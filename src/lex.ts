/**
 * G-code line lexer, faithful to RepRapFirmware's own line-splitting rules
 * (`src/GCodes/GCodeBuffer/StringParser.cpp`, checked directly against RRF 3.7.0-rc.1 source —
 * `Put`, `DecodeCommand`, `FindParameters`, `SetFinished` — not inferred from example files).
 *
 * The rules that make this a real state machine rather than a `;`-then-space split, each verified
 * by tracing RRF's own character-by-character `Put()`:
 *  - **Several commands can share one line.** An unquoted, unbraced `G` or `M` ends whatever
 *    command came before it and starts a new one at that exact character (`FindParameters`'s
 *    `if (c2=='G'||c2=='M') break;`, `SetFinished`'s `commandStart = commandEnd; DecodeCommand();`).
 *    `T` does **not** do this — a `T` parameter (e.g. `M104 T1`) is just a parameter.
 *  - **Parameters split at every letter, not at whitespace.** `G1X10Y20` is `X=10 Y=20`; a value
 *    runs until the next parameter letter (or the next command, or end of line).
 *  - **`E` right after a digit is an exponent, not a parameter** — `G1 X1e3` is one parameter,
 *    `X=1e3` — unless it is the very first character being scanned.
 *  - **A leading `'` escapes the next letter as a lowercase axis parameter**, valid for `A` through
 *    `HighestAxisLetter` (`'z'` on 64-bit-bitmap boards, `'f'` on 32-bit ones —
 *    `src/RepRapFirmware.h`; this package always allows up to `'z'`, the more permissive case).
 *    Escaped letters are recorded separately from the plain form of the same letter (RRF stores them
 *    in a disjoint bitmap range) and — unlike a bare letter — an escaped `G`/`M` does **not** end the
 *    command; only an *unescaped* one does.
 *  - **`(...)` is a comment only when the machine is in CNC mode**, and only outside an open `{...}`
 *    expression; it does not nest, and RRF splices it out of the line entirely rather than treating
 *    everything after it as a trailing comment (`G1(note)X10` in CNC mode reads as `G1X10`).
 *  - **A `*NN` checksum is only recognised when the line had an `N` line number and no `{...}` is
 *    open.** Once the checksum's digits end, RRF discards the rest of the line unconditionally
 *    (even if it looks like a `;` comment).
 *  - **Some commands take the rest of the line as one unquoted string**, not letter parameters — see
 *    `STRING_ARGUMENT_COMMANDS` below.
 *
 * One thing this module deliberately does NOT reproduce: RRF's own bookkeeping about which `;` it
 * literally stores versus discards internally (`commandIndent == 0 && gcodeLineEnd == 0` in `Put`)
 * only matters for RRF's echo/checksum accounting — an editor needs the comment TEXT regardless of
 * where on the line it starts, so `comment` here is populated whenever an unquoted, unbraced `;` is
 * found, indented or not. The observable effect for execution (a comment-only line, indented or not,
 * does nothing and never affects block indentation) is unchanged and is already documented on
 * `meta.ts`'s `ClassifiedLine.indent`.
 *
 * Deliberately allocation-light on the common path: a full pass over a 200 MB file lexes every
 * line, so this returns index spans into the original string. `lexLine` is the primary entry point;
 * `tokenise`/`parseParams` (this file's and `params.ts`'s) remain as thin, deprecated views over it
 * for callers that only care about a line's first command.
 */

import { isDigit, leadingIndent } from "./chars.js";
import { metaKeywordOf, type MetaKeyword } from "./metaKeywords.js";

export type { MetaKeyword };

export type MachineMode = "fff" | "laser" | "cnc";

export interface LexOptions {
	/** Default `"fff"`. Only affects `(...)` bracketed-comment recognition (CNC only) — see the
	 *  module doc comment. Multiple motion systems / Fanuc-style continuation lines are line-to-line
	 *  state, tracked by the document model (`docs/tasks/06-document-model.md`), not here. */
	machineMode?: MachineMode;
}

/**
 * Commands whose argument is the rest of the line (RRF's `GetUnprecedentedString`), not letter
 * parameters. The complete list, found by grepping every `GetUnprecedentedString` call site in RRF
 * 3.7.0-rc.1 and confirming each `case`, all in `src/GCodes/GCodes2.cpp`:
 *  - `M23`/`M32` ("Set file to print" / "Select file and start SD print", a shared handler) — :1126
 *  - `M28` ("Write to file") — :1362
 *  - `M30` ("Delete file") — :1383
 *  - `M36` ("Return file information", empty allowed) — :1422
 *  - `M38` ("Report CRC32 of file") — :1499
 *  - `M117` ("Display message", empty allowed) — :2090
 *
 * `M550`, `M551` and `M37` were checked too, on the strength of looking like plausible candidates,
 * and do NOT belong here: they read their string through `TryGetPossiblyQuotedString('P', ...)` /
 * `GetPossiblyQuotedString` behind an explicit `P` parameter, not as an unprecedented whole-line
 * string. Confirmed by reading `GCodes2.cpp` line by line, not assumed from the command's shape.
 */
export const STRING_ARGUMENT_COMMANDS: ReadonlySet<string> = new Set([
	"M23", "M28", "M30", "M32", "M36", "M38", "M117",
]);

/** RRF's `HighestAxisLetter` (`src/RepRapFirmware.h`): `'z'` on boards with a 64-bit
 *  `ParameterLettersBitmap` (Duet 3 / STM32H7), `'f'` on boards with a 32-bit one. This package
 *  always uses the more permissive `'Z'` — see `docs/tasks/05-lexer.md`'s Findings. */
const HIGHEST_AXIS_LETTER = "Z";
const HIGHEST_AXIS_LETTER_CODE = HIGHEST_AXIS_LETTER.charCodeAt(0);

export type ParamKind = "empty" | "number" | "list" | "string" | "expression" | "other";

export interface LexedParam {
	/** Uppercase, or lowercase when this is an escaped axis parameter (`escapedAxis: true`). */
	letter: string;
	/** True for a `'`-escaped axis letter (e.g. the `a` in `'a10`) — recorded separately from a
	 *  plain parameter of the same letter, matching RRF's own disjoint bitmap ranges for the two. */
	escapedAxis: boolean;
	/** Raw value text exactly as written — quotes/braces included, trailing whitespace excluded. */
	value: string;
	kind: ParamKind;
	/** Index of the letter (or of the `'` for an escaped one) within the line passed to `lexLine`. */
	start: number;
	valueStart: number;
	/** End index (exclusive) of the value. */
	end: number;
}

export interface LexedCommand {
	letter: "G" | "M" | "T";
	/** May be fractional (`38.2`) or negative (`T-1`); null for a bare command with no number. */
	number: number | null;
	/** Uppercase command, e.g. "G1", "M104", "T0", "G38.2", "T-1", "T". */
	code: string;
	start: number;
	end: number;
	/** Empty when `stringArgument` is set (`STRING_ARGUMENT_COMMANDS`). */
	params: ReadonlyArray<LexedParam>;
	/** Set only for `STRING_ARGUMENT_COMMANDS`. Raw text — quotes/braces included when the value was
	 *  quoted or an expression; for a plain value, the rest of the line with trailing whitespace
	 *  stripped (RRF's own `InternalGetPossiblyQuotedString`+`StripTrailingSpaces`), reading right
	 *  through any embedded `G`/`M`/`;`-shaped text — RRF resets `commandEnd` to the true end of line
	 *  for exactly this reason (`GetUnprecedentedString`'s doc comment: provided for M23 and similar
	 *  "legacy" filename/message commands). */
	stringArgument: { value: string; start: number; end: number } | null;
}

export interface LexError { code: string; message: string; start: number; end: number }

export interface LexedLine {
	/** The original line, without its newline. */
	raw: string;
	/** RRF's own leading-indentation count — see `chars.ts`'s `leadingIndent`. */
	indent: number;
	lineNumber: { value: number; start: number; end: number } | null;
	/** Recognised only when the line had a line number and no `{...}` was open at the `*`. */
	checksum: { value: number; start: number; end: number } | null;
	/** Every command found on the line, in order. Empty unless `kind === "commands"`. */
	commands: ReadonlyArray<LexedCommand>;
	/** `;` to end of line — see the module doc comment for why this is populated regardless of
	 *  indentation, unlike RRF's own internal echo/checksum bookkeeping. */
	comment: { text: string; start: number; end: number } | null;
	/** `(...)` comments, CNC mode only, in the order they appear. */
	bracketedComments: ReadonlyArray<{ text: string; start: number; end: number }>;
	/** Set when the line is a meta-command (`if`/`var`/`while`/…) — `commands` is then empty. */
	meta: MetaKeyword | null;
	/**
	 * - `"commands"` — one or more G/M/T commands.
	 * - `"meta"` — a conditional-G-code keyword; see `meta` above.
	 * - `"comment"` — nothing but a comment (`;` text and/or, in CNC mode, `(...)` text).
	 * - `"blank"` — nothing at all (after indentation and an optional line number).
	 * - `"fields"` — letters/values with no G/M/T command, e.g. `X10 Y20` or `'a10 X5` — a Fanuc-style
	 *   continuation candidate in laser/cnc mode; resolving that needs the previous line's modal
	 *   command, which is line-to-line state the document model (task 06) tracks, not this function.
	 * - `"unrecognised"` — content that isn't any of the above (e.g. starts with a digit or symbol).
	 */
	kind: "commands" | "meta" | "comment" | "blank" | "fields" | "unrecognised";
	errors: ReadonlyArray<LexError>;
}

function isSpaceCh(ch: string | undefined): boolean {
	return ch === " " || ch === "\t";
}
function isDigitCh(ch: string | undefined): boolean {
	return ch !== undefined && isDigit(ch.charCodeAt(0));
}

/**
 * A "content" region of a line is almost always one contiguous slice of `raw` (the overwhelmingly
 * common case: no CNC bracketed comment on the line at all), so instead of building a per-character
 * array (which allocates one object per character — measured far too slow for a 200 MB-file hot
 * path: ~3x slower than the flat-string scan it replaced), content is represented as a small list of
 * `[rawStart, rawEnd)` segments (length 1 unless a bracketed comment spliced the line, in which case
 * one more segment per splice), concatenated once into a plain string, `contentText`. `mapToRaw`
 * converts a `contentText` index back to its position in `raw` by walking this (tiny) segment list —
 * O(1) in the common single-segment case.
 */
interface ContentSegment { rawStart: number; rawEnd: number }

function mapToRaw(segments: ReadonlyArray<ContentSegment>, ci: number): number {
	let remaining = ci;
	for (let s = 0; s < segments.length; s++) {
		const seg = segments[s];
		const len = seg.rawEnd - seg.rawStart;
		if (remaining <= len) return seg.rawStart + remaining;
		remaining -= len;
	}
	const last = segments[segments.length - 1];
	return last ? last.rawEnd : ci;
}

/**
 * First pass: walk the line character by character exactly as `StringParser::Put` does (minus line
 * splitting, since we already have one line), locating the trailing comment, any CNC bracketed
 * comments (spliced out of the retained content, not just truncating at the first one — see
 * `ContentSegment`), and a checksum. Scalar state only; no per-character allocation.
 */
function scanContent(
	raw: string,
	start: number,
	machineMode: MachineMode,
	hasLineNumber: boolean,
): {
	segments: Array<ContentSegment>;
	contentText: string;
	bracketedComments: Array<{ text: string; start: number; end: number }>;
	comment: { text: string; start: number; end: number } | null;
	checksum: { value: number; start: number; end: number } | null;
	errors: Array<LexError>;
} {
	const bracketedComments: Array<{ text: string; start: number; end: number }> = [];
	let comment: { text: string; start: number; end: number } | null = null;
	let checksum: { value: number; start: number; end: number } | null = null;
	const errors: Array<LexError> = [];
	const cnc = machineMode === "cnc";
	const len = raw.length;

	let inQuotes = false;
	let inBracket = false;
	let braceCount = 0;
	let bracketStart = -1;
	let quoteStart = -1;
	let truncateAt = len;

	let i = start;
	for (; i < len; i++) {
		const c = raw.charCodeAt(i);
		if (inBracket) {
			if (c === 41 /* ) */) {
				bracketedComments.push({ text: raw.slice(bracketStart, i + 1), start: bracketStart, end: i + 1 });
				inBracket = false;
			}
			continue;
		}
		if (inQuotes) {
			if (c === 34 /* " */) inQuotes = false;
			continue;
		}
		if (c === 34) { inQuotes = true; quoteStart = i; continue; }
		if (cnc && c === 40 /* ( */ && braceCount === 0) { inBracket = true; bracketStart = i; continue; }
		if (c === 123 /* { */) { braceCount++; continue; }
		if (c === 125 /* } */) { if (braceCount > 0) braceCount--; continue; }
		if (c === 42 /* * */ && hasLineNumber && braceCount === 0) {
			let j = i + 1;
			while (j < len && isDigit(raw.charCodeAt(j))) j++;
			if (j > i + 1) checksum = { value: Number(raw.slice(i + 1, j)), start: i, end: j };
			truncateAt = i;
			// RRF discards everything after the checksum's digits unconditionally, even text that
			// would otherwise look like a `;` comment - so there is nothing left to scan for.
			i = len;
			break;
		}
		if (c === 59 /* ; */) {
			comment = { text: raw.slice(i + 1), start: i, end: len };
			truncateAt = i;
			break;
		}
	}

	// The following three checks are this package's OWN diagnostics, not something RRF's `Put()`
	// itself flags (an unterminated quote, brace or bracketed comment just runs to end of line for
	// RRF, silently) - useful for an editor, not sourced from a firmware error.
	if (inQuotes) {
		errors.push({ code: "unterminated-string", message: "Unterminated quoted string", start: quoteStart, end: len });
	}
	if (inBracket) {
		errors.push({ code: "unterminated-bracketed-comment", message: "Unterminated bracketed comment", start: bracketStart, end: len });
	}
	if (braceCount > 0) {
		errors.push({ code: "unbalanced-brace", message: "Unbalanced { in expression", start, end: len });
	}

	// An unterminated bracketed comment swallows everything from "(" to end of line (nothing after
	// it was ever stored by RRF either), so the retained content stops there too.
	const contentEnd = inBracket ? bracketStart : truncateAt;
	const segments: Array<ContentSegment> = [];
	let cursor = start;
	for (const b of bracketedComments) {
		if (b.start >= contentEnd) break;
		segments.push({ rawStart: cursor, rawEnd: b.start });
		cursor = b.end;
	}
	segments.push({ rawStart: cursor, rawEnd: Math.max(cursor, contentEnd) });

	let contentText: string;
	if (segments.length === 1) {
		contentText = raw.slice(segments[0].rawStart, segments[0].rawEnd); // the common case: one slice
	} else {
		contentText = "";
		for (const seg of segments) contentText += raw.slice(seg.rawStart, seg.rawEnd);
	}

	return { segments, contentText, bracketedComments, comment, checksum, errors };
}

const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const SPECIAL_CHAR_RE = /['"{]/;

function classifyValue(value: string): ParamKind {
	if (value.length === 0) return "empty";
	if (value[0] === "\"") return "string";
	if (value[0] === "{") return "expression";
	// A colon-list convention this package uses for editing purposes (see params.ts's
	// paramNumberList) - not something RRF's own lexing distinguishes at this level.
	if (value.includes(":")) return "list";
	return NUMBER_RE.test(value) ? "number" : "other";
}

/** `ci` is the LETTER's own index (where its value starts from). `tokenStart` is where the whole
 *  parameter token starts, which for a `'`-escaped axis is the `'` one character earlier — they
 *  differ only in that case. Both are needed: the value runs from `ci + 1`, but the parameter's own
 *  span (and the point at which the PREVIOUS parameter's value must stop) is `tokenStart`, or the
 *  `'` would both fall outside this parameter's span and leak into the previous one's value. */
interface ScannedLetter { ci: number; tokenStart: number; letter: string; escapedAxis: boolean }

/**
 * The actual `FindParameters` rule: collect every parameter letter's position from `parameterStart`
 * onward, stopping at an unescaped `G`/`M` (the next command) or end of content. The hottest loop in
 * this module (once per character of every command's parameter section, and — via
 * `resolveFanucContinuation` — of a Fanuc-style continuation line's whole content too), so it has two
 * implementations of the exact same rule, kept in sync by test/lex.test.ts and test/corpus.test.ts
 * (both run on ordinary lines, which take the fast path, and on quoted/expression/escaped-axis
 * fixtures, which force the careful one): a plain line (the common case — no quotes, expressions or
 * escaped axes at all) never needs the quote/brace/escape bookkeeping, so `simple` skips straight to
 * the letter/E-exception/G-M check that's the only part that actually matters for it — measured a
 * large win over always paying for state this kind of line never uses (see docs/tasks/05-lexer.md's
 * Findings).
 */
function scanParamLetters(contentText: string, parameterStart: number, simple: boolean): { letters: Array<ScannedLetter>; commandEndCi: number } {
	const contentLength = contentText.length;
	const letters: Array<ScannedLetter> = [];
	let commandEndCi = contentLength;
	let j = parameterStart;
	if (simple) {
		while (j < contentLength) {
			const code = contentText.charCodeAt(j);
			const upper = code >= 97 && code <= 122 ? code - 32 : code;
			if (upper >= 65 && upper <= 90) {
				if (upper === 71 /* G */ || upper === 77 /* M */) {
					commandEndCi = j;
					break;
				}
				if (upper !== 69 /* E */ || j === parameterStart || !isDigit(contentText.charCodeAt(j - 1))) {
					letters.push({ ci: j, tokenStart: j, letter: String.fromCharCode(upper), escapedAxis: false });
				}
			}
			j++;
		}
	} else {
		let inQuotes = false;
		let escaped = false;
		let localBraces = 0;
		while (j < contentLength) {
			const code = contentText.charCodeAt(j);
			if (code === 39 /* ' */) { escaped = !inQuotes; j++; continue; }
			if (code === 34 /* " */) { inQuotes = !inQuotes; escaped = false; j++; continue; }
			if (inQuotes) { escaped = false; j++; continue; }
			if (code === 123 /* { */) { localBraces++; escaped = false; j++; continue; }
			if (localBraces > 0) {
				if (code === 125 /* } */) localBraces--;
				escaped = false;
				j++;
				continue;
			}
			// ASCII-only ('a'-'z' is 97-122); anything else (digits, punctuation) falls through
			// the two upper-range checks below exactly as a non-letter should.
			const upper = code >= 97 && code <= 122 ? code - 32 : code;
			const isLetterRange = upper >= 65 && upper <= 90; // 'A'..'Z'
			// `j > parameterStart` is implied once past the `j === parameterStart` short-circuit
			// (parameterStart >= 0), so the digit check never needs its own bounds guard.
			const eOk = upper !== 69 /* E */ || j === parameterStart || !isDigit(contentText.charCodeAt(j - 1));
			if (escaped) {
				if (isLetterRange && upper <= HIGHEST_AXIS_LETTER_CODE && eOk) {
					letters.push({ ci: j, tokenStart: j - 1, letter: String.fromCharCode(upper + 32), escapedAxis: true });
				}
				escaped = false;
				j++;
				continue;
			}
			if (upper === 71 /* G */ || upper === 77 /* M */) {
				commandEndCi = j;
				break;
			}
			if (isLetterRange && eOk) {
				letters.push({ ci: j, tokenStart: j, letter: String.fromCharCode(upper), escapedAxis: false });
			}
			j++;
		}
	}
	return { letters, commandEndCi };
}

/** Turn the letters `scanParamLetters` found into `LexedParam`s — a value runs from just after its
 *  letter to the next letter's position (or `commandEndCi`), trailing whitespace excluded. */
function buildParams(contentText: string, letters: ReadonlyArray<ScannedLetter>, commandEndCi: number, toRaw: (ci: number) => number): Array<LexedParam> {
	const params: Array<LexedParam> = [];
	for (let p = 0; p < letters.length; p++) {
		const L = letters[p];
		const valueStartCi = L.ci + 1;
		let valueEndCi = p + 1 < letters.length ? letters[p + 1].tokenStart : commandEndCi;
		while (valueEndCi > valueStartCi && isSpaceCh(contentText[valueEndCi - 1])) valueEndCi--;
		const value = contentText.slice(valueStartCi, valueEndCi);
		const valueStartAt = toRaw(valueStartCi);
		const valueEndAt = valueEndCi > valueStartCi ? toRaw(valueEndCi) : valueStartAt;
		params.push({
			letter: L.letter, escapedAxis: L.escapedAxis, value, kind: classifyValue(value),
			start: toRaw(L.tokenStart), valueStart: valueStartAt, end: valueEndAt,
		});
	}
	return params;
}

/**
 * Second pass: read one or more G/M/T commands out of `contentText`. Mirrors `DecodeCommand` +
 * `FindParameters` + `SetFinished` exactly, including the "T{expr}" and escaped-axis special cases,
 * looping for as many commands as the line actually has. Operates on the flat `contentText` string
 * (fast: string indexing, no per-character allocation); `segments` is only consulted — via
 * `mapToRaw` — the handful of times a span actually needs to be reported.
 */
function extractCommands(contentText: string, segments: ReadonlyArray<ContentSegment>): Array<LexedCommand> {
	const commands: Array<LexedCommand> = [];
	const contentLength = contentText.length;
	// The overwhelmingly common case (no CNC bracketed comment spliced this line) has exactly one
	// segment, making the content-index -> raw-index mapping pure addition - skip `mapToRaw`'s loop
	// entirely then, rather than paying a function call per span for what is otherwise a no-op.
	const singleOffset = segments.length === 1 ? segments[0].rawStart : -1;
	const toRaw = (ci: number): number => (singleOffset >= 0 ? singleOffset + ci : mapToRaw(segments, ci));
	// Whether the parameter-scanning loop below can skip its quote/brace/escape bookkeeping - see
	// that loop's own comment. A single native scan over the whole line, once, rather than per
	// command (a line with N commands only pays this once either way).
	const simple = !SPECIAL_CHAR_RE.test(contentText);
	let i = 0;

	while (i < contentLength) {
		const first = contentText[i];
		if (first === "'") break; // leading apostrophe - Fanuc continuation, not a G/M/T command here
		const upper = first.toUpperCase();
		if (upper !== "G" && upper !== "M" && upper !== "T") break; // only possible for command #1
		const letterCi = i;
		i++;

		// -- command number (same grammar as the pre-existing, already-RRF-verified scan) --
		let numberText: string | null = null;
		let parameterStart: number;
		if (upper === "T" && i < contentLength && contentText[i] === "{") {
			// RRF's own special case: "T{expr}" is read as if it were "T T{expr}" - re-scan the "T"
			// itself as a parameter letter below by rewinding parameterStart onto it.
			parameterStart = i - 1;
		} else {
			const negative = i < contentLength && contentText[i] === "-";
			let k = negative ? i + 1 : i;
			const digitsStart = k;
			while (k < contentLength && isDigitCh(contentText[k])) k++;
			const hasDigits = k > digitsStart;
			if (hasDigits) {
				let text = (negative ? "-" : "") + contentText.slice(digitsStart, k);
				i = k;
				// RRF reads at most one fractional digit (`commandFraction` is a single digit).
				if (i < contentLength && contentText[i] === ".") {
					i++;
					text += ".";
					if (i < contentLength && isDigitCh(contentText[i])) {
						text += contentText[i];
						i++;
					}
				}
				numberText = text;
			}
			// Skip whitespace after the command letter/number (DecodeCommand does this before
			// FindParameters; the T{expr} branch above deliberately skips it).
			while (i < contentLength && isSpaceCh(contentText[i])) i++;
			parameterStart = i;
		}

		const code = upper + (numberText ?? "");
		const isStringArg = STRING_ARGUMENT_COMMANDS.has(code);
		const letterAt = toRaw(letterCi);

		if (isStringArg) {
			// GetUnprecedentedString/GetPossiblyQuotedString reset the command's end to the TRUE end
			// of content, overriding whatever FindParameters would otherwise have found - reading
			// straight through any embedded G/M/;-shaped text.
			const vStart = parameterStart;
			let vEnd: number;
			if (contentText[parameterStart] === "\"") {
				let v = parameterStart + 1;
				while (v < contentLength) {
					if (contentText[v] === "\"") {
						if (contentText[v + 1] === "\"") { v += 2; continue; }
						v++;
						break;
					}
					v++;
				}
				vEnd = v;
			} else if (contentText[parameterStart] === "{") {
				let depth = 0;
				let v = parameterStart;
				while (v < contentLength) {
					if (contentText[v] === "{") depth++;
					else if (contentText[v] === "}") { depth--; if (depth === 0) { v++; break; } }
					v++;
				}
				vEnd = v;
			} else {
				vEnd = contentLength;
				while (vEnd > vStart && isSpaceCh(contentText[vEnd - 1])) vEnd--; // StripTrailingSpaces
			}
			const value = contentText.slice(vStart, vEnd);
			const rawStart = toRaw(vStart);
			const rawEnd = value.length > 0 ? toRaw(vEnd) : rawStart;
			commands.push({
				letter: upper as "G" | "M" | "T", number: numberText !== null ? Number(numberText) : null, code,
				start: letterAt, end: toRaw(contentLength),
				params: [],
				stringArgument: { value, start: rawStart, end: rawEnd },
			});
			i = contentLength;
			continue;
		}

		// -- FindParameters-equivalent scan --see `scanParamLetters` for the two implementations of
		// the actual rule (kept there so `resolveFanucContinuation`, below, can reuse them).
		const { letters, commandEndCi } = scanParamLetters(contentText, parameterStart, simple);
		const params = buildParams(contentText, letters, commandEndCi, toRaw);

		commands.push({
			letter: upper as "G" | "M" | "T",
			number: numberText !== null ? Number(numberText) : null,
			code,
			start: letterAt,
			end: toRaw(commandEndCi),
			params,
			stringArgument: null,
		});
		i = commandEndCi;
	}

	return commands;
}

/**
 * Lex one line of G-code, faithful to RRF's own splitting rules. Never throws — see `LexedLine`'s
 * `errors` for anything malformed. This is the primary entry point; `tokenise`/`parseParams` (this
 * file's and `params.ts`'s) are deprecated, first-command-only views over it.
 */
export function lexLine(raw: string, options?: LexOptions): LexedLine {
	const machineMode: MachineMode = options?.machineMode ?? "fff";

	let indent = 0;
	let i = 0;
	for (; i < raw.length; i++) {
		const c = raw.charCodeAt(i);
		if (c === 32) indent += 1;
		else if (c === 9) indent = (indent + 4) & ~3;
		else break;
	}
	const contentStart0 = i;

	let lineNumber: { value: number; start: number; end: number } | null = null;
	let pos = contentStart0;
	if (pos < raw.length && (raw[pos] === "N" || raw[pos] === "n")) {
		let j = pos + 1;
		while (j < raw.length && isDigit(raw.charCodeAt(j))) j++;
		if (j > pos + 1) {
			lineNumber = { value: Number(raw.slice(pos + 1, j)), start: pos, end: j };
			pos = j;
			while (pos < raw.length && isSpaceCh(raw[pos])) pos++;
		}
	}

	const { segments, contentText, bracketedComments, comment, checksum, errors } = scanContent(raw, pos, machineMode, lineNumber !== null);

	if (contentText.length === 0) {
		const kind = comment !== null || bracketedComments.length > 0 ? "comment" : "blank";
		return { raw, indent, lineNumber, checksum, commands: [], comment, bracketedComments, meta: null, kind, errors };
	}

	const meta = metaKeywordOf(contentText);
	if (meta !== null) {
		return { raw, indent, lineNumber, checksum, commands: [], comment, bracketedComments, meta, kind: "meta", errors };
	}

	const commands = extractCommands(contentText, segments);
	if (commands.length > 0) {
		return { raw, indent, lineNumber, checksum, commands, comment, bracketedComments, meta: null, kind: "commands", errors };
	}

	const first = contentText[0];
	const looksLikeFields = /[A-Za-z]/.test(first) || (first === "'" && contentText.length > 1 && /[A-Za-z]/.test(contentText[1]));
	return {
		raw, indent, lineNumber, checksum, commands: [], comment, bracketedComments, meta: null,
		kind: looksLikeFields ? "fields" : "unrecognised", errors,
	};
}

/** RRF's `GCodes::AllowedAxisLetters` (`GCodes.h`): every letter an axis COULD be configured on —
 *  `"XYZUVWABCD"` plus, on Duet 3/STM32H7 boards, all of `a`-`z`, or on other boards just `a`-`f`.
 *  This package always uses the more permissive full range (matching `HIGHEST_AXIS_LETTER` above),
 *  since a specific machine's actually-configured letters aren't available without the object model. */
const ALLOWED_AXIS_LETTERS = "XYZUVWABCDabcdefghijklmnopqrstuvwxyz";

/**
 * For a `"fields"`-kind line (see `LexedLine.kind`'s doc comment) in laser or CNC mode: the
 * parameters RRF would read for it as a Fanuc/LaserWeb-style repeat of the given previous `G0`-`G3`
 * command — line-to-line state this function doesn't track itself (the document model, task 06,
 * does). Verified against `StringParser::DecodeCommand` (3.7.0-rc.1, ~line 1064): RRF re-runs
 * `FindParameters` from position 0 of the line's OWN content (not a synthetic "repeated command"
 * string) — `parameterStart = commandStart; FindParameters();` — so the line's leading field (the
 * `X` in `X10 Y20`) becomes a parameter exactly like any other.
 *
 * DecodeCommand's real condition also requires: the previous command was `G0`-`G3` specifically
 * (checked by the caller, via `previous`); the line's first character is a letter RRF could have an
 * axis on (`ALLOWED_AXIS_LETTERS`); and the second character isn't alphabetic (so `if`/`var`/... , or
 * indeed any other meta keyword or command, is never mistaken for a continuation) — all reproduced
 * here. Returns null when the line doesn't actually qualify (not in laser/cnc mode, or fails one of
 * those checks) — a caller should still show the line as `"fields"`, just without an
 * `implicitCommand`.
 */
export function resolveFanucContinuation(
	raw: string,
	previous: { letter: "G"; number: 0 | 1 | 2 | 3 },
	options?: LexOptions,
): LexedCommand | null {
	const machineMode: MachineMode = options?.machineMode ?? "fff";
	if (machineMode !== "laser" && machineMode !== "cnc") return null;

	const { contentStart } = leadingIndent(raw);
	let pos = contentStart;
	let hasLineNumber = false;
	if (pos < raw.length && (raw[pos] === "N" || raw[pos] === "n")) {
		let j = pos + 1;
		while (j < raw.length && isDigit(raw.charCodeAt(j))) j++;
		if (j > pos + 1) {
			hasLineNumber = true;
			pos = j;
			while (pos < raw.length && isSpaceCh(raw[pos])) pos++;
		}
	}

	const { segments, contentText } = scanContent(raw, pos, machineMode, hasLineNumber);
	if (contentText.length === 0) return null;

	const first = contentText[0];
	const escaped = first === "'";
	const cl = escaped ? contentText[1]?.toLowerCase() : first.toUpperCase();
	if (cl === undefined || !ALLOWED_AXIS_LETTERS.includes(cl)) return null;
	const secondCharIndex = escaped ? 2 : 1;
	if (secondCharIndex < contentText.length && /[A-Za-z]/.test(contentText[secondCharIndex])) return null;

	const singleOffset = segments.length === 1 ? segments[0].rawStart : -1;
	const toRaw = (ci: number): number => (singleOffset >= 0 ? singleOffset + ci : mapToRaw(segments, ci));
	const simple = !SPECIAL_CHAR_RE.test(contentText);
	const { letters, commandEndCi } = scanParamLetters(contentText, 0, simple);
	const params = buildParams(contentText, letters, commandEndCi, toRaw);

	return {
		letter: previous.letter, number: previous.number, code: previous.letter + previous.number,
		start: toRaw(0), end: toRaw(commandEndCi),
		params, stringArgument: null,
	};
}

// ── deprecated, first-command-only views ──────────────────────────────────────────────────────────

export interface Tokenised {
	/** The original line, without its newline. */
	raw: string;
	/** Uppercase command, e.g. "G1", "M104", "T0", "G38.2". Null when the line has no command. A
	 *  command letter with no digits at all is still a command — e.g. bare "T" ("report the current
	 *  tool") — so `code` can equal `letter` with `number` null; it is only ever null when `letter`
	 *  is too. */
	code: string | null;
	/** Command letter (G/M/T) or null. */
	letter: string | null;
	/** Numeric part of the command (may be fractional, or negative for e.g. "T-1"), or null when
	 *  the command has no number at all (a bare "G"/"M"/"T"). */
	number: number | null;
	/** Index of the comment-introducing ";" in `raw`, or -1. */
	commentIndex: number;
	/** Comment text without the leading ";", or null when there is no comment. */
	comment: string | null;
	/** The command + parameters section of `raw` (everything before the comment). */
	body: string;
	/** True for a blank line or a line that is only a comment. */
	isCommentOnly: boolean;
}

/**
 * Find the index of the comment separator, skipping any ";" inside a quoted string.
 * Returns -1 when the line has no comment. Braces do NOT protect a ";" — confirmed against RRF's
 * `Put()`: a `;` inside an open `{...}` still ends the line there, exactly as outside one.
 */
export function findCommentIndex(raw: string): number {
	let inQuotes = false;
	for (let i = 0; i < raw.length; i++) {
		const ch = raw.charCodeAt(i);
		if (ch === 34 /* " */) {
			// RRF escapes a literal quote by doubling it; skip the pair and stay in the same state
			if (inQuotes && raw.charCodeAt(i + 1) === 34) {
				i++;
				continue;
			}
			inQuotes = !inQuotes;
		} else if (ch === 59 /* ; */ && !inQuotes) {
			return i;
		}
	}
	return -1;
}

/**
 * Split a line into its command, parameter body and comment. Never throws.
 *
 * @deprecated Only ever sees the line's FIRST command — RRF allows several per line (`G90 G1 X10`
 * is two). Use `lexLine` instead; this remains for single-command callers and defaults to FFF
 * machine mode (so a CNC `(...)` comment is read as plain text, as it always was before `lexLine`).
 */
export function tokenise(raw: string): Tokenised {
	const line = lexLine(raw);
	const commentIndex = line.comment ? line.comment.start : -1;
	const comment = line.comment ? line.comment.text : null;
	const body = commentIndex === -1 ? raw : raw.slice(0, commentIndex);
	const first = line.commands[0] ?? null;
	return {
		raw,
		code: first ? first.code : null,
		letter: first ? first.letter : null,
		number: first ? first.number : null,
		commentIndex,
		comment,
		body,
		isCommentOnly: body.trim().length === 0,
	};
}

/** Rebuild a full line from a (possibly rewritten) body, preserving the original comment. */
export function withBody(token: Tokenised, body: string): string {
	return token.commentIndex === -1 ? body : body + ";" + (token.comment ?? "");
}

/**
 * `lexLine` over a stream of raw text chunks (task 16, `docs/tasks/16-hardening-and-readiness.md`'s
 * "the way consumers read files" - a 200 MB print file read as, say, 64 KB pieces from a `Blob`/
 * `File`, never materialised as one JS string). Splits on `"\n"` only (a `"\r"` immediately before it
 * is stripped from the yielded line's own `raw`, matching `document.ts`'s own EOL handling - RRF's
 * line buffer doesn't keep it either), carrying a partial line across a chunk boundary exactly once
 * (never re-scanning already-consumed text), so total work stays linear in input size regardless of
 * how the caller chose to slice it.
 *
 * Deliberately does NOT track `M451`/`M452`/`M453` machine-mode switches the way `parseDocument`
 * does - `LexOptions.machineMode`'s own doc comment already says line-to-line state is the document
 * model's job, and that model needs the whole file in memory for its block tree anyway, so it isn't
 * something a true streaming reader could offer regardless. `machineMode` here is a single fixed
 * value applied to every line, the same contract `lexLine` itself already has.
 */
export function* lexLines(chunks: Iterable<string>, options?: LexOptions): Generator<LexedLine, void, undefined> {
	let carry = "";
	for (const chunk of chunks) {
		carry += chunk;
		let lineStart = 0;
		for (;;) {
			const nl = carry.indexOf("\n", lineStart);
			if (nl === -1) break;
			const end = nl > lineStart && carry.charCodeAt(nl - 1) === 13 /* \r */ ? nl - 1 : nl;
			yield lexLine(carry.slice(lineStart, end), options);
			lineStart = nl + 1;
		}
		carry = lineStart === 0 ? carry : carry.slice(lineStart);
	}
	if (carry.length > 0) {
		const raw = carry.charCodeAt(carry.length - 1) === 13 ? carry.slice(0, -1) : carry;
		yield lexLine(raw, options);
	}
}
