/**
 * Runs the release change events (`changes.ts`) over a set of a machine's own files and reports which
 * lines are affected by a firmware change between two versions: the engine behind a "your files use
 * something that changed between 3.6.3 and 3.7.0-rc.2" report.
 *
 * Pure, like everything here: the caller lists and downloads the files (`{ path, text }`), this module
 * classifies, parses and matches. `impactOf` does the per-document matching; this adds
 *  - file selection (`classifyFile`; menu files, `board.txt`, CSV/binary and print files are skipped),
 *  - grouping by event and by file, with a one-line snippet per occurrence,
 *  - an `acknowledged` bucket (events the user has already reviewed, kept visible rather than dropped),
 *  - `undetectable`: the events in range that `impactOf` can never match. A report that only listed
 *    what it found would read as "all clear" for a change it has no way to see, so a UI must show this.
 *
 * Coverage is the catalogue's, which is partial by nature ("known changes", never "your files are safe").
 */
import { GCODE_FILE_KINDS, classifyFile } from "../files/kinds.js";
import { parseDocument } from "../document.js";
import { compareFirmwareVersions } from "../versionCompare.js";
import { changesBetween, type DirectedChangeEvent } from "./changes.js";
import { collapseSuperseded, impactOf, isDetectable, type ImpactFinding } from "./impact.js";
import type { ChangeEvent } from "./schema.js";

export interface ScanFile {
	/** SD-card path; `0:/sys/config.g` and `/macros/x.g` both classify. */
	path: string;
	text: string;
}

/** One place in one file where a changed command, parameter, path or syntax feature is used. */
export interface ScanOccurrence {
	path: string;
	/** 0-based, like `ImpactFinding.line`. */
	line: number;
	/** Absolute offsets into the file's text (BOM already accounted for), like `ImpactFinding`. */
	start: number;
	end: number;
	/** The line's text, trimmed and cut to `SNIPPET_MAX` characters. */
	snippet: string;
	message: string;
}

export interface EventOccurrences {
	event: DirectedChangeEvent;
	occurrences: ReadonlyArray<ScanOccurrence>;
}

export interface FileOccurrences {
	path: string;
	occurrences: ReadonlyArray<ScanOccurrence & { event: DirectedChangeEvent }>;
}

export type SkipReason = "not-gcode" | "print-file";

export interface ImpactReport {
	from: string;
	to: string;
	direction: "upgrade" | "downgrade";
	/** Events with at least one occurrence, in version order, that the caller has not acknowledged. */
	byEvent: ReadonlyArray<EventOccurrences>;
	/** The same shape for events the caller listed in `options.acknowledged`. */
	acknowledged: ReadonlyArray<EventOccurrences>;
	/** Unacknowledged occurrences grouped by file, in path order, then line order. */
	byFile: ReadonlyArray<FileOccurrences>;
	/** Events in range that `impactOf` cannot match (see `isDetectable`). */
	undetectable: ReadonlyArray<DirectedChangeEvent>;
	skipped: ReadonlyArray<{ path: string; reason: SkipReason }>;
	totals: {
		filesScanned: number;
		filesSkipped: number;
		/** Events in range after superseded ones collapse (what `impactOf` considers). */
		eventsInRange: number;
		eventsCheckable: number;
		eventsUndetectable: number;
		/** Unacknowledged. */
		occurrences: number;
		filesAffected: number;
		eventsHit: number;
		acknowledgedOccurrences: number;
	};
}

export interface ScanOptions {
	/** Event ids the user has already reviewed or chosen to ignore. */
	acknowledged?: ReadonlySet<string> | ReadonlyArray<string>;
}

export const SNIPPET_MAX = 160;

/** Whether `scanFile` would look inside `path` at all. */
export function isScannable(path: string): { scan: true } | { scan: false; reason: SkipReason } {
	const c = classifyFile(path);
	if (c.kind === "print-file") return { scan: false, reason: "print-file" };
	if (c.syntax !== "gcode" || !GCODE_FILE_KINDS.has(c.kind)) return { scan: false, reason: "not-gcode" };
	return { scan: true };
}

/** One file's raw findings between two versions (`impactOf`), not yet grouped or filtered. */
export interface FileScan {
	path: string;
	findings: ReadonlyArray<ScanOccurrence & { event: DirectedChangeEvent }>;
}

function snippetOf(text: string, offset: number): string {
	let from = offset;
	while (from > 0 && text.charCodeAt(from - 1) !== 10 && text.charCodeAt(from - 1) !== 13) from--;
	let to = offset;
	while (to < text.length && text.charCodeAt(to) !== 10 && text.charCodeAt(to) !== 13) to++;
	const line = text.slice(from, to).trim();
	return line.length > SNIPPET_MAX ? `${line.slice(0, SNIPPET_MAX - 1)}…` : line;
}

/**
 * Scan ONE file: the unit a host can cache and run in a loop that yields between files. Returns `null`
 * for a file `isScannable` rejects. `from`/`to` may be given in either order (a downgrade is the same
 * call with the versions swapped, as `impactOf`).
 */
export function scanFile(file: ScanFile, from: string, to: string): FileScan | null {
	if (!isScannable(file.path).scan) return null;
	const doc = parseDocument(file.text);
	const findings = impactOf(doc, from, to).map((f: ImpactFinding) => {
		const lineStart = doc.lines[f.line].start;
		return {
			path: file.path,
			line: f.line,
			start: f.start,
			end: f.end,
			snippet: snippetOf(doc.text, lineStart),
			message: f.message,
			event: f.event as DirectedChangeEvent,
		};
	});
	return { path: file.path, findings };
}

function byVersionThenId(a: { event: ChangeEvent }, b: { event: ChangeEvent }): number {
	return compareFirmwareVersions(a.event.version, b.event.version) || (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0);
}

/** Group per-file scans into an `ImpactReport`. `scanImpact` is `scanFile` over each file, then this. */
export function buildImpactReport(
	scans: ReadonlyArray<FileScan>,
	skipped: ReadonlyArray<{ path: string; reason: SkipReason }>,
	from: string,
	to: string,
	options: ScanOptions = {},
): ImpactReport {
	const ack: ReadonlySet<string> = options.acknowledged === undefined
		? new Set()
		: options.acknowledged instanceof Set ? options.acknowledged : new Set(options.acknowledged);
	const direction: "upgrade" | "downgrade" = compareFirmwareVersions(from, to) <= 0 ? "upgrade" : "downgrade";
	const inRange = collapseSuperseded(changesBetween(from, to));
	const undetectable = inRange.filter((e) => !isDetectable(e));

	const live = new Map<string, { event: DirectedChangeEvent; occurrences: Array<ScanOccurrence> }>();
	const acked = new Map<string, { event: DirectedChangeEvent; occurrences: Array<ScanOccurrence> }>();
	const fileGroups: Array<FileOccurrences> = [];
	let occurrences = 0, ackOccurrences = 0;

	for (const scan of [...scans].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		const mine: Array<ScanOccurrence & { event: DirectedChangeEvent }> = [];
		for (const f of scan.findings) {
			const occurrence: ScanOccurrence = { path: f.path, line: f.line, start: f.start, end: f.end, snippet: f.snippet, message: f.message };
			const isAcked = ack.has(f.event.id);
			const bucket = isAcked ? acked : live;
			let group = bucket.get(f.event.id);
			if (group === undefined) {
				group = { event: f.event, occurrences: [] };
				bucket.set(f.event.id, group);
			}
			group.occurrences.push(occurrence);
			if (isAcked) {
				ackOccurrences++;
			} else {
				occurrences++;
				mine.push(f);
			}
		}
		if (mine.length > 0) {
			mine.sort((a, b) => a.line - b.line || a.start - b.start || byVersionThenId(a, b));
			fileGroups.push({ path: scan.path, occurrences: mine });
		}
	}

	const order = (m: Map<string, EventOccurrences & { occurrences: Array<ScanOccurrence> }>): Array<EventOccurrences> =>
		[...m.values()].sort(byVersionThenId).map((g) => ({ event: g.event, occurrences: g.occurrences.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0) || a.line - b.line || a.start - b.start) }));
	const byEvent = order(live);

	return {
		from, to, direction,
		byEvent,
		acknowledged: order(acked),
		byFile: fileGroups,
		undetectable,
		skipped,
		totals: {
			filesScanned: scans.length,
			filesSkipped: skipped.length,
			eventsInRange: inRange.length,
			eventsCheckable: inRange.length - undetectable.length,
			eventsUndetectable: undetectable.length,
			occurrences,
			filesAffected: fileGroups.length,
			eventsHit: byEvent.length,
			acknowledgedOccurrences: ackOccurrences,
		},
	};
}

/**
 * The whole thing: which lines of `files` are affected by the firmware changes between `from` and `to`
 * (either order). Both versions may carry a board's `(CAN0)` suffix or a `+N` build number; a version
 * that does not parse throws, as `compareFirmwareVersions` does - normalise or catch upstream.
 */
export function scanImpact(files: ReadonlyArray<ScanFile>, from: string, to: string, options: ScanOptions = {}): ImpactReport {
	const scans: Array<FileScan> = [];
	const skipped: Array<{ path: string; reason: SkipReason }> = [];
	for (const file of files) {
		const verdict = isScannable(file.path);
		if (!verdict.scan) {
			skipped.push({ path: file.path, reason: verdict.reason });
			continue;
		}
		const scan = scanFile(file, from, to);
		if (scan !== null) scans.push(scan);
	}
	return buildImpactReport(scans, skipped, from, to, options);
}
