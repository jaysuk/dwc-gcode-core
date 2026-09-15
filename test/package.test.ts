import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import * as index from "../src/index.js";
import * as edit from "../src/edit.js";
import * as params from "../src/params.js";
import { RRF_BASELINE } from "../src/rrf.js";
import { CORE_VERSION } from "../src/version.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
	version: string;
	rrf: { baseline: string };
	exports: Record<string, unknown>;
};

/**
 * Subpaths deliberately NOT re-exported from the root barrel, because their exports collide by name
 * with something the root already exports differently — see `index.ts`'s own comment on `edit`
 * (its `setParam` rewrites a raw line; `params.ts`'s rewrites an already-tokenised command body).
 */
const ROOT_EXCLUDED_SUBPATHS = new Set(["./edit", "./dictionary/*"]);

/** The source module behind every `exports` subpath, wildcards expanded. */
function exportedModules(rootOnly: boolean): Array<string> {
	const files: Array<string> = [];
	for (const key of Object.keys(pkg.exports)) {
		if (key === "." || key === "./package.json") continue;
		if (rootOnly && ROOT_EXCLUDED_SUBPATHS.has(key)) continue;
		const sub = key.slice(2);
		if (sub.endsWith("/*")) {
			const dir = join(root, "src", sub.slice(0, -2));
			for (const name of readdirSync(dir)) {
				if (name.endsWith(".ts")) files.push(join(dir, name));
			}
		} else {
			files.push(join(root, "src", `${sub}.ts`));
		}
	}
	return files;
}

describe("package surface", () => {
	it("states the same RRF baseline in package.json and in code", () => {
		expect(pkg.rrf.baseline).toBe(RRF_BASELINE);
	});

	it("states the same package version in package.json and in code (CORE_VERSION, task 09's stamp)", () => {
		expect(pkg.version).toBe(CORE_VERSION);
	});

	it("has a source module behind every exports subpath", () => {
		const modules = exportedModules(false);
		expect(modules.length).toBeGreaterThan(0);
		for (const file of modules) {
			expect(existsSync(file), file).toBe(true);
		}
	});

	it("re-exports every subpath's runtime exports from the root, except the documented exclusions", async () => {
		for (const file of exportedModules(true)) {
			const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
			for (const name of Object.keys(mod)) {
				expect(index, `${name} from ${file}`).toHaveProperty(name);
			}
		}
	});

	it("the root's setParam is params.ts's (tokenised-body), not edit.ts's (raw-line) — the reason edit is excluded", () => {
		// Both are real, different functions with the same name (see index.ts's own comment). If
		// this ever passes with `index.setParam === edit.setParam` instead, the exclusion above has
		// silently stopped doing its job.
		expect(index.setParam).toBe(params.setParam);
		expect(index.setParam).not.toBe(edit.setParam);
		// edit.ts's own setParam must still work when imported from its own subpath.
		expect(edit.setParam("M92 E420:500", "E", "397.2")).toBe("M92 E397.2");
	});
});
