# 15 — Compare: semantic diff of files and projects

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
