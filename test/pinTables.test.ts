import { describe, expect, it } from "vitest";

import { BOARD_PIN_TABLES, lookupPinName } from "../src/pins/tables.js";

const BOARD = "btt/octopuspro1_1_h723";

describe("BOARD_PIN_TABLES", () => {
	it("includes every generated community board, non-empty pin lists", () => {
		expect(BOARD_PIN_TABLES.length).toBeGreaterThan(40);
		for (const table of BOARD_PIN_TABLES) {
			expect(table.family).toBe("rrfpins-txt");
			expect(table.pins.length, table.boardId).toBeGreaterThan(0);
		}
	});

	it("merges a physical pin's aliases across multiple rrfpins.txt lines into one entry (task 17's own A.5/A.6/A.7 finding)", () => {
		const table = BOARD_PIN_TABLES.find((t) => t.boardId === BOARD);
		const a5 = table?.pins.find((p) => p.canonicalName === "A.5");
		expect(a5?.aliases).toContain("lcdsck");
		expect(a5?.aliases).toContain("sck");
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
});
