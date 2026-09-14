import { describe, expect, it } from "vitest";

import { tokenise } from "../src/lex.js";
import { findParam, parseParams } from "../src/params.js";

// RRF's command-number grammar, verified directly against `StringParser::ParseInternal`
// (RRF 3.7.0-rc.1) rather than inferred from the wiki - see docs/gcode-core-plan.md's Decisions #4.
describe("command number scanning matches RRF's StringParser exactly", () => {
	it("reads a bare command letter with no digits as a command with no number", () => {
		// "T" alone is real and documented: Duet3D/wiki-content's "## T: Select Tool" gives it as
		// the example for "report the current tool number". It used to tokenise as `code: null`.
		const t = tokenise("T");
		expect(t.code).toBe("T");
		expect(t.letter).toBe("T");
		expect(t.number).toBeNull();
	});

	it("accepts a leading '-' after any of G, M or T, not just T", () => {
		// RRF's scan reads an optional "-" unconditionally before checking for digits, for all
		// three letters. No current RRF command has a negative number other than T-1, but the
		// grammar itself doesn't special-case T - a hand-edited or corrupted "G-1"/"M-1" tokenises
		// as a (numerically meaningless, but syntactically real) command, matching the firmware.
		expect(tokenise("T-1")).toMatchObject({ code: "T-1", letter: "T", number: -1 });
		expect(tokenise("G-1")).toMatchObject({ code: "G-1", letter: "G", number: -1 });
		expect(tokenise("M-1")).toMatchObject({ code: "M-1", letter: "M", number: -1 });
	});

	it("reads a real example straight from the wiki's T-code table", () => {
		// "T-1 P0" - "deselect all tools but don't run any tool change macro files"
		const t = tokenise("T-1 P0");
		expect(t.code).toBe("T-1");
		expect(findParam(parseParams(t.body), "P")?.value).toBe("0");
	});

	it("reads only a single digit of fraction, matching RRF's commandFraction", () => {
		expect(tokenise("G38.2")).toMatchObject({ code: "G38.2", number: 38.2 });
		// No real RRF command has a two-digit fraction; a hand-edited "G38.25" is read by the
		// firmware as G38 fraction 2, with the second "5" left over for parameter scanning - not
		// folded into the command number the way a naive decimal scan would.
		const g = tokenise("G38.25");
		expect(g.code).toBe("G38.2");
		expect(g.number).toBe(38.2);
	});

	it("treats 'T{expr}' as the bare T command plus a T-parameter carrying the expression", () => {
		// RRF's own special case (ParseInternal): "T{expr}" is handled as if it were "T T{expr}".
		// The wiki's own example: "T T{state.currentTool + 1} ; select the tool whose number is
		// one higher than the current tool".
		const line = "T{state.currentTool + 1}";
		const t = tokenise(line);
		expect(t.code).toBe("T");
		expect(t.number).toBeNull();
		const params = parseParams(t.body);
		expect(findParam(params, "T")?.value).toBe("{state.currentTool + 1}");
	});
});
