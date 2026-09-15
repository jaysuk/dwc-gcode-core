#!/usr/bin/env node
// One-off helper for closing docs/rrf-triage/3.6.3..3.7.0-rc.1.md section by section (task 12's full
// closure). Ticks every "- [ ]" line within ONE named "## <Section> (N)" block only (never touches
// any other section), and inserts a one-line summary right after the header if given. Scoped
// on purpose - a global tick-all was tried once by hand and immediately reverted; this can't repeat
// that mistake because it only ever touches the lines between one header and the next "## ".
//
//   node scripts/tick-triage-section.mjs "<Section Name>" "<summary line>"
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "docs/rrf-triage/3.6.3..3.7.0-rc.1.md";
const [, , sectionArg, summary] = process.argv;
if (!sectionArg) { console.error("usage: tick-triage-section.mjs \"<Section Name>\" [\"summary\"]"); process.exit(1); }

const text = readFileSync(FILE, "utf-8");
const eol = text.includes("\r\n") ? "\r\n" : "\n";
const lines = text.split(/\r\n|\n/);
const headerRe = new RegExp(`^## ${sectionArg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\(\\d+\\)$`);
const startIdx = lines.findIndex((l) => headerRe.test(l));
if (startIdx === -1) { console.error("section not found:", sectionArg); process.exit(1); }
let endIdx = lines.length;
for (let i = startIdx + 1; i < lines.length; i++) {
	if (lines[i].startsWith("## ")) { endIdx = i; break; }
}

let ticked = 0;
for (let i = startIdx; i < endIdx; i++) {
	if (lines[i].startsWith("- [ ]")) { lines[i] = "- [x]" + lines[i].slice(5); ticked++; }
}

if (summary) {
	// Insert right after the header (and after any existing blank/summary line already there).
	let insertAt = startIdx + 1;
	if (lines[insertAt] === "") insertAt++;
	lines.splice(insertAt, 0, summary, "");
}

writeFileSync(FILE, lines.join(eol));
console.log(`Ticked ${ticked} item(s) in section "${sectionArg}".`);
