# Changelog

All notable changes to cc-proxy are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed
- `400 Unsupported parameter(s): enable_thinking` when proxying Claude Code to
  an NVIDIA NIM model. NIM rejects the top-level `enable_thinking` param the
  toggle reasoning branch emits, and the `developer` message role (which
  500s when combined with `chat_template_kwargs`). cc-proxy often sits in
  front of a provider aggregator that bundles many providers behind one base
  URL; the aggregator tags a model as NIM-served by appending `-[Provider]`
  (e.g. `minimaxai/minimax-m3-[Nvidia]`). cc-proxy now gates NIM shaping on
  that suffix, and for a NIM-served model emits per-family reasoning fields
  nested inside `chat_template_kwargs` instead:
  - minimax (M2.x/M3): `{thinking_mode: "enabled"|"disabled"}`
  - kimi (k2/k2.6): `{thinking: true}` (+ `reasoning_effort` when the catalog
    resolves an effort-tagged copy)
  - glm (z-ai/zhipu on NIM): `{enable_thinking: true, clear_thinking: false}`
  - deepseek (v4-flash/pro): `{thinking: true}` (+ `reasoning_effort`)
  - nemotron and other NVIDIA in-house: `{thinking: true}`
  Models with any other (or no) suffix keep the existing `effort` /
  `budget_tokens` / `toggle` cascade and `developer` role. A NIM-tagged model
  not present in the catalog silently drops thinking rather than emitting a
  param NIM rejects — the proxy never lets an unknown model 400.
- The NIM gate keys off the model's `-[Provider]` suffix, not the upstream
  host (a fixed aggregator URL, useless as a signal) nor the catalog-resolved
  provider name (a metadata heuristic that resolves `moonshotai/kimi-k2.6` to
  the `moonshotai` catalog entry, not `nvidia`). The suffix is the only
  signal that survives an aggregator hop.

### Added
- The models.dev model catalog is now **vendored** as `src/catalog-data.json`
  (~3 MB) and ships in the npm tarball. A first-ever boot no longer blocks on a
  network round-trip — the bundled copy seeds the in-memory catalog at module
  load, and the existing background refresh keeps the runtime `.cache/` copy
  fresh. Manual curl-install of `lib/proxy.js` alone (no JSON) still degrades
  gracefully to the foreground fetch on first boot.
- `findModelEntry(bareId)` in `src/catalog.js`, returning
  `{entry, providerName}` (the catalog metadata provider the winning entry
  was sourced from). `findModel` is now a thin wrapper over it; its signature
  and call sites are unchanged.
- `CCPROXY_NIM_SUFFIXES` env var: a comma-separated list of extra
  `-[Provider]` suffix names (beyond the defaults `Nvidia` and `NIM`) to treat
  as NVIDIA NIM, for aggregators that tag NIM traffic with a custom name.

## [1.0.0] - 2026-07-24


### Added
- Initial npm-packaged release. The proxy logic itself is unchanged from
  the pre-npm `proxy.js` script; this release packages it as an
  installable, tested, linted npm package.
- `bin/cc-proxy.js` wrapper with Node 18+ version guard.
- Comprehensive test suite using Node's built-in `node:test` runner
  (unit + integration tests).
- CI workflow testing on Node 18, 20, 22, 24 across Linux and Windows.
- ESLint and Prettier configuration.
- GitHub Release workflow that creates a release with auto-generated
  notes when a `v*` tag is pushed.
- `CONTRIBUTING.md` and `SECURITY.md`.
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
- Graceful shutdown on SIGTERM/SIGINT. The proxy stops accepting new
  connections and lets in-flight requests drain before exiting. A second
  signal forces an immediate exit (conventional Ctrl-C-twice behavior).
  The drain timeout defaults to 10s and is overridable via
  `CCPROXY_SHUTDOWN_TIMEOUT_MS`.

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
- `GET /v1/models` now returns `502` in the Anthropic error envelope when
  the upstream `/models` call fails (network error or non-2xx response),
  instead of masking the failure with `200` and an empty model list. This
  lets Claude Code surface upstream outages instead of silently treating
  them as "no models available."
- `src/catalog.js`, `src/request.js`, `src/retry.js`, `src/server.js`,
  `src/main.js` — added explicit `require('node:process')` for consistency
  with the rest of the tree rather than relying on the global `process`.
- `src/retry.js` — `reqAbortSignal` no longer guards on
  `typeof AbortSignal.timeout === 'function'` (a vestigial check for an API
  it never used); it now only checks for a request object.
- `scripts/run-tests.js` — unit tests now run serially (concurrency=1).
  The HTTP-server-based retry tests were flaky on Windows when many
  files spun up loopback servers concurrently.

### Removed
- Dead state in `src/catalog.js`: the write-only `lastLoaded` timestamp
  and the write-only `bestExactProvider` loop variable have been removed.

### Fixed
- `package.json` — `globals` is now a direct devDependency (it is
  `require`d by `eslint.config.js` but was previously only available via a
  transitive install of `eslint`). A future `eslint` minor bump could
  otherwise have broken `npm run lint` on a fresh install.
- ESLint is now clean: all 17 pre-existing `no-unused-vars` warnings are
  resolved. Unused `catch (e)` bindings were converted to optional catch
  binding (`catch {}`), and the lint rule now also ignores `catch (_)`.
