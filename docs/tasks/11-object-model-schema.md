# 11 — Object-model schema per RRF release

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
