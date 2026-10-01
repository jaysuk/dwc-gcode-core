/**
 * Where the local RepRapFirmware clone lives, shared by every script that reads RRF history.
 * Order: an explicit `--rrf <path>` (handled by the caller), `$RRF_CLONE`, then the first existing sibling
 * checkout (`../RepRapFirmware`, the old `../RRFBuild/RepRapFirmware`). Never check out, reset, clean or
 * build in the clone - every read here is `git show`/`log`/`grep` against a tag or sha.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export function defaultRrfClone() {
	if (process.env.RRF_CLONE) return process.env.RRF_CLONE;
	const candidates = [
		join(ROOT, "..", "RepRapFirmware"),
		join(ROOT, "..", "RRFBuild", "RepRapFirmware"),
	];
	return candidates.find((c) => existsSync(join(c, ".git"))) ?? candidates[0];
}

export function git(clone, args, opts = {}) {
	return execFileSync("git", ["-C", clone, ...args], { encoding: "utf-8", maxBuffer: 512 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"], ...opts });
}

/** `git show <ref>:<path>`, or `null` when the file does not exist at that ref. */
export function show(clone, ref, path) {
	try {
		return git(clone, ["show", `${ref}:${path}`]);
	} catch {
		return null;
	}
}

export function lines(text) {
	return text.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
}
