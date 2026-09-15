#!/usr/bin/env node
// Companion to tick-triage-section.mjs, for task 12's full closure: many commits appear in SEVERAL
// subsystem sections (a merge or a widely-touching refactor lands in every section whose watched file
// it happens to touch). Once a commit's disposition has been decided ONCE (by reading its real diff),
// this ticks every occurrence of that exact SHA across the whole file - never a blanket tick, always
// keyed to a specific commit already reviewed.
//
//   node scripts/tick-triage-sha.mjs <sha10> [<sha10> ...]
import { readFileSync, writeFileSync } from "node:fs";

const FILE = "docs/rrf-triage/3.6.3..3.7.0-rc.1.md";
const shas = process.argv.slice(2);
if (shas.length === 0) { console.error("usage: tick-triage-sha.mjs <sha10> [<sha10> ...]"); process.exit(1); }

const text = readFileSync(FILE, "utf-8");
const eol = text.includes("\r\n") ? "\r\n" : "\n";
const lines = text.split(/\r\n|\n/);

let total = 0;
for (const sha of shas) {
	let n = 0;
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].startsWith("- [ ]") && lines[i].includes("`" + sha + "`")) {
			lines[i] = "- [x]" + lines[i].slice(5);
			n++;
		}
	}
	console.log(`${sha}: ticked ${n} occurrence(s)`);
	total += n;
}

writeFileSync(FILE, lines.join(eol));
console.log(`Total ticked: ${total}`);
