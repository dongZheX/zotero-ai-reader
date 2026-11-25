/* docreader.js — one place that answers "what can we do with THIS document?".
 *
 * The plugin supports several reading types (PDF, web-snapshot/HTML, EPUB, plain
 * text). They differ in ONE structural fact: PDFs have page geometry
 * (block.position.rects), the rest don't. That single fact gates four
 * capabilities — render a region to an image, annotate/highlight a region, jump
 * by position, and index figures. Historically every call site re-derived this
 * with an ad-hoc `if (!block.position)`, each choosing a different fate (error /
 * silent skip / crash). This module centralises it:
 *
 *   • Factory    — _docReader(att) picks a strategy from the attachment's type.
 *   • Strategy   — each type is a plain object with the capability methods.
 *   • Null Object— position-less types get safe no-ops (renderRegion→null,
 *                  annotate→throws a clear "unsupported", figuresIn→[]), so
 *                  callers never branch on document type.
 *   • Capabilities (caps) — a frozen traits object the UI / agents consult to
 *                  show/hide features and gate tools, instead of guessing.
 *
 * Mental model is Bridge: reading FEATURES (chat / annotate / share) only call
 * reader.xxx() / consult caps; they never test contentType. Add a new doc type
 * here (one entry), not across the feature code.
 */

Object.assign(AIReader, {
  _DOC_CAPS: {
    pdf:  { kind: "pdf",  label: "PDF",   text: true, regions: true,  annotate: true,  navigate: "position" },
    html: { kind: "html", label: "网页快照", text: true, regions: false, annotate: false, navigate: "anchor" },
    epub: { kind: "epub", label: "EPUB",  text: true, regions: false, annotate: false, navigate: "anchor" },
    text: { kind: "text", label: "文本",   text: true, regions: false, annotate: false, navigate: "none" },
  },

  // Factory: contentType → document kind. The one place type is sniffed.
  _docKind(att) {
    let ct = "";
    try { ct = (att && att.attachmentContentType) || ""; } catch (e) {}
    if (/pdf/i.test(ct)) return "pdf";
    if (/html|xhtml/i.test(ct)) return "html";
    if (/epub/i.test(ct)) return "epub";
    return "text";
  },

  _docReaderCache: new Map(), // attachment.key -> reader strategy

  // Factory → Strategy (+ Null Object for position-less kinds). Cached per key.
  _docReader(att) {
    const key = att && att.key;
    if (key && this._docReaderCache.has(key)) return this._docReaderCache.get(key);
    const kind = this._docKind(att);
    const caps = Object.freeze(this._DOC_CAPS[kind] || this._DOC_CAPS.text);
    const self = this;
    const reader = caps.regions
      ? { // PDF strategy — delegates to the geometry-backed primitives
          kind, caps,
          renderRegion: (a, b) => self.renderRegionDataURI(a, b),
          annotate: (a, b, info) => self.applyAnnotation(a, b, info),
          figuresIn: (blocks) => (blocks || []).filter((x) => (x.type === "image" || x.type === "table") && x.position),
        }
      : { // Null Object — position-less docs: safe no-ops, no scattered ifs
          kind, caps,
          renderRegion: async () => null,
          annotate: async () => { throw new Error("此文档类型（" + caps.label + "）没有页面坐标，无法在原文上做区域标注"); },
          figuresIn: () => [],
        };
    if (key) this._docReaderCache.set(key, reader);
    return reader;
  },

  _docCaps(att) { return this._docReader(att).caps; },
});
