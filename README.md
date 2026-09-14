# dwc-gcode-core

G-code parsing for DuetWebControl plugins that follows what RepRapFirmware actually does, not what a
G-code line looks like it does.

- **An allocation-light line tokeniser** that never splits a comment out of a quoted string
  (`M291 P"done; resuming"`), handles RRF's `""` escapes and `{…}` expressions, and skips `N` line
  numbers.
- **Parameter parsing and in-place rewriting** on index spans, so rewriting one value leaves the
  rest of the line byte-identical.
- **A small table of what specific commands mean**, each entry checked against RRF source at a
  named release: `G10`'s three forms (tool settings, workplace offset, retraction), `M568`/`G10`
  tool temperatures including per-heater colon lists, and which commands' `P` is a tool number.
- **A line-preserving config.g/macro directive editor** (`dwc-gcode-core/edit`) — find a directive
  (active or commented-out), replace one parameter or the whole line, append one if it's missing, or
  edit across `config.g` and its `M98` includes, always keeping the rest of the file byte-identical.
- **Conditional G-code (RRF's `if`/`var`/`while`/…) recognition** — `classifyLine` tells a command
  apart from a meta-command, a comment or blank line, with RRF's own block-nesting indent computed
  alongside it; `parseAssignment` reads all four of RRF's variable-mutating forms
  (`var`/`global` declarations, `set var.`/`set global.` assignments).
- **Firmware version comparison and a small "what changed since when" table** — `parseFirmwareVersion`/
  `compareFirmwareVersions` handle RRF's actual version format (the STM32 port's parenthesised
  suffix, and its `+N` build-number tiebreaker for same-prerelease releases); `FEATURES`/`supports()`
  gate on a cited RRF version rather than a magic string repeated at every call site.

Pure TypeScript, zero runtime dependencies, no Vue, Pinia or DWC imports. It is bundled into each
plugin that uses it.

## Install

```bash
npm install dwc-gcode-core
```

## Use

```ts
import {
	classifyLine, firmwareAtLeast, g10Form, parseAssignment, parseParams, paramNumber,
	readToolTemperatureSetting, setParam, supports, tokenise, withBody,
} from "dwc-gcode-core";

const token = tokenise("G10 P1 S205:200 R150 ; tool 1");
token.code;                                      // "G10"
g10Form(token.body);                             // "toolSettings" — not a retraction
readToolTemperatureSetting(token.code, token.body);
// { tool: 1, active: [205, 200], standby: [150], setsTemperatures: true, heaterState: null }

paramNumber(parseParams("M116 P"), "P");         // null — a bare P waits for every tool; it is not tool 0
withBody(token, setParam(token.body, "P", "2")); // "G10 P2 S205:200 R150 ; tool 1"

classifyLine("if sensors.gpIn[0].value = 1");    // { kind: "meta", meta: "if", indent: 0 }
classifyLine("  G28 Z");                         // { kind: "command", command: {...}, indent: 2 }
parseAssignment("set global.T1heat=heat.heaters[1].active");
// { form: "set", scope: "global", name: "T1heat", expression: "heat.heaters[1].active", ... }

supports(board.firmwareVersion, "m568");           // true from RRF 3.3 onward
firmwareAtLeast(board.firmwareVersion, "3.7.0-rc.1"); // strips a real board's "3.7.0-rc.1(CAN0)" first
```

Each module is also its own entry point (`dwc-gcode-core/lex`, `/params`, `/meta`, `/document`,
`/edit`, `/expr/parse`, `/expr/tables`, `/files/kinds`, `/files/menu`, `/files/heightmap`,
`/firmware`, `/commands/g10`, `/commands/toolParams`, `/rrf`, `/version`, `/stamp`), and the package
is marked side-effect free, so a bundler keeps only what a plugin imports. **`/edit` is subpath-only,
not re-exported from the root** — its own
`setParam` (rewrites a parameter on a raw config.g *line*) is a different function from the root's
`setParam` (rewrites a parameter on an already-tokenised command *body*) that happens to share a
name; import config-file editing explicitly:

```ts
import { findDirectives, parseLines, planDirectiveEdit, setParam } from "dwc-gcode-core/edit";

const plan = planDirectiveEdit(configText, "M572", { D: "0" }, (raw) => setParam(raw, "S", "0.045"), "M572 D0 S0.045", "note");
plan.after;   // the whole file's new text, or unchanged with plan.blocked set if the line isn't safe to touch
plan.diff;    // line-level diff for a preview UI
```

## The stamp

Every file a plugin parses can carry a stamp — one `;` comment recording the RRF version it was
checked against, the plugin (id + version) that checked it, and this package's own version — so a
file can be flagged for re-checking when the firmware, the plugin, or this package itself changes
(the user's own words: "in case we need to reparse due to plugin bugs"). One format, owned here, so
every plugin reads and writes the same thing.

```ts
import { readStamp, recheckReasons, stampable, writeStamp } from "dwc-gcode-core/stamp";
import { classifyFile } from "dwc-gcode-core/files/kinds";

const { kind } = classifyFile("0:/gcodes/benchy.gcode");
if (stampable(kind)) {
	text = writeStamp(text, { rrf: "3.7.0-rc.1", pluginId: "GCodePostProcessor", pluginVersion: "1.2.1", at: new Date().toISOString() }, kind);
}
// ; dwc-gcode-core: checked rrf=3.7.0-rc.1 plugin=GCodePostProcessor@1.2.1 core=0.5.0 at=2026-09-14T10:00:00.000Z

const stamp = readStamp(text);                                        // null if there is no stamp
recheckReasons(stamp, { rrf: currentRrf, pluginId: "GCodePostProcessor", pluginVersion: "1.3.0" });
// [{ kind: "plugin-changed", pluginId: "GCodePostProcessor", from: "1.2.1", to: "1.3.0" }]
```

Writing replaces an existing stamp in place rather than accumulating one, coexists with the
post-processor's own `; postprocessed-by:` line (in either order), and survives a BOM or CRLF line
endings untouched. `writeStamp` throws `StampNotAllowedError` for a file kind that must never be
stamped — `heightmap.csv` and `probePoints.csv` most importantly: their own loader in RRF requires
an exact first line, so a stamp would break loading outright (verified directly against
`HeightMap::LoadFromFile`, not assumed). A value containing a space, `%` or `=` (a DWC plugin id may
contain a space) is percent-encoded; anything else, including the `at` timestamp's own colons, is
left as plain text.

## Tracking RepRapFirmware

`RRF_BASELINE` (and `package.json`'s `rrf.baseline`) names the RRF release every citation in this
package was checked against — currently **3.7.0-rc.1**.

When RRF releases, list the commits that could change what this package must recognise:

```bash
npm run triage -- 3.7.0-rc.1 3.7.0 --out docs/rrf-triage/3.7.0-rc.1..3.7.0.md
```

That lists every commit in the range touching RRF's G-code parser (`src/GCodes/GCodeBuffer/`) or
command dispatch (`src/GCodes/GCodes*.cpp`), as a checklist. It needs an authenticated `gh`. Each
item is closed as *no effect on syntax*, *recognition added* (code + test) or *semantic table
updated* (entry + citation + test). Only a fully closed list moves the baseline, and that commit is
tagged `rrf-<tag>` alongside the usual `vX.Y.Z` release tags.

`docs/wiki-discrepancies.md` records where the Duet3D G-code dictionary and RRF source disagree, with
evidence from both, so they can be reported upstream.

## Known limitation: a legacy webpack/CJS-oriented build cannot import the bare package name

This package is ESM-only (`"type": "module"`), and its `package.json` `exports` map has no
`"require"` condition on any entry. A modern bundler (Vite, current TypeScript with
`moduleResolution: "bundler"`/`"node16"`/`"nodenext"`) handles this fine. An older webpack/Vue-CLI
setup using `moduleResolution: "node"` (TypeScript's classic algorithm) cannot resolve
`import ... from "dwc-gcode-core"` at all — confirmed against a real DWC 3.6 build (resonance-lab's
own dual DWC 3.6/3.7 target), which fails with `TS2307: ... types exist, but this result could not be
resolved under your current 'moduleResolution' setting`.

**A documented subpath always works instead** (`dwc-gcode-core/lex`, `/params`, `/meta`, `/edit`,
`/firmware`, `/commands/g10`, `/commands/toolParams`, `/rrf`) — subpaths resolve via `typesVersions`'
wildcard mapping, which classic Node resolution already understands, independent of the `exports`
map's condition matching that trips up the bare root specifier. If a consumer targets a legacy
webpack/CJS build alongside a modern one, import every symbol from its specific subpath and never
from the bare package name — consistent, and it works on both build systems.

## Licence

GPL-3.0-or-later.
