/**
 * The command dictionary's own shape (task 10, `docs/tasks/10-dictionary.md`). `src/dictionary/
 * commands.ts` is GENERATED data (`scripts/build-dictionary.mjs`) conforming to this; nothing in
 * this file itself is generated.
 */

import type { MachineMode } from "../lex.js";

export type ParamKind =
	| "number" | "integer" | "unsigned" | "boolean01" | "string" | "driverId" | "pin"
	| "axisLetters" | "toolNumber" | "heaterNumber" | "fanNumber" | "sensorNumber" | "probeNumber"
	| "bitmap" | "filename" | "any";

export interface ParamValueSpec { value: string; description: string }

export interface ParamSpec {
	letter: string;
	description: string;
	kind: ParamKind;
	/** Takes a colon-separated list of `kind` (e.g. `M92 E420:500`). */
	list: boolean;
	/** Accepts an RRF `{...}` expression in place of a literal value. */
	expressionAllowed: boolean;
	/** `"unknown"` when required-ness genuinely depends on other parameters/context RRF's own
	 *  source makes clear exists but this entry hasn't pinned down precisely - see task 10's Traps
	 *  ("use required: 'unknown' plus a note rather than a wrong boolean"), OR the real condition
	 *  needs more than one companion letter at once (e.g. M586's H, required only when P selects MQTT
	 *  AND S1 enables it) - the object form below is deliberately limited to ONE companion letter,
	 *  mirroring the single `gb.Seen(...)` check every real single-condition case in RRF's own source
	 *  turned out to be (task 17, Decision 4) - don't grow it into a general expression evaluator for
	 *  the rare multi-letter case; use `"unknown"` for those instead.
	 *
	 *  The object form is a same-line condition on exactly one companion letter, matching what RRF's
	 *  own source does for every case that fits: `ifLetterPresent` alone for a plain "requires X"
	 *  (e.g. M586.4's `T`, required only when `W` is given); `valueOneOf` narrows it to "present AND
	 *  equal to one of these" (e.g. M569.1's `C`, required only when `T` is `1` or `2`); `valueNot`
	 *  narrows it to "present AND not equal to" (e.g. M589's `P`/`I`, required only when `S` is given
	 *  and isn't `"*"`). Values are compared against the companion parameter's own literal text,
	 *  unquoted first if it's a quoted string - never against an RRF `{...}` expression. */
	required?: boolean | "unknown" | {
		ifLetterPresent: string;
		valueOneOf?: ReadonlyArray<string>;
		valueNot?: string;
	};
	values?: ReadonlyArray<ParamValueSpec>;
	/** How `values` is matched against a literal `kind: "string"` value. Omit (or `"exact"`) for
	 *  RRF's usual `NamedEnum`/`strcmp` string enums (e.g. M593's `P`, M569.1's `Y`) - case-sensitive,
	 *  no separator tolerance. `"reduced"` is for the rarer case where RRF itself uses
	 *  `ReducedStringEquals` (case-insensitive, ignores `-`/`_` on either side) - confirmed for M308's
	 *  `Y` (`TemperatureSensor::Create`) by reading `General/StringFunctions.cpp` directly; don't
	 *  assume one or the other without checking the specific command's own matching function. */
	valueMatch?: "exact" | "reduced";
	range?: { min?: number; max?: number };
	/** For `list: true` only - the element counts RRF itself actually accepts, when the valid element
	 *  count is a genuinely closed set rather than "any length". Found via `StringParser::CheckArray
	 *  Length` (`GCodes/GCodeBuffer/StringParser.cpp`) - the shared array-reading code every
	 *  `Get{Float,Unsigned,Int}Array` call goes through, which THROWS `"array too long for parameter
	 *  '%c'"` once the element count would exceed the caller's own fixed-size array (e.g. M950's
	 *  spindle-form `L` reads into a 2-element array - `{1, 2}` are the only valid lengths, `Tools/
	 *  Spindle.cpp:87-101`; its `K` reads into a 3-element array - `{1, 2, 3}`, `Spindle.cpp:65-79`).
	 *  Only ever a hard UPPER bound RRF enforces by construction (the fixed array size) - there is no
	 *  general lower-bound check in the shared array reader itself (a caller's own logic, e.g.
	 *  `numValues == 1` vs `== 2` vs `== 3`, decides what each count MEANS, not whether it's allowed) -
	 *  so don't assume every length below the max is valid without checking that specific parameter's
	 *  own caller logic; the safe, always-citable subset to encode here is "every length RRF explicitly
	 *  reads/gives meaning to", which in practice is `1` through the array size, with no gaps found so
	 *  far. */
	listLength?: ReadonlyArray<number>;
	/** RRF version this PARAMETER was added/removed in, if narrower than the command's own. */
	since?: string;
	until?: string;
	sources: ReadonlyArray<string>;
}

export interface OrderDependency { code: string; when?: string; source: string }

export interface CommandSpec {
	code: string;
	summary: string;
	/** Omit = valid in every machine mode. */
	machineModes?: ReadonlyArray<MachineMode>;
	/** `"config"` only where source or the wiki actually says so (e.g. only valid in config.g). */
	context?: "config" | "any";
	since?: string;
	until?: string;
	deprecated?: { since?: string; replacement?: string; source: string };
	/** Set for the `STRING_ARGUMENT_COMMANDS` (task 05, `lex.ts`) - the whole remainder of the line
	 *  is one unquoted string, not letter parameters. */
	stringArgument?: boolean;
	parameters: ReadonlyArray<ParamSpec>;
	axisParameters?: { kind: ParamKind; list: boolean; description: string };
	mustFollow?: ReadonlyArray<OrderDependency>;
	/** Macro-invoking commands the wiki says must be alone on their line (`G28`, `G29`, `G32`, `M98`). */
	mustBeLastOnLine?: boolean;
	/** The RRF version this entry's handler was actually read at, in RRF source - unset means this
	 *  entry is still draft-only (bootstrapped from monacotokens/the wiki, not yet reviewed). */
	reviewed?: string;
	sources: ReadonlyArray<string>;
}

export type CommandDictionary = Readonly<Record<string, CommandSpec>>;
