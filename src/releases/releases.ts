/**
 * The RepRapFirmware versions this package tracks change events across, oldest first. The single source of
 * truth for "which versions exist in the window": `OBJECT_MODEL_VERSIONS` and every `ChangeEvent.version`
 * at or after `RELEASES[0]` must be a member (`test/releases.test.ts` holds them to it), and
 * `scripts/audit-releases.mjs` holds every entry to a real RRF clone (`docs/rrf-triage/README.md`).
 *
 * What a "version" is: the string `src/Version.h`'s `MAIN_VERSION` reads, which is what a board reports. Two kinds:
 *  - `tag`: a real `Duet3D/RepRapFirmware` git tag (`git tag --list '3.6*' '3.7*'`). `commit` is the tagged commit and
 *    `date` its commit date (only `3.7.0-alpha.2` is an annotated tag; the rest are lightweight).
 *  - `build`: a `Version.h` string that was never tagged - RRF bumps it in a "Increased version to X" commit and
 *    builds from `3.7-dev` carry it. `alpha.3`..`alpha.8` (no tag between `alpha.2` and `beta.1`),
 *    `3.7.0-beta.2+1`, `3.7.0-beta.3+1` and `3.7.0-rc.1+1`..`+3` (`+N` is RRF's counter within one prerelease,
 *    `ParsedVersion.build`). `commit` is the FIRST commit whose own tree reads the string (`git show <sha>:src/Version.h`,
 *    never `git describe`, which names the last tag instead). `after` is the tag it follows in version order.
 *
 * Pin rule for an event: the FIRST tracked release whose `commit` contains the change commit (`git merge-base
 * --is-ancestor <change> <release.commit>`; `git describe --contains`, but over builds as well as tags). A `Version.h`
 * string spans every commit between one bump and the next, and a tag is often a week or more after its own bump commit,
 * so two boards that both report `3.7.0-rc.1` can differ; pinning to the release that is certain to contain the change
 * errs toward warning, never toward silence. `scripts/audit-releases.mjs --events` checks every cited commit.
 *
 * `3.7.0-alpha` (a `Version.h` string only, 2026-02-18, before the first tag) is deliberately NOT tracked: every change that
 * landed before `alpha.2` is pinned to `alpha.2`, the first release that certainly contains it, and a board reporting the
 * bare `3.7.0-alpha` orders below `alpha.2`, so it is warned about all of them (the safe side).
 *
 * Topology: `3.7.0-alpha.2` (2026-03-09) is OLDER than `3.6.3` (2026-06-02) and does not contain its fixes (`3.6-dev` was
 * merged into `3.7-dev` between `beta.1` and `beta.2`), yet it orders after it by version. A per-release slice is
 * therefore "reachable from this release, not from the previous one, not from 3.6.3" (`scripts/audit-releases.mjs`,
 * `docs/rrf-triage/README.md`).
 */
import { compareFirmwareVersions } from "../versionCompare.js";

export interface RrfRelease {
	/** The version string RRF reports (`M115`, `boards[0].firmwareVersion`), without a `(CAN0)`-style suffix. */
	version: string;
	kind: "tag" | "build";
	/** ISO date of `commit` (a tag: the tagged commit; a build: the bump commit). */
	date?: string;
	/** Present on a `build`: the tag it follows in version order. */
	after?: string;
	/** Short SHA in `Duet3D/RepRapFirmware` (see the file comment for which commit). */
	commit?: string;
}

export const RELEASES: ReadonlyArray<RrfRelease> = [
	{ version: "3.6.3", kind: "tag", date: "2026-06-02", commit: "aebf62958" },
	{ version: "3.7.0-alpha.2", kind: "tag", date: "2026-03-09", commit: "18e855e0e" },
	{ version: "3.7.0-alpha.3", kind: "build", after: "3.7.0-alpha.2", date: "2026-04-03", commit: "24fc17017" },
	{ version: "3.7.0-alpha.4", kind: "build", after: "3.7.0-alpha.2", date: "2026-04-15", commit: "3f76f7e1b" },
	{ version: "3.7.0-alpha.5", kind: "build", after: "3.7.0-alpha.2", date: "2026-05-05", commit: "0823da26e" },
	{ version: "3.7.0-alpha.6", kind: "build", after: "3.7.0-alpha.2", date: "2026-05-22", commit: "4ab5c1eec" },
	{ version: "3.7.0-alpha.7", kind: "build", after: "3.7.0-alpha.2", date: "2026-06-10", commit: "fb37fd6e3" },
	{ version: "3.7.0-alpha.8", kind: "build", after: "3.7.0-alpha.2", date: "2026-06-15", commit: "1786ee658" },
	{ version: "3.7.0-beta.1", kind: "tag", date: "2026-06-21", commit: "d622ec351" },
	{ version: "3.7.0-beta.2", kind: "tag", date: "2026-07-28", commit: "788de6e8c" },
	{ version: "3.7.0-beta.2+1", kind: "build", after: "3.7.0-beta.2", date: "2026-08-07", commit: "25e8eae82" },
	{ version: "3.7.0-beta.3", kind: "tag", date: "2026-08-18", commit: "5aae39a74" },
	{ version: "3.7.0-beta.3+1", kind: "build", after: "3.7.0-beta.3", date: "2026-08-20", commit: "89f7cd068" },
	{ version: "3.7.0-rc.1", kind: "tag", date: "2026-09-08", commit: "6bdc5514e" },
	{ version: "3.7.0-rc.1+1", kind: "build", after: "3.7.0-rc.1", date: "2026-09-09", commit: "ee3c80b6b" },
	{ version: "3.7.0-rc.1+2", kind: "build", after: "3.7.0-rc.1", date: "2026-09-10", commit: "52a883cc2" },
	{ version: "3.7.0-rc.1+3", kind: "build", after: "3.7.0-rc.1", date: "2026-09-17", commit: "c2e3866ea" },
	{ version: "3.7.0-rc.2", kind: "tag", date: "2026-09-26", commit: "36388362c" },
];

/** The oldest tracked release: anything older is "before the window". */
export const OLDEST_TRACKED_RELEASE: string = RELEASES[0].version;

/** The newest tracked release. */
export const NEWEST_TRACKED_RELEASE: string = RELEASES[RELEASES.length - 1].version;

/** True when `version` is exactly one of `RELEASES` (compared as versions, so `3.7.0-rc.2(CAN0)` counts). */
export function isTrackedRelease(version: string): boolean {
	return RELEASES.some((r) => compareFirmwareVersions(r.version, version) === 0);
}
