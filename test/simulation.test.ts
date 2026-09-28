import { describe, expect, it } from "vitest";

import { UnresolvedPathError, type EvalValue } from "../src/expr/evaluate.js";
import { UnresolvedMessageBoxError, walkExecution } from "../src/execute.js";
import { parseDocument } from "../src/document.js";
import { buildExecutionIndex, resolveKnownPath } from "../src/stepper/executionIndex.js";
import { createState } from "../src/stepper/machineState.js";
import { messageBoxKey } from "../src/stepper/messageBoxAnswers.js";
import { parseSimulatedValueInput } from "../src/stepper/simulatedValues.js";
import {
	axisReadouts, describeStep, emptySimulationInputs, findReferencedInputs, formatEvalValue, formatParamValue,
	getInputValue, isEmptySimulationInputs, renderEvaluatedLine, runSimulation, simulationInputsFromJSON,
	simulationInputsToJSON, sourceLines, variableChanges, withDeclaredAxis, withInputValue, withStartAxis,
	withStartHomed, withStartMode, withStartValue, type SimulationInputs,
} from "../src/stepper/simulation.js";

const doc = (...lines: Array<string>): string => lines.join("\n");

function inputs(over: Partial<SimulationInputs> = {}): SimulationInputs {
	return { ...emptySimulationInputs(), ...over };
}

function noOverrides(): (path: string) => EvalValue {
	return (path) => { throw new UnresolvedPathError(path); };
}
function noBoxes(): () => never {
	return () => { throw new UnresolvedMessageBoxError(); };
}

describe("a starting position", () => {
	it("gives a relative move something to be relative to", () => {
		const r = runSimulation(doc("G91", "G1 X5 Y-2"), inputs({ start: { axes: { X: 100, Y: 50 } } }));
		expect(r.status).toBe("complete");
		expect(r.steps[1]!.state.x).toBe(105);
		expect(r.steps[1]!.state.y).toBe(48);
	});

	it("without one, a relative move from an unknown position just takes the commanded value (the old behaviour)", () => {
		const r = runSimulation(doc("G91", "G1 X5"), inputs());
		expect(r.steps[1]!.state.x).toBe(5);
	});

	it("can start in G91 / M83 and with a tool, feedrate and homed axes", () => {
		const r = runSimulation(doc("G1 X1"), inputs({
			start: { axes: { X: 10 }, relativeMoves: true, relativeE: true, tool: 2, feedrate: 3000, homed: ["X", "Y"], e: 4 },
		}));
		const s = r.steps[0]!.state;
		expect(s.x).toBe(11); // relative from 10
		expect(s.relativeE).toBe(true);
		expect(s.tool).toBe(2);
		expect(s.feedrate).toBe(3000);
		expect([s.homedX, s.homedY, s.homedZ]).toEqual([true, true, false]); // Z was not listed
		expect(s.e).toBe(4);
	});

	it("is reflected in the object-model paths the tracker answers itself", () => {
		const r = runSimulation(doc("if move.axes[2].userPosition > 10", "    G1 X1", "G1 Y1"), inputs({ start: { axes: { Z: 20 } } }));
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([0, 1, 2]);
		const r2 = runSimulation(doc("if move.axes[2].userPosition > 10", "    G1 X1", "G1 Y1"), inputs({ start: { axes: { Z: 5 } } }));
		expect(r2.steps.map((s) => s.line)).toEqual([0, 2]);
	});

	it("ignores an unknown axis letter and a non-finite value rather than throwing", () => {
		const r = runSimulation(doc("G1 X1"), inputs({ start: { axes: { Q: 5, Y: Number.NaN, Z: 3 } } }));
		expect(r.steps[0]!.state.z).toBe(3);
		expect(r.steps[0]!.state.y).toBeNull();
		expect(r.steps[0]!.state.axisLetters).toEqual(["X", "Y", "Z"]);
	});
});

describe("axes beyond X/Y/Z", () => {
	it("tracks a U axis: declared by a move, absolute then relative", () => {
		const r = runSimulation(doc("G1 U5", "G91", "G1 U2.5", "G90", "G92 U0"), inputs());
		expect(r.steps.map((s) => s.state.extraAxes.U)).toEqual([5, 5, 7.5, 7.5, 0]);
		expect(r.steps[0]!.state.axisLetters).toEqual(["X", "Y", "Z", "U"]);
	});

	it("does not disturb earlier steps' snapshots when a later step moves the axis", () => {
		const r = runSimulation(doc("G1 U5", "G1 U9"), inputs());
		expect(r.steps[0]!.state.extraAxes.U).toBe(5); // still 5 after step 2 ran
		expect(r.steps[1]!.state.extraAxes.U).toBe(9);
	});

	it("takes a starting position for an extra axis, which also declares it", () => {
		const r = runSimulation(doc("G91", "G1 A10"), inputs({ start: { axes: { A: 90 } } }));
		expect(r.steps[1]!.state.extraAxes.A).toBe(100);
		expect(r.steps[1]!.state.axisLetters).toEqual(["X", "Y", "Z", "A"]);
	});

	it("reads a {...} extra-axis value from the evaluated parameters", () => {
		const r = runSimulation(doc("G1 U{1 + 2}"), inputs());
		expect(r.steps[0]!.state.extraAxes.U).toBe(3);
	});

	it("G28 U homes only U, and a bare G28 homes every axis the walk knows", () => {
		const onlyU = runSimulation(doc("G28 U"), inputs());
		const s1 = onlyU.steps[0]!.state;
		expect([s1.homedX, s1.homedY, s1.homedZ]).toEqual([false, false, false]);
		expect(s1.homedExtra).toEqual(["U"]);

		const all = runSimulation(doc("G1 U1", "G28"), inputs());
		const s2 = all.steps[1]!.state;
		expect([s2.homedX, s2.homedY, s2.homedZ]).toEqual([true, true, true]);
		expect(s2.homedExtra).toEqual(["U"]);
	});

	it("M584 declares the axes it names, in the order they appear", () => {
		const r = runSimulation(doc("M584 X0 Y1 Z2 V3 U4"), inputs());
		expect(r.steps[0]!.state.axisLetters).toEqual(["X", "Y", "Z", "V", "U"]);
	});

	it("answers move.axes[n] paths for a declared extra axis by its index", () => {
		const r = runSimulation(doc("G1 U7", "if move.axes[3].userPosition = 7", "    G1 X1", "if move.axes[3].letter = \"U\"", "    G1 Y1"), inputs());
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([0, 1, 2, 3, 4]);
	});

	it("an axis index past the axes this walk knows is unknown, so it pauses rather than answering 0/false", () => {
		const r = buildExecutionIndex(doc("if move.axes[5].homed", "    G1 X1"), noOverrides(), noBoxes());
		expect(r.status).toBe("paused");
		expect(r).toMatchObject({ path: "move.axes[5].homed" });
	});

	it("resolveKnownPath keeps its old answers for X/Y/Z", () => {
		const state = createState({ initial: { axes: { X: 1, Y: 2, Z: 3 }, homed: ["Y"] } });
		expect(resolveKnownPath("move.axes[0].userPosition", state)).toBe(1);
		expect(resolveKnownPath("move.axes[1].userPosition", state)).toBe(2);
		expect(resolveKnownPath("move.axes[2].userPosition", state)).toBe(3);
		expect(resolveKnownPath("move.axes[1].homed", state)).toBe(true);
		expect(resolveKnownPath("move.axes[0].homed", state)).toBe(false);
		expect(resolveKnownPath("move.axes[2].letter", state)).toBe("Z");
	});
});

describe("path values a user supplies up front", () => {
	it("lets both arms of a condition be tested by changing one value", () => {
		const text = doc("if sensors.gpIn[0].value = 1", "    G1 X10", "else", "    G1 X20");
		const high = runSimulation(text, inputs({ paths: new Map([["sensors.gpIn[0].value", 1]]) }));
		const low = runSimulation(text, inputs({ paths: new Map([["sensors.gpIn[0].value", 0]]) }));
		expect(high.steps[high.steps.length - 1]!.state.x).toBe(10);
		expect(low.steps[low.steps.length - 1]!.state.x).toBe(20);
	});

	it("still pauses on a path nobody gave a value for", () => {
		const r = runSimulation(doc("if sensors.gpIn[0].value = 1", "    G1 X10"), inputs());
		expect(r.status).toBe("paused");
		expect(r).toMatchObject({ path: "sensors.gpIn[0].value" });
	});

	it("supplies macro arguments as param.*", () => {
		const r = runSimulation(doc("G1 X{param.X + 1}"), inputs({ paths: new Map([["param.X", 9]]) }));
		expect(r.steps[0]!.state.x).toBe(10);
	});

	it("makes exists(param.X) true only when the argument was given", () => {
		const text = doc("if exists(param.X)", "    G1 X1", "else", "    G1 X2");
		expect(runSimulation(text, inputs()).steps.at(-1)!.state.x).toBe(2);
		expect(runSimulation(text, inputs({ paths: new Map([["param.X", 0]]) })).steps.at(-1)!.state.x).toBe(1);
	});

	it("takes an array value", () => {
		const r = runSimulation(doc("if #heat.heaters = 2", "    G1 X1"), inputs({ paths: new Map<string, EvalValue>([["heat.heaters", [1, 2]]]) }));
		expect(r.status).toBe("complete");
		expect(r.steps.map((s) => s.line)).toEqual([0, 1]);
	});
});

describe("globals and vars that already exist", () => {
	it("makes a global from config.g readable in a macro that never declares it", () => {
		const text = doc("if global.myFlag", "    G1 X5");
		const missing = runSimulation(text, inputs());
		expect(missing.status).toBe("error");
		expect(missing).toMatchObject({ message: expect.stringContaining("global.myFlag") });
		const set = runSimulation(text, inputs({ globals: new Map([["myFlag", true]]) }));
		expect(set.status).toBe("complete");
		expect(set.steps.map((s) => s.line)).toEqual([0, 1]);
	});

	it("makes exists(global.x) reflect whether it was provided", () => {
		const text = doc("if exists(global.x)", "    G1 X1", "else", "    G1 X2");
		expect(runSimulation(text, inputs()).steps.at(-1)!.state.x).toBe(2);
		expect(runSimulation(text, inputs({ globals: new Map([["x", 0]]) })).steps.at(-1)!.state.x).toBe(1);
	});

	it("lets set global.x change a provided global", () => {
		const r = runSimulation(doc("set global.n = global.n + 1"), inputs({ globals: new Map([["n", 4]]) }));
		expect(r.status).toBe("complete");
		expect(r.steps[0]!.variables!.global.get("n")).toBe(5);
	});

	it("supports initial vars for a fragment", () => {
		const r = runSimulation(doc("G1 X{var.start + 1}"), inputs({ vars: new Map([["start", 41]]) }));
		expect(r.steps[0]!.state.x).toBe(42);
	});
});

describe("recording what each line evaluated to", () => {
	it("records nothing unless asked (existing callers see the same steps as before)", () => {
		const r = buildExecutionIndex(doc("var a = 1", "G1 X{var.a}"), noOverrides(), noBoxes());
		expect(r.steps[0]).not.toHaveProperty("evaluation");
		expect(r.steps[0]).not.toHaveProperty("variables");
	});

	it("records an assignment and the variables after it", () => {
		const r = runSimulation(doc("var a = 1 + 2", "set var.a = var.a * 10"), inputs());
		expect(r.steps[0]!.evaluation!.assignment).toEqual({ form: "declare", scope: "local", name: "a", value: 3 });
		expect(r.steps[1]!.evaluation!.assignment).toEqual({ form: "set", scope: "local", name: "a", value: 30 });
		expect(r.steps[0]!.variables!.local.get("a")).toBe(3);
		expect(r.steps[1]!.variables!.local.get("a")).toBe(30);
	});

	it("hands consecutive steps the SAME variables object while nothing changes", () => {
		const r = runSimulation(doc("var a = 1", "G1 X1", "G1 X2", "set var.a = 2", "G1 X3"), inputs());
		const v = r.steps.map((s) => s.variables);
		expect(v[1]).toBe(v[0]);
		expect(v[2]).toBe(v[0]);
		expect(v[3]).not.toBe(v[0]);
		expect(v[4]).toBe(v[3]);
	});

	it("drops a block-scoped var once its block ends", () => {
		const r = runSimulation(doc("if true", "    var inner = 1", "G1 X1"), inputs());
		expect(r.steps[1]!.variables!.local.has("inner")).toBe(true);
		expect(r.steps[2]!.variables!.local.has("inner")).toBe(false);
	});

	it("records a condition's outcome", () => {
		const r = runSimulation(doc("var a = 3", "if var.a > 5", "    G1 X1", "elif var.a > 1", "    G1 X2"), inputs());
		const cond = r.steps.filter((s) => s.evaluation?.condition !== undefined);
		expect(cond.map((s) => s.evaluation!.condition)).toEqual([false, true]);
	});

	it("records each {...} parameter's value and its exact span in the line", () => {
		const text = doc("var a = 100", "G1 X{var.a + 5} Y2 F{var.a * 10}");
		const r = runSimulation(text, inputs());
		const ev = r.steps[1]!.evaluation!;
		expect(ev.expressions.map((e) => [e.kind, e.letter, e.value])).toEqual([["param", "X", 105], ["param", "F", 1000]]);
		const raw = "G1 X{var.a + 5} Y2 F{var.a * 10}";
		expect(ev.expressions.map((e) => raw.slice(e.start, e.end))).toEqual(["{var.a + 5}", "{var.a * 10}"]);
	});

	it("records an echo's expression, and does not fail an echo whose text isn't a clean expression", () => {
		const r = runSimulation(doc("var n = 4", 'echo "n is " ^ var.n', 'echo >"0:/sys/log.txt" "hello"'), inputs());
		expect(r.status).toBe("complete");
		expect(r.steps[1]!.evaluation!.expressions[0]!.value).toBe("n is 4");
		expect(r.steps[2]!.evaluation).toBeUndefined(); // skipped, not failed
	});

	it("evaluates a {...} string argument such as M117's", () => {
		const r = runSimulation(doc("var n = 2", 'M117 {"n=" ^ var.n}'), inputs());
		expect(r.status).toBe("complete");
		const e = r.steps[1]!.evaluation!.expressions[0]!;
		expect(e.kind).toBe("stringArgument");
		expect(e.value).toBe("n=2");
	});

	it("pauses on an unresolved path in an echo rather than skipping it", () => {
		const r = runSimulation(doc('echo "t=" ^ heat.heaters[1].current'), inputs());
		expect(r.status).toBe("paused");
		expect(r).toMatchObject({ path: "heat.heaters[1].current" });
	});

	it("fails an echo that names an undefined variable, as RRF would", () => {
		const r = runSimulation(doc('echo "x" ^ var.nope'), inputs());
		expect(r.status).toBe("error");
	});

	it("records a while loop's iteration count on the lines inside it", () => {
		const r = runSimulation(doc("var i = 0", "while var.i < 3", "    set var.i = var.i + 1", "    G1 X{iterations}"), inputs());
		expect(r.status).toBe("complete");
		const moves = r.steps.filter((s) => s.line === 3);
		expect(moves.map((s) => s.iteration)).toEqual([0, 1, 2]);
		expect(moves.map((s) => s.state.x)).toEqual([0, 1, 2]);
	});

	it("walkExecution alone exposes the same records", () => {
		const out = walkExecution(parseDocument("var a = 2\nG1 X{var.a}"), { resolvePath: noOverrides(), recordEvaluation: true });
		expect(out.status).toBe("complete");
		expect(out.steps[1]!.evaluation!.expressions[0]!.value).toBe(2);
	});
});

describe("renderEvaluatedLine", () => {
	it("substitutes a parameter's value in place", () => {
		const r = runSimulation(doc("var a = 100", "G1 X{var.a + 5} Y2"), inputs());
		const line = renderEvaluatedLine("G1 X{var.a + 5} Y2", r.steps[1]!.evaluation);
		expect(line.text).toBe("G1 X105 Y2");
		expect(line.changed).toBe(true);
		expect(line.segments.map((s) => s.kind)).toEqual(["source", "value", "source"]);
	});

	it("trims floating-point noise", () => {
		const r = runSimulation(doc("G1 X{0.1 + 0.2}"), inputs());
		expect(renderEvaluatedLine("G1 X{0.1 + 0.2}", r.steps[0]!.evaluation).text).toBe("G1 X0.3");
	});

	it("appends a condition's outcome", () => {
		const r = runSimulation(doc("var a = 9", "if var.a > 5", "    G1 X1"), inputs());
		expect(renderEvaluatedLine("if var.a > 5", r.steps[1]!.evaluation).text).toBe("if var.a > 5 → true");
	});

	it("appends an assignment", () => {
		const r = runSimulation(doc("var a = 9", "set var.a = var.a + 1"), inputs());
		expect(renderEvaluatedLine("set var.a = var.a + 1", r.steps[1]!.evaluation).text).toBe("set var.a = var.a + 1 → var.a = 10");
	});

	it("appends an echo's text, quoted", () => {
		const r = runSimulation(doc('echo "hi " ^ "there"'), inputs());
		expect(renderEvaluatedLine('echo "hi " ^ "there"', r.steps[0]!.evaluation).text).toBe('echo "hi " ^ "there" → "hi there"');
	});

	it("renders a string parameter quoted and an array parameter colon-separated, as RRF reads them", () => {
		expect(formatParamValue("a b")).toBe('"a b"');
		expect(formatParamValue('say "x"')).toBe('"say ""x"""');
		expect(formatParamValue([200, 210.5])).toBe("200:210.5");
		expect(formatEvalValue([1, "a", true, null])).toBe('[1, "a", true, null]');
	});

	it("leaves a line with nothing to evaluate untouched and unchanged", () => {
		const line = renderEvaluatedLine("G1 X10", undefined);
		expect(line).toEqual({ text: "G1 X10", segments: [{ text: "G1 X10", kind: "source" }], changed: false });
	});

	it("ignores an out-of-range span rather than corrupting the line", () => {
		const line = renderEvaluatedLine("G1 X1", { expressions: [{ kind: "param", letter: "X", start: 3, end: 99, value: 5 }] });
		expect(line.text).toBe("G1 X1");
	});
});

describe("axisReadouts", () => {
	it("reports position, delta and which axes moved, in move.axes[] order", () => {
		const r = runSimulation(doc("G1 X10 Y5 U1", "G1 X12 U1"), inputs());
		const readouts = axisReadouts(r.steps[1]!.state, r.steps[0]!.state);
		expect(readouts.map((a) => a.letter)).toEqual(["X", "Y", "Z", "U"]);
		const byLetter = Object.fromEntries(readouts.map((a) => [a.letter, a]));
		expect(byLetter.X).toMatchObject({ position: 12, previous: 10, delta: 2, changed: true });
		expect(byLetter.Y).toMatchObject({ position: 5, delta: 0, changed: false });
		expect(byLetter.Z).toMatchObject({ position: null, delta: null, changed: false });
		expect(byLetter.U).toMatchObject({ position: 1, changed: false });
	});

	it("treats the first step as everything that has a position having changed", () => {
		const r = runSimulation(doc("G1 X10"), inputs());
		const x = axisReadouts(r.steps[0]!.state, null).find((a) => a.letter === "X")!;
		expect(x).toMatchObject({ position: 10, previous: null, delta: null, changed: true });
	});
});

describe("variableChanges", () => {
	it("reports added, changed and removed variables between two steps", () => {
		const r = runSimulation(doc("var a = 1", "set var.a = 2", "global g = 5", "if true", "    var b = 1", "G1 X1"), inputs());
		const vars = r.steps.map((s) => s.variables);
		expect(variableChanges(undefined, vars[0])).toEqual([{ scope: "var", name: "a", value: 1, previous: undefined, change: "added" }]);
		expect(variableChanges(vars[0], vars[1])).toEqual([{ scope: "var", name: "a", value: 2, previous: 1, change: "changed" }]);
		expect(variableChanges(vars[1], vars[2])).toEqual([{ scope: "global", name: "g", value: 5, previous: undefined, change: "added" }]);
		expect(variableChanges(vars[4], vars[5])).toEqual([{ scope: "var", name: "b", value: undefined, previous: 1, change: "removed" }]);
	});

	it("reports nothing when the step shares the previous snapshot", () => {
		const r = runSimulation(doc("var a = 1", "G1 X1"), inputs());
		expect(variableChanges(r.steps[0]!.variables, r.steps[1]!.variables)).toEqual([]);
	});

	it("compares arrays by content", () => {
		const r = runSimulation(doc("var a = [1, 2]", "set var.a = [1, 2]"), inputs());
		expect(r.status).toBe("complete");
		expect(variableChanges(r.steps[0]!.variables, r.steps[1]!.variables)).toEqual([]);
	});
});

describe("findReferencedInputs", () => {
	it("lists object-model paths, params and undeclared globals, with the lines that read them", () => {
		const text = doc(
			"global declared = 1",
			"if sensors.gpIn[0].value = 1 && global.external > 0",
			"    G1 X{param.X} Y{global.declared}",
			"echo heat.heaters[1].current",
			"if sensors.gpIn[0].value = 0",
			"    G1 Z1",
		);
		const found = findReferencedInputs(text);
		const summary = found.map((f) => [f.kind, f.name, [...f.lines]]);
		// Ordered by the first line that reads each, then by name.
		expect(summary).toEqual([
			["global", "external", [1]],
			["objectModel", "sensors.gpIn[0].value", [1, 4]],
			["param", "param.X", [2]],
			["objectModel", "heat.heaters[1].current", [3]],
		]);
		expect(found.every((f) => !f.dynamic)).toBe(true);
	});

	it("marks a path with a computed index as dynamic, with a [*] template", () => {
		const found = findReferencedInputs(doc("var i = 1", "if heat.heaters[var.i].current > 5", "    G1 X1"));
		expect(found).toEqual([expect.objectContaining({ kind: "objectModel", name: "heat.heaters[*].current", dynamic: true })]);
	});

	it("finds a path inside exists() and inside a function call", () => {
		const found = findReferencedInputs(doc("if exists(param.S) && abs(move.axes[0].max) > 1", "    G1 X1"));
		expect(found.map((f) => f.name).sort()).toEqual(["move.axes[0].max", "param.S"]);
	});

	it("flags a path the schema at a given version does not know", () => {
		const found = findReferencedInputs(doc("if move.speedFactor > 0 && bogus.path > 0", "    G1 X1"), { objectModelVersion: "3.7.0-rc.1" });
		const byName = Object.fromEntries(found.map((f) => [f.name, f.known]));
		expect(byName["move.speedFactor"]).toBe(true);
		expect(byName["bogus.path"]).toBe(false);
	});

	it("lists an undeclared var but not one the file declares", () => {
		const found = findReferencedInputs(doc("var mine = 1", "G1 X{var.mine + var.other}"));
		expect(found.map((f) => [f.kind, f.name])).toEqual([["var", "other"]]);
	});

	it("lists nothing for a file of plain commands", () => {
		expect(findReferencedInputs(doc("G28", "G1 X10 Y10 F3000"))).toEqual([]);
	});

	it("does not crash on an expression with a parse error", () => {
		expect(() => findReferencedInputs(doc("if (((", "    G1 X{"))).not.toThrow();
	});
});

describe("saving a scenario", () => {
	it("round-trips every part", () => {
		const prompt = { mode: "ok" as const, message: "Ready?", title: null };
		const original = inputs({
			start: { axes: { X: 1, U: 2 }, homed: ["X"], tool: 1, relativeMoves: true },
			paths: new Map<string, EvalValue>([["sensors.gpIn[0].value", 1], ["heat.heaters", [1, 2]], ["param.S", "abc"]]),
			globals: new Map<string, EvalValue>([["flag", true]]),
			vars: new Map<string, EvalValue>([["v", null]]),
			messageBoxAnswers: new Map([[messageBoxKey(prompt as never), { input: null, cancelled: false }]]),
		});
		const back = simulationInputsFromJSON(JSON.parse(JSON.stringify(simulationInputsToJSON(original))));
		expect(back).toEqual(original);
	});

	it("returns null for something that is not its own output", () => {
		expect(simulationInputsFromJSON(null)).toBeNull();
		expect(simulationInputsFromJSON({})).toBeNull();
		expect(simulationInputsFromJSON({ kind: "dwc-gcode-simulation-inputs", schemaVersion: 2 })).toBeNull();
		expect(simulationInputsFromJSON("nope")).toBeNull();
	});

	it("drops individual bad entries instead of rejecting the whole file", () => {
		const back = simulationInputsFromJSON({
			kind: "dwc-gcode-simulation-inputs", schemaVersion: 1,
			start: { axes: { X: 5, Y: "oops" }, tool: "two", homed: ["X", 3] },
			paths: { good: 1, bad: { nested: true }, nan: null },
			globals: [], vars: "x",
			messageBoxAnswers: { a: { input: 1, cancelled: false }, b: { input: {}, cancelled: false }, c: 4 },
		})!;
		expect(back.start).toEqual({ axes: { X: 5 }, homed: ["X"] });
		expect([...back.paths.keys()].sort()).toEqual(["good", "nan"]);
		expect(back.globals.size).toBe(0);
		expect(back.vars.size).toBe(0);
		expect([...back.messageBoxAnswers.keys()]).toEqual(["a"]);
	});
});

describe("parseSimulatedValueInput, extended", () => {
	it("reads null, arrays and quoted strings", () => {
		expect(parseSimulatedValueInput("null")).toBeNull();
		expect(parseSimulatedValueInput("[1, 2, 3]")).toEqual([1, 2, 3]);
		expect(parseSimulatedValueInput('["a", true]')).toEqual(["a", true]);
		expect(parseSimulatedValueInput('"12"')).toBe("12"); // the STRING twelve, not the number
	});

	it("keeps malformed structured input as the literal text", () => {
		expect(parseSimulatedValueInput("[oops")).toBe("[oops");
		expect(parseSimulatedValueInput('"unterminated')).toBe('"unterminated');
		expect(parseSimulatedValueInput('[{"a":1}]')).toBe('[{"a":1}]'); // an object is not an EvalValue
	});
});

describe("describeStep", () => {
	const text = doc("var a = 100", "G1 X{var.a + 5} Y2", "set var.a = 1");

	it("bundles the source line, its evaluated form, both states and the axis deltas", () => {
		const scenario = inputs({ start: { axes: { X: 90, Y: 2 } } });
		const index = runSimulation(text, scenario);
		const v = describeStep(index, 1, sourceLines(text), scenario)!;
		expect(v.line).toBe(2); // 1-based
		expect(v.source).toBe("G1 X{var.a + 5} Y2");
		expect(v.evaluated.text).toBe("G1 X105 Y2");
		expect(v.state.x).toBe(105);
		expect(v.previousState.x).toBe(90); // the step BEFORE it (the var line) left X at its starting 90
		const x = v.axes.find((a) => a.letter === "X")!;
		expect(x).toMatchObject({ position: 105, previous: 90, delta: 15, changed: true });
		const y = v.axes.find((a) => a.letter === "Y")!;
		expect(y).toMatchObject({ position: 2, previous: 2, delta: 0, changed: false }); // Y2 == where it started
	});

	it("for step 0, 'before' is the scenario's starting state, so the first move shows a real delta", () => {
		const scenario = inputs({ start: { axes: { X: 90 } } });
		const index = runSimulation("G1 X100", scenario);
		const v = describeStep(index, 0, sourceLines("G1 X100"), scenario)!;
		expect(v.previousState.x).toBe(90);
		expect(v.axes.find((a) => a.letter === "X")).toMatchObject({ position: 100, previous: 90, delta: 10 });
	});

	it("reports the variables after the step and what changed in them", () => {
		const index = runSimulation(text, inputs());
		const lines = sourceLines(text);
		const declared = describeStep(index, 0, lines, inputs())!;
		expect(declared.variables.local.get("a")).toBe(100);
		expect(declared.variableChanges).toEqual([{ scope: "var", name: "a", value: 100, previous: undefined, change: "added" }]);
		const move = describeStep(index, 1, lines, inputs())!;
		expect(move.variableChanges).toEqual([]);
		const changed = describeStep(index, 2, lines, inputs())!;
		expect(changed.variableChanges).toEqual([{ scope: "var", name: "a", value: 1, previous: 100, change: "changed" }]);
	});

	it("does not call a preset global 'added' on the first step - it was already there", () => {
		const scenario = inputs({ globals: new Map([["g", 1]]) });
		const t = "G1 X1";
		const v = describeStep(runSimulation(t, scenario), 0, sourceLines(t), scenario)!;
		expect(v.variables.global.get("g")).toBe(1);
		expect(v.variableChanges).toEqual([]);
	});

	it("carries the loop iteration, else null", () => {
		const t = doc("var i = 0", "while var.i < 2", "    set var.i = var.i + 1");
		const index = runSimulation(t, inputs());
		const lines = sourceLines(t);
		expect(describeStep(index, 0, lines, inputs())!.iteration).toBeNull();
		const inside = index.steps.findIndex((s) => s.line === 2);
		expect(describeStep(index, inside, lines, inputs())!.iteration).toBe(0);
	});

	it("is null outside the recorded steps", () => {
		const index = runSimulation("G1 X1", inputs());
		expect(describeStep(index, 5, ["G1 X1"], inputs())).toBeNull();
		expect(describeStep(index, -1, ["G1 X1"], inputs())).toBeNull();
	});

	it("sourceLines indexes lines the same way the walker does, including CRLF", () => {
		expect(sourceLines("G28\r\nG1 X1\rG1 X2\n")).toEqual(["G28", "G1 X1", "G1 X2", ""]);
	});
});

describe("editing a scenario", () => {
	it("sets and clears each kind of input without mutating the original", () => {
		const base = inputs();
		const a = withInputValue(base, "objectModel", "sensors.gpIn[0].value", 1);
		const b = withInputValue(a, "param", "param.S", "x");
		const c = withInputValue(b, "global", "flag", true);
		const d = withInputValue(c, "var", "v", [1, 2]);
		expect(base.paths.size).toBe(0);
		expect(getInputValue(d, "objectModel", "sensors.gpIn[0].value")).toBe(1);
		expect(getInputValue(d, "param", "param.S")).toBe("x");
		expect(getInputValue(d, "global", "flag")).toBe(true);
		expect(getInputValue(d, "var", "v")).toEqual([1, 2]);
		// each landed in its own map: a global "flag" is not a path
		expect(d.paths.has("flag")).toBe(false);
		const cleared = withInputValue(d, "objectModel", "sensors.gpIn[0].value", undefined);
		expect(getInputValue(cleared, "objectModel", "sensors.gpIn[0].value")).toBeUndefined();
		expect(getInputValue(d, "objectModel", "sensors.gpIn[0].value")).toBe(1); // original untouched
	});

	it("sets, replaces and unsets a starting axis position", () => {
		let s = withStartAxis(inputs(), "X", 10);
		s = withStartAxis(s, "U", 5);
		expect(s.start.axes).toEqual({ X: 10, U: 5 });
		s = withStartAxis(s, "X", 20);
		expect(s.start.axes).toEqual({ X: 20, U: 5 });
		s = withStartAxis(s, "X", null);
		expect(s.start.axes).toEqual({ U: 5 });
		expect(withStartAxis(s, "Y", Number.NaN).start.axes).toEqual({ U: 5 }); // NaN unsets, never stored
	});

	it("declares and drops an extra axis, dropping its position with it", () => {
		let s = withDeclaredAxis(withStartAxis(inputs(), "U", 3), "U", true);
		expect(s.start.axisLetters).toEqual(["U"]);
		s = withDeclaredAxis(s, "U", true);
		expect(s.start.axisLetters).toEqual(["U"]); // idempotent
		s = withDeclaredAxis(s, "U", false);
		expect(s.start.axisLetters).toEqual([]);
		expect(s.start.axes).toEqual({});
		// and the walk sees the declared-but-unpositioned axis
		const declared = runSimulation("G1 X1", withDeclaredAxis(inputs(), "V", true));
		expect(declared.steps[0]!.state.axisLetters).toEqual(["X", "Y", "Z", "V"]);
	});

	it("toggles homed axes, starting mode flags and numeric start values", () => {
		let s = withStartHomed(inputs(), "X", true);
		s = withStartHomed(s, "Y", true);
		s = withStartHomed(s, "X", false);
		expect(s.start.homed).toEqual(["Y"]);
		s = withStartMode(s, "relativeMoves", true);
		s = withStartValue(s, "tool", 2);
		s = withStartValue(s, "feedrate", 900);
		s = withStartValue(s, "feedrate", null);
		expect(s.start).toMatchObject({ homed: ["Y"], relativeMoves: true, tool: 2 });
		expect(s.start).not.toHaveProperty("feedrate");
	});

	it("isEmptySimulationInputs is true only when nothing at all is set", () => {
		expect(isEmptySimulationInputs(inputs())).toBe(true);
		expect(isEmptySimulationInputs(withStartAxis(inputs(), "X", 0))).toBe(false); // 0 is a value
		expect(isEmptySimulationInputs(withStartMode(inputs(), "relativeE", false))).toBe(false);
		expect(isEmptySimulationInputs(withInputValue(inputs(), "global", "g", null))).toBe(false); // null is a value
		expect(isEmptySimulationInputs(withStartAxis(withStartAxis(inputs(), "X", 1), "X", null))).toBe(true);
	});
});
