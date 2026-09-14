/**
 * `heightmap.csv` (`FileKind: "height-map"`) — read end to end from RRF `3.7.0-rc.1`
 * `src/Movement/BedProbing/Grid.cpp`/`.h`. Never written by this package (task 09's stamp rules:
 * this file's own loader requires an exact first line, so a stamp would break it — verified here by
 * reading `HeightMap::LoadFromFile` directly, not assumed).
 *
 * File structure, all confirmed directly in `LoadFromFile` (not inferred):
 * 1. A line starting with `HeightMapComment` (`"RepRapFirmware height map file v2"`, `Grid.h:115`) —
 *    checked with a starts-with, not an exact match, so a trailing date/comment is fine.
 * 2. A label line, checked against `GridDefinition::HeightMapLabelLines` (`Grid.cpp:72-77`) with the
 *    same starts-with rule; WHICH of the three it matches determines `version` (0, 1 or 2), which
 *    then determines how line 3 is read - see `GridDefinition::ReadParameters` (`Grid.cpp:183-273`):
 *      v0 (old):              min0,max0,min1,max1,radius,spacing,num0,num1        (spacing shared)
 *      v1 (until 3.3-beta1):  min0,max0,min1,max1,radius,spacing0,spacing1,num0,num1
 *      v2 (from 3.3-beta2):   axis0,axis1,min0,max0,min1,max1,radius,spacing0,spacing1,num0,num1
 *    v0/v1 have no axis letters in the data line at all (RRF defaults them to X/Y).
 * 3. `num1` more lines, each `num0` comma-separated values (arbitrary surrounding space/tab
 *    tolerated per value): a bare `0` with nothing but a comma or end-of-line right after it means
 *    "not probed" (`null` here) — this is only a special case because it has no decimal point; an
 *    actual zero-height reading is always written as `0.0` and parses as a real number. Anything
 *    else must parse as a float, or RRF reports "number expected at line R column C" - reproduced
 *    with the same row/column numbering (`row + 3`, 1-based column).
 *
 * Deliberately does NOT reproduce `GridDefinition::CheckValidity`'s full validity check (spacing/
 * range minimums, `MaxGridProbePoints`, and whether the axis letters are actually configured on the
 * target machine) - that needs machine configuration this package doesn't have access to. A
 * structurally well-formed file with an out-of-range grid still parses here; task 14 (diagnostics)
 * is the right place for that check once the object model is available (task 11).
 *
 * One real difference from RRF's own reader, worth knowing about: this parses a plain JS
 * line-split, which can't distinguish "past end of file" from "an empty line that happens to sit at
 * that position" the way `FileStore::ReadLine`'s length return can. In practice this only matters
 * for a truncated/corrupt file, and it still fails with an error either way (just possibly a
 * "number expected" one at that position rather than "failed to read line from file") - never a
 * successful, wrongly-parsed grid.
 */

export interface HeightMapGrid {
	axis0: string; axis1: string;
	min0: number; max0: number; min1: number; max1: number;
	radius: number; spacing0: number; spacing1: number;
	num0: number; num1: number;
}

export interface HeightMap {
	version: number;
	grid: HeightMapGrid;
	rows: ReadonlyArray<ReadonlyArray<number | null>>;
}

export interface HeightMapError { message: string; line: number }

const HEIGHT_MAP_COMMENT = "RepRapFirmware height map file v2";

/** `GridDefinition::HeightMapLabelLines` (`Grid.cpp:72-77`), verbatim - index is the format version. */
const LABEL_LINES: ReadonlyArray<string> = [
	"xmin,xmax,ymin,ymax,radius,spacing,xnum,ynum",
	"xmin,xmax,ymin,ymax,radius,xspacing,yspacing,xnum,ynum",
	"axis0,axis1,min0,max0,min1,max1,radius,spacing0,spacing1,num0,num1",
];

function parseFloatField(text: string, start: number): { value: number; next: number } | null {
	const m = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(text.slice(start));
	if (m === null || m[0].length === 0) return null;
	return { value: Number(m[0]), next: start + m[0].length };
}

function parseUintField(text: string, start: number): { value: number; next: number } | null {
	const m = /^\d+/.exec(text.slice(start));
	if (m === null) return null;
	return { value: Number(m[0]), next: start + m[0].length };
}

/** `GridDefinition::ReadParameters` (`Grid.cpp:183-273`) — the exact field layout per version. */
function readParameters(line: string, version: number): HeightMapGrid | null {
	let pos = 0;
	let axis0 = "X";
	let axis1 = "Y";
	if (version >= 2) {
		if (line[0] === undefined || line[1] !== ",") return null;
		axis0 = line[0];
		pos = 2;
		if (line[pos + 1] !== ",") return null;
		axis1 = line[pos];
		pos += 2;
	}

	const min0 = parseFloatField(line, pos);
	if (min0 === null || line[min0.next] !== ",") return null;
	const max0 = parseFloatField(line, min0.next + 1);
	if (max0 === null || line[max0.next] !== ",") return null;
	const min1 = parseFloatField(line, max0.next + 1);
	if (min1 === null || line[min1.next] !== ",") return null;
	const max1 = parseFloatField(line, min1.next + 1);
	if (max1 === null || line[max1.next] !== ",") return null;
	const radius = parseFloatField(line, max1.next + 1);
	if (radius === null || line[radius.next] !== ",") return null;
	const spacing0 = parseFloatField(line, radius.next + 1);
	if (spacing0 === null || line[spacing0.next] !== ",") return null;

	let spacing1: number;
	let afterSpacings: number;
	if (version === 0) {
		spacing1 = spacing0.value;
		afterSpacings = spacing0.next;
	} else {
		const s1 = parseFloatField(line, spacing0.next + 1);
		if (s1 === null || line[s1.next] !== ",") return null;
		spacing1 = s1.value;
		afterSpacings = s1.next;
	}

	const num0 = parseUintField(line, afterSpacings + 1);
	if (num0 === null || line[num0.next] !== ",") return null;
	const num1 = parseUintField(line, num0.next + 1);
	if (num1 === null) return null;

	return {
		axis0, axis1,
		min0: min0.value, max0: max0.value, min1: min1.value, max1: max1.value,
		radius: radius.value, spacing0: spacing0.value, spacing1,
		num0: num0.value, num1: num1.value,
	};
}

/** One data row: `num0` comma-separated values, leading space/tab tolerated before each. A bare `0`
 *  immediately followed by `,` or end-of-line is the "not probed" sentinel (`null`); anything else
 *  must parse as a float. Returns `null` and appends to `errors` on the first malformed value,
 *  matching RRF's own "number expected at line R column C" (`Grid.cpp`'s `LoadFromFile` row loop). */
function parseRow(line: string, num0: number, lineNumber: number, errors: Array<HeightMapError>): Array<number | null> | null {
	const values: Array<number | null> = [];
	let pos = 0;
	for (let col = 0; col < num0; col++) {
		while (line[pos] === " " || line[pos] === "\t") pos++;
		if (line[pos] === "0" && (line[pos + 1] === "," || line[pos + 1] === undefined)) {
			values.push(null);
			pos++;
		} else {
			const f = parseFloatField(line, pos);
			if (f === null) {
				errors.push({ message: `number expected at line ${lineNumber} column ${pos + 1}`, line: lineNumber });
				return null;
			}
			values.push(f.value);
			pos = f.next;
		}
		// Skip to (and past) the next comma, if any - RRF's own loop re-syncs on ',' between columns.
		while (line[pos] !== undefined && line[pos] !== ",") pos++;
		if (line[pos] === ",") pos++;
	}
	return values;
}

export function parseHeightMap(text: string): { map: HeightMap | null; errors: ReadonlyArray<HeightMapError> } {
	const lines = text.split(/\r\n|\r|\n/);
	const errors: Array<HeightMapError> = [];

	if (lines[0] === undefined || !lines[0].startsWith(HEIGHT_MAP_COMMENT)) {
		errors.push({ message: "bad header line or wrong version header", line: 1 });
		return { map: null, errors };
	}
	if (lines[1] === undefined) {
		errors.push({ message: "failed to read line from file", line: 2 });
		return { map: null, errors };
	}
	const version = LABEL_LINES.findIndex((l) => lines[1].startsWith(l));
	if (version === -1) {
		errors.push({ message: "bad label line", line: 2 });
		return { map: null, errors };
	}
	if (lines[2] === undefined) {
		errors.push({ message: "failed to read line from file", line: 3 });
		return { map: null, errors };
	}
	const grid = readParameters(lines[2], version);
	if (grid === null) {
		errors.push({ message: "failed to parse grid parameters", line: 3 });
		return { map: null, errors };
	}

	const rows: Array<ReadonlyArray<number | null>> = [];
	for (let r = 0; r < grid.num1; r++) {
		const lineIndex = 3 + r;
		if (lines[lineIndex] === undefined) {
			errors.push({ message: "failed to read line from file", line: lineIndex + 1 });
			return { map: null, errors };
		}
		const row = parseRow(lines[lineIndex], grid.num0, lineIndex + 1, errors);
		if (row === null) return { map: null, errors };
		rows.push(row);
	}

	return { map: { version, grid, rows }, errors: [] };
}
