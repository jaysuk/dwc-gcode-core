/**
 * The release change-event store (task 12, `docs/tasks/12-release-model.md`). Three sources, merged
 * into one `CHANGES` array:
 *  - `HAND_WRITTEN_CHANGES` below — syntax and behaviour changes that don't fit the dictionary's or
 *    object model's own per-entry lifetime fields, found via `scripts/rrf-triage.mjs`'s
 *    `GCodeBuffer`/`GCodes dispatch` output (see `docs/tasks/12-release-model.md`'s Findings for
 *    exactly which subsystems have been triaged so far - most have not yet).
 *  - `changesFromDictionary()` — generated from task 10's `dictionary/commands.json`: any reviewed
 *    command or parameter with a `since`/`until`/`deprecated` field becomes an `added`/`removed`/
 *    `deprecated` event automatically. Most reviewed entries don't have these fields yet (task 10's
 *    own scope was existence/shape, not version history) - this generator picks up whatever the
 *    dictionary is later filled in with, without needing this file touched again.
 *  - `changesFromObjectModel()` — generated from task 11's `src/objectmodel/schema.ts`
 *    (`OBJECT_MODEL_PATHS`), which already has real `since`/`until`/`deprecated` data for all 709
 *    tracked paths.
 *
 * `FEATURES` (`../firmware.js`) is a thin, named view over a handful of these events (task 12's own
 * decision) - `featureFromEvent` below resolves a feature's `since`/`source` from its event instead
 * of duplicating them.
 */
import { COMMANDS } from "../dictionary/commands.js";
import { OBJECT_MODEL_PATHS } from "../objectmodel/schema.js";
import { compareFirmwareVersions } from "../versionCompare.js";
import type { ChangeEvent } from "./schema.js";

export type { ChangeEvent, ChangeEventTarget } from "./schema.js";

/**
 * Real, cited syntax and behaviour changes found while triaging `3.6.3..3.7.0-rc.1` (task 12's own
 * checklist, `docs/rrf-triage/3.6.3..3.7.0-rc.1.md`) plus the facts already established (and cited)
 * in `firmware.ts`'s pre-task-12 `FEATURES` table, migrated here so `FEATURES` can become a view over
 * them rather than a second, disconnected copy of the same facts.
 *
 * Every `version` here was pinned with `git -C <RRF clone> describe --tags --contains <sha>` (the
 * earliest tag whose history contains the commit) against the local RRF clone, not guessed from a
 * commit's own date - a commit's date can precede the tag that actually first ships it by months.
 */
const HAND_WRITTEN_CHANGES: ReadonlyArray<ChangeEvent> = [
	// --- migrated from firmware.ts's FEATURES, pre-task-12 (each citation already existed there) ---
	{
		id: "expr-basic",
		version: "3.01",
		kind: "added",
		target: { type: "syntax", feature: "expressions" },
		description: "{expression} in place of any numeric or quoted-string operand.",
		sources: ["wiki Gcode_meta_commands.md \"Use of expressions within GCode commands\""],
	},
	{
		id: "meta-variables",
		version: "3.3",
		kind: "added",
		target: { type: "syntax", feature: "variables" },
		description: "var/global/set meta-commands (RRF's local/global variables).",
		sources: ["wiki Gcode_meta_commands.md \"Variables\": \"Supported from RRF 3.3\""],
	},
	{
		id: "m568-added",
		version: "3.3",
		kind: "added",
		target: { type: "command", code: "M568" },
		description: "M568 (Set Tool Settings) added - the modern alternative to G10's temperature form.",
		sources: ["wiki Gcodes.md \"## M568: Set Tool Settings\": \"Available in RepRapFirmware 3.3 and later\""],
	},
	{
		id: "m563-r-added",
		version: "3.3",
		kind: "added",
		target: { type: "parameter", code: "M563", letter: "R" },
		description: "M563's R parameter (spindle number mapped to a tool) added.",
		sources: ["wiki Gcodes.md \"## M563\": \"(RRF >= 3.3)\""],
	},
	{
		id: "lowercase-axis-letters",
		version: "3.4",
		kind: "added",
		target: { type: "syntax", feature: "lowercase-axis-letters" },
		description: "Lowercase axis letters (a-l) from M584, quoted with a leading ' in G-code.",
		sources: ["wiki Gcodes.md \"## M584\": \"UVWABCDabcdefghijkl available in RepRapFirmware 3.4\""],
	},
	{
		id: "m309-added",
		version: "3.4",
		kind: "added",
		target: { type: "command", code: "M309" },
		description: "M309 (heater feedforward) added.",
		sources: ["wiki Gcodes.md \"## M309\": \"Supported in RepRapFirmware v3.4 and later\""],
	},
	{
		id: "m309-feedforward-added",
		version: "3.6.0",
		kind: "added",
		target: { type: "behaviour", code: "M309", description: "T (temperature feedforward) and A parameters, not just S (PWM)" },
		description: "M309's T (temperature feedforward) and A parameters added, not just S (PWM).",
		sources: ["wiki Gcodes.md \"## M309\": \"Supported in RRF 3.6.0 and later\" (the T parameter specifically)"],
	},
	{
		id: "comment-indent-insignificant",
		version: "3.6.0",
		kind: "changed",
		target: { type: "syntax", feature: "comment-indent-insignificant" },
		description: "A comment line's own indentation no longer affects meta-gcode block nesting.",
		sources: ["wiki Gcode_meta_commands.md \"Indentation of comments\""],
	},
	{
		id: "m116-scoped-to-motion-system",
		version: "3.5.0",
		kind: "changed",
		target: { type: "behaviour", code: "M116", description: "bare M116 (no params) only waits for tools of the invoking motion system" },
		description: "Bare M116 (no params) only waits for tools of the invoking motion system.",
		sources: ["wiki Gcodes.md \"## M116\": \"in RRF 3.5.0 and later, the scope of tool heaters...\""],
	},
	{
		id: "m116-p-colon-list",
		version: "3.7.0-beta.3",
		kind: "changed",
		target: { type: "parameter", code: "M116", letter: "P" },
		description: "M116's P may be a colon-separated tool list; bare P waits for every tool.",
		sources: ["wiki Gcodes.md \"## M116\": \"In RRF 3.7.0-beta.3 and later this may be a colon-separated list\""],
	},
	{
		// Was pinned to a conservative "3.7.0-rc.1" ("the commit lands somewhere between 3.6.3 and
		// 3.7.0-rc.1... not dated to an exact intermediate beta" - firmware.ts's own former comment).
		// Task 12's triage now pins it exactly: `git describe --tags --contains 6aadff7c19` = "3.7.0-beta.1~73".
		id: "expr-array-concat",
		version: "3.7.0-beta.1",
		kind: "added",
		target: { type: "syntax", feature: "array-concat" },
		description: "The ^ operator concatenates two arrays in an expression.",
		sources: ["RRF commit 6aadff7c19 \"feat: allow arrays to be concatenated with `^`\""],
	},
	{
		id: "m955-single-accelerometer",
		version: "3.7.0-rc.1",
		kind: "changed",
		target: { type: "behaviour", code: "M955", description: "collapsed to exactly one active accelerometer machine-wide; C mandatory, P capped to 0" },
		description: "M955/M956 collapsed to exactly one active accelerometer machine-wide; C mandatory, P capped to 0.",
		sources: ["RepRapFirmware commit 81d68e1"],
	},
	{
		id: "m955-p-uncapped",
		version: "3.7.0-rc.1+1",
		kind: "changed",
		target: { type: "parameter", code: "M955", letter: "P" },
		description: "M955/M956 support up to 10 independent accelerometer slots; P selects which (no longer capped to 0).",
		sources: ["RepRapFirmware commit ee3c80b / Duet3Expansion commit 73549e0"],
	},

	// --- new, found during task 12's own triage of GCodeBuffer + GCodes dispatch ---
	{
		id: "expr-array-literal",
		version: "3.7.0-alpha.2",
		kind: "added",
		target: { type: "syntax", feature: "array-literal" },
		description: "Array literal syntax [e,e,e...] in expressions.",
		sources: ["RRF commit 18612b8685 \"Introduce new array syntax [e,e,e...]\""],
	},
	{
		id: "expr-exists-argument-forms",
		version: "3.7.0-alpha.2",
		kind: "changed",
		target: { type: "syntax", feature: "exists-argument-forms" },
		description: "exists() accepts exists(#x) and exists(x[0]) even when x is not an array (previously restricted to array expressions).",
		sources: ["RRF commit c1decff1da \"Support exists(#x) and exists(x[0]) when x is not an array\""],
	},
	{
		id: "m408-removed",
		version: "3.7.0-alpha.2",
		kind: "removed",
		target: { type: "command", code: "M408" },
		description: "M408 removed entirely; superseded by the object model (M409's own JSON reporting).",
		sources: ["RRF commit 9aaeab794f \"Removed support for M408\""],
	},
	{
		id: "m301-removed",
		version: "3.7.0-beta.1",
		kind: "removed",
		target: { type: "command", code: "M301" },
		description: "M301 removed as a standalone dispatched command; M301PidParameters survives only as an internal struct name for M307's own reporting.",
		sources: ["RRF commit fbd90a6a6e \"Removed support for M301 and M304\"", "docs/tasks/10-dictionary.md Findings (independently found from the RRF-vs-monacotokens diff)"],
	},
	{
		id: "m304-removed",
		version: "3.7.0-beta.1",
		kind: "removed",
		target: { type: "command", code: "M304" },
		description: "M304 removed as a standalone dispatched command.",
		sources: ["RRF commit fbd90a6a6e \"Removed support for M301 and M304\"", "docs/tasks/10-dictionary.md Findings (independently found from the RRF-vs-monacotokens diff)"],
	},
	{
		id: "m140-h-colon-list",
		version: "3.7.0-beta.1",
		kind: "changed",
		target: { type: "parameter", code: "M140", letter: "H" },
		description: "M140/M141's H parameter becomes a colon list; multiple heaters may be assigned to one bed/chamber slot.",
		sources: ["RRF commit 8a1738d029 \"Allow multiple heaters to be assigned to beds/chambers (#1103)\""],
	},
	{
		id: "m558-4-added",
		version: "3.7.0-beta.3",
		kind: "added",
		target: { type: "command", code: "M558.4" },
		description: "M558.4 added to manually tare a load cell probe.",
		sources: ["RRF commit 2645db0930 \"Added M558.4 to manually tare a load cell probe\""],
	},
	{
		id: "m564-r-added",
		version: "3.7.0-beta.3",
		kind: "added",
		target: { type: "parameter", code: "M564", letter: "R" },
		description: "M564 R parameter added for relative-move clamping.",
		sources: ["RRF commit 7e74287b62 \"Added M564 R parameter for relative move clamping\""],
	},
	{
		id: "m221-f-added",
		version: "3.7.0-rc.1",
		kind: "added",
		target: { type: "parameter", code: "M221", letter: "F" },
		description: "M221 F1 added: apply the extrusion factor immediately (low latency) instead of through the usual jerk-limited ramp.",
		sources: ["RRF commit 68010861b2 \"Started adding support for M221 F1 parameter\""],
	},
	{
		id: "m552-t-tristate",
		version: "3.7.0-beta.1",
		kind: "changed",
		target: { type: "parameter", code: "M552", letter: "T" },
		description: "M552's T parameter widens from a boolean (0/1, enable TLS) to a tri-state (-1 clear stored TLS material and start plain, 0/absent plain, 1 enable) as part of WiFi TLS support - T-1 has no effect before this version.",
		sources: ["RRF commit 4ead59f9a4 \"Added TLS support over WiFi (ESP32 S3)\""],
	},
];

function dictionaryCommandEvents(): Array<ChangeEvent> {
	const events: Array<ChangeEvent> = [];
	for (const spec of Object.values(COMMANDS)) {
		if (spec.since !== undefined) {
			events.push({
				id: `dict-${spec.code}-added`, version: spec.since, kind: "added",
				target: { type: "command", code: spec.code },
				description: `${spec.code} added: ${spec.summary}`, sources: spec.sources,
			});
		}
		if (spec.until !== undefined) {
			events.push({
				id: `dict-${spec.code}-removed`, version: spec.until, kind: "removed",
				target: { type: "command", code: spec.code },
				description: `${spec.code} removed: ${spec.summary}`, sources: spec.sources,
			});
		}
		if (spec.deprecated?.since !== undefined) {
			events.push({
				id: `dict-${spec.code}-deprecated`, version: spec.deprecated.since, kind: "deprecated",
				target: { type: "command", code: spec.code },
				description: spec.deprecated.replacement !== undefined
					? `${spec.code} deprecated - use ${spec.deprecated.replacement} instead`
					: `${spec.code} deprecated`,
				sources: [spec.deprecated.source],
			});
		}
		for (const param of spec.parameters) {
			if (param.since !== undefined) {
				events.push({
					id: `dict-${spec.code}-${param.letter}-added`, version: param.since, kind: "added",
					target: { type: "parameter", code: spec.code, letter: param.letter },
					description: `${spec.code}'s ${param.letter} parameter added: ${param.description}`, sources: param.sources,
				});
			}
			if (param.until !== undefined) {
				events.push({
					id: `dict-${spec.code}-${param.letter}-removed`, version: param.until, kind: "removed",
					target: { type: "parameter", code: spec.code, letter: param.letter },
					description: `${spec.code}'s ${param.letter} parameter removed: ${param.description}`, sources: param.sources,
				});
			}
		}
	}
	return events;
}

function objectModelEvents(): Array<ChangeEvent> {
	const events: Array<ChangeEvent> = [];
	for (const entry of OBJECT_MODEL_PATHS) {
		if (entry.since !== undefined) {
			events.push({
				id: `om-${entry.path}-added`, version: entry.since, kind: "added",
				target: { type: "objectModelPath", path: entry.path },
				description: `Object-model path ${entry.path} added`, sources: ["@duet3d/objectmodel (see docs/tasks/11-object-model-schema.md)"],
			});
		}
		if (entry.until !== undefined) {
			events.push({
				id: `om-${entry.path}-removed`, version: entry.until, kind: "removed",
				target: { type: "objectModelPath", path: entry.path },
				description: `Object-model path ${entry.path} removed`, sources: ["@duet3d/objectmodel (see docs/tasks/11-object-model-schema.md)"],
			});
		}
		if (entry.deprecated !== undefined) {
			events.push({
				id: `om-${entry.path}-deprecated`, version: entry.deprecated.since, kind: "deprecated",
				target: { type: "objectModelPath", path: entry.path },
				description: `Object-model path ${entry.path} deprecated - ${entry.deprecated.message}`,
				sources: ["@duet3d/objectmodel deprecations.json (see docs/tasks/11-object-model-schema.md)"],
			});
		}
	}
	return events;
}

/**
 * Every known change event, from all three sources above. IDs are unique across the whole store -
 * `dict-`/`om-` prefixes keep the two generators from ever colliding with each other or with a
 * hand-written id.
 */
export const CHANGES: ReadonlyArray<ChangeEvent> = [
	...HAND_WRITTEN_CHANGES,
	...dictionaryCommandEvents(),
	...objectModelEvents(),
];

/** Looks up one hand-written event by id, for `firmware.ts`'s `FEATURES` to read `since`/`sources`
 *  from instead of duplicating them - task 12's "FEATURES becomes a thin view over events" decision.
 *  Throws on an unknown id (a typo'd reference is a bug to fix, not a silently-missing feature). */
export function changeEvent(id: string): ChangeEvent {
	const event = CHANGES.find((e) => e.id === id);
	if (event === undefined) {
		throw new Error(`changeEvent(): no change event with id "${id}"`);
	}
	return event;
}

export interface DirectedChangeEvent extends ChangeEvent {
	direction: "upgrade" | "downgrade";
}

/**
 * Every change event whose version lies in `(min(fromVersion, toVersion), max(fromVersion,
 * toVersion)]`, each annotated with which way the query actually runs. `kind` is left exactly as
 * recorded (what really happened in RRF's own history) - `direction` is how the CALLER should read
 * it: on a downgrade, an event's own `kind` still says "added" (that's the historical fact), but the
 * caller reading `direction: "downgrade"` knows the target is NOT available at `toVersion`. This
 * mirrors task 11's `objectModelChanges`, which uses the same "kind is the recorded fact, direction
 * is how you're traversing it" split.
 */
export function changesBetween(fromVersion: string, toVersion: string): ReadonlyArray<DirectedChangeEvent> {
	const forward = compareFirmwareVersions(fromVersion, toVersion) <= 0;
	const lo = forward ? fromVersion : toVersion;
	const hi = forward ? toVersion : fromVersion;
	const direction: "upgrade" | "downgrade" = forward ? "upgrade" : "downgrade";
	return CHANGES.filter((e) => compareFirmwareVersions(e.version, lo) > 0 && compareFirmwareVersions(e.version, hi) <= 0)
		.map((e) => ({ ...e, direction }))
		.sort((a, b) => compareFirmwareVersions(a.version, b.version) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
