import { describe, expect, it } from "vitest";

import { parseMenu } from "../src/files/menu.js";
import { MENU_COMMAND_BUFFER_SIZE, buttonCommand, measureLcdText, resolveMenu } from "../src/display/menuModel.js";
import { classifyMenuValueCode, formatDuration, formatFixed } from "../src/display/menuValues.js";

// A fixed width so layout maths can be checked independently of the font tables.
const fixed = { measureText: () => 20 };

describe("resolveMenu: state RRF carries from line to line", () => {
	it("R, C and F stick until changed", () => {
		const m = resolveMenu('text R10 C5 F1 T"a" W10\ntext T"b" W10\ntext C50 T"c" W10\ntext R30 T"d" W10', fixed);
		expect(m.items.map((i) => [i.row, i.column, i.font])).toEqual([
			[10, 5, 1], // set explicitly
			[10, 15, 1], // same row/font, column advanced by the previous item's width
			[10, 50, 1], // C reset
			[30, 60, 1], // row reset, column carries on
		]);
	});

	it("an item with no W takes its measured width, a left-aligned text one extra column", () => {
		const m = resolveMenu('text T"abc"\ntext H1 T"abc"', fixed);
		expect(m.items.map((i) => i.width)).toEqual([21, 20]);
		expect(m.items[1].column).toBe(21);
	});

	it("value and alter default to 25 pixels wide; a button measures ` text ` with padding", () => {
		const m = resolveMenu('value N80\nalter N180\nbutton T"Go"');
		expect(m.items[0].width).toBe(25);
		expect(m.items[1].width).toBe(25);
		expect(m.items[2].width).toBe(measureLcdText(0, "Go", "button"));
		expect(m.items[2].width).toBe(measureLcdText(0, "Go", "text") + 2);
	});

	it("a files item spans the width from column 0, moves row down by its line count and resets the column", () => {
		const m = resolveMenu('text R0 C40 F0 T"x" W10\nfiles R12 N4 I"/gcodes" A"M32 #0"\ntext T"below" W5');
		const files = m.items[1];
		expect([files.column, files.width, files.height]).toEqual([0, 128, 4 * 11]);
		expect([m.items[2].row, m.items[2].column]).toEqual([12 + 4 * 11, 0]);
	});

	it("takes RRF's defaults for missing parameters", () => {
		const [t, b, f, i] = resolveMenu('text\nbutton\nfiles\nimage').items;
		expect(t.text).toBe("*");
		expect(b.text).toBe("*");
		expect(b.file).toBe("main");
		expect(f.directory).toBe("");
		expect(i.file).toBe("main");
		expect(b.action).toBeNull();
	});

	it("a bare quoted string is the text; the last of a repeated letter wins", () => {
		const m = resolveMenu('text "hi" T"there" F0 F1');
		expect(m.items[0].text).toBe("there");
		expect(m.items[0].font).toBe(1);
	});

	it("clamps F to the fonts a 12864 display has", () => {
		expect(resolveMenu('text F9 T"x"').items[0].font).toBe(1);
	});

	it("selectable kinds are button, alter and files", () => {
		const kinds = resolveMenu('text T"a"\nbutton T"b"\nvalue N80\nalter N180\nfiles N3\nimage L"x"').items.filter((i) => i.selectable).map((i) => i.kind);
		expect(kinds).toEqual(["button", "alter", "files"]);
	});

	it("reads visibility as a code or an object-model expression, and N{...} on a value", () => {
		const m = resolveMenu('text V3 T"a"\ntext V{state.status == "idle"} T"b"\nvalue N{heat.heaters[0].current}\ntext T"c"');
		expect(m.items[0].visibility).toEqual({ kind: "code", code: 3 });
		expect(m.items[1].visibility).toEqual({ kind: "expression", expression: 'state.status == "idle"' });
		expect(m.items[2].valueExpression).toBe("heat.heaters[0].current");
		expect(m.items[3].visibility).toEqual({ kind: "always" });
	});

	it("uses the image's own width to advance the column", () => {
		const m = resolveMenu('image L"logo.bin"\ntext T"after" W5', { imageSize: () => ({ width: 40, height: 20 }) });
		expect(m.items[1].column).toBe(40);
		expect(m.items[0].height).toBe(20);
	});
});

describe("resolveMenu: errors stop the menu, as RRF's loader does", () => {
	it("reports the first error and builds no items", () => {
		const m = resolveMenu('text T"ok"\nbogus T"x"\nbutton T"b" Q1');
		expect(m.firstError).toMatchObject({ message: "Unknown command", line: 2 });
		expect(m.items).toEqual([]);
		expect(m.errors.length).toBeGreaterThanOrEqual(2); // every problem is still listed
	});

	it("gives an error column both as written and as RRF counts it (leading whitespace is stripped by RRF)", () => {
		const doc = parseMenu('    button T"x" Z1');
		expect(doc.errors[0]).toMatchObject({ message: "Bad arg letter", column: 17, rrfColumn: 13 });
		expect(parseMenu('    bogus T"x"').errors[0]).toMatchObject({ message: "Unknown command", column: 5, rrfColumn: 1 });
		expect(parseMenu("  b1 x").errors[0]).toMatchObject({ message: "Bad command", column: 4, rrfColumn: 2 });
	});

	it("fails with RRF's own '|Menu buffer full' once the strings outgrow its 2500-byte buffer", () => {
		const long = "x".repeat(200);
		const lines = Array.from({ length: 14 }, () => `text T"${long}" W1`);
		const m = resolveMenu(lines.join("\n"), fixed);
		expect(MENU_COMMAND_BUFFER_SIZE).toBe(2500);
		expect(m.firstError).toMatchObject({ message: "|Menu buffer full", line: 13 }); // 12 * 201 = 2412, the 13th crosses 2500
		expect(m.items).toEqual([]);
	});

	it("does not trip on a menu that fits", () => {
		const lines = Array.from({ length: 12 }, () => `text T"${"x".repeat(200)}" W1`);
		expect(resolveMenu(lines.join("\n"), fixed).firstError).toBeNull();
	});
});

describe("buttonCommand (ButtonMenuItem::Select)", () => {
	it("puts the L file, quoted, where #0 is", () => {
		expect(buttonCommand("M98 P#0", "/macros/Preheat PLA")).toBe('M98 P"/macros/Preheat PLA"');
		expect(buttonCommand("M32 #0|return", "a.g")).toBe('M32 "a.g"|return');
	});

	it("a bare menu opens the menu named by L", () => {
		expect(buttonCommand("menu", "listFiles")).toBe("menu listFiles");
		expect(buttonCommand("MENU", "x")).toBe("MENU x");
	});

	it("leaves everything else alone", () => {
		expect(buttonCommand("M21", "main")).toBe("M21");
		expect(buttonCommand("menu other", "main")).toBe("menu other");
		expect(buttonCommand(null, "main")).toBe("");
	});
});

describe("legacy value codes (ValueMenuItem)", () => {
	it("classifies the documented codes", () => {
		expect(classifyMenuValueCode(80)).toEqual({ type: "float", percent: false, adjustable: false });
		expect(classifyMenuValueCode(180)).toMatchObject({ type: "float", adjustable: true });
		expect(classifyMenuValueCode(399)).toEqual({ type: "float", percent: true, adjustable: true });
		expect(classifyMenuValueCode(500)).toMatchObject({ percent: true });
		expect(classifyMenuValueCode(501)).toMatchObject({ type: "text" });
		expect(classifyMenuValueCode(520)).toMatchObject({ type: "int" });
		expect(classifyMenuValueCode(536)).toMatchObject({ type: "duration" });
	});

	it("shows *** for anything RRF has no meaning for", () => {
		expect(classifyMenuValueCode(600)).toBeNull();
		expect(classifyMenuValueCode(505)).toBeNull();
		expect(classifyMenuValueCode(540)).toBeNull();
	});

	it("formats like printf and ExpressionValue", () => {
		expect(formatFixed(21.456, 1)).toBe("21.5");
		expect(formatFixed(21, 0)).toBe("21");
		expect(formatDuration(3725)).toBe("1:02:05");
		expect(formatDuration(59)).toBe("0:00:59");
	});
});
