'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { loadProxy } = require('../helpers/load.js');

const p = loadProxy([]);

// Helpers to extract the JSON payloads from generated SSE chunks.
function parseSSE(s) {
  const events = [];
  for (const block of s.split(/\n\n/)) {
    if (!block) continue;
    const lines = block.split(/\n/);
    let event = null,
      data = '';
    for (const line of lines) {
      if (line.startsWith('event:')) event = line.slice(6).trim();
      else if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (event && data) {
      try {
        events.push({ event, data: JSON.parse(data) });
      } catch (e) {
        /* skip */
      }
    }
  }
  return events;
}

test('StreamBuilder: start() emits message_start', () => {
  const b = new p.StreamBuilder('claude-3-5-sonnet');
  const out = b.start(100);
  const events = parseSSE(out);
  assert.equal(events.length, 1);
  assert.equal(events[0].event, 'message_start');
  assert.equal(events[0].data.type, 'message_start');
  assert.equal(events[0].data.message.model, 'claude-3-5-sonnet');
  assert.equal(events[0].data.message.usage.input_tokens, 100);
});

test('StreamBuilder: start() applies scaleUsage', () => {
  const b = new p.StreamBuilder('gpt-4o');
  const out = b.start(128000);
  const events = parseSSE(out);
  const expected = Math.ceil(128000 * (200000 / 128000));
  assert.equal(events[0].data.message.usage.input_tokens, expected);
});

test('StreamBuilder: text() opens a text block and emits deltas', () => {
  const b = new p.StreamBuilder('gpt-4o');
  let out = b.start(0);
  out += b.text('hello');
  out += b.text(' world');
  const events = parseSSE(out);
  // message_start, content_block_start(text), content_block_delta(text_delta "hello"), content_block_delta(text_delta " world")
  assert.equal(events.length, 4);
  assert.equal(events[1].event, 'content_block_start');
  assert.equal(events[1].data.content_block.type, 'text');
  assert.equal(events[2].data.delta.text, 'hello');
  assert.equal(events[3].data.delta.text, ' world');
});

test('StreamBuilder: closeText() emits content_block_stop', () => {
  const b = new p.StreamBuilder('gpt-4o');
  let out = b.text('hi');
  out += b.closeText();
  const events = parseSSE(out);
  const stop = events.find((e) => e.event === 'content_block_stop');
  assert.ok(stop);
});

test('StreamBuilder: empty text() emits nothing', () => {
  const b = new p.StreamBuilder('gpt-4o');
  assert.equal(b.text(''), '');
});

test('StreamBuilder: openThinking opens a thinking block before text', () => {
  const b = new p.StreamBuilder('gpt-4o');
  let out = b.openThinking('reasoning...');
  out += b.text('answer');
  out += b.finish({ completion_tokens: 10 });
  const events = parseSSE(out);
  // Should be: thinking block_start, thinking delta, then text block_start, text delta
  const blockStarts = events.filter((e) => e.event === 'content_block_start');
  assert.equal(blockStarts.length, 2);
  assert.equal(blockStarts[0].data.content_block.type, 'thinking');
  assert.equal(blockStarts[1].data.content_block.type, 'text');
});

test('StreamBuilder: openThinking then text auto-closes the thinking block', () => {
  const b = new p.StreamBuilder('gpt-4o');
  let out = b.openThinking('t1');
  out += b.text('answer');
  const events = parseSSE(out);
  const stops = events.filter((e) => e.event === 'content_block_stop');
  // One stop for the thinking block
  assert.ok(stops.length >= 1);
  // The thinking stop should come before the text block_start
  const stopIdx = events.findIndex((e) => e.event === 'content_block_stop');
  const textStartIdx = events.findIndex(
    (e) => e.event === 'content_block_start' && e.data.content_block.type === 'text',
  );
  assert.ok(stopIdx < textStartIdx);
});

test('StreamBuilder: openToolCall opens a tool_use block with id+name', () => {
  const b = new p.StreamBuilder('gpt-4o');
  let out = b.openToolCall(0, 'call_abc', 'get_weather');
  const events = parseSSE(out);
  assert.equal(events[0].event, 'content_block_start');
  assert.equal(events[0].data.content_block.type, 'tool_use');
  assert.equal(events[0].data.content_block.id, 'call_abc');
  assert.equal(events[0].data.content_block.name, 'get_weather');
});

test('StreamBuilder: appendToolArgs emits input_json_delta', () => {
  const b = new p.StreamBuilder('gpt-4o');
  let out = b.openToolCall(0, 'call_abc', 'get_weather');
  out += b.appendToolArgs(0, '{"city":');
  out += b.appendToolArgs(0, '"Paris"}');
  const events = parseSSE(out);
  const deltas = events.filter((e) => e.event === 'content_block_delta');
  assert.equal(deltas.length, 2);
  assert.equal(deltas[0].data.delta.partial_json, '{"city":');
  assert.equal(deltas[1].data.delta.partial_json, '"Paris"}');
});

test('StreamBuilder: appendToolArgs for unknown index emits nothing', () => {
  const b = new p.StreamBuilder('gpt-4o');
  assert.equal(b.appendToolArgs(99, 'x'), '');
});

test('StreamBuilder: multiple tool calls with distinct oai indices', () => {
  const b = new p.StreamBuilder('gpt-4o');
  let out = b.openToolCall(0, 'call_a', 'tool_a');
  out += b.appendToolArgs(0, '{"a":1}');
  out += b.openToolCall(1, 'call_b', 'tool_b');
  out += b.appendToolArgs(1, '{"b":2}');
  out += b.closeAllToolBlocks();
  const events = parseSSE(out);
  const starts = events.filter((e) => e.event === 'content_block_start');
  assert.equal(starts.length, 2);
  assert.equal(starts[0].data.index, 0);
  assert.equal(starts[0].data.content_block.id, 'call_a');
  assert.equal(starts[1].data.index, 1);
  assert.equal(starts[1].data.content_block.id, 'call_b');
});

test('StreamBuilder: finish() closes everything and emits message_delta + message_stop', () => {
  const b = new p.StreamBuilder('gpt-4o');
  let out = b.text('hi');
  out += b.finish({ completion_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } });
  const events = parseSSE(out);
  const md = events.find((e) => e.event === 'message_delta');
  const ms = events.find((e) => e.event === 'message_stop');
  assert.ok(md);
  assert.ok(ms);
  assert.equal(md.data.delta.stop_reason, 'end_turn');
});

test('StreamBuilder: finish() with no usage uses outputTokens=0', () => {
  const b = new p.StreamBuilder('claude-3-5-sonnet');
  let out = b.text('hi');
  out += b.finish();
  const events = parseSSE(out);
  const md = events.find((e) => e.event === 'message_delta');
  assert.equal(md.data.usage.output_tokens, 0);
});

test('StreamBuilder: finish() scaleUses usage', () => {
  const b = new p.StreamBuilder('gpt-4o');
  let out = b.text('hi');
  out += b.finish({ completion_tokens: 1000, output_tokens_details: { reasoning_tokens: 0 } });
  const events = parseSSE(out);
  const md = events.find((e) => e.event === 'message_delta');
  // 1000 * 200000/128000 = 1563 (ceil)
  assert.equal(md.data.usage.output_tokens, Math.ceil((1000 * 200000) / 128000));
});

test('StreamBuilder: text after openToolCall does not crash', () => {
  const b = new p.StreamBuilder('gpt-4o');
  let out = b.openToolCall(0, 'call_a', 'tool_a');
  // The text() function will try to openText(), which by design does not
  // close any existing tool_use block — the contract is that the model
  // finishes emitting deltas for one tool before starting text. We just
  // assert this doesn't throw.
  assert.doesNotThrow(() => {
    out += b.text('nope');
  });
  // The text function should have produced something even if the ordering
  // is non-ideal in this contrived case.
  assert.ok(out.length > 0);
});
