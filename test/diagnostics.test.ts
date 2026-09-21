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

	it("M586.4's MQTT client parameters (entirely missing before this pass) no longer misfire", () => {
		// Found while migrating dwc-config-backup-core's own redaction table onto this dictionary
		// (2026-09-16) - M586.4 didn't exist in the dictionary at all.
		expect(diagsFor('M586.4 U"user" K"pass" C"client1" N1\n', "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor('M586.4 S"status/topic" O2\n', "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor('M586.4 W"offline" T"status/topic" Q1 R1\n', "dictionary/unknown-parameter")).toHaveLength(0);
	});

	it("M587/M588/M589's real parameters (also entirely empty before this pass) no longer misfire", () => {
		// Same migration pass - M587/588/589 were "reviewed" with empty parameter lists, exactly like
		// M586 before task 12 found and fixed that one.
		expect(diagsFor('M587 S"MyNetwork" P"hunter22" I192.168.1.50\n', "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor('M587 X1 S"Corp" A"anon" U"user" P"pk.pem" Q"pkpass" E"ca.pem"\n', "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor('M588 S"MyNetwork"\n', "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor('M589 S"MyAP" P"hunter22" I192.168.1.1 C6\n', "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor("M589 T10\n", "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor("M589 L1\n", "dictionary/unknown-parameter")).toHaveLength(0);
	});

	it("M950's LED-strip form (K colour order, U max LEDs, T strip type) no longer misfires", () => {
		// Found via the wiki cross-check during task 12's full triage: T was documented as
		// "heater form only", but it's also the LED strip type; K and U were missing entirely.
		expect(diagsFor('M950 E0 C"led" T2 K5 U60\n', "dictionary/unknown-parameter")).toHaveLength(0);
	});

	it("M950's spindle form (K min:max:idle PWM, L min:max RPM, T spindle type) no longer misfires", () => {
		// K and T are shared letters with the LED form but mean something completely different here
		// (a float PWM array and a spindle type, not a colour order/strip type) - found by reading
		// Tools/Spindle.cpp directly during task 12's full wiki triage.
		expect(diagsFor('M950 R0 C"spindle" Q100 K0.1:1.0:0.2 L1000:10000 T1\n', "dictionary/unknown-parameter")).toHaveLength(0);
	});

	it("M584's P (visible axis count) no longer misfires", () => {
		expect(diagsFor("M584 X0 Y1 Z2 P2\n", "dictionary/unknown-parameter")).toHaveLength(0);
	});

	it("M308's universal (A/U/V) and thermistor-specific (T/B/C/R/L/H) parameters no longer misfire", () => {
		// M308 was reviewed with only S/P/Y - every real thermistor-config line (the single most common
		// M308 form, and one of the most common lines in any config.g) flagged T/B/C as unknown.
		expect(diagsFor('M308 S0 P"temp0" Y"thermistor" T100000 B4725 C7.06e-8 R4700 A"Bed"\n', "dictionary/unknown-parameter")).toHaveLength(0);
	});

	it("M106's thermostatic-mode parameters (T/H/B/L/X) and C (fan name) no longer misfire", () => {
		// M106 was reviewed with only P/S/R - the thermostatic-fan form (extremely common for
		// hotend/case fans in config.g) flagged T/H/B/L/X as unknown. Found via Fans/Fan.cpp
		// during task 12's full wiki triage.
		expect(diagsFor('M106 P1 T45:60 H1 B2 L0.2 X1.0 C"Hotend Fan"\n', "dictionary/unknown-parameter")).toHaveLength(0);
	});

	it("M569's U (TMC current scaler override) no longer misfires", () => {
		// Found via the wiki cross-check during task 12's full triage: Move2.cpp's
		// ConfigureLocalDriverBasicParameters reads U for TMC5160/2160 globalscaler tuning.
		expect(diagsFor("M569 P0 U20\n", "dictionary/unknown-parameter")).toHaveLength(0);
	});

	it("M575's C (RS485 direction port for Modbus device mode) no longer misfires", () => {
		expect(diagsFor('M575 P1 S2 C"io1.out"\n', "dictionary/unknown-parameter")).toHaveLength(0);
	});

	it("M906's T (idle timeout) no longer misfires", () => {
		expect(diagsFor("M906 X800 Y800 I30 T30\n", "dictionary/unknown-parameter")).toHaveLength(0);
	});

	it("M569's R-1 (driver always disabled) is a real value, not a wrong-kind boolean01 flag", () => {
		// R was declared boolean01 (0/1 only), but RRF's SetEnableValue takes a signed int8 and -1
		// means "always disabled, not monitored" - found via the wiki cross-check during task 12's
		// full triage. Checked here (not just wrong-kind below) because unknown-parameter and
		// wrong-kind are the two rules a bad "kind" declaration could trip.
		expect(diagsFor("M569 P0 R-1\n", "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor("M569 P0 R-1\n", "dictionary/wrong-kind")).toHaveLength(0);
	});

	it("M593's L (accepted but ignored since RRF 3.6.0) doesn't misfire on an old config.g line", () => {
		// RRF's AxisShaper::Configure never reads 'L' at all - the wiki confirms it's a deliberate
		// no-op kept for backward compatibility, not a removed/erroring parameter.
		expect(diagsFor("M593 P\"zvd\" F40 S0.1 L0.05\n", "dictionary/unknown-parameter")).toHaveLength(0);
	});

	it("M569.1's closed-loop configuration parameters (T/C/PID gains/E/S/Q/B/Y) no longer misfire", () => {
		// Added for ClosedLoopTuningPlugin's migration (2026-09-16) - the whole M569.1/.5/.6 family was
		// entirely absent from the dictionary before this. Duet3Expansion's own ClosedLoop.cpp is the
		// real source, since these sub-commands only ever execute on a CAN-connected closed-loop driver.
		expect(diagsFor('M569.1 P51.0 T3 R150 I5000 D0.2 V400 A200000 E2:4 Q0.5 B0.1 Y"as5047d"\n', "dictionary/unknown-parameter")).toHaveLength(0);
		expect(diagsFor("M569.1 P51.0 T2 C4096 S200\n", "dictionary/unknown-parameter")).toHaveLength(0);
	});

	it("M569.5's data-collection parameters (S/A/D/R/V/F) no longer misfire", () => {
		expect(diagsFor('M569.5 P51.0 S1000 A0 D3 R1000 V0 F"test.csv"\n', "dictionary/unknown-parameter")).toHaveLength(0);
	});

	it("M569.6's tuning-manoeuvre V parameter no longer misfires", () => {
		expect(diagsFor("M569.6 P51.0 V1\n", "dictionary/unknown-parameter")).toHaveLength(0);
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

	// RRF's own float grammar (StringParser::ReadFloatValue -> SafeStrtof -> NumericConverter::
	// Accumulate, RRFLibraries/src/General/NumericConverter.cpp) explicitly accepts scientific
	// notation for every kind:"number" parameter - confirmed real user input, a Steinhart-Hart C
	// coefficient of 7.06e-8 on M308, was wrongly flagged before NUMBER_RE (lex.ts) and this rule's
	// own regex drifted apart.
	it("a kind:number value in scientific notation is not flagged - a real M308 C coefficient", () => {
		expect(diagsFor('M308 S0 Y"thermistor" C7.06e-8\n', "dictionary/wrong-kind")).toHaveLength(0);
	});
	it("scientific notation with a positive/explicit-sign exponent is also accepted", () => {
		expect(diagsFor("M104 S1.5e+2\n", "dictionary/wrong-kind")).toHaveLength(0);
	});
	it("a negative value in scientific notation is also accepted", () => {
		expect(diagsFor("M104 S-1.5e2\n", "dictionary/wrong-kind")).toHaveLength(0);
	});

	// The fix must NOT leak into integer-shaped kinds - RRF reads those via ReadUIValue/ReadIValue ->
	// StrToU32/StrToI32, which call NumericConverter::Accumulate WITHOUT the AcceptFloat option, so
	// its exponent-parsing block never runs there; scientific notation is genuinely invalid RRF
	// syntax for these, unlike for kind:"number".
	it("scientific notation on an integer-shaped kind (fanNumber) is still flagged", () => {
		const [d] = diagsFor("M106 P1e2 S1\n", "dictionary/wrong-kind");
		expect(d.message).toContain("1e2");
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

	// task 17, Decision 4: ParamSpec.required's object form ({ ifLetterPresent, valueOneOf?, valueNot? })
	describe("conditional required (task 17)", () => {
		it("M569.1's C is required when T is 1 or 2 (rotary quadrature/linear composite), not otherwise", () => {
			expect(diagsFor("M569.1 P0 T1\n", "dictionary/missing-required")).toHaveLength(1);
			expect(diagsFor("M569.1 P0 T2\n", "dictionary/missing-required")).toHaveLength(1);
			expect(diagsFor("M569.1 P0 T1 C400\n", "dictionary/missing-required")).toHaveLength(0);
			expect(diagsFor("M569.1 P0 T3\n", "dictionary/missing-required")).toHaveLength(0); // rotary magnetic - C not needed
			expect(diagsFor("M569.1 P0\n", "dictionary/missing-required")).toHaveLength(0); // T absent - condition doesn't apply
		});
		it("M593's H is required when P is \"custom\"", () => {
			const [d] = diagsFor('M593 P"custom"\n', "dictionary/missing-required");
			expect(d.message).toContain("H");
			expect(diagsFor('M593 P"custom" H0.2:0.3\n', "dictionary/missing-required")).toHaveLength(0);
			expect(diagsFor('M593 P"zvd"\n', "dictionary/missing-required")).toHaveLength(0);
		});
		it("M586.4's T is required when W is given, not otherwise", () => {
			expect(diagsFor('M586.4 S0 W"goodbye"\n', "dictionary/missing-required")).toHaveLength(1);
			expect(diagsFor('M586.4 S0 W"goodbye" T"lwt/topic"\n', "dictionary/missing-required")).toHaveLength(0);
			expect(diagsFor("M586.4 S0\n", "dictionary/missing-required")).toHaveLength(0);
		});
		it("M589's P and I are required when S is given and isn't \"*\"", () => {
			expect(diagsFor('M589 S"MyAP"\n', "dictionary/missing-required")).toHaveLength(2);
			expect(diagsFor('M589 S"MyAP" P"password1" I"192.168.1.1"\n', "dictionary/missing-required")).toHaveLength(0);
		});
		it("M589's P/I are not required when S is \"*\" (the delete-configuration form)", () => {
			expect(diagsFor('M589 S"*"\n', "dictionary/missing-required")).toHaveLength(0);
		});
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

	// A string-kind `values` list needs unquoting first (LexedParam.value keeps quotes verbatim) -
	// without it every quoted enum value would wrongly fail this check. M593's P is exact/case-
	// sensitive (RRF's NamedEnum/strcmp); M308's Y is "reduced" (RRF's ReducedStringEquals) - the two
	// commands deliberately exercise the two different valueMatch modes.
	it("a quoted string enum value that matches is not flagged (M593 P, exact match)", () => {
		expect(diagsFor("M593 P\"zvd\"\n", "dictionary/value-out-of-range")).toHaveLength(0);
	});
	it("a quoted string enum value that doesn't match is flagged, unquoted in the message", () => {
		const [d] = diagsFor("M593 P\"zdv\"\n", "dictionary/value-out-of-range");
		expect(d.message).toContain("zdv");
	});
	it("M593's P is case-sensitive - a differently-cased match still fails (no valueMatch: \"reduced\")", () => {
		expect(diagsFor("M593 P\"ZVD\"\n", "dictionary/value-out-of-range")).toHaveLength(1);
	});
	it("M308's Y matches case-insensitively (valueMatch: \"reduced\")", () => {
		expect(diagsFor("M308 S0 Y\"Thermistor\"\n", "dictionary/value-out-of-range")).toHaveLength(0);
	});
	it("M308's Y ignores '-'/'_' on either side (RRF's ReducedStringEquals)", () => {
		expect(diagsFor("M308 S0 Y\"thermocouple_max31855\"\n", "dictionary/value-out-of-range")).toHaveLength(0);
		expect(diagsFor("M308 S0 Y\"thermocouple-max-31855\"\n", "dictionary/value-out-of-range")).toHaveLength(0);
	});
	it("M308's Y still flags a genuinely unknown sensor type", () => {
		const [d] = diagsFor("M308 S0 Y\"thermocouple-k\"\n", "dictionary/value-out-of-range");
		expect(d.message).toContain("thermocouple-k");
	});
	it("a trailing separator with nothing after it does not match (reduced matching isn't just a substring check)", () => {
		expect(diagsFor("M308 S0 Y\"thermistor-\"\n", "dictionary/value-out-of-range")).toHaveLength(1);
	});

	// task 17's audit script (scripts/audit-dictionary.mjs) found these three - each verified against
	// real RRF source before fixing, not just added on the script's say-so.
	it("M143's C (heater monitor trigger) rejects a value outside -1..1 - RRF's own enum only has those three (Heater::ConfigureMonitor's GetLimitedIValue('C', -1, 1))", () => {
		expect(diagsFor("M143 H0 C2\n", "dictionary/value-out-of-range")).toHaveLength(1);
		expect(diagsFor("M143 H0 C-1\n", "dictionary/value-out-of-range")).toHaveLength(0);
	});
	it("M574's S (endstop input type) rejects 0 - RRF explicitly errors \"endstop type 0 is no longer supported\", not silently accepts it", () => {
		const [d] = diagsFor("M574 X1 S0\n", "dictionary/value-out-of-range");
		expect(d.message).toContain("0");
	});
	it("M574's S accepts 1..5", () => {
		expect(diagsFor("M574 X1 S1\n", "dictionary/value-out-of-range")).toHaveLength(0);
		expect(diagsFor("M574 X1 S5\n", "dictionary/value-out-of-range")).toHaveLength(0);
	});
	it("M575's F (serial parity) rejects a value outside 0..2 - Platform::HandleM575's GetLimitedUIValue('F', 3) throws, it doesn't clamp", () => {
		expect(diagsFor("M575 P1 F3\n", "dictionary/value-out-of-range")).toHaveLength(1);
		expect(diagsFor("M575 P1 F2\n", "dictionary/value-out-of-range")).toHaveLength(0);
	});
	it("M569.6's V (tuning manoeuvre) accepts 1-4 and the undocumented 64, rejects anything else - ClosedLoop::ProcessM569Point6's switch has no default fallthrough (\"invalid tuning mode\")", () => {
		expect(diagsFor("M569.6 P0 V1\n", "dictionary/value-out-of-range")).toHaveLength(0);
		expect(diagsFor("M569.6 P0 V64\n", "dictionary/value-out-of-range")).toHaveLength(0);
		expect(diagsFor("M569.6 P0 V5\n", "dictionary/value-out-of-range")).toHaveLength(1);
	});
	it("M575's S (channel mode) accepts the real 8-entry auxModes[] range 0-7, previously wrongly described as just 0/1/2", () => {
		expect(diagsFor("M575 P1 S7\n", "dictionary/value-out-of-range")).toHaveLength(0);
		expect(diagsFor("M575 P1 S8\n", "dictionary/value-out-of-range")).toHaveLength(1);
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

	it("M950's B (ambient-compensation sensor, task 12's full triage: RRF commit 049b4bda29) is dated since 3.7.0-beta.2", () => {
		// Confirmed two ways, not just one: git merge-base --is-ancestor (not beta.1, is beta.2) AND
		// independently by the wiki's own "supported in RRF 3.7.0-beta.2 and later" - the wiki cross-
		// check here caught a real dating error in this task's own first pass (which had beta.1).
		const [d] = diagsFor('M950 H0 C"out0" T0 B1\n', "dictionary/not-available-on-firmware", { firmwareVersion: "3.7.0-beta.1" });
		expect(d.message).toContain("3.7.0-beta.2");
		expect(diagsFor('M950 H0 C"out0" T0 B1\n', "dictionary/not-available-on-firmware", { firmwareVersion: RRF_BASELINE })).toHaveLength(0);
	});

	it("M575's F (serial parity, task 12's full triage: RRF commit 0a90c25e8a) is dated since 3.7.0-beta.2", () => {
		const [d] = diagsFor("M575 P1 F1\n", "dictionary/not-available-on-firmware", { firmwareVersion: "3.7.0-beta.1" });
		expect(d.message).toContain("3.7.0-beta.2");
		expect(diagsFor("M575 P1 F1\n", "dictionary/not-available-on-firmware", { firmwareVersion: RRF_BASELINE })).toHaveLength(0);
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

	// Task 17: M308 S<n> only creates a sensor when Y is also given (Heat::ConfigureSensor's
	// `if (gb.Seen('Y'))`) - reconfiguring sensor 0 without ever having created it should flag the
	// SAME rule a missing tool/heater/etc. definition already flags, not a new one.
	it("M308 S0 with no Y anywhere in the project (reconfiguring a sensor that was never created) is flagged", () => {
		const files: Array<ProjectFile> = [{ path: "0:/sys/config.g", text: 'M308 S0 A"bed"\n' }];
		const [d] = projectDiagsFor(files, "project/undefined-symbol");
		expect(d.message).toContain("sensor 0");
	});
	it("M308 S0 A\"renamed\" after a real M308 S0 Y\"thermistor\" (reconfiguring a sensor that DOES exist) is not", () => {
		const files: Array<ProjectFile> = [{ path: "0:/sys/config.g", text: 'M308 S0 Y"thermistor"\nM308 S0 A"renamed"\n' }];
		expect(projectDiagsFor(files, "project/undefined-symbol")).toHaveLength(0);
	});
	it("the same shape for M950's heater form: H0 with no C anywhere is flagged", () => {
		const files: Array<ProjectFile> = [{ path: "0:/sys/config.g", text: "M950 H0 Q100\n" }];
		const [d] = projectDiagsFor(files, "project/undefined-symbol");
		expect(d.message).toContain("heater 0");
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

describe("project/pin-already-used (task 17, Part B, Step 8)", () => {
	it("the same physical pin claimed by two different commands is flagged - RRF itself refuses a second allocation at runtime", () => {
		const files: Array<ProjectFile> = [{ path: "0:/sys/config.g", text: 'M574 Y1 S1 P"io1.in"\nM558 K0 C"io1.in"\n' }];
		const [d] = projectDiagsFor(files, "project/pin-already-used");
		expect(d.message).toContain("io1.in");
	});
	it("two DIFFERENT pins are not", () => {
		const files: Array<ProjectFile> = [{ path: "0:/sys/config.g", text: 'M574 Y1 S1 P"io1.in"\nM558 K0 C"io2.in"\n' }];
		expect(projectDiagsFor(files, "project/pin-already-used")).toHaveLength(0);
	});
	it("re-stating \"nil\" twice is not - freeing a pin is never a conflict", () => {
		const files: Array<ProjectFile> = [{ path: "0:/sys/config.g", text: 'M950 H0 C"nil"\nM950 H1 C"nil"\n' }];
		expect(projectDiagsFor(files, "project/pin-already-used")).toHaveLength(0);
	});
	it("the same base pin name on two different CAN-address-prefixed boards is not a conflict", () => {
		const files: Array<ProjectFile> = [{ path: "0:/sys/config.g", text: 'M950 H0 C"121.out0"\nM950 H1 C"122.out0"\n' }];
		expect(projectDiagsFor(files, "project/pin-already-used")).toHaveLength(0);
	});

	// The user's own reported case: M574's P can name TWO endstop pins joined with "+"
	// (IoPort::AssignPort(s), a real, pervasive RRF convention - not M574-specific, see project.ts's
	// own pinSymbolSites doc comment for the other confirmed commands: M558 C, M955 C, M308 P/DHT).
	it("M574 P\"io2.in+io3.in\" (two endstop pins on one axis) is not flagged against itself - two distinct pins, not a self-conflict", () => {
		const files: Array<ProjectFile> = [{ path: "0:/sys/config.g", text: 'M574 Y1 S1 P"io2.in+io3.in"\n' }];
		expect(projectDiagsFor(files, "project/pin-already-used")).toHaveLength(0);
	});
	it("...but DOES correctly flag when one of those two pins is also claimed elsewhere", () => {
		const files: Array<ProjectFile> = [{ path: "0:/sys/config.g", text: 'M574 Y1 S1 P"io2.in+io3.in"\nM558 K0 C"io3.in"\n' }];
		const [d] = projectDiagsFor(files, "project/pin-already-used");
		expect(d.message).toContain("io3.in");
	});
});

describe("project/unknown-pin-name (task 17, Part B, Step 8)", () => {
	const BOARDS = new Map([[0, "btt/octopuspro1_1_h723"]]);

	it("a pin name that doesn't match any alias or the port.pin fallback on a known board is flagged", () => {
		const files: Array<ProjectFile> = [{ path: "0:/sys/config.g", text: 'M950 H0 C"not_a_real_pin_at_all"\n' }];
		const [d] = projectDiagsFor(files, "project/unknown-pin-name", { ...OPTS, boards: BOARDS });
		expect(d.message).toContain("not_a_real_pin_at_all");
	});
	it("a real alias on that board is not flagged", () => {
		const files: Array<ProjectFile> = [{ path: "0:/sys/config.g", text: 'M950 H0 C"bedtemp"\n' }];
		expect(projectDiagsFor(files, "project/unknown-pin-name", { ...OPTS, boards: BOARDS })).toHaveLength(0);
	});
	it("is skipped entirely when DiagnoseOptions.boards doesn't name a board for that pin's address - never guessed", () => {
		const files: Array<ProjectFile> = [{ path: "0:/sys/config.g", text: 'M950 H0 C"not_a_real_pin_at_all"\n' }];
		expect(projectDiagsFor(files, "project/unknown-pin-name")).toHaveLength(0);
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
