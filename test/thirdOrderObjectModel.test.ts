import { describe, expect, it } from "vitest";

import { diagnoseDocument } from "../src/diagnostics/diagnose.js";
import { parseDocument } from "../src/document.js";
import { objectModelChanges, objectModelPath } from "../src/objectmodel/schema.js";
import { CHANGES, changesBetween } from "../src/releases/changes.js";
import { impactOf } from "../src/releases/impact.js";

/**
 * `move.accelerationTime` and `move.usingSCurve` (third-order motion control, `M201 T`): the Duet3D/ObjectModel v3.6.3
 * mirror declares both but RRF 3.6.3 serves neither - `git grep` at the tag finds nothing - and both enter
 * `Move::objectModelTable` at 3.7.0-alpha.2 (RRF `bee83e350`). Until this was fixed (`scripts/build-om-schema.mjs`,
 * `THIRD_ORDER_NOT_AT_363`) the schema called them present everywhere, so `{move.usingSCurve}` in a macro raised no
 * warning on 3.6.3 and no event told a user upgrading from 3.6.3 that the keys now exist.
 */
const KEYS = ["move.accelerationTime", "move.usingSCurve"] as const;

describe("third-order object-model keys are new in 3.7.0-alpha.2", () => {
	it("are unknown at 3.6.3 and known from alpha.2 on", () => {
		for (const key of KEYS) {
			expect(objectModelPath(key, "3.6.3").known, `${key} at 3.6.3`).toBe(false);
			for (const v of ["3.7.0-alpha.2", "3.7.0-beta.1", "3.7.0-beta.3", "3.7.0-rc.2"]) {
				expect(objectModelPath(key, v).known, `${key} at ${v}`).toBe(true);
			}
		}
	});

	it("each has an `added` event at alpha.2 and it is in the 3.6.3 -> alpha.2 window", () => {
		for (const key of KEYS) {
			const event = CHANGES.find((e) => e.id === `om-${key}-added`);
			expect(event, key).toBeDefined();
			expect(event!.version).toBe("3.7.0-alpha.2");
			expect(event!.target).toEqual({ type: "objectModelPath", path: key });
			expect(changesBetween("3.6.3", "3.7.0-alpha.2").map((e) => e.id)).toContain(`om-${key}-added`);
		}
		expect(objectModelChanges("3.6.3", "3.7.0-alpha.2").map((c) => c.path)).toEqual(expect.arrayContaining([...KEYS]));
	});

	it("a macro that reads one is flagged when it runs on 3.6.3, and not on a release that has it", () => {
		const text = "if move.usingSCurve\n  echo move.accelerationTime\n";
		const doc = parseDocument(text);
		const old = diagnoseDocument(doc, "0:/macros/s.g", { firmwareVersion: "3.6.3" }).filter((d) => d.rule === "objectModel/unknown-path").map((d) => d.message);
		expect(old).toEqual(["move.usingSCurve isn't a known object-model path at RRF 3.6.3", "move.accelerationTime isn't a known object-model path at RRF 3.6.3"]);
		expect(diagnoseDocument(doc, "0:/macros/s.g", { firmwareVersion: "3.7.0-rc.2" }).filter((d) => d.rule === "objectModel/unknown-path")).toEqual([]);
	});

	it("moving a file that reads them from 3.6.3 to alpha.2 notes the new keys, and the way back says they are gone", () => {
		const doc = parseDocument("echo {move.usingSCurve}\n");
		expect(impactOf(doc, "3.6.3", "3.7.0-alpha.2").map((f) => f.event.id)).toEqual(["om-move.usingSCurve-added"]);
		expect(impactOf(doc, "3.7.0-alpha.2", "3.6.3")[0]?.direction).toBe("downgrade");
		expect(impactOf(doc, "3.7.0-alpha.2", "3.7.0-rc.2")).toEqual([]);
	});
});
