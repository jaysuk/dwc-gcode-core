import { describe, expect, it } from "vitest";

import { advance, createState, type InitialMachineState } from "../src/stepper/machineState.js";
import { tokenise } from "../src/lex.js";

function run(lines: Array<string>) {
	const state = createState();
	const seen: Array<{ line: string; layer: number; z: number | null; changed: boolean }> = [];
	for (const line of lines) {
		advance(state, tokenise(line));
		seen.push({ line, layer: state.layer, z: state.z, changed: state.layerChanged });
	}
	return { state, seen };
}

describe("layer tracking", () => {
	it("counts PrusaSlicer LAYER_CHANGE markers", () => {
		const { state } = run([";LAYER_CHANGE", "G1 Z0.2", ";LAYER_CHANGE", "G1 Z0.4"]);
		expect(state.layer).toBe(1);
		expect(state.sawLayerMarker).toBe(true);
	});

	it("does not treat BEFORE/AFTER_LAYER_CHANGE as extra layers", () => {
		// Prusa emits all three around one layer boundary; counting them all trebles the count
		const { state } = run([";BEFORE_LAYER_CHANGE", ";LAYER_CHANGE", ";AFTER_LAYER_CHANGE"]);
		expect(state.layer).toBe(0);
	});

	it("reads Cura's absolute layer index", () => {
		const { state } = run([";LAYER:0", ";LAYER:1", ";LAYER:7"]);
		expect(state.layer).toBe(7);
	});

	it("normalises Simplify3D's 1-based numbering", () => {
		const { state } = run(["; layer 1, Z = 0.2", "; layer 2, Z = 0.4"]);
		expect(state.layer).toBe(1);
	});

	it("falls back to Z-only rises when the file has no markers", () => {
		const { state } = run(["G1 Z0.2", "G1 X10 Y10", "G1 Z0.4", "G1 X20 Y20"]);
		expect(state.layer).toBe(1);
	});

	it("does not count a Z-lift that also travels in XY as a layer", () => {
		const { state } = run(["G1 Z0.2", "G1 X10 Y10 Z0.6", "G1 X20 Y20 Z0.2"]);
		expect(state.layer).toBe(0);
	});

	it("discards the geometric count when the first marker arrives", () => {
		// Real start G-code moves Z before the first marker; counting it puts every layer out by one
		const { state } = run(["G1 Z0.2", ";BEFORE_LAYER_CHANGE", ";LAYER_CHANGE", ";AFTER_LAYER_CHANGE", "G1 Z0.4"]);
		expect(state.layer).toBe(0);
	});

	it("never guesses at all when the pre-scan found markers", () => {
		// The belt to the reset's braces: a step anchored to "every layer" must not fire on the
		// start block's Z move before the first marker
		const state = createState({ geometricFallback: false });
		const seen: Array<boolean> = [];
		for (const line of ["G1 Z0.2", "G1 Z0.4", ";LAYER_CHANGE", "G1 Z0.6"]) {
			advance(state, tokenise(line));
			seen.push(state.layerChanged);
		}
		expect(seen).toEqual([false, false, true, false]);
		expect(state.layer).toBe(0);
	});

	it("stops the geometric fallback once a marker appears", () => {
		const { state } = run([";LAYER_CHANGE", "G1 Z0.2", "G1 Z1.0", "G1 Z2.0"]);
		expect(state.layer).toBe(0);
	});

	it("flags the line the layer changed on", () => {
		const { seen } = run([";LAYER_CHANGE", "G1 Z0.2"]);
		expect(seen[0].changed).toBe(true);
		expect(seen[1].changed).toBe(false);
	});
});

describe("machine state", () => {
	it("tracks the active tool", () => {
		const { state } = run(["T0", "G1 X1", "T1"]);
		expect(state.tool).toBe(1);
	});

	it("tracks relative extrusion mode", () => {
		expect(run(["M83"]).state.relativeE).toBe(true);
		expect(run(["M83", "M82"]).state.relativeE).toBe(false);
	});

	it("tracks relative axis mode and applies it to Z", () => {
		const { state } = run(["G90", "G1 Z1", "G91", "G1 Z0.5"]);
		expect(state.z).toBeCloseTo(1.5);
	});

	it("takes Z from G92", () => {
		expect(run(["G1 Z5", "G92 Z0"]).state.z).toBe(0);
	});

	it("tracks the feedrate", () => {
		expect(run(["G1 X1 F1200", "G1 X2"]).state.feedrate).toBe(1200);
	});

	it("tracks the M486 object by number and by label", () => {
		expect(run(["M486 S2"]).state.object).toBe("2");
		expect(run(["M486 S2 A\"handle\""]).state.object).toBe("handle");
		expect(run(["M486 S2", "M486 S-1"]).state.object).toBeNull();
	});

	it("tracks the slicer feature type", () => {
		expect(run([";TYPE:External perimeter"]).state.featureType).toBe("External perimeter");
	});

	it("counts lines from 1", () => {
		expect(run(["G1 X1", "G1 X2"]).state.lineNo).toBe(2);
	});
});

describe("position tracking", () => {
	it("is null before any move on that axis", () => {
		const state = createState();
		expect(state.x).toBeNull();
		expect(state.y).toBeNull();
		expect(state.e).toBeNull();
	});

	it("tracks absolute X/Y from G1", () => {
		const { state } = run(["G1 X10 Y20", "G1 X15"]);
		expect(state.x).toBe(15);
		expect(state.y).toBe(20); // unmentioned on the second move - stays where it was
	});

	it("accumulates X/Y under G91, same as Z already does", () => {
		const { state } = run(["G90", "G1 X10 Y10", "G91", "G1 X1 Y-2"]);
		expect(state.x).toBeCloseTo(11);
		expect(state.y).toBeCloseTo(8);
	});

	it("tracks extrusion, absolute by default and accumulating under M83", () => {
		const { state } = run(["G1 X10 E5", "G1 X20 E8"]);
		expect(state.e).toBe(8); // absolute E - the second move's E is a new total, not a delta

		const relative = run(["M83", "G1 X10 E1", "G1 X20 E1.5"]).state;
		expect(relative.e).toBeCloseTo(2.5);
	});

	it("G92 sets X/Y/Z/E outright, regardless of G90/G91", () => {
		const { state } = run(["G91", "G1 X5", "G92 X0 Y0 Z0 E0"]);
		expect(state.x).toBe(0);
		expect(state.y).toBe(0);
		expect(state.z).toBe(0);
		expect(state.e).toBe(0);
	});

	it("G2/G3 arc moves update the destination position the same way G1 does", () => {
		const g2 = run(["G1 X0 Y0", "G2 X10 Y10 I5 J0"]).state;
		expect(g2.x).toBe(10);
		expect(g2.y).toBe(10);

		const g3 = run(["G1 X0 Y0", "G3 X10 Y0 I5 J0"]).state;
		expect(g3.x).toBe(10);
		expect(g3.y).toBe(0);
	});

	it("an arc move does NOT trigger the geometric layer-change fallback, unlike a plain G1 Z rise", () => {
		// Deliberate scope boundary (see state.ts's own comment on the G2/G3 case) - not asserting
		// arcs never change layers, just that this fallback specifically doesn't guess at it.
		const { state } = run(["G1 Z0.2", "G2 X10 Y10 Z0.4 I5 J0"]);
		expect(state.layer).toBe(0);
		expect(state.z).toBeCloseTo(0.4);
	});
});

describe("homing tracking (G28)", () => {
	it("starts unhomed", () => {
		const state = createState();
		expect(state.homedX).toBe(false);
		expect(state.homedY).toBe(false);
		expect(state.homedZ).toBe(false);
	});

	it("a bare G28 homes all three axes", () => {
		const { state } = run(["G28"]);
		expect(state.homedX).toBe(true);
		expect(state.homedY).toBe(true);
		expect(state.homedZ).toBe(true);
	});

	it("G28 with named axes only homes those", () => {
		const { state } = run(["G28 X Y"]);
		expect(state.homedX).toBe(true);
		expect(state.homedY).toBe(true);
		expect(state.homedZ).toBe(false);
	});

	it("a single-axis G28 doesn't un-home the others", () => {
		const { state } = run(["G28", "G28 X"]);
		expect(state.homedX).toBe(true);
		expect(state.homedY).toBe(true);
		expect(state.homedZ).toBe(true);
	});
});

describe("homing moves (G1 H1) against a modelled endstop", () => {
	function homing(lines: Array<string>, initial: InitialMachineState = {}) {
		const state = createState({ initial });
		for (const line of lines) advance(state, tokenise(line));
		return state;
	}

	it("puts the axis at RRF's default minimum and homes it when the move heads negative", () => {
		// RRF 3.7.0-rc.1 GCodes4.cpp: a triggered low-end endstop sets the axis to AxisMinimum (default 0).
		const s = homing(["G91", "G1 H1 X-300 F3000"], { axes: { X: 150 } });
		expect(s.x).toBe(0);
		expect(s.homedX).toBe(true);
	});

	it("puts the axis at RRF's default maximum when the move heads positive", () => {
		const s = homing(["G91", "G1 H1 Y400"], { axes: { Y: 10 } });
		expect(s.y).toBe(200);
		expect(s.homedY).toBe(true);
	});

	it("uses the scenario's M208 limits and M574 end instead of guessing from direction", () => {
		const s = homing(["G91", "G1 H1 Z-500"], { axes: { Z: 50 }, endstops: { Z: { end: "high", max: 250, min: -5 } } });
		expect(s.z).toBe(250); // a high-end endstop even though the move went down
		expect(s.homedZ).toBe(true);
		const t = homing(["G91", "G1 H1 Z-500"], { axes: { Z: 50 }, endstops: { Z: { min: -5 } } });
		expect(t.z).toBe(-5);
	});

	it("works out the direction from the target in absolute mode when the position is known", () => {
		expect(homing(["G1 H1 X-10"], { axes: { X: 50 } }).x).toBe(0);
		expect(homing(["G1 H1 X999"], { axes: { X: 50 } }).x).toBe(200);
	});

	it("an endstop that never triggers lets the move finish at its target, not homed", () => {
		const s = homing(["G91", "G1 H1 X-30"], { axes: { X: 100 }, endstops: { X: { triggers: false } } });
		expect(s.x).toBe(70);
		expect(s.homedX).toBe(false);
	});

	it("an axis with no endstop never triggers either", () => {
		const s = homing(["G91", "G1 H1 X-30"], { axes: { X: 100 }, endstops: { X: { end: "none" } } });
		expect(s.x).toBe(70);
		expect(s.homedX).toBe(false);
	});

	it("only the axes named in the move are affected, each by its own endstop", () => {
		const s = homing(["G91", "G1 H1 X-300 Y300"], { axes: { X: 90, Y: 90, Z: 7 }, endstops: { Y: { end: "high", max: 310 } } });
		expect([s.x, s.y, s.z]).toEqual([0, 310, 7]);
		expect([s.homedX, s.homedY, s.homedZ]).toEqual([true, true, false]);
	});

	it("homes an extra axis too", () => {
		const s = homing(["G91", "G1 H1 U-100"], { axes: { U: 40 }, endstops: { U: { min: 2 } } });
		expect(s.extraAxes.U).toBe(2);
		expect(s.homedExtra).toContain("U");
	});

	it("only H1 is a homing move: H2 (raw motor), H3 and H4 just move", () => {
		for (const h of [2, 3, 4]) {
			const s = homing(["G91", `G1 H${h} X-30`], { axes: { X: 100 } });
			expect(s.x).toBe(70);
			expect(s.homedX).toBe(false);
		}
	});

	it("a homing Z move is not counted as a layer change by the geometric fallback", () => {
		const s = homing(["G1 H1 Z500"], { axes: { Z: 0 } });
		expect(s.layer).toBe(-1);
	});

	it("sanitises a hand-edited endstop model rather than trusting it", () => {
		const s = createState({ initial: { endstops: { X: { end: "sideways", min: Number.NaN, max: 9 }, Q: { min: 1 }, Y: 5 } as never } });
		expect(s.endstops).toEqual({ X: { max: 9 } });
	});

	it("G28 still homes without modelling anything", () => {
		const s = homing(["G28 X"]);
		expect(s.homedX).toBe(true);
		expect(s.x).toBeNull();
	});
});
