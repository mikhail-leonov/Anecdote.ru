/**
 * src/services/scraper.js
 * -----------------------------------------------------------------------------
 * The crawl orchestrator for anekdot.ru, retargeted to harvest TEXT anecdotes
 * by category.
 *
 * Flow:
 *   discover tags (/tags/ -> tags-cloud) ->
 *     for each tag:
 *       walk pages from the top (following the "след. →" link) ->
 *         save each text anecdote (keyed by stable data-id), tagged with the
 *         category name ->
 *       mark the tag complete when its last page is reached.
 *
 * Resume:
 *   - knownPosts (visited-posts.json) holds processed anecdote ids, so the
 *     daily +1 page shift never causes duplicates or misses.
 *   - completedTags (metadata.json) records which categories are fully mirrored.
 *     Until a tag is complete, the incremental early-stop is disabled so a
 *     resumed first mirror finishes instead of stopping after the first page.
 *
 * Resilience: every page is wrapped so one failure is logged and skipped; state
 * is persisted after every page; SIGINT/SIGTERM triggers a graceful shutdown.
 * -----------------------------------------------------------------------------
 */

import { load as loadHtml } from 'cheerio';

import { Logger } from '../utils/logger.js';
import { JsonStore } from '../db/jsonStore.js';
import { PostParser } from './postParser.js';
import { Pagination } from './pagination.js';
import { AnecdoteWriter } from './anecdoteWriter.js';
import {
  RateLimiter,
  decodeHtml,
  fetchWithTimeout,
  normalizeUrl,
  withRetry,
  ensureDir,
} from '../utils/index.js';

export class Scraper {
  #config;
  #logger;
  #postParser;
  #pagination;
  #anecdotes;
  #rateLimiter;

  #visitedStore;
  #metadataStore;
  #postsStore;
  #visited = new Map();        // normalizedUrl -> { processedAt, next, tag }
  #knownPosts = new Set();     // 'anek:id:<id>' | 'anek:txt:<hash>'
  #completedTags = new Set();  // normalized tag URLs fully mirrored
  #shuttingDown = false;
  #progressTimer = null;

  constructor(config) {
    this.#config = config;
  }

  /** Wire up collaborators and load persisted state. */
  async init() {
    const cfg = this.#config;
    await ensureDir(cfg.output.dataDir);

    this.#logger = await new Logger({ logsDir: cfg.output.logsDir }).init();
    this.#rateLimiter = new RateLimiter(cfg.request.delayMs);

    this.#postParser = new PostParser({ config: cfg, logger: this.#logger });
    this.#pagination = new Pagination({ config: cfg, logger: this.#logger });
    this.#anecdotes = new AnecdoteWriter({
      file: cfg.output.anecdotesFile,
      logger: this.#logger,
    });
    await this.#anecdotes.init();

    this.#visitedStore = new JsonStore(cfg.output.visitedPagesFile, {});
    this.#postsStore = new JsonStore(cfg.output.visitedPostsFile, { posts: [] });
    this.#metadataStore = new JsonStore(cfg.output.metadataFile, {});
    const visited = await this.#visitedStore.load();
    for (const [k, v] of Object.entries(visited)) this.#visited.set(k, v);
    const postsData = await this.#postsStore.load();
    for (const u of postsData.posts || []) this.#knownPosts.add(u);
    const meta = await this.#metadataStore.load();
    for (const t of meta?.completedTags || []) this.#completedTags.add(t);

    this.#installSignalHandlers();

    this.#logger.info(
      `Initialised [${cfg.crawl.mode}]. ${this.#anecdotes.count} anecdotes known, ` +
        `${this.#knownPosts.size} posts seen, ${this.#completedTags.size} tag(s) complete.` +
        (cfg.behavior.dryRun ? '  [DRY-RUN]' : ''),
    );
    return this;
  }

  /** Main run: discover tags, then crawl each. */
  async run() {
    const cfg = this.#config;

    this.#progressTimer = setInterval(() => {
      this.#logger.info(`PROGRESS ${this.#logger.progressLine()}`);
    }, 10_000);

    try {
      const tags = await this.#discoverTags(cfg.startUrl);
      if (!tags.length) {
        this.#logger.warn(
          `No tags found at ${cfg.startUrl} via '${cfg.selectors.tagLink}'. ` +
            'Check the tags-cloud selector (SEL_TAG_LINK).',
        );
        return;
      }
      this.#logger.info(`Discovered ${tags.length} tag(s).`);

      for (const tag of tags) {
        if (this.#shuttingDown) break;
        await this.#crawlTag(tag.url, tag.name);
      }

      this.#logger.info(
        `All tags processed. Anecdotes stored: ${this.#anecdotes.count}.`,
      );
    } finally {
      await this.#shutdown();
    }
  }

  // --- tag discovery ---------------------------------------------------------

  async #discoverTags(indexUrl) {
    let html;
    try {
      html = await this.#fetchHtml(indexUrl);
    } catch (err) {
      this.#logger.failure(indexUrl, err);
      return [];
    }
    const $ = loadHtml(html);
    return this.#postParser.parseTags($, indexUrl);
  }

  // --- per-tag crawl ---------------------------------------------------------

  async #crawlTag(tagUrl, tagName) {
    const cfg = this.#config;
    const incremental = cfg.crawl.mode !== 'full';
    const tagKey = normalizeUrl(tagUrl);
    const tagComplete = this.#completedTags.has(tagKey);

    // The incremental early-stop only applies once a tag's first full mirror
    // exists. Until then, walk it to the end (skipping known anecdotes).
    const allowEarlyStop = incremental && tagComplete;
    this.#logger.info(
      `[${tagName}] crawling${tagComplete ? '' : ' (first mirror — early-stop disabled)'}.`,
    );

    let pageUrl = tagUrl;
    let pageCount = 0;
    let consecutiveKnownPages = 0;
    let reachedEndOfTag = false;
    const seenPages = new Set();

    while (pageUrl && !this.#shuttingDown) {
      if (cfg.pagination.maxPages > 0 && pageCount >= cfg.pagination.maxPages) {
        this.#logger.info(`[${tagName}] reached maxPages (${cfg.pagination.maxPages}).`);
        break;
      }

      const pk = normalizeUrl(pageUrl);
      if (seenPages.has(pk)) {
        this.#logger.warn(`[${tagName}] pagination loop at ${pageUrl}; stopping tag.`);
        reachedEndOfTag = true;
        break;
      }
      seenPages.add(pk);

      const { nextUrl, newPosts, totalPosts, reachedEnd } =
        await this.#processTagPage(pageUrl, tagName);
      pageCount += 1;

      if (nextUrl === null && reachedEnd) reachedEndOfTag = true;

      this.#visited.set(pk, {
        processedAt: new Date().toISOString(),
        next: nextUrl,
        tag: tagName,
      });
      await this.#persistState();

      if (allowEarlyStop && totalPosts > 0 && newPosts === 0) {
        consecutiveKnownPages += 1;
        this.#logger.info(
          `[${tagName}] no new anecdotes ` +
            `(${consecutiveKnownPages}/${cfg.crawl.stopAfterKnownPages}).`,
        );
        if (consecutiveKnownPages >= cfg.crawl.stopAfterKnownPages) {
          this.#logger.info(`[${tagName}] caught up; stopping tag.`);
          break;
        }
      } else if (newPosts > 0) {
        consecutiveKnownPages = 0;
      }

      if (nextUrl === null) {
        this.#logger.info(
          reachedEnd
            ? `[${tagName}] reached the last page.`
            : `[${tagName}] stopped before the end (transient); will resume next run.`,
        );
      }
      pageUrl = nextUrl;
    }

    if (reachedEndOfTag && !tagComplete) {
      this.#completedTags.add(tagKey);
      await this.#persistState();
      this.#logger.info(`[${tagName}] full mirror complete.`);
    }
  }

  /**
   * Fetch and process one tag page.
   * @returns {Promise<{nextUrl:string|null, newPosts:number, totalPosts:number,
   *                     reachedEnd:boolean}>}
   */
  async #processTagPage(pageUrl, tagName) {
    let html;
    try {
      html = await this.#fetchHtml(pageUrl);
    } catch (err) {
      const reachedEnd = err?.noRetry === true;
      this.#logger.warn(
        `Stopping [${tagName}] pagination; could not fetch ${pageUrl}: ${err.message}` +
          (reachedEnd ? ' (end of pages)' : ' (transient — will resume next run)'),
      );
      return { nextUrl: null, newPosts: 0, totalPosts: 0, reachedEnd };
    }

    this.#logger.page(pageUrl);
    const $ = loadHtml(html);

    const posts = this.#postParser.parsePosts($, pageUrl);

    let newPosts = 0;
    let relevant = 0;
    for (const p of posts) {
      if (this.#shuttingDown) break;
      relevant += 1;

      const key = p.id
        ? `anek:id:${p.id}`
        : `anek:txt:${AnecdoteWriter.hashOf(p.text)}`;
      if (this.#knownPosts.has(key)) {
        this.#logger.debug('skip known anecdote');
        continue;
      }

      newPosts += 1;
      await this.#anecdotes.write({
        text: p.text,
        title: '',
        url: p.url,
        tags: [tagName],
        dryRun: this.#config.behavior.dryRun,
      });
      this.#knownPosts.add(key);
    }

    this.#logger.info(
      `PAGE  ${pageUrl} -> ${posts.length} anecdote(s), ${newPosts} new`,
    );

    if (posts.length === 0 && this.#config.behavior.stopOnEmptyPage) {
      return { nextUrl: null, newPosts, totalPosts: relevant, reachedEnd: true };
    }

    const nextUrl = this.#pagination.getNextPageUrl($, pageUrl);
    return { nextUrl, newPosts, totalPosts: relevant, reachedEnd: nextUrl === null };
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
          if (!(res.status >= 500 || res.status === 429)) err.noRetry = true;
          throw err;
        }
        // Decode using the page's real charset so Cyrillic text is read
        // correctly rather than as mojibake.
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
    await this.#anecdotes.save();
    await this.#metadataStore.save({
      startUrl: cfg.startUrl,
      mode: cfg.crawl.mode,
      completedTags: [...this.#completedTags],
      updatedAt: new Date().toISOString(),
      knownPosts: this.#knownPosts.size,
      anecdotes: this.#anecdotes.count,
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
      await this.#anecdotes.save(true);
      await this.#persistState();
    } catch (err) {
      this.#logger.error(`Error while flushing state: ${err.message}`);
    }
    this.#logger.summary();
    await this.#logger.close();
  }
}

export default Scraper;
