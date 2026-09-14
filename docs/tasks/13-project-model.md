# 13 — Project model: the machine's configuration as a whole

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
