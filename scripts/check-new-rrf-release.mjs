#!/usr/bin/env node
/**
 * Has Duet3D/RepRapFirmware tagged a release newer than `RRF_BASELINE` (`src/rrf.ts`)? The catalogue is bundled, so a
 * new tag it has not been triaged against means every notification silently stops at the old version (step D7 of
 * Flexible-Layouts' FIRMWARE-CHANGES-PLAN.md). Needs `npm run build` first (reads `dist/`) and
 * network access; no clone is needed, only `git ls-remote`.
 *
 *   node scripts/check-new-rrf-release.mjs [--remote <url>]
 *
 * Exit 0 = nothing newer, exit 1 = newer tags listed (the scheduled workflow opens an issue on 1), exit 2 = could not ask.
 * Tags that are not a plain `3.x` / `3.x.y` / `-alpha|beta|rc.N` version are ignored (STM32 forks and build tags).
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const argv = process.argv.slice(2);
let remote = "https://github.com/Duet3D/RepRapFirmware.git";
for (let i = 0; i < argv.length; i++) if (argv[i] === "--remote") remote = argv[++i] ?? remote;

const baseline = /export const RRF_BASELINE = "([^"]+)"/.exec(readFileSync(join(ROOT, "src", "rrf.ts"), "utf8"))?.[1];
if (!baseline) {
	console.error("Could not read RRF_BASELINE from src/rrf.ts");
	process.exit(2);
}
const { compareFirmwareVersions } = await import(pathToFileURL(join(ROOT, "dist", "versionCompare.js")).href);

let out;
try {
	out = execFileSync("git", ["ls-remote", "--tags", "--refs", remote], { encoding: "utf8" });
} catch (e) {
	console.error(`git ls-remote ${remote} failed: ${e.message}`);
	process.exit(2);
}

const TAG = /^3\.\d+(?:\.\d+)?(?:-(?:alpha|beta|rc)\.\d+)?$/;
const newer = out
	.split("\n")
	.map((l) => l.split("refs/tags/")[1]?.trim())
	.filter((t) => t && TAG.test(t) && compareFirmwareVersions(t, baseline) > 0)
	.sort(compareFirmwareVersions);

if (newer.length === 0) {
	console.log(`RRF_BASELINE ${baseline} is the newest tag on ${remote}.`);
} else {
	console.log(`RRF has tags newer than RRF_BASELINE ${baseline}: ${newer.join(", ")}`);
	console.log(`Recipe: npm run triage -- ${baseline} ${newer[newer.length - 1]} --per-release (docs/rrf-triage/README.md)`);
	process.exit(1);
}
