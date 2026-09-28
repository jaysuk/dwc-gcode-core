import { describe, expect, it } from "vitest";

import { EVENT_MACRO_PARAMETERS, EVENT_TYPES, eventByType, eventForMacro } from "../src/files/events.js";
import { classifyFile } from "../src/files/kinds.js";
import { loadProject } from "../src/project.js";

// Facts pinned here are read from RRF source (`Event.cpp`, CANlib's `RRF3Common.h`), not just the
// wiki's Events.md - see each entry's own `sources` and docs/wiki-discrepancies.md.

describe("EVENT_TYPES", () => {
	it("is exactly RRF 3.7.0-rc.2's EventType enum (rc.1's plus the two board-temperature events), in enum order", () => {
		expect(EVENT_TYPES.map((e) => e.type)).toEqual([
			"main_board_power_fail", "expansion_reconnect", "expansion_timeout", "heater_fault", "driver_error",
			"filament_error", "driver_stall", "driver_warning", "mcu_temperature_warning", "overvoltage", "undervoltage",
			"board_temperature_warning", "board_over_temperature",
		]);
	});

	it("builds every macro name the way Event::GetMacroFileName does: underscores to dashes, plus .g", () => {
		for (const e of EVENT_TYPES) expect(e.macro, e.type).toBe(`${e.type.replace(/_/g, "-")}.g`);
	});

	it("cites source for every event", () => {
		for (const e of EVENT_TYPES) expect(e.sources.length, e.type).toBeGreaterThan(0);
	});

	it("only the two board-temperature events arrived after 3.7.0-rc.1", () => {
		expect(EVENT_TYPES.filter((e) => e.since !== undefined).map((e) => `${e.type}@${e.since}`)).toEqual([
			"board_temperature_warning@3.7.0-rc.2", "board_over_temperature@3.7.0-rc.2",
		]);
	});

	it("matches the default actions RRF's ProcessEvent takes", () => {
		const action = (t: string) => eventByType(t)?.defaultAction;
		expect(action("heater_fault")).toBe("pause");
		expect(action("filament_error")).toBe("pause");
		// driver_error (and rc.2's board_over_temperature) pause WITHOUT running pause.g: eventPausing2.
		expect(action("driver_error")).toBe("pause-without-pause-g");
		expect(action("board_over_temperature")).toBe("pause-without-pause-g");
		expect(action("driver_stall")).toBe("message");
		expect(action("expansion_timeout")).toBe("message");
	});

	it("marks the four enumerators RRF never raises itself", () => {
		expect(EVENT_TYPES.filter((e) => !e.raisedAutomatically).map((e) => e.type)).toEqual([
			"main_board_power_fail", "mcu_temperature_warning", "overvoltage", "undervoltage",
		]);
	});

	it("records that expansion-reconnect's P is not always 0 - the wiki's table is wrong about that", () => {
		expect(eventByType("expansion_reconnect")?.param).toContain("3 when in addition it switched its heaters off");
	});
});

describe("EVENT_MACRO_PARAMETERS", () => {
	it("is D, B, P and S, in that order", () => {
		expect(EVENT_MACRO_PARAMETERS.map((p) => p.letter)).toEqual(["D", "B", "P", "S"]);
	});
});

describe("eventForMacro / eventByType", () => {
	it("finds an event by its handler macro's filename, case-insensitively", () => {
		expect(eventForMacro("heater-fault.g")?.type).toBe("heater_fault");
		expect(eventForMacro("HEATER-FAULT.G")?.type).toBe("heater_fault");
	});
	it("does not treat the underscore spelling as a macro name", () => {
		expect(eventForMacro("heater_fault.g")).toBeNull();
	});
	it("finds an event by type with either separator, as M957 accepts", () => {
		expect(eventByType("filament_error")?.macro).toBe("filament-error.g");
		expect(eventByType("filament-error")?.macro).toBe("filament-error.g");
		expect(eventByType("no-such-event")).toBeNull();
	});
});

describe("classifyFile: event macros", () => {
	it.each(EVENT_TYPES.map((e) => [e.macro, e.macro.slice(0, -2)]))("%s is a system macro whose role is %s", (macro, role) => {
		expect(classifyFile(`0:/sys/${macro}`)).toEqual({ kind: "system-macro", syntax: "gcode", role });
		expect(classifyFile(macro)).toEqual({ kind: "system-macro", syntax: "gcode", role });
	});

	it("does not treat an underscore-spelled name as an event macro (RRF looks for the dashed one)", () => {
		expect(classifyFile("0:/sys/heater_fault.g").kind).toBe("user-macro");
	});
});

describe("M957 in a project", () => {
	it("records the event's handler macro as a call when the file exists", () => {
		const project = loadProject([
			{ path: "0:/sys/config.g", text: 'M957 E"heater-fault" D1\n' },
			{ path: "0:/sys/heater-fault.g", text: "M118 S{param.S}\n" },
		]);
		expect(project.calls.filter((c) => c.via === "M957")).toEqual([
			{ from: { file: "0:/sys/config.g", line: 0 }, to: "sys/heater-fault.g", resolved: true, dynamic: false, via: "M957" },
		]);
	});

	it("takes the underscore spelling too", () => {
		const project = loadProject([
			{ path: "0:/sys/config.g", text: 'M957 E"driver_stall" D0\n' },
			{ path: "0:/sys/driver-stall.g", text: "; handler\n" },
		]);
		expect(project.calls.map((c) => c.to)).toContain("sys/driver-stall.g");
	});

	it("does not record a missing handler as an unresolved call - RRF falls back to the event's default action", () => {
		const project = loadProject([{ path: "0:/sys/config.g", text: 'M957 E"heater_fault" D1\n' }]);
		expect(project.calls).toEqual([]);
	});

	it("ignores an event name RRF would reject", () => {
		const project = loadProject([
			{ path: "0:/sys/config.g", text: 'M957 E"nonsense" D1\n' },
			{ path: "0:/sys/nonsense.g", text: "; x\n" },
		]);
		expect(project.calls).toEqual([]);
	});
});
