# 11 — Object-model schema per RRF release

**Status: Done (commit pending — see "Resolution" below for the user's decision and what was built).**

## Resolution (2026-09-15)

The user chose option 1 from the three laid out below: read the object model's own authoritative
source directly for `3.6.3`, rather than moving the effective baseline or accepting an inaccurate
`since`. What was actually read turned out to be more precise than raw RRF C++: `@duet3d/
objectmodel`'s own upstream source, `Duet3D/ObjectModel` (a public GitHub repo, hand-maintained
TypeScript classes mirroring RRF's object model field-for-field), tagged `v3.6.3` — its own
`documentation.json` generator plainly didn't exist that early (confirmed: no such script in
`package.json` at that tag), but the class structure itself did, and it **is** `@duet3d/
objectmodel`'s real source, so reading it directly satisfies "read the authoritative source" exactly
as approved, while being enormously more tractable than reverse-engineering full recursive paths from
RRF's type-erased C++ `OBJECT_MODEL_FUNC` macros (which return runtime lambdas, not statically
readable type information). This substitution is recorded here rather than re-litigated as a new stop
point, since it serves the identical goal the user already approved: build a real, source-derived
3.6.3 path list, not RRF C++ specifically.

**The deriver (`scripts/build-om-schema.mjs`) was validated, not assumed correct.** It parses every
`export class` in the TS source tree (property declarations, `extends` chains) and walks the object
graph from the root `ObjectModel` class to every path, `[]` for each array/dictionary hop. Run against
`Duet3D/ObjectModel`'s OWN `v3.7.0-rc.1` tag and diffed against that exact version's REAL, published
`documentation.json` (691 entries) via `node scripts/build-om-schema.mjs --validate`, it converges to
**691/691 real paths reproduced exactly**, plus 10 further paths this parser derives that real
documentation.json omits — each individually confirmed genuine (not a parser bug) and recorded with a
reason in the script's own `KNOWN_DERIVATION_GAPS`:
- 6 fields real, declared in `Duet3D/ObjectModel`'s TS source, with no comment explaining their
  absence from documentation.json's 691-entry list (`boards[].drivers[].status`,
  `move.keepout[].active`, `boards[].directDisplay.screen.{colourBits,height,spiFreq,width}`) — an
  upstream documentation completeness gap, not a derivation error; each is a real, live path.
- 1 (`network.interfaces[].signal`) is deprecated ("use rssi instead", confirmed in
  `deprecations.json` at every tracked version) — documentation.json's own main listing appears to
  exclude deprecated paths entirely, which is exactly why the real schema-building step (below) unions
  `documentation.json`'s keys with `deprecations.json`'s rather than trusting either list alone.
- 3 are "bare container key" omissions (`boards[].drivers[].closedLoop`, `boards[].drivers[].config`,
  `move.keepout[].coords`): their CHILDREN are fully present and correct in real docs
  (`boards[].drivers[].closedLoop.currentFraction` etc.), just not the container's own one-line
  summary key — checked directly against two fields that DO get a bare key (`boards[].accelerometer`,
  `fans[].thermostatic`) for a JSDoc-comment-based explanation; neither has one either, so this isn't
  even a detectable-from-source distinction, and it's a presentation question the task's own
  Decisions section already puts out of scope ("value types... not needed for existence and
  deprecation checks").

**Real bugs found and fixed while building the deriver** (each caught by `--validate`'s own diff, not
assumed away):
1. `stripMethodBodies` was missing entirely at first — a naive per-body regex for `name: Type = ...;`
   also matched object-literal keys INSIDE a method body one level down (`PluginManifest`'s
   constructor defines properties via `Object.defineProperty(this, "id", { enumerable: true, get()
   {...} })`, whose `enumerable: true` line looks exactly like a field to a regex not tracking brace
   depth) - fixed by stripping every method/constructor/getter/setter body before scanning for fields.
2. `ModelObject`'s own `static readonly resetsMissingProperties: boolean = true;` was appearing under
   every single class's own path - `static` fields are class-level metadata, not per-instance
   object-model data; fixed by skipping any field whose modifiers include `static`.
3. The bare `path[]` for a collection/dictionary was being emitted as its own key (e.g. "fans[]") -
   real docs only ever have the bare `path` (the collection as a whole) and `path[].<child>` entries,
   never `path[]` itself; fixed to use `path[]` only as a recursion prefix, never add it to the output.
4. **Polymorphic dispatch was completely missing at first.** `Board`'s `boards[]` entries are really
   `MainBoard` (index 0) or `ExpansionBoard` (every other index) depending on position
   (`boards/index.ts`'s own `getBoard(index)` factory); `Move.kinematics`'s field type `Kinematics` is
   actually whichever of `CoreKinematics`/`DeltaKinematics`/`HangprinterKinematics`/`PolarKinematics`/
   `ScaraKinematics` the machine is configured for; filament monitor types work the same way.
   `documentation.json` documents the UNION of every variant's fields at that position, not just the
   declared type's own. Fixed in two steps: a reverse-`extends` index to find all (transitive)
   subclasses of a class, and (once `move.kinematics` showed the first fix wasn't enough — `Kinematics`
   has no subclasses of its own; its SIBLINGS `CoreKinematics` etc. all extend the shared
   `KinematicsBase` directly) walking UP to the shared family root before unioning down.
5. Two sibling subclasses can declare the **same field name with completely unrelated types**:
   `LaserFilamentMonitor.calibrated: LaserFilamentMonitorCalibrated` vs.
   `PulsedFilamentMonitor.calibrated: PulsedFilamentMonitorCalibrated` vs.
   `RotatingMagnetFilamentMonitor.calibrated: RotatingMagnetFilamentMonitorCalibrated` — three
   unrelated classes sharing no base of their own. An early version of the field-union step kept only
   the first type found per field name, silently dropping the other variants' own children. Fixed by
   tracking a `Set` of every distinct type seen per field name and recursing into all of them.
6. `export default class Driver extends ModelObject { ... }` (used by exactly two files,
   `boards/Driver.ts` and `move/KeepoutZone.ts`) wasn't matched by the class-header regex at all (it
   only handled `export class Name` and `export abstract class Name`) - both classes were silently
   invisible to the whole deriver until the regex grew a `(?:default\s+)?` alternative.

**Step 2's cross-check** (task requirement: compare `documentation.json`'s keys against RRF's own
`OBJECT_MODEL_TABLE` for two subsystems) was done directly against RRF 3.7.0-rc.1 C++ source for
`heat` and `move`, beyond the TS-mirror validation above: `Heat::objectModelTable` in
`src/Heating/Heat.cpp` and `Move::objectModelTable` in `src/Movement/Move.cpp` were read in full and
compared key-by-key against the derived schema's `heat.*`/`move.*` root paths. Exact match on every
key, **including which ones RRF's own C++ marks `ObjectModelEntryFlags::obsolete`** — `bedHeaters`/
`chamberHeaters` (heat) and `printingAcceleration`/`rotation`/`travelAcceleration`/`virtualEPos`/
`workplaceNumber` (move) are marked obsolete in the C++ table, and every one of them is exactly the
set this schema's `deprecated` field reports from `deprecations.json` — strong independent
confirmation that RRF's real source, `Duet3D/ObjectModel`'s TS mirror, and the npm-published
`deprecations.json` all agree.

**Building the real schema** (`node scripts/build-om-schema.mjs`, no `--validate`) fetches all 5
tracked versions (`3.6.3` via the TS deriver, `3.7.0-beta.1`/`beta.2`/`beta.3`/`rc.1` via their own
npm `documentation.json` + `deprecations.json`, unioned per-version for the reason above) and found
one more real wrinkle: **57 paths are missing from one or more INTERMEDIATE tracked versions' own
path list while present at both an earlier and a later tracked version** — every one of them a
"polymorphic family union" path (`move.kinematics.towers`, `sensors.filamentMonitors[].calibrated.
mmPerRev`, etc.) or a `directDisplay.screen` field, exactly the categories already shown above to be
inconsistently documented even at the FINAL tracked version. Modelling this as "genuinely removed,
then re-added" would report an upstream documentation-completeness gap as an RRF behaviour change;
instead, `buildLifetimes` treats a path as continuously present from its first tracked appearance to
its last, logging (not failing on) every path this affects — visible in the generator's own build
output and reproducible by re-running it, rather than hidden. A single `{since?, until?}` span per
path was confirmed to be enough for the actual tracked-version data (0 real multi-span cases, only
this documentation-noise category, each logged by name so a real regression stays visible in the
generator's own output rather than being silently absorbed).

**One real bug found via the tests written after generation** (`test/objectmodel.test.ts`):
`objectModelChanges`'s first version pinned a reported change's `version` to the query RANGE's own
endpoint (`TRACKED_ORDER[lo]`/`TRACKED_ORDER[hi]`) depending on direction, rather than to the actual
transition point (`entry.since`/`entry.until`) — correct only when the query range happened to start
or end exactly on the transition itself. A downgrade test (`objectModelChanges("3.7.0-rc.1",
"3.6.3")` for a path added at `3.7.0-beta.1`) caught it immediately: it reported the removal as
happening at `"3.7.0-rc.1"` (the range's own endpoint) instead of `"3.7.0-beta.1"` (where the path
actually stopped existing, going backward). Fixed so the reported version is always the real
transition point; only the "added"/"removed" label flips with query direction, matching the task's
own test requirement ("a path added or removed... is reported in both directions").

**Coverage**: 709 known paths across the 5 tracked versions, `OBJECT_MODEL_BASELINE = "3.7.0-rc.1"`.
`3.7.0-alpha.2` is listed in `OBJECT_MODEL_VERSIONS` (so task 12's release-model work knows the RRF
tag existed) but flagged `hasData: false` — neither a `documentation.json` nor a matching
`Duet3D/ObjectModel` git tag exists for it, and no other primary source was found; `objectModelPath`/
`objectModelChanges` throw a clear error naming this if ever called with it.

## Findings (original stop-point investigation, 2026-09-15, before the user's decision)

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
