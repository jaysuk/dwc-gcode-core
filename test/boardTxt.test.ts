import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { BOARD_TXT_KEYS, boardTxtDefaults, findBoardTxtKey, parseBoardTxt } from "../src/files/boardTxt.js";
import { lookupPinName } from "../src/pins/tables.js";

const corpusDir = join(dirname(fileURLToPath(import.meta.url)), "corpus", "rrfboot");

function parse(text: string, options?: Parameters<typeof parseBoardTxt>[1]) {
	return parseBoardTxt(text, options);
}

describe("real rrfboot.txt files (the same loader as board.txt)", () => {
	const files = readdirSync(corpusDir).filter((f) => f.endsWith(".txt"));
	it("found the fixture files", () => {
		expect(files.length).toBe(48);
	});

	for (const file of files) {
		it(`${file}: parses with no problems and names its board`, () => {
			const text = readFileSync(join(corpusDir, file), "utf-8");
			const boardId = file.replace(/\.txt$/, "").split("__")[1];
			// `_f4` boards are the STM32F4 build, which has no H7-only key: the flag must not reject any of theirs.
			const mcu = boardId.endsWith("_f4") ? "f4" : "h7";
			const r = parse(text, { restricted: false, mcu });
			expect(r.problems).toEqual([]);
			// The name is the file's own choice, not always the directory's (fly/c5_1_0_h723 says `c5_1_0`).
			expect(typeof r.values["board"] === "string" && r.values["board"] !== "").toBe(true);
			expect(r.assignments.length).toBeGreaterThan(5);
			for (const entry of BOARD_TXT_KEYS) {
				const v = r.values[entry.key];
				expect(Array.isArray(v) ? v.length : 1).toBe(entry.count);
			}
			// Every pin the file sets is in canonical "A.13" form (or NoPin) - none is left as text.
			for (const a of r.assignments) {
				if (findBoardTxtKey(a.key)!.type !== "pin") continue;
				for (const p of Array.isArray(a.value) ? a.value : [a.value]) expect(p === null || /^[A-I]\.\d{1,2}$/.test(p as string)).toBe(true);
			}
		});
	}

	it("reads octopuspro1_1_h723 to the values its own file spells", () => {
		const r = parse(readFileSync(join(corpusDir, "btt__octopuspro1_1_h723.txt"), "utf-8"), { restricted: false });
		expect(r.values["board"]).toBe("octopuspro1_1_h723");
		expect(r.values["board.longName"]).toBe("BTT Octopus Pro V1.1 STM32H723"); // exactly 30 characters: the longest that fits
		expect(r.values["sdcard.internal.type"]).toBe(2);
		expect(r.values["SPI0.pins"]).toEqual(["A.5", "A.6", "A.7"]);
		expect(r.values["SPI3.pins"]).toEqual([null, null, null]);
		expect((r.values["stepper.stepPins"] as Array<string | null>).slice(0, 3)).toEqual(["F.13", "G.0", "F.11"]);
		// Only 8 of the 14 driver slots are given; the rest keep the default (NoPin).
		expect((r.values["stepper.stepPins"] as Array<string | null>).slice(8)).toEqual([null, null, null, null, null, null]);
		expect(r.values["wifi.serialRxTxPins"]).toEqual(["D.9", "D.8"]);
		expect(r.values["stepper.numSmartDrivers"]).toBe(8);
		expect(r.values["heat.spiTempSensorCSPins"]).toEqual(["F.8", null, null, null, null, null, null, null]);
		expect(r.values["can.readPin"]).toBe("D.0");
	});
});

describe("parseBoardTxt - lines, comments and keys", () => {
	it("starts from ClearConfig's defaults", () => {
		const r = parse("");
		expect(r.values).toEqual(boardTxtDefaults());
		expect(r.values["heat.thermistorSeriesResistor"]).toBe(4700);
		expect(r.values["atx.initialPowerOn"]).toBe(true);
		expect(r.values["sdcard.internal.type"]).toBe(0xfe);
		expect(r.values["serial.aux.rxTxPins"]).toEqual(["A.10", "A.9"]);
		expect(r.values["wifi.csPin"]).toBe("B.12");
		expect(r.values["can.readPin"]).toBe("B.8");
	});

	it("ignores blank lines and comments; a comment may also end a line early", () => {
		const r = parse([
			"", "   ", "# hash", "; semi", "// slash", "\t  # indented comment",
			"stepper.digipotFactor = 5 ; trailing comment",
			"power.voltage = # nothing before the comment",
		].join("\n"));
		expect(r.values["stepper.digipotFactor"]).toBe(5);
		expect(r.values["power.voltage"]).toBe(24); // untouched: the comment ended the line before a value
		// RRF says nothing about that line; we note it, and nothing else.
		expect(r.problems.map((p) => [p.kind, p.line])).toEqual([["missing-value", 8]]);
	});

	it("matches keys case-insensitively, tolerates blanks around '=', and uses the table's spelling", () => {
		const r = parse("STEPPER.DIGIPOTFACTOR\t=\t  7\nSdCard.Internal.SpiFrequencyHz=1000000\nsdcard.INTERNAL.type=3");
		expect(r.values["stepper.digipotFactor"]).toBe(7);
		expect(r.values["sdCard.internal.spiFrequencyHz"]).toBe(1000000);
		expect(r.values["sdcard.internal.type"]).toBe(3);
		expect(r.assignments.map((a) => a.key)).toEqual(["stepper.digipotFactor", "sdCard.internal.spiFrequencyHz", "sdcard.internal.type"]);
	});

	it("later lines win", () => {
		expect(parse("stepper.digipotFactor=1\nstepper.digipotFactor=2").values["stepper.digipotFactor"]).toBe(2);
	});

	it("reports a line with no '=' and a key RRF does not know, with RRF's own debug text", () => {
		const r = parse("just words\nnot.a.key = 1\n= 5");
		expect(r.problems.map((p) => [p.kind, p.line, p.rrfMessage])).toEqual([
			["missing-equals", 1, "Missing equals just words"],
			["unknown-key", 2, "Key not found or wrong type not.a.key"],
			["unknown-key", 3, "Key not found or wrong type "],
		]);
	});

	it("a comment before the '=' means there is no '='", () => {
		expect(parse("power.voltage ; = 5").problems.map((p) => p.kind)).toEqual(["missing-equals"]);
	});

	it("splits lines at CRLF, lone CR and LF alike, and numbers them", () => {
		const r = parse("power.voltage=1\r\nbogus\rpower.voltage=3\nbogus2\n");
		expect(r.values["power.voltage"]).toBe(3);
		expect(r.problems.map((p) => p.line)).toEqual([2, 4]);
	});

	it("reads a line over 255 characters as 255-character pieces (FileStore::ReadLine)", () => {
		const long = `board.longName="${"x".repeat(300)}"`; // the closing quote and more fall in the next piece
		const r = parse(long);
		// Piece 1 is 255 characters: the key, '=', the opening quote and 238 x's, with no closing quote - the
		// value is too long, so it is left alone; piece 2 has no '=' and is reported.
		expect(r.problems.map((p) => [p.kind, p.line])).toEqual([["value-too-long", 1], ["missing-equals", 1]]);
		expect(r.values["board.longName"]).toBe("");
	});

	it("splits at exactly 255 characters: a 255-character line is one line, a 256-character one is two", () => {
		const padTo = (n: number) => `power.voltage=7 #${"#".repeat(n - 18)}x`; // n characters, last one a stray letter
		const exact = parse(padTo(255));
		expect(padTo(255)).toHaveLength(255);
		expect(exact.values["power.voltage"]).toBe(7);
		expect(exact.problems).toEqual([]);
		const over = parse(padTo(256));
		expect(padTo(256)).toHaveLength(256);
		expect(over.values["power.voltage"]).toBe(7);
		expect(over.problems.map((p) => [p.kind, p.line])).toEqual([["missing-equals", 1]]); // the 256th character, alone
	});

	it("a UTF-8 byte-order mark spoils the first line, as it does in RRF, and says so", () => {
		const r = parse("﻿board.longName=\"A\"\nleds.diagnosticOn=0");
		expect(r.values["board.longName"]).toBe("");
		expect(r.values["leds.diagnosticOn"]).toBe(false);
		expect(r.problems).toHaveLength(1);
		expect(r.problems[0]).toMatchObject({ kind: "missing-equals", line: 1 });
		expect(r.problems[0].message).toContain("byte-order mark");
	});
});

describe("parseBoardTxt - scalar values", () => {
	it("cuts a value at the first character outside [A-Za-z0-9._]", () => {
		const r = parse("heat.thermistorSeriesResistor = 4700.5k # x\nstepper.digipotFactor = -1\npower.voltage = 12,5");
		expect(r.values["heat.thermistorSeriesResistor"]).toBe(4700.5);
		expect(r.values["stepper.digipotFactor"]).toBe(0); // '-' ends the value before it starts: empty reads as 0
		expect(r.values["power.voltage"]).toBe(12);
	});

	it("reads uint8/uint16 modulo their width, because the clamp after the narrowing is dead code", () => {
		const r = parse("sdcard.internal.type = 256\nsbc.spiChannel = 300\ncan.exp.address = 99999999999");
		expect(r.values["sdcard.internal.type"]).toBe(0);
		expect(r.values["sbc.spiChannel"]).toBe(44);
		expect(r.values["can.exp.address"]).toBe(255); // saturates to 0xFFFFFFFF first, whose low byte is 0xFF
	});

	it("saturates a uint32 and reads only the decimal prefix", () => {
		const r = parse("power.voltage = 99999999999\nwifi.clockReg = 0x10\nsdCard.external.spiFrequencyHz = 12abc");
		expect(r.values["power.voltage"]).toBe(0xffffffff);
		expect(r.values["wifi.clockReg"]).toBe(0);
		expect(r.values["sdCard.external.spiFrequencyHz"]).toBe(12);
	});

	it("reads a bool as exactly '1' or 'true' (any case); everything else is false", () => {
		const r = (v: string) => parse(`atx.powerPinInverted = ${v}`).values["atx.powerPinInverted"];
		expect([r("1"), r("true"), r("TRUE"), r("True")]).toEqual([true, true, true, true]);
		expect([r("0"), r("yes"), r("01"), r("11"), r("false"), r("2")]).toEqual([false, false, false, false, false, false]);
		// The default-true settings can be turned off, but an unreadable value is false, not "leave it".
		expect(parse("atx.initialPowerOn = off").values["atx.initialPowerOn"]).toBe(false);
	});

	it("reads a quoted string to the closing quote, whatever is inside", () => {
		const r = parse("board.longName = \"My ; board # 1\"  ; trailing");
		expect(r.values["board.longName"]).toBe("My ; board # 1");
	});

	it("an unquoted string stops at the first character outside [A-Za-z0-9._]", () => {
		expect(parse("board.longName = BTT-Octopus", { restricted: false }).values["board.longName"]).toBe("BTT");
	});

	it("leaves a string of 32 or more characters unset (strlen + 1 must be < MaxBoardNameLength)", () => {
		const ok = "a".repeat(30);
		const tooLong = "a".repeat(31);
		expect(parse(`board.longName="${ok}"`).values["board.longName"]).toBe(ok);
		const r = parse(`board.longName="${tooLong}"`);
		expect(r.values["board.longName"]).toBe("");
		expect(r.problems.map((p) => p.kind)).toEqual(["value-too-long"]);
	});

	it("ignores `board` in board.txt (restricted) but records it, and honours it in rrfboot.txt", () => {
		const text = "board = mine";
		const user = parse(text, { base: { ...boardTxtDefaults(), board: "shipped" } });
		expect(user.values["board"]).toBe("shipped");
		expect(user.assignments).toEqual([expect.objectContaining({ key: "board", value: "mine", ignored: "restricted" })]);
		const boot = parse(text, { restricted: false });
		expect(boot.values["board"]).toBe("mine");
		expect(boot.assignments[0].ignored).toBeUndefined();
	});

	it("reads a module type case-sensitively when it is a single value (only list entries are lowercased)", () => {
		expect(parse("wifi.moduleType = esp32").values["wifi.moduleType"]).toBe("esp32");
		const bad = parse("wifi.moduleType = ESP32");
		expect(bad.values["wifi.moduleType"]).toBeNull();
		expect(bad.problems.map((p) => p.kind)).toEqual(["unknown-name"]);
	});

	it("reports a missing value, and a value where a list is required", () => {
		const r = parse("power.voltage =\nstepper.stepPins = a.1");
		expect(r.problems.map((p) => [p.kind, p.key])).toEqual([["missing-value", "power.voltage"], ["wrong-shape", "stepper.stepPins"]]);
		expect(r.values["stepper.stepPins"]).toEqual(boardTxtDefaults()["stepper.stepPins"]);
	});
});

describe("parseBoardTxt - pin values", () => {
	const pin = (v: string, options?: Parameters<typeof parseBoardTxt>[1]) => parse(`leds.diagnostic = ${v}`, options).values["leds.diagnostic"];

	it("reads the port.pin forms StringToPin does", () => {
		expect(["a.1", "A.1", "PA1", "pa_1", "PA.1", "A1", "a_1"].map((v) => pin(v))).toEqual(Array(7).fill("A.1"));
		expect(pin("i.15")).toBe("I.15");
		expect(pin("PB_12")).toBe("B.12");
	});

	it("takes NoPin / nil in any case as NoPin, and anything StringToPin rejects as NoPin", () => {
		expect([pin("NoPin"), pin("NIL"), pin("j.1"), pin("a.16"), pin("a"), pin("")]).toEqual([null, null, null, null, null, null]);
	});

	it("keeps StringToPin's leniency: a digit prefix, and the pin number narrowed to a byte before the range check", () => {
		expect(pin("a.1x")).toBe("A.1"); // trailing junk after the digits is ignored
		expect(pin("a256")).toBe("A.0"); // 256 & 0xff = 0, which passes `< 16`
	});

	it("asks resolvePin (lowercased) before StringToPin, and reports what neither knows - only when asked to resolve", () => {
		const resolvePin = (n: string) => (n === "bedtemp" ? "F.3" : undefined);
		expect(pin("BedTemp", { resolvePin })).toBe("F.3");
		const miss = parse("leds.diagnostic = nosuchpin", { resolvePin });
		expect(miss.values["leds.diagnostic"]).toBeNull();
		expect(miss.problems.map((p) => p.kind)).toEqual(["unknown-pin"]);
		// Without a resolver an alias is just unread, not an error: the caller has told us nothing to check against.
		const none = parse("leds.diagnostic = bedtemp");
		expect(none.values["leds.diagnostic"]).toBeNull();
		expect(none.problems).toEqual([]);
		expect(none.assignments[0].raw).toBe("bedtemp");
	});

	it("resolves through a real board's rrfpins table", () => {
		const resolvePin = (n: string) => lookupPinName("btt/octopuspro1_1_h723", n)?.canonicalName;
		const r = parse("heat.tempSensePins = { bedtemp, PF4 }", { resolvePin });
		expect(r.problems).toEqual([]);
		expect(r.values["heat.tempSensePins"]).toEqual(expect.arrayContaining(["F.3", "F.4"]));
	});
});

describe("parseBoardTxt - { } lists", () => {
	const defaults = boardTxtDefaults();
	const steps = (text: string, options?: Parameters<typeof parseBoardTxt>[1]) => parse(text, options).values["stepper.stepPins"] as Array<string | null>;

	it("writes only the entries given and leaves the rest as they were", () => {
		const base = { ...defaults, "stepper.stepPins": Array.from({ length: 14 }, (_, i) => `E.${i}`) };
		const out = steps("stepper.stepPins = {a.1, b.2}", { base });
		expect(out.slice(0, 3)).toEqual(["A.1", "B.2", "E.2"]);
		expect(out).toHaveLength(14);
	});

	it("lowercases entries, accepts whitespace, a trailing comma, and ignores what follows the brace", () => {
		expect(steps("stepper.stepPins = {  PA1 ,\tB.2 , } trailing ; junk").slice(0, 3)).toEqual(["A.1", "B.2", null]);
	});

	it("an empty list sets nothing (RRF's size_t index wraps)", () => {
		const r = parse("stepper.stepPins = { }");
		expect(r.values["stepper.stepPins"]).toEqual(defaults["stepper.stepPins"]);
		expect(r.problems.map((p) => p.kind)).toEqual(["empty-array"]);
		expect(r.assignments).toEqual([]);
	});

	it("an empty entry reads as NoPin", () => {
		expect(steps("stepper.stepPins = {a.1,,a.3}").slice(0, 3)).toEqual(["A.1", null, "A.3"]);
	});

	it("more entries than the array holds discards the whole list", () => {
		const r = parse("heat.spiTempSensorCSPins = {a.1,a.2,a.3,a.4,a.5,a.6,a.7,a.8,a.9}");
		expect(r.values["heat.spiTempSensorCSPins"]).toEqual(defaults["heat.spiTempSensorCSPins"]);
		expect(r.problems.map((p) => [p.kind, p.rrfMessage])).toEqual([["array-overflow", "Error : Too many entries defined in config for array"]]);
		// Exactly the capacity is fine.
		expect((parse("heat.spiTempSensorCSPins = {a.1,a.2,a.3,a.4,a.5,a.6,a.7,a.8}").values["heat.spiTempSensorCSPins"] as Array<string>)[7]).toBe("A.8");
	});

	it("a bad separator, or a list not closed on its line, discards the whole list", () => {
		const bad = parse("stepper.stepPins = {a.1 a.2}");
		expect(bad.values["stepper.stepPins"]).toEqual(defaults["stepper.stepPins"]);
		expect(bad.problems.map((p) => p.kind)).toEqual(["array-syntax"]);
		const open = parse("stepper.stepPins = {a.1, a.2");
		expect(open.values["stepper.stepPins"]).toEqual(defaults["stepper.stepPins"]);
		expect(open.problems.map((p) => p.kind)).toEqual(["array-syntax"]);
		const open2 = parse("stepper.stepPins = {a.1, ");
		expect(open2.problems.map((p) => p.kind)).toEqual(["array-unterminated"]);
		// A leading '!' (an rrfpins.txt option) is not a value character, so it is a syntax error here.
		expect(parse("stepper.stepPins = {!a.1}").problems.map((p) => p.kind)).toEqual(["array-syntax"]);
	});

	it("a list for a scalar key, and a list for a key that does not exist, are reported", () => {
		const r = parse("power.voltage = {1}\nnot.a.key = {1}");
		expect(r.problems.map((p) => [p.kind, p.line])).toEqual([["wrong-shape", 1], ["unknown-key", 2]]);
	});

	it("reads driver types as lowercased names; an unknown name is null", () => {
		const r = parse("stepper.DriverType = {TMC2209, StepDir, tmc9999}");
		expect((r.values["stepper.DriverType"] as Array<string | null>).slice(0, 4)).toEqual(["tmc2209", "stepdir", null, "unknown"]);
		expect(r.problems.map((p) => p.kind)).toEqual(["unknown-name"]);
	});

	it("layers on a base: rrfboot.txt, then board.txt", () => {
		const boot = parse("board=x\nstepper.stepPins={a.1,a.2,a.3}\nstepper.numSmartDrivers=3", { restricted: false });
		const user = parse("stepper.stepPins={c.5}", { base: boot.values });
		expect((user.values["stepper.stepPins"] as Array<string | null>).slice(0, 3)).toEqual(["C.5", "A.2", "A.3"]);
		expect(user.values["stepper.numSmartDrivers"]).toBe(3);
		expect(boot.values["stepper.stepPins"]).not.toBe(user.values["stepper.stepPins"]);
		expect((boot.values["stepper.stepPins"] as Array<string | null>)[0]).toBe("A.1"); // the base is not mutated
	});
});

describe("parseBoardTxt - which keys exist", () => {
	it("drops the STM32H7-only keys on an F4 when told the MCU, and accepts everything otherwise", () => {
		const text = "SPI6.pins={a.1,a.2,a.3}\ncan.readPin=d.0";
		expect(parse(text, { mcu: "f4" }).problems.map((p) => p.kind)).toEqual(["unknown-key", "unknown-key"]);
		expect(parse(text, { mcu: "h7" }).problems).toEqual([]);
		expect(parse(text).problems).toEqual([]);
	});

	it("has one entry per key, none duplicated ignoring case, each with a default of the right shape", () => {
		const lower = BOARD_TXT_KEYS.map((k) => k.key.toLowerCase());
		expect(new Set(lower).size).toBe(lower.length);
		expect(BOARD_TXT_KEYS.length).toBe(75);
		const defaults = boardTxtDefaults();
		for (const k of BOARD_TXT_KEYS) expect(Array.isArray(defaults[k.key])).toBe(k.count > 1);
	});
});
