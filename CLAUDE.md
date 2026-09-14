# dwc-gcode-core — working notes

Framework-free TypeScript library: RepRapFirmware-faithful G-code parsing for the DWC plugin family.
**Not on npm yet** — consumers depend on a `github:jaysuk/dwc-gcode-core#vX.Y.Z` tag (the same
bootstrapping pattern `dwc-plugin-runtime`/`dwc-config-backup-core` used before they were published).
**Bundled into each consuming plugin** — not a monorepo, no workspaces. A change here does nothing
for a plugin until it's tagged/released and that plugin bumps its dependency to the new tag. The plan
it follows, and the consumers it is meant to replace code in, are in
`duet-gcode-postprocessor/docs/gcode-core-plan.md`.

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

## Tracking RRF

`RRF_BASELINE` in `src/rrf.ts` and `rrf.baseline` in `package.json` must match (a test holds them
together). Moving them is a review: run the triage script between the baseline and the new tag,
close every item, then change both and tag the commit `rrf-<tag>`. `rrf-*` tags do not trigger the
release workflow; `v*` tags do.

## Releasing

Bump `package.json`, commit, `git tag vX.Y.Z && git push origin vX.Y.Z` — the release workflow tests,
then publishes a GitHub Release with the shared changelog. `npm publish` is manual.
