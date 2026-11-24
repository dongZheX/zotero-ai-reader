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
  BLOCK_CACHE_VERSION: 4,  // bump when the block schema changes so stale disk caches are re-extracted
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

  // Temperature is OPT-IN: only sent when the user entered a value. Empty/blank
  // means "use the model's default" and the field is omitted entirely — some
  // models (OpenAI reasoning models like gpt-5 / o-series on /responses) reject
  // any non-default temperature, so sending our own default would error.

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
    try { this.startDevBridge(); } catch (e) { this.log("devBridge start: " + e); }
  },

  unregisterAll() {
    try { Zotero.ItemPaneManager.unregisterSection("ai-reader-summary"); } catch (e) {}
    try { if (this._prefPaneID) Zotero.PreferencePanes.unregister(this._prefPaneID); } catch (e) {}
    try { if (this._selectionHandler) Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this._selectionHandler); } catch (e) {}
    try { if (this._ctxHandler) { Zotero.Reader.unregisterEventListener("createViewContextMenu", this._ctxHandler); Zotero.Reader.unregisterEventListener("createSelectorContextMenu", this._ctxHandler); } } catch (e) {}
    try { this.stopDevBridge(); } catch (e) {}
  },

  // ---------------------------------------------------------- dev bridge
  // OPT-IN developer tool (pref extensions.zotero.aireader.devBridge, default
  // off). Polls <DataDir>/aireader-dev/cmd.json for { seq, code } and runs the
  // code as an async function body with `this` === AIReader — i.e. in the live
  // plugin scope, with full access to the reader, blocks and DOM — then writes
  // { seq, ok, result|error, logs } to out.json. This gives an external process
  // a real REPL into a running Zotero: inspect state, exercise a feature, and
  // even hot-redefine methods (this.navigateTo = async function(){…}) without
  // reinstalling the xpi. Never touches the network; only this machine's files.
  startDevBridge() {
    if (this._devTimer) return;
    if (!Zotero.Prefs.get("aireader.devBridge")) return;
    const win = Zotero.getMainWindow && Zotero.getMainWindow();
    if (!win || typeof win.setInterval !== "function") { this.log("devBridge: no window timer"); return; }
    const dir = PathUtils.join(Zotero.DataDirectory.dir, "aireader-dev");
    const cmdPath = PathUtils.join(dir, "cmd.json");
    const outPath = PathUtils.join(dir, "out.json");
    this._devWin = win;
    IOUtils.makeDirectory(dir, { ignoreExisting: true }).catch(() => {});
    let lastSeq = -1;
    const tick = async () => {
      let cmd;
      try {
        if (!(await IOUtils.exists(cmdPath))) return;
        cmd = JSON.parse(await IOUtils.readUTF8(cmdPath));
      } catch (e) { return; }
      if (!cmd || typeof cmd.seq !== "number" || cmd.seq === lastSeq) return;
      lastSeq = cmd.seq;
      const logs = [];
      const origLog = this.log;
      this.log = (m) => { try { logs.push(String(m)); } catch (e) {} try { origLog.call(AIReader, m); } catch (e) {} };
      let out;
      try {
        const fn = new Function("Zotero", "PathUtils", "IOUtils", "Services", "log",
          "return (async () => {\n" + String(cmd.code || "") + "\n})();");
        const result = await fn.call(this, Zotero, PathUtils, IOUtils, (typeof Services !== "undefined" ? Services : null), this.log);
        out = { seq: cmd.seq, ok: true, result: this._devSafe(result), logs: logs, ts: Date.now() };
      } catch (e) {
        out = { seq: cmd.seq, ok: false, error: String((e && e.stack) || e), logs: logs, ts: Date.now() };
      } finally {
        this.log = origLog;
      }
      try { await IOUtils.writeUTF8(outPath, JSON.stringify(out)); } catch (e) { origLog.call(AIReader, "devBridge write: " + e); }
    };
    this._devTimer = win.setInterval(() => { tick().catch(() => {}); }, 500);
    this.log("devBridge ON → " + dir);
  },
  stopDevBridge() {
    try { if (this._devTimer && this._devWin) this._devWin.clearInterval(this._devTimer); } catch (e) {}
    this._devTimer = null; this._devWin = null;
  },
  // JSON-safe snapshot: drop functions, name DOM nodes, cap depth/size, guard
  // cycles — so whatever dev code returns serializes without throwing.
  _devSafe(v, depth, seen) {
    depth = depth || 0; seen = seen || new WeakSet();
    if (v === null || v === undefined) return v;
    const t = typeof v;
    if (t === "function") return "[fn " + (v.name || "anonymous") + "]";
    if (t !== "object") return (t === "bigint" ? String(v) : v);
    if (v.nodeType && v.nodeName) return "[Node " + v.nodeName + (v.className ? "." + v.className : "") + "]";
    if (seen.has(v)) return "[circular]";
    seen.add(v);
    if (depth > 6) return "[…]";
    if (Array.isArray(v)) return v.slice(0, 500).map((x) => this._devSafe(x, depth + 1, seen));
    const o = {}; let n = 0;
    for (const k in v) {
      if (n++ > 200) { o["…"] = "truncated"; break; }
      let val; try { val = v[k]; } catch (e) { o[k] = "[getter err]"; continue; }
      try { o[k] = this._devSafe(val, depth + 1, seen); } catch (e) { o[k] = "[err]"; }
    }
    return o;
  },

  registerSection() {
    Zotero.ItemPaneManager.registerSection({
      paneID: "ai-reader-summary",
      pluginID: this.id,
      header: { l10nID: "aireader-section-header", icon: this.rootURI + "content/icons/ai16.svg" },
      sidenav: { l10nID: "aireader-section-sidenav", icon: this.rootURI + "content/icons/ai20.svg" },
      // Settings button lives in the section header row (next to the collapse
      // chevron) via Zotero's native sectionButtons API.
      sectionButtons: [{
        type: "ai-reader-settings",
        icon: this.rootURI + "content/icons/gear.svg",
        l10nID: "aireader-section-settings",
        onClick: () => { try { Zotero.Utilities.Internal.openPreferences(AIReader._prefPaneID); } catch (e) { AIReader.log("openPreferences: " + e); } },
      }],
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


};
