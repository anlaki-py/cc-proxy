'use strict';

// One-time prewarm: download models.dev catalog into .cache/ so the unit
// tests can load it synchronously. Run via `npm run prewarm-catalog` or
// automatically by `npm run pretest` (which the regular `npm test` chains
// to). Safe to run repeatedly — overwrites the cache file.

const process = require('node:process');
const { loadCatalog } = require('../src/catalog.js');

loadCatalog({ forceRefresh: true })
  .then(() => {
    process.stdout.write('[prewarm] catalog ready at .cache/models.dev.json\n');
    process.exit(0);
  })
  .catch((e) => {
    process.stderr.write(`[prewarm] failed: ${e.message}\n`);
    process.exit(1);
  });
