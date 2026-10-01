/**
 * The release change-event shape (task 12, `docs/tasks/12-release-model.md`). `src/releases/
 * changes.ts` is the store built from this shape; nothing in this file is generated.
 */

export type ChangeEventTarget =
	| { type: "command"; code: string }
	/** `whenAbsent` flips the match: the event concerns a line that does NOT give `letter`. `"upgrade"` is for a
	 *  parameter RRF used to default when omitted and now insists on (`M955 P`) - a line without it is only a
	 *  problem moving TO the version that requires it, never back. `true` is for one whose default merely
	 *  changed (`M303 F`: 0.7 then 0.8), which differs whichever way the file moves.
	 *  `whenValue` narrows the match to a line whose value for `letter` is one of these (a number compares
	 *  numerically, so `3`, `03` and `3.0` are one value; text compares case-insensitively with its quotes
	 *  dropped): the change is about one accepted VALUE, not the letter (`M558 P3`, a probe type 3.7 rejects).
	 *  A listed text ending in `*` is a prefix (`fm*` matches the pin name `fm0.switch`).
	 *  A `{...}` expression or a bare letter never matches, since its value is not known from the file. It
	 *  cannot be combined with `whenAbsent`.
	 *  `whenCompanion` narrows the match to a command line whose OTHER letter `letter` has one of `values` as a literal
	 *  (compared like `whenValue`): the change belongs to one selector value of a command that reads different letters
	 *  per selector (`M669 K9`'s `D`, not the serial SCARA's `D`). A line that omits the companion or gives an expression
	 *  never matches - the file does not say which variant it means. It cannot be combined with `whenAbsent`.
	 *  `whenElements` narrows the match to a parameter whose literal value is a colon-separated list of exactly that many
	 *  elements (`M669 K9 D100:100`, the two-value form 3.6.3 rejected); an expression never matches. Cannot be
	 *  combined with `whenAbsent`.
	 *  `alsoAbsent` goes with `whenAbsent`: the line must ALSO leave out each of these letters, for a change to a command's
	 *  "nothing said" form that stops mattering as soon as any of several letters is given (bare `M116`, which with P, H or C
	 *  waits for what they name). */
	| { type: "parameter"; code: string; letter: string; whenAbsent?: true | "upgrade"; alsoAbsent?: ReadonlyArray<string>; whenValue?: ReadonlyArray<string>;
		whenCompanion?: { letter: string; values: ReadonlyArray<string> }; whenElements?: ReadonlyArray<number> }
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
		case "parameter": return `parameter:${target.code}:${target.letter.toUpperCase()}${target.whenAbsent !== undefined ? ":absent" : ""}${target.alsoAbsent !== undefined ? `:and-absent=${[...target.alsoAbsent].map((l) => l.toUpperCase()).sort().join("")}` : ""}${target.whenValue !== undefined ? `:value=${[...target.whenValue].map((v) => v.toLowerCase()).sort().join("|")}` : ""}${target.whenCompanion !== undefined ? `:with=${target.whenCompanion.letter.toUpperCase()}=${[...target.whenCompanion.values].map((v) => v.toLowerCase()).sort().join("|")}` : ""}${target.whenElements !== undefined ? `:elements=${[...target.whenElements].sort((a, b) => a - b).join("|")}` : ""}`;
		case "objectModelPath": return `objectModelPath:${target.path}`;
		case "syntax": return `syntax:${target.feature}`;
		case "behaviour": return `behaviour:${target.code ?? ""}:${target.description}`;
	}
}
