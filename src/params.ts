/**
 * Parameter parsing, reading and in-place rewriting on a command body (`Tokenised.body` from
 * `lex.ts`). Every rewrite works on index spans, so the rest of the line — spacing, other
 * parameters, capitalisation — stays byte-identical.
 */

import { isDigit, isLetter, isSpace } from "./chars.js";

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
 */
export function parseParams(body: string, startIndex = 0): ReadonlyArray<ParsedParam> {
	let i = startIndex;
	// Skip whitespace, an optional line number, and the command itself
	while (i < body.length && isSpace(body.charCodeAt(i))) i++;
	if (i < body.length && (body[i] === "N" || body[i] === "n")) {
		let j = i + 1;
		while (j < body.length && isDigit(body.charCodeAt(j))) j++;
		if (j > i + 1) i = j;
	}
	while (i < body.length && isSpace(body.charCodeAt(i))) i++;
	if (i < body.length && isLetter(body.charCodeAt(i))) {
		const c = body[i].toUpperCase();
		if (c === "G" || c === "M" || c === "T") {
			let j = i + 1;
			while (j < body.length && (isDigit(body.charCodeAt(j)) || body[j] === ".")) j++;
			if (j > i + 1) i = j;
		}
	}

	let params: Array<ParsedParam> | null = null;
	while (i < body.length) {
		while (i < body.length && isSpace(body.charCodeAt(i))) i++;
		if (i >= body.length) break;
		if (!isLetter(body.charCodeAt(i))) {
			// Not a parameter (a checksum "*42", a stray token) — stop rather than guess
			break;
		}
		const letter = body[i].toUpperCase();
		const start = i;
		i++;
		const valueStart = i;
		if (body[i] === "\"") {
			i++;
			while (i < body.length) {
				if (body[i] === "\"") {
					if (body[i + 1] === "\"") { i += 2; continue; }
					i++;
					break;
				}
				i++;
			}
		} else if (body[i] === "{") {
			let depth = 0;
			while (i < body.length) {
				if (body[i] === "{") depth++;
				else if (body[i] === "}") { depth--; if (depth === 0) { i++; break; } }
				i++;
			}
		} else {
			while (i < body.length && !isSpace(body.charCodeAt(i))) i++;
		}
		(params ??= []).push({ letter, value: body.slice(valueStart, i), start, end: i });
	}
	return params ?? EMPTY_PARAMS;
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
 * whole parameter would silently read as absent. Non-numeric elements are dropped rather than
 * failing the lot, and so are empty ones (`S200::180`, or a bare `S`) — `Number("")` would make
 * them zero. Empty when the parameter is absent.
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
