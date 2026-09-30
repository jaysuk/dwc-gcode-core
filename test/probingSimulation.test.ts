import { describe, expect, it } from "vitest";

import { parseDocument } from "../src/document.js";
import { walkExecution } from "../src/execute.js";
import { tokenise } from "../src/lex.js";
import { advance, createState, type InitialMachineState } from "../src/stepper/machineState.js";
import { mergeProbe, probeFromObjectModel } from "../src/stepper/objectModelEndstops.js";
import {
	emptySimulationInputs, isEmptySimulationInputs, runSimulation, simulationInputsFromJSON, simulationInputsToJSON,
	withEndstop, withProbe, type SimulationInputs,
} from "../src/stepper/simulation.js";

const inputs = (over: Partial<SimulationInputs> = {}): SimulationInputs => ({ ...emptySimulationInputs(), ...over });

/** Runs each line as its own step and reports the fault (if any) each one left. */
function walk(lines: Array<string>, initial: InitialMachineState = {}) {
	const state = createState({ initial });
	const faults: Array<string | null> = [];
	for (const line of lines) {
		advance(state, tokenise(line));
		faults.push(state.fault);
	}
	return { state, faults };
}

const NOT_TRIGGERED = "Probe was not triggered during probing move";

describe("failed homing (G28 with an endstop that never triggers)", () => {
	it("homes normally, with no fault, when every endstop triggers", () => {
		const { state, faults } = walk(["G28"]);
		expect(faults).toEqual([null]);
		expect([state.homedX, state.homedY, state.homedZ]).toEqual([true, true, true]);
	});

	it("fails with RRF's message and leaves that axis unhomed", () => {
		// RRF GCodes4.cpp `homing2`: "Failed to home axes " + AppendAxes (letters run together).
		const { state, faults } = walk(["G28 X"], { endstops: { X: { triggers: false } } });
		expect(faults).toEqual(["Failed to home axes X"]);
		expect(state.homedX).toBe(false);
	});

	it("a bare G28 homes the axes that work and names only the ones that don't, in axis order", () => {
		const { state, faults } = walk(["G28"], { endstops: { Z: { triggers: false }, X: { triggers: false } } });
		expect(faults).toEqual(["Failed to home axes XZ"]);
		expect([state.homedX, state.homedY, state.homedZ]).toEqual([false, true, false]);
	});

	it("re-homing an axis that was homed un-homes it when it fails", () => {
		const { state } = walk(["G28 X"], { homed: ["X"], endstops: { X: { triggers: false } } });
		expect(state.homedX).toBe(false);
	});

	it("covers an extra axis, which a bare G28 knows about once it is declared", () => {
		const { state, faults } = walk(["G28"], { axisLetters: ["U"], endstops: { U: { triggers: false } } });
		expect(faults).toEqual(["Failed to home axes U"]);
		expect(state.homedExtra).not.toContain("U");
		expect(state.homedZ).toBe(true);
	});

	it("an axis with no endstop (end: none) still counts as homed by G28 - only triggers:false fails it", () => {
		expect(walk(["G28 Z"], { endstops: { Z: { end: "none" } } }).faults).toEqual([null]);
	});

	it("the next line starts clean", () => {
		const { faults } = walk(["G28 X", "G1 Y5"], { endstops: { X: { triggers: false } } });
		expect(faults).toEqual(["Failed to home axes X", null]);
	});

	it("a G1 H1 whose endstop never triggers is not itself an error: the axis just stays unhomed", () => {
		// RRF only reports "Failed to home" from G28, after the homing macro has run.
		const { state, faults } = walk(["G91", "G1 H1 X-30"], { axes: { X: 100 }, endstops: { X: { triggers: false } } });
		expect(faults).toEqual([null, null]);
		expect(state.homedX).toBe(false);
	});
});

describe("G30 single probe", () => {
	it("sets Z to the trigger height, flags Z homed, and retracts to the dive height above it", () => {
		// RRF GCodes4.cpp `probingAtPoint4`/`4a`: Z = trigger height, SetAxisIsHomed(Z), then Z = GetStartingHeight
		// = diveHeight + trigger height. Defaults: 0.7 and 5 (Configuration.h).
		const { state, faults } = walk(["G30"], { axes: { Z: 50 } });
		expect(faults).toEqual([null]);
		expect(state.z).toBe(5.7);
		expect(state.homedZ).toBe(true);
	});

	it("uses the probe's own trigger and dive heights", () => {
		expect(walk(["G30"], { axes: { Z: 50 }, probe: { triggerHeight: 2.5, diveHeight: 3 } }).state.z).toBe(5.5);
	});

	it("G30 S-1, S-2 and S-3 only report or adjust: Z is not flagged homed", () => {
		for (const s of [-1, -2, -3]) {
			const { state, faults } = walk([`G30 S${s}`], { axes: { Z: 50 } });
			expect(faults).toEqual([null]);
			expect(state.homedZ).toBe(false);
			expect(state.z).toBe(5.7);
		}
	});

	it("G30 P<n> records a mesh point: it neither homes Z nor sets a datum, and X/Y name the point", () => {
		const { state } = walk(["G30 P0 X20 Y30 Z-9999"], { axes: { X: 0, Y: 0, Z: 50 } });
		expect([state.x, state.y]).toEqual([20, 30]);
		expect(state.homedZ).toBe(false);
		expect(state.z).toBe(5.7);
	});

	it("a probe that never triggers fails with RRF's message and leaves Z alone", () => {
		const { state, faults } = walk(["G30"], { axes: { Z: 50 }, probe: { triggers: false } });
		expect(faults).toEqual([NOT_TRIGGERED]);
		expect(state.z).toBe(50);
		expect(state.homedZ).toBe(false);
	});

	it("fails the same way for every variant", () => {
		for (const line of ["G30 S-1", "G30 S-3", "G30 P1 X10 Y10 Z-9999"]) {
			expect(walk([line], { probe: { triggers: false } }).faults).toEqual([NOT_TRIGGERED]);
		}
	});

	it("a failing G30 still goes to the X/Y it names", () => {
		const { state } = walk(["G30 P0 X20 Y30 Z-9999"], { probe: { triggers: false } });
		expect([state.x, state.y]).toEqual([20, 30]);
	});
});

describe("G29 mesh probing", () => {
	const mesh = (line: string, triggers: boolean) => walk([line], { probe: { triggers } }).faults[0];

	it("a probe that never triggers fails G29 and G29 S0", () => {
		expect(mesh("G29", false)).toBe(NOT_TRIGGERED);
		expect(mesh("G29 S0", false)).toBe(NOT_TRIGGERED);
	});

	it("loading, clearing or saving a height map never probes, so it cannot fail", () => {
		for (const s of [1, 2, 3]) expect(mesh(`G29 S${s}`, false)).toBeNull();
	});

	it("succeeds when the probe works", () => {
		expect(mesh("G29", true)).toBeNull();
	});
});

describe("G38.x straight probing", () => {
	it("a downward G38.2 stops at the trigger height", () => {
		const { state, faults } = walk(["G38.2 Z-20 F100"], { axes: { Z: 10 } });
		expect(faults).toEqual([null]);
		expect(state.z).toBe(0.7);
		expect(state.feedrate).toBe(100);
	});

	it("X/Y stop somewhere the file cannot say, so the position becomes unknown", () => {
		const { state } = walk(["G38.3 X50 Y50"], { axes: { X: 0, Y: 0, Z: 10 } });
		expect([state.x, state.y, state.z]).toEqual([null, null, 10]);
	});

	it("probing away (G38.4/G38.5) leaves the stopping height unknown", () => {
		expect(walk(["G38.5 Z20"], { axes: { Z: 0 } }).state.z).toBeNull();
	});

	it("an extra axis named in the move becomes unknown too", () => {
		expect(walk(["G38.2 U-10"], { axes: { U: 5 } }).state.extraAxes.U).toBeUndefined();
	});

	it("a probe that never triggers: G38.2 fails and the move completes at its target", () => {
		const { state, faults } = walk(["G38.2 Z-20"], { axes: { Z: 10 }, probe: { triggers: false } });
		expect(faults).toEqual([NOT_TRIGGERED]);
		expect(state.z).toBe(-20);
	});

	it("G38.4 that never loses contact fails with its own message", () => {
		const { faults } = walk(["G38.4 Z5"], { axes: { Z: 0 }, probe: { triggers: false } });
		expect(faults).toEqual(["Probe did not lose contact during probing move"]);
	});

	it("G38.3 and G38.5 never signal an error: the move just completes", () => {
		for (const line of ["G38.3 Z-20", "G38.5 Z-20"]) {
			const { state, faults } = walk([line], { axes: { Z: 10 }, probe: { triggers: false } });
			expect(faults).toEqual([null]);
			expect(state.z).toBe(-20);
		}
	});

	it("honours G91 for the target", () => {
		const { state } = walk(["G91", "G38.3 Z-5"], { axes: { Z: 10 }, probe: { triggers: false } });
		expect(state.z).toBe(5);
	});
});

describe("the probe model", () => {
	it("is sanitised: anything that isn't a boolean or finite number is dropped", () => {
		const s = createState({ initial: { probe: { triggers: "no", triggerHeight: Number.NaN, diveHeight: 4 } as never } });
		expect(s.probe).toEqual({ diveHeight: 4 });
	});

	it("starts empty, with no fault", () => {
		const s = createState();
		expect(s.probe).toEqual({});
		expect(s.fault).toBeNull();
	});
});

describe("a simulated failure stops the walk like an RRF error", () => {
	it("a failed G28 ends the walk on that line, flagged simulated, with the failing line as the last step", () => {
		const sc = withEndstop(inputs(), "X", { triggers: false });
		const r = runSimulation("G28 X\nG1 Y10", sc);
		expect(r.status).toBe("error");
		if (r.status !== "error") return;
		expect(r.simulated).toBe(true);
		expect(r.message).toBe("Failed to home axes X");
		expect(r.line).toBe(0);
		expect(r.steps.map((s) => s.line)).toEqual([0]);
		expect(r.steps[0]!.state.homedX).toBe(false);
	});

	it("nothing after the failing line runs", () => {
		const sc = withProbe(inputs(), { triggers: false });
		const r = runSimulation("G90\nG30\nG1 X99\nG1 Y99", sc);
		expect(r.status).toBe("error");
		expect(r.steps.map((s) => s.line)).toEqual([0, 1]);
	});

	it("a probe that works lets the walk carry on, with the machine's trigger height", () => {
		const r = runSimulation("G30\nif move.axes[2].homed\n    G1 X5", inputs(), { machineProbe: { triggerHeight: 1.2, diveHeight: 4 } });
		expect(r.status).toBe("complete");
		expect(r.steps[0]!.state.z).toBe(5.2);
		expect(r.steps.some((s) => s.line === 2)).toBe(true);
	});

	it("an ordinary document error is not flagged simulated", () => {
		const r = runSimulation("else\nG1 X1", inputs());
		expect(r.status).toBe("error");
		if (r.status === "error") expect(r.simulated).toBeUndefined();
	});

	it("a failure inside a loop body stops everything, not just that iteration", () => {
		const sc = withProbe(inputs(), { triggers: false });
		const r = runSimulation("var n = 0\nwhile var.n < 3\n    G30\n    set var.n = var.n + 1", sc);
		expect(r.status).toBe("error");
		expect(r.steps.filter((s) => s.line === 2)).toHaveLength(1);
	});

	it("scenario settings override the machine's field by field", () => {
		const sc = withProbe(inputs(), { diveHeight: 10 });
		const r = runSimulation("G30", sc, { machineProbe: { triggerHeight: 2, diveHeight: 4 } });
		expect(r.steps[0]!.state.z).toBe(12);
	});
});

describe("editing the probe model", () => {
	it("withProbe merges fields, removes one given as undefined, and drops an emptied model", () => {
		let sc = withProbe(inputs(), { triggers: false, triggerHeight: 2 });
		sc = withProbe(sc, { diveHeight: 6 });
		expect(sc.start.probe).toEqual({ triggers: false, triggerHeight: 2, diveHeight: 6 });
		sc = withProbe(sc, { triggers: undefined });
		expect(sc.start.probe).toEqual({ triggerHeight: 2, diveHeight: 6 });
		sc = withProbe(sc, null);
		expect(sc.start.probe).toBeUndefined();
		expect(isEmptySimulationInputs(sc)).toBe(true);
	});

	it("a probe model counts as a non-empty scenario and survives the JSON round trip", () => {
		const sc = withProbe(inputs(), { triggers: false, triggerHeight: 1.5 });
		expect(isEmptySimulationInputs(sc)).toBe(false);
		const back = simulationInputsFromJSON(JSON.parse(JSON.stringify(simulationInputsToJSON(sc))));
		expect(back?.start.probe).toEqual({ triggers: false, triggerHeight: 1.5 });
	});

	it("drops a hand-edited probe entry that is nonsense", () => {
		const json = simulationInputsToJSON(inputs());
		const back = simulationInputsFromJSON({ ...json, start: { probe: { triggers: "yes", triggerHeight: "tall" } } });
		expect(back?.start.probe).toBeUndefined();
	});
});

describe("probeFromObjectModel", () => {
	it("reads the trigger height and the first dive height of probe 0", () => {
		const m = { sensors: { probes: [{ type: 8, triggerHeight: 1.25, diveHeights: [4, 2] }, { triggerHeight: 9 }] } };
		expect(probeFromObjectModel(m)).toEqual({ triggerHeight: 1.25, diveHeight: 4 });
	});

	it("falls back to the older single diveHeight", () => {
		expect(probeFromObjectModel({ sensors: { probes: [{ triggerHeight: 0.5, diveHeight: 7 }] } })).toEqual({ triggerHeight: 0.5, diveHeight: 7 });
	});

	it("gives nothing for a machine with no probe, a null entry, or no model at all", () => {
		expect(probeFromObjectModel({ sensors: { probes: [] } })).toEqual({});
		expect(probeFromObjectModel({ sensors: { probes: [null] } })).toEqual({});
		expect(probeFromObjectModel({})).toEqual({});
		expect(probeFromObjectModel(undefined)).toEqual({});
	});

	it("never says the probe fails: that is a what-if", () => {
		expect(probeFromObjectModel({ sensors: { probes: [{ triggerHeight: 1, triggers: false }] } })).toEqual({ triggerHeight: 1 });
	});

	it("skips a field that is not a number", () => {
		expect(probeFromObjectModel({ sensors: { probes: [{ triggerHeight: "1", diveHeights: [null] }] } })).toEqual({});
	});
});

describe("mergeProbe", () => {
	it("lays the scenario over the machine field by field", () => {
		expect(mergeProbe({ triggerHeight: 2, diveHeight: 4 }, { diveHeight: 9, triggers: false })).toEqual({ triggerHeight: 2, diveHeight: 9, triggers: false });
	});

	it("an explicit undefined on one side never blanks the other", () => {
		expect(mergeProbe({ triggerHeight: 2 }, { triggerHeight: undefined })).toEqual({ triggerHeight: 2 });
	});

	it("copes with either side missing", () => {
		expect(mergeProbe(undefined, undefined)).toEqual({});
		expect(mergeProbe({ diveHeight: 3 }, undefined)).toEqual({ diveHeight: 3 });
	});
});

describe("walkExecution's checkStep", () => {
	const doc = parseDocument("G1 X1\nG1 X2\nG1 X3");

	it("stops with a simulated error on the step it fails, after recording it and running onStep", () => {
		const seen: Array<number> = [];
		const r = walkExecution(doc, {
			resolvePath: () => 0,
			onStep: (s) => { seen.push(s.line); },
			checkStep: (s) => (s.line === 1 ? "boom" : undefined),
		});
		expect(r).toMatchObject({ status: "error", line: 1, message: "boom", simulated: true });
		expect(r.steps.map((s) => s.line)).toEqual([0, 1]);
		expect(seen).toEqual([0, 1]);
	});

	it("an onStep that happens to return a value, such as an arrow over Array.push, is unaffected", () => {
		const seen: Array<unknown> = [];
		const r = walkExecution(doc, { resolvePath: () => 0, onStep: (s) => seen.push(s) });
		expect(r.status).toBe("complete");
		expect(seen).toHaveLength(3);
	});
});
