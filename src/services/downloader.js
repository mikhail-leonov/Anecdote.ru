/**
 * src/downloader.js
 * -----------------------------------------------------------------------------
 * Responsible for fetching a single image URL and writing it to data/images/.
 *
 * Guarantees / behaviour:
 *   - streams the body to disk (constant memory, large GIFs are fine)
 *   - computes the SHA-256 of the bytes while streaming
 *   - enforces the minimum file-size threshold (rejects tiny files)
 *   - retries with backoff on network / 5xx errors
 *   - picks an original-preserving, collision-free filename
 *   - honours dry-run (reports, writes nothing)
 *   - never throws to the caller for an expected failure; returns a result
 *     object describing what happened so one bad image cannot crash a run.
 * -----------------------------------------------------------------------------
 */

import { createWriteStream } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import path from 'node:path';
import {
  ensureDir,
  extensionFromUrl,
  fetchWithTimeout,
  numberFromUrl,
  safeFilenameFromUrl,
  sanitizeTitleForFilename,
  uniqueFilename,
  withRetry,
} from '../utils/index.js';

export class Downloader {
  #config;
  #logger;
  #duplicates;
  #rateLimiter;

  constructor({ config, logger, duplicates, rateLimiter }) {
    this.#config = config;
    this.#logger = logger;
    this.#duplicates = duplicates;
    this.#rateLimiter = rateLimiter;
  }

  /**
   * Download one image.
   *
   * @param {string} url            absolute image URL
   * @param {object} [opts]
   * @param {string} [opts.referer] referer header (the post page URL)
   * @returns {Promise<{status:string, filename?:string, sha256?:string,
   *                     bytes?:number, reason?:string}>}
   *   status is one of: 'downloaded' | 'duplicate' | 'skipped' | 'failed' | 'dry-run'
   */
  async download(url, { referer, title, ordinal, subdir } = {}) {
    const { request, filters, output, behavior } = this.#config;

    // (1) Cheapest possible duplicate check: have we already fetched this URL?
    if (this.#duplicates.hasUrl(url)) {
      this.#logger.duplicate(url, 'url already downloaded');
      return { status: 'duplicate', reason: 'url' };
    }

    // (2) Decide on a filename up front (post-title based when available). For a
    // series, prefix the post-title subfolder so all its images group together.
    const baseName = this.#resolveFilename(url, { title, ordinal });
    const relBase = subdir ? `${subdir}/${baseName}` : baseName;

    // (3) Dry-run: report intent and stop before any network write.
    if (behavior.dryRun) {
      this.#logger.info(`DRY   would download -> ${relBase}  <= ${url}`);
      return { status: 'dry-run', filename: relBase };
    }

    // Reserve a unique relative path so concurrent downloads don't collide.
    const relName = uniqueFilename(relBase, this.#duplicates.usedFilenames);
    this.#duplicates.reserveFilename(relName);
    const destPath = path.join(output.imagesDir, relName);
    await ensureDir(path.dirname(destPath));

    try {
      const result = await withRetry(
        () => this.#fetchToFile(url, destPath, { referer }),
        {
          retries: request.maxRetries,
          baseDelayMs: request.retryBaseDelayMs,
          onRetry: (err, attempt, willRetry) => {
            this.#logger.retry(url, attempt);
            if (!willRetry) this.#logger.debug(`giving up on ${url}: ${err.message}`);
          },
        },
      );

      // (4) Enforce the minimum byte threshold (decorative/preview files).
      if (result.bytes < filters.minBytes) {
        await this.#safeUnlink(destPath);
        this.#logger.skipped(url, `below min size (${result.bytes} bytes)`);
        return { status: 'skipped', reason: 'min-bytes' };
      }

      // (5) Post-download content de-duplication via SHA-256.
      if (this.#duplicates.hasHash(result.sha256)) {
        await this.#safeUnlink(destPath);
        this.#logger.duplicate(url, 'identical content (sha256)');
        return { status: 'duplicate', reason: 'hash' };
      }

      // (6) Commit: record in the JSON store and report success.
      this.#duplicates.record({
        url,
        filename: relName,
        sha256: result.sha256,
        bytes: result.bytes,
      });
      this.#logger.downloaded(relName, result.bytes);
      return {
        status: 'downloaded',
        filename: relName,
        sha256: result.sha256,
        bytes: result.bytes,
      };
    } catch (err) {
      // Clean up any partial file so a resume doesn't see a truncated image.
      await this.#safeUnlink(destPath);
      this.#logger.failure(url, err);
      return { status: 'failed', reason: err.message };
    }
  }

  /**
   * Perform a single fetch attempt, streaming the body to `destPath` while
   * hashing. Throws on HTTP errors so withRetry can decide to retry.
   */
  async #fetchToFile(url, destPath, { referer }) {
    await this.#rateLimiter.wait(); // rate limiting / politeness

    const headers = { 'User-Agent': this.#config.request.userAgent };
    if (referer) headers.Referer = referer;

    const res = await fetchWithTimeout(url, {
      timeoutMs: this.#config.request.timeoutMs,
      headers,
    });

    // Retry 5xx and 429; treat other non-2xx as permanent failures.
    if (!res.ok) {
      const retryable = res.status >= 500 || res.status === 429;
      const err = new Error(`HTTP ${res.status} for ${url}`);
      err.retryable = retryable;
      // For non-retryable statuses, throw past the retry budget immediately.
      if (!retryable) err.noRetry = true;
      throw err;
    }
    if (!res.body) throw new Error(`Empty response body for ${url}`);

    const hash = createHash('sha256');
    let bytes = 0;

    // A pass-through that tees the stream into the hash and counts bytes.
    const meter = new Transform({
      transform(chunk, _enc, cb) {
        hash.update(chunk);
        bytes += chunk.length;
        cb(null, chunk);
      },
    });

    const fileStream = createWriteStream(destPath);
    // Convert the web ReadableStream to a Node stream and pipe through.
    const nodeReadable = Readable.fromWeb(res.body);
    await pipeline(nodeReadable, meter, fileStream);

    return { bytes, sha256: hash.digest('hex') };
  }

  /**
   * Build a filename for a URL.
   *
   * When `nameByPostTitle` is on and a title is available, produce
   * "<sanitised title>_<n>.<ext>", where <n> is the trailing number from the
   * source filename (e.g. image_3 -> 3) or the fallback `ordinal`. Otherwise
   * fall back to preserving the original source filename.
   */
  #resolveFilename(url, { title, ordinal } = {}) {
    const f = this.#config.filters;
    const allowed = [...f.allowedExtensions, ...(f.videoExtensions || [])];
    let ext = extensionFromUrl(url);
    if (!allowed.includes(ext)) ext = 'jpg'; // bytes unchanged; name only

    if (this.#config.behavior.nameByPostTitle && title) {
      const base = sanitizeTitleForFilename(title);
      const num = numberFromUrl(url);
      const suffix = num !== null ? num : String(ordinal ?? 0);
      return `${base}_${suffix}.${ext}`;
    }

    // Fallback: preserve the original source filename.
    let name = safeFilenameFromUrl(url);
    if (!allowed.includes(extensionFromUrl(url)) && !path.extname(name)) {
      name += '.jpg';
    }
    return name;
  }

  /** Best-effort unlink that never throws. */
  async #safeUnlink(p) {
    try {
      await unlink(p);
    } catch {
      /* ignore */
    }
  }
}

// Best-effort unlink that never throws is defined above.
export default Downloader;
