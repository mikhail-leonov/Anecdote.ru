/**
 * src/logger.js
 * -----------------------------------------------------------------------------
 * Logging + live statistics. Writes a timestamped, line-oriented log file to
 * data/logs/ and mirrors important lines to the console. Also maintains the
 * counters required by the spec (pages visited, posts processed, images
 * discovered/downloaded/skipped/duplicate, failures, retries).
 *
 * The logger owns no global state; create one instance and pass it around.
 * -----------------------------------------------------------------------------
 */

import { createWriteStream } from 'node:fs';
import path from 'node:path';
import { ensureDir, formatBytes, formatDuration } from './index.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export class Logger {
  #stream = null;
  #consoleLevel;
  #startedAt = Date.now();

  /** Counters surfaced in the final summary and progress line. */
  stats = {
    pagesVisited: 0,
    postsProcessed: 0,
    imagesDiscovered: 0,
    imagesDownloaded: 0,
    imagesSkipped: 0,
    duplicates: 0,
    failures: 0,
    retries: 0,
    bytesDownloaded: 0,
  };

  /**
   * @param {object} opts
   * @param {string} opts.logsDir         directory for the log file
   * @param {('debug'|'info'|'warn'|'error')} [opts.consoleLevel='info']
   */
  constructor({ logsDir, consoleLevel = 'info' }) {
    this.logsDir = logsDir;
    this.#consoleLevel = LEVELS[consoleLevel] ?? LEVELS.info;
  }

  /** Open the log file. Call once before logging. */
  async init() {
    await ensureDir(this.logsDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(this.logsDir, `scrape-${stamp}.log`);
    this.#stream = createWriteStream(file, { flags: 'a' });
    this.info(`Logging to ${file}`);
    return this;
  }

  #write(level, msg) {
    const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`;
    if (this.#stream) this.#stream.write(`${line}\n`);
    if (LEVELS[level] >= this.#consoleLevel) {
      const out = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
      out.write(`${line}\n`);
    }
  }

  debug(msg) { this.#write('debug', msg); }
  info(msg) { this.#write('info', msg); }
  warn(msg) { this.#write('warn', msg); }
  error(msg) { this.#write('error', msg); }

  // --- Category helpers that also bump the relevant counter ------------------

  page(url) {
    this.stats.pagesVisited += 1;
    this.info(`PAGE  visited: ${url}`);
  }

  post(url) {
    this.stats.postsProcessed += 1;
    this.debug(`POST  processed: ${url}`);
  }

  discovered(url, dims) {
    this.stats.imagesDiscovered += 1;
    this.debug(`IMG   discovered (${dims}): ${url}`);
  }

  downloaded(file, bytes) {
    this.stats.imagesDownloaded += 1;
    this.stats.bytesDownloaded += bytes;
    this.info(`SAVE  ${file} (${formatBytes(bytes)})`);
  }

  skipped(url, reason) {
    this.stats.imagesSkipped += 1;
    this.debug(`SKIP  ${reason}: ${url}`);
  }

  duplicate(url, reason) {
    this.stats.duplicates += 1;
    this.debug(`DUP   ${reason}: ${url}`);
  }

  failure(url, err) {
    this.stats.failures += 1;
    this.error(`FAIL  ${url} :: ${err?.message || err}`);
  }

  retry(url, attempt) {
    this.stats.retries += 1;
    this.warn(`RETRY attempt ${attempt}: ${url}`);
  }

  /** One-line progress indicator suitable for periodic printing. */
  progressLine() {
    const s = this.stats;
    const elapsed = Date.now() - this.#startedAt;
    const rate = s.imagesDownloaded / Math.max(1, elapsed / 1000); // imgs/sec
    return (
      `pages=${s.pagesVisited} posts=${s.postsProcessed} ` +
      `found=${s.imagesDiscovered} saved=${s.imagesDownloaded} ` +
      `dup=${s.duplicates} skip=${s.imagesSkipped} fail=${s.failures} ` +
      `data=${formatBytes(s.bytesDownloaded)} ` +
      `(${rate.toFixed(2)} img/s, ${formatDuration(elapsed)})`
    );
  }

  /** Print a full summary. Call at the end (or on shutdown). */
  summary() {
    const elapsed = Date.now() - this.#startedAt;
    this.info('================ SUMMARY ================');
    this.info(`Elapsed:            ${formatDuration(elapsed)}`);
    this.info(`Pages visited:      ${this.stats.pagesVisited}`);
    this.info(`Posts processed:    ${this.stats.postsProcessed}`);
    this.info(`Images discovered:  ${this.stats.imagesDiscovered}`);
    this.info(`Images downloaded:  ${this.stats.imagesDownloaded}`);
    this.info(`Duplicates skipped: ${this.stats.duplicates}`);
    this.info(`Other skips:        ${this.stats.imagesSkipped}`);
    this.info(`Failures:           ${this.stats.failures}`);
    this.info(`Retries:            ${this.stats.retries}`);
    this.info(`Data downloaded:    ${formatBytes(this.stats.bytesDownloaded)}`);
    this.info('=========================================');
  }

  /** Flush and close the log file. */
  async close() {
    if (!this.#stream) return;
    await new Promise((resolve) => this.#stream.end(resolve));
    this.#stream = null;
  }
}

export default Logger;
