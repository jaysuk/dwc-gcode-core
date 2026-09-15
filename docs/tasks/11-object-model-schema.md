# 11 — Object-model schema per RRF release

**Status: STOPPED — a Sources premise is false against real data. See Findings below.**

## Findings

Step 1's literal stop point (documentation.json's key format) resolved cleanly, but investigating it
surfaced a second, more consequential problem with the task's own Sources/Decisions.

**Version mapping** (the task's own first decision — exact RRF-git-tag-string ⇔ npm-version-string
match): `git -C RepRapFirmware tag --list` (255 tags) ∩ `npm view @duet3d/objectmodel versions`
(168 versions), by exact string equality, is 27 versions total. Restricted to this package's support
window (RRF 3.6.3 onward), the intersection is exactly **six**: `3.6.3`, `3.7.0-alpha.2`,
`3.7.0-beta.1`, `3.7.0-beta.2`, `3.7.0-beta.3`, `3.7.0-rc.1`. (RRF has more pre-releases in this range
— e.g. `3.6.2-beta.1`, `3.6.2-rc.1`, `3.6.3-rc.1`, `3.7.0-beta.4`..`beta.19` — that `@duet3d/
objectmodel` never published a matching version string for; per the task's own decision, these are
simply absent from the mapping, not estimated or interpolated.)

**Step 1, key format — clean, no blocker.** `documentation.json` at 3.7.0-rc.1 (691 keys) uses exactly
the `[]`-for-array-index normalisation task 07's `expressionsOfLine`/path handling already produces
(`"boards[].accelerometer.orientation"`, `"boards[].drivers[].closedLoop.currentFraction"`) — dotted
member access, `[]` for every array hop, no numeric indices anywhere in a key. Entries are `{ summary,
remarks? }` for an object/array-of-object path, or a bare string for a scalar leaf path. This confirms
the task's own hoped-for outcome: no adapter is needed between these keys and an expression path.

**The real problem: `documentation.json` does not exist at RRF 3.6.3 — the start of this package's own
support window.** Extracting the actual npm tarballs (not assumed from the task's Sources section)
shows:

| version | `documentation.json`? | `deprecations.json`? | `enums.json`? |
| --- | --- | --- | --- |
| `3.6.3` | **no** | yes | yes |
| `3.7.0-alpha.2` | **no** | yes | yes |
| `3.7.0-beta.1` | yes | yes | yes |
| `3.7.0-beta.2` | yes | yes | yes |
| `3.7.0-beta.3` | yes | yes | yes |
| `3.7.0-rc.1` | yes (691 entries) | yes | yes |

The file was added to the package somewhere between `3.7.0-alpha.2` and `3.7.0-beta.1` — confirmed by
extracting both tarballs directly (`3.6.3`'s `dist/` has only `deprecations.json`/`enums.json`; no
`documentation.json` anywhere in either package). The task's own Sources section states
"`@duet3d/objectmodel` — published for every RRF release in our window ... `documentation.json` has
691 entries" as if this were true across the whole window; it is only true from `3.7.0-beta.1`
onward. **3.6.3, this package's own oldest supported release, has no `documentation.json` at all.**

This breaks the Decisions section's stated schema design at its foundation: "one path list with
lifetimes ... `since` omitted = present at 3.6.3" assumes there is a 3.6.3 path list to establish
that baseline from `documentation.json` in the first place. There isn't one. Three ways to actually
get a 3.6.3 baseline exist, each with a real cost, and none of them is "diff two `documentation.json`
files" the way every other version-to-version step in this task would be:

1. **Read RRF 3.6.3 source's own `OBJECT_MODEL_TABLE` definitions directly** (the task's own
   fallback source, "the authoritative key list", ~63 files) to build a 3.6.3 baseline by hand/script
   from C++ macros instead of a generator's JSON diff. This is real, additional parsing work this
   task's Steps section doesn't currently budget for — it's a distinct code path from every other
   version transition (JSON-vs-JSON diff), not an extension of it.
2. **Move the package's effective object-model baseline to `3.7.0-beta.1`** and treat 3.6.3 as
   "known unsupported by this feature" rather than silently wrong — but this directly contradicts
   `docs/tasks/README.md`'s own stated firmware window, "RRF 3.6.3 onward", for this one subsystem.
3. **Treat every `documentation.json`-known path as `since: "3.7.0-beta.1"` even though most of them
   really existed at 3.6.3 too** — cheapest to build, but is exactly the kind of invented/wrong fact
   the house rules ("never invent a rule... if you can't cite it, it doesn't go in") forbid: a path
   that has existed since RRF's early history would incorrectly report `objectModelChanges("3.6.3",
   "3.7.0-beta.1")` as adding hundreds of paths that didn't actually change.

None of these is a small implementation detail — each changes what "3.6.3" means throughout this
subsystem's whole API (`objectModelPath`, `objectModelChanges`) and how much of the OBJECT_MODEL_TABLE
source-reading work is actually required before this task can call itself accurate. Per this repo's
own rule ("a premise in a task turns out false against source, stop... don't work around it"),
stopping here rather than picking one of the three above unilaterally.

## The gap

## The gap

Expressions and conditional G-code reference object-model paths (`move.axes[0].homed`,
`heat.heaters[1].current`). Paths are added, removed and deprecated between releases, which silently
breaks macros. Nothing here knows which paths exist in which release.

## Sources

- `@duet3d/objectmodel` — **published for every RRF release in our window** (`3.6.3`, the
  `3.7.0-beta.*` tags, `3.7.0-rc.1`), plus many intermediate versions that don't correspond to RRF
  tags. At `3.7.0-rc.1`, `documentation.json` has 691 entries keyed by path (`{ summary, remarks? }`)
  and `deprecations.json` has 16 (`path → message`); there is also `enums.json`. Locate the files in
  the tarball — don't assume the `dist/` layout.
- RRF source: the `OBJECT_MODEL_TABLE` definitions (about 63 files) — the authoritative key list.

## Decisions

- **Map RRF tags to package versions by exact version string only.** A package version with no
  matching RRF tag is ignored (it's a DWC build artefact, not a firmware release). Record the mapping
  in `src/objectmodel/versions.ts`, generated from `git tag` in the RRF clone and
  `npm view @duet3d/objectmodel versions`.
- **Stored as one path list with lifetimes**, not one list per version: `{ path, since?, until?,
  deprecated?: { since, message } }`, with versions inside our window (`since` omitted = present at
  3.6.3).
- `scripts/build-om-schema.mjs` fetches each mapped version (`npm pack` into the scratch directory),
  reads the JSON, diffs consecutive versions and writes `src/objectmodel/schema.ts`.

## API

```ts
export function objectModelPath(path: string, rrfVersion: string): { known: boolean; deprecated?: string; since?: string; until?: string };
export function objectModelChanges(fromVersion: string, toVersion: string): ReadonlyArray<{ path: string; change: "added" | "removed" | "deprecated"; version: string }>;
```

Paths use `[]` for indices (`move.axes[].homed`) — the same normalisation task 07 produces.

## Steps

1. **Stop point** — inspect `documentation.json`'s key format at 3.6.3 and 3.7.0-rc.1 (dotted? how
   are arrays written?). If keys don't map cleanly onto expression paths, report with examples before
   building the generator.
2. Cross-check: for one release, compare `documentation.json`'s keys with the `OBJECT_MODEL_TABLE`
   keys in RRF source for two subsystems (heat, move); record any gap in Findings.
3. Generator, schema and API.

## Tests

Known paths at each version; a path from `deprecations.json` reports its message; a path added or
removed between 3.6.3 and 3.7.0-rc.1 is reported by `objectModelChanges` in **both** directions (a
downgrade reports the addition as a removal).

## Acceptance

Schema generated for every RRF release in the window; mapping table cited; both cross-checks recorded.

## Out of scope

Value types of object-model fields (not needed for existence and deprecation checks; `enums.json`
can be added later if a rule needs it).
