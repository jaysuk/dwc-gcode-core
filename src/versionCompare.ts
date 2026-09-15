/**
 * RRF firmware version parsing and comparison — split out of `firmware.ts` (task 12) so
 * `src/releases/changes.ts` can compare versions without creating an import cycle (`firmware.ts`'s
 * `FEATURES` reads its `since`/`source` from the change-event store `changes.ts` builds, and that
 * store needs to compare versions itself — this module is the one thing both sides can depend on
 * without depending on each other). `firmware.ts` re-exports everything here; nothing about this
 * split is visible to a consumer importing `dwc-gcode-core/firmware`.
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
