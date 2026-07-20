'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { loadProxy } = require('../helpers/load.js');

const p = loadProxy([]);

function clean(schema) {
  return p.cleanupSchemaForChatCompletions(schema);
}

test('strips format: "uri" at any depth', () => {
  const s = clean({
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri', description: 'A url' },
      nested: {
        type: 'object',
        properties: { deep: { type: 'string', format: 'uri' } },
      },
    },
    required: ['url', 'nested'],
  });
  assert.equal(s.properties.url.format, undefined);
  assert.equal(s.properties.nested.properties.deep.format, undefined);
});

test('removes schema-level strict: true', () => {
  const s = clean({
    type: 'object',
    strict: true,
    properties: { a: { type: 'string' } },
    required: ['a'],
  });
  assert.equal(s.strict, undefined);
});

test('drops "optional" from description → not required', () => {
  const s = clean({
    type: 'object',
    properties: { x: { type: 'string', description: 'Optional. The name.' } },
    required: ['x'],
  });
  assert.equal(s.required, undefined);
});

test('drops "(optional)" from description → not required', () => {
  const s = clean({
    type: 'object',
    properties: { x: { type: 'string', description: 'The name (optional).' } },
    required: ['x'],
  });
  assert.equal(s.required, undefined);
});

test('drops "if not specified" from description → not required', () => {
  const s = clean({
    type: 'object',
    properties: { x: { type: 'string', description: 'If not specified, defaults to foo.' } },
    required: ['x'],
  });
  assert.equal(s.required, undefined);
});

test('drops "defaults to" from description → not required', () => {
  const s = clean({
    type: 'object',
    properties: { x: { type: 'string', description: 'Defaults to "auto".' } },
    required: ['x'],
  });
  assert.equal(s.required, undefined);
});

test('drops "set to true to" from description → not required', () => {
  const s = clean({
    type: 'object',
    properties: { x: { type: 'boolean', description: 'Set to true to enable.' } },
    required: ['x'],
  });
  assert.equal(s.required, undefined);
});

test('drops "if provided" from description → not required', () => {
  const s = clean({
    type: 'object',
    properties: { x: { type: 'string', description: 'API key, if provided.' } },
    required: ['x'],
  });
  assert.equal(s.required, undefined);
});

test('drops "only provide if" from description → not required', () => {
  const s = clean({
    type: 'object',
    properties: { x: { type: 'string', description: 'Only provide if explicitly requested.' } },
    required: ['x'],
  });
  assert.equal(s.required, undefined);
});

test('keeps a param required if no optional-style description and no default', () => {
  const s = clean({
    type: 'object',
    properties: { x: { type: 'string', description: 'The user ID.' } },
    required: ['x'],
  });
  assert.deepEqual(s.required, ['x']);
});

test('drops param from required if it has a default', () => {
  const s = clean({
    type: 'object',
    properties: { x: { type: 'string', default: 'foo' } },
    required: ['x'],
  });
  assert.equal(s.required, undefined);
});

test('drops param from required if nullable: true', () => {
  const s = clean({
    type: 'object',
    properties: { x: { type: 'string', nullable: true } },
    required: ['x'],
  });
  assert.equal(s.required, undefined);
});

test('drops param from required if type is boolean', () => {
  const s = clean({
    type: 'object',
    properties: { verbose: { type: 'boolean' } },
    required: ['verbose'],
  });
  assert.equal(s.required, undefined);
});

test('keeps only truly-required in a mixed schema', () => {
  const s = clean({
    type: 'object',
    properties: {
      name: { type: 'string', description: 'The user name.' },
      age: { type: 'integer', description: 'Optional. The age.' },
      flag: { type: 'boolean' },
      debug: { type: 'string', default: 'off' },
    },
    required: ['name', 'age', 'flag', 'debug'],
  });
  assert.deepEqual(s.required, ['name']);
});

test('recurses into array items', () => {
  const s = clean({
    type: 'object',
    properties: {
      list: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            note: { type: 'string', description: 'Optional.' },
          },
          required: ['id', 'note'],
        },
      },
    },
    required: ['list'],
  });
  assert.deepEqual(s.properties.list.items.required, ['id']);
});

test('null/undefined input passes through', () => {
  assert.equal(clean(null), null);
  assert.equal(clean(undefined), undefined);
});

test('does not mutate the input', () => {
  const input = {
    type: 'object',
    properties: { x: { type: 'string', format: 'uri' } },
    required: ['x'],
  };
  const snapshot = JSON.parse(JSON.stringify(input));
  clean(input);
  assert.deepEqual(input, snapshot);
});
