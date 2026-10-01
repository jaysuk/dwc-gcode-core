#!/usr/bin/env node
/**
 * E4 of `FIRMWARE-CHANGES-PLAN.md`: for each dictionary command, which of its parameter letters RRF's handler reads at
 * every tracked release, and which letters it reads that the dictionary does not list. A CANDIDATE generator, not an
 * oracle: every proposed `since`/`until` is confirmed with `git show <release>:<file>` and cited before it is written.
 * Needs `npm run build` (reads `dist/`) and an RRF clone (`--rrf`, `$RRF_CLONE`, `../RepRapFirmware`).
 *
 *   node scripts/dictionary-param-history.mjs M140,M201,M558.4 [--out report.md]
 *   node scripts/dictionary-param-history.mjs --batch config [--out report.md]
 *
 * How: at each release's own commit, the handler text is the command's dispatch `case` plus the `GCodeBuffer` functions it
 * calls (looked up in the files the entry's `sources` cite, three levels deep), and a letter is "read" when that text has
 * `Seen('X')`, `MustSee('X')`, `TryGet*('X'`, `Get*('X'` or a `SeenAny("..X..")`. Limits, all printed as flags:
 *  - a fractional code (`M558.4`) shares its integer code's `case`, so its evidence is COARSE (letters of any fraction);
 *  - a callee with no definition found is listed under `unresolved`: a letter missing there is "cannot tell", not absent;
 *  - `#if` blocks are all counted, so a letter read only in a build-time-conditional branch counts as read;
 *  - `3.6.3` is a separate branch that `3.7.0-alpha.2` does not contain: a letter absent at alpha.2 but present at 3.6.3
 *    and later is a GAP for a human (usually a 3.6.x-only change), never folded into a range.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { defaultRrfClone } from "./lib/rrfClone.mjs";
import { dispatchCases, gcodeFunctions, handlerText, lettersRead, loadTree, readsLetter } from "./lib/rrfSource.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
let clone = defaultRrfClone();
let out = null;
let batch = null;
const wanted = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--rrf") clone = argv[++i] ?? clone;
	else if (argv[i] === "--out") out = argv[++i] ?? null;
	else if (argv[i] === "--batch") batch = argv[++i] ?? null;
	else wanted.push(...argv[i].split(",").filter(Boolean));
}

const { RELEASES } = await import(pathToFileURL(join(ROOT, "dist", "releases", "releases.js")).href);
const { COMMANDS } = await import(pathToFileURL(join(ROOT, "dist", "dictionary", "commands.js")).href);

const BATCHES = {
	config: ["M950", "M584", "M569", "M569.1", "M308", "M558", "M558.1", "M558.2", "M558.3", "M558.4", "M574", "M671", "M92", "M906", "M913", "M201", "M203", "M204", "M208", "M140", "M141", "M143", "M307", "M563", "M550", "M552", "M553", "M554", "M586", "M587", "M589", "M591", "M592", "M593", "M595", "M955", "M956", "M18", "M17", "G31", "G10"],
};
const codes = batch !== null ? BATCHES[batch] : wanted;
if (codes === undefined || codes.length === 0) {
	console.error("usage: node scripts/dictionary-param-history.mjs <M140,M201,...> | --batch config  [--out file]");
	process.exit(2);
}

/** The source files a dictionary entry cites (`Endstops/EndstopsManager.cpp:392`), plus its dispatcher file. */
function citedFiles(spec) {
	const texts = [...(spec.sources ?? []), ...spec.parameters.flatMap((p) => p.sources ?? [])];
	const files = new Set();
	for (const t of texts) for (const m of t.matchAll(/([A-Za-z0-9_/]+\.cpp)/g)) files.add(m[1]);
	return [...files];
}

const specs = new Map();
for (const code of codes) {
	const spec = COMMANDS[code];
	if (spec === undefined) { console.error(`no dictionary entry for ${code}`); continue; }
	specs.set(code, spec);
}

const versions = RELEASES.map((r) => r.version);
/** code -> version -> { present: Set<letter>, all: Set<letter>, unresolved, implemented } */
const evidence = new Map([...specs.keys()].map((c) => [c, new Map()]));

for (const r of RELEASES) {
	process.stderr.write(`${r.version} (${r.commit}): loading ... `);
	const tree = loadTree(clone, r.commit);
	const cases = dispatchCases(tree);
	const defs = gcodeFunctions(tree);
	process.stderr.write(`${tree.size} files, ${cases.size} codes\n`);
	for (const [code, spec] of specs) {
		const base = code.replace(/\.\d+$/, "");
		const h = handlerText(cases, defs, base, citedFiles(spec));
		const cell = h === null
			? { implemented: false, present: new Set(), all: new Set(), unresolved: [] }
			: {
				implemented: true,
				present: new Set(spec.parameters.filter((p) => readsLetter(h.text, p.letter)).map((p) => p.letter)),
				all: lettersRead(h.text),
				// a callee that is a macro or libc call is not a helper that could read a letter
				unresolved: h.unresolved.filter((n) => !/^(?:printf|memcpy|memset|strcmp|snprintf|SUPPORT_[A-Z0-9_]+|[A-Z0-9_]+)(?![A-Za-z])/.test(n)),
				variableLetters: /(?:axisLetters|extrudeLetter)/.test(h.text),
			};
		evidence.get(code).set(r.version, cell);
	}
}

const md = [];
md.push("# Parameter history candidates (generated)", "", `Generated by \`scripts/dictionary-param-history.mjs\` for ${[...specs.keys()].join(", ")}. Candidates only: confirm each with \`git show <release>:<file>\`. See that script's header for what it cannot see.`, "");
/** code -> reasons a human still has to look (empty = every automatic check passed) */
const needsHuman = new Map();
for (const [code, spec] of specs) {
	const cells = versions.map((v) => evidence.get(code).get(v));
	const coarse = code.includes(".");
	const problems = [];
	if (coarse) problems.push("fractional code: a shared integer case, evidence is coarse");
	md.push(`## ${code}${coarse ? " (fractional: evidence is the whole integer case, COARSE)" : ""}`, "");
	const implemented = cells.map((c) => c.implemented);
	const firstImpl = implemented.indexOf(true);
	if (firstImpl < 0) { md.push("No dispatch case at any release (macro-only or compound entry).", ""); problems.push("no dispatch case"); }
	else {
		if (implemented.includes(false) && spec.since === undefined && spec.until === undefined) problems.push("case missing at some release but the dictionary has no since/until");
		if (firstImpl > 0 || implemented.includes(false)) md.push(`Command has a case ${implemented.map((b, i) => (b ? versions[i] : null)).filter(Boolean).length === versions.length ? "everywhere" : `from ${versions[firstImpl]} to ${versions[implemented.lastIndexOf(true)]}`} (see docs/dictionary-history.md).`, "");
		const unresolved = new Set(cells.flatMap((c) => c.unresolved));
		if (unresolved.size > 0) md.push(`Unresolved callees (a missing letter may just be in one of these): ${[...unresolved].join(", ")}`, "");
		md.push("| Letter | Dictionary since | Dictionary until | Read at (first .. last) | Verdict |", "| --- | --- | --- | --- | --- |");
		for (const p of spec.parameters) {
			if (p.letter.length !== 1) continue;
			// 1 = read; 0 = not read and every helper resolved; ? = not read but a helper could not be followed
			const state = cells.map((c) => (!c.implemented ? "0" : c.present.has(p.letter) ? "1" : c.unresolved.length > 0 ? "?" : "0"));
			const pres = state.map((s) => s === "1");
			const first = pres.indexOf(true);
			const last = pres.lastIndexOf(true);
			const variable = /^[XYZUVWABCDE]$/.test(p.letter) && cells.some((c) => c.variableLetters);
			let verdict;
			if (first < 0) verdict = variable ? "variable axis/extruder letter (read through axisLetters/extrudeLetter): assumed present at every release" : "NEVER read by the handler text: helper not followed, or wrong letter - check by hand";
			else if (state.slice(first).includes("?") || state.slice(0, last).includes("?")) verdict = `UNCERTAIN - not read at ${versions.filter((_, i) => state[i] === "?").join(", ")} where a helper could not be followed`;
			else {
				const gap = pres.slice(first, last + 1).includes(false);
				const parts = [];
				if (first > 0) parts.push(`appears at ${versions[first]}`);
				if (last < versions.length - 1) parts.push(`gone after ${versions[last]}`);
				if (gap) parts.push(`GAP - absent at ${versions.filter((_, i) => i >= first && i <= last && !pres[i]).join(", ")}`);
				verdict = parts.length === 0 ? "unchanged" : parts.join("; ");
			}
			const agrees = verdict === "unchanged" || verdict.startsWith("variable")
				|| (verdict === `appears at ${p.since}` && first > 0)
				// a letter that arrives with its command is covered by the command's own `since`
				|| (p.since === undefined && spec.since !== undefined && verdict === `appears at ${spec.since}`)
				|| (p.until !== undefined && verdict === `gone after ${p.until}`);
			if (!agrees) problems.push(`${p.letter}: ${verdict}`);
			md.push(`| ${p.letter} | ${p.since ?? "-"} | ${p.until ?? "-"} | ${first < 0 ? "-" : `${versions[first]} .. ${versions[last]}`} | ${verdict} |`);
		}
		md.push("");
		const listed = new Set(spec.parameters.map((p) => p.letter));
		const extra = new Map();
		// an `axisParameters` entry covers the axis letters (and only those); `macroParameters` takes any letter
		const AXIS_LETTER = /^[XYZUVWABCDE]$/;
		versions.forEach((v, i) => { for (const l of cells[i].all) if (!listed.has(l) && !spec.macroParameters && !(spec.axisParameters && AXIS_LETTER.test(l))) extra.set(l, [...(extra.get(l) ?? []), v]); });
		if (extra.size > 0) {
			problems.push(`reads letters the dictionary does not list: ${[...extra.keys()].join("")}`);
			md.push("Read by the handler but not in the dictionary:", "");
			for (const [l, vs] of extra) md.push(`- ${l}: ${vs.length === versions.length ? "every release" : `${vs[0]} .. ${vs[vs.length - 1]}`}`);
			md.push("");
		}
	}
	needsHuman.set(code, problems);
}
md.push("## Summary", "", "Commands whose every automatic check passed (a human still spot-checks before `historyChecked` is set):", "");
md.push([...needsHuman].filter(([, p]) => p.length === 0).map(([c]) => c).join(" ") || "none", "", "Commands that need a human, and why:", "");
for (const [c, p] of needsHuman) if (p.length > 0) md.push(`- ${c}: ${p.join("; ")}`);
md.push("");
const text = md.join("\n");
if (out !== null) writeFileSync(out, text);
else console.log(text);
