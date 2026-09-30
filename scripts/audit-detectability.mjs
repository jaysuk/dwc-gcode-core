// Lists the release change events `impactOf` can never match against a document, grouped by why.
// Each one should become a retarget to a detectable target (command / parameter / object-model path), a new matcher in
// src/releases/impact.ts with a fixture, or an explicit "informational" event. Reads dist/, so `npm run build` first.
//   node scripts/audit-detectability.mjs [--json]
import { CHANGES } from "../dist/releases/changes.js";
import { undetectableReason } from "../dist/releases/impact.js";

const groups = new Map();
for (const e of CHANGES) {
	const why = undetectableReason(e);
	if (why === null) continue;
	if (!groups.has(why)) groups.set(why, []);
	groups.get(why).push(e);
}
const total = [...groups.values()].reduce((n, g) => n + g.length, 0);

if (process.argv.includes("--json")) {
	console.log(JSON.stringify({ total, of: CHANGES.length, groups: Object.fromEntries([...groups].map(([k, v]) => [k, v.map((e) => e.id)])) }, null, 2));
} else {
	console.log(`${total} of ${CHANGES.length} events cannot be matched by impactOf.\n`);
	for (const [why, events] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
		console.log(`## ${why} (${events.length})`);
		for (const e of events) console.log(`  ${e.version.padEnd(14)} ${e.id}`);
		console.log();
	}
}
