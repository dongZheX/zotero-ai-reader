/* AI Reader — Zotero bootstrap entry point */

var AIReader;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  // Vendored rendering libs (define globals `marked` and `katex` in this scope).
  try { Services.scriptloader.loadSubScript(rootURI + "content/vendor/marked.min.js"); } catch (e) { Zotero.logError(e); }
  try { Services.scriptloader.loadSubScript(rootURI + "content/vendor/katex/katex.min.js"); } catch (e) { Zotero.logError(e); }
  // Load the main module into this bootstrap sandbox (defines global AIReader).
  Services.scriptloader.loadSubScript(rootURI + "content/aireader.js");
  // Domain modules — each Object.assign(AIReader, …) onto the core above.
  try { Services.scriptloader.loadSubScript(rootURI + "content/net.js"); } catch (e) { Zotero.logError(e); }
  // Share/deck generation prompts + the maintained skill core (presets / voices).
  try { Services.scriptloader.loadSubScript(rootURI + "content/prompts.js"); } catch (e) { Zotero.logError(e); }
  // Share generator (article/deck/one-pager) + full-text translate pipeline.
  try { Services.scriptloader.loadSubScript(rootURI + "content/share.js"); } catch (e) { Zotero.logError(e); }
  // Block model + context builders + snapshot navigation.
  try { Services.scriptloader.loadSubScript(rootURI + "content/blocks.js"); } catch (e) { Zotero.logError(e); }
  // Read-&-annotate agent + annotation writers + directive application.
  try { Services.scriptloader.loadSubScript(rootURI + "content/annotate.js"); } catch (e) { Zotero.logError(e); }
  // Agent tool-calling loop + web tools + scholarly discovery.
  try { Services.scriptloader.loadSubScript(rootURI + "content/tools.js"); } catch (e) { Zotero.logError(e); }
  // Conversation (history/compaction/send) + multi-paper compare + persistence.
  try { Services.scriptloader.loadSubScript(rootURI + "content/chat.js"); } catch (e) { Zotero.logError(e); }
  // Panel UI + rendering + reader selection popup (loaded last; carries _el/setStatus/requireKey).
  try { Services.scriptloader.loadSubScript(rootURI + "content/ui.js"); } catch (e) { Zotero.logError(e); }
  AIReader.init({ id, version, rootURI });
  await AIReader.registerAll();
}

function shutdown() {
  if (AIReader) {
    AIReader.unregisterAll();
    AIReader = undefined;
  }
}

// When the main window opens/closes after startup, (re)attach UI if needed.
function onMainWindowLoad({ window }) {
  AIReader?.onMainWindowLoad?.(window);
}
function onMainWindowUnload({ window }) {
  AIReader?.onMainWindowUnload?.(window);
}
