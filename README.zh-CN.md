<div align="center">

<img src="assets/banner.svg" alt="AI Reader for Zotero" width="100%"/>

<h1>AI Reader for Zotero</h1>

<p>在 Zotero 条目面板里用 AI 读论文。回答带出处，点页码徽标即可跳回 PDF。</p>

<p>
  <img alt="version" src="https://img.shields.io/badge/version-0.10.1-3b7ddd?style=flat-square"/>
  <img alt="zotero" src="https://img.shields.io/badge/Zotero-7 · 8 · 10 · 11-cc2936?style=flat-square&logo=zotero&logoColor=white"/>
  <img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-green?style=flat-square"/>
</p>

<a href="README.md">English</a> · <b>中文</b> · <a href="https://github.com/dongZheX/obsidian-ai-reader">Obsidian 版本</a>

</div>

---

## 这是什么

Zotero 条目面板侧栏里的一个对话框。选中一篇论文就能提问，论文正文作为上下文发给模型，所以回答基于文档本身，而不是模型的印象。

和普通对话框相比，多了两点：

- **回答指回原文。** 论断可带页码徽标（`p7`），点一下阅读器跳到对应段落并高亮。定位来自 Zotero 的结构化文本（每个文本块带页码和坐标）。
- **能写标注。** 模型建议「划线 / 批注」，渲染成按钮。不点不动你的文库；点了才创建一条带 `AI` 标签的原生高亮，之后也能从面板删掉。

<div align="center">
<img src="assets/ui-preview.svg" alt="AI Reader 面板" width="560"/>
</div>

### 演示

https://github.com/user-attachments/assets/2503e82e-5289-42d1-a6e0-51cf5076695e

## 功能

| | |
|---|---|
| **带上下文的对话** | 整篇论文作为上下文。流式 Markdown（`marked` + KaTeX，含 `$…$` / `$$…$$` 公式），每条消息显示 token 与 context 用量。 |
| **点击溯源** | 回答里的 `[B<id>]` 渲染成页码徽标，点一下跳转并高亮阅读器里对应的文本块。 |
| **AI 写标注** | 模型建议划线/批注，一键应用为原生标注。`✕` 删掉它在该位置加的全部标注。 |
| **通读并标注 agent** | 一键让 agent 读完整篇，自动按类别打彩色高亮+批注（贡献/方法/结果/局限/关键概念）。去重、幂等，有进度日志和一键撤销。 |
| **阅读技能** | 顶部选阅读模式——精读理解（默认）、同行评审、三遍速读、领域综述、可复现复刻、批判红队、导师讲解、速览。切换会换掉快捷按钮并注入对应方法。 |
| **图表视觉解读** | 把图/表区域渲染成图像交给多模态模型，而不只读 caption 文本。 |
| **联网搜索与抓取** | `web_search`（Google via Serper，需填 Key）和 `web_fetch`（把网页读成正文），用于核对论文之外的背景。 |
| **学术发现** | 顺着论文查**参考文献**、找**相关与后续工作**、按标题/DOI/arXiv 查任意论文——走免费的 Semantic Scholar 引文图。填了 Serper Key 时，关键词检索升级为 Google Scholar（带被引数）。 |
| **对话内画图** | 模型用 ` ```svg ` 代码块画图，内联渲染（已净化、自动缩放）。生成时不显示源码。 |
| **连续上下文** | 整段对话是一条连续历史——读过的章节后续天然可见、不重复读；过长时自动 compact。 |
| **全文翻译** | 把整篇文档翻译成你的输出语言——分段、携带相邻上下文并发翻译（术语前后一致），产出双语子附件、在阅读器里打开（翻译时显示进度条）。 |
| **网页快照与 HTML** | 不止 PDF，网页快照 / HTML 附件也能总结、问答、翻译——读取 Zotero 的 `.zotero-ft-cache`。快照上的引用通过阅读器全文搜索跳转定位。 |
| **多篇对比** | 把多篇论文加入对比篮子，一次跨多篇提问。 |
| **分享材料** | 一键生成一页 Markdown 总结，或分章节的图文 HTML 分享页（嵌入本文图表、手绘 SVG、速问速答卡）。HTML 页顶部带权威的论文信息卡（标题、作者、会议·年份、可点 arXiv/DOI、摘要——取自 Zotero 条目而非模型生成），并内置 **4 种可切换视觉主题**（期刊风 / 现代 / 瑞士 / 暖笔记），支持深色模式。 |
| **对话多机同步** | 对话持久化进一条随 Zotero 同步的数据笔记，历史跟着你跨机器走。 |
| **选中弹窗** | 在阅读器里选中文字，可引用、解释（流式，带复制和「写入批注」）、或翻译。 |
| **你的标注作为上下文** | 读取你已有的高亮和笔记，于是可问「总结我的高亮」。 |
| **持久化** | 对话历史按附件保存、下次恢复；任意对话可存为 Zotero 笔记。 |
| **不绑定厂商** | OpenAI `chat/completions`、OpenAI `responses`、Anthropic `messages`，以及兼容网关（DeepSeek、Moonshot、本地 Ollama / vLLM）。 |

## 安装

1. 从 [Releases](https://github.com/dongZheX/zotero-ai-reader/releases) 或仓库下载 `ai-reader.xpi`。
2. Zotero：**工具 → 插件 → 右上齿轮 → Install Add-on From File…**，选中文件。
3. 重启 Zotero。

兼容 Zotero 7 / 8 / 10 / 11。点击溯源依赖 Zotero 10+ 的结构化文本；7 和 8 上对话与总结可用，但无法精确定位。

## 配置

打开 **设置 → AI Reader**：

| 项 | 说明 |
|---|---|
| 接口格式 | **自动**按模型名选择（Claude → `/messages`，OpenAI → `/responses`），也可手动指定。 |
| Base URL | 只填主机名会自动补 `/v1`，`http` 自动升级为 `https`。 |
| API Key | 你的密钥。 |
| Model | 如 `gpt-5`、`deepseek-chat`、`claude-opus-5-5`。 |
| 输出语言 | 中文 / English / 日本語。 |
| Temperature | 采样温度。**留空则用模型默认值**——只有填了数值才会发送（部分模型如 GPT 推理模型不接受自定义温度，必须留空）。 |
| 最大发送字符数 | 注入正文的上限。 |
| 最大输出 token | `0` 表示不限制。 |
| 并行工具数 | 只读工具最多并发多少个；API 不允许并发就设 `1`。 |
| Serper API Key | 启用 `web_search`（[serper.dev](https://serper.dev)），可选。 |
| 自定义指令 | 追加到系统提示的额外要求，可选。 |

## 使用

1. 选中一篇带 PDF 附件的论文，或在阅读器里打开。
2. 展开 **AI 阅读** 分区，点 **生成总结** 或直接提问。
3. 点 `p页码` 徽标跳转；点 **应用划线 / 批注** 创建真实标注。
4. 在阅读器里选中文字：**在右侧问 AI / AI 解释 / 翻译**。
5. 点 **存为笔记** 把对话写进 Zotero 笔记。

## 工作原理

```
Zotero.SDT.getReader(attachmentID).materialize()
      └─ 带页码和坐标的文本块 → [B<id> p<page>]
                 │  system prompt：用 [B<id>] 引用，用 [[hl:id]] / [[note:id|批注]] 提议标注
                 ▼
         流式回答 → marked + KaTeX
                 ├─ [B<id>]      → 页码徽标 → Zotero.Reader.open()      跳转 + 高亮
                 └─ [[hl|note]]  → 按钮      → Zotero.Annotations.saveFromJSON()
```

决定模型行为的内容都放在 **system 消息**里：论文上下文、去 AI 味的风格指南、SVG 作图规则、当前阅读技能、以及你的自定义指令。之后整段对话作为一条连续历史运行——用户轮、助手轮、工具轮（读章节、看图）持续累积，所以读过的内容后续可见、不重复读；过长时把最旧的若干回合摘要、保留最近回合。Anthropic 下稳定前缀带 `cache_control` 命中 prompt 缓存，只读工具并行执行。

## 构建

```bash
zip -r -q ai-reader.xpi manifest.json bootstrap.js prefs.js content locale
node test/sim.js        # → ALL OK
node test/snapshot.js   # → SNAPSHOT OK（快照锚点 + 引用跳转）
```

## 已知限制

- **PDF** 点击溯源是精确的（页码 + 坐标）。**快照 / HTML / EPUB** 没有页面坐标，所以引用改为驱动阅读器的全文搜索跳到那句话——对文字可靠，但无法在那里高亮图/表。
- 超长论文按「最大发送字符数」截断，大上下文模型可调高。

## 开发

插件内置一个可选的**开发桥**（pref `extensions.zotero.aireader.devBridge`，默认关），给你一个进到*运行中* Zotero 的真实 REPL——调试任何涉及 reader/DOM 的东西都极有用。打开 pref 后：

```bash
node scripts/zdev.mjs 'return this.version'      # 在运行中的插件作用域里执行代码
node scripts/zdev.mjs -f snippet.js              # 或从文件读
```

代码以 async 函数体运行，`this` 就是 `AIReader` 对象（可访问 reader、blocks、DOM），甚至能热替换方法而不用重装。它只读本机一个命令文件、在进程内运行——不走网络。完整工作流见 `CLAUDE.md`。正式构建里默认**关闭**。

## 致谢与借鉴

| 项目 | 借鉴之处 |
|---|---|
| [Moonlight](https://www.themoonlight.io/zh) | 一体化阅读助手的交互范式 |
| [yilewang/llm-for-zotero](https://github.com/yilewang/llm-for-zotero) | 侧栏对话面板布局 |
| [papersgpt/papersgpt-for-zotero](https://github.com/papersgpt/papersgpt-for-zotero) | Zotero 内 AI 问答的工程实践 |
| [cboulanger/zotero-skills](https://github.com/cboulanger/zotero-skills) | AI 与 Zotero 协作的接口思路 |
| [stark1tty/zotero-AI-Butler](https://github.com/stark1tty/zotero-AI-Butler-english) | Prompt 模板、笔记排版 |
| [blader/humanizer](https://github.com/blader/humanizer) | 去 AI 味的风格指南 |
| `artifact-design` skill | SVG 规则里「避免 AI 设计套路」 |
| [bytedance/deer-flow](https://github.com/bytedance/deer-flow) | 同行评审、领域综述技能 |
| [S. Keshav《How to Read a Paper》](https://web.stanford.edu/class/ee384m/Handouts/HowtoReadPaper.pdf) | 三遍速读技能 |

## 许可

[Apache License 2.0](LICENSE)
