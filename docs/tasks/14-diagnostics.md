# 14 — Diagnostics: errors and omissions

## The gap

"Read the contents of files correctly and highlight any errors or omissions." Nothing produces
diagnostics today, and DWC's own editor shows none (no `setModelMarkers` anywhere in its source).

## Decisions

- **Every rule is cited.** A rule states the requirement it checks and where RRF or the wiki states
  it. No rule rests on "good practice" alone. Omission rules especially: only requirements the wiki
  or source actually states ("must", "Order dependency", `MustSee`, a file RRF runs that isn't there).
- **Rules are data plus a check function**, in a registry, so a consumer can list, filter and
  configure them.
- **Firmware-aware**: every rule knows which RRF versions it applies to; `diagnose*` takes the target
  firmware version (and optionally the stamped one, to add task 12's release findings).
- **Fixes are `TextEdit`s** from task 06, offered only when unambiguous.

## API

```ts
export type Severity = "error" | "warning" | "info" | "hint";
export interface Diagnostic {
	rule: string; severity: Severity; message: string;
	file: string; line: number; start: number; end: number;   // absolute offsets in the file
	fixes?: ReadonlyArray<{ title: string; edits: ReadonlyArray<TextEdit> }>;
	sources: ReadonlyArray<string>;
}
export interface RuleInfo {
	id: string; severity: Severity;
	category: "syntax" | "structure" | "dictionary" | "project" | "release" | "menu" | "data" | "objectModel";
	description: string; sources: ReadonlyArray<string>; appliesTo?: { since?: string; until?: string };
}
export const RULES: ReadonlyArray<RuleInfo>;
export interface DiagnoseOptions {
	firmwareVersion: string; stampedVersion?: string; machineMode?: MachineMode;
	rules?: { disable?: ReadonlyArray<string>; severity?: Readonly<Record<string, Severity>> };
}
export function diagnoseDocument(doc: GcodeDocument, path: string, options: DiagnoseOptions): ReadonlyArray<Diagnostic>;
export function diagnoseProject(project: Project, options: DiagnoseOptions): ReadonlyArray<Diagnostic>;
export function toMonacoMarkers(diags: ReadonlyArray<Diagnostic>, text: string): ReadonlyArray<{ severity: 1 | 2 | 4 | 8; message: string; startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number; code: string }>;
```

`toMonacoMarkers` returns plain objects shaped like Monaco's `IMarkerData` (severity values from
Monaco's `MarkerSeverity` — verify them against Monaco's API documentation); no Monaco import.

## Rules to implement (each cited when written; drop any you can't cite)

- **Syntax**: every lexer, document and expression error from tasks 05–07; a line longer than RRF's
  maximum (find the buffer size in source); checksum mismatch.
- **Structure**: task 06's structural errors; a macro-invoking command not last on its line (wiki,
  multiple commands on a line); a meta keyword written with capitals (`If`, `VAR`) — RRF doesn't treat
  it as a meta-command, so say what it does read it as.
- **Dictionary**: unknown command — **but** RRF runs `/sys/<code>.g` for an unimplemented G/M code
  (wiki, custom G-codes), so it's fine in a project with that file, and `info` (not `error`) without
  a project; unknown parameter; wrong kind; missing required; value outside `values`/`range`; command
  or parameter not available on the target firmware; deprecated (with the replacement); command not
  valid in the current machine mode.
- **Project**: reference to an undefined tool/heater/fan/sensor/axis/probe; duplicate definition;
  order dependency violated (dictionary `mustFollow`); `M98` or invoked file missing; conditional or
  dynamic references at `info`, never as errors.
- **Release**: task 12's `impactOf` findings when `stampedVersion` is given (upgrade and downgrade).
- **Menu**: unknown menu command, `menu <name>` target missing, missing required parameter, `image`
  file missing.
- **Data**: height-map load errors, exactly as RRF's loader reports them.
- **Object model**: an expression path unknown at the target firmware, or deprecated (task 11).

## Steps

1. Registry, `Diagnostic` plumbing and `toMonacoMarkers`.
2. Rules in the order above, each with a fixture that triggers it and one that doesn't.
3. `docs/diagnostics.md`, generated from `RULES` (id, severity, description, sources).

## Tests

For every rule: a positive fixture, a negative fixture and a teeth check. Snapshot the full
diagnostic list for task 13's project fixtures. Test the Monaco adapter on a multi-line CRLF document
with non-ASCII text (columns are 1-based UTF-16 units).

## Acceptance

Every rule cited and tested both ways; `docs/diagnostics.md` generated from `RULES`.

## Traps

- Don't flag what RRF accepts. When unsure whether RRF errors, warns or ignores, read the handler.
- `M98 P"{…}"` and other expression-valued references are dynamic — `info` at most.

## Out of scope

Evaluating expressions; checking against a live machine's object model.
