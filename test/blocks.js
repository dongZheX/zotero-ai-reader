// Unit tests for block structuring on position-less docs (HTML / web snapshots).
// HTML snapshots have no page geometry; these assert that sections + headings
// still form so list_sections / read_section work on them (the bug: 0 sections).
const { loadInto } = require('./_load');
const ctx = {
  Zotero: { debug() {}, Prefs: { get: () => '', set() {} }, getMainWindow: () => null },
  console, Math, Date, setTimeout, clearTimeout, TextDecoder, TextEncoder,
};
const A = loadInto(ctx);
let fails = 0;
function ok(c, m) { if (!c) { fails++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); }

// ---- _looksLikeHeading ----
ok(A._looksLikeHeading('3 Method'), 'numbered heading "3 Method"');
ok(A._looksLikeHeading('3.1.2 Experimental Setup'), 'nested numbered heading');
ok(A._looksLikeHeading('Introduction'), 'section-word heading "Introduction"');
ok(A._looksLikeHeading('相关工作'), 'Chinese section word 相关工作');
ok(A._looksLikeHeading('Results'), 'bare section word "Results" is a heading');
ok(!A._looksLikeHeading('We introduce a new benchmark that spans four categories.'), 'a sentence is not a heading');
ok(!A._looksLikeHeading('The method, in short, works.'), 'clause ending in period not a heading');
ok(!A._looksLikeHeading('This is a reasonably long line of running prose that clearly is body text and exceeds the length'), 'long line not a heading');
ok(!A._looksLikeHeading('Results show that the model improves on prior work'), 'sentence merely starting with a section word is NOT a heading');
ok(!A._looksLikeHeading('3 people were tested in the study'), 'number + lowercase word is not a numbered heading');

// ---- _buildSections keeps position-less text blocks + splits on headings ----
const snap = [
  { id: 0, type: 'heading', text: 'Introduction', position: null },
  { id: 1, type: 'paragraph', text: 'We study phone-use agents.', position: null },
  { id: 2, type: 'paragraph', text: 'Prior work is limited.', position: null },
  { id: 3, type: 'heading', text: '3 Benchmark Categories', position: null },
  { id: 4, type: 'paragraph', text: 'There are four categories.', position: null },
  { id: 5, type: 'image', text: 'fig', position: null },
];
const secs = A._buildSections(snap);
ok(secs.length === 2, 'position-less snapshot yields 2 sections (got ' + secs.length + ')');
ok(secs[0].title === 'Introduction' && secs[0].blockIds.length === 2, 'first section groups its 2 paragraphs');
ok(secs[1].title === '3 Benchmark Categories' && secs[1].blockIds.join(',') === '4', 'second section has the one paragraph (image skipped)');

// headingless position-less blocks still make a 前言/摘要 section (not 0)
const flat = [ { id: 0, type: 'paragraph', text: 'a', position: null }, { id: 1, type: 'paragraph', text: 'b', position: null } ];
const fsec = A._buildSections(flat);
ok(fsec.length === 1 && fsec[0].blockIds.length === 2, 'headingless snapshot still yields one readable section (not 0)');

// PDF blocks (with position) unchanged
const pdf = [ { id: 0, type: 'heading', text: 'H', position: { pageIndex: 0, rects: [[0, 0, 1, 1]] } }, { id: 1, type: 'paragraph', text: 'p', position: { pageIndex: 0, rects: [[0, 0, 1, 1]] } } ];
ok(A._buildSections(pdf).length === 1, 'positioned PDF blocks still section normally');

console.log('');
if (fails) { console.error(fails + ' FAILED'); process.exit(1); }
console.log('BLOCKS OK');
