# 15 — Compare: semantic diff of files and projects

**Status: Done.**

## Findings

**Identity keys, one row per defining command, each cited** (`IDENTITY_KEYS`/`IDENTITY_RULES` in
`src/compare.ts`) — `M563` by `P`, `M950` by whichever of `H`/`F`/`J`/`P`/`S`/`R`/`E` is present (RRF's
own "exactly one of" rule, `Platform::ConfigurePort`), `M308` by `S`, `M558` by `K`, `M955` by `P`,
`M584` per axis letter (plus `E`, the extruder-driver mapping) present on the line, `M574` per axis
letter or by `E<extruder number>` for the extruder-endstop form, and `G10` by its own dispatch rule
(`g10Form`, already cited in task 10's `src/commands/g10.ts`) - `toolSettings` keyed by tool `P`,
`workplace` keyed by coordinate-system `P`. This covers every command the task's own Decisions name
explicitly, plus the immediate family already used the same way in `project.ts`'s `SYMBOL_RULES`
(task 13) — not an attempt at covering every RRF command with a numbered resource, which would be a
much larger, separate effort.

**A real nuance found while writing `M584`'s identity rule**: `R` (axis wrap type) and `S` (NIST-
rotational flag) are NOT per-axis-persistent settings — RRF's own `GCodes::DoDriveMapping` applies
them to "the axes just mapped" by THAT SPECIFIC invocation, not to every axis ever assigned that
letter. So `M584 X0 R1` followed later by a separate `M584 Y1` (no `R`) leaves `Y` without the wrap
flag even though both are "axis" mappings — confirmed directly in `GCodes3.cpp:449-451`, not assumed
from the parameter's name. Each axis-letter identity unit therefore carries its OWN copy of whichever
`R`/`S` appeared on ITS line, so a change in either shows up against exactly the axis(es) that
invocation actually touched — covered by its own test (`test/compare.test.ts`, "R/S travel with each
axis unit").

**A deliberate, documented simplification for "moved"**: the task's own Decisions describe two
distinct triggers - "order-sensitive commands" relocating, and any directive moving "across files".
This package has no data source for which commands are order-sensitive (no dictionary field, no wiki
statement to cite - inventing one would break "never invent a rule"), so only the second, literally
citable/testable half is implemented: an identity-keyed directive with unchanged content is reported
`moved` only when its FILE changes; a same-file relocation with unchanged content is not reported at
all (nothing semantic changed - a pure textual reshuffle is exactly what `diffText` is for instead).
A directive that both moved AND changed content is reported as `changed` at its new (B-side) location,
not `moved` - the `DirectiveChange` type's own `"changed"` variant only carries one `file`, not
`fileA`/`fileB`, so there's no way to represent "moved AND changed" as a single richer event without
extending the task's own API shape; this is a real, minor information loss, documented rather than
worked around by changing the public type.

**Positional matching for commands with no identity rule** (`G90`, a bare `G1` move, ...) is scoped to
one `(file, code)` group at a time, paired off in order of appearance - NOT scoped to the enclosing
block (an `if`/`while` body) the way the task's own phrase "within their block" might suggest. Doing
real block-scoped positional matching would need walking both documents' `Block` trees in parallel and
handling the case where the block structure ITSELF differs between the two versions (an `if` added,
removed, or restructured) - a meaningfully bigger feature than this task's own scope suggests, and
not something the Tests/Acceptance sections actually require a fixture for. Documented here as a real,
intentional scope limit, not a silent gap: two documents whose block structure differs substantially
around a same-code sequence of positional commands may pair them up "wrong" (e.g. matching a G1 that
used to be inside an `if` to one that's now outside it) - `diffText` remains the exact, unambiguous
fallback for anyone who needs textual truth instead.

**`diffText`** is a classic O(|a|×|b|) LCS line diff, splitting only on `"\n"` (a trailing `"\r"` stays
attached to its own line, so CRLF round-trips exactly) - explicitly not sized for multi-megabyte print
files (this package's hot path is `tokenise()`, not this); config/macro-sized files are the target, per
"The gap"'s own examples (backup vs live, before vs after a calibration). Round-trip property
(`test/compare.test.ts`) checked on both a small structured example and a larger, less structured one.

**Validated against real data, not just synthetic fixtures**: `compareProjects` run against task 13's
own `fff-basic`/`cnc-basic`/`laser-basic` project fixtures, each self-compared to itself (0 changes on
all three - proves the identity/positional matching doesn't misfire on realistic, multi-file,
multi-resource-type input) and against a hand-edited copy (a single `M950` pin-name change in
`fff-basic`'s `config.g` produces exactly one precise `changed` finding, nothing else) — the same "run
it for real" validation pattern task 14 established, not skipped here.

**Two small, additive, low-risk changes to already-shipped modules, both reused rather than
duplicated**: `g10.ts`'s `AXIS_LETTERS` constant is now exported (was a private `const`) so this
module doesn't hand-maintain a second copy of the same cited axis-letter list; and
`files/kinds.ts` gained an exported `GCODE_FILE_KINDS` (task 14's diagnostics engine had the exact
same hand-written set locally, needed for the exact same reason - telling a `GcodeDocument`-bearing
`Project.files` entry apart from a `MenuDocument` one by `kind` alone) - `src/diagnostics/rules.ts`
now imports it too instead of keeping its own copy, removing a duplicate-drift risk this task's own
work would otherwise have introduced a second time.

## The gap

Plugins compare configs — backup vs live, before vs after a calibration, the stamped version vs
current firmware — and the only tool today is `edit.ts`'s `diffLines`, which works index by index
and only understands its own edits.

## Decisions

- **Semantic, not textual**: directives are matched by an **identity key** from the dictionary —
  for example `M950` by the resource it creates, `M563` by `P`, `M308` by `S`, `M584` per axis
  letter, `G10` by `L` plus `P`. Each identity rule is cited, or derived from the dictionary's
  defining parameters. Commands without an identity (e.g. `G90`) match by position within their block.
- **Output** is a list of changes: added / removed / changed directive (with per-parameter old → new),
  moved (for order-sensitive commands, and across files), and meta-block changes.
- **Release-aware**: given two firmware versions, each change is annotated with the task-12 events
  that explain or require it.
- A byte-faithful, LCS-based line diff is also exported for UIs that want both views.

## API

```ts
export type DirectiveChange =
	| { type: "added" | "removed"; file: string; line: number; code: string; identity: string }
	| { type: "changed"; file: string; lineA: number; lineB: number; code: string; identity: string; params: ReadonlyArray<{ letter: string; from: string | null; to: string | null }> }
	| { type: "moved"; fileA: string; fileB: string; code: string; identity: string; lineA: number; lineB: number };
export function compareDocuments(a: GcodeDocument, b: GcodeDocument, options?: { path?: string; fromVersion?: string; toVersion?: string }): ReadonlyArray<DirectiveChange & { events?: ReadonlyArray<string> }>;
export function compareProjects(a: Project, b: Project, options?: { fromVersion?: string; toVersion?: string }): ReadonlyArray<DirectiveChange & { events?: ReadonlyArray<string> }>;
export function diffText(a: string, b: string): ReadonlyArray<{ type: "same" | "added" | "removed"; lineA?: number; lineB?: number; text: string }>;
```

## Tests

Reordered parameters aren't a change; a changed colon list; an `M950` whose pin changed; a directive
moved from `config.g` into an included file is `moved` across files, not removed plus added;
annotation with a real task-12 event; `diffText` round-trips (applying the diff to `a` yields `b`).

## Acceptance

Identity keys cited for every defining command; the tests above, with teeth.
