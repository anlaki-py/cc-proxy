'use strict';

// Test-only catalog warmup. Unit tests share this file via require(); on
// first require it calls loadCatalogSync() which reads .cache/models.dev.json
// if present. If no cache exists, it falls back to the existing hardcoded
// fallback behavior (safe defaults). The integration test pre-warms the
// cache by running the actual server, so by the time CI runs `test/unit`,
// the file is on disk. Locally, run `node scripts/prewarm-catalog.js` once
// to download it for the first time.
//
// IMPORTANT: do not include this from src/. Test-only.

const { loadCatalogSync } = require('../../src/catalog.js');

loadCatalogSync();
