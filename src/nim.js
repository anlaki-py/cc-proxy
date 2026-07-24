'use strict';

// ---------- NVIDIA NIM detection via the model's -[Provider] suffix ----------
//
// cc-proxy is often pointed at an *aggregator* (one base URL) that bundles many
// underlying providers — one of which is NVIDIA NIM. The aggregator signals
// which sub-provider served a given model by tagging the model id with a
// `-[ProviderName]` suffix, e.g. `minimaxai/minimax-m3-[Nvidia]`. The upstream
// host is therefore a single fixed aggregator host, NOT `integrate.api.nvidia.com`,
// so host-based detection can't tell NIM traffic from any other provider's.
//
// The suffix is the only reliable NIM signal in that setup, so that's what we
// gate on. parseProviderSuffix(model) returns the bare provider name (lowercased)
// from the trailing `-[Name]`, or null. isNimModel(model) is true when that name
// is one of the NIM suffixes (default ["nvidia","nim"]; extensible via the
// CCPROXY_NIM_SUFFIXES env var).
//
// NIM rejects the top-level `enable_thinking` param and the `developer` message
// role, and expects per-family fields under `chat_template_kwargs` instead — see
// the family dispatch in src/thinking.js. applyThinking / request.js call
// isNimModel(model) per-request to decide that shaping. Note the suffix lives on
// the model id the aggregator receives, so it's available even though catalog
// lookups strip the suffix before resolving metadata.

const process = require('node:process');

// Match a trailing -[ProviderName] suffix (the form Claude Code's routing and
// aggregators append). Captures the inner name. Used only to read the suffix —
// stripping for catalog lookup is handled separately in catalog.js.
const SUFFIX_RE = /-\[([^\]]+)\]\s*$/;

// Provider-suffix names that mean "this request is served by NVIDIA NIM" and so
// must use the NIM param shaping. Lowercased. Extensible via the env var so a
// custom aggregator's tag name (e.g. -[nv-nim]) can be added without a code change.
const NIM_SUFFIXES = new Set([
  'nvidia',
  'nim',
  ...((typeof process !== 'undefined' && process.env && process.env.CCPROXY_NIM_SUFFIXES) || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
]);

// Read the -[Provider] suffix off a model id. Returns the inner name lowercased,
// or null when there is no suffix. Returns null rather than throwing on bad input.
function parseProviderSuffix(model) {
  if (!model || typeof model !== 'string') return null;
  const m = model.match(SUFFIX_RE);
  return m ? m[1].trim().toLowerCase() : null;
}

// The NIM gate. True when the model's -[Provider] suffix names a NIM provider.
function isNimModel(model) {
  const s = parseProviderSuffix(model);
  return s !== null && NIM_SUFFIXES.has(s);
}

module.exports = {
  isNimModel,
  parseProviderSuffix,
  NIM_SUFFIXES,
};
