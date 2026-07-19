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
const IMAGE_FETCH = args.imageFetch || process.env.IMAGE_FETCH === '1';
const MAX_IMAGE_BYTES = parseInt(
  args.maxImageBytes || process.env.MAX_IMAGE_BYTES || String(20 * 1024 * 1024),
  10
);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base' || a === '-b') out.base = argv[++i];
    else if (a === '--key' || a === '-k') out.key = argv[++i];
    else if (a === '--port' || a === '-p') out.port = argv[++i];
    else if (a === '--model' || a === '-m') out.model = argv[++i];
    else if (a === '--image-fetch') out.imageFetch = true;
    else if (a === '--max-image-bytes') out.maxImageBytes = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
  }
  return out;
}

function printHelp() {
  process.stdout.write(`Usage: node proxy.js [options]

Options:
  -b, --base <url>           OpenAI-compatible base URL (e.g. http://localhost:11434/v1)
  -k, --key <key>            API key sent as Bearer to upstream
  -p, --port <port>          Port to listen on (default 8082)
  -m, --model <name>         Override the model name in every request
      --image-fetch          Fetch+base64 re-encode image URL sources server-side
                             (use when upstream doesn't accept URL image inputs)
      --max-image-bytes <n>  Max bytes per image when --image-fetch is on (default 20M)
  -h, --help                 Show this help

Env vars: OPENAI_BASE_URL, OPENAI_API_KEY, PORT, MODEL_OVERRIDE,
          IMAGE_FETCH=1, MAX_IMAGE_BYTES, LOG=1
`);
}

// ---------- helpers ----------

function msgId() {
  return 'msg_' + Math.random().toString(36).slice(2, 26);
}

function reqId() {
  return 'req_' + Math.random().toString(36).slice(2, 18);
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

// ---------- fetch with retry ----------
//
// Chat-completions POSTs are safe to retry on 429/5xx and transient network
// errors because the upstream either never received the call or rejected it
// before any state change. We retry only BEFORE the first byte is sent to
// the client — once we start streaming, mid-stream retry would duplicate the
// message_start event and Anthropic SSE has no rewind.
//
// Reference: CLASP/internal/proxy/handler.go:961 doRequestWithRetry. We
// diverge by including 429 (CLASP misses it) and 529 (CLASP excludes it),
// and we honor Retry-After.

const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 4000;
const RETRY_TOTAL_DEADLINE_MS = 30000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504, 529]);
const RETRYABLE_NET_CODES = new Set([
  'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'EAI_AGAIN',
  'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT',
]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); reject(new Error('aborted')); };
    const cleanup = () => { clearTimeout(t); signal?.removeEventListener('abort', onAbort); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseRetryAfter(header) {
  if (!header) return null;
  const s = Number(header);
  if (Number.isFinite(s) && s >= 0) return Math.min(s * 1000, RETRY_MAX_MS);
  const t = Date.parse(header);
  if (!Number.isNaN(t)) return Math.min(Math.max(t - Date.now(), 0), RETRY_MAX_MS);
  return null;
}

function isRetryableNetworkError(e) {
  if (e?.name === 'AbortError') return false;
  const code = e?.cause?.code;
  if (code && RETRYABLE_NET_CODES.has(code)) return true;
  if (typeof e?.message === 'string' && e.message.includes('fetch failed')) return true;
  return false;
}

async function fetchWithRetry(url, opts, signal) {
  const start = Date.now();
  let attempt = 0;
  while (true) {
    if (signal?.aborted) throw new Error('aborted');
    let r;
    try {
      r = await fetch(url, { ...opts, signal });
    } catch (e) {
      if (!isRetryableNetworkError(e) || Date.now() - start >= RETRY_TOTAL_DEADLINE_MS) throw e;
      const delay = Math.min(RETRY_BASE_MS * 2 ** attempt + Math.random() * 100, RETRY_MAX_MS);
      if (process.env.LOG) console.log(`  ↻ retry ${attempt + 1} after ${Math.round(delay)}ms (network: ${e.cause?.code || e.message})`);
      await sleep(delay, signal);
      attempt++;
      continue;
    }
    if (r.ok) return r;
    if (!RETRYABLE_STATUS.has(r.status) || Date.now() - start >= RETRY_TOTAL_DEADLINE_MS) return r;
    // Drain so the connection can be reused for the next attempt.
    try { await r.text(); } catch (_) {}
    const retryAfter = parseRetryAfter(r.headers.get('retry-after'));
    const delay = retryAfter ?? Math.min(RETRY_BASE_MS * 2 ** attempt + Math.random() * 100, RETRY_MAX_MS);
    if (process.env.LOG) console.log(`  ↻ retry ${attempt + 1} after ${Math.round(delay)}ms (status ${r.status})`);
    await sleep(delay, signal);
    attempt++;
  }
}

// Returns an AbortSignal that fires when the client disconnects mid-request.
function reqAbortSignal(req) {
  if (typeof AbortSignal.timeout === 'function' && req) {
    const ac = new AbortController();
    req.on('close', () => ac.abort());
    return ac.signal;
  }
  return undefined;
}

// ---------- Anthropic request -> OpenAI request ----------

async function resolveImageSource(source) {
  if (!source) throw new Error('image: missing source');
  if (source.type === 'base64') {
    if (!source.media_type || !source.data) throw new Error('image: base64 source missing media_type or data');
    return { type: 'image_url', image_url: { url: `data:${source.media_type};base64,${source.data}` } };
  }
  if (source.type === 'url') {
    if (!source.url) throw new Error('image: url source missing url');
    if (!IMAGE_FETCH) return { type: 'image_url', image_url: { url: source.url } };
    // Server-side fetch + base64 re-encode. Use when the upstream doesn't
    // accept URL image inputs (Ollama, llama.cpp, vLLM with file refs, etc.).
    const r = await fetch(source.url, { signal: AbortSignal.timeout(10000) });
    if (!r.ok) throw new Error(`image: fetch ${source.url} returned ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_IMAGE_BYTES) {
      throw new Error(`image: ${buf.length} bytes from ${source.url} exceeds --max-image-bytes (${MAX_IMAGE_BYTES})`);
    }
    const ct = r.headers.get('content-type') || 'image/png';
    return { type: 'image_url', image_url: { url: `data:${ct};base64,${buf.toString('base64')}` } };
  }
  if (source.type === 'file') {
    throw new Error('image: file source type (Anthropic Files API) is not supported by this proxy');
  }
  throw new Error(`image: unknown source type: ${source.type}`);
}

async function anthropicToOpenAIMessages(anth, model) {
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
    const trailingImages = []; // images that can't fit in a tool message; appended as user messages
    for (const b of m.content || []) {
      if (b.type === 'text') {
        textParts.push(b.text);
      } else if (b.type === 'image' && b.source) {
        textParts.push(await resolveImageSource(b.source));
      } else if (b.type === 'tool_use') {
        toolCalls.push({
          id: b.id, type: 'function',
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
              const img = await resolveImageSource(x.source);
              trailingImages.push({ ...img, _caption: textBits.join('\n') || null });
              textBits.length = 0; // image content is moved out
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
      for (const img of trailingImages) {
        const parts = [];
        if (img._caption) parts.push({ type: 'text', text: `[tool returned an image] ${img._caption}` });
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

async function buildOpenAIRequest(anth) {
  const model = MODEL_OVERRIDE || anth.model;
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

// Context-window limits per model. Claude Code assumes a 200k context (because
// it talks to Claude natively), so we scale input/output token counts by
// 200k / modelLimit so the TUI's "context used" indicator behaves correctly
// for non-Claude upstreams. Reference: CLASP/internal/translator/context_scaling.go
const ANTHROPIC_CONTEXT = 200000;
const DEFAULT_CONTEXT_LIMIT = 32000; // safe over-report for unknown models
const MODEL_CONTEXT_LIMITS = {
  // OpenAI
  'gpt-5': 1000000, 'gpt-5-mini': 400000, 'gpt-5-nano': 400000, 'gpt-5-chat-latest': 128000,
  'gpt-5.1': 1000000, 'gpt-5.2': 1000000, 'gpt-5.4': 1000000, 'gpt-5.5': 1000000, 'gpt-5.6': 1000000,
  'gpt-4o': 128000, 'gpt-4o-mini': 128000,
  'gpt-4-turbo': 128000, 'gpt-4': 8192,
  'gpt-3.5-turbo': 16385,
  'o1': 200000, 'o1-mini': 128000, 'o1-preview': 128000,
  'o3': 200000, 'o3-mini': 200000, 'o4-mini': 200000,
  // Anthropic (1:1 — no scaling)
  'claude-3-5-sonnet': 200000, 'claude-3-5-haiku': 200000,
  'claude-3-opus': 200000, 'claude-3-sonnet': 200000, 'claude-3-haiku': 200000,
  // Google
  'gemini-2.0-flash': 1000000, 'gemini-2.0-pro': 2000000,
  'gemini-1.5-pro': 2000000, 'gemini-1.5-flash': 1000000,
  // Mistral
  'mistral-large': 128000, 'mistral-small': 32000, 'mixtral': 32000,
  // Meta
  'llama-3.1-405b': 128000, 'llama-3.1-70b': 128000, 'llama-3.1-8b': 128000,
  'llama-3.2': 128000,
  // Qwen
  'qwen-2.5-72b': 128000, 'qwen-long': 1000000,
  // DeepSeek
  'deepseek-v3': 64000, 'deepseek-r1': 64000, 'deepseek-v3.1': 128000, 'deepseek-v3.2': 128000,
};

function getModelContextLimit(model) {
  if (!model) return DEFAULT_CONTEXT_LIMIT;
  if (MODEL_CONTEXT_LIMITS[model]) return MODEL_CONTEXT_LIMITS[model];
  for (const [prefix, limit] of Object.entries(MODEL_CONTEXT_LIMITS)) {
    if (model.startsWith(prefix)) return limit;
  }
  return DEFAULT_CONTEXT_LIMIT;
}

function contextScale(model) {
  return ANTHROPIC_CONTEXT / getModelContextLimit(model);
}

function scaleUsage(usage, model) {
  if (!usage) return usage;
  const k = contextScale(model);
  if (k === 1) return usage;
  const out = { ...usage };
  if (typeof usage.input_tokens === 'number') out.input_tokens = Math.ceil(usage.input_tokens * k);
  if (typeof usage.output_tokens === 'number') out.output_tokens = Math.ceil(usage.output_tokens * k);
  return out;
}

// Rough char-based estimate of input tokens (used for the message_start event
// before the real count arrives in the final usage chunk). 4 chars/token is
// a common rule of thumb for English/dense code.
function estimateInputTokens(oaiReq) {
  try { return Math.ceil(JSON.stringify(oaiReq.messages).length / 4); } catch (e) { return 0; }
}

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

  start(estimatedInputTokens) {
    const usage = scaleUsage(
      { input_tokens: estimatedInputTokens || 0, output_tokens: 0 },
      this.model
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
    const upstreamOutput = usage?.completion_tokens ?? this.outputTokens;
    const scaled = scaleUsage({ output_tokens: upstreamOutput, reasoning_tokens: usage?.output_tokens_details?.reasoning_tokens || 0 }, this.model);
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

  let oaiReq;
  try {
    oaiReq = await buildOpenAIRequest(anth);
  } catch (e) {
    if (process.env.LOG) console.log('  <- build error:', e.message);
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: anthropicError(400, e.message).error,
      request_id: reqId(),
    }));
    return;
  }
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
    upstream = await fetchWithRetry(`${BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
      },
      body: JSON.stringify(oaiReq),
    }, reqAbortSignal(req));
  } catch (e) {
    if (process.env.LOG) console.log('  <- upstream fetch failed:', e.message);
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: anthropicError(502, `upstream fetch failed: ${e.message}`).error,
      request_id: reqId(),
    }));
    return;
  }

  if (!upstream.ok) {
    const errText = await upstream.text();
    let parsed = null;
    try { parsed = JSON.parse(errText); } catch (e) {}
    const msg = parsed?.error?.message || errText || `upstream returned ${upstream.status}`;
    if (process.env.LOG) console.log('  <- upstream error', upstream.status, errText.slice(0, 500));
    res.writeHead(upstream.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      type: 'error',
      error: anthropicError(upstream.status, msg).error,
      request_id: reqId(),
    }));
    return;
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
      usage: scaleUsage({
        input_tokens: data.usage?.prompt_tokens || 0,
        output_tokens: data.usage?.completion_tokens || 0,
        reasoning_tokens: data.usage?.output_tokens_details?.reasoning_tokens || 0,
      }, anth.model),
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
  res.write(b.start(estimateInputTokens(oaiReq)));

  // SSE keepalive ping. Reasoning models can sit silent 30-60s before the
  // first content delta, which trips idle timeouts at intermediate proxies
  // and cloud front-doors. Emitting a ping right after message_start and
  // every 15s afterwards defeats this. CLASP does the same (stream.go:424).
  const writePing = () => {
    if (res.writableEnded || res.destroyed) return false;
    res.write(`event: ping\ndata: ${JSON.stringify({ type: 'ping' })}\n\n`);
    return true;
  };
  writePing();
  const pingTimer = setInterval(writePing, 15000);

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
  } finally {
    clearInterval(pingTimer);
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
