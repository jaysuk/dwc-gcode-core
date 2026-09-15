/**
 * RepRapFirmware's tool-temperature commands, and what a `G10` line actually is.
 *
 * One reader for all of it, because separate readers drift. In duet-gcode-postprocessor, before this
 * existed, travel detection called any `G10` without a `P` a retraction, tool renumbering left every
 * `G10` alone as ambiguous, and predictive pre-heat counted a `G10 L2`/`L20` workplace offset
 * carrying an `S` or `R` as a tool's temperature setup.
 *
 * - **`M568 P<tool> S<active> R<standby> A<state>`** (RRF 3.3+) — `Duet3D/wiki-content`'s own words:
 *   "Temperatures set with M568 do not wait for the heaters to reach temp before proceeding. In
 *   order to wait for the temp use a M116 command after the M568". `A` is the heater state: 0 off,
 *   1 standby, 2 active.
 * - **`G10 P<tool> S<active> R<standby>`** — the older form M568 replaces; the wiki says the same
 *   about waiting.
 *
 * Checked against RRF 3.7.0-rc.1 (`RRF_BASELINE`): `src/GCodes/GCodes2.cpp` `case 568` and `case 10`
 * both call `src/GCodes/GCodes.cpp` `SetOrReportOffsets`, which reads `S` and `R` with
 * `GetFloatArray` — a colon list, one value per heater of the tool, so `S185:200:150` sets three
 * heaters — reads `A` with `TryGetLimitedUIValue(…, 3)`, so 0–2, and waits for nothing. `P` is
 * optional; without it the current tool is meant, and the command fails when no tool is selected
 * (`GetSpecifiedOrCurrentTool`).
 *
 * How many values a list may hold (`GCodeBuffer::GetFloatArray` with `doPad` true): a single value
 * is copied to every heater of the tool; fewer values than heaters set only the first ones; more
 * values than heaters are an error. A tool with no heaters ignores `S` and `R` entirely. This module
 * reports the values as written — it cannot know the tool's heater count from a file.
 */

import { commandSpec } from "../dictionary/commands.js";
import { findParam, paramNumber, paramNumberList, parseParams, type ParsedParam } from "../params.js";

/**
 * Which of `G10`'s three meanings a line has, by RepRapFirmware's own dispatch (RRF 3.7.0-rc.1
 * `src/GCodes/GCodes2.cpp`, `case 10`). The wiki's per-form summaries are narrower (temperatures: "a
 * P combined with at least an R or S"), but its note on command queueing states the firmware's rule
 * exactly — a `G10` with no `L` and "at least one P, R, S or axis letter parameter" is tool settings.
 * In full:
 *
 * - **With an `L` parameter:** `L1` is tool settings, the same as no `L`; `L2`/`L20` set a workplace
 *   coordinate system's origin, and there `P` is a coordinate system number, **not** a tool; any
 *   other `L` is rejected by the firmware and does nothing.
 * - **With no `L`:** *any* of `P`, `R`, `S` or an axis letter makes it tool settings — temperatures
 *   (`S`/`R`) and/or tool offsets (axis letters), for tool `P` or the current tool. So `G10 S200` is
 *   the current tool's active temperature, not a retraction, even though it has no `P`.
 * - **Otherwise** — nothing that marks it as tool settings — it is RRF's firmware retraction.
 */
export type G10Form = "retract" | "toolSettings" | "workplace" | "unrecognised";

/**
 * The axis letters RRF checks for (`axisLetters[0..numVisibleAxes)`): X, Y, Z and the extra-axis
 * letters `M584` accepts, `UVWABCD` (the wiki's M584 entry). RRF checks only the machine's
 * *configured* axes, which a file on its own cannot know — so each of these counts whether or not
 * this machine has it, and a `G10` that might be a tool offset is not taken for a retraction.
 *
 * Not covered: lowercase axes, which G-code must write with a leading quote (`'A10` means axis `a`,
 * the wiki's M584 notes). At RRF 3.7.0-rc.1 they are `a`–`f`, or `a`–`z` on `DUET3` builds
 * (`src/GCodes/GCodes.h`, `AllowedAxisLetters`). `parseParams` stops at the quote, so a `G10` whose
 * only offset is on a lowercase axis reads as a retraction here — a known gap, and not something a
 * slicer emits.
 */
export const AXIS_LETTERS: ReadonlyArray<string> = ["X", "Y", "Z", "U", "V", "W", "A", "B", "C", "D"];

/**
 * The non-`L` letters that mark a `G10` with no `L` as tool settings — read from the dictionary's
 * own reviewed `G10` entry (`dictionary/commands.json`) rather than duplicated here, so a future
 * correction to that entry's parameter list (itself cited to RRF source) doesn't silently drift out
 * of step with this dispatch rule. Falls back to the literal `["P", "R", "S"]` RRF source names
 * (`GCodes.cpp`, `SetOrReportOffsets`) only if the dictionary is ever unavailable at this letter, so
 * this module never throws for want of it.
 */
const TOOL_SETTING_LETTERS: ReadonlyArray<string> =
	commandSpec("G10")
		?.parameters.map((p) => p.letter)
		.filter((letter) => letter !== "L") ?? ["P", "R", "S"];

function g10FormOf(params: ReadonlyArray<ParsedParam>): G10Form {
	if (findParam(params, "L") !== null) {
		const l = paramNumber(params, "L");
		if (l === 1) return "toolSettings";
		if (l === 2 || l === 20) return "workplace";
		return "unrecognised";
	}
	for (const letter of [...TOOL_SETTING_LETTERS, ...AXIS_LETTERS]) {
		if (findParam(params, letter) !== null) return "toolSettings";
	}
	return "retract";
}

/** Which of `G10`'s three meanings this `G10` line's body has — see `G10Form`. */
export function g10Form(body: string): G10Form {
	return g10FormOf(parseParams(body));
}

export interface ToolTemperatureSetting {
	/** Tool number from `P`, or null when the command addresses the current tool. */
	tool: number | null;
	/** `S` — active temperature per heater, in heater order. Empty when `S` is absent, and a
	 *  non-numeric element (an expression) is dropped — there is no number to read. */
	active: Array<number>;
	/** `R` — standby temperature per heater, in heater order. Same rules as `active`. */
	standby: Array<number>;
	/**
	 * True when `S` or `R` is present at all, whatever its value. This differs from the lists being
	 * non-empty only when a value is not a plain number: RRF 3.01+ accepts an expression in braces
	 * anywhere a number goes (the wiki's G-code dictionary: "instead of a number you may use an
	 * expression enclosed in braces"), e.g. `S{global.printTemp}`. The lists drop it — there is no
	 * number to read — but it still sets the tool's temperatures. A caller asking "are this tool's
	 * temperatures established here?" (predictive pre-heat) needs this; a caller that needs the
	 * numbers themselves (a max-temperature check, print recovery) uses the lists.
	 */
	setsTemperatures: boolean;
	/** `M568`'s `A`: 0 off, 1 standby, 2 active. Null when absent — and always null for `G10`,
	 *  which has no heater-state parameter. */
	heaterState: number | null;
}

/**
 * The tool-temperature content of one command, or null when the line is not a tool-temperature
 * command at all — anything other than `M568`/`G10`, a `G10` that is not tool settings (a
 * retraction, a workplace offset), or a tool-settings `G10` that sets only offsets. `M568` is always
 * read, even with no temperatures, because its `A` alone changes heater state.
 */
export function readToolTemperatureSetting(code: string | null, body: string): ToolTemperatureSetting | null {
	if (code !== "M568" && code !== "G10") return null;
	const params = parseParams(body);
	const setsTemperatures = findParam(params, "S") !== null || findParam(params, "R") !== null;
	if (code === "G10") {
		if (g10FormOf(params) !== "toolSettings") return null;
		if (!setsTemperatures) return null;
	}
	const p = paramNumber(params, "P");
	return {
		tool: p !== null && p >= 0 ? Math.trunc(p) : null,
		active: paramNumberList(params, "S"),
		standby: paramNumberList(params, "R"),
		setsTemperatures,
		heaterState: code === "M568" ? paramNumber(params, "A") : null,
	};
}
