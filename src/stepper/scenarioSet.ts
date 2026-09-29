/**
 * Several named scenarios for one file - "cold start" against "already primed", the first-heater-on
 * branch against the second - with exactly one active at a time. `simulation.ts` owns what a single
 * scenario IS ({@link SimulationInputs}); this module is only the collection around it: which one is
 * active, adding/duplicating/renaming/deleting, and the one JSON form a host stores per file.
 *
 * Pure and dependency-free like the rest of the package (persistence is the host's job), and every
 * function returns a NEW set rather than mutating - a host holds the set in a `shallowRef` and swaps
 * it, exactly as it already does with a bare `SimulationInputs`.
 *
 * A file that only ever had ONE scenario (everything saved before this module existed) reads back as
 * a set of one named {@link DEFAULT_SCENARIO_NAME}: {@link scenarioSetFromJSON} accepts the old bare
 * `SimulationInputsJSON` form, so nothing a person entered is lost by upgrading.
 */

import {
	emptySimulationInputs, isEmptySimulationInputs, simulationInputsFromJSON, simulationInputsToJSON,
	type SimulationInputs, type SimulationInputsJSON,
} from "./simulation.js";

export const DEFAULT_SCENARIO_NAME = "Default";
/** Longer names are cut - they label a dropdown, not a document. */
export const MAX_SCENARIO_NAME_LENGTH = 60;

export interface NamedScenario {
	name: string;
	inputs: SimulationInputs;
}

export interface ScenarioSet {
	/** The name of the scenario the walk runs under. Always one of {@link scenarios}. */
	active: string;
	/** In the order a UI lists them; names are unique. Never empty. */
	scenarios: ReadonlyArray<NamedScenario>;
}

/** A set holding just `inputs`, named {@link DEFAULT_SCENARIO_NAME}. */
export function singleScenarioSet(inputs: SimulationInputs = emptySimulationInputs()): ScenarioSet {
	return { active: DEFAULT_SCENARIO_NAME, scenarios: [{ name: DEFAULT_SCENARIO_NAME, inputs }] };
}

export function scenarioNames(set: ScenarioSet): ReadonlyArray<string> {
	return set.scenarios.map((s) => s.name);
}

/** The active scenario's inputs. */
export function activeScenario(set: ScenarioSet): SimulationInputs {
	return (set.scenarios.find((s) => s.name === set.active) ?? set.scenarios[0]!).inputs;
}

/** A name as stored: trimmed and cut to {@link MAX_SCENARIO_NAME_LENGTH}. Empty when nothing is left. */
export function cleanScenarioName(name: string): string {
	return name.trim().slice(0, MAX_SCENARIO_NAME_LENGTH).trim();
}

/** `wanted` (cleaned), or `wanted 2`, `wanted 3`... when a scenario already has that name, ignoring
 *  `except` (the scenario being renamed, whose own current name is not a clash). */
export function uniqueScenarioName(set: ScenarioSet, wanted: string, except?: string): string {
	const base = cleanScenarioName(wanted) || "Scenario";
	const taken = new Set(set.scenarios.map((s) => s.name).filter((n) => n !== except));
	if (!taken.has(base)) return base;
	for (let i = 2; ; i++) {
		const suffix = ` ${i}`;
		const candidate = base.slice(0, MAX_SCENARIO_NAME_LENGTH - suffix.length).trimEnd() + suffix;
		if (!taken.has(candidate)) return candidate;
	}
}

/** `set` with the active scenario's inputs replaced. */
export function updateActiveScenario(set: ScenarioSet, inputs: SimulationInputs): ScenarioSet {
	return { ...set, scenarios: set.scenarios.map((s) => (s.name === set.active ? { ...s, inputs } : s)) };
}

/** `set` with `name` made active - unchanged when there is no such scenario. */
export function selectScenario(set: ScenarioSet, name: string): ScenarioSet {
	return set.scenarios.some((s) => s.name === name) && name !== set.active ? { ...set, active: name } : set;
}

/** `set` plus a new scenario, which becomes the active one. `from` is its starting content: a blank
 *  scenario (the default) or a copy of the active one. The name is made unique. */
export function addScenario(set: ScenarioSet, name: string, from: "empty" | "active" = "empty"): ScenarioSet {
	const unique = uniqueScenarioName(set, name);
	const inputs = from === "active" ? activeScenario(set) : emptySimulationInputs();
	return { active: unique, scenarios: [...set.scenarios, { name: unique, inputs }] };
}

/** `set` plus a copy of the active scenario named `<active> copy`, which becomes the active one. */
export function duplicateScenario(set: ScenarioSet): ScenarioSet {
	return addScenario(set, `${set.active} copy`, "active");
}

/** `set` with `from` renamed to `to` (cleaned). Unchanged when there is no `from`, `to` is empty, or
 *  another scenario already has that name. The active scenario stays active under its new name. */
export function renameScenario(set: ScenarioSet, from: string, to: string): ScenarioSet {
	const name = cleanScenarioName(to);
	if (name === "" || !set.scenarios.some((s) => s.name === from)) return set;
	if (name !== from && set.scenarios.some((s) => s.name === name)) return set;
	return {
		active: set.active === from ? name : set.active,
		scenarios: set.scenarios.map((s) => (s.name === from ? { ...s, name } : s)),
	};
}

/** `set` without `name`. Deleting the active one activates its neighbour; deleting the only one
 *  leaves a single blank {@link DEFAULT_SCENARIO_NAME} - a file always has a scenario. */
export function deleteScenario(set: ScenarioSet, name: string): ScenarioSet {
	const index = set.scenarios.findIndex((s) => s.name === name);
	if (index < 0) return set;
	if (set.scenarios.length === 1) return singleScenarioSet();
	const scenarios = set.scenarios.filter((_, i) => i !== index);
	const active = set.active === name ? scenarios[Math.min(index, scenarios.length - 1)]!.name : set.active;
	return { active, scenarios };
}

/** True when the set holds nothing worth keeping: one scenario, with the default name, that sets
 *  nothing. A host removes its stored copy for such a set instead of writing it. */
export function isEmptyScenarioSet(set: ScenarioSet): boolean {
	return set.scenarios.length === 1 && set.scenarios[0]!.name === DEFAULT_SCENARIO_NAME && isEmptySimulationInputs(set.scenarios[0]!.inputs);
}

// ── persistence shape ──────────────────────────────────────────────────────────────────────────────

export interface ScenarioSetJSON {
	kind: "dwc-gcode-scenario-set";
	schemaVersion: 1;
	active: string;
	scenarios: Array<{ name: string; inputs: SimulationInputsJSON }>;
}

/** A plain-JSON form of `set`, for a host to store however it likes (per file). */
export function scenarioSetToJSON(set: ScenarioSet): ScenarioSetJSON {
	return {
		kind: "dwc-gcode-scenario-set",
		schemaVersion: 1,
		active: set.active,
		scenarios: set.scenarios.map((s) => ({ name: s.name, inputs: simulationInputsToJSON(s.inputs) })),
	};
}

/**
 * Reads a stored set back. Accepts this module's own JSON, and also the bare
 * {@link SimulationInputsJSON} a file had before named scenarios existed (it becomes the set's one
 * {@link DEFAULT_SCENARIO_NAME} scenario). Returns null for anything else - a host falls back to
 * {@link singleScenarioSet} rather than fail on a value that could have been hand-edited. Individual
 * bad entries are dropped, clashing names are made unique, and an `active` that names nothing falls
 * back to the first scenario.
 */
export function scenarioSetFromJSON(value: unknown): ScenarioSet | null {
	if (typeof value !== "object" || value === null) return null;
	const o = value as Record<string, unknown>;
	if (o.kind === "dwc-gcode-simulation-inputs") {
		const inputs = simulationInputsFromJSON(value);
		return inputs === null ? null : singleScenarioSet(inputs);
	}
	if (o.kind !== "dwc-gcode-scenario-set" || o.schemaVersion !== 1 || !Array.isArray(o.scenarios)) return null;

	let set: ScenarioSet = { active: "", scenarios: [] };
	for (const entry of o.scenarios) {
		if (typeof entry !== "object" || entry === null) continue;
		const e = entry as Record<string, unknown>;
		const inputs = simulationInputsFromJSON(e.inputs);
		if (typeof e.name !== "string" || inputs === null) continue;
		const name = uniqueScenarioName(set, e.name);
		set = { active: "", scenarios: [...set.scenarios, { name, inputs }] };
	}
	if (set.scenarios.length === 0) return null;
	const wanted = typeof o.active === "string" ? cleanScenarioName(o.active) : "";
	return { active: set.scenarios.some((s) => s.name === wanted) ? wanted : set.scenarios[0]!.name, scenarios: set.scenarios };
}
