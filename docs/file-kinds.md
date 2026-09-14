# Every file kind RRF reads or writes on the SD card

Task 08's inventory (`docs/tasks/08-file-kinds-menu-data.md`, step 1). Everything below was found by
reading RRF `3.7.0-rc.1` source directly — `git grep` across `src/`, following every file-name
constant to its actual use — not transcribed from the wiki or guessed from file extensions. Where
the original task listed a file that turned out to live somewhere different, or not to exist at all
at this baseline, that's corrected here and called out.

## The seven top-level directories

RRF's own list, `Config/Configuration.h:298-304` — one place, not scattered. The task's own draft
list didn't have a fixed directory for menu files; `MENU_DIR` shows it does.

| Path | Constant | Citation | In scope? |
| --- | --- | --- | --- |
| `0:/sys/` | `DEFAULT_SYS_DIR` (changeable via `M505`) | `Config/Configuration.h:300` | Yes — the bulk of this table |
| `0:/gcodes/` | `GCODE_DIR` | `Config/Configuration.h:299` | Yes — print files |
| `0:/macros/` | `MACRO_DIR` | `Config/Configuration.h:301` | Yes — user macros |
| `0:/filaments/<name>/` | `FILAMENTS_DIRECTORY` | `Config/Configuration.h:302` | Yes — per-filament config/load/unload |
| `0:/menu/` | `MENU_DIR` | `Config/Configuration.h:304` | Yes — 12864-display menu files |
| `0:/www/` | `DEFAULT_WEB_DIR` | `Config/Configuration.h:298` | **Out of scope** — DWC's own files |
| `0:/firmware/` | `FIRMWARE_DIRECTORY` | `Config/Configuration.h:303` | **Out of scope** — firmware binaries |

`0:/sys/accelerometer/` (accelerometer captures) is a subpath of the sys directory, not a separate
top-level one.

## `0:/sys/` — configuration and system macros

| Path | `FileKind` | Syntax | Role / who runs it | Stampable | Citation |
| --- | --- | --- | --- | --- | --- |
| `config.g` | `config` | gcode | Read at startup | Yes | `GCodes.h:317` `CONFIG_FILE` |
| `config.g.bak` | `config` | gcode | A backup copy RRF itself keeps of `config.g` before overwriting it | Yes | `GCodes.h:318` `CONFIG_BACKUP_FILE` — **not in the original task list**, found in this pass |
| `config-override.g` | `config-override` | gcode | Written by `M500`; read by `M501` and, if present, automatically after `config.g` at startup | Yes | `GCodes.h:326` `CONFIG_OVERRIDE_G`; write site `GCodes2.cpp` `case 500`; read `case 501` |
| `bed.g` | `system-macro` (`role: "bed"`) | gcode | Run by `G32` | Yes | `GCodes.h:319` `BED_EQUATION_G` |
| `mesh.g` | `system-macro` (`role: "mesh"`) | gcode | Run by `G29` | Yes | `GCodes.h:320` `MESH_G` |
| `pause.g` | `system-macro` (`role: "pause"`) | gcode | Run on pause (`M25`/`M226`/a pause trigger) | Yes | `GCodes.h:321` `PAUSE_G` |
| `resume.g` | `system-macro` (`role: "resume"`) | gcode | Run by `M24` after a pause | Yes | `GCodes.h:322` `RESUME_G` |
| `cancel.g` | `system-macro` (`role: "cancel"`) | gcode | Run when a paused print is cancelled | Yes | `GCodes.h:323` `CANCEL_G` |
| `start.g` | `system-macro` (`role: "start"`) | gcode | Run when an SD print job begins | Yes | `GCodes.h:324` `START_G`; run site `GCodes.cpp:3875` |
| `stop.g` | `system-macro` (`role: "stop"`) | gcode | Run on `M0`/`M1` or job completion | Yes | `GCodes.h:325` `STOP_G`; run sites `GCodes2.cpp:797`, `GCodes4.cpp:844` |
| `daemon.g` | `system-macro` (`role: "daemon"`) | gcode | Run periodically in the background, if present | Yes | `GCodes.h:334` `DAEMON_G` |
| `runonce.g` | `system-macro` (`role: "runonce"`) | gcode | Run once after `config.g` at startup, then deleted by the user's own script (RRF doesn't delete it) | Yes | `GCodes.h:335` `RUNONCE_G` |
| `resurrect.g` | `system-macro` (`role: "resurrect"`) | gcode | Run by `M916` to resume after a power failure | Yes | `GCodes.h:331` `RESUME_AFTER_POWER_FAIL_G` |
| `resurrect-prologue.g` | `system-macro` (`role: "resurrect-prologue"`) | gcode | Run before `resurrect.g`, if present | Yes | `GCodes.h:332` `RESUME_PROLOGUE_G` |
| `filament-change.g` | `system-macro` (`role: "filament-change"`) | gcode | Run on a filament-change pause (`M600`-style) | Yes | `GCodes.h:333` `FILAMENT_CHANGE_G` |
| `home<letter>.g` (e.g. `homex.g`) | `system-macro` (`role: "home"`) | gcode | Run by `G28 <letter>` for one axis. Filename is `"home" + lowercase(axisLetter) + ".g"`, **except** when the configured axis letter is already lowercase (an extra/reused axis — see task 05's `AllowedAxisLetters` finding), in which case it is escaped with a leading apostrophe: axis `a` homes from `home'a.g`, not `homea.g` (which would collide with axis `A`'s file) | Yes | Default: `Movement/Kinematics/Kinematics.cpp:184` (`Kinematics::GetHomingFileName`, the generic implementation; per-kinematics-type overrides exist — e.g. `Kinematics::HomeAllFileName`'s sibling constants `HomeRadiusFileName`/`HomeBedFileName` (`PolarKinematics.h:44-45`), `HomeProximalFileName`/`HomeDistalFileName` (`ScaraKinematics.h:57-58`), and fixed names like `homex.g`/`homey.g` checked literally in `PolarKinematics.cpp:265,269` and `ScaraKinematics.cpp:412,416`, `homedelta.g` (`LinearDeltaKinematics.cpp:1008`, `RotaryDeltaKinematics.cpp:658`), `home5barscara.g` (`FiveBarScaraKinematics.h:50`) |
| `homeall.g` | `system-macro` (`role: "homeall"`) | gcode | Run by a bare `G28` (home all axes) | Yes | `Movement/Kinematics/Kinematics.cpp:25` `Kinematics::HomeAllFileName` |
| `deployprobe.g`, `deployprobe<N>.g` | `system-macro` (`role: "deployprobe"`) | gcode | Deploy Z probe `N` (or the generic form if `<N>.g` doesn't exist) | Yes | `GCodes.h:310` `DEPLOYPROBE`; use `GCodes3.cpp:1202,1211` |
| `retractprobe.g`, `retractprobe<N>.g` | `system-macro` (`role: "retractprobe"`) | gcode | Retract Z probe `N` | Yes | `GCodes.h:311` `RETRACTPROBE`; use `GCodes3.cpp:1224,1233` |
| `tfree.g`, `tfree<N>.g` | `system-macro` (`role: "tfree"`) | gcode | Run when freeing tool `N` on a tool change | Yes | `GCodes.h:315` `TFREE`; use `GCodes4.cpp:434,437` |
| `tpre.g`, `tpre<N>.g` | `system-macro` (`role: "tpre"`) | gcode | Run before selecting tool `N` | Yes | `GCodes.h:313` `TPRE`; use `GCodes4.cpp:462,465` |
| `tpost.g`, `tpost<N>.g` | `system-macro` (`role: "tpost"`) | gcode | Run after selecting tool `N` | Yes | `GCodes.h:314` `TPOST`; use `GCodes4.cpp:515,518` |
| `filament-error.g` | `system-macro` (`role: "filament-error"`) | gcode | **Defined but not actually invoked anywhere in 3.7.0-rc.1** - `FILAMENT_ERROR` is declared and never referenced again; a real filament-monitor error now goes through the Event system instead (`FilamentMonitor.cpp:483`, `Event::AddEvent(EventType::filament_error, ...)`), not a macro file. Classified here in case a plugin still finds one on an older-firmware SD card, but it should not be treated as something current RRF will run. | Yes | `GCodes.h:312` `FILAMENT_ERROR` (unused) |
| `trigger<N>.g` | `system-macro` (`role: "trigger"`) | gcode | Run when trigger input `N` fires (`M581`-configured) | Yes | `GCodes.cpp:957` (`filename.printf("trigger%u.g", ...)`) |
| `<Letter><Number>.g`, `<Letter><Number>.<Fraction>.g` (e.g. `G27.g`, `M577.g`, `G38.2.g`) | `system-macro` (`role: "custom-code"`) | gcode | Run for an otherwise-unimplemented G/M code (RRF's "Custom GCodes" mechanism) — matches any `[A-Z][0-9]+(\.[0-9]+)?\.g` filename, so this is a pattern, not a fixed list | Yes | `GCodes2.cpp` `GCodes::TryMacroFile` (confirmed in this pass, not just cited from the wiki) |
| `heightmap.csv` | `height-map` | csv | Written by `G29 S1`/read by `G29 S0`; the file the loader itself requires to start with `HeightMapComment` then a label line — see task 09's stamp rules | **Never** | `GCodes.h:327` `DefaultHeightMapFile`; directory resolution `GCodes6.cpp:466-471` (`MakeSysFileName`); loader `Movement/BedProbing/Grid.cpp` |
| `probePoints.csv` | `probe-points` | csv | Multi-point manual bed probing point list | **Never** | `GCodes.h:337` `DefaultProbeProbePointsFile` (behind `SUPPORT_PROBE_POINTS_FILE`) |
| `eventlog.txt` | `event-log` | text | Written by `M929` (default name; `M929 P"..."` overrides it) | No (append-only log, not G-code) | `Config/Configuration.h:316` `DEFAULT_LOG_FILE`; default-name site `Platform/Platform.cpp:3427`; directory `Platform/Logger.cpp:37` (`OpenSysFile`) |
| `accelerometer/<board>_<yyyy-mm-dd>_<hh.mm.ss>.csv` | `accelerometer-data` | csv | Written by `M956` | No | `Accelerometers/Accelerometers.cpp:478` |

## `0:/filaments/<name>/`

| Path | `FileKind` | Syntax | Role | Stampable | Citation |
| --- | --- | --- | --- | --- | --- |
| `config.g` | `filament-config` | gcode | Applies the filament's own settings (temperatures, retraction) when it's loaded | Yes | `GCodes.h:329` `CONFIG_FILAMENT_G`; use `GCodes2.cpp:4393` |
| `load.g` | `filament-load` | gcode | Runs when this filament is loaded (`M701`) | Yes | `GCodes.h:328` `LOAD_FILAMENT_G`; use `GCodes.cpp:4670` |
| `unload.g` | `filament-unload` | gcode | Runs when this filament is unloaded (`M702`) | Yes | `GCodes.h:330` `UNLOAD_FILAMENT_G`; use `GCodes.cpp:4711` |

**Correction to the original task list**: `load.g`/`unload.g`/a filament's own `config.g` are *only*
ever referenced under `filaments/<name>/` (confirmed — every use site builds the path from
`FILAMENTS_DIRECTORY`); there is no separate top-level `/sys/load.g` or `/sys/unload.g`. The task's
draft inventory implied these were `/sys` files; they are not.

A `filament.json` per-filament metadata file is mentioned only in a source comment
(`Tools/Filament.h:24`, "should be stored in a dedicated file... like .../filament.json") and is not
actually read or written anywhere in `3.7.0-rc.1` — left out of the table as aspirational, not real.

## `0:/gcodes/`

| Path | `FileKind` | Syntax | Stampable | Citation |
| --- | --- | --- | --- | --- |
| any file (recursively) | `print-file` | gcode | Yes — a stamp is a `;` comment near the top; `Storage/FileInfoParser.cpp` scans header/footer chunks for slicer metadata and doesn't require line 1 to be anything specific (task 09 verified this directly before relying on it) | `Config/Configuration.h:299` `GCODE_DIR` |

## `0:/macros/`

| Path | `FileKind` | Syntax | Stampable | Citation |
| --- | --- | --- | --- | --- |
| any file (recursively), including menu files under `0:/menu/` if a machine keeps them there | `user-macro` (gcode) or `menu` (see below), by content/extension | gcode or menu | Yes | `Config/Configuration.h:301` `MACRO_DIR` |

## `0:/menu/` — 12864-display menu files

`MENU_DIR` (`Config/Configuration.h:304`); loaded by `Display/Menu.cpp`'s `Menu::Reload()`
(`OpenFile(MENU_DIR, fname, ...)`). `.g` extension is NOT used for menu files, so `classifyFile`
distinguishes them by **directory** (a `menu` path segment - the fixed `0:/menu/` root, or a
`menu/` segment anywhere for tolerance), not by extension.

| Path | `FileKind` | Syntax | Stampable | Citation |
| --- | --- | --- | --- | --- |
| `menu/*` (any file without an image extension) | `menu` | menu | Yes — `;` starts a comment (confirmed directly: `Menu::ParseMenuLine`'s first check is `*commandWord == ';' \|\| *commandWord == 0`) | `Display/Menu.cpp:236-239`; wiki `Display_12864_menu.md` |
| `menu/*.img`, `menu/*.xbm`, `menu/*.bmp` (an image the `image` command references) | `menu-image` | binary | Never | `Display/Menu.cpp`'s `image` command handling (`ImageMenuItem`); wiki `Display_12864_menu.md` |

## Out of scope (not this package's concern at all)

| Path | Why |
| --- | --- |
| `0:/firmware/*` | Firmware binaries — `FIRMWARE_DIRECTORY`, `Config/Configuration.h:303` |
| `0:/www/*` | DWC's own served files — `DEFAULT_WEB_DIR`, `Config/Configuration.h:298` |
| Any plugin-installed file (DWC plugin ZIPs, their own SD-stored data) | Not RRF's own file, per the user's own scope decision (decision 3: "anything that's not a gcode, firmware file or plugin/dwc file") |

## `other`

Anything else on the card that doesn't match one of the rows above (an unrecognised file in `/sys`,
a user's own notes file, etc.) classifies as `FileKind: "other"`, `syntax: "text"` — never stamped,
since its format isn't known.
