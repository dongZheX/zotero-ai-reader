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
- Base URL normalization (`_normBase`): bare host → append `/v1`; `http` →
  `https` for remote hosts but keep `localhost` on `http`.
- `maxTokens` pref: `0` means unlimited. For the Anthropic format `max_tokens`
  is required, so an uncapped request uses a large fallback (32000).

### API-key gating

- Sidebar actions (chat / summary / follow-ups / figure vision) go through
  `requireKey`, which shows a status message and opens the preferences pane.
- The reader selection popup and right-click menu return early when no key is
  set, so they simply don't appear.
