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
 * Scope: only `if`/`elif`/`else`/`while` CONDITIONS can pause execution on an unresolved path — an
 * ordinary command's own `{...}` parameter (e.g. `G1 X{sensors.someValue}`) is not evaluated by this
 * module at all, since it doesn't affect which lines run next. A caller deriving machine state from
 * each step is free to evaluate those separately.
 */

import { evaluateExpression, type EvalContext, type EvalValue } from "./expr/evaluate.js";
import type { Block, GcodeDocument } from "./document.js";
import { expressionsOfLine } from "./document.js";
import { parseAssignment } from "./meta.js";

export interface ExecutionStep {
	/** The physical line index (`doc.lines[line]`) that actually executes at this step. A loop body
	 *  produces one step per iteration, so the same line index can appear more than once. */
	line: number;
}

export interface WalkOptions {
	/** Resolves an object-model path to a value, or throws `UnresolvedPathError` (from
	 *  `./expr/evaluate.js`) to pause the walk at the condition that referenced it. */
	resolvePath(path: string): EvalValue;
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
}

export type WalkOutcome =
	| { status: "complete"; steps: ReadonlyArray<ExecutionStep> }
	/** Stopped at an `if`/`elif`/`while` condition whose evaluation needs a path `resolvePath` doesn't
	 *  have a value for yet. `steps` holds everything executed before this point; re-running
	 *  `walkExecution` with a `resolvePath` that now answers `path` picks up from the top and gets
	 *  further (see the module doc comment for why re-running beats resuming). */
	| { status: "paused"; steps: ReadonlyArray<ExecutionStep>; line: number; path: string }
	/** A genuine problem with the document itself (a malformed condition, an undefined variable, an
	 *  `elif`/`else` that doesn't follow an `if`, a runaway loop) — not something more simulated input
	 *  can fix. */
	| { status: "error"; steps: ReadonlyArray<ExecutionStep>; line: number; message: string };

type Signal =
	| { kind: "fell-through" }
	| { kind: "break"; line: number }
	| { kind: "continue"; line: number }
	| { kind: "abort" }
	| { kind: "paused"; line: number; path: string }
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
	private readonly varScope = new Map<string, EvalValue>();
	private readonly globalScope = new Map<string, EvalValue>();
	private totalSteps = 0;
	private readonly maxIterationsPerLoop: number;
	private readonly maxSteps: number;
	private readonly evalCtx: EvalContext;

	constructor(private readonly doc: GcodeDocument, resolvePath: (path: string) => EvalValue, maxIterationsPerLoop: number, maxSteps: number) {
		this.maxIterationsPerLoop = maxIterationsPerLoop;
		this.maxSteps = maxSteps;
		this.evalCtx = {
			resolvePath,
			resolveVariable: (scope, name) => {
				if (scope === "param") throw new Error(`'param.${name}' is not available — this is a whole-file simulation, not a macro call`);
				const map = scope === "global" ? this.globalScope : this.varScope;
				if (!map.has(name)) throw new Error(`'${scope}.${name}' is not defined`);
				return map.get(name) as EvalValue;
			},
		};
	}

	private pushStep(line: number): "ok" | { kind: "error"; line: number; message: string } {
		this.steps.push({ line });
		this.totalSteps++;
		if (this.totalSteps > this.maxSteps) {
			return { kind: "error", line, message: `Execution exceeded the ${this.maxSteps}-step budget` };
		}
		return "ok";
	}

	/** Evaluates an `if`/`elif`/`while` line's condition. Returns the boolean, or the `Signal` to
	 *  propagate (paused/error) when it couldn't be evaluated. */
	private evalCondition(line: number): { ok: true; value: boolean } | Signal {
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
		return { ok: true, value: outcome.value };
	}

	/** Executes a `var`/`global`/`set` line's assignment against the running variable scopes. Returns
	 *  the `Signal` to propagate on failure, or `null` on success. */
	private execAssignment(line: number): Signal | null {
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
		const map = assignment.scope === "global" ? this.globalScope : this.varScope;
		if (assignment.form === "set" && !map.has(assignment.name)) {
			return { kind: "error", line, message: `'${assignment.scope}.${assignment.name}' is not defined` };
		}
		map.set(assignment.name, outcome.value);
		return null;
	}

	/** Ordinary (non-block-keyword) lines in `[from, toExclusive)`: comments/blanks are skipped,
	 *  commands/fields/unrecognised lines are recorded as steps, and `break`/`continue`/`abort` end the
	 *  range early with the matching `Signal`. `if`/`elif`/`else`/`while` never appear here — the
	 *  caller (`execBlockList`) only calls this on the gaps BETWEEN block-tree nodes. */
	private execPlainLines(from: number, toExclusive: number): Signal {
		for (let line = from; line < toExclusive; line++) {
			const docLine = this.doc.lines[line]!;
			if (docLine.kind === "comment" || docLine.kind === "blank") continue;

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
						const r = this.pushStep(line);
						if (r !== "ok") return r;
						return { kind: "abort" };
					}
					case "var":
					case "global":
					case "set": {
						const sig = this.execAssignment(line);
						if (sig !== null) return sig; // paused/error - this line never completes, not a step
						const r = this.pushStep(line);
						if (r !== "ok") return r;
						continue;
					}
					default: {
						// "skip" (a documented no-op) and "echo" (its message text doesn't affect control
						// flow, see module doc comment) just record a step like any other line.
						const r = this.pushStep(line);
						if (r !== "ok") return r;
						continue;
					}
				}
			}

			const r = this.pushStep(line);
			if (r !== "ok") return r;
		}
		return { kind: "fell-through" };
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
					&& (blocks[j]!.keyword === "if" || blocks[j]!.keyword === "elif" || blocks[j]!.keyword === "else")
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
						const sig = this.execBlockList(arm.children, arm.line + 1, arm.endLine + 1);
						if (sig.kind !== "fell-through") return sig;
					} else {
						const cond = this.evalCondition(arm.line);
						if (!("ok" in cond)) return cond; // paused/error - this line never completes, not a step
						const r = this.pushStep(arm.line);
						if (r !== "ok") return r;
						if (cond.value) {
							resolvedArm = true;
							const sig = this.execBlockList(arm.children, arm.line + 1, arm.endLine + 1);
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
					const r = this.pushStep(block.line);
					if (r !== "ok") return r;
					if (!cond.value) break;
					iterations++;
					if (iterations > this.maxIterationsPerLoop) {
						return { kind: "error", line: block.line, message: `'while' loop exceeded ${this.maxIterationsPerLoop} iterations — this simulator caps loops RRF itself doesn't` };
					}
					const sig = this.execBlockList(block.children, block.line + 1, block.endLine + 1);
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
	const walker = new Walker(doc, options.resolvePath, maxIterationsPerLoop, maxSteps);
	return walker.run(startLine, endLine);
}
