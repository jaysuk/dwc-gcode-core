# Changelog

Hand-kept list of user-visible changes, in addition to the release workflow's own generated notes.
Not published until the user says otherwise — see `docs/tasks/README.md`, decision 4.

## Unreleased

### Added

- `parseDocument`/`serializeDocument` (`src/document.ts`, new `dwc-gcode-core/document` subpath): a
  lossless, byte-exact-round-trip whole-file G-code document built on `lexLine` — per-line machine
  mode (`M451`/`M452`/`M453`), Fanuc/LaserWeb continuation lines resolved against the last `G0`-`G3`
  command, and the `if`/`elif`/`else`/`while`/`break`/`continue` block tree (siblings per keyword, not
  one node per chain), plus structural diagnostics: `elif-without-if`, `else-without-if`,
  `else-after-else`, `break-outside-loop`, `continue-outside-loop`, `mixed-indentation`,
  `t-not-alone`. See `docs/tasks/06-document-model.md`.
- `applyEdits`/`editSetParam`/`editRemoveParam`/`editReplaceLine`/`editInsertLines`/`editRemoveLine`
  (`document.ts`) and `TextEdit`/`UnsafeEditError`: edit primitives that work in absolute document
  offsets, so several edits can be composed and applied together.
- `resolveFanucContinuation` (`lex.ts`): given a `"fields"`-kind line and the previous `G0`-`G3`
  command, resolves what RRF would read it as in laser/CNC mode.
- `parseExpression` (`src/expr/parse.ts`, new `dwc-gcode-core/expr/parse` subpath — also re-exported
  from the root): a tolerant, never-throwing parser for RRF's `{...}` expression syntax — full
  operator precedence (including the ternary and `^`'s real behaviour, general concatenation rather
  than exponentiation), object-model paths (indices normalised to `[]`), `var.`/`global.`/`param.`
  variable references, function calls (all 31 real functions, generated from source — see
  `src/expr/tables.ts` / `scripts/build-expr-tables.mjs`), the 8 named constants, array literals,
  hex/binary/decimal number literals and quoted-string/character literals. `document.ts`'s
  `expressionsOfLine` finds every `{...}` parameter and the expression part of `if`/`elif`/`while`/
  `var`/`global`/`set`/`echo`/`abort` lines on a given document line.
- `classifyFile` (`src/files/kinds.ts`, new `dwc-gcode-core/files/*` subpath — also re-exported from
  the root): classifies any SD-card path into RRF's own file roles (`config`, `system-macro` with a
  role like `"bed"`/`"home"`/`"tpre"`, `filament-config`/`-load`/`-unload`, `print-file`, `menu`,
  `menu-image`, `height-map`, `probe-points`, `event-log`, `accelerometer-data`, `other`, or
  `out-of-scope`), each row cited in `docs/file-kinds.md` — read from RRF 3.7.0-rc.1 source, not the
  wiki or guessed from extensions.
- `parseMenu` (`src/files/menu.ts`): a tolerant parser for 12864-display menu files
  (`Display/Menu.cpp`'s `Menu::ParseMenuLine`, read end to end) — all six commands, every parameter
  letter including the RRF-3.5+ `V{...}`/`N{...}` expression forms, and `A"..."` action strings split
  into G-code/`menu <name>`/`return` parts (the G-code part lexed with this package's own `lexLine`).
- `parseHeightMap` (`src/files/heightmap.ts`): parses `heightmap.csv`, all three historical label-
  line formats (`Movement/BedProbing/Grid.cpp`'s `GridDefinition::HeightMapLabelLines`), reporting
  RRF's own loader errors with the same row/column numbering. Never stamped (task 09) — the loader
  requires an exact first line.

- `lexLine` (`src/lex.ts`), the new primary lexing entry point, faithful to RRF's
  `StringParser::FindParameters`/`DecodeCommand`/`Put` (3.7.0-rc.1): several commands per line,
  parameters split at every letter (not whitespace), the `E`-after-a-digit exponent exception,
  `'`-escaped lowercase axis parameters, `(...)` bracketed comments in CNC mode (spliced out, not
  just truncated), `*NN` checksums, and whole-line string arguments for `M23`/`M28`/`M30`/`M32`/
  `M36`/`M38`/`M117` (`STRING_ARGUMENT_COMMANDS`). See `docs/tasks/05-lexer.md`.
- `MachineMode` (`"fff" | "laser" | "cnc"`), threaded through `lexLine` via `LexOptions`.

### Changed

- **Behaviour fix**: `tokenise`/`parseParams` previously read `G90 G1 X10` as one command (`G90`)
  with bogus params `G=1 X=10`; they now correctly see only `G90`'s own (empty) parameter list —
  `G1 X10` is a second command, invisible to these single-command, now-deprecated views. Use
  `lexLine` to see every command on a line.
- **Behaviour fix**: `parseParams("M117 Hello World")` no longer misreads the message as parameters
  `H="ello"`/`W="orld"`; `M117` (and the other `STRING_ARGUMENT_COMMANDS`) now correctly yield no
  parameters at all under the deprecated views — use `lexLine`'s `stringArgument` field instead.
- **Behaviour fix**: `paramNumberList(parseParams("M568 P0 S200:x:150"), "S")` now returns `[200]`,
  not `[200, 150]` — a bare letter inside what looks like a colon list is a genuinely new parameter
  to RRF's own `FindParameters`, not a harmless non-numeric element; the old test asserted the wrong
  thing (see `docs/tasks/05-lexer.md`'s Findings).
- `tokenise` and `parseParams` (in `lex.ts` and `params.ts` respectively) are now thin,
  `@deprecated` first-command-only views over `lexLine`, re-implemented on it rather than carrying
  their own parsing logic.
- **Behaviour fix (`edit.ts`)**: `parseLines("N10 M92 E420")[0].code` used to be `"N10"` (its own
  hand-rolled parser didn't know to skip a line number); it's `"M92"` now.
- **Behaviour fix (`edit.ts`)**: `setParam("M572 D0 S{global.pa}", "S", "0.05")` used to silently
  append a duplicate `S` (`"M572 D0 S{global.pa} S0.05"`) — its regex only matched numeric/colon-list
  values, so it never found the existing `S{global.pa}` at all. `setParam` on an existing expression
  parameter now throws `UnsafeEditError` (re-exported from `document.ts`) instead. The same rewrite
  also fixes a related, previously-latent bug: an existing STRING-valued parameter (`C"^spi.cs1"`)
  used to be unfindable by the same regex and would also have gained a silent duplicate — it's found
  and replaced correctly now.
- `edit.ts`'s own hand-rolled parser (`parseLine`/`maskQuoted`/a local `parseParams`) is deleted,
  replaced by `lexLine`. `edit.ts`'s public API and `test/edit.test.ts` are unchanged apart from the
  two fixes above and their new tests.

### Internal

- `MetaKeyword`/`metaKeywordOf`/`META_KEYWORDS` moved from `meta.ts` into a new, unexported
  `src/metaKeywords.ts`, to let `lex.ts` recognise a meta-command line without an import cycle with
  `meta.ts`. Both modules still export/re-export `MetaKeyword` from their own public surface;
  behaviour is unchanged.
- `leadingIndent` moved from a private function in `meta.ts` into `src/chars.ts`, shared with
  `lex.ts`. Behaviour is unchanged.
