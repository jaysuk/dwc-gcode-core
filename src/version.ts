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
 * description, found while migrating `dwc-config-backup-core`.
 */
export const CORE_VERSION = "1.3.0";
