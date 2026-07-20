// All-in-one stub upstream for testing cc-proxy.
// Endpoints:
//   POST /chat/completions        — chat
//   GET  /img.png                 — small image used by --image-fetch test
const http = require('http');
const fs = require('fs');
const path = require('path');

// Counters to drive retry behavior per-path
const state = {
  chatCalls: 0, // 503 the first time
  fetchCalls: 0, // always 200, used to test image-fetch
  // Map of request-body signature -> how many times we've 503'd it (for retry tests)
  force503Calls: new Map(),
};

const server = http.createServer((req, res) => {
  if (req.method === 'GET' && req.url === '/img.png') {
    // 1x1 transparent PNG
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
      'base64',
    );
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': png.length });
    res.end(png);
    return;
  }

  if (req.method === 'POST' && req.url === '/v1/chat/completions') {
    state.chatCalls++;
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      console.log('--- upstream saw (call #' + state.chatCalls + ') ---');
      console.log(body);
      // 503 either on first chat call, or when explicitly requested via
      // body content (fail once per unique body, then succeed on retry).
      let want503 = false;
      if (state.chatCalls === 1 && (body.includes('"force_503"') || req.headers['x-test-503'])) {
        want503 = true;
      } else if (body.includes('"force_503"')) {
        // Use a small body signature so retries of the same request 503 once.
        const sig = body.length + ':' + body.slice(0, 64);
        const n = (state.force503Calls.get(sig) || 0) + 1;
        state.force503Calls.set(sig, n);
        want503 = n === 1; // only first attempt for this body
      }
      if (want503) {
        res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '0' });
        res.end(
          JSON.stringify({
            error: { message: 'service unavailable (test)', type: 'server_error' },
          }),
        );
        return;
      }
      // 401 to test error envelope
      if (body.includes('"force_401"')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ error: { message: 'invalid api key (test)', code: 'invalid_api_key' } }),
        );
        return;
      }

      const req2 = JSON.parse(body);
      const wantStream = req2.stream === true;
      res.writeHead(200, { 'content-type': 'text/event-stream' });

      if (!wantStream) {
        res.end(
          JSON.stringify({
            id: 'stub',
            object: 'chat.completion',
            model: req2.model,
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: 'stub reply' },
                finish_reason: 'stop',
              },
            ],
            usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
          }),
        );
        return;
      }

      const w = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      // Slight delay so the ping at T+0 has time to flush before the first chunk.
      setTimeout(() => {
        w({ id: 's', choices: [{ index: 0, delta: { role: 'assistant', content: 'hello ' } }] });
        w({ id: 's', choices: [{ index: 0, delta: { content: 'world' } }] });
        w({ id: 's', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        w({
          id: 's',
          choices: [],
          usage: { prompt_tokens: 1000, completion_tokens: 500, total_tokens: 1500 },
        });
        res.write('data: [DONE]\n\n');
        res.end();
      }, 200);
    });
    return;
  }

  res.writeHead(404).end();
});

server.listen(11434, () => console.log('stub on 11434'));
