/**
 * Which tracked release first contains an RRF commit, shared by `split-triage.mjs` and `rrf-triage.mjs --per-release`.
 * `RELEASES` (`dist/releases/releases.js`, so `npm run build` first) is an ancestry chain from `3.7.0-alpha.2` on
 * (`audit-releases.mjs` section 3 holds it to that), so "the first release containing a commit" is a binary search, not a
 * scan. `3.6.3` is a separate branch: it is the baseline, never a candidate, and a commit already in it is "before the window".
 * The pin rule is the one in `src/releases/releases.ts` and `docs/rrf-triage/README.md`.
 */
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { git } from "./rrfClone.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

export async function loadReleases() {
	const mod = await import(pathToFileURL(join(ROOT, "dist", "releases", "releases.js")).href);
	return mod.RELEASES;
}

export async function loadChanges() {
	const mod = await import(pathToFileURL(join(ROOT, "dist", "releases", "changes.js")).href);
	return mod.CHANGES;
}

export function isAncestor(clone, a, b) {
	try {
		git(clone, ["merge-base", "--is-ancestor", a, b]);
		return true;
	} catch {
		return false;
	}
}

/**
 * The first tracked release (after the `3.6.3` baseline) whose commit contains `sha`, `"baseline"` when `3.6.3` already
 * contains it, or `null` when no tracked release does (a commit newer than the newest entry).
 */
export function firstContaining(clone, releases, sha) {
	if (isAncestor(clone, sha, releases[0].commit)) return "baseline";
	const chain = releases.slice(1);
	if (!isAncestor(clone, sha, chain[chain.length - 1].commit)) return null;
	let lo = 0;
	let hi = chain.length - 1; // chain[hi] is known to contain it
	while (lo < hi) {
		const mid = (lo + hi) >> 1;
		if (isAncestor(clone, sha, chain[mid].commit)) hi = mid;
		else lo = mid + 1;
	}
	return chain[lo].version;
}
