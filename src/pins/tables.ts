/**
 * The public pin-table API (task 17, Part B) - one uniform `lookupPinName` over every board family,
 * even though each family's own matching rules are genuinely different (task 17's Findings):
 * `rrfpins-txt` boards match case-insensitively and tolerate `_`/`-` the user typed but the file
 * doesn't have; a `duet-compiled` board matches case-sensitively with no separator tolerance AND has
 * no generic port.pin fallback at all - confirmed by reading the mainline's complete `LookupPinName`
 * (`Config/Pins.cpp`) end to end (task 17's Decision 9): it returns `false` outright when no alias in
 * `PinTable[]` matches, unlike the `rrfpins-txt` family's own `BoardConfig::LookupPinName`, which
 * falls back to `StringToPin`. `PA1`-style typing is genuinely STM32/community-board-exclusive, not a
 * simplification - a real Duet board rejects it. Callers never need to know any of this; it's all
 * inside `lookupPinName` below.
 */

import { COMMUNITY_BOARD_PIN_TABLES } from "./communityBoards.js";
import { DUET_BOARD_PIN_TABLES } from "./duetBoards.js";
import { parsePortPin } from "./portPin.js";
import type { BoardPinTable, PinTableEntry } from "./schema.js";

export type { BoardPinTable, PinTableEntry } from "./schema.js";

/** Every board this package knows a pin table for, across every family. */
export const BOARD_PIN_TABLES: ReadonlyArray<BoardPinTable> = [...DUET_BOARD_PIN_TABLES, ...COMMUNITY_BOARD_PIN_TABLES];

const byBoardId = new Map<string, BoardPinTable>(BOARD_PIN_TABLES.map((t) => [t.boardId, t]));

/** `rrfpins-txt`'s own alias-matching rule - a direct port of `Hardware/TGBTC/BoardConfig.cpp`'s
 *  `LookupPinName` per-alias loop (`upstream/v3.7-dev:...BoardConfig.cpp:947-968`), not a
 *  reconstruction from memory: case-insensitive; a LEADING `_` on the user-typed side is skipped
 *  once before comparing starts; then, after every successfully-matched character, BOTH `_` and `-`
 *  are skipped on the user-typed side before the next comparison (so `"bed_temp"`/`"bed-temp"` both
 *  match a file alias of plain `"bedtemp"`, but a file alias itself is compared literally - RRF never
 *  strips separators from the FILE'S own text, only from what the user typed). A leading hardware-pin-
 *  option modifier (`+`/`-`/`^`, then optional `!`) is skipped on the FILE alias side too, for
 *  fidelity, even though no real board's `rrfpins.txt` in this package's own sample was found to use
 *  one (task 17's Findings) - re-verify against real data before removing this as dead code. */
function rrfpinsAliasMatches(userTyped: string, fileAlias: string): boolean {
	let p = 0;
	let q = (fileAlias[0] === "+" || fileAlias[0] === "-" || fileAlias[0] === "^") ? 1 : 0;
	if (fileAlias[q] === "!") q++;
	while (userTyped[p] === "_") p++;
	while (p < userTyped.length && q < fileAlias.length && userTyped[p].toLowerCase() === fileAlias[q].toLowerCase()) {
		p++; q++;
		while (userTyped[p] === "_" || userTyped[p] === "-") p++;
	}
	return p === userTyped.length && q === fileAlias.length;
}

/**
 * Looks up a pin name typed in G-code against a specific board's table. Tries the board's own alias
 * list first (per-family matching rule), then the generic `PA1`/`PA_1`/`PA.1`/`A1`/`A_1`/`A.1`
 * port.pin fallback (`parsePortPin`) - RRF's own `LookupPinName` does the same two-step fallback for
 * `rrfpins-txt` boards (task 17's Findings). Returns the matched entry (whose own `canonicalName` is
 * the identity to use for duplicate-pin comparisons), or `null` if the board is unknown or nothing
 * matches.
 */
export function lookupPinName(boardId: string, name: string): PinTableEntry | null {
	const table = byBoardId.get(boardId);
	if (table === undefined) return null;

	for (const entry of table.pins) {
		for (const alias of entry.aliases) {
			if (table.family === "rrfpins-txt" ? rrfpinsAliasMatches(name, alias) : name === alias) {
				return entry;
			}
		}
	}

	// The generic port.pin fallback is rrfpins-txt-exclusive (task 17's Decision 9, confirmed by
	// reading the mainline's complete LookupPinName end to end - Config/Pins.cpp - it returns false
	// outright when no PinTable[] alias matches; there is no numeric fallback of any kind there). A
	// duet-compiled board rejects PA1-style typing for real, so this function must too.
	if (table.family !== "rrfpins-txt") return null;

	const parsed = parsePortPin(name);
	if (parsed === null) return null;
	// RRF's own StringToPin fallback (cited in portPin.ts) trusts ANY syntactically valid port.pin
	// form unconditionally - it never checks the result against the board's own alias table at all,
	// so a numeric address for a real MCU pin that just isn't broken out/named on this board still
	// "succeeds" in real RRF. Match that faithfully: if the board's table happens to already have this
	// exact canonicalName (from its own alias data), return that entry; otherwise synthesise one with
	// no aliases rather than returning null - this is a deliberate match of RRF's permissiveness for
	// the numeric form, not a fallback bug.
	const canonicalName = `${String.fromCharCode("A".charCodeAt(0) + parsed.port)}.${parsed.pin}`;
	return table.pins.find((e) => e.canonicalName === canonicalName) ?? { canonicalName, aliases: [] };
}
