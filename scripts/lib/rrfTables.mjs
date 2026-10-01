/**
 * RRF's own object-model tables, read straight from the clone at a tag (CLAUDE.md rule 12 ranks them first).
 * Every entry is `{ "key", OBJECT_MODEL_FUNC...(...), flags }`; the class a table belongs to and the way tables
 * nest are C++ types this does not follow, so what it answers is "is there a table entry for this key, in which
 * files": a key that is absent from every table at a tag is reliably absent, a key that is present may still be a
 * different class's field of the same name - the caller reviews those.
 */
import { git } from "./rrfClone.mjs";

const ENTRY = /\{\s*"([A-Za-z0-9_]+)"\s*,\s*OBJECT_MODEL_FUNC/g;

/** Map: key -> array of `file` (src-relative, one per entry). */
export function tableKeysAt(clone, ref) {
	const out = new Map();
	let text = "";
	try {
		text = git(clone, ["grep", "-n", "-E", `"[A-Za-z0-9_]+"[[:space:]]*,[[:space:]]*OBJECT_MODEL_FUNC`, ref, "--", "src"]);
	} catch {
		return out;
	}
	for (const row of text.split("\n")) {
		if (row === "") continue;
		// <ref>:<file>:<line>:<content>
		const m = /^[^:]+:([^:]+):(\d+):(.*)$/.exec(row);
		if (m === null) continue;
		ENTRY.lastIndex = 0;
		let e;
		while ((e = ENTRY.exec(m[3])) !== null) {
			const list = out.get(e[1]) ?? [];
			list.push(m[1].replace(/^src\//, ""));
			out.set(e[1], list);
		}
	}
	return out;
}
