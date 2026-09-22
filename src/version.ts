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
 * `execPlainLines` doc comment for why the two aren't treated the same.
 */
export const CORE_VERSION = "1.5.1";
