/**
 * src/db/jsonStore.js
 * -----------------------------------------------------------------------------
 * The project's persistence layer. The spec forbids any real database, so this
 * folder provides a tiny JSON-file store instead of SQL. Every piece of durable
 * state (downloaded-images, visited-pages, metadata) is a JsonStore.
 *
 * Writes are atomic (temp file + rename) so a crash mid-write cannot corrupt a
 * state file — which is what makes the scraper safely resumable.
 * -----------------------------------------------------------------------------
 */

import { readJsonSafe, writeJsonAtomic } from '../utils/index.js';

export class JsonStore {
  #file;
  #fallback;
  #data;

  /**
   * @param {string} file       path to the JSON file
   * @param {*} fallback         value returned/seeded when the file is absent
   */
  constructor(file, fallback) {
    this.#file = file;
    this.#fallback = fallback;
  }

  /** Load (or initialise) the store and return the data. Never throws. */
  async load() {
    this.#data = await readJsonSafe(this.#file, structuredClone(this.#fallback));
    return this.#data;
  }

  /** The currently held data (after load). */
  get data() {
    return this.#data;
  }

  /** Persist the given object (or the held data) atomically. */
  async save(data) {
    this.#data = data ?? this.#data;
    await writeJsonAtomic(this.#file, this.#data);
  }
}

export default JsonStore;
