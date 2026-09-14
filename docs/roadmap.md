# dwc-gcode-core — audit (2026-09-14, v0.5.0) and roadmap

**The goal this is measured against** (the user's own words, 2026-09-14): parse *all* G-code RRF
supports; correctly recognise config changes between each RRF release and the next; and cover
everything a plugin needs to **read, edit or compare** files — including reading their contents
correctly and **highlighting errors or omissions**. Supported firmware window: RRF 3.6.3 onward.

Phases 0–4 of `duet-gcode-postprocessor/docs/gcode-core-plan.md` are done. Measured against that
goal, v0.5.0 is a solid foundation with real parser bugs in it, and roughly a quarter of the
required surface. Every finding below was reproduced against the v0.5.0 `dist/` build or read
directly from RRF 3.7.0-rc.1 source (`src/GCodes/GCodeBuffer/StringParser.cpp`), unless it is
explicitly labelled a hypothesis.

---

## Part 1 — Audit

### A. Parser correctness: the lexer does not follow RRF's own splitting rules

RRF finds parameters and command boundaries in `StringParser::FindParameters`. Outside quotes and
braces it scans character by character:

- **every letter A–Z marks a parameter** — except `E` directly after a digit, which is part of a
  number's exponent;
- **an unquoted `G` or `M` ends the current command**, and `SetFinished` then decodes the rest of the
  line as the next command;
- **a `'` escapes the next letter as a lowercase axis.**

Separately, `(` starts a comment, but only when the machine type is CNC.

`lex.ts`/`params.ts` instead assume **one command per line, with values delimited by whitespace**.
Probe results against v0.5.0:

| # | Input | v0.5.0 result | What RRF does | Severity |
|---|---|---|---|---|
| A1 | `G90 G1 X10` | one command `G90`, params `G=1 X=10` | two commands, `G90` then `G1 X10` (RRF 3.2+ doesn't even need the space) | **High** — a real command silently read as a parameter by every consumer |
| A2 | `G1X10Y20` | `X="10Y20"` | `X=10`, `Y=20` | **High** for compact output (some CAM/hosts) |
| A3 | `N10 M92 E420*55` | `E="420*55"` | `E=420`; `*55` is a checksum (only when the line has an `N`) | Medium |
| A4 | `G1 'a10 X5` | **zero** parameters — the scan aborts at `'`, losing `X5` too | lowercase axis `a` = 10, then `X` = 5 | Medium |
| A5 | `M117 S{"}"} X1` | brace scan ends at the `}` inside the string | quotes are honoured inside braces | Low |
| A6 | `(comment) G1 X1` (CNC mode) | `unrecognised` | a bracketed comment, then `G1 X1` | Medium for CNC/laser |
| A7 | `X10 Y20` (CNC/laser mode) | `unrecognised` | "Fanuc-style" line: repeats the previous `G0`–`G3` (wiki, "Conditional execution…" section) | Medium for CNC/laser |
| A8 | `M117 Hello World` | phantom params `H`, `W` | the whole rest of the line is one unquoted string (`GetUnprecedentedString` — also used for `M550`/`M551`, and a string argument of `M28`/`M30`/`M32`/`M37`/`M38` among others) | Medium — any per-parameter validation would be wrong |

**`edit.ts` has a second, private parser** — its own `parseLine`/`maskQuoted`, written before the
package existed. It carries its own bugs:
- `N10 M92 E420` → `code: "N10"`;
- `setParam("M572 D0 S{global.pa}", "S", "0.05")` → `M572 D0 S{global.pa} S0.05` (a duplicate `S`).

The second one is only safe because `planDirectiveEdit*` refuses `unsafe` lines before it ever calls
`setParam`. A plugin calling `setParam` directly gets a corrupt line. The root cause is having two
parsers; the fix is having one.

### B. Consumer defects introduced or exposed by the migrations

- **B1 — the Phase 1 lexer fix changed post-processor behaviour, and no test caught it (Medium).**
  `T-1` and a bare `T` used to tokenise as "not a command". They now correctly tokenise as commands,
  but nothing downstream was re-examined:
  - `preheat.ts` now records `T-1` as a tool change to tool −1 → `byNumber.get(-1)` misses → the step
    reports "tool −1 has no heater".
  - `insertAt.ts`'s "before tool change" (any tool) now also fires on a `T-1` deselect.
  - `state.ts` now sets `tool = -1` on `T-1`, which is correct RRF semantics but new.

  Of the post-processor's seven test fixtures, none contains `T-1` or a bare `T`, so its golden-file
  tests could not catch this. The same applies to the empty-value change (`paramNumber` on `P` with
  no value → `null`, not `0`).
- **B2 — `dwc-config-backup-core`'s `parseAssignmentLoose` relies on `toLowerCase()` preserving
  length (Low, in a security tool).** It doesn't for non-ASCII text (`"İ"` becomes 2 characters —
  verified), so spans shift. The prefix before the value is ASCII by construction, but the value's
  end can overshoot. Fix: lowercase `A`–`Z` only.
- **B3 — a narrowing in that same redaction tool (Low).** The old regex accepted variable names
  starting with `_`. RRF's name rule (first character must be a letter), now used, drops a line like
  `var _hash = "…"` from Tier 3. RRF would reject that line anyway, but the tool's own stated policy
  is to over-match.
- **B4 — a release blocker for `dwc-config-backup-core`.** It is published to npm, and now depends
  on a `github:` ref. Publishing it as-is would make every npm consumer fetch `dwc-gcode-core` from
  git, including the DWC 3.6 host that installs core into a DWC checkout by version. **Publish
  `dwc-gcode-core` to npm first.** Nothing has been released yet, so nothing is broken in the wild.
- **B5 — the post-processor is still pinned to `v0.1.0`.** Harmless today, but it carries B1's
  behaviour with none of the later fixes.

### C. Package and process gaps

- **C1 — the bare `"dwc-gcode-core"` import fails under legacy TypeScript resolution**, and is
  worked around by subpath imports.
  - Hypothesis, not yet verified: the `typesVersions` `"*": ["dist/*"]` mapping also captures the
    bare specifier and sends it to `dist/` rather than `dist/index.d.ts`.
  - Needs a real fix, plus a CI job that type-checks a consumer under `moduleResolution: "node"`.
- **C2 — the triage script watches the wrong files for the stated goal.** It lists commits touching
  `src/GCodes/GCodeBuffer/` and `src/GCodes/GCodes*.cpp`. But **70 source files across 15 subsystems
  read G-code parameters** — Movement 14, Heating 12, GCodes 9, Endstops 5, Platform 4, … — and
  **63 files define object-model tables**. M955 lives in Accelerometers, M569 in Movement, M308 in
  Heating. As written, it would miss most config-affecting changes between releases.
- **C3 — `RRF_BASELINE = 3.7.0-rc.1` means less than the plan said.**
  - It is the current latest release (published 2026-09-08), so it isn't stale.
  - The 3.6.3 → 3.7.0-rc.1 triage (148 commits) was generated and never closed, and no `rrf-` tag
    exists. Today the baseline means "the facts cited here were checked at this version", not "fully
    triaged to this version".
  - `FEATURES.multiAccelerometerScheme` cites `3.7.0-rc.1+1`, which is beyond any tagged release.
- **C4 — `FEATURES` can only say "since".** Release diffing needs changes over time, and some entries
  already mislead without that:
  - `singleAccelerometerScheme` says "P capped to 0", which stops being true at `3.7.0-rc.1+1`;
  - `m116ScopedToMotionSystem` changed again at `3.7.0-beta.3`.

  Removals, behaviour changes and deprecations need `until`/`changed` *events*, not a boolean flag.
- **C5 — semantic coverage is 5 of 276 commands.** `test/dictionary.test.ts` proves that every bare
  code tokenises; it proves nothing about any command's parameters.
- **C6 — no diagnostics, no document model, no cross-file model** — the three things "highlight
  errors or omissions" needs. DWC's own editor shows no diagnostics either (no `setModelMarkers`
  anywhere in its source).
- **C7 — minor:** `compareFirmwareVersions` compares prerelease tags case-sensitively (`"RC"` vs
  `"rc"`).

### D. What is sound and should be kept

- Quoting, `""` escapes and comment detection.
- The command-number rules (bare letter, `-`, a single fractional digit, `T{expr}`).
- The twelve meta keywords and RRF's exact indent rule.
- `parseAssignment` with byte spans.
- The `edit.ts` plan builders (`planDirectiveEdit*`, multi-file includes).
- A genuine three-way firmware comparator.
- Every semantic claim is cited, 471 tests, and the discipline of reading source rather than
  inferring — which is how every item above was found.

---

## Part 2 — What the goal requires

Five capabilities, each layered on the one below it:

1. **Read everything, losslessly.** Lexer → per-file document model → expression syntax.
2. **Know what every command means, per version.** A versioned, cited command dictionary, plus the
   object-model schema per release.
3. **Know what changed between any two releases**, in either direction, from 3.6.3 onward — as
   change *events*.
4. **Understand a machine's configuration as a whole.** The SD layout, includes, tool and filament
   macros, and a symbol table of what is defined where.
5. **Say what is wrong or missing, and offer fixes** — diagnostics with spans and quick-fix edits,
   plus semantic comparison of two files or two configs.

### Target layers

| Layer | What it is | Built from |
|---|---|---|
| **L0 Lexer** | RRF-faithful: several commands per line, parameters split by letter, the `E`-exponent rule, `'` lowercase axes, checksums, `(…)` and Fanuc continuation lines under a `machineMode: "fdm"\|"cnc"\|"laser"` option, commands that take a whole-line string | `StringParser.cpp` (`FindParameters`, the `parseNotStarted`/`parsingGCode`/bracketed-comment states) — fixes A1–A8 |
| **L1 Document model** | Lossless concrete syntax tree per file: lines → commands / meta statement / comment; meta **block tree** from indent (comments excluded, as RRF 3.6.0+ does); spans everywhere; byte-identical round-trip. **`edit.ts` rebuilt on it** — one parser, not two | L0 + `meta.ts` |
| **L2 Expression syntax** (parse, never evaluate) | `{…}` → AST: literals, arrays, `var.`/`global.`/`param.` references, object-model paths, functions, operators including `^`. Reports unbalanced braces and unknown functions, and exposes the list of object-model paths referenced | `monacotokens` `expressions.json` (functions, constants, scopes); RRF `ExpressionParser.cpp` for grammar and precedence |
| **L3 Dictionary** | Per command: parameters `{letter, kind (number/int/colon list/string/whole-line string/driver id/pin/axis), expression allowed?, required?, allowed values, since/until}`, plus command since/until/deprecated, order dependencies, config-only vs print-file, sources. Stored as reviewed JSON in-repo, not generated at runtime | A generator seeded from `@duet3d/monacotokens` `gcodes.json` (276 commands, parameters, values); the wiki's `Gcodes.md` (675 version mentions, 33 "Order dependency" sections, 34 deprecations); RRF handler source (`MustSee` → required). Human-reviewed and cited, like `commands/` today |
| **L3b Object-model schema** | Valid object-model paths and deprecations per RRF release | `@duet3d/objectmodel` — published for every release from 3.6.0 through 3.7.0-rc.1, including 3.6.3; `documentation.json` (691 paths) and `deprecations.json`. Diffing consecutive versions gives object-model changes between releases mechanically |
| **L4 Release model** | `ChangeEvent {id, version, kind: added\|removed\|changed\|deprecated, target: command\|parameter\|objectModelPath\|syntax\|behaviour, description, sources}`; `changesBetween(a, b)` in both directions; `impactOf(document, a, b)` → findings with spans. `FEATURES`/`supports()` becomes a view over this | L3 + L3b + a widened triage (C2): all 70 handler files, the object-model tables, and the wiki's own git history per section |
| **L5 Project model** | The SD card layout: `sys/config.g` + `M98` includes, `config-override.g`, `tfree`/`tpre`/`tpost#.g`, homing files, `bed.g`, `daemon.g`, `filaments/<name>/{config,load,unload}.g`, `macros/`, `gcodes/`; `menu/` as a separate small grammar (`monacotokens` already has one). A **symbol table**: tools, heaters, sensors, fans, axes/drivers, globals, filaments — where each is defined and used | L1 + L3 |
| **L6 Diagnostics** | `Diagnostic {severity, code, message, file, span, since?, fix?}`: syntax (L0–L2); dictionary (unknown command or parameter, wrong kind, missing required, deprecated, unsupported on firmware X); structure (`elif` without `if`, `break` outside `while`, mixed tabs/spaces — which RRF itself warns about); project (undefined tool/heater/fan/sensor references, order dependencies, duplicate definitions); release (from L4). Fixes are L1 edits. Includes an adapter to Monaco markers | All of the above |
| **L7 Compare** | A semantic diff of two files or two projects (directives keyed by identity parameters, the way `edit.ts` already matches), able to say when a difference is required by a firmware change | L1 + L4 |
| **L8 Stamp** | `readStamp`/`writeStamp` — one agreed format so every plugin reads the same stamp; kept intact by L1 edits | L1 |

### Phases — ordered so that each one ships something usable

- **Phase 5 — fix the audit before building on it.**
  - Rewrite L0 to `FindParameters` semantics (A1–A8), with a machine-mode option.
  - Represent several commands per line — a real API change (`Tokenised` → a line that holds
    commands); acceptable before 1.0, but consumers need migrating.
  - Fix B1–B3 in their repos, with the missing fixtures (`T-1`, bare `T`, valueless parameters).
  - Fix C1, with a legacy-resolution CI check.
  - **Publish `dwc-gcode-core` to npm** (unblocks B4); bump the post-processor off `v0.1.0`.
- **Phase 6 — the document model and expression syntax (L1, L2).** Rebuild `edit.ts` on L1 and
  retire its private parser. Add a byte-identical round-trip corpus test over real config files.
- **Phase 7 — dictionary v1 (L3, L3b)** for all 276 commands at the current baseline: a generator
  plus a reviewed, cited JSON file. The per-command test becomes "a real example of every command
  parses and validates against its own entry", replacing today's bare-code test.
- **Phase 8 — the release model (L4).**
  - Widen the triage (C2) and close the 3.6.3 → 3.7.0-rc.1 list for real, earning the first `rrf-`
    tag.
  - Diff `@duet3d/objectmodel` versions across releases.
  - `ChangeEvent`s with since/until; `changesBetween` and `impactOf`.
  - Replace `FEATURES` (fixes C4).
- **Phase 9 — project model, diagnostics and stamp (L5, L6, L8)**, plus a Monaco marker adapter —
  the natural upstream offer to DWC, whose editor shows none today.
- **Phase 10 — compare (L7)**, and consumer adoption: post-processor preflight,
  `dwc-config-backup-core` restore suggestions, calibration-wizard's config patching.
- **Every RRF release after that:** run the widened triage, close it, update the dictionary and
  change events, and tag `rrf-<tag>`.

### Decisions needed before Phase 5 starts

1. **Stamp format and scope.** Proposal: a first-line comment, e.g.
   `; checked-rrf: 3.7.0-rc.1 (dwc-gcode-core 0.6.0) 2026-09-14`. Also: are print files in `/gcodes`
   stamped too, or only config, macros and filaments?
2. **CNC/laser in scope?** Recommended yes, as a lexer option. It decides A6/A7.
3. **Menu files** — include as a separate grammar in Phase 9, or leave them out?
4. **Publishing `dwc-gcode-core` to npm** now — needed before `dwc-config-backup-core` can be
   released.
5. **Accepting an API break** (several commands per line) before 1.0, with the consumer migrations
   that brings.
