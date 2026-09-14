# 07 — Expression syntax (parse, never evaluate)

## The gap

`{…}` is kept as opaque text. Nothing can report a malformed expression, list the object-model paths
or variables a file depends on (task 12 needs these to find object-model changes that break a macro),
or validate a function name. Meta lines (`if`, `elif`, `while`, `var`, `global`, `set`, `echo`,
`abort`) carry whole-line expressions and are equally opaque.

## Sources

- RRF `3.7.0-rc.1` `src/GCodes/GCodeBuffer/ExpressionParser.cpp` and `.h`: the grammar — literals
  (numbers in every form it accepts, strings and their escape rule, any character literals), array
  literals, operators and their **precedence**, the ternary, unary operators, any length/count
  operator, function-call parsing and the **function-name table**, named constants, the
  `var.`/`global.`/`param.` scopes, object-model path syntax (dots, `[index]`), and `^` (array
  concatenation from 3.7).
- `@duet3d/monacotokens@3.7.0-rc.1` `expressions/expressions.json` (`functions`, `constants`,
  `scopes`, `objectModel`) — cross-check only; **source wins**.
- Wiki `Gcode_meta_commands.md` expression sections.

## Decisions

- **Syntax only.** No evaluation, no object-model access.
- **Tolerant parser**: always returns an AST plus a list of errors with spans; never throws.
- The function and constant tables are generated from `ExpressionParser.cpp` into
  `src/expr/tables.ts` by `scripts/build-expr-tables.mjs`, citing the source line for each entry.
- Disagreements with `expressions.json` go in `docs/wiki-discrepancies.md` (labelled
  "monacotokens vs source").

## API

```ts
export type ExprNode =
	| { type: "number"; value: number; raw: string; start: number; end: number }
	| { type: "string"; value: string; start: number; end: number }
	| { type: "array"; items: ReadonlyArray<ExprNode>; start: number; end: number }
	| { type: "path"; root: string; segments: ReadonlyArray<string | ExprNode>; start: number; end: number } // OM path, var./global./param.
	| { type: "call"; name: string; args: ReadonlyArray<ExprNode>; start: number; end: number }
	| { type: "unary"; op: string; operand: ExprNode; start: number; end: number }
	| { type: "binary"; op: string; left: ExprNode; right: ExprNode; start: number; end: number }
	| { type: "ternary"; test: ExprNode; then: ExprNode; else: ExprNode; start: number; end: number }
	| { type: "constant"; name: string; start: number; end: number }
	| { type: "error"; start: number; end: number };
export interface ParsedExpression {
	ast: ExprNode;
	errors: ReadonlyArray<{ code: string; message: string; start: number; end: number }>;
	objectModelPaths: ReadonlyArray<{ path: string; start: number; end: number }>;  // indices normalised to []
	variables: ReadonlyArray<{ scope: "var" | "global" | "param"; name: string; start: number; end: number }>;
	functions: ReadonlyArray<{ name: string; known: boolean; start: number; end: number }>;
}
export function parseExpression(text: string, offset?: number): ParsedExpression; // offset makes spans absolute
```

The document model gains a lazy accessor, `expressionsOfLine(doc, line)`, covering every `{…}`
parameter and the expression part of each meta line.

## Steps

1. Read `ExpressionParser.cpp` end to end. Write the grammar, precedence table included, as a comment
   block at the top of `src/expr/parse.ts`, each rule cited to its function.
2. Generate `tables.ts`; diff it against `expressions.json`; record differences.
3. Implement the parser; wire it into the document model.

## Tests

- Precedence: one test per level of the source table.
- Every function in the table parses as a call. An unknown function name is flagged `known: false`;
  it's an error only if RRF rejects it at parse time (check — it may be a run-time error; mirror RRF).
- Corpus: every `{…}` in the wiki examples and in `Gcode_meta_commands.md` examples parses with zero
  errors, or is listed in a commented known-bad list with the reason.
- Path normalisation: `move.axes[0].homed` → `move.axes[].homed`.

## Acceptance

Grammar and tables cited; corpora clean; `objectModelPaths` and `variables` correct on the wiki's
own examples.

## Traps

- Take named values that are only valid in some contexts (`iterations`, `line`, `result`, `input`
  and the like) from source, not from memory.
- Check whether `^` also applies to strings in source.

## Out of scope

Evaluation; type-checking against the object model (task 11 provides the schema, task 14 the rule).
