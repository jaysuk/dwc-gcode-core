# Changelog

Hand-kept list of user-visible changes, in addition to the release workflow's own generated notes.
Not published until the user says otherwise — see `docs/tasks/README.md`, decision 4.

## Unreleased

## 1.18.0 - 2026-09-23

### Added

- Reviewed dictionary entries for M470-M472 (SD file/directory create/rename/delete), M503 (list
  config.g), M505/M505.1 (sys/web folder path), M555 (firmware emulation type), M556 (X/Y/Z-only
  axis-skew compensation) - cited against `RRF 3.7.0-rc.1`. 202 reviewed (was 194), 78 still
  draft-only.

## 1.17.0 - 2026-09-23

### Added

- Reviewed dictionary entries for M374-M376 (height map save/load/taper), M401/M402 (Z probe
  deploy/retract), M404 (filament-width-sensor diameter), M409 (object model query), M425 (backlash
  compensation), M450 (report printer mode) - cited against `RRF 3.7.0-rc.1`. 194 reviewed
  (was 185), 86 still draft-only.

## 1.16.0 - 2026-09-23

### Added

- Reviewed dictionary entries for the M260/M261 I2C-Modbus-UART-dispenser family (M260, M260.1-.4,
  M261, M261.1-.2) - cited against `RRF 3.7.0-rc.1`. 185 reviewed (was 177), 95 still draft-only.

## 1.15.0 - 2026-09-23

### Added

- Reviewed dictionary entries for M290, M300, M303, M305, M309. M301/M304 also reviewed as
  genuinely unimplemented in this RRF version (no dispatcher case at all - falls through to a
  user macro or "unsupported command"), the same treatment `G32`'s existing entry already gives a
  fully macro-delegated command. 177 reviewed (was 170), 103 still draft-only.

## 1.14.0 - 2026-09-23

### Added

- Reviewed dictionary entries for M141, M144, M150 (LED strips), M191, M200, M201.1, M206, M226 -
  cited against `RRF 3.7.0-rc.1`. 170 reviewed (was 162), 110 still draft-only.

## 1.13.0 - 2026-09-23

### Added

- Reviewed dictionary entries for M92 (steps/mm) and the M101-M122 diagnostic/control range
  (M101-M103, M108, M110-M115, M118, M119-M122) - cited against `RRF 3.7.0-rc.1`. 162 reviewed
  (was 147), 118 still draft-only.

## 1.12.0 - 2026-09-23

### Added

- Reviewed dictionary entries for 25 more M-code drafts: M2-M5, M17/M18, the SD file family
  (M20-M23, M26-M30, M32, M36/M36.1/M36.2, M37-M39), M42, and M80/M81 - cited against
  `RRF 3.7.0-rc.1`. 147 reviewed (was 122), 133 still draft-only.

## 1.11.0 - 2026-09-23

### Added

- Reviewed dictionary entries for all 24 G-code drafts (`G11`, `G17`-`G20`, `G38.2`-`G38.5`,
  `G53`-`G59.3`, `G60`, `G68`, `G69`, `G93`, `G94`), cited against `RRF 3.7.0-rc.1`. First batch of
  the 182 remaining `@duet3d/monacotokens` drafts, which the diagnostics engine silently skips
  parameter checks on (see 1.9.2's own note on `M280`). 122 reviewed (was 98), 158 still draft-only.

## 1.10.0 - 2026-09-23

### Added

- `stepper/*` — the offline conditional-execution stepper's model layer (`MachineState` tracking,
  `buildExecutionIndex`/`resolveKnownPath`, the pure halves of the simulated-value and message-box
  resolvers, `splitCommands`), extracted from `duet-gcode-postprocessor` so a second consumer
  (`Flexible-Layouts`) can build the same feature without duplicating it. `buildExecutionIndex` now
  takes the document as a plain string rather than a CodeMirror `Text` (this package takes zero
  runtime dependencies); the two override modules export only their pure resolver logic, since their
  original `localStorage`-backed persistence stays host-side. See `src/version.ts`'s own doc comment
  for the full detail.

## 1.9.2 - 2026-09-22

### Fixed

- `M280` was still a `@duet3d/monacotokens` draft entry (no `reviewed` field), so
  `dictionary/*`'s parameter-level diagnostics rules deliberately stayed silent on it
  (`src/diagnostics/rules.ts`: "a draft entry's parameter list is a heuristic, not a fact") — e.g.
  `M280 K5`, `M280 Start` and `M280 P5` all reported zero issues despite each being invalid. Promoted
  to a reviewed entry cited against `RRF 3.7.0-rc.1 GCodes2.cpp:2842-2865` (`case 280: // Servos`):
  `P` (GPIO/servo port index, `unsigned`) and `S` (angle/pulse-width, `number`) are both required —
  `gb.GetLimitedUIValue('P', MaxGpOutPorts)` and `gb.MustSee('S')` respectively, neither guarded by a
  prior `Seen` check. `P`'s upper bound (`MaxGpOutPorts`) is a board-specific runtime constant, not a
  fixed value this static dictionary can encode, so out-of-range port numbers still need live
  object-model validation against the connected machine — not covered by this fix.

## 1.9.1 - 2026-09-22

### Fixed

- `expr/evaluate.ts`'s unary case never handled `#` (length/count) — `expr/parse.ts` has always parsed
  it correctly, but the evaluator silently fell into the generic numeric-unary path: `#anArray` threw
  a confusing "must be a number" error instead of returning its count, and `#5` silently evaluated to
  `5` (treating `#` as a no-op) instead of the real RRF error a non-string/array operand should be.
  Cited against `ApplyLengthOperator` (`ExpressionParser.cpp:1589`): a string's length, or an array's
  element count, anything else is an error.

## 1.9.0 - 2026-09-22

### Added

- `messageBox.ts`'s `BlockingMessageBox` gains a `"choice"` kind for `M291`'s `S4` (multiple choice):
  `K`'s expression (real RRF's own `gb.GetExpression()` — often a literal array, but it can reference
  a variable) is parsed but deliberately left UNEVALUATED, since evaluating it needs a live
  `EvalContext` this module doesn't have. `execute.ts`'s `walkExecution` evaluates it with the walk's
  own `var`/`global` scope before ever pausing — the same way an `if` condition already is — producing
  a final `{ mode: "choice", choices: string[], ... }` prompt once resolved. `input` after answering
  one is the chosen 0-based index (this package's own convention — real RRF's `m291Result` is simply
  "whatever M292's own `R` expression sends back", with no canonical index-vs-string rule of its own).

### Fixed

- An `S4` box previously matched neither "supported" nor "clean error": `parseBlockingMessageBox`
  returned `null` for it (indistinguishable from a genuinely non-blocking box), so the walker treated
  the line as an ordinary no-op step and any LATER read of `input`/`result` silently got stale data
  left over from whatever came before, rather than a signal that anything had been skipped. A missing
  `K` (`gb.MustSee('K')` in real RRF) is now a genuine parse error on the returned expression, not a
  silent `null`, either.

## 1.8.0 - 2026-09-22

### Added

- `messageBox.ts`: `parseBlockingMessageBox(cmd)` parses an `M291` command into a structured prompt —
  cited against RRF's real `GCodes::DoMessageBox` (`GCodes7.cpp`) and `MessageBoxLimits::
  GetIntegerLimits`/`GetFloatLimits` (`MessageBox.cpp`). Covers the blocking modes `S2`/`S3` (OK /
  OK+Cancel) and `S5`/`S6`/`S7` (integer/float/string value entry, with `L`/`H`/`F` limits and
  default). Returns `null` for the non-blocking modes (`S0`/`S1`, including when `S` is omitted — RRF's
  own default), for `S4` (multiple choice from a `K`-array — a documented gap, not yet supported), and
  for a `P`/`R` whose value is an RRF expression rather than a literal string.
- `execute.ts`'s `walkExecution` now pauses on a blocking `M291` exactly like an unresolved
  object-model path: `WalkOptions.resolveMessageBox` answers it, or throws the new
  `UnresolvedMessageBoxError` to defer (mirroring `UnresolvedPathError`), pausing the walk with a new
  `"message-box"` `WalkOutcome` carrying the parsed prompt. Cancelling an `S3` box aborts the walk by
  default — RRF's own default behaviour (`shouldAbort` unless the command's `J2`) — matching the
  existing `abort` meta-keyword handling exactly.
- `expr/evaluate.ts`'s `result`/`input`/`line`/`iterations` named constants are implemented via a new
  optional `EvalContext.resolveExecutionConstant`. `execute.ts` always supplies a working
  implementation (all four are cheap and unconditionally trackable): `result` is 0 after an accepted
  message box or -1 after a cancelled one that didn't abort; `input` is the entered/chosen value from
  the last blocking `M291`; `line` is the current 1-based source line; `iterations` is the innermost
  enclosing `while` loop's 0-based pass count (an error, not a crash, when read outside any loop).

## 1.7.0 - 2026-09-22

### Added

- `execute.ts`'s `WalkOptions.onStep?(step)` — called synchronously, in order, immediately after each
  step is recorded (including the last one before a step-budget error), before `walkExecution` itself
  returns. Lets a caller maintain its own state incrementally as the walk proceeds instead of only
  being able to replay `WalkOutcome.steps` after the whole walk finishes — added for
  `duet-gcode-postprocessor`'s offline stepper, so a `resolvePath` can answer `move.axes[n].homed` from
  a `G28` it already walked past rather than always prompting the user for it.

## 1.6.0 - 2026-09-22

### Added

- `expr/evaluate.ts`: `vector(n, fill)`, `take(arrayOrString, n)`, `drop(arrayOrString, n)`,
  `find(string, charOrSubstring)` — cited against RRF's own `Function::vector`/`EvaluateTake`/
  `EvaluateDrop`/`SetFindResult` (`ExpressionParser.cpp`). `exists(path)` — special-cased the same way
  real RRF's own parser special-cases it (a different code path, taken BEFORE the argument is
  evaluated normally): true for a declared `var`/`global` regardless of its current value, or for an
  object-model path when the new optional `EvalContext.pathExists` is supplied; a clean "not
  supported" error for an object-model path when it isn't.
- `execute.ts`'s `WalkOptions` gains `objectModelVersion?: string` — when given, every concrete
  object-model path a condition references is checked against `objectmodel/schema.ts` before
  `resolvePath` is even called; an unknown path (typo, or added/removed at that RRF version) is a hard
  `"error"`, not a `"paused"` (asking a caller to guess a value for a path that doesn't exist doesn't
  make sense). Also backs `exists()` above.
- `execute.ts`'s `walkExecution` now properly block-scopes `var` (a fresh scope frame per `if`/`elif`/
  `else`-arm or `while`-iteration body, popped when it ends) instead of one flat map for the whole
  file — a `var` declared inside a block no longer leaks past where it should go out of scope, and
  correctly shadows an outer `var` of the same name without corrupting it. `global` is unaffected (not
  block-scoped in RRF either).

### Fixed

- `walkExecution`'s `if`/`elif`/`else` chain scan wrongly swept a fresh, independent `if` into the
  PREVIOUS `if`'s chain whenever it started immediately after the previous arm's own body ended (its
  line-adjacency check didn't also require the continuing arm's keyword to be `elif`/`else`). Once the
  earlier arm had already resolved true, the new `if`'s own condition was silently never evaluated and
  its body never ran.
- An undefined-variable read from a condition (e.g. `if var.neverDeclared > 0`) threw a plain `Error`
  instead of `EvalError`, which `evaluateExpression`'s own catch doesn't convert — it crashed
  `walkExecution` outright instead of returning the documented `{status:"error"}` outcome. (Every
  earlier test only exercised the "`set` on an undefined variable" path, which never reaches this code
  at all — a plain read from a condition was untested until the block-scoping tests added here.)

## 1.5.1 - 2026-09-22

### Fixed

- `execute.ts`'s `walkExecution` now includes comment lines in its `steps`, not just commands — found
  integrating this release into `duet-gcode-postprocessor`, whose own `MachineState` derivation reads
  layer/feature info straight out of slicer comments (e.g. `;LAYER_CHANGE`), the same way RRF's real
  file reader passes over every physical line regardless of whether it dispatches a command. Blank
  lines remain excluded from `steps` — they carry no content a caller could ever use, and this
  package's own line-splitting (`document.ts`'s `splitLines`) already adds one trailing blank line to
  almost every real file, which would otherwise show up as a spurious extra step at the end of nearly
  everything.

## 1.5.0 - 2026-09-22

### Added

- `expr/evaluate.ts`: a practical-subset RRF expression evaluator over the AST `expr/parse.ts` only
  ever parsed (that module's own doc comment: "never evaluates anything"). Comparisons, short-circuit
  `&&`/`||`/`&`/`|`, arithmetic, `^` as concatenation (not exponentiation — see its own doc comment),
  the ternary (lazy on the untaken branch), and the deterministic math functions (`abs`, `floor`,
  `ceil`, `round`, `sqrt`, `square`, trig, `mod`, `pow`, `atan2`, `max`/`min`, `isnan`). Deliberately
  leaves out anything needing file IO, entropy, wall-clock time or macro-call parameters (`fileread`,
  `fileexists`, `random`, `datetime`, `exists`, `find`, `take`, `drop`, `vector`, `param.*`) as clean
  "not supported" errors rather than guessing. Object-model paths and undefined variables resolve
  through a caller-supplied `EvalContext`; a path whose value genuinely isn't known yet (a live sensor
  reading, an input pin) throws `UnresolvedPathError`, a distinct, catchable outcome from a plain
  `EvalError`, so a caller can tell "ask for a value" apart from "this expression is wrong".
- `execute.ts`'s `walkExecution`: determines a document's REAL execution order — which `if`/`elif`/
  `else` arm actually runs, how many times a `while` body repeats, `break`/`continue`/`abort` — using
  the evaluator above together with `document.ts`'s existing `blocks` tree, instead of a flat
  top-to-bottom line walk. A pure, single-pass, synchronous function: given a `resolvePath` that
  throws `UnresolvedPathError` for a value it doesn't have, it pauses exactly at the condition that
  needed it and reports everything executed up to that point; re-running with a `resolvePath` that now
  answers that path picks up from the top and gets further. `while` loops are capped at
  `maxIterationsPerLoop` (default 10 000) — RRF itself has none (`GCodeBuffer::RestartFrom` re-seeks
  the file every iteration), but an offline simulator can't inherit that unboundedness without risking
  a hang.

## 1.4.0 - 2026-09-21

### Added

- `ParamSpec.listLength` (`src/dictionary/schema.ts`): the element counts RRF's own array reader
  (`StringParser::CheckArrayLength`) actually accepts for a `list: true` parameter, when the valid
  count is a genuinely closed set - RRF throws `"array too long for parameter"` past a fixed-size
  array. Applied to `M950`'s spindle-form `L` (1-2 values) and `K` (1-3 values), then a further batch
  found by triaging the audit script's own new category against real source: `G31`'s `T` (1-2),
  `M106`'s `T` (1-2, padded), `M307`'s `K`/`C` (1-2 each), `M558`'s `H` (1-2, padded) and `F` (1-3,
  padded), `M569`'s `T` (exactly `4` - the one confirmed EXACT-count case, `Move2.cpp`'s own "bad
  timing parameter" check, not a range), `M572`'s `S` (1-2), and `M593`'s `H`/`T` (1-4 each,
  `MaxImpulses - 1`). A handful of remaining candidates were checked and deliberately left alone: any
  capped only by a large board-resource constant (`MaxSensors`, `MaxTools`, `MaxDriversPerAxis`) isn't
  a meaningfully "closed" set in the same sense; `M569.1`'s `E` was inconclusive (its real bound lives
  behind a CAN-message marshalling layer this pass didn't fully trace) and left unset rather than
  guessed.
- Two new diagnostic rules (task 17, Part B, Step 8), completing the pin-name infrastructure:
  `project/pin-already-used` (error) fires when the same physical pin is claimed unconditionally by
  more than one site anywhere in the project - cited directly to `IoPort::Allocate`'s own
  `portUsedBy`/`"Pin '%s' is not free"` check, a real RRF runtime error, not a style preference.
  `project/unknown-pin-name` (warning) fires when a pin name doesn't match any known alias (or, for a
  community board, the port.pin fallback) on a board named in the new `DiagnoseOptions.boards` -
  skipped entirely when no board is named for that pin's address, never guessed. Running the new rule
  against task 13's own `fff-basic` fixture immediately found a real, previously-undetected bug in the
  fixture itself: `M574 Y1 S1 P"io1.in"` (an endstop) and `M558 K0 C"^io1.in"` (a Z-probe) claimed the
  same physical pin with two different roles - confirmed real RRF would reject this exact config
  (`IoPort::Allocate`'s conflict check only allows a second claim when it's the SAME `temporaryInput`
  role) - fixed by moving the Z-probe to its own pin.
- `project.ts`'s symbol tracker now has a `"pin"` type: every reviewed `kind: "pin"` parameter site
  becomes a `"pin"` symbol, generically off the dictionary (the same approach `"axis"` already uses)
  rather than a hand-listed set of commands. Identity mirrors RRF's own `IoPort::Allocate` (confirmed
  unchanged between the mainline and the community/TGBTC fork): leading `!`/`^`/`*` modifiers are
  stripped, a leading `<digits>.` is a CAN-address prefix (default `0`), and `"nil"`/`"NoPin"` is never
  tracked at all (frees a pin, never a conflict). New `ProjectOptions.boards` (CAN address -> board
  id) resolves a pin alias through that board's own table first, so two different alias spellings for
  the same physical pin (e.g. `lcdsck`/`sck`) collapse to one symbol; without a board mapping for an
  address, falls back to raw normalised-string comparison rather than refusing to track the pin.
- New `dwc-gcode-core/pins/*` subpaths (root-exported too): `BOARD_PIN_TABLES`/`lookupPinName`
  (`pins/tables`) and `parsePortPin` (`pins/portPin`) - task 17 Part B's pin-name infrastructure.
  `lookupPinName(boardId, name)` resolves a G-code pin name against a specific board's real pin
  table, board-family matching rules included: case-insensitive and `_`/`-`-tolerant, falling back to
  the generic `PA1`/`PA_1`/`PA.1`/`A1`/`A_1`/`A.1` port.pin syntax, for community boards; case-
  sensitive with NO port.pin fallback at all for official Duet boards - confirmed by reading the
  mainline's complete `LookupPinName` (`Config/Pins.cpp`) end to end, it has no numeric fallback path,
  so `PA1`-style typing genuinely doesn't work on a real Duet board. `BOARD_PIN_TABLES` covers 48
  community boards (BTT/FLY/Formbot/FYSETC/LDO) plus 6 official Duet mainboards (`Pins_FMDC.h` not
  yet included - real conditional compilation in its `PinTable[]` this generator doesn't resolve yet).
- `scripts/build-pin-tables-rrfpins.mjs` generates `src/pins/communityBoards.ts` from every
  `rrfpins.txt` in the gloomyandy/RRFBuild repo (48 boards, 1805 pins total) - the real, per-board pin
  list the STM32 "TGBTC" firmware fork loads at boot. Merges a physical pin's aliases across multiple
  lines of one board's own file into a single entry (a real board can legitimately spell the same wire
  two different ways under two unrelated names - confirmed and cited in task 17's own Findings).
- `scripts/build-pin-tables-duet.mjs` generates `src/pins/duetBoards.ts` (266 pins across 6 boards)
  from each official mainboard's own compiled `PinTable[]` (`RepRapFirmware/src/Config/Pins_*.h`) - a
  narrow, purpose-built parser rather than a general C++ one, since only one field (`pinNames`, always
  last) actually needs reading. Resolves a board-specific named-constant `pinNames` field
  (`ModbusTxPinName`) and strips the leading `!` "hardware inverted" marker RRF itself treats as
  invisible to what a user types (`Pins_Duet3Mini.h`'s own doc comment). `canonicalName` is each pin's
  own first listed alias, not a derived chip address - `Pins_DuetNG.h` has real virtual/expander pins
  (a DueX board, an SX1509B I2C GPIO expander) with no physical chip pin address at all.
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
- `M569.6`'s `V` (tuning manoeuvre) now has `values` - a genuinely non-contiguous set (`1`-`4` plus an
  undocumented `64`, found in `ClosedLoop::ProcessM569Point6`'s own `switch`), so `range` couldn't have
  expressed this even as a fallback.
- `scripts/audit-dictionary.mjs` (task 17, Decision 2): a repeatable sweep of every reviewed
  command's parameters for two real gap shapes - a `kind: "string"` parameter with no `values` list,
  and a description that already says "required when X" in prose without `required` reflecting it.
  Surfaces candidates for a human to verify against RRF source, doesn't apply anything itself.
- `ParamSpec.required` (`src/dictionary/schema.ts`) can now be a same-line condition on one companion
  letter (`{ ifLetterPresent, valueOneOf?, valueNot? }`), not just a flat boolean - applied to four
  real, RRF-source-verified cases: `M569.1`'s `C` (required when `T` is `1` or `2`), `M593`'s `H`
  (required when `P` is `"custom"`), `M586.4`'s `T` (required when `W` is given), and `M589`'s `P`/`I`
  (required when `S` is given and isn't `"*"`). `M586`'s `H` (a genuine two-condition case - `P`
  selects MQTT AND `S1` enables it) deliberately stays `required: "unknown"` rather than being forced
  into the single-letter shape. `M572`'s `L` (a list-length condition on `S`) and `M950`'s `T` (a
  multi-form, two-letter condition) join `M586`'s `H` for the same reason.

### Documentation

- `M106`'s `T`/`H`/`B`/`L`/`X`/`C` all said "requires P" - re-read `GCodes2.cpp`'s real M106 dispatch:
  `P` isn't actually `gb.MustSee`d at all, and these six are simply never read when `P` is absent
  (`FansManager::ConfigureFan`, which reads them, is only called inside the `seenFanNum` branch) - RRF
  silently ignores them, it doesn't error. Corrected the wording; deliberately did NOT add a
  `required` condition, since that mechanism is for a real RRF-thrown error, not a silent no-op.
- **`M575`'s `S` (channel mode) description was wrong**: it said "0 raw, 1 PanelDue, 2 Duet3D device
  mode" - RRF's real `auxModes[]` table has 8 entries, not 3, and index 0/1 are both PanelDue variants
  (not "raw"). Now has the real 8-value `values` list, each cited to the table's own inline comment.

### Fixed

- **`project.ts` never recognised a `+`-joined multi-pin value** (e.g. `M574 Y1 S1 P"io2.in+io3.in"`,
  two endstop pins OR'd together for one axis) - it tracked the whole string as one nonsense "pin"
  rather than two separate ones, so `project/pin-already-used`/`project/unknown-pin-name` couldn't
  check either pin correctly. `+`-joining is a real, pervasive RRF convention
  (`IoPort::AssignPort(s)`, `Hardware/IoPorts.cpp`) confirmed at multiple real call sites, not just
  M574: `M558`'s `C` (up to 2 pins), `M955`'s `C` (exactly 2), `M950`'s fan form `C` (up to 2 -
  control + tacho), and `M308`'s `P` for a DHT sensor specifically (2 - every other sensor type is
  single-pin only). `pinSymbolSites` now splits on `+` for every `kind: "pin"` value, tracking each
  segment as its own independent pin claim/lookup.
- **The CAN-address prefix on a `+`-joined multi-pin value was being re-parsed per segment instead of
  once for the whole value** - so `M950 F0 C"!1.out3+out3.tach"` (a fan's control pin on expansion
  board 1, plus its tacho pin, which has no prefix of its own since it inherits board 1 from the
  value's own front) was wrongly tracking the tacho pin as being on the mainboard instead. Confirmed
  directly, not assumed, at four real call sites (`FansManager::ConfigureFanPort`,
  `Heat::ConfigureHeater`, `Accelerometers::ConfigureAccelerometer`, `EndstopsManager::HandleM558`):
  each calls `IoPort::RemoveBoardAddress` exactly once on the raw string, before any `+`-awareness, to
  decide whether the WHOLE device is local or remote. `M574` is the one confirmed exception -
  `SwitchEndstop::Configure` has its own hand-rolled loop that parses each `+`-segment's address
  independently (a dual-Z axis can genuinely have endstops on two different expansion boards).
- **`M950`'s spindle-form `K` (PWM values) was modelled with the LED form's own `kind`/`list`/`range`
  only** (`kind: "unsigned"`, `list: false`, `range: 0-5`) - a real, pre-existing bug: a genuinely
  valid spindle value like `K0.1:0.9` was wrongly flagged as `dictionary/wrong-kind` (decimals aren't
  "unsigned") and the colon-list was never even split. `K` is genuinely bimodal (LED: single integer
  colour-order 0-5; spindle: 1-3 colon-separated PWM floats 0.0-1.0) - broadened to `kind: "number"`,
  `list: true`, `listLength: [1,2,3]`, keeping `range: 0-5` (still correctly enforced only for the
  LED form's single-value case). Also corrected the description, which was missing the spindle form's
  1-value ("max alone") case entirely.
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
