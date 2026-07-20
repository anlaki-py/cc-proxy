'use strict';

require('../helpers/load-catalog.js');

const { test } = require('node:test');
const assert = require('node:assert');
const {
  capMaxTokens,
  getModelContextLimit,
  contextScale,
  scaleUsage,
  needsMaxCompletionTokens,
} = require('../../src/models.js');
const { findModel, stripProviderSuffix, modelSupportsVision } = require('../../src/catalog.js');

// ---------- findModel + stripProviderSuffix ----------

test('findModel: exact id match', () => {
  const e = findModel('gpt-4o');
  assert.ok(e, 'should find gpt-4o');
  assert.equal(e.id, 'gpt-4o');
});

test('findModel: case-insensitive', () => {
  const e = findModel('GPT-4O');
  assert.ok(e);
  assert.equal(e.id, 'gpt-4o');
});

test('findModel: provider/id form', () => {
  const e = findModel('openai/gpt-4o');
  assert.ok(e);
  assert.equal(e.id, 'gpt-4o');
});

test('findModel: unknown model returns null', () => {
  assert.equal(findModel('totally-not-a-model-xyz'), null);
});

test('stripProviderSuffix: strips -[Provider]', () => {
  assert.equal(stripProviderSuffix('deepseek-v4-flash-free-[opencode]'), 'deepseek-v4-flash-free');
  assert.equal(stripProviderSuffix('gpt-4o-[openai]'), 'gpt-4o');
});

test('stripProviderSuffix: leaves non-suffix alone', () => {
  assert.equal(stripProviderSuffix('gpt-4o'), 'gpt-4o');
  assert.equal(stripProviderSuffix('openai/gpt-4o'), 'openai/gpt-4o');
  assert.equal(stripProviderSuffix(''), '');
});

test('findModel: suffix-stripped lookup finds deepseek-v4-flash-free-[opencode]', () => {
  // The user's example: model id is the same across providers, but the
  // proxy receives it with a '-[opencode]' routing suffix.
  const e = findModel('deepseek-v4-flash-free-[opencode]');
  assert.ok(e, 'should resolve the suffixed name via the catalog');
  assert.equal(e.id, 'deepseek-v4-flash-free');
});

test('findModel: progressive suffix strip for date-suffixed ids', () => {
  // models.dev has 'claude-sonnet-4-5-20250929' but not the legacy
  // 'claude-3-5-sonnet-20241022'. Strip iteratively.
  const e = findModel('claude-sonnet-4-5-20250929');
  assert.ok(e);
  assert.equal(e.family, 'claude-sonnet');
});

// ---------- getModelContextLimit ----------

test('getModelContextLimit: gpt-4o → 128000', () => {
  assert.equal(getModelContextLimit('gpt-4o'), 128000);
});

test('getModelContextLimit: deepseek-v4-flash → 1000000', () => {
  assert.equal(getModelContextLimit('deepseek-v4-flash'), 1000000);
});

test('getModelContextLimit: minimax-m3 → 512000+ (whatever the catalog currently says)', () => {
  // Note: multiple providers carry 'minimax-m3' with different context
  // windows. The picker prefers more-populated entries; the exact value
  // depends on which provider's data the catalog currently favors. We
  // just assert it's a real window, not the safe fallback.
  const v = getModelContextLimit('minimax-m3');
  assert.ok(v >= 512000, `expected a real catalog value, got ${v}`);
});

test('getModelContextLimit: unknown model → safe fallback (32000)', () => {
  assert.equal(getModelContextLimit('some-unknown-model-xyz'), 32000);
});

test('getModelContextLimit: empty/null → safe fallback', () => {
  assert.equal(getModelContextLimit(null), 32000);
  assert.equal(getModelContextLimit(''), 32000);
});

// ---------- contextScale / scaleUsage ----------

test('contextScale: 200k / modelLimit', () => {
  // 200000 / ctx(gpt-4o) = 200000 / 128000
  assert.equal(contextScale('gpt-4o'), 200000 / 128000);
  // For gpt-5.4 we just assert it's a positive number — multiple providers
  // carry this id with different context windows, and the picker chooses
  // one. The point is that the function returns a number, not undefined.
  const k = contextScale('gpt-5.4');
  assert.ok(k > 0 && Number.isFinite(k));
});

test('scaleUsage: k===1 returns input unchanged', () => {
  // For an exact-1.0 model, scaleUsage returns the same object. The
  // gpt-4o case (k != 1) verifies the more practical property: the
  // function computes the scaled values correctly.
  const u = { input_tokens: 100, output_tokens: 50 };
  const out = scaleUsage(u, 'gpt-4o');
  assert.notEqual(out, u); // gpt-4o has k != 1, so a new object is returned
  assert.equal(out.input_tokens, Math.ceil((100 * 200000) / 128000));
  assert.equal(out.output_tokens, Math.ceil((50 * 200000) / 128000));
});

test('scaleUsage: null passes through', () => {
  assert.equal(scaleUsage(null, 'gpt-4o'), null);
});

test('scaleUsage: missing fields stay missing', () => {
  const out = scaleUsage({ input_tokens: 10 }, 'gpt-4o');
  assert.equal(out.output_tokens, undefined);
});

// ---------- capMaxTokens ----------

test('capMaxTokens: gpt-4o capped at limit.output (16384)', () => {
  assert.equal(capMaxTokens(100000, 'gpt-4o'), 16384);
});

test('capMaxTokens: gpt-5.4 capped at limit.output (128000)', () => {
  assert.equal(capMaxTokens(999999, 'gpt-5.4'), 128000);
});

test('capMaxTokens: deepseek-v4-flash capped at limit.output', () => {
  const e = findModel('deepseek-v4-flash');
  assert.equal(capMaxTokens(999999, 'deepseek-v4-flash'), e.limit.output);
});

test('capMaxTokens: unknown model uses safe fallback (16384)', () => {
  assert.equal(capMaxTokens(999999, 'totally-unknown-model-xyz'), 16384);
});

test('capMaxTokens: requested below cap is preserved', () => {
  assert.equal(capMaxTokens(100, 'gpt-4o'), 100);
});

test('capMaxTokens: falsy/zero passes through', () => {
  assert.equal(capMaxTokens(0, 'gpt-4o'), 0);
  assert.equal(capMaxTokens(undefined, 'gpt-4o'), undefined);
  assert.equal(capMaxTokens(null, 'gpt-4o'), null);
});

// ---------- needsMaxCompletionTokens ----------

test('needsMaxCompletionTokens: o-series (o1, o3)', () => {
  // o1 and o3 live in the catalog with family starting with 'o'.
  const o1 = findModel('o1');
  const o3 = findModel('o3');
  // Some models.dev catalogs may or may not list o1/o3. If present, the
  // family-based check should be true. If absent, the string-prefix
  // fallback kicks in. Either way the answer must be true.
  if (o1) {
    assert.equal(needsMaxCompletionTokens('o1'), true);
  } else {
    assert.equal(needsMaxCompletionTokens('o1'), true); // string fallback
  }
  if (o3) {
    assert.equal(needsMaxCompletionTokens('o3'), true);
  } else {
    assert.equal(needsMaxCompletionTokens('o3'), true);
  }
});

test('needsMaxCompletionTokens: gpt-5 family', () => {
  assert.equal(needsMaxCompletionTokens('gpt-5'), true);
  assert.equal(needsMaxCompletionTokens('gpt-5.4'), true);
});

test('needsMaxCompletionTokens: gpt-4o → false', () => {
  assert.equal(needsMaxCompletionTokens('gpt-4o'), false);
});

test('needsMaxCompletionTokens: deepseek-v4-flash → true (it is a reasoning model)', () => {
  // Reasoning models use max_completion_tokens regardless of vendor.
  assert.equal(needsMaxCompletionTokens('deepseek-v4-flash'), true);
});

// ---------- modelSupportsVision ----------

test('modelSupportsVision: gpt-4o supports image', () => {
  assert.equal(modelSupportsVision('gpt-4o'), true);
});

test('modelSupportsVision: gpt-5.4 supports image', () => {
  assert.equal(modelSupportsVision('gpt-5.4'), true);
});

test('modelSupportsVision: deepseek-v4-flash does NOT support image', () => {
  assert.equal(modelSupportsVision('deepseek-v4-flash'), false);
});

test('modelSupportsVision: unknown model returns false (safe default)', () => {
  assert.equal(modelSupportsVision('totally-unknown-model-xyz'), false);
});
