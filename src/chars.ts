/** Character-class tests on char codes, shared by the lexer and the parameter parser. Not exported. */

export function isSpace(code: number): boolean {
	return code === 32 || code === 9 || code === 13;
}
export function isDigit(code: number): boolean {
	return code >= 48 && code <= 57;
}
export function isLetter(code: number): boolean {
	return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

/**
 * RRF's own leading-indentation rule (`StringParser::Put`'s `parseNotStarted` state, checked
 * against 3.7.0-rc.1 source): each leading space adds 1; each leading tab rounds up to the next
 * multiple of 4 (`(indent + 4) & ~3`). Counted only over the run of leading whitespace before the
 * first other character. Shared by `lex.ts` (which needs it to locate where a line's content
 * starts) and `meta.ts` (which reports it for block-nesting purposes) - moved here from a private
 * copy in `meta.ts` so both use the identical implementation; behaviour is unchanged.
 */
export function leadingIndent(raw: string): { indent: number; contentStart: number } {
	let indent = 0;
	let i = 0;
	for (; i < raw.length; i++) {
		const c = raw.charCodeAt(i);
		if (c === 32 /* space */) {
			indent += 1;
		} else if (c === 9 /* tab */) {
			indent = (indent + 4) & ~3;
		} else {
			break;
		}
	}
	return { indent, contentStart: i };
}
