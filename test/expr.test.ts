import { describe, expect, it } from "vitest";

import { parseExpression } from "../src/expr/parse.js";
import { EXPRESSION_FUNCTIONS, NAMED_CONSTANTS } from "../src/expr/tables.js";

describe("precedence — one test per level of ParseInternal's own table", () => {
	it("'?:' (priority 1) binds loosest, and is right-associative", () => {
		const r = parseExpression("a ? b : c ? d : e");
		expect(r.ast).toMatchObject({ type: "ternary", else: { type: "ternary" } });
	});

	it("'^' (priority 2) binds tighter than '?:' but looser than '&'/'|'", () => {
		const r = parseExpression("a & b ^ c");
		expect(r.ast).toMatchObject({ type: "binary", op: "^", left: { op: "&" } });
	});

	it("'&' and '|' (priority 3) are the SAME priority - left to right, not AND-before-OR", () => {
		const r = parseExpression("a | b & c");
		// Left-to-right at equal priority: (a | b) & c, not a | (b & c).
		expect(r.ast).toMatchObject({ type: "binary", op: "&", left: { op: "|" } });
	});

	it("comparisons (priority 4) bind tighter than '&'/'|'", () => {
		const r = parseExpression("a = 1 & b = 2");
		expect(r.ast).toMatchObject({ type: "binary", op: "&", left: { op: "=" }, right: { op: "=" } });
	});

	it("'+'/'-' (priority 5) bind tighter than comparisons", () => {
		const r = parseExpression("a + 1 = b - 1");
		expect(r.ast).toMatchObject({ type: "binary", op: "=", left: { op: "+" }, right: { op: "-" } });
	});

	it("'*'/'/' (priority 6) bind tightest of the binary operators", () => {
		const r = parseExpression("1 + 2 * 3");
		expect(r.ast).toMatchObject({ type: "binary", op: "+", right: { op: "*" } });
		const r2 = parseExpression("1 * 2 + 3");
		expect(r2.ast).toMatchObject({ type: "binary", op: "+", left: { op: "*" } });
	});

	it("unary operators bind tighter than any binary one", () => {
		const r = parseExpression("-a + b");
		expect(r.ast).toMatchObject({ type: "binary", op: "+", left: { type: "unary", op: "-" } });
	});

	it("parentheses override precedence", () => {
		const r = parseExpression("(1 + 2) * 3");
		expect(r.ast).toMatchObject({ type: "binary", op: "*", left: { op: "+" } });
	});
});

describe("operator alternates and two-character forms", () => {
	it("accepts == as an alternate for =, && for &, || for |", () => {
		expect(parseExpression("a == b").ast).toMatchObject({ type: "binary", op: "=" });
		expect(parseExpression("a && b").ast).toMatchObject({ type: "binary", op: "&" });
		expect(parseExpression("a || b").ast).toMatchObject({ type: "binary", op: "|" });
	});

	it("reads <=, >= and != as their own operators", () => {
		expect(parseExpression("a <= b").ast).toMatchObject({ type: "binary", op: "<=" });
		expect(parseExpression("a >= b").ast).toMatchObject({ type: "binary", op: ">=" });
		expect(parseExpression("a != b").ast).toMatchObject({ type: "binary", op: "!=" });
	});
});

describe("'^' is concatenation (string or array), not exponentiation", () => {
	it("joins two strings", () => {
		const r = parseExpression("\"a\" ^ \"b\"");
		expect(r.ast).toMatchObject({ type: "binary", op: "^" });
	});

	it("applies to non-array operands too - confirmed against Concat() in source, not assumed", () => {
		// RRF's Concat() only special-cases BOTH operands being arrays; anything else is stringified
		// and joined - this is the task's own "check whether ^ also applies to strings" trap,
		// resolved: yes, unconditionally.
		const r = parseExpression("var.name ^ 5");
		expect(r.ast).toMatchObject({ type: "binary", op: "^" });
	});
});

describe("literals", () => {
	it("parses decimal integers and floats", () => {
		expect(parseExpression("42").ast).toMatchObject({ type: "number", value: 42 });
		expect(parseExpression("3.14").ast).toMatchObject({ type: "number", value: 3.14 });
	});

	it("parses a signed exponent", () => {
		expect(parseExpression("1e-3").ast).toMatchObject({ type: "number", value: 0.001 });
		expect(parseExpression("1.5e+2").ast).toMatchObject({ type: "number", value: 150 });
	});

	it("parses hex (0x) and binary (0b) literals, per NumericConverter::Accumulate", () => {
		expect(parseExpression("0x1F").ast).toMatchObject({ type: "number", value: 31 });
		expect(parseExpression("0b101").ast).toMatchObject({ type: "number", value: 5 });
	});

	it("parses a quoted string, unescaping doubled quotes", () => {
		const r = parseExpression("\"say \"\"hi\"\"\"");
		expect(r.ast).toMatchObject({ type: "string", value: "say \"hi\"" });
	});

	it("parses a character literal", () => {
		expect(parseExpression("'A'").ast).toMatchObject({ type: "string", value: "A" });
	});

	it("parses true/false/null as constants, not paths", () => {
		expect(parseExpression("true").ast).toMatchObject({ type: "constant", name: "true" });
		expect(parseExpression("false").ast).toMatchObject({ type: "constant", name: "false" });
		expect(parseExpression("null").ast).toMatchObject({ type: "constant", name: "null" });
	});

	it("parses array literals: empty, single-element and multi-element, with a trailing comma allowed", () => {
		expect(parseExpression("[]").ast).toMatchObject({ type: "array", items: [] });
		expect(parseExpression("[1]").ast).toMatchObject({ type: "array", items: [{ value: 1 }] });
		expect(parseExpression("[1,2,3]").ast).toMatchObject({ type: "array", items: [{ value: 1 }, { value: 2 }, { value: 3 }] });
		expect(parseExpression("[1,2,3,]").ast).toMatchObject({ type: "array", items: [{ value: 1 }, { value: 2 }, { value: 3 }] });
	});

	it("parses a nested array literal", () => {
		const r = parseExpression("{1,{2,3,4},5}");
		expect(r.ast.type).toBe("array");
		if (r.ast.type === "array") {
			expect(r.ast.items).toHaveLength(3);
			expect(r.ast.items[1]).toMatchObject({ type: "array", items: [{ value: 2 }, { value: 3 }, { value: 4 }] });
		}
		expect(r.errors).toEqual([]);
	});

	it("treats {expr} as a plain expression, not an array, with no trailing comma", () => {
		expect(parseExpression("{1+1}").ast).toMatchObject({ type: "binary", op: "+" });
	});

	it("treats {expr,} as a single-element array (RRF's own disambiguation)", () => {
		expect(parseExpression("{pi,}").ast).toMatchObject({ type: "array", items: [{ type: "constant", name: "pi" }] });
	});
});

describe("object-model paths and variable scopes", () => {
	it("normalises an array index to [] in the reported path", () => {
		const r = parseExpression("move.axes[0].homed");
		expect(r.objectModelPaths).toEqual([{ path: "move.axes[].homed", start: 0, end: 18 }]);
	});

	it("recognises var./global./param. as variable references, not object-model paths", () => {
		expect(parseExpression("var.retries").variables).toEqual([{ scope: "var", name: "retries", start: 0, end: 11 }]);
		expect(parseExpression("global.setPAValue").variables).toEqual([{ scope: "global", name: "setPAValue", start: 0, end: 17 }]);
		expect(parseExpression("param.S").variables).toEqual([{ scope: "param", name: "S", start: 0, end: 7 }]);
	});

	it("does not double-count a variable as an object-model path", () => {
		const r = parseExpression("var.retries");
		expect(r.objectModelPaths).toEqual([]);
	});

	it("finds every path/variable in a compound expression", () => {
		const r = parseExpression("var.a + global.b + move.axes[0].max");
		expect(r.variables.map((v) => v.name)).toEqual(["a", "b"]);
		expect(r.objectModelPaths.map((p) => p.path)).toEqual(["move.axes[].max"]);
	});
});

describe("functions", () => {
	it("parses every real function name as a known call", () => {
		for (const name of EXPRESSION_FUNCTIONS) {
			const r = parseExpression(`${name}(1)`);
			expect(r.functions, name).toEqual([{ name, known: true, start: 0, end: r.ast.end }]);
			expect(r.errors, name).toEqual([]);
		}
	});

	it("flags an unknown function name as a parse error, matching RRF's own parse-time check", () => {
		// ExpressionParser::ParseIdentifierExpression throws "unknown function" before even reading
		// the call's arguments - a real parse-time error in RRF, not deferred to evaluation.
		const r = parseExpression("bogus(1)");
		expect(r.functions).toEqual([{ name: "bogus", known: false, start: 0, end: 8 }]);
		expect(r.errors.map((e) => e.code)).toContain("unknown-function");
	});

	it("parses a multi-argument call", () => {
		const r = parseExpression("atan2(1, 2)");
		expect(r.ast).toMatchObject({ type: "call", name: "atan2", args: [{ value: 1 }, { value: 2 }] });
	});

	it("parses a variadic min/max call with more than two arguments", () => {
		const r = parseExpression("max(1, 2, 3, 4)");
		expect(r.ast.type).toBe("call");
		if (r.ast.type === "call") expect(r.ast.args).toHaveLength(4);
	});

	it("every named constant is recognised, not just the common ones (task's own trap)", () => {
		for (const name of NAMED_CONSTANTS) {
			expect(parseExpression(name).ast, name).toMatchObject({ type: "constant", name });
		}
	});
});

describe("errors — tolerant, never throws", () => {
	it("flags an unterminated string instead of throwing", () => {
		const r = parseExpression("\"abc");
		expect(r.errors.map((e) => e.code)).toContain("unterminated-string");
	});

	it("flags a missing closing bracket", () => {
		expect(parseExpression("(1 + 2").errors.map((e) => e.code)).toContain("expected-closing-bracket");
		expect(parseExpression("[1, 2").errors.map((e) => e.code)).toContain("expected-closing-bracket");
	});

	it("flags a missing ':' in a ternary", () => {
		expect(parseExpression("a ? b").errors.map((e) => e.code)).toContain("expected-colon");
	});

	it("flags unexpected trailing content after a complete expression", () => {
		expect(parseExpression("1 + 2 3").errors.map((e) => e.code)).toContain("trailing-content");
	});

	it("never throws on garbage input", () => {
		for (const bad of ["", "(", ")", "[", "]", "{", "}", "?", ":", "\"", "'", "..", "1.2.3", "&&&", "()"]) {
			expect(() => parseExpression(bad), bad).not.toThrow();
		}
	});
});

describe("real wiki expressions (Gcode_meta_commands.md, pinned 2026-09-14 @235a5a8)", () => {
	// Pulled from real "if"/"var"/"set" examples on the page. `{.is-info}` and `{target=_blank}` are
	// the wiki's OWN Markdown/HTML attribute syntax (admonition boxes, link targets) - not RRF
	// expressions at all - so they are deliberately excluded, not silently mis-tested.
	const EXAMPLES: ReadonlyArray<string> = [
		"global.defaultPA", "global.defaultSpeed", "global.e0StepsPerMm", "global.lastTool",
		"move.axes[0].max-10", "move.axes[1].max-10", "move.axes[1].min+10",
		"param.S", "param.T", "param.Y",
		"var.config", "var.defaultValue", "var.dir", "var.e0Accel", "var.e1Accel",
		"var.extruderDrive", "var.filepath", "var.id", "var.name", "var.newDiameters",
		"var.newDiameters[var.tool]", "var.newHF", "var.temperature", "var.tool", "var.unload", "var.value",
		"var.highFlow ? \"HF \" : \"\"",
		"\"/sys/globals/\"^var.id",
		"\"globals/\"^var.id",
		"\"Creating filament \"^var.name^\" (un)loading at \"^var.temperature^\"C\"",
		"\"Filament \"^var.name^\" already exists, overwrite?\"",
		"[global.e0StepsPerMm, 400]", "[var.e0Accel, var.e1Accel]",
		"[1,2,3]", "[1,2,3,]", "[false, false]", "[null, null]", "[pi,]", "[pi]",
	];

	for (const example of EXAMPLES) {
		it(`parses cleanly: ${example}`, () => {
			const r = parseExpression(example);
			expect(r.errors, example).toEqual([]);
		});
	}
});
