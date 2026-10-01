#!/usr/bin/env node
/**
 * Re-slice the closed per-range triage checklists (`docs/rrf-triage/<from>..<to>.md`) into one document per adjacent
 * release pair (`docs/rrf-triage/per-release/<prev>..<release>.md`), carrying every item's existing closure text over BY
 * COMMIT SHA (nothing is re-decided here). Each commit goes to the first tracked release that contains it (the pin rule in
 * `src/releases/releases.ts`, `scripts/lib/releaseSlices.mjs`). Needs `npm run build` first and a full-history RRF clone
 * (`--rrf <path>`, else `$RRF_CLONE`, else `../RepRapFirmware`). Read-only against the clone.
 *
 *   node scripts/split-triage.mjs [--out docs/rrf-triage/per-release] [--check]
 *
 * - A section's lead-in note is range-level prose; it is carried into every per-release document that has items in that
 *   section, marked as carried, so a reader of one release document still sees why a section was closed the way it was.
 * - An item with no prior closure stays open (`[ ]`). An item closed only by its section's note (no closure text of its own)
 *   is listed in the summary as "closed by section note": that is the set `docs/tasks` D3 step 2 second-looks.
 * - The wiki section is bucketed by date (a wiki commit goes to the first release dated on or after it).
 * - `--check` (D3 step 1) exits 1 when a closure text names an event pinned EARLIER than the release the item's commit
 *   first ships in. An event citing several commits may legitimately sit at a later one, so a DIFF is a question, not a verdict.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { defaultRrfClone } from "./lib/rrfClone.mjs";
import { firstContaining, loadChanges, loadReleases } from "./lib/releaseSlices.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TRIAGE_DIR = join(ROOT, "docs", "rrf-triage");

const argv = process.argv.slice(2);
let clone = defaultRrfClone();
let outDir = join(TRIAGE_DIR, "per-release");
let check = false;
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--rrf") clone = argv[++i] ?? clone;
	else if (argv[i] === "--out") outDir = argv[++i] ?? outDir;
	else if (argv[i] === "--check") check = true;
}
if (!existsSync(join(clone, ".git"))) {
	console.error(`no RRF clone at ${clone} (use --rrf or $RRF_CLONE)`);
	process.exit(2);
}

const releases = await loadReleases();
const changes = check ? await loadChanges() : [];
const eventVersion = new Map(changes.map((e) => [e.id, e.version]));

const ITEM = /^- \[([ x])\] \[`([0-9a-f]+)`\]\(https:\/\/github\.com\/([^/]+\/[^/]+)\/commit\/([0-9a-f]{40})\) (\d{4}-\d{2}-\d{2}) — (.*)$/;
const WIKI_REPO = "Duet3D/wiki-content";

const releaseIndex = (version) => releases.findIndex((r) => r.version === version);
const SHA = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/g;
/** Why an event may sit at a release LATER than one of its commits ships in (`null` = no good reason, so a DIFF). */
function eventLaterIsExplained(id) {
	if (id.startsWith("om-")) return "object-model events are tag-precise, dated to the snapshot that shows the path";
	const event = changes.find((e) => e.id === id);
	const shas = new Set(event.sources.flatMap((src) => src.match(SHA) ?? []).map((s) => s.slice(0, 9)));
	return shas.size > 1 ? "cites several commits; dated to the latest" : null;
}

/** @typedef {{ ticked: boolean, short: string, full: string, repo: string, date: string, text: string, raw: string }} Item */

/** Parse one range document into its sections: `{ title, note: string[], items: Item[] }`. */
function parseRange(text) {
	const sections = [];
	let current = null;
	for (const raw of text.split(/\r?\n/)) {
		const heading = /^## (.+)$/.exec(raw);
		if (heading) {
			current = { title: heading[1], note: [], items: [] };
			sections.push(current);
			continue;
		}
		if (current === null) continue;
		const m = ITEM.exec(raw);
		if (m) {
			current.items.push({ ticked: m[1] === "x", short: m[2], full: m[4], repo: m[3], date: m[5], text: m[6], raw });
		} else if (raw.trim() !== "") {
			current.note.push(raw);
		}
	}
	return sections;
}

/** Strip a trailing ` (n)` count: per-release documents recount. */
const baseTitle = (title) => title.replace(/\s*\(\d+\)$/, "");

/** release version -> section title -> { note, items } */
const buckets = new Map();
const unplaced = [];
const before = [];
const cache = new Map();
const place = (full) => {
	if (!cache.has(full)) cache.set(full, firstContaining(clone, releases, full));
	return cache.get(full);
};
const releaseDates = releases.slice(1).map((r) => [r.version, r.date]);
const byDate = (date) => releaseDates.find(([, d]) => d >= date)?.[0] ?? null;

function bucket(version, title, note) {
	if (!buckets.has(version)) buckets.set(version, new Map());
	const sections = buckets.get(version);
	if (!sections.has(title)) sections.set(title, { note, items: [] });
	return sections.get(title);
}

const rangeFiles = readdirSync(TRIAGE_DIR).filter((f) => /^\d.*\.\.\d.*\.md$/.test(f)).sort();
for (const file of rangeFiles) {
	const sections = parseRange(readFileSync(join(TRIAGE_DIR, file), "utf8"));
	for (const section of sections) {
		const title = baseTitle(section.title);
		for (const item of section.items) {
			if (item.repo === WIKI_REPO) {
				const version = byDate(item.date);
				if (version === null) unplaced.push({ file, title, item });
				else bucket(version, title, section.note).items.push({ ...item, file });
				continue;
			}
			const version = place(item.full);
			if (version === null) unplaced.push({ file, title, item });
			else if (version === "baseline") before.push({ file, title, item });
			else bucket(version, title, section.note).items.push({ ...item, file });
		}
	}
}

// --- write one document per release, in RELEASES order
mkdirSync(outDir, { recursive: true });
const CLOSURE = /no effect on files|event added|schema updated|dictionary .*(?:updated|gains|fix)|\*\*[a-z0-9_.-]+\*\*$/i;
const summary = [];
let diffs = 0;
const reported = new Set();
for (let i = 1; i < releases.length; i++) {
	const release = releases[i];
	const prev = i === 1 ? releases[0] : releases[i - 1];
	const sections = buckets.get(release.version);
	if (!sections) continue;
	const order = [...sections.keys()].sort((a, b) => {
		const rank = (t) => (t === "GCodeBuffer" ? 0 : t === "GCodes dispatch" ? 1 : t.startsWith("Wiki") ? 3 : 2);
		return rank(a) - rank(b) || a.localeCompare(b);
	});
	let total = 0;
	let open = 0;
	let bySectionNote = 0;
	const body = [];
	for (const title of order) {
		const { note, items } = sections.get(title);
		items.sort((a, b) => a.date.localeCompare(b.date));
		total += items.length;
		body.push(`## ${title} (${items.length})`, "");
		if (note.length > 0) body.push("_Carried from the range document:_", "", ...note, "");
		for (const item of items) {
			if (!item.ticked) open++;
			else if (item.repo !== WIKI_REPO && !CLOSURE.test(item.text)) bySectionNote++;
			body.push(item.raw);
			if (check && item.repo !== WIKI_REPO) {
				for (const [id, version] of eventVersion) {
					if (!item.text.includes(id) || version === release.version) continue;
					if (reported.has(`${item.full}|${id}`)) continue; // the same commit sits in several sections
					reported.add(`${item.full}|${id}`);
					const explained = eventLaterIsExplained(id);
					if (explained !== null && releaseIndex(version) > releaseIndex(release.version)) {
						console.log(`NOTE  ${release.version}: ${item.short} names event ${id} at ${version} (${explained})`);
					} else {
						diffs++;
						console.log(`DIFF  ${release.version}: ${item.short} names event ${id}, whose version is ${version}`);
					}
				}
			}
		}
		body.push("");
	}
	const head = [
		`# RRF ${prev.version} → ${release.version}: parser, dispatch and object-model triage`,
		"",
		`${total} item(s) whose commit first ships in ${release.version} (${release.kind === "tag" ? "tag" : "build"}, \`${release.commit}\`, ${release.date}), ` +
			`sliced from ${rangeFiles.map((f) => `\`${f}\``).join(" and ")} by \`scripts/split-triage.mjs\`. ` +
			"Closure text is carried over by commit SHA, never re-decided here. " +
			(i === 1 ? "`3.7.0-alpha.2` was cut before `3.6.3`, so this slice is \"reachable from alpha.2, not from 3.6.3\" (`README.md`). " : "") +
			(open === 0 ? "Every item is closed." : `**${open} item(s) are still open.**`) +
			(bySectionNote > 0 ? ` ${bySectionNote} are closed only by their section's note (no closure text of their own).` : ""),
		"",
	];
	writeFileSync(join(outDir, `${prev.version}..${release.version}.md`), [...head, ...body].join("\n"));
	summary.push({ release: release.version, total, open, bySectionNote });
}

console.log("release".padEnd(18) + "items".padStart(6) + "open".padStart(6) + "by-note".padStart(9));
for (const s of summary) {
	console.log(s.release.padEnd(18) + String(s.total).padStart(6) + String(s.open).padStart(6) + String(s.bySectionNote).padStart(9));
}
console.log(`${summary.reduce((n, s) => n + s.total, 0)} item(s) written to ${outDir}`);
if (before.length > 0) console.log(`NOTE  ${before.length} item(s) are already in 3.6.3 (dropped): ${[...new Set(before.map((b) => b.item.short))].join(" ")}`);
if (unplaced.length > 0) console.log(`FAIL  ${unplaced.length} item(s) no tracked release contains: ${unplaced.map((u) => u.item.short).join(" ")}`);
if (check) console.log(`${diffs} event/version DIFF(s)`);
process.exit(unplaced.length > 0 || (check && diffs > 0) ? 1 : 0);
