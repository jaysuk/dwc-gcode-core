#!/usr/bin/env node
/**
 * Builds `src/dictionary/commands.ts` (the exported `COMMANDS` record) and `dictionary/
 * coverage.json` from two inputs:
 *  - `dictionary/commands.json` — the REVIEWED entries this repo hand-maintains, each cited to RRF
 *    source (task 10, `docs/tasks/10-dictionary.md`). Plain JSON, not JSONC: this package's own
 *    citation fields (`sources`, `reviewed`) already carry what a free-text comment would, without
 *    needing a hand-rolled JSONC parser for a repo that otherwise has none.
 *  - `dictionary/draft/<code>.json` — auto-bootstrapped, unreviewed entries for every command this
 *    repo hasn't read RRF source for yet (`--bootstrap` regenerates these from
 *    `@duet3d/monacotokens`'s `gcodes.json`; never overwrites a code that's been promoted to
 *    `commands.json`).
 *
 * A code present in `commands.json` always wins over its own draft.
 *
 *   node scripts/build-dictionary.mjs --bootstrap [--tag 3.7.0-rc.1]   # (re)writes dictionary/draft/*.json
 *   node scripts/build-dictionary.mjs                                  # builds src/dictionary/commands.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DRAFT_DIR = join(ROOT, "dictionary", "draft");
const REVIEWED_FILE = join(ROOT, "dictionary", "commands.json");
const OUT_TS = join(ROOT, "src", "dictionary", "commands.ts");
const COVERAGE_FILE = join(ROOT, "dictionary", "coverage.json");

// Kept in step with `STRING_ARGUMENT_COMMANDS` in `src/lex.ts` by hand (both cited to the same RRF
// source; `test/dictionary.test.ts` asserts the two stay identical) rather than one being generated
// from the other - avoids a build-order dependency between the hand-written lexer and this
// generated dictionary for a 7-entry constant that essentially never changes.
const STRING_ARGUMENT_CODES = new Set(["M23", "M28", "M30", "M32", "M36", "M38", "M117"]);

function inferKind(param) {
	const desc = (param.description ?? "").toLowerCase();
	if (param.values && param.values.length > 0) {
		const allNonNegativeInts = param.values.every((v) => /^\d+$/.test(String(v.value).trim()));
		return allNonNegativeInts ? "unsigned" : "integer";
	}
	if (/\bdriver\b/.test(desc)) return "driverId";
	if (/\bpin\b/.test(desc)) return "pin";
	if (/\bfile ?name\b|\bfile path\b|\bdirectory\b/.test(desc)) return "filename";
	if (/\btool number\b|\btool to\b/.test(desc)) return "toolNumber";
	if (/\bheater number\b|\bheater to\b/.test(desc)) return "heaterNumber";
	if (/\bfan number\b/.test(desc)) return "fanNumber";
	if (/\bsensor number\b/.test(desc)) return "sensorNumber";
	if (/\bprobe number\b/.test(desc)) return "probeNumber";
	if (/\b0 or 1\b|\bboolean\b/.test(desc)) return "boolean01";
	if (/"[^"]|'text'|\bmessage\b|\bstring\b|\bname\b/.test(desc)) return "string";
	if (/\bmm\b|\bmm\/|degrees|percent|%|\bseconds\b|\bvalue\b|\bfactor\b|\bfeedrate\b|\btemperature\b/.test(desc)) return "number";
	return "any";
}

function draftFromMonacotokens(entry) {
	const code = entry.code;
	const parameters = (entry.parameters ?? []).map((p) => ({
		letter: p.letter,
		description: p.description ?? "",
		kind: inferKind(p),
		list: false,
		expressionAllowed: true,
		...(p.values ? { values: p.values.map((v) => ({ value: Array.isArray(v.value) ? v.value.join("|") : String(v.value), description: v.description ?? "" })) } : {}),
		sources: ["@duet3d/monacotokens (draft, unreviewed)"],
	}));
	const spec = {
		code,
		summary: entry.summary ?? "",
		...(STRING_ARGUMENT_CODES.has(code) ? { stringArgument: true } : {}),
		parameters,
		...(entry.axisParameter ? { axisParameters: { kind: "number", list: false, description: entry.axisParameter.description ?? "" } } : {}),
		...(entry.deprecated ? { deprecated: { source: "@duet3d/monacotokens (draft, unreviewed)" } } : {}),
		sources: ["@duet3d/monacotokens@3.7.0-rc.1 (draft, unreviewed - see docs/tasks/10-dictionary.md)"],
	};
	return spec;
}

async function bootstrap() {
	const tmp = mkdtempSync(join(tmpdir(), "dwc-gcode-core-dict-"));
	try {
		execFileSync("npm", ["pack", "@duet3d/monacotokens@3.7.0-rc.1", "--silent"], { cwd: tmp, stdio: "inherit", shell: true });
		const tarball = readdirSync(tmp).find((f) => f.endsWith(".tgz"));
		execFileSync("tar", ["xzf", tarball], { cwd: tmp });
		const gcodesPath = join(tmp, "package", "dist", "gcodes", "gcodes.json");
		const entries = JSON.parse(readFileSync(gcodesPath, "utf-8"));

		mkdirSync(DRAFT_DIR, { recursive: true });
		let written = 0;
		for (const entry of entries) {
			const draft = draftFromMonacotokens(entry);
			writeFileSync(join(DRAFT_DIR, `${entry.code}.json`), JSON.stringify(draft, null, "\t") + "\n");
			written++;
		}
		console.log(`Wrote ${written} draft entries to ${DRAFT_DIR}`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

function loadReviewed() {
	if (!existsSync(REVIEWED_FILE)) return {};
	return JSON.parse(readFileSync(REVIEWED_FILE, "utf-8"));
}

function loadDrafts() {
	if (!existsSync(DRAFT_DIR)) return {};
	const drafts = {};
	for (const file of readdirSync(DRAFT_DIR)) {
		if (!file.endsWith(".json")) continue;
		const spec = JSON.parse(readFileSync(join(DRAFT_DIR, file), "utf-8"));
		drafts[spec.code] = spec;
	}
	return drafts;
}

const REQUIRED_FIELDS = ["code", "summary", "parameters", "sources"];
const VALID_KINDS = new Set([
	"number", "integer", "unsigned", "boolean01", "string", "driverId", "pin",
	"axisLetters", "toolNumber", "heaterNumber", "fanNumber", "sensorNumber", "probeNumber",
	"bitmap", "filename", "any",
]);

function validate(spec) {
	for (const field of REQUIRED_FIELDS) {
		if (!(field in spec)) throw new Error(`${spec.code ?? "?"}: missing required field "${field}"`);
	}
	if (!Array.isArray(spec.sources) || spec.sources.length === 0) {
		throw new Error(`${spec.code}: "sources" must be a non-empty array`);
	}
	for (const p of spec.parameters) {
		if (!VALID_KINDS.has(p.kind)) throw new Error(`${spec.code}: parameter ${p.letter} has invalid kind "${p.kind}"`);
	}
}

function build() {
	const reviewed = loadReviewed();
	const drafts = loadDrafts();
	const merged = { ...drafts, ...reviewed }; // reviewed always wins over its own draft

	const codes = Object.keys(merged).sort();
	for (const code of codes) validate(merged[code]);

	const reviewedCount = codes.filter((c) => merged[c].reviewed !== undefined).length;
	const coverage = { total: codes.length, reviewed: reviewedCount, draftOnly: codes.length - reviewedCount };
	mkdirSync(join(ROOT, "dictionary"), { recursive: true });
	writeFileSync(COVERAGE_FILE, JSON.stringify(coverage, null, "\t") + "\n");

	const header = `/**
 * The RRF command dictionary — GENERATED by \`scripts/build-dictionary.mjs\` from
 * \`dictionary/commands.json\` (reviewed, cited to RRF source) and \`dictionary/draft/*.json\`
 * (bootstrapped from \`@duet3d/monacotokens\`, unreviewed). Do not hand-edit; edit those inputs and
 * re-run the script. See \`docs/tasks/10-dictionary.md\` and \`dictionary/coverage.json\`.
 */

import type { CommandDictionary } from "./schema.js";

export const COMMANDS: CommandDictionary = Object.freeze(
${JSON.stringify(Object.fromEntries(codes.map((c) => [c, merged[c]])), null, "\t")}
);

export function commandSpec(code: string): CommandDictionary[string] | null {
	const upper = code.toUpperCase();
	const direct = COMMANDS[upper];
	if (direct !== undefined) return direct;
	// A numbered tool selection ("T0", "T-1", bare "T" with a command number rather than a T
	// parameter - see lex.ts's LexedCommand.code) is still just "select a tool"; the dictionary only
	// carries one entry for it, keyed by the bare "T" RRF's own wiki and GCodes2.cpp::HandleTcode use.
	if (/^T-?\\d+$/.test(upper)) return COMMANDS.T ?? null;
	return null;
}
`;
	mkdirSync(join(ROOT, "src", "dictionary"), { recursive: true });
	writeFileSync(OUT_TS, header);
	console.log(`Wrote ${OUT_TS}: ${codes.length} total, ${reviewedCount} reviewed, ${codes.length - reviewedCount} draft-only.`);
}

const args = process.argv.slice(2);
if (args.includes("--bootstrap")) {
	await bootstrap();
} else {
	build();
}
