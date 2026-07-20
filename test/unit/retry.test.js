'use strict';

// Retries in this suite use real wall-clock sleeps. The default 30s deadline
// would make the "returns last retryable response after deadline" test block
// for ~30s. Set a 1s deadline BEFORE loading src/retry.js — the constant is
// captured at require time, so the order matters here.
process.env.CCPROXY_RETRY_DEADLINE_MS = process.env.CCPROXY_RETRY_DEADLINE_MS || '1000';

const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { fetchWithRetry, isRetryableNetworkError, parseRetryAfter } = require('../../src/retry.js');

// Spin up a tiny scripted HTTP server that returns a sequence of responses.
// Each test sets up its own.
function startScriptedServer(script) {
  return new Promise((resolve) => {
    let callIndex = 0;
    const server = http.createServer((req, res) => {
      const chunk = [];
      req.on('data', (c) => chunk.push(c));
      req.on('end', () => {
        const i = callIndex++;
        const handler = script[i] || script[script.length - 1];
        handler(req, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ port, server, callCount: () => callIndex });
    });
  });
}

function closeServer(server) {
  return new Promise((r) => server.close(r));
}

test('fetchWithRetry: succeeds on first try', async () => {
  const { port, server } = await startScriptedServer([
    (req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":1}');
    },
  ]);
  try {
    const r = await fetchWithRetry(`http://127.0.0.1:${port}/x`, {});
    assert.equal(r.status, 200);
    assert.equal(await r.json().then((d) => d.ok), 1);
  } finally {
    await closeServer(server);
  }
});

test('fetchWithRetry: retries on 429 then succeeds', async () => {
  const { port, server, callCount } = await startScriptedServer([
    (req, res) => {
      res.writeHead(429);
      res.end();
    },
    (req, res) => {
      res.writeHead(200);
      res.end('{"ok":1}');
    },
  ]);
  try {
    const r = await fetchWithRetry(`http://127.0.0.1:${port}/x`, {});
    assert.equal(r.status, 200);
    assert.equal(callCount(), 2);
  } finally {
    await closeServer(server);
  }
});

test('fetchWithRetry: retries on 502/503/504/529', async () => {
  for (const status of [502, 503, 504, 529]) {
    const { port, server, callCount } = await startScriptedServer([
      (req, res) => {
        res.writeHead(status);
        res.end();
      },
      (req, res) => {
        res.writeHead(200);
        res.end('{}');
      },
    ]);
    try {
      const r = await fetchWithRetry(`http://127.0.0.1:${port}/x`, {});
      assert.equal(r.status, 200, `status ${status} should be retried`);
      assert.equal(callCount(), 2, `status ${status} should be retried once`);
    } finally {
      await closeServer(server);
    }
  }
});

test('fetchWithRetry: does not retry on 400', async () => {
  const { port, server, callCount } = await startScriptedServer([
    (req, res) => {
      res.writeHead(400);
      res.end('{"err":1}');
    },
  ]);
  try {
    const r = await fetchWithRetry(`http://127.0.0.1:${port}/x`, {});
    assert.equal(r.status, 400);
    assert.equal(callCount(), 1);
  } finally {
    await closeServer(server);
  }
});

test('fetchWithRetry: honors Retry-After numeric', async () => {
  const { port, server, callCount } = await startScriptedServer([
    (req, res) => {
      res.writeHead(429, { 'retry-after': '1' });
      res.end();
    },
    (req, res) => {
      res.writeHead(200);
      res.end('{}');
    },
  ]);
  try {
    const start = Date.now();
    const r = await fetchWithRetry(`http://127.0.0.1:${port}/x`, {});
    const elapsed = Date.now() - start;
    assert.equal(r.status, 200);
    assert.equal(callCount(), 2);
    // Should wait roughly 1 second (capped at RETRY_MAX_MS = 4000)
    assert.ok(elapsed >= 900, `elapsed ${elapsed}ms should be >= 900ms`);
  } finally {
    await closeServer(server);
  }
});

test('fetchWithRetry: returns last retryable response after deadline', async () => {
  // The 1s deadline set at file load (top of retry.test.js) means this test
  // gives up after ~1s of 503s rather than the 30s prod default. With 250ms
  // base + exponential delay, we expect ~3-4 attempts before the deadline
  // cuts it off.
  const { port, server, callCount } = await startScriptedServer(
    Array(20).fill((req, res) => {
      res.writeHead(503);
      res.end();
    }),
  );
  try {
    const r = await fetchWithRetry(`http://127.0.0.1:${port}/x`, {});
    assert.equal(r.status, 503);
    assert.ok(callCount() >= 2);
  } finally {
    await closeServer(server);
  }
});

test('isRetryableNetworkError: AbortError is not retryable', () => {
  const e = new Error('aborted');
  e.name = 'AbortError';
  assert.equal(isRetryableNetworkError(e), false);
});

test('isRetryableNetworkError: ECONNRESET is retryable', () => {
  const e = new Error('boom');
  e.cause = { code: 'ECONNRESET' };
  assert.equal(isRetryableNetworkError(e), true);
});

test('isRetryableNetworkError: ETIMEDOUT is retryable', () => {
  const e = new Error('boom');
  e.cause = { code: 'ETIMEDOUT' };
  assert.equal(isRetryableNetworkError(e), true);
});

test('isRetryableNetworkError: random code is not retryable', () => {
  const e = new Error('boom');
  e.cause = { code: 'ENOENT' };
  assert.equal(isRetryableNetworkError(e), false);
});

test('isRetryableNetworkError: "fetch failed" message is retryable', () => {
  const e = new Error('fetch failed');
  assert.equal(isRetryableNetworkError(e), true);
});

test('parseRetryAfter: numeric seconds → ms', () => {
  assert.equal(parseRetryAfter('2'), 2000);
});

test('parseRetryAfter: numeric capped at RETRY_MAX_MS (4000)', () => {
  assert.equal(parseRetryAfter('100'), 4000);
});

test('parseRetryAfter: HTTP-date in the past → 0', () => {
  const past = new Date(Date.now() - 10000).toUTCString();
  assert.equal(parseRetryAfter(past), 0);
});

test('parseRetryAfter: HTTP-date in the future → ms until that time', () => {
  const future = new Date(Date.now() + 5000).toUTCString();
  const v = parseRetryAfter(future);
  assert.ok(v >= 4000 && v <= 5000);
});

test('parseRetryAfter: null/garbage → null', () => {
  assert.equal(parseRetryAfter(null), null);
  assert.equal(parseRetryAfter('not a date or number'), null);
});
