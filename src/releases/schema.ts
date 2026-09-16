/**
 * The release change-event shape (task 12, `docs/tasks/12-release-model.md`). `src/releases/
 * changes.ts` is the store built from this shape; nothing in this file is generated.
 */

export type ChangeEventTarget =
	| { type: "command"; code: string }
	| { type: "parameter"; code: string; letter: string }
	| { type: "objectModelPath"; path: string }
	| { type: "syntax"; feature: string }
	| { type: "behaviour"; code?: string; description: string };

export interface ChangeEvent {
	/** Stable, e.g. "m955-p-uncapped" - never reused for a different fact once published, so a
	 *  consumer can persist "I've already surfaced this one to the user" against it. */
	id: string;
	/** The RRF version this change first appears in. May be a real tag ("3.7.0-beta.1") or a
	 *  version that exists only in firmware builds, never as a tag ("3.7.0-rc.1+1") - see task 12's
	 *  own Traps; either way it must be a string `compareFirmwareVersions` (`../firmware.js`) can
	 *  parse, since `changesBetween` orders events by it. */
	version: string;
	kind: "added" | "removed" | "changed" | "deprecated";
	target: ChangeEventTarget;
	description: string;
	/** RRF commit SHAs, wiki section @sha, release notes - never empty (same citation bar as tasks
	 *  10/11's `sources` arrays). */
	sources: ReadonlyArray<string>;
}

/**
 * A stable string key identifying WHAT a target refers to, independent of version/kind/description -
 * two events with the same key describe the same evolving fact at different points in RRF's history
 * (e.g. M955's P parameter being capped to 0 at one version, then uncapped again at a later one).
 * `impact.ts`'s `collapseSuperseded` groups by this to find a chain of changes to one target and keep
 * only whichever is relevant to a given query's destination version - see that module for why.
 *
 * Two hand-written events that are really about the same fact MUST share a target for this to work -
 * this bit a real case once: M955's "P capped to 0" (3.7.0-rc.1) was originally authored as a
 * `behaviour` target (code only, no letter) while its own reversal, "P uncapped" (3.7.0-rc.1+1), was a
 * `parameter` target - two different keys for what is obviously one evolving fact about the same
 * parameter. Fixed by re-targeting the first event at `{ type: "parameter", code: "M955", letter: "P" }`
 * too (see `changes.ts`'s own comment on `m955-single-accelerometer`). When adding a hand-written event
 * that supersedes or is superseded by an existing one, target the same specific thing the existing
 * event targets, not a broader/looser shape that happens to also be true.
 */
export function targetKey(target: ChangeEventTarget): string {
	switch (target.type) {
		case "command": return `command:${target.code}`;
		case "parameter": return `parameter:${target.code}:${target.letter.toUpperCase()}`;
		case "objectModelPath": return `objectModelPath:${target.path}`;
		case "syntax": return `syntax:${target.feature}`;
		case "behaviour": return `behaviour:${target.code ?? ""}:${target.description}`;
	}
}
