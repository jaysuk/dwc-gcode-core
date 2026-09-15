# 16 — Hardening and readiness (publishing NOT executed)

**Status: Done** (publishing itself intentionally NOT executed - see `docs/release-readiness.md`).

## Findings

**1. Performance** (`docs/performance.md`, `scripts/bench-lex.mjs` extended): both scenarios this
task names were actually run and recorded, not estimated - a 5,000-line dictionary-realistic config
(`--config 5000`, 182,303 lines/s, well under 30 ms) and a 200 MB synthetic print file processed in
64 KB chunks (`--chunked-print 200`, 608,078 lines/s). The chunk-streaming helper was built for a
**bounded working set**, which is what the measurement actually supports: lexing 200 MB costs the same
~7 s whether it arrives in 64 KB pieces or as one string, but `lexLines`' own retained memory is ~26 MB
chunked versus ~181 MB whole-file (essentially the retained string), and the chunked figure is flat in
file size. *(Corrected after an audit: the first version of this Findings section, and of
`docs/performance.md`, claimed "~37x less heap and ~30% faster". Both figures were artifacts of the
benchmark's own synthetic generator building a 200 MB string by repeated concatenation - 1533 MB of the
1713 MB, and all of the time difference. The script now has a `--generate-only` mode so the generator's
cost is always reported and subtracted, and the docs state only what survives that subtraction.)*
Built `lexLines(chunks, options)` in
`src/lex.ts` for it: splits a stream of raw chunks into complete lines, carrying a partial line across
a chunk boundary exactly once. Deliberately does NOT track `M451`/`M452`/`M453` machine-mode switches
across lines - `LexOptions.machineMode`'s own doc comment already says that's `parseDocument`'s job,
and that model needs the whole file in memory anyway, so a true streaming reader could never offer it
regardless; documented as a real, cited scope limit, not a silent gap.

**2. Fuzzing** (`test/fuzz.test.ts`, seeded with `mulberry32`, fully reproducible): 10,000 random
lines per machine mode from the lexer's own alphabet, checking `lexLine` never throws and every span
stays in bounds; a second pass runs the same generator through `parseDocument`/`serializeDocument` and
checks the round trip holds. **Caught a real bug on the very first run - in the fuzz test itself, not
the lexer**: the fuzz-generated line `"MWv7g(HwAFIBk5BBZKOOrKaq)suWsZ"` in CNC mode produces a command
whose own span legitimately CONTAINS a `(...)` bracketed comment (RRF allows an inline CNC comment to
interrupt a command's own parameter list mid-line, with the command's span correctly continuing past
it to later params) - the test's first-draft invariant ("no two spans overlap at all") was too strict
and flagged this correct behaviour as a failure. Fixed by distinguishing a genuine partial/"crossing"
overlap (always a bug) from full containment (allowed only for a bracketed comment inside a command's
span, since that's the one real nesting relationship this format has) - `lexLine` itself needed no
change. Left at 10,000 lines/mode (~4s total) as a reasonable per-commit cost; the seed makes any
future failure exactly reproducible from the printed line index.

**3. Packaging fix (audit C1) — done, and the real cause was NOT what the original bug report
implied.** `test/packaging/legacy/` (a real `moduleResolution: "node"` consumer importing the root and
every subpath) reproduced the exact recorded failure first, before any fix was attempted. Two
plausible-sounding causes were tested directly against the fixture and both **ruled out**: a missing
`"require"` condition in `exports` (added one - no change), and the `exports` map itself (removed it
entirely, along with `"type": "module"` - still failed, with a different, more generic error). The
actual cause, found by isolating each `package.json` field one at a time against a minimal known-good
comparison package: `typesVersions`' own `"*": {"*": ["dist/*"]}` wildcard ALSO matches the ROOT
specifier under classic `moduleResolution: "node"` (the "subpath" being matched is empty for a root
import), rewriting it to `dist/` with no filename - which fails to resolve, and that failure shadows
the perfectly good top-level `types`/`main` fields entirely, rather than falling back to them. **Fix**:
a second fallback candidate in the same wildcard entry, `"*": ["dist/*", "dist/index.d.ts"]` - a real
subpath still resolves via the first candidate; the root specifier's empty match fails the first and
falls through to the second. Verified end-to-end against the real built package (`npm run
test:packaging`, also wired into CI, `.github/workflows/test.yml`). README's "Legacy webpack/CJS
builds" section and CLAUDE.md rule 8 rewritten with the real cause, not the original (reasonable, but
wrong) guess.

**4. API review**: `docs/api.md` generated (`scripts/build-api-doc.mjs`, `npm run docs:api`) - every
`exports` subpath, every runtime export (function/const) and every type-only export (interface/type
alias), read directly from the built `dist/` output. `tokenise`/`parseParams` (task 05's deprecated
shims) were **kept, not removed** - checked directly, not assumed: `src/meta.ts` still calls
`tokenise()` and `src/commands/g10.ts` still calls `parseParams()` internally, so the task's own
condition for removal ("only if nothing internal needs them") isn't met. Migrating those two modules
onto `lexLine` directly instead was considered and deliberately not done - `params.ts`'s
`findParam`/`paramNumber`/`paramNumberList` helpers operate on its own `ParsedParam` shape, not
`lex.ts`'s richer `LexedParam`, so the migration would touch two already-shipped, already-tested
modules' internals for a purely cosmetic API-surface reduction with no behaviour change - out of scope
for what this task actually asks. README's subpath list updated to include `/diagnostics/*` and
`/compare` (both existed in their own full sections already, just missing from the one consolidated
enumeration line).

**5. `CHANGELOG.md`**: extended with task 16's own two additions (`lexLines`, the packaging fix) - the
rest of the file was already kept current task-by-task through this whole queue (tasks 10-15 each
added their own entries as they shipped, not deferred to this pass).

**Readiness checklist**: `docs/release-readiness.md`. The two most load-bearing findings there, not
assumed: the `rrf-3.7.0-rc.1` tag genuinely does not exist (checked directly against both the local
clone and the remote) - expected, since task 12's own triage closed at a reduced scope, not the full
closure that tag is meant to certify; and `npm pack --dry-run` (actually run, not guessed) confirms the
tarball is exactly `dist`/`src`/`README.md`/`LICENSE` as intended, 102 files, with `CHANGELOG.md`
deliberately excluded (it reaches consumers via the GitHub Release instead). A version bump to `0.6.0`
is proposed, not applied, with `1.0.0` named as a real alternative the user may prefer instead.

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
