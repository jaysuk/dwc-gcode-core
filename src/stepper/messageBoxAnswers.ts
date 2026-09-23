/**
 * The caller-facing side of simulating a blocking `M291` message box — `walkExecution` (`../execute.js`)
 * pauses at one via `UnresolvedMessageBoxError`; this module is the map of "what would I click/type/
 * choose here" answers a caller has supplied, and the `resolveMessageBox` callback `executionIndex.ts`
 * wires to `walkExecution`, backed by that map.
 *
 * Keyed by the prompt's own CONTENT (`messageBoxKey`), not by line number — `walkExecution`'s
 * `resolveMessageBox` only receives the parsed prompt, not which line triggered it, and content-based
 * identity is the same philosophy `simulatedValues.ts`'s object-model-path overrides already use (two
 * occurrences that ask the exact same question share one remembered answer).
 *
 * Extracted from `duet-gcode-postprocessor`'s own `model/gcode/messageBoxAnswers.ts` (task: shared
 * stepper) — only the pure resolver logic moved here; that module's own `localStorage`-backed
 * persistence stays host-side (this package takes zero runtime dependencies, `localStorage` included),
 * each host free to persist the resulting `MessageBoxAnswerOverrides` however it already does.
 */

import { UnresolvedMessageBoxError } from "../execute.js";
import type { MessageBoxAnswer, MessageBoxPrompt } from "../execute.js";

export type MessageBoxAnswerOverrides = ReadonlyMap<string, MessageBoxAnswer>;

/** A stable content key for a prompt — two prompts that ask the exact same question (same mode,
 *  message, title and limits) get the same key, so an earlier answer to one is reused for the other. */
export function messageBoxKey(prompt: MessageBoxPrompt): string {
	return JSON.stringify(prompt);
}

/** Builds a `walkExecution`-compatible `resolveMessageBox`: answers from `overrides` when this exact
 *  prompt has a remembered answer, otherwise throws `UnresolvedMessageBoxError` so the walk pauses
 *  there and the caller can prompt for one. */
export function createMessageBoxResolver(overrides: MessageBoxAnswerOverrides): (prompt: MessageBoxPrompt) => MessageBoxAnswer {
	return (prompt) => {
		const answer = overrides.get(messageBoxKey(prompt));
		if (answer === undefined) throw new UnresolvedMessageBoxError();
		return answer;
	};
}
