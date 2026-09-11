#!/usr/bin/env node
/**
 * List the RepRapFirmware commits between two release tags that could change what this package has
 * to recognise: anything touching the G-code parser (`src/GCodes/GCodeBuffer/`) or the command
 * dispatch files (`src/GCodes/GCodes*.cpp`, discovered at the newer tag, so a new GCodes8.cpp is
 * picked up without editing this script). Prints a Markdown checklist.
 *
 *   node scripts/rrf-triage.mjs 3.6.3 3.7.0-rc.1 [--out docs/rrf-triage/3.6.3..3.7.0-rc.1.md]
 *
 * Each item is then closed as one of: no effect on syntax; recognition added (code + test); or
 * semantic table updated (entry + citation + test). Only a fully closed list moves RRF_BASELINE and
 * earns the `rrf-<tag>` git tag.
 *
 * Needs the GitHub CLI (`gh`), authenticated. It makes a few API calls per watched path, not one per
 * commit: the range's commit set comes from the compare API, and each path's history is listed
 * with the commits API's `path` filter and intersected with that set.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const REPO = "Duet3D/RepRapFirmware";
const PARSER_DIR = "src/GCodes/GCodeBuffer";
const DISPATCH_DIR = "src/GCodes";
const DISPATCH_FILE = /^GCodes\d*\.cpp$/;

function gh(args) {
	return execFileSync("gh", ["api", ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
}

function lines(text) {
	return text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

const positional = [];
let out = null;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--out") {
		out = argv[++i] ?? "";
	} else {
		positional.push(argv[i]);
	}
}
const [from, to] = positional;
if (!from || !to || positional.length !== 2 || out === "") {
	console.error("usage: node scripts/rrf-triage.mjs <from-tag> <to-tag> [--out <file.md>]");
	process.exit(2);
}

// Every commit in the range, with its committer date. The earliest date bounds the path queries
// below, so a commit made long before it was merged is still inside the window.
const rangeRows = lines(gh(["--paginate", `repos/${REPO}/compare/${from}...${to}?per_page=100`,
	"--jq", ".commits[] | [.sha, .commit.committer.date] | @tsv"]));
const inRange = new Set(rangeRows.map((r) => r.split("\t")[0]));
const totalCommits = Number(gh([`repos/${REPO}/compare/${from}...${to}?per_page=1`, "--jq", ".total_commits"]).trim());
if (inRange.size !== totalCommits) {
	console.error(`warning: the compare API listed ${inRange.size} of ${totalCommits} commits; the checklist may be incomplete`);
}
const earliest = rangeRows.map((r) => r.split("\t")[1]).sort()[0];
const since = new Date(Date.parse(earliest) - 24 * 60 * 60 * 1000).toISOString();

const dispatchFiles = lines(gh([`repos/${REPO}/contents/${DISPATCH_DIR}?ref=${encodeURIComponent(to)}`,
	"--jq", ".[] | select(.type == \"file\") | .name"]))
	.filter((name) => DISPATCH_FILE.test(name))
	.map((name) => `${DISPATCH_DIR}/${name}`);
const watched = [PARSER_DIR, ...dispatchFiles];

/** sha -> { date, subject, paths } */
const touched = new Map();
for (const path of watched) {
	const rows = lines(gh(["--paginate",
		`repos/${REPO}/commits?sha=${encodeURIComponent(to)}&path=${encodeURIComponent(path)}&since=${since}&per_page=100`,
		"--jq", ".[] | [.sha, .commit.committer.date, (.commit.message | split(\"\\n\")[0])] | @tsv"]));
	for (const row of rows) {
		const [sha, date, subject] = row.split("\t");
		if (!inRange.has(sha)) continue;
		const entry = touched.get(sha) ?? { date, subject, paths: new Set() };
		entry.paths.add(path === PARSER_DIR ? "GCodeBuffer/" : path.slice(DISPATCH_DIR.length + 1));
		touched.set(sha, entry);
	}
}

// Parser commits first: those are the ones most likely to change syntax
const items = [...touched.entries()].sort(([, a], [, b]) => {
	const pa = a.paths.has("GCodeBuffer/") ? 0 : 1;
	const pb = b.paths.has("GCodeBuffer/") ? 0 : 1;
	return pa - pb || a.date.localeCompare(b.date);
});

const md = [
	`# RRF ${from} → ${to}: parser and dispatch triage`,
	"",
	`${items.length} of the ${totalCommits} commits in this range touch a watched path:`,
	"",
	`- \`${PARSER_DIR}/\` — the G-code parser`,
	`- ${dispatchFiles.map((f) => `\`${f.slice(DISPATCH_DIR.length + 1)}\``).join(", ")} — command dispatch`,
	"",
	"Close each item as **no effect on syntax**, **recognition added** (code + test) or **semantic table",
	"updated** (entry + citation + test). Only a fully closed list moves `RRF_BASELINE` and earns the",
	`\`rrf-${to}\` tag.`,
	"",
	...items.map(([sha, e]) =>
		`- [ ] [\`${sha.slice(0, 10)}\`](https://github.com/${REPO}/commit/${sha}) ${e.date.slice(0, 10)} — ${e.subject} — _${[...e.paths].join(", ")}_`),
	"",
].join("\n");

if (out) {
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, md);
	console.error(`wrote ${items.length} items to ${out}`);
} else {
	process.stdout.write(md);
}
