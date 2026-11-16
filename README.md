<div align="center">

<img src="assets/banner.svg" alt="AI Reader for Zotero" width="100%"/>

<h1>AI Reader for Zotero</h1>

<p><b>在 Zotero 里用 AI 读论文</b> — 带出处的对话式总结，每一点都能 <b>一键跳回 PDF 原文</b>，AI 还能直接在论文里划线、批注、存笔记。</p>

<p>
  <img alt="version" src="https://img.shields.io/badge/version-0.6.3-3b7ddd?style=flat-square"/>
  <img alt="zotero" src="https://img.shields.io/badge/Zotero-7 · 8 · 10 · 11-cc2936?style=flat-square&logo=zotero&logoColor=white"/>
  <img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square"/>
  <img alt="providers" src="https://img.shields.io/badge/API-OpenAI · Anthropic · 兼容网关-6f42c1?style=flat-square"/>
  <img alt="built-with" src="https://img.shields.io/badge/built%20with-Claude%20Opus%205.5-d97757?style=flat-square"/>
</p>

<sub>对标 <a href="https://www.themoonlight.io/zh">Moonlight</a> 的阅读体验 · 直接长在 Zotero 条目面板里 · 无需第二个 App</sub>

</div>

---

## ✨ 亮点

<table>
<tr>
<td width="50%" valign="top">

### 🔗 答案定向原文（反向召回）
模型回答里的关键论断带可点 **页码徽标**（如 `p3`）。点一下，Zotero 阅读器自动跳转并高亮对应段落——基于结构化文本的块级页码 + 坐标，精确到段落。

</td>
<td width="50%" valign="top">

### ✎ AI 写标注（建议 + 一键应用）
模型可以建议「在这里划线 / 批注」，渲染成按钮。点一下才真正在 PDF 里创建 **原生黄高亮 + `AI` 标签**，绝不自动改你的文库。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### ∑ 流式 Markdown + 公式
打字机式流式输出，内置 **marked + KaTeX**：粗体 / 列表 / 表格 / 代码块、行内 `$…$` 与块级 `$$…$$` 公式都能正确渲染。底部实时显示 **token 数与 context 用量**。

</td>
<td width="50%" valign="top">

### 🖼️ 图 / 表 / 公式视觉解读
对论文里的图表区域做 **多模态视觉识别**（渲染为图像后交给支持视觉的模型），而不仅是读 caption 文本。

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 💬 统一对话面板
一个面板搞定：多轮对话、生成总结、选中即问。整篇论文作为上下文注入，**对话历史持久化**，下次打开自动恢复。

</td>
<td width="50%" valign="top">

### 🧭 选中即问 / 解释 / 翻译
在阅读器里选中文字右键：**引用到右侧输入框**自己提问、**AI 解释**、或**只翻译**。TF-IDF 检索把最相关的段落喂给模型。

</td>
</tr>
</table>

<div align="center">
<img src="assets/ui-preview.svg" alt="AI Reader 面板预览" width="560"/>
<br/>
<sub>统一对话面板：消息区（含出处徽标 / 公式 / 应用划线按钮）· 快捷模板 · 模型切换 · 贴底输入框</sub>
</div>

---

## 🚀 安装

1. 从 [Releases](https://github.com/dongZheX/zotero-ai-reader/releases) 或仓库下载 **`ai-reader.xpi`**。
2. Zotero → **工具 (Tools)** → **插件 (Add-ons)** → 右上齿轮 → *Install Add-on From File…* → 选中 `ai-reader.xpi`。
3. 重启 Zotero。

> 兼容 **Zotero 7 / 8 / 10 / 11**。反向召回与图表跳转依赖 Zotero 10+ 的结构化文本（SDT）；在 7 / 8 上总结与对话可用，但精确召回需要 10+。

## ⚙️ 配置

Zotero → **设置 (Settings)** → 左侧 **AI Reader**：

| 项 | 说明 | 示例 |
|---|---|---|
| **接口格式** | `chat-completions` / `responses` / `anthropic` 三选一 | `OpenAI /chat/completions` |
| **Base URL** | 接口根地址（只填主机名会自动补 `/v1`，`http` 自动升级 `https`） | `https://api.openai.com/v1` |
| **API Key** | 你的密钥 | `sk-…` |
| **Model** | 模型名 | `gpt-5` · `deepseek-chat` · `Opus 5.5` |
| **输出语言** | 回复语言 | 中文 / English / 日本語 |
| **Temperature** | 采样温度 | `0.3` |
| **最大发送字符数** | 注入正文的上限 | `60000` |
| **最大输出 token** | `0 = 不限制`（避免长总结被截断） | `0` |

点 **测试连接** 验证。兼容任何 OpenAI 格式 `/chat/completions` 网关（OpenAI、DeepSeek、Moonshot、本地 Ollama / vLLM 等）与 Anthropic `/messages`。

## 📖 使用

1. 选中一篇带 PDF 附件的论文（或在阅读器中打开它）。
2. 条目面板展开 **AI 阅读** 分区，点 **生成总结**，或直接在下方提问。
3. 点任意 `p页码` 徽标 → PDF 跳转并高亮；点 **应用划线 / 应用批注** → 在 PDF 创建真实标注。
4. 阅读器里选中文字右键 → **在右侧问 AI / AI 解释 / AI 翻译**。
5. 满意的对话点 **存为笔记**，写入 Zotero 条目笔记。

---

## 🛠️ 工作原理

```
Zotero.SDT.getReader(attachmentID).materialize()
      └─ 带 pageRects(页码+坐标) 的文本块 → [B<id> p<page>]
                 │  注入 system prompt（要求回答里写 [B<id>] 引用、
                 │  用 [[hl:id]] / [[note:id|批注]] 提议标注）
                 ▼
         流式回答 → marked + KaTeX 渲染
                 ├─ [B<id>]      → 可点页码徽标 → Zotero.Reader.open(id,{position})  跳转+高亮
                 └─ [[hl|note]]  → 按钮 → Zotero.Annotations.saveFromJSON()           写入 PDF
```

## 🔨 从源码构建

```bash
cd zotero-ai-reader
zip -r -q ai-reader.xpi manifest.json bootstrap.js prefs.js content locale
```

测试（Node 无头仿真，覆盖提取 / sortIndex / 标注 / 检索 / 流式 / 用量 / Markdown+KaTeX / 视觉 / 多接口格式）：

```bash
node test/sim.js   # → ALL OK
```

## 📐 已知限制

- 反向召回与图表跳转仅支持 **PDF 附件**（EPUB / 快照有结构文本但无页坐标，可总结 / 对话但不定位）。
- 超长论文按「最大发送字符数」截断；大上下文模型可调高。
- 翻译为「选中即译」；整篇 / 保留布局双语不做（可配合 zotero-pdf-translate）。

---

## 🙏 致谢与借鉴

本项目在设计与实现上参考了以下优秀工作：

| 项目 | 借鉴之处 |
|---|---|
| [Moonlight](https://www.themoonlight.io/zh) | 一体化 AI 阅读体验与交互范式 |
| [yilewang/llm-for-zotero](https://github.com/yilewang/llm-for-zotero) | 侧栏对话面板的布局结构 |
| [papersgpt/papersgpt-for-zotero](https://github.com/papersgpt/papersgpt-for-zotero) | Zotero 内 AI 问答的工程实践 |
| [cboulanger/zotero-skills](https://github.com/cboulanger/zotero-skills) | AI agent 与 Zotero 协作的接口思路 |
| [stark1tty/zotero-AI-Butler](https://github.com/stark1tty/zotero-AI-Butler-english)（原作 steven-jianhao-li） | 自定义 Prompt 模板、条目右键生成、笔记排版与界面布局设计 |

## 🤖 署名

> 本项目的代码、测试、文档与配图 **完全由 [Anthropic](https://www.anthropic.com) 的 Claude（Opus 5.5）通过 [Claude Code](https://claude.com/claude-code) 编写**。

## 📄 License

[Apache License 2.0](LICENSE)
