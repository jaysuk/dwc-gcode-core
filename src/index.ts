export * from "./lex.js";
export * from "./params.js";
export * from "./commands/g10.js";
export * from "./commands/toolParams.js";
export * from "./rrf.js";

// `edit.ts` is deliberately NOT re-exported here: its own `setParam` (rewrites one parameter on a
// full raw LINE, colon-list aware, comment-preserving) is a different function with the same name
// as `params.ts`'s (rewrites a parameter on an already-tokenised command BODY) - a wildcard
// re-export of both would be an ambiguous, silently-broken barrel. Import config-file editing from
// the `dwc-gcode-core/edit` subpath instead.
