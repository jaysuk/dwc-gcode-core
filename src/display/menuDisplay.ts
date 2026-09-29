/**
 * A running 12864 menu: loads menu files, draws their items on a {@link Lcd12864}, and responds to the
 * rotary encoder (turn / push) and touch the way RepRapFirmware `3.7.0-rc.2` does - a port of `Menu.cpp`'s
 * runtime and the `Draw`/`Select`/`Adjust` methods of `TextMenuItem`, `ButtonMenuItem`, `ValueMenuItem`,
 * `ImageMenuItem` and `FilesMenuItem`, including RRF's incremental redraw (an item is only redrawn when it
 * changed, so overlapping items and erase-on-hide behave as they do on the real display).
 *
 * The machine is abstracted as a {@link MenuHost}: menu files, images and directory listings come from the
 * host (synchronously - a caller preloads `0:/menu/`), live values and visibility conditions are answered
 * by it, and G-code a button would send is handed back through `execute`. Nothing here touches DWC.
 *
 * M291 message boxes are ported too - `Menu::DisplayMessageBox` and `Menu::ClearMessageBox`
 * ({@link MenuDisplay.displayMessageBox} / {@link MenuDisplay.clearMessageBox}) and the part of `Display::Spin`
 * that decides when to call them ({@link MenuDisplay.setMessageBox}). The message-box state itself
 * (`MessageBox::GetLockedCurrent`, and what `M292` does to it) belongs to the firmware, so a host supplies the box
 * and clears it when the `M292` a button sent has been "processed".
 *
 * Deliberately not ported: the resistive-touch beep, and the tone/beep hooks.
 */
import { type MenuError, type MenuLine } from "../files/menu.js";
import { LCD_COLS, LCD_ROWS, Lcd12864 } from "./lcd.js";
import {
	MENU_MAX_FILENAME_LENGTH, MENU_MAX_NESTING, type MenuAlignment, type MenuVisibility, type ResolvedMenuItem, buttonCommand,
	resolveMenu,
} from "./menuModel.js";
import { classifyMenuValueCode, formatDuration, formatFixed } from "./menuValues.js";

/** An object-model expression's result, as a `value` item shows it (`ExpressionValue::AppendAsString`). */
export type MenuValue =
	| { type: "float"; value: number }
	| { type: "int"; value: number }
	| { type: "text"; value: string }
	| { type: "bool"; value: boolean }
	| { type: "null" };

export interface MenuHost {
	/** Text of `0:/menu/<name>`, or `undefined` if it doesn't exist. */
	readMenuFile(name: string): string | undefined;
	/** Raw bytes of an `image` item's file in `0:/menu/`: columns, rows, then row-padded bitmap data. */
	readImage?(name: string): Uint8Array | undefined;
	/**
	 * Entries of a directory (given with a trailing `/`). Return `undefined` while a listing is still being
	 * fetched - the `files` item waits and asks again on the next `refresh` - and an empty array for a
	 * directory that can't be read.
	 */
	listDirectory?(path: string): ReadonlyArray<{ name: string; isDirectory: boolean }> | undefined;
	/** Whether the SD card is mounted; when it isn't RRF shows a fixed "Mount SD" menu. Default true. */
	sdMounted?(): boolean;
	/**
	 * A legacy `V<n>` visibility code (`MenuItem::IsVisible`): 2/3 really printing / not, 4/5 print monitor
	 * printing / not, 6 paused or pausing, 7 printing or resuming, 10/11 SD mounted / not, 20 tool
	 * temperature fault, 28 bed heater fault. Unknown codes and 0 are always visible. Default true.
	 */
	visibilityCode?(code: number): boolean;
	/** A `V{...}` condition. RRF treats an error as false. Default false. */
	evaluateCondition?(expression: string): boolean;
	/** An `N{...}` expression on a `value`, or `undefined` for an error (shown as `***`). */
	evaluateValue?(expression: string): MenuValue | undefined;
	/**
	 * A legacy `N<code>` value, already in display units (temperatures in degrees, fan/extruder/speed factors
	 * and file progress as 0-100, durations in seconds, an IP address or the `M117` message as text).
	 * `undefined` reads as 0 (numbers) or empty (text).
	 */
	legacyValue?(code: number): number | string | undefined;
	/** Commit an `alter` item's new value (`N100`-`N599`, in display units) when the encoder is pressed. */
	setLegacyValue?(code: number, value: number): void;
	/** The highest temperature an `alter` may raise a heater's target to (RRF: the heater's limit). Default 500. */
	temperatureLimit?(item: number): number;
	/** Send a G-code command as the display would (`ProcessCommandFromLcd`); return whether it was accepted. */
	execute?(command: string): boolean;
	/** Milliseconds, for the inactivity and error timeouts. Default `Date.now`. */
	now?(): number;
}

/**
 * An `M291` message box, as far as the display draws it: what `Display::Spin` reads off `MessageBox`
 * (`Platform/MessageBox.h`, RRF 3.7.0-rc.2 - `GetTitle`, `GetMessage`, `GetMode`, `GetControls`, `GetSeq`).
 */
export interface DisplayMessageBox {
	/** `M291` `R`. */
	title: string;
	/** `M291` `P`. Drawn on a single row: a long message is cut at the box's edge (RRF: "only 1 row for now"). */
	message: string;
	/**
	 * `M291` `S`. The display only shows 0-3 (`MessageBox::IsLegacyType`): bit 2 (`S2`, `S3`) adds an OK button that
	 * sends `M292 P0`, bit 1 (`S1`, `S3`) a Cancel button that sends `M292 P1` - so `S1`, the "Close" box on the web
	 * interface, has a Cancel button here, and `S0` has none. Higher modes (a choice list, a number to type) are not
	 * drawn: {@link MenuDisplay.setMessageBox} treats them as no box at all.
	 */
	mode: number;
	/** Axes with a jog control (`M291` `X`/`Y`/`Z` > 0; `DoMessageBox` only reads them for modes 2 and 3). Only X, Y and Z are drawn. */
	controls?: { x?: boolean; y?: boolean; z?: boolean };
	/**
	 * `MessageBox::GetSeq`: which box this is. {@link MenuDisplay.setMessageBox} redraws only when it changes; without
	 * it the box object itself is the identity.
	 */
	seq?: number;
}

/** The highest `M291` mode the display can show (`MessageBox::IsLegacyType`: `mode <= 3`). */
export const MESSAGE_BOX_MAX_DISPLAY_MODE = 3;

interface LoadedError {
	message: string;
	file: string;
	line: number;
	column: number;
}

const INACTIVITY_TIMEOUT_MS = 20000;
const ERROR_TIMEOUT_MS = 6000;

interface Item {
	def: ResolvedMenuItem;
	changed: boolean;
	drawn: boolean;
	highlighted: boolean;
	width: number;
	height: number;
	// value / alter
	valueError: boolean;
	valuePercent: boolean;
	valueText: string | null;
	current: MenuValue;
	adjusting: "displaying" | "adjusting" | "live";
	// files
	dir: string;
	initialNesting: number;
	/** Whether the directory has been read (RRF: the item's "card state" is `mounted`). */
	filesReady: boolean;
	entries: Array<{ name: string; isDirectory: boolean }>;
	selectedIndex: number;
	firstVisible: number;
}

/** A menu file's selectable and non-selectable items, in the order RRF keeps them. */
export class MenuDisplay {
	readonly lcd = new Lcd12864();

	private readonly host: MenuHost;
	private filenames: Array<string> = [];
	private selectable: Array<Item> = [];
	private unselectable: Array<Item> = [];
	private highlightedItem: Item | null = null;
	private itemIsSelected = false;
	private displayingFixedMenu = false;
	private displayingError = false;
	private loadError: LoadedError | null = null;
	private timeoutValue = 0;
	private lastActionTime = 0;
	private rowOffset = 0;
	private currentMargin = 0;
	/** `Menu::displayingMessageBox`: set by {@link displayMessageBox}, cleared only by {@link clearMessageBox}. */
	private displayingMessageBox = false;
	private shownBox: DisplayMessageBox | null = null;
	/** `Display::mboxActive` / `mboxSeq`, for {@link setMessageBox}. */
	private mboxActive = false;
	private mboxKey: number | DisplayMessageBox | null = null;

	constructor(host: MenuHost) {
		this.host = host;
	}

	// #region State for a UI

	/** The menu currently open (`main` at the top), or `null` before anything is loaded. */
	get currentMenu(): string | null {
		return this.filenames.length > 0 ? this.filenames[this.filenames.length - 1] : null;
	}

	/** Names of the open menus, outermost first. */
	get menuStack(): ReadonlyArray<string> {
		return this.filenames;
	}

	/** The problem RRF is currently showing as "Error loading menu", if any. */
	get error(): Readonly<LoadedError> | null {
		return this.loadError;
	}

	/** The message box on screen, or `null` (see {@link displayMessageBox}). */
	get messageBox(): Readonly<DisplayMessageBox> | null {
		return this.displayingMessageBox ? this.shownBox : null;
	}

	/** The definition of the highlighted item, if any. */
	get highlighted(): ResolvedMenuItem | null {
		return this.highlightedItem?.def ?? null;
	}

	/** Whether the highlighted `alter` item is being adjusted with the encoder. */
	get adjusting(): boolean {
		return this.itemIsSelected;
	}

	/** Every item of the open menu, selectable first (the order RRF draws them in). */
	get items(): ReadonlyArray<ResolvedMenuItem> {
		return [...this.selectable, ...this.unselectable].map((i) => i.def);
	}

	// #endregion

	private now(): number {
		return this.host.now ? this.host.now() : Date.now();
	}

	private isSdMounted(): boolean {
		return this.host.sdMounted ? this.host.sdMounted() : true;
	}

	/** Open the top menu (`main`), dropping any nesting - what RRF does at start-up and after the inactivity timeout. */
	start(): void {
		this.filenames = [];
		this.load("main");
	}

	/** Open a menu on top of the current one (`Menu::Load`); ignored past the nesting limit. */
	load(name: string): void {
		if (this.filenames.length < MENU_MAX_NESTING) {
			this.filenames.push(name.slice(0, MENU_MAX_FILENAME_LENGTH));
			this.reload();
		}
	}

	/** Return to the menu below (`Menu::Pop`). */
	pop(): void {
		// RRF would index below its menu stack here; a `return` in the bottom menu just stays put.
		if (this.filenames.length > 1) this.filenames.pop();
		this.reload();
	}

	private resetCache(): void {
		this.highlightedItem = null;
		this.selectable = [];
		this.unselectable = [];
	}

	private reload(): void {
		this.displayingFixedMenu = false;
		// A low-resolution display doesn't nest menus visually: always the whole screen.
		this.currentMargin = 0;
		this.rowOffset = 0;
		this.lcd.clearAll();
		this.resetCache();
		this.displayingError = false;
		this.loadError = null;
		this.lcd.setRightMargin(this.lcd.numCols - this.currentMargin);

		const file = this.filenames[this.filenames.length - 1];
		const text = this.host.readMenuFile(file);
		if (text === undefined) {
			this.showLoadError("File not found", 0, 0);
			return;
		}
		this.build(text);
	}

	private build(text: string): void {
		const resolved = resolveMenu(text, {
			imageSize: (name) => {
				const bytes = this.host.readImage?.(name);
				return bytes && bytes.length >= 2 ? { width: bytes[0], height: bytes[1] } : undefined;
			},
		});
		if (resolved.firstError) {
			// RRF stops at the first bad line and shows it - no partial menu.
			const e: MenuError = resolved.firstError;
			this.showLoadError(e.message, e.line, e.rrfColumn);
			return;
		}
		for (const def of resolved.items) {
			const item = this.makeItem(def);
			(def.selectable ? this.selectable : this.unselectable).push(item);
		}
	}

	private makeItem(def: ResolvedMenuItem): Item {
		const item: Item = {
			def, changed: true, drawn: false, highlighted: false, width: def.width, height: def.height,
			valueError: false, valuePercent: false, valueText: null, current: { type: "float", value: 0 },
			adjusting: "displaying", dir: "", initialNesting: 0, filesReady: false, entries: [], selectedIndex: 0, firstVisible: 0,
		};
		if (def.kind === "files") {
			let dir = def.directory;
			if (dir.length === 0 || dir[dir.length - 1] !== "/") dir += "/";
			item.dir = dir;
			item.initialNesting = directoryNesting(dir);
		}
		return item;
	}

	/** `Menu::LoadError`: clear the screen and describe what went wrong, for a few seconds. */
	private showLoadError(message: string, line: number, column: number): void {
		this.resetCache();
		const file = this.currentMenu;
		this.lcd.clearAll();
		this.lcd.setFont(0);
		let out = `Error loading menu\nFile: ${file ?? "(none)"}`;
		if (line !== 0) {
			out += `\nLine ${line}`;
			if (column !== 0) out += ` column ${column}`;
		}
		out += `\n${message}`;
		this.lcd.print(out);
		this.lastActionTime = this.now();
		this.timeoutValue = ERROR_TIMEOUT_MS;
		this.displayingError = true;
		this.loadError = { message, file: file ?? "", line, column };
	}

	/** RRF's "no SD card" fallback menu (`Menu::LoadFixedMenu`). */
	private loadFixedMenu(): void {
		this.displayingFixedMenu = true;
		this.filenames = [];
		this.rowOffset = this.currentMargin = 0;
		this.lcd.clearAll();
		this.lcd.setRightMargin(this.lcd.numCols);
		this.resetCache();
		this.displayingError = false;
		this.loadError = null;
		const resolved = resolveMenu('text R3 C5 F0 T"No SD Card Found"\nbutton R15 C5 F0 T"Mount SD" A"M21"');
		for (const def of resolved.items) {
			(def.selectable ? this.selectable : this.unselectable).push(this.makeItem(def));
		}
	}

	// #region M291 message boxes

	/**
	 * `Menu::DisplayMessageBox`: draw the box over whatever is on screen. The menu underneath is not redrawn - its
	 * items are discarded (`ResetCache`), so it stays as a frozen picture around the box until
	 * {@link clearMessageBox} reloads it - and the inactivity timeout is switched off, so it doesn't drop back to
	 * `main` while someone reads the box.
	 *
	 * The layout is RRF's: a 1-pixel border 4 pixels in from each edge, the interior cleared, then in font 0 (each
	 * row `fontHeight + 1` tall, 2 pixels inside the border) the title and the message centred, a row of X/Y/Z jog
	 * values (`N510`-`N512`, a quarter of the width each, adjustable with the encoder) for the axes in `controls`, and
	 * the OK (left) / Cancel (right) buttons, 30 pixels wide, for the bits set in `mode`.
	 */
	displayMessageBox(box: DisplayMessageBox): void {
		const { lcd } = this;
		this.resetCache();
		this.displayingMessageBox = true;
		this.shownBox = box;
		this.timeoutValue = 0;

		const topBottomMargin = 4;
		const sideMargin = 4;

		// Draw a box and clear the interior.
		const nr = lcd.numRows;
		const nc = lcd.numCols;
		lcd.setRightMargin(nc);
		lcd.line(topBottomMargin, sideMargin, topBottomMargin, nc - sideMargin - 1, true);
		lcd.line(topBottomMargin, nc - sideMargin - 1, nr - topBottomMargin - 1, nc - sideMargin - 1, true);
		lcd.line(nr - topBottomMargin - 1, sideMargin, nr - topBottomMargin - 1, nc - sideMargin - 1, true);
		lcd.line(topBottomMargin, sideMargin, nr - topBottomMargin - 1, sideMargin, true);
		lcd.clear(topBottomMargin + 1, sideMargin + 1, nr - topBottomMargin - 1, nc - sideMargin - 1);

		const font = 0;
		const insideMargin = 2;
		const rowHeight = lcd.getFontHeight(font) + 1;
		const top = topBottomMargin + 1 + insideMargin;
		const left = sideMargin + 1 + insideMargin;
		const right = nc - left;
		const availableWidth = right - left;
		this.addBoxItem("text", top, left, availableWidth, font, { text: box.title });
		this.addBoxItem("text", top + rowHeight, left, availableWidth, font, { text: box.message }); // only 1 row for now

		// Whichever XYZ jog buttons we have been asked to display - RRF assumes only XYZ for now.
		const axisButtonWidth = Math.trunc(availableWidth / 4);
		const axisButtonStep = Math.trunc((availableWidth - 3 * axisButtonWidth) / 2) + axisButtonWidth;
		if (box.controls?.x) this.addBoxItem("alter", top + 2 * rowHeight, left, axisButtonWidth, font, { n: 510, decimals: 1 });
		if (box.controls?.y) this.addBoxItem("alter", top + 2 * rowHeight, left + axisButtonStep, axisButtonWidth, font, { n: 511, decimals: 1 });
		if (box.controls?.z) this.addBoxItem("alter", top + 2 * rowHeight, left + 2 * axisButtonStep, axisButtonWidth, font, { n: 512, decimals: 2 });

		const okCancelButtonWidth = 30;
		if (box.mode & 2) {
			this.addBoxItem("button", top + 3 * rowHeight, left, okCancelButtonWidth, font, { text: "OK", action: "M292 P0" });
		}
		if (box.mode & 1) {
			this.addBoxItem("button", top + 3 * rowHeight, right - okCancelButtonWidth, okCancelButtonWidth, font, { text: "Cancel", action: "M292 P1" });
		}
	}

	/** `Menu::AddItem` for what `displayMessageBox` builds with `new TextMenuItem(...)` and friends. */
	private addBoxItem(
		kind: "text" | "alter" | "button", row: number, column: number, width: number, font: number,
		extra: { text?: string; action?: string; n?: number; decimals?: number },
	): void {
		const source: MenuLine = { raw: "", kind: "command", command: kind, params: [], actions: [] };
		const def: ResolvedMenuItem = {
			kind, line: 0, row, column, font, width, height: this.lcd.getFontHeight(font),
			alignment: 1 as MenuAlignment, // `MenuItem::CentreAlign`, for all of them
			text: extra.text ?? "", file: "", directory: "", action: extra.action ?? null, actions: [],
			n: extra.n ?? 0, valueExpression: null, decimals: extra.decimals ?? 0,
			visibility: { kind: "always" }, selectable: kind !== "text", source,
		};
		(def.selectable ? this.selectable : this.unselectable).push(this.makeItem(def));
	}

	/** `Menu::ClearMessageBox`: forget the box and reload the menu that was open underneath it. */
	clearMessageBox(): void {
		this.displayingMessageBox = false;
		this.shownBox = null;
		// RRF's `Reload` would index below its menu stack if the fixed "Mount SD" menu is what is showing; redraw that instead.
		if (this.filenames.length === 0) this.loadFixedMenu();
		else this.reload();
	}

	/**
	 * What `Display::Spin` does each pass with the firmware's current message box: a box the display can show
	 * (mode 0-3) is drawn when it appears or is replaced by another (`seq` differs); anything else - none, or a
	 * mode the display can't draw - takes an active box down again. A new box first drops the menu's highlight and
	 * redraws it, so it doesn't sit under the box highlighted.
	 */
	setMessageBox(box: DisplayMessageBox | null): void {
		if (box !== null && box.mode <= MESSAGE_BOX_MAX_DISPLAY_MODE) {
			const key = box.seq ?? box;
			if (!this.mboxActive || this.mboxKey !== key) {
				if (!this.mboxActive) {
					this.clearHighlighting();
					this.refresh();
				}
				this.mboxActive = true;
				this.mboxKey = key;
				this.displayMessageBox(box);
			}
		} else if (this.mboxActive) {
			// Cancelled from this or another input channel.
			this.clearMessageBox();
			this.mboxActive = false;
			this.mboxKey = null;
		}
	}

	/** `Menu::ClearHighlighting`: no item highlighted or being adjusted. The next `refresh` draws it. */
	clearHighlighting(): void {
		this.highlightedItem = null;
		this.itemIsSelected = false;
	}

	// #endregion

	// #region Visibility and value evaluation

	private isVisible(v: MenuVisibility): boolean {
		if (v.kind === "expression") return this.host.evaluateCondition ? this.host.evaluateCondition(v.expression) : false;
		if (v.kind === "code" && v.code !== 0 && this.host.visibilityCode) return this.host.visibilityCode(v.code);
		return true;
	}

	private visible(item: Item): boolean {
		return this.isVisible(item.def.visibility);
	}

	// #endregion

	/**
	 * Call periodically (RRF: every display spin): applies the timeouts - back to `main` after 20 s of no
	 * input, off an error screen after 6 s - shows the fixed menu while the SD card is unmounted, then
	 * redraws whatever changed. Returns the LCD so callers can render it.
	 */
	refresh(): Lcd12864 {
		if (!this.isSdMounted()) {
			if (!this.displayingFixedMenu) this.loadFixedMenu();
		} else if (this.displayingFixedMenu || (this.timeoutValue !== 0 && this.now() - this.lastActionTime > this.timeoutValue)) {
			this.timeoutValue = 0;
			this.filenames = [];
			this.load("main");
		}
		this.drawAll();
		return this.lcd;
	}

	private drawAll(): void {
		for (const item of [...this.selectable, ...this.unselectable]) this.eraseIfInvisible(item);
		const rightMargin = this.lcd.numCols - this.currentMargin;
		for (const item of this.selectable) this.draw(item, rightMargin, item === this.highlightedItem);
		for (const item of this.unselectable) this.draw(item, rightMargin, false);
	}

	private eraseIfInvisible(item: Item): void {
		if (item.drawn && !this.visible(item)) {
			this.lcd.clear(item.def.row, item.def.column, item.def.row + item.height, item.def.column + item.width);
			item.drawn = false;
		}
	}

	// #region Drawing

	private draw(item: Item, rightMargin: number, highlight: boolean): void {
		const { lcd } = this;
		const def = item.def;
		switch (def.kind) {
			case "text":
				// Text isn't selectable, so `highlight` is ignored.
				if (this.visible(item) && (!item.drawn || item.changed)) {
					this.printAligned(item, rightMargin);
					item.changed = false;
					item.drawn = true;
				}
				break;
			case "button":
				if (this.visible(item) && (item.changed || !item.drawn || highlight !== item.highlighted) && def.column < lcd.numCols) {
					item.highlighted = highlight;
					this.printAligned(item, rightMargin);
					item.changed = false;
					item.drawn = true;
				}
				break;
			case "value":
			case "alter":
				this.drawValue(item, rightMargin, highlight);
				break;
			case "image":
				this.drawImage(item, highlight);
				break;
			case "files":
				this.drawFiles(item, rightMargin, highlight);
				break;
		}
	}

	/** What each kind prints at the cursor (`CorePrint`). */
	private corePrint(item: Item): void {
		const { lcd } = this;
		switch (item.def.kind) {
			case "text":
				lcd.print(item.def.text);
				break;
			case "button":
				lcd.writeSpaces(1); // space at start in case highlighted
				lcd.print(item.def.text);
				lcd.writeSpaces(1); // and at the end
				break;
			case "value":
			case "alter":
				if (item.def.kind === "alter") lcd.writeSpaces(1);
				lcd.print(this.valueString(item));
				break;
			default:
				break;
		}
	}

	private valueString(item: Item): string {
		if (item.valueError) return "***";
		if (item.valueText !== null) return item.valueText;
		const v = item.current;
		switch (v.type) {
			case "float":
				return formatFixed(v.value, item.def.decimals) + (item.valuePercent ? "%" : "");
			case "int":
				return String(Math.trunc(v.value));
			case "bool":
				return v.value ? "true" : "false";
			case "null":
				return "null";
			case "text":
				return v.value;
		}
	}

	/** `MenuItem::PrintAligned`: measure, then print at the right place for the item's alignment. */
	private printAligned(item: Item, rightMargin: number): void {
		const { lcd } = this;
		const def = item.def;
		let colsToSkip = 0;
		lcd.setFont(def.font);
		if (def.alignment !== 0) {
			lcd.setCursor(lcd.numRows, def.column);
			lcd.setRightMargin(Math.min(rightMargin, def.column + item.width));
			this.corePrint(item);
			const w = lcd.getColumn() - def.column;
			if (w < item.width) {
				colsToSkip = def.alignment === 2
					? item.width - w - 1 // right aligned: leave 1 pixel at the end
					: Math.trunc((item.width - w) / 2);
			}
		}
		lcd.setCursor(def.row, def.column);
		lcd.setRightMargin(Math.min(rightMargin, def.column + item.width));
		lcd.textInvert(item.highlighted);
		if (colsToSkip !== 0) {
			lcd.clearToMargin();
			lcd.setCursor(def.row, def.column + colsToSkip);
		}
		this.corePrint(item);
		if (def.alignment === 0) lcd.clearToMargin();
		lcd.textInvert(false);
	}

	private drawValue(item: Item, rightMargin: number, highlight: boolean): void {
		if (!this.visible(item)) return;
		const def = item.def;
		item.valueError = item.valuePercent = false;
		item.valueText = null;
		const old = item.current;
		if (def.valueExpression !== null) {
			const r = this.host.evaluateValue?.(def.valueExpression);
			if (r === undefined) {
				item.valueError = true;
				item.current = { type: "null" };
				item.changed = true;
			} else {
				item.current = r;
				item.changed = item.changed || !sameValue(old, r);
			}
		} else if (item.adjusting !== "adjusting") {
			this.readLegacy(item, old);
		}
		if (item.changed || !item.drawn || highlight !== item.highlighted) {
			item.highlighted = highlight;
			this.printAligned(item, rightMargin);
			item.changed = false;
			item.drawn = true;
		}
	}

	private readLegacy(item: Item, old: MenuValue): void {
		const code = item.def.n;
		const info = classifyMenuValueCode(code);
		if (info === null) {
			item.valueError = true;
			item.changed = true;
			return;
		}
		const raw = this.host.legacyValue?.(code);
		item.valuePercent = info.percent;
		switch (info.type) {
			case "text":
				item.valueText = raw === undefined ? "" : String(raw);
				item.current = { type: "text", value: item.valueText };
				break;
			case "duration":
				item.valueText = formatDuration(typeof raw === "number" ? raw : 0);
				item.current = { type: "text", value: item.valueText };
				break;
			case "int":
			case "uint":
				item.current = { type: "int", value: typeof raw === "number" ? raw : 0 };
				break;
			case "float": {
				let v = typeof raw === "number" ? raw : 0;
				if (Math.floor(code / 100) <= 2) v = Math.max(v, 0); // temperatures show as 0 rather than negative
				item.current = { type: "float", value: v };
				break;
			}
		}
		if (!sameValue(old, item.current)) item.changed = true;
	}

	private drawImage(item: Item, highlight: boolean): void {
		if (!(this.visible(item) && (!item.drawn || item.changed || highlight !== item.highlighted))) return;
		const bytes = this.host.readImage?.(item.def.file);
		if (bytes && bytes.length >= 2) {
			const cols = bytes[0];
			const rows = bytes[1];
			if (cols !== 0 && cols <= this.lcd.numCols && rows !== 0) {
				const bytesPerRow = Math.ceil(cols / 8);
				for (let r = 0; r < rows; r++) {
					const start = 2 + r * bytesPerRow;
					if (start + bytesPerRow > bytes.length) break;
					this.lcd.bitmapRow(item.def.row + r, item.def.column, cols, bytes.subarray(start, start + bytesPerRow), highlight);
				}
			}
		}
		item.changed = false;
		item.drawn = true;
		item.highlighted = highlight;
	}

	// #endregion

	// #region Files item (FilesMenuItem)

	/**
	 * Go to the top of `item.dir`. The listing itself is read on the next draw, so a host that has to fetch
	 * it asynchronously can return `undefined` from `listDirectory` until it has it (the item just waits).
	 */
	private enterDirectory(item: Item): void {
		item.selectedIndex = 0;
		item.firstVisible = 0;
		item.entries = [];
		item.filesReady = false;
		item.changed = true;
	}

	private inSubdirectory(item: Item): boolean {
		return directoryNesting(item.dir) > item.initialNesting;
	}

	private listingEntries(item: Item): number {
		return this.inSubdirectory(item) ? 1 + item.entries.length : item.entries.length;
	}

	private drawFiles(item: Item, rightMargin: number, highlight: boolean): void {
		const { lcd } = this;
		if (!this.visible(item)) {
			item.filesReady = false; // RRF forgets the card state, so the listing is re-read when it shows again
			return;
		}
		if (!item.filesReady) {
			const listing = this.host.listDirectory ? this.host.listDirectory(item.dir) : [];
			if (listing === undefined) return; // still being fetched: try again on the next refresh
			item.entries = listing.filter((e) => !e.name.startsWith(".")).map((e) => ({ ...e }));
			item.filesReady = true;
			item.changed = true;
		}
		if (item.drawn && !item.changed && item.highlighted === highlight) return;

		const def = item.def;
		const font = def.font;
		lcd.setFont(font);
		lcd.setRightMargin(rightMargin);
		let line = 0;
		let skip: number;
		const fontHeight = lcd.getFontHeight();
		const sub = this.inSubdirectory(item);
		if (sub) {
			if (item.firstVisible === 0) {
				lcd.setCursor(def.row, def.column);
				lcd.print("  ..");
				lcd.clearToMargin();
				if (highlight && item.selectedIndex === 0) {
					lcd.setCursor(def.row, def.column);
					lcd.print(">");
				}
				line = 1;
				skip = 0;
			} else {
				skip = item.firstVisible - 1;
			}
		} else {
			skip = item.firstVisible;
		}
		let idx = skip;
		while (line < def.n) {
			lcd.setCursor(def.row + fontHeight * line, def.column);
			const entry = item.entries[idx];
			if (entry) {
				lcd.print("  ");
				if (entry.isDirectory) lcd.print("./");
				lcd.print(entry.name);
				lcd.clearToMargin();
				if (highlight && item.selectedIndex === line + item.firstVisible) {
					lcd.setCursor(def.row + fontHeight * line, def.column);
					lcd.print(">");
				}
			} else {
				lcd.clearToMargin();
			}
			line++;
			idx++;
		}
		item.changed = false;
		item.drawn = true;
		item.highlighted = highlight;
	}

	private filesAdvance(item: Item, counts: number): number {
		const total = this.listingEntries(item);
		if (total === 0) return counts;
		const rows = item.def.n;
		while (counts > 0) {
			if (item.selectedIndex + 1 === total) break; // hand the rest back to the menu
			item.selectedIndex++;
			counts--;
			if (item.selectedIndex === item.firstVisible + rows) item.firstVisible++;
		}
		while (counts < 0) {
			if (item.selectedIndex === 0) break;
			item.selectedIndex--;
			counts++;
			if (item.selectedIndex < item.firstVisible) item.firstVisible--;
		}
		item.changed = true;
		return counts;
	}

	private filesEnter(item: Item, forward: boolean): void {
		const total = this.listingEntries(item);
		if (forward || total === 0) {
			item.selectedIndex = 0;
			item.firstVisible = 0;
		} else {
			item.selectedIndex = total - 1;
			item.firstVisible = total > item.def.n ? total - item.def.n : 0;
		}
		item.changed = true;
	}

	/** `FilesMenuItem::Select`: returns the command to run, or `null` if it only navigated. */
	private filesSelect(item: Item): string | null {
		const def = item.def;
		if (this.inSubdirectory(item) && item.selectedIndex === 0) {
			// ".." goes back to the item's own directory (RRF: "TODO: go up one level rather than to logical root").
			let dir = def.directory;
			if (dir.length === 0 || dir[dir.length - 1] !== "/") dir += "/";
			item.dir = dir;
			this.enterDirectory(item);
			return null;
		}
		const entry = item.entries[this.inSubdirectory(item) ? item.selectedIndex - 1 : item.selectedIndex];
		if (!entry) return null;
		if (entry.isDirectory) {
			item.dir = `${item.dir}${entry.name}/`;
			this.enterDirectory(item);
			return null;
		}
		const action = def.action ?? "";
		const at = action.indexOf("#0");
		let cmd = at !== -1 ? `${action.slice(0, at)}"${item.dir}${entry.name}"${action.slice(at + 2)}` : action;
		// RRF, literally: a command containing "menu" is cut there and the L parameter appended.
		const menuAt = cmd.indexOf("menu");
		if (menuAt !== -1) cmd = cmd.slice(0, menuAt) + def.file;
		return cmd;
	}

	// #endregion

	// #region Encoder and touch

	private executeOne(cmd: string): void {
		if (/^return$/i.test(cmd)) {
			this.pop();
		} else if (/^menu /i.test(cmd)) {
			this.load(cmd.slice(5));
		} else if (/^[GMT]/i.test(cmd)) {
			this.host.execute?.(cmd);
		}
	}

	private runCommands(command: string): void {
		// Commands are split on `|` up front, then run in turn (a `return` or `menu` reloads under the loop).
		for (const cmd of command.split("|")) this.executeOne(cmd);
	}

	private selectItem(item: Item): { command: string | null; adjustable: boolean } {
		switch (item.def.kind) {
			case "button":
				return { command: buttonCommand(item.def.action, item.def.file), adjustable: false };
			case "files":
				return { command: this.filesSelect(item), adjustable: false };
			case "alter":
				item.adjusting = "adjusting";
				return { command: null, adjustable: true };
			default:
				return { command: null, adjustable: false };
		}
	}

	private enterItem(): void {
		const item = this.highlightedItem;
		if (item && this.visible(item)) {
			const { command, adjustable } = this.selectItem(item);
			if (command !== null) this.runCommands(command);
			else if (adjustable) this.itemIsSelected = true;
		}
	}

	private scrollItem(action: number): void {
		let remaining = action;
		const item = this.highlightedItem;
		if (item && this.visible(item) && item.def.kind === "files") remaining = this.filesAdvance(item, remaining);
		if (remaining !== 0) {
			this.advanceHighlight(remaining);
			const now = this.highlightedItem;
			if (now) {
				if (now.def.kind === "files") this.filesEnter(now, remaining > 0);
				const before = this.rowOffset;
				this.rowOffset = this.visibilityRowOffset(now, before);
				if (this.rowOffset !== before) {
					// The whole menu scrolled: redraw everything.
					this.lcd.clearAll();
					for (const i of [...this.selectable, ...this.unselectable]) i.changed = true;
				}
			}
		}
	}

	/** `GetVisibilityRowOffset`: only a `button` scrolls the menu to keep itself on screen. */
	private visibilityRowOffset(item: Item, current: number): number {
		if (item.def.kind !== "button") return 0;
		const fontHeight = this.lcd.getFontHeight(item.def.font);
		let request = current;
		if (64 + current <= item.def.row + fontHeight + 1) request = item.def.row - 3; // off the bottom
		if (item.def.row < current + 3) request = item.def.row > 3 ? item.def.row - 3 : 0; // move back up
		return request;
	}

	/**
	 * A turn of the encoder (`clicks` > 0 clockwise, < 0 anticlockwise) or, with `0`, a push
	 * (`Menu::EncoderAction`).
	 */
	encoder(clicks: number): void {
		if (this.displayingError) {
			if (clicks === 0) this.timeoutValue = 1; // a push dismisses the message at the next refresh
			return;
		}
		if (this.itemIsSelected) {
			const item = this.highlightedItem;
			if (item && this.visible(item)) {
				if (this.adjust(item, clicks)) this.itemIsSelected = false;
			} else {
				this.itemIsSelected = false;
			}
		} else if (clicks !== 0) {
			this.scrollItem(clicks);
		} else {
			this.enterItem();
		}
		// RRF: "if the operation did not result in an error and we are not displaying a message box".
		if (!this.displayingError && !this.displayingMessageBox) {
			this.lastActionTime = this.now();
			this.timeoutValue = INACTIVITY_TIMEOUT_MS;
		}
	}

	/** A touch at pixel (x, y): press the nearest selectable item within 8 pixels (`Menu::HandleTouch`). */
	touch(x: number, y: number): void {
		const MAX_ERR = 8;
		if (this.displayingError) {
			this.timeoutValue = 1;
			return;
		}
		let best: Item | null = null;
		let bestError = MAX_ERR + MAX_ERR;
		for (const item of this.selectable) {
			if (!this.visible(item)) continue;
			const minX = item.def.column;
			const maxX = item.def.column + item.width - 1;
			const minY = item.def.row;
			const maxY = item.def.row + item.height - 1;
			const xError = x < minX ? minX - x : x > maxX ? x - maxX : 0;
			if (xError < MAX_ERR) {
				const yError = y < minY ? minY - y : y > maxY ? y - maxY : 0;
				if (yError < MAX_ERR && xError + yError < bestError) {
					bestError = xError + yError;
					best = item;
				}
			}
		}
		if (best) {
			if (!this.itemIsSelected) {
				this.highlightedItem = best;
				this.enterItem();
			}
			if (!this.displayingError && !this.displayingMessageBox) {
				this.lastActionTime = this.now();
				this.timeoutValue = INACTIVITY_TIMEOUT_MS;
			}
		}
	}

	private advanceHighlight(n: number): void {
		if (this.highlightedItem === null) {
			this.highlightedItem = this.findNext(null);
		} else if (n > 0) {
			for (;;) {
				const p = this.findNext(this.highlightedItem);
				if (n === 0 || p === null || p === this.highlightedItem) {
					this.highlightedItem = p;
					return;
				}
				n--;
			}
		} else {
			for (;;) {
				const p = this.findPrev(this.highlightedItem);
				if (n === 0 || p === null || p === this.highlightedItem) {
					this.highlightedItem = p;
					return;
				}
				n++;
			}
		}
	}

	/** Next visible selectable item after `p` (wrapping), or the first when `p` is null. */
	private findNext(p: Item | null): Item | null {
		const list = this.selectable;
		if (list.length === 0) return null;
		let idx = p === null ? 0 : (list.indexOf(p) + 1) % list.length;
		const start = idx;
		do {
			if (this.visible(list[idx])) return list[idx];
			idx = (idx + 1) % list.length;
		} while (idx !== start);
		return null;
	}

	/** RRF's `FindPrevSelectableItem`: the last visible item up to `p` in a single pass round the list from `p`. */
	private findPrev(p: Item | null): Item | null {
		const list = this.selectable;
		if (list.length === 0) return null;
		const start = p === null ? 0 : Math.max(list.indexOf(p), 0);
		let idx = start;
		let best: Item | null = null;
		do {
			if (this.visible(list[idx])) best = list[idx];
			idx = (idx + 1) % list.length;
		} while (idx !== start);
		return best;
	}

	// #endregion

	// #region Adjusting an `alter` item (ValueMenuItem::Adjust*)

	/** Returns true when adjustment is finished. */
	private adjust(item: Item, clicks: number): boolean {
		if (clicks === 0) return this.commitAdjust(item);
		item.changed = true;
		const code = item.def.n;
		const group = Math.floor(code / 100);
		const number = code % 100;
		const cur = item.current.type === "float" || item.current.type === "int" ? item.current.value : 0;
		let next = cur;
		switch (group) {
			case 1:
			case 2:
				if (number < 80) {
					// Tool heaters: below 95 a decrease drops to 0 and an increase from 0 jumps to 95.
					if (clicks < 0) {
						next = cur + clicks;
						if (next < 95) next = 0;
					} else {
						if (cur === 0) next = 95 - 1;
						next = Math.min(next + clicks, this.host.temperatureLimit ? this.host.temperatureLimit(number) : 500);
					}
				} else {
					next = cur + clicks;
				}
				break;
			case 3:
				next = Math.min(Math.max(cur + clicks, 0), 100);
				break;
			case 5:
				if (number === 0) {
					next = Math.min(Math.max(cur + clicks, 10), 500);
				} else if (number === 20) {
					next = Math.min(Math.max(Math.trunc(cur) + clicks, -1), 255);
				} else if (number === 21) {
					this.host.execute?.(`M290 Z${(0.02 * clicks).toFixed(2)}`);
					item.adjusting = "live";
				} else if (number >= 10 && number <= 15) {
					const letter = "XYZUVW"[number - 10];
					const amount = (number === 12 ? 0.02 : 0.1) * clicks;
					this.host.execute?.(`M120 G91 G1 F3000 ${letter}${amount.toFixed(2)} M121`);
					item.adjusting = "live";
				}
				break;
			default:
				next = cur + clicks;
				break;
		}
		if (item.adjusting !== "live") item.current = item.current.type === "int" ? { type: "int", value: next } : { type: "float", value: next };
		return false;
	}

	private commitAdjust(item: Item): boolean {
		if (item.adjusting === "adjusting") {
			const code = item.def.n;
			const group = Math.floor(code / 100);
			const number = code % 100;
			const value = item.current.type === "float" || item.current.type === "int" ? item.current.value : 0;
			const committable = group === 1 || group === 2 || group === 3 || group === 4 || (group === 5 && (number === 0 || number === 20));
			if (committable) {
				// Heater targets below 1 mean "off" (absolute zero in RRF).
				const v = (group === 1 || group === 2) && value < 1 ? -273.15 : value;
				this.host.setLegacyValue?.(code, v);
			}
		}
		item.adjusting = "displaying";
		item.changed = true;
		return true;
	}

	// #endregion
}

function directoryNesting(path: string): number {
	let slashes = 0;
	for (let i = 0; i < path.length; i++) {
		if (path[i] === "/" && i + 1 < path.length) slashes++; // a trailing slash doesn't count
	}
	return slashes;
}

function sameValue(a: MenuValue, b: MenuValue): boolean {
	if (a.type !== b.type) return false;
	return (a as { value?: unknown }).value === (b as { value?: unknown }).value;
}

export { LCD_COLS, LCD_ROWS };
