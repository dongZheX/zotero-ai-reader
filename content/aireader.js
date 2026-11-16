/* AI Reader — core module (loaded into the bootstrap sandbox) */

AIReader = {
  id: null,
  version: null,
  rootURI: null,
  _selectionHandler: null,
  _bodyState: new WeakMap(),
  _panels: new Map(),      // attachment.key -> state (latest live panel)
  _chatStore: new Map(),   // attachment.key -> [{role, content}]
  _blockStore: new Map(),  // attachment.key -> blocks[]

  HILITE_COLOR: "#ffd400",

  init({ id, version, rootURI }) {
    this.id = id; this.version = version; this.rootURI = rootURI;
  },

  getPref(key) { return Zotero.Prefs.get("aireader." + key); },
  log(msg) { Zotero.debug("[AIReader] " + msg); },

  PRESETS: [
    { label: "总结全文", q: "请分【研究问题 / 方法 / 主要发现 / 结论与意义 / 局限】五部分，结构化总结这篇论文。", broad: true },
    { label: "三行摘要", q: "用三行中文给出这篇论文的极简摘要：问题、方法、结论各一行。", broad: true },
    { label: "关键词", q: "列出本文 6-10 个关键术语，每个一句话解释，并用 [B<id>] 标注来源。", broad: true },
    { label: "核心贡献", q: "这篇论文的核心贡献是什么？", broad: false },
    { label: "方法", q: "它用了什么方法？简要说明。", broad: false },
    { label: "主要结论", q: "主要结论或实验结果是什么？", broad: false },
    { label: "局限", q: "有哪些局限或未来工作？", broad: false },
    { label: "自动高亮", q: "从全文挑选 6-10 个最关键的句子，对每一句用 [[hl:<id>]] 标出；可附 [[note:<id>|一句话理由]]。逐条给出指令并简要说明理由。", broad: true, autoApply: true },
    { label: "总结我的高亮", q: "请总结我在这篇论文里高亮和批注的内容，并说明它们之间的联系与整体脉络。", broad: false, annos: true },
    { label: "基于我的批注", q: "基于我在 PDF 里的高亮和批注回答：它们共同说明了什么？我可能在关注哪些问题？有没有遗漏的要点？", broad: false, annos: true },
  ],

  // ---------------------------------------------------------- registration
  async registerAll() {
    this.registerSection();
    await this.registerPrefs();
    this.registerReaderPopup();
  },

  unregisterAll() {
    try { Zotero.ItemPaneManager.unregisterSection("ai-reader-summary"); } catch (e) {}
    try { if (this._prefPaneID) Zotero.PreferencePanes.unregister(this._prefPaneID); } catch (e) {}
    try { if (this._selectionHandler) Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this._selectionHandler); } catch (e) {}
    try { if (this._ctxHandler) { Zotero.Reader.unregisterEventListener("createViewContextMenu", this._ctxHandler); Zotero.Reader.unregisterEventListener("createSelectorContextMenu", this._ctxHandler); } } catch (e) {}
  },

  registerSection() {
    Zotero.ItemPaneManager.registerSection({
      paneID: "ai-reader-summary",
      pluginID: this.id,
      header: { l10nID: "aireader-section-header", icon: this.rootURI + "content/icons/ai16.svg" },
      sidenav: { l10nID: "aireader-section-sidenav", icon: this.rootURI + "content/icons/ai20.svg" },
      onItemChange: ({ item, setEnabled }) => { setEnabled(AIReader.canHandle(item)); return true; },
      onRender: ({ body, item, doc }) => { AIReader.renderSkeleton(body, item, doc); },
      onAsyncRender: async ({ body, item, doc }) => { await AIReader.hydrate(body, item, doc); },
    });
  },

  async registerPrefs() {
    this._prefPaneID = await Zotero.PreferencePanes.register({
      pluginID: this.id,
      src: this.rootURI + "content/preferences.xhtml",
      scripts: [this.rootURI + "content/preferences.js"],
      image: this.rootURI + "content/icons/ai20.svg",
      label: "AI Reader",
    });
  },

  registerReaderPopup() {
    this._selectionHandler = (event) => AIReader.onSelectionPopup(event);
    Zotero.Reader.registerEventListener("renderTextSelectionPopup", this._selectionHandler, this.id);
    this._ctxHandler = (event) => AIReader.onReaderContextMenu(event);
    try { Zotero.Reader.registerEventListener("createViewContextMenu", this._ctxHandler, this.id); } catch (e) {}
    try { Zotero.Reader.registerEventListener("createSelectorContextMenu", this._ctxHandler, this.id); } catch (e) {}
  },

  _readerSelection(reader) {
    try {
      const win = reader && reader._internalReader && reader._internalReader._primaryView && reader._internalReader._primaryView._iframeWindow;
      const s = win && win.getSelection && win.getSelection().toString();
      return (s || "").trim();
    } catch (e) { return ""; }
  },

  onReaderContextMenu(event) {
    try {
      const { reader, append } = event;
      if (typeof append !== "function") return;
      const text = this._readerSelection(reader);
      if (!text) return;
      if (!this.getPref("apiKey")) return;
      const lang = this.getPref("language") || "中文";
      // 问 AI = 把选中原文作为引用填进右侧输入框，自己接着提问
      append({ label: "在右侧问 AI（引用到输入框）", onCommand: () => this.quoteSelection(reader, text) });
      // 解释 = 直接发一条「解释这段」的消息并得到带出处的回答
      append({
        label: "AI 解释", onCommand: () => this.askFromSelection(reader, "请结合上下文解释这段原文，并指出它在论文中的作用：\n“" + text + "”", text),
      });
      // 翻译 = 只翻译，不解释
      append({
        label: "AI 翻译", onCommand: () => this.askFromSelection(reader, "请把下面这段原文翻译成" + lang + "，只输出译文，不要解释：\n“" + text + "”", text),
      });
    } catch (e) { this.log("ctxmenu error: " + e); }
  },

  onMainWindowLoad() {}, onMainWindowUnload() {},

  // ------------------------------------------------------------- item logic
  canHandle(item) {
    if (!item) return false;
    if (item.isAttachment && item.isAttachment()) return item.isFileAttachment && item.isFileAttachment();
    return item.isRegularItem && item.isRegularItem();
  },

  async resolveAttachment(item) {
    if (!item) return null;
    if (item.isAttachment && item.isAttachment()) return (item.isFileAttachment && item.isFileAttachment()) ? item : null;
    if (item.isRegularItem && item.isRegularItem()) return (await item.getBestAttachment()) || null;
    return null;
  },

  // ------------------------------------------------------------------- UI
  injectCSS(doc) {
    const add = (id, href) => {
      if (doc.getElementById(id)) return;
      const link = doc.createElementNS("http://www.w3.org/1999/xhtml", "link");
      link.id = id; link.rel = "stylesheet"; link.href = href;
      (doc.head || doc.documentElement).appendChild(link);
    };
    add("aireader-katex", this.rootURI + "content/vendor/katex/katex.min.css");
    // Cache-bust so a reinstall/restart always loads the current stylesheet
    // (Gecko aggressively caches file:// resources by URL).
    add("aireader-style", this.rootURI + "content/style.css?v=" + (this.version || "") + "-" + Date.now());
  },

  // Theme-aware, explicit colours so the popup menu is legible even when
  // Zotero's CSS custom props (--fill-primary, etc.) are undefined in the
  // reader panel. Returns hardcoded hex values, never a var().
  _menuColors(doc) {
    let dark = false;
    try { dark = !!(doc.defaultView && doc.defaultView.matchMedia("(prefers-color-scheme: dark)").matches); } catch (e) {}
    return dark
      ? { fg: "#e6edf3", muted: "#9aa6bb", bg: "#22272e", border: "#3a434f", hover: "rgba(255,255,255,.08)", accent: "#5a9bff" }
      : { fg: "#1a1d21", muted: "#6b7280", bg: "#ffffff", border: "#d7dbe0", hover: "rgba(59,125,221,.12)", accent: "#3b7ddd" };
  },

  _UIFONT: '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", Helvetica, Arial, sans-serif',

  // Zotero's main window is a XUL document, so a bare doc.createElement("div")
  // produces a XUL element whose text content renders with a fallback/symbol
  // font ("乱码"). HTML elements must be created in the XHTML namespace.
  // (Same thing zotero-plugin-toolkit's createElement does.)
  _el(doc, tag, cls, text) {
    const e = doc.createElementNS("http://www.w3.org/1999/xhtml", tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  },

  renderSkeleton(body, item, doc) {
    const old = this._bodyState.get(body);
    if (old) {
      this.closeModelMenu(old);
      if (old._ro) { try { old._ro.disconnect(); } catch (e) {} old._ro = null; }
      if (old._onWinResize) { try { old.doc.defaultView.removeEventListener("resize", old._onWinResize); } catch (e) {} old._onWinResize = null; }
    }
    this.injectCSS(doc);
    body.textContent = "";
    body.classList.add("aireader-root");

    const top = this._el(doc, "div", "aireader-top");
    const noteBtn = this._el(doc, "div", "aireader-top-btn", "存为笔记");
    noteBtn.title = "把当前对话存为 Zotero 笔记";
    noteBtn.addEventListener("click", () => this.saveNote(body));
    const gear = this._el(doc, "div", "aireader-gear", "⚙");
    gear.title = "Settings";
    gear.addEventListener("click", () => Zotero.Utilities.Internal.openPreferences(AIReader._prefPaneID));
    top.appendChild(noteBtn);
    top.appendChild(this._el(doc, "div", "aireader-foot-spacer"));
    top.appendChild(gear);
    body.appendChild(top);

    const status = this._el(doc, "div", "aireader-status");
    body.appendChild(status);

    const chatMsgs = this._el(doc, "div", "aireader-chat-msgs");
    body.appendChild(chatMsgs);

    const chips = this._el(doc, "div", "aireader-chips");
    for (const p of this.PRESETS) {
      const c = this._el(doc, "button", "aireader-chip", p.label);
      c.addEventListener("click", () => this.onChatSend(body, p.q, { broad: p.broad, autoApply: p.autoApply, annos: p.annos }));
      chips.appendChild(c);
    }
    body.appendChild(chips);

    const composer = this._el(doc, "div", "aireader-composer");
    const input = this._el(doc, "textarea", "aireader-chat-input");
    input.setAttribute("rows", "1");
    input.setAttribute("data-l10n-id", "aireader-chat-placeholder");
    input.setAttribute("placeholder", "有什么尽管问我…");
    input.addEventListener("keydown", (ev) => {
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); this.onChatSend(body); }
      else if (ev.key === "Escape") { const st = this._bodyState.get(body); if (st && st.streaming) { ev.preventDefault(); st.cancel = true; } }
    });
    input.addEventListener("input", () => { input.style.height = "auto"; input.style.height = Math.min(140, input.scrollHeight) + "px"; });
    const send = this._el(doc, "button", "aireader-send", "↑");
    send.title = "Send";
    send.addEventListener("click", () => {
      const st = this._bodyState.get(body);
      if (st && st.streaming) { st.cancel = true; }
      else { this.onChatSend(body); }
    });
    composer.appendChild(input); composer.appendChild(send);

    // Footer (model switcher + clear) sits just ABOVE the composer so the input
    // box is the bottom-most row of the panel.
    const footer = this._el(doc, "div", "aireader-footer");
    const modelPill = this._el(doc, "button", "aireader-modelpill");
    modelPill.addEventListener("click", (ev) => { ev.stopPropagation(); this.toggleModelMenu(body); });
    footer.appendChild(modelPill);
    footer.appendChild(this._el(doc, "div", "aireader-foot-spacer"));
    const clear = this._el(doc, "button", "aireader-foot-btn", "清空");
    clear.addEventListener("click", () => this.onClear(body));
    footer.appendChild(clear);
    body.appendChild(footer);

    body.appendChild(composer);

    const preview = this._el(doc, "div", "aireader-preview");
    preview.style.display = "none";
    body.appendChild(preview);

    const state = {
      item, attachment: null, blocks: null, doc, body,
      status, chatMsgs, input, send, modelPill, chips, composer, footer, preview,
      modelMenu: null, modelList: null, _onDoc: null, streaming: false, cancel: false,
    };
    this._bodyState.set(body, state);
    this.updateModelPill(state);

    // Scroll containment (lightweight): let the messages area and any scrollable
    // child scroll NATIVELY — overscroll-behavior:contain (CSS) stops the scroll
    // from chaining out to the window when it reaches a boundary. We only
    // preventDefault wheel over NON-scrollable regions (top bar, chips, empty
    // space) so those don't chain to the window/other apps. Doing it this way
    // keeps normal scroll-up-to-history working (a full manual trap broke it).
    const win = doc.defaultView;
    body.addEventListener("wheel", (ev) => {
      let el = ev.target;
      while (el && el !== body && el.nodeType === 1) {
        if (el.scrollHeight - el.clientHeight > 1) {
          let oy = ""; try { oy = win.getComputedStyle(el).overflowY; } catch (e) {}
          if (oy === "auto" || oy === "scroll") return; // native scroll handles it
        }
        el = el.parentNode;
      }
      ev.preventDefault(); // over a non-scrollable area → don't chain out
    }, { passive: false });

    // Measure the panel's real height = window height - our top offset, instead
    // of guessing a reserve. The flex layout (messages flex:1) then keeps the
    // chips/composer visible. CSS calc() is only the pre-measurement fallback.
    try {
      const win2 = doc.defaultView;
      const size = () => this._sizeRoot(state);
      if (win2 && win2.requestAnimationFrame) win2.requestAnimationFrame(size); else size();
      if (win2 && win2.setTimeout) win2.setTimeout(size, 150);
      if (win2 && win2.addEventListener) { state._onWinResize = size; win2.addEventListener("resize", size); }
    } catch (e) { this.log("sizeRoot setup error: " + e); }

    // Safety: clear any stale full-height attribute from older versions so the
    // panel can never get stranded blank.
    try { state.doc.documentElement.removeAttribute("data-air-view"); } catch (e) {}
  },

  // Set the panel's height to the measured available space (window bottom minus
  // our top). Precise, not a guessed reserve. Flex handles the rest.
  _sizeRoot(state) {
    try {
      const root = state && state.body;
      const win = root && root.ownerDocument && root.ownerDocument.defaultView;
      if (!root || !win) return;
      const top = root.getBoundingClientRect().top;
      const h = (win.innerHeight || 0) - top - 6;
      if (h > 140) { root.style.height = h + "px"; root.style.maxHeight = h + "px"; }
    } catch (e) {}
  },

  setComposerEnabled(state, on) {
    if (state.input) state.input.disabled = !on;
    if (state.send) state.send.disabled = !on;
  },

  updateSendButton(state) {
    if (!state.send) return;
    state.send.textContent = state.streaming ? "■" : "↑";
    state.send.classList && state.send.classList.toggle("aireader-send-stop", !!state.streaming);
  },

  updateModelPill(state) {
    if (!state.modelPill) return;
    state.modelPill.textContent = (this.getPref("model") || "选择模型") + "  ·  " + this._fmt() + "  ▾";
  },

  toggleModelMenu(body) {
    const state = this._bodyState.get(body);
    if (!state) return;
    if (state.modelMenu) { this.closeModelMenu(state); return; }
    const doc = state.doc;
    const C = this._menuColors(doc);
    const menu = this._el(doc, "div", "aireader-modelmenu");
    // Inline styling wins over any stale/undefined CSS and guarantees legibility.
    menu.style.cssText += ";background:" + C.bg + ";color:" + C.fg + ";border:1px solid " + C.border + ";font-family:" + this._UIFONT + ";";
    const fmtRow = this._el(doc, "div", "aireader-fmtrow");
    const cur = this._fmt();
    for (const [val, lbl] of [["chat", "chat"], ["responses", "responses"], ["anthropic", "claude"]]) {
      const on = cur === val;
      const b = this._el(doc, "button", "aireader-fmt" + (on ? " aireader-fmt-on" : ""), lbl);
      b.style.cssText += ";font-family:" + this._UIFONT + ";color:" + (on ? "#fff" : C.fg) + ";background:" + (on ? C.accent : "transparent") + ";border:1px solid " + (on ? "transparent" : C.border) + ";";
      b.addEventListener("click", (ev) => { ev.stopPropagation(); Zotero.Prefs.set("aireader.apiFormat", val); this.updateModelPill(state); this.closeModelMenu(state); this.toggleModelMenu(body); });
      fmtRow.appendChild(b);
    }
    menu.appendChild(fmtRow);
    const listWrap = this._el(doc, "div", "aireader-modellist");
    listWrap.style.color = C.fg;
    menu.appendChild(listWrap);
    state.modelMenu = menu;
    body.appendChild(menu);
    this.populateModels(state, listWrap);
    const onDoc = (ev) => { if (state.modelMenu && !state.modelMenu.contains(ev.target) && ev.target !== state.modelPill) this.closeModelMenu(state); };
    state._onDoc = onDoc;
    setTimeout(() => doc.addEventListener("click", onDoc), 0);
  },

  closeModelMenu(state) {
    if (state._onDoc) { try { state.doc.removeEventListener("click", state._onDoc); } catch (e) {} state._onDoc = null; }
    if (state.modelMenu) { state.modelMenu.remove(); state.modelMenu = null; }
  },

  async populateModels(state, wrap) {
    const C = this._menuColors(state.doc);
    const render = (ids) => {
      const cur = this.getPref("model");
      wrap.textContent = "";
      for (const id of ids) {
        const on = id === cur;
        const it = this._el(state.doc, "div", "aireader-modelitem" + (on ? " aireader-modelitem-on" : ""), id);
        // Explicit colour + font so model names are legible, and flex:0 0 auto
        // + line-height so the flex column (fixed max-height, many items) does
        // NOT crush each row to a clipped sliver.
        it.style.cssText += ";color:" + (on ? C.accent : C.fg) + ";font-family:" + this._UIFONT + ";font-size:12px;line-height:1.6;flex:0 0 auto;" + (on ? "font-weight:600;" : "");
        it.addEventListener("mouseenter", () => { it.style.background = C.hover; });
        it.addEventListener("mouseleave", () => { it.style.background = "transparent"; });
        it.addEventListener("click", (ev) => { ev.stopPropagation(); Zotero.Prefs.set("aireader.model", id); this.updateModelPill(state); this.closeModelMenu(state); });
        wrap.appendChild(it);
      }
    };
    const msg = (t) => { wrap.textContent = t; wrap.style.cssText += ";color:" + C.muted + ";font-family:" + this._UIFONT + ";padding:6px 9px;"; };
    if (state.modelList) { render(state.modelList); return; }
    msg("加载模型中…");
    try {
      const ids = await this.fetchModels();
      state.modelList = ids;
      if (ids.length) render(ids); else msg("未获取到模型列表");
    } catch (e) { msg("加载失败: " + (e.message || e)); }
  },

  async fetchModels() {
    const base = this._normBase();
    if (!base) throw new Error("Base URL 未设置");
    const key = this.getPref("apiKey");
    if (!key) throw new Error("API Key 未设置");
    // Send both auth schemes so it works for OpenAI- and Anthropic-style gateways.
    const resp = await fetch(base + "/models", {
      headers: { Authorization: "Bearer " + key, "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    const raw = await resp.text();
    if (!resp.ok) throw new Error("HTTP " + resp.status + " " + raw.slice(0, 160));
    const data = JSON.parse(raw);
    const arr = Array.isArray(data.data) ? data.data : (Array.isArray(data) ? data : []);
    return arr.map((x) => (x && (x.id || x.name)) || x).filter((x) => typeof x === "string");
  },

  setStatus(state, msg, kind) {
    state.status.textContent = msg || "";
    state.status.className = "aireader-status" + (kind ? " aireader-status-" + kind : "");
  },

  async hydrate(body, item, doc) {
    const state = this._bodyState.get(body);
    if (!state) return;
    state.item = item;
    try {
      const att = await this.resolveAttachment(item);
      state.attachment = att;
      if (!att) { this.setStatus(state, "No attachment found for this item.", "muted"); this.setComposerEnabled(state, false); return; }
      this.setComposerEnabled(state, true);
      this._panels.set(att.key, state);

      // blocks: memory -> disk
      let blocks = this._blockStore.get(att.key);
      if (!blocks) { const disk = await this.loadCache(att); if (disk && disk.blocks) { blocks = disk.blocks; this._blockStore.set(att.key, blocks); } }
      if (blocks) state.blocks = blocks;

      // conversation: memory -> disk
      let hist = this._chatStore.get(att.key);
      if (!hist) { hist = (await this.loadChat(att)) || []; this._chatStore.set(att.key, hist); }
      this.renderChatHistory(state, hist);
      this.setStatus(state, "", "muted");
    } catch (e) { this.log("hydrate error: " + e); this.setStatus(state, "Error: " + e.message, "error"); }
  },

  requireKey(state) {
    if (!this.getPref("apiKey")) { this.setStatus(state, "先在设置里填 API Key。", "error"); Zotero.Utilities.Internal.openPreferences(this._prefPaneID); return false; }
    return true;
  },

  onClear(body) {
    const state = this._bodyState.get(body);
    if (!state || !state.attachment) return;
    this._chatStore.set(state.attachment.key, []);
    this.saveChat(state.attachment, []).catch(() => {});
    state.chatMsgs.textContent = "";
    this.setStatus(state, "已清空对话。", "muted");
  },

  // ---------------------------------------------------------------- blocks
  async ensureBlocks(state) {
    if (state.blocks && state.blocks.length) return state.blocks;
    this.setStatus(state, "正在提取正文…", "busy");
    const blocks = await this.extractBlocks(state.attachment.id);
    if (!blocks || !blocks.length) throw new Error("无法提取结构化文本（是文字版 PDF 吗？）。");
    state.blocks = blocks;
    this._blockStore.set(state.attachment.key, blocks);
    this.saveCache(state.attachment, blocks).catch(() => {});
    return blocks;
  },

  blockText(node) {
    if (typeof node.text === "string") return node.text;
    if (!Array.isArray(node.content)) return "";
    let out = "";
    for (const c of node.content) out += (typeof c.text === "string") ? c.text : this.blockText(c) + " ";
    return out;
  },

  async extractBlocks(attachmentID) {
    if (!Zotero.SDT || typeof Zotero.SDT.getReader !== "function") return this.extractBlocksFallback(attachmentID);
    const reader = await Zotero.SDT.getReader(attachmentID, { isPriority: true });
    if (!reader) return this.extractBlocksFallback(attachmentID);
    const struct = await reader.materialize();
    const pages = (struct.catalog && struct.catalog.pages) || [];
    const blocks = [];
    let id = 0;
    for (const node of struct.content) {
      if (node.flowClass === "excluded") continue;
      let text = this.blockText(node).replace(/\s+/g, " ").trim();
      if (!text && node.type !== "image") continue;
      if (text.length > 2000) text = text.slice(0, 2000) + "…";
      const rectsByPage = {};
      for (const pr of (node.anchor && node.anchor.pageRects) || []) { const pi = pr[0]; (rectsByPage[pi] = rectsByPage[pi] || []).push([pr[1], pr[2], pr[3], pr[4]]); }
      const pageIdxs = Object.keys(rectsByPage).map(Number).sort((a, b) => a - b);
      let position = null, pageLabel = "?", pageHeight = 792;
      if (pageIdxs.length) {
        const pi = pageIdxs[0];
        position = { pageIndex: pi, rects: rectsByPage[pi] };
        pageLabel = (pages[pi] && pages[pi].label) || String(pi + 1);
        const vr = pages[pi] && pages[pi].viewRect; if (vr) pageHeight = vr[3] - vr[1];
      }
      blocks.push({ id: id++, type: node.type, text, position, pageLabel, pageHeight });
    }
    return blocks;
  },

  async extractBlocksFallback(attachmentID) {
    const item = await Zotero.Items.getAsync(attachmentID);
    let text = "";
    try { text = await item.attachmentText; } catch (e) {}
    if (!text) { try { const r = await Zotero.PDFWorker.getFullText(attachmentID, null); text = r && r.text; } catch (e) {} }
    if (!text) return null;
    const paras = text.split(/\n\s*\n|\f/).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
    let id = 0;
    return paras.map((t) => ({ id: id++, type: "paragraph", text: t.length > 2000 ? t.slice(0, 2000) + "…" : t, position: null, pageLabel: "?", pageHeight: 792 }));
  },

  // --------------------------------------------------------- context build
  figKind(type) { return type === "image" ? "图" : type === "table" ? "表" : "公式"; },

  _figIndex(blocks) {
    const figs = [];
    for (const b of blocks) {
      if ((b.type === "image" || b.type === "table" || b.type === "math") && b.position) {
        figs.push("[B" + b.id + " p" + b.pageLabel + "] " + this.figKind(b.type) + (b.text ? ": " + b.text.slice(0, 60) : ""));
      }
    }
    return figs.length ? "\n\nFigures/tables/formulas index:\n" + figs.slice(0, 80).join("\n") : "";
  },

  // Full/broad context: sequential blocks until the char budget.
  buildContext(blocks) {
    const maxChars = Number(this.getPref("maxChars")) || 60000;
    const lines = []; let total = 0;
    for (const b of blocks) {
      if (b.type === "image" || b.type === "math") continue;
      const line = "[B" + b.id + " p" + b.pageLabel + "] " + b.text;
      if (total + line.length > maxChars) break;
      lines.push(line); total += line.length + 1;
    }
    return lines.join("\n") + this._figIndex(blocks);
  },

  tokenize(s) {
    const out = [];
    const low = (s || "").toLowerCase();
    const latin = low.match(/[a-z0-9]{2,}/g) || [];
    for (const w of latin) out.push(w);
    const cjk = (s || "").match(/[一-鿿]/g) || [];
    for (const c of cjk) out.push(c);
    return out;
  },

  // Query-relevant context via TF-IDF retrieval (keeps token use down and
  // citations precise on long papers).
  buildRetrievedContext(blocks, query) {
    const maxChars = Number(this.getPref("maxChars")) || 60000;
    const qtok = this.tokenize(query);
    if (!qtok.length) return this.buildContext(blocks);
    const textBlocks = blocks.filter((b) => b.type !== "image" && b.type !== "math" && b.text);
    const toks = textBlocks.map((b) => this.tokenize(b.text));
    const df = new Map();
    for (const t of toks) for (const w of new Set(t)) df.set(w, (df.get(w) || 0) + 1);
    const N = textBlocks.length || 1;
    const qset = new Set(qtok);
    const scored = textBlocks.map((b, i) => {
      const tf = new Map();
      for (const w of toks[i]) if (qset.has(w)) tf.set(w, (tf.get(w) || 0) + 1);
      let s = 0;
      for (const w of qset) if (tf.has(w)) s += tf.get(w) * Math.log(1 + N / ((df.get(w) || 0) + 1));
      return { id: b.id, s };
    });
    const chosen = new Set();
    for (const b of blocks) if (b.type === "heading") chosen.add(b.id); // keep structure
    scored.sort((a, b) => b.s - a.s);
    for (const { id, s } of scored) { if (s <= 0) break; chosen.add(id); }
    const lines = []; let total = 0;
    for (const b of blocks) {
      if (!chosen.has(b.id) || b.type === "image" || b.type === "math") continue;
      const line = "[B" + b.id + " p" + b.pageLabel + "] " + b.text;
      if (total + line.length > maxChars) break;
      lines.push(line); total += line.length + 1;
    }
    if (lines.length < 3) return this.buildContext(blocks); // fall back if query too sparse
    return lines.join("\n") + this._figIndex(blocks);
  },

  systemPrompt(ctx) {
    const lang = this.getPref("language") || "中文";
    return "你是针对某一篇学术论文的阅读助手，用" + lang + "回答。论文正文按块给出，每块形如 [B<id> p<页码>] 文本。要求：\n" +
      "1) 回答必须基于论文；论文没涉及的就说没涉及。\n" +
      "2) 在每个关键论断后用 [B<id>] 标出依据的块（可多个），方便用户点回原文。\n" +
      "3) 当用户要求划线/标注，或你认为某处值得高亮时，可输出指令：划线用 [[hl:<id>]]，加批注用 [[note:<id>|批注内容]]。这些会渲染成按钮由用户一键应用到 PDF。\n" +
      "4) 当用户想看某个图/表的视觉内容、或你需要看图才能准确解释时，输出 [[fig:<id>]]（id 为图/表块），会渲染该区域图像并交给多模态模型识图。\n" +
      "5) 若正文前附有【用户在 PDF 中的高亮与批注】，当用户问到『我的高亮/批注』时请优先结合这些内容回答。\n\n" +
      "论文内容：\n\n" + ctx;
  },

  // ---------------------------------------------------------------- chat UI
  renderChatHistory(state, hist) {
    state.chatMsgs.textContent = "";
    let lastUser = "";
    for (const m of hist) {
      if (m.role === "user") { this.appendUserMsg(state, m.content); lastUser = m.content; }
      else { const { msg, bubble } = this.appendAssistantMsg(state); this.enhanceMessage(state, bubble, m.content); this.addAssistantActions(state, msg, m.content, lastUser); }
    }
  },

  appendUserMsg(state, text) {
    const msg = this._el(state.doc, "div", "aireader-msg aireader-msg-user");
    msg.appendChild(this._el(state.doc, "div", "aireader-bubble", text));
    state.chatMsgs.appendChild(msg);
    state.chatMsgs.scrollTop = state.chatMsgs.scrollHeight;
  },

  appendAssistantMsg(state) {
    const msg = this._el(state.doc, "div", "aireader-msg aireader-msg-assistant");
    const bubble = this._el(state.doc, "div", "aireader-bubble");
    msg.appendChild(bubble);
    state.chatMsgs.appendChild(msg);
    state.chatMsgs.scrollTop = state.chatMsgs.scrollHeight;
    return { msg, bubble };
  },

  addAssistantActions(state, msg, fullText, question) {
    const doc = state.doc;
    const row = this._el(doc, "div", "aireader-actions");
    const mkAction = (label) => { const a = this._el(doc, "span", "aireader-action", label); row.appendChild(a); return a; };

    const copy = mkAction("复制");
    copy.addEventListener("click", () => { try { Zotero.Utilities.Internal.copyTextToClipboard(fullText); copy.textContent = "已复制"; setTimeout(() => (copy.textContent = "复制"), 1200); } catch (e) {} });

    if (question) mkAction("重新生成").addEventListener("click", () => this._regen(state, msg, question));

    const note = mkAction("存为笔记");
    note.addEventListener("click", async () => {
      note.textContent = "存中…";
      try { await this.saveNoteFromText(state, fullText, question); note.textContent = "✓ 已存"; setTimeout(() => (note.textContent = "存为笔记"), 1500); }
      catch (e) { note.textContent = "存失败"; this.log("saveNoteFromText error: " + e); }
    });

    // Apply-all when the answer contains highlight/note directives.
    const dCount = (fullText.match(/\[\[(?:hl|note):\d+/g) || []).length;
    if (dCount > 0) {
      const applyAll = mkAction("应用全部划线 (" + dCount + ")");
      applyAll.addEventListener("click", async () => {
        if (applyAll._done || applyAll._busy) return; // avoid duplicate highlights on repeat clicks
        applyAll._busy = true;
        applyAll.textContent = "应用中…";
        const n = await this.autoApplyDirectives(state, fullText);
        applyAll.textContent = n ? ("✓ 已应用 " + n + " 处") : "未识别到";
        applyAll._done = n > 0; applyAll._busy = false;
      });
    }
    msg.appendChild(row);

    // Quick follow-ups below the actions.
    if (question !== null) {
      const fups = this._el(doc, "div", "aireader-followups");
      fups.appendChild(this._el(doc, "span", "aireader-followups-label", "追问"));
      const FOLLOWUPS = [["更详细", "请在上一条回答基础上展开讲得更详细，补充细节与例子。"], ["举个例子", "针对上一条回答，给一个具体例子帮助理解。"], ["继续", "继续补充上一条回答里没展开的要点。"], ["通俗点", "把上一条回答用更通俗、面向非专业读者的方式再讲一遍。"]];
      for (const [label, q] of FOLLOWUPS) {
        const c = this._el(doc, "button", "aireader-followup", label);
        c.addEventListener("click", () => this._send(state, q, { broad: false }));
        fups.appendChild(c);
      }
      msg.appendChild(fups);
    }
  },

  _regen(state, msg, question) {
    try { msg.remove(); } catch (e) {}
    const hist = this._chatStore.get(state.attachment.key) || [];
    if (hist.length && hist[hist.length - 1].role === "assistant") hist.pop();
    this._send(state, question, { skipUser: true, broad: false });
  },

  onChatSend(body, forcedText, opts) {
    const state = this._bodyState.get(body);
    if (!state || !state.attachment) return;
    const q = forcedText != null ? forcedText : (state.input.value || "").trim();
    if (!q) return;
    if (forcedText == null) state.input.value = "";
    return this._send(state, q, opts || { broad: false });
  },

  async _send(state, text, opts) {
    opts = opts || {};
    if (!this.requireKey(state)) return;
    if (state.streaming) return;
    const key = state.attachment.key;
    let hist = this._chatStore.get(key);
    if (!hist) { hist = []; this._chatStore.set(key, hist); }

    if (!opts.skipUser) this.appendUserMsg(state, text);
    const { msg, bubble } = this.appendAssistantMsg(state);
    bubble.classList.add("aireader-streaming");
    state.streaming = true; state.cancel = false; this.updateSendButton(state);

    const meta = {};
    try {
      await this.ensureBlocks(state);
      let ctx = opts.broad ? this.buildContext(state.blocks) : this.buildRetrievedContext(state.blocks, text);
      if (opts.annos) {
        const ua = await this.getUserAnnotations(state.attachment);
        if (ua.length) ctx = "【用户在 PDF 中的高亮与批注】（按出现顺序，优先结合这些回答）：\n" + ua.join("\n") + "\n\n——\n\n论文正文：\n" + ctx;
        else this.setStatus(state, "这篇论文还没有你的高亮/批注。", "muted");
      }
      meta.ctxChars = ctx.length;
      this.setStatus(state, "生成中…", "busy");
      // On regen (skipUser) the question is already the last history entry, so
      // don't append it again (that duplicated it in the prompt).
      const messages = [{ role: "system", content: this.systemPrompt(ctx) }, ...hist.slice(-12)];
      if (!opts.skipUser) messages.push({ role: "user", content: text });

      let acc = "", lastR = 0;
      const full = await this.callLLMStream(messages, (d) => {
        acc += d;
        const el = state.chatMsgs;
        // Only auto-follow if the user is already near the bottom; don't yank
        // them back down while they're scrolling up to read earlier content.
        const stick = (el.scrollHeight - el.scrollTop - el.clientHeight) < 60;
        const now = Date.now();
        if (now - lastR > 140) { lastR = now; try { this.renderRich(state, bubble, acc); } catch (e) { bubble.textContent = acc; } }
        this.setStatus(state, "生成中… " + acc.length + " 字", "busy");
        if (stick) el.scrollTop = el.scrollHeight;
      }, () => state.cancel, meta);

      bubble.classList.remove("aireader-streaming");
      this.enhanceMessage(state, bubble, full);
      this.addAssistantActions(state, msg, full, text);
      this.addMetaLine(state, msg, meta, full);
      this.setStatus(state, "", "");
      if (!opts.skipUser) hist.push({ role: "user", content: text });
      hist.push({ role: "assistant", content: full });
      this.saveChat(state.attachment, hist).catch(() => {});
      if (opts.autoApply) { const n = await this.autoApplyDirectives(state, full); this.setStatus(state, n ? ("已自动高亮 " + n + " 处。") : "未识别到可高亮的句子。", n ? "ok" : "muted"); }
    } catch (e) {
      bubble.classList.remove("aireader-streaming");
      bubble.textContent = (state.cancel ? "（已停止）" : "Error: " + e.message);
    } finally {
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
      const ctxk = meta.ctxChars != null ? (" · 上下文 " + (meta.ctxChars >= 1000 ? (meta.ctxChars / 1000).toFixed(1) + "k" : meta.ctxChars) + " 字") : "";
      const line = this._el(doc, "div", "aireader-meta", inTok + "⬇ " + approx + outTok + " tok" + ctxk);
      msg.appendChild(line);
    } catch (e) {}
  },

  // Rebuild assistant bubble. Prefer full Markdown + KaTeX rendering; fall back
  // to the lightweight line renderer if the libs are missing or anything throws
  // (so a render error can never blank the panel).
  enhanceMessage(state, bubble, text) {
    try {
      if (typeof marked !== "undefined" && marked && typeof marked.parse === "function") {
        this.renderRich(state, bubble, text);
        return;
      }
    } catch (e) { this.log("rich render failed, falling back: " + e); }
    this._renderLines(state, bubble, text);
  },

  // --- rich (markdown + math) ---
  _extractMath(text) {
    const maths = [];
    const stash = (tex, display) => { maths.push({ tex, display }); return "\u0000M" + (maths.length - 1) + "\u0000"; };
    let t = text;
    t = t.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex) => stash(tex, true));
    t = t.replace(/\\\[([\s\S]+?)\\\]/g, (m, tex) => stash(tex, true));
    t = t.replace(/\\\(([\s\S]+?)\\\)/g, (m, tex) => stash(tex, false));
    t = t.replace(/(?<![\w$])\$(?!\s)([^\n$]+?)\$(?![\w$])/g, (m, tex) => stash(tex, false));
    return { t, maths };
  },

  _mathAndMarkdown(text) {
    const { t, maths } = this._extractMath(text || "");
    let html = marked.parse(t, { breaks: true, gfm: true });
    html = html.replace(/\u0000M(\d+)\u0000/g, (m, i) => {
      const o = maths[+i]; if (!o) return "";
      try { return (typeof katex !== "undefined") ? katex.renderToString(o.tex, { displayMode: o.display, throwOnError: false }) : o.tex; }
      catch (e) { return o.tex; }
    });
    return html;
  },

  renderRich(state, bubble, text) {
    const doc = state.doc;
    const html = this._mathAndMarkdown(text);
    const tmp = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    tmp.innerHTML = html;
    this._sanitize(tmp);
    bubble.textContent = "";
    bubble.classList.add("aireader-rich");
    while (tmp.firstChild) bubble.appendChild(tmp.firstChild);
    this._linkifyTokens(state, bubble);
  },

  // Strip anything executable from model-produced HTML before insertion.
  _sanitize(root) {
    try {
      root.querySelectorAll("script,style,iframe,object,embed,link,meta,base,form,input,button").forEach((n) => n.remove());
      root.querySelectorAll("*").forEach((el) => {
        for (const a of Array.from(el.attributes)) {
          const n = a.name.toLowerCase();
          if (n.startsWith("on")) el.removeAttribute(a.name);
          if ((n === "href" || n === "src") && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
        }
      });
    } catch (e) {}
  },

  // Walk rendered text nodes and turn [B<id>] / [[hl|note|fig:id]] into elements.
  _linkifyTokens(state, root) {
    const doc = state.doc;
    const re = /\[\[(?:hl|note|fig):\d+|\[B\d+\]/;
    const targets = [];
    try {
      const walker = doc.createTreeWalker(root, 4 /* SHOW_TEXT */);
      let n; while ((n = walker.nextNode())) { if (re.test(n.nodeValue)) targets.push(n); }
    } catch (e) { return; }
    for (const tn of targets) {
      const frag = doc.createDocumentFragment();
      this.renderInline(state, frag, tn.nodeValue);
      if (tn.parentNode) tn.parentNode.replaceChild(frag, tn);
    }
  },

  // --- fallback line renderer (no libs) ---
  _isTableRow(s) { return /^\s*\|.*\|\s*$/.test(s); },
  _isTableDelim(s) { return /\|/.test(s) && /^\s*\|?[\s:|-]+\|?\s*$/.test(s) && /-/.test(s); },
  _splitRow(s) {
    let t = s.trim();
    if (t.startsWith("|")) t = t.slice(1);
    if (t.endsWith("|")) t = t.slice(0, -1);
    return t.split("|").map((c) => c.trim());
  },
  _renderTable(state, bubble, headerLine, bodyLines) {
    const doc = state.doc;
    const wrap = this._el(doc, "div", "aireader-tablewrap");
    const table = this._el(doc, "table", "aireader-md-table");
    const thead = this._el(doc, "thead");
    const htr = this._el(doc, "tr");
    for (const c of this._splitRow(headerLine)) { const th = this._el(doc, "th"); this.renderInline(state, th, c); htr.appendChild(th); }
    thead.appendChild(htr); table.appendChild(thead);
    const tbody = this._el(doc, "tbody");
    for (const bl of bodyLines) {
      const tr = this._el(doc, "tr");
      for (const c of this._splitRow(bl)) { const td = this._el(doc, "td"); this.renderInline(state, td, c); tr.appendChild(td); }
      tbody.appendChild(tr);
    }
    table.appendChild(tbody); wrap.appendChild(table); bubble.appendChild(wrap);
  },
  _renderLines(state, bubble, text) {
    const doc = state.doc;
    bubble.textContent = "";
    const lines = (text || "").split(/\r?\n/);
    let ul = null;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();
      // GFM table block: header row, delimiter row, then body rows.
      if (this._isTableRow(trimmed) && i + 1 < lines.length && this._isTableDelim(lines[i + 1].trim())) {
        ul = null;
        const body = [];
        let j = i + 2;
        while (j < lines.length && this._isTableRow(lines[j].trim())) { body.push(lines[j].trim()); j++; }
        this._renderTable(state, bubble, trimmed, body);
        i = j - 1;
        continue;
      }
      const isBullet = /^[-*•]\s+/.test(trimmed) || /^\d+[.)]\s+/.test(trimmed);
      if (isBullet) {
        if (!ul) { ul = this._el(doc, "ul", "aireader-md-ul"); bubble.appendChild(ul); }
        const li = this._el(doc, "li");
        this.renderInline(state, li, trimmed.replace(/^([-*•]|\d+[.)])\s+/, ""));
        ul.appendChild(li);
      } else {
        ul = null;
        if (!trimmed) continue;
        const p = this._el(doc, "div", "aireader-md-p");
        this.renderInline(state, p, trimmed.replace(/^#{1,6}\s+/, ""));
        bubble.appendChild(p);
      }
    }
    if (!bubble.childNodes.length) bubble.textContent = text || "";
  },

  renderInline(state, container, text) {
    const doc = state.doc;
    const byId = new Map((state.blocks || []).map((b) => [b.id, b]));
    const re = /\[\[(hl|note|fig):(\d+)(?:\|([^\]]*))?\]\]|\[B(\d+)\]|\*\*([^*]+)\*\*|`([^`]+)`/g;
    let last = 0, m;
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) container.appendChild(doc.createTextNode(text.slice(last, m.index)));
      last = re.lastIndex;
      if (m[1]) {
        const block = byId.get(Number(m[2]));
        if (block && block.position) {
          container.appendChild(m[1] === "fig"
            ? this.makeFigButton(state, block)
            : this.makeApplyButton(state, block, m[1], m[3] || ""));
        }
      } else if (m[4] !== undefined) {
        const block = byId.get(Number(m[4]));
        if (block && block.position) {
          const badge = this._el(doc, "a", "aireader-ref", "p" + block.pageLabel);
          badge.addEventListener("click", (ev) => { ev.preventDefault(); AIReader.navigateTo(state.attachment.id, block); });
          badge.addEventListener("mouseenter", (ev) => this.showPreview(state, ev, block));
          badge.addEventListener("mouseleave", () => this.hidePreview(state));
          container.appendChild(badge);
        } else { container.appendChild(doc.createTextNode(m[0])); }
      } else if (m[5] !== undefined) {
        container.appendChild(this._el(doc, "strong", null, m[5]));
      } else if (m[6] !== undefined) {
        container.appendChild(this._el(doc, "code", "aireader-code", m[6]));
      }
    }
    if (last < text.length) container.appendChild(doc.createTextNode(text.slice(last)));
  },

  showPreview(state, ev, block) {
    const p = state.preview; if (!p) return;
    p.textContent = block.text || "";
    p.style.display = "block";
    try {
      const rootRect = state.body.getBoundingClientRect();
      const r = ev.target.getBoundingClientRect();
      p.style.left = Math.max(4, r.left - rootRect.left) + "px";
      p.style.top = (r.bottom - rootRect.top + 4) + "px";
    } catch (e) {}
  },
  hidePreview(state) { if (state.preview) state.preview.style.display = "none"; },

  makeApplyButton(state, block, kind, comment) {
    const doc = state.doc;
    const baseLabel = (kind === "note" ? "✎ 应用批注 p" : "✎ 应用划线 p") + block.pageLabel;
    const btn = this._el(doc, "a", "aireader-apply", baseLabel);
    btn.title = (comment ? comment + "\n\n" : "") + block.text.slice(0, 160);
    // Render the applied state: label (click → jump to PDF) + a ✕ to remove.
    const setApplied = () => {
      btn.textContent = "";
      btn.classList.add("aireader-apply-done");
      const lbl = this._el(doc, "span", "aireader-apply-label", "✓ 已标注 p" + block.pageLabel + " · 点击跳转");
      const del = this._el(doc, "span", "aireader-apply-del", "✕");
      del.title = "取消该标注";
      del.addEventListener("click", async (ev) => {
        ev.preventDefault(); ev.stopPropagation();
        if (btn._busy) return; btn._busy = true;
        try {
          // Sweep EVERY AI annotation at this block's spot. Applying both 划线
          // and 批注 to one block stacks two overlapping highlights; deleting
          // only one leaves the other ("颜色浅了一下还在"). The sweep clears all.
          let removed = 0;
          try { removed = await AIReader.removeAnnotationsForBlock(state.attachment, block); } catch (e) { AIReader.log("sweep remove: " + e); }
          // Fallback: nothing matched by spot (e.g. sortIndex drift) → delete the
          // exact annotation this button created.
          if (!removed) await AIReader.removeAnnotation(btn._ann, state.attachment);
          btn._ann = null; btn.classList.remove("aireader-apply-done"); btn.textContent = baseLabel;
        }
        catch (e) { del.textContent = "✕?"; del.title = "取消失败：" + (e.message || e); AIReader.log("remove annotation error: " + e); }
        finally { btn._busy = false; }
      });
      btn.appendChild(lbl); btn.appendChild(del);
    };
    btn.addEventListener("click", async (ev) => {
      ev.preventDefault();
      if (btn._busy) return;
      if (btn._ann) { AIReader.navigateTo(state.attachment.id, block); return; } // applied → jump to PDF
      btn._busy = true;
      btn.textContent = "…";
      try {
        btn._ann = (await AIReader.applyAnnotation(state.attachment, block, { type: "highlight", comment })) || true;
        setApplied();
      } catch (e) {
        btn.textContent = "✗ " + (e.message || "失败");
        AIReader.log("apply annotation error: " + e);
      } finally { btn._busy = false; }
    });
    return btn;
  },

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

  makeFigButton(state, block) {
    const btn = this._el(state.doc, "a", "aireader-apply aireader-figbtn", "🔍 看图 p" + block.pageLabel);
    btn.title = "渲染该区域并用多模态模型识图";
    btn.addEventListener("click", (ev) => { ev.preventDefault(); this.explainFigure(state, block); });
    return btn;
  },

  // Render the figure's PDF region to a PNG and have a multimodal model read it.
  async explainFigure(state, block) {
    if (!this.requireKey(state)) return;
    const key = state.attachment.key;
    let hist = this._chatStore.get(key); if (!hist) { hist = []; this._chatStore.set(key, hist); }
    const label = "看图解释 p" + block.pageLabel;
    this.appendUserMsg(state, label);
    const { msg, bubble } = this.appendAssistantMsg(state);
    bubble.textContent = "正在渲染图像…";
    try {
      const dataURI = await this.renderRegionDataURI(state.attachment, block);
      bubble.textContent = "正在识图…";
      const idx = state.blocks.findIndex((b) => b.id === block.id);
      const around = state.blocks.slice(Math.max(0, idx - 2), idx + 3).map((b) => b.text).join("\n");
      const lang = this.getPref("language") || "中文";
      const prompt = "请结合论文语境解读这张" + this.figKind(block.type) + "（第" + block.pageLabel +
        "页）：它展示了什么、关键结论是什么。附近文字：\n" + around;
      const messages = this.buildVisionMessages(this._fmt(), lang, prompt, dataURI);
      const ans = await this.callLLM(messages);
      bubble.textContent = "";
      this.enhanceMessage(state, bubble, ans);
      this.addAssistantActions(state, msg, ans, null);
      hist.push({ role: "user", content: label });
      hist.push({ role: "assistant", content: ans });
      this.saveChat(state.attachment, hist).catch(() => {});
    } catch (e) {
      bubble.textContent = "看图失败: " + e.message;
      this.log("explainFigure error: " + e);
    }
  },

  // Create a temporary image annotation over the block's bbox, render it to a
  // cached PNG via the PDF worker, read it as a data URI, then clean up.
  async renderRegionDataURI(attachment, block) {
    if (!Zotero.PDFWorker || typeof Zotero.PDFWorker.renderAttachmentAnnotations !== "function") {
      throw new Error("渲染 API 不可用（需 Zotero PDF）");
    }
    const rects = block.position.rects;
    let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
    for (const r of rects) { x1 = Math.min(x1, r[0]); y1 = Math.min(y1, r[1]); x2 = Math.max(x2, r[2]); y2 = Math.max(y2, r[3]); }
    const json = {
      key: Zotero.Utilities.generateObjectKey(),
      type: "image",
      color: this.HILITE_COLOR,
      pageLabel: block.pageLabel === "?" ? "" : String(block.pageLabel),
      sortIndex: this.sortIndex(block),
      position: { pageIndex: block.position.pageIndex, rects: [[x1, y1, x2, y2]] },
    };
    const saved = await Zotero.Annotations.saveFromJSON(attachment, json);
    // Resolve the real annotation Item by key so toJSON works AND the temporary
    // annotation is reliably erased afterwards (otherwise it litters the PDF).
    let ann = (saved && typeof saved.eraseTx === "function") ? saved : null;
    if (!ann) { try { if (Zotero.Items.getByLibraryAndKey) ann = Zotero.Items.getByLibraryAndKey(attachment.libraryID, json.key) || null; } catch (e) {} }
    if (!ann) ann = saved;
    try {
      await Zotero.PDFWorker.renderAttachmentAnnotations(attachment.id);
      const j = await Zotero.Annotations.toJSON(ann);
      if (!j || !j.image) throw new Error("渲染结果为空");
      return j.image; // data:image/png;base64,...
    } finally {
      try {
        if (ann && typeof ann.eraseTx === "function") await ann.eraseTx();
        else if (Zotero.Items.getByLibraryAndKey) { const it = Zotero.Items.getByLibraryAndKey(attachment.libraryID, json.key); if (it && it.eraseTx) await it.eraseTx(); }
      } catch (e) {}
      try { await Zotero.Annotations.removeCacheImage(ann); } catch (e) {}
    }
  },

  buildVisionMessages(fmt, lang, prompt, dataURI) {
    const sys = { role: "system", content: "你是学术论文阅读助手，看图并用" + lang + "解读，简明准确。" };
    if (fmt === "anthropic") {
      const b64 = dataURI.replace(/^data:image\/[a-z]+;base64,/, "");
      return [sys, { role: "user", content: [{ type: "text", text: prompt }, { type: "image", source: { type: "base64", media_type: "image/png", data: b64 } }] }];
    }
    // chat / responses: OpenAI-style image_url
    return [sys, { role: "user", content: [{ type: "text", text: prompt }, { type: "image_url", image_url: { url: dataURI } }] }];
  },

  async autoApplyDirectives(state, text) {
    const byId = new Map((state.blocks || []).map((b) => [b.id, b]));
    const re = /\[\[(hl|note):(\d+)(?:\|([^\]]*))?\]\]/g;
    let m, n = 0;
    while ((m = re.exec(text)) !== null) {
      const block = byId.get(Number(m[2]));
      if (block && block.position) {
        try { await this.applyAnnotation(state.attachment, block, { type: "highlight", comment: m[1] === "note" ? (m[3] || "") : "" }); n++; }
        catch (e) { this.log("autoApply error: " + e); }
      }
    }
    return n;
  },

  async navigateTo(attachmentID, block) {
    if (!block || !block.position) return;
    try { await Zotero.Reader.open(attachmentID, { position: block.position }); } catch (e) { this.log("navigate error: " + e); }
  },

  // ---------------------------------------------------- annotation writing
  sortIndex(block) {
    const pi = block.position.pageIndex;
    let topY = 0; for (const r of block.position.rects) topY = Math.max(topY, r[3]);
    const top = Math.max(0, Math.floor((block.pageHeight || 792) - topY));
    const pad = (n, w) => String(n).slice(0, w).padStart(w, "0");
    return pad(pi, 5) + "|" + pad(0, 6) + "|" + pad(top, 5);
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

  async applyAnnotation(attachment, block, { type, comment }) {
    if (!attachment || !attachment.libraryID) throw new Error("No attachment");
    if (!Zotero.Annotations || typeof Zotero.Annotations.saveFromJSON !== "function") throw new Error("Annotation API unavailable");
    const json = {
      key: Zotero.Utilities.generateObjectKey(),
      type: type || "highlight",
      text: block.text,
      comment: comment || "",
      color: this.HILITE_COLOR,
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

  // ----------------------------------------------------- save as Zotero note
  async saveNote(body) {
    const state = this._bodyState.get(body);
    if (!state || !state.attachment) return;
    const hist = this._chatStore.get(state.attachment.key) || [];
    if (!hist.length) { this.setStatus(state, "没有可保存的对话。", "muted"); return; }
    try {
      let inner = "";
      for (const m of hist) {
        if (m.role === "user") inner += "<p><strong>问：</strong>" + this._escapeHTML(m.content) + "</p>\n";
        else inner += this._answerToHTML(state, m.content);
      }
      inner += this._noteFooter();
      const n = await this._appendOrCreateNote(state, inner);
      this.setStatus(state, n && n._aireaderAppended ? "已追加到现有 AI 笔记。" : "已存为 Zotero 笔记。", "ok");
    } catch (e) { this.log("saveNote error: " + e); this.setStatus(state, "存笔记失败: " + e.message, "error"); }
  },

  // Save a single answer (optionally with its question) to the item's AI note.
  async saveNoteFromText(state, text, question) {
    let inner = "";
    if (question) inner += "<p><strong>问：</strong>" + this._escapeHTML(question) + "</p>\n";
    inner += this._answerToHTML(state, text);
    inner += this._noteFooter();
    await this._appendOrCreateNote(state, inner);
  },

  _noteFooter() {
    const model = this.getPref("model") || "";
    const when = new Date().toLocaleString();
    return '<p style="color:#9aa0a6;font-size:0.85em">— AI Reader · ' + this._escapeHTML(model) + " · " + this._escapeHTML(when) + "</p>\n";
  },

  async _findAINote(parent) {
    try {
      if (!parent || !parent.getNotes) return null;
      for (const id of (parent.getNotes() || [])) {
        const n = Zotero.Items.get(id);
        if (n && n.hasTag && n.hasTag("AI Reader")) return n;
      }
    } catch (e) {}
    return null;
  },

  // Append to the item's existing "AI Reader"-tagged note, or create one.
  async _appendOrCreateNote(state, innerHTML) {
    let parent = state.item;
    if (parent && parent.isAttachment && parent.isAttachment()) parent = parent.parentItem || parent;
    if (!parent) throw new Error("无父条目");
    const existing = await this._findAINote(parent);
    if (existing) {
      existing.setNote(existing.getNote() + "\n<hr/>\n" + innerHTML);
      await existing.saveTx();
      existing._aireaderAppended = true;
      return existing;
    }
    const title = (state.item && state.item.getDisplayTitle && state.item.getDisplayTitle()) || "AI Reader";
    const note = new Zotero.Item("note");
    note.libraryID = parent.libraryID;
    if (parent.isRegularItem && parent.isRegularItem()) note.parentID = parent.id;
    note.setNote("<h1>AI Reader — " + this._escapeHTML(title) + "</h1>\n" + innerHTML);
    try { note.addTag("AI Reader"); } catch (e) {}
    await note.saveTx();
    return note;
  },

  _answerToHTML(state, text) {
    const lines = (text || "").split(/\r?\n/);
    let html = "", inUl = false;
    for (const line of lines) {
      const t = line.trim();
      const bullet = /^[-*•]\s+/.test(t) || /^\d+[.)]\s+/.test(t);
      if (bullet) { if (!inUl) { html += "<ul>"; inUl = true; } html += "<li>" + this._mdInlineHTML(state, t.replace(/^([-*•]|\d+[.)])\s+/, "")) + "</li>"; }
      else { if (inUl) { html += "</ul>"; inUl = false; } if (t) html += "<p>" + this._mdInlineHTML(state, t.replace(/^#{1,6}\s+/, "")) + "</p>\n"; }
    }
    if (inUl) html += "</ul>";
    return html;
  },

  _escapeHTML(s) { return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;"); },

  _mdInlineHTML(state, text) {
    const byId = new Map((state.blocks || []).map((b) => [b.id, b]));
    let out = "", last = 0, m;
    const re = /\[\[(hl|note):(\d+)(?:\|([^\]]*))?\]\]|\[B(\d+)\]|\*\*([^*]+)\*\*|`([^`]+)`/g;
    while ((m = re.exec(text)) !== null) {
      out += this._escapeHTML(text.slice(last, m.index));
      last = re.lastIndex;
      if (m[1]) { /* drop annotation directives in notes */ }
      else if (m[4] !== undefined) {
        const b = byId.get(Number(m[4]));
        if (b) {
          const key = state.attachment && state.attachment.key;
          const page = (b.pageLabel && b.pageLabel !== "?") ? b.pageLabel : "";
          if (key && page) out += ' <a href="zotero://open-pdf/library/items/' + key + "?page=" + encodeURIComponent(page) + '" style="color:#3b7ddd;text-decoration:none">(p' + this._escapeHTML(page) + ")</a>";
          else out += ' <span style="color:#888">(p' + this._escapeHTML(b.pageLabel) + ")</span>";
        }
      }
      else if (m[5] !== undefined) out += "<strong>" + this._escapeHTML(m[5]) + "</strong>";
      else if (m[6] !== undefined) out += "<code>" + this._escapeHTML(m[6]) + "</code>";
    }
    out += this._escapeHTML(text.slice(last));
    return out;
  },

  historyToHTML(state, hist) {
    const title = (state.item && state.item.getDisplayTitle && state.item.getDisplayTitle()) || "AI Reader";
    let html = "<h1>AI Reader — " + this._escapeHTML(title) + "</h1>\n";
    for (const m of hist) {
      if (m.role === "user") html += "<p><strong>问：</strong>" + this._escapeHTML(m.content) + "</p>\n";
      else html += this._answerToHTML(state, m.content);
    }
    return html;
  },

  // ---------------------------------------------------------------- LLM
  _fmt() { const f = (this.getPref("apiFormat") || "chat").trim(); return ["chat", "responses", "anthropic"].includes(f) ? f : "chat"; },
  _normBase() {
    let b = (this.getPref("baseURL") || "").trim().replace(/\/+$/, "");
    if (!b) return b;
    // Remote http endpoints usually redirect to https, and that cross-scheme
    // redirect strips the auth header ("未提供令牌"). Upgrade to https, but keep
    // localhost on http (e.g. Ollama).
    const m = b.match(/^http:\/\/([^/]+)/);
    if (m && !/^(localhost|127\.|0\.0\.0\.0|\[::1\]|\[?::1)/i.test(m[1])) b = b.replace(/^http:\/\//i, "https://");
    if (/^https?:\/\/[^/]+$/.test(b)) b += "/v1";
    return b;
  },
  _endpointFor(fmt) { const base = this._normBase(); if (!base) throw new Error("Base URL is not set."); if (fmt === "responses") return base + "/responses"; if (fmt === "anthropic") return base + "/messages"; return base + "/chat/completions"; },
  _headersFor(fmt) { const key = this.getPref("apiKey"); if (fmt === "anthropic") return { "Content-Type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" }; return { "Content-Type": "application/json", Authorization: "Bearer " + key }; },
  _bodyFor(fmt, messages, stream) {
    const model = this.getPref("model");
    const t = parseFloat(this.getPref("temperature")); const temp = isNaN(t) ? 0.3 : t;
    // maxTokens: 0 (or unset) => do not cap (Anthropic requires the field, so use a generous fallback).
    const mtRaw = parseInt(this.getPref("maxTokens"), 10);
    const maxTok = isNaN(mtRaw) || mtRaw <= 0 ? 0 : mtRaw;
    if (fmt === "responses") {
      const body = { model, input: messages, temperature: temp, stream: !!stream };
      if (maxTok) body.max_output_tokens = maxTok;
      return JSON.stringify(body);
    }
    if (fmt === "anthropic") {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const msgs = messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content }));
      // Anthropic requires max_tokens; when uncapped, request a large ceiling so answers aren't truncated.
      const body = { model, messages: msgs, max_tokens: maxTok || 32000, temperature: temp, stream: !!stream };
      if (system) body.system = system;
      return JSON.stringify(body);
    }
    const body = { model, messages, temperature: temp, stream: !!stream };
    if (maxTok) body.max_tokens = maxTok;
    if (stream) body.stream_options = { include_usage: true }; // OpenAI usage in final chunk
    return JSON.stringify(body);
  },

  _captureUsage(meta, j) {
    const u = j.usage || (j.message && j.message.usage) || (j.response && j.response.usage);
    if (u) {
      if (u.prompt_tokens != null) meta.inTok = u.prompt_tokens;
      if (u.input_tokens != null) meta.inTok = u.input_tokens;
      if (u.completion_tokens != null) meta.outTok = u.completion_tokens;
      if (u.output_tokens != null) meta.outTok = u.output_tokens;
    }
  },
  _extractContent(fmt, data) {
    if (fmt === "responses") { if (typeof data.output_text === "string") return data.output_text; if (Array.isArray(data.output)) return data.output.map((o) => Array.isArray(o.content) ? o.content.map((c) => c.text || "").join("") : "").join(""); return undefined; }
    if (fmt === "anthropic") { if (Array.isArray(data.content)) return data.content.map((c) => c.text || "").join(""); return undefined; }
    const msg = data.choices && data.choices[0] && data.choices[0].message; return msg && msg.content;
  },
  _streamDelta(fmt, j) {
    if (fmt === "responses") return (j.type && /output_text\.delta$/.test(j.type)) ? (j.delta || "") : "";
    if (fmt === "anthropic") return (j.type === "content_block_delta" && j.delta) ? (j.delta.text || "") : "";
    return (j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content) || "";
  },
  _fail(resp, raw) { return new Error("HTTP " + resp.status + " " + resp.statusText + "\n" + (raw || "").slice(0, 1200)); },
  _parseOrThrow(raw) { try { return JSON.parse(raw); } catch (e) { throw new Error("响应不是 JSON（Base URL 或 API 格式可能不对）。实际返回：\n" + (raw || "").slice(0, 1200)); } },

  async callLLM(messages) {
    const fmt = this._fmt();
    const resp = await fetch(this._endpointFor(fmt), { method: "POST", headers: this._headersFor(fmt), body: this._bodyFor(fmt, messages, false) });
    const raw = await resp.text();
    if (!resp.ok) throw this._fail(resp, raw);
    const data = this._parseOrThrow(raw);
    if (data.error) throw new Error(typeof data.error === "string" ? data.error : (data.error.message || JSON.stringify(data.error)));
    const content = this._extractContent(fmt, data);
    if (typeof content !== "string") throw new Error("无法从响应中取出内容（" + fmt + "）。实际返回：\n" + raw.slice(0, 1200));
    return content;
  },

  async callLLMStream(messages, onDelta, shouldStop, meta) {
    meta = meta || {};
    const fmt = this._fmt();
    const resp = await fetch(this._endpointFor(fmt), { method: "POST", headers: this._headersFor(fmt), body: this._bodyFor(fmt, messages, true) });
    if (!resp.ok) { const raw = await resp.text().catch(() => ""); throw this._fail(resp, raw); }
    if (!resp.body || typeof resp.body.getReader !== "function") {
      const raw = await resp.text();
      const data = this._parseOrThrow(raw);
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      this._captureUsage(meta, data);
      const c = this._extractContent(fmt, data) || ""; if (c) onDelta(c); return c;
    }
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    let buf = "", full = "";
    while (true) {
      if (shouldStop && shouldStop()) { try { await reader.cancel(); } catch (e) {} break; }
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim();
        if (payload === "[DONE]") continue;
        let j; try { j = JSON.parse(payload); } catch (e) { continue; }
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        this._captureUsage(meta, j);
        const d = this._streamDelta(fmt, j);
        if (d) { full += d; onDelta(d); }
      }
    }
    return full;
  },

  // ------------------------------------------------- reader selection popup
  onSelectionPopup(event) {
    try {
      const { doc, params, append, reader } = event;
      const text = params && params.annotation && params.annotation.text;
      if (!text || !text.trim()) return;
      if (!this.getPref("apiKey")) return;

      const win = doc.defaultView;
      const mq = (q) => { try { return !!(win && win.matchMedia(q).matches); } catch (e) { return false; } };
      const dark = mq("(prefers-color-scheme: dark)");
      const reduceT = mq("(prefers-reduced-transparency: reduce)");
      // Apple HIG "Liquid Glass" popover (webview approximation): translucent
      // blurred fill, hairline border, soft shadow; monochrome labels with a
      // single accent primary action; system-blue selection highlight.
      const fg = dark ? "#f5f5f7" : "#1d1d1f";
      const accent = dark ? "#0a84ff" : "#007aff";
      const border = dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.08)";
      const glass = (dark ? "rgba(44,46,51," : "rgba(250,250,252,") + (reduceT ? "1)" : "0.72)");
      const filter = reduceT ? "none" : "blur(24px) saturate(1.4)";

      const wrap = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      wrap.style.cssText =
        "min-width:180px;max-width:340px;margin-top:6px;padding:5px;border-radius:13px;background:" + glass +
        ";-webkit-backdrop-filter:" + filter + ";backdrop-filter:" + filter +
        ";border:0.5px solid " + border + ";box-shadow:0 10px 34px rgba(0,0,0,0.22),0 1px 2px rgba(0,0,0,0.12)" +
        ";font-family:" + this._UIFONT + ";color:" + fg + ";";
      const mkSep = () => { const s = doc.createElementNS("http://www.w3.org/1999/xhtml", "div"); s.style.cssText = "height:0;border-top:0.5px solid " + border + ";margin:4px 8px;"; return s; };

      // result text — selectable so the user can copy with the mouse too
      const result = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      result.style.cssText = "display:none;margin:5px 7px 3px;padding-top:7px;border-top:0.5px solid " + border +
        ";max-width:320px;max-height:220px;overflow:auto;font-size:12px;line-height:1.5;white-space:pre-wrap;color:" + fg +
        ";user-select:text;-webkit-user-select:text;cursor:text;";

      // action row under a result (copy / write-to-annotation); hidden until a
      // result exists
      const actions = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      actions.style.cssText = "display:none;gap:8px;margin:2px 7px 4px;";
      const mkMini = (label) => {
        const b = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
        b.textContent = label;
        b.style.cssText = "display:inline-flex;align-items:center;cursor:pointer;padding:4px 10px;border-radius:7px;font-size:11.5px;font-weight:600;color:" + accent + ";background:transparent;border:0.5px solid " + border + ";margin-inline-end:8px;transition:background .08s,color .08s;";
        b.addEventListener("mouseenter", () => { b.style.background = accent; b.style.color = "#fff"; });
        b.addEventListener("mouseleave", () => { b.style.background = "transparent"; b.style.color = accent; });
        return b;
      };
      const lang = this.getPref("language") || "中文";
      let lastResult = "";
      const copyBtn = mkMini("复制");
      copyBtn.addEventListener("click", () => {
        if (!lastResult) return;
        const ok = AIReader._copyText(doc, lastResult);
        copyBtn.textContent = ok ? "已复制 ✓" : "复制失败";
        setTimeout(() => { copyBtn.textContent = "复制"; }, 1400);
      });
      const annoBtn = mkMini("写入 PDF 批注");
      annoBtn.addEventListener("click", async () => {
        if (!lastResult || annoBtn._busy) return; annoBtn._busy = true;
        const orig = annoBtn.textContent; annoBtn.textContent = "写入中…";
        try {
          const r = await AIReader.annotateSelection(reader, params.annotation, "AI 解释：" + lastResult);
          annoBtn.textContent = r.updated ? "已写入高亮批注 ✓" : "已加高亮+批注 ✓";
        } catch (e) { annoBtn.textContent = "写入失败"; AIReader.log("annotateSelection: " + e); }
        finally { annoBtn._busy = false; setTimeout(() => { annoBtn.textContent = orig; }, 1800); }
      });
      actions.appendChild(copyBtn); actions.appendChild(annoBtn);

      // resting (non-hover) style for an item, by role
      const restBg = "transparent";
      const mkItem = (label, primary, run) => {
        const b = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
        const labelSpan = doc.createElementNS("http://www.w3.org/1999/xhtml", "span");
        labelSpan.textContent = label; b.appendChild(labelSpan);
        const restFg = primary ? accent : fg;
        b.style.cssText = "display:flex;align-items:center;cursor:pointer;padding:7px 12px;border-radius:8px;font-size:13px;line-height:1.25;white-space:nowrap;min-height:24px;transition:background .08s;background:" + restBg + ";color:" + restFg + ";font-weight:" + (primary ? "600" : "450") + ";";
        // Hover is driven ONLY by enter/leave and always resets on leave — no
        // "busy" guard, so the highlight can never get stuck after an async run.
        b.addEventListener("mouseenter", () => { b.style.background = accent; b.style.color = "#fff"; });
        b.addEventListener("mouseleave", () => { b.style.background = restBg; b.style.color = restFg; });
        b.addEventListener("click", () => run(b, labelSpan));
        return b;
      };
      // Stream a producer into the result area with live feedback. Busy state is
      // shown ONLY via the label text + result area (never the background), so it
      // can't collide with hover styling.
      const runStream = (btn, labelSpan, baseLabel, waitText, showActions, streamRun) => async () => {
        if (btn._busy) return; btn._busy = true;
        labelSpan.textContent = baseLabel + " · " + waitText + " ⏳";
        result.style.display = "block"; result.style.color = fg; result.textContent = "⏳ " + waitText + "…";
        actions.style.display = "none"; lastResult = "";
        let acc = "";
        try {
          await streamRun((d) => { acc += d; result.textContent = acc; try { result.scrollTop = result.scrollHeight; } catch (e) {} });
          lastResult = acc.trim();
          result.textContent = lastResult || "(空响应)";
          if (showActions && lastResult) actions.style.display = "flex";
        } catch (e) { result.style.color = accent; result.textContent = "出错：" + (e.message || e); }
        finally { btn._busy = false; labelSpan.textContent = baseLabel; }
      };

      wrap.appendChild(mkItem("问 AI（引用到侧栏）", true, (b) => {
        this.quoteSelection(reader, text);
        result.style.display = "block"; result.style.color = accent;
        result.textContent = "已引用到右侧输入框 →"; actions.style.display = "none"; lastResult = "";
      }));
      wrap.appendChild(mkSep());
      // AI 解释：流式输出，看得到论文相关段落 + 之前的对话历史；完成后出「复制 / 写入批注」
      wrap.appendChild(mkItem("AI 解释", false, (b, ls) =>
        runStream(b, ls, "AI 解释", "解释中", true, (onDelta) => this.explainSelectionStream(reader, text, onDelta))()));
      wrap.appendChild(mkItem("翻译", false, (b, ls) =>
        runStream(b, ls, "翻译", "翻译中", false, (onDelta) => this.callLLMStream([{ role: "system", content: "You are a professional translator. Translate into " + lang + ". Output only the translation." }, { role: "user", content: text }], onDelta, () => false))()));
      wrap.appendChild(result);
      wrap.appendChild(actions);
      append(wrap);
    } catch (e) { this.log("popup error: " + e); }
  },

  // Put the selection into the sidebar input as a quote and let the user type
  // their own question ("问 AI" / "在右侧问 AI"). Falls back to sending a
  // grounded explain if no live panel is available.
  quoteSelection(reader, text) {
    try {
      const att = Zotero.Items.get(reader.itemID); const key = att && att.key;
      const state = key && this._panels.get(key);
      if (state && state.input && state.attachment && state.attachment.key === key) {
        const q = "关于这段原文：\n“" + text + "”\n\n我的问题是：";
        state.input.value = q;
        try {
          state.input.style.height = "auto";
          state.input.style.height = Math.min(140, state.input.scrollHeight) + "px";
          state.input.focus();
          state.input.setSelectionRange(q.length, q.length);
        } catch (e) {}
        return;
      }
    } catch (e) { this.log("quoteSelection error: " + e); }
    // No live panel → send a grounded explain so the user still gets an answer.
    this.askFromSelection(reader, "请结合上下文解释这段原文，并指出它在论文中的作用：\n“" + text + "”", text);
  },

  // Route a reader selection into the sidebar chat (live panel if present,
  // else run headless and store so it appears when the panel opens).
  // `message` is sent verbatim; `anchor` (raw selection) drives retrieval.
  async askFromSelection(reader, message, anchor) {
    const q = message;
    const sel = anchor || message;
    let key = null;
    try { const att = Zotero.Items.get(reader.itemID); key = att && att.key; } catch (e) {}
    const state = key && this._panels.get(key);
    if (state && state.attachment && state.attachment.key === key) { this._send(state, q, { broad: false }); return; }
    // headless fallback
    try {
      const att = Zotero.Items.get(reader.itemID);
      let blocks = this._blockStore.get(key);
      if (!blocks) { blocks = await this.extractBlocks(att.id); if (blocks) this._blockStore.set(key, blocks); }
      let hist = this._chatStore.get(key); if (!hist) { hist = (await this.loadChat(att)) || []; this._chatStore.set(key, hist); }
      hist.push({ role: "user", content: q });
      const ctx = blocks ? this.buildRetrievedContext(blocks, sel) : "";
      const messages = [{ role: "system", content: this.systemPrompt(ctx) }, ...hist.slice(-12)];
      const ans = await this.callLLM(messages);
      hist.push({ role: "assistant", content: ans });
      this.saveChat(att, hist).catch(() => {});
    } catch (e) { this.log("askFromSelection headless error: " + e); }
  },

  // Build the grounded message list for explaining a selection: inject the
  // paper's most-relevant blocks (retrieval on the selection) AND the recent
  // conversation so the explanation builds on what we've already discussed —
  // not an isolated one-shot.
  async _explainMessages(reader, text) {
    const lang = this.getPref("language") || "中文";
    let att = null, key = null;
    try { att = Zotero.Items.get(reader.itemID); key = att && att.key; } catch (e) {}
    let ctx = "";
    try {
      let blocks = key && this._blockStore.get(key);
      if (!blocks && att) { blocks = await this.extractBlocks(att.id); if (blocks && key) this._blockStore.set(key, blocks); }
      if (blocks) ctx = this.buildRetrievedContext(blocks, text);
    } catch (e) { this.log("explain ctx error: " + e); }
    const hist = (key && this._chatStore.get(key)) || [];
    const sys = "You explain excerpts from academic papers clearly and concisely in " + lang +
      ". 2-4 sentences. Use the paper context and the prior conversation when they help; stay consistent with earlier answers." +
      (ctx ? ("\n\n## 论文相关段落\n" + ctx) : "");
    const messages = [{ role: "system", content: sys }];
    for (const m of hist.slice(-8)) if (m && m.role && m.content) messages.push({ role: m.role, content: m.content });
    messages.push({ role: "user", content: "请解释下面这段原文（结合论文上下文与我们之前的讨论）：\n“" + text + "”" });
    return messages;
  },

  // Non-streaming explain (used by tests / headless paths).
  async explainSelectionText(reader, text) {
    return await this.callLLM(await this._explainMessages(reader, text));
  },

  // Streaming explain: emits deltas via onDelta for the popup's live output.
  async explainSelectionStream(reader, text, onDelta) {
    return await this.callLLMStream(await this._explainMessages(reader, text), onDelta || (() => {}), () => false);
  },

  // Copy text to the clipboard from inside the reader webview. Tries Zotero's
  // helper, then the clipboard service, then a DOM fallback. Returns success.
  _copyText(doc, text) {
    try { if (Zotero.Utilities && Zotero.Utilities.Internal && Zotero.Utilities.Internal.copyTextToClipboard) { Zotero.Utilities.Internal.copyTextToClipboard(text); return true; } } catch (e) {}
    try {
      const win = doc && doc.defaultView;
      if (win && win.navigator && win.navigator.clipboard) { win.navigator.clipboard.writeText(text); return true; }
    } catch (e) {}
    try {
      const ta = doc.createElementNS("http://www.w3.org/1999/xhtml", "textarea");
      ta.value = text; (doc.body || doc.documentElement).appendChild(ta); ta.select();
      const ok = doc.execCommand && doc.execCommand("copy"); ta.remove(); return !!ok;
    } catch (e) {}
    return false;
  },

  // ----------------------------------------------------------------- cache
  cachePath(attachment) { const dir = PathUtils.join(Zotero.DataDirectory.dir, "aireader"); return { dir, path: PathUtils.join(dir, attachment.libraryID + "-" + attachment.key + ".json") }; },
  chatPath(attachment) { const dir = PathUtils.join(Zotero.DataDirectory.dir, "aireader"); return { dir, path: PathUtils.join(dir, attachment.libraryID + "-" + attachment.key + "-chat.json") }; },

  async loadCache(attachment) {
    try {
      const { path } = this.cachePath(attachment);
      if (!(await IOUtils.exists(path))) return null;
      const obj = JSON.parse(await IOUtils.readUTF8(path));
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
      await IOUtils.writeUTF8(path, JSON.stringify({ version: 3, hash: hash || null, date: new Date().toISOString(), blocks }));
    } catch (e) { this.log("saveCache error: " + e); }
  },

  async loadChat(attachment) {
    try {
      const { path } = this.chatPath(attachment);
      if (!(await IOUtils.exists(path))) return null;
      const obj = JSON.parse(await IOUtils.readUTF8(path));
      return Array.isArray(obj.messages) ? obj.messages : null;
    } catch (e) { return null; }
  },

  async saveChat(attachment, hist) {
    try {
      const { dir, path } = this.chatPath(attachment);
      await IOUtils.makeDirectory(dir, { ignoreExisting: true });
      await IOUtils.writeUTF8(path, JSON.stringify({ version: 1, date: new Date().toISOString(), messages: hist }));
    } catch (e) { this.log("saveChat error: " + e); }
  },
};
