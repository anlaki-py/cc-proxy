'use strict';

// Test-only catalog warmup. Shared by unit tests via require(); on first
// require it calls loadCatalogSync() which prefers the on-disk
// `.cache/models.dev.json` (kept fresh by `npm run prewarm-catalog`) and falls
// back to the vendored `src/catalog-data.json` bundled into the package. With
// the bundled copy present, unit tests no longer depend on the prewarm step
// having run — `loadCatalogSync()` always returns a populated catalog on a
// fresh checkout.
//
// IMPORTANT: do not include this from src/. Test-only.

const assert = require('node:assert');
const { loadCatalogSync, getCatalog } = require('../../src/catalog.js');

loadCatalogSync();

// Sanity: the catalog actually loaded. A silently-empty catalog would turn
// every model lookup into the safe-fallback path and mask real regressions
// (especially the NIM family-dispatch tests, which key off entry.family).
assert.ok(getCatalog(), 'catalog must be populated for tests (bundled or cached)');
