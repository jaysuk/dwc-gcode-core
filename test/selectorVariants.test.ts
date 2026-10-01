import { describe, expect, it } from "vitest";

import { diagnoseDocument } from "../src/diagnostics/diagnose.js";
import { COMMANDS } from "../src/dictionary/commands.js";
import { parseDocument } from "../src/document.js";
import { compareFirmwareVersions } from "../src/versionCompare.js";
import { CHANGES, changesBetween } from "../src/releases/changes.js";
import { impactOf } from "../src/releases/impact.js";
import { RELEASES } from "../src/releases/releases.js";
import { targetKey } from "../src/releases/schema.js";

/**
 * `CommandSpec.selectorVariants` (M669: the kinematics type K picks which letters follow) and the two event-target
 * conditions that go with it (`whenCompanion`, `whenElements`). Every letter below was read in each kinematics'
 * `Configure` at rc.2 and hashed at all 18 tracked builds (`docs/dictionary-param-history/`); only Hangprinter (beta.2)
 * and the five-bar SCARA (rc.2) ever changed.
 */
const RC2 = "3.7.0-rc.2";
const dict = (text: string, firmwareVersion = RC2): Array<string> =>
	diagnoseDocument(parseDocument(text), "0:/sys/config.g", { firmwareVersion })
		.filter((d) => d.rule.startsWith("dictionary/"))
		.map((d) => `${d.rule}: ${d.message}`);
const ids = (text: string, from: string, to: string): Array<string> => impactOf(parseDocument(text), from, to).map((f) => f.event.id);

const HANGPRINTER = "M669 K6 N4 A0:-2000:-100 B2000:1000:-100 C-2000:1000:-100 D0:0:3000 P1500\n";

describe("M669 is judged against the kinematics type K selects", () => {
	it("a well-formed line of each type draws nothing at rc.2", () => {
		for (const line of [
			HANGPRINTER,
			"M669 K6 N6 A0:-2000:-100 B2000:1000:-100 C-2000:1000:-100 D0:0:3000 I0:0:3100 J0:0:3200 P1500\n",
			"M669 K4 P200 D150 X0 Y0 A-30:120 B-130:130 C0:0:0 R50 S100 T0.5\n",
			"M669 K7 R0:300 H0 A8000 F1000 S100 T0.5\n",
			"M669 K9 X-100:100 Y0:0 P150:150 D200:200 L1 B20:10 A15:165:0:360:0:360 C10:170:10:170 Z-50:-50:50:50\n",
			"M669 K10 U200 L400:400:400 H100 A-10:80 R120 B100 X0 Y0 Z0\n",
			"M669 K3 X100:-100 Y100:-100\n",
			"M669 K1 X1:1:0 Y1:-1:0 Z0:0:1 S100 T0.5\n",
			"M669 K11 X1:0:0 Y0:1:0 Z0:0:1\n",
		]) {
			expect(dict(line), line).toEqual([]);
		}
	});

	it("a letter another type reads is unknown for this one, and the message names the type", () => {
		expect(dict("M669 K4 N5 P200 D150\n")).toEqual(["dictionary/unknown-parameter: M669 doesn't have a N parameter for Serial SCARA (K4)"]);
		expect(dict("M669 K6 Q1\n")).toEqual(["dictionary/unknown-parameter: M669 doesn't have a Q parameter for Hangprinter (K6)"]);
		expect(dict("M669 K3 Q1\n")[0]).toContain("for Linear delta (K3)");
		// Z is a SCARA-less letter but a rotary delta and five-bar one; the polar type has none of them.
		expect(dict("M669 K7 Z1\n")[0]).toContain("for Polar (K7)");
	});

	it("the Core types accept any axis letter (motor factors), the others do not", () => {
		expect(dict("M669 K1 X1:1:0 Y1:-1:0 Z0:0:1 U0:0:0\n")).toEqual([]);
		expect(dict("M669 K0 W0:0:0\n")).toEqual([]);
		expect(dict("M669 K10 W1\n")[0]).toContain("for Rotary delta (K10)");
	});

	it("without a literal K the active type decides, so nothing is flagged (the old catch-all)", () => {
		for (const line of ["M669 N5\n", "M669 Q1 X1:1:0\n", "M669 K{global.kin} N5\n", "M669 K12 N5\n", "M669 K Q1\n"]) {
			expect(dict(line).filter((d) => d.startsWith("dictionary/unknown-parameter")), line).toEqual([]);
		}
	});

	it("checks a variant letter's shape: list length, value set", () => {
		expect(dict("M669 K9 X-100:100 Y0:0 P150:150 D200\n")).toEqual(["dictionary/value-out-of-range: M669's D takes 2 or 4 colon-separated value(s), not 1"]);
		expect(dict("M669 K9 X-100:100 Y0:0 P150:150 D1:2:3\n")[0]).toContain("takes 2 or 4");
		expect(dict("M669 K9 X-100:100 Y0:0 P150:150 D1:2 L3\n")[0]).toContain("isn't one of 1/2/4");
		expect(dict("M669 K9 X100 Y0:0 P150:150 D1:2\n")[0]).toContain("X takes 2 colon-separated");
		expect(dict("M669 K4 A-30:120:5 P1 D1\n")[0]).toContain("A takes 2 colon-separated");
		expect(dict("M669 K10 U1:2 L1 H1\n")[0]).toContain("U takes 1 or 3");
	});

	it("dates a variant letter: J, L and O of a Hangprinter are not read before beta.2", () => {
		const line = "M669 K6 N6 A0:-2000:-100 B2000:1000:-100 C-2000:1000:-100 D0:0:3000 I0:0:3100 J0:0:3200\n";
		expect(dict(line, "3.6.3")).toEqual(["dictionary/not-available-on-firmware: M669's J isn't available until RRF 3.7.0-beta.2"]);
		expect(dict(line, "3.7.0-beta.1")).toHaveLength(1);
		expect(dict(line, "3.7.0-beta.2")).toEqual([]);
		// A..D and I existed all along.
		expect(dict(HANGPRINTER, "3.6.3")).toEqual([]);
	});

	it("only the selected variant's letters are dated: a rotary delta's L is not a Hangprinter L", () => {
		expect(dict("M669 K10 U200 L400 H100\n", "3.6.3")).toEqual([]);
	});
});

describe("whenCompanion and whenElements narrow a parameter event", () => {
	it("M669 K9 D with two values is flagged going to rc.2, with four or on another type or with no K it is not", () => {
		expect(ids("M669 K9 X-100:100 Y0:0 P150:150 D200:200\n", "3.6.3", RC2)).toContain("m669-five-bar-d-two-values");
		for (const text of [
			"M669 K9 X-100:100 Y0:0 P150:150 D200:200:10:10\n",
			"M669 K4 P200 D150\n",
			"M669 D200:200\n",
			"M669 K{global.k} D200:200\n",
			"M669 K9 X-100:100 Y0:0 P150:150 D{global.d}\n",
			"M669 K9 X-100:100 Y0:0 P150:150 D\n",
		]) {
			expect(ids(text, "3.6.3", RC2), text).not.toContain("m669-five-bar-d-two-values");
		}
	});

	it("matches the selector as a number and puts the squiggle on the parameter", () => {
		const text = "M669 K09 X-100:100 Y0:0 P150:150 D200:200\n";
		const hit = impactOf(parseDocument(text), "3.6.3", RC2).find((f) => f.event.id === "m669-five-bar-d-two-values")!;
		expect(hit).toBeDefined();
		expect(text.slice(hit.start, hit.end)).toBe("D200:200");
	});

	it("the five-bar type event is about K9 lines, not every M669 (a CoreXY or delta machine is not told about it)", () => {
		expect(ids("M669 K9 X-100:100 Y0:0 P150:150 D200:200 S100 T0.5\n", "3.7.0-rc.1", RC2)).toContain("m669-five-bar-own-kinematics-type");
		for (const text of ["M669 K1 X1:1:0 Y1:-1:0 Z0:0:1\n", "M669 K3 X10:20\n", "M669 K4 P200 D150\n", "M669\n", "M669 S100 T0.5\n"]) {
			expect(ids(text, "3.7.0-rc.1", RC2), text).not.toContain("m669-five-bar-own-kinematics-type");
		}
	});

	it("the two-value form is a problem going BACK to 3.6.3", () => {
		const down = impactOf(parseDocument("M669 K9 X-100:100 Y0:0 P150:150 D200:200\n"), RC2, "3.6.3").find((f) => f.event.id === "m669-five-bar-d-two-values");
		expect(down?.direction).toBe("downgrade");
		// ...and nothing before rc.2 knew the difference.
		expect(ids("M669 K9 X-100:100 Y0:0 P150:150 D200:200\n", "3.6.3", "3.7.0-rc.1")).not.toContain("m669-five-bar-d-two-values");
	});

	it("Hangprinter anchors: N6-N8 and the J/L/O letters, and no one else", () => {
		const six = "M669 K6 N6 A0:-2000:-100 B2000:1000:-100 C-2000:1000:-100 D0:0:3000 I0:0:3100 J0:0:3200\n";
		expect(ids(six, "3.6.3", "3.7.0-beta.2")).toEqual(expect.arrayContaining(["m669-hangprinter-anchor-count-8", "dict-M669-K6-J-added"]));
		expect(ids(six, "3.7.0-beta.2", RC2).filter((id) => id.includes("hangprinter") || id.startsWith("dict-M669-K6"))).toEqual([]);
		for (const n of ["N5", "N4", "N", "N{global.n}"]) expect(ids(`M669 K6 ${n}\n`, "3.6.3", RC2), n).not.toContain("m669-hangprinter-anchor-count-8");
		expect(ids("M669 K6 N8\n", "3.6.3", RC2)).toContain("m669-hangprinter-anchor-count-8");
		// the same letters mean something else on a rotary delta / SCARA and must not draw Hangprinter events
		for (const text of ["M669 K10 U200 L400 H100\n", "M669 K4 P200 D150 L1\n", "M669 K6 L0:0:3300\n"]) {
			const found = ids(text, "3.6.3", RC2);
			expect(found.includes("dict-M669-K6-L-added"), text).toBe(text.startsWith("M669 K6"));
		}
	});

	it("M666 on a Hangprinter: W, F and P are matched, a delta's M666 draws none of it", () => {
		expect(ids("M666 W2.5 S20000\n", "3.6.3", "3.7.0-beta.2")).toContain("m666-hangprinter-flex-opt-in");
		expect(ids("M666 F1\n", "3.6.3", "3.7.0-beta.2")).toContain("m666-hangprinter-f-flex-algorithm-added");
		expect(ids("M666 P1\n", "3.6.3", "3.7.0-beta.2")).toContain("m666-hangprinter-p-ignore-pretension-added");
		for (const delta of ["M666 X-0.2 Y0.1 Z0 A0.5 B-0.5\n", "M666 B1\n"]) {
			const found = ids(delta, "3.6.3", RC2).filter((id) => id.startsWith("m666-hangprinter"));
			expect(found, delta).toEqual([]);
		}
	});

	it("is a different fact from the bare letter's own event (target keys differ, order and case do not matter)", () => {
		const bare = targetKey({ type: "parameter", code: "M669", letter: "D" });
		const nine = targetKey({ type: "parameter", code: "M669", letter: "D", whenCompanion: { letter: "K", values: ["9"] } });
		const two = targetKey({ type: "parameter", code: "M669", letter: "D", whenCompanion: { letter: "K", values: ["9"] }, whenElements: [2] });
		expect(new Set([bare, nine, two]).size).toBe(3);
		expect(targetKey({ type: "parameter", code: "M669", letter: "D", whenCompanion: { letter: "k", values: ["10", "9"] } }))
			.toBe(targetKey({ type: "parameter", code: "M669", letter: "D", whenCompanion: { letter: "K", values: ["9", "10"] } }));
		expect(targetKey({ type: "parameter", code: "M669", letter: "D", whenElements: [4, 2] })).toBe(targetKey({ type: "parameter", code: "M669", letter: "D", whenElements: [2, 4] }));
	});
});

describe("the generated events for a variant's since/until", () => {
	it("J, L and O of K6 each have one `added` event at beta.2 that names the selector", () => {
		for (const letter of ["J", "L", "O"]) {
			const event = CHANGES.find((e) => e.id === `dict-M669-K6-${letter}-added`);
			expect(event, letter).toBeDefined();
			expect(event!.version).toBe("3.7.0-beta.2");
			expect(event!.kind).toBe("added");
			expect(event!.target).toEqual({ type: "parameter", code: "M669", letter, whenCompanion: { letter: "K", values: ["6"] } });
			expect(event!.sources.length).toBeGreaterThan(0);
		}
		expect(changesBetween("3.6.3", "3.7.0-beta.2").map((e) => e.id)).toContain("dict-M669-K6-O-added");
	});

	it("every hand-written event for this work is in the window and cites a commit", () => {
		for (const id of ["m669-five-bar-d-two-values", "m669-hangprinter-anchor-count-8", "m666-hangprinter-flex-opt-in", "m666-hangprinter-f-flex-algorithm-added", "m666-hangprinter-p-ignore-pretension-added"]) {
			const e = CHANGES.find((x) => x.id === id);
			expect(e, id).toBeDefined();
			expect(RELEASES.some((r) => r.version === e!.version), id).toBe(true);
			expect(e!.sources.some((s) => /RRF commit [0-9a-f]{8,}/.test(s)), id).toBe(true);
		}
	});

	it("an event that names a companion names a letter the command lists; a generated one names the command's selector", () => {
		for (const e of CHANGES) {
			if (e.target.type !== "parameter" || e.target.whenCompanion === undefined) continue;
			const companion = e.target.whenCompanion;
			const spec = COMMANDS[e.target.code];
			expect(spec, e.id).toBeDefined();
			expect(spec!.parameters.some((p) => p.letter === companion.letter), `${e.id}: companion ${companion.letter}`).toBe(true);
			if (e.id.startsWith("dict-")) expect(spec!.selectorVariants?.selector, e.id).toBe(companion.letter);
		}
	});
});

describe("the M669 variants are well-formed and say what was read", () => {
	const spec = COMMANDS.M669!;
	const sv = spec.selectorVariants!;

	it("selector K is one of the command's own letters, every value is a number, no value is claimed twice", () => {
		expect(sv.selector).toBe("K");
		expect(spec.parameters.some((p) => p.letter === sv.selector)).toBe(true);
		const seen = new Set<number>();
		for (const v of sv.variants) {
			for (const value of v.values) {
				expect(Number.isInteger(Number(value)), value).toBe(true);
				expect(seen.has(Number(value)), `K${value} named by two variants`).toBe(false);
				seen.add(Number(value));
			}
			expect(v.sources.length, v.label).toBeGreaterThan(0);
		}
		// K0-K11 are the kinematics types RRF builds (KinematicsType, Kinematics::Create): every one is covered.
		expect([...seen].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
	});

	it("the letters per type are the ones each Configure reads at rc.2 (a changed list fails here, then in the source)", () => {
		const letters = (value: string): string => sv.variants.find((v) => v.values.includes(value))!.parameters.map((p) => p.letter).sort().join("");
		expect(letters("6")).toBe("ABCDIJLNOP");
		expect(letters("9")).toBe("ABCDLPXYZ");
		expect(letters("4")).toBe("ABCDPRXY");
		expect(letters("7")).toBe("AFHR");
		expect(letters("10")).toBe("ABHLRUXYZ");
		expect(letters("3")).toBe("XY");
		expect(letters("1")).toBe("");
		expect(sv.variants.find((v) => v.values.includes("1"))!.axisParameters).toBeDefined();
	});

	it("each variant parameter is cited to a Configure at a tracked tag, letters are unique within a variant", () => {
		for (const v of sv.variants) {
			const letters = v.parameters.map((p) => p.letter);
			expect(new Set(letters).size, v.label).toBe(letters.length);
			for (const p of v.parameters) {
				expect(p.letter, `${v.label} ${p.letter}`).toMatch(/^[A-Z]$/);
				expect(p.sources.length, `${v.label} ${p.letter}`).toBeGreaterThan(0);
				expect(p.sources.some((s) => /^RRF 3\.\d/.test(s) || /^RRF commit/.test(s)), `${v.label} ${p.letter}`).toBe(true);
				if (p.since !== undefined) {
					expect(RELEASES.some((r) => r.version === p.since), `${v.label} ${p.letter} since`).toBe(true);
					expect(compareFirmwareVersions(p.since, RELEASES[0]!.version), `${v.label} ${p.letter} since`).toBeGreaterThan(0);
				}
			}
		}
	});

	it("the only dated variant letters are the Hangprinter's J, L and O (beta.2)", () => {
		const dated = sv.variants.flatMap((v) => v.parameters.filter((p) => p.since !== undefined || p.until !== undefined).map((p) => `${v.values[0]}${p.letter}@${p.since}`));
		expect(dated.sort()).toEqual(["6J@3.7.0-beta.2", "6L@3.7.0-beta.2", "6O@3.7.0-beta.2"]);
	});
});
