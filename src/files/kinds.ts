/**
 * Classifies a file by its SD-card path into one of RRF's own well-known roles, or `"other"` for
 * anything unrecognised. Every row cited to where RRF itself names or uses the file — see
 * `docs/file-kinds.md` for the full inventory this is built from (read from RRF `3.7.0-rc.1` source
 * directly, not the wiki or guessed from extensions), including two corrections it made to this
 * task's own draft list: `load.g`/`unload.g`/a filament's own `config.g` live ONLY under
 * `filaments/<name>/`, never in `/sys`; and `filament-error.g` is a constant RRF defines but never
 * actually invokes in this baseline (real filament-monitor errors go through the Event system now).
 *
 * Path input is tolerant of how a caller likely has it: with or without a leading `0:` volume
 * prefix, with or without a leading `/`, and either a full path or just a bare filename (the common
 * case once a plugin already knows which directory it's listing) — matching by exact filename
 * happens before matching by directory, so `classifyFile("heightmap.csv")` and
 * `classifyFile("0:/sys/heightmap.csv")` both classify the same way.
 */

export type FileSyntax = "gcode" | "menu" | "csv" | "text" | "binary";

export type FileKind =
	| "config"
	| "config-override"
	| "system-macro"
	| "user-macro"
	| "filament-config"
	| "filament-load"
	| "filament-unload"
	| "print-file"
	| "menu"
	| "menu-image"
	| "height-map"
	| "probe-points"
	| "event-log"
	| "accelerometer-data"
	| "other"
	| "out-of-scope";

export interface ClassifiedFile {
	kind: FileKind;
	syntax: FileSyntax;
	/** Set only for `kind: "system-macro"` — which role it plays (`"bed"`, `"home"`, `"tpre"`, ...). */
	role?: string;
}

function basename(path: string): string {
	const idx = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
	return idx === -1 ? path : path.slice(idx + 1);
}

function normalise(path: string): Array<string> {
	// Strip an "0:"-style volume prefix and any leading slash, then split into segments, dropping
	// empty ones (a leading "/" or doubled separators).
	const withoutVolume = path.replace(/^[A-Za-z0-9]*:/, "");
	return withoutVolume.split(/[/\\]+/).filter((s) => s.length > 0);
}

/** Fixed (non-numbered) `/sys` filenames — `docs/file-kinds.md`'s own table, each row cited there. */
const SYS_FIXED: ReadonlyMap<string, { kind: FileKind; role?: string }> = new Map([
	["config.g", { kind: "config" }],
	["config.g.bak", { kind: "config" }],
	["config-override.g", { kind: "config-override" }],
	["bed.g", { kind: "system-macro", role: "bed" }],
	["mesh.g", { kind: "system-macro", role: "mesh" }],
	["pause.g", { kind: "system-macro", role: "pause" }],
	["resume.g", { kind: "system-macro", role: "resume" }],
	["cancel.g", { kind: "system-macro", role: "cancel" }],
	["start.g", { kind: "system-macro", role: "start" }],
	["stop.g", { kind: "system-macro", role: "stop" }],
	["daemon.g", { kind: "system-macro", role: "daemon" }],
	["runonce.g", { kind: "system-macro", role: "runonce" }],
	["resurrect.g", { kind: "system-macro", role: "resurrect" }],
	["resurrect-prologue.g", { kind: "system-macro", role: "resurrect-prologue" }],
	["filament-change.g", { kind: "system-macro", role: "filament-change" }],
	["filament-error.g", { kind: "system-macro", role: "filament-error" }], // defined but unused in 3.7.0-rc.1 - see module doc comment
	["homeall.g", { kind: "system-macro", role: "homeall" }],
]);

/** Numbered/lettered `/sys` filename patterns: prefix + optional index + `.g`. */
const SYS_NUMBERED: ReadonlyArray<{ prefix: string; role: string }> = [
	{ prefix: "deployprobe", role: "deployprobe" },
	{ prefix: "retractprobe", role: "retractprobe" },
	{ prefix: "tfree", role: "tfree" },
	{ prefix: "tpre", role: "tpre" },
	{ prefix: "tpost", role: "tpost" },
	{ prefix: "trigger", role: "trigger" },
];

/** `home<letter>.g`, or `home'<letter>.g` for an already-lowercase-configured axis letter
 *  (`Kinematics::GetHomingFileName`'s escaping rule — see docs/file-kinds.md). */
const HOME_AXIS_RE = /^home'?[a-z]\.g$/i;

/** RRF's "Custom GCodes" mechanism (`GCodes::TryMacroFile`): an otherwise-unimplemented command's
 *  own macro, named after the command itself. */
const CUSTOM_CODE_RE = /^[GMT][0-9]+(\.[0-9]+)?\.g$/i;

function classifySysFile(name: string): ClassifiedFile | null {
	const lower = name.toLowerCase();
	const fixed = SYS_FIXED.get(lower);
	if (fixed !== undefined) return { ...fixed, syntax: "gcode" };
	for (const { prefix, role } of SYS_NUMBERED) {
		if (lower === `${prefix}.g` || new RegExp(`^${prefix}[0-9]+\\.g$`).test(lower)) {
			return { kind: "system-macro", role, syntax: "gcode" };
		}
	}
	if (HOME_AXIS_RE.test(name)) return { kind: "system-macro", role: "home", syntax: "gcode" };
	if (CUSTOM_CODE_RE.test(name)) return { kind: "system-macro", role: "custom-code", syntax: "gcode" };
	return null;
}

const MENU_IMAGE_EXTENSIONS: ReadonlySet<string> = new Set(["img", "xbm", "bmp"]);

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

export function classifyFile(path: string): ClassifiedFile {
	const name = basename(path);
	const lowerName = name.toLowerCase();

	// Exact-filename matches that are unambiguous regardless of which directory they're found in -
	// so a caller can classify a bare filename it already knows the directory of.
	if (lowerName === "heightmap.csv") return { kind: "height-map", syntax: "csv" };
	if (lowerName === "probepoints.csv") return { kind: "probe-points", syntax: "csv" };
	if (lowerName === "eventlog.txt") return { kind: "event-log", syntax: "text" };

	const segments = normalise(path);
	const top = segments[0]?.toLowerCase();

	if (top === "firmware") return { kind: "out-of-scope", syntax: "binary" };
	if (top === "www") return { kind: "out-of-scope", syntax: "binary" };

	if (top === "filaments" && segments.length >= 3) {
		if (lowerName === "config.g") return { kind: "filament-config", syntax: "gcode" };
		if (lowerName === "load.g") return { kind: "filament-load", syntax: "gcode" };
		if (lowerName === "unload.g") return { kind: "filament-unload", syntax: "gcode" };
	}

	// RRF's own menu root is the fixed `MENU_DIR` ("0:/menu/", Config/Configuration.h:304); matching
	// any "menu" segment (not just a leading one) also tolerates a caller passing a path relative to
	// that root already. Classify by whether it looks like an image asset a menu references.
	if (segments.some((s) => s.toLowerCase() === "menu")) {
		if (MENU_IMAGE_EXTENSIONS.has(extensionOf(name))) return { kind: "menu-image", syntax: "binary" };
		return { kind: "menu", syntax: "menu" };
	}

	if (top === "accelerometer" || segments.some((s) => s.toLowerCase() === "accelerometer")) {
		if (extensionOf(name) === "csv") return { kind: "accelerometer-data", syntax: "csv" };
	}

	if (top === "gcodes") return { kind: "print-file", syntax: "gcode" };

	if (top === "sys" || top === undefined || segments.length === 1) {
		const sysFile = classifySysFile(name);
		if (sysFile !== null) return sysFile;
		if (extensionOf(name) === "g") return { kind: "user-macro", syntax: "gcode" };
	}

	if (top === "macros") {
		return { kind: "user-macro", syntax: "gcode" };
	}

	const ext = extensionOf(name);
	if (ext === "g" || ext === "gcode") return { kind: "user-macro", syntax: "gcode" };
	if (ext === "csv") return { kind: "other", syntax: "csv" };
	return { kind: "other", syntax: "text" };
}
