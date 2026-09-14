import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { tokenise } from "../src/lex.js";

// One code per line RRF's dictionary documents, extracted from `@duet3d/monacotokens` at
// RRF_BASELINE (see rrf.ts). Not a runtime dependency of this package — see the README next to this
// file for how to refresh it when the baseline moves.
const codes = JSON.parse(readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "corpus/rrf-command-codes.json"), "utf-8",
)) as Array<string>;

// This is what "covers every G/M/T command" means in practice, per the plan
// (duet-gcode-postprocessor/docs/gcode-core-plan.md, Decisions #4): every command the dictionary
// documents must tokenise as a command, with the right letter and number - not fall through to
// `code: null` the way a real command never should. This is the test that caught the "T" gap
// (bare T, "report the current tool", used to read as "not a command" here) before it shipped.
describe("every RRF command code tokenises as a command", () => {
	it.each(codes)("%s", (code) => {
		const token = tokenise(code);
		expect(token.code, `tokenise(${JSON.stringify(code)}).code`).not.toBeNull();
		expect(token.letter).toBe(code[0]);
		if (code.length > 1) {
			// The dictionary's own code string round-trips through Number for every non-bare entry
			// ("G38.2" -> 38.2); "T" is the one bare entry and is asserted separately below.
			expect(token.number).toBe(Number(code.slice(1)));
		}
	});

	it("still recognises the codes when given real parameters, not just the bare code", () => {
		for (const code of codes) {
			const line = code.length > 1 ? `${code} X1 Y2 S3` : `${code} P1`;
			const token = tokenise(line);
			expect(token.code, line).not.toBeNull();
		}
	});
});
