/**
 * The machine's whole SD-card configuration as one graph: which files run which other files
 * (`Project.calls`), and which numbered/named resource each command defines or references
 * (`Project.symbols`). Task 13, `docs/tasks/13-project-model.md` — every invocation route below is
 * cited in `docs/invocation-table.md`, read from RRF 3.7.0-rc.1 source directly, not guessed from
 * example files.
 *
 * **Static analysis only** (this task's own decision): a call or symbol use inside an `if`/`elif`/
 * `else`/`while` block is recorded with `conditional: true`, never resolved further - this module
 * never knows which branch actually runs. A resource number written as an `{...}` expression is
 * recorded as `dynamic: true` and its `to`/`id` is the literal expression text, not a guess at what
 * it evaluates to.
 *
 * `path` values throughout are compared case-insensitively after stripping any `<digit>:` volume
 * prefix and normalising slashes - RRF's own SD card storage is FAT, which is case-insensitive at
 * the filesystem layer (a fact about the storage medium, not something in RRF's own C++ string
 * handling to cite line-by-line); `0:/sys/config.g` and `/SYS/CONFIG.G` are the same file to this
 * module for exactly that reason.
 */
import { parseAssignment } from "./meta.js";
import { classifyFile, type FileKind } from "./files/kinds.js";
import { parseMenu, type MenuDocument } from "./files/menu.js";
import { commandSpec } from "./dictionary/commands.js";
import {
	expressionsOfLine, parseDocument, type Block, type DocumentLine, type GcodeDocument,
} from "./document.js";
import type { LexedCommand, LexedParam, MachineMode } from "./lex.js";
import { unquoteString } from "./params.js";
import { lookupPinName } from "./pins/tables.js";

export interface ProjectFile {
	path: string;
	text: string;
}

export interface ProjectOptions {
	machineMode?: MachineMode;
	firmwareVersion?: string;
	/** Board(s) in play, keyed by CAN address (`0` = the mainboard) - needed to resolve a pin alias to
	 *  its canonical identity (task 17, Part B, Decision 7) before two different alias spellings can
	 *  be recognised as the same physical pin. Omitting an address falls back to raw normalised-string
	 *  comparison for pins on that board, rather than failing outright - a real, if weaker, signal is
	 *  still better than none. */
	boards?: ReadonlyMap<number, string>;
}

export interface SymbolSite {
	file: string;
	line: number;
	start: number;
	end: number;
	conditional: boolean;
	dynamic: boolean;
}

export interface ProjectSymbol {
	/** e.g. "tool", "heater", "sensor", "fan", "axis", "endstop", "driver", "extruder", "probe",
	 *  "accelerometer", "spindle", "ledStrip", "gpin", "gpout", "global", "filament", "pin" (task 17,
	 *  Part B - every reviewed `kind: "pin"` parameter site, generically, the same way "axis" is
	 *  derived off `axisParameters` rather than hand-listed). */
	type: string;
	/** e.g. "1" for a numbered resource, an axis letter for an axis/endstop, a name for a global or
	 *  a filament, the literal `{...}` expression text when `dynamic` on that site is true, or (for
	 *  "pin") `"<CAN address>.<canonical or raw pin name>"` - see `pinSymbolIdentity`. */
	id: string;
	definitions: ReadonlyArray<SymbolSite>;
	uses: ReadonlyArray<SymbolSite>;
}

export interface ProjectCall {
	from: { file: string; line: number };
	/** The resolved (canonical) path this call targets - the literal `{...}` expression text if
	 *  `dynamic`, otherwise always populated even when `resolved` is false (the path that WOULD be
	 *  opened, per `docs/invocation-table.md`, whether or not it's actually present in this project). */
	to: string;
	/** True when `to` names a file present in `Project.files` (case/volume-prefix-insensitive). */
	resolved: boolean;
	dynamic: boolean;
	/** Which invocation route this is, e.g. "M98", "G28-homeall", "T-tfree", "M701". */
	via: string;
}

export interface Project {
	files: ReadonlyMap<string, { kind: FileKind; doc: GcodeDocument | MenuDocument | null; text: string }>;
	calls: ReadonlyArray<ProjectCall>;
	symbols: ReadonlyArray<ProjectSymbol>;
}

// ── path canonicalisation ───────────────────────────────────────────────────────────────────────

/** Strips a `<digit>:` volume prefix and any leading slash, lowercases, and collapses backslashes to
 *  forward slashes - the form every path is compared in. `0:/sys/config.g`, `/sys/config.g` and
 *  `sys/config.g` (relative to the SD root) all canonicalise to `sys/config.g`. */
function canonicalPath(path: string): string {
	let p = path.replace(/\\/g, "/");
	if (/^\d+:/.test(p)) p = p.slice(p.indexOf(":") + 1);
	if (p.startsWith("/")) p = p.slice(1);
	return p.toLowerCase();
}

/** RRF's configured system-macro directory (`Platform::GetSysDir()`) is `/sys/` by default and can
 *  be changed at runtime (`M505`) - this module doesn't track a run's own `M505` history (a
 *  file-order-dependent, stateful fact static analysis can't resolve in general), so every route
 *  resolves against the factory-default `sys/` always. Documented as a real, deliberate scope limit
 *  in `docs/tasks/13-project-model.md`'s Findings, not silently assumed. */
const SYS_DIR = "sys";

/** RRF's own path resolution for a macro name (`docs/invocation-table.md`'s shared preamble):
 *  absolute (a `<digit>:` prefix or a leading `/`) is used as-is; anything else is relative to
 *  `SYS_DIR` - every route in the table resolves through `Platform::OpenSysFile`, never a
 *  caller-supplied directory. Mirrors `edit.ts`'s own `resolveIncludePath`, verified against source
 *  in `docs/invocation-table.md`'s own preamble. */
function resolveMacroPath(raw: string, rootRelative = false): string {
	if (/^\d+:/.test(raw) || raw.startsWith("/") || rootRelative) return canonicalPath(raw);
	return canonicalPath(`${SYS_DIR}/${raw}`);
}

// ── conditional-ness ────────────────────────────────────────────────────────────────────────────

/** Whether `line` sits strictly inside the body of some `if`/`elif`/`else`/`while` block (not ON the
 *  keyword line itself, which is what decides whether the body runs, not part of the body). Walks
 *  the whole block tree, since a call/use can be nested arbitrarily deep. */
function isConditional(blocks: ReadonlyArray<Block>, line: number): boolean {
	const CONDITIONAL_KEYWORDS = new Set(["if", "elif", "else", "while"]);
	for (const block of blocks) {
		if (CONDITIONAL_KEYWORDS.has(block.keyword) && line > block.line && line <= block.endLine) return true;
		if (line >= block.line && line <= block.endLine && isConditional(block.children, line)) return true;
	}
	return false;
}

// ── invocation routes ───────────────────────────────────────────────────────────────────────────

function paramValue(cmd: LexedCommand, letter: string): LexedParam | null {
	return cmd.params.find((p) => p.letter.toUpperCase() === letter) ?? null;
}

function isDynamic(param: LexedParam): boolean {
	return param.kind === "expression";
}

/** A parameter's own literal text with quotes stripped, for a filename/name argument. Returns null
 *  (never a guess) for an expression - callers must check `isDynamic` first and use the raw
 *  `param.value` as the recorded (unresolved) id/path in that case. */
function literalString(param: LexedParam): string | null {
	if (param.kind === "expression") return null;
	return unquoteString(param.value.trim());
}

function literalNumber(param: LexedParam): number | null {
	if (param.kind !== "number") return null;
	const n = Number(param.value);
	return Number.isFinite(n) ? n : null;
}

/**
 * One raw call before resolution. `to` is either a literal filename or (if `dynamic`) the raw
 * expression text of the parameter that produced it. `chain` groups a command's own try-then-
 * fall-back candidates (a tool change tries `tfree<N>.g`, falling back to bare `tfree.g`) - members
 * of the same chain, in try order, share one `chain` id; `resolveCalls` below keeps whichever
 * candidate in a chain actually resolves, or the FIRST one if none do, matching RRF's own order.
 * `rootRelative` is true for the few routes (`M701`/`M702`) that resolve against the SD card's own
 * root rather than the system-macro directory every other route in the table uses.
 */
interface RawCall { to: string; dynamic: boolean; via: string; chain: string; rootRelative?: boolean }

/**
 * Every file this ONE command invokes, per `docs/invocation-table.md`. Multiple entries for one
 * command are real (a tool change tries `tfree<N>.g` and, if that's absent, falls back to bare
 * `tfree.g` - `resolveCalls` below checks both and keeps whichever actually resolves, recording the
 * first-tried path if neither does, exactly matching RRF's own fallback order).
 */
function rawCallsFor(cmd: LexedCommand): Array<RawCall> {
	const calls: Array<RawCall> = [];

	// `T0`'s own LexedCommand.code is the literal string "T0" (task 10's dictionary needed the same
	// fix for commandSpec()'s own lookup) - every T-code route below keys off `cmd.letter`, not
	// `cmd.code`, for exactly that reason.
	if (cmd.letter === "T") {
		if (cmd.number !== null) {
			const n = cmd.number;
			calls.push({ to: `tfree${n}.g`, dynamic: false, via: "T-tfree", chain: "tfree" });
			calls.push({ to: "tfree.g", dynamic: false, via: "T-tfree-fallback", chain: "tfree" });
			calls.push({ to: `tpre${n}.g`, dynamic: false, via: "T-tpre", chain: "tpre" });
			calls.push({ to: "tpre.g", dynamic: false, via: "T-tpre-fallback", chain: "tpre" });
			calls.push({ to: `tpost${n}.g`, dynamic: false, via: "T-tpost", chain: "tpost" });
			calls.push({ to: "tpost.g", dynamic: false, via: "T-tpost-fallback", chain: "tpost" });
		}
		return calls; // bare "T" (report current tool) invokes nothing
	}

	switch (cmd.code) {
		case "M98": {
			const p = paramValue(cmd, "P");
			if (p === null) break;
			if (isDynamic(p)) { calls.push({ to: p.value, dynamic: true, via: "M98", chain: "m98" }); break; }
			const name = literalString(p);
			if (name !== null) calls.push({ to: name, dynamic: false, via: "M98", chain: "m98" });
			break;
		}
		case "G28": {
			const axisLetters = cmd.params.filter((p) => !["N"].includes(p.letter.toUpperCase()));
			if (axisLetters.length === 0) {
				calls.push({ to: "homeall.g", dynamic: false, via: "G28-homeall", chain: "g28" });
			} else {
				for (const p of axisLetters) {
					const letter = p.letter.toLowerCase();
					// A `'`-escaped axis whose plain letter is ALREADY lowercase needs the literal
					// apostrophe RRF's own Kinematics::GetHomingFileName writes (docs/invocation-table.md).
					const fileLetter = p.escapedAxis ? `'${letter}` : letter;
					calls.push({ to: `home${fileLetter}.g`, dynamic: false, via: "G28-home-axis", chain: `g28-${letter}` });
				}
			}
			break;
		}
		case "M701":
		case "M702": {
			const s = paramValue(cmd, "S");
			const macro = cmd.code === "M701" ? "load.g" : "unload.g";
			if (s !== null) {
				if (isDynamic(s)) { calls.push({ to: `filaments/${s.value}/${macro}`, dynamic: true, via: cmd.code, chain: cmd.code, rootRelative: true }); break; }
				const name = literalString(s);
				if (name !== null) calls.push({ to: `filaments/${name}/${macro}`, dynamic: false, via: cmd.code, chain: cmd.code, rootRelative: true });
			}
			// With no S, RRF acts on the current tool's already-loaded filament - not statically knowable.
			break;
		}
		case "M703":
			// Acts on the current tool's loaded filament - never statically knowable which one.
			break;
		case "G29":
			if (cmd.params.length === 0) calls.push({ to: "mesh.g", dynamic: false, via: "G29-mesh", chain: "g29" });
			break;
		case "G32":
			calls.push({ to: "bed.g", dynamic: false, via: "G32", chain: "g32" });
			break;
		case "M0":
		case "M1":
		case "M2":
			calls.push({ to: "cancel.g", dynamic: false, via: "M0-cancel", chain: "m0" });
			calls.push({ to: "stop.g", dynamic: false, via: "M0-stop-fallback", chain: "m0" });
			break;
		case "M24": {
			const p = paramValue(cmd, "P");
			const skip = p !== null && !isDynamic(p) && literalNumber(p) === 0;
			if (!skip) calls.push({ to: "resume.g", dynamic: false, via: "M24", chain: "m24" });
			break;
		}
		case "M25":
		case "M226":
		case "M601":
			calls.push({ to: "pause.g", dynamic: false, via: "M25-pause", chain: "m25" });
			break;
		case "M600":
			calls.push({ to: "filament-change.g", dynamic: false, via: "M600", chain: "m600" });
			calls.push({ to: "pause.g", dynamic: false, via: "M600-fallback", chain: "m600" });
			break;
		case "M501":
			calls.push({ to: "config-override.g", dynamic: false, via: "M501", chain: "m501" });
			break;
		case "M502":
			calls.push({ to: "config.g", dynamic: false, via: "M502", chain: "m502" });
			break;
		case "M581": {
			// M581 configures a trigger; the file that runs when it FIRES is trigger<T>.g, T being the
			// trigger number this same line names.
			const t = paramValue(cmd, "T");
			if (t !== null && !isDynamic(t)) {
				const n = literalNumber(t);
				if (n !== null) calls.push({ to: `trigger${n}.g`, dynamic: false, via: "M581", chain: "m581" });
			}
			break;
		}
		default:
			break;
	}
	return calls;
}

// ── symbol definitions/uses ─────────────────────────────────────────────────────────────────────

interface SymbolRule {
	/** "*" matches any command whose dictionary entry declares generic `axisParameters` - used for
	 *  the axis symbol type, which is otherwise unmanageable to hand-list (dozens of commands accept
	 *  axis letters). */
	code: string;
	letter: string;
	type: string;
	/** `{ ifLetterPresent }` is for the real "this line only creates the resource when a companion
	 *  letter is ALSO given, otherwise it's reconfiguring one that must already exist" shape - e.g.
	 *  `M308 S<n>` only creates a sensor when `Y` is also on the same line (`Heat::ConfigureSensor`'s
	 *  `if (gb.Seen('Y'))`); `S` alone expects sensor `<n>` to already be defined. Same-line-scoped
	 *  only, matching RRF's own `gb.Seen(...)` check - never a file-order or project-state condition. */
	role: "define" | "use" | { ifLetterPresent: string; else: "use" };
	list: boolean;
}

function roleFor(rule: SymbolRule, cmd: LexedCommand): "define" | "use" {
	if (typeof rule.role === "string") return rule.role;
	return paramValue(cmd, rule.role.ifLetterPresent) !== null ? "define" : rule.role.else;
}

/**
 * Which command+letter combinations define or reference which symbol type - confirmed against the
 * dictionary (task 10) and RRF source directly. Not exhaustive over every symbol type task 13's own
 * Decisions list (LED strips, GPIO and filament monitors are real gaps here, not silently claimed -
 * see this module's own Findings in `docs/tasks/13-project-model.md`), but every row here is real.
 */
const SYMBOL_RULES: ReadonlyArray<SymbolRule> = [
	// tool
	{ code: "M563", letter: "P", type: "tool", role: "define", list: false },
	{ code: "T", letter: "T", type: "tool", role: "use", list: false }, // the command number itself, handled specially below
	{ code: "G10", letter: "P", type: "tool", role: "use", list: false },
	{ code: "M568", letter: "P", type: "tool", role: "use", list: false },
	{ code: "M567", letter: "P", type: "tool", role: "use", list: false },
	{ code: "M116", letter: "P", type: "tool", role: "use", list: true },
	{ code: "M207", letter: "P", type: "tool", role: "use", list: false },
	// heater - M950 H<n> only (re)creates the heater when C (pin name) is also seen on the same line
	// (Heat::ConfigureHeater's `if (gb.Seen('C'))`); H alone expects heater <n> to already exist.
	// NOT modelled: `C"nil"` inside that same block DELETES the heater rather than creating it - a
	// real, rarer edge case this project model doesn't track (it has no delete concept anywhere else
	// either), so `M950 H0 C"nil"` is still recorded as a "define" site here.
	{ code: "M950", letter: "H", type: "heater", role: { ifLetterPresent: "C", else: "use" }, list: false },
	{ code: "M563", letter: "H", type: "heater", role: "use", list: true },
	{ code: "M140", letter: "H", type: "heater", role: "use", list: true },
	{ code: "M141", letter: "H", type: "heater", role: "use", list: true },
	{ code: "M307", letter: "H", type: "heater", role: "use", list: false },
	{ code: "M143", letter: "H", type: "heater", role: "use", list: false },
	{ code: "M104", letter: "T", type: "tool", role: "use", list: false },
	// sensor - M308 S<n> only (re)creates the sensor when Y (type name) is also seen on the same line
	// (Heat::ConfigureSensor's `if (gb.Seen('Y'))`); S alone expects sensor <n> to already exist. NOT
	// modelled: `P"nil"` (a separate, earlier branch in the same handler) deletes the sensor instead -
	// same documented limitation as M950's H/C below.
	{ code: "M308", letter: "S", type: "sensor", role: { ifLetterPresent: "Y", else: "use" }, list: false },
	{ code: "M143", letter: "T", type: "sensor", role: "use", list: false },
	{ code: "G31", letter: "H", type: "sensor", role: "use", list: false },
	// fan
	{ code: "M950", letter: "F", type: "fan", role: "define", list: false },
	{ code: "M106", letter: "P", type: "fan", role: "use", list: false },
	{ code: "M563", letter: "F", type: "fan", role: "use", list: true },
	// Z probe
	{ code: "M558", letter: "K", type: "probe", role: "define", list: false },
	{ code: "G30", letter: "K", type: "probe", role: "use", list: false },
	{ code: "G31", letter: "K", type: "probe", role: "use", list: false },
	{ code: "M574", letter: "K", type: "probe", role: "use", list: false },
	// accelerometer
	{ code: "M955", letter: "P", type: "accelerometer", role: "define", list: false },
	{ code: "M956", letter: "P", type: "accelerometer", role: "use", list: false },
	// spindle
	{ code: "M950", letter: "R", type: "spindle", role: "define", list: false },
	{ code: "M563", letter: "R", type: "spindle", role: "use", list: false },
	// GPIO (definitions only - no reference sites currently tracked, see Findings). BOTH `S` and `P`
	// define a gpout port, and the SAME one for a given number: RRF's `Platform::ConfigurePort`
	// indexes one `gpoutPorts[gpioNumber]` array from either letter (`Platform.cpp:4123-4132`), the
	// only difference being the servo flag it passes (`true` for `S`, `false` for `P`). Leaving `P`
	// out meant the plain GPIO-output form - the commoner of the two in real configs - produced no
	// symbol at all.
	{ code: "M950", letter: "J", type: "gpin", role: "define", list: false },
	{ code: "M950", letter: "S", type: "gpout", role: "define", list: false },
	{ code: "M950", letter: "P", type: "gpout", role: "define", list: false },
	// LED strip (definitions only)
	{ code: "M950", letter: "E", type: "ledStrip", role: "define", list: false },
	// extruder
	{ code: "M563", letter: "D", type: "extruder", role: "use", list: true },
	{ code: "M572", letter: "D", type: "extruder", role: "use", list: true },
	{ code: "M221", letter: "D", type: "extruder", role: "use", list: false },
	// driver
	{ code: "M569", letter: "P", type: "driver", role: "use", list: true },
];

/** Axis letters found via each command's own dictionary `axisParameters` entry, rather than a
 *  hand-maintained list of every axis-accepting command (there are dozens - `dictionary/
 *  commands.json` already marks exactly which ones via task 10's own `axisParameters` field). `M584`
 *  DEFINES the axis it names; every other command with `axisParameters` USES it. `M574` additionally
 *  defines the same letter as an "endstop" symbol (a distinct type per task 13's own Decisions),
 *  since that's specifically what configures the axis's endstop. */
function axisSymbolSites(cmd: LexedCommand, spec: ReturnType<typeof commandSpec>): Array<{ letter: string; type: string; role: "define" | "use"; param: LexedParam }> {
	if (spec?.axisParameters === undefined) return [];
	const known = new Set(spec.parameters.map((p) => p.letter.toUpperCase()));
	const sites: Array<{ letter: string; type: string; role: "define" | "use"; param: LexedParam }> = [];
	for (const p of cmd.params) {
		const letter = p.letter.toUpperCase();
		if (known.has(letter)) continue; // a named parameter, not a generic axis letter
		sites.push({ letter, type: "axis", role: cmd.code === "M584" ? "define" : "use", param: p });
		if (cmd.code === "M574") sites.push({ letter, type: "endstop", role: "define", param: p });
	}
	return sites;
}

/** RRF's own literal for "no pin"/"free this pin" (`RepRapFirmware.h`'s `NoPinName = "nil"`), matched
 *  case-insensitively the same way `LookupPinName` itself does (`StringEqualsIgnoreCase`) - a
 *  `rrfpins-txt` board additionally accepts `"NoPin"` as a synonym (`BoardConfig.cpp`'s own
 *  `LookupPinName`), also covered here since it costs nothing to recognise on every board. Freeing a
 *  pin is never a conflict, so this identity is never tracked as a symbol site at all. */
function isNoPinName(text: string): boolean {
	const lower = text.toLowerCase();
	return lower === "nil" || lower === "nopin";
}

/**
 * Normalises a raw `kind: "pin"` parameter value into a stable identity for duplicate-pin comparison
 * (task 17, Part B, Decision 5/7), or `null` for `"nil"`/`"NoPin"` (frees a pin, never a conflict).
 * Mirrors `IoPort::Allocate` (`Hardware/IoPorts.cpp`), confirmed unchanged between the mainline
 * (`3.7.0-rc.1`) and the community/TGBTC fork's own branch (`upstream/v3.7-dev`) - the same modifier-
 * stripping and CAN-address-prefix parsing applies to a pin name on EITHER board family, before
 * either platform's own `LookupPinName` is ever reached:
 *  - Strips leading `!`/`^`/`*` modifiers, in any combination/order (`IoPort::Allocate`'s own loop).
 *  - A leading `<digits>.` is a CAN-expansion board-address prefix (defaults to `0`, the mainboard,
 *    when absent) - kept as part of the identity, since the same base name on two different boards is
 *    never a real conflict.
 *  - Resolves the remaining text through that board's own pin table (`lookupPinName`, task 17 Step
 *    5/6) when `boards` names one for this address, so two different aliases for the SAME physical
 *    pin (e.g. `lcdmiso`/`miso`, task 17's own Findings) collapse to one identity. Without a board
 *    mapping for this address, falls back to the modifier-stripped raw text itself - a real, if
 *    weaker, signal rather than refusing to track the pin at all.
 */
function pinSymbolIdentity(rawValue: string, boards: ReadonlyMap<number, string> | undefined): string | null {
	let text = unquoteString(rawValue.trim());
	for (;;) {
		if (text[0] === "!" || text[0] === "^" || text[0] === "*") { text = text.slice(1); continue; }
		break;
	}
	if (isNoPinName(text)) return null;

	let boardAddress = 0;
	const addressMatch = text.match(/^(\d+)\.(.+)$/);
	let baseName = text;
	if (addressMatch !== null) {
		boardAddress = Number(addressMatch[1]);
		baseName = addressMatch[2];
	}
	const boardId = boards?.get(boardAddress);
	const resolved = boardId !== undefined ? lookupPinName(boardId, baseName) : null;
	return `${boardAddress}.${resolved !== null ? resolved.canonicalName : baseName}`;
}

/** Every reviewed command's `kind: "pin"` parameter, generically off the dictionary itself - the same
 *  approach `axisSymbolSites` already uses for `axisParameters`, rather than hand-listing the (small
 *  but real, task 17's own Findings) set of pin-bearing commands. Always `role: "use"` - assigning a
 *  pin isn't "defining" it the way a tool/heater number is; `project/pin-already-used` (task 17 Step
 *  8) is what makes a SECOND use interesting, a different shape than the numbered-resource rules. */
function pinSymbolSites(cmd: LexedCommand, spec: ReturnType<typeof commandSpec>, boards: ReadonlyMap<number, string> | undefined): Array<{ id: string; param: LexedParam }> {
	if (spec === null) return [];
	const sites: Array<{ id: string; param: LexedParam }> = [];
	for (const paramSpec of spec.parameters) {
		if (paramSpec.kind !== "pin") continue;
		const param = paramValue(cmd, paramSpec.letter);
		if (param === null || param.kind === "expression") continue; // absent, or dynamic - not resolvable statically
		const pieces = paramSpec.list ? param.value.split(":") : [param.value];
		for (const piece of pieces) {
			if (piece.trim().length === 0) continue;
			const id = pinSymbolIdentity(piece, boards);
			if (id !== null) sites.push({ id, param });
		}
	}
	return sites;
}

class SymbolTable {
	private readonly byKey = new Map<string, { type: string; id: string; definitions: Array<SymbolSite>; uses: Array<SymbolSite> }>();

	add(type: string, id: string, role: "define" | "use", site: SymbolSite): void {
		const key = `${type}:${id}`;
		let entry = this.byKey.get(key);
		if (entry === undefined) {
			entry = { type, id, definitions: [], uses: [] };
			this.byKey.set(key, entry);
		}
		(role === "define" ? entry.definitions : entry.uses).push(site);
	}

	toArray(): Array<ProjectSymbol> {
		return [...this.byKey.values()].sort((a, b) => (a.type === b.type ? (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) : a.type < b.type ? -1 : 1));
	}
}

function siteFor(path: string, line: DocumentLine, param: LexedParam, conditionalBlocks: ReadonlyArray<Block>): SymbolSite {
	return {
		file: path, line: line.index,
		start: line.start + param.start, end: line.start + param.end,
		conditional: isConditional(conditionalBlocks, line.index),
		dynamic: param.kind === "expression",
	};
}

function idFor(param: LexedParam): string {
	return param.kind === "expression" ? param.value : param.value;
}

function addSymbolsForCommand(table: SymbolTable, path: string, doc: GcodeDocument, line: DocumentLine, cmd: LexedCommand, boards: ReadonlyMap<number, string> | undefined): void {
	const spec = commandSpec(cmd.code);

	// The one hand-special-cased site: T<n>'s own command number is itself a tool "use", not a letter
	// parameter - GCodes2.cpp's HandleTcode reads it as gb.GetCommandNumber(), not gb.Seen('T').
	if (cmd.letter === "T" && cmd.number !== null) {
		table.add("tool", String(cmd.number), "use", {
			file: path, line: line.index, start: line.start + cmd.start, end: line.start + cmd.end,
			conditional: isConditional(doc.blocks, line.index), dynamic: false,
		});
	}

	for (const rule of SYMBOL_RULES) {
		if (rule.code !== cmd.code) continue;
		const param = paramValue(cmd, rule.letter);
		if (param === null) continue;
		const role = roleFor(rule, cmd);
		if (rule.list && param.kind !== "expression") {
			// A colon list of literal numbers becomes one site per element - each is independently a
			// real definition/use, and `dwc-gcode-core/params.js`'s own list convention (task 05) is
			// "a letter inside the list is a new parameter", so a genuinely mixed list (some literal,
			// some `{...}`) would already have been split into separate LexedParams by lexLine itself;
			// what's left here is a single param's own `:`-joined literal text.
			for (const piece of param.value.split(":")) {
				if (piece.length === 0) continue;
				table.add(rule.type, piece.trim(), role, siteFor(path, line, param, doc.blocks));
			}
		} else {
			table.add(rule.type, idFor(param), role, siteFor(path, line, param, doc.blocks));
		}
	}

	for (const site of axisSymbolSites(cmd, spec)) {
		table.add(site.type, site.letter, site.role, siteFor(path, line, site.param, doc.blocks));
	}

	for (const site of pinSymbolSites(cmd, spec, boards)) {
		table.add("pin", site.id, "use", siteFor(path, line, site.param, doc.blocks));
	}
}

/** `global`/`var`/`set` (task 06's `parseAssignment`) and `{global....}` references (task 07's
 *  `expressionsOfLine`) - the one symbol type this module can track with full expression-level
 *  precision, since both halves already exist from earlier tasks. `var.` (function-local) is
 *  deliberately NOT tracked as a project-wide symbol - it never outlives the file/macro invocation
 *  it's declared in, so cross-file definitions/uses don't apply to it the way they do to `global.`. */
function addGlobalSymbols(table: SymbolTable, path: string, doc: GcodeDocument): void {
	for (const line of doc.lines) {
		if (line.meta === "global") {
			const assignment = parseAssignment(line.raw);
			if (assignment !== null && assignment.scope === "global") {
				table.add("global", assignment.name, "define", {
					file: path, line: line.index,
					start: line.start + assignment.nameStart, end: line.start + assignment.nameEnd,
					conditional: isConditional(doc.blocks, line.index), dynamic: false,
				});
			}
		}
		for (const { expression } of expressionsOfLine(doc, line.index)) {
			for (const v of expression.variables) {
				if (v.scope !== "global") continue;
				table.add("global", v.name, "use", {
					file: path, line: line.index, start: v.start, end: v.end,
					conditional: isConditional(doc.blocks, line.index), dynamic: false,
				});
			}
		}
	}
}

/** A filament is "defined" by the mere existence of its own `0:/filaments/<name>/` directory in the
 *  project (task 08's `classifyFile` already recognises the three file kinds under it) - referenced
 *  by `M701`/`M702`'s `S` parameter name. */
function addFilamentSymbols(table: SymbolTable, files: ReadonlyMap<string, { path: string; kind: FileKind }>, docs: ReadonlyMap<string, { path: string; doc: GcodeDocument }>): void {
	for (const { path, kind } of files.values()) {
		if (kind !== "filament-config" && kind !== "filament-load" && kind !== "filament-unload") continue;
		const parts = path.split("/");
		const idx = parts.findIndex((p) => p.toLowerCase() === "filaments");
		const name = idx !== -1 && parts.length > idx + 1 ? parts[idx + 1] : null;
		if (name === null) continue;
		table.add("filament", name, "define", { file: path, line: 0, start: 0, end: 0, conditional: false, dynamic: false });
	}
	for (const { path, doc } of docs.values()) {
		for (const line of doc.lines) {
			for (const cmd of line.commands) {
				if (cmd.code !== "M701" && cmd.code !== "M702") continue;
				const s = paramValue(cmd, "S");
				if (s === null) continue;
				const name = s.kind === "expression" ? s.value : literalString(s);
				if (name !== null) {
					table.add("filament", name, "use", siteFor(path, line, s, doc.blocks));
				}
			}
		}
	}
}

// ── loadProject ─────────────────────────────────────────────────────────────────────────────────

export function loadProject(files: ReadonlyArray<ProjectFile>, options?: ProjectOptions): Project {
	const byPath = new Map<string, { path: string; kind: FileKind; text: string }>();
	for (const f of files) {
		byPath.set(canonicalPath(f.path), { path: f.path, kind: classifyFile(f.path).kind, text: f.text });
	}

	const resultFiles = new Map<string, { kind: FileKind; doc: GcodeDocument | MenuDocument | null; text: string }>();
	const gcodeDocs = new Map<string, GcodeDocument>();
	const filamentFiles = new Map<string, { path: string; kind: FileKind }>();

	for (const [canon, entry] of byPath) {
		const syntax = classifyFile(entry.path).syntax;
		let doc: GcodeDocument | MenuDocument | null = null;
		if (syntax === "gcode") {
			const parsed = parseDocument(entry.text, { machineMode: options?.machineMode });
			doc = parsed;
			gcodeDocs.set(canon, parsed);
		} else if (syntax === "menu") {
			doc = parseMenu(entry.text);
		}
		resultFiles.set(entry.path, { kind: entry.kind, doc, text: entry.text });
		if (entry.kind === "filament-config" || entry.kind === "filament-load" || entry.kind === "filament-unload") {
			filamentFiles.set(canon, { path: entry.path, kind: entry.kind });
		}
	}

	// ── calls ──
	const calls: Array<ProjectCall> = [];
	for (const [canon, doc] of gcodeDocs) {
		const original = byPath.get(canon)!.path;
		for (const line of doc.lines) {
			for (const cmd of line.commands) {
				const raw = rawCallsFor(cmd);
				if (raw.length === 0) continue;

				// Group by `chain`, preserving first-seen order - each chain is either one call or a
				// try-then-fall-back sequence (T's tfree/tpre/tpost, M0's cancel/stop, M600's
				// filament-change/pause). A dynamic call is always its own chain of one (rawCallsFor
				// never mixes a dynamic candidate into a literal fallback chain).
				const chains = new Map<string, Array<RawCall>>();
				for (const r of raw) {
					const group = chains.get(r.chain);
					if (group === undefined) chains.set(r.chain, [r]);
					else group.push(r);
				}

				for (const group of chains.values()) {
					const first = group[0];
					if (first.dynamic) {
						calls.push({
							from: { file: original, line: line.index }, to: first.to,
							resolved: false, dynamic: true, via: first.via,
						});
						continue;
					}
					// Keep whichever candidate actually resolves in this project; if none do, report
					// the FIRST-TRIED path as unresolved, matching RRF's own try-then-fall-back order.
					let chosen = group[group.length - 1];
					for (const candidate of group) {
						const resolvedPath = resolveMacroPath(candidate.to, candidate.rootRelative);
						if (byPath.has(resolvedPath)) { chosen = candidate; break; }
					}
					const resolvedPath = resolveMacroPath(chosen.to, chosen.rootRelative);
					calls.push({
						from: { file: original, line: line.index }, to: resolvedPath,
						resolved: byPath.has(resolvedPath), dynamic: false, via: group[0].via,
					});
				}
			}
		}
	}

	// ── symbols ──
	const table = new SymbolTable();
	for (const [canon, doc] of gcodeDocs) {
		const original = byPath.get(canon)!.path;
		for (const line of doc.lines) {
			for (const cmd of line.commands) addSymbolsForCommand(table, original, doc, line, cmd, options?.boards);
		}
		addGlobalSymbols(table, original, doc);
	}
	const gcodeDocsWithPath = new Map([...gcodeDocs].map(([canon, doc]) => [canon, { path: byPath.get(canon)!.path, doc }] as const));
	addFilamentSymbols(table, filamentFiles, gcodeDocsWithPath);

	return { files: resultFiles, calls, symbols: table.toArray() };
}
