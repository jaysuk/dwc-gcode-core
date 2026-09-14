/**
 * Firmware version parsing/comparison, and a small table of what changed in which RRF release.
 *
 * Merged from two copies that diverged after one was copied into the other: resonance-lab's
 * `src/config/firmwareVersion.ts` (the original, which later grew the `+N` build-number tiebreaker
 * below) and duet-calibration-wizard's `src/model/firmwareVersion.ts` (a copy, per that file's own
 * header, that never got the tiebreaker back-ported — latent there, since neither of that plugin's
 * own gates currently need resolution at that level).
 *
 * RRF version strings are semver-ish but not strictly semver: the STM32 port appends a parenthesised
 * suffix - `3.7.0-rc.1(CAN0)`, `3.7.0-beta.1(no 3rd order motion)` (with a SPACE before the paren,
 * despite that file's own comment claiming the version must not contain spaces). Any comparison MUST
 * strip that suffix first, or every STM32H7 board - the main phase-stepping platform - reports an
 * unparseable version and a fail-closed gate hides the feature from exactly the hardware it targets.
 */

/**
 * @remarks Real semver calls a `+N` suffix "build metadata" and defines it as precedence-NEUTRAL,
 * but RRF uses it as a genuine sequential counter WITHIN one prerelease tag - confirmed by reading
 * two consecutive firmware commits' `Version.h` diffs, both bumping only this number while leaving
 * `"rc.1"` itself unchanged (RepRapFirmware's multi-accelerometer commits, one day apart, both
 * reporting `"3.7.0-rc.1"` then `"3.7.0-rc.1+1"`). Compared as the LAST tiebreaker in
 * `compareFirmwareVersions`, only once everything else is already equal; undefined (compared as 0)
 * when absent, so `"3.7.0-rc.1" < "3.7.0-rc.1+1" < "3.7.0-rc.1+2"`. A non-numeric suffix (real build
 * metadata, e.g. a git hash) leaves this undefined and is otherwise ignored, same as if it were absent.
 */
export interface ParsedVersion {
	major: number;
	minor: number;
	patch: number;
	prerelease: Array<string | number>;
	build?: number;
}

/** Split a prerelease string into identifiers, breaking at ".", "-", and letter/digit boundaries. */
function splitPrerelease(raw: string): Array<string | number> {
	const parts = raw.split(/[.-]/).flatMap((piece) => piece.split(/(?<=[a-zA-Z])(?=[0-9])|(?<=[0-9])(?=[a-zA-Z])/));
	return parts
		.filter((p) => p.length > 0)
		.map((p) => (/^\d+$/.test(p) ? parseInt(p, 10) : p));
}

/**
 * Parse an RRF-reported version string. Strips a parenthesised suffix (the STM32 port's
 * VERSION_SUFFIX) and a leading "v" first, then captures a numeric "+N" suffix as `build` (see
 * `ParsedVersion.build`) before matching semver on what's left. A non-numeric suffix after "+" (real
 * build metadata, e.g. a git hash) is dropped entirely, same as before `build` existed.
 */
export function parseFirmwareVersion(raw: string): ParsedVersion | null {
	if (!raw) {
		return null;
	}
	let s = raw.split("(")[0].trim();
	s = s.replace(/^v/i, "");

	let build: number | undefined;
	const plusIndex = s.indexOf("+");
	if (plusIndex !== -1) {
		const buildPart = s.slice(plusIndex + 1);
		s = s.slice(0, plusIndex);
		if (/^\d+$/.test(buildPart)) {
			build = parseInt(buildPart, 10);
		}
	}

	const m = /^(\d+)\.(\d+)(?:\.(\d+))?(.*)$/.exec(s);
	if (!m) {
		return null;
	}
	const major = parseInt(m[1], 10);
	const minor = parseInt(m[2], 10);
	const patch = m[3] !== undefined ? parseInt(m[3], 10) : 0;
	const rest = m[4].replace(/^[.-]/, "");
	const prerelease = rest ? splitPrerelease(rest) : [];
	return build !== undefined ? { major, minor, patch, prerelease, build } : { major, minor, patch, prerelease };
}

/** Compare two prerelease identifiers per semver precedence: numeric < alphanumeric; numeric compares numerically. */
function compareIdentifier(a: string | number, b: string | number): number {
	const aNum = typeof a === "number", bNum = typeof b === "number";
	if (aNum && bNum) {
		return a === b ? 0 : (a as number) < (b as number) ? -1 : 1;
	}
	if (aNum !== bNum) {
		return aNum ? -1 : 1; // numeric identifiers have lower precedence than alphanumeric
	}
	return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Compare two firmware version strings. Semver precedence: major, minor, patch; then a version with
 * NO prerelease outranks one WITH a prerelease (3.7.0 > 3.7.0-rc.1); then prerelease identifiers
 * compare pairwise, and if all shared identifiers are equal the longer list wins; then, ONLY once all
 * of that is tied, a "+N" build number breaks the tie (3.7.0-rc.1+1 > 3.7.0-rc.1; see
 * `ParsedVersion.build` for why this departs from real semver, which treats build metadata as
 * precedence-neutral - RRF does not use it that way).
 *
 * This is a genuine three-way comparator, not just an "is at least" gate - deliberately, so it also
 * answers the DOWNGRADE question correctly: `compareFirmwareVersions(older, newer) < 0` holds exactly
 * as reliably as the reverse. A file-stamp-diffing feature (comparing a file's stamped version against
 * a board's current one in EITHER direction) depends on this; `firmwareAtLeast` alone would not do.
 *
 * @returns -1 if a < b, 0 if equal, 1 if a > b. Throws if either string fails to parse - callers that
 * need a safe boolean should use firmwareAtLeast instead.
 */
export function compareFirmwareVersions(a: string, b: string): number {
	const pa = parseFirmwareVersion(a);
	const pb = parseFirmwareVersion(b);
	if (!pa || !pb) {
		throw new Error(`Cannot compare unparseable firmware version: "${a}" vs "${b}"`);
	}
	if (pa.major !== pb.major) { return pa.major < pb.major ? -1 : 1; }
	if (pa.minor !== pb.minor) { return pa.minor < pb.minor ? -1 : 1; }
	if (pa.patch !== pb.patch) { return pa.patch < pb.patch ? -1 : 1; }

	const aHasPre = pa.prerelease.length > 0, bHasPre = pb.prerelease.length > 0;
	if (aHasPre !== bHasPre) {
		return aHasPre ? -1 : 1; // no prerelease outranks any prerelease
	}
	const len = Math.min(pa.prerelease.length, pb.prerelease.length);
	for (let i = 0; i < len; i++) {
		const cmp = compareIdentifier(pa.prerelease[i], pb.prerelease[i]);
		if (cmp !== 0) {
			return cmp;
		}
	}
	if (pa.prerelease.length !== pb.prerelease.length) {
		return pa.prerelease.length < pb.prerelease.length ? -1 : 1; // longer list wins on a tie
	}
	const ba = pa.build ?? 0, bb = pb.build ?? 0;
	if (ba !== bb) {
		return ba < bb ? -1 : 1;
	}
	return 0;
}

/**
 * Whether `actual` is at least `required`, failing CLOSED (false) on anything that doesn't parse -
 * missing, empty, or unparseable firmware means "unsupported", never "assume it's fine".
 */
export function firmwareAtLeast(actual: string | null | undefined, required: string): boolean {
	if (!actual) {
		return false;
	}
	const pa = parseFirmwareVersion(actual);
	const pb = parseFirmwareVersion(required);
	if (!pa || !pb) {
		return false;
	}
	return compareFirmwareVersions(actual, required) >= 0;
}

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

/**
 * Curated, not exhaustive — one entry per fact this package or a consumer has actually needed and
 * verified, never speculative. Extending this table is the main payoff of `scripts/rrf-triage.mjs`:
 * a syntax-affecting commit between two RRF tags becomes a candidate entry here, cited to that
 * commit, not to a guess.
 */
export const FEATURES = {
	expressions: {
		since: "3.01",
		description: "{expression} in place of any numeric or quoted-string operand.",
		source: "wiki Gcode_meta_commands.md \"Use of expressions within GCode commands\"",
	},
	variables: {
		since: "3.3",
		description: "var/global/set meta-commands (RRF's local/global variables).",
		source: "wiki Gcode_meta_commands.md \"Variables\": \"Supported from RRF 3.3\"",
	},
	m568: {
		since: "3.3",
		description: "M568 (Set Tool Settings) — the modern alternative to G10's temperature form.",
		source: "wiki Gcodes.md \"## M568: Set Tool Settings\": \"Available in RepRapFirmware 3.3 and later\"",
	},
	m563SpindleParam: {
		since: "3.3",
		description: "M563's R parameter (spindle number mapped to a tool).",
		source: "wiki Gcodes.md \"## M563\": \"(RRF >= 3.3)\"",
	},
	lowercaseAxisLetters: {
		since: "3.4",
		description: "Lowercase axis letters (a-l) from M584, quoted with a leading ' in G-code.",
		source: "wiki Gcodes.md \"## M584\": \"UVWABCDabcdefghijkl available in RepRapFirmware 3.4\"",
	},
	m309: {
		since: "3.4",
		description: "M309 (heater feedforward) exists at all.",
		source: "wiki Gcodes.md \"## M309\": \"Supported in RepRapFirmware v3.4 and later\"",
	},
	m309TemperatureFeedforward: {
		since: "3.6.0",
		description: "M309's T (temperature feedforward) and A parameters, not just S (PWM).",
		source: "wiki Gcodes.md \"## M309\": \"Supported in RRF 3.6.0 and later\" (the T parameter specifically)",
	},
	commentIndentInsignificant: {
		since: "3.6.0",
		description: "A comment line's own indentation no longer affects meta-gcode block nesting.",
		source: "wiki Gcode_meta_commands.md \"Indentation of comments\"",
	},
	m116ScopedToMotionSystem: {
		since: "3.5.0",
		description: "Bare M116 (no params) only waits for tools of the invoking motion system.",
		source: "wiki Gcodes.md \"## M116\": \"in RRF 3.5.0 and later, the scope of tool heaters...\"",
	},
	m116ToolList: {
		since: "3.7.0-beta.3",
		description: "M116's P may be a colon-separated tool list; bare P waits for every tool.",
		source: "wiki Gcodes.md \"## M116\": \"In RRF 3.7.0-beta.3 and later this may be a colon-separated list\"",
	},
	arrayConcatOperator: {
		// Conservative: the commit lands somewhere between 3.6.3 and 3.7.0-rc.1 (found via
		// scripts/rrf-triage.mjs, not dated to an exact intermediate beta) - "3.7.0-rc.1" is the
		// latest it could be, so `supports()` never reports true earlier than the feature is real,
		// only possibly later than it needs to be.
		since: "3.7.0-rc.1",
		description: "The ^ operator concatenates two arrays in an expression.",
		source: "RRF commit 6aadff7c19 \"feat: allow arrays to be concatenated with ^\" (between 3.6.3 and 3.7.0-rc.1)",
	},
	singleAccelerometerScheme: {
		since: "3.7.0-rc.1",
		description: "M955/M956 collapsed to exactly one active accelerometer machine-wide; C mandatory, P capped to 0.",
		source: "RepRapFirmware commit 81d68e1",
	},
	multiAccelerometerScheme: {
		since: "3.7.0-rc.1+1",
		description: "M955/M956 support up to 10 independent accelerometer slots; P selects which.",
		source: "RepRapFirmware commit ee3c80b / Duet3Expansion commit 73549e0",
	},
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
