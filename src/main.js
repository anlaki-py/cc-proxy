'use strict';

// ---------- entry: parse argv + env, start server, listen ----------
//
// Side-effect module. The build script loads this last (after all deps), so
// `require('../lib/proxy.js')` boots the proxy the same way the old monolith
// did. Kept side-effect-only so this file has nothing else to export.

const { parseArgs } = require('./cli.js');
const { startServer } = require('./server.js');
const { loadCatalog } = require('./catalog.js');

async function boot(argv) {
  const args = parseArgs(argv);
  const BASE = (args.base || process.env.OPENAI_BASE_URL || 'http://localhost:11434/v1').replace(
    /\/$/,
    '',
  );
  const KEY = args.key || process.env.OPENAI_API_KEY || '';
  const PORT = parseInt(args.port || process.env.PORT || '8082', 10);
  const MODEL_OVERRIDE = args.model || process.env.MODEL_OVERRIDE || '';
  const IMAGE_FETCH = !!args.imageFetch || process.env.IMAGE_FETCH === '1';
  const MAX_IMAGE_BYTES = parseInt(
    args.maxImageBytes || process.env.MAX_IMAGE_BYTES || String(20 * 1024 * 1024),
    10,
  );

  // Load the model catalog before the server starts accepting requests.
  // On first-ever boot this blocks for a network round trip; on every
  // subsequent boot it returns instantly from disk and fires a background
  // refresh.
  await loadCatalog();

  const server = startServer({
    base: BASE,
    key: KEY,
    modelOverride: MODEL_OVERRIDE,
    imageFetch: IMAGE_FETCH,
    maxImageBytes: MAX_IMAGE_BYTES,
  });

  server.listen(PORT, () => {
    console.log(`Anthropic <-> OpenAI proxy listening on http://localhost:${PORT}`);
    console.log(`  upstream: ${BASE}`);
    console.log(`  auth:     ${KEY ? 'bearer ***' + KEY.slice(-4) : 'none'}`);
    if (MODEL_OVERRIDE) console.log(`  model:    ${MODEL_OVERRIDE} (override)`);
    console.log('');
    console.log('To use with Claude Code:');
    console.log('');
    console.log(
      `ANTHROPIC_BASE_URL=http://localhost:${PORT} ANTHROPIC_AUTH_TOKEN=any-value claude`,
    );
    console.log('');
  });

  return server;
}

// Always boot on load. The original monolith ran parseArgs + server.listen at
// module top level, so `require('../lib/proxy.js')` from bin/cc-proxy.js started
// the proxy. Bundling must preserve that — main is the last module loaded, and
// we boot here unconditionally to keep the manual-install path identical.
boot(process.argv.slice(2)).catch((e) => {
  console.error('cc-proxy failed to start:', e.message);
  process.exit(1);
});

module.exports = { boot };
