# 17 — Conditional parameter validation, enum-value coverage, and pin-name checking

**Status: Done.** Original scope written 2026-09-21 per the user's M308 report; expanded the same day
per the user's follow-up asking to (a) generalise the required/optional/enum work from M308 to every
reviewed command, and (b) close what was originally an open, blocking question about STM32 board
support with two real sources the user pointed at (`https://github.com/gloomyandy/RepRapFirmware`,
`https://github.com/gloomyandy/RRFBuild`). User then said "please begin" - implementation completed
same day, both Parts A and B, all nine steps, plus THREE same-day follow-up rounds (see "Follow-up:
`+`-joined multi-pin values", "Follow-up round 2" and "Follow-up round 3" near the end) - the first
two prompted by the user asking "are you sure that's all?", the third by a plain "continue": per-
command multi-pin support (round 1), a shared-vs-per-segment CAN-address distinction round 1 itself
got wrong for every command except M574 plus a genuinely bimodal, previously-mistyped `M950` `K`
parameter and a new `listLength` validation dimension (round 2), then 9 more real `listLength` fixes
found by triaging that dimension's own audit-script candidates against source (round 3). All fixed
and tested now.

**Part A is done - Steps 1-4 all complete, including the full `scripts/audit-dictionary.mjs` sweep
(all 67 candidates across all three categories triaged, not just some).** Net result: 9 real
dictionary fixes (3 of them correcting genuinely wrong pre-existing descriptions - `M143 C`, `M574 S`,
`M575 S` - not just filling gaps), a new `ParamSpec.valueMatch` and a broadened `ParamSpec.required`
(`{ ifLetterPresent, valueOneOf?, valueNot? }`) applied to 4 real conditional cases, 3 confirmed-and-
documented false positives (`M569 R`, `M586 T`, `M106`'s six `requires P` params), 5 explicit
`required: "unknown"` markings for cases that genuinely don't fit the single-companion-letter shape,
and the `M308`/`M950` `SymbolRule.role` fix that was the direct answer to the user's own original
report. Every fix teeth-tested, all three gates green before every commit.

**Part B, Steps 5, 6 and 9 done**: both pin-table generators (48 community boards/1805 pins, 6 Duet
mainboards/266 pins - `Pins_FMDC.h` deliberately not yet included), the generic port.pin fallback
syntax, and a single `lookupPinName(boardId, name)` over both families with the CORRECT per-family
matching rules (including a real, teeth-tested fix: the port.pin fallback only applies to community
boards - a real Duet board has no such fallback at all, confirmed by reading the mainline's complete
`LookupPinName` end to end). New `dwc-gcode-core/pins/*` subpaths, root-exported.

**Steps 7 and 8 also done**: `project.ts`'s symbol tracker now has a `"pin"` type, generic off the
dictionary the same way `"axis"` already is, with `ProjectOptions.boards` resolving aliases through a
real board's table; and the two new diagnostic rules (`project/pin-already-used`,
`project/unknown-pin-name`) close out Part B entirely. Running the new rule against real fixtures
immediately found a genuine, previously-undetected pin conflict in task 13's own `fff-basic` fixture -
fixed, not the rule. See this section's own Findings/Decisions above, and the Steps list below, for
the full detail on every piece.

## The gap (as reported, in two rounds)

> When editing M308, the parser was unable to validate when an incomplete parameter (in this case Y,
> sensor type) was entered. Any gcode that has a set list of parameters available to it should
> validate the contents to ensure they have been typed in correctly. The parser should also correctly
> be able to identify when a parameter is required, optional, or not needed. The parser should
> identify when a pin name is used more than once in a file and highlight it as an issue. The parser
> should be able to store a list of all the pin names possible that can be used on an official board
> and be able to identify when one has been entered incorrectly. For an STM32 based board this is
> slightly harder, however all the pin names that are available can be obtained from an M122 P200
> output. Pin numbers may also be used in place of pin names and can be in the form of PA_1, PA1,
> PA.1, A.1, A_1, A1. The pin names for RP2040 based expansion boards are preset like the duet boards.

> the STM32 fork can be found here https://github.com/gloomyandy/RepRapFirmware it may be easier to
> contain a list for every board rather than query M122 P200. A list of each boards pin names can be
> found in each rrfpins.txt file for each board
> https://github.com/gloomyandy/RRFBuild/blob/v3.7-dev/boards/btt/octopuspro1_1_h723/rrfpins.txt
> please expand looking at issues with required, optional etc from M308 to all gcode as well as making
> sure all lists are populated for all parameters that are from a set list.

Two parts, same as before, both now broader: **A** (required/optional/not-needed modelling and
enum-`values` coverage, generalised across the whole reviewed dictionary, not just M308) and **B**
(pin-name symbol tracking - duplicates, and validation against known per-board pin lists, now
including STM32/community boards via the two sources above).

## Findings

### Part A — generalised beyond M308

**Step 1 implementation findings (2026-09-21) - two real bugs found that neither draft of this task
file anticipated, both fixed as part of Step 1, not deferred:**

- **`dictionary/value-out-of-range` never actually matched a quoted string `values` entry at all.**
  `LexedParam.value` (`src/lex.ts`'s own doc comment) keeps quotes verbatim ("Raw value text exactly
  as written - quotes/braces included"), so comparing it against an unquoted dictionary value like
  `"zvd"` would compare the literal 5-character string `"zvd"` (with quote characters) against `zvd`
  and always fail. Invisible until now because every PRIOR `values` user (`G29`'s `S`, `M143`'s `A`,
  `M500`'s `P`) is `kind: "unsigned"`, never quoted. Confirmed with a real teeth check: stashed the fix,
  reran the suite, and a real line in task 13's own `fff-basic` fixture (`M308 S<n> Y"thermistor"`,
  a genuinely valid value) started failing - proof this would have been a 100%-false-positive rule
  for every real quoted string enum, not a theoretical edge case. Fixed by unquoting (`params.ts`'s
  existing `unquoteString`) before comparing, only for `kind: "string"`.
- **M308's `Y` needed a second matching mode, M593/M569.1 didn't - checked precisely, not assumed.**
  `TemperatureSensor::Create` (`Heating/Sensors/TemperatureSensor.cpp:230`) matches via
  `ReducedStringEquals` (`RRFLibraries/src/General/StringFunctions.cpp:42-68` - case-insensitive,
  `-`/`_` ignored on EITHER side, but only while both strings still have characters left; a trailing
  separator after one side has ended is NOT ignored, e.g. `"thermistor-"` ≠ `"thermistor"`). M593's `P`
  and M569.1's `Y` both go through RRF's `NamedEnum` construction instead, which is plain `strcmp`
  (`RRFLibraries/src/General/NamedEnum.cpp:13-18`) - case-sensitive, exact. Added `ParamSpec
  .valueMatch: "exact" | "reduced"` (default `"exact"`) rather than assuming one behaviour for every
  string enum - a real, cited distinction between commands, not a simplification. The first JS port of
  `ReducedStringEquals` written for this was subtly wrong (independently skipped trailing separators
  on whichever side wasn't yet exhausted, which the real C++ doesn't do since its outer loop stops as
  soon as EITHER side hits null) - caught by re-deriving from the exact C++ control flow instead of
  trusting a "looks equivalent" rewrite, then added a fixture (`"thermistor-"` must NOT match
  `"thermistor"`) specifically for that failure mode.
- M308's own `Y` description previously used `"thermocouple-k"` as an example value - re-deriving the
  real enum from source (23 names, every `TypeName*`/`PrimaryTypeName`/`DuexTypeName` constant across
  `Heating/Sensors/*.h`, all unconditionally self-registered) found this was never a real RRF string at
  all (it reduces to `thermocouplek`, which matches nothing) - a pre-existing, harmless-until-now
  inaccuracy in the dictionary's own prose, corrected in the same pass.
- Board-variant availability (which sensor/encoder types a given board's firmware actually compiles
  in) is still not modelled, consistent with this package's existing scope limits for per-board (as
  opposed to per-RRF-version) availability elsewhere in the dictionary - documented in prose on the
  affected parameters (`M569.1`'s `Y`, specifically `mt6835`/`SUPPORT_MT6835`) rather than silently
  assumed universal.

**The machinery already exists; the gap is data coverage plus one schema limitation, both now sized
properly by actually running the audit, not guessing at its scope.**

- `ParamSpec.values` (`src/dictionary/schema.ts:28`) already exists and is already enforced by
  `dictionary/value-out-of-range` (`src/diagnostics/rules.ts:368-372`) whenever populated. **A quick
  script against the live dictionary** (`node` one-liner over `dictionary/commands.json`, filtering
  reviewed commands' `kind: "string"` parameters with no `.values`) found **38 candidates** across the
  97 currently-reviewed commands. Most are genuinely free text (MAC/IP addresses, netmasks, passwords,
  SSIDs, machine/tool/fan/object names, filenames, message box text) and are correctly `string` with
  no enum - **don't add a `values` list to these just to "complete" the sweep**, that would be
  inventing a false constraint RRF doesn't have. Two, checked against source, are real, confirmed
  enum gaps:
  - **`M593 P`** (input shaper type name) - `AxisShaper.h:16` declares
    `NamedEnum(InputShaperType, uint8_t, custom, ei2, ei3, mzv, none, zvd, zvdd, zvddd)` - eight fixed,
    lowercase, alphabetically-ordered names, cited directly, no conditional compilation. The
    dictionary's current description even lists a *subset* of these as examples
    (`"e.g. zvd, mzv, ei2, custom, none"`) without the other three (`ei3`, `zvdd`, `zvddd`) - a real,
    fixable gap, not a debatable one.
  - **`M569.1 Y`** (magnetic encoder chip type) - `AbsoluteRotaryEncoder.h:30` (Duet3Expansion, closed-
    loop driver code) declares `NamedEnum(MagneticEncoderType, uint8_t, as5047d, #if SUPPORT_MT6835
    mt6835 #endif)` - **conditionally compiled**, same shape as the RP2040 pin-table caveat below: only
    `as5047d` is universal, `mt6835` depends on the target board's build flags. Document that
    conditionality explicitly rather than silently listing both as always valid.
  - The remaining 36 candidates from the sweep are the audit's *starting list*, not a finished
    conclusion - each still needs the same "read the real source, decide enum vs free text" treatment
    `M593`/`M569.1` above got. Don't add `values` to any of them without doing that read first.
- **The same script, re-run for descriptions that already say "required when"/"requires X"/"only
  when" in prose** (i.e., cases the *original dictionary author already knew about* but the schema
  couldn't express, so `required` was left `undefined`) found **16 parameters across 8 commands**:
  `M106` (`T`/`H`/`B`/`L`/`X`/`C`, all "requires P" - **note**: `M106`'s own `P` (fan number) is very
  likely unconditionally required on its own already; re-check `commandSpec("M106").parameters` before
  treating these six as a gap - they may already be adequately covered and just verbosely worded),
  `M569.1` (`T`, `C`), `M572 L`, `M586 H`, `M586.4` (`W`, `T`), `M589` (`P`, `I`), `M593 H`, `M950 T`.
  Reading these together shows the conditional shapes are **more varied than a single "companion letter
  present" rule can express**:
  - **Simple presence**: `M586.4 T` required when `W` is given (a will message needs a will topic).
  - **Presence + specific value**: `M593 H` required when `P` **equals** `"custom"` (not just "P is
    present" - `P` is present on every `M593` invocation that sets a shaper). Same shape as the already-
    confirmed `M569.1 C`, required when `T` is `1` (linear composite) **or** `2` (rotary quadrature),
    not when it's `0`/`3` (none/rotary magnetic) - `Encoders`/`ClosedLoop.cpp:215,228` (Duet3Expansion).
  - **Presence + value exclusion**: `M589 P`/`I` required when `S` is given **and isn't** `"*"` (`"*"`
    is the special "delete configuration" form, which needs nothing else).
  - **Multi-parameter combination**: `M586 H` required only when `P` selects the MQTT protocol **and**
    `S1` enables it - two conditions, not one.
  - **List-shape condition**: `M572 L` required when `S` is given as a **two-element** colon list - not
    expressible as a presence/value condition on a single companion letter at all; this one may
    genuinely need to stay `required: "unknown"` with a note, rather than forcing it into whatever
    general shape gets built for the others (see Decisions).
  - **Multi-form, not a fixed pair**: `M950 T`'s meaning (and thus its condition) depends on which
    sub-form the line is - already documented as a known gap in task 14's own Findings
    (`docs/tasks/14-diagnostics.md:61-69`), the same shape as M308's `S`/`Y` (Decision 2/3 below).
- **A real bug independently confirmed while reading `Heat::ConfigureSensor`** (`Heat.cpp:1045-1080`):
  `Y`'s requiredness is a *project-level* condition (does this sensor number already exist), not a
  same-line one - `if (gb.Seen('Y'))` (re)creates the sensor; absent, RRF expects one already
  registered. `project.ts`'s `SYMBOL_RULES` (`src/project.ts:307`) marks **every** `M308 S<n>`
  unconditionally `role: "define"`, which is wrong per this source - the fix doubles as the mechanism
  for "required only on first use" (Decisions 2-3, unchanged from the original draft).
- **The audit needs a repeatable script, not a one-off read**, given the scale (97 reviewed commands
  now, more as coverage grows per `dictionary/coverage.json`) - see the new Decision/Step below, in
  the same spirit as task 12's `scripts/rrf-triage.mjs` (a systematic sweep producing candidates for
  human review, not a fully-automated "trust the output" tool).

### Part B — STM32/community boards, now sourced (was a blocking open question, now resolved)

**Both of the user's new links check out directly and answer the open question cleanly.**

- **`upstream` in the local `RepRapFirmware` clone already points at
  `https://github.com/gloomyandy/RepRapFirmware.git`** (confirmed via `git remote -v` - this was
  already the case before this task existed, per this package's own `docs/tasks/README.md` "Sources"
  section mentioning an `upstream=gloomyandy fork` remote with old tags). `git fetch upstream --tags`
  pulled real branches, including `upstream/v3.7-dev` - the exact branch the user's second link names.
  **No new clone needed**; this task can cite it the same read-only way (`git show upstream/v3.7-dev:
  <path>`) as `duet3d`/`origin` are already cited for the mainline.
- **`M122`'s `P<n>` argument genuinely has no `200` case anywhere in either fork** (re-confirmed on
  `upstream/v3.7-dev` too, not just the Duet3D mainline) - the user's own follow-up message agrees and
  redirects to the per-board `rrfpins.txt` file instead, which turns out to be a much better source
  anyway (see below): a plain-text, per-board, git-versioned file beats reverse-engineering a live
  diagnostic dump.
- **`rrfpins.txt` is this firmware's real, citable, per-board pin table - not user-editable data**.
  `STM32H7HardwareUsage.md`/`STM32F4HardwareUsage.md` (`upstream/v3.7-dev`, both files, matching
  sections) state directly: *"From version 3.5.0-rc.4 onwards we use a small in flash file system to
  contain[] two files rrfboot.txt and rrfpins.txt these files hold information about the board hardware
  ... and pin usage. This information is loaded at boot time before any user supplied board.txt file is
  loaded."* So this is board-firmware-embedded data, loaded before any user customisation - the same
  guarantee level as a compiled-in Duet `PinTable[]`, just shipped as flash-embedded text instead of a
  C++ array. The actual lookup code reads it from `0:/rrfpins.txt` on the SD card
  (`BoardConfig.cpp:74`, `pinsConfigFile`) - exactly how it reaches the SD card from the in-flash copy
  wasn't traced further (not needed for this task: the RRFBuild repo's per-board copy is the
  ground-truth source either way, since it's what gets built into that board's firmware release).
- **The real `LookupPinName` for this firmware family** (`upstream/v3.7-dev:src/Hardware/TGBTC/
  BoardConfig.cpp:920-995` - "TGBTC" = Team Gloomy BTC, the STM32 board-config subsystem) is
  **completely different from the mainline's compiled-`PinTable` version**, and fully explains the
  user's `PA_1`/`PA1`/`PA.1`/`A.1`/`A_1`/`A1` forms, cited exactly:
  - It reads `0:/rrfpins.txt` line by line: `<port.pin> <alias1>[,<alias2>,...]` - e.g.
    `F.3 bedtemp,tb` (real line, `boards/btt/octopuspro1_1_h723/rrfpins.txt`, fetched via `gh api` at
    `v3.7-dev`).
  - Matching an alias the user typed is **case-insensitive** (`tolower(*p) == tolower(*q)`, the
    opposite of the mainline's case-sensitive `LookupPinName`) and **tolerant of `_`/`-` the user typed
    but the file doesn't have** (`while (*p == '_') p++` before comparing, and again after every
    matched character) - so `bedtemp`, `bed_temp`, `bed-temp`, `BedTemp` all resolve to the same file
    entry even though the file only ever spells it `bedtemp`.
  - If no alias matches anywhere in the file, it falls back to `BoardConfig::StringToPin`
    (`BoardConfig.cpp:1049-1066`), whose own doc comment reads verbatim: *"Convert a pin string into a
    RRF Pin. Handle formats such as A.13, A_13, PA_13 or PA.13"* - **this is the exact citation for the
    user's six alternate forms**. Traced precisely: an optional leading `P`/`p` is skipped; the next
    character must be a port letter `A`-`I` (`port <= 8`); an optional single `.` or `_` separator is
    skipped; the rest is parsed as a decimal pin number `0`-`15`. `PA1`, `PA_1`, `PA.1`, `A1`, `A_1`,
    `A.1` all reduce to the identical `(port=0, pin=1)` result - confirming the user's list is exactly
    right, not approximate.
- **A real nuance found while spot-checking a board file for duplicate-detection design, not assumed**:
  the *same physical pin* can legitimately appear on **two different lines** of one board's own
  `rrfpins.txt`, under two unrelated alias groups - e.g. `octopuspro1_1_h723`'s `A.5`/`A.6`/`A.7` are
  listed once as `lcdmiso`/`lcdsck`/`lcdmosi` (the 12864 display header) and again as `miso`/`mosi`/
  `sck` (the general SPI bus pins) - two legitimate names for one wire, by board design. **This means
  pin-identity normalisation for the duplicate-use check (Decision 5/6, Part B) must resolve an alias
  to its canonical `port.pin` form via the board's own table before comparing** - comparing raw alias
  strings (even after modifier-stripping) would miss a real conflict where a user types `bedtemp` on
  one line and `tb` on another, and would falsely treat `lcdmiso` and `miso` as unrelated when they're
  the same wire. This generalises what the original draft already said for the mainline (alias
  comparison must go through the board's table, not string equality) - now confirmed as a real,
  observed case rather than a theoretical one.
- **Scope, confirmed by listing the actual repo tree at `v3.7-dev`**: 48 `rrfpins.txt` files across 5
  manufacturer directories - `boards/btt/*` (15 boards: gtr1_0, kraken, octopus1_1, octopuspro1_0,
  octopuspro1_1, scylla1_0, skr2, skr3, skr3_h743, skr3ez_h723, skr3ez_h743, skrpro1_1, skrpro1_2,
  skrrrfe3_1_1, skrsebx2), `boards/fly/*` (19 boards), `boards/formbot/*` (1), `boards/fysetc/*` (4),
  `boards/ldo/*` (4). A small, tractable, generateable set - one text-file parser handles all 48,
  unlike the mainline's C++ `PinTable[]` parser which differs in syntax per source file.
- **The rest of the original Part B findings (RRF's own `IoPort::Allocate`/`portUsedBy` duplicate-pin
  behaviour, the `!`/`^`/`*` modifier stripping, the CAN-address `<n>.` namespace prefix, and the
  official Duet mainboard/CAN-expansion `Pins_*.h`/`<Board>.h` inventory) are unchanged from the
  original draft** - not re-quoted here, still accurate, still the grounding for Decisions 5-7 below.

## Decisions

**Part A**

1. **Populate `M308`'s `Y`, `M593`'s `P`, and `M569.1`'s `Y` with `values`, each cited fresh from
   source at implementation time** (not copied from this Findings section, which was a sampling pass).
   `M569.1`'s `Y` needs the conditional-availability note (Decision 4 below) for `mt6835`, not just a
   flat list. Small, low-risk, uses existing machinery end to end - do these first.
2. **A systematic audit script for the other ~35 `values` candidates and the dictionary's remaining
   non-`kind:"string"` parameters too** (an enum-shaped constraint isn't exclusive to string kind - a
   small `integer`/`unsigned` parameter with a short, fixed, named set of meaningful values, like
   `M569.1`'s own `T` encoder-type numbers `0`-`3`, is just as real a "set list" as a string enum, and
   the user's own wording - "any gcode that has a set list of parameters" - doesn't distinguish by
   kind). Modelled on task 12's `scripts/rrf-triage.mjs`: produce a report of candidates (parameter +
   description + a guess at whether it looks enum-shaped) for a human pass, not an auto-apply tool -
   the M106/`values`-vs-free-text split above shows plenty of description text *looks* like it should
   have `values` but is actually genuinely open (a machine name, a filename) and plenty of *numeric*
   parameters described in prose as one-of-a-small-set (`M569.1 T`'s four documented encoder types)
   currently have no `values` list either, purely because the existing dictionary only ever populated
   `values` for the few `kind: "string"` cases that obviously needed it, never as a deliberate sweep.
3. **Extend `SymbolRule.role` to a conditional form for the "creates a resource" shape** (unchanged
   from the original draft): `role: "define" | "use" | { ifLetterPresent: string; else: "use" }`.
   Fixes `M308`'s `S` rule (`define` only when `Y` is also seen) and `M950`'s heater `H` rule (`define`
   only when `C` is also seen, task 14's already-flagged gap). This piece stays *same-line-scoped* -
   `gb.Seen('Y')`/`gb.Seen('C')` are same-line checks in RRF's own source, not order checks.
4. **A broader `ParamSpec.required` shape is needed than the original draft's single-condition
   sketch**, given the variety actually found in this round's audit (Findings, above): at minimum,
   presence-of-another-letter, presence-with-a-specific-value (`oneOf`), and presence-with-value-
   excluded (`M589`'s `"*"` case) all have real, confirmed examples. **`M572 L`'s list-length condition
   is the one case that doesn't fit any of those** - don't force a bespoke "list length" shape into the
   schema for one parameter; leave it on `required: "unknown"` with a note, same as this field's
   original, still-valid purpose. **Do not build a general expression-evaluator for this** - every
   condition found is a simple, literal comparison against another parameter on the same line; RRF's
   own source expresses every one of them the same simple way (a handful of `if (gb.Seen(...))`/
   `== SomeEnum::value` checks), so the schema shape should mirror that directly, not grow into a
   rules engine.
5. **`required: "unknown"`'s original purpose (Decision 4 in the first draft) narrows rather than
   disappears**: it was drafted as a catch-all for "conditional required-ness the schema can't yet
   express" - now that (4) covers most real cases, `"unknown"` becomes specifically for cases like
   `M572 L` that don't fit even the broadened shape, not a dumping ground for anything inconvenient.

**Part B**

6. **Two independent pin-table sources, two independent (simple) generators - do not try to unify them
   into one parser.** Official Duet mainboards/CAN-expansion boards: compiled C++ `PinTable[]` arrays,
   case-sensitive matching, comma-separated aliases inline in the array initializer (unchanged from the
   original draft's Decision 7). STM32/community boards (the gloomyandy fork): plain-text `rrfpins.txt`,
   one `<port.pin> alias1[,alias2,...]` line per pin, case-insensitive and `_`/`-`-tolerant alias
   matching, plus the generic `PA_1`-family port.pin fallback syntax that needs no per-board data at
   all (it's a fixed algorithm, cited in Findings - implement it once, directly, not as generated data).
   The text-file parser is considerably simpler than the C++ one; do it first if sequencing this by
   difficulty.
7. **Pin-identity normalisation must resolve through the relevant board's own alias table, not just
   strip modifier characters** (this is a real correction to the original draft's Decision 5, which
   only described modifier-stripping): two different alias strings that the board's table maps to the
   same `port.pin` (Findings' `lcdmiso`/`miso` example) are the same symbol for duplicate-detection
   purposes. This means the pin-symbol tracker (`project.ts`, Decision 5 in the original draft, still
   correct as far as it went) needs the board's pin table available at symbol-build time to resolve
   aliases, not just at the separate `project/unknown-pin-name` validation step (Decision 8, original
   draft) - the two features share a dependency on "which board(s) are in play" that wasn't fully
   threaded through in the first draft; see the updated API sketch.
8. **Board identity, not just "STM32 vs not"**: `DiagnoseOptions.boards` (original draft's API sketch)
   needs to resolve to a specific board id from either family (e.g. `"duet3mini"` or
   `"btt-octopuspro1_1_h723"`), since STM32/community-board pin lists are genuinely per-model (48
   distinct files), not per-family. Generated pin-table data should carry which parsing family
   (`"compiled"` vs `"rrfpins-txt"`) it came from only as provenance/citation metadata, not as
   something a consumer needs to branch on - `lookupPinName(boardId, name)` should present one uniform
   interface regardless of source.
9. **The generic port.pin fallback syntax (`PA_1` etc.) is a real gap for the OFFICIAL Duet boards
   too, worth checking before assuming it's STM32-only**: the mainline `LookupPinName`
   (`Config/Pins.cpp:20`) has no equivalent fallback in what was read for the original draft - only
   exact alias-table matches. Confirm this at implementation time (re-read `IoPort::Allocate`'s full
   call chain, not just `LookupPinName` itself, in case a numeric fallback lives elsewhere on the Duet
   side) before assuming `PA1`-style typing is STM32-exclusive; if it turns out Duet boards also accept
   a port/pin numeric form somewhere, the validator needs to accept it there too, not just for STM32.
10. **The original "Open question" is resolved - remove the "STM32 unsupported" carve-out from
    Acceptance/Traps** (updated below). STM32/community boards are now in scope for
    `project/unknown-pin-name` and the `PA_1`-family syntax, on the same footing as official Duet
    boards, cited the same way.

## API sketch

```ts
// src/dictionary/schema.ts — Part A
export interface ParamSpec {
	// ...existing fields...
	/** Replaces most of "unknown"'s old role (Decision 4/5). Each condition is a literal, same-line
	 *  comparison against another parameter - mirrors how RRF's own source expresses every real case
	 *  found (gb.Seen(...) / == SomeEnum::value), deliberately not a general expression evaluator. */
	required?: boolean | "unknown" | {
		ifLetterPresent: string;
		/** Narrows "present" to "present and equal to one of these" (e.g. M593 H needs P="custom"). */
		valueOneOf?: ReadonlyArray<string>;
		/** Narrows "present" to "present and not equal to" (e.g. M589 P/I need S != "*"). */
		valueNot?: string;
	};
}

// src/project.ts — Part A (unchanged from original draft) + B (board-aware now, Decision 7)
interface SymbolRule {
	code: string;
	letter: string;
	type: string;
	role: "define" | "use" | { ifLetterPresent: string; else: "use" };
	list: boolean;
}
export interface ProjectOptions {
	// ...existing fields...
	/** Board(s) in play, keyed by CAN address (0 = mainboard) — needed to resolve a pin alias to its
	 *  canonical identity (Decision 7) before duplicate-detection can trust two different alias
	 *  strings are/aren't the same physical pin. Omitting an address falls back to raw normalised-
	 *  string comparison for that board's pins (Decision 5's original, narrower behaviour) rather than
	 *  failing outright. */
	boards?: ReadonlyMap<number, string>;
}

// src/diagnostics/rules.ts — Part B
// project/pin-already-used: error, cited to IoPorts.cpp IoPort::Allocate (mainline) — same rule,
//   now board-alias-aware per Decision 7.
// project/unknown-pin-name: warning, needs board identity — same DiagnoseOptions.boards as above.

// new: src/pins/tables.ts (subpath TBD) — Part B, generated data + lookup, both board families
export interface PinTableEntry { canonicalName: string; aliases: ReadonlyArray<string> }
export interface BoardPinTable {
	boardId: string;
	family: "duet-compiled" | "rrfpins-txt";       // provenance only, not a branch point for consumers
	pins: ReadonlyArray<PinTableEntry>;
	sources: ReadonlyArray<string>;
}
export const BOARD_PIN_TABLES: ReadonlyArray<BoardPinTable>;   // scripts/build-pin-tables.mjs (Duet)
                                                                 // + scripts/build-pin-tables-rrfpins.mjs (community)
/** Case-sensitivity and modifier/port.pin-fallback handling differ per board family (Findings) —
 *  this function is where that's resolved once, so callers never need to know which family a board
 *  belongs to. */
export function lookupPinName(boardId: string, name: string): PinTableEntry | undefined;
```

## Steps

1. ✅ Done. `values` for `M308 Y`, `M593 P`, `M569.1 Y` (Decision 1). Also required, and got, a new
   `ParamSpec.valueMatch` schema field and a `dictionary/value-out-of-range` fix (quoted-string
   unquoting) neither draft anticipated - see Part A's Findings, "Step 1 implementation findings".
2. 🔶 In progress. `scripts/audit-dictionary.mjs` built (candidate generator: string params with no
   `values`, descriptions saying "required when X" without `required` set, and numeric params whose
   prose looks like a named enum). First run found **35 string-enum candidates, 16 conditional-required
   candidates, 16 numeric-enum candidates** - more than the manual sampling pass in this file's own
   Findings turned up, confirming the script earns its keep. First triage batch done (four numeric-enum
   candidates the script flagged "NO range set - a real validation gap"), each verified against real
   RRF source before touching anything, not applied on the script's say-so:
   - `M143 C` (heater monitor trigger): the EXISTING description had a fabricated value ("2 sensor
     reading error") that isn't in RRF's real 3-value enum (`Disabled=-1`/`TemperatureExceeded=0`/
     `TemperatureTooLow=1`, `Heating/HeaterMonitor.h`) - a genuine pre-existing inaccuracy the audit
     surfaced, not just a missing `values` list. Fixed with `values`.
   - `M574 S` (endstop input type): the EXISTING description also had wrong meanings for 1/2 ("active-
     high pin"/"active-low pin" - polarity is actually the `P` pin name's own `!` modifier, unrelated
     to `S`). Real meanings from `Endstops/EndstopDefs.h`'s `NamedEnum(EndStopType, ...)`. Also now
     correctly flags `S0` - RRF explicitly rejects it with its own error message, not merely
     undocumented. Fixed with `values`.
   - `M575 F` (serial parity): description was already accurate, just missing `values` -
     `GetLimitedUIValue('F', 3)` throws outside 0..2, confirmed it doesn't clamp. Fixed with `values`.
   - `M569 R` (enable polarity) - **checked and REJECTED, a real false positive from the script**:
     `Move::SetEnableValue` stores any `int8_t` the user types with no range enforcement anywhere in
     the call chain (`gb.GetIValue()`, unclamped); only two behaviours actually differ (`> 0` treated
     as active-high, `<= 0` as active-low, `== -1` additionally disables driver-status polling) - RRF
     itself accepts `R5` without complaint, so flagging it as `dictionary/value-out-of-range` would be
     inventing a rule RRF doesn't enforce. Documented here, not silently dropped - the same discipline
     this repo's consumer-migration work applied to three previously-claimed bugs that also turned out
     false on direct source inspection: record a checked-and-rejected candidate, don't just move on.
   **Second pass, same day - the two non-numeric categories are now FULLY triaged, not just
   partially**:
   - **All 35 `values`-less string candidates checked - confirmed genuinely free text, zero further
     gaps.** The three the heuristic itself flagged uncertain (`M291 K` "array of string choices" -
     user-authored menu text, not an RRF-defined set; `M586 C` a CORS origin URL; `M701 S` a
     user-named filament folder) were read directly and are all real free text, same as the other 32.
   - **All 16 original conditional-required candidates now accounted for**, not just the four already
     fixed: `M572 L` and `M950 T` set to explicit `required: "unknown"` (list-length and multi-form/
     two-letter conditions, same "doesn't fit the single-companion shape" reasoning as `M586 H`,
     each cited). **A second real false positive found, same class as M569's `R`**: `M106`'s `T`/`H`/
     `B`/`L`/`X`/`C` all said "requires P" in prose, but re-reading `GCodes2.cpp`'s real M106 dispatch
     shows `P` is never `gb.MustSee`d at all - these six parameters are simply never read at all when
     `P` is absent (`FansManager::ConfigureFan`, which reads them, only runs inside the `seenFanNum`
     branch); RRF silently ignores them rather than erroring. Corrected the misleading wording, did
     NOT add a `required` condition (the mechanism is for a real thrown error, not a silent no-op) -
     this is a materially different shape of false positive than M569's R (there, RRF accepts
     anything; here, RRF silently ignores the parameter rather than validating it at all). The
     remaining 2 items the script's regex matched (`M569.1 T`, `M586.4 W`) were confirmed as
     regex-only false positives - both descriptions are correctly describing a DIFFERENT parameter's
     requirement (the ones already fixed), not their own.
   **Third pass, same day, closes out the numeric-enum category too - Step 2 is now fully done, all
   67 original candidates accounted for.** Of the remaining 9 ("NO range set" ones beyond the already-
   fixed `M143 C`/`M574 S`/`M575 F`): `M569.6 V` fixed with `values` - a genuinely non-contiguous set
   (`1`-`4` plus an undocumented `64`, `ClosedLoop::ProcessM569Point6`'s own `switch`) that `range`
   literally cannot express. `M575 S` fixed with `values` - and its EXISTING description was flat
   wrong ("0 raw, 1 PanelDue, 2 Duet3D device mode"), a third real dictionary inaccuracy this audit
   surfaced (after `M143 C`/`M574 S`): RRF's real `auxModes[]` table has 8 entries, not 3, with index
   0/1 both being PanelDue variants, not "raw" at all. `M586 T` checked and REJECTED - a third real
   false positive, same shape as `M569 R`: `NetworkInterface::EnableProtocol`'s `if (secure > 0)` never
   enforces any range, so flagging an out-of-range `T` would invent a rule RRF doesn't have. `M950 T`
   deliberately left alone (already `required: "unknown"`; its value meaning is genuinely per-form and
   doesn't reduce to one `values`/`range`, consistent with everywhere else this multi-form complexity
   has been handled). The remaining 8 "range already set, readability only" candidates (`G0 H`, `G1 H`,
   `M291 S`, `M291 J`, `M569.1 T`, `M586 P`, `M587 X`, `M950 K`) need no action - `range` alone already
   fully validates a contiguous span, and `dictionary/value-out-of-range`'s own `range`-before-`values`
   precedence means adding `values` on top would be inert, not a validation improvement.
   **Part A's `scripts/audit-dictionary.mjs` sweep is now fully triaged across all three categories** -
   9 real dictionary fixes (3 of them correcting genuinely wrong pre-existing descriptions, not just
   filling gaps), 3 confirmed-and-documented false positives, 5 explicit `required: "unknown"`
   markings, 8 correctly-inert candidates. Re-run for `dictionary/coverage.json`'s currently-draft-only
   commands too, once they reach `reviewed`, as ongoing maintenance rather than a one-time sweep.
3. ✅ Done, out of order (before Step 2 finished - it's the direct fix for the user's own original
   M308 report and didn't need the audit script first). `SymbolRule.role` conditional form (`{ ifLetterPresent,
   else }`) + M308's `S`/`Y` and M950's `H`/`C` fixes (Decision 3). Confirmed both halves with teeth:
   `test/project.test.ts` (symbol define/use counts directly) and `test/diagnostics.test.ts`
   (`project/undefined-symbol` now correctly fires on a reconfigure-without-create). Also confirmed via
   RRF source, not assumed, that `M950 H<n> C"nil"` (delete) and `M308 S<n> P"nil"` (delete) are
   separate, earlier branches in their own handlers that return before the create/reconfigure logic -
   documented as a known, deliberately-unmodelled edge case in `project.ts`'s own comments (a delete
   still gets recorded as a "define" site) rather than silently assumed away.
4. ✅ Done. Broadened `ParamSpec.required` to `boolean | "unknown" | { ifLetterPresent, valueOneOf?,
   valueNot? }` and applied it to every candidate from Decision 4's own list that actually fits a
   single-companion-letter condition, each re-verified against real RRF source first (not trusted from
   the earlier audit's prose alone): `M569.1 C` (required when `T` is `1` or `2` -
   `ClosedLoop.cpp:215-217`, confirmed same-line-only, both read via the same M569.1 line's own
   parser), `M593 H` (required when `P` is `"custom"` - `AxisShaper.cpp`, with a documented same-line-
   only caveat: RRF's `type` is member state that can persist across lines, so a later F/S-only line
   while a custom shaper is already configured also needs H again in real RRF, which this condition
   doesn't catch), `M586.4 T` (required when `W` is given - `MqttClient.cpp:393-417`, RRF's own comment
   confirms it: "Setting the will topic without the will message shouldn't be possible"), `M589 P`/`I`
   (required when `S` is given and isn't `"*"` - `WiFiInterface.cpp:1750-1779`). `M586 H` genuinely
   needs two simultaneous conditions (`P` selects MQTT AND `S1` enables it) - doesn't fit the single-
   letter shape, left explicitly `required: "unknown"` with a note rather than forced or silently
   dropped, per Decision 4's own "don't overbuild for one case" rule. `M572 L`'s list-length condition
   (Findings) was not revisited - still open, matches Decision 4's original call that it doesn't fit
   this shape either. Verified with a real teeth check: reverted `isRequiredHere` to the old flat-
   boolean-only check, confirmed all 4 new tests fail, restored it.
5. ✅ Done. `rrfpins.txt` parser + generator (`scripts/build-pin-tables-rrfpins.mjs` →
   `src/pins/communityBoards.ts`, 48 boards/1805 pins) and the generic `PA1`/`PA_1`/`PA.1`/`A1`/`A_1`/
   `A.1` fallback parser (`src/pins/portPin.ts`'s `parsePortPin`, tested against all six forms plus
   edge cases - port letters past I, pin numbers ≥16, too-short/too-long input). `src/pins/tables.ts`'s
   `lookupPinName(boardId, name)` is the public entry point, new `dwc-gcode-core/pins/*` subpaths
   (root-exported). Two real refinements found while implementing, not anticipated in Decisions 6/7:
   - The generator MERGES a physical pin's aliases across every line of a board's own file that names
     the same `port.pin` (confirmed the `A.5`/`A.6`/`A.7` case from Findings survives the generator
     correctly, with a dedicated test) - this is what makes `canonicalName` usable as a real identity
     for duplicate-pin detection (Step 8) rather than an artefact of file line order.
   - `lookupPinName`'s own alias-matching function (`rrfpinsAliasMatches`) needed re-deriving from the
     EXACT C++ control flow, not a "looks equivalent" paraphrase - the real
     `LookupPinName`/`BoardConfig.cpp:947-968` skips both `_` AND `-` on the user-typed side (not just
     `_`) after every matched character, and separately skips a leading `+`/`-`/`^`/`!` hardware-pin-
     option modifier on the FILE alias side (kept for fidelity even though no real sample data
     exercises it). A first draft only handled leading `_`, caught before committing by re-reading the
     source line by line rather than trusting an initial paraphrase - the same discipline task 17
     Step 1's `reducedStringEquals` needed. Verified with a real teeth check (simplified the matcher
     to a plain case-fold compare, confirmed the separator-tolerance tests fail, restored it).
   The port.pin fallback is DELIBERATELY permissive to match real RRF: it succeeds for any
   syntactically valid address even when that exact pin isn't in the board's own alias table at all
   (RRF's own `StringToPin` never cross-checks it either) - documented in `tables.ts` itself as a
   deliberate fidelity choice, not a bug, with a test asserting it.
6. ✅ Done. `scripts/build-pin-tables-duet.mjs` → `src/pins/duetBoards.ts` (6 boards, 266 pins) - a
   narrow, purpose-built parser: each board's `PinDescription` struct has a DIFFERENT field count/
   order (confirmed directly - 8/7/5 fields across the 6 boards), but `pinNames` is always the LAST
   field, so that's the only thing this script ever reads. Started with `Pins_Duet3Mini.h` end to end
   as planned, then generalised - three real complications found only by actually running it against
   every board, none anticipated in Decision 6:
   - **`Pins_Duet3_MB6HC.h`/`Pins_Duet3_MB6XD.h` use a named `constexpr const char*` constant
     (`ModbusTxPinName`) instead of a literal string for one row's `pinNames`** - resolved by looking
     up that declaration elsewhere in the same file, never assumed to share a value across boards
     even though both happen to (`"rs485.tx"`).
   - **A naive whole-row `split(",")` breaks**, because `pinNames` itself is routinely a single quoted
     string containing multiple comma-separated aliases (e.g. `"lcd.a0,exp1.7,spi.cs4"`) - splitting
     the whole row on every comma would wrongly split that string's own internal ones too. Fixed with
     a quote-aware top-level-only comma split.
   - **`Pins_DuetNG.h` has real rows with no physical chip pin address at all** - a DueX expansion
     board's stop inputs/fans/GP pins and a whole SX1509B I2C GPIO expander's 16 ports, all addressed
     purely by name (e.g. `"duex.e2stop" ... // E2_STOP`, no `P<Letter><NN>`-shaped comment). This
     forced a real design change: `canonicalName` is now each pin's own FIRST listed alias (always
     present whenever a row has any name at all), not a `port.pin` form derived from the trailing
     comment as originally planned - simpler, and correct for every row instead of most of them.
   `Pins_FMDC.h` deliberately excluded: real `#if defined(FMDC_V03)` rows inside its `PinTable[]` with
   no build-variant selection mechanism here yet (documented in the generator's own doc comment, same
   class of gap as the RP2040 board's conditional compilation from the original Findings).
7. ✅ Done. `pin` symbol type in `project.ts` (`pinSymbolSites`/`pinSymbolIdentity`), generic off the
   dictionary's `kind: "pin"` parameters the same way `axisSymbolSites` already is off
   `axisParameters`. `ProjectOptions.boards` (CAN address → board id) threaded through
   `addSymbolsForCommand`. Confirmed, not assumed, that `IoPort::Allocate`'s modifier/CAN-address
   parsing is UNCHANGED between the mainline (`3.7.0-rc.1`) and the community/TGBTC fork's own branch
   (`git diff` between the two tags on `Hardware/IoPorts.cpp` shows no change to that function at
   all) - so one normalisation function correctly covers pin sites on either board family before
   `lookupPinName` is even reached. Verified with a real teeth check (temporarily removed the
   `pinSymbolSites` wiring, confirmed 5 of 6 new tests fail, restored it) - including the specific
   case task 17's own Findings exists to catch: two DIFFERENT aliases (`lcdsck`/`sck`) for the SAME
   physical pin correctly collapse to one symbol once a `boards` map is supplied, and do NOT collapse
   without one (the documented raw-string fallback, not a silent wrong merge).
8. ✅ Done. `project/pin-already-used` (error) and `project/unknown-pin-name` (warning), both added to
   `checkProjectSymbols` (`src/diagnostics/rules.ts`) working directly off the new `"pin"` symbol type
   from Step 7 - no separate line-scan needed, since a pin symbol's own `id` already carries everything
   needed (a real design payoff of Step 7's `<CAN address>.<name>` identity shape). `unknown-pin-name`
   RE-RESOLVES fresh at diagnose time via the new `DiagnoseOptions.boards` rather than trusting
   whatever `ProjectOptions.boards` the project was loaded with - deliberately decoupled, and safe/
   idempotent either way (re-running `lookupPinName` on an already-resolved `canonicalName` still
   succeeds, since a board table's own canonical name is always one of its own aliases). **Running the
   new rule against real fixtures immediately found a genuine, previously-undetected bug** (the exact
   value this package's whole history keeps demonstrating): task 13's own `fff-basic` fixture had
   `M574 Y1 S1 P"io1.in"` (an endstop) and `M558 K0 C"^io1.in"` (a Z-probe) claiming the SAME physical
   pin with two different roles - traced `IoPort::Allocate`'s exact conflict logic and confirmed real
   RRF would reject this precise config (a second claim is only allowed when it's the SAME
   `PinUsedBy::temporaryInput` role; `endstop` then `zprobe` is a real conflict) - fixed the fixture,
   not the rule. Both rules verified with a real teeth check (disabled the whole `pin` branch,
   confirmed both new describe blocks fail, restored it). `docs/diagnostics.md` regenerated (27 rules).
9. ✅ Done (resolved as part of Step 6, since `lookupPinName` needed the answer before it could be
   correct). Re-read `Config/Pins.cpp`'s COMPLETE `LookupPinName` end to end, not just its opening -
   confirmed it `return false`s outright when no `PinTable[]` alias matches, with NO numeric fallback
   path anywhere in the function. **The `PA1`-style syntax is genuinely STM32/community-board-
   exclusive, not a simplification** - a real Duet board rejects it. `lookupPinName` gates the
   fallback on `family === "rrfpins-txt"`; a teeth check (temporarily removing that gate) confirmed a
   Duet board's own real chip address (`"PA11"`/`"A.11"` for `out4`) would otherwise have wrongly
   resolved.
10. ✅ Done, as an ordinary follow-up pass rather than a single final sweep - each step's own Findings
    above already got a real, honest write-up as it landed (not a separate end-of-task pass).

**Task 17 was marked complete after Step 9, then reopened same day for one real follow-up** - see
"Follow-up: `+`-joined multi-pin values" below, prompted by the user's own question about `M574`'s
`P"io2.in+io3.in"` syntax. Every other item from the original nine steps is done; the only remaining
known-open gap is `Pins_FMDC.h`'s real conditional compilation (Step 6) - documented in the generator
script's own doc comment, not silently worked around.

## Follow-up: `+`-joined multi-pin values (2026-09-21, same day)

**User asked directly**: does `M574`'s `P"io2.in+io3.in"` (two endstop pins for one axis) get handled
correctly, and does the same apply to other commands? It did not - a real, confirmed gap in Steps 7/8
as originally built, found and fixed the same day.

**Findings**: `+`-joining is a real, pervasive RRF convention, not M574-specific -
`IoPort::AssignPort(s)` (`Hardware/IoPorts.cpp:44-105`) splits any pin-parameter string on `+` into up
to `numPorts` independent port allocations, each going through the SAME conflict-checked `Allocate`
call as a lone pin would. `SwitchEndstop::Configure` (M574's own handler) has an identical hand-rolled
copy of the same splitting logic rather than calling the shared function, but the behaviour is
identical. Checked every one of the 7 reviewed `kind: "pin"` parameters' own real call sites, not
assumed uniform:
- `M574 P`: up to `MaxDriversPerAxis` (`4` on `Pins_Duet3Mini.h` - a real per-board constant, not
  necessarily `4` on every board).
- `M558 C`: up to `2` (`LocalZProbe::Configure`'s own fixed `{ &inputPort, &modulationPort }`).
- `M955 C`: exactly `2`, required (`Accelerometers::ConfigureAccelerometer`'s own `!= 2` check).
- `M308 P`: `2`, but ONLY for a DHT sensor (`DhtSensor.cpp`) - every other sensor type's own shared
  `SensorWithPort.cpp` is single-pin only (`AssignPort` singular, no `+` splitting at all).
- `M950`'s heater form: ALSO multi-port on some boards (`MaxPortsPerHeater` is `2` or `3` depending on
  the board, `LocalHeater::ConfigurePortAndSensor`) - genuinely board-dependent.
- `M452 C` and `M575 C`: confirmed single-pin only (`AssignLaserPin`/`ConfigureDirectionPort` each
  call `AssignPort` singular, or pass a literal string directly with no port-count concept at all).

**Decision**: rather than encode an exact per-command (and sometimes per-board, e.g. M950's heater
form) port-count CAP - a real but much bigger undertaking, and one that would need `ParamSpec` to
carry board-conditional data it doesn't model anywhere else either - `pinSymbolSites` splits on `+`
UNCONDITIONALLY for every `kind: "pin"` value. This is always at least as correct as not splitting:
a genuinely single-pin-only command realistically never has a literal `+` in its value in real G-code,
and for the confirmed multi-pin commands it now correctly tracks each `+`-segment as its own
independent pin claim/lookup instead of one nonsense compound "pin name" that could never legitimately
match anything in a board's own alias table.

**Fix**: `pinSymbolIdentity` (`src/project.ts`) now operates on one already-split name at a time;
`pinSymbolSites` unquotes the raw parameter value ONCE (a `+`-joined value is still one quoted string,
so unquoting has to happen before splitting, not per-segment), then splits on `+`, running the
existing modifier-stripping/CAN-address-prefix/board-alias-resolution logic independently per
segment. `project/pin-already-used` and `project/unknown-pin-name` needed no changes at all - both
already operate on `project.symbols`, so correctly splitting at the symbol-tracking layer was
sufficient for both rules to become correct automatically.

Verified with a real teeth check (reverted the `+`-split back to whole-value tracking, confirmed 3
`project.test.ts` tests fail, restored it) and new tests proving the actual scenario asked about: two
`+`-joined pins are tracked as two separate symbols, NOT flagged as a self-conflict; one of those two
segments correctly DOES conflict with a later, separate use of the same physical pin; and each segment
gets its own modifier/CAN-address parsing independently (`"!io2.in+121.io3.in"` → two correctly
distinct, correctly normalised symbols).

## Follow-up round 2: shared CAN-address + M950's L/K (2026-09-21, same day)

**User pushed further, immediately after round 1 shipped**: are you sure that's all? Gave two more
real examples - `M950 F0 C"!1.out3+out3.tach"` (a fan's control pin on expansion board 1 plus its
tacho pin, no prefix of its own) and `M950 R0 C"pwm_pin+onoff_pin+dir_pin"` (a spindle's three pins) -
and asked about `M950`'s `L`/`K` colon-list parameters specifically: does the parser know when they're
optional, and when a specific number of values is required?

**Finding 1 - a real bug round 1 didn't catch**: the CAN-address prefix on a `+`-joined value is
parsed ONCE from the FRONT of the whole value and shared by every segment - it is NOT re-parsed per
segment the way round 1's fix assumed for every command. Confirmed directly at four real call sites
(`FansManager::ConfigureFanPort`, `Heat::ConfigureHeater`, `Accelerometers::ConfigureAccelerometer`,
`EndstopsManager::HandleM558`): each calls `IoPort::RemoveBoardAddress` exactly once on the raw
string, BEFORE any `+`-awareness, to decide whether the WHOLE device (all its ports) is local or
remote - a remote address forwards the ENTIRE command to that board over CAN, where the remaining
`+`-joined text (address already stripped) is interpreted in THAT board's own local context. This
means `out3.tach` in the user's own example correctly belongs to board 1 even though only `out3`
carries the explicit `1.` prefix - round 1's per-segment parsing would have wrongly defaulted it to
board 0. **`M574` is the one confirmed exception**: `SwitchEndstop::Configure` has its own hand-rolled
loop with a genuinely per-port `boardNumbers[]` array - a dual-Z (or similar) axis really can have its
two endstop switches on two DIFFERENT expansion boards. `M950`'s fan form (`FansManager
::ConfigureFanPort` → `LocalFan::AssignPorts`, up to 2 ports) and spindle form (`Spindle::Configure`,
exactly 3 ports) are both now confirmed real multi-pin cases too, joining the round-1 list.

**Fix**: split `pinSymbolIdentity` into three smaller pieces - `stripPinModifiers` (the `!`/`^`/`*`
strip, now reusable), `splitBoardAddress` (extracts a leading `<digits>.` prefix, returning
`[address, rest]`), and `resolvedPinIdentity` (board-table lookup given an address that's already
been decided). `pinSymbolSites` special-cases `cmd.code === "M574"` to keep round 1's per-segment
parsing (strip modifiers, split address, resolve - independently per `+`-segment); every other
command now strips modifiers and splits the address ONCE from the front of the whole value, then
splits the remainder on `+` and resolves each segment against that SAME shared address (each segment
still gets its own modifier-strip too, in case a later segment carries its own `!`/`^`/`*`).

Verified with a real teeth check (reverted the general case back to per-segment parsing, confirmed
the new fan-form and spindle-form tests fail, restored it) and new tests covering exactly the user's
own examples: a fan's control+tacho pins both resolve to board 1 with only the first segment
prefixed; a spindle's three pins all resolve to the same explicit address; and a value with no prefix
at all still correctly defaults every segment to board 0.

**Finding 2 - a real, independent, pre-existing bug in `M950`'s `K` parameter**: checked the user's
own quoted wiki text for `M950`'s spindle-form `L`/`K` against `Tools/Spindle.cpp:60-101` directly.
`L` (RPM: 1 or 2 values) was already correctly described and typed, just missing an explicit element-
count check - a real, previously-unvalidated gap (RRF's own `StringParser::CheckArrayLength` throws
`"array too long for parameter"` past `L`'s 2-element array, `GCodes/GCodeBuffer/StringParser.cpp:
1549-1555` - confirmed this is a real thrown error, not silent truncation). `K` (PWM: 1, 2 or 3
values) was WORSE than just missing a count check: its existing dictionary entry only modelled the
LED form's meaning (`kind: "unsigned"`, `list: false`, `range: 0-5`) despite its own `sources` array
already citing the spindle form's real 1-3-value float behaviour - meaning a genuinely valid spindle
value like `K0.1:0.9` was ALREADY being wrongly flagged as `dictionary/wrong-kind` before this session
even started (decimals aren't `"unsigned"`), and the colon-list was never split at all. Also: the
existing description was missing the spindle form's 1-value ("max alone") case entirely, even though
the LED form's own citation for that exact same letter was accurate.

**Decision**: added `ParamSpec.listLength?: ReadonlyArray<number>` - the closed set of element counts
RRF's own array reader accepts (cited to `CheckArrayLength`, which only ever enforces a hard UPPER
bound via the caller's fixed-size array; there's no general lower-bound check in the shared reader
itself, so this field should only ever list counts a command's own caller logic actually gives
meaning to, not "every length up to the max"). Wired into `dictionary/value-out-of-range` (reused
rather than adding a new rule ID, since RRF's own error is structurally the same shape as an enum/
range mismatch - "this value doesn't fit the shape the dictionary says it should"). `M950`'s `K` was
broadened to `kind: "number"` (accepts both the LED form's integers and the spindle form's decimals -
a genuine superset, not a loosening that invents acceptance RRF doesn't have) and `list: true` with
`listLength: [1, 2, 3]`; `range: 0-5` stays and is STILL correctly enforced for the LED form
specifically, since the range check only ever runs when `pieces.length === 1`. `M950`'s `L` got
`listLength: [1, 2]` added, no other change needed.

**A real, broader pattern surfaced while fixing this**: re-ran `scripts/audit-dictionary.mjs` with a
new fourth category (`list: true` parameters with no `listLength`) and found 34 more candidates across
the reviewed dictionary (`M563`'s axis-mapping lists, `M569`'s `T` timing values, `M307`'s cooling-rate
lists, etc.) - most are genuinely open-ended (e.g. "extruder number(s) to disable" has no real RRF
cap), but some plausibly have a real fixed count the same way `M950`'s `L`/`K` did. Not fixed in THIS
round - see "Follow-up round 3" immediately below, done straight after on the user's own "continue".

## Follow-up round 3: triaging the `listLength` candidates (2026-09-21, same day)

**User said "continue"** - read as continuing the same triage-and-fix methodology into the 34
candidates round 2's audit-script run surfaced. Checked each against real RRF source, same discipline
as every other pass in this task (never add a `listLength` without a citable array-size/exact-count
check in the actual handler); fixed the ones with a genuinely SMALL, closed count, left the rest
alone.

**Fixed (9 parameters, all `listLength` cited to a fixed-size array or an explicit count check)**:
- `G31 T`: `[1, 2]` (`ZProbe.cpp` - `float temperatureCoefficients[2]`).
- `M106 T`: `[1, 2]`, padded (`Fan.cpp` - `GetFloatArray(triggerTemperatures, 2, true)`).
- `M307 K`/`C`: `[1, 2]` each (`Heater.cpp` - both read into 2-element arrays, `C` padded).
- `M558 H`: `[1, 2]`, padded; `F`: `[1, 2, 3]`, padded (`ZProbe.cpp` - `diveHeights[2]`,
  `userProbeSpeeds[3]`).
- `M569 T`: `[4]` - the one confirmed EXACT-count case found this round, not a range:
  `Move2.cpp`'s own `if (numTimings != ARRAY_SIZE(timings)) { reply.copy("bad timing parameter"); ...
  }` rejects anything but exactly 4 (direction setup/hold time, min step pulse width, min step
  interval).
- `M572 S`: `[1, 2]` (`Move2.cpp` - already read once this session for its own `L`-required
  conditional; the same handler's own `S` array is capped at 2).
- `M593 H`/`T`: `[1, 2, 3, 4]` each (`AxisShaper.h`'s own `MaxImpulses = 5`, so `MaxImpulses - 1 = 4`).
  `T`'s own real constraint is stricter than a plain range - RRF requires its element count to
  EXACTLY MATCH whatever `H` had on the same line (`"Number of delays must be same as number of
  amplitudes"`) - a cross-parameter constraint `listLength` can't express (the same class of gap as
  `M572`'s own `L`-required-when-two-`S`-values case, already documented); only the upper bound is
  encoded, the cross-check is left as a documented, real, un-modelled gap rather than invented.

**Deliberately left alone (checked, not fixed)**:
- `M106 H`, `M116 P`: capped only by a large board-resource constant (`MaxSensors`, `MaxTools`) - not
  a meaningfully "closed" set in the spirit of this check (the interesting error class this feature
  catches is a small, easy-to-mistype fixed tuple, not "you named more sensors than the board has").
- `M569.1 E`: genuinely inconclusive - its real element-count enforcement (if any) lives behind a
  `CanMessageGenericParser`/CAN-message-marshalling layer this pass didn't fully trace through (the
  array is CAN-marshalled on the main board before the remote board's own `GetFloatArrayParam` ever
  sees it) - left unset rather than guessed, consistent with this task's own "don't invent" rule.
- Every other candidate from round 2's list (`M563`'s axis/driver/heater mapping lists, `M569`/
  `M569.1`'s `P` driver-ID lists, `M572 D`, `M84 E`, `M140 H`, `M116 H`/`C`, `G10 S`/`R`, `M568 S`/`R`,
  `G0`/`G1 S`, `M500 P`) - genuinely open-ended in the real sense (as many drivers/heaters/extruders
  as the board has), not checked individually beyond confirming their descriptions don't imply a
  small fixed count the way the fixed ones did.

Verified with a real teeth check (disabled the `listLength` branch entirely, confirmed all 7 new
`describe` blocks' worth of assertions fail across the 9 fixed parameters, restored it) and new tests
for every fixed parameter, both the valid boundary and the first invalid count past it.

## Tests

Same discipline as tasks 10/12/13/14: every new/changed rule and every new `values`/conditional-
`required` entry gets a fixture that fires and one that doesn't, plus a teeth check. Specific to this
round's expansion:
- The audit script itself (Step 2) needs a test asserting it doesn't silently skip a kind other than
  `string` - the whole point of Decision 2 is that enum-shaped `integer`/`unsigned` parameters were
  never swept before.
- `M569.1`'s `Y` values test must cover the conditional-availability note (`mt6835` only under
  `SUPPORT_MT6835`) - don't just assert both names validate unconditionally.
- Pin alias resolution (Decision 7) needs the `lcdmiso`/`miso`-are-the-same-pin fixture from Findings
  as an explicit positive case for `project/pin-already-used`, and the `PA1`/`PA_1`/`PA.1`/`A1`/`A_1`/
  `A.1`-all-resolve-identically fixture for `StringToPin`'s parser (Decision 6/9).

## Acceptance

- `M308 S0 Y"thermstor"` (typo), `M593 P"zdv"` (typo), and `M569.1 Y"as5047"` (truncated) each flag
  `dictionary/value-out-of-range` with the real enumerated list.
- The audit script (Decision 2) runs over the full reviewed dictionary and its output has been
  triaged by hand at least once, with real `values`/`required` fixes committed for every confirmed
  candidate (not just the three seeded in this file).
- `M308 S0` with no prior `M308 S0 Y...` anywhere in the project flags `project/undefined-symbol`;
  reconfiguring an existing sensor without `Y` does not.
- At least one confirmed multi-condition `required` case (`M589 P`/`I`, or `M586 H`) is implemented and
  tested, proving the broadened shape (Decision 4) isn't just theoretical.
- Two lines naming the same physical pin - whether by the identical alias, a different alias that
  resolves to the same `port.pin` (the `lcdmiso`/`miso` case), or the same `PA1`/`PA_1`/`PA.1` numeric
  form spelled two different ways - flag `project/pin-already-used` exactly once; different boards/CAN
  addresses do not conflict.
- Official Duet + community (`rrfpins.txt`) board pin tables are both generated from real source,
  cited, covering all 48 community boards found in Findings and every official `Pins_*.h`/
  `Duet3Expansion` board from the original draft.
- `project/unknown-pin-name` works identically (same rule, same severity, same API) for both board
  families - no STM32 carve-out remains anywhere in the implementation or its tests.

## Traps

- Don't mark any of this round's newly-found conditional-`required` parameters unconditionally
  `required: true` - same trap as the original draft's M308/M950 case, now with more real examples to
  get wrong (`M589`'s `"*"`-exclusion case is the easiest to misjudge - `S` is *required*, `P`/`I` are
  conditionally required *on top of* `S`, don't conflate the two).
- The audit script (Decision 2) is a candidate generator, not an oracle - the M106 "requires P" set in
  Findings is flagged explicitly as *possibly already covered* elsewhere; verify each candidate against
  `commandSpec()`'s current state before treating it as a gap.
- STM32/community pin matching is **case-insensitive and `_`/`-`-tolerant**; official Duet pin matching
  is **case-sensitive with no separator tolerance** (Findings, both drafts) - do not accidentally share
  one matching function across both families in `lookupPinName`; the family field in `BoardPinTable`
  exists specifically so the implementation can dispatch correctly, even though callers don't need to
  know about it.
- The `lcdmiso`/`miso`-style same-pin-two-aliases case (Findings) means duplicate detection must
  resolve through the board table *before* comparing, not compare raw (even modifier-stripped)
  strings - the original draft's Decision 5 undersold this; Decision 7 is the correction.
- `rrfpins.txt`'s per-board file in the RRFBuild repo is a *reference/build input*, not necessarily
  byte-identical to what a specific in-the-field board is currently running (firmware version drift) -
  cite it as "the pin table this board's firmware build ships with," not as something guaranteed
  live-verified against every possible installed version, the same honesty this package already
  applies to `RRF_BASELINE` drift elsewhere.
- Don't guess at the RP2040 board's active build configuration (original draft's Findings) - say which
  one the generated table assumes, in the generated data's own doc comment.

## Out of scope

- Filament monitors, GPIO in/out (`gpin`/`gpout`), LED strips as pin-bearing symbol types beyond what
  the generic `kind: "pin"` sweep already picks up structurally (task 13's own known gap, unchanged).
- Validating a pin's *electrical* capability (PWM/ADC-appropriateness) - names only, per the user's own
  wording; a natural follow-up, not bundled in here.
- Community board families outside the gloomyandy fork's `btt`/`fly`/`formbot`/`fysetc`/`ldo` set, or
  outside the `v3.7-dev` branch specifically - if a board is added to that fork later, or another STM32
  fork entirely is used, that's a follow-up, not silently assumed covered by this task's generator.
- Re-litigating whether every one of the 38 (Part A) enum candidates or 16 conditional-required
  candidates found in this round's sweep is real - that's Step 2/4's own job at implementation time,
  not something to resolve inside this planning document.
