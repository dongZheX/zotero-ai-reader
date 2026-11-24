pref("extensions.zotero.aireader.apiFormat", "auto");
pref("extensions.zotero.aireader.baseURL", "https://api.openai.com/v1");
pref("extensions.zotero.aireader.apiKey", "");
pref("extensions.zotero.aireader.model", "gpt-4o-mini");
pref("extensions.zotero.aireader.language", "中文");
pref("extensions.zotero.aireader.temperature", ""); // empty = use the model's default (field omitted; some models reject a custom temperature)
pref("extensions.zotero.aireader.maxChars", 60000);
pref("extensions.zotero.aireader.maxTokens", 0);
pref("extensions.zotero.aireader.serperKey", "");
pref("extensions.zotero.aireader.customPrompt", "");
pref("extensions.zotero.aireader.skill", "deep-read");
pref("extensions.zotero.aireader.maxParallelTools", 3);
pref("extensions.zotero.aireader.syncChats", true);
pref("extensions.zotero.aireader.shareTheme", "article-academic"); // 分享引擎 id：article-academic/storytelling/concise（paper-craft 长文）或 deck/deck-pro/deck-mono（frontend-slides 放映）
// Developer-only eval bridge (off by default). See scripts/zdev.mjs + CLAUDE.md.
pref("extensions.zotero.aireader.devBridge", false);
