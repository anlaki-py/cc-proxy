'use strict';

require('../helpers/load-catalog.js');

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const {
  findModel,
  stripProviderSuffix,
  modelSupportsVision,
  loadCatalogSync,
  CACHE_FILE,
} = require('../../src/catalog.js');

// ---------- loadCatalogSync ----------

test('loadCatalogSync: returns the cached catalog if present', () => {
  const c = loadCatalogSync();
  assert.ok(c, 'cache must be present for unit tests (prewarm runs in pretest)');
  assert.ok(c.providers);
  assert.ok(Object.keys(c.providers).length > 100, 'expect 100+ providers');
});

// ---------- findModel ----------

test('findModel: openai/gpt-4o resolves via provider/id form', () => {
  const e = findModel('openai/gpt-4o');
  assert.ok(e);
  assert.equal(e.id, 'gpt-4o');
  assert.equal(e.limit.context, 128000);
});

test('findModel: gpt-4o found exactly', () => {
  const e = findModel('gpt-4o');
  assert.ok(e);
  assert.equal(e.id, 'gpt-4o');
});

test('findModel: case-insensitive', () => {
  const e = findModel('GPT-4O');
  assert.ok(e);
});

test('findModel: null on empty / non-string', () => {
  assert.equal(findModel(''), null);
  assert.equal(findModel(null), null);
  assert.equal(findModel(undefined), null);
});

test('findModel: null on truly unknown model', () => {
  assert.equal(findModel('definitely-not-a-real-model-zzz-9999'), null);
});

test('findModel: progressive suffix strip finds the canonical entry', () => {
  // claude-sonnet-4-5-20250929 -> claude-sonnet-4-5 (the canonical id)
  const e = findModel('claude-sonnet-4-5-20250929');
  assert.ok(e);
  assert.equal(e.family, 'claude-sonnet');
});

test('findModel: provider/id form for an unknown provider returns null', () => {
  const e = findModel('not-a-provider/gpt-4o');
  assert.equal(e, null);
});

// ---------- stripProviderSuffix ----------

test('stripProviderSuffix: -[Provider] form', () => {
  assert.equal(stripProviderSuffix('deepseek-v4-flash-free-[opencode]'), 'deepseek-v4-flash-free');
  assert.equal(stripProviderSuffix('gpt-4o-[openai]'), 'gpt-4o');
});

test('stripProviderSuffix: leaves plain names alone', () => {
  assert.equal(stripProviderSuffix('gpt-4o'), 'gpt-4o');
  assert.equal(stripProviderSuffix('openai/gpt-4o'), 'openai/gpt-4o');
});

test('stripProviderSuffix: empty / null', () => {
  assert.equal(stripProviderSuffix(''), '');
  assert.equal(stripProviderSuffix(null), null);
});

// ---------- modelSupportsVision ----------

test('modelSupportsVision: gpt-4o → true', () => {
  assert.equal(modelSupportsVision('gpt-4o'), true);
});

test('modelSupportsVision: gpt-5.4 → true (multimodal gpt-5)', () => {
  assert.equal(modelSupportsVision('gpt-5.4'), true);
});

test('modelSupportsVision: deepseek-v4-flash → false', () => {
  assert.equal(modelSupportsVision('deepseek-v4-flash'), false);
});

test('modelSupportsVision: deepseek-v4-flash-free → false', () => {
  assert.equal(modelSupportsVision('deepseek-v4-flash-free'), false);
});

test('modelSupportsVision: unknown model → false', () => {
  assert.equal(modelSupportsVision('zzz-no-such-model'), false);
});

// ---------- cache file exists ----------

test('cacheupply: cache file is at .cache/models.dev.json', () => {
  // CACHE_FILE is a relative path; resolve against cwd.
  const abs = path.resolve(CACHE_FILE);
  assert.ok(fs.existsSync(abs), `expected cache file at ${abs}`);
});
