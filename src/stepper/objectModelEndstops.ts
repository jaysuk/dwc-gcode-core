/**
 * The `G1 H1` endstop model, read from a machine's object model instead of typed in.
 *
 * What a homing move needs - which end each axis's endstop is at, and the axis limits it lands on - is
 * machine configuration (`M574`, `M208`) that the file being stepped does not carry, but the machine the
 * host is connected to reports it:
 *
 * - `move.axes[i].letter`, `.min`, `.max` - the axis and its `M208` limits;
 * - `sensors.endstops[i]` - the endstop of axis `i`: `highEnd` says which end it is at (`M574`), and the
 *   entry is `null` when the axis has none (`M574 ... S0`).
 *
 * Both arrays are indexed by axis number (RRF `Endstops/EndstopsManager.cpp`: the array reports
 * `GetTotalAxes()` entries, each `FindEndstopWhenLockOwned(index)`, which is a null pointer for an axis
 * with no endstop; `Endstops/Endstop.cpp` puts `highEnd` from `GetAtHighEnd()` in the model). So the two
 * are matched by position, and the letter comes from `move.axes`.
 *
 * Pure and dependency-free like the rest of this package: it takes the model as `unknown` (a host passes
 * its own live object, which may be a class instance, a reactive proxy or plain JSON) and reads it
 * defensively, since a disconnected or older machine's model can lack any of these.
 */

import { sanitiseEndstops, type EndstopModel } from "./machineState.js";

type Record_ = Readonly<Record<string, unknown>>;

const isRecord = (v: unknown): v is Record_ => typeof v === "object" && v !== null && !Array.isArray(v);
const isFiniteNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/**
 * The endstop model a machine's object model describes, per axis letter. An axis contributes only what
 * the model actually says: `min`/`max` when they are numbers, `end` when `sensors.endstops` has an entry
 * for it (`"high"`/`"low"` from `highEnd`, `"none"` for a `null` entry). Nothing at all - no `move.axes`,
 * no `sensors.endstops`, an empty model - gives `{}`, which leaves the simulator on its own defaults.
 *
 * `triggers` is never set: whether an endstop fires is a what-if for a scenario, not machine
 * configuration.
 */
export function endstopsFromObjectModel(model: unknown): Readonly<Record<string, EndstopModel>> {
	if (!isRecord(model)) return {};
	const move = model.move;
	const axes = isRecord(move) ? move.axes : undefined;
	if (!Array.isArray(axes)) return {};
	const sensors = model.sensors;
	const endstops = isRecord(sensors) ? sensors.endstops : undefined;

	const raw: Record<string, Record<string, unknown>> = {};
	axes.forEach((axis: unknown, index: number) => {
		if (!isRecord(axis) || typeof axis.letter !== "string") return;
		// `sanitiseEndstops` upper-cases a letter, so a lowercase axis (RRF allows `a`-`z` too) would
		// otherwise overwrite the uppercase one of the same name; only the letters the simulator models.
		const letter = axis.letter;
		if (letter === "" || letter !== letter.toUpperCase()) return;
		const entry: Record<string, unknown> = {};
		if (isFiniteNumber(axis.min)) entry.min = axis.min;
		if (isFiniteNumber(axis.max)) entry.max = axis.max;
		if (Array.isArray(endstops) && index < endstops.length) {
			const endstop: unknown = endstops[index];
			if (endstop === null) entry.end = "none";
			else if (isRecord(endstop) && typeof endstop.highEnd === "boolean") entry.end = endstop.highEnd ? "high" : "low";
		}
		raw[letter] = entry;
	});
	return sanitiseEndstops(raw);
}

/**
 * `machine` (from {@link endstopsFromObjectModel}) with a scenario's own endstop settings laid over it,
 * field by field: a scenario that only sets `X`'s `max` keeps the machine's `end` and `min` for `X`. An
 * axis only one side mentions comes through unchanged.
 */
export function mergeEndstops(
	machine: Readonly<Record<string, EndstopModel>> | undefined,
	scenario: Readonly<Record<string, EndstopModel>> | undefined,
): Readonly<Record<string, EndstopModel>> {
	const out: Record<string, EndstopModel> = {};
	for (const source of [machine, scenario]) {
		if (source === undefined) continue;
		// Sanitised so an explicit `undefined` field can never blank out what the other side set.
		for (const [letter, model] of Object.entries(sanitiseEndstops(source))) out[letter] = { ...out[letter], ...model };
	}
	return out;
}
