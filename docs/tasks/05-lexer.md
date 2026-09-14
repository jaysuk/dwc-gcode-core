# 05 — Lexer rewrite to RRF's `FindParameters` semantics

## The gap

`src/lex.ts` (`tokenise`, line 63) and `src/params.ts` (`parseParams`, line 29) assume **one command
per line** and **whitespace-delimited parameter values**. RRF does neither. Reproduced against v0.5.0
(roadmap Part 1, §A):

| Input | v0.5.0 | RRF |
|---|---|---|
| `G90 G1 X10` | `G90` with params `G=1`, `X=10` | two commands: `G90`, then `G1 X10` |
| `G1X10Y20` | `X="10Y20"` | `X=10`, `Y=20` |
| `N10 M92 E420*55` | `E="420*55"` | `E=420`; `*55` is a checksum |
| `G1 'a10 X5` | no params at all | lowercase axis `a`=10, `X`=5 |
| `M117 S{"}"} X1` | brace scan ends inside the string | quotes honoured inside braces |
| `(note) G1 X1` in CNC mode | `unrecognised` | bracketed comment, then `G1 X1` |
| `M117 Hello World` | phantom params `H`, `W` | one unquoted string argument |

## Sources (read these first — they decide every rule below)

All at RRF `3.7.0-rc.1`, `src/GCodes/GCodeBuffer/StringParser.cpp`:
- `StringParser::Put` — the character state machine: `parseNotStarted` (indent, `N` line number),
  `parsingLineNumber`, `parsingWhitespace`, `parsingGCode` (`;` comment; `(` bracketed comment **only
  when `MachineType::cnc` and `braceCount == 0`**; `"` quoted string; `{`/`}` brace count; `*`
  checksum **only when `hadLineNumber && braceCount == 0`**), `parsingBracketedComment`,
  `parsingQuotedString`, `parsingChecksum`.
- `StringParser::DecodeCommand` (~line 995) — command letter/number: optional `-`, digits, one
  fractional digit; the `T{` special case. Already implemented correctly in `lex.ts` — keep it.
- `StringParser::FindParameters` (~line 1120) — **the rule**: scanning from `parameterStart` outside
  quotes and braces, a `'` escapes the next letter as a lowercase axis (valid only for `A` up to
  `HighestAxisLetter`); an unquoted `G` or `M` **ends the command** (the next one starts there —
  `SetFinished`, ~line 1221); any other letter `A`–`Z` marks a parameter, **except `E` immediately
  after a digit** (an exponent — unless it's the first character of the parameters).
- `GetUnprecedentedString` / `GetPossiblyQuotedString` call sites across `src/GCodes/GCodes*.cpp` —
  the commands whose argument is the rest of the line rather than letter parameters.
- `src/GCodes/GCodes.h` — `enum class MachineType { fff, laser, cnc }`.
- Wiki `Gcodes.md`, "Multiple commands on a single line": RRF 3.2+ doesn't need the space before a
  second `G`/`M`; a `T` command must be on a line by itself; a macro-invoking command (`G28`, `G29`,
  `G32`, `M98`) must be last on its line.

## Decisions

- **New primary API: `lexLine(raw, options)`** returning every command on the line. `tokenise()` and
  `parseParams()` stay exported, re-implemented as first-command views of `lexLine`, marked
  `@deprecated` in their doc comments — they remain a convenience for single-command callers, but
  must no longer lie about multi-command lines.
- **Machine mode is an input**, default `"fff"`. The lexer doesn't track `M451`/`M452`/`M453` — that
  is line-to-line state and belongs to task 06.
- **Parameter value extent**: a value runs from just after its letter to the start of the next
  parameter letter, `G`/`M`, `;`, bracketed comment, checksum or end of line — trailing whitespace
  excluded. This is the extent RRF's own presence scan implies; a handler reading a float stops
  earlier, but a rewrite must replace exactly this span.
- **Whole-line string commands**: a small cited constant `STRING_ARGUMENT_COMMANDS` in `src/lex.ts`
  (built in step 1). For those the lexer produces `stringArgument` and **no** parameters. Task 10's
  dictionary later becomes the source of truth and this constant is derived from it.
- **Parameter kind** (cheap, syntactic): `"empty"` (letter, no value), `"number"`, `"list"`
  (colon-separated values), `"string"` (quoted), `"expression"` (starts with `{`), `"other"`
  (anything else, e.g. an unquoted `^io1.in`).

## API (implement this shape; extend only if a step proves it necessary)

```ts
export type MachineMode = "fff" | "laser" | "cnc";
export interface LexOptions { machineMode?: MachineMode }

export type ParamKind = "empty" | "number" | "list" | "string" | "expression" | "other";
export interface LexedParam {
	letter: string;          // uppercase, or lowercase when escaped with '
	escapedAxis: boolean;    // true for the 'a form
	value: string;           // raw text, quotes/braces included, trailing whitespace excluded
	kind: ParamKind;
	start: number;           // index of the letter (or of the ') in the raw line
	valueStart: number;
	end: number;             // exclusive
}
export interface LexedCommand {
	letter: "G" | "M" | "T";
	number: number | null;
	code: string;            // as today: "G1", "T-1", "T", "G38.2"
	start: number; end: number;
	params: ReadonlyArray<LexedParam>;
	stringArgument: { value: string; start: number; end: number } | null;
}
export interface LexError { code: string; message: string; start: number; end: number }
export interface LexedLine {
	raw: string;
	indent: number;          // RRF rule, as meta.ts computes it today
	lineNumber: { value: number; start: number; end: number } | null;
	checksum: { value: number; start: number; end: number } | null;
	commands: ReadonlyArray<LexedCommand>;
	comment: { text: string; start: number; end: number } | null;                    // ';' to end of line
	bracketedComments: ReadonlyArray<{ text: string; start: number; end: number }>;  // CNC only
	meta: MetaKeyword | null;  // set when the line is a meta-command (commands is then empty)
	kind: "commands" | "meta" | "comment" | "blank" | "fields" | "unrecognised";
	// "fields": letters/values but no G/M/T command — a Fanuc-style continuation candidate;
	// task 06 decides whether it is one (laser/cnc only)
	errors: ReadonlyArray<LexError>;  // unterminated quote, unbalanced brace, malformed checksum
}
export function lexLine(raw: string, options?: LexOptions): LexedLine;
```

`meta.ts`'s `classifyLine` becomes a thin view over `lexLine` (keep its public shape).

## Steps

1. **Stop point — enumerate whole-line string commands.** At the baseline, find every
   `GetUnprecedentedString` / `GetPossiblyQuotedString` call and the `case` it sits under. `M117`,
   `M550`, `M551` and the filename-taking uses around `M23`/`M28`/`M30`/`M32`/`M36`/`M37`/`M38` are
   expected — confirm each and record the real list in `lex.ts` with file:function citations. If a
   command accepts either a quoted parameter **or** an unprecedented string, find the exact rule RRF
   uses to tell them apart and **report it before implementing it.**
2. Record the benchmark baseline **before changing anything**: add `scripts/bench-lex.mjs`, which
   tokenises and parses parameters for a generated 1,000,000-line file (a mix of `G1 X.. Y.. E..`,
   comments, `M106`, `G92`) and prints lines per second. Run it against the current `dist/` and
   record the number in this file under `## Findings`.
3. Build the corpora:
   - `scripts/extract-wiki-examples.mjs` — pin `Gcodes.md` at a SHA, inspect how example blocks are
     marked up, extract every example line tagged with its `## Gxxx`/`## Mxxx` section, and write
     `test/corpus/wiki-examples.json` (`{ sha, examples: [{ section, line }] }`).
   - Copy the slicer fixtures from `C:\Users\live\Documents\Github\duet-gcode-postprocessor\test\fixtures\`
     into `test/corpus/slicer/` (a read-only copy — don't modify the post-processor repo).
4. Implement `lexLine` following `Put`/`FindParameters` exactly. Keep `findCommentIndex`, but match
   what `Put` does with `;` inside `{…}` (verify in source; don't assume).
5. Re-implement `tokenise`/`parseParams` as first-command views; keep `withBody`, `setParam` and
   `removeParam` working on a single command body using the new extents.
6. Re-implement `classifyLine` on `lexLine`.
7. Run the benchmark again and record the number. It must be at least 80% of the baseline.

## Tests

- `test/lex.test.ts`: every row of the gap table as its own test, plus: `G90G1X10` (no spaces);
  `M104 T1 S200` (T is a parameter, not a command); `T-1 P0`; `G1 X1e3` (E after a digit is an
  exponent → single param `X`); `G1 E1` (E at parameter start is a parameter); `G1 X10 E-2` (E after a
  space is a parameter); `'a` on `M584`; a CNC-mode bracketed comment vs the same line in FFF mode;
  `N10 G1 X1*47` (checksum parsed with correct offsets) vs `G1 X1*47` (no line number — assert
  whatever `Put` does); unterminated quote and unbalanced brace produce `errors`; `echo "a;b"` is meta
  with no comment.
- `test/corpus.test.ts`: every wiki example lexes with zero `errors` **or** is listed in a commented
  `KNOWN_BAD_EXAMPLES` array with the reason (a wiki typo is a finding for
  `docs/wiki-discrepancies.md`, not a lexer bug); every slicer fixture line lexes with zero errors;
  all spans lie inside the line and don't overlap.
- Existing tests all still pass, except those asserting the old wrong behaviour — change those and
  say why in the commit and in `CHANGELOG.md`.

## Acceptance

- Every row of the gap table behaves as RRF does, each with a test that fails on v0.5.0's behaviour.
- `STRING_ARGUMENT_COMMANDS` is cited command by command.
- Benchmark at least 80% of baseline; both numbers recorded.
- Gates green.

## Traps

- `T` is **not** a command terminator in `FindParameters` — only `G` and `M` are.
- The `E`-exponent exception applies to `E` only, and not at the first parameter position.
- Bracketed comments are CNC-only; in FFF and laser modes `(` is an ordinary character.
- Quotes inside braces: mirror the order in which `FindParameters` checks quotes and braces exactly.

## Out of scope

Line-to-line state (machine-mode switching, block nesting, Fanuc continuation) — task 06.
Expression internals — task 07. Per-command parameter validity — task 10.
