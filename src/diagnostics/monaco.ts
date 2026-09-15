/**
 * Converts this package's own 0-based line / absolute-offset `Diagnostic`s (task 14) into the shape
 * Monaco's `editor.setModelMarkers` expects - 1-based line numbers and 1-based columns, both counted
 * in UTF-16 code units (Monaco's own convention; a JS string index already is one, so no conversion
 * of the offsets themselves is needed, only which line they fall on and how far into it).
 *
 * This module never imports `monaco-editor` - a consumer's own bundle already has it, and this
 * package has no DOM/runtime dependencies at all (CLAUDE.md rule 3). The returned objects are plain
 * data matching Monaco's `IMarkerData` shape structurally.
 */

import type { Diagnostic, Severity } from "./schema.js";

export interface MonacoMarker {
	code: string;
	severity: 1 | 2 | 4 | 8;
	message: string;
	startLineNumber: number;
	startColumn: number;
	endLineNumber: number;
	endColumn: number;
}

/** `monaco.MarkerSeverity`: Hint = 1, Info = 2, Warning = 4, Error = 8. */
const MONACO_SEVERITY: Readonly<Record<Severity, 1 | 2 | 4 | 8>> = {
	hint: 1,
	info: 2,
	warning: 4,
	error: 8,
};

/** Start offset (into `text`) of each line, index 0 is line 0. A line "starts" right after the
 *  previous `\n`; `\r` immediately before it is left as the last character of the line it ends,
 *  matching how every `start`/`end` offset elsewhere in this package was measured off the raw text. */
function lineStartOffsets(text: string): Array<number> {
	const starts = [0];
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 10 /* \n */) starts.push(i + 1);
	}
	return starts;
}

function offsetToPosition(starts: ReadonlyArray<number>, offset: number): { line: number; column: number } {
	// Binary search for the last start <= offset.
	let lo = 0;
	let hi = starts.length - 1;
	while (lo < hi) {
		const mid = (lo + hi + 1) >> 1;
		if (starts[mid] <= offset) lo = mid; else hi = mid - 1;
	}
	return { line: lo, column: offset - starts[lo] + 1 };
}

/** `diagnostics` must all belong to the single file whose text is `text`. Only `start`/`end` are
 *  read - they're the authoritative absolute offsets, and the line/column pair is derived from them
 *  against `text`. `Diagnostic.line` is deliberately ignored rather than cross-checked: it would only
 *  ever disagree if the caller paired diagnostics with the wrong file's text, in which case the
 *  offsets are wrong too and there's nothing useful to fall back to. */
export function toMonacoMarkers(diagnostics: ReadonlyArray<Diagnostic>, text: string): Array<MonacoMarker> {
	const starts = lineStartOffsets(text);
	return diagnostics.map((d) => {
		const from = offsetToPosition(starts, d.start);
		const to = offsetToPosition(starts, d.end);
		return {
			code: d.rule,
			severity: MONACO_SEVERITY[d.severity],
			message: d.message,
			startLineNumber: from.line + 1,
			startColumn: from.column,
			endLineNumber: to.line + 1,
			endColumn: to.column,
		};
	});
}
