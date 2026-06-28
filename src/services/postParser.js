/**
 * src/services/postParser.js
 * -----------------------------------------------------------------------------
 * anekdot.ru parser. Two jobs:
 *
 *   1. parseTags()  — from the tags index (/tags/), return every category link
 *                     in the tags-cloud as { url, name } (name = decoded slug).
 *   2. parsePosts() — from a tag page, return every TEXT anecdote as
 *                     { type:'anecdote', id, text, url }.
 *
 * "Save only texts": topicboxes whose .text contains an <img>/<video>/<iframe>
 * (картинки / видео) are skipped. The stable data-id is used as the resume key.
 * -----------------------------------------------------------------------------
 */

import { resolveUrl, normalizeUrl } from '../utils/index.js';

export class PostParser {
  #config;
  #logger;

  constructor({ config, logger }) {
    this.#config = config;
    this.#logger = logger;
  }

  // --- tags index ------------------------------------------------------------

  /**
   * @param {import('cheerio').CheerioAPI} $  loaded /tags/ page
   * @param {string} baseUrl                  the tags index URL (for resolving)
   * @returns {Array<{url:string, name:string}>}
   */
  parseTags($, baseUrl) {
    const sel = this.#config.selectors.tagLink;
    const tags = [];
    const seen = new Set();

    $(sel).each((_i, a) => {
      const href = $(a).attr('href');
      if (!href) return undefined;
      const url = resolveUrl(href, baseUrl);
      if (!url) return undefined;
      // Only keep links into /tags/<slug>.
      if (!/\/tags\/[^/]+/.test(new URL(url).pathname)) return undefined;
      const key = normalizeUrl(url);
      if (seen.has(key)) return undefined;
      seen.add(key);
      tags.push({ url, name: this.#tagNameFromUrl(url) });
      return undefined;
    });

    return tags;
  }

  /** Decode the category name from a tag URL slug (handles a trailing /<page>). */
  #tagNameFromUrl(url) {
    try {
      const u = new URL(url);
      const seg = u.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
      let slug = seg[seg.length - 1];
      if (/^\d+$/.test(slug) && seg.length >= 2) slug = seg[seg.length - 2];
      try {
        return decodeURIComponent(slug);
      } catch {
        return slug;
      }
    } catch {
      return '';
    }
  }

  // --- tag page (anecdotes) --------------------------------------------------

  /**
   * @param {import('cheerio').CheerioAPI} $  loaded tag page
   * @param {string} pageUrl                  the tag page URL (for resolving)
   * @returns {Array<{type:'anecdote', id:string, text:string, url:string}>}
   */
  parsePosts($, pageUrl) {
    const { selectors } = this.#config;
    const minLen = this.#config.behavior.anecdoteMinLength || 15;
    const out = [];
    const seen = new Set();

    $(selectors.post).each((_i, el) => {
      const $box = $(el);

      if (this.#isAd($, $box)) {
        this.#logger.debug('skip topicbox: advertisement/sponsored');
        return undefined;
      }

      const $text = $box.find(selectors.anecdoteText).first();
      if (!$text.length) return undefined;

      // "Save only texts": skip picture / video / embed boxes.
      if ($text.find('img, video, iframe, picture, source, object, embed').length > 0) {
        this.#logger.debug('skip topicbox: media (not text)');
        return undefined;
      }

      const text = this.#extractText($, $text);
      if (text.length < minLen) {
        this.#logger.debug('skip topicbox: too short / empty');
        return undefined;
      }

      const id = ($box.attr('data-id') || '').trim();
      const url = id ? (resolveUrl(`/id/${id}/`, pageUrl) || '') : '';

      const key = id ? `id:${id}` : `txt:${text.slice(0, 120)}`;
      if (seen.has(key)) return undefined; // same box twice on one page
      seen.add(key);

      out.push({ type: 'anecdote', id, text, url });
      return undefined;
    });

    return out;
  }

  // --- helpers ---------------------------------------------------------------

  /** Turn <br> into newlines and tidy whitespace, preserving joke line breaks. */
  #extractText($, $text) {
    $text.find('br').replaceWith('\n');
    let raw = $text.text();
    raw = raw
      .replace(/\u00a0/g, ' ')      // nbsp -> space
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t]+\n/g, '\n')   // trailing spaces on a line
      .replace(/\n[ \t]+/g, '\n')   // leading spaces on a line
      .replace(/[ \t]{2,}/g, ' ')   // collapse runs of spaces
      .replace(/\n{3,}/g, '\n\n')   // collapse blank-line runs
      .trim();
    return raw;
  }

  /** True if the box sits inside (or is itself) an ad container. */
  #isAd($, $box) {
    const adSel = this.#config.selectors.adContainer;
    if (!adSel) return false;
    if ($box.is(adSel)) return true;
    return $box.closest(adSel).length > 0;
  }
}

export default PostParser;
