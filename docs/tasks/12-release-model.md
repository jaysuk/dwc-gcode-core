# 12 — Release model: what changed between any two RRF releases

**Status: In progress — steps 1-2 done (script rebuilt, checklist generated); step 3 (closing every
item) is a much larger undertaking than the task file's own numbers assumed. See Findings.**

## Findings (2026-09-15, steps 1-2)

**The task's own "148 commits" figure was for the OLD, narrower watch list** (`src/GCodes/
GCodeBuffer/` + `src/GCodes/GCodes*.cpp` only, 8 files) — re-run locally against the actual clone it
comes to 157 (close enough; the small difference is almost certainly the compare-API-vs-local-git
boundary-date handling the old script's own comment already flagged as approximate). **The broader
watch list this task itself introduces is a different order of magnitude**: `git grep`-ing
`3.7.0-rc.1` for every `gb\.(Seen|MustSee|TryGet|GetUnprecedentedString)` file, every
`OBJECT_MODEL_TABLE` file, and everything under `GCodeBuffer/` gives **97 distinct files**, not 8-9.
Rebuilt `scripts/rrf-triage.mjs` (per Steps 1: local-git-primary, `gh` fallback, subsystem grouping,
wiki commits) against `3.6.3..3.7.0-rc.1` and it found:

- **366 RepRapFirmware commits** across 21 subsystems (of 682 total in the range) — `GCodeBuffer` 54,
  `GCodes dispatch` 119, `Movement` 116, `Platform` 73, `CAN` 48, `Endstops` 28, `Heating` 30,
  `Networking` 26, `SBC` 25, and 12 smaller subsystems totalling the rest. Written to
  `docs/rrf-triage/3.6.3..3.7.0-rc.1.md`.
- **138 wiki `Gcodes.md` commits** in the same date window, each with the `##`/`###` section headings
  its own patch touches (via the GitHub API's diff media type — this repo has no local wiki-content
  clone).

**504 items total.** Closing each one properly — the task's own bar, matching every other task in
this queue — means reading the actual diff, deciding whether it's *no effect on files* / *event
added* / *dictionary or schema updated*, and for the latter two, doing the same real citation work
task 10 and 11 did per item. A first skim of just the small subsystems already shows real,
dictionary-affecting changes hiding in commit subjects that don't announce themselves as such
("Renamed 'Old', 'New', 'NewNew' message type suffices to V0, V1, V2", "Revert type of
heat.heaters[].model.pid.used to bool") alongside ones that are self-evidently a real find ("Removed
support for M301 and M304" — independently confirms task 10's own finding about those two codes;
"Added M950 heater B parameter"; "Added M558.4 to manually tare a load cell probe"; "Fixed M574 K
parameter not being range checked"). This is not a list that can be closed by pattern-matching commit
subjects alone — several "boring-sounding" ones turn out to matter and several "exciting-sounding"
ones (mass `Merge branch '3.6-dev' into 3.7-dev` commits, `eCv`/annotation/compiler-warning commits)
don't.

**This is a genuinely large, multi-session undertaking** — not a "stop point" in the sense of a false
premise (nothing here is wrong; the task's own broader watch-list decision is correct and the 97-file/
366-commit/138-wiki-commit scope is what actually implementing it produces), but a scale finding
significant enough to flag before continuing to spend turns on it silently. Steps 3-5 (closing every
item, building the events store/`changesBetween`/`impactOf`, migrating `FEATURES`, tagging
`rrf-3.7.0-rc.1`) are not started.

## The gap

- `FEATURES` in `src/firmware.ts` can only say "available since X". It can't express removals,
  behaviour changes or deprecations, and two entries already mislead: `singleAccelerometerScheme`
  ("P capped to 0" stops being true at `3.7.0-rc.1+1`) and `m116ScopedToMotionSystem` (changed again
  at `3.7.0-beta.3`).
- `scripts/rrf-triage.mjs` watches only `src/GCodes/GCodeBuffer/` and `src/GCodes/GCodes*.cpp` —
  about 9 of the ~70 files that read G-code parameters, and none of the object-model tables.
- The 3.6.3 → 3.7.0-rc.1 triage (148 commits) was generated and never closed, so no `rrf-` tag
  exists.

The stamp (task 09) needs to answer: "what in *this file* is affected between the stamped version and
the current one, upgrade **or** downgrade?"

## Decisions

- **Change events are the unit.**

  ```ts
  export interface ChangeEvent {
  	id: string;                       // stable, e.g. "m955-p-uncapped"
  	version: string;                  // the RRF version the change first appears in
  	kind: "added" | "removed" | "changed" | "deprecated";
  	target:
  		| { type: "command"; code: string }
  		| { type: "parameter"; code: string; letter: string }
  		| { type: "objectModelPath"; path: string }
  		| { type: "syntax"; feature: string }        // e.g. "array-concat"
  		| { type: "behaviour"; code?: string; description: string };
  	description: string;
  	sources: ReadonlyArray<string>;   // RRF commit SHAs, wiki section @sha, release notes
  }
  ```

  Stored in `src/releases/changes.ts`. Task 10's dictionary `since`/`until` and task 11's
  object-model lifetimes **generate** events; hand-written events cover behaviour and syntax.
- **Bidirectional**: `changesBetween(a, b)` returns events whose version lies in `(min, max]`, each
  annotated with `direction: "upgrade" | "downgrade"`. A downgrade inverts meaning: `added` becomes
  "not available on the target", usually the more dangerous case.
- `FEATURES`/`supports()` become a thin view over events (a feature = a named `added` event); the two
  misleading entries get follow-up events.
- **Triage is rebuilt on the local RRF clone** (read-only: `fetch --tags`, `log`, `show`, `grep`;
  never check out). Watched paths are computed at the `to` tag: every file matching
  `gb\.(Seen|MustSee|TryGet|GetUnprecedentedString)`, every file containing `OBJECT_MODEL_TABLE`,
  plus `src/GCodes/GCodeBuffer/`. Output groups commits by subsystem.
- The triage also lists the wiki's `Gcodes.md` commits between the two tags' dates (`gh api` commits
  on that path) and the sections they changed.

## API

```ts
export function changesBetween(fromVersion: string, toVersion: string): ReadonlyArray<ChangeEvent & { direction: "upgrade" | "downgrade" }>;
export interface ImpactFinding { event: ChangeEvent; direction: "upgrade" | "downgrade"; line: number; start: number; end: number; message: string }
export function impactOf(doc: GcodeDocument, fromVersion: string, toVersion: string): ReadonlyArray<ImpactFinding>;
```

`impactOf` matches events against the document: commands and parameters present (task 06), and
object-model paths and syntax used in expressions (task 07).

## Steps

1. Rebuild `scripts/rrf-triage.mjs` as above (a `--rrf <clone>` flag; `gh` only as a fallback), keeping
   its checklist output format.
2. Run it for `3.6.3..3.7.0-rc.1` → `docs/rrf-triage/3.6.3..3.7.0-rc.1.md`.
3. **Close every item** as one of: *no effect on files* / *event added* (id) / *dictionary or schema
   updated* (entry). Tick them in the file. This is the long part — work subsystem by subsystem, one
   commit per subsystem.
4. Implement the events store, the generators from tasks 10/11, `changesBetween` and `impactOf`;
   migrate `FEATURES`.
5. When step 3 is fully closed, tag that commit `rrf-3.7.0-rc.1` and push the tag — **this tag is
   allowed**: it isn't a release and doesn't trigger the release workflow.

## Tests

- Symmetry: `changesBetween(a, b)` and `changesBetween(b, a)` contain the same event ids with
  opposite directions.
- `impactOf` fixtures: an `M955` line in a 3.6.3-era config checked against 3.7.0-rc.1; an
  object-model path deprecated in the window; a `^` expression checked against 3.6.3 (a downgrade
  finding).
- The two corrected `FEATURES` entries behave correctly at `3.7.0-rc.1` and `3.7.0-rc.1+1`.

## Acceptance

Triage checklist fully closed and committed; `rrf-3.7.0-rc.1` tag pushed; events cover every closed
item that affects files; `impactOf` works in both directions.

## Traps

- Versions like `3.7.0-rc.1+1` exist in firmware builds but not as tags — events may use them, and
  must say so in `sources`.
- Most commits in a range are irrelevant; don't create an event without a file-visible effect.

## Out of scope

Releases before 3.6.3.
