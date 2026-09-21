/**
 * The diagnostics engine's own shape (task 14, `docs/tasks/14-diagnostics.md`). `src/diagnostics/
 * rules.ts` is the actual rule registry and check logic; nothing in this file is generated.
 */

import type { MachineMode } from "../lex.js";
import type { TextEdit } from "../document.js";

export type Severity = "error" | "warning" | "info" | "hint";

export interface Diagnostic {
	/** e.g. "dictionary/unknown-parameter" - stable, matches a `RuleInfo.id`. */
	rule: string;
	severity: Severity;
	message: string;
	file: string;
	/** 0-based, matching `GcodeDocument.lines[].index` (task 06's own convention) - NOT Monaco's
	 *  1-based line numbers; `toMonacoMarkers` does that conversion. */
	line: number;
	/** Absolute offsets into the file's own text (`GcodeDocument.text`), like `DocumentError`/
	 *  `LexError` before it. */
	start: number;
	end: number;
	fixes?: ReadonlyArray<{ title: string; edits: ReadonlyArray<TextEdit> }>;
	/** RRF source, wiki passage, or both - never empty (same citation bar as every dictionary/
	 *  object-model/release entry in this package). */
	sources: ReadonlyArray<string>;
}

export type RuleCategory = "syntax" | "structure" | "dictionary" | "project" | "release" | "menu" | "data" | "objectModel";

export interface RuleInfo {
	id: string;
	severity: Severity;
	category: RuleCategory;
	description: string;
	sources: ReadonlyArray<string>;
	/** Omit = applies at every RRF version this package tracks. */
	appliesTo?: { since?: string; until?: string };
}

export interface DiagnoseOptions {
	firmwareVersion: string;
	/** The version a file's own stamp (task 09) last recorded, if any - enables task 12's release
	 *  findings (`impactOf`) between that and `firmwareVersion`, in whichever direction that runs. */
	stampedVersion?: string;
	machineMode?: MachineMode;
	/** Board(s) in play, keyed by CAN address (`0` = the mainboard) - `project/unknown-pin-name`
	 *  only (task 17, Part B). Omitting an address skips that rule for pins on that board entirely,
	 *  rather than guessing - the same pattern this package already uses for `firmwareVersion`-gated
	 *  rules. Independent of whatever `ProjectOptions.boards` a project was loaded with - re-resolves
	 *  fresh at diagnose time (a pin symbol's own `id` already carries its `<CAN address>.<name>`
	 *  shape regardless of whether that name was resolved against a board table or left as raw typed
	 *  text at load time, so re-checking it here is always safe and idempotent). */
	boards?: ReadonlyMap<number, string>;
	rules?: { disable?: ReadonlyArray<string>; severity?: Readonly<Record<string, Severity>> };
}
