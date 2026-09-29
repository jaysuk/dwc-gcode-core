import { describe, expect, it } from "vitest";

import {
	DEFAULT_SCENARIO_NAME, MAX_SCENARIO_NAME_LENGTH, activeScenario, addScenario, deleteScenario, duplicateScenario,
	isEmptyScenarioSet, renameScenario, scenarioNames, scenarioSetFromJSON, scenarioSetToJSON, selectScenario,
	singleScenarioSet, uniqueScenarioName, updateActiveScenario,
} from "../src/stepper/scenarioSet.js";
import { emptySimulationInputs, simulationInputsToJSON, withStartAxis, withStartLine, type SimulationInputs } from "../src/stepper/simulation.js";

const withX = (x: number): SimulationInputs => withStartAxis(emptySimulationInputs(), "X", x);

describe("a set of scenarios", () => {
	it("starts as one blank scenario named Default, and that counts as empty", () => {
		const set = singleScenarioSet();
		expect(scenarioNames(set)).toEqual([DEFAULT_SCENARIO_NAME]);
		expect(set.active).toBe(DEFAULT_SCENARIO_NAME);
		expect(isEmptyScenarioSet(set)).toBe(true);
	});

	it("editing changes only the active scenario", () => {
		let set = addScenario(singleScenarioSet(withX(1)), "Primed");
		set = updateActiveScenario(set, withX(99));
		expect(activeScenario(set).start.axes).toEqual({ X: 99 });
		expect(selectScenario(set, DEFAULT_SCENARIO_NAME).scenarios[0]!.inputs.start.axes).toEqual({ X: 1 });
		expect(isEmptyScenarioSet(set)).toBe(false);
	});

	it("a new scenario is blank and becomes active; 'active' copies the current one instead", () => {
		const base = singleScenarioSet(withX(5));
		const blank = addScenario(base, "Blank");
		expect(blank.active).toBe("Blank");
		expect(activeScenario(blank).start.axes).toBeUndefined();
		const copy = addScenario(base, "Copy", "active");
		expect(activeScenario(copy).start.axes).toEqual({ X: 5 });
	});

	it("names are cleaned and kept unique", () => {
		let set = singleScenarioSet();
		set = addScenario(set, "  Cold  ");
		set = addScenario(set, "Cold");
		set = addScenario(set, "Cold");
		expect(scenarioNames(set)).toEqual(["Default", "Cold", "Cold 2", "Cold 3"]);
		expect(uniqueScenarioName(set, "")).toBe("Scenario");
		expect(uniqueScenarioName(set, "x".repeat(200)).length).toBe(MAX_SCENARIO_NAME_LENGTH);
	});

	it("a long name that clashes still fits inside the length limit", () => {
		const long = "y".repeat(MAX_SCENARIO_NAME_LENGTH);
		const set = addScenario(addScenario(singleScenarioSet(), long), long);
		expect(scenarioNames(set)[2]!.length).toBeLessThanOrEqual(MAX_SCENARIO_NAME_LENGTH);
		expect(new Set(scenarioNames(set)).size).toBe(3);
	});

	it("duplicating copies the active scenario under '<name> copy' and switches to it", () => {
		const set = duplicateScenario(singleScenarioSet(withX(7)));
		expect(scenarioNames(set)).toEqual(["Default", "Default copy"]);
		expect(set.active).toBe("Default copy");
		expect(activeScenario(set).start.axes).toEqual({ X: 7 });
	});

	it("selecting an unknown name changes nothing", () => {
		const set = singleScenarioSet();
		expect(selectScenario(set, "Nope")).toBe(set);
	});

	describe("renaming", () => {
		it("keeps the renamed scenario active when it was", () => {
			const set = renameScenario(addScenario(singleScenarioSet(), "A"), "A", "B");
			expect(scenarioNames(set)).toEqual(["Default", "B"]);
			expect(set.active).toBe("B");
		});

		it("refuses an empty name, a missing scenario and a name another scenario already has", () => {
			const set = addScenario(singleScenarioSet(), "A");
			expect(renameScenario(set, "A", "   ")).toBe(set);
			expect(renameScenario(set, "Ghost", "Z")).toBe(set);
			expect(renameScenario(set, "A", "Default")).toBe(set);
		});

		it("allows re-cleaning its own name", () => {
			const set = addScenario(singleScenarioSet(), "A");
			expect(scenarioNames(renameScenario(set, "A", "  A "))).toEqual(["Default", "A"]);
		});
	});

	describe("deleting", () => {
		it("activates the neighbour when the active one goes", () => {
			let set = addScenario(addScenario(singleScenarioSet(), "B"), "C"); // active C, last
			set = deleteScenario(set, "C");
			expect(set.active).toBe("B");
			set = selectScenario(set, "Default");
			set = deleteScenario(set, "Default");
			expect(set.active).toBe("B");
			expect(scenarioNames(set)).toEqual(["B"]);
		});

		it("leaves the active one alone when another is deleted", () => {
			const set = deleteScenario(addScenario(singleScenarioSet(), "B"), "Default");
			expect(set.active).toBe("B");
		});

		it("deleting the only scenario leaves a blank Default, never an empty set", () => {
			const set = deleteScenario(singleScenarioSet(withX(3)), DEFAULT_SCENARIO_NAME);
			expect(scenarioNames(set)).toEqual([DEFAULT_SCENARIO_NAME]);
			expect(isEmptyScenarioSet(set)).toBe(true);
		});

		it("an unknown name is a no-op", () => {
			const set = singleScenarioSet();
			expect(deleteScenario(set, "Ghost")).toBe(set);
		});
	});
});

describe("saving a set", () => {
	it("round-trips every scenario, its inputs and which is active", () => {
		let set = singleScenarioSet(withStartLine(withX(1), 4));
		set = addScenario(set, "Primed");
		set = updateActiveScenario(set, withX(2));
		const back = scenarioSetFromJSON(JSON.parse(JSON.stringify(scenarioSetToJSON(set))));
		expect(back?.active).toBe("Primed");
		expect(scenarioNames(back!)).toEqual(["Default", "Primed"]);
		expect(back!.scenarios[0]!.inputs.startLine).toBe(4);
		expect(activeScenario(back!).start.axes).toEqual({ X: 2 });
	});

	it("reads a file's old single scenario as the Default of a new set - nothing is lost by upgrading", () => {
		const old = simulationInputsToJSON(withX(42));
		const back = scenarioSetFromJSON(old);
		expect(scenarioNames(back!)).toEqual([DEFAULT_SCENARIO_NAME]);
		expect(activeScenario(back!).start.axes).toEqual({ X: 42 });
	});

	it("returns null for anything that isn't ours", () => {
		for (const bad of [null, 5, "x", [], {}, { kind: "dwc-gcode-scenario-set", schemaVersion: 2, scenarios: [] }, { kind: "dwc-gcode-scenario-set", schemaVersion: 1, scenarios: [] }]) {
			expect(scenarioSetFromJSON(bad)).toBeNull();
		}
	});

	it("drops bad entries, uniquifies clashing names and falls back when 'active' names nothing", () => {
		const good = simulationInputsToJSON(withX(1));
		const back = scenarioSetFromJSON({
			kind: "dwc-gcode-scenario-set", schemaVersion: 1, active: "Ghost",
			scenarios: [{ name: "A", inputs: good }, { name: 7, inputs: good }, { name: "B", inputs: "junk" }, null, { name: "A", inputs: good }],
		});
		expect(scenarioNames(back!)).toEqual(["A", "A 2"]);
		expect(back!.active).toBe("A");
	});

	it("keeps an 'active' that names a real scenario", () => {
		const good = simulationInputsToJSON(emptySimulationInputs());
		const back = scenarioSetFromJSON({ kind: "dwc-gcode-scenario-set", schemaVersion: 1, active: "B", scenarios: [{ name: "A", inputs: good }, { name: "B", inputs: good }] });
		expect(back!.active).toBe("B");
	});

	it("a lone blank scenario with a custom name is NOT empty - the name is worth keeping", () => {
		expect(isEmptyScenarioSet(renameScenario(singleScenarioSet(), "Default", "Mine"))).toBe(false);
	});
});
