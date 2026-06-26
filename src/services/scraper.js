/**
 * src/services/scraper.js
 * -----------------------------------------------------------------------------
 * The core crawl orchestrator (a service). Pulls together the other services
 * (pagination, postParser, imageFinder, downloader, duplicateChecker), the db
 * layer (visited-pages + metadata stores) and the logger.
 *
 * Flow:
 *   load state -> for each listing page:
 *       fetch page -> parse posts ->
 *         for each post with an image:
 *           fetch post page -> find images -> download (concurrently)
 *       persist state -> follow pagination
 *   ... until no next page, maxPages, an empty page, or Ctrl+C.
 *
 * Resilience: every page/post/image is wrapped so a single failure is logged
 * and skipped, never crashing the run; state is persisted after every page so
 * the crawl resumes cleanly; SIGINT/SIGTERM triggers a graceful shutdown.
 *
 * Construction is done by src/controllers/scrapeController.js; this class holds
 * all run state on the instance (no module globals).
 * -----------------------------------------------------------------------------
 */

import { load as loadHtml } from 'cheerio';
import pLimit from 'p-limit';

import { Logger } from '../utils/logger.js';
import { JsonStore } from '../db/jsonStore.js';
import { DuplicateChecker } from './duplicateChecker.js';
import { Downloader } from './downloader.js';
import { ImageFinder } from './imageFinder.js';
import { PostParser } from './postParser.js';
import { Pagination } from './pagination.js';
import { AnecdoteWriter } from './anecdoteWriter.js';
import {
  RateLimiter,
  decodeHtml,
  fetchWithTimeout,
  normalizeUrl,
  sanitizeTitleForFilename,
  withRetry,
  ensureDir,
} from '../utils/index.js';

export class Scraper {
  #config;
  #logger;
  #duplicates;
  #downloader;
  #imageFinder;
  #postParser;
  #pagination;
  #anecdotes;
  #rateLimiter;
  #downloadLimit;

  #visitedStore;
  #metadataStore;
  #postsStore;
  #visited = new Map(); // normalizedUrl -> { processedAt, next }  (informational)
  #knownPosts = new Set(); // normalized POST urls already processed (stable id)
  #fullCrawlComplete = false; // has the initial full mirror reached the end once?
  #shuttingDown = false;
  #progressTimer = null;

  constructor(config) {
    this.#config = config;
  }

  /** Wire up all collaborators and load persisted state. */
  async init() {
    const cfg = this.#config;
    await ensureDir(cfg.output.dataDir);
    await ensureDir(cfg.output.imagesDir);

    this.#logger = await new Logger({ logsDir: cfg.output.logsDir }).init();
    this.#rateLimiter = new RateLimiter(cfg.request.delayMs);
    this.#downloadLimit = pLimit(cfg.concurrency.downloads);

    this.#duplicates = await new DuplicateChecker({
      file: cfg.output.downloadedImagesFile,
    }).load();

    this.#downloader = new Downloader({
      config: cfg,
      logger: this.#logger,
      duplicates: this.#duplicates,
      rateLimiter: this.#rateLimiter,
    });
    this.#imageFinder = new ImageFinder({
      config: cfg,
      logger: this.#logger,
      rateLimiter: this.#rateLimiter,
    });
    this.#postParser = new PostParser({ config: cfg, logger: this.#logger });
    this.#pagination = new Pagination({ config: cfg, logger: this.#logger });
    this.#anecdotes = new AnecdoteWriter({
      file: cfg.output.anecdotesFile,
      logger: this.#logger,
      tags: cfg.behavior.anecdoteTags,   // <-- tag every anecdote
    });
    await this.#anecdotes.init();        // load + back-fill existing anecdotes

    // db layer: visited-pages (informational), known-posts (resume key), metadata.
    this.#visitedStore = new JsonStore(cfg.output.visitedPagesFile, {});
    this.#postsStore = new JsonStore(cfg.output.visitedPostsFile, { posts: [] });
    this.#metadataStore = new JsonStore(cfg.output.metadataFile, {});
    const visited = await this.#visitedStore.load();
    for (const [k, v] of Object.entries(visited)) this.#visited.set(k, v);
    const postsData = await this.#postsStore.load();
    for (const u of postsData.posts || []) this.#knownPosts.add(u);
    // Resume the "is the initial mirror finished?" flag across runs.
    const meta = await this.#metadataStore.load();
    this.#fullCrawlComplete = meta?.fullCrawlComplete === true;

    this.#installSignalHandlers();

    this.#logger.info(
      `Initialised [${cfg.crawl.mode}]. ${this.#duplicates.count} images known, ` +
        `${this.#knownPosts.size} posts already processed. ` +
        `Full mirror ${this.#fullCrawlComplete ? 'complete' : 'INCOMPLETE (will crawl to the end)'}.` +
        (cfg.behavior.dryRun ? '  [DRY-RUN]' : ''),
    );
    return this;
  }

  /** Main crawl loop. */
  async run() {
    const cfg = this.#config;
    const incremental = cfg.crawl.mode !== 'full';

    // The incremental early-stop assumes already-scraped content sits at the
    // BOTTOM of the feed: a daily run walks down from the top until it meets
    // known posts, then stops. That assumption only holds once the initial full
    // mirror exists.
    //
    // On a *resumed first mirror* the opposite is true: the TOP pages are
    // already known (we processed them last run) while unscraped posts remain
    // further down. Early-stopping there would quit after the first page or two
    // and never finish the mirror — exactly the "we just checked the first page
    // and stopped" bug. So: until the mirror has reached the end at least once
    // (#fullCrawlComplete), we keep walking to the end even in incremental mode.
    // Already-downloaded posts are still skipped, so nothing is re-fetched.
    const allowEarlyStop = incremental && this.#fullCrawlComplete;
    if (incremental && !this.#fullCrawlComplete) {
      this.#logger.info(
        'Initial full mirror not complete yet — crawling to the end (early-stop disabled). ' +
          'Already-downloaded posts/images are still skipped.',
      );
    }

    this.#progressTimer = setInterval(() => {
      this.#logger.info(`PROGRESS ${this.#logger.progressLine()}`);
    }, 10_000);

    let pageUrl = cfg.startUrl;
    let pageCount = 0;
    let consecutiveKnownPages = 0;

    try {
      while (pageUrl && !this.#shuttingDown) {
        if (cfg.pagination.maxPages > 0 && pageCount >= cfg.pagination.maxPages) {
          this.#logger.info(`Reached maxPages (${cfg.pagination.maxPages}); stopping.`);
          break;
        }

        // The feed PREPENDS new posts daily, so a given page URL holds different
        // posts over time: yesterday's page 2 is today's page 3 — the content
        // shifts DOWN by ~one page each day. We therefore never resume by page
        // number. We always walk from the top and rely on the stable post-URL
        // set (#knownPosts) + image dedup to skip work already done. The +1/day
        // shift also means a finished daily run only needs a couple of pages
        // before it meets known content (see early-stop below).
        const { nextUrl, newPosts, totalPosts, reachedEnd } =
          await this.#processListingPage(pageUrl);
        pageCount += 1;

        // Reaching the real end of pagination means the mirror is now complete.
        // Record it so future runs can use the fast incremental early-stop.
        if (nextUrl === null && reachedEnd && !this.#fullCrawlComplete) {
          this.#fullCrawlComplete = true;
          this.#logger.info('Reached the end of pagination; full mirror is now complete.');
        }

        this.#visited.set(normalizeUrl(pageUrl), {
          processedAt: new Date().toISOString(),
          next: nextUrl,
        });
        await this.#persistState();

        // Incremental early-stop (only once the mirror is complete): a page
        // whose posts are ALL already known means we've reached previously
        // scraped content. After enough consecutive such pages, the new
        // material is exhausted — stop. With the +1/day shift the new posts fit
        // in roughly the first page, so a small threshold catches up quickly.
        if (allowEarlyStop && totalPosts > 0 && newPosts === 0) {
          consecutiveKnownPages += 1;
          this.#logger.info(
            `No new posts here (${consecutiveKnownPages}/${cfg.crawl.stopAfterKnownPages} ` +
              `consecutive all-known pages).`,
          );
          if (consecutiveKnownPages >= cfg.crawl.stopAfterKnownPages) {
            this.#logger.info('Caught up with previously-scraped content; stopping.');
            break;
          }
        } else if (newPosts > 0) {
          consecutiveKnownPages = 0;
        }

        if (nextUrl === null) {
          if (reachedEnd) {
            this.#logger.info('No further pages found; crawl complete.');
          } else {
            this.#logger.info(
              'Stopped before the end (transient issue); mirror left INCOMPLETE and ' +
                'will resume from the top on the next run.',
            );
          }
        }
        pageUrl = nextUrl;
      }
    } finally {
      await this.#shutdown();
    }
  }

  // --- per-page / per-post work ---------------------------------------------

  /**
   * Fetch and process a single listing page.
   * @returns {Promise<{nextUrl:string|null, newPosts:number, totalPosts:number,
   *                     reachedEnd:boolean}>}
   *   reachedEnd is true only when we genuinely hit the end of the feed (404
   *   past the last page, an empty page, or no further "next"). A transient
   *   failure returns reachedEnd:false so the mirror is NOT marked complete.
   */
  async #processListingPage(pageUrl) {
    let html;
    try {
      html = await this.#fetchHtml(pageUrl);
    } catch (err) {
      // A permanent HTTP error (e.g. 404 past the last page) is the normal
      // end-of-pagination signal -> treat as the end. A transient failure
      // (timeout, repeated 5xx) is NOT the end: stop, but leave the mirror
      // incomplete so the next run resumes and finishes it.
      const reachedEnd = err?.noRetry === true;
      this.#logger.warn(
        `Stopping pagination; could not fetch ${pageUrl}: ${err.message}` +
          (reachedEnd ? ' (end of pages)' : ' (transient — will resume next run)'),
      );
      return { nextUrl: null, newPosts: 0, totalPosts: 0, reachedEnd };
    }

    this.#logger.page(pageUrl);
    const $ = loadHtml(html);

    const posts = this.#postParser.parsePosts($, pageUrl);

    // Process posts we have not seen. In anecdotes-only mode, media posts are
    // ignored entirely and only anecdotes count toward "new"/"total" (so a
    // media-only page never triggers the incremental early-stop).
    const anecdotesOnly = this.#config.behavior.anecdotesOnly;
    let newPosts = 0;
    let relevant = 0;
    for (const p of posts) {
      if (this.#shuttingDown) break;

      if (p.type === 'anecdote') {
        relevant += 1;
        const key = `anec:${AnecdoteWriter.hashOf(p.text)}`;
        if (this.#knownPosts.has(key)) {
          this.#logger.debug('skip known anecdote');
          continue;
        }
        newPosts += 1;
        await this.#anecdotes.write({
          text: p.text,
          title: p.title,
          dryRun: this.#config.behavior.dryRun,
        });
        this.#knownPosts.add(key);
        continue;
      }

      // media post
      if (anecdotesOnly) {
        this.#logger.debug(`skip media (anecdotes-only): ${p.postUrl}`);
        continue;
      }
      relevant += 1;
      const key = normalizeUrl(p.postUrl);
      if (this.#knownPosts.has(key)) {
        this.#logger.debug(`skip known post: ${p.postUrl}`);
        continue;
      }
      newPosts += 1;
      await this.#processPost(p.postUrl, p.title);
      this.#knownPosts.add(key);
    }

    this.#logger.info(
      `PAGE  ${pageUrl} -> ${posts.length} post(s), ${relevant} relevant, ${newPosts} new`,
    );

    if (posts.length === 0 && this.#config.behavior.stopOnEmptyPage) {
      // An empty listing page is a legitimate end-of-feed marker.
      return { nextUrl: null, newPosts, totalPosts: relevant, reachedEnd: true };
    }

    const nextUrl = this.#pagination.getNextPageUrl($, pageUrl);
    return { nextUrl, newPosts, totalPosts: relevant, reachedEnd: nextUrl === null };
  }

  /** Fetch a post page, discover images, and download them concurrently. */
  async #processPost(postUrl, listingTitle = '') {
    let html;
    try {
      html = await this.#fetchHtml(postUrl);
    } catch (err) {
      this.#logger.failure(postUrl, err);
      return;
    }

    this.#logger.post(postUrl);
    const $ = loadHtml(html);

    // Prefer the listing title; fall back to the post page's own title/h1.
    const sel = this.#config.selectors.postTitle;
    const title =
      listingTitle ||
      (sel ? $(sel).first().text().trim() : '') ||
      $('h1').first().text().trim();

    let images;
    try {
      images = await this.#imageFinder.findImages($, postUrl);
    } catch (err) {
      this.#logger.failure(postUrl, err);
      return;
    }

    if (images.length === 0) {
      this.#logger.debug(`No qualifying images on ${postUrl}`);
      return;
    }

    // A post with MORE THAN ONE image is a series/gallery: group its files in a
    // subfolder named after the post title. A single-image post stays flat in
    // the images directory (named "<title>_<n>.<ext>" as before).
    const isSeries = images.length > 1;
    const subdir = isSeries && title ? sanitizeTitleForFilename(title) : '';

    // `ordinal` is a fallback index used only when the source filename has no
    // trailing number; downloader prefers the source number when present.
    const jobs = images.map(({ url }, ordinal) =>
      this.#downloadLimit(async () => {
        if (this.#shuttingDown) return;
        await this.#downloader.download(url, { referer: postUrl, title, ordinal, subdir });
      }),
    );
    await Promise.allSettled(jobs);

    await this.#duplicates.save();
  }

  // --- infrastructure --------------------------------------------------------

  /** Fetch a URL as text (HTML) with retry + timeout + rate limiting. */
  async #fetchHtml(url) {
    return withRetry(
      async () => {
        await this.#rateLimiter.wait();
        const res = await fetchWithTimeout(url, {
          timeoutMs: this.#config.request.timeoutMs,
          headers: { 'User-Agent': this.#config.request.userAgent },
        });
        if (!res.ok) {
          const err = new Error(`HTTP ${res.status} for ${url}`);
          // Only 5xx and 429 are worth retrying; 4xx (e.g. 404) are permanent.
          if (!(res.status >= 500 || res.status === 429)) err.noRetry = true;
          throw err;
        }
        // Decode using the page's real charset (e.g. windows-1251) so Cyrillic
        // titles and anecdote text are read correctly rather than as mojibake.
        const buf = Buffer.from(await res.arrayBuffer());
        return decodeHtml(buf, res.headers.get('content-type'));
      },
      {
        retries: this.#config.request.maxRetries,
        baseDelayMs: this.#config.request.retryBaseDelayMs,
        onRetry: (_err, attempt) => this.#logger.retry(url, attempt),
      },
    );
  }

  /** Persist visited-pages, known-posts, anecdotes and a metadata snapshot. */
  async #persistState() {
    const cfg = this.#config;
    await this.#visitedStore.save(Object.fromEntries(this.#visited));
    await this.#postsStore.save({ posts: [...this.#knownPosts] });
    await this.#anecdotes.save();   // flush new anecdotes to disk
    await this.#metadataStore.save({
      startUrl: cfg.startUrl,
      mode: cfg.crawl.mode,
      fullCrawlComplete: this.#fullCrawlComplete, // resume key for early-stop
      updatedAt: new Date().toISOString(),
      knownPosts: this.#knownPosts.size,
      stats: this.#logger.stats,
      dryRun: cfg.behavior.dryRun,
    });
  }

  /** Register graceful-shutdown handlers (idempotent). */
  #installSignalHandlers() {
    const onSignal = (sig) => {
      if (this.#shuttingDown) return;
      this.#shuttingDown = true;
      this.#logger.warn(`Received ${sig}; finishing in-flight work and shutting down...`);
    };
    process.once('SIGINT', () => onSignal('SIGINT'));
    process.once('SIGTERM', () => onSignal('SIGTERM'));
  }

  /** Flush everything and close out the run. Safe to call once. */
  async #shutdown() {
    if (this.#progressTimer) clearInterval(this.#progressTimer);
    try {
      await this.#duplicates.save(true);
      await this.#anecdotes.save(true); // force final save
      await this.#persistState();
    } catch (err) {
      this.#logger.error(`Error while flushing state: ${err.message}`);
    }
    this.#logger.summary();
    await this.#logger.close();
  }
}

export default Scraper;
