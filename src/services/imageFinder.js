/**
 * src/imageFinder.js
 * -----------------------------------------------------------------------------
 * Given the parsed HTML of a dedicated post page, discover every qualifying
 * image and return the highest-resolution URL for each distinct image.
 *
 * Discovery sources (covers single images, galleries, GIFs, and "click the
 * thumbnail for the full file" layouts):
 *   - <a href="...jpg|png|webp|gif">  full-size links (strongest signal)
 *   - <img src> / <img data-src> / data-original / data-large-file
 *   - <img srcset>  (largest candidate chosen)
 *   - <meta property="og:image">      and <link rel="image_src">
 *
 * Filtering:
 *   - extension must be in config.filters.allowedExtensions
 *   - URL must not match any config.filters.excludeUrlPatterns
 *   - probed width/height must meet config.filters thresholds
 *
 * Dimensions are probed with `probe-image-size`, which reads only the first
 * few bytes of the file (a ranged request) rather than downloading it whole —
 * so we can reject tiny images cheaply, before committing to a full download.
 * -----------------------------------------------------------------------------
 */

import probe from 'probe-image-size';
import {
  extensionFromUrl,
  normalizeUrl,
  resolveUrl,
} from '../utils/index.js';

export class ImageFinder {
  #config;
  #logger;
  #rateLimiter;

  constructor({ config, logger, rateLimiter }) {
    this.#config = config;
    this.#logger = logger;
    this.#rateLimiter = rateLimiter;
  }

  /**
   * @param {import('cheerio').CheerioAPI} $  loaded post-page document
   * @param {string} pageUrl                  the post page URL (for resolving)
   * @returns {Promise<Array<{url:string,width:number,height:number}>>}
   */
  async findImages($, pageUrl) {
    const { selectors } = this.#config;
    const scope = $(selectors.postContent).length
      ? $(selectors.postContent)
      : $.root();

    // (1) Gather raw candidate URLs from every source into a set.
    const candidates = new Set();
    const add = (href) => {
      const abs = resolveUrl(href, pageUrl);
      if (abs) candidates.add(abs);
    };

    // Anchors that link directly to image files (full-size links).
    scope.find(selectors.imageLink).each((_i, el) => {
      const href = $(el).attr('href');
      if (!href) return;
      const abs = resolveUrl(href, pageUrl);
      // Test the *resolved* URL so relative hrefs ("/img/x.png") work too.
      if (abs && this.#looksLikeImage(abs)) candidates.add(abs);
    });

    // <img> elements and their lazy-load / full-size attributes.
    scope.find(selectors.image).each((_i, el) => {
      const $el = $(el);
      for (const attr of ['data-large-file', 'data-original', 'data-src', 'src']) {
        const v = $el.attr(attr);
        if (v) add(v);
      }
      const srcset = $el.attr('srcset');
      if (srcset) add(this.#largestFromSrcset(srcset));
    });

    // <video> elements and their <source> children (and poster is ignored).
    scope.find('video, video source').each((_i, el) => {
      const v = $(el).attr('src');
      if (v) add(v);
    });

    // Page-level hints.
    $('meta[property="og:image"], meta[name="og:image"]').each((_i, el) => add($(el).attr('content')));
    $('link[rel="image_src"]').each((_i, el) => add($(el).attr('href')));

    // (2) Upgrade size-suffixed thumbnails to their originals, then de-duplicate
    //     by normalized URL (keeping the upgraded form).
    const upgraded = new Map(); // normalizedUrl -> url
    for (const url of candidates) {
      const best = this.#upgradeResolution(url);
      const key = normalizeUrl(best);
      if (!upgraded.has(key)) upgraded.set(key, best);
    }

    // (3) Apply cheap URL-based filters before any network probing.
    const urlFiltered = [...upgraded.values()].filter((url) => {
      if (!this.#extensionAllowed(url)) {
        this.#logger.skipped(url, 'extension not allowed');
        return false;
      }
      if (this.#isExcludedByPattern(url)) {
        this.#logger.skipped(url, 'matched exclude pattern');
        return false;
      }
      return true;
    });

    // (4) Probe dimensions and keep only images meeting the size thresholds.
    //     Videos can't be probed by probe-image-size, so they are kept as-is
    //     (the downloader still enforces the min-bytes threshold).
    const results = [];
    for (const url of urlFiltered) {
      if (this.#isVideo(url)) {
        results.push({ url, width: 0, height: 0 });
        this.#logger.discovered(url, 'video');
        continue;
      }
      const dims = await this.#probe(url);
      if (!dims) {
        // Could not read dimensions; keep it but mark unknown. The downloader
        // still enforces the byte-size threshold as a second line of defence.
        results.push({ url, width: 0, height: 0 });
        this.#logger.discovered(url, 'dimensions unknown');
        continue;
      }
      const { width, height } = dims;
      if (
        width < this.#config.filters.minWidth ||
        height < this.#config.filters.minHeight
      ) {
        this.#logger.skipped(url, `too small (${width}x${height})`);
        continue;
      }
      results.push({ url, width, height });
      this.#logger.discovered(url, `${width}x${height}`);
    }

    return results;
  }

  // --- helpers ---------------------------------------------------------------

  /** Allowed image OR video extensions. */
  #mediaExtensions() {
    const f = this.#config.filters;
    return [...f.allowedExtensions, ...(f.videoExtensions || [])];
  }

  #isVideo(url) {
    const f = this.#config.filters;
    return (f.videoExtensions || []).includes(extensionFromUrl(url));
  }

  /** Does a URL/href carry a supported image OR video extension? */
  #looksLikeImage(href) {
    return this.#mediaExtensions().includes(extensionFromUrl(href));
  }

  #extensionAllowed(url) {
    return this.#mediaExtensions().includes(extensionFromUrl(url));
  }

  #isExcludedByPattern(url) {
    const lower = url.toLowerCase();
    return this.#config.filters.excludeUrlPatterns.some((p) => lower.includes(p));
  }

  /** Pick the highest-resolution URL from a srcset attribute. */
  #largestFromSrcset(srcset) {
    let bestUrl = '';
    let bestW = -1;
    for (const part of srcset.split(',')) {
      const [u, descriptor] = part.trim().split(/\s+/);
      if (!u) continue;
      // descriptor like "1024w" or "2x"; treat width descriptors as the rank.
      const w = descriptor && descriptor.endsWith('w')
        ? parseInt(descriptor, 10)
        : 0;
      if (w >= bestW) {
        bestW = w;
        bestUrl = u;
      }
    }
    return bestUrl;
  }

  /**
   * Strip a "-WIDTHxHEIGHT" size suffix (e.g. photo-300x200.jpg ->
   * photo.jpg) to request the original upload. Controlled by config flag.
   */
  #upgradeResolution(url) {
    if (!this.#config.behavior.upgradeSizeSuffixedUrls) return url;
    return url.replace(/-\d{2,5}x\d{2,5}(\.[a-zA-Z]{3,4})(\?.*)?$/, '$1$2');
  }

  /**
   * Probe image dimensions over the network. Returns {width,height} or null.
   * Rate-limited and wrapped so a probe failure never aborts the run.
   */
  async #probe(url) {
    try {
      await this.#rateLimiter.wait();
      const result = await probe(url, {
        headers: { 'User-Agent': this.#config.request.userAgent },
        timeout: this.#config.request.timeoutMs,
      });
      return { width: result.width, height: result.height };
    } catch (err) {
      this.#logger.debug(`probe failed for ${url}: ${err.message}`);
      return null;
    }
  }
}

export default ImageFinder;
