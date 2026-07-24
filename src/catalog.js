'use strict';

// ---------- models.dev catalog: cache + lookup ----------
//
// Pulls the full models.dev model catalog (https://models.dev/api.json,
// ~3.2MB, 167 providers) once, caches it on disk, and serves O(1) lookups
// for context window, max output, vision support, and reasoning field shape.
//
// Boot behavior:
//   * First-ever boot (no cache file): blocks until the fetch finishes.
//   * Subsequent boots: returns instantly from disk, kicks off a background
//     refresh that updates the in-memory copy when it finishes.
//   * If the background fetch fails: log a one-liner, keep serving from
//     the cached copy. Never crash.
//
// All consumers should call findModel(bareId) — never read .data directly.

const fs = require('node:fs');
const path = require('node:path');
const process = require('node:process');

const CATALOG_URL = 'https://models.dev/api.json';
const CACHE_DIR = path.join(process.cwd(), '.cache');
const CACHE_FILE = path.join(CACHE_DIR, 'models.dev.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Vendored copy of models.dev's api.json, shipped inside the package. This is
// the seed: a fresh clone (or `npm install -g cc-proxy`) has data available at
// first boot with no network round-trip. The background refresh in
// loadCatalog() still updates the in-memory copy and the on-disk .cache file
// when it can, so the bundled copy is never more stale than the release date.
//
// We probe a few candidate paths because the module can live in two layouts:
//   * unbundled (tests, src/ running directly): the JSON sits next to us in
//     src/catalog-data.json — `__dirname + 'catalog-data.json'`.
//   * bundled (npm/published, bin/cc-proxy.js -> lib/proxy.js): the JSON is
//     shipped at src/catalog-data.json one level up from lib/.
//   * manual curl-install (lib/proxy.js only): no JSON is available — we
//     return null and the network fetch path in loadCatalog() takes over.
let _bundledCatalogCache;

// In-memory pointer. Swapped atomically when a background refresh succeeds.
let currentCatalog = null;

function readBundledCatalog() {
  if (_bundledCatalogCache !== undefined) return _bundledCatalogCache;
  const candidates = [
    path.join(__dirname, 'catalog-data.json'),
    path.join(__dirname, '..', 'src', 'catalog-data.json'),
  ];
  for (const p of candidates) {
    try {
      const raw = fs.readFileSync(p, 'utf8');
      const j = JSON.parse(raw);
      if (j && typeof j === 'object' && j.providers) {
        _bundledCatalogCache = j;
        return j;
      }
    } catch {
      // missing or corrupt at this path — try the next candidate
    }
  }
  _bundledCatalogCache = null;
  return null;
}

function log(line) {
  process.stdout.write(`[catalog] ${line}\n`);
}

function ensureCacheDir() {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  } catch {
    // .cache dir creation failed (read-only fs?); fall through — we'll just
    // not be able to persist, but the in-memory load still works for this run.
  }
}

function readCacheFile() {
  try {
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && j.providers) return j;
  } catch {
    // missing or invalid; treat as no cache
  }
  return null;
}

function writeCacheFile(data) {
  ensureCacheDir();
  const tmp = CACHE_FILE + '.tmp';
  try {
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, CACHE_FILE);
  } catch {
    // best-effort; not fatal
  }
}

async function fetchFresh() {
  const r = await fetch(CATALOG_URL);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const j = await r.json();
  // Sanity: the file is a flat { "<provider>": { ... } } object; wrap it.
  if (!j || typeof j !== 'object') throw new Error('malformed catalog');
  const providers = {};
  let modelCount = 0;
  for (const [pname, p] of Object.entries(j)) {
    if (!p || typeof p !== 'object' || !p.models) continue;
    providers[pname] = p;
    modelCount += Object.keys(p.models).length;
  }
  return {
    providers,
    _meta: { fetchedAt: Date.now(), providers: Object.keys(providers).length, models: modelCount },
  };
}

function applyInPlace(data) {
  // Atomic pointer swap: consumers calling getCatalog() always see a
  // fully-populated object, never a partial update.
  currentCatalog = data;
}

function getCatalog() {
  return currentCatalog;
}

// Module-init: seed the in-memory catalog from the vendored bundled copy so
// lookups work even before the async loadCatalog() at boot has run, and on
// fresh installs with no .cache file. The background refresh path overrides
// this pointer when it succeeds. readBundledCatalog() returns null if the
// bundled file is absent (e.g. running from raw src/ without the JSON) — in
// which case the catalog stays empty until loadCatalog() runs.
(function seedFromBundle() {
  if (currentCatalog) return;
  const bundled = readBundledCatalog();
  if (bundled) applyInPlace(bundled);
})();

// loadCatalog(): await once at boot.
//   * If we have a valid cache file (any age), use it and return immediately.
//   * Kick off a background refresh that updates the in-memory copy.
//   * First-ever boot (no cache file) blocks until the foreground fetch
//     finishes, so the proxy never serves a request with an empty catalog.
async function loadCatalog({ forceRefresh = false } = {}) {
  if (forceRefresh) {
    try {
      const data = await fetchFresh();
      applyInPlace(data);
      writeCacheFile(data);
      log(
        `refreshed from models.dev (${data._meta.providers} providers, ${data._meta.models} models)`,
      );
    } catch (e) {
      if (!currentCatalog) {
        // No cached copy and refresh failed: rethrow so the caller knows.
        throw new Error(`models.dev fetch failed and no cache available: ${e.message}`);
      }
      log(`refresh failed: ${e.message}`);
    }
    return currentCatalog;
  }

  const cached = readCacheFile();
  if (cached) {
    applyInPlace(cached);
    // Background refresh regardless — keeps the cache fresh for next boot.
    // We don't await this; the caller proceeds.
    setImmediate(() => backgroundRefresh());
    return currentCatalog;
  }

  // No cache file: first-ever boot. Block on the fetch.
  log('no cache found, downloading models.dev (one-time, ~3MB)...');
  try {
    const data = await fetchFresh();
    applyInPlace(data);
    writeCacheFile(data);
    log(`loaded from models.dev (${data._meta.providers} providers, ${data._meta.models} models)`);
  } catch (e) {
    throw new Error(`models.dev fetch failed and no cache available: ${e.message}`);
  }
  return currentCatalog;
}

async function backgroundRefresh() {
  try {
    const data = await fetchFresh();
    applyInPlace(data);
    writeCacheFile(data);
    log(`updated from models.dev (${data._meta.providers} providers, ${data._meta.models} models)`);
  } catch (e) {
    log(`background refresh failed: ${e.message}`);
  }
}

// Strip a trailing '-[Provider]', '-provider', or '/[Provider]' suffix so
// the lookup finds the same model regardless of which provider the client
// is routing through. Examples:
//   'deepseek-v4-flash-free-[opencode]' -> 'deepseek-v4-flash-free'
//   'openai/gpt-4o'                     -> 'openai/gpt-4o'  (provider-prefix form kept)
//   'gpt-4o'                            -> 'gpt-4o'
function stripProviderSuffix(model) {
  if (!model) return model;
  // '[Provider]' suffix first (most common from Claude Code routing)
  let m = model.replace(/-\[[^\]]+\]\s*$/, '');
  // bare '-provider' suffix is ambiguous (could be a real model name), so
  // only strip when the suffix matches a known provider name in the catalog.
  // We do this lazily: findModel() will fall through to the suffix-stripped
  // form if the original id isn't found, so we don't pre-strip here.
  return m;
}

// findModel(bareId, catalog?) — returns the model entry, or null.
//   1. exact id match in any provider's models
//   2. provider-prefix form: 'openai/gpt-4o' looks up provider='openai', id='gpt-4o'
//   3. case-insensitive id match
//   4. last resort: strip the '-<word>' suffix and try again (handles
//      'claude-3-5-sonnet-20241022' → 'claude-3-5-sonnet')
// Canonical provider names — when an entry is from one of these, we prefer
// it over a mirror entry that may have stale/incorrect fields.
const CANONICAL_PROVIDERS = new Set([
  'openai',
  'anthropic',
  'google',
  'xai',
  'meta',
  'mistral',
  'deepseek',
  'cohere',
  'groq',
  'openrouter',
  'azure',
  'bedrock',
  'vertex',
]);

function _entryScore(entry, providerName) {
  if (!entry) return 0;
  let n = 0;
  if (entry.family) n++;
  if (entry.limit && entry.limit.context) n++;
  if (entry.limit && entry.limit.output) n++;
  if (Array.isArray(entry.reasoning_options) && entry.reasoning_options.length) n += 2;
  if (entry.modalities && Array.isArray(entry.modalities.input)) n++;
  if (typeof entry.reasoning === 'boolean') n++;
  // Big bonus for being from a canonical provider — this trumps field count
  // when a mirror provider has more populated but wrong fields.
  if (providerName && CANONICAL_PROVIDERS.has(providerName)) n += 100;
  return n;
}

// findModelEntry(bareId, catalog?) — resolves a model id and returns
//   { entry, providerName } where providerName is the catalog provider the
//   winning entry was sourced from. Returns null if not found.
//
// `providerName` is the catalog metadata provider, NOT necessarily the
// upstream the request is routed through — `moonshotai/kimi-k2.6` resolves
// here to the `moonshotai` catalog provider (and `nvidia/nemotron-30b` to
// `openrouter`, via the canonical score bonus). NIM-specific request shaping
// is gated on the model's `-[Provider]` suffix (see src/nim.js isNimModel),
// which is why this value is exported only for diagnostics, not as the gate.
function findModelEntry(bareId, catalog) {
  if (!bareId) return null;
  const data = catalog || currentCatalog;
  if (!data || !data.providers) return null;
  return _findIn(bareId, data, new Set());
}

function findModel(bareId, catalog) {
  const r = findModelEntry(bareId, catalog);
  return r ? r.entry : null;
}

function _findIn(id, data, visited) {
  if (visited.has(id)) return null;
  visited.add(id);

  // 2. provider/id form
  const slash = id.indexOf('/');
  if (slash > 0) {
    const pname = id.slice(0, slash);
    const mid = id.slice(slash + 1);
    const p = data.providers[pname];
    if (p && p.models && p.models[mid]) return { entry: p.models[mid], providerName: pname };
  }

  // 1. exact id — when multiple providers have the same id, prefer canonical
  //    providers (openai/anthropic/google/etc.). These carry the most
  //    authoritative metadata; mirror providers sometimes have stale fields.
  let bestExact = null;
  let bestExactScore = -1;
  let bestExactProvider = null;
  for (const pname of Object.keys(data.providers)) {
    const p = data.providers[pname];
    if (!p.models || !p.models[id]) continue;
    const entry = p.models[id];
    const score = _entryScore(entry, pname);
    if (score > bestExactScore) {
      bestExact = entry;
      bestExactScore = score;
      bestExactProvider = pname;
    }
  }
  if (bestExact) return { entry: bestExact, providerName: bestExactProvider };

  // 3. case-insensitive — same canonical-preference logic
  const lower = id.toLowerCase();
  let bestCI = null;
  let bestCIScore = -1;
  let bestCIProvider = null;
  for (const pname of Object.keys(data.providers)) {
    const p = data.providers[pname];
    if (!p.models) continue;
    for (const [mid, entry] of Object.entries(p.models)) {
      if (mid.toLowerCase() !== lower) continue;
      const s = _entryScore(entry, pname);
      if (s > bestCIScore) {
        bestCI = entry;
        bestCIScore = s;
        bestCIProvider = pname;
      }
    }
  }
  if (bestCI) return { entry: bestCI, providerName: bestCIProvider };

  // 4. suffix strip: progressively remove trailing '-<word>' segments.
  //    Stops at the first match, when no more dashes remain, or when we
  //    loop back to an id we've already tried.
  let cur = stripProviderSuffix(id);
  while (cur !== id) {
    const r = _findIn(cur, data, visited);
    if (r) return r;
    const shorter = cur.replace(/-[^-]+$/, '');
    if (!shorter || !shorter.includes('-')) break;
    cur = shorter;
  }
  return null;
}

// Convenience: does this model accept image input?
function modelSupportsVision(model) {
  const entry = findModel(model);
  if (!entry || !entry.modalities) return false;
  return Array.isArray(entry.modalities.input) && entry.modalities.input.includes('image');
}

// loadCatalogSync() — synchronous load from disk only. No network. Returns
// the cached catalog if available; otherwise the vendored bundled copy;
// otherwise null. Used by tests so they don't need a before() hook, and as a
// last-resort sync source. The integration test / production path uses
// the async loadCatalog() which handles the network fetch.
function loadCatalogSync() {
  const cached = readCacheFile();
  if (cached) {
    applyInPlace(cached);
    return cached;
  }
  const bundled = readBundledCatalog();
  if (bundled) {
    applyInPlace(bundled);
    return bundled;
  }
  return null;
}

module.exports = {
  loadCatalog,
  loadCatalogSync,
  getCatalog,
  findModel,
  findModelEntry,
  stripProviderSuffix,
  modelSupportsVision,
  CACHE_FILE,
  CACHE_TTL_MS,
};
