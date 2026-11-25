// Unit tests for share-agent.js pure helpers + the multimodal tool-result
// shaping in tools.js (the agentShare loop + rendering needs a live Zotero and
// is smoke-tested via the dev bridge, not here).
const { loadInto } = require('./_load');
const ctx = {
  Zotero: { debug() {}, Prefs: { get: () => '', set() {} }, getMainWindow: () => null },
  console, Math, Date, setTimeout, clearTimeout, TextDecoder, TextEncoder,
};
const A = loadInto(ctx);
let fails = 0;
function ok(c, m) { if (!c) { fails++; console.error('  ✗ ' + m); } else console.log('  ✓ ' + m); }
function eq(a, b, m) { ok(JSON.stringify(a) === JSON.stringify(b), m + '  (got ' + JSON.stringify(a) + ')'); }

// ---- _forceSectionId: make the article side-nav anchors deterministic ----
eq(A._forceSectionId('<section id="foo"><h2>T</h2></section>', 'sec3'),
  '<section id="sec3"><h2>T</h2></section>', 'rewrites an existing id');
eq(A._forceSectionId('<section class="x"><h2>T</h2></section>', 'sec0'),
  '<section id="sec0" class="x"><h2>T</h2></section>', 'injects id when absent');
eq(A._forceSectionId('<section>\n<h2>T</h2></section>', 'sec1'),
  '<section id="sec1">\n<h2>T</h2></section>', 'injects id on bare <section>');
ok(A._forceSectionId('not a section', 'sec0') === 'not a section', 'leaves non-section untouched');

// ---- _sectionTitle: pull the heading text for TOC / progress ----
ok(A._sectionTitle('<section id="s1"><h2>方法 <span>总览</span></h2>…</section>') === '方法 总览', 'extracts h2 text, strips inner tags');
ok(A._sectionTitle('<section><h1>封面</h1></section>') === '封面', 'extracts h1');
ok(A._sectionTitle('<section><p>no heading</p></section>', 'fb') === 'fb', 'falls back when no heading');

// ---- _sortedUnits: numeric index order, holes ignored ----
eq(A._sortedUnits({ 2: { title: 'c' }, 0: { title: 'a' }, 10: { title: 'z' }, 1: { title: 'b' } }).map((u) => u.title),
  ['a', 'b', 'c', 'z'], 'sorts units by numeric index (not lexicographic)');
eq(A._sortedUnits({}), [], 'empty units → empty array');

// ---- _shareAgentToolDecls: engine-aware + vision-gated ----
const deckTools = A._shareAgentToolDecls('deck', true).map((t) => t.name);
ok(deckTools.includes('write_unit') && deckTools.includes('finalize'), 'deck tools include write_unit + finalize');
ok(deckTools.includes('render_preview'), 'render_preview offered when vision available');
const noVision = A._shareAgentToolDecls('article', false).map((t) => t.name);
ok(!noVision.includes('render_preview'), 'render_preview withheld when no vision');
ok(A._shareAgentToolDecls('deck', true).find((t) => t.name === 'write_unit').parameters.required.join(',') === 'index,html', 'write_unit requires index + html');
// capability gate: HTML/snapshot (sections but no figures) keeps section +
// write/preview/finalize, drops figure tools
const snapShare = A._shareAgentToolDecls('deck', true, { sections: true, figures: false }).map((t) => t.name);
ok(snapShare.includes('list_sections') && snapShare.includes('read_section'), 'snapshot share keeps section tools (text is readable)');
ok(!snapShare.includes('list_figures') && !snapShare.includes('view_figure'), 'snapshot share drops figure tools (no page geometry)');
ok(snapShare.includes('write_unit') && snapShare.includes('render_preview') && snapShare.includes('finalize'), 'snapshot share keeps write/preview/finalize');
const pdfShare = A._shareAgentToolDecls('deck', true, { sections: true, figures: true }).map((t) => t.name);
ok(pdfShare.includes('list_figures') && pdfShare.includes('view_figure'), 'PDF share keeps figure tools');

// shared _agentTools capability gate (chat agent)
const chatSnap = A._agentTools({ sections: true, figures: false, annotate: false }).map((t) => t.name);
ok(chatSnap.includes('list_sections') && chatSnap.includes('read_section'), 'snapshot chat keeps section tools');
ok(!chatSnap.includes('view_figure') && !chatSnap.includes('list_figures') && !chatSnap.includes('highlight'), 'snapshot chat drops figure/highlight tools');
ok(chatSnap.includes('web_fetch') && chatSnap.includes('lookup_paper'), 'snapshot chat keeps web/scholar tools');
const chatPdf = A._agentTools().map((t) => t.name);
ok(chatPdf.includes('list_sections') && chatPdf.includes('highlight') && chatPdf.includes('view_figure'), 'PDF chat (default) keeps all tools');

// ---- multimodal _pushToolResults: image block in anthropic tool_result ----
const PNG = 'data:image/png;base64,QUJD';
// anthropic: object output → content array with text + image block
let msgs = [];
A._pushToolResults('anthropic', msgs, [{ id: 'tu1', name: 'render_preview', output: { text: '看图', images: [PNG] } }]);
const tr = msgs[0].content[0];
ok(msgs[0].role === 'user' && tr.type === 'tool_result' && tr.tool_use_id === 'tu1', 'anthropic wraps a tool_result for the user turn');
ok(Array.isArray(tr.content) && tr.content[0].type === 'text' && tr.content[0].text === '看图', 'anthropic tool_result carries the text block');
ok(tr.content[1].type === 'image' && tr.content[1].source.type === 'base64' && tr.content[1].source.media_type === 'image/png' && tr.content[1].source.data === 'QUJD', 'anthropic tool_result carries a base64 image block');
// anthropic: plain string output passes through unchanged (existing tools)
msgs = [];
A._pushToolResults('anthropic', msgs, [{ id: 'tu2', name: 'read_section', output: '[]' }]);
ok(msgs[0].content[0].content === '[]', 'anthropic plain-string output unchanged');
// chat: image output degrades to the text part (tool messages are text-only)
msgs = [];
A._pushToolResults('chat', msgs, [{ id: 'tc1', name: 'render_preview', output: { text: '看图', images: [PNG] } }]);
ok(msgs[0].role === 'tool' && msgs[0].content === '看图', 'chat degrades image output to its text part');
// responses: same degrade
msgs = [];
A._pushToolResults('responses', msgs, [{ id: 'rc1', name: 'render_preview', output: { text: '看图', images: [PNG] } }]);
ok(msgs[0].type === 'function_call_output' && msgs[0].output === '看图', 'responses degrades image output to its text part');

// ---- _shareAgentPrompt: engine-aware, coverage + canvas rules present ----
const deckSys = A._shareAgentPrompt('deck', '中文', '（无）', A._deckPreset('broadside'), '', true);
ok(/1920×1080/.test(deckSys) && /render_preview/.test(deckSys), 'deck system prompt pins canvas + mentions render_preview');
ok(/write_unit/.test(deckSys) && /finalize/.test(deckSys) && /覆盖/.test(deckSys), 'deck system prompt documents the write/finalize flow + coverage');
const artSysNoVis = A._shareAgentPrompt('article', '中文', '（无）', null, '', false);
ok(!/render_preview/.test(artSysNoVis.split('没有 render_preview')[0].replace('没有 render_preview', '')) || /不支持看图/.test(artSysNoVis), 'article no-vision prompt notes vision is unavailable');
ok(/secN/.test(A._shareAgentPrompt('article', '中文', '', null, '', true)), 'article prompt tells the model the secN id convention');
// with a figure list, the prompt must push real [[fig:id]] over hand-drawn svg
const sysWithFigs = A._shareAgentPrompt('deck', '中文', '[[fig:3]] 图：架构\n[[fig:7]] 表：结果', A._deckPreset('monochrome'), '', true);
ok(/\[\[fig:<id>\]\]/.test(sysWithFigs) && /不要用 ```svg 去重画/.test(sysWithFigs), 'prompt requires real [[fig:id]] and forbids redrawing paper figures as svg');
ok(sysWithFigs.indexOf('[[fig:3]]') >= 0, 'prompt embeds the available figure list for the model');

console.log('');
if (fails) { console.error(fails + ' FAILED'); process.exit(1); }
console.log('SHARE-AGENT OK');
