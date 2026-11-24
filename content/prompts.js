/* prompts.js — central home for the SHARE / DECK generation prompts and the
 * maintained "skill core" (deck presets + paper-craft writing voices). Loaded
 * into the bootstrap sandbox after aireader.js; attaches everything to the
 * global AIReader via Object.assign, so the methods still call this.* siblings
 * (e.g. this._skillDirective, this._figureListText) that live in aireader.js.
 *
 * Keeping the share prompts here (instead of scattered through aireader.js)
 * makes them easy to find and tune in one place. (The chat / translate / skill
 * prompts still live in aireader.js for now; they can migrate here the same way.)
 *
 * Credits (design tokens + method distilled from):
 *   • frontend-slides (MIT, © 2025 Zara Zhang)  https://github.com/zarazhangrui/frontend-slides
 *   • paper-craft / paper-analyzer (bundled method, author's verbal consent)  https://github.com/zsyggg/paper-craft-skills
 */

Object.assign(AIReader, {
  // ---- maintained skill core: deck visual presets (real frontend-slides color/
  // font tokens as CSS custom properties) ----
  _deckPresets: {
    broadside: {
      id: "broadside", label: "大字海报",
      fonts: "https://fonts.googleapis.com/css2?family=Barlow:wght@400;700;800;900&display=swap",
      rootVars: ":root{--bg:#111111;--bg-alt:#1A1A18;--fg:#F0ECE5;--muted:#888880;--accent:#E85D26;--on-accent:#111111;--border:#282826;--font-display:'Barlow','Noto Sans SC',sans-serif;--font-body:'Barlow','Noto Sans SC',sans-serif;}",
      note: "抗议海报编辑风：墨黑底 + 唯一烈橙强调 + 超大 Barlow 粗体小写标题，字即图形，零装饰。",
    },
    "blue-professional": {
      id: "blue-professional", label: "商务蓝",
      fonts: "https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;700&display=swap",
      rootVars: ":root{--bg:#fdfae7;--bg-alt:#f4f0dd;--fg:#111111;--muted:#6b6b6b;--accent:#1e2bfa;--on-accent:#ffffff;--border:rgba(30,43,250,.2);--font-display:'Space Grotesk','Noto Sans SC',sans-serif;--font-body:'Space Grotesk','Noto Sans SC',sans-serif;}",
      note: "清爽专业：暖白底 + 电子蓝强调 + Space Grotesk，克制留白、适合汇报。",
    },
    monochrome: {
      id: "monochrome", label: "极简黑白",
      fonts: "https://fonts.googleapis.com/css2?family=Jost:wght@200;400;600&display=swap",
      rootVars: ":root{--bg:#FAFADF;--bg-alt:#F2F2D2;--fg:#1A1A16;--muted:#5E5E54;--accent:#1A1A16;--on-accent:#FAFADF;--border:#8A8A80;--font-display:'Jost','Noto Sans SC',system-ui,sans-serif;--font-body:'Jost','Noto Sans SC',system-ui,sans-serif;}",
      note: "极简：米纸底 + 墨黑 + 纤细 Jost，靠排版与留白，不用彩色。",
    },
  },
  _deckPreset(id) { return this._deckPresets[id] || this._deckPresets.broadside; },

  // ---- maintained skill core: paper-craft writing voices (distilled from
  // paper-analyzer's per-style hard standards) ----
  _articleVoices: {
    academic:
      "\n\n【写作风格 · 学术（paper-craft academic）】比论文更清晰的深度解析：术语准确不过度简化；准确引用论文定义与公式（有公式用 $…$/$$…$$）、引用图表标 Figure 号；客观陈述、少主观；结构 摘要→背景与动机→方法→实验→分析→结论，每节有明确技术目标，强调与相关工作对比；篇幅充分、论证扎实。",
    storytelling:
      "\n\n【写作风格 · 故事（paper-craft storytelling）】像一篇好读的深度公众号：钩子开头(反常识/共鸣场景，先让人好奇再讲技术)；多用“你”与读者对话；段落短(≤4 句)；技术词立刻给“人话解释”；关键处配类比；数据翻译成可感知的东西；结尾回到开头形成闭环 + 一句能被转述的金句。",
    concise:
      "\n\n【写作风格 · 精炼（paper-craft concise）】直给要点、结论先行、少铺陈：多用列表/对比表/速问速答承载信息，不写大段；每节只留最能说明问题的几个数字与结论。",
  },
  _articleVoice(id) { return this._articleVoices[id] || this._articleVoices.academic; },

  // ---- shared style note (de-AI + term handling) for share output ----
  _shareStyleNote() {
    return "语言：中文为主，专有名词/模型名/指标名/英文缩写保留原文（如 LoRA、RLHF、in-context）。" +
      "审美上避免 AI 套路：不空话套话、不堆排比、不用装饰性加粗、不滥用 emoji、不要升华式结尾。";
  },

  // ---- one-pager (Markdown summary) format ----
  _shareFormats() {
    const S = this._shareStyleNote();
    return [
      { id: "onepager", label: "一页总结", desc: "结构化 Markdown，适合存笔记", ext: "md", buildSystemPrompt: (lang) =>
        "你是论文分享助手，用" + lang + "把这篇论文浓缩成一页可分享的总结（Markdown）。按以下结构，每节具体、给数字、别空泛：\n" +
        "# 标题\n**一句话 TL;DR**（这篇到底做了什么、结论是什么）\n" +
        "## 背景与问题（它针对什么痛点）\n## 核心贡献（分条，每条一句话说清“新在哪”）\n" +
        "## 方法（关键设计与直觉，必要时给维度/公式）\n## 关键结果（引用具体数字与对比；相关图表用 [[fig:<id>]] 指出）\n" +
        "## 局限与开放问题\n## 一句话评价（值不值得读、适合谁）\n" +
        "要求：基于论文，关键论断后用 [B<id>] 标注依据；不臆造。" + S },
    ];
  },

  // ---- ARTICLE (paper-craft) prompts: outline → per-section ----
  _shareOutlinePrompt(lang, styleNote) {
    return "你是论文分享助手。读完论文后，规划一篇图文并茂深度长文的结构。只输出一个 JSON 对象（不要 ``` 包裹、不要任何多余文字）：\n" +
      '{"title":"论文标题","tldr":"一句话说清这篇做了什么、结论是什么","tags":["关键词",3至6个],"sections":[{"id":"s1","title":"章节标题","brief":"这一章要覆盖哪些要点（一两句）"}]}\n' +
      "**目标是把论文讲全、不漏要点**（不是只做几节好看的摘要）。按论文丰富度 6–11 节：\n" +
      "- **第一章固定「方法总览」**（整体方法论鸟瞰 + 一张总览图），**最后一章固定「速问速答」**（≥5 组 Q&A，覆盖 why/how/trade-off/常见疑问）。\n" +
      "- 为论文的**每个核心贡献**、**每组关键实验/结果**各安排一节（或拆多节），别把多个贡献挤成一节；中间覆盖：背景与问题、方法细节（关键设计/公式/步骤）、关键结果、消融/对比、局限与未来。\n" +
      "- 每个 brief 要把该节该覆盖的要点**逐条列出来**（给 3–6 个具体要点/数字的提示），别只写一句泛话。标题用" + lang + "。只输出 JSON。" + (styleNote || "") + this._skillDirective();
  },
  _shareSectionPrompt(lang, section, figList, styleNote, isOverview) {
    return "你是论文分享助手，用" + lang + "写深度长文中的这一个章节，只输出一个 <section> 元素（不要输出其它章节、不要 ``` 包裹、不要 <html>/<style>）。\n" +
      "章节 id=\"" + section.id + "\"，标题：" + section.title + "。要覆盖：" + (section.brief || section.title) + "。\n" +
      "格式：<section id=\"" + section.id + "\"><h2>" + section.title + "</h2> … </section>。\n" +
      (isOverview ? "【本章是「方法总览」：开头先给一张整体方法论总览图——优先用 [[fig:<id>]] 放本文的架构/流程图；没有合适图就用一段 ```svg 手绘总览图（根 <svg> 带 viewBox、不固定像素宽高）放进 <div class=\"svg-wrap\">…<div class=\"caption\">图1·方法总览</div></div>。然后用一段 <p class=\"lead\"> 概述整体思路。】\n" : "") +
      "【覆盖优先 + 结构化：把本章要覆盖的要点讲全，一个都别漏；但用结构承载、不要写成大段文字墙。】\n" +
      "· **务必覆盖上面「要覆盖」里列出的每一个要点**（论文里的具体数字、设定、步骤、消融、结论都要落到纸面），信息多宁可长一点也不要为了简洁省略要点。\n" +
      "· 组织方式：用 <h3> 小标题分点 + <ul> 列表 + <table> 把要点列清楚，而不是堆长段落；需要叙述时 <p> 最多 3-4 行就断开。\n" +
      "· 开头用一句 <p class=\"lead\">…</p> 点明本章结论。关键数字/结论/术语用 <span class=\"highlight\">…</span> 或 <strong>…</strong> 高亮；本章最重要的一条洞见放进 <div class=\"callout\">…</div>（每章最多 1 个）。\n" +
      "按内容需要选用组件（样式已定义，直接用 class）：维度/数据流 <div class=\"dim\">[B,N,d]→…</div>；优缺点 <div class=\"pros-cons\"><div class=\"pros\"><h4>优点</h4><ul>…</ul></div><div class=\"cons\"><h4>局限</h4><ul>…</ul></div></div>；多项对比用 <table>（带表头）；流程/架构用 ```svg 手绘（根 <svg> 带 viewBox、不固定像素宽高）放进 <div class=\"svg-wrap\">…<div class=\"caption\">图N·说明</div></div>。\n" +
      "若本章是速问速答，用 <div class=\"qa\"><div class=\"q\">问题</div><div class=\"a\">回答（带具体数字/方法）</div></div>，≥5 条，覆盖 why/how/trade-off。\n" +
      "要展示论文自己的图表时用 [[fig:<id>]] 占位（会被替换成真实图片）。可用图表清单：\n" + (figList || "（无）") + "\n" +
      "关键论断后可用 [B<id>]；不臆造、图表不编造。" + this._shareStyleNote() + (styleNote || "") + this._skillDirective();
  },

  // ---- DECK (frontend-slides) prompts: outline → per-slide ----
  _deckOutlinePrompt(lang) {
    return "你是演示文稿设计师。读完论文后，规划一套可放映幻灯片的页目。只输出一个 JSON 对象（不要 ``` 包裹、不要多余文字）：\n" +
      '{"title":"论文标题","sections":[{"id":"s1","title":"这一页的短标题","brief":"这一页要覆盖哪些关键点（具体列出，不要只写一句泛话）"}]}\n' +
      "**目标是把论文的关键信息讲清楚、不漏要点，而不是只做几页好看的海报。** 8–14 页，宁可多一页也不要把重要内容省掉：\n" +
      "- 第一页固定「封面」（标题+一句话结论+作者/会议）；第二页固定「方法总览」（整体方法论+总览图）。\n" +
      "- 为论文的**每个核心贡献**、**每组关键实验/结果**各安排一页（或拆多页），别把多个贡献挤成一句。\n" +
      "- 覆盖：背景与问题、方法细节（关键设计/公式/步骤）、关键结果（具体数字与对比）、消融/对比、局限与未来。\n" +
      "- **倒数第二页固定「速问速答」**（3–5 组 Q&A，覆盖 why/how/trade-off/常见疑问），最后一页「一句话总结」。\n" +
      "- 每个 brief 要把该页该讲的要点**逐条列出来**（给 3–6 个要点/数字的提示），好让后续每页内容充实。标题用" + lang + "。只输出 JSON。" + this._skillDirective();
  },
  _deckSlidePrompt(lang, preset, slide, figList, isTitle, isOverview) {
    return "你在做一套放映幻灯中的**这一页**，用" + lang + "。只输出一个 <section" + (isTitle ? " class=\"slide title-slide\"" : " class=\"slide\"") + "> 元素——不要 <style>/<html>、不要其它页、不要 ``` 包裹。\n" +
      "这一页标题：" + slide.title + "；要覆盖：" + (slide.brief || slide.title) + "。\n" +
      "画布固定 1920×1080，用 px（标题 ~72–104px、正文/要点 ~26–32px、内边距 ~64–72px，不要用 vw）。\n" +
      (isTitle ? "这是封面：大号论文标题 + 一句话结论 + 作者/会议，留白大气（封面可以简）。\n"
               : "【信息优先，不是极简海报】把本页该讲的关键点**完整列出来**，别为了好看省略重要内容：用 <ul> 列 4–8 条要点，或 2–4 个要点卡片、或对比 <table>；每条要点都带具体内容（数字、方法步骤、术语），不要只写标题词。信息多就用高密度「阅读型」排版，但保持可读（正文 ≥24px、不溢出一屏）。关键数字/结论用 var(--accent) 或加粗强调。\n") +
      "配色/字体用这些 CSS 变量（已全局定义）：本页 background:var(--bg);color:var(--fg);，强调色 var(--accent)，次要文字 var(--muted)，标题 font-family:var(--font-display)、正文 var(--font-body)。\n" +
      (isOverview ? "这是「方法总览」页：先放一张总览图（优先 [[fig:<id>]] 本文架构/流程图；没有就 ```svg 手绘，根 <svg> 带 viewBox、不固定像素宽高），再用 3–5 条要点概述整体方法。\n" : "") +
      (/速问速答|问答|Q ?& ?A|面试/i.test(slide.title || "") ? "这是「速问速答」页：用问答卡片布局，每条「问题 + 带具体数字/方法的回答」，≥3 组，覆盖 why/how/trade-off/常见疑问。\n" : "") +
      "结果类页务必给论文里的具体数字与对比。展示论文自己的图表用 [[fig:<id>]] 占位（会替换成真实图片）。可用图表：\n" + (figList || "（无）") + "\n" +
      "【风格：" + (preset.label || "") + "】" + (preset.note || "") + this._shareStyleNote() + this._skillDirective();
  },

  // ---- reading-skill accessors (the SKILLS/COMMON_PRESETS data arrays stay in
  // aireader.js as chip data; these just pick the active skill + its directive) ----
  _skillId() {
    const id = (this.getPref("skill") || "").trim();
    return this.SKILLS.some((s) => s.id === id) ? id : this.SKILLS[0].id;
  },
  currentSkill() {
    const id = this._skillId();
    return this.SKILLS.find((s) => s.id === id) || this.SKILLS[0];
  },
  _skillDirective() {
    const s = this.currentSkill();
    return (s && s.inject) ? ("\n\n【阅读技能：" + s.label + "】\n" + s.inject) : "";
  },

  // ---- chat / compare system prompts + the shared style guide ----
  systemPrompt(ctx) {
    const lang = this.getPref("language") || "中文";
    return "你是针对某一篇学术论文的阅读助手，用" + lang + "回答。论文正文按块给出，每块形如 [B<id> p<页码>] 文本。要求：\n" +
      "1) 回答必须基于论文；论文没涉及的就说没涉及。\n" +
      "2) 在每个关键论断后用 [B<id>] 标出依据的块（可多个），方便用户点回原文。\n" +
      "3) 当用户要求划线/标注，或你认为某处值得高亮时，可输出指令：划线用 [[hl:<id>]]，加批注用 [[note:<id>|批注内容]]。这些会渲染成按钮由用户一键应用到 PDF。\n" +
      "4) 当用户想看某个图/表的视觉内容、或你需要看图才能准确解释时，输出 [[fig:<id>]]（id 为图/表块），会渲染该区域图像并交给多模态模型识图。\n" +
      "5) 若正文前附有【用户在 PDF 中的高亮与批注】，当用户问到『我的高亮/批注』时请优先结合这些内容回答。\n" +
      "6) 需要用图示说明（流程、架构、时间线、关系等）时，请输出一个 ```svg 代码块，会被内联渲染成矢量图。要点：用 <rect>/<text>/<line>/<path>/<polygon> 等手绘；根 <svg> 必须带 viewBox 定义坐标系（不要写固定像素 width/height，会自适应容器宽度）；viewBox 宽度建议 ≤ 600，框与文字不要重叠、箭头对齐、字号分层、留白充足、元素对齐。审美上避免 AI 设计套路：配色克制（中性色带一点偏向强调色的色相、再加一个强调色，别用纯灰；别套用米色+衬线+赭石、紫蓝渐变、荧光绿点缀这类默认风格），不要用 emoji、不要什么都居中或一律圆角；编号(01/02/03)只在内容确实是有序步骤时才用。不要用 mermaid（本环境无法渲染，只会显示源码）。仅在确实有助于理解时才画。\n\n" +
      this._styleGuide() +
      this._customPrompt() +
      "论文内容：\n\n" + ctx;
  },
  _customPrompt() {
    const c = (this.getPref("customPrompt") || "").trim();
    return c ? ("【用户自定义要求】（在不破坏上述引用/工具/画图规则的前提下遵循）\n" + c + "\n\n") : "";
  },
  _styleGuide() {
    return "【表达风格】像懂行的人跟同行说话：直接、具体、克制，别带 AI 腔。\n" +
      "- 先说结论，别铺垫；不要“让我们深入探讨 / 首先需要明确 / 综上所述”这类套路开场和升华式收尾，也别用“这不仅是 X，更是 Y”的句式或金句式独句结尾。\n" +
      "- 不堆排比和“三件套”，该列几点就几点；少用破折号串句，多用短句和句号。\n" +
      "- 不用空话套话与夸大词（如“值得注意的是 / 不言而喻 / 彰显 / 赋能 / 生态 / 闭环 / 助力 / 至关重要 / 深刻洞察 / 一探究竟”），换成平实的说法。\n" +
      "- 不写“专家认为 / 研究表明”这类空泛背书；有依据就用 [B<id>] 指向原文，没有就别编。\n" +
      "- 不用装饰性加粗和 emoji，小标题用普通短语；不复述问题，不说“希望对你有帮助”之类客套。\n" +
      "- 术语按中文科技写作习惯处理：模型名、指标名、专业名词、英文缩写（如 SFT、RLHF、VQA、gold label/gold data）保留原文，不要生硬直译——例如 gold 在“gold 数据 / 黄金标准”语境里不要译成“黄金”；没有通行译名就保留英文并在括号里给出解释。\n" +
      "- 无论用哪种语言回答，都遵循以上风格，读起来像人写的，而不是模板。\n\n";
  },
  _multiSystemPrompt(ctx, n) {
    const lang = this.getPref("language") || "中文";
    return "你是学术论文对比阅读助手，用" + lang + "回答。下面给出了 " + n + " 篇论文各自的相关片段（按『【论文 i · 标题】』分节，片段中的 (p页码) 为页码）。要求：\n" +
      "1) 基于这些片段对比/综合作答，明确区分每篇的观点与贡献，不要混淆来源。\n" +
      "2) 引用某篇时写（论文i · p页），不要用 [B<id>] 这类单篇徽标。\n" +
      "3) 片段可能是节选；信息不足以回答时如实说明，不要臆造。\n" +
      "4) 适合时用表格并列对比各篇的方法/数据/结论。\n\n" +
      this._styleGuide() + this._customPrompt() +
      "各篇论文相关片段：\n\n" + ctx;
  },
  // ---- full-text translation system prompt ----
  _buildTranslatePrompt(targetLang) {
    return "你是专业学术翻译。只翻译「待翻译」区里带编号的段落，翻译成" + targetLang + "。严格要求：\n" +
      "- 逐段翻译，输出每段一行，格式为 [[n]] 译文（n 为原段编号）；不要输出原文、不要加任何说明或标题。\n" +
      "- 「上文」「下文」区仅供理解上下文与保持术语一致，绝对不要翻译它们、也不要为它们编号输出。\n" +
      "- 段落编号必须与「待翻译」区一一对应，不得漏段、合并或拆分。\n" +
      "- 保留数学公式、变量符号、文献引用标记（如 [12]、(Smith et al., 2024)）、以及英文专有名词/模型名/缩写原样（如 Transformer、RLHF、LoRA）。\n" +
      "- 忠实、通顺，符合" + targetLang + "科技写作习惯，前后术语保持一致。";
  },

  _shareSkillsLoaded: true,
});
