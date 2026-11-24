// A 429 (rate limit) / 503 / 529 (overloaded) response must be retried with
// backoff instead of failing immediately. A Retry-After header is honored; a
// user cancel (abortSignal) stops the wait. Mid-stream drops are NOT retried
// (that's a separate network-retry budget), so a 429 retry can't dupe an answer.
const fs = require('fs'), vm = require('vm'), path = require('path');
function assert(c, m) { if (!c) { console.error('ASSERT FAIL:', m); process.exit(1); } }

// Build a stub Response with a status and optional Retry-After header.
function resp(status, headers) {
  const h = headers || {};
  return {
    status, ok: status >= 200 && status < 300,
    headers: { get: (k) => h[String(k).toLowerCase()] },
    body: { cancel() {} },
    text: async () => '',
  };
}

let calls = 0, script = [];
const scriptedFetch = async () => {
  const r = script[Math.min(calls, script.length - 1)];
  calls++;
  return r;
};

const ctx = {
  Zotero: {
    debug: () => {},
    Prefs: { get: () => undefined },
    getMainWindow: () => ({ setInterval, clearInterval, AbortController }),
    ItemPaneManager: { registerSection() {}, unregisterSection() {} },
    Reader: { registerEventListener() {}, unregisterEventListener() {} },
    PreferencePanes: { register: async () => 'p', unregister() {} },
  },
  AbortController, fetch: scriptedFetch, PathUtils: {}, IOUtils: {},
  console, setTimeout, clearTimeout, setInterval, clearInterval, Math, Date, TextDecoder, TextEncoder,
};
const A = require('./_load').loadInto(ctx);

(async () => {
  // 1) _retryAfterMs: delta-seconds, clamped, and a garbage value → null
  assert(A._retryAfterMs(resp(429, { 'retry-after': '2' })) === 2000, 'retry-after seconds → ms');
  assert(A._retryAfterMs(resp(429, { 'retry-after': '9999' })) === 30000, 'retry-after clamped to 30s');
  assert(A._retryAfterMs(resp(429, {})) === null, 'no header → null');

  // 2) 429 twice then 200 → _fetchLLM retries and returns the 200. Short waits
  //    via a tiny Retry-After so the test is fast.
  calls = 0; script = [resp(429, { 'retry-after': '0' }), resp(429, { 'retry-after': '0' }), resp(200)];
  const t0 = Date.now();
  const r = await A._fetchLLM('https://x/y', { method: 'POST' }, { timeoutMs: 5000, retries: 0 });
  assert(r.status === 200, '429,429,200 → eventually returns 200');
  assert(calls === 3, 'made exactly 3 attempts, got: ' + calls);
  assert(Date.now() - t0 < 4000, 'retried promptly with the small Retry-After');

  // 3) streaming-style call (retries:0) still gets the 429 retry (429 precedes
  //    any stream bytes, so it can't produce a duplicate answer)
  calls = 0; script = [resp(503, { 'retry-after': '0' }), resp(200)];
  const r2 = await A._fetchLLM('https://x/y', { method: 'POST' }, { timeoutMs: 5000, retries: 0 });
  assert(r2.status === 200 && calls === 2, '503 then 200 under retries:0');

  // 4) exhausting the rate-retry budget returns the last 429 (caller then fails)
  calls = 0; script = [resp(429, { 'retry-after': '0' })];
  const r3 = await A._fetchLLM('https://x/y', { method: 'POST' }, { timeoutMs: 5000, retries: 0, rateRetries: 2 });
  assert(r3.status === 429 && calls === 3, 'gives up after rateRetries and returns the 429: calls=' + calls);

  // 5) a cancel during the backoff wait aborts instead of sleeping it out
  calls = 0; script = [resp(429, { 'retry-after': '1' }), resp(200)];
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  let cancelled = false;
  try { await A._fetchLLM('https://x/y', { method: 'POST' }, { timeoutMs: 5000, retries: 0, abortSignal: ac.signal }); }
  catch (e) { cancelled = !!(e && e._cancelled); }
  assert(cancelled, 'cancel during backoff rejects with _cancelled');

  console.log('RETRY OK');
  process.exit(0);
})();
