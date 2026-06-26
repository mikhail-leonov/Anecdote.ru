/**
 * src/pagination.js
 * -----------------------------------------------------------------------------
 * Determines the URL of the next listing page. Two strategies, in order:
 *
 *   1. DOM strategy  — follow a "next" link located via config.selectors.nextPage
 *                      (rel="next", .next a, etc.). This is the most reliable.
 *   2. Pattern strategy — if no link is found and config.pagination.urlPattern
 *                      is set, derive the next page number from the current URL
 *                      and build the next URL (e.g. /page/2/ -> /page/3/).
 *
 * Returns null when neither strategy yields a new page, which stops the crawl.
 * -----------------------------------------------------------------------------
 */

import { resolveUrl, normalizeUrl } from '../utils/index.js';

export class Pagination {
  #config;
  #logger;

  constructor({ config, logger }) {
    this.#config = config;
    this.#logger = logger;
  }

  /**
   * @param {import('cheerio').CheerioAPI} $  loaded listing page
   * @param {string} currentUrl              URL of the page just processed
   * @returns {string|null}                  next page URL, or null to stop
   */
  getNextPageUrl($, currentUrl) {
    // (1) DOM strategy.
    const sel = this.#config.selectors.nextPage;
    if (sel) {
      const href = $(sel).first().attr('href');
      if (href) {
        const next = resolveUrl(href, currentUrl);
        if (next && normalizeUrl(next) !== normalizeUrl(currentUrl)) {
          this.#logger.debug(`next page via link: ${next}`);
          return next;
        }
      }
    }

    // (2) Pattern strategy (fallback).
    const pattern = this.#config.pagination.urlPattern;
    if (pattern) {
      const next = this.#nextByPattern(currentUrl, pattern);
      if (next) {
        this.#logger.debug(`next page via pattern: ${next}`);
        return next;
      }
    }

    return null;
  }

  /**
   * Derive the next page URL from a pattern like '/page/{n}/'. Works whether the
   * current URL already contains the pattern (increment it) or is the bare root
   * (treat as page 1 and produce page 2).
   */
  #nextByPattern(currentUrl, pattern) {
    let url;
    try {
      url = new URL(currentUrl);
    } catch {
      return null;
    }

    // Match against pathname + search so query-string patterns work too
    // (e.g. '/index.php?page={n}' as well as '/page/{n}/').
    const combined = url.pathname + url.search;
    const re = new RegExp(
      pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{n\\}', '(\\d+)'),
    );
    const m = combined.match(re);

    if (m) {
      // Currently on page N -> go to N+1. Rebuild from the pattern so both the
      // path and query are produced correctly.
      const n = parseInt(m[1], 10) + 1;
      const nextRef = pattern.replace('{n}', String(n));
      return resolveUrl(nextRef, `${url.origin}/`);
    }

    // First page (no page number yet). Only fabricate "page 2" from a listing
    // root (path "/" or the pattern's own base path) so we never append a page
    // segment onto an arbitrary URL.
    const base = pattern.split('{n}')[0].split('?')[0].replace(/\/+$/, '');
    const path0 = url.pathname.replace(/\/+$/, '');
    if (path0 === '' || path0 === base) {
      const nextRef = pattern.replace('{n}', '2');
      return resolveUrl(nextRef, `${url.origin}/`);
    }
    return null;
  }
}

export default Pagination;
