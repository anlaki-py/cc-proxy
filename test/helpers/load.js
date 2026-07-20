// Helper: load proxy.js without actually starting the HTTP server.
//
// `lib/proxy.js` runs side-effecting code at module top level (parses argv,
// binds a port, starts a server). For unit tests, we want to access its pure
// helper functions in isolation. We do that by reading the file source,
// stripping the auto-execution prelude and trailing server block, and
// evaluating the remainder in a fresh `vm` context with a stub `require`
// that provides only the `http` module's surface (which the file imports).
//
// The functions we expose: parseArgs, cleanupSchemaForChatCompletions,
// capMaxTokens, getModelContextLimit, needsMaxCompletionTokens, applyThinking,
// scaleUsage, contextScale, mapToolChoice, mapFinishReason, anthropicToOpenAITools,
// parseSSEEvents, anthropicToOpenAIMessages, resolveImageSource, fetchWithRetry,
// isRetryableNetworkError, parseRetryAfter, StreamBuilder, anthropicError,
// writeJsonError, sse, estimateInputTokens.

'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const Module = require('module');

const PROXY_PATH = path.join(__dirname, '..', '..', 'lib', 'proxy.js');

function loadProxy(args = []) {
  const src = fs.readFileSync(PROXY_PATH, 'utf8');

  // We need to grab the function/const definitions but skip the side effects
  // (the call to `parseArgs(process.argv.slice(2))`, the `const http = require('http')`,
  // the `const server = http.createServer(...)`, and the `server.listen(...)` call).
  //
  // Strategy: rewrite the file to expose everything we want on globalThis
  // and stub out the side-effecting parts.

  // 0) Strip the shebang — vm can't parse it.
  let transformed = src.replace(/^#![^\n]*\n/, '');

  // 1) Replace `const http = require('http');` with a noop (we don't need http
  //    in unit tests — we don't start the server).
  transformed = transformed.replace(
    /const http = require\('http'\);/,
    '/* const http = require("http"); — stubbed in test loader */'
  );

  // 2) Replace the top-level config block that depends on parseArgs + env.
  //    The block we want to remove starts at the `const args = parseArgs(...)`
  //    line and ends right before the `function parseArgs` definition.
  transformed = transformed.replace(
    /const args = parseArgs\(process\.argv\.slice\(2\)\);[\s\S]*?function parseArgs/,
    '/* config + args prelude stubbed in test loader */\nfunction parseArgs'
  );

  // 3) Replace the trailing server creation + listen block. It begins with
  //    `const server = http.createServer(...)` and runs to EOF.
  transformed = transformed.replace(
    /\/\/ ---------- HTTP server ----------[\s\S]*$/,
    '/* HTTP server block stubbed in test loader */\n' +
      'module.exports = { parseArgs, cleanupSchemaForChatCompletions, capMaxTokens, ' +
      'getModelContextLimit, needsMaxCompletionTokens, applyThinking, scaleUsage, ' +
      'contextScale, mapToolChoice, mapFinishReason, anthropicToOpenAITools, ' +
      'parseSSEEvents, anthropicToOpenAIMessages, resolveImageSource, fetchWithRetry, ' +
      'isRetryableNetworkError, parseRetryAfter, StreamBuilder, anthropicError, ' +
      'writeJsonError, sse, estimateInputTokens };'
  );

  // 4) Run parseArgs with the test-provided argv, then build the same config
  //    constants the real module top-level would build. These are read by
  //    `resolveImageSource` (IMAGE_FETCH, MAX_IMAGE_BYTES) and other helpers,
  //    so we have to recreate them here.
  const __args = JSON.parse(JSON.stringify(args));
  const prelude = [
    `const __args = ${JSON.stringify(args)};`,
    `const args = __args;`,
    `const BASE = (args.base || '').replace(/\\/$/, '') || 'http://localhost:11434/v1';`,
    `const KEY = args.key || '';`,
    `const PORT = 0;`,
    `const MODEL_OVERRIDE = args.model || '';`,
    `const IMAGE_FETCH = !!args.imageFetch;`,
    `const MAX_IMAGE_BYTES = 20 * 1024 * 1024;`,
  ].join('\n') + '\n';
  const fullSource = prelude + transformed;

  const sandbox = {};
  // Provide a minimal `process` mock (only the fields the file touches).
  sandbox.process = {
    env: {},
    versions: { node: process.versions.node },
    stdout: { write: () => {} },
    stderr: { write: () => {} },
    exit: (code) => {
      throw new Error(`process.exit(${code}) called`);
    },
  };
  sandbox.console = console;
  sandbox.setTimeout = setTimeout;
  sandbox.clearTimeout = clearTimeout;
  sandbox.fetch = (...a) => fetch(...a);
  sandbox.AbortController = AbortController;
  sandbox.AbortSignal = AbortSignal;
  sandbox.Buffer = Buffer;
  sandbox.TextDecoder = TextDecoder;
  sandbox.JSON = JSON;
  sandbox.Math = Math;
  sandbox.Date = Date;
  sandbox.Set = Set;
  sandbox.Map = Map;
  sandbox.Number = Number;
  sandbox.Object = Object;
  sandbox.Array = Array;
  sandbox.String = String;
  sandbox.Error = Error;
  sandbox.Promise = Promise;
  sandbox.globalThis = sandbox;

  // Note: the file references `args` in its own `parseArgs` body? No, parseArgs
  // is a self-contained function. But other config constants were in the
  // removed block. The only top-level references that survive in the file
  // are the helper functions themselves. So we don't need to re-inject `args`.
  //
  // However, the test still needs to be able to call `parseArgs(__args)`. We
  // expose the module via the sandbox's `module.exports`; but the rewritten
  // source uses CommonJS assignment, which works in a vm context with a
  // stubbed `module` global.
  sandbox.module = { exports: {} };
  sandbox.exports = sandbox.module.exports;
  sandbox.require = (name) => {
    if (name === 'http') return { createServer: () => ({ listen: () => {} }) };
    // fall back to real require for anything unexpected
    return Module.createRequire(__filename)(name);
  };

  vm.createContext(sandbox);
  vm.runInContext(fullSource, sandbox, { filename: PROXY_PATH });

  return sandbox.module.exports;
}

module.exports = { loadProxy, PROXY_PATH };
