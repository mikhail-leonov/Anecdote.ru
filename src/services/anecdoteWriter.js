/**
 * src/services/anecdoteWriter.js
 * -----------------------------------------------------------------------------
 * Each anecdote = separate object. Splits on <br><br><br> / multiple newlines.
 *
 * Every anecdote carries a `tags` array (default ["pejnya"]) so saved jokes can
 * be grouped/filtered by source. New anecdotes are tagged on write; any
 * pre-existing anecdotes are back-filled with the tag on startup.
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
  #tags;
  #buffer = [];
  #anecdotes = [];
  #hashes = new Set();
  #dirty = false;
  #title = 'Anecdotes';
  #nextIndex = 1;
  #fileCounts = new Map();

  constructor({ file, logger, tags = ['pejnya'] }) {
    this.#file = file;
    this.#logger = logger;
    this.#tags = Array.isArray(tags) && tags.length ? [...tags] : ['pejnya'];
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

      let loaded = Array.isArray(data.anecdotes) ? data.anecdotes : [];

      this.#fileCounts.set(fullPath, loaded.length);

      for (const a of loaded) {
        if (!a?.text?.trim()) continue;
        this.#applyTags(a); // keep in-memory copies tagged too
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

    // Back-fill the tag into anecdotes saved before tagging existed.
    await this.#backfillTags(files.map(f => path.join(dir, f)));

    this.#logger.debug(`AnecdoteWriter loaded ${this.#anecdotes.length} anecdotes`);
    return this;
  }

  static hashOf(text) {
    return createHash('sha256')
      .update(text.trim().replace(/\s+/g, ' '))
      .digest('hex');
  }

  /** Ensure an anecdote object carries the configured tags. Mutates in place. */
  #applyTags(entry) {
    if (!entry || typeof entry !== 'object') return false;
    if (!Array.isArray(entry.tags)) {
      entry.tags = [...this.#tags];
      return true;
    }
    let changed = false;
    for (const t of this.#tags) {
      if (!entry.tags.includes(t)) {
        entry.tags.push(t);
        changed = true;
      }
    }
    return changed;
  }

  /** Add the tag to any on-disk anecdote that lacks it (atomic, idempotent). */
  async #backfillTags(paths) {
    for (const full of paths) {
      const data = await readJsonSafe(full, null);
      if (!data || !Array.isArray(data.anecdotes)) continue;
      let changed = false;
      for (const a of data.anecdotes) {
        if (this.#applyTags(a)) changed = true;
      }
      if (changed) {
        await writeJsonAtomic(full, data);
        this.#logger.debug(`Back-filled tags in ${path.basename(full)}`);
      }
    }
  }

  async write({ text, title = 'Подборка анекдотов', url = '', dryRun = false }) {
    const body = (text || '').trim();
    if (!body) return { status: 'skipped', reason: 'empty' };

    const hash = AnecdoteWriter.hashOf(body);
    if (this.#hashes.has(hash)) return { status: 'skipped', reason: 'duplicate' };

    if (dryRun) {
      this.#logger.info(`DRY   would add anecdote`);
      return { status: 'dry-run' };
    }

    const entry = {
      title: title.trim(),
      text: body,
      tags: [...this.#tags],
      addedAt: new Date().toISOString()
    };
    if (url) entry.url = url;

    this.#buffer.push(entry);
    this.#hashes.add(hash);
    this.#dirty = true;

    this.#logger.info(`TEXT  added anecdote (${body.slice(0, 50).replace(/\n/g, ' ')}...)`);
    return { status: 'written' };
  }

  async save(force = false) {
    if (this.#buffer.length === 0 && !force) return;

    const activePath = this.#file;
    let activeCount = this.#fileCounts.get(activePath) || 0;

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
      anecdotes: [...existing, ...this.#buffer]
    };

    await writeJsonAtomic(activePath, updated);
    this.#fileCounts.set(activePath, updated.anecdotes.length);

    this.#anecdotes.push(...this.#buffer);
    this.#buffer = [];
    this.#dirty = false;
  }

  get count() {
    return this.#anecdotes.length;
  }
}

export default AnecdoteWriter;
