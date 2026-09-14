# 08 — Every file kind on the SD card; menu files; height-map files

## The gap

Scope is G-code files plus every other file on the SD card except firmware binaries and DWC/plugin
files (user decision 3). The package only understands G-code syntax today: it has no notion of
*which* file it's looking at, and no parser for menu files or RRF's own data files.

## Sources

- File names RRF itself reads or writes, found 2026-09-14 by grepping RRF `3.7.0-rc.1`
  (`GCodes*.cpp`, `GCodes.h`, `Configuration.h`, `Grid.cpp`): `config.g`, `config-override.g`,
  `bed.g`, `mesh.g`, `daemon.g`, `runonce.g`, `start.g`, `stop.g`, `cancel.g`, `pause.g`, `resume.g`,
  `resurrect.g`, `resurrect-prologue.g`, `filament-change.g`, `load.g`, `unload.g`, `heightmap.csv`,
  `probePoints.csv`, `eventlog.txt`, and name prefixes `deployprobe`, `retractprobe`,
  `filament-error`, `tpre`, `tpost`, `tfree`. **This list is a starting point, not complete**: homing
  files (`homeall.g`, `home<axis>.g`), `sleep.g`, trigger files, custom-command macros (`/sys/<code>.g`
  — wiki, custom G-codes), `filaments/<name>/config.g` (`M703`) and others are built from string
  pieces the grep missed.
- Menu files: wiki `Display_12864_menu.md` (commands `image`, `text`, `button`, `value`, `alter`,
  `files`; parameters `R C A F D T L W H V N I`; actions in `A"…"` separated by `|` — a G-code
  string, `menu <name>` or `return`; `V{…}`/`N{…}` expressions from RRF 3.5); RRF
  `src/Display/Menu.cpp` (`Menu::ParseMenuLine`: a line starting `;` is a comment and argument
  parsing stops at `;`; unknown commands are reported) and the `*MenuItem.cpp` files;
  `@duet3d/monacotokens` menu grammar (`lineComment: ";"`).
- Height map / probe points: RRF `src/Movement/BedProbing/Grid.cpp` — `HeightMapComment`,
  `PointsFileComment`, the historical label lines, the writer, and the loader (line 1 must start with
  the comment, then the label line, then parameters). Label-line versions:
  old `xmin,xmax,ymin,ymax,radius,spacing,xnum,ynum`; until 3.3-beta1
  `xmin,xmax,ymin,ymax,radius,xspacing,yspacing,xnum,ynum`; from 3.3-beta2
  `axis0,axis1,min0,max0,min1,max1,radius,spacing0,spacing1,num0,num1`.

## Decisions

- `FileKind` is a closed union, classified **by SD path** (and, for unknown paths, by extension):
  `config`, `config-override`, `system-macro` (with a `role`, e.g. `"homeall"`, `"tpre"`, `"pause"`),
  `user-macro`, `filament-config`, `filament-load`, `filament-unload`, `print-file`, `menu`,
  `menu-image`, `height-map`, `probe-points`, `event-log`, `accelerometer-data`, `other`, and
  `out-of-scope` (firmware, `www/`, plugin/DWC files). The table lives in `src/files/kinds.ts`, each
  row cited to where RRF names or uses the file.
- Each kind also records its **syntax** (`"gcode" | "menu" | "csv" | "text" | "binary"`) — task 09's
  stamp rules key off this.
- **Menu parser** reuses the lexer's parameter scan where the syntax matches (letters with values,
  quoted strings). Whether an un-prefixed quoted string is text depends on the command — take the
  rule from `Menu.cpp`. `A"…"` actions are split on `|`, and each G-code action is lexed with
  task 05's `lexLine`.
- **Height map** is parsed into `{ version, grid, rows }` and validated exactly as the loader would —
  never modified by this package, never stamped.
- `event-log` and `accelerometer-data` are classified but not parsed (no consumer needs them yet;
  resonance-lab's `src/capture/csv.ts` is prior art for the latter — note it in `kinds.ts`).

## API

```ts
export type FileSyntax = "gcode" | "menu" | "csv" | "text" | "binary";
export type FileKind = /* as above */;
export function classifyFile(path: string): { kind: FileKind; syntax: FileSyntax; role?: string };
export interface MenuDocument { lines: ReadonlyArray<MenuLine>; errors: ReadonlyArray<MenuError> }
export function parseMenu(text: string): MenuDocument;
export interface HeightMap {
	version: number;
	grid: { axis0: string; axis1: string; min0: number; max0: number; min1: number; max1: number; radius: number; spacing0: number; spacing1: number; num0: number; num1: number };
	rows: ReadonlyArray<ReadonlyArray<number | null>>;
}
export function parseHeightMap(text: string): { map: HeightMap | null; errors: ReadonlyArray<{ message: string; line: number }> };
```

## Steps

1. **Inventory (stop point)**: enumerate every file RRF reads or writes — grep the baseline for
   `".g"`, `".csv"`, `".txt"`, `".json"` literals, the macro-running call sites, and the string
   building for names like `home%c` and `tpre%d`. Write `docs/file-kinds.md`: path pattern, kind,
   syntax, who reads/writes it, whether it's stampable, citation. **Report the table before
   implementing** if it contradicts anything in this task.
2. `classifyFile`, with a test for every row.
3. Menu parser, with tests built from the wiki's syntax table and every branch of
   `Menu::ParseMenuLine`'s dispatch.
4. Height-map parser, with tests for all three label-line versions and each loader error.

## Acceptance

`docs/file-kinds.md` complete and cited; `classifyFile` covers every row; the menu and height-map
parsers reject exactly what RRF rejects.

## Out of scope

Rendering menus; decoding `menu-image` files beyond recognising them.
