// HTML share: multi-theme system (content theme-agnostic) + authoritative paper
// info card from Zotero item fields. Content-generation prompts are unchanged.
const fs = require('fs'), vm = require('vm'), path = require('path');
function assert(c, m) { if (!c) { console.error('ASSERT FAIL:', m); process.exit(1); } }

// A stub Zotero item exposing getField/getCreators like the real one.
const item = {
  isAttachment: () => false,
  getField: (f) => ({
    title: 'Phone Use Agent: A Benchmark',
    date: '2026-05-01',
    publicationTitle: 'NeurIPS',
    DOI: '10.1234/abcd.5678',
    url: 'https://arxiv.org/abs/2511.01234',
    extra: 'arXiv:2511.01234',
    abstractNote: 'We present a reproducible benchmark and query-generation pipeline for phone-use GUI agents.',
  }[f] || ''),
  getCreators: () => [{ firstName: 'Zhe', lastName: 'Dong' }, { firstName: 'A', lastName: 'Lee' }],
};
let sharePref = '';
const ctx = {
  Zotero: {
    debug: () => {},
    Prefs: { get: (k) => (k === 'aireader.shareTheme' ? sharePref : undefined), set: (k, v) => { if (k === 'aireader.shareTheme') sharePref = v; } },
    getMainWindow: () => null,
    ItemPaneManager: { registerSection() {}, unregisterSection() {} },
    Reader: { registerEventListener() {}, unregisterEventListener() {} },
    PreferencePanes: { register: async () => 'p', unregister() {} },
  },
  PathUtils: {}, IOUtils: {}, console, setTimeout, TextDecoder, TextEncoder,
};
ctx.AIReader = undefined;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'content', 'aireader.js'), 'utf8'), ctx, { filename: 'aireader.js' });
const A = ctx.AIReader;

// 1) theme registry: >=4, each has id/label/desc + a :root vars block
assert(Array.isArray(A._shareThemes) && A._shareThemes.length >= 4, 'at least 4 themes');
for (const t of A._shareThemes) {
  assert(t.id && t.label && t.desc, 'theme has id/label/desc: ' + JSON.stringify(t));
  assert(/:root\{/.test(t.vars || ''), 'theme vars has :root: ' + t.id);
}
const ids = A._shareThemes.map((t) => t.id);
assert(['journal', 'modern', 'swiss', 'warm'].every((x) => ids.includes(x)), 'has journal/modern/swiss/warm');

// 2) theme resolution + pref fallback
assert(A._shareTheme('swiss').id === 'swiss', 'resolve swiss');
assert(A._shareTheme('nope').id === A._shareThemes[0].id, 'unknown falls back to first');
assert(A._shareThemeId() === 'journal', 'blank pref → journal default');
sharePref = 'modern'; assert(A._shareThemeId() === 'modern', 'pref honored');
sharePref = 'garbage'; assert(A._shareThemeId() === 'journal', 'invalid pref → default');
sharePref = '';

// 3) base CSS styles every component class the section prompt can emit
const base = A._shareBaseCss;
for (const sel of ['.dim', '.pros-cons', '.pros', '.cons', '.qa', '.svg-wrap', '.paper-fig', '.highlight', '.toc', 'section', 'h2', '.paper-badges', '.paper-abstract', '.tag']) {
  assert(base.indexOf(sel) >= 0, 'base css styles ' + sel);
}
// tokens drive color (no hardcoded AI purple gradient)
assert(base.indexOf('var(--accent)') >= 0 && base.indexOf('var(--ink)') >= 0, 'base uses CSS variables');
assert(base.indexOf('#667eea') < 0 && base.indexOf('#764ba2') < 0, 'old AI purple gradient removed');
assert(A._shareDarkCss.indexOf('prefers-color-scheme:dark') >= 0, 'dark mode supported');

// 4) _wrapHtmlDoc injects the chosen theme vars + body
const docSwiss = A._wrapHtmlDoc('T', '<section>hi</section>', 'swiss');
assert(docSwiss.indexOf('<!DOCTYPE html>') === 0, 'doctype');
assert(docSwiss.indexOf('#e4002b') >= 0, 'swiss accent injected');
assert(docSwiss.indexOf('<section>hi</section>') >= 0, 'body embedded');
assert(docSwiss.indexOf('var(--accent)') >= 0, 'base css present');
const docModern = A._wrapHtmlDoc('T', 'x', 'modern');
assert(docModern.indexOf('#4f46e5') >= 0, 'modern accent injected');

// 5) _paperInfo pulls authoritative fields from the item
const info = A._paperInfo({ item });
assert(info.title.indexOf('Phone Use Agent') === 0, 'title');
assert(info.authors.join('|') === 'Zhe Dong|A Lee', 'authors from creators');
assert(info.year === '2026', 'year from date');
assert(info.venue === 'NeurIPS', 'venue');
assert(info.arxiv === '2511.01234', 'arxiv id');
assert(info.doi === '10.1234/abcd.5678', 'doi');
assert(/reproducible benchmark/.test(info.abstract), 'abstract');

// 6) header card renders authoritative links + abstract; TOC labelled
const header = A._shareHeaderHtml({ title: 'ignored-model-title', tldr: 'one line', tags: ['GUI', 'agent'] }, info);
assert(header.indexOf('Phone Use Agent') >= 0, 'card uses item title');
assert(header.indexOf('https://arxiv.org/abs/2511.01234') >= 0, 'arxiv link');
assert(header.indexOf('https://doi.org/10.1234/abcd.5678') >= 0, 'doi link');
assert(header.indexOf('Zhe Dong、A Lee') >= 0, 'authors line');
assert(header.indexOf('NeurIPS · 2026') >= 0, 'venue·year');
assert(header.indexOf('paper-abstract') >= 0, 'abstract block');
assert(header.indexOf('one line') >= 0 && header.indexOf('class="tag"') >= 0, 'tldr + tags kept');

// 7) assemble is theme-agnostic (same markup regardless of theme)
const frag = A._assembleShareHtml({ title: 't', tldr: '', tags: [], sections: [{ id: 's1', title: 'Intro' }] }, ['<section id="s1"><h2>Intro</h2></section>'], info);
assert(frag.indexOf('<header>') >= 0 && frag.indexOf('class="toc"') >= 0 && frag.indexOf('<section id="s1">') >= 0, 'assembled structure');

// 8) content-generation prompts untouched (still reference component classes)
const sp = A._shareSectionPrompt('中文', { id: 's1', title: 'x', brief: 'y' }, '(无)');
assert(sp.indexOf('pros-cons') >= 0 && sp.indexOf('[[fig:') >= 0 && sp.indexOf('qa') >= 0, 'section prompt still drives the same components');

console.log('SHARE OK');
