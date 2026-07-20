'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { loadProxy } = require('../helpers/load.js');

const p = loadProxy(['--port', '0']);

test('parseArgs: long-form flags', () => {
  const r = p.parseArgs([
    '--base',
    'http://x.com/v1',
    '--key',
    'sk-123',
    '--port',
    '9001',
    '--model',
    'gpt-4o',
    '--image-fetch',
    '--max-image-bytes',
    '1000',
  ]);
  assert.equal(r.base, 'http://x.com/v1');
  assert.equal(r.key, 'sk-123');
  assert.equal(r.port, '9001');
  assert.equal(r.model, 'gpt-4o');
  assert.equal(r.imageFetch, true);
  assert.equal(r.maxImageBytes, '1000');
});

test('parseArgs: short-form flags', () => {
  const r = p.parseArgs(['-b', 'http://x', '-k', 'k', '-p', '80', '-m', 'gpt']);
  assert.equal(r.base, 'http://x');
  assert.equal(r.key, 'k');
  assert.equal(r.port, '80');
  assert.equal(r.model, 'gpt');
});

test('parseArgs: empty argv returns empty object with no keys', () => {
  assert.equal(Object.keys(p.parseArgs([])).length, 0);
});

test('parseArgs: unknown flag is ignored', () => {
  const r = p.parseArgs(['--unknown', 'value', '-b', 'x']);
  assert.equal(r.base, 'x');
  assert.equal(r.unknown, undefined);
});

test('parseArgs: --image-fetch sets boolean true', () => {
  assert.equal(p.parseArgs(['--image-fetch']).imageFetch, true);
});
