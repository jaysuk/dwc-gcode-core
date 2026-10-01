import { describe, expect, it } from "vitest";

import { parseDocument } from "../src/document.js";
import { CHANGES } from "../src/releases/changes.js";
import { impactOf } from "../src/releases/impact.js";

/**
 * Events found by reading the "by-note" triage commits line by line (docs/rrf-triage/d3-line-by-line.md). Each one is pinned to the
 * first tracked release that contains its commit, so the window (from, to] is exact.
 */
const ids = (text: string, from: string, to: string): Array<string> => impactOf(parseDocument(text), from, to).map((f) => f.event.id);

describe("boards[0].firmwareDate carries the time from beta.2", () => {
	const macro = "if {boards[0].firmwareDate} = \"2024-11-12\"\n  echo \"old\"\n";
	it("flags a macro that reads it when upgrading across beta.2, and not outside that window", () => {
		expect(ids(macro, "3.6.3", "3.7.0-beta.2")).toContain("om-boards-firmware-date-includes-time");
		expect(ids(macro, "3.7.0-beta.1", "3.7.0-beta.2")).toContain("om-boards-firmware-date-includes-time");
		expect(ids(macro, "3.7.0-beta.2", "3.7.0-rc.2")).not.toContain("om-boards-firmware-date-includes-time");
		expect(ids(macro, "3.6.3", "3.7.0-beta.1")).not.toContain("om-boards-firmware-date-includes-time");
	});

	it("does not flag a macro that reads some other board field", () => {
		expect(ids("echo {boards[0].firmwareVersion}\n", "3.6.3", "3.7.0-rc.2")).not.toContain("om-boards-firmware-date-includes-time");
	});

	it("cites both ends of the change", () => {
		const e = CHANGES.find((c) => c.id === "om-boards-firmware-date-includes-time")!;
		expect(e.sources.some((s) => s.includes("684e8e097"))).toBe(true);
		expect(e.sources.some((s) => s.includes("3.6.3"))).toBe(true);
	});
});

describe("M116 (RRF #1240, first in 3.7.0-beta.2+1)", () => {
	it("a colon-list P is flagged going up and going down, and only across beta.2+1", () => {
		expect(ids("M116 P0:1\n", "3.7.0-beta.2", "3.7.0-beta.2+1")).toContain("m116-p-colon-list");
		expect(ids("M116 P0:1\n", "3.6.3", "3.7.0-rc.2")).toContain("m116-p-colon-list");
		expect(ids("M116 P0:1\n", "3.7.0-rc.2", "3.6.3")).toContain("m116-p-colon-list");
		expect(ids("M116 P0:1\n", "3.7.0-beta.2+1", "3.7.0-rc.2")).not.toContain("m116-p-colon-list");
	});

	it("the bare form is flagged only when nothing else says what to wait for", () => {
		for (const text of ["M116\n", "M116 S5\n"]) {
			expect(ids(text, "3.6.3", "3.7.0-rc.2"), text).toContain("m116-bare-waits-for-all-tools");
			expect(ids(text, "3.7.0-beta.2", "3.7.0-beta.2+1"), text).toContain("m116-bare-waits-for-all-tools");
			expect(ids(text, "3.7.0-beta.2+1", "3.7.0-rc.2"), text).not.toContain("m116-bare-waits-for-all-tools");
		}
	});

	it("a macro that names a tool, heater or chamber keeps its meaning", () => {
		for (const text of ["M116 P1\n", "M116 H1\n", "M116 C0\n"]) expect(ids(text, "3.6.3", "3.7.0-rc.2"), text).not.toContain("m116-bare-waits-for-all-tools");
	});
});

describe("M950 J virtual inputs (filament monitor from beta.2+1, Z probe from beta.3)", () => {
	it("flags the filament-monitor form only when going back past beta.2+1, with the ! invert too", () => {
		for (const text of ["M950 J1 C\"fm0.switch\"\n", "M950 J2 C\"!fm1.motion\"\n"]) {
			expect(ids(text, "3.7.0-rc.2", "3.7.0-beta.2"), text).toContain("m950-j-filament-monitor-input");
			expect(ids(text, "3.7.0-rc.2", "3.7.0-beta.2+1"), text).not.toContain("m950-j-filament-monitor-input");
		}
	});

	it("flags the probe form only when going back past beta.3", () => {
		expect(ids("M950 J3 C\"probe0\"\n", "3.7.0-rc.2", "3.7.0-beta.2+1")).toContain("m950-j-probe-input");
		expect(ids("M950 J3 C\"!probe1\"\n", "3.7.0-rc.2", "3.7.0-beta.3")).not.toContain("m950-j-probe-input");
	});

	it("leaves ordinary pin names alone and does not read a prefix as a name", () => {
		for (const text of ["M950 J1 C\"io3.in\"\n", "M950 J1 C\"^io3.in\"\n", "M950 F0 C\"out1\"\n", "M950 J1 C\"fan0\"\n"]) {
			const found = ids(text, "3.7.0-rc.2", "3.6.3");
			expect(found, text).not.toContain("m950-j-filament-monitor-input");
			expect(found, text).not.toContain("m950-j-probe-input");
		}
	});
});

describe("M221 fast extrusion-factor change (first in 3.7.0-rc.1)", () => {
	it("flags M221 on the way across rc.1 in either direction and not outside it", () => {
		expect(ids("M221 S110\n", "3.7.0-beta.3+1", "3.7.0-rc.1")).toContain("m221-rescales-queued-moves");
		expect(ids("M221 S110\n", "3.6.3", "3.7.0-rc.2")).toContain("m221-rescales-queued-moves");
		expect(ids("M221 S110\n", "3.7.0-rc.2", "3.6.3")).toContain("m221-rescales-queued-moves");
		expect(ids("M221 S110\n", "3.7.0-rc.1", "3.7.0-rc.2")).not.toContain("m221-rescales-queued-moves");
	});

	it("leaves the neighbouring commands alone", () => {
		for (const text of ["M220 S110\n", "M222 S1\n", "G1 X10 E1\n"]) expect(ids(text, "3.6.3", "3.7.0-rc.2"), text).not.toContain("m221-rescales-queued-moves");
	});
});
