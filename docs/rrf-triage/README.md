# RRF triage and release pinning

`*.md` here are closed triage checklists (`npm run triage -- <from> <to>`), one per baseline move. This page says how a change is
pinned to a release, which the checklists and `src/releases/changes.ts` rely on. Everything here needs a full-history clone of
`Duet3D/RepRapFirmware` (`$RRF_CLONE`, else `../RepRapFirmware`) and never touches its working tree.

## What a "release" is

`RELEASES` (`src/releases/releases.ts`) lists every `src/Version.h` `MAIN_VERSION` string a board can report in the window, oldest
first, each with the RRF commit it was read from:

| Kind | Meaning | `commit` |
| --- | --- | --- |
| `tag` | a git tag (`3.6.3`, `3.7.0-alpha.2`, `beta.1`..`rc.2`) | the tagged commit; its commit date is the `date` |
| `build` | a `Version.h` string that was never tagged: `3.7.0-alpha.3`..`alpha.8`, `beta.2+1`, `beta.3+1`, `rc.1+1`..`+3` | the FIRST commit whose own tree reads the string (`git show <sha>:src/Version.h`) - the "Increased version to X" commit |

`+N` is RRF's counter within one prerelease (`ParsedVersion.build`), not a tag. Find the next one with
`git log --reverse --format='%h %cs' <last-tag>..<branch> -- src/Version.h` and read `MAIN_VERSION` at each hit;
`node scripts/audit-releases.mjs` lists any string in history that `RELEASES` lacks.

Only the GitHub releases (`gh api repos/Duet3D/RepRapFirmware/releases`) are binaries most users run: `3.6.3`, `beta.1`..`rc.2`. The
builds are there for the people who run `3.7-dev` builds (the `rc.1+1` accelerometer change is one a real plugin gates on).

## Topology: `3.7.0-alpha.2` is older than `3.6.3`

`3.6.3` (2026-06-02) is a separate branch. `3.7.0-alpha.2` (2026-03-09) was cut from `3.7-dev` before it and does not contain 3.6.3's
fixes; `3.6-dev` was merged into `3.7-dev` between `beta.1` and `beta.2`. Versions still order `3.6.3 < 3.7.0-alpha.2`, which is what
a firmware-version comparison does, so:

- a slice of history for a release is "reachable from its commit, not from the previous release's, **not from 3.6.3**"
  (`git rev-list <release> ^<previous> ^3.6.3`) - otherwise the 3.6.3 fixes merged into 3.7-dev show up as "new in beta.2";
- a fact that holds at 3.6.3 and at `beta.2` but not at `alpha.2` is a topology artefact, not a removal and re-addition
  (the dictionary tools report it as a GAP for a human).

## Pinning an event

An event's `version` is the **first tracked release whose commit contains the change commit**:

```
git merge-base --is-ancestor <change> <release.commit>
```

`node scripts/audit-releases.mjs --events` does that for every RRF commit a change event cites (`RRF commit <sha>`), and
`test/releaseAudit.test.ts` runs it whenever a clone is present. A commit already in 3.6.3 is not a change in the window. An event
citing several commits may sit at any release that first contains one of them (the latest is the safe choice).

The rule errs toward warning: a board reporting a build string may or may not have a change that landed between two bumps, so an event
is dated to the release that certainly has it. (The earlier rule, "the `Version.h` string in the commit's own tree", dated a change to a
string that the previous build also reported.)

Object-model events are the one exception: they come from per-tag snapshots of the object model (`scripts/build-om-schema.mjs`), so they
are tag-precise - a path added during the alpha builds is dated `3.7.0-beta.1`. `3.7.0-alpha.2` has data derived from RRF's own
tables at that tag.

## Dictionary history

`scripts/dictionary-history.mjs` (which codes RRF dispatched at each release, `docs/dictionary-history.md`),
`scripts/dictionary-param-history.mjs` (which listed letters a handler reads at each release, `docs/dictionary-param-history/`) and
`scripts/explain-handler.mjs` (the lines behind a verdict) produce candidates; `since`/`until` and `historyChecked` are written by a
person after `git show` confirms each one (`CLAUDE.md`, "Tracking RRF").

## Per-release checklists

The range documents above (one per baseline move) cannot answer "what changed in `beta.2`?", and the catalogue's
`changesBetween(a, b)` has to be right for ANY pair of releases, so the same items are also kept one release at a time in
`per-release/<previous>..<release>.md`. A commit sits in the first tracked release that contains it (the pin rule; `3.7.0-alpha.2`'s
slice is "reachable from alpha.2, not from 3.6.3"), and a wiki commit in the first release dated on or after it.

- `node scripts/split-triage.mjs [--check]` re-slices the two CLOSED range documents. It carries each item's closure text over by commit
  SHA and decides nothing; a section's lead-in note is repeated (marked "carried") in every release that has items in that section. It
  prints, per release, how many items are **closed only by their section's note** - the ones with no closure text of their own, which
  are what a second look (plan D3 step 2) is for. `--check` (D3 step 1) fails if a closure text names an event pinned EARLIER than the
  release its commit first ships in; an event dated later is explained (object-model events are tag-precise; an event that cites several
  commits is dated to the latest) or it is a DIFF to answer from `git show`. Re-run it after closing an item in a range document;
  the per-release files are generated, so edit the range document, not them.
- `node scripts/rrf-triage.mjs <from> <to> --per-release [--out <dir>]` is how a NEW range starts: the same watched-file list, one open
  checklist per release in (from, to]. Add the new release to `RELEASES` first. Close the items in those files from then on (they are
  the source of truth for that range; no range document is written).

Both need `npm run build` (they read `dist/releases/releases.js`) and a full-history clone.
