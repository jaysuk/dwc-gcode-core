# Changelog

Hand-kept list of user-visible changes, in addition to the release workflow's own generated notes.
Not published until the user says otherwise — see `docs/tasks/README.md`, decision 4.

## Unreleased

### Added

- `diagnoseDocument`/`diagnoseProject` (`src/diagnostics/diagnose.ts`, new `dwc-gcode-core/
  diagnostics/*` subpaths, root-exported): 25 cited rules across syntax, structure, dictionary,
  project, release, menu, data and object-model categories (`RULES`), each `Diagnostic` carrying an
  absolute `{file, line, start, end}` span and its own `sources`. `diagnoseDocument` checks lexer/
  document errors, line length, checksums, a macro-invoking command sharing a line, a capitalised
  meta keyword, unknown/wrong-kind/out-of-range/missing-required/not-yet-available/deprecated/
  wrong-machine-mode dictionary parameters, unknown/deprecated object-model paths, and task 12's
  `impactOf` release findings (when a `stampedVersion` is given); `diagnoseProject` adds undefined/
  duplicate resource symbols, `mustFollow` order dependencies, missing macro files, menu-file errors
  (unknown command, missing `menu`/`image` target) and height-map load errors. `toMonacoMarkers`
  (`src/diagnostics/monaco.ts`) converts to Monaco's own 1-based line/column `IMarkerData` shape (no
  Monaco import). `docs/diagnostics.md` is generated from `RULES` by `npm run docs:diagnostics`. See
  `docs/tasks/14-diagnostics.md`'s Findings for what's deliberately not implemented and why (RRF's
  5-digit CRC16 checksum form; a menu's "missing required parameter", which RRF itself doesn't error
  on; machine-mode/command-since/`mustFollow` dictionary rules, real but not yet exercisable against
  any currently-reviewed dictionary entry).
- `loadProject` (`src/project.ts`, new `dwc-gcode-core/project` subpath, root-exported): the
  machine's whole SD-card configuration as one graph - `Project.calls` (which file invokes which
  other file: `M98`, `G28`/homing, tool-change `tfree`/`tpre`/`tpost` with their real fallback order,
  `M701`/`M702`/`M703`, `G29`/`G32`, pause/resume/cancel/stop, `M501`/`M502`, `M581` - every route
  cited in the new `docs/invocation-table.md`, read from RRF 3.7.0-rc.1 source directly) and
  `Project.symbols` (definitions and uses of tools, heaters, sensors, fans, axes, endstops, probes,
  accelerometers, spindles, extruders, drivers, globals and filaments, each `{ file, line, start,
  end, conditional, dynamic }`). Static analysis only - a definition inside an `if`/`while` is
  `conditional: true`, a resource number written as an expression is `dynamic: true`, neither ever
  resolved further. Fixture SD trees for FFF, CNC and laser machines in `test/corpus/projects/`.
- `changesBetween`/`impactOf` (`src/releases/changes.ts`/`impact.ts`, new
  `dwc-gcode-core/releases/*` subpaths, root-exported): a versioned catalogue of RRF syntax,
  command, parameter and object-model changes (`ChangeEvent`), queryable in either direction
  (upgrade/downgrade), and `impactOf(doc, from, to)` matches those events against a real
  `GcodeDocument` (commands, parameters, object-model paths in expressions, and the `array-literal`/
  `array-concat` expression syntax features) to find what a specific file actually uses that changed.
  Built from `scripts/rrf-triage.mjs`'s rebuilt output for the `GCodeBuffer`/`GCodes dispatch`
  subsystems (146 commits, `docs/rrf-triage/3.6.3..3.7.0-rc.1.md`) plus every `dictionary/
  commands.json` and `src/objectmodel/schema.ts` entry with a `since`/`until`/`deprecated` field -
  the rest of the triage (19 subsystems + the wiki) is deferred, see `docs/tasks/12-release-model.md`.
  `firmware.ts`'s `FEATURES` is now a thin view over this store (`arrayConcatOperator`'s date is
  corrected from a conservative guess to the exact commit's real tag, `3.7.0-beta.1`); its version
  comparison engine moved to the new internal `versionCompare.ts` to avoid an import cycle.
- `objectModelPath`/`objectModelChanges` (`src/objectmodel/schema.ts`, generated, new
  `dwc-gcode-core/objectmodel/schema` subpath, also root-exported) and `OBJECT_MODEL_VERSIONS`/
  `OBJECT_MODEL_BASELINE` (`src/objectmodel/versions.ts`): whether an object-model path (`heat.
  heaters[].current`, `move.axes[].homed`, ...) exists, since/until which RRF release, and whether
  it's deprecated - 709 paths tracked across 5 RRF releases (`3.6.3`, `3.7.0-beta.1`/`beta.2`/
  `beta.3`/`3.7.0-rc.1`; `3.7.0-alpha.2` is a known RRF tag with no usable object-model source and is
  flagged `hasData: false`, not silently guessed). `scripts/build-om-schema.mjs` builds this from
  `@duet3d/objectmodel`'s own `documentation.json`/`deprecations.json` where they exist, and - for
  `3.6.3`, whose npm package predates `documentation.json` entirely - directly from `Duet3D/
  ObjectModel`'s own TypeScript source at the matching git tag, validated to reproduce 691/691 of
  `3.7.0-rc.1`'s real, published paths exactly (see `docs/tasks/11-object-model-schema.md`'s
  Findings for the full validation and the polymorphic-dispatch/subclass-union handling it needed).

- `COMMANDS`/`commandSpec` (`src/dictionary/commands.ts`, generated, new
  `dwc-gcode-core/dictionary/commands` and `dwc-gcode-core/dictionary/schema` subpaths — not
  re-exported from the root: `ParamKind` there collides by name with `lex.ts`'s own): a versioned,
  RRF-source-cited dictionary of what each command's parameters are — letter, kind, whether it takes
  a colon list or an expression, required-ness, value enums, deprecation. 280 commands known; 93
  reviewed against RRF 3.7.0-rc.1 source (every command a real slicer or config.g uses, "tier 1" —
  see `docs/tasks/10-dictionary.md`), the rest drafted from `@duet3d/monacotokens` pending review
  (tracked in `dictionary/coverage.json`). `dictionary/commands.json` is the hand-maintained, cited
  source of truth; `scripts/build-dictionary.mjs` merges it with the bootstrapped drafts and
  generates the `.ts`.
- `src/commands/toolParams.ts`'s `TOOL_PARAM_COMMANDS` is now derived from the dictionary's own
  reviewed `toolNumber`-kind parameters instead of hand-maintained, and is now more complete (adds
  `M104`/`M109`'s `T` and `M207`'s `P`, both real tool numbers the old hand-curated table omitted).
  `commands/g10.ts` now reads its non-`L` letter list from the dictionary too, rather than a second
  hardcoded copy.

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
- `readStamp`/`writeStamp`/`stampable`/`recheckReasons` (`src/stamp.ts`, new `dwc-gcode-core/stamp`
  subpath, root-exported) and `CORE_VERSION` (`src/version.ts`, new `dwc-gcode-core/version`
  subpath): the file-checked-against-version stamp the user asked for — one `;` comment recording
  the RRF version, the checking plugin's id and version, this package's own version, and a
  timestamp. Coexists with the post-processor's own `; postprocessed-by:` line; throws
  `StampNotAllowedError` for a file kind that must never be stamped (`heightmap.csv`/
  `probePoints.csv` most importantly — verified against `HeightMap::LoadFromFile` directly).
  Documented in the README under "The stamp".

- `lexLine` (`src/lex.ts`), the new primary lexing entry point, faithful to RRF's
  `StringParser::FindParameters`/`DecodeCommand`/`Put` (3.7.0-rc.1): several commands per line,
  parameters split at every letter (not whitespace), the `E`-after-a-digit exponent exception,
  `'`-escaped lowercase axis parameters, `(...)` bracketed comments in CNC mode (spliced out, not
  just truncated), `*NN` checksums, and whole-line string arguments for `M23`/`M28`/`M30`/`M32`/
  `M36`/`M38`/`M117` (`STRING_ARGUMENT_COMMANDS`). See `docs/tasks/05-lexer.md`.
- `MachineMode` (`"fff" | "laser" | "cnc"`), threaded through `lexLine` via `LexOptions`.

### Changed

- **Dictionary fix**: `M950`'s reviewed entry was missing `T`/`B`/`Q` for the heater form entirely -
  RRF's `Heat::ConfigureHeater` (`Heat.cpp:562-571`) requires a `T` (sensor number) and optionally
  reads `B`/`Q` whenever `M950 H<n> C"..."` creates a new heater, so every real `M950 H0 C"..." T0`
  line (found while running task 14's diagnostics against task 13's own fixtures) was wrongly
  flagged as using an unknown `T` parameter. Added, cited, `src/dictionary/commands.ts` regenerated.
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
