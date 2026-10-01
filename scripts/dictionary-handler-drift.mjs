#!/usr/bin/env node
/**
 * Second signal for E4 of `FIRMWARE-CHANGES-PLAN.md`, independent of `dictionary-param-history.mjs`: for each command, the
 * lines of its handler (dispatch `case` plus the `GCodeBuffer` helpers it calls, as that script follows them) that READ A
 * PARAMETER, normalised for whitespace, compared at every tracked release. A command whose read-lines are identical at
 * every release is "stable": no letter can have appeared, gone or moved inside the text we follow. A command whose lines
 * differ is printed with the added/removed lines so a human reads the change. It cannot see a callee that is not followed
 * (`unresolved`), so those are reported as "cannot tell", never "stable".
 *
 *   node scripts/dictionary-handler-drift.mjs M25,M600 [--rrf <clone>] [--out report.md]
 *   node scripts/dictionary-handler-drift.mjs --unchecked [--out report.md]     (every code without `historyChecked`)
 *
 * Needs `npm run build` (reads `dist/`) and an RRF clone.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { defaultRrfClone } from "./lib/rrfClone.mjs";
import { dispatchCases, gcodeFunctions, handlerText, loadTree } from "./lib/rrfSource.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
let clone = defaultRrfClone();
let out = null;
let unchecked = false;
const wanted = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--rrf") clone = argv[++i] ?? clone;
	else if (argv[i] === "--out") out = argv[++i] ?? null;
	else if (argv[i] === "--unchecked") unchecked = true;
	else wanted.push(...argv[i].split(",").filter(Boolean));
}

const { RELEASES } = await import(pathToFileURL(join(ROOT, "dist", "releases", "releases.js")).href);
const { COMMANDS } = await import(pathToFileURL(join(ROOT, "dist", "dictionary", "commands.js")).href);
const codes = unchecked ? Object.values(COMMANDS).filter((c) => c.historyChecked === undefined && !c.code.includes(".")).map((c) => c.code) : wanted;
if (codes.length === 0) {
	console.error("usage: node scripts/dictionary-handler-drift.mjs <M25,M600,...> | --unchecked  [--out file]");
	process.exit(2);
}

function citedFiles(spec) {
	const files = new Set();
	for (const t of [...(spec.sources ?? []), ...spec.parameters.flatMap((p) => p.sources ?? [])]) for (const m of t.matchAll(/([A-Za-z0-9_/]+\.cpp)/g)) files.add(m[1]);
	return [...files];
}

/** The parameter-reading lines of a handler text, whitespace- and comment-normalised, in source order. */
const READ = /\b(?:Seen|SeenAny|MustSee|TryGet\w*|Get\w*(?:Value|Array|String|Id|Distance|Acceleration|Speed)\w*|GetDriverId\w*|GetCommandFraction)\s*\(|\bparser\.Get\w*Param\(/;
function readLines(text) {
	return text.split("\n").map((l) => l.replace(/\/\/.*$/, "").replace(/\s+/g, " ").trim()).filter((l) => l !== "" && READ.test(l));
}

const evidence = new Map(codes.map((c) => [c, []]));
for (const r of RELEASES) {
	process.stderr.write(`${r.version}: loading ... `);
	const tree = loadTree(clone, r.commit);
	const cases = dispatchCases(tree);
	const defs = gcodeFunctions(tree);
	process.stderr.write("done\n");
	for (const code of codes) {
		const spec = COMMANDS[code];
		if (spec === undefined) continue;
		const h = handlerText(cases, defs, code.replace(/\.\d+$/, ""), citedFiles(spec));
		evidence.get(code).push(h === null ? null : { lines: readLines(h.text), unresolved: h.unresolved.filter((n) => !/^(?:printf|memcpy|memset|strcmp|snprintf|[A-Z0-9_]+)(?![A-Za-z])/.test(n)) });
	}
}

const versions = RELEASES.map((r) => r.version);
const md = ["# Handler drift (generated)", "", "`scripts/dictionary-handler-drift.mjs`. STABLE = every release has the same parameter-reading lines. See the script header for what this cannot see.", ""];
const stable = [], drift = [], unresolvedCodes = [], absent = [];
for (const code of codes) {
	const cells = evidence.get(code);
	if (cells === undefined || cells.length === 0) continue;
	const present = cells.map((c, i) => (c === null ? null : i)).filter((i) => i !== null);
	if (present.length === 0) { absent.push(code); continue; }
	const uns = [...new Set(cells.flatMap((c) => c?.unresolved ?? []))];
	if (present.length < cells.length) { drift.push(code); md.push(`## ${code}`, "", `Has a dispatch case only at: ${present.map((i) => versions[i]).join(", ")}`, ""); continue; }
	const sig = cells.map((c) => c.lines.join("\n"));
	if (new Set(sig).size === 1) {
		(uns.length > 0 ? unresolvedCodes : stable).push(code);
		continue;
	}
	drift.push(code);
	md.push(`## ${code}`, "");
	let prev = 0;
	for (let i = 1; i < cells.length; i++) {
		if (sig[i] === sig[prev]) continue;
		const a = new Set(cells[prev].lines), b = new Set(cells[i].lines);
		const removed = [...a].filter((l) => !b.has(l)), added = [...b].filter((l) => !a.has(l));
		md.push(`${versions[prev]} -> ${versions[i]}:`, "", ...removed.map((l) => `- \`${l}\``), ...added.map((l) => `+ \`${l}\``), "");
		prev = i;
	}
	if (uns.length > 0) md.push(`(unresolved callees: ${uns.join(", ")})`, "");
}
md.push("## Summary", "", `STABLE (${stable.length}): ${stable.join(" ")}`, "", `STABLE INSIDE FOLLOWED TEXT ONLY, callees unresolved (${unresolvedCodes.length}): ${unresolvedCodes.join(" ")}`, "", `DRIFT, read the diffs above (${drift.length}): ${drift.join(" ")}`, "", `No dispatch case at any release (${absent.length}): ${absent.join(" ")}`, "");
const text = md.join("\n");
if (out !== null) writeFileSync(out, text);
else console.log(text);
