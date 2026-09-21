#!/usr/bin/env node
/**
 * Builds `src/pins/duetBoards.ts` (`DUET_BOARD_PIN_TABLES`) from every official Duet mainboard's
 * compiled `PinTable[]` array (task 17, `docs/tasks/17-pin-names-and-validation.md`, Part B,
 * Decision 6) - `RepRapFirmware/src/Config/Pins_*.h`.
 *
 * A narrow, purpose-built parser, not a general C++ parser (task 17's own Decision/Step guidance):
 * each `PinDescription` struct's FIELD COUNT AND ORDER differs per board (confirmed directly - some
 * boards have 8 positional fields, some 5, some 7), but `pinNames` (a quoted comma-separated alias
 * list, occasionally a named `constexpr const char*` constant instead of a literal, or `nullptr` for
 * a pin with no G-code-addressable name at all) is ALWAYS the LAST field before the row's closing
 * `}` - so this script only ever needs that one field, never the ones before it.
 *
 * `canonicalName` is the pin's own FIRST listed alias, not a `port.pin` form derived from the row's
 * trailing comment (a real, checked reason why: `Pins_DuetNG.h` has rows for a DueX expansion board
 * and an SX1509B I2C GPIO expander with no physical chip pin address at all, e.g. `"duex.e2stop"
 * ... // E2_STOP` - the comment format isn't reliable identity across every board, but the pin's own
 * first alias always is, whenever it has one).
 *
 * `nullptr` rows are DROPPED entirely: `LookupPinName` (`Config/Pins.cpp`) skips a null `pinNames`
 * unconditionally, so that pin genuinely cannot be referenced by name from G-code at all.
 *
 * A leading `!` on one alias within a pinNames string means "this name implies hardware-inverted
 * polarity" (`Pins_Duet3Mini.h:403`'s own comment: "If a pin name is prefixed by ! then this means
 * the pin is hardware inverted... The same pin may have names for both the inverted and non-inverted
 * cases") - `LookupPinName` strips it before comparing (`Config/Pins.cpp`'s own `hwInverted` handling),
 * so it's invisible to what a user actually types; stripped here too rather than stored literally.
 *
 * `Pins_FMDC.h` is DELIBERATELY EXCLUDED from this run: its `PinTable[]` has real
 * `#if defined(FMDC_V03)`-guarded rows this script doesn't resolve (no build-variant selection
 * mechanism exists here yet, same class of gap as the RP2040 board's own conditional compilation,
 * task 17's Findings) - a real, documented gap, not silently wrong.
 *
 *   node scripts/build-pin-tables-duet.mjs [--tag 3.7.0-rc.1] [--rrf <clone>]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_TS = join(ROOT, "src", "pins", "duetBoards.ts");
const DEFAULT_CLONE = "C:\\Users\\live\\Documents\\Github\\RRFBuild\\RepRapFirmware";
const DEFAULT_TAG = "3.7.0-rc.1";

// boardId -> Pins_<Board>.h. Pins_FMDC.h deliberately omitted - see this file's own doc comment.
const BOARD_FILES = {
	"duet3mini": "Pins_Duet3Mini.h",
	"duet3-indx": "Pins_Duet3_INDX.h",
	"duet3-mb6hc": "Pins_Duet3_MB6HC.h",
	"duet3-mb6xd": "Pins_Duet3_MB6XD.h",
	"duetng": "Pins_DuetNG.h",
	"pccb": "Pins_Pccb.h",
};

function git(clone, args) {
	return execFileSync("git", ["-C", clone, ...args], { encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 });
}

/** The raw text strictly between `PinTable[] = {` and its own matching closing `};` - never the
 *  whole file, so a row-level scan below can't accidentally pick up something else in the file. */
function extractPinTableBlock(fileText, boardFile) {
	const start = fileText.indexOf("PinDescription PinTable[]");
	if (start < 0) throw new Error(`${boardFile}: no "PinDescription PinTable[]" found`);
	const openBrace = fileText.indexOf("{", start);
	const end = fileText.indexOf("\n};", openBrace);
	if (openBrace < 0 || end < 0) throw new Error(`${boardFile}: couldn't find the array's own { ... }; bounds`);
	return fileText.slice(openBrace + 1, end);
}

/** One `{ ...fields..., pinNames }, // optional comment` per real row. A trailing comment is kept
 *  only as debug/citation context, NOT relied on for identity - confirmed a real reason not to:
 *  `Pins_DuetNG.h` has rows for a DueX expansion board and an SX1509B I2C GPIO expander that are
 *  pure virtual/alias-addressed pins with no physical `P<Letter><NN>` chip address at all (e.g.
 *  `"duex.e2stop" ... // E2_STOP`) - the array position is still real and ordered, but the comment
 *  format isn't a reliable identity source across every board. `canonicalName` is derived from the
 *  pin's own first listed alias instead (`buildBoardTable`, below), which is always present whenever
 *  a row has any name at all. Preprocessor lines (`#if`/`#endif`/etc.) abort the whole board - "stop
 *  and report" (task 17 README rule 6) rather than silently emit a wrong/partial table. */
function parseRows(block, boardFile) {
	const lines = block.split("\n");
	const rows = [];
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (line.length === 0) continue;
		if (line.startsWith("//") && !line.includes("{")) continue; // a bare "// Port A" section header
		if (line.startsWith("#")) {
			throw new Error(`${boardFile}: preprocessor line inside PinTable[] ("${line}") - this board needs a build-variant decision before it can be included, see this script's own doc comment`);
		}
		const braceOpen = line.indexOf("{");
		if (braceOpen < 0) continue; // e.g. a blank/comment-only line already handled above
		const braceClose = line.indexOf("}", braceOpen);
		if (braceClose < 0) {
			throw new Error(`${boardFile}: a row's { ... } doesn't close on the same line ("${line}") - this script assumes one row per line, re-check`);
		}
		rows.push({ fields: line.slice(braceOpen + 1, braceClose), comment: line.slice(braceClose).replace(/^\},?\s*\/\/\s*/, "").trim() });
	}
	return rows;
}

/** A handful of rows use a NAMED constant instead of a literal string for `pinNames` (confirmed: two
 *  real cases across these 6 boards, both `ModbusTxPinName` - `Pins_Duet3_MB6HC.h`/`Pins_Duet3_MB6XD
 *  .h`, each board's own separately-defined `constexpr const char *ModbusTxPinName = "rs485.tx";`).
 *  Resolved by looking up that exact declaration elsewhere in the same file - never assumed to have
 *  the same value across boards, even though both happen to. */
function resolvePinNameConstant(fileText, constantName, boardFile) {
	const re = new RegExp(`\\b${constantName}\\s*=\\s*"([^"]*)"`);
	const match = fileText.match(re);
	if (match === null) {
		throw new Error(`${boardFile}: pinNames field references "${constantName}" but no "${constantName} = \\"...\\"" declaration was found in the same file`);
	}
	return match[1];
}

/** Splits a row's field list on top-level commas only - i.e. NOT commas inside a quoted string, since
 *  `pinNames` itself is routinely a single string containing multiple comma-separated aliases (e.g.
 *  `"lcd.a0,exp1.7,spi.cs4"`); a naive `fields.split(",")` would wrongly split that string apart too. */
function splitTopLevelFields(fields) {
	const parts = [];
	let current = "";
	let inQuotes = false;
	for (const ch of fields) {
		if (ch === '"') inQuotes = !inQuotes;
		if (ch === "," && !inQuotes) {
			parts.push(current);
			current = "";
		} else {
			current += ch;
		}
	}
	parts.push(current);
	return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

/** The last field in a row's field list is always `pinNames` (confirmed: every other field in every
 *  board's `PinDescription` is an enum/int, never a string literal or identifier itself) - either
 *  `nullptr`, a literal `"..."` string (itself possibly containing internal commas - see
 *  `splitTopLevelFields`), or (rarely) a named constant identifier ending `PinName`. */
function extractPinNames(fields, fileText, boardFile, context) {
	const topLevelFields = splitTopLevelFields(fields);
	const last = topLevelFields[topLevelFields.length - 1];
	if (last === "nullptr") return null;
	if (last.startsWith('"') && last.endsWith('"')) return last.slice(1, -1);
	if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(last)) return resolvePinNameConstant(fileText, last, boardFile);
	throw new Error(`${boardFile}: row for ${context}'s last field ("${last}") is neither nullptr, a quoted string, nor a plain identifier - unexpected shape`);
}

function buildBoardTable(clone, tag, boardId, boardFile) {
	const fileText = git(clone, ["show", `${tag}:src/Config/${boardFile}`]);
	const block = extractPinTableBlock(fileText, boardFile);
	const rows = parseRows(block, boardFile);

	const pins = [];
	for (const row of rows) {
		const pinNames = extractPinNames(row.fields, fileText, boardFile, row.comment || "(no comment)");
		if (pinNames === null) continue; // not addressable by name from G-code at all
		const aliases = pinNames.split(",").map((a) => a.trim()).filter((a) => a.length > 0)
			.map((a) => (a.startsWith("!") ? a.slice(1) : a)); // strip the hardware-inverted marker (see doc comment)
		if (aliases.length === 0) continue;
		pins.push({ canonicalName: aliases[0], aliases });
	}

	return {
		boardId,
		family: "duet-compiled",
		pins,
		sources: [`RRF ${tag} Config/${boardFile} PinTable[]`],
	};
}

function main() {
	const argv = process.argv.slice(2);
	let clone = DEFAULT_CLONE, tag = DEFAULT_TAG;
	for (let i = 0; i < argv.length; i++) {
		if (argv[i] === "--rrf") clone = argv[++i];
		else if (argv[i] === "--tag") tag = argv[++i];
	}

	const tables = Object.entries(BOARD_FILES)
		.map(([boardId, boardFile]) => buildBoardTable(clone, tag, boardId, boardFile))
		.sort((a, b) => (a.boardId < b.boardId ? -1 : a.boardId > b.boardId ? 1 : 0));
	const totalPins = tables.reduce((n, t) => n + t.pins.length, 0);

	const header = `/**
 * Official Duet mainboard pin tables - GENERATED by \`scripts/build-pin-tables-duet.mjs\` from each
 * board's own compiled \`PinTable[]\` in \`RepRapFirmware/src/Config/Pins_*.h\`. Do not hand-edit; edit
 * the generator (or re-run it against updated RRF source) instead. See
 * \`docs/tasks/17-pin-names-and-validation.md\` (Part B). \`Pins_FMDC.h\` is deliberately NOT included -
 * see the generator script's own doc comment (real conditional compilation it doesn't resolve).
 */

import type { BoardPinTable } from "./schema.js";

export const DUET_BOARD_PIN_TABLES: ReadonlyArray<BoardPinTable> = Object.freeze(
${JSON.stringify(tables, null, "\t")}
);
`;
	mkdirSync(join(ROOT, "src", "pins"), { recursive: true });
	writeFileSync(OUT_TS, header);
	console.log(`Wrote ${OUT_TS}: ${tables.length} boards, ${totalPins} pins total.`);
}

main();
