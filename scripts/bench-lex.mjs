#!/usr/bin/env node
/**
 * Lexer/document throughput benchmark — task 05's "the lexer is a hot path" requirement (CLAUDE.md
 * rule 4), extended by task 06 to cover `parseDocument`, and by task 16
 * (`docs/tasks/16-hardening-and-readiness.md`) to cover the two scenarios that task asks for by name:
 * a large synthetic print file processed in CHUNKS the way a consumer actually reads one (never
 * materialised as one JS string), and a config-sized file run through `parseDocument` whole. Numbers
 * from this script are recorded in `docs/performance.md` - re-run it and update that file whenever a
 * change could plausibly move them, not just when this task revisits it.
 *
 * Usage:
 *   node scripts/bench-lex.mjs [--lines N] [--old <dir with dist/lex.js + dist/params.js>]
 *   node scripts/bench-lex.mjs [--lines N] --document
 *   node scripts/bench-lex.mjs --chunked-print <MB> [--chunk-bytes N] [--generate-only]
 *   node scripts/bench-lex.mjs --config <lines>
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

/** A config.g-shaped line at index `i` — dictionary-real commands and meta-gcode blocks, not just
 *  flat motion, so `parseDocument`'s block-tree builder actually has something to do. */
function configLineAt(i) {
	const m = i % 25;
	switch (m) {
		case 0: return "; --- section ---";
		case 1: return "if !exists(global.toolTemp)";
		case 2: return `\tglobal toolTemp${i} = 210`;
		case 3: return `M584 X0 Y1 Z2 E${i % 4}`;
		case 4: return `M574 X1 S1 P"io${i % 4}.in"`;
		case 5: return `M350 X16 Y16 Z16 E16 I1`;
		case 6: return `M92 X80 Y80 Z400 E${420 + (i % 10)}`;
		case 7: return `M308 S${i % 8} P"temp${i % 8}" Y"thermistor"`;
		case 8: return `M950 H${i % 8} C"out${i % 8}" T${i % 8}`;
		case 9: return `M143 H${i % 8} S280`;
		case 10: return `M563 P${i % 6} D0 H${1 + (i % 8)} F0`;
		case 11: return `G10 P${i % 6} S{global.toolTemp${i - 3 >= 0 ? i - 3 : 0}} R150`;
		case 12: return `M950 F${i % 4} C"fan${i % 4}"`;
		case 13: return `M106 P${i % 4} S0`;
		case 14: return `M558 K0 C"^io1.in" H5 F120 T6000`;
		case 15: return `G31 K0 P500 X0 Y0 Z0.7`;
		case 16: return "while iterations < 3";
		case 17: return `\tG1 X${i % 100} Y${i % 100} F3000`;
		case 18: return "\tset iterations = iterations + 1";
		case 19: return "M500 P10";
		default: return `G1 X${(i * 0.1).toFixed(3)} Y${(i * 0.2).toFixed(3)} F3000`;
	}
}

/** Yields ~`chunkBytes`-sized string chunks totalling ~`targetMb` megabytes of synthetic print-file
 *  text, never holding more than one chunk's worth in memory at once - this is "the way consumers
 *  read files" the task itself names, not a single `join()`ed multi-hundred-MB string. */
function* generatePrintFileChunks(targetMb, chunkBytes) {
	const targetBytes = targetMb * 1024 * 1024;
	let produced = 0;
	let buf = "";
	let i = 0;
	while (produced < targetBytes) {
		const m = i % 20;
		const text = (m === 0 ? "; LAYER_CHANGE" : m === 1 ? "G92 E0" : m === 18 ? "M106 S255" : m === 19 ? "M107"
			: `G1 X${(i * 0.1).toFixed(3)} Y${(i * 0.2).toFixed(3)} E${(i * 0.01).toFixed(5)} F1200`) + "\n";
		buf += text;
		produced += text.length;
		i++;
		if (buf.length >= chunkBytes) {
			yield buf;
			buf = "";
		}
	}
	if (buf.length > 0) yield buf;
}

/**
 * `--generate-only` measures the SYNTHETIC GENERATOR alone, with no lexing at all. It exists because
 * the generator's own cost is not free and is not the same in both chunk modes: building one 200 MB
 * string means ~5.5M `buf +=` concatenations, which dominates both time and memory. Comparing two
 * chunk sizes without subtracting this attributes the harness's string-building to `lexLines`, which
 * is how `docs/performance.md`'s first draft overstated the gap - always report both numbers.
 */
async function runChunkedPrint(targetMb, chunkBytes, generateOnly) {
	const { lexLines } = await import("../dist/lex.js");
	if (globalThis.gc) globalThis.gc();
	const memBefore = process.memoryUsage().heapUsed;
	const start = process.hrtime.bigint();
	let lineCount = 0;
	let commandCount = 0;
	if (generateOnly) {
		let bytes = 0;
		for (const chunk of generatePrintFileChunks(targetMb, chunkBytes)) bytes += chunk.length;
		lineCount = bytes; // only used for the sanity print below
	} else {
		for (const line of lexLines(generatePrintFileChunks(targetMb, chunkBytes))) {
			lineCount++;
			commandCount += line.commands.length;
		}
	}
	const end = process.hrtime.bigint();
	const memAfter = process.memoryUsage().heapUsed;
	const seconds = Number(end - start) / 1e9;
	const heapMb = ((memAfter - memBefore) / 1024 / 1024).toFixed(1);
	if (generateOnly) {
		console.log(
			`generate-only (no lexing, ${chunkBytes}B chunks): ~${targetMb} MB in ${seconds.toFixed(3)}s ` +
			`(heap delta ${heapMb} MB) - subtract this from the run below to get lexLines' own cost`,
		);
		return;
	}
	console.log(
		`lexLines (chunked, ${chunkBytes}B chunks): ~${targetMb} MB, ${lineCount.toLocaleString()} lines in ${seconds.toFixed(3)}s ` +
		`= ${(targetMb / seconds).toFixed(1)} MB/s, ${Math.round(lineCount / seconds).toLocaleString()} lines/s ` +
		`(sanity command count ${commandCount.toLocaleString()}; heap delta ${heapMb} MB, generator included)`,
	);
}

async function runConfig(n) {
	const { parseDocument } = await import("../dist/document.js");
	const lines = new Array(n);
	for (let i = 0; i < n; i++) lines[i] = configLineAt(i);
	const text = lines.join("\n") + "\n";
	const start = process.hrtime.bigint();
	const doc = parseDocument(text);
	const end = process.hrtime.bigint();
	const seconds = Number(end - start) / 1e9;
	console.log(
		`parseDocument (config-shaped): ${n.toLocaleString()} lines (${(text.length / 1024).toFixed(1)} KB) in ` +
		`${(seconds * 1000).toFixed(2)}ms = ${Math.round(n / seconds).toLocaleString()} lines/s ` +
		`(${doc.blocks.length} top-level blocks, ${doc.errors.length} errors)`,
	);
}

async function main() {
	const args = process.argv.slice(2);

	const chunkedArg = args.indexOf("--chunked-print");
	if (chunkedArg !== -1) {
		const targetMb = Number(args[chunkedArg + 1]);
		const chunkBytesArg = args.indexOf("--chunk-bytes");
		const chunkBytes = chunkBytesArg !== -1 ? Number(args[chunkBytesArg + 1]) : 65536;
		await runChunkedPrint(targetMb, chunkBytes, args.includes("--generate-only"));
		return;
	}

	const configArg = args.indexOf("--config");
	if (configArg !== -1) {
		await runConfig(Number(args[configArg + 1]));
		return;
	}

	const linesArg = args.indexOf("--lines");
	const n = linesArg !== -1 ? Number(args[linesArg + 1]) : 1_000_000;
	const oldArg = args.indexOf("--old");
	const asDocument = args.includes("--document");
	const lines = generateLines(n);

	let run;
	if (asDocument) {
		const { parseDocument } = await import("../dist/document.js");
		const text = lines.join("\n") + "\n";
		run = () => parseDocument(text).lines.length;
	} else if (oldArg !== -1) {
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
	const label = asDocument ? "parseDocument" : oldArg !== -1 ? "old (tokenise+parseParams)" : "lexLine";
	console.log(`${label}: ${n} lines in ${seconds.toFixed(3)}s = ${Math.round(linesPerSecond).toLocaleString()} lines/s (sanity count ${count})`);
}

await main();
