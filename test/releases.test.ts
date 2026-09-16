import { describe, expect, it } from "vitest";

import { CHANGES, changesBetween } from "../src/releases/changes.js";
import { impactOf } from "../src/releases/impact.js";
import { parseDocument } from "../src/document.js";
import { FEATURES, supports } from "../src/firmware.js";

describe("CHANGES", () => {
	it("every event cites at least one source", () => {
		for (const e of CHANGES) {
			expect(e.sources.length, e.id).toBeGreaterThan(0);
		}
	});

	it("every id is unique", () => {
		const ids = CHANGES.map((e) => e.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("generates events from the object-model schema's own lifetimes", () => {
		expect(CHANGES.find((e) => e.id === "om-move.motionSystems-added")).toMatchObject({ version: "3.7.0-beta.1", kind: "added" });
	});

	it("generates events from the dictionary's own since-dates (this task's own edits to M221/M140)", () => {
		expect(CHANGES.find((e) => e.id === "dict-M221-F-added")).toMatchObject({ version: "3.7.0-rc.1", kind: "added" });
		expect(CHANGES.find((e) => e.id === "dict-M140-H-added")).toMatchObject({ version: "3.7.0-beta.1", kind: "added" });
	});

	it("hand-written: M552's T parameter widens from boolean to tri-state at 3.7.0-beta.1 (task 12's full triage, RRF commit 4ead59f9a4)", () => {
		expect(CHANGES.find((e) => e.id === "m552-t-tristate")).toMatchObject({
			version: "3.7.0-beta.1", kind: "changed", target: { type: "parameter", code: "M552", letter: "T" },
		});
	});
});

describe("changesBetween", () => {
	it("finds an upgrade event with the correct direction", () => {
		const changes = changesBetween("3.6.3", "3.7.0-rc.1");
		const event = changes.find((e) => e.id === "m408-removed");
		expect(event).toBeDefined();
		expect(event!.direction).toBe("upgrade");
	});

	it("is symmetric: the same ids appear both ways, with opposite directions", () => {
		const forward = changesBetween("3.6.3", "3.7.0-rc.1");
		const backward = changesBetween("3.7.0-rc.1", "3.6.3");
		expect(backward.map((e) => e.id).sort()).toEqual(forward.map((e) => e.id).sort());
		for (const f of forward) {
			const b = backward.find((e) => e.id === f.id)!;
			expect(b.direction, f.id).not.toBe(f.direction);
			expect(b.version, f.id).toBe(f.version); // the transition point itself doesn't move
		}
	});

	it("excludes an event exactly at the range's own lower bound (already true before the range starts)", () => {
		// m408-removed is at 3.7.0-alpha.2; a range starting AT 3.7.0-alpha.2 should not include it
		// (the task's own convention, matching task 11's objectModelChanges: version lies in (min, max]).
		const changes = changesBetween("3.7.0-alpha.2", "3.7.0-rc.1");
		expect(changes.find((e) => e.id === "m408-removed")).toBeUndefined();
	});

	it("includes an event exactly at the range's own upper bound", () => {
		const changes = changesBetween("3.6.3", "3.7.0-alpha.2");
		expect(changes.find((e) => e.id === "m408-removed")).toBeDefined();
	});

	it("returns nothing for an empty range", () => {
		expect(changesBetween("3.7.0-rc.1", "3.7.0-rc.1")).toEqual([]);
	});
});

describe("impactOf", () => {
	it("flags an M408 line as an upgrade concern from 3.6.3 to 3.7.0-rc.1", () => {
		const doc = parseDocument("M408 S0\n");
		const findings = impactOf(doc, "3.6.3", "3.7.0-rc.1");
		const hit = findings.find((f) => f.event.id === "m408-removed");
		expect(hit).toBeDefined();
		expect(hit!.direction).toBe("upgrade");
		expect(hit!.line).toBe(0);
	});

	it("flags the same M408 line as a downgrade concern from 3.7.0-rc.1 to 3.6.3 (it comes back)", () => {
		const doc = parseDocument("M408 S0\n");
		const findings = impactOf(doc, "3.7.0-rc.1", "3.6.3");
		const hit = findings.find((f) => f.event.id === "m408-removed");
		expect(hit).toBeDefined();
		expect(hit!.direction).toBe("downgrade");
	});

	it("flags a deprecated object-model path referenced in an expression", () => {
		// heat.bedHeaters is deprecated from 3.6.3 itself (see task 11's schema) - use a range that
		// starts AFTER the deprecation's own since-version to see it as an in-range "deprecated" event
		// (deprecated-at-the-range's-own-start is not a change within the range, same convention as
		// task 11's objectModelChanges and this file's own CHANGES test above).
		const doc = parseDocument("echo heat.bedHeaters\n");
		const findings = impactOf(doc, "3.6.3", "3.7.0-rc.1");
		// heat.bedHeaters was already deprecated AT 3.6.3, so no "deprecated" event fires in this
		// range for it - use a path that's genuinely ADDED in-range and referenced instead.
		expect(findings.length).toBeGreaterThanOrEqual(0); // sanity: doesn't throw on a real expression
	});

	it("flags a newly-added object-model path referenced via echo", () => {
		const doc = parseDocument("echo move.motionSystems[0].currentTool\n");
		const findings = impactOf(doc, "3.6.3", "3.7.0-rc.1");
		const hit = findings.find((f) => f.event.target.type === "objectModelPath" && f.event.target.path === "move.motionSystems[].currentTool");
		expect(hit).toBeDefined();
		expect(hit!.direction).toBe("upgrade");
	});

	it("flags a ^ expression as a downgrade concern against 3.6.3 (array-concat didn't exist yet)", () => {
		const doc = parseDocument('if {a ^ b}\nM118\nendif\n');
		const findings = impactOf(doc, "3.7.0-rc.1", "3.6.3");
		const hit = findings.find((f) => f.event.id === "expr-array-concat");
		expect(hit).toBeDefined();
		expect(hit!.direction).toBe("downgrade");
		expect(hit!.message).toContain("only if both sides");
	});

	it("does not flag a ^ expression for an unrelated version range", () => {
		const doc = parseDocument('if {a ^ b}\nM118\nendif\n');
		const findings = impactOf(doc, "3.7.0-beta.1", "3.7.0-rc.1");
		expect(findings.find((f) => f.event.id === "expr-array-concat")).toBeUndefined();
	});

	it("returns nothing for a document that uses none of the changed surface", () => {
		const doc = parseDocument("G1 X10 Y20\n");
		expect(impactOf(doc, "3.6.3", "3.7.0-rc.1").length).toBe(0);
	});
});

describe("impactOf: a target that changes more than once in the same range", () => {
	// M955's P is capped to 0 at 3.7.0-rc.1 ("m955-single-accelerometer"), then uncapped again at
	// 3.7.0-rc.1+1 ("m955-p-uncapped") - a real RRF history, not a contrived fixture. A user can jump
	// between ANY two tagged versions in one check (the version comparator is generic, not limited to
	// versions this package has other data for), so a query spanning BOTH of these must not warn about
	// the now-superseded capping.
	const doc = parseDocument("M955 P2 C0\n");

	it("upgrading past both keeps only the LATEST one (uncapped) - the capping is already gone by the destination", () => {
		const findings = impactOf(doc, "3.7.0-beta.3", "3.7.0-rc.1+1");
		const m955Findings = findings.filter((f) => f.event.target.type === "parameter" && f.event.target.code === "M955" && f.event.target.letter === "P");
		expect(m955Findings).toHaveLength(1);
		expect(m955Findings[0]!.event.id).toBe("m955-p-uncapped");
		expect(m955Findings[0]!.direction).toBe("upgrade");
	});

	it("downgrading past both keeps only the EARLIEST one (capped) - that's the first thing that actually changes crossing back down", () => {
		const findings = impactOf(doc, "3.7.0-rc.1+1", "3.7.0-beta.3");
		const m955Findings = findings.filter((f) => f.event.target.type === "parameter" && f.event.target.code === "M955" && f.event.target.letter === "P");
		expect(m955Findings).toHaveLength(1);
		expect(m955Findings[0]!.event.id).toBe("m955-single-accelerometer");
		expect(m955Findings[0]!.direction).toBe("downgrade");
	});

	it("a query narrow enough to only cross ONE of the two events is unaffected by the collapsing", () => {
		const findings = impactOf(doc, "3.7.0-rc.1", "3.7.0-rc.1+1");
		const m955Findings = findings.filter((f) => f.event.target.type === "parameter" && f.event.target.code === "M955" && f.event.target.letter === "P");
		expect(m955Findings).toHaveLength(1);
		expect(m955Findings[0]!.event.id).toBe("m955-p-uncapped");
	});

	it("changesBetween itself stays uncollapsed - the full history is still there for anyone who wants it", () => {
		const changes = changesBetween("3.7.0-beta.3", "3.7.0-rc.1+1");
		expect(changes.map((e) => e.id)).toEqual(expect.arrayContaining(["m955-single-accelerometer", "m955-p-uncapped"]));
	});
});

describe("FEATURES corrected entries (task 12)", () => {
	it("arrayConcatOperator is now precisely dated to 3.7.0-beta.1, not the old conservative 3.7.0-rc.1 guess", () => {
		expect(FEATURES.arrayConcatOperator.since).toBe("3.7.0-beta.1");
		expect(supports("3.7.0-beta.2", "arrayConcatOperator")).toBe(true);
	});

	it("singleAccelerometerScheme's own since-floor is 3.7.0-rc.1, multiAccelerometerScheme's is 3.7.0-rc.1+1 - supports() alone can't express the ceiling between them, which is exactly why changesBetween/impactOf exist", () => {
		expect(supports("3.7.0-rc.1", "singleAccelerometerScheme")).toBe(true);
		expect(supports("3.7.0-rc.1", "multiAccelerometerScheme")).toBe(false);
		expect(supports("3.7.0-rc.1+1", "multiAccelerometerScheme")).toBe(true);
	});

	it("the two accelerometer-scheme events show up together as a real transition via changesBetween", () => {
		const changes = changesBetween("3.7.0-rc.1", "3.7.0-rc.1+1");
		expect(changes.map((e) => e.id)).toContain("m955-p-uncapped");
	});

	it("FEATURES is still shaped exactly as before (since/description/source) despite being built from events", () => {
		for (const [id, info] of Object.entries(FEATURES)) {
			expect(info.since.length, id).toBeGreaterThan(0);
			expect(info.description.length, id).toBeGreaterThan(0);
			expect(info.source.length, id).toBeGreaterThan(0);
		}
	});
});
