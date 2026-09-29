/**
 * Parses `M291`'s parameters into a structured, uninterpreted prompt — the RRF-command-specific half
 * of simulating a blocking message box; `execute.ts`'s `walkExecution` is the half that actually
 * pauses/resumes a walk on one. Cited against RRF 3.7.0-rc.1 `GCodes::DoMessageBox`
 * (`src/GCodes/GCodes7.cpp:14`) and `MessageBoxLimits::GetIntegerLimits`/`GetFloatLimits`
 * (`src/Platform/MessageBox.cpp:193,233`).
 *
 * RRF's mode parameter (`S`, default 1) is a closed set: 0/1 are non-blocking (RRF displays and moves
 * on immediately — never worth pausing an offline walk for), 2/3/4/5/6/7 are the blocking modes this
 * module supports. Every mode except 4 (multiple choice) needs only literal parameter reads; 4's `K`
 * is a full RRF expression (`gb.GetExpression()` in real RRF — often a literal array, but it can just
 * as well reference a variable), so parsing it alone can't produce a final, ready-to-display prompt
 * the way the other modes can — `parseBlockingMessageBox` returns the UNEVALUATED expression for that
 * one case (`kind: "choice"`) and leaves evaluating it to the caller, which has a live `EvalContext`
 * (`execute.ts`'s `walkExecution` — the same reason `if`/`while` conditions are evaluated there and
 * not here). This module itself still never evaluates anything, matching `expr/parse.ts`'s own stance.
 */

import type { EvalValue } from "./expr/evaluate.js";
import { parseExpression, type ParsedExpression } from "./expr/parse.js";
import { paramNumber, unquoteString } from "./params.js";
import type { LexedCommand, LexedParam } from "./lex.js";

export type MessageBoxPrompt =
	| { mode: "ok"; message: string; title: string | null }
	| { mode: "okCancel"; message: string; title: string | null }
	| { mode: "integer"; message: string; title: string | null; min: number | null; max: number | null; defaultValue: number | null }
	| { mode: "float"; message: string; title: string | null; min: number | null; max: number | null; defaultValue: number | null }
	| { mode: "string"; message: string; title: string | null; minLength: number | null; maxLength: number | null; defaultValue: string | null }
	/** `choices` is 0-based — matches `F`'s own default-choice index and RRF's own 0-based array
	 *  indexing elsewhere, but is this package's OWN convention, not a verified RRF one: real RRF's
	 *  `m291Result` is simply "whatever expression M292's own `R` parameter evaluates to"
	 *  (`GCodeBuffer.h`'s own comment: "the value entered or choice selected") — the actual
	 *  index-vs-string convention lives in whichever UI sends that M292, not in RRF's firmware itself,
	 *  so there is no single canonical answer this module could cite instead. */
	| { mode: "choice"; message: string; title: string | null; choices: ReadonlyArray<string>; defaultIndex: number | null };

export type BlockingMessageBox =
	| { kind: "ready"; prompt: MessageBoxPrompt; cancelAborts: boolean }
	/** Mode 4 (choice): `choices` is the unevaluated `K` expression — parse errors already reported on
	 *  `choices.errors`, but evaluating it (and checking it actually produced an array of strings) is
	 *  the caller's job. `message`/`title`/`defaultIndex`/`cancelAborts` are already final, same as the
	 *  "ready" case, since only `K` itself is expression-valued for this mode. */
	| { kind: "choice"; message: string; title: string | null; choices: ParsedExpression; defaultIndex: number | null; cancelAborts: boolean };

/** The already-evaluated values of one command's `{...}` parameters, by letter - what
 *  `execute.ts` computes when it evaluates a line's parameters. Optional everywhere: without it an
 *  expression-valued parameter reads as absent, exactly as before. */
export type EvaluatedCommandParams = ReadonlyMap<string, EvalValue>;

function findLexedParam(cmd: LexedCommand, letter: string): LexedParam | null {
	const want = letter.toUpperCase();
	return cmd.params.find((p) => p.letter === want) ?? null;
}

/** An evaluated value as text, the way RRF's `ExpressionValue::AppendAsString` builds a string
 *  parameter from an expression (`StringParser::GetQuotedString` takes the `{` branch): a string as
 *  is, anything else in its ordinary written form. Number formatting is display-grade (12 significant
 *  digits), not RRF's exact `%.7g`-style rendering. */
function valueText(v: EvalValue): string {
	if (typeof v === "string") return v;
	if (v === null) return "null";
	if (typeof v === "number") return Number.isInteger(v) || !Number.isFinite(v) ? String(v) : String(parseFloat(v.toPrecision(12)));
	if (Array.isArray(v)) return `[${v.map(valueText).join(",")}]`;
	return String(v);
}

/** A string-valued parameter: a literal (quoted or bare), or - when `evaluated` has one - the text of
 *  an expression-valued (`P{...}`) one. Null when absent, or an expression nobody evaluated. */
function stringParam(cmd: LexedCommand, letter: string, evaluated?: EvaluatedCommandParams): string | null {
	const p = findLexedParam(cmd, letter);
	if (p === null) return null;
	if (p.kind !== "expression") return unquoteString(p.value);
	const v = evaluated?.get(p.letter);
	return v === undefined ? null : valueText(v);
}

/** A numeric parameter: a literal, or the number an evaluated `{...}` produced. A non-number result
 *  counts as absent, as it does for the machine-state tracker's own numeric reads. */
function numberParam(cmd: LexedCommand, letter: string, evaluated?: EvaluatedCommandParams): number | null {
	const literal = paramNumber(cmd.params, letter);
	if (literal !== null || evaluated === undefined) return literal;
	const v = evaluated.get(letter.toUpperCase());
	return typeof v === "number" ? v : null;
}

/** Parses an `M291` command into a {@link BlockingMessageBox}, or `null` when it isn't one this
 *  module simulates: not `M291` at all, a non-blocking mode (0/1, including when `S` is omitted — RRF's
 *  own default), an unrecognised `S` value, or a `P` that is an expression nobody has evaluated. Any
 *  parameter written as a `{...}` expression is read from `evaluated` (this command's own values, by
 *  letter - `execute.ts` supplies them); without it such a parameter reads as absent, so an M291 with
 *  `P{...}` is not recognised as a message box. RRF reads a string parameter this way too:
 *  `StringParser::GetQuotedString` (`StringParser.cpp`) takes a `{` branch that evaluates the
 *  expression and appends it as text, and `GCodes::DoMessageBox` (`GCodes7.cpp:14`) reads `P`/`R`
 *  through it. Never throws — a malformed `K` on a choice box still returns a `"choice"` result,
 *  with the problem recorded on `choices.errors` for the caller to surface however it surfaces any
 *  other expression error. */
export function parseBlockingMessageBox(cmd: LexedCommand, evaluated?: EvaluatedCommandParams): BlockingMessageBox | null {
	if (cmd.code !== "M291") return null;
	const message = stringParam(cmd, "P", evaluated);
	if (message === null) return null;
	const title = stringParam(cmd, "R", evaluated);

	const sParam = numberParam(cmd, "S", evaluated);
	const mode = sParam ?? 1; // GCodes7.cpp: "uint32_t sParam = 1;" before TryGetLimitedUIValue('S', ...)
	const jParam = numberParam(cmd, "J", evaluated);
	const cancelAborts = jParam !== 2;

	switch (mode) {
		case 2:
			return { kind: "ready", prompt: { mode: "ok", message, title }, cancelAborts };
		case 3:
			return { kind: "ready", prompt: { mode: "okCancel", message, title }, cancelAborts };
		case 4: {
			// gb.MustSee('K') in real RRF - a choice box with no K at all is a genuine RRF error
			// ("expected 'K' on line ..."), not "not a choice box" - reproduced here as a parse error
			// (via a fabricated ParsedExpression, since there's no K text to actually parse) rather
			// than returning null, which would silently treat the whole line as an ordinary,
			// un-paused-on step - the wrong failure mode for a malformed command.
			const kParam = findLexedParam(cmd, "K");
			const choices: ParsedExpression = kParam !== null
				? parseExpression(kParam.value)
				: {
					ast: { type: "error", start: 0, end: 0 },
					errors: [{ code: "missing-k", message: "M291 S4 requires a 'K' parameter", start: 0, end: 0 }],
					objectModelPaths: [], variables: [], functions: [],
				};
			const defaultIndex = numberParam(cmd, "F", evaluated);
			return { kind: "choice", message, title, choices, defaultIndex, cancelAborts };
		}
		case 5:
			return {
				kind: "ready",
				prompt: {
					mode: "integer", message, title,
					min: numberParam(cmd, "L", evaluated), max: numberParam(cmd, "H", evaluated),
					defaultValue: numberParam(cmd, "F", evaluated),
				},
				cancelAborts,
			};
		case 6:
			return {
				kind: "ready",
				prompt: {
					mode: "float", message, title,
					min: numberParam(cmd, "L", evaluated), max: numberParam(cmd, "H", evaluated),
					defaultValue: numberParam(cmd, "F", evaluated),
				},
				cancelAborts,
			};
		case 7:
			return {
				kind: "ready",
				prompt: {
					mode: "string", message, title,
					minLength: numberParam(cmd, "L", evaluated), maxLength: numberParam(cmd, "H", evaluated),
					defaultValue: stringParam(cmd, "F", evaluated),
				},
				cancelAborts,
			};
		default:
			return null; // 0/1 non-blocking, anything else unrecognised
	}
}
