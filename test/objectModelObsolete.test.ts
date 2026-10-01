import { describe, expect, it } from "vitest";

import { parseDocument } from "../src/document.js";
import { objectModelChanges, objectModelPath } from "../src/objectmodel/schema.js";
import { CHANGES, changesBetween } from "../src/releases/changes.js";
import { impactOf } from "../src/releases/impact.js";
import { diagnoseDocument } from "../src/diagnostics/diagnose.js";

/**
 * RRF treats an object-model key as obsolete when its table entry carries `ObjectModelEntryFlags::obsolete`: a read in an expression
 * prints "obsolete object model field X queried" and M409 omits it by default. The published mirror lists these keys as deprecated
 * at 3.6.3 already (with advice naming keys 3.6.3 does not have), so every deprecation event was dated to the baseline, which a scan
 * can never report (the window is (from, to]). RRF's own tables flag eleven of them only from 3.7.0-alpha.3 (alpha.4 for one):
 * `git grep -E '"key".*obsolete'` at each tracked tag. They are therefore dated to beta.1, the first tracked object-model snapshot.
 */
const FROM_BETA1 = [
	"heat.bedHeaters", "heat.chamberHeaters", "move.extruders[].pressureAdvance", "move.printingAcceleration", "move.rotation",
	"move.travelAcceleration", "move.virtualEPos", "move.workplaceNumber", "state.nextTool", "state.previousTool", "state.restorePoints",
];
const FROM_BASELINE = ["tools[].feedForward", "sensors.probes[].diveHeight", "sensors.filamentMonitors[].enabled", "job.layers[].filament", "network.interfaces[].signal"];

describe("deprecations RRF's own tables date after 3.6.3", () => {
	it("are not deprecated at 3.6.3 or alpha.2 and are from beta.1 on, with the RRF source in the event", () => {
		for (const path of FROM_BETA1) {
			expect(objectModelPath(path, "3.6.3").deprecated, `${path} at 3.6.3`).toBeUndefined();
			expect(objectModelPath(path, "3.7.0-alpha.2").deprecated, `${path} at alpha.2`).toBeUndefined();
			expect(objectModelPath(path, "3.7.0-beta.1").deprecated, `${path} at beta.1`).toBeTypeOf("string");
			expect(objectModelPath(path, "3.7.0-rc.2").deprecated, `${path} at rc.2`).toBeTypeOf("string");
			const event = CHANGES.find((e) => e.id === `om-${path}-deprecated`);
			expect(event, path).toBeDefined();
			expect(event!.version, path).toBe("3.7.0-beta.1");
			expect(event!.sources[0], path).toContain("ObjectModelEntryFlags::obsolete");
		}
	});

	it("the ones RRF already flags at 3.6.3, or does not serve, keep the baseline date", () => {
		for (const path of FROM_BASELINE) expect(objectModelPath(path, "3.6.3").deprecated, path).toBeTypeOf("string");
	});

	it("upgrading from 3.6.3 now reports them (it could not before: the date was the baseline)", () => {
		const changes = objectModelChanges("3.6.3", "3.7.0-beta.1").filter((c) => c.change === "deprecated").map((c) => c.path);
		for (const path of FROM_BETA1) expect(changes, path).toContain(path);
		for (const path of FROM_BASELINE) expect(changes, path).not.toContain(path);
		expect(changesBetween("3.6.3", "3.7.0-beta.1").map((e) => e.id)).toContain("om-state.nextTool-deprecated");
	});

	it("a tool-change macro that reads state.nextTool is flagged going to a release that warns, and the lint agrees", () => {
		const doc = parseDocument("if state.nextTool = 1\n  M98 P\"tpost1.g\"\n");
		expect(impactOf(doc, "3.6.3", "3.7.0-rc.2").map((f) => f.event.id)).toContain("om-state.nextTool-deprecated");
		expect(impactOf(doc, "3.7.0-beta.1", "3.7.0-rc.2")).toEqual([]);
		const at363 = diagnoseDocument(doc, "0:/sys/tpost1.g", { firmwareVersion: "3.6.3" }).filter((d) => d.rule === "objectModel/deprecated-path");
		const atRc2 = diagnoseDocument(doc, "0:/sys/tpost1.g", { firmwareVersion: "3.7.0-rc.2" }).filter((d) => d.rule === "objectModel/deprecated-path");
		expect(at363).toEqual([]);
		expect(atRc2.map((d) => d.message)).toEqual(["state.nextTool is deprecated - use move.motionSystems[].nextTool instead"]);
	});
});
