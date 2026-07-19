#!/usr/bin/env node
// Anthropic <-> OpenAI proxy for Claude Code.
//
// Usage:
//   node proxy.js --base https://api.openai.com/v1 --key sk-xxx --port 8082
//   or via env: OPENAI_BASE_URL, OPENAI_API_KEY, PORT, MODEL_OVERRIDE
//
// Then in Claude Code:
//   export ANTHROPIC_BASE_URL=http://localhost:8082
//   export ANTHROPIC_AUTH_TOKEN=any
//   claude --bare                  # interactive
//   claude -p --bare "your prompt" # non-interactive
//
// Notes:
//   * Thinking blocks from Claude Code are dropped (no OpenAI analogue).
//     Disable extended thinking in Claude Code if you want clean runs.
//   * Streaming is translated chunk-by-chunk from OpenAI SSE to Anthropic SSE.
//   * Tool calls: streams are stitched via OpenAI's `index` field, so multi-tool
//     and partial-arg deltas work.

const http = require('http');

// ---------- config ----------

const args = parseArgs(process.argv.slice(2));
const BASE = (args.base || process.env.OPENAI_BASE_URL || 'http://localhost:11434/v1').replace(/\/$/, '');
const KEY = args.key || process.env.OPENAI_API_KEY || '';
const PORT = parseInt(args.port || process.env.PORT || '8082', 10);
const MODEL_OVERRIDE = args.model || process.env.MODEL_OVERRIDE || '';

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base' || a === '-b') out.base = argv[++i];
    else if (a === '--key' || a === '-k') out.key = argv[++i];
    else if (a === '--port' || a === '-p') out.port = argv[++i];
    else if (a === '--model' || a === '-m') out.model = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`Usage: node proxy.js [options]

Options:
  -b, --base <url>     OpenAI-compatible base URL (e.g. http://localhost:11434/v1)
  -k, --key <key>      API key sent as Bearer to upstream
  -p, --port <port>    Port to listen on (default 8082)
  -m, --model <name>   Override the model name in every request
  -h, --help           Show this help

Env vars: OPENAI_BASE_URL, OPENAI_API_KEY, PORT, MODEL_OVERRIDE, LOG=1
`);
}

// ---------- helpers ----------

function msgId() {
  return 'msg_' + Math.random().toString(36).slice(2, 26);
}

function sse(eventType, data) {
  return `event: ${eventType}\ndata: ${JSON.stringify(data)}\n\n`;
}

function anthropicError(status, message) {
  let type = 'api_error';
  if (status === 400) type = 'invalid_request_error';
  else if (status === 401) type = 'authentication_error';
  else if (status === 403) type = 'permission_error';
  else if (status === 404) type = 'not_found_error';
  else if (status === 429) type = 'rate_limit_error';
  else if (status === 503 || status === 529) type = 'overloaded_error';
  return { type: 'error', error: { type, message } };
}

function writeJsonError(res, status, message) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(anthropicError(status, message)));
}

// ---------- Anthropic request -> OpenAI request ----------

function anthropicToOpenAIMessages(anth, model) {
  const out = [];
  if (anth.system) {
    const sys = typeof anth.system === 'string'
      ? anth.system
      : (anth.system || []).map(b => b.text || '').join('\n\n');
    if (sys) out.push({ role: needsMaxCompletionTokens(model) ? 'developer' : 'system', content: sys });
  }
  for (const m of anth.messages || []) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content });
      continue;
    }
    const textParts = [];
    const toolCalls = [];
    const toolResults = [];
    for (const b of m.content || []) {
      if (b.type === 'text') {
        textParts.push(b.text);
      } else if (b.type === 'image' && b.source) {
        const s = b.source;
        if (s.type === 'base64') {
          textParts.push({ type: 'image_url', image_url: { url: `data:${s.media_type};base64,${s.data}` } });
        } else if (s.type === 'url') {
          textParts.push({ type: 'image_url', image_url: { url: s.url } });
        }
      } else if (b.type === 'tool_use') {
        toolCalls.push({
          id: b.id, type: 'function',
          function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) },
        });
      } else if (b.type === 'tool_result') {
        const c = typeof b.content === 'string'
          ? b.content
          : (b.content || []).map(x => x.text || '').join('');
        toolResults.push({
          role: 'tool',
          tool_call_id: b.tool_use_id,
          content: b.is_error ? `[tool error] ${c}` : c,
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
        const hasNonString = textParts.some(p => typeof p !== 'string');
        if (hasNonString) {
          const content = textParts.map(p =>
            typeof p === 'string' ? { type: 'text', text: p } : p
          );
          out.push({ role: 'user', content });
        } else {
          out.push({ role: 'user', content: textParts.join('') });
        }
      }
      for (const tr of toolResults) out.push(tr);
    }
  }
  return out;
}

function anthropicToOpenAITools(tools) {
  if (!tools) return undefined;
  return tools.map(t => {
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

// Clean an Anthropic JSON Schema so it's safe to send to the OpenAI Chat
// Completions endpoint. Two things go wrong otherwise:
//   1. OpenAI rejects `format: "uri"` and the schema-level `strict: true`.
//   2. Anthropic (and Claude Code) mark every parameter as required, which
//      causes OpenAI to reject the call when the model omits an optional
//      argument. We re-derive `required` to only the params that are truly
//      required: present in the original `required`, no default, not nullable,
//      not a boolean (flags are almost always optional), and the description
//      doesn't contain "optional"-style phrases.
function cleanupSchemaForChatCompletions(schema) {
  if (!schema || typeof schema !== 'object') return schema;
  const out = JSON.parse(JSON.stringify(schema));
  const visit = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.format === 'uri') delete node.format;
    delete node.strict;
    if (node.properties && typeof node.properties === 'object') {
      const originalRequired = new Set(Array.isArray(node.required) ? node.required : []);
      const truly = [];
      for (const [name, prop] of Object.entries(node.properties)) {
        if (!originalRequired.has(name)) continue;
        if (typeof prop !== 'object' || !prop) continue;
        if ('default' in prop) continue;
        if (prop.nullable === true) continue;
        if (prop.type === 'boolean') continue;
        const desc = (prop.description || '').toLowerCase();
        if (
          desc.includes('optional') ||
          desc.includes('(optional)') ||
          desc.includes('if not specified') ||
          desc.includes('defaults to') ||
          desc.includes('set to true to') ||
          desc.includes('set to false to') ||
          desc.includes('if provided') ||
          desc.includes('when provided') ||
          desc.includes('can be omitted') ||
          desc.includes('not required') ||
          desc.includes('only provide if')
        ) continue;
        truly.push(name);
      }
      if (truly.length) node.required = truly;
      else delete node.required;
      for (const v of Object.values(node.properties)) visit(v);
    }
    if (node.items && typeof node.items === 'object') visit(node.items);
  };
  visit(out);
  return out;
}

function mapToolChoice(tc) {
  if (!tc) return undefined;
  if (tc.type === 'auto') return 'auto';
  if (tc.type === 'any') return 'required';
  if (tc.type === 'none') return 'none';
  if (tc.type === 'tool' && tc.name) return { type: 'function', function: { name: tc.name } };
  return undefined;
}

function buildOpenAIRequest(anth) {
  const model = MODEL_OVERRIDE || anth.model;
  const req = {
    model,
    messages: anthropicToOpenAIMessages(anth, model),
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

// Per-model cap on max_tokens. Values lifted from CLASP request.go.
const MODEL_MAX_TOKENS = {
  'gpt-4.5': 32768, 'gpt-4.5-preview': 32768, 'gpt-4.5-turbo': 32768,
  'gpt-4o': 16384, 'gpt-4o-2024-11-20': 16384, 'gpt-4o-2024-08-06': 16384,
  'gpt-4o-2024-05-13': 4096, 'gpt-4o-mini': 16384, 'gpt-4o-mini-2024-07-18': 16384,
  'gpt-4-turbo': 4096, 'gpt-4-turbo-2024-04-09': 4096, 'gpt-4-turbo-preview': 4096,
  'gpt-4-0125-preview': 4096, 'gpt-4-1106-preview': 4096,
  'gpt-4': 8192, 'gpt-4-32k': 8192, 'gpt-4-0613': 8192, 'gpt-4-32k-0613': 8192,
  'gpt-3.5-turbo': 4096, 'gpt-3.5-turbo-0125': 4096, 'gpt-3.5-turbo-1106': 4096, 'gpt-3.5-turbo-16k': 4096,
  o1: 100000, 'o1-preview': 32768, 'o1-mini': 65536,
  o3: 100000, 'o3-mini': 100000,
  'gpt-5': 16384, 'gpt-5-mini': 16384, 'gpt-5-nano': 16384, 'gpt-5-chat-latest': 16384,
  'gpt-5.1': 16384, 'gpt-5.2': 16384, 'gpt-5.4': 16384, 'gpt-5.5': 16384, 'gpt-5.6': 16384,
  'claude-3-5-sonnet': 8192, 'claude-3-5-sonnet-20241022': 8192, 'claude-3-5-sonnet-20240620': 8192,
  'claude-3-5-haiku': 8192, 'claude-3-5-haiku-20241022': 8192,
  'claude-3-opus': 4096, 'claude-3-sonnet': 4096, 'claude-3-haiku': 4096,
  'gemini-2.0-flash': 8192, 'gemini-2.0-flash-lite': 8192, 'gemini-2.0-pro': 8192, 'gemini-2.0-flash-exp': 8192,
  'gemini-1.5-pro': 8192, 'gemini-1.5-flash': 8192,
};
const DEFAULT_MAX_TOKENS = 16384;

function capMaxTokens(requested, model) {
  if (!requested || requested <= 0) return requested;
  let limit = MODEL_MAX_TOKENS[model];
  if (!limit) {
    for (const [prefix, cap] of Object.entries(MODEL_MAX_TOKENS)) {
      if (model.startsWith(prefix)) { limit = cap; break; }
    }
  }
  if (!limit) limit = DEFAULT_MAX_TOKENS;
  return Math.min(requested, limit);
}

function needsMaxCompletionTokens(model) {
  const m = model.toLowerCase();
  return (
    m.startsWith('o1') || m.startsWith('o3') ||
    m.startsWith('gpt-5') || m.startsWith('gpt5') ||
    m.includes('codex')
  );
}

// Map Anthropic's extended thinking to the upstream's reasoning field. We
// support the four shapes CLASP covers: OpenAI o-series / gpt-5, Grok, Gemini
// 2.5/3, Qwen, DeepSeek-R1/V3.1+. For models with no reasoning analogue
// (the common case) we just drop `thinking` and continue.
function applyThinking(anth, req, model) {
  const t = anth.thinking;
  if (!t || !t.type || t.type === 'disabled') {
    // On known reasoning models, explicitly turn reasoning off so the upstream
    // doesn't burn budget when the client asked for none.
    if (needsMaxCompletionTokens(model)) req.reasoning_effort = 'none';
    return;
  }
  const m = model.toLowerCase();
  const budget = t.budget_tokens || 0;
  if (needsMaxCompletionTokens(m)) {
    if (t.type === 'adaptive') {
      // Anthropic's adaptive mode: let the model pick. medium is a safe default.
      req.reasoning_effort = 'medium';
    } else if (budget <= 0) {
      req.reasoning_effort = 'low';
    } else {
      req.reasoning_effort =
        budget >= 80000 ? 'xhigh' :
        budget >= 24000 ? 'high' :
        budget >= 8000  ? 'medium' :
        budget >= 2000  ? 'low' :
        'minimal'; // legacy o1/o1-mini only; gpt-5+ will reject
    }
  } else if (m.includes('grok')) {
    req.reasoning_effort = budget >= 20000 ? 'high' : 'low';
  } else if (m.includes('gemini-3') || m.includes('gemini/3')) {
    req.thinking_level = budget >= 16000 ? 'high' : 'low';
  } else if (m.includes('gemini-2.5') || m.includes('gemini/2.5')) {
    req.thinking_config = { thinking_budget: Math.min(budget, 24576) };
  } else if (m.includes('qwen')) {
    req.enable_thinking = true;
    req.thinking_budget = budget;
  } else if (m.includes('deepseek') &&
             (m.includes('r1') || m.includes('v3.1') || m.includes('v3.2') || m.includes('thinking'))) {
    req.enable_thinking = true;
  }
  // otherwise: silently drop. Most OpenAI-compatible endpoints ignore `thinking`.
}

// ---------- OpenAI stream -> Anthropic SSE ----------

class StreamBuilder {
  constructor(model) {
    this.model = model;
    this.messageId = msgId();
    this.blockIndex = 0;
    this.textBlockOpen = false;
    this.textBlockIndex = -1;
    this.thinkingBlockOpen = false;
    this.thinkingBlockIndex = -1;
    this.toolBlocks = new Map();   // tool_call_id -> {index, name, args}
    this.toolIndexMap = new Map(); // oai delta index -> tool_call_id
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.finishReason = 'end_turn';
  }

  start() {
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
        usage: { input_tokens: this.inputTokens, output_tokens: 0 },
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
    return prefix + sse('content_block_start', {
      type: 'content_block_start',
      index: this.textBlockIndex,
      content_block: { type: 'text', text: '' },
    });
  }

  closeText() {
    if (!this.textBlockOpen) return '';
    this.textBlockOpen = false;
    const out = sse('content_block_stop', { type: 'content_block_stop', index: this.textBlockIndex });
    this.textBlockIndex = -1;
    return out;
  }

  text(t) {
    if (!t) return '';
    const prefix = this.textBlockOpen ? '' : this.openText();
    return prefix + sse('content_block_delta', {
      type: 'content_block_delta',
      index: this.textBlockIndex,
      delta: { type: 'text_delta', text: t },
    });
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
    const outputTokens = usage?.completion_tokens ?? this.outputTokens;
    out += sse('message_delta', {
      type: 'message_delta',
      delta: { stop_reason: this.finishReason, stop_sequence: null },
      usage: {
        output_tokens: outputTokens,
        reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens || 0,
      },
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
    try { events.push(JSON.parse(data)); } catch (e) { /* skip malformed */ }
  }
  return { events, rest: buf.slice(start) };
}

function mapFinishReason(reason) {
  if (reason === 'tool_calls' || reason === 'function_call') return 'tool_use';
  if (reason === 'length' || reason === 'max_tokens') return 'max_tokens';
  if (reason === 'content_filter' || reason === 'safety') return 'end_turn';
  return 'end_turn';
}

// ---------- HTTP server ----------

const server = http.createServer(async (req, res) => {
  if (process.env.LOG) process.stdout.write(`> ${req.method} ${req.url}\n`);

  if (req.method === 'HEAD' && req.url === '/') {
    // Some clients (Claude Code) probe with HEAD before sending body.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end();
    return;
  }

  if (req.method === 'GET' && (req.url === '/' || req.url === '/health')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'ok', upstream: BASE, model_override: MODEL_OVERRIDE || null }));
    return;
  }

  if (req.method === 'GET' && req.url === '/v1/models') {
    try {
      const r = await fetch(`${BASE}/models`, {
        headers: KEY ? { authorization: `Bearer ${KEY}` } : {},
      });
      const data = await r.json();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [] }));
    }
    return;
  }

  // Strip query string for path matching (e.g. Claude Code sends ?beta=true).
  const reqPath = (req.url || '').split('?')[0];

  if (req.method !== 'POST' || reqPath !== '/v1/messages') {
    writeJsonError(res, 404, `not found: ${req.method} ${req.url}`);
    return;
  }

  let raw = '';
  for await (const chunk of req) raw += chunk;

  let anth;
  try { anth = JSON.parse(raw); }
  catch (e) { return writeJsonError(res, 400, 'invalid JSON: ' + e.message); }

  if (!anth.model) return writeJsonError(res, 400, 'model is required');
  if (!anth.max_tokens || anth.max_tokens <= 0) return writeJsonError(res, 400, 'max_tokens is required and must be positive');
  if (!Array.isArray(anth.messages) || anth.messages.length === 0) return writeJsonError(res, 400, 'messages is required');

  const oaiReq = buildOpenAIRequest(anth);
  if (process.env.LOG) {
    const summary = {
      model: oaiReq.model,
      msgs: oaiReq.messages.length,
      tools: oaiReq.tools?.length || 0,
      stream: oaiReq.stream,
    };
    console.log('  -> upstream', JSON.stringify(summary));
  }

  let upstream;
  try {
    upstream = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
      },
      body: JSON.stringify(oaiReq),
    });
  } catch (e) {
    return writeJsonError(res, 502, 'upstream fetch failed: ' + e.message);
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    let parsed = null;
    try { parsed = JSON.parse(errText); } catch (e) {}
    const msg = parsed?.error?.message || errText || `upstream returned ${upstream.status}`;
    return writeJsonError(res, upstream.status, msg);
  }

  // Non-streaming response
  if (!oaiReq.stream) {
    const data = await upstream.json();
    const choice = data.choices?.[0] || {};
    const msg = choice.message || {};
    const content = [];
    // Reasoning comes before text in the response, matching the streaming
    // block order (ollama/anthropic.go:659-680 and CLASP/stream.go:206-212).
    const thinking = msg.reasoning_content ?? msg.reasoning;
    if (thinking) content.push({ type: 'thinking', thinking });
    if (msg.content) content.push({ type: 'text', text: msg.content });
    if (Array.isArray(msg.tool_calls)) {
      for (const tc of msg.tool_calls) {
        let input = {};
        try { input = JSON.parse(tc.function?.arguments || '{}'); } catch (e) {}
        content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
      }
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      id: data.id || msgId(),
      type: 'message',
      role: 'assistant',
      content,
      model: data.model || anth.model,
      stop_reason: mapFinishReason(choice.finish_reason),
      stop_sequence: null,
      usage: {
        input_tokens: data.usage?.prompt_tokens || 0,
        output_tokens: data.usage?.completion_tokens || 0,
        reasoning_tokens: data.usage?.output_tokens_details?.reasoning_tokens || 0,
      },
    }));
    return;
  }

  // Streaming response
  res.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const b = new StreamBuilder(anth.model);
  res.write(b.start());

  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let usage = null;

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const { events, rest } = parseSSEEvents(buf);
      buf = rest;
      for (const ev of events) {
        if (ev.usage) usage = ev.usage;
        const choice = ev.choices?.[0];
        if (!choice) continue;
        const delta = choice.delta || {};
        // Reasoning/thinking content. Some providers use `reasoning` (Azure
        // OpenAI, mirrors CLASP's stream.go delta.Reasoning), others use
        // `reasoning_content` (DeepSeek-R1, Qwen, some Ollama-compat shims).
        const thinking = delta.reasoning ?? delta.reasoning_content;
        if (thinking) {
          const out = b.openThinking(thinking);
          if (out) res.write(out);
        }
        if (delta.content) {
          const out = b.text(delta.content);
          if (out) res.write(out);
        }
        if (Array.isArray(delta.tool_calls)) {
          for (const tc of delta.tool_calls) {
            const oaiIndex = tc.index ?? 0;
            if (tc.id && tc.function?.name) {
              res.write(b.openToolCall(oaiIndex, tc.id, tc.function.name));
            }
            if (tc.function?.arguments) {
              res.write(b.appendToolArgs(oaiIndex, tc.function.arguments));
            }
          }
        }
        if (choice.finish_reason) {
          b.finishReason = mapFinishReason(choice.finish_reason);
        }
      }
    }
    res.write(b.finish(usage));
    res.end();
    if (process.env.LOG) console.log('  <- done');
  } catch (e) {
    console.error('stream error:', e);
    try { res.end(); } catch (e) {}
  }
});

server.listen(PORT, () => {
  console.log(`Anthropic <-> OpenAI proxy listening on http://localhost:${PORT}`);
  console.log(`  upstream: ${BASE}`);
  console.log(`  auth:     ${KEY ? 'bearer ***' + KEY.slice(-4) : 'none'}`);
  if (MODEL_OVERRIDE) console.log(`  model:    ${MODEL_OVERRIDE} (override)`);
  console.log('');
  console.log('To use with Claude Code:');
  console.log(`  export ANTHROPIC_BASE_URL=http://localhost:${PORT}`);
  console.log(`  export ANTHROPIC_AUTH_TOKEN=any-value`);
  console.log(`  claude --bare                  # interactive`);
  console.log(`  claude -p --bare "your prompt" # non-interactive`);
  console.log('');
});
