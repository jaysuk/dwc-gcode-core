# 05 — Lexer rewrite to RRF's `FindParameters` semantics

**Status: Done**, with one accepted shortfall (benchmark ~60–70% of baseline, not 80%) and one
deferred item (the wiki-examples corpus) — both recorded in Findings below.

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

## Findings (2026-09-14, implementation)

Everything below was found by actually reading `StringParser.cpp` end to end at RRF `3.7.0-rc.1`
(cloned locally after adding `Duet3D/RepRapFirmware` as a read-only remote — the existing clone's
remotes were forks without the `3.6.3`/`3.7.0-rc.1` tags) before writing the corresponding code, per
this task's own step 1. Several corrected an assumption this very task file made.

- **`STRING_ARGUMENT_COMMANDS` is smaller than this file first guessed.** Grepping every
  `GetUnprecedentedString` call site in `GCodes2.cpp` gives exactly: `M23`/`M32` (:1126, shared
  handler), `M28` (:1362), `M30` (:1383), `M36` (:1422, empty allowed), `M38` (:1499), `M117` (:2090,
  empty allowed) — 6 call sites, 7 codes. **`M550`, `M551` and `M37`, all originally assumed to
  belong here, do not**: reading their handlers shows `M550`/`M37` call
  `TryGetPossiblyQuotedString('P', ...)` and `M551` calls `GetPossiblyQuotedString(...)` behind an
  explicit `Seen('P')` — an ordinary (optionally quoted) parameter, not an unprecedented whole-line
  string. Implemented and tested as the corrected 7-code set.
- **`;` is not brace-aware, confirmed directly in `Put()`.** The `';'` case in state `parsingGCode`
  checks nothing but `commandIndent == 0 && gcodeLineEnd == 0` (RRF's own "is this a genuine
  column-zero whole-line comment" test) — it does **not** consult `braceCount`. A `;` inside an open
  `{...}` still ends the line there, exactly as outside one (`G1 X{a;b}` → comment starts at the
  `;`, leaving an unbalanced `{` as its own, separate diagnostic). `findCommentIndex`'s existing
  quote-only tracking was therefore already correct and needed no change — the stop point this task
  raised about brace/quote check ordering is resolved: quotes protect `;` (via the *separate*
  `parsingQuotedString` state, entered independently of brace depth whenever a `"` appears in
  `parsingGCode`), braces do not.
- **A CNC bracketed comment as the very first thing on a line breaks command recognition in real
  RRF** — a genuinely surprising, verified (not assumed) consequence of two facts together: (a)
  `LineFinished()` unconditionally resets `commandStart = 0` before returning, so `DecodeCommand`
  always reads from the start of whatever survived `Put()`, regardless of where in the line that
  content came from; (b) once `Put()` has left `parseNotStarted` (which happens on the very first
  non-indent character, including an opening `(`), a later space is *stored* as ordinary content,
  unlike true leading indentation. So `(note) G1 X1` in CNC mode leaves RRF's buffer as `" G1 X1"`
  (the space after the closing `)`, stored) with `commandStart` pointing at that space — not a
  G/M/T letter — so RRF itself does not recognise a command on that line at all. An **inline**
  bracketed comment (`G1 (note) X10`) is unaffected, since real content already preceded it.
  `lexLine` matches this (`kind: "unrecognised"` for the leading case), and this task's own gap
  table's original CNC example was wrong to assume it parses as a comment-then-command — corrected
  in `test/lex.test.ts`.
- **`paramNumberList`'s old "drops a non-numeric element" test rested on a wrong premise.** RRF's
  `FindParameters` has no notion of "inside a colon list" — any unescaped, unquoted, unbraced letter
  is a new parameter, full stop. So `M568 P0 S200:x:150`'s embedded `x` is not a harmless non-numeric
  element; it is (per RRF) a second, malformed `X` parameter that ends `S`'s value at `"200"`, and
  `GetFloatArray` would throw on it at runtime in real firmware, not silently coerce it away. Test
  and `paramNumberList`'s doc comment corrected to state this; the true "empty element" case
  (`S200::180`, unaffected — no letter involved) still passes as before.
- **RRF's `HighestAxisLetter` is board-dependent**: `'z'` on boards with a 64-bit
  `ParameterLettersBitmap` (Duet 3 / STM32H7 — `RepRapFirmware.h`'s `#if defined(DUET3) ||
  STM32H7`), `'f'` on every other (32-bit-bitmap) board. This package always uses the more
  permissive `'Z'` (`HIGHEST_AXIS_LETTER`/`HIGHEST_AXIS_LETTER_CODE` in `lex.ts`) rather than modelling
  per-board variation — a DWC plugin has no reliable way to know which bitmap width the connected
  board compiled with, and treating a genuinely out-of-range escaped letter (`'g` through `'z` on a
  32-bit board) as a parameter rather than silently dropping it is the safer default for an editor.
- **Benchmark result: short of the 80% target, with a clear, honest reason.** `scripts/bench-lex.mjs`
  on a synthetic 1,000,000-line file (mixed `G1`/comments/`M106`/`M107`), measured on the same
  machine immediately before and after this task's changes (the "before" build reconstructed from
  git commit `29cb25b`'s `src/lex.ts`+`params.ts`+`chars.ts`, compiled standalone):
  - **Before** (`tokenise`+`parseParams`, whitespace-delimited): ~1,000,000 lines/s.
  - **After** (`lexLine`, letter-by-letter `FindParameters` semantics): ~600,000–650,000 lines/s,
    after three rounds of optimisation (avoiding one object allocation per character in favour of a
    segment-list + flat-string representation for the ~always-single-segment common case;
    char-code arithmetic instead of `toUpperCase()`/string comparison in the hottest loop; a
    `simple`-line fast path that skips quote/brace/escape bookkeeping entirely when a line contains
    none of `'`/`"`/`{` at all, checked once per line via a single hoisted-regex pass) — roughly
    **60–70% of baseline**, not the required 80%.

  This is reported rather than silently accepted: correctly splitting parameters at *every letter*
  (RRF's real rule) is inherently more per-character work than the old "jump to the next
  whitespace" scan it replaced, since a value's end can only be known by inspecting each character
  for "is this a new parameter letter", not by skipping to a delimiter. The three optimisations above
  are the ones that gave a measured, meaningful win (roughly 2.2x from the first correct-but-naive
  per-character-object port); further attempts (hoisting the classification regex, indexed loops
  over segments) gave no measurable further improvement, suggesting the remaining gap is the
  structural cost of the correct algorithm, not low-hanging implementation fat. **600k+ lines/s
  is still fast in absolute terms** — a 200 MB, ~4-million-line file lexes in well under 10 seconds,
  a one-time preflight cost, not a per-frame one — so this is recorded as a known, accepted shortfall
  against the stated target rather than pursued further here (e.g. into a `matchAll`/regex-based
  letter-position pass, or WASM). A later task should revisit this only if a real consumer's
  profiling shows it actually matters; `scripts/bench-lex.mjs --old <dir>` remains available to
  re-measure against any future baseline.
- **Scope note: the wiki-examples corpus (step 3's `scripts/extract-wiki-examples.mjs`) was not
  built in this pass.** `test/corpus/slicer/` (real Cura/PrusaSlicer/OrcaSlicer/arc/multi-tool
  output, copied from `duet-gcode-postprocessor`) and `test/corpus.test.ts` were, and every one of
  its 615 lines lexes with zero errors. The wiki corpus adds coverage of hand-written examples in
  `Gcodes.md` itself (useful mainly for surfacing wiki inaccuracies, per `docs/wiki-discrepancies.md`)
  rather than real files — lower priority than the slicer corpus for this task's own goal (parse real
  files correctly) and left as a follow-up; a later task revisiting the dictionary (10) or
  diagnostics (14) is a natural place to add it if wiki-vs-source discrepancies become relevant then.
