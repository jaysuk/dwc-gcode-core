import { describe, expect, it, vi } from "vitest";

import { parseDocument } from "../src/document.js";
import { UnresolvedPathError, type EvalValue } from "../src/expr/evaluate.js";
import { walkExecution, type WalkOutcome } from "../src/execute.js";

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
});

describe("startLine/endLine", () => {
	it("restricts the walk to a sub-range of the document", () => {
		const doc = parseDocument("G28\nG1 X1\nG1 X2\nG1 X3\n");
		const r = walkExecution(doc, { resolvePath: noPaths(), startLine: 1, endLine: 3 });
		expect(lines(r)).toEqual([1, 2]);
	});
});
