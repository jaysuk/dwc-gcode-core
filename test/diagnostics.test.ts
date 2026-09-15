import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { parseDocument } from "../src/document.js";
import { loadProject, type Project, type ProjectFile } from "../src/project.js";
import { RRF_BASELINE } from "../src/rrf.js";
import { diagnoseDocument, diagnoseProject } from "../src/diagnostics/diagnose.js";
import { RULES } from "../src/diagnostics/rules.js";
import { toMonacoMarkers } from "../src/diagnostics/monaco.js";
import type { Diagnostic, DiagnoseOptions } from "../src/diagnostics/schema.js";

const OPTS: DiagnoseOptions = { firmwareVersion: RRF_BASELINE };

function diagsFor(text: string, ruleId: string, options: DiagnoseOptions = OPTS): ReadonlyArray<Diagnostic> {
	const doc = parseDocument(text);
	return diagnoseDocument(doc, "test.g", options).filter((d) => d.rule === ruleId);
}

function projectDiagsFor(files: ReadonlyArray<ProjectFile>, ruleId: string, options: DiagnoseOptions = OPTS): ReadonlyArray<Diagnostic> {
	const project = loadProject(files);
	return diagnoseProject(project, options).filter((d) => d.rule === ruleId);
}

// ── the registry itself ─────────────────────────────────────────────────────────────────────────

describe("RULES", () => {
	it("every rule cites at least one source", () => {
		for (const r of RULES) expect(r.sources.length, r.id).toBeGreaterThan(0);
	});

	it("every id is unique", () => {
		const ids = RULES.map((r) => r.id);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it("every id's prefix matches its own category", () => {
		for (const r of RULES) expect(r.id.split("/")[0], r.id).toBe(r.category);
	});
});

describe("DiagnoseOptions: rules.disable / rules.severity", () => {
	it("disable suppresses a rule entirely", () => {
		const withRule = diagsFor("N1 G1 X10*79\n", "syntax/checksum-mismatch");
		expect(withRule).toHaveLength(1);
		const disabled = diagsFor("N1 G1 X10*79\n", "syntax/checksum-mismatch", { ...OPTS, rules: { disable: ["syntax/checksum-mismatch"] } });
		expect(disabled).toHaveLength(0);
	});

	it("severity overrides the registry's own default", () => {
		const [d] = diagsFor("N1 G1 X10*79\n", "syntax/checksum-mismatch", { ...OPTS, rules: { severity: { "syntax/checksum-mismatch": "warning" } } });
		expect(d.severity).toBe("warning");
	});
});

// ── syntax ──────────────────────────────────────────────────────────────────────────────────────

describe("syntax/lexer-error", () => {
	it("an unterminated string is flagged", () => {
		const [d] = diagsFor('M291 P"oops\n', "syntax/lexer-error");
		expect(d.message).toMatch(/unterminated/i);
	});
	it("a properly closed string is not", () => {
		expect(diagsFor('M291 P"fine"\n', "syntax/lexer-error")).toHaveLength(0);
	});
});

describe("syntax/line-too-long", () => {
	const long = `G1 X${"1".repeat(300)}\n`;
	it("a line whose non-comment content is >= 256 chars is flagged", () => {
		const [d] = diagsFor(long, "syntax/line-too-long");
		expect(d.message).toMatch(/304 characters/);
		expect(d.message).toMatch(/at most 255/);
	});
	it("a short line is not", () => {
		expect(diagsFor("G1 X10\n", "syntax/line-too-long")).toHaveLength(0);
	});
	it("a trailing ; comment doesn't count toward the limit (RRF resets its overflow flag for comments)", () => {
		const text = `G1 X10 ;${"a".repeat(300)}\n`;
		expect(diagsFor(text, "syntax/line-too-long")).toHaveLength(0);
	});
});

describe("syntax/checksum-mismatch", () => {
	// "N1 G1 X10" XORs (byte-for-byte) to 80 - verified independently, not just by trusting the rule.
	it("a wrong checksum is flagged", () => {
		const [d] = diagsFor("N1 G1 X10*79\n", "syntax/checksum-mismatch");
		expect(d.message).toContain("*79");
		expect(d.message).toContain("*80");
	});
	it("the correct checksum is not flagged", () => {
		expect(diagsFor("N1 G1 X10*80\n", "syntax/checksum-mismatch")).toHaveLength(0);
	});

	it("still validates when something follows the checksum (a trailing comment, trailing spaces)", () => {
		// The digit count is measured across the checksum's own span; measuring it to the end of the
		// line instead silently skipped every checksummed line that had anything after it.
		expect(diagsFor("N1 G1 X10*79 ; streamed\n", "syntax/checksum-mismatch")).toHaveLength(1);
		expect(diagsFor("N1 G1 X10*79   \n", "syntax/checksum-mismatch")).toHaveLength(1);
		expect(diagsFor("N1 G1 X10*80 ; streamed\n", "syntax/checksum-mismatch")).toHaveLength(0);
	});

	it("still ignores RRF's 5-digit CRC16 form, with or without a trailing comment", () => {
		expect(diagsFor("N1 G1 X10*12345 ; streamed\n", "syntax/checksum-mismatch")).toHaveLength(0);
	});
});

// ── structure ───────────────────────────────────────────────────────────────────────────────────

describe("structure/document-error", () => {
	it("an elif without a matching if is flagged", () => {
		const [d] = diagsFor("elif true\n    G1 X1\n", "structure/document-error");
		expect(d.message).toMatch(/elif/);
	});
	it("a well-formed if block is not", () => {
		expect(diagsFor("if true\n    G1 X1\n", "structure/document-error")).toHaveLength(0);
	});
});

describe("structure/macro-command-not-last", () => {
	it("G28 sharing a line with another command is flagged", () => {
		const [d] = diagsFor("G28 G1 X10\n", "structure/macro-command-not-last");
		expect(d.message).toContain("G28");
	});
	it("G28 alone on its line is not", () => {
		expect(diagsFor("G28\n", "structure/macro-command-not-last")).toHaveLength(0);
	});
});

describe("structure/capitalised-meta-keyword", () => {
	it("a capitalised \"If\" is flagged, saying what it's read as instead", () => {
		const [d] = diagsFor("If true\n    G1 X1\n", "structure/capitalised-meta-keyword");
		expect(d.message).toContain("If");
		expect(d.message).toContain("if");
	});
	it("all-lowercase if is not", () => {
		expect(diagsFor("if true\n    G1 X1\n", "structure/capitalised-meta-keyword")).toHaveLength(0);
	});
});

// ── dictionary ──────────────────────────────────────────────────────────────────────────────────

describe("dictionary/unknown-command", () => {
	it("an unrecognised code is flagged (info) with no project", () => {
		const [d] = diagsFor("G9999\n", "dictionary/unknown-command");
		expect(d.severity).toBe("info");
	});
	it("a known code is not", () => {
		expect(diagsFor("G1 X10\n", "dictionary/unknown-command")).toHaveLength(0);
	});
	it("still flagged against a project when the /sys/<code>.g macro is absent", () => {
		const files: Array<ProjectFile> = [{ path: "0:/gcodes/test.gcode", text: "G9999\n" }];
		expect(projectDiagsFor(files, "dictionary/unknown-command")).toHaveLength(1);
	});
	it("NOT flagged against a project when the /sys/<code>.g macro is present (RRF's own custom-code fallback)", () => {
		const files: Array<ProjectFile> = [
			{ path: "0:/gcodes/test.gcode", text: "G9999\n" },
			{ path: "0:/sys/G9999.g", text: "; noop\n" },
		];
		expect(projectDiagsFor(files, "dictionary/unknown-command")).toHaveLength(0);
	});
});

describe("dictionary/unknown-parameter", () => {
	it("a parameter the dictionary doesn't list is flagged", () => {
		const [d] = diagsFor("G4 Q1\n", "dictionary/unknown-parameter");
		expect(d.message).toContain("Q");
	});
	it("a listed parameter is not", () => {
		expect(diagsFor("G4 S1\n", "dictionary/unknown-parameter")).toHaveLength(0);
	});

	it("M586's real parameters (found empty during task 12's full triage) no longer misfire", () => {
		// M586 was "reviewed" with an empty parameter list - every real use flagged every parameter as
		// unknown. Confirmed against RRF's own Network::ConfigureNetworkProtocol directly.
		expect(diagsFor('M586 P0 S1 R80\n', "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor('M586 C"https://example.com"\n', "dictionary/unknown-parameter")).toHaveLength(0);
	});
});

describe("dictionary/wrong-kind", () => {
	it("a non-numeric value where a number is expected is flagged", () => {
		// "Sabc" would lex as four separate valueless params (S,A,B,C - the tokeniser splits at every
		// letter, RRF-style), not one bad value, so a mis-shaped-but-single-param value needs a value
		// built from non-letter characters instead - "1.2.3" fails the numeric regex as one param.
		const [d] = diagsFor("M104 S1.2.3\n", "dictionary/wrong-kind");
		expect(d.message).toContain("1.2.3");
	});
	it("a numeric value is not", () => {
		expect(diagsFor("M104 S200\n", "dictionary/wrong-kind")).toHaveLength(0);
	});
	it("an {expression} value is never flagged, even where it can't look like the kind statically", () => {
		expect(diagsFor("M104 S{var.temp}\n", "dictionary/wrong-kind")).toHaveLength(0);
	});
});

describe("dictionary/missing-required", () => {
	it("a required parameter's absence is flagged", () => {
		const [d] = diagsFor("M563\n", "dictionary/missing-required");
		expect(d.message).toContain("P");
	});
	it("its presence is not", () => {
		expect(diagsFor("M563 P0\n", "dictionary/missing-required")).toHaveLength(0);
	});
});

describe("dictionary/value-out-of-range", () => {
	it("a numeric value outside the dictionary's range is flagged (G0 H: 0..5)", () => {
		const [d] = diagsFor("G0 H9\n", "dictionary/value-out-of-range");
		expect(d.message).toContain("9");
	});
	it("a value inside the range is not", () => {
		expect(diagsFor("G0 H2\n", "dictionary/value-out-of-range")).toHaveLength(0);
	});
	it("an enumerated value not in the dictionary's own list is flagged (G29 S: 0..4)", () => {
		const [d] = diagsFor("G29 S9\n", "dictionary/value-out-of-range");
		expect(d.message).toContain("9");
	});
	it("a listed enum value is not", () => {
		expect(diagsFor("G29 S1\n", "dictionary/value-out-of-range")).toHaveLength(0);
	});
});

describe("dictionary/not-available-on-firmware", () => {
	// M140's H parameter is dated `since: "3.7.0-beta.1"` (task 10/12's own real per-parameter data).
	it("a parameter used before its own since-version is flagged", () => {
		const [d] = diagsFor("M140 H1\n", "dictionary/not-available-on-firmware", { firmwareVersion: "3.6.3" });
		expect(d.message).toContain("3.7.0-beta.1");
	});
	it("the same line at/after its since-version is not", () => {
		expect(diagsFor("M140 H1\n", "dictionary/not-available-on-firmware", { firmwareVersion: RRF_BASELINE })).toHaveLength(0);
	});

	it("M574's E (extruder filament endstop, task 12's full triage: RRF commit 83403dfac6) is dated since 3.7.0-beta.3", () => {
		const [d] = diagsFor("M574 E0 P0\n", "dictionary/not-available-on-firmware", { firmwareVersion: "3.7.0-beta.2" });
		expect(d.message).toContain("3.7.0-beta.3");
		expect(diagsFor("M574 E0 P0\n", "dictionary/not-available-on-firmware", { firmwareVersion: RRF_BASELINE })).toHaveLength(0);
	});

	it("M558's V/U (load-cell probe scale/preload, task 12's full triage) are dated since 3.7.0-beta.3", () => {
		expect(diagsFor("M558 K0 V100\n", "dictionary/not-available-on-firmware", { firmwareVersion: "3.7.0-beta.2" })).toHaveLength(1);
		expect(diagsFor("M558 K0 U5\n", "dictionary/not-available-on-firmware", { firmwareVersion: "3.7.0-beta.2" })).toHaveLength(1);
		expect(diagsFor("M558 K0 V100 U5\n", "dictionary/not-available-on-firmware", { firmwareVersion: RRF_BASELINE })).toHaveLength(0);
	});
});

describe("dictionary/deprecated", () => {
	it("a deprecated command is flagged", () => {
		const [d] = diagsFor("M107\n", "dictionary/deprecated");
		expect(d.message).toMatch(/deprecated/);
	});
	it("its non-deprecated replacement is not", () => {
		expect(diagsFor("M106 S0\n", "dictionary/deprecated")).toHaveLength(0);
	});
});

// ── object model ────────────────────────────────────────────────────────────────────────────────

describe("objectModel/unknown-path", () => {
	it("a bogus object-model path in an expression is flagged", () => {
		const [d] = diagsFor("if move.totallyBogusField123\n    G1 X1\n", "objectModel/unknown-path");
		expect(d.message).toContain("move.totallyBogusField123");
	});
	it("a real path is not", () => {
		expect(diagsFor("if move.axes[0].homed\n    G1 X1\n", "objectModel/unknown-path")).toHaveLength(0);
	});
});

describe("objectModel/deprecated-path", () => {
	// heat.bedHeaters is deprecated (since 3.6.3) in favour of heat.bedHeaterMapping - real data from
	// task 11's own schema, not fabricated for this test. Referenced bare (not indexed): the schema
	// entry's own path is "heat.bedHeaters" with no "[]" - indexing it turns the extracted path into
	// "heat.bedHeaters[]" instead, which wouldn't match this specific schema entry.
	it("a deprecated path is flagged, naming the replacement", () => {
		const [d] = diagsFor("if heat.bedHeaters = 0\n    G1 X1\n", "objectModel/deprecated-path");
		expect(d.message).toMatch(/bedHeaterMapping/);
	});
	it("its non-deprecated replacement path is not", () => {
		expect(diagsFor("if heat.bedHeaterMapping[0] = 0\n    G1 X1\n", "objectModel/deprecated-path")).toHaveLength(0);
	});
});

// ── release ─────────────────────────────────────────────────────────────────────────────────────

describe("release/impact", () => {
	// m408-removed (CHANGES, task 12): M408 was removed at 3.7.0-alpha.2.
	it("a command removed between the stamped and target version is flagged", () => {
		const [d] = diagsFor("M408\n", "release/impact", { firmwareVersion: RRF_BASELINE, stampedVersion: "3.6.3" });
		expect(d.message).toMatch(/M408/);
	});
	it("no finding without a stampedVersion", () => {
		expect(diagsFor("M408\n", "release/impact", { firmwareVersion: RRF_BASELINE })).toHaveLength(0);
	});
	it("no finding for a command untouched across the range", () => {
		expect(diagsFor("G1 X10\n", "release/impact", { firmwareVersion: RRF_BASELINE, stampedVersion: "3.6.3" })).toHaveLength(0);
	});
});

// ── project ─────────────────────────────────────────────────────────────────────────────────────

describe("project/undefined-symbol", () => {
	it("a tool used but never defined anywhere is flagged", () => {
		const files: Array<ProjectFile> = [
			{ path: "0:/sys/config.g", text: "M563 P0\n" },
			{ path: "0:/gcodes/test.gcode", text: "T5\n" },
		];
		const [d] = projectDiagsFor(files, "project/undefined-symbol");
		expect(d.message).toContain("tool 5");
	});
	it("a tool that IS defined somewhere is not", () => {
		const files: Array<ProjectFile> = [
			{ path: "0:/sys/config.g", text: "M563 P0\n" },
			{ path: "0:/gcodes/test.gcode", text: "T0\n" },
		];
		expect(projectDiagsFor(files, "project/undefined-symbol")).toHaveLength(0);
	});
});

describe("project/duplicate-definition", () => {
	it("the same tool defined unconditionally twice is flagged", () => {
		const files: Array<ProjectFile> = [{ path: "0:/sys/config.g", text: "M563 P0\nM563 P0\n" }];
		const [d] = projectDiagsFor(files, "project/duplicate-definition");
		expect(d.message).toContain("tool 0");
	});
	it("a single definition is not", () => {
		const files: Array<ProjectFile> = [{ path: "0:/sys/config.g", text: "M563 P0\n" }];
		expect(projectDiagsFor(files, "project/duplicate-definition")).toHaveLength(0);
	});
});

describe("project/missing-macro-file", () => {
	it("M98 P\"...\" naming a file absent from the project is flagged", () => {
		const files: Array<ProjectFile> = [{ path: "0:/gcodes/test.gcode", text: 'M98 P"missing.g"\n' }];
		const [d] = projectDiagsFor(files, "project/missing-macro-file");
		expect(d.message).toContain("missing.g");
	});
	it("a file that IS present is not", () => {
		const files: Array<ProjectFile> = [
			{ path: "0:/gcodes/test.gcode", text: 'M98 P"present.g"\n' },
			{ path: "0:/sys/present.g", text: "; noop\n" },
		];
		expect(projectDiagsFor(files, "project/missing-macro-file")).toHaveLength(0);
	});
});

// ── menu ────────────────────────────────────────────────────────────────────────────────────────

describe("menu/unknown-command", () => {
	it("a command word RRF doesn't recognise is flagged", () => {
		const files: Array<ProjectFile> = [{ path: "0:/menu/main", text: 'foo T"x"\n' }];
		const [d] = projectDiagsFor(files, "menu/unknown-command");
		expect(d.message).toContain("foo");
	});
	it("a recognised command is not", () => {
		const files: Array<ProjectFile> = [{ path: "0:/menu/main", text: 'text T"hi"\n' }];
		expect(projectDiagsFor(files, "menu/unknown-command")).toHaveLength(0);
	});
});

describe("menu/target-missing", () => {
	it("a bare \"menu\" action's own L target absent from 0:/menu/ is flagged (the common A\"menu\" L\"name\" form)", () => {
		const files: Array<ProjectFile> = [{ path: "0:/menu/main", text: 'button T"Go" A"menu" L"missing"\n' }];
		const [d] = projectDiagsFor(files, "menu/target-missing");
		expect(d.message).toContain("missing");
	});
	it("a present target is not", () => {
		const files: Array<ProjectFile> = [
			{ path: "0:/menu/main", text: 'button T"Go" A"menu" L"other"\n' },
			{ path: "0:/menu/other", text: "text T\"hi\"\n" },
		];
		expect(projectDiagsFor(files, "menu/target-missing")).toHaveLength(0);
	});
	it("a name embedded right in the action text (\"menu <name>\") is also checked", () => {
		const files: Array<ProjectFile> = [{ path: "0:/menu/main", text: 'button T"Go" A"menu missing"\n' }];
		const [d] = projectDiagsFor(files, "menu/target-missing");
		expect(d.message).toContain("missing");
	});
});

describe("menu/image-missing", () => {
	it("an image command's own L file absent from 0:/menu/ is flagged", () => {
		const files: Array<ProjectFile> = [{ path: "0:/menu/main", text: 'image L"missing.bin"\n' }];
		const [d] = projectDiagsFor(files, "menu/image-missing");
		expect(d.message).toContain("missing.bin");
	});
	it("a present image file is not", () => {
		const files: Array<ProjectFile> = [
			{ path: "0:/menu/main", text: 'image L"logo.bin"\n' },
			{ path: "0:/menu/logo.bin", text: "" },
		];
		expect(projectDiagsFor(files, "menu/image-missing")).toHaveLength(0);
	});
});

// ── data (height maps) ──────────────────────────────────────────────────────────────────────────

describe("data/height-map-error", () => {
	it("a malformed heightmap.csv is flagged with RRF's own message", () => {
		const files: Array<ProjectFile> = [{ path: "0:/sys/heightmap.csv", text: "not a height map\n" }];
		const [d] = projectDiagsFor(files, "data/height-map-error");
		expect(d.message).toMatch(/header/);
	});
	it("a well-formed heightmap.csv is not", () => {
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
		const files: Array<ProjectFile> = [{ path: "0:/sys/heightmap.csv", text }];
		expect(projectDiagsFor(files, "data/height-map-error")).toHaveLength(0);
	});
});

// ── toMonacoMarkers ─────────────────────────────────────────────────────────────────────────────

describe("toMonacoMarkers", () => {
	it("maps every Severity to Monaco's own MarkerSeverity", () => {
		const diags: Array<Diagnostic> = (["hint", "info", "warning", "error"] as const).map((severity, i) => (
			{ rule: `r${i}`, severity, message: "m", file: "f", line: 0, start: 0, end: 1, sources: ["s"] }
		));
		const markers = toMonacoMarkers(diags, "X\n");
		expect(markers.map((m) => m.severity)).toEqual([1, 2, 4, 8]);
		expect(markers.map((m) => m.code)).toEqual(["r0", "r1", "r2", "r3"]);
	});

	it("converts a multi-line CRLF document's absolute offsets to 1-based line/column, in UTF-16 units (a surrogate-pair emoji counts as 2)", () => {
		const emoji = "\u{1F642}"; // 2 UTF-16 code units
		const text = `G1 X10\r\nM117 "café ${emoji}"\r\nG1 Y5\r\n`;
		const start = text.indexOf(emoji);
		const end = start + emoji.length;
		const diag: Diagnostic = { rule: "x", severity: "error", message: "m", file: "f", line: 1, start, end, sources: ["s"] };
		const [marker] = toMonacoMarkers([diag], text);
		const line1Start = text.indexOf("\n") + 1; // right after the first line's own \r\n
		expect(marker.startLineNumber).toBe(2);
		expect(marker.endLineNumber).toBe(2);
		expect(marker.startColumn).toBe(start - line1Start + 1);
		expect(marker.endColumn).toBe(end - line1Start + 1);
		expect(marker.endColumn - marker.startColumn).toBe(2); // the emoji itself, in UTF-16 units
	});

	it("a diagnostic on the very first character is column 1", () => {
		const diag: Diagnostic = { rule: "x", severity: "hint", message: "m", file: "f", line: 0, start: 0, end: 1, sources: ["s"] };
		const [marker] = toMonacoMarkers([diag], "G1 X10\n");
		expect(marker.startLineNumber).toBe(1);
		expect(marker.startColumn).toBe(1);
	});
});

// ── task 13's own project fixtures, full diagnostic list ──────────────────────────────────────────

const CORPUS_ROOT = join(dirname(fileURLToPath(import.meta.url)), "corpus", "projects");

function readTree(dir: string, root: string): Array<ProjectFile> {
	const files: Array<ProjectFile> = [];
	for (const name of readdirSync(dir)) {
		if (name === "README.md") continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			files.push(...readTree(full, root));
		} else {
			const rel = relative(root, full).replace(/\\/g, "/");
			files.push({ path: `0:/${rel}`, text: readFileSync(full, "utf-8") });
		}
	}
	return files;
}

function loadFixture(name: string): Project {
	const root = join(CORPUS_ROOT, name);
	return loadProject(readTree(root, root));
}

function summarise(diags: ReadonlyArray<Diagnostic>): Array<string> {
	return diags.map((d) => `${d.severity} ${d.rule} ${d.file}:${d.line} ${d.message}`).sort();
}

describe("diagnoseProject: task 13's own fixtures (full diagnostic list, snapshotted)", () => {
	it("fff-basic", () => {
		expect(summarise(diagnoseProject(loadFixture("fff-basic"), OPTS))).toMatchSnapshot();
	});
	it("cnc-basic", () => {
		expect(summarise(diagnoseProject(loadFixture("cnc-basic"), OPTS))).toMatchSnapshot();
	});
	it("laser-basic", () => {
		expect(summarise(diagnoseProject(loadFixture("laser-basic"), OPTS))).toMatchSnapshot();
	});
});
