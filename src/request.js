'use strict';

// ---------- Anthropic request -> OpenAI request ----------

const process = require('node:process');

const { needsMaxCompletionTokens, capMaxTokens } = require('./models.js');
const { cleanupSchemaForChatCompletions } = require('./schema.js');
const { applyThinking } = require('./thinking.js');
const { resolveImageSource } = require('./images.js');
const { modelSupportsVision } = require('./catalog.js');

// Module-level config that buildOpenAIRequest's single-arg form reads.
// Forward-compatible 2nd arg opts { modelOverride } overrides it; the server
// module calls configureRequest({ modelOverride }) at boot to set the —model
// override.
let MODEL_OVERRIDE = '';

function configureRequest({ modelOverride } = {}) {
  if (modelOverride !== undefined) MODEL_OVERRIDE = modelOverride;
}

async function anthropicToOpenAIMessages(anth, model) {
  const out = [];
  if (anth.system) {
    const sys =
      typeof anth.system === 'string'
        ? anth.system
        : (anth.system || []).map((b) => b.text || '').join('\n\n');
    if (sys)
      out.push({ role: needsMaxCompletionTokens(model) ? 'developer' : 'system', content: sys });
  }
  for (const m of anth.messages || []) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const textParts = [];
    const toolCalls = [];
    const toolResults = [];
    const trailingImages = []; // images that can't fit in a tool message; appended as user messages
    for (const b of m.content || []) {
      if (b.type === 'text') {
        textParts.push(b.text);
      } else if (b.type === 'image' && b.source) {
        if (modelSupportsVision(model)) {
          textParts.push(await resolveImageSource(b.source));
        } else if (process.env.LOG) {
          console.log(`  ~ dropping image (model ${model} does not support vision)`);
        }
      } else if (b.type === 'tool_use') {
        toolCalls.push({
          id: b.id,
          type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      } else if (b.type === 'tool_result') {
        // Anthropic tool_result.content can be a string or an array of
        // text+image blocks. OpenAI tool messages are text-only, so images
        // get appended as a follow-up user message (with a short caption).
        let text = '';
        if (typeof b.content === 'string') {
          text = b.content;
        } else if (Array.isArray(b.content)) {
          const textBits = [];
          for (const x of b.content) {
            if (!x) continue;
            if (x.type === 'text') textBits.push(x.text || '');
            else if (x.type === 'image' && x.source) {
              if (modelSupportsVision(model)) {
                const img = await resolveImageSource(x.source);
                trailingImages.push({ ...img, _caption: textBits.join('\n') || null });
                textBits.length = 0; // image content is moved out
              } else if (process.env.LOG) {
                console.log(`  ~ dropping image (model ${model} does not support vision)`);
              }
            }
          }
          text = textBits.join('\n');
        }
        toolResults.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: b.is_error ? `[tool error] ${text}` : text,
        });
      }
      // 'thinking' / 'redacted_thinking' blocks: dropped.
    }
    if (m.role === 'assistant') {
      const msg = { role: 'assistant', content: textParts.length ? textParts.join('') : null };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
    } else if (m.role === 'user') {
      if (textParts.length) {
        // If anything is non-string (image), emit the array form with all parts
        // as typed objects. Otherwise join to a single string.
        const hasNonString = textParts.some((p) => typeof p !== 'string');
        if (hasNonString) {
          const content = textParts.map((p) =>
            typeof p === 'string' ? { type: 'text', text: p } : p,
          );
          out.push({ role: 'user', content });
        } else {
          out.push({ role: 'user', content: textParts.join('') });
        }
      }
      for (const tr of toolResults) out.push(tr);
      for (const img of trailingImages) {
        const parts = [];
        if (img._caption)
          parts.push({ type: 'text', text: `[tool returned an image] ${img._caption}` });
        else parts.push({ type: 'text', text: '[tool returned an image]' });
        parts.push({ type: 'image_url', image_url: img.image_url });
        out.push({ role: 'user', content: parts });
      }
    }
  }
  return out;
}

function anthropicToOpenAITools(tools) {
  if (!tools) return undefined;
  return tools.map((t) => {
    const fn = {
      name: t.name,
      description: t.description,
      parameters: t.input_schema ? cleanupSchemaForChatCompletions(t.input_schema) : t.input_schema,
    };
    return {
      type: 'function',
      function: fn,
      // strict: false is critical — Anthropic marks every param as required,
      // so OpenAI's strict validation rejects the call when an optional is omitted.
    };
  });
}

function mapToolChoice(tc) {
  if (!tc) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}

async function buildOpenAIRequest(anth, opts = {}) {
  const modelOverride = opts.modelOverride !== undefined ? opts.modelOverride : MODEL_OVERRIDE;
  const model = modelOverride || anth.model;
  const req = {
    model,
    messages: await anthropicToOpenAIMessages(anth, model),
    stream: !!anth.stream,
  };
  const maxTok = capMaxTokens(anth.max_tokens, model);
  // For o-series and gpt-5 we use max_completion_tokens instead of max_tokens.
  if (needsMaxCompletionTokens(model) && maxTok > 0) req.max_completion_tokens = maxTok;
  else if (maxTok > 0) req.max_tokens = maxTok;
  if (anth.temperature !== undefined && !needsMaxCompletionTokens(model)) {
    req.temperature = anth.temperature;
  }
  if (anth.top_p !== undefined) req.top_p = anth.top_p;
  if (anth.stop_sequences) req.stop = anth.stop_sequences;
  const tools = anthropicToOpenAITools(anth.tools);
  if (tools) req.tools = tools;
  const tc = mapToolChoice(anth.tool_choice);
  if (tc) req.tool_choice = tc;
  if (anth.stream) req.stream_options = { include_usage: true };
  applyThinking(anth, req, model);
  return req;
}

module.exports = {
  anthropicToOpenAIMessages,
  anthropicToOpenAITools,
  mapToolChoice,
  buildOpenAIRequest,
  configureRequest,
};
