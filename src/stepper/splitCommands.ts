/**
 * Split a raw source line into one substring per G/M/T command it holds.
 *
 * RRF allows several commands on one line (`lex.ts`: "`G90 G1 X10` is two"), but a caller built on
 * `tokenise()` only ever sees a line's FIRST command (that function's own `@deprecated` note) unless
 * it splits first. Splitting here, once, lets every such caller keep calling the simple,
 * first-command `tokenise()` on each substring in turn — each one only ever holds a single command,
 * exactly what `tokenise()` was already correct for.
 *
 * Extracted from `duet-gcode-postprocessor`'s own `model/gcode/splitCommands.ts` (task: shared
 * stepper) — moved verbatim except for the import path, so every existing behaviour/test carries
 * over unchanged.
 */

import { lexLine } from "../lex.js";

/**
 * Returns `[raw]` unchanged for the overwhelmingly common case (zero or one command on the line) —
 * every existing single-command code path stays byte-for-byte untouched. For a line with N (>1)
 * commands, returns N substrings in source order; the first includes whatever precedes the first
 * command (indentation, a line number, a checksum), and the last includes any trailing comment.
 * Concatenating the result always reconstructs `raw` exactly.
 */
export function splitCommands(raw: string): ReadonlyArray<string> {
	const lexed = lexLine(raw);
	const commands = lexed.commands;
	if (commands.length <= 1) return [raw];

	const out: Array<string> = [];
	for (let i = 0; i < commands.length; i++) {
		const isLast = i === commands.length - 1;
		const end = isLast ? raw.length : commands[i + 1].start;
		out.push(i === 0 ? raw.slice(0, end) : raw.slice(commands[i].start, end));
	}
	return out;
}
