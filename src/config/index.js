/**
 * src/config/index.js
 * -----------------------------------------------------------------------------
 * Central configuration. Keeps the original project's convention: values are
 * read from environment variables (via dotenv) using small typed helpers, with
 * sensible fallbacks baked in. Copy `.env.example` to `.env` to override.
 *
 * This file replaces the old web-app config (DB connection, HTTP port) with the
 * scraper's settings, but preserves the str/int/bool/list helper style so the
 * project's shape stays familiar.
 * -----------------------------------------------------------------------------
 */

import 'dotenv/config';
import path from 'node:path';

// --- typed environment readers (unchanged in spirit from the original) -------

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

  // Entry point for the crawl.
  startUrl: str('START_URL', 'http://pejnya.net/'),

  // Where everything is written (no database; JSON files only).
  output: {
    dataDir: OUTPUT_DIR,
    imagesDir: path.join(OUTPUT_DIR, 'images'),
    logsDir: path.join(OUTPUT_DIR, 'logs'),
    downloadedImagesFile: path.join(OUTPUT_DIR, 'downloaded-images.json'),
    visitedPagesFile: path.join(OUTPUT_DIR, 'visited-pages.json'),
    visitedPostsFile: path.join(OUTPUT_DIR, 'visited-posts.json'),
    anecdotesDir: path.join(OUTPUT_DIR, 'anecdotes'),
    anecdotesFile: path.join(OUTPUT_DIR, 'anecdotes', 'anecdotes.json'), // <-- new
    metadataFile: path.join(OUTPUT_DIR, 'metadata.json'),
  },

  // Network behaviour.
  request: {
    userAgent: str(
      'USER_AGENT',
      'Mozilla/5.0 (compatible; RueroImageScraper/1.0; +https://example.com/bot)',
    ),
    timeoutMs: int('REQUEST_TIMEOUT_MS', 30_000),
    delayMs: int('REQUEST_DELAY_MS', 1_000),
    maxRetries: int('MAX_RETRIES', 4),
    retryBaseDelayMs: int('RETRY_BASE_DELAY_MS', 1_000),
  },

  // Parallelism.
  concurrency: {
    downloads: int('DOWNLOAD_CONCURRENCY', 4),
  },

  // Pagination.
  pagination: {
    maxPages: int('MAX_PAGES', 0), // 0 = unlimited
    urlPattern: str('PAGINATION_PATTERN', '/index.php?page={n}'),
  },

  // Crawl strategy.
  //
  // This site PREPENDS new posts daily, so page numbers are not stable
  // (today's /page/2/ becomes tomorrow's /page/3/). Resume therefore keys on the
  // stable POST URL, not the page number.
  //
  //   - 'incremental' (default): walk pages from the top, skip posts already
  //     downloaded, and STOP once `stopAfterKnownPages` consecutive pages
  //     contain no new posts (i.e. we've caught up). Fast daily runs.
  //   - 'full': walk every page to the end (for the initial complete mirror).
  //     Already-downloaded posts are still skipped, but the crawl never
  //     early-stops.
  crawl: {
    mode: str('CRAWL_MODE', 'incremental'),
    stopAfterKnownPages: int('STOP_AFTER_KNOWN_PAGES', 2),
  },

  // Image qualification thresholds.
  filters: {
    minWidth: int('MIN_WIDTH', 400),
    minHeight: int('MIN_HEIGHT', 400),
    minBytes: int('MIN_BYTES', 20 * 1024),
    allowedExtensions: list('ALLOWED_EXTENSIONS', [
      'jpg',
      'jpeg',
      'png',
      'webp',
      'gif',
    ]),
    // Video files are downloaded like images (stored the same way).
    videoExtensions: list('VIDEO_EXTENSIONS', ['mp4', 'webm', 'm4v', 'mov', 'ogv']),
    excludeUrlPatterns: list('EXCLUDE_URL_PATTERNS', [
      'thumb',
      'thumbnail',
      'avatar',
      '/icon',
      'icons/',
      'emoji',
      'logo',
      'sprite',
      'badge',
      'pixel',
      'spacer',
      'placeholder',
      '/ad/',
      '/ads/',
      'banner',
      'tracking',
    ]),
  },

  // CSS selectors — the per-site part. Edit these to retarget a new website.
  //
  // NOTE: pejnya.net uses an old table-based layout with no semantic post
  // classes, so these are BEST-EFFORT defaults. Verify them against the real
  // page HTML (see README) and adjust if a run reports 0 posts.
  //   - media posts link to content/photo.php?news=… (galleries) or a video
  //   - anecdote posts are inline joke text whose header links to anekdot.php
  selectors: {
    // Each post is a 2-row <table> (header cell + content cell). Selecting leaf
    // tables (no nested table) avoids matching the outer layout tables.
    post: str('SEL_POST', 'table:not(:has(table))'),
    adContainer: str('SEL_AD', '.ad, .ads, .sponsored, .promoted'),
    // Media links: photo galleries (content/photo.php) and video pages
    // (video_prikol_big.php). A video post may contain several such links.
    mediaLink: str(
      'SEL_MEDIA_LINK',
      'a[href*="content/photo.php"], a[href*="video_prikol_big"]',
    ),
    postLink: str('SEL_POST_LINK', 'a[href*="content/"]'), // fallback permalink
    // Header cell holds "Title | Раздел - …date"; we cut at the separator.
    postTitle: str('SEL_POST_TITLE', 'td.txt-main[bgcolor="#EAEAEA"]'),
    titleSeparator: str('SEL_TITLE_SEPARATOR', '|'),
    postThumbnail: str('SEL_POST_THUMB', 'img'),
    // Anecdote: header links to the anekdot section; text is the content cell.
    anecdoteMarker: str('SEL_ANECDOTE_MARKER', 'a[href*="anekdot"]'),
    anecdoteText: str('SEL_ANECDOTE_TEXT', 'td.txt-main[bgcolor="#ffffff"]'),
    nextPage: str('SEL_NEXT', 'a[rel="next"]'), // none on site -> pattern used
    postContent: str('SEL_POST_CONTENT', 'body'), // gallery page scope
    image: str('SEL_IMAGE', 'img'),
    imageLink: str('SEL_IMAGE_LINK', 'a'),
  },

  // Behaviour switches.
  behavior: {
    dryRun: bool('DRY_RUN', false),
    stopOnEmptyPage: bool('STOP_ON_EMPTY_PAGE', true),
    upgradeSizeSuffixedUrls: bool('UPGRADE_SIZE_SUFFIXED_URLS', true),
    // Name saved files "<post title>_<n>.<ext>" instead of the source filename.
    nameByPostTitle: bool('NAME_BY_POST_TITLE', true),
    // Save text-only posts (anecdotes/jokes) as .txt files under anecdotesDir.
    saveAnecdotes: bool('SAVE_ANECDOTES', true),
    anecdoteMinLength: int('ANECDOTE_MIN_LENGTH', 40),
    // Anecdotes-only mode: ignore photo/video posts entirely and save only
    // anecdotes. Set ANECDOTES_ONLY=false to also download images & videos.
    anecdotesOnly: bool('ANECDOTES_ONLY', true),
  },
};

export default config;