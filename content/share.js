/* share.js — the SHARE generator (one-pager / paper-craft article / frontend-
 * slides deck engines, HTML assembly + figure embedding + file writing/opening)
 * and the full-text bilingual TRANSLATE pipeline. Loaded into the bootstrap
 * sandbox after aireader.js; attaches onto the global AIReader via Object.assign,
 * so methods still call this.* siblings in the core (e.g. this._escapeHTML,
 * this.buildContextBounded, this.callLLM, this._deckPreset). Pure move out of
 * aireader.js — no behavior change. The deck prompts/presets live in prompts.js;
 * the <deck-stage> runtime is vendored in content/vendor/deck-stage.js.
 */

Object.assign(AIReader, {
  // ---------------------------------------------- 分享材料（share generator）
  // Mirrors obsidian src/share.ts. The recipe (prompts + HTML template) is
  // distilled from the tech-html-explainer idea, run through our own pipeline.
  // NOTE: share/deck prompt builders + _shareStyleNote + _shareFormats +
  // _deckPresets/_articleVoices now live in content/prompts.js (one place to
  // find/tune share prompts), attached to AIReader via Object.assign.
  // Share engines — each backed by a real bundled open-source skill, driven
  // faithfully (its real files feed the prompt / its real runtime is inlined).
  //  • article-*  → paper-craft (paper-analyzer): deep illustrated long-form,
  //    three real writing voices. Clean reading shell + sticky side TOC.
  //  • deck       → frontend-slides (MIT): a real 16:9 presentation deck using
  //    the upstream <deck-stage> runtime verbatim (keyboard nav + print-to-PDF).
  _shareEngines() {
    return [
      { id: "article-academic", engine: "article", style: "academic",
        label: "深度长文 · 学术", desc: "paper-craft：严谨深解，比论文更清晰（侧边目录）" },
      { id: "article-storytelling", engine: "article", style: "storytelling",
        label: "深度长文 · 故事", desc: "paper-craft：像一篇好读的公众号深解" },
      { id: "article-concise", engine: "article", style: "concise",
        label: "深度长文 · 精炼", desc: "paper-craft：直给要点，少铺陈" },
      { id: "deck", engine: "deck", preset: "broadside",
        label: "幻灯片 · 放映（大字海报）", desc: "frontend-slides：真·16:9 幻灯，←/→ 翻页、全屏放映、可打印 PDF" },
      { id: "deck-pro", engine: "deck", preset: "blue-professional",
        label: "幻灯片 · 放映（商务蓝）", desc: "frontend-slides：清爽专业的演示风" },
      { id: "deck-mono", engine: "deck", preset: "monochrome",
        label: "幻灯片 · 放映（极简黑白）", desc: "frontend-slides：极简黑白演示风" },
    ];
  },
  _shareEngine(id) { return this._shareEngines().find((e) => e.id === id) || this._shareEngines()[0]; },
  _shareEngineId() { const p = ((this.getPref("shareTheme") || "") + "").trim(); return this._shareEngines().some((e) => e.id === p) ? p : this._shareEngines()[0].id; },
  // [[fig:id]] → figure card; resolver failure drops the placeholder.
  async _embedFigures(text, resolver) {
    const re = /\[\[fig:B?(\d+)\]\]/g;
    const ids = []; let m;
    while ((m = re.exec(text || ""))) ids.push(parseInt(m[1], 10));
    const uriById = new Map();
    for (const id of ids) {
      if (uriById.has(id)) continue;
      try { const u = await resolver(id); if (u) uriById.set(id, u); } catch (e) {}
    }
    return (text || "").replace(re, (_w, g1) => {
      const uri = uriById.get(parseInt(g1, 10));
      return uri ? '<div class="paper-fig"><img src="' + uri + '" alt="figure ' + g1 + '"/><div class="caption">本文图表 ' + g1 + '</div></div>' : "";
    });
  },
  _svgFencesToInline(html) { return (html || "").replace(/```svg\s*([\s\S]*?)```/gi, (_w, body) => String(body).trim()); },
  _htmlEsc(title) { return (title || "").replace(/[<>&]/g, (c) => (c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&amp;")); },
  // ---- ARTICLE engine (paper-craft): clean reading shell + sticky side TOC +
  // scrollspy. The bundled component CSS (_shareBaseCss) styles the SAME classes
  // the section prompt emits; _articleLayoutCss adds the sidebar grid.
  _articleCss() { return this._shareBaseCss + "\n" + this._articleLayoutCss + "\n" + this._shareDarkCss; },
  _assembleArticleHtml(title, headerHtml, tocHtml, sectionsHtml) {
    return "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\"/>\n" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"/>\n" +
      "<meta name=\"color-scheme\" content=\"light dark\"/>\n" +
      "<title>" + this._htmlEsc(title || "论文分享") + "</title>\n<style>\n" + this._articleCss() + "\n</style>\n</head>\n<body>\n" +
      "<div class=\"layout\">\n<nav class=\"sidenav\">" + (tocHtml || "") + "</nav>\n<main class=\"content\">\n" +
      (headerHtml || "") + "\n" + (sectionsHtml || "") + "\n<footer>由 AI Reader 生成 · paper-craft 风格</footer>\n</main>\n</div>\n" +
      "<script>\n" + this._articleScrollspyJs + "\n</script>\n</body>\n</html>\n";
  },
  _articleLayoutCss: [
    "body{padding:0;}",
    ".layout{display:grid;grid-template-columns:250px minmax(0,1fr);gap:clamp(24px,4vw,48px);max-width:1260px;margin:0 auto;padding:clamp(16px,3vw,36px);align-items:start;}",
    ".sidenav{position:sticky;top:16px;align-self:start;max-height:calc(100vh - 32px);overflow-y:auto;padding:4px 6px 20px 0;}",
    ".sidenav .lbl{display:block;font-size:.7rem;letter-spacing:.12em;text-transform:uppercase;color:var(--muted);margin:6px 0 12px 12px;}",
    ".sidenav ul{list-style:none;} .sidenav li{margin:0;border:none;padding:0;}",
    ".sidenav a{display:block;padding:7px 12px;border-radius:8px;color:var(--muted);text-decoration:none;font-size:.9rem;line-height:1.4;border-left:2px solid transparent;transition:color .15s,background .15s;}",
    ".sidenav a:hover{color:var(--accent);}",
    ".sidenav a.active{color:var(--accent);background:var(--accent-soft);border-left-color:var(--accent);font-weight:600;}",
    ".content{min-width:0;} .content>section{scroll-margin-top:16px;} .content>header{scroll-margin-top:16px;}",
    "@media (max-width:900px){.layout{grid-template-columns:1fr;} .sidenav{position:static;max-height:none;overflow:visible;border-bottom:1px solid var(--border);margin-bottom:12px;padding-bottom:12px;}}",
  ].join("\n"),
  _articleScrollspyJs: [
    "(function(){",
    " var links=[].slice.call(document.querySelectorAll('.sidenav a[href^=\"#\"]'));",
    " var map={}; links.forEach(function(a){var id=decodeURIComponent(a.getAttribute('href').slice(1)); map[id]=a;",
    "  a.addEventListener('click',function(e){var t=document.getElementById(id); if(t){e.preventDefault(); t.scrollIntoView({behavior:'smooth',block:'start'});}});});",
    " var secs=[].slice.call(document.querySelectorAll('.content section[id], .content header[id]'));",
    " if(!('IntersectionObserver' in window)||!secs.length) return;",
    " var io=new IntersectionObserver(function(ents){ents.forEach(function(en){ if(en.isIntersecting){var id=en.target.id; links.forEach(function(a){a.classList.remove('active');}); if(map[id])map[id].classList.add('active');}});},{rootMargin:'-15% 0px -75% 0px',threshold:0});",
    " secs.forEach(function(s){io.observe(s);});",
    "})();",
  ].join("\n"),
  // ---- DECK engine (frontend-slides, MIT): the upstream <deck-stage> runtime
  // is inlined verbatim (keyboard nav, stage scaling, print-to-PDF). The model
  // authors :root preset vars + <section> slides as direct children. Zero-dep.
  _deckBaseCss: [
    "html,body{margin:0;padding:0;height:100%;background:var(--bg,#000);}",
    "*{box-sizing:border-box;}",
    "deck-stage section{overflow:hidden;}",
    // figure / image / svg / table guards: the deck doc ships ONLY this CSS (not
    // _shareBaseCss), so without these an embedded [[fig]] <img> renders at its
    // native pixel size and overflows the 1920×1080 slide. Clamp to the slide box.
    "deck-stage section img{display:block;max-width:100%;max-height:640px;width:auto;height:auto;object-fit:contain;margin:16px auto;}",
    "deck-stage section .paper-fig{margin:16px 0;text-align:center;}",
    "deck-stage section svg{display:block;max-width:100%;max-height:680px;height:auto;margin:0 auto;}",
    "deck-stage section .svg-wrap{margin:16px 0;}",
    "deck-stage section .paper-fig .caption,deck-stage section .svg-wrap .caption{color:var(--muted);font-size:22px;margin-top:8px;text-align:center;}",
    "deck-stage section table{border-collapse:collapse;max-width:100%;}",
    "deck-stage section th,deck-stage section td{border:1px solid var(--border);padding:8px 14px;text-align:left;}",
    "deck-stage section .highlight{color:var(--accent);font-weight:700;}",
  ].join("\n"),
  async _assembleDeckHtml(title, slidesHtml, presetVarsCss, fontsLink) {
    const runtime = await this._deckRuntime();
    const fonts = fontsLink ? '<link rel="stylesheet" href="' + fontsLink + '"/>\n' : "";
    return "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\"/>\n" +
      "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\"/>\n" + fonts +
      "<title>" + this._htmlEsc(title || "Slides") + "</title>\n<style>\n" + this._deckBaseCss + "\n" + (presetVarsCss || "") + "\n</style>\n</head>\n<body>\n" +
      "<deck-stage width=\"1920\" height=\"1080\">\n" + (slidesHtml || "") + "\n</deck-stage>\n" +
      "<script>\n" + (runtime || "") + "\n</script>\n</body>\n</html>\n";
  },
  // ---- component CSS: styles the SAME classes the article section prompt emits.
  _shareBaseCss: [
    "*{box-sizing:border-box;margin:0;padding:0;}",
    ":root{--maxw:1040px;--radius:14px;--gap:24px;--paper:#faf7f2;--surface:#fffdf9;--ink:#1e2430;--muted:#6b6256;--accent:#9a3412;--on-accent:#fff;--accent-soft:#f6ece1;--border:#e7ddcd;--mark:#fde68a;--ok:#15803d;--bad:#b91c1c;--code-bg:#f4efe6;--shadow-1:0 1px 2px rgba(30,20,10,.05),0 2px 10px rgba(30,20,10,.04);--font-head:Georgia,'Times New Roman','Songti SC',serif;--font-body:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei',sans-serif;--font-mono:'SF Mono',ui-monospace,Consolas,monospace;}",
    "html{-webkit-text-size-adjust:100%;}",
    "body{font-family:var(--font-body);line-height:1.75;color:var(--ink);background:var(--paper);padding:clamp(16px,4vw,40px);min-height:100vh;}",
    "@supports (text-wrap:pretty){body{text-wrap:pretty;}}",
    ".container{max-width:var(--maxw);margin:0 auto;}",
    "header{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:clamp(24px,5vw,44px);margin-bottom:var(--gap);box-shadow:var(--shadow-1);}",
    "header h1{font-family:var(--font-head);font-weight:800;font-size:clamp(1.65rem,4.2vw,2.5rem);line-height:1.2;letter-spacing:-.01em;color:var(--ink);}",
    ".paper-authors{color:var(--muted);margin-top:12px;font-size:.98rem;line-height:1.6;}",
    ".paper-venue{color:var(--accent);font-weight:600;margin-top:4px;font-size:.95rem;}",
    ".paper-badges{margin-top:16px;display:flex;flex-wrap:wrap;gap:8px;}",
    ".paper-badges a{text-decoration:none;font-size:.8rem;font-weight:600;padding:5px 13px;border-radius:999px;border:1px solid var(--accent);color:var(--accent);background:transparent;transition:background .15s ease,color .15s ease;}",
    ".paper-badges a:hover{background:var(--accent);color:var(--on-accent);}",
    ".tldr{margin-top:18px;font-size:1.06rem;color:var(--ink);font-weight:500;}",
    ".tags{margin-top:12px;} .tag{display:inline-block;background:var(--accent-soft);color:var(--accent);padding:3px 11px;border-radius:999px;margin:4px 6px 0 0;font-size:.8rem;font-weight:600;}",
    ".paper-abstract{margin-top:18px;padding-top:16px;border-top:1px solid var(--border);font-size:.95rem;color:var(--ink);}",
    ".paper-abstract .lbl,.toc .lbl{display:block;font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;color:var(--muted);margin-bottom:8px;}",
    ".toc{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:20px 26px;margin-bottom:var(--gap);box-shadow:var(--shadow-1);}",
    ".toc ul{list-style:none;} .toc li{padding:5px 0;border-bottom:1px solid var(--border);} .toc li:last-child{border-bottom:none;} .toc a{color:var(--ink);text-decoration:none;border-bottom:1px solid transparent;} .toc a:hover{color:var(--accent);border-bottom-color:var(--accent);}",
    "section{background:var(--surface);border:1px solid var(--border);border-radius:var(--radius);padding:clamp(22px,4vw,38px);margin-bottom:var(--gap);box-shadow:var(--shadow-1);}",
    "h2{font-family:var(--font-head);font-size:clamp(1.3rem,3vw,1.72rem);color:var(--ink);margin-bottom:18px;padding-bottom:10px;border-bottom:2px solid var(--accent);}",
    "h3{font-size:1.2rem;color:var(--ink);margin:22px 0 10px;font-weight:700;}",
    "h4{color:var(--accent);margin:16px 0 8px;font-size:1rem;font-weight:700;}",
    "p{margin-bottom:12px;} ul,ol{padding-left:22px;margin-bottom:12px;} li{margin:5px 0;} a{color:var(--accent);} strong{color:var(--ink);}",
    "code{background:var(--code-bg);color:var(--accent);padding:2px 7px;border-radius:5px;font-family:var(--font-mono);font-size:.9em;}",
    "table{width:100%;border-collapse:collapse;margin:16px 0;font-size:.94em;} th,td{padding:10px 14px;text-align:left;border-bottom:1px solid var(--border);} th{background:var(--accent-soft);font-weight:700;color:var(--ink);}",
    ".pros-cons{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin:16px 0;} .pros,.cons{padding:18px 20px;border-radius:10px;border:1px solid var(--border);} .pros{background:color-mix(in srgb,var(--ok) 9%,transparent);border-color:color-mix(in srgb,var(--ok) 30%,var(--border));} .cons{background:color-mix(in srgb,var(--bad) 9%,transparent);border-color:color-mix(in srgb,var(--bad) 30%,var(--border));}",
    ".pros h4{color:var(--ok);margin-top:0;} .cons h4{color:var(--bad);margin-top:0;}",
    ".qa{background:var(--accent-soft);border:1px solid var(--border);border-radius:10px;padding:16px 20px;margin:14px 0;} .qa .q{font-weight:700;color:var(--ink);margin-bottom:8px;} .qa .q::before{content:'Q ';color:var(--accent);font-weight:800;} .qa .a{color:var(--ink);padding-left:14px;border-left:3px solid var(--accent);} .qa .a::before{content:'A ';font-weight:800;color:var(--accent);}",
    ".highlight{background:linear-gradient(transparent 62%,var(--mark) 0);padding:0 2px;}",
    ".lead{font-size:1.08rem;font-weight:600;color:var(--ink);margin:0 0 16px;padding:8px 0 8px 16px;border-left:4px solid var(--accent);}",
    ".callout{background:var(--accent-soft);border:1px solid var(--border);border-left:4px solid var(--accent);border-radius:10px;padding:14px 18px;margin:16px 0;color:var(--ink);} .callout strong,.callout b{color:var(--accent);}",
    ".dim{font-family:var(--font-mono);font-size:.86em;background:var(--code-bg);border:1px dashed var(--border);padding:12px 18px;border-radius:8px;margin:10px 0;white-space:pre-wrap;line-height:1.7;color:var(--muted);}",
    ".svg-wrap{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:18px;margin:18px 0;overflow-x:auto;box-shadow:var(--shadow-1);} .svg-wrap .caption{text-align:center;color:var(--muted);font-size:.86em;margin-top:10px;}",
    "svg{display:block;margin:0 auto;max-width:100%;height:auto;}",
    ".paper-fig{background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:20px;margin:18px 0;box-shadow:var(--shadow-1);} .paper-fig img{display:block;max-width:100%;height:auto;margin:0 auto;border-radius:6px;} .paper-fig .caption{text-align:center;color:var(--muted);font-size:.88em;margin-top:12px;}",
    "footer{text-align:center;color:var(--muted);font-size:.82em;margin:8px 0 0;}",
    "@media (max-width:768px){.pros-cons{grid-template-columns:1fr;}}",
    "@media (prefers-reduced-motion:reduce){*{transition:none!important;scroll-behavior:auto!important;}}",
  ].join("\n"),
  // Shared dark remap: neutrals flip, each theme keeps its own --accent.
  _shareDarkCss: "@media (prefers-color-scheme:dark){:root{--paper:#0f1216;--surface:#171b22;--ink:#e6ecf3;--muted:#98a4b5;--border:#2a313c;--code-bg:#1c222b;--accent-soft:color-mix(in srgb,var(--accent) 16%,#171b22);--shadow-1:0 1px 2px rgba(0,0,0,.4),0 2px 12px rgba(0,0,0,.35);}}",

  // ---- rich HTML built section-by-section (depth + per-section progress) ----
  _parseShareOutline(text) {
    try {
      let t = (text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
      const a = t.indexOf("{"), b = t.lastIndexOf("}");
      if (a < 0 || b <= a) return null;
      const o = JSON.parse(t.slice(a, b + 1));
      if (!o || !Array.isArray(o.sections) || !o.sections.length) return null;
      const sections = o.sections.map((s, i) => ({ id: String((s && s.id) || "s" + (i + 1)), title: String((s && s.title) || "章节 " + (i + 1)), brief: String((s && s.brief) || "") })).filter((s) => s.title);
      if (!sections.length) return null;
      return { title: String(o.title || ""), tldr: String(o.tldr || ""), tags: Array.isArray(o.tags) ? o.tags.map(String).slice(0, 6) : [], sections };
    } catch (e) { return null; }
  },
  // Authoritative paper metadata from the Zotero item (NOT model-generated), for
  // the header info card: title, authors, venue·year, arXiv/DOI/URL links, abstract.
  _paperInfo(state) {
    let it = state && state.item;
    try { if (it && it.isAttachment && it.isAttachment() && it.parentItem) it = it.parentItem; } catch (e) {}
    const get = (f) => { try { return (it && it.getField && it.getField(f)) || ""; } catch (e) { return ""; } };
    let authors = [];
    try {
      const cr = (it && it.getCreators && it.getCreators()) || [];
      authors = cr.map((c) => ((c.firstName ? c.firstName + " " : "") + (c.lastName || c.name || "")).trim()).filter(Boolean);
    } catch (e) {}
    const date = get("date") || "";
    const ym = /(\d{4})/.exec(date); const year = ym ? ym[1] : "";
    const venue = get("publicationTitle") || get("conferenceName") || get("proceedingsTitle") || get("publisher") || get("repository") || "";
    const extra = get("extra") || ""; const url = get("url") || ""; const title = get("title") || "";
    const doi = (get("DOI") || (/10\.\d{4,9}\/[^\s"]+/.exec(extra) || [])[0] || "").trim();
    const am = /arxiv[:/ ]?\s*(\d{4}\.\d{4,5})/i.exec(extra + " " + url + " " + title);
    const arxiv = am ? am[1] : "";
    const abstract = get("abstractNote") || "";
    return { title, authors, year, venue, doi, arxiv, url, abstract };
  },
  _attr(s) { return this._escapeHTML(String(s || "")).replace(/"/g, "&quot;"); },
  _shareHeaderHtml(o, info) {
    info = info || {};
    const esc = (s) => this._escapeHTML(s);
    const title = esc(info.title || o.title || "论文分享");
    let h = "<header><h1>" + title + "</h1>";
    if (info.authors && info.authors.length) {
      const names = info.authors.slice(0, 12).map(esc).join("、") + (info.authors.length > 12 ? " 等" : "");
      h += '<div class="paper-authors">' + names + "</div>";
    }
    const vy = [info.venue, info.year].filter(Boolean).map(esc).join(" · ");
    if (vy) h += '<div class="paper-venue">' + vy + "</div>";
    const badges = [];
    if (info.arxiv) badges.push('<a href="https://arxiv.org/abs/' + this._attr(info.arxiv) + '" target="_blank" rel="noopener">arXiv ' + esc(info.arxiv) + "</a>");
    if (info.doi) badges.push('<a href="https://doi.org/' + this._attr(info.doi) + '" target="_blank" rel="noopener">DOI</a>');
    if (info.url && !info.arxiv) badges.push('<a href="' + this._attr(info.url) + '" target="_blank" rel="noopener">原文链接</a>');
    if (badges.length) h += '<div class="paper-badges">' + badges.join("") + "</div>";
    if (o.tldr) h += '<p class="tldr">' + esc(o.tldr) + "</p>";
    const tags = (o.tags || []).map((t) => '<span class="tag">' + esc(t) + "</span>").join("");
    if (tags) h += '<div class="tags">' + tags + "</div>";
    if (info.abstract) {
      const ab = info.abstract.length > 1200 ? info.abstract.slice(0, 1200) + "…" : info.abstract;
      h += '<div class="paper-abstract"><span class="lbl">摘要 Abstract</span>' + esc(ab) + "</div>";
    }
    return h + "</header>";
  },
  // Sticky side-nav TOC body (the <nav class="sidenav"> wrapper is added by the
  // article assembler; scrollspy JS highlights the current section link).
  _shareSidenavHtml(o) {
    return '<span class="lbl">目录 Contents</span><ul>' + (o.sections || []).map((s) => '<li><a href="#' + this._attr(s.id) + '">' + this._escapeHTML(s.title) + "</a></li>").join("") + "</ul>";
  },
  _stripHtmlFence(s) { return (s || "").trim().replace(/^```(?:html)?\s*/i, "").replace(/\s*```$/i, "").trim(); },
  _figureListText(blocks) {
    const figs = (blocks || []).filter((b) => b.type === "image" || b.type === "table" || b.type === "figure").slice(0, 20);
    if (!figs.length) return "（无）";
    return figs.map((b) => "[[fig:" + b.id + "]] " + this.figKind(b.type) + "：" + ((b.text || "").slice(0, 60) || "(无标题)")).join("\n");
  },

  _shareBaseName(state) {
    let it = state && state.item;
    try { if (it && it.isAttachment && it.isAttachment() && it.parentItem) it = it.parentItem; } catch (e) {}
    let base = "";
    try { base = (it && it.getField && it.getField("title")) || ""; } catch (e) {}
    if (!base) base = (state.attachment && state.attachment.key) || "share";
    return base.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
  },
  async _writeShareFile(state, ext, content) {
    const dir = PathUtils.join(Zotero.DataDirectory.dir, "aireader", "shares");
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const path = PathUtils.join(dir, this._shareBaseName(state) + "." + ext);
    await IOUtils.writeUTF8(path, content);
    return path;
  },
  // Build a valid file:// URI from an absolute path. A raw "file://"+path breaks
  // the moment the path has a space / 中文 / # / ? (the share filename is the
  // paper title) → the browser never opens. Encode each segment, keep the "/".
  _fileURI(path) {
    const p = String(path || "");
    const parts = p.split("/").map((seg) => encodeURIComponent(seg));
    let uri = parts.join("/");
    if (!uri.startsWith("/")) uri = "/" + uri; // absolute paths start with /
    return "file://" + uri;
  },
  _openFile(path) {
    try { if (typeof Zotero.launchURL === "function") { Zotero.launchURL(this._fileURI(path)); return true; } } catch (e) {}
    // macOS fallback: hand the raw path to `open`, which needs no URI encoding.
    try {
      const Subprocess = (typeof ChromeUtils !== "undefined" && ChromeUtils.importESModule) && ChromeUtils.importESModule("resource://gre/modules/Subprocess.sys.mjs").Subprocess;
      if (Subprocess && Zotero.isMac) { Subprocess.call({ command: "/usr/bin/open", arguments: [path] }); return true; }
    } catch (e) {}
    try { if (Zotero.File && typeof Zotero.File.reveal === "function") { Zotero.File.reveal(path); return true; } } catch (e) {}
    return false;
  },
  // The deck presentation runtime is the ONE thing shipped verbatim: the real
  // frontend-slides <deck-stage> (content/vendor/deck-stage.js, MIT), inlined
  // into generated decks. Read once from the packaged xpi and cached. (rootURI
  // is a jar:file://…xpi!/ URL — getContentsFromURLAsync CHOKES on jar:, but
  // fetch / sync getContentsFromURL read it fine.) Presets, authoring rules and
  // writing voices live in content/share-skills.js (_deckPresets etc.).
  _deckRuntimeCache: null,
  async _deckRuntime() {
    if (this._deckRuntimeCache != null) return this._deckRuntimeCache;
    const url = this.rootURI + "content/vendor/deck-stage.js";
    let txt = "";
    if (typeof fetch === "function") { try { const r = await fetch(url); txt = await r.text(); } catch (e) { this.log("deckRuntime fetch: " + e); } }
    if (!txt && Zotero.File && typeof Zotero.File.getContentsFromURL === "function") { try { txt = Zotero.File.getContentsFromURL(url); } catch (e) { this.log("deckRuntime sync: " + e); } }
    this._deckRuntimeCache = txt || "";
    return this._deckRuntimeCache;
  },

  // Generate a shareable artifact from the whole paper. Its own streamed turn;
  // does NOT push into chat history / synced note (it's a separate product).
  async generateShare(state, fmtId, themeId) {
    if (!this.requireKey(state)) return;
    if (state.streaming) return;
    // fmtId is either "onepager" (a Markdown format) or a share-engine id.
    const engine = fmtId === "onepager" ? null : this._shareEngines().find((e) => e.id === fmtId);
    const spec = engine ? null : this._shareFormats().find((f) => f.id === fmtId);
    if (!engine && !spec) return;
    this.appendUserMsg(state, "📄 生成分享材料：" + (engine ? engine.label : spec.label));
    const { msg, bubble } = this.appendAssistantMsg(state);
    bubble.classList.add("aireader-streaming");
    state.streaming = true; state.cancel = false; this.updateSendButton(state);
    const meta = {};
    try {
      await this.ensureBlocks(state);
      const lang = this.getPref("language") || "中文";
      // Article & deck are built by a model-driven agent loop (agentShare):
      // the model plans, reads, writes each unit, sees its real rendered
      // screenshot, fixes layout, and finalizes — see content/share-agent.js.
      if (engine && (engine.engine === "article" || engine.engine === "deck")) { await this.agentShare(state, bubble, msg, lang, engine); this.setStatus(state, "", ""); return; }
      // one-pager: single streamed pass (readable Markdown). Show a spinner +
      // label while prefilling / streaming so it never looks like a dead box.
      bubble.classList.remove("aireader-streaming");
      bubble.textContent = "";
      const waitRow = this._el(state.doc, "div", "aireader-share-wait", "正在生成一页总结…"); bubble.appendChild(waitRow);
      const contentEl = this._el(state.doc, "div", ""); bubble.appendChild(contentEl);
      let ctx = this.buildContextBounded(state.blocks);
      try { const fd = await this._figureDigest(state, 4); if (fd) ctx = fd + "——\n\n论文正文：\n" + ctx; } catch (e) { this.log("share figdigest: " + e); }
      const messages = [{ role: "system", content: spec.buildSystemPrompt(lang) }, { role: "user", content: "论文内容：\n\n" + ctx }];
      this._startWait(state, "正在生成" + spec.label + "…");
      let acc = "", lastR = 0;
      const res = await this._streamAnswer(messages, null, (d) => {
        this._stopWait(state); acc += d;
        const now = Date.now(); if (now - lastR > 140) { lastR = now; contentEl.textContent = acc; }
        this.setStatus(state, "生成中… " + acc.length + " 字", "busy");
        if (state.chatMsgs) state.chatMsgs.scrollTop = state.chatMsgs.scrollHeight;
      }, () => state.cancel, meta);
      this._stopWait(state);
      bubble.textContent = "";
      await this._finishShareText(state, bubble, msg, spec, (res.text || acc || "").trim());
      this.setStatus(state, "", "");
    } catch (e) {
      bubble.classList.remove("aireader-streaming");
      bubble.textContent = state.cancel ? "（已停止）" : this._friendlyError(e);
      this.log("generateShare error: " + e);
    } finally {
      this._stopWait(state); state.streaming = false; this.updateSendButton(state);
    }
  },
  async _finishShareText(state, bubble, msg, spec, text) {
    this.enhanceMessage(state, bubble, text);
    const doc = state.doc;
    const row = this._el(doc, "div", "aireader-actions"); msg.appendChild(row);
    const mk = (label) => { const a = this._el(doc, "span", "aireader-action", label); row.appendChild(a); return a; };
    const copy = mk("复制");
    copy.addEventListener("click", () => { try { Zotero.Utilities.Internal.copyTextToClipboard(text); copy.textContent = "已复制"; setTimeout(() => (copy.textContent = "复制"), 1200); } catch (e) {} });
    if (spec.id === "onepager") {
      const note = mk("存为笔记");
      note.addEventListener("click", async () => { note.textContent = "存中…"; try { await this.saveNoteFromText(state, text, null); note.textContent = "✓ 已存"; setTimeout(() => (note.textContent = "存为笔记"), 1500); } catch (e) { note.textContent = "存失败"; } });
    }
    const save = mk("保存到文件");
    save.addEventListener("click", async () => {
      save.textContent = "保存中…";
      try { const p = await this._writeShareFile(state, spec.ext, text); save.textContent = "✓ 已保存"; this.setStatus(state, "已保存：" + p, "ok"); this._openFile(p); }
      catch (e) { save.textContent = "保存失败"; this.log("writeShareFile: " + e); }
    });
    // Persist the one-pager into history so it survives a restart (it's a
    // readable Markdown summary, re-rendered on reload).
    if (spec.id === "onepager" && text) this._persistArtifact(state, text, null);
  },
  async _finishShareArticle(state, bubble, msg, outline, sectionHtmls, engine) {
    this.setStatus(state, "正在嵌入图表…", "busy");
    const info = this._paperInfo(state);
    const header = this._shareHeaderHtml(outline, info);
    const sidenav = this._shareSidenavHtml(outline);
    let sections = sectionHtmls.join("\n");
    sections = await this._embedFigures(sections, async (id) => {
      const b = (state.blocks || []).find((x) => x.id === id);
      if (!b) return null;
      try { return await this.renderRegionDataURI(state.attachment, b); } catch (e) { return null; }
    });
    sections = this._svgFencesToInline(sections);
    const title = (info && info.title) || outline.title || this._shareBaseName(state);
    const html = this._assembleArticleHtml(title, header, sidenav, sections);
    bubble.appendChild(this._el(state.doc, "div", "aireader-meta", "深度长文已生成（" + sectionHtmls.length + " 个章节）。"));
    await this._finishShareDoc(state, bubble, msg, html, title, engine.label, "📄 已生成分享长文（" + engine.label + "）");
  },
  async _finishShareDeck(state, bubble, msg, raw, engine, preset) {
    this.setStatus(state, "正在嵌入图表…", "busy");
    const info = this._paperInfo(state);
    preset = preset || this._deckPreset(engine.preset);
    // The model emits a <style> block (preset :root vars) then the slides.
    let styleCss = ""; let slides = raw || "";
    const sm = /<style[^>]*>([\s\S]*?)<\/style>/i.exec(slides);
    if (sm) { styleCss = sm[1]; slides = slides.replace(sm[0], "").trim(); }
    // Guarantee the preset :root vars are present even if the model omitted them.
    if (styleCss.indexOf("--accent") < 0) styleCss = (preset.rootVars || "") + "\n" + styleCss;
    slides = await this._embedFigures(slides, async (id) => {
      const b = (state.blocks || []).find((x) => x.id === id);
      if (!b) return null;
      try { return await this.renderRegionDataURI(state.attachment, b); } catch (e) { return null; }
    });
    slides = this._svgFencesToInline(slides);
    const title = (info && info.title) || this._shareBaseName(state);
    const html = await this._assembleDeckHtml(title, slides, styleCss, preset.fonts);
    const nSlides = (slides.match(/<section/gi) || []).length;
    bubble.appendChild(this._el(state.doc, "div", "aireader-meta", "幻灯片已生成（" + nSlides + " 张）。在浏览器用 ←/→ 翻页、全屏放映、或打印成 PDF。"));
    await this._finishShareDoc(state, bubble, msg, html, title, engine.label, "🖼 已生成放映幻灯（" + engine.label + "）");
  },
  // Shared finish: write the self-contained HTML to disk, offer 打开（浏览器）/
  // 复制 HTML, keep a synced child attachment for durability, and persist a
  // history turn so the artifact comes back after a restart. The open button
  // launches the system browser (via _fileURI) — no Zotero-reader button.
  async _finishShareDoc(state, bubble, msg, html, title, label, persistText) {
    const doc = state.doc;
    const row = this._el(doc, "div", "aireader-actions"); msg.appendChild(row);
    const mk = (t) => { const a = this._el(doc, "span", "aireader-action", t); row.appendChild(a); return a; };
    let path = null;
    try { path = await this._writeShareFile(state, "html", html); this.setStatus(state, "已生成：" + path, "ok"); } catch (e) { this.log("writeShareFile html: " + e); }
    const open = mk("在浏览器打开");
    open.addEventListener("click", async () => { try { if (!path) path = await this._writeShareFile(state, "html", html); if (!this._openFile(path)) this.setStatus(state, "文件路径：" + path, "muted"); } catch (e) { this.log("open share: " + e); } });
    const copy = mk("复制 HTML");
    copy.addEventListener("click", () => { try { Zotero.Utilities.Internal.copyTextToClipboard(html); copy.textContent = "已复制"; setTimeout(() => (copy.textContent = "复制 HTML"), 1200); } catch (e) {} });
    // Keep BOTH the synced attachment key (durable, cross-machine) AND the disk
    // path (fallback), so a restored button still opens even if the attachment
    // is gone or wasn't created (standalone snapshots have no parent to attach to).
    let artifact = null;
    try { const att = await this._attachHtml(state, title + " · " + label, html); if (att && att.key) artifact = { kind: "attachment", key: att.key, path: path, label: "在浏览器打开" }; } catch (e) { this.log("attach share: " + e); }
    if (!artifact && path) artifact = { kind: "file", path: path, label: "在浏览器打开" };
    this._persistArtifact(state, persistText, artifact);
  },

  // ---------------------------------------------- 全文双语翻译（translate）
  // Mirrors obsidian src/translate.ts: paragraph-by-paragraph bilingual output.
  // _buildTranslatePrompt moved to content/prompts.js
  _batchPayload(batch, prevUnits, nextUnits) {
    const parts = [];
    const prev = prevUnits.map((u) => u.text).join("\n\n").trim();
    const next = nextUnits.map((u) => u.text).join("\n\n").trim();
    if (prev) parts.push("【上文（仅供理解，不要翻译）】\n" + prev);
    parts.push("【待翻译（只翻译下列带编号段落）】\n" + this._numberSegments(batch));
    if (next) parts.push("【下文（仅供理解，不要翻译）】\n" + next);
    return parts.join("\n\n");
  },
  _neighborContext(units, batches, i, ctx) {
    const first = batches[i][0], last = batches[i][batches[i].length - 1];
    const a = units.findIndex((u) => u.n === first.n);
    const b = units.findIndex((u) => u.n === last.n);
    return { prev: units.slice(Math.max(0, a - ctx), a), next: units.slice(b + 1, b + 1 + ctx) };
  },
  _translatableUnits(blocks) {
    const out = []; let n = 0;
    for (const b of blocks || []) {
      if ((b.type === "paragraph" || b.type === "heading") && b.text && b.text.trim()) out.push({ n: ++n, text: b.text.trim(), heading: b.type === "heading" });
    }
    return out;
  },
  _batchUnits(units, maxChars) {
    const batches = []; let cur = [], total = 0;
    for (const u of units) {
      const len = u.text.length + 8;
      if (cur.length && total + len > maxChars) { batches.push(cur); cur = []; total = 0; }
      cur.push(u); total += len;
    }
    if (cur.length) batches.push(cur);
    return batches;
  },
  _numberSegments(units) { return units.map((u) => "[[" + u.n + "]] " + u.text).join("\n\n"); },
  _parseTranslations(text) {
    const map = new Map(); const re = /\[\[(\d+)\]\]/g; const hits = []; let m;
    while ((m = re.exec(text || ""))) hits.push({ n: parseInt(m[1], 10), start: m.index, end: m.index + m[0].length });
    for (let i = 0; i < hits.length; i++) {
      const seg = (text || "").slice(hits[i].end, i + 1 < hits.length ? hits[i + 1].start : undefined).trim();
      if (seg) map.set(hits[i].n, seg);
    }
    return map;
  },
  _interleaveBilingual(title, units, trans) {
    const lines = [];
    if (title) lines.push("# " + title + "（双语对照）", "");
    for (const u of units) {
      const t = trans.get(u.n);
      if (u.heading) { lines.push("## " + u.text); if (t) lines.push("## " + t); lines.push(""); }
      else { lines.push(u.text); if (t) lines.push("", "> " + t.replace(/\n+/g, "\n> ")); lines.push(""); }
    }
    return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  },
  // Bilingual note HTML (readable inside Zotero): original then translation.
  _bilingualNoteHTML(title, units, trans) {
    let html = "<h1>" + this._escapeHTML(title) + "（双语对照）</h1>\n";
    for (const u of units) {
      const t = trans.get(u.n);
      if (u.heading) { html += "<h2>" + this._escapeHTML(u.text) + (t ? " / " + this._escapeHTML(t) : "") + "</h2>\n"; }
      else { html += "<p>" + this._escapeHTML(u.text) + "</p>\n"; if (t) html += '<p style="color:#1a73e8">' + this._escapeHTML(t) + "</p>\n"; }
    }
    return html;
  },
  // Standalone bilingual HTML document (saved as a child attachment, opened in
  // Zotero). Original paragraph + translation beneath it, readable column.
  _bilingualHtmlDoc(title, units, trans) {
    const esc = (s) => this._escapeHTML(s);
    // Translation-forward layout: the (Chinese) translation is the main reading
    // text; the English source sits above it, smaller & muted, as a reference.
    let body = "";
    for (const u of units) {
      const t = trans.get(u.n);
      if (u.heading) {
        body += '<h2>' + esc(t || u.text) + (t ? '<span class="en">' + esc(u.text) + "</span>" : "") + "</h2>\n";
      } else {
        body += '<div class="seg"><p class="o">' + esc(u.text) + "</p>" + (t ? '<p class="t">' + esc(t) + "</p>" : "") + "</div>\n";
      }
    }
    const css = [
      ":root{--fg:#1f2328;--src:#6b7686;--mut:#9aa4b2;--accent:#3b6ea5;--line:#e7e9ee;--bg:#fcfcfb;}",
      "@media(prefers-color-scheme:dark){:root{--fg:#e6edf3;--src:#8b97a7;--mut:#6b7686;--accent:#6ea8e6;--line:#262b33;--bg:#12151a;}}",
      "*{box-sizing:border-box;}",
      "body{margin:0;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Microsoft YaHei','Segoe UI',sans-serif;font-size:17px;line-height:1.85;color:var(--fg);background:var(--bg);}",
      ".doc{max-width:760px;margin:0 auto;padding:48px 30px 96px;}",
      "header.top{margin-bottom:30px;padding-bottom:16px;border-bottom:1px solid var(--line);}",
      "header.top h1{font-size:1.45em;line-height:1.3;margin:0 0 6px;}",
      "header.top .sub{color:var(--mut);font-size:.8em;letter-spacing:.02em;}",
      "h2{font-size:1.2em;line-height:1.4;margin:40px 0 14px;padding-left:13px;border-left:3px solid var(--accent);}",
      "h2 .en{display:block;color:var(--src);font-size:.62em;font-weight:500;letter-spacing:.01em;margin-top:3px;}",
      ".seg{margin:0 0 20px;}",
      "p{margin:0;}",
      "p.o{color:var(--src);font-size:.86em;line-height:1.55;margin-bottom:4px;}",
      "p.t{color:var(--fg);}",
      "::selection{background:rgba(110,168,230,.28);}",
    ].join("");
    return "<!DOCTYPE html>\n<html lang=\"zh-CN\"><head><meta charset=\"UTF-8\"/>" +
      "<meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"/>" +
      "<title>" + esc(title) + " · 双语对照</title><style>" + css + "</style></head>" +
      "<body><div class=\"doc\"><header class=\"top\"><h1>" + esc(title) + "</h1><div class=\"sub\">AI Reader · 双语对照 · 共 " + units.length + " 段</div></header>\n" + body + "</div></body></html>\n";
  },
  // Write HTML to a temp file and import it as a stored child attachment of the
  // current item's parent (syncs through Zotero). Returns the attachment item.
  async _attachHtml(state, title, html) {
    let parent = state.item;
    try { if (parent && parent.isAttachment && parent.isAttachment() && parent.parentItem) parent = parent.parentItem; } catch (e) {}
    if (!parent || !(parent.isRegularItem && parent.isRegularItem())) return null; // nothing to attach to
    const dir = PathUtils.join(Zotero.DataDirectory.dir, "aireader", "shares");
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const safe = (title || "translation").replace(/[\\/:*?"<>|]+/g, "_").slice(0, 80);
    const path = PathUtils.join(dir, safe + ".html");
    await IOUtils.writeUTF8(path, html);
    return await Zotero.Attachments.importFromFile({ file: path, parentItemID: parent.id, title: title, contentType: "text/html" });
  },
  _viewAttachment(att) {
    try { const zp = Zotero.getActiveZoteroPane && Zotero.getActiveZoteroPane(); if (zp && zp.viewAttachment) { zp.viewAttachment([att.id]); return; } } catch (e) {}
    try { const p = att.getFilePath && att.getFilePath(); if (p) this._openFile(p); } catch (e) { this.log("viewAttachment: " + e); }
  },
  async generateTranslation(body) {
    const state = this._bodyState.get(body);
    if (!state || !state.attachment) return;
    if (!this.requireKey(state)) return;
    if (state.streaming) return;
    this.appendUserMsg(state, "🌐 全文翻译");
    const { msg, bubble } = this.appendAssistantMsg(state);
    state.streaming = true; state.cancel = false; this.updateSendButton(state);
    try {
      await this.ensureBlocks(state);
      const units = this._translatableUnits(state.blocks);
      if (!units.length) { bubble.textContent = "没有可翻译的正文段落。"; return; }
      const target = this.getPref("language") || "中文";
      const batches = this._batchUnits(units, 5000);
      // Friendly progress: a determinate bar + "已完成 X / 总 段（%）", per batch.
      bubble.textContent = "";
      const label = this._el(state.doc, "div", "aireader-trans-label"); bubble.appendChild(label);
      const barOuter = this._el(state.doc, "div", "aireader-progress"); const barFill = this._el(state.doc, "div", "aireader-progress-fill"); barOuter.appendChild(barFill); bubble.appendChild(barOuter);
      const limit = Math.max(1, Math.min(8, Number(this.getPref("maxParallelTools")) || 3));
      let doneU = 0;
      const paint = () => { const pct = Math.round((doneU / units.length) * 100); barFill.style.width = pct + "%"; label.textContent = "翻译中… 已完成 " + doneU + " / " + units.length + " 段（" + pct + "%）· 并发 " + limit; };
      paint();
      this.setStatus(state, "翻译中…", "busy");
      const trans = new Map();
      // Bounded-concurrency pool; each batch carries read-only neighbor context so
      // cross-boundary references & terminology stay consistent despite parallelism.
      let nextI = 0;
      const worker = async () => {
        while (!state.cancel) {
          const i = nextI++; if (i >= batches.length) break;
          try {
            const nc = this._neighborContext(units, batches, i, 2);
            const res = await this._streamAnswer(
              [{ role: "system", content: this._buildTranslatePrompt(target) }, { role: "user", content: this._batchPayload(batches[i], nc.prev, nc.next) }],
              null, () => {}, () => state.cancel, {},
            );
            for (const [n, t] of this._parseTranslations(res.text || "")) trans.set(n, t);
          } catch (e) { this.log("trans batch " + i + ": " + e); }
          doneU += batches[i].length; paint();
        }
      };
      await Promise.all(Array.from({ length: Math.min(limit, batches.length) }, () => worker()));
      if (state.cancel) { bubble.textContent = "（已停止）"; return; }
      const title = this._shareBaseName(state);
      const md = this._interleaveBilingual(title, units, trans);
      // Deliver the bilingual result as a CHILD ATTACHMENT (like zotero-pdf2zh):
      // a standalone HTML file under the item, opens in Zotero and syncs — instead
      // of polluting the item's notes.
      this.setStatus(state, "正在保存双语文档…", "busy");
      const html = this._bilingualHtmlDoc(title, units, trans);
      let att = null;
      try { att = await this._attachHtml(state, title + " · 双语对照", html); } catch (e) { this.log("attach bilingual: " + e); }
      bubble.textContent = "";
      const row = this._el(state.doc, "div", "aireader-actions"); msg.appendChild(row);
      const mk = (lbl) => { const a = this._el(state.doc, "span", "aireader-action", lbl); row.appendChild(a); return a; };
      if (att) {
        bubble.appendChild(this._el(state.doc, "div", "aireader-meta", "双语对照已生成（" + units.length + " 段），已作为子附件「" + title + " · 双语对照」挂到本条目，可在条目下打开。"));
        const open = mk("打开");
        open.addEventListener("click", () => this._viewAttachment(att));
      } else {
        // fallback: no parent item to attach to → offer file save
        bubble.appendChild(this._el(state.doc, "div", "aireader-meta", "双语对照已生成（" + units.length + " 段）。"));
        const save = mk("保存到文件");
        save.addEventListener("click", async () => { save.textContent = "保存中…"; try { const p = await this._writeShareFile(state, "双语.html", html); this._openFile(p); save.textContent = "✓ 已保存"; } catch (e) { save.textContent = "保存失败"; } });
      }
      const copy = mk("复制文本");
      copy.addEventListener("click", () => { try { Zotero.Utilities.Internal.copyTextToClipboard(md); copy.textContent = "已复制"; setTimeout(() => (copy.textContent = "复制文本"), 1200); } catch (e) {} });
      // Durable record: survives restart; attachment ref syncs across machines.
      const tArtifact = (att && att.key) ? { kind: "attachment", key: att.key, label: "打开双语对照" } : null;
      this._persistArtifact(state, "🌐 已生成全文双语翻译（" + units.length + " 段）", tArtifact);
      this.setStatus(state, "", "");
    } catch (e) {
      bubble.textContent = state.cancel ? "（已停止）" : this._friendlyError(e);
      this.log("generateTranslation error: " + e);
    } finally {
      this._stopWait(state); state.streaming = false; this.updateSendButton(state);
    }
  },
});
