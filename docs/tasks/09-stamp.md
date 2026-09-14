# 09 — The stamp

## The gap

The user's decision: **every file a plugin parses gets a comment recording the RRF version it was
checked against and the plugin (id + version) that checked it**, so that when either the firmware or
the plugin changes, the file can be flagged for a re-check. This package is part of that chain too,
so its own version goes in the stamp. One format, owned here, so every plugin writes and reads the
same thing.

## Facts verified on 2026-09-14 — cite them in the module

- **Menu files** accept a `;` comment line: RRF `3.7.0-rc.1` `src/Display/Menu.cpp`,
  `Menu::ParseMenuLine` (a line whose first word starts with `;` is treated as a comment). DWC's own
  menu grammar agrees (`@duet3d/monacotokens`, `lineComment: ";"`).
- **Height-map and probe-points files must NOT be stamped**: RRF
  `src/Movement/BedProbing/Grid.cpp` — the loader rejects the file unless line 1 starts with
  `HeightMapComment` (or `PointsFileComment`), followed by the label line, then parameters.
- **Print files**: RRF `src/Storage/FileInfoParser.cpp` scans a header chunk and a footer chunk for
  slicer metadata; one short comment line at the top shouldn't hide anything it looks for — but
  **verify** in step 1 that no slicer pattern must be on line 1.
- The post-processor already writes its own first-line stamp,
  `; postprocessed-by: GCodePostProcessor v… recipe="…" hash=… at=…`
  (`duet-gcode-postprocessor/src/model/recipe.ts`, `STAMP_PREFIX`/`STAMP_RE`). The new stamp must
  **coexist** with it — neither disturbs the other. The post-processor adopts this format during
  task 16's migration, not now.

## Decisions

- **Format** — exactly one `;` comment line:

  ```
  ; dwc-gcode-core: checked rrf=3.7.0-rc.1 plugin=GCodePostProcessor@1.2.1 core=0.6.0 at=2026-09-14T10:00:00Z
  ```

  Grammar: `; dwc-gcode-core: checked`, then space-separated `key=value` pairs. Keys `rrf`, `plugin`
  (`<pluginId>@<version>`), `core` and `at` (ISO-8601 UTC, seconds precision) are required; unknown
  keys are preserved on read and ignored. Values can't contain spaces, so percent-encode `%`, space
  and `=` in values (DWC plugin ids may contain spaces — check DWC's plugin-manifest id rule and cite
  it).
- **One stamp per file.** Writing replaces an existing stamp in place; stamps never accumulate.
- **Placement**: if a stamp exists in the first 20 lines, replace that line. Otherwise insert it as
  line 1 — after a UTF-8 BOM if present, after an existing `; postprocessed-by:` line, and after any
  line step 1 finds must stay first. The stamp line uses the file's own EOL.
- **Which files**: `stampable(kind)` uses task 08's `syntax` — `"gcode"` and `"menu"` files yes;
  `"csv"`, `"text"` and `"binary"` never.
- **Re-check reasons** are computed, not stored: firmware moved (up or down), the stamping plugin's
  version changed, this package's version changed, or no stamp.
- `CORE_VERSION` is exported from `src/version.ts`; `test/package.test.ts` asserts it equals
  `package.json`'s `version` (the same pattern as `RRF_BASELINE`). Because versions aren't bumped
  until publish (decision 4), `core=` reads `0.5.0` until then — that's expected.

## API

```ts
export interface Stamp { rrf: string; pluginId: string; pluginVersion: string; core: string; at: string; extra: Readonly<Record<string, string>>; line: number }
export function readStamp(text: string): Stamp | null;
export function writeStamp(text: string, stamp: { rrf: string; pluginId: string; pluginVersion: string; at: string; extra?: Record<string, string> }, kind: FileKind): string; // core is filled from CORE_VERSION; throws StampNotAllowedError for non-stampable kinds
export function stampable(kind: FileKind): boolean;
export type RecheckReason =
	| { kind: "unstamped" }
	| { kind: "firmware-upgraded" | "firmware-downgraded"; from: string; to: string }
	| { kind: "plugin-changed"; pluginId: string; from: string; to: string }
	| { kind: "core-changed"; from: string; to: string };
export function recheckReasons(stamp: Stamp | null, current: { rrf: string; pluginId: string; pluginVersion: string }): ReadonlyArray<RecheckReason>;
```

A stamp written by a *different* plugin than the current one isn't a `plugin-changed` reason by
itself — report it as `plugin-changed` only when the ids match and the versions differ; record the
other case as its own reason kind if step 2 shows a consumer needs it (write it down in Findings).

## Steps

1. **Stop point** — read `FileInfoParser.cpp` at the baseline and confirm no slicer detection relies
   on line 1. Also confirm running a macro has no first-line requirement. Report if anything does.
2. Implement. `readStamp` must accept leading whitespace and CRLF.
3. Document the format in the README under its own heading.

## Tests

Round trip on every stampable kind; replace-not-accumulate; BOM preserved; CRLF preserved;
coexistence with `; postprocessed-by:` in both orders; `writeStamp` on `heightmap.csv` throws; every
`RecheckReason` kind, including a downgrade (`3.7.0-rc.1` → `3.6.3`); percent-encoding round trip.

## Acceptance

Format documented in the README; all tests with teeth; the four verified facts cited in code.

## Out of scope

File I/O, backups, atomic writes — each plugin's own layer.
