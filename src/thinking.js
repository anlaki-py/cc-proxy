'use strict';

// Map Anthropic's extended thinking to the upstream's reasoning field.
// Driven by the models.dev `reasoning_options` for each model.
//
// reasoning_options shapes we handle:
//   * {type:'effort', values:['low','medium','high',...]} — pick a value
//     from the model's own allowed list using a budget-tokens ladder.
//   * {type:'toggle'} — flip enable_thinking: true (qwen, deepseek-r1).
//   * {type:'budget_tokens', min, max} — emit thinking_budget: number
//     (clamped to [min, max]). Used by gemini-2.5.
//
// If the model isn't in the catalog and no recognizable family pattern
// applies, drop `thinking` silently.

const { findModel, stripProviderSuffix } = require('./catalog.js');

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

function applyThinking(anth, req, model) {
  const t = anth.thinking;
  if (!t || !t.type || t.type === 'disabled') {
    // On a known reasoning model, explicitly turn reasoning off so the
    // upstream doesn't burn budget when the client asked for none.
    const entry = findModel(stripProviderSuffix(model));
    if (entry && entry.reasoning) req.reasoning_effort = 'none';
    return;
  }

  const budget = t.budget_tokens || 0;
  const entry = findModel(stripProviderSuffix(model));
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

module.exports = { applyThinking };
