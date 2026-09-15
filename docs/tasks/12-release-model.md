# 12 — Release model: what changed between any two RRF releases

**Status: Done, at a deliberately reduced scope the user approved** — steps 1-2 fully done; step 3
closed for the two subsystems most relevant to this package (`GCodeBuffer`, `GCodes dispatch`), the
other 19 subsystems and the wiki commits explicitly deferred; steps 4-5 (events store,
`changesBetween`/`impactOf`, `FEATURES` migration) done against that reduced-but-real scope. The
`rrf-3.7.0-rc.1` tag is **not** pushed - the task's own acceptance criterion (full closure) isn't met,
and this file says so rather than tagging anyway.

## Findings (2026-09-15)

### Steps 1-2: the real scope

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
significant enough to flag before continuing to spend turns on it silently.

### The user's chosen scope reduction

Given the choice between grinding through all 504 items across many further turns or taking a
narrower, still-real slice now, the user chose the latter: **triage `GCodeBuffer` and `GCodes
dispatch` only** (146 distinct commits between them, the two subsystems most likely to affect what
this package itself parses/dispatches), **build the actual events store and API against that**, and
defer the other 19 subsystems (`Movement` 116, `Platform` 73, `CAN` 48, `Heating` 30, `Endstops` 28,
`Networking` 26, `SBC` 25, and 12 smaller ones) plus the 138 wiki commits entirely.

**Closing the 146.** Read via `git show --stat`/`git show` (batched, not one-by-one from scratch) and
categorised: the large majority are merge-branch integrations (RRF's `3.6-dev`→`3.7-dev` merge
pattern, where a change already lands via its own direct commit and is then folded into the release
branch), compiler-warning/eCv-annotation/refactor-only changes, or plumbing this package has no
reason to model (SBC/USB channel handling, CAN-FD, simulation speed, driver diagnostics). None of
those got an individual citation - the checklist file itself (all 173 checkbox lines across the two
sections now ticked) is the record of what was read, with a summary note at the top of each section
rather than 146 near-identical "no effect" annotations.

**22 hand-written events came out of the substantive minority**, each version-pinned with
`git -C <RRF clone> describe --tags --contains <sha>` (the earliest tag whose ancestry contains the
commit - NOT the commit's own date, which can precede the tag that ships it by months) rather than
guessed:

- `expr-array-literal` (3.7.0-alpha.2) - array literal syntax `[e,e,e...]`.
- `expr-array-concat` (3.7.0-beta.1) - **corrects** the pre-existing `FEATURES.arrayConcatOperator`
  entry, which the task's own Gap section flagged as one of two misleading entries; it had been
  conservatively pinned to "3.7.0-rc.1" for lack of an exact date. The exact commit (`6aadff7c19`) was
  already known; this task just pinned its real tag.
- `expr-exists-argument-forms` (3.7.0-alpha.2) - `exists(#x)`/`exists(x[0])` accepted even when the
  argument isn't an array (previously restricted) - task 07's own Findings already noted this as
  "real RRF grammar this parser deliberately doesn't replicate"; recorded as an event regardless so
  `changesBetween` at least surfaces the fact even though `impactOf` can't yet detect uses of it.
- `m408-removed` (3.7.0-alpha.2), `m301-removed`/`m304-removed` (3.7.0-beta.1) - the latter two
  **independently confirm** task 10's own RRF-source finding that M301/M304 no longer dispatch,
  now with an exact commit and version.
- `m140-h-colon-list` (3.7.0-beta.1) - multi-heater bed/chamber assignment; also applied as a real
  `since` update to `dictionary/commands.json`'s existing M140 `H` parameter entry.
- `m558-4-added`, `m564-r-added` (3.7.0-beta.3).
- `m221-f-added` (3.7.0-rc.1) - a genuine dictionary GAP this triage surfaced: M221's `F1` parameter
  (apply the extrusion factor immediately, bypassing the jerk-limited ramp) wasn't in task 10's
  reviewed M221 entry at all; added to `dictionary/commands.json` with a real citation and `since`.
- The pre-existing `FEATURES` table's other 11 entries were migrated into events unchanged (same
  version/description/source each already had) so `FEATURES` could become a genuine view over the
  store rather than a second, disconnected copy - see "FEATURES becomes a view" below.
- One thing found but **not** turned into an event: `M140.1` was added (`f526e7b1c1`, first in
  `3.7.0-alpha.2`) then reverted (`12a2bd3d14`, first in `3.7.0-beta.1`) - both transitions happen
  between two of our tracked-with-data versions' own boundaries in a way that never actually differs
  at any two versions this package's dictionary/object-model schemas have real data for. Recorded
  here as a real historical fact, not modelled as an event since it would never fire for any query
  this package can actually answer.

### Steps 4-5: the events store, `changesBetween`, `impactOf`, `FEATURES`

- **`src/releases/schema.ts`** - the `ChangeEvent`/`ChangeEventTarget` shape, exactly per the task's
  own sketch.
- **`src/releases/changes.ts`** - `CHANGES`, merged from three sources: the 22 hand-written events
  above; `changesFromDictionary()`-equivalent logic reading `dictionary/commands.json`'s own
  `since`/`until`/`deprecated` fields (task 10's schema already had these fields; almost no reviewed
  entry had them populated before this task, since task 10's own scope was existence/shape, not
  history - this generator will pick up whatever gets filled in later without this file changing
  again); and every one of task 11's 709 object-model paths with a `since`/`until`/`deprecated` set
  (105 of them do). `changesBetween(from, to)` compares with `compareFirmwareVersions`
  (`versionCompare.ts`, see below), selecting `(min, max]` and annotating `direction` - the same
  convention task 11's `objectModelChanges` already established, including the "the version reported
  is the real transition point, not the query range's own endpoint" fix that task needed too (written
  correctly here from the start, having already found that bug once).
- **`src/releases/impact.ts`** - `impactOf(doc, from, to)`. Coverage is real but partial, stated
  plainly in the module's own header rather than implied to be complete: exact for `command`/
  `parameter`/`objectModelPath` targets (matched against the document's own lexed commands and
  `expressionsOfLine`'s extracted paths); for `syntax` targets, only the two features this module can
  recognise in an `ExprNode` AST (`array-literal`, `array-concat` - flagged on any `^` use, since
  whether both operands are actually arrays can depend on a variable's runtime value this module
  can't know statically, and the finding's own message says so); any other `syntax` feature id and
  any `behaviour` target with no `code` are silently skipped, not falsely reported as absent.
- **`src/versionCompare.ts`** (new) - `firmware.ts`'s version parsing/comparison engine, moved out
  verbatim. Needed because `FEATURES` now reads its facts from `changes.ts`, and `changes.ts` needs to
  compare versions itself - keeping the comparator in `firmware.ts` would make `firmware.ts` import
  `changes.ts` AND `changes.ts` import `firmware.ts`, a real cycle. `firmware.ts` re-exports
  everything from here unchanged, so `dwc-gcode-core/firmware` consumers see no difference.
- **`FEATURES` becomes a view over events** (the task's own decision): each entry is now
  `featureFromEvent(eventId, description)`, reading `since`/`source` from the matching `CHANGES`
  entry instead of duplicating them. All 13 entries kept their exact prior `since`/`source` except
  `arrayConcatOperator`, which is now precisely dated (see above). The two "misleading" entries the
  task's own Gap section named are now backed by real, independently-queryable events:
  `singleAccelerometerScheme`/`multiAccelerometerScheme` (M955/M956's P-capped-to-0 boundary) and
  `m116ScopedToMotionSystem`/`m116ToolList` (M116's P-becomes-a-list boundary) were ALREADY two
  separate hand-dated `FEATURES` entries each (not one misleading boolean) - the real gap `supports()`
  alone could never close is that a document scanner has no way to check WHICH of a pair of boundaries
  a real file crosses; `impactOf` is what actually closes that gap, by matching the specific
  parameter target directly against a document instead of only answering "is firmware X new enough".
- `test/releases.test.ts` (20 tests): `CHANGES` shape/uniqueness/citation checks; `changesBetween`
  symmetry and boundary-inclusion (task's own "(min, max]" convention, matching task 11); `impactOf`
  fixtures for a removed command (M408) in both directions, a genuinely new object-model path
  reached via `echo`, and a `^` expression flagged only against a downgrade target old enough to
  matter; the two corrected `FEATURES` entries.

### What's still open

The other 19 subsystems (`Movement`, `Platform`, `CAN`, `Heating`, `Endstops`, `Networking`, `SBC`,
`Storage`, `Tools`, `Accelerometers`, `ClosedLoop`, `Display`, `Fans`, `FilamentMonitors`, `GCodes`
(the small directly-named-`GCodes`-subsystem bucket, distinct from `GCodes dispatch`), `GPIO`,
`LedStrips`, `ObjectModel`, `PrintMonitor`) and the 138 wiki `Gcodes.md` commits remain entirely
untriaged - `docs/rrf-triage/3.6.3..3.7.0-rc.1.md` still has every one of their checkboxes unticked.
`rrf-3.7.0-rc.1` is not tagged. Extending `CHANGES`/`dictionary/commands.json`/
`src/objectmodel/schema.ts` with whatever those subsystems turn up is real, valid follow-up work for
whoever picks this up next (very possibly this same package, in a later session) - the infrastructure
built here (the triage script, the events store, the two generators, `changesBetween`/`impactOf`)
needs no further changes to absorb it, only more citations.

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
