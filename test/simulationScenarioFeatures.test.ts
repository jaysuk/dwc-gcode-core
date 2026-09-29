import { describe, expect, it } from "vitest";

import { messageBoxKey } from "../src/stepper/messageBoxAnswers.js";
import {
	describeStep, emptySimulationInputs, findReferencedInputs, isEmptySimulationInputs, runSimulation,
	simulationInputsFromJSON, simulationInputsToJSON, sourceLines, withEndstop, withStartLine, type SimulationInputs,
} from "../src/stepper/simulation.js";

const doc = (...lines: Array<string>): string => lines.join("\n");

function inputs(over: Partial<SimulationInputs> = {}): SimulationInputs {
	return { ...emptySimulationInputs(), ...over };
}

describe("beginning at a chosen line", () => {
	const macro = doc(
		"var pos = 0",
		"if sensors.gpIn[0].value > 0",
		"    G1 X10",
		"    G1 X20",
		"else",
		"    G1 X30",
		"G1 Y5",
	);

	it("runs from that line only, skipping what came before without evaluating it", () => {
		// Line 2 ('if') would pause on an unset sensor - starting after it must not.
		const r = runSimulation(macro, inputs({ startLine: 7 }));
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([6]);
	});

	it("starting inside a branch resumes that branch (1-based, like the editor's line numbers)", () => {
		const r = runSimulation(macro, inputs({ startLine: 4, start: { axes: { X: 10 } } }));
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([3, 4, 6]); // rest of the arm, the else header, then the tail
		expect(r.steps[0]!.state.x).toBe(20);
	});

	it("no startLine is line 1, as before", () => {
		expect(runSimulation("G1 X1\nG1 X2", inputs()).steps.map((s) => s.line)).toEqual([0, 1]);
	});

	it("survives a JSON round trip, and a bad value is dropped rather than trusted", () => {
		const back = simulationInputsFromJSON(simulationInputsToJSON(inputs({ startLine: 12 })));
		expect(back?.startLine).toBe(12);
		for (const bad of [0, -3, 2.5, "7", null]) {
			const json = { ...simulationInputsToJSON(inputs()), startLine: bad };
			expect(simulationInputsFromJSON(json)?.startLine).toBeUndefined();
		}
		expect("startLine" in simulationInputsToJSON(inputs())).toBe(false);
	});

	it("withStartLine sets, and clears with null or anything that is not a line number", () => {
		expect(withStartLine(inputs(), 5).startLine).toBe(5);
		expect(withStartLine(inputs({ startLine: 5 }), null).startLine).toBeUndefined();
		expect(withStartLine(inputs({ startLine: 5 }), 0).startLine).toBeUndefined();
		expect(withStartLine(inputs({ startLine: 5 }), 1.5).startLine).toBeUndefined();
	});

	it("a start line counts as something set", () => {
		expect(isEmptySimulationInputs(inputs({ startLine: 3 }))).toBe(false);
	});

	it("findReferencedInputs ignores lines before it and stops treating earlier declarations as declared", () => {
		const text = doc("var n = 1", "echo var.n", "G1 X{sensors.a}", "echo var.n", "G1 X{sensors.b}");
		// Whole file: var.n is declared on line 1, so only the two sensors are inputs.
		expect(findReferencedInputs(text).map((r) => r.name)).toEqual(["sensors.a", "sensors.b"]);
		// From line 4: the declaration is skipped, so var.n needs a value; sensors.a is never reached.
		const from4 = findReferencedInputs(text, { startLine: 4 });
		expect(from4.map((r) => `${r.kind}:${r.name}`)).toEqual(["var:n", "objectModel:sensors.b"]);
	});

	it("describeStep still reports the scenario's own starting state as the state before the first step", () => {
		const text = "G1 X99\nG1 X7";
		const sc = inputs({ startLine: 2, start: { axes: { X: 5 } } });
		const view = describeStep(runSimulation(text, sc), 0, sourceLines(text), sc);
		expect(view?.line).toBe(2);
		expect(view?.previousState.x).toBe(5);
		expect(view?.axes.find((a) => a.letter === "X")?.delta).toBe(2);
	});
});

describe("homing moves in a walked macro", () => {
	const homeX = doc("if !move.axes[0].homed", "    G91", "    G1 H1 X-300 F3000", "    G90", "G1 X10");

	it("G1 H1 homes the axis, so a later check of move.axes[0].homed sees it", () => {
		const sc = inputs({ start: { axes: { X: 120 } } });
		const r = runSimulation(doc(homeX, "if move.axes[0].homed", "    G1 Y1"), sc);
		expect(r.status).toBe("complete");
		const afterHoming = r.steps.find((s) => s.line === 2)!;
		expect(afterHoming.state.x).toBe(0);
		expect(afterHoming.state.homedX).toBe(true);
		expect(r.steps.some((s) => s.line === 6)).toBe(true); // the "if homed" body ran
	});

	it("uses the scenario's endstop model: an M208 max and a high-end endstop", () => {
		const sc = inputs({ start: { axes: { X: 50 }, endstops: { X: { end: "high", max: 305 } } } });
		const r = runSimulation("G91\nG1 H1 X400", sc);
		expect(r.steps[1]!.state.x).toBe(305);
	});

	it("an endstop that doesn't trigger leaves the axis unhomed at the commanded position", () => {
		const sc = withEndstop(inputs({ start: { axes: { X: 120 } } }), "X", { triggers: false });
		const r = runSimulation("G91\nG1 H1 X-30", sc);
		expect(r.steps[1]!.state.x).toBe(90);
		expect(r.steps[1]!.state.homedX).toBe(false);
	});
});

describe("editing the endstop model", () => {
	it("withEndstop merges fields, and removes one given as undefined", () => {
		let sc = withEndstop(inputs(), "Z", { end: "high", max: 250 });
		sc = withEndstop(sc, "Z", { min: -2 });
		expect(sc.start.endstops).toEqual({ Z: { end: "high", max: 250, min: -2 } });
		sc = withEndstop(sc, "Z", { end: undefined });
		expect(sc.start.endstops).toEqual({ Z: { max: 250, min: -2 } });
	});

	it("an axis left with no settings is dropped, and so is the whole map when empty", () => {
		const sc = withEndstop(withEndstop(inputs(), "X", { min: 3 }), "X", { min: undefined });
		expect(sc.start.endstops).toBeUndefined();
		expect(isEmptySimulationInputs(sc)).toBe(true);
	});

	it("null removes an axis's whole model", () => {
		const sc = withEndstop(withEndstop(inputs(), "X", { min: 3 }), "Y", { max: 9 });
		expect(withEndstop(sc, "X", null).start.endstops).toEqual({ Y: { max: 9 } });
	});

	it("ignores a bad field rather than storing it", () => {
		const sc = withEndstop(inputs(), "X", { min: Number.NaN, end: "sideways" as never });
		expect(sc.start.endstops).toBeUndefined();
	});

	it("survives the JSON round trip", () => {
		const sc = withEndstop(inputs(), "Y", { end: "low", min: -4, triggers: false });
		const back = simulationInputsFromJSON(JSON.parse(JSON.stringify(simulationInputsToJSON(sc))));
		expect(back?.start.endstops).toEqual({ Y: { end: "low", min: -4, triggers: false } });
	});

	it("a scenario saved before endstops existed still loads", () => {
		const old = { kind: "dwc-gcode-simulation-inputs", schemaVersion: 1, start: { axes: { X: 1 } }, paths: {}, globals: {}, vars: {}, messageBoxAnswers: {} };
		const back = simulationInputsFromJSON(old);
		expect(back?.start.axes).toEqual({ X: 1 });
		expect(back?.start.endstops).toBeUndefined();
	});
});

describe("M291 in the line as evaluated", () => {
	it("shows the evaluated message and title in the line, and pauses with them", () => {
		const text = 'M291 P{"Set " ^ var.n} R{"T" ^ var.n} S2';
		const sc = inputs({ vars: new Map([["n", 3]]) });
		const paused = runSimulation(text, sc);
		expect(paused).toMatchObject({ status: "message-box", prompt: { message: "Set 3", title: "T3" } });
		if (paused.status !== "message-box") throw new Error("expected a paused message box");
		const answers = new Map([[messageBoxKey(paused.prompt), { input: null, cancelled: false }]]);
		const answered = runSimulation(text, { ...sc, messageBoxAnswers: answers });
		expect(answered.status).toBe("complete");
		const view = describeStep(answered, 0, sourceLines(text), sc);
		expect(view?.evaluated.text).toBe('M291 P"Set 3" R"T3" S2');
		expect(view?.evaluated.changed).toBe(true);
	});
});
