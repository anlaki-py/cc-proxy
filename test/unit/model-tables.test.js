'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { loadProxy } = require('../helpers/load.js');

const p = loadProxy([]);

test('capMaxTokens: exact match', () => {
  assert.equal(p.capMaxTokens(100000, 'gpt-4o'), 16384);
  assert.equal(p.capMaxTokens(999999, 'o1'), 100000);
  assert.equal(p.capMaxTokens(50000, 'claude-3-5-sonnet'), 8192);
});

test('capMaxTokens: prefix match', () => {
  assert.equal(p.capMaxTokens(999999, 'gpt-4o-custom-2025'), 16384);
  assert.equal(p.capMaxTokens(999999, 'gpt-5-turbo-preview'), 16384);
});

test('capMaxTokens: unknown model uses default 16384', () => {
  assert.equal(p.capMaxTokens(999999, 'totally-unknown-model'), 16384);
});

test('capMaxTokens: requested below cap is preserved', () => {
  assert.equal(p.capMaxTokens(100, 'gpt-4o'), 100);
});

test('capMaxTokens: falsy/zero passes through', () => {
  assert.equal(p.capMaxTokens(0, 'gpt-4o'), 0);
  assert.equal(p.capMaxTokens(undefined, 'gpt-4o'), undefined);
  assert.equal(p.capMaxTokens(null, 'gpt-4o'), null);
});

test('getModelContextLimit: exact match', () => {
  assert.equal(p.getModelContextLimit('gpt-4o'), 128000);
  assert.equal(p.getModelContextLimit('gpt-5'), 1000000);
  assert.equal(p.getModelContextLimit('claude-3-5-sonnet'), 200000);
});

test('getModelContextLimit: prefix match', () => {
  assert.equal(p.getModelContextLimit('gpt-5-turbo-custom'), 1000000);
  assert.equal(p.getModelContextLimit('llama-3.1-405b-instruct'), 128000);
});

test('getModelContextLimit: unknown model uses default 32000', () => {
  assert.equal(p.getModelContextLimit('some-unknown-model-xyz'), 32000);
});

test('getModelContextLimit: empty/null returns default', () => {
  assert.equal(p.getModelContextLimit(null), 32000);
  assert.equal(p.getModelContextLimit(''), 32000);
});

test('contextScale: 200k / modelLimit', () => {
  assert.equal(p.contextScale('gpt-4o'), 200000 / 128000);
  assert.equal(p.contextScale('claude-3-5-sonnet'), 1);
  assert.equal(p.contextScale('gpt-5'), 200000 / 1000000);
});

test('scaleUsage: k===1 returns input unchanged', () => {
  const u = { input_tokens: 100, output_tokens: 50 };
  assert.strictEqual(p.scaleUsage(u, 'claude-3-5-sonnet'), u);
});

test('scaleUsage: scales input/output tokens', () => {
  const u = { input_tokens: 100, output_tokens: 50 };
  const out = p.scaleUsage(u, 'gpt-4o');
  assert.equal(out.input_tokens, Math.ceil(100 * 200000 / 128000));
  assert.equal(out.output_tokens, Math.ceil(50 * 200000 / 128000));
});

test('scaleUsage: null passes through', () => {
  assert.equal(p.scaleUsage(null, 'gpt-4o'), null);
});

test('scaleUsage: missing fields stay missing', () => {
  const out = p.scaleUsage({ input_tokens: 10 }, 'gpt-4o');
  assert.equal(out.output_tokens, undefined);
});

test('needsMaxCompletionTokens: o-series', () => {
  assert.equal(p.needsMaxCompletionTokens('o1'), true);
  assert.equal(p.needsMaxCompletionTokens('o1-mini'), true);
  assert.equal(p.needsMaxCompletionTokens('o3'), true);
  assert.equal(p.needsMaxCompletionTokens('o3-mini'), true);
});

test('needsMaxCompletionTokens: gpt-5 family', () => {
  assert.equal(p.needsMaxCompletionTokens('gpt-5'), true);
  assert.equal(p.needsMaxCompletionTokens('gpt-5-mini'), true);
  assert.equal(p.needsMaxCompletionTokens('gpt-5.1'), true);
});

test('needsMaxCompletionTokens: codex', () => {
  assert.equal(p.needsMaxCompletionTokens('gpt-5-codex'), true);
});

test('needsMaxCompletionTokens: classic models are false', () => {
  assert.equal(p.needsMaxCompletionTokens('gpt-4o'), false);
  assert.equal(p.needsMaxCompletionTokens('gpt-3.5-turbo'), false);
  assert.equal(p.needsMaxCompletionTokens('claude-3-5-sonnet'), false);
});
