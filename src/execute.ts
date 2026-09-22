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

import { EvalError, evaluateExpression, type EvalContext, type EvalValue } from "./expr/evaluate.js";
import type { Block, GcodeDocument } from "./document.js";
import { expressionsOfLine } from "./document.js";
import { parseAssignment } from "./meta.js";
import { objectModelPath } from "./objectmodel/schema.js";

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
	/** When given, every concrete object-model path a condition references is checked against
	 *  `objectmodel/schema.ts` at this RRF version BEFORE `resolvePath` is even called — a path that
	 *  doesn't exist at that version (a typo, or a path added/removed since) is a hard `"error"`, not a
	 *  `"paused"` — asking a caller to guess a value for a path that doesn't exist doesn't make sense.
	 *  Also backs `exists()` for an object-model-path argument (`EvalContext.pathExists`); without this
	 *  option `exists()` on such a path is a clean "not supported" error instead. Must be one of
	 *  `OBJECT_MODEL_VERSIONS`' tracked versions (`objectmodel/versions.js`) — an unknown/untracked
	 *  version surfaces as an ordinary `"error"` outcome, not a thrown exception. */
	objectModelVersion?: string;
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
	private readonly evalCtx: EvalContext;

	constructor(
		private readonly doc: GcodeDocument,
		resolvePath: (path: string) => EvalValue,
		maxIterationsPerLoop: number,
		maxSteps: number,
		objectModelVersion: string | undefined,
	) {
		this.maxIterationsPerLoop = maxIterationsPerLoop;
		this.maxSteps = maxSteps;
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
				if (scope === "param") throw new EvalError(`'param.${name}' is not available — this is a whole-file simulation, not a macro call`);
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
			this.varStack.pop();
		}
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

		if (assignment.scope === "global") {
			if (assignment.form === "set" && !this.globalScope.has(assignment.name)) {
				return { kind: "error", line, message: `'global.${assignment.name}' is not defined` };
			}
			this.globalScope.set(assignment.name, outcome.value);
			return null;
		}

		// "local" (var) scope. 'declare' (var NAME = ...) always creates it in the CURRENT (innermost)
		// frame, shadowing any outer var of the same name - matches ordinary block-scoped declaration.
		if (assignment.form === "declare") {
			this.varStack[this.varStack.length - 1]!.set(assignment.name, outcome.value);
			return null;
		}
		// 'set' (set var.NAME = ...) mutates an EXISTING var - search innermost-first and update
		// whichever frame actually has it, not always the current one.
		for (let i = this.varStack.length - 1; i >= 0; i--) {
			if (this.varStack[i]!.has(assignment.name)) {
				this.varStack[i]!.set(assignment.name, outcome.value);
				return null;
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
						const r = this.pushStep(arm.line);
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
					const r = this.pushStep(block.line);
					if (r !== "ok") return r;
					if (!cond.value) break;
					iterations++;
					if (iterations > this.maxIterationsPerLoop) {
						return { kind: "error", line: block.line, message: `'while' loop exceeded ${this.maxIterationsPerLoop} iterations — this simulator caps loops RRF itself doesn't` };
					}
					const sig = this.execBlock(block.children, block.line + 1, block.endLine + 1);
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
	const walker = new Walker(doc, options.resolvePath, maxIterationsPerLoop, maxSteps, options.objectModelVersion);
	return walker.run(startLine, endLine);
}
