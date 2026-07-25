'use strict';

// ---------- entry: parse argv + env, start server, listen ----------
//
// Side-effect module. The build script loads this last (after all deps), so
// `require('../lib/proxy.js')` boots the proxy the same way the old monolith
// did. Kept side-effect-only so this file has nothing else to export.

const process = require('node:process');

const { parseArgs } = require('./cli.js');
const { startServer } = require('./server.js');
const { loadCatalog } = require('./catalog.js');
const { resolveFromProfiles } = require('./profiles.js');

// Maximum number of ports to try before giving up when EADDRINUSE is hit.
const MAX_PORT_ATTEMPTS = 10;

async function boot(argv) {
  const args = parseArgs(argv);

  // When neither -b nor -k is on the command line, offer saved profiles
  // (interactive TTY). Non-TTY falls through to env/defaults as before.
  let profileBase;
  let profileKey;
  let profileName;
  if (args.base === undefined && args.key === undefined) {
    const picked = await resolveFromProfiles();
    if (picked) {
      profileBase = picked.base;
      profileKey = picked.key;
      profileName = picked.name;
    }
  }

  const BASE = (
    args.base ||
    profileBase ||
    process.env.OPENAI_BASE_URL ||
    'http://localhost:11434/v1'
  ).replace(/\/$/, '');
  const KEY =
    args.key !== undefined
      ? args.key
      : profileKey !== undefined
        ? profileKey
        : process.env.OPENAI_API_KEY || '';
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

  // Try listening on PORT; if it's taken, increment and retry up to
  // MAX_PORT_ATTEMPTS times before giving up. Emits a warning so the user
  // knows which port was actually bound.
  const boundPort = await listenWithFallback(server, PORT);

  console.log(`Anthropic <-> OpenAI proxy listening on http://localhost:${boundPort}`);
  if (profileName) console.log(`  profile:  ${profileName}`);
  console.log(`  upstream: ${BASE}`);
  console.log(`  auth:     ${KEY ? 'bearer ***' + KEY.slice(-4) : 'none'}`);
  if (MODEL_OVERRIDE) console.log(`  model:    ${MODEL_OVERRIDE} (override)`);
  console.log('');
  console.log('To use with Claude Code:');
  console.log('');
  console.log('  bash / zsh:');
  console.log(
    `    ANTHROPIC_BASE_URL=http://localhost:${boundPort} ANTHROPIC_AUTH_TOKEN=any-value claude`,
  );
  console.log('');
  console.log('  PowerShell:');
  console.log(
    `    $env:ANTHROPIC_BASE_URL="http://localhost:${boundPort}"; $env:ANTHROPIC_AUTH_TOKEN="any-value"; claude`,
  );
  console.log('');
  console.log('  cmd:');
  console.log(
    `    set ANTHROPIC_BASE_URL=http://localhost:${boundPort} && set ANTHROPIC_AUTH_TOKEN=any-value && claude`,
  );
  console.log('');

  // Graceful shutdown. On SIGTERM/SIGINT we stop accepting new connections and
  // let in-flight requests drain. Each handler removes itself so a second
  // signal falls through to Node's default (immediate exit) — matching
  // conventional Ctrl-C-twice-to-force behavior. A hard timeout (default
  // 10s, overridable via CCPROXY_SHUTDOWN_TIMEOUT_MS) prevents a stuck client
  // from hanging the process.
  let shuttingDown = false;
  function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`\ncc-proxy received ${signal}, shutting down...\n`);
    process.removeListener('SIGTERM', onTerm);
    process.removeListener('SIGINT', onInt);
    const forceAfter = Number(process.env.CCPROXY_SHUTDOWN_TIMEOUT_MS) || 10000;
    const timer = setTimeout(() => {
      process.stderr.write('cc-proxy: forcing exit after shutdown timeout\n');
      process.exit(1);
    }, forceAfter).unref();
    server.close(() => {
      clearTimeout(timer);
      process.exit(0);
    });
  }
  function onTerm() {
    shutdown('SIGTERM');
  }
  function onInt() {
    shutdown('SIGINT');
  }
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);

  return server;
}

/**
 * Attempt to listen on `port`. If EADDRINUSE is thrown, increment and retry
 * up to MAX_PORT_ATTEMPTS times. Resolves with the port that was actually
 * bound. Rejects if every attempt fails or a non-EADDRINUSE error is thrown.
 *
 * @param {import('node:http').Server} server
 * @param {number} port  Desired starting port
 * @returns {Promise<number>}  Bound port
 */
function listenWithFallback(server, port) {
  return new Promise((resolve, reject) => {
    let attempt = 0;

    function tryListen(p) {
      server.once('error', onError);
      server.listen(p, onListening);

      function onListening() {
        server.removeListener('error', onError);
        resolve(p);
      }

      function onError(err) {
        server.removeListener('listening', onListening);
        if (err.code !== 'EADDRINUSE') {
          return reject(err);
        }
        attempt++;
        if (attempt >= MAX_PORT_ATTEMPTS) {
          return reject(new Error(`could not bind to any port in range ${port}–${p} (all in use)`));
        }
        process.stderr.write(`cc-proxy: port ${p} is already in use, trying ${p + 1}...\n`);
        tryListen(p + 1);
      }
    }

    tryListen(port);
  });
}

// Always boot on load. The original monolith ran parseArgs + server.listen at
// module top level, so `require('../lib/proxy.js')` from bin/cc-proxy.js started
// the proxy. Bundling must preserve that — main is the last module loaded, and
// we boot here unconditionally to keep the manual-install path identical.
boot(process.argv.slice(2)).catch((e) => {
  console.error('cc-proxy failed to start:', e.message);
  process.exit(1);
});

module.exports = { boot, listenWithFallback };
