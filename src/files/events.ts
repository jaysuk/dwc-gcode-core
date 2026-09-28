/**
 * RRF's event system (`docs/file-kinds.md`, `docs/invocation-table.md`): a hardware or firmware
 * condition (a heater fault, a filament-monitor error, a driver stall, ...) is queued as an `Event`,
 * and RRF's normal action for it is to run the macro named after the event type, in the system
 * files folder. Every entry below is read from RRF source, not just the wiki's `Events.md`; where
 * the two disagree, source decides and `docs/wiki-discrepancies.md` has both quotes.
 *
 * How a macro's name is built (`Platform/Event.cpp:91-100` `Event::GetMacroFileName`, RRF
 * `3.7.0-rc.1`): the enumerator's own name (`EventType`, a `NamedEnum` in `Duet3D/CANlib`'s
 * `src/RRF3Common.h:326`), every `_` replaced by `-`, plus `.g` - so `heater_fault` runs
 * `heater-fault.g`. The macro only runs if the file exists (`GCodes3.cpp:1407` `SysFileExists`);
 * otherwise RRF takes its built-in default action for that event (`GCodes3.cpp:1427-1449`).
 *
 * The macro is started with four parameters (`Event.cpp:103-112` `Event::GetParameters`, plus `S`
 * added at `GCodes3.cpp:1414`) - see `EVENT_MACRO_PARAMETERS`. All four are always present, even
 * where a given event has nothing meaningful to say for one of them (`B` is deliberately always
 * included "so that the same macros can be used on all Duets", `Event.cpp:109`).
 */

/** What RRF itself does with an event when no handler macro exists. */
export type EventDefaultAction =
	/** Print the event's text on the console (and log it) and carry on. */
	| "message"
	/** Pause the print, running `pause.g` (`GCodeState::eventPausing1`). */
	| "pause"
	/** Pause the print WITHOUT running `pause.g` (`GCodeState::eventPausing2`). */
	| "pause-without-pause-g";

export interface EventTypeInfo {
	/** RRF's own enumerator, e.g. `"heater_fault"` - also what `M957 E"..."` takes (`-` is accepted for
	 *  `_`, `GCodes3.cpp:1368`). */
	type: string;
	/** The handler macro's filename in `/sys`, e.g. `"heater-fault.g"`. */
	macro: string;
	/** RRF release this event type first exists in, if later than every tracked release (so it can be
	 *  present in this table before the package's `RRF_BASELINE` reaches it - see `sources`). */
	since?: string;
	/** `false` for an enumerator RRF declares (so `M957` can raise it, and its macro would run) but
	 *  never raises itself on any board. */
	raisedAutomatically: boolean;
	/** What the `D` macro parameter means for this event (`Event::deviceNumber`). */
	device: string;
	/** What the `P` macro parameter means (`Event::param`). */
	param: string;
	/** What the `B` macro parameter means (`Event::boardAddress`). */
	board: string;
	defaultAction: EventDefaultAction;
	/** The message class RRF logs the event's text as (`Event::GetTextDescription`'s return value). */
	level: "error" | "warning";
	/** RRF source lines, and the wiki passage where it says the same (or, where it differs, the
	 *  discrepancy entry to look at). */
	sources: ReadonlyArray<string>;
}

const EVENT_ENUM = "Duet3D/CANlib 3.7.0-rc.1 src/RRF3Common.h:326 NamedEnum(EventType, ...)";
const TEXT = "RRF 3.7.0-rc.1 Platform/Event.cpp:153-243 Event::GetTextDescription";
const PAUSE = "RRF 3.7.0-rc.1 Platform/Event.cpp:115-133 Event::GetDefaultPauseReason";
const WIKI = "wiki RepRapFirmware/Events.md \"Processing events\" table";

/**
 * Every value of RRF's `EventType`, in the enumerator's own order. The wiki table lists nine of
 * these; the other four are enumerators RRF never raises by itself (see each entry's own note).
 */
export const EVENT_TYPES: ReadonlyArray<EventTypeInfo> = [
	{
		type: "main_board_power_fail", macro: "main-board-power-fail.g", raisedAutomatically: false,
		device: "0 unless given to M957", param: "0 unless given to M957", board: "CAN address the event was raised for",
		defaultAction: "message", level: "error",
		sources: [
			EVENT_ENUM,
			"Duet3D/CANlib 3.7.0-rc.1 src/RRF3Common.h:324 \"main board power failure is not currently handled by the event system but is included here as a placeholder\"",
			"RRF 3.7.0-rc.1 Platform/Event.cpp:199-201 \"This does not currently generate an event, so no text\"",
			"wiki Events.md \"The following are not currently treated as events\" (Main board power failure)",
		],
	},
	{
		type: "expansion_reconnect", macro: "expansion-reconnect.g", raisedAutomatically: true,
		device: "0", param: "0 when the board restarted; 1 when it lost and regained time sync but kept its configuration; 3 when in addition it switched its heaters off (bit 1)",
		board: "CAN address of the board that reconnected",
		defaultAction: "message", level: "error",
		sources: [
			EVENT_ENUM,
			"RRF 3.7.0-rc.1 CAN/ExpansionManager.cpp:186 (P=1 or 3) and :192 (P=0) Event::AddEvent(EventType::expansion_reconnect, ...)",
			`${TEXT} (case expansion_reconnect)`,
			`${WIKI} - the wiki says P is always 0; source differs, see docs/wiki-discrepancies.md`,
		],
	},
	{
		type: "expansion_timeout", macro: "expansion-timeout.g", raisedAutomatically: true,
		device: "0", param: "0", board: "CAN address of the board that has stopped communicating",
		defaultAction: "message", level: "error",
		sources: [
			EVENT_ENUM,
			"RRF 3.7.0-rc.1 CAN/ExpansionManager.cpp:598 Event::AddEvent(EventType::expansion_timeout, 0, addr, 0, \"\")",
			`${TEXT} (case expansion_timeout)`,
			WIKI,
		],
	},
	{
		type: "heater_fault", macro: "heater-fault.g", raisedAutomatically: true,
		device: "heater number", param: "heater fault type code (HeaterFaultType: 0 failed to read sensor, 1 temperature rising too slowly, 2 exceeded allowed excursion, 3 monitor triggered, and from 3.7 4 PWM too high, 5 inductive heater error)",
		board: "CAN address of the board controlling the heater",
		defaultAction: "pause", level: "error",
		sources: [
			EVENT_ENUM,
			"RRF 3.7.0-rc.1 Heating/LocalHeater.cpp:1050,1055 (the faulty heater is turned off before the event is raised)",
			PAUSE,
			`${TEXT} (case heater_fault)`,
			WIKI,
		],
	},
	{
		type: "driver_error", macro: "driver-error.g", raisedAutomatically: true,
		device: "local driver number (not including the board's CAN address)", param: "lower 16 bits of the driver status word",
		board: "CAN address of the board with the driver",
		defaultAction: "pause-without-pause-g", level: "error",
		sources: [
			EVENT_ENUM,
			"RRF 3.7.0-rc.1 Movement/Move.cpp:3727,3732 (raised)",
			`${PAUSE} + GCodes/GCodes4.cpp:1981 (driverError uses eventPausing2, which does not run pause.g)`,
			`${TEXT} (case driver_error)`,
			WIKI,
		],
	},
	{
		type: "filament_error", macro: "filament-error.g", raisedAutomatically: true,
		device: "extruder number", param: "filament error type code (FilamentSensorStatus)",
		board: "CAN address of the board hosting the filament monitor",
		defaultAction: "pause", level: "error",
		sources: [
			EVENT_ENUM,
			"RRF 3.7.0-rc.1 FilamentMonitors/FilamentMonitor.cpp:483 Event::AddEvent(EventType::filament_error, ...)",
			PAUSE,
			`${TEXT} (case filament_error)`,
			WIKI,
		],
	},
	{
		type: "driver_stall", macro: "driver-stall.g", raisedAutomatically: true,
		device: "local driver number", param: "0", board: "CAN address of the board with the driver",
		defaultAction: "message", level: "warning",
		sources: [
			EVENT_ENUM,
			"RRF 3.7.0-rc.1 Movement/Move.cpp:3759,3767 (raised)",
			`${TEXT} (case driver_stall)`,
			WIKI,
		],
	},
	{
		type: "driver_warning", macro: "driver-warning.g", raisedAutomatically: true,
		device: "local driver number", param: "lower 16 bits of the driver status word",
		board: "CAN address of the board with the driver",
		defaultAction: "message", level: "warning",
		sources: [
			EVENT_ENUM,
			"RRF 3.7.0-rc.1 Movement/Move.cpp:3741,3746 (raised)",
			`${TEXT} (case driver_warning)`,
			WIKI,
		],
	},
	{
		type: "mcu_temperature_warning", macro: "mcu-temperature-warning.g", raisedAutomatically: false,
		device: "0 unless given to M957", param: "temperature in tenths of a degree C", board: "CAN address the event was raised for",
		defaultAction: "message", level: "warning",
		sources: [
			EVENT_ENUM,
			"Duet3D/CANlib 3.7.0-rc.1 src/RRF3Common.h:325 \"mcu_temperature_warning is not current used\"",
			`${TEXT} (case mcu_temperature_warning)`,
		],
	},
	{
		type: "overvoltage", macro: "overvoltage.g", raisedAutomatically: false,
		device: "0 unless given to M957", param: "voltage in tenths of a volt", board: "CAN address the event was raised for",
		defaultAction: "message", level: "warning",
		sources: [
			EVENT_ENUM,
			"no raise site found in RRF 3.7.0-rc.1 src/ or Duet3Expansion 3.7.0-rc.1 src/ - only M957 (GCodes3.cpp:1362-1391) can queue it",
			`${TEXT} (case overvoltage)`,
		],
	},
	{
		type: "undervoltage", macro: "undervoltage.g", raisedAutomatically: false,
		device: "0 unless given to M957", param: "voltage in tenths of a volt", board: "CAN address the event was raised for",
		defaultAction: "message", level: "warning",
		sources: [
			EVENT_ENUM,
			"no raise site found in RRF 3.7.0-rc.1 src/ or Duet3Expansion 3.7.0-rc.1 src/ - only M957 (GCodes3.cpp:1362-1391) can queue it",
			`${TEXT} (case undervoltage)`,
		],
	},
	{
		type: "board_temperature_warning", macro: "board-temperature-warning.g", since: "3.7.0-rc.2", raisedAutomatically: true,
		device: "0", param: "board temperature in tenths of a degree C", board: "CAN address of the board",
		defaultAction: "message", level: "warning",
		sources: [
			"Duet3D/CANlib 3.7.0-rc.2 src/RRF3Common.h:326-332 NamedEnum(EventType, ..., board_temperature_warning, board_over_temperature)",
			"RRF 3.7.0-rc.2 Platform/Event.cpp:220-226 Event::GetTextDescription (case board_temperature_warning)",
			"Duet3D/Duet3Expansion 3.7-dev@806ef34 (2026-09-25, not yet in its 3.7.0-rc.1 tag) src/Movement/Move.cpp:351 CanInterface::RaiseEvent(EventType::board_temperature_warning, ...) - raised by expansion boards over CAN, not by a mainboard",
			"wiki Events.md \"Board temperature warning (RRF 3.7.0-rc.2 and later on Motor M23CL)\"",
		],
	},
	{
		type: "board_over_temperature", macro: "board-over-temperature.g", since: "3.7.0-rc.2", raisedAutomatically: true,
		device: "0", param: "board temperature in tenths of a degree C", board: "CAN address of the board",
		defaultAction: "pause-without-pause-g", level: "error",
		sources: [
			"Duet3D/CANlib 3.7.0-rc.2 src/RRF3Common.h:326-332",
			"RRF 3.7.0-rc.2 Platform/Event.cpp:131-132 Event::GetDefaultPauseReason (boardOverTemperature) + :228-234 Event::GetTextDescription",
			"RRF 3.7.0-rc.2 GCodes/GCodes4.cpp:1981 (boardOverTemperature, like driverError, uses eventPausing2 - no pause.g)",
			"Duet3D/Duet3Expansion 3.7-dev@806ef34 (2026-09-25, not yet in its 3.7.0-rc.1 tag) src/Movement/Move.cpp:345 CanInterface::RaiseEvent(EventType::board_over_temperature, ...)",
			"wiki Events.md \"Board over-temperature\" row: \"pause the job without running pause.g\"",
		],
	},
];

/** The four parameters every event macro is started with. */
export const EVENT_MACRO_PARAMETERS: ReadonlyArray<{ letter: string; description: string; source: string }> = [
	{ letter: "D", description: "the event's device number (what that means depends on the event - see EventTypeInfo.device)", source: "RRF 3.7.0-rc.1 Platform/Event.cpp:108" },
	{ letter: "B", description: "the CAN address of the board that raised the event (always present, 0 on a standalone board)", source: "RRF 3.7.0-rc.1 Platform/Event.cpp:109" },
	{ letter: "P", description: "extra information about the event (see EventTypeInfo.param)", source: "RRF 3.7.0-rc.1 Platform/Event.cpp:110" },
	{ letter: "S", description: "the event's full description text, the same string RRF logs (a string, not a number)", source: "RRF 3.7.0-rc.1 GCodes/GCodes3.cpp:1414" },
];

const BY_MACRO: ReadonlyMap<string, EventTypeInfo> = new Map(EVENT_TYPES.map((e) => [e.macro, e]));
const BY_TYPE: ReadonlyMap<string, EventTypeInfo> = new Map(EVENT_TYPES.map((e) => [e.type, e]));

/** The event whose handler macro is called `fileName` (a bare filename, matched case-insensitively -
 *  RRF's SD card is FAT), or `null`. */
export function eventForMacro(fileName: string): EventTypeInfo | null {
	return BY_MACRO.get(fileName.toLowerCase()) ?? null;
}

/** The event with this type name, as RRF spells it (`heater_fault`) or as `M957`/the macro filename
 *  do (`heater-fault`) - RRF itself accepts either for `M957` (`GCodes3.cpp:1368` `ReplaceAll('-', '_')`). */
export function eventByType(type: string): EventTypeInfo | null {
	return BY_TYPE.get(type.replace(/-/g, "_")) ?? null;
}
