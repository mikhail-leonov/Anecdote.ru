/**
 * src/config/index.js
 * -----------------------------------------------------------------------------
 * Central configuration. Values are read from environment variables (via
 * dotenv) using small typed helpers, with sensible fallbacks. Copy
 * `.env.example` to `.env` to override.
 *
 * Retargeted for anekdot.ru: the crawl starts at the tags index (/tags/),
 * discovers every category in the tags-cloud, and walks each category's
 * paginated anecdote feed, saving TEXT anecdotes only.
 * -----------------------------------------------------------------------------
 */

import 'dotenv/config';
import path from 'node:path';

// --- typed environment readers -----------------------------------------------

function str(key, fallback = '') {
  const v = process.env[key];
  return v === undefined || v === '' ? fallback : v;
}

function int(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return Number.isNaN(n) ? fallback : n;
}

function bool(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return /^(1|true|yes|on)$/i.test(v.trim());
}

function list(key, fallback) {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Output directory is env-driven; all data paths derive from it.
const OUTPUT_DIR = str('OUTPUT_DIR', 'data');

export const config = {
  env: str('NODE_ENV', 'development'),

  // Entry point for the crawl: the tags index. Every category in the
  // tags-cloud is discovered and crawled from here.
  startUrl: str('START_URL', 'https://www.anekdot.ru/tags/'),

  // Where everything is written (no database; JSON files only).
  output: {
    dataDir: OUTPUT_DIR,
    imagesDir: path.join(OUTPUT_DIR, 'images'),
    logsDir: path.join(OUTPUT_DIR, 'logs'),
    downloadedImagesFile: path.join(OUTPUT_DIR, 'downloaded-images.json'),
    visitedPagesFile: path.join(OUTPUT_DIR, 'visited-pages.json'),
    visitedPostsFile: path.join(OUTPUT_DIR, 'visited-posts.json'),
    anecdotesDir: path.join(OUTPUT_DIR, 'anecdotes'),
    anecdotesFile: path.join(OUTPUT_DIR, 'anecdotes', 'anecdotes.json'),
    metadataFile: path.join(OUTPUT_DIR, 'metadata.json'),
  },

  // Network behaviour.
  request: {
    userAgent: str(
      'USER_AGENT',
      'Mozilla/5.0 (compatible; AnekdotScraper/1.0; +https://example.com/bot)',
    ),
    timeoutMs: int('REQUEST_TIMEOUT_MS', 30_000),
    delayMs: int('REQUEST_DELAY_MS', 1_000),
    maxRetries: int('MAX_RETRIES', 4),
    retryBaseDelayMs: int('RETRY_BASE_DELAY_MS', 1_000),
  },

  // Parallelism (unused in anecdotes-only mode; kept for config shape).
  concurrency: {
    downloads: int('DOWNLOAD_CONCURRENCY', 4),
  },

  // Pagination.
  //
  // anekdot.ru renders a `.pageslist` widget whose "след. →" link points at the
  // next page. We follow that link (see selectors.nextPage / nextPageText), so
  // no URL pattern is needed; the link is recomputed relative to the current
  // page, which absorbs the daily +1 page shift automatically.
  pagination: {
    maxPages: int('MAX_PAGES', 0), // 0 = unlimited
    urlPattern: str('PAGINATION_PATTERN', ''), // empty -> link strategy only
  },

  // Crawl strategy (per tag).
  //
  // Categories are crawled from the top. Resume keys on each anecdote's stable
  // data-id, so the daily page shift never causes duplicates or misses.
  //
  //   - 'incremental' (default): walk a tag from the top, skip known anecdotes,
  //     and STOP once `stopAfterKnownPages` consecutive pages contain no new
  //     anecdotes. Fast daily runs. (Disabled until a tag's first full mirror
  //     completes — see scraper.js.)
  //   - 'full': walk every page of every tag to the end.
  crawl: {
    mode: str('CRAWL_MODE', 'incremental'),
    stopAfterKnownPages: int('STOP_AFTER_KNOWN_PAGES', 2),
  },

  // Image qualification thresholds (unused in anecdotes-only mode).
  filters: {
    minWidth: int('MIN_WIDTH', 400),
    minHeight: int('MIN_HEIGHT', 400),
    minBytes: int('MIN_BYTES', 20 * 1024),
    allowedExtensions: list('ALLOWED_EXTENSIONS', [
      'jpg', 'jpeg', 'png', 'webp', 'gif',
    ]),
    videoExtensions: list('VIDEO_EXTENSIONS', ['mp4', 'webm', 'm4v', 'mov', 'ogv']),
    excludeUrlPatterns: list('EXCLUDE_URL_PATTERNS', [
      'thumb', 'thumbnail', 'avatar', '/icon', 'icons/', 'emoji', 'logo',
      'sprite', 'badge', 'pixel', 'spacer', 'placeholder', '/ad/', '/ads/',
      'banner', 'tracking',
    ]),
  },

  // CSS selectors — the per-site part. Tuned for anekdot.ru.
  selectors: {
    // Tags index (/tags/): each category link lives in the tags-cloud.
    tagLink: str('SEL_TAG_LINK', '.tags-cloud a'),

    // A single anecdote box on a tag page: <div class="topicbox" data-id="...">.
    post: str('SEL_POST', 'div.topicbox'),
    adContainer: str('SEL_AD', '.ad, .ads, .sponsored, .promoted'),

    // The anecdote text is in <div class="text"> inside the topicbox.
    anecdoteText: str('SEL_ANECDOTE_TEXT', 'div.text'),

    // Pagination widget. The "след. →" link (matched by its text) is the next
    // page; there is no such link on the last page, which ends the tag.
    nextPage: str('SEL_NEXT', '.pageslist a'),
    nextPageText: str('SEL_NEXT_TEXT', 'след'),

    // (image scraping is disabled in anecdotes-only mode; kept for completeness)
    postContent: str('SEL_POST_CONTENT', 'body'),
    image: str('SEL_IMAGE', 'img'),
    imageLink: str('SEL_IMAGE_LINK', 'a'),
  },

  // Behaviour switches.
  behavior: {
    dryRun: bool('DRY_RUN', false),
    stopOnEmptyPage: bool('STOP_ON_EMPTY_PAGE', true),
    upgradeSizeSuffixedUrls: bool('UPGRADE_SIZE_SUFFIXED_URLS', true),
    nameByPostTitle: bool('NAME_BY_POST_TITLE', true),
    // Save text anecdotes as JSON (500 per file, rotated). Always on here.
    saveAnecdotes: bool('SAVE_ANECDOTES', true),
    // Minimum length for a block to count as an anecdote (filters out stray
    // fragments / captions). Kept low so short one-liners are still saved.
    anecdoteMinLength: int('ANECDOTE_MIN_LENGTH', 15),
    // Text-only: image/video topicboxes are ignored entirely.
    anecdotesOnly: bool('ANECDOTES_ONLY', true),
  },
};

export default config;
