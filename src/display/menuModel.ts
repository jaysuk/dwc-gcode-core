/**
 * A menu file resolved into the items RepRapFirmware would build from it - the layer between
 * `parseMenu` (`files/menu.ts`, which only tokenises each line) and drawing.
 *
 * `Menu::ParseMenuLine` (RRF `3.7.0-rc.2` `src/Display/Menu.cpp`) is stateful, and that state is what an
 * editor needs to show where things end up: `R`, `C` and `F` *stick* from line to line, every item
 * advances `column` by its own width (so `text` followed by `value` sits side by side with no `C`),
 * a `files` item resets the column and moves `row` down by its line count, and parameters that are
 * left out take defaults (`T` = `"*"`, `L` = `"main"`, `I` = `""`). This module reproduces exactly that,
 * measuring text with the same font tables the display uses.
 *
 * Like RRF - and unlike `parseMenu`, which reports every problem - resolving **stops at the first error**:
 * `Menu::Reload` calls `LoadError` and shows an error screen instead of a partial menu, so `items` is
 * empty whenever `firstError` is set. `errors` still lists all of them, for an editor's problems list.
 */
import { type MenuAction, type MenuDocument, type MenuError, type MenuLine, type MenuParam, parseMenu } from "../files/menu.js";
import { LCD_COLS, LCD_FONT_COUNT, Lcd12864, lcdFontHeight } from "./lcd.js";

export type MenuItemKind = "text" | "image" | "button" | "value" | "alter" | "files";

/** When an item shows: always, per a legacy visibility code (`V<n>`), or per an object-model condition (`V{...}`). */
export type MenuVisibility =
	| { kind: "always" }
	| { kind: "code"; code: number }
	| { kind: "expression"; expression: string };

/**
 * RRF keeps every string a menu's items need in one fixed buffer (`Menu::CommandBufferSize`); when it
 * fills, loading stops with "|Menu buffer full" (the leading `|` is RRF's own typo, kept as it appears
 * on the display). Each string counts its length plus one.
 */
export const MENU_COMMAND_BUFFER_SIZE = 2500;

/** RRF reads a menu file in chunks of this many bytes including the terminator, splitting a longer line. */
export const MENU_MAX_LINE_LENGTH = 120;

/** Longest menu file name RRF keeps when opening a menu (`Menu::MaxMenuFilenameLength` - 1). */
export const MENU_MAX_FILENAME_LENGTH = 17;

/** How many menus can be open inside one another (`Menu::MaxMenuNesting`). */
export const MENU_MAX_NESTING = 8;

/** Default width of a `value`/`alter` field with no `W` (`ValueMenuItem::DefaultWidth`). */
export const MENU_DEFAULT_VALUE_WIDTH = 25;

/** Text alignment inside an item's width - the `H` parameter (`MenuItem::LeftAlign`/`CentreAlign`/`RightAlign`). */
export type MenuAlignment = 0 | 1 | 2;

export interface ResolvedMenuItem {
	kind: MenuItemKind;
	/** 1-based line in the menu file this item came from. */
	line: number;
	/** Top pixel row and left pixel column, after the sticky `R`/`C` and any earlier item's advance. */
	row: number;
	column: number;
	/** Font number after clamping to the fonts a 12864 display has. */
	font: number;
	/** Width in pixels: the `W` parameter, else the measured width (text/button/image) or 25 (value/alter). Always >= 0. */
	width: number;
	/** Height in pixels: the font height (image: the bitmap's height when known). */
	height: number;
	/** `H`: 0 left (default), 1 centre, 2 right. A `button` is always centred; an `image`/`files` item left. */
	alignment: MenuAlignment;
	/** `T` text (default `"*"`). Used by `text` and `button`. */
	text: string;
	/** `L` (default `"main"`): a `button`'s file argument (`#0` in its action, or the menu a bare `menu` opens) and an `image`'s file name. */
	file: string;
	/** `I` (default `""`): the directory a `files` item lists. */
	directory: string;
	/** `A`: the raw action string, or `null` if the item has none. */
	action: string | null;
	/** `A`, split on `|` into what each part does. */
	actions: ReadonlyArray<MenuAction>;
	/** `N` as a number: the legacy value code (`value`/`alter`), or the number of lines a `files` item shows. */
	n: number;
	/** `N{...}` on a `value`: an object-model expression to display instead of a legacy code. */
	valueExpression: string | null;
	/** `D`: decimal places for a numeric value. */
	decimals: number;
	visibility: MenuVisibility;
	/** Whether the encoder can land on it: `button`, `alter` and `files`. */
	selectable: boolean;
	/** The `MenuLine` this came from, for callers that want its params/spans. */
	source: MenuLine;
}

export interface ResolvedMenu {
	items: ReadonlyArray<ResolvedMenuItem>;
	/** Every problem `parseMenu` found, in order. */
	errors: ReadonlyArray<MenuError>;
	/** The problem RRF would stop at and show as "Error loading menu" - `null` when the menu loads. */
	firstError: MenuError | null;
}

export interface ResolveMenuOptions {
	/**
	 * Width in pixels of a `text`/`button` item's content, used when it has no `W`. Defaults to measuring
	 * with the real 12864 font tables. Override in tests.
	 */
	measureText?: (font: number, text: string, kind: "text" | "button") => number;
	/** Size of an `image` item's bitmap (its first two bytes: columns, rows), if the file is known. */
	imageSize?: (file: string) => { width: number; height: number } | undefined;
}

/** Width the display would print `text` at (a `text` item), or a button's ` text ` with its two padding columns. */
export function measureLcdText(font: number, text: string, kind: "text" | "button" = "text"): number {
	const lcd = new Lcd12864();
	lcd.setFont(font);
	lcd.setCursor(lcd.numRows, 0); // off screen: nothing is drawn, but the column still advances
	lcd.setRightMargin(lcd.numCols);
	lcd.textInvert(false);
	if (kind === "button") lcd.writeSpaces(1);
	lcd.print(text);
	if (kind === "button") lcd.writeSpaces(1);
	return lcd.getColumn();
}

function lastParam(line: MenuLine, letter: string): MenuParam | undefined {
	let found: MenuParam | undefined;
	for (const p of line.params) {
		if (p.letter === letter) found = p;
	}
	return found;
}

function number(p: MenuParam | undefined): number {
	if (!p || p.kind !== "number") return 0;
	const n = Number.parseInt(p.value, 10);
	return Number.isFinite(n) ? n : 0;
}

function text(p: MenuParam | undefined, fallback: string): string {
	return p && p.kind === "string" ? p.value : fallback;
}

/** Resolve already-parsed lines; see {@link resolveMenu}. */
export function resolveMenuDocument(doc: MenuDocument, options: ResolveMenuOptions = {}): ResolvedMenu {
	const measure = options.measureText ?? measureLcdText;
	const firstError = doc.errors.length > 0 ? doc.errors[0] : null;
	const items: Array<ResolvedMenuItem> = [];
	if (firstError) return { items, errors: doc.errors, firstError };

	// State `Menu::ParseMenuLine` keeps between lines (Menu members, reset by Menu::Reload).
	let row = 0;
	let column = 0;
	let font = 0;
	let bufferUsed = 0;
	let bufferFullLine = 0;

	doc.lines.forEach((line, index) => {
		if (line.kind !== "command" || !line.command) return;
		const command = line.command.toLowerCase() as MenuItemKind;

		const r = lastParam(line, "R");
		const c = lastParam(line, "C");
		const f = lastParam(line, "F");
		if (r) row = number(r);
		if (c) column = number(c);
		if (f) font = Math.min(number(f), LCD_FONT_COUNT - 1);

		const w = number(lastParam(line, "W"));
		const alignmentRaw = number(lastParam(line, "H"));
		const alignment = (alignmentRaw === 1 || alignmentRaw === 2 ? alignmentRaw : 0) as MenuAlignment;
		const decimals = number(lastParam(line, "D"));
		const nParam = lastParam(line, "N");
		const vParam = lastParam(line, "V");
		const aParam = lastParam(line, "A");
		const visibility: MenuVisibility = vParam
			? (vParam.kind === "expression" ? { kind: "expression", expression: vParam.value } : { kind: "code", code: number(vParam) })
			: { kind: "always" };
		const valueExpression = command === "value" && nParam?.kind === "expression" ? nParam.value : null;

		const base = {
			line: index + 1,
			font,
			alignment,
			text: text(lastParam(line, "T"), "*"),
			file: text(lastParam(line, "L"), "main"),
			directory: text(lastParam(line, "I"), ""),
			action: aParam && aParam.kind === "string" ? aParam.value : null,
			actions: line.actions,
			n: nParam?.kind === "number" ? number(nParam) : 0,
			valueExpression,
			decimals,
			visibility,
			source: line,
		};
		const fontHeight = lcdFontHeight(font);

		// Strings RRF copies into its buffer for this line (see MENU_COMMAND_BUFFER_SIZE): the visibility and
		// value expressions while parsing, then per command what the item keeps.
		const cost = (str: string | null): number => (str === null ? 0 : str.length + 1);
		bufferUsed += vParam?.kind === "expression" ? cost(vParam.value) : 0;
		bufferUsed += valueExpression !== null ? cost(valueExpression) : 0;
		if (command === "text") bufferUsed += cost(base.text);
		else if (command === "button") bufferUsed += cost(base.text) + cost(base.action ?? "") + cost(base.file);
		else if (command === "files") bufferUsed += cost(base.action ?? "") + cost(base.directory) + cost(base.file);
		if (bufferUsed >= MENU_COMMAND_BUFFER_SIZE && bufferFullLine === 0) bufferFullLine = index + 1;

		switch (command) {
			case "text": {
				// A left-aligned text with no W gets one extra column so the next item follows immediately.
				const width = w !== 0 ? w : measure(font, base.text, "text") + (alignment === 0 ? 1 : 0);
				items.push({ ...base, kind: "text", row, column, width, height: fontHeight, selectable: false });
				column += width;
				break;
			}
			case "image": {
				const size = options.imageSize?.(base.file);
				const width = size?.width ?? 0;
				items.push({ ...base, kind: "image", alignment: 0, row, column, width, height: size?.height ?? 0, selectable: false });
				column += width;
				break;
			}
			case "button": {
				const width = w !== 0 ? w : measure(font, base.text, "button");
				items.push({ ...base, kind: "button", alignment: 1, row, column, width, height: fontHeight, selectable: true });
				column += width;
				break;
			}
			case "value":
			case "alter": {
				const width = w !== 0 ? w : MENU_DEFAULT_VALUE_WIDTH;
				items.push({ ...base, kind: command, row, column, width, height: fontHeight, selectable: command === "alter" });
				column += width;
				break;
			}
			case "files": {
				// Always full width from column 0; the list takes N lines, and the next item starts below it.
				items.push({ ...base, kind: "files", alignment: 0, row, column: 0, width: LCD_COLS, height: fontHeight * base.n, selectable: true });
				row += base.n * fontHeight;
				column = 0;
				break;
			}
		}
	});

	if (bufferFullLine !== 0) {
		// RRF checks after each line and gives up on the whole menu.
		const error: MenuError = { message: "|Menu buffer full", line: bufferFullLine, column: 0, rrfColumn: 0 };
		return { items: [], errors: [...doc.errors, error], firstError: error };
	}
	return { items, errors: doc.errors, firstError };
}

/** Parse and resolve a menu file's text. */
export function resolveMenu(source: string, options: ResolveMenuOptions = {}): ResolvedMenu {
	return resolveMenuDocument(parseMenu(source), options);
}

/**
 * The command string selecting a `button` sends (`ButtonMenuItem::Select`): `#0` in the action becomes the
 * button's `L` file in double quotes (RRF 3.6+ requires the quotes for `M98`); a bare `menu` action opens
 * the menu named by `L` (backwards compatibility). The result may still hold several `|`-separated commands.
 */
export function buttonCommand(action: string | null, file: string): string {
	const command = action ?? "";
	const at = command.indexOf("#0");
	if (at !== -1) return `${command.slice(0, at)}"${file}"${command.slice(at + 2)}`;
	if (command.toLowerCase() === "menu" && file.length !== 0) return `${command} ${file}`;
	return command;
}
