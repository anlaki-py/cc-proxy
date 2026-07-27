'use strict';

// Integration tests: actually start the proxy server in a child process,
// point it at a local scripted mock upstream, and issue real HTTP requests
// at it. The proxy runs on an ephemeral port and the upstream is a tiny
// stub HTTP server in this same process.
//
// We can't simply require('../lib/proxy') in-process because the file runs
// side effects on import (parses argv, binds a port). We fork a child
// process with a known PORT and wait for it to log "listening on".

const { test } = require('node:test');
const assert = require('node:assert');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const PROXY_BIN = path.join(__dirname, '..', '..', 'bin', 'cc-proxy.js');
const PROXY_DIR = path.join(__dirname, '..', '..');

// Allocate unique ports per test to avoid collisions during parallel runs.
let nextPort = 19000 + Math.floor(Math.random() * 1000);
const allocPort = () => nextPort++;

function startProxy(port, upstreamBase, key, extraEnv = {}, extraArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [PROXY_BIN, '--port', String(port), '--base', upstreamBase, '--key', key, ...extraArgs],
      {
        cwd: PROXY_DIR,
        env: { ...process.env, LOG: '1', ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString();
      if (buf.includes('listening on')) {
        child.stdout.off('data', onData);
        resolve({ child, port, stdout: buf });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', (c) => process.stderr.write(`proxy stderr: ${c}`));
    child.on('exit', (code) => reject(new Error(`proxy exited early with code ${code}: ${buf}`)));
    setTimeout(() => reject(new Error('proxy startup timeout: ' + buf)), 5000);
  });
}

function stopProxy(p) {
  return new Promise((resolve) => {
    if (!p || p.child.killed) return resolve();
    p.child.once('exit', () => resolve());
    p.child.kill('SIGTERM');
    setTimeout(() => p.child.kill('SIGKILL'), 2000);
  });
}

// A scripted upstream: register a sequence of (matcher, response) pairs;
// each request consumes the first matching handler.
function makeUpstream() {
  const handlers = [];
  const server = http.createServer((req, res) => {
    const chunk = [];
    req.on('data', (c) => chunk.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunk).toString();
      const h = handlers.shift();
      if (h) h({ req, body }, res);
      else {
        res.writeHead(500);
        res.end('upstream: no handler registered');
      }
    });
  });
  return {
    server,
    addHandler: (fn) => handlers.push(fn),
    listen: () =>
      new Promise((resolve) =>
        server.listen(0, '127.0.0.1', () => {
          const { port } = server.address();
          resolve({ port, base: `http://127.0.0.1:${port}/v1` });
        }),
      ),
    close: () => new Promise((r) => server.close(r)),
  };
}

function fetch_(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: opts.method || 'GET',
        headers: opts.headers || {},
      },
      (res) => {
        const chunk = [];
        res.on('data', (c) => chunk.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunk).toString(),
          }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

test('HEAD / returns 200', async (t) => {
  const up = makeUpstream();
  const { base } = await up.listen();
  const proxy = await startProxy(allocPort(), base, 'test-key');
  t.after(() => Promise.all([stopProxy(proxy), up.close()]));
  const r = await fetch_(`http://127.0.0.1:${proxy.port}/`, { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(r.headers['content-type'], 'application/json');
});

test('--host binds to the requested IP address', async (t) => {
  const up = makeUpstream();
  const { base } = await up.listen();
  t.after(() => up.close());

  const proxy = await startProxy(allocPort(), base, '', {}, ['--host', '127.0.0.1']);
  t.after(() => stopProxy(proxy));

  assert.match(proxy.stdout, new RegExp(`listening on http://127\\.0\\.0\\.1:${proxy.port}`));
  const r = await fetch_(`http://127.0.0.1:${proxy.port}/health`);
  assert.equal(r.status, 200);
});

test('GET /health returns status: ok', async (t) => {
  const up = makeUpstream();
  const { base } = await up.listen();
  const proxy = await startProxy(allocPort(), base, '');
  t.after(() => Promise.all([stopProxy(proxy), up.close()]));
  const r = await fetch_(`http://127.0.0.1:${proxy.port}/health`);
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.status, 'ok');
  assert.equal(j.upstream, base);
});

test('GET /v1/models passes through to upstream', async (t) => {
  const up = makeUpstream();
  up.addHandler((ctx, res) => {
    assert.equal(ctx.req.url, '/v1/models');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ object: 'list', data: [{ id: 'gpt-4o' }] }));
  });
  const { base } = await up.listen();
  const proxy = await startProxy(allocPort(), base, 'test-key');
  t.after(() => Promise.all([stopProxy(proxy), up.close()]));
  const r = await fetch_(`http://127.0.0.1:${proxy.port}/v1/models`);
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.data[0].id, 'gpt-4o');
});

test('GET /v1/models: 502 when upstream returns non-ok', async (t) => {
  const up = makeUpstream();
  up.addHandler((ctx, res) => {
    res.writeHead(500, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'boom' } }));
  });
  const { base } = await up.listen();
  const proxy = await startProxy(allocPort(), base, 'test-key');
  t.after(() => Promise.all([stopProxy(proxy), up.close()]));
  const r = await fetch_(`http://127.0.0.1:${proxy.port}/v1/models`);
  assert.equal(r.status, 502);
  const j = JSON.parse(r.body);
  assert.equal(j.type, 'error');
  assert.match(j.error.message, /upstream \/models returned 500/);
  assert.match(j.request_id, /^req_/);
});

test('GET /v1/models: 502 when upstream is unreachable', async (t) => {
  // No upstream bound; the proxy's fetch will throw.
  const proxy = await startProxy(allocPort(), 'http://127.0.0.1:1/v1', 'test-key');
  t.after(() => stopProxy(proxy));
  const r = await fetch_(`http://127.0.0.1:${proxy.port}/v1/models`);
  assert.equal(r.status, 502);
  const j = JSON.parse(r.body);
  assert.equal(j.type, 'error');
  assert.match(j.error.message, /upstream \/models fetch failed/);
});

test('POST /v1/messages?beta=true: non-streaming round-trip', async (t) => {
  const up = makeUpstream();
  up.addHandler((ctx, res) => {
    assert.equal(ctx.req.url, '/v1/chat/completions');
    const oaiReq = JSON.parse(ctx.body);
    assert.equal(oaiReq.model, 'gpt-4o');
    assert.equal(oaiReq.stream, false);
    assert.equal(oaiReq.messages[0].role, 'user');
    assert.equal(oaiReq.messages[0].content, 'hello');
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        id: 'cmpl-1',
        model: 'gpt-4o',
        choices: [
          { index: 0, message: { role: 'assistant', content: 'hi back' }, finish_reason: 'stop' },
        ],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    );
  });
  const { base } = await up.listen();
  const proxy = await startProxy(allocPort(), base, 'test-key');
  t.after(() => Promise.all([stopProxy(proxy), up.close()]));
  const anth = {
    model: 'gpt-4o',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hello' }],
  };
  const r = await fetch_(`http://127.0.0.1:${proxy.port}/v1/messages?beta=true`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(anth),
  });
  assert.equal(r.status, 200);
  const j = JSON.parse(r.body);
  assert.equal(j.role, 'assistant');
  assert.equal(j.content[0].text, 'hi back');
  assert.equal(j.stop_reason, 'end_turn');
});

test('POST /v1/messages: streaming SSE round-trip', async (t) => {
  const up = makeUpstream();
  up.addHandler((ctx, res) => {
    const oaiReq = JSON.parse(ctx.body);
    assert.equal(oaiReq.stream, true);
    assert.equal(oaiReq.stream_options.include_usage, true);
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
    res.write('data: {"choices":[{"delta":{"content":" world"}}]}\n\n');
    res.write(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":2}}\n\n',
    );
    res.write('data: [DONE]\n\n');
    res.end();
  });
  const { base } = await up.listen();
  const proxy = await startProxy(allocPort(), base, 'test-key');
  t.after(() => Promise.all([stopProxy(proxy), up.close()]));
  const anth = {
    model: 'gpt-4o',
    max_tokens: 100,
    stream: true,
    messages: [{ role: 'user', content: 'hi' }],
  };
  const r = await fetch_(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(anth),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers['content-type'], /text\/event-stream/);
  // Parse the SSE response: should contain message_start, text deltas, message_stop.
  assert.match(r.body, /event: message_start/);
  assert.match(r.body, /event: content_block_start/);
  assert.match(r.body, /event: content_block_delta/);
  assert.match(r.body, /event: message_delta/);
  assert.match(r.body, /event: message_stop/);
  // And the actual text should appear in the deltas.
  assert.match(r.body, /"hello"/);
  assert.match(r.body, /" world"/);
});

test('POST /v1/messages: 400 on missing model', async (t) => {
  const up = makeUpstream();
  const { base } = await up.listen();
  const proxy = await startProxy(allocPort(), base, '');
  t.after(() => Promise.all([stopProxy(proxy), up.close()]));
  const r = await fetch_(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ max_tokens: 100, messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 400);
  const j = JSON.parse(r.body);
  assert.equal(j.type, 'error');
  assert.equal(j.error.type, 'invalid_request_error');
  assert.match(j.error.message, /model is required/);
});

test('POST /v1/messages: 400 on missing max_tokens', async (t) => {
  const up = makeUpstream();
  const { base } = await up.listen();
  const proxy = await startProxy(allocPort(), base, '');
  t.after(() => Promise.all([stopProxy(proxy), up.close()]));
  const r = await fetch_(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 400);
  const j = JSON.parse(r.body);
  assert.match(j.error.message, /max_tokens is required/);
});

test('POST /v1/messages: 400 on missing messages', async (t) => {
  const up = makeUpstream();
  const { base } = await up.listen();
  const proxy = await startProxy(allocPort(), base, '');
  t.after(() => Promise.all([stopProxy(proxy), up.close()]));
  const r = await fetch_(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'gpt-4o', max_tokens: 100 }),
  });
  assert.equal(r.status, 400);
  const j = JSON.parse(r.body);
  assert.match(j.error.message, /messages is required/);
});

test('POST /v1/messages: 400 on invalid JSON', async (t) => {
  const up = makeUpstream();
  const { base } = await up.listen();
  const proxy = await startProxy(allocPort(), base, '');
  t.after(() => Promise.all([stopProxy(proxy), up.close()]));
  const r = await fetch_(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: 'not json',
  });
  assert.equal(r.status, 400);
  const j = JSON.parse(r.body);
  assert.match(j.error.message, /invalid JSON/);
});

test('POST /v1/messages: 404 on unknown path', async (t) => {
  const up = makeUpstream();
  const { base } = await up.listen();
  const proxy = await startProxy(allocPort(), base, '');
  t.after(() => Promise.all([stopProxy(proxy), up.close()]));
  const r = await fetch_(`http://127.0.0.1:${proxy.port}/v1/nope`, { method: 'POST' });
  assert.equal(r.status, 404);
  const j = JSON.parse(r.body);
  assert.equal(j.type, 'error');
});

test('POST /v1/messages: 502 when upstream is unreachable', async (t) => {
  // Use a real-but-unreachable upstream on a port we don't bind.
  // Shorten the retry deadline so this test fails fast instead of waiting 30s.
  const proxy = await startProxy(allocPort(), 'http://127.0.0.1:1/v1', '', {
    CCPROXY_RETRY_DEADLINE_MS: '1000',
  });
  t.after(() => stopProxy(proxy));
  const anth = {
    model: 'gpt-4o',
    max_tokens: 100,
    messages: [{ role: 'user', content: 'hi' }],
  };
  const r = await fetch_(`http://127.0.0.1:${proxy.port}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(anth),
  });
  assert.equal(r.status, 502);
  const j = JSON.parse(r.body);
  assert.match(j.error.message, /upstream fetch failed/);
});

// ── Port-bump tests ─────────────────────────────────────────────────────────

// Helper: bind a throw-away HTTP server on `port` across all interfaces
// (no host argument → 0.0.0.0), matching the proxy's own listen() call.
// Binding only to 127.0.0.1 does NOT reliably trigger EADDRINUSE on Windows
// when another process later binds 0.0.0.0 on the same port.
function occupyPort(port) {
  return new Promise((resolve, reject) => {
    const s = http.createServer();
    s.listen(port, () => resolve(s));
    s.on('error', reject);
  });
}

// Start a proxy child process and resolve once it prints "listening on".
// Returns { child, stdout, stderr } where stdout/stderr are the *complete*
// buffers accumulated until the process signals readiness.
//
// Key design: stdout and stderr are separate OS-level pipes. On Windows the
// kernel can deliver them in any order relative to each other, so we MUST NOT
// snapshot stderrBuf the instant stdout fires — we'd race the warning message.
// Instead we wait for the 'listening on' line in stdout, then give stderr one
// extra event-loop drain (setImmediate) to flush any data that arrived in the
// same I/O batch but hasn't been emitted to us yet.
function startProxyProcess(port, base, key, extraEnv = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [PROXY_BIN, '--port', String(port), '--base', base, '--key', key],
      {
        cwd: PROXY_DIR,
        env: { ...process.env, LOG: '1', ...extraEnv },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

    let stdoutBuf = '';
    let stderrBuf = '';

    child.stdout.on('data', (c) => {
      stdoutBuf += c.toString();
    });
    child.stderr.on('data', (c) => {
      stderrBuf += c.toString();
    });

    child.on('exit', (code) => {
      reject(new Error(`proxy exited early (${code}): ${stdoutBuf} | ${stderrBuf}`));
    });

    // Poll stdout until the ready banner appears, then drain one more tick so
    // any stderr that arrived in the same syscall batch can be processed.
    const poll = setInterval(() => {
      if (!stdoutBuf.includes('listening on')) return;
      clearInterval(poll);
      clearTimeout(timer);
      // One setImmediate gives libuv time to push any buffered stderr chunks
      // through the stream machinery before we snapshot the buffer.
      setImmediate(() => resolve({ child, stdout: stdoutBuf, stderr: stderrBuf }));
    }, 20);

    const timer = setTimeout(() => {
      clearInterval(poll);
      reject(new Error(`startup timeout: ${stdoutBuf} | ${stderrBuf}`));
    }, 6000);
  });
}

function stopProxyProcess(proxy) {
  return new Promise((r) => {
    proxy.child.once('exit', r);
    proxy.child.kill('SIGTERM');
    setTimeout(() => proxy.child.kill('SIGKILL'), 2000);
  });
}

test('auto-bumps port when preferred port is already in use', async (t) => {
  const up = makeUpstream();
  const { base } = await up.listen();

  const preferred = allocPort();
  const occupier = await occupyPort(preferred);
  t.after(() => Promise.all([up.close(), new Promise((r) => occupier.close(r))]));

  const proxy = await startProxyProcess(preferred, base, '');
  t.after(() => stopProxyProcess(proxy));

  const bumped = preferred + 1;

  // stderr must carry the "port in use, trying" warning.
  assert.match(
    proxy.stderr,
    /port \d+ is already in use, trying \d+/,
    `Expected port-bump warning in stderr; got: ${JSON.stringify(proxy.stderr)}`,
  );

  // stdout must advertise the bumped port.
  assert.match(
    proxy.stdout,
    new RegExp(`listening on http://localhost:${bumped}`),
    `Expected listening on ${bumped}; got: ${proxy.stdout}`,
  );

  // The proxy must actually accept connections on the bumped port.
  const r = await fetch_(`http://127.0.0.1:${bumped}/health`);
  assert.equal(r.status, 200);
  assert.equal(JSON.parse(r.body).status, 'ok');
});

test('cascades through multiple occupied ports', async (t) => {
  const up = makeUpstream();
  const { base } = await up.listen();

  const preferred = allocPort();
  const occupier1 = await occupyPort(preferred);
  const occupier2 = await occupyPort(preferred + 1);
  t.after(() =>
    Promise.all([
      up.close(),
      new Promise((r) => occupier1.close(r)),
      new Promise((r) => occupier2.close(r)),
    ]),
  );

  const proxy = await startProxyProcess(preferred, base, '');
  t.after(() => stopProxyProcess(proxy));

  const finalPort = preferred + 2;

  // stdout must advertise the final port (bumped twice).
  assert.match(
    proxy.stdout,
    new RegExp(`listening on http://localhost:${finalPort}`),
    `Expected listening on ${finalPort}; got: ${proxy.stdout}`,
  );

  // Two bump warnings must be in stderr.
  const warnings = proxy.stderr.match(/port \d+ is already in use, trying \d+/g) || [];
  assert.equal(
    warnings.length,
    2,
    `Expected 2 bump warnings; got: ${JSON.stringify(proxy.stderr)}`,
  );

  const r = await fetch_(`http://127.0.0.1:${finalPort}/health`);
  assert.equal(r.status, 200);
});
