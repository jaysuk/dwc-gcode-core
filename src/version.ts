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
 */
export const CORE_VERSION = "1.9.0";
