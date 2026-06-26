#!/usr/bin/env node
/**
 * src/index.js
 * -----------------------------------------------------------------------------
 * Executable entry point. Parses command-line arguments and hands off to the
 * scrape controller. (This replaces the previous Express server entry; the
 * project is now a CLI scraper, but the "src/index.js is the entry" convention
 * is preserved.)
 * -----------------------------------------------------------------------------
 */

import { pathToFileURL } from 'node:url';
import { parseCliArgs, HELP_TEXT } from './utils/index.js';
import { runScrape } from './controllers/scrapeController.js';

export async function main() {
  const cli = parseCliArgs();
  if (cli.help) {
    process.stdout.write(HELP_TEXT);
    return;
  }
  await runScrape(cli);
}

// Run only when executed directly (not when imported).
if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exitCode = 1;
  });
}

export default main;
