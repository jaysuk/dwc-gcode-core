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
`/firmware`, `/commands/g10`, `/commands/toolParams`, `/dictionary/commands`, `/dictionary/schema`,
`/objectmodel/versions`, `/objectmodel/schema`, `/releases/schema`, `/releases/changes`,
`/releases/impact`, `/diagnostics/schema`, `/diagnostics/rules`, `/diagnostics/diagnose`,
`/diagnostics/monaco`, `/project`, `/compare`, `/rrf`, `/version`, `/stamp` — see `docs/api.md` for
every export, subpath by subpath), and the package is
marked side-effect free, so a bundler keeps only what a plugin imports. **`/edit` and `/dictionary/*`
are subpath-only, not re-exported from the root** — `/edit`'s own `setParam` (rewrites a parameter on
a raw config.g *line*) is a different function from the root's `setParam` (rewrites a parameter on an
already-tokenised command *body*) that happens to share a name, and `/dictionary/schema`'s `ParamKind`
(the dictionary's parameter-kind enum) likewise collides by name with `/lex`'s own `ParamKind` (a
lexed parameter's syntactic shape); import config-file editing explicitly:

```ts
import { findDirectives, parseLines, planDirectiveEdit, setParam } from "dwc-gcode-core/edit";

const plan = planDirectiveEdit(configText, "M572", { D: "0" }, (raw) => setParam(raw, "S", "0.045"), "M572 D0 S0.045", "note");
plan.after;   // the whole file's new text, or unchanged with plan.blocked set if the line isn't safe to touch
plan.diff;    // line-level diff for a preview UI
```

## The command dictionary

What each command's parameters are — letter, kind, whether it takes a colon list or an expression,
required-ness, value enums, deprecation — cited to a named RRF release rather than guessed from a
pattern. 280 commands are known; every command a real slicer or `config.g` actually uses ("tier 1")
is reviewed against RRF 3.7.0-rc.1 source, the rest are drafted from `@duet3d/monacotokens` pending
review (`dictionary/coverage.json` tracks exactly which is which — see `docs/tasks/10-dictionary.md`).

```ts
import { commandSpec } from "dwc-gcode-core/dictionary/commands";

const spec = commandSpec("M568");
spec?.parameters.find((p) => p.letter === "P");
// { letter: "P", kind: "toolNumber", list: false, expressionAllowed: true, ... }
spec?.reviewed; // "3.7.0-rc.1" for a reviewed entry, undefined for a drafted-only one
```

`src/commands/toolParams.ts`'s `TOOL_PARAM_COMMANDS` (which commands' parameter is a real tool
number, for a tool-renumbering pass) is derived from this dictionary's reviewed `toolNumber`
parameters, rather than hand-maintained.

## The object model

Whether an object-model path used in an expression or a condition (`move.axes[0].homed`,
`heat.heaters[1].current`) exists at a given RRF release, since/until which release, and whether it's
deprecated — paths are added, removed and deprecated between releases, and a macro written against
one release can silently break on another.

```ts
import { objectModelChanges, objectModelPath } from "dwc-gcode-core/objectmodel/schema";

objectModelPath("move.motionSystems", "3.6.3");     // { known: false } - added later
objectModelPath("move.motionSystems", "3.7.0-rc.1"); // { known: true, since: "3.7.0-beta.1" }
objectModelPath("heat.bedHeaters", "3.7.0-rc.1");    // { known: true, deprecated: "use bedHeaterMapping instead" }

objectModelChanges("3.6.3", "3.7.0-rc.1");
// [{ path: "move.motionSystems", change: "added", version: "3.7.0-beta.1" }, ...]
objectModelChanges("3.7.0-rc.1", "3.6.3"); // the same change, the other way: "removed"
```

709 paths are tracked across every RRF release in this package's window that `@duet3d/objectmodel`
published a matching version for (`3.6.3`, `3.7.0-beta.1`–`3.7.0-rc.1`); `3.7.0-alpha.2` is a known
RRF tag with no usable object-model source for it (see `docs/tasks/11-object-model-schema.md`) and is
listed in `OBJECT_MODEL_VERSIONS` with `hasData: false` rather than silently guessed at.

## Evaluating expressions and simulating execution

`expr/parse.ts` only parses `{...}` expressions into an AST — it "never evaluates anything ... no
object model, no variable values" (its own doc comment). `expr/evaluate.ts` is the practical subset
of RRF's real evaluator built on top of that AST: comparisons, short-circuit `&&`/`||`, arithmetic,
`^` (concatenation, not exponentiation — see its own doc comment), the deterministic math functions
(`abs`, `floor`, `pow`, `mod`, `max`/`min`, ...), `vector`/`take`/`drop`/`find`, and `exists()`
(special-cased like real RRF's own parser — true for a declared `var`/`global` regardless of its
value, or for an object-model path when `EvalContext.pathExists` is supplied). It deliberately leaves
out anything that needs file IO, entropy, wall-clock time or macro-call parameters (`fileread`,
`fileexists`, `random`, `datetime`, `param.*`, ...) as clean "not supported" errors rather than
guessing.

```ts
import { evaluateExpression, UnresolvedPathError, type EvalContext } from "dwc-gcode-core/expr/evaluate";
import { parseExpression } from "dwc-gcode-core/expr/parse";

const ctx: EvalContext = {
	resolvePath: (path) => { throw new UnresolvedPathError(path); }, // a live/hardware value we don't have
	resolveVariable: (scope, name) => { throw new Error(`'${scope}.${name}' is not defined`); },
};
evaluateExpression(parseExpression("sensors.gpIn[0].value > 0").ast, ctx);
// { ok: false, kind: "unresolved-path", path: "sensors.gpIn[0].value" }
```

`execute.ts`'s `walkExecution` uses that evaluator together with `document.ts`'s `blocks` tree to
determine a file's REAL execution order — which `if`/`elif`/`else` arm actually runs, how many times
a `while` body repeats, `break`/`continue`/`abort` — rather than a flat top-to-bottom line walk. It's
a single-pass, synchronous, pure function: given a `resolvePath` that throws `UnresolvedPathError` for
a value it doesn't have, it stops exactly at the condition that needed it and reports everything
executed up to that point; re-running it with a `resolvePath` that now answers that path picks up from
the top and gets further (re-running is simpler and no less correct than trying to resume mid-walk,
since the walk is deterministic given the same inputs). This is the seam a caller uses to simulate
"what if this sensor read X" without a live machine — prompt for a value, supply it, re-walk.

```ts
import { walkExecution } from "dwc-gcode-core/execute";
import { parseDocument } from "dwc-gcode-core/document";

const doc = parseDocument("if sensors.gpIn[0].value > 0\n    G1 X1\nelse\n    G1 X2\nM400\n");
const r = walkExecution(doc, { resolvePath: () => { throw new UnresolvedPathError("sensors.gpIn[0].value"); } });
// { status: "paused", line: 0, path: "sensors.gpIn[0].value", steps: [] }

walkExecution(doc, { resolvePath: (p) => (p === "sensors.gpIn[0].value" ? 1 : 0) });
// { status: "complete", steps: [{ line: 0 }, { line: 1 }, { line: 2 }, { line: 4 }] }
```

A `while` loop is capped at `maxIterationsPerLoop` (default 10 000) — RRF itself has none (it re-seeks
the file on every iteration), but an offline simulator can't inherit that unboundedness without risking
a hang. Only `if`/`elif`/`while` CONDITIONS can pause a walk; an ordinary command's own `{...}`
parameter (e.g. `G1 X{sensors.someValue}`) isn't evaluated by `walkExecution` at all, since it doesn't
affect which lines run next — a caller deriving machine state from each step evaluates those itself.
`var` is properly block-scoped (a fresh frame per `if`/`elif`/`else`-arm or `while`-iteration body,
popped when it ends, correctly shadowing an outer `var` of the same name without corrupting it) —
`global` is unaffected, RRF doesn't block-scope it either.

Pass `objectModelVersion` (one of `OBJECT_MODEL_VERSIONS`' tracked versions, `objectmodel/versions.ts`)
to validate every referenced path against `objectmodel/schema.ts` before `resolvePath` is even called
— a path that doesn't exist at that version is a hard `"error"`, not a `"paused"` (there's no
reasonable value to ask for a path that isn't real), and it's what lets `exists()` answer for an
object-model-path argument instead of a "not supported" error:

```ts
walkExecution(doc, { resolvePath: () => { throw new UnresolvedPathError("x"); }, objectModelVersion: "3.7.0-rc.1" });
// a typo'd or version-mismatched path is now an "error", not a "paused" waiting for a value
```

`onStep(step)` fires synchronously, in order, right after each step is recorded — before
`walkExecution` itself returns. It's the seam for a caller that wants to maintain its own derived state
INCREMENTALLY as the walk proceeds (rather than only replaying the final `steps` array afterwards), so
a later condition's `resolvePath` can answer from something the walk has already gone past — e.g.
answering `move.axes[0].homed` from a `G28` seen earlier, instead of always prompting for it.

## The project model

The machine's whole SD-card configuration as one graph — which files invoke which others (`M98`,
homing, tool changes, filament changes, pause/resume, and more, every route cited in
`docs/invocation-table.md`), and which numbered/named resource (tool, heater, sensor, fan, axis,
endstop, probe, ...) each command defines or references.

```ts
import { loadProject } from "dwc-gcode-core/project";

const project = loadProject([
	{ path: "0:/sys/config.g", text: configText },
	{ path: "0:/sys/homeall.g", text: homeallText },
	{ path: "0:/gcodes/print.gcode", text: printText },
]);

project.calls.find((c) => c.via === "G28-homeall");     // { to: "sys/homeall.g", resolved: true, ... }
project.symbols.find((s) => s.type === "tool" && s.id === "0");
// { definitions: [...], uses: [...] } - each site records whether it's inside an `if`/`while`
// (conditional) or written as an `{...}` expression (dynamic) - static analysis only, never evaluated.
```

## Diagnostics

25 cited rules — syntax, structure, dictionary, project, release, menu, data and object-model — each
naming the RRF source or wiki passage that justifies it (see `docs/diagnostics.md`, generated from
the rule registry). `diagnoseDocument` checks a single parsed file; `diagnoseProject` adds everything
that needs the whole SD-card graph (undefined/duplicate resources, missing macro files, order
dependencies, menu-file and height-map errors).

```ts
import { diagnoseDocument, diagnoseProject } from "dwc-gcode-core/diagnostics/diagnose";
import { toMonacoMarkers } from "dwc-gcode-core/diagnostics/monaco";
import { parseDocument } from "dwc-gcode-core/document";

const doc = parseDocument(configText);
const diags = diagnoseDocument(doc, "0:/sys/config.g", { firmwareVersion: "3.7.0-rc.1" });
// [{ rule: "dictionary/deprecated", severity: "warning", message: "M107 is deprecated...", ... }]

toMonacoMarkers(diags, configText); // 1-based line/column, UTF-16 units - no Monaco import
```

Run `diagnoseProject(project, options)` (see "The project model" above for `loadProject`) to add the
project-wide rules on top of every file's own.

## Compare

Semantic diff, not textual — directives are matched by an identity key derived from the dictionary's
own defining parameters (a tool by its `P`, a heater by `M950`'s `H`, an axis mapping by `M584`'s own
letter, ...), so a reordered file or one split across includes reads as `changed`/`moved`, not
wholesale removals and additions. `diffText` is the separate byte-faithful line diff for callers that
want that view too.

```ts
import { compareDocuments, diffText } from "dwc-gcode-core/compare";
import { parseDocument } from "dwc-gcode-core/document";

compareDocuments(parseDocument(before), parseDocument(after), { fromVersion: "3.6.3", toVersion: "3.7.0-rc.1" });
// [{ type: "changed", code: "M950", identity: "M950:H0", params: [{ letter: "C", from: "\"out0\"", to: "\"out1\"" }], ... }]

diffText(before, after); // [{ type: "same" | "added" | "removed", text, lineA?, lineB? }, ...]
```

`compareProjects(a, b, options)` runs the same matching across a whole `loadProject` graph, which is
what lets a directive that moved from `config.g` into an included file show up as `moved`, not a
false remove-plus-add.

## Release changes

A versioned catalogue of RRF changes — commands, parameters, object-model paths and a handful of
expression-syntax features — queryable in either direction, plus matching those changes against a
real file to find what it actually uses that changed.

```ts
import { changesBetween } from "dwc-gcode-core/releases/changes";
import { impactOf } from "dwc-gcode-core/releases/impact";
import { parseDocument } from "dwc-gcode-core/document";

changesBetween("3.6.3", "3.7.0-rc.1").find((e) => e.id === "m408-removed");
// { id: "m408-removed", version: "3.7.0-alpha.2", kind: "removed", direction: "upgrade", ... }

const doc = parseDocument(configText);
impactOf(doc, "3.6.3", "3.7.0-rc.1");
// [{ event: {...}, direction: "upgrade", line: 4, message: "M408 removed entirely; ... (will stop working ...)" }]
```

Built from `scripts/rrf-triage.mjs`'s output for the `GCodeBuffer`/`GCodes dispatch` subsystems (the
two most likely to affect this package) plus every dictionary/object-model entry with version history
— the rest of RRF's subsystems and the wiki are deferred; see `docs/tasks/12-release-model.md`.
`firmware.ts`'s `FEATURES`/`supports()` are now a thin, named view over this same store.

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

## Legacy webpack/CJS builds (`moduleResolution: "node"`)

This package is ESM-only (`"type": "module"`) and its `exports` map has no `"require"` condition. A
modern bundler (Vite, current TypeScript with `moduleResolution: "bundler"`/`"node16"`/`"nodenext"`)
handles this fine. An older webpack/Vue-CLI setup using `moduleResolution: "node"` (TypeScript's
classic algorithm, which doesn't read `exports` at all) resolves both the bare root specifier and
every subpath correctly as of `typesVersions`' current shape (task 16) — verified against a real
build failure, not assumed fixed: `test/packaging/legacy/` is a fixture consumer importing the root
and every documented subpath under `moduleResolution: "node"`; `npm run test:packaging` (also a CI
step) copies the built package into its own `node_modules` and runs `tsc --noEmit` against it.

**History, for anyone hitting this again**: the root specifier alone used to fail — confirmed against
a real DWC 3.6 build (resonance-lab's own dual DWC 3.6/3.7 target) — with `TS2307: ... types exist,
but this result could not be resolved under your current 'moduleResolution' setting`. The actual cause
turned out to be neither the missing `"require"` condition nor the `exports` map at all (both were
tested and ruled out directly against the fixture): `typesVersions`' own `"*": {"*": ["dist/*"]}`
wildcard also matches the ROOT specifier under classic resolution (the "subpath" being matched is
empty), rewriting it to `dist/` with no filename — which fails, shadowing the perfectly good top-level
`types`/`main` fields entirely. The fix is a **second fallback candidate** in the same wildcard entry:
`"*": ["dist/*", "dist/index.d.ts"]` — a real subpath still resolves via the first candidate; the
root specifier's empty match fails the first candidate and falls through to the second, which is
exactly `dist/index.d.ts`. No `exports` or `main`/`types` change was needed once this was understood.

## Licence

GPL-3.0-or-later.
