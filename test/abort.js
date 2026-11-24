// The Stop button must cancel even a hung request (connection open, no bytes).
// _abortGuard bridges a shouldStop() flag to a real AbortController by polling;
// _fetchLLM forwards that signal so a stalled fetch is actually aborted.
const fs = require('fs'), vm = require('vm'), path = require('path');
function assert(c, m) { if (!c) { console.error('ASSERT FAIL:', m); process.exit(1); } }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const mkAbort = () => Object.assign(new Error('aborted'), { name: 'AbortError' });

// A fetch that simulates a stalled server: never resolves on its own; only
// rejects when its AbortSignal fires. If Stop can't abort, this hangs forever.
const hangingFetch = (url, opts) => new Promise((_res, rej) => {
  const s = opts && opts.signal;
  if (!s) return; // hang forever
  if (s.aborted) return rej(mkAbort());
  s.addEventListener('abort', () => rej(mkAbort()), { once: true });
});

const ctx = {
  Zotero: {
    debug: () => {},
    Prefs: { get: () => undefined },
    getMainWindow: () => ({ setInterval, clearInterval }),
    ItemPaneManager: { registerSection() {}, unregisterSection() {} },
    Reader: { registerEventListener() {}, unregisterEventListener() {} },
    PreferencePanes: { register: async () => 'p', unregister() {} },
  },
  AbortController, fetch: hangingFetch, PathUtils: {}, IOUtils: {},
  console, setTimeout, setInterval, clearInterval, TextDecoder, TextEncoder,
};
const A = require('./_load').loadInto(ctx);

(async () => {
  // 1) guard signal starts open, aborts when shouldStop() flips, dispose() stops poller
  let stop = false;
  const g = A._abortGuard(() => stop);
  assert(g.signal && g.signal.aborted === false, 'guard signal starts un-aborted');
  stop = true;
  await sleep(400);
  assert(g.signal.aborted === true, 'guard aborts when shouldStop() becomes true');
  g.dispose();

  const g2 = A._abortGuard(() => false);
  await sleep(250);
  assert(g2.signal.aborted === false, 'guard without stop stays open');
  g2.dispose();

  // 2) THE BUG: a hung fetch must be cancellable. Flip the flag after 300ms and
  //    assert _fetchLLM rejects promptly instead of hanging on the 600s timeout.
  let stop2 = false;
  setTimeout(() => { stop2 = true; }, 300);
  const guard = A._abortGuard(() => stop2);
  const t0 = Date.now();
  let threw = false, elapsed = 0;
  try {
    await A._fetchLLM('https://stalled.example/stream', { method: 'GET' }, { timeoutMs: 600000, retries: 0, abortSignal: guard.signal });
  } catch (e) { threw = true; }
  elapsed = Date.now() - t0;
  guard.dispose();
  assert(threw, 'hung fetch rejects once Stop flips');
  assert(elapsed < 2000, 'hung fetch is aborted promptly (not after the 600s ceiling): ' + elapsed + 'ms');

  // 3) already-aborted signal → immediate rejection, no retries waited out
  const ac = new AbortController(); ac.abort();
  const t1 = Date.now(); let threw2 = false;
  try { await A._fetchLLM('https://x/y', { method: 'GET' }, { timeoutMs: 600000, retries: 2, abortSignal: ac.signal }); }
  catch (e) { threw2 = true; }
  assert(threw2 && (Date.now() - t1) < 1000, 'pre-aborted signal rejects immediately without retrying');

  console.log('ABORT OK');
  process.exit(0); // defensive: don't let any stray timer keep the test alive
})();
