'use strict';

// Map Anthropic's extended thinking to the upstream's reasoning field.
// Driven by the models.dev `reasoning_options` for each model.
//
// reasoning_options shapes we handle (non-NIM upstreams):
//   * {type:'effort', values:['low','medium','high',...]} — pick a value
//     from the model's own allowed list using a budget-tokens ladder.
//   * {type:'toggle'} — flip enable_thinking: true (qwen, deepseek-r1).
//   * {type:'budget_tokens', min, max} — emit thinking_budget: number
//     (clamped to [min, max]). Used by gemini-2.5.
//
// NVIDIA NIM is a special case: it rejects the top-level `enable_thinking`
// param and the `developer` message role, and expects per-family fields
// nested in `chat_template_kwargs` instead. cc-proxy often sits in front of an
// aggregator that bundles many providers; the aggregator tags a request as
// NIM-served by appending a -[Provider] suffix to the model id (e.g.
// `minimaxai/minimax-m3-[Nvidia]`). isNimModel(model) keys off THAT suffix,
// not the upstream host (the host is the fixed aggregator URL, useless as a
// signal) nor the catalog-resolved provider name (a metadata heuristic that
// resolves `moonshotai/kimi-k2.6-[Nvidia]` to the `moonshotai` catalog entry,
// not `nvidia`). When isNimModel() is true we dispatch on entry.family to emit
// the NIM-specific shape; non-NIM models keep the cascade below. If the model
// carries a NIM suffix but isn't in the catalog, thinking is silently dropped
// rather than emitting a param NIM would reject — we never 400.
//
// If the model isn't in the catalog and no recognizable family pattern
// applies, drop `thinking` silently.

const { findModel, stripProviderSuffix } = require('./catalog.js');
const { isNimModel } = require('./nim.js');

const REASONING_BUDGET_LADDER = [2000, 8000, 24000, 80000];

// Pick a value from `values` for a given `budget`. Walks the ladder from
// highest to lowest and maps the matched rung to the closest index in the
// model's own values array. Falls back to the lowest value if budget is
// below all thresholds.
function pickEffort(values, budget) {
  if (!Array.isArray(values) || values.length === 0) return undefined;
  // Find the highest ladder rung the budget clears.
  let rung = 0;
  for (let i = 0; i < REASONING_BUDGET_LADDER.length; i++) {
    if (budget >= REASONING_BUDGET_LADDER[i]) rung = i;
  }
  // Map the rung onto the values array. With equal lengths, rung-to-value
  // is 1:1. Otherwise we distribute evenly: values[idx] where idx is
  // rung * (len-1) / (ladderLen-1), clamped.
  if (values.length === REASONING_BUDGET_LADDER.length) return values[rung];
  const idx = Math.min(
    values.length - 1,
    Math.round((rung * (values.length - 1)) / (REASONING_BUDGET_LADDER.length - 1)),
  );
  return values[idx];
}

// Find the first {type:'effort'} option in the entry's reasoning_options and
// resolve a value for the budget. Returns undefined if the entry has no
// effort option or no allowed values.
function resolveEffort(entry, budget) {
  if (!entry || !Array.isArray(entry.reasoning_options)) return undefined;
  const effort = entry.reasoning_options.find((o) => o && o.type === 'effort');
  if (!effort || !Array.isArray(effort.values) || !effort.values.length) return undefined;
  return pickEffort(effort.values, budget);
}

// applyThinking dispatches between the NIM path and the standard path. Both
// share the same entry lookup so the catalog is consulted once.
function applyThinking(anth, req, model) {
  const t = anth.thinking;
  const enabled = t && t.type && t.type !== 'disabled';
  const entry = findModel(stripProviderSuffix(model));

  if (isNimModel(model)) {
    applyNimThinking(req, entry, t, enabled);
    return;
  }

  applyStandardThinking(req, entry, t, enabled);
}

// ---- NVIDIA NIM ----
//
// NIM rejects the top-level `enable_thinking` param; it wants a
// family-specific field nested inside `chat_template_kwargs`. We dispatch on
// entry.family:
//
//   minimax*           → {thinking_mode: 'enabled'|'disabled'}
//   kimi*              → {thinking: true}  (+ reasoning_effort if effort opt)
//   glm*               → {enable_thinking: true, clear_thinking: false}
//   deepseek*          → {thinking: true}  (+ reasoning_effort if effort opt)
//   nemotron / other   → {thinking: true}     (nvidia in-house default)
//
// "Off" (thinking disabled/absent): minimax asks for {thinking_mode:'disabled'}
// explicitly; every other family just omits chat_template_kwargs so the model
// defaults to no thinking (the conservative, cross-family-safe choice).
//
// When the resolved entry also carries a {type:'effort'} reasoning_option
// (kimi-k2.6 and deepseek-v4 on the nvidia catalog do), NIM accepts the
// standard `reasoning_effort` top-level field, so we emit BOTH the kwargs
// toggle and reasoning_effort. (When the entry resolves via a provider whose
// copy is toggle-only — e.g. `moonshotai/kimi-k2.6` lands on the moonshotai
// catalog provider's toggle copy — there's no effort list, so reasoning_effort
// is simply omitted and we send the kwargs alone.)
function applyNimThinking(req, entry, t, enabled) {
  const family = (entry && entry.family) || '';

  if (!enabled || !entry) {
    // Minimax needs an explicit disabled; others omit kwargs entirely.
    if (enabled === false && family.startsWith('minimax')) {
      req.chat_template_kwargs = { thinking_mode: 'disabled' };
    }
    return;
  }

  const budget = (t && t.budget_tokens) || 0;
  if (family.startsWith('minimax')) {
    req.chat_template_kwargs = { thinking_mode: 'enabled' };
  } else if (family.startsWith('kimi')) {
    req.chat_template_kwargs = { thinking: true };
  } else if (family.startsWith('glm')) {
    req.chat_template_kwargs = { enable_thinking: true, clear_thinking: false };
  } else if (family.startsWith('deepseek')) {
    req.chat_template_kwargs = { thinking: true };
  } else {
    // nemotron and other nvidia in-house families: {thinking: true}.
    req.chat_template_kwargs = { thinking: true };
  }

  // kimi and deepseek are the two NIM families the nvidia catalog tags with a
  // {type:'effort'} option; for those, NIM accepts the standard top-level
  // reasoning_effort alongside the chat_template_kwargs toggle. glm/minimax/
  // nemotron take a fixed enable field with no effort level, so we must NOT
  // add reasoning_effort (their NIM shape is the kwargs alone — emitting an
  // effort value sourced from a non-nvidia catalog copy would risk a 400).
  if (family.startsWith('kimi') || family.startsWith('deepseek')) {
    const effort = resolveEffort(entry, budget);
    if (effort) req.reasoning_effort = effort;
  }
}

// ---- Standard (non-NIM) path ----
//
// Preserved unchanged from the original applyThinking: effort → budget_tokens
// → toggle cascade. OpenRouter, Anthropic, OpenAI, each vendor's own platform
// API, Groq, etc. all take this path.
function applyStandardThinking(req, entry, t, enabled) {
  if (!enabled) {
    // On a known reasoning model, explicitly turn reasoning off so the
    // upstream doesn't burn budget when the client asked for none.
    if (entry && entry.reasoning) req.reasoning_effort = 'none';
    return;
  }

  const budget = t.budget_tokens || 0;
  const opts = entry && Array.isArray(entry.reasoning_options) ? entry.reasoning_options : [];

  // effort-style
  const effort = opts.find((o) => o && o.type === 'effort');
  if (effort && Array.isArray(effort.values) && effort.values.length) {
    req.reasoning_effort = pickEffort(effort.values, budget);
    return;
  }

  // budget_tokens-style (gemini-2.5): emit integer thinking_budget clamped
  // to the model's [min, max] window. If no budget was supplied, default
  // to the midpoint of the range.
  const budgetOpt = opts.find((o) => o && o.type === 'budget_tokens');
  if (budgetOpt) {
    const min = typeof budgetOpt.min === 'number' ? budgetOpt.min : 0;
    const max = typeof budgetOpt.max === 'number' ? budgetOpt.max : 24576;
    const v = budget || Math.round((min + max) / 2) || min || max;
    req.thinking_budget = Math.max(min, Math.min(max, v));
    return;
  }

  // toggle-style
  const toggle = opts.find((o) => o && o.type === 'toggle');
  if (toggle) {
    req.enable_thinking = true;
    if (budget) req.thinking_budget = budget;
    return;
  }
}

module.exports = { applyThinking, pickEffort };
