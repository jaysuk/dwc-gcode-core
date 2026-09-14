import { describe, expect, it } from "vitest";

import { MENU_COMMANDS, parseMenu } from "../src/files/menu.js";

describe("parseMenu — real wiki example files (Display_12864_menu.md, pinned @3e567e7)", () => {
	it("parses \"main\" with zero errors", () => {
		const main = [
			'text R0 C0 F1 T"My Super 3D Printer "',
			'image L"reprapimg.bin"',
			'text R15 C0 F0 T"Bed temp "',
			"alter N180 W30",
			'text T" actual "',
			"value N80 W30",
			'button R27 C0 T"Preheat PLA" A"M98 P#0" L"/macros/Preheat PLA"',
			'button R39 C0 T"Preheat ABS" A"M98 P#0" L"/macros/Preheat ABS"',
			'button R51 C0 T"Select file to print" A"menu" L"listFiles"',
		].join("\n");
		const doc = parseMenu(main);
		expect(doc.errors).toEqual([]);
		expect(doc.lines.every((l) => l.kind === "command" || l.kind === "blank")).toBe(true);
	});

	it("parses \"listFiles\" with zero errors, including a multi-action A parameter", () => {
		const listFiles = [
			'text R0 C0 F0 T"Select file to print  "',
			'button T"Back" A"return"',
			'files R15 N4 I"/gcodes" A"M32 #0|return"',
		].join("\n");
		const doc = parseMenu(listFiles);
		expect(doc.errors).toEqual([]);
		const filesLine = doc.lines[2];
		expect(filesLine.actions.map((a) => a.kind)).toEqual(["gcode", "return"]);
		expect(filesLine.actions[0]).toMatchObject({ kind: "gcode", text: "M32 #0" });
		if (filesLine.actions[0].kind === "gcode") {
			expect(filesLine.actions[0].command.commands[0]).toMatchObject({ code: "M32", stringArgument: { value: "#0" } });
		}
	});

	it("parses the doubled-quote escaped M98 form from the wiki's own follow-up example", () => {
		// button R27 C0 T"Preheat PLA" A"M98 P""/macros/Preheat PLA"""
		const line = 'button T"x" A"M98 P""/macros/Preheat PLA"""';
		const doc = parseMenu(line);
		expect(doc.errors).toEqual([]);
		expect(doc.lines[0].actions[0]).toMatchObject({ kind: "gcode", text: 'M98 P"/macros/Preheat PLA"' });
	});
});

describe("parseMenu — every branch of Menu::ParseMenuLine's own dispatch", () => {
	it("recognises a blank line and a comment line, with no error", () => {
		const doc = parseMenu("\n; a comment\ntext R0");
		expect(doc.lines.map((l) => l.kind)).toEqual(["blank", "comment", "command"]);
		expect(doc.errors).toEqual([]);
	});

	it("reads R/C/F/D/W/H as plain unsigned integers", () => {
		const doc = parseMenu("text R0 C1 F2 D3 W4 H5");
		expect(doc.lines[0].params.map((p) => [p.letter, p.value])).toEqual([
			["R", "0"], ["C", "1"], ["F", "2"], ["D", "3"], ["W", "4"], ["H", "5"],
		]);
	});

	it("reads V as a plain number OR (RRF 3.5+) a {...} expression, on any command", () => {
		expect(parseMenu("button V0").lines[0].params[0]).toMatchObject({ kind: "number", value: "0" });
		expect(parseMenu("button V{heat.heaters[0].current>60}").lines[0].params[0])
			.toMatchObject({ kind: "expression", value: "heat.heaters[0].current>60" });
	});

	it("reads N as a {...} expression ONLY for the \"value\" command, else a plain number", () => {
		expect(parseMenu("value N{heat.heaters[0].current}").lines[0].params[0])
			.toMatchObject({ letter: "N", kind: "expression" });
		// "alter" is not "value" - N{...} here is NOT the expression form, matching RRF's own
		// StringEqualsIgnoreCase(commandWord, "value") check exactly (confirmed by tracing what
		// StrToU32 does when handed a non-digit: both real RRF and this parser fall through to
		// "Bad arg letter" on the unconsumed '{').
		const altered = parseMenu("alter N{heat.heaters[0].current}");
		expect(altered.errors.map((e) => e.message)).toContain("Bad arg letter");
	});

	it("reads T/L/A/I as double-quoted strings, with '\"\"' as one literal '\"'", () => {
		const doc = parseMenu('text T"say ""hi"""');
		expect(doc.lines[0].params[0]).toMatchObject({ letter: "T", kind: "string", value: 'say "hi"' });
	});

	it("treats a bare quote with no letter as T (RRF 2.02+)", () => {
		const doc = parseMenu('text "hello"');
		expect(doc.lines[0].params[0]).toMatchObject({ letter: "T", kind: "string", value: "hello" });
	});

	it("flags 'Bad command' when the command word isn't cleanly terminated", () => {
		const doc = parseMenu("text5 R0");
		expect(doc.errors).toEqual([{ message: "Bad command", line: 1, column: 5 }]);
	});

	it("flags 'Bad arg letter' for an unrecognised parameter letter, stopping the line there", () => {
		const doc = parseMenu("text Z5 R0");
		expect(doc.errors[0]).toMatchObject({ message: "Bad arg letter" });
		// R0 after the bad letter is never reached - matches RRF returning immediately on error.
		expect(doc.lines[0].params).toEqual([]);
	});

	it("flags 'Missing string arg' when T/L/A/I isn't followed by a quote", () => {
		const doc = parseMenu("text T");
		expect(doc.errors).toEqual([{ message: "Missing string arg", line: 1, column: 7 }]);
	});

	it("flags 'Unknown command' for anything outside the six recognised keywords", () => {
		const doc = parseMenu("bogus R0");
		expect(doc.errors).toEqual([{ message: "Unknown command", line: 1, column: 1 }]);
	});

	it("recognises all six commands, case-insensitively", () => {
		for (const cmd of MENU_COMMANDS) {
			expect(parseMenu(cmd.toUpperCase()).errors, cmd).toEqual([]);
		}
	});

	it("does not require any particular parameter to be present (RRF itself doesn't either)", () => {
		expect(parseMenu("text").errors).toEqual([]);
		expect(parseMenu("image").errors).toEqual([]);
		expect(parseMenu("files").errors).toEqual([]);
	});

	it("is tolerant across lines: one line's error doesn't stop the rest of the file being parsed", () => {
		// Unlike real RRF (Menu::Reload stops loading the WHOLE file at the first error) - a
		// deliberate divergence documented in this module's own doc comment.
		const doc = parseMenu("bogus R0\ntext R0\n");
		expect(doc.errors).toHaveLength(1);
		expect(doc.lines[1]).toMatchObject({ kind: "command", command: "text" });
	});
});
