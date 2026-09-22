/**
 * Evaluates the AST `expr/parse.ts` produces — that module deliberately never evaluates anything
 * ("no object model, no variable values", its own doc comment). This module is the practical subset
 * of RRF's real evaluator (`ExpressionParser::Evaluate`, 3.7.0-rc.1) needed to actually run a
 * condition: comparisons, short-circuit booleans, arithmetic, and the deterministic math functions.
 * Deliberately NOT a complete implementation of RRF's ~31 functions — `fileread`/`fileexists`/
 * `random`/`datetime`/`exists`/`find`/`take`/`drop`/`vector` all need either file IO, entropy, wall
 * clock, or macro-call semantics this package has no model of, and are left as clean "not supported"
 * errors rather than guessed at. Extend `FUNCTIONS` below when a real file needs one of them.
 *
 * The one piece of state this module can't supply itself is object-model VALUES — `sensors.gpIn[0]
 * .value` means nothing without a live machine (or a simulated one). `EvalContext.resolvePath` is the
 * seam: a caller wired to a real object model returns a real value; a caller simulating execution
 * (this package's own `execute.ts`, or a plugin prompting a user for a hypothetical sensor reading)
 * returns whatever it has, or throws `UnresolvedPathError` to signal "no value available yet" — a
 * distinct, catchable outcome from a genuine evaluation error, so a caller can tell "ask the user"
 * apart from "this expression is wrong".
 */

import type { ExprNode } from "./parse.js";

export type EvalValue = number | string | boolean | null | ReadonlyArray<EvalValue>;

export type EvalVariableScope = "var" | "global" | "param";

export interface EvalContext {
	/** Resolve a fully-concrete object-model path (every index already substituted with a real
	 *  number, e.g. `"sensors.gpIn[0].value"`, never `"sensors.gpIn[].value"`) to a value. Throw
	 *  {@link UnresolvedPathError} when the path is well-formed but its value isn't known without more
	 *  information (the live/hardware-dependent case); throw a plain `Error` (or let one propagate)
	 *  for a path that's simply wrong. */
	resolvePath(path: string): EvalValue;
	/** Resolve a `var`/`global`/`param`-scoped variable's current value by its bare name (no scope
	 *  prefix, no index — indexing is applied afterwards by this module). Throw for an undefined
	 *  variable; RRF itself treats that as a hard error, not a soft "no value yet". */
	resolveVariable(scope: EvalVariableScope, name: string): EvalValue;
	/** Backs RRF's `exists(path)` for an object-model path argument — true when the path is
	 *  structurally present (regardless of whether its VALUE is known), false otherwise. Distinct from
	 *  `resolvePath`: `exists()` is a presence check RRF answers without erroring on an unresolvable
	 *  value ("we can use expressions such as `if {a.b == null || a.b.c == 1}`", RRF's own
	 *  `ParseIdentifierExpression` doc comment). Optional — when omitted, `exists()` on an
	 *  object-model-path argument is a clean "not supported" error rather than a guess; `exists()` on a
	 *  plain `var`/`global` reference works either way (it only needs `resolveVariable` not to throw). */
	pathExists?(path: string): boolean;
	/** Resolves RRF's four execution-state named constants — `result` (the last command's completion
	 *  status: 0 ok, 1 warning, -1 a cancelled `M291` — see `execute.ts`'s own message-box handling),
	 *  `input` (the value/choice from the last blocking `M291`), `line` (the current source line
	 *  number) and `iterations` (the innermost enclosing `while` loop's 0-based iteration count).
	 *  Meaningless outside an active simulation, so — unlike `true`/`false`/`null`/`pi`, always
	 *  available — this is optional and context-supplied: omit it (or throw) to leave these as a clean
	 *  "not supported" error rather than a guess. `execute.ts`'s `walkExecution` always supplies a
	 *  working implementation, since it tracks all four unconditionally regardless of any option. */
	resolveExecutionConstant?(name: "result" | "input" | "line" | "iterations"): EvalValue;
}

/** Thrown by `EvalContext.resolvePath` for a path whose value depends on information the caller
 *  doesn't have yet (a live sensor reading, an input pin, …) — caught at the top of
 *  {@link evaluateExpression} and surfaced as `{ ok: false, kind: "unresolved-path" }` rather than a
 *  generic error, so callers can distinguish "pause and ask" from "this is broken". */
export class UnresolvedPathError extends Error {
	constructor(public readonly path: string) {
		super(`Unresolved object-model path: ${path}`);
		this.name = "UnresolvedPathError";
	}
}

/** A genuine evaluation failure — wrong type to an operator, unknown function, undefined variable,
 *  malformed AST node. Distinct from {@link UnresolvedPathError}: this can never be resolved by
 *  supplying a value, only by fixing the expression. */
export class EvalError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvalError";
	}
}

export type EvalOutcome =
	| { ok: true; value: EvalValue }
	| { ok: false; kind: "unresolved-path"; path: string }
	| { ok: false; kind: "error"; message: string };

function typeName(v: EvalValue): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return "array";
	return typeof v;
}

function expectNumber(v: EvalValue, what: string): number {
	if (typeof v !== "number") throw new EvalError(`${what} must be a number, got ${typeName(v)}`);
	return v;
}
function expectBoolean(v: EvalValue, what: string): boolean {
	if (typeof v !== "boolean") throw new EvalError(`${what} must be a boolean, got ${typeName(v)}`);
	return v;
}

function stringify(v: EvalValue): string {
	if (v === null) return "null";
	if (Array.isArray(v)) return `[${v.map(stringify).join(",")}]`;
	return String(v);
}

// ── functions — the deterministic, dependency-free subset ──────────────────────────────────────────
//
// Every entry here takes already-evaluated `EvalValue` arguments (the AST's own `args` are evaluated
// by the caller before dispatch) and returns a value or throws EvalError. `max`/`min` are the only
// variadic ones (a single array arg, or 2+ scalars — `expr/tables.ts`'s VARIADIC_FUNCTIONS) so they're
// handled separately in `evalCall`, not through this table.

type UnaryMathFn = (x: number) => number;
const UNARY_MATH_FUNCTIONS: ReadonlyMap<string, UnaryMathFn> = new Map<string, UnaryMathFn>([
	["abs", Math.abs], ["ceil", Math.ceil], ["floor", Math.floor], ["round", Math.round],
	["sqrt", Math.sqrt], ["square", (x) => x * x], ["sin", Math.sin], ["cos", Math.cos], ["tan", Math.tan],
	["asin", Math.asin], ["acos", Math.acos], ["atan", Math.atan], ["exp", Math.exp], ["log", Math.log],
	["degrees", (x) => (x * 180) / Math.PI], ["radians", (x) => (x * Math.PI) / 180],
]);

function evalCall(name: string, args: ReadonlyArray<EvalValue>): EvalValue {
	const unary = UNARY_MATH_FUNCTIONS.get(name);
	if (unary !== undefined) {
		if (args.length !== 1) throw new EvalError(`'${name}' takes exactly one argument, got ${args.length}`);
		return unary(expectNumber(args[0], `'${name}''s argument`));
	}
	switch (name) {
		case "isnan":
			return Number.isNaN(expectNumber(args[0], "'isnan''s argument"));
		case "mod": {
			const a = expectNumber(args[0], "'mod''s first argument");
			const b = expectNumber(args[1], "'mod''s second argument");
			return a % b;
		}
		case "pow": {
			const a = expectNumber(args[0], "'pow''s first argument");
			const b = expectNumber(args[1], "'pow''s second argument");
			return Math.pow(a, b);
		}
		case "atan2": {
			const y = expectNumber(args[0], "'atan2''s first argument");
			const x = expectNumber(args[1], "'atan2''s second argument");
			return Math.atan2(y, x);
		}
		case "max":
		case "min": {
			const pick = name === "max" ? Math.max : Math.min;
			const values = args.length === 1 && Array.isArray(args[0])
				? (args[0] as ReadonlyArray<EvalValue>)
				: args;
			if (values.length === 0) throw new EvalError(`'${name}' needs at least one value`);
			return pick(...values.map((v) => expectNumber(v, `'${name}''s argument`)));
		}
		case "vector": {
			// vector(numElements, elementValue) - ExpressionParser.cpp's own comment on Function::vector.
			const n = expectNumber(args[0], "'vector''s first argument");
			if (!Number.isInteger(n) || n < 0) throw new EvalError("'vector''s first argument must be a non-negative integer");
			const fill = args[1];
			return Array.from({ length: n }, () => fill);
		}
		case "take": {
			// take(arrayOrString, n): the first min(length, n) elements/characters - EvaluateTake.
			const base = args[0];
			const n = expectTakeDropCount(args[1], "take");
			if (typeof base === "string") return base.slice(0, n);
			if (Array.isArray(base)) return base.slice(0, n);
			throw new EvalError("'take''s first argument must be an array or a string");
		}
		case "drop": {
			// drop(arrayOrString, n): everything AFTER the first min(length, n) elements/characters - EvaluateDrop.
			const base = args[0];
			const n = expectTakeDropCount(args[1], "drop");
			if (typeof base === "string") return base.slice(n);
			if (Array.isArray(base)) return base.slice(n);
			throw new EvalError("'drop''s first argument must be an array or a string");
		}
		case "find": {
			// find(string, charOrSubstring): 0-based index of the first match, or -1 - SetFindResult.
			// RRF's own comment: "find() on arrays is not yet implemented but may be in future".
			const base = args[0];
			const needle = args[1];
			if (typeof base !== "string") throw new EvalError("'find''s first argument must be a string");
			if (typeof needle !== "string") throw new EvalError("'find''s second argument must be a character or a string");
			return base.indexOf(needle);
		}
		default:
			throw new EvalError(`Function '${name}' is not supported by this simulator yet`);
	}
}

function expectTakeDropCount(v: EvalValue, fnName: string): number {
	const n = expectNumber(v, `'${fnName}''s second argument`);
	if (!Number.isInteger(n) || n < 0) throw new EvalError(`'${fnName}''s second argument must be a non-negative integer`);
	return n;
}

// ── path resolution ─────────────────────────────────────────────────────────────────────────────────

interface PathNode { root: string; segments: ReadonlyArray<string | ExprNode>; }

const VARIABLE_SCOPES: ReadonlyArray<EvalVariableScope> = ["var", "global", "param"];

function evalVariablePath(node: PathNode, scope: EvalVariableScope, ctx: EvalContext): EvalValue {
	const name = node.segments[1];
	if (typeof name !== "string") throw new EvalError(`Malformed ${scope} reference`);
	let value = ctx.resolveVariable(scope, name);
	for (let i = 2; i < node.segments.length; i++) {
		const seg = node.segments[i];
		if (typeof seg === "string") {
			throw new EvalError(`Field access on variable '${name}' is not supported`);
		}
		const idx = Math.trunc(expectNumber(evalNode(seg, ctx), `'${name}''s index`));
		if (!Array.isArray(value)) throw new EvalError(`'${name}' is not an array — cannot index it`);
		if (idx < 0 || idx >= value.length) throw new EvalError(`Index ${idx} is out of range for '${name}'`);
		value = value[idx];
	}
	return value;
}

/** Builds the fully-concrete object-model path string (every index substituted with a real,
 *  evaluated number, e.g. `"move.axes[0].homed"`), shared by `evalObjectModelPath` (which then
 *  resolves it to a value) and `evalExists` (which only needs the path ITSELF, never a value). */
function buildConcretePath(node: PathNode, ctx: EvalContext): string {
	let concrete = node.root;
	for (let i = 1; i < node.segments.length; i++) {
		const seg = node.segments[i];
		if (typeof seg === "string") {
			concrete += `.${seg}`;
		} else {
			const idx = Math.trunc(expectNumber(evalNode(seg, ctx), "Array index"));
			concrete += `[${idx}]`;
		}
	}
	return concrete;
}

function evalObjectModelPath(node: PathNode, ctx: EvalContext): EvalValue {
	return ctx.resolvePath(buildConcretePath(node, ctx));
}

function evalPath(node: ExprNode & { type: "path" }, ctx: EvalContext): EvalValue {
	const scope = VARIABLE_SCOPES.find((s) => node.root === s);
	if (scope !== undefined && typeof node.segments[1] === "string") {
		return evalVariablePath(node, scope, ctx);
	}
	return evalObjectModelPath(node, ctx);
}

/**
 * RRF's `exists(path)` — special-cased in real RRF too (`ExpressionParser::ParseExpression`'s own
 * `if (func == Function::exists)` branch, taking a different code path than every other function
 * BEFORE its argument is read) because it answers "is this structurally present", not "what's its
 * value" — a path can exist and still be unresolvable offline. Takes the raw, unevaluated argument
 * node rather than going through `evalCall`'s normal pre-evaluated-args dispatch, since evaluating an
 * object-model path argument normally would defeat the point (it would throw/pause exactly when
 * `exists()` is meant to answer without doing that).
 */
function evalExists(node: ExprNode & { type: "call" }, ctx: EvalContext): boolean {
	if (node.args.length !== 1) throw new EvalError("'exists' takes exactly one argument");
	const arg = node.args[0]!;
	if (arg.type !== "path") throw new EvalError("'exists' needs an identifier or object-model path, not a general expression");
	const scope = VARIABLE_SCOPES.find((s) => arg.root === s);
	if (scope !== undefined && typeof arg.segments[1] === "string") {
		try {
			ctx.resolveVariable(scope, arg.segments[1]);
			return true;
		} catch {
			return false;
		}
	}
	if (ctx.pathExists === undefined) {
		throw new EvalError("'exists' on an object-model path needs schema information this context wasn't given");
	}
	return ctx.pathExists(buildConcretePath(arg, ctx));
}

// ── operators ────────────────────────────────────────────────────────────────────────────────────────

function valuesEqual(a: EvalValue, b: EvalValue): boolean {
	if (Array.isArray(a) || Array.isArray(b)) throw new EvalError("Cannot compare arrays");
	return a === b;
}

function compare(op: string, a: EvalValue, b: EvalValue): boolean {
	if (op === "=" || op === "==") return valuesEqual(a, b);
	if (op === "!=") return !valuesEqual(a, b);
	// Ordering comparisons: RRF compares like-typed numbers or strings; this package doesn't attempt
	// RRF's full numeric/string coercion matrix (out of scope for the "practical subset") — reject a
	// mismatched or unordered pair loudly instead of guessing at a coercion.
	if (typeof a === "number" && typeof b === "number") {
		switch (op) {
			case "<": return a < b;
			case "<=": return a <= b;
			case ">": return a > b;
			case ">=": return a >= b;
		}
	}
	if (typeof a === "string" && typeof b === "string") {
		switch (op) {
			case "<": return a < b;
			case "<=": return a <= b;
			case ">": return a > b;
			case ">=": return a >= b;
		}
	}
	throw new EvalError(`Cannot compare ${typeName(a)} and ${typeName(b)} with '${op}'`);
}

function evalBinary(node: ExprNode & { type: "binary" }, ctx: EvalContext): EvalValue {
	const { op } = node;
	// '&'/'&&' and '|'/'||' are RRF's short-circuit boolean operators, same priority — evaluating the
	// right side of a false AND (or a true OR) must not happen, since it may reference a live path
	// that's genuinely irrelevant to the outcome (matches RRF's own short-circuit evaluation).
	if (op === "&" || op === "&&") {
		if (!expectBoolean(evalNode(node.left, ctx), "'&&''s left side")) return false;
		return expectBoolean(evalNode(node.right, ctx), "'&&''s right side");
	}
	if (op === "|" || op === "||") {
		if (expectBoolean(evalNode(node.left, ctx), "'||''s left side")) return true;
		return expectBoolean(evalNode(node.right, ctx), "'||''s right side");
	}
	if (op === "^") {
		const left = evalNode(node.left, ctx);
		const right = evalNode(node.right, ctx);
		if (Array.isArray(left) && Array.isArray(right)) return [...left, ...right];
		return stringify(left) + stringify(right);
	}
	if (op === "=" || op === "==" || op === "!=" || op === "<" || op === "<=" || op === ">" || op === ">=") {
		return compare(op, evalNode(node.left, ctx), evalNode(node.right, ctx));
	}
	const left = expectNumber(evalNode(node.left, ctx), `'${op}''s left side`);
	const right = expectNumber(evalNode(node.right, ctx), `'${op}''s right side`);
	switch (op) {
		case "+": return left + right;
		case "-": return left - right;
		case "*": return left * right;
		case "/": return left / right;
		default: throw new EvalError(`Unsupported operator '${op}'`);
	}
}

function evalNode(node: ExprNode, ctx: EvalContext): EvalValue {
	switch (node.type) {
		case "number": return node.value;
		case "string": return node.value;
		case "array": return node.items.map((i) => evalNode(i, ctx));
		case "path": return evalPath(node, ctx);
		case "call":
			if (node.name === "exists") return evalExists(node, ctx);
			return evalCall(node.name, node.args.map((a) => evalNode(a, ctx)));
		case "unary": {
			if (node.op === "!") return !expectBoolean(evalNode(node.operand, ctx), "'!''s operand");
			if (node.op === "#") {
				// Length/count operator - RRF's ApplyLengthOperator (ExpressionParser.cpp:1589): a
				// string's length, or an array's element count (object-model-backed or a plain/variable
				// one - this evaluator has no such distinction, both are just EvalValue arrays).
				// Anything else is a real RRF error, not a coercion (e.g. `#5` is invalid, not `5`).
				const v = evalNode(node.operand, ctx);
				if (typeof v === "string" || Array.isArray(v)) return v.length;
				throw new EvalError(`'#' requires a string or array operand, got ${typeName(v)}`);
			}
			const v = expectNumber(evalNode(node.operand, ctx), `unary '${node.op}''s operand`);
			return node.op === "-" ? -v : v;
		}
		case "binary": return evalBinary(node, ctx);
		case "ternary": {
			const test = expectBoolean(evalNode(node.test, ctx), "the ternary's condition");
			return evalNode(test ? node.then : node.else, ctx);
		}
		case "constant":
			switch (node.name) {
				case "true": return true;
				case "false": return false;
				case "null": return null;
				case "pi": return Math.PI;
				case "result":
				case "input":
				case "line":
				case "iterations":
					if (ctx.resolveExecutionConstant === undefined) {
						throw new EvalError(`Constant '${node.name}' is not supported by this simulator yet`);
					}
					return ctx.resolveExecutionConstant(node.name);
				default: throw new EvalError(`Constant '${node.name}' is not supported by this simulator yet`);
			}
		case "error":
			throw new EvalError("Cannot evaluate a malformed expression");
	}
}

/** Evaluates a parsed expression's AST against `ctx`. Never throws — `UnresolvedPathError` and
 *  `EvalError` are caught and converted into the corresponding `EvalOutcome`; any other thrown value
 *  is a programmer error in `ctx` itself and is allowed to propagate. */
export function evaluateExpression(ast: ExprNode, ctx: EvalContext): EvalOutcome {
	try {
		return { ok: true, value: evalNode(ast, ctx) };
	} catch (e) {
		if (e instanceof UnresolvedPathError) return { ok: false, kind: "unresolved-path", path: e.path };
		if (e instanceof EvalError) return { ok: false, kind: "error", message: e.message };
		throw e;
	}
}
