/**
 * Parameter parsing, reading and in-place rewriting on a command body (`Tokenised.body` from
 * `lex.ts`). Every rewrite works on index spans, so the rest of the line — spacing, other
 * parameters, capitalisation — stays byte-identical.
 */

import { isSpace } from "./chars.js";
import { lexLine } from "./lex.js";

export interface ParsedParam {
	/** Uppercase parameter letter. */
	letter: string;
	/** Raw value text exactly as it appeared (quotes and braces included). */
	value: string;
	/** Start index of the letter within the line the params were parsed from. */
	start: number;
	/** End index (exclusive) of the value. */
	end: number;
}

const EMPTY_PARAMS: ReadonlyArray<ParsedParam> = Object.freeze([]);

/**
 * Parse the parameters of a command body (the string returned as `Tokenised.body`).
 *
 * Handles plain values (`X1.5`, `S-40`, `E1e-3`), quoted strings (`P"a b"`, with `""` escapes) and
 * RRF expressions (`S{move.axes[0].max}`), returning index spans so a caller can rewrite one
 * parameter in place without reconstructing (and subtly reformatting) the whole line.
 *
 * @deprecated Only ever sees the line's FIRST command — RRF allows several per line, and this has
 * no way to represent that. A `STRING_ARGUMENT_COMMANDS` command (e.g. `M117`) now correctly yields
 * no parameters at all rather than misreading its message text as letter parameters — use `lexLine`
 * from `./lex.js` for that, and for the `escapedAxis` distinction (a `'`-escaped axis letter and its
 * plain uppercase form collide onto the same, uppercased `letter` here).
 */
export function parseParams(body: string, startIndex = 0): ReadonlyArray<ParsedParam> {
	const offset = startIndex;
	const sub = offset === 0 ? body : body.slice(offset);
	const first = lexLine(sub).commands[0];
	if (first === undefined) return EMPTY_PARAMS;
	return first.params.map((p) => ({
		letter: p.letter.toUpperCase(),
		value: p.value,
		start: p.start + offset,
		end: p.end + offset,
	}));
}

/**
 * Numeric value of a parameter, or null when absent, non-numeric (a string/expression) or written
 * with no value at all. That last case is not zero, although `Number("")` is: RRF 3.7.0-beta.3+
 * reads `M116 P` as "wait for every tool", and `M84 X Y E` names axes without giving a number.
 * Use `findParam` to ask whether the letter is there.
 */
export function paramNumber(params: ReadonlyArray<ParsedParam>, letter: string): number | null {
	const p = findParam(params, letter);
	if (p === null || p.value.length === 0) return null;
	const n = Number(p.value);
	return Number.isFinite(n) ? n : null;
}

/**
 * A parameter's value as RepRapFirmware's colon-separated list — `S185:200:150` is one value per
 * heater of a multi-heater tool (RRF reads these with `GetFloatArray`). A plain `S210` is a
 * one-element list. `paramNumber` cannot be used for these: `Number("185:200:150")` is NaN, so the
 * whole parameter would silently read as absent. An empty element (`S200::180`, or a bare `S`) is
 * dropped rather than read as zero — `Number("")` would make it one. A genuinely non-numeric
 * element (a bare letter, e.g. `S200:x:150`) can't reach this function at all: `lexLine`'s value
 * scan already stops at that letter (RRF's own `FindParameters` treats it as a new parameter, not
 * part of S's value — see `docs/tasks/05-lexer.md`), so `S`'s value here is only ever `"200"`.
 * Empty when the parameter is absent.
 */
export function paramNumberList(params: ReadonlyArray<ParsedParam>, letter: string): Array<number> {
	const p = findParam(params, letter);
	if (p === null) return [];
	return p.value.split(":").filter((s) => s.length > 0).map(Number).filter((n) => Number.isFinite(n));
}

/** First parameter with the given letter, or null. Letter comparison is case-insensitive. */
export function findParam(params: ReadonlyArray<ParsedParam>, letter: string): ParsedParam | null {
	const want = letter.toUpperCase();
	for (const p of params) {
		if (p.letter === want) return p;
	}
	return null;
}

/**
 * Replace (or append) one parameter's value in a command body, leaving the rest of the line —
 * spacing, other parameters, capitalisation — byte-identical.
 */
export function setParam(body: string, letter: string, value: string): string {
	const params = parseParams(body);
	const existing = findParam(params, letter);
	if (existing !== null) {
		return body.slice(0, existing.start + 1) + value + body.slice(existing.end);
	}
	const trimmedEnd = body.replace(/\s+$/, "");
	const trailing = body.slice(trimmedEnd.length);
	return `${trimmedEnd} ${letter.toUpperCase()}${value}${trailing}`;
}

/** Remove a parameter from a command body. Returns the body unchanged when it is not present. */
export function removeParam(body: string, letter: string): string {
	const params = parseParams(body);
	const existing = findParam(params, letter);
	if (existing === null) return body;
	// Swallow one leading space so removing a middle parameter does not leave a double space
	let start = existing.start;
	if (start > 0 && isSpace(body.charCodeAt(start - 1))) start--;
	return body.slice(0, start) + body.slice(existing.end);
}

/**
 * Format a number the way G-code readers expect: fixed decimals, but without the trailing zeros
 * that make a diff noisy (`0.80` -> `0.8`, `5.000` -> `5`).
 */
export function formatNumber(value: number, decimals: number): string {
	if (!Number.isFinite(value)) return "0";
	const fixed = value.toFixed(Math.max(0, Math.min(10, decimals)));
	return fixed.includes(".") ? fixed.replace(/\.?0+$/, "") : fixed;
}

/**
 * Strip the surrounding quotes from a string-parameter value (as returned by {@link parseParams},
 * quotes and all) and un-escape RRF's `""` doubling. Returns the value unchanged when it was not
 * quoted to begin with — an expression like `{var.name}` or a bare number, say.
 */
export function unquoteString(value: string): string {
	if (value.length >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
		return value.slice(1, -1).replace(/""/g, "\"");
	}
	return value;
}
