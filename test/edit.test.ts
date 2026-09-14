import { describe, expect, it } from "vitest";

import {
	appendDirective, detectEol, diffLines, findDirectives, findIncludes, parseLines,
	planDirectiveEdit, planDirectiveEditAcrossFiles, removeDirective, replaceDirective, replaceLine,
	resolveIncludePath, serializeLines, setIndexedParam, setParam, UnsafeEditError,
} from "../src/edit.js";

// Characterisation tests, merged from the two source copies before anything here was changed:
// resonance-lab's src/config/gcodeEdit.ts (test/gcodeEdit.test.ts) and duet-calibration-wizard's
// src/model/gcodeEdit.ts (the "config.g line editor"/"config.g M98 includes" describes in
// src/__tests__/retraction-speed-config.test.ts). Identical cases kept once; each file's own-only
// cases (calibration's five extra exports, resonance-lab's removeDirective) kept as-is.

describe("parseLines", () => {
	it("extracts the directive word and params, tolerating quoted strings and trailing comments", () => {
		const [line] = parseLines('M955 P121.0 C"^spi.cs1" Q2000000 I20 ; toolboard accelerometer');
		expect(line.code).toBe("M955");
		expect(line.params).toEqual({ P: "121.0", C: "\"^spi.cs1\"", Q: "2000000", I: "20" });
		expect(line.disabled).toBe(false);
		expect(line.unsafe).toBe(false);
	});

	it("flags a fully commented-out line as disabled but still finds its directive", () => {
		const [line] = parseLines('; M593 P"mzv" F64 S0.05 ; old tune');
		expect(line.code).toBe("M593");
		expect(line.disabled).toBe(true);
	});

	it("skips a leading line number when finding the directive word (task 06's bug fix)", () => {
		// Used to read "N10" itself as the code, since the old hand-rolled parser didn't know to
		// skip a line number - lexLine (RRF-faithful) does.
		const [line] = parseLines("N10 M92 E420");
		expect(line.code).toBe("M92");
		expect(line.params.E).toBe("420");
	});

	it("blank and plain-comment lines have no code", () => {
		const [blank, comment] = parseLines("\n; just a note");
		expect(blank.code).toBeNull();
		expect(comment.code).toBeNull();
		expect(comment.disabled).toBe(true);
	});

	it("flags {expression} lines and flow control as unsafe", () => {
		const lines = parseLines([
			"M572 D0:1 S{global.setPAValue}",
			"if sensors.gpIn[0].value = 1",
			'echo "hello"',
			"M593 P\"mzv\" F62.5 S0.10",
		].join("\n"));
		expect(lines[0].unsafe).toBe(true);
		expect(lines[1].unsafe).toBe(true);
		expect(lines[2].unsafe).toBe(true);
		expect(lines[3].unsafe).toBe(false);
	});

	it("flags every one of RRF's twelve meta keywords as unsafe, not just the six the old regex knew", () => {
		// classifyLine (this package's own meta.ts) replaced a six-keyword, case-insensitive regex -
		// var/global/set/break/continue/skip were never flagged before it existed.
		for (const line of ["var x = 1", "global x = 1", "set global.x = 1", "break", "continue", "skip"]) {
			expect(parseLines(line)[0].unsafe, line).toBe(true);
		}
	});

	it("a letter inside a quoted value is not mistaken for a parameter", () => {
		// The pin name contains "s1" - must not be parsed as an S parameter.
		const [line] = parseLines('M955 P121.0 C"^spi.cs1"');
		expect(line.params.S).toBeUndefined();
		expect(line.params.C).toBe("\"^spi.cs1\"");
	});

	it("round-trips CRLF files exactly, including the trailing newline", () => {
		const text = 'M955 P0 I20\r\nM593 P"mzv" F62.5 S0.10\r\n';
		expect(detectEol(text)).toBe("\r\n");
		expect(serializeLines(parseLines(text), detectEol(text))).toBe(text);
	});

	it("round-trips LF files exactly", () => {
		const text = 'M955 P0 I20\nM593 P"mzv" F62.5 S0.10';
		expect(detectEol(text)).toBe("\n");
		expect(serializeLines(parseLines(text), detectEol(text))).toBe(text);
	});
});

describe("findDirectives", () => {
	it("finds an active directive by code alone", () => {
		const lines = parseLines('G90\nM593 P"mzv" F62.5 S0.10\nM84 S60');
		const found = findDirectives(lines, "M593");
		expect(found).toHaveLength(1);
		expect(found[0].index).toBe(1);
	});

	it("matches M955 by P id numerically, tolerant of an omitted .0 index", () => {
		const lines = parseLines("M955 P121 I0\nM955 P122.0 I0");
		expect(findDirectives(lines, "M955", { P: "121.0" })).toHaveLength(1);
		expect(findDirectives(lines, "M955", { P: "121" })[0].index).toBe(0);
		expect(findDirectives(lines, "M955", { P: "999" })).toHaveLength(0);
	});

	it("returns disabled matches too, so a caller can flag a shadowed directive", () => {
		const lines = parseLines('; M593 P"mzv" F60 S0.05 ; old\nM593 P"mzv" F62.5 S0.10');
		const found = findDirectives(lines, "M593");
		expect(found).toHaveLength(2);
		expect(found[0].line.disabled).toBe(true);
		expect(found[1].line.disabled).toBe(false);
	});

	it("finds nothing when the directive genuinely isn't present", () => {
		expect(findDirectives(parseLines("G90\nM84 S60"), "M955")).toHaveLength(0);
	});
});

describe("setParam", () => {
	it("replaces one parameter's value and leaves every other token, spacing and comment untouched", () => {
		const raw = 'M955 P121.0 C"^spi.cs1" Q2000000 I0 ; toolboard accelerometer';
		const edited = setParam(raw, "I", "20");
		expect(edited).toBe('M955 P121.0 C"^spi.cs1" Q2000000 I20 ; toolboard accelerometer');
	});

	it("appends the parameter when it wasn't present at all", () => {
		expect(setParam("M955 P0", "I", "20")).toBe("M955 P0 I20");
	});

	it("appends before a trailing comment rather than after it", () => {
		expect(setParam("M955 P0 ; mainboard", "I", "20")).toBe("M955 P0 I20 ; mainboard");
	});

	it("does not corrupt a quoted string parameter that happens to contain digits", () => {
		// The bare-numeric regex must not match "1" inside C"^spi.cs1" - only a real I token.
		expect(setParam('M955 P121.0 C"^spi.cs1" I5', "I", "20"))
			.toBe('M955 P121.0 C"^spi.cs1" I20');
	});

	it("is case-insensitive on the letter but always writes it upper-case", () => {
		expect(setParam("m955 p0 i0", "I", "20")).toBe("m955 p0 I20");
	});

	it("replaces the WHOLE colon-list token, not just its first number (the settled behaviour)", () => {
		// resonance-lab's own setParam used a plain-number regex here and would have replaced only
		// the "600" in "E600:600", leaving a stray ":600" dangling - this is the one real behaviour
		// difference between the two source copies, settled by adopting calibration-wizard's
		// colon-list-aware regex for both.
		expect(setParam("M906 E600:600", "E", "800")).toBe("M906 E800");
		expect(setParam("M92 E420:500", "E", "397.2")).toBe("M92 E397.2");
	});

	it("throws UnsafeEditError instead of appending a duplicate expression parameter (task 06's bug fix)", () => {
		// Used to silently append a duplicate S, producing "M572 D0 S{global.pa} S0.05" - the old
		// regex only matched numeric/colon-list values, so it never found the existing S at all.
		expect(() => setParam("M572 D0 S{global.pa}", "S", "0.05")).toThrow(UnsafeEditError);
		// Untouched by the throw - the rest of the line is not a valid re-parse target afterwards.
		expect(() => setParam("M572 D0 S{global.pa}", "S", "0.05")).toThrow(/expression/);
	});

	it("finds and replaces an existing STRING-valued parameter, not just numeric ones", () => {
		// The old regex-based setParam could ONLY match a numeric/colon-list value, so calling it on
		// an existing quoted-string parameter would silently append a duplicate instead of finding
		// it - a latent bug (never hit because no caller did this), fixed as a side effect of
		// replacing the regex with lexLine's real parameter scan.
		expect(setParam('M563 P0 C"^spi.cs1"', "C", "\"^spi.cs2\"")).toBe('M563 P0 C"^spi.cs2"');
	});

	it("still replaces other parameters cleanly on a line that also has an expression one", () => {
		expect(setParam("M572 D0 S{global.pa}", "D", "1")).toBe("M572 D1 S{global.pa}");
	});
});

describe("setIndexedParam", () => {
	it("sets one drive's slot in a colon-list parameter, expanding a shared single value first", () => {
		expect(setIndexedParam("M92 E420", "E", 1, "500", 3)).toBe("M92 E420:500:420");
		expect(setIndexedParam("M92 E420:500:450", "E", 1, "397.2", 3)).toBe("M92 E420:397.2:450");
	});
});

describe("replaceDirective", () => {
	it("replaces the whole directive, keeping indentation and trailing comment", () => {
		const raw = '  M593 P"mzv" F75 0.05 ; update 4.23.25 after testing higher belt tension';
		const edited = replaceDirective(raw, 'M593 P"zvd" F45.2 S0.10');
		expect(edited).toBe('  M593 P"zvd" F45.2 S0.10 ; update 4.23.25 after testing higher belt tension');
	});

	it("works on a line with no comment at all", () => {
		expect(replaceDirective('M593 P"mzv" F60', 'M593 P"zvd" F45.2 S0.10')).toBe('M593 P"zvd" F45.2 S0.10');
	});
});

describe("appendDirective", () => {
	it("appends an audit comment then the directive as new lines", () => {
		const lines = parseLines("G90\nM84 S60");
		const result = appendDirective(lines, 'M593 P"mzv" F62.5 S0.10', "2026-09-14");
		expect(result).toHaveLength(4);
		expect(result[2].raw).toBe("; 2026-09-14");
		expect(result[3].raw).toBe('M593 P"mzv" F62.5 S0.10');
		expect(result[3].code).toBe("M593");
		expect(result[0].raw).toBe("G90");
		expect(result[1].raw).toBe("M84 S60");
	});
});

describe("replaceLine", () => {
	it("re-derives code/params from the new text and leaves other lines' identity untouched", () => {
		const lines = parseLines("G90\nM955 P0 I0\nM84 S60");
		const edited = replaceLine(lines, 1, setParam(lines[1].raw, "I", "20"));
		expect(edited[1].raw).toBe("M955 P0 I20");
		expect(edited[1].params.I).toBe("20");
		expect(edited[0]).toBe(lines[0]); // untouched lines keep their identity, not just equal content
		expect(edited[2]).toBe(lines[2]);
	});
});

describe("removeDirective", () => {
	it("deletes exactly the named line, leaving every other line's identity untouched", () => {
		const lines = parseLines('G90\nM955 P0 C"121.i2c.lis" I6\nM84 S60');
		const after = removeDirective(lines, 1);
		expect(after.map((l) => l.raw)).toEqual(["G90", "M84 S60"]);
		expect(after[0]).toBe(lines[0]);
		expect(after[1]).toBe(lines[2]);
	});

	it("leaves an audit comment ABOVE the removed line in place - only the directive itself is deleted", () => {
		const lines = parseLines('; 2026-09-09\nM955 P0 C"121.i2c.lis" I6');
		const after = removeDirective(lines, 1);
		expect(after.map((l) => l.raw)).toEqual(["; 2026-09-09"]);
	});

	it("removing the only line leaves an empty result", () => {
		expect(removeDirective(parseLines('M955 P0 C"121.i2c.lis" I6'), 0)).toEqual([]);
	});
});

describe("diffLines", () => {
	it("marks only the changed line as removed+added, everything else as same", () => {
		const before = parseLines("G90\nM955 P0 I0\nM84 S60");
		const after = replaceLine(before, 1, "M955 P0 I20");
		const diff = diffLines(before, after);
		expect(diff).toEqual([
			{ type: "same", text: "G90" },
			{ type: "removed", text: "M955 P0 I0" },
			{ type: "added", text: "M955 P0 I20" },
			{ type: "same", text: "M84 S60" },
		]);
	});

	it("marks appended lines as added with nothing removed", () => {
		const before = parseLines("G90\nM84 S60");
		const after = appendDirective(before, "M955 P0 I20", "2026-09-14");
		const diff = diffLines(before, after);
		expect(diff).toEqual([
			{ type: "same", text: "G90" },
			{ type: "same", text: "M84 S60" },
			{ type: "added", text: "; 2026-09-14" },
			{ type: "added", text: "M955 P0 I20" },
		]);
	});

	it("is empty of changes for two identical files", () => {
		const lines = parseLines("G90\nM84 S60");
		expect(diffLines(lines, lines).every((d) => d.type === "same")).toBe(true);
	});
});

describe("a realistic config.g excerpt", () => {
	const CONFIG = [
		"; General preferences",
		"M575 P1 S1 B57600",
		"G90",
		"M83",
		"M572 D0:1 S{global.setPAValue}",
		';M593 P"mzv" F64 0.05 ; 74 was good for BB hoist in 3.5.1',
		'M593 P"mzv" F75 0.05 ; update 4.23.25 after testing higher belt tension',
	].join("\n");

	it("finds the live M593 and flags the disabled one and the {expression} line separately", () => {
		const lines = parseLines(CONFIG);
		const found = findDirectives(lines, "M593");
		expect(found).toHaveLength(2);
		expect(found.filter((f) => !f.line.disabled)).toHaveLength(1);
		expect(lines.find((l) => l.raw.includes("setPAValue"))?.unsafe).toBe(true);
	});

	it("fixes a real formatting bug in the live config: F75 0.05 has no S before the damping value", () => {
		// M593's damping parameter is S; a bare "0.05" after F75 is not parsed as damping at all -
		// replaceDirective must emit a well-formed line when the plugin (re)writes it.
		const lines = parseLines(CONFIG);
		const live = findDirectives(lines, "M593").find((f) => !f.line.disabled)!;
		expect(live.line.params.S).toBeUndefined(); // confirms the bug is real in the fixture
		const rewritten = replaceDirective(live.line.raw, 'M593 P"zvd" F45.2 S0.10');
		expect(rewritten).toBe('M593 P"zvd" F45.2 S0.10 ; update 4.23.25 after testing higher belt tension');
	});
});

// ── planDirectiveEdit / planDirectiveEditAcrossFiles (calibration-wizard's own exports) ──────────

describe("planDirectiveEdit", () => {
	const config = [
		"; config.g",
		"M92 X80 Y80 Z400 E420",
		"M566 X600 Y600 Z12 E3000",
		"M572 D0 S0.03",
	].join("\n");

	it("replaces one M572 by D, keeping the rest of the file byte-identical", () => {
		const plan = planDirectiveEdit(config, "M572", { D: "0" }, () => "M572 D0 S0.045", "M572 D0 S0.045", "note");
		expect(plan.appended).toBe(false);
		expect(plan.after).toContain("M572 D0 S0.045");
		expect(plan.after).toContain("M92 X80 Y80 Z400 E420");
		expect(plan.after.split("\n")).toHaveLength(config.split("\n").length);
	});

	it("edits only the E token on the shared M92 line", () => {
		const plan = planDirectiveEdit(config, "M92", {}, (raw) => setParam(raw, "E", "397.2"), "M92 E397.2", "note");
		expect(plan.after).toContain("M92 X80 Y80 Z400 E397.2");
	});

	it("appends when the directive is absent", () => {
		const plan = planDirectiveEdit("M92 E420\n", "M207", {}, () => "M207 S0.5 F2100", "M207 S0.5 F2100", "note");
		expect(plan.appended).toBe(true);
		expect(plan.after).toContain("; note");
		expect(plan.after).toContain("M207 S0.5 F2100");
	});

	it("refuses a line with expression syntax", () => {
		const plan = planDirectiveEdit("M572 D0 S{global.pa}\n", "M572", { D: "0" }, () => "x", "x", "n");
		expect(plan.blocked).toBeTruthy();
		expect(plan.after).toBe(plan.before);
	});

	it("flags a commented-out duplicate", () => {
		const plan = planDirectiveEdit("; M572 D0 S0.02\nM572 D0 S0.03\n", "M572", { D: "0" }, () => "M572 D0 S0.05", "M572 D0 S0.05", "n");
		expect(plan.disabledDuplicateFound).toBe(true);
		expect(plan.after).toContain("; M572 D0 S0.02");
		expect(plan.after).toContain("M572 D0 S0.05");
	});
});

describe("config.g M98 includes", () => {
	it("finds uncommented M98 P\"...\" .g targets, ignoring disabled and non-.g ones", () => {
		const text = [
			"M98 P\"config-tools.g\"",
			"; M98 P\"disabled.g\"",
			"M98 P\"0:/macros/not-included.gcode\"",
		].join("\n");
		expect(findIncludes(text)).toEqual(["config-tools.g"]);
	});

	it("resolves a bare filename relative to the system directory, and passes through an explicit volume", () => {
		expect(resolveIncludePath("config-tools.g", "0:/sys")).toBe("0:/sys/config-tools.g");
		expect(resolveIncludePath("0:/macros/foo.g", "0:/sys")).toBe("0:/macros/foo.g");
	});

	it("edits the file that actually contains the ACTIVE directive, not always config.g", () => {
		const configG = "M98 P\"config-tools.g\"\nM92 X80 Y80\n";
		const toolsG = "M572 D0 S0.03\n";
		const plan = planDirectiveEditAcrossFiles(
			[{ path: "0:/sys/config.g", text: configG }, { path: "0:/sys/config-tools.g", text: toolsG }],
			"M572", { D: "0" }, () => "M572 D0 S0.045", "M572 D0 S0.045", "note",
		);
		expect(plan.path).toBe("0:/sys/config-tools.g");
		expect(plan.after).toContain("M572 D0 S0.045");
		expect(plan.searchedPaths).toEqual(["0:/sys/config.g", "0:/sys/config-tools.g"]);
	});

	it("appends to config.g (the first file) when the directive exists nowhere", () => {
		const plan = planDirectiveEditAcrossFiles(
			[{ path: "0:/sys/config.g", text: "M92 X80\n" }, { path: "0:/sys/config-tools.g", text: "M92 Y80\n" }],
			"M207", {}, () => "x", "M207 S0.5 F2100", "note",
		);
		expect(plan.appended).toBe(true);
		expect(plan.path).toBe("0:/sys/config.g");
		expect(plan.after).toContain("M207 S0.5 F2100");
	});
});
