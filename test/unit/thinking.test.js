'use strict';

require('../helpers/load-catalog.js');

const { test } = require('node:test');
const assert = require('node:assert');
const { applyThinking } = require('../../src/thinking.js');
const { scaleUsage } = require('../../src/models.js');
const { findModel } = require('../../src/catalog.js');

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
