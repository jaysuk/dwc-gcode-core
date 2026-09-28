/**
 * An offline stepper has no live machine, so an `if`/`while` condition referencing an object-model
 * path (`sensors.gpIn[0].value`, `heat.heaters[0].current`, `move.axes[0].homed`, ...) genuinely has
 * no known value - not just the hardware-dependent ones, ALL of them, since this is a static file
 * being read, not a connected board. `walkExecution` (`../execute.js`) pauses at exactly that point
 * via `UnresolvedPathError`; this module is the caller-facing side of resolving it: a map of path ->
 * hypothetical value a caller has supplied, and the `resolvePath` callback `executionIndex.ts` wires
 * to `walkExecution`, backed by that map.
 *
 * Extracted from `duet-gcode-postprocessor`'s own `model/gcode/simulatedValues.ts` (task: shared
 * stepper) — only the pure resolver logic moved here; that module's own `localStorage`-backed
 * persistence stays host-side (this package takes zero runtime dependencies, `localStorage` included),
 * each host free to persist the resulting `SimulatedValueOverrides` however it already does.
 */

import { UnresolvedPathError, type EvalValue } from "../expr/evaluate.js";

export type SimulatedValueOverrides = ReadonlyMap<string, EvalValue>;

/** Builds a `walkExecution`-compatible `resolvePath`: answers from `overrides` when the exact
 *  (already-indexed, e.g. `"sensors.gpIn[0].value"`) path has one, otherwise throws
 *  `UnresolvedPathError` so the walk pauses there and the caller can prompt for a value. */
export function createSimulatedResolvePath(overrides: SimulatedValueOverrides): (path: string) => EvalValue {
	return (path) => {
		const value = overrides.get(path);
		if (value !== undefined || overrides.has(path)) return value as EvalValue;
		throw new UnresolvedPathError(path);
	};
}

/**
 * Parses what a user typed into the "what value should the simulation use?" prompt: `true`/`false`
 * (case-insensitive) become a boolean, a valid finite number becomes a number, anything else is kept
 * as the literal string - ordinary "type what you mean" input, not a separate type selector, since
 * the vast majority of conditions this pauses on are numeric sensor readings or boolean pin states.
 */
export function parseSimulatedValueInput(text: string): EvalValue {
	const trimmed = text.trim();
	if (/^true$/i.test(trimmed)) return true;
	if (/^false$/i.test(trimmed)) return false;
	if (/^null$/i.test(trimmed)) return null;
	if (trimmed !== "" && Number.isFinite(Number(trimmed))) return Number(trimmed);
	// An array (`[1, 2, 3]`, `["a", "b"]`) or a quoted string (`"12"`, to give the STRING twelve rather
	// than the number): both are valid JSON, so let JSON say. Anything that doesn't parse as one of
	// those stays the literal text - typing `[oops` gets you the string, not an error.
	if (trimmed.startsWith("[") || (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"'))) {
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (isJsonEvalValue(parsed)) return parsed;
		} catch {
			// fall through to the literal
		}
	}
	return trimmed;
}

function isJsonEvalValue(v: unknown): v is EvalValue {
	if (v === null || typeof v === "string" || typeof v === "boolean") return true;
	if (typeof v === "number") return Number.isFinite(v);
	return Array.isArray(v) && v.every(isJsonEvalValue);
}
