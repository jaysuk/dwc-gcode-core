/**
 * Line-preserving G-code file editor — locate a directive in config.g (or a tool-change macro) and
 * replace it, replace one of its parameters, or append it, without disturbing anything else in the
 * file byte-for-byte.
 *
 * Merged from two copies that diverged after one was copied into the other: resonance-lab's
 * `src/config/gcodeEdit.ts` (the original) and duet-calibration-wizard's `src/model/gcodeEdit.ts`
 * (a superset — `setIndexedParam`, `planDirectiveEdit`, `findIncludes`, `resolveIncludePath` and
 * `planDirectiveEditAcrossFiles` were added there and never ported back). 89 lines were identical
 * between them; this is that code once, not twice.
 *
 * Deliberately conservative: a line inside a conditional or using `{...}` expression syntax (RRF
 * meta-gcode, e.g. `M572 D0 S{global.paValue}`) is flagged `unsafe` rather than silently mis-edited —
 * callers refuse those and tell the user to edit by hand. This module does not yet use this
 * package's own future `meta` classification (a later phase); `UNSAFE_LINE` is the same
 * conservative regex both source copies already used, unchanged.
 *
 * Pure, no Vue/host imports (deliberately self-contained, not built on `lex.ts`/`params.ts` — this
 * module's quote-masking is a naive toggle, not `lex.ts`'s `""`-escape-aware scan, but the two are
 * observably equivalent for finding an unquoted `;` in well-formed text: an escaped `""` pair is
 * always two characters wide, which is parity-neutral under a naive per-character toggle regardless
 * of whether the toggle "understands" the escape — traced through by hand before assuming otherwise).
 * A consuming plugin's own thin layer (its own `machineConfig.ts` / `configFile.ts`) does the actual
 * file I/O — reading, backing up, writing — through its host.
 */

export interface GcodeLine {
	/** Original line text, exactly as read (no line-ending characters). */
	raw: string;
	/** The directive word (e.g. "M955"), upper-cased. Null for blank lines and pure comments with no
	 *  directive text at all. Set even when `disabled` is true, so a commented-out directive is still
	 *  findable - `disabled` is what says whether it's currently active. */
	code: string | null;
	/** Single-letter parameters as written, quotes included for string values (e.g. P: '"mzv"'). */
	params: Record<string, string>;
	/** The whole line is a comment (starts with `;` after only whitespace) - a directive here, if
	 *  any, is not in effect. */
	disabled: boolean;
	/** Contains `{...}` expression syntax, or looks like flow control (if/elif/else/while/echo/abort)
	 *  - editing tools in this file must refuse to touch it. */
	unsafe: boolean;
}

/** Blank out the contents of "..." spans (replacing each character with a space) so a search for
 *  unquoted syntax - a parameter letter, a comment `;`, `{` - can't match text inside a quoted
 *  string value. Same length as the input, so match positions still index into the original text. */
function maskQuoted(s: string): string {
	let out = "";
	let inQuotes = false;
	for (let i = 0; i < s.length; i++) {
		const c = s[i];
		if (c === "\"") {
			inQuotes = !inQuotes;
			out += " ";
		} else {
			out += inQuotes ? " " : c;
		}
	}
	return out;
}

/** Split a line into its code+params portion and its trailing ";comment" (the first UNQUOTED
 *  semicolon onward, with no leading space - see `withComment`), so param parsing/editing can never
 *  match inside either a quoted value or a comment. */
function splitComment(raw: string): [body: string, comment: string] {
	const idx = maskQuoted(raw).indexOf(";");
	return idx === -1 ? [raw, ""] : [raw.slice(0, idx), raw.slice(idx)];
}

/** Reattach a comment split off by `splitComment`, inserting the separating space `comment` doesn't
 *  carry itself (it starts exactly at the `;`). A no-op when there's no comment at all. */
function withComment(body: string, comment: string): string {
	return comment ? `${body} ${comment}` : body;
}

const UNSAFE_LINE = /\{[^}]*\}|^\s*(if|elif|else|while|echo|abort)\b/i;

/** Parse a line's parameters after the directive word. Handles quoted string values and decimal
 *  numbers; not a general G-code parser (this module only ever edits well-formed directive lines
 *  like M955/M572/M593/M92 - `params.ts`'s `parseParams` is the general one, used by everything else
 *  in this package). */
function parseParams(afterCode: string): Record<string, string> {
	const params: Record<string, string> = {};
	const masked = maskQuoted(afterCode);
	const re = /[A-Za-z]/g;
	for (let m = re.exec(masked); m !== null; m = re.exec(masked)) {
		const start = m.index;
		if (start > 0 && !/\s/.test(masked[start - 1])) {
			continue; // a letter that isn't at a token boundary - part of something else, not a param
		}
		const letter = masked[start].toUpperCase();
		let end = start + 1;
		if (afterCode[end] === "\"") {
			end++;
			while (end < afterCode.length && afterCode[end] !== "\"") {
				end++;
			}
			end = Math.min(end + 1, afterCode.length);
		} else {
			while (end < afterCode.length && !/\s/.test(afterCode[end])) {
				end++;
			}
		}
		params[letter] = afterCode.slice(start + 1, end);
	}
	return params;
}

function parseLine(raw: string): GcodeLine {
	const disabled = /^[ \t]*;/.test(raw);
	const afterComment = disabled ? raw.replace(/^[ \t]*;[ \t]*/, "") : raw;
	const [body] = splitComment(afterComment);
	const trimmed = body.trimStart();
	const codeMatch = /^([A-Za-z][0-9]+(?:\.[0-9]+)?)\b/.exec(trimmed);
	const code = codeMatch ? codeMatch[1].toUpperCase() : null;
	const params = code ? parseParams(trimmed.slice(codeMatch![1].length)) : {};
	return { raw, code, params, disabled, unsafe: UNSAFE_LINE.test(raw) };
}

/** Whether a file most likely uses CRLF line endings, so a rewritten file matches. Any CRLF present
 *  is taken as CRLF - real config.g files are not a mix, and guessing conservatively wrong for a
 *  genuinely mixed file is no worse than any other heuristic here. */
export function detectEol(text: string): "\r\n" | "\n" {
	return text.includes("\r\n") ? "\r\n" : "\n";
}

export function parseLines(text: string): Array<GcodeLine> {
	return text.split(/\r\n|\n/).map(parseLine);
}

export function serializeLines(lines: Array<GcodeLine>, eol: "\r\n" | "\n"): string {
	return lines.map((l) => l.raw).join(eol);
}

/** Numeric-tolerant so `P121` (index 0 implied) matches a target of `"121.0"` and vice versa - a
 *  board's own accelerometer/driver ids are always `<n>` or `<n>.0`, which are the same float either
 *  way. Falls back to a quote-insensitive string compare for non-numeric values (e.g. M593's
 *  `P"mzv"`). */
function valuesEqual(actual: string | undefined, wanted: string): boolean {
	if (actual === undefined) {
		return false;
	}
	const na = Number(actual);
	const nb = Number(wanted);
	if (!Number.isNaN(na) && !Number.isNaN(nb)) {
		return na === nb;
	}
	return actual.replace(/^"|"$/g, "") === wanted.replace(/^"|"$/g, "");
}

export interface DirectiveMatch { index: number; line: GcodeLine }

/** Every line (active or commented-out) whose directive word matches, optionally filtered by
 *  parameter values. Returns both kinds deliberately - callers distinguish via `line.disabled` so
 *  the UI can say "there's also a disabled M593 above the one I changed" rather than silently
 *  ignoring it. */
export function findDirectives(lines: Array<GcodeLine>, code: string, matchParams: Record<string, string> = {}): Array<DirectiveMatch> {
	const upper = code.toUpperCase();
	const wanted = Object.entries(matchParams);
	const found: Array<DirectiveMatch> = [];
	lines.forEach((line, index) => {
		if (line.code !== upper) {
			return;
		}
		if (wanted.every(([k, v]) => valuesEqual(line.params[k], v))) {
			found.push({ index, line });
		}
	});
	return found;
}

/** Matches a numeric parameter value INCLUDING a colon-separated list (e.g. `E420:500`) — RRF's
 *  per-drive form for M92/M201/M203/M566 and others. A regex that only matched a single number would
 *  replace just the first element and corrupt the rest (`E420:500` -> `E397.2:500` broken into
 *  `E397.2` + stray `:500` text left dangling), so this must always be the one used to find a
 *  numeric param's full extent. This was the one real behaviour difference between the two source
 *  copies — resonance-lab's own `setParam` used a plain-number-only regex and had exactly this bug,
 *  latent because nothing there happened to call it on a colon-list value yet; merging picks
 *  calibration-wizard's colon-list-aware version for both consumers. */
const NUMERIC_LIST_VALUE = "-?[0-9]*\\.?[0-9]+(?::-?[0-9]*\\.?[0-9]+)*";

/**
 * Replace (or append) exactly one parameter token (e.g. `I` in `M955 P121.0 I20`, or the whole
 * colon-list `E` in `M92 E420:500`), leaving every other parameter, the directive word, spacing and
 * trailing comment untouched. Not for string parameters (M593's `P"mzv"`) - use `replaceDirective`
 * for those.
 */
export function setParam(raw: string, letter: string, value: string): string {
	const [body, comment] = splitComment(raw);
	const masked = maskQuoted(body);
	const upper = letter.toUpperCase();
	const re = new RegExp(`(^|\\s)(${upper})(${NUMERIC_LIST_VALUE})`, "i");
	const m = re.exec(masked);
	if (m) {
		// body.slice(end) already carries whatever space originally sat between the old value and the
		// comment (or end of line), so the comment reattaches directly - no separator to add here.
		const start = m.index + m[1].length;
		const end = start + m[2].length + m[3].length;
		return body.slice(0, start) + upper + value + body.slice(end) + comment;
	}
	// The append path replaces body's own trailing whitespace outright, so it DOES need withComment
	// to supply a fresh separator before the comment.
	return withComment(`${body.replace(/[ \t]+$/, "")} ${upper}${value}`, comment);
}

/**
 * Set ONE drive's value within a colon-separated parameter (e.g. the E1 slot of `M92 E420:500`),
 * preserving every other drive's value — never collapse the whole list down to the one value being
 * changed. If the parameter is currently a single number (RRF's "applies to all drives" form), it
 * is first expanded to `driveCount` copies of that number before the target index is overwritten,
 * mirroring RRF's own convention that a short list's last value covers the remaining drives.
 */
export function setIndexedParam(raw: string, letter: string, index: number, value: string, driveCount: number): string {
	const line = parseLine(raw);
	const current = line.params[letter.toUpperCase()];
	const parts = current !== undefined ? current.split(":") : [];
	const size = Math.max(driveCount, index + 1, parts.length);
	const filled: Array<string> = [];
	for (let i = 0; i < size; i++) {
		filled.push(parts[i] ?? parts[parts.length - 1] ?? value);
	}
	filled[index] = value;
	return setParam(raw, letter, filled.join(":"));
}

/** Replace a line's entire directive+params with `newDirective`, keeping its original indentation
 *  and trailing comment. For a directive whose few parameters are all replaced together (e.g. M593's
 *  `P F S`). */
export function replaceDirective(raw: string, newDirective: string): string {
	const indent = /^[ \t]*/.exec(raw)![0];
	const [, comment] = splitComment(raw);
	return withComment(`${indent}${newDirective}`, comment);
}

/** Append a new directive at the end of the file with an audit comment, for when none exists yet. */
export function appendDirective(lines: Array<GcodeLine>, directive: string, note: string): Array<GcodeLine> {
	return [...lines, parseLine(`; ${note}`), parseLine(directive)];
}

/** Replace one line by index without disturbing any other, re-deriving `code`/`params`/etc from the
 *  new text so the result stays as accurate as a freshly-parsed line (useful if a caller inspects it
 *  further; `serializeLines` itself only reads `.raw`). */
export function replaceLine(lines: Array<GcodeLine>, index: number, raw: string): Array<GcodeLine> {
	return lines.map((l, i) => (i === index ? parseLine(raw) : l));
}

/** Delete one line by index outright, leaving every other line (including any comment ABOVE it, such
 *  as an audit stamp this module itself appended) untouched. Unlike every other editing function
 *  here, this removes a directive entirely rather than replacing or adding one - for migrating a
 *  directive out of a file it no longer belongs in, not for any of the edit-in-place/append flows
 *  above. */
export function removeDirective(lines: Array<GcodeLine>, index: number): Array<GcodeLine> {
	return lines.filter((_, i) => i !== index);
}

export interface DiffLine { type: "same" | "added" | "removed"; text: string }

/**
 * Line-level diff between an original file and one of this module's own edits. Deliberately not a
 * general diff algorithm - `before`/`after` only ever differ by one changed line and/or lines
 * appended at the end (everything `setParam`/`replaceDirective`/`appendDirective` produce), so a
 * straight index-by-index walk is exact and there's no realignment-on-insertion case to get wrong.
 */
export function diffLines(before: Array<GcodeLine>, after: Array<GcodeLine>): Array<DiffLine> {
	const out: Array<DiffLine> = [];
	const max = Math.max(before.length, after.length);
	for (let i = 0; i < max; i++) {
		const b = before[i];
		const a = after[i];
		if (b && a && b.raw === a.raw) {
			out.push({ type: "same", text: a.raw });
			continue;
		}
		if (b) {
			out.push({ type: "removed", text: b.raw });
		}
		if (a) {
			out.push({ type: "added", text: a.raw });
		}
	}
	return out;
}

// ── plan builder ────────────────────────────────────────────────────────────────────────────────

export interface DirectiveEditPlan {
	before: string;
	after: string;
	diff: Array<DiffLine>;
	/** True when no active directive existed and this plan appends one. */
	appended: boolean;
	/** A commented-out copy was also found — worth mentioning. */
	disabledDuplicateFound: boolean;
	/** Set (with `after === before`) when the live directive is on a line the editor refuses to
	 *  touch. The caller should show this and not offer "save". */
	blocked?: string;
}

/**
 * Preview replacing (or appending) one directive in a SINGLE file's text. A thin single-file
 * convenience over `planDirectiveEditAcrossFiles` (below) — kept as its own export because most
 * callers (and most tests) only ever deal with one file's text, not config.g's M98 includes.
 *
 * @param match  exact parameter values that identify the line to edit (e.g. `{ D: "0" }` for the
 *   M572 of extruder 0). Pass `{}` to match the first line of that directive.
 * @param editLine  how to rewrite the matched line (usually `raw => replaceDirective(raw, newLine)`).
 * @param newDirectiveLine  the whole line to append if none exists.
 * @param stampNote  audit comment written above an appended directive.
 */
export function planDirectiveEdit(
	beforeText: string,
	code: string,
	match: Record<string, string>,
	editLine: (raw: string) => string,
	newDirectiveLine: string,
	stampNote: string,
): DirectiveEditPlan {
	return planDirectiveEditAcrossFiles([{ path: "", text: beforeText }], code, match, editLine, newDirectiveLine, stampNote);
}

// ── multi-file (config.g + its M98 includes) ──────────────────────────────────────────────────────

export interface NamedFile { path: string; text: string }

/**
 * Uncommented `M98 P"..."` targets in a file's text, in order — config.g on a machine that splits
 * its configuration up (e.g. `M98 P"config-tools.g"`) needs those files searched too, or a save
 * either misses the directive that's actually live or duplicates it into config.g alongside the
 * real one. Only `.g` targets are returned; non-macro M98 targets (rare) are not configuration.
 */
export function findIncludes(text: string): Array<string> {
	const paths: Array<string> = [];
	for (const line of parseLines(text)) {
		if (line.disabled || line.code !== "M98") continue;
		const p = line.params.P;
		if (!p) continue;
		const raw = p.replace(/^"|"$/g, "").trim();
		if (raw.toLowerCase().endsWith(".g")) paths.push(raw);
	}
	return paths;
}

/** Resolve an M98 P path the way RRF does: an explicit volume (`0:/...`) or a leading `/` is used
 *  as-is; a bare filename is relative to the system directory (config.g's own folder). */
export function resolveIncludePath(raw: string, sysDir: string): string {
	if (raw.includes(":")) return raw;
	if (raw.startsWith("/")) return `0:${raw}`;
	return `${sysDir}/${raw}`;
}

export interface MultiFileEditPlan extends DirectiveEditPlan {
	/** The file that will actually be written. */
	path: string;
	/** Every file that was searched, in order, for context in the UI. */
	searchedPaths: Array<string>;
}

/**
 * The same preview as `planDirectiveEdit`, but searching an ordered list of files (config.g first,
 * then its includes) for the ACTIVE directive — editing whichever file actually contains it, rather
 * than always assuming config.g. A commented-out duplicate found in any file is still reported. If
 * no active directive exists anywhere, the new one is appended to the FIRST file (config.g).
 */
export function planDirectiveEditAcrossFiles(
	files: Array<NamedFile>,
	code: string,
	match: Record<string, string>,
	editLine: (raw: string) => string,
	newDirectiveLine: string,
	stampNote: string,
): MultiFileEditPlan {
	const searchedPaths = files.map((f) => f.path);
	let disabledDuplicateFound = false;

	for (const file of files) {
		const before = parseLines(file.text);
		const matches = findDirectives(before, code, match);
		const active = matches.find((m) => !m.line.disabled);
		if (matches.some((m) => m.line.disabled)) disabledDuplicateFound = true;
		if (!active) continue;

		if (active.line.unsafe) {
			return {
				path: file.path, before: file.text, after: file.text, diff: [], appended: false,
				disabledDuplicateFound, searchedPaths,
				blocked: `The active ${code} line in ${file.path} uses {...} expression syntax or sits inside `
					+ "a conditional — edit it by hand for this one, it isn't safe to rewrite automatically.",
			};
		}
		const afterLines = replaceLine(before, active.index, editLine(active.line.raw));
		return {
			path: file.path,
			before: file.text,
			after: serializeLines(afterLines, detectEol(file.text)),
			diff: diffLines(before, afterLines),
			appended: false,
			disabledDuplicateFound,
			searchedPaths,
		};
	}

	// Not found active anywhere — append to the first file (config.g).
	const target = files[0];
	const before = parseLines(target.text);
	const afterLines = appendDirective(before, newDirectiveLine, stampNote);
	return {
		path: target.path,
		before: target.text,
		after: serializeLines(afterLines, detectEol(target.text)),
		diff: diffLines(before, afterLines),
		appended: true,
		disabledDuplicateFound,
		searchedPaths,
	};
}
