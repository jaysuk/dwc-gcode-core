import { describe, expect, it } from "vitest";

import { objectModelChanges, objectModelPath } from "../src/objectmodel/schema.js";
import { CHANGES, changesBetween } from "../src/releases/changes.js";

/**
 * The published object-model mirror lags RRF at the pre-release snapshots, so a key can be listed a release or two after RRF's own
 * `objectModelTable` serves it. `RRF_SOURCE_OVERLAYS` in scripts/build-om-schema.mjs moves five groups to the tag RRF's tables
 * first carry them (`git grep '"key"' <tag> -- src`): without it a scan upgrading across that release says nothing about a key a
 * macro may already read.
 */
const FIRST_AT: Array<[path: string, first: string, before: string]> = [
	["state.restorePoints[].gCommandNumber", "3.7.0-beta.2", "3.7.0-beta.1"],
	["move.motionSystems[].restorePoints[].gCommandNumber", "3.7.0-beta.2", "3.7.0-beta.1"],
	["boards[].drivers[].config", "3.7.0-beta.1", "3.7.0-alpha.2"],
	["boards[].timeout", "3.7.0-beta.2", "3.7.0-beta.1"],
	["move.currentMove.filePosition", "3.7.0-beta.2", "3.7.0-beta.1"],
	["sensors.probes[].loadCell", "3.7.0-beta.3", "3.7.0-beta.2"],
	["sensors.probes[].loadCell.force", "3.7.0-beta.3", "3.7.0-beta.2"],
	["sensors.probes[].loadCell.gramsPerCount", "3.7.0-beta.3", "3.7.0-beta.2"],
	["sensors.probes[].loadCell.preload", "3.7.0-beta.3", "3.7.0-beta.2"],
	["sensors.probes[].loadCell.preloadWindow", "3.7.0-beta.3", "3.7.0-beta.2"],
	["sensors.filamentMonitors[].filamentPresent", "3.7.0-beta.3", "3.7.0-beta.2"],
	["sensors.filamentMonitors[].agc", "3.7.0-beta.3", "3.7.0-beta.2"],
];

describe("object-model keys dated to the tag RRF's own tables first carry them", () => {
	it.each(FIRST_AT)("%s is unknown at the tag before %s and known from it, with the RRF source recorded", (path, first, before) => {
		expect(objectModelPath(path, before).known, `${path} at ${before}`).toBe(false);
		expect(objectModelPath(path, first).known, `${path} at ${first}`).toBe(true);
		expect(objectModelPath(path, "3.7.0-rc.2").known, `${path} at rc.2`).toBe(true);
		const event = CHANGES.find((e) => e.id === `om-${path}-added`);
		expect(event, path).toBeDefined();
		expect(event!.version, path).toBe(first);
		expect(event!.sources[0], path).toMatch(/^RRF 3\.7\.0-beta\.\d /);
	});

	it("a scan across the release that adds them reports them, one release earlier it does not", () => {
		const across = (from: string, to: string) => objectModelChanges(from, to).filter((c) => c.change === "added").map((c) => c.path);
		expect(across("3.7.0-beta.1", "3.7.0-beta.2")).toEqual(expect.arrayContaining(["state.restorePoints[].gCommandNumber", "boards[].timeout"]));
		expect(across("3.7.0-beta.2", "3.7.0-beta.3")).toEqual(expect.arrayContaining(["sensors.probes[].loadCell", "sensors.filamentMonitors[].filamentPresent"]));
		expect(across("3.7.0-beta.3", "3.7.0-rc.1")).not.toContain("sensors.probes[].loadCell");
		expect(changesBetween("3.7.0-beta.2", "3.7.0-beta.3").map((e) => e.id)).toContain("om-sensors.probes[].loadCell.gramsPerCount-added");
	});

	it("move.motionSystems[].currentMove.filePosition is not served by any tracked RRF build (only move.currentMove has it)", () => {
		for (const version of ["3.6.3", "3.7.0-beta.3", "3.7.0-rc.1", "3.7.0-rc.2"]) {
			expect(objectModelPath("move.motionSystems[].currentMove.filePosition", version).known, version).toBe(false);
			expect(objectModelPath("move.motionSystems[].currentMove.duration", version).known === (version !== "3.6.3"), version).toBe(true);
		}
	});
});
