import { describe, expect, it } from "vitest";

import { lexLine, lexLines, STRING_ARGUMENT_COMMANDS, type LexedLine } from "../src/lex.js";

function params(line: LexedLine, ci = 0): Array<{ letter: string; value: string }> {
	return line.commands[ci].params.map((p) => ({ letter: p.letter, value: p.value }));
}

describe("lexLine — RRF's real splitting rules (verified against 3.7.0-rc.1 StringParser.cpp)", () => {
	it("splits several commands on one line at an unescaped G/M (FindParameters)", () => {
		const l = lexLine("G90 G1 X10");
		expect(l.kind).toBe("commands");
		expect(l.commands.map((c) => c.code)).toEqual(["G90", "G1"]);
		expect(params(l)).toEqual([]);
		expect(params(l, 1)).toEqual([{ letter: "X", value: "10" }]);
	});

	it("does not let T end a command — T is just a parameter letter", () => {
		const l = lexLine("M104 T1 S200");
		expect(l.commands).toHaveLength(1);
		expect(params(l)).toEqual([{ letter: "T", value: "1" }, { letter: "S", value: "200" }]);
	});

	it("splits parameters at every letter, not at whitespace", () => {
		expect(params(lexLine("G1X10Y20"))).toEqual([{ letter: "X", value: "10" }, { letter: "Y", value: "20" }]);
	});

	it("reads a checksummed line, ignoring the checksum as a parameter", () => {
		const l = lexLine("N10 M92 E420*55");
		expect(l.lineNumber).toMatchObject({ value: 10 });
		expect(l.commands[0].code).toBe("M92");
		expect(params(l)).toEqual([{ letter: "E", value: "420" }]);
		expect(l.checksum).toEqual({ value: 55, start: 12, end: 15 });
	});

	it("does not recognise a checksum without a preceding line number", () => {
		// RRF: `*` only starts a checksum when `hadLineNumber && braceCount == 0`.
		const l = lexLine("G1 X1*47");
		expect(l.checksum).toBeNull();
		expect(params(l)).toEqual([{ letter: "X", value: "1*47" }]);
	});

	it("reads a leading ' as a lowercase escaped axis parameter", () => {
		const l = lexLine("G1 'a10 X5");
		expect(params(l)).toEqual([{ letter: "a", value: "10" }, { letter: "X", value: "5" }]);
		expect(l.commands[0].params[0].escapedAxis).toBe(true);
		expect(l.commands[0].params[1].escapedAxis).toBe(false);
	});

	it("an escaped axis parameter's own span covers the ', as its documented contract says", () => {
		// The span is what every rewriting caller splices on (`params.ts`/`document.ts`'s
		// removeParam/editRemoveParam); if it started at the letter, removing the parameter would
		// leave the ' orphaned and produce a line RRF can't parse.
		const raw = "G1 'a10 X5";
		const p = lexLine(raw).commands[0].params[0];
		expect(raw.slice(p.start, p.end)).toBe("'a10");
		expect(p.valueStart).toBe(raw.indexOf("10")); // the VALUE still starts after the letter
	});

	it("an escaped axis's ' does not leak into the PRECEDING parameter's value", () => {
		// A parameter's value runs to the next parameter's token start, which for an escaped axis is
		// the ' - not the letter. Reading X as "5 '" here made paramNumber(X) unreadable.
		const l = lexLine("G1 X5 'a10 Y6");
		expect(params(l)).toEqual([
			{ letter: "X", value: "5" }, { letter: "a", value: "10" }, { letter: "Y", value: "6" },
		]);
	});

	it("does not let an escaped G/M end the command, unlike a plain one", () => {
		// 'g' escaped is just an axis-letter parameter; a bare G would have ended M584's command.
		const l = lexLine("M584 'g5");
		expect(l.commands).toHaveLength(1);
		expect(params(l)).toEqual([{ letter: "g", value: "5" }]);
	});

	it("treats a quoted string's contents (semicolons included) as opaque", () => {
		const l = lexLine("M291 P\"done; resuming\" S0");
		expect(l.comment).toBeNull();
		expect(params(l)).toEqual([{ letter: "P", value: "\"done; resuming\"" }, { letter: "S", value: "0" }]);
	});

	it("reads a bracketed comment as such only in CNC mode", () => {
		const cnc = lexLine("(note) G1 X1", { machineMode: "cnc" });
		// Verified against RRF source, not assumed: `LineFinished` always resets `commandStart` to 0,
		// so DecodeCommand reads from the START OF THE STORED BUFFER regardless of where in Put()'s
		// state machine that content was produced. A bracketed comment spliced out from the very
		// start of the line leaves the SPACE after it as buffer[0] - not a G/M/T letter - so RRF
		// itself fails to recognise a command here. See docs/tasks/05-lexer.md's Findings.
		expect(cnc.bracketedComments).toEqual([{ text: "(note)", start: 0, end: 6 }]);
		expect(cnc.kind).toBe("unrecognised");
		expect(cnc.commands).toEqual([]);

		// An inline bracketed comment (real content already before it) is unaffected.
		const inline = lexLine("G1 (note) X10", { machineMode: "cnc" });
		expect(inline.commands[0].code).toBe("G1");
		expect(params(inline)).toEqual([{ letter: "X", value: "10" }]);
		expect(inline.bracketedComments).toEqual([{ text: "(note)", start: 3, end: 9 }]);
	});

	it("treats '(' as plain text outside CNC mode", () => {
		const fff = lexLine("(note) G1 X1", { machineMode: "fff" });
		expect(fff.bracketedComments).toEqual([]);
		// '(' isn't G/M/T and isn't a letter at all, so this is the same "unrecognised leading
		// content" shape as any other non-letter first character - not a command line in FFF mode.
		expect(fff.kind).toBe("unrecognised");

		const laser = lexLine("(note) G1 X1", { machineMode: "laser" });
		expect(laser.bracketedComments).toEqual([]);
		expect(laser.kind).toBe("unrecognised");
	});

	for (const code of STRING_ARGUMENT_COMMANDS) {
		it(`${code} takes the rest of the line as one unquoted string, not letter parameters`, () => {
			const l = lexLine(`${code} Hello World`);
			expect(l.commands[0].params).toEqual([]);
			expect(l.commands[0].stringArgument?.value).toBe("Hello World");
		});
	}

	it("M117's message reads straight through embedded G/M-shaped text", () => {
		// GetUnprecedentedString resets commandEnd to the true end of line for exactly this reason.
		const l = lexLine("M117 Hello Mike");
		expect(l.commands).toHaveLength(1);
		expect(l.commands[0].stringArgument?.value).toBe("Hello Mike");
	});

	it("M117's message stops at a real trailing comment, same as any other command", () => {
		const l = lexLine("M117 Hello ; not part of the message");
		expect(l.commands[0].stringArgument?.value).toBe("Hello");
		expect(l.comment?.text).toBe(" not part of the message");
	});

	it("M550/M551/M37 are NOT string-argument commands — they take an ordinary P parameter", () => {
		// Verified by reading GCodes2.cpp: all three call TryGetPossiblyQuotedString('P', ...) /
		// GetPossiblyQuotedString behind an explicit P, not GetUnprecedentedString.
		expect(STRING_ARGUMENT_COMMANDS.has("M550")).toBe(false);
		expect(STRING_ARGUMENT_COMMANDS.has("M551")).toBe(false);
		expect(STRING_ARGUMENT_COMMANDS.has("M37")).toBe(false);
		expect(params(lexLine("M550 P\"My Printer\""))).toEqual([{ letter: "P", value: "\"My Printer\"" }]);
	});

	it("allows an empty string-argument value (M117 with nothing after it)", () => {
		const l = lexLine("M117");
		expect(l.commands[0].stringArgument).toEqual({ value: "", start: 4, end: 4 });
	});

	it("excludes E right after a digit (an exponent), but not E at the start of the parameters", () => {
		expect(params(lexLine("G1 X1e3"))).toEqual([{ letter: "X", value: "1e3" }]);
		expect(params(lexLine("G1 E1"))).toEqual([{ letter: "E", value: "1" }]);
		expect(params(lexLine("G1 X10 E-2"))).toEqual([
			{ letter: "X", value: "10" }, { letter: "E", value: "-2" },
		]);
	});

	it("treats T{expr} as bare T plus a T-parameter carrying the expression (RRF's own special case)", () => {
		const l = lexLine("T{state.currentTool + 1}");
		expect(l.commands[0]).toMatchObject({ code: "T", number: null });
		expect(params(l)).toEqual([{ letter: "T", value: "{state.currentTool + 1}" }]);
	});

	it("classifies parameter value kinds", () => {
		const l = lexLine("M568 P0 S185:200:150 D\"x\" A{1+1} B");
		const kinds = Object.fromEntries(l.commands[0].params.map((p) => [p.letter, p.kind]));
		expect(kinds).toEqual({ P: "number", S: "list", D: "string", A: "expression", B: "empty" });
	});

	it("finds a comment, unquoted-brace-unaware (a ; inside an open { still ends the line)", () => {
		// Verified against Put(): the ';' case in state parsingGCode does not check braceCount at all.
		const l = lexLine("G1 X{a;b}");
		expect(l.comment).toEqual({ text: "b}", start: 6, end: 9 });
	});

	it("recognises a meta-command and reports no G/M/T commands for it", () => {
		const l = lexLine("if true");
		expect(l.kind).toBe("meta");
		expect(l.meta).toBe("if");
		expect(l.commands).toEqual([]);
	});

	it("marks a bare comment-only or blank line, indented or not", () => {
		expect(lexLine(";LAYER:5").kind).toBe("comment");
		expect(lexLine("  ; indented comment").kind).toBe("comment");
		expect(lexLine("").kind).toBe("blank");
		expect(lexLine("   ").kind).toBe("blank");
	});

	it("marks bare fields (no G/M/T) as \"fields\", a Fanuc-continuation candidate for later tasks", () => {
		const l = lexLine("X10 Y20");
		expect(l.kind).toBe("fields");
		expect(l.commands).toEqual([]);
	});

	it("marks a leading-apostrophe continuation line as \"fields\" too", () => {
		expect(lexLine("'a10 X5").kind).toBe("fields");
	});

	it("marks genuinely unrecognisable content", () => {
		expect(lexLine("*47").kind).toBe("unrecognised"); // no line number, so not a real checksum either
		expect(lexLine("}}}").kind).toBe("unrecognised");
	});

	it("flags an unterminated quoted string and an unbalanced brace as this package's own diagnostics", () => {
		const q = lexLine("M291 P\"oops");
		expect(q.errors.map((e) => e.code)).toContain("unterminated-string");
		const b = lexLine("G1 X{1+1");
		expect(b.errors.map((e) => e.code)).toContain("unbalanced-brace");
	});

	it("flags an unterminated bracketed comment in CNC mode", () => {
		const l = lexLine("(never closed", { machineMode: "cnc" });
		expect(l.errors.map((e) => e.code)).toContain("unterminated-bracketed-comment");
	});

	it("reads a bare command letter with no digits as a command with no number", () => {
		const t = lexLine("T");
		expect(t.commands[0]).toMatchObject({ code: "T", letter: "T", number: null });
	});

	it("accepts a leading '-' after any of G, M or T, not just T", () => {
		expect(lexLine("T-1").commands[0]).toMatchObject({ code: "T-1", number: -1 });
		expect(lexLine("G-1").commands[0]).toMatchObject({ code: "G-1", number: -1 });
		expect(lexLine("M-1").commands[0]).toMatchObject({ code: "M-1", number: -1 });
	});

	it("reads only a single fractional digit, matching RRF's commandFraction", () => {
		const g = lexLine("G38.25");
		expect(g.commands[0]).toMatchObject({ code: "G38.2", number: 38.2 });
	});

	it("reads a command letter case-insensitively, matching RRF's own toupper(cl)", () => {
		expect(lexLine("g1 x10").commands[0].code).toBe("G1");
	});

	it("gives spans that address the original raw line, never overlapping", () => {
		const raw = "N7 G1 X10 Y20 E1.5 F1200 ; move";
		const l = lexLine(raw);
		const p = l.commands[0].params;
		expect(raw.slice(p[0].start, p[0].end)).toBe("X10");
		expect(raw.slice(p[3].start, p[3].end)).toBe("F1200");
		expect(raw.slice(l.comment!.start, l.comment!.end)).toBe("; move");
	});
});

describe("lexLines — chunked streaming (task 16)", () => {
	const TEXT = "G1 X10\nG1 Y20\nM104 S200\n; a comment\nG28\n";

	function codes(chunks: ReadonlyArray<string>): Array<string> {
		return [...lexLines(chunks)].map((l) => l.raw);
	}

	it("one line per chunk gives the same result as one chunk for the whole text", () => {
		const whole = codes([TEXT]);
		const perLine = codes(TEXT.split(/(?<=\n)/)); // keep each "\n" on the line it ends
		expect(perLine).toEqual(whole);
	});

	it("splitting mid-line carries the partial line across the chunk boundary correctly", () => {
		// Break right in the middle of "M104 S200".
		const chunks = ["G1 X10\nG1 Y20\nM10", "4 S200\n; a comment\nG28\n"];
		expect(codes(chunks)).toEqual(["G1 X10", "G1 Y20", "M104 S200", "; a comment", "G28"]);
	});

	it("splitting one character at a time still reconstructs every line exactly", () => {
		expect(codes([...TEXT])).toEqual(["G1 X10", "G1 Y20", "M104 S200", "; a comment", "G28"]);
	});

	it("a CRLF terminator split exactly between the \\r and the \\n is still stripped correctly", () => {
		const chunks = ["G1 X10\r", "\nG1 Y20\r\n"];
		expect(codes(chunks)).toEqual(["G1 X10", "G1 Y20"]);
	});

	it("a final line with no trailing newline at all is still yielded", () => {
		expect(codes(["G1 X10\nG1 Y20"])).toEqual(["G1 X10", "G1 Y20"]);
	});

	it("an empty input yields nothing", () => {
		expect(codes([])).toEqual([]);
		expect(codes([""])).toEqual([]);
	});

	it("actually lexes each line, not just splits it - same LexedLine shape as lexLine itself", () => {
		const [line] = [...lexLines(["G1 X10 Y20\n"])];
		expect(line).toEqual(lexLine("G1 X10 Y20"));
	});

	it("passes machineMode through to every line, unchanged (no M451/M452/M453 tracking - that's the document model's job)", () => {
		const [line] = [...lexLines(["G0 X1 (a CNC comment)\n"], { machineMode: "cnc" })];
		expect(line.bracketedComments).toHaveLength(1);
	});
});
