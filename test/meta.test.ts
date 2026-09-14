import { describe, expect, it } from "vitest";

import { classifyLine, type MetaKeyword, parseAssignment } from "../src/meta.js";

const ALL_KEYWORDS: ReadonlyArray<MetaKeyword> = [
	"if", "elif", "else", "while", "break", "continue", "abort", "var", "global", "set", "echo", "skip",
];

describe("classifyLine: meta-keyword recognition", () => {
	it.each(ALL_KEYWORDS)("recognises '%s' terminated by a space", (kw) => {
		expect(classifyLine(`${kw} x = 1`)).toMatchObject({ kind: "meta", meta: kw });
	});

	it.each(ALL_KEYWORDS)("recognises '%s' alone on the line", (kw) => {
		expect(classifyLine(kw)).toMatchObject({ kind: "meta", meta: kw });
	});

	it("terminates a keyword on '{', '\"' and '(' too, not just whitespace", () => {
		expect(classifyLine('if{sensors.gpIn[0].value = 1}')).toMatchObject({ kind: "meta", meta: "if" });
		expect(classifyLine('echo"hello"')).toMatchObject({ kind: "meta", meta: "echo" });
	});

	it("is case-sensitive - unlike G/M/T commands, RRF reads these lowercase-only", () => {
		expect(classifyLine("If sensors.gpIn[0].value = 1").kind).not.toBe("meta");
		expect(classifyLine("VAR x = 1").kind).not.toBe("meta");
		expect(classifyLine("Echo \"hi\"").kind).not.toBe("meta");
	});

	it("does not match a word that merely starts with a keyword (needs a real terminator)", () => {
		// "variable" starts with "var" but the 4th char 'i' is not a valid terminator
		expect(classifyLine("variable = 1").kind).not.toBe("meta");
		expect(classifyLine("ifonly = 1").kind).not.toBe("meta");
	});

	it("there is no 'return' keyword - RRF's conditional G-code has none", () => {
		expect(classifyLine("return").kind).not.toBe("meta");
	});

	it("recognises 'skip' as meta even though it's a no-op in the firmware", () => {
		expect(classifyLine("skip").kind).toBe("meta");
	});
});

describe("classifyLine: the other four kinds", () => {
	it("blank line", () => {
		expect(classifyLine("").kind).toBe("blank");
		expect(classifyLine("   ").kind).toBe("blank");
		expect(classifyLine("\t")).toMatchObject({ kind: "blank", indent: 4 });
	});

	it("comment-only line, indented or not", () => {
		expect(classifyLine("; a note")).toMatchObject({ kind: "comment", indent: 0 });
		expect(classifyLine("  ; a note")).toMatchObject({ kind: "comment", indent: 2 });
	});

	it("a real G/M/T command, with its tokenised form attached", () => {
		const line = classifyLine("G1 X10 Y20 ; move");
		expect(line.kind).toBe("command");
		expect(line.command?.code).toBe("G1");
		expect(line.command?.raw).toBe("G1 X10 Y20 ; move"); // the original line, unsliced
	});

	it("a bare command letter with no digits is still a command (the lex.ts fix carries through)", () => {
		expect(classifyLine("T").kind).toBe("command");
	});

	it("unrecognised: neither a command, a meta line, a comment, nor blank", () => {
		// Deliberately NOT starting with 'g'/'m'/'t' - any of those would (correctly - see lex.ts's
		// own tests) tokenise as a bare command, since a command letter needs no digits to be one.
		expect(classifyLine("xyz123").kind).toBe("unrecognised");
	});
});

describe("classifyLine: indent (RRF's exact counting rule)", () => {
	it("each leading space adds 1", () => {
		expect(classifyLine("   G1 X1").indent).toBe(3);
	});

	it("each leading tab rounds up to the next multiple of 4", () => {
		expect(classifyLine("\tG1 X1").indent).toBe(4);
		expect(classifyLine("\t\tG1 X1").indent).toBe(8);
	});

	it("a space then a tab rounds the running total up, not adds a flat 4", () => {
		// 1 (space) -> 1, then tab rounds (1+4)&~3 = 4
		expect(classifyLine(" \tG1 X1").indent).toBe(4);
	});

	it("stops counting at the first non-whitespace character, including 'N'", () => {
		// whitespace AFTER the line number does not add to indent
		expect(classifyLine("  N10 G1 X1").indent).toBe(2);
		expect(classifyLine("N10    G1 X1").indent).toBe(0);
	});

	it("is still computed for a line with no meaningful content at all", () => {
		expect(classifyLine("   ").indent).toBe(3);
	});
});

describe("a realistic nested macro (RRF 3.6.3+ shaped)", () => {
	const MACRO = [
		"; homeall.g",
		"G91 ; relative positioning",
		"if !move.axes[0].homed",
		"  G1 H1 X-350 F1800",
		"  if sensors.gpIn[0].value = 1",
		"    echo \"endstop already triggered\"",
		"    abort \"check X endstop\"",
		"  else",
		"    G1 H2 X5 F600",
		"var retries = 0",
		"while var.retries < 3",
		"  G1 H1 X-350 F1800",
		"  set var.retries = var.retries + 1",
		"G90 ; back to absolute",
	].join("\n");

	it("classifies every line correctly - the corpus test this phase is built on", () => {
		const kinds = MACRO.split("\n").map((l) => classifyLine(l).kind);
		expect(kinds).toEqual([
			"comment", "command", "meta", "command", "meta", "meta", "meta", "meta", "command",
			"meta", "meta", "command", "meta", "command",
		]);
	});

	it("indentation nests correctly through the if/else block", () => {
		const lines = MACRO.split("\n").map((l) => classifyLine(l));
		expect(lines[2].indent).toBe(0); // if !move.axes[0].homed
		expect(lines[3].indent).toBe(2); // G1 H1 X-350 (inside the if)
		expect(lines[4].indent).toBe(2); // nested if
		expect(lines[5].indent).toBe(4); // echo (inside the nested if)
		expect(lines[7].indent).toBe(2); // else (back to the outer if's level)
	});

	it("never misreads a real command as meta, or vice versa", () => {
		for (const line of MACRO.split("\n")) {
			const c = classifyLine(line);
			if (c.kind === "command") expect(c.meta).toBeUndefined();
			if (c.kind === "meta") expect(c.command).toBeUndefined();
		}
	});
});

describe("parseAssignment", () => {
	it("local variable declaration - the wiki's own example", () => {
		expect(parseAssignment('var aaa = "aaa"')).toMatchObject({
			form: "declare", scope: "local", name: "aaa", expression: '"aaa"',
		});
	});

	it("global variable declaration - the wiki's own example", () => {
		expect(parseAssignment("global T1heat=0")).toMatchObject({
			form: "declare", scope: "global", name: "T1heat", expression: "0",
		});
	});

	it("global variable assignment - the wiki's own example", () => {
		expect(parseAssignment("set global.T1heat=heat.heaters[1].active")).toMatchObject({
			form: "set", scope: "global", name: "T1heat", expression: "heat.heaters[1].active",
		});
	});

	it("local variable assignment", () => {
		expect(parseAssignment("set var.retries = var.retries + 1")).toMatchObject({
			form: "set", scope: "local", name: "retries", expression: "var.retries + 1",
		});
	});

	it("strips a trailing comment from the expression", () => {
		expect(parseAssignment('global apiKey = "sk-abc123" ; do not share')).toMatchObject({
			form: "declare", scope: "global", name: "apiKey", expression: '"sk-abc123"',
		});
	});

	it("is case-sensitive, matching classifyLine", () => {
		expect(parseAssignment("Var x = 1")).toBeNull();
		expect(parseAssignment("Global x = 1")).toBeNull();
		expect(parseAssignment("Set global.x = 1")).toBeNull();
	});

	it("rejects a 'set' with neither var. nor global. - RRF itself throws on this", () => {
		expect(parseAssignment("set x = 1")).toBeNull();
	});

	it("rejects array-index assignment - out of scope, documented", () => {
		expect(parseAssignment("set var.e0Accel[0] = 500")).toBeNull();
		// RRF skips whitespace before the "[" too - `set var.x [0] = 5` is valid RRF syntax
		expect(parseAssignment("set var.e0Accel [0] = 500")).toBeNull();
	});

	it("does not mistake array syntax in the VALUE for an indexed target", () => {
		// The wiki's own "set global.T1heat=heat.heaters[1].active" example already covers this,
		// but this is the case that would have broken with a naive "does '[' appear anywhere after
		// the name" check.
		expect(parseAssignment("var x = move.axes[0].max")).toMatchObject({
			form: "declare", scope: "local", name: "x", expression: "move.axes[0].max",
		});
	});

	it("returns null for anything that isn't one of the four forms", () => {
		expect(parseAssignment("G1 X10")).toBeNull();
		expect(parseAssignment("if true")).toBeNull();
		expect(parseAssignment("echo \"hi\"")).toBeNull();
		expect(parseAssignment("")).toBeNull();
	});

	it("returns null for a malformed declaration (no '=', or no expression)", () => {
		expect(parseAssignment("var aaa")).toBeNull();
		expect(parseAssignment("var aaa =")).toBeNull();
	});

	it("handles indentation and a line number the same way classifyLine does", () => {
		expect(parseAssignment("  N20 var aaa = 1")).toMatchObject({
			form: "declare", scope: "local", name: "aaa", expression: "1",
		});
	});

	describe("name/expression spans", () => {
		it("always satisfy raw.slice(start, end) === the reported text", () => {
			const cases = [
				'var aaa = "aaa"',
				"global T1heat=0",
				"set global.T1heat=heat.heaters[1].active",
				"set var.retries = var.retries + 1",
				'  N20 var apiKey = "sk-abc123" ; do not share',
			];
			for (const raw of cases) {
				const a = parseAssignment(raw);
				expect(a, raw).not.toBeNull();
				expect(raw.slice(a!.nameStart, a!.nameEnd), raw).toBe(a!.name);
				expect(raw.slice(a!.expressionStart, a!.expressionEnd), raw).toBe(a!.expression);
			}
		});

		it("lets a caller replace just the value, byte-identical otherwise - the redaction use case", () => {
			const raw = 'set global.wifiPassword = "hunter2" ; do not share';
			const a = parseAssignment(raw)!;
			const redacted = raw.slice(0, a.expressionStart) + '"[REDACTED]"' + raw.slice(a.expressionEnd);
			expect(redacted).toBe('set global.wifiPassword = "[REDACTED]" ; do not share');
		});

		it("excludes surrounding whitespace from the expression span, not just the trimmed text", () => {
			const raw = "var x =   1   ";
			const a = parseAssignment(raw)!;
			expect(a.expression).toBe("1");
			expect(raw.slice(a.expressionStart, a.expressionEnd)).toBe("1"); // not "  1  "
		});
	});
});
