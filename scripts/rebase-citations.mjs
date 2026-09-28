#!/usr/bin/env node
/**
 * Moves this repo's `RRF <from-tag> <file>[:<lines>]` citations to `RRF <to-tag>` when moving
 * `RRF_BASELINE` (`CLAUDE.md` "Tracking RRF"), without ever claiming more than was checked:
 *
 *  - the cited file is byte-identical at both tags -> the label moves, the line numbers stay;
 *  - the file changed, but no hunk touches the cited line(s) -> the label moves and the numbers are
 *    remapped through the hunks above them (the cited text is proven identical at the new lines);
 *  - a cited line falls inside a hunk, or the citation has no line number and the file changed
 *    (a function- or `case`-level citation - whether the function changed is a human judgement) ->
 *    left at `<from-tag>` and printed, for the person doing the review to re-read at `<to-tag>`
 *    and re-cite by hand.
 *
 * Only the `RRF <from-tag> <path>` form is touched; prose such as "checked against RRF `3.7.0-rc.1`"
 * and every other release's citations are left alone. Historical records (`docs/tasks/`,
 * `docs/rrf-triage/`, `CHANGELOG.md`) are never scanned.
 *
 *   node scripts/rebase-citations.mjs <from-tag> <to-tag> --rrf <clone> [--ok-lineless <path>]... [--bare <file>]... [--write]
 *
 * `--bare <file>` (repo-relative, repeatable) additionally remaps the bare `File.cpp:lines` citations in that
 * file - the form `docs/invocation-table.md` and `docs/file-kinds.md` use, with no `RRF <tag>` prefix. Their
 * line numbers are remapped (or listed for review) by the same rules; there is no label to move.
 *
 * `--ok-lineless <path>` (repeatable, matched as a suffix of the resolved src/ path) is the reviewer's
 * assertion that no function, `case` or table cited WITHOUT a line number in that file is inside a hunk
 * of `<from-tag>..<to-tag>` - read the hunks first (`git diff -U0 <from> <to> -- <path>`).
 *
 * Without `--write` it only reports. `--rrf` is a clone with both tags (read-only: `diff`, `show`,
 * `ls-tree`). Scripted `dictionary/commands.json` edits must be text replaces, not `JSON.stringify`
 * (the file is hand-formatted), which is why this rewrites matched substrings in place.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
const positional = [];
let clone = "";
let write = false;
const okLineless = [];
const bareFiles = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--rrf") clone = argv[++i] ?? "";
	else if (argv[i] === "--ok-lineless") okLineless.push(argv[++i] ?? "");
	else if (argv[i] === "--bare") bareFiles.push(argv[++i] ?? "");
	else if (argv[i] === "--write") write = true;
	else positional.push(argv[i]);
}
const [from, to] = positional;
if (!from || !to || positional.length !== 2 || clone === "") {
	console.error("usage: node scripts/rebase-citations.mjs <from-tag> <to-tag> --rrf <clone> [--ok-lineless <path>]... [--bare <file>]... [--write]");
	process.exit(2);
}

function git(args) {
	return execFileSync("git", ["-C", clone, ...args], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
}

// --- the scanned files ---------------------------------------------------------------------------
const SCAN_DIRS = ["src", "dictionary", "docs"];
const SKIP_DIRS = new Set(["node_modules", "dist", "tasks", "rrf-triage", "draft"]);
const SCAN_EXT = new Set([".ts", ".json", ".md"]);
// Generated from other files - rebuilt by their own scripts after this one runs.
const GENERATED = new Set(["src/dictionary/commands.ts", "docs/api.md", "docs/diagnostics.md"].map((p) => join(ROOT, p)));

function walk(dir, out) {
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			if (!SKIP_DIRS.has(name)) walk(full, out);
		} else if (SCAN_EXT.has(name.slice(name.lastIndexOf("."))) && !GENERATED.has(full)) {
			out.push(full);
		}
	}
}
const files = [];
for (const d of SCAN_DIRS) walk(join(ROOT, d), files);

// --- resolving a cited path to a real file ----------------------------------------------------------
const treeAt = (tag) => git(["ls-tree", "-r", "--name-only", tag, "--", "src/"]).split("\n").filter((l) => l !== "");
const fromTree = treeAt(from);
const toTreeSet = new Set(treeAt(to));
const resolveCache = new Map();
function resolvePath(cited) {
	if (resolveCache.has(cited)) return resolveCache.get(cited);
	const bare = cited.replace(/^src\//, "");
	let matches = fromTree.filter((p) => p === `src/${bare}`);
	if (matches.length === 0) matches = fromTree.filter((p) => p.endsWith(`/${bare}`));
	const result = matches.length === 1 ? matches[0] : null;
	resolveCache.set(cited, result);
	return result;
}

// --- per-file hunks, old line -> new line ------------------------------------------------------------
const hunkCache = new Map();
function hunksOf(path) {
	if (hunkCache.has(path)) return hunkCache.get(path);
	let result;
	if (!toTreeSet.has(path)) {
		result = { deleted: true, hunks: [] };
	} else {
		const diff = git(["diff", "-U0", "--no-color", `${from}`, `${to}`, "--", path]);
		const hunks = [];
		for (const m of diff.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
			hunks.push({ oldStart: +m[1], oldLen: m[2] === undefined ? 1 : +m[2], newStart: +m[3], newLen: m[4] === undefined ? 1 : +m[4] });
		}
		result = { deleted: false, hunks };
	}
	hunkCache.set(path, result);
	return result;
}

/** New line number for old line `n`, or null when a hunk removed or rewrote it. */
function mapLine(hunks, n) {
	let delta = 0;
	for (const h of hunks) {
		if (h.oldLen === 0) {
			// pure insertion after old line `oldStart`
			if (h.oldStart < n) delta += h.newLen;
			continue;
		}
		if (n < h.oldStart) break;
		if (n < h.oldStart + h.oldLen) return null;
		delta += h.newLen - h.oldLen;
	}
	return n + delta;
}

/** Map one citation's line spec ("2582-2660", "4700-4702,4710", "274"). null = a line was touched, or a
 *  hunk (including a pure insertion) sits inside a range so the range no longer means the same text. */
function mapSpec(hunks, spec) {
	const parts = spec.split(",");
	const out = [];
	for (const part of parts) {
		const [a, b] = part.split("-").map(Number);
		if (b === undefined) {
			const m = mapLine(hunks, a);
			if (m === null) return null;
			out.push(String(m));
			continue;
		}
		const ma = mapLine(hunks, a);
		const mb = mapLine(hunks, b);
		if (ma === null || mb === null) return null;
		// every line between must survive unchanged too: no hunk may overlap the range (an
		// equal-length rewrite keeps the span the same length but changes the text), and no pure
		// insertion may sit inside it
		for (const h of hunks) {
			const overlaps = h.oldLen === 0 ? h.oldStart >= a && h.oldStart < b : h.oldStart <= b && h.oldStart + h.oldLen - 1 >= a;
			if (overlaps) return null;
		}
		out.push(`${ma}-${mb}`);
	}
	return out.join(",");
}

// --- the rewrite --------------------------------------------------------------------------------------
const escapedFrom = from.replace(/[.+*?^${}()|[\]\\]/g, "\\$&");
// `RRF <from> <path>[:<lines>]` - the path may be a bare basename or carry a directory / `src/` prefix.
const CITATION = new RegExp(`(RRF ${escapedFrom} )((?:src/)?[A-Za-z0-9_][A-Za-z0-9_/.+-]*\\.(?:cpp|h|hpp|c|mk))(?::(\\d+(?:[-,]\\d+)*))?`, "g");

const unresolved = [];
const needsReview = [];
let moved = 0;
let remapped = 0;
const changedFiles = [];

for (const file of files) {
	const text = readFileSync(file, "utf-8");
	const rel = relative(ROOT, file).replace(/\\/g, "/");
	let touched = false;
	const next = text.replace(CITATION, (whole, label, cited, spec, offset) => {
		const path = resolvePath(cited);
		const lineNo = text.slice(0, offset).split("\n").length;
		if (path === null) {
			unresolved.push(`${rel}:${lineNo}  ${whole}`);
			return whole;
		}
		const { deleted, hunks } = hunksOf(path);
		if (deleted) {
			needsReview.push(`${rel}:${lineNo}  ${whole}  (file gone at ${to})`);
			return whole;
		}
		const newLabel = label.replace(from, to);
		if (hunks.length === 0) {
			moved++;
			touched = true;
			return `${newLabel}${cited}${spec === undefined ? "" : `:${spec}`}`;
		}
		if (spec === undefined) {
			if (okLineless.some((p) => path.endsWith(p))) {
				moved++;
				touched = true;
				return `${newLabel}${cited}`;
			}
			needsReview.push(`${rel}:${lineNo}  ${whole}  (no line number, and ${path} changed)`);
			return whole;
		}
		const mapped = mapSpec(hunks, spec);
		if (mapped === null) {
			needsReview.push(`${rel}:${lineNo}  ${whole}  (cited lines touched in ${path})`);
			return whole;
		}
		moved++;
		if (mapped !== spec) remapped++;
		touched = true;
		return `${newLabel}${cited}:${mapped}`;
	});
	if (touched) {
		changedFiles.push(rel);
		if (write) writeFileSync(file, next);
	}
}

// --- bare `File.cpp:lines` citations in the files named with --bare -----------------------------------------
const BARE = /(?<![\w./-])((?:[A-Za-z0-9_]+\/)*[A-Za-z0-9_]+\.(?:cpp|h)):(\d+(?:[-,]\d+)*)/g;
let bareMoved = 0;
for (const rel of bareFiles) {
	const file = join(ROOT, rel);
	const text = readFileSync(file, "utf-8");
	let touched = false;
	const next = text.replace(BARE, (whole, cited, spec, offset) => {
		const path = resolvePath(cited);
		const lineNo = text.slice(0, offset).split("\n").length;
		if (path === null) return whole; // not an RRF file (or not unique) - not ours to touch
		const { deleted, hunks } = hunksOf(path);
		if (deleted) {
			needsReview.push(`${rel}:${lineNo}  ${whole}  (file gone at ${to})`);
			return whole;
		}
		if (hunks.length === 0) return whole; // identical file: the numbers already hold
		const mapped = mapSpec(hunks, spec);
		if (mapped === null) {
			needsReview.push(`${rel}:${lineNo}  ${whole}  (cited lines touched in ${path})`);
			return whole;
		}
		if (mapped === spec) return whole;
		bareMoved++;
		touched = true;
		return `${cited}:${mapped}`;
	});
	if (touched) {
		changedFiles.push(rel);
		if (write) writeFileSync(file, next);
	}
}
if (bareFiles.length > 0) console.log(`${write ? "remapped" : "would remap"} ${bareMoved} bare citation(s) in ${bareFiles.join(", ")}`);

console.log(`${write ? "rewrote" : "would rewrite"} ${moved} citation(s) in ${changedFiles.length} file(s) (${remapped} with remapped line numbers)`);
for (const f of changedFiles) console.log(`  ${f}`);
console.log(`\n${needsReview.length} citation(s) left at ${from} - re-read at ${to} and re-cite by hand:`);
for (const l of needsReview) console.log(`  ${l}`);
console.log(`\n${unresolved.length} citation(s) whose path did not resolve to exactly one file at ${from}:`);
for (const l of unresolved) console.log(`  ${l}`);
