# dwc-gcode-core — working notes

Framework-free TypeScript library: RepRapFirmware-faithful G-code parsing for the DWC plugin family.
**Published to npm since 2026-09-16** (`npm publish` after every release-worthy bump — the release
workflow itself only builds the GitHub Release, it does NOT publish to npm, so that step is always a
manual, deliberate one after `git push origin vX.Y.Z`) — consumers depend on a normal `^X.Y.Z` semver
range now, not a `github:` tag (older plugins predating the npm publish may still show the old
pattern; safe to switch over). **Bundled into each consuming plugin** — not a monorepo, no
workspaces. A change here does nothing for a plugin until it's released (tagged AND `npm publish`ed)
and that plugin bumps/reinstalls. The plan it follows, and the consumers it is meant to replace code
in, are in `duet-gcode-postprocessor/docs/gcode-core-plan.md`. **Note**: after `npm publish` reports
success, the registry can take ~1-2 minutes to actually serve the new version — poll `npm view
dwc-gcode-core version` before bumping a downstream consumer, don't assume it's immediately live.

## Commands

- `npm run typecheck` — the library **and** the tests (`tsconfig.test.json`). The tests are
  type-checked on purpose: a test-only type error once failed a plugin's release build after every
  local gate had passed.
- `npm test` — vitest, node environment. No DWC checkout needed.
- `npm run build` — `tsc` to `dist/`.
- `npm run triage -- <from> <to> [--out file]` — see "Tracking RRF".

## Rules

1. **Faithful to RRF source, cited.** Every statement about what a command means names the RRF
   release, file and `case` it was read from, and the wiki passage where relevant. When source and
   wiki disagree, source decides the behaviour and the disagreement goes in
   `docs/wiki-discrepancies.md` with both quotes.
2. **Moved code keeps its behaviour, unless a bug fix is deliberate and listed.** Consumers migrate by
   swapping imports and expect zero change; any behaviour change needs a test that failed before it
   and a line in the changelog that says what changed.
3. **Pure.** `lib` is `ES2021` with `types: []`, so a DOM or Node API in `src/` fails the type check.
   No runtime dependencies.
4. **The tokeniser is a hot path.** Consumers run it over every line of 200 MB files. It returns index
   spans, and `parseParams` is opt-in. Don't add allocation to `tokenise()`.
5. **Imports carry `.js` extensions** — the emitted ESM must resolve outside a bundler.
6. **Every test has teeth**: break the behaviour and watch it fail before trusting it.
7. **A subpath is excluded from the root `index.ts` barrel when it would collide by name with
   something the root already exports differently** — `edit.ts` (a raw-line `setParam`) vs.
   `params.ts` (a tokenised-body `setParam`) is the first case; `test/package.test.ts`'s
   `ROOT_EXCLUDED_SUBPATHS` is where an exclusion gets registered, and the same test proves the root
   still resolves to the *other* one, not silently to whichever module happened to load last.
8. **`typesVersions`' wildcard target needs a two-candidate fallback array** (`["dist/*", "dist/index.d.ts"]`), not just `["dist/*"]` — under classic `moduleResolution: "node"`, the wildcard's "subpath"
   matches empty for the bare root specifier too, rewriting it to `dist/` (no filename), which fails
   and shadows the top-level `types`/`main` fields entirely; the second candidate is what lets the
   root specifier fall through to `dist/index.d.ts`. This is NOT an `exports`/`require`-condition
   issue (both were tested directly and ruled out) — task 16 found and fixed this against a real
   repro (`test/packaging/legacy/`, `npm run test:packaging`) after a real DWC 3.6 build broke on it
   (resonance-lab's own dual DWC 3.6/3.7 target); see README's "Legacy webpack/CJS builds" section.
   Adding a new subpath: keep it in `package.json` `exports` AND make sure it still matches
   `typesVersions`' `"*"` wildcard (it will, unless the subpath itself is `"."`-shaped).

9. **A "reviewed" dictionary entry must list what RRF actually reads — an empty `parameters` list flags
   every real use.** When a handler delegates (`kinematics.Configure`, `Display::Configure`,
   `Platform::GetSetAncillaryPwm`), follow it to the `gb.Seen(...)` calls; M671/M571/M918 were reviewed
   empty and misfired for weeks. A command that runs a macro hands every letter to it as `param.X`:
   mark it `macroParameters` (M98 with `trigger: "P"`, G32, and any code RRF has no `case` for, which is
   also `unimplemented: true` — that flag is what `reachesMacroFile` reads). Do NOT use
   `axisParameters` for this: it feeds the project model's axis symbols.
10. **User-defined G/M codes** (`/sys/M1234.g`) are `files/customCodes.ts`. `reachesMacroFile` encodes
    `TryMacroFile`'s real reach (G and M only, never T; fractional forms except the numbers RRF takes
    fractions of; an implemented code's same-named file never runs). Events are `files/events.ts` — an
    event macro's name is the `EventType` enumerator with `_`→`-`. Adding an event or a custom-code
    route means updating `docs/invocation-table.md` and `docs/file-kinds.md` too.
11. **Firmware forks**: a command/parameter that exists only on the STM32 fork (`gloomyandy/
    RepRapFirmware`) carries `platforms: ["stm32"]`, cited to that repo's branch@commit. The lint only
    judges it when `DiagnoseOptions.platform` (or the mainboard in `boards`) is known.
12. **The object-model schema is generated and has three truths, in this order of authority: RRF's own
    `OBJECT_MODEL_TABLE`s, the `Duet3D/ObjectModel` TypeScript source, then `documentation.json`.** The npm
    package is a DWC/DSF mirror and omits RRF-only keys (`seqs`) — those live in
    `RRF_ONLY_PATHS` in `scripts/build-om-schema.mjs`, each verified at 3.6.3 and the baseline. An
    array element (`x[]`) resolves through the array's `array` depth in `objectModelPath`; never list
    `x[]` separately. Regenerate with `node scripts/build-om-schema.mjs` (needs network + `gh`).

## Sources

The local RRF clone `docs/tasks/README.md` names (`...\RRFBuild\RepRapFirmware`) is not on every machine.
If absent, `git clone --depth 1 --branch <tag> https://github.com/Duet3D/RepRapFirmware.git` into the
system temp dir (never the repo) and `git grep` there; the STM32 fork is
`gloomyandy/RepRapFirmware` (`v3.7-dev`, `v3.6-dev`), CAN event enums are in `Duet3D/CANlib`
`src/RRF3Common.h`. Cite `file:line` at the tag you read, not at a branch tip. Scripted edits of
`dictionary/commands.json` must go through a text replace, not `JSON.stringify` — the file is
hand-formatted (tabs, CRLF in the working tree, inline `[1, 2]` arrays); then run
`node scripts/build-dictionary.mjs`, `npm run docs:diagnostics` and `npm run docs:api`.

## Tracking RRF

`RRF_BASELINE` in `src/rrf.ts` and `rrf.baseline` in `package.json` must match (a test holds them
together). Moving them is a review: run the triage script between the baseline and the new tag,
close every item, then change both and tag the commit `rrf-<tag>`. `rrf-*` tags do not trigger the
release workflow; `v*` tags do.

What a baseline move actually takes (learned moving rc.1 -> rc.2, 2026-09-28):

- **The triage list is commits in watched files, not the changes that matter.** Also diff every line that
  reads a parameter across the range - `git diff -U0 <from> <to> -- src | grep -E '^[+-].*(gb|parser)\.(Seen|SeenAny|MustSee|TryGet|Get)'`
  - and every object-model table entry (`{ "key", OBJECT_MODEL_FUNC`). That is how `M955`/`M956` `P` going from
  `Seen` to `MustSee` (a `P`-less line that used to work now errors) and the accelerometer's move to
  `sensors.accelerometers[]` surfaced; `@duet3d/objectmodel` for the same release still had the old layout
  (rule 12: RRF's tables win - `RRF_SOURCE_OVERLAYS` in `scripts/build-om-schema.mjs`).
- **Pin an event to the `Version.h` string in the commit's own tree** (`git show <sha>:src/Version.h`):
  `3.7.0-rc.1+N` is a dev build between two tags, never a tag; `changesBetween` compares it fine.
- **A change to a line that does NOT give a parameter** (a default that changed, a parameter that became
  mandatory) is a `whenAbsent` parameter target: `"upgrade"` for "now required", `true` for "default changed".
- **Then move the citations**: `node scripts/rebase-citations.mjs <from> <to> --rrf <clone> [--ok-lineless <path>]...
  [--bare docs/invocation-table.md --bare docs/file-kinds.md] --write`. It moves a citation only when the cited
  lines are provably unchanged and lists the rest for you to re-cite against the new tag. It preserves
  whatever accuracy a citation had - about 40% of the dictionary's line numbers were already a few lines off
  at rc.1 (count them with a `gb.Seen('X')`-token check) - so re-cite an entry against exact lines whenever you
  edit it. Verify a rewrite independently (text at the old lines == text at the new); the script's first
  version passed an equal-length rewrite inside a cited range, and the independent check caught it.
- A citation that describes the *old* release stays at the old tag (`RRF 3.7.0-rc.1 ... - the rc.1
  behaviour`); the script leaves those alone when their lines were touched, and you must not run it with
  `--ok-lineless` for a file that has one.

## Releasing

Bump `package.json`, commit, `git tag vX.Y.Z && git push origin vX.Y.Z` — the release workflow tests,
then publishes a GitHub Release with the shared changelog. `npm publish` is manual.
