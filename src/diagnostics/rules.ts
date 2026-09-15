/**
 * The diagnostics rule registry and check logic (task 14, `docs/tasks/14-diagnostics.md`). Every
 * rule is data (a `RuleInfo` in `RULES`) plus a check function; `diagnose.ts` runs them all and
 * merges the results. Every rule cites the RRF source or wiki passage that justifies it - a rule
 * this file can't cite for is not here (task's own "drop any you can't cite").
 */

import { commandSpec } from "../dictionary/commands.js";
import type { ParamSpec } from "../dictionary/schema.js";
import { expressionsOfLine, type DocumentLine, type GcodeDocument } from "../document.js";
import { GCODE_FILE_KINDS } from "../files/kinds.js";
import type { LexedCommand, LexedParam } from "../lex.js";
import { STRING_ARGUMENT_COMMANDS } from "../lex.js";
import { metaKeywordOf, META_KEYWORDS } from "../metaKeywords.js";
import { compareFirmwareVersions } from "../versionCompare.js";
import { objectModelPath } from "../objectmodel/schema.js";
import { impactOf } from "../releases/impact.js";
import type { MenuDocument } from "../files/menu.js";
import { parseHeightMap } from "../files/heightmap.js";
import type { Project } from "../project.js";
import type { Diagnostic, DiagnoseOptions, RuleInfo } from "./schema.js";

// ── the registry ────────────────────────────────────────────────────────────────────────────────

export const RULES: ReadonlyArray<RuleInfo> = [
	// syntax
	{ id: "syntax/lexer-error", severity: "error", category: "syntax",
		description: "A line failed to lex at all - an unterminated quoted string, an unterminated CNC bracketed comment, or an unbalanced { in an expression.",
		sources: ["dwc-gcode-core src/lex.ts scanContent - each condition cited to RRF's own StringParser.cpp at its own definition site (task 05)"] },
	{ id: "syntax/line-too-long", severity: "error", category: "syntax",
		description: "The line's own non-comment content is 256 characters or more (RRF's line buffer, including a null terminator, so 255 usable) - RRF throws \"GCode command too long\". A CNC (...) bracketed comment counts toward this; a trailing ; comment does not.",
		sources: ["RRF 3.7.0-rc.1 Config/Configuration.h:169 MaxGCodeStringLength = 256", "RRF 3.7.0-rc.1 GCodes/GCodeBuffer/StringParser.cpp:74-97,385-387 (buffer allocation, overflow flag, thrown exception)"] },
	{ id: "syntax/checksum-mismatch", severity: "error", category: "syntax",
		description: "A line has an N<num> line number and a *NN checksum (1-3 digits, the classic XOR form), but the checksum doesn't match the line's own content.",
		sources: ["RRF 3.7.0-rc.1 GCodes/GCodeBuffer/StringParser.cpp:61-73 AddToChecksum/StoreAndAddToChecksum (XOR of every byte before *)", "RRF 3.7.0-rc.1 GCodes/GCodeBuffer/StringParser.cpp:328-341 badChecksum check", "RRF 3.7.0-rc.1 GCodes/GCodes2.cpp:4719 \"Checksum error on line %d\""] },

	// structure
	{ id: "structure/document-error", severity: "error", category: "structure",
		description: "A structural error in the meta-gcode block tree - elif/else without a matching if, else after an else, break/continue outside a loop, a T command not alone on its line, or mixed space/tab indentation (RRF warns once per file for this last one).",
		sources: ["dwc-gcode-core src/document.ts block-builder (task 06), each cited at its own definition site to StringParser::ProcessIfCommand/ProcessElseCommand/ProcessElifCommand/ProcessWhileCommand/ProcessBreakCommand/ProcessContinueCommand"] },
	{ id: "structure/macro-command-not-last", severity: "warning", category: "structure",
		description: "G28, G29, G32 or M98 shares a line with another command - the wiki says a macro-invoking command must be alone on its line.",
		sources: ["wiki Gcodes.md \"Multiple commands on a single line\""] },
	{ id: "structure/capitalised-meta-keyword", severity: "warning", category: "structure",
		description: "A line's own content case-insensitively matches a meta keyword (if/elif/else/while/break/continue/abort/var/global/set/echo/skip) but isn't all-lowercase - RRF's own recognition is case-sensitive, so this line is not read as a meta-command at all and is silently ignored.",
		sources: ["dwc-gcode-core src/metaKeywords.ts metaKeywordOf - cited to RRF's own ProcessConditionalGCode length-then-text dispatch (task 06)"] },

	// dictionary
	{ id: "dictionary/unknown-command", severity: "info", category: "dictionary",
		description: "The command isn't in this package's dictionary at all. RRF itself would try to run /sys/<code>.g for it (its own \"custom G/M codes\" mechanism) - reported at info without a project (no way to know if that file exists), and only when checked against a project that's missing the file does this become more severe (see project/missing-macro-file).",
		sources: ["RRF 3.7.0-rc.1 GCodes/GCodes2.cpp:4810 GCodes::TryMacroFile", "wiki Gcodes.md \"Custom G and M codes\""] },
	{ id: "dictionary/unknown-parameter", severity: "warning", category: "dictionary",
		description: "A parameter letter this command's reviewed dictionary entry doesn't recognise (and the command has no generic axisParameters catch-all). Only checked against REVIEWED entries - a draft-only entry's parameter list is a heuristic, not a fact, so this rule stays silent for those.",
		sources: ["dwc-gcode-core dictionary/commands.json (task 10) - each reviewed entry's own parameter list, itself cited to RRF source"] },
	{ id: "dictionary/wrong-kind", severity: "warning", category: "dictionary",
		description: "A parameter's value doesn't look like the kind the dictionary says it should be (e.g. a non-numeric value where a number is expected) - unless the value is an RRF {...} expression, which is always allowed where expressionAllowed is true and can't be shape-checked statically.",
		sources: ["dwc-gcode-core dictionary/commands.json (task 10) ParamSpec.kind"] },
	{ id: "dictionary/missing-required", severity: "error", category: "dictionary",
		description: "A parameter the dictionary marks required: true is absent from the line.",
		sources: ["dwc-gcode-core dictionary/commands.json (task 10) ParamSpec.required - only set true where RRF's own gb.MustSee(...) is read directly, per task 10's own rule"] },
	{ id: "dictionary/value-out-of-range", severity: "warning", category: "dictionary",
		description: "A literal numeric parameter's value falls outside the dictionary's own range, or (for an enumerated parameter) isn't one of its listed values.",
		sources: ["dwc-gcode-core dictionary/commands.json (task 10) ParamSpec.range/.values"] },
	{ id: "dictionary/not-available-on-firmware", severity: "error", category: "dictionary",
		description: "A command or parameter the dictionary dates with since/until isn't present at the target firmware version.",
		sources: ["dwc-gcode-core dictionary/commands.json (task 10/12) CommandSpec.since/until, ParamSpec.since/until"] },
	{ id: "dictionary/deprecated", severity: "warning", category: "dictionary",
		description: "A command the dictionary marks deprecated, with its replacement if one is known.",
		sources: ["dwc-gcode-core dictionary/commands.json (task 10) CommandSpec.deprecated"] },
	{ id: "dictionary/wrong-machine-mode", severity: "warning", category: "dictionary",
		description: "A command the dictionary restricts to specific machine modes (machineModes) is used in a document set to a different one.",
		sources: ["dwc-gcode-core dictionary/commands.json (task 10) CommandSpec.machineModes"] },

	// project
	{ id: "project/undefined-symbol", severity: "error", category: "project",
		description: "A tool/heater/sensor/fan/axis/probe/endstop/accelerometer/spindle/global/filament is referenced but never defined anywhere in the project. NOT checked for extruder/driver: SYMBOL_RULES only records USES for those two (RRF has no single command that \"creates\" an extruder or driver number the way M950/M563/M308 do for the others), so \"undefined\" would misfire on every ordinary config.",
		sources: ["dwc-gcode-core src/project.ts SYMBOL_RULES (task 13)"] },
	{ id: "project/duplicate-definition", severity: "warning", category: "project",
		description: "The same numbered/named resource is defined more than once (unconditionally) in the project - except a filament, whose config.g/load.g/unload.g each legitimately add their own definition site for the same name by design.",
		sources: ["dwc-gcode-core src/project.ts (task 13) - a definition site's own conditional flag; addFilamentSymbols's own per-file-kind definition sites"] },
	{ id: "project/order-dependency", severity: "warning", category: "project",
		description: "A command the dictionary says must follow another (mustFollow) is used before that other command is ever defined/run anywhere earlier in the project.",
		sources: ["dwc-gcode-core dictionary/commands.json (task 10) CommandSpec.mustFollow"] },
	{ id: "project/missing-macro-file", severity: "error", category: "project",
		description: "A call this package's invocation table recognises (M98, G28/homing, a tool change, M701/M702, G29/G32, pause/resume, M501, M581, ...) doesn't resolve to a file present in the project.",
		sources: ["dwc-gcode-core docs/invocation-table.md, src/project.ts Project.calls.resolved (task 13)"] },

	// release
	{ id: "release/impact", severity: "warning", category: "release",
		description: "A command, parameter, object-model path or expression-syntax feature this file uses changed between the file's own stamped RRF version and the target version (task 12's impactOf) - in either direction.",
		sources: ["dwc-gcode-core src/releases/changes.ts, src/releases/impact.ts (task 12)"] },

	// menu
	{ id: "menu/unknown-command", severity: "error", category: "menu",
		description: "A menu file's command word isn't one of the six RRF recognises (image, text, button, value, alter, files).",
		sources: ["RRF 3.7.0-rc.1 Display/Menu.cpp Menu::ParseMenuLine (task 08)"] },
	{ id: "menu/target-missing", severity: "error", category: "menu",
		description: "A \"menu\" action's target isn't a menu file present in the project - either the L parameter (the common \"A\\\"menu\\\" L\\\"name\\\"\" form: RRF's own case 'L' sets \"fname\", which is what \"menu\" chains to) or a name embedded right in the action text (\"menu <name>\", the separate form EncoderAction_ExecuteHelper also recognises).",
		sources: ["RRF 3.7.0-rc.1 src/Display/Menu.cpp:39 \"'menu' (chains to the menu file given in the L parameter)\"", "RRF 3.7.0-rc.1 src/Display/Menu.cpp:357-366 case 'L' sets fname", "RRF 3.7.0-rc.1 src/Display/Menu.cpp:580 EncoderAction_ExecuteHelper StringStartsWithIgnoreCase(cmd, \"menu \")"] },
	{ id: "menu/image-missing", severity: "error", category: "menu",
		description: "An image command's own file (its L parameter - RRF's \"fname\", the same letter \"menu\" chains through) isn't present in the project's 0:/menu/ directory.",
		sources: ["RRF 3.7.0-rc.1 src/Display/Menu.cpp:357-366 case 'L' sets fname", "RRF 3.7.0-rc.1 src/Display/Menu.cpp:407 new ImageMenuItem(row, column, fname)"] },

	// data
	{ id: "data/height-map-error", severity: "error", category: "data",
		description: "heightmap.csv failed to load - reported with exactly the message RRF's own loader would give.",
		sources: ["RRF 3.7.0-rc.1 Movement/BedProbing/Grid.cpp (task 08's parseHeightMap)"] },

	// object model
	{ id: "objectModel/unknown-path", severity: "error", category: "objectModel",
		description: "An object-model path referenced in an expression doesn't exist at the target firmware version.",
		sources: ["dwc-gcode-core src/objectmodel/schema.ts objectModelPath (task 11)"] },
	{ id: "objectModel/deprecated-path", severity: "warning", category: "objectModel",
		description: "An object-model path referenced in an expression is deprecated at the target firmware version, with the deprecation message.",
		sources: ["dwc-gcode-core src/objectmodel/schema.ts objectModelPath (task 11)"] },
];

const RULE_BY_ID = new Map(RULES.map((r) => [r.id, r]));

function severityFor(ruleId: string, options: DiagnoseOptions): RuleInfo["severity"] | null {
	if (options.rules?.disable?.includes(ruleId)) return null;
	return options.rules?.severity?.[ruleId] ?? RULE_BY_ID.get(ruleId)!.severity;
}

function applies(ruleId: string, firmwareVersion: string): boolean {
	const rule = RULE_BY_ID.get(ruleId)!;
	if (rule.appliesTo?.since !== undefined && compareFirmwareVersions(firmwareVersion, rule.appliesTo.since) < 0) return false;
	if (rule.appliesTo?.until !== undefined && compareFirmwareVersions(firmwareVersion, rule.appliesTo.until) > 0) return false;
	return true;
}

function makeDiag(ruleId: string, options: DiagnoseOptions, file: string, line: number, start: number, end: number, message: string, sources: ReadonlyArray<string>, fixes?: Diagnostic["fixes"]): Diagnostic | null {
	if (!applies(ruleId, options.firmwareVersion)) return null;
	const severity = severityFor(ruleId, options);
	if (severity === null) return null;
	const d: Diagnostic = { rule: ruleId, severity, message, file, line, start, end, sources };
	if (fixes !== undefined) d.fixes = fixes;
	return d;
}

// ── syntax ──────────────────────────────────────────────────────────────────────────────────────

const MAX_GCODE_STRING_LENGTH = 256; // RRF 3.7.0-rc.1 Config/Configuration.h:169 - includes the null terminator

function checkSyntax(doc: GcodeDocument, path: string, options: DiagnoseOptions): Array<Diagnostic> {
	const out: Array<Diagnostic> = [];
	for (const err of doc.errors) {
		const isStructural = ["elif-without-if", "else-without-if", "else-after-else", "break-outside-loop", "continue-outside-loop", "t-not-alone", "mixed-indentation"].includes(err.code);
		const ruleId = isStructural ? "structure/document-error" : "syntax/lexer-error";
		const d = makeDiag(ruleId, options, path, err.line, err.start, err.end, err.message, RULE_BY_ID.get(ruleId)!.sources);
		if (d !== null) out.push(d);
	}

	for (const line of doc.lines) {
		// Line length: non-comment content only - a trailing `;` comment doesn't count (RRF resets
		// its own overflow flag for comment lines), but everything up to it, including a CNC `(...)`
		// bracketed comment, does.
		const contentEnd = line.comment !== null ? line.comment.start : line.raw.length;
		if (contentEnd >= MAX_GCODE_STRING_LENGTH) {
			const d = makeDiag("syntax/line-too-long", options, path, line.index, line.start, line.start + contentEnd,
				`Line is ${contentEnd} characters before any comment - RRF's line buffer holds at most ${MAX_GCODE_STRING_LENGTH - 1}`,
				RULE_BY_ID.get("syntax/line-too-long")!.sources);
			if (d !== null) out.push(d);
		}

		if (line.checksum !== null && line.lineNumber !== null) {
			// Measured across the CHECKSUM'S OWN span, not to the end of the line: anything after the
			// checksum (a trailing `;` comment, trailing whitespace) would otherwise inflate the count
			// past 3 and silently skip validation on a perfectly ordinary host-mode line.
			const digits = line.checksum.end - line.checksum.start - 1; // "*" then the digits
			if (digits >= 1 && digits <= 3) {
				const declared = line.checksum.value;
				const computed = computeChecksum(line.raw, line.checksum.start);
				if (computed !== declared) {
					const d = makeDiag("syntax/checksum-mismatch", options, path, line.index,
						line.start + line.checksum.start, line.start + line.checksum.end,
						`Checksum *${declared} doesn't match the line's own content (computed *${computed})`,
						RULE_BY_ID.get("syntax/checksum-mismatch")!.sources);
					if (d !== null) out.push(d);
				}
			}
			// A 5-digit checksum is RRF's CRC16 form (StringParser.cpp:342-344), not the classic XOR -
			// not validated here; a real, documented gap (see docs/tasks/14-diagnostics.md's Findings).
		}
	}
	return out;
}

/** RRF's own algorithm (`AddToChecksum`/`StoreAndAddToChecksum`): XOR of every byte up to (not
 *  including) the `*`. */
function computeChecksum(raw: string, starIndex: number): number {
	let sum = 0;
	for (let i = 0; i < starIndex; i++) sum ^= raw.charCodeAt(i) & 0xff;
	return sum;
}

// ── structure ───────────────────────────────────────────────────────────────────────────────────

const MACRO_INVOKING_CODES: ReadonlySet<string> = new Set(["G28", "G29", "G32", "M98"]);

function checkStructure(doc: GcodeDocument, path: string, options: DiagnoseOptions): Array<Diagnostic> {
	const out: Array<Diagnostic> = [];
	for (const line of doc.lines) {
		if (line.commands.length > 1) {
			for (const cmd of line.commands) {
				if (MACRO_INVOKING_CODES.has(cmd.code)) {
					const d = makeDiag("structure/macro-command-not-last", options, path, line.index, line.start + cmd.start, line.start + cmd.end,
						`${cmd.code} shares a line with another command - the wiki says a macro-invoking command must be alone on its line`,
						RULE_BY_ID.get("structure/macro-command-not-last")!.sources);
					if (d !== null) out.push(d);
				}
			}
		}

		// A capitalised meta keyword never lexes as `kind: "meta"` (that requires an exact-case match)
		// and never as `kind: "commands"` (a real G/M/T code's first letter is followed by a digit,
		// which this regex's letters-only match can't consume) - it lands as `"fields"` (RRF's own
		// Fanuc-style letter/value heuristic often matches, e.g. "If true") or `"unrecognised"`
		// depending on what follows, so both are checked here; not gated on `line.kind` at all.
		{
			const content = line.raw.slice(line.indent);
			const match = /^([A-Za-z]{2,8})(?=[\s{"(]|$)/.exec(content);
			if (match !== null) {
				const lower = match[1].toLowerCase();
				if (match[1] !== lower && META_KEYWORDS.has(lower) && metaKeywordOf(content) === null) {
					const start = line.start + line.indent;
					const d = makeDiag("structure/capitalised-meta-keyword", options, path, line.index, start, start + match[1].length,
						`"${match[1]}" is not a meta-command - RRF only recognises "${lower}" in all-lowercase; this line is silently ignored`,
						RULE_BY_ID.get("structure/capitalised-meta-keyword")!.sources);
					if (d !== null) out.push(d);
				}
			}
		}
	}
	return out;
}

// ── dictionary ──────────────────────────────────────────────────────────────────────────────────

function isExpression(param: LexedParam): boolean {
	return param.kind === "expression";
}

/** Whether a literal (non-expression) value's own text looks like the dictionary's declared kind -
 *  deliberately loose (this is a lint, not a re-implementation of RRF's own number grammar from
 *  Duet3D/RRFLibraries, out of scope per task 07's own Findings). */
function looksLikeKind(value: string, kind: ParamSpec["kind"]): boolean {
	switch (kind) {
		case "number": case "integer": case "unsigned":
		case "heaterNumber": case "fanNumber": case "sensorNumber": case "probeNumber": case "toolNumber":
			return /^-?\d+(\.\d+)?$/.test(value) || value.includes(":"); // a list is checked element-wise by the caller
		case "boolean01":
			return value === "0" || value === "1";
		case "driverId":
			return /^\d+(\.\d+)?$/.test(value);
		case "bitmap":
			return /^\d+$/.test(value);
		default:
			return true; // string/pin/filename/axisLetters/any - no useful shape check
	}
}

function checkDictionaryForCommand(path: string, line: DocumentLine, cmd: LexedCommand, options: DiagnoseOptions, project: Project | undefined): Array<Diagnostic> {
	const out: Array<Diagnostic> = [];
	const spec = commandSpec(cmd.code);

	if (spec === null) {
		const hasSysMacro = project !== undefined && [...project.files.keys()].some((p) => new RegExp(`(^|/)${cmd.code}(\\.\\d+)?\\.g$`, "i").test(p));
		if (!hasSysMacro) {
			const d = makeDiag("dictionary/unknown-command", options, path, line.index, line.start + cmd.start, line.start + cmd.end,
				`${cmd.code} isn't a known command - RRF would try to run /sys/${cmd.code}.g for it`,
				RULE_BY_ID.get("dictionary/unknown-command")!.sources);
			if (d !== null) out.push(d);
		}
		return out;
	}

	if (spec.reviewed === undefined) return out; // a draft entry's parameter list is a heuristic, not a fact - stay silent

	if (spec.since !== undefined && compareFirmwareVersions(options.firmwareVersion, spec.since) < 0) {
		const d = makeDiag("dictionary/not-available-on-firmware", options, path, line.index, line.start + cmd.start, line.start + cmd.end,
			`${cmd.code} isn't available until RRF ${spec.since}`, RULE_BY_ID.get("dictionary/not-available-on-firmware")!.sources);
		if (d !== null) out.push(d);
	}
	if (spec.until !== undefined && compareFirmwareVersions(options.firmwareVersion, spec.until) > 0) {
		const d = makeDiag("dictionary/not-available-on-firmware", options, path, line.index, line.start + cmd.start, line.start + cmd.end,
			`${cmd.code} was removed in RRF ${spec.until}`, RULE_BY_ID.get("dictionary/not-available-on-firmware")!.sources);
		if (d !== null) out.push(d);
	}
	if (spec.deprecated !== undefined) {
		const msg = spec.deprecated.replacement !== undefined ? `${cmd.code} is deprecated - use ${spec.deprecated.replacement} instead` : `${cmd.code} is deprecated`;
		const d = makeDiag("dictionary/deprecated", options, path, line.index, line.start + cmd.start, line.start + cmd.end, msg, [spec.deprecated.source]);
		if (d !== null) out.push(d);
	}
	if (spec.machineModes !== undefined && options.machineMode !== undefined && !spec.machineModes.includes(options.machineMode)) {
		const d = makeDiag("dictionary/wrong-machine-mode", options, path, line.index, line.start + cmd.start, line.start + cmd.end,
			`${cmd.code} isn't valid in ${options.machineMode} mode (only ${spec.machineModes.join("/")})`,
			RULE_BY_ID.get("dictionary/wrong-machine-mode")!.sources);
		if (d !== null) out.push(d);
	}

	if (spec.stringArgument === true) return out; // whole remainder is a string, not letter parameters

	const known = new Map(spec.parameters.map((p) => [p.letter.toUpperCase(), p]));
	const hasAxisCatchAll = spec.axisParameters !== undefined;
	const seen = new Set<string>();
	for (const param of cmd.params) {
		const letter = param.letter.toUpperCase();
		seen.add(letter);
		const paramSpec = known.get(letter);
		if (paramSpec === undefined) {
			if (hasAxisCatchAll && /^[A-Z]$/.test(letter)) continue; // a generic axis letter
			const d = makeDiag("dictionary/unknown-parameter", options, path, line.index, line.start + param.start, line.start + param.end,
				`${cmd.code} doesn't have a ${letter} parameter`, RULE_BY_ID.get("dictionary/unknown-parameter")!.sources);
			if (d !== null) out.push(d);
			continue;
		}

		if (paramSpec.since !== undefined && compareFirmwareVersions(options.firmwareVersion, paramSpec.since) < 0) {
			const d = makeDiag("dictionary/not-available-on-firmware", options, path, line.index, line.start + param.start, line.start + param.end,
				`${cmd.code}'s ${letter} isn't available until RRF ${paramSpec.since}`, RULE_BY_ID.get("dictionary/not-available-on-firmware")!.sources);
			if (d !== null) out.push(d);
		}
		if (paramSpec.until !== undefined && compareFirmwareVersions(options.firmwareVersion, paramSpec.until) > 0) {
			const d = makeDiag("dictionary/not-available-on-firmware", options, path, line.index, line.start + param.start, line.start + param.end,
				`${cmd.code}'s ${letter} was removed in RRF ${paramSpec.until}`, RULE_BY_ID.get("dictionary/not-available-on-firmware")!.sources);
			if (d !== null) out.push(d);
		}

		if (isExpression(param)) continue; // can't shape-check an expression statically

		const pieces = paramSpec.list ? param.value.split(":") : [param.value];
		if (!pieces.every((p) => looksLikeKind(p.trim(), paramSpec.kind))) {
			const d = makeDiag("dictionary/wrong-kind", options, path, line.index, line.start + param.start, line.start + param.end,
				`${cmd.code}'s ${letter} should be ${describeKind(paramSpec)}, not "${param.value}"`, RULE_BY_ID.get("dictionary/wrong-kind")!.sources);
			if (d !== null) out.push(d);
		} else if (paramSpec.range !== undefined && pieces.length === 1) {
			const n = Number(pieces[0]);
			if (Number.isFinite(n)) {
				if ((paramSpec.range.min !== undefined && n < paramSpec.range.min) || (paramSpec.range.max !== undefined && n > paramSpec.range.max)) {
					const d = makeDiag("dictionary/value-out-of-range", options, path, line.index, line.start + param.start, line.start + param.end,
						`${cmd.code}'s ${letter} value ${n} is outside ${paramSpec.range.min ?? "-inf"}..${paramSpec.range.max ?? "inf"}`,
						RULE_BY_ID.get("dictionary/value-out-of-range")!.sources);
					if (d !== null) out.push(d);
				}
			}
		} else if (paramSpec.values !== undefined && pieces.length === 1) {
			if (!paramSpec.values.some((v) => v.value === pieces[0].trim())) {
				const d = makeDiag("dictionary/value-out-of-range", options, path, line.index, line.start + param.start, line.start + param.end,
					`${cmd.code}'s ${letter} value "${pieces[0]}" isn't one of ${paramSpec.values.map((v) => v.value).join("/")}`,
					RULE_BY_ID.get("dictionary/value-out-of-range")!.sources);
				if (d !== null) out.push(d);
			}
		}
	}

	for (const paramSpec of spec.parameters) {
		if (paramSpec.required === true && !seen.has(paramSpec.letter.toUpperCase())) {
			const d = makeDiag("dictionary/missing-required", options, path, line.index, line.start + cmd.start, line.start + cmd.end,
				`${cmd.code} needs a ${paramSpec.letter} parameter`, RULE_BY_ID.get("dictionary/missing-required")!.sources);
			if (d !== null) out.push(d);
		}
	}

	return out;
}

function describeKind(spec: ParamSpec): string {
	return spec.list ? `a colon-separated list of ${spec.kind}` : spec.kind;
}

function checkDictionary(doc: GcodeDocument, path: string, options: DiagnoseOptions, project: Project | undefined): Array<Diagnostic> {
	const out: Array<Diagnostic> = [];
	for (const line of doc.lines) {
		for (const cmd of line.commands) {
			if (STRING_ARGUMENT_COMMANDS.has(cmd.code)) continue; // no letter parameters to check
			out.push(...checkDictionaryForCommand(path, line, cmd, options, project));
		}
	}
	return out;
}

// ── object model ────────────────────────────────────────────────────────────────────────────────

function checkObjectModel(doc: GcodeDocument, path: string, options: DiagnoseOptions): Array<Diagnostic> {
	const out: Array<Diagnostic> = [];
	for (const line of doc.lines) {
		for (const { expression } of expressionsOfLine(doc, line.index)) {
			for (const ref of expression.objectModelPaths) {
				let status;
				try {
					status = objectModelPath(ref.path, options.firmwareVersion);
				} catch {
					continue; // firmwareVersion isn't a tracked object-model version - nothing to say
				}
				if (!status.known) {
					const d = makeDiag("objectModel/unknown-path", options, path, line.index, ref.start, ref.end,
						`${ref.path} isn't a known object-model path at RRF ${options.firmwareVersion}`,
						RULE_BY_ID.get("objectModel/unknown-path")!.sources);
					if (d !== null) out.push(d);
				} else if (status.deprecated !== undefined) {
					const d = makeDiag("objectModel/deprecated-path", options, path, line.index, ref.start, ref.end,
						`${ref.path} is deprecated - ${status.deprecated}`, RULE_BY_ID.get("objectModel/deprecated-path")!.sources);
					if (d !== null) out.push(d);
				}
			}
		}
	}
	return out;
}

// ── release ─────────────────────────────────────────────────────────────────────────────────────

function checkRelease(doc: GcodeDocument, path: string, options: DiagnoseOptions): Array<Diagnostic> {
	if (options.stampedVersion === undefined) return [];
	const out: Array<Diagnostic> = [];
	for (const finding of impactOf(doc, options.stampedVersion, options.firmwareVersion)) {
		const d = makeDiag("release/impact", options, path, finding.line, finding.start, finding.end, finding.message,
			finding.event.sources);
		if (d !== null) out.push(d);
	}
	return out;
}

// ── document-level orchestration (task 14 step 1) ──────────────────────────────────────────────

export function diagnoseDocumentRules(doc: GcodeDocument, path: string, options: DiagnoseOptions, project?: Project): Array<Diagnostic> {
	return [
		...checkSyntax(doc, path, options),
		...checkStructure(doc, path, options),
		...checkDictionary(doc, path, options, project),
		...checkObjectModel(doc, path, options),
		...checkRelease(doc, path, options),
	];
}

// ── project-level rules ─────────────────────────────────────────────────────────────────────────

/** Symbol types genuinely finished/never-conditionally-defined enough for a "never defined anywhere"
 *  finding to be trustworthy - `gpin`/`gpout`/`ledStrip` are define-only with no use-tracking yet
 *  (task 13's own Findings), so an "undefined" finding for those would really just mean "this
 *  project doesn't use M950 J/S/E", not a real omission; excluded here for that reason. The mirror
 *  gap is real too, and worse: `extruder` and `driver` are USE-only in `SYMBOL_RULES` (`M563`'s `D`,
 *  `M572`'s `D`, `M221`'s `D` for extruders; `M569`'s `P` for drivers) - RRF has no single command
 *  that "creates" an extruder or a driver number the way `M950`/`M563`/`M308` do for the others (an
 *  extruder's existence is implicit in how many drives `M584`'s own `E` list names, which this
 *  module doesn't map to the `extruder` type at all - a real, separate task 13 gap). Checking either
 *  for "undefined" here would misfire on every ordinary FFF config that uses an extruder at all -
 *  caught by this task's own project-fixture snapshot test, not assumed. */
const UNDEFINED_CHECK_TYPES: ReadonlySet<string> = new Set([
	"tool", "heater", "sensor", "fan", "probe", "accelerometer", "spindle", "global", "filament", "axis", "endstop",
]);

/** `addFilamentSymbols` (task 13, `src/project.ts`) adds one unconditional "define" site for a
 *  filament PER FILE KIND under its own `filaments/<name>/` directory - config.g, load.g AND
 *  unload.g each independently define it, by design (proving the filament exists three separate
 *  ways, not three separate resources). A normal, fully-formed filament folder is therefore
 *  EXPECTED to have more than one unconditional definition; "duplicate-definition" would misfire on
 *  every correct filament otherwise, so this one symbol type is excluded from that specific check
 *  (it's still checked for "undefined", above - that part isn't per-file-kind multiplied). */
const DUPLICATE_CHECK_EXCLUDED_TYPES: ReadonlySet<string> = new Set(["filament"]);

function checkProjectSymbols(project: Project, options: DiagnoseOptions): Array<Diagnostic> {
	const out: Array<Diagnostic> = [];
	for (const symbol of project.symbols) {
		if (UNDEFINED_CHECK_TYPES.has(symbol.type) && symbol.definitions.length === 0) {
			for (const use of symbol.uses) {
				if (use.dynamic) continue; // "info at most" per the task's own Traps - not modelled as a diagnostic here
				const d = makeDiag("project/undefined-symbol", options, use.file, use.line, use.start, use.end,
					`${symbol.type} ${symbol.id} is used but never defined anywhere in this project`,
					RULE_BY_ID.get("project/undefined-symbol")!.sources);
				if (d !== null) out.push(d);
			}
		}
		if (DUPLICATE_CHECK_EXCLUDED_TYPES.has(symbol.type)) continue;
		const unconditionalDefs = symbol.definitions.filter((s) => !s.conditional);
		if (unconditionalDefs.length > 1) {
			for (const site of unconditionalDefs.slice(1)) {
				const d = makeDiag("project/duplicate-definition", options, site.file, site.line, site.start, site.end,
					`${symbol.type} ${symbol.id} is defined more than once`, RULE_BY_ID.get("project/duplicate-definition")!.sources);
				if (d !== null) out.push(d);
			}
		}
	}
	return out;
}

function checkProjectCalls(project: Project, options: DiagnoseOptions): Array<Diagnostic> {
	const out: Array<Diagnostic> = [];
	for (const call of project.calls) {
		if (call.dynamic || call.resolved) continue;
		const entry = project.files.get(call.from.file);
		const line = entry !== undefined && entry.doc !== null && GCODE_FILE_KINDS.has(entry.kind)
			? (entry.doc as GcodeDocument).lines[call.from.line]
			: undefined;
		const start = line?.start ?? 0;
		const end = line !== undefined ? line.start + line.raw.length : 0;
		const d = makeDiag("project/missing-macro-file", options, call.from.file, call.from.line, start, end,
			`This ${call.via} call's own target, ${call.to}, isn't a file in this project`,
			RULE_BY_ID.get("project/missing-macro-file")!.sources);
		if (d !== null) out.push(d);
	}
	return out;
}

function checkOrderDependencies(project: Project, options: DiagnoseOptions): Array<Diagnostic> {
	const out: Array<Diagnostic> = [];
	// Earliest {file, line} any command actually appears at anywhere in the project, by code.
	const firstSeen = new Map<string, { file: string; line: number }>();
	const usageSites: Array<{ code: string; file: string; line: number; start: number; end: number }> = [];
	for (const [path, entry] of project.files) {
		if (entry.doc === null || !GCODE_FILE_KINDS.has(entry.kind)) continue;
		const doc = entry.doc as GcodeDocument;
		for (const line of doc.lines) {
			for (const cmd of line.commands) {
				usageSites.push({ code: cmd.code, file: path, line: line.index, start: line.start + cmd.start, end: line.start + cmd.end });
				if (!firstSeen.has(cmd.code) || compareSite(firstSeen.get(cmd.code)!, { file: path, line: line.index }, project) < 0) {
					firstSeen.set(cmd.code, { file: path, line: line.index });
				}
			}
		}
	}
	for (const site of usageSites) {
		const spec = commandSpec(site.code);
		if (spec?.mustFollow === undefined) continue;
		for (const dep of spec.mustFollow) {
			if (!firstSeen.has(dep.code)) {
				const d = makeDiag("project/order-dependency", options, site.file, site.line, site.start, site.end,
					`${site.code} needs ${dep.code} to run first (${dep.when ?? "order dependency"}), but ${dep.code} doesn't appear anywhere in this project`,
					[dep.source]);
				if (d !== null) out.push(d);
			}
		}
	}
	return out;
}

/** A rough total ordering for "which of two sites comes first" across DIFFERENT files - by config.g
 *  running before anything it calls, approximated here by file path (config.g sorts first) then line
 *  number; genuinely resolving RRF's real execution order across files would need task 13's own call
 *  graph walked as a traversal, which this rule doesn't attempt (a real, documented simplification). */
function compareSite(a: { file: string; line: number }, b: { file: string; line: number }, project: Project): number {
	void project;
	const aIsConfig = /config\.g$/i.test(a.file) ? 0 : 1;
	const bIsConfig = /config\.g$/i.test(b.file) ? 0 : 1;
	if (aIsConfig !== bIsConfig) return aIsConfig - bIsConfig;
	if (a.file !== b.file) return a.file < b.file ? -1 : 1;
	return a.line - b.line;
}

// ── menu ────────────────────────────────────────────────────────────────────────────────────────

function checkMenuDocument(menu: MenuDocument, path: string, options: DiagnoseOptions, project: Project | undefined): Array<Diagnostic> {
	const out: Array<Diagnostic> = [];
	let offset = 0;
	for (const [index, line] of menu.lines.entries()) {
		if (line.kind === "unrecognised" && line.command !== undefined) {
			const start = offset;
			const d = makeDiag("menu/unknown-command", options, path, index, start, start + line.command.length,
				`"${line.command}" isn't a recognised menu command (image/text/button/value/alter/files)`,
				RULE_BY_ID.get("menu/unknown-command")!.sources);
			if (d !== null) out.push(d);
		}
		if (project !== undefined) {
			// "menu" (bare) chains to the file named by the line's own L parameter ("fname" in RRF's
			// own Menu::ParseMenuLine); "menu <name>" (a name embedded right in the action text) is a
			// second, separate form EncoderAction_ExecuteHelper also recognises (StringStartsWithIgnore
			// Case(cmd, "menu ")) - both are real and checked here.
			const lParam = line.params.find((p) => p.letter === "L");
			for (const action of line.actions) {
				if (action.kind === "menu") {
					const name = action.name !== "" ? action.name : lParam?.value;
					const site = action.name !== "" ? { start: action.start, end: action.end } : lParam !== undefined ? { start: lParam.start, end: lParam.end } : { start: action.start, end: action.end };
					if (name === undefined) continue; // bare "menu" with no L param - RRF's own TODO says this isn't validated either; nothing to check
					const target = [...project.files.keys()].find((p) => new RegExp(`(^|/)menu/${escapeRegExp(name)}$`, "i").test(p));
					if (target === undefined) {
						const d = makeDiag("menu/target-missing", options, path, index, offset + site.start, offset + site.end,
							`menu "${name}" isn't a file in this project's 0:/menu/ directory`,
							RULE_BY_ID.get("menu/target-missing")!.sources);
						if (d !== null) out.push(d);
					}
				}
			}
			if (line.command?.toLowerCase() === "image" && lParam !== undefined) {
				const target = [...project.files.keys()].find((p) => new RegExp(`(^|/)menu/${escapeRegExp(lParam.value)}$`, "i").test(p));
				if (target === undefined) {
					const d = makeDiag("menu/image-missing", options, path, index, offset + lParam.start, offset + lParam.end,
						`image "${lParam.value}" isn't a file in this project's 0:/menu/ directory`,
						RULE_BY_ID.get("menu/image-missing")!.sources);
					if (d !== null) out.push(d);
				}
			}
		}
		offset += line.raw.length + 1; // "+1" for the newline this loop's own text-splitting assumed - see diagnoseMenuFile
	}
	return out;
}

function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ── data (height maps) ──────────────────────────────────────────────────────────────────────────

function checkHeightMapFile(text: string, path: string, options: DiagnoseOptions): Array<Diagnostic> {
	const { errors } = parseHeightMap(text);
	const out: Array<Diagnostic> = [];
	for (const err of errors) {
		const d = makeDiag("data/height-map-error", options, path, err.line, 0, 0, err.message, RULE_BY_ID.get("data/height-map-error")!.sources);
		if (d !== null) out.push(d);
	}
	return out;
}

// ── project-level orchestration (task 14 step 1) ───────────────────────────────────────────────

export function diagnoseProjectRules(project: Project, options: DiagnoseOptions): Array<Diagnostic> {
	const out: Array<Diagnostic> = [];
	for (const [path, entry] of project.files) {
		if (entry.doc !== null && GCODE_FILE_KINDS.has(entry.kind)) {
			out.push(...diagnoseDocumentRules(entry.doc as GcodeDocument, path, options, project));
		}
		if (entry.kind === "menu" && entry.doc !== null) {
			out.push(...checkMenuDocument(entry.doc as MenuDocument, path, options, project));
		}
		if (entry.kind === "height-map") {
			out.push(...checkHeightMapFile(entry.text, path, options));
		}
	}
	out.push(...checkProjectSymbols(project, options));
	out.push(...checkProjectCalls(project, options));
	out.push(...checkOrderDependencies(project, options));
	return out;
}
