'use strict';

// ---------- model metadata (sourced from models.dev at boot) ----------
//
// All numbers come from the models.dev catalog via src/catalog.js. Hardcoded
// tables lived here before; they're now derived lookups. When the catalog
// is unavailable or a model isn't in it, we fall back to safe defaults.

const { findModel, stripProviderSuffix } = require('./catalog.js');

const ANTHROPIC_CONTEXT = 200000;
// Safe over-report for an unknown model: assumes a small context so the
// usage numbers it returns don't lie about headroom. (32k matches what the
// old hardcoded DEFAULT_CONTEXT_LIMIT used.)
const SAFE_FALLBACK_CONTEXT = 32000;
const SAFE_FALLBACK_OUTPUT = 16384;

function getModelContextLimit(model) {
  if (!model) return SAFE_FALLBACK_CONTEXT;
  const entry = findModel(stripProviderSuffix(model));
  if (entry && entry.limit && typeof entry.limit.context === 'number') {
    return entry.limit.context;
  }
  return SAFE_FALLBACK_CONTEXT;
}

function contextScale(model) {
  return ANTHROPIC_CONTEXT / getModelContextLimit(model);
}

function scaleUsage(usage, model) {
  if (!usage) return usage;
  const k = contextScale(model);
  if (k === 1) return usage;
  const out = { ...usage };
  if (typeof usage.input_tokens === 'number') out.input_tokens = Math.ceil(usage.input_tokens * k);
  if (typeof usage.output_tokens === 'number')
    out.output_tokens = Math.ceil(usage.output_tokens * k);
  return out;
}

// Rough char-based estimate of input tokens (used for the message_start event
// before the real count arrives in the final usage chunk). 4 chars/token is
// a common rule of thumb for English/dense code.
function estimateInputTokens(oaiReq) {
  try {
    return Math.ceil(JSON.stringify(oaiReq.messages).length / 4);
  } catch {
    return 0;
  }
}

function capMaxTokens(requested, model) {
  if (!requested || requested <= 0) return requested;
  const entry = findModel(stripProviderSuffix(model));
  let limit = SAFE_FALLBACK_OUTPUT;
  if (entry && entry.limit && typeof entry.limit.output === 'number') {
    limit = entry.limit.output;
  }
  return Math.min(requested, limit);
}

// OpenAI reasoning models (o1, o3, gpt-5) use max_completion_tokens (not
// max_tokens) and reject the temperature field. models.dev tags these with
// `reasoning: true`. When the catalog is unavailable we keep the old
// string-prefix heuristic so behavior degrades gracefully.
function needsMaxCompletionTokens(model) {
  if (!model) return false;
  const entry = findModel(stripProviderSuffix(model));
  if (entry) {
    return !!entry.reasoning;
  }
  // Fallback: string-prefix match, matching the pre-catalog behavior.
  const m = model.toLowerCase();
  return (
    m.startsWith('o1') ||
    m.startsWith('o3') ||
    m.startsWith('gpt-5') ||
    m.startsWith('gpt5') ||
    m.includes('codex')
  );
}

module.exports = {
  ANTHROPIC_CONTEXT,
  SAFE_FALLBACK_CONTEXT,
  SAFE_FALLBACK_OUTPUT,
  getModelContextLimit,
  contextScale,
  scaleUsage,
  estimateInputTokens,
  capMaxTokens,
  needsMaxCompletionTokens,
};
