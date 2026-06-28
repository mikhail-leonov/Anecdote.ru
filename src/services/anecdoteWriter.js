/**
 * src/services/anecdoteWriter.js
 * -----------------------------------------------------------------------------
 * Stores text anecdotes as JSON, 500 per file (anecdotes.json, then
 * anecdotes_1.json, anecdotes_2.json, ...). Each anecdote is one object:
 *
 *   { title, text, tags: [...], addedAt, url? }
 *
 * Tags are supplied per write (the anekdot.ru category, e.g. ["армия"]).
 * De-duplication is by normalized text hash, so the same joke is never stored
 * twice even when it appears under more than one category.
 * -----------------------------------------------------------------------------
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ensureDir, readJsonSafe, writeJsonAtomic } from '../utils/index.js';

const ANECDOTE_COUNT_THRESHOLD = 500;

export class AnecdoteWriter {
  #file;
  #logger;
  #defaultTags;
  #buffer = [];
  #anecdotes = [];
  #hashes = new Set();
  #dirty = false;
  #title = 'Anecdotes';
  #nextIndex = 1;
  #fileCounts = new Map();

  constructor({ file, logger, tags = [] }) {
    this.#file = file;
    this.#logger = logger;
    this.#defaultTags = Array.isArray(tags) ? [...tags] : [];
  }

  async init() {
    const dir = path.dirname(this.#file);
    await ensureDir(dir);

    let files = [];
    try {
      const entries = await fs.readdir(dir);
      files = entries.filter(f => f === 'anecdotes.json' || /^anecdotes_\d+\.json$/.test(f));
    } catch {}

    let maxIndex = 0;
    for (const f of files) {
      const fullPath = path.join(dir, f);
      const data = await readJsonSafe(fullPath, { title: this.#title, anecdotes: [] });
      const loaded = Array.isArray(data.anecdotes) ? data.anecdotes : [];
      this.#fileCounts.set(fullPath, loaded.length);

      for (const a of loaded) {
        if (!a?.text?.trim()) continue;
        if (!Array.isArray(a.tags)) a.tags = [];
        const hash = AnecdoteWriter.hashOf(a.text);
        if (!this.#hashes.has(hash)) {
          this.#hashes.add(hash);
          this.#anecdotes.push(a);
        }
      }

      const match = f.match(/^anecdotes_(\d+)\.json$/);
      if (match) maxIndex = Math.max(maxIndex, parseInt(match[1], 10));
    }

    this.#nextIndex = maxIndex + 1;
    this.#logger.debug(`AnecdoteWriter loaded ${this.#anecdotes.length} anecdotes`);
    return this;
  }

  static hashOf(text) {
    return createHash('sha256')
      .update(String(text).trim().replace(/\s+/g, ' '))
      .digest('hex');
  }

  /**
   * Add one anecdote.
   * @param {object} p
   * @param {string} p.text         the anecdote body
   * @param {string} [p.title='']   optional title (anekdot anecdotes have none)
   * @param {string} [p.url='']     optional permalink
   * @param {string[]} [p.tags]     category tags for this anecdote
   * @param {boolean} [p.dryRun=false]
   */
  async write({ text, title = '', url = '', tags, dryRun = false }) {
    const body = (text || '').trim();
    if (!body) return { status: 'skipped', reason: 'empty' };

    const hash = AnecdoteWriter.hashOf(body);
    if (this.#hashes.has(hash)) return { status: 'skipped', reason: 'duplicate' };

    if (dryRun) {
      this.#logger.info('DRY   would add anecdote');
      return { status: 'dry-run' };
    }

    const entryTags = (Array.isArray(tags) && tags.length ? tags : this.#defaultTags)
      .map(t => String(t).trim())
      .filter(Boolean);

    const entry = {
      title: String(title || '').trim(),
      text: body,
      tags: [...new Set(entryTags)],
      addedAt: new Date().toISOString(),
    };
    if (url) entry.url = url;

    this.#buffer.push(entry);
    this.#hashes.add(hash);
    this.#dirty = true;

    this.#logger.info(
      `TEXT  added anecdote [${entry.tags.join(', ')}] (${body.slice(0, 50).replace(/\n/g, ' ')}...)`,
    );
    return { status: 'written' };
  }

  async save(force = false) {
    if (this.#buffer.length === 0 && !force) return;

    const activePath = this.#file;
    let activeCount = this.#fileCounts.get(activePath) || 0;

    // Rotate the active file to anecdotes_<n>.json once it would exceed 500.
    if (activeCount > 0 && (activeCount + this.#buffer.length) > ANECDOTE_COUNT_THRESHOLD) {
      const dir = path.dirname(activePath);
      const indexedPath = path.join(dir, `anecdotes_${this.#nextIndex}.json`);

      await fs.rename(activePath, indexedPath);
      this.#fileCounts.set(indexedPath, activeCount);
      this.#fileCounts.delete(activePath);

      this.#logger.debug(`Rotated to ${path.basename(indexedPath)}`);
      this.#nextIndex += 1;
      activeCount = 0;
    }

    const current = await readJsonSafe(activePath, { title: this.#title, anecdotes: [] });
    const existing = Array.isArray(current.anecdotes) ? current.anecdotes : [];

    const updated = {
      title: this.#title,
      anecdotes: [...existing, ...this.#buffer],
    };

    await writeJsonAtomic(activePath, updated);
    this.#fileCounts.set(activePath, updated.anecdotes.length);

    this.#anecdotes.push(...this.#buffer);
    this.#buffer = [];
    this.#dirty = false;
  }

  get count() {
    return this.#anecdotes.length + this.#buffer.length;
  }
}

export default AnecdoteWriter;
