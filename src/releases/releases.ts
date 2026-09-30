/**
 * The RepRapFirmware releases this package tracks change events across, oldest first. The single source of
 * truth for "which versions exist in the window": `OBJECT_MODEL_VERSIONS` and every `ChangeEvent.version`
 * at or after `RELEASES[0]` must be a member (`test/releases.test.ts` holds them to it).
 *
 * Two kinds of entry:
 *  - `tag`: a real `Duet3D/RepRapFirmware` git tag (`git tag --list '3.6*' '3.7*'`; the window has no others).
 *  - `build`: a dev build between two tags that reports its own `Version.h` string but was never tagged.
 *    `3.7.0-rc.1+N` is the Nth `Version.h` bump after the `rc.1` tag (RRF uses `+N` as a sequential counter
 *    within one prerelease, see `ParsedVersion.build`). Pin such an id to the commit whose tree first
 *    reads it: `git show <sha>:src/Version.h`, never `git describe`, which names the last tag instead.
 */
import { compareFirmwareVersions } from "../versionCompare.js";

export interface RrfRelease {
	/** The version string RRF reports (`M115`, `boards[0].firmwareVersion`), without a `(CAN0)`-style suffix. */
	version: string;
	kind: "tag" | "build";
	/** ISO date the release was published (tag: the GitHub release or the tag itself); absent for a build. */
	date?: string;
	/** Present on a `build`: the tag it follows. */
	after?: string;
}

export const RELEASES: ReadonlyArray<RrfRelease> = [
	{ version: "3.6.3", kind: "tag", date: "2026-06-02" },
	{ version: "3.7.0-alpha.2", kind: "tag", date: "2026-03-09" },
	{ version: "3.7.0-beta.1", kind: "tag", date: "2026-06-22" },
	{ version: "3.7.0-beta.2", kind: "tag", date: "2026-07-28" },
	{ version: "3.7.0-beta.3", kind: "tag", date: "2026-08-18" },
	{ version: "3.7.0-rc.1", kind: "tag", date: "2026-09-08" },
	{ version: "3.7.0-rc.1+1", kind: "build", after: "3.7.0-rc.1" },
	{ version: "3.7.0-rc.1+2", kind: "build", after: "3.7.0-rc.1" },
	{ version: "3.7.0-rc.1+3", kind: "build", after: "3.7.0-rc.1" },
	{ version: "3.7.0-rc.2", kind: "tag", date: "2026-09-26" },
];

/** The oldest tracked release: anything older is "before the window". */
export const OLDEST_TRACKED_RELEASE: string = RELEASES[0].version;

/** The newest tracked release. */
export const NEWEST_TRACKED_RELEASE: string = RELEASES[RELEASES.length - 1].version;

/** True when `version` is exactly one of `RELEASES` (compared as versions, so `3.7.0-rc.2(CAN0)` counts). */
export function isTrackedRelease(version: string): boolean {
	return RELEASES.some((r) => compareFirmwareVersions(r.version, version) === 0);
}
