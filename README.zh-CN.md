<div align="center">

<img src="assets/banner.svg" alt="AI Reader for Zotero" width="100%"/>

<h1>AI Reader for Zotero</h1>

<p>在 Zotero 的条目面板里用 AI 读论文。回答带出处，点一下页码徽标就跳回 PDF 对应的位置。</p>

<p>
  <img alt="version" src="https://img.shields.io/badge/version-0.8.2-3b7ddd?style=flat-square"/>
  <img alt="zotero" src="https://img.shields.io/badge/Zotero-7 · 8 · 10 · 11-cc2936?style=flat-square&logo=zotero&logoColor=white"/>
  <img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square"/>
</p>

<a href="README.md">English</a> · <b>中文</b>

<p>用 Obsidian？→ <a href="https://github.com/dongZheX/obsidian-ai-reader"><b>AI Reader for Obsidian</b></a></p>

</div>

---

## 这是什么

一个 Zotero 插件，在条目面板侧栏放了一个对话框。在文库里选中一篇论文就能提问，不必先打开阅读器。提问时会把论文正文作为上下文发给模型，所以回答是基于文档本身，而不是模型对它的印象。

它比普通对话框多做了两件事：

- **回答能指回原文。** 每个论断可以带一个页码徽标（`p7`），点它，阅读器会打开到对应段落并短暂高亮。这套定位基于 Zotero 的结构化文本——每个文本块都带页码和坐标。
- **模型能写标注。** 它可以建议「在这里划线 / 批注」，渲染成按钮。不点就不会动你的文库；点了才在 PDF 里创建一条原生黄高亮并打上 `AI` 标签，之后也能从面板里删掉。

<div align="center">
<img src="assets/ui-preview.svg" alt="AI Reader 面板" width="560"/>
</div>

## 功能

| | |
|---|---|
| **带上下文的对话** | 整篇论文作为上下文注入。流式 Markdown 输出，用 `marked` + KaTeX 渲染粗体、列表、表格、代码块，以及行内 `$…$` 和块级 `$$…$$` 公式。每条消息底部显示 token 与 context 用量。 |
| **点击溯源** | 回答里的 `[B<id>]` 渲染成页码徽标，点一下跳转并高亮阅读器里对应的文本块。 |
| **AI 写标注** | 模型建议划线/批注，你一键应用为原生标注。`✕` 会把它在那个位置加的标注全部删掉。 |
| **Agent 通读并标注** | 一键（**✨ 通读并标注**）让 agent 读完整篇论文，自动按类别打上**彩色**高亮+批注——贡献（黄）、方法（绿）、结果（蓝）、局限（红）、关键概念（紫）。全自动、去重且幂等，面板实时显示进度，并提供一键**撤销本次标注**。 |
| **图表视觉解读** | 把图或表的区域渲染成图像交给多模态模型，而不是只读 caption 文本。 |
| **联网搜索与抓取** | 模型可调用 `web_search`（Google via Serper，需在设置里填 Serper Key）和 `web_fetch`（把网页读成正文）来核对论文之外的背景、最新进展或术语。`web_fetch` 无需 Key；`web_search` 仅在填入 Serper Key 后出现。 |
| **对话内画图（SVG）** | 模型可用 ` ```svg ` 代码块画示意图，直接内联渲染（已净化、自动缩放适配面板宽度）。生成时**不显示源码**，只显示「正在绘制…」动画，完成后呈现图形。总结类预设（总结全文 / 含图表 / 核心贡献 / 主要结论）默认附带一张示意图。 |
| **选中弹窗** | 在阅读器里选中文字，可以引用到侧栏、解释（流式，带复制按钮和一键「写入 PDF 批注」）、或翻译。解释时会参考论文上下文和最近的对话。 |
| **你的标注作为上下文** | 读取你已有的高亮和笔记，于是可以问「总结我的高亮」「基于我的批注回答」。 |
| **持久化** | 对话历史按附件保存，下次打开自动恢复。任意一段对话可存为 Zotero 笔记。 |
| **不绑定厂商** | 支持 OpenAI `chat/completions`、OpenAI `responses`、Anthropic `messages`，以及兼容网关（DeepSeek、Moonshot、本地 Ollama / vLLM 等）。 |

## 安装

1. 从 [Releases](https://github.com/dongZheX/zotero-ai-reader/releases) 或仓库下载 `ai-reader.xpi`。
2. Zotero：**工具 → 插件 → 右上齿轮 → Install Add-on From File…**，选中 `ai-reader.xpi`。
3. 重启 Zotero。

兼容 Zotero 7 / 8 / 10 / 11。点击溯源和图表跳转依赖 Zotero 10+ 的结构化文本（SDT）；在 7 和 8 上对话与总结可用，但精确溯源需要 10+。

## 配置

打开 **设置 → AI Reader**：

| 项 | 说明 | 示例 |
|---|---|---|
| 接口格式 | `chat-completions`、`responses` 或 `anthropic` | OpenAI `/chat/completions` |
| Base URL | 接口根地址；只填主机名会自动补 `/v1`，`http` 自动升级为 `https` | `https://api.openai.com/v1` |
| API Key | 你的密钥 | `sk-…` |
| Model | 模型名 | `gpt-5` · `deepseek-chat` · `claude-opus-5-5` |
| 输出语言 | 回复语言 | 中文 / English / 日本語 |
| Temperature | 采样温度 | `0.3` |
| 最大发送字符数 | 注入正文的上限 | `60000` |
| 最大输出 token | `0` 表示不限制（避免长总结被截断） | `0` |
| Serper API Key | 启用 `web_search` 联网搜索（来自 [serper.dev](https://serper.dev)），可选 | — |

点 **测试连接** 验证配置。

## 使用

1. 选中一篇带 PDF 附件的论文，或在阅读器里打开它。
2. 展开条目面板的 **AI 阅读** 分区，点 **生成总结**，或直接提问。
3. 点 `p页码` 徽标跳转并高亮；点 **应用划线 / 应用批注** 创建真实标注。
4. 在阅读器里选中文字右键（或用选中弹窗）：**在右侧问 AI / AI 解释 / 翻译**。
5. 点 **存为笔记** 把对话写进条目的 Zotero 笔记。

## 工作原理

```
Zotero.SDT.getReader(attachmentID).materialize()
      └─ 带 pageRects（页码 + 坐标）的文本块 → [B<id> p<page>]
                 │  注入 system prompt（要求模型用 [B<id>] 引用，
                 │  用 [[hl:id]] / [[note:id|批注]] 提议标注）
                 ▼
         流式回答 → marked + KaTeX 渲染
                 ├─ [B<id>]      → 页码徽标 → Zotero.Reader.open(id, {position})   跳转 + 高亮
                 └─ [[hl|note]]  → 按钮      → Zotero.Annotations.saveFromJSON()    写入 PDF
```

## 从源码构建

```bash
cd zotero-ai-reader
zip -r -q ai-reader.xpi manifest.json bootstrap.js prefs.js content locale
```

测试（Node 无头仿真，覆盖提取、sortIndex、标注、检索、流式、用量、Markdown + KaTeX、视觉、多接口格式）：

```bash
node test/sim.js   # → ALL OK
```

## 已知限制

- 点击溯源和图表跳转只支持 **PDF 附件**。EPUB 和快照有结构文本但无页坐标，可以总结和对话，但无法定位。
- 超长论文按「最大发送字符数」截断，大上下文模型可调高。
- 翻译是「选中即译」。整篇或保留布局的双语不在范围内（可配合 zotero-pdf-translate）。

## 致谢与借鉴

设计与实现参考了以下项目：

| 项目 | 借鉴之处 |
|---|---|
| [Moonlight](https://www.themoonlight.io/zh) | 一体化阅读助手的交互范式 |
| [yilewang/llm-for-zotero](https://github.com/yilewang/llm-for-zotero) | 侧栏对话面板的布局 |
| [papersgpt/papersgpt-for-zotero](https://github.com/papersgpt/papersgpt-for-zotero) | Zotero 内 AI 问答的工程实践 |
| [cboulanger/zotero-skills](https://github.com/cboulanger/zotero-skills) | AI 与 Zotero 协作的接口思路 |
| [stark1tty/zotero-AI-Butler](https://github.com/stark1tty/zotero-AI-Butler-english)（原作 steven-jianhao-li） | Prompt 模板、右键生成、笔记排版 |

## 许可

[Apache License 2.0](LICENSE)
