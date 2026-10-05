import { describe, expect, it } from "vitest";

import { parseDocument } from "../src/document.js";
import { objectModelChanges, objectModelPath } from "../src/objectmodel/schema.js";
import { changesBetween } from "../src/releases/changes.js";
import { planActions } from "../src/releases/actions.js";
import { impactOf } from "../src/releases/impact.js";
import { isTrackedRelease, RELEASES } from "../src/releases/releases.js";
import { scanImpact, type ScanFile } from "../src/releases/scan.js";

// What changed for a user's files between RRF 3.7.0-rc.2 and 3.7.0 stable. Read from RRF source at the 3.7-dev head 86eaac524 (2026-10-05, 3.7.0 not yet
// tagged); docs/rrf-triage/per-release/3.7.0-rc.2..3.7.0-rc.2+1.md and 3.7.0-rc.2+1..3.7.0.md are the closed checklists, each event's `sources` the lines.

const RC2 = "3.7.0-rc.2";
const STABLE = "3.7.0";

const eventIds = (text: string, from = RC2, to = STABLE): Array<string> => impactOf(parseDocument(text), from, to).map((f) => f.event.id);
const plan = (text: string, from = RC2, to = STABLE) => {
	const files: Array<ScanFile> = [{ path: "0:/sys/config.g", text }];
	return planActions(scanImpact(files, from, to), files);
};

describe("3.7.0 is a tracked release", () => {
	it("follows rc.2 with the rc.2+1 build between them", () => {
		expect(RELEASES.slice(-3).map((r) => r.version)).toEqual([RC2, "3.7.0-rc.2+1", STABLE]);
		for (const v of [STABLE, "3.7.0(CAN0)", "3.7.0-rc.2+1"]) expect(isTrackedRelease(v), v).toBe(true);
	});

	it("a scan from rc.2 to 3.7.0 has a catalogue (the Settings card's 'beyond the catalogue' warning is gone)", () => {
		const report = scanImpact([{ path: "0:/sys/config.g", text: "G1 X10\n" }], RC2, STABLE);
		expect(report.coverage).toEqual({ predatesCatalogue: false, beyondCatalogue: false });
	});

	it("rc.2 -> 3.7.0 holds exactly the events this pass added (and the object-model ones the schema generates)", () => {
		const hand = changesBetween(RC2, STABLE).map((e) => e.id).filter((id) => !id.startsWith("om-"));
		expect(hand.sort()).toEqual([
			"fileinfo-comment-scan-fixes", "fileinfo-preflight-print-height", "m558-1-retracts-probe-on-sensor-error", "m593-custom-delays-validated",
			"m593-mzv-amplitudes-corrected", "m593-prepare-advance-time-corrected", "m593-s-damping-limit",
		]);
	});
});

describe("M593 input shaping", () => {
	it("S above 0.9 is rejected from 3.7.0, and the cap follows the shaper (ei2 0.3, ei3 0.2)", () => {
		for (const [line, breaks] of [
			['M593 P"zvd" F40 S0.95', true],
			['M593 P"zvd" F40 S0.5', false],
			['M593 P"ei2" F40 S0.4', true],
			['M593 P"ei2" F40 S0.3', false],
			['M593 P"ei3" F40 S0.25', true],
			['M593 P"ei3" F40 S0.2', false],
			["M593 F40 S0.95", true], // no P: certain to exceed every cap
			["M593 F40 S0.05", false],
		] as const) {
			const found = plan(`${line}\n`);
			expect(found.problems.map((p) => p.event.id), line).toEqual(breaks ? ["m593-s-damping-limit"] : []);
		}
	});

	it("S with no P between 0.2 and 0.9 is worth a look, not a break (the shaper set earlier decides)", () => {
		const found = plan("M593 F40 S0.5\n");
		expect(found.problems).toEqual([]);
		expect(found.worthALook.map((p) => p.event.id)).toEqual(["m593-s-damping-limit"]);
	});

	it("an S set by an expression is left to the owner, and going back to rc.2 never flags it", () => {
		expect(plan("M593 F40 S{var.zeta}\n").worthALook.map((p) => p.event.id)).toEqual(["m593-s-damping-limit"]);
		const down = plan('M593 P"zvd" F40 S0.95\n', STABLE, RC2);
		expect(down.problems).toEqual([]);
		expect(down.worthALook.map((p) => p.event.id)).not.toContain("m593-s-damping-limit");
	});

	it("flags a custom shaper whose T delays are not positive and strictly increasing", () => {
		const bad = ['M593 P"custom" H0.3:0.4 T0.02:0.01', 'M593 P"custom" H0.3:0.4 T0:0.01', 'M593 P"custom" H0.3:0.4 T0.01:0.01'];
		for (const line of bad) expect(plan(`${line}\n`).problems.map((p) => p.event.id), line).toEqual(["m593-custom-delays-validated"]);
		for (const line of ['M593 P"custom" H0.3:0.4 T0.01:0.02', 'M593 P"zvd" T0.02:0.01', 'M593 P"custom" H0.3:0.4']) {
			expect(plan(`${line}\n`).problems, line).toEqual([]);
		}
	});

	it("the event for a custom shaper matches M593 T, and the MZV one matches only P\"mzv\"", () => {
		expect(eventIds('M593 P"custom" H0.3 T0.01\n')).toContain("m593-custom-delays-validated");
		expect(eventIds('M593 P"mzv" F40\n')).toContain("m593-mzv-amplitudes-corrected");
		expect(eventIds('M593 P"zvd" F40\n')).not.toContain("m593-mzv-amplitudes-corrected");
		expect(eventIds('M593 P"mzv" F40\n', "3.7.0-rc.1", RC2)).not.toContain("m593-mzv-amplitudes-corrected");
	});

	it("the MZV fix is a fix, not a to-do, on the way up", () => {
		const found = plan('M593 P"mzv" F40 S0.05\n');
		expect(found.problems).toEqual([]);
		expect(found.worthALook).toEqual([]);
	});
});

describe("object model", () => {
	it("move.motionSystems[].currentMove.filePosition appears at 3.7.0, and is not served at rc.2", () => {
		expect(objectModelPath("move.motionSystems[].currentMove.filePosition", RC2).known).toBe(false);
		expect(objectModelPath("move.motionSystems[].currentMove.filePosition", STABLE)).toMatchObject({ known: true, since: STABLE });
		expect(objectModelChanges(RC2, STABLE).map((c) => c.path)).toContain("move.motionSystems[].currentMove.filePosition");
	});

	it("move.motionSystems[].currentMove.laserPwm is not a path RRF ever served (it is under #if 0)", () => {
		for (const v of ["3.7.0-beta.1", RC2, STABLE]) expect(objectModelPath("move.motionSystems[].currentMove.laserPwm", v).known, v).toBe(false);
		expect(objectModelChanges(RC2, STABLE).map((c) => c.path)).not.toContain("move.motionSystems[].currentMove.laserPwm");
	});
});
