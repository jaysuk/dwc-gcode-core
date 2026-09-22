import { describe, expect, it, vi } from "vitest";

import { parseDocument } from "../src/document.js";
import { UnresolvedPathError, type EvalValue } from "../src/expr/evaluate.js";
import { UnresolvedMessageBoxError, walkExecution, type MessageBoxAnswer, type WalkOutcome } from "../src/execute.js";

function lines(outcome: WalkOutcome): Array<number> {
	return outcome.steps.map((s) => s.line);
}

function noPaths() {
	return (path: string): EvalValue => { throw new Error(`unexpected path lookup: ${path}`); };
}

describe("linear files — no conditionals", () => {
	it("walks every line in order, recording comments as steps but not blanks", () => {
		const doc = parseDocument("G28\n; a comment\n\nG1 X10\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("complete");
		// Line 1 ('; a comment') IS a step - a caller may derive state from a comment's own content
		// (e.g. a slicer's layer marker). Line 2 (blank) is not - see execPlainLines' own doc comment.
		expect(lines(r)).toEqual([0, 1, 3, 4]);
	});
});

describe("if/else", () => {
	it("takes the true branch and never visits the false one's body", () => {
		const doc = parseDocument("if true\n    G1 X1\nelse\n    G1 X2\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("complete");
		// Both the 'if' and 'else' lines are visited (RRF reads them sequentially), but only the
		// chosen arm's body (line 1) executes - line 3 ('G1 X2') never appears.
		expect(lines(r)).toEqual([0, 1, 2, 4]);
	});

	it("takes the false branch's body when the condition is false", () => {
		const doc = parseDocument("if false\n    G1 X1\nelse\n    G1 X2\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(lines(r)).toEqual([0, 2, 3, 4]);
	});

	it("runs neither body when there's no matching else and the condition is false", () => {
		const doc = parseDocument("if false\n    G1 X1\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(lines(r)).toEqual([0, 2]);
	});
});

describe("elif chains", () => {
	it("stops checking once an earlier arm wins — later elif conditions are never evaluated", () => {
		const doc = parseDocument("if true\n    G1 X1\nelif sensors.gpIn[0].value > 0\n    G1 X2\nM400\n");
		const resolvePath = vi.fn(() => { throw new Error("should not be called"); });
		const r = walkExecution(doc, { resolvePath });
		expect(r.status).toBe("complete");
		// Line 2 (the 'elif' line) is still visited/recorded - RRF reads past it sequentially even
		// though it never evaluates its condition, having already committed to the earlier true arm.
		expect(lines(r)).toEqual([0, 1, 2, 4]);
		expect(resolvePath).not.toHaveBeenCalled();
	});

	it("falls through to the second arm when the first is false", () => {
		const doc = parseDocument("if false\n    G1 X1\nelif true\n    G1 X2\nelse\n    G1 X3\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(lines(r)).toEqual([0, 2, 3, 4, 6]);
	});
});

describe("while loops", () => {
	it("re-evaluates the condition before every iteration, including the first and the last (false) check", () => {
		const doc = parseDocument("var i = 0\nwhile var.i < 3\n    G1 X{var.i}\n    set var.i = var.i + 1\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("complete");
		// line 0 (var decl), then 3 full iterations of [1 (while), 2 (body), 3 (set)], then a final
		// line-1 visit where the condition is false, then line 4.
		expect(lines(r)).toEqual([0, 1, 2, 3, 1, 2, 3, 1, 2, 3, 1, 4]);
	});

	it("never enters the body when the condition starts false", () => {
		const doc = parseDocument("while false\n    G1 X1\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(lines(r)).toEqual([0, 2]);
	});

	it("'break' stops the loop immediately, skipping the rest of that iteration's body", () => {
		const doc = parseDocument("var i = 0\nwhile true\n    set var.i = var.i + 1\n    break\n    set var.i = 99\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("complete");
		expect(lines(r)).toEqual([0, 1, 2, 3, 5]);
	});

	it("'continue' skips the rest of the body and re-checks the condition", () => {
		const doc = parseDocument("var i = 0\nwhile var.i < 2\n    set var.i = var.i + 1\n    continue\n    set var.i = 99\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("complete");
		// Two iterations, each hitting 'continue' and never reaching the dead 'set var.i = 99' at
		// line 4, then the final false check and the trailing M400.
		expect(lines(r)).toEqual([0, 1, 2, 3, 1, 2, 3, 1, 5]);
	});

	it("teeth: a runaway loop is capped, not left to hang", () => {
		const doc = parseDocument("while true\n    G1 X1\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths(), maxIterationsPerLoop: 50 });
		expect(r.status).toBe("error");
		expect((r as { message: string }).message).toMatch(/50 iterations/);
	});
});

describe("variables", () => {
	it("a declared var is visible to a later condition", () => {
		const doc = parseDocument("var x = 5\nif var.x > 3\n    G1 X1\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(lines(r)).toEqual([0, 1, 2, 3]);
	});

	it("'set' updates an existing variable; a later read sees the new value", () => {
		const doc = parseDocument("var x = 1\nset var.x = 9\nif var.x = 9\n    G1 X1\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(lines(r)).toEqual([0, 1, 2, 3, 4]);
	});

	it("'set' on an undefined variable is a hard error", () => {
		const doc = parseDocument("set var.x = 9\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("error");
		expect((r as { line: number }).line).toBe(0);
	});
});

describe("pausing on an unresolved live/hardware path", () => {
	it("stops exactly at the condition, reporting the path and everything executed so far", () => {
		const doc = parseDocument("G28\nif sensors.gpIn[0].value > 0\n    G1 X1\nelse\n    G1 X2\nM400\n");
		const resolvePath = (path: string): EvalValue => { throw new UnresolvedPathError(path); };
		const r = walkExecution(doc, { resolvePath });
		expect(r.status).toBe("paused");
		expect(r).toMatchObject({ line: 1, path: "sensors.gpIn[0].value" });
		expect(lines(r)).toEqual([0]);
	});

	it("re-running with a resolving path picks up and completes", () => {
		const doc = parseDocument("G28\nif sensors.gpIn[0].value > 0\n    G1 X1\nelse\n    G1 X2\nM400\n");
		const resolvePath = (path: string): EvalValue => {
			if (path === "sensors.gpIn[0].value") return 1;
			throw new UnresolvedPathError(path);
		};
		const r = walkExecution(doc, { resolvePath });
		expect(r.status).toBe("complete");
		expect(lines(r)).toEqual([0, 1, 2, 3, 5]);
	});

	it("a path inside a loop body pauses on the first iteration that needs it", () => {
		const doc = parseDocument("var i = 0\nwhile var.i < 3\n    if sensors.gpIn[0].value > 0\n        G1 X1\n    set var.i = var.i + 1\nM400\n");
		const resolvePath = (path: string): EvalValue => { throw new UnresolvedPathError(path); };
		const r = walkExecution(doc, { resolvePath });
		expect(r.status).toBe("paused");
		// Line 1 ('while', condition true) is recorded; line 2 (the inner 'if') is the one that pauses,
		// so - consistent with the top-level case - its own line isn't recorded as a completed step.
		expect(lines(r)).toEqual([0, 1]);
	});
});

describe("abort", () => {
	it("ends the walk as 'complete' at the abort line, nothing after it runs", () => {
		const doc = parseDocument("G28\nif true\n    abort \"stop here\"\n    G1 X1\nG1 X2\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("complete");
		expect(lines(r)).toEqual([0, 1, 2]);
	});
});

describe("malformed control flow", () => {
	it("an elif/else that doesn't follow an if is a hard error, matching RRF's own runtime throw", () => {
		const doc = parseDocument("else\n    G1 X1\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("error");
		expect((r as { message: string }).message).toMatch(/did not follow 'if'/);
	});

	it("a non-boolean condition is a hard error, not silently coerced", () => {
		const doc = parseDocument("if 5\n    G1 X1\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("error");
	});

	it("regression: two independent, line-adjacent top-level ifs are NOT the same chain", () => {
		// A real bug: the chain scan only checked "is this arm's keyword if/elif/else, and does its
		// line immediately follow the previous arm's endLine" - a fresh 'if' satisfies BOTH when it
		// starts right where a preceding if's body ended, so it got silently swept into that if's own
		// chain. Once the first if had already resolved true, this second (entirely unrelated) if's
		// own condition was never evaluated and its body never ran - it was treated as a skipped
		// elif/else instead of an independent statement.
		const doc = parseDocument("if true\n    G1 X1\nif true\n    G1 X2\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("complete");
		expect(lines(r)).toEqual([0, 1, 2, 3, 4]);
	});

	it("regression: an undefined variable read from a condition is a clean WalkOutcome error, not an uncaught exception", () => {
		// A real bug: resolveVariable threw a plain Error, which evaluateExpression's own catch doesn't
		// convert (only EvalError/UnresolvedPathError are) - it propagated straight out of walkExecution
		// as a real crash instead of the documented {status:"error"} outcome.
		const doc = parseDocument("if var.neverDeclared > 0\n    G1 X1\nM400\n");
		expect(() => walkExecution(doc, { resolvePath: noPaths() })).not.toThrow();
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("error");
	});
});

describe("startLine/endLine", () => {
	it("restricts the walk to a sub-range of the document", () => {
		const doc = parseDocument("G28\nG1 X1\nG1 X2\nG1 X3\n");
		const r = walkExecution(doc, { resolvePath: noPaths(), startLine: 1, endLine: 3 });
		expect(lines(r)).toEqual([1, 2]);
	});
});

describe("'var' block scoping", () => {
	it("a var declared inside an if body is gone once the body ends", () => {
		const doc = parseDocument("if true\n    var x = 1\nif var.x > 0\n    G1 X1\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("error"); // the second 'if' can't see the first if-body's var.x
		expect((r as { message: string }).message).toMatch(/'var\.x' is not defined/);
	});

	it("an outer var IS visible inside a nested if's body", () => {
		const doc = parseDocument("var x = 5\nif true\n    if var.x > 0\n        G1 X1\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("complete");
	});

	it("an inner var shadows an outer one of the same name, without corrupting the outer value", () => {
		const doc = parseDocument("var x = 1\nif true\n    var x = 99\n    if var.x = 99\n        G1 X1\nif var.x = 1\n    G1 X2\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("complete");
		// Both inner bodies ran: the shadowed x=99 check inside the if, and the outer x=1 check after it
		// (proving the inner 'var x = 99' declaration didn't leak out and overwrite the outer x).
		expect(lines(r)).toContain(3); // "G1 X1" - inner shadow saw 99
		expect(lines(r)).toContain(6); // "G1 X2" - outer scope still sees the original 1
	});

	it("each while iteration gets its own fresh var scope (no stale value from a previous iteration)", () => {
		// Each iteration declares 'seen' fresh - if scoping leaked across iterations, 'set var.seen'
		// would fail on iteration 2 (nothing WOULD be declared yet, since 'var seen' re-declares every
		// time), or worse, silently reuse a stale frame. Redeclaring with 'var' every iteration and
		// reading it back within the SAME iteration is the observable behaviour this test locks in.
		const doc = parseDocument("var i = 0\nwhile var.i < 2\n    var seen = var.i\n    G1 X{seen}\n    set var.i = var.i + 1\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("complete");
	});

	it("'set' on a var that only exists in an outer scope updates the outer one, not a new inner copy", () => {
		const doc = parseDocument("var x = 1\nif true\n    set var.x = 2\nif var.x = 2\n    G1 X1\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("complete");
		expect(lines(r)).toContain(4); // "G1 X1" - the outer x really became 2
	});

	it("global is NOT block-scoped - visible everywhere regardless of where it was declared", () => {
		const doc = parseDocument("if true\n    global x = 1\nif global.x = 1\n    G1 X1\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("complete");
		expect(lines(r)).toContain(3);
	});
});

describe("objectModelVersion (schema validation)", () => {
	it("a path that doesn't exist at the given RRF version is a hard error, not a pause", () => {
		const doc = parseDocument("if bogus.path.here > 0\n    G1 X1\nM400\n");
		const r = walkExecution(doc, { resolvePath: noPaths(), objectModelVersion: "3.7.0-rc.1" });
		expect(r.status).toBe("error");
		expect((r as { message: string }).message).toMatch(/not a known object-model path/);
	});

	it("a real, known path still resolves normally through the caller's resolvePath", () => {
		const doc = parseDocument("if sensors.gpIn[0].value > 0\n    G1 X1\nM400\n");
		const r = walkExecution(doc, { resolvePath: () => 1, objectModelVersion: "3.7.0-rc.1" });
		expect(r.status).toBe("complete");
	});

	it("a path added only in a later RRF version is rejected at an earlier one", () => {
		// move.motionSystems - real dwc-gcode-core object-model schema data: since 3.7.0-beta.1.
		const doc = parseDocument("if move.motionSystems[0].speedFactor > 0\n    G1 X1\nM400\n");
		const r = walkExecution(doc, { resolvePath: () => 1, objectModelVersion: "3.6.3" });
		expect(r.status).toBe("error");
	});

	it("without objectModelVersion, an unknown/typo'd path is NOT flagged - it just pauses like any other", () => {
		const doc = parseDocument("if bogus.path.here > 0\n    G1 X1\nM400\n");
		const resolvePath = (path: string): EvalValue => { throw new UnresolvedPathError(path); };
		const r = walkExecution(doc, { resolvePath });
		expect(r.status).toBe("paused");
	});

	it("an unknown/untracked RRF version surfaces as an ordinary error outcome, not a thrown exception", () => {
		const doc = parseDocument("if sensors.gpIn[0].value > 0\n    G1 X1\nM400\n");
		expect(() => walkExecution(doc, { resolvePath: () => 1, objectModelVersion: "9.9.9-not-real" })).not.toThrow();
		const r = walkExecution(doc, { resolvePath: () => 1, objectModelVersion: "9.9.9-not-real" });
		expect(r.status).toBe("error");
	});
});

describe("onStep", () => {
	it("fires once per step, in order, matching the final steps array exactly", () => {
		const doc = parseDocument("if true\n    G1 X1\nelse\n    G1 X2\nM400\n");
		const seen: Array<number> = [];
		const r = walkExecution(doc, { resolvePath: noPaths(), onStep: (s) => seen.push(s.line) });
		expect(seen).toEqual(lines(r));
	});

	it("fires BEFORE walkExecution itself returns - a caller can build live state during the walk", () => {
		const doc = parseDocument("G28\nif var.neverDeclared > 0\n    G1 X1\nM400\n");
		const seen: Array<number> = [];
		walkExecution(doc, { resolvePath: noPaths(), onStep: (s) => seen.push(s.line) });
		// Even though the walk pauses/errors partway through, onStep already saw the step(s) that DID
		// complete before that point - proving it's a live callback, not just steps-array access after.
		expect(seen).toEqual([0]);
	});

	it("still fires for the last step recorded right before a step-budget error", () => {
		const doc = parseDocument("while true\n    G1 X1\nM400\n");
		const seen: Array<number> = [];
		const r = walkExecution(doc, { resolvePath: noPaths(), onStep: (s) => seen.push(s.line), maxSteps: 5 });
		expect(r.status).toBe("error");
		// maxSteps is a "no more than N" budget checked AFTER each push, so the step that actually
		// crosses it (totalSteps becomes 6, > 5) still gets recorded and still fires onStep.
		expect(seen.length).toBe(6);
	});
});

describe("blocking M291 message boxes", () => {
	it("a non-blocking M291 (S0/S1) is just an ordinary step - no pause even with no resolveMessageBox", () => {
		const doc = parseDocument('M291 P"hi" S1\nG1 X1\n');
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("complete");
		expect(lines(r)).toEqual([0, 1]);
	});

	it("a blocking M291 pauses with the parsed prompt when no resolveMessageBox is given", () => {
		const doc = parseDocument('G28\nM291 P"Ready?" R"Confirm" S2\nG1 X1\n');
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("message-box");
		expect(r).toMatchObject({ line: 1, prompt: { mode: "ok", message: "Ready?", title: "Confirm" } });
		expect(lines(r)).toEqual([0]); // the M291 line itself hasn't completed yet
	});

	it("an accepted OK box continues, and the line IS recorded as a step", () => {
		const doc = parseDocument('M291 P"Ready?" S2\nG1 X1\n');
		const resolveMessageBox = (): MessageBoxAnswer => ({ input: null, cancelled: false });
		const r = walkExecution(doc, { resolvePath: noPaths(), resolveMessageBox });
		expect(r.status).toBe("complete");
		expect(lines(r)).toEqual([0, 1]);
	});

	it("an accepted value box (S5/S6/S7) exposes the entered value via the 'input' constant on a later line", () => {
		const doc = parseDocument('M291 P"How many?" S5 L0 H10\nif input > 3\n    G1 X1\nG1 Y1\n');
		const resolveMessageBox = (): MessageBoxAnswer => ({ input: 7, cancelled: false });
		const r = walkExecution(doc, { resolvePath: noPaths(), resolveMessageBox });
		expect(r.status).toBe("complete");
		expect(lines(r)).toEqual([0, 1, 2, 3]);
	});

	it("'result' reads 0 after an accepted box", () => {
		const doc = parseDocument('M291 P"Ready?" S2\nif result = 0\n    G1 X1\n');
		const resolveMessageBox = (): MessageBoxAnswer => ({ input: null, cancelled: false });
		const r = walkExecution(doc, { resolvePath: noPaths(), resolveMessageBox });
		expect(r.status).toBe("complete");
		expect(lines(r)).toEqual([0, 1, 2]);
	});

	it("cancelling an S3 box aborts the walk by default (RRF's own default: shouldAbort unless J2)", () => {
		const doc = parseDocument('M291 P"Continue?" S3\nG1 X1\n');
		const resolveMessageBox = (): MessageBoxAnswer => ({ input: null, cancelled: true });
		const r = walkExecution(doc, { resolvePath: noPaths(), resolveMessageBox });
		expect(r.status).toBe("complete");
		expect(lines(r)).toEqual([0]); // line 1 never runs - the walk ended at the cancelled box
	});

	it("cancelling an S3 box with J2 does NOT abort - execution continues with result=-1", () => {
		const doc = parseDocument('M291 P"Continue?" S3 J2\nif result = -1\n    G1 X1\n');
		const resolveMessageBox = (): MessageBoxAnswer => ({ input: null, cancelled: true });
		const r = walkExecution(doc, { resolvePath: noPaths(), resolveMessageBox });
		expect(r.status).toBe("complete");
		expect(lines(r)).toEqual([0, 1, 2]);
	});

	it("resolveMessageBox throwing UnresolvedMessageBoxError pauses, same as omitting the option", () => {
		const doc = parseDocument('M291 P"Ready?" S2\n');
		const resolveMessageBox = (): MessageBoxAnswer => { throw new UnresolvedMessageBoxError(); };
		const r = walkExecution(doc, { resolvePath: noPaths(), resolveMessageBox });
		expect(r.status).toBe("message-box");
	});

	it("teeth: a genuine programmer error from resolveMessageBox is NOT swallowed as a pause", () => {
		const doc = parseDocument('M291 P"Ready?" S2\n');
		const resolveMessageBox = (): MessageBoxAnswer => { throw new TypeError("boom"); };
		expect(() => walkExecution(doc, { resolvePath: noPaths(), resolveMessageBox })).toThrow(TypeError);
	});

	it("S4 (choice) pauses on 'message-box' with the evaluated choices, when no resolveMessageBox is given", () => {
		const doc = parseDocument('M291 P"Pick" S4 K{"a","b","c"}\nG1 X1\n');
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("message-box");
		expect(r).toMatchObject({ line: 0, prompt: { mode: "choice", message: "Pick", choices: ["a", "b", "c"] } });
	});

	it("S4 accepts an answer and 'input' reads the chosen index on a later line", () => {
		const doc = parseDocument('M291 P"Pick" S4 K{"a","b","c"}\nif input = 1\n    G1 X1\n');
		const resolveMessageBox = (): MessageBoxAnswer => ({ input: 1, cancelled: false });
		const r = walkExecution(doc, { resolvePath: noPaths(), resolveMessageBox });
		expect(r.status).toBe("complete");
		expect(lines(r)).toEqual([0, 1, 2]);
	});

	it("K referencing a var is evaluated with the walker's own live variable scope", () => {
		const doc = parseDocument('var opts = ["x","y"]\nM291 P"Pick" S4 K{var.opts}\n');
		const resolveMessageBox = vi.fn((): MessageBoxAnswer => ({ input: 0, cancelled: false }));
		const r = walkExecution(doc, { resolvePath: noPaths(), resolveMessageBox });
		expect(r.status).toBe("complete");
		expect(resolveMessageBox).toHaveBeenCalledWith({ mode: "choice", message: "Pick", title: null, choices: ["x", "y"], defaultIndex: null });
	});

	it("K evaluating to something other than an array of strings is a clean error, not a crash", () => {
		const doc = parseDocument('M291 P"Pick" S4 K{1 + 1}\n');
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("error");
		expect((r as { message: string }).message).toMatch(/array of strings/);
	});

	it("a missing K is a clean error, matching RRF's own MustSee('K')", () => {
		const doc = parseDocument('M291 P"Pick" S4\n');
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("error");
	});

	it("K referencing an unresolved object-model path pauses on THAT path, not the message box", () => {
		const doc = parseDocument('M291 P"Pick" S4 K{sensors.gpIn[0].value}\n');
		const resolvePath = (path: string): EvalValue => { throw new UnresolvedPathError(path); };
		const r = walkExecution(doc, { resolvePath });
		expect(r.status).toBe("paused");
		expect(r).toMatchObject({ path: "sensors.gpIn[0].value" });
	});
});

describe("'line' and 'iterations' execution constants", () => {
	it("'line' reads the current 1-based physical line number", () => {
		const doc = parseDocument("G28\nif line = 2\n    G1 X1\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("complete");
		expect(lines(r)).toEqual([0, 1, 2]);
	});

	it("'iterations' is 0-based and tracks the innermost while loop", () => {
		const doc = parseDocument("var i = 0\nwhile var.i < 3\n    if iterations = 1\n        G1 X1\n    set var.i = var.i + 1\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("complete");
		// Only the SECOND iteration (iterations === 1) reaches line 3's body.
		const bodyHits = r.steps.filter((s) => s.line === 3).length;
		expect(bodyHits).toBe(1);
	});

	it("'iterations' outside any loop is a clean error, not a crash", () => {
		const doc = parseDocument("if iterations = 0\n    G1 X1\n");
		const r = walkExecution(doc, { resolvePath: noPaths() });
		expect(r.status).toBe("error");
	});
});
