/**
 * User-defined G and M codes: RRF's "custom G and M codes" mechanism. A G or M code RRF doesn't
 * implement itself is run as a macro named after the code - `M1234` runs `/sys/M1234.g`, `G38.9`
 * runs `/sys/G38.9.g` (`GCodes/GCodes2.cpp:4810-4830` `GCodes::TryMacroFile`, RRF `3.7.0-rc.1`;
 * wiki `Gcodes.md` "Custom G and M codes"). The macro is started with the command's own parameters
 * as `param.<letter>` (`DoFileMacroWithParameters`), so a code like this legitimately takes any
 * letters - which is why this package's diagnostics don't judge a custom code's parameters.
 *
 * This module answers three questions a plugin has when it meets a code it doesn't recognise:
 *  - is this filename a custom-code macro at all (`customCodeOfFile`),
 *  - which codes do a folder listing's files define (`customCodesOf`), and
 *  - would RRF actually run a macro for this command, or handle it itself (`reachesMacroFile`) -
 *    a `sys/M104.g` is silently never run, because M104 is implemented.
 *
 * `commandDispatch` combines those with the command dictionary into the one answer an editor wants
 * for a hover or a diagnostic.
 */

import { commandSpec } from "../dictionary/commands.js";
import type { CommandSpec } from "../dictionary/schema.js";

/** `TryMacroFile` refuses a code outside `0..9999` (`GCodes2.cpp:4813`). */
const MAX_CODE = 9999;

/**
 * G-codes with a fractional part (`G38.2`) that RRF's own switch handles - every OTHER `G<n>.<f>` is
 * offered to `TryMacroFile` before the switch is even reached (`GCodes2.cpp:200-207`, "these are the
 * only G-codes we implement that can have fractional parts").
 */
const G_FRACTION_HANDLED: ReadonlySet<number> = new Set([38, 59]);

/** The M-code equivalent (`GCodes2.cpp:742-753`), including the two codes that are conditional there
 *  (`558` needs scanning-probe support, `970` needs phase-stepping support - both are in every build
 *  this package's baseline describes). */
const M_FRACTION_HANDLED: ReadonlySet<number> = new Set([36, 201, 260, 261, 505, 558, 569, 576, 581, 586, 587, 970]);

/** `M558.5` and up are handed to `TryMacroFile` even though `M558` itself takes fractions
 *  (`GCodes2.cpp:3749` `(gb.GetCommandFraction() > 4) ? TryMacroFile(gb) : HandleM558`). */
const M558_FIRST_MACRO_FRACTION = 5;

export interface CustomCode {
	letter: "G" | "M";
	number: number;
	/** The single fractional digit RRF reads (`lex.ts` - `commandFraction` is one digit), or `null`. */
	fraction: number | null;
	/** Uppercase, in the form `LexedCommand.code` uses: `"M1234"`, `"G38.9"`. */
	code: string;
	/** The macro's filename as RRF builds it: `"M1234.g"`, `"G38.9.g"` (`TryMacroFile`'s `printf`). */
	file: string;
}

// The number has no leading zero: `TryMacroFile` prints it with `%d`, so "M05.g" is not a name it looks for.
const FILE_RE = /^([GM])(0|[1-9]\d{0,3})(?:\.(\d))?\.g$/i;
const CODE_RE = /^([GM])(0|[1-9]\d{0,3})(?:\.(\d))?$/i;

/** Splits a path into segments, dropping a `<volume>:` prefix - the same tolerance `classifyFile` has. */
function segmentsOf(path: string): Array<string> {
	return path.replace(/^[A-Za-z0-9]*:/, "").split(/[/\\]+/).filter((s) => s.length > 0);
}

/**
 * The custom code a filename defines, or `null`. Accepts a bare filename (`"M1234.g"`) or a path;
 * a path must be directly in the system folder (`sys/M1234.g`, `0:/sys/M1234.g`) - `TryMacroFile`
 * opens the macro through `DoFileMacro`, which resolves a relative name against `/sys` and nowhere
 * else, so a `macros/M1234.g` is an ordinary macro, not a custom code. Matching is
 * case-insensitive (the SD card is FAT).
 */
export function customCodeOfFile(path: string): CustomCode | null {
	const segments = segmentsOf(path);
	if (segments.length === 0) return null;
	if (segments.length > 1 && !(segments.length === 2 && segments[0].toLowerCase() === "sys")) return null;
	const match = FILE_RE.exec(segments[segments.length - 1]);
	if (match === null) return null;
	const number = Number(match[2]);
	if (number > MAX_CODE) return null;
	const letter = match[1].toUpperCase() as "G" | "M";
	const fraction = match[3] === undefined ? null : Number(match[3]);
	// `TryMacroFile` prints "%c%d.%d.g" only when the fraction is > 0, "%c%d.g" otherwise.
	const hasFraction = fraction !== null && fraction > 0;
	if (fraction !== null && !hasFraction) return null; // "M5.0.g" is never the name RRF looks for
	const code = hasFraction ? `${letter}${number}.${fraction}` : `${letter}${number}`;
	return { letter, number, fraction: hasFraction ? fraction : null, code, file: `${code}.g` };
}

/** The set of custom codes (`"M1234"`, `"G38.9"`) defined by a folder listing's files - pass this as
 *  `DiagnoseOptions.customCodes`. Files that aren't custom-code macros are ignored. */
export function customCodesOf(paths: Iterable<string>): Set<string> {
	const codes = new Set<string>();
	for (const path of paths) {
		const c = customCodeOfFile(path);
		if (c !== null) codes.add(c.code);
	}
	return codes;
}

/** The macro filename RRF looks for when it runs `code` as a custom code - `"M1234.g"`. Returns
 *  `null` for anything `TryMacroFile` would refuse (a `T` code, no number, a number over 9999). */
export function macroFileForCode(code: string): string | null {
	const match = CODE_RE.exec(code);
	if (match === null) return null;
	const fraction = match[3] === undefined ? 0 : Number(match[3]);
	const base = `${match[1].toUpperCase()}${Number(match[2])}`;
	return fraction > 0 ? `${base}.${fraction}.g` : `${base}.g`;
}

/**
 * Whether RRF offers this command to `TryMacroFile` - i.e. whether a `/sys/<code>.g` file would
 * ever run for it.
 *  - a code with a fractional part goes there unless the number is one RRF handles fractions of
 *    (`G_FRACTION_HANDLED`/`M_FRACTION_HANDLED`);
 *  - a code without one goes there only when RRF's switch has no case for it - which this package
 *    reads from its own command dictionary (complete: `dictionary/coverage.json`): a code the
 *    dictionary doesn't know, or one it marks `unimplemented`.
 */
export function reachesMacroFile(code: string): boolean {
	const match = CODE_RE.exec(code);
	if (match === null) return false;
	const letter = match[1].toUpperCase();
	const number = Number(match[2]);
	const fraction = match[3] === undefined ? 0 : Number(match[3]);
	if (fraction > 0) {
		if (letter === "G") return !G_FRACTION_HANDLED.has(number);
		if (number === 558) return fraction >= M558_FIRST_MACRO_FRACTION;
		return !M_FRACTION_HANDLED.has(number);
	}
	const spec = commandSpec(`${letter}${number}`);
	return spec === null || spec.unimplemented === true;
}

export type CommandDispatch =
	/** RRF implements this itself; a same-named macro in `/sys` is never run. */
	| { kind: "builtin"; spec: CommandSpec }
	/** RRF runs `/sys/<file>` for this code. `present` is `undefined` when the caller gave no listing
	 *  of `/sys` to check. */
	| { kind: "custom-macro"; file: string; present: boolean | undefined }
	/** Neither: RRF would report the code as unsupported (or, for an exempt fractional form, handle
	 *  and reject it itself). */
	| { kind: "unknown" };

/**
 * What RRF does with `code`, combining the dictionary and the custom-code rule. `customCodes` is the
 * set of custom codes actually present in `/sys` (`customCodesOf`); omit it when the caller can't
 * see the SD card, and `present` is reported as `undefined` rather than guessed.
 */
export function commandDispatch(code: string, customCodes?: ReadonlySet<string> | ReadonlyArray<string>): CommandDispatch {
	const upper = code.toUpperCase();
	if (reachesMacroFile(upper)) {
		const set = customCodes === undefined ? undefined : customCodes instanceof Set ? customCodes : new Set(customCodes);
		return { kind: "custom-macro", file: macroFileForCode(upper)!, present: set === undefined ? undefined : set.has(upper) };
	}
	const spec = commandSpec(upper);
	return spec === null ? { kind: "unknown" } : { kind: "builtin", spec };
}
