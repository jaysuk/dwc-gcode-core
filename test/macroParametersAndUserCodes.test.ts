import { describe, expect, it } from "vitest";

import { parseDocument } from "../src/document.js";
import { loadProject, type ProjectFile } from "../src/project.js";
import { RRF_BASELINE } from "../src/rrf.js";
import { customCodesOf } from "../src/files/customCodes.js";
import { BOARD_PIN_TABLES } from "../src/pins/tables.js";
import { diagnoseDocument, diagnoseProject } from "../src/diagnostics/diagnose.js";
import type { Diagnostic, DiagnoseOptions } from "../src/diagnostics/schema.js";

// Regression tests for the 2026-09-28 reports: M98 with parameters, M671's X/Y/S, user-defined
// G/M codes (sys/M1234.g), and the STM32-only M569.9. Every one of these misfired before.

const OPTS: DiagnoseOptions = { firmwareVersion: RRF_BASELINE };

function diagsFor(text: string, ruleId: string, options: DiagnoseOptions = OPTS): ReadonlyArray<Diagnostic> {
	return diagnoseDocument(parseDocument(text), "test.g", options).filter((d) => d.rule === ruleId);
}

function projectDiagsFor(files: ReadonlyArray<ProjectFile>, ruleId: string, options: DiagnoseOptions = OPTS): ReadonlyArray<Diagnostic> {
	return diagnoseProject(loadProject(files), options).filter((d) => d.rule === ruleId);
}

describe("commands that hand their parameters to a macro (CommandSpec.macroParameters)", () => {
	it("M98 P\"macro.g\" with parameters is not flagged - they become param.<letter> in the macro", () => {
		const text = 'M98 P"macro.g" A1 B"text" C{1+2} S0.5 X-3\n';
		expect(diagsFor(text, "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor(text, "dictionary/wrong-kind")).toHaveLength(0);
	});

	it("M98's own R is still checked when there is no P (it isn't a macro call then), and passed through when there is", () => {
		expect(diagsFor("M98 R5\n", "dictionary/wrong-kind")).toHaveLength(1);
		expect(diagsFor('M98 P"macro.g" R5\n', "dictionary/wrong-kind")).toHaveLength(0);
	});

	it("M98 without P has no macro to pass anything to, so an unknown letter is still unknown", () => {
		expect(diagsFor("M98 A1 B2\n", "dictionary/unknown-parameter").map((d) => d.message)).toEqual([
			"M98 doesn't have a A parameter", "M98 doesn't have a B parameter",
		]);
	});

	it("G32 passes its parameters to bed.g", () => {
		expect(diagsFor("G32 S1 A2\n", "dictionary/unknown-parameter")).toHaveLength(0);
	});

	it("an unimplemented code the dictionary lists (M301, M900) takes any letters, since its macro defines them", () => {
		expect(diagsFor("M301 H1 P10 I0.1 D200\n", "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor("M900 K0.5 Z9\n", "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor("M900 Kabc\n", "dictionary/wrong-kind")).toHaveLength(0);
	});

	it("an ordinary command with no macroParameters is unaffected", () => {
		expect(diagsFor("G4 Q1\n", "dictionary/unknown-parameter")).toHaveLength(1);
	});

	it("does not register M98's macro parameters as project axes", () => {
		const project = loadProject([
			{ path: "0:/sys/config.g", text: 'M98 P"macro.g" A1 B2\n' },
			{ path: "0:/sys/macro.g", text: "; x\n" },
		]);
		expect(project.symbols.filter((s) => s.type === "axis")).toEqual([]);
	});

	it("records the macro M98 calls, parameters or not", () => {
		const project = loadProject([
			{ path: "0:/sys/config.g", text: 'M98 P"macro.g" A1 B2\n' },
			{ path: "0:/sys/macro.g", text: "; x\n" },
		]);
		expect(project.calls).toEqual([
			{ from: { file: "0:/sys/config.g", line: 0 }, to: "sys/macro.g", resolved: true, dynamic: false, via: "M98" },
		]);
	});
});

describe("M671 (Z leadscrew positions)", () => {
	it("takes X and Y coordinate lists and S, P and F", () => {
		expect(diagsFor("M671 X-100:100 Y0:0 S0.5\n", "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor("M671 X-10:10:0 Y-10:-10:20 P0.7 F0.8 S1\n", "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor("M671 X-100:100 Y0:0 S0.5\n", "dictionary/wrong-kind")).toHaveLength(0);
	});

	it("needs X and Y together, as RRF's own \"Specify 1, 2, 3 or 4 X and Y coordinates\" says", () => {
		const [d] = diagsFor("M671 X-100:100\n", "dictionary/missing-required");
		expect(d.message).toContain("Y");
		expect(diagsFor("M671 X1:2 Y1:2\n", "dictionary/missing-required")).toHaveLength(0);
		expect(diagsFor("M671 S0.5\n", "dictionary/missing-required")).toHaveLength(0); // tune with neither
		expect(diagsFor("M671\n", "dictionary/missing-required")).toHaveLength(0); // report
	});

	it("accepts at most four leadscrews (MaxLeadscrews)", () => {
		expect(diagsFor("M671 X0:1:2:3 Y0:1:2:3\n", "dictionary/value-out-of-range")).toHaveLength(0);
		expect(diagsFor("M671 X0:1:2:3:4 Y0:1:2:3:4\n", "dictionary/value-out-of-range")).toHaveLength(2);
	});

	it("still flags a letter RRF doesn't read", () => {
		expect(diagsFor("M671 X1:2 Y1:2 Q1\n", "dictionary/unknown-parameter")).toHaveLength(1);
	});
});

describe("M571 and M918 (were reviewed with empty parameter lists)", () => {
	it("M571's P and S are known", () => {
		expect(diagsFor("M571 P3 S0.5\n", "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor("M571 P-1\n", "dictionary/value-out-of-range")).toHaveLength(0);
		expect(diagsFor("M571 P-2\n", "dictionary/value-out-of-range")).toHaveLength(1);
	});

	it("M918's P, E, C, R and F are known, and P is one of the four controller types", () => {
		expect(diagsFor("M918 P1 E4 C200 R18 F1000000\n", "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor("M918 P2\n", "dictionary/value-out-of-range")).toHaveLength(0);
		expect(diagsFor("M918 P4\n", "dictionary/value-out-of-range")).toHaveLength(1);
	});
});

describe("user-defined G/M codes (DiagnoseOptions.customCodes, Project.customCodes)", () => {
	it("an unknown code is info, and says which macro RRF would look for", () => {
		const [d] = diagsFor("M1234 A1\n", "dictionary/unknown-command");
		expect(d.severity).toBe("info");
		expect(d.message).toContain("/sys/M1234.g");
	});

	it("is not reported when the caller lists its macro", () => {
		expect(diagsFor("M1234 A1\n", "dictionary/unknown-command", { ...OPTS, customCodes: ["M1234"] })).toHaveLength(0);
		expect(diagsFor("M1234 A1\n", "dictionary/unknown-command", { ...OPTS, customCodes: new Set(["M1234"]) })).toHaveLength(0);
	});

	it("takes a fractional code from a folder listing via customCodesOf", () => {
		const customCodes = customCodesOf(["config.g", "G38.9.g", "G1.1.g"]);
		expect(diagsFor("G1.1 X1\nG1.2 X1\n", "dictionary/unknown-command", { ...OPTS, customCodes })).toHaveLength(1); // only G1.2
	});

	it("listing a macro for one code does not hide another", () => {
		expect(diagsFor("M1235\n", "dictionary/unknown-command", { ...OPTS, customCodes: ["M1234"] })).toHaveLength(1);
	});

	it("only a /sys file counts in a project - a same-named macro elsewhere doesn't define the code", () => {
		const files: Array<ProjectFile> = [
			{ path: "0:/gcodes/test.gcode", text: "M1234\n" },
			{ path: "0:/macros/M1234.g", text: "; not in /sys\n" },
		];
		expect(projectDiagsFor(files, "dictionary/unknown-command")).toHaveLength(1);
	});

	it("a fractional G/M code is found by its own macro, not its parent's (M600.g doesn't define M600.1)", () => {
		const files: Array<ProjectFile> = [
			{ path: "0:/gcodes/test.gcode", text: "M600.1\n" },
			{ path: "0:/sys/M600.g", text: "; filament change\n" },
		];
		expect(projectDiagsFor(files, "dictionary/unknown-command")).toHaveLength(1);
		files.push({ path: "0:/sys/M600.1.g", text: "; mine\n" });
		expect(projectDiagsFor(files, "dictionary/unknown-command")).toHaveLength(0);
	});

	it("a fractional form RRF handles itself is reported as such, not as a missing macro", () => {
		// G38 takes fractions itself, and the dictionary has G38.2-.5 only - G38.9 is unknown, yet not a macro.
		const [d] = diagsFor("G38.9 X1\n", "dictionary/unknown-command");
		expect(d.message).toContain("doesn't look for a macro");
	});

	it("never raises project/missing-macro-file for a code with no macro - RRF has its own fallback", () => {
		const files: Array<ProjectFile> = [{ path: "0:/gcodes/test.gcode", text: "M1234\n" }];
		expect(projectDiagsFor(files, "project/missing-macro-file")).toHaveLength(0);
	});

	it("a user-defined code's parameters aren't judged (the macro reads them as param.<letter>)", () => {
		const files: Array<ProjectFile> = [
			{ path: "0:/gcodes/test.gcode", text: "M1234 A1 B2 Zabc\n" },
			{ path: "0:/sys/M1234.g", text: "echo {param.A}\n" },
		];
		const all = diagnoseProject(loadProject(files), OPTS).filter((d) => d.file === "0:/gcodes/test.gcode");
		expect(all).toEqual([]);
	});
});

describe("dictionary/not-available-on-platform (M569.9 is STM32-only)", () => {
	const STM32: DiagnoseOptions = { ...OPTS, platform: "stm32" };
	const DUET: DiagnoseOptions = { ...OPTS, platform: "duet" };
	const LINE = "M569.9 P0.1 T5 R0.11 S1.8\n";

	it("M569.9 is fine on the STM32 fork, with its T, R and S", () => {
		expect(diagsFor(LINE, "dictionary/not-available-on-platform", STM32)).toHaveLength(0);
		expect(diagsFor(LINE, "dictionary/unknown-parameter", STM32)).toHaveLength(0);
		expect(diagsFor(LINE, "dictionary/wrong-kind", STM32)).toHaveLength(0);
		expect(diagsFor("M569.9 P0.1\n", "dictionary/missing-required", STM32)).toHaveLength(0); // a bare report
	});

	it("is an error on a Duet3D build, for the command and again for each fork-only parameter", () => {
		const found = diagsFor(LINE, "dictionary/not-available-on-platform", DUET);
		expect(found.every((d) => d.severity === "error")).toBe(true);
		expect(found.map((d) => d.message)).toEqual([
			"M569.9 only exists on STM32 (gloomyandy fork) firmware, not Duet3D",
			"M569.9's T only exists on STM32 (gloomyandy fork) firmware, not Duet3D",
			"M569.9's R only exists on STM32 (gloomyandy fork) firmware, not Duet3D",
			"M569.9's S only exists on STM32 (gloomyandy fork) firmware, not Duet3D",
		]);
	});

	it("is not judged when the platform isn't known", () => {
		expect(diagsFor(LINE, "dictionary/not-available-on-platform")).toHaveLength(0);
	});

	it("takes the platform from the mainboard named in boards", () => {
		const stm32Board = BOARD_PIN_TABLES.find((t) => t.family === "rrfpins-txt")!.boardId;
		const duetBoard = BOARD_PIN_TABLES.find((t) => t.family === "duet-compiled")!.boardId;
		expect(diagsFor("M569.9 P0 T5\n", "dictionary/not-available-on-platform", { ...OPTS, boards: new Map([[0, stm32Board]]) })).toHaveLength(0);
		expect(diagsFor("M569.9 P0 T5\n", "dictionary/not-available-on-platform", { ...OPTS, boards: new Map([[0, duetBoard]]) })).toHaveLength(2);
		// an expansion board's family says nothing about the mainboard's firmware
		expect(diagsFor("M569.9 P0 T5\n", "dictionary/not-available-on-platform", { ...OPTS, boards: new Map([[3, duetBoard]]) })).toHaveLength(0);
	});

	it("an explicit platform wins over boards", () => {
		const duetBoard = BOARD_PIN_TABLES.find((t) => t.family === "duet-compiled")!.boardId;
		expect(diagsFor("M569.9 P0 T5\n", "dictionary/not-available-on-platform", { ...OPTS, platform: "stm32", boards: new Map([[0, duetBoard]]) })).toHaveLength(0);
	});

	it("checks T's value against the fork's driver-type list (0-10)", () => {
		expect(diagsFor("M569.9 P0 T10\n", "dictionary/value-out-of-range", STM32)).toHaveLength(0);
		expect(diagsFor("M569.9 P0 T11\n", "dictionary/value-out-of-range", STM32)).toHaveLength(1);
	});

	it("an unrelated M569 form is unaffected", () => {
		expect(diagsFor("M569 P0.1 S1\n", "dictionary/not-available-on-platform", DUET)).toHaveLength(0);
	});
});
