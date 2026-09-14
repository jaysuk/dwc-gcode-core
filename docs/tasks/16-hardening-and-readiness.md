# 16 — Hardening and readiness (publishing NOT executed)

## Hardening — do these

1. **Performance**: extend `scripts/bench-lex.mjs` to `parseDocument` on a 200 MB synthetic print
   file (processed in chunks, the way consumers read files) and a 5,000-line config; record the numbers
   in `docs/performance.md`. Add a chunk-streaming helper if consumers need one
   (e.g. `lexLines(chunks: Iterable<string>)` carrying partial lines across chunk boundaries).
2. **Fuzzing**: a seeded, reproducible property test generating random lines from the lexer's own
   alphabet (letters, digits, `;`, `"`, `{`, `}`, `'`, `(`, `)`, `*`, spaces, tabs) in all three
   machine modes: never throws, spans stay in bounds and don't overlap, document round trip holds.
3. **Packaging fix (audit C1)**: the bare `import … from "dwc-gcode-core"` fails under legacy
   TypeScript resolution (`moduleResolution: "node"`), as seen in resonance-lab's DWC 3.6 build.
   Reproduce it with a fixture project in `test/packaging/legacy/` (a `tsconfig.json` with
   `moduleResolution: "node"`, importing the root and every subpath from the built package), fix it
   (a root entry in `typesVersions` or a `types`/`main` field are the likely candidates — prove which),
   and add a CI step that runs `tsc --noEmit` on the fixture. Then update the README's
   "Known limitation" section and CLAUDE.md rule 8.
4. **API review**: list every export; remove the deprecated shims from task 05 (`tokenise`,
   `parseParams`) only if nothing internal needs them; generate `docs/api.md`; make sure every
   subpath is documented in the README.
5. **`CHANGELOG.md`** complete for everything since v0.5.0.

## Readiness checklist — prepare, don't execute

Write `docs/release-readiness.md` with the checklist below and each item's current state.
**Don't publish, tag a `v` release, bump the version, or touch any consumer repo** — the user
decides when.

- Tasks 05–15 Done; the `rrf-3.7.0-rc.1` tag exists.
- Version plan (0.5.0 → next; the API break warrants a clear bump — propose, don't apply).
- `npm pack --dry-run` output reviewed: only `dist`, `src`, README, LICENSE, CHANGELOG.
- **Consumer migration list** — exact and file by file, for when the user unfreezes them:
  - duet-gcode-postprocessor: bump off `v0.1.0`; use `lexLine` for multi-command lines in its
    pipeline; audit B1 — `T-1`/bare `T` handling in `src/model/steps/preheat.ts` (reports "tool −1
    has no heater"), `src/model/steps/insertAt.ts` (the tool-change trigger fires on `T-1`) and
    `src/model/gcode/state.ts` (the tool becomes −1); add fixtures with `T-1`, bare `T`, valueless
    parameters and multi-command lines; adopt the task-09 stamp alongside its own
    `postprocessed-by` line.
  - resonance-lab: bump; keep subpath imports until the packaging fix ships.
  - duet-calibration-wizard: bump; consider `diagnoseDocument` before writing `config.g`.
  - dwc-config-backup-core: audit B2 (`parseAssignmentLoose` uses `toLowerCase()`, which isn't
    length-preserving for non-ASCII — lowercase `A`–`Z` only); B3 (names starting with `_` are no
    longer matched by Tier 3 — decide); B4 (**it must not publish while it depends on a `github:`
    ref** — publish `dwc-gcode-core` to npm first, then switch to a semver range); then its three
    hosts' release cascade (Flexible-Layouts, duet-config-backup-plugin,
    duet-config-backup-plugin-3.6).
  - Every consumer: adopt the stamp (decision 1) wherever it parses a file.
- `npm publish` of `dwc-gcode-core` — **the user's decision**.
