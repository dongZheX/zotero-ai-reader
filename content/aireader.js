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
  _histSummary: new Map(), // attachment.key -> rolling summary of compacted older turns
  _readStore: new Map(),   // attachment.key -> Map(sectionIndex -> {title,text})  — read sections
  _figStore: new Map(),    // attachment.key -> Map(figId -> {page,kind,desc})      — viewed figures
  _popupCache: null,       // {text, raw, showActions} — survives reader popup re-render on scroll
  _deepRead: false,        // deep-read mode: traverse the whole paper + use vision aggressively

  HILITE_COLOR: "#ffd400",
  // Agentic reading categories → Zotero's native annotation palette.
  CATEGORY_COLORS: {
    contribution: "#ffd400", // yellow
    method: "#5fb236",       // green
    result: "#2ea8e5",       // blue
    limitation: "#ff6666",   // red
    keyterm: "#a28ae5",      // purple
  },
  CATEGORY_LABELS: {
    contribution: "贡献", method: "方法", result: "结果", limitation: "局限", keyterm: "关键概念",
  },
  colorForCategory(cat) { return this.CATEGORY_COLORS[cat] || this.HILITE_COLOR; },

  init({ id, version, rootURI }) {
    this.id = id; this.version = version; this.rootURI = rootURI;
  },

  getPref(key) { return Zotero.Prefs.get("aireader." + key); },
  log(msg) { Zotero.debug("[AIReader] " + msg); },

  // Reading skills: each is a method injected into the system prompt + its own
  // quick chips. Switching a skill swaps the chips and the injected guidance.
  // Sources: deer-flow academic-paper-review / systematic-literature-review,
  // Keshav《How to Read a Paper》three-pass. COMMON_PRESETS stay across skills.
  SKILLS: [
    { id: "deep-read", label: "精读理解", desc: "结构化精读（默认）",
      inject: "按结构化精读：先抓研究问题与动机，再方法、主要发现（给出关键数字并 [B] 溯源）、结论与意义、局限；论断都要能回指原文。",
      presets: [
        { label: "总结全文", q: "请分【研究问题 / 方法 / 主要发现 / 结论与意义 / 局限】五部分，结构化总结这篇论文。最后额外用一个 ```svg 图直观呈现整体脉络（问题→方法→发现→结论）。", broad: true },
        { label: "三行摘要", q: "用三行中文给出这篇论文的极简摘要：问题、方法、结论各一行。", broad: true },
        { label: "关键词", q: "列出本文 6-10 个关键术语，每个一句话解释，并用 [B<id>] 标注来源。", broad: true },
        { label: "核心贡献", q: "这篇论文的核心贡献是什么？最后额外用一个 ```svg 图把各项贡献及其关系直观呈现出来。", broad: false },
        { label: "方法", q: "它用了什么方法？简要说明。", broad: false },
        { label: "主要结论", q: "主要结论或实验结果是什么？最后额外用一个 ```svg 图直观呈现关键结论之间的关系。", broad: false },
        { label: "局限", q: "有哪些局限或未来工作？", broad: false },
      ] },
    { id: "peer-review", label: "同行评审", desc: "顶会审稿人视角",
      inject: "以顶会（NeurIPS/ICML/ACL）审稿人的标准写评审，客观、具体、可操作，每条意见指向具体章节/图表并用 [B] 溯源：贡献小结；优点 S1/S2…；缺点 W1/W2…；方法评分（各 1–5）Soundness、Novelty、Reproducibility、Experimental design、Statistical rigor、Scalability；给作者的问题；总体 Accept / Weak Accept / Borderline / Weak Reject / Reject + 置信度(高/中/低)。只依据论文证据，不臆测。",
      agentInject: "以审稿视角标注：优先标出贡献句、方法关键决策、支撑或存疑的实验结果、以及局限与过度声明。",
      presets: [
        { label: "评审总览", q: "按同行评审格式给出完整评审：贡献小结、优点(S)、缺点(W)、方法评分表、给作者的问题、总体结论与置信度。", broad: true },
        { label: "主要贡献", q: "这篇论文声称的主要贡献有哪些？逐条列出并用 [B] 溯源，评估其新颖性。", broad: true },
        { label: "优点 (S)", q: "列出这篇论文的主要优点 S1/S2/S3…，每条指明在何处、为何重要。", broad: true },
        { label: "缺点 (W)", q: "列出主要缺点/隐患 W1/W2/W3…，每条指明在何处、为何是问题、如何改进。", broad: true },
        { label: "方法评分", q: "对方法按 Soundness / Novelty / Reproducibility / Experimental design / Statistical rigor / Scalability 各打 1–5 分并简述理由。", broad: true },
        { label: "给作者的问题", q: "列出 3-6 个最该向作者澄清的问题。", broad: false },
        { label: "是否接收", q: "给出总体建议（Accept / Weak Accept / Borderline / Weak Reject / Reject）与置信度，并说明关键依据。", broad: true },
      ] },
    { id: "three-pass", label: "三遍速读", desc: "Keshav 三遍法",
      inject: "用 Keshav《How to Read a Paper》三遍法：第一遍只鸟瞰（题目/摘要/引言/各节标题/结论），判断 5C（类型、背景、正确性/假设是否成立、贡献、清晰度）；第二遍抓要点、仔细看图表（坐标轴是否标注、有无误差棒、结论是否统计显著）；第三遍挑战每个假设，相当于在脑中复刻。按用户要求的那一遍作答。",
      presets: [
        { label: "第一遍鸟瞰", q: "用 Keshav 第一遍法鸟瞰本文：给出 5C（类型/背景/正确性/贡献/清晰度）的快速判断。", broad: true },
        { label: "第二遍要点", q: "用 Keshav 第二遍法：抓住主旨与证据，并逐一点评关键图表（坐标轴/误差棒/是否统计显著），用 [B] 溯源。", broad: true, withFigures: true },
        { label: "第三遍质疑", q: "用 Keshav 第三遍法：挑战文中每个关键假设，指出哪些未被证据支撑、若要复刻还缺什么。", broad: true },
        { label: "图表体检", q: "逐一检查本文主要图表：坐标轴是否清楚、是否有误差棒/置信区间、呈现是否误导。", broad: true, withFigures: true },
      ] },
    { id: "survey", label: "领域综述", desc: "放到领域里看（联网更佳）",
      inject: "把这篇论文放到研究领域里看：主动用 web_search 找近年相关工作与 SOTA、用 web_fetch 读关键页面，沿参考文献找反复出现的关键论文与作者。说明本文相对已有工作的定位、改进与尚存空白；外部信息要给出处/链接。",
      presets: [
        { label: "相关工作", q: "这篇论文属于哪条研究脉络？联网检索并列出最相关的几篇工作及其关系。", broad: true },
        { label: "与 SOTA 对比", q: "与当前 SOTA 相比，本文处在什么位置？联网核对后给出对比。", broad: true },
        { label: "本文定位", q: "用一段话说清本文相对已有工作的独特定位与增量贡献。", broad: true },
        { label: "后续方向", q: "基于本文与领域现状，有哪些值得做的后续方向？", broad: false },
      ] },
    { id: "reproduce", label: "可复现复刻", desc: "能不能复现",
      inject: "从复现角度读：逐项核对复现所需信息——数据集与预处理、模型结构与超参、训练设置与算力、评测协议与指标、代码/权重可得性。明确指出哪些齐全、哪些缺失，给出若要复刻的大致步骤与风险点；信息都要 [B] 溯源。",
      presets: [
        { label: "复现清单", q: "列一张复现清单：数据、预处理、模型与超参、训练设置与算力、评测与指标、代码可得性，逐项说明论文是否给出并 [B] 溯源。", broad: true },
        { label: "缺失信息", q: "要复现本文，还缺哪些关键信息或资源？", broad: true },
        { label: "动手步骤", q: "给出复刻本文核心结果的大致步骤与所需条件。", broad: true },
        { label: "风险点", q: "复现中最可能踩坑或结果对不上的地方有哪些？", broad: false },
      ] },
    { id: "redteam", label: "批判红队", desc: "专挑漏洞",
      inject: "当红队：专挑方法与实验的漏洞——未控制的混淆变量、不公平对比、cherry-picking、过度声明、结论强于证据之处、可能的反例或失败情形。区分“有依据的质疑”和“吹毛求疵”，每条用 [B] 指向原文。",
      presets: [
        { label: "找漏洞", q: "从方法与实验里找出最站不住脚的地方，逐条说明问题所在并 [B] 溯源。", broad: true },
        { label: "挑战假设", q: "文中有哪些被默认成立、其实需要验证的关键假设？", broad: true },
        { label: "可能反例", q: "在什么情形/数据下本文方法可能失效或结论不成立？", broad: true },
        { label: "过度声明", q: "哪些结论强于其证据支撑？指出被夸大的声明。", broad: true },
      ] },
    { id: "tutor", label: "导师讲解", desc: "讲给新手",
      inject: "像导师给初学者讲：先讲清背景与为什么要做这件事，再用直觉/类比解释核心想法，少堆术语；出现的关键术语要解释；多举具体例子；耐心、循序渐进。",
      presets: [
        { label: "讲背景", q: "用通俗的话讲清这篇论文的背景、它想解决的问题、为什么重要。", broad: true },
        { label: "讲直觉", q: "用直觉或类比解释本文的核心想法，尽量不用公式术语。", broad: true },
        { label: "术语表", q: "列出理解本文需要先懂的关键术语，每个用一句话通俗解释。", broad: true },
        { label: "举例说明", q: "用一个具体例子走一遍本文方法是怎么工作的。", broad: false },
      ] },
    { id: "quick", label: "速览", desc: "极简要点",
      inject: "只给最关键的要点，极简、不展开、不客套。",
      presets: [
        { label: "三句话", q: "用三句话说清这篇论文：问题、做法、结论。", broad: true },
        { label: "一张图", q: "用一个 ```svg 图概括这篇论文的整体脉络。", broad: true },
        { label: "关键数字", q: "列出本文最重要的几个数字/结果，并 [B] 溯源。", broad: true },
        { label: "一句话结论", q: "用一句话给出本文最核心的结论。", broad: false },
      ] },
  ],
  // Always-on chips (figure/annotation abilities) appended after any skill's chips.
  COMMON_PRESETS: [
    { label: "总结(含图表)", q: "结合正文与图表，分【研究问题 / 方法 / 主要发现(含关键图表) / 结论与意义 / 局限】结构化总结这篇论文。最后额外用一个 ```svg 图直观呈现整体脉络与关键发现。", broad: true, withFigures: true },
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
      this.closeSkillMenu(old);
      if (old._ro) { try { old._ro.disconnect(); } catch (e) {} old._ro = null; }
      if (old._onWinResize) { try { old.doc.defaultView.removeEventListener("resize", old._onWinResize); } catch (e) {} old._onWinResize = null; }
    }
    this.injectCSS(doc);
    body.textContent = "";
    body.classList.add("aireader-root");

    const top = this._el(doc, "div", "aireader-top");
    const agentBtn = this._el(doc, "div", "aireader-top-btn aireader-top-agent", "✨ 通读并标注");
    agentBtn.title = "让 AI 通读全文，自动按类别高亮+批注（可一键撤销）";
    agentBtn.addEventListener("click", () => { const st = this._bodyState.get(body); if (st) this.agentAnnotate(st); });
    // deep-read toggle: when on, the model traverses the whole paper and reads
    // figures aggressively (more tool calls, slower, more thorough).
    const deepBtn = this._el(doc, "div", "aireader-top-btn aireader-deep", "深读 " + (this._deepRead ? "开" : "关"));
    deepBtn.title = "深读模式：让模型遍历所有章节、主动读图，覆盖更全（更慢更贵）";
    if (this._deepRead) deepBtn.classList.add("aireader-deep-on");
    deepBtn.addEventListener("click", () => {
      this._deepRead = !this._deepRead;
      deepBtn.textContent = "深读 " + (this._deepRead ? "开" : "关");
      deepBtn.classList.toggle("aireader-deep-on", this._deepRead);
    });
    // reading-skill selector: switches the injected method + the quick chips.
    const skillBtn = this._el(doc, "div", "aireader-top-btn aireader-skillbtn", "技能 ▾");
    skillBtn.title = "选择阅读技能：切换方法与下方快捷按钮";
    skillBtn.addEventListener("click", (ev) => { ev.stopPropagation(); this.toggleSkillMenu(body); });
    const noteBtn = this._el(doc, "div", "aireader-top-btn", "存为笔记");
    noteBtn.title = "把当前对话存为 Zotero 笔记";
    noteBtn.addEventListener("click", () => this.saveNote(body));
    const gear = this._el(doc, "div", "aireader-gear", "⚙");
    gear.title = "Settings";
    gear.addEventListener("click", () => Zotero.Utilities.Internal.openPreferences(AIReader._prefPaneID));
    top.appendChild(agentBtn);
    top.appendChild(skillBtn);
    top.appendChild(deepBtn);
    top.appendChild(noteBtn);
    top.appendChild(this._el(doc, "div", "aireader-foot-spacer"));
    top.appendChild(gear);
    // (the button row is appended just above the composer below, not at the top,
    //  so the input area is the visual focus)

    const status = this._el(doc, "div", "aireader-status");
    body.appendChild(status);

    const chatMsgs = this._el(doc, "div", "aireader-chat-msgs");
    body.appendChild(chatMsgs);

    const chips = this._el(doc, "div", "aireader-chips"); // filled by renderChips(state) below
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

    body.appendChild(top); // button row sits right above the input area
    body.appendChild(composer);

    const preview = this._el(doc, "div", "aireader-preview");
    preview.style.display = "none";
    body.appendChild(preview);

    const state = {
      item, attachment: null, blocks: null, doc, body,
      status, chatMsgs, input, send, modelPill, skillBtn, chips, composer, footer, preview,
      modelMenu: null, modelList: null, skillMenu: null, _onDoc: null, _onSkillDoc: null, streaming: false, cancel: false,
    };
    this._bodyState.set(body, state);
    this.updateModelPill(state);
    this.updateSkillPill(state);
    this.renderChips(state);

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

  // ---- reading skills: selected method injected into the prompt + its chips ----
  _skillId() {
    const id = (this.getPref("skill") || "").trim();
    return this.SKILLS.some((s) => s.id === id) ? id : this.SKILLS[0].id;
  },
  currentSkill() {
    const id = this._skillId();
    return this.SKILLS.find((s) => s.id === id) || this.SKILLS[0];
  },
  _skillDirective() {
    const s = this.currentSkill();
    return (s && s.inject) ? ("\n\n【阅读技能：" + s.label + "】\n" + s.inject) : "";
  },
  updateSkillPill(state) {
    if (state && state.skillBtn) state.skillBtn.textContent = "技能 · " + this.currentSkill().label + " ▾";
  },
  // (Re)render the quick chips: the current skill's presets + the always-on ones.
  renderChips(state) {
    if (!state || !state.chips) return;
    const doc = state.doc, body = state.body;
    state.chips.textContent = "";
    for (const p of this.currentSkill().presets.concat(this.COMMON_PRESETS)) {
      const c = this._el(doc, "button", "aireader-chip", p.label);
      c.addEventListener("click", () => this.onChatSend(body, p.q, { broad: p.broad, autoApply: p.autoApply, annos: p.annos, withFigures: p.withFigures }));
      state.chips.appendChild(c);
    }
  },
  toggleSkillMenu(body) {
    const state = this._bodyState.get(body);
    if (!state) return;
    if (state.skillMenu) { this.closeSkillMenu(state); return; }
    this.closeModelMenu(state);
    const doc = state.doc;
    const C = this._menuColors(doc);
    const menu = this._el(doc, "div", "aireader-skillmenu");
    menu.style.cssText += ";background:" + C.bg + ";color:" + C.fg + ";border:1px solid " + C.border + ";font-family:" + this._UIFONT + ";";
    const cur = this._skillId();
    for (const s of this.SKILLS) {
      const on = s.id === cur;
      const it = this._el(doc, "div", "aireader-skillitem" + (on ? " aireader-skillitem-on" : ""));
      const t = this._el(doc, "div", "aireader-skillitem-t", s.label);
      const d = this._el(doc, "div", "aireader-skillitem-d", s.desc || "");
      it.appendChild(t); it.appendChild(d);
      it.style.cssText += ";padding:6px 10px;cursor:pointer;color:" + (on ? C.accent : C.fg) + ";font-family:" + this._UIFONT + ";" + (on ? "font-weight:600;" : "");
      d.style.cssText += ";color:" + C.muted + ";font-size:11px;font-weight:400;";
      it.addEventListener("mouseenter", () => { it.style.background = C.hover; });
      it.addEventListener("mouseleave", () => { it.style.background = "transparent"; });
      it.addEventListener("click", (ev) => { ev.stopPropagation(); Zotero.Prefs.set("aireader.skill", s.id); this.updateSkillPill(state); this.renderChips(state); this.closeSkillMenu(state); });
      menu.appendChild(it);
    }
    state.skillMenu = menu;
    body.appendChild(menu);
    this._positionMenu(state, menu, state.skillBtn);
    const onDoc = (ev) => { if (state.skillMenu && !state.skillMenu.contains(ev.target) && ev.target !== state.skillBtn) this.closeSkillMenu(state); };
    state._onSkillDoc = onDoc;
    setTimeout(() => doc.addEventListener("click", onDoc), 0);
  },
  closeSkillMenu(state) {
    if (state._onSkillDoc) { try { state.doc.removeEventListener("click", state._onSkillDoc); } catch (e) {} state._onSkillDoc = null; }
    if (state.skillMenu) { state.skillMenu.remove(); state.skillMenu = null; }
  },

  updateModelPill(state) {
    if (!state.modelPill) return;
    state.modelPill.textContent = (this.getPref("model") || "选择模型") + "  ·  " + this._fmt() + "  ▾";
  },

  // Anchor a dropdown to its button, flipping up or down based on available space
  // (the button row / model bar now sit near the bottom, above the input).
  _positionMenu(state, menu, btn) {
    try {
      const rr = state.body.getBoundingClientRect(), br = btn.getBoundingClientRect();
      menu.style.left = "4px"; menu.style.right = "4px";
      const below = rr.bottom - br.bottom, above = br.top - rr.top;
      if (below >= above) { menu.style.top = (br.bottom - rr.top + 4) + "px"; menu.style.bottom = "auto"; }
      else { menu.style.bottom = (rr.bottom - br.top + 4) + "px"; menu.style.top = "auto"; }
    } catch (e) {}
  },
  toggleModelMenu(body) {
    const state = this._bodyState.get(body);
    if (!state) return;
    if (state.modelMenu) { this.closeModelMenu(state); return; }
    this.closeSkillMenu(state);
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
    this._positionMenu(state, menu, state.modelPill);
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
  // Elapsed-seconds ticker for silent waits (prefill before the first token, the
  // blocking vision call, tool execution). Turns a static "正在思考…" into
  // "正在思考… · 8s" so a long wait reads as alive, not frozen.
  _startWait(state, label) {
    this._stopWait(state);
    const t0 = Date.now();
    const tick = () => {
      const s = Math.round((Date.now() - t0) / 1000);
      this.setStatus(state, s >= 1 ? (label + " · " + s + "s") : label, "busy");
      try { state._waitTimer = setTimeout(tick, 1000); if (state._waitTimer && state._waitTimer.unref) state._waitTimer.unref(); } catch (e) {}
    };
    tick();
  },
  _stopWait(state) {
    if (state && state._waitTimer) { try { clearTimeout(state._waitTimer); } catch (e) {} state._waitTimer = null; }
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
    } catch (e) { this.log("hydrate error: " + e); this.setStatus(state, this._friendlyError(e), "error"); }
  },

  requireKey(state) {
    if (!this.getPref("apiKey")) { this.setStatus(state, "先在设置里填 API Key。", "error"); Zotero.Utilities.Internal.openPreferences(this._prefPaneID); return false; }
    return true;
  },

  onClear(body) {
    const state = this._bodyState.get(body);
    if (!state || !state.attachment) return;
    const key = state.attachment.key;
    this._chatStore.set(key, []);
    this.saveChat(state.attachment, []).catch(() => {});
    this._histSummary.delete(key); this._readStore.delete(key); this._figStore.delete(key); // reset continuous context too
    state.live = null;
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
    const ref = { id: 0 };
    for (const node of struct.content) {
      if (node.flowClass === "excluded") continue;
      this._emitBlocks(node, pages, blocks, ref);
    }
    return blocks;
  },

  // Page label + height helper.
  _pageMeta(pages, pi) {
    const pageLabel = (pages[pi] && pages[pi].label) || String(pi + 1);
    const vr = pages[pi] && pages[pi].viewRect;
    const pageHeight = vr ? (vr[3] - vr[1]) : 792;
    return { pageLabel, pageHeight };
  },

  // Walk a content node's leaf spans and return ordered segments carrying both
  // the text AND the per-segment rect from the leaf's textMap
  // ([rot, pageIndex, x1, y1, x2, y2, …]). This is what lets us annotate/cite a
  // single SENTENCE instead of the whole paragraph.
  _leafSegments(node) {
    const segs = [];
    const walk = (n) => {
      if (typeof n.text === "string") {
        const tm = n.anchor && n.anchor.textMap;
        let parsed = null; if (tm) { try { parsed = JSON.parse(tm); } catch (e) {} }
        if (Array.isArray(parsed) && parsed.length) {
          const rects = []; let pi = null;
          for (const s of parsed) { if (Array.isArray(s) && s.length >= 6) { pi = s[1]; rects.push([s[2], s[3], s[4], s[5]]); } }
          segs.push({ text: n.text, rects, pi });
        } else {
          segs.push({ text: n.text, rects: [], pi: null });
        }
        return;
      }
      if (Array.isArray(n.content)) for (const c of n.content) walk(c);
    };
    walk(node);
    return segs;
  },

  // Split text into sentence-ish chunks with char offsets. Short trailing
  // fragments (abbreviations like "al.", decimals, "2025).") are merged back so
  // we don't cut a sentence at every dot.
  _splitSentences(text) {
    const out = [];
    const re = /[^.!?。！？]*[.!?。！？]+|[^.!?。！？]+$/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      if (m[0] === "") { re.lastIndex++; continue; }
      out.push({ text: m[0], start: m.index, end: m.index + m[0].length });
    }
    const merged = [];
    for (const s of out) {
      const t = s.text.trim();
      if (merged.length && (t.length < 20 || /^[a-z0-9)\]]/.test(t))) {
        const p = merged[merged.length - 1]; p.text += s.text; p.end = s.end;
      } else merged.push({ text: s.text, start: s.start, end: s.end });
    }
    return merged.length ? merged : [{ text, start: 0, end: text.length }];
  },

  // Emit block(s) for one content node. Paragraphs are split into sentence-level
  // blocks (each with its own rects); headings / figures / rectless nodes stay a
  // single block (old behaviour).
  _emitBlocks(node, pages, blocks, ref) {
    const norm = (t) => t.replace(/\s+/g, " ").trim();
    const push = (type, text, pi, rects) => {
      let position = null, pageLabel = "?", pageHeight = 792;
      if (pi != null && rects && rects.length) {
        const meta = this._pageMeta(pages, pi); pageLabel = meta.pageLabel; pageHeight = meta.pageHeight;
        position = { pageIndex: pi, rects };
      }
      let t = text; if (t.length > 2000) t = t.slice(0, 2000) + "…";
      blocks.push({ id: ref.id++, type, text: t, position, pageLabel, pageHeight });
    };

    // figures/images and headings: keep whole, position from node.anchor.pageRects
    const wholeRects = {};
    for (const pr of (node.anchor && node.anchor.pageRects) || []) { (wholeRects[pr[0]] = wholeRects[pr[0]] || []).push([pr[1], pr[2], pr[3], pr[4]]); }
    const wholePages = Object.keys(wholeRects).map(Number).sort((a, b) => a - b);
    const wholePi = wholePages.length ? wholePages[0] : null;

    if (node.type === "image" || node.type === "heading" || node.type === "math" || node.type === "table") {
      const text = norm(this.blockText(node));
      if (!text && node.type !== "image") return;
      push(node.type, text, wholePi, wholePi != null ? wholeRects[wholePi] : null);
      return;
    }

    // paragraph: split into sentences using per-segment rects
    const segs = this._leafSegments(node);
    const haveRects = segs.some((s) => s.rects.length);
    const full = segs.map((s) => s.text).join("");
    if (!norm(full)) return;
    if (!haveRects) { push(node.type || "paragraph", norm(full), wholePi, wholePi != null ? wholeRects[wholePi] : null); return; }

    // char-offset spans per segment
    const spans = []; let pos = 0;
    for (const s of segs) { spans.push({ start: pos, end: pos + s.text.length, seg: s }); pos += s.text.length; }
    for (const sent of this._splitSentences(full)) {
      const t = norm(sent.text);
      if (!t) continue;
      // segments overlapping this sentence's char range
      const hit = spans.filter((sp) => sp.end > sent.start && sp.start < sent.end && sp.seg.rects.length);
      if (!hit.length) { push(node.type || "paragraph", t, null, null); continue; }
      // dominant page = page of the first hit segment; keep only its rects
      let pi = null; for (const h of hit) { if (h.seg.pi != null) { pi = h.seg.pi; break; } }
      const rects = [];
      for (const h of hit) { if (h.seg.pi === pi) for (const r of h.seg.rects) rects.push(r); }
      push(node.type || "paragraph", t, pi, rects);
    }
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

  // Broad context that survives long papers: if the whole body fits the budget,
  // use it all; otherwise keep the beginning (abstract/intro) AND the end
  // (conclusion) and mark the omitted middle — instead of a hard cut that drops
  // the entire back half of the paper.
  buildContextBounded(blocks, maxChars) {
    maxChars = maxChars || Number(this.getPref("maxChars")) || 60000;
    const text = (blocks || []).filter((b) => b.type !== "image" && b.type !== "math" && b.text);
    const lineOf = (b) => "[B" + b.id + " p" + b.pageLabel + "] " + b.text;
    const all = text.map(lineOf);
    const sum = all.reduce((s, l) => s + l.length + 1, 0);
    if (sum <= maxChars) return all.join("\n") + this._figIndex(blocks);
    const headBudget = Math.floor(maxChars * 0.6), tailBudget = maxChars - headBudget;
    const head = []; let ht = 0;
    for (const b of text) { const l = lineOf(b); if (ht + l.length > headBudget) break; head.push(l); ht += l.length + 1; }
    const tail = []; let tt = 0;
    for (let i = text.length - 1; i >= 0; i--) { const l = lineOf(text[i]); if (tt + l.length > tailBudget) break; tail.unshift(l); tt += l.length + 1; }
    return head.join("\n") + "\n\n…（中间内容略，可在对话中追问细节）…\n\n" + tail.join("\n") + this._figIndex(blocks);
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
    // Headings are always kept for structure, so a low-signal query (a short or
    // CJK query against an English paper → all scores 0) can leave ONLY headings
    // chosen. That would feed the model a table of contents with no prose and
    // make it refuse ("只有章节目录和图表索引，没有正文"). If too few BODY blocks
    // actually matched, fall back to the full bounded context instead.
    let bodyHits = 0;
    for (const b of blocks) if (chosen.has(b.id) && b.type !== "heading" && b.type !== "image" && b.type !== "math" && b.text) bodyHits++;
    if (bodyHits < 5) return this.buildContextBounded(blocks, maxChars);
    const lines = []; let total = 0;
    for (const b of blocks) {
      if (!chosen.has(b.id) || b.type === "image" || b.type === "math") continue;
      const line = "[B" + b.id + " p" + b.pageLabel + "] " + b.text;
      if (total + line.length > maxChars) break;
      lines.push(line); total += line.length + 1;
    }
    if (lines.length < 3) return this.buildContextBounded(blocks, maxChars); // fall back if query too sparse
    return lines.join("\n") + this._figIndex(blocks);
  },

  systemPrompt(ctx) {
    const lang = this.getPref("language") || "中文";
    return "你是针对某一篇学术论文的阅读助手，用" + lang + "回答。论文正文按块给出，每块形如 [B<id> p<页码>] 文本。要求：\n" +
      "1) 回答必须基于论文；论文没涉及的就说没涉及。\n" +
      "2) 在每个关键论断后用 [B<id>] 标出依据的块（可多个），方便用户点回原文。\n" +
      "3) 当用户要求划线/标注，或你认为某处值得高亮时，可输出指令：划线用 [[hl:<id>]]，加批注用 [[note:<id>|批注内容]]。这些会渲染成按钮由用户一键应用到 PDF。\n" +
      "4) 当用户想看某个图/表的视觉内容、或你需要看图才能准确解释时，输出 [[fig:<id>]]（id 为图/表块），会渲染该区域图像并交给多模态模型识图。\n" +
      "5) 若正文前附有【用户在 PDF 中的高亮与批注】，当用户问到『我的高亮/批注』时请优先结合这些内容回答。\n" +
      "6) 需要用图示说明（流程、架构、时间线、关系等）时，请输出一个 ```svg 代码块，会被内联渲染成矢量图。要点：用 <rect>/<text>/<line>/<path>/<polygon> 等手绘；根 <svg> 必须带 viewBox 定义坐标系（不要写固定像素 width/height，会自适应容器宽度）；viewBox 宽度建议 ≤ 600，框与文字不要重叠、箭头对齐、字号分层、留白充足、元素对齐。审美上避免 AI 设计套路：配色克制（中性色带一点偏向强调色的色相、再加一个强调色，别用纯灰；别套用米色+衬线+赭石、紫蓝渐变、荧光绿点缀这类默认风格），不要用 emoji、不要什么都居中或一律圆角；编号(01/02/03)只在内容确实是有序步骤时才用。不要用 mermaid（本环境无法渲染，只会显示源码）。仅在确实有助于理解时才画。\n\n" +
      this._styleGuide() +
      this._customPrompt() +
      "论文内容：\n\n" + ctx;
  },

  // User-defined extra instructions from Settings. Appended (not a replacement)
  // so it can't break the citation / tool / drawing machinery above.
  _customPrompt() {
    const c = (this.getPref("customPrompt") || "").trim();
    return c ? ("【用户自定义要求】（在不破坏上述引用/工具/画图规则的前提下遵循）\n" + c + "\n\n") : "";
  },

  // Style constraints injected into every answer so output reads human-written,
  // not model-generic. Condensed from the "Signs of AI writing" rules (the
  // humanizer skill) plus Chinese sci-writing term/translation handling —
  // because a bootstrap plugin has no skills, only the system prompt.
  _styleGuide() {
    return "【表达风格】像懂行的人跟同行说话：直接、具体、克制，别带 AI 腔。\n" +
      "- 先说结论，别铺垫；不要“让我们深入探讨 / 首先需要明确 / 综上所述”这类套路开场和升华式收尾，也别用“这不仅是 X，更是 Y”的句式或金句式独句结尾。\n" +
      "- 不堆排比和“三件套”，该列几点就几点；少用破折号串句，多用短句和句号。\n" +
      "- 不用空话套话与夸大词（如“值得注意的是 / 不言而喻 / 彰显 / 赋能 / 生态 / 闭环 / 助力 / 至关重要 / 深刻洞察 / 一探究竟”），换成平实的说法。\n" +
      "- 不写“专家认为 / 研究表明”这类空泛背书；有依据就用 [B<id>] 指向原文，没有就别编。\n" +
      "- 不用装饰性加粗和 emoji，小标题用普通短语；不复述问题，不说“希望对你有帮助”之类客套。\n" +
      "- 术语按中文科技写作习惯处理：模型名、指标名、专业名词、英文缩写（如 SFT、RLHF、VQA、gold label/gold data）保留原文，不要生硬直译——例如 gold 在“gold 数据 / 黄金标准”语境里不要译成“黄金”；没有通行译名就保留英文并在括号里给出解释。\n" +
      "- 无论用哪种语言回答，都遵循以上风格，读起来像人写的，而不是模板。\n\n";
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
    return msg;
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
    const dCount = (fullText.match(/\[\[(?:hl|note):B?\d+/g) || []).length;
    if (dCount > 0) {
      const applyAll = mkAction("应用全部划线 (" + dCount + ")");
      applyAll.addEventListener("click", async () => {
        if (applyAll._done || applyAll._busy) return; // avoid duplicate highlights on repeat clicks
        applyAll._busy = true;
        applyAll.textContent = "应用中…";
        const { count } = await this.autoApplyDirectives(state, fullText);
        applyAll.textContent = count ? ("✓ 已应用 " + count + " 处") : "未识别到";
        applyAll._done = count > 0; applyAll._busy = false;
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

  // Keep long conversations from silently losing their early turns: once the
  // history grows past TRIGGER, fold the older turns into one rolling summary
  // (stored per attachment) and keep only the most recent KEEP turns verbatim.
  async _compactHistory(key, hist) {
    const KEEP = 12, TRIGGER = 20;
    if (!hist || hist.length < TRIGGER) return;
    const older = hist.splice(0, hist.length - KEEP);
    const prev = this._histSummary.get(key) || "";
    const convo = older.map((m) => (m.role === "user" ? "用户：" : "助手：") + m.content).join("\n");
    try {
      const sum = await this.callLLM([
        { role: "system", content: "把以下对话压缩成要点笔记：保留已得出的结论、用户已问过的问题、表达过的偏好。简洁中文，分条。" },
        { role: "user", content: (prev ? "已有要点：\n" + prev + "\n\n新增对话：\n" : "") + convo },
      ]);
      this._histSummary.set(key, (sum || "").trim());
    } catch (e) { this.log("compact error: " + e); hist.unshift.apply(hist, older); }
  },

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
    return this._send(state, q, opts || { broad: false });
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
      this.setStatus(state, "生成中…", "busy");
      // Fold older turns into a rolling summary so long chats don't lose their
      // early context when we slice to the most recent turns.
      await this._compactHistory(key, hist);
      const sumNote = this._histSummary.get(key);
      const deep = !!this._deepRead;
      const hasSerper = !!(this.getPref("serperKey") || "").trim();
      const webNote = (hasSerper
        ? "需要论文之外的背景、最新进展、术语或相关工作时，可用 web_search 联网搜索、web_fetch 抓取网页正文。"
        : "需要抓取某个网页正文时可用 web_fetch。");
      const toolNote = "\n\n上面的论文正文可能是节选。你可以调用工具查阅更多内容：list_sections 看章节结构；read_section 读取某一章拿到每句 id；" +
        "list_figures 列出图表；view_figure 识读某张图/表的视觉内容；highlight 高亮某个句子 id（给 category 和一句话 reason）。" + webNote +
        (deep
          ? "【深读模式】回答前请主动用 list_sections + read_section 读取所有相关章节，并对相关图/表 view_figure，确保基于充分证据作答。"
          : "当注入的正文不足以准确回答、或问题涉及具体数据/图表时，请主动调用 read_section / view_figure 查阅后再答；普通问题可直接作答。");
      const sys = this.systemPrompt(ctx) + toolNote + this._skillDirective() + (sumNote ? "\n\n【早期对话要点】\n" + sumNote : "");
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
      const tools = this._toolSchemas(fmt0);
      const tc = { sections: this._buildSections(state.blocks), byId: new Map((state.blocks || []).map((b) => [b.id, b])), run: { keys: [], applied: [] }, tally: {}, reads: 0 };
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
      if (opts.autoApply) { const { count } = await this.autoApplyDirectives(state, full); this.setStatus(state, count ? ("已自动高亮 " + count + " 处。") : "未识别到可高亮的句子。", count ? "ok" : "muted"); }
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

  // Rebuild assistant bubble. Prefer full Markdown + KaTeX rendering; fall back
  // to the lightweight line renderer if the libs are missing or anything throws
  // (so a render error can never blank the panel).
  enhanceMessage(state, bubble, text) {
    try {
      if (typeof marked !== "undefined" && marked && typeof marked.parse === "function") {
        this.renderRich(state, bubble, text, { artifacts: true });
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

  renderRich(state, bubble, text, opts) {
    const doc = state.doc;
    const html = this._mathAndMarkdown(text);
    const tmp = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
    tmp.innerHTML = html;
    this._sanitize(tmp);
    bubble.textContent = "";
    bubble.classList.add("aireader-rich");
    while (tmp.firstChild) bubble.appendChild(tmp.firstChild);
    this._linkifyTokens(state, bubble);
    // Model-drawn diagrams render only on the FINAL pass (not mid-stream), so
    // an incomplete fenced block is never injected and SVG isn't rebuilt per delta.
    if (opts && opts.artifacts) { try { this._renderArtifacts(state, bubble); } catch (e) { this.log("artifacts: " + e); } }
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

  // ---- model-drawn diagrams (svg / html) ----
  // Diagrams are rendered by injecting the model's SVG/HTML inline, after a
  // diagram-sanitize pass (strips script/iframe/foreignObject/on*/javascript:
  // but KEEPS <style> for fidelity). This is the same innerHTML path that renders
  // Markdown, so it works where iframes don't: Zotero's privileged XUL-hosted
  // panel renders neither a sandboxed srcdoc iframe nor a same-origin local-page
  // iframe (both stayed blank), and injecting a <script> into the window is CSP-
  // blocked — so a DOM-dependent lib like mermaid can't run here at all. We steer
  // the model to SVG; a stray ```mermaid block degrades to readable source.
  _sanitizeArtifact(root) {
    try {
      root.querySelectorAll("script,iframe,object,embed,link,meta,base,form,input,button,foreignObject").forEach((n) => n.remove());
      root.querySelectorAll("*").forEach((el) => {
        for (const a of Array.from(el.attributes)) {
          const n = a.name.toLowerCase();
          if (n.startsWith("on")) el.removeAttribute(a.name);
          if ((n === "href" || n === "src" || n === "xlink:href") && /^\s*javascript:/i.test(a.value)) el.removeAttribute(a.name);
        }
      });
    } catch (e) {}
  },
  // Replace ```svg / ```html fenced blocks with inline diagrams; a ```mermaid
  // block (which can't render here) shows readable, wrapping source instead.
  // Runs only on the FINAL render (not mid-stream).
  _renderArtifacts(state, root) {
    const doc = state.doc;
    let codes;
    try { codes = root.querySelectorAll("pre > code"); } catch (e) { return; }
    const KIND = { "language-mermaid": "mermaid", "language-svg": "svg", "language-html": "html", "language-xml": "svg" };
    Array.from(codes || []).forEach((code) => {
      let kind = null;
      for (const cls of ((code.className || "") + "").split(/\s+/)) if (KIND[cls]) { kind = KIND[cls]; break; }
      if (!kind) return;
      const src = code.textContent || "";
      if ((kind === "svg") && !/<svg[\s>]/i.test(src)) return;
      if ((kind === "html") && !/[<&]/.test(src)) return;
      const pre = code.parentNode;
      if (!pre || !pre.parentNode) return;
      try {
        const wrap = this._el(doc, "div", "aireader-artifact aireader-artifact-" + kind);
        if (kind === "mermaid") {
          wrap.appendChild(this._el(doc, "div", "aireader-artifact-src", src)); // readable source (no DOM-lib renderer available)
        } else {
          wrap.innerHTML = src;
          this._sanitizeArtifact(wrap); // strip executable bits, keep <style> for SVG fidelity
          if (kind === "svg") { try { this._fitSvg(wrap); } catch (e) {} }
        }
        pre.parentNode.replaceChild(wrap, pre);
      } catch (e) { this.log("artifact replace: " + e); }
    });
  },

  // Make an injected SVG fluid: drop the fixed pixel width/height (which blew the
  // panel wider than the bubble), synthesize a viewBox from them when missing so
  // the aspect ratio is kept, and cap it to the container width.
  _fitSvg(wrap) {
    const svg = wrap.querySelector && wrap.querySelector("svg");
    if (!svg) return;
    const w = parseFloat(svg.getAttribute("width")), h = parseFloat(svg.getAttribute("height"));
    if (!svg.getAttribute("viewBox") && w > 0 && h > 0) svg.setAttribute("viewBox", "0 0 " + w + " " + h);
    svg.removeAttribute("width");
    svg.removeAttribute("height");
    try { svg.style.maxWidth = "100%"; svg.style.height = "auto"; } catch (e) {}
  },

  // "正在绘制…" placeholder shown while a diagram is still streaming (so the raw
  // SVG source never flashes). Appended once; survives across throttled renders
  // because we skip re-rendering the unchanged prose, keeping the spin animation.
  _showDrawing(state, el) {
    let d = el.querySelector && el.querySelector(".aireader-drawing");
    if (!d) { d = this._el(state.doc, "div", "aireader-drawing"); el.appendChild(d); state._drawT0 = Date.now(); }
    const s = Math.round((Date.now() - (state._drawT0 || Date.now())) / 1000);
    d.textContent = s >= 1 ? ("正在绘制图示… " + s + "s") : "正在绘制图示…";
  },
  _clearDrawing(el) {
    try { const d = el.querySelector && el.querySelector(".aireader-drawing"); if (d) d.remove(); } catch (e) {}
  },
  // Prose that precedes the first diagram fence (```svg|html|mermaid|xml), or null
  // if none has opened yet. Used to hide the diagram's raw source while streaming.
  _artifactCut(text) {
    const m = /```(?:svg|html|mermaid|xml)\b/i.exec(text || "");
    return m ? text.slice(0, m.index) : null;
  },

  // Walk rendered text nodes and turn [B<id>] / [[hl|note|fig:id]] into elements.
  _linkifyTokens(state, root) {
    const doc = state.doc;
    const re = /\[\[(?:hl|note|fig):B?\d+|\[B\d+(?:\s*[,，、\-–]\s*B?\d+)*\]/;
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
    const re = /\[\[(hl|note|fig):B?(\d+)(?:\|([^\]]*))?\]\]|(\[B\d+(?:\s*[,，、\-–]\s*B?\d+)*\])|\*\*([^*]+)\*\*|`([^`]+)`/g;
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
        // one or more [B<id>] citations (incl. "[B1, B2]" / "[B1–B2]") → a badge each
        let any = false;
        for (const idStr of (m[4].match(/\d+/g) || [])) {
          const block = byId.get(Number(idStr));
          if (!block || !block.position) continue;
          if (any) container.appendChild(doc.createTextNode(" "));
          const badge = this._el(doc, "a", "aireader-ref", "p" + block.pageLabel);
          badge.addEventListener("click", (ev) => { ev.preventDefault(); AIReader.navigateTo(state.attachment.id, block); });
          badge.addEventListener("mouseenter", (ev) => this.showPreview(state, ev, block));
          badge.addEventListener("mouseleave", () => this.hidePreview(state));
          container.appendChild(badge);
          any = true;
        }
        if (!any) container.appendChild(doc.createTextNode(m[0]));
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

  // One-line vision description of the top figures/tables, folded into a broad
  // summary so it reflects the figures, not just caption text. Bounded for cost.
  async _figureDigest(state, maxFigs) {
    maxFigs = maxFigs || 2;
    const figs = (state.blocks || []).filter((b) => (b.type === "image" || b.type === "table") && b.position).slice(0, maxFigs);
    if (!figs.length) return "";
    const lang = this.getPref("language") || "中文";
    const out = [];
    for (const b of figs) {
      try {
        const dataURI = await this.renderRegionDataURI(state.attachment, b);
        const messages = this.buildVisionMessages(this._fmt(), lang, "一句话说明这张" + this.figKind(b.type) + "（第" + b.pageLabel + "页）展示了什么、关键结论。", dataURI);
        const ans = await this.callLLM(messages);
        out.push("[B" + b.id + " p" + b.pageLabel + "] " + this.figKind(b.type) + "：" + (ans || "").trim().replace(/\s+/g, " "));
      } catch (e) { this.log("figDigest error: " + e); }
    }
    return out.length ? ("【图表视觉摘要】\n" + out.join("\n") + "\n\n") : "";
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

  // Is there already an AI-created annotation at this block's spot? Used to keep
  // auto-apply idempotent (re-running must not stack duplicates).
  _existingAIKeyAt(attachment, block) {
    if (!attachment || !block || !block.position || typeof attachment.getAnnotations !== "function") return null;
    const si = this.sortIndex(block);
    for (let a of (attachment.getAnnotations() || [])) {
      if (typeof a === "number") a = Zotero.Items.get(a);
      if (!a) continue;
      if (a.hasTag && a.hasTag("AI") && a.annotationSortIndex === si) return a.key || true;
    }
    return null;
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

  // ----------------------------------------------- agentic read & annotate
  // Neutral tool declarations (JSON-Schema); shaped per API format by _toolSchemas.
  _agentTools() {
    const T = [
      { name: "list_sections", description: "列出论文的章节大纲（标题、页码、句子数）。先调用它了解结构。", parameters: { type: "object", properties: {}, required: [] } },
      { name: "read_section", description: "读取某一章节的全部句子，返回每句的 id、页码、文本。index 来自 list_sections。", parameters: { type: "object", properties: { index: { type: "integer", description: "章节序号" } }, required: ["index"] } },
      { name: "highlight", description: "在 PDF 里高亮某一句并加一句话批注。id 必须来自 read_section 返回的 id。", parameters: { type: "object", properties: { id: { type: "integer" }, category: { type: "string", enum: ["contribution", "method", "result", "limitation", "keyterm"] }, reason: { type: "string", description: "一句话理由（作为批注）" } }, required: ["id", "category"] } },
      { name: "list_figures", description: "列出论文中的图/表（id、页码、标题）。想看某张图就先用它找到 id。", parameters: { type: "object", properties: {}, required: [] } },
      { name: "view_figure", description: "查看某张图/表的视觉内容：渲染该区域并用多模态模型识读，返回图的文字描述。id 来自 list_figures。", parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
    ];
    // Web search needs a Serper key; only offer it when one is configured so the
    // model doesn't waste turns calling a tool it can't use.
    if ((this.getPref("serperKey") || "").trim()) {
      T.push({ name: "web_search", description: "联网搜索（Google via Serper）。当论文之外的背景、最新进展、术语定义、相关工作需要外部信息时使用。返回标题、链接、摘要。", parameters: { type: "object", properties: { query: { type: "string", description: "搜索关键词" }, num: { type: "integer", description: "返回条数，默认 6，最多 10" } }, required: ["query"] } });
    }
    T.push({ name: "web_fetch", description: "抓取某个网页 URL 并返回其正文文本（已去除导航/脚本）。常配合 web_search 使用：先搜索拿到链接，再抓取需要细读的页面。", parameters: { type: "object", properties: { url: { type: "string", description: "http(s) 网址" } }, required: ["url"] } });
    T.push({ name: "finish", description: "读完并标注完后调用，结束。", parameters: { type: "object", properties: { note: { type: "string" } }, required: [] } });
    return T;
  },
  _toolSchemas(fmt) {
    const T = this._agentTools();
    if (fmt === "anthropic") return T.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (fmt === "responses") return T.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
    return T.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  },
  // Anthropic reads the longest cached *prefix*. A breakpoint on the system
  // block alone caches only the paper/system — the growing conversation is
  // re-read uncached every turn. Add a second, rolling breakpoint on the last
  // message so each turn caches the conversation so far; the next turn hits it
  // and only the new delta is written (incremental multi-turn caching).
  // Clone so we never persist cache_control back into the live history.
  _anthropicCacheMsgs(msgs) {
    if (!msgs.length) return msgs;
    const out = msgs.slice();
    const last = out[out.length - 1];
    const CC = { type: "ephemeral" };
    if (Array.isArray(last.content) && last.content.length) {
      const blocks = last.content.map((b) => ({ ...b }));
      blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: CC };
      out[out.length - 1] = { ...last, content: blocks };
    } else if (typeof last.content === "string") {
      out[out.length - 1] = { ...last, content: [{ type: "text", text: last.content, cache_control: CC }] };
    }
    return out;
  },
  _toolBody(fmt, messages, tools, stream) {
    const model = this.getPref("model");
    const t = parseFloat(this.getPref("temperature")); const temp = isNaN(t) ? 0.3 : t;
    const mtRaw = parseInt(this.getPref("maxTokens"), 10); const maxTok = isNaN(mtRaw) || mtRaw <= 0 ? 0 : mtRaw;
    const hasTools = Array.isArray(tools) && tools.length > 0;
    if (fmt === "anthropic") {
      const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
      const msgs = this._anthropicCacheMsgs(messages.filter((m) => m.role !== "system"));
      const body = { model, messages: msgs, max_tokens: maxTok || 32000, temperature: temp, stream: !!stream };
      if (hasTools) body.tools = tools;
      // Cache the large, stable system prompt (paper context) so multi-turn
      // requests on the same paper hit the prompt cache instead of re-billing it.
      if (system) body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
      return JSON.stringify(body);
    }
    if (fmt === "responses") {
      const body = { model, input: messages, temperature: temp, stream: !!stream };
      if (hasTools) { body.tools = tools; body.tool_choice = "auto"; }
      if (maxTok) body.max_output_tokens = maxTok;
      return JSON.stringify(body);
    }
    const body = { model, messages, temperature: temp, stream: !!stream };
    if (hasTools) { body.tools = tools; body.tool_choice = "auto"; }
    if (maxTok) body.max_tokens = maxTok;
    if (stream) body.stream_options = { include_usage: true };
    return JSON.stringify(body);
  },
  // Accumulate streamed tool-call fragments into `tc` (keyed by index).
  _streamToolDelta(fmt, j, tc) {
    if (fmt === "anthropic") {
      if (j.type === "content_block_start" && j.content_block && j.content_block.type === "tool_use") tc[j.index] = { id: j.content_block.id, name: j.content_block.name, args: "" };
      else if (j.type === "content_block_delta" && j.delta && j.delta.type === "input_json_delta" && tc[j.index]) tc[j.index].args += j.delta.partial_json || "";
      return;
    }
    if (fmt === "responses") {
      if (j.type === "response.output_item.added" && j.item && j.item.type === "function_call") tc[j.output_index] = { id: j.item.call_id || j.item.id, name: j.item.name, args: "" };
      else if (j.type === "response.function_call_arguments.delta" && tc[j.output_index]) tc[j.output_index].args += j.delta || "";
      return;
    }
    const arr = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.tool_calls;
    if (Array.isArray(arr)) for (const t of arr) { const i = t.index || 0; tc[i] = tc[i] || { id: "", name: "", args: "" }; if (t.id) tc[i].id = t.id; if (t.function) { if (t.function.name) tc[i].name = t.function.name; if (t.function.arguments) tc[i].args += t.function.arguments; } }
  },
  _finalizeToolCalls(tc) {
    return Object.keys(tc).sort((a, b) => a - b).map((k) => ({ id: tc[k].id, name: tc[k].name, args: this._safeJSON(tc[k].args) })).filter((c) => c.name);
  },
  // Accumulate the model's REASONING so it can be fed back verbatim on the next
  // round — required for multi-turn tool use: Anthropic rejects a follow-up whose
  // assistant turn drops the thinking block (it must keep its signature), and
  // OpenAI /responses needs the reasoning item returned with its id. (litellm does
  // the same "preserve & replay" for both.) Chat Completions has no such token.
  _streamReasoningDelta(fmt, j, racc) {
    if (fmt === "anthropic") {
      if (j.type === "content_block_start" && j.content_block) {
        if (j.content_block.type === "thinking") racc[j.index] = { type: "thinking", thinking: j.content_block.thinking || "", signature: j.content_block.signature || "" };
        else if (j.content_block.type === "redacted_thinking") racc[j.index] = { type: "redacted_thinking", data: j.content_block.data || "" };
      } else if (j.type === "content_block_delta" && j.delta && racc[j.index]) {
        if (j.delta.type === "thinking_delta") racc[j.index].thinking += j.delta.thinking || "";
        else if (j.delta.type === "signature_delta") racc[j.index].signature = (racc[j.index].signature || "") + (j.delta.signature || "");
      }
      return;
    }
    if (fmt === "responses") {
      // keep the whole reasoning item (id / summary / encrypted_content) verbatim
      if ((j.type === "response.output_item.added" || j.type === "response.output_item.done") && j.item && j.item.type === "reasoning") racc[j.output_index] = j.item;
      return;
    }
  },
  _finalizeReasoning(racc) {
    const keys = Object.keys(racc);
    return keys.length ? keys.sort((a, b) => a - b).map((k) => racc[k]).filter(Boolean) : [];
  },
  // Streamed turn that returns both the streamed text and any tool calls.
  async _streamAnswer(messages, tools, onDelta, shouldStop, meta) {
    meta = meta || {};
    const fmt = this._fmt();
    // Long streamed answers can take minutes; the default 60s abort would cut
    // the stream mid-sentence, so give streaming a generous ceiling and no retry.
    const resp = await this._fetchLLM(this._endpointFor(fmt), { method: "POST", headers: this._headersFor(fmt), body: this._toolBody(fmt, messages, tools, true) }, { timeoutMs: 600000, retries: 0 });
    if (!resp.ok) { const raw = await resp.text().catch(() => ""); throw this._fail(resp, raw); }
    if (!resp.body || typeof resp.body.getReader !== "function") {
      const raw = await resp.text(); const data = this._parseOrThrow(raw);
      if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
      this._captureUsage(meta, data);
      const parsed = this._parseToolCalls(fmt, data);
      if (parsed.text) onDelta(parsed.text);
      return { text: parsed.text, calls: parsed.calls, reasoning: parsed.reasoning || [] };
    }
    const reader = resp.body.getReader(); const dec = new TextDecoder();
    let buf = "", text = ""; const tc = {}; const racc = {};
    while (true) {
      if (shouldStop && shouldStop()) { try { await reader.cancel(); } catch (e) {} break; }
      const { done, value } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1);
        if (!line || !line.startsWith("data:")) continue;
        const payload = line.slice(5).trim(); if (payload === "[DONE]") continue;
        let j; try { j = JSON.parse(payload); } catch (e) { continue; }
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        this._captureUsage(meta, j);
        const d = this._streamDelta(fmt, j); if (d) { text += d; onDelta(d); }
        this._streamToolDelta(fmt, j, tc);
        this._streamReasoningDelta(fmt, j, racc);
      }
    }
    return { text, calls: this._finalizeToolCalls(tc), reasoning: this._finalizeReasoning(racc) };
  },
  _safeJSON(s) { if (s && typeof s === "object") return s; try { return JSON.parse(s || "{}"); } catch (e) { return {}; } },
  _parseToolCalls(fmt, data) {
    if (fmt === "anthropic") {
      const content = Array.isArray(data.content) ? data.content : [];
      let text = ""; const calls = [], reasoning = [];
      for (const c of content) {
        if (c.type === "text") text += c.text || "";
        else if (c.type === "tool_use") calls.push({ id: c.id, name: c.name, args: c.input || {} });
        else if (c.type === "thinking" || c.type === "redacted_thinking") reasoning.push(c);
      }
      return { text, calls, reasoning, raw: content };
    }
    if (fmt === "responses") {
      const out = Array.isArray(data.output) ? data.output : [];
      let text = ""; const calls = [], reasoning = [];
      for (const o of out) {
        if (o.type === "function_call") calls.push({ id: o.call_id || o.id, name: o.name, args: this._safeJSON(o.arguments) });
        else if (o.type === "reasoning") reasoning.push(o);
        else if (o.type === "message" && Array.isArray(o.content)) text += o.content.map((x) => x.text || "").join("");
      }
      if (typeof data.output_text === "string" && data.output_text) text = data.output_text;
      return { text, calls, reasoning, raw: out };
    }
    const msg = (data.choices && data.choices[0] && data.choices[0].message) || {};
    const calls = (msg.tool_calls || []).map((tc) => ({ id: tc.id, name: tc.function && tc.function.name, args: this._safeJSON(tc.function && tc.function.arguments) }));
    return { text: msg.content || "", calls, reasoning: [], raw: msg };
  },
  // Build the assistant turn in each format's native shape from {text, calls}
  // (works whether the turn came from a streamed or non-streamed response).
  _pushAssistantToolTurn(fmt, messages, parsed) {
    const calls = parsed.calls || [], text = parsed.text || "", reasoning = parsed.reasoning || [];
    if (fmt === "anthropic") {
      const content = [];
      for (const r of reasoning) content.push(r); // thinking/redacted_thinking FIRST, verbatim (keeps signature)
      if (text) content.push({ type: "text", text });
      for (const c of calls) content.push({ type: "tool_use", id: c.id, name: c.name, input: c.args || {} });
      messages.push({ role: "assistant", content });
      return;
    }
    if (fmt === "responses") {
      for (const r of reasoning) messages.push(r); // reasoning item returned verbatim, before the function_call
      if (text) messages.push({ role: "assistant", content: text });
      for (const c of calls) messages.push({ type: "function_call", call_id: c.id, name: c.name, arguments: JSON.stringify(c.args || {}) });
      return;
    }
    const tool_calls = calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
    messages.push({ role: "assistant", content: text || null, tool_calls });
  },
  _pushToolResults(fmt, messages, results) {
    if (fmt === "anthropic") { messages.push({ role: "user", content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: r.output })) }); return; }
    if (fmt === "responses") { for (const r of results) messages.push({ type: "function_call_output", call_id: r.id, output: r.output }); return; }
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: r.output });
  },

  // Group blocks into sections by preceding heading. index == array position.
  _buildSections(blocks) {
    const sections = []; let cur = null;
    const start = (title, page) => { cur = { index: 0, title, page, blockIds: [] }; sections.push(cur); };
    for (const b of blocks || []) {
      if (b.type === "heading") { start((b.text || "（无标题）").slice(0, 80), b.pageLabel); continue; }
      if (b.type === "image" || b.type === "math") continue;
      if (!b.position || !b.text) continue;
      if (!cur) start("前言 / 摘要", b.pageLabel);
      cur.blockIds.push(b.id);
    }
    const kept = sections.filter((s) => s.blockIds.length);
    kept.forEach((s, i) => { s.index = i; });
    return kept;
  },

  // Build one collapsible tool block (borrowed from cc_manager's tool-timeline):
  // arrow/dot + name + brief + outcome; click to expand body (read/list) or jump
  // to the sentence (highlight). Returns the element (caller appends).
  _buildToolBlock(state, r) {
    const doc = state.doc;
    const block = this._el(doc, "div", "aireader-tool");
    const header = this._el(doc, "div", "aireader-tool-header");
    if (r.cat) { const dot = this._el(doc, "span", "aireader-tool-dot"); dot.style.background = this.colorForCategory(r.cat); header.appendChild(dot); }
    else header.appendChild(this._el(doc, "span", "aireader-tool-arrow", "›"));
    header.appendChild(this._el(doc, "span", "aireader-tool-name", r.label));
    if (r.brief) header.appendChild(this._el(doc, "span", "aireader-tool-brief", r.brief));
    if (r.outcome) header.appendChild(this._el(doc, "span", "aireader-tool-outcome", r.outcome));
    block.appendChild(header);
    if (r.bodyText) {
      block.appendChild(this._el(doc, "div", "aireader-tool-body", r.bodyText));
      header.style.cursor = "pointer";
      header.addEventListener("click", () => block.classList.toggle("aireader-tool-open"));
    } else if (r.jumpId != null) {
      header.style.cursor = "pointer";
      header.addEventListener("click", () => { const blk = (state.blocks || []).find((x) => x.id === r.jumpId); if (blk) this.navigateTo(state.attachment.id, blk); });
    }
    return block;
  },
  _renderToolBlock(state, wrap, r) { const b = this._buildToolBlock(state, r); wrap.appendChild(b); return b; },

  // Append a tool block, compressing a run of same-type calls into a collapsible
  // group ("读取章节 × N"): the first of a kind shows inline; once a second of
  // the same kind arrives the group header appears and the body collapses.
  _appendToolGrouped(state, wrap, grp, r) {
    const doc = state.doc;
    const block = this._buildToolBlock(state, r);
    if (grp.label !== r.label || !grp.group) {
      const group = this._el(doc, "div", "aireader-toolgroup");
      const header = this._el(doc, "div", "aireader-toolgroup-header");
      header.style.display = "none";
      header.appendChild(this._el(doc, "span", "aireader-tool-arrow", "›"));
      header.appendChild(this._el(doc, "span", "aireader-tool-name", r.label));
      const countEl = this._el(doc, "span", "aireader-toolgroup-count", "");
      header.appendChild(countEl);
      const body = this._el(doc, "div", "aireader-toolgroup-body");
      group.appendChild(header); group.appendChild(body);
      wrap.appendChild(group);
      header.addEventListener("click", () => group.classList.toggle("aireader-toolgroup-open"));
      grp.label = r.label; grp.group = group; grp.header = header; grp.body = body; grp.countEl = countEl; grp.count = 0;
    }
    grp.body.appendChild(block); grp.count++;
    if (grp.count >= 2) { grp.header.style.display = "flex"; grp.countEl.textContent = "× " + grp.count; grp.group.classList.add("aireader-toolgroup-multi"); }
    return block;
  },

  // Execute one tool call against the paper. c = {sections, byId, run, tally, reads}.
  // Returns { output (string for the model), render (tool-block spec), finish? }.
  // Session-scoped cache of what the model has already read (sections) and seen
  // (figures) for the current paper, so later turns reuse it instead of calling
  // the same read_section / view_figure again — a continuous reading context.
  // Global (per attachment key) caches of what has been read/viewed, so the
  // selection-popup Explain — which has no panel state — can also see them, and
  // so the "通读并标注" agent (which has no live conversation) can reuse them.
  _readFor(key) { if (!this._readStore.has(key)) this._readStore.set(key, new Map()); return this._readStore.get(key); },
  _figFor(key) { if (!this._figStore.has(key)) this._figStore.set(key, new Map()); return this._figStore.get(key); },
  _priorContextForKey(key) {
    if (!key) return "";
    const parts = [];
    for (const [, s] of (this._readStore.get(key) || new Map())) parts.push("## " + s.title + "\n" + s.text);
    for (const [id, f] of (this._figStore.get(key) || new Map())) parts.push("## 图/表 B" + id + "（p" + f.page + "）\n" + f.desc);
    if (!parts.length) return "";
    let body = parts.join("\n\n");
    const CAP = 40000;
    if (body.length > CAP) body = "…（较早内容略）…\n" + body.slice(body.length - CAP); // keep most recent
    return "\n\n【本会话已读资料（已为你读取，可直接引用；不要再 read_section / view_figure 已在此列出的章节/图表）】\n" + body;
  },
  // Run one round's tool calls, returning results aligned with `calls`.
  // Read-only calls (reading sections, viewing figures, web) run concurrently up
  // to maxParallelTools (default 3; set 1 to force serial if your API rejects
  // parallel requests); side-effecting calls (highlight/finish) stay serial and
  // in order. Per-call failures become an error result, never crash the round.
  async _runToolCalls(state, c, calls) {
    const RO = new Set(["list_sections", "read_section", "list_figures", "view_figure", "web_search", "web_fetch"]);
    const limit = Math.max(1, parseInt(this.getPref("maxParallelTools"), 10) || 3);
    const slots = new Array(calls.length);
    const run1 = async (i) => {
      // Once the user hits stop, don't launch any further tool calls (the one
      // already in flight will still finish — aborting mid-request would need a
      // signal threaded through the whole network layer).
      if (state && state.cancel) { slots[i] = { output: JSON.stringify({ error: "已取消" }), render: { label: calls[i].name, outcome: "✕ 已取消" } }; return; }
      try { slots[i] = await this._execTool(state, c, calls[i]); }
      catch (e) { slots[i] = { output: JSON.stringify({ error: String((e && e.message) || e) }), render: { label: calls[i].name, outcome: "✕ 失败" } }; }
    };
    const ro = [], wr = [];
    calls.forEach((call, i) => (RO.has(call.name) ? ro : wr).push(i));
    let p = 0;
    const worker = async () => { while (p < ro.length) { await run1(ro[p++]); } };
    await Promise.all(Array.from({ length: Math.min(limit, ro.length) }, () => worker()));
    for (const i of wr) await run1(i); // side effects serial + in order
    return slots;
  },
  async _execTool(state, c, call) {
    const name = call.name, args = call.args || {};
    if (name === "list_sections") {
      return { output: JSON.stringify(c.sections.map((s) => ({ index: s.index, title: s.title, page: s.page, sentences: s.blockIds.length }))),
        render: { label: "列出章节", outcome: "→ " + c.sections.length + " 节", bodyText: c.sections.map((s) => "[" + s.index + "] " + s.title + "  (p" + s.page + " · " + s.blockIds.length + " 句)").join("\n") } };
    }
    if (name === "read_section") {
      if (c.maxReads && (c.reads || 0) >= c.maxReads) return { output: JSON.stringify({ error: "read limit reached" }), render: { label: "读取章节", brief: "index " + args.index, outcome: "✕ 已达上限" } };
      c.reads = (c.reads || 0) + 1;
      const s = c.sections[args.index];
      if (!s) return { output: JSON.stringify({ error: "no such section " + args.index }), render: { label: "读取章节", brief: "index " + args.index, outcome: "✕ 无此节" } };
      const lines = []; let total = 0;
      for (const id of s.blockIds) { const b = c.byId.get(id); if (!b) continue; lines.push({ id: b.id, page: b.pageLabel, text: b.text }); total += (b.text || "").length; if (total > 9000) break; }
      const btext = lines.map((l) => "[B" + l.id + " p" + l.page + "] " + l.text).join("\n");
      { const k = state.attachment && state.attachment.key; if (k) this._readFor(k).set(args.index, { title: s.title, text: btext }); } // keep for later turns / popup
      return { output: JSON.stringify(lines), render: { label: "读取章节", brief: s.title, outcome: "→ " + lines.length + " 句", bodyText: btext } };
    }
    if (name === "highlight") {
      if (c.maxAnn && c.run && c.run.keys.length >= c.maxAnn) return { output: JSON.stringify({ error: "annotation limit reached" }), render: { label: "高亮", outcome: "✕ 已达上限" } };
      const b = c.byId.get(args.id);
      if (!b || !b.position) return { output: JSON.stringify({ error: "no such sentence id " + args.id }), render: { label: "高亮", brief: "id " + args.id, outcome: "✕ 无此句" } };
      const cat = args.category || "keyterm";
      if (this._existingAIKeyAt(state.attachment, b)) return { output: JSON.stringify({ ok: true, note: "already highlighted" }), render: { label: "高亮", cat, brief: (this.CATEGORY_LABELS[cat] || cat), outcome: "· 已存在", jumpId: b.id } };
      const r = await this.applyAnnotation(state.attachment, b, { type: "highlight", comment: args.reason || "", color: this.colorForCategory(cat) });
      c.run.keys.push(r.key); c.run.applied.push({ key: r.key, category: cat, blockId: b.id, pageLabel: b.pageLabel, comment: args.reason || "", color: this.colorForCategory(cat) });
      c.tally[cat] = (c.tally[cat] || 0) + 1;
      return { output: JSON.stringify({ ok: true, key: r.key }), render: { label: "高亮", cat, brief: (this.CATEGORY_LABELS[cat] || cat) + (args.reason ? " · " + args.reason : ""), outcome: "p" + b.pageLabel, jumpId: b.id } };
    }
    if (name === "list_figures") {
      const figs = (state.blocks || []).filter((b) => (b.type === "image" || b.type === "table") && b.position);
      return { output: JSON.stringify(figs.map((f) => ({ id: f.id, page: f.pageLabel, kind: this.figKind(f.type), caption: (f.text || "").slice(0, 80) }))),
        render: { label: "列出图表", outcome: "→ " + figs.length + " 个", bodyText: figs.map((f) => "[B" + f.id + " p" + f.pageLabel + "] " + this.figKind(f.type) + (f.text ? ": " + f.text.slice(0, 60) : "")).join("\n") || "（无图表）" } };
    }
    if (name === "view_figure") {
      const b = c.byId.get(args.id);
      if (!b || !b.position) return { output: JSON.stringify({ error: "no such figure id " + args.id }), render: { label: "看图", brief: "id " + args.id, outcome: "✕ 无此图" } };
      try {
        const dataURI = await this.renderRegionDataURI(state.attachment, b);
        const lang = this.getPref("language") || "中文";
        const vm = this.buildVisionMessages(this._fmt(), lang, "请详细描述这张" + this.figKind(b.type) + "（第" + b.pageLabel + "页）展示的内容、坐标轴/变量、关键趋势与结论。", dataURI);
        const desc = (await this.callLLM(vm)).trim();
        { const k = state.attachment && state.attachment.key; if (k) this._figFor(k).set(args.id, { page: b.pageLabel, kind: this.figKind(b.type), desc }); } // keep for later turns / popup
        return { output: JSON.stringify({ description: desc }), render: { label: "看图", brief: this.figKind(b.type) + " p" + b.pageLabel, outcome: "→ 已识读", bodyText: desc, jumpId: b.id } };
      } catch (e) { return { output: JSON.stringify({ error: String(e.message || e) }), render: { label: "看图", brief: "p" + b.pageLabel, outcome: "✕ 失败" } }; }
    }
    if (name === "web_search") {
      const q = (args.query || "").trim();
      if (!q) return { output: JSON.stringify({ error: "empty query" }), render: { label: "联网搜索", outcome: "✕ 空查询" } };
      try {
        const results = await this.webSearch(q, args.num);
        return { output: JSON.stringify(results),
          render: { label: "联网搜索", brief: q, outcome: "→ " + results.length + " 条", bodyText: results.map((r, i) => (i + 1) + ". " + r.title + "\n   " + r.link + "\n   " + (r.snippet || "")).join("\n") || "（无结果）" } };
      } catch (e) { return { output: JSON.stringify({ error: String(e.message || e) }), render: { label: "联网搜索", brief: q, outcome: "✕ 失败" } }; }
    }
    if (name === "web_fetch") {
      const url = (args.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return { output: JSON.stringify({ error: "url must start with http(s)://" }), render: { label: "抓取网页", brief: url || "(空)", outcome: "✕ 非法 URL" } };
      try {
        const { title, text } = await this.webFetch(url);
        return { output: JSON.stringify({ url, title, text }),
          render: { label: "抓取网页", brief: this._urlHost(url), outcome: "→ " + text.length + " 字", bodyText: (title ? title + "\n\n" : "") + text.slice(0, 2000) } };
      } catch (e) { return { output: JSON.stringify({ error: String(e.message || e) }), render: { label: "抓取网页", brief: this._urlHost(url), outcome: "✕ 失败" } }; }
    }
    if (name === "finish") return { output: JSON.stringify({ ok: true }), render: { label: "完成", outcome: "✓" }, finish: true };
    return { output: JSON.stringify({ error: "unknown tool " + name }), render: { label: name, outcome: "✕ 未知工具" } };
  },

  _urlHost(u) { try { return new URL(u).host; } catch (e) { return (u || "").slice(0, 40); } },

  // Google search via Serper (serper.dev). Needs the serperKey pref.
  async webSearch(query, num) {
    const key = (this.getPref("serperKey") || "").trim();
    if (!key) throw new Error("未配置 Serper API Key（设置 → AI Reader）。");
    const n = Math.max(1, Math.min(10, parseInt(num, 10) || 6));
    const resp = await this._fetchLLM("https://google.serper.dev/search",
      { method: "POST", headers: { "X-API-KEY": key, "Content-Type": "application/json" }, body: JSON.stringify({ q: query, num: n }) },
      { timeoutMs: 20000, retries: 1 });
    const raw = await resp.text();
    if (!resp.ok) throw new Error("Serper " + resp.status + "：" + raw.slice(0, 200));
    const data = this._parseOrThrow(raw);
    const out = [];
    if (data.answerBox && (data.answerBox.answer || data.answerBox.snippet)) out.push({ title: data.answerBox.title || "Answer", link: data.answerBox.link || "", snippet: data.answerBox.answer || data.answerBox.snippet });
    for (const r of (data.organic || [])) { out.push({ title: r.title || "", link: r.link || "", snippet: r.snippet || "" }); if (out.length >= n) break; }
    return out;
  },

  // Fetch a web page and reduce it to readable plain text.
  async webFetch(url) {
    const resp = await this._fetchLLM(url, { method: "GET", headers: { "User-Agent": "Mozilla/5.0 (ZoteroAIReader)", "Accept": "text/html,application/xhtml+xml,text/plain,*/*" } }, { timeoutMs: 25000, retries: 1 });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const ctype = (resp.headers && resp.headers.get && resp.headers.get("content-type")) || "";
    const body = await resp.text();
    if (/application\/json/i.test(ctype)) return { title: "", text: body.slice(0, 16000) };
    return this._htmlToText(body);
  },

  _decodeEntities(s) {
    return (s || "")
      .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
      .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCharCode(+d); } catch (e) { return ""; } });
  },
  // Strip scripts/styles/markup and collapse whitespace into readable text.
  _htmlToText(html) {
    let s = html || "";
    const tm = s.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    const title = tm ? this._decodeEntities(tm[1].replace(/\s+/g, " ").trim()) : "";
    s = s.replace(/<!--[\s\S]*?-->/g, " ");
    s = s.replace(/<(script|style|noscript|svg|head|nav|footer|header|form|aside)[\s\S]*?<\/\1>/gi, " ");
    s = s.replace(/<\/(p|div|li|tr|h[1-6]|br|section|article)>/gi, "\n");
    s = s.replace(/<li[^>]*>/gi, "• ");
    s = s.replace(/<[^>]+>/g, " ");
    s = this._decodeEntities(s);
    s = s.replace(/[ \t ]+/g, " ").replace(/\n{3,}/g, "\n\n").replace(/^\s+|\s+$/gm, "").trim();
    return { title, text: s.slice(0, 16000) };
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

  async navigateTo(attachmentID, block) {
    if (!block || !block.position) return;
    try { await Zotero.Reader.open(attachmentID, { position: block.position }); } catch (e) { this.log("navigate error: " + e); }
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
    const re = /\[\[(hl|note):B?(\d+)(?:\|([^\]]*))?\]\]|(\[B\d+(?:\s*[,，、\-–]\s*B?\d+)*\])|\*\*([^*]+)\*\*|`([^`]+)`/g;
    while ((m = re.exec(text)) !== null) {
      out += this._escapeHTML(text.slice(last, m.index));
      last = re.lastIndex;
      if (m[1]) { /* drop annotation directives in notes */ }
      else if (m[4] !== undefined) {
        // one or more [B<id>] citations (incl. "[B1, B2]" / "[B1–B2]")
        const key = state.attachment && state.attachment.key;
        const parts = [];
        for (const idStr of (m[4].match(/\d+/g) || [])) {
          const b = byId.get(Number(idStr)); if (!b) continue;
          const page = (b.pageLabel && b.pageLabel !== "?") ? b.pageLabel : "";
          if (key && page) parts.push('<a href="zotero://open-pdf/library/items/' + key + "?page=" + encodeURIComponent(page) + '" style="color:#3b7ddd;text-decoration:none">p' + this._escapeHTML(page) + "</a>");
          else parts.push('<span style="color:#888">p' + this._escapeHTML(b.pageLabel) + "</span>");
        }
        out += parts.length ? (" (" + parts.join(", ") + ")") : this._escapeHTML(m[0]);
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
  _fmt() {
    const f = (this.getPref("apiFormat") || "auto").trim();
    if (["chat", "responses", "anthropic"].includes(f)) return f; // explicit user choice wins
    return this._autoFmt(this.getPref("model")); // "auto" (or anything unknown) → pick by model name
  },
  // Map a model name to its best-fit API format: Claude → Anthropic /messages,
  // OpenAI → /responses; otherwise fall back to /chat/completions (the only
  // format most compatible gateways — DeepSeek, Moonshot, Qwen, Ollama… — speak).
  _autoFmt(model) {
    const m = (model || "").toLowerCase();
    if (/claude/.test(m)) return "anthropic";
    if (/gpt-oss/.test(m)) return "chat"; // open-weight GPT, served via /chat/completions on gateways — not /responses
    if (/\bgpt\b|gpt-|^o[1-9]|\bo[1-9]-|openai|davinci|text-(davinci|embedding)/.test(m)) return "responses";
    return "chat";
  },
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
      const msgs = this._anthropicCacheMsgs(messages.filter((m) => m.role !== "system").map((m) => ({ role: m.role, content: m.content })));
      // Anthropic requires max_tokens; when uncapped, request a large ceiling so answers aren't truncated.
      const body = { model, messages: msgs, max_tokens: maxTok || 32000, temperature: temp, stream: !!stream };
      if (system) body.system = [{ type: "text", text: system, cache_control: { type: "ephemeral" } }];
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
      // prompt-cache hits (Anthropic) / cached_tokens (OpenAI) so savings are visible
      if (u.cache_read_input_tokens != null) meta.cacheRead = u.cache_read_input_tokens;
      if (u.cache_creation_input_tokens != null) meta.cacheWrite = u.cache_creation_input_tokens;
      if (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens != null) meta.cacheRead = u.prompt_tokens_details.cached_tokens;
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

  // Turn a raw error into a short, actionable Chinese hint (keeps the original
  // text appended, so a wrong Base URL / format / key is diagnosable at a glance
  // instead of a bare "Error: HTTP 401 …").
  _friendlyError(e) {
    const raw = (e && e.message) ? String(e.message) : String(e || "出错了");
    const m = raw.toLowerCase();
    if (/base url 未设置|api key 未设置/.test(raw)) return raw; // already clear + actionable
    const tip = (t) => t + "\n\n（原始信息：" + raw.slice(0, 300) + "）";
    if (/abort|timeout|timed ?out/.test(m)) return tip("请求超时。回答太长或网络较慢时容易这样——可以重试，或在设置里调小「最大发送字符数」。");
    if (/http 401|http 403|unauthorized|forbidden|invalid.?api.?key|invalid_api_key/.test(m)) return tip("API Key 无效或没有权限。到设置里确认 Key，以及它是否对应当前 Base URL 的服务。");
    if (/http 404|not found|no such|unknown model|does not exist/.test(m)) return tip("接口或模型找不到。检查 Base URL、「接口格式」和模型名是否匹配。");
    if (/http 429|rate.?limit|too many requests|quota/.test(m)) return tip("触发限流或额度不足。稍等再试，或换一个 Key / 模型。");
    if (/http 5\d\d|internal server|bad gateway|service unavailable|overloaded/.test(m)) return tip("服务端出错（5xx），通常是对面临时故障，稍后重试。");
    if (/network|failed to fetch|fetch failed|enotfound|econnrefused|socket hang|dns|网络请求失败/.test(m)) return tip("连不上接口。检查网络、Base URL 是否正确、是否需要代理。");
    if (/非 json|not json|unexpected token|无法从响应|无法提取结构化文本/.test(m)) return tip("返回的内容不是预期格式。多半是 Base URL 或「接口格式」选错了（比如给 OpenAI 服务选了 Anthropic 格式）。");
    return raw;
  },
  _parseOrThrow(raw) { try { return JSON.parse(raw); } catch (e) { throw new Error("响应不是 JSON（Base URL 或 API 格式可能不对）。实际返回：\n" + (raw || "").slice(0, 1200)); } },

  // fetch with an idle timeout and one automatic retry on a *network* failure
  // (connection reset / empty reply — the transient errors we actually hit).
  // HTTP errors (4xx/5xx with a body) are returned as-is and NOT retried.
  async _fetchLLM(url, opts, cfg) {
    cfg = cfg || {};
    const timeoutMs = cfg.timeoutMs || 60000;
    const retries = cfg.retries == null ? 1 : cfg.retries;
    let lastErr;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const ctrl = (typeof AbortController === "function") ? new AbortController() : null;
      const timer = ctrl ? setTimeout(() => { try { ctrl.abort(); } catch (e) {} }, timeoutMs) : null;
      try {
        const resp = await fetch(url, ctrl ? Object.assign({}, opts, { signal: ctrl.signal }) : opts);
        if (timer) clearTimeout(timer);
        return resp; // HTTP status handled by caller; not a network failure
      } catch (e) {
        if (timer) clearTimeout(timer);
        lastErr = e;
        if (attempt < retries) { this.log("fetch retry after network error: " + (e && e.message)); continue; }
      }
    }
    throw new Error("网络请求失败（已重试）：" + (lastErr && lastErr.message ? lastErr.message : lastErr));
  },

  async callLLM(messages) {
    const fmt = this._fmt();
    const resp = await this._fetchLLM(this._endpointFor(fmt), { method: "POST", headers: this._headersFor(fmt), body: this._bodyFor(fmt, messages, false) });
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
    // _fetchLLM retries only the connection (before any stream bytes), so a
    // mid-stream drop is never silently retried into a duplicate answer.
    const resp = await this._fetchLLM(this._endpointFor(fmt), { method: "POST", headers: this._headersFor(fmt), body: this._bodyFor(fmt, messages, true) }, { timeoutMs: 600000, retries: 0 });
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
        "min-width:280px;max-width:460px;margin-top:6px;padding:5px;border-radius:13px;background:" + glass +
        ";-webkit-backdrop-filter:" + filter + ";backdrop-filter:" + filter +
        ";border:0.5px solid " + border + ";box-shadow:0 10px 34px rgba(0,0,0,0.22),0 1px 2px rgba(0,0,0,0.12)" +
        ";font-family:" + this._UIFONT + ";color:" + fg + ";";
      const mkSep = () => { const s = doc.createElementNS("http://www.w3.org/1999/xhtml", "div"); s.style.cssText = "height:0;border-top:0.5px solid " + border + ";margin:4px 8px;"; return s; };

      // result text — selectable so the user can copy with the mouse too
      const result = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      result.style.cssText = "display:none;margin:5px 7px 3px;padding-top:7px;border-top:0.5px solid " + border +
        ";max-width:440px;max-height:260px;overflow:auto;font-size:12px;line-height:1.5;white-space:pre-wrap;color:" + fg +
        ";user-select:text;-webkit-user-select:text;cursor:text;";

      // action row under a result (copy / write-to-annotation); hidden until a
      // result exists
      const actions = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
      actions.style.cssText = "display:none;gap:8px;margin:2px 7px 4px;";
      const mkMini = (label) => {
        const b = doc.createElementNS("http://www.w3.org/1999/xhtml", "div");
        b.textContent = label;
        b.style.cssText = "display:inline-flex;align-items:center;white-space:nowrap;cursor:pointer;padding:4px 10px;border-radius:7px;font-size:11.5px;font-weight:600;color:" + accent + ";background:transparent;border:0.5px solid " + border + ";margin-inline-end:8px;transition:background .08s,color .08s;";
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
      // cancel flag for an in-flight stream; a "停止" chip flips it.
      const popupCancel = { v: false };
      const stopEl = mkMini("■ 停止");
      stopEl.style.display = "none";
      stopEl.addEventListener("click", () => { popupCancel.v = true; stopEl.textContent = "停止中…"; });

      // Stream a producer into the result area with live feedback. The result is
      // rendered as Markdown/KaTeX (same pipeline as the sidebar). Busy state is
      // shown ONLY via the label text + result area (never the background), so it
      // can't collide with hover styling.
      const renderMD = (t) => { try { result.innerHTML = AIReader._mathAndMarkdown(t); } catch (e) { result.textContent = t; } };
      const runStream = (btn, labelSpan, baseLabel, waitText, showActions, streamRun) => async () => {
        if (btn._busy) return; btn._busy = true; popupCancel.v = false;
        labelSpan.textContent = baseLabel + " · " + waitText + " ⏳";
        result.style.display = "block"; result.style.color = fg; result.textContent = "⏳ " + waitText + "…";
        actions.style.display = "none"; lastResult = "";
        stopEl.textContent = "■ 停止"; stopEl.style.display = "inline-flex";
        let acc = "", lastR = 0;
        try {
          await streamRun((d) => {
            acc += d; const now = Date.now();
            if (now - lastR > 90) { lastR = now; renderMD(acc); try { result.scrollTop = result.scrollHeight; } catch (e) {} }
          }, () => popupCancel.v);
          lastResult = acc.trim();
          if (lastResult) renderMD(lastResult); else result.textContent = popupCancel.v ? "（已停止）" : "(空响应)";
          if (showActions && lastResult) actions.style.display = "flex";
          // Cache so the result survives the reader re-rendering this popup on
          // scroll (otherwise scrolling wiped the freshly-built DOM).
          if (lastResult) AIReader._popupCache = { text: text, raw: lastResult, showActions: !!showActions };
        } catch (e) { result.style.color = accent; result.textContent = "出错：" + (e.message || e); }
        finally { btn._busy = false; labelSpan.textContent = baseLabel; stopEl.style.display = "none"; }
      };

      wrap.appendChild(mkItem("问 AI（引用到侧栏）", true, (b) => {
        this.quoteSelection(reader, text);
        result.style.display = "block"; result.style.color = accent;
        result.textContent = "已引用到右侧输入框 →"; actions.style.display = "none"; lastResult = "";
      }));
      wrap.appendChild(mkSep());
      // AI 解释：流式输出 + Markdown 渲染，看得到论文相关段落 + 之前的对话历史；完成后出「复制 / 写入批注」
      wrap.appendChild(mkItem("AI 解释", false, (b, ls) =>
        runStream(b, ls, "AI 解释", "解释中", true, (onDelta, stop) => this.explainSelectionStream(reader, text, onDelta, stop))()));
      wrap.appendChild(mkItem("翻译", false, (b, ls) =>
        runStream(b, ls, "翻译", "翻译中", false, (onDelta, stop) => this.callLLMStream([{ role: "system", content: "You are a professional translator. Translate into " + lang + ". Output only the translation." }, { role: "user", content: text }], onDelta, stop))()));
      wrap.appendChild(result);
      stopEl.style.margin = "2px 7px 4px";
      wrap.appendChild(stopEl);
      wrap.appendChild(actions);
      // Restore a previous result for this exact selection: the reader rebuilds
      // this popup on scroll, which would otherwise erase the explanation.
      const cached = AIReader._popupCache;
      if (cached && cached.text === text && cached.raw) {
        lastResult = cached.raw;
        result.style.display = "block"; result.style.color = fg; renderMD(cached.raw);
        if (cached.showActions) actions.style.display = "flex";
      }
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
      ". 2-4 sentences. The paper context and prior conversation are BACKGROUND only — use them to stay consistent, but " +
      "answer by explaining the selected passage directly. Do NOT comment on, apologise for, or correct earlier messages, " +
      "and do NOT add meta remarks like “更正”/“上一条”；只输出对选中原文的解释本身。\n\n" +
      this._styleGuide() +
      this._customPrompt() +
      this._priorContextForKey(key) + // sections/figures the user already had the agent read, so the explanation can build on them
      (ctx ? ("## 论文相关段落\n" + ctx) : "");
    const messages = [{ role: "system", content: sys }];
    for (const m of hist.slice(-8)) if (m && m.role && typeof m.content === "string") messages.push({ role: m.role, content: m.content });
    messages.push({ role: "user", content: "只解释下面这段原文（可参考上下文，但不要评论之前的对话）：\n“" + text + "”" });
    return messages;
  },

  // Non-streaming explain (used by tests / headless paths).
  async explainSelectionText(reader, text) {
    return await this.callLLM(await this._explainMessages(reader, text));
  },

  // Streaming explain: emits deltas via onDelta for the popup's live output.
  async explainSelectionStream(reader, text, onDelta, shouldStop) {
    return await this.callLLMStream(await this._explainMessages(reader, text), onDelta || (() => {}), shouldStop || (() => false));
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
