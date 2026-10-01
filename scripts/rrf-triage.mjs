#!/usr/bin/env node
/**
 * List the RepRapFirmware commits between two release tags that could change what this package has
 * to recognise (task 12, `docs/tasks/12-release-model.md`). Watched paths are computed AT THE `to`
 * TAG, so a file added since `from` is still picked up without editing this script:
 *  - every file matching `gb\.(Seen|MustSee|TryGet|GetUnprecedentedString)` (a G-code parameter
 *    reader - covers command dispatch across the whole tree, not just `src/GCodes/GCodes*.cpp`)
 *  - every file containing `OBJECT_MODEL_TABLE` (the object-model schema tables task 11 tracks)
 *  - everything under `src/GCodes/GCodeBuffer/` (the parser itself, which doesn't call `gb.Seen` on
 *    itself but is exactly where a syntax rule like task 05's `FindParameters` semantics lives)
 *
 * Prints a Markdown checklist, grouped by subsystem (the first directory segment under `src/`, with
 * `GCodeBuffer` and `GCodes dispatch` broken out from the rest of `src/GCodes/` since those are the
 * two places most likely to affect this package). Each item is then closed as one of: **no effect on
 * files** / **event added** (id) / **dictionary or schema updated** (entry) - see task 12's Steps.
 *
 *   node scripts/rrf-triage.mjs 3.6.3 3.7.0-rc.1 [--out docs/rrf-triage/3.6.3..3.7.0-rc.1.md] [--rrf <clone>]
 *   node scripts/rrf-triage.mjs 3.7.0-rc.1 3.7.0-rc.2 --per-release [--out docs/rrf-triage/per-release]
 *
 * `--per-release` (local clone only; `npm run build` first, it reads `dist/releases/releases.js`) writes ONE checklist per tracked
 * release in (from, to] instead of one for the range: each commit goes under the first `RELEASES` entry whose commit contains it,
 * each wiki commit under the release dated on or after it, and `--out` is a directory. Add a new release to `RELEASES` first; a
 * commit that no tracked release contains is filed under the `to` tag. `scripts/split-triage.mjs` does the same to the two
 * existing range documents.
 *
 * `--rrf <clone>` (default: the local clone documented in `docs/tasks/README.md`) uses that clone's
 * own `git log`/`git grep`/`git ls-tree` - read-only, never `checkout`/`reset`/`clean`. Omit it (or
 * point it at a path that doesn't exist) to fall back to the GitHub API instead, at the cost of many
 * more `gh api` calls and no watched-file discovery via `git grep` (it uses the same fixed
 * `GCodeBuffer`/`GCodes*.cpp` set the pre-task-12 version of this script used, since re-implementing
 * `git grep`-equivalent watched-file discovery over the API is not worth it for a fallback path).
 *
 * The wiki's `Gcodes.md` commits in the same date range are listed separately (via `gh api` - there
 * is no local clone of `Duet3D/wiki-content`), each with the `##`/`###` section headings its own
 * patch touches.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { defaultRrfClone } from "./lib/rrfClone.mjs";
import { firstContaining, loadReleases } from "./lib/releaseSlices.mjs";

const REPO = "Duet3D/RepRapFirmware";
const WIKI_REPO = "Duet3D/wiki-content";
const WIKI_GCODES_PATH = "User_manual/Reference/Gcodes.md";
const GCODEBUFFER_DIR = "src/GCodes/GCodeBuffer/";
const GCODES_DISPATCH_FILE = /^src\/GCodes\/GCodes\d*\.cpp$/;

function gh(args) {
	return execFileSync("gh", ["api", ...args], { encoding: "utf-8", maxBuffer: 64 * 1024 * 1024 });
}

function git(clone, args) {
	return execFileSync("git", ["-C", clone, ...args], { encoding: "utf-8", maxBuffer: 256 * 1024 * 1024 });
}

function lines(text) {
	return text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}

const positional = [];
let out = null;
let perRelease = false;
let rrfClone = defaultRrfClone();
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--out") out = argv[++i] ?? "";
	else if (argv[i] === "--rrf") rrfClone = argv[++i] ?? "";
	else if (argv[i] === "--per-release") perRelease = true;
	else positional.push(argv[i]);
}
const [from, to] = positional;
if (!from || !to || positional.length !== 2 || out === "") {
	console.error("usage: node scripts/rrf-triage.mjs <from-tag> <to-tag> [--out <file.md>] [--per-release] [--rrf <clone>]   (clone: --rrf, else $RRF_CLONE, else ../RepRapFirmware)");
	process.exit(2);
}

const useLocalClone = rrfClone !== "" && existsSync(rrfClone);
if (!useLocalClone) {
	console.error(`note: "${rrfClone}" not found - falling back to the GitHub API (slower, narrower watched-file discovery)`);
}

/** subsystem name for a watched src/ path, per this script's own doc comment. */
function subsystemOf(path) {
	if (path.startsWith(GCODEBUFFER_DIR)) return "GCodeBuffer";
	if (GCODES_DISPATCH_FILE.test(path)) return "GCodes dispatch";
	const m = /^src\/([^/]+)\//.exec(path);
	return m ? m[1] : "(top-level)";
}

let watchedPaths;
let totalCommits;
let inRange;
let earliestDate;
let latestDate;
/** sha -> { date, subject } for every commit in (from, to] */
const commitInfo = new Map();

if (useLocalClone) {
	git(rrfClone, ["fetch", "--tags", "-q"]); // read-only; never touches the working tree

	// `git grep -l` with a revision prefixes each line "revision:path" - strip that back off before
	// using these as pathspecs. `2>&1 || true`-equivalent isn't needed: a `git grep` with zero matches
	// exits 1, which execFileSync would throw on, so each call is wrapped.
	function grepFiles(pattern) {
		try {
			return lines(git(rrfClone, ["grep", "-l", "-E", pattern, to, "--", "src/"]))
				.map((l) => l.slice(l.indexOf(":") + 1));
		} catch {
			return [];
		}
	}
	const paramReaders = grepFiles("gb\\.(Seen|MustSee|TryGet|GetUnprecedentedString)");
	const objectModelTables = grepFiles("OBJECT_MODEL_TABLE");
	const gcodeBufferFiles = lines(git(rrfClone, ["ls-tree", "-r", "--name-only", to, "--", GCODEBUFFER_DIR]));
	watchedPaths = [...new Set([...paramReaders, ...objectModelTables, ...gcodeBufferFiles])].sort();

	const logFormat = "%H\x1f%cI\x1f%s";
	for (const row of lines(git(rrfClone, ["log", `--format=${logFormat}`, `${from}..${to}`]))) {
		const [sha, date, subject] = row.split("\x1f");
		commitInfo.set(sha, { date, subject });
	}
	totalCommits = commitInfo.size;
	inRange = new Set(commitInfo.keys());
	const dates = [...commitInfo.values()].map((e) => e.date).sort();
	earliestDate = dates[0];
	latestDate = dates[dates.length - 1];
} else {
	const rangeRows = lines(gh(["--paginate", `repos/${REPO}/compare/${from}...${to}?per_page=100`,
		"--jq", ".commits[] | [.sha, .commit.committer.date, (.commit.message | split(\"\\n\")[0])] | @tsv"]));
	for (const row of rangeRows) {
		const [sha, date, subject] = row.split("\t");
		commitInfo.set(sha, { date, subject });
	}
	totalCommits = Number(gh([`repos/${REPO}/compare/${from}...${to}?per_page=1`, "--jq", ".total_commits"]).trim());
	if (commitInfo.size !== totalCommits) {
		console.error(`warning: the compare API listed ${commitInfo.size} of ${totalCommits} commits; the checklist may be incomplete`);
	}
	inRange = new Set(commitInfo.keys());
	const dates = [...commitInfo.values()].map((e) => e.date).sort();
	earliestDate = dates[0];
	latestDate = dates[dates.length - 1];
	const dispatchFiles = lines(gh([`repos/${REPO}/contents/src/GCodes?ref=${encodeURIComponent(to)}`,
		"--jq", ".[] | select(.type == \"file\") | .name"]))
		.filter((name) => /^GCodes\d*\.cpp$/.test(name))
		.map((name) => `src/GCodes/${name}`);
	watchedPaths = [GCODEBUFFER_DIR, ...dispatchFiles];
}

/** sha -> { date, subject, paths: Set<string> } */
const touched = new Map();
if (useLocalClone) {
	for (const path of watchedPaths) {
		const rows = lines(git(rrfClone, ["log", "--format=%H", `${from}..${to}`, "--", path]));
		for (const sha of rows) {
			if (!inRange.has(sha)) continue;
			const info = commitInfo.get(sha);
			const entry = touched.get(sha) ?? { date: info.date, subject: info.subject, paths: new Set() };
			entry.paths.add(path);
			touched.set(sha, entry);
		}
	}
} else {
	const since = new Date(Date.parse(earliestDate) - 24 * 60 * 60 * 1000).toISOString();
	for (const path of watchedPaths) {
		const rows = lines(gh(["--paginate",
			`repos/${REPO}/commits?sha=${encodeURIComponent(to)}&path=${encodeURIComponent(path)}&since=${since}&per_page=100`,
			"--jq", ".[] | [.sha, .commit.committer.date, (.commit.message | split(\"\\n\")[0])] | @tsv"]));
		for (const row of rows) {
			const [sha, date, subject] = row.split("\t");
			if (!inRange.has(sha)) continue;
			const entry = touched.get(sha) ?? { date, subject, paths: new Set() };
			entry.paths.add(path);
			touched.set(sha, entry);
		}
	}
}

const subsystemOrder = (name) => (name === "GCodeBuffer" ? 0 : name === "GCodes dispatch" ? 1 : 2);

function commitLine(sha, e) {
	return `- [ ] [\`${sha.slice(0, 10)}\`](https://github.com/${REPO}/commit/${sha}) ${e.date.slice(0, 10)} — ${e.subject}`;
}

/**
 * The checklist for `entries` (a sha -> `{ date, subject, paths }` map), grouped by subsystem, GCodeBuffer/GCodes-dispatch
 * first (most likely to matter), then alphabetical. `scope` is the prose after the count: the whole range, or one release.
 */
function checklist(heading, entries, scope, tag) {
	const bySubsystem = new Map();
	for (const [sha, e] of entries) {
		for (const path of e.paths) {
			const subsystem = subsystemOf(path);
			if (!bySubsystem.has(subsystem)) bySubsystem.set(subsystem, new Map());
			bySubsystem.get(subsystem).set(sha, e);
		}
	}
	const subsystems = [...bySubsystem.keys()].sort((a, b) => {
		const oa = subsystemOrder(a);
		const ob = subsystemOrder(b);
		return oa - ob || a.localeCompare(b);
	});
	return [
		heading,
		"",
		scope(entries.size, subsystems.length),
		"",
		"Close each item as **no effect on files** (nothing this package reads changed observably),",
		"**event added** (a `ChangeEvent` id in `src/releases/changes.ts`) or **dictionary or schema",
		"updated** (a task 10/11 entry). " + tag,
		"",
		...subsystems.flatMap((subsystem) => [
			`## ${subsystem} (${bySubsystem.get(subsystem).size})`,
			"",
			...[...bySubsystem.get(subsystem).entries()]
				.sort(([, a], [, b]) => a.date.localeCompare(b.date))
				.map(([sha, e]) => commitLine(sha, e)),
			"",
		]),
	].join("\n");
}

const totalItems = touched.size;
const md = checklist(
	`# RRF ${from} → ${to}: parser, dispatch and object-model triage`,
	touched,
	(n, subsystems) =>
		`${n} of the ${totalCommits} commits in this range touch a watched path (${watchedPaths.length} files` +
		`${useLocalClone ? `, discovered at ${to} via git grep` : " - narrowed fallback set, no local clone"}), across ${subsystems} subsystems.`,
	"Only a fully closed list earns the `rrf-" + to + "` tag.",
);

// The wiki's own Gcodes.md commits in a date window - a separate, non-git-clone source
// (there is no local Duet3D/wiki-content clone), always via `gh api`.
function wikiSection(since = earliestDate, until = latestDate, omitWhenEmpty = false) {
	const rows = lines(gh(["--paginate",
		`repos/${WIKI_REPO}/commits?path=${encodeURIComponent(WIKI_GCODES_PATH)}&since=${since}&until=${until}&per_page=100`,
		"--jq", ".[] | [.sha, .commit.committer.date, (.commit.message | split(\"\\n\")[0])] | @tsv"]));
	if (rows.length === 0) {
		if (omitWhenEmpty) return [];
		return [`## Wiki: ${WIKI_GCODES_PATH} (0)`, "", "No commits to this file in the date range above.", ""];
	}
	const lines_ = [`## Wiki: ${WIKI_GCODES_PATH} (${rows.length})`, ""];
	for (const row of rows) {
		const [sha, date, subject] = row.split("\t");
		let headings = [];
		try {
			const patch = gh([`repos/${WIKI_REPO}/commits/${sha}`, "-H", "Accept: application/vnd.github.diff"]);
			headings = [...new Set(
				lines(patch)
					.filter((l) => /^[+-]#{1,4}\s/.test(l))
					.map((l) => l.replace(/^[+-]/, "").trim()),
			)];
		} catch {
			// A patch that's too large for this Accept header, or a merge commit with no direct diff,
			// just means "sections touched" can't be listed - the commit itself is still recorded.
		}
		lines_.push(
			`- [ ] [\`${sha.slice(0, 10)}\`](https://github.com/${WIKI_REPO}/commit/${sha}) ${date.slice(0, 10)} — ${subject}` +
				(headings.length > 0 ? ` — _${headings.join("; ")}_` : ""),
		);
	}
	lines_.push("");
	return lines_;
}

/**
 * `--per-release`: one checklist per tracked release in (from, to], each commit under the first `RELEASES` entry whose commit
 * contains it (`scripts/lib/releaseSlices.mjs`), the wiki commits under the release dated on or after them. A commit that no
 * tracked release contains (the `to` tag is not in `RELEASES` yet) goes under `to` itself, so nothing is dropped.
 */
async function writePerRelease() {
	if (!useLocalClone) {
		console.error("--per-release needs a local RRF clone (the GitHub API fallback cannot place a commit in a release)");
		process.exit(2);
	}
	const releases = await loadReleases();
	const fromIndex = releases.findIndex((r) => r.version === from);
	if (fromIndex === -1) {
		console.error(`"${from}" is not in RELEASES (src/releases/releases.ts); add it first`);
		process.exit(2);
	}
	const slices = new Map(); // version -> Map<sha, entry>
	for (const [sha, e] of touched) {
		const placed = firstContaining(rrfClone, releases, sha);
		if (placed === "baseline") continue; // already at 3.6.3: not a change in the window
		const version = placed ?? to;
		if (!slices.has(version)) slices.set(version, new Map());
		slices.get(version).set(sha, e);
	}
	const dir = out ?? "docs/rrf-triage/per-release";
	mkdirSync(dir, { recursive: true });
	const chain = releases.slice(fromIndex + 1);
	const versions = [...chain.map((r) => r.version), ...(chain.some((r) => r.version === to) ? [] : [to])];
	let previous = releases[fromIndex];
	let written = 0;
	for (const version of versions) {
		const release = releases.find((r) => r.version === version);
		const entries = slices.get(version);
		// the release is dated `release.date`; its wiki window runs from the previous release's date to its own
		const until = release?.date ?? latestDate;
		const wiki = until > previous.date && release !== undefined
			? wikiSection(`${previous.date}T00:00:00Z`, `${until}T23:59:59Z`, true)
			: [];
		if (entries !== undefined || wiki.length > 0) {
			const body = entries === undefined ? "" : checklist(
				`# RRF ${previous.version} → ${version}: parser, dispatch and object-model triage`,
				entries,
				(n, subsystems) => `${n} commit(s) whose first release is ${version}, across ${subsystems} subsystems (watched files as in the range run: ${watchedPaths.length}).`,
				release?.kind === "tag" ? "Only a fully closed list earns the `rrf-" + version + "` tag." : "A build has no tag; close the list all the same.",
			);
			const file = `${dir}/${previous.version}..${version}.md`;
			writeFileSync(file, [body || `# RRF ${previous.version} → ${version}: parser, dispatch and object-model triage\n`, ...wiki].join("\n"));
			written++;
			console.error(`wrote ${entries?.size ?? 0} repo item(s)${wiki.length > 0 ? " + wiki section" : ""} to ${file}`);
		}
		if (release !== undefined) previous = release;
	}
	console.error(`${written} per-release checklist(s) in ${dir}`);
}

if (perRelease) {
	await writePerRelease();
	process.exit(0);
}

const fullMd = [md, ...wikiSection()].join("\n");

if (out) {
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, fullMd);
	console.error(`wrote ${totalItems} repo item(s) + wiki section to ${out}`);
} else {
	process.stdout.write(fullMd);
}
