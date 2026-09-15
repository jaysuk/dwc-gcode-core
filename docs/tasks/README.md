# Work orders — dwc-gcode-core to full RRF coverage

Each file here is a self-contained task, written so an implementer with no memory of how it came
about can do it correctly. **Read this file first, then `../../CLAUDE.md`, then `../roadmap.md`**
(Part 1 of the roadmap is the audit these tasks fix; Part 2 is the architecture they build).

## The goal

Parse **all** G-code RRF accepts, on every machine type; recognise **config changes between each RRF
release and the next**, in both directions; and give any plugin what it needs to **read, edit and
compare** the files on a Duet's SD card, **highlighting errors and omissions**. Firmware window:
**RRF 3.6.3 onward**.

## Decisions already made by the user (2026-09-14) — do not re-litigate

1. **Every file a plugin parses gets a stamp comment** recording the RRF version it was checked
   against **and** the plugin (id + version) that did it, "in case we need to reparse due to plugin
   bugs". This package records its own version in the stamp too (task 09).
2. **All machine types are in scope**: RRF's `MachineType` is `fff`, `laser`, `cnc`
   (`src/GCodes/GCodes.h`, `enum class MachineType`).
3. **Menu files are in scope** — and, in the user's words, "anything that's not a gcode, firmware
   file or plugin/dwc file". So scope is G-code files **plus** every other file on the SD card,
   except firmware binaries and DWC/plugin files. Task 08 classifies every file RRF itself reads or
   writes.
4. **Do not publish.** No `npm publish`, no `vX.Y.Z` tags, no GitHub Releases, no version bump in
   `package.json`, until the user says they're comfortable. Commit per task and push to `main` of
   `jaysuk/dwc-gcode-core` only (CI runs the gates); record user-visible changes in `CHANGELOG.md`
   under `## Unreleased` (the file doesn't exist yet — create it in task 05; it's a hand-kept list
   for the eventual release, separate from the release workflow's generated notes).
5. **API breaks are allowed** — no plugin using this package has been released. Don't add
   backwards-compatibility shims for their own sake. **Do not touch any consumer repo**
   (duet-gcode-postprocessor, resonance-lab, duet-calibration-wizard, dwc-config-backup-core, or
   anything else) — the user is freezing them until this is complete. Findings for consumers go into
   task 16's migration list, not into their repos.

## The queue

| # | Task | Depends on |
| --- | --- | --- |
| [05](05-lexer.md) | ✅ Done — Lexer rewrite to RRF's `FindParameters` semantics — multiple commands per line, parameters split by letter, checksums, `'` lowercase axes, `(…)` comments in CNC mode, whole-line string arguments | — |
| [06](06-document-model.md) | ✅ Done — Lossless document model: lines, meta block tree, machine-mode tracking, Fanuc continuation lines; `edit.ts` rebuilt on it | 05 |
| [07](07-expressions.md) | ✅ Done — Expression syntax (parse, never evaluate) from RRF's `ExpressionParser.cpp` | 05, 06 |
| [08](08-file-kinds-menu-data.md) | ✅ Done — Inventory of every file kind on the SD card; menu-file parser; height-map / probe-points parser | 05, 06, 07 |
| [09](09-stamp.md) | ✅ Done — The stamp: format, read/write, placement rules per file kind, re-check reasons | 06, 08 |
| [10](10-dictionary.md) | ✅ Done — Versioned, cited command dictionary; tier 1 (every command a real slicer/config.g uses) fully reviewed against RRF source, the rest drafted and tracked in `dictionary/coverage.json` | 05 |
| [11](11-object-model-schema.md) | ✅ Done — Object-model path existence/deprecation per RRF release; 3.6.3's baseline (no `documentation.json` at that version) derived directly from `Duet3D/ObjectModel`'s own TS source, validated to 691/691 against 3.7.0-rc.1's real docs | 07 |
| [12](12-release-model.md) | ✅ Done, reduced scope (user-approved) — `GCodeBuffer`/`GCodes dispatch` (146 commits) fully triaged into `src/releases/changes.ts`'s events + `changesBetween`/`impactOf`; the other 19 subsystems + 138 wiki commits deferred, `rrf-3.7.0-rc.1` not tagged — see Findings | 10, 11 |
| [13](13-project-model.md) | Project model: SD layout, includes/call graph, symbol table | 06, 08, 10 |
| [14](14-diagnostics.md) | Diagnostics engine: errors and omissions, quick fixes, Monaco-marker adapter | 07–13 |
| [15](15-compare.md) | Semantic compare of two files / two projects, release-aware | 06, 10, 12, 13 |
| [16](16-hardening-and-readiness.md) | Performance, fuzzing, the legacy-resolution packaging fix, API review, and the (not executed) consumer-migration + publish checklist | all |

Do them in order. A task is **Done** only when all its acceptance criteria hold and the gates pass.
Mark it Done by adding `**Status: Done (<commit>)**` under its title.

## Sources — how to read RRF, the wiki and DWC's packages

- **RRF source** — a local clone exists at `C:\Users\live\Documents\Github\RRFBuild\RepRapFirmware`
  (working tree at `v3.7.0-beta.1-2`). **Never check out, reset, clean or build in it** — the user
  builds firmware there. Run `git -C <clone> fetch --tags` first (it doesn't touch the working tree),
  then read at a tag: `git -C <clone> show 3.7.0-rc.1:src/GCodes/GCodes2.cpp`; list files with
  `git -C <clone> ls-tree -r --name-only 3.7.0-rc.1 src/`; search with
  `git -C <clone> grep -n "<pattern>" 3.7.0-rc.1 -- src/`. If the clone is unusable, fall back to
  `gh api "repos/Duet3D/RepRapFirmware/contents/<path>?ref=<tag>" -H "Accept: application/vnd.github.raw"`.
- **Baseline**: `RRF_BASELINE` in `src/rrf.ts` (`3.7.0-rc.1`, the latest release on 2026-09-14). At
  the start of each task check `gh api repos/Duet3D/RepRapFirmware/releases --jq '.[0].tag_name'`;
  if a newer release exists, **stop and report** — the baseline would move.
- **Wiki**: `Duet3D/wiki-content`. The G-code dictionary is one file, `User_manual/Reference/Gcodes.md`;
  meta-commands are `User_manual/Reference/Gcode_meta_commands.md`; menu files are
  `User_manual/Connecting_hardware/Display_12864_menu.md` (confirm paths with `gh api` — they have
  moved before). **Pin a commit SHA** for anything you extract
  (`gh api "repos/Duet3D/wiki-content/commits?path=<file>&per_page=1" --jq '.[0].sha'`) and record it
  next to the extracted data.
- **DWC's packages** (devDependencies at most — this package keeps **zero runtime dependencies**):
  `@duet3d/monacotokens` (`gcodes.json`, `expressions/expressions.json`, the menu grammar,
  `objectmodel/*`) and `@duet3d/objectmodel` (`documentation.json`, `deprecations.json`, `enums.json`),
  both published at `3.7.0-rc.1`. They are *inputs to generators* in `scripts/`, never imported by
  `src/`. Locate files inside them with `npm pack <pkg>@<version>` into the scratch directory and
  list the tarball — don't assume paths.

## Rules that apply to every task

1. **RRF source decides behaviour.** Every rule, dictionary entry and change event cites where it
   came from: `RRF <tag> <file> <function or case>` and/or `wiki <file> "<section>" @<sha>`. When the
   wiki and source disagree, source wins and the disagreement goes in `docs/wiki-discrepancies.md`
   with both quotes. **Never invent a rule, parameter, version or requirement.** If you can't cite
   it, it doesn't go in.
2. **Every test has teeth.** For each behaviour you add or fix, break it on purpose, watch the test
   fail, then restore it. A test named for a condition it never establishes proves nothing.
3. **Pure.** `src/` has no DOM, Node, Vue or DWC imports (`lib: ES2021`, `types: []` enforce it).
   Generators live in `scripts/` and may use Node.
4. **The lexer is a hot path** — consumers run it over 200 MB print files. No per-line allocation
   beyond the result; parameter and expression detail is lazy where possible. Task 05 records a
   benchmark baseline; later tasks must not regress it by more than 20% without saying why.
5. **Imports carry `.js` extensions.** Every new module gets its own `exports` subpath in
   `package.json` (and a `typesVersions` entry). If a new export collides by name with a root
   export, exclude its subpath from `src/index.ts` and register it in `test/package.test.ts`'s
   `ROOT_EXCLUDED_SUBPATHS`.
6. **Stop points are real.** When a task says "stop and report", or a premise in a task turns out
   false against source, stop, write what you found in the task file under `## Findings`, commit
   that, and report. Don't work around it.
7. **House style**: tabs, double quotes, `Array<T>`/`ReadonlyArray<T>`, comments explain *why*.
   Match the density of the file you're in. The API sketches in the tasks are the contract's shape;
   refine names only with a reason recorded in Findings.

## The gates — all three, before every commit

```bash
npm run typecheck   # library + tests (tsconfig.test.json)
npm test
npm run build
```

No DWC checkout is needed for this package. CI (`.github/workflows/test.yml`) runs the same three.

## Commits

One commit per task, or per coherent step of a large task. Imperative subject; the body explains
the gap being closed and cites the sources used. End every commit message with the attribution
line the harness specifies.
