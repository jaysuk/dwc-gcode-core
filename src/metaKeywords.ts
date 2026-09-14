/**
 * RepRapFirmware's conditional-G-code keyword set and recognition rule, shared by `meta.ts` (line
 * classification) and `lex.ts` (which needs to know a line is a meta-command BEFORE attempting to
 * read it as G/M/T commands, matching RRF's own order: `GCodeBuffer::CheckMetaCommand` runs before
 * `StringParser::DecodeCommand`'s G/M/T dispatch). Split out from `meta.ts` (which used to define
 * these itself) purely to avoid `lex.ts` <-> `meta.ts` importing each other; the recognition rule
 * itself is unchanged from what `meta.ts` has always used.
 */

/**
 * The complete set RRF recognises — all twelve, not a curated subset. `skip` is recognised and
 * consumed but does nothing (`ProcessConditionalGCode`'s `case 4` returns `true` for it with no
 * further action); it is still reported as `"skip"`, not folded into `"unrecognised"` or dropped,
 * because it IS meta-command syntax to the firmware. There is no `return` keyword — RRF's
 * conditional G-code has no such thing.
 */
export type MetaKeyword =
	| "if" | "elif" | "else" | "while" | "break" | "continue" | "abort"
	| "var" | "global" | "set" | "echo" | "skip";

export const META_KEYWORDS: ReadonlySet<string> = new Set<MetaKeyword>([
	"if", "elif", "else", "while", "break", "continue", "abort", "var", "global", "set", "echo", "skip",
]);

/**
 * Which meta keyword (if any) a line's content starts with, by RRF's exact recognition rule
 * (`ProcessConditionalGCode`): a run of lowercase `a`–`z` characters, at most 8 long ("all command
 * words are less than 9 characters long"), immediately followed by end-of-content, a space, a tab,
 * `{`, `"` or `(`. Two consequences worth the reminder: this is **case-sensitive** — `If`/`VAR` are
 * not meta-commands to RRF, unlike G/M/T commands, which it reads case-insensitively — and it is a
 * length-then-text dispatch in source, not a regex alternation, but the *outcome* is exactly these
 * twelve words, properly terminated, nothing else.
 */
export function metaKeywordOf(content: string): MetaKeyword | null {
	let i = 0;
	while (i < content.length && i < 8 && content.charCodeAt(i) >= 97 && content.charCodeAt(i) <= 122) i++;
	if (i < 2) return null;
	const terminator = content[i];
	if (terminator !== undefined && terminator !== " " && terminator !== "\t" && terminator !== "{" && terminator !== "\"" && terminator !== "(") {
		return null;
	}
	const word = content.slice(0, i);
	return META_KEYWORDS.has(word) ? (word as MetaKeyword) : null;
}
