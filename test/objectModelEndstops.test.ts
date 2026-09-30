import { describe, expect, it } from "vitest";

import { endstopsFromObjectModel, mergeEndstops } from "../src/stepper/objectModelEndstops.js";
import { emptySimulationInputs, runSimulation, withEndstop, type SimulationInputs } from "../src/stepper/simulation.js";

const inputs = (over: Partial<SimulationInputs> = {}): SimulationInputs => ({ ...emptySimulationInputs(), ...over });

/** The bits of a real object model this reads: `move.axes[]` and `sensors.endstops[]`, same order. */
function machine(): unknown {
	return {
		move: {
			axes: [
				{ letter: "X", min: -10, max: 235, homed: true },
				{ letter: "Y", min: 0, max: 210 },
				{ letter: "Z", min: 0, max: 300 },
			],
		},
		sensors: {
			endstops: [
				{ highEnd: false, triggered: false, type: "inputPin" },
				{ highEnd: false, triggered: false, type: "inputPin" },
				{ highEnd: true, triggered: false, type: "zProbeAsEndstop", probe: 0 },
			],
		},
	};
}

describe("endstopsFromObjectModel", () => {
	it("takes each axis's limits and which end its endstop is at, matching the two arrays by index", () => {
		expect(endstopsFromObjectModel(machine())).toEqual({
			X: { end: "low", min: -10, max: 235 },
			Y: { end: "low", min: 0, max: 210 },
			Z: { end: "high", min: 0, max: 300 },
		});
	});

	it("a null endstop entry is an axis with no endstop", () => {
		const m = machine() as { sensors: { endstops: Array<unknown> } };
		m.sensors.endstops[1] = null;
		expect(endstopsFromObjectModel(m).Y).toEqual({ end: "none", min: 0, max: 210 });
	});

	it("takes the letters from move.axes, so an extra axis lands on its own letter", () => {
		const m = {
			move: { axes: [{ letter: "X", min: 0, max: 200 }, { letter: "Y", min: 0, max: 200 }, { letter: "Z", min: 0, max: 200 }, { letter: "U", min: 5, max: 90 }] },
			sensors: { endstops: [null, null, null, { highEnd: true }] },
		};
		const got = endstopsFromObjectModel(m);
		expect(got.U).toEqual({ end: "high", min: 5, max: 90 });
		expect(got.X).toEqual({ end: "none", min: 0, max: 200 });
	});

	it("says nothing about `end` when sensors.endstops is missing, and nothing about limits that are not numbers", () => {
		const m = { move: { axes: [{ letter: "X", min: 3, max: "far" }] } };
		expect(endstopsFromObjectModel(m)).toEqual({ X: { min: 3 } });
	});

	it("an entry with no boolean highEnd leaves `end` unset rather than guessing", () => {
		const m = { move: { axes: [{ letter: "X" }] }, sensors: { endstops: [{ type: "unknown" }] } };
		expect(endstopsFromObjectModel(m)).toEqual({});
	});

	it("a lowercase axis letter cannot overwrite the uppercase axis of the same name", () => {
		const m = { move: { axes: [{ letter: "A", min: 0, max: 10 }, { letter: "a", min: 50, max: 60 }] } };
		expect(endstopsFromObjectModel(m)).toEqual({ A: { min: 0, max: 10 } });
	});

	it("is quiet about a model that is not there, is empty, or is the wrong shape", () => {
		for (const bad of [undefined, null, 5, "x", [], {}, { move: {} }, { move: { axes: {} } }, { move: { axes: [null, 3, { letter: 4 }] } }]) {
			expect(endstopsFromObjectModel(bad)).toEqual({});
		}
	});

	it("never sets `triggers`: whether an endstop fires is the scenario's what-if", () => {
		for (const model of Object.values(endstopsFromObjectModel(machine()))) expect("triggers" in model).toBe(false);
	});
});

describe("mergeEndstops", () => {
	it("lays the scenario over the machine field by field", () => {
		const merged = mergeEndstops({ X: { end: "low", min: 0, max: 200 } }, { X: { max: 305 }, Y: { triggers: false } });
		expect(merged).toEqual({ X: { end: "low", min: 0, max: 305 }, Y: { triggers: false } });
	});

	it("either side may be absent, and an explicit undefined field does not blank the other side", () => {
		expect(mergeEndstops(undefined, undefined)).toEqual({});
		expect(mergeEndstops({ Z: { end: "high" } }, undefined)).toEqual({ Z: { end: "high" } });
		expect(mergeEndstops({ Z: { end: "high" } }, { Z: { end: undefined, min: 1 } })).toEqual({ Z: { end: "high", min: 1 } });
	});
});

describe("runSimulation with the machine's endstops", () => {
	it("a G1 H1 lands where the machine's endstop is, with the machine's limits", () => {
		const machineEndstops = endstopsFromObjectModel(machine());
		// Z's endstop is at the HIGH end (a bed that homes up): heading downwards makes no difference.
		const z = runSimulation("G91\nG1 H1 Z-400", inputs({ start: { axes: { Z: 100 } } }), { machineEndstops });
		expect(z.steps[1]!.state.z).toBe(300);
		expect(z.steps[1]!.state.homedZ).toBe(true);
		// X's is at the low end and its minimum is -10, not RRF's default 0.
		const x = runSimulation("G91\nG1 H1 X-400", inputs({ start: { axes: { X: 100 } } }), { machineEndstops });
		expect(x.steps[1]!.state.x).toBe(-10);
	});

	it("without the machine's endstops it is still the heading-based default, as before", () => {
		const z = runSimulation("G91\nG1 H1 Z-400", inputs({ start: { axes: { Z: 100 } } }));
		expect(z.steps[1]!.state.z).toBe(0);
	});

	it("an axis the machine says has no endstop is not homed by G1 H1", () => {
		const m = machine() as { sensors: { endstops: Array<unknown> } };
		m.sensors.endstops[0] = null;
		const r = runSimulation("G91\nG1 H1 X-30", inputs({ start: { axes: { X: 100 } } }), { machineEndstops: endstopsFromObjectModel(m) });
		expect(r.steps[1]!.state.x).toBe(70);
		expect(r.steps[1]!.state.homedX).toBe(false);
	});

	it("the scenario overrides the machine, per field", () => {
		const machineEndstops = endstopsFromObjectModel(machine());
		const sc = withEndstop(inputs({ start: { axes: { Z: 100 } } }), "Z", { max: 250 });
		const r = runSimulation("G91\nG1 H1 Z-400", sc, { machineEndstops });
		expect(r.steps[1]!.state.z).toBe(250); // the scenario's max, the machine's high end
		const flipped = runSimulation("G91\nG1 H1 Z-400", withEndstop(inputs({ start: { axes: { Z: 100 } } }), "Z", { end: "low" }), { machineEndstops });
		expect(flipped.steps[1]!.state.z).toBe(0); // the scenario's end, the machine's (default) minimum
	});

	it("the scenario's own start.endstops object is not modified", () => {
		const sc = withEndstop(inputs(), "Z", { max: 250 });
		runSimulation("G1 H1 Z5", sc, { machineEndstops: endstopsFromObjectModel(machine()) });
		expect(sc.start.endstops).toEqual({ Z: { max: 250 } });
	});
});
