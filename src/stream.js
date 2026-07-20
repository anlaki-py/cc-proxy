'use strict';

// ---------- OpenAI stream -> Anthropic SSE ----------

const { msgId, sse } = require('./ids.js');
const { scaleUsage } = require('./models.js');

class StreamBuilder {
  constructor(model) {
    this.model = model;
    this.messageId = msgId();
    this.blockIndex = 0;
    this.textBlockOpen = false;
    this.textBlockIndex = -1;
    this.thinkingBlockOpen = false;
    this.thinkingBlockIndex = -1;
    this.toolBlocks = new Map(); // tool_call_id -> {index, name, args}
    this.toolIndexMap = new Map(); // oai delta index -> tool_call_id
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.finishReason = 'end_turn';
  }

  start(estimatedInputTokens) {
    const usage = scaleUsage(
      { input_tokens: estimatedInputTokens || 0, output_tokens: 0 },
      this.model,
    );
    return sse('message_start', {
      type: 'message_start',
      message: {
        id: this.messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model: this.model,
        stop_reason: null,
        stop_sequence: null,
        usage,
      },
    });
  }

  // Returns the SSE chunk + true if it opened a new block; false if the
  // thinking block is already open or if `text` was empty.
  openThinking(text) {
    if (!text) return '';
    let out = '';
    if (!this.thinkingBlockOpen) {
      this.thinkingBlockIndex = this.blockIndex++;
      this.thinkingBlockOpen = true;
      out += sse('content_block_start', {
        type: 'content_block_start',
        index: this.thinkingBlockIndex,
        content_block: { type: 'thinking', thinking: '' },
      });
    }
    out += sse('content_block_delta', {
      type: 'content_block_delta',
      index: this.thinkingBlockIndex,
      delta: { type: 'thinking_delta', thinking: text },
    });
    return out;
  }

  closeThinking() {
    if (!this.thinkingBlockOpen) return '';
    this.thinkingBlockOpen = false;
    const out = sse('content_block_stop', {
      type: 'content_block_stop',
      index: this.thinkingBlockIndex,
    });
    this.thinkingBlockIndex = -1;
    return out;
  }

  openText() {
    if (this.textBlockOpen) return '';
    // If a thinking block is still open when text starts, close it first
    // (mirrors what ollama's anthropic adapter does at line ~821).
    const prefix = this.closeThinking();
    this.textBlockOpen = true;
    this.textBlockIndex = this.blockIndex++;
    return (
      prefix +
      sse('content_block_start', {
        type: 'content_block_start',
        index: this.textBlockIndex,
        content_block: { type: 'text', text: '' },
      })
    );
  }

  closeText() {
    if (!this.textBlockOpen) return '';
    this.textBlockOpen = false;
    const out = sse('content_block_stop', {
      type: 'content_block_stop',
      index: this.textBlockIndex,
    });
    this.textBlockIndex = -1;
    return out;
  }

  text(t) {
    if (!t) return '';
    const prefix = this.textBlockOpen ? '' : this.openText();
    return (
      prefix +
      sse('content_block_delta', {
        type: 'content_block_delta',
        index: this.textBlockIndex,
        delta: { type: 'text_delta', text: t },
      })
    );
  }

  openToolCall(oaiIndex, id, name) {
    let out = '';
    if (this.textBlockOpen) out += this.closeText();
    out += this.closeThinking();
    const idx = this.blockIndex++;
    this.toolBlocks.set(id, { index: idx, name, args: '' });
    this.toolIndexMap.set(oaiIndex, id);
    out += sse('content_block_start', {
      type: 'content_block_start',
      index: idx,
      content_block: { type: 'tool_use', id, name, input: {} },
    });
    return out;
  }

  appendToolArgs(oaiIndex, partialArgs) {
    const id = this.toolIndexMap.get(oaiIndex);
    if (!id) return '';
    const info = this.toolBlocks.get(id);
    if (!info) return '';
    info.args += partialArgs;
    return sse('content_block_delta', {
      type: 'content_block_delta',
      index: info.index,
      delta: { type: 'input_json_delta', partial_json: partialArgs },
    });
  }

  closeAllToolBlocks() {
    let out = '';
    for (const info of this.toolBlocks.values()) {
      out += sse('content_block_stop', { type: 'content_block_stop', index: info.index });
    }
    this.toolBlocks.clear();
    this.toolIndexMap.clear();
    return out;
  }

  finish(usage) {
    let out = '';
    if (this.textBlockOpen) out += this.closeText();
    out += this.closeThinking();
    out += this.closeAllToolBlocks();
    const upstreamOutput = usage?.completion_tokens ?? this.outputTokens;
    const scaled = scaleUsage(
      {
        output_tokens: upstreamOutput,
        reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens || 0,
      },
      this.model,
    );
    out += sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.finishReason, stop_sequence: null },
      usage: scaled,
    });
    out += sse('message_stop', { type: 'message_stop' });
    return out;
  }
}

function parseSSEEvents(buf) {
  const events = [];
  let start = 0;
  const sep = /\r?\n\r?\n/g;
  sep.lastIndex = 0;
  let m;
  while ((m = sep.exec(buf)) !== null) {
    const block = buf.slice(start, m.index);
    start = m.index + m[0].length;
    let data = '';
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) data += line.slice(5).trim();
    }
    if (!data || data === '[DONE]') continue;
    try {
      events.push(JSON.parse(data));
    } catch (e) {
      /* skip malformed */
    }
  }
  return { events, rest: buf.slice(start) };
}

function mapFinishReason(reason) {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'length' || reason === 'max_tokens') return 'max_tokens';
  if (reason === 'content_filter' || reason === 'safety') return 'end_turn';
  return 'end_turn';
}

module.exports = { StreamBuilder, parseSSEEvents, mapFinishReason };
