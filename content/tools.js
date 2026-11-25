/* tools.js — the agent's capabilities: native tool-calling plumbing (tool
 * declarations/schemas, the tool-call loop _runToolCalls/_execTool, tool-turn
 * message shaping, and the live tool-bubble rendering), the web tools
 * (webSearch/webFetch + HTML→text), and scholarly discovery over free APIs
 * (Semantic Scholar citation graph + Serper). Loaded after aireader.js;
 * Object.assign onto the global AIReader — pure move out of aireader.js, no
 * behavior change. Methods still call this.* siblings in the core.
 * (The banner below is carried over verbatim; the read-&-annotate agent that
 * once shared this section now lives in content/annotate.js.)
 */

Object.assign(AIReader, {
  // ----------------------------------------------- agentic read & annotate
  // Neutral tool declarations (JSON-Schema); shaped per API format by _toolSchemas.
  // Capability-gated tool set. opts (each default true) comes from the document's
  // caps + extracted structure, NOT guessed here:
  //   sections — _buildSections found readable sections (always true once text exists)
  //   figures  — caps.regions: can render a figure region to an image (PDF only)
  //   annotate — caps.annotate: can highlight a region in the doc (PDF only)
  // Position-less docs (HTML/EPUB/snapshot) drop the tools they can't honour so
  // the model never calls a dead tool or re-reads already-injected text.
  _agentTools(opts) {
    const o = opts || {};
    const sections = o.sections !== false, figures = o.figures !== false, annotate = o.annotate !== false;
    const T = [];
    if (sections) {
      T.push(
        { name: "list_sections", description: "列出论文的章节大纲（标题、页码、句子数）。先调用它了解结构。", parameters: { type: "object", properties: {}, required: [] } },
        { name: "read_section", description: "读取某一章节的全部句子，返回每句的 id、页码、文本。index 来自 list_sections。", parameters: { type: "object", properties: { index: { type: "integer", description: "章节序号" } }, required: ["index"] } },
      );
    }
    if (annotate) {
      T.push({ name: "highlight", description: "在 PDF 里高亮某一句并加一句话批注。id 必须来自 read_section 返回的 id。", parameters: { type: "object", properties: { id: { type: "integer" }, category: { type: "string", enum: ["contribution", "method", "result", "limitation", "keyterm"] }, reason: { type: "string", description: "一句话理由（作为批注）" } }, required: ["id", "category"] } });
    }
    if (figures) {
      T.push(
        { name: "list_figures", description: "列出论文中的图/表（id、页码、标题）。想看某张图就先用它找到 id。", parameters: { type: "object", properties: {}, required: [] } },
        { name: "view_figure", description: "查看某张图/表的视觉内容：渲染该区域并用多模态模型识读，返回图的文字描述。id 来自 list_figures。", parameters: { type: "object", properties: { id: { type: "integer" } }, required: ["id"] } },
      );
    }
    // Web search needs a Serper key; only offer it when one is configured so the
    // model doesn't waste turns calling a tool it can't use.
    if ((this.getPref("serperKey") || "").trim()) {
      T.push({ name: "web_search", description: "联网搜索（Google via Serper）。当论文之外的背景、最新进展、术语定义、相关工作需要外部信息时使用。返回标题、链接、摘要。", parameters: { type: "object", properties: { query: { type: "string", description: "搜索关键词" }, num: { type: "integer", description: "返回条数，默认 6，最多 10" } }, required: ["query"] } });
    }
    T.push({ name: "web_fetch", description: "抓取某个网页 URL 并返回其正文文本（已去除导航/脚本）。常配合 web_search 使用：先搜索拿到链接，再抓取需要细读的页面。", parameters: { type: "object", properties: { url: { type: "string", description: "http(s) 网址" } }, required: ["url"] } });
    // Scholarly discovery (free APIs, no key needed): look up a paper, trace its
    // references, and find related / follow-up work via the citation graph.
    T.push({ name: "lookup_paper", description: "按标题/DOI/arXiv id/主题查一篇论文的元数据（标题、作者、年份、venue、被引数、摘要、链接）。query 留空=当前论文。用于确认某篇论文是什么、或找某主题的代表作。", parameters: { type: "object", properties: { query: { type: "string", description: "论文标题 / DOI / arXiv id / 主题关键词；留空=当前论文" } }, required: [] } });
    T.push({ name: "find_references", description: "列出一篇论文引用了哪些工作（参考文献）。query 留空=当前论文。用于回答『这篇基于哪些工作』『某条引用的原文是什么』。", parameters: { type: "object", properties: { query: { type: "string", description: "论文标题/DOI/arXiv；留空=当前论文" } }, required: [] } });
    T.push({ name: "related_papers", description: "找与某篇论文相关的工作，以及后续引用了它的新工作。query 留空=当前论文。用于『有哪些相关/后续研究』。", parameters: { type: "object", properties: { query: { type: "string", description: "论文标题/DOI/arXiv；留空=当前论文" } }, required: [] } });
    T.push({ name: "finish", description: "读完并标注完后调用，结束。", parameters: { type: "object", properties: { note: { type: "string" } }, required: [] } });
    return T;
  },
  // Shape a neutral tool list ({name,description,parameters}) into one API
  // format. Shared by _toolSchemas (read&annotate agent) and the share agent.
  _shapeTools(fmt, T) {
    if (fmt === "anthropic") return T.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters }));
    if (fmt === "responses") return T.map((t) => ({ type: "function", name: t.name, description: t.description, parameters: t.parameters }));
    return T.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } }));
  },
  _toolSchemas(fmt, opts) { return this._shapeTools(fmt, this._agentTools(opts)); },
  // Anthropic reads the longest cached *prefix*. A breakpoint on the system
  // block alone caches only the paper/system — the growing conversation is
  // re-read uncached every turn. Add a second, rolling breakpoint on the last
  // message so each turn caches the conversation so far; the next turn hits it
  // and only the new delta is written (incremental multi-turn caching).
  // Clone so we never persist cache_control back into the live history.
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
  // A tool's `output` is normally a JSON/text STRING. For multimodal tools it
  // may instead be `{ text, images:[dataURI] }` so the model can SEE the result
  // (e.g. render_preview returns the real rendered screenshot). Anthropic takes
  // image blocks natively inside tool_result.content (verified: Sonnet reads
  // them); chat/responses tool messages are text-only, so there we degrade to
  // the text part. Plain-string outputs are passed through unchanged.
  _toolResultAnthropic(out) {
    if (!out || typeof out !== "object" || !Array.isArray(out.images)) return out; // plain string
    const arr = [];
    if (out.text) arr.push({ type: "text", text: String(out.text) });
    for (const uri of out.images) {
      const m = /^data:(image\/[a-z.+-]+);base64,([\s\S]*)$/i.exec(String(uri || ""));
      if (m) arr.push({ type: "image", source: { type: "base64", media_type: m[1], data: m[2] } });
    }
    return arr.length ? arr : (out.text || "（已生成截图，但无法内联）");
  },
  _toolResultText(out) {
    if (!out || typeof out !== "object" || !Array.isArray(out.images)) return out; // plain string
    return out.text || "（已生成截图；当前 API 格式不支持在工具结果里回传图片）";
  },
  _pushToolResults(fmt, messages, results) {
    if (fmt === "anthropic") { messages.push({ role: "user", content: results.map((r) => ({ type: "tool_result", tool_use_id: r.id, content: this._toolResultAnthropic(r.output) })) }); return; }
    if (fmt === "responses") { for (const r of results) messages.push({ type: "function_call_output", call_id: r.id, output: this._toolResultText(r.output) }); return; }
    for (const r of results) messages.push({ role: "tool", tool_call_id: r.id, content: this._toolResultText(r.output) });
  },

  // Group blocks into sections by preceding heading. index == array position.
  // Text blocks WITHOUT a position are kept (HTML/web-snapshot/EPUB attachments
  // have no page geometry but their text is still readable + navigable by anchor);
  // only truly text-less blocks and image/math blocks are skipped. read_section
  // works off text, and snapshot navigation jumps by text anchor — neither needs
  // page rects — so a position-less doc now yields real, readable sections.
  _buildSections(blocks) {
    const sections = []; let cur = null;
    const start = (title, page) => { cur = { index: 0, title, page, blockIds: [] }; sections.push(cur); };
    for (const b of blocks || []) {
      if (b.type === "heading") { start((b.text || "（无标题）").slice(0, 80), b.pageLabel); continue; }
      if (b.type === "image" || b.type === "math") continue;
      if (!b.text) continue;
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
    const RO = new Set(["list_sections", "read_section", "list_figures", "view_figure", "web_search", "web_fetch", "lookup_paper", "find_references", "related_papers"]);
    // The share agent supplies its own executor (write_unit/render_preview/
    // finalize) via c.execTool; those side-effecting tools stay out of RO so
    // they run serially & in order (so write_unit lands before its render_preview).
    const exec = (c && c.execTool) || this._execTool;
    const limit = Math.max(1, parseInt(this.getPref("maxParallelTools"), 10) || 3);
    const slots = new Array(calls.length);
    const run1 = async (i) => {
      // Once the user hits stop, don't launch any further tool calls (the one
      // already in flight will still finish — aborting mid-request would need a
      // signal threaded through the whole network layer).
      if (state && state.cancel) { slots[i] = { output: JSON.stringify({ error: "已取消" }), render: { label: calls[i].name, outcome: "✕ 已取消" } }; return; }
      try { slots[i] = await exec.call(this, state, c, calls[i]); }
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
      const r = await this._docReader(state.attachment).annotate(state.attachment, b, { type: "highlight", comment: args.reason || "", color: this.colorForCategory(cat) });
      c.run.keys.push(r.key); c.run.applied.push({ key: r.key, category: cat, blockId: b.id, pageLabel: b.pageLabel, comment: args.reason || "", color: this.colorForCategory(cat) });
      c.tally[cat] = (c.tally[cat] || 0) + 1;
      return { output: JSON.stringify({ ok: true, key: r.key }), render: { label: "高亮", cat, brief: (this.CATEGORY_LABELS[cat] || cat) + (args.reason ? " · " + args.reason : ""), outcome: "p" + b.pageLabel, jumpId: b.id } };
    }
    if (name === "list_figures") {
      const figs = this._docReader(state.attachment).figuresIn(state.blocks); // [] for position-less docs (Null Object)
      return { output: JSON.stringify(figs.map((f) => ({ id: f.id, page: f.pageLabel, kind: this.figKind(f.type), caption: (f.text || "").slice(0, 80) }))),
        render: { label: "列出图表", outcome: "→ " + figs.length + " 个", bodyText: figs.map((f) => "[B" + f.id + " p" + f.pageLabel + "] " + this.figKind(f.type) + (f.text ? ": " + f.text.slice(0, 60) : "")).join("\n") || "（无图表）" } };
    }
    if (name === "view_figure") {
      const b = c.byId.get(args.id);
      if (!b || !b.position) return { output: JSON.stringify({ error: "no such figure id " + args.id }), render: { label: "看图", brief: "id " + args.id, outcome: "✕ 无此图" } };
      try {
        const dataURI = await this._docReader(state.attachment).renderRegion(state.attachment, b);
        if (!dataURI) return { output: JSON.stringify({ error: "this document has no renderable figure regions" }), render: { label: "看图", brief: "id " + args.id, outcome: "✕ 不支持" } };
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
    if (name === "lookup_paper") {
      const label = "查论文", brief = (args.query || "当前论文");
      try { const r = await this.scholarLookup(state, args.query); const list = r.results || [];
        return { output: JSON.stringify(list), render: { label, brief, outcome: "→ " + list.length + " 条", bodyText: this._fmtPaperList(list) } };
      } catch (e) { return { output: JSON.stringify({ error: String(e.message || e) }), render: { label, brief, outcome: "✕ 失败" } }; }
    }
    if (name === "find_references") {
      const label = "找参考文献", brief = (args.query || "当前论文");
      try { const list = await this.scholarReferences(state, args.query);
        return { output: JSON.stringify(list), render: { label, brief, outcome: "→ " + list.length + " 条", bodyText: this._fmtPaperList(list) } };
      } catch (e) { return { output: JSON.stringify({ error: String(e.message || e) }), render: { label, brief, outcome: "✕ 失败" } }; }
    }
    if (name === "related_papers") {
      const label = "相关论文", brief = (args.query || "当前论文");
      try { const r = await this.scholarRelated(state, args.query);
        const body = "【相关】\n" + this._fmtPaperList(r.related) + "\n\n【后续引用】\n" + this._fmtPaperList(r.citedBy);
        return { output: JSON.stringify(r), render: { label, brief, outcome: "→ " + (r.related.length + r.citedBy.length) + " 条", bodyText: body } };
      } catch (e) { return { output: JSON.stringify({ error: String(e.message || e) }), render: { label, brief, outcome: "✕ 失败" } }; }
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

  // ---- scholarly discovery (references + related work) via free APIs ----
  // Semantic Scholar (keyless) for the citation graph; Google Scholar via the
  // user's existing Serper key for keyword search. Results are kept small and
  // errors are soft (S2's anonymous pool throttles under load) so the model can
  // fall back instead of hard-failing.
  _scholarCache(key) { if (!this._scholarStore) this._scholarStore = new Map(); if (!this._scholarStore.has(key)) this._scholarStore.set(key, {}); return this._scholarStore.get(key); },
  _s2Fields: "title,authors,year,venue,citationCount,externalIds,url",
  _currentPaperMeta(state) {
    let it = state && state.item;
    try { if (it && it.isAttachment && it.isAttachment() && it.parentItem) it = it.parentItem; } catch (e) {}
    const get = (f) => { try { return (it && it.getField && it.getField(f)) || ""; } catch (e) { return ""; } };
    const title = get("title");
    const doi = (get("DOI") || "").trim();
    const am = /arxiv[:/ ]?\s*(\d{4}\.\d{4,5})/i.exec((get("extra") || "") + " " + (get("url") || ""));
    return { title, doi, arxiv: am ? am[1] : "" };
  },
  async _s2Get(path) {
    const resp = await this._fetchLLM("https://api.semanticscholar.org" + path, { method: "GET", headers: { Accept: "application/json" } }, { timeoutMs: 20000, retries: 1 });
    if (resp.status === 429 || resp.status === 503) throw new Error("Semantic Scholar 暂时限流，稍后再试");
    if (!resp.ok) throw new Error("Semantic Scholar HTTP " + resp.status);
    return this._parseOrThrow(await resp.text());
  },
  _normS2(p) {
    if (!p) return null;
    const ids = p.externalIds || {};
    return { title: p.title || "(无标题)", authors: (p.authors || []).map((a) => a && a.name).filter(Boolean), year: p.year || null, venue: p.venue || "", citations: p.citationCount != null ? p.citationCount : null, doi: ids.DOI || "", arxiv: ids.ArXiv || "", url: (ids.ArXiv ? "https://arxiv.org/abs/" + ids.ArXiv : (p.url || (ids.DOI ? "https://doi.org/" + ids.DOI : ""))), abstract: p.abstract || "" };
  },
  // Turn a query/DOI/arXiv into an id the S2 graph endpoints accept (DOI:… /
  // ARXIV:… pass straight through; a title is matched to its paperId).
  async _s2ResolveId(q) {
    q = (q || "").trim();
    if (/^10\.\d{4,9}\//.test(q) || /doi\.org\//i.test(q)) return "DOI:" + q.replace(/^.*doi\.org\//i, "").trim();
    const am = /(\d{4}\.\d{4,5})(v\d+)?$/.exec(q);
    if (/arxiv/i.test(q) && am) return "ARXIV:" + am[1];
    const j = await this._s2Get("/graph/v1/paper/search/match?query=" + encodeURIComponent(q) + "&fields=title");
    const hit = j && j.data && j.data[0];
    if (!hit || !hit.paperId) throw new Error("没有找到匹配的论文：" + q);
    return hit.paperId;
  },
  async _paperIdFor(state, query) {
    const q = (query || "").trim();
    if (q) return await this._s2ResolveId(q);
    const key = state && state.attachment && state.attachment.key;
    const cache = key ? this._scholarCache(key) : {};
    if (cache.id) return cache.id;
    const meta = this._currentPaperMeta(state);
    const seed = meta.doi || (meta.arxiv ? "arxiv:" + meta.arxiv : meta.title);
    if (!seed) throw new Error("无法确定当前论文（缺少标题/DOI）");
    const id = await this._s2ResolveId(seed);
    if (key) cache.id = id;
    return id;
  },
  async _scholarSearchSerper(query, num) {
    const key = (this.getPref("serperKey") || "").trim();
    if (!key) throw new Error("未配置 Serper Key");
    const n = Math.max(1, Math.min(20, num || 10));
    const resp = await this._fetchLLM("https://google.serper.dev/scholar", { method: "POST", headers: { "X-API-KEY": key, "Content-Type": "application/json" }, body: JSON.stringify({ q: query, num: n }) }, { timeoutMs: 20000, retries: 1 });
    if (!resp.ok) throw new Error("Serper HTTP " + resp.status);
    const data = this._parseOrThrow(await resp.text());
    return (data.organic || []).map((r) => ({ title: r.title || "", url: r.link || "", year: r.year || null, citations: r.citedBy != null ? r.citedBy : null, pdf: r.pdfUrl || "", info: r.publicationInfo || "", abstract: r.snippet || "", authors: [] }));
  },
  async scholarLookup(state, query) {
    const q = (query || "").trim() || this._currentPaperMeta(state).title;
    if (!q) throw new Error("没有可查的论文（请给标题/DOI/arXiv，或先选中一篇论文）");
    const hasKey = !!(this.getPref("serperKey") || "").trim();
    const isId = /^10\.\d{4,9}\//.test(q) || /arxiv/i.test(q);
    if (hasKey && !isId) return { source: "scholar", results: await this._scholarSearchSerper(q, 8) };
    const j = await this._s2Get("/graph/v1/paper/search?query=" + encodeURIComponent(q) + "&limit=8&fields=" + this._s2Fields + ",abstract");
    return { source: "s2", results: (j.data || []).map((p) => this._normS2(p)).filter(Boolean) };
  },
  async scholarReferences(state, query) {
    const id = await this._paperIdFor(state, query);
    const j = await this._s2Get("/graph/v1/paper/" + encodeURIComponent(id) + "/references?limit=25&fields=" + this._s2Fields);
    return (j.data || []).map((d) => this._normS2(d.citedPaper)).filter(Boolean);
  },
  async scholarRelated(state, query) {
    const id = await this._paperIdFor(state, query);
    let related = [], citedBy = [];
    try { const r = await this._s2Get("/recommendations/v1/papers/forpaper/" + encodeURIComponent(id) + "?limit=12&fields=" + this._s2Fields); related = (r.recommendedPapers || []).map((p) => this._normS2(p)).filter(Boolean); } catch (e) { this.log("related recs: " + e); }
    try { const c = await this._s2Get("/graph/v1/paper/" + encodeURIComponent(id) + "/citations?limit=15&fields=" + this._s2Fields); citedBy = (c.data || []).map((d) => this._normS2(d.citingPaper)).filter(Boolean); } catch (e) { this.log("related cites: " + e); }
    if (!related.length && !citedBy.length) throw new Error("没有找到相关/后续论文");
    return { related, citedBy };
  },
  _fmtPaperList(list) {
    if (!list || !list.length) return "（无结果）";
    return list.slice(0, 15).map((p, i) => {
      const au = (p.authors || []).slice(0, 3).join(", ") + ((p.authors || []).length > 3 ? " 等" : "");
      const meta = [au, p.year, p.venue, p.info].filter(Boolean).join(" · ");
      const cite = p.citations != null ? "  被引 " + p.citations : "";
      const link = p.url || p.pdf || (p.doi ? "https://doi.org/" + p.doi : "");
      return (i + 1) + ". " + (p.title || "") + (meta ? "\n   " + meta : "") + cite + (link ? "\n   " + link : "");
    }).join("\n");
  },

});
