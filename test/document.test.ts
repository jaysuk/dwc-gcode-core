import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import {
	applyEdits, editInsertLines, editRemoveLine, editRemoveParam, editReplaceLine, editSetParam,
	expressionsOfLine, parseDocument, serializeDocument, UnsafeEditError,
} from "../src/document.js";

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), "corpus", "slicer");

describe("byte-exact round trip", () => {
	const cases: Record<string, string> = {
		LF: "G1 X10\nG1 Y20\nG1 Z5\n",
		CRLF: "G1 X10\r\nG1 Y20\r\nG1 Z5\r\n",
		"mixed line endings": "G1 X10\r\nG1 Y20\nG1 Z5\r",
		"lone CR": "G1 X10\rG1 Y20\r",
		"UTF-8 BOM": "﻿G1 X10\nG1 Y20\n",
		"no trailing newline": "G1 X10\nG1 Y20",
		"empty file": "",
		"blank lines and comments": "\n; a comment\n   \nG1 X10 ; move\n",
	};

	for (const [name, text] of Object.entries(cases)) {
		it(name, () => {
			const doc = parseDocument(text);
			expect(serializeDocument(doc)).toBe(text);
		});
	}

	it("marks the BOM separately from line 0's own text", () => {
		const doc = parseDocument("﻿G1 X10\n");
		expect(doc.bom).toBe(true);
		expect(doc.lines[0].raw).toBe("G1 X10");
		expect(doc.lines[0].start).toBe(1); // right after the BOM
	});

	it("round-trips every real slicer fixture, byte for byte", () => {
		for (const file of readdirSync(corpusDir).filter((f) => f.endsWith(".gcode"))) {
			const text = readFileSync(join(corpusDir, file), "utf-8");
			expect(serializeDocument(parseDocument(text)), file).toBe(text);
		}
	});

	it("round-trips a realistic nested if/elif/while macro (test/meta.test.ts's own fixture)", () => {
		const macro = [
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
		const doc = parseDocument(macro);
		expect(serializeDocument(doc)).toBe(macro);
		expect(doc.errors).toEqual([]);
		// Two top-level control constructs: the outer if (line 2) and the while loop (line 10). The
		// "else" at indent 2 (line 7) matches the NESTED if (line 4, same indent - a second statement
		// in the outer if's own body), not the outer if - so both become the outer if's children.
		expect(doc.blocks.map((b) => [b.keyword, b.line])).toEqual([["if", 2], ["while", 10]]);
		expect(doc.blocks[0].children.map((b) => [b.keyword, b.line])).toEqual([["if", 4], ["else", 7]]);
	});
});

describe("blocks", () => {
	it("builds an if/elif/else chain as siblings, each closing the previous", () => {
		const text = "if true\n    G1 X1\nelif false\n    G1 X2\nelse\n    G1 X3\nM400\n";
		const doc = parseDocument(text);
		expect(doc.blocks.map((b) => [b.keyword, b.line, b.endLine])).toEqual([
			["if", 0, 1], ["elif", 2, 3], ["else", 4, 5],
		]);
		expect(doc.errors).toEqual([]);
	});

	it("nests a while inside an if's body, and an if inside a while's body", () => {
		const text = "if a\n    while b\n        G1 X1\n";
		const doc = parseDocument(text);
		expect(doc.blocks).toHaveLength(1);
		// Still open at EOF - endLine is the document's actual last line index, which includes the
		// trailing empty line the final "\n" produces (splitLines' own documented convention).
		expect(doc.blocks[0]).toMatchObject({ keyword: "if", line: 0, endLine: 3 });
		expect(doc.blocks[0].children).toMatchObject([{ keyword: "while", line: 1, endLine: 3 }]);
	});

	it("does not let a comment's indentation end a block (RRF 3.6.0+)", () => {
		const text = "if a\n    G1 X1\n; a dedented comment\n    G1 X2\nG1 X3\n";
		const doc = parseDocument(text);
		expect(doc.blocks[0]).toMatchObject({ line: 0, endLine: 3 }); // includes line 3, not just line 1
		expect(doc.errors).toEqual([]);
	});

	it("treats a tab as rounding up to the next multiple of 4, matching RRF", () => {
		// One tab (indent 4) and four spaces (indent 4) are the SAME indent to RRF - both inside the if.
		const text = "if a\n\tG1 X1\n    G1 X2\nG1 X3\n";
		const doc = parseDocument(text);
		expect(doc.blocks[0]).toMatchObject({ line: 0, endLine: 2 });
	});

	it("flags each structural error, with a fixture that fails without the check", () => {
		expect(parseDocument("else\n    G1 X1\n").errors[0]).toMatchObject({ code: "else-without-if" });
		expect(parseDocument("elif true\n    G1 X1\n").errors[0]).toMatchObject({ code: "elif-without-if" });
		expect(
			parseDocument("if a\n    G1 X1\nelse\n    G1 X2\nelse\n    G1 X3\n").errors[0],
		).toMatchObject({ code: "else-after-else" });
		expect(parseDocument("break\n").errors[0]).toMatchObject({ code: "break-outside-loop" });
		expect(parseDocument("continue\n").errors[0]).toMatchObject({ code: "continue-outside-loop" });
		// A break/continue nested under an if that's itself under a while is fine (any ancestor loop).
		expect(parseDocument("while a\n    if b\n        break\n").errors).toEqual([]);
	});

	it("flags a T command sharing a line with another command", () => {
		expect(parseDocument("T1 G1 X10\n").errors[0]).toMatchObject({ code: "t-not-alone" });
		expect(parseDocument("T1\nG1 X10\n").errors).toEqual([]);
	});

	it("warns at most once per document, even across separate nested runs", () => {
		// RRF's `warnedAboutMixedSpacesAndTabs` is never reset (unlike `seenLeadingSpace`/
		// `seenLeadingTab`, which DO reset at indent 0) - so this fires once for the whole file, not
		// once per run, even though the second if/mixed run (lines 5-7) is a fully separate nesting.
		const text = "if a\n    G1 X1\n\tG1 X2\n\tG1 X3\nG1 X4\nif b\n\tG1 X5\n    G1 X6\n";
		const doc = parseDocument(text);
		const codes = doc.errors.filter((e) => e.code === "mixed-indentation");
		expect(codes.map((e) => e.line)).toEqual([2]);
	});
});

describe("machine mode and Fanuc/LaserWeb continuation", () => {
	it("switches mode on M451/M452/M453, affecting only SUBSEQUENT lines", () => {
		const doc = parseDocument("M453\nG1 X10\n(comment) G1 Y10\n");
		expect(doc.lines[0].machineMode).toBe("fff"); // M453 itself is read in the still-fff mode
		expect(doc.lines[1].machineMode).toBe("cnc");
		expect(doc.lines[2].bracketedComments).toHaveLength(1); // now CNC, so "(...)" is a comment
	});

	it("resolves an implicit command only in laser/cnc mode, from the last G0-G3", () => {
		const cnc = parseDocument("M453\nG1 X10\nX20 Y5\n");
		expect(cnc.lines[2].kind).toBe("fields");
		expect(cnc.lines[2].implicitCommand).toMatchObject({ code: "G1" });
		expect(cnc.lines[2].implicitCommand!.params.map((p) => `${p.letter}${p.value}`)).toEqual(["X20", "Y5"]);

		const fff = parseDocument("G1 X10\nX20 Y5\n"); // still fff - no continuation
		expect(fff.lines[1].implicitCommand).toBeNull();
	});

	it("does not resolve a continuation across a non-motion command", () => {
		const doc = parseDocument("M453\nG92 X0\nX20 Y5\n"); // last was G92, not G0-G3
		expect(doc.lines[2].implicitCommand).toBeNull();
	});
});

describe("edits", () => {
	it("replaces an existing plain-value parameter", () => {
		const doc = parseDocument("G1 X10 Y20\n");
		const edit = editSetParam(doc, 0, 0, "X", "99");
		expect(applyEdits(doc, [edit]).text).toBe("G1 X99 Y20\n");
	});

	it("appends a parameter that is not present", () => {
		const doc = parseDocument("G1 X10\n");
		const edit = editSetParam(doc, 0, 0, "F", "1200");
		expect(applyEdits(doc, [edit]).text).toBe("G1 X10 F1200\n");
	});

	it("throws UnsafeEditError instead of appending a duplicate expression parameter", () => {
		// The bug this replaces: M572 D0 S{global.pa} + setParam("S", "0.05") used to silently
		// append a duplicate S, producing "M572 D0 S{global.pa} S0.05".
		const doc = parseDocument("M572 D0 S{global.pa}\n");
		expect(() => editSetParam(doc, 0, 0, "S", "0.05")).toThrow(UnsafeEditError);
	});

	it("removes a parameter and its leading space", () => {
		const doc = parseDocument("G1 X10 Y20 E1\n");
		const edit = editRemoveParam(doc, 0, 0, "Y");
		expect(applyEdits(doc, [edit]).text).toBe("G1 X10 E1\n");
	});

	it("removes an escaped axis parameter WITH its leading ', leaving a line that still parses", () => {
		const doc = parseDocument("G1 'a10 X5\n");
		const after = applyEdits(doc, [editRemoveParam(doc, 0, 0, "a")]);
		expect(after.text).toBe("G1 X5\n"); // used to be "G1 ' X5\n"
		expect(after.lines[0].commands[0].params.map((p) => p.letter)).toEqual(["X"]);
	});

	it("replaces a whole line, preserving its EOL", () => {
		const doc = parseDocument("G1 X10\r\nG1 Y20\r\n");
		const edit = editReplaceLine(doc, 0, "G1 X99");
		expect(applyEdits(doc, [edit]).text).toBe("G1 X99\r\nG1 Y20\r\n");
	});

	it("inserts lines before an existing one, using the document's own EOL", () => {
		const doc = parseDocument("G1 X10\nG1 Y20\n");
		const edit = editInsertLines(doc, 1, ["M400"]);
		expect(applyEdits(doc, [edit]).text).toBe("G1 X10\nM400\nG1 Y20\n");
	});

	it("inserts lines at the end of a file with no trailing newline", () => {
		const doc = parseDocument("G1 X10");
		const edit = editInsertLines(doc, 1, ["M400"]);
		expect(applyEdits(doc, [edit]).text).toBe("G1 X10\nM400\n");
	});

	it("removes a line entirely, including its EOL", () => {
		const doc = parseDocument("G1 X10\nG1 Y20\nG1 Z5\n");
		const edit = editRemoveLine(doc, 1);
		expect(applyEdits(doc, [edit]).text).toBe("G1 X10\nG1 Z5\n");
	});

	it("rejects overlapping edits", () => {
		const doc = parseDocument("G1 X10 Y20\n");
		const a = editSetParam(doc, 0, 0, "X", "1");
		const b = editReplaceLine(doc, 0, "G1 X1 Y1");
		expect(() => applyEdits(doc, [a, b])).toThrow(/[Oo]verlap/);
	});

	it("applies several non-overlapping edits together", () => {
		const doc = parseDocument("G1 X10 Y20\nG1 Z5\n");
		const a = editSetParam(doc, 0, 0, "X", "1");
		const b = editSetParam(doc, 1, 0, "Z", "9");
		expect(applyEdits(doc, [a, b]).text).toBe("G1 X1 Y20\nG1 Z9\n");
	});
});

describe("expressionsOfLine (task 07)", () => {
	it("finds a {...} parameter's expression, with absolute document offsets", () => {
		const doc = parseDocument("G1 X10\nG1 X{move.axes[0].max}\n");
		const exprs = expressionsOfLine(doc, 1);
		expect(exprs).toHaveLength(1);
		expect(exprs[0].source).toEqual({ kind: "param", command: 0, letter: "X" });
		expect(doc.text.slice(exprs[0].expression.ast.start, exprs[0].expression.ast.end)).toBe("move.axes[0].max");
		expect(exprs[0].expression.objectModelPaths).toEqual([{ path: "move.axes[].max", start: 12, end: 28 }]);
	});

	it("finds the expression part of if/elif/while/echo/abort meta lines", () => {
		const doc = parseDocument('if var.retries < 3\necho "hi " ^ var.name\n');
		const ifExpr = expressionsOfLine(doc, 0);
		expect(ifExpr).toHaveLength(1);
		expect(doc.text.slice(ifExpr[0].expression.ast.start, ifExpr[0].expression.ast.end)).toBe("var.retries < 3");

		const echoExpr = expressionsOfLine(doc, 1);
		expect(doc.text.slice(echoExpr[0].expression.ast.start, echoExpr[0].expression.ast.end)).toBe('"hi " ^ var.name');
	});

	it("finds the RIGHT-hand side only for var/global/set, via parseAssignment's own precise span", () => {
		const doc = parseDocument("set var.retries = var.retries + 1\n");
		const exprs = expressionsOfLine(doc, 0);
		expect(doc.text.slice(exprs[0].expression.ast.start, exprs[0].expression.ast.end)).toBe("var.retries + 1");
	});

	it("has nothing for break/continue/skip, or a line with no expression at all", () => {
		expect(expressionsOfLine(parseDocument("break\n"), 0)).toEqual([]);
		expect(expressionsOfLine(parseDocument("G1 X10\n"), 0)).toEqual([]);
	});

	it("finds an expression inside a string-argument command (e.g. M117)", () => {
		const doc = parseDocument('M117 {"done"}\n');
		const exprs = expressionsOfLine(doc, 0);
		expect(exprs).toHaveLength(1);
		expect(exprs[0].source).toEqual({ kind: "stringArgument", command: 0 });
	});

	it("finds every expression on a line with several commands", () => {
		const doc = parseDocument("G90 G1 X{1} Y{2}\n");
		const exprs = expressionsOfLine(doc, 0);
		expect(exprs.map((e) => e.source)).toEqual([
			{ kind: "param", command: 1, letter: "X" },
			{ kind: "param", command: 1, letter: "Y" },
		]);
	});
});
