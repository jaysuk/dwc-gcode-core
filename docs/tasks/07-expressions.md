# 07 — Expression syntax (parse, never evaluate)

**Status: Done**, with one deferred item (the automated wiki-examples extraction script — a curated,
hand-picked set of real wiki expressions is tested instead, same call as task 05 made for its own
wiki corpus). See Findings.

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

## Findings (2026-09-14, implementation)

- **Both name tables come from ONE line each in source**, not scattered `case` statements — RRF
  defines them via a macro: `NamedEnum(NamedConstant, unsigned int, _false, iterations, line, _null,
  pi, _result, _true, input);` (line 80) and `NamedEnum(Function, unsigned int, abs, acos, ..., take,
  tan, vector);` (line 81), both in `ExpressionParser.cpp`. `scripts/build-expr-tables.mjs` fetches
  that exact file at `RRF_BASELINE` via `gh api` (no local RRF clone needed — matches
  `rrf-triage.mjs`'s own convention) and regex-extracts both lines, so a baseline bump regenerates
  `src/expr/tables.ts` from source rather than drifting from a hand-typed copy. Cross-checked against
  `@duet3d/monacotokens@3.7.0-rc.1`'s `expressions.json`: **identical** in both directions — recorded
  in `docs/wiki-discrepancies.md` even though nothing was found, since a clean check is still worth
  not re-doing.
- **`^` is general `Concat`, not exponentiation, and not array-only** — read `ExpressionParser::
  Concat` directly: only when BOTH operands are arrays does it produce array concatenation; for
  anything else it stringifies both sides (`AppendAsString`) and joins them. This resolves the task's
  own "check whether `^` also applies to strings" trap: yes, unconditionally, for any non-array pair.
- **`NumericConverter` (number-literal grammar) isn't vendored in the RepRapFirmware checkout** —
  it lives in the separate `Duet3D/RRFLibraries` repo. Found via `gh api search/code` (a plain path
  guess would have silently failed), fetched directly by commit SHA. Confirmed grammar: `0x`+hex
  digits or `0b`+binary digits (mutually exclusive with a fraction/exponent — `options &=
  ~AcceptFloat` the moment either prefix is seen), else decimal digits with an optional `.digits`
  fraction and an optional signed `[eE]` exponent.
- **A deliberate scope narrowing, documented in the parser's own comment, not silently applied**:
  RRF's real grammar allows postfix `[index]` on ANY expression (`ParseInternal`'s own trailing-
  index loop, applied after whatever `case` produced `val` — a parenthesised expression, a function
  call's result, a string literal), not just on an identifier path. This parser only supports
  `[index]` as part of building a `path` node (`move.axes[0]`, by far the common real case); indexing
  a non-path result (`(a+b)[0]`, `"x"[0]`, `foo()[0]`) is not parsed as an index at all — the `[`
  is left for the top-level trailing-content check to flag as an error, rather than silently
  mis-parsed. The task's own `ExprNode` schema has no generic "index of an arbitrary node" variant to
  extend into; adding one wasn't justified for a construct this obscure in real macros.
- **`exists()` is also narrower here than in RRF**: source parses its argument via a special,
  recursive `ParseIdentifierExpression` call (requiring an identifier-like reference, and accepting a
  leading `#`), not a general expression. This parser treats `exists(...)` as an ordinary call with
  one general-expression argument — simpler, and this package doesn't validate argument *kinds*
  against a function's real signature anyway (see "Out of scope").
- **`job.file.customInfo.` is a fourth de-facto "scope" prefix in source** (`GetPrintMonitor().
  GetCustomInfoForReading()`), alongside `var.`/`global.`/`param.`. Not treated specially here: it's
  syntactically just a dotted object-model path like any other, and the task's own `variables` field
  is only for the three real variable scopes — a `job.file.customInfo.X` reference correctly shows up
  in `objectModelPaths` instead, which is the accurate place for it.
- **The wiki-examples extraction script (`scripts/extract-wiki-examples.mjs`) was not built** —
  same call task 05 made for its own corpus. Instead, `test/expr.test.ts`'s "real wiki expressions"
  suite hand-curates ~35 genuine `{...}` bodies pulled directly from `Gcode_meta_commands.md` (pinned
  at commit `235a5a8`, fetched via `gh api`), explicitly excluding two false positives that are the
  wiki's OWN Markdown/HTML syntax (`{.is-info}`, an admonition-box marker; `{target=_blank}`, a link
  attribute) rather than silently mis-testing them as RRF expressions.
