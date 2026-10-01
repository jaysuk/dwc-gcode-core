#!/usr/bin/env node
/**
 * Holds `RELEASES` (`src/releases/releases.ts`) and every change event's `version` to the RRF clone
 * (`docs/rrf-triage/README.md` says how a version is pinned). Needs `npm run build` first (reads `dist/`) and a
 * full-history clone with tags: `--rrf <path>`, else `$RRF_CLONE`, else `../RepRapFirmware`.
 *
 *   node scripts/audit-releases.mjs [--events] [--fix-report]
 *
 * 1. Every `RELEASES` entry's `commit` exists and its own tree's `src/Version.h` `MAIN_VERSION` reads the entry's version.
 * 2. Every `MAIN_VERSION` string that ever appeared in `src/Version.h` between 3.6.3's fork point and the newest
 *    tracked release is in `RELEASES` - a board reports one of these strings, so an untracked one is a hole.
 * 3. `RELEASES` is a chain: each entry's commit contains the previous one (3.6.3 -> 3.7.0-alpha is the one known break -
 *    they are separate branches), so "the first release containing a commit" is well defined.
 * 4. (`--events`) every change event that cites an RRF commit: the FIRST tracked release containing that commit
 *    (the pin rule in `releases.ts`) against the event's `version`, and whether 3.6.3 already contained the commit.
 *
 * Exit 1 on any FAIL. A candidate generator, not an oracle: a DIFF is a question to answer from `git show`.
 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultRrfClone, git, show, lines } from "./lib/rrfClone.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
let clone = defaultRrfClone();
let events = false;
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--rrf") clone = argv[++i] ?? clone;
	else if (argv[i] === "--events") events = true;
}

const { RELEASES } = await import(pathToFileURL(join(ROOT, "dist", "releases", "releases.js")).href);
const { CHANGES } = await import(pathToFileURL(join(ROOT, "dist", "releases", "changes.js")).href);
const { compareFirmwareVersions } = await import(pathToFileURL(join(ROOT, "dist", "versionCompare.js")).href);
const { OBJECT_MODEL_VERSIONS } = await import(pathToFileURL(join(ROOT, "dist", "objectmodel", "versions.js")).href);

const MAIN_VERSION = /#\s*define\s+MAIN_VERSION\s+"([^"]+)"/;
const versionAt = (ref) => MAIN_VERSION.exec(show(clone, ref, "src/Version.h") ?? "")?.[1] ?? null;

let failed = false;
const fail = (msg) => { failed = true; console.log(`FAIL  ${msg}`); };

// --- 1. RELEASES against the clone
console.log("== RELEASES against the clone");
for (const r of RELEASES) {
	if (r.commit === undefined) { fail(`${r.version}: no commit recorded`); continue; }
	let full;
	try { full = git(clone, ["rev-parse", "--verify", `${r.commit}^{commit}`]).trim(); } catch { fail(`${r.version}: commit ${r.commit} not in the clone`); continue; }
	const shown = versionAt(full);
	if (shown !== r.version) fail(`${r.version}: ${r.commit}'s Version.h reads ${JSON.stringify(shown)}`);
	if (r.kind === "tag") {
		let tagged = "";
		try { tagged = git(clone, ["rev-parse", "--verify", `refs/tags/${r.version}^{commit}`]).trim(); } catch { fail(`${r.version}: no such tag`); continue; }
		if (tagged !== full) fail(`${r.version}: the tag is ${tagged.slice(0, 9)}, RELEASES says ${r.commit}`);
		const date = git(clone, ["log", "-1", "--format=%cs", tagged]).trim();
		if (r.date !== date) fail(`${r.version}: the tagged commit is dated ${date}, RELEASES says ${r.date}`);
	}
}

// --- 2. every Version.h string in history is tracked
console.log("== Version.h strings between the 3.6.3 fork point and the newest release");
const newest = RELEASES[RELEASES.length - 1];
const forkPoint = git(clone, ["merge-base", RELEASES[0].commit, newest.commit]).trim();
const seen = new Map();
for (const sha of lines(git(clone, ["log", "--reverse", "--format=%H", `${forkPoint}..${newest.commit}`, "--", "src/Version.h"]))) {
	const v = versionAt(sha);
	if (v !== null && !seen.has(v)) seen.set(v, sha);
}
const tracked = new Set(RELEASES.map((r) => r.version));
for (const [v, sha] of seen) {
	// "3.7.0-alpha" (before the first tag) is absorbed into alpha.2 on purpose - see releases.ts
	if (!tracked.has(v) && compareFirmwareVersions(v, RELEASES[1].version) > 0) fail(`Version.h reads ${v} from ${sha.slice(0, 9)} (${git(clone, ["log", "-1", "--format=%cs", sha]).trim()}) but RELEASES has no such entry`);
}
console.log(`${seen.size} distinct MAIN_VERSION strings seen, ${RELEASES.length} tracked`);

// --- 3. RELEASES is a chain
console.log("== RELEASES is an ancestry chain");
const isAncestor = (a, b) => { try { git(clone, ["merge-base", "--is-ancestor", a, b]); return true; } catch { return false; } };
for (let i = 2; i < RELEASES.length; i++) {
	if (!isAncestor(RELEASES[i - 1].commit, RELEASES[i].commit)) console.log(`NOTE  ${RELEASES[i - 1].version} (${RELEASES[i - 1].commit}) is not an ancestor of ${RELEASES[i].version} (${RELEASES[i].commit})`);
}

// --- 4. events that cite an RRF commit
if (events) {
	console.log("== change events that cite an RRF commit");
	const sha = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;
	let checked = 0;
	const setFor = new Map();
	const noteFor = new Map();
	const firstContaining = (full) => RELEASES.slice(1).find((r) => isAncestor(full, r.commit))?.version ?? null;
	for (const e of CHANGES) {
		for (const src of e.sources) {
			for (const s of src.match(sha) ?? []) {
				let full;
				try { full = git(clone, ["rev-parse", "--verify", `${s}^{commit}`]).trim(); } catch { continue; } // a wiki sha, not RRF's
				checked++;
				const inBaseline = isAncestor(full, RELEASES[0].commit);
				const first = firstContaining(full);
				const note = `${e.id} @ ${e.version} cites ${s}: first release containing it is ${first ?? "none tracked"}${inBaseline ? " (already in 3.6.3)" : ""}`;
				if (inBaseline) fail(note);
				else { (setFor.get(e.id) ?? setFor.set(e.id, new Set()).get(e.id)).add(first); noteFor.set(e.id, note); }
			}
		}
	}
	// An event spanning several commits may sit at any release that is the first to contain one of them (the latest is
	// the safe choice - see releases.ts); a single-commit event must sit exactly at the release containing it.
	// An object-model event (`om-...`) dated to a tracked object-model snapshot (`OBJECT_MODEL_VERSIONS`) is dated to the snapshot, not to a
	// build: the schema has no data between tags, so a path that changed in an alpha build is dated to the FIRST snapshot at or after it
	// (docs/rrf-triage/README.md, "Object-model events are the one exception"). Its commit's release is allowed to be earlier, but the event
	// must sit exactly at that snapshot. A hand-written `om-` event pinned at a build (`3.7.0-rc.1+3`) is held to the strict rule below.
	const snapshotAtOrAfter = (release) => OBJECT_MODEL_VERSIONS.map((v) => v.version).find((v) => compareFirmwareVersions(v, release) >= 0) ?? null;
	for (const e of CHANGES) {
		const set = setFor.get(e.id);
		if (set === undefined) continue;
		if (e.id.startsWith("om-") && OBJECT_MODEL_VERSIONS.some((v) => v.version === e.version)) {
			const allowed = new Set([...set].map((r) => snapshotAtOrAfter(r)));
			if (!allowed.has(e.version)) console.log(`DIFF  ${e.id} @ ${e.version}: cited commits first ship in ${[...set].join(", ")}, so the first object-model snapshot at or after is ${[...allowed].join(", ")}`);
		} else if (!set.has(e.version)) {
			console.log(`DIFF  ${e.id} @ ${e.version}: cited commits first ship in ${[...set].join(", ")}`);
		}
	}
	console.log(`${checked} commit citations checked`);
}

process.exit(failed ? 1 : 0);
