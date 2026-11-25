/* share-agent.js — agentShare: a model-driven agent loop that BUILDS the share
 * HTML itself (deck or deep article) instead of a fixed outline→per-unit→review
 * pipeline. The model plans, reads the paper, writes each unit, SEES the real
 * rendered screenshot (render_preview → multimodal tool_result), fixes layout on
 * its own judgement, repeats, then finalize()s. Replaces _runArticleShare /
 * _runDeckShare / _reviewAndFix (those fixed-orchestration methods are retired).
 *
 * Reuses: the read tools (list_sections/read_section/list_figures/view_figure)
 * via _execTool; net.js tool plumbing (_toolBody/_parseToolCalls/
 * _pushAssistantToolTurn/_pushToolResults, now multimodal); capture.js
 * (_embedFigures via resolver, _deckSlideCaptureHtml/_articleSectionCaptureHtml,
 * _renderHtmlToPng, _visionAvailable); share.js builders (_finishShareArticle/
 * _finishShareDeck → _embedFigures / _assembleArticleHtml / _assembleDeckHtml /
 * _writeShareFile / _persistArtifact).
 * Loaded after capture.js; Object.assign onto AIReader.
 */

Object.assign(AIReader, {
  // ---- neutral tool declarations for the share agent (shaped by _shapeTools) ----
  _shareAgentToolDecls(kind, canSee, opts) {
    const isDeck = kind === "deck";
    const unit = isDeck ? "幻灯页" : "章节";
    // opts: { sections, figures } — sections need text (always on a real doc),
    // figures need page geometry (PDF only). HTML/snapshot: sections yes, figures no.
    const o = opts || {};
    const sections = o.sections !== false, figures = o.figures !== false;
    const T = [];
    if (sections) {
      T.push(
        { name: "list_sections", description: "列出论文的章节大纲（标题、页码、句子数）。先调用它了解结构。", parameters: { type: "object", properties: {}, required: [] } },
        { name: "read_section", description: "读取某一章节的全部句子，返回每句的 id、页码、文本。index 来自 list_sections。", parameters: { type: "object", properties: { index: { type: "integer", description: "章节序号" } }, required: ["index"] } },
      );
    }
    if (figures) {
      T.push(
        { name: "list_figures", description: "列出论文中的图/表（id、页码、标题）。想引用某张图就先用它找到 id。", parameters: { type: "object", properties: {}, required: [] } },
        { name: "view_figure", description: "查看某张图/表的视觉内容：渲染该区域并用多模态模型识读，返回文字描述。id 来自 list_figures。", parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
      );
    }
    T.push(
      { name: "write_unit", description: "写第 index 个" + unit + "（index 从 0 连续递增）。html 为单个 <section>（" + (isDeck ? "class=\"slide\"，封面加 title-slide" : "带 id=\"secN\"") + "，不要 <html>/<style>/其它单元/``` 围栏）。用同一 index 再调用即覆盖该" + unit + "。", parameters: { type: "object", properties: { index: { type: "integer", description: "单元序号，从 0 起" }, title: { type: "string", description: "该单元短标题（用于目录/进度）" }, html: { type: "string", description: "单个 <section> 的 HTML" } }, required: ["index", "html"] } },
    );
    if (canSee) T.push({ name: "render_preview", description: "把第 index 个" + unit + "按真实样式/画布渲染成截图回给你看，用于自查排版（溢出/裁切/图文重叠/文字截断/留白失衡/错位）。发现问题就改写该 index 再复查。", parameters: { type: "object", properties: { index: { type: "integer" } }, required: ["index"] } });
    T.push({ name: "finalize", description: "所有" + unit + "都写好、排版干净后调用：组装成完整 HTML、落盘、结束。", parameters: { type: "object", properties: { title: { type: "string", description: "文档标题" }, tldr: { type: "string", description: "一句话总述（可选）" }, tags: { type: "array", items: { type: "string" }, description: "关键词（可选）" } }, required: [] } });
    return T;
  },

  // Force a <section>'s id to secN so the article side-nav links resolve
  // regardless of what id the model wrote (deck ignores ids).
  _forceSectionId(html, id) {
    const h = String(html || "").trim();
    const m = /^<section\b([^>]*)>/i.exec(h);
    if (!m) return h;
    let attrs = m[1];
    if (/\bid\s*=/.test(attrs)) attrs = attrs.replace(/\bid\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/i, 'id="' + id + '"');
    else attrs = ' id="' + id + '"' + attrs;
    return h.replace(m[0], "<section" + attrs + ">");
  },
  _sectionTitle(html, fallback) {
    const m = /<h[1-3][^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html || "");
    return m ? m[1].replace(/<[^>]+>/g, "").trim() : (fallback || "");
  },
  // units map (index→{title,html}) → array sorted by numeric index.
  _sortedUnits(units) {
    return Object.keys(units || {}).map(Number).filter((n) => !isNaN(n)).sort((a, b) => a - b).map((i) => units[i]);
  },

  // The share agent's own tool executor: handle write_unit/render_preview/
  // finalize; delegate the paper-reading tools to the shared _execTool.
  async _execShareTool(state, c, call) {
    const name = call.name, args = call.args || {};
    if (name === "write_unit") {
      if (c.maxWrites && c.writes >= c.maxWrites) return { output: JSON.stringify({ error: "write limit reached" }), render: { label: "写入", outcome: "✕ 已达上限" } };
      const idx = parseInt(args.index, 10);
      if (isNaN(idx) || idx < 0) return { output: JSON.stringify({ error: "index must be a non-negative integer" }), render: { label: "写入", outcome: "✕ index 非法" } };
      let html = this._stripHtmlFence(args.html || "");
      if (!/^<section\b/i.test(html)) return { output: JSON.stringify({ error: "html must be a single <section>…</section>" }), render: { label: "写入", brief: "#" + idx, outcome: "✕ 非 <section>" } };
      const fresh = !(idx in c.units);
      c.writes++;
      const title = (args.title || this._sectionTitle(html, (c.kind === "deck" ? "第" + (idx + 1) + "页" : "第" + (idx + 1) + "节")));
      c.units[idx] = { title: title, html: html };
      const n = this._sortedUnits(c.units).length;
      return { output: JSON.stringify({ ok: true, index: idx, totalUnits: n, overwrote: !fresh }), render: { label: (c.kind === "deck" ? "写幻灯" : "写章节"), brief: "#" + idx + " " + title, outcome: (fresh ? "→ 已写入" : "↻ 已覆盖"), bodyText: html } };
    }
    if (name === "render_preview") {
      if (!c.canSee) return { output: JSON.stringify({ error: "preview unavailable (model has no vision)" }), render: { label: "预览", outcome: "✕ 无视觉" } };
      if (c.maxPreviews && c.previews >= c.maxPreviews) return { output: JSON.stringify({ error: "preview limit reached" }), render: { label: "预览", outcome: "✕ 已达上限" } };
      const idx = parseInt(args.index, 10);
      const u = c.units[idx];
      if (!u) return { output: JSON.stringify({ error: "no unit at index " + idx + "; write_unit it first" }), render: { label: "预览", brief: "#" + idx, outcome: "✕ 无此单元" } };
      try {
        c.previews++;
        const embedded = this._svgFencesToInline(await this._embedFigures(u.html, c.resolver));
        const W = c.kind === "deck" ? 1920 : 1040, H = c.kind === "deck" ? 1080 : 1800;
        const capHtml = c.kind === "deck" ? this._deckSlideCaptureHtml(embedded, c.presetVars, c.fonts) : this._articleSectionCaptureHtml(embedded);
        const png = await this._renderHtmlToPng(capHtml, { width: W, height: H });
        const text = "第 " + idx + " 个" + (c.kind === "deck" ? "幻灯页" : "章节") + "「" + u.title + "」的真实渲染截图如下。请检查排版：是否溢出画布、图被裁切、图文重叠、文字被截断、大片空白失衡、元素错位。有问题就用同一 index 重新 write_unit 修正后再 render_preview 复查；没问题就继续。";
        return { output: { text: text, images: [png] }, render: { label: "预览", brief: "#" + idx + " " + u.title, outcome: "→ 已看真图" } };
      } catch (e) { return { output: JSON.stringify({ error: "render failed: " + String(e && e.message || e) }), render: { label: "预览", brief: "#" + idx, outcome: "✕ 渲染失败" } }; }
    }
    if (name === "finalize") {
      c.finalizeArgs = { title: args.title || "", tldr: args.tldr || "", tags: Array.isArray(args.tags) ? args.tags : [] };
      const n = this._sortedUnits(c.units).length;
      return { output: JSON.stringify({ ok: true, units: n }), render: { label: "定稿", outcome: "✓ " + n + " 单元" }, finish: true };
    }
    return this._execTool(state, c, call);
  },

  // ---- the agent loop (replaces _runArticleShare / _runDeckShare) ----
  async agentShare(state, bubble, msg, lang, engine) {
    const kind = engine.engine; // "article" | "deck"
    const fmt = this._fmt();
    const blocks = state.blocks;
    const sections = this._buildSections(blocks);
    const byId = new Map((blocks || []).map((b) => [b.id, b]));
    const caps = this._docCaps(state.attachment); // PDF: regions true; HTML/snapshot: false
    const figList = caps.regions ? this._figureListText(blocks) : "（无）"; // no renderable figures without page geometry
    const preset = kind === "deck" ? this._deckPreset(engine.preset) : null;
    const styleNote = kind === "article" ? this._articleVoice(engine.style) : "";
    const canSee = await this._visionAvailable();

    bubble.classList.remove("aireader-streaming"); bubble.textContent = "";
    const doc = state.doc;
    const unitWord = kind === "deck" ? "页" : "节";
    const headline = this._el(doc, "div", "aireader-agent-sum", "🔧 正在生成" + (kind === "deck" ? "放映幻灯" : "深度长文") + "…" + (canSee ? "" : "（当前模型不支持看图，跳过真图自检）"));
    bubble.appendChild(headline);
    // Compact progress UI (no raw tool-call timeline): one status line + a live
    // per-unit checklist whose rows update in place as units are written / previewed.
    const statusRow = this._el(doc, "div", "aireader-share-wait", "正在通读论文…"); bubble.appendChild(statusRow);
    const list = this._el(doc, "div", "aireader-share-checklist"); bubble.appendChild(list);
    const unitRows = {}; // index -> row element (kept sorted by index)
    const upsertUnit = (idx, title, seen) => {
      let r = unitRows[idx];
      if (!r) {
        r = this._el(doc, "div", "aireader-share-step");
        // insert in index order
        let before = null;
        for (const k of Object.keys(unitRows).map(Number).sort((a, b) => a - b)) { if (k > idx) { before = unitRows[k]; break; } }
        if (before) list.insertBefore(r, before); else list.appendChild(r);
        unitRows[idx] = r;
      }
      r.className = "aireader-share-step aireader-share-step-done";
      r.textContent = "✓ 第 " + (idx + 1) + " " + unitWord + "：" + (title || "") + (seen ? " 👁" : "");
    };
    // Scroll so this generation block's TOP sits at the top of the scroller
    // (not pinned to the bottom) — robust to the section being short.
    const anchorTop = () => { try { const d = msg.getBoundingClientRect().top - state.chatMsgs.getBoundingClientRect().top; state.chatMsgs.scrollTop += (d - 6); } catch (e) {} };

    const MAX_TURNS = 60, MAX_READS = 80, MAX_WRITES = 40, MAX_PREVIEWS = 40;
    const rd = this._docReader(state.attachment);
    const resolver = async (id) => { const b = (blocks || []).find((x) => x.id === id); if (!b) return null; try { return await rd.renderRegion(state.attachment, b); } catch (e) { return null; } };
    const c = {
      sections, byId, reads: 0, maxReads: MAX_READS,
      units: {}, writes: 0, maxWrites: MAX_WRITES, previews: 0, maxPreviews: MAX_PREVIEWS,
      kind, preset, presetVars: preset && preset.rootVars, fonts: preset && preset.fonts,
      resolver, canSee, finalizeArgs: null, execTool: this._execShareTool,
    };
    const setHead = (done) => { headline.textContent = (done || ("🔧 正在生成" + (kind === "deck" ? "放映幻灯" : "深度长文") + "…")) + " · 已写 " + this._sortedUnits(c.units).length + " 个" + unitWord + (c.previews ? " · 校对 " + c.previews + " 次" : ""); };

    // HTML / web-snapshot papers have no page geometry → no sections/figures to
    // read. Drop those dead tools and inject the full text directly so the model
    // still has material to write from.
    const structural = sections.length > 0;
    const sys = this._shareAgentPrompt(kind, lang, figList, preset, styleNote, canSee);
    const flowHint = structural ? "先 list_sections 了解结构，再逐" + unitWord + " write_unit，" : "下面已给出全文，直接逐" + unitWord + " write_unit，";
    let firstUser = (kind === "deck" ? "请为这篇论文做一套放映幻灯。" : "请为这篇论文写一篇图文并茂的深度长文。") + flowHint + (canSee ? "用 render_preview 看真实渲染效果、发现问题就改，" : "") + "最后 finalize。";
    if (!structural) { try { firstUser += "\n\n论文正文：\n\n" + this.buildContextBounded(blocks); } catch (e) {} }
    const messages = [{ role: "system", content: sys }, { role: "user", content: firstUser }];
    const tools = this._shapeTools(fmt, this._shareAgentToolDecls(kind, canSee, { sections: structural, figures: caps.regions }));

    let finalized = false;
    try {
      let nudged = false;
      for (let turn = 0; turn < MAX_TURNS && !finalized; turn++) {
        if (state.cancel) break;
        if (c.writes >= c.maxWrites) { statusRow.textContent = "已达写入上限，正在定稿…"; }
        this.setStatus(state, "生成中… 第 " + (turn + 1) + " 步", "busy");
        let data;
        try {
          const resp = await this._fetchLLM(this._endpointFor(fmt), { method: "POST", headers: this._headersFor(fmt), body: this._toolBody(fmt, messages, tools) });
          const raw = await resp.text();
          if (!resp.ok) throw this._fail(resp, raw);
          data = this._parseOrThrow(raw);
          if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        } catch (e) { this.log("agentShare turn error: " + e); statusRow.textContent = "请求失败：" + String(e.message || e).slice(0, 80); break; }
        const parsed = this._parseToolCalls(fmt, data);
        if (!parsed.calls.length) {
          // No tool call: nudge once if nothing written yet, else treat the plain
          // reply as the model deciding it's done (fall back to finalize).
          if (!nudged && this._sortedUnits(c.units).length === 0) { nudged = true; this._pushAssistantToolTurn(fmt, messages, parsed); messages.push({ role: "user", content: "请使用工具：" + (structural ? "先 list_sections，再逐个 write_unit，" : "直接逐个 write_unit，") + (canSee ? "用 render_preview 自查，" : "") + "最后 finalize。" }); continue; }
          break;
        }
        this._pushAssistantToolTurn(fmt, messages, parsed);
        const results = [];
        const slots = await this._runToolCalls(state, c, parsed.calls);
        parsed.calls.forEach((call, i) => {
          const r = slots[i];
          const okCall = !(r.render && /✕/.test(r.render.outcome || ""));
          // Compact progress: only unit writes/previews touch the checklist; the
          // paper-reading tools just update the one status line (no per-call rows).
          if (call.name === "write_unit" && okCall) { const idx = parseInt(call.args.index, 10); if (!isNaN(idx)) { upsertUnit(idx, (c.units[idx] && c.units[idx].title) || call.args.title, false); statusRow.textContent = "已写第 " + (idx + 1) + " " + unitWord + "，继续…"; } }
          else if (call.name === "render_preview" && okCall) { const idx = parseInt(call.args.index, 10); if (!isNaN(idx)) { upsertUnit(idx, c.units[idx] && c.units[idx].title, true); statusRow.textContent = "校对第 " + (idx + 1) + " " + unitWord + "…"; } }
          else if (call.name === "finalize") { statusRow.textContent = "正在定稿…"; }
          else if (call.name === "read_section" || call.name === "list_sections" || call.name === "list_figures") { statusRow.textContent = "正在通读论文…"; }
          else if (call.name === "view_figure") { statusRow.textContent = "正在看论文图表…"; }
          results.push({ id: call.id, name: call.name, output: r.output });
          if (r.finish) finalized = true;
        });
        setHead();
        this._pushToolResults(fmt, messages, results);
        anchorTop(); // keep the headline + checklist readable from the top (the
        // section can be short when stacked below other sidebar panels — pinning
        // to the bottom would bury everything but the last row)
      }

      const units = this._sortedUnits(c.units);
      if (state.cancel && !finalized) { bubble.appendChild(this._el(doc, "div", "aireader-meta", "（已停止）")); return; }
      if (!units.length) { headline.textContent = "未生成任何内容"; this.setStatus(state, "未生成内容。", "error"); return; }

      // Assemble + write via the existing finish builders (golden-covered).
      const fa = c.finalizeArgs || {};
      try { statusRow.remove(); } catch (e) {}
      setHead("✓ 生成完成");
      this.setStatus(state, "正在组装…", "busy");
      if (kind === "deck") {
        await this._finishShareDeck(state, bubble, msg, units.map((u) => u.html).join("\n"), engine, preset);
      } else {
        const navSections = units.map((u, i) => ({ id: "sec" + i, title: u.title || this._sectionTitle(u.html, "第" + (i + 1) + "节") }));
        const outline = { title: fa.title || this._shareBaseName(state), tldr: fa.tldr || "", tags: fa.tags || [], sections: navSections };
        const sectionHtmls = units.map((u, i) => this._forceSectionId(u.html, "sec" + i));
        await this._finishShareArticle(state, bubble, msg, outline, sectionHtmls, engine);
      }
      headline.textContent = (finalized ? "✓ " : "✓（自动定稿）") + "已生成" + (kind === "deck" ? "放映幻灯 " : "深度长文 ") + units.length + " 个" + (kind === "deck" ? "页" : "节") + (c.previews ? " · 看图自检 " + c.previews + " 次" : "");
      anchorTop(); // show the result from the top (headline + checklist + 打开按钮)
    } catch (e) {
      headline.textContent = "出错：" + (e.message || e);
      this.log("agentShare error: " + e);
    }
  },
});
