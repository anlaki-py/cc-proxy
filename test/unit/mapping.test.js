'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { mapToolChoice, anthropicToOpenAITools } = require('../../src/request.js');
const { mapFinishReason, parseSSEEvents } = require('../../src/stream.js');
const { anthropicError } = require('../../src/errors.js');
const { sse } = require('../../src/ids.js');

test('mapToolChoice: auto', () => {
  assert.equal(mapToolChoice({ type: 'auto' }), 'auto');
});

test('mapToolChoice: any → required', () => {
  assert.equal(mapToolChoice({ type: 'any' }), 'required');
});

test('mapToolChoice: none', () => {
  assert.equal(mapToolChoice({ type: 'none' }), 'none');
});

test('mapToolChoice: tool with name', () => {
  assert.deepEqual(mapToolChoice({ type: 'tool', name: 'foo' }), {
    type: 'function',
    function: { name: 'foo' },
  });
});

test('mapToolChoice: undefined input returns undefined', () => {
  assert.equal(mapToolChoice(undefined), undefined);
  assert.equal(mapToolChoice(null), undefined);
  assert.equal(mapToolChoice({}), undefined);
});

test('mapFinishReason: tool_calls → tool_use', () => {
  assert.equal(mapFinishReason('tool_calls'), 'tool_use');
  assert.equal(mapFinishReason('function_call'), 'tool_use');
});

test('mapFinishReason: length/max_tokens → max_tokens', () => {
  assert.equal(mapFinishReason('length'), 'max_tokens');
  assert.equal(mapFinishReason('max_tokens'), 'max_tokens');
});

test('mapFinishReason: content_filter/safety → end_turn', () => {
  assert.equal(mapFinishReason('content_filter'), 'end_turn');
  assert.equal(mapFinishReason('safety'), 'end_turn');
});

test('mapFinishReason: stop/undefined → end_turn', () => {
  assert.equal(mapFinishReason('stop'), 'end_turn');
  assert.equal(mapFinishReason(undefined), 'end_turn');
});

test('anthropicToOpenAITools: undefined returns undefined', () => {
  assert.equal(anthropicToOpenAITools(undefined), undefined);
});

test('anthropicToOpenAITools: maps name, description, parameters; strict: false implicit', () => {
  const out = anthropicToOpenAITools([
    {
      name: 'get_weather',
      description: 'Get the weather',
      input_schema: {
        type: 'object',
        properties: { city: { type: 'string' } },
        required: ['city'],
      },
    },
  ]);
  assert.equal(out.length, 1);
  assert.equal(out[0].type, 'function');
  assert.equal(out[0].function.name, 'get_weather');
  assert.equal(out[0].function.description, 'Get the weather');
  assert.deepEqual(out[0].function.parameters, {
    type: 'object',
    properties: { city: { type: 'string' } },
    required: ['city'],
  });
});

test('anthropicToOpenAITools: cleans the schema', () => {
  const out = anthropicToOpenAITools([
    {
      name: 'f',
      description: 'd',
      input_schema: {
        type: 'object',
        strict: true,
        properties: {
          x: { type: 'string', format: 'uri', description: 'A real url.' },
          y: { type: 'string', description: 'Optional.' },
        },
        required: ['x', 'y'],
      },
    },
  ]);
  assert.equal(out[0].function.parameters.strict, undefined);
  assert.equal(out[0].function.parameters.properties.x.format, undefined);
  assert.deepEqual(out[0].function.parameters.required, ['x']);
});

test('sse: produces the expected wire format', () => {
  const out = sse('message_start', { type: 'message_start', message: {} });
  assert.equal(out, 'event: message_start\ndata: {"type":"message_start","message":{}}\n\n');
});

test('anthropicError: maps status to type', () => {
  assert.equal(anthropicError(400, 'x').error.type, 'invalid_request_error');
  assert.equal(anthropicError(401, 'x').error.type, 'authentication_error');
  assert.equal(anthropicError(403, 'x').error.type, 'permission_error');
  assert.equal(anthropicError(404, 'x').error.type, 'not_found_error');
  assert.equal(anthropicError(429, 'x').error.type, 'rate_limit_error');
  assert.equal(anthropicError(500, 'x').error.type, 'api_error');
  assert.equal(anthropicError(503, 'x').error.type, 'overloaded_error');
  assert.equal(anthropicError(529, 'x').error.type, 'overloaded_error');
});

test('anthropicError: message is included', () => {
  assert.equal(anthropicError(400, 'oops').error.message, 'oops');
});

test('parseSSEEvents: parses a complete event', () => {
  const buf = 'event: foo\ndata: {"x":1}\n\n';
  const { events, rest } = parseSSEEvents(buf);
  assert.equal(rest, '');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { x: 1 });
});

test('parseSSEEvents: handles [DONE]', () => {
  const buf = 'data: [DONE]\n\ndata: {"y":2}\n\n';
  const { events } = parseSSEEvents(buf);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { y: 2 });
});

test('parseSSEEvents: returns incomplete rest', () => {
  const buf = 'data: {"a":1}\n\ndata: {"b":';
  const { events, rest } = parseSSEEvents(buf);
  assert.equal(events.length, 1);
  assert.equal(rest, 'data: {"b":');
});

test('parseSSEEvents: tolerates malformed JSON', () => {
  const buf = 'data: not json\n\ndata: {"ok":1}\n\n';
  const { events } = parseSSEEvents(buf);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { ok: 1 });
});

test('parseSSEEvents: tolerates CRLF line endings', () => {
  const buf = 'event: foo\r\ndata: {"x":1}\r\n\r\n';
  const { events } = parseSSEEvents(buf);
  assert.equal(events.length, 1);
  assert.deepEqual(events[0], { x: 1 });
});
