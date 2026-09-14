/**
 * RepRapFirmware's conditional G-code — `if`/`var`/`while`/… — a second grammar layered on top of
 * G/M/T commands, handled by a completely different firmware code path
 * (`StringParser::ProcessConditionalGCode`, checked directly against RRF 3.7.0-rc.1 source rather
 * than the wiki, which doesn't document the recognition rule at this level of precision — and is
 * itself incomplete here: its own "Conditional execution" section lists only nine keywords, missing
 * `break`, `continue` and `skip`, all three confirmed present in source). This matters most for
 * exactly the files a consumer of this package is most likely to open outside a slicer's own output:
 * `config.g`, homing macros, tool-change macros — `/sys` and `/macros` content is disproportionately
 * meta-commands, not motion commands.
 */

import { leadingIndent } from "./chars.js";
import { findCommentIndex, tokenise, type Tokenised } from "./lex.js";
import { metaKeywordOf, type MetaKeyword } from "./metaKeywords.js";

export type { MetaKeyword };

export type LineKind = "command" | "meta" | "comment" | "blank" | "unrecognised";

export interface ClassifiedLine {
	kind: LineKind;
	/** Set only when `kind === "meta"`. */
	meta?: MetaKeyword;
	/** Set only when `kind === "command"` — the same result `tokenise()` would give this line's
	 *  body, provided so a caller doesn't have to re-tokenise after classifying. */
	command?: Tokenised;
	/**
	 * Block-nesting depth, computed the way RRF actually computes it (`StringParser`'s
	 * `parseNotStarted` state): each leading space adds 1; each leading tab rounds up to the next
	 * multiple of 4 (`(indent + 4) & ~3`). Counted ONLY over the run of leading whitespace before the
	 * first other character — an `N123` line number, once reached, ends the count; whitespace after
	 * the line number does not add to it. Meaningful for every line, not just meta ones: RRF uses a
	 * REGULAR command's indentation to detect the end of the enclosing block. **Except a comment
	 * line's own indent**: from RRF 3.6.0 (`Duet3D/wiki-content`'s `Gcode_meta_commands.md`,
	 * "Indentation of comments" — inside this package's whole supported range, whose floor is 3.6.3)
	 * a comment's indentation is no longer significant to block nesting at all. This field still
	 * reports it faithfully for a `"comment"` line — a caller tracking nesting depth must skip
	 * comment lines when deciding whether a block has ended, not feed every line's `indent` into
	 * that decision uniformly.
	 */
	indent: number;
}

/**
 * Skip an optional `N123` line number (case-insensitive) and the whitespace after it, the same
 * convention `lex.ts`'s `tokenise()` and `params.ts`'s `parseParams()` already use — RRF's own
 * command-content buffer excludes both the leading indentation and any line number.
 */
function skipLineNumber(body: string, start: number): number {
	let i = start;
	if (i < body.length && (body[i] === "N" || body[i] === "n")) {
		let j = i + 1;
		while (j < body.length && body.charCodeAt(j) >= 48 && body.charCodeAt(j) <= 57) j++;
		if (j > i + 1) {
			i = j;
			while (i < body.length && (body[i] === " " || body[i] === "\t")) i++;
		}
	}
	return i;
}

/**
 * Classify one raw line as a G/M/T command, a meta-command, a comment, blank, or unrecognised.
 * Never throws.
 */
export function classifyLine(raw: string): ClassifiedLine {
	const { indent, contentStart } = leadingIndent(raw);
	const afterIndent = skipLineNumber(raw, contentStart);

	const commentIndex = findCommentIndex(raw);
	const contentEnd = commentIndex === -1 ? raw.length : commentIndex;
	const content = raw.slice(afterIndent, contentEnd);

	if (content.trim().length === 0) {
		return { kind: commentIndex === -1 ? "blank" : "comment", indent };
	}

	const meta = metaKeywordOf(content);
	if (meta !== null) {
		return { kind: "meta", meta, indent };
	}

	// tokenise() already skips leading whitespace and an N-number itself, so the full raw line goes
	// in unsliced - this also keeps `command.raw` the actual original line, not a re-derived slice.
	const command = tokenise(raw);
	if (command.code !== null) {
		return { kind: "command", command, indent };
	}

	return { kind: "unrecognised", indent };
}

export type AssignmentForm = "declare" | "set";
export type VariableScope = "local" | "global";

export interface Assignment {
	/** `"declare"` for `var`/`global` (creates a new variable); `"set"` for `set var.`/`set global.`
	 *  (assigns an existing one) — `Duet3D/wiki-content`'s own terms, `Gcode_meta_commands.md`'s
	 *  "Local/Global variable declaration" vs. "Variable assignment" sections. */
	form: AssignmentForm;
	scope: VariableScope;
	/** The variable's own name, without any `var.`/`global.` prefix. */
	name: string;
	/** Index span of `name` within the raw line passed to `parseAssignment` — `raw.slice(nameStart,
	 *  nameEnd) === name`, always. */
	nameStart: number;
	nameEnd: number;
	/** The expression text exactly as written (not evaluated — this package doesn't evaluate RRF
	 *  expressions; see the package README), trimmed, with any trailing comment already removed. */
	expression: string;
	/** Index span of `expression` within the raw line — `raw.slice(expressionStart, expressionEnd)
	 *  === expression`, always. Lets a caller replace just the value in place (the same purpose
	 *  `params.ts`'s `ParsedParam` spans serve for a G-code parameter), e.g. for redaction. */
	expressionStart: number;
	expressionEnd: number;
}

const NAME_RE = /^[A-Za-z][A-Za-z0-9_]*/;

function isSpaceChar(c: string | undefined): boolean {
	return c === " " || c === "\t";
}

/**
 * Parse a `var NAME = expr` / `global NAME = expr` declaration, or a `set var.NAME = expr` /
 * `set global.NAME = expr` assignment to an existing one — RRF's four variable-mutating forms
 * (`Duet3D/wiki-content`'s `Gcode_meta_commands.md`, "Variables" section; each form's own example is
 * this function's own test fixture). Returns null for anything else, including a `set` that isn't
 * `var.`/`global.`-prefixed (RRF's `ProcessSetCommand` throws "expected a global or local variable"
 * for that — not a form this package represents as a successful parse) and array-index assignment
 * (`set var.x[0] = …`) — the index isn't needed for identifying which variable is targeted, and this
 * package doesn't parse RRF's expression grammar. Never throws.
 */
export function parseAssignment(raw: string): Assignment | null {
	const { contentStart } = leadingIndent(raw);
	const afterIndent = skipLineNumber(raw, contentStart);
	const commentIndex = findCommentIndex(raw);
	const contentEnd = commentIndex === -1 ? raw.length : commentIndex;
	const content = raw.slice(afterIndent, contentEnd);

	const keyword = metaKeywordOf(content);
	let scope: VariableScope;
	let form: AssignmentForm;
	let pos: number; // position within `content`, tracked throughout rather than re-sliced, so every
	// span reported at the end is exact rather than reconstructed after the fact.

	if (keyword === "var" || keyword === "global") {
		form = "declare";
		scope = keyword === "global" ? "global" : "local";
		pos = keyword.length;
	} else if (keyword === "set") {
		form = "set";
		pos = "set".length;
		while (isSpaceChar(content[pos])) pos++;
		if (content.startsWith("global.", pos)) {
			scope = "global";
			pos += "global.".length;
		} else if (content.startsWith("var.", pos)) {
			scope = "local";
			pos += "var.".length;
		} else {
			return null; // RRF itself rejects this ("expected a global or local variable")
		}
	} else {
		return null;
	}

	while (isSpaceChar(content[pos])) pos++;
	const nameMatch = NAME_RE.exec(content.slice(pos));
	if (nameMatch === null) return null;
	const name = nameMatch[0];
	const nameStartRel = pos;
	pos += name.length;

	while (isSpaceChar(content[pos])) pos++;
	// RRF skips whitespace before checking for "[" too (`set var.x [0] = …` is valid to it), so the
	// check for "out of scope, indexed" has to happen on the token right after the name - not by
	// searching the whole remainder, which would also (wrongly) reject a plain assignment whose
	// VALUE happens to contain array syntax, e.g. `heat.heaters[1].active`.
	if (content[pos] === "[") return null; // array-index assignment - out of scope, see doc comment
	if (content[pos] !== "=") return null;
	pos += 1;

	let exprStartRel = pos;
	let exprEndRel = content.length;
	while (exprStartRel < exprEndRel && isSpaceChar(content[exprStartRel])) exprStartRel++;
	while (exprEndRel > exprStartRel && isSpaceChar(content[exprEndRel - 1])) exprEndRel--;
	if (exprEndRel === exprStartRel) return null; // empty expression

	return {
		form, scope, name,
		nameStart: afterIndent + nameStartRel,
		nameEnd: afterIndent + nameStartRel + name.length,
		expression: content.slice(exprStartRel, exprEndRel),
		expressionStart: afterIndent + exprStartRel,
		expressionEnd: afterIndent + exprEndRel,
	};
}
