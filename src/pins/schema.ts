/**
 * Board pin-name tables (task 17, `docs/tasks/17-pin-names-and-validation.md`, Part B). Two board
 * families feed `BOARD_PIN_TABLES` (`src/pins/tables.ts`), each with its own generator, own matching
 * rules and own citations - `family` here is provenance metadata only, never something a consumer
 * needs to branch on (`lookupPinName` hides the difference).
 */

export interface PinTableEntry {
	/** The board's own canonical identity for this physical pin - a `port.pin` form (`"A.5"`) for a
	 *  `rrfpins-txt` board, or whichever spelling that board's own compiled `PinTable[]` uses as its
	 *  first/primary name for a `duet-compiled` one. Two aliases that resolve to the same physical pin
	 *  share this value - that's what makes duplicate-pin detection (a later step) possible. */
	canonicalName: string;
	/** Every name RRF itself accepts for this pin on this board, as given in its own source (a
	 *  `rrfpins-txt` board's comma-separated alias list, or a compiled board's `pinNames` string) -
	 *  does NOT include the generic `PA1`/`PA_1`/`PA.1`/`A1`/`A_1`/`A.1` port.pin forms, which are a
	 *  separate, algorithmic fallback (`src/pins/portPin.ts`), not per-pin data. */
	aliases: ReadonlyArray<string>;
}

export interface BoardPinTable {
	/** `"<manufacturer>/<model>"` for an `rrfpins-txt` board (its path under `boards/` in the
	 *  gloomyandy/RRFBuild repo, e.g. `"btt/octopuspro1_1_h723"`); TBD for `duet-compiled` boards
	 *  (task 17 Step 6, not yet built). */
	boardId: string;
	family: "duet-compiled" | "rrfpins-txt";
	pins: ReadonlyArray<PinTableEntry>;
	sources: ReadonlyArray<string>;
}
