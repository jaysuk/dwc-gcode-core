import { describe, expect, it } from "vitest";

import { BOARD_PIN_TABLES, lookupPinName } from "../src/pins/tables.js";

const BOARD = "btt/octopuspro1_1_h723";
const DUET_BOARD = "duet3mini";

describe("BOARD_PIN_TABLES", () => {
	it("includes every generated community board, non-empty pin lists", () => {
		const community = BOARD_PIN_TABLES.filter((t) => t.family === "rrfpins-txt");
		expect(community.length).toBeGreaterThan(40);
		for (const table of community) expect(table.pins.length, table.boardId).toBeGreaterThan(0);
	});

	it("includes every generated official Duet board, non-empty pin lists", () => {
		const duet = BOARD_PIN_TABLES.filter((t) => t.family === "duet-compiled");
		expect(duet.length).toBe(6); // Pins_FMDC.h deliberately excluded - see the generator's own doc comment
		for (const table of duet) expect(table.pins.length, table.boardId).toBeGreaterThan(0);
	});

	it("merges a physical pin's aliases across multiple rrfpins.txt lines into one entry (task 17's own A.5/A.6/A.7 finding)", () => {
		const table = BOARD_PIN_TABLES.find((t) => t.boardId === BOARD);
		const a5 = table?.pins.find((p) => p.canonicalName === "A.5");
		expect(a5?.aliases).toContain("lcdsck");
		expect(a5?.aliases).toContain("sck");
	});

	it("a Duet board's multi-alias pin (lcd.a0,exp1.7,spi.cs4) keeps every alias, first one canonical", () => {
		const table = BOARD_PIN_TABLES.find((t) => t.boardId === DUET_BOARD);
		const lcd = table?.pins.find((p) => p.canonicalName === "lcd.a0");
		expect(lcd?.aliases).toEqual(["lcd.a0", "exp1.7", "spi.cs4"]);
	});

	it("strips a Duet board's leading '!' hardware-inverted marker from an alias - invisible to what a user types", () => {
		const duetng = BOARD_PIN_TABLES.find((t) => t.boardId === "duetng");
		const bedheat = duetng?.pins.find((p) => p.aliases.includes("bedheat"));
		expect(bedheat?.aliases.some((a) => a.startsWith("!"))).toBe(false);
	});
});

describe("lookupPinName", () => {
	it("finds a pin by its real alias, case-insensitively", () => {
		expect(lookupPinName(BOARD, "bedtemp")?.canonicalName).toBe("F.3");
		expect(lookupPinName(BOARD, "BEDTEMP")?.canonicalName).toBe("F.3");
	});

	it("tolerates '_'/'-' the user typed that the file's own alias doesn't have", () => {
		expect(lookupPinName(BOARD, "bed_temp")?.canonicalName).toBe("F.3");
		expect(lookupPinName(BOARD, "bed-temp")?.canonicalName).toBe("F.3");
		expect(lookupPinName(BOARD, "_bedtemp")?.canonicalName).toBe("F.3");
	});

	it("resolves two different aliases for the same physical pin to the same canonicalName", () => {
		expect(lookupPinName(BOARD, "lcdsck")?.canonicalName).toBe(lookupPinName(BOARD, "sck")?.canonicalName);
	});

	it("does not match a genuinely different, unrelated alias", () => {
		expect(lookupPinName(BOARD, "bedtemp2")).toBeNull();
		expect(lookupPinName(BOARD, "notarealpin")).toBeNull();
	});

	it("falls back to the generic port.pin syntax when no alias matches", () => {
		// F.3 is a real, wired pin (bedtemp) - the numeric form should resolve to the SAME canonical id
		expect(lookupPinName(BOARD, "F.3")?.canonicalName).toBe("F.3");
		expect(lookupPinName(BOARD, "F3")?.canonicalName).toBe("F.3");
	});

	it("the port.pin fallback succeeds even for a pin absent from the board's own alias table - RRF's own StringToPin never checks, this is deliberate fidelity, not a bug", () => {
		const result = lookupPinName(BOARD, "H.15"); // an address unlikely to be a named pin on this board
		expect(result).not.toBeNull();
		expect(result?.canonicalName).toBe("H.15");
	});

	it("returns null for an unknown board id", () => {
		expect(lookupPinName("not-a-real-board", "bedtemp")).toBeNull();
	});

	it("returns null for text that's neither a known alias nor valid port.pin syntax", () => {
		expect(lookupPinName(BOARD, "!!!not-a-pin!!!")).toBeNull();
	});

	describe("duet-compiled boards (task 17 Step 6)", () => {
		it("finds a pin by its real alias - case-sensitively, matching the mainline's own LookupPinName", () => {
			expect(lookupPinName(DUET_BOARD, "lcd.a0")?.canonicalName).toBe("lcd.a0");
			expect(lookupPinName(DUET_BOARD, "LCD.A0")).toBeNull();
		});

		it("does NOT tolerate '_'/'-' the way rrfpins-txt boards do - the mainline's own matcher is a plain *p==*q compare", () => {
			expect(lookupPinName(DUET_BOARD, "lcd_a0")).toBeNull();
		});

		it("has NO generic port.pin fallback at all - confirmed by reading Config/Pins.cpp's complete LookupPinName (task 17 Decision 9): it returns false outright with no numeric fallback path", () => {
			// "out4" is a real alias on this board; its port.pin form must NOT also work
			expect(lookupPinName(DUET_BOARD, "out4")).not.toBeNull();
			expect(lookupPinName(DUET_BOARD, "PA11")).toBeNull(); // PA11 is out4's real chip address
			expect(lookupPinName(DUET_BOARD, "A.11")).toBeNull();
		});

		it("resolves a board-specific named-constant pinNames field (ModbusTxPinName) to its real string value", () => {
			expect(lookupPinName("duet3-mb6hc", "rs485.tx")?.canonicalName).toBe("rs485.tx");
		});

		it("finds a virtual/expander pin with no physical chip address (DuetNG's DueX/SX1509B rows)", () => {
			expect(lookupPinName("duetng", "duex.e2stop")?.canonicalName).toBe("duex.e2stop");
			expect(lookupPinName("duetng", "sx1509b.3")?.canonicalName).toBe("sx1509b.3");
		});
	});
});
