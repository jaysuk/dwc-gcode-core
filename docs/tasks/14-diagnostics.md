# 14 — Diagnostics: errors and omissions

**Status: Done.**

## Findings

**25 rules implemented and cited**, across all 8 categories - registry in `src/diagnostics/rules.ts`,
schema in `src/diagnostics/schema.ts`, the public API (`diagnoseDocument`, `diagnoseProject`,
`toMonacoMarkers`) in `src/diagnostics/diagnose.ts`/`monaco.ts`. `docs/diagnostics.md` is generated
from `RULES` by `scripts/build-diagnostics-doc.mjs` (`npm run docs:diagnostics`, after `npm run
build`).

**A real, undocumented-until-now bug in the checksum spec.** RRF's `StringParser.cpp` has a SECOND
checksum form (5 digits, a CRC16 - `checksumCharsReceived==5` in the real handler) alongside the
classic 1-3-digit XOR form this task's own API section describes. `syntax/checksum-mismatch` only
validates the XOR form; a 5-digit checksum line is deliberately left unvalidated (a real, documented
gap, not silently wrong - RRF's own CRC16 polynomial isn't reproduced here).

**Dropped: the menu "missing required parameter" rule.** RRF's own `Menu::ParseMenuLine` (cited
already in `src/files/menu.ts`'s own doc comment, task 08) does NOT enforce which parameters a given
menu command needs - a missing one silently defaults, it never errors. The task's own rules list
named this as a rule to implement; per "drop any you can't cite," it isn't here, because RRF doesn't
actually behave that way.

**Two real bugs found and fixed in `src/files/menu.ts`'s own documented model, while building the
menu rules against it** (not assumed - read straight from RRF's real `src/Display/Menu.cpp` at
`3.7.0-rc.1`, since the existing task 08 work didn't need this level of detail):
- The common `A"menu" L"filename"` form (a bare `"menu"` action naming its target through the line's
  own `L` parameter) was never resolved at all - only a name embedded directly in the action text
  (`A"menu somename"`, a second, real, separate form `EncoderAction_ExecuteHelper` also recognises)
  was checked. RRF's own comment states it plainly: `"menu" (chains to the menu file given in the L
  parameter)` (`Menu.cpp:39`); `case 'L'` (`Menu.cpp:357-366`) sets the same `fname` variable
  `EncoderAction_ExecuteHelper`'s `Load(cmd + 5)` uses for the embedded form. `menu/target-missing`
  now checks both forms.
- `menu/image-missing` read the wrong parameter letter entirely (`T`, the display TEXT string) for
  an `image` command's filename - the real filename is the same `L`/`fname` the `menu` action uses
  (`ImageMenuItem(row, column, fname)`, `Menu.cpp:407`). Fixed.

**Two real false-positive bugs found by running the engine against task 13's own project fixtures**
(exactly the value a "run it for real" pass is supposed to provide, not something a unit test in
isolation would have caught):
- `structure/capitalised-meta-keyword` only checked lines lexed as `kind: "unrecognised"`, but a
  capitalised keyword like `"If true"` actually lexes as `kind: "fields"` (this package's own
  Fanuc-style letter/value heuristic often matches it) - the kind check was simply wrong and missed
  the common case. Fixed by dropping the `kind` gate entirely (the regex + `META_KEYWORDS.has` +
  `metaKeywordOf(...) === null` combination is already precise enough on its own; a real G/M/T
  command can never match the letters-only regex).
- `project/duplicate-definition` and `project/undefined-symbol` both trusted `UNDEFINED_CHECK_TYPES`
  too literally against `src/project.ts`'s real `SYMBOL_RULES` (task 13):
  - `filament` gets ONE unconditional "define" site added per file kind under its own
    `filaments/<name>/` directory (`addFilamentSymbols`) - by design, not a duplicate. A normal,
    fully-formed filament (config.g + load.g + unload.g) was tripping `duplicate-definition` on
    every single one. Now excluded from that specific check via `DUPLICATE_CHECK_EXCLUDED_TYPES`.
  - `extruder` and `driver` are USE-only in `SYMBOL_RULES` - RRF has no single command that "creates"
    an extruder or a driver number the way `M950`/`M563`/`M308` do for tool/heater/sensor/etc. (an
    extruder's existence is implicit in how many drives `M584`'s own `E` list names, which task 13's
    model never maps to the `extruder` type at all). Checking either for "undefined" misfired on
    every ordinary FFF/CNC config that uses an extruder or a driver at all - removed from
    `UNDEFINED_CHECK_TYPES`, documented as a real task 13 gap rather than invented here.

**A real dictionary gap found the same way, and fixed**: `M950`'s reviewed entry (task 10) was
missing `T`/`B`/`Q` entirely for the heater form - RRF's `Heat::ConfigureHeater` (`Heat.cpp:562-571`)
`gb.MustSee('T')`s a sensor number, and optionally reads `B` (ambient sensor) and `Q` (PWM frequency),
whenever `M950 H<n> C"..."` creates a new heater. Every real `M950 H0 C"..." T0` line (the fixture's
own, and every real Duet config) was tripping `dictionary/unknown-parameter` on its own `T`. Added
all three parameters to `dictionary/commands.json`'s `M950` entry, cited to `Heat.cpp`, and
regenerated `src/dictionary/commands.ts`. (`T` isn't marked `required: true`: it's only required when
`C` is ALSO given to create a new heater, not on every `M950 H<n>` invocation - the dictionary schema
has no conditional-required, so marking it unconditionally required would be its own false positive.)

**`Project.files`'s value type gained a `text: string` field** (`src/project.ts`, task 13's own
shape) - needed because a height-map file parses to `doc: null` (task 08 never builds a structured
document for CSV), so `data/height-map-error` re-parses the file's own raw text on demand via
`parseHeightMap`. A retroactive, additive widening of an already-shipped task's data model - the
project's own ground rules treat an API break before 1.0 as acceptable when justified, and this one
only adds a field, breaking nothing that read the old shape.

**Every rule has a positive fixture, a negative fixture, and an assertion on the message/severity
itself** (`test/diagnostics.test.ts`, 65 tests) - not just "found something" / "found nothing", so a
rule that fires for the wrong reason still fails. The three rules with no real dictionary data to
exercise them yet are the one documented exception:

- `dictionary/wrong-machine-mode` (`CommandSpec.machineModes`)
- `dictionary/not-available-on-firmware` at the COMMAND level (`CommandSpec.since`/`.until` - the
  PARAMETER level, `ParamSpec.since`/`.until`, IS exercised: `M140`'s `H`, real data from task 10/12)
- `project/order-dependency` (`CommandSpec.mustFollow`)

As of this task, zero entries in `dictionary/commands.json` populate `machineModes`, command-level
`since`/`until`, or `mustFollow` on any REVIEWED command - so no real fixture can exercise these three
rules without fabricating dictionary content that doesn't reflect an actual reviewed RRF fact, which
this project's own rules forbid. The rule logic itself is implemented, cited, and structurally
identical to the already-tested parameter-level `since`/`until` check (a straightforward
`compareFirmwareVersions` comparison) and the already-tested "does this code appear earlier in the
project" scan `project/missing-macro-file` already exercises - not new, unverified machinery. When a
future dictionary task adds a `machineModes`-restricted, dated, or `mustFollow` command, these three
become end-to-end testable against real data; that isn't blocking today's Acceptance, since the task
itself asks to "drop any you can't cite" and doesn't ask for fabricated fixtures.

**Task 13's own project fixtures now double as a diagnostics regression suite**: `diagnoseProject`
run against `fff-basic`/`cnc-basic`/`laser-basic`, summarised and snapshotted
(`test/__snapshots__/diagnostics.test.ts.snap`). Every finding in the current snapshot traces to a
file the fixture deliberately omits (documented in task 13's own Findings) - zero unexplained noise,
which is itself the strongest evidence the rule set is sound against realistic input, not just
synthetic one-liners.

## The gap

"Read the contents of files correctly and highlight any errors or omissions." Nothing produces
diagnostics today, and DWC's own editor shows none (no `setModelMarkers` anywhere in its source).

## Decisions

- **Every rule is cited.** A rule states the requirement it checks and where RRF or the wiki states
  it. No rule rests on "good practice" alone. Omission rules especially: only requirements the wiki
  or source actually states ("must", "Order dependency", `MustSee`, a file RRF runs that isn't there).
- **Rules are data plus a check function**, in a registry, so a consumer can list, filter and
  configure them.
- **Firmware-aware**: every rule knows which RRF versions it applies to; `diagnose*` takes the target
  firmware version (and optionally the stamped one, to add task 12's release findings).
- **Fixes are `TextEdit`s** from task 06, offered only when unambiguous.

## API

```ts
export type Severity = "error" | "warning" | "info" | "hint";
export interface Diagnostic {
	rule: string; severity: Severity; message: string;
	file: string; line: number; start: number; end: number;   // absolute offsets in the file
	fixes?: ReadonlyArray<{ title: string; edits: ReadonlyArray<TextEdit> }>;
	sources: ReadonlyArray<string>;
}
export interface RuleInfo {
	id: string; severity: Severity;
	category: "syntax" | "structure" | "dictionary" | "project" | "release" | "menu" | "data" | "objectModel";
	description: string; sources: ReadonlyArray<string>; appliesTo?: { since?: string; until?: string };
}
export const RULES: ReadonlyArray<RuleInfo>;
export interface DiagnoseOptions {
	firmwareVersion: string; stampedVersion?: string; machineMode?: MachineMode;
	rules?: { disable?: ReadonlyArray<string>; severity?: Readonly<Record<string, Severity>> };
}
export function diagnoseDocument(doc: GcodeDocument, path: string, options: DiagnoseOptions): ReadonlyArray<Diagnostic>;
export function diagnoseProject(project: Project, options: DiagnoseOptions): ReadonlyArray<Diagnostic>;
export function toMonacoMarkers(diags: ReadonlyArray<Diagnostic>, text: string): ReadonlyArray<{ severity: 1 | 2 | 4 | 8; message: string; startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; code: string }>;
```

`toMonacoMarkers` returns plain objects shaped like Monaco's `IMarkerData` (severity values from
Monaco's `MarkerSeverity` — verify them against Monaco's API documentation); no Monaco import.

## Rules to implement (each cited when written; drop any you can't cite)

- **Syntax**: every lexer, document and expression error from tasks 05–07; a line longer than RRF's
  maximum (find the buffer size in source); checksum mismatch.
- **Structure**: task 06's structural errors; a macro-invoking command not last on its line (wiki,
  multiple commands on a line); a meta keyword written with capitals (`If`, `VAR`) — RRF doesn't treat
  it as a meta-command, so say what it does read it as.
- **Dictionary**: unknown command — **but** RRF runs `/sys/<code>.g` for an unimplemented G/M code
  (wiki, custom G-codes), so it's fine in a project with that file, and `info` (not `error`) without
  a project; unknown parameter; wrong kind; missing required; value outside `values`/`range`; command
  or parameter not available on the target firmware; deprecated (with the replacement); command not
  valid in the current machine mode.
- **Project**: reference to an undefined tool/heater/fan/sensor/axis/probe; duplicate definition;
  order dependency violated (dictionary `mustFollow`); `M98` or invoked file missing; conditional or
  dynamic references at `info`, never as errors.
- **Release**: task 12's `impactOf` findings when `stampedVersion` is given (upgrade and downgrade).
- **Menu**: unknown menu command, `menu <name>` target missing, missing required parameter, `image`
  file missing.
- **Data**: height-map load errors, exactly as RRF's loader reports them.
- **Object model**: an expression path unknown at the target firmware, or deprecated (task 11).

## Steps

1. Registry, `Diagnostic` plumbing and `toMonacoMarkers`.
2. Rules in the order above, each with a fixture that triggers it and one that doesn't.
3. `docs/diagnostics.md`, generated from `RULES` (id, severity, description, sources).

## Tests

For every rule: a positive fixture, a negative fixture and a teeth check. Snapshot the full
diagnostic list for task 13's project fixtures. Test the Monaco adapter on a multi-line CRLF document
with non-ASCII text (columns are 1-based UTF-16 units).

## Acceptance

Every rule cited and tested both ways; `docs/diagnostics.md` generated from `RULES`.

## Traps

- Don't flag what RRF accepts. When unsure whether RRF errors, warns or ignores, read the handler.
- `M98 P"{…}"` and other expression-valued references are dynamic — `info` at most.

## Out of scope

Evaluating expressions; checking against a live machine's object model.
