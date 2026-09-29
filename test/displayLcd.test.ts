import { describe, expect, it } from "vitest";

import { Lcd12864 } from "../src/display/lcd.js";
import { measureLcdText } from "../src/display/menuModel.js";

function lit(lcd: Lcd12864, column: number, rows: number): Array<number> {
	const out: Array<number> = [];
	for (let r = 0; r < rows; r++) if (lcd.getPixel(r, column)) out.push(r);
	return out;
}

// Glyph data is RRF's own table (Liberation Sans 7x11): '!' is one column, 0x017C little-endian
// (LSB = top row) = rows 2-6 and 8.
describe("Lcd12864 text", () => {
	it("draws a glyph from the font table, LSB at the top", () => {
		const lcd = new Lcd12864();
		lcd.setFont(0);
		lcd.setCursor(0, 0);
		lcd.print("!");
		expect(lit(lcd, 0, 11)).toEqual([2, 3, 4, 5, 6, 8]);
		expect(lit(lcd, 1, 11)).toEqual([]);
	});

	it("advances by the glyph's own width", () => {
		const lcd = new Lcd12864();
		lcd.setFont(0);
		lcd.setCursor(0, 0);
		lcd.print("!");
		expect(lcd.getColumn()).toBe(1);
	});

	it("kerns: a pair that can't touch loses a space column", () => {
		// '!' (a lone vertical bar) followed by '!' - with numSpaces 1 and no shared rows... they DO share rows,
		// so no kerning: 1 + 1 space + 1. Whereas ',' (row 9-10) then '"' (rows 2-3) share none: one column fewer.
		expect(measureLcdText(0, "!!")).toBe(3);
		const comma = measureLcdText(0, ",");
		const quote = measureLcdText(0, "\"");
		expect(measureLcdText(0, ",\"")).toBe(comma + quote + 1 - 1);
	});

	it("prints nothing past the right margin", () => {
		const lcd = new Lcd12864();
		lcd.setFont(1);
		lcd.setCursor(0, 0);
		lcd.setRightMargin(10);
		lcd.print("MMMMMM");
		expect(lcd.getColumn()).toBeLessThanOrEqual(10);
		for (let x = 10; x < 128; x++) expect(lit(lcd, x, 14)).toEqual([]);
	});

	it("inverted text is dark on a lit background", () => {
		const lcd = new Lcd12864();
		lcd.setFont(0);
		lcd.setCursor(0, 0);
		lcd.textInvert(true);
		lcd.print("!");
		// The glyph's lit rows are now the dark ones.
		expect(lit(lcd, 0, 11)).toEqual([0, 1, 7, 9, 10]);
	});

	it("measures off-screen without drawing", () => {
		const lcd = new Lcd12864();
		lcd.setFont(0);
		lcd.setCursor(lcd.numRows, 0);
		lcd.print("Hello");
		expect(lcd.getColumn()).toBeGreaterThan(10);
		expect(lcd.image.every((b) => b === 0)).toBe(true);
	});

	it("replaces characters the font lacks with the square box", () => {
		const a = new Lcd12864();
		const b = new Lcd12864();
		a.setFont(0); a.setCursor(0, 0); a.print("\u{1F600}");
		b.setFont(0); b.setCursor(0, 0); b.print("\u007F");
		expect(a.toAscii()).toEqual(b.toAscii());
	});

	it("a newline goes down one font height plus one, back to the left margin", () => {
		const lcd = new Lcd12864();
		lcd.setFont(0);
		lcd.setCursor(0, 5);
		lcd.print("!\n!");
		expect(lcd.getRow()).toBe(12);
		expect(lcd.getColumn()).toBe(1);
	});
});

describe("Lcd12864 drawing", () => {
	it("bitmapRow draws bits MSB first at any column offset, optionally inverted", () => {
		const lcd = new Lcd12864();
		lcd.bitmapRow(3, 5, 8, Uint8Array.of(0b10100000), false);
		expect(lcd.toAscii()[3].slice(0, 14)).toBe(".....#.#......");
		lcd.bitmapRow(4, 5, 8, Uint8Array.of(0b10100000), true);
		expect(lcd.toAscii()[4].slice(0, 14)).toBe("......#.#####.");
	});

	it("line draws a Bresenham diagonal", () => {
		const lcd = new Lcd12864();
		lcd.line(0, 0, 3, 3, true);
		expect([0, 1, 2, 3].map((i) => lcd.getPixel(i, i))).toEqual([true, true, true, true]);
	});

	it("clear resets the margins, so text fits the cleared block", () => {
		const lcd = new Lcd12864();
		lcd.clear(0, 0, 10, 20);
		lcd.setFont(0);
		lcd.print("MMMMMMMM");
		expect(lcd.getColumn()).toBeLessThanOrEqual(20);
	});
});
