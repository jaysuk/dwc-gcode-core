# 06 — Lossless document model; `edit.ts` rebuilt on it

## The gap

There is no whole-file model. Consumers re-tokenise line by line, block structure (`if`/`while`
nesting) isn't represented, machine-mode changes inside a file are ignored, and `src/edit.ts` carries
its **own second parser** (private `parseLine`/`maskQuoted`) with its own bugs:
`parseLines("N10 M92 E420")[0].code === "N10"`, and
`setParam("M572 D0 S{global.pa}", "S", "0.05")` → `M572 D0 S{global.pa} S0.05` (a duplicate `S`).

## Sources

- RRF `StringParser.cpp`: indentation and block state (`commandIndent`, `CheckForMixedSpacesAndTabs`,
  `ProcessConditionalGCode`, the `if`/`elif`/`else`/`while`/`break`/`continue` handlers), and how
  indentation ends a block.
- Wiki `Gcode_meta_commands.md`, blocks and indentation, and the indentation-of-comments rule (RRF
  3.6.0+: a comment line's indent isn't significant — inside our whole window).
- Machine mode: `M451` (FFF), `M452` (laser), `M453` (CNC) — **verify** in RRF `GCodes2.cpp` and cite.
- Fanuc-style continuation: the wiki says that in CNC or laser mode, a line that doesn't start with a
  G, M or T command but has other fields repeats the previous `G0`/`G1`/`G2`/`G3`. Find the wiki
  passage and the implementing code in RRF (search `StringParser` for the saved command / "Fanuc")
  and cite both.

## Decisions

- **A document is an immutable value**; edits return a new document. Nothing mutates in place.
- **Round trip is byte-exact**: `serializeDocument(parseDocument(t)) === t` for every input,
  including mixed/CRLF/lone-CR line endings, a UTF-8 BOM, a missing final newline and trailing
  whitespace.
- **Blocks** are derived, never stored as text: a tree of `{ keyword, line, endLine, children }`
  built from meta lines and indentation, skipping comment and blank lines when deciding where a
  block ends.
- **Machine mode** is tracked per line, from the document's initial mode (option, default `"fff"`)
  through `M451`/`M452`/`M453` lines; each line is lexed in the mode in force when it's read.
- **`edit.ts` keeps its public API and its test file** — `test/edit.test.ts` must still pass,
  changed only for the two bugs above — but is re-implemented on the document model. Its private
  parser is deleted. `setParam` on an existing parameter of kind `"expression"` **throws**
  `UnsafeEditError` instead of appending a duplicate.

## API

```ts
export interface DocumentOptions { machineMode?: MachineMode }
export interface DocumentLine extends LexedLine {
	index: number;             // 0-based line index
	start: number;             // offset of the line in the whole text
	eol: "" | "\n" | "\r\n" | "\r";
	machineMode: MachineMode;  // mode in force when this line was read
	implicitCommand: LexedCommand | null;  // Fanuc continuation, resolved (laser/cnc only)
}
export interface Block { keyword: MetaKeyword; line: number; endLine: number; children: ReadonlyArray<Block> }
export interface DocumentError { code: string; message: string; line: number; start: number; end: number }
export interface GcodeDocument {
	text: string; bom: boolean; lines: ReadonlyArray<DocumentLine>; blocks: ReadonlyArray<Block>;
	errors: ReadonlyArray<DocumentError>;  // lex errors plus structural ones
}
export function parseDocument(text: string, options?: DocumentOptions): GcodeDocument;
export function serializeDocument(doc: GcodeDocument): string;
export interface TextEdit { start: number; end: number; newText: string }
export function applyEdits(doc: GcodeDocument, edits: ReadonlyArray<TextEdit>, options?: DocumentOptions): GcodeDocument;
// Command-level helpers that return TextEdits:
export function editSetParam(doc: GcodeDocument, line: number, command: number, letter: string, value: string): TextEdit;
export function editRemoveParam(doc: GcodeDocument, line: number, command: number, letter: string): TextEdit;
export function editReplaceLine(doc: GcodeDocument, line: number, newText: string): TextEdit;
export function editInsertLines(doc: GcodeDocument, beforeLine: number, lines: ReadonlyArray<string>): TextEdit;
export function editRemoveLine(doc: GcodeDocument, line: number): TextEdit;
```

Structural `DocumentError` codes, each cited to the RRF function that raises the equivalent error:
`elif-without-if`, `else-without-if`, `else-after-else`, `break-outside-loop`,
`continue-outside-loop`, `mixed-indentation` (check whether RRF errors or warns — mirror it), and
`t-not-alone` (a `T` command sharing a line — wiki citation).

## Steps

1. Verify `M451`–`M453` and the Fanuc continuation code in RRF source; cite both in the module.
2. Implement `parseDocument`/`serializeDocument` (lines, EOLs, BOM), machine-mode tracking, blocks.
3. Implement the edit helpers and `applyEdits` (edits must not overlap; sort and apply back to front).
4. Rebuild `edit.ts` on it; delete its private parser.
5. Round-trip corpus test over `test/corpus/slicer/*` and the realistic macro fixtures in
   `test/meta.test.ts`.
6. Extend `scripts/bench-lex.mjs` to `parseDocument` and record the number.

## Tests

- Byte-exact round trip on LF, CRLF, mixed, lone `\r`, BOM, no trailing newline, empty file.
- Blocks: nested `if`/`elif`/`else`/`while` with spaces and with tabs (check how RRF counts a tab);
  comment lines at *lower* indentation inside a block (must not end it); blank lines.
- Each structural error code, with a fixture that fails without the check.
- Machine mode: a file with `M453` half-way — `(...)` is a comment only after it; an `X10 Y20` line
  after `G1` gets `implicitCommand` G1 only in laser/cnc.
- `test/edit.test.ts` passing, plus the two fixed bugs.

## Acceptance

Byte-exact round trip on all corpora; `edit.ts` has no parser of its own; structural errors cited;
benchmark recorded.

## Traps

- Don't let a comment's indentation end a block (RRF 3.6.0+).
- `else`/`elif` sit at the parent `if`'s indent, not the body's.
- A `T` sharing a line is an RRF error — record it as a document error; don't reject the line.

## Out of scope

Evaluating conditions; knowing which branch runs.
