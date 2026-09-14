/**
 * This package's own version — kept in sync with `package.json`'s `version` field by
 * `test/package.test.ts`, the same pattern `rrf.ts`'s `RRF_BASELINE` uses for `package.json`'s
 * `rrf.baseline`. Recorded in every stamp this package writes (`stamp.ts`, task 09) as `core=...`,
 * so a file can be flagged for re-checking if a bug in THIS package's own parsing is fixed later,
 * not just when the plugin using it or the target firmware changes.
 *
 * Not bumped until the user says this package is ready to publish (`docs/tasks/README.md`,
 * decision 4) — so `core=0.5.0` in a stamp written today is expected, not stale.
 */
export const CORE_VERSION = "0.5.0";
