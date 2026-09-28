/**
 * The release change-event store (task 12, `docs/tasks/12-release-model.md`). Three sources, merged
 * into one `CHANGES` array:
 *  - `HAND_WRITTEN_CHANGES` below — syntax and behaviour changes that don't fit the dictionary's or
 *    object model's own per-entry lifetime fields, found via `scripts/rrf-triage.mjs` (see
 *    `docs/tasks/12-release-model.md`'s Findings for `3.6.3..3.7.0-rc.1` and
 *    `docs/rrf-triage/3.7.0-rc.1..3.7.0-rc.2.md` for the rc.2 pass, both fully closed).
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
import { OBJECT_MODEL_VERSIONS } from "../objectmodel/versions.js";
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
		// Originally targeted `{ type: "behaviour", code: "M955" }` (no letter) - retargeted at P
		// specifically so this shares a `targetKey` with "m955-p-uncapped" below, the event that
		// SUPERSEDES this one at 3.7.0-rc.1+1. Without a shared target, `impact.ts`'s
		// `collapseSuperseded` can't recognise these as the same evolving fact, and a query spanning
		// both versions would wrongly warn about P being capped even when the destination version has
		// already uncapped it again - the exact scenario this event pair exists to get right.
		id: "m955-single-accelerometer",
		version: "3.7.0-rc.1",
		kind: "changed",
		target: { type: "parameter", code: "M955", letter: "P" },
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

	// --- found by the 3.7.0-rc.1..3.7.0-rc.2 triage (docs/rrf-triage/3.7.0-rc.1..3.7.0-rc.2.md) ---
	// Versions are the Version.h string in the commit's own tree: "3.7.0-rc.1+N" is a dev build between the two
	// tags (never a tag - task 12's Traps), "3.7.0-rc.2" the tag that first contains the change. Where a change
	// is about a parameter a line does NOT give, the target says whenAbsent (impact.ts matches the command).
	{
		id: "m955-p-required",
		version: "3.7.0-rc.1+1",
		kind: "changed",
		target: { type: "parameter", code: "M955", letter: "P", whenAbsent: "upgrade" },
		description: "M955 must now give P, the accelerometer number (0 to 9; only 0 on a board without CAN expansion). Before, an omitted P meant accelerometer 0 - the case that keeps working only if you add P0.",
		sources: [
			"RRF commit ee3c80b6b2 \"Support configuring multiple accelerometers\" (Version.h 3.7.0-rc.1+1): gb.MustSee('P')",
			"RRF 3.7.0-rc.2 Accelerometers/Accelerometers.cpp:371-372 Accelerometers::ConfigureAccelerometer",
			"RRF 3.7.0-rc.1 Accelerometers/Accelerometers.cpp:275-276 gb.Seen('P') ? ... : 0",
			"wiki Gcodes.md M955 \"Pnn Accelerometer to use (required, ...)\" (docs/wiki-discrepancies.md: the wiki lists it required from 3.7.0-rc.1, source made it so at rc.1+1)",
		],
	},
	{
		id: "m956-p-required",
		version: "3.7.0-rc.1+1",
		kind: "changed",
		target: { type: "parameter", code: "M956", letter: "P", whenAbsent: "upgrade" },
		description: "M956 must now give P, the accelerometer number M955 configured it under (0 to 9). Before, an omitted P meant accelerometer 0 - the case that keeps working only if you add P0.",
		sources: [
			"RRF commit ee3c80b6b2 \"Support configuring multiple accelerometers\" (Version.h 3.7.0-rc.1+1): gb.MustSee('P')",
			"RRF 3.7.0-rc.2 Accelerometers/Accelerometers.cpp:551-552 Accelerometers::StartAccelerometer",
			"RRF 3.7.0-rc.1 Accelerometers/Accelerometers.cpp:418-419 gb.Seen('P') ? ... : 0",
		],
	},
	{
		id: "m201-t-warnings",
		version: "3.7.0-rc.1+3",
		kind: "changed",
		target: { type: "parameter", code: "M201", letter: "T" },
		description: "M201 T (acceleration time for third-order, S-curve motion) now warns when it cannot take effect: on a board built without third-order motion (only Duet 3 MB6HC builds have it) and when any drive is a CAN-connected driver, as well as when phase stepping is off. Before, an unsupported board ignored T without a word.",
		sources: [
			"RRF commit b9302c13c4 \"Added warnings when M201 T cannot take effect\" (Version.h 3.7.0-rc.1+3)",
			"RRF 3.7.0-rc.2 GCodes2.cpp:2658-2678 (the warnings), Config/Pins_Duet3_MB6HC.h:28 SUPPORT_3RD_ORDER 1, Movement/Move2.cpp AnyDriveHasRemoteDriver",
			"wiki Gcodes.md M201 \"Tn.nn ... (Duet 3 MB6HC only, firmware 3.7 and later)\"",
		],
	},
	{
		id: "m569-c-more-chopconf-bits",
		version: "3.7.0-rc.1+3",
		kind: "changed",
		target: { type: "parameter", code: "M569", letter: "C" },
		description: "M569 C (chopper control register) now applies the TPFD, FD3 and DISFDCC bits on TMC2240 and TMC51xx drivers (Duet 3 MB6HC, EXP3HC, ...); before only TBL, HSTRT, HEND and TOFF took effect and the other bits were silently dropped. M569's report shows the register as 6 hex digits, not 5.",
		sources: [
			"RRF commit 816bc61f \"Allow additional CHOPCONF bits to be set by user\" (Version.h 3.7.0-rc.1+3)",
			"RRF 3.7.0-rc.2 Movement/StepperDrivers/TMC22xx.cpp:395-399,1445-1465; Movement/StepperDrivers/TMC51xx.cpp:316-318,889-905",
			"RRF commit 173ff570ba \"Increased display of chopper control reg to 6 hex digits\": Movement/Move2.cpp:1355 ccr 0x%06",
		],
	},
	...(["M970", "M970.1", "M970.2", "M970.3"] as const).map((code): ChangeEvent => ({
		id: `${code.toLowerCase().replace(".", "-")}-can-expansion-boards`,
		version: "3.7.0-rc.1+3",
		kind: "changed",
		target: { type: "command", code },
		description: `${code} (phase stepping) is now also accepted on CAN-expansion-capable main boards without local phase stepping (Duet 3 MB6HC/MB6XD builds that lack it): it configures their CAN-connected drivers, and answers \"Local drivers on this board do not support phase stepping\" for the board's own. Before, such a board did not have the command at all.`,
		sources: [
			"RRF commit 97d45a32c7 \"Extended phase stepping support over CAN\" (Version.h 3.7.0-rc.1+3)",
			"RRF 3.7.0-rc.2 GCodes2.cpp:748-750,4715-4719 (# if SUPPORT_PHASE_STEPPING || SUPPORT_CAN_EXPANSION); GCodes3.cpp:855,892 GCodes::ConfigureStepMode; Movement/Move.cpp:2458-2523,2469 Move::SetStepMode",
			"RRF 3.7.0-rc.1 GCodes2.cpp # if SUPPORT_PHASE_STEPPING (alone) around case 970",
		],
	})),
	{
		id: "m303-f-default",
		version: "3.7.0-rc.1+2",
		kind: "changed",
		target: { type: "parameter", code: "M303", letter: "F", whenAbsent: true },
		description: "M303 without F now runs the tune with the cooling fan at 0.8 PWM instead of 0.7 (\"to get more accurate results across the PWM range\"), so a tune repeated on rc.2 with the same command can land on different PID values.",
		sources: [
			"RRF commit 3abb0563 \"Increased default fan PWM for heater tuning to 0.8\" (Version.h 3.7.0-rc.1+2)",
			"RRF 3.7.0-rc.2 Heating/Heater.h:189 DefaultTuningFanPwm = 0.8; Heating/Heater.cpp:317",
		],
	},
	{
		id: "m959-expansion-enforces-timeout",
		version: "3.7.0-rc.1+3",
		kind: "changed",
		target: { type: "behaviour", code: "M959", description: "the expansion board itself now switches its heaters off when it loses time sync for longer than the timeout" },
		description: "M959's connection timeout is now enforced by the expansion board: once it has had time sync and lost it for longer than the timeout (10 s unless M959 says otherwise) it switches all its heaters off and re-announces itself as a reconnect, and the main board keeps a new M959 T value only if the board accepted it.",
		sources: [
			"RRF commit 1615410dd9 \"Added M959 connection timeout support in expansion mode (#858)\" (Version.h 3.7.0-rc.1+3)",
			"RRF 3.7.0-rc.2 CAN/CanInterface.cpp:449-511 UpdateSyncLockState, ProcessM959; CAN/ExpansionManager.cpp:588-601; CAN/ExpansionManager.h:24-25",
			"RRF 3.7.0-rc.1 CAN/ExpansionManager.cpp:605-635 - the main board recorded the value and sent the message without waiting for the board's answer",
		],
	},
	{
		id: "m309-extrusion-feedforward-reworked",
		version: "3.7.0-rc.2",
		kind: "changed",
		target: { type: "behaviour", code: "M309", description: "extrusion feedforward reworked: dropped on non-printing extruder moves, PWM-fault check allows for it, remote fan feedforward fixed" },
		description: "Heater feedforward (M309 S/T) behaves differently: the extrusion boost is taken back on non-printing extruder moves, the heater PWM-too-high fault check now allows for the boost feedforward can add, and fan feedforward to remote heaters is fixed. A config tuned against rc.1 (or against a fault it worked around) may need its S/T values looked at again.",
		sources: [
			"RRF commits 52a883cc22 (Version.h 3.7.0-rc.1+2), 24d2587157, e7e485eab3, 21d60076d9 (3.7.0-rc.2)",
			"RRF 3.7.0-rc.2 Heating/LocalHeater.cpp:479,509,667-690 (expectedActualPwm/expectedMaxPwm, ApplyExtrusionFeedForward); Heating/Heater.h:171-172; Fans/FansManager.cpp:200-204",
		],
	},
	{
		id: "m581-1-string-literal-hang",
		version: "3.7.0-rc.1+3",
		kind: "changed",
		target: { type: "behaviour", code: "M581.1", description: "a trigger condition containing a string literal no longer hangs RRF" },
		description: "An M581.1 trigger whose condition contains a string literal (for example a comparison against \"printing\") hung RRF when it was evaluated (a heap lock taken twice); from 3.7.0-rc.1+3 it evaluates normally. On an older firmware such a trigger must not be used.",
		sources: [
			"RRF commit 59a04159b5 \"Fixed M581.1 triggers hanging when the expression contains a string literal\" (Version.h 3.7.0-rc.1+3)",
			"RRF 3.7.0-rc.2 GCodes/TriggerItem.cpp:335-345 TriggerItem::EvaluateExpression",
		],
	},
	{
		id: "m669-five-bar-own-kinematics-type",
		version: "3.7.0-rc.1+3",
		kind: "changed",
		target: { type: "behaviour", code: "M669", description: "five-bar SCARA (K5) now has its own kinematics type; M669 K5 with no geometry reports it" },
		description: "Five-bar SCARA (M669 K5) is now a kinematics type of its own. Before, it was recorded as SCARA (K4): a repeated M669 K5 rebuilt it from scratch every time, M669 K4 could not switch away from it, and M669 K5 with no geometry parameters failed with a missing-parameter error instead of reporting the configuration.",
		sources: [
			"RRF commit 5decc372 \"Fixed M669 reporting for SCARA and five-bar SCARA kinematics (#1290)\" (Version.h 3.7.0-rc.1+3)",
			"RRF 3.7.0-rc.2 Movement/Kinematics/FiveBarScaraKinematics.cpp:44,545-566; Movement/Move.cpp:941-950 Move::SetKinematics; GCodes2.cpp:4181-4220 case 669",
			"RRF 3.7.0-rc.1 Movement/Kinematics/FiveBarScaraKinematics.cpp:44 ZLeadscrewKinematics(KinematicsType::scara, ...)",
		],
	},
	{
		id: "om-type-boards-drivers-config-direction",
		version: "3.7.0-rc.1+2",
		kind: "changed",
		target: { type: "objectModelPath", path: "boards[].drivers[].config.direction" },
		description: "boards[].drivers[].config.direction is now a boolean (true = forwards) instead of the integer 0/1, so an expression comparing it with a number (== 1) no longer means what it did.",
		sources: [
			"RRF commit b131e9f96f \"Changed type of OM field boards[].drivers[].direction to bool\" (Version.h 3.7.0-rc.1+2)",
			"RRF 3.7.0-rc.2 Movement/Move.cpp:332; Movement/StepperDrivers/DriverData.cpp:38",
		],
	},
	{
		id: "om-value-move-extruders-percentcurrent",
		version: "3.7.0-rc.1+2",
		kind: "changed",
		target: { type: "objectModelPath", path: "move.extruders[].percentCurrent" },
		description: "move.extruders[].percentCurrent read the motor current of the axis with the same number as the extruder (extruder 0 gave X's) instead of the extruder's own driver; it now reports the extruder's, so a macro that read it has been getting the wrong value.",
		sources: [
			"RRF commit 59c63a66eb \"Fixed OM move.extruders[].percentCurrent and percentStstCurrent\" (Version.h 3.7.0-rc.1+2)",
			"RRF 3.7.0-rc.2 Movement/Move.cpp:297; RRF 3.7.0-rc.1 the same line indexed GetMotorCurrent with context.GetLastIndex()",
		],
	},
	{
		id: "om-value-move-extruders-percentststcurrent",
		version: "3.7.0-rc.1+2",
		kind: "changed",
		target: { type: "objectModelPath", path: "move.extruders[].percentStstCurrent" },
		description: "move.extruders[].percentStstCurrent read the standstill current of the axis with the same number as the extruder instead of the extruder's own driver; it now reports the extruder's.",
		sources: [
			"RRF commit 59c63a66eb \"Fixed OM move.extruders[].percentCurrent and percentStstCurrent\" (Version.h 3.7.0-rc.1+2)",
			"RRF 3.7.0-rc.2 Movement/Move.cpp:299",
		],
	},
	{
		id: "om-value-heat-heaters-extrpwmboost",
		version: "3.7.0-rc.2",
		kind: "changed",
		target: { type: "objectModelPath", path: "heat.heaters[].extrPwmBoost" },
		description: "heat.heaters[].extrPwmBoost now reports the extrusion boost last applied to the heater (back to 0 on non-printing extruder moves) rather than the boost feedforward last asked for.",
		sources: [
			"RRF commit 24d2587157 \"Fixes to extrusion feedforward\" (Version.h 3.7.0-rc.2)",
			"RRF 3.7.0-rc.2 Heating/Heater.cpp:47 (lastExtrusionPwmBoost); RRF 3.7.0-rc.1 Heating/Heater.cpp:47 (extrusionPwmBoost)",
		],
	},
	{
		id: "fileinfo-preflight-layer-count",
		version: "3.7.0-rc.1+3",
		kind: "added",
		target: { type: "behaviour", description: "RRF reads a preFlight \"; layer_count = N\" comment in a G-code file as the layer count" },
		description: "RRF's file-info parser now reads the layer count from a preFlight slicer's \"; layer_count = 60\" comment, so job.file.numLayers is filled in for those files (no effect on a file that does not carry the comment).",
		sources: [
			"RRF commit 2867dc42 \"Added preFlight layer count to the file info parser\" (Version.h 3.7.0-rc.1+3)",
			"RRF 3.7.0-rc.2 Storage/FileInfoParser.cpp:53 parseTable \"Layer_count\"",
		],
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

/** The object-model versions this schema has data for, oldest first. */
const TRACKED_OM_VERSIONS: ReadonlyArray<string> = OBJECT_MODEL_VERSIONS.filter((v) => v.hasData).map((v) => v.version);

/** An object-model path's `until` is the LAST tracked version it exists in; it is gone from the next one, and
 *  that is the version a `removed` event belongs to - `changesBetween` selects `(from, to]`, so dating it at
 *  `until` itself would miss the very upgrade that crosses it (a file moving from `until` to the next tracked
 *  version, e.g. `3.7.0-rc.1` -> `3.7.0-rc.2` for `boards[].accelerometer`). */
function firstTrackedVersionAfter(until: string): string {
	return TRACKED_OM_VERSIONS[TRACKED_OM_VERSIONS.indexOf(until) + 1] ?? until;
}

function objectModelEvents(): Array<ChangeEvent> {
	const events: Array<ChangeEvent> = [];
	for (const entry of OBJECT_MODEL_PATHS) {
		if (entry.since !== undefined) {
			events.push({
				id: `om-${entry.path}-added`, version: entry.since, kind: "added",
				target: { type: "objectModelPath", path: entry.path },
				description: `Object-model path ${entry.path} added`, sources: [entry.source ?? "@duet3d/objectmodel (see docs/tasks/11-object-model-schema.md)"],
			});
		}
		if (entry.until !== undefined) {
			events.push({
				id: `om-${entry.path}-removed`, version: firstTrackedVersionAfter(entry.until), kind: "removed",
				target: { type: "objectModelPath", path: entry.path },
				description: entry.note === undefined ? `Object-model path ${entry.path} removed` : `Object-model path ${entry.path} removed - ${entry.note}`,
				sources: [entry.source ?? "@duet3d/objectmodel (see docs/tasks/11-object-model-schema.md)"],
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
