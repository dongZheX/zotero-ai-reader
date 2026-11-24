// Temperature is opt-in: omitted from the request unless the user set a value.
// Covers both body builders (_bodyFor, _toolBody) across all three formats.
const fs = require('fs'), vm = require('vm'), path = require('path');
function assert(c, m) { if (!c) { console.error('ASSERT FAIL:', m); process.exit(1); } }

const prefs = { 'aireader.model': 'gpt-5', 'aireader.maxTokens': '0', 'aireader.temperature': '' };
const ctx = {
  Zotero: {
    debug: () => {},
    Prefs: { get: (k) => prefs[k] },
    getMainWindow: () => null,
    ItemPaneManager: { registerSection() {}, unregisterSection() {} },
    Reader: { registerEventListener() {}, unregisterEventListener() {} },
    PreferencePanes: { register: async () => 'p', unregister() {} },
  },
  PathUtils: {}, IOUtils: {}, console, setTimeout, TextDecoder, TextEncoder,
};
const A = require('./_load').loadInto(ctx);

const msgs = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }];
const bodies = (fmt) => [JSON.parse(A._bodyFor(fmt, msgs, false)), JSON.parse(A._toolBody(fmt, msgs, [], false))];

// 1) blank temperature → field omitted in every format / builder
for (const v of ['', '   ', 'abc']) {
  prefs['aireader.temperature'] = v;
  for (const fmt of ['responses', 'chat', 'anthropic']) {
    for (const b of bodies(fmt)) {
      assert(!('temperature' in b), `temperature omitted when pref=${JSON.stringify(v)} fmt=${fmt}`);
    }
  }
}

// 2) explicit numeric temperature → field sent with that value
prefs['aireader.temperature'] = '0.7';
for (const fmt of ['responses', 'chat', 'anthropic']) {
  for (const b of bodies(fmt)) {
    assert(b.temperature === 0.7, `temperature=0.7 sent fmt=${fmt}`);
  }
}

// 3) explicit 0 is a real value (not "unset")
prefs['aireader.temperature'] = '0';
for (const fmt of ['responses', 'chat', 'anthropic']) {
  for (const b of bodies(fmt)) {
    assert(b.temperature === 0, `temperature=0 sent fmt=${fmt}`);
  }
}

console.log('TEMPERATURE OK');
