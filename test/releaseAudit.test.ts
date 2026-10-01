import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Holds `RELEASES` and every change event that cites an RRF commit to the real RRF history, by running
 * `scripts/audit-releases.mjs --events`. Needs a full-history clone (`$RRF_CLONE` or `../RepRapFirmware`) and a built
 * `dist/`; without them it is skipped, so CI without a clone stays green while a maintainer's machine runs it.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const clone = process.env.RRF_CLONE ?? join(ROOT, "..", "RepRapFirmware");
const canRun = existsSync(join(clone, ".git")) && existsSync(join(ROOT, "dist", "releases", "releases.js"));

/** Newest mtime of the `.ts` files under `dir` (the audit's inputs), or 0 when there are none. */
function newestSource(dir: string): number {
	let newest = 0;
	for (const name of readdirSync(dir)) {
		if (name.endsWith(".ts")) newest = Math.max(newest, statSync(join(dir, name)).mtimeMs);
	}
	return newest;
}

describe.skipIf(!canRun)("RELEASES and event pins against the RRF clone", () => {
	it("dist/ is newer than src/releases (the audit reads dist/, so a stale build would audit old events)", () => {
		const built = statSync(join(ROOT, "dist", "releases", "changes.js")).mtimeMs;
		expect(newestSource(join(ROOT, "src", "releases")), "run `npm run build` first: dist/ is older than src/releases").toBeLessThanOrEqual(built);
	});

	it("audit-releases --events passes: every release is a real commit, every event sits at the first release containing its commit", () => {
		let output = "";
		try {
			output = execFileSync(process.execPath, [join(ROOT, "scripts", "audit-releases.mjs"), "--events", "--rrf", clone], { encoding: "utf8", cwd: ROOT });
		} catch (e) {
			output = String((e as { stdout?: string }).stdout ?? e);
			throw new Error(`audit-releases failed:\n${output}`);
		}
		expect(output).not.toMatch(/^(FAIL|DIFF) /m);
		expect(output).toMatch(/commit citations checked/);
	}, 120_000);
});
