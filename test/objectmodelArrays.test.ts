import { describe, expect, it } from "vitest";

import { parseDocument } from "../src/document.js";
import { RRF_BASELINE } from "../src/rrf.js";
import { diagnoseDocument } from "../src/diagnostics/diagnose.js";
import { OBJECT_MODEL_PATHS, objectModelChanges, objectModelPath } from "../src/objectmodel/schema.js";

// The 2026-09-28 report: `sensors.probes[0].offsets[0]` was flagged as not existing, "and this also
// happens to other valid OM entries". Root cause: the schema listed `sensors.probes[].offsets` but an
// element of it normalises to `sensors.probes[].offsets[]`, which no generated list carries (arrays of
// primitives have no children to imply it, and even an array of objects only ever lists its children,
// never the bare element). Plus real RRF-only keys (`seqs`) and declared-but-undocumented fields.

const LATEST = "3.7.0-rc.2";

function unknownPaths(expressions: ReadonlyArray<string>, firmwareVersion = LATEST): Array<string> {
	const doc = parseDocument(expressions.map((e) => `echo {${e}}`).join("\n"));
	const diags = diagnoseDocument(doc, "x.g", { firmwareVersion }).filter((d) => d.rule === "objectModel/unknown-path");
	return expressions.filter((_, i) => diags.some((d) => d.line === i));
}

describe("indexing an array (objectModelPath)", () => {
	it("accepts an element of a leaf array - sensors.probes[].offsets[]", () => {
		expect(objectModelPath("sensors.probes[].offsets[]", LATEST).known).toBe(true);
	});

	it("accepts an element of an array of objects, which has no path of its own - heat.heaters[]", () => {
		expect(objectModelPath("heat.heaters[]", LATEST).known).toBe(true);
		expect(objectModelPath("move.axes[]", LATEST).known).toBe(true);
	});

	it("accepts a doubly-indexed array of arrays, but not one more level than the array has", () => {
		expect(objectModelPath("heat.bedHeaterMapping[][]", LATEST).known).toBe(true);
		expect(objectModelPath("move.kinematics.anchors[][]", LATEST).known).toBe(true);
		expect(objectModelPath("sensors.probes[].offsets[][]", LATEST).known).toBe(false);
		expect(objectModelPath("heat.heaters[][]", LATEST).known).toBe(false);
	});

	it("does not accept an index on something that isn't an array", () => {
		expect(objectModelPath("state.status[]", LATEST).known).toBe(false);
		expect(objectModelPath("heat.coldExtrudeTemperature[]", LATEST).known).toBe(false);
		expect(objectModelPath("sensors.probes[].nonsense[]", LATEST).known).toBe(false);
	});

	it("an element of a nonexistent array is still unknown", () => {
		expect(objectModelPath("does.not.exist[]", LATEST).known).toBe(false);
	});

	it("an element carries its array's lifetime and deprecation", () => {
		// move.motionSystems appeared at 3.7.0-beta.1
		expect(objectModelPath("move.motionSystems[]", "3.6.3").known).toBe(false);
		expect(objectModelPath("move.motionSystems[]", "3.7.0-beta.1")).toMatchObject({ known: true, since: "3.7.0-beta.1" });
		// heat.bedHeaters is deprecated from beta.1 (RRF flags it obsolete from alpha.3), not at 3.6.3
		expect(objectModelPath("heat.bedHeaters[]", "3.6.3").deprecated).toBeUndefined();
		expect(objectModelPath("heat.bedHeaters[]", "3.7.0-beta.1")).toMatchObject({ known: true, deprecated: "use bedHeaterMapping instead" });
	});

	it("every path with an indexable value records how far it can be indexed", () => {
		const by = new Map(OBJECT_MODEL_PATHS.map((e) => [e.path, e]));
		expect(by.get("sensors.probes[].offsets")?.array).toBe(1);
		expect(by.get("heat.heaters")?.array).toBe(1);
		expect(by.get("heat.bedHeaterMapping")?.array).toBe(2);
		expect(by.get("state.status")?.array).toBeUndefined();
	});

	it("every collection with children is indexable (the invariant the generator's fallback also enforces)", () => {
		const withChildren = new Set(OBJECT_MODEL_PATHS.filter((e) => e.path.includes("[]")).map((e) => e.path.slice(0, e.path.indexOf("[]"))));
		const by = new Map(OBJECT_MODEL_PATHS.map((e) => [e.path, e]));
		for (const p of withChildren) {
			// a nested path (a[].b[].c) contributes a[] and a[].b; only test the bare prefixes the schema itself lists
			const entry = by.get(p);
			if (entry !== undefined) expect(entry.array, p).toBeGreaterThanOrEqual(1);
		}
	});
});

describe("diagnostics: real expressions from the report and its neighbours are not flagged", () => {
	it("sensors.probes[0].offsets[0] and every other array element the report's category covers", () => {
		expect(unknownPaths([
			"sensors.probes[0].offsets[0]", "sensors.probes[0].offsets[1]", "sensors.probes[0].speeds[1]",
			"sensors.probes[0].diveHeights[0]", "sensors.probes[0].temperatureCoefficients[1]", "sensors.probes[0].value[0]",
			"tools[0].heaters[0]", "tools[0].offsets[1]", "tools[0].extruders[0]", "tools[0].fans[0]",
			"move.axes[0].workplaceOffsets[2]", "move.axes[0].drivers[0]", "move.axes[0].machinePosition",
			"heat.heaters[0]", "heat.bedHeaterMapping[0][1]", "move.axes[0]", "sensors.probes[0]", "boards[0].drivers[0]",
			"move.kinematics.anchors[0][1]", "move.compensation.probeGrid.axes[0]", "network.interfaces[0]", "volumes[0]",
			"sensors.analog[0]", "job.layers[0]", "fans[0].thermostatic.sensors[0]",
		])).toEqual([]);
	});

	it("still flags a genuinely wrong path in the same shape", () => {
		expect(unknownPaths([
			"sensors.probes[0].nonsense[0]", "sensors.probes[0].offsets[0].x", "sensors.probes[0].offsets[0][0]", "state.status[0]",
		])).toHaveLength(4);
	});
});

describe("paths RRF serves that the object-model package leaves out", () => {
	it("seqs (RepRap.cpp table 5) is known, with each member", () => {
		expect(unknownPaths(["seqs", "seqs.heat", "seqs.move", "seqs.boards", "seqs.reply", "seqs.volChanges[0]"])).toEqual([]);
		expect(unknownPaths(["seqs.nope", "seqs[0]"])).toHaveLength(2);
	});

	it("carries its citation", () => {
		const seqs = OBJECT_MODEL_PATHS.find((e) => e.path === "seqs");
		expect(seqs?.source).toContain("Platform/RepRap.cpp");
		expect(seqs?.until).toBeUndefined();
		expect(seqs?.since).toBeUndefined();
	});

	it("closedLoop's own avg/max/rms members (DriverData.cpp) are known", () => {
		expect(unknownPaths([
			"boards[0].drivers[0].closedLoop.currentFraction.avg", "boards[0].drivers[0].closedLoop.currentFraction.max",
			"boards[0].drivers[0].closedLoop.positionError.max", "boards[0].drivers[0].closedLoop.positionError.rms",
		])).toEqual([]);
	});

	it("declared-but-undocumented fields are present at 3.7.0-rc.1 (they used to read as removed after 3.6.3)", () => {
		for (const p of ["boards[].drivers[].status", "boards[].drivers[].closedLoop", "move.keepout[].active", "boards[].directDisplay.screen.width"]) {
			expect(objectModelPath(p, LATEST).known, p).toBe(true);
			expect(objectModelPath(p, "3.6.3").known, p).toBe(true);
			expect(objectModelChanges("3.6.3", LATEST).some((c) => c.path === p), p).toBe(false);
		}
	});

	it("baseline check: the version this package targets is the one the diagnostics above ran at", () => {
		expect(LATEST).toBe(RRF_BASELINE);
	});
});
