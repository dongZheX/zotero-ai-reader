// Shared test loader: runs the plugin's content/*.js into a vm context in the
// SAME order bootstrap.js loads them, so tests keep working as the single
// aireader.js is split into domain modules (each does Object.assign(AIReader,…)).
// When a new module is added, append it here once.
const fs = require('fs'), vm = require('vm'), path = require('path');
const repoRoot = path.join(__dirname, '..');

// JS modules that define/extend the global AIReader (mirrors bootstrap.js order;
// marked/katex are UI-only and not needed headless).
const MODULES = [
  'content/aireader.js',
  'content/net.js',
  'content/prompts.js',
  'content/share.js',
  'content/blocks.js',
  'content/docreader.js',
  'content/annotate.js',
  'content/tools.js',
  'content/chat.js',
  'content/ui.js',
  'content/capture.js',
  'content/share-agent.js',
];

// Load the modules into an already-built ctx (with whatever Zotero/fetch stubs
// the test needs). Returns ctx.AIReader.
function loadInto(ctx) {
  if (!('AIReader' in ctx)) ctx.AIReader = undefined;
  vm.createContext(ctx);
  for (const m of MODULES) vm.runInContext(fs.readFileSync(path.join(repoRoot, m), 'utf8'), ctx, { filename: m });
  return ctx.AIReader;
}

module.exports = { loadInto, MODULES, repoRoot };
