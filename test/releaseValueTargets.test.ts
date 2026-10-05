import { describe, expect, it } from "vitest";

import { parseDocument } from "../src/document.js";
import { CHANGES } from "../src/releases/changes.js";
import { impactOf } from "../src/releases/impact.js";
import { targetKey } from "../src/releases/schema.js";

/**
 * `whenValue` narrows a parameter target to one accepted VALUE (`M558 P3`). The catalogue knew the probe type had
 * gone (M558's P description says so) but nothing matched the line, so a scan reported nothing for the most common
 * kind of break: a config that still names something the new firmware rejects.
 */
const ids = (text: string, from: string, to: string): Array<string> => impactOf(parseDocument(text), from, to).map((f) => f.event.id);

describe("whenValue parameter targets", () => {
	it("flags M558 P3 on the way to rc.1, and only that type", () => {
		expect(ids("M558 P3 C\"zprobe.in\" H5\n", "3.6.3", "3.7.0-rc.1")).toContain("m558-p3-removed");
		for (const other of ["M558 P5 C\"zprobe.in\" H5\n", "M558 P8 C\"zprobe.in\" H5\n", "M558 P1 C\"zprobe.in\" H5\n", "M558 P13 C\"x\"\n", "M558 P30 C\"x\"\n", "M558 P C\"x\"\n"]) {
			expect(ids(other, "3.6.3", "3.7.0-rc.1"), other).not.toContain("m558-p3-removed");
		}
	});

	it("compares a number as a number (03 and 3.0 are type 3; 3.5 is not)", () => {
		expect(ids("M558 P03 C\"x\"\n", "3.6.3", "3.7.0-rc.1")).toContain("m558-p3-removed");
		expect(ids("M558 P3.0 C\"x\"\n", "3.6.3", "3.7.0-rc.1")).toContain("m558-p3-removed");
		expect(ids("M558 P3.5 C\"x\"\n", "3.6.3", "3.7.0-rc.1")).not.toContain("m558-p3-removed");
	});

	it("never claims a value it cannot read: an expression is not flagged", () => {
		expect(ids("M558 P{global.probeType} C\"x\"\n", "3.6.3", "3.7.0-rc.1")).not.toContain("m558-p3-removed");
	});

	it("puts the squiggle on the parameter, not the whole line", () => {
		const text = "M558 P3 C\"zprobe.in\" H5\n";
		const hit = impactOf(parseDocument(text), "3.6.3", "3.7.0-rc.1").find((f) => f.event.id === "m558-p3-removed")!;
		expect(text.slice(hit.start, hit.end)).toBe("P3");
	});

	it("matches a quoted string value without its quotes, case-insensitively (M308 Y)", () => {
		expect(ids("M308 S4 Y\"bme68x\" P\"spi.cs3\"\n", "3.6.3", "3.7.0-alpha.3")).toContain("m308-bme68x-added");
		expect(ids("M308 S4 Y\"BME68X\" P\"spi.cs3\"\n", "3.6.3", "3.7.0-alpha.3")).toContain("m308-bme68x-added");
		expect(ids("M308 S4 Y\"bme280\" P\"spi.cs3\"\n", "3.6.3", "3.7.0-alpha.3")).not.toContain("m308-bme68x-added");
		expect(ids("M308 S0 Y\"thermistor\" P\"temp0\"\n", "3.6.3", "3.7.0-alpha.3")).not.toContain("m308-bme68x-added");
	});

	it("an added value matters only when going back: a 3.6.3 board cannot use P12 or S5", () => {
		const down = impactOf(parseDocument("M558 P12 C\"x\" V-0.002\nM574 X1 S5\n"), "3.7.0-rc.2", "3.6.3");
		const byId = new Map(down.map((f) => [f.event.id, f.direction]));
		expect(byId.get("m558-p12-load-cell")).toBe("downgrade");
		expect(byId.get("m574-s5-encoder-endstop")).toBe("downgrade");
		expect(ids("M558 P12 C\"x\" V-0.002\nM574 X1 S5\n", "3.6.3", "3.7.0-rc.2").filter((id) => id === "m558-p12-load-cell" || id === "m574-s5-encoder-endstop").length).toBe(2);
	});

	it("does not flag other M574 endstop types", () => {
		for (const s of ["S1", "S3", "S4", "S2"]) expect(ids(`M574 X1 ${s} P"io1.in"\n`, "3.6.3", "3.7.0-rc.2"), s).not.toContain("m574-s5-encoder-endstop");
	});

	it("keeps a value-specific event apart from the letter's own event (different target keys)", () => {
		expect(targetKey({ type: "parameter", code: "M558", letter: "P", whenValue: ["3"] })).not.toBe(targetKey({ type: "parameter", code: "M558", letter: "P" }));
		expect(targetKey({ type: "parameter", code: "M558", letter: "P", whenValue: ["3"] })).not.toBe(targetKey({ type: "parameter", code: "M558", letter: "P", whenValue: ["12"] }));
		// The order and case in the list are not a different fact.
		expect(targetKey({ type: "parameter", code: "M308", letter: "Y", whenValue: ["B", "a"] })).toBe(targetKey({ type: "parameter", code: "M308", letter: "Y", whenValue: ["A", "b"] }));
	});

	it("every shipped whenValue event says which value in its description and cites a source", () => {
		const valued = CHANGES.filter((e) => e.target.type === "parameter" && e.target.whenValue !== undefined);
		expect(valued.map((e) => e.id).sort()).toEqual(["m308-bme68x-added", "m472-r1-recursive-delete-nested", "m558-p12-load-cell", "m558-p3-removed", "m574-s5-encoder-endstop", "m586-t-tls-listener", "m593-mzv-amplitudes-corrected", "m669-five-bar-own-kinematics-type", "m669-hangprinter-anchor-count-8", "m950-j-filament-monitor-input", "m950-j-probe-input", "m950-led-k-honoured-for-neopixel", "m997-s3-wifi-external-removed"]);
		for (const e of valued) expect(e.sources.length, e.id).toBeGreaterThan(0);
	});
});
