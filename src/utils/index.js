/**
 * src/utils.js
 * -----------------------------------------------------------------------------
 * Small, dependency-light helpers shared across the scraper. Everything here is
 * pure/reusable and free of module-level mutable state (no globals).
 * -----------------------------------------------------------------------------
 */

import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import iconv from 'iconv-lite';

/** Pause for `ms` milliseconds. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Detect the charset of an HTML byte buffer: prefer the HTTP Content-Type
 * header, then a <meta charset> / <meta http-equiv> in the first 2KB, else
 * default to utf-8. Returns a lower-cased label iconv-lite understands.
 */
export function detectCharset(buffer, contentType = '') {
  const fromHeader = /charset=["']?([\w-]+)/i.exec(contentType);
  if (fromHeader) return fromHeader[1].toLowerCase();
  const head = buffer.subarray(0, 2048).toString('latin1');
  const fromMeta = /charset=["']?([\w-]+)/i.exec(head);
  if (fromMeta) return fromMeta[1].toLowerCase();
  return 'utf-8';
}

/**
 * Decode an HTML byte buffer to a string using the detected charset. Falls back
 * to utf-8 for unknown encodings. This is what lets the scraper read
 * windows-1251 (Cyrillic) pages without turning text into mojibake.
 */
export function decodeHtml(buffer, contentType) {
  let cs = detectCharset(buffer, contentType);
  if (cs === 'utf8') cs = 'utf-8';
  if (!iconv.encodingExists(cs)) cs = 'utf-8';
  return iconv.decode(buffer, cs);
}

/**
 * Ensure a directory exists (recursively). Safe to call repeatedly.
 */
export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

/**
 * Read a JSON file, returning `fallback` if it is missing or unparseable.
 * Never throws — a corrupt state file must not crash a resumable scraper.
 */
export async function readJsonSafe(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Atomically write JSON: write to a temp file then rename. This prevents a
 * half-written state file if the process is killed mid-write (resume safety).
 */
export async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(tmp, file);
}

/**
 * Resolve a possibly-relative URL against a base page URL.
 * Returns null if the result is not a valid absolute http(s) URL.
 */
export function resolveUrl(href, baseUrl) {
  try {
    const u = new URL(href, baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString();
  } catch {
    return null;
  }
}

/**
 * Normalize a URL for de-duplication: drop the hash, sort query params, and
 * strip a trailing slash. Two URLs that point at the same resource normalize
 * to the same string.
 */
export function normalizeUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    u.searchParams.sort();
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch {
    return url;
  }
}

/**
 * Extract a lower-cased file extension (without dot) from a URL path.
 * Returns '' when none is present.
 */
export function extensionFromUrl(url) {
  try {
    // Dummy base so relative URLs (e.g. "/img/x.png") parse too.
    const { pathname } = new URL(url, 'http://_base_/');
    const ext = path.extname(pathname).slice(1).toLowerCase();
    return ext;
  } catch {
    return '';
  }
}

/** Map a few common image content-types to file extensions. */
export function extensionFromContentType(contentType = '') {
  const ct = contentType.split(';')[0].trim().toLowerCase();
  const map = {
    'image/jpeg': 'jpg',
    'image/jpg': 'jpg',
    'image/png': 'png',
    'image/webp': 'webp',
    'image/gif': 'gif',
  };
  return map[ct] || '';
}

/**
 * Turn an arbitrary string into a filesystem-safe base filename, preserving the
 * original where possible. Strips query strings and dangerous characters.
 */
export function safeFilenameFromUrl(url) {
  let base = 'image';
  try {
    const { pathname } = new URL(url);
    const last = decodeURIComponent(pathname.split('/').pop() || '');
    if (last) base = last;
  } catch {
    /* keep default */
  }
  // Remove anything that is not a reasonable filename character.
  base = base.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/_+/g, '_');
  if (!base || base === '.' || base === '..') base = 'image';
  return base;
}

/**
 * Turn a post title into a filesystem-safe base filename. Keeps Unicode
 * letters (e.g. Cyrillic) and spaces; replaces characters illegal on Windows
 * (<>:"/\|?*) with '-', collapses whitespace, trims trailing dots/spaces, and
 * caps the length. Falls back to 'post' if nothing usable remains.
 */
export function sanitizeTitleForFilename(title) {
  let t = String(title ?? '').trim();
  // eslint-disable-next-line no-control-regex
  t = t.replace(/[<>:"/\\|?*\x00-\x1F]/g, '-'); // Windows-illegal chars
  t = t.replace(/\s+/g, ' '); // collapse whitespace
  t = t.replace(/[ .]+$/, ''); // no trailing dot/space on Windows
  if (t.length > 150) t = t.slice(0, 150).trim();
  return t || 'post';
}

/**
 * Extract the trailing number from a URL's filename stem, e.g.
 * ".../image_3.jpg" -> "3", ".../new1.png" -> "1". Returns null if the stem
 * has no trailing digits. Kept as a string to preserve values like "0".
 */
export function numberFromUrl(url) {
  try {
    const { pathname } = new URL(url, 'http://_base_/');
    const last = pathname.split('/').pop() || '';
    const stem = last.replace(/\.[a-z0-9]+$/i, '');
    const m = stem.match(/(\d+)$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/**
 * Given a desired filename and a set of names already in use, return a unique
 * name by inserting _2, _3, ... before the extension (image.jpg -> image_2.jpg).
 */
export function uniqueFilename(desired, usedNames) {
  if (!usedNames.has(desired)) return desired;
  const ext = path.extname(desired);
  const stem = desired.slice(0, desired.length - ext.length);
  let i = 2;
  let candidate = `${stem}_${i}${ext}`;
  while (usedNames.has(candidate)) {
    i += 1;
    candidate = `${stem}_${i}${ext}`;
  }
  return candidate;
}

/**
 * Retry an async function with exponential backoff.
 *
 * @param {() => Promise<T>} fn        the operation to attempt
 * @param {object} opts
 * @param {number} opts.retries        max additional attempts after the first
 * @param {number} opts.baseDelayMs    backoff base (doubles each attempt)
 * @param {(err:Error, attempt:number, willRetry:boolean)=>void} [opts.onRetry]
 * @returns {Promise<T>}
 */
export async function withRetry(fn, { retries, baseDelayMs, onRetry } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      // Permanent errors (e.g. HTTP 404) opt out of retrying via err.noRetry.
      const willRetry = attempt < retries && err?.noRetry !== true;
      if (onRetry) onRetry(err, attempt + 1, willRetry);
      if (!willRetry) break;
      // Exponential backoff with a little jitter to avoid thundering herds.
      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
      await sleep(delay);
    }
  }
  throw lastErr;
}

/**
 * Simple serial rate limiter: callers `await limiter.wait()` before each
 * network request to guarantee a minimum gap between requests. Because the
 * internal promise chain is serialized, requests are also naturally throttled.
 */
export class RateLimiter {
  #minIntervalMs;
  #chain = Promise.resolve();
  #last = 0;

  constructor(minIntervalMs) {
    this.#minIntervalMs = minIntervalMs;
  }

  wait() {
    this.#chain = this.#chain.then(async () => {
      const now = Date.now();
      const gap = now - this.#last;
      if (gap < this.#minIntervalMs) {
        await sleep(this.#minIntervalMs - gap);
      }
      this.#last = Date.now();
    });
    return this.#chain;
  }
}

/**
 * fetch() wrapped with an AbortController timeout. Returns the Response.
 * Throws on network error or timeout (caller decides whether to retry).
 */
export async function fetchWithTimeout(url, { timeoutMs, headers } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { headers, signal: controller.signal, redirect: 'follow' });
  } finally {
    clearTimeout(timer);
  }
}

/** Human-readable byte count (e.g. 1.4 MB). */
export function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(1)} ${units[i]}`;
}

/** Human-readable duration from milliseconds (e.g. 1h 02m 03s). */
export function formatDuration(ms) {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  if (h > 0) return `${h}h ${pad(m)}m ${pad(sec)}s`;
  if (m > 0) return `${m}m ${pad(sec)}s`;
  return `${sec}s`;
}

/**
 * Parse command-line arguments into an overrides object. Unknown flags are
 * ignored. Booleans (dry-run) need no value.
 */
export function parseCliArgs(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'start-url': { type: 'string' },
      'max-pages': { type: 'string' },
      'concurrency': { type: 'string' },
      'delay': { type: 'string' },
      'timeout': { type: 'string' },
      'retries': { type: 'string' },
      'min-width': { type: 'string' },
      'min-height': { type: 'string' },
      'min-bytes': { type: 'string' },
      'output': { type: 'string' },
      'user-agent': { type: 'string' },
      'full': { type: 'boolean' },
      'stop-after-known': { type: 'string' },
      'dry-run': { type: 'boolean' },
      'help': { type: 'boolean' },
    },
  });
  return values;
}

/**
 * Merge CLI overrides into a (shallow-cloned) config object and return the
 * result. Pure: does not mutate the input config.
 */
export function applyCliOverrides(baseConfig, cli) {
  // Deep clone so the original defaults are never mutated.
  const cfg = structuredClone(baseConfig);
  const num = (v) => (v === undefined ? undefined : Number(v));

  if (cli['start-url']) cfg.startUrl = cli['start-url'];
  if (cli['user-agent']) cfg.request.userAgent = cli['user-agent'];
  if (num(cli['timeout']) !== undefined) cfg.request.timeoutMs = num(cli['timeout']);
  if (num(cli['delay']) !== undefined) cfg.request.delayMs = num(cli['delay']);
  if (num(cli['retries']) !== undefined) cfg.request.maxRetries = num(cli['retries']);
  if (num(cli['concurrency']) !== undefined) cfg.concurrency.downloads = num(cli['concurrency']);
  if (num(cli['max-pages']) !== undefined) cfg.pagination.maxPages = num(cli['max-pages']);
  if (num(cli['min-width']) !== undefined) cfg.filters.minWidth = num(cli['min-width']);
  if (num(cli['min-height']) !== undefined) cfg.filters.minHeight = num(cli['min-height']);
  if (num(cli['min-bytes']) !== undefined) cfg.filters.minBytes = num(cli['min-bytes']);
  if (cli['dry-run']) cfg.behavior.dryRun = true;
  if (cli['full']) cfg.crawl.mode = 'full';
  if (num(cli['stop-after-known']) !== undefined) {
    cfg.crawl.stopAfterKnownPages = num(cli['stop-after-known']);
  }

  if (cli['output']) {
    // Re-base every output path under the supplied directory.
    const root = cli['output'];
    cfg.output.dataDir = root;
    cfg.output.imagesDir = path.join(root, 'images');
    cfg.output.logsDir = path.join(root, 'logs');
    cfg.output.downloadedImagesFile = path.join(root, 'downloaded-images.json');
    cfg.output.visitedPagesFile = path.join(root, 'visited-pages.json');
    cfg.output.visitedPostsFile = path.join(root, 'visited-posts.json');
    cfg.output.anecdotesDir = path.join(root, 'anecdotes');
    cfg.output.anecdotesFile = path.join(root, 'anecdotes', 'anecdotes.json'); // <-- new
    cfg.output.metadataFile = path.join(root, 'metadata.json');
  }

  return cfg;
}

/** Text shown for --help. */
export const HELP_TEXT = `
Ruero Image Scraper — download images from a paginated website.

Usage:
  node src/scraper.js [options]

Options:
  --start-url <url>      Override the starting/listing URL
  --max-pages <n>        Stop after n listing pages (0 = unlimited)
  --concurrency <n>      Parallel image downloads
  --delay <ms>           Minimum delay between requests
  --timeout <ms>         Per-request timeout
  --retries <n>          Retry attempts per failed request
  --min-width <px>       Minimum image width to keep
  --min-height <px>      Minimum image height to keep
  --min-bytes <bytes>    Minimum image file size to keep
  --output <dir>         Output directory (default: data)
  --user-agent <ua>      Override the User-Agent header
  --full                 Full crawl (walk every page); default is incremental
  --stop-after-known <n> Incremental: stop after n consecutive all-known pages
  --dry-run              Report what would be downloaded; write nothing
  --help                 Show this help
`;