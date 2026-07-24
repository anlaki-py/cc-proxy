'use strict';

// ---------- HTTP server ----------

const http = require('http');
const process = require('node:process');

const { msgId, reqId } = require('./ids.js');
const { anthropicError, writeJsonError } = require('./errors.js');
const { fetchWithRetry, reqAbortSignal } = require('./retry.js');
const { buildOpenAIRequest, configureRequest } = require('./request.js');
const { configureImages } = require('./images.js');
const { estimateInputTokens, scaleUsage } = require('./models.js');
const { StreamBuilder, parseSSEEvents, mapFinishReason } = require('./stream.js');

// startServer(config) builds the http server but does NOT listen. The caller
// (src/main.js) calls .listen(port, banner). Returns the server instance.
function startServer(config) {
  const { base, key, modelOverride, imageFetch, maxImageBytes } = config;

  // Push config into the request + image modules so their single-arg paths
  // (used by buildOpenAIRequest, resolveImageSource) pick it up.
  configureRequest({ modelOverride });
  configureImages({ imageFetch, maxImageBytes });

  const BASE = base.replace(/\/$/, '');
  const KEY = key;
  const MODEL_OVERRIDE = modelOverride;

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
      res.end(
        JSON.stringify({ status: 'ok', upstream: BASE, model_override: MODEL_OVERRIDE || null }),
      );
      return;
    }

    if (req.method === 'GET' && req.url === '/v1/models') {
      try {
        const r = await fetch(`${BASE}/models`, {
          headers: KEY ? { authorization: `Bearer ${KEY}` } : {},
        });
        const data = await r.json();
        if (!r.ok) {
          // Forward upstream failures as 502 in the Anthropic error envelope
          // so Claude Code surfaces them instead of silently seeing an empty
          // model list masked as success.
          if (res.writableEnded || res.destroyed) return;
          res.writeHead(502, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              type: 'error',
              error: anthropicError(502, `upstream /models returned ${r.status}`).error,
              request_id: reqId(),
            }),
          );
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(data));
      } catch {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(502, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            type: 'error',
            error: anthropicError(502, 'upstream /models fetch failed').error,
            request_id: reqId(),
          }),
        );
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
    try {
      for await (const chunk of req) raw += chunk;
    } catch (e) {
      if (res.writableEnded || res.destroyed) return;
      return writeJsonError(res, 502, 'request aborted: ' + e.message);
    }

    let anth;
    try {
      anth = JSON.parse(raw);
    } catch (e) {
      return writeJsonError(res, 400, 'invalid JSON: ' + e.message);
    }

    if (!anth.model) return writeJsonError(res, 400, 'model is required');
    if (!anth.max_tokens || anth.max_tokens <= 0)
      return writeJsonError(res, 400, 'max_tokens is required and must be positive');
    if (!Array.isArray(anth.messages) || anth.messages.length === 0)
      return writeJsonError(res, 400, 'messages is required');

    let oaiReq;
    try {
      oaiReq = await buildOpenAIRequest(anth);
    } catch (e) {
      if (process.env.LOG) console.log('  <- build error:', e.message);
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: anthropicError(400, e.message).error,
          request_id: reqId(),
        }),
      );
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
      upstream = await fetchWithRetry(
        `${BASE}/chat/completions`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(KEY ? { authorization: `Bearer ${KEY}` } : {}),
          },
          body: JSON.stringify(oaiReq),
        },
        reqAbortSignal(req),
      );
    } catch (e) {
      if (process.env.LOG) console.log('  <- upstream fetch failed:', e.message);
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: anthropicError(502, `upstream fetch failed: ${e.message}`).error,
          request_id: reqId(),
        }),
      );
      return;
    }

    if (!upstream.ok) {
      const errText = await upstream.text();
      let parsed = null;
      try {
        parsed = JSON.parse(errText);
      } catch {}
      const msg = parsed?.error?.message || errText || `upstream returned ${upstream.status}`;
      if (process.env.LOG)
        console.log('  <- upstream error', upstream.status, errText.slice(0, 500));
      if (res.writableEnded || res.destroyed) return;
      res.writeHead(upstream.status, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          type: 'error',
          error: anthropicError(upstream.status, msg).error,
          request_id: reqId(),
        }),
      );
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
          try {
            input = JSON.parse(tc.function?.arguments || '{}');
          } catch {}
          content.push({ type: 'tool_use', id: tc.id, name: tc.function.name, input });
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: data.id || msgId(),
          type: 'message',
          role: 'assistant',
          content,
          model: data.model || anth.model,
          stop_reason: mapFinishReason(choice.finish_reason),
          stop_sequence: null,
          usage: scaleUsage(
            {
              input_tokens: data.usage?.prompt_tokens || 0,
              output_tokens: data.usage?.completion_tokens || 0,
              reasoning_tokens: data.usage?.output_tokens_details?.reasoning_tokens || 0,
            },
            anth.model,
          ),
        }),
      );
      return;
    }

    // Streaming response
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
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
      try {
        res.end();
      } catch {}
    } finally {
      clearInterval(pingTimer);
    }
  });

  // Catch raw socket-level errors (ECONNRESET, etc.) that never reach the
  // request handler. Without this, Node defaults to destroying the socket
  // silently, but the async request handler may still reject unhandled.
  server.on('clientError', (err, socket) => {
    if (process.env.LOG) console.error('clientError:', err.code || err.message);
    if (socket.writable && !socket.destroyed) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    } else {
      socket.destroy(err);
    }
  });

  return server;
}

module.exports = { startServer };
