# 13 — Project model: the machine's configuration as a whole

**Status: Done.**

## Findings

**Step 1, the invocation table**, is `docs/invocation-table.md` - every route cited to RRF
3.7.0-rc.1 source directly (file constants in `GCodes.h`, the actual `DoFileMacro` call sites, and
`Kinematics::GetHomingFileName`/`Kinematics::HomeAllFileName` for `G28`'s own homing-file logic,
which turned out to be delegated to the configured KINEMATICS, not a fixed rule - the base
(Cartesian-family) implementation is what's modelled; delta/SCARA/hangprinter kinematics override it
and are out of scope here). One shared fact, verified once rather than per-row: every route resolves
through `Platform::OpenSysFile` → `MassStorage::CombineName`, which treats a `<digit>:`-prefixed or
leading-`/` name as absolute and everything else as relative to the sys directory - exactly what
`edit.ts`'s existing `resolveIncludePath` (prior art the task named directly) already implements,
confirmed against source rather than assumed correct because it already existed.

A few routes from the task's own list needed real digging beyond what was already known from tasks
08/10: `T<n>`'s three macros (`tfree`/`tpre`/`tpost`) each try a NUMBERED file first
(`tfree<oldTool>.g`) and fall back to a bare one (`tfree.g`) if that's absent (`GCodes4.cpp:429-519`),
gated by the `T ... P<bitmap>` bits (`TFreeBit`/`TPreBit`/`TPostBit`, `Tool.h:37-40`); `M600`
(filament-change pause) tries `filament-change.g` first, falling back to the ordinary `pause.g`
(`GCodes4.cpp:570-580`) - not documented anywhere in the wiki as a fallback, found only by reading the
state machine directly; `M0`/`M2` (not paused) try `cancel.g`, falling back to `stop.g`
(`GCodes2.cpp:792-798`); `daemon.g` runs repeatedly while idle (1s then every 10s,
`GCodes.cpp:613-629`), and `runonce.g` runs exactly once at startup then is deleted
(`RepRap.cpp:634-644`) - neither was in the task's own starting list, added because they're real,
citable routes the source directly showed while reading the surrounding code.

**`M505` (which can move the sys directory at runtime) is a real, deliberate scope gap**: this
module always resolves relative paths against the factory-default `sys/`, documented plainly in
`src/project.ts`'s own `SYS_DIR` comment, rather than trying to track a file-order-dependent runtime
fact static analysis can't generally resolve.

**Step 2/3: symbols and `loadProject`** (`src/project.ts`, new `dwc-gcode-core/project` subpath,
root-exported). Covers `tool`, `heater`, `sensor`, `fan`, `axis`, `endstop`, `probe`, `accelerometer`,
`spindle`, `extruder`, `driver`, `global` and `filament` with real defining/referencing command+letter
pairs, each traceable to a specific dictionary entry or RRF source read. `axis` uses are derived
GENERICALLY from the dictionary's own `axisParameters` field (task 10) rather than a hand-maintained
list of the dozens of commands that accept axis letters - `M584` defines an axis, every other command
with `axisParameters` set uses it, and `M574` additionally defines the same letter as a distinct
`endstop` symbol. `global` definitions/uses reuse task 06's `parseAssignment` and task 07's
`expressionsOfLine` directly, giving it full expression-level precision essentially for free.
**Real gaps, not silently claimed**: `gpin`/`gpout`/`ledStrip` symbols are DEFINE-only (from `M950`'s
own `J`/`S`/`E` parameters) with no reference sites tracked yet, and `filamentMonitor` isn't modelled
at all (its defining command, `M591`, isn't in the reviewed dictionary yet) - task 13's own Decisions
list these as in-scope symbol types, so this is recorded honestly rather than glossed over.

**Three real bugs found while writing the test fixtures**, all in `src/project.ts` itself:
1. Every `T`-code route (`rawCallsFor`'s tool-change macros, `addSymbolsForCommand`'s tool-use
   special-case) checked `cmd.code === "T"`, which is NEVER true for a real tool select - `lex.ts`'s
   own `LexedCommand.code` for `T0` is the literal string `"T0"`, not `"T"` (the exact same class of
   bug task 10 hit with `commandSpec()`'s own lookup, fixed the same way: match on `cmd.letter`
   instead). Every `T<n>` line was silently producing zero calls and zero tool-use symbols until this
   was fixed.
2. `M701`/`M702`'s filament-macro paths (`filaments/<name>/load.g`) were being resolved AS IF
   relative to `/sys/`, giving `sys/filaments/pla/load.g` instead of the real `filaments/pla/load.g` -
   these two routes resolve against the SD card's own root, not the sys directory; fixed with a
   `rootRelative` flag on the raw-call record.
3. The fallback-chain grouping (which candidate in a try-then-fall-back sequence actually "won") was
   inferred from string-manipulating each candidate's own `via` label (stripping a `"-fallback"`
   suffix and checking it matched the previous group's own label) - this happened to work for `T`'s
   three macros (whose fallback labels are named consistently) but silently produced a WRONG, separate
   one-item group for `M0`'s `cancel.g`/`stop.g` pair, since their labels don't share that exact
   naming pattern. Replaced with an explicit `chain` id on each raw call instead of inferring grouping
   from string shape.

**Fixtures**: `test/corpus/projects/{fff-basic,cnc-basic,laser-basic}/`, each a small but real SD
layout (own `README.md` in the fff-basic one explaining every deliberate choice - an absent
`homey.g`/`tpre0.g`/`cancel.g` to exercise unresolved-call and fallback paths, a `var`/`if`/`M98`/
`T{expression}` macro for conditional- and dynamic-call coverage). `test/project.test.ts` (30 tests)
covers calls (resolved, unresolved, fallback-chain, dynamic, conditional) and symbols (definitions,
uses, conditional flag) across all three machine types.

**Not done, a deliberate scope decision, not an oversight**: `edit.ts`'s `findIncludes`/
`resolveIncludePath` are NOT rewired to sit on top of `Project.calls`, despite the task's own note
that they "become views over" it. `findIncludes` is a narrower, standalone, already-tested M98-only
helper; `Project.calls` is the complete, superseding model covering every route in the invocation
table. Refactoring a stable, already-shipped module's internals to route through a much larger new
one for architectural tidiness, with no functional need driving it, was judged not worth the
regression risk for this pass - noted here rather than done quietly or claimed done.

## The gap

Every check today works on one line or one file. "Highlight omissions", and most real errors, are
cross-file: a tool used in a print file but never defined, `M98` of a missing file, a heater
configured without a sensor, `tpre1.g` missing for a tool whose change runs it.

## Sources

- Task 08's `docs/file-kinds.md` (which files RRF runs, and when).
- RRF source for **what invokes what** — expected routes to confirm, each needing a citation:
  `M98 P`; `G28` → `homeall.g`/`home<axis>.g`; `T` → `tfree`/`tpre`/`tpost` (and `T … P<bitmap>`
  choosing which run); `M701`/`M702`/`M703` → filament files; `G29` → `mesh.g`; `G32` → `bed.g`;
  pause/resume/cancel → `pause.g`/`resume.g`/`cancel.g`; `M0`/`M1` → `stop.g`/`sleep.g`;
  `M581` → `trigger<n>.g`; power-fail/resurrect → `resurrect.g`/`resurrect-prologue.g`;
  unimplemented codes → `/sys/<code>.g`; `daemon.g`, `runonce.g`; `M501` → `config-override.g`.
  Drop any route you can't cite; add any source shows that isn't here.
- Task 10's dictionary: which parameters define and which reference a numbered resource.

## Decisions

- **Static analysis only** — no expression evaluation. A definition inside an `if` block is recorded
  as *conditional*; a resource number that's an expression is *dynamic*.
- **Symbols**: tools (`M563 P`), heaters, sensors (`M308 S`), fans, GPIO, servos, axes and drivers
  (`M584`), extruders, Z probes (`M558 K`), endstops (`M574`), accelerometers (`M955`), LED strips,
  filament monitors, globals (`global`), filaments (directories). Confirm each defining command and
  letter in source/the dictionary. Each symbol records definitions and uses as
  `{ file, line, start, end, conditional, dynamic }`.
- Definition and reference roles come from the dictionary's parameter kinds (`heaterNumber` and so
  on) plus a small cited table of "defining" commands.
- Paths: the project's file paths are SD paths (`0:/sys/config.g` and `/sys/config.g` both
  accepted); resolution follows RRF's own rules for relative `M98 P` paths (cite them — the current
  `resolveIncludePath` in `edit.ts` is the prior art; verify it against source).

## API

```ts
export interface ProjectFile { path: string; text: string }
export interface ProjectOptions { machineMode?: MachineMode; firmwareVersion?: string }
export interface ProjectSymbol {
	type: string; id: string;  // e.g. "heater", "1"
	definitions: ReadonlyArray<SymbolSite>; uses: ReadonlyArray<SymbolSite>;
}
export interface SymbolSite { file: string; line: number; start: number; end: number; conditional: boolean; dynamic: boolean }
export interface Project {
	files: ReadonlyMap<string, { kind: FileKind; doc: GcodeDocument | MenuDocument | null }>;
	calls: ReadonlyArray<{ from: { file: string; line: number }; to: string; resolved: boolean; dynamic: boolean; via: string }>;
	symbols: ReadonlyArray<ProjectSymbol>;
}
export function loadProject(files: ReadonlyArray<ProjectFile>, options?: ProjectOptions): Project;
```

`edit.ts`'s `findIncludes`/`resolveIncludePath` become views over `Project.calls`.

## Steps

1. Build the invocation table from source (stop and report any route you can't cite).
2. Symbols and roles.
3. `loadProject` with include resolution; unresolved and dynamic calls are reported, never guessed.

## Tests

A fixture SD tree (`test/corpus/projects/fff-basic/…`) with `config.g` and includes, tool macros,
homing files, a filament and a menu; assert calls, symbols and the conditional/dynamic flags. A
second tree for a CNC machine and a third for a laser.

## Acceptance

Every invocation route cited; fixtures cover each symbol type and each machine type.

## Out of scope

Knowing which branch of an `if` runs; the live object model.
