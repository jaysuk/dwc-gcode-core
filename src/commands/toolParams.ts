/**
 * Which commands' `P` parameter is a real tool number — the table a tool-renumbering pass needs so
 * it rewrites `M568 P0` but never `M106 P0`.
 */

import { g10Form } from "./g10.js";

export interface ToolParamCommand {
	command: string;
	param: string;
	/** When present, the parameter is a tool number only for a line this accepts. */
	when?: (body: string) => boolean;
}

/**
 * Commands whose `P` parameter is a real tool number — verified command-by-command against
 * `Duet3D/wiki-content`'s G-code dictionary (`User_manual/Reference/Gcodes.md`) and RRF 3.7.0-rc.1
 * source (`src/GCodes/GCodes2.cpp`), never guessed from a pattern like "P after an M-code is a tool":
 *
 * - `M563 P` — "Tool number (0 to 49 in RRF 3.x)", defines/redefines a tool.
 * - `M567 P` — "Tool number. If this parameter is not provided, the current tool is used" (mix ratios).
 * - `M568 P` — "Tool number. If this parameter is not provided, the current tool is used" (settings).
 * - `M116 P` — "Tool number... waits for temperatures associated with that tool"; plausible in a
 *   sliced file around a tool change, unlike the config.g-only commands excluded below. From RRF
 *   3.7.0-beta.3 `P` may be a colon list (`P0:1`), and `P` with no value waits for every tool
 *   (`case 116` reads it with `GetUnsignedArray`). A rewrite must therefore leave a valueless `P`
 *   alone — it is not tool 0 — and a single-number rewrite does not cover the list form.
 * - `G10 P` — **only in its tool-settings form**, the one entry here that needs `when`. `G10` means
 *   three things: tool settings (`G10 P<n> S… R…` temperatures, `G10 [L1] P<n> X Y Z` offsets — `P`
 *   is a tool), a workplace coordinate origin (`G10 L2`/`L20 P<n>` — `P` is a coordinate system
 *   number, **not** a tool), and a bare firmware retraction (no `P` at all). `g10Form`
 *   (`commands/g10.ts`) tells them apart by RepRapFirmware's own dispatch rule, which is what makes
 *   this safe to include.
 *
 * Deliberately **not** included:
 *
 * - `M106` — `P` is a **fan index**, not a tool. This is the exact regression this allow-list exists
 *   to prevent: a find-and-replace or a heuristic rewrite would silently redirect part cooling on a
 *   file that also renumbers tools, with no error anywhere.
 * - `M107` — takes no parameters at all in RRF: `case 107` calls `SetMappedFanSpeed(0)`, which turns
 *   off the current tool's print-cooling fans (fan 0 when no tool is selected). A `P` on it is
 *   ignored, so there is nothing to renumber.
 * - `M585` — `P` is a **Z probe number**, not a tool.
 * - `M207` (per-tool retraction) and `M309` (per-tool heater feedforward) — both are config.g-only
 *   tuning commands that do not appear in a slicer's own G-code output, excluded on realistic scope
 *   rather than on ambiguity.
 */
export const TOOL_PARAM_COMMANDS: ReadonlyArray<ToolParamCommand> = [
	{ command: "M563", param: "P" },
	{ command: "M567", param: "P" },
	{ command: "M568", param: "P" },
	{ command: "M116", param: "P" },
	{ command: "G10", param: "P", when: (body) => g10Form(body) === "toolSettings" },
];
