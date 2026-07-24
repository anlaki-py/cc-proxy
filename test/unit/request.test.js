'use strict';

require('../helpers/load-catalog.js');

const { test } = require('node:test');
const assert = require('node:assert');
const { buildOpenAIRequest } = require('../../src/request.js');

// NIM-ness comes from a `-[Nvidia]` suffix on the model id, so the role test
// just passes a -[Nvidia]-suffixed id for the NIM case and a bare id for the
// standard case. No global toggle, no per-test setup.
async function systemRole(model) {
  const req = await buildOpenAIRequest({
    model,
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
    system: 'You are helpful.',
  });
  return (req.messages.find((m) => m.role === 'system' || m.role === 'developer') || {}).role;
}

test('role: reasoning model (gpt-5, no suffix) → developer role', async () => {
  assert.equal(await systemRole('gpt-5'), 'developer');
});

test('role: reasoning model (gpt-5-[Nvidia]) → system role retained for NIM', async () => {
  // The developer role combined with chat_template_kwargs causes 500s on NIM,
  // so a -[Nvidia]-tagged reasoning model keeps system even when
  // needsMaxCompletionTokens is true.
  assert.equal(await systemRole('gpt-5-[Nvidia]'), 'system');
});

test('role: minimax-m3-[Nvidia] → system role retained for NIM', async () => {
  assert.equal(await systemRole('minimaxai/minimax-m3-[Nvidia]'), 'system');
});

test('role: minimax-m3 (no suffix, through a non-NIM provider) → developer', async () => {
  // Same bare model, not NIM — catalog sees reasoning:true, so developer role.
  assert.equal(await systemRole('minimaxai/minimax-m3'), 'developer');
});

test('role: minimax-m3-[opencode] (non-NVIDIA suffix) → developer', async () => {
  // Only -[Nvidia]/-[NIM] are NIM; a different provider suffix keeps developer.
  assert.equal(await systemRole('minimaxai/minimax-m3-[opencode]'), 'developer');
});

test('role: non-reasoning model (gpt-4o) → system regardless of suffix', async () => {
  assert.equal(await systemRole('gpt-4o'), 'system');
  assert.equal(await systemRole('gpt-4o-[Nvidia]'), 'system');
});

test('role: no system prompt → no system/developer message at all', async () => {
  const req = await buildOpenAIRequest({
    model: 'gpt-5-[Nvidia]',
    max_tokens: 1024,
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.equal(
    req.messages.find((m) => m.role === 'system' || m.role === 'developer'),
    undefined,
  );
});
