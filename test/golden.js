// GOLDEN SNAPSHOT — the zero-functional-diff safety net for the module split.
// Captures the deterministic output of every pure builder (prompts, context,
// assemblers, CSS, utils) into test/golden.snapshot.json. Run before the split
// to record the baseline; after moving each module it must still match byte-for-
// byte. Mismatch = the move changed behavior.
//
//   node test/golden.js            # compare against the committed baseline
//   node test/golden.js --update   # (re)write the baseline (only before splitting)
const fs = require('fs'), path = require('path');
const { loadInto, repoRoot } = require('./_load');

// ---- deterministic environment ----
const prefs = {
  language: '中文', customPrompt: '【测试自定义要求】务必简洁', skill: 'deep-read',
  temperature: '0.3', maxChars: '60000', maxTokens: '0', model: 'gpt-4o-mini',
  baseURL: 'api.example.com', apiFormat: 'auto', serperKey: '', shareTheme: 'article-academic',
};
const item = {
  isAttachment: () => false,
  getField: (f) => ({ title: 'Phone Use Agent: A Benchmark', date: '2026-05-01', publicationTitle: 'NeurIPS',
    DOI: '10.1234/abcd.5678', url: 'https://arxiv.org/abs/2511.01234', extra: 'arXiv:2511.01234',
    abstractNote: 'We present a reproducible benchmark for phone-use GUI agents.' }[f] || ''),
  getCreators: () => [{ firstName: 'Zhe', lastName: 'Dong' }, { firstName: 'A', lastName: 'Lee' }],
};
const blocks = [
  { id: 1, type: 'heading', text: 'Introduction', pageLabel: '1' },
  { id: 2, type: 'text', text: 'We study phone-use GUI agents and propose a reproducible benchmark with query generation.', pageLabel: '1' },
  { id: 3, type: 'text', text: 'Our method combines tiling and online softmax to reduce memory from O(N^2) to O(N).', pageLabel: '2' },
  { id: 4, type: 'image', text: 'Figure 1: architecture overview', pageLabel: '2' },
  { id: 5, type: 'text', text: 'Experiments on GSM8K and MATH show 2.4x speedup and 15% accuracy gain.', pageLabel: '3' },
];
const ctx = {
  Zotero: {
    debug() {}, isMac: true,
    Prefs: { get: (k) => prefs[String(k).replace(/^aireader\./, '')], set() {} },
    getMainWindow: () => null,
    File: { getContentsFromURL: (u) => fs.readFileSync(path.join(repoRoot, u), 'utf8') },
    Libraries: { userLibraryID: 1 },
    ItemPaneManager: { registerSection() {}, unregisterSection() {} },
    Reader: { registerEventListener() {}, unregisterEventListener() {} },
    PreferencePanes: { register: async () => 'p', unregister() {} },
  },
  PathUtils: { join: (...a) => a.join('/') }, IOUtils: {},
  console, setTimeout, clearTimeout, setInterval, clearInterval, Math, Date, TextDecoder, TextEncoder,
};
const A = loadInto(ctx);
A.rootURI = '';

const figList = A._figureListText(blocks);
const info = A._paperInfo({ item });

// stable stringify (sorted keys) so key order can't cause false diffs
function stable(v) {
  if (Array.isArray(v)) return v.map(stable);
  if (v && typeof v === 'object') { const o = {}; for (const k of Object.keys(v).sort()) o[k] = stable(v[k]); return o; }
  return v;
}

(async () => {
  const snap = {};
  // prompts
  snap.styleGuide = A._styleGuide();
  snap.customPrompt = A._customPrompt();
  snap.systemPrompt = A.systemPrompt('<<CTX>>');
  snap.multiSystemPrompt = A._multiSystemPrompt('<<CTX>>', 3);
  snap.translatePrompt = A._buildTranslatePrompt('English');
  snap.shareStyleNote = A._shareStyleNote();
  snap.onepager = A._shareFormats()[0].buildSystemPrompt('中文');
  snap.shareOutline = A._shareOutlinePrompt('中文', A._articleVoice('academic'));
  snap.sectionOverview = A._shareSectionPrompt('中文', { id: 's1', title: '方法总览', brief: 'b1' }, figList, A._articleVoice('academic'), true);
  snap.sectionNorm = A._shareSectionPrompt('中文', { id: 's2', title: '关键结果', brief: 'b2' }, figList, '', false);
  snap.deckOutline = A._deckOutlinePrompt('中文');
  snap.deckTitle = A._deckSlidePrompt('中文', A._deckPreset('broadside'), { id: 's1', title: '封面', brief: 'b' }, figList, true, false);
  snap.deckOverview = A._deckSlidePrompt('中文', A._deckPreset('monochrome'), { id: 's2', title: '方法总览', brief: 'b' }, figList, false, true);
  snap.deckQa = A._deckSlidePrompt('中文', A._deckPreset('blue-professional'), { id: 's9', title: '速问速答', brief: 'b' }, figList, false, false);
  // reading skills (data + directive per skill)
  snap.skillInject = {};
  snap.skillDirective = {};
  for (const s of A.SKILLS) { snap.skillInject[s.id] = s.inject || ''; prefs.skill = s.id; snap.skillDirective[s.id] = A._skillDirective(); }
  prefs.skill = 'deep-read';
  snap.skillsFull = A.SKILLS;           // full skill defs incl. presets/agentInject
  snap.commonPresets = A.COMMON_PRESETS;
  // context builders
  snap.buildContext = A.buildContext(blocks);
  snap.buildContextBounded = A.buildContextBounded(blocks);
  snap.buildContextBounded_small = A.buildContextBounded(blocks, 80);
  snap.buildRetrieved = A.buildRetrievedContext(blocks, '方法 memory softmax');
  // assemblers + components
  snap.shareHeader = A._shareHeaderHtml({ tldr: 'one line', tags: ['GUI', 'agent'] }, info);
  snap.shareSidenav = A._shareSidenavHtml({ sections: [{ id: 's1', title: 'Intro' }, { id: 's2', title: 'Method' }] });
  snap.assembleArticle = A._assembleArticleHtml('T', '<header id="h">H</header>', snap.shareSidenav, '<section id="s1"><h2>Intro</h2></section>');
  snap.assembleDeck = await A._assembleDeckHtml('T', '<section class="slide">x</section>', A._deckPreset('broadside').rootVars, A._deckPreset('broadside').fonts);
  snap.paperInfo = info;
  snap.figList = figList;
  // CSS + JS blocks
  snap.shareBaseCss = A._shareBaseCss;
  snap.articleCss = A._articleCss();
  snap.articleLayoutCss = A._articleLayoutCss;
  snap.articleScrollspyJs = A._articleScrollspyJs;
  snap.deckBaseCss = A._deckBaseCss;
  snap.shareDarkCss = A._shareDarkCss;
  // pure utils
  snap.fileURI = ['/a/b c/论文.html', '/x/y#z?q.html', '/plain.html'].map((p) => A._fileURI(p));
  snap.svgFence = A._svgFencesToInline('pre ```svg <svg><rect/></svg> ``` post');
  snap.embedFigures = await A._embedFigures('see [[fig:3]] and [[fig:99]]', async (id) => (id === 3 ? 'data:image/png;base64,ZZZ' : null));
  snap.retryAfter = [A._retryAfterMs({ headers: { get: () => '2' } }), A._retryAfterMs({ headers: { get: () => '9999' } }), A._retryAfterMs({ headers: { get: () => null } })];
  snap.normBase = A._normBase();
  snap.temperature = A._temperature();
  snap.deckPresets = A._deckPresets;
  snap.articleVoices = A._articleVoices;

  const out = JSON.stringify(stable(snap), null, 2);
  const file = path.join(__dirname, 'golden.snapshot.json');
  if (process.argv.includes('--update') || !fs.existsSync(file)) {
    fs.writeFileSync(file, out + '\n');
    console.log('GOLDEN baseline written (' + Object.keys(snap).length + ' keys) → ' + path.relative(repoRoot, file));
    process.exit(0);
  }
  const base = fs.readFileSync(file, 'utf8').trim();
  if (base === out.trim()) { console.log('GOLDEN OK (' + Object.keys(snap).length + ' keys identical)'); process.exit(0); }
  // find first differing key for a readable message
  let baseObj = {}; try { baseObj = JSON.parse(base); } catch (e) {}
  const cur = JSON.parse(out);
  for (const k of Object.keys(cur)) {
    if (JSON.stringify(baseObj[k]) !== JSON.stringify(cur[k])) {
      console.error('GOLDEN MISMATCH at key: ' + k);
      const a = JSON.stringify(baseObj[k]), b = JSON.stringify(cur[k]);
      console.error('  baseline: ' + (a ? a.slice(0, 300) : '(missing)'));
      console.error('  current : ' + (b ? b.slice(0, 300) : '(missing)'));
      process.exit(1);
    }
  }
  console.error('GOLDEN MISMATCH (keys added/removed or formatting)'); process.exit(1);
})().catch((e) => { console.error('GOLDEN FAIL (threw):', e); process.exit(1); });
