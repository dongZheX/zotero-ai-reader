// Share engines: paper-craft deep long-form (sticky side TOC) + frontend-slides
// real <deck-stage> deck. The ONE vendored runtime is content/vendor/deck-stage.js;
// presets/voices + share prompts live in content/prompts.js. Also: file:// URI fix.
const fs = require('fs'), vm = require('vm'), path = require('path');
function assert(c, m) { if (!c) { console.error('ASSERT FAIL:', m); process.exit(1); } }
const repoRoot = path.join(__dirname, '..');

const item = {
  isAttachment: () => false,
  getField: (f) => ({
    title: 'Phone Use Agent: A Benchmark', date: '2026-05-01', publicationTitle: 'NeurIPS',
    DOI: '10.1234/abcd.5678', url: 'https://arxiv.org/abs/2511.01234', extra: 'arXiv:2511.01234',
    abstractNote: 'We present a reproducible benchmark for phone-use GUI agents.',
  }[f] || ''),
  getCreators: () => [{ firstName: 'Zhe', lastName: 'Dong' }, { firstName: 'A', lastName: 'Lee' }],
};
let sharePref = '', skillPref = '';
const ctx = {
  Zotero: {
    debug: () => {}, isMac: true,
    Prefs: { get: (k) => (k === 'aireader.shareTheme' ? sharePref : k === 'aireader.skill' ? skillPref : undefined), set: (k, v) => { if (k === 'aireader.shareTheme') sharePref = v; } },
    getMainWindow: () => null,
    // Stub: read vendored runtime straight from the repo (rootURI is '').
    File: { getContentsFromURL: (url) => fs.readFileSync(path.join(repoRoot, url), 'utf8') },
    ItemPaneManager: { registerSection() {}, unregisterSection() {} },
    Reader: { registerEventListener() {}, unregisterEventListener() {} },
    PreferencePanes: { register: async () => 'p', unregister() {} },
  },
  PathUtils: {}, IOUtils: {}, console, setTimeout, TextDecoder, TextEncoder,
};
const A = require('./_load').loadInto(ctx);
A.rootURI = ''; // so _deckRuntime reads "content/vendor/deck-stage.js" via the stub

(async () => {
  // 0) prompts.js attached the maintained core
  assert(A._shareSkillsLoaded === true, 'prompts.js loaded');
  assert(Object.keys(A._deckPresets).length === 3, '3 deck presets');
  assert(Object.keys(A._articleVoices).length === 3, '3 article voices');
  for (const id of ['broadside', 'blue-professional', 'monochrome']) {
    const p = A._deckPresets[id];
    assert(p && /:root\{/.test(p.rootVars) && p.rootVars.indexOf('--accent') >= 0, 'preset ' + id + ' has :root --accent');
    assert(p.label && p.fonts, 'preset ' + id + ' has label + fonts');
  }

  // 1) file:// URI encoding — the open-in-browser bug fix
  assert(A._fileURI('/a/b c/论文.html') === 'file:///a/b%20c/' + encodeURIComponent('论文.html'), 'spaces + 中文 encoded');
  assert(A._fileURI('/x/y#z?q.html').indexOf('%23') >= 0 && A._fileURI('/x/y#z?q.html').indexOf('%3F') >= 0, '# and ? encoded');

  // 2) engine registry: 3 article + 3 deck, valid, pref fallback
  const engs = A._shareEngines();
  const eids = engs.map((e) => e.id);
  assert(['article-academic', 'article-storytelling', 'article-concise', 'deck', 'deck-pro', 'deck-mono'].every((x) => eids.includes(x)), 'all engines: ' + eids.join(','));
  assert(engs.filter((e) => e.engine === 'article').length === 3 && engs.filter((e) => e.engine === 'deck').length === 3, '3+3');
  assert(A._shareEngine('deck').id === 'deck' && A._shareEngine('nope').id === engs[0].id, 'resolve + fallback');
  sharePref = 'deck-mono'; assert(A._shareEngineId() === 'deck-mono', 'pref honored');
  sharePref = 'garbage'; assert(A._shareEngineId() === engs[0].id, 'invalid → first'); sharePref = '';

  // 3) component CSS still styles every class the article section prompt emits
  const base = A._shareBaseCss;
  for (const sel of ['.dim', '.pros-cons', '.qa', '.svg-wrap', '.paper-fig', '.highlight', '.lead', '.callout', 'section', 'h2']) assert(base.indexOf(sel) >= 0, 'base css ' + sel);

  // 4) ARTICLE shell: sticky side-nav + scrollspy
  assert(A._articleCss().indexOf('.sidenav') >= 0 && A._articleLayoutCss.indexOf('position:sticky') >= 0, 'sticky side nav');
  assert(A._articleScrollspyJs.indexOf('IntersectionObserver') >= 0, 'scrollspy');
  const sidenav = A._shareSidenavHtml({ sections: [{ id: 's1', title: 'Intro' }, { id: 's2', title: 'Method' }] });
  assert(sidenav.indexOf('href="#s1"') >= 0 && sidenav.indexOf('Method') >= 0, 'side nav links');
  const artDoc = A._assembleArticleHtml('T', '<header id="h">H</header>', sidenav, '<section id="s1"><h2>Intro</h2></section>');
  assert(artDoc.indexOf('class="layout"') >= 0 && artDoc.indexOf('class="sidenav"') >= 0 && artDoc.indexOf('IntersectionObserver') >= 0, 'article structure + scrollspy');

  // 5) paper info card
  const info = A._paperInfo({ item });
  assert(info.year === '2026' && info.arxiv === '2511.01234' && info.doi === '10.1234/abcd.5678', 'paper info');
  const header = A._shareHeaderHtml({ tldr: 'one line', tags: ['GUI'] }, info);
  assert(header.indexOf('Phone Use Agent') >= 0 && header.indexOf('NeurIPS · 2026') >= 0 && header.indexOf('paper-abstract') >= 0, 'header card');

  // 6) article prompts: paper-craft voice injected + methodology overview first
  const outP = A._shareOutlinePrompt('中文', A._articleVoice('academic'));
  assert(outP.indexOf('方法总览') >= 0 && outP.indexOf('paper-craft academic') >= 0, 'outline: overview first + academic voice');
  const secOverview = A._shareSectionPrompt('中文', { id: 's1', title: '方法总览', brief: 'y' }, '(无)', A._articleVoice('storytelling'), true);
  assert(secOverview.indexOf('总览图') >= 0 && secOverview.indexOf('svg') >= 0 && secOverview.indexOf('storytelling') >= 0, 'overview section + voice');
  const secNorm = A._shareSectionPrompt('中文', { id: 's2', title: 'x', brief: 'y' }, '(无)', '', false);
  assert(secNorm.indexOf('lead') >= 0 && secNorm.indexOf('callout') >= 0 && secNorm.indexOf('highlight') >= 0, 'section emphasis');

  // 7) DECK uses the SAME plan→per-slide checklist UX as articles
  const preset = A._deckPreset('broadside');
  const deckOut = A._deckOutlinePrompt('中文');
  assert(deckOut.indexOf('封面') >= 0 && deckOut.indexOf('方法总览') >= 0 && deckOut.indexOf('JSON') >= 0, 'deck outline: cover + overview + JSON');
  const titleSlide = A._deckSlidePrompt('中文', preset, { id: 's1', title: '封面', brief: 'x' }, '(无)', true, false);
  assert(titleSlide.indexOf('title-slide') >= 0 && titleSlide.indexOf('1920') >= 0 && titleSlide.indexOf('var(--accent)') >= 0, 'title slide prompt');
  const ovSlide = A._deckSlidePrompt('中文', preset, { id: 's2', title: '方法总览', brief: 'y' }, '[[fig:3]]', false, true);
  assert(ovSlide.indexOf('总览') >= 0 && ovSlide.indexOf('svg') >= 0 && ovSlide.indexOf('[[fig:') >= 0, 'overview slide asks for diagram');
  const deckDoc = await A._assembleDeckHtml('Talk', '<section class="slide">hi</section>', preset.rootVars, preset.fonts);
  assert(deckDoc.indexOf('<!DOCTYPE html>') === 0, 'deck doctype');
  assert(deckDoc.indexOf('<deck-stage width="1920" height="1080">') >= 0, 'deck-stage 1920x1080');
  assert(deckDoc.indexOf('customElements.define') >= 0 && deckDoc.indexOf("'deck-stage'") >= 0, 'real deck-stage.js runtime inlined');
  assert(deckDoc.indexOf('#E85D26') >= 0 && deckDoc.indexOf('fonts.googleapis.com') >= 0, 'preset vars + fonts link');

  // 7b) the selected reading skill (三遍速读 etc.) is injected into share prompts
  skillPref = 'three-pass';
  assert(A._skillDirective().indexOf('阅读技能') >= 0, 'skill directive non-empty for three-pass');
  assert(A._shareSectionPrompt('中文', { id: 's1', title: 'x' }, '(无)', '', false).indexOf('三遍') >= 0, 'article section carries reading skill');
  assert(A._deckSlidePrompt('中文', A._deckPreset('broadside'), { id: 's1', title: 'x' }, '(无)', false, false).indexOf('三遍') >= 0, 'deck slide carries reading skill');
  assert(A._deckOutlinePrompt('中文').indexOf('阅读技能') >= 0, 'deck outline carries reading skill');
  skillPref = '';

  // 8) figure + svg helpers
  const emb = await A._embedFigures('a [[fig:3]] b', async (id) => (id === 3 ? 'data:image/png;base64,Z' : null));
  assert(emb.indexOf('data:image/png;base64,Z') >= 0 && emb.indexOf('[[fig:') < 0, 'embedFigures');
  assert(A._svgFencesToInline('x ```svg <svg></svg> ``` y').indexOf('<svg></svg>') >= 0, 'svg fence inlined');

  console.log('SHARE OK');
  process.exit(0);
})().catch((e) => { console.error('ASSERT FAIL (threw):', e); process.exit(1); });
