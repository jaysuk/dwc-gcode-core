# Release readiness (task 16) — checklist, not an action

This document originally recorded the CURRENT state of every item task 16 asked for, without itself
publishing, tagging, bumping a version, or touching a consumer repo — those were the user's calls,
made explicitly, not inferred from this checklist being complete. **Actioned 2026-09-16**: the user
explicitly asked to bump to `1.0.0`, tag, push, and `npm publish` — done (see "Version plan" and
`npm publish`" below for what actually happened, kept alongside the original pre-decision text rather
than rewritten, so the record of what this document recommended vs. what the user actually chose stays
visible).

## Tasks 05–15 Done; the `rrf-3.7.0-rc.1` tag exists

- **Tasks 05–15: Done.** Every task file's own `## Findings` section documents what was built, what
  was found, and any deliberate scope limit. Task 16 (this one) is in progress.
- **The `rrf-3.7.0-rc.1` tag does NOT exist** (checked directly: `git tag -l` and `git ls-remote
  --tags origin` both list only `v0.1.0`–`v0.5.0`, no `rrf-*` tag at all). This is expected, not an
  oversight: `rrf-<tag>` marks a completed, closed RRF-version-triage review (CLAUDE.md's "Tracking
  RRF" section), and task 12's own triage was completed at a **user-approved reduced scope** — only
  `GCodeBuffer`/`GCodes dispatch` (146 of 366 real commits) were closed; 19 subsystems and 138 wiki
  commits were deliberately deferred (`docs/tasks/12-release-model.md`'s own Findings). Tagging
  `rrf-3.7.0-rc.1` now would assert a full closure that didn't happen. `RRF_BASELINE` in `src/rrf.ts`
  has been `"3.7.0-rc.1"` since this baseline was first adopted (never moved from an earlier tag
  within this repo's history), so there was never a "move" event requiring this tag under CLAUDE.md's
  own rule either way.

## Version plan

Current: `0.5.0` (`package.json`, kept in sync with `src/version.ts`'s `CORE_VERSION` by a test).
Since `0.5.0`, this queue shipped: six new modules (dictionary, object-model schema, releases,
project, diagnostics, compare), a new `lexLines` streaming API, and several real, cited **behaviour
fixes** to already-shipped modules (`tokenise`/`parseParams` command-splitting, `edit.ts`'s line-number
handling and expression-parameter rewriting, `M950`'s dictionary entry, the packaging `typesVersions`
fix) — all acceptable pre-1.0 per this project's own decision 5 (no consumer depends on this package
yet), but real enough that a patch bump would understate them.

**Proposed, not applied**: `0.6.0` — a single minor bump for this whole batch, consistent with SemVer's
own convention for a `0.x` line (increment MINOR for a breaking change, PATCH for a non-breaking one).
This is the conservative default and what this document recommends.

**An alternative worth naming, not automatically preferring**: `1.0.0` — everything task 05's original
plan called for (`docs/tasks/README.md`) is now built, which is a real argument for declaring the
package "done." This document's own recommendation was to hold off: "1.0" usually signals a stability
commitment (a real API-break bar going forward), and that commitment reads more honestly once at least
one real consumer has actually migrated onto it (the list below) and confirmed nothing in the design
needs to move again - not purely from every planned task file being checked off.

**Chosen: `1.0.0` (2026-09-16).** The user chose `1.0.0` over this document's `0.6.0` recommendation,
before any consumer had migrated - a real, explicit judgment call against this document's own advice,
not something to quietly walk back later as though it weren't a deliberate choice. Done: `package.json`
+ `src/version.ts`'s `CORE_VERSION` bumped to `1.0.0`, `CHANGELOG.md`'s `Unreleased` section moved under
a `## 1.0.0 - 2026-09-16` heading, `v1.0.0` tagged and pushed (triggers `.github/workflows/release.yml`,
which tests then publishes a GitHub Release), and `npm publish` run.

## `npm pack --dry-run` output reviewed

Run directly (`npm pack --dry-run`), not assumed:

- **102 total files**, package size **274.2 kB** (compressed), unpacked **1.4 MB**.
- Only `dist/**`, `src/**`, `README.md`, `LICENSE` and `package.json` are included — exactly
  `package.json`'s own `files` list (`["dist", "src", "README.md", "LICENSE"]`) plus the two files npm
  always includes regardless (`README*`, `LICENSE*`) and `package.json` itself.
- **`CHANGELOG.md` is deliberately NOT in the tarball** (not in `files`) — it still reaches consumers
  through the GitHub Release the release workflow generates from it (CLAUDE.md's "Releasing" section),
  just not bundled into every install. Confirmed intentional, not an oversight.
- `docs/`, `scripts/`, `test/`, `.github/` are correctly absent (dev-only, no `files` entry names
  them).
- Nothing unexpected (no `.env`, no stray build artefacts, no `node_modules`).

## `npm publish` of `dwc-gcode-core`

**Run 2026-09-16, at the user's own explicit instruction** ("version bump to 1.0.0, push and then
release on npm") - `npm publish` from a clean working tree at the tagged `v1.0.0` commit, `prepare`
running `npm run build` first per `package.json`'s own lifecycle script. Published as
`dwc-gcode-core@1.0.0`, public (the package has no scope, so no `--access public` was needed).

## Consumer migration list

Exact, file by file, for when the user unfreezes each repo — reproduced from this task's own list
(`docs/tasks/16-hardening-and-readiness.md`), each item still checked true against the current state
of this package:

- **duet-gcode-postprocessor**: bump off `v0.1.0`; use `lexLine` for multi-command lines in its
  pipeline (a line like `G90 G1 X10` is two commands, not one — `tokenise`'s own deprecation notice
  explains exactly this); audit B1 — `T-1`/bare `T` handling in `src/model/steps/preheat.ts` (reports
  "tool −1 has no heater"), `src/model/steps/insertAt.ts` (the tool-change trigger fires on `T-1`) and
  `src/model/gcode/state.ts` (the tool becomes −1); add fixtures with `T-1`, bare `T`, valueless
  parameters and multi-command lines; adopt the task-09 stamp (`src/stamp.ts`) alongside its own
  `postprocessed-by` line. Task 15's `compareDocuments`/`diffText` are also a natural fit for its own
  before/after preview UI, worth a look during the migration even though not originally scoped there.
- **resonance-lab**: bump; keep subpath imports until it's confirmed the same real DWC 3.6 build no
  longer needs them now that the root specifier itself also resolves under `moduleResolution: "node"`
  (task 16's packaging fix) — subpath imports still work either way, so switching isn't required, just
  no longer the only option.
- **duet-calibration-wizard**: bump; consider `diagnoseDocument`/`diagnoseProject` (task 14, now
  built) before writing `config.g`, and `compareDocuments` (task 15, now built) for a before/after
  preview of what a calibration step is about to change.
- **dwc-config-backup-core**: audit B2 (`parseAssignmentLoose` uses `toLowerCase()`, which isn't
  length-preserving for non-ASCII — lowercase `A`–`Z` only); B3 (names starting with `_` are no longer
  matched by Tier 3 — decide); B4 (**it must not publish while it depends on a `github:` ref** —
  publish `dwc-gcode-core` to npm first, then switch to a semver range); then its three hosts' release
  cascade (Flexible-Layouts, duet-config-backup-plugin, duet-config-backup-plugin-3.6).
- **Every consumer**: adopt the stamp (decision 1) wherever it parses a file.

## `npm publish` — the user's decision

Executed 2026-09-16, per the user's own explicit instruction - see "`npm publish` of `dwc-gcode-core`"
above. The consumer migration list below is no longer blocked on this.
