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

/**
 * Which firmware build a parameter or command exists on, where RRF's own source differs by board
 * family. `"duet"` is the Duet3D/RepRapFirmware tree this dictionary is otherwise read from;
 * `"stm32"` is the gloomyandy/RepRapFirmware fork that runs on STM32 boards (its "TGBTC" build -
 * see `pins/communityBoards.ts`). Omit = present on every platform.
 */
export type FirmwarePlatform = "duet" | "stm32";

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
	/** The RRF version this parameter became required (`required: true`, or the object form's
	 *  condition holding) - for a parameter RRF used to default when omitted and later started
	 *  insisting on with `gb.MustSee`, where flagging its absence against older firmware would be
	 *  wrong (`M955`/`M956`'s `P`, `3.7.0-rc.1+1`). Omit = required at every version `required` names.
	 *  Only `dictionary/missing-required` reads it, against `DiagnoseOptions.firmwareVersion`. */
	requiredSince?: string;
	values?: ReadonlyArray<ParamValueSpec>;
	/** Names the companion letter whose value is a port name; `values` is checked only when that port is on the
	 *  main board. A port with a CAN board prefix (`123.dummy`) is handed to that board, whose own firmware
	 *  decides what the value may be - so the list, which is the main board's, does not apply (M308's `Y`:
	 *  `TemperatureSensor::Create` builds a `RemoteSensor` before it ever looks at the type name). */
	valuesLocalOnlyVia?: string;
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
	/** RRF version this PARAMETER was added in / last present in, if narrower than the command's own. `since` is the
	 *  first release that reads the letter; `until` the LAST release that still does (inclusive - the same meaning as
	 *  the object-model schema's `until`). Only a parameter that appears or disappears AFTER the oldest tracked
	 *  release (`RELEASES[0]`) needs either; a parameter whose range or values changed is a hand-written `changed`
	 *  event, not an existence change. */
	since?: string;
	until?: string;
	/** Ids for the change events generated from `since`/`until`, when a hand-written event already carries this
	 *  fact under its own id (event ids are a contract: `changes.ts` emits the existing id instead of `dict-...`). */
	eventIds?: { since?: string; until?: string };
	/** Only on these firmware builds - omit = every platform. The parameter is read from that
	 *  platform's own source (cited in `sources`), not the mainline's. */
	platforms?: ReadonlyArray<FirmwarePlatform>;
	sources: ReadonlyArray<string>;
}

/**
 * The parameters one value of a command's SELECTOR letter brings with it (`CommandSpec.selectorVariants`).
 * `M669 K6` selects Hangprinter kinematics, whose own `Configure` reads `N`, `A`-`D`, `I`, `J`, `L`, `O`, `P`; `K9` selects
 * the five-bar SCARA, which reads a different set under the same letters. `parameters` carries everything a plain
 * `ParamSpec` can say (kind, `listLength`, `since`/`until`, `values`), so a letter that only one type ever read, or whose
 * list length changed, is dated and checked per type instead of being lost in a catch-all.
 */
export interface ParamVariant {
	/** The selector values that pick this variant, as literal text (`"6"`); compared numerically. */
	values: ReadonlyArray<string>;
	/** What the variant is, for messages (`"Hangprinter (K6)"`). */
	label: string;
	/** The letters this variant reads in addition to the command's own `parameters` (a variant letter wins over a
	 *  command-level one of the same letter). */
	parameters: ReadonlyArray<ParamSpec>;
	/** For a variant whose letters are not fixed (the Core types: one row of motor factors per axis letter). Replaces
	 *  the command-level `axisParameters` for a line this variant selects; without it, an unlisted letter is unknown. */
	axisParameters?: { kind: ParamKind; list: boolean; description: string };
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
	/** First / LAST release that has this command (both inclusive; omitted = present at the oldest tracked release /
	 *  still present at the newest). See `ParamSpec.since`. */
	since?: string;
	until?: string;
	/** Ids for the events generated from `since`/`until`/`deprecated.since`, see `ParamSpec.eventIds`. */
	eventIds?: { since?: string; until?: string; deprecated?: string };
	deprecated?: { since?: string; replacement?: string; source: string };
	/** The newest RRF release up to which this command's own existence AND every parameter's history across the tracked
	 *  window (`RELEASES`) has been confirmed against RRF's source at each release, so an omitted `since`/`until` on it
	 *  (or on a parameter) means "unchanged", not "not looked at". Set only from `scripts/dictionary-history.mjs`
	 *  (the dispatcher's `case` at every release, `docs/dictionary-history.md`) and `scripts/dictionary-param-history.mjs`
	 *  (each listed letter read at every release, `docs/dictionary-param-history/`) with every non-"unchanged" verdict
	 *  settled by hand (`scripts/explain-handler.mjs`, `git show`). `dictionary/coverage.json` counts them and a test holds
	 *  the count from regressing. Not set for a fractional code (`M569.1`): its handler is shared with the integer code
	 *  or lives on an expansion board, so the tools cannot see it. */
	historyChecked?: string;
	/** Set for the `STRING_ARGUMENT_COMMANDS` (task 05, `lex.ts`) - the whole remainder of the line
	 *  is one unquoted string, not letter parameters. */
	stringArgument?: boolean;
	parameters: ReadonlyArray<ParamSpec>;
	axisParameters?: { kind: ParamKind; list: boolean; description: string };
	/**
	 * For a command whose accepted letters depend on the value of one of them (`M669`: `K` picks the kinematics type and
	 * each type reads its own letters). A line that gives the selector as a literal matching one variant is judged against
	 * `parameters` plus that variant's `parameters`, and a letter in neither is unknown (unless the variant has its own
	 * `axisParameters`). A line with no selector, an expression for it, or a value no variant names is judged exactly as
	 * before - the active state decides what is read and the command-level `axisParameters` catch-all still applies. Only
	 * the `since`/`until` of a variant's parameters feed `changesFromDictionary()`, as parameter events that name the
	 * selector (`ChangeEventTarget`'s `whenCompanion`), so one type's letter never flags another's line.
	 */
	selectorVariants?: { selector: string; variants: ReadonlyArray<ParamVariant> };
	/**
	 * RRF hands every parameter on this command to a macro it runs, as `param.<letter>`, without
	 * reading them itself - so a letter this entry doesn't list is not an error and not something this
	 * package can judge - a letter outside `except` is neither checked for being known nor for the
	 * shape of its value. `except` names the letters RRF does read for itself (`M98`'s `P` is the
	 * macro's filename and is not passed on). `trigger` is the letter whose presence makes the
	 * command run a macro at all (`M98`: only with `P`; `M98 R1` is a different, macro-less form) -
	 * omit it for a command that always runs one (`G32`, an unimplemented code). Distinct from
	 * `axisParameters`: those letters name axes and feed the project model's axis symbols; these are
	 * opaque to it.
	 * Cited to `StringParser::AddParameters` (`GCodes/GCodeBuffer/StringParser.cpp:2127-2149`) and the
	 * `DoFileMacroWithParameters` call site for the command.
	 */
	macroParameters?: { trigger?: string; except?: ReadonlyArray<string>; source: string };
	/** RRF's dispatcher has no `case` for this code - it falls through to `TryMacroFile` and runs
	 *  `/sys/<code>.g` if the user provided one (`files/customCodes.ts`). Always set together with
	 *  `macroParameters`. */
	unimplemented?: boolean;
	/** Only on these firmware builds - omit = every platform. */
	platforms?: ReadonlyArray<FirmwarePlatform>;
	mustFollow?: ReadonlyArray<OrderDependency>;
	/** Macro-invoking commands the wiki says must be alone on their line (`G28`, `G29`, `G32`, `M98`). */
	mustBeLastOnLine?: boolean;
	/** The RRF version this entry's handler was actually read at, in RRF source - unset means this
	 *  entry is still draft-only (bootstrapped from monacotokens/the wiki, not yet reviewed). */
	reviewed?: string;
	sources: ReadonlyArray<string>;
}

export type CommandDictionary = Readonly<Record<string, CommandSpec>>;
