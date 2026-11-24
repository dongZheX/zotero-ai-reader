/* ui.js — the entire panel UI + rendering layer: panel skeleton/sizing/CSS, the
 * generate/options/model/skill menus, the chat UI (append/actions/history/
 * artifact buttons), message rendering (Markdown+KaTeX, model-drawn SVG, the
 * fallback line renderer, tables/inline), figure vision UI, and the reader
 * selection popup ("quote"/"ask"/"explain"). Also carries the shared UI
 * primitives _el / setStatus / requireKey (DOM factory + status line + key
 * gating), which every module calls via this.*. Loaded LAST after aireader.js;
 * Object.assign onto the global AIReader — pure move out of aireader.js, no
 * behavior change.
 */

Object.assign(AIReader, {
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
      this._closePopMenu(old);
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
    // reading-skill selector: switches the injected method + the quick chips.
    const skillBtn = this._el(doc, "div", "aireader-top-btn aireader-skillbtn", "技能 ▾");
    skillBtn.title = "选择阅读技能：切换方法与下方快捷按钮";
    skillBtn.addEventListener("click", (ev) => { ev.stopPropagation(); this.toggleSkillMenu(body); });
    // Consolidated menus (keeps the row short): 生成 = export/produce actions,
    // 选项 = toggles/modes.
    const genBtn = this._el(doc, "div", "aireader-top-btn aireader-genbtn", "生成 ▾");
    genBtn.title = "存为笔记 / 一页总结 / HTML 分享页 / 全文翻译";
    genBtn.addEventListener("click", (ev) => { ev.stopPropagation(); this.toggleGenMenu(body); });
    const optBtn = this._el(doc, "div", "aireader-top-btn aireader-optbtn", "选项 ▾");
    optBtn.title = "深读模式 / 对比篮子 / 跨论文提问";
    optBtn.addEventListener("click", (ev) => { ev.stopPropagation(); this.toggleOptMenu(body); });
    top.appendChild(agentBtn);
    top.appendChild(skillBtn);
    top.appendChild(genBtn);
    top.appendChild(optBtn);
    // (the button row is appended just above the composer below, not at the top,
    //  so the input area is the visual focus)

    const status = this._el(doc, "div", "aireader-status");
    body.appendChild(status);

    const chatMsgs = this._el(doc, "div", "aireader-chat-msgs");
    body.appendChild(chatMsgs);

    const basketBar = this._el(doc, "div", "aireader-basketbar"); // comparison set, filled by _renderBasket
    basketBar.style.display = "none";
    body.appendChild(basketBar);

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
      genBtn, optBtn, basketBar, basket: [], multiMode: false,
      modelMenu: null, modelList: null, skillMenu: null, popMenu: null, _onDoc: null, _onSkillDoc: null, _onPopDoc: null, streaming: false, cancel: false,
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
      // Several delayed re-measures: when the section is first revealed the panel
      // may not be laid out yet (height 0 / wrong top), so the first pass gets a
      // bad value and — until now — nothing re-ran until the user dragged the
      // sidebar slider (a resize). Catch the late layout with staged retries.
      if (win2 && win2.setTimeout) { win2.setTimeout(size, 50); win2.setTimeout(size, 150); win2.setTimeout(size, 400); }
      if (win2 && win2.addEventListener) { state._onWinResize = size; win2.addEventListener("resize", size); }
      // A ResizeObserver on the CONTAINER (not root — whose height we set, which
      // would loop) re-measures on any layout change: the section expanding from
      // collapsed, the item pane first showing us, or the sidebar being resized.
      // This is what makes the "drag the slider to fix the layout" step unnecessary.
      const RO = win2 && win2.ResizeObserver;
      const container = state.body && state.body.parentNode;
      if (RO && container) {
        try { if (state._ro) state._ro.disconnect(); } catch (e) {}
        state._ro = new RO(() => { if (win2.requestAnimationFrame) win2.requestAnimationFrame(size); else size(); });
        state._ro.observe(container);
      }
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
  // (_skillId / currentSkill / _skillDirective moved to content/prompts.js)
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

  // ---- consolidated 生成 / 选项 dropdowns ----
  // Generic popup anchored to a button; items = {label, desc?, checked?, onClick}.
  _openPopMenu(state, anchor, items) {
    this._closePopMenu(state);
    this.closeModelMenu(state); this.closeSkillMenu(state);
    const doc = state.doc;
    const C = this._menuColors(doc);
    const menu = this._el(doc, "div", "aireader-skillmenu aireader-sharemenu");
    menu.style.cssText += ";background:" + C.bg + ";color:" + C.fg + ";border:1px solid " + C.border + ";font-family:" + this._UIFONT + ";";
    for (const item of items) {
      const it = this._el(doc, "div", "aireader-skillitem");
      const lbl = (item.checked === undefined ? "" : (item.checked ? "☑ " : "☐ ")) + item.label;
      const t = this._el(doc, "div", "aireader-skillitem-t", lbl);
      it.appendChild(t);
      if (item.desc) { const d = this._el(doc, "div", "aireader-skillitem-d", item.desc); d.style.cssText += ";color:" + C.muted + ";font-size:11px;font-weight:400;"; it.appendChild(d); }
      it.style.cssText += ";padding:6px 10px;cursor:pointer;color:" + C.fg + ";font-family:" + this._UIFONT + ";";
      it.addEventListener("mouseenter", () => { it.style.background = C.hover; });
      it.addEventListener("mouseleave", () => { it.style.background = "transparent"; });
      it.addEventListener("click", (ev) => { ev.stopPropagation(); this._closePopMenu(state); item.onClick(); });
      menu.appendChild(it);
    }
    state.popMenu = menu;
    state.body.appendChild(menu);
    this._positionMenu(state, menu, anchor);
    const onDoc = (ev) => { if (state.popMenu && !state.popMenu.contains(ev.target) && ev.target !== anchor) this._closePopMenu(state); };
    state._onPopDoc = onDoc;
    setTimeout(() => doc.addEventListener("click", onDoc), 0);
  },
  _closePopMenu(state) {
    if (!state) return;
    if (state._onPopDoc) { try { state.doc.removeEventListener("click", state._onPopDoc); } catch (e) {} state._onPopDoc = null; }
    if (state.popMenu) { state.popMenu.remove(); state.popMenu = null; }
  },
  toggleGenMenu(body) {
    const state = this._bodyState.get(body);
    if (!state) return;
    if (state.popMenu) { this._closePopMenu(state); return; }
    this._openPopMenu(state, state.genBtn, [
      { label: "存为笔记", desc: "把当前对话存为 Zotero 笔记", onClick: () => this.saveNote(body) },
      { label: "一页总结", desc: "结构化 Markdown，适合存笔记", onClick: () => this.generateShare(state, "onepager") },
      { label: "分享页 ▸", desc: "深度长文 / 可放映幻灯片（内嵌开源 skill）", onClick: () => this._openShareMenu(state) },
      { label: "全文翻译", desc: "双语对照，生成双语笔记/文件", onClick: () => this.generateTranslation(body) },
    ]);
  },
  // Second-level menu: pick a share engine. Two real open-source skills are
  // bundled and driven faithfully — paper-craft (deep illustrated long-form,
  // academic/storytelling/concise voices) and frontend-slides (a true 16:9
  // deck you can present). Remembers the last choice.
  _openShareMenu(state) {
    const cur = this._shareEngineId();
    this._openPopMenu(state, state.genBtn, this._shareEngines().map((e) => ({
      label: (e.id === cur ? "● " : "○ ") + e.label,
      desc: e.desc,
      onClick: () => { try { Zotero.Prefs.set("aireader.shareTheme", e.id); } catch (e2) {} this.generateShare(state, e.id); },
    })));
  },
  toggleOptMenu(body) {
    const state = this._bodyState.get(body);
    if (!state) return;
    if (state.popMenu) { this._closePopMenu(state); return; }
    const inBasket = !!(state.attachment && (state.basket || []).some((p) => p.key === state.attachment.key));
    this._openPopMenu(state, state.optBtn, [
      { label: "深读模式", desc: "遍历所有章节、主动读图（更慢更贵）", checked: !!this._deepRead, onClick: () => { this._deepRead = !this._deepRead; this.setStatus(state, "深读模式：" + (this._deepRead ? "开" : "关"), "muted"); } },
      { label: inBasket ? "移出对比篮子" : "加入对比篮子", desc: "把当前论文加入/移出跨论文对比", onClick: () => this._basketToggle(state) },
      { label: "跨论文提问", desc: "提问跨对比篮子里的多篇论文综合作答", checked: !!state.multiMode, onClick: () => this._toggleMulti(state) },
    ]);
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
      this._renderBasket(state); // reflect comparison-basket state for this paper
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


  // systemPrompt / _customPrompt / _styleGuide moved to content/prompts.js

  // ---------------------------------------------------------------- chat UI
  renderChatHistory(state, hist) {
    state.chatMsgs.textContent = "";
    let lastUser = "";
    for (const m of hist) {
      if (m.role === "user") { this.appendUserMsg(state, m.content); lastUser = m.content; }
      else {
        const { msg, bubble } = this.appendAssistantMsg(state);
        this.enhanceMessage(state, bubble, m.content);
        // Artifact turns (share HTML / translation / one-pager / annotate) carry a
        // persisted `artifact` so the record + its "open" button survive a restart.
        if (m.artifact) this._renderArtifactButton(state, msg, m.artifact);
        else this.addAssistantActions(state, msg, m.content, lastUser);
      }
    }
  },

  // Persist a produced artifact (share page / translation / summary / annotation
  // run) as an assistant turn in the saved history so it reappears after a
  // restart and syncs across machines. `artifact` is carried verbatim through
  // the JSON-serialized history (local + synced note).
  _persistArtifact(state, content, artifact) {
    try {
      const key = state.attachment && state.attachment.key;
      if (!key) return;
      let hist = this._chatStore.get(key);
      if (!hist) { hist = []; this._chatStore.set(key, hist); }
      const entry = { role: "assistant", content: content };
      if (artifact) entry.artifact = artifact;
      hist.push(entry);
      this.saveChat(state.attachment, hist).catch(() => {});
    } catch (e) { this.log("persistArtifact: " + e); }
  },
  // Rebuild an artifact's "open" action from the persisted record (on reload).
  _renderArtifactButton(state, msg, artifact) {
    try {
      const doc = state.doc;
      const row = this._el(doc, "div", "aireader-actions"); msg.appendChild(row);
      const a = this._el(doc, "span", "aireader-action", artifact.label || "打开"); row.appendChild(a);
      a.addEventListener("click", async () => {
        try {
          // 1) try the synced attachment; 2) fall back to the stored file path;
          // 3) last resort — re-materialize nothing, just report the path.
          let opened = false;
          if (artifact.kind === "attachment" && artifact.key) {
            const libID = (state.attachment && state.attachment.libraryID) || Zotero.Libraries.userLibraryID;
            const it = Zotero.Items.getByLibraryAndKey(libID, artifact.key);
            if (it) { let p = null; try { p = it.getFilePath && it.getFilePath(); } catch (e) {} if (p && this._openFile(p)) opened = true; }
          }
          if (!opened && artifact.path) opened = this._openFile(artifact.path);
          if (!opened) this.setStatus(state, "打不开分享文件（可能已被删除）。" + (artifact.path ? "路径：" + artifact.path : ""), "muted");
        } catch (e) { this.log("open artifact: " + e); }
      });
    } catch (e) { this.log("renderArtifactButton: " + e); }
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
      // Fenced code block: ```[lang] … ``` — collect verbatim into a <pre> so the
      // fence markers never leak as literal text (this fallback runs when the full
      // Markdown renderer threw; without this, ``` lines show raw).
      if (/^(```|~~~)/.test(trimmed)) {
        ul = null;
        const fence = trimmed.slice(0, 3);
        const buf = [];
        let j = i + 1;
        for (; j < lines.length; j++) { if (lines[j].trim().startsWith(fence)) break; buf.push(lines[j]); }
        const pre = this._el(doc, "pre", "aireader-md-pre");
        pre.appendChild(this._el(doc, "code", "", buf.join("\n")));
        bubble.appendChild(pre);
        i = (j < lines.length) ? j : lines.length; // skip the closing fence (or to EOF if unterminated)
        continue;
      }
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
          // A block is navigable if it has a geometric position (PDF) OR any text
          // we can full-text-search to (snapshot/EPUB/HTML). Don't depend on the
          // `anchor` flag — blocks cached by an older build won't have it.
          if (!block) continue;
          const canFind = !block.position && (block.query || (block.text && block.text.trim()));
          if (!block.position && !canFind) continue;
          if (any) container.appendChild(doc.createTextNode(" "));
          const label = block.position ? ("p" + block.pageLabel) : "🔗 原文";
          const badge = this._el(doc, "a", "aireader-ref", label);
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


  // _multiSystemPrompt moved to content/prompts.js



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
});
