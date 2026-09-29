import { describe, expect, it } from "vitest";

import { MenuDisplay, type MenuHost } from "../src/display/menuDisplay.js";

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
