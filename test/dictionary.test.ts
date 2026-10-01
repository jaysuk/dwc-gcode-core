import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { COMMANDS, commandSpec } from "../src/dictionary/commands.js";
import type { ParamKind } from "../src/dictionary/schema.js";
import { lexLine, STRING_ARGUMENT_COMMANDS, tokenise } from "../src/lex.js";
import { RELEASES } from "../src/releases/releases.js";
import { compareFirmwareVersions } from "../src/versionCompare.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

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

// --- The command dictionary itself (task 10, docs/tasks/10-dictionary.md) ------------------------

const VALID_KINDS: ReadonlySet<ParamKind> = new Set([
	"number", "integer", "unsigned", "boolean01", "string", "driverId", "pin",
	"axisLetters", "toolNumber", "heaterNumber", "fanNumber", "sensorNumber", "probeNumber",
	"bitmap", "filename", "any",
]);

describe("COMMANDS schema validation", () => {
	const entries = Object.entries(COMMANDS);

	it("has entries", () => {
		expect(entries.length).toBeGreaterThan(0);
	});

	it.each(entries)("%s: required fields, non-empty sources, valid parameter kinds", (code, spec) => {
		expect(spec.code).toBe(code);
		expect(spec.summary.length, `${code}.summary`).toBeGreaterThan(0);
		expect(Array.isArray(spec.parameters), `${code}.parameters`).toBe(true);
		expect(spec.sources.length, `${code}.sources`).toBeGreaterThan(0);
		for (const param of spec.parameters) {
			expect(VALID_KINDS.has(param.kind), `${code}.${param.letter}.kind = ${param.kind}`).toBe(true);
			expect(param.sources.length, `${code}.${param.letter}.sources`).toBeGreaterThan(0);
		}
		if (spec.axisParameters) {
			expect(VALID_KINDS.has(spec.axisParameters.kind), `${code}.axisParameters.kind`).toBe(true);
		}
	});

	it("every reviewed entry cites real RRF source, not just the draft bootstrap", () => {
		for (const [code, spec] of entries) {
			if (spec.reviewed === undefined) continue;
			const hasRealCitation = spec.sources.some((s) => !s.includes("(draft, unreviewed"));
			expect(hasRealCitation, `${code}.sources = ${JSON.stringify(spec.sources)}`).toBe(true);
		}
	});

	it("commandSpec() looks codes up case-insensitively and returns null for the unknown", () => {
		expect(commandSpec("g1")?.code).toBe("G1");
		expect(commandSpec("M104")?.code).toBe("M104");
		expect(commandSpec("M99999")).toBeNull();
	});
});

describe("tier 1 is fully reviewed (docs/tasks/10-dictionary.md step 2)", () => {
	// The exact list from the task file, plus every command test/corpus/slicer fixtures actually use.
	const TIER_1 = (
		"G0 G1 G2 G3 G4 G10 G28 G29 G30 G31 G32 G90 G91 G92 " +
		"M0 M1 M24 M25 M82 M83 M84 M98 M99 M104 M106 M107 M109 M116 M117 M140 M143 M190 " +
		"M201 M203 M204 M205 M207 M208 M220 M221 M291 M292 M302 M307 M308 M350 M400 " +
		"M451 M452 M453 M486 M500 M501 M502 M540 M550 M551 M552 M553 M554 M557 M558 " +
		"M563 M566 M567 M568 M569 M572 M574 M575 M584 M586 M587 M588 M589 M593 M600 " +
		"M701 M702 M703 M906 M918 M950 M955 M956 T"
	).split(" ");

	it.each(TIER_1)("%s is reviewed", (code) => {
		const spec = commandSpec(code);
		expect(spec, `${code} has no dictionary entry at all`).not.toBeNull();
		expect(spec!.reviewed, `${code}.reviewed`).toBeDefined();
	});

	const slicerRoot = join(ROOT, "test", "corpus", "slicer");
	const codesUsedInCorpus = new Set<string>();
	for (const file of readdirSync(slicerRoot).filter((f) => f.endsWith(".gcode"))) {
		const text = readFileSync(join(slicerRoot, file), "utf-8");
		for (const raw of text.split(/\r\n|\n/)) {
			for (const cmd of lexLine(raw).commands) {
				codesUsedInCorpus.add(cmd.code);
			}
		}
	}

	it.each([...codesUsedInCorpus])("%s (used in test/corpus/slicer) is reviewed", (code) => {
		const spec = commandSpec(code);
		expect(spec, `${code} has no dictionary entry at all`).not.toBeNull();
		expect(spec!.reviewed, `${code}.reviewed`).toBeDefined();
	});
});

describe("coverage does not regress", () => {
	// `dictionary/coverage.json` is committed alongside `dictionary/commands.json`/`draft/*.json` -
	// this asserts the generated dictionary (`src/dictionary/commands.ts`, built from those inputs)
	// never reports FEWER reviewed or total entries than the last commit recorded, which would mean
	// either a reviewed entry lost its `reviewed` field or a draft was deleted without being replaced.
	const committed = JSON.parse(
		readFileSync(join(ROOT, "dictionary", "coverage.json"), "utf-8"),
	) as { total: number; reviewed: number; draftOnly: number; versionHistory: { total: number; checked: number } };

	const liveReviewed = Object.values(COMMANDS).filter((s) => s.reviewed !== undefined).length;
	const liveTotal = Object.keys(COMMANDS).length;

	it("total commands known has not decreased", () => {
		expect(liveTotal).toBeGreaterThanOrEqual(committed.total);
	});

	it("reviewed commands has not decreased", () => {
		expect(liveReviewed).toBeGreaterThanOrEqual(committed.reviewed);
	});

	it("committed coverage.json matches its own arithmetic", () => {
		expect(committed.reviewed + committed.draftOnly).toBe(committed.total);
	});

	it("commands with a confirmed version history has not decreased (raise HISTORY_CHECKED_FLOOR as batches land; the end state is every command)", () => {
		const live = Object.values(COMMANDS).filter((s) => s.historyChecked !== undefined).length;
		expect(live).toBeGreaterThanOrEqual(committed.versionHistory.checked);
		expect(live).toBeGreaterThanOrEqual(HISTORY_CHECKED_FLOOR);
		expect(committed.versionHistory.total).toBe(committed.total);
	});
});

// The count of `historyChecked` commands the last commit reached; a batch that confirms more raises it.
const HISTORY_CHECKED_FLOOR = 282; // every command: the last 24 (kinematics M665/M666/M669, the hand-read handlers G0-G3/G68/M109/M122/M150/M309/M567/M568/M571/M585/M675, M569.2/M569.9 and the no-dispatch M573/M650/M651/M900/T) were read at all 18 builds; before that 258: M73 (ProcessM73 hashed at all 18 builds); M576.1 entered (since alpha.4, RRF a919948d3); the rest of the fractional families: M260.1-.4/M261.1-.2 (S/B/V added, the same letter reads at all 18 builds), G38.2-.5, G59.1-.3, M201.1, M505.1, M586.4, M36.1/.2, M970/.1/.2 and M970.3 (new in 3.7.0-rc.1, RRF 6544cc727; S/J/O added); before that: M569.1/.3-.8 (CANlib's tables and Duet3Expansion's parsers, both cloned, read at 3.6.3 and rc.1/rc.2: M569.1 B since rc.1, M569.4 V, M569.3 S and its Hangprinter-only summary); earlier: batches 1-3: config-time, homing/macro, then the remainder that passed both history signals (docs/dictionary-param-history/); +M25 P, M260/M261 V, M673 S, M36/M588/M600/M601/M997 settled by hand; fractional codes one family at a time (M558.1-.4 read per fraction, identical letters at all 7 releases, .4 since beta.3; M581/M581.1 - M581.1 since alpha.2, R added; M587.1/.2 via a per-release hash of HandleWiFiCode)

describe("since / until / historyChecked are well-formed (E8)", () => {
	const newest = RELEASES[RELEASES.length - 1]!.version;
	const oldest = RELEASES[0]!.version;
	const tracked = (v: string): boolean => RELEASES.some((r) => r.version === v);
	const holders: Array<[string, { since?: string; until?: string }]> = [];
	for (const [code, spec] of Object.entries(COMMANDS)) {
		holders.push([code, spec]);
		for (const p of spec.parameters) holders.push([`${code} ${p.letter}`, p]);
	}

	it("every since/until is a tracked release, since is after the oldest, until before the newest, and since <= until", () => {
		for (const [what, h] of holders) {
			if (h.since !== undefined) {
				expect(tracked(h.since), `${what} since ${h.since}`).toBe(true);
				expect(compareFirmwareVersions(h.since, oldest), `${what} since must be after ${oldest} (an omitted since means present there)`).toBeGreaterThan(0);
			}
			if (h.until !== undefined) {
				expect(tracked(h.until), `${what} until ${h.until}`).toBe(true);
				expect(compareFirmwareVersions(h.until, newest), `${what} until must be before ${newest} (until is the LAST release that has it)`).toBeLessThan(0);
				if (h.since !== undefined) expect(compareFirmwareVersions(h.since, h.until), `${what} since <= until`).toBeLessThanOrEqual(0);
			}
		}
	});

	it("historyChecked names a tracked release", () => {
		for (const [code, spec] of Object.entries(COMMANDS)) {
			if (spec.historyChecked !== undefined) expect(tracked(spec.historyChecked), code).toBe(true);
		}
	});
});

describe("STRING_ARGUMENT_COMMANDS stays in step with the generator's own copy", () => {
	// scripts/build-dictionary.mjs hand-maintains STRING_ARGUMENT_CODES as a 7-entry constant instead
	// of importing lex.ts (a generator script depending on the library it generates data for would be
	// a build-order inversion) - this is the test that keeps the two lists from drifting apart.
	const GENERATOR_STRING_ARGUMENT_CODES = new Set(["M23", "M28", "M30", "M32", "M36", "M38", "M117"]);

	it("matches lex.ts's STRING_ARGUMENT_COMMANDS exactly", () => {
		expect([...GENERATOR_STRING_ARGUMENT_CODES].sort()).toEqual([...STRING_ARGUMENT_COMMANDS].sort());
	});

	it("every dictionary entry marked stringArgument: true is in STRING_ARGUMENT_COMMANDS", () => {
		for (const [code, spec] of Object.entries(COMMANDS)) {
			if (spec.stringArgument) {
				expect(STRING_ARGUMENT_COMMANDS.has(code), code).toBe(true);
			}
		}
	});
});

/**
 * Real-usage validation, standing in for "every wiki example line validates against its own
 * section's spec" (docs/tasks/10-dictionary.md's Tests section): the wiki example corpus itself
 * isn't vendored into this repo, so this checks every reviewed command's parameters against the
 * same real-slicer-output fixtures `corpus.test.ts` already lexes (`test/corpus/slicer/*.gcode`).
 * A letter a real file uses that the dictionary doesn't know about is exactly the kind of gap this
 * test exists to catch - either the dictionary is wrong (fix it) or the usage is genuinely odd
 * (add it to KNOWN_BAD_EXAMPLES with a reason, matching corpus.test.ts's own escape-hatch pattern).
 */
describe("reviewed dictionary entries accept the parameters real slicer output uses", () => {
	const KNOWN_BAD_EXAMPLES: ReadonlySet<string> = new Set([]);

	const slicerRoot = join(ROOT, "test", "corpus", "slicer");
	const files = readdirSync(slicerRoot).filter((f) => f.endsWith(".gcode"));

	for (const file of files) {
		it(`${file}: every parameter letter on a reviewed command is known to its spec`, () => {
			const text = readFileSync(join(slicerRoot, file), "utf-8");
			const lines = text.split(/\r\n|\n/);
			for (const [idx, raw] of lines.entries()) {
				const key = `${file}:${idx + 1}`;
				if (KNOWN_BAD_EXAMPLES.has(key)) continue;
				for (const cmd of lexLine(raw).commands) {
					const spec = commandSpec(cmd.code);
					if (spec === null || spec.reviewed === undefined) continue; // draft-only: not this test's job
					if (spec.stringArgument) continue; // whole remainder is a string, not letter parameters
					const knownLetters = new Set(spec.parameters.map((p) => p.letter));
					const hasAxisCatchAll = spec.axisParameters !== undefined;
					for (const param of cmd.params) {
						const letter = param.letter.toUpperCase();
						const known = knownLetters.has(letter) || (hasAxisCatchAll && /^[A-Z]$/.test(letter));
						expect(known, `${key}: ${cmd.code} ${letter} — ${JSON.stringify(raw)}`).toBe(true);
					}
				}
			}
		});
	}
});
