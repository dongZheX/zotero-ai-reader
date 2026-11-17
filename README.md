<div align="center">

<img src="assets/banner.svg" alt="AI Reader for Zotero" width="100%"/>

<h1>AI Reader for Zotero</h1>

<p>Read papers with an AI assistant inside Zotero's item pane. Answers cite the source, and a click on any page badge jumps back to that spot in the PDF.</p>

<p>
  <img alt="version" src="https://img.shields.io/badge/version-0.8.1-3b7ddd?style=flat-square"/>
  <img alt="zotero" src="https://img.shields.io/badge/Zotero-7 · 8 · 10 · 11-cc2936?style=flat-square&logo=zotero&logoColor=white"/>
  <img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square"/>
</p>

<b>English</b> · <a href="README.zh-CN.md">中文</a>

</div>

---

## What it is

A Zotero plugin that puts a chat panel in the item-pane sidebar. Select a paper in your library and ask questions about it — no need to open the reader first. The paper's text is sent as context, so answers stay grounded in the actual document rather than the model's memory of it.

Two things make it more than a chat box:

- **Answers point back to the page.** Each claim can carry a page badge (`p7`). Click it and the reader opens at that paragraph with a brief highlight. The mapping comes from Zotero's structured text, which carries page numbers and coordinates per text block.
- **The model can write annotations.** It can suggest "highlight this" or "note that", which show up as buttons. Nothing touches your library until you click — then it creates a native yellow highlight tagged `AI`, which you can remove again from the panel.

<div align="center">
<img src="assets/ui-preview.svg" alt="AI Reader panel" width="560"/>
</div>

## Features

| | |
|---|---|
| **Grounded chat** | The whole paper is injected as context. Streaming Markdown output with `marked` + KaTeX for bold, lists, tables, code, and `$…$` / `$$…$$` math. Token and context usage shown per message. |
| **Click-to-source** | `[B<id>]` citations render as page badges. Click to jump and highlight the matching block in the reader. |
| **AI annotations** | The model proposes highlights/notes; you apply them with one click as native annotations. The `✕` removes every annotation it added at that spot. |
| **Agentic read & annotate** | One click (**✨ 通读并标注**) sends the agent through the whole paper and applies colour-coded highlights + notes for the key points — contribution (yellow), method (green), result (blue), limitation (red), key term (purple). Fully automatic, de-duplicated and idempotent, with a live progress log and a one-click **undo this run**. |
| **Figure & table vision** | Render a figure or table region to an image and send it to a multimodal model, instead of reading only the caption text. |
| **Web search & fetch** | The model can call `web_search` (Google via Serper — set a Serper key in settings) and `web_fetch` (read a page as text) to check background, recent work, or terms beyond the paper. `web_fetch` works without a key; `web_search` only appears once a Serper key is set. |
| **Inline diagrams** | The model can draw with fenced ` ```mermaid `, ` ```svg `, or ` ```html ` blocks; they render inline in a sandboxed iframe (scripts isolated from Zotero), with graceful fallback to source. |
| **Selection popup** | Select text in the reader to quote it into the sidebar, explain it (streaming, with a copy button and a one-click "write to PDF annotation"), or translate it. Explanations see the paper context and the recent conversation. |
| **Your notes as context** | Reads your existing highlights and notes so you can ask "summarize my highlights" or "answer based on my notes". |
| **Persistence** | Conversation history is saved per attachment and restored next time. Save any conversation as a Zotero note. |
| **Provider-agnostic** | OpenAI `chat/completions`, OpenAI `responses`, and Anthropic `messages`. Works with compatible gateways (DeepSeek, Moonshot, local Ollama / vLLM, …). |

## Install

1. Download `ai-reader.xpi` from [Releases](https://github.com/dongZheX/zotero-ai-reader/releases) or the repository.
2. In Zotero: **Tools → Add-ons → gear menu → Install Add-on From File…**, then pick `ai-reader.xpi`.
3. Restart Zotero.

Works on Zotero 7 / 8 / 10 / 11. Click-to-source and figure jumps rely on the structured text (SDT) in Zotero 10+. On 7 and 8 the chat and summaries work, but precise recall needs 10+.

## Configure

Open **Settings → AI Reader**:

| Field | Notes | Example |
|---|---|---|
| API format | `chat-completions`, `responses`, or `anthropic` | OpenAI `/chat/completions` |
| Base URL | Root endpoint; a bare host gets `/v1` appended, `http` is upgraded to `https` | `https://api.openai.com/v1` |
| API Key | Your key | `sk-…` |
| Model | Model name | `gpt-5` · `deepseek-chat` · `claude-opus-5-5` |
| Output language | Reply language | 中文 / English / 日本語 |
| Temperature | Sampling temperature | `0.3` |
| Max characters | Upper bound on injected body text | `60000` |
| Max output tokens | `0` means no limit (avoids truncated summaries) | `0` |
| Serper API Key | Enables `web_search` (from [serper.dev](https://serper.dev)); optional | — |

Use **Test connection** to check the setup.

## Usage

1. Select a paper with a PDF attachment, or open it in the reader.
2. Expand the **AI Reading** section in the item pane. Click **Generate summary**, or type a question.
3. Click a `p<page>` badge to jump and highlight. Click **Apply highlight / Apply note** to create a real annotation.
4. In the reader, select text and right-click (or use the selection popup) for **Ask in sidebar / Explain / Translate**.
5. Click **Save as note** to write a conversation into the item's Zotero note.

## How it works

```
Zotero.SDT.getReader(attachmentID).materialize()
      └─ text blocks with pageRects (page + coordinates) → [B<id> p<page>]
                 │  injected into the system prompt (ask the model to cite with
                 │  [B<id>], and propose annotations with [[hl:id]] / [[note:id|text]])
                 ▼
         streaming reply → rendered with marked + KaTeX
                 ├─ [B<id>]      → page badge → Zotero.Reader.open(id, {position})   jump + highlight
                 └─ [[hl|note]]  → button      → Zotero.Annotations.saveFromJSON()    write into the PDF
```

## Build from source

```bash
cd zotero-ai-reader
zip -r -q ai-reader.xpi manifest.json bootstrap.js prefs.js content locale
```

Tests (headless Node simulation covering extraction, sortIndex, annotations, retrieval, streaming, usage, Markdown + KaTeX, vision, and the API formats):

```bash
node test/sim.js   # → ALL OK
```

## Limitations

- Click-to-source and figure jumps apply to **PDF attachments** only. EPUB and snapshots have structured text but no page coordinates, so they can be summarized and discussed but not located.
- Long papers are truncated at the "max characters" setting; raise it for large-context models.
- Translation is selection-based. Whole-document or layout-preserving bilingual output is out of scope (pair it with zotero-pdf-translate).

## Acknowledgements

The design borrows from several projects:

| Project | What was borrowed |
|---|---|
| [Moonlight](https://www.themoonlight.io/zh) | The integrated reading-assistant interaction model |
| [yilewang/llm-for-zotero](https://github.com/yilewang/llm-for-zotero) | Sidebar chat panel layout |
| [papersgpt/papersgpt-for-zotero](https://github.com/papersgpt/papersgpt-for-zotero) | In-Zotero Q&A engineering |
| [cboulanger/zotero-skills](https://github.com/cboulanger/zotero-skills) | Interface ideas for AI/Zotero interaction |
| [stark1tty/zotero-AI-Butler](https://github.com/stark1tty/zotero-AI-Butler-english) (orig. steven-jianhao-li) | Prompt templates, right-click generation, note formatting |

## License

[Apache License 2.0](LICENSE)
