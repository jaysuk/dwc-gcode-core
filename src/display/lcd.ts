/**
 * A 128x64 monochrome LCD, ported from RepRapFirmware `3.7.0-rc.2` `src/Display/Lcd/Lcd.cpp` and
 * `MonoLcd.cpp` (the ST7920 12864 display's drawing model, minus the SPI): the same font tables, the same
 * auto-kerning, the same margin/inversion rules and the same 1-bit-per-pixel frame buffer, so text lands on
 * exactly the pixels a real display would light. Menu items (`menuDisplay.ts`) draw through this.
 *
 * Coordinates follow RRF: `row` is a pixel row from the top, `column` a pixel column from the left, and
 * "rows"/"columns" everywhere below are pixels, not character cells.
 */
import { type LcdFontData, FONT_11X14, FONT_7X11 } from "./lcdFontData.js";

export const LCD_ROWS = 64;
export const LCD_COLS = 128;

interface Font extends LcdFontData {
	bytes: Uint8Array;
	bytesPerColumn: number;
	bytesPerChar: number;
}

function decodeBase64(b64: string): Uint8Array {
	const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	const out: Array<number> = [];
	let bits = 0;
	let acc = 0;
	for (const ch of b64) {
		const v = alphabet.indexOf(ch);
		if (v < 0) continue; // padding
		acc = (acc << 6) | v;
		bits += 6;
		if (bits >= 8) {
			bits -= 8;
			out.push((acc >> bits) & 0xff);
		}
	}
	return Uint8Array.from(out);
}

function loadFont(data: LcdFontData): Font {
	const bytesPerColumn = Math.ceil(data.height / 8);
	return { ...data, bytes: decodeBase64(data.data), bytesPerColumn, bytesPerChar: bytesPerColumn * data.width + 1 };
}

/** The 12864 font list, indexed by a menu's `F` parameter (`Display.cpp`: `{ &font7x11, &font11x14 }`). */
let fonts: ReadonlyArray<Font> | null = null;
function getFonts(): ReadonlyArray<Font> {
	return (fonts ??= [loadFont(FONT_7X11), loadFont(FONT_11X14)]);
}

/** How many fonts a 12864 display has. */
export const LCD_FONT_COUNT = 2;

/** Row height in pixels of font `fontNumber` (clamped to the fonts that exist, as a menu's `F` is). */
export function lcdFontHeight(fontNumber: number): number {
	const list = getFonts();
	return list[Math.min(Math.max(fontNumber, 0), list.length - 1)].height;
}

export class Lcd12864 {
	readonly numRows = LCD_ROWS;
	readonly numCols = LCD_COLS;
	/** The frame buffer: `numRows` rows of `numCols / 8` bytes, most significant bit leftmost. */
	readonly image = new Uint8Array((LCD_ROWS * LCD_COLS) / 8);

	private row = 0;
	private column = 0;
	private leftMargin = 0;
	private rightMargin = LCD_COLS;
	private currentFont = 0;
	private textInverted = false;
	private lastCharColData = 0;
	private justSetCursor = true;

	get numFonts(): number {
		return getFonts().length;
	}

	/** Select a font; an out-of-range number is ignored (`Lcd::SetFont`). */
	setFont(fontNumber: number): void {
		if (fontNumber >= 0 && fontNumber < getFonts().length) {
			this.currentFont = fontNumber;
		}
	}

	/** Height in pixels of the current font, or of `fontNumber` when it names a font (else the current one). */
	getFontHeight(fontNumber?: number): number {
		const list = getFonts();
		const n = fontNumber !== undefined && fontNumber >= 0 && fontNumber < list.length ? fontNumber : this.currentFont;
		return list[n].height;
	}

	getRow(): number {
		return this.row;
	}

	getColumn(): number {
		return this.column;
	}

	setCursor(row: number, column: number): void {
		this.row = row;
		this.column = column;
		this.lastCharColData = 0;
		this.justSetCursor = true;
	}

	setLeftMargin(c: number): void {
		this.leftMargin = Math.min(c, this.numCols);
	}

	setRightMargin(r: number): void {
		this.rightMargin = Math.min(r, this.numCols);
	}

	/** Select normal or inverted text; changing it forces a space column, as RRF does. */
	textInvert(inverted: boolean): void {
		if (inverted !== this.textInverted) {
			this.textInverted = inverted;
			if (!this.justSetCursor) {
				const h = this.getFontHeight();
				this.lastCharColData = h < 32 ? ((1 << h) - 1) >>> 0 : 0xffffffff;
			}
		}
	}

	getPixel(y: number, x: number): boolean {
		if (y < 0 || y >= this.numRows || x < 0 || x >= this.numCols) return false;
		return (this.image[y * (this.numCols / 8) + (x >> 3)] & (0x80 >> (x & 7))) !== 0;
	}

	private put(y: number, x: number, on: boolean): void {
		const i = y * (this.numCols / 8) + (x >> 3);
		const mask = 0x80 >> (x & 7);
		if (on) this.image[i] |= mask;
		else this.image[i] &= ~mask;
	}

	/** Set or clear one pixel; like RRF, nothing at or beyond the right margin is drawn. */
	setPixel(y: number, x: number, on: boolean): void {
		if (y >= 0 && y < this.numRows && x >= 0 && x < this.rightMargin) this.put(y, x, on);
	}

	/** Fill a block from (top, left) to just before (bottom, right) - `MonoLcd::ClearBlock`. */
	clearBlock(top: number, left: number, bottom: number, right: number, foreground: boolean): void {
		const r = Math.min(right, this.numCols);
		const b = Math.min(bottom, this.numRows);
		for (let y = Math.max(top, 0); y < b; y++) {
			for (let x = Math.max(left, 0); x < r; x++) this.put(y, x, foreground);
		}
	}

	/** Clear part of the display, select non-inverted text and set the margins (`Lcd::Clear`). */
	clear(top: number, left: number, bottom: number, right: number): void {
		this.clearBlock(top, left, bottom, right, false);
		this.setCursor(top, left);
		this.textInverted = false;
		this.leftMargin = left;
		this.rightMargin = right;
	}

	clearAll(): void {
		this.clear(0, 0, this.numRows, this.numCols);
	}

	/** Write `numPixels` blank columns (light, or dark when inverted) at the cursor - `Lcd::WriteSpaces`. */
	writeSpaces(numPixels: number): void {
		let ySize = this.getFontHeight();
		if (this.row < this.numRows) {
			if (this.row + ySize > this.numRows) ySize = this.numRows - this.row;
			this.clearBlock(this.row, this.column, this.row + ySize, this.column + numPixels, this.textInverted);
		}
		this.column += numPixels;
		this.lastCharColData = 0;
		this.justSetCursor = false;
	}

	/** Blank from the cursor to the right margin, one font-height tall (`Lcd::ClearToMargin`). */
	clearToMargin(): void {
		if (this.column < this.rightMargin) this.writeSpaces(this.rightMargin - this.column);
	}

	/**
	 * Print text at the cursor. RRF feeds `printf` output through a UTF-8 decoder into `writeNative`;
	 * a JavaScript string is already decoded, so each code point goes straight to it (anything beyond
	 * the BMP becomes the 0x7F box, as RRF's `charVal < 0x10000` check does).
	 */
	print(text: string): void {
		for (const ch of text) {
			const cp = ch.codePointAt(0)!;
			this.writeNative(cp < 0x10000 ? cp : 0x7f);
		}
	}

	private writeNative(codePoint: number): void {
		if (codePoint === 0x0a) {
			this.setCursor(this.row + this.getFontHeight() + 1, this.leftMargin);
			return;
		}
		if (this.column < this.rightMargin) {
			const font = getFonts()[this.currentFont];
			let ch = codePoint;
			if (ch < font.startCharacter || ch > font.endCharacter) ch = 0x7f; // unsupported: the square box
			const fontHeight = font.height;
			const cmask = fontHeight < 32 ? ((1 << fontHeight) - 1) >>> 0 : 0xffffffff;
			const charBase = font.bytesPerChar * (ch - font.startCharacter);
			let numFontColumns = font.bytes[charBase];
			const colData = (col: number): number => {
				// RRF reads 4 bytes and masks to the font height; past the table end that is zeros.
				let v = 0;
				const at = charBase + 1 + col * font.bytesPerColumn;
				for (let i = 0; i < 4; i++) v |= (font.bytes[at + i] ?? 0) << (8 * i);
				return v >>> 0;
			};

			let columnsLeft = this.rightMargin - this.column;
			let numSpaces: number;
			if (this.lastCharColData !== 0) {
				// Add space columns first, one fewer when the pair kerns (auto-kerning).
				let thisCharColData = (colData(0) & cmask) >>> 0;
				if (thisCharColData === 0) thisCharColData = (colData(1) & cmask) >>> 0;
				numSpaces = font.numSpaces;
				const last = this.lastCharColData >>> 0;
				const kern = numSpaces >= 2
					? ((thisCharColData & last) >>> 0) === 0
					: ((((thisCharColData | (thisCharColData << 1)) >>> 0) & ((last | (last << 1)) >>> 0)) >>> 0) === 0;
				if (kern) numSpaces--;
				if (numSpaces > columnsLeft) numSpaces = columnsLeft;
				columnsLeft -= numSpaces;
			} else {
				numSpaces = 0;
			}
			if (numFontColumns > columnsLeft) numFontColumns = columnsLeft;

			let ySize = fontHeight;
			if (this.row >= this.numRows) ySize = 0; // still advances, so off-screen writes can measure text
			else if (ySize > this.numRows - this.row) ySize = this.numRows - this.row;

			if (ySize !== 0 && numSpaces !== 0) {
				this.clearBlock(this.row, this.column, this.row + ySize, this.column + numSpaces, this.textInverted);
			}
			this.column += numSpaces;

			for (let c = 0; c < numFontColumns; c++) {
				const data = colData(c);
				if (((data & cmask) >>> 0) !== 0) this.lastCharColData = (data & cmask) >>> 0;
				if (ySize !== 0) this.writeColumn(ySize, data);
				this.column++;
			}
		}
		this.justSetCursor = false;
	}

	/** One column of glyph data at (row, column): lit pixels, or dark ones when the text is inverted. */
	private writeColumn(ySize: number, columnData: number): void {
		const setVal = this.textInverted ? 0 : 1;
		if (this.column >= this.numCols) return;
		for (let r = 0; r < ySize; r++) {
			this.put(this.row + r, this.column, ((columnData >>> r) & 1) === setVal);
		}
	}

	/** Draw a line with Bresenham's algorithm (`Lcd::Line`). */
	line(y0: number, x0: number, y1: number, x1: number, on: boolean): void {
		const dx = Math.abs(x1 - x0);
		const dy = Math.abs(y1 - y0);
		const sx = x0 < x1 ? 1 : -1;
		const sy = y0 < y1 ? 1 : -1;
		let err = dx - dy;
		for (;;) {
			this.setPixel(y0, x0, on);
			if (x0 === x1 && y0 === y1) break;
			const e2 = err + err;
			if (e2 > -dy) {
				err -= dy;
				x0 += sx;
			}
			if (e2 < dx) {
				err += dx;
				y0 += sy;
			}
		}
	}

	/**
	 * Draw one bitmap row of `width` bits (MSB first, `data` padded to whole bytes) with its left edge at
	 * `left`, optionally inverted - `MonoLcd::BitmapRow`.
	 */
	bitmapRow(top: number, left: number, width: number, data: Uint8Array, invert: boolean): void {
		let w = width;
		if (left + w > this.numCols) w = this.numCols - left;
		if (w <= 0 || top < 0 || top >= this.numRows) return;
		for (let i = 0; i < w; i++) {
			const bit = ((data[i >> 3] ?? 0) >> (7 - (i & 7))) & 1;
			this.put(top, left + i, (bit === 1) !== invert);
		}
	}

	/** The frame buffer as one string per row (`#` lit, `.` dark) - handy in tests and logs. */
	toAscii(): Array<string> {
		const rows: Array<string> = [];
		for (let y = 0; y < this.numRows; y++) {
			let s = "";
			for (let x = 0; x < this.numCols; x++) s += this.getPixel(y, x) ? "#" : ".";
			rows.push(s);
		}
		return rows;
	}
}
