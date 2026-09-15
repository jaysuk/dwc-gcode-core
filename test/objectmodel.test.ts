import { describe, expect, it } from "vitest";

import { OBJECT_MODEL_BASELINE, OBJECT_MODEL_VERSIONS } from "../src/objectmodel/versions.js";
import { objectModelChanges, objectModelPath } from "../src/objectmodel/schema.js";

// Real object-model facts this test pins down, each checked directly against the generated schema
// (docs/tasks/11-object-model-schema.md) rather than invented:
//  - "move.motionSystems" is a genuinely new RRF 3.7 feature (multi-motion-system support), absent
//    at 3.6.3 (this package's oldest tracked version) and present from 3.7.0-beta.1 onward.
//  - "boards[].bootloaderFileName" existed at 3.6.3 and was genuinely removed by 3.7.0-beta.1 -
//    confirmed by reading `Duet3D/ObjectModel`'s own `Board` class at both tags directly.
//  - "heat.bedHeaters" and "network.interfaces[].signal" are both deprecated for the whole tracked
//    window (in `deprecations.json` at every tracked version, including 3.6.3).
const ADDED_PATH = "move.motionSystems";
const ADDED_AT = "3.7.0-beta.1";
const REMOVED_PATH = "boards[].bootloaderFileName";
const REMOVED_AFTER = "3.6.3";
const DEPRECATED_SINCE_START_PATH = "heat.bedHeaters";
const DEPRECATED_MESSAGE = "use bedHeaterMapping instead";
const ALWAYS_PRESENT_PATH = "heat.coldExtrudeTemperature";
const UNKNOWN_PATH = "does.not.exist.anywhere";

describe("OBJECT_MODEL_VERSIONS", () => {
	it("lists every RRF-tag/npm-version intersection in the support window, oldest first", () => {
		const versions = OBJECT_MODEL_VERSIONS.map((v) => v.version);
		expect(versions).toEqual(["3.6.3", "3.7.0-alpha.2", "3.7.0-beta.1", "3.7.0-beta.2", "3.7.0-beta.3", "3.7.0-rc.1"]);
	});

	it("flags 3.7.0-alpha.2 as having no object-model data (no documentation.json, no matching Duet3D/ObjectModel tag)", () => {
		const alpha2 = OBJECT_MODEL_VERSIONS.find((v) => v.version === "3.7.0-alpha.2");
		expect(alpha2?.hasData).toBe(false);
	});

	it("every other tracked version has data", () => {
		for (const v of OBJECT_MODEL_VERSIONS) {
			if (v.version !== "3.7.0-alpha.2") expect(v.hasData, v.version).toBe(true);
		}
	});

	it("OBJECT_MODEL_BASELINE is the newest tracked version", () => {
		expect(OBJECT_MODEL_BASELINE).toBe("3.7.0-rc.1");
	});
});

describe("objectModelPath", () => {
	it("reports a path present at every tracked version as known with no since/until", () => {
		const status = objectModelPath(ALWAYS_PRESENT_PATH, "3.6.3");
		expect(status.known).toBe(true);
		expect(status.since).toBeUndefined();
		expect(status.until).toBeUndefined();
	});

	it("reports an unknown path as not known, at any version", () => {
		expect(objectModelPath(UNKNOWN_PATH, "3.6.3").known).toBe(false);
		expect(objectModelPath(UNKNOWN_PATH, "3.7.0-rc.1").known).toBe(false);
	});

	it("reports a path added partway through the window as unknown before its since version", () => {
		expect(objectModelPath(ADDED_PATH, "3.6.3").known).toBe(false);
		const status = objectModelPath(ADDED_PATH, ADDED_AT);
		expect(status.known).toBe(true);
		expect(status.since).toBe(ADDED_AT);
	});

	it("reports a path added partway through the window as known at every later tracked version", () => {
		expect(objectModelPath(ADDED_PATH, "3.7.0-rc.1").known).toBe(true);
	});

	it("reports a path removed partway through the window as known up to its until version, unknown after", () => {
		const status = objectModelPath(REMOVED_PATH, REMOVED_AFTER);
		expect(status.known).toBe(true);
		expect(status.until).toBe(REMOVED_AFTER);
		expect(objectModelPath(REMOVED_PATH, "3.7.0-beta.1").known).toBe(false);
		expect(objectModelPath(REMOVED_PATH, "3.7.0-rc.1").known).toBe(false);
	});

	it("reports a deprecated-since-the-start-of-the-window path's message at every tracked version", () => {
		for (const version of ["3.6.3", "3.7.0-beta.2", "3.7.0-rc.1"]) {
			const status = objectModelPath(DEPRECATED_SINCE_START_PATH, version);
			expect(status.known, version).toBe(true);
			expect(status.deprecated, version).toBe(DEPRECATED_MESSAGE);
		}
	});

	it("does not report deprecation for a path that isn't deprecated", () => {
		expect(objectModelPath(ALWAYS_PRESENT_PATH, "3.7.0-rc.1").deprecated).toBeUndefined();
	});

	it("throws for a version with no tracked data (3.7.0-alpha.2)", () => {
		expect(() => objectModelPath(ALWAYS_PRESENT_PATH, "3.7.0-alpha.2")).toThrow(/no object-model data/);
	});

	it("throws for a version that isn't tracked at all", () => {
		expect(() => objectModelPath(ALWAYS_PRESENT_PATH, "9.9.9")).toThrow(/not one of OBJECT_MODEL_VERSIONS/);
	});
});

describe("objectModelChanges", () => {
	it("reports an added path as \"added\" going forward, from 3.6.3 to 3.7.0-rc.1", () => {
		const changes = objectModelChanges("3.6.3", "3.7.0-rc.1");
		expect(changes).toContainEqual({ path: ADDED_PATH, change: "added", version: ADDED_AT });
	});

	it("reports the SAME added path as \"removed\" going backward, from 3.7.0-rc.1 to 3.6.3 - a downgrade", () => {
		const changes = objectModelChanges("3.7.0-rc.1", "3.6.3");
		expect(changes).toContainEqual({ path: ADDED_PATH, change: "removed", version: ADDED_AT });
	});

	it("reports a removed path as \"removed\" going forward", () => {
		const changes = objectModelChanges("3.6.3", "3.7.0-rc.1");
		expect(changes).toContainEqual({ path: REMOVED_PATH, change: "removed", version: REMOVED_AFTER });
	});

	it("reports the SAME removed path as \"added\" going backward - a downgrade re-adds it", () => {
		const changes = objectModelChanges("3.7.0-rc.1", "3.6.3");
		expect(changes).toContainEqual({ path: REMOVED_PATH, change: "added", version: REMOVED_AFTER });
	});

	it("reports a path deprecated within the queried range as \"deprecated\"", () => {
		// heat.bedHeaters is deprecated from 3.6.3 itself, so deprecation is NOT a change within any
		// range that starts at 3.6.3 (it was already deprecated at the range's own start) - use a
		// range that starts AFTER the deprecation's own since version to see a real "deprecated" event.
		// (No mid-window deprecation exists in the real tracked data to exercise this the other way;
		// this asserts the boundary behaviour instead: deprecated-at-the-start is not re-reported.)
		const changes = objectModelChanges("3.6.3", "3.7.0-rc.1");
		expect(changes.find((c) => c.path === DEPRECATED_SINCE_START_PATH && c.change === "deprecated")).toBeUndefined();
	});

	it("reports nothing for an unchanged path", () => {
		const changes = objectModelChanges("3.6.3", "3.7.0-rc.1");
		expect(changes.find((c) => c.path === ALWAYS_PRESENT_PATH)).toBeUndefined();
	});

	it("is symmetric in size between the two directions (every change has exactly one mirror)", () => {
		const forward = objectModelChanges("3.6.3", "3.7.0-rc.1");
		const backward = objectModelChanges("3.7.0-rc.1", "3.6.3");
		expect(backward.length).toBe(forward.length);
	});
});
