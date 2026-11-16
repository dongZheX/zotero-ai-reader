# AI Reader — Zotero 插件

在 Zotero 侧边栏用 AI 阅读论文：生成结构化总结，**总结里的每一点都能点回 PDF 里对应的位置**（反向召回 / reverse recall）。类似 Moonlight 的体验，但直接长在 Zotero 里。

## 功能

侧边栏一个**统一对话面板**（对标 Moonlight 的一体化体验），在文库条目面板和阅读器右栏都能用：

- **对话**：就整篇论文多轮提问，**流式输出**（打字机效果）。论文全文作为上下文注入，图/表/公式也能问。
- **答案定向原文**：模型回答里的关键论断带可点页码徽标（如 `p3`），点击即跳转并高亮 PDF 对应段落。基于 Zotero 10 结构化文本（SDT）的块级页码+坐标，精确到段落。
- **AI 写标注（建议+一键应用）**：模型可建议在某处划线/批注，渲染成「应用划线/应用批注」按钮；点一下才真正在 PDF 里创建标注（native 黄高亮 + `AI` 标签），不自动改你的文库。
- **一键总结**：点「生成总结」得到一段带引用的结构化总结，作为对话的一条消息。
- **选中即解释 / 翻译**：阅读器里选中文字，弹窗里点「AI 解释」或「翻译」。
- **可配置模型**：设置里填 Base URL、API Key、模型名——兼容任何 OpenAI 格式 `/chat/completions` 接口（OpenAI、DeepSeek、Moonshot、本地 Ollama/vLLM 等）。
- **本地缓存**：结构化块缓存在数据目录，PDF 未变则再次打开直接复用。

## 要求

- **Zotero 7 或更高**（反向召回依赖 Zotero 10 的结构化文本；在 7/8 上总结可用，但精确召回需要 10）。

## 安装

1. 下载 `ai-reader.xpi`。
2. Zotero → 工具（Tools）→ 插件（Add-ons）→ 右上齿轮 → *Install Add-on From File…* → 选中 `ai-reader.xpi`。
3. 重启 Zotero。

## 配置

Zotero → 设置（Settings）→ 左侧 **AI Reader**：

| 项 | 说明 | 示例 |
|---|---|---|
| 接口格式 | chat-completions / responses / anthropic 三选一 | `OpenAI /chat/completions` |
| Base URL | 接口根地址（只填主机名会自动补 `/v1`） | `https://api.openai.com/v1` |
| API Key | 你的密钥 | `sk-...` |
| Model | 模型名 | `gpt-4o-mini` / `deepseek-chat` / `Opus 5.5` |
| 输出语言 | 总结语言 | 中文 / English |
| Temperature | 采样温度 | `0.3` |
| 最大发送字符数 | 发送给模型的正文上限 | `60000` |

点 **测试连接** 验证配置。

## 使用

1. 选中一篇有 PDF 附件的论文（或在阅读器中打开它）。
2. 侧边栏打开「AI 总结」分区，点 **生成总结**。
3. 阅读总结；点任意要点后的 `p页码` 徽标，PDF 自动跳转并高亮该处。

## 从源码构建

```bash
cd zotero-ai-reader
zip -r -q ai-reader.xpi manifest.json bootstrap.js prefs.js content locale
```

## 开发 / 热重载

把插件目录软链到 Zotero 的 `extensions` 目录（文件名为插件 id），并在 `prefs.js`（Zotero 配置编辑器）里设 `extensions.lastAppBuildId`/`extensions.lastAppVersion` 触发重载，或用 [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) 的热重载流程。

## 工作原理

1. `Zotero.SDT.getReader(attachmentID).materialize()` 得到带 `anchor.pageRects`（页码+坐标）的文本块；每块编号 `[B<id> p<page>]`。
2. 这些块作为论文上下文注入 system prompt；要求模型在论断后写 `[B<id>]` 引用，用 `[[hl:id]]` / `[[note:id|批注]]` 提议标注。
3. 回答流式显示，结束后把 `[B<id>]` 渲染成可点页码徽标 → `Zotero.Reader.open(id,{position})` 跳转并高亮 2 秒；把标注指令渲染成按钮 → `Zotero.Annotations.saveFromJSON()` 在 PDF 创建真实高亮/批注。

## 已知限制

- 反向召回与图表跳转仅支持 PDF 附件（EPUB/快照有结构文本但无页坐标，可总结/对话但不定位）。
- 超长论文按「最大发送字符数」截断；大上下文模型可调高。
- 图表解读目前为文本上下文解释（caption + 邻近正文 + 该块文本层），暂不做图像视觉识别。
- 翻译仅「选中即译」；整篇/保留布局双语不做（可用 zoteropdftranslate）。
