// Focused test for snapshot/HTML citation navigation (no SDT fixture needed).
// Loads content/aireader.js in a vm with minimal stubs and asserts:
//   - _searchAnchor collapses whitespace and caps to a word-boundary anchor.
//   - navigateTo on a PDF block opens the reader at its geometric position.
//   - navigateTo on a positionless (snapshot) block jumps via the PUBLIC
//     reader.navigate({position: TextPositionSelector}).
//   - _textPositionFor computes correct offsets (exact + whitespace-insensitive).
//   - _readerContentDoc resolves the rendered document defensively.
const fs = require('fs'), vm = require('vm'), path = require('path');
function assert(c, m) { if (!c) { console.error('ASSERT FAIL:', m); process.exit(1); } }

// The snapshot content the mock reader "renders". navigateTo locates the query
// in this text and navigates to its character offset.
const DOC_TEXT = 'intro. hello world body. then derived anchor here. then legacy cached block body. then just some text here. end.';
let opened = null, navs = [];
// Mock reader shaped like Zotero 7's public surface: navigate(location) is the
// public jump API; the rendered doc is at _internalReader._primaryView._iframeDocument.
const mkReader = () => ({
  _initPromise: Promise.resolve(),
  _window: { setTimeout: () => {} },
  _internalReader: { _primaryView: { _iframeDocument: { body: { textContent: DOC_TEXT } } } },
  navigate: (loc) => { navs.push(loc); },
});
const ctx = {
  Zotero: {
    debug: () => {},
    Prefs: { get: () => undefined },
    getMainWindow: () => ({ setTimeout: () => {} }),
    Reader: {
      open: async (id, loc) => { opened = { id, loc }; return mkReader(); },
      registerEventListener() {}, unregisterEventListener() {},
    },
    ItemPaneManager: { registerSection() {}, unregisterSection() {} },
    PreferencePanes: { register: async () => 'p', unregister() {} },
  },
  PathUtils: { join: (...a) => a.join('/'), parent: (p) => p },
  IOUtils: { async exists() { return false; }, async readUTF8() { return ''; } },
  console, setTimeout, TextDecoder, TextEncoder,
};
ctx.AIReader = undefined;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'content', 'aireader.js'), 'utf8'), ctx, { filename: 'aireader.js' });
const A = ctx.AIReader;

// helper: a navigate() call's selector must resolve to `want` in DOC_TEXT
function navHits(nav, want) {
  const p = nav && nav.position;
  return p && p.type === 'TextPositionSelector' && DOC_TEXT.slice(p.start, p.end) === want;
}

// 1) _searchAnchor
assert(A._searchAnchor('  hello   world  ') === 'hello world', 'anchor collapses whitespace');
assert(A._searchAnchor('') === '', 'anchor empty');
const longTxt = 'The quick brown fox jumps over the lazy dog and then keeps running across the entire meadow without stopping once';
const anc = A._searchAnchor(longTxt);
assert(anc.length <= 80 && anc.length > 40, 'anchor capped near 80 chars: ' + anc.length);
assert(!/\s$/.test(anc) && longTxt.startsWith(anc), 'anchor is a clean word-boundary prefix');

// 2) _textPositionFor — exact match
let sel = A._textPositionFor({ textContent: 'abc HELLO xyz' }, 'HELLO');
assert(sel && sel.type === 'TextPositionSelector' && sel.start === 4 && sel.end === 9, 'textPosition exact match');
// whitespace-insensitive: query spacing differs from the raw DOM spacing
sel = A._textPositionFor({ textContent: 'a  b\n c d' }, 'b c');
assert(sel && 'a  b\n c d'.slice(sel.start, sel.end).replace(/\s+/g, ' ') === 'b c', 'textPosition whitespace-insensitive');
// not found → null
assert(A._textPositionFor({ textContent: 'nothing here' }, 'absent') === null, 'textPosition missing → null');
assert(A._textPositionFor({ textContent: '' }, 'x') === null, 'textPosition empty body → null');

// 3) _readerContentDoc — primaryView path and nested-iframe fallback
const d1 = { body: { textContent: 'x' } };
assert(A._readerContentDoc({ _internalReader: { _primaryView: { _iframeDocument: d1 } } }) === d1, 'contentDoc via primaryView');
const d2 = { body: { textContent: 'y' } };
const r2 = { _iframeWindow: { document: { querySelector: (s) => s === 'iframe' ? { contentDocument: d2 } : null } } };
assert(A._readerContentDoc(r2) === d2, 'contentDoc via nested iframe fallback');
assert(A._readerContentDoc({}) === null, 'contentDoc none → null');

(async () => {
  // 4) PDF block → geometric position open, no navigate()
  opened = null; navs = [];
  await A.navigateTo(7, { position: { pageIndex: 2, rects: [[1, 2, 3, 4]] }, pageLabel: '3' });
  assert(opened && opened.id === 7 && opened.loc && opened.loc.position, 'pdf block opens at position');
  assert(navs.length === 0, 'pdf block does not use navigate()');

  // 5) anchor block (snapshot) → open + navigate(TextPositionSelector) to its query
  opened = null; navs = [];
  await A.navigateTo(9, { position: null, anchor: true, query: 'hello world', text: 'hello world body', pageLabel: '' });
  assert(opened && opened.id === 9 && !opened.loc, 'anchor block opens reader without a position');
  assert(navs.length >= 1 && navHits(navs[0], 'hello world'), 'anchor block navigates to its query offset');

  // 6) no stored query → derives anchor from text
  opened = null; navs = [];
  await A.navigateTo(11, { position: null, anchor: true, text: '  derived   anchor here ', pageLabel: '' });
  assert(navs.length >= 1 && navHits(navs[0], 'derived anchor here'), 'navigates to derived anchor');

  // 7) positionless block with query but NO anchor flag (older cached block)
  opened = null; navs = [];
  await A.navigateTo(13, { position: null, query: 'legacy cached block', text: 'legacy cached block body', pageLabel: '' });
  assert(opened && opened.id === 13 && navs.length >= 1 && navHits(navs[0], 'legacy cached block'), 'anchorless cached block still navigates');

  // 8) positionless block with only text
  opened = null; navs = [];
  await A.navigateTo(15, { position: null, text: '  just   some  text  here ', pageLabel: '' });
  assert(navs.length >= 1 && navHits(navs[0], 'just some text here'), 'text-only block navigates via derived query');

  // 9) block with neither position nor text → safe no-op
  opened = null; navs = [];
  await A.navigateTo(17, { position: null, text: '', pageLabel: '' });
  assert(navs.length === 0, 'empty block is a safe no-op');

  // 10) BLOCK_CACHE_VERSION bumped so stale caches re-extract
  assert(typeof A.BLOCK_CACHE_VERSION === 'number' && A.BLOCK_CACHE_VERSION >= 4, 'block cache version bumped');

  console.log('SNAPSHOT OK');
})();
