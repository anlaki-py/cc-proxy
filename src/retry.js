'use strict';

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
// Overridable via env so tests can shorten the deadline; 30s in prod.
const RETRY_TOTAL_DEADLINE_MS =
  Number.isFinite(+process.env.CCPROXY_RETRY_DEADLINE_MS) &&
  +process.env.CCPROXY_RETRY_DEADLINE_MS > 0
    ? +process.env.CCPROXY_RETRY_DEADLINE_MS
    : 30000;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504, 529]);
const RETRYABLE_NET_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('aborted'));
    const t = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);
    const onAbort = () => {
      cleanup();
      reject(new Error('aborted'));
    };
    const cleanup = () => {
      clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
    };
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
      if (process.env.LOG)
        console.log(
          `  ↻ retry ${attempt + 1} after ${Math.round(delay)}ms (network: ${e.cause?.code || e.message})`,
        );
      await sleep(delay, signal);
      attempt++;
      continue;
    }
    if (r.ok) return r;
    if (!RETRYABLE_STATUS.has(r.status) || Date.now() - start >= RETRY_TOTAL_DEADLINE_MS) return r;
    // Drain so the connection can be reused for the next attempt.
    try {
      await r.text();
    } catch (_) {}
    const retryAfter = parseRetryAfter(r.headers.get('retry-after'));
    const delay =
      retryAfter ?? Math.min(RETRY_BASE_MS * 2 ** attempt + Math.random() * 100, RETRY_MAX_MS);
    if (process.env.LOG)
      console.log(`  ↻ retry ${attempt + 1} after ${Math.round(delay)}ms (status ${r.status})`);
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

module.exports = {
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  RETRY_TOTAL_DEADLINE_MS,
  RETRYABLE_STATUS,
  RETRYABLE_NET_CODES,
  sleep,
  parseRetryAfter,
  isRetryableNetworkError,
  fetchWithRetry,
  reqAbortSignal,
};
