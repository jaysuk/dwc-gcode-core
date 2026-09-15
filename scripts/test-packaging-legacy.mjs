#!/usr/bin/env node
/**
 * Packaging audit C1 (task 16, `docs/tasks/16-hardening-and-readiness.md`): proves the BUILT package
 * still resolves under a legacy TypeScript `moduleResolution: "node"` consumer - the classic
 * pre-`exports`-map algorithm an older webpack/Vue-CLI project uses, which is what broke against a
 * real DWC 3.6 build (resonance-lab's own dual DWC 3.6/3.7 target) before this task's fix.
 *
 * Copies (not symlinks - portable across Windows/macOS/Linux with no elevated privileges and no
 * junction/symlink quirks in a git checkout) this package's own `package.json` + `dist/` into
 * `test/packaging/legacy/node_modules/dwc-gcode-core`, exactly as `npm install dwc-gcode-core` would
 * lay it out, then runs `tsc -p test/packaging/legacy --noEmit`. `test/packaging/legacy/index.ts`
 * imports the bare root specifier and every documented subpath - a resolution regression on ANY of
 * them fails this script, not just the root.
 *
 *   npm run build && node scripts/test-packaging-legacy.mjs
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const FIXTURE = join(ROOT, "test", "packaging", "legacy");
const INSTALLED = join(FIXTURE, "node_modules", "dwc-gcode-core");

if (!existsSync(join(ROOT, "dist", "index.js"))) {
	console.error("dist/index.js not found - run `npm run build` first.");
	process.exit(1);
}

rmSync(INSTALLED, { recursive: true, force: true });
mkdirSync(INSTALLED, { recursive: true });
cpSync(join(ROOT, "package.json"), join(INSTALLED, "package.json"));
cpSync(join(ROOT, "dist"), join(INSTALLED, "dist"), { recursive: true });

// Invoke TypeScript's own JS entry point directly with `node`, not the `tsc`/`tsc.cmd` shim - avoids
// needing `shell: true` (and its arg-escaping footgun) purely to run a `.cmd` file on Windows.
const tscJs = fileURLToPath(new URL("../node_modules/typescript/bin/tsc", import.meta.url));
try {
	execFileSync(process.execPath, [tscJs, "-p", FIXTURE, "--noEmit"], { stdio: "inherit" });
	console.log("test-packaging-legacy: OK - the built package resolves under moduleResolution: \"node\".");
} catch {
	console.error("test-packaging-legacy: FAILED - see tsc output above.");
	process.exit(1);
}
