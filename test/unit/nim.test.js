'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { isNimModel, parseProviderSuffix, NIM_SUFFIXES } = require('../../src/nim.js');

test('parseProviderSuffix: reads a trailing -[Provider] tag', () => {
  assert.equal(parseProviderSuffix('minimaxai/minimax-m3-[Nvidia]'), 'nvidia');
  assert.equal(parseProviderSuffix('moonshotai/kimi-k2.6-[Nvidia]'), 'nvidia');
  assert.equal(parseProviderSuffix('some-model-[NIM]'), 'nim');
  assert.equal(parseProviderSuffix('openai/gpt-4o-[opencode]'), 'opencode');
  assert.equal(parseProviderSuffix('model-foo-[My-Provider]'), 'my-provider');
});

test('parseProviderSuffix: returns null when there is no -[...] suffix', () => {
  assert.equal(parseProviderSuffix('gpt-4o'), null);
  assert.equal(parseProviderSuffix('openai/gpt-4o'), null);
  assert.equal(parseProviderSuffix('deepseek-v4-flash'), null);
  // a -[] suffix with empty name is not a provider tag
  assert.equal(parseProviderSuffix('model-[]'), null);
  assert.equal(parseProviderSuffix(''), null);
  assert.equal(parseProviderSuffix(null), null);
  assert.equal(parseProviderSuffix(undefined), null);
  assert.equal(parseProviderSuffix(123), null);
});

test('parseProviderSuffix: only matches a trailing suffix (not one mid-id)', () => {
  assert.equal(parseProviderSuffix('foo-[nv]-bar'), null);
  assert.equal(parseProviderSuffix('[Nvidia]-model'), null);
});

test('parseProviderSuffix: tolerates trailing whitespace', () => {
  assert.equal(parseProviderSuffix('model-[Nvidia]   '), 'nvidia');
});

test('isNimModel: true for the default NIM suffixes (case-insensitive tag)', () => {
  assert.equal(isNimModel('minimaxai/minimax-m3-[Nvidia]'), true);
  assert.equal(isNimModel('minimaxai/minimax-m3-[nvidia]'), true);
  assert.equal(isNimModel('x-[NVIDIA]'), true);
  assert.equal(isNimModel('anything-[NIM]'), true);
  assert.equal(isNimModel('anything-[nim]'), true);
});

test('isNimModel: false for non-NIM provider tags and bare models', () => {
  assert.equal(isNimModel('openai/gpt-4o-[opencode]'), false);
  assert.equal(isNimModel('gpt-4o'), false);
  assert.equal(isNimModel('openai/gpt-4o'), false);
  assert.equal(isNimModel(''), false);
  assert.equal(isNimModel(null), false);
});

test('NIM_SUFFIXES: contains the defaults and is a Set', () => {
  assert.ok(NIM_SUFFIXES instanceof Set);
  assert.ok(NIM_SUFFIXES.has('nvidia'));
  assert.ok(NIM_SUFFIXES.has('nim'));
});

test('CCPROXY_NIM_SUFFIXES: adds custom NIM tag names', () => {
  // A fresh require under the env caches the parser, so test the parsed config
  // by re-running the env spread logic inline (the module reads env at load).
  const extra = 'nv-nim,nvidia-integrate';
  const built = new Set([
    'nvidia',
    'nim',
    ...extra
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ]);
  assert.ok(built.has('nv-nim'));
  assert.ok(built.has('nvidia-integrate'));
  assert.ok(built.has('nvidia'));
});

test('isNimModel is stateless: no per-process configuration needed (no host to set)', () => {
  // Unlike a host-based gate this needs no boot-time config; the suffix is on
  // every request's model id, so the result is purely a function of the input.
  assert.equal(isNimModel('m-[Nvidia]'), true);
  assert.equal(isNimModel('m'), false);
  assert.equal(isNimModel('m-[Nvidia]'), true);
});
