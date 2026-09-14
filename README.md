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

Pure TypeScript, zero runtime dependencies, no Vue, Pinia or DWC imports. It is bundled into each
plugin that uses it.

## Install

```bash
npm install dwc-gcode-core
```

## Use

```ts
import { g10Form, parseParams, paramNumber, readToolTemperatureSetting, setParam, tokenise, withBody } from "dwc-gcode-core";

const token = tokenise("G10 P1 S205:200 R150 ; tool 1");
token.code;                                      // "G10"
g10Form(token.body);                             // "toolSettings" — not a retraction
readToolTemperatureSetting(token.code, token.body);
// { tool: 1, active: [205, 200], standby: [150], setsTemperatures: true, heaterState: null }

paramNumber(parseParams("M116 P"), "P");         // null — a bare P waits for every tool; it is not tool 0
withBody(token, setParam(token.body, "P", "2")); // "G10 P2 S205:200 R150 ; tool 1"
```

Each module is also its own entry point (`dwc-gcode-core/lex`, `/params`, `/edit`, `/commands/g10`,
`/commands/toolParams`, `/rrf`), and the package is marked side-effect free, so a bundler keeps only
what a plugin imports. **`/edit` is subpath-only, not re-exported from the root** — its own
`setParam` (rewrites a parameter on a raw config.g *line*) is a different function from the root's
`setParam` (rewrites a parameter on an already-tokenised command *body*) that happens to share a
name; import config-file editing explicitly:

```ts
import { findDirectives, parseLines, planDirectiveEdit, setParam } from "dwc-gcode-core/edit";

const plan = planDirectiveEdit(configText, "M572", { D: "0" }, (raw) => setParam(raw, "S", "0.045"), "M572 D0 S0.045", "note");
plan.after;   // the whole file's new text, or unchanged with plan.blocked set if the line isn't safe to touch
plan.diff;    // line-level diff for a preview UI
```

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

## Licence

GPL-3.0-or-later.
