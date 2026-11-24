/* annotate.js — everything that writes to the PDF/attachment: the tool-calling
 * "read & annotate" agent (agentAnnotate) with its live summary + undo/redo, the
 * low-level annotation writers (sortIndex / getUserAnnotations / applyAnnotation /
 * annotateSelection), directive application (autoApplyDirectives, parsing the
 * model's [[hl]]/[[note]] markers), and annotation removal. Loaded after
 * aireader.js; Object.assign onto the global AIReader — pure move out of
 * aireader.js, no behavior change. Methods still call this.* siblings in the
 * core (e.g. this.callLLMStream, this.buildContext, this._agentTools).
 */

Object.assign(AIReader, {
  // Delete an annotation created by the apply button (toggle-off). Resolves the
  // real Item by eraseTx-capable ref, then by key via getByLibraryAndKey, then
  // by scanning the attachment's annotations for the key. Throws if not found
  // so the UI can keep the applied state instead of pretending it was removed.
  async removeAnnotation(ann, attachment) {
    if (!ann || ann === true) return;
    const canErase = (x) => x && typeof x.eraseTx === "function";
    let item = canErase(ann) ? ann : (canErase(ann.item) ? ann.item : null);
    const libraryID = ann.libraryID || (ann.item && ann.item.libraryID) || (attachment && attachment.libraryID);
    const key = ann.key || (ann.item && ann.item.key);
    if (!item && key && libraryID && Zotero.Items && typeof Zotero.Items.getByLibraryAndKey === "function") {
      const it = Zotero.Items.getByLibraryAndKey(libraryID, key);
      if (canErase(it)) item = it;
    }
    if (!item && key && attachment && typeof attachment.getAnnotations === "function") {
      for (let a of (attachment.getAnnotations() || [])) {
        if (typeof a === "number") a = Zotero.Items.get(a);
        if (a && a.key === key) { if (canErase(a)) item = a; break; }
      }
    }
    if (item) { await item.eraseTx(); return; }
    if (ann.id != null && Zotero.Items && typeof Zotero.Items.erase === "function") { await Zotero.Items.erase(ann.id); return; }
    throw new Error("找不到对应标注");
  },

  // Erase EVERY AI-created annotation sitting at this block's spot (same
  // sortIndex + "AI" tag). "应用划线" and "应用批注" each create a separate
  // highlight at the same position, so a single eraseTx leaves one behind and
  // the PDF still looks highlighted. This clears the whole stack in one go.
  // Returns the number erased (0 = nothing to remove, caller falls back).
  async removeAnnotationsForBlock(attachment, block) {
    if (!attachment || !block || !block.position || typeof attachment.getAnnotations !== "function") return 0;
    const si = this.sortIndex(block);
    let removed = 0;
    for (let a of (attachment.getAnnotations() || [])) {
      if (typeof a === "number") a = Zotero.Items.get(a);
      if (!a || typeof a.eraseTx !== "function") continue;
      if (!(a.hasTag && a.hasTag("AI"))) continue;
      if (a.annotationSortIndex !== si) continue;
      try { await a.eraseTx(); removed++; } catch (e) { this.log("sweep erase: " + e); }
    }
    return removed;
  },

  // Parse [[hl:id]] / [[note:id|why]] directives (optionally prefixed by a
  // category word) and write them as real annotations. Deduped by block —
  // hl + note for the same block become ONE highlight carrying the note, and a
  // block already annotated by us is skipped (idempotent). An optional
  // `category` from the text colours the highlight. Returns { count, keys }.
  async autoApplyDirectives(state, text, opts) {
    opts = opts || {};
    const byId = new Map((state.blocks || []).map((b) => [b.id, b]));
    // category word may appear just before the directive, e.g. "method [[hl:12]]"
    const re = /(?:\b(contribution|method|result|limitation|keyterm)\b[^\[]{0,40})?\[\[(hl|note):B?(\d+)(?:\|([^\]]*))?\]\]/gi;
    // Merge directives per block id so one block yields at most one annotation.
    const perBlock = new Map();
    let m;
    while ((m = re.exec(text)) !== null) {
      const cat = m[1] ? m[1].toLowerCase() : null;
      const id = Number(m[3]);
      const note = m[2].toLowerCase() === "note" ? (m[4] || "") : "";
      const cur = perBlock.get(id) || { comment: "", category: null };
      if (note && !cur.comment) cur.comment = note;
      if (cat && !cur.category) cur.category = cat;
      perBlock.set(id, cur);
    }
    const cap = opts.cap || Infinity;
    let n = 0; const keys = []; const applied = [];
    for (const [id, info] of perBlock) {
      if (n >= cap) break;
      const block = byId.get(id);
      if (!block || !block.position) continue;
      if (this._existingAIKeyAt(state.attachment, block)) continue; // idempotent
      const category = opts.forceCategory || info.category || null;
      const color = this.colorForCategory(category);
      try {
        const r = await this.applyAnnotation(state.attachment, block, { type: "highlight", comment: info.comment, color });
        if (r && r.key) keys.push(r.key);
        // carry enough to recreate on redo
        applied.push({ key: r && r.key, category, blockId: id, pageLabel: block.pageLabel, comment: info.comment, color });
        n++;
      } catch (e) { this.log("autoApply error: " + e); }
    }
    return { count: n, keys, applied };
  },

  // A tool-calling agent: the model LISTS the paper's sections, READS the ones
  // it chooses, and HIGHLIGHTs specific sentences — via native function-calling.
  // The tool-interaction process is shown live in the bubble.
  async agentAnnotate(state) {
    if (!this.requireKey(state)) return;
    if (state.streaming) return;
    const deep = !!this._deepRead;
    const MAX_TURNS = deep ? 80 : 30, MAX_ANN = deep ? 120 : 60, MAX_READS = deep ? 200 : 40;
    await this.ensureBlocks(state);
    const sections = this._buildSections(state.blocks);
    if (!sections.length) { this.setStatus(state, "无法提取正文结构，无法通读。", "error"); return; }
    const lang = this.getPref("language") || "中文";
    const fmt = this._fmt();
    const byId = new Map((state.blocks || []).map((b) => [b.id, b]));

    this.appendUserMsg(state, "AI 通读并标注全文");
    const { bubble } = this.appendAssistantMsg(state);
    state.streaming = true; state.cancel = false; this.updateSendButton(state);
    const headline = this._el(state.doc, "div", "aireader-agent-sum", "🔧 正在阅读并标注…");
    bubble.appendChild(headline);
    const logWrap = this._el(state.doc, "div", "aireader-toollog");
    bubble.appendChild(logWrap);

    const run = { keys: [], applied: [], at: Date.now() };
    const tally = {};
    const grp = {}; // groups consecutive same-type tool blocks into "× N"
    const c = { sections, byId, run, tally, reads: 0, maxReads: MAX_READS, maxAnn: MAX_ANN };
    let steps = 0;
    const setHead = () => { headline.textContent = "🔧 阅读并标注中… 第 " + steps + " 步 · 已标注 " + run.keys.length + " 处"; };

    const sys = "你是论文精读助手，用" + lang + "工作。任务：通读这篇论文，并在 PDF 里高亮关键句、加简短批注。\n" +
      "工具：list_sections 看章节结构；read_section 读你选的章节拿到每句 id；highlight 高亮某个句子 id 并给类别和一句话理由；list_figures 列出图表；view_figure 识读某张图/表的视觉内容。" +
      ((this.getPref("serperKey") || "").trim() ? "需要核对背景、术语或相关工作时，可用 web_search 联网搜索、web_fetch 抓取网页。\n" : "需要抓取网页正文时可用 web_fetch。\n") +
      "流程：先 list_sections；再对值得读的章节逐个 read_section；遇到被正文引用的重要图/表，用 list_figures + view_figure 看懂再判断；对真正关键的句子调用 highlight（每节通常 2-6 句，务必精选，避免过度标注）；覆盖重要章节后调用 finish 结束。\n" +
      (deep ? "【深读模式】务必遍历所有章节（对每个 section 都 read_section，不要跳过），并对每张图/表 view_figure；在此基础上更充分地标注。\n" : "") +
      "类别只能是 contribution / method / result / limitation / keyterm。highlight 的 id 必须来自 read_section 返回的 id。" +
      (this.currentSkill().agentInject ? ("\n" + this.currentSkill().agentInject) : "") + this._priorContextForKey(state.attachment && state.attachment.key);
    const messages = [{ role: "system", content: sys }, { role: "user", content: (deep ? "请深读本论文（遍历所有章节 + 看所有图表）并标注关键句。先调用 list_sections。" : "请通读本论文并标注关键句。先调用 list_sections。") }];
    const tools = this._toolSchemas(fmt);

    try {
      let finished = false, nudged = false;
      for (let turn = 0; turn < MAX_TURNS && !finished; turn++) {
        if (state.cancel) break;
        if (run.keys.length >= MAX_ANN) { this._renderToolBlock(state, logWrap, { label: "提示", outcome: "已达标注上限" }); break; }
        this.setStatus(state, "阅读中… 第 " + (turn + 1) + " 步", "busy");
        let data;
        try {
          const resp = await this._fetchLLM(this._endpointFor(fmt), { method: "POST", headers: this._headersFor(fmt), body: this._toolBody(fmt, messages, tools) });
          const raw = await resp.text();
          if (!resp.ok) throw this._fail(resp, raw);
          data = this._parseOrThrow(raw);
          if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
        } catch (e) { this.log("agent turn error: " + e); this._renderToolBlock(state, logWrap, { label: "请求失败", outcome: String(e.message || e).slice(0, 80) }); break; }
        const parsed = this._parseToolCalls(fmt, data);
        if (!parsed.calls.length) {
          if (!nudged && run.keys.length === 0) { nudged = true; this._pushAssistantToolTurn(fmt, messages, parsed); messages.push({ role: "user", content: "请使用工具：先 list_sections，再 read_section，然后 highlight 关键句，最后 finish。" }); continue; }
          if (parsed.text) { const t = this._el(state.doc, "div", "aireader-tool-thought", parsed.text); logWrap.appendChild(t); }
          break;
        }
        this._pushAssistantToolTurn(fmt, messages, parsed);
        const results = [];
        const slots = await this._runToolCalls(state, c, parsed.calls);
        parsed.calls.forEach((call, i) => {
          steps++;
          const r = slots[i];
          this._appendToolGrouped(state, logWrap, grp, r.render);
          results.push({ id: call.id, name: call.name, output: r.output });
          if (r.finish) finished = true;
        });
        setHead();
        this._pushToolResults(fmt, messages, results);
        setHead();
        try { state.chatMsgs.scrollTop = state.chatMsgs.scrollHeight; } catch (e) {}
      }
      state._lastRun = run;
      headline.textContent = (state.cancel ? "已停止 · " : "✓ ") + "本次共标注 " + run.keys.length + " 处";
      this._renderAgentSummary(state, bubble, tally, run.keys.length, state.cancel);
      this.setStatus(state, state.cancel ? "已停止。" : ("完成，已标注 " + run.keys.length + " 处。"), state.cancel ? "muted" : "ok");
      // Persist a record (the highlights themselves live durably in the PDF).
      if (!state.cancel && run.keys.length) this._persistArtifact(state, "✨ 已通读并标注 " + run.keys.length + " 处（标注已写入 PDF）", null);
    } catch (e) {
      headline.textContent = "出错：" + (e.message || e);
    } finally {
      state.streaming = false; this.updateSendButton(state);
    }
  },

  _renderAgentSummary(state, bubble, tally, total, stopped) {
    const doc = state.doc;
    const legend = this._el(doc, "div", "aireader-agent-legend");
    for (const cat of ["contribution", "method", "result", "limitation", "keyterm"]) {
      if (!tally[cat]) continue;
      const item = this._el(doc, "span", "aireader-agent-legenditem", (this.CATEGORY_LABELS[cat] || cat) + " " + tally[cat]);
      item.style.borderBottom = "2px solid " + this.colorForCategory(cat);
      legend.appendChild(item);
    }
    bubble.appendChild(legend);
    if (total > 0) {
      // One button that toggles between undo (erase this run) and redo
      // (re-create what was just undone).
      const btn = this._el(doc, "button", "aireader-followup", "↩ 撤销本次标注");
      btn.addEventListener("click", async () => {
        if (btn._busy) return; btn._busy = true;
        try {
          if (btn._mode === "redo") {
            btn.textContent = "重做中…";
            const n = await this.redoRun(state);
            btn._mode = "undo"; btn.textContent = "↩ 撤销本次标注（已重做 " + n + " 处）";
          } else {
            btn.textContent = "撤销中…";
            const n = await this.undoRun(state);
            btn._mode = "redo"; btn.textContent = "↪ 重做本次标注（已撤销 " + n + " 处）";
          }
        } finally { btn._busy = false; }
      });
      bubble.appendChild(btn);
    }
  },

  // Erase every annotation created by the most recent agentAnnotate run, and
  // stash enough to recreate them so the action can be redone.
  async undoRun(state) {
    const run = state._lastRun;
    if (!run || !run.keys || !run.keys.length) return 0;
    const attachment = state.attachment;
    let removed = 0;
    for (const key of run.keys) {
      if (!key) continue;
      try { await this.removeAnnotation({ key, libraryID: attachment.libraryID }, attachment); removed++; }
      catch (e) { this.log("undoRun erase: " + e); }
    }
    state._redo = { applied: (run.applied || []).slice(), at: Date.now() };
    state._lastRun = { keys: [], applied: [], at: Date.now() };
    return removed;
  },

  // Re-create the annotations that the last undoRun removed.
  async redoRun(state) {
    const redo = state._redo;
    if (!redo || !redo.applied || !redo.applied.length) return 0;
    const byId = new Map((state.blocks || []).map((b) => [b.id, b]));
    const run = { keys: [], applied: [], at: Date.now() };
    for (const a of redo.applied) {
      const block = byId.get(a.blockId);
      if (!block || !block.position) continue;
      if (this._existingAIKeyAt(state.attachment, block)) continue; // already there
      try {
        const r = await this.applyAnnotation(state.attachment, block, { type: "highlight", comment: a.comment, color: a.color });
        const entry = Object.assign({}, a, { key: r && r.key });
        run.keys.push(r && r.key); run.applied.push(entry);
      } catch (e) { this.log("redoRun apply: " + e); }
    }
    state._lastRun = run;
    state._redo = { applied: [], at: Date.now() };
    return run.keys.length;
  },


  // ---------------------------------------------------- annotation writing
  sortIndex(block) {
    const pi = block.position.pageIndex;
    let topY = 0, minX = Infinity;
    for (const r of block.position.rects) { topY = Math.max(topY, r[3]); minX = Math.min(minX, r[0]); }
    const top = Math.max(0, Math.floor((block.pageHeight || 792) - topY));
    // Horizontal offset distinguishes sentence-level blocks sharing a line (same
    // top) — otherwise their sortIndex collides and idempotency over-matches.
    const off = Math.max(0, Math.floor(minX === Infinity ? 0 : minX));
    const pad = (n, w) => String(n).slice(0, w).padStart(w, "0");
    return pad(pi, 5) + "|" + pad(off, 6) + "|" + pad(top, 5);
  },

  // Read the user's existing highlights/underlines/notes from the PDF so the
  // model can answer "based on my highlights / summarize my notes".
  async getUserAnnotations(attachment) {
    const out = [];
    try {
      let anns = (attachment && attachment.getAnnotations) ? attachment.getAnnotations() : [];
      for (let a of (anns || [])) {
        if (typeof a === "number") a = Zotero.Items.get(a);
        if (!a) continue;
        const type = a.annotationType;
        if (type !== "highlight" && type !== "underline" && type !== "note") continue;
        const txt = (a.annotationText || "").replace(/\s+/g, " ").trim();
        const cmt = (a.annotationComment || "").trim();
        const pg = a.annotationPageLabel || "";
        if (!txt && !cmt) continue;
        let line = "[p" + pg + "] ";
        if (txt) line += "“" + txt + "”";
        if (cmt) line += (txt ? " —— 批注：" : "批注：") + cmt;
        out.push(line);
      }
    } catch (e) { this.log("getUserAnnotations error: " + e); }
    return out;
  },

  async applyAnnotation(attachment, block, { type, comment, color }) {
    if (!attachment || !attachment.libraryID) throw new Error("No attachment");
    if (!Zotero.Annotations || typeof Zotero.Annotations.saveFromJSON !== "function") throw new Error("Annotation API unavailable");
    const json = {
      key: Zotero.Utilities.generateObjectKey(),
      type: type || "highlight",
      text: block.text,
      comment: comment || "",
      color: color || this.HILITE_COLOR,
      pageLabel: block.pageLabel === "?" ? "" : String(block.pageLabel),
      sortIndex: this.sortIndex(block),
      position: block.position,
      tags: [{ name: "AI" }],
    };
    const saved = await Zotero.Annotations.saveFromJSON(attachment, json);
    // Return an object that always carries key + libraryID (+ the Item if we
    // can resolve it now) so toggle-off can reliably find and delete it.
    let item = (saved && typeof saved.eraseTx === "function") ? saved : null;
    if (!item) { try { if (Zotero.Items.getByLibraryAndKey) item = Zotero.Items.getByLibraryAndKey(attachment.libraryID, json.key) || null; } catch (e) {} }
    return { key: json.key, libraryID: attachment.libraryID, item };
  },

  // Annotate a reader text selection with an AI comment. The reader hands us a
  // PENDING annotation (`params.annotation`) that already carries the exact
  // position / sortIndex / pageLabel — more reliable than our block geometry.
  //   • selection sits on an EXISTING highlight → append the note into it
  //     (so "AI 解释" on a highlighted passage writes a note, no duplicate).
  //   • plain selection → create a new highlight carrying the note.
  async annotateSelection(reader, pendingAnn, comment) {
    const attachment = reader && Zotero.Items.get(reader.itemID);
    if (!attachment || !attachment.libraryID) throw new Error("No attachment");
    if (!Zotero.Annotations || typeof Zotero.Annotations.saveFromJSON !== "function") throw new Error("Annotation API unavailable");
    const si = pendingAnn && pendingAnn.sortIndex;
    if (si && typeof attachment.getAnnotations === "function") {
      for (let a of (attachment.getAnnotations() || [])) {
        if (typeof a === "number") a = Zotero.Items.get(a);
        if (!a || typeof a.saveTx !== "function") continue;
        if (a.annotationSortIndex !== si) continue;
        if (a.annotationType !== "highlight" && a.annotationType !== "underline") continue;
        const prev = (a.annotationComment || "").trim();
        a.annotationComment = prev ? (prev + "\n\n" + comment) : comment;
        try { if (a.addTag) a.addTag("AI"); } catch (e) {}
        await a.saveTx();
        return { key: a.key, updated: true };
      }
    }
    const json = {
      key: Zotero.Utilities.generateObjectKey(),
      type: "highlight",
      text: (pendingAnn && pendingAnn.text) || "",
      comment: comment || "",
      color: (pendingAnn && pendingAnn.color) || this.HILITE_COLOR,
      pageLabel: (pendingAnn && pendingAnn.pageLabel) || "",
      sortIndex: si,
      position: pendingAnn && pendingAnn.position,
      tags: [{ name: "AI" }],
    };
    await Zotero.Annotations.saveFromJSON(attachment, json);
    return { key: json.key, updated: false };
  },
});
