#!/usr/bin/env node
// Standalone entry point for the qsTr() extractor. The implementation lives in
// lib.mjs so that scripts/hanhua.mjs can reuse it without spawning a process.
//
// Usage: node scripts/hanhua/extract-qsTr.mjs [--out FILE] [--root DIR]
//
// Output is a JSON document:
//   { "generated": "...", "entries": [ { context, source, locations: [] } ] }

import { writeFileSync } from "node:fs";
import { join, relative } from "node:path";

import { extractQsTr, REPO_ROOT, writeText } from "./lib.mjs";

const argv = process.argv.slice(2);
let out = join(REPO_ROOT, "scripts", "hanhua", "data", "qsTr.json");
let root = REPO_ROOT;
for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--out") out = argv[++i];
    else if (argv[i] === "--root") root = argv[++i];
}

const { entries, unsupported, files, callSites } = extractQsTr(root);

writeText(out, JSON.stringify({ generated: new Date().toISOString(), entries }, null, 2) + "\n");

console.log(`scanned ${files} QML files`);
console.log(`${callSites} qsTr call sites -> ${entries.length} unique strings`);
console.log(`wrote ${relative(root, out)}`);
if (unsupported.length) {
    console.error(`\n${unsupported.length} unsupported call(s):`);
    for (const line of unsupported) console.error("  " + line);
    // Reported, not fatal: the one occurrence today is unreachable code.
    process.exitCode = 0;
}
