import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { lexLine } from "../src/lex.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "corpus", "slicer");

/**
 * Every real-slicer line this package has on hand (Cura, PrusaSlicer, OrcaSlicer, plus hand-built
 * arc/multi-tool fixtures — see `test/corpus/slicer/README.md`) must lex with zero errors and with
 * spans that stay inside the line and never overlap. Nothing in these fixtures is expected to be
 * malformed; if one ever needs to be, list it here with the reason instead of silencing the check.
 */
const KNOWN_BAD_LINES: ReadonlySet<string> = new Set([]);

describe("real slicer output lexes cleanly", () => {
	const files = readdirSync(root).filter((f) => f.endsWith(".gcode"));
	it("found the fixture files", () => {
		expect(files.length).toBeGreaterThan(0);
	});

	for (const file of files) {
		it(`${file}: every line lexes with no errors and well-formed spans`, () => {
			const text = readFileSync(join(root, file), "utf-8");
			const lines = text.split(/\r\n|\n/);
			for (const [idx, raw] of lines.entries()) {
				const key = `${file}:${idx + 1}`;
				if (KNOWN_BAD_LINES.has(key)) continue;
				const line = lexLine(raw);
				expect(line.errors, `${key}: ${JSON.stringify(raw)}`).toEqual([]);
				for (const cmd of line.commands) {
					expect(cmd.start, key).toBeGreaterThanOrEqual(0);
					expect(cmd.end, key).toBeLessThanOrEqual(raw.length);
					expect(cmd.start, key).toBeLessThanOrEqual(cmd.end);
					let prevEnd = cmd.start;
					for (const p of cmd.params) {
						expect(p.start, key).toBeGreaterThanOrEqual(prevEnd);
						expect(p.valueStart, key).toBeGreaterThanOrEqual(p.start);
						expect(p.end, key).toBeGreaterThanOrEqual(p.valueStart);
						expect(p.end, key).toBeLessThanOrEqual(raw.length);
						prevEnd = p.end;
					}
				}
				if (line.comment) {
					expect(line.comment.start, key).toBeGreaterThanOrEqual(0);
					expect(line.comment.end, key).toBe(raw.length);
				}
			}
		});
	}
});
