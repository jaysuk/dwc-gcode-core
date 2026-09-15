/**
 * Seeded property fuzzing (task 16, `docs/tasks/16-hardening-and-readiness.md`) — generates random
 * lines from the lexer's own alphabet in all three machine modes and checks three invariants that
 * must hold for ANY input, not just the hand-written fixtures elsewhere: `lexLine` never throws, every
 * span it (or `parseDocument`) reports stays in bounds and doesn't overlap a sibling span, and a whole
 * document built from the same random corpus round-trips byte-for-byte through
 * `parseDocument`/`serializeDocument` (task 06's own guarantee, now checked against adversarial input
 * too, not just hand-written fixtures).
 *
 * The generator is a seeded PRNG (mulberry32 - a small, public-domain, deterministic generator; not a
 * dependency), so a failure is always reproducible from the printed seed/index, matching this
 * project's own "every test has teeth" rule: a real regression here fails loudly and repeatably, not
 * once in a blue moon in CI.
 */
import { describe, expect, it } from "vitest";

import { lexLine, type LexedLine, type MachineMode } from "../src/lex.js";
import { parseDocument, serializeDocument } from "../src/document.js";

const SEED = 0xc0ffee;
const LINES_PER_MODE = 10000;
const MAX_LINE_LENGTH = 40;

// The lexer's own alphabet (task 16's own list): letters, digits, and every character with special
// meaning somewhere in `lex.ts` - `;` (comment), `"` (quoted string), `{`/`}` (expression), `'`
// (escaped axis), `(`/`)` (CNC comment), `*` (checksum), space and tab.
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789;\"{}'()* \t";

/** mulberry32 - deterministic, seedable, good enough statistical quality for fuzzing (not crypto). */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function randomLine(rand: () => number): string {
	const length = Math.floor(rand() * MAX_LINE_LENGTH);
	let s = "";
	for (let i = 0; i < length; i++) s += ALPHABET[Math.floor(rand() * ALPHABET.length)];
	return s;
}

interface Span { start: number; end: number; label: string }

function topLevelSpans(line: LexedLine): Array<Span> {
	const spans: Array<Span> = [];
	if (line.lineNumber !== null) spans.push({ ...line.lineNumber, label: "lineNumber" });
	if (line.checksum !== null) spans.push({ ...line.checksum, label: "checksum" });
	if (line.comment !== null) spans.push({ ...line.comment, label: "comment" });
	for (const [i, bc] of line.bracketedComments.entries()) spans.push({ ...bc, label: `bracketedComment[${i}]` });
	for (const [i, cmd] of line.commands.entries()) spans.push({ start: cmd.start, end: cmd.end, label: `command[${i}]` });
	return spans;
}

function overlaps(a: Span, b: Span): boolean {
	return a.start < b.end && b.start < a.end;
}

function contains(a: Span, b: Span): boolean {
	return a.start <= b.start && b.end <= a.end;
}

/** True for a genuine indexing bug: two spans partially overlap without either fully containing the
 *  other. A `(...)` bracketed comment legitimately sits fully INSIDE a command's own span when it
 *  interrupts that command's parameter list mid-line (CNC mode allows this, and the command's own
 *  span correctly continues past it to any params written after the comment closes) - full
 *  containment is fine; a ragged, partial overlap never is, for any pair of spans on one line. */
function crosses(a: Span, b: Span): boolean {
	return overlaps(a, b) && !contains(a, b) && !contains(b, a);
}

function checkSpansInBoundsAndNonOverlapping(line: LexedLine, seedLabel: string): void {
	const len = line.raw.length;
	const top = topLevelSpans(line);
	for (const s of top) {
		expect(s.start, `${seedLabel} ${s.label}.start on ${JSON.stringify(line.raw)}`).toBeGreaterThanOrEqual(0);
		expect(s.end, `${seedLabel} ${s.label}.end on ${JSON.stringify(line.raw)}`).toBeLessThanOrEqual(len);
		expect(s.start, `${seedLabel} ${s.label} start<=end on ${JSON.stringify(line.raw)}`).toBeLessThanOrEqual(s.end);
	}
	for (let i = 0; i < top.length; i++) {
		for (let j = i + 1; j < top.length; j++) {
			const a = top[i];
			const b = top[j];
			// A bracketed comment may sit fully inside a command's own span (see `crosses`'s own
			// comment); every other pair of top-level spans must be strictly disjoint - two commands,
			// or a command and the line's `;` comment/checksum/line-number, never nest or partially
			// overlap.
			const bothContainmentAllowed = a.label.startsWith("bracketedComment") || b.label.startsWith("bracketedComment");
			const bad = bothContainmentAllowed ? crosses(a, b) : overlaps(a, b);
			expect(bad, `${seedLabel} ${a.label} vs ${b.label} on ${JSON.stringify(line.raw)}`).toBe(false);
		}
	}
	for (const cmd of line.commands) {
		const params = cmd.params.map((p, i) => ({ start: p.start, end: p.end, label: `param[${i}] ${p.letter}` }));
		for (const p of params) {
			expect(p.start, `${seedLabel} ${p.label}.start on ${JSON.stringify(line.raw)}`).toBeGreaterThanOrEqual(cmd.start);
			expect(p.end, `${seedLabel} ${p.label}.end on ${JSON.stringify(line.raw)}`).toBeLessThanOrEqual(len);
			expect(p.start, `${seedLabel} ${p.label} start<=end on ${JSON.stringify(line.raw)}`).toBeLessThanOrEqual(p.end);
		}
		for (let i = 0; i < params.length; i++) {
			for (let j = i + 1; j < params.length; j++) {
				expect(overlaps(params[i], params[j]), `${seedLabel} ${params[i].label} overlaps ${params[j].label} on ${JSON.stringify(line.raw)}`).toBe(false);
			}
		}
	}
}

describe.each<MachineMode>(["fff", "laser", "cnc"])("fuzz: lexLine never throws, spans are sane (%s mode)", (machineMode) => {
	it(`${LINES_PER_MODE} random lines from the lexer's own alphabet, seed 0x${SEED.toString(16)}`, () => {
		const rand = mulberry32(SEED ^ (machineMode === "fff" ? 0 : machineMode === "laser" ? 1 : 2));
		for (let i = 0; i < LINES_PER_MODE; i++) {
			const raw = randomLine(rand);
			const seedLabel = `[${machineMode} #${i}]`;
			let line: LexedLine;
			expect(() => { line = lexLine(raw, { machineMode }); }, `${seedLabel} lexLine threw on ${JSON.stringify(raw)}`).not.toThrow();
			line = lexLine(raw, { machineMode });
			checkSpansInBoundsAndNonOverlapping(line, seedLabel);
			for (const err of line.errors) {
				expect(err.start, `${seedLabel} error.start on ${JSON.stringify(raw)}`).toBeGreaterThanOrEqual(0);
				expect(err.end, `${seedLabel} error.end on ${JSON.stringify(raw)}`).toBeLessThanOrEqual(raw.length);
			}
		}
	});
});

describe("fuzz: parseDocument/serializeDocument round trip on the same random corpus", () => {
	it.each<MachineMode>(["fff", "laser", "cnc"])("holds byte-for-byte, %s mode", (machineMode) => {
		const rand = mulberry32(SEED ^ 0x5eed0000 ^ (machineMode === "fff" ? 0 : machineMode === "laser" ? 1 : 2));
		const lines: Array<string> = [];
		for (let i = 0; i < 2000; i++) lines.push(randomLine(rand));
		const text = lines.join("\n") + "\n";
		expect(() => parseDocument(text, { machineMode })).not.toThrow();
		const doc = parseDocument(text, { machineMode });
		expect(serializeDocument(doc)).toBe(text);
	});
});
