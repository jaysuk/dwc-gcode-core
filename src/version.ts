/**
 * This package's own version — kept in sync with `package.json`'s `version` field by
 * `test/package.test.ts`, the same pattern `rrf.ts`'s `RRF_BASELINE` uses for `package.json`'s
 * `rrf.baseline`. Recorded in every stamp this package writes (`stamp.ts`, task 09) as `core=...`,
 * so a file can be flagged for re-checking if a bug in THIS package's own parsing is fixed later,
 * not just when the plugin using it or the target firmware changes.
 *
 * Bumped to 1.0.0 and published to npm 2026-09-16 (`docs/tasks/README.md` decision 4, actioned by the
 * user's own explicit instruction) — every task 05-16 API is now under normal SemVer: a breaking
 * change needs a major bump, not a free pass (decision 5's "API breaks are allowed" applied only
 * pre-1.0, while no plugin had released against this package yet). 1.1.0 (same day) adds
 * `formatStampLine`/`StampInput`, found while migrating `duet-gcode-postprocessor` onto the stamp -
 * additive, no existing export's behaviour changed. 1.2.0 (same day) adds the `M569.1`/`M569.5`/
 * `M569.6` dictionary entries, found while migrating `ClosedLoopTuningPlugin`. 1.3.0 (same day) adds
 * `M586.4`/`M587`/`M588`/`M589` and fixes a wrong MQTT protocol number in `M586`'s own `P`
 * description, found while migrating `dwc-config-backup-core`. 1.3.1 fixes a false-positive
 * `dictionary/wrong-kind` on a `kind:"number"` value in scientific notation (e.g. `M308`'s
 * `C7.06e-8`), found from real user input against a live printer via `dwc-gcode-editor`. 1.4.0
 * (task 17) is the biggest jump since 1.0.0: a dictionary-wide conditional-`required`/enum-`values`
 * audit (`ParamSpec.valueMatch`, the broadened `required` shape, `listLength`, dozens of real
 * dictionary fixes) plus a whole new pin-name subsystem (`dwc-gcode-core/pins/*` - generated tables
 * for 48 STM32/community boards and 6 official Duet mainboards, `lookupPinName`, a new `"pin"`
 * symbol type in `project.ts`, and `project/pin-already-used`/`project/unknown-pin-name`). 1.5.0 adds
 * `expr/evaluate.ts` (a practical-subset evaluator for the AST `expr/parse.ts` only ever parsed) and
 * `execute.ts` (`walkExecution`, an RRF-faithful execution-order walker over `document.ts`'s existing
 * `blocks` tree - real `if`/`elif`/`else`/`while`/`break`/`continue`/`abort` semantics, pausable on an
 * unresolved live/hardware object-model path via `UnresolvedPathError`). 1.5.1 fixes `walkExecution`'s
 * `steps` to include comment lines (found integrating into `duet-gcode-postprocessor`: its own
 * layer-detection reads slicer `;LAYER_CHANGE` comments, which a caller deriving state per step needs
 * to see walked in order same as any other line) - blank lines remain excluded, see `execute.ts`'s own
 * `execPlainLines` doc comment for why the two aren't treated the same. 1.6.0: `expr/evaluate.ts` gains
 * `vector`/`take`/`drop`/`find` (pure array/string functions, cited against RRF's own `EvaluateTake`/
 * `EvaluateDrop`/`SetFindResult`) and `exists()` (special-cased like real RRF's own parser - true for a
 * declared `var`/`global` regardless of its value, or for an object-model path when the new optional
 * `EvalContext.pathExists` is supplied). `execute.ts`'s `walkExecution` gains an optional
 * `objectModelVersion` (validates every referenced path against `objectmodel/schema.ts` BEFORE
 * `resolvePath` is even called - an unknown path is a hard error, not a pause; also backs `exists()`),
 * and `var` is now properly block-scoped (a fresh frame per if/elif/else-arm or while-iteration body,
 * popped when it ends) instead of one flat map for the whole file. Also fixes two real bugs found
 * while adding the block-scoping tests: (1) the if/elif/else chain scan wrongly swept a fresh,
 * independent `if` into the PREVIOUS if's chain whenever it started immediately after the previous
 * arm's own body ended - once that earlier arm had resolved true, the new if's own condition was never
 * evaluated and its body never ran; (2) an undefined-variable read from a condition threw a plain
 * `Error` instead of `EvalError`, which `evaluateExpression`'s catch doesn't convert - it crashed
 * `walkExecution` outright instead of returning the documented `{status:"error"}` outcome. 1.7.0 adds
 * `WalkOptions.onStep`, called synchronously in order right after each step is recorded - lets a
 * caller maintain its own derived state INCREMENTALLY as the walk proceeds (e.g. so a later
 * condition's `resolvePath` can answer from what's already known instead of asking again), rather than
 * only being able to replay `WalkOutcome.steps` after the whole walk finishes. Added for
 * `duet-gcode-postprocessor`'s offline stepper to answer `move.axes[n].homed` from a `G28` it already
 * walked past, instead of always prompting the user for it. 1.8.0 adds `messageBox.ts`
 * (`parseBlockingMessageBox`, cited against RRF's real `GCodes::DoMessageBox`/`MessageBoxLimits` -
 * `S2`/`S3` OK/OK-Cancel, `S5`/`S6`/`S7` integer/float/string value entry; `S4` choice-from-array is a
 * documented gap) and wires it into `walkExecution`: a blocking `M291` now pauses the walk exactly
 * like an unresolved object-model path (`WalkOptions.resolveMessageBox`, throw the new
 * `UnresolvedMessageBoxError` to defer an answer), and its result becomes readable by later lines via
 * two now-implemented named constants, `result` (0 ok / -1 a cancelled `M291`) and `input` (the
 * entered/chosen value) - plus, since the same `resolveExecutionConstant` mechanism covers them for
 * free, `line` and `iterations` are implemented too. Cancelling an `S3` box aborts the walk by default
 * (RRF's own default: `shouldAbort` unless `J2`), matching the existing `abort` meta-keyword handling.
 * 1.9.0 fully resolves `S4` (multiple choice): `messageBox.ts`'s `BlockingMessageBox` gains a
 * `"choice"` kind carrying `K`'s UNEVALUATED expression (real RRF's own `K` is `gb.GetExpression()` -
 * often a literal array, but it can reference a variable, so parsing alone can't finish it);
 * `execute.ts`'s `walkExecution` evaluates it with the walk's own live `EvalContext` (`var`/`global`
 * scope included) before ever pausing, the same way an `if` condition already is. Found and fixed a
 * real, worse-than-missing gap while doing this: an `S4` box previously matched neither "supported"
 * nor "clean error" - `parseBlockingMessageBox` returned `null` for it (same as a genuinely
 * non-blocking box), so the walker just treated the line as an ordinary no-op step and any LATER read
 * of `input`/`result` silently got STALE data left over from whatever came before, not a signal that
 * anything was skipped. `input` after a choice answer is the chosen 0-based INDEX - this package's
 * own convention (matching `F`'s own default-index semantics), not a verified RRF one: real RRF's
 * `m291Result` is simply "whatever M292's own `R` expression sends back", with no canonical
 * index-vs-string rule of its own (`GCodeBuffer.h`'s own comment on `m291Result`).
 *
 * 1.9.1 fixes a real, previously-undiscovered bug in `expr/evaluate.ts`: the `#` (length/count)
 * unary operator - `expr/parse.ts` has always parsed it correctly (its own grammar comment has
 * documented it since task 07) - was never actually handled by the evaluator's unary case, so it
 * silently fell into the generic numeric-unary path: `#anArray` threw a confusing "must be a number,
 * got array" instead of returning the count, and `#5` silently evaluated to `5` (treating `#` as a
 * no-op) instead of the real RRF error a non-string/array operand should be. Cited against
 * `ApplyLengthOperator` (`ExpressionParser.cpp:1589`): a string's length, or an array's element
 * count (object-model-backed or a plain/variable one - this package's own `EvalValue` doesn't
 * distinguish the two), anything else is an error.
 *
 * 1.9.2 promotes `M280` from an unreviewed `@duet3d/monacotokens` draft to a reviewed dictionary
 * entry, cited against `RRF 3.7.0-rc.1 GCodes2.cpp:2842-2865` (`case 280: // Servos`): `P` and `S`
 * are both required. The diagnostics engine deliberately stays silent on parameter-level checks for
 * any draft-only entry (`diagnostics/rules.ts`), so `M280` previously reported zero issues no matter
 * how invalid the line was. 1.10.0 adds `stepper/*` - the offline conditional-execution stepper's
 * model layer, extracted from `duet-gcode-postprocessor`'s own `model/gcode/{state,executionIndex,
 * messageBoxAnswers,simulatedValues,splitCommands}.ts` so a second host (`Flexible-Layouts`) can
 * build the same feature without duplicating it, per this package's own "shared logic gets
 * extracted once a second consumer needs it" convention. Moved with two deliberate, behaviour-
 * preserving changes required by this package's zero-runtime-dependency rule: `stepper/
 * executionIndex.ts`'s `buildExecutionIndex` now takes the document as a plain string instead of a
 * CodeMirror `Text` (a host passes `doc.toString()`, exactly as the original did internally before
 * this change), and `stepper/messageBoxAnswers.ts`/`stepper/simulatedValues.ts` export only the
 * pure resolver logic - their original `localStorage`-backed persistence stays host-side, since
 * `localStorage` is a browser API this package's `lib: ["ES2021"]` typecheck rejects. `state.ts`
 * (renamed `stepper/machineState.ts` to avoid colliding with any host's own unrelated `state.ts`)
 * and `splitCommands.ts` moved verbatim otherwise. All original tests ported alongside (68 tests),
 * full suite 1660 (was 1592). 1.11.0 reviews the first batch of the 182 remaining
 * `@duet3d/monacotokens` drafts: all 24 G-codes (`G11`, `G17`-`G20`, `G38.2`-`G38.5`, `G53`-`G59.3`,
 * `G60`, `G68`, `G69`, `G93`, `G94`), cited against `RRF 3.7.0-rc.1` (`GCodes2.cpp`'s `HandleGcode`
 * switch, plus `GCodes3.cpp`'s `SavePosition`/`HandleG68` and `GCodes6.cpp`'s `StraightProbe`). Two
 * notable findings while reviewing: `G68`'s rotation-centre parameters are a genuine EITHER-OR alias
 * pair RRF itself implements (`gb.MustSee('A', 'X')`, `gb.MustSee('B', 'Y')`) that this schema's
 * single-companion-letter `required` object can't express precisely - encoded as `required:
 * "unknown"` on all four letters rather than risk a false "missing A" when X was the one actually
 * supplied (same "unknown over a wrong boolean" principle the schema's own doc comment already
 * states for a different case). `G38.2`-`.5`'s probe-number parameter is genuinely `K` OR `P`
 * (`(gb.Seen('K') || gb.Seen('P')) ? ... : 0`, both optional) - no schema gap here since neither is
 * ever required. 122 reviewed (was 98), 158 still draft-only. 1.12.0 reviews the next batch: M2-M5
 * (stop/spindle/laser), M17/M18 (motor enable/disable, sharing M84's already-reviewed body), the SD
 * file family (M20-M23, M26-M30, M32, M36/M36.1/M36.2, M37-M39), M42 (GPIO, the M280-shaped
 * P-required/S-required pair again), and M80/M81 (ATX power) - cited against `GCodes2.cpp`'s
 * `HandleMcode` switch and `Platform.cpp`'s `HandleM80`/`HandleM81`. 147 reviewed (was 122), 133
 * still draft-only. 1.13.0 reviews M92 (steps/mm) and the M101-M122 diagnostic/control range: M101-
 * M103 (Simplify3D retraction compatibility codes), M108, M110-M115, M118 (whose MQTT-only T/Q/R/D
 * parameters are the first real use of this schema's `ifLetterPresent`+`valueOneOf` conditional-
 * required form since M569.1's own C), M119-M122 - cited against `GCodes2.cpp`'s `HandleMcode`
 * switch plus `RepRap.cpp`'s `ProcessM111` and `GCodes.cpp`'s `HandleM114`. 162 reviewed (was 147),
 * 118 still draft-only. 1.14.0 reviews M141/M144/M150/M191/M200/M201.1/M206/M226. M141 and M191
 * mirror the already-reviewed M140/M190's own handler shape exactly (chamber vs bed). M150 (LED
 * strips) needed following the real parameter parsing down through `LedStripManager::HandleM150`
 * into `LocalLedStrip::LedParams::GetM150Params` - its `P`/`Y` are alternate brightness scales
 * (0-255 vs 0-31), `P` checked first when both are given. M201.1 turned out to set a genuinely
 * separate "reduced acceleration for probing and stall-detection moves" array
 * (`Move.h:746`), not just a documentation variant of M201. 170 reviewed (was 162), 110 still
 * draft-only. 1.15.0 reviews M290, M300, M303, M305, M309, plus M301/M304 - genuinely unimplemented
 * in this RRF version (no `case 301`/`304` in `HandleMcode`'s dispatcher at all; an unmatched code
 * falls through to `TryMacroFile`, i.e. a user-provided `M301.g`/`M304.g` or an "unsupported
 * command" error), reviewed the same way `G32`'s existing entry already treats a fully
 * macro-delegated command: `parameters: []` with a summary explaining there's nothing this
 * dictionary can check. M303's `S` (target temperature) is required only once `H` or `T` selects a
 * heater to tune - the same either-or-on-two-different-letters gap `G68` and `G38.2`-`.5` already
 * hit, encoded the same way (`required: "unknown"`). 177 reviewed (was 170), 103 still draft-only.
 * 1.16.0 reviews the M260/M261 I2C-Modbus-UART-dispenser family (M260, M260.1-.4, M261, M261.1-.2)
 * - both are one C++ function each (`Platform::SendI2cOrModbus`/`ReceiveI2cOrModbus`) branching on
 * `gb.GetCommandFraction()` into I2C, Modbus RTU, raw UART, a Nordson Ultimus V dispenser protocol
 * (M260.3, its own fixed protocol - not the general B/S/A/R set), and generic Modbus (M260.4). No
 * M261.3/M261.4 exist - the receive side's own fraction switch explicitly falls through to "use
 * M260.3"/"use M260.4" for those, since a dispenser command and a generic Modbus transaction are
 * each already a single send+receive round trip. 185 reviewed (was 177), 95 still draft-only.
 * 1.17.0 reviews M374-M376 (height map save/load/taper), M401/M402 (Z probe deploy/retract),
 * M404 (filament-width-sensor diameter - unrelated to M200's own volumetric diameter despite the
 * similar name), M409 (object model query), M425 (backlash compensation), and M450 (report printer
 * mode). 194 reviewed (was 185), 86 still draft-only.
 */
export const CORE_VERSION = "1.17.0";
