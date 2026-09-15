/**
 * Firmware version parsing/comparison, and a small table of what changed in which RRF release.
 *
 * The version parsing/comparison engine itself lives in `versionCompare.ts` (task 12 moved it there
 * to break an import cycle: `FEATURES` below reads its facts from `src/releases/changes.ts`'s event
 * store, and that store needs to compare versions too - see that file's own header) and is
 * re-exported here unchanged, so nothing about this split is visible to a consumer importing
 * `dwc-gcode-core/firmware`.
 *
 * Merged from two copies that diverged after one was copied into the other: resonance-lab's
 * `src/config/firmwareVersion.ts` (the original, which later grew the `+N` build-number tiebreaker)
 * and duet-calibration-wizard's `src/model/firmwareVersion.ts` (a copy, per that file's own header,
 * that never got the tiebreaker back-ported — latent there, since neither of that plugin's own gates
 * currently need resolution at that level).
 */
export type { ParsedVersion } from "./versionCompare.js";
export { compareFirmwareVersions, firmwareAtLeast, parseFirmwareVersion } from "./versionCompare.js";

import { changeEvent } from "./releases/changes.js";
import { firmwareAtLeast } from "./versionCompare.js";

// ── FEATURES: what changed, and since when ─────────────────────────────────────────────────────

export interface FeatureInfo {
	/** RRF version this became available in. Compare with `firmwareAtLeast`/`compareFirmwareVersions`,
	 *  not string equality — a board reports its own exact patch/prerelease, rarely exactly this
	 *  string. No floor is enforced on `since` itself — existing consumers already gate on features
	 *  older than 3.6.3 (e.g. `variables` at 3.3) for reasons unrelated to file-stamp diffing; that
	 *  feature's own 3.6.3 floor (see `duet-gcode-postprocessor/docs/gcode-core-plan.md`'s
	 *  "File-stamp diffing" section) is a product decision for that specific feature to apply when
	 *  it queries this table, not a constraint on the table's own contents. */
	since: string;
	description: string;
	/** `RRF <version> <file> <anchor>`, or a wiki section title, or both — every entry must have one;
	 *  a lint test (`test/firmware.test.ts`) enforces it. */
	source: string;
}

/** Builds one `FeatureInfo` from a `src/releases/changes.ts` event's own `version`/`sources` — task
 *  12's "FEATURES/supports() become a thin view over events" decision: `since`/`source` are never
 *  hand-typed here a second time, only looked up. Throws (via `changeEvent`) on a typo'd event id. */
function featureFromEvent(eventId: string, description: string): FeatureInfo {
	const event = changeEvent(eventId);
	return { since: event.version, description, source: event.sources[0] };
}

/**
 * Curated, not exhaustive — one entry per fact this package or a consumer has actually needed and
 * verified, never speculative. Extending this table means adding the underlying event to
 * `src/releases/changes.ts` first (cited to the commit/wiki passage that proves it, per
 * `scripts/rrf-triage.mjs`'s own checklist), then a `featureFromEvent` line here to name it.
 */
export const FEATURES = {
	expressions: featureFromEvent("expr-basic", "{expression} in place of any numeric or quoted-string operand."),
	variables: featureFromEvent("meta-variables", "var/global/set meta-commands (RRF's local/global variables)."),
	m568: featureFromEvent("m568-added", "M568 (Set Tool Settings) — the modern alternative to G10's temperature form."),
	m563SpindleParam: featureFromEvent("m563-r-added", "M563's R parameter (spindle number mapped to a tool)."),
	lowercaseAxisLetters: featureFromEvent("lowercase-axis-letters", "Lowercase axis letters (a-l) from M584, quoted with a leading ' in G-code."),
	m309: featureFromEvent("m309-added", "M309 (heater feedforward) exists at all."),
	m309TemperatureFeedforward: featureFromEvent("m309-feedforward-added", "M309's T (temperature feedforward) and A parameters, not just S (PWM)."),
	commentIndentInsignificant: featureFromEvent("comment-indent-insignificant", "A comment line's own indentation no longer affects meta-gcode block nesting."),
	m116ScopedToMotionSystem: featureFromEvent("m116-scoped-to-motion-system", "Bare M116 (no params) only waits for tools of the invoking motion system."),
	m116ToolList: featureFromEvent("m116-p-colon-list", "M116's P may be a colon-separated tool list; bare P waits for every tool."),
	// Was pinned to a conservative "3.7.0-rc.1" before task 12's triage found the exact commit's tag
	// (`git describe --tags --contains 6aadff7c19` = "3.7.0-beta.1~73") - see the "expr-array-concat"
	// event for the corrected version.
	arrayConcatOperator: featureFromEvent("expr-array-concat", "The ^ operator concatenates two arrays in an expression."),
	singleAccelerometerScheme: featureFromEvent("m955-single-accelerometer", "M955/M956 collapsed to exactly one active accelerometer machine-wide; C mandatory, P capped to 0."),
	multiAccelerometerScheme: featureFromEvent("m955-p-uncapped", "M955/M956 support up to 10 independent accelerometer slots; P selects which."),
} as const satisfies Record<string, FeatureInfo>;

export type FeatureId = keyof typeof FEATURES;

/**
 * Whether `firmwareVersion` is new enough for `featureId`, failing CLOSED (false) on missing or
 * unparseable firmware — same convention as `firmwareAtLeast`. Throws on an unknown `featureId`
 * (a typo'd id is a bug to fix, not a silent "unsupported").
 */
export function supports(firmwareVersion: string | null | undefined, featureId: FeatureId): boolean {
	const feature = FEATURES[featureId];
	if (feature === undefined) {
		throw new Error(`supports(): unknown feature id "${String(featureId)}"`);
	}
	return firmwareAtLeast(firmwareVersion, feature.since);
}
