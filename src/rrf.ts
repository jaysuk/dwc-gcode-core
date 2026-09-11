/**
 * The RepRapFirmware release this package's citations were checked against. Every semantic entry
 * under `commands/` cites RRF source at this tag, and `package.json`'s `rrf.baseline` must say the
 * same (a test holds them together).
 *
 * Moving it is a review, not an edit: run `npm run triage -- <RRF_BASELINE> <new tag>`, resolve every
 * commit it lists, then change both values and tag the commit `rrf-<new tag>`.
 */
export const RRF_BASELINE = "3.7.0-rc.1";
