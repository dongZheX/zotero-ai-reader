#!/usr/bin/env node
// zdev — a tiny REPL into a *running* Zotero, via the AI Reader dev bridge.
//
// The plugin (when pref extensions.zotero.aireader.devBridge is true) polls
// <DataDir>/aireader-dev/cmd.json and runs the `code` as an async function body
// with `this` === AIReader, writing the result to out.json. This script writes a
// command, waits for the matching result, and prints it.
//
// Usage:
//   node scripts/zdev.mjs 'return this.version'                 # inline code
//   node scripts/zdev.mjs -f snippet.js                          # code from file
//   echo 'return Object.keys(this)' | node scripts/zdev.mjs      # code from stdin
//
// The code runs in the live plugin scope. Available: this (AIReader), Zotero,
// PathUtils, IOUtils, Services, log(msg). `return` whatever you want to inspect.
//
// Env:
//   ZOTERO_DATA_DIR   override the Zotero data dir (default ~/Zotero)
//   ZDEV_TIMEOUT_MS   how long to wait for a result (default 25000)
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const dataDir = process.env.ZOTERO_DATA_DIR || join(homedir(), "Zotero");
const dir = join(dataDir, "aireader-dev");
const cmdPath = join(dir, "cmd.json");
const outPath = join(dir, "out.json");
const timeoutMs = Number(process.env.ZDEV_TIMEOUT_MS || 25000);

async function readCode() {
  const args = process.argv.slice(2);
  if (args[0] === "-f" && args[1]) return await readFile(args[1], "utf8");
  if (args.length && args[0] !== "-") return args.join(" ");
  // stdin
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const code = (await readCode()).trim();
  if (!code) { console.error("zdev: no code given"); process.exit(2); }
  await mkdir(dir, { recursive: true });
  const seq = Date.now();
  await writeFile(cmdPath, JSON.stringify({ seq, code }), "utf8");

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(150);
    if (!existsSync(outPath)) continue;
    let out;
    try { out = JSON.parse(await readFile(outPath, "utf8")); } catch { continue; }
    if (!out || out.seq !== seq) continue;
    if (Array.isArray(out.logs) && out.logs.length) {
      for (const l of out.logs) console.error("[log] " + l);
    }
    if (out.ok) {
      const r = out.result;
      console.log(typeof r === "string" ? r : JSON.stringify(r, null, 2));
      process.exit(0);
    } else {
      console.error("ERROR: " + out.error);
      process.exit(1);
    }
  }
  console.error("zdev: timed out after " + timeoutMs + "ms (is Zotero running with devBridge on?)");
  process.exit(3);
}

main().catch((e) => { console.error(e); process.exit(1); });
