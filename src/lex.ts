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
	/** Uppercase command, e.g. "G1", "M104", "T0", "G38.2". Null when the line has no command. */
	code: string | null;
	/** Command letter (G/M/T) or null. */
	letter: string | null;
	/** Numeric part of the command (may be fractional), or null. */
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

	let j = i + 1;
	while (j < body.length && (isDigit(body.charCodeAt(j)) || body[j] === ".")) j++;
	if (j === i + 1) {
		// A bare letter with no number is not a command (e.g. a stray "T" or an expression)
		return {
			raw, code: null, letter: null, number: null,
			commentIndex, comment, body,
			isCommentOnly: body.trim().length === 0,
		};
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
