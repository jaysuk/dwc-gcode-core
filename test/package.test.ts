import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

import * as index from "../src/index.js";
import { RRF_BASELINE } from "../src/rrf.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8")) as {
	rrf: { baseline: string };
	exports: Record<string, unknown>;
};

/** The source module behind every `exports` subpath, wildcards expanded. */
function exportedModules(): Array<string> {
	const files: Array<string> = [];
	for (const key of Object.keys(pkg.exports)) {
		if (key === "." || key === "./package.json") continue;
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

	it("has a source module behind every exports subpath", () => {
		const modules = exportedModules();
		expect(modules.length).toBeGreaterThan(0);
		for (const file of modules) {
			expect(existsSync(file), file).toBe(true);
		}
	});

	it("re-exports every subpath's runtime exports from the root", async () => {
		for (const file of exportedModules()) {
			const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
			for (const name of Object.keys(mod)) {
				expect(index, `${name} from ${file}`).toHaveProperty(name);
			}
		}
	});
});
