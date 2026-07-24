# Handoff: Fix NVIDIA NIM `enable_thinking` 400 + bundle models.dev catalog

## Goal

Two bugs reported by the user when using cc-proxy pointed at NVIDIA NIM
(`https://integrate.api.nvidia.com/v1`) from Claude Code:

1. **`400 Unsupported parameter(s): enable_thinking`** — when the user picks
   `minimaxai/minimax-m3-[Nvidia]` and sends a prompt, cc-proxy emits
   `enable_thinking: true` as a top-level param in the OpenAI Chat Completions
   request. NVIDIA NIM rejects this with a 400. NVIDIA NIM does NOT accept
   `enable_thinking` for this model; it expects `chat_template_kwargs` with a
   family-specific field (`thinking_mode` for minimax-m3, `thinking:true` for
   kimi-k2, etc.).

   **This is the cc-proxy bug we're fixing.**

2. **`Model 'moonshotai/kimi-k2.6-[Nvidia]' not found`** — this string is NOT
   emitted by cc-proxy. Grepping `src/` confirms only `src/server.js:89` emits
   `not found: METHOD /url` (HTTP route-level). The `Model 'X' not found`
   message comes from **Claude Code's own `/model` picker** validating model
   IDs against a list built from `/v1/models`. cc-proxy passes `/v1/models`
   through unchanged from upstream (`src/server.js:48-83`) and has no control
   over the `[Nvidia]` suffix label — that's added by Claude Code's provider
   routing config. **This is out of cc-proxy's scope; nothing to fix here.**

The chosen implementation direction (confirmed by the user in plan mode):
- Vendor the models.dev catalog under `src/` as `src/catalog-data.json` so
  cc-proxy always has it available with no network round-trip at boot.
  (`SAFE_FALLBACK_CONTEXT`/`SAFE_FALLBACK_OUTPUT` in `src/models.js:15-16`
  are the only built-in values left; the README/changelog confirm all
  hardcoded model tables were dropped in 1.0.0. So "built in catalog list
  is ass" refers to "the bundled copy is stale/missing", not hardcoded
  tables — we're bundling a fresh copy from `.cache/models.dev.json`.)
- Make `src/thinking.js` provider-aware: when `findModel()` resolves the
  entry via the `nvidia` provider, branch on `entry.family` and emit the
  NIM-specific `chat_template_kwargs` shape instead of `enable_thinking`.

## Current state

- **Working tree is clean** (`git status` → nothing to commit, branch
  `master` up to date with `origin/master` as of 2026-07-24).
- **No implementation has been written.** This handoff captures the plan
  decided in the previous session; nothing is mid-change on disk.
- A full plan was drafted and approved in the prior session. The plan lives
  in this document (see "Next steps"). No code was written because the
  session ran in read-only/plan mode.
- The models.dev catalog is already downloaded at
  `.cache/models.dev.json` (3.2 MB, 167 providers, ~1000+ models). This is
  the source for the new `src/catalog-data.json`.

## Files involved

Implementation targets (none exist yet — all to be created/modified):

- `src/catalog-data.json` — **NEW.** Vendored copy of models.dev's
  `api.json`, copied from `.cache/models.dev.json`. Must be committed and
  added to `package.json`'s `files` whitelist so the npm tarball ships it.
  ~3.2 MB.
- `src/catalog.js` — **MODIFY.** Read `src/catalog-data.json`
  synchronously at module load as the initial `currentCatalog` seed, so
  `loadCatalogSync()` returns data even on a fresh clone with no
  `.cache/models.dev.json`. Keep the existing `loadCatalog()` background
  refresh path; the cache file is still preferred when fresh. Add a
  sibling helper `findModelEntry(bareId, catalog)` that returns
  `{entry, providerName}` (current `findModel` returns only the entry —
  `applyThinking` needs the provider name to gate NIM-specific behavior).
  Keep `findModel` as a thin wrapper over `findModelEntry` for backwards
  compatibility (no other call site breaks).
- `src/thinking.js` — **MODIFY.** `applyThinking(anth, req, model)` must:
  (a) call `findModelEntry(stripProviderSuffix(model))` to get the
  resolved provider; (b) if `providerName === 'nvidia'`, dispatch on
  `entry.family` to emit `chat_template_kwargs` per family; (c) otherwise
  fall through to the existing `effort` / `budget_tokens` / `toggle`
  branches unchanged (so OpenRouter, DeepSeek's own API, MiniMax's own
  API, GLM's z.ai/zhipuai APIs etc. keep working).
- `src/request.js` — **MODIFY.** Line 31 switches `system→developer` when
  `needsMaxCompletionTokens(model)` is true. Per the xRyul NIM README, the
  `developer` role combined with `chat_template_kwargs` causes 500s on NIM.
  Expose `isNimModel(model)` from `catalog.js` (queries `findModelEntry`
  and checks `providerName === 'nvidia'`) and keep `role:'system'` for NIM
  reasoning models even when `needsMaxCompletionTokens` returns true.
- `package.json` — **MODIFY.** Add `src/catalog-data.json` to the `files`
  whitelist (currently `["bin/", "lib/", "README.md", "LICENSE",
  "CHANGELOG.md"]`).否则 the npm tarball won't include the vendored
  catalog and the bundled-load path breaks for `npm install -g cc-proxy`
  users.
- `test/unit/thinking.test.js` — **MODIFY.** Add NIM branch cases:
  `minimaxai/minimax-m3-[Nvidia]` enabled → `chat_template_kwargs.thinking_mode==='enabled'`,
  no `enable_thinking`. Same model disabled → `{thinking_mode:'disabled'}`.
  `moonshotai/kimi-k2.6-[Nvidia]` → `{thinking:true}` plus
  `reasoning_effort` from the effort ladder (nvidia's kimi-k2.6 entry has
  `reasoning_options:[{type:'effort', values:['none','minimal','low','medium','high','xhigh','max']}]`).
  `z-ai/glm-5.2` resolved via nvidia → `{enable_thinking:true,
  clear_thinking:false}`. Canonical (non-Nvidia) provider lookups for the
  same model ids must keep the old `toggle`/`effort` behavior (regression
  guard).
- `test/unit/request.test.js` — **NEW or extend** (check if it exists
  first). Cover `developer → system` role retention for NIM models.
- `test/helpers/load-catalog.js` — **REVIEW.** With the bundled catalog,
  `loadCatalogSync()` always returns data; the "first time run prewarm"
  message becomes obsolete. Replace it with a sanity assertion that the
  bundled data loaded (one-line `assert.ok(getCatalog())`).
- `scripts/build.js` — **REVIEW.** The concat bundler wraps `src/*.js`
  only. `require('./catalog-data.json')` is a `.json` file, which the
  bundler's `_require` shim (lines 100-106) routes through
  `__ccproxy_externalRequire` — Node's real `require` — which handles
  JSON natively. **Verify** this actually works after the change; if not,
  update `scripts/build.js` to wrap `catalog-data.json` as a CommonJS
  factory and add `catalog-data` to the `ORDER` array (line 26).
- `README.md` — **MODIFY.** Add a one-line note under "What it does" that
  the models.dev catalog is now bundled (~3 MB) so first-ever boot no
  longer blocks on the network; the background refresh keeps it fresh.
- `CHANGELOG.md` — **MODIFY.** Add entries under `[Unreleased]` for the
  bug and the fix. Note that the Claude Code `/model 'X-[Nvidia]' not
  found` picker failure is a Claude Code config-layer issue, not cc-proxy.

Reference (read-only, already correct):
- `.cache/models.dev.json` — the live cache (3.2 MB). Source for
  `src/catalog-data.json`.
- `src/server.js` — HTTP server. `/v1/models` passes through at lines
  48-83. No changes needed here.
- `src/models.js` — `needsMaxCompletionTokens` and `capMaxTokens` already
  catalog-driven. `SAFE_FALLBACK_CONTEXT`/`OUTPUT` are the only built-in
  values and they're correct (safe over/under-report). No changes needed.
- `src/main.js` — `await loadCatalog()` at line 57 stays. With the inline
  bundled seed, this call becomes near-instant and never blocks on
  network, but the background refresh path is preserved.

## What's changed this session

Nothing — the session ran in read-only/plan mode the entire time. `git
status` confirms the working tree is clean. All findings, the diagnosis,
the chosen direction, and this handoff document are the only outputs.

## Constraints and things to avoid

- **No new runtime dependencies.** cc-proxy is zero-dependency by design
  (`README.md:3`, `package.json:56-60` has only devDependencies). The fix
  must use only Node built-ins (`fs`, `path`, `process`, `fetch`).
- **Backward compatibility for non-NVIDIA upstreams.** OpenRouter,
  Anthropic, OpenAI, MiniMax's own platform (`minimax.io`),
  Moonshot's own API, Zhipu's own API, DeepSeek's own API, Groq, etc.
  all keep working with the existing `effort`/`toggle`/`budget_tokens`
  shapes. Do NOT change behavior for entries resolved through providers
  other than `nvidia`. The dispatch gate is `providerName === 'nvidia'`
  (a `Set` named e.g. `NIM_PROVIDER_NAMES` so it's extensible if other
  NIM mirror providers appear later — e.g. `nvidia-coding-plan`,
  nothing else I'm aware of).
- **Do NOT modify `.cache/models.dev.json`.** It's regenerated by the
  background refresh and prewarm scripts; editing it is pointless. The
  vendored `src/catalog-data.json` is the actual source-of-truth for the
  commit, and the background refresh keeps the (separate, runtime-only)
  `.cache/` copy fresh.
- **`scripts/build.js` idempotency invariant** (header comment lines
  14-15): any change to `src/*.js` must produce a byte-identical
  `lib/proxy.js` across rebuilds. The JSON-as-external-require path
  through `__ccproxy_externalRequire` is the safest way to preserve this;
  if the JSON has to be inlined as a CommonJS factory, make sure the
  build doesn't embed timestamps or absolute paths.
- **Do not try to fix Claude Code's `/model 'X-[Nvidia]' not found`
  picker.** That's a Claude Code config-layer issue, outside this
  codebase. If the user mentions it again, redirect them to their Claude
  Code provider config, not cc-proxy.
- **`findModel`'s call surface is broad** — `src/models.js`,
  `src/thinking.js`, `src/request.js` (via `modelSupportsVision`), tests.
  Keep its signature returning the bare entry. Add `findModelEntry` as a
  new export alongside it, not as a replacement.
- **Do NOT change `_entryScore`'s canonical-provider preference.**
  `CANONICAL_PROVIDERS` (catalog.js:176-190) intentionally prefers
  openai/anthropic/google/etc. over mirror providers. NVIDIA is NOT in
  that set (correct — its entries are mirrors). The dispatch must branch
  on the *resolved* provider name, not on a forced preference change.

## What's been tried and failed

Nothing — read-only session. Two things were considered and rejected
during planning (not actual failures, but they ruled out paths):

- **Per-model family toggle param via catalog JSON edits.** Considered
  encoding `param`/`value`/`container` fields directly into
  `src/catalog-data.json` so `applyThinking` could be data-driven.
  Rejected: makes the catalog drift from upstream models.dev every time
  we re-vendor, complicates `scripts/prewarm-catalog.js`, and the family
  table is small enough to live as code in `src/thinking.js` cleanly.
- **Special-casing only `minimax-m3`.** Rejected as too narrow — kimi-k2,
  glm-5.x, deepseek-v4, nemotron all have the same class of problem with
  different `chat_template_kwargs` field names. A family-keyed dispatch
  table fixes all of them in one pass and is barely more code.

## Other learnings

- **The bug is catalog-asymmetry-sensitive.** `findModel` for `minimaxai/minimax-m3`
  resolves to the **nvidia** provider's copy (verified via inline node
  execution: `findModel('minimaxai/minimax-m3').id === 'minimaxai/minimax-m3'`,
  `reasoning_options === [{"type":"toggle"}]`). The minimax provider's
  copy (`MiniMax-M3`, case-sensitive) is a different entry with the same
  toggle shape. Either path currently triggers the `enable_thinking`
  emission — but only nvidia actually rejects the param. The fix gates on
  `providerName === 'nvidia'` so the non-nvidia path keeps emitting
  `enable_thinking` (which minimax.io / moonshot / zhipuai do accept).
- **NVIDIA NIM's `chat_template_kwargs` field names per family** (sourced
  from https://github.com/xRyul/pi-nvidia-nim/blob/main/README.md and
  corroborated by build.nvidia.com model page examples). Verified map:
  - `minimax-m3` / `minimax` (M2/M2.5/M2.7/M3): `{thinking_mode:
    "disabled"|"adaptive"|"enabled"}` — `disabled` for thinking.type
    disabled, `enabled` for any budget ≥ 1, `adaptive` is the middle
    option. Older MiniMax M2.x in the catalog does NOT have this; it
    leaks reasoning into `choices[0].message.content` per a forum thread
    (forums.developer.nvidia.com/t/minimaxai-minimax-m2-5-leaks-reasoning).
    For minimax family generally, the `thinking_mode` field is correct.
  - `kimi-k2` / `kimi-thinking` / `kimi-k3`: `{thinking: true}`. The
    nvidia catalog entry for `moonshotai/kimi-k2.6` has
    `reasoning_options:[{type:'effort', values:[...]}]`, so for THIS
    entry also emit `reasoning_effort` from `pickEffort(values, budget)`.
  - `glm`, `glm-flash`, `glm-air`, `glmv`, `glm-free`:
    `{enable_thinking: true, clear_thinking: false}`. (Yes, this *is*
    the `enable_thinking` field name — but inside `chat_template_kwargs`,
    not at top level. NVIDIA rejects the top-level form.)
  - `deepseek`, `deepseek-flash`, `deepseek-thinking`,
    `deepseek-flash-free`: `{thinking: true}` plus optional
    `reasoning_effort` from the catalog `values` if any.
  - `nemotron` and other nvidia in-house families: `{thinking: true}`.
  - Unknown family under nvidia provider: fall through to existing
    `effort` / `toggle` behavior (safe default; e.g. mirrored GPT-OSS
    entries accept `reasoning_effort` directly).
- **`developer` role is NIM-hostile with `chat_template_kwargs`.** Same
  source: "Uses `system` role instead of `developer` for all NIM models
  - the `developer` role combined with `chat_template_kwargs` causes 500
  errors on NIM." This means Step 4 in the plan (role retention) is
  load-bearing for the fix to actually work, not just an aesthetic add.
- **CI runs on Node 18, 20, 22, 24** (`.github/workflows/ci.yml`, per
  README badge text). `fs.rmSync`/`AbortSignal.timeout` etc. were
  already available on 18; the JSON-sync-read path adds no version
  requirements.
- **`scripts/prewarm-catalog.js`** forces a cache refresh for tests. With
  the bundled copy, the prewarm step is no longer required for unit
  tests, but `pretest` still chains it (`package.json:43`). Leave it —
  it keeps the cache fresh in dev, and the tests' `loadCatalogSync()`
  will simply prefer the bundled copy if the cache is absent. Don't
  remove `prewarm-catalog` or it'll break `npm test`.
- **Build is CommonJS-only** (`scripts/build.js:1` "Hand-rolled
  zero-dependency concat bundler"). No ESM transform — keep all `src/`
  edits in CommonJS (`require`/`module.exports`), do not introduce
  `import`/`export`.

## Next steps

Concrete first action, in order:

1. **Copy the catalog into the repo.** From the project root:
   ```powershell
   Copy-Item -LiteralPath ".cache/models.dev.json" -Destination "src/catalog-data.json"
   ```
   Then add `"src/catalog-data.json"` to the `package.json` `files`
   whitelist (line 29-35). Verify with `npm pack --dry-run | Select-String catalog-data`.

2. **Wire the bundled catalog into `src/catalog.js`.** After the
   existing `require`s at the top, add:
   ```js
   const BUNDLED_CATALOG_PATH = path.join(__dirname, 'catalog-data.json');
   function readBundledCatalog() {
     try {
       const raw = fs.readFileSync(BUNDLED_CATALOG_PATH, 'utf8');
       const j = JSON.parse(raw);
       if (j && typeof j === 'object' && j.providers) return j;
     } catch (e) {
       // bundled catalog missing or corrupt — fall through to cache path
     }
     return null;
   }
   ```
   At module init (top level of `catalog.js`, after function defs): if
   `currentCatalog` is null and `readBundledCatalog()` returns non-null,
   `applyInPlace(readBundledCatalog())`. Then update `loadCatalogSync()`
   to return the bundled copy as a last-resort if `readCacheFile()`
   returns null. Add `findModelEntry(id, catalog)` returning
   `{entry, providerName}` (refactor `_findIn` to also return the
   winning provider; have `findModel` call `findModelEntry` and return
   `.entry`). Export `findModelEntry` and `isNimModel`.

3. **Add NIM dispatch to `src/thinking.js`.** Replace the body of
   `applyThinking` so that after computing `entry`, it checks
   `findModelEntry(...)` for `providerName`:
   - If `providerName === 'nvidia'`, run a new `applyNimThinking(req,
     entry, anth)`.
   - Otherwise, the existing `effort` → `budget_tokens` → `toggle`
     cascade stays (move into an `applyNonNimThinking` helper).
   - `applyNimThinking` switches on `entry.family` per the table in
     "Other learnings". For `disabled` thinking on NIM, emit the family
     "off" variant (minimax → `{thinking_mode:'disabled'}`, others → omit
     `chat_template_kwargs` entirely so the model defaults to no
     thinking).

4. **Add `isNimModel` + role retention in `src/request.js`.** Line 31:
   change the predicate to `needsMaxCompletionTokens(model) &&
   !isNimModel(model)`. `isNimModel` lives in `catalog.js` (calls
   `findModelEntry` and checks `providerName === 'nvidia'`).

5. **Add tests in `test/unit/thinking.test.js`** per the cases in
   "Files involved". Run `npm test`. If `scripts/build.js` chokes on the
   JSON require, fix it per "Files involved" / `scripts/build.js` entry.

6. **Run the full verify chain:** `npm run lint`, `npm run format`, then
   `npm run build` twice and `git diff lib/proxy.js` to confirm
   byte-identical output (idempotency invariant). Then `npm test`.

7. **Update `README.md` and `CHANGELOG.md`** per "Files involved".

8. If a live NVIDIA key is available, smoke-test against
   `https://integrate.api.nvidia.com/v1` for `minimaxai/minimax-m3-[Nvidia]`
   with thinking enabled — the 400 should be gone. If no key, the unit
   tests cover the request-shape transformation; defer live verification
   to the user.

## How to verify current state

Run these first, in order:

1. **`git status`** in `C:\Users\anlaki\projects\cc-proxy` — should be
   clean, on `master`. If anything's mid-change, this handoff may be
   stale.
2. **`Test-Path .\src\catalog-data.json`** — should be `False` right now
   (nothing implemented yet). If it's `True`, Step 1+ of "Next steps"
   have already been done; skip ahead.
3. **`npm test`** — baseline. It currently passes (the existing test
   suite is green; `pretest` rebuilds `lib/proxy.js` and prewarms the
   cache). If `npm test` fails before any implementation, stop and
   investigate — don't build on a broken baseline.
4. **Inline reproduce the bug** to confirm it's still present before
   fixing:
   ```powershell
   node --input-type=commonjs -e "const c=require('./src/catalog.js'); c.loadCatalogSync(); const {findModel, stripProviderSuffix}=c; const e=findModel(stripProviderSuffix('minimaxai/minimax-m3-[Nvidia]')); console.log(e.id, JSON.stringify(e.reasoning_options));"
   ```
   Expected output: `minimaxai/minimax-m3 [{"type":"toggle"}]`. If that
   changes, the catalog may have been re-vendored and the family-name
   assumptions in "Other learnings" need rechecking against the new
   `.cache/models.dev.json`.

After implementing, re-run `npm test` and the inline reproduction; the
reproduction output stays the same (it's the catalog lookup, unchanged),
but a new inline check should show that `applyThinking` on the nvidia
entry emits `chat_template_kwargs` instead of `enable_thinking`:
```powershell
node --input-type=commonjs -e "const c=require('./src/catalog.js'); c.loadCatalogSync(); const {applyThinking}=require('./src/thinking.js'); const req={}; applyThinking({thinking:{type:'enabled',budget_tokens:8000}}, req, 'minimaxai/minimax-m3-[Nvidia]'); console.log(JSON.stringify(req))"
```
Expected after fix: `{"chat_template_kwargs":{"thinking_mode":"enabled"}}`
(no `enable_thinking`).
