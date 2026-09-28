/**
 * `0:/sys/board.txt` (`FileKind: "board-config"`) - the STM32 firmware's per-board hardware settings
 * file, read end to end from the STM32 fork `gloomyandy/RepRapFirmware` `v3.7-dev` (`2660444`),
 * `src/Hardware/TGBTC/BoardConfig.cpp`. It is NOT G-code and nothing Duet-mainline reads it. The same
 * loader also reads `rrfboot.txt`, the copy of these settings baked into each board's firmware
 * (`LoadBoardDefaults`, `BoardConfig.cpp:635-648`), and only then `board.txt` on the SD card as an
 * override (`BoardConfig::Init`, `:781-793`), so a real board's effective settings are the two layered:
 * `parseBoardTxt(bootText, { restricted: false })` then `parseBoardTxt(userText, { base: boot.values })`.
 *
 * What the loader actually does (`GetConfigKeys`, `BoardConfig.cpp:1488-1728`), all reproduced here:
 * - Lines end at `\r\n`, a lone `\r` or `\n`; a line over 255 characters is split into 255-character
 *   pieces, each read as its own line (`FileStore::ReadLine`, `Storage/FileStore.cpp:472`).
 * - Leading spaces/tabs are skipped; a line whose first other character is `/`, `#` or `;` is a comment.
 *   The same test after the key or after `=` makes a comment there end the line, so `key = ; x` has no
 *   value, and `key ; x = 1` has no `=`.
 * - A key is a run of `[A-Za-z0-9._]`, then optional blanks, then `=`. Key matching is case-insensitive.
 * - A value is a run of the same characters, or a double-quoted string (anything up to the next `"`).
 *   Anything else ends it: `-1` is the empty value, `4.7k` is `4.7`-then-junk, `a.1,` is `a.1`. Text
 *   after the value is ignored.
 * - `{` starts a list, valid only for a key whose count is over 1 and whose type is pin or driver type.
 *   Entries are lowercased, separated by `,`, and the list closes at `}`. Only the entries given are
 *   written - the rest keep their earlier value (the built-in default, or `rrfboot.txt`'s). An empty
 *   `{}` writes nothing, a trailing comma is fine, and too many entries, a bad separator or a list not
 *   closed on the line writes NOTHING (the whole list is discarded).
 * - A scalar for a list key, a list for a scalar key, or an unknown key is skipped with a debug message
 *   that only reaches USB serial - which is why `problems` here is worth having.
 *
 * Deliberate differences from real RRF, all listed so a consumer isn't surprised:
 * - The key table is the superset over the STM32 builds. Most keys sit behind a build flag (`guard`,
 *   informational: a build without it reports "Key not found"); only `mcu` filters, because a board id
 *   tells you the MCU and nothing else about the build.
 * - A pin name is resolved to `"A.13"` form only through `resolvePin` (the board's `rrfpins.txt`
 *   aliases, in real RRF read from the SD card) then `StringToPin`'s `PA13`/`PA_13`/`PA.13`/`A13`
 *   forms. With no `resolvePin`, an alias such as `bedtemp` becomes `null` (NoPin) - see `assignments`
 *   for the text that was written.
 * - Floats are JS numbers, not rounded to 32 bits; strings are UTF-16, not bytes.
 * - An empty pin name is NoPin without asking `rrfpins.txt` (real RRF scans it for an empty alias).
 */

export type BoardTxtValueType = "pin" | "bool" | "uint8" | "uint16" | "uint32" | "float" | "string" | "driver-type" | "module-type";

/** One decoded value: a pin as `"A.13"` (`null` = `NoPin`), a number, a boolean, a string, or an
 *  enumerator name (`null` when the text named no enumerator). */
export type BoardTxtScalar = string | number | boolean | null;
export type BoardTxtValue = BoardTxtScalar | ReadonlyArray<BoardTxtScalar>;
export type BoardTxtValues = Readonly<Record<string, BoardTxtValue>>;

export interface BoardTxtKey {
	/** The key as `boardConfigs[]` spells it (`BoardConfig.cpp:81-204`); matching ignores case. */
	key: string;
	type: BoardTxtValueType;
	/** `numItems`: 1 = a scalar, more = a `{...}` list of at most this many entries. */
	count: number;
	/** Value before any file is read: `ClearConfig` (`BoardConfig.cpp:207-295`). Absent = the type's zero. */
	default?: BoardTxtValue;
	/** The preprocessor condition the entry sits behind, as written; informational (see file header). */
	guard?: string;
	/** Only in the STM32H7 build - unknown on an F4 when `mcu: "f4"` is given. */
	h7Only?: boolean;
}

/** `DriverType`'s enumerators in order (`Config/Pins_TeamGloomy_BTC.h:196-209`). */
export const BOARD_TXT_DRIVER_TYPES: ReadonlyArray<string> = [
	"unknown", "none", "stepdir", "tmcuartauto", "tmc2208", "tmc2209", "tmc2660", "tmcspiauto", "tmc5160", "tmc2240", "tmcauto", "invalid",
];

/** `NetworkModuleType`'s enumerators in order (`Config/Pins_TeamGloomy_BTC.h:354-362`). */
export const BOARD_TXT_MODULE_TYPES: ReadonlyArray<string> = [
	"espauto", "none", "esp8266", "esp32", "esp32eth", "esp32s3", "esp32c3", "esp32c5",
];

/** `SSPNONE` (`CoreSTM32 cores/arduino/Core.h:76`, 9c95319) - "no SPI channel". */
const SSP_NONE = 0xff;

// Array sizes, `Config/Pins_TeamGloomy_BTC.h`: `NumDirectDrivers` :109, `NumThermistorInputs` :147/:174,
// `MaxInitialPins` :238 (also `MaxSpiTempSensors` :256), `NumSPIPins` :315, `NumberSerialPins` :333.
const NUM_DRIVERS = 14;
const NUM_THERMISTORS = 9;
const MAX_INITIAL_PINS = 8;
const NUM_SPI_PINS = 3;
const NUM_SERIAL_PINS = 2;
/** `MaxBoardNameLength` (`Pins_TeamGloomy_BTC.h:410`): a string value must be shorter than this. */
const MAX_BOARD_NAME_LENGTH = 32;

function key(name: string, type: BoardTxtValueType, count = 1, extra: Partial<BoardTxtKey> = {}): BoardTxtKey {
	return { key: name, type, count, ...extra };
}

const SMART = "HAS_SMART_DRIVERS";
const TMC51 = "HAS_SMART_DRIVERS && SUPPORT_TMC51xx";

/** `boardConfigs[]` (`BoardConfig.cpp:81-204`), in file order, with `ClearConfig`'s defaults. */
export const BOARD_TXT_KEYS: ReadonlyArray<BoardTxtKey> = [
	key("board", "string"),
	key("board.longName", "string"),
	key("leds.diagnostic", "pin"),
	key("leds.diagnosticOn", "bool", 1, { default: true }),
	key("leds.activity", "pin"),
	key("leds.activityOn", "bool", 1, { default: true }),

	key("pins.SetHigh", "pin", MAX_INITIAL_PINS),
	key("pins.SetLow", "pin", MAX_INITIAL_PINS),

	key("stepper.powerEnablePin", "pin"),
	key("stepper.enablePins", "pin", NUM_DRIVERS),
	key("stepper.stepPins", "pin", NUM_DRIVERS),
	key("stepper.directionPins", "pin", NUM_DRIVERS),
	key("stepper.digipotFactor", "float"),
	key("stepper.TmcUartPins", "pin", NUM_DRIVERS, { guard: SMART }),
	key("stepper.DriverType", "driver-type", NUM_DRIVERS, { guard: SMART }),
	key("stepper.numSmartDrivers", "uint32", 1, { guard: SMART }),
	key("stepper.num5160Drivers", "uint32", 1, { guard: TMC51 }),
	key("stepper.spiChannel", "uint8", 1, { guard: TMC51, default: SSP_NONE }),
	key("stepper.csDelay", "uint32", 1, { guard: TMC51 }),
	key("stepper.TmcDiagPins", "pin", NUM_DRIVERS, { guard: "HAS_SMART_DRIVERS && HAS_STALL_DETECT && SUPPORT_TMC22xx" }),

	key("heat.tempSensePins", "pin", NUM_THERMISTORS),
	key("heat.spiTempSensorCSPins", "pin", MAX_INITIAL_PINS),
	key("heat.spiTempSensorChannel", "uint8", 1, { default: SSP_NONE }),
	key("heat.thermistorSeriesResistor", "float", 1, { default: 4700 }),

	key("atx.powerPin", "pin"),
	key("atx.powerPinInverted", "bool"),
	key("atx.initialPowerOn", "bool", 1, { default: true }),

	// `sdcard.internal.type` is an index into `SDCardConfigs[]` (`BoardConfig.cpp:592-599`);
	// 0xfe = `SD_UNKNOWN`, 0xff = `SD_NONE`.
	key("sdcard.internal.type", "uint8", 1, { default: 0xfe }),
	key("sdCard.internal.spiFrequencyHz", "uint32", 1, { default: 25000000 }),
	key("sdCard.external.csPin", "pin"),
	key("sdCard.external.cardDetectPin", "pin"),
	key("sdCard.external.spiFrequencyHz", "uint32", 1, { default: 4000000 }),
	key("sdCard.external.spiChannel", "uint8", 1, { default: SSP_NONE }),

	key("lcd.lcdCSPin", "pin", 1, { guard: "SUPPORT_12864_LCD" }),
	key("lcd.lcdBeepPin", "pin", 1, { guard: "SUPPORT_12864_LCD" }),
	key("lcd.encoderPinA", "pin", 1, { guard: "SUPPORT_12864_LCD" }),
	key("lcd.encoderPinB", "pin", 1, { guard: "SUPPORT_12864_LCD" }),
	key("lcd.encoderPinSw", "pin", 1, { guard: "SUPPORT_12864_LCD" }),
	key("lcd.lcdDCPin", "pin", 1, { guard: "SUPPORT_12864_LCD" }),
	key("lcd.panelButtonPin", "pin", 1, { guard: "SUPPORT_12864_LCD" }),
	key("lcd.spiChannel", "uint8", 1, { guard: "SUPPORT_12864_LCD", default: SSP_NONE }),

	// SCK, MISO, MOSI. SPI6-8 exist only in the STM32H7 build.
	key("SPI0.pins", "pin", NUM_SPI_PINS),
	key("SPI1.pins", "pin", NUM_SPI_PINS),
	key("SPI2.pins", "pin", NUM_SPI_PINS),
	key("SPI3.pins", "pin", NUM_SPI_PINS),
	key("SPI4.pins", "pin", NUM_SPI_PINS),
	key("SPI5.pins", "pin", NUM_SPI_PINS),
	key("SPI6.pins", "pin", NUM_SPI_PINS, { h7Only: true, guard: "STM32H7" }),
	key("SPI7.pins", "pin", NUM_SPI_PINS, { h7Only: true, guard: "STM32H7" }),
	key("SPI8.pins", "pin", NUM_SPI_PINS, { h7Only: true, guard: "STM32H7" }),

	key("wifi.espDataReadyPin", "pin", 1, { guard: "HAS_WIFI_NETWORKING" }),
	key("wifi.TfrReadyPin", "pin", 1, { guard: "HAS_WIFI_NETWORKING" }),
	key("wifi.espResetPin", "pin", 1, { guard: "HAS_WIFI_NETWORKING" }),
	key("wifi.csPin", "pin", 1, { guard: "HAS_WIFI_NETWORKING", default: "B.12" }),
	key("wifi.serialRxTxPins", "pin", NUM_SERIAL_PINS, { guard: "HAS_WIFI_NETWORKING" }),
	key("wifi.spiChannel", "uint8", 1, { guard: "HAS_WIFI_NETWORKING", default: 1 }),
	key("wifi.clockReg", "uint32", 1, { guard: "HAS_WIFI_NETWORKING" }),
	key("wifi.moduleType", "module-type", 1, { guard: "HAS_WIFI_NETWORKING", default: "espauto" }),

	key("sbc.TfrReadyPin", "pin", 1, { guard: "HAS_SBC_INTERFACE" }),
	key("sbc.csPin", "pin", 1, { guard: "HAS_SBC_INTERFACE", default: "B.12" }),
	key("sbc.spiChannel", "uint8", 1, { guard: "HAS_SBC_INTERFACE", default: 1 }),
	key("sbc.loadConfig", "bool", 1, { guard: "HAS_SBC_INTERFACE" }),
	key("sbc.SBCMode", "bool", 1, { guard: "HAS_SBC_INTERFACE" }),

	key("serial.aux.rxTxPins", "pin", NUM_SERIAL_PINS, { guard: "NUM_ASYNC_PORTS != 0", default: ["A.10", "A.9"] }),
	key("serial.aux2.rxTxPins", "pin", NUM_SERIAL_PINS, { guard: "NUM_ASYNC_PORTS > 1" }),

	key("led.neopixelPin", "pin", 1, { guard: "SUPPORT_LED_STRIPS" }),

	key("power.VInDetectPin", "pin", 1, { guard: "HAS_VOLTAGE_MONITOR" }),
	key("power.voltage", "uint32", 1, { guard: "HAS_VOLTAGE_MONITOR", default: 24 }),
	key("accelerometer.spiChannel", "uint8", 1, { guard: "SUPPORT_ACCELEROMETERS", default: SSP_NONE }),
	key("can.spiChannel", "uint8", 1, { guard: "USE_SPICAN" }),
	key("can.csPin", "pin", 1, { guard: "USE_SPICAN" }),
	key("can.spiFrequencyHz", "uint32", 1, { guard: "USE_SPICAN", default: 15000000 }),
	key("can.readPin", "pin", 1, { h7Only: true, guard: "STM32H7", default: "B.8" }),
	key("can.writePin", "pin", 1, { h7Only: true, guard: "STM32H7", default: "B.9" }),
	key("can.exp.address", "uint8", 1, { guard: "SUPPORT_REMOTE_COMMANDS", default: 255 }),
];

const KEYS_BY_LOWER: ReadonlyMap<string, BoardTxtKey> = new Map(BOARD_TXT_KEYS.map((k) => [k.key.toLowerCase(), k]));

/** `FindConfigKey` (`BoardConfig.cpp:1455-1467`): the table entry for a key, ignoring case. */
export function findBoardTxtKey(name: string): BoardTxtKey | undefined {
	return KEYS_BY_LOWER.get(name.toLowerCase());
}

function zeroOf(type: BoardTxtValueType): BoardTxtScalar {
	switch (type) {
		case "pin": return null;
		case "bool": return false;
		case "float": case "uint8": case "uint16": case "uint32": return 0;
		case "string": return "";
		case "driver-type": return "unknown";
		case "module-type": return "espauto";
	}
}

function defaultOf(entry: BoardTxtKey): BoardTxtValue {
	if (entry.count > 1) {
		return Array.isArray(entry.default) ? [...entry.default] : Array.from({ length: entry.count }, () => zeroOf(entry.type));
	}
	return entry.default ?? zeroOf(entry.type);
}

/** Every key's value before any file is read - `ClearConfig` (`BoardConfig.cpp:207-295`). A fresh copy each call. */
export function boardTxtDefaults(): Record<string, BoardTxtValue> {
	const values: Record<string, BoardTxtValue> = {};
	for (const entry of BOARD_TXT_KEYS) values[entry.key] = defaultOf(entry);
	return values;
}

export type BoardTxtProblemKind =
	| "missing-equals"
	| "unknown-key"
	| "wrong-shape"
	| "array-overflow"
	| "array-syntax"
	| "array-unterminated"
	| "empty-array"
	| "missing-value"
	| "value-too-long"
	| "unknown-pin"
	| "unknown-name";

export interface BoardTxtProblem {
	kind: BoardTxtProblemKind;
	/** 1-based line of the file. */
	line: number;
	message: string;
	/** The key, in the table's spelling, when the line got far enough to name one. */
	key?: string;
	/** The exact `debugPrintf` text RRF prints for this (USB serial only); absent when RRF says nothing. */
	rrfMessage?: string;
}

export interface BoardTxtAssignment {
	/** The table's spelling of the key. */
	key: string;
	line: number;
	/** The text the value was read from (lowercased per entry for a list); what to show when a pin alias
	 *  could not be resolved. */
	raw: string | ReadonlyArray<string>;
	/** What was decoded: a whole list (only its first `raw.length` entries are written), or a scalar. */
	value: BoardTxtValue;
	/** `"restricted"`: `board` in `board.txt` is read and then thrown away (`LoadBoardConfigFromFile`,
	 *  `BoardConfig.cpp:1401-1405`), so it is not in `values`. */
	ignored?: "restricted";
}

export interface BoardTxtOptions {
	/** `true` (default) for `board.txt`: the `board` key is ignored. `false` for `rrfboot.txt`. */
	restricted?: boolean;
	/** Start from these effective values (an earlier parse's `values`) instead of the built-in defaults. */
	base?: BoardTxtValues;
	/** Resolve a lowercased pin alias (a name from the board's `rrfpins.txt`) to `"A.13"` form. Return
	 *  `undefined`/`null` for no match. Typically `(n) => lookupPinName(boardId, n)?.canonicalName`. */
	resolvePin?: (name: string) => string | null | undefined;
	/** Drop the STM32H7-only keys (`SPI6-8.pins`, `can.readPin`, `can.writePin`) on an `"f4"`. */
	mcu?: "f4" | "h7";
}

export interface BoardTxtResult {
	/** Every key's effective value after this file, in the table's spelling. */
	values: BoardTxtValues;
	/** Each line that set a key, in file order (an earlier one may be overwritten by a later one). */
	assignments: ReadonlyArray<BoardTxtAssignment>;
	problems: ReadonlyArray<BoardTxtProblem>;
}

/** `FileStore::ReadLine`'s records: `\r\n`, `\r` or `\n` end a line; a line over 255 characters is
 *  split into 255-character records; nothing follows a final terminator. `line` is the physical line. */
function readRecords(text: string): Array<{ text: string; line: number }> {
	const records: Array<{ text: string; line: number }> = [];
	const maxLength = 255;
	const terminator = /\r\n|\r|\n/g;
	let start = 0;
	let line = 1;
	const push = (piece: string): void => {
		if (piece.length <= maxLength) {
			records.push({ text: piece, line });
			return;
		}
		for (let i = 0; i < piece.length; i += maxLength) records.push({ text: piece.slice(i, i + maxLength), line });
	};
	for (let m = terminator.exec(text); m !== null; m = terminator.exec(text)) {
		push(text.slice(start, m.index));
		start = m.index + m[0].length;
		line++;
	}
	if (start < text.length) push(text.slice(start));
	return records;
}

/** `SkipWhitespace` (`BoardConfig.cpp:1469-1479`): blanks, then a comment start sends `pos` to the end. */
function skipWhitespace(line: string, pos: number): number {
	while (pos < line.length && (line[pos] === " " || line[pos] === "\t")) pos++;
	const c = line[pos];
	return (c === "/" || c === "#" || c === ";") ? line.length : pos;
}

/** `IsValidChar` (`BoardConfig.cpp:1481-1486`). */
function isValidChar(c: string | undefined): boolean {
	if (c === undefined) return false;
	const code = c.charCodeAt(0);
	return (code >= 48 && code <= 57) || (code >= 65 && code <= 90) || (code >= 97 && code <= 122) || c === "." || c === "_";
}

/** `StrToU32` (`RRFLibraries General/SafeStrtod.cpp`): unsigned decimal prefix, saturating, 0 if none. */
function strToU32(text: string): number {
	const m = /^[ \t]*\+?(\d+)/.exec(text);
	if (m === null) return 0;
	const n = Number(m[1]);
	return n > 0xffffffff ? 0xffffffff : n;
}

/** `SafeStrtof`: a decimal float prefix, 0 if none. */
function strToFloat(text: string): number {
	const m = /^[ \t]*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/.exec(text);
	return m === null ? 0 : Number(m[1]);
}

/**
 * `BoardConfig::StringToPin` (`BoardConfig.cpp:1052-1082`), exactly: unlike `pins/portPin.ts`'s
 * `parsePortPin` (which needs the whole remainder to be digits, fine for a tokenised G-code parameter),
 * RRF reads a digit PREFIX here and ignores what follows, and stores the pin number in a `uint8_t`
 * before the `< 16` check - so a hand-edited file can carry `PA1x` (= `A.1`) or `A256` (= `A.0`) and
 * RRF accepts it. Returns `"A.13"` form, or `null` for `NoPin`.
 */
function stringToPin(text: string): string | null {
	let s = text;
	if (s[0] === "p" || s[0] === "P") s = s.slice(1);
	if (s.length < 2 || s.length > 4) return null;
	const port = s.charCodeAt(0) & ~0x20;
	if (port < 65 || port > 65 + 8) return null;
	const rest = (s[1] === "." || s[1] === "_") ? s.slice(2) : s.slice(1);
	const m = /^\d+/.exec(rest);
	if (m === null) return null;
	const pin = Number(m[0]) & 0xff;
	if (pin >= 16) return null;
	return `${String.fromCharCode(port)}.${pin}`;
}

/** Parses `board.txt` (or `rrfboot.txt`, with `restricted: false`) text. Never throws. */
export function parseBoardTxt(text: string, options: BoardTxtOptions = {}): BoardTxtResult {
	const restricted = options.restricted !== false;
	const values: Record<string, BoardTxtScalar | Array<BoardTxtScalar>> = {};
	for (const [name, value] of Object.entries(options.base ?? boardTxtDefaults())) {
		values[name] = Array.isArray(value) ? [...value] : value as BoardTxtScalar;
	}
	const assignments: Array<BoardTxtAssignment> = [];
	const problems: Array<BoardTxtProblem> = [];

	const known = (name: string): BoardTxtKey | undefined => {
		const entry = findBoardTxtKey(name);
		return entry !== undefined && entry.h7Only === true && options.mcu === "f4" ? undefined : entry;
	};

	for (const record of readRecords(text)) {
		const line = record.text;
		const len = line.length;
		const lineNo = record.line;
		const problem = (kind: BoardTxtProblemKind, message: string, keyName?: string, rrfMessage?: string): void => {
			const p: BoardTxtProblem = { kind, line: lineNo, message };
			if (keyName !== undefined) p.key = keyName;
			if (rrfMessage !== undefined) p.rrfMessage = rrfMessage;
			problems.push(p);
		};

		let pos = skipWhitespace(line, 0);
		if (pos >= len) continue;

		const keyStart = pos;
		while (pos < len && isValidChar(line[pos])) pos++;
		const keyText = line.slice(keyStart, pos);
		pos = skipWhitespace(line, pos);
		if (pos >= len || line[pos] !== "=") {
			const bom = lineNo === 1 && line.charCodeAt(0) === 0xfeff ? " (the file starts with a UTF-8 byte-order mark, which RRF reads as part of the first key - save it without one)" : "";
			problem("missing-equals", `No '=' after the key on this line${bom}.`, undefined, `Missing equals ${line}`);
			continue;
		}
		pos = skipWhitespace(line, pos + 1);

		const entry = known(keyText);
		const unknownKey = (): void => {
			const wrongShape = entry !== undefined;
			problem(wrongShape ? "wrong-shape" : "unknown-key",
				wrongShape ? `'${entry.key}' ${entry.count > 1 ? "takes a { } list" : "takes a single value"}.` : `'${keyText}' is not a board.txt setting.`,
				entry?.key, `Key not found or wrong type ${keyText}`);
		};

		const pinOf = (name: string, entryKey: string): string | null => {
			// `LookupPin` lowercases, then `LookupPinName` (`BoardConfig.cpp:920-999`): nil/NoPin, the pins
			// file's aliases, then `StringToPin`.
			const lower = name.toLowerCase();
			if (lower === "" || lower === "nil" || lower === "nopin") return null;
			const hit = options.resolvePin?.(lower);
			if (typeof hit === "string") return hit;
			const parsed = stringToPin(lower);
			if (parsed === null && options.resolvePin !== undefined) {
				problem("unknown-pin", `'${name}' is not a pin name on this board and not a port.pin form; RRF reads it as NoPin.`, entryKey);
			}
			return parsed;
		};
		const enumOf = (names: ReadonlyArray<string>, name: string, entryKey: string): string | null => {
			// `NamedEnumLookup`: an exact, case-sensitive match; anything else is out of range.
			if (names.includes(name)) return name;
			problem("unknown-name", `'${name}' is not one of ${names.join(", ")}.`, entryKey);
			return null;
		};

		if (pos < len && line[pos] === "{") {
			if (entry === undefined || entry.count <= 1 || (entry.type !== "pin" && entry.type !== "driver-type")) {
				unknownKey();
				continue;
			}
			pos = skipWhitespace(line, pos + 1);

			const read: Array<BoardTxtScalar> = [];
			const raw: Array<string> = [];
			// `arrIdx` is a `size_t` in RRF: `{}` decrements it below zero, which wraps and fails the range test.
			let index = 0;
			let closedAt = -2; // the last written index once the `}` is seen; -1 = empty list
			for (;;) {
				pos = skipWhitespace(line, pos);
				if (pos >= len) {
					problem("array-unterminated", `The { } list for '${entry.key}' is not closed on this line, so none of it is used.`, entry.key, "Got to end of line before end of array, line must be longer than maxLineLength");
					break;
				}
				let closed = false;
				if (line[pos] === "}") {
					closed = true;
					index--;
				} else {
					if (index >= entry.count) {
						problem("array-overflow", `'${entry.key}' takes at most ${entry.count} entries, so none of the list is used.`, entry.key, "Error : Too many entries defined in config for array");
						break;
					}
					const valueStart = pos;
					while (pos < len && isValidChar(line[pos])) pos++;
					const value = line.slice(valueStart, pos).toLowerCase();
					pos = skipWhitespace(line, pos);
					if (pos >= len || (line[pos] !== "}" && line[pos] !== ",")) {
						problem("array-syntax", `Expected ',' or '}' after '${value}' in the list for '${entry.key}', so none of it is used.`, entry.key, "Error: invalid array");
						break;
					}
					if (line[pos] === "}") closed = true;
					raw[index] = value;
					read[index] = entry.type === "pin" ? pinOf(value, entry.key) : enumOf(BOARD_TXT_DRIVER_TYPES, value, entry.key);
				}
				if (closed) {
					closedAt = index;
					break;
				}
				index++;
				pos++;
			}

			if (closedAt === -1) {
				problem("empty-array", `'${entry.key}' has an empty list, which sets nothing.`, entry.key);
			} else if (closedAt >= 0) {
				const target = values[entry.key] as Array<BoardTxtScalar>;
				for (let i = 0; i <= closedAt; i++) target[i] = read[i];
				const written = read.slice(0, closedAt + 1);
				assignments.push({ key: entry.key, line: lineNo, raw: raw.slice(0, closedAt + 1), value: written });
			}
			continue;
		}

		if (pos >= len) {
			if (entry !== undefined) problem("missing-value", `'${entry.key}' has no value.`, entry.key);
			continue;
		}
		let valueStart = pos;
		if (line[pos] === "\"") {
			pos++;
			valueStart++;
			while (pos < len && line[pos] !== "\"") pos++;
		} else {
			while (pos < len && isValidChar(line[pos])) pos++;
		}
		const value = line.slice(valueStart, pos);

		if (entry === undefined || entry.count !== 1) {
			unknownKey();
			continue;
		}

		let decoded: BoardTxtScalar;
		switch (entry.type) {
			case "pin":
				decoded = pinOf(value, entry.key);
				break;
			case "bool":
				decoded = value.length === 1 ? value === "1" : value.length === 4 && value.toLowerCase() === "true";
				break;
			case "float":
				decoded = strToFloat(value);
				break;
			// `uint8_t val = StrToU32(...)` narrows before the `> 0xFF` clamp (`BoardConfig.cpp:1344-1349`),
			// which is therefore dead code: 256 reads as 0, and a huge value as 255.
			case "uint8":
				decoded = strToU32(value) & 0xff;
				break;
			case "uint16":
				decoded = strToU32(value) & 0xffff;
				break;
			case "uint32":
				decoded = strToU32(value);
				break;
			case "string":
				decoded = value;
				break;
			case "module-type":
				decoded = enumOf(BOARD_TXT_MODULE_TYPES, value, entry.key);
				break;
			default:
				decoded = null;
		}

		const assignment: BoardTxtAssignment = { key: entry.key, line: lineNo, raw: value, value: decoded };
		if (entry.type === "string" && value.length + 1 >= MAX_BOARD_NAME_LENGTH) {
			problem("value-too-long", `'${entry.key}' must be under ${MAX_BOARD_NAME_LENGTH - 1} characters; RRF leaves the old value.`, entry.key);
			continue;
		}
		if (restricted && entry.key === "board") {
			assignment.ignored = "restricted";
		} else {
			values[entry.key] = decoded;
		}
		assignments.push(assignment);
	}

	return { values, assignments, problems };
}
