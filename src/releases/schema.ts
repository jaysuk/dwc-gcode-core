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
