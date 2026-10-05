/**
 * From "this line uses something that changed" (`scanImpact`) to "this line needs changing, and here is how" (task 12 follow-up).
 *
 * `scanImpact` answers a narrow question - which lines mention a command, parameter, path or syntax feature that some release
 * touched. That is not the question a user has. Most of what it finds cannot hurt them: an ADDED command is no problem on an
 * upgrade, a parameter that now also takes a list does not break a line that gives one value, an `M140 P0 H0` is only wrong when heater 0
 * is also on a tool. This module is the second pass that decides, for every occurrence, whether it is worth the user's time:
 *
 *  - `severityOf`: what kind of event this is when read in the direction the file is moving (`breaks`, `differs`, `info`);
 *  - a per-event RULE (`RULES`), which may look at the line, or at every scanned file (a heater given two jobs is a fact about two
 *    files), to skip an occurrence the files prove harmless, to raise one to `breaks`, and to propose a FIX;
 *  - `planActions`: the result, as `problems` (will fail or stop working), `worthALook` (behaviour differs, a person has to judge) and a
 *    count of what was left out. `info` is never listed - a caller that wants everything still has the `ImpactReport`.
 *
 * A fix is a list of plain text edits (`FileEdit`: file, offsets, replacement), never a command to run, so a caller previews it
 * (`previewEdits`), checks the file has not changed since the scan, and applies it (`applyTextEdits`). Rules for a fix are held to:
 *  1. it comes from what the catalogue entry itself says (each one cites the RRF source that says it), not from a guess at intent;
 *  2. it is idempotent - a file already migrated to the newer firmware must not be damaged by applying it again, because a scan cannot
 *     tell a file that still needs the change from one that has had it. `M575 P1` -> `P2` (the numbering change) is therefore NOT a fix:
 *     a file that already says `P2` would be moved to the wrong port;
 *  3. where the right edit depends on what the user meant (which of two jobs a heater keeps) it offers each choice and picks none.
 *
 * Pure, like the rest of `releases`: the caller gives the files' text and applies the result.
 */
import { parseDocument, type DocumentLine, type GcodeDocument } from "../document.js";
import type { LexedCommand, LexedParam } from "../lex.js";
import type { DirectedChangeEvent } from "./changes.js";
import type { ImpactReport, ScanFile, ScanOccurrence } from "./scan.js";

// ── severity ──────────────────────────────────────────────────────────────────────────────────────

/**
 * How much a change matters to a file that uses it, read in the direction the file is moving:
 *  - `breaks`: the line errors, stops doing anything, or the thing it names is gone;
 *  - `differs`: it still works but behaves differently, and only the owner can say whether that matters;
 *  - `info`: nothing the user has to do (new in this version, deprecated but still working, now accepted more widely).
 */
export type ImpactSeverity = "breaks" | "differs" | "info";

type SeverityOverride = ImpactSeverity | { upgrade?: ImpactSeverity; downgrade?: ImpactSeverity };

/**
 * Events whose default reading (below) is wrong. Keyed by event id, which is a contract (`test/fixtures/event-ids.json`); a test checks
 * every key here is a real event, so a retired id cannot leave a dead entry behind.
 */
const SEVERITY_OVERRIDES: Readonly<Record<string, SeverityOverride>> = {
	// Accepted more widely than before: an upgrade only ever lets more through.
	"m970-can-expansion-boards": { upgrade: "info" },
	"m970-1-can-expansion-boards": { upgrade: "info" },
	"m970-2-can-expansion-boards": { upgrade: "info" },
	"m970-3-can-expansion-boards": { upgrade: "info" },
	"m669-five-bar-d-two-values": { upgrade: "info" },
	"m669-five-bar-own-kinematics-type": { upgrade: "info" },
	"g68-bare-reports-rotation": { upgrade: "info" },
	"m569-2-bare-reports-waveform": { upgrade: "info" },
	"expr-exists-argument-forms": { upgrade: "info" },
	"m116-p-colon-list": { upgrade: "info" },
	"m955-p-uncapped": { upgrade: "info" },
	// Fixes, or a warning where there used to be silence: nothing for a file to change.
	"m201-t-warnings": { upgrade: "info" },
	"m472-r1-recursive-delete-nested": { upgrade: "info" },
	"m581-1-string-literal-hang": { upgrade: "info" },
	"comment-indent-insignificant": { upgrade: "info" },
	"m593-mzv-amplitudes-corrected": { upgrade: "info" },
	// Only a literal delay list that breaks the new check is a problem (the rule below finds those); a delay set by an expression is left out.
	"m593-custom-delays-validated": { upgrade: "info" },
	// Moves with the firmware and nothing in a file selects it.
	"m303-f-default": { upgrade: "info" },
	"m959-expansion-enforces-timeout": { upgrade: "info" },
	"m221-rescales-queued-moves": { upgrade: "info" },
	// An omitted P is an error from this release on (the rule below confirms a line really omits it).
	"m955-p-required": "breaks",
	"m956-p-required": "breaks",
	// "No longer does anything" is a stop-working, not a mere difference.
	"m997-s3-wifi-external-removed": "breaks",
};

/** The default reading of an event, by what kind of change it is and which way the file is moving. */
export function severityOf(event: DirectedChangeEvent): ImpactSeverity {
	const override = SEVERITY_OVERRIDES[event.id];
	if (override !== undefined) {
		const picked = typeof override === "string" ? override : override[event.direction];
		if (picked !== undefined) return picked;
	}
	if (event.direction === "upgrade") {
		switch (event.kind) {
			case "removed": return "breaks";
			case "changed": return "differs";
			default: return "info"; // added, deprecated: still works
		}
	}
	// Downgrade: what was added is missing. A missing COMMAND is an error; a missing parameter or syntax is usually just ignored or differs.
	switch (event.kind) {
		case "added": return event.target.type === "command" ? "breaks" : "differs";
		case "changed": return "differs";
		default: return "info"; // removed (it is back), deprecated (not yet)
	}
}

/** Event ids that carry a severity override, for the consistency test. */
export const SEVERITY_OVERRIDE_IDS: ReadonlyArray<string> = Object.keys(SEVERITY_OVERRIDES);

// ── edits ─────────────────────────────────────────────────────────────────────────────────────────

/** Replace `[start, end)` of `path`'s text (absolute offsets, the same coordinates as `ScanOccurrence`) with `replacement`. */
export interface FileEdit { path: string; start: number; end: number; replacement: string }

/** One way to put a problem right. */
export interface FixOption {
	label: string;
	/** Usually one edit; a choice that touches two lines (a heater's two jobs) lists both. Never overlapping, never adds or removes a line. */
	edits: ReadonlyArray<FileEdit>;
}

export interface Fix {
	/** One sentence on what the edit does and why (plain English, cites nothing - the event's `sources` do). */
	summary: string;
	/** One option: a suggestion to apply. Several: the user has to say which. */
	options: ReadonlyArray<FixOption>;
	/** True when there is a single option that cannot change what the file means to its owner (a missing required parameter given its old
	 *  default). Only these are meant for a one-click "fix all"; a choice never is. */
	safe: boolean;
}

export interface Problem {
	event: DirectedChangeEvent;
	severity: "breaks" | "differs";
	occurrence: ScanOccurrence;
	/** What is wrong with THIS line - the event's own description unless a rule can be more specific. */
	explanation: string;
	/** `null` when there is no edit to propose (advice only: the user has to decide what to use instead). */
	fix: Fix | null;
}

export interface ActionPlan {
	from: string;
	to: string;
	direction: "upgrade" | "downgrade";
	/** Lines that will fail or stop working, in path then line order. */
	problems: ReadonlyArray<Problem>;
	/** Lines that still work but behave differently. */
	worthALook: ReadonlyArray<Problem>;
	/** Occurrences the plan left out because they cannot hurt (`info`) or the files prove harmless. */
	leftOut: number;
}

const EOL = /[\r\n]/;

/**
 * Apply `edits` to one file's text. Edits are single-line (no end-of-line in a replacement: a preview and the line numbers a user was
 * shown stay true) and must not overlap; throws a `RangeError` otherwise or when one lies outside the text.
 */
export function applyTextEdits(text: string, edits: ReadonlyArray<Pick<FileEdit, "start" | "end" | "replacement">>): string {
	const sorted = [...edits].sort((a, b) => a.start - b.start || a.end - b.end);
	let previousEnd = 0;
	for (const e of sorted) {
		if (e.start < 0 || e.end < e.start || e.end > text.length) throw new RangeError(`edit ${e.start}-${e.end} is outside the file`);
		if (e.start < previousEnd) throw new RangeError(`edit ${e.start}-${e.end} overlaps another edit`);
		if (EOL.test(e.replacement)) throw new RangeError("a replacement must not contain a line break");
		if (EOL.test(text.slice(e.start, e.end))) throw new RangeError("an edit must not span a line break");
		previousEnd = e.end;
	}
	let out = "";
	let cursor = 0;
	for (const e of sorted) {
		out += text.slice(cursor, e.start) + e.replacement;
		cursor = e.end;
	}
	return out + text.slice(cursor);
}

/** The files `edits` change, with their new text (a file no edit touches is not returned). */
export function applyFileEdits(files: ReadonlyArray<ScanFile>, edits: ReadonlyArray<FileEdit>): Array<ScanFile> {
	const out: Array<ScanFile> = [];
	for (const file of files) {
		const mine = edits.filter((e) => e.path === file.path);
		if (mine.length > 0) out.push({ path: file.path, text: applyTextEdits(file.text, mine) });
	}
	for (const e of edits) {
		if (!files.some((f) => f.path === e.path)) throw new RangeError(`no file ${e.path} to edit`);
	}
	return out;
}

export interface LineChange {
	path: string;
	/** 1-based, as an editor shows it. */
	line: number;
	before: string;
	after: string;
}

/** The lines `edits` change, before and after, for a diff preview. */
export function previewEdits(files: ReadonlyArray<ScanFile>, edits: ReadonlyArray<FileEdit>): Array<LineChange> {
	const out: Array<LineChange> = [];
	for (const next of applyFileEdits(files, edits)) {
		const before = files.find((f) => f.path === next.path)!.text;
		const beforeLines = splitLines(before);
		const afterLines = splitLines(next.text);
		const touched = new Set<number>();
		for (const e of edits) if (e.path === next.path) touched.add(lineAt(before, e.start));
		for (const index of [...touched].sort((a, b) => a - b)) {
			out.push({ path: next.path, line: index + 1, before: beforeLines[index] ?? "", after: afterLines[index] ?? "" });
		}
	}
	return out;
}

function splitLines(text: string): Array<string> { return text.split(/\r\n|\n|\r/); }

/** 0-based line index of an offset. */
function lineAt(text: string, offset: number): number {
	let line = 0;
	for (let i = 0; i < offset; i++) {
		const c = text.charCodeAt(i);
		if (c === 10 || (c === 13 && text.charCodeAt(i + 1) !== 10)) line++;
	}
	return line;
}

// ── what the rules can see ────────────────────────────────────────────────────────────────────────

interface HeaterUse {
	role: "bed" | "chamber" | "tool";
	path: string;
	line: DocumentLine;
	command: LexedCommand;
	param: LexedParam;
	heaters: ReadonlyArray<number>;
	/** Inside an if/while block: whether it runs is not something the file alone says. */
	conditional: boolean;
}

const HEATER_ROLE: Readonly<Record<string, HeaterUse["role"]>> = { M140: "bed", M141: "chamber", M563: "tool" };
const ROLE_NAME: Readonly<Record<HeaterUse["role"], string>> = { bed: "bed heater (M140)", chamber: "chamber heater (M141)", tool: "tool (M563)" };

/** Every scanned file, parsed once and only when a rule asks. */
class FileIndex {
	private readonly docs = new Map<string, GcodeDocument>();
	private uses: Array<HeaterUse> | null = null;

	constructor(readonly files: ReadonlyArray<ScanFile>) {}

	doc(path: string): GcodeDocument | null {
		let doc = this.docs.get(path);
		if (doc === undefined) {
			const file = this.files.find((f) => f.path === path);
			if (file === undefined) return null;
			doc = parseDocument(file.text);
			this.docs.set(path, doc);
		}
		return doc;
	}

	/** Every M140/M141/M563 `H` that lists only plain heater numbers, across every file. */
	heaterUses(): ReadonlyArray<HeaterUse> {
		if (this.uses !== null) return this.uses;
		const uses: Array<HeaterUse> = [];
		for (const file of this.files) {
			const doc = this.doc(file.path);
			if (doc === null) continue;
			for (const line of doc.lines) {
				for (const command of line.commands) {
					const role = HEATER_ROLE[command.code];
					if (role === undefined) continue;
					const param = command.params.find((p) => p.letter === "H");
					const heaters = param === undefined ? null : plainIntList(param.value);
					if (param === undefined || heaters === null) continue;
					uses.push({ role, path: file.path, line, command, param, heaters, conditional: insideBlock(doc, line.index) });
				}
			}
		}
		this.uses = uses;
		return uses;
	}
}

function insideBlock(doc: GcodeDocument, lineIndex: number): boolean {
	return doc.blocks.some((b) => b.line <= lineIndex && lineIndex <= b.endLine);
}

/** `"0:1"` -> `[0, 1]`; null for an expression, a bare letter or anything else not a plain list of integers. */
function plainIntList(raw: string): Array<number> | null {
	const parts = raw.trim().split(":");
	const out: Array<number> = [];
	for (const p of parts) {
		if (!/^-?\d+$/.test(p.trim())) return null;
		out.push(Number(p));
	}
	return out;
}

interface RuleContext {
	event: DirectedChangeEvent;
	occurrence: ScanOccurrence;
	file: ScanFile;
	doc: GcodeDocument;
	line: DocumentLine;
	/** The command the occurrence sits in (found by its offsets), or `undefined` when the occurrence is not inside a command (an expression). */
	command: LexedCommand | undefined;
	index: FileIndex;
}

interface RuleResult {
	/** The files prove this occurrence harmless. */
	skip?: true;
	severity?: "breaks" | "differs";
	explanation?: string;
	fix?: Fix;
	/** Two occurrences with the same key are one problem seen from two lines (a heater's two jobs): only the first is kept. */
	dedupeKey?: string;
}

type Rule = (ctx: RuleContext) => RuleResult;

const baseName = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

/** An edit that deletes one `H` heater from a use: the list without it; `-1` for a bed or chamber slot (RRF reads `H-1` as "none"), the parameter removed for a tool. */
function withoutHeater(use: HeaterUse, heater: number): FileEdit {
	const remaining = use.heaters.filter((h) => h !== heater);
	const base = use.line.start;
	if (remaining.length > 0 || use.role !== "tool") {
		return { path: use.path, start: base + use.param.valueStart, end: base + use.param.end, replacement: remaining.length > 0 ? remaining.join(":") : "-1" };
	}
	// A tool with no heater is an M563 with no H: take the parameter and the space before it.
	let start = base + use.param.start;
	const text = use.line.raw;
	while (start > base && /[ \t]/.test(text[start - base - 1])) start--;
	return { path: use.path, start, end: base + use.param.end, replacement: "" };
}

/**
 * A heater given two jobs. 3.6.3 let `M140 H0` and `M563 H0` (or M141) coexist; 3.7 rejects the line that comes second. The event matches
 * every such line, including the great majority that are fine, so this checks the other files for the same heater number.
 */
const heaterConflictRule: Rule = (ctx) => {
	const own = ctx.command === undefined ? undefined : ctx.index.heaterUses().find((u) => u.path === ctx.file.path && u.line.index === ctx.line.index && u.command.start === ctx.command!.start);
	if (own === undefined) return { skip: true };

	if (ctx.event.direction === "downgrade") {
		// A colon list is a 3.7 form; 3.6.3 takes one heater number. M563's H was always a list, so only the bed and the chamber matter.
		if (own.role === "tool" || own.heaters.length < 2) return { skip: true };
		return { severity: "breaks", explanation: `${ctx.command!.code} H${own.param.value} lists several heaters, which only 3.7 and later accept; 3.6.3 takes one heater number per slot.` };
	}

	for (const heater of own.heaters) {
		if (heater < 0) continue;
		const other = ctx.index.heaterUses().find((u) => u !== own && u.role !== own.role && u.heaters.includes(heater));
		if (other === undefined) continue;
		const key = `heater-two-jobs:${heater}:${[own, other].map((u) => `${u.path}:${u.line.index}`).sort().join("|")}`;
		const where = `${baseName(other.path)}:${other.line.index + 1}`;
		const explanation = `Heater ${heater} is both a ${ROLE_NAME[own.role]} here and a ${ROLE_NAME[other.role]} at ${where}. 3.6.3 let that through; 3.7 refuses whichever of the two lines runs second.`;
		if (own.conditional || other.conditional) {
			// One of them sits inside an if/while: the file does not say both run, so say what to look at and offer no edit.
			return { severity: "differs", dedupeKey: key, explanation: `${explanation} One of the two lines is inside an if/while block, so check whether both can run on the same machine.` };
		}
		return {
			severity: "breaks",
			dedupeKey: key,
			explanation,
			fix: {
				summary: `Heater ${heater} can only do one of these jobs. Pick which line keeps it.`,
				safe: false,
				options: [
					{ label: `Take heater ${heater} off this ${ROLE_NAME[own.role]} line`, edits: [withoutHeater(own, heater)] },
					{ label: `Take heater ${heater} off the ${ROLE_NAME[other.role]} line at ${where}`, edits: [withoutHeater(other, heater)] },
				],
			},
		};
	}
	return { skip: true };
};

/** A command that must now give `P` and does not. Before, an omitted P meant 0, so adding `P0` keeps the line doing exactly what it did. */
function missingP(code: string): Rule {
	return (ctx) => {
		const cmd = ctx.command;
		if (cmd === undefined || cmd.code !== code || cmd.params.some((p) => p.letter === "P")) return { skip: true };
		const last = cmd.params[cmd.params.length - 1];
		// After the last parameter, or straight after the command word when there is none.
		const at = ctx.line.start + (last !== undefined ? last.end : cmd.start + code.length);
		return {
			severity: "breaks",
			explanation: `${code} must give P, the accelerometer number, from this release. Without it the line is rejected.`,
			fix: {
				summary: `Add P0, which is what an omitted P meant, so the line keeps doing what it did.`,
				safe: true,
				options: [{ label: `Add P0 to ${code}`, edits: [{ path: ctx.file.path, start: at, end: at, replacement: " P0" }] }],
			},
		};
	};
}

/** A parameter value that is a plain number as written (an expression, a variable or a list is not). */
function literalNumber(value: string): number | undefined {
	return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(value) ? Number(value) : undefined;
}

/** The shaper name an `M593 P"..."` gives, without its quotes; `undefined` when the line has no P, `null` when P is not a plain quoted word. */
function shaperNameOf(cmd: LexedCommand): string | null | undefined {
	const p = cmd.params.find((x) => x.letter === "P");
	if (p === undefined) return undefined;
	const m = /^"([^"{}]*)"$/.exec(p.value);
	return m === null ? null : m[1];
}

/**
 * 3.7.0 caps M593's damping ratio at 0.9 (0.3 for ei2, 0.2 for ei3), where 3.7.0-rc.2 allowed 0.99. The event matches every `M593 S`; only a literal
 * above the cap for the shaper on the same line is a break. Without a P the shaper is whatever was set before, which a file cannot say, so a value
 * above 0.2 (the lowest cap) is worth a look and one above 0.9 is certain to be rejected.
 */
const m593DampingRule: Rule = (ctx) => {
	const cmd = ctx.command;
	if (ctx.event.direction !== "upgrade") return { skip: true }; // going back only raises the cap
	if (cmd === undefined || cmd.code !== "M593") return {};
	const s = cmd.params.find((p) => p.letter === "S");
	const value = s === undefined ? undefined : literalNumber(s.value);
	if (value === undefined) return {}; // an expression: only the owner can say
	const name = shaperNameOf(cmd);
	if (name === null) return {};
	const cap = name === "ei2" ? 0.3 : name === "ei3" ? 0.2 : 0.9;
	if (name === undefined) {
		if (value <= 0.2) return { skip: true };
		if (value <= 0.9) return { severity: "differs", explanation: `M593 S${s!.value} has no P, so the cap is the one for the shaper set earlier: 0.9, but 0.3 for ei2 and 0.2 for ei3. From 3.7.0 a value above that cap is rejected.` };
	} else if (value <= cap) return { skip: true };
	return { severity: "breaks", explanation: `M593 S${s!.value} is above the ${cap} limit for ${name === undefined ? "any shaper" : `P"${name}"`} from 3.7.0 (rc.2 allowed 0.99). The line is rejected with "parameter 'S' too high".` };
};

/** A custom shaper's T delays must be positive and strictly increasing from 3.7.0. Only a literal list that breaks that is reported. */
const m593DelaysRule: Rule = (ctx) => {
	const cmd = ctx.command;
	if (ctx.event.direction !== "upgrade") return { skip: true }; // going back only drops the check
	if (cmd === undefined || cmd.code !== "M593") return {};
	const name = shaperNameOf(cmd);
	if (name !== undefined && name !== "custom") return { skip: true }; // T is read only for a custom shaper
	const t = cmd.params.find((p) => p.letter === "T");
	if (t === undefined) return { skip: true };
	const delays = t.value.split(":").map(literalNumber);
	if (delays.some((d) => d === undefined)) return {}; // an expression
	const ok = (delays as Array<number>).every((d, i, all) => d > 0 && (i === 0 || d > all[i - 1]));
	if (ok) return { skip: true };
	return { severity: "breaks", explanation: `M593 T${t.value}: the delays of a custom shaper must be positive and strictly increasing from 3.7.0. This line is rejected with "Delays must be positive and in strictly increasing order" and input shaping is turned off.` };
};

const RULES: Readonly<Record<string, Rule>> = {
	"m955-p-required": missingP("M955"),
	"m956-p-required": missingP("M956"),
	"m140-h-colon-list": heaterConflictRule,
	"m141-h-colon-list": heaterConflictRule,
	"m563-h-rejects-bed-or-chamber-heater": heaterConflictRule,
	"m593-s-damping-limit": m593DampingRule,
	"m593-custom-delays-validated": m593DelaysRule,
};

/** Event ids that have a rule, for the consistency test. */
export const RULE_EVENT_IDS: ReadonlyArray<string> = Object.keys(RULES);

// ── the plan ──────────────────────────────────────────────────────────────────────────────────────

/**
 * Turn an `ImpactReport` into what the user has to do. `files` must be the files the report was made from (their text is what the
 * occurrences' offsets index into); an occurrence whose file is not among them is kept with its event's own reading and no fix.
 */
export function planActions(report: ImpactReport, files: ReadonlyArray<ScanFile>): ActionPlan {
	const index = new FileIndex(files);
	const problems: Array<Problem> = [];
	const worthALook: Array<Problem> = [];
	const seen = new Set<string>();
	let leftOut = 0;

	for (const group of report.byEvent) {
		const rule = RULES[group.event.id];
		for (const occurrence of group.occurrences) {
			let result: RuleResult = {};
			if (rule !== undefined) {
				const file = files.find((f) => f.path === occurrence.path);
				const doc = file === undefined ? null : index.doc(file.path);
				if (file !== undefined && doc !== null) {
					const line = doc.lines[occurrence.line];
					const command = line.commands.find((c) => line.start + c.start <= occurrence.start && occurrence.start <= line.start + c.end);
					result = rule({ event: group.event, occurrence, file, doc, line, command, index });
				}
			}
			if (result.skip === true) { leftOut++; continue; }
			const severity = result.severity ?? severityOf(group.event);
			if (severity === "info") { leftOut++; continue; }
			if (result.dedupeKey !== undefined) {
				if (seen.has(result.dedupeKey)) { leftOut++; continue; }
				seen.add(result.dedupeKey);
			}
			const problem: Problem = { event: group.event, severity, occurrence, explanation: result.explanation ?? group.event.description, fix: result.fix ?? null };
			(severity === "breaks" ? problems : worthALook).push(problem);
		}
	}

	const byPlace = (a: Problem, b: Problem): number => (a.occurrence.path < b.occurrence.path ? -1 : a.occurrence.path > b.occurrence.path ? 1 : 0) || a.occurrence.line - b.occurrence.line;
	return { from: report.from, to: report.to, direction: report.direction, problems: problems.sort(byPlace), worthALook: worthALook.sort(byPlace), leftOut };
}
