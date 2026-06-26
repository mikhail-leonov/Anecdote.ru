/**
 * src/services/postParser.js
 * -----------------------------------------------------------------------------
 * Parses a listing (index) page and returns the dedicated post-page URLs worth
 * visiting. A post qualifies only if:
 *   - it is not inside an advertisement/sponsored container, and
 *   - it appears to contain an image (text-only posts are ignored), and
 *   - it links to a dedicated post page we can open.
 *
 * Detection is deliberately conservative.
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

  /**
   * @param {import('cheerio').CheerioAPI} $  loaded listing page
   * @param {string} pageUrl                  the listing page URL
   * @returns {Array<{type:'media'|'anecdote', postUrl?:string, title:string, text?:string}>}
   */
  parsePosts($, pageUrl) {
    const { selectors } = this.#config;
    const seen = new Set();
    const posts = [];

    $(selectors.post).each((_i, el) => {
      const $post = $(el);

      if (this.#isAd($, $post)) {
        this.#logger.debug('skip post: advertisement/sponsored');
        return;
      }

      const title = this.#findTitle($, $post);

      // (a) ANECDOTE first — its header carries a tiny bullet <img>, so checking
      // media first would misclassify it.
      if (this.#config.behavior.saveAnecdotes && this.#looksLikeAnecdote($, $post)) {
        const texts = this.#anecdoteText($, $post);
        for (const text of texts) {
          if (text) {
            posts.push({ type: 'anecdote', title, text });
          }
        }
        return;
      }

      // (b) MEDIA
      if (this.#hasMedia($, $post)) {
        const urls = this.#findMediaUrls($, $post, pageUrl);
        if (urls.length === 0) {
          this.#logger.debug('skip media post: no link found');
          return;
        }
        for (const u of urls) {
          const key = normalizeUrl(u);
          if (seen.has(key)) continue;
          seen.add(key);
          posts.push({ type: 'media', postUrl: u, title });
        }
        return;
      }

      this.#logger.debug('skip post: not media, not anecdote');
    });

    return posts;
  }

  // --- helpers ---------------------------------------------------------------

  /**
   * Extract the post title from the header cell.
   */
  #findTitle($, $post) {
    const titleSel = this.#config.selectors.postTitle;
    let raw = titleSel ? $post.find(titleSel).first().text() : '';
    if (!raw) raw = $post.find(this.#config.selectors.postLink).first().text();
    const sep = this.#config.selectors.titleSeparator;
    if (sep && raw.includes(sep)) raw = raw.split(sep)[0];
    return raw.replace(/\s+/g, ' ').trim();
  }

  /** A post carries media if it has a media link or a <video>. */
  #hasMedia($, $post) {
    const ml = this.#config.selectors.mediaLink;
    if (ml && $post.find(ml).length > 0) return true;
    if ($post.find('video, video source').length > 0) return true;
    if (!ml && this.#hasImage($, $post)) return true;
    return false;
  }

  /** All distinct media URLs in a post */
  #findMediaUrls($, $post, pageUrl) {
    const urls = [];
    const seen = new Set();
    const sels = [this.#config.selectors.mediaLink, this.#config.selectors.postLink].filter(Boolean);
    for (const sel of sels) {
      $post.find(sel).each((_i, a) => {
        const h = $(a).attr('href');
        if (!h) return;
        if (h.startsWith('#') || h.startsWith('mailto:') || h.startsWith('javascript:')) return;
        const abs = resolveUrl(h, pageUrl);
        if (abs && !seen.has(abs)) {
          seen.add(abs);
          urls.push(abs);
        }
      });
      if (urls.length > 0) break;
    }
    return urls;
  }

  /** A non-media post is an anecdote when it carries the section marker. */
  #looksLikeAnecdote($, $post) {
    const marker = this.#config.selectors.anecdoteMarker;
    if (marker) return $post.find(marker).length > 0;
    return true; // fallback
  }

  /**
   * Extract anecdote text and split into separate anecdotes on <br><br><br>
   */
  #anecdoteText($, $post) {
    const sel = this.#config.selectors.anecdoteText;
    const $c = sel ? $post.find(sel).first() : $post;
    if (!$c.length) return [];

    // Replace <br> with newlines for easier splitting
    $c.find('br').replaceWith('\n');

    const raw = $c.text().trim();
    if (!raw) return [];

    // Split on triple newlines (which come from <br><br><br>)
    const blocks = raw.split(/\n\s*\n\s*\n/);

    return blocks
      .map(block => block.trim())
      .filter(block => block.length >= (this.#config.behavior.anecdoteMinLength || 40));
  }

  /** True if the post sits inside (or is itself) an ad container. */
  #isAd($, $post) {
    const adSel = this.#config.selectors.adContainer;
    if (!adSel) return false;
    if ($post.is(adSel)) return true;
    return $post.closest(adSel).length > 0 || $post.find(adSel).length > 0;
  }

  /** True if the post contains a content image in the listing markup. */
  #hasImage($, $post) {
    const imgs = $post.find(this.#config.selectors.postThumbnail);
    if (imgs.length === 0) return false;
    let found = false;
    imgs.each((_i, img) => {
      const $img = $(img);
      if (
        $img.attr('src') ||
        $img.attr('data-src') ||
        $img.attr('data-original') ||
        $img.attr('srcset')
      ) {
        found = true;
        return false; // break
      }
      return undefined;
    });
    return found;
  }
}

export default PostParser;