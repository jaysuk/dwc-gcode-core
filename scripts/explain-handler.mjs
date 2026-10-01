#!/usr/bin/env node
/**
 * The confirm step for `dictionary-param-history.mjs`: prints the lines of a command's dispatch `case` (at one release)
 * that read a letter, so a proposed since/until can be checked by eye before it is written. Any letter-reading line is
 * shown (Seen / MustSee / TryGet / a letter variable), not only the requested letter.
 *
 *   node scripts/explain-handler.mjs <release-or-commit> M906:I M92:E ... [--rrf <clone>] [--callees]
 *
 * `--callees` also prints every function the case hands `gb` to, with its file, so the next place to look is known.
 */
import { defaultRrfClone } from "./lib/rrfClone.mjs";
import { calleesWithGb, dispatchCases, gcodeFunctions, loadTree } from "./lib/rrfSource.mjs";

const argv = process.argv.slice(2);
let clone = defaultRrfClone();
let callees = false;
const rest = [];
for (let i = 0; i < argv.length; i++) {
	if (argv[i] === "--rrf") clone = argv[++i] ?? clone;
	else if (argv[i] === "--callees") callees = true;
	else rest.push(argv[i]);
}
const [ref, ...specs] = rest;
if (ref === undefined || specs.length === 0) {
	console.error("usage: node scripts/explain-handler.mjs <ref> CODE:LETTER ... [--callees]");
	process.exit(2);
}
const tree = loadTree(clone, ref);
const cases = dispatchCases(tree);
const defs = callees ? gcodeFunctions(tree) : null;
for (const s of specs) {
	const [code, letter] = s.split(":");
	const c = cases.get(code.replace(/\.\d+$/, ""));
	console.log(`=== ${code} ${letter ?? ""} @ ${ref}  (${c ? c.file : "no dispatch case"})`);
	if (c === undefined) continue;
	const re = new RegExp(`'${letter ?? "."}'|Letter|Seen\\(|MustSee|TryGet`);
	console.log(c.body.split("\n").filter((l) => re.test(l)).map((l) => `  ${l.trim()}`).slice(0, 24).join("\n"));
	if (defs !== null) for (const name of calleesWithGb(c.body)) console.log(`  -> ${name}: ${(defs.get(name) ?? []).map((d) => d.file).join(", ") || "not found"}`);
}
