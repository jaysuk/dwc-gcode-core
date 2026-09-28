/**
 * Determines the REAL execution order of a `GcodeDocument`'s lines — which `if`/`elif`/`else` arm
 * actually runs, whether/how many times a `while` body repeats, `break`/`continue`/`abort` — rather
 * than the flat top-to-bottom walk a caller gets by just iterating `doc.lines`. Built entirely on
 * `document.ts`'s existing `blocks` tree (the indentation-stack structure, already RRF-faithful) and
 * `expr/evaluate.ts` (this task's own evaluator) — this module's only real job is the control-flow
 * interpretation glueing the two together, plus the small amount of state RRF's execution model needs
 * that a static parse doesn't carry: `var`/`global` variable values, assigned as `var`/`global`/`set`
 * lines are reached.
 *
 * Deliberately a single-pass, whole-walk, SYNCHRONOUS function, not a resumable generator: re-running
 * it from the top after a caller supplies one more simulated value (see `UnresolvedPathError` in
 * `expr/evaluate.ts`) is simpler and no less correct than trying to resume mid-walk — the walk is
 * pure and deterministic given the same `resolvePath`, so it just gets further than last time.
 *
 * Scope: an `if`/`elif`/`else`/`while` CONDITION can pause execution on an unresolved object-model
 * path OR an unresolved `param.*` reference (a macro's own M98-call argument - this is a whole-file
 * simulation with no calling M98 line, so `param.*` is never actually known, only ever simulatable),
 * and a blocking `M291` (`messageBox.ts`) can pause it on an unanswered message box — all three are
 * genuine control-flow forks a real machine would actually wait on, and all three ultimately pause
 * through the same `resolvePath`/`UnresolvedPathError` mechanism (a `param.X` pause reports its path
 * as the string `"param.X"`, no separate WalkOutcome shape). An ordinary command's own `{...}`
 * parameter (e.g. `G1 X{sensors.someValue}`) is NOT evaluated by this module at all, since — unlike
 * those two — it doesn't affect which lines run next; a caller deriving machine state from each step
 * is free to evaluate those separately.
 */

import { EvalError, evaluateExpression, type EvalContext, type EvalValue } from "./expr/evaluate.js";
import type { Block, GcodeDocument } from "./document.js";
import { expressionsOfLine } from "./document.js";
import { parseAssignment, type AssignmentForm, type VariableScope } from "./meta.js";
import { parseBlockingMessageBox, type BlockingMessageBox, type MessageBoxPrompt } from "./messageBox.js";
import { objectModelPath } from "./objectmodel/schema.js";

export type { MessageBoxPrompt };

/** One expression on a line, evaluated - see {@link LineEvaluation}. */
export interface EvaluatedExpression {
	/** `"meta"`: the expression of an `if`/`elif`/`while`/`echo`/`abort`/`var`/`global`/`set` line.
	 *  `"param"`: a `{...}`-valued parameter. `"stringArgument"`: the `{...}` string argument of a
	 *  command like `M117`. */
	kind: "meta" | "param" | "stringArgument";
	/** The parameter's letter, for `kind: "param"`. */
	letter?: string;
	/** Index span within the LINE'S OWN raw text (`doc.lines[line].raw`) - a parameter's covers its
	 *  whole value including the braces, so replacing `raw.slice(start, end)` with the value
	 *  renders "the line as evaluated". */
	start: number;
	end: number;
	value: EvalValue;
}

/** What evaluating a line's own expressions produced - present on a step only under
 *  {@link WalkOptions.recordEvaluation}, and only when the line has something to evaluate. */
export interface LineEvaluation {
	/** In source order. */
	expressions: ReadonlyArray<EvaluatedExpression>;
	/** For `if`/`elif`/`while`: whether the condition held. */
	condition?: boolean;
	/** For `var`/`global`/`set`: the assignment that took effect. */
	assignment?: { form: AssignmentForm; scope: VariableScope; name: string; value: EvalValue };
}

/** The variables visible AFTER a step ran (`var` names innermost-scope-wins, plus every `global`).
 *  Immutable and shared between consecutive steps that didn't change them, so recording it on every
 *  step costs one reference, not one copy. */
export interface StepVariables {
	local: ReadonlyMap<string, EvalValue>;
	global: ReadonlyMap<string, EvalValue>;
}

export interface ExecutionStep {
	/** The physical line index (`doc.lines[line]`) that actually executes at this step. A loop body
	 *  produces one step per iteration, so the same line index can appear more than once. */
	line: number;
	/** Only under {@link WalkOptions.recordEvaluation}: this line's expressions as evaluated. */
	evaluation?: LineEvaluation;
	/** Only under {@link WalkOptions.recordEvaluation}: the variables as they stand after this step. */
	variables?: StepVariables;
	/** Only under {@link WalkOptions.recordEvaluation}, and only inside a `while`: RRF's `iterations`
	 *  value (0-based) for the innermost enclosing loop at this step. */
	iteration?: number;
	/** Every `{...}`-valued parameter on this line's own command(s), evaluated - only present when
	 *  `WalkOptions.evaluateParams` is true AND the line actually has at least one. Keyed by the
	 *  literal parameter letter (uppercase); a line with more than one command on it (`G90 G1
	 *  X{param.X}`) pools every command's params into one map, since letters don't collide within a
	 *  single physical line's own commands in practice. */
	resolvedParams?: ReadonlyMap<string, EvalValue>;
}

export interface WalkOptions {
	/** Resolves an object-model path to a value, or throws `UnresolvedPathError` (from
	 *  `./expr/evaluate.js`) to pause the walk at the condition that referenced it. */
	resolvePath(path: string): EvalValue;
	/** When true, every `{...}`-valued PARAMETER (not just a condition/M291) on each executed plain
	 *  command line is also evaluated, via the same `resolvePath`/variable scope a condition already
	 *  uses - an unresolved one (`UnresolvedPathError`) pauses the whole walk exactly like an
	 *  unresolved condition does, so a caller can prompt for it the same way. Resolved values are
	 *  exposed on that step via `ExecutionStep.resolvedParams`. Default false: evaluating every
	 *  line's own parameters is real extra work this module's own documented scope has always
	 *  excluded (see the module doc comment) - a caller that only cares about control flow, or that
	 *  evaluates parameters itself from `onStep`, shouldn't pay for it. */
	evaluateParams?: boolean;
	/** When true, each {@link ExecutionStep} also carries what its line evaluated to (`evaluation`),
	 *  the variables in force after it (`variables`) and the loop `iteration`. Implies
	 *  `evaluateParams`, and additionally evaluates what that leaves alone: a command's `{...}`
	 *  string argument, and an `echo`/`abort` expression (an `echo` whose text isn't a clean
	 *  expression - a `>file` redirect, say - is left alone rather than failed). Like an unresolved
	 *  parameter, an unresolved path in any of them pauses the walk. Default false. */
	recordEvaluation?: boolean;
	/** `global` variables that already exist when the walk starts - what a macro sees when
	 *  `config.g` (or an earlier macro) declared them, which a single-file walk otherwise has no
	 *  way to know. */
	initialGlobals?: ReadonlyMap<string, EvalValue>;
	/** `var` variables that already exist in the file's outermost scope when the walk starts - for
	 *  stepping a fragment lifted out of a longer macro. */
	initialVars?: ReadonlyMap<string, EvalValue>;
	/** First line to execute from. Default 0. */
	startLine?: number;
	/** One past the last line to execute (exclusive). Default `doc.lines.length`. */
	endLine?: number;
	/** Hard cap on a single `while` loop's iteration count — RRF itself has none (it re-seeks the file
	 *  on every iteration, `GCodeBuffer::RestartFrom`), but an offline simulator must not be allowed to
	 *  hang a browser tab on `while true`. Default 10 000. */
	maxIterationsPerLoop?: number;
	/** Hard cap on the total number of steps produced across the whole walk (guards against many
	 *  loops each individually under `maxIterationsPerLoop` still multiplying out to something huge).
	 *  Default 200 000. */
	maxSteps?: number;
	/** When given, every concrete object-model path a condition references is checked against
	 *  `objectmodel/schema.ts` at this RRF version BEFORE `resolvePath` is even called — a path that
	 *  doesn't exist at that version (a typo, or a path added/removed since) is a hard `"error"`, not a
	 *  `"paused"` — asking a caller to guess a value for a path that doesn't exist doesn't make sense.
	 *  Also backs `exists()` for an object-model-path argument (`EvalContext.pathExists`); without this
	 *  option `exists()` on such a path is a clean "not supported" error instead. Must be one of
	 *  `OBJECT_MODEL_VERSIONS`' tracked versions (`objectmodel/versions.js`) — an unknown/untracked
	 *  version surfaces as an ordinary `"error"` outcome, not a thrown exception. */
	objectModelVersion?: string;
	/** Called synchronously, in order, immediately after each step is recorded (including the last one
	 *  before a step-budget error) — before `walkExecution` itself returns. Lets a caller maintain its
	 *  own state INCREMENTALLY as the walk proceeds (e.g. deriving machine state line by line so a
	 *  later condition's `resolvePath` can answer from what's ALREADY known instead of asking again),
	 *  rather than only being able to replay `WalkOutcome.steps` after the whole walk finishes. */
	onStep?(step: ExecutionStep): void;
	/** Answers a blocking `M291` message box (`messageBox.ts`'s own doc comment has the exact modes
	 *  this covers). Throw {@link UnresolvedMessageBoxError} (or omit this option entirely) to pause
	 *  the walk there instead — the same re-run-to-make-progress pattern `resolvePath` uses. A
	 *  non-blocking `M291` (S0/S1) never reaches this; it's just an ordinary step. */
	resolveMessageBox?(prompt: MessageBoxPrompt): MessageBoxAnswer;
}

export interface MessageBoxAnswer {
	/** RRF's `input` constant afterward — the entered/chosen value for `"integer"`/`"float"`/
	 *  `"string"`, or `null` for `"ok"`/`"okCancel"` (nothing was ever asked for) or when cancelled. */
	input: EvalValue;
	/** Only meaningful for `"okCancel"` — every other mode has no cancel button, so this must be
	 *  `false` for those. */
	cancelled: boolean;
}

/** Thrown by `WalkOptions.resolveMessageBox` for a blocking `M291` whose answer isn't available yet —
 *  caught inside `walkExecution` and turned into a `"message-box"` `WalkOutcome`, the same "pause and
 *  let a caller re-run with more information" shape `UnresolvedPathError` uses for object-model paths
 *  (`expr/evaluate.ts`). Distinct class because a message box isn't an expression-evaluation concern
 *  at all — it's triggered by a whole COMMAND, not a path reference inside a condition. */
export class UnresolvedMessageBoxError extends Error {
	constructor(message = "No answer available for this message box yet") {
		super(message);
		this.name = "UnresolvedMessageBoxError";
	}
}

export type WalkOutcome =
	| { status: "complete"; steps: ReadonlyArray<ExecutionStep> }
	/** Stopped at an `if`/`elif`/`while` condition whose evaluation needs a path `resolvePath` doesn't
	 *  have a value for yet. `steps` holds everything executed before this point; re-running
	 *  `walkExecution` with a `resolvePath` that now answers `path` picks up from the top and gets
	 *  further (see the module doc comment for why re-running beats resuming). */
	| { status: "paused"; steps: ReadonlyArray<ExecutionStep>; line: number; path: string }
	/** Stopped at a blocking `M291` (`messageBox.ts`) whose answer `resolveMessageBox` doesn't have —
	 *  same re-run-to-progress shape as `"paused"`, just triggered by a command instead of a path. */
	| { status: "message-box"; steps: ReadonlyArray<ExecutionStep>; line: number; prompt: MessageBoxPrompt }
	/** A genuine problem with the document itself (a malformed condition, an undefined variable, an
	 *  `elif`/`else` that doesn't follow an `if`, a runaway loop) — not something more simulated input
	 *  can fix. */
	| { status: "error"; steps: ReadonlyArray<ExecutionStep>; line: number; message: string };

const EMPTY_PARAM_VALUES: ReadonlyMap<string, EvalValue> = new Map();

type Signal =
	| { kind: "fell-through" }
	| { kind: "break"; line: number }
	| { kind: "continue"; line: number }
	| { kind: "abort" }
	| { kind: "paused"; line: number; path: string }
	| { kind: "message-box"; line: number; prompt: MessageBoxPrompt }
	| { kind: "error"; line: number; message: string };

function conditionExpression(doc: GcodeDocument, line: number) {
	// `if`/`elif`/`while` each carry exactly one "meta" expression (their condition) — see
	// `document.ts`'s `META_KEYWORDS_WITH_EXPRESSION` and `expressionsOfLine`.
	return expressionsOfLine(doc, line).find((e) => e.source.kind === "meta");
}

/** Runs `walkExecution`; kept as its own class only so the mutable `var`/`global` maps, `steps`
 *  array and step budget don't need threading through every helper as explicit parameters. */
class Walker {
	private readonly steps: Array<ExecutionStep> = [];
	// `var` is block-scoped (RRF: a variable declared inside an if/while body doesn't exist once that
	// body ends) - a stack of frames, one pushed per block body entered (see execBlock below),
	// `varStack[0]` being the file's own outermost scope. Declaring inserts into the TOP frame only
	// (may shadow an outer one); `set` mutates whichever frame the name is actually found in, searching
	// innermost-first, NOT always the top frame. `global` has no such scoping in RRF - one flat map.
	private readonly varStack: Array<Map<string, EvalValue>> = [new Map()];
	private readonly globalScope = new Map<string, EvalValue>();
	private totalSteps = 0;
	private readonly maxIterationsPerLoop: number;
	private readonly maxSteps: number;
	private readonly onStep: ((step: ExecutionStep) => void) | undefined;
	private readonly resolveMessageBox: ((prompt: MessageBoxPrompt) => MessageBoxAnswer) | undefined;
	private readonly evaluateParams: boolean;
	private readonly record: boolean;
	// Bumped whenever the set of visible variables changes, so `snapshotVariables` can hand consecutive
	// steps the SAME object instead of copying the scopes for every step of a long loop.
	private varsVersion = 0;
	private cachedVars: StepVariables | undefined;
	private cachedVarsVersion = -1;
	private readonly evalCtx: EvalContext;
	// RRF's `result`/`input`/`line`/`iterations` execution-state constants (expr/evaluate.ts's own
	// `resolveExecutionConstant`) - tracked unconditionally, regardless of whether the caller cares
	// about message boxes at all, since all four are cheap and always answerable from what the walker
	// already knows. `lastResult` starts at 0 (ok) - this simulator doesn't model ordinary command
	// failure, only a cancelled M291 (-1) ever changes it.
	private lastResult: EvalValue = 0;
	private lastInput: EvalValue = null;
	private currentLine = 0;
	private readonly iterationStack: Array<number> = [];

	constructor(
		private readonly doc: GcodeDocument,
		resolvePath: (path: string) => EvalValue,
		maxIterationsPerLoop: number,
		maxSteps: number,
		objectModelVersion: string | undefined,
		onStep: ((step: ExecutionStep) => void) | undefined,
		resolveMessageBox: ((prompt: MessageBoxPrompt) => MessageBoxAnswer) | undefined,
		evaluateParams: boolean,
		recordEvaluation: boolean,
		initialGlobals: ReadonlyMap<string, EvalValue> | undefined,
		initialVars: ReadonlyMap<string, EvalValue> | undefined,
	) {
		this.maxIterationsPerLoop = maxIterationsPerLoop;
		this.onStep = onStep;
		this.maxSteps = maxSteps;
		this.resolveMessageBox = resolveMessageBox;
		this.record = recordEvaluation;
		this.evaluateParams = evaluateParams || recordEvaluation;
		for (const [name, value] of initialGlobals ?? []) this.globalScope.set(name, value);
		for (const [name, value] of initialVars ?? []) this.varStack[0]!.set(name, value);
		const checkKnownPath = (path: string): boolean => {
			// Indices are already concrete numbers here (e.g. "sensors.gpIn[0].value") - the schema
			// stores paths normalised with "[]" (task 07's own convention, matched by objectmodel/
			// schema.ts's own OBJECT_MODEL_PATHS), so undo that before looking the path up.
			const normalized = path.replace(/\[\d+\]/g, "[]");
			try {
				return objectModelPath(normalized, objectModelVersion!).known;
			} catch (e) {
				throw new EvalError(e instanceof Error ? e.message : String(e));
			}
		};
		this.evalCtx = {
			resolvePath: objectModelVersion === undefined
				? resolvePath
				: (path) => {
					if (!checkKnownPath(path)) throw new EvalError(`'${path}' is not a known object-model path at RRF ${objectModelVersion}`);
					return resolvePath(path);
				},
			resolveVariable: (scope, name) => {
				// Must throw EvalError specifically, not a plain Error - evaluateExpression's own catch
				// only converts UnresolvedPathError/EvalError into a clean {ok:false} outcome; anything
				// else is deliberately left to propagate as a real exception (a programmer-error signal,
				// see its own doc comment) - a plain Error here would crash the whole walk instead of
				// surfacing as a normal WalkOutcome "error" (a real bug this fixed, caught by a test that
				// reads an undefined var from a CONDITION - every earlier test only exercised the
				// "set on an undefined var" path, which never reaches resolveVariable at all).
				//
				// `param.*` (a macro's own M98-call arguments) genuinely has no value in a whole-file
				// simulation with no calling M98 line - routed through the caller's own (UNWRAPPED -
				// deliberately bypassing the objectModelVersion/checkKnownPath gate above, which is
				// about real object-model paths, not this separate namespace) `resolvePath`, keyed
				// "param.<name>", so a caller backing it with the same overrides map it already uses for
				// object-model paths (e.g. `createSimulatedResolvePath`) can pause-and-prompt for a
				// param's value exactly the way it already does for an unresolved sensor reading -
				// `resolvePath` throwing `UnresolvedPathError` here produces the same clean "paused"
				// outcome, with `path` reading "param.X", no new WalkOutcome shape needed.
				if (scope === "param") return resolvePath(`param.${name}`);
				if (scope === "global") {
					if (!this.globalScope.has(name)) throw new EvalError(`'global.${name}' is not defined`);
					return this.globalScope.get(name) as EvalValue;
				}
				for (let i = this.varStack.length - 1; i >= 0; i--) {
					const frame = this.varStack[i]!;
					if (frame.has(name)) return frame.get(name) as EvalValue;
				}
				throw new EvalError(`'var.${name}' is not defined`);
			},
			pathExists: objectModelVersion === undefined ? undefined : checkKnownPath,
			resolveExecutionConstant: (name) => {
				switch (name) {
					case "result": return this.lastResult;
					case "input": return this.lastInput;
					case "line": return this.currentLine;
					case "iterations": {
						const top = this.iterationStack[this.iterationStack.length - 1];
						if (top === undefined) throw new EvalError("'iterations' used when not inside a loop");
						return top;
					}
				}
			},
		};
	}

	/** Runs `body` with a fresh `var` scope frame pushed for its duration - every block BODY (an
	 *  if/elif/else arm, one `while` iteration) gets its own frame, popped again once `body` returns
	 *  regardless of how it returns, so a `var` declared inside never leaks past where it should go out
	 *  of scope. The file's own top-level scope (`varStack[0]`) is never pushed/popped this way - see
	 *  `run()`, which calls `execBlockList` directly for the whole-document walk. */
	private execBlock(children: ReadonlyArray<Block>, start: number, end: number): Signal {
		this.varStack.push(new Map());
		try {
			return this.execBlockList(children, start, end);
		} finally {
			// Only a frame that actually held something changes what's visible afterwards.
			if (this.varStack.pop()!.size > 0) this.varsVersion++;
		}
	}

	private snapshotVariables(): StepVariables {
		if (this.cachedVars !== undefined && this.cachedVarsVersion === this.varsVersion) return this.cachedVars;
		const local = new Map<string, EvalValue>();
		for (const frame of this.varStack) for (const [name, value] of frame) local.set(name, value);
		this.cachedVars = { local, global: new Map(this.globalScope) };
		this.cachedVarsVersion = this.varsVersion;
		return this.cachedVars;
	}

	private pushStep(line: number, resolvedParams?: ReadonlyMap<string, EvalValue>, evaluation?: LineEvaluation): "ok" | { kind: "error"; line: number; message: string } {
		const step: ExecutionStep = resolvedParams === undefined ? { line } : { line, resolvedParams };
		if (this.record) {
			if (evaluation !== undefined) step.evaluation = evaluation;
			step.variables = this.snapshotVariables();
			const iteration = this.iterationStack[this.iterationStack.length - 1];
			if (iteration !== undefined) step.iteration = iteration;
		}
		this.steps.push(step);
		this.totalSteps++;
		this.onStep?.(step);
		if (this.totalSteps > this.maxSteps) {
			return { kind: "error", line, message: `Execution exceeded the ${this.maxSteps}-step budget` };
		}
		return "ok";
	}

	/** Evaluates every `{...}`-valued PARAMETER on `line`'s own command(s) - only ever called when
	 *  `this.evaluateParams` is true. Returns the resolved values (empty if the line has none), or the
	 *  `Signal` to propagate (paused/error) when one couldn't be evaluated - an unresolved parameter
	 *  pauses the whole walk exactly like an unresolved condition does, via the same `resolvePath`. */
	private evalLineParams(line: number): { ok: true; values: ReadonlyMap<string, EvalValue>; evaluation?: LineEvaluation } | Signal {
		const exprs = expressionsOfLine(this.doc, line)
			.filter((e) => e.source.kind === "param" || (this.record && e.source.kind === "stringArgument"));
		if (exprs.length === 0) return { ok: true, values: EMPTY_PARAM_VALUES };
		const docLine = this.doc.lines[line]!;
		const values = new Map<string, EvalValue>();
		const evaluated: Array<EvaluatedExpression> = [];
		for (const { source, expression } of exprs) {
			if (source.kind === "param") {
				if (expression.errors.length > 0) {
					return { kind: "error", line, message: `Parameter ${source.letter} has a parse error: ${expression.errors[0]!.message}` };
				}
			} else if (expression.errors.length > 0) {
				// A string argument that merely starts with '{' but isn't a clean expression is just text to
				// RRF's own reader too - not something to fail a walk over.
				continue;
			}
			const outcome = evaluateExpression(expression.ast, this.evalCtx);
			if (!outcome.ok) {
				if (outcome.kind === "unresolved-path") return { kind: "paused", line, path: outcome.path };
				const what = source.kind === "param" ? `Parameter ${source.letter}` : "String argument";
				return { kind: "error", line, message: `${what}: ${outcome.message}` };
			}
			if (source.kind === "param") values.set(source.letter, outcome.value);
			if (this.record) {
				if (source.kind === "param") {
					const p = docLine.commands[source.command]?.params.find((q) => q.kind === "expression" && q.letter === source.letter);
					if (p !== undefined) evaluated.push({ kind: "param", letter: source.letter, start: p.valueStart, end: p.end, value: outcome.value });
				} else if (source.kind === "stringArgument") {
					const arg = docLine.commands[source.command]?.stringArgument;
					if (arg !== null && arg !== undefined) evaluated.push({ kind: "stringArgument", start: arg.start, end: arg.end, value: outcome.value });
				}
			}
		}
		return evaluated.length === 0 ? { ok: true, values } : { ok: true, values, evaluation: { expressions: evaluated } };
	}

	/** Evaluates an `echo`/`abort` line's expression for display only (it can't change control flow -
	 *  `abort` ends the walk either way). A text that isn't a clean expression is skipped rather than
	 *  failed: `echo >"0:/sys/log.txt" "text"` (a file redirect) is a legitimate `echo` this expression
	 *  parser was never meant to read. An unresolved path pauses and a genuine evaluation error fails,
	 *  as they would for a parameter. */
	private evalDisplayExpression(line: number): { ok: true; evaluation?: LineEvaluation } | Signal {
		this.currentLine = line + 1;
		const found = conditionExpression(this.doc, line);
		if (found === undefined || found.expression.errors.length > 0) return { ok: true };
		const outcome = evaluateExpression(found.expression.ast, this.evalCtx);
		if (!outcome.ok) {
			if (outcome.kind === "unresolved-path") return { kind: "paused", line, path: outcome.path };
			return { kind: "error", line, message: outcome.message };
		}
		return { ok: true, evaluation: { expressions: [this.metaExpression(line, found.expression.ast, outcome.value)] } };
	}

	private metaExpression(line: number, ast: { start: number; end: number }, value: EvalValue): EvaluatedExpression {
		const lineStart = this.doc.lines[line]!.start;
		return { kind: "meta", start: ast.start - lineStart, end: ast.end - lineStart, value };
	}

	/** Evaluates an `if`/`elif`/`while` line's condition. Returns the boolean, or the `Signal` to
	 *  propagate (paused/error) when it couldn't be evaluated. */
	private evalCondition(line: number): { ok: true; value: boolean; evaluation?: LineEvaluation } | Signal {
		this.currentLine = line + 1; // RRF's 'line' constant is 1-based (GCodeBuffer::GetLineNumber)
		const found = conditionExpression(this.doc, line);
		if (found === undefined) return { kind: "error", line, message: "Missing condition expression" };
		if (found.expression.errors.length > 0) {
			return { kind: "error", line, message: `Condition has a parse error: ${found.expression.errors[0]!.message}` };
		}
		const outcome = evaluateExpression(found.expression.ast, this.evalCtx);
		if (!outcome.ok) {
			if (outcome.kind === "unresolved-path") return { kind: "paused", line, path: outcome.path };
			return { kind: "error", line, message: outcome.message };
		}
		if (typeof outcome.value !== "boolean") {
			return { kind: "error", line, message: `Condition did not evaluate to a boolean (got ${outcome.value === null ? "null" : Array.isArray(outcome.value) ? "array" : typeof outcome.value})` };
		}
		if (!this.record) return { ok: true, value: outcome.value };
		return {
			ok: true,
			value: outcome.value,
			evaluation: { expressions: [this.metaExpression(line, found.expression.ast, outcome.value)], condition: outcome.value },
		};
	}

	/** Executes a `var`/`global`/`set` line's assignment against the running variable scopes. Returns
	 *  the `Signal` to propagate on failure, or `{ ok: true }` (with what was assigned, when recording)
	 *  on success. */
	private execAssignment(line: number): { ok: true; evaluation?: LineEvaluation } | Signal {
		this.currentLine = line + 1;
		const raw = this.doc.lines[line]!.raw;
		const assignment = parseAssignment(raw);
		if (assignment === null) {
			return { kind: "error", line, message: "This assignment form isn't supported by the simulator (e.g. an indexed 'set' target)" };
		}
		const found = conditionExpression(this.doc, line);
		if (found === undefined || found.expression.errors.length > 0) {
			return { kind: "error", line, message: "Assignment expression has a parse error" };
		}
		const outcome = evaluateExpression(found.expression.ast, this.evalCtx);
		if (!outcome.ok) {
			if (outcome.kind === "unresolved-path") return { kind: "paused", line, path: outcome.path };
			return { kind: "error", line, message: outcome.message };
		}

		const done = (): { ok: true; evaluation?: LineEvaluation } => {
			this.varsVersion++;
			if (!this.record) return { ok: true };
			return {
				ok: true,
				evaluation: {
					expressions: [this.metaExpression(line, found.expression.ast, outcome.value)],
					assignment: { form: assignment.form, scope: assignment.scope, name: assignment.name, value: outcome.value },
				},
			};
		};

		if (assignment.scope === "global") {
			if (assignment.form === "set" && !this.globalScope.has(assignment.name)) {
				return { kind: "error", line, message: `'global.${assignment.name}' is not defined` };
			}
			this.globalScope.set(assignment.name, outcome.value);
			return done();
		}

		// "local" (var) scope. 'declare' (var NAME = ...) always creates it in the CURRENT (innermost)
		// frame, shadowing any outer var of the same name - matches ordinary block-scoped declaration.
		if (assignment.form === "declare") {
			this.varStack[this.varStack.length - 1]!.set(assignment.name, outcome.value);
			return done();
		}
		// 'set' (set var.NAME = ...) mutates an EXISTING var - search innermost-first and update
		// whichever frame actually has it, not always the current one.
		for (let i = this.varStack.length - 1; i >= 0; i--) {
			if (this.varStack[i]!.has(assignment.name)) {
				this.varStack[i]!.set(assignment.name, outcome.value);
				return done();
			}
		}
		return { kind: "error", line, message: `'var.${assignment.name}' is not defined` };
	}

	/** Ordinary (non-block-keyword) lines in `[from, toExclusive)`: comments/blanks are skipped,
	 *  commands/fields/unrecognised/comment lines are all recorded as steps — a comment has no effect
	 *  on control flow, but RRF's real file reader still passes over it in physical order, and a caller
	 *  deriving its own state from a line's content (e.g. a slicer's `;LAYER_CHANGE` marker) needs to
	 *  see it walked in sequence like any other line, the same reasoning that already applies to
	 *  `skip`/`echo` below. A blank line is excluded — unlike a comment, it carries no content a caller
	 *  could ever care about, and (unlike RRF, which has no trailing-newline convention to trip over)
	 *  this package's own line-splitting produces one extra trailing blank line for every document
	 *  ending in a newline (`document.ts`'s `splitLines`, matching `String.prototype.split`'s own
	 *  convention) — counting it as a step would put a spurious extra step at the end of nearly every
	 *  real file. `break`/`continue`/`abort` end the range early with the matching `Signal`.
	 *  `if`/`elif`/`else`/`while` never appear here — the caller (`execBlockList`) only calls this on
	 *  the gaps BETWEEN block-tree nodes. */
	private execPlainLines(from: number, toExclusive: number): Signal {
		for (let line = from; line < toExclusive; line++) {
			const docLine = this.doc.lines[line]!;
			if (docLine.kind === "blank") continue;

			if (docLine.kind === "meta") {
				switch (docLine.meta) {
					case "break": {
						const r = this.pushStep(line);
						if (r !== "ok") return r;
						return { kind: "break", line };
					}
					case "continue": {
						const r = this.pushStep(line);
						if (r !== "ok") return r;
						return { kind: "continue", line };
					}
					case "abort": {
						let evaluation: LineEvaluation | undefined;
						if (this.record) {
							const shown = this.evalDisplayExpression(line);
							if (!("ok" in shown)) return shown;
							evaluation = shown.evaluation;
						}
						const r = this.pushStep(line, undefined, evaluation);
						if (r !== "ok") return r;
						return { kind: "abort" };
					}
					case "var":
					case "global":
					case "set": {
						const assigned = this.execAssignment(line);
						if (!("ok" in assigned)) return assigned; // paused/error - this line never completes, not a step
						const r = this.pushStep(line, undefined, assigned.evaluation);
						if (r !== "ok") return r;
						continue;
					}
					default: {
						// "skip" (a documented no-op) and "echo" (its message text doesn't affect control
						// flow, see module doc comment) just record a step like any other line - though under
						// recordEvaluation an echo's expression is evaluated so the step can show its text.
						let evaluation: LineEvaluation | undefined;
						if (this.record && docLine.meta === "echo") {
							const shown = this.evalDisplayExpression(line);
							if (!("ok" in shown)) return shown;
							evaluation = shown.evaluation;
						}
						const r = this.pushStep(line, undefined, evaluation);
						if (r !== "ok") return r;
						continue;
					}
				}
			}

			if (docLine.kind === "commands") {
				const box = docLine.commands.map(parseBlockingMessageBox).find((b) => b !== null) ?? null;
				if (box !== null) {
					if (box.kind === "choice") {
						const resolved = this.evalChoicePrompt(line, box);
						if (!("prompt" in resolved)) return resolved; // paused/error - K itself didn't resolve
						const sig = this.execMessageBox(line, resolved.prompt, box.cancelAborts);
						if (sig !== null) return sig;
						continue;
					}
					const sig = this.execMessageBox(line, box.prompt, box.cancelAborts);
					if (sig !== null) return sig; // paused/error/abort - this line never completes as a plain step
					continue; // accepted (or cancelled without aborting) - execMessageBox already pushed the step
				}
			}

			if (this.evaluateParams) {
				this.currentLine = line + 1;
				const evaluated = this.evalLineParams(line);
				if (!("ok" in evaluated)) return evaluated; // paused/error - this line never completes as a step
				const r = this.pushStep(line, evaluated.values, evaluated.evaluation);
				if (r !== "ok") return r;
				continue;
			}

			const r = this.pushStep(line);
			if (r !== "ok") return r;
		}
		return { kind: "fell-through" };
	}

	/** Evaluates an `S4` choice box's `K` expression (unevaluated by `messageBox.ts` itself — see its
	 *  own doc comment) into a final, displayable `"choice"` prompt. Returns the `Signal` to propagate
	 *  when `K` itself doesn't resolve (a parse error, an unresolved path, or a value that isn't an
	 *  array of strings) — never called for any other mode, which need no evaluation at all. */
	private evalChoicePrompt(line: number, box: Extract<BlockingMessageBox, { kind: "choice" }>): { prompt: MessageBoxPrompt } | Signal {
		if (box.choices.errors.length > 0) {
			return { kind: "error", line, message: `'K' has a parse error: ${box.choices.errors[0]!.message}` };
		}
		const outcome = evaluateExpression(box.choices.ast, this.evalCtx);
		if (!outcome.ok) {
			if (outcome.kind === "unresolved-path") return { kind: "paused", line, path: outcome.path };
			return { kind: "error", line, message: outcome.message };
		}
		if (!Array.isArray(outcome.value) || !outcome.value.every((v) => typeof v === "string")) {
			return { kind: "error", line, message: "'K' must evaluate to an array of strings" };
		}
		return { prompt: { mode: "choice", message: box.message, title: box.title, choices: outcome.value, defaultIndex: box.defaultIndex } };
	}

	/** Resolves a blocking `M291` (see `messageBox.ts`). Returns the `Signal` to propagate
	 *  (paused/error/abort) or `null` once it's been answered and the line recorded as a step. */
	private execMessageBox(line: number, prompt: MessageBoxPrompt, cancelAborts: boolean): Signal | null {
		if (this.resolveMessageBox === undefined) return { kind: "message-box", line, prompt };
		let answer: MessageBoxAnswer;
		try {
			answer = this.resolveMessageBox(prompt);
		} catch (e) {
			if (e instanceof UnresolvedMessageBoxError) return { kind: "message-box", line, prompt };
			throw e; // a genuine programmer error in the resolver, not a value-domain "don't know yet"
		}
		const r = this.pushStep(line);
		if (r !== "ok") return r;
		if (answer.cancelled) {
			this.lastResult = -1;
			this.lastInput = null;
			// "If shouldAbort is true, then the containing macro will be aborted before this value can
			// be read" (RRF's own AcknowledgeMessage comment) - matches this walker's existing 'abort'
			// meta-keyword handling exactly: the walk ends as "complete" right here, nothing after runs.
			return cancelAborts ? { kind: "abort" } : null;
		}
		this.lastResult = 0;
		this.lastInput = answer.input;
		return null;
	}

	/** Walks `blocks` (a sibling list at one nesting level — `doc.blocks` itself, or some block's own
	 *  `children`) together with the ordinary lines between/around them, covering `[containerStart,
	 *  containerEnd)`. Mirrors RRF's real behaviour: an `if`/`elif`/`else` chain evaluates arms in
	 *  order until one is true (or `else` is reached) and executes only that one's body; a `while`
	 *  re-evaluates its condition before every iteration, including the first. */
	private execBlockList(blocks: ReadonlyArray<Block>, containerStart: number, containerEnd: number): Signal {
		let cursor = containerStart;
		let i = 0;
		while (i < blocks.length) {
			const block = blocks[i]!;
			const gap = this.execPlainLines(cursor, block.line);
			if (gap.kind !== "fell-through") return gap;

			if (block.keyword === "if") {
				let j = i;
				let resolvedArm = false;
				while (
					j < blocks.length
					// The chain's own head (j === i) is always "if" - guaranteed by the caller's own
					// dispatch just above. Any LATER member (j > i) may only be an 'elif'/'else' - a
					// fresh 'if' starting right after the previous arm's endLine is a brand-new,
					// independent statement, never a continuation, no matter how adjacent the lines are
					// (a real bug this fixed: two back-to-back top-level ifs with no gap between them
					// were wrongly swept into one chain, silently skipping the second if's own condition
					// and body whenever the first arm had already resolved true).
					&& (j === i ? blocks[j]!.keyword === "if" : (blocks[j]!.keyword === "elif" || blocks[j]!.keyword === "else"))
					&& (j === i || blocks[j]!.line === blocks[j - 1]!.endLine + 1)
				) {
					const arm = blocks[j]!;
					if (resolvedArm) {
						// A later sibling in the chain, reached only after an earlier arm already won -
						// RRF still reads past this line sequentially (there's no seek here, only in a
						// while's RestartFrom), it just never evaluates ITS condition or runs ITS body.
						const r = this.pushStep(arm.line);
						if (r !== "ok") return r;
					} else if (arm.keyword === "else") {
						const r = this.pushStep(arm.line);
						if (r !== "ok") return r;
						resolvedArm = true;
						const sig = this.execBlock(arm.children, arm.line + 1, arm.endLine + 1);
						if (sig.kind !== "fell-through") return sig;
					} else {
						const cond = this.evalCondition(arm.line);
						if (!("ok" in cond)) return cond; // paused/error - this line never completes, not a step
						const r = this.pushStep(arm.line, undefined, cond.evaluation);
						if (r !== "ok") return r;
						if (cond.value) {
							resolvedArm = true;
							const sig = this.execBlock(arm.children, arm.line + 1, arm.endLine + 1);
							if (sig.kind !== "fell-through") return sig;
						}
					}
					j++;
				}
				cursor = blocks[j - 1]!.endLine + 1;
				i = j;
				continue;
			}

			if (block.keyword === "while") {
				let iterations = 0;
				for (;;) {
					const cond = this.evalCondition(block.line);
					if (!("ok" in cond)) return cond; // paused/error - this line never completes, not a step
					const r = this.pushStep(block.line, undefined, cond.evaluation);
					if (r !== "ok") return r;
					if (!cond.value) break;
					iterations++;
					if (iterations > this.maxIterationsPerLoop) {
						return { kind: "error", line: block.line, message: `'while' loop exceeded ${this.maxIterationsPerLoop} iterations — this simulator caps loops RRF itself doesn't` };
					}
					// RRF's 'iterations' constant is 0-based; the local counter above is already
					// incremented to "this is pass number N" (1-based) by this point.
					this.iterationStack.push(iterations - 1);
					const sig = this.execBlock(block.children, block.line + 1, block.endLine + 1);
					this.iterationStack.pop();
					if (sig.kind === "break") break;
					if (sig.kind !== "fell-through" && sig.kind !== "continue") return sig;
				}
				cursor = block.endLine + 1;
				i++;
				continue;
			}

			// Only an orphaned 'elif'/'else' (one that doesn't follow a valid 'if') reaches here directly
			// — a valid chain is entirely consumed by the 'if' branch above. RRF's own
			// ProcessElifCommand/ProcessElseCommand throw "... did not follow 'if'" for exactly this.
			return { kind: "error", line: block.line, message: `'${block.keyword}' did not follow 'if'` };
		}
		return this.execPlainLines(cursor, containerEnd);
	}

	run(startLine: number, endLine: number): WalkOutcome {
		const sig = this.execBlockList(this.doc.blocks, startLine, endLine);
		switch (sig.kind) {
			case "fell-through":
			case "abort":
				return { status: "complete", steps: this.steps };
			case "paused":
				return { status: "paused", steps: this.steps, line: sig.line, path: sig.path };
			case "message-box":
				return { status: "message-box", steps: this.steps, line: sig.line, prompt: sig.prompt };
			case "error":
				return { status: "error", steps: this.steps, line: sig.line, message: sig.message };
			case "break":
			case "continue":
				// document.ts already flags this structurally ("break-outside-loop"/"continue-outside-loop")
				// - reaching here means the walk itself hit one live, which RRF treats as a hard error too.
				return { status: "error", steps: this.steps, line: sig.line, message: `'${sig.kind}' was not inside a loop` };
		}
	}
}

/** Walks `doc` in real RRF execution order (see module doc comment) and returns either the complete
 *  step sequence, or where/why it stopped early. Pure and synchronous — re-invoke with an updated
 *  `resolvePath` to make further progress past a `"paused"` outcome. */
export function walkExecution(doc: GcodeDocument, options: WalkOptions): WalkOutcome {
	const startLine = options.startLine ?? 0;
	const endLine = options.endLine ?? doc.lines.length;
	const maxIterationsPerLoop = options.maxIterationsPerLoop ?? 10_000;
	const maxSteps = options.maxSteps ?? 200_000;
	const walker = new Walker(doc, options.resolvePath, maxIterationsPerLoop, maxSteps, options.objectModelVersion, options.onStep, options.resolveMessageBox, options.evaluateParams ?? false, options.recordEvaluation ?? false, options.initialGlobals, options.initialVars);
	return walker.run(startLine, endLine);
}
