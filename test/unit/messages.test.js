'use strict';

require('../helpers/load-catalog.js');

const { test } = require('node:test');
const assert = require('node:assert');
const { anthropicToOpenAIMessages } = require('../../src/request.js');
const { resolveImageSource } = require('../../src/images.js');
const { estimateInputTokens } = require('../../src/models.js');

test('anthropicToOpenAIMessages: system string', async () => {
  const out = await anthropicToOpenAIMessages({ system: 'you are helpful' }, 'gpt-4o');
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, 'you are helpful');
});

test('anthropicToOpenAIMessages: system string on o-series → developer', async () => {
  const out = await anthropicToOpenAIMessages({ system: 'be terse' }, 'o1');
  assert.equal(out[0].role, 'developer');
});

test('anthropicToOpenAIMessages: system blocks concatenated', async () => {
  const out = await anthropicToOpenAIMessages(
    {
      system: [
        { type: 'text', text: 'line 1' },
        { type: 'text', text: 'line 2' },
      ],
    },
    'gpt-4o',
  );
  assert.equal(out[0].role, 'system');
  assert.equal(out[0].content, 'line 1\n\nline 2');
});

test('anthropicToOpenAIMessages: string-content user message', async () => {
  const out = await anthropicToOpenAIMessages(
    { messages: [{ role: 'user', content: 'hi' }] },
    'gpt-4o',
  );
  assert.deepEqual(out, [{ role: 'user', content: 'hi' }]);
});

test('anthropicToOpenAIMessages: assistant text + tool_use', async () => {
  const out = await anthropicToOpenAIMessages(
    {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'calling tool' },
            { type: 'tool_use', id: 'tc1', name: 'get_weather', input: { city: 'Paris' } },
          ],
        },
      ],
    },
    'gpt-4o',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'assistant');
  assert.equal(out[0].content, 'calling tool');
  assert.equal(out[0].tool_calls.length, 1);
  assert.equal(out[0].tool_calls[0].id, 'tc1');
  assert.equal(out[0].tool_calls[0].function.name, 'get_weather');
  assert.deepEqual(JSON.parse(out[0].tool_calls[0].function.arguments), { city: 'Paris' });
});

test('anthropicToOpenAIMessages: tool_result → tool role message', async () => {
  const out = await anthropicToOpenAIMessages(
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'sunny, 22C' }],
        },
      ],
    },
    'gpt-4o',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0].role, 'tool');
  assert.equal(out[0].tool_call_id, 'tc1');
  assert.equal(out[0].content, 'sunny, 22C');
});

test('anthropicToOpenAIMessages: tool_result is_error → prefixed with [tool error]', async () => {
  const out = await anthropicToOpenAIMessages(
    {
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tc1', content: 'nope', is_error: true }],
        },
      ],
    },
    'gpt-4o',
  );
  assert.equal(out[0].content, '[tool error] nope');
});

test('anthropicToOpenAIMessages: thinking blocks are dropped', async () => {
  const out = await anthropicToOpenAIMessages(
    {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'private' },
            { type: 'text', text: 'visible' },
          ],
        },
      ],
    },
    'gpt-4o',
  );
  assert.equal(out[0].content, 'visible');
});

test('anthropicToOpenAIMessages: redacted_thinking blocks are dropped', async () => {
  const out = await anthropicToOpenAIMessages(
    {
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'redacted_thinking', data: 'xxxx' },
            { type: 'text', text: 'ok' },
          ],
        },
      ],
    },
    'gpt-4o',
  );
  assert.equal(out[0].content, 'ok');
});

test('anthropicToOpenAIMessages: image base64 passthrough', async () => {
  const out = await anthropicToOpenAIMessages(
    {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'base64', media_type: 'image/png', data: 'AAAA' },
            },
          ],
        },
      ],
    },
    'gpt-4o',
  );
  assert.equal(out[0].role, 'user');
  assert.equal(out[0].content[0].type, 'image_url');
  assert.equal(out[0].content[0].image_url.url, 'data:image/png;base64,AAAA');
});

test('anthropicToOpenAIMessages: image url passthrough (no image-fetch)', async () => {
  const out = await anthropicToOpenAIMessages(
    {
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'image',
              source: { type: 'url', url: 'https://example.com/x.png' },
            },
          ],
        },
      ],
    },
    'gpt-4o',
  );
  assert.equal(out[0].content[0].image_url.url, 'https://example.com/x.png');
});

test('anthropicToOpenAIMessages: image file source type throws', async () => {
  await assert.rejects(async () => {
    await anthropicToOpenAIMessages(
      {
        messages: [
          {
            role: 'user',
            content: [{ type: 'image', source: { type: 'file', file_id: 'f_1' } }],
          },
        ],
      },
      'gpt-4o',
    );
  }, /file source type/);
});

test('resolveImageSource: unknown source type throws', async () => {
  await assert.rejects(async () => {
    await resolveImageSource({ type: 'mystery' });
  }, /unknown source type/);
});

test('resolveImageSource: base64 missing media_type throws', async () => {
  await assert.rejects(async () => {
    await resolveImageSource({ type: 'base64', data: 'x' });
  }, /missing media_type/);
});

test('estimateInputTokens: 4-chars-per-token heuristic over the JSON of messages', () => {
  // The function JSON.stringifies messages, so the result includes keys
  // and brackets. For a 4-char body, total is roughly 4 + role/content keys overhead.
  const req = { messages: [{ role: 'user', content: 'a' }] };
  const expected = Math.ceil(JSON.stringify(req.messages).length / 4);
  assert.equal(estimateInputTokens(req), expected);
});
