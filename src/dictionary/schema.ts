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
	 *  ("use required: 'unknown' plus a note rather than a wrong boolean"). */
	required?: boolean | "unknown";
	values?: ReadonlyArray<ParamValueSpec>;
	/** How `values` is matched against a literal `kind: "string"` value. Omit (or `"exact"`) for
	 *  RRF's usual `NamedEnum`/`strcmp` string enums (e.g. M593's `P`, M569.1's `Y`) - case-sensitive,
	 *  no separator tolerance. `"reduced"` is for the rarer case where RRF itself uses
	 *  `ReducedStringEquals` (case-insensitive, ignores `-`/`_` on either side) - confirmed for M308's
	 *  `Y` (`TemperatureSensor::Create`) by reading `General/StringFunctions.cpp` directly; don't
	 *  assume one or the other without checking the specific command's own matching function. */
	valueMatch?: "exact" | "reduced";
	range?: { min?: number; max?: number };
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
