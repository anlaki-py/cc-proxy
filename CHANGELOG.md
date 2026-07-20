# Changelog

All notable changes to cc-proxy are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `src/catalog.js` — pulls model metadata from `https://models.dev/api.json`
  at boot. First-ever boot blocks briefly to download; subsequent boots
  return instantly from `.cache/models.dev.json` and fire a background
  refresh that updates the on-disk cache for next run. Refreshing logs
  `[catalog] updated from models.dev (N providers, M models)`. The
  bootstrap is silent on success and prints a one-liner on failure;
  the proxy keeps serving from cache.
- `modelSupportsVision(model)` lookup driven by the catalog's
  `modalities.input` field. When a request contains an image block and
  the resolved model does not accept image input, the image is dropped
  and (under `LOG=1`) a `~ dropping image (model X does not support vision)`
  warning is logged. The text content of the message is preserved.
- New `npm run prewarm-catalog` script for one-time cache download. Runs
  automatically as part of `npm run pretest`.

### Changed
- `src/models.js` — dropped the hardcoded `MODEL_MAX_TOKENS` and
  `MODEL_CONTEXT_LIMITS` tables. `getModelContextLimit`, `capMaxTokens`,
  and `needsMaxCompletionTokens` now look up `limit.context`,
  `limit.output`, and `reasoning` from the models.dev catalog. Safe
  fallbacks (32k context, 16k output) apply when the catalog is empty
  or the model is unknown.
- `src/thinking.js` — replaced the per-family string-match dispatch
  (o-series, grok, gemini-3, gemini-2.5, qwen, deepseek-r1/v3.1+) with
  catalog-driven dispatch over `reasoning_options`. The supported shapes
  are `{type:'effort', values:[...]}` (pick from the model's own allowed
  values using a budget-tokens ladder), `{type:'toggle'}` (qwen/deepseek
  `enable_thinking`), and `{type:'budget_tokens', min, max}` (gemini-2.5
  `thinking_budget`, clamped). Unknown models silently drop `thinking`.
- `src/request.js` — image blocks now pass through `modelSupportsVision()`
  before being forwarded. Behavior is otherwise identical.
- `src/main.js` — awaits `loadCatalog()` before `startServer()` so the
  proxy never serves a request with an empty catalog.
- `scripts/run-tests.js` — unit tests now run serially (concurrency=1).
  The HTTP-server-based retry tests were flaky on Windows when many
  files spun up loopback servers concurrently.

## [1.0.0] - 2026-07-20

### Added
- Initial npm-packaged release. The proxy logic itself is unchanged from
  the pre-npm `proxy.js` script; this release packages it as an
  installable, tested, linted npm package.
- `bin/cc-proxy.js` wrapper with Node 18+ version guard.
- Comprehensive test suite using Node's built-in `node:test` runner
  (unit + integration tests).
- CI workflow testing on Node 18, 20, 22, 24 across Linux and Windows.
- ESLint and Prettier configuration.
- Trusted-publishing release workflow with provenance attestation.
- `CONTRIBUTING.md` and `SECURITY.md`.
