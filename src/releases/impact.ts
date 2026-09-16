/**
 * Matches release change events against a real document (task 12, `docs/tasks/12-release-model.md`):
 * commands and parameters present (task 06's `GcodeDocument`), object-model paths and a couple of
 * expression-syntax features used in expressions (task 07's `ExprNode`).
 *
 * Coverage is intentionally partial, not a false claim of completeness:
 *  - `target.type === "command"` / `"parameter"`: exact, from the document's own lexed commands.
 *  - `target.type === "objectModelPath"`: exact, from `expressionsOfLine`'s already-extracted paths.
 *  - `target.type === "syntax"`: only the two features this module can actually recognise in an AST
 *    (`"array-literal"` - an `ExprNode` of type `"array"`; `"array-concat"` - any `^` binary operator,
 *    flagged whenever `^` appears at all, not only when both operands are provably arrays, since that
 *    can depend on a variable's runtime value this module can't know statically - the finding's own
 *    `message` says so). Any other `syntax` event's `feature` id is not detectable here and is
 *    silently skipped, not a false positive OR a false confidence of absence.
 *  - `target.type === "behaviour"`: only when the event names a `code` - matched at the same
 *    granularity as a bare command target (this module can't distinguish which BEHAVIOUR of a
 *    command a document triggers, only that the command appears at all).
 */
import type { DocumentLine, GcodeDocument } from "../document.js";
import { expressionsOfLine } from "../document.js";
import type { ExprNode } from "../expr/parse.js";
import { compareFirmwareVersions } from "../versionCompare.js";
import { changesBetween, type DirectedChangeEvent } from "./changes.js";
import { targetKey, type ChangeEvent } from "./schema.js";

export interface ImpactFinding {
	event: ChangeEvent;
	direction: "upgrade" | "downgrade";
	line: number;
	start: number;
	end: number;
	message: string;
}

function message(event: ChangeEvent, direction: "upgrade" | "downgrade"): string {
	const verb = direction === "upgrade"
		? (event.kind === "removed" ? "will stop working" : event.kind === "deprecated" ? "is deprecated" : "changes")
		: (event.kind === "added" ? "is not available" : event.kind === "deprecated" ? "was not yet deprecated" : "behaves differently");
	return `${event.description} (${verb} at ${direction === "upgrade" ? "the target version" : "the target (older) version"})`;
}

/** The two `syntax` features this module can actually recognise in an expression's own AST. */
const RECOGNISABLE_SYNTAX_FEATURES: ReadonlySet<string> = new Set(["array-literal", "array-concat"]);

function walkForSyntax(node: ExprNode, line: number, out: Array<{ feature: string; start: number; end: number }>): void {
	if (node.type === "array") {
		out.push({ feature: "array-literal", start: node.start, end: node.end });
		for (const item of node.items) walkForSyntax(item, line, out);
	} else if (node.type === "binary") {
		if (node.op === "^") out.push({ feature: "array-concat", start: node.start, end: node.end });
		walkForSyntax(node.left, line, out);
		walkForSyntax(node.right, line, out);
	} else if (node.type === "unary") {
		walkForSyntax(node.operand, line, out);
	} else if (node.type === "ternary") {
		walkForSyntax(node.test, line, out);
		walkForSyntax(node.then, line, out);
		walkForSyntax(node.else, line, out);
	} else if (node.type === "call") {
		for (const arg of node.args) walkForSyntax(arg, line, out);
	} else if (node.type === "path") {
		for (const seg of node.segments) if (typeof seg !== "string") walkForSyntax(seg, line, out);
	}
}

function matchesCommand(line: DocumentLine, code: string): Array<{ start: number; end: number }> {
	return line.commands.filter((c) => c.code === code).map((c) => ({ start: c.start, end: c.end }));
}

function matchesParameter(line: DocumentLine, code: string, letter: string): Array<{ start: number; end: number }> {
	const spans: Array<{ start: number; end: number }> = [];
	for (const cmd of line.commands) {
		if (cmd.code !== code) continue;
		for (const p of cmd.params) {
			if (p.letter.toUpperCase() === letter.toUpperCase()) spans.push({ start: p.start, end: p.end });
		}
	}
	return spans;
}

/**
 * A user can jump between ANY two tagged (or hypothetical, e.g. "3.7.0-rc.1+1") RRF versions in one
 * check - `changesBetween` already returns every event in the range, not just ones at versions this
 * package happens to have other data for. That means the same target can appear more than once in one
 * `events` list if RRF changed it, then changed it AGAIN, before the query's destination version - the
 * real case this collapses: M955's P is capped to 0 at 3.7.0-rc.1, then uncapped at 3.7.0-rc.1+1.
 * Jumping straight from 3.7.0-beta.3 to 3.7.0-rc.1+1 must not warn about the capping - it's already
 * gone again by the time the file lands there. Grouped by `targetKey` (so two events must target the
 * exact same thing to collapse together - see that function's own doc comment for why that matters),
 * keeping whichever is closest to the DESTINATION version: upgrading, that's the latest (its version is
 * literally what's true once you arrive); downgrading, it's the earliest (crossing back below it undoes
 * everything after it at once, so the earliest is the first - and only - thing that actually changes).
 * `changesBetween` itself is left returning the full, uncollapsed history - this collapsing is specific
 * to "does my file need attention right now", which is what `impactOf` answers.
 */
function collapseSuperseded(events: ReadonlyArray<DirectedChangeEvent>): ReadonlyArray<DirectedChangeEvent> {
	if (events.length <= 1) return events;
	const direction = events[0].direction; // one changesBetween() call, so every event shares a direction
	const byTarget = new Map<string, DirectedChangeEvent>();
	for (const e of events) {
		const key = targetKey(e.target);
		const existing = byTarget.get(key);
		if (existing === undefined) {
			byTarget.set(key, e);
			continue;
		}
		const eIsNewer = compareFirmwareVersions(e.version, existing.version) > 0;
		if (direction === "upgrade" ? eIsNewer : !eIsNewer) {
			byTarget.set(key, e);
		}
	}
	return [...byTarget.values()].sort((a, b) => compareFirmwareVersions(a.version, b.version) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * Every `ImpactFinding` from applying `changesBetween(fromVersion, toVersion)` to `doc` - a command,
 * parameter, object-model path or recognisable syntax feature the document actually uses that also
 * changed somewhere in that version range. See this module's own header for exactly what "somewhere
 * in that range" can and can't detect, and `collapseSuperseded` above for how a target changed more
 * than once in the same range is handled.
 */
export function impactOf(doc: GcodeDocument, fromVersion: string, toVersion: string): ReadonlyArray<ImpactFinding> {
	const events = collapseSuperseded(changesBetween(fromVersion, toVersion));
	if (events.length === 0) return [];

	const commandEvents = events
		.map((e) => ({ event: e, code: e.target.type === "command" ? e.target.code : e.target.type === "behaviour" ? e.target.code : undefined }))
		.filter((x): x is { event: (typeof events)[number]; code: string } => x.code !== undefined);
	const paramEvents = events.filter((e) => e.target.type === "parameter");
	const pathEvents = events.filter((e) => e.target.type === "objectModelPath");
	const syntaxEvents = events.filter((e) => e.target.type === "syntax" && RECOGNISABLE_SYNTAX_FEATURES.has(e.target.feature));

	const findings: Array<ImpactFinding> = [];

	for (const line of doc.lines) {
		for (const { event, code } of commandEvents) {
			for (const span of matchesCommand(line, code)) {
				findings.push({ event, direction: event.direction, line: line.index, start: span.start, end: span.end, message: message(event, event.direction) });
			}
		}
		for (const event of paramEvents) {
			if (event.target.type !== "parameter") continue;
			for (const span of matchesParameter(line, event.target.code, event.target.letter)) {
				findings.push({ event, direction: event.direction, line: line.index, start: span.start, end: span.end, message: message(event, event.direction) });
			}
		}

		if (pathEvents.length === 0 && syntaxEvents.length === 0) continue;
		for (const { expression } of expressionsOfLine(doc, line.index)) {
			for (const event of pathEvents) {
				if (event.target.type !== "objectModelPath") continue;
				for (const ref of expression.objectModelPaths) {
					if (ref.path === event.target.path) {
						findings.push({ event, direction: event.direction, line: line.index, start: ref.start, end: ref.end, message: message(event, event.direction) });
					}
				}
			}
			if (syntaxEvents.length > 0) {
				const found: Array<{ feature: string; start: number; end: number }> = [];
				walkForSyntax(expression.ast, line.index, found);
				for (const event of syntaxEvents) {
					if (event.target.type !== "syntax") continue;
					for (const hit of found) {
						if (hit.feature === event.target.feature) {
							const msg = event.target.feature === "array-concat"
								? `${message(event, event.direction)} - only if both sides of ^ here are arrays`
								: message(event, event.direction);
							findings.push({ event, direction: event.direction, line: line.index, start: hit.start, end: hit.end, message: msg });
						}
					}
				}
			}
		}
	}

	return findings;
}
