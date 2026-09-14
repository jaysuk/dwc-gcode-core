/**
 * A lossless, whole-file G-code document: every line lexed with `lex.ts`'s `lexLine`, plus the
 * line-to-line state a single line can't see on its own — the machine mode in force (`M451`/`M452`/
 * `M453`, verified at RRF 3.7.0-rc.1 in `GCodes2.cpp` `case 451`/`452`/`453`), Fanuc/LaserWeb-style
 * continuation lines resolved against the last `G0`-`G3` command (`lex.ts`'s
 * `resolveFanucContinuation`), and the `if`/`elif`/`else`/`while`/`break`/`continue` block structure
 * (`StringParser::ProcessIfCommand`/`ProcessElseCommand`/`ProcessElifCommand`/`ProcessWhileCommand`/
 * `ProcessBreakCommand`/`ProcessContinueCommand`, all read end to end at 3.7.0-rc.1 — see this
 * module's own citations below).
 *
 * A `GcodeDocument` is an immutable value: every edit function returns a new one (or a `TextEdit` to
 * apply). Round trip is byte-exact — `serializeDocument(parseDocument(t)) === t` for any `t`,
 * mixed/CRLF/lone-CR line endings, a BOM, a missing final newline and all.
 */

import { parseExpression, type ParsedExpression } from "./expr/parse.js";
import {
	lexLine, resolveFanucContinuation, type LexedCommand, type LexedLine, type LexOptions,
	type MachineMode, type ParamKind,
} from "./lex.js";
import { parseAssignment } from "./meta.js";
import type { MetaKeyword } from "./metaKeywords.js";

export interface DocumentOptions {
	/** Mode the document starts in, before any `M451`/`M452`/`M453` line changes it. Default `"fff"`. */
	machineMode?: MachineMode;
}

export interface DocumentLine extends LexedLine {
	/** 0-based line index — `doc.lines[index] === this`. */
	index: number;
	/** Offset of this line's first character within `doc.text` (BOM, if any, already accounted for). */
	start: number;
	/** This line's own terminator — `""` only for the file's last line when it has none. */
	eol: "" | "\n" | "\r\n" | "\r";
	/** The machine mode in force when THIS line was read (i.e. before any `M451`/`M452`/`M453` on
	 *  this very line takes effect — those change the mode for subsequent lines). */
	machineMode: MachineMode;
	/** Set only for a `kind: "fields"` line in laser/cnc mode that actually resolves against the
	 *  last `G0`-`G3` command — see `resolveFanucContinuation`. Null otherwise, including when the
	 *  line merely looks like a continuation but fails one of RRF's own checks. */
	implicitCommand: LexedCommand | null;
}

export interface Block {
	keyword: MetaKeyword;
	/** Index of the line carrying this keyword. */
	line: number;
	/** Index of the last line belonging to this block (inclusive). */
	endLine: number;
	children: ReadonlyArray<Block>;
}

export interface DocumentError { code: string; message: string; line: number; start: number; end: number }

export interface GcodeDocument {
	text: string;
	bom: boolean;
	lines: ReadonlyArray<DocumentLine>;
	/** Top-level blocks (an `if`/`elif`/`else` chain contributes one sibling `Block` per keyword —
	 *  see this module's block-building comment below for why). */
	blocks: ReadonlyArray<Block>;
	/** Every `lexLine` error, plus this module's own structural ones (see the codes list below). */
	errors: ReadonlyArray<DocumentError>;
}

// ── splitting text into lines, preserving each line's own EOL exactly ──────────────────────────────

interface RawLine { raw: string; start: number; eol: "" | "\n" | "\r\n" | "\r" }

/**
 * Splits `text` into lines without discarding how each one ended — needed for byte-exact round trip
 * on a file that mixes LF/CRLF/lone-CR, which a single `split(/\r\n|\n/)` can't reconstruct. Matches
 * `String.prototype.split`'s own convention of producing a trailing empty line after a final
 * terminator (and a single empty line for empty input), so this composes with the rest of the
 * package's existing line-array conventions (`edit.ts`'s `parseLines`).
 */
function splitLines(text: string): Array<RawLine> {
	const lines: Array<RawLine> = [];
	const len = text.length;
	let lineStart = 0;
	let i = 0;
	while (i < len) {
		const c = text.charCodeAt(i);
		if (c === 10 /* \n */) {
			lines.push({ raw: text.slice(lineStart, i), start: lineStart, eol: "\n" });
			i += 1;
			lineStart = i;
		} else if (c === 13 /* \r */) {
			if (text.charCodeAt(i + 1) === 10) {
				lines.push({ raw: text.slice(lineStart, i), start: lineStart, eol: "\r\n" });
				i += 2;
			} else {
				lines.push({ raw: text.slice(lineStart, i), start: lineStart, eol: "\r" });
				i += 1;
			}
			lineStart = i;
		} else {
			i += 1;
		}
	}
	lines.push({ raw: text.slice(lineStart, len), start: lineStart, eol: "" });
	return lines;
}

const BOM = "﻿";

// ── machine mode and Fanuc-continuation tracking ────────────────────────────────────────────────────

function machineModeAfter(current: MachineMode, commands: ReadonlyArray<LexedCommand>): MachineMode {
	let mode = current;
	for (const cmd of commands) {
		// RRF 3.7.0-rc.1 GCodes2.cpp: case 451 -> MachineType::fff, case 452 -> laser, case 453 -> cnc.
		if (cmd.code === "M451") mode = "fff";
		else if (cmd.code === "M452") mode = "laser";
		else if (cmd.code === "M453") mode = "cnc";
	}
	return mode;
}

function lastMotionAfter(current: { letter: "G"; number: 0 | 1 | 2 | 3 } | null, commands: ReadonlyArray<LexedCommand>): { letter: "G"; number: 0 | 1 | 2 | 3 } | null {
	let last = current;
	for (const cmd of commands) {
		if (cmd.letter === "G" && cmd.number !== null && Number.isInteger(cmd.number) && cmd.number >= 0 && cmd.number <= 3) {
			last = { letter: "G", number: cmd.number as 0 | 1 | 2 | 3 };
		}
	}
	return last;
}

// ── block structure ──────────────────────────────────────────────────────────────────────────────
//
// RRF tracks control-flow state per INDENT LEVEL, not per statement: `ProcessIfCommand` calls
// `gb.GetBlockState().SetIfTrueBlock()` on whatever block is currently innermost — which, at the
// moment the `if` line itself is processed, is the block the `if` line lives IN, not a new one for
// its body (that's only created once the first body line's greater indent is actually seen,
// `StringParser::CheckMetaCommand`'s `if (commandIndent > gb.GetBlockIndent()) CreateBlock(...)`).
// A later `elif`/`else`/plain line at the if's OWN indent pops that body block first
// (`while (commandIndent < gb.GetBlockIndent()) EndBlock();`) and then either continues the same
// scope's chain (`elif`/`else`) or leaves it closed.
//
// This module doesn't need to replicate that lazily-created-block mechanism exactly (there is
// nothing here that executes a file), only its OBSERVABLE structural effect: at any given indent, is
// an `elif`/`else` a valid continuation of the `if` that opened it, and is a `break`/`continue`
// lexically inside a `while`. A stack of frames keyed by the CONTROL LINE's own indent, popped
// whenever a later line's indent is not strictly greater, captures exactly that.
//
// Each frame also OWNS a `Block` node, one per keyword (`if`, each `elif`, `else` and `while` each
// get their own sibling node, not a single "if-statement" node) — a caller wanting the whole chain
// can find `elif`/`else` siblings by their shared parent's `children` array and adjacent `line`
// numbers, but keeping them separate mirrors RRF's own per-keyword state and lets each arm's `line`/
// `endLine`/`children` describe exactly its own body.

type FrameKind = "if" | "elif-open" | "closed" | "loop";

interface MutableBlock { keyword: MetaKeyword; line: number; endLine: number; children: Array<MutableBlock> }
interface Frame { indent: number; kind: FrameKind; block: MutableBlock; siblings: Array<MutableBlock> }

interface BlockBuilder {
	push(idx: number, indent: number, kind: MetaKeyword | null, addError: (code: string, message: string) => void): void;
	finish(lastLine: number): Array<Block>;
}

function toReadonlyBlock(b: MutableBlock): Block {
	return { keyword: b.keyword, line: b.line, endLine: b.endLine, children: b.children.map(toReadonlyBlock) };
}

function createBlockBuilder(): BlockBuilder {
	const root: Array<MutableBlock> = [];
	const stack: Array<Frame> = [];

	function popDeeperThan(indent: number, endLine: number): void {
		while (stack.length > 0 && stack[stack.length - 1].indent > indent) {
			stack.pop()!.block.endLine = endLine;
		}
	}
	function popAtLeast(indent: number, endLine: number): void {
		while (stack.length > 0 && stack[stack.length - 1].indent >= indent) {
			stack.pop()!.block.endLine = endLine;
		}
	}
	function currentSiblings(): Array<MutableBlock> {
		return stack.length > 0 ? stack[stack.length - 1].block.children : root;
	}

	return {
		push(idx, indent, keyword, addError) {
			if (keyword === "elif" || keyword === "else") {
				popDeeperThan(indent, idx - 1);
				const top = stack[stack.length - 1];
				const sameLevel = top !== undefined && top.indent === indent;
				if (sameLevel && (top.kind === "if" || top.kind === "elif-open")) {
					// Valid continuation: close the previous arm, open a new sibling in its place.
					top.block.endLine = idx - 1;
					const node: MutableBlock = { keyword, line: idx, endLine: idx, children: [] };
					top.siblings.push(node);
					top.block = node;
					top.kind = keyword === "else" ? "closed" : "elif-open";
				} else if (sameLevel) {
					// Same level, but the chain there is already closed (a prior 'else') or isn't an
					// if/elif chain at all (e.g. a 'while') - record it as its own sibling, in the
					// SAME frame slot (so a later line at this indent sees it, not the arm it followed),
					// closed to any further chaining since it was never valid to begin with.
					addError(
						keyword === "else" ? "else-after-else" : "elif-without-if",
						`'${keyword}' did not follow 'if' — RRF: StringParser::Process${keyword === "else" ? "Else" : "Elif"}Command`,
					);
					top.block.endLine = idx - 1;
					const node: MutableBlock = { keyword, line: idx, endLine: idx, children: [] };
					top.siblings.push(node);
					top.block = node;
					top.kind = "closed";
				} else {
					// Nothing open at this indent at all - a genuinely orphaned elif/else.
					addError(
						keyword === "else" ? "else-without-if" : "elif-without-if",
						`'${keyword}' did not follow 'if' — RRF: StringParser::Process${keyword === "else" ? "Else" : "Elif"}Command`,
					);
					const siblings = currentSiblings();
					const node: MutableBlock = { keyword, line: idx, endLine: idx, children: [] };
					siblings.push(node);
					stack.push({ indent, kind: "closed", block: node, siblings });
				}
			} else if (keyword === "if" || keyword === "while") {
				popAtLeast(indent, idx - 1);
				const siblings = currentSiblings();
				const node: MutableBlock = { keyword, line: idx, endLine: idx, children: [] };
				siblings.push(node);
				stack.push({ indent, kind: keyword === "if" ? "if" : "loop", block: node, siblings });
			} else if (keyword === "break" || keyword === "continue") {
				popAtLeast(indent, idx - 1);
				if (!stack.some((f) => f.kind === "loop")) {
					addError(
						keyword === "break" ? "break-outside-loop" : "continue-outside-loop",
						`'${keyword}' was not inside a loop — RRF: StringParser::Process${keyword === "break" ? "Break" : "Continue"}Command`,
					);
				}
			} else {
				// Any other content (a command, "fields", "unrecognised", or a non-block meta keyword
				// like var/global/set/echo/abort/skip) just participates in indent-based popping.
				popAtLeast(indent, idx - 1);
			}
		},
		finish(lastLine) {
			while (stack.length > 0) stack.pop()!.block.endLine = lastLine;
			return root.map(toReadonlyBlock);
		},
	};
}

// ── mixed-indentation tracking ──────────────────────────────────────────────────────────────────
//
// RRF's `StringParser::CheckForMixedSpacesAndTabs` (3.7.0-rc.1) has two kinds of state, easy to
// conflate: `seenLeadingSpace`/`seenLeadingTab` reset whenever indentation returns to zero (a fresh
// top-level line doesn't need to match a previous nested run's choice), but
// `warnedAboutMixedSpacesAndTabs` is a plain one-time latch that is NEVER reset (not touched in
// `Init()` at all) — so the warning fires at most ONCE per file, even across separate, later,
// otherwise-unrelated nested runs, not once per run. Reproduced faithfully here (including that
// surprise). Source additionally gates the warning behind "at least one meta-command has been seen
// anywhere in the file yet" (`seenMetaCommand`) — an obscure detail that would make this diagnostic
// depend on unrelated lines appearing earlier in the file for no reason a user would expect. This
// module reports the underlying condition without that particular gate, which is the strictly more
// useful behaviour for a static document model — noted here, not silently changed.

function leadingWhitespaceKinds(raw: string, indentChars: number): { hasSpace: boolean; hasTab: boolean } {
	let hasSpace = false;
	let hasTab = false;
	for (let i = 0; i < indentChars; i++) {
		if (raw.charCodeAt(i) === 32) hasSpace = true;
		else if (raw.charCodeAt(i) === 9) hasTab = true;
	}
	return { hasSpace, hasTab };
}

// ── parseDocument / serializeDocument ───────────────────────────────────────────────────────────

export function parseDocument(text: string, options?: DocumentOptions): GcodeDocument {
	const bom = text.length > 0 && text.charCodeAt(0) === 0xfeff;
	const body = bom ? text.slice(1) : text;
	const bomOffset = bom ? 1 : 0;
	const rawLines = splitLines(body);

	const lines: Array<DocumentLine> = [];
	const errors: Array<DocumentError> = [];
	const blockBuilder = createBlockBuilder();

	let mode: MachineMode = options?.machineMode ?? "fff";
	let lastMotion: { letter: "G"; number: 0 | 1 | 2 | 3 } | null = null;
	let seenSpace = false;
	let seenTab = false;
	let warnedMixedIndentation = false;

	for (const rl of rawLines) {
		const idx = lines.length;
		const lexed = lexLine(rl.raw, { machineMode: mode });
		const lineMode = mode;

		let implicitCommand: LexedCommand | null = null;
		if (lexed.kind === "fields" && (mode === "laser" || mode === "cnc") && lastMotion !== null) {
			implicitCommand = resolveFanucContinuation(rl.raw, lastMotion, { machineMode: mode });
		}
		const effectiveCommands = lexed.commands.length > 0 ? lexed.commands : (implicitCommand !== null ? [implicitCommand] : []);
		mode = machineModeAfter(mode, effectiveCommands);
		lastMotion = lastMotionAfter(lastMotion, effectiveCommands);

		const addError = (code: string, message: string): void => {
			errors.push({ code, message, line: idx, start: rl.start + bomOffset, end: rl.start + bomOffset + rl.raw.length });
		};

		for (const e of lexed.errors) {
			// `e.start`/`e.end` are relative to `rl.raw` (lexLine only ever sees one line) - offset by
			// this line's own position in the document to get valid absolute `DocumentError` spans.
			errors.push({ code: e.code, message: e.message, line: idx, start: rl.start + bomOffset + e.start, end: rl.start + bomOffset + e.end });
		}

		// Wiki (Duet3D/wiki-content, Gcodes.md, "Multiple commands on a single line"): "a T-code must
		// not be combined with any other code on the same line."
		if (lexed.commands.length > 1 && lexed.commands.some((c) => c.letter === "T")) {
			addError("t-not-alone", "A T command must be on a line by itself");
		}

		if (lexed.kind !== "comment" && lexed.kind !== "blank") {
			if (lexed.indent === 0) {
				// A fresh top-level line - the previous nested run's choice of space vs. tab doesn't
				// need to match whatever a new one uses (mirrors RRF resetting these flags here too).
				seenSpace = false;
				seenTab = false;
			} else {
				// Recompute how many literal leading characters (not the RRF tab-rounded `indent`
				// value) precede the content, to inspect which whitespace characters were actually used.
				let leadingChars = 0;
				while (leadingChars < rl.raw.length && (rl.raw.charCodeAt(leadingChars) === 32 || rl.raw.charCodeAt(leadingChars) === 9)) leadingChars++;
				const { hasSpace, hasTab } = leadingWhitespaceKinds(rl.raw, leadingChars);
				if (hasSpace) seenSpace = true;
				if (hasTab) seenTab = true;
				if (seenSpace && seenTab && !warnedMixedIndentation) {
					addError("mixed-indentation", "Both spaces and tabs are used to indent nested blocks");
					warnedMixedIndentation = true;
				}
			}
		}

		if (lexed.kind !== "comment" && lexed.kind !== "blank") {
			blockBuilder.push(idx, lexed.indent, lexed.meta, addError);
		}

		lines.push({
			...lexed,
			index: idx,
			start: rl.start + bomOffset,
			eol: rl.eol,
			machineMode: lineMode,
			implicitCommand,
		});
	}

	const blocks = blockBuilder.finish(Math.max(0, lines.length - 1));
	return { text, bom, lines, blocks, errors };
}

export function serializeDocument(doc: GcodeDocument): string {
	let out = doc.bom ? BOM : "";
	for (const line of doc.lines) out += line.raw + line.eol;
	return out;
}

// ── expressions (task 07) ────────────────────────────────────────────────────────────────────────

export type LineExpressionSource =
	| { kind: "param"; command: number; letter: string }
	| { kind: "stringArgument"; command: number }
	| { kind: "meta" };

export interface LineExpression { source: LineExpressionSource; expression: ParsedExpression }

/** Meta keywords that carry an expression at all - `break`/`continue`/`skip` don't (RRF: `if
 *  (gb.buffer[readPointer] != 0) ThrowParseException(...)`-style "unexpected characters" checks for
 *  those, i.e. nothing is meant to follow them - see `ProcessBreakCommand`/`ProcessContinueCommand`,
 *  which read no expression at all). */
const META_KEYWORDS_WITH_EXPRESSION: ReadonlySet<MetaKeyword> = new Set(["if", "elif", "while", "echo", "abort"]);

/** The expression text of an `if`/`elif`/`while`/`echo`/`abort` line: everything after the keyword
 *  and its one mandatory separator (a space/tab, or nothing when the keyword is immediately followed
 *  by `{`/`"`/`(` - the same terminator set `metaKeywordOf` itself checks), up to any trailing
 *  comment. `var`/`global`/`set` are handled separately, via `parseAssignment`, which already
 *  extracts a more precise span (excluding the `NAME =` part). */
function metaExpressionSpan(line: DocumentLine): { start: number; end: number } | null {
	if (line.meta === null || !META_KEYWORDS_WITH_EXPRESSION.has(line.meta)) return null;
	const raw = line.raw;
	let i = 0;
	while (i < raw.length && (raw.charCodeAt(i) === 32 || raw.charCodeAt(i) === 9)) i++; // leading indent
	if (i < raw.length && (raw[i] === "N" || raw[i] === "n")) {
		let j = i + 1;
		while (j < raw.length && raw.charCodeAt(j) >= 48 && raw.charCodeAt(j) <= 57) j++;
		if (j > i + 1) {
			i = j;
			while (i < raw.length && (raw[i] === " " || raw[i] === "\t")) i++;
		}
	}
	i += line.meta.length; // skip the keyword itself
	if (raw[i] === " " || raw[i] === "\t") i++; // its one mandatory separator, if it used one
	const end = line.comment !== null ? line.comment.start : raw.length;
	while (i < end && (raw[i] === " " || raw[i] === "\t")) i++; // tolerate more than one separator
	return { start: i, end };
}

/**
 * Every `{...}` parameter and the expression part of a meta line, parsed. Lazy (not stored on
 * `DocumentLine` - most lines have none) - a caller wanting this for many lines should call it
 * once per line it actually cares about, not scan the whole document up front.
 */
export function expressionsOfLine(doc: GcodeDocument, line: number): ReadonlyArray<LineExpression> {
	const l = requireLine(doc, line);
	const results: Array<LineExpression> = [];

	if (l.meta === "var" || l.meta === "global" || l.meta === "set") {
		const assignment = parseAssignment(l.raw);
		if (assignment !== null) {
			results.push({ source: { kind: "meta" }, expression: parseExpression(assignment.expression, l.start + assignment.expressionStart) });
		}
	} else {
		const span = metaExpressionSpan(l);
		if (span !== null && span.end > span.start) {
			results.push({ source: { kind: "meta" }, expression: parseExpression(l.raw.slice(span.start, span.end), l.start + span.start) });
		}
	}

	l.commands.forEach((cmd, commandIndex) => {
		for (const p of cmd.params) {
			if (p.kind === "expression") {
				results.push({
					source: { kind: "param", command: commandIndex, letter: p.letter },
					expression: parseExpression(p.value, l.start + p.valueStart),
				});
			}
		}
		if (cmd.stringArgument !== null && cmd.stringArgument.value.startsWith("{")) {
			results.push({
				source: { kind: "stringArgument", command: commandIndex },
				expression: parseExpression(cmd.stringArgument.value, l.start + cmd.stringArgument.start),
			});
		}
	});

	return results;
}

// ── edits ────────────────────────────────────────────────────────────────────────────────────────

export interface TextEdit { start: number; end: number; newText: string }

export class UnsafeEditError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "UnsafeEditError";
	}
}

/** Applies non-overlapping edits to `doc.text` and re-parses the result. Edits are applied back to
 *  front (by `start`) so earlier offsets stay valid; two edits may not overlap. */
export function applyEdits(doc: GcodeDocument, edits: ReadonlyArray<TextEdit>, options?: DocumentOptions): GcodeDocument {
	const sorted = [...edits].sort((a, b) => b.start - a.start);
	for (let i = 1; i < sorted.length; i++) {
		if (sorted[i].end > sorted[i - 1].start) {
			throw new Error(`Overlapping edits at ${sorted[i].start}..${sorted[i].end} and ${sorted[i - 1].start}..${sorted[i - 1].end}`);
		}
	}
	let text = doc.text;
	for (const edit of sorted) {
		text = text.slice(0, edit.start) + edit.newText + text.slice(edit.end);
	}
	return parseDocument(text, options ?? { machineMode: doc.lines[0]?.machineMode });
}

function requireLine(doc: GcodeDocument, line: number): DocumentLine {
	const l = doc.lines[line];
	if (l === undefined) throw new RangeError(`Document has no line ${line}`);
	return l;
}

function requireCommand(line: DocumentLine, command: number): LexedCommand {
	const c = line.commands[command];
	if (c === undefined) throw new RangeError(`Line ${line.index} has no command ${command}`);
	return c;
}

/**
 * Replace one command's parameter, leaving the rest of the line untouched. Throws
 * {@link UnsafeEditError} when the existing parameter is an unevaluated `{...}` expression — this
 * package doesn't evaluate RRF expressions, so blindly overwriting `S{global.pa}` would silently
 * discard whatever that expression was doing (the bug this replaces: the old `edit.ts` couldn't even
 * find such a parameter, and appended a duplicate instead).
 */
export function editSetParam(doc: GcodeDocument, line: number, command: number, letter: string, value: string): TextEdit {
	const l = requireLine(doc, line);
	const cmd = requireCommand(l, command);
	const want = letter.toUpperCase();
	const existing = cmd.params.find((p) => p.letter.toUpperCase() === want);
	// `LexedParam`/`LexedCommand` spans are relative to the LINE's own raw text (lexLine only ever
	// sees one line at a time) — every span reported here must be offset by `l.start` to become a
	// valid absolute `TextEdit` into `doc.text`.
	if (existing !== undefined) {
		if (existing.kind === "expression") {
			throw new UnsafeEditError(`Line ${line}'s ${letter} parameter is an expression (${existing.value}) — refusing to overwrite it`);
		}
		return { start: l.start + existing.valueStart, end: l.start + existing.end, newText: value };
	}
	// Append after the command's own text (before any trailing comment/checksum, which `cmd.end`
	// already excludes).
	return { start: l.start + cmd.end, end: l.start + cmd.end, newText: ` ${want}${value}` };
}

export function editRemoveParam(doc: GcodeDocument, line: number, command: number, letter: string): TextEdit {
	const l = requireLine(doc, line);
	const cmd = requireCommand(l, command);
	const want = letter.toUpperCase();
	const existing = cmd.params.find((p) => p.letter.toUpperCase() === want);
	if (existing === undefined) {
		const at = l.start + cmd.end;
		return { start: at, end: at, newText: "" };
	}
	// Swallow one leading space so removing a middle parameter doesn't leave a double space.
	let start = l.start + existing.start;
	if (start > l.start && / |\t/.test(doc.text[start - 1])) start--;
	return { start, end: l.start + existing.end, newText: "" };
}

export function editReplaceLine(doc: GcodeDocument, line: number, newText: string): TextEdit {
	const l = requireLine(doc, line);
	return { start: l.start, end: l.start + l.raw.length, newText };
}

/** Inserts whole lines before `beforeLine` (or at the end of the file when `beforeLine` equals
 *  `doc.lines.length`), using the document's own EOL where one can be inferred from a neighbouring
 *  line, defaulting to `"\n"` for an otherwise-empty document. */
export function editInsertLines(doc: GcodeDocument, beforeLine: number, lines: ReadonlyArray<string>): TextEdit {
	const eol = doc.lines.find((l) => l.eol !== "")?.eol ?? "\n";
	const text = lines.map((l) => l + eol).join("");
	if (beforeLine >= doc.lines.length) {
		const last = doc.lines[doc.lines.length - 1];
		if (last === undefined) return { start: 0, end: 0, newText: text };
		const lastEnd = last.start + last.raw.length + last.eol.length;
		// The current last line may have no trailing EOL - give it one before appending after it.
		const prefix = last.eol === "" && last.raw.length > 0 ? eol : "";
		return { start: lastEnd, end: lastEnd, newText: prefix + text };
	}
	const l = requireLine(doc, beforeLine);
	return { start: l.start, end: l.start, newText: text };
}

export function editRemoveLine(doc: GcodeDocument, line: number): TextEdit {
	const l = requireLine(doc, line);
	return { start: l.start, end: l.start + l.raw.length + l.eol.length, newText: "" };
}

// Re-exported so a consumer of this module doesn't also need to import from "./lex.js" just for the
// parameter-kind type `editSetParam`'s own doc comment references.
export type { ParamKind, LexOptions, MachineMode };
