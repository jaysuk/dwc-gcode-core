/**
 * Which commands' parameters are a real tool number — the table a tool-renumbering pass needs so
 * it rewrites `M568 P0` but never `M106 P0`.
 *
 * Derived from the command dictionary (task 10, `docs/tasks/10-dictionary.md` step 4): every
 * **reviewed** entry's parameter of kind `toolNumber` becomes a row here automatically. Only
 * reviewed entries are considered — a draft entry's `kind` is a monacotokens-description heuristic
 * (`scripts/build-dictionary.mjs`'s `inferKind`), not something read from RRF source, so it isn't
 * trustworthy enough to drive a rewrite.
 *
 * `G10` is the one command the dictionary alone cannot resolve: its `P` is a tool number in its
 * tool-settings form only, a workplace-coordinate-system number in its `L2`/`L20` form, and absent
 * entirely in its bare-retraction form — a per-line fact about which *form* is in play, not a fact
 * about the parameter's kind. `g10Form` (`commands/g10.ts`) is RRF's own dispatch rule for telling
 * the forms apart, so it is layered on top of the derived row as a `when` guard rather than folded
 * into the dictionary schema.
 */

import { COMMANDS } from "../dictionary/commands.js";
import { g10Form } from "./g10.js";

export interface ToolParamCommand {
	command: string;
	param: string;
	/** When present, the parameter is a tool number only for a line this accepts. */
	when?: (body: string) => boolean;
}

function derivedToolParamCommands(): Array<ToolParamCommand> {
	const rows: Array<ToolParamCommand> = [];
	for (const spec of Object.values(COMMANDS)) {
		if (spec.reviewed == null) {
			continue;
		}
		for (const param of spec.parameters) {
			if (param.kind === "toolNumber") {
				rows.push({ command: spec.code, param: param.letter });
			}
		}
	}
	return rows;
}

/**
 * Commands whose parameter is a real tool number, verified against RRF 3.7.0-rc.1 source and cited
 * in `dictionary/commands.json` (see each entry's own `sources`). `G10`'s `P` needs the extra `when`
 * guard described above; every other row is exactly what the dictionary's reviewed `toolNumber`
 * parameters say.
 */
export const TOOL_PARAM_COMMANDS: ReadonlyArray<ToolParamCommand> = derivedToolParamCommands().map((row) =>
	row.command === "G10" ? { ...row, when: (body: string) => g10Form(body) === "toolSettings" } : row,
);
