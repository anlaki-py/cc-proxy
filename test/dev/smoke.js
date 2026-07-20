// Smoke tests for cc-proxy. Assumes stub-upstream.js is running on 11434
// and the proxy is running on 8082 pointed at http://localhost:11434/v1.
const http = require('http');

const PROXY = { host: 'localhost', port: 8082 };

function req(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request(
      {
        host: PROXY.host,
        port: PROXY.port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      },
    );
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

function reqStream(path, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = http.request(
      {
        host: PROXY.host,
        port: PROXY.port,
        path,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(data),
          ...headers,
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: buf }));
      },
    );
    r.on('error', reject);
    r.write(data);
    r.end();
  });
}

let pass = 0,
  fail = 0;
function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`  PASS ${name}`);
  } else {
    fail++;
    console.log(`  FAIL ${name} ${extra}`);
  }
}

async function main() {
  // T1: gpt-4 context scaling (8k -> 25x) + non-streaming
  console.log('\n[T1] gpt-4 context scaling (non-streaming)');
  {
    const r = await req('/v1/messages', {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    check('status 200', r.status === 200, `got ${r.status} ${r.body.slice(0, 200)}`);
    const j = JSON.parse(r.body);
    const inputScale = j.usage?.input_tokens;
    const outputScale = j.usage?.output_tokens;
    // stub returns prompt_tokens=1000, completion_tokens=500
    // gpt-4 is 8192, ratio = 200000/8192 ~= 24.414 -> Math.ceil(1000*24.414)=24415
    check('input scaled ~24.4x', inputScale === 24415, `got ${inputScale}`);
    check('output scaled ~24.4x', outputScale === 12208, `got ${outputScale}`);
  }

  // T2: claude-3-5-sonnet no scaling (1:1)
  console.log('\n[T2] claude-3-5-sonnet passthrough (no scaling)');
  {
    const r = await req('/v1/messages', {
      model: 'claude-3-5-sonnet',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'hi' }],
    });
    check('status 200', r.status === 200, `got ${r.status}`);
    const j = JSON.parse(r.body);
    check('input passthrough 1000', j.usage?.input_tokens === 1000, `got ${j.usage?.input_tokens}`);
    check(
      'output passthrough 500',
      j.usage?.output_tokens === 500,
      `got ${j.usage?.output_tokens}`,
    );
  }

  // T3: error envelope on 401 (stub force_401)
  console.log('\n[T3] error envelope on 401');
  {
    const r = await req('/v1/messages', {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'force_401' }],
    });
    check('status 401', r.status === 401, `got ${r.status}`);
    const j = JSON.parse(r.body);
    check('type=error', j.type === 'error', `got ${j.type}`);
    check(
      'error.type=authentication_error',
      j.error?.type === 'authentication_error',
      `got ${j.error?.type}`,
    );
    check(
      'has request_id',
      typeof j.request_id === 'string' && j.request_id.startsWith('req_'),
      `got ${j.request_id}`,
    );
    check(
      'error.message has stub msg',
      j.error?.message?.includes('invalid api key'),
      `got ${j.error?.message}`,
    );
  }

  // T4: retry on 503 then 200 (stub 503s first chat call with force_503)
  console.log('\n[T4] retry on 503 then 200');
  {
    const r = await req('/v1/messages', {
      model: 'gpt-4',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'force_503' }],
    });
    check(
      'status 200 after retry',
      r.status === 200,
      `got ${r.status} body=${r.body.slice(0, 200)}`,
    );
    const j = JSON.parse(r.body);
    check('got stub reply', j.content?.[0]?.text === 'stub reply', `got ${j.content?.[0]?.text}`);
  }

  // T5: image base64 passthrough
  console.log('\n[T5] image base64 passthrough');
  {
    const r = await req(
      '/v1/messages',
      {
        model: 'gpt-4o',
        max_tokens: 100,
        messages: [
          {
            role: 'user',
            content: [
              {
                type: 'image',
                source: {
                  type: 'base64',
                  media_type: 'image/png',
                  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNgAAIAAAUAAen63NgAAAAASUVORK5CYII=',
                },
              },
              { type: 'text', text: 'what is this?' },
            ],
          },
        ],
      },
      { 'x-test-capture-upstream': '1' },
    );
    check('status 200', r.status === 200, `got ${r.status} body=${r.body.slice(0, 200)}`);
    // The stub logs what it saw; we can't directly inspect it here, but
    // 200 means the base64 was accepted as a data URL by the stub.
  }

  // T6: image file type -> 400
  console.log('\n[T6] image file type -> 400');
  {
    const r = await req('/v1/messages', {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'file', file_id: 'file_abc123' } },
            { type: 'text', text: 'what is this?' },
          ],
        },
      ],
    });
    check('status 400', r.status === 400, `got ${r.status} body=${r.body.slice(0, 200)}`);
    const j = JSON.parse(r.body);
    check('type=error', j.type === 'error');
    check(
      'error message mentions file source',
      /file source/i.test(j.error?.message || ''),
      `got ${j.error?.message}`,
    );
    check('has request_id', typeof j.request_id === 'string' && j.request_id.startsWith('req_'));
  }

  // T7: image URL with --image-fetch
  // Note: this requires the proxy to be started with IMAGE_FETCH=1
  // We just check the request succeeds (base path goes to stub /img.png)
  console.log('\n[T7] image url passthrough (IMAGE_FETCH off, default)');
  {
    const r = await req('/v1/messages', {
      model: 'gpt-4o',
      max_tokens: 100,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'url', url: 'http://localhost:11434/img.png' } },
            { type: 'text', text: 'what is this?' },
          ],
        },
      ],
    });
    check('status 200', r.status === 200, `got ${r.status} body=${r.body.slice(0, 200)}`);
  }

  // T8: ping keepalive verification (streaming)
  console.log('\n[T8] ping keepalive (streaming)');
  {
    const r = await reqStream('/v1/messages', {
      model: 'gpt-4',
      max_tokens: 100,
      stream: true,
      messages: [{ role: 'user', content: 'hi' }],
    });
    check('status 200', r.status === 200, `got ${r.status} body=${r.body.slice(0, 200)}`);
    const hasPing = r.body.includes('event: ping');
    check('has ping event', hasPing, 'body: ' + r.body.slice(0, 300));
    const hasMessageStart = r.body.includes('message_start');
    check('has message_start', hasMessageStart);
    const hasDone = r.body.includes('message_stop');
    check('has message_stop', hasDone);
    // ping should appear right after message_start (T+0)
    const pingIdx = r.body.indexOf('event: ping');
    const msIdx = r.body.indexOf('message_start');
    check('ping after message_start', pingIdx > msIdx, `ping=${pingIdx} ms=${msIdx}`);
  }

  console.log(`\n=== ${pass} pass, ${fail} fail ===`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
