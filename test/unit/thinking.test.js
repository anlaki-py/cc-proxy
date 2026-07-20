'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { loadProxy } = require('../helpers/load.js');

const p = loadProxy([]);

test('applyThinking: disabled thinking on reasoning model sends reasoning_effort: none', () => {
  const anth = { thinking: { type: 'disabled' } };
  const req = {};
  p.applyThinking(anth, req, 'o1');
  assert.equal(req.reasoning_effort, 'none');
});

test('applyThinking: no thinking field at all → no-op for non-reasoning models', () => {
  const req = {};
  p.applyThinking({}, req, 'gpt-4o');
  assert.deepEqual(req, {});
});

test('applyThinking: o-series budget → xhigh/high/medium/low/minimal ladder', () => {
  const cases = [
    [80000, 'xhigh'],
    [79999, 'high'],
    [24000, 'high'],
    [23999, 'medium'],
    [8000, 'medium'],
    [7999, 'low'],
    [2000, 'low'],
    [1999, 'minimal'],
  ];
  for (const [budget, expected] of cases) {
    const req = {};
    p.applyThinking({ thinking: { type: 'enabled', budget_tokens: budget } }, req, 'o1');
    assert.equal(req.reasoning_effort, expected, `budget=${budget}`);
  }
});

test('applyThinking: adaptive mode on o-series → medium', () => {
  const req = {};
  p.applyThinking({ thinking: { type: 'adaptive' } }, req, 'gpt-5');
  assert.equal(req.reasoning_effort, 'medium');
});

test('applyThinking: o-series with budget <= 0 → low', () => {
  const req = {};
  p.applyThinking({ thinking: { type: 'enabled', budget_tokens: 0 } }, req, 'o1');
  assert.equal(req.reasoning_effort, 'low');
});

test('applyThinking: grok model', () => {
  const req1 = {};
  p.applyThinking({ thinking: { type: 'enabled', budget_tokens: 20000 } }, req1, 'grok-2');
  assert.equal(req1.reasoning_effort, 'high');

  const req2 = {};
  p.applyThinking({ thinking: { type: 'enabled', budget_tokens: 19999 } }, req2, 'grok-2');
  assert.equal(req2.reasoning_effort, 'low');
});

test('applyThinking: gemini-3 → thinking_level', () => {
  const req1 = {};
  p.applyThinking({ thinking: { type: 'enabled', budget_tokens: 20000 } }, req1, 'gemini-3-pro');
  assert.equal(req1.thinking_level, 'high');

  const req2 = {};
  p.applyThinking({ thinking: { type: 'enabled', budget_tokens: 1000 } }, req2, 'gemini/3-pro');
  assert.equal(req2.thinking_level, 'low');
});

test('applyThinking: gemini-2.5 → thinking_config with cap of 24576', () => {
  const req = {};
  p.applyThinking({ thinking: { type: 'enabled', budget_tokens: 100000 } }, req, 'gemini-2.5-pro');
  assert.deepEqual(req.thinking_config, { thinking_budget: 24576 });

  const req2 = {};
  p.applyThinking({ thinking: { type: 'enabled', budget_tokens: 1000 } }, req2, 'gemini-2.5-flash');
  assert.deepEqual(req2.thinking_config, { thinking_budget: 1000 });
});

test('applyThinking: qwen → enable_thinking + thinking_budget', () => {
  const req = {};
  p.applyThinking({ thinking: { type: 'enabled', budget_tokens: 5000 } }, req, 'qwen-2.5-72b');
  assert.equal(req.enable_thinking, true);
  assert.equal(req.thinking_budget, 5000);
});

test('applyThinking: deepseek-r1 → enable_thinking only', () => {
  const req = {};
  p.applyThinking({ thinking: { type: 'enabled', budget_tokens: 8000 } }, req, 'deepseek-r1');
  assert.equal(req.enable_thinking, true);
});

test('applyThinking: deepseek-v3.1+ → enable_thinking', () => {
  for (const m of ['deepseek-v3.1', 'deepseek-v3.2', 'deepseek-thinking']) {
    const req = {};
    p.applyThinking({ thinking: { type: 'enabled', budget_tokens: 1000 } }, req, m);
    assert.equal(req.enable_thinking, true, m);
  }
});

test('applyThinking: deepseek-v3 (not r1, not v3.1+) → no-op', () => {
  const req = {};
  p.applyThinking({ thinking: { type: 'enabled', budget_tokens: 1000 } }, req, 'deepseek-v3');
  assert.deepEqual(req, {});
});

test('applyThinking: unknown model → silently dropped', () => {
  const req = {};
  p.applyThinking({ thinking: { type: 'enabled', budget_tokens: 5000 } }, req, 'unknown-model-xyz');
  assert.deepEqual(req, {});
});

test('scaleUsage: reasoning_tokens passes through', () => {
  const out = p.scaleUsage(
    {
      input_tokens: 100,
      output_tokens: 50,
      reasoning_tokens: 30,
    },
    'claude-3-5-sonnet',
  );
  assert.equal(out.reasoning_tokens, 30);
});
