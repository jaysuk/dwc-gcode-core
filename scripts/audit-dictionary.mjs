#!/usr/bin/env node
/**
 * Systematic sweep of `dictionary/commands.json`'s REVIEWED entries for two shapes of gap task 17
 * (`docs/tasks/17-pin-names-and-validation.md`, Decision 2) found by hand, one command at a time,
 * before deciding a repeatable script was needed: a parameter that looks like it draws from a fixed,
 * closed set of values but has no `values` list; and a parameter whose own description already says
 * (in prose) that it's required only under some condition, but `required` isn't set to reflect that.
 *
 * This is a CANDIDATE GENERATOR, not an oracle - task 17's own Traps say so explicitly. Every
 * candidate still needs a human to read the real RRF source and decide: genuinely enum-shaped or
 * genuinely free text; a real conditional-required gap or already adequately covered another way
 * (e.g. by an unconditionally-required companion letter, or by `project.ts`'s symbol tracking instead
 * of `ParamSpec.required` at all - M308's `Y`/M950's `H` are exactly that case, task 17 Step 3, and
 * deliberately do NOT need a `required` entry even though their description mentions a condition).
 *
 *   node scripts/audit-dictionary.mjs [--out docs/dictionary-audit.md]
 *
 * Rerun whenever a draft command is promoted to reviewed, or a `values`/`required` fix is applied -
 * this is meant to be repeatable maintenance (task 17's own Decision 2), not a one-time sweep.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const DICT_FILE = join(ROOT, "dictionary", "commands.json");

const argv = process.argv.slice(2);
let out = null;
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--out") out = argv[++i] ?? null;
}

const dict = JSON.parse(readFileSync(DICT_FILE, "utf-8"));

// A rough, deliberately over-inclusive signal that a description is describing free text rather than
// a closed set - lowers a candidate's priority in the report, never excludes it outright (the whole
// point of a human pass is to catch cases this heuristic gets wrong in either direction).
const FREE_TEXT_HINTS = /\b(address|password|passphrase|SSID|hostname|host name|machine name|tool name|fan name|sensor name|object name|file ?name|topic|title|message|text string|MAC|IP|netmask|gateway|client ID|identity|key|username|certificate)\b/i;

// A description already saying, in prose, that this parameter is conditionally required - the signal
// `required` should reflect but currently might not.
const REQUIRED_PROSE_RE = /required (only )?when|only required|requires? [A-Z]\b|MustSee.*when/i;

/** @returns {string[]} */
function enumCandidates() {
	const rows = [];
	for (const [code, spec] of Object.entries(dict)) {
		if (!spec.reviewed) continue;
		for (const p of spec.parameters ?? []) {
			if (p.kind !== "string" || p.values !== undefined) continue;
			const freeText = FREE_TEXT_HINTS.test(p.description);
			rows.push(`- \`${code} ${p.letter}\` (${freeText ? "likely free text" : "check for a closed set"}) - ${p.description}`);
		}
	}
	return rows;
}

/** @returns {string[]} */
function conditionalRequiredCandidates() {
	const rows = [];
	for (const [code, spec] of Object.entries(dict)) {
		if (!spec.reviewed) continue;
		for (const p of spec.parameters ?? []) {
			if (p.required !== undefined) continue; // already true, "unknown", or a reviewed condition object - nothing to reconsider
			if (!REQUIRED_PROSE_RE.test(p.description)) continue;
			rows.push(`- \`${code} ${p.letter}\` - ${p.description}`);
		}
	}
	return rows;
}

/** A numeric parameter whose description lists several "N <meaning>" pairs - informational only: if
 *  `range` already covers the full valid span contiguously, `values` would only add readability, not
 *  validation (task 17's own Decision 2/Findings reasoning for M569.1's T). Still worth a human
 *  glance in case the span ISN'T contiguous (a real validation gap `range` alone can't express). */
function namedNumericEnumCandidates() {
	const rows = [];
	const NAMED_PAIR_RE = /\b\d+\s+[a-z]/gi;
	for (const [code, spec] of Object.entries(dict)) {
		if (!spec.reviewed) continue;
		for (const p of spec.parameters ?? []) {
			if (p.values !== undefined) continue;
			if (!["integer", "unsigned", "boolean01"].includes(p.kind)) continue;
			const matches = p.description.match(NAMED_PAIR_RE) ?? [];
			if (matches.length < 3) continue; // need at least a handful of "N word" pairs to be worth a look
			const rangeNote = p.range !== undefined
				? `range ${p.range.min ?? "-inf"}..${p.range.max ?? "inf"} set - only a readability gap unless the span isn't contiguous`
				: "NO range set - a real validation gap, not just readability";
			rows.push(`- \`${code} ${p.letter}\` (${rangeNote}) - ${p.description}`);
		}
	}
	return rows;
}

const reviewedCount = Object.values(dict).filter((s) => s.reviewed).length;
const enumRows = enumCandidates();
const requiredRows = conditionalRequiredCandidates();
const numericRows = namedNumericEnumCandidates();

const report = [
	"# Dictionary audit — enum-`values` and conditional-`required` candidates",
	"",
	`Generated by \`scripts/audit-dictionary.mjs\` against \`dictionary/commands.json\`'s ${reviewedCount} ` +
		"reviewed commands. A candidate generator (task 17, Decision 2) - every row needs a human to read " +
		"the real RRF source before acting on it, per this script's own doc comment.",
	"",
	`## String parameters with no \`values\` (${enumRows.length})`,
	"",
	...(enumRows.length > 0 ? enumRows : ["(none)"]),
	"",
	`## Descriptions that already say "required when X" but \`required\` doesn't reflect it (${requiredRows.length})`,
	"",
	...(requiredRows.length > 0 ? requiredRows : ["(none)"]),
	"",
	`## Numeric parameters that look like a named enum in prose (${numericRows.length}, informational)`,
	"",
	...(numericRows.length > 0 ? numericRows : ["(none)"]),
	"",
].join("\n");

if (out !== null) {
	writeFileSync(out, report);
	console.error(`Wrote ${out}: ${enumRows.length} enum, ${requiredRows.length} conditional-required, ${numericRows.length} numeric-enum candidates.`);
} else {
	console.log(report);
}
