/**
 * config.js
 * -----------------------------------------------------------------------------
 * Single source of truth for every tunable setting in the scraper.
 *
 * Nothing here is hard-coded elsewhere: starting URL, thresholds, selectors,
 * timing, retry behaviour and output paths all live in this object so the
 * utility can be retargeted at a different website by editing this file alone.
 *
 * Any value can also be overridden at runtime from the command line
 * (see utils.parseCliArgs / applyCliOverrides). CLI flags win over these
 * defaults.
 * -----------------------------------------------------------------------------
 */

export const config = {
  // ---------------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------------
  // The first listing page. The scraper follows pagination from here.
  startUrl: 'http://pejnya.nl/',

  // ---------------------------------------------------------------------------
  // Output locations (all relative to the project root unless absolute)
  // ---------------------------------------------------------------------------
  output: {
    dataDir: 'data',
    imagesDir: 'data/images',
    logsDir: 'data/logs',
    // JSON state files (no database is used anywhere in this project)
    downloadedImagesFile: 'data/downloaded-images.json',
    visitedPagesFile: 'data/visited-pages.json',
    metadataFile: 'data/metadata.json',
  },

  // ---------------------------------------------------------------------------
  // Network / request behaviour
  // ---------------------------------------------------------------------------
  request: {
    // Identify politely. Some sites block the default Node fetch UA.
    userAgent:
      'Mozilla/5.0 (compatible; RueroImageScraper/1.0; +https://example.com/bot)',
    // Abort a single request after this many milliseconds.
    timeoutMs: 30_000,
    // Minimum gap enforced between *any* two outbound requests (rate limiting).
    delayMs: 1_000,
    // How many times to retry a failed request before giving up on it.
    maxRetries: 4,
    // Base delay for exponential backoff between retries (doubles each attempt).
    retryBaseDelayMs: 1_000,
  },

  // ---------------------------------------------------------------------------
  // Concurrency
  // ---------------------------------------------------------------------------
  concurrency: {
    // How many image downloads may run in parallel. Page fetching stays
    // sequential so pagination order and politeness are preserved.
    downloads: 4,
  },

  // ---------------------------------------------------------------------------
  // Pagination
  // ---------------------------------------------------------------------------
  pagination: {
    // 0 means "no limit" — keep going until no next page is found.
    maxPages: 0,
    // Fallback pattern used only when no "next" link can be located in the DOM.
    // {n} is replaced with the next page number. Set to null to disable.
    urlPattern: '/page/{n}/',
  },

  // ---------------------------------------------------------------------------
  // Image filtering / qualification thresholds
  // ---------------------------------------------------------------------------
  filters: {
    minWidth: 400, // px
    minHeight: 400, // px
    minBytes: 20 * 1024, // 20 KB — reject tiny preview/decorative files
    // Extensions we accept. Files are downloaded as-is; no format conversion.
    allowedExtensions: ['jpg', 'jpeg', 'png', 'webp', 'gif'],
    // If any of these substrings appears in an image URL it is skipped.
    // Catches thumbnails, avatars, icons, emojis, logos, sprites, pixels, ads.
    excludeUrlPatterns: [
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
    ],
  },

  // ---------------------------------------------------------------------------
  // CSS selectors — the part you change per target site.
  // ---------------------------------------------------------------------------
  selectors: {
    // Listing (index) page
    post: 'article, .post, .entry', // a single post container
    adContainer: '.ad, .ads, .sponsored, .promoted', // skipped entirely
    postLink: 'a', // link to the dedicated post page
    postThumbnail: 'img', // used only to detect "has image"

    // Pagination
    nextPage: 'a[rel="next"], .next a, a.next, .pagination .next',

    // Post (detail) page — where the full-resolution images live
    postContent: 'article, .post, .entry-content, main', // search scope
    image: 'img', // <img> elements within the content
    imageLink: 'a', // anchors that may link to full-size files
  },

  // ---------------------------------------------------------------------------
  // Behaviour switches
  // ---------------------------------------------------------------------------
  behavior: {
    // Report what would be downloaded without writing any files.
    dryRun: false,
    // Stop when a listing page yields zero posts (typical "end of pages").
    stopOnEmptyPage: true,
    // When a thumbnail URL contains a "-WIDTHxHEIGHT" suffix (common on
    // WordPress), try the de-suffixed original first to grab full resolution.
    upgradeSizeSuffixedUrls: true,
  },
};

export default config;
