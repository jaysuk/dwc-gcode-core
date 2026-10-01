import { describe, expect, it } from "vitest";

import { CHANGES, changesBetween } from "../src/releases/changes.js";
import { scanImpact, type ScanFile } from "../src/releases/scan.js";
import {
	RULE_EVENT_IDS, SEVERITY_OVERRIDE_IDS, applyFileEdits, applyTextEdits, planActions, previewEdits, severityOf,
} from "../src/releases/actions.js";

const plan = (files: Array<ScanFile>, from = "3.6.3", to = "3.7.0-rc.2") => planActions(scanImpact(files, from, to), files);
const config = (...lines: Array<string>): ScanFile => ({ path: "0:/sys/config.g", text: lines.join("\n") + "\n" });
const ids = (list: ReadonlyArray<{ event: { id: string } }>): Array<string> => list.map((p) => p.event.id);

describe("severityOf", () => {
	const event = (id: string, direction: "upgrade" | "downgrade") => changesBetween(direction === "upgrade" ? "3.6.3" : "3.7.0-rc.2", direction === "upgrade" ? "3.7.0-rc.2" : "3.6.3").find((e) => e.id === id)!;

	it("reads a change by what it means in the direction the file is moving", () => {
		expect(severityOf(event("m408-removed", "upgrade"))).toBe("breaks");
		expect(severityOf(event("expr-array-literal", "upgrade"))).toBe("info"); // added: nothing breaks on an upgrade
		expect(severityOf(event("expr-array-literal", "downgrade"))).toBe("differs"); // ...but the older firmware lacks it
		expect(severityOf(event("m558-4-added", "downgrade"))).toBe("breaks"); // a missing COMMAND is an error
		expect(severityOf(event("m408-removed", "downgrade"))).toBe("info"); // it is back
		expect(severityOf(event("m575-p-channel-numbering", "upgrade"))).toBe("differs");
	});

	it("honours a per-direction override", () => {
		expect(severityOf(event("m669-five-bar-d-two-values", "upgrade"))).toBe("info");
		expect(severityOf(event("m669-five-bar-d-two-values", "downgrade"))).toBe("differs");
	});

	it("only names events that exist", () => {
		const known = new Set(CHANGES.map((e) => e.id));
		for (const id of [...SEVERITY_OVERRIDE_IDS, ...RULE_EVENT_IDS]) expect(known.has(id), id).toBe(true);
	});
});

describe("planActions", () => {
	it("says nothing about a file that only uses things that were added", () => {
		const p = plan([{ path: "0:/macros/a.g", text: "var a = {1,2,3}\nM140 P0 H0\nM563 P0 D0 H1\n" }]);
		expect(p.problems).toEqual([]);
		expect(ids(p.worthALook)).not.toContain("expr-array-literal");
		expect(p.leftOut).toBeGreaterThan(0);
	});

	it("does not flag M140 H when the heater has no other job", () => {
		const p = plan([config("M140 P0 H0", "M563 P0 D0 H1", "M141 P0 H2")]);
		expect(p.problems).toEqual([]);
		expect(ids(p.worthALook)).not.toContain("m140-h-colon-list");
	});

	it("a command that no longer exists is a problem with advice and no edit", () => {
		const p = plan([config("M408 S0")]);
		expect(ids(p.problems)).toEqual(["m408-removed"]);
		expect(p.problems[0].fix).toBeNull();
		expect(p.problems[0].explanation).toContain("M408");
	});

	describe("a heater with two jobs", () => {
		const files = [config("M140 P0 H0", "M563 P0 D0 H0:1")];

		it("is ONE problem, found once, however many lines the catalogue matches", () => {
			const p = plan(files);
			expect(p.problems).toHaveLength(1);
			expect(p.problems[0].severity).toBe("breaks");
			expect(p.problems[0].explanation).toContain("Heater 0");
		});

		it("offers each side and picks neither", () => {
			const fix = plan(files).problems[0].fix!;
			expect(fix.safe).toBe(false);
			expect(fix.options).toHaveLength(2);
			const results = fix.options.map((o) => applyFileEdits(files, o.edits)[0].text);
			expect(results).toContain("M140 P0 H-1\nM563 P0 D0 H0:1\n"); // the bed gives it up: H-1 is "none"
			expect(results).toContain("M140 P0 H0\nM563 P0 D0 H1\n"); // the tool gives it up: the rest of its list stays
		});

		it("takes the whole H off a tool whose only heater it was", () => {
			const f = [config("M141 P0 H3", "M563 P1 D1 H3 F0")];
			const results = plan(f).problems[0].fix!.options.map((o) => applyFileEdits(f, o.edits)[0].text);
			expect(results).toContain("M141 P0 H-1\nM563 P1 D1 H3 F0\n");
			expect(results).toContain("M141 P0 H3\nM563 P1 D1 F0\n");
		});

		it("finds a conflict across files", () => {
			const p = plan([config("M140 P0 H0"), { path: "0:/sys/tools.g", text: "M563 P0 D0 H0\n" }]);
			expect(p.problems).toHaveLength(1);
			expect(p.problems[0].fix!.options.map((o) => o.label).join("\n")).toContain("tools.g:1");
		});

		it("only suggests a look, with no edit, when one line is inside an if", () => {
			const p = plan([config("M140 P0 H0", "if {true}", "  M563 P0 D0 H0", "endif")]);
			expect(p.problems).toEqual([]);
			expect(p.worthALook).toHaveLength(1);
			expect(p.worthALook[0].fix).toBeNull();
		});

		it("ignores a heater given by an expression, which the file cannot resolve", () => {
			const p = plan([config("M140 P0 H{global.h}", "M563 P0 D0 H0")]);
			expect(p.problems).toEqual([]);
		});

		it("on a downgrade only a list of several bed heaters matters", () => {
			const down = (files: Array<ScanFile>) => plan(files, "3.7.0-rc.2", "3.6.3");
			expect(down([config("M140 P0 H0:1")]).problems.map((p) => p.explanation).join()).toContain("lists several heaters");
			expect(down([config("M140 P0 H0", "M563 P0 D0 H0:1")]).problems.filter((p) => p.event.id.startsWith("m140") || p.event.id.startsWith("m563"))).toEqual([]);
		});
	});

	describe("M955/M956 without P", () => {
		it("adds P0, which is what an omitted P meant, and calls that safe", () => {
			const files = [config("M955 C0 ; accelerometer", "M956 S100", "M955 P1 C0")];
			const p = plan(files);
			expect(ids(p.problems).sort()).toEqual(["m955-p-required", "m956-p-required"]);
			for (const problem of p.problems) expect(problem.fix!.safe).toBe(true);
			const out = applyFileEdits(files, p.problems.flatMap((x) => x.fix!.options[0].edits))[0].text;
			expect(out).toBe("M955 C0 P0 ; accelerometer\nM956 S100 P0\nM955 P1 C0\n");
		});

		it("handles a bare command, and leaves an already-migrated file alone", () => {
			const files = [config("M955")];
			expect(applyFileEdits(files, plan(files).problems[0].fix!.options[0].edits)[0].text).toBe("M955 P0\n");
			expect(plan([config("M955 P0 C0")]).problems).toEqual([]);
		});

		it("is idempotent: the fixed file has nothing left to fix", () => {
			const files = [config("M955 C0")];
			const fixed = applyFileEdits(files, plan(files).problems[0].fix!.options[0].edits);
			expect(plan(fixed).problems).toEqual([]);
		});

		it("does not touch a downgrade, where an omitted P is how it always worked", () => {
			expect(plan([config("M955 C0")], "3.7.0-rc.2", "3.6.3").problems).toEqual([]);
		});
	});

	it("a numbering change is advice, never an edit (a migrated file would be moved to the wrong port)", () => {
		const p = plan([config("M575 P1 B57600 S1")]);
		expect(ids(p.worthALook)).toContain("m575-p-channel-numbering");
		expect(p.worthALook.every((x) => x.fix === null)).toBe(true);
	});
});

describe("applyTextEdits / previewEdits", () => {
	it("applies several edits at once, in any order", () => {
		expect(applyTextEdits("abcdef", [{ start: 4, end: 5, replacement: "X" }, { start: 0, end: 1, replacement: "YY" }])).toBe("YYbcdXf");
	});

	it("refuses an overlap, a range outside the file and a line break", () => {
		expect(() => applyTextEdits("abcdef", [{ start: 0, end: 3, replacement: "" }, { start: 2, end: 4, replacement: "" }])).toThrow(RangeError);
		expect(() => applyTextEdits("abc", [{ start: 0, end: 9, replacement: "" }])).toThrow(RangeError);
		expect(() => applyTextEdits("abc", [{ start: 0, end: 1, replacement: "a\nb" }])).toThrow(RangeError);
		expect(() => applyTextEdits("a\nb", [{ start: 0, end: 3, replacement: "x" }])).toThrow(RangeError);
	});

	it("keeps CRLF line endings, because it never touches one", () => {
		const files: Array<ScanFile> = [{ path: "0:/sys/config.g", text: "M955 C0\r\nG1 X1\r\n" }];
		expect(applyFileEdits(files, plan(files).problems[0].fix!.options[0].edits)[0].text).toBe("M955 C0 P0\r\nG1 X1\r\n");
	});

	it("previews the changed lines with their 1-based numbers", () => {
		const files: Array<ScanFile> = [config("G1 X1", "M955 C0")];
		expect(previewEdits(files, plan(files).problems[0].fix!.options[0].edits)).toEqual([
			{ path: "0:/sys/config.g", line: 2, before: "M955 C0", after: "M955 C0 P0" },
		]);
	});

	it("throws for an edit to a file that was not given", () => {
		expect(() => applyFileEdits([], [{ path: "0:/x.g", start: 0, end: 0, replacement: "a" }])).toThrow(RangeError);
	});
});
