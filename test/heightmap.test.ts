import { describe, expect, it } from "vitest";

import { parseHeightMap } from "../src/files/heightmap.js";

describe("parseHeightMap — all three label-line versions (Grid.cpp's own HeightMapLabelLines)", () => {
	it("parses the current (v2, from 3.3-beta2) format, with axis letters in the data line", () => {
		const text = [
			"RepRapFirmware height map file v2 generated at 2026-09-14 10:00",
			"axis0,axis1,min0,max0,min1,max1,radius,spacing0,spacing1,num0,num1",
			"X,Y,-100.00,100.00,-100.00,100.00,-1.00,40.00,40.00,6,6",
			"0.010, 0.020, 0.030, 0, -0.010, 0.000",
			"0, 0, 0, 0, 0, 0",
			"0, 0, 0, 0, 0, 0",
			"0, 0, 0, 0, 0, 0",
			"0, 0, 0, 0, 0, 0",
			"0, 0, 0, 0, 0, 0",
			"",
		].join("\n");
		const r = parseHeightMap(text);
		expect(r.errors).toEqual([]);
		expect(r.map).toMatchObject({
			version: 2,
			grid: { axis0: "X", axis1: "Y", min0: -100, max0: 100, min1: -100, max1: 100, radius: -1, spacing0: 40, spacing1: 40, num0: 6, num1: 6 },
		});
		// A bare "0" is the "not probed" sentinel; "0.000" (has a decimal point) is a real reading.
		expect(r.map!.rows[0]).toEqual([0.01, 0.02, 0.03, null, -0.01, 0]);
		expect(r.map!.rows).toHaveLength(6);
	});

	it("parses the pre-3.3-beta2 (v1) format: no axis letters, separate x/y spacing", () => {
		const text = [
			"RepRapFirmware height map file v2",
			"xmin,xmax,ymin,ymax,radius,xspacing,yspacing,xnum,ynum",
			"-50.00,50.00,-50.00,50.00,-1.00,25.00,25.00,5,5",
			"0,0,0,0,0",
			"0,0.1,0.2,0.1,0",
			"0,0,0,0,0",
			"0,0,0,0,0",
			"0,0,0,0,0",
			"",
		].join("\n");
		const r = parseHeightMap(text);
		expect(r.errors).toEqual([]);
		expect(r.map).toMatchObject({
			version: 1,
			grid: { axis0: "X", axis1: "Y", min0: -50, max0: 50, min1: -50, max1: 50, spacing0: 25, spacing1: 25, num0: 5, num1: 5 },
		});
		expect(r.map!.rows[1]).toEqual([null, 0.1, 0.2, 0.1, null]);
	});

	it("parses the oldest (v0) format: no axis letters, ONE shared spacing for both axes", () => {
		const text = [
			"RepRapFirmware height map file v2",
			"xmin,xmax,ymin,ymax,radius,spacing,xnum,ynum",
			"-50.00,50.00,-50.00,50.00,-1.00,25.00,5,5",
			"0,0,0,0,0",
			"0,0,0,0,0",
			"0,0,0,0,0",
			"0,0,0,0,0",
			"0,0,0,0,0",
			"",
		].join("\n");
		const r = parseHeightMap(text);
		expect(r.errors).toEqual([]);
		expect(r.map).toMatchObject({ version: 0, grid: { spacing0: 25, spacing1: 25, num0: 5, num1: 5 } });
	});
});

describe("parseHeightMap — each loader error (HeightMap::LoadFromFile)", () => {
	it("rejects a missing or wrong header line", () => {
		expect(parseHeightMap("").errors).toEqual([{ message: "bad header line or wrong version header", line: 1 }]);
		expect(parseHeightMap("not a height map\n").errors[0].message).toBe("bad header line or wrong version header");
	});

	it("accepts a header line with extra trailing text (RRF checks with a starts-with, not exact match)", () => {
		const text = [
			"RepRapFirmware height map file v2 generated at some point",
			"axis0,axis1,min0,max0,min1,max1,radius,spacing0,spacing1,num0,num1",
			"X,Y,0,1,0,1,-1,1,1,2,1",
			"0,0",
			"",
		].join("\n");
		expect(parseHeightMap(text).errors).toEqual([]);
	});

	it("rejects an unrecognised label line", () => {
		const text = "RepRapFirmware height map file v2\nnot a real label line\n";
		expect(parseHeightMap(text).errors).toEqual([{ message: "bad label line", line: 2 }]);
	});

	it("rejects a malformed parameters line", () => {
		const text = [
			"RepRapFirmware height map file v2",
			"axis0,axis1,min0,max0,min1,max1,radius,spacing0,spacing1,num0,num1",
			"not,valid,params",
			"",
		].join("\n");
		expect(parseHeightMap(text).errors).toEqual([{ message: "failed to parse grid parameters", line: 3 }]);
	});

	it("reports a missing data row", () => {
		// No trailing newline - line 5 (the second of two expected rows) is genuinely absent, not an
		// empty string (which a real trailing blank line would parse as its own, different failure).
		const text = [
			"RepRapFirmware height map file v2",
			"axis0,axis1,min0,max0,min1,max1,radius,spacing0,spacing1,num0,num1",
			"X,Y,0,1,0,1,-1,1,1,2,2",
			"0,0",
		].join("\n");
		expect(parseHeightMap(text).errors).toEqual([{ message: "failed to read line from file", line: 5 }]);
	});

	it("reports a malformed number in a data row, with RRF's own row/column numbering", () => {
		const text = [
			"RepRapFirmware height map file v2",
			"axis0,axis1,min0,max0,min1,max1,radius,spacing0,spacing1,num0,num1",
			"X,Y,0,1,0,1,-1,1,1,2,1",
			"0,notanumber",
			"",
		].join("\n");
		expect(parseHeightMap(text).errors).toEqual([{ message: "number expected at line 4 column 3", line: 4 }]);
	});

	it("returns a null map whenever there are errors", () => {
		expect(parseHeightMap("nope").map).toBeNull();
	});
});
