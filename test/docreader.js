// Unit tests for the per-document capability strategy (content/docreader.js):
// Factory picks a kind from contentType; PDF delegates to geometry primitives;
// position-less kinds are Null Objects (renderRegion→null, annotate→throws,
// figuresIn→[]). One source of truth for "what can we do with this doc?".
const { loadInto } = require('./_load');
const ctx = {
  Zotero: { debug() {}, Prefs: { get: () => '', set() {} }, getMainWindow: () => null },
  console, Math, Date, setTimeout, clearTimeout, TextDecoder, TextEncoder,
};
const A = loadInto(ctx);
// stub the PDF geometry primitives so we can see the PDF strategy delegate
let rendered = null, annotated = null;
A.renderRegionDataURI = async (att, b) => { rendered = b.id; return 'data:image/png;base64,ZZ'; };
A.applyAnnotation = async (att, b) => { annotated = b.id; return { key: 'K' + b.id }; };

let fails = 0;
function ok(c, m) { if (!c) { fails++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); }

const mk = (ct) => ({ key: 'k-' + ct, attachmentContentType: ct });

// ---- Factory: contentType → kind ----
ok(A._docKind(mk('application/pdf')) === 'pdf', 'application/pdf → pdf');
ok(A._docKind(mk('text/html')) === 'html', 'text/html → html');
ok(A._docKind(mk('application/xhtml+xml')) === 'html', 'xhtml → html');
ok(A._docKind(mk('application/epub+zip')) === 'epub', 'epub+zip → epub');
ok(A._docKind(mk('text/plain')) === 'text', 'text/plain → text');
ok(A._docKind(null) === 'text', 'null attachment → text (safe default)');

// ---- caps ----
const pdfCaps = A._docCaps(mk('application/pdf'));
ok(pdfCaps.regions && pdfCaps.annotate && pdfCaps.navigate === 'position', 'PDF caps: regions + annotate + position nav');
const htmlCaps = A._docCaps(mk('text/html'));
ok(htmlCaps.text && !htmlCaps.regions && !htmlCaps.annotate && htmlCaps.navigate === 'anchor', 'HTML caps: text only, anchor nav, no regions/annotate');
ok(A._docCaps(mk('application/epub+zip')).navigate === 'anchor', 'EPUB navigates by anchor');
ok(A._docCaps(mk('text/plain')).navigate === 'none', 'plain text has no navigation');

// ---- PDF strategy delegates to the geometry primitives ----
(async () => {
  const pdf = A._docReader(mk('application/pdf'));
  const uri = await pdf.renderRegion({}, { id: 7 });
  ok(uri === 'data:image/png;base64,ZZ' && rendered === 7, 'PDF renderRegion delegates to renderRegionDataURI');
  const ann = await pdf.annotate({}, { id: 9 }, {});
  ok(ann.key === 'K9' && annotated === 9, 'PDF annotate delegates to applyAnnotation');
  ok(pdf.figuresIn([{ id: 1, type: 'image', position: {} }, { id: 2, type: 'paragraph', position: {} }, { id: 3, type: 'table' }]).map((f) => f.id).join(',') === '1', 'PDF figuresIn keeps positioned image/table only');

  // ---- Null Object for position-less kinds ----
  const html = A._docReader(mk('text/html'));
  ok((await html.renderRegion({}, { id: 1 })) === null, 'HTML renderRegion → null (Null Object)');
  ok(html.figuresIn([{ id: 1, type: 'image' }]).length === 0, 'HTML figuresIn → [] (Null Object)');
  let threw = false;
  try { await html.annotate({}, { id: 1 }, {}); } catch (e) { threw = true; }
  ok(threw, 'HTML annotate throws a clear unsupported error (Null Object)');

  // ---- Factory caches per key ----
  ok(A._docReader(mk('application/pdf')) === A._docReader(mk('application/pdf')), 'reader cached per attachment key');

  console.log('');
  if (fails) { console.error(fails + ' FAILED'); process.exit(1); }
  console.log('DOCREADER OK');
})();
