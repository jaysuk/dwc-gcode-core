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
	/** What each axis's endstop does when a `G1 H1` homing move runs - see {@link EndstopModel}. Fixed
	 *  for the whole walk (it is machine configuration, `M574`/`M208`, which no single file carries), so
	 *  it is only ever set from {@link InitialMachineState.endstops}. */
	endstops: Readonly<Record<string, EndstopModel>>;
	/** What the Z probe does when `G30`/`G29`/`G38.x` probes - see {@link ProbeModel}. Fixed for the whole
	 *  walk, like {@link endstops}. */
	probe: ProbeModel;
	/** Set by the line that just ran when one of its commands FAILED under the scenario - a `G28` whose
	 *  axis never homed, a probe that never triggered - with the message RRF would give; null otherwise.
	 *  Cleared by `beginLine`. `buildExecutionIndex` turns it into the walk stopping with an error there,
	 *  which is what RRF does to a macro on an error. */
	fault: string | null;
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
 * How one axis's endstop behaves under a `G1 H1` homing move. RRF's homing move (`G1 H1`, RRF 3.7.0-rc.1
 * `GCodes::DoStraightMove` and the `waitingForSpecialMoveToComplete` state in `GCodes4.cpp`) runs until
 * the axis's endstop triggers; then, for each axis named in the move whose endstop DID trigger, the
 * axis position is set to `AxisMaximum` (an endstop at the high end) or `AxisMinimum` (low end) and the
 * axis is flagged homed. An axis whose endstop never triggers just ends up where the move was
 * commanded to go, not homed. None of that configuration (`M574` for the end, `M208` for the limits) is
 * in the file being stepped, so a scenario states it here; every field is optional.
 */
export interface EndstopModel {
	/** Which end the endstop is at (`M574`): `"low"` sets the axis to its minimum, `"high"` to its
	 *  maximum, `"none"` means no endstop, so the move never triggers. Omitted, it is the end the move
	 *  heads toward: negative (or towards a lower known position) is low, otherwise high. */
	end?: "low" | "high" | "none";
	/** The axis minimum (`M208 S1`). RRF's own default is 0 (`DefaultAxisMinimum`). */
	min?: number;
	/** The axis maximum (`M208`). RRF's own default is 200 (`DefaultAxisMaximum`). */
	max?: number;
	/** False to simulate an endstop that never triggers (a broken switch, or a move that stops short).
	 *  A `G1 H1` move then completes at its target and the axis stays unhomed; a `G28` covering the axis
	 *  FAILS, as RRF's does when the homing macro left an axis unhomed (`GCodes4.cpp`, `homing2`:
	 *  "Failed to home axes X"), which stops the walk there. Default true. */
	triggers?: boolean;
}

/** RRF's `DefaultAxisMinimum` / `DefaultAxisMaximum` (`Config/Configuration.h`), used when a scenario
 *  gives an axis no `M208` limits. */
export const DEFAULT_AXIS_MINIMUM = 0;
export const DEFAULT_AXIS_MAXIMUM = 200;

/**
 * The Z probe a `G30`, `G29` or `G38.x` probing move uses (probe 0; `K` is not modelled). Like
 * {@link EndstopModel} it is machine configuration (`G31`, `M558`) that the file being stepped doesn't
 * carry, so a scenario states it and a host can seed it from the machine's object model; every field is
 * optional.
 */
export interface ProbeModel {
	/** False to simulate a probe that never triggers - a wrong wiring, a probe that is out of range, a
	 *  bed that is too far away. A `G30`/`G29` then FAILS ("Probe was not triggered during probing move",
	 *  RRF `GCodes4.cpp`, `probingAtPoint4`) and so does `G38.2`/`G38.4`, which stops the walk there; a
	 *  `G38.3`/`G38.5` just completes its move. Default true. */
	triggers?: boolean;
	/** The Z at which the probe triggers (`G31 Z`). RRF's default is 0.7 (`DefaultZProbeTriggerHeight`). */
	triggerHeight?: number;
	/** The height the probe retracts above the trigger height after probing (`M558 H`). RRF's default is
	 *  5 (`DefaultZDive`). */
	diveHeight?: number;
}

/** RRF's `DefaultZProbeTriggerHeight` / `DefaultZDive` (`Config/Configuration.h`). */
export const DEFAULT_PROBE_TRIGGER_HEIGHT = 0.7;
export const DEFAULT_PROBE_DIVE_HEIGHT = 5;

/** The messages RRF gives for these failures - they surface as the walk's error text. */
export const PROBE_NOT_TRIGGERED = "Probe was not triggered during probing move";
export const PROBE_DID_NOT_LOSE_CONTACT = "Probe did not lose contact during probing move";

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
	/** Per axis letter, what a `G1 H1` homing move does - see {@link EndstopModel}. An axis with no
	 *  entry behaves as `{}`: the endstop triggers, at the end the move heads toward, with RRF's default
	 *  limits. */
	endstops?: Readonly<Record<string, EndstopModel>>;
	/** What the Z probe does under `G30`/`G29`/`G38.x` - see {@link ProbeModel}. Omitted, the probe
	 *  triggers, with RRF's default trigger and dive heights. */
	probe?: ProbeModel;
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
		endstops: {},
		probe: {},
		fault: null,
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
	if (initial.endstops !== undefined) state.endstops = sanitiseEndstops(initial.endstops);
	if (initial.probe !== undefined) state.probe = sanitiseProbe(initial.probe);
}

/** `probe` reduced to what the simulator understands - typically parsed from user input, so anything
 *  else is dropped rather than thrown on. */
export function sanitiseProbe(probe: unknown): ProbeModel {
	if (typeof probe !== "object" || probe === null || Array.isArray(probe)) return {};
	const o = probe as Record<string, unknown>;
	const model: ProbeModel = {};
	if (typeof o.triggers === "boolean") model.triggers = o.triggers;
	if (isFiniteNumber(o.triggerHeight)) model.triggerHeight = o.triggerHeight;
	if (isFiniteNumber(o.diveHeight)) model.diveHeight = o.diveHeight;
	return model;
}

/** `endstops` reduced to what the simulator understands - typically parsed from user input, so an
 *  unknown letter, a non-finite limit or an unrecognised `end` is dropped rather than thrown on. */
export function sanitiseEndstops(endstops: Readonly<Record<string, unknown>>): Readonly<Record<string, EndstopModel>> {
	const out: Record<string, EndstopModel> = {};
	for (const [letter, raw] of Object.entries(endstops)) {
		const l = letter.toUpperCase();
		if (l !== "X" && l !== "Y" && l !== "Z" && !EXTRA_AXIS_LETTERS.has(l)) continue;
		if (typeof raw !== "object" || raw === null || Array.isArray(raw)) continue;
		const o = raw as Record<string, unknown>;
		const model: EndstopModel = {};
		if (o.end === "low" || o.end === "high" || o.end === "none") model.end = o.end;
		if (isFiniteNumber(o.min)) model.min = o.min;
		if (isFiniteNumber(o.max)) model.max = o.max;
		if (typeof o.triggers === "boolean") model.triggers = o.triggers;
		if (Object.keys(model).length > 0) out[l] = model;
	}
	return out;
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

/** The opposite of `markHomed`: the axis is (or stays) unhomed. An extra axis is still declared, since
 *  naming it is what declares it. */
function markNotHomed(state: MachineState, letter: string): void {
	switch (letter) {
		case "X": state.homedX = false; break;
		case "Y": state.homedY = false; break;
		case "Z": state.homedZ = false; break;
		default:
			if (!EXTRA_AXIS_LETTERS.has(letter)) return;
			state.axisLetters = withAxisLetter(state.axisLetters, letter);
			if (state.homedExtra.includes(letter)) state.homedExtra = state.homedExtra.filter((l) => l !== letter);
	}
}

/** Makes an axis's position unknown again, for a probing move that stopped somewhere the file can't
 *  say. Anything that later needs the position pauses the walk and asks for it. */
function forgetAxisPosition(state: MachineState, letter: string): void {
	switch (letter) {
		case "X": state.x = null; break;
		case "Y": state.y = null; break;
		case "Z": state.z = null; break;
		default:
			if (letter in state.extraAxes) state.extraAxes = Object.fromEntries(Object.entries(state.extraAxes).filter(([l]) => l !== letter));
	}
}

/** A height with the floating-point noise of adding two decimals trimmed (`0.7 + 5` is `5.7`). */
function roundMm(v: number): number {
	return Math.round(v * 1e6) / 1e6;
}

/** Records a failure for the line that is running. The first one wins: a later command on the same
 *  physical line never runs in RRF once an earlier one has errored. */
function fail(state: MachineState, message: string): void {
	state.fault ??= message;
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
	state.fault = null;
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

/** Every axis position as it stands, for `applyEndstopHits` to compare a homing move against. */
function snapshotPositions(state: MachineState): Record<string, number | null> {
	const out: Record<string, number | null> = { X: state.x, Y: state.y, Z: state.z };
	for (const letter of state.axisLetters) if (!(letter in out)) out[letter] = axisPosition(state, letter);
	return out;
}

/**
 * Finishes a `G1 H1` homing move (RRF 3.7.0-rc.1 `GCodes4.cpp`, `waitingForSpecialMoveToComplete`):
 * every axis the move named whose endstop triggered is put at its endstop position (`AxisMaximum` for a
 * high-end endstop, `AxisMinimum` for a low-end one) and flagged homed. `before` is the positions before
 * the move, only used to tell which way an axis with no declared `end` was heading. An axis the move
 * named that doesn't trigger keeps the position the ordinary move arithmetic gave it and stays as
 * homed as it was.
 */
function applyEndstopHits(
	state: MachineState,
	params: ReadonlyArray<ParsedParam>,
	resolved: ResolvedParams | undefined,
	before: Readonly<Record<string, number | null>>,
): void {
	const hit = (letter: string, commanded: number): void => {
		const model = state.endstops[letter];
		if (model?.triggers === false || model?.end === "none") return;
		const now = axisPosition(state, letter);
		const was = before[letter] ?? null;
		const towardsHigh = model?.end === undefined
			? (was !== null && now !== null ? now > was : state.relativeMoves && commanded > 0)
			: model.end === "high";
		setAxisPosition(state, letter, towardsHigh ? (model?.max ?? DEFAULT_AXIS_MAXIMUM) : (model?.min ?? DEFAULT_AXIS_MINIMUM));
		markHomed(state, letter);
	};
	for (const letter of ["X", "Y", "Z"] as const) {
		const v = resolveParamNumber(params, letter, resolved);
		if (v !== null) hit(letter, v);
	}
	forEachExtraAxis(params, resolved, hit);
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
			// `H` makes it a special move (RRF `DoStraightMove`: 1 homing, 2 raw motor, 3 sense
			// length, 4 stall): only H1 changes what this tracker records - see `applyEndstopHits`.
			const h = resolveParamNumber(params, "H", resolved);
			const before = h === 1 ? snapshotPositions(state) : null;
			if (f !== null) state.feedrate = f;
			if (x !== null) state.x = applyAxisPosition(state.x, x, state.relativeMoves);
			if (y !== null) state.y = applyAxisPosition(state.y, y, state.relativeMoves);
			if (z !== null) {
				const newZ = applyAxisPosition(state.z, z, state.relativeMoves);
				// Geometric fallback: only for files with no layer marker at all, and only on a
				// Z-only rise (a move that also travels in XY is a ramp, not a layer change) - and never
				// for a special (H) move, which is homing/probing, not printing
				if (state.geometricFallback && !state.sawLayerMarker && (h === null || h === 0) && newZ > (state.z ?? -Infinity)) {
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
			if (before !== null) applyEndstopHits(state, params, resolved, before);
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
			// real endstop-triggered semantics). The one thing a scenario can change is an axis whose
			// endstop is set never to trigger: RRF runs the homing macro, finds the axis still unhomed and
			// reports "Failed to home axes X" (`GCodes4.cpp`, `homing2`), so that axis stays unhomed and
			// the line fails. A bare G28 homes every axis THIS WALK knows about, extras included; a named
			// extra axis declares itself the way a move naming it does.
			const params = parseParams(token.body);
			const named = new Set(params.map((p) => p.letter).filter((l) => l === "X" || l === "Y" || l === "Z" || EXTRA_AXIS_LETTERS.has(l)));
			const targets = named.size > 0 ? [...named] : [...state.axisLetters];
			const failed: Array<string> = [];
			for (const letter of targets) {
				if (state.endstops[letter]?.triggers === false) {
					markNotHomed(state, letter);
					failed.push(letter);
				} else {
					markHomed(state, letter);
				}
			}
			if (failed.length > 0) {
				// RRF lists them in axis order, letters run together (`AppendAxes`).
				failed.sort((a, b) => state.axisLetters.indexOf(a) - state.axisLetters.indexOf(b));
				fail(state, `Failed to home axes ${failed.join("")}`);
			}
			break;
		}
		// G29 with no S (or S0) probes the whole mesh grid - and with no S it first runs mesh.g, which
		// can only be probing as well. S1/S2/S3.. load, clear or save a height map and never probe.
		case 29: {
			const s = resolveParamNumber(parseParams(token.body), "S", resolved);
			if ((s === null || s === 0) && state.probe.triggers === false) fail(state, PROBE_NOT_TRIGGERED);
			break;
		}
		// G30 probes down at the current XY (`GCodes4.cpp`, `probingAtPoint4`). A probe that never
		// triggers fails and changes nothing. Otherwise the head retracts to the dive height above the
		// trigger height, and a plain G30 (no P, and S not -1/-2/-3, which only report or adjust) also
		// sets Z to the trigger height first and flags it homed - so the net position is the same for
		// every variant, and only a plain G30 homes Z. A G30 P<n> records a mesh point and moves no datum.
		// The probe's own XY offset is not modelled: X/Y name where the head goes.
		case 30: {
			const params = parseParams(token.body);
			const p = resolveParamNumber(params, "P", resolved);
			const s = resolveParamNumber(params, "S", resolved);
			const x = resolveParamNumber(params, "X", resolved);
			const y = resolveParamNumber(params, "Y", resolved);
			if (x !== null) state.x = x;
			if (y !== null) state.y = y;
			if (state.probe.triggers === false) {
				fail(state, PROBE_NOT_TRIGGERED);
				break;
			}
			if (p === null && s !== -1 && s !== -2 && s !== -3) markHomed(state, "Z");
			state.z = roundMm((state.probe.triggerHeight ?? DEFAULT_PROBE_TRIGGER_HEIGHT) + (state.probe.diveHeight ?? DEFAULT_PROBE_DIVE_HEIGHT));
			break;
		}
		// G38.2/.3 probe towards the target until the probe triggers, G38.4/.5 until it lets go (RRF
		// `StraightProbe`; .2 and .4 are the ones that signal an error when it doesn't happen). The move
		// stops wherever that is, which the file can't say - except that Z heading down stops at the
		// trigger height. Every other named axis is unknown from there; a probe that never triggers
		// just completes the move.
		case 38.2:
		case 38.3:
		case 38.4:
		case 38.5: {
			const away = token.number === 38.4 || token.number === 38.5;
			const signalsError = token.number === 38.2 || token.number === 38.4;
			const params = parseParams(token.body);
			const x = resolveParamNumber(params, "X", resolved);
			const y = resolveParamNumber(params, "Y", resolved);
			const z = resolveParamNumber(params, "Z", resolved);
			const f = resolveParamNumber(params, "F", resolved);
			const zBefore = state.z;
			const named: Array<string> = [];
			if (f !== null) state.feedrate = f;
			if (x !== null) { state.x = applyAxisPosition(state.x, x, state.relativeMoves); named.push("X"); }
			if (y !== null) { state.y = applyAxisPosition(state.y, y, state.relativeMoves); named.push("Y"); }
			if (z !== null) { state.z = applyAxisPosition(state.z, z, state.relativeMoves); named.push("Z"); }
			applyExtraAxisMoves(state, params, resolved);
			forEachExtraAxis(params, resolved, (letter) => { named.push(letter); });
			if (state.probe.triggers === false) {
				if (signalsError) fail(state, away ? PROBE_DID_NOT_LOSE_CONTACT : PROBE_NOT_TRIGGERED);
				break;
			}
			const zDown = !away && zBefore !== null && state.z !== null && state.z < zBefore;
			for (const letter of named) {
				if (letter === "Z" && zDown) state.z = state.probe.triggerHeight ?? DEFAULT_PROBE_TRIGGER_HEIGHT;
				else forgetAxisPosition(state, letter);
			}
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
