#!/usr/bin/env node
/**
 * Lexer throughput benchmark — task 05's "the lexer is a hot path" requirement (CLAUDE.md rule 4).
 * Generates a synthetic multi-million-line file mixing G1 motion, comments and a couple of common
 * M-codes, then times `lexLine` (or, with `--old <dir>`, a prior build's `tokenise`+`parseParams`,
 * for an apples-to-apples "before" number).
 *
 * Usage:
 *   node scripts/bench-lex.mjs [--lines N] [--old <dir with dist/lex.js + dist/params.js>]
 */

import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";

function generateLines(n) {
	const lines = new Array(n);
	for (let i = 0; i < n; i++) {
		const m = i % 20;
		if (m === 0) lines[i] = "; LAYER_CHANGE";
		else if (m === 1) lines[i] = "G92 E0";
		else if (m === 18) lines[i] = "M106 S255";
		else if (m === 19) lines[i] = "M107";
		else lines[i] = `G1 X${(i * 0.1).toFixed(3)} Y${(i * 0.2).toFixed(3)} E${(i * 0.01).toFixed(5)} F1200`;
	}
	return lines;
}

async function main() {
	const args = process.argv.slice(2);
	const linesArg = args.indexOf("--lines");
	const n = linesArg !== -1 ? Number(args[linesArg + 1]) : 1_000_000;
	const oldArg = args.indexOf("--old");
	const lines = generateLines(n);

	let run;
	if (oldArg !== -1) {
		const dir = args[oldArg + 1];
		const abs = isAbsolute(dir) ? dir : resolve(process.cwd(), dir);
		const { tokenise } = await import(pathToFileURL(resolve(abs, "lex.js")).href);
		const { parseParams } = await import(pathToFileURL(resolve(abs, "params.js")).href);
		run = () => {
			let count = 0;
			for (const raw of lines) {
				const t = tokenise(raw);
				count += parseParams(t.body).length;
			}
			return count;
		};
	} else {
		const { lexLine } = await import("../dist/lex.js");
		run = () => {
			let count = 0;
			for (const raw of lines) {
				count += lexLine(raw).commands.length;
			}
			return count;
		};
	}

	const start = process.hrtime.bigint();
	const count = run();
	const end = process.hrtime.bigint();
	const seconds = Number(end - start) / 1e9;
	const linesPerSecond = n / seconds;
	console.log(`${oldArg !== -1 ? "old (tokenise+parseParams)" : "lexLine"}: ${n} lines in ${seconds.toFixed(3)}s = ${Math.round(linesPerSecond).toLocaleString()} lines/s (sanity count ${count})`);
}

await main();
