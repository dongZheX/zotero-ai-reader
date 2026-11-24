# AI Reader — developer notes

A Zotero 7/8/10/11 bootstrap plugin. The item-pane section lives in
`content/aireader.js` (one big `AIReader` object), styled by `content/style.css`.
Tests are a headless Node simulation in `test/sim.js`.

## Workflow (read before committing)

- **Release only after the user says OK.** Between confirmations: run tests and
  rebuild the `.xpi` with the version **unchanged**; do not bump the version and
  do not push. Only when the user confirms do you bump `manifest.json`, commit,
  and push. Version releases go directly to `main`.
- **Tests must pass.** `node test/sim.js` must print `ALL OK`. Add assertions
  there for any new behavior — it's the only automated safety net.
- **Scan for secrets before every commit.** Never commit an API key / AK-SK.
  ```bash
  grep -rnEi "sk-[A-Za-z0-9]{20,}" . --exclude-dir=.git   # + any internal gateway key fragments
  ```
- **Build the xpi:**
  ```bash
  zip -r -q ai-reader.xpi manifest.json bootstrap.js prefs.js content locale
  ```
- **Syntax check:** `node --check content/aireader.js`.

## Pitfalls hit during development (don't relearn these)

### Zotero environment

- **XUL namespace → garbled text ("乱码").** The Zotero 7 main window is a XUL
  document, so `doc.createElement("div")` makes a *XUL* element that renders text
  with a fallback/icon font → garbage glyphs. Always create HTML via
  `doc.createElementNS("http://www.w3.org/1999/xhtml", tag)`. The `_el` helper
  does this; use it, don't call `createElement` directly.
- **Inside the reader panel, CSS vars can be undefined or an icon font.** The
  model dropdown looked garbled partly for this reason. Pin an explicit UI font
  stack and explicit hex colors inline on menu items (not `var(--…)`).
- **Zotero caches plugin files aggressively.** A reinstall over the top often
  keeps the old JS/CSS. To actually load a new build: fully **Remove** the
  plugin → restart → **Install From File** → restart. (During development we
  kept a visible build stamp in the header to confirm which build was live;
  it has since been removed.) CSS can be cache-busted with `style.css?v=…`.
- **`Zotero.Annotations.saveFromJSON` return type varies across versions** — it
  is not reliably the saved Item. Resolve the item yourself by key:
  `Zotero.Items.getByLibraryAndKey(libraryID, key)`, or scan
  `attachment.getAnnotations()` for the key.
- **The reader selection popup hands you a pending annotation** in
  `event.params.annotation` with the exact `position` / `sortIndex` /
  `pageLabel`. Reuse those when creating an annotation from a selection — it's
  more reliable than recomputing geometry from a text block.
- **Clipboard from inside the reader webview:** prefer
  `Zotero.Utilities.Internal.copyTextToClipboard`, then
  `navigator.clipboard.writeText`, then a `<textarea>` + `execCommand("copy")`
  fallback.

### Annotations

- **Applying both 划线 and 批注 to one block stacks two overlapping highlights**
  at the same `sortIndex`. Deleting one leaves the other, so the PDF still looks
  highlighted ("颜色浅了一下还在"). Removal sweeps **every** `AI`-tagged
  annotation at the block's `sortIndex` — see `removeAnnotationsForBlock`.
- Annotation writes don't need an API key (they only touch Zotero); don't gate
  them behind `requireKey`.

### Layout / scroll (panel)

- **Don't guess the panel height** (`calc(100vh - 120px)` was a guess that
  broke). Measure it: `_sizeRoot` sets height from
  `win.innerHeight - root.getBoundingClientRect().top`, re-run on rAF +
  `setTimeout` + window resize.
- Messages area is the only scroller: `flex: 1 1 0; min-height; overflow-y:auto`.
  Fixed rows (top/status/chips/composer) are `flex: 0 0 auto` so they're always
  visible.
- `overscroll-behavior: contain` on the scrollers — otherwise the wheel chains
  out to the window and triggers back/forward or app-switch gestures.
- Chips row uses `flex-wrap: wrap` + `max-height` + `min-width: 0`. `nowrap`
  widened the panel and clipped content horizontally.
- Assistant message rows need **column** layout; a flex *row* squished the
  复制/重新生成 actions to one character per line.
- **Streaming autoscroll:** only stick to the bottom when the user is already
  near the bottom, so they can scroll up to read history mid-stream without
  being yanked back.
- **Right-side overflow is a recurring bug — there is now ONE structural fix,
  don't patch it per-component.** A single unbreakable child (a long URL, an
  English tool brief, a wide artifact/table) pushes the whole assistant message
  wider than the panel, and because the message area is a flex column, a flex
  item with the default `min-width:auto` won't shrink below its min-content → the
  content is laid out too wide and clipped at the right edge. The fix is a
  catch-all in `style.css`: `.aireader-msg-assistant .aireader-bubble, … *
  { max-width:100%; min-width:0 }` plus `min-width:0` on `.aireader-msg` and
  wrap rules on `a`/`pre`/`table`. Any NEW component rendered inside an assistant
  bubble inherits this for free. `test/sim.js` asserts these selectors exist, so
  a refactor that drops them fails the tests. If overflow reappears, the child is
  almost certainly escaping the bubble (rendered outside `.aireader-msg-assistant
  .aireader-bubble`) — fix the DOM nesting, don't add another width hack.

### Selection popup

- **Hover driven by JS `mouseenter`/`mouseleave` must not be gated by a "busy"
  flag.** During an `await` the pointer leaves but no `mouseleave` fires, so the
  highlight sticks. Keep hover purely enter/leave (always reset on leave) and
  show busy state via text, never the background.
- The popup's "AI 解释" is **grounded**: it injects the paper's retrieved blocks
  (`buildRetrievedContext`) + recent chat history (`_chatStore`) so it stays
  consistent with the sidebar conversation. See `_explainMessages`.

### Networking

- **Streaming is real** via `callLLMStream`: `fetch` with `stream:true`, read
  `resp.body.getReader()`, parse SSE `data:` frames, emit per delta. It falls
  back to a single-shot delivery only if `resp.body` isn't readable or the
  gateway doesn't support SSE.
- **Never `await resp.json()` blindly.** Read `resp.text()` then parse, and on
  failure throw an error that includes a snippet of the real body — a non-JSON
  response usually means a wrong Base URL or API format, not a code bug.
- **`AbortController` is NOT a global in the bootstrap sandbox** (`typeof
  AbortController === "undefined"`), but `fetch` IS. Source the controller from
  the main window (`_abortCtor()` → `Zotero.getMainWindow().AbortController`); a
  window-created signal correctly aborts the sandbox `fetch`. A bare
  `new AbortController()` is undefined → silently disables BOTH the request
  timeout and cancellation (this is why the Stop button couldn't kill a hung
  request, and why the timeout never actually fired).
- **Cancel = real abort, not just a flag.** `state.cancel` alone can't stop a
  request stalled before the first byte (the `reader.read()`/initial `fetch`
  await never yields to re-check the flag). `_abortGuard(shouldStop)` polls the
  flag on a window timer and calls `controller.abort()`; `_streamAnswer` /
  `callLLMStream` pass its `signal` into `_fetchLLM` (`cfg.abortSignal`), which
  wires it to the fetch. Verified live: a hung fetch aborts in ~0.4s.
- Base URL normalization (`_normBase`): bare host → append `/v1`; `http` →
  `https` for remote hosts but keep `localhost` on `http`.
- `maxTokens` pref: `0` means unlimited. For the Anthropic format `max_tokens`
  is required, so an uncapped request uses a large fallback (32000).

### API-key gating

- Sidebar actions (chat / summary / follow-ups / figure vision) go through
  `requireKey`, which shows a status message and opens the preferences pane.
- The reader selection popup and right-click menu return early when no key is
  set, so they simply don't appear.

## Live debugging: the dev bridge + `scripts/zdev.mjs`

Zotero has no CLI eval, so iterating on reader/DOM behavior by rebuilding and
hand-testing is painfully slow. The plugin ships an **opt-in eval bridge** for a
real test loop into a *running* Zotero:

- Pref `extensions.zotero.aireader.devBridge` (default **false**). When true,
  `startDevBridge()` polls `<DataDir>/aireader-dev/cmd.json` for `{ seq, code }`,
  runs `code` as an async function body with `this` === `AIReader` (full plugin
  scope: reader, blocks, DOM), and writes `{ seq, ok, result|error, logs }` to
  `out.json`.
- `scripts/zdev.mjs` is the client: `node scripts/zdev.mjs 'return this.version'`
  or `node scripts/zdev.mjs -f snippet.js`. Available in the snippet: `this`,
  `Zotero`, `PathUtils`, `IOUtils`, `Services`, `log()`. `return` anything to
  inspect it (serialized by `_devSafe`).
- You can **hot-redefine methods** without reinstalling: in a snippet do
  `this.navigateTo = async function(...){...}; return "patched"`, then exercise
  it. Bake the winning version into `content/aireader.js` only once it works.
- Enabling it: set `aireader.devBridge` true (Config Editor or, in another live
  session, `Zotero.Prefs.set("aireader.devBridge", true)` — note this is
  debounced and may not survive an immediate quit) and restart; or temporarily
  flip the `prefs.js` default for a dev build. It only reads one local file and
  runs it in-process — no network. Keep the default **false** in released xpis.

Autonomous loop used to debug the snapshot jump: swap the xpi into the profile's
`extensions/`, clear `startupCache` + `extensions/staged/<id>`, quit via
`osascript -e 'tell application "Zotero" to quit'`, relaunch with `open -a
Zotero`, poll the bridge for readiness, then drive/measure through zdev.

### Snapshot / non-PDF navigation (hard-won)

- Snapshot/HTML/EPUB blocks have **no page geometry**, so there's no PDF-style
  `{position}` with rects. We keep a text `anchor` (`_searchAnchor`, ~80 chars)
  per block and jump by text (`navigateTo` → `_snapshotJump`).
- **Use the PUBLIC API.** Zotero exposes no public text-search, but it does expose
  `reader.navigate({ position })` (the documented plugin nav method; it does the
  cross-compartment `cloneInto` for you). For a snapshot the position is a
  **`TextPositionSelector` `{ type, start, end }`** — Zotero's own annotation
  position format. `start`/`end` are offsets into the concatenated text-node
  content of the rendered `<body>` (exactly what Zotero's `textPositionToRange`
  walks: raw, NOT whitespace-normalized). Don't drive the view's private
  `setFindState` — an earlier version did and it was fragile; `navigate` is the
  stable contract. (There is **no** `reader.find()` in Zotero 7.)
- Computing `start`/`end` is the ONE place we must read the rendered document;
  it's isolated in `_readerContentDoc(reader)` (tries `_internalReader
  ._primaryView._iframeDocument`, then a nested content iframe off
  `reader._iframeWindow`; feature-detected, returns null → caller degrades).
  `_textPositionFor(body, query)` (pure, unit-tested) does exact match first,
  else a whitespace-insensitive match that maps the collapsed hit back to raw
  offsets (so English text whose DOM spacing differs from the anchor resolves).
- The `.zotero-ft-cache` text does **not** line up with the rendered body text
  (it has extra `\n`s and a different length — e.g. 15373 vs 13050 chars), so you
  cannot compute the selector from the ft-cache alone; it must come from the live
  rendered body. (Verified via the dev bridge.)
- **Don't judge scroll success by `window.scrollY`.** A web snapshot (e.g. a Baidu
  doc) scrolls an **inner container** (`SECTION.mp-layout-content…`), so
  `window.scrollY` stays 0 even on a successful jump. Measure the inner scroller's
  `scrollTop` or the matched range's `getBoundingClientRect().top`.
- Right after a cold `Reader.open`, the content may not be laid out yet and the
  first jump can land at 0; `navigateTo` retries once after ~450ms.
- Block schema changes must bump `BLOCK_CACHE_VERSION` — `loadCache` rejects
  mismatched versions so a doc cached by an older build is re-extracted (otherwise
  anchorless cached blocks make citations unclickable).
