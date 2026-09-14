/**
 * G-code line tokeniser.
 *
 * Deliberately allocation-light: a full pass over a 200 MB file tokenises every line, so this
 * returns index spans into the original string rather than a bag of substrings, and parameter
 * parsing (`params.ts`) is a separate opt-in call that most lines never pay for.
 *
 * Quote handling matters more than it looks: RepRapFirmware string parameters routinely contain
 * semicolons (`M291 P"done; resuming"`), so a naive indexOf(";") splits a comment out of the middle
 * of a perfectly good command and corrupts the file. Quotes are escaped by doubling in RRF (`""`).
 */

import { isDigit, isSpace } from "./chars.js";

export interface Tokenised {
	/** The original line, without its newline. */
	raw: string;
	/**
	 * Uppercase command, e.g. "G1", "M104", "T0", "G38.2". Null when the line has no command. A
	 * command letter with no digits at all is still a command — e.g. bare "T" ("report the current
	 * tool") — so `code` can equal `letter` with `number` null; it is only ever null when `letter`
	 * is too.
	 */
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
 * Returns -1 when the line has no comment.
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

/** Split a line into its command, parameter body and comment. Never throws. */
export function tokenise(raw: string): Tokenised {
	const commentIndex = findCommentIndex(raw);
	const body = commentIndex === -1 ? raw : raw.slice(0, commentIndex);
	const comment = commentIndex === -1 ? null : raw.slice(commentIndex + 1);

	// Skip leading whitespace, then an optional line number (N123) that some senders prepend
	let i = 0;
	while (i < body.length && isSpace(body.charCodeAt(i))) i++;
	if (i < body.length && (body[i] === "N" || body[i] === "n")) {
		let j = i + 1;
		while (j < body.length && isDigit(body.charCodeAt(j))) j++;
		if (j > i + 1) {
			i = j;
			while (i < body.length && isSpace(body.charCodeAt(i))) i++;
		}
	}

	const letterChar = i < body.length ? body[i].toUpperCase() : "";
	if (letterChar !== "G" && letterChar !== "M" && letterChar !== "T") {
		return {
			raw, code: null, letter: null, number: null,
			commentIndex, comment, body,
			isCommentOnly: body.trim().length === 0,
		};
	}

	// Mirrors RRF's own command-number scan exactly (`StringParser::ParseInternal`, checked
	// against 3.7.0-rc.1 source): a leading "-" is read before the digits for ANY of G/M/T, not
	// just T — `M-1`/`G-1` are syntactically commands too, even though no current RRF command
	// number happens to be negative. And a command letter with no digits at all is STILL a
	// command with no number (RRF sets `hasCommandNumber = false`, not "reject the line") — a bare
	// "T" is real and documented ("report the current tool"; `Duet3D/wiki-content`'s `## T: Select
	// Tool`), and this used to be misread as "not a command" here.
	let j = i + 1;
	const negative = body[j] === "-";
	if (negative) j++;
	const digitsStart = j;
	while (j < body.length && isDigit(body.charCodeAt(j))) j++;
	const hasDigits = j > digitsStart;

	if (!hasDigits) {
		return {
			raw, code: letterChar, letter: letterChar, number: null,
			commentIndex, comment, body,
			isCommentOnly: false,
		};
	}

	// RRF reads at most ONE fractional digit here (`commandFraction` is a single digit 0-9, not a
	// decimal scan) — `G38.2` is whole 38 + fraction 2, but a hypothetical "G38.25" would read
	// fraction "2" and leave the second "5" for parameter scanning, not fold it into the command
	// number. No command in the current RRF dictionary has a two-digit fraction, but a corrupted
	// or hand-edited line might, and this keeps that case matching the firmware instead of
	// silently accepting a command that was never real.
	if (body[j] === ".") {
		j++; // RRF consumes the "." whether or not a digit follows it
		if (j < body.length && isDigit(body.charCodeAt(j))) j++;
	}

	const numberText = body.slice(i + 1, j);
	const number = Number(numberText);
	return {
		raw,
		code: letterChar + numberText,
		letter: letterChar,
		number: Number.isFinite(number) ? number : null,
		commentIndex,
		comment,
		body,
		isCommentOnly: false,
	};
}

/** Rebuild a full line from a (possibly rewritten) body, preserving the original comment. */
export function withBody(token: Tokenised, body: string): string {
	return token.commentIndex === -1 ? body : body + ";" + (token.comment ?? "");
}
