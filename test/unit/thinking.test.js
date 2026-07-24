'use strict';

require('../helpers/load-catalog.js');

const { test } = require('node:test');
const assert = require('node:assert');
const { applyThinking } = require('../../src/thinking.js');
const { scaleUsage } = require('../../src/models.js');
const { findModel } = require('../../src/catalog.js');

// NIM-ness is decided by a `-[Provider]` suffix on the model id, not a global
// toggle, so the NIM tests just pass a -[Nvidia]-suffixed id and the standard
// tests pass a bare id. No per-test setup/teardown is needed.
function think(anth, model) {
  const req = {};
  applyThinking(anth, req, model);
  return req;
}

// ---------- disabled / no thinking ----------

test('applyThinking: disabled thinking on reasoning model sends reasoning_effort: none', () => {
  // gpt-5 has reasoning:true in the catalog.
  const anth = { thinking: { type: 'disabled' } };
  const req = {};
  applyThinking(anth, req, 'gpt-5');
  assert.equal(req.reasoning_effort, 'none');
});

test('applyThinking: disabled on non-reasoning model → no-op', () => {
  const req = {};
  applyThinking({ thinking: { type: 'disabled' } }, req, 'gpt-4o');
  assert.deepEqual(req, {});
});

test('applyThinking: no thinking field at all → no-op for non-reasoning models', () => {
  const req = {};
  applyThinking({}, req, 'gpt-4o');
  assert.deepEqual(req, {});
});

// ---------- effort-style (reasoning_options has {type:'effort', values:[...]}) ----------

test('applyThinking: gpt-5 with high budget → reasoning_effort=high', () => {
  // gpt-5 reasoning_options.values = ['minimal','low','medium','high']
  // budget 80000 maps to the top of the ladder → top of values → 'high'
  const req = {};
  applyThinking({ thinking: { type: 'enabled', budget_tokens: 80000 } }, req, 'gpt-5');
  assert.equal(req.reasoning_effort, 'high');
});

test('applyThinking: gpt-5 with low budget → reasoning_effort=lowest allowed value', () => {
  // The catalog's lowest value is 'minimal' (not 'low'). The dispatcher
  // maps a low budget to the first value in the model's allowed list.
  const req = {};
  applyThinking({ thinking: { type: 'enabled', budget_tokens: 100 } }, req, 'gpt-5');
  assert.equal(req.reasoning_effort, 'minimal');
});

test('applyThinking: gpt-5 with no budget → reasoning_effort=lowest allowed', () => {
  // budget=0 → below all ladder rungs → first value
  const req = {};
  applyThinking({ thinking: { type: 'enabled', budget_tokens: 0 } }, req, 'gpt-5');
  assert.equal(req.reasoning_effort, 'minimal');
});

test('applyThinking: gpt-5 with mid budget → mid value', () => {
  // gpt-5 values = [minimal,low,medium,high]; budget 24000 clears the
  // 3rd ladder rung (24000) → values[2] = 'medium'.
  const req = {};
  applyThinking({ thinking: { type: 'enabled', budget_tokens: 24000 } }, req, 'gpt-5');
  assert.equal(req.reasoning_effort, 'medium');
});

// ---------- budget_tokens-style (gemini-2.5) ----------

test('applyThinking: gemini-2.5-pro → thinking_budget clamped to [128, 32768]', () => {
  // gemini-2.5-pro reasoning_options = [{type:'budget_tokens', min:128, max:32768}]
  const req = {};
  applyThinking({ thinking: { type: 'enabled', budget_tokens: 100000 } }, req, 'gemini-2.5-pro');
  assert.equal(req.thinking_budget, 32768);
});

test('applyThinking: gemini-2.5 with small budget → passes through (above min)', () => {
  const req = {};
  applyThinking({ thinking: { type: 'enabled', budget_tokens: 1000 } }, req, 'gemini-2.5-pro');
  assert.equal(req.thinking_budget, 1000);
});

// ---------- no-op cases ----------

test('applyThinking: unknown model → silently dropped', () => {
  const req = {};
  applyThinking({ thinking: { type: 'enabled', budget_tokens: 5000 } }, req, 'unknown-model-xyz');
  assert.deepEqual(req, {});
});

test('applyThinking: gpt-4o (non-reasoning) → dropped', () => {
  const req = {};
  applyThinking({ thinking: { type: 'enabled', budget_tokens: 1000 } }, req, 'gpt-4o');
  assert.deepEqual(req, {});
});

// ---------- scaleUsage sanity ----------

test('scaleUsage: reasoning_tokens passes through', () => {
  const out = scaleUsage(
    {
      input_tokens: 100,
      output_tokens: 50,
      reasoning_tokens: 30,
    },
    'gpt-4o',
  );
  assert.equal(out.reasoning_tokens, 30);
});

// Sanity check that the catalog has the entries these tests assume.
test('catalog sanity: gpt-5, gpt-4o, gemini-2.5-pro, deepseek-v4-flash are all findable', () => {
  assert.ok(findModel('gpt-5'), 'gpt-5 must be in catalog');
  assert.ok(findModel('gpt-4o'), 'gpt-4o must be in catalog');
  assert.ok(findModel('gemini-2.5-pro'), 'gemini-2.5-pro must be in catalog');
  assert.ok(findModel('deepseek-v4-flash'), 'deepseek-v4-flash must be in catalog');
});

// ---------- NVIDIA NIM branch ----------
//
// cc-proxy often sits in front of an aggregator; the aggregator tags a model
// as NIM-served by appending `-[Nvidia]` to the id. isNimModel() keys off that
// suffix, so the NIM tests pass a -[Nvidia]-suffixed id and the cascade tests
// pass a bare id (the same model routed through its own platform / another
// provider). NIM must NEVER emit top-level `enable_thinking`; it wants
// family-specific fields inside `chat_template_kwargs` instead.

test('NIM: minimax-m3-[Nvidia] enabled → chat_template_kwargs.thinking_mode=enabled, no enable_thinking', () => {
  const req = think(
    { thinking: { type: 'enabled', budget_tokens: 8000 } },
    'minimaxai/minimax-m3-[Nvidia]',
  );
  assert.deepEqual(req.chat_template_kwargs, { thinking_mode: 'enabled' });
  assert.equal(req.enable_thinking, undefined, 'must not emit top-level enable_thinking on NIM');
});

test('NIM: minimax-m3-[Nvidia] disabled → chat_template_kwargs.thinking_mode=disabled', () => {
  const req = think({ thinking: { type: 'disabled' } }, 'minimaxai/minimax-m3-[Nvidia]');
  assert.deepEqual(req.chat_template_kwargs, { thinking_mode: 'disabled' });
});

test('NIM: kimi-k2.6-[Nvidia] enabled → {thinking:true} in chat_template_kwargs, no top-level enable_thinking', () => {
  // moonshotai/kimi-k2.6 catalog-resolves to the moonshotai provider's toggle
  // copy (no effort values) — so reasoning_effort is NOT emitted.
  const req = think(
    { thinking: { type: 'enabled', budget_tokens: 80000 } },
    'moonshotai/kimi-k2.6-[Nvidia]',
  );
  assert.deepEqual(req.chat_template_kwargs, { thinking: true });
  assert.equal(req.enable_thinking, undefined);
  assert.equal(req.reasoning_effort, undefined, 'toggle copy carries no effort values');
});

test('NIM: deepseek-v4-flash-[Nvidia] enabled → {thinking:true} + reasoning_effort from effort ladder', () => {
  // deepseek-ai/deepseek-v4-flash catalog-resolves to the nvidia copy, which
  // has reasoning_options [{type:'effort', values:['none','high','max']}];
  // budget 80000 → top rung → 'max'. NIM accepts reasoning_effort for kimi/
  // deepseek models, so we emit both the kwargs toggle and reasoning_effort.
  const req = think(
    { thinking: { type: 'enabled', budget_tokens: 80000 } },
    'deepseek-ai/deepseek-v4-flash-[Nvidia]',
  );
  assert.deepEqual(req.chat_template_kwargs, { thinking: true });
  assert.equal(req.reasoning_effort, 'max');
  assert.equal(req.enable_thinking, undefined);
});

test('NIM: glm-5.2-[Nvidia] enabled → {enable_thinking,clear_thinking} in kwargs, NO reasoning_effort', () => {
  // glm's NIM shape is a fixed enable_thinking toggle with no effort level.
  // Even though the resolved catalog copy (openrouter) carries effort values,
  // we must NOT surface them as reasoning_effort for glm on NIM.
  const req = think(
    { thinking: { type: 'enabled', budget_tokens: 5000 } },
    'z-ai/glm-5.2-[Nvidia]',
  );
  assert.deepEqual(req.chat_template_kwargs, { enable_thinking: true, clear_thinking: false });
  assert.equal(req.reasoning_effort, undefined);
  assert.equal(req.enable_thinking, undefined);
});

test('NIM: nemotron-[Nvidia] enabled → {thinking:true} in chat_template_kwargs', () => {
  const req = think(
    { thinking: { type: 'enabled', budget_tokens: 5000 } },
    'nvidia/nvidia-nemotron-nano-9b-v2-[Nvidia]',
  );
  assert.deepEqual(req.chat_template_kwargs, { thinking: true });
});

test('NIM: nemotron-[Nvidia] disabled → chat_template_kwargs omitted (model defaults off)', () => {
  const req = think(
    { thinking: { type: 'disabled' } },
    'nvidia/nvidia-nemotron-nano-9b-v2-[Nvidia]',
  );
  assert.equal(req.chat_template_kwargs, undefined);
  assert.equal(req.enable_thinking, undefined);
});

test('NIM: kimi-k2.6-[Nvidia] disabled → chat_template_kwargs omitted', () => {
  const req = think({ thinking: { type: 'disabled' } }, 'moonshotai/kimi-k2.6-[Nvidia]');
  assert.equal(req.chat_template_kwargs, undefined);
  assert.equal(req.enable_thinking, undefined);
});

test('NIM: no thinking field on a -[Nvidia] model → no-op (never emits enable_thinking)', () => {
  const req = think({}, 'minimaxai/minimax-m3-[Nvidia]');
  assert.deepEqual(req, {});
  assert.equal(req.enable_thinking, undefined);
});

test('NIM: unknown family on a -[Nvidia] model still emits nothing NIM rejects', () => {
  // A NIM-tagged model not in the catalog: thinking enabled, but we must not
  // error upstream. entry is null, so applyNimThinking no-ops — no top-level
  // enable_thinking, no rejected param. The request succeeds; thinking is off.
  const req = think(
    { thinking: { type: 'enabled', budget_tokens: 5000 } },
    'totally-made-up-[Nvidia]',
  );
  assert.equal(req.enable_thinking, undefined, 'no enable_thinking for an unknown NIM model');
  assert.equal(req.chat_template_kwargs, undefined);
  assert.deepEqual(req, {});
});

// ---------- regression guard: NON-NIM routing keeps the standard cascade ----------
//
// The *same bare id* routed through a non-NIM provider (minimax.io, moonshot,
// openrouter, …) keeps the original effort/budget/toggle behavior. Stripping
// the -[Nvidia] suffix (or it never having one) is the non-NIM case.

test('regression: minimax-m3 (no suffix) toggle enabled → top-level enable_thinking', () => {
  // The catalog's minimaxai/minimax-m3 resolves to a toggle entry. Through a
  // non-NIM upstream that toggle cascade emits top-level enable_thinking —
  // exactly what those upstreams accept.
  const req = think({ thinking: { type: 'enabled', budget_tokens: 5000 } }, 'minimaxai/minimax-m3');
  assert.equal(req.enable_thinking, true);
  assert.equal(req.chat_template_kwargs, undefined, 'non-NIM must not stack chat_template_kwargs');
  assert.equal(req.thinking_budget, 5000);
});

test('regression: kimi-k2.6 (no suffix) toggle enabled → top-level enable_thinking', () => {
  const req = think({ thinking: { type: 'enabled', budget_tokens: 5000 } }, 'moonshotai/kimi-k2.6');
  assert.equal(req.enable_thinking, true);
  assert.equal(req.chat_template_kwargs, undefined);
});

test('regression: a non-NVIDIA suffix (e.g. -[opencode]) is NOT treated as NIM', () => {
  // Only -[Nvidia]/-[NIM] tag NIM; any other -[Provider] takes the standard
  // path (the aggregator routes it elsewhere, and those providers accept
  // enable_thinking). The catalog lookup strips any -[...] suffix first.
  const req = think(
    { thinking: { type: 'enabled', budget_tokens: 5000 } },
    'minimaxai/minimax-m3-[opencode]',
  );
  assert.equal(req.enable_thinking, true);
  assert.equal(req.chat_template_kwargs, undefined);
});

test('standard path default: gpt-5 keeps reasoning_effort (no suffix, not NIM)', () => {
  const req = {};
  applyThinking({ thinking: { type: 'enabled', budget_tokens: 80000 } }, req, 'gpt-5');
  assert.equal(req.reasoning_effort, 'high');
  assert.equal(req.chat_template_kwargs, undefined);
});
