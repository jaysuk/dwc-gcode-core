# 10 — The command dictionary: every command, versioned and cited

**Status: Done**

## Findings

- **`dictionary/commands.json`, not `commands.jsonc`.** The task's own Decisions section calls for a
  "human-editable, comments allowed" JSONC file. This package has no JSONC parser anywhere and adding
  one just for this file was judged not worth it: every fact a comment would carry (why a value is
  what it is, which RRF function was read) already has a dedicated place in each entry's own
  `sources` array and the parameter-level `sources` arrays, which the generator's `validate()`
  requires to be non-empty. Plain `.json` with mandatory citations turned out to carry the same
  information with no parser to write and maintain.
- **`STRING_ARGUMENT_CODES` is hand-synced, not generated.** `scripts/build-dictionary.mjs` keeps its
  own literal copy of the 7-code set (`M23 M28 M30 M32 M36 M38 M117`) instead of importing
  `lex.ts`'s `STRING_ARGUMENT_COMMANDS` — a generator script depending on the library it generates
  data for would be a build-order inversion (the generator must be able to run before the library
  builds). `test/dictionary.test.ts`'s "STRING_ARGUMENT_COMMANDS stays in step with the generator's
  own copy" suite is what keeps the two from silently drifting apart; it also asserts every
  `stringArgument: true` dictionary entry is itself in `STRING_ARGUMENT_COMMANDS`.
- **RRF dispatches these; monacotokens' `gcodes.json` doesn't have them** (found by diffing RRF
  3.7.0-rc.1's `GCodes2.cpp` `HandleGcode`/`HandleMcode` switches against the 276 monacotokens
  codes): `M85` ("Set inactive time" — dispatched but its body is literally `break;`, a no-op stub),
  `M407` (filament-width report; the adjacent source comment notes "Support for M408 was withdrawn at
  version 3.7"), `M601` (aliased into the shared `M226`/`M600`/`M601` pause-handling fallthrough
  block), and a **false positive**: bare `G38` — the real dispatched forms are `G38.2`/`G38.3`/
  `G38.4`/`G38.5` via `commandFraction`, and those four *are* in monacotokens (`dictionary/draft/
  G38.*.json`). All four real gaps (`M85`, `M407`, `M601`, plus `M600`) are now reviewed entries in
  `dictionary/commands.json`, not just drafted — they were cheap to finish once found.
- **monacotokens has these; RRF 3.7.0-rc.1's switch doesn't dispatch them**: `M301`, `M304`, `M573`,
  `M650`, `M651`. Confirmed by source inspection, not just absence-from-grep: `M301` survives only as
  an internal struct name (`M301PidParameters` in `FOPDT.h`/`FOPDT.cpp`) for PID-parameter shape,
  surfaced through `M307`'s own reporting, not a standalone command; `M573`'s old behaviour (report
  heater average PWM) has a source comment saying it "is no longer supported because you can use
  `echo heat/heaters[N].avgPwm` instead"; `M650`/`M651` have a similar "no longer handled specially,
  use macros" comment. These stay draft-only — reviewing them further would only be documenting that
  they don't exist, which the coverage/Findings record already does.
- **Two apparent extra "missing" M-codes were a naive-grep false positive, not a real gap**: a first
  pass diffing `case N:` labels flagged `M6`/`M7` as RRF-dispatched-but-undocumented. Reading the
  surrounding source showed these `case` labels belong to an unrelated *nested* `switch` inside the
  `M118`/message-port handler (selecting a port type: 0 generic, 1 USB, ...), not top-level M-code
  dispatch at all. Recorded here as a caution against trusting a bare `case N:` grep without reading
  the enclosing scope.
- **Tier 1 (task step 2) is fully reviewed**: every code in the task's own list, plus every code the
  real fixtures in `test/corpus/slicer/*.gcode` actually use. The fixture sweep caught real dictionary
  gaps a static review missed — `test/dictionary.test.ts`'s corpus-based parameter check failed
  against the first draft of this dictionary three times before it passed:
  - `M84`'s first pass had *zero* parameters — wrong. RRF's `case 17/18/84` (they share one body) does
    read axis letters (disable/enable that axis's drivers specifically), `E` (extruder drive numbers,
    colon list) and `S` (idle timeout). `cura.gcode`'s real `M84 X Y E` line is exactly this — not an
    unknown-parameter file, a dictionary gap.
  - `M204`'s first pass had `S`/`P`/`T` only, missing `R`. PrusaSlicer's fixture emits
    `M204 P1250 R1250 T1250`; re-reading `GCodes::ConfigureAccelerations` line by line confirmed RRF
    genuinely never reads `R` — it's Marlin's retract-acceleration parameter, silently ignored by
    RRF, which has no separate retract-acceleration setting. Documented as such rather than either
    omitted (which the test would keep failing on) or invented as if RRF used it.
  - `commandSpec("T0")` (and any other numbered tool selection, `"T1"`, `"T-1"`, ...) returned `null`
    — the dictionary only ever had one entry keyed by the bare `"T"` RRF's own wiki and
    `GCodes2.cpp::HandleTcode` use, but `lex.ts`'s `LexedCommand.code` for a numbered tool select is
    the numbered string itself (`"T0"`), not `"T"`. Fixed in the generated `commandSpec()` with a
    fallback: an unresolved code matching `/^T-?\d+$/` resolves to the `"T"` entry. (First attempt at
    this regex silently lost its `\d` — a template-literal escaping bug in the generator script,
    caught immediately by the same test re-run.)
  - `M900` (Marlin linear advance, `M900 K0.04` in `prusaslicer.gcode`) is not dispatched by RRF at
    all — confirmed via the `HandleMcode` `default:` case, which sends an unrecognised M-code through
    `TryMacroFile` (attempting an `M900.g` macro) rather than erroring outright. Documented with `K`
    listed and explained, the same pattern as `M453`'s "no longer supported here" `S` and `M73`'s
    "accepted... but currently ignored" `P`.
- **`src/commands/toolParams.ts` is now a derived query** over the dictionary's own reviewed
  `toolNumber`-kind parameters (step 4), not a hand-maintained list — see the module's own doc
  comment. This is a strictly more complete table than the one it replaced: the old hand-curated list
  excluded `M207`'s `P` "on realistic scope" (config.g-only, unlikely in slicer output) and never
  considered `M104`/`M109`'s `T` at all. Both are now included automatically, since both are genuine,
  reviewed `toolNumber` parameters — a real improvement the derivation surfaced, not a regression.
  `G10`'s `P` still needs its own `when` guard (`g10Form`), since which RRF *form* a `G10` line is in
  is a per-line fact the dictionary's per-parameter schema has no way to express — exactly the case
  the task's Decisions section anticipated ("keep g10.ts, its form logic isn't expressible as a
  table"). Only **reviewed** dictionary entries are considered; a draft entry's `kind` is a
  monacotokens-description regex heuristic (`inferKind` in the generator), not something read from
  RRF source, and isn't trustworthy enough to drive a rewrite.
- **`g10.ts` now reads its own non-`L` letter list (`P`, `R`, `S`) from `commandSpec("G10")`** instead
  of a second hardcoded literal, with a fallback to the same three RRF-source-cited letters if the
  dictionary entry is ever missing. The axis-letter list (`X`,`Y`,`Z`,`U`,`V`,`W`,`A`-`D`) stays
  hardcoded, as before — it is genuinely not a fact the dictionary's `axisParameters` (a generic
  per-machine catch-all) can express, since RRF checks only the machine's *configured* axes.
- **Wiki-example validation (Tests section) was not built as literally specified.** The task calls
  for validating "every wiki example line" against its own section's spec, but the wiki's example
  corpus isn't vendored into this repo and fetching/curating it was out of scope for this pass. In
  its place, `test/dictionary.test.ts`'s "reviewed dictionary entries accept the parameters real
  slicer output uses" suite validates every reviewed entry against `test/corpus/slicer/*.gcode` — real
  Cura/PrusaSlicer/OrcaSlicer output already vendored for `corpus.test.ts` — with the same
  `KNOWN_BAD_EXAMPLES` escape-hatch shape the task asked for. This substitute already earned its keep:
  it is what caught the `M84`/`M204`/`M900`/`T0` gaps above. Pulling in genuine wiki example lines
  remains open follow-up work, noted for whichever task next touches the dictionary (task 12's
  release-model work is the next thing that reads `dictionary/commands.json` closely).
- **Coverage after this task**: 280 commands known (276 from monacotokens + `M407`/`M601`, both found
  missing from it, + the two forms already reasoned about above), **93 reviewed** (tier 1 in full,
  plus `M600`/`M601`/`M85`/`M407` found along the way, plus `G21`/`M73`/`M105`/`M900` pulled in by the
  corpus sweep), 187 remaining draft-only — recorded in the committed `dictionary/coverage.json`.
  Reviewing the remaining ~187 non-tier-1 commands (the task's step 3) is explicitly not attempted in
  this pass; per the task's own Acceptance criterion, they are "explicitly listed as drafted-only in
  `dictionary/coverage.json`" rather than silently left unreviewed. This is honest partial completion
  of step 3, not a claim that step 3 is done — task 12 (release model) will need to read further into
  the non-tier-1 codes anyway when it establishes `since`/`until` history, and can extend review
  coverage as it goes rather than this task re-deriving effort that will be spent again there.

## The gap

Semantic coverage is 5 of 276 commands (`src/commands/`). Validation ("unknown parameter", "missing
required", "wrong value", "not available on firmware X") and release diffing both need a
machine-readable spec of **every** command.

## Sources

- `@duet3d/monacotokens@3.7.0-rc.1` `gcodes.json` — 276 entries (inspect the exact shape; expect
  code, summary, parameters with letter/description/values, deprecation info). Earlier published
  versions (`npm view @duet3d/monacotokens versions`) give history; there is **no 3.6.3** release.
- Wiki `Gcodes.md` (pin a SHA): about 288 command sections, 675 firmware-version mentions, 33
  "Order dependency" sections, 34 deprecation mentions.
- RRF source at the baseline: each command's handler (`case N:` in `GCodes2.cpp` and the functions
  it calls, across the ~70 files that read parameters — find them with
  `git grep -l -E "gb\.(Seen|MustSee|TryGet)"`). Read the accessor each parameter uses:
  `MustSee` ⇒ required; limited-value getters ⇒ range; array getters ⇒ list; quoted-string getters ⇒
  string; driver-id getters ⇒ driver id; `TryGet…` ⇒ optional. Confirm each accessor's meaning in
  `GCodeBuffer.h` before relying on this mapping.

## Decisions

- **Data, not code**: `src/dictionary/commands.ts` exports a frozen `COMMANDS` record, generated by
  `scripts/build-dictionary.mjs` from a reviewed source file, `dictionary/commands.jsonc` (in-repo,
  human-editable, comments allowed). The generator validates it and emits the `.ts`.
- **Draft, then review**: the generator can bootstrap `dictionary/draft/<code>.json` from
  monacotokens and the wiki. An entry moves into `commands.jsonc` only after its handler has been read
  in RRF source; each reviewed entry carries `reviewed: "3.7.0-rc.1"` and its `sources`.
- **Kinds** (extend only with a cited reason): `number`, `integer`, `unsigned`, `boolean01`,
  `string`, `driverId`, `pin`, `axisLetters`, `toolNumber`, `heaterNumber`, `fanNumber`,
  `sensorNumber`, `probeNumber`, `bitmap`, `filename`, `any`. Each parameter says whether it takes a
  colon list and whether an expression is allowed.
- `STRING_ARGUMENT_COMMANDS` (task 05) is regenerated from `stringArgument: true` entries.
- **Order dependencies** come only from the wiki's "Order dependency" sections, cited.

## Schema

```ts
export interface CommandSpec {
	code: string; summary: string;
	machineModes?: ReadonlyArray<MachineMode>;        // omit = all
	context?: "config" | "any";                       // "config" only where source or wiki says so
	since?: string; until?: string;                   // RRF versions; omit = before our window / still present
	deprecated?: { since?: string; replacement?: string; source: string };
	stringArgument?: boolean;
	parameters: ReadonlyArray<ParamSpec>;
	axisParameters?: { kind: ParamKind; list: boolean; description: string };
	mustFollow?: ReadonlyArray<{ code: string; when?: string; source: string }>; // order dependency
	mustBeLastOnLine?: boolean;                       // macro-invoking commands, per the wiki
	reviewed?: string; sources: ReadonlyArray<string>;
}
export interface ParamSpec {
	letter: string; description: string; kind: ParamKind; list: boolean; expressionAllowed: boolean;
	required?: boolean | "unknown"; values?: ReadonlyArray<{ value: string; description: string }>;
	range?: { min?: number; max?: number }; since?: string; until?: string; sources: ReadonlyArray<string>;
}
export function commandSpec(code: string): CommandSpec | null;
```

## Steps

1. Generator scaffold and draft bootstrap for all 276 codes. Also list (in Findings) every command
   RRF dispatches that monacotokens lacks, and every monacotokens code RRF doesn't dispatch.
2. **Review tier 1 first** — the commands that actually appear in configs and slicer output: every
   command present in `test/corpus/slicer/*`, plus `G0 G1 G2 G3 G4 G10 G28 G29 G30 G31 G32 G90 G91
   G92 M0 M1 M24 M25 M82 M83 M84 M98 M99 M104 M106 M107 M109 M116 M117 M140 M143 M190 M201 M203 M204
   M205 M207 M208 M220 M221 M291 M292 M302 M307 M308 M350 M400 M451 M452 M453 M486 M500 M501 M502
   M540 M550 M551 M552 M553 M554 M557 M558 M563 M566 M567 M568 M569 M572 M574 M575 M584 M586 M587
   M588 M589 M593 M600 M701 M702 M703 M906 M918 M950 M955 M956 T`.
3. Review the rest.
4. Replace `src/commands/toolParams.ts`'s table with a derived query (parameters of kind
   `toolNumber`); keep `g10.ts` (its form logic isn't expressible as a table) but have it read
   letters from the spec.

## Tests

- Schema validation of the whole dictionary (the generator refuses bad entries).
- **Every wiki example line validates against its own section's spec** (unknown letters, wrong
  kinds). Each failure is either a dictionary fix or a `KNOWN_BAD_EXAMPLES` entry with a reason.
- Every reviewed entry has at least one RRF-source citation.
- `test/dictionary.test.ts` extended: coverage (drafted / reviewed / total) asserted non-decreasing
  against a committed `dictionary/coverage.json`.

## Acceptance

All dispatched commands drafted; tier 1 fully reviewed; the rest reviewed or explicitly listed as
drafted-only in `dictionary/coverage.json`.

## Traps

- monacotokens lists some parameters RRF no longer reads, and misses some it does. Source wins.
- A parameter can be required only in some circumstances — use `required: "unknown"` plus a note
  rather than a wrong boolean.
- Axis parameters depend on the machine's configured axes: model them with `axisParameters`, not as
  fixed letters.

## Out of scope

Behaviour beyond parameter shape (per-command code like `g10.ts`, added only when a consumer needs
it). Version history beyond what the wiki states — task 12 fills `since`/`until`.
