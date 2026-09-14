# 12 — Release model: what changed between any two RRF releases

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
