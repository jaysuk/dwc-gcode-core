/**
 * The offline stepper as a SCENARIO: everything a person can set up before pressing "step" to test
 * how a macro or system file reacts, plus the pure helpers a UI needs to show what each step did.
 *
 * `executionIndex.ts` already walks a file; what it takes are separate callbacks and options a host
 * has to assemble. This module is the one serialisable value a host stores per file
 * ({@link SimulationInputs}) and the one call that turns it into a run ({@link runSimulation}):
 *
 * - where the machine STARTS - axis positions (X/Y/Z and any other axis), which are homed, the tool,
 *   relative modes - so a macro that moves relative to "wherever the head is" has somewhere to be;
 * - object-model values - `sensors.gpIn[0].value`, `heat.heaters[1].current`, ... - and `param.*`
 *   (the arguments a calling `M98` would have passed), so a condition can be tested down both arms;
 * - `global` variables that already exist (declared by `config.g` or an earlier macro, which a
 *   single-file walk cannot see) and `var`s for a fragment;
 * - answers to blocking `M291` message boxes.
 *
 * It also holds the "what did this step do" helpers: the line rendered as evaluated
 * ({@link renderEvaluatedLine}), per-axis position/delta readouts ({@link axisReadouts}), variable
 * changes between steps ({@link variableChanges}), and discovery of which inputs a file actually
 * references ({@link findReferencedInputs}) so a UI can offer them before the run rather than pausing
 * to ask one at a time.
 *
 * Pure and dependency-free like the rest of this package: persistence (where a host keeps the JSON
 * form) is the host's job.
 */

import { expressionsOfLine, parseDocument } from "../document.js";
import type { EvalValue } from "../expr/evaluate.js";
import type { ExprNode } from "../expr/parse.js";
import type { LineEvaluation, MessageBoxAnswer, StepVariables } from "../execute.js";
import { parseAssignment } from "../meta.js";
import { objectModelPath } from "../objectmodel/schema.js";
import { buildExecutionIndex, type ExecutionIndex } from "./executionIndex.js";
import { axisHomed, axisPosition, createState, type InitialMachineState, type MachineState } from "./machineState.js";
import { createMessageBoxResolver, type MessageBoxAnswerOverrides } from "./messageBoxAnswers.js";
import { createSimulatedResolvePath } from "./simulatedValues.js";

// ── the scenario ───────────────────────────────────────────────────────────────────────────────────

export interface SimulationInputs {
	/** Where the machine starts - see `InitialMachineState`. */
	start: InitialMachineState;
	/** Object-model paths (`"sensors.gpIn[0].value"`) and macro arguments (`"param.S"`) to their
	 *  values. A path with no entry pauses the walk when something reads it, the way it always has. */
	paths: ReadonlyMap<string, EvalValue>;
	/** `global` variables that already exist when the file starts, by bare name (`"myFlag"`). */
	globals: ReadonlyMap<string, EvalValue>;
	/** `var` variables already in scope when the file starts, by bare name. */
	vars: ReadonlyMap<string, EvalValue>;
	messageBoxAnswers: MessageBoxAnswerOverrides;
}

export function emptySimulationInputs(): SimulationInputs {
	return { start: {}, paths: new Map(), globals: new Map(), vars: new Map(), messageBoxAnswers: new Map() };
}

export interface RunSimulationOptions {
	/** Check every referenced object-model path against the schema for this exact RRF version - see
	 *  `buildExecutionIndex`. Only pass a version `OBJECT_MODEL_VERSIONS` tracks. */
	objectModelVersion?: string;
}

/** Walks `text` under `inputs`, recording each step's evaluated expressions and variables. */
export function runSimulation(text: string, inputs: SimulationInputs, options: RunSimulationOptions = {}): ExecutionIndex {
	return buildExecutionIndex(
		text,
		createSimulatedResolvePath(inputs.paths),
		createMessageBoxResolver(inputs.messageBoxAnswers),
		{
			objectModelVersion: options.objectModelVersion,
			initialState: inputs.start,
			initialGlobals: inputs.globals,
			initialVars: inputs.vars,
			recordEvaluation: true,
		},
	);
}

// ── persistence shape ──────────────────────────────────────────────────────────────────────────────

export interface SimulationInputsJSON {
	kind: "dwc-gcode-simulation-inputs";
	schemaVersion: 1;
	start: InitialMachineState;
	paths: Record<string, EvalValue>;
	globals: Record<string, EvalValue>;
	vars: Record<string, EvalValue>;
	messageBoxAnswers: Record<string, MessageBoxAnswer>;
}

function mapToRecord<V>(map: ReadonlyMap<string, V>): Record<string, V> {
	const out: Record<string, V> = {};
	for (const [k, v] of map) out[k] = v;
	return out;
}

/** A plain-JSON form of `inputs`, for a host to store however it likes (per file, per scenario). */
export function simulationInputsToJSON(inputs: SimulationInputs): SimulationInputsJSON {
	return {
		kind: "dwc-gcode-simulation-inputs",
		schemaVersion: 1,
		start: inputs.start,
		paths: mapToRecord(inputs.paths),
		globals: mapToRecord(inputs.globals),
		vars: mapToRecord(inputs.vars),
		messageBoxAnswers: mapToRecord(inputs.messageBoxAnswers),
	};
}

/** True for exactly the values an expression can hold: numbers, strings, booleans, null and arrays of
 *  those. Anything else (an object, undefined, NaN) is not something the evaluator can compute with. */
export function isEvalValue(v: unknown): v is EvalValue {
	if (v === null || typeof v === "string" || typeof v === "boolean") return true;
	if (typeof v === "number") return Number.isFinite(v);
	return Array.isArray(v) && v.every(isEvalValue);
}

function recordOfValues(v: unknown): Map<string, EvalValue> {
	const out = new Map<string, EvalValue>();
	if (typeof v !== "object" || v === null || Array.isArray(v)) return out;
	for (const [k, val] of Object.entries(v)) if (isEvalValue(val)) out.set(k, val);
	return out;
}

function stringList(v: unknown): Array<string> | undefined {
	return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

function sanitiseStart(v: unknown): InitialMachineState {
	if (typeof v !== "object" || v === null || Array.isArray(v)) return {};
	const o = v as Record<string, unknown>;
	const start: InitialMachineState = {};
	if (typeof o.axes === "object" && o.axes !== null && !Array.isArray(o.axes)) {
		const axes: Record<string, number> = {};
		for (const [k, val] of Object.entries(o.axes)) if (typeof val === "number" && Number.isFinite(val)) axes[k] = val;
		start.axes = axes;
	}
	const axisLetters = stringList(o.axisLetters);
	if (axisLetters !== undefined) start.axisLetters = axisLetters;
	const homed = stringList(o.homed);
	if (homed !== undefined) start.homed = homed;
	for (const key of ["e", "tool", "feedrate"] as const) {
		const val = o[key];
		if (typeof val === "number" && Number.isFinite(val)) start[key] = val;
	}
	for (const key of ["relativeMoves", "relativeE"] as const) {
		if (typeof o[key] === "boolean") start[key] = o[key];
	}
	return start;
}

/** Reads a stored scenario back. Returns null for anything that isn't recognisably this module's own
 *  output - a host falls back to {@link emptySimulationInputs} rather than fail on a file that could
 *  have been hand-edited or written by a different version. Individual bad entries are dropped, not
 *  fatal. */
export function simulationInputsFromJSON(value: unknown): SimulationInputs | null {
	if (typeof value !== "object" || value === null) return null;
	const o = value as Record<string, unknown>;
	if (o.kind !== "dwc-gcode-simulation-inputs" || o.schemaVersion !== 1) return null;
	const answers = new Map<string, MessageBoxAnswer>();
	if (typeof o.messageBoxAnswers === "object" && o.messageBoxAnswers !== null) {
		for (const [k, a] of Object.entries(o.messageBoxAnswers)) {
			if (typeof a === "object" && a !== null && isEvalValue((a as MessageBoxAnswer).input) && typeof (a as MessageBoxAnswer).cancelled === "boolean") {
				answers.set(k, { input: (a as MessageBoxAnswer).input, cancelled: (a as MessageBoxAnswer).cancelled });
			}
		}
	}
	return {
		start: sanitiseStart(o.start),
		paths: recordOfValues(o.paths),
		globals: recordOfValues(o.globals),
		vars: recordOfValues(o.vars),
		messageBoxAnswers: answers,
	};
}

// ── formatting ─────────────────────────────────────────────────────────────────────────────────────

/** A number as a person reads it: floating-point noise from arithmetic (`0.1 + 0.2`) trimmed to 12
 *  significant digits, so `0.30000000000000004` shows as `0.3`. */
export function formatDisplayNumber(n: number): string {
	if (!Number.isFinite(n) || Number.isInteger(n)) return String(n);
	return String(parseFloat(n.toPrecision(12)));
}

/** A value as it reads in the simulator's own UI: strings quoted, arrays bracketed. */
export function formatEvalValue(v: EvalValue): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return `[${v.map(formatEvalValue).join(", ")}]`;
	if (typeof v === "string") return `"${v.replace(/"/g, '""')}"`;
	if (typeof v === "number") return formatDisplayNumber(v);
	return String(v);
}

/** A value as it would appear written into a G-code parameter: strings quoted the way RRF quotes
 *  them (a doubled `""`), and an array as the colon-separated list RRF reads for a per-heater or
 *  per-axis parameter (`{[200, 210]}` is `200:210`). */
export function formatParamValue(v: EvalValue): string {
	if (Array.isArray(v)) return v.map(formatParamValue).join(":");
	if (typeof v === "string") return `"${v.replace(/"/g, '""')}"`;
	if (v === null) return "null";
	if (typeof v === "number") return formatDisplayNumber(v);
	return String(v);
}

// ── the line as evaluated ──────────────────────────────────────────────────────────────────────────

export interface EvaluatedLineSegment {
	text: string;
	/** `"source"`: text exactly as written. `"value"`: an expression replaced by what it evaluated to.
	 *  `"result"`: appended after the line - a condition's outcome, an assignment, an `echo`'s text. */
	kind: "source" | "value" | "result";
}

export interface EvaluatedLine {
	/** The segments joined. */
	text: string;
	segments: ReadonlyArray<EvaluatedLineSegment>;
	/** False when the line had nothing to evaluate (the segments are just the raw line). */
	changed: boolean;
}

/**
 * The line as evaluated, for showing beside the source line while stepping: each `{...}` parameter
 * is replaced by its value (`G1 X{var.x + 10}` -> `G1 X110`), and a meta line gets its outcome
 * appended (`if var.x > 5` -> `if var.x > 5 -> true`, `set var.n = var.n + 1` -> `... -> var.n = 4`,
 * `echo "n is " ^ var.n` -> `... -> "n is 4"`).
 */
export function renderEvaluatedLine(raw: string, evaluation: LineEvaluation | undefined): EvaluatedLine {
	if (evaluation === undefined) return { text: raw, segments: [{ text: raw, kind: "source" }], changed: false };

	const substitutions = evaluation.expressions
		.filter((e) => e.kind === "param" || e.kind === "stringArgument")
		.slice()
		.sort((a, b) => a.start - b.start);
	const segments: Array<EvaluatedLineSegment> = [];
	let cursor = 0;
	for (const sub of substitutions) {
		if (sub.start < cursor || sub.end > raw.length) continue; // overlapping/out-of-range span: leave the source alone
		if (sub.start > cursor) segments.push({ text: raw.slice(cursor, sub.start), kind: "source" });
		segments.push({ text: formatParamValue(sub.value), kind: "value" });
		cursor = sub.end;
	}
	if (cursor < raw.length) segments.push({ text: raw.slice(cursor), kind: "source" });

	const meta = evaluation.expressions.find((e) => e.kind === "meta");
	let result: string | undefined;
	if (evaluation.assignment !== undefined) {
		const a = evaluation.assignment;
		result = `${a.scope === "global" ? "global" : "var"}.${a.name} = ${formatEvalValue(a.value)}`;
	} else if (evaluation.condition !== undefined) {
		result = String(evaluation.condition);
	} else if (meta !== undefined) {
		result = formatEvalValue(meta.value);
	}
	if (result !== undefined) segments.push({ text: ` → ${result}`, kind: "result" });

	return {
		text: segments.map((s) => s.text).join(""),
		segments,
		changed: substitutions.length > 0 || result !== undefined,
	};
}

// ── coordinates ────────────────────────────────────────────────────────────────────────────────────

export interface AxisReadout {
	letter: string;
	position: number | null;
	previous: number | null;
	/** `position - previous`, when both are known. */
	delta: number | null;
	/** Whether the position differs from `previous` (an axis appearing for the first time counts). */
	changed: boolean;
	homed: boolean;
}

/** One readout per axis this walk knows, in `move.axes[]` order, against the previous step's state
 *  (null for the first step). */
export function axisReadouts(state: MachineState, previous: MachineState | null): ReadonlyArray<AxisReadout> {
	return state.axisLetters.map((letter) => {
		const position = axisPosition(state, letter);
		const before = previous === null ? null : axisPosition(previous, letter);
		return {
			letter,
			position,
			previous: before,
			delta: position !== null && before !== null ? position - before : null,
			changed: position !== before,
			homed: axisHomed(state, letter),
		};
	});
}

// ── variables ──────────────────────────────────────────────────────────────────────────────────────

export interface VariableChange {
	scope: "var" | "global";
	name: string;
	value: EvalValue | undefined;
	previous: EvalValue | undefined;
	change: "added" | "changed" | "removed";
}

function sameValue(a: EvalValue | undefined, b: EvalValue | undefined): boolean {
	if (a === b) return true;
	if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
	return false;
}

/** What differs between the variables after the previous step and after this one. */
export function variableChanges(previous: StepVariables | undefined, current: StepVariables | undefined): ReadonlyArray<VariableChange> {
	const out: Array<VariableChange> = [];
	const scopes = [["var", "local"], ["global", "global"]] as const;
	for (const [scope, key] of scopes) {
		const before = previous?.[key];
		const after = current?.[key];
		if (before === after) continue; // the same shared snapshot: nothing changed
		for (const [name, value] of after ?? []) {
			const was = before?.get(name);
			if (before === undefined || !before.has(name)) out.push({ scope, name, value, previous: undefined, change: "added" });
			else if (!sameValue(was, value)) out.push({ scope, name, value, previous: was, change: "changed" });
		}
		for (const [name, was] of before ?? []) {
			if (after === undefined || !after.has(name)) out.push({ scope, name, value: undefined, previous: was, change: "removed" });
		}
	}
	return out;
}

// ── which inputs does this file reference? ─────────────────────────────────────────────────────────

export type ReferencedInputKind = "objectModel" | "param" | "global" | "var";

export interface ReferencedInput {
	kind: ReferencedInputKind;
	/** The key to store a value under: for `objectModel` and `param` a key of
	 *  {@link SimulationInputs.paths} (`"sensors.gpIn[0].value"`, `"param.S"`); for `global` and `var`
	 *  the bare name, a key of `globals` / `vars`. For a `dynamic` path, a template with `[*]` standing
	 *  for each computed index - informational only, there is no single value to give it. */
	name: string;
	/** 0-based indices of the lines that read it, ascending. */
	lines: ReadonlyArray<number>;
	/** True when an index in the path is itself an expression (`heat.heaters[var.i].current`): the
	 *  concrete paths only exist while the walk runs, and each will pause for a value when reached. */
	dynamic: boolean;
	/** For `objectModel` when a version was given: whether the schema at that version has the path. */
	known?: boolean;
}

export interface FindReferencedInputsOptions {
	/** When given, `objectModel` entries get {@link ReferencedInput.known}. */
	objectModelVersion?: string;
}

function walkExpression(node: ExprNode, visitPath: (node: ExprNode & { type: "path" }) => void): void {
	switch (node.type) {
		case "path":
			visitPath(node);
			for (const seg of node.segments) if (typeof seg !== "string") walkExpression(seg, visitPath);
			return;
		case "call": for (const a of node.args) walkExpression(a, visitPath); return;
		case "unary": walkExpression(node.operand, visitPath); return;
		case "binary": walkExpression(node.left, visitPath); walkExpression(node.right, visitPath); return;
		case "ternary": walkExpression(node.test, visitPath); walkExpression(node.then, visitPath); walkExpression(node.else, visitPath); return;
		case "array": for (const i of node.items) walkExpression(i, visitPath); return;
		default: return;
	}
}

/**
 * The object-model paths, `param.*` arguments and undeclared `global`/`var` variables that `text`
 * reads, so a UI can list them with an input box each BEFORE the run instead of pausing to ask about
 * them one at a time. A `global`/`var` the file itself declares (`global x = 0`) is not listed - the
 * file supplies its value. Only paths with literal indices are concrete; see
 * {@link ReferencedInput.dynamic} for the rest.
 */
export function findReferencedInputs(text: string, options: FindReferencedInputsOptions = {}): ReadonlyArray<ReferencedInput> {
	const doc = parseDocument(text);
	const declaredGlobals = new Set<string>();
	const declaredVars = new Set<string>();
	for (const line of doc.lines) {
		if (line.meta !== "global" && line.meta !== "var") continue;
		const a = parseAssignment(line.raw);
		if (a !== null) (line.meta === "global" ? declaredGlobals : declaredVars).add(a.name);
	}

	const found = new Map<string, { input: ReferencedInput; lines: Set<number> }>();
	const note = (kind: ReferencedInputKind, name: string, dynamic: boolean, line: number): void => {
		const key = `${kind}\u0000${name}`;
		let entry = found.get(key);
		if (entry === undefined) {
			entry = { input: { kind, name, lines: [], dynamic }, lines: new Set() };
			found.set(key, entry);
		}
		entry.lines.add(line);
	};

	for (const line of doc.lines) {
		if (line.meta === null && !line.raw.includes("{")) continue; // no expression can be on this line
		for (const { expression } of expressionsOfLine(doc, line.index)) {
			if (expression.errors.length > 0) continue;
			walkExpression(expression.ast, (node) => {
				const scope = node.root === "var" || node.root === "global" || node.root === "param" ? node.root : null;
				if (scope !== null && typeof node.segments[1] === "string") {
					const name = node.segments[1];
					if (scope === "param") note("param", `param.${name}`, false, line.index);
					else if (scope === "global" && !declaredGlobals.has(name)) note("global", name, false, line.index);
					else if (scope === "var" && !declaredVars.has(name)) note("var", name, false, line.index);
					return;
				}
				let concrete = node.root;
				let dynamic = false;
				for (let i = 1; i < node.segments.length; i++) {
					const seg = node.segments[i]!;
					if (typeof seg === "string") concrete += `.${seg}`;
					else if (seg.type === "number" && Number.isInteger(seg.value)) concrete += `[${seg.value}]`;
					else { concrete += "[*]"; dynamic = true; }
				}
				note("objectModel", concrete, dynamic, line.index);
			});
		}
	}

	const result: Array<ReferencedInput> = [];
	for (const { input, lines } of found.values()) {
		const sorted = [...lines].sort((a, b) => a - b);
		const entry: ReferencedInput = { ...input, lines: sorted };
		if (input.kind === "objectModel" && options.objectModelVersion !== undefined) {
			try {
				entry.known = objectModelPath(input.name.replace(/\[\d+\]|\[\*\]/g, "[]"), options.objectModelVersion).known;
			} catch {
				// an untracked version: leave `known` unset rather than claim anything
			}
		}
		result.push(entry);
	}
	return result.sort((a, b) => a.lines[0]! - b.lines[0]! || a.name.localeCompare(b.name));
}

// ── the view of one step ───────────────────────────────────────────────────────────────────────────

/** The source lines of `text` exactly as the walker indexes them - `ExecutionStepState.line` indexes
 *  this array. Compute once per run and pass to {@link describeStep}. */
export function sourceLines(text: string): ReadonlyArray<string> {
	return parseDocument(text).lines.map((l) => l.raw);
}

export interface StepView {
	/** 0-based index into `ExecutionIndex.steps`. */
	step: number;
	/** 1-based physical line, the convention `setCurrentLine` and editors use. */
	line: number;
	/** The line as written. */
	source: string;
	/** The line as evaluated (`changed: false` when there was nothing to evaluate). */
	evaluated: EvaluatedLine;
	/** The machine state after this step. */
	state: MachineState;
	/** The machine state before it - the starting state for step 0. */
	previousState: MachineState;
	/** Per-axis position, delta and homed flag for this step. */
	axes: ReadonlyArray<AxisReadout>;
	/** `var`/`global` values after this step (the scenario's presets when nothing has run yet). */
	variables: StepVariables;
	variableChanges: ReadonlyArray<VariableChange>;
	/** RRF's `iterations` when the step is inside a `while`, else null. */
	iteration: number | null;
}

/** Everything a stepper UI shows for one step, in one place: the source line and its evaluated form,
 *  the machine state before and after with per-axis deltas, and the variables and what changed in
 *  them. Null when `step` is outside `index.steps` (an empty file, or a run that paused first). */
export function describeStep(
	index: ExecutionIndex,
	step: number,
	lines: ReadonlyArray<string>,
	inputs: SimulationInputs,
): StepView | null {
	const current = index.steps[step];
	if (current === undefined) return null;
	const before = step > 0 ? index.steps[step - 1]! : undefined;
	const presetVariables: StepVariables = { local: inputs.vars, global: inputs.globals };
	const previousState = before?.state ?? createState({ initial: inputs.start });
	const variables = current.variables ?? presetVariables;
	const previousVariables = before === undefined ? presetVariables : before.variables ?? presetVariables;
	const source = lines[current.line] ?? "";
	return {
		step,
		line: current.line + 1,
		source,
		evaluated: renderEvaluatedLine(source, current.evaluation),
		state: current.state,
		previousState,
		axes: axisReadouts(current.state, previousState),
		variables,
		variableChanges: variableChanges(previousVariables, variables),
		iteration: current.iteration ?? null,
	};
}

// ── editing a scenario (pure: each returns a new SimulationInputs) ─────────────────────────────────

function withEntry(map: ReadonlyMap<string, EvalValue>, name: string, value: EvalValue | undefined): ReadonlyMap<string, EvalValue> {
	const next = new Map(map);
	if (value === undefined) next.delete(name);
	else next.set(name, value);
	return next;
}

/** The value a scenario gives an input, or undefined when it has none. `kind` is a
 *  {@link ReferencedInputKind}: object-model paths and `param.*` live in `paths`, `global`s and
 *  `var`s in their own maps. */
export function getInputValue(inputs: SimulationInputs, kind: ReferencedInputKind, name: string): EvalValue | undefined {
	return (kind === "global" ? inputs.globals : kind === "var" ? inputs.vars : inputs.paths).get(name);
}

/** `inputs` with the named input set to `value`, or removed when `value` is undefined. */
export function withInputValue(inputs: SimulationInputs, kind: ReferencedInputKind, name: string, value: EvalValue | undefined): SimulationInputs {
	if (kind === "global") return { ...inputs, globals: withEntry(inputs.globals, name, value) };
	if (kind === "var") return { ...inputs, vars: withEntry(inputs.vars, name, value) };
	return { ...inputs, paths: withEntry(inputs.paths, name, value) };
}

/** `inputs` with an axis's starting position set, or unset (null). Setting an extra axis declares it. */
export function withStartAxis(inputs: SimulationInputs, letter: string, position: number | null): SimulationInputs {
	const axes = { ...(inputs.start.axes ?? {}) };
	if (position === null || !Number.isFinite(position)) delete axes[letter];
	else axes[letter] = position;
	return { ...inputs, start: { ...inputs.start, axes } };
}

/** `inputs` with an extra axis declared (or dropped) for the walk even before it has a position. */
export function withDeclaredAxis(inputs: SimulationInputs, letter: string, declared: boolean): SimulationInputs {
	const letters = (inputs.start.axisLetters ?? []).filter((l) => l !== letter);
	if (declared) letters.push(letter);
	const start = { ...inputs.start, axisLetters: letters };
	if (!declared) start.axes = Object.fromEntries(Object.entries(inputs.start.axes ?? {}).filter(([l]) => l !== letter));
	return { ...inputs, start };
}

export function withStartHomed(inputs: SimulationInputs, letter: string, homed: boolean): SimulationInputs {
	const others = (inputs.start.homed ?? []).filter((l) => l !== letter);
	return { ...inputs, start: { ...inputs.start, homed: homed ? [...others, letter] : others } };
}

/** `inputs` with the starting extruder position / tool / feedrate set, or unset (null). */
export function withStartValue(inputs: SimulationInputs, key: "e" | "tool" | "feedrate", value: number | null): SimulationInputs {
	const start = { ...inputs.start };
	if (value === null || !Number.isFinite(value)) delete start[key];
	else start[key] = value;
	return { ...inputs, start };
}

export function withStartMode(inputs: SimulationInputs, key: "relativeMoves" | "relativeE", value: boolean): SimulationInputs {
	return { ...inputs, start: { ...inputs.start, [key]: value } };
}

/** True when the scenario sets nothing at all. */
export function isEmptySimulationInputs(inputs: SimulationInputs): boolean {
	const s = inputs.start;
	return (s.axes === undefined || Object.keys(s.axes).length === 0)
		&& (s.axisLetters === undefined || s.axisLetters.length === 0)
		&& (s.homed === undefined || s.homed.length === 0)
		&& s.e === undefined && s.tool === undefined && s.feedrate === undefined
		&& s.relativeMoves === undefined && s.relativeE === undefined
		&& inputs.paths.size === 0 && inputs.globals.size === 0 && inputs.vars.size === 0
		&& inputs.messageBoxAnswers.size === 0;
}
