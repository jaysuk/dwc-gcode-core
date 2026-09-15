# RRF's file invocation table

Every route by which one file on the SD card causes RRF to run another, read directly from RRF
3.7.0-rc.1 source (task 13, `docs/tasks/13-project-model.md`). Every row is cited; a route this
package can't cite is not listed (task's own rule: "drop any route you can't cite").

All filenames below are relative to `0:/sys/` unless stated otherwise - confirmed generically once,
not per row: every macro (including `M98`'s own `P` argument) opens via `GCodes::DoFileMacro` →
`Platform::OpenSysFile` → `Platform::MakeSysFileName` → `MassStorage::CombineName`
(`src/Storage/MassStorage.cpp:205`), which prefixes the sys directory onto a *relative* name and
leaves an *absolute* one (starting `/` or `<digit>:`) untouched. This is exactly what
`dwc-gcode-core/edit`'s existing `resolveIncludePath` already implements (`raw.includes(":")` →
as-is; `raw.startsWith("/")` → `0:` + raw; else → `sysDir/raw`) - verified against source here, not
assumed; task 13's project model reuses it rather than re-deriving path resolution.

| Trigger | File(s) run, in order | Source |
| --- | --- | --- |
| Startup | `config.g`, else `config.g.bak` | `RepRap.cpp:628` `RunStartupFile(GCodes::CONFIG_FILE, ...)` |
| Startup, once, then deleted | `runonce.g` (SD-card mode only, not SBC) | `RepRap.cpp:634-644` |
| Idle, repeatedly (1s then every 10s) | `daemon.g` (no error if absent) | `GCodes.cpp:613-629` |
| `M98 P"file"` | `file` (relative → `/sys/`, absolute as-is) | `GCodes2.cpp` case 98 → `DoFileMacroWithParameters` |
| `G28` (no axis letters) | `homeall.g` | `GCodes.cpp:3711` `DoHome`; `GCodes4.cpp:358` state `homing1`; `Kinematics.cpp:25` `HomeAllFileName = "homeall.g"` |
| `G28 <axis>` (one or more axis letters) | `home<lowercase-letter>.g` per axis actually homed this pass (Z last if a Z probe is configured and X/Y aren't home yet) - a literal `'` before the letter if that axis's own letter is already lowercase (e.g. reused axis `a` → `home'a.g`) | `Kinematics.cpp:166` `Kinematics::GetHomingFileName` (the Cartesian-family default; delta/SCARA/hangprinter kinematics override this - see the same file's siblings) |
| `T<n>` tool change, old tool's `TFreeBit` set (default) | `tfree<old-tool-number>.g`, else `tfree.g` | `GCodes4.cpp:429-438` |
| `T<n>` tool change, `TPreBit` set (default) | `tpre<new-tool-number>.g`, else `tpre.g` | `GCodes4.cpp:456-467` |
| `T<n>` tool change, `TPostBit` set (default) | `tpost<new-tool-number>.g`, else `tpost.g` | `GCodes4.cpp:510-519` |
| — bitmap itself | `T ... P<bitmap>`: bit 0 = run tfree, bit 1 = tpre, bit 2 = tpost; default (no `P`) = all three | `Tool.h:37-40` `TFreeBit`/`TPreBit`/`TPostBit`/`DefaultToolChangeParam` |
| `G30` deploy/retract (when the probe's `C` pin is a macro-driven probe) | `deployprobe<probe-number>.g`, else `deployprobe.g`; `retractprobe<probe-number>.g`, else `retractprobe.g` | `GCodes3.cpp:1202-1233` |
| `M701`/`M702` (load/unload filament) | `0:/filaments/<name>/load.g` / `unload.g` | `GCodes.cpp:4624` `LoadFilament`, `4688` `UnloadFilament` - task 08's own file-kinds inventory |
| `M703` (configure filament) | `0:/filaments/<name>/config.g` (of the current tool's loaded filament) | `GCodes2.cpp` case 703 |
| `G29` with no `S` | `mesh.g` if it exists, else the same as `G29 S0` | `GCodes2.cpp` case 29 |
| `G32` | `bed.g` | `GCodes2.cpp:449` case 32, `DoFileMacroWithParameters(gb, BED_EQUATION_G, ...)` |
| `M25`/`M226`/`M601` (pause) | `pause.g` | `GCodes4.cpp:565` state `pausing1`/`eventPausing1` |
| `M600` (filament-change pause) | `filament-change.g`, else `pause.g` | `GCodes4.cpp:570-580` state `filamentChangePause1` |
| `M24` resuming a paused print (no `P0`) | `resume.g` | `GCodes2.cpp:1198` |
| `M0`/`M2` (not paused) | `cancel.g` if it exists, else `stop.g` | `GCodes2.cpp:792-798` |
| `M0`/`M1`/`M112`/an error abort | `stop.g` | `GCodes4.cpp:844` |
| `M916` (resume after power fail) | `resurrect.g`, only if `resurrect-prologue.g` also exists | `GCodes2.cpp:4607-4619` |
| — the resurrect file's own content | `resurrect.g`'s first line is generated as `G21` + `M98 P"resurrect-prologue.g"` (passing the saved axis positions), the rest of the file is the saved state itself | `GCodes.cpp:1503` |
| `M581 T<n>` trigger firing | `trigger<n>.g` | `GCodes.cpp:957` |
| `M501` | `config-override.g` | `GCodes2.cpp` case 501 |
| `M502` | re-runs `config.g` (ignoring `config-override.g`) | `GCodes2.cpp` case 502 |
| A print starting | `start.g`, then the print file itself | `GCodes.cpp:3875` |
| Any `<Letter><Number>[.Fraction]` code RRF doesn't dispatch itself | `<Letter><Number>.g` or `<Letter><Number>.<Fraction>.g` | `GCodes2.cpp:4810` `TryMacroFile` |

## Out of scope for this table (real routes, not modelled by task 13)

- `M912`/board-specific board.txt files, WiFi module firmware upload paths, and anything under
  `0:/firmware/` - out of this package's whole scope per `docs/tasks/README.md` decision 3.
- Which branch of an `if`/`elif` a macro's OWN content takes at runtime - task 13's own "static
  analysis only" decision; a call inside a conditional is recorded as `conditional: true`, not
  resolved further.
