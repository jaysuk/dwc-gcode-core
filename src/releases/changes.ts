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
import { RELEASES } from "./releases.js";
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
/** The description shared by the serial-channel renumbering events (`m575-p-channel-numbering`, `aux-port-numbering-*`). */
const AUX_PORT_NUMBERING = (what: string): string =>
	`${what} numbers serial channels differently on a Duet 3 main board from 3.7.0-alpha.2, which gains a second USB CDC channel: ` +
	"P0 is the first USB channel, P1 the SECOND USB channel, P2 the first auxiliary UART (where a PanelDue usually sits) and P3 the second; " +
	"3.6.3 and earlier numbered P1 as the first auxiliary UART and P2 as the second. A line written for one numbering configures or talks to " +
	"the wrong port under the other (for example M575 P1 B57600 S1 would set up USB2 instead of the PanelDue port). A Duet 2 has one USB " +
	"channel and keeps the old numbering.";

const AUX_PORT_SOURCES: ReadonlyArray<string> = [
	"RRF commit f6da176a1 \"Added support for second USB CDC channel\" (3.7.0-alpha.2), with b9cbdaf8c, 6a2a93812 (3.7.0-alpha.2) and d7a85d4c9 (3.7.0-alpha.4) for the follow-up fixes",
	"RRF 3.6.3 Config/Pins_Duet3_MB6HC.h:117-119 (FirstAuxChannel = 1); RRF 3.7.0-rc.2 Config/Pins.h:46 (FirstAuxChannel = NumUsbChannels), Config/Pins_Duet3_MB6HC.h:131-142 (NumUsbChannels = 2 under CORE_USES_TINYUSB), Platform/Platform.cpp:2268-2271 HandleM575 (chan = P), :2567 (P - FirstAuxChannel)",
	"wiki User_manual/Reference/Gcodes.md M575 \"P parameter (RRF 3.7 and later)\", and the \"numbered as in M575\" note on M260.1-M261.2",
];

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
		version: "3.7.0-beta.2+1",
		kind: "changed",
		target: { type: "parameter", code: "M116", letter: "P" },
		description: "M116's P may be a colon-separated tool list; bare P waits for every tool.",
		sources: [
			"RRF commits 4be2861c3 \"Implemented #1240\" and bfbe44c16 \"Changed implementation of #1240 again\" (the first build that has them is 3.7.0-beta.2+1; the wiki says beta.3, the source decides)",
			"RRF 3.7.0-rc.2 GCodes/GCodes2.cpp:2009-2034 case 116 - gb.GetUnsignedArray(toolNumbers, toolCount, false); an empty list walks Tool::GetToolList()",
			"RRF 3.6.3 GCodes/GCodes2.cpp case 116 - Tool::GetLockedTool(gb.GetIValue()), one tool",
		],
	},
	{
		id: "m116-bare-waits-for-all-tools",
		version: "3.7.0-beta.2+1",
		kind: "changed",
		target: { type: "parameter", code: "M116", letter: "P", whenAbsent: true, alsoAbsent: ["H", "C"] },
		description: "A bare M116 waited for the heaters of the tool this motion system had selected (plus the bed and chambers). It now waits for every tool in the tool list, except one another motion system has selected, plus the bed and chambers. A start.g or tool-change macro that sets a standby or inactive tool's temperature and then runs a bare M116 can therefore wait much longer, or for ever if a tool's heater cannot reach its set temperature. Use M116 P<tool> to wait for one tool only.",
		sources: [
			"RRF commit 4be2861c3 \"Implemented #1240\" (3.7.0-beta.2+1)",
			"RRF 3.7.0-rc.2 GCodes/GCodes2.cpp:2102-2135 case 116 - if (!seen) loops Tool::GetToolList(), skipping a tool another motion system has current, then SlowHeatersAtSetTemperatures",
			"RRF 3.6.3 GCodes/GCodes2.cpp:2056-2059 case 116 - if (!seen && (!ToolHeatersAtSetTemperatures(GetMovementState(gb).GetLockedCurrentTool().Ptr(), ...) || !SlowHeatersAtSetTemperatures(...)))",
		],
	},
	{
		// Was pinned to a conservative "3.7.0-rc.1" ("the commit lands somewhere between 3.6.3 and
		// 3.7.0-rc.1... not dated to an exact intermediate beta" - firmware.ts's own former comment).
		// Task 12's triage now pins it exactly: `git describe --tags --contains 6aadff7c19` = "3.7.0-beta.1~73".
		id: "expr-array-concat",
		version: "3.7.0-alpha.4",
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
	// Versions follow the pin rule in releases.ts: the first tracked release whose commit contains the change
	// ("3.7.0-rc.1+N" is a dev build between the two tags, never a tag - task 12's Traps; "3.7.0-rc.2" the tag that
	// first contains a change made after the +3 bump). scripts/audit-releases.mjs --events checks it. Where a change
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
		version: "3.7.0-rc.2",
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
		version: "3.7.0-rc.2",
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
		version: "3.7.0-rc.2",
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
		version: "3.7.0-rc.1+3",
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
		version: "3.7.0-rc.2",
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
		version: "3.7.0-rc.2",
		kind: "changed",
		target: { type: "behaviour", code: "M581.1", description: "a trigger condition containing a string literal no longer hangs RRF" },
		description: "An M581.1 trigger whose condition contains a string literal (for example a comparison against \"printing\") hung RRF when it was evaluated (a heap lock taken twice); from 3.7.0-rc.2 it evaluates normally. On an older firmware such a trigger must not be used.",
		sources: [
			"RRF commit 59a04159b5 \"Fixed M581.1 triggers hanging when the expression contains a string literal\" (Version.h 3.7.0-rc.1+3)",
			"RRF 3.7.0-rc.2 GCodes/TriggerItem.cpp:335-345 TriggerItem::EvaluateExpression",
		],
	},
	{
		id: "m669-five-bar-own-kinematics-type",
		version: "3.7.0-rc.2",
		kind: "changed",
		target: { type: "parameter", code: "M669", letter: "K", whenValue: ["9"] },
		description: "Five-bar SCARA (M669 K9) is now a kinematics type of its own. Before, it was recorded as SCARA (K4): a repeated M669 K9 rebuilt it from scratch every time, M669 K4 could not switch away from it, and M669 K9 with no geometry parameters (a bare report, or only S/T to set segmentation) failed with a missing-parameter error instead of reporting the configuration or applying S/T.",
		sources: [
			"RRF commit 5decc372 \"Fixed M669 reporting for SCARA and five-bar SCARA kinematics (#1290)\" (Version.h 3.7.0-rc.1+3)",
			"RRF 3.7.0-rc.2 Movement/Kinematics/FiveBarScaraKinematics.cpp:44,545-566; Movement/Move.cpp:941-950 Move::SetKinematics; GCodes2.cpp:4181-4220 case 669",
			"RRF 3.7.0-rc.1 Movement/Kinematics/FiveBarScaraKinematics.cpp:44 ZLeadscrewKinematics(KinematicsType::scara, ...)",
		],
	},
	{
		id: "m669-five-bar-d-two-values",
		version: "3.7.0-rc.2",
		kind: "changed",
		target: { type: "parameter", code: "M669", letter: "D", whenCompanion: { letter: "K", values: ["9"] }, whenElements: [2] },
		description: "On the five-bar SCARA (M669 K9) the distal arm lengths D may be given as two values (left:right, no cantilevers) as well as four. 3.6.3 read D with TryGetFloatArray('D', 4), so a two-value D failed with \"Wrong number of values in array, expected 4\" and the geometry was not applied.",
		sources: [
			"RRF commit 5decc3728 \"Fixed M669 reporting for SCARA and five-bar SCARA kinematics (#1290)\" (and its 3.6-dev twin cb5dab5b3), first contained by 3.7.0-rc.2",
			"RRF 3.7.0-rc.2 Movement/Kinematics/FiveBarScaraKinematics.cpp:607-621 FiveBarScaraKinematics::Configure - GetFloatArray(distalLengths, numDistalLengths, false), accepts 2 or 4",
			"RRF 3.6.3 Movement/Kinematics/FiveBarScaraKinematics.cpp - TryGetFloatArray('D', 4, ...); GCodeBuffer.cpp TryGetFloatArray throws on a count other than the one asked for; the source's own TODO says it should allow 2 or 4",
		],
	},
	{
		id: "m569-4-hangprinter-t-per-driver",
		version: "3.7.0-beta.2",
		kind: "changed",
		target: { type: "parameter", code: "M569.4", letter: "T", whenElements: [2, 3, 4, 5, 6, 7, 8] },
		description: "On a Hangprinter, M569.4 (ODrive torque mode) takes one force per motor: P is a list of the drivers and T a list of the same length, e.g. M569.4 P40.0:41.0:42.0:43.0 T0.2:0.2:0.2:0.2, and a count that does not match is \"M569.4 requires one T value per P\". 3.6.3 read a single T value for the one driver in P, so a T list is rejected there.",
		sources: [
			"RRF commit 7253bc518 \"Allows one force/torque per motor in Hangprinter's M569.4\" (first contained by 3.7.0-beta.2)",
			"RRF 3.7.0-rc.2 CAN/CanInterface.cpp:1184-1213 CanInterface::ConfigureRemoteDriver, case 4 - gb.MustSee('P'); GetDriverIdArray; GetFloatArray(forces, forceCount, true); forceCount must equal the driver count",
			"RRF 3.6.3 CAN/CanInterface.cpp:1075-1077 case 4 - gb.MustSee('T'); const float torque = gb.GetFValue()",
		],
	},
	{
		id: "m669-hangprinter-anchor-count-8",
		version: "3.7.0-beta.2",
		kind: "added",
		target: { type: "parameter", code: "M669", letter: "N", whenValue: ["6", "7", "8"] },
		description: "A Hangprinter (M669 K6) may have 6, 7 or 8 anchors from 3.7.0-beta.2: the sixth to eighth are addressed with J, L and O, and the ODrive CAN boards for them may sit at addresses 40-49 (the limit was 43). Up to beta.1 the firmware held 5 anchors and does not range-check N, so on 3.6.3 an N above 5 reads and writes past its arrays.",
		sources: [
			"RRF commit 02473d7bf \"Updates Hangprinter support\" (first contained by 3.7.0-beta.2)",
			"RRF 3.7.0-beta.2 Movement/Kinematics/HangprinterKinematics.h:22,76 HANGPRINTER_MAX_ANCHORS = 8, ANCHOR_CHARS = \"ABCDIJLO\"; HangprinterKinematics.cpp:211-219 case 669, ODrive board range \"Board address not between 40 and 49\"",
			"RRF 3.6.3 Movement/Kinematics/HangprinterKinematics.h:69-70 ANCHOR_CHARS = \"ABCDIJKLO\", HANGPRINTER_MAX_ANCHORS = 5",
		],
	},
	{
		id: "m666-hangprinter-flex-opt-in",
		version: "3.7.0-beta.2",
		kind: "changed",
		target: { type: "parameter", code: "M666", letter: "W" },
		description: "On a Hangprinter, line-flex compensation is now off until M666 F1 (quadratic programme) or F2 (Tikhonov) turns it on; setting the mover weight W (the line this is matched on - a delta's M666 has no W) no longer does it. Up to beta.1 flex compensation ran by itself whenever the anchor mode was LastOnTop (the default) with 4 or 5 anchors and W was above 0.0001 kg. The default anchor mode is now None and an unset guy-wire length is 0 instead of being derived from the last anchor. So a config that sets only W has flex compensation on 3.6.3 and none from beta.2 until F is added (3.6.3 ignores F).",
		sources: [
			"RRF commit 02473d7bf \"Updates Hangprinter support\" (first contained by 3.7.0-beta.2)",
			"RRF 3.7.0-beta.2 Movement/Kinematics/HangprinterKinematics.cpp:268-300 case 666 (F sets flexEnabled/flexAlgorithm), :394 CartesianToMotorSteps if (flexEnabled); HangprinterKinematics.h:87,111-114 defaults",
			"RRF 3.6.3 Movement/Kinematics/HangprinterKinematics.cpp:1277-1296 StaticForces (anchorMode LastOnTop, 4 or 5 anchors) and :1306 StaticForcesQuadrilateralPyramid (returns when moverWeight_kg < 0.0001)",
		],
	},
	{
		id: "m666-hangprinter-f-flex-algorithm-added",
		version: "3.7.0-beta.2",
		kind: "added",
		target: { type: "parameter", code: "M666", letter: "F" },
		description: "M666 F (Hangprinter flex compensation: 0 off, 1 quadratic programme, 2 Tikhonov; any other value is \"Unknown flex algorithm\") is new in 3.7.0-beta.2. A 3.6.3 firmware ignores it. (M666 B and P also gained a Hangprinter meaning, ignore-gravity and ignore-pretension, but a delta's M666 B is the Y tilt, so only F and P are matched on the letter.)",
		sources: [
			"RRF commit 02473d7bf \"Updates Hangprinter support\" (first contained by 3.7.0-beta.2)",
			"RRF 3.7.0-rc.2 Movement/Kinematics/HangprinterKinematics.cpp:268-300 case 666 - gb.TryGetIValue('F', flexCommand, seenFlexParam); no F in the 3.6.3 handler",
		],
	},
	{
		id: "m666-hangprinter-p-ignore-pretension-added",
		version: "3.7.0-beta.2",
		kind: "added",
		target: { type: "parameter", code: "M666", letter: "P" },
		description: "M666 P (Hangprinter: ignore the line pretension when planning the flex forces, 0 or 1) is new in 3.7.0-beta.2. A 3.6.3 firmware ignores it.",
		sources: [
			"RRF commit 02473d7bf \"Updates Hangprinter support\" (first contained by 3.7.0-beta.2)",
			"RRF 3.7.0-rc.2 Movement/Kinematics/HangprinterKinematics.cpp:301 case 666 - gb.TryGetBValue('P', ignorePretension, geometryParamSeen); no P in the 3.6.3 handler",
		],
	},
	{
		id: "m141-chamber-heater-own-defaults",
		version: "3.7.0-alpha.2",
		kind: "changed",
		target: { type: "parameter", code: "M141", letter: "H" },
		description: "A heater assigned as a chamber heater (M141 H) now gets chamber defaults of its own, where 3.6.3 gave it the bed's. Until M143 S, M307 or an M303 tune say otherwise, its over-temperature limit is 100 C (the bed's was 125 C, so a chamber setpoint above 100 C without its own M143 limit now raises a heater fault) and its default model has a dead time of 30 s (the bed's 10 s), which is also what heat.heaters[].model.deadTime reports. The fault-detection rise factor (0.3) is unchanged.",
		sources: [
			"RRF commit a0fe960b7 \"Changes to some heater-related CAN messages to support custom heaters\" (first contained by 3.7.0-alpha.2): Heater::SetAsChamberHeater, HeaterFunction",
			"RRF 3.7.0-rc.2 Heating/Heater.cpp:663-687 Heater::SetFunction (DefaultChamberTemperatureLimit, SetDefaultModel); Heating/Heat.cpp:719-731 Heat::SetChamberHeaters; CANlib 3.7.0-rc.2 src/RRF3Common.h:77 DefaultChamberTemperatureLimit = 100.0, src/HeaterModel.h:73-85 DefaultChamberHeaterModel (deadTime 30.0)",
			"RRF 3.6.3 Heating/Heater.cpp:677-688 Heater::SetAsBedOrChamberHeater (DefaultBedTemperatureLimit, SetDefaultBedOrChamberParameters); CANlib 3.6.3 src/RRF3Common.h:69,83-86 (bed limit 125.0, bed model dead time 10.0, \"For the chamber heater, we use the same values as for the bed heater\")",
		],
	},
	{
		id: "om-inputs-state-unused",
		version: "3.7.0-alpha.2",
		kind: "changed",
		target: { type: "objectModelPath", path: "inputs[].state" },
		description: "inputs[].state is now \"unused\" for an input channel that has never been given a command, where 3.6.3 reported \"idle\" for every channel at rest: the G-code buffers are allocated on first use. A condition such as inputs[n].state == \"idle\" on a channel that has not run anything yet (a daemon or auxiliary channel, say) is false until it has. M122 says \"is unused\" for the same channels.",
		sources: [
			"RRF commit d4eb8a563 \"Fixed more stuff that git merge f***ed up\" (the dynamic G-code buffer allocation of 3.7-dev, merged back in), first contained by 3.7.0-alpha.2",
			"RRF 3.7.0-rc.2 GCodes/GCodeBuffer/GCodeBuffer.cpp:77,94 GCodeBuffer::GetStateText - return (buffer != nullptr) ? \"idle\" : \"unused\"; StringParser.cpp:93-95 allocates the buffer in Put",
			"RRF 3.6.3 GCodes/GCodeBuffer/GCodeBuffer.cpp:94 GetStateText - case parseNotStarted: return \"idle\" (GCodeBuffer.h: buffer is a fixed char[MaxGCodeLength] there, never unallocated)",
		],
	},
	{
		id: "om-boards-firmware-date-includes-time",
		version: "3.7.0-beta.2",
		kind: "changed",
		target: { type: "objectModelPath", path: "boards[].firmwareDate" },
		description: "boards[0].firmwareDate (the main board) is now the build date AND time (an ISO date followed by the time) where 3.6.3 and earlier betas reported the date alone, so a macro that compares it with a bare date, or cuts it to a fixed width, sees a different string. Expansion boards report whatever their own firmware sends and are not changed by this. M115's FIRMWARE_DATE already carried the time and is unchanged.",
		sources: [
			"RRF commit 684e8e097 \"Include time in firmware date for boards[0] in object model\" (3.7.0-beta.2)",
			"RRF 3.7.0-beta.2 Platform/Platform.cpp:224 - { \"firmwareDate\", OBJECT_MODEL_FUNC_NOSELF(DateTimeText) }; Version.cpp:12 DateTimeText = IsoDateTime",
			"RRF 3.6.3 Platform/Platform.cpp:220 - { \"firmwareDate\", OBJECT_MODEL_FUNC_NOSELF(DateText) }",
		],
	},
	{
		id: "om-type-boards-drivers-config-direction",
		version: "3.7.0-rc.1+3",
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
		version: "3.7.0-rc.1+3",
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
		version: "3.7.0-rc.1+3",
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
		version: "3.7.0-rc.2",
		kind: "added",
		target: { type: "behaviour", description: "RRF reads a preFlight \"; layer_count = N\" comment in a G-code file as the layer count" },
		description: "RRF's file-info parser now reads the layer count from a preFlight slicer's \"; layer_count = 60\" comment, so job.file.numLayers is filled in for those files (no effect on a file that does not carry the comment).",
		sources: [
			"RRF commit 2867dc42 \"Added preFlight layer count to the file info parser\" (Version.h 3.7.0-rc.1+3)",
			"RRF 3.7.0-rc.2 Storage/FileInfoParser.cpp:53 parseTable \"Layer_count\"",
		],
	},

	// Found by FIRMWARE-CHANGES-PLAN.md D3 step 2 (a second look at the items the range documents closed only by a section note).
	// Not detectable: whether a move leaves the M208 limits depends on coordinates, not on any command or letter.
	{
		id: "axis-limit-absolute-moves-error",
		version: "3.7.0-alpha.2",
		kind: "changed",
		target: { type: "behaviour", description: "a G0/G1 whose absolute target is outside the M208 axis limits (M564 S1, the default) is an error on a 3D printer too, not silently clamped" },
		description: "With axis limits on (M564 S1, the default) a G0/G1 to an absolute position outside the M208 limits of a homed axis now raises \"target position outside machine limits\" and abandons the move on every machine type; RRF 3.6.3 clamped it silently on a 3D printer (only CNC and laser machines errored). The same release aborts a job when an intermediate point of a segmented move is outside the limits (3.6.3 only did that for CNC and laser). Relative moves (G91) were errors too from 3.7.0-alpha.2 to beta.1, then 3.7.0-beta.2 went back to clamping them, and M564 R0 (3.7.0-beta.2+1) turns the clamping off so they error as well. A macro or slicer start code that used to be clamped past an axis limit now raises the error instead.",
		sources: [
			"RRF commits 4b9e720cd \"Abort print in FFF mode like in CNC mode if position is unreachable (#1188)\" (3.7.0-alpha.2), 73f3ba5e2 \"Changed axis jog behaviour\" and a240ba1f0 \"Reintroduced move aborts on axis limit violations\" (3.7.0-beta.2), 7e74287b6 \"Added M564 R parameter for relative move clamping\" (3.7.0-beta.2+1)",
			"RRF 3.6.3 GCodes/GCodes.cpp:2535-2541 DoStraightMove (machineType != fff guard); RRF 3.7.0-rc.2 GCodes/GCodes.cpp:2656-2662 (!axesRelative || !limitAxesRelative), GCodes/GCodes4.cpp RunStateMachine segmentedMoveState",
		],
	},

	{
		id: "m574-k-range-checked",
		version: "3.7.0-rc.1",
		kind: "changed",
		target: { type: "parameter", code: "M574", letter: "K" },
		description: "M574 K (the Z probe number for an S3 endstop) is now range-checked against the board's number of Z probe slots (MaxZProbes) on any M574 line that gives it. RRF 3.6.3 read K without a limit and only for S3, so a K beyond the last probe created an endstop on a probe that does not exist; from 3.7.0-rc.1 the line is rejected with a bad-value error.",
		sources: [
			"RRF commit c224eea5f \"Fixed M574 K parameter not being range checked (#1275)\" (3.7.0-rc.1)",
			"RRF 3.6.3 Endstops/EndstopsManager.cpp:452 (gb.GetUIValue, inside case zProbeAsEndstop); RRF 3.7.0-rc.2 Endstops/EndstopsManager.cpp HandleM574 (gb.GetLimitedUIValue('K', MaxZProbes), read before the P/axis handling)",
		],
	},
	// The four events below are about one accepted VALUE of a parameter that keeps existing, so each target carries
	// `whenValue` (impact.ts matches only a line that gives exactly that literal). Before this the catalogue knew
	// `M558 P3` had gone (M558's P description says so) but no event said it, so a scan never flagged the line.
	{
		id: "m558-p3-removed",
		version: "3.7.0-rc.1",
		kind: "removed",
		target: { type: "parameter", code: "M558", letter: "P", whenValue: ["3"] },
		description: "M558 P3 (the \"alternate analog\" Z probe type) is no longer supported: the line is rejected with \"Invalid Z probe type 3\", like the other obsolete types 4, 6 and 7. RRF 3.6.3 accepted it and created the probe. Use one of the remaining types (P1 analog, P5/P8 switch, P9 BLTouch, ...).",
		sources: [
			"RRF commit b28569a1d \"Removed support for ZProbe type 3, see issue #1271\" (3.7.0-rc.1)",
			"RRF 3.6.3 Endstops/EndstopsManager.cpp:619-627 (only types 4, 6 and 7 rejected) vs RRF 3.7.0-rc.2 Endstops/EndstopsManager.cpp:724-733 (HandleM558: alternateAnalog_obsolete added to the rejected list); Endstops/EndstopDefs.h ZProbeType 3 renamed alternateAnalog_obsolete",
		],
	},
	{
		id: "m558-p12-load-cell",
		version: "3.7.0-beta.3",
		kind: "added",
		target: { type: "parameter", code: "M558", letter: "P", whenValue: ["12"] },
		description: "M558 P12 creates a load cell Z probe (it triggers on the force measured when the nozzle touches the bed, and needs the V scale in grams per count). RRF 3.6.3 has no probe type 12 and rejects the line.",
		sources: [
			"RRF commit 91dbd13b4 \"Added load cell Z probe support\" (3.7.0-beta.3)",
			"RRF 3.6.3 Endstops/EndstopDefs.h ZProbeType::numTypes = 12 vs RRF 3.7.0-rc.2 Endstops/EndstopDefs.h loadCell = 12, numTypes = 13",
		],
	},
	{
		id: "m574-s5-encoder-endstop",
		version: "3.7.0-rc.1",
		kind: "added",
		target: { type: "parameter", code: "M574", letter: "S", whenValue: ["5"] },
		description: "M574 S5 homes an axis against the encoder of a driver on a CAN-connected board (it triggers when the motor falls behind the commanded position by the first value of the M569.1 E parameter) instead of against StallGuard. RRF 3.6.3 has no endstop type 5 and rejects the line.",
		sources: [
			"RRF commit da53463f2 \"Added M574 S5 encoder stall endstop support\" (3.7.0-rc.1)",
			"wiki-content User_manual/Reference/Gcodes.md M574 (endstop type S5, \"after 3.7.0-beta.3\")",
		],
	},
	{
		id: "m308-bme68x-added",
		version: "3.7.0-alpha.3",
		kind: "added",
		target: { type: "parameter", code: "M308", letter: "Y", whenValue: ["bme68x"] },
		description: "M308 Y\"bme68x\" configures a BME680/688/690 environmental sensor over SPI (temperature, plus pressure, humidity and gas outputs as additional sensors). It exists only on boards built with SUPPORT_BME68X (Duet 3 MB6HC, MB6XD and Mini 5+); RRF 3.6.3 has no such sensor type and rejects the line.",
		sources: [
			"RRF commit 36fb7830b \"Added support for BME680/688/690\" (2026-03-10; in the tracked 3.7.0-alpha.3 build)",
			"RRF 3.7.0-rc.2 Heating/Sensors/BME68x.h TypeName \"bme68x\"; Config/Pins_Duet3_MB6HC.h SUPPORT_BME68X 1",
		],
	},
	{
		id: "g68-bare-reports-rotation",
		version: "3.7.0-beta.3",
		kind: "changed",
		target: { type: "parameter", code: "G68", letter: "R", whenAbsent: true },
		description: "A G68 with no R used to fail (R was mandatory); from 3.7.0-beta.3 it reports the current rotation (\"XY rotation N degrees centred on [x y]\") and changes nothing. A G68 that gives R behaves as before.",
		sources: [
			"RRF commit ec066efd6 \"G68 without parameters now reports the current rotation details\" (3.7.0-beta.3)",
			"RRF 3.6.3 GCodes/GCodes3.cpp HandleG68 (gb.MustSee('R')); RRF 3.7.0-rc.2 GCodes/GCodes3.cpp:1173 (reply.printf(\"XY rotation ...\") when R is not seen)",
		],
	},
	{
		id: "m569-2-bare-reports-waveform",
		version: "3.7.0-rc.1",
		kind: "changed",
		target: { type: "parameter", code: "M569.2", letter: "R", whenAbsent: true },
		description: "An M569.2 with no R used to fail (\"missing parameter 'R'\", on a CAN-connected driver \"Missing P or R parameter in CAN message\"). On a TMC51xx or TMC2240 SPI driver from 3.7.0-rc.1 a bare M569.2 P<driver> reports that driver's sine-table waveform corrections instead, and M569.2 with S sets one (S, J and O are new in rc.1, see their own events); on other drivers R is still required. A line that gives R reads or writes the register as before.",
		sources: [
			"RRF commit 6544cc727 \"Motor waveform correction and faster phase stepping\" (2026-08-21, 3.7.0-rc.1): Move2.cpp ConfigureLocalDriver fraction 2 (\"if (!gb.Seen('R')) { reply.printf(\"Driver %u waveform correction:\" ...\")",
			"Duet3Expansion 3.7.0-rc.1 CommandProcessing/CommandProcessor.cpp ProcessM569Point2 (R was required at 3.6.3: \"Missing P or R parameter in CAN message\"); CANlib 3.7.0-rc.2 CanMessageGenericTables.h M569Point2Params",
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
		id: "m140-h-colon-list",
		version: "3.7.0-alpha.3",
		kind: "changed",
		target: { type: "parameter", code: "M140", letter: "H" },
		description: "M140/M141's H parameter becomes a colon list; multiple heaters may be assigned to one bed/chamber slot. It is also checked for conflicts that 3.6.3 let through: M140 H (or M141 H) now fails with \"Heater N is already assigned to a tool\" if that heater is on a tool (M563 H), and M140 H fails if it is already a chamber heater (M141 H) - \"already assigned as a chamber heater\" - and M141 H if it is already a bed heater. A config.g that gave one heater two jobs worked in 3.6.3 and now errors on the later line.",
		sources: [
			"RRF commit 8a1738d029 \"Allow multiple heaters to be assigned to beds/chambers (#1103)\"",
			"RRF 3.7.0-rc.2 GCodes/GCodes2.cpp:2361-2373 case 140/141 - Tool::IsHeaterAssignedToTool(heaterNumbers[i]) and heat.GetHeaterFunction(heaterNumbers[i]) rejections; RRF 3.6.3 GCodes/GCodes2.cpp case 140/141 takes the heater with no such check",
		],
	},
	{
		id: "m997-s3-wifi-external-removed",
		version: "3.7.0-alpha.3",
		kind: "removed",
		target: { type: "parameter", code: "M997", letter: "S", whenValue: ["3"] },
		description: "M997 S3 (the DuetWiFi's \"external firmware\" module: reset the WiFi module into flashing mode so it can be programmed from outside, with esptool) no longer does anything. The module number is still accepted, so the line raises no error, but there is nothing behind it; WiFi firmware is updated with M997 S1.",
		sources: [
			"RRF commit e349e936d \"Refactored serial interface code\" (first contained by 3.7.0-alpha.3): WifiExternalFirmwareModule removed, \"Module 2 was WifiExternalFirmwareModule, no longer supported\"",
			"RRF 3.7.0-rc.2 Comms/FirmwareUpdater.h:14-25 (module 3 is _unused) and Comms/FirmwareUpdater.cpp:95-125 FirmwareUpdater::UpdateModule (no case for it); GCodes/GCodes3.cpp UpdateFirmware accepts any module below NumUpdateModules",
			"RRF 3.6.3 Comms/FirmwareUpdater.cpp:37-46,106-111 WifiExternalFirmwareModule = 3 -> ResetWiFiForUpload(true)",
		],
	},
	{
		id: "m586-t-tls-listener",
		version: "3.7.0-alpha.3",
		kind: "added",
		target: { type: "parameter", code: "M586", letter: "T", whenValue: ["1"] },
		description: "M586 T1 (the TLS variant of HTTP, FTP or Telnet) is accepted on a board with TLS support: the wired Ethernet interface from 3.7.0-alpha.3 (the WiFi ESP32 module follows in alpha.6, see m552-t-tristate). With T1, R is the TLS port (HTTPS 443, FTPS 990, Telnets 992 by default), the plain listener and its port stay as they were, and S0 turns both off. 3.6.3 answers every T1 with \"this firmware does not support TLS\" and does not apply the line.",
		sources: [
			"RRF commit 0f8da3b79 \"Added TLS support for SAME series using MbedTls\" (first contained by 3.7.0-alpha.3); WiFi: 4ead59f9a (3.7.0-alpha.6)",
			"RRF 3.7.0-rc.2 Networking/NetworkInterface.cpp:35-120 NetworkInterface::EnableProtocol (secure > 0 -> TLS listener on the port from R; SupportsTls() false defers); Networking/NetworkDefs.h:36-41 default TLS ports",
			"RRF 3.6.3 Networking/NetworkInterface.cpp NetworkInterface::EnableProtocol - if (secure > 0) reply.copy(\"this firmware does not support TLS\")",
		],
	},
	{
		id: "m950-led-k-honoured-for-neopixel",
		version: "3.7.0-alpha.3",
		kind: "changed",
		target: { type: "parameter", code: "M950", letter: "K", whenValue: ["0", "1", "2", "3", "4", "5"], whenCompanion: { letter: "T", values: ["1", "2"] } },
		description: "On an LED strip, M950 K (colour order, 0-5) is now read for NeoPixel strips (T1, T2) as well as DotStar ones, and defaults to GRB for NeoPixel. 3.6.3 read K only for a DotStar strip and ignored it on a NeoPixel one, so a config that carries a K on a NeoPixel line gets its colours reordered from alpha.3 (and the reverse going back). (On a spindle line K means PWM values; such a line only matches here when its K is a whole number 0-5 and its T is 1 or 2.)",
		sources: [
			"RRF commit 2830c5345 \"Implemented enhancement #1220\" (first contained by 3.7.0-alpha.3): the colour order moves from DotStarLedStrip into LocalLedStrip::CommonConfigure",
			"RRF 3.7.0-rc.2 LedStrips/LocalLedStrip.cpp:75-78 LocalLedStrip::CommonConfigure - gb.TryGetLimitedUIValue('K', order, seen, ColorOrder::count); LedStrips/LedStripBase.h:37,66-67 DefaultNeoPixelColorOrder = GRB, DefaultDotStarColorOrder = BGR (53877ec02 moved the defaults there)",
			"RRF 3.6.3 LedStrips/DotStarLedStrip.cpp Configure - the only place gb.TryGetLimitedUIValue('K', order, ...) appears for LED strips",
		],
	},
	{
		id: "m221-rescales-queued-moves",
		version: "3.7.0-rc.1",
		kind: "changed",
		target: { type: "behaviour", code: "M221", description: "M221 can now rescale extrusion in moves already queued but not yet started, within the extruder jerk limit" },
		description: "M221 used to change only the factor that moves read AFTER it are built with (plus the one move being assembled). It now also rescales the extrusion of moves already planned but not yet committed to the motors, limited so that no extruder's instantaneous speed change exceeds its jerk limit. Whether a given M221 does that depends on the channel it arrives on, so the moment a new factor takes effect, and exactly which already-queued moves it reaches, differs from 3.6.3. A print file that changes M221 mid-stream, or a script that relies on the exact point a factor applies, should be checked.",
		sources: [
			"RRF commits dce60398a \"Implemented fast extrusion factor change\", 371e97f2d \"Always use fast extrusion factor change but apply extruder jerk limit\" and e707b11e9 \"M221 extrusion rate changes are not immediate when from a File channel\" (all first in 3.7.0-rc.1)",
			"RRF 3.7.0-rc.2 GCodes/GCodes2.cpp case 221 - ChangeExtrusionFactor(extruder, extrusionFactor, isFileChannel), GCodes/GCodes3.cpp ChangeExtrusionFactor - the per-motion-system rescale only runs when its `immediate` argument is true; Movement/DDA.cpp DDA::AdjustExtrusion and Movement/DDARing.cpp ChangeExtrusionFactor walk the uncommitted DDAs (the commit subject for e707b11e9 and the code disagree about which channel is immediate; the code is what ships)",
			"RRF 3.6.3 GCodes/GCodes3.cpp ChangeExtrusionFactor and Movement/RawMove.cpp MovementState::ChangeExtrusionFactor - only coords of the move still being assembled; no DDA is touched",
		],
	},
	{
		id: "m950-j-filament-monitor-input",
		version: "3.7.0-beta.2+1",
		kind: "added",
		target: { type: "parameter", code: "M950", letter: "C", whenValue: ["fm*", "!fm*"] },
		description: "A general-purpose input (M950 J) can take its state from a filament monitor instead of a pin: C\"fm0.switch\" follows extruder 0's filament-present switch and C\"fm0.motion\" its motion detection, with a leading ! to invert. Firmware without this reads it as a pin name and fails, so a config that uses it cannot go back.",
		sources: [
			"RRF commit 7831771ce \"Implemented #1185\" (first contained by 3.7.0-beta.2+1)",
			"RRF 3.7.0-rc.2 GPIO/GpInPort.cpp:101-125 GpInputPort::Configure - \"Check for a virtual port fed by a filament monitor, e.g. \\\"fm0.switch\\\" or \\\"!fm0.motion\\\"\"; an unknown suffix gives \"Invalid filament monitor input name\"",
			"RRF 3.6.3 GPIO/GpInPort.cpp GpInputPort::Configure - the name goes straight to the pin parser",
		],
	},
	{
		id: "m950-j-probe-input",
		version: "3.7.0-beta.3",
		kind: "added",
		target: { type: "parameter", code: "M950", letter: "C", whenValue: ["probe*", "!probe*"] },
		description: "A general-purpose input (M950 J) can follow a Z probe's triggered state: C\"probe0\" (probe number, ! to invert). Firmware without this reads it as a pin name and fails, so a config that uses it cannot go back.",
		sources: [
			"RRF commit d6ae7e8f1 \"Added Z probe virtual input source for general-purpose inputs\" (first contained by 3.7.0-beta.3)",
			"RRF 3.7.0-rc.2 GPIO/GpInPort.cpp:127-141 GpInputPort::Configure - \"Check for a virtual port fed by the triggered state of a Z probe, e.g. \\\"probe0\\\"\"; an out-of-range number or a suffix gives \"Invalid Z probe input name\"",
		],
	},
	{
		id: "m141-h-colon-list",
		version: "3.7.0-alpha.3",
		kind: "changed",
		target: { type: "parameter", code: "M141", letter: "H" },
		description: "M141's H parameter becomes a colon list too (the chamber twin of m140-h-colon-list): up to 4 heaters may be assigned to one chamber slot, e.g. M141 H2:3, where 3.6.3 took a single heater number. Each heater is also checked, which 3.6.3 did not: M141 H now fails if the heater is on a tool (M563 H) or is already a bed heater (M140 H), so a heater that served as both in a 3.6.3 config.g errors on whichever of the two lines comes second.",
		sources: [
			"RRF commit 8a1738d029 \"Allow multiple heaters to be assigned to beds/chambers (#1103)\" (first contained by 3.7.0-alpha.3)",
			"RRF 3.7.0-rc.2 GCodes/GCodes2.cpp:2320-2385 case 140/141 - gb.GetIntArray(heaterNumbers, heaterCount, false), maxHeatersPerSlot = MaxHeatersPerChamber for 141 (Config/Pins_*.h: 4); Heating/Heat.cpp Heat::SetChamberHeaters",
			"RRF 3.6.3 GCodes/GCodes2.cpp:2243-2260 case 141 - int heater = gb.GetIValue() (line 2255)",
		],
	},
	{
		id: "planner-junction-extrusion-ratio-mb6hc",
		version: "3.7.0-alpha.2",
		kind: "changed",
		target: { type: "behaviour", description: "Duet 3 MB6HC: how fast a printing move may hand over to the next changed, even with S-curve acceleration off" },
		description: "Only on a Duet 3 Mainboard 6HC (the board whose default build compiles in the new 3rd-order motion code), and whether or not S-curve acceleration is switched on: before one printing move is melded with the one before it, the planner now compares their extrusion. If an extruder reverses, starts or stops between the two, if an extruder's share of the move falls below 0.2 of the previous move's, or if a mixing set-up's per-extruder ratios differ by more than 1%, the junction is taken from standstill; otherwise the previous move's end speed is scaled by the extrusion ratio and also capped by each visible axis's M566 maximum instantaneous speed change. 3.6.3 had neither rule: it limited the junction only through the printing instantaneous speed-change limits (DDA::MatchSpeeds). The same M566/M204 settings can therefore give different corner speeds and print times. Nothing in a file selects this, so a scan cannot check it. Read from the code, not measured on a machine.",
		sources: [
			"RRF commit db94d82c7 \"Preparation for new S-curve planning mechanism\" (first contained by 3.7.0-alpha.2; the logic moved to Movement/DDA_3rdOrder.cpp by 2f78e0873)",
			"RRF 3.7.0-rc.2 Movement/DDA.cpp:596-666 DDA::InitStandardMove (meld test, startSpeed = prev->endSpeed * beforePrepare.startSpeedRatio, prev->beforePrepare.targetNextSpeed capped by maxPrevEndSpeed); Movement/DDA_3rdOrder.cpp:37-106 SetSpeedRatioAndMaxJunctionSpeedForPrintingMoves / ForNonPrintingMoves; Config/Pins_Duet3_MB6HC.h:28 SUPPORT_3RD_ORDER 1",
			"RRF 3.6.3 Movement/DDA.cpp:535-550 (meld: prev->beforePrepare.targetNextSpeed = min(fastSqrtf(maxDeceleration * totalDistance * 2.0), requestedSpeed); startSpeed = prev->endSpeed) and :1006 DDA::MatchSpeeds",
		],
	},
	{
		id: "m563-h-rejects-bed-or-chamber-heater",
		version: "3.7.0-alpha.3",
		kind: "changed",
		target: { type: "parameter", code: "M563", letter: "H" },
		description: "M563 now refuses a tool whose H lists a heater that is already a bed heater (M140 H) or a chamber heater (M141 H): the tool is not created and the line fails with \"heater N is already assigned as a bed heater\" (or \"chamber\"). 3.6.3 checked only that the number was in range, so a config.g that put one heater on both a bed or chamber and a tool loaded without error. The mirror-image check on M140/M141 is described by m140-h-colon-list and m141-h-colon-list.",
		sources: [
			"RRF commit 8a1738d029 \"Allow multiple heaters to be assigned to beds/chambers (#1103)\" (first contained by 3.7.0-alpha.3; reverted by eef715879 and applied again as 7579d899c before that build, which carries the check)",
			"RRF 3.7.0-rc.2 Tools/Tool.cpp:177-190 Tool::Create - reprap.GetHeat().GetHeaterFunction(h[i]) is bed or chamber -> \"heater %d is already assigned as a %s heater\", return nullptr",
			"RRF 3.6.3 Tools/Tool.cpp:176-183 Tool::Create - the heater loop checks only h[i] < 0 || h[i] >= MaxHeaters (\"bad heater number\")",
		],
	},
	{
		id: "m472-r1-recursive-delete-nested",
		version: "3.7.0-rc.2",
		kind: "changed",
		target: { type: "parameter", code: "M472", letter: "R", whenValue: ["1"] },
		description: "M472 R1 now removes a directory that contains sub-directories. In 3.6.3 the recursive delete deleted the files directly inside the directory but handed the wrong directory handle to its recursion for each sub-directory, so the contents of a sub-directory were never deleted, the sub-directory itself was never removed and the final delete of the top directory failed because it was not empty. 3.7.0-rc.2 walks the tree iteratively, deleting each directory once it is empty. A macro that worked around the old behaviour (deleting the sub-directories one by one first) still works. Only the standalone SD-card path changed: with a Raspberry Pi (SBC) the delete is done by DSF in both versions.",
		sources: [
			"RRF commit 095e5824b \"Fixed recursive delete of directories containing subdirectories\" (2026-09-24, first contained by 3.7.0-rc.2)",
			"RRF 3.7.0-rc.2 Storage/MassStorage.cpp:747 DeleteContents(const StringRef&, ...) and :861 MassStorage::Delete; GCodes/GCodes2.cpp:3423 case 472 - recursive = (gb.Seen('R') && gb.GetUIValue() == 1)",
			"RRF 3.6.3 Storage/MassStorage.cpp:670-720 DeleteContents(DIR& dir, ...) - the recursive call at :697 passes the outer 'dir' instead of 'dir2' and never deletes the sub-directory; the function ends with return true whatever happened",
		],
	},
	// Not detectable: nothing in a file selects it; it is the lack of an M586 P0 S1 line (and a board that has no other way to start HTTP) that matters.
	{
		id: "network-http-not-enabled-by-default",
		version: "3.7.0-alpha.3",
		kind: "changed",
		target: { type: "behaviour", description: "a network interface starts with HTTP (the web interface) disabled until M586 P0 S1 is run; it used to start with HTTP enabled" },
		description: "The network interfaces no longer start with HTTP enabled. RRF 3.6.3 set the HTTP flag in the interface's constructor, so a board that had a network enabled (M552 S1) served the web interface on port 80 even if config.g never mentioned M586. From 3.7.0-alpha.3 every protocol starts disabled (the constructor sets them all false and nothing else switches HTTP on), so HTTP only comes up after M586 P0 S1 - which the standard config.g written by the Duet configuration tool already contains. A hand-written or heavily trimmed config.g that relied on the old default no longer reaches the web interface after the update. Applies to wired Ethernet (Duet 3, Duet 2 Ethernet) and to WiFi alike; in SBC mode DuetWebServer decides, not RRF. The same constructor change introduced the TLS flags (m586-t-tls-listener). Read from the code, not measured on a board; no commit message says whether the default change was intended.",
		sources: [
			"RRF commit 0f8da3b79 \"Added TLS support for SAME series using MbedTls\" (2026-03-18; first contained by 3.7.0-alpha.3 [24fc17017])",
			"RRF 3.7.0-rc.2 Networking/NetworkInterface.cpp:23 protocolEnabled[i] = false; the only other writers are NetworkInterface::EnableProtocol (:105-107) and DisableProtocol (:148), reached only from M586 (Networking/Network.cpp:602, :618)",
			"RRF 3.6.3 Networking/NetworkInterface.cpp:18 protocolEnabled[i] = (i == HttpProtocol)",
		],
	},
	// Not detectable: it needs input shaping switched on (M593) and depends on the order of the moves, not on any one line.
	{
		id: "input-shaping-unshaped-move-start-gap",
		version: "3.7.0-alpha.2",
		kind: "changed",
		target: { type: "behaviour", description: "with input shaping on, which moves wait for the previous move's shaping tail to finish before they start" },
		description: "With input shaping on (M593), a move that is not itself shaped is held back until the shaping tail of a preceding shaped move has finished. 3.6.3 applied that hold to any non-printing move that followed a printing move, which also held back an XY travel move (which is shaped) and never held back a Z move or an extruder-only move that followed an XY travel. From 3.7.0-alpha.2 the test is on the shaping itself: a move without input shaping (Z-only, extruder-only, isolated or leadscrew-adjustment moves) waits for the preceding shaped move, whether that was a print or a travel, and a shaped move is never held back for the preceding move's tail. Corner timing and print time change by up to the shaping time (a few tens of milliseconds) per affected move; nothing in a file selects it. Read from the code, not measured.",
		sources: [
			"RRF commit a30caa5b9 \"Don't overlap an unshaped move with a previous shaped moved\" (2025-11-18, first contained by 3.7.0-alpha.2)",
			"RRF 3.7.0-rc.2 Movement/DDA.cpp:1248 DDA::Prepare - if (!params.useInputShaping && prev->UsesInputShaping()) prevEndTime += shaping time; Movement/DDA.h:388 UsesInputShaping()",
			"RRF 3.6.3 Movement/DDA.cpp:1060 DDA::Prepare - if (prev->flags.isPrintingMove && !flags.isPrintingMove) prevEndTime += shaping time",
		],
	},
	{
		id: "m552-t-tristate",
		version: "3.7.0-alpha.6",
		kind: "changed",
		target: { type: "parameter", code: "M552", letter: "T" },
		description: "M552's T parameter widens from a boolean (0/1, enable TLS) to a tri-state (-1 clear stored TLS material and start plain, 0/absent plain, 1 enable) as part of WiFi TLS support - T-1 has no effect before this version. It also now moves the certificate and key files: M552 T1 on the WiFi interface sends /sys/server.crt and /sys/server.key to the WiFi module's flash when both exist and then securely wipes and deletes the SD copies, so keep your own copy of them; M552 T-1 clears what the module stores, and on a wired Ethernet interface that is not yet active it wipes and deletes those two files from /sys.",
		sources: [
			"RRF commit 4ead59f9a4 \"Added TLS support over WiFi (ESP32 S3)\" (first contained by 3.7.0-alpha.6)",
			"RRF 3.7.0-rc.2 Networking/ESP8266WiFi/WiFiInterface.cpp:1120-1146 ImportTlsFromSd and TryEnableTls (SendPemFile of TlsCertFile and TlsKeyFile, then MassStorage::SecureDelete of both), HandlePendingTlsRequest (networkClearTls); Networking/LwipEthernet/LwipEthernetInterface.cpp EnableInterface (tlsParam < 0 && !activated: SecureDelete of both files); Networking/NetworkDefs.h:80-81 TlsCertFile = \"/sys/server.crt\", TlsKeyFile = \"/sys/server.key\"",
		],
	},
	// Found by FIRMWARE-CHANGES-PLAN.md D3 step 2. A Duet 3 main board gains a second USB CDC channel, so every serial channel
	// number after 0 moves up by one: `M575 P1 B57600 S1` (PanelDue, the usual config.g line) now selects the SECOND USB channel.
	{
		id: "m575-p-channel-numbering",
		version: "3.7.0-alpha.2",
		kind: "changed",
		target: { type: "parameter", code: "M575", letter: "P" },
		description: AUX_PORT_NUMBERING("M575 P"),
		sources: AUX_PORT_SOURCES,
	},
	...["M260.1", "M260.2", "M260.3", "M260.4", "M261.1", "M261.2"].map((code): ChangeEvent => ({
		id: `aux-port-numbering-${code.toLowerCase().replace(".", "-")}`,
		version: "3.7.0-alpha.2",
		kind: "changed",
		target: { type: "parameter", code, letter: "P" },
		description: AUX_PORT_NUMBERING(`${code} P`),
		sources: AUX_PORT_SOURCES,
	})),
];

/** A dictionary `until` is the LAST release that has the command or parameter, so its removal event belongs to the
 *  next tracked release - `changesBetween` selects `(from, to]`, and an event dated at `until` itself would miss
 *  the very upgrade that crosses it (the same rule as `firstTrackedVersionAfter` for object-model paths). */
function firstReleaseAfter(until: string): string {
	return RELEASES.find((r) => compareFirmwareVersions(r.version, until) > 0)?.version ?? until;
}

function dictionaryCommandEvents(): Array<ChangeEvent> {
	const events: Array<ChangeEvent> = [];
	for (const spec of Object.values(COMMANDS)) {
		if (spec.since !== undefined) {
			events.push({
				id: spec.eventIds?.since ?? `dict-${spec.code}-added`, version: spec.since, kind: "added",
				target: { type: "command", code: spec.code },
				description: `${spec.code} added: ${spec.summary}`, sources: spec.sources,
			});
		}
		if (spec.until !== undefined) {
			events.push({
				id: spec.eventIds?.until ?? `dict-${spec.code}-removed`, version: firstReleaseAfter(spec.until), kind: "removed",
				target: { type: "command", code: spec.code },
				description: `${spec.code} removed: ${spec.summary}`, sources: spec.sources,
			});
		}
		if (spec.deprecated?.since !== undefined) {
			events.push({
				id: spec.eventIds?.deprecated ?? `dict-${spec.code}-deprecated`, version: spec.deprecated.since, kind: "deprecated",
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
					id: param.eventIds?.since ?? `dict-${spec.code}-${param.letter}-added`, version: param.since, kind: "added",
					target: { type: "parameter", code: spec.code, letter: param.letter },
					description: `${spec.code}'s ${param.letter} parameter added: ${param.description}`, sources: param.sources,
				});
			}
			if (param.until !== undefined) {
				events.push({
					id: param.eventIds?.until ?? `dict-${spec.code}-${param.letter}-removed`, version: firstReleaseAfter(param.until), kind: "removed",
					target: { type: "parameter", code: spec.code, letter: param.letter },
					description: `${spec.code}'s ${param.letter} parameter removed: ${param.description}`, sources: param.sources,
				});
			}
		}
		// A variant's letter exists for ONE selector value (`M669 K6`'s J), so its event names the selector on the same line:
		// without that a rotary delta's `M669 K10 L...` would be flagged by a Hangprinter-only letter's event.
		if (spec.selectorVariants !== undefined) {
			const { selector, variants } = spec.selectorVariants;
			for (const variant of variants) {
				for (const param of variant.parameters) {
					const target: ChangeEvent["target"] = {
						type: "parameter", code: spec.code, letter: param.letter,
						whenCompanion: { letter: selector, values: variant.values },
					};
					const stem = `dict-${spec.code}-${selector}${variant.values[0]}-${param.letter}`;
					if (param.since !== undefined) {
						events.push({
							id: param.eventIds?.since ?? `${stem}-added`, version: param.since, kind: "added", target,
							description: `${spec.code}'s ${param.letter} parameter added for ${variant.label}: ${param.description}`, sources: param.sources,
						});
					}
					if (param.until !== undefined) {
						events.push({
							id: param.eventIds?.until ?? `${stem}-removed`, version: firstReleaseAfter(param.until), kind: "removed", target,
							description: `${spec.code}'s ${param.letter} parameter removed for ${variant.label}: ${param.description}`, sources: param.sources,
						});
					}
				}
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
				sources: [entry.deprecated.source ?? "@duet3d/objectmodel deprecations.json (see docs/tasks/11-object-model-schema.md)"],
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
