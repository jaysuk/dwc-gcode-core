import { describe, expect, it } from "vitest";

import { readToolTemperatureSetting } from "../src/commands/g10.js";
import { paramNumber, paramNumberList, parseParams } from "../src/params.js";

// A parameter letter with no value is not zero. RRF 3.7.0-beta.3+ reads `M116 P` as "wait for all
// tools" (GCodes2.cpp case 116: GetUnsignedArray returns no elements), and `M84 X Y E` names axes
// without giving any number. `Number("")` is 0, so reading these as numbers used to yield tool 0,
// temperature 0 — and a tool-renumbering pass would rewrite `M116 P` into `M116 P2`.
describe("a parameter present without a value", () => {
	it("has no numeric value", () => {
		expect(paramNumber(parseParams("M116 P"), "P")).toBeNull();
		expect(paramNumber(parseParams("M84 X Y E"), "Y")).toBeNull();
	});

	it("has no list elements", () => {
		expect(paramNumberList(parseParams("M116 P"), "P")).toEqual([]);
		expect(paramNumberList(parseParams("G10 P0 S R150"), "S")).toEqual([]);
	});

	it("is still present, so presence checks keep working", () => {
		const s = readToolTemperatureSetting("G10", "G10 P0 S");
		expect(s).not.toBeNull();
		expect(s!.setsTemperatures).toBe(true);
		expect(s!.active).toEqual([]);
	});

	it("does not stop an empty element in a list from being dropped on its own", () => {
		// `S200::180` has an empty middle element; the two real temperatures survive
		expect(paramNumberList(parseParams("G10 P0 S200::180"), "S")).toEqual([200, 180]);
	});
});
