# Changelog

Hand-kept list of user-visible changes, in addition to the release workflow's own generated notes.
Not published until the user says otherwise — see `docs/tasks/README.md`, decision 4.

## Unreleased

### Added

- `M308`'s `Y` (sensor type), `M593`'s `P` (input shaper type), and `M569.1`'s `Y` (magnetic encoder
  chip) now have a `values` enum in `dictionary/commands.json`, cited fresh from RRF source
  (`Heating/Sensors/*.h`'s self-registering `SensorTypeDescriptor` list; `Movement/AxisShaper.h`'s
  `NamedEnum`; Duet3Expansion's `AbsoluteRotaryEncoder.h`'s `NamedEnum`), closing a real gap: a typo
  like `M308 S0 Y"thermstor"` previously validated as any other string and was never flagged.
- `ParamSpec.valueMatch` (`src/dictionary/schema.ts`): `"exact"` (default, RRF's usual `NamedEnum`/
  `strcmp` string enums) or `"reduced"` (RRF's `ReducedStringEquals` - case-insensitive, `-`/`_`
  ignored on either side, confirmed from `RRFLibraries/src/General/StringFunctions.cpp` - used only
  by M308's `Y`, since `TemperatureSensor::Create` is the one command in the dictionary so far that
  matches this way instead of the stricter `NamedEnum`).
- `M575`'s `F` (serial parity) now has `values` (`0`/`1`/`2`) - `Platform::HandleM575`'s
  `GetLimitedUIValue('F', 3)` throws for anything else, it doesn't clamp.
- `scripts/audit-dictionary.mjs` (task 17, Decision 2): a repeatable sweep of every reviewed
  command's parameters for two real gap shapes - a `kind: "string"` parameter with no `values` list,
  and a description that already says "required when X" in prose without `required` reflecting it.
  Surfaces candidates for a human to verify against RRF source, doesn't apply anything itself.

### Fixed

- **`dictionary/value-out-of-range` never matched a quoted string enum value at all**: `LexedParam
  .value` keeps quotes verbatim, so a real `M593 P"zvd"` was compared against the dictionary's
  unquoted `"zvd"` and always failed - this was invisible until this release's first `kind: "string"`
  `values` entries existed to expose it (`G29`'s `S`/`M143`'s `A`/`M500`'s `P`, the only prior
  `values` users, are all numeric, where quoting never applied). Fixed by unquoting a `kind: "string"`
  value before comparing.
- **`M143`'s `C` (heater monitor trigger) description listed a value ("2 sensor reading error") that
  doesn't exist in RRF's real enum** (`HeaterMonitorTrigger`: `Disabled=-1`, `TemperatureExceeded=0`,
  `TemperatureTooLow=1` only) - found by `scripts/audit-dictionary.mjs`'s numeric-enum sweep, then
  confirmed against `Heater::ConfigureMonitor`/`HeaterMonitor.h` directly. Now has `values` (`-1..1`).
- **`M574`'s `S` (endstop input type) description had the wrong meaning for values 1 and 2** ("1
  active-high pin, 2 active-low pin" - polarity is actually set by the `P` pin name's own `!` modifier,
  not by `S`). The real meanings, confirmed against `EndstopDefs.h`'s `NamedEnum(EndStopType, ...)`:
  `1`=switch-type input pin, `2`=the configured Z probe used as this axis's endstop. Also now flags `S0`
  as invalid - RRF explicitly rejects it ("endstop type 0 is no longer supported"), it isn't just an
  undocumented value. Now has `values` (`1..5`).
- **`M308 S<n>` (and `M950 H<n>`) were unconditionally treated as "defining" the sensor/heater**, even
  on a line that only reconfigures one that must already exist. RRF only (re)creates a sensor when
  `Y` is also seen on the same `M308` line (`Heat::ConfigureSensor`'s `if (gb.Seen('Y'))`), and only
  (re)creates a heater when `M950`'s `C` is also seen (`Heat::ConfigureHeater`'s `if (gb.Seen('C'))`) -
  a plain `M308 S0 A"renamed"` or `M950 H0 Q100` never created anything. `project.ts`'s `SymbolRule
  .role` can now be a same-line condition (`{ ifLetterPresent, else }`) instead of only a flat
  `"define" | "use"`; this also means `project/undefined-symbol` now correctly flags a sensor/heater
  that's reconfigured but was never actually created anywhere in the project - the "required, optional
  or not needed" distinction the M308 report originally asked for.

## 1.3.1 - 2026-09-17

### Fixed

- **`dictionary/wrong-kind` false positive**: a `kind: "number"` parameter's value in scientific
  notation (e.g. `M308`'s `C7.06e-8` Steinhart-Hart coefficient) was wrongly flagged as not looking
  like a number. `lex.ts`'s own tokeniser already accepted it correctly (its `NUMBER_RE` supports
  `[eE][+-]?digits`) - only this diagnostic's own, independently-drifted copy of the shape check
  didn't. Confirmed directly against RRF source (`RRFLibraries/src/General/NumericConverter.cpp`'s
  `Accumulate`) that this is generic float grammar every `kind: "number"` parameter accepts (via
  `ReadFloatValue` → `SafeStrtof`), not something specific to M308 - and confirmed the fix does NOT
  extend to integer-shaped kinds (`integer`/`unsigned`/`heaterNumber`/`fanNumber`/`sensorNumber`/
  `probeNumber`/`toolNumber`), since RRF reads those through a separate integer parser
  (`ReadUIValue`/`ReadIValue`) that never accepts an exponent. `looksLikeKind` now reuses `lex.ts`'s
  own `NUMBER_RE` (newly exported) for the `"number"` case specifically, instead of a second copy, so
  the two can't drift apart again.

## 1.3.0 - 2026-09-16

### Added

- `M586.4`, `M587`, `M588`, `M589` dictionary entries (`dictionary/commands.json`) - MQTT client
  configuration, WiFi network add/list, WiFi network forget, and access-point configuration. `M587`/
  `M588`/`M589` were "reviewed" with entirely empty parameter lists before this (every real use
  flagged every parameter as unknown); `M586.4` didn't exist at all. Found while migrating
  `dwc-config-backup-core`'s own hand-maintained redaction table onto this dictionary. Cited to
  `Networking/ESP8266WiFi/WiFiInterface.cpp` (`WiFiInterface::HandleWiFiCode`) and
  `Networking/MQTT/MqttClient.cpp` (`MqttClient::Configure`).

### Changed

- **Dictionary fix**: `M586`'s `P` parameter description wrongly said MQTT was protocol `3` - it's
  actually `4` (`NetworkDefs.h`'s `NetworkProtocol` enum: `HttpProtocol = 0, FtpProtocol = 1,
  TelnetProtocol = 2, MulticastDiscoveryProtocol = 3, MqttProtocol = 4`); `3` is multicast discovery.
  Found while adding `M586.4`'s own entry and cross-checking the constant this entry only named
  informally before.

## 1.2.0 - 2026-09-16

### Added

- `M569.1`, `M569.5`, `M569.6` dictionary entries (`dictionary/commands.json`) - closed-loop driver
  configuration (encoder/PID gains/error thresholds), data collection, and calibration/tuning
  manoeuvres. Entirely absent before this - found while migrating `ClosedLoopTuningPlugin` onto this
  package. Cited to `Duet3Expansion`'s own `ClosedLoop/ClosedLoop.cpp` (the actual parameter-reading
  implementation, since these sub-commands only ever execute on a CAN-connected closed-loop driver
  board, not the mainboard - `RepRapFirmware`'s own `ClosedLoop.cpp` only handles M569.5's initial
  G-code parsing before forwarding a pre-built CAN message) and `CANlib`'s shared `EncoderType` enum.

## 1.1.0 - 2026-09-16

### Added

- `formatStampLine(stamp)` (`src/stamp.ts`, root-exported): formats one stamp as its exact `;`-comment
  line, with no document parsing or insertion logic - for a caller that builds output as a stream and
  can never hold a whole file in memory to hand `writeStamp` (found while adopting the stamp in
  `duet-gcode-postprocessor`, whose chunked Blob read/write pipeline is built specifically to never
  materialise a whole large file as one JS string). `writeStamp` itself is unchanged and remains the
  right choice whenever the whole file text is already in memory.
- `StampInput` (`src/stamp.ts`, root-exported): the fields needed to write a stamp, factored out of
  `writeStamp`'s and `formatStampLine`'s previously-duplicated inline parameter type.

## 1.0.0 - 2026-09-16

First published release. Every task in `docs/tasks/README.md`'s queue (05-16) is done - the lexer,
document model, expressions, file kinds, the stamp, the command dictionary, the object-model schema,
release/change tracking (`changesBetween`/`impactOf`), the project model, diagnostics, compare, and
hardening (performance, fuzzing, packaging). From this version on, a breaking API change needs a major
version bump like any other published package - `docs/tasks/README.md`'s decision 5 ("API breaks are
allowed") applied only pre-1.0, while no plugin had released against this package yet.

### Added

- `targetKey(target)` (`src/releases/schema.ts`, root-exported): a stable string key for what a
  `ChangeEventTarget` refers to, independent of version/kind/description. Backs `impactOf`'s handling
  of a target that changes more than once within one query range (see Changed below).
- `lexLines(chunks, options)` (`src/lex.ts`, root and `/lex` subpath): `lexLine` over a stream of raw
  text chunks - splits on `"\n"` only, carrying a partial line across a chunk boundary exactly once,
  so a consumer scanning a huge print file can read it in bounded-size pieces (a `Blob`/`File`'s own
  chunked read) instead of materialising the whole thing as one JS string first. The benefit is a
  bounded working set, not speed: lexing 200 MB takes the same ~7 s either way, but `lexLines` holds
  ~26 MB when fed 64 KB pieces versus ~181 MB when handed the whole file (roughly the retained string
  itself), and the chunked figure stays flat as the file grows. See `docs/performance.md`, which
  reports the synthetic generator's own cost separately so it isn't misattributed to the library.
- `compareDocuments`/`compareProjects`/`diffText` (`src/compare.ts`, new `dwc-gcode-core/compare`
  subpath, root-exported): semantic diff by an **identity key** derived from the dictionary's own
  defining parameters (`M563` by `P`, `M950` by whichever of `H`/`F`/`J`/`P`/`S`/`R`/`E` is present,
  `M308` by `S`, `M558` by `K`, `M955` by `P`, `M584`/`M574` per axis letter, `G10` by its own
  `toolSettings`/`workplace` dispatch form) so a reordered `config.g`, or one split across included
  files, reads as `changed`/`moved`, not wholesale `removed`+`added`. A command with no identity rule
  (`G90`, a bare `G1`, ...) matches by position within its own file instead. `events` on a change name
  the real task-12 `CHANGES` entries that explain it, when a `fromVersion`/`toVersion` range is given.
  `diffText` is a separate, byte-faithful LCS line diff for callers that want the textual view too.
  Validated against task 13's own project fixtures (each self-compares to zero changes; a targeted
  edit produces exactly the one expected finding) - see `docs/tasks/15-compare.md`'s Findings for the
  real nuance found while writing `M584`'s rule (`R`/`S` apply per-invocation, not per-axis-forever)
  and the scope limits documented rather than silently assumed away (no data exists to cite which
  commands are "order-sensitive" for cross-file moves; positional matching isn't block-scoped).
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

- **Behaviour fix (`impactOf`)**: a target that changed more than once inside one queried version
  range used to produce one finding PER change, including ones already superseded by a later change
  before the query's own destination version. Real case: M955's `P` is capped to 0 at `3.7.0-rc.1`,
  then uncapped again at `3.7.0-rc.1+1` - checking a file across `3.7.0-beta.3` → `3.7.0-rc.1+1` (a
  single upgrade skipping the intermediate `rc.1`, a normal thing for a user to do) used to warn about
  the capping even though it no longer applies at the destination. `impactOf` now collapses a chain of
  same-target events down to the one closest to the destination version (latest when upgrading, since
  that's what's actually true on arrival; earliest when downgrading, since crossing back below it undoes
  everything after it at once) before matching against the document. `changesBetween` is unchanged - it
  still returns the full, uncollapsed history, for anyone who wants the complete audit trail rather than
  "does my file need attention right now". Root cause: the two M955 events didn't share a comparable
  target at all (one was `behaviour`-typed, the other `parameter`-typed) - fixed alongside, see
  `docs/tasks/12-release-model.md`'s Findings.
- **Behaviour fix (`lex.ts`, and everything built on it)**: a `'`-escaped axis parameter's own `start`
  pointed at the letter rather than at the `'`, contradicting `LexedParam.start`'s own documented
  contract, and the `'` was additionally counted as part of the PRECEDING parameter's value. Two real
  consequences, both fixed: `removeParam("G1 'a10 X5", "a")` (and `editRemoveParam`) returned
  `"G1 ' X5"` — an orphaned quote RRF can't parse — and `paramNumber(parseParams("G1 X5 'a10"), "X")`
  read `X` as `"5 '"` instead of `5`. A parameter's span now covers its whole token, and a value now
  stops at the next token's start rather than the next letter.
- **Behaviour fix (`diagnostics`)**: `syntax/checksum-mismatch` measured its digit count to the end of
  the line instead of across the checksum's own span, so any checksummed line with anything after the
  checksum — a trailing `;` comment, or just trailing whitespace — silently skipped validation
  entirely. Ordinary host-mode output has exactly that shape.
- **Behaviour fix (`project.ts`)**: `M950 P<n>` (the plain GPIO-output form) defined no symbol at all,
  while `M950 S<n>` did — but RRF's `Platform::ConfigurePort` indexes one `gpoutPorts` array from
  either letter (`Platform.cpp:4123-4132`), differing only in the servo flag. Both now define the same
  `gpout` symbol, so a genuinely duplicated port is also catchable by `project/duplicate-definition`.
- **`diffText` no longer allocates without bound**: it now trims the common head and tail before
  building its LCS table, and refuses tables over `MAX_DIFF_CELLS` (16M cells / 64 MB) with a new
  `DiffTooLargeError` rather than quietly allocating gigabytes — `Int32Array` storage sits outside
  V8's heap, so `--max-old-space-size` never stopped it and a browser tab would simply die. A
  5,000-line config with a handful of edited lines went from ~614 ms to ~3 ms as a side effect.
- **Packaging fix**: the bare `import ... from "dwc-gcode-core"` root specifier failed to resolve
  under a legacy `moduleResolution: "node"` TypeScript build (confirmed against a real DWC 3.6 build,
  resonance-lab's own dual DWC 3.6/3.7 target) even though every documented subpath already worked.
  The real cause (found by direct experiment against a reproducing fixture, not assumed): `package.
  json`'s own `typesVersions` wildcard also matches the ROOT specifier under classic resolution,
  rewriting it to `dist/` with no filename, which fails and shadows the perfectly good top-level
  `types`/`main` fields - not an `exports`/`require`-condition issue, both of which were tested and
  ruled out directly. Fixed with a second fallback candidate in the same wildcard entry
  (`["dist/*", "dist/index.d.ts"]`); a regression here now fails CI (`test/packaging/legacy/`,
  `npm run test:packaging`). See README's "Legacy webpack/CJS builds" section for the full story.
- **Dictionary fix**: `M950`'s reviewed entry was missing `T`/`B`/`Q` for the heater form entirely -
  RRF's `Heat::ConfigureHeater` (`Heat.cpp:562-571`) requires a `T` (sensor number) and optionally
  reads `B`/`Q` whenever `M950 H<n> C"..."` creates a new heater, so every real `M950 H0 C"..." T0`
  line (found while running task 14's diagnostics against task 13's own fixtures) was wrongly
  flagged as using an unknown `T` parameter. Added, cited, `src/dictionary/commands.ts` regenerated.
- **Dictionary fixes (task 12's full triage closure)**: cross-checking every reviewed command against
  all 366 RRF commits and 138 wiki commits in `3.6.3..3.7.0-rc.1` surfaced real gaps that were flagging
  legitimate config.g/print-file syntax as unknown or wrong-kind. `M106` gained its thermostatic-fan
  form (`T`/`H`/`B`/`L`/`X`) and `C` (fan name) - a high-value fix given M106's near-universal use.
  `M308` gained universal (`A`/`U`/`V`) and thermistor-specific (`T`/`B`/`C`/`R`/`L`/`H`) parameters -
  thermistors are its most common sensor type. `M950`'s `T` now covers all three sub-forms it silently
  serves (heater sensor number, LED strip type, spindle type); `K` similarly covers LED colour order
  vs. spindle PWM array (same letter, unrelated meaning); new `L` (spindle RPM range) and `U` (LED max
  length); `B`'s `since` corrected from an initially-wrong `3.7.0-beta.1` to `3.7.0-beta.2`, caught by
  the wiki directly contradicting the dictionary's own claim. `M574` gained `E`'s `since` date and `S5`
  (encoder stall detection). `M558` gained `V`/`U` (load cell scale/preload window) and a note on `P`
  type `3`'s removal. `M575` gained `F` (serial parity) and `C` (RS485 direction port). `M584` gained
  `P` (visible axis count). `M116`'s `P` gained its colon-list-since-beta.3 note. `M569`'s `R` gained
  its `-1` value (and its `kind` was corrected from `boolean01` to `integer`, since `boolean01` would
  have flagged `R-1` as wrong-kind) and a new `U` (TMC current-scaler override). `M906` gained `T`
  (idle timeout). `M593` gained `L` (accepted but a deliberate no-op since 3.6.0). Every fix has a
  regression test in `test/diagnostics.test.ts`; see `docs/tasks/12-release-model.md`'s Findings for
  the full citation trail, including the `git describe --tags --contains`-is-unreliable-for-dating
  methodological finding the wiki cross-check surfaced.
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
