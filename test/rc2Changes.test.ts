import { describe, expect, it } from "vitest";

import { parseDocument } from "../src/document.js";
import { diagnoseDocument } from "../src/diagnostics/diagnose.js";
import { objectModelChanges, objectModelPath } from "../src/objectmodel/schema.js";
import { CHANGES, changesBetween } from "../src/releases/changes.js";
import { impactOf } from "../src/releases/impact.js";
import { RRF_BASELINE } from "../src/rrf.js";
import { COMMANDS } from "../src/dictionary/commands.js";

// What changed for a user's files between RRF 3.7.0-rc.1 and 3.7.0-rc.2 - every fact here was read from
// RRF source at the two tags (docs/rrf-triage/3.7.0-rc.1..3.7.0-rc.2.md is the closed checklist, each
// event's `sources` the lines).

const RC1 = "3.7.0-rc.1";
const RC2 = "3.7.0-rc.2";

function eventIds(text: string, from: string, to: string): Array<string> {
	return impactOf(parseDocument(text), from, to).map((f) => f.event.id);
}

function dictionaryDiags(text: string, firmwareVersion = RC2): Array<string> {
	return diagnoseDocument(parseDocument(text), "0:/sys/config.g", { firmwareVersion })
		.filter((d) => d.rule.startsWith("dictionary/"))
		.map((d) => `${d.rule}: ${d.message}`);
}

describe("the baseline moved to 3.7.0-rc.2", () => {
	it("is rc.2", () => {
		expect(RRF_BASELINE).toBe(RC2);
	});

	it("every reviewed dictionary entry was reviewed at a release the baseline has reached", () => {
		for (const spec of Object.values(COMMANDS)) {
			if (spec.reviewed !== undefined) expect(["3.7.0-rc.1", RC2], spec.code).toContain(spec.reviewed);
		}
	});
});

describe("M955 / M956: P is mandatory from 3.7.0-rc.1+1", () => {
	it("flags an M955 line with no P moving to rc.2, at the command", () => {
		const hits = impactOf(parseDocument('M955 C"spi.cs1+spi.cs2" I10\n'), RC1, RC2).filter((f) => f.event.id === "m955-p-required");
		expect(hits).toHaveLength(1);
		expect(hits[0]!.direction).toBe("upgrade");
		expect(hits[0]!.line).toBe(0);
	});

	it("does not flag an M955 line that gives P", () => {
		expect(eventIds('M955 P0 C"spi.cs1+spi.cs2" I10\n', RC1, RC2)).not.toContain("m955-p-required");
	});

	it("flags an M956 line with no P, and not one with P", () => {
		expect(eventIds("M956 S1000 A0\n", RC1, RC2)).toContain("m956-p-required");
		expect(eventIds("M956 P0 S1000 A0\n", RC1, RC2)).not.toContain("m956-p-required");
	});

	it("a P given as an expression still counts as given", () => {
		expect(eventIds("M956 P{0} S1000 A0\n", RC1, RC2)).not.toContain("m956-p-required");
	});

	it("does NOT flag a P-less line going back to rc.1 - it was optional there", () => {
		expect(eventIds('M955 C"spi.cs1+spi.cs2"\n', RC2, RC1)).not.toContain("m955-p-required");
		expect(eventIds("M956 S1000 A0\n", RC2, RC1)).not.toContain("m956-p-required");
	});

	it("is found from a much older firmware too (the absent-P event and the P events are separate targets)", () => {
		const ids = eventIds('M955 C"spi.cs1+spi.cs2"\n', "3.6.3", RC2);
		expect(ids).toContain("m955-p-required");
	});

	it("dictionary/missing-required says so at rc.1+1 and later, and stays quiet at rc.1", () => {
		const line = 'M955 C"spi.cs1+spi.cs2" I10\n';
		expect(dictionaryDiags(line, RC2)).toEqual(["dictionary/missing-required: M955 needs a P parameter"]);
		expect(dictionaryDiags(line, "3.7.0-rc.1+1")).toEqual(["dictionary/missing-required: M955 needs a P parameter"]);
		expect(dictionaryDiags(line, RC1)).toEqual([]);
		expect(dictionaryDiags("M956 S1000 A0\n", RC2)).toEqual(["dictionary/missing-required: M956 needs a P parameter"]);
		expect(dictionaryDiags("M956 S1000 A0\n", RC1)).toEqual([]);
	});
});

describe("the parameters RRF reads that the dictionary now lists", () => {
	it("M955 takes Q, R and S as well as P, C and I", () => {
		expect(dictionaryDiags('M955 P0 C"spi.cs1+spi.cs2" I10 S1600 R12 Q2000000\n')).toEqual([]);
	});

	it("M955's P is 0 to 9", () => {
		expect(dictionaryDiags('M955 P10 C"spi.cs1"\n')).toEqual([expect.stringContaining("M955's P value 10 is outside 0..9")]);
	});

	it("M956 takes F (the file name) and the axis letters", () => {
		expect(dictionaryDiags('M956 P0 S1000 A0 X Y F"accel.csv"\n')).toEqual([]);
	});

	it("M569 takes C, F, B, V, H and Y - the raw driver tuning letters", () => {
		expect(dictionaryDiags("M569 P0.0 S1 D3 C475 F4 B2 V2000 H200 Y5:0\n")).toEqual([]);
		expect(dictionaryDiags("M569 P0.0 C{0x1d5}\n")).toEqual([]);
	});

	it("a bare hex C is split into parameters by RRF's own tokeniser (FindParameters: every letter starts one), so its X is reported", () => {
		expect(dictionaryDiags("M569 P0.0 C0x1d5\n")).toContain("dictionary/unknown-parameter: M569 doesn't have a X parameter");
	});

	it("M569's Y takes 2 or 3 values", () => {
		expect(dictionaryDiags("M569 P0.0 Y5\n")).toEqual([expect.stringContaining("M569's Y takes 2 or 3 colon-separated value(s), not 1")]);
	});

	it("M201 lists T (acceleration time)", () => {
		expect(COMMANDS.M201?.parameters.map((p) => p.letter)).toContain("T");
		expect(dictionaryDiags("M201 X3000 Y3000 T0.05\n")).toEqual([]);
		expect(dictionaryDiags("M201 X3000 T-1\n")).toEqual([expect.stringContaining("M201's T value -1 is outside 0..inf")]);
	});

	it("M959 B<n> alone is a report, not a missing T (T was never required)", () => {
		expect(dictionaryDiags("M959 B1\n")).toEqual([]);
		expect(dictionaryDiags("M959\n")).toEqual([]);
		expect(dictionaryDiags("M959 B1 T30\n")).toEqual([]);
		expect(dictionaryDiags("M959 B1 T2\n")).toEqual([expect.stringContaining("M959's T value 2 is outside 3..65535")]);
		expect(dictionaryDiags("M959 B127 T30\n")).toEqual([expect.stringContaining("M959's B value 127 is outside 1..126")]);
	});

	it("M303's F is 0.1 to 1", () => {
		expect(dictionaryDiags("M303 H1 S200 F0.8\n")).toEqual([]);
		expect(dictionaryDiags("M303 H1 S200 F0.05\n")).toEqual([expect.stringContaining("M303's F value 0.05 is outside 0.1..1")]);
	});
});

describe("impactOf across rc.1 -> rc.2", () => {
	it("M201 T (its new warnings)", () => {
		expect(eventIds("M201 X3000 T0.05\n", RC1, RC2)).toContain("m201-t-warnings");
		expect(eventIds("M201 X3000\n", RC1, RC2)).not.toContain("m201-t-warnings");
	});

	it("M569 C (more CHOPCONF bits take effect)", () => {
		expect(eventIds("M569 P0.0 S1 C0x1d5\n", RC1, RC2)).toContain("m569-c-more-chopconf-bits");
		expect(eventIds("M569 P0.0 S1\n", RC1, RC2)).not.toContain("m569-c-more-chopconf-bits");
	});

	it("M970 and its .1/.2/.3 forms (now on CAN-expansion-capable boards)", () => {
		expect(eventIds("M970\n", RC1, RC2)).toContain("m970-can-expansion-boards");
		expect(eventIds("M970.1 X0.5\n", RC1, RC2)).toContain("m970-1-can-expansion-boards");
		expect(eventIds("M970.2 X0.5\n", RC1, RC2)).toContain("m970-2-can-expansion-boards");
		expect(eventIds("M970.3 P0.1 S4 J1\n", RC1, RC2)).toContain("m970-3-can-expansion-boards");
	});

	it("M303 without F (the default fan PWM went from 0.7 to 0.8) - and with F it doesn't, either way", () => {
		expect(eventIds("M303 H1 S200\n", RC1, RC2)).toContain("m303-f-default");
		expect(eventIds("M303 H1 S200 F0.7\n", RC1, RC2)).not.toContain("m303-f-default");
		expect(eventIds("M303 H1 S200\n", RC2, RC1)).toContain("m303-f-default"); // differs going back too
	});

	it("M959, M309, M581.1 and M669 (behaviour, matched at the command)", () => {
		expect(eventIds("M959 B1 T30\n", RC1, RC2)).toContain("m959-expansion-enforces-timeout");
		expect(eventIds("M309 P0 S0.05\n", RC1, RC2)).toContain("m309-extrusion-feedforward-reworked");
		expect(eventIds('M581.1 T0 P"state.status == \\"printing\\""\n', RC1, RC2)).toContain("m581-1-string-literal-hang");
		expect(eventIds("M669 K5 X0 Y0 P100:100 D200:200\n", RC1, RC2)).toContain("m669-five-bar-own-kinematics-type");
	});

	it("nothing in a document that uses none of it", () => {
		expect(impactOf(parseDocument("G1 X10 Y20\nM106 S255\nM104 S200\n"), RC1, RC2)).toEqual([]);
	});

	it("nothing when the file is already at rc.2", () => {
		expect(eventIds('M955 C"spi.cs1+spi.cs2"\nM303 H1 S200\nM201 T0.05\n', RC2, RC2)).toEqual([]);
	});

	it("the same M955 line jumping from beta.3 gets both the P-optional -> required and the uncapped-P findings", () => {
		const ids = eventIds('M955 C"spi.cs1+spi.cs2"\nM955 P2 C"spi.cs1"\n', "3.7.0-beta.3", RC2);
		expect(ids).toContain("m955-p-required");
		expect(ids).toContain("m955-p-uncapped");
	});
});

describe("the object model: accelerometers moved from boards[] to sensors.accelerometers[]", () => {
	it("boards[].accelerometer.* is gone at rc.2 and was there at rc.1", () => {
		for (const p of ["boards[].accelerometer", "boards[].accelerometer.orientation", "boards[].accelerometer.points", "boards[].accelerometer.resolution", "boards[].accelerometer.runs", "boards[].accelerometer.samplingRate"]) {
			expect(objectModelPath(p, RC1).known, `${p} at rc.1`).toBe(true);
			expect(objectModelPath(p, RC2).known, `${p} at rc.2`).toBe(false);
		}
	});

	it("sensors.accelerometers[] is new at rc.2, with a port member the old model never had", () => {
		for (const p of ["sensors.accelerometers", "sensors.accelerometers[].orientation", "sensors.accelerometers[].points", "sensors.accelerometers[].port", "sensors.accelerometers[].resolution", "sensors.accelerometers[].runs", "sensors.accelerometers[].samplingRate"]) {
			expect(objectModelPath(p, RC1).known, `${p} at rc.1`).toBe(false);
			expect(objectModelPath(p, RC2).known, `${p} at rc.2`).toBe(true);
		}
		expect(objectModelPath("sensors.accelerometers[]", RC2).known).toBe(true); // an element of the array
	});

	it("objectModelChanges lists exactly those 13 paths between rc.1 and rc.2, and the reverse when going back", () => {
		const forward = objectModelChanges(RC1, RC2);
		expect(forward.filter((c) => c.change === "added").map((c) => c.path).sort()).toEqual([
			"sensors.accelerometers", "sensors.accelerometers[].orientation", "sensors.accelerometers[].points", "sensors.accelerometers[].port",
			"sensors.accelerometers[].resolution", "sensors.accelerometers[].runs", "sensors.accelerometers[].samplingRate",
		]);
		expect(forward.filter((c) => c.change === "removed")).toHaveLength(6);
		expect(objectModelChanges(RC2, RC1).filter((c) => c.change === "added")).toHaveLength(6);
	});

	it("an expression reading the old path is flagged with where the data went; the new path is flagged going back", () => {
		const up = impactOf(parseDocument("echo boards[0].accelerometer.runs\n"), RC1, RC2);
		expect(up).toHaveLength(1);
		expect(up[0]!.event.kind).toBe("removed");
		expect(up[0]!.event.description).toContain("moved to sensors.accelerometers[].runs");
		expect(up[0]!.message).toContain("will stop working");

		const down = impactOf(parseDocument("echo sensors.accelerometers[0].runs\n"), RC2, RC1);
		expect(down).toHaveLength(1);
		expect(down[0]!.event.kind).toBe("added");
		expect(down[0]!.message).toContain("is not available");
	});

	it("the diagnostics agree: the old path is unknown at rc.2, the new one unknown at rc.1", () => {
		const unknown = (text: string, v: string) =>
			diagnoseDocument(parseDocument(text), "0:/sys/config.g", { firmwareVersion: v }).filter((d) => d.rule === "objectModel/unknown-path").length;
		expect(unknown("echo boards[0].accelerometer.runs\n", RC1)).toBe(0);
		expect(unknown("echo boards[0].accelerometer.runs\n", RC2)).toBe(1);
		expect(unknown("echo sensors.accelerometers[0].runs\n", RC2)).toBe(0);
		expect(unknown("echo sensors.accelerometers[0].runs\n", RC1)).toBe(1);
	});

	it("the added events cite the RRF source they were read from, not the npm package that lags it", () => {
		const added = CHANGES.find((e) => e.id === "om-sensors.accelerometers-added");
		expect(added?.version).toBe(RC2);
		expect(added?.sources[0]).toContain("RRF 3.7.0-rc.2 Accelerometers/Accelerometers.cpp");
	});
});

describe("object-model values that changed under an unchanged path", () => {
	it("boards[].drivers[].config.direction is a boolean now", () => {
		const hits = impactOf(parseDocument("if boards[0].drivers[0].config.direction == 1\n  M118 S\"fwd\"\nendif\n"), RC1, RC2);
		expect(hits.map((h) => h.event.id)).toContain("om-type-boards-drivers-config-direction");
	});

	it("move.extruders[].percentCurrent / percentStstCurrent read the wrong drive before", () => {
		const ids = eventIds("echo move.extruders[0].percentCurrent\necho move.extruders[0].percentStstCurrent\n", RC1, RC2);
		expect(ids).toContain("om-value-move-extruders-percentcurrent");
		expect(ids).toContain("om-value-move-extruders-percentststcurrent");
		// the axes' own entries were always right
		expect(eventIds("echo move.axes[0].percentCurrent\n", RC1, RC2)).toEqual([]);
	});

	it("heat.heaters[].extrPwmBoost", () => {
		expect(eventIds("echo heat.heaters[1].extrPwmBoost\n", RC1, RC2)).toContain("om-value-heat-heaters-extrpwmboost");
	});
});

describe("events the rc.2 triage added are ordered and dated like the rest", () => {
	it("every rc.2 pass event is inside (rc.1, rc.2] and cites its commit", () => {
		const ids = [
			"m955-p-required", "m956-p-required", "m201-t-warnings", "m569-c-more-chopconf-bits", "m970-can-expansion-boards", "m303-f-default",
			"m959-expansion-enforces-timeout", "m309-extrusion-feedforward-reworked", "m581-1-string-literal-hang",
			"m669-five-bar-own-kinematics-type", "om-type-boards-drivers-config-direction", "fileinfo-preflight-layer-count",
		];
		const between = new Set(changesBetween(RC1, RC2).map((e) => e.id));
		for (const id of ids) {
			expect(between.has(id), id).toBe(true);
			const e = CHANGES.find((x) => x.id === id)!;
			expect(e.sources.join("\n"), id).toMatch(/RRF commits? [0-9a-f]{8,}/);
		}
	});

	it("the code-less preFlight layer_count event is in the changelog but never matched against a document", () => {
		expect(changesBetween(RC1, RC2).map((e) => e.id)).toContain("fileinfo-preflight-layer-count");
		expect(impactOf(parseDocument("; layer_count = 60\nG1 X1\n"), RC1, RC2)).toEqual([]);
	});
});

describe("M308's sensor type on another CAN board (the wiki's rc.2 Y\"board-temp\" example)", () => {
	// TemperatureSensor::Create builds a RemoteSensor for a port on another board before it looks at the type
	// name (Heating/Sensors/TemperatureSensor.cpp:219-221, the same at rc.1 and rc.2), so the main board's own
	// list of type names cannot judge it - the expansion board's firmware decides.
	it("is not checked when P carries another board's CAN address", () => {
		expect(dictionaryDiags('M308 S13 Y"board-temp" P"123.dummy" A"Motor temperature"\n')).toEqual([]);
		expect(dictionaryDiags('M308 S14 Y"some-future-type" P"121.temp0"\n')).toEqual([]);
	});

	it("still is for a local port, and for board 0 (the main board)", () => {
		expect(dictionaryDiags('M308 S13 Y"board-temp" P"temp0"\n')).toEqual([expect.stringContaining("M308's Y value")]);
		expect(dictionaryDiags('M308 S13 Y"board-temp" P"0.temp0"\n')).toEqual([expect.stringContaining("M308's Y value")]);
		expect(dictionaryDiags('M308 S13 Y"board-temp"\n')).toEqual([expect.stringContaining("M308's Y value")]);
	});

	it("a real local type name is still accepted", () => {
		expect(dictionaryDiags('M308 S0 Y"thermistor" P"temp0" T100000 B4138\n')).toEqual([]);
	});
});
