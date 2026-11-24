/* blocks.js — document block model (PDF/HTML/EPUB extraction, sentence/leaf
 * segmentation, search anchors, figure indexing), the context builders fed to
 * the LLM (full / char-bounded / retrieval-ranked), and snapshot/non-PDF
 * navigation (text-position jump into the reader). Loaded after aireader.js;
 * Object.assign onto the global AIReader — pure move out of aireader.js, no
 * behavior change. Methods still call this.* siblings in the core.
 */

Object.assign(AIReader, {
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
    // Web snapshots / HTML attachments aren't PDFs — read the HTML file and turn
    // it into paragraph blocks (no page coords, so cite-only, like the fallback).
    try {
      const it = await Zotero.Items.getAsync(attachmentID);
      const ct = it && it.attachmentContentType;
      if (ct === "text/html" || ct === "application/xhtml+xml") { const b = await this._extractHtmlBlocks(it); if (b && b.length) return b; }
    } catch (e) { this.log("html detect: " + e); }
    if (!Zotero.SDT || typeof Zotero.SDT.getReader !== "function") return this.extractBlocksFallback(attachmentID);
    let reader = null;
    try { reader = await Zotero.SDT.getReader(attachmentID, { isPriority: true }); } catch (e) { this.log("SDT getReader: " + e); }
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

  // Read an HTML snapshot / HTML attachment → paragraph blocks. Prefers the
  // on-disk file (most reliable), falls back to Zotero's indexed attachmentText.
  async _extractHtmlBlocks(item) {
    let fp = "";
    try { fp = (item.getFilePath && item.getFilePath()) || ""; } catch (e) {}
    let text = "";
    // 1) Zotero's own clean full-text cache sits next to the snapshot file
    //    (.zotero-ft-cache) — small, markup/JS already stripped. Far more reliable
    //    than stripping a 3-4 MB inlined web snapshot ourselves.
    if (fp) { try { const cache = PathUtils.join(PathUtils.parent(fp), ".zotero-ft-cache"); if (await IOUtils.exists(cache)) text = await IOUtils.readUTF8(cache); } catch (e) { this.log("ft-cache: " + e); } }
    // 2) the indexed attachmentText getter (also backed by that cache)
    if (!text.trim()) { try { text = (await item.attachmentText) || ""; } catch (e) {} }
    // 3) last resort: strip the raw HTML file (guarded + size-capped)
    if (!text.trim() && fp) {
      try { if (await IOUtils.exists(fp)) { let raw = await IOUtils.readUTF8(fp); if (raw.length > 4000000) raw = raw.slice(0, 4000000); text = this._htmlToText(raw) || ""; } } catch (e) { this.log("strip snapshot: " + e); }
    }
    if (!text || !text.trim()) return null;
    const paras = text.split(/\n\s*\n|\n/).map((t) => t.replace(/[ \t ]+/g, " ").trim()).filter((t) => t.length > 1);
    let id = 0;
    // Snapshots/HTML have no page geometry, so there's no PDF-style position to
    // jump to. Keep a distinctive text anchor per block instead; citations open
    // the snapshot and full-text-search to it (see navigateTo). `anchor:true`
    // lets the renderer draw a clickable badge even though position==null.
    return paras.map((t) => {
      const body = t.length > 2000 ? t.slice(0, 2000) + "…" : t;
      return { id: id++, type: "paragraph", text: body, position: null, anchor: true, query: this._searchAnchor(t), pageLabel: "", pageHeight: 792 };
    });
  },

  // A contiguous, distinctive substring of a block, used to full-text-search a
  // snapshot/EPUB to the right spot. Collapse whitespace and take the first
  // ~80 chars on a word boundary — long enough to be unique, short enough that
  // the ft-cache text and the live DOM text still match it verbatim.
  _searchAnchor(t) {
    const s = String(t || "").replace(/\s+/g, " ").trim();
    if (!s) return "";
    if (s.length <= 80) return s;
    let cut = s.slice(0, 80);
    const sp = cut.lastIndexOf(" ");
    if (sp > 40) cut = cut.slice(0, sp);
    return cut;
  },

  async extractBlocksFallback(attachmentID) {
    const item = await Zotero.Items.getAsync(attachmentID);
    let text = "";
    try { text = await item.attachmentText; } catch (e) {}
    if (!text) { try { const r = await Zotero.PDFWorker.getFullText(attachmentID, null); text = r && r.text; } catch (e) {} }
    if (!text) return null;
    const paras = text.split(/\n\s*\n|\f/).map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean);
    let id = 0;
    return paras.map((t) => {
      const body = t.length > 2000 ? t.slice(0, 2000) + "…" : t;
      return { id: id++, type: "paragraph", text: body, position: null, anchor: true, query: this._searchAnchor(t), pageLabel: "", pageHeight: 792 };
    });
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

  // -------------------------------------- snapshot / non-PDF navigation
  async navigateTo(attachmentID, block) {
    if (!block) return;
    try {
      // PDF: precise geometric jump.
      if (block.position) { await Zotero.Reader.open(attachmentID, { position: block.position }); return; }
      // Snapshot/EPUB/HTML: no geometry. Jump by text, using only PUBLIC reader
      // APIs — open the reader, then drive `reader.navigate({position})` with a
      // TextPositionSelector (Zotero's own annotation-position format, which its
      // navigate() scrolls to and does the cross-compartment marshalling for us).
      // Works for any positionless block with text, not just `anchor`-flagged ones.
      const q = block.query || this._searchAnchor(block.text);
      if (!q) return;
      let reader = await Zotero.Reader.open(attachmentID);
      // open() returns undefined when it just re-selected an already-open tab;
      // recover the live reader instance (public getByTabID) so we can drive it.
      if (!reader) reader = this._findOpenReader(attachmentID);
      if (!reader) return;
      try { if (reader._initPromise) await reader._initPromise; } catch (e) {}
      const ok = this._snapshotJump(reader, q);
      // The content may not be laid out yet right after open — retry once.
      if (!ok) { try { (reader._window || Zotero.getMainWindow()).setTimeout(() => this._snapshotJump(reader, q), 450); } catch (e) {} }
    } catch (e) { this.log("navigate error: " + e); }
  },

  // Locate an already-open reader instance for an attachment via the PUBLIC
  // Zotero.Reader.getByTabID + the window's tab registry.
  _findOpenReader(attachmentID) {
    try {
      const R = Zotero.Reader;
      if (R && typeof R.getByTabID === "function" && Zotero.getMainWindow) {
        const tabs = Zotero.getMainWindow().Zotero_Tabs;
        const tabID = tabs && tabs.getTabIDByItemID && tabs.getTabIDByItemID(attachmentID);
        if (tabID) { const r = R.getByTabID(tabID); if (r) return r; }
      }
    } catch (e) { this.log("findOpenReader: " + e); }
    return null;
  },

  // Scroll a snapshot/EPUB/HTML reader to `query` using the PUBLIC
  // `reader.navigate({ position })`. Zotero exposes no public text-search API, so
  // we build a TextPositionSelector — its `start`/`end` are offsets into the
  // concatenated text nodes of the rendered body (what Zotero's own
  // textPositionToRange counts). Computing them is the one place we must read the
  // rendered document; that read is isolated in `_readerContentDoc` (feature-
  // detected, with a fallback) and nothing else here touches reader internals.
  // Returns false (→ caller retries) if the doc or the text can't be resolved.
  _snapshotJump(reader, query) {
    try {
      const doc = this._readerContentDoc(reader);
      if (!doc || !doc.body) { this.log("snapshotJump: no content doc"); return false; }
      const sel = this._textPositionFor(doc.body, query);
      if (!sel) { this.log("snapshotJump: text not found"); return false; }
      reader.navigate({ position: sel }); // PUBLIC API; navigate() does its own cloneInto
      return true;
    } catch (e) { this.log("snapshotJump: " + e); return false; }
  },

  // The one place that reads the reader's rendered document (to compute a text
  // offset). Isolated + feature-detected: tries the primary view's document,
  // then a nested content iframe reachable from the reader window. Returns null
  // if neither is available (caller degrades gracefully).
  _readerContentDoc(reader) {
    try {
      const ir = reader && reader._internalReader;
      const pv = ir && (ir._primaryView || (typeof ir._getActiveView === "function" && ir._getActiveView()));
      if (pv && pv._iframeDocument && pv._iframeDocument.body) return pv._iframeDocument;
      const rw = reader && reader._iframeWindow;
      const inner = rw && rw.document && rw.document.querySelector && rw.document.querySelector("iframe");
      if (inner && inner.contentDocument && inner.contentDocument.body) return inner.contentDocument;
    } catch (e) { this.log("contentDoc: " + e); }
    return null;
  },

  // Build a TextPositionSelector { start, end } locating `query` in bodyEl's
  // concatenated text-node content (the exact text Zotero's textPositionToRange
  // walks). Exact match first; else a whitespace-insensitive match that maps the
  // collapsed hit back to raw offsets, so English text whose DOM spacing differs
  // from the stored anchor still resolves. Pure — unit-tested in test/snapshot.js.
  _textPositionFor(bodyEl, query) {
    const raw = (bodyEl && bodyEl.textContent) || "";
    const q = String(query || "").trim();
    if (!q || !raw) return null;
    let start = raw.indexOf(q);
    if (start >= 0) return { type: "TextPositionSelector", start: start, end: start + q.length };
    // whitespace-insensitive fallback: collapse runs of whitespace to one space,
    // remembering each kept char's raw index, then map the collapsed hit back.
    let norm = "", prevWs = false; const map = [];
    for (let i = 0; i < raw.length; i++) {
      const c = raw[i];
      if (/\s/.test(c)) { if (prevWs) continue; norm += " "; map.push(i); prevWs = true; }
      else { norm += c; map.push(i); prevWs = false; }
    }
    const nq = q.replace(/\s+/g, " ").trim();
    const ni = norm.indexOf(nq);
    if (ni < 0) return null;
    const endNorm = ni + nq.length - 1;
    const endRaw = (map[endNorm] != null ? map[endNorm] : raw.length - 1) + 1;
    return { type: "TextPositionSelector", start: map[ni], end: endRaw };
  },
});
