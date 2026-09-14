/**
 * 12864-display menu file syntax (`0:/menu/*`, `MENU_DIR` — `Config/Configuration.h:304`), read
 * end to end from RRF `3.7.0-rc.1` `src/Display/Menu.cpp`'s `Menu::ParseMenuLine` (not the wiki
 * alone, though `Display_12864_menu.md` is cited too for the parts source doesn't spell out, like
 * what an action string means). Tolerant: unlike RRF itself (which stops loading the WHOLE menu file
 * at the first error — `Menu::Reload`'s `LoadError(...); break;`), this parses every line
 * independently so an editor can show every problem at once, not just the first.
 *
 * Grammar (`ParseMenuLine`, line by line, leading whitespace already stripped by the caller —
 * `SkipWhitespace(buffer)` in `Menu::Reload`):
 * ```
 * line      := '' | ';' comment | command (' '|'\t' arg)*
 * command   := alpha+                     -- must be followed by space/tab/end, else "Bad command"
 * arg       := letter (number | string | expr)
 *   R C F D W H    -- a plain unsigned integer (StrToU32)
 *   V              -- a plain integer, OR (RRF 3.5+) a '{...}' expression (any command)
 *   N              -- a plain integer, OR (RRF 3.5+) a '{...}' expression - ONLY for "value" (checked
 *                     by comparing the command word, case-insensitively, right there in the switch)
 *   T L A I "..."  -- a double-quoted string ('""' is one literal '"' - same escape as G-code); a
 *                     bare '"' with no letter is short for T (`case '"': ch = 'T'; --args; fallthrough`)
 *   (anything else) -- "Bad arg letter", and RRF stops the line right there
 * ```
 * Recognised commands (case-insensitive `StringEqualsIgnoreCase`): `image`, `text`, `button`,
 * `value`, `alter`, `files` — anything else is "Unknown command". RRF does NOT enforce which
 * parameters a given command actually needs (its own TODO comments say so) - a missing parameter
 * silently gets a default (`text="*"`, `fname="main"`, `dirpath=""`, no action) rather than erroring,
 * so this parser doesn't invent a "missing required parameter" error either; see task 14 (a real
 * *diagnostic* layer) for whether that's worth surfacing as a lint later.
 *
 * Action strings (the `A` parameter's value — wiki `Display_12864_menu.md`, `Menu.cpp` doesn't
 * itself parse them, only stores the raw text for `ButtonMenuItem`/`FilesMenuItem` to interpret at
 * runtime): `|`-separated parts, each a G-code command (starting with `G`/`M`/`T`), `menu <name>`,
 * or `return`. Lexed with this package's own `lexLine` for the G-code case, so an action's own
 * command/parameters are just as available as anywhere else in this package.
 */

import { lexLine, type LexedLine } from "../lex.js";

export type MenuParamKind = "number" | "string" | "expression";

export interface MenuParam {
	/** Always uppercase — RRF reads the letter case-insensitively (`toupper` in the dispatch
	 *  switch) and a bare `"` with no letter is treated as `T`. */
	letter: string;
	kind: MenuParamKind;
	/** Raw value text: digits for `"number"`, the decoded string (quotes stripped, `""` resolved to
	 *  one `"`) for `"string"`, and the text between `{`/`}` (braces excluded) for `"expression"`. */
	value: string;
	start: number;
	end: number;
}

export type MenuAction =
	| { kind: "gcode"; text: string; command: LexedLine; start: number; end: number }
	| { kind: "menu"; name: string; start: number; end: number }
	| { kind: "return"; start: number; end: number }
	| { kind: "unrecognised"; text: string; start: number; end: number };

/** The exact six keywords `Menu::ParseMenuLine` dispatches on (`StringEqualsIgnoreCase`). */
export const MENU_COMMANDS: ReadonlySet<string> = new Set(["image", "text", "button", "value", "alter", "files"]);

export interface MenuLine {
	raw: string;
	kind: "blank" | "comment" | "command" | "unrecognised";
	/** Set only for `kind: "command"` or `"unrecognised"` — the command word exactly as written
	 *  (RRF compares it case-insensitively; this preserves the source's own casing). */
	command?: string;
	/** Parameters found before any error stopped the line — RRF itself stops parsing arguments the
	 *  instant one is malformed, so a line with an error may still have zero or more valid params
	 *  from before that point. */
	params: ReadonlyArray<MenuParam>;
	/** The `A` parameter's value, split into actions on `|` — empty when there was no `A` param. */
	actions: ReadonlyArray<MenuAction>;
}

export interface MenuError { message: string; line: number; column: number }

export interface MenuDocument { lines: ReadonlyArray<MenuLine>; errors: ReadonlyArray<MenuError> }

function isAlphaCh(c: string | undefined): boolean {
	return c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
}
function isDigitCh(c: string | undefined): boolean {
	return c !== undefined && c >= "0" && c <= "9";
}
function isSpaceCh(c: string | undefined): boolean {
	return c === " " || c === "\t";
}

function parseAction(text: string, offset: number): MenuAction {
	const start = offset;
	const end = offset + text.length;
	const trimmed = text.trim();
	if (/^menu\b/i.test(trimmed)) {
		return { kind: "menu", name: trimmed.replace(/^menu\s*/i, ""), start, end };
	}
	if (/^return$/i.test(trimmed)) {
		return { kind: "return", start, end };
	}
	if (/^[GMT]/i.test(trimmed)) {
		return { kind: "gcode", text: trimmed, command: lexLine(trimmed), start, end };
	}
	return { kind: "unrecognised", text: trimmed, start, end };
}

/** Splits an action-parameter's decoded value on `|`, tracking each part's position in the ORIGINAL
 *  (still `""`-escaped) text isn't attempted precisely here — actions are reported with spans
 *  relative to the DECODED string, which is what a caller almost always wants for the G-code lexing
 *  anyway; see `MenuParam.value` for the same convention (decoded, not raw-with-quotes). */
function splitActions(value: string, offset: number): Array<MenuAction> {
	const actions: Array<MenuAction> = [];
	let partStart = 0;
	const pushPart = (endIndex: number): void => {
		const part = value.slice(partStart, endIndex);
		actions.push(parseAction(part, offset + partStart));
		partStart = endIndex + 1;
	};
	for (let i = 0; i < value.length; i++) {
		if (value[i] === "|") pushPart(i);
	}
	pushPart(value.length);
	return actions;
}

function parseLine(raw: string, lineNumber: number, errors: Array<MenuError>): MenuLine {
	let i = 0;
	while (isSpaceCh(raw[i])) i++;

	if (raw[i] === undefined || raw[i] === ";") {
		return { raw, kind: raw[i] === ";" ? "comment" : "blank", params: [], actions: [] };
	}

	const commandStart = i;
	while (isAlphaCh(raw[i])) i++;
	if (i === commandStart || (raw[i] !== undefined && !isSpaceCh(raw[i]))) {
		errors.push({ message: "Bad command", line: lineNumber, column: i - commandStart + 1 });
		return { raw, kind: "unrecognised", command: raw.slice(commandStart, i), params: [], actions: [] };
	}
	const command = raw.slice(commandStart, i);
	while (isSpaceCh(raw[i])) i++;

	const params: Array<MenuParam> = [];
	let actionValue: { value: string; start: number } | null = null;

	while (i < raw.length && raw[i] !== ";") {
		if (isSpaceCh(raw[i])) { i++; continue; }
		const letterAt = i;
		let letter = raw[i].toUpperCase();
		i++;

		if (letter === "R" || letter === "C" || letter === "F" || letter === "D" || letter === "W" || letter === "H") {
			const digitsStart = i;
			while (isDigitCh(raw[i])) i++;
			params.push({ letter, kind: "number", value: raw.slice(digitsStart, i), start: letterAt, end: i });
			continue;
		}

		if (letter === "V" || (letter === "N" && raw[i] === "{" && command.toLowerCase() === "value")) {
			if (raw[i] === "{") {
				const exprStart = i + 1;
				i++;
				while (i < raw.length && raw[i] !== "}") i++;
				params.push({ letter, kind: "expression", value: raw.slice(exprStart, i), start: letterAt, end: Math.min(i + 1, raw.length) });
				if (raw[i] === "}") i++;
				continue;
			}
			const digitsStart = i;
			while (isDigitCh(raw[i])) i++;
			params.push({ letter, kind: "number", value: raw.slice(digitsStart, i), start: letterAt, end: i });
			continue;
		}

		if (letter === "N") {
			const digitsStart = i;
			while (isDigitCh(raw[i])) i++;
			params.push({ letter, kind: "number", value: raw.slice(digitsStart, i), start: letterAt, end: i });
			continue;
		}

		if (raw[letterAt] === "\"") {
			// A bare quote with no letter is short for T - RRF's own `case '"': ch = 'T'; --args;`.
			letter = "T";
			i = letterAt; // back up: the quote itself hasn't been consumed yet for this form
		}
		if (letter === "T" || letter === "L" || letter === "A" || letter === "I") {
			if (raw[i] !== "\"") {
				errors.push({ message: "Missing string arg", line: lineNumber, column: i + 1 });
				break;
			}
			i++; // opening quote
			const valueStart = i;
			let value = "";
			for (;;) {
				const c = raw[i];
				if (c === undefined) break; // RRF's own loop also just stops at the null terminator
				i++;
				if (c === "\"") {
					if (raw[i] === "\"") { value += "\""; i++; continue; }
					break;
				}
				value += c;
			}
			const end = i;
			params.push({ letter, kind: "string", value, start: letterAt, end });
			if (letter === "A") actionValue = { value, start: valueStart };
			continue;
		}

		errors.push({ message: "Bad arg letter", line: lineNumber, column: letterAt + 1 });
		break;
	}

	const known = MENU_COMMANDS.has(command.toLowerCase());
	if (!known) {
		errors.push({ message: "Unknown command", line: lineNumber, column: 1 });
	}

	return {
		raw,
		kind: known ? "command" : "unrecognised",
		command,
		params,
		actions: actionValue !== null ? splitActions(actionValue.value, actionValue.start) : [],
	};
}

export function parseMenu(text: string): MenuDocument {
	const rawLines = text.split(/\r\n|\r|\n/);
	const errors: Array<MenuError> = [];
	const lines = rawLines.map((raw, idx) => parseLine(raw, idx + 1, errors));
	return { lines, errors };
}
