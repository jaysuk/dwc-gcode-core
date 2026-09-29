import { describe, expect, it } from "vitest";

import { type DisplayMessageBox, MenuDisplay, type MenuHost } from "../src/display/menuDisplay.js";

function makeHost(files: Record<string, string>, extra: Partial<MenuHost> = {}) {
	const sent: Array<string> = [];
	let clock = 0;
	const host: MenuHost = {
		readMenuFile: (name) => files[name],
		execute: (cmd) => { sent.push(cmd); return true; },
		now: () => clock,
		...extra,
	};
	return { host, sent, advance: (ms: number) => { clock += ms; } };
}

function open(files: Record<string, string>, extra: Partial<MenuHost> = {}) {
	const h = makeHost(files, extra);
	const d = new MenuDisplay(h.host);
	d.start();
	d.refresh();
	return { ...h, d };
}

/** Whether any pixel is lit in the pixel rectangle. */
function litIn(d: MenuDisplay, top: number, left: number, bottom: number, right: number): boolean {
	for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) if (d.lcd.getPixel(y, x)) return true;
	return false;
}

describe("MenuDisplay: drawing", () => {
	it("draws a text item where the file says", () => {
		const { d } = open({ main: 'text R20 C30 F0 T"Hi"' });
		expect(litIn(d, 20, 30, 31, 45)).toBe(true);
		expect(litIn(d, 0, 0, 19, 128)).toBe(false); // nothing above it
	});

	it("draws selectable items before the others, and highlights the first on a turn of the encoder", () => {
		const { d } = open({ main: 'button R0 C0 T"A"\nbutton R20 C0 T"B"' });
		expect(d.highlighted).toBeNull();
		d.encoder(1);
		expect(d.highlighted?.text).toBe("A");
		d.refresh();
		// Highlighted button is a lit block (its own padding columns lit too).
		expect(d.lcd.getPixel(0, 0)).toBe(true);
	});

	it("moves the highlight through the buttons and wraps round", () => {
		const { d } = open({ main: 'button R0 C0 T"A"\nbutton R20 C0 T"B"\nbutton R40 C0 T"C"' });
		d.encoder(1);
		d.encoder(1);
		expect(d.highlighted?.text).toBe("B");
		d.encoder(1);
		d.encoder(1);
		expect(d.highlighted?.text).toBe("A"); // C, then wraps round
		d.encoder(-1);
		expect(d.highlighted?.text).toBe("C");
	});

	it("moves one item per turn however many clicks arrive (RRF's AdvanceHighlightedItem never updates its cursor inside the loop)", () => {
		const { d } = open({ main: 'button R0 C0 T"A"\nbutton R20 C0 T"B"\nbutton R40 C0 T"C"' });
		d.encoder(1);
		d.encoder(5);
		expect(d.highlighted?.text).toBe("B");
	});

	it("right-aligns and centres text inside an item's width", () => {
		const left = open({ main: 'text R0 C0 W60 T"!"' }).d;
		const right = open({ main: 'text R0 C0 W60 H2 T"!"' }).d;
		const centre = open({ main: 'text R0 C0 W60 H1 T"!"' }).d;
		const col = (d: MenuDisplay) => { for (let x = 0; x < 128; x++) if (litIn(d, 0, x, 11, x + 1)) return x; return -1; };
		expect(col(left)).toBe(0);
		expect(col(right)).toBe(58); // width 60 - glyph 1 - 1 spare pixel at the end
		expect(col(centre)).toBe(29);
	});
});

describe("MenuDisplay: navigation (Menu::EncoderAction)", () => {
	const files = {
		main: 'button R0 C0 T"Go" A"menu" L"sub"\nbutton R20 C0 T"Home" A"G28"',
		sub: 'text T"sub"\nbutton R20 C0 T"Back" A"return"',
	};

	it("a bare `menu` action opens the menu named by L, and `return` comes back", () => {
		const { d } = open(files);
		d.encoder(1);
		d.encoder(0);
		expect(d.currentMenu).toBe("sub");
		expect(d.menuStack).toEqual(["main", "sub"]);
		d.refresh();
		d.encoder(1);
		d.encoder(0);
		expect(d.currentMenu).toBe("main");
	});

	it("sends G-code, M-code and T-code actions to the host, in order", () => {
		const { d, sent } = open({ main: 'button T"x" A"G28 X|M117 hi|T1"' });
		d.encoder(1);
		d.encoder(0);
		expect(sent).toEqual(["G28 X", "M117 hi", "T1"]);
	});

	it("substitutes the quoted L file for #0 in the sent command", () => {
		const { d, sent } = open({ main: 'button T"Preheat" A"M98 P#0" L"/macros/PLA"' });
		d.encoder(1);
		d.encoder(0);
		expect(sent).toEqual(['M98 P"/macros/PLA"']);
	});

	it("ignores actions that aren't G/M/T, menu or return", () => {
		const { d, sent } = open({ main: 'button T"x" A"shutdown"' });
		d.encoder(1);
		d.encoder(0);
		expect(sent).toEqual([]);
	});

	it("nests at most eight menus deep", () => {
		const { d } = open({ main: 'button T"in" A"menu" L"main"' });
		for (let i = 0; i < 12; i++) {
			d.encoder(1); // highlight the button in the freshly loaded menu
			d.encoder(0); // press it
			d.refresh();
		}
		expect(d.menuStack.length).toBe(8);
	});

	it("touching a button presses it", () => {
		const { d, sent } = open({ main: 'button R30 C10 T"Go" A"G28"' });
		d.touch(15, 33);
		expect(sent).toEqual(["G28"]);
	});

	it("a touch too far from any button does nothing", () => {
		const { d, sent } = open({ main: 'button R30 C10 T"Go" A"G28"' });
		d.touch(100, 5);
		expect(sent).toEqual([]);
	});
});

describe("MenuDisplay: errors and timeouts", () => {
	it("shows RRF's error screen, with the line and column, for a bad menu file", () => {
		const { d } = open({ main: 'text T"ok"\n  button T"x" Z1' });
		expect(d.error).toMatchObject({ message: "Bad arg letter", file: "main", line: 2, column: 13 });
		// The screen isn't the menu: the 'ok' text is gone and there's text below the top row.
		expect(litIn(d, 12, 0, 40, 100)).toBe(true);
	});

	it("says so when the file isn't there", () => {
		const { d } = open({});
		expect(d.error).toMatchObject({ message: "File not found", file: "main", line: 0 });
	});

	it("leaves the error screen for `main` after six seconds, or on a push", () => {
		const { d, advance } = open({ main: 'button T"x" Z1' });
		expect(d.error).not.toBeNull();
		advance(5000);
		d.refresh();
		expect(d.error).not.toBeNull();
		advance(1500);
		d.refresh();
		// Reloaded main (still broken, so the same error again - but it went through the reload).
		expect(d.menuStack).toEqual(["main"]);
	});

	it("goes back to `main` after 20 seconds without input", () => {
		const files = { main: 'button T"Go" A"menu" L"sub"', sub: 'button T"b"' };
		const { d, advance } = open(files);
		d.encoder(1);
		d.encoder(0);
		expect(d.currentMenu).toBe("sub");
		advance(19000);
		d.refresh();
		expect(d.currentMenu).toBe("sub");
		advance(2000);
		d.refresh();
		expect(d.menuStack).toEqual(["main"]);
	});

	it("shows the fixed 'Mount SD' menu while the SD card is unmounted", () => {
		const { d, sent } = open({ main: 'text T"x"' }, { sdMounted: () => false });
		expect(d.items.map((i) => i.text)).toEqual(["Mount SD", "No SD Card Found"]);
		d.encoder(1);
		d.encoder(0);
		expect(sent).toEqual(["M21"]);
	});
});

describe("MenuDisplay: values and visibility", () => {
	it("shows a legacy value with its decimals, and a % for percentages", () => {
		const { d } = open({ main: 'value R0 C0 W60 D1 N80\nvalue R20 C0 W60 N500' }, { legacyValue: (c) => (c === 80 ? 21.456 : c === 500 ? 100 : 0) });
		const plain = open({ main: 'text R0 C0 W60 T"21.5"\ntext R20 C0 W60 T"100%"' }).d;
		expect(d.lcd.toAscii().slice(0, 40)).toEqual(plain.lcd.toAscii().slice(0, 40));
	});

	it("shows *** for a value code RRF doesn't know", () => {
		const { d } = open({ main: 'value R0 C0 W40 N999' });
		const ref = open({ main: 'text R0 C0 W40 T"***"' }).d;
		expect(d.lcd.toAscii()).toEqual(ref.lcd.toAscii());
	});

	it("redraws a value when the machine's value changes (and only then)", () => {
		let temp = 20;
		const { d } = open({ main: 'value R0 C0 W40 N80' }, { legacyValue: () => temp });
		const before = d.lcd.toAscii();
		d.refresh();
		expect(d.lcd.toAscii()).toEqual(before);
		temp = 200;
		d.refresh();
		expect(d.lcd.toAscii()).not.toEqual(before);
	});

	it("evaluates an N{...} expression through the host, and shows *** when it can't", () => {
		const good = open({ main: 'value R0 C0 W50 N{a}' }, { evaluateValue: () => ({ type: "text", value: "hot" }) }).d;
		const text = open({ main: 'text R0 C0 W50 T"hot"' }).d;
		expect(good.lcd.toAscii()).toEqual(text.lcd.toAscii());
		const bad = open({ main: 'value R0 C0 W50 N{a}' }, { evaluateValue: () => undefined }).d;
		expect(bad.lcd.toAscii()).toEqual(open({ main: 'text R0 C0 W50 T"***"' }).d.lcd.toAscii());
	});

	it("hides an item whose visibility condition is false, and erases it if it was showing", () => {
		let printing = false;
		const { d } = open({ main: 'text R0 C0 V3 T"idle only"' }, { visibilityCode: (c) => (c === 3 ? !printing : true) });
		expect(litIn(d, 0, 0, 11, 60)).toBe(true);
		printing = true;
		d.refresh();
		expect(litIn(d, 0, 0, 11, 60)).toBe(false);
		printing = false;
		d.refresh();
		expect(litIn(d, 0, 0, 11, 60)).toBe(true);
	});

	it("evaluates V{...} through the host; an expression with no host is false", () => {
		const shown = open({ main: 'text R0 C0 V{x} T"a"' }, { evaluateCondition: () => true }).d;
		expect(litIn(shown, 0, 0, 11, 30)).toBe(true);
		const hidden = open({ main: 'text R0 C0 V{x} T"a"' }).d;
		expect(litIn(hidden, 0, 0, 11, 30)).toBe(false);
	});

	it("skips hidden buttons when moving the highlight", () => {
		const { d } = open({ main: 'button R0 C0 V3 T"A"\nbutton R20 C0 T"B"' }, { visibilityCode: (c) => c !== 3 });
		d.encoder(1);
		expect(d.highlighted?.text).toBe("B");
	});
});

describe("MenuDisplay: alter (encoder adjusts a value)", () => {
	function alter(code: number, start: number) {
		const commits: Array<[number, number]> = [];
		const h = open({ main: `alter R0 C0 W40 N${code}` }, {
			legacyValue: () => start,
			setLegacyValue: (c, v) => commits.push([c, v]),
		});
		h.d.encoder(1); // highlight
		h.d.encoder(0); // select for adjustment
		return { ...h, commits };
	}

	it("a push selects it for adjustment; turning changes the value and a second push commits", () => {
		const { d, commits } = alter(180, 60); // N180 is the bed (item 80): plain +/- steps
		expect(d.adjusting).toBe(true);
		d.encoder(3);
		expect(commits).toEqual([]); // nothing is committed while turning
		d.encoder(0);
		expect(d.adjusting).toBe(false);
		expect(commits).toEqual([[180, 63]]);
	});

	it("a tool heater target below 95 jumps up to 95 and back down to 0 (RRF's shortcut)", () => {
		const up = alter(101, 0);
		up.d.encoder(1);
		up.d.encoder(0);
		expect(up.commits).toEqual([[101, 95]]);
		const down = alter(101, 100);
		down.d.encoder(-10);
		down.d.encoder(0);
		expect(down.commits).toEqual([[101, -273.15]]); // < 95 -> 0 -> committed as "off"
	});

	it("caps a heater target at the host's temperature limit", () => {
		const commits: Array<[number, number]> = [];
		const { d } = open({ main: "alter R0 C0 W40 N101" }, { legacyValue: () => 250, temperatureLimit: () => 260, setLegacyValue: (c, v) => commits.push([c, v]) });
		d.encoder(1); d.encoder(0); d.encoder(50); d.encoder(0);
		expect(commits).toEqual([[101, 260]]);
	});

	it("fan percentages stay between 0 and 100, the speed factor between 10 and 500", () => {
		const fan = alter(300, 99);
		fan.d.encoder(50); fan.d.encoder(0);
		expect(fan.commits).toEqual([[300, 100]]);
		const speed = alter(500, 12);
		speed.d.encoder(-50); speed.d.encoder(0);
		expect(speed.commits).toEqual([[500, 10]]);
	});

	it("axis and baby-step adjustments are sent to the machine as they're turned", () => {
		const z = alter(512, 0);
		z.d.encoder(2);
		expect(z.sent).toEqual(["M120 G91 G1 F3000 Z0.04 M121"]); // 0.02 mm per click on Z
		const x = alter(510, 0);
		x.d.encoder(-3);
		expect(x.sent).toEqual(["M120 G91 G1 F3000 X-0.30 M121"]); // 0.1 mm per click elsewhere
		const baby = alter(521, 0);
		baby.d.encoder(1);
		expect(baby.sent).toEqual(["M290 Z0.02"]);
	});
});

describe("MenuDisplay: files", () => {
	const listing = {
		"/gcodes/": [{ name: "a.gcode", isDirectory: false }, { name: "sub", isDirectory: true }, { name: ".hidden", isDirectory: false }, { name: "b.gcode", isDirectory: false }],
		"/gcodes/sub/": [{ name: "c.gcode", isDirectory: false }],
	} as Record<string, Array<{ name: string; isDirectory: boolean }>>;

	function files() {
		return open({ main: 'files R0 N3 I"/gcodes" A"M32 #0"' }, { listDirectory: (p) => listing[p] });
	}

	it("lists the directory, skipping dot files, and sends the chosen file to the action", () => {
		const { d, sent } = files();
		d.refresh(); // first pass reads the directory, this one draws it
		d.encoder(1); // highlight the item
		d.encoder(0);
		expect(sent).toEqual(['M32 "/gcodes/a.gcode"']);
	});

	it("scrolls inside the list before moving on, and enters a directory then goes '..'", () => {
		const { d, sent } = files();
		d.refresh();
		d.encoder(1); // highlight the item (first entry)
		d.encoder(1); // -> sub
		d.encoder(0); // enter the directory
		d.refresh();
		d.encoder(1); // in a subdirectory ".." is entry 0; c.gcode is entry 1
		d.encoder(0);
		expect(sent).toEqual(['M32 "/gcodes/sub/c.gcode"']);
	});

	it("waits, redrawing later, while the host is still fetching a listing", () => {
		let ready = false;
		const { d } = open({ main: 'files R0 N3 I"/gcodes" A"M32 #0"' }, { listDirectory: (p) => (ready ? listing[p] : undefined) });
		expect(litIn(d, 0, 0, 33, 128)).toBe(false);
		ready = true;
		d.refresh();
		expect(litIn(d, 0, 0, 33, 128)).toBe(true);
	});

	it("shows a '>' by the selected entry and lists three lines at most", () => {
		const { d } = files();
		d.refresh();
		d.encoder(1);
		d.refresh();
		expect(litIn(d, 0, 0, 33, 128)).toBe(true);
		expect(litIn(d, 33, 0, 64, 128)).toBe(false);
	});
});

describe("MenuDisplay: images", () => {
	it("draws an image item's bitmap (columns, rows, then padded row data)", () => {
		const bitmap = Uint8Array.of(8, 2, 0b10000001, 0b11111111);
		const { d } = open({ main: 'image R5 C7 L"logo"' }, { readImage: () => bitmap });
		expect(d.lcd.getPixel(5, 7)).toBe(true);
		expect(d.lcd.getPixel(5, 8)).toBe(false);
		expect(d.lcd.getPixel(5, 14)).toBe(true);
		expect(d.lcd.getPixel(6, 10)).toBe(true);
	});

	it("draws nothing for a missing image", () => {
		const { d } = open({ main: 'image R5 C7 L"nope"' });
		expect(d.lcd.image.every((b) => b === 0)).toBe(true);
	});
});

describe("MenuDisplay: robustness", () => {
	it("a `return` in the bottom menu stays put instead of falling off the stack", () => {
		const { d } = open({ main: 'button T"x" A"return"' });
		d.encoder(1);
		d.encoder(0);
		expect(d.menuStack).toEqual(["main"]);
		expect(d.error).toBeNull();
	});
});

// M291 message boxes - RRF 3.7.0-rc.2 src/Display/Menu.cpp `DisplayMessageBox` / `ClearMessageBox` (lines 138-199) and
// the message-box handling in src/Display/Display.cpp `Spin` (lines 124-148). With font 0 (7x11) the layout works out to
// rowHeight 12, top 7, left 7, right 121, available width 114 - every coordinate below is that arithmetic, not a snapshot.
describe("MenuDisplay: M291 message boxes", () => {
	// Columns with a lit pixel in the rows [top, bottom), INSIDE the border (columns 5-122): the border itself is
	// lit on every row, so counting it would make every check on what the box draws pass whatever it drew.
	const litColumns = (d: MenuDisplay, top: number, bottom: number): Array<number> => {
		const cols: Array<number> = [];
		for (let x = 5; x < 123; x++) {
			for (let y = top; y < bottom; y++) if (d.lcd.getPixel(y, x)) { cols.push(x); break; }
		}
		return cols;
	};
	/** The title (the box's first `text` item - selectable items come first in `items`, RRF's draw order). */
	const titleOf = (d: MenuDisplay): string | undefined => d.items.find((i) => i.kind === "text")?.text;
	const TITLE_ROWS: [number, number] = [7, 18];
	const MESSAGE_ROWS: [number, number] = [19, 30];
	const JOG_ROWS: [number, number] = [31, 42];
	const BUTTON_ROWS: [number, number] = [43, 54];

	it("draws a border 4 pixels in from every edge, with the interior cleared", () => {
		// A menu item that runs through where the interior will be, and one outside the border.
		const { d } = open({ main: 'text R30 C10 F0 T"underneath"\ntext R0 C0 F0 T"top"' });
		expect(litIn(d, 30, 10, 41, 60)).toBe(true);
		d.displayMessageBox({ title: "", message: "", mode: 0 });
		// The four edges: rows 4 and 59, columns 4 and 123, every pixel on each.
		for (let x = 4; x <= 123; x++) {
			expect(d.lcd.getPixel(4, x), `top edge x=${x}`).toBe(true);
			expect(d.lcd.getPixel(59, x), `bottom edge x=${x}`).toBe(true);
		}
		for (let y = 4; y <= 59; y++) {
			expect(d.lcd.getPixel(y, 4), `left edge y=${y}`).toBe(true);
			expect(d.lcd.getPixel(y, 123), `right edge y=${y}`).toBe(true);
		}
		// Interior: RRF clears (5,5)..(59,123) exclusive, so what was under the box is gone (an empty title/message draws nothing)...
		expect(litIn(d, 5, 5, 59, 123)).toBe(false);
		// ...but nothing outside the border is touched: RRF never clears the whole screen, only the interior.
		expect(litIn(d, 0, 0, 4, 20)).toBe(true);
		expect(d.lcd.getPixel(3, 4)).toBe(false);
		expect(d.lcd.getPixel(60, 64)).toBe(false);
	});

	it("centres the title and the message, each on its own row", () => {
		const { d } = open({ main: 'text R0 C0 F0 T"x"' });
		d.displayMessageBox({ title: "Title", message: "A message", mode: 0 });
		d.refresh(); // the items are added by displayMessageBox and drawn by the next refresh, as in RRF
		for (const rows of [TITLE_ROWS, MESSAGE_ROWS]) {
			const cols = litColumns(d, ...rows);
			expect(cols.length).toBeGreaterThan(0);
			const centre = (cols[0] + cols[cols.length - 1]) / 2;
			expect(Math.abs(centre - 64), `rows ${rows}`).toBeLessThanOrEqual(3); // the middle of the 114 pixel band starting at column 7
		}
		// the jog and button rows are empty for mode 0
		expect(litIn(d, JOG_ROWS[0], 5, BUTTON_ROWS[1], 123)).toBe(false);
	});

	it("shows only what fits of a message that is too long: it is cut at the box, not wrapped", () => {
		const { d } = open({ main: 'text R0 C0 F0 T"x"' });
		d.displayMessageBox({ title: "T".repeat(40), message: "m".repeat(60), mode: 0 });
		d.refresh();
		for (const rows of [TITLE_ROWS, MESSAGE_ROWS]) {
			const cols = litColumns(d, ...rows);
			expect(cols[cols.length - 1], `rows ${rows} fill the band`).toBeGreaterThanOrEqual(115); // it ran out of room, not text
			expect(litIn(d, rows[0], 121, rows[1], 123), `rows ${rows}`).toBe(false); // the band ends at 121 (7 + 114); the border is at 123
		}
		expect(litIn(d, JOG_ROWS[0], 5, JOG_ROWS[1], 123)).toBe(false); // and no second message row
	});

	describe("buttons (mode bit 2 = OK -> M292 P0, bit 1 = Cancel -> M292 P1)", () => {
		const buttons = (mode: number) => {
			const o = open({ main: 'text R0 C0 F0 T"x"' });
			o.d.displayMessageBox({ title: "t", message: "m", mode });
			o.d.refresh();
			return o;
		};

		it("S0 has no buttons and nothing to select", () => {
			const { d, sent } = buttons(0);
			expect(d.items.filter((i) => i.selectable)).toEqual([]);
			d.encoder(1);
			d.encoder(0);
			expect(sent).toEqual([]);
			expect(litIn(d, BUTTON_ROWS[0], 5, BUTTON_ROWS[1], 123)).toBe(false);
		});

		it("S2 has an OK button at the left, 30 pixels wide, that sends M292 P0", () => {
			const { d, sent } = buttons(2);
			const selectable = d.items.filter((i) => i.selectable);
			expect(selectable.map((i) => [i.kind, i.text, i.row, i.column, i.width])).toEqual([["button", "OK", 43, 7, 30]]);
			d.encoder(1);
			expect(d.highlighted?.text).toBe("OK");
			d.encoder(0);
			expect(sent).toEqual(["M292 P0"]);
			expect(litColumns(d, ...BUTTON_ROWS).every((x) => x >= 7 && x < 37)).toBe(true);
		});

		it("S3 has OK at the left and Cancel at the right edge, and the encoder moves between them", () => {
			const { d, sent } = buttons(3);
			const selectable = d.items.filter((i) => i.selectable);
			expect(selectable.map((i) => [i.text, i.column, i.width])).toEqual([["OK", 7, 30], ["Cancel", 91, 30]]); // right - 30 = 121 - 30
			d.encoder(1);
			d.encoder(1);
			expect(d.highlighted?.text).toBe("Cancel");
			d.encoder(0);
			expect(sent).toEqual(["M292 P1"]);
		});

		it("S1 (the web interface's Close box) shows a Cancel button on the display - bit 1 is Cancel, whatever the mode is called elsewhere", () => {
			const { d, sent } = buttons(1);
			expect(d.items.filter((i) => i.selectable).map((i) => i.text)).toEqual(["Cancel"]);
			d.encoder(1);
			d.encoder(0);
			expect(sent).toEqual(["M292 P1"]);
		});

		it("a touch on a button presses it", () => {
			const { d, sent } = buttons(3);
			d.touch(20, 48); // inside OK (columns 7-36, rows 43-53)
			expect(sent).toEqual(["M292 P0"]);
			d.touch(100, 48); // inside Cancel
			expect(sent).toEqual(["M292 P0", "M292 P1"]);
		});

		it("highlighting a button inverts it", () => {
			const { d } = buttons(2);
			const before = d.lcd.toAscii().slice(43, 54).join("");
			d.encoder(1);
			d.refresh();
			expect(d.lcd.toAscii().slice(43, 54).join("")).not.toBe(before);
			expect(d.lcd.getPixel(43, 7)).toBe(true); // the button's own padding column is lit when highlighted
		});
	});

	describe("jog controls (X, Y, Z = N510, N511, N512, a quarter of the width each)", () => {
		it("adds a value item per axis asked for, in X, Y, Z order and before the buttons", () => {
			const { d } = open({ main: 'text R0 C0 F0 T"x"' });
			d.displayMessageBox({ title: "t", message: "m", mode: 3, controls: { x: true, y: true, z: true } });
			const selectable = d.items.filter((i) => i.selectable);
			expect(selectable.map((i) => [i.kind, i.n, i.column, i.width, i.decimals, i.row])).toEqual([
				// left 7; width 114/4 = 28; step (114 - 3*28)/2 + 28 = 43
				["alter", 510, 7, 28, 1, 31],
				["alter", 511, 50, 28, 1, 31],
				["alter", 512, 93, 28, 2, 31],
				["button", 0, 7, 30, 0, 43],
				["button", 0, 91, 30, 0, 43],
			]);
		});

		it("leaves out an axis that was not asked for", () => {
			const { d } = open({ main: 'text R0 C0 F0 T"x"' });
			d.displayMessageBox({ title: "t", message: "m", mode: 2, controls: { z: true } });
			expect(d.items.filter((i) => i.kind === "alter").map((i) => i.n)).toEqual([512]);
		});

		it("shows the axis position from the host and jogs it with the encoder", () => {
			const positions: Record<number, number> = { 510: 12.3, 511: -4, 512: 0.25 };
			const { d, sent } = open({ main: 'text R0 C0 F0 T"x"' }, { legacyValue: (code) => positions[code] });
			d.displayMessageBox({ title: "t", message: "m", mode: 2, controls: { x: true, y: true, z: true } });
			d.refresh();
			expect(litColumns(d, ...JOG_ROWS).length).toBeGreaterThan(0);
			d.encoder(1); // highlight X
			d.encoder(0); // push: adjust it
			expect(d.adjusting).toBe(true);
			d.encoder(2);
			expect(sent).toEqual(["M120 G91 G1 F3000 X0.20 M121"]); // ValueMenuItem's axis jog, 0.1 per click
		});

		it("draws none when the box asks for none", () => {
			const { d } = open({ main: 'text R0 C0 F0 T"x"' });
			d.displayMessageBox({ title: "t", message: "m", mode: 3, controls: {} });
			expect(d.items.some((i) => i.kind === "alter")).toBe(false);
		});
	});

	describe("while a box is showing, the menu underneath is not drawn", () => {
		it("its items are gone, so a value changing behind the box does not repaint it", () => {
			let temp = 21;
			const { d } = open({ main: 'value R30 C10 N80 F0\nbutton R0 C0 T"btn"' }, { legacyValue: () => temp });
			expect(d.items.length).toBe(2);
			d.displayMessageBox({ title: "t", message: "m", mode: 0 });
			expect(d.items.map((i) => i.kind)).toEqual(["text", "text"]); // the box's own, not the menu's
			d.refresh(); // draws the box own text: RRF adds the items in DisplayMessageBox and draws them on the next refresh
			const before = d.lcd.toAscii().join("\n");
			temp = 99;
			d.refresh();
			expect(d.lcd.toAscii().join("\n")).toBe(before);
		});

		it("does not drop back to main on the inactivity timeout, and turning the knob does not arm one", () => {
			const { d, advance } = open({ main: 'button T"Go" A"menu" L"sub"', sub: 'text T"sub"' });
			d.encoder(1);
			d.encoder(0);
			expect(d.menuStack).toEqual(["main", "sub"]);
			d.displayMessageBox({ title: "t", message: "m", mode: 2 });
			advance(60000);
			d.refresh();
			expect(d.menuStack).toEqual(["main", "sub"]);
			expect(d.messageBox).not.toBeNull();
			d.encoder(1); // Menu::EncoderAction: "not displaying a message box" gates the timeout
			advance(60000);
			d.refresh();
			expect(d.messageBox).not.toBeNull();
			expect(d.menuStack).toEqual(["main", "sub"]);
		});

		it("does not arm the timeout on a touch either", () => {
			const { d, advance } = open({ main: 'button T"Go" A"menu" L"sub"', sub: 'text T"sub"' });
			d.encoder(1);
			d.encoder(0);
			d.displayMessageBox({ title: "t", message: "m", mode: 2 });
			d.touch(20, 48);
			advance(60000);
			d.refresh();
			expect(d.menuStack).toEqual(["main", "sub"]);
			expect(d.messageBox).not.toBeNull();
		});

		it("control: without a box the same sequence DOES return to main (so the tests above have teeth)", () => {
			const { d, advance } = open({ main: 'button T"Go" A"menu" L"sub"', sub: 'text T"sub"\nbutton R20 C0 T"b"' });
			d.encoder(1);
			d.encoder(0);
			d.encoder(1);
			advance(60000);
			d.refresh();
			expect(d.menuStack).toEqual(["main"]);
		});
	});

	describe("ClearMessageBox reloads the menu that was open", () => {
		it("puts the menu back, at the same depth, and takes the box's pixels off", () => {
			const { d } = open({ main: 'button T"Go" A"menu" L"sub"', sub: 'text R30 C10 F0 T"sub menu"' });
			d.encoder(1);
			d.encoder(0);
			d.displayMessageBox({ title: "Title", message: "Message", mode: 2 });
			expect(d.messageBox?.title).toBe("Title");
			d.clearMessageBox();
			expect(d.messageBox).toBeNull();
			expect(d.menuStack).toEqual(["main", "sub"]);
			d.refresh();
			expect(litIn(d, 30, 10, 41, 70)).toBe(true); // the sub menu's text is drawn again
			expect(litIn(d, 4, 120, 5, 124)).toBe(false); // the box's border is gone (the whole screen was cleared)
			expect(d.items.map((i) => i.text)).toEqual(["sub menu"]);
		});

		it("lets the inactivity timeout work again for the reloaded menu once the knob is used", () => {
			const { d, advance } = open({ main: 'button T"Go" A"menu" L"sub"', sub: 'text T"sub"\nbutton R20 C0 T"b"' });
			d.encoder(1);
			d.encoder(0);
			d.displayMessageBox({ title: "t", message: "m", mode: 0 });
			d.clearMessageBox();
			d.encoder(1); // no longer displaying a box: this arms the timeout again
			advance(21000);
			d.refresh();
			expect(d.menuStack).toEqual(["main"]);
		});

		it("does not throw with the fixed 'Mount SD' menu showing (RRF would index below its menu stack)", () => {
			const { d } = open({ main: 'text T"x"' }, { sdMounted: () => false });
			expect(d.items.map((i) => i.text)).toContain("Mount SD");
			d.displayMessageBox({ title: "t", message: "m", mode: 2 });
			expect(() => d.clearMessageBox()).not.toThrow();
			// straight away, before any refresh could paper over it: the fixed menu is back, not a "File not found" error
			expect(d.error).toBeNull();
			expect(d.items.map((i) => i.text)).toContain("Mount SD");
		});
	});

	describe("setMessageBox (what Display::Spin does with the firmware's current box)", () => {
		const box = (over: Partial<DisplayMessageBox> = {}): DisplayMessageBox => ({ title: "t", message: "m", mode: 3, seq: 1, ...over });

		it("draws a new box, and leaves it alone while it is the same one", () => {
			const { d } = open({ main: 'text R0 C0 F0 T"x"' });
			d.setMessageBox(box());
			d.encoder(1);
			expect(d.highlighted?.text).toBe("OK");
			d.setMessageBox(box()); // same seq: not redrawn, so the highlight survives
			expect(d.highlighted?.text).toBe("OK");
		});

		it("redraws when the box is replaced by another (a different seq)", () => {
			const { d } = open({ main: 'text R0 C0 F0 T"x"' });
			d.setMessageBox(box());
			d.encoder(1);
			d.setMessageBox(box({ seq: 2, title: "second" }));
			expect(d.highlighted).toBeNull();
			expect(titleOf(d)).toBe("second");
		});

		it("uses the box object as its identity when there is no seq", () => {
			const { d } = open({ main: 'text R0 C0 F0 T"x"' });
			const first: DisplayMessageBox = { title: "one", message: "m", mode: 2 };
			d.setMessageBox(first);
			d.encoder(1);
			d.setMessageBox(first);
			expect(d.highlighted?.text).toBe("OK");
			d.setMessageBox({ title: "two", message: "m", mode: 2 });
			expect(titleOf(d)).toBe("two");
		});

		it("a new box first drops the menu's highlight, so the menu behind it is not left highlighted", () => {
			const { d } = open({ main: 'button R0 C0 T"A"\nbutton R20 C0 T"B"' });
			d.encoder(1);
			expect(d.highlighted?.text).toBe("A");
			d.refresh();
			expect(d.lcd.getPixel(0, 0)).toBe(true); // highlighted: a lit block
			d.setMessageBox(box({ mode: 0 }));
			expect(d.highlighted).toBeNull();
			// the menu's own row 0 (outside the border) was redrawn unhighlighted before the box went up
			expect(d.lcd.getPixel(0, 0)).toBe(false);
		});

		it("takes an active box down when the firmware has none (cancelled from another channel)", () => {
			const { d } = open({ main: 'text R30 C10 F0 T"menu"' });
			d.setMessageBox(box());
			expect(d.messageBox).not.toBeNull();
			d.setMessageBox(null);
			expect(d.messageBox).toBeNull();
			d.refresh();
			expect(d.items.map((i) => i.text)).toEqual(["menu"]);
			d.setMessageBox(null); // and a second none is harmless
			expect(d.items.map((i) => i.text)).toEqual(["menu"]);
		});

		it("does not draw a mode the display can't show (a choice list, a number to type), and takes an active box down for one", () => {
			const { d } = open({ main: 'text R30 C10 F0 T"menu"' });
			d.setMessageBox(box({ mode: 4 }));
			expect(d.messageBox).toBeNull();
			expect(d.items.map((i) => i.text)).toEqual(["menu"]); // untouched
			d.setMessageBox(box());
			expect(d.messageBox).not.toBeNull();
			d.setMessageBox(box({ mode: 5, seq: 9 }));
			expect(d.messageBox).toBeNull();
			expect(d.items.map((i) => i.text)).toEqual(["menu"]);
		});

		it("a box that comes back after being taken down is drawn afresh", () => {
			const { d } = open({ main: 'text R0 C0 F0 T"x"' });
			d.setMessageBox(box());
			d.setMessageBox(null);
			d.setMessageBox(box()); // same seq as before, but the box had gone: it is new again
			expect(d.messageBox).not.toBeNull();
		});
	});
});
