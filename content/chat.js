/* chat.js — the conversational core: the continuous agentic conversation (live
 * message history, compaction, send/regenerate/retry flow), the multi-paper
 * compare "basket", and all persistence (block cache + chat history, local file
 * copy + the synced "AI Reader Chat Data" note). Loaded after aireader.js;
 * Object.assign onto the global AIReader — pure move out of aireader.js, no
 * behavior change. Methods still call this.* siblings in the core / other
 * modules (e.g. this.enhanceMessage in ui, this.callLLMStream in net).
 */

Object.assign(AIReader, {
  // ---- continuous agentic conversation (live message history + compaction) ----
  // A "real user" turn marks a round boundary. NB: Anthropic tool_result turns are
  // also role:"user" but their content is an array — those are NOT boundaries.
  _isUserTurn(m) { return m && m.role === "user" && typeof m.content === "string"; },
  _liveChars(messages) {
    let n = 0;
    for (const m of messages) { try { n += (typeof m.content === "string" ? m.content : JSON.stringify(m.content || m)).length; } catch (e) {} }
    return n;
  },
  // Rebuild the live history from the persisted text hist when it's missing, or
  // when the attachment / API format changed (tool-turn structure is format- and
  // session-specific, so we don't carry it across those).
  _ensureLive(state) {
    const key = state.attachment && state.attachment.key;
    const fmt = this._fmt();
    if (state.live && state.live.key === key && state.live.fmt === fmt) return;
    const hist = this._chatStore.get(key) || [];
    const messages = hist.filter((m) => m && m.role && typeof m.content === "string").map((m) => ({ role: m.role, content: m.content }));
    state.live = { key, fmt, messages };
  },
  // Regenerate: drop everything after (and including the assistant for) the last
  // real user turn, keeping that user turn so it can be answered again.
  _rollbackLiveToLastUser(state) {
    if (!state.live) return;
    const msgs = state.live.messages;
    let lastU = -1;
    for (let i = msgs.length - 1; i >= 0; i--) if (this._isUserTurn(msgs[i])) { lastU = i; break; }
    if (lastU >= 0) msgs.splice(lastU + 1); // keep the user turn, drop its answer + tool turns
  },
  // Compact the live history like an agent harness: summarise the oldest whole
  // rounds (prose + what was read/seen) into one note, keep the recent rounds
  // intact. Rounds are split on real user turns so tool_use/tool_result pairs
  // are never severed.
  async _compactLive(state, meta) {
    if (!state.live) return;
    const msgs = state.live.messages;
    const TRIGGER = 120000, KEEPCHARS = 60000;
    if (this._liveChars(msgs) < TRIGGER) return;
    // user-turn boundaries
    const bounds = [];
    for (let i = 0; i < msgs.length; i++) if (this._isUserTurn(msgs[i])) bounds.push(i);
    if (bounds.length < 2) return; // need at least one older + one recent round
    // find the earliest boundary such that the kept tail is under KEEPCHARS
    let cut = bounds[bounds.length - 1];
    for (let bi = bounds.length - 1; bi >= 1; bi--) {
      if (this._liveChars(msgs.slice(bounds[bi])) > KEEPCHARS) { cut = bounds[bi + 1] != null ? bounds[bi + 1] : cut; break; }
      cut = bounds[bi];
    }
    const older = msgs.slice(0, cut);
    if (!older.length) return;
    if (meta) this.setStatus(state, "整理上下文…", "busy");
    try {
      const sum = await this.callLLM([
        { role: "system", content: "把下面这段『阅读对话 + 工具读取』压缩成要点笔记，务必保留：已读过哪些章节及其关键内容与数据、已识读的图表结论、用户问过/关注的问题、已得出的结论。简洁中文、分条，便于后续继续引用，避免重复读取。" },
        { role: "user", content: this._turnsToText(older) },
      ]);
      const note = { role: "user", content: "【早期阅读与对话摘要（供连续参考，无需重复读取已覆盖的章节/图表）】\n" + (sum || "").trim() };
      state.live.messages = [note].concat(msgs.slice(cut));
    } catch (e) { this.log("live compact error: " + e); } // leave as-is on failure
  },
  // Flatten a slice of the live history (incl. tool turns, any API format) into
  // readable text for summarisation.
  _turnsToText(messages) {
    const out = [];
    for (const m of messages) {
      if (this._isUserTurn(m)) { out.push("用户：" + m.content); continue; }
      if (m.role === "assistant" && typeof m.content === "string") { if (m.content.trim()) out.push("助手：" + m.content); continue; }
      if (m.role === "tool") { out.push("（工具结果：" + String(m.content || "").slice(0, 1200) + "）"); continue; } // openai chat
      if (m.type === "function_call") { out.push("（调用 " + m.name + "）"); continue; } // responses
      if (m.type === "function_call_output") { out.push("（工具结果：" + String(m.output || "").slice(0, 1200) + "）"); continue; }
      if (Array.isArray(m.content)) { // anthropic blocks
        for (const b of m.content) {
          if (b.type === "text") out.push((m.role === "assistant" ? "助手：" : "") + (b.text || ""));
          else if (b.type === "tool_use") out.push("（调用 " + b.name + "）");
          else if (b.type === "tool_result") out.push("（工具结果：" + String(typeof b.content === "string" ? b.content : JSON.stringify(b.content)).slice(0, 1200) + "）");
        }
        continue;
      }
      if (m.role === "assistant" && typeof m.content === "string") out.push("助手：" + m.content);
    }
    return out.join("\n");
  },

  _regen(state, msg, question) {
    try { msg.remove(); } catch (e) {}
    const hist = this._chatStore.get(state.attachment.key) || [];
    if (hist.length && hist[hist.length - 1].role === "assistant") hist.pop();
    this._send(state, question, { skipUser: true, broad: false });
  },

  // A failed turn leaves the error bubble with a "重试" button. Re-run the same
  // question with the same options, cleaning up the failed turn first: nothing
  // was committed to hist (that happens only on success), and the live history
  // is rolled back so the model doesn't see the aborted attempt.
  _addRetry(state, errMsg, userMsg, text, opts) {
    try {
      const row = this._el(state.doc, "div", "aireader-actions");
      const btn = this._el(state.doc, "span", "aireader-action", "重试");
      btn.addEventListener("click", () => {
        if (state.streaming) return;
        try { errMsg.remove(); } catch (e) {}
        if (!opts.skipUser) {
          try { if (userMsg) userMsg.remove(); } catch (e) {}
          // drop the failed user turn (+ any partial tool turns) from live; the
          // re-send will re-add it.
          if (state.live) { const msgs = state.live.messages; for (let i = msgs.length - 1; i >= 0; i--) if (this._isUserTurn(msgs[i])) { msgs.splice(i); break; } }
        } else {
          // regen-style retry: keep the existing user turn, drop only its partials.
          this._rollbackLiveToLastUser(state);
        }
        this._send(state, text, opts);
      });
      row.appendChild(btn);
      errMsg.querySelector && errMsg.querySelector(".aireader-bubble") ? errMsg.querySelector(".aireader-bubble").appendChild(row) : errMsg.appendChild(row);
    } catch (e) { this.log("addRetry error: " + e); }
  },

  onChatSend(body, forcedText, opts) {
    const state = this._bodyState.get(body);
    if (!state || !state.attachment) return;
    const q = forcedText != null ? forcedText : (state.input.value || "").trim();
    if (!q) return;
    if (forcedText == null) state.input.value = "";
    opts = opts || { broad: false };
    // 跨论文 mode (toggle on + at least 2 papers once the current one is folded in).
    if (state.multiMode && this._basketList(state).length >= 2) opts = Object.assign({}, opts, { multi: true });
    return this._send(state, q, opts);
  },

  async _send(state, text, opts) {
    opts = opts || {};
    if (!this.requireKey(state)) return;
    if (state.streaming) return;
    const key = state.attachment.key;
    let hist = this._chatStore.get(key);
    if (!hist) { hist = []; this._chatStore.set(key, hist); }

    const userMsg = !opts.skipUser ? this.appendUserMsg(state, text) : null;
    const { msg, bubble } = this.appendAssistantMsg(state);
    bubble.classList.add("aireader-streaming");
    state.streaming = true; state.cancel = false; this.updateSendButton(state);

    const meta = {};
    try {
      await this.ensureBlocks(state);
      // Fold older turns into a rolling summary so long chats don't lose their
      // early context when we slice to the most recent turns.
      await this._compactHistory(key, hist);
      const sumNote = this._histSummary.get(key);
      const deep = !!this._deepRead;
      let sys;
      if (opts.multi) {
        // Multi-paper mode: assemble retrieved excerpts from every paper in the
        // comparison basket. No single-paper agent tools (section/figure/highlight
        // are per-document); citations are textual (论文i · p页), not [B id] badges.
        this.setStatus(state, "正在整理多篇论文…", "busy");
        const mctx = await this._buildMultiContext(state, text);
        meta.ctxChars = mctx.length;
        sys = this._multiSystemPrompt(mctx, this._basketList(state).length) + this._skillDirective() + (sumNote ? "\n\n【早期对话要点】\n" + sumNote : "");
      } else {
        let ctx = opts.broad ? this.buildContextBounded(state.blocks) : this.buildRetrievedContext(state.blocks, text);
        if (opts.annos) {
          const ua = await this.getUserAnnotations(state.attachment);
          if (ua.length) ctx = "【用户在 PDF 中的高亮与批注】（按出现顺序，优先结合这些回答）：\n" + ua.join("\n") + "\n\n——\n\n论文正文：\n" + ctx;
          else this.setStatus(state, "这篇论文还没有你的高亮/批注。", "muted");
        }
        if (opts.withFigures) {
          this.setStatus(state, "正在识读图表…", "busy");
          try { const fd = await this._figureDigest(state, 2); if (fd) ctx = fd + "——\n\n论文正文：\n" + ctx; } catch (e) { this.log("withFigures: " + e); }
        }
        meta.ctxChars = ctx.length;
        const hasSerper = !!(this.getPref("serperKey") || "").trim();
        const webNote = (hasSerper
          ? "需要论文之外的背景、最新进展、术语或相关工作时，可用 web_search 联网搜索、web_fetch 抓取网页正文。"
          : "需要抓取某个网页正文时可用 web_fetch。");
        // What the tools can actually do is decided by the document's capabilities
        // (docreader) + whether we found sections — not guessed here. Position-less
        // docs (HTML/EPUB/snapshot) have no figure/highlight regions; the tool note
        // only advertises what's available so the model never calls a dead tool.
        const caps = this._docCaps(state.attachment);
        const hasSections = this._buildSections(state.blocks).length > 0;
        const scholarNote = "涉及参考文献、相关工作或后续研究时，可用 lookup_paper 查某篇论文、find_references 看本文引用了哪些工作、related_papers 找相关/后续论文（query 留空即当前论文）。";
        let toolNote;
        if (hasSections && caps.regions) {
          toolNote = "\n\n上面的论文正文可能是节选。你可以调用工具查阅更多内容：list_sections 看章节结构；read_section 读取某一章拿到每句 id；" +
            "list_figures 列出图表；view_figure 识读某张图/表的视觉内容" + (caps.annotate ? "；highlight 高亮某个句子 id（给 category 和一句话 reason）。" : "。") + webNote + scholarNote +
            (deep
              ? "【深读模式】回答前请主动用 list_sections + read_section 读取所有相关章节，并对相关图/表 view_figure，确保基于充分证据作答。"
              : "当注入的正文不足以准确回答、或问题涉及具体数据/图表时，请主动调用 read_section / view_figure 查阅后再答；普通问题可直接作答。");
        } else if (hasSections) {
          toolNote = "\n\n这是" + (caps.label || "网页") + "文档，没有页面坐标（没有图表/高亮工具）。正文已按章节给出，需要更多内容时可 read_section 读取某一章。" + webNote + scholarNote;
        } else {
          toolNote = "\n\n上面给出的正文即可直接作答，本文档没有可用的章节/图表工具。" + webNote + scholarNote;
        }
        sys = this.systemPrompt(ctx) + toolNote + this._skillDirective() + (sumNote ? "\n\n【早期对话要点】\n" + sumNote : "");
      }
      this.setStatus(state, "生成中…", "busy");
      // Continuous agentic context: one live message history (incl. tool turns)
      // persists across questions; compact it when it grows too large. The read
      // tool results already live in `convo`, so we no longer inject _priorContext.
      this._ensureLive(state);
      if (opts.skipUser) this._rollbackLiveToLastUser(state); // regen: redo the last question
      await this._compactLive(state, meta);
      const convo = state.live.messages;
      if (!opts.skipUser) convo.push({ role: "user", content: text });
      const withSys = () => [{ role: "system", content: sys }, ...convo];

      // Stream the answer; if the model issues tool calls mid-stream, execute
      // them (shown as collapsible tool blocks) and continue — so tool use is a
      // general capability of normal chat, not just the "通读并标注" button.
      const fmt0 = this._fmt();
      const tc = { sections: this._buildSections(state.blocks), byId: new Map((state.blocks || []).map((b) => [b.id, b])), run: { keys: [], applied: [] }, tally: {}, reads: 0 };
      // multi-paper mode: context pre-assembled, no single-paper tools. Otherwise
      // gate tools by document capability: sections need text, figures/highlight
      // need page geometry (PDF only) — see content/docreader.js.
      const dcaps = this._docCaps(state.attachment);
      const tools = opts.multi ? null : this._toolSchemas(fmt0, { sections: tc.sections.length > 0, figures: dcaps.regions, annotate: dcaps.annotate });
      const toolLog = this._el(state.doc, "div", "aireader-toollog"); let toolLogAdded = false; const grp = {};
      const ensureToolLog = () => { if (!toolLogAdded) { bubble.appendChild(toolLog); toolLogAdded = true; } };
      let answerEl = this._el(state.doc, "div", "aireader-answer"); bubble.appendChild(answerEl);
      let full = "";
      const MAX_ROUNDS = deep ? 20 : 10;
      for (let round = 0; round < MAX_ROUNDS && !state.cancel; round++) {
        let acc = "", lastR = 0, lastRendered = null;
        const turnEl = answerEl;
        // Stream: once a diagram fence (```svg etc.) opens, hide its raw source and
        // show a "正在绘制…" animation instead; keep rendering the prose before it.
        const paint = (text, force) => {
          const cut = this._artifactCut(text);
          if (cut == null) { this._clearDrawing(turnEl); if (force || text !== lastRendered) { try { this.renderRich(state, turnEl, text); } catch (e) { turnEl.textContent = text; } lastRendered = text; } }
          else { if (force || cut !== lastRendered) { try { this.renderRich(state, turnEl, cut); } catch (e) { turnEl.textContent = cut; } lastRendered = cut; } this._showDrawing(state, turnEl); }
        };
        this._startWait(state, round === 0 ? "正在思考…" : "继续生成…"); // ticks until the first token arrives
        const res = await this._streamAnswer(withSys(), tools, (d) => {
          this._stopWait(state);
          acc += d;
          const el = state.chatMsgs;
          const stick = (el.scrollHeight - el.scrollTop - el.clientHeight) < 60;
          const now = Date.now();
          if (now - lastR > 140) { lastR = now; paint(acc); }
          this.setStatus(state, "生成中… " + acc.length + " 字", "busy");
          if (stick) el.scrollTop = el.scrollHeight;
        }, () => state.cancel, meta);
        this._stopWait(state);
        paint(res.text || "", true); // still hide any in-progress diagram source (final SVG is drawn by enhanceMessage below)
        if (res.calls && res.calls.length && !state.cancel) {
          this._pushAssistantToolTurn(fmt0, convo, { text: res.text, calls: res.calls, reasoning: res.reasoning });
          ensureToolLog();
          const hasVision = res.calls.some((c) => c.name === "view_figure");
          this._startWait(state, hasVision ? "正在识读图表…" : "调用工具中…"); // vision is a blocking sub-call; show it's working
          const results = [];
          const slots = await this._runToolCalls(state, tc, res.calls);
          this._stopWait(state);
          res.calls.forEach((call, i) => { const r = slots[i]; this._appendToolGrouped(state, toolLog, grp, r.render); results.push({ id: call.id, name: call.name, output: r.output }); });
          this._pushToolResults(fmt0, convo, results);
          answerEl = this._el(state.doc, "div", "aireader-answer"); bubble.appendChild(answerEl);
          try { state.chatMsgs.scrollTop = state.chatMsgs.scrollHeight; } catch (e) {}
          continue;
        }
        full = res.text || ""; break;
      }

      // Ran out of tool rounds without a final answer (model kept calling tools) —
      // ask once more WITHOUT tools so it must write the answer, instead of
      // leaving an empty bubble ("卡住").
      if (!full && !state.cancel) {
        convo.push({ role: "user", content: "请基于以上读取到的内容，给出完整、充分的回答。" });
        const fin = answerEl; let acc2 = "", lastR2 = 0, lastRend2 = null;
        const paint2 = (t, force) => {
          const cut = this._artifactCut(t);
          if (cut == null) { this._clearDrawing(fin); if (force || t !== lastRend2) { try { this.renderRich(state, fin, t); } catch (e) { fin.textContent = t; } lastRend2 = t; } }
          else { if (force || cut !== lastRend2) { try { this.renderRich(state, fin, cut); } catch (e) { fin.textContent = cut; } lastRend2 = cut; } this._showDrawing(state, fin); }
        };
        try {
          this._startWait(state, "整理回答…");
          const res2 = await this._streamAnswer(withSys(), null, (d) => { this._stopWait(state); acc2 += d; const now = Date.now(); if (now - lastR2 > 140) { lastR2 = now; paint2(acc2); } this.setStatus(state, "整理回答… " + acc2.length + " 字", "busy"); if (state.chatMsgs) state.chatMsgs.scrollTop = state.chatMsgs.scrollHeight; }, () => state.cancel, meta);
          this._stopWait(state);
          paint2(res2.text || acc2, true);
          full = res2.text || acc2 || "";
        } catch (e) { this.log("final wrap-up failed: " + e); }
      }

      bubble.classList.remove("aireader-streaming");
      this.enhanceMessage(state, answerEl, full);
      this.addAssistantActions(state, msg, full, text);
      this.addMetaLine(state, msg, meta, full);
      if (tc.run.keys.length) { state._lastRun = tc.run; this._renderAgentSummary(state, bubble, tc.tally, tc.run.keys.length, false); }
      this.setStatus(state, "", "");
      convo.push({ role: "assistant", content: full }); // final text turn into the live history
      if (!opts.skipUser) hist.push({ role: "user", content: text });
      hist.push({ role: "assistant", content: full });
      this.saveChat(state.attachment, hist).catch(() => {});
      if (opts.autoApply) {
        if (!this._docCaps(state.attachment).annotate) { this.setStatus(state, "这是" + (this._docCaps(state.attachment).label || "网页") + "文档，没有页面坐标，无法在原文上高亮（已照常给出文字回答）。", "muted"); }
        else { const { count } = await this.autoApplyDirectives(state, full); this.setStatus(state, count ? ("已自动高亮 " + count + " 处。") : "未识别到可高亮的句子。", count ? "ok" : "muted"); }
      }
    } catch (e) {
      bubble.classList.remove("aireader-streaming");
      bubble.textContent = (state.cancel ? "（已停止）" : this._friendlyError(e));
      if (!state.cancel) this._addRetry(state, msg, userMsg, text, opts);
    } finally {
      this._stopWait(state);
      state.streaming = false; this.updateSendButton(state);
    }
  },

  // Small per-message line: token usage (if the API reported it) + context size.
  addMetaLine(state, msg, meta, full) {
    try {
      const doc = state.doc;
      const outTok = meta.outTok != null ? meta.outTok : Math.round([...(full || "")].length / 3);
      const inTok = meta.inTok != null ? ("⬆ " + meta.inTok + " ") : "";
      const approx = meta.outTok != null ? "" : "~";
      const kfmt = (n) => (n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n));
      const ctxk = meta.ctxChars != null ? (" · 上下文 " + kfmt(meta.ctxChars) + " 字") : "";
      // Show both cache read (multi-turn hit) and cache write (first turn, the
      // cache being created) so prompt caching is visible either way.
      let cache = "";
      if (meta.cacheRead) cache += " · 命中缓存 " + kfmt(meta.cacheRead);
      if (meta.cacheWrite) cache += " · 写缓存 " + kfmt(meta.cacheWrite);
      const line = this._el(doc, "div", "aireader-meta", inTok + "⬇ " + approx + outTok + " tok" + cache + ctxk);
      msg.appendChild(line);
    } catch (e) {}
  },

  // ---------------------------------------------------------- 多篇对比（对比篮子）
  // Session-only "basket" of papers to ask across. The currently-open paper is
  // always folded in (so you add the OTHER papers, not the one you're reading).
  _basketList(state) {
    const list = (state.basket || []).slice();
    const curKey = state.attachment && state.attachment.key;
    if (curKey && !list.some((p) => p.key === curKey)) {
      const meta = this._currentPaperMeta(state);
      list.unshift({ key: curKey, id: state.attachment.id, libraryID: state.attachment.libraryID, title: meta.title || "当前论文" });
    }
    return list;
  },
  _basketToggle(state) {
    if (!state.attachment) return;
    const key = state.attachment.key;
    const i = (state.basket || []).findIndex((p) => p.key === key);
    if (i >= 0) state.basket.splice(i, 1);
    else {
      const meta = this._currentPaperMeta(state);
      state.basket.push({ key, id: state.attachment.id, libraryID: state.attachment.libraryID, title: meta.title || "未命名论文" });
    }
    this._renderBasket(state);
    const inB0 = state.attachment && (state.basket || []).some((p) => p.key === state.attachment.key);
    this.setStatus(state, inB0 ? "已加入对比篮子。" : "已移出对比篮子。", "muted");
  },
  _toggleMulti(state) {
    state.multiMode = !state.multiMode;
    const n = this._basketList(state).length;
    if (state.multiMode && n < 2) this.setStatus(state, "跨论文已开：在「选项 ▾ · 加入对比篮子」把要对比的论文加进来（至少 2 篇）。", "muted");
    else if (state.multiMode) this.setStatus(state, "跨论文已开：提问将综合 " + n + " 篇论文。", "muted");
    else this.setStatus(state, "跨论文已关。", "muted");
    this._renderBasket(state);
  },
  _renderBasket(state) {
    const bar = state.basketBar; if (!bar) return;
    const doc = state.doc;
    bar.textContent = "";
    if (!(state.basket && state.basket.length)) { bar.style.display = "none"; return; }
    bar.style.display = "";
    bar.appendChild(this._el(doc, "span", "aireader-basket-label", "对比(" + state.basket.length + ")" + (state.multiMode ? " · 跨论文已开" : "")));
    state.basket.forEach((p) => {
      const chip = this._el(doc, "span", "aireader-basket-chip");
      chip.appendChild(this._el(doc, "span", "aireader-basket-chip-t", (p.title || "未命名").slice(0, 32)));
      const x = this._el(doc, "span", "aireader-basket-x", "✕");
      x.title = "移除";
      x.addEventListener("click", () => {
        const i = state.basket.findIndex((q) => q.key === p.key);
        if (i >= 0) state.basket.splice(i, 1);
        this._renderBasket(state);
      });
      chip.appendChild(x);
      bar.appendChild(chip);
    });
    const clear = this._el(doc, "span", "aireader-basket-clear", "清空对比");
    clear.addEventListener("click", () => { state.basket = []; this._renderBasket(state); });
    bar.appendChild(clear);
  },
  // Blocks for any basket paper: current paper uses live blocks, others come
  // from the in-memory store, then disk cache, then a fresh extraction (cached).
  async _basketBlocks(state, p) {
    if (state.attachment && p.key === state.attachment.key && state.blocks && state.blocks.length) return state.blocks;
    let blocks = this._blockStore.get(p.key);
    if (blocks && blocks.length) return blocks;
    try {
      const att = Zotero.Items.get(p.id);
      if (att) { const disk = await this.loadCache(att); if (disk && disk.blocks && disk.blocks.length) blocks = disk.blocks; }
    } catch (e) {}
    if (!(blocks && blocks.length)) { try { blocks = await this.extractBlocks(p.id); } catch (e) { this.log("basket extract " + p.key + ": " + e); } }
    if (blocks && blocks.length) this._blockStore.set(p.key, blocks);
    return blocks || [];
  },
  // Assemble a labelled multi-document context: for each basket paper, the most
  // query-relevant excerpt (budget = maxChars/N). Block ids collide across
  // papers, so strip the [B<id> …] prefix and keep only the page → textual cites.
  async _buildMultiContext(state, query) {
    const list = this._basketList(state);
    const N = list.length || 1;
    const maxChars = Number(this.getPref("maxChars")) || 60000;
    const per = Math.max(2000, Math.floor(maxChars / N) - 200);
    const parts = [];
    for (let i = 0; i < list.length; i++) {
      const p = list[i];
      const blocks = await this._basketBlocks(state, p);
      let body;
      if (!blocks.length) body = "（无法提取正文）";
      else {
        let ex = this.buildRetrievedContext(blocks, query);
        ex = ex.replace(/\[B\d+\s+(p[^\]]*)\]/g, "($1)"); // drop colliding ids, keep page
        if (ex.length > per) ex = ex.slice(0, per) + "\n…（略）";
        body = ex;
      }
      parts.push("【论文 " + (i + 1) + " · " + (p.title || "未命名") + "】\n" + body);
    }
    return parts.join("\n\n———\n\n");
  },

  // ----------------------------------------------------------------- cache
  cachePath(attachment) { const dir = PathUtils.join(Zotero.DataDirectory.dir, "aireader"); return { dir, path: PathUtils.join(dir, attachment.libraryID + "-" + attachment.key + ".json") }; },
  chatPath(attachment) { const dir = PathUtils.join(Zotero.DataDirectory.dir, "aireader"); return { dir, path: PathUtils.join(dir, attachment.libraryID + "-" + attachment.key + "-chat.json") }; },

  async loadCache(attachment) {
    try {
      const { path } = this.cachePath(attachment);
      if (!(await IOUtils.exists(path))) return null;
      const obj = JSON.parse(await IOUtils.readUTF8(path));
      // Reject caches from an older block schema so they get re-extracted with
      // the current code (e.g. snapshot blocks gained a text `anchor` in v4 —
      // without this, a doc cached by an older build keeps anchorless blocks and
      // its citations stay unclickable).
      if (obj.version !== this.BLOCK_CACHE_VERSION) return null;
      const hash = await attachment.attachmentHash;
      if (hash && obj.hash && hash !== obj.hash) return null;
      return obj;
    } catch (e) { return null; }
  },

  async saveCache(attachment, blocks) {
    try {
      const { dir, path } = this.cachePath(attachment);
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      const hash = await attachment.attachmentHash;
      await IOUtils.writeUTF8(path, JSON.stringify({ version: this.BLOCK_CACHE_VERSION, hash: hash || null, date: new Date().toISOString(), blocks }));
    } catch (e) { this.log("saveCache error: " + e); }
  },

  async _loadChatLocal(attachment) {
    try {
      const { path } = this.chatPath(attachment);
      if (!(await IOUtils.exists(path))) return null;
      const obj = JSON.parse(await IOUtils.readUTF8(path));
      return Array.isArray(obj.messages) ? { date: obj.date || "", messages: obj.messages } : null;
    } catch (e) { return null; }
  },

  async loadChat(attachment) {
    const local = await this._loadChatLocal(attachment);
    // Multi-machine sync: a Zotero note (which DOES sync) may hold a newer copy
    // written on another machine. Take whichever is newer and backfill local.
    let synced = null;
    if (this.getPref("syncChats") !== false) { try { synced = await this._loadChatSynced(attachment); } catch (e) { this.log("loadChatSynced: " + e); } }
    const pick = this._newerChat(local, synced);
    if (pick.fromSync && pick.bundle) this._writeChatLocal(attachment, pick.bundle.messages).catch(() => {});
    return (pick.bundle && pick.bundle.messages) || null;
  },

  // Pick the newer of local vs synced chat bundles by ISO date; ties keep local.
  _newerChat(local, synced) {
    if (!synced) return { bundle: local, fromSync: false };
    if (!local) return { bundle: synced, fromSync: true };
    const ls = Date.parse(local.date || "") || 0;
    const ss = Date.parse(synced.date || "") || 0;
    return ss > ls ? { bundle: synced, fromSync: true } : { bundle: local, fromSync: false };
  },

  async _writeChatLocal(attachment, hist) {
    const { dir, path } = this.chatPath(attachment);
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    await IOUtils.writeUTF8(path, JSON.stringify({ version: 1, date: new Date().toISOString(), messages: hist }));
  },

  async saveChat(attachment, hist) {
    try { await this._writeChatLocal(attachment, hist); } catch (e) { this.log("saveChat error: " + e); }
    // Mirror to a synced Zotero note (debounced — note writes are heavier than a
    // file write and happen on every turn).
    if (this.getPref("syncChats") !== false) this._syncChatDebounced(attachment, hist);
  },

  // ---- synced copy: a dedicated "AI Reader Chat Data"-tagged note under the
  // parent item. Its body is the chat JSON, HTML-escaped inside <pre>. Zotero
  // notes sync across machines; this note is separate from the user-readable
  // "存为笔记" note so the two never collide. ----
  _chatDataToNote(hist) {
    const json = JSON.stringify({ version: 1, date: new Date().toISOString(), messages: hist });
    return "<p>AI Reader 对话记录（自动同步，请勿编辑）</p>\n<pre data-air-chat=\"1\">" + this._escapeHTML(json) + "</pre>";
  },
  _parseChatDataNote(html) {
    try {
      const m = /<pre[^>]*data-air-chat[^>]*>([\s\S]*?)<\/pre>/i.exec(html || "");
      if (!m) return null;
      const json = m[1].replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
      const obj = JSON.parse(json);
      return Array.isArray(obj.messages) ? { date: obj.date || "", messages: obj.messages } : null;
    } catch (e) { return null; }
  },
  _parentOf(attachment) {
    try { return (attachment && attachment.parentItem) || null; } catch (e) { return null; }
  },
  async _findChatDataNote(parent) {
    try {
      if (!parent || !parent.getNotes) return null;
      for (const id of (parent.getNotes() || [])) {
        const n = Zotero.Items.get(id);
        if (n && n.hasTag && n.hasTag("AI Reader Chat Data")) return n;
      }
    } catch (e) {}
    return null;
  },
  async _loadChatSynced(attachment) {
    const parent = this._parentOf(attachment);
    if (!parent) return null;
    const note = await this._findChatDataNote(parent);
    if (!note) return null;
    return this._parseChatDataNote(note.getNote());
  },
  _syncChatDebounced(attachment, hist) {
    try {
      this._syncChatTimers = this._syncChatTimers || new Map();
      const key = attachment.libraryID + "-" + attachment.key;
      const prev = this._syncChatTimers.get(key);
      if (prev) { try { clearTimeout(prev); } catch (e) {} }
      const t = setTimeout(() => { this._syncChatTimers.delete(key); this._writeChatSynced(attachment, hist).catch((e) => this.log("writeChatSynced: " + e)); }, 4000);
      if (t && t.unref) t.unref();
      this._syncChatTimers.set(key, t);
    } catch (e) { this.log("syncChatDebounced: " + e); }
  },
  async _writeChatSynced(attachment, hist) {
    const parent = this._parentOf(attachment);
    if (!parent) return; // standalone attachment: nothing to hang a synced note on
    const body = this._chatDataToNote(hist);
    const existing = await this._findChatDataNote(parent);
    if (existing) { existing.setNote(body); await existing.saveTx(); return existing; }
    const note = new Zotero.Item("note");
    note.libraryID = parent.libraryID;
    if (parent.isRegularItem && parent.isRegularItem()) note.parentID = parent.id;
    note.setNote(body);
    try { note.addTag("AI Reader Chat Data"); } catch (e) {}
    await note.saveTx();
    return note;
  },
});
