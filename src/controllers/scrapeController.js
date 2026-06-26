/**
 * src/controllers/scrapeController.js
 * -----------------------------------------------------------------------------
 * Controller layer: turns a parsed CLI-override object into an effective
 * configuration, constructs the Scraper service, and runs it. Keeping this
 * wiring out of the service makes the Scraper easy to unit-test or embed.
 * -----------------------------------------------------------------------------
 */

import { config as baseConfig } from '../config/index.js';
import { Scraper } from '../services/scraper.js';
import { applyCliOverrides } from '../utils/index.js';

/**
 * Run a full scrape.
 * @param {object} cli  parsed CLI overrides (see utils.parseCliArgs)
 * @returns {Promise<Scraper>} the scraper instance (for stats inspection)
 */
export async function runScrape(cli = {}) {
  const config = applyCliOverrides(baseConfig, cli);
  const scraper = new Scraper(config);
  await scraper.init();
  await scraper.run();
  return scraper;
}

export default runScrape;
