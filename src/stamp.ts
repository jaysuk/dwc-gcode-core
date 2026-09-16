/**
 * The user's own decision (2026-09-14): "every file that's parsed should get a comment of which
 * firmware version it was parsed against and probably the version of the plugin that did it, in
 * case we need to reparse due to plugin bugs." One format, owned here, so every plugin reads and
 * writes the same thing.
 *
 * Facts this design rests on, each verified directly against RRF source (not assumed):
 *  - **A stamp line doesn't interfere with slicer metadata detection in print files.**
 *    `Storage/FileInfoParser.cpp`'s `ScanBuffer` (read end to end for this task) scans every
 *    comment line in the header chunk for a known slicer key phrase — it does NOT require the
 *    phrase to be on line 1, or stop looking once it's seen one non-matching comment. It only stops
 *    the HEADER scan on an actual `G`/`M`/`T` command line. So a `;`-comment stamp inserted before a
 *    slicer's own signature comment is invisible to this scan, wherever it lands.
 *  - **Height-map and probe-points files must never be stamped** — confirmed in task 08's own
 *    `heightmap.ts`: `HeightMap::LoadFromFile` requires line 1 to start with `HeightMapComment` (or
 *    `PointsFileComment`) exactly, then the label line, then parameters — inserting anything before
 *    that breaks loading outright.
 *  - **Menu files tolerate a `;` comment line** — task 08's `menu.ts`, from `Menu::ParseMenuLine`.
 *  - **A DWC plugin id can contain a literal space** — `DuetWebControl/src/plugins/index.ts`'s
 *    `checkManifest` (`id.length <= 32` and `/[a-zA-Z0-9 .\-_]/` per character) allows it. The stamp
 *    format is space-separated `key=value` pairs, so plugin id and version are percent-encoded
 *    (`encodeURIComponent`) to keep the line parseable regardless.
 *
 * Format — exactly one `;` comment line:
 * ```
 * ; dwc-gcode-core: checked rrf=3.7.0-rc.1 plugin=GCodePostProcessor@1.2.1 core=0.6.0 at=2026-09-14T10:00:00Z
 * ```
 * `plugin` is `<percent-encoded id>@<percent-encoded version>` — `@` is never itself percent-encoded
 * by `encodeURIComponent` in a way that could collide with this, and a real DWC plugin id can't
 * contain a literal `@` at all (see `checkManifest` above), so splitting the `plugin` value on the
 * FIRST `@` is always unambiguous. Unknown `key=value` pairs are preserved on read (`extra`) and
 * ignored — this package doesn't currently write any, but a future version, or another tool sharing
 * this exact stamp line, might.
 */

import {
	applyEdits, editInsertLines, editReplaceLine, parseDocument, serializeDocument, type GcodeDocument,
} from "./document.js";
import { compareFirmwareVersions } from "./firmware.js";
import type { FileKind } from "./files/kinds.js";
import { CORE_VERSION } from "./version.js";

export interface Stamp {
	rrf: string;
	pluginId: string;
	pluginVersion: string;
	core: string;
	at: string;
	extra: Readonly<Record<string, string>>;
	/** 0-based index of the stamp line within the file. */
	line: number;
}

/** The fields needed to WRITE a stamp - `Stamp` minus `core` (always this package's own
 *  `CORE_VERSION`, never a caller-supplied value) and `line` (only meaningful once a stamp is
 *  actually placed in a real file). */
export interface StampInput {
	rrf: string;
	pluginId: string;
	pluginVersion: string;
	at: string;
	extra?: Record<string, string>;
}

export class StampNotAllowedError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "StampNotAllowedError";
	}
}

const STAMP_MARKER = "dwc-gcode-core: checked";
const STAMP_LINE_RE = /^;\s*dwc-gcode-core:\s*checked\s*(.*)$/;
const POSTPROCESSED_BY_RE = /^;\s*postprocessed-by:/i;

/** Kinds this package will actually write a stamp to — gcode and menu syntax only (task 08's
 *  `FileKind`/`FileSyntax`). CSV, plain text and binary files are never stamped: `heightmap.csv`/
 *  `probePoints.csv` can't tolerate an extra line at all (see the module doc comment), and stamping
 *  `eventlog.txt` or an unrecognised file would just be noise with nothing to re-check. */
const STAMPABLE_KINDS: ReadonlySet<FileKind> = new Set([
	"config", "config-override", "system-macro", "user-macro",
	"filament-config", "filament-load", "filament-unload",
	"print-file", "menu",
]);

export function stampable(kind: FileKind): boolean {
	return STAMPABLE_KINDS.has(kind);
}

// Narrower than `encodeURIComponent`, deliberately: the stamp's own grammar (space-separated
// key=value pairs) only breaks on a literal space, '%' or '=' in a value - a colon (the "at"
// timestamp's own separator) or anything else stays as plain, readable text, matching the format
// exactly as written in this module's own doc comment and `docs/tasks/09-stamp.md`.
function encodeField(value: string): string {
	return value.replace(/%/g, "%25").replace(/ /g, "%20").replace(/=/g, "%3D");
}
function decodeField(value: string): string {
	// Reverse order from encodeField, so a literal '%' that was escaped first doesn't get its OWN
	// "%25" mistaken for one of the other two escapes introduced afterwards.
	return value.replace(/%3D/g, "=").replace(/%20/g, " ").replace(/%25/g, "%");
}

/**
 * Formats one stamp as its exact `;`-comment line — no document parsing, no insertion logic. Exported
 * for a caller that builds output as a stream and can never hold a whole file in memory to hand
 * `writeStamp` (e.g. a chunked Blob read/write pipeline): such a caller emits this as its own first
 * output line itself, the same way it already emits its own idempotency marker if it has one - see
 * `writeStamp`'s own doc comment for the ordering convention (after an existing `; postprocessed-by:`
 * line) a streaming caller should replicate by construction, not by calling into this package.
 * `writeStamp` itself is unchanged and remains the right choice whenever the whole file text is
 * already in memory, since it also handles replacing an existing stamp rather than accumulating one.
 */
export function formatStampLine(stamp: StampInput): string {
	const parts = [
		`rrf=${encodeField(stamp.rrf)}`,
		`plugin=${encodeField(stamp.pluginId)}@${encodeField(stamp.pluginVersion)}`,
		`core=${encodeField(CORE_VERSION)}`,
		`at=${encodeField(stamp.at)}`,
	];
	if (stamp.extra) {
		for (const [k, v] of Object.entries(stamp.extra)) parts.push(`${k}=${encodeField(v)}`);
	}
	return `; ${STAMP_MARKER} ${parts.join(" ")}`;
}

/** Parses `key=value key=value ...` (space-separated, no quoting - a value that needed a literal
 *  space was percent-encoded when written). Tolerant: a token with no `=` is skipped, not an error. */
function parseFields(body: string): Record<string, string> {
	const fields: Record<string, string> = {};
	for (const token of body.trim().split(/\s+/)) {
		if (token.length === 0) continue;
		const eq = token.indexOf("=");
		if (eq === -1) continue;
		fields[token.slice(0, eq)] = token.slice(eq + 1);
	}
	return fields;
}

function findStampLine(doc: GcodeDocument): number | null {
	const limit = Math.min(doc.lines.length, 20);
	for (let i = 0; i < limit; i++) {
		if (STAMP_LINE_RE.test(doc.lines[i].raw.trimStart())) return i;
	}
	return null;
}

/** Reads the stamp from `text`, if any is present in the first 20 lines. Tolerant of leading
 *  whitespace on the stamp line and of CRLF/mixed line endings (via `document.ts`'s own line
 *  splitting). Returns null when there's no stamp, or the line found doesn't have all four required
 *  fields (`rrf`, `plugin`, `core`, `at`) - a partially hand-edited stamp is treated as absent
 *  rather than guessed at. */
export function readStamp(text: string): Stamp | null {
	const doc = parseDocument(text);
	const lineIndex = findStampLine(doc);
	if (lineIndex === null) return null;

	const match = STAMP_LINE_RE.exec(doc.lines[lineIndex].raw.trimStart());
	const fields = parseFields(match![1]);
	const { rrf, plugin, core, at, ...rest } = fields;
	if (rrf === undefined || plugin === undefined || core === undefined || at === undefined) return null;

	const atSign = plugin.indexOf("@");
	if (atSign === -1) return null;
	const pluginId = decodeField(plugin.slice(0, atSign));
	const pluginVersion = decodeField(plugin.slice(atSign + 1));

	const extra: Record<string, string> = {};
	for (const [k, v] of Object.entries(rest)) extra[k] = decodeField(v);

	return { rrf: decodeField(rrf), pluginId, pluginVersion, core: decodeField(core), at: decodeField(at), extra, line: lineIndex };
}

/**
 * Writes (or replaces) the stamp in `text`. Throws {@link StampNotAllowedError} for a `kind` that
 * must never be stamped (see `stampable`). If a stamp already exists in the first 20 lines, that
 * line is replaced in place (never accumulates); otherwise the stamp is inserted as the new first
 * line — after a UTF-8 BOM (handled by `document.ts`'s own line offsets) and after an existing
 * `; postprocessed-by:` line, so the two coexist without disturbing each other.
 */
export function writeStamp(text: string, stamp: StampInput, kind: FileKind): string {
	if (!stampable(kind)) {
		throw new StampNotAllowedError(`"${kind}" files must never be stamped`);
	}
	const doc = parseDocument(text);
	const line = formatStampLine(stamp);

	const existing = findStampLine(doc);
	if (existing !== null) {
		return serializeDocument(applyEdits(doc, [editReplaceLine(doc, existing, line)]));
	}

	const insertAt = doc.lines[0] !== undefined && POSTPROCESSED_BY_RE.test(doc.lines[0].raw) ? 1 : 0;
	return serializeDocument(applyEdits(doc, [editInsertLines(doc, insertAt, [line])]));
}

export type RecheckReason =
	| { kind: "unstamped" }
	| { kind: "firmware-upgraded" | "firmware-downgraded"; from: string; to: string }
	| { kind: "plugin-changed"; pluginId: string; from: string; to: string }
	| { kind: "core-changed"; from: string; to: string };

/**
 * Why a stamped (or unstamped) file might need re-checking. A stamp written by a DIFFERENT plugin
 * than `current.pluginId` is deliberately not itself a reason (per the user's own decision) - only a
 * version change under the SAME plugin id counts as `plugin-changed`; no consumer need for a
 * separate "different plugin entirely" reason surfaced while building this, so none was added (see
 * `docs/tasks/09-stamp.md`'s Findings).
 */
export function recheckReasons(stamp: Stamp | null, current: { rrf: string; pluginId: string; pluginVersion: string }): ReadonlyArray<RecheckReason> {
	if (stamp === null) return [{ kind: "unstamped" }];

	const reasons: Array<RecheckReason> = [];
	if (stamp.rrf !== current.rrf) {
		const cmp = compareFirmwareVersions(stamp.rrf, current.rrf);
		if (cmp !== 0) {
			reasons.push({ kind: cmp < 0 ? "firmware-upgraded" : "firmware-downgraded", from: stamp.rrf, to: current.rrf });
		}
	}
	if (stamp.pluginId === current.pluginId && stamp.pluginVersion !== current.pluginVersion) {
		reasons.push({ kind: "plugin-changed", pluginId: current.pluginId, from: stamp.pluginVersion, to: current.pluginVersion });
	}
	if (stamp.core !== CORE_VERSION) {
		reasons.push({ kind: "core-changed", from: stamp.core, to: CORE_VERSION });
	}
	return reasons;
}
