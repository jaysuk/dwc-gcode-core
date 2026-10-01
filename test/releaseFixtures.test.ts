import { describe, expect, it } from "vitest";

import { parseDocument } from "../src/document.js";
import { CHANGES } from "../src/releases/changes.js";
import { impactOf } from "../src/releases/impact.js";
import { RELEASES } from "../src/releases/releases.js";

/**
 * One real-file fixture per release that has a hand-written, detectable event: a config.g / macro snippet that uses
 * what changed THERE, and the exact events it must raise crossing that release in each direction. Together with the
 * partition property (`releaseScan.test.ts`) this holds "for any pair of releases, exactly what changed between them"
 * to something a person can read. Every id below was pinned by `scripts/audit-releases.mjs --events` against RRF's
 * git history, so a re-pin that moves an event to a different release fails here.
 */
interface Fixture {
	release: string;
	file: string;
	text: string;
	/** Event ids the snippet must raise when the range ENDS at `release` from its predecessor (and the reverse). */
	ids: ReadonlyArray<string>;
	/** True for a `whenAbsent: "upgrade"` event: a line without the parameter is a problem only moving TO the release. */
	upgradeOnly?: true;
	/** True when a LATER event about the same target supersedes it over the whole window (`collapseSuperseded`). */
	supersededLater?: true;
}

const FIXTURES: ReadonlyArray<Fixture> = [
	{ release: "3.7.0-alpha.3", file: "0:/sys/config.g", ids: ["m308-bme68x-added"], text: "M308 S4 Y\"bme68x\" P\"spi.cs3\" A\"Enclosure\"\n" },
	{ release: "3.7.0-beta.3", file: "0:/sys/config.g", ids: ["m558-p12-load-cell"], text: "M558 P12 C\"123.io0.in\" V-0.002 F300 H5\n" },
	{ release: "3.7.0-rc.1", file: "0:/sys/config.g", ids: ["m558-p3-removed"], text: "M558 P3 C\"zprobe.in+zprobe.mod\" H5 F120 T6000\n" },
	{ release: "3.7.0-rc.1", file: "0:/sys/config.g", ids: ["m574-s5-encoder-endstop"], text: "M574 X1 S5\n" },
	{ release: "3.7.0-alpha.2", file: "0:/macros/status.g", ids: ["expr-array-literal", "m408-removed"], text: "M408 S0\nset global.tools = {0, 1}\n" },
	{ release: "3.7.0-alpha.2", file: "0:/sys/config.g", ids: ["m575-p-channel-numbering", "aux-port-numbering-m260-1"], text: "M575 P1 B57600 S1\nM260.1 P2 A1 R1 B1\n" },
	{ release: "3.7.0-alpha.3", file: "0:/sys/config.g", ids: ["m140-h-colon-list"], text: "M140 H0:1 S60\n" },
	{ release: "3.7.0-alpha.3", file: "0:/sys/config.g", ids: ["m563-h-rejects-bed-or-chamber-heater"], text: "M563 P0 D0 H0\n" },
	{ release: "3.7.0-alpha.4", file: "0:/macros/merge.g", ids: ["expr-array-concat"], text: "set var.all = var.a ^ var.b\n" },
	{ release: "3.7.0-alpha.6", file: "0:/sys/config.g", ids: ["m552-t-tristate"], text: "M552 S1 T-1\n" },
	{ release: "3.7.0-alpha.7", file: "0:/sys/config.g", ids: ["m301-removed", "m304-removed"], text: "M301 H1 P10 I0.1 D200\nM304 P1 I0.2\n" },
	{ release: "3.7.0-beta.2+1", file: "0:/sys/config.g", ids: ["m564-r-added"], text: "M564 S1 H1 R1\n" },
	{ release: "3.7.0-beta.2+1", file: "0:/macros/heat.g", ids: ["m116-p-colon-list"], text: "M116 P0:1\n" },
	{ release: "3.7.0-beta.2+1", file: "0:/macros/wait.g", ids: ["m116-bare-waits-for-all-tools"], text: "M104 T1 S150\nM116\n" },
	{ release: "3.7.0-beta.3", file: "0:/macros/probe.g", ids: ["m558-4-added"], text: "M558.4 P8\n" },
	{ release: "3.7.0-beta.3", file: "0:/macros/rotate.g", ids: ["g68-bare-reports-rotation"], text: "G68\n" },
	{ release: "3.7.0-rc.1", file: "0:/sys/config.g", ids: ["m955-single-accelerometer"], supersededLater: true, text: "M955 P0 C\"spi.cs1\" I5\n" },
	{ release: "3.7.0-rc.1", file: "0:/sys/config.g", ids: ["m574-k-range-checked"], text: "M574 Z1 S3 K1\n" },
	{ release: "3.7.0-rc.1", file: "0:/macros/drivers.g", ids: ["m569-2-bare-reports-waveform"], text: "M569.2 P0\n" },
	{ release: "3.7.0-rc.1+1", file: "0:/sys/config.g", ids: ["m955-p-uncapped"], text: "M955 P2 C\"spi.cs1\" I5\n" },
	{ release: "3.7.0-rc.1+1", file: "0:/sys/config.g", ids: ["m955-p-required", "m956-p-required"], upgradeOnly: true, text: "M955 C\"spi.cs1\" I5\nM956 S1000\n" },
	{ release: "3.7.0-rc.1+3", file: "0:/macros/tune.g", ids: ["m303-f-default"], text: "M303 H1 S200\n" },
	{ release: "3.7.0-rc.2", file: "0:/macros/clean.g", ids: ["m472-r1-recursive-delete-nested"], text: "M472 P\"0:/gcodes/old\" R1\n" },
	{ release: "3.7.0-rc.2", file: "0:/sys/config.g", ids: ["m201-t-warnings", "m569-c-more-chopconf-bits", "m970-can-expansion-boards"], text: "M201 T0.02\nM569 P0.0 C123456\nM970 P0 R2\n" },
];

/** Ids among `wanted` that `impactOf` raises for `text` moving `from` -> `to` (either order). */
function raised(text: string, from: string, to: string, wanted: ReadonlyArray<string>): Array<string> {
	const doc = parseDocument(text);
	const found = new Set(impactOf(doc, from, to).map((f) => f.event.id));
	return wanted.filter((id) => found.has(id));
}

const versions = RELEASES.map((r) => r.version);
const previous = (v: string): string => versions[versions.indexOf(v) - 1]!;
const next = (v: string): string | undefined => versions[versions.indexOf(v) + 1];

describe("real-file fixtures, one per release that has events", () => {
	for (const fx of FIXTURES) {
		const before = previous(fx.release);
		const after = next(fx.release);
		describe(fx.release, () => {
			it("names events that really sit at this release", () => {
				for (const id of fx.ids) expect(CHANGES.find((e) => e.id === id)?.version, id).toBe(fx.release);
			});

			it(`raises them on the way in (${before} -> ${fx.release}), as an upgrade`, () => {
				expect(raised(fx.text, before, fx.release, fx.ids)).toEqual(fx.ids);
				for (const f of impactOf(parseDocument(fx.text), before, fx.release)) if (fx.ids.includes(f.event.id)) expect(f.direction).toBe("upgrade");
			});

			it(`${fx.upgradeOnly === true ? "stays quiet" : "raises them"} on the way back (${fx.release} -> ${before}), as a downgrade`, () => {
				expect(raised(fx.text, fx.release, before, fx.ids)).toEqual(fx.upgradeOnly === true ? [] : fx.ids);
				for (const f of impactOf(parseDocument(fx.text), fx.release, before)) if (fx.ids.includes(f.event.id)) expect(f.direction).toBe("downgrade");
			});

			if (after !== undefined) {
				it(`is silent once already there (${fx.release} -> ${after}), and on the reverse`, () => {
					expect(raised(fx.text, fx.release, after, fx.ids)).toEqual([]);
					expect(raised(fx.text, after, fx.release, fx.ids)).toEqual([]);
				});
			}

			it(fx.supersededLater === true ? "is superseded by a later event over the whole window (only the newest word on the target is raised)" : "is still raised across the whole window", () => {
				expect(raised(fx.text, versions[0]!, versions[versions.length - 1]!, fx.ids).sort()).toEqual(fx.supersededLater === true ? [] : [...fx.ids].sort());
			});
		});
	}

	it("a fixture that predates the release raises nothing crossing it (M408 is gone by alpha.2, not re-flagged at rc.2)", () => {
		expect(raised("M408 S0\n", "3.7.0-rc.1", "3.7.0-rc.2", ["m408-removed"])).toEqual([]);
	});
});
