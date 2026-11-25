// Unit tests for capture.js pure helpers (screenshot sizing + review-verdict
// parsing + capture-doc wrappers). The actual HiddenBrowser/drawSnapshot render
// needs a live Zotero and is smoke-tested via the dev bridge, not here.
const { loadInto } = require('./_load');
const ctx = {
  Zotero: { debug() {}, Prefs: { get: () => '', set() {} }, getMainWindow: () => null },
  console, Math, Date, setTimeout, clearTimeout, TextDecoder, TextEncoder,
};
const A = loadInto(ctx);
let fails = 0;
function ok(c, m) { if (!c) { fails++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + '  (got ' + JSON.stringify(a) + ')'); }

// ---- _fitEdge: downscale to a max long edge, keep aspect ----
eq(A._fitEdge(1920, 1080, 1536), { w: 1536, h: 864, scale: 1536 / 1920 }, '_fitEdge downscales 1920→1536 long edge');
eq(A._fitEdge(800, 600, 1536), { w: 800, h: 600, scale: 1 }, '_fitEdge no-op when within max');
eq(A._fitEdge(1040, 1800, 1536), { w: Math.round(1040 * 1536 / 1800), h: 1536, scale: 1536 / 1800 }, '_fitEdge clamps tall article tile');

// ---- _parseReviewVerdict: tolerant JSON ----
eq(A._parseReviewVerdict('{"ok":true}'), { ok: true, issue: '', fix: '' }, 'verdict ok:true');
eq(A._parseReviewVerdict('```json\n{"ok":false,"issue":"图太大","fix":"限高"}\n```'), { ok: false, issue: '图太大', fix: '限高' }, 'verdict strips ``` fence');
eq(A._parseReviewVerdict('前缀 {"ok":false,"issue":"a","fix":"b"} 尾'), { ok: false, issue: 'a', fix: 'b' }, 'verdict extracts embedded JSON');
ok(A._parseReviewVerdict('完全不是json').ok === true, 'unparseable verdict defaults to ok (no loop)');

// ---- _visualReviewPrompt ----
ok(/1920×1080/.test(A._visualReviewPrompt('deck')), 'deck review prompt mentions the 1920×1080 canvas');
ok(/\{"ok":true\}/.test(A._visualReviewPrompt('article')), 'review prompt demands strict JSON');

// ---- capture-doc wrappers embed the shared CSS + the unit fragment ----
const deckDoc = A._deckSlideCaptureHtml('<section class="slide"><h1>T</h1></section>', ':root{--bg:#111}', 'https://fonts/x');
ok(/<deck-stage>/.test(deckDoc) && /<section class="slide">/.test(deckDoc), 'deck capture doc wraps the slide in deck-stage');
ok(/max-height:640px/.test(deckDoc), 'deck capture doc carries the figure img clamp from _deckBaseCss');
ok(/width:1920px;height:1080px/.test(deckDoc), 'deck capture doc pins the 1920×1080 static frame');
ok(/fonts\/x/.test(deckDoc), 'deck capture doc keeps the preset font link');

const artDoc = A._articleSectionCaptureHtml('<section id="s1"><h2>Intro</h2></section>');
ok(/cap-wrap/.test(artDoc) && /<section id="s1">/.test(artDoc), 'article capture doc wraps the section');
ok(/\.paper-fig img\{display:block;max-width:100%/.test(artDoc) || /max-width:100%;height:auto/.test(artDoc), 'article capture doc carries _shareBaseCss img rules');

console.log('');
if (fails) { console.error(fails + ' FAILED'); process.exit(1); }
console.log('CAPTURE OK');
