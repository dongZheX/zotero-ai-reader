/* capture.js — render generated share HTML to a PNG so the model can SEE its
 * own layout and fix it. Uses Zotero's own offscreen HiddenBrowser + the
 * drawSnapshot→canvas→toDataURL path (same primitive tabs.js uses for tab
 * thumbnails). Plus the single-image visual QA call. The review/fix ORCHESTRATION
 * (which units to re-generate) lives in share.js, which owns the prompts/context.
 * Loaded after ui.js; Object.assign onto AIReader. Methods call this.* siblings
 * (this._deckBaseCss, this._articleCss, this.buildVisionMessages, this.callLLM).
 */

Object.assign(AIReader, {
  // --- pure: fit (w,h) within a max long-edge, returns target size + scale ---
  _fitEdge(w, h, maxEdge) {
    const m = Math.max(w, h);
    if (!maxEdge || m <= maxEdge) return { w: w, h: h, scale: 1 };
    const scale = maxEdge / m;
    return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)), scale: scale };
  },

  // --- render a self-contained HTML string to a PNG data URI (offscreen) ---
  // opts: { width, height, maxEdge=1536, scale=1, settleMs=450 }
  async _renderHtmlToPng(html, opts) {
    opts = opts || {};
    const W = opts.width || 1920, H = opts.height || 1080;
    const maxEdge = opts.maxEdge != null ? opts.maxEdge : 1536;
    const win = Zotero.getMainWindow();
    if (!win) throw new Error("无主窗口，无法截图");
    const XHTML = "http://www.w3.org/1999/xhtml";
    const { HiddenBrowser } = ChromeUtils.importESModule("chrome://zotero/content/HiddenBrowser.mjs");
    const dataURL = "data:text/html;charset=utf-8," + encodeURIComponent(html);
    const hb = new HiddenBrowser();
    try {
      await hb.load(dataURL);
      if (typeof hb.waitForDocument === "function") await hb.waitForDocument();
      await new Promise((r) => win.setTimeout(r, opts.settleMs != null ? opts.settleMs : 450)); // fonts/images/paint settle
      const br = hb._browser || hb.browser;
      const wg = br && br.browsingContext && br.browsingContext.currentWindowGlobal;
      if (!wg || typeof wg.drawSnapshot !== "function") throw new Error("drawSnapshot 不可用");
      const bitmap = await wg.drawSnapshot(new win.DOMRect(0, 0, W, H), opts.scale || 1, "white");
      const canvas = win.document.createElementNS(XHTML, "canvas");
      canvas.width = W; canvas.height = H;
      canvas.getContext("2d").drawImage(bitmap, 0, 0);
      try { bitmap.close(); } catch (e) {}
      const fit = this._fitEdge(W, H, maxEdge);
      let outCanvas = canvas;
      if (fit.scale < 1) {
        const c2 = win.document.createElementNS(XHTML, "canvas");
        c2.width = fit.w; c2.height = fit.h;
        c2.getContext("2d").drawImage(canvas, 0, 0, fit.w, fit.h);
        outCanvas = c2;
      }
      return outCanvas.toDataURL("image/png");
    } finally {
      try { hb.destroy(); } catch (e) {}
    }
  },

  // --- wrap ONE slide's <section> into a standalone 1920×1080 capture doc ---
  // Reuses _deckBaseCss (now carries the figure/img clamps) + the preset :root
  // vars + fonts, but renders the slide statically (no deck-stage runtime, no
  // scaling) so a single slide fills the 1920×1080 frame for the screenshot.
  _deckSlideCaptureHtml(slideHtml, presetVarsCss, fontsLink) {
    const fonts = fontsLink ? '<link rel="stylesheet" href="' + fontsLink + '"/>\n' : "";
    const capCss = "html,body{margin:0;padding:0}deck-stage{display:block}deck-stage section{display:block;position:relative;width:1920px;height:1080px;transform:none}";
    return "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\"/>\n" + fonts +
      "<style>\n" + this._deckBaseCss + "\n" + (presetVarsCss || "") + "\n" + capCss + "\n</style>\n</head>\n<body>\n" +
      "<deck-stage>" + (slideHtml || "") + "</deck-stage>\n</body>\n</html>\n";
  },

  // --- wrap ONE article <section> into a standalone capture doc (fixed width) ---
  _articleSectionCaptureHtml(sectionHtml) {
    const capCss = "body{padding:28px;background:var(--paper);}.cap-wrap{max-width:1040px;margin:0 auto;}";
    return "<!DOCTYPE html>\n<html lang=\"zh-CN\">\n<head>\n<meta charset=\"UTF-8\"/>\n" +
      "<style>\n" + this._articleCss() + "\n" + capCss + "\n</style>\n</head>\n<body>\n" +
      "<div class=\"cap-wrap\">" + (sectionHtml || "") + "</div>\n</body>\n</html>\n";
  },

  // --- visual QA prompt for ONE rendered unit (returns strict JSON) ---
  _visualReviewPrompt(kind) {
    const what = kind === "deck" ? "一张放映幻灯片（固定 1920×1080 画布）" : "一篇深度长文中的一个章节";
    return "你是排版质检员。下面是" + what + "**渲染后的真实截图**。只判断排版/版面是否有明显问题：" +
      "图片溢出画布或被裁掉、图片过大顶掉文字、图文重叠、文字被截断或挤出边界、大片空白严重失衡、元素错位或超出容器。" +
      "不要评价文字内容质量、措辞或配色偏好，只看版面。\n" +
      "只输出一个 JSON 对象，不要任何多余文字或 ``` 围栏：\n" +
      '排版没问题 → {"ok":true}\n' +
      '有问题 → {"ok":false,"issue":"一句话说清具体排版问题","fix":"具体怎么改（如：把图片 max-height 调小/改成两栏/减少要点条数/缩小字号/让图居中限高）"}';
  },

  // --- parse the review verdict JSON (tolerant of ``` fences / stray text) ---
  _parseReviewVerdict(text) {
    const s = String(text || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
    let obj = null;
    try { obj = JSON.parse(s); } catch (e) {
      const m = s.match(/\{[\s\S]*\}/);
      if (m) { try { obj = JSON.parse(m[0]); } catch (e2) {} }
    }
    if (!obj || typeof obj !== "object") return { ok: true, issue: "", fix: "" }; // unparseable → treat as OK (don't loop)
    return { ok: obj.ok !== false, issue: String(obj.issue || ""), fix: String(obj.fix || "") };
  },

  // --- review ONE unit visually: screenshot already taken → ask the model ---
  async _reviewUnitVisually(kind, pngDataURI) {
    const lang = this.getPref("language") || "中文";
    const messages = this.buildVisionMessages(this._fmt(), lang, this._visualReviewPrompt(kind), pngDataURI);
    const ans = await this.callLLM(messages);
    return this._parseReviewVerdict(ans);
  },

  // --- can the model ACTUALLY read an image? probe once, cache result ---
  // Must verify the model truly SEES the picture — a trivial "reply OK" prompt is
  // a false positive (a text-only model like ERNIE-Flash answers OK without ever
  // receiving the image, which would make the review loop "fix" every page from a
  // blank read and wreck the content). So we render a known number and require the
  // model to read it back; mismatch / throw ⇒ no vision ⇒ degrade to CSS-only.
  async _visionAvailable() {
    if (this._visionProbe != null) return this._visionProbe;
    try {
      const code = "73"; // arbitrary two-digit token the model must read off the image
      const html = '<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="margin:0;background:#cc0000"><div style="font:bold 240px sans-serif;color:#fff;text-align:center;padding-top:70px">' + code + '</div></body></html>';
      const png = await this._renderHtmlToPng(html, { width: 420, height: 420, maxEdge: 420 });
      const lang = this.getPref("language") || "中文";
      const msgs = this.buildVisionMessages(this._fmt(), lang, "这张图里显示的数字是什么？只回答那个数字本身，不要任何其它文字。", png);
      const ans = String((await this.callLLM(msgs)) || "");
      this._visionProbe = ans.indexOf(code) >= 0;
      if (!this._visionProbe) this.log("vision probe: model could not read the image (ans=" + ans.slice(0, 80) + ") → visual review disabled");
    } catch (e) {
      this.log("vision probe failed: " + (e && e.message) + " → visual review disabled");
      this._visionProbe = false;
    }
    return this._visionProbe;
  },
});
