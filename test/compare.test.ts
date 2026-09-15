import { describe, expect, it } from "vitest";

import { parseDocument } from "../src/document.js";
import { loadProject, type Project, type ProjectFile } from "../src/project.js";
import { RRF_BASELINE } from "../src/rrf.js";
import {
	compareDocuments, compareProjects, diffText, DiffTooLargeError, IDENTITY_KEYS, type DirectiveChange,
} from "../src/compare.js";

function diff(a: string, b: string, options?: { path?: string; fromVersion?: string; toVersion?: string }): ReadonlyArray<DirectiveChange> {
	return compareDocuments(parseDocument(a), parseDocument(b), options);
}

function byCode(changes: ReadonlyArray<DirectiveChange>, code: string): ReadonlyArray<DirectiveChange> {
	return changes.filter((c) => c.code === code);
}

describe("IDENTITY_KEYS", () => {
	it("cites at least one source for every defining command", () => {
		expect(IDENTITY_KEYS.length).toBeGreaterThan(0);
		for (const rule of IDENTITY_KEYS) expect(rule.sources.length, rule.code).toBeGreaterThan(0);
	});

	it("covers every command this task's own Decisions name explicitly", () => {
		const codes = IDENTITY_KEYS.map((r) => r.code);
		for (const code of ["M950", "M563", "M308", "M584", "G10"]) expect(codes).toContain(code);
	});
});

describe("compareDocuments: identity-keyed directives", () => {
	it("M563: reordered parameters aren't a change", () => {
		const changes = diff("M563 P0 H1 F0\n", "M563 P0 F0 H1\n");
		expect(byCode(changes, "M563")).toHaveLength(0);
	});

	it("M563: a changed colon list (H is a list of heaters)", () => {
		const changes = diff("M563 P0 H1:2\n", "M563 P0 H1:3\n");
		expect(changes).toEqual([
			{ type: "changed", file: "", lineA: 0, lineB: 0, code: "M563", identity: "M563:0",
				params: [{ letter: "H", from: "1:2", to: "1:3" }] },
		]);
	});

	it("M563: added and removed tools", () => {
		const changes = diff("M563 P0\n", "M563 P0\nM563 P1\n");
		expect(byCode(changes, "M563")).toEqual([
			{ type: "added", file: "", line: 1, code: "M563", identity: "M563:1" },
		]);
	});

	it("M950: whose pin changed", () => {
		const changes = diff('M950 H0 C"out0" T0\n', 'M950 H0 C"out1" T0\n');
		expect(changes).toEqual([
			{ type: "changed", file: "", lineA: 0, lineB: 0, code: "M950", identity: "M950:H0",
				params: [{ letter: "C", from: '"out0"', to: '"out1"' }] },
		]);
	});

	it("M950: different resource letters (H vs F) never collide as the same identity", () => {
		const changes = diff("M950 H0 C\"out0\" T0\n", "M950 F0 C\"out0\"\n");
		const codes = changes.map((c) => c.identity).sort();
		expect(codes).toEqual(["M950:F0", "M950:H0"]); // one removed, one added - not "changed"
	});

	it("M308: identified by S, sensor-type change detected", () => {
		const changes = diff('M308 S0 P"temp0" Y"thermistor"\n', 'M308 S0 P"temp0" Y"pt1000"\n');
		expect(changes).toHaveLength(1);
		expect(changes[0]).toMatchObject({ type: "changed", code: "M308", identity: "M308:0" });
	});

	it("M584: per axis letter - one axis changed, one added, others untouched", () => {
		const changes = diff("M584 X0 Y1 Z2\n", "M584 X0 Y1 Z9 U3\n");
		const relevant = [...byCode(changes, "M584")].sort((a, b) => a.identity.localeCompare(b.identity));
		expect(relevant).toEqual([
			{ type: "added", file: "", line: 0, code: "M584", identity: "M584:U" },
			{ type: "changed", file: "", lineA: 0, lineB: 0, code: "M584", identity: "M584:Z",
				params: [{ letter: "Z", from: "2", to: "9" }] },
		]);
	});

	it("M584: R/S travel with each axis unit (\"the axes just mapped\" this invocation)", () => {
		const changes = diff("M584 X0 R1\n", "M584 X0\n");
		expect(byCode(changes, "M584")).toEqual([
			{ type: "changed", file: "", lineA: 0, lineB: 0, code: "M584", identity: "M584:X",
				params: [{ letter: "R", from: "1", to: null }] },
		]);
	});

	it("M574: per axis letter, a changed pin", () => {
		const changes = diff('M574 X1 S1 P"io0.in"\n', 'M574 X1 S1 P"io1.in"\n');
		expect(changes).toEqual([
			{ type: "changed", file: "", lineA: 0, lineB: 0, code: "M574", identity: "M574:X",
				params: [{ letter: "P", from: '"io0.in"', to: '"io1.in"' }] },
		]);
	});

	it("M574: the extruder-endstop form is keyed by E<number>, not the axis letters", () => {
		const changes = diff("M574 E0 S3 K0\n", "M574 E0 S3 K1\n");
		expect(changes).toEqual([
			{ type: "changed", file: "", lineA: 0, lineB: 0, code: "M574", identity: "M574:E0",
				params: [{ letter: "K", from: "0", to: "1" }] },
		]);
	});

	it("G10: tool-settings form keyed by P, an offset change detected", () => {
		const changes = diff("G10 P0 X-5 Y0 Z0\n", "G10 P0 X-6 Y0 Z0\n");
		expect(changes).toEqual([
			{ type: "changed", file: "", lineA: 0, lineB: 0, code: "G10", identity: "G10:tool:0",
				params: [{ letter: "X", from: "-5", to: "-6" }] },
		]);
	});

	it("G10: workplace form (L2/L20) is a distinct identity space from tool settings", () => {
		const changes = diff("G10 L2 P1 X0 Y0 Z0\n", "G10 P1 X10 Y0 Z0\n"); // same P, different form
		// L2 P1 (workplace 1) vanished; a NEW tool-settings-for-tool-1 line appeared - not "changed",
		// because they're different identities ("G10:wcs:1" vs "G10:tool:1") despite sharing P=1.
		expect(changes.map((c) => c.identity).sort()).toEqual(["G10:tool:1", "G10:wcs:1"]);
		expect(changes.every((c) => c.type === "removed" || c.type === "added")).toBe(true);
	});

	it("G10: a retraction (no L, no P/R/S/axis letter) has no identity and a bare G1 comparison still works positionally", () => {
		const changes = diff("G10\nG1 X10\n", "G10\nG1 X20\n");
		expect(byCode(changes, "G10")).toHaveLength(0); // both sides: identical retraction, positionally matched, no change
		expect(byCode(changes, "G1")).toEqual([
			{ type: "changed", file: "", lineA: 1, lineB: 1, code: "G1", identity: "#1",
				params: [{ letter: "X", from: "10", to: "20" }] },
		]);
	});
});

describe("compareDocuments: commands without an identity rule match by position", () => {
	it("an extra G90 shows as added/removed at the tail, not a spurious change", () => {
		const changes = diff("G90\n", "G90\nG90\n");
		expect(byCode(changes, "G90")).toEqual([
			{ type: "added", file: "", line: 1, code: "G90", identity: "#2" },
		]);
	});

	it("unchanged positional commands produce no output at all", () => {
		expect(diff("G90\nG91\n", "G90\nG91\n")).toHaveLength(0);
	});

	it("a same-file relocation of an identity-keyed directive with unchanged content is invisible (semantic diff, not textual)", () => {
		const changes = diff("G28\nM563 P0\n", "M563 P0\nG28\n");
		expect(byCode(changes, "M563")).toHaveLength(0);
	});
});

describe("compareProjects: cross-file relocation", () => {
	function project(files: ReadonlyArray<ProjectFile>): Project {
		return loadProject(files);
	}

	it("a directive moved from config.g into an included file is 'moved' across files, not removed plus added", () => {
		const a = project([{ path: "0:/sys/config.g", text: "M563 P0 H1\n" }]);
		const b = project([
			{ path: "0:/sys/config.g", text: "" },
			{ path: "0:/sys/tool0.g", text: "M563 P0 H1\n" },
		]);
		const changes = compareProjects(a, b);
		expect(byCode(changes, "M563")).toEqual([
			{ type: "moved", fileA: "0:/sys/config.g", fileB: "0:/sys/tool0.g", code: "M563", identity: "M563:0", lineA: 0, lineB: 0 },
		]);
	});

	it("a directive that both moved AND changed is reported as 'changed' (at its new file), not 'moved'", () => {
		const a = project([{ path: "0:/sys/config.g", text: "M563 P0 H1\n" }]);
		const b = project([
			{ path: "0:/sys/config.g", text: "" },
			{ path: "0:/sys/tool0.g", text: "M563 P0 H2\n" },
		]);
		const changes = compareProjects(a, b);
		expect(byCode(changes, "M563")).toEqual([
			{ type: "changed", file: "0:/sys/tool0.g", lineA: 0, lineB: 0, code: "M563", identity: "M563:0",
				params: [{ letter: "H", from: "1", to: "2" }] },
		]);
	});
});

describe("release-event annotation", () => {
	it("annotates a removed M408 with the real task-12 m408-removed event", () => {
		const changes = diff("M408\n", "", { fromVersion: "3.6.3", toVersion: RRF_BASELINE });
		const removed = byCode(changes, "M408").find((c) => c.type === "removed");
		expect(removed).toBeDefined();
		expect((removed as { events?: ReadonlyArray<string> }).events).toContain("m408-removed");
	});

	it("no events property at all when no version range is given", () => {
		const changes = diff("M408\n", "");
		expect(changes.every((c) => !("events" in c))).toBe(true);
	});

	it("no events found for an untouched command over the same range", () => {
		const changes = diff("G90\n", "G90\nG90\n", { fromVersion: "3.6.3", toVersion: RRF_BASELINE });
		expect(changes.every((c) => !("events" in c) || (c as { events?: ReadonlyArray<string> }).events?.length === 0)).toBe(true);
	});
});

describe("diffText", () => {
	it("round-trips: applying the diff (every same/added line, in order) reproduces b exactly", () => {
		const a = "G90\nG91\nG1 X10\nM400\n";
		const b = "G90\nG1 X10\nG1 Y20\nM400\n";
		const result = diffText(a, b);
		const rebuilt = result.filter((e) => e.type !== "removed").map((e) => e.text).join("\n");
		expect(rebuilt).toBe(b);
	});

	it("round-trips on a larger, less structured pair too", () => {
		const a = Array.from({ length: 40 }, (_, i) => `line ${i % 7}`).join("\n");
		const b = Array.from({ length: 35 }, (_, i) => `line ${(i * 3) % 11}`).join("\n");
		const rebuilt = diffText(a, b).filter((e) => e.type !== "removed").map((e) => e.text).join("\n");
		expect(rebuilt).toBe(b);
	});

	it("round-trips back to A as well, from every same/removed entry", () => {
		const a = "G90\nG91\nG1 X10\nM400\n";
		const b = "G90\nG1 X10\nG1 Y20\nM400\n";
		const rebuiltA = diffText(a, b).filter((e) => e.type !== "added").map((e) => e.text).join("\n");
		expect(rebuiltA).toBe(a);
	});

	it("trims the common head and tail, so a big file with a few edits stays cheap", () => {
		// The LCS table is quadratic in the DIFFERING lines only. Without trimming, this pair needed a
		// 25,000,000-cell table and ~600ms; the assertion here is on the result, the point is the cost.
		const base = Array.from({ length: 5000 }, (_, i) => `G1 X${i}`);
		const edited = base.slice();
		edited[2500] = "G1 X9999";
		const result = diffText(base.join("\n"), edited.join("\n"));
		expect(result.filter((e) => e.type !== "same")).toEqual([
			{ type: "removed", lineA: 2500, text: "G1 X2500" },
			{ type: "added", lineB: 2500, text: "G1 X9999" },
		]);
		expect(result.filter((e) => e.type !== "removed").map((e) => e.text).join("\n")).toBe(edited.join("\n"));
	});

	it("throws DiffTooLargeError rather than quietly allocating gigabytes", () => {
		// Int32Array storage sits outside V8's heap, so an unbounded table isn't stopped by
		// --max-old-space-size; it just kills a browser tab. Fail loudly instead.
		const a = Array.from({ length: 6000 }, (_, i) => `a${i}`).join("\n");
		const b = Array.from({ length: 6000 }, (_, i) => `b${i}`).join("\n");
		expect(() => diffText(a, b)).toThrow(DiffTooLargeError);
		expect(() => diffText(a, b)).toThrow(/over the 16000000-cell limit/);
	});

	it("does NOT throw for the same line count when the files mostly agree", () => {
		// Same 6000 lines as above, but sharing a head/tail - the cap is on differing lines, not size.
		const base = Array.from({ length: 6000 }, (_, i) => `line${i}`);
		const edited = base.slice();
		edited[3000] = "changed";
		expect(() => diffText(base.join("\n"), edited.join("\n"))).not.toThrow();
	});

	it("marks identical input as entirely 'same'", () => {
		const text = "G90\nG91\n";
		const result = diffText(text, text);
		expect(result.every((e) => e.type === "same")).toBe(true);
	});

	it("a genuinely changed line shows as one removed and one added, not a false 'same'", () => {
		// No trailing "\n" here on purpose: with one, both sides would also share a trailing empty
		// line from the split - a real "same" entry, just not the one this test is checking for.
		const result = diffText("G1 X10", "G1 X20");
		expect(result).toEqual([
			{ type: "removed", lineA: 0, text: "G1 X10" },
			{ type: "added", lineB: 0, text: "G1 X20" },
		]);
	});
});
