export * from "./lex.js";
export * from "./params.js";
export * from "./meta.js";
export * from "./document.js";
export * from "./expr/parse.js";
export * from "./expr/tables.js";
export * from "./files/kinds.js";
export * from "./files/menu.js";
export * from "./files/heightmap.js";
export * from "./firmware.js";
export * from "./commands/g10.js";
export * from "./commands/toolParams.js";
export * from "./rrf.js";
export * from "./version.js";
export * from "./stamp.js";

// `edit.ts` is deliberately NOT re-exported here: its own `setParam` (rewrites one parameter on a
// full raw LINE, colon-list aware, comment-preserving) is a different function with the same name
// as `params.ts`'s (rewrites a parameter on an already-tokenised command BODY) - a wildcard
// re-export of both would be an ambiguous, silently-broken barrel. Import config-file editing from
// the `dwc-gcode-core/edit` subpath instead.

// `dictionary/*` (task 10) is deliberately NOT re-exported here either: `dictionary/schema.ts`'s
// `ParamKind` (the command dictionary's parameter-kind enum - "number" | "integer" | "unsigned" |
// ...) is a different type with the same name as this file's own `lex.ts`'s `ParamKind` (a lexed
// parameter's syntactic shape - "empty" | "number" | "list" | ...). Import the command dictionary
// from the `dwc-gcode-core/dictionary/commands` and `dwc-gcode-core/dictionary/schema` subpaths.
