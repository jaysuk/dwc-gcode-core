/**
 * Running machine state derived from the G-code stream, one line at a time — the offline stepper's
 * (and any host's per-line gutter's) shared notion of "which layer is this, what Z, which tool, is E
 * relative", computed once per line and carried forward rather than re-derived from scratch.
 *
 * Layer detection prefers the slicer's own marker comment, because the geometric fallback (a
 * positive Z-only move) misfires on Z-hop, on vase mode, and on any print with a raft or a
 * z-lift-on-retract. The marker set below covers PrusaSlicer/SuperSlicer/Orca/Bambu
 * (`;LAYER_CHANGE`), Cura (`;LAYER:n`), Simplify3D (`; layer 3, Z = 0.6`) and ideaMaker
 * (`;LAYER:n`). The fallback only runs when no marker has ever been seen in the file.
 *
 * Extracted from `duet-gcode-postprocessor`'s own `model/gcode/state.ts` (task: shared stepper) —
 * moved verbatim except for import paths, so every existing behaviour/test carries over unchanged.
 */

import { AXIS_LETTERS } from "../commands/g10.js";
import { paramNumber, parseParams, unquoteString } from "../params.js";
import { splitCommands } from "./splitCommands.js";
import type { Tokenised } from "../lex.js";
import { tokenise } from "../lex.js";
import type { EvalValue } from "../expr/evaluate.js";
import type { ParsedParam } from "../params.js";

/** A `{...}`-valued parameter's ALREADY-EVALUATED value, keyed by letter - typically
 *  `ExecutionStep.resolvedParams` from `../execute.js`'s `evaluateParams` option. Optional
 *  everywhere it's threaded through: the always-on line-state gutter has no expression-evaluation
 *  context at all and never passes one, so every one of these call sites stays exactly as cheap as
 *  before for that caller - resolution only costs anything when a caller actually asks for it. */
export type ResolvedParams = ReadonlyMap<string, EvalValue>;

/** Like `paramNumber`, but when the literal read comes back empty (absent, or a `{...}` expression
 *  `paramNumber` can't itself read as a number) AND `resolved` has a NUMERIC value for this letter
 *  (from evaluating that same expression elsewhere, e.g. `execute.ts`'s `evaluateParams`), returns
 *  that instead. A non-numeric resolved value (a string/boolean/array) is treated the same as "no
 *  value" here - this tracker's own fields are all numbers, so there's nothing sensible to do with
 *  e.g. a string RPM. */
function resolveParamNumber(params: ReadonlyArray<ParsedParam>, letter: string, resolved: ResolvedParams | undefined): number | null {
	const literal = paramNumber(params, letter);
	if (literal !== null || resolved === undefined) return literal;
	const v = resolved.get(letter);
	return typeof v === "number" ? v : null;
}

export interface MachineState {
	/** 1-based line number in the source file. */
	lineNo: number;
	/** 0-based layer index; -1 before the first layer marker. */
	layer: number;
	/** Last commanded X, or null before any X move. */
	x: number | null;
	/** Last commanded Y, or null before any Y move. */
	y: number | null;
	/** Last commanded Z, or null before any Z move. */
	z: number | null;
	/** Last commanded position of every axis OTHER than X/Y/Z (`U V W A B C D`, see
	 *  {@link axisLetters}), keyed by letter - only letters that have had a position appear. Kept apart
	 *  from `x`/`y`/`z` so the hot per-line path for a printer file (which never names these) stays
	 *  allocation-free, and replaced (never mutated) on a change so a `{ ...state }` snapshot taken
	 *  earlier is never disturbed by a later step. Read through {@link axisPosition}. */
	extraAxes: Readonly<Record<string, number>>;
	/** The axes this walk knows exist, in `move.axes[]` index order. Starts as `X Y Z`; a move (or
	 *  `G92`/`G28`/`M584`) naming another {@link AXIS_LETTERS} letter appends it. A single file has no
	 *  `config.g` to say which axes the machine has, so naming one IS what declares it here - RRF would
	 *  reject an unconfigured letter at runtime, but staying silent about a `U` move in a macro someone
	 *  is stepping through would be the less useful failure. Replaced, never mutated (see `extraAxes`). */
	axisLetters: ReadonlyArray<string>;
	/** Running extruder position for the active tool, or null before any extrusion. An E move in
	 *  relative mode (M83) accumulates onto this the same way a relative X/Y/Z move accumulates onto
	 *  {@link x}/{@link y}/{@link z} under G91 - see {@link relativeE}. */
	e: number | null;
	/** Active tool number; -1 when none has been selected. */
	tool: number;
	/** Last commanded feedrate (mm/min), or null. */
	feedrate: number | null;
	/** True after G91 (relative axis moves), false after G90. */
	relativeMoves: boolean;
	/** True after M83 (relative extrusion), false after M82. */
	relativeE: boolean;
	/** True once a `G28` covering this axis has been seen (bare `G28` homes all three; `G28 X`/`G28 Y`/
	 *  `G28 Z` home only the named ones). A simplification, not real RRF homing semantics - RRF only
	 *  actually sets an axis's homed bit once the homing MACRO it runs (`homeall.g`/`homex.g`/...)
	 *  completes successfully (an endstop really triggering during a `G1 H1` move), which this tracker
	 *  has no way to simulate. For a single-file offline stepper "a G28 covering this axis was executed
	 *  earlier in the file" is the useful, honest question to answer instead - see
	 *  `executionIndex.ts`'s own `resolveKnownPath` for how this is used. Assumes the default RRF axis
	 *  order (0=X, 1=Y, 2=Z) - a config that reassigns axis letters via `M584` isn't accounted for. */
	homedX: boolean;
	homedY: boolean;
	homedZ: boolean;
	/** Letters of the axes OTHER than X/Y/Z that a `G28` has covered - the same simplification as
	 *  `homedX`, replaced rather than mutated. */
	homedExtra: ReadonlyArray<string>;
	/** Current object label from M486, or null. */
	object: string | null;
	/** Current feature type from the slicer's `;TYPE:` comment, or null. */
	featureType: string | null;
	/** True on the line where the layer index changed. */
	layerChanged: boolean;
	/** True once a layer-change marker comment has been seen (disables the geometric fallback). */
	sawLayerMarker: boolean;
	/**
	 * Whether a Z-only rise may be counted as a layer change. Turned off by the caller when the
	 * pre-scan has already found real markers in the file: a Prusa/Orca start block moves Z before
	 * its first marker, and guessing there would fire every layer-anchored step one extra time
	 * before the print has started.
	 */
	geometricFallback: boolean;
}

/** Matches `;LAYER_CHANGE`, `;AFTER_LAYER_CHANGE`, `;BEFORE_LAYER_CHANGE`. */
const RE_LAYER_CHANGE = /^\s*(?:AFTER_|BEFORE_)?LAYER_CHANGE\s*$/i;
/** Matches Cura/ideaMaker `;LAYER:12`. */
const RE_LAYER_INDEX = /^\s*LAYER:\s*(-?\d+)\s*$/i;
/** Matches Simplify3D `; layer 3, Z = 0.6`. */
const RE_S3D_LAYER = /^\s*layer\s+(\d+)\s*,/i;
/** Matches the slicer feature comment `;TYPE:Perimeter`. */
const RE_TYPE = /^\s*TYPE:\s*(.+?)\s*$/i;

/**
 * Where the machine "already is" before the first line of a file runs. The offline stepper walks a
 * single file with no live machine, so a macro that does `G91` / `G1 Z5` (a relative move from
 * wherever the head happens to be) has nothing to be relative TO unless the user says where the
 * machine starts. Every field is optional; an omitted one keeps `createState`'s own default
 * ("unknown" for positions).
 */
export interface InitialMachineState {
	/** Starting position per axis letter (`{ X: 100, Y: 100, Z: 20, U: 5 }`). A letter that isn't
	 *  `X`/`Y`/`Z` also declares that axis (see {@link MachineState.axisLetters}). A letter that is not
	 *  an axis letter, or a non-finite value, is ignored rather than thrown on - this is typically
	 *  parsed from user input. */
	axes?: Readonly<Record<string, number>>;
	/** Extra axes to declare (in `move.axes[]` order after X/Y/Z) even before anything positions
	 *  them, e.g. a machine's `U` that the file only homes. */
	axisLetters?: ReadonlyArray<string>;
	/** Letters (`"X"`, `"U"`, ...) that start out homed. */
	homed?: ReadonlyArray<string>;
	e?: number;
	/** Selected tool, `-1` for none. */
	tool?: number;
	feedrate?: number;
	/** `G91` in force. */
	relativeMoves?: boolean;
	/** `M83` in force. */
	relativeE?: boolean;
}

const EXTRA_AXIS_LETTERS: ReadonlySet<string> = new Set(AXIS_LETTERS.filter((l) => l !== "X" && l !== "Y" && l !== "Z"));

function isFiniteNumber(v: unknown): v is number {
	return typeof v === "number" && Number.isFinite(v);
}

/** `letters` with `letter` appended when it isn't already there - `letters` itself when it is, so
 *  the common case allocates nothing. */
function withAxisLetter(letters: ReadonlyArray<string>, letter: string): ReadonlyArray<string> {
	return letters.includes(letter) ? letters : [...letters, letter];
}

export function createState(options: { geometricFallback?: boolean; initial?: InitialMachineState } = {}): MachineState {
	const state: MachineState = {
		geometricFallback: options.geometricFallback !== false,
		lineNo: 0,
		layer: -1,
		x: null,
		y: null,
		z: null,
		extraAxes: {},
		axisLetters: ["X", "Y", "Z"],
		e: null,
		tool: -1,
		feedrate: null,
		relativeMoves: false,
		relativeE: false,
		homedX: false,
		homedY: false,
		homedZ: false,
		homedExtra: [],
		object: null,
		featureType: null,
		layerChanged: false,
		sawLayerMarker: false,
	};
	if (options.initial !== undefined) applyInitialState(state, options.initial);
	return state;
}

function applyInitialState(state: MachineState, initial: InitialMachineState): void {
	for (const letter of initial.axisLetters ?? []) {
		const l = letter.toUpperCase();
		if (EXTRA_AXIS_LETTERS.has(l)) state.axisLetters = withAxisLetter(state.axisLetters, l);
	}
	for (const [letter, value] of Object.entries(initial.axes ?? {})) {
		if (isFiniteNumber(value)) setAxisPosition(state, letter.toUpperCase(), value);
	}
	for (const letter of initial.homed ?? []) markHomed(state, letter.toUpperCase());
	if (isFiniteNumber(initial.e)) state.e = initial.e;
	if (isFiniteNumber(initial.tool)) state.tool = initial.tool;
	if (isFiniteNumber(initial.feedrate)) state.feedrate = initial.feedrate;
	if (initial.relativeMoves !== undefined) state.relativeMoves = initial.relativeMoves;
	if (initial.relativeE !== undefined) state.relativeE = initial.relativeE;
}

/** The last commanded position of the axis with this letter (any of `AXIS_LETTERS`), or null when
 *  it has never been positioned. */
export function axisPosition(state: MachineState, letter: string): number | null {
	switch (letter) {
		case "X": return state.x;
		case "Y": return state.y;
		case "Z": return state.z;
		default: return state.extraAxes[letter] ?? null;
	}
}

/** Sets an axis's position outright (no relative-move arithmetic), declaring it when it's an extra
 *  axis the state hasn't seen. False for a letter that isn't an axis letter at all. */
function setAxisPosition(state: MachineState, letter: string, value: number): boolean {
	switch (letter) {
		case "X": state.x = value; return true;
		case "Y": state.y = value; return true;
		case "Z": state.z = value; return true;
		default:
			if (!EXTRA_AXIS_LETTERS.has(letter)) return false;
			state.axisLetters = withAxisLetter(state.axisLetters, letter);
			state.extraAxes = { ...state.extraAxes, [letter]: value };
			return true;
	}
}

function markHomed(state: MachineState, letter: string): void {
	switch (letter) {
		case "X": state.homedX = true; break;
		case "Y": state.homedY = true; break;
		case "Z": state.homedZ = true; break;
		default:
			if (!EXTRA_AXIS_LETTERS.has(letter)) return;
			state.axisLetters = withAxisLetter(state.axisLetters, letter);
			if (!state.homedExtra.includes(letter)) state.homedExtra = [...state.homedExtra, letter];
	}
}

/** Whether a `G28` (or the initial state) has homed the axis with this letter. */
export function axisHomed(state: MachineState, letter: string): boolean {
	switch (letter) {
		case "X": return state.homedX;
		case "Y": return state.homedY;
		case "Z": return state.homedZ;
		default: return state.homedExtra.includes(letter);
	}
}

/**
 * Reset the bookkeeping that belongs to one *physical* source line — the line counter and the
 * layer-changed flag — before applying its command(s). Call exactly once per physical line,
 * regardless of how many commands it holds (`splitCommands.ts`: RRF allows several — `G90 G1 X10` is
 * two), then call {@link applyToken} once per command. `layerChanged` is deliberately not reset
 * again between those `applyToken` calls: whichever command on the line carries the layer marker
 * must not have its flag clobbered by a later command on the same line that carries none.
 */
export function beginLine(state: MachineState): void {
	state.lineNo++;
	state.layerChanged = false;
}

/**
 * Apply one already-tokenised command's effect to the state. `beginLine` must already have been
 * called once for the physical line this command came from. `token` must be the tokenised
 * **original** text: state tracking describes the source file, so a step that rewrites a command
 * does not retroactively change what layer a later command is on.
 *
 * `resolved`, when given, supplies already-evaluated values for this SAME line's `{...}`-valued
 * parameters (see `ResolvedParams`'s own doc comment) - without it, a parameter like `X{param.X}`
 * reads as absent, exactly as it always has.
 */
export function applyToken(state: MachineState, token: Tokenised, resolved?: ResolvedParams): void {
	if (token.comment !== null) {
		applyComment(state, token.comment);
	}
	if (token.code === null) return;

	switch (token.letter) {
		case "T": {
			// A bare T-1 unloads; T without a number was already rejected by the tokeniser
			if (token.number !== null) state.tool = token.number;
			break;
		}
		case "G": {
			applyG(state, token, resolved);
			break;
		}
		case "M": {
			applyM(state, token, resolved);
			break;
		}
	}
}

/**
 * Advance the state by one source line holding exactly one command — `beginLine` + `applyToken` in
 * one call. Kept for the many callers (and tests) that only ever see a single-command line; a caller
 * that must handle a line with several commands (see `splitCommands.ts`) calls `beginLine` once and
 * `applyToken` once per command instead.
 */
export function advance(state: MachineState, token: Tokenised, resolved?: ResolvedParams): void {
	beginLine(state);
	applyToken(state, token, resolved);
}

/** Applies one physical line's effect to `state` in place — the shared per-line update every caller
 *  (a flat top-to-bottom index, or `executionIndex.ts`'s branch/loop-aware walk) drives. `resolved`
 *  is the SAME per-line `{...}`-parameter map `applyToken`'s own doc comment describes - when the
 *  line holds more than one command (`splitCommands.ts`), every command sees the whole map; letters
 *  don't collide within one physical line's own commands in practice. */
export function applyLineToState(state: MachineState, raw: string, resolved?: ResolvedParams): void {
	const subLines = splitCommands(raw);
	beginLine(state);
	for (const subRaw of subLines) applyToken(state, tokenise(subRaw), resolved);
}

function applyComment(state: MachineState, comment: string): void {
	if (RE_LAYER_CHANGE.test(comment)) {
		// The first marker of any kind is authoritative and discards whatever the geometric
		// fallback counted: real slicer start G-code contains a Z move (a purge line, the
		// first-layer approach) before the first marker, and counting it puts every layer out by
		// one. Note Prusa's BEFORE_LAYER_CHANGE arrives before the bare marker, so the reset has to
		// happen here rather than inside the bare-marker branch below
		if (!state.sawLayerMarker) {
			state.layer = -1;
			state.sawLayerMarker = true;
		}
		// Prusa/Orca emit BEFORE_LAYER_CHANGE and AFTER_LAYER_CHANGE around one bare LAYER_CHANGE.
		// Counting all three would treble the layer count, so only the bare marker increments.
		if (/^\s*LAYER_CHANGE\s*$/i.test(comment)) {
			state.layer++;
			state.layerChanged = true;
		}
		return;
	}
	const indexed = RE_LAYER_INDEX.exec(comment);
	if (indexed !== null) {
		const n = Number(indexed[1]);
		if (Number.isFinite(n)) {
			state.layer = n;
			state.layerChanged = true;
			state.sawLayerMarker = true;
		}
		return;
	}
	const s3d = RE_S3D_LAYER.exec(comment);
	if (s3d !== null) {
		const n = Number(s3d[1]);
		if (Number.isFinite(n)) {
			// Simplify3D numbers layers from 1; normalise to the 0-based index everything else uses
			state.layer = n - 1;
			state.layerChanged = true;
			state.sawLayerMarker = true;
		}
		return;
	}
	const type = RE_TYPE.exec(comment);
	if (type !== null) {
		state.featureType = type[1];
	}
}

/** Absolute-or-relative axis update, matching how G91 already applies to Z above: a relative move
 *  accumulates onto the running position, an absolute one replaces it outright. Shared by X/Y (no
 *  layer-detection side effect) and, via {@link applyExtrusion}, E under M83. */
function applyAxisPosition(current: number | null, commanded: number, relative: boolean): number {
	return relative && current !== null ? current + commanded : commanded;
}

function applyExtrusion(state: MachineState, e: number | null): void {
	if (e !== null) state.e = applyAxisPosition(state.e, e, state.relativeE);
}

/** Calls `fn` for every axis OTHER than X/Y/Z that this command names a numeric value for - written
 *  literally or supplied by an already-evaluated `{...}` parameter. A cheap no-op for the printer
 *  files this tracker mostly sees, which never name one. */
function forEachExtraAxis(
	params: ReadonlyArray<ParsedParam>,
	resolved: ResolvedParams | undefined,
	fn: (letter: string, value: number) => void,
): void {
	for (const p of params) {
		if (!EXTRA_AXIS_LETTERS.has(p.letter)) continue;
		const v = resolveParamNumber(params, p.letter, resolved);
		if (v !== null) fn(p.letter, v);
	}
	if (resolved === undefined) return;
	for (const [letter, value] of resolved) {
		if (!EXTRA_AXIS_LETTERS.has(letter) || typeof value !== "number") continue;
		if (paramNumber(params, letter) !== null) continue; // already handled above, from the literal
		fn(letter, value);
	}
}

function applyExtraAxisMoves(state: MachineState, params: ReadonlyArray<ParsedParam>, resolved: ResolvedParams | undefined): void {
	forEachExtraAxis(params, resolved, (letter, value) => {
		setAxisPosition(state, letter, applyAxisPosition(axisPosition(state, letter), value, state.relativeMoves));
	});
}

function applyG(state: MachineState, token: Tokenised, resolved: ResolvedParams | undefined): void {
	switch (token.number) {
		case 0:
		case 1: {
			const params = parseParams(token.body);
			const x = resolveParamNumber(params, "X", resolved);
			const y = resolveParamNumber(params, "Y", resolved);
			const z = resolveParamNumber(params, "Z", resolved);
			const e = resolveParamNumber(params, "E", resolved);
			const f = resolveParamNumber(params, "F", resolved);
			if (f !== null) state.feedrate = f;
			if (x !== null) state.x = applyAxisPosition(state.x, x, state.relativeMoves);
			if (y !== null) state.y = applyAxisPosition(state.y, y, state.relativeMoves);
			if (z !== null) {
				const newZ = applyAxisPosition(state.z, z, state.relativeMoves);
				// Geometric fallback: only for files with no layer marker at all, and only on a
				// Z-only rise (a move that also travels in XY is a ramp, not a layer change)
				if (state.geometricFallback && !state.sawLayerMarker && newZ > (state.z ?? -Infinity)) {
					const hasXY = params.some((p) => p.letter === "X" || p.letter === "Y");
					if (!hasXY) {
						state.layer++;
						state.layerChanged = true;
					}
				}
				state.z = newZ;
			}
			applyExtraAxisMoves(state, params, resolved);
			applyExtrusion(state, e);
			break;
		}
		// Arc moves (G2 clockwise / G3 counter-clockwise): X/Y/Z/E name the same destination
		// coordinates a G1 would (RRF's own DoArcMove, hardware-independent of I/J/R, reads them via
		// the same per-axis parameter path a straight move does). Deliberately NOT given the G0/G1
		// case's geometric layer-fallback: that heuristic is specifically about a plain Z-only rise
		// during printing, and arcs combined with a layer change are not a pattern worth guessing at
		// without a real example to verify against.
		case 2:
		case 3: {
			const params = parseParams(token.body);
			const x = resolveParamNumber(params, "X", resolved);
			const y = resolveParamNumber(params, "Y", resolved);
			const z = resolveParamNumber(params, "Z", resolved);
			const e = resolveParamNumber(params, "E", resolved);
			const f = resolveParamNumber(params, "F", resolved);
			if (f !== null) state.feedrate = f;
			if (x !== null) state.x = applyAxisPosition(state.x, x, state.relativeMoves);
			if (y !== null) state.y = applyAxisPosition(state.y, y, state.relativeMoves);
			if (z !== null) state.z = applyAxisPosition(state.z, z, state.relativeMoves);
			applyExtraAxisMoves(state, params, resolved);
			applyExtrusion(state, e);
			break;
		}
		case 28: {
			// Bare G28 homes every axis it knows about; G28 X/Y/Z homes only the named ones - see
			// MachineState.homedX's own doc comment for what "homed" means here (a simplification, not
			// real endstop-triggered semantics).
			const params = parseParams(token.body);
			const hasAny = params.some((p) => p.letter === "X" || p.letter === "Y" || p.letter === "Z" || EXTRA_AXIS_LETTERS.has(p.letter));
			if (!hasAny || params.some((p) => p.letter === "X")) state.homedX = true;
			if (!hasAny || params.some((p) => p.letter === "Y")) state.homedY = true;
			if (!hasAny || params.some((p) => p.letter === "Z")) state.homedZ = true;
			// A bare G28 homes every axis THIS WALK knows about, extras included; a named extra axis
			// declares itself the way a move naming it does.
			for (const p of params) if (EXTRA_AXIS_LETTERS.has(p.letter)) markHomed(state, p.letter);
			if (!hasAny) for (const letter of state.axisLetters) markHomed(state, letter);
			break;
		}
		case 90:
			state.relativeMoves = false;
			break;
		case 91:
			state.relativeMoves = true;
			break;
		case 92: {
			const params = parseParams(token.body);
			const x = resolveParamNumber(params, "X", resolved);
			const y = resolveParamNumber(params, "Y", resolved);
			const z = resolveParamNumber(params, "Z", resolved);
			const e = resolveParamNumber(params, "E", resolved);
			// G92 sets the CURRENT position without moving there - always absolute, regardless of
			// G90/G91, since it's redefining what "here" means rather than commanding a move.
			if (x !== null) state.x = x;
			if (y !== null) state.y = y;
			if (z !== null) state.z = z;
			forEachExtraAxis(params, resolved, (letter, value) => { setAxisPosition(state, letter, value); });
			if (e !== null) state.e = e;
			break;
		}
	}
}

function applyM(state: MachineState, token: Tokenised, resolved: ResolvedParams | undefined): void {
	switch (token.number) {
		case 82:
			state.relativeE = false;
			break;
		case 83:
			state.relativeE = true;
			break;
		case 584: {
			// M584 names the axes the machine has (`M584 X0 Y1 Z2 U3`): declare each extra letter so
			// `move.axes[]` indexes and later homed/position reads know about it. Its drive numbers and
			// `E` (extruder drives) are not modelled.
			for (const p of parseParams(token.body)) {
				if (EXTRA_AXIS_LETTERS.has(p.letter)) state.axisLetters = withAxisLetter(state.axisLetters, p.letter);
			}
			break;
		}
		case 486: {
			const params = parseParams(token.body);
			const s = resolveParamNumber(params, "S", resolved);
			if (s !== null) {
				state.object = s < 0 ? null : String(s);
			}
			// RRF/Orca also carry a human label: M486 S3 A"handle"
			for (const p of params) {
				if (p.letter === "A") {
					state.object = unquoteString(p.value);
					break;
				}
			}
			break;
		}
	}
}
