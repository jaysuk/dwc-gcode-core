# `fff-basic` fixture

A minimal but real FFF machine's SD-card layout (task 13, `docs/tasks/13-project-model.md`), used by
`test/project.test.ts`. Deliberately includes:

- `sys/config.g` — defines tools, heaters, a sensor, a fan, a Z probe, axes/endstops, and (inside an
  `if` block, for `conditional: true` coverage) a spindle port that has no real use here.
- `sys/homeall.g`, `sys/homex.g` — `homey.g`/`homez.g` are deliberately **absent**, so `G28 Y` in
  `gcodes/test.gcode` produces an unresolved call.
- `sys/tfree0.g` (numbered form present), `sys/tpre.g` (only the bare fallback exists - `tpre0.g` is
  deliberately absent), `sys/tpost0.g` (numbered form present) - exercises the fallback-chain
  resolution both ways.
- `sys/bed.g`, `sys/pause.g`, `sys/resume.g`, `sys/stop.g` (`cancel.g` deliberately absent, so `M0`
  in the print file falls back to `stop.g`).
- `sys/toolpick.g` - a `var`/`if`/`M98`/`T{expression}` macro for conditional-call and dynamic-call
  coverage, independent of the print file.
- `filaments/PLA/{load,unload,config}.g` - a real filament directory.
- `gcodes/test.gcode` - the print file: `G28`, `G28 Y` (unresolved), `M701 S"PLA"`, `T0`, `G32`,
  `M98 P"missing.g"` (unresolved), `M0`.
- `menu/main` - a real 12864-menu file.
