/**
 * src/services/pagination.js
 * -----------------------------------------------------------------------------
 * Determines the URL of the next listing page. Strategies, in order:
 *
 *   1. Link by TEXT — within config.selectors.nextPage, follow the first anchor
 *      whose text contains config.selectors.nextPageText (e.g. "след"). This is
 *      how anekdot.ru's `.pageslist` "след. →" link is followed. Recomputed by
 *      the server relative to the current page, so the daily +1 shift is absorbed.
 *   2. Link (first) — if no nextPageText is configured, follow the first
 *      nextPage anchor's href.
 *   3. URL pattern — fallback when config.pagination.urlPattern is set.
 *
 * Returns null when nothing yields a new page, which ends the (tag) crawl.
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
    const sel = this.#config.selectors.nextPage;
    const txt = this.#config.selectors.nextPageText;

    if (sel) {
      let href = null;

      if (txt) {
        const needle = String(txt).toLowerCase();
        $(sel).each((_i, el) => {
          const t = $(el).text().trim().toLowerCase();
          if (t.includes(needle)) {
            href = $(el).attr('href');
            return false; // first match wins (the "next" link)
          }
          return undefined;
        });
      } else {
        href = $(sel).first().attr('href');
      }

      if (href) {
        const next = resolveUrl(href, currentUrl);
        if (next && normalizeUrl(next) !== normalizeUrl(currentUrl)) {
          this.#logger.debug(`next page via link: ${next}`);
          return next;
        }
      }
    }

    // Pattern fallback (disabled for anekdot.ru: urlPattern is empty).
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
   * Derive the next page URL from a pattern like '/page/{n}/' or
   * '/index.php?page={n}'. Increments an existing page number, or fabricates
   * page 2 from a listing root. Returns null when it doesn't apply.
   */
  #nextByPattern(currentUrl, pattern) {
    let url;
    try {
      url = new URL(currentUrl);
    } catch {
      return null;
    }

    const combined = url.pathname + url.search;
    const re = new RegExp(
      pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\{n\\}', '(\\d+)'),
    );
    const m = combined.match(re);

    if (m) {
      const n = parseInt(m[1], 10) + 1;
      const nextRef = pattern.replace('{n}', String(n));
      return resolveUrl(nextRef, `${url.origin}/`);
    }

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
