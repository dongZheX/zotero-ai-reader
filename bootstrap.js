/* AI Reader — Zotero bootstrap entry point */

var AIReader;

function install() {}
function uninstall() {}

async function startup({ id, version, rootURI }) {
  // Load the main module into this bootstrap sandbox (defines global AIReader).
  Services.scriptloader.loadSubScript(rootURI + "content/aireader.js");
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
