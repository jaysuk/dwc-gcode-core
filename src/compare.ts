/**
 * Semantic diff of files and projects (task 15, `docs/tasks/15-compare.md`) — matches directives by
 * an **identity key** derived from the dictionary's own defining parameters, not by line position,
 * so a reordered `config.g` (or one split across included files) doesn't read as wholesale removals
 * and additions. `diffText` is the separate, byte-faithful textual view for UIs that want both.
 *
 * **Identity keys, one row per defining command, each cited** (`IDENTITY_RULES`):
 *  - `M563` by `P` (tool number - RRF 3.7.0-rc.1 `GCodes.cpp:4102` `GCodes::ManageTool`; `dictionary/
 *    commands.json`'s own `P: required` on the reviewed entry).
 *  - `M950` by whichever of `H`/`F`/`J`/`P`/`S`/`R`/`E` is present, plus its value - RRF's own
 *    `Platform::ConfigurePort` accepts "exactly one of" these per invocation (`Platform.cpp:4108-
 *    4121`, already cited in `dictionary/commands.json`'s `M950` entry).
 *  - `M308` by `S` (sensor number - `Heat::ConfigureSensor`, cited in the dictionary's `M308` entry).
 *  - `M558` by `K` (Z probe number - cited in the dictionary's `M558` entry).
 *  - `M955` by `P` (accelerometer number - `Accelerometers::ConfigureAccelerometer`, cited in the
 *    dictionary's `M955` entry).
 *  - `M584` per axis letter (plus `E`, the extruder-to-driver mapping) present on the line - RRF's
 *    `GCodes3.cpp` `GCodes::DoDriveMapping` maps each letter independently; `R`/`S` (wrap type, NIST-
 *    rotational) apply to "the axes just mapped" THIS invocation (RRF's own wording), so they travel
 *    with each axis-letter unit rather than the whole line.
 *  - `M574` per axis letter present, or by `E<extruder number>` for the extruder-endstop form -
 *    `EndstopsManager::HandleM574` (`EndstopsManager.cpp:377-470`, cited in the dictionary's `M574`
 *    entry) configures one endstop per invocation; `S`/`P`/`K` describe that one endstop.
 *  - `G10` by its own dispatch rule (`src/commands/g10.ts`'s `g10Form`, already cited to RRF 3.7.0-
 *    rc.1 `GCodes2.cpp` `case 10`): `toolSettings` keys by tool `P` (or "current" when `P` is
 *    absent - a real, documented limit, see this module's own Findings in
 *    `docs/tasks/15-compare.md`); `workplace` keys by coordinate-system `P`; `retract`/
 *    `unrecognised` have no identity.
 *
 * A command with no identity rule here (`G90`, a bare `G1` move, ...) is matched **by position**
 * within its own file, per this task's own Decisions - grouped by `(file, code)` and paired off in
 * order of appearance; extra entries on either side are `added`/`removed`. This is a documented
 * simplification: RRF has no data this package can cite for "these commands are order-sensitive"
 * (the Decisions' own phrase), so position is scoped to one file, never compared across files -
 * unlike an identity-keyed directive, a same-file relocation of a positional unit with unchanged
 * content is invisible here on purpose (nothing semantic changed), and `diffText` is the tool for a
 * caller that wants that positional detail anyway.
 */

import { g10Form, AXIS_LETTERS } from "./commands/g10.js";
import type { DocumentLine, GcodeDocument } from "./document.js";
import { GCODE_FILE_KINDS } from "./files/kinds.js";
import type { LexedCommand } from "./lex.js";
import type { Project } from "./project.js";
import { changesBetween } from "./releases/changes.js";
import type { ChangeEventTarget } from "./releases/schema.js";

// ── the public shape ────────────────────────────────────────────────────────────────────────────

export type DirectiveChange =
	| { type: "added" | "removed"; file: string; line: number; code: string; identity: string }
	| { type: "changed"; file: string; lineA: number; lineB: number; code: string; identity: string; params: ReadonlyArray<{ letter: string; from: string | null; to: string | null }> }
	| { type: "moved"; fileA: string; fileB: string; code: string; identity: string; lineA: number; lineB: number };

export type CompareResult = DirectiveChange & { events?: ReadonlyArray<string> };

export interface TextDiffEntry {
	type: "same" | "added" | "removed";
	lineA?: number;
	lineB?: number;
	text: string;
}

// ── identity extraction ─────────────────────────────────────────────────────────────────────────

interface IdentityHit {
	identity: string;
	params: ReadonlyMap<string, string>;
}

type IdentityFn = (cmd: LexedCommand, doc: GcodeDocument) => ReadonlyArray<IdentityHit>;

interface IdentityRule {
	code: string;
	extract: IdentityFn;
	sources: ReadonlyArray<string>;
}

/** Every parameter on `cmd` except the letters in `exclude`, uppercased, as a plain map - the
 *  "diffable content" of a directive once its identity-defining letter(s) are set aside. Raw
 *  `value` text (quotes/braces included) is compared as-is: a colon list changing (`E3:4` → `E3:5`)
 *  or a quoted pin name changing (`C"out0"` → `C"out1"`) both show up as an ordinary value change,
 *  with no special-casing needed. Map order carries no meaning, so param order on the line never
 *  does either - the "reordered parameters aren't a change" requirement falls out of this for free. */
function paramsExcept(cmd: LexedCommand, exclude: ReadonlySet<string>): Map<string, string> {
	const out = new Map<string, string>();
	for (const p of cmd.params) {
		const letter = p.letter.toUpperCase();
		if (!exclude.has(letter)) out.set(letter, p.value);
	}
	return out;
}

function singleLetterIdentity(code: string, letter: string): IdentityFn {
	return (cmd) => {
		const p = cmd.params.find((pp) => pp.letter.toUpperCase() === letter);
		if (p === undefined) return [];
		return [{ identity: `${code}:${p.value}`, params: paramsExcept(cmd, new Set([letter])) }];
	};
}

/** RRF requires exactly one of these per `M950` (`Platform::ConfigurePort`'s own `charsPresent`
 *  switch) - whichever is present names the resource this line creates/reconfigures. */
const M950_RESOURCE_LETTERS: ReadonlyArray<string> = ["H", "F", "J", "P", "S", "R", "E"];

function m950Identity(cmd: LexedCommand): ReadonlyArray<IdentityHit> {
	for (const letter of M950_RESOURCE_LETTERS) {
		const p = cmd.params.find((pp) => pp.letter.toUpperCase() === letter);
		if (p !== undefined) {
			return [{ identity: `M950:${letter}${p.value}`, params: paramsExcept(cmd, new Set([letter])) }];
		}
	}
	return [];
}

const M584_LETTERS: ReadonlyArray<string> = [...AXIS_LETTERS, "E"];

function m584Identity(cmd: LexedCommand): ReadonlyArray<IdentityHit> {
	const shared = paramsExcept(cmd, new Set(M584_LETTERS)); // R (wrap type), S (NIST-rotational)
	const out: Array<IdentityHit> = [];
	for (const p of cmd.params) {
		const letter = p.letter.toUpperCase();
		if (!M584_LETTERS.includes(letter)) continue;
		const params = new Map(shared);
		params.set(letter, p.value);
		out.push({ identity: `M584:${letter}`, params });
	}
	return out;
}

function m574Identity(cmd: LexedCommand): ReadonlyArray<IdentityHit> {
	const shared = paramsExcept(cmd, new Set([...AXIS_LETTERS, "E"])); // S (type), P (pin), K (probe)
	const out: Array<IdentityHit> = [];
	for (const p of cmd.params) {
		const letter = p.letter.toUpperCase();
		if (AXIS_LETTERS.includes(letter)) {
			const params = new Map(shared);
			params.set(letter, p.value);
			out.push({ identity: `M574:${letter}`, params });
		} else if (letter === "E") {
			const params = new Map(shared);
			params.set("E", p.value);
			out.push({ identity: `M574:E${p.value}`, params });
		}
	}
	return out;
}

function g10Identity(cmd: LexedCommand, doc: GcodeDocument): ReadonlyArray<IdentityHit> {
	const form = g10Form(doc.text.slice(cmd.start, cmd.end));
	if (form !== "toolSettings" && form !== "workplace") return [];
	const p = cmd.params.find((pp) => pp.letter.toUpperCase() === "P");
	if (form === "workplace" && p === undefined) return []; // no coordinate-system number to key by
	const identity = form === "toolSettings" ? `G10:tool:${p?.value ?? "current"}` : `G10:wcs:${p!.value}`;
	return [{ identity, params: paramsExcept(cmd, new Set(["L", "P"])) }];
}

const IDENTITY_RULES: ReadonlyArray<IdentityRule> = [
	{ code: "M563", extract: singleLetterIdentity("M563", "P"),
		sources: ["RRF 3.7.0-rc.1 GCodes.cpp:4102 GCodes::ManageTool", "dwc-gcode-core dictionary/commands.json M563.P (required)"] },
	{ code: "M950", extract: m950Identity,
		sources: ["RRF 3.7.0-rc.1 Platform.cpp:4108-4121 Platform::ConfigurePort (\"exactly one of\" DEFHJPSR)"] },
	{ code: "M308", extract: singleLetterIdentity("M308", "S"),
		sources: ["RRF 3.7.0-rc.1 Heat.cpp:1049 Heat::ConfigureSensor"] },
	{ code: "M558", extract: singleLetterIdentity("M558", "K"),
		sources: ["dwc-gcode-core dictionary/commands.json M558.K"] },
	{ code: "M955", extract: singleLetterIdentity("M955", "P"),
		sources: ["RRF 3.7.0-rc.1 Accelerometers.cpp Accelerometers::ConfigureAccelerometer"] },
	{ code: "M584", extract: m584Identity,
		sources: ["RRF 3.7.0-rc.1 GCodes3.cpp:449-451 GCodes::DoDriveMapping (per-letter drive mapping; R/S apply to \"the axes just mapped\")"] },
	{ code: "M574", extract: m574Identity,
		sources: ["RRF 3.7.0-rc.1 EndstopsManager.cpp:377-470 EndstopsManager::HandleM574"] },
	{ code: "G10", extract: g10Identity,
		sources: ["dwc-gcode-core src/commands/g10.ts g10Form(), citing RRF 3.7.0-rc.1 GCodes2.cpp case 10"] },
];

const IDENTITY_BY_CODE: ReadonlyMap<string, IdentityFn> = new Map(IDENTITY_RULES.map((r) => [r.code, r.extract]));

/** Which commands this module derives an identity key for, and where that key comes from - the
 *  task's own Acceptance criterion ("identity keys cited for every defining command"), as data a
 *  caller (or a test) can actually inspect, not just a claim in a comment. */
export const IDENTITY_KEYS: ReadonlyArray<{ code: string; sources: ReadonlyArray<string> }> =
	IDENTITY_RULES.map(({ code, sources }) => ({ code, sources }));

// ── directive units ─────────────────────────────────────────────────────────────────────────────

interface Unit {
	file: string;
	line: number;
	code: string;
	/** null = no identity rule for this code; matched by position within `(file, code)` instead. */
	identity: string | null;
	params: ReadonlyMap<string, string>;
}

function unitsForLine(doc: GcodeDocument, line: DocumentLine, file: string): Array<Unit> {
	const out: Array<Unit> = [];
	for (const cmd of line.commands) {
		const fn = IDENTITY_BY_CODE.get(cmd.code);
		const hits = fn?.(cmd, doc) ?? [];
		if (hits.length === 0) {
			out.push({ file, line: line.index, code: cmd.code, identity: null, params: paramsExcept(cmd, new Set()) });
		} else {
			for (const hit of hits) out.push({ file, line: line.index, code: cmd.code, identity: hit.identity, params: hit.params });
		}
	}
	return out;
}

function unitsForDocument(doc: GcodeDocument, file: string): Array<Unit> {
	const out: Array<Unit> = [];
	for (const line of doc.lines) out.push(...unitsForLine(doc, line, file));
	return out;
}

function unitsForProject(project: Project): Array<Unit> {
	const out: Array<Unit> = [];
	for (const [path, entry] of project.files) {
		if (entry.doc === null || !GCODE_FILE_KINDS.has(entry.kind)) continue;
		out.push(...unitsForDocument(entry.doc as GcodeDocument, path));
	}
	return out;
}

// ── matching ────────────────────────────────────────────────────────────────────────────────────

function groupKey(u: Unit): string {
	return u.identity !== null ? `id:${u.identity}` : `pos:${u.file}:${u.code}`;
}

function groupBy(units: ReadonlyArray<Unit>): Map<string, Array<Unit>> {
	const groups = new Map<string, Array<Unit>>();
	for (const u of units) {
		const key = groupKey(u);
		const arr = groups.get(key);
		if (arr === undefined) groups.set(key, [u]); else arr.push(u);
	}
	return groups;
}

function sortByLocation(units: ReadonlyArray<Unit>): Array<Unit> {
	return [...units].sort((a, b) => (a.file !== b.file ? (a.file < b.file ? -1 : 1) : a.line - b.line));
}

function paramsEqual(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): boolean {
	if (a.size !== b.size) return false;
	for (const [letter, value] of a) if (b.get(letter) !== value) return false;
	return true;
}

function paramDiff(a: ReadonlyMap<string, string>, b: ReadonlyMap<string, string>): Array<{ letter: string; from: string | null; to: string | null }> {
	const letters = [...new Set([...a.keys(), ...b.keys()])].sort();
	const out: Array<{ letter: string; from: string | null; to: string | null }> = [];
	for (const letter of letters) {
		const from = a.get(letter) ?? null;
		const to = b.get(letter) ?? null;
		if (from !== to) out.push({ letter, from, to });
	}
	return out;
}

function matchGroup(code: string, identity: string | null, unitsA: ReadonlyArray<Unit>, unitsB: ReadonlyArray<Unit>): Array<DirectiveChange> {
	const a = sortByLocation(unitsA);
	const b = sortByLocation(unitsB);
	const out: Array<DirectiveChange> = [];
	const n = Math.min(a.length, b.length);
	for (let i = 0; i < n; i++) {
		const ua = a[i];
		const ub = b[i];
		const label = identity ?? `#${i + 1}`;
		if (paramsEqual(ua.params, ub.params)) {
			// Identity-keyed and unchanged: report a cross-file relocation, but a same-file one is
			// invisible here on purpose (see this module's own header comment).
			if (identity !== null && ua.file !== ub.file) {
				out.push({ type: "moved", fileA: ua.file, fileB: ub.file, code, identity: label, lineA: ua.line, lineB: ub.line });
			}
		} else {
			out.push({ type: "changed", file: ub.file, lineA: ua.line, lineB: ub.line, code, identity: label, params: paramDiff(ua.params, ub.params) });
		}
	}
	for (let i = n; i < a.length; i++) out.push({ type: "removed", file: a[i].file, line: a[i].line, code, identity: identity ?? `#${i + 1}` });
	for (let i = n; i < b.length; i++) out.push({ type: "added", file: b[i].file, line: b[i].line, code, identity: identity ?? `#${i + 1}` });
	return out;
}

function compareUnitSets(unitsA: ReadonlyArray<Unit>, unitsB: ReadonlyArray<Unit>): Array<DirectiveChange> {
	const groupsA = groupBy(unitsA);
	const groupsB = groupBy(unitsB);
	const out: Array<DirectiveChange> = [];
	for (const key of new Set([...groupsA.keys(), ...groupsB.keys()])) {
		const a = groupsA.get(key) ?? [];
		const b = groupsB.get(key) ?? [];
		const sample = a[0] ?? b[0];
		out.push(...matchGroup(sample.code, sample.identity, a, b));
	}
	return out;
}

// ── release annotation ──────────────────────────────────────────────────────────────────────────

function targetMatches(target: ChangeEventTarget, change: DirectiveChange): boolean {
	if (target.type === "command") return target.code === change.code;
	if (target.type === "behaviour") return target.code === change.code;
	if (target.type === "parameter") {
		if (target.code !== change.code) return false;
		return change.type !== "changed" || change.params.some((p) => p.letter.toUpperCase() === target.letter.toUpperCase());
	}
	return false;
}

function annotate(changes: ReadonlyArray<DirectiveChange>, fromVersion: string | undefined, toVersion: string | undefined): ReadonlyArray<CompareResult> {
	if (fromVersion === undefined || toVersion === undefined) return changes;
	const events = changesBetween(fromVersion, toVersion);
	if (events.length === 0) return changes;
	return changes.map((c) => {
		const ids = events.filter((e) => targetMatches(e.target, c)).map((e) => e.id);
		return ids.length > 0 ? { ...c, events: ids } : c;
	});
}

// ── public API ──────────────────────────────────────────────────────────────────────────────────

export function compareDocuments(a: GcodeDocument, b: GcodeDocument, options?: { path?: string; fromVersion?: string; toVersion?: string }): ReadonlyArray<CompareResult> {
	const path = options?.path ?? "";
	const changes = compareUnitSets(unitsForDocument(a, path), unitsForDocument(b, path));
	return annotate(changes, options?.fromVersion, options?.toVersion);
}

export function compareProjects(a: Project, b: Project, options?: { fromVersion?: string; toVersion?: string }): ReadonlyArray<CompareResult> {
	const changes = compareUnitSets(unitsForProject(a), unitsForProject(b));
	return annotate(changes, options?.fromVersion, options?.toVersion);
}

// ── diffText: byte-faithful LCS line diff ──────────────────────────────────────────────────────

/**
 * A classic LCS line diff, O(|a| × |b|) time and space - not meant for multi-megabyte print files
 * (this package's hot path is `tokenise()`, not this), but exact for the config/macro-sized files
 * `compareDocuments`/`compareProjects` above target. Splits on `"\n"` only (a `\r` stays attached to
 * whichever line it ends), so applying the diff - every `"same"`/`"added"` entry's `text`, in order,
 * joined by `"\n"` - reproduces `b` exactly, CRLF included, by construction.
 */
export class DiffTooLargeError extends Error {
	constructor(readonly linesA: number, readonly linesB: number, readonly cells: number) {
		super(
			`diffText: ${linesA} x ${linesB} differing lines needs a ${cells}-cell table, over the ` +
			`${MAX_DIFF_CELLS}-cell limit. Diff smaller files, or use compareDocuments/compareProjects, ` +
			`which don't build one.`,
		);
		this.name = "DiffTooLargeError";
	}
}

/**
 * Largest LCS table `diffText` will allocate, in cells (4 bytes each at `Int32Array`) - 16M cells,
 * so 64 MB, measured AFTER common leading/trailing lines are trimmed off. The cap exists because the
 * table is `O(differing lines squared)`: without it, two 40,000-line files quietly allocate ~6 GB,
 * and because `Int32Array` storage sits outside V8's heap, `--max-old-space-size` won't stop it and a
 * browser tab just dies. Failing loudly with `DiffTooLargeError` beats that.
 */
export const MAX_DIFF_CELLS = 16_000_000;

/** Number of leading elements `x` and `y` share. */
function commonPrefixLength(x: ReadonlyArray<string>, y: ReadonlyArray<string>): number {
	const limit = Math.min(x.length, y.length);
	let i = 0;
	while (i < limit && x[i] === y[i]) i++;
	return i;
}

export function diffText(a: string, b: string): ReadonlyArray<TextDiffEntry> {
	const linesA = a.split("\n");
	const linesB = b.split("\n");
	const n = linesA.length;
	const m = linesB.length;

	// Trim the identical head and tail first. Two versions of one config usually differ in a handful
	// of lines, so this is what keeps the table small in practice - a 5,000-line config with 10 edited
	// lines costs a ~100-cell table instead of a 25,000,000-cell one.
	const prefix = commonPrefixLength(linesA, linesB);
	let suffix = 0;
	while (suffix < Math.min(n, m) - prefix && linesA[n - 1 - suffix] === linesB[m - 1 - suffix]) suffix++;

	const midA = n - suffix - prefix;
	const midB = m - suffix - prefix;
	const cells = (midA + 1) * (midB + 1);
	if (cells > MAX_DIFF_CELLS) throw new DiffTooLargeError(midA, midB, cells);

	const out: Array<TextDiffEntry> = [];
	for (let k = 0; k < prefix; k++) out.push({ type: "same", lineA: k, lineB: k, text: linesA[k] });

	const lcs: Array<Int32Array> = new Array(midA + 1);
	for (let i = 0; i <= midA; i++) lcs[i] = new Int32Array(midB + 1);
	for (let i = midA - 1; i >= 0; i--) {
		for (let j = midB - 1; j >= 0; j--) {
			lcs[i][j] = linesA[prefix + i] === linesB[prefix + j]
				? lcs[i + 1][j + 1] + 1
				: Math.max(lcs[i + 1][j], lcs[i][j + 1]);
		}
	}

	let i = 0;
	let j = 0;
	while (i < midA && j < midB) {
		if (linesA[prefix + i] === linesB[prefix + j]) {
			out.push({ type: "same", lineA: prefix + i, lineB: prefix + j, text: linesA[prefix + i] });
			i++; j++;
		} else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
			out.push({ type: "removed", lineA: prefix + i, text: linesA[prefix + i] });
			i++;
		} else {
			out.push({ type: "added", lineB: prefix + j, text: linesB[prefix + j] });
			j++;
		}
	}
	while (i < midA) { out.push({ type: "removed", lineA: prefix + i, text: linesA[prefix + i] }); i++; }
	while (j < midB) { out.push({ type: "added", lineB: prefix + j, text: linesB[prefix + j] }); j++; }

	for (let k = 0; k < suffix; k++) {
		out.push({ type: "same", lineA: n - suffix + k, lineB: m - suffix + k, text: linesA[n - suffix + k] });
	}
	return out;
}
