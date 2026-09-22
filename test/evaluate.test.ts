import { describe, expect, it, vi } from "vitest";

import {
	EvalError, type EvalContext, type EvalValue, UnresolvedPathError, evaluateExpression,
} from "../src/expr/evaluate.js";
import { parseExpression } from "../src/expr/parse.js";

function ctx(overrides?: Partial<EvalContext>): EvalContext {
	return {
		resolvePath: () => { throw new Error(`unexpected path lookup`); },
		resolveVariable: () => { throw new Error(`unexpected variable lookup`); },
		...overrides,
	};
}

function evalExpr(text: string, c: EvalContext = ctx()) {
	return evaluateExpression(parseExpression(text).ast, c);
}

describe("literals and arithmetic", () => {
	it("evaluates numbers, strings and booleans", () => {
		expect(evalExpr("42")).toEqual({ ok: true, value: 42 });
		expect(evalExpr('"hello"')).toEqual({ ok: true, value: "hello" });
		expect(evalExpr("true")).toEqual({ ok: true, value: true });
	});

	it("does arithmetic with normal precedence", () => {
		expect(evalExpr("2 + 3 * 4")).toEqual({ ok: true, value: 14 });
	});

	it("teeth: division is real division, not integer division", () => {
		expect(evalExpr("7 / 2")).toEqual({ ok: true, value: 3.5 });
	});

	it("rejects arithmetic on non-numbers", () => {
		const r = evalExpr('1 + "a"');
		expect(r).toMatchObject({ ok: false, kind: "error" });
	});
});

describe("'^' is concatenation, not exponentiation", () => {
	it("joins two arrays", () => {
		expect(evalExpr("[1,2] ^ [3,4]")).toEqual({ ok: true, value: [1, 2, 3, 4] });
	});

	it("stringifies and joins when either side isn't an array", () => {
		expect(evalExpr('1 ^ "a"')).toEqual({ ok: true, value: "1a" });
	});

	it("teeth: '^' must NOT compute a power — pow() is the function for that", () => {
		const r = evalExpr("2 ^ 3");
		expect(r).not.toEqual({ ok: true, value: 8 });
		expect(r).toEqual({ ok: true, value: "23" });
		expect(evalExpr("pow(2,3)")).toEqual({ ok: true, value: 8 });
	});
});

describe("comparisons", () => {
	it("compares numbers", () => {
		expect(evalExpr("3 > 2")).toEqual({ ok: true, value: true });
		expect(evalExpr("3 >= 3")).toEqual({ ok: true, value: true });
		expect(evalExpr("3 < 2")).toEqual({ ok: true, value: false });
	});

	it("compares strings lexicographically", () => {
		expect(evalExpr('"a" < "b"')).toEqual({ ok: true, value: true });
	});

	it("accepts '==' and '!=' as RRF's own alternates for '=' and its negation", () => {
		expect(evalExpr("1 == 1")).toEqual({ ok: true, value: true });
		expect(evalExpr("1 != 2")).toEqual({ ok: true, value: true });
	});

	it("teeth: ordering a number against a string is a hard error, not a coercion", () => {
		const r = evalExpr('3 > "2"');
		expect(r).toMatchObject({ ok: false, kind: "error" });
	});

	it("rejects comparing arrays", () => {
		const r = evalExpr("[1] = [1]");
		expect(r).toMatchObject({ ok: false, kind: "error" });
	});
});

describe("boolean operators — short-circuit", () => {
	it("'&&' short-circuits on a false left side, never touching the right", () => {
		const resolvePath = vi.fn(() => { throw new Error("should not be called"); });
		const r = evalExpr("false && sensors.gpIn[0].value > 0", ctx({ resolvePath }));
		expect(r).toEqual({ ok: true, value: false });
		expect(resolvePath).not.toHaveBeenCalled();
	});

	it("'||' short-circuits on a true left side, never touching the right", () => {
		const resolvePath = vi.fn(() => { throw new Error("should not be called"); });
		const r = evalExpr("true || sensors.gpIn[0].value > 0", ctx({ resolvePath }));
		expect(r).toEqual({ ok: true, value: true });
		expect(resolvePath).not.toHaveBeenCalled();
	});

	it("'&'/'|' accept the same short forms as '&&'/'||'", () => {
		expect(evalExpr("true & false")).toEqual({ ok: true, value: false });
		expect(evalExpr("false | true")).toEqual({ ok: true, value: true });
	});

	it("does evaluate the right side when short-circuiting doesn't apply", () => {
		const resolvePath = vi.fn(() => true);
		const r = evalExpr("true && sensors.gpIn[0].value", ctx({ resolvePath }));
		expect(r).toEqual({ ok: true, value: true });
		expect(resolvePath).toHaveBeenCalledWith("sensors.gpIn[0].value");
	});
});

describe("ternary — lazy on the untaken branch", () => {
	it("only evaluates the chosen branch", () => {
		const resolvePath = vi.fn(() => { throw new Error("should not be called"); });
		expect(evalExpr("true ? 1 : sensors.gpIn[0].value", ctx({ resolvePath }))).toEqual({ ok: true, value: 1 });
		expect(resolvePath).not.toHaveBeenCalled();
		expect(evalExpr("false ? sensors.gpIn[0].value : 2", ctx({ resolvePath }))).toEqual({ ok: true, value: 2 });
		expect(resolvePath).not.toHaveBeenCalled();
	});
});

describe("unary operators", () => {
	it("negates and passes through", () => {
		expect(evalExpr("-5")).toEqual({ ok: true, value: -5 });
		expect(evalExpr("+5")).toEqual({ ok: true, value: 5 });
	});

	it("logical not requires a boolean", () => {
		expect(evalExpr("!true")).toEqual({ ok: true, value: false });
		expect(evalExpr("!1")).toMatchObject({ ok: false, kind: "error" });
	});
});

describe("object-model paths", () => {
	it("builds a fully-concrete path, substituting evaluated indices", () => {
		const resolvePath = vi.fn(() => 1);
		evalExpr("move.axes[0].homed", ctx({ resolvePath }));
		expect(resolvePath).toHaveBeenCalledWith("move.axes[0].homed");
	});

	it("evaluates a dynamic index expression before building the path", () => {
		const resolvePath = vi.fn(() => 1);
		evalExpr("move.axes[1 + 1].homed", ctx({ resolvePath }));
		expect(resolvePath).toHaveBeenCalledWith("move.axes[2].homed");
	});

	it("surfaces UnresolvedPathError as a distinct outcome from a generic error", () => {
		const resolvePath = () => { throw new UnresolvedPathError("sensors.gpIn[0].value"); };
		const r = evalExpr("sensors.gpIn[0].value > 0", ctx({ resolvePath }));
		expect(r).toEqual({ ok: false, kind: "unresolved-path", path: "sensors.gpIn[0].value" });
	});

	it("teeth: a plain EvalError from resolvePath is NOT reported as unresolved-path", () => {
		const resolvePath = () => { throw new EvalError("no such path"); };
		const r = evalExpr("bogus.path", ctx({ resolvePath }));
		expect(r).toMatchObject({ ok: false, kind: "error" });
		expect((r as { kind: "error" }).kind).not.toBe("unresolved-path");
	});

	it("an unresolved path inside a short-circuited operand never surfaces", () => {
		const resolvePath = () => { throw new UnresolvedPathError("sensors.gpIn[0].value"); };
		const r = evalExpr("false && sensors.gpIn[0].value > 0", ctx({ resolvePath }));
		expect(r).toEqual({ ok: true, value: false });
	});
});

describe("variables", () => {
	it("resolves var/global by bare name", () => {
		const resolveVariable = (scope: string, name: string): EvalValue => (scope === "var" && name === "x" ? 7 : 0);
		expect(evalExpr("var.x", ctx({ resolveVariable }))).toEqual({ ok: true, value: 7 });
	});

	it("indexes an array-valued variable", () => {
		const resolveVariable = (): EvalValue => [10, 20, 30];
		expect(evalExpr("var.arr[1]", ctx({ resolveVariable }))).toEqual({ ok: true, value: 20 });
	});

	it("an undefined variable is a plain error (RRF treats it as one, not a live-state pause)", () => {
		const resolveVariable = () => { throw new EvalError("'x' is not defined"); };
		const r = evalExpr("var.x", ctx({ resolveVariable }));
		expect(r).toMatchObject({ ok: false, kind: "error" });
	});

	it("indexing something that isn't an array is a clean error, not a crash", () => {
		const resolveVariable = (): EvalValue => 5;
		const r = evalExpr("var.x[0]", ctx({ resolveVariable }));
		expect(r).toMatchObject({ ok: false, kind: "error" });
	});
});

describe("functions — the implemented deterministic subset", () => {
	it("evaluates unary math functions", () => {
		expect(evalExpr("abs(-5)")).toEqual({ ok: true, value: 5 });
		expect(evalExpr("floor(1.9)")).toEqual({ ok: true, value: 1 });
		expect(evalExpr("sqrt(9)")).toEqual({ ok: true, value: 3 });
	});

	it("evaluates mod/pow/atan2 with two arguments", () => {
		expect(evalExpr("mod(7, 3)")).toEqual({ ok: true, value: 1 });
		expect(evalExpr("pow(2, 10)")).toEqual({ ok: true, value: 1024 });
	});

	it("max/min accept an array or 2+ scalars", () => {
		expect(evalExpr("max([1,5,3])")).toEqual({ ok: true, value: 5 });
		expect(evalExpr("min(1,5,3)")).toEqual({ ok: true, value: 1 });
	});

	it("a function outside the implemented subset is a clean 'not supported' error, not a crash", () => {
		const r = evalExpr('fileexists("0:/sys/config.g")');
		expect(r).toMatchObject({ ok: false, kind: "error" });
	});

	it("vector(n, fill) builds an array of n copies of fill", () => {
		expect(evalExpr("vector(3, 0)")).toEqual({ ok: true, value: [0, 0, 0] });
		expect(evalExpr('vector(2, "x")')).toEqual({ ok: true, value: ["x", "x"] });
	});

	it("vector rejects a negative or non-integer element count", () => {
		expect(evalExpr("vector(-1, 0)")).toMatchObject({ ok: false, kind: "error" });
		expect(evalExpr("vector(1.5, 0)")).toMatchObject({ ok: false, kind: "error" });
	});

	it("take/drop split an array at n, take keeping the front and drop keeping the rest", () => {
		expect(evalExpr("take([1,2,3,4], 2)")).toEqual({ ok: true, value: [1, 2] });
		expect(evalExpr("drop([1,2,3,4], 2)")).toEqual({ ok: true, value: [3, 4] });
	});

	it("take/drop also work on strings, character-wise", () => {
		expect(evalExpr('take("hello", 3)')).toEqual({ ok: true, value: "hel" });
		expect(evalExpr('drop("hello", 3)')).toEqual({ ok: true, value: "lo" });
	});

	it("teeth: take/drop clamp to the real length rather than erroring past the end", () => {
		expect(evalExpr("take([1,2], 10)")).toEqual({ ok: true, value: [1, 2] });
		expect(evalExpr("drop([1,2], 10)")).toEqual({ ok: true, value: [] });
	});

	it("find returns the 0-based index of a substring or character, or -1", () => {
		expect(evalExpr('find("hello world", "world")')).toEqual({ ok: true, value: 6 });
		expect(evalExpr("find(\"hello\", 'l')")).toEqual({ ok: true, value: 2 });
		expect(evalExpr('find("hello", "z")')).toEqual({ ok: true, value: -1 });
	});

	it("find on a non-string first operand is a clean error, matching RRF's own 'not yet implemented for arrays'", () => {
		const r = evalExpr('find([1,2,3], "x")');
		expect(r).toMatchObject({ ok: false, kind: "error" });
	});
});

describe("exists()", () => {
	it("is true for a declared var/global, false for an undeclared one, without needing pathExists", () => {
		const resolveVariable = (_scope: string, name: string) => { if (name !== "x") throw new Error("undefined"); return 1; };
		expect(evalExpr("exists(var.x)", ctx({ resolveVariable }))).toEqual({ ok: true, value: true });
		expect(evalExpr("exists(var.y)", ctx({ resolveVariable }))).toEqual({ ok: true, value: false });
	});

	it("teeth: exists() does NOT evaluate the variable, just checks it resolves - an error mid-value is still 'exists'", () => {
		// resolveVariable succeeding (not throwing) is what exists() checks - it never looks at the
		// value itself the way a normal reference to var.x would.
		const resolveVariable = () => "irrelevant";
		expect(evalExpr("exists(var.x)", ctx({ resolveVariable }))).toEqual({ ok: true, value: true });
	});

	it("on an object-model path, defers to pathExists when the context provides one", () => {
		const pathExists = (path: string) => path === "sensors.gpIn[0].value";
		expect(evalExpr("exists(sensors.gpIn[0].value)", ctx({ pathExists }))).toEqual({ ok: true, value: true });
		expect(evalExpr("exists(state.status)", ctx({ pathExists }))).toEqual({ ok: true, value: false });
	});

	it("teeth: exists() on an object-model path never calls resolvePath - it must not pause/error on an unresolved live value", () => {
		const resolvePath = vi.fn(() => { throw new Error("should not be called"); });
		const pathExists = () => true;
		const r = evalExpr("exists(sensors.gpIn[0].value)", ctx({ resolvePath, pathExists }));
		expect(r).toEqual({ ok: true, value: true });
		expect(resolvePath).not.toHaveBeenCalled();
	});

	it("on an object-model path with no pathExists supplied, a clean 'not supported' error, not a guess", () => {
		const r = evalExpr("exists(sensors.gpIn[0].value)");
		expect(r).toMatchObject({ ok: false, kind: "error" });
	});

	it("rejects a non-identifier argument", () => {
		const r = evalExpr("exists(1 + 1)");
		expect(r).toMatchObject({ ok: false, kind: "error" });
	});
});

describe("execution-state constants (result/input/line/iterations)", () => {
	it("resolves each through resolveExecutionConstant when supplied", () => {
		const resolveExecutionConstant = (name: string) => ({ result: 0, input: "answer", line: 42, iterations: 3 } as const)[name as "result"];
		expect(evalExpr("result", ctx({ resolveExecutionConstant }))).toEqual({ ok: true, value: 0 });
		expect(evalExpr("input", ctx({ resolveExecutionConstant }))).toEqual({ ok: true, value: "answer" });
		expect(evalExpr("line", ctx({ resolveExecutionConstant }))).toEqual({ ok: true, value: 42 });
		expect(evalExpr("iterations", ctx({ resolveExecutionConstant }))).toEqual({ ok: true, value: 3 });
	});

	it("without a context implementation, each is a clean 'not supported' error, not a crash", () => {
		expect(evalExpr("result")).toMatchObject({ ok: false, kind: "error" });
		expect(evalExpr("input")).toMatchObject({ ok: false, kind: "error" });
		expect(evalExpr("line")).toMatchObject({ ok: false, kind: "error" });
		expect(evalExpr("iterations")).toMatchObject({ ok: false, kind: "error" });
	});

	it("a context that throws for 'iterations' (not inside a loop) surfaces as an ordinary error", () => {
		const resolveExecutionConstant = (): never => { throw new EvalError("'iterations' used when not inside a loop"); };
		const r = evalExpr("iterations", ctx({ resolveExecutionConstant }));
		expect(r).toMatchObject({ ok: false, kind: "error" });
	});
});

describe("evaluateExpression's boundary", () => {
	it("never throws for a value-domain failure", () => {
		expect(() => evalExpr('1 + "a"')).not.toThrow();
	});

	it("teeth: a genuine programmer error in the context (not EvalError/UnresolvedPathError) still propagates", () => {
		const resolvePath = () => { throw new TypeError("boom"); };
		expect(() => evalExpr("sensors.gpIn[0].value", ctx({ resolvePath }))).toThrow(TypeError);
	});
});
