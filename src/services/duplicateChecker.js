/**
 * src/services/duplicateChecker.js
 * -----------------------------------------------------------------------------
 * Tracks which images have already been downloaded so the scraper can resume
 * without re-downloading. Persists through the JSON db layer (src/db/jsonStore)
 * and stores records in the shape defined by src/models/imageRecord.
 *
 * Three independent de-duplication signals (per the spec):
 *   - normalized original URL   (checked cheaply before any download)
 *   - filename already on disk   (avoids name collisions across runs)
 *   - SHA-256 of the file bytes  (same image served from two URLs)
 * -----------------------------------------------------------------------------
 */

import { JsonStore } from '../db/jsonStore.js';
import { createImageRecord } from '../models/imageRecord.js';
import { normalizeUrl } from '../utils/index.js';

export class DuplicateChecker {
  #store;
  #byUrl = new Set(); // normalized URLs
  #byHash = new Set(); // sha256 hex strings
  #filenames = new Set(); // filenames already used on disk
  #records = []; // full records persisted to disk
  #dirty = false;

  constructor({ file }) {
    this.#store = new JsonStore(file, { images: [] });
  }

  /** Load existing state from disk (empty if the file does not yet exist). */
  async load() {
    const data = await this.#store.load();
    const images = Array.isArray(data.images) ? data.images : [];
    for (const rec of images) {
      this.#records.push(rec);
      if (rec.normalizedUrl) this.#byUrl.add(rec.normalizedUrl);
      if (rec.sha256) this.#byHash.add(rec.sha256);
      if (rec.filename) this.#filenames.add(rec.filename);
    }
    return this;
  }

  /** True if this URL has already been downloaded (pre-download check). */
  hasUrl(url) {
    return this.#byUrl.has(normalizeUrl(url));
  }

  /** True if a file with this SHA-256 already exists (post-download check). */
  hasHash(sha256) {
    return this.#byHash.has(sha256);
  }

  /** The set of filenames already used — passed to uniqueFilename(). */
  get usedFilenames() {
    return this.#filenames;
  }

  /** Reserve a filename before bytes are written (concurrent-safe naming). */
  reserveFilename(filename) {
    this.#filenames.add(filename);
  }

  /** Record a completed download and mark state dirty for the next save(). */
  record({ url, filename, sha256, bytes }) {
    const rec = createImageRecord({ url, filename, sha256, bytes });
    this.#records.push(rec);
    this.#byUrl.add(rec.normalizedUrl);
    if (rec.sha256) this.#byHash.add(rec.sha256);
    this.#filenames.add(rec.filename);
    this.#dirty = true;
  }

  /** Persist to disk if anything changed since the last save. */
  async save(force = false) {
    if (!this.#dirty && !force) return;
    await this.#store.save({ images: this.#records });
    this.#dirty = false;
  }

  get count() {
    return this.#records.length;
  }
}

export default DuplicateChecker;
