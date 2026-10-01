/**
 * The diagnostics rule registry and check logic (task 14, `docs/tasks/14-diagnostics.md`). Every
 * rule is data (a `RuleInfo` in `RULES`) plus a check function; `diagnose.ts` runs them all and
 * merges the results. Every rule cites the RRF source or wiki passage that justifies it - a rule
 * this file can't cite for is not here (task's own "drop any you can't cite").
 */

import { commandSpec } from "../dictionary/commands.js";
import type { CommandSpec, FirmwarePlatform, ParamSpec, ParamVariant } from "../dictionary/schema.js";
import { expressionsOfLine, type DocumentLine, type GcodeDocument } from "../document.js";
import { macroFileForCode, reachesMacroFile } from "../files/customCodes.js";
import { GCODE_FILE_KINDS } from "../files/kinds.js";
import type { LexedCommand, LexedParam } from "../lex.js";
import { NUMBER_RE, STRING_ARGUMENT_COMMANDS } from "../lex.js";
import { unquoteString } from "../params.js";
import { metaKeywordOf, META_KEYWORDS } from "../metaKeywords.js";
import { compareFirmwareVersions } from "../versionCompare.js";
import { objectModelPath } from "../objectmodel/schema.js";
import { impactOf } from "../releases/impact.js";
import type { MenuDocument } from "../files/menu.js";
import { MENU_MAX_LINE_LENGTH, resolveMenuDocument } from "../display/menuModel.js";
import { classifyMenuValueCode } from "../display/menuValues.js";
import { parseHeightMap } from "../files/heightmap.js";
import type { Project } from "../project.js";
import { lookupPinName, platformOfBoard } from "../pins/tables.js";
import type { Diagnostic, DiagnoseOptions, RuleInfo } from "./schema.js";

// ── the registry ────────────────────────────────────────────────────────────────────────────────

export const RULES: ReadonlyArray<RuleInfo> = [
	// syntax
	{ id: "syntax/lexer-error", severity: "error", category: "syntax",
		description: "A line failed to lex at all - an unterminated quoted string, an unterminated CNC bracketed comment, or an unbalanced { in an expression.",
		sources: ["dwc-gcode-core src/lex.ts scanContent - each condition cited to RRF's own StringParser.cpp at its own definition site (task 05)"] },
	{ id: "syntax/line-too-long", severity: "error", category: "syntax",
		description: "The line's own non-comment content is 256 characters or more (RRF's line buffer, including a null terminator, so 255 usable) - RRF throws \"GCode command too long\". A CNC (...) bracketed comment counts toward this; a trailing ; comment does not.",
		sources: ["RRF 3.7.0-rc.2 Config/Configuration.h:169 MaxGCodeStringLength = 256", "RRF 3.7.0-rc.2 GCodes/GCodeBuffer/StringParser.cpp:74-97,385-387 (buffer allocation, overflow flag, thrown exception)"] },
	{ id: "syntax/checksum-mismatch", severity: "error", category: "syntax",
		description: "A line has an N<num> line number and a *NN checksum (1-3 digits, the classic XOR form), but the checksum doesn't match the line's own content.",
		sources: ["RRF 3.7.0-rc.2 GCodes/GCodeBuffer/StringParser.cpp:61-73 AddToChecksum/StoreAndAddToChecksum (XOR of every byte before *)", "RRF 3.7.0-rc.2 GCodes/GCodeBuffer/StringParser.cpp:328-341 badChecksum check", "RRF 3.7.0-rc.2 GCodes/GCodes2.cpp:4735 \"Checksum error on line %d\""] },

	{ id: "syntax/bad-command", severity: "error", category: "syntax",
		description: "A line that RRF cannot read as a G, M or T command, a meta-command (if/elif/else/while/break/continue/abort/var/global/set/echo/skip, all lowercase) or a comment - RRF replies \"Bad command: <line>\" when it runs. Typical causes are a note that lost its ; (a line of words, including one that starts with G, M or T followed by a letter, like \"Tool change\"), a keyword from another language (endif, endwhile, endfor, elseif, fi, done: RRF ends a block by indentation, there is no closing keyword), a capitalised meta keyword, or a typo in a command letter. A bare axis-letter line (X10 Y20) is a valid repeat of the last G0-G3 on a CNC or laser machine, whose mode this check does not know, so such a line is never reported. Only reported for lines that run: a line inside a block that is skipped is never read, but is still wrong.",
		sources: ["RRF 3.7.0-rc.2 GCodes/GCodeBuffer/StringParser.cpp:985-1086 DecodeCommand (anything but G/M/T, a ; comment or the CNC/laser axis continuation becomes a \"bad command\")", "RRF 3.7.0-rc.2 GCodes/GCodes2.cpp:158-163 ActOnCode \"Bad command: \""] },

	{ id: "syntax/text-after-command", severity: "warning", category: "syntax",
		description: "Words after a command's parameters (`M104 S200 heat up`, `G28 home all axes`, `G1 X10 moves left`): a note that lost its `;`. RRF reads every letter in them as a parameter, so they cause a run of unrelated parameter errors, or none at all when the command hands its parameters to a macro. A group starts at a lowercase word of three or more letters that is not a parameter of that command and runs over the lowercase words and numbers after it. Not reported for a command whose argument is text (M117, echo), a command with no reviewed dictionary entry (custom codes), a word made only of that command's own parameter letters (`M18 xy`) or an unquoted string value (`M550 Pname`). The dictionary and macro-placement findings inside the text are dropped, as they are noise.",
		sources: ["RRF 3.7.0-rc.2 GCodes/GCodeBuffer/StringParser.cpp FindParameters (every letter outside a quoted string or expression is a parameter)", "dwc-gcode-core dictionary/commands.json - each reviewed entry's own parameter list"] },
	// structure
	{ id: "structure/document-error", severity: "error", category: "structure",
		description: "A structural error in the meta-gcode block tree - elif/else without a matching if, else after an else, break/continue outside a loop, a T command not alone on its line, or mixed space/tab indentation (RRF warns once per file for this last one).",
		sources: ["dwc-gcode-core src/document.ts block-builder (task 06), each cited at its own definition site to StringParser::ProcessIfCommand/ProcessElseCommand/ProcessElifCommand/ProcessWhileCommand/ProcessBreakCommand/ProcessContinueCommand"] },
	{ id: "structure/macro-command-not-last", severity: "warning", category: "structure",
		description: "G28, G29, G32 or M98 shares a line with another command - the wiki says a macro-invoking command must be alone on its line.",
		sources: ["wiki Gcodes.md \"Multiple commands on a single line\""] },
	{ id: "structure/capitalised-meta-keyword", severity: "warning", category: "structure",
		description: "A line's own content case-insensitively matches a meta keyword (if/elif/else/while/break/continue/abort/var/global/set/echo/skip) but isn't all-lowercase - RRF's own recognition is case-sensitive, so this line is not read as a meta-command at all and RRF reports \"Bad command\" for it.",
		sources: ["dwc-gcode-core src/metaKeywords.ts metaKeywordOf - cited to RRF's own ProcessConditionalGCode length-then-text dispatch (task 06)"] },

	// dictionary
	{ id: "dictionary/unknown-command", severity: "info", category: "dictionary",
		description: "The command isn't in this package's dictionary at all, and no user macro for it is known. RRF itself would try to run /sys/<code>.g for it (its own \"custom G/M codes\" mechanism), so this is only ever info: the code is fine if that file exists. It is not reported at all when the project's /sys folder holds that file, or when DiagnoseOptions.customCodes lists it (files/customCodes.ts customCodesOf builds that list from a folder listing). A fractional form of a code RRF handles fractions of itself (M569.11, G38.7) is never run as a macro, and the message says so.",
		sources: ["RRF 3.7.0-rc.2 GCodes/GCodes2.cpp:4826-4846 GCodes::TryMacroFile", "RRF 3.7.0-rc.2 GCodes/GCodes2.cpp:200-207,742-753 (the fractions RRF handles itself)", "wiki Gcodes.md \"Custom G and M codes\""] },
	{ id: "dictionary/unknown-parameter", severity: "warning", category: "dictionary",
		description: "A parameter letter this command's reviewed dictionary entry doesn't recognise (and the command has no generic axisParameters catch-all). When the command's selector letter is a literal that names a selectorVariants entry (M669 K6 = Hangprinter), the letters are checked against that variant's own list. Only checked against REVIEWED entries - a draft-only entry's parameter list is a heuristic, not a fact, so this rule stays silent for those.",
		sources: ["dwc-gcode-core dictionary/commands.json (task 10) - each reviewed entry's own parameter list, itself cited to RRF source"] },
	{ id: "dictionary/wrong-kind", severity: "warning", category: "dictionary",
		description: "A parameter's value doesn't look like the kind the dictionary says it should be (e.g. a non-numeric value where a number is expected) - unless the value is an RRF {...} expression, which is always allowed where expressionAllowed is true and can't be shape-checked statically.",
		sources: ["dwc-gcode-core dictionary/commands.json (task 10) ParamSpec.kind"] },
	{ id: "dictionary/missing-required", severity: "error", category: "dictionary",
		description: "A parameter the dictionary marks required: true is absent from the line (for one with requiredSince, only when the target firmware is at least that version).",
		sources: ["dwc-gcode-core dictionary/commands.json (task 10) ParamSpec.required - only set true where RRF's own gb.MustSee(...) is read directly, per task 10's own rule"] },
	{ id: "dictionary/value-out-of-range", severity: "warning", category: "dictionary",
		description: "A literal numeric parameter's value falls outside the dictionary's own range, isn't one of its listed values (for an enumerated parameter), or (for a colon-separated list) has an element count outside ParamSpec.listLength - RRF's own array reader throws \"array too long for parameter\" past a fixed size, e.g. M950's spindle-form L (1-2 values) and K (1-3 values).",
		sources: ["dwc-gcode-core dictionary/commands.json (task 10) ParamSpec.range/.values/.listLength", "RRF 3.7.0-rc.2 GCodes/GCodeBuffer/StringParser.cpp:1549-1555 CheckArrayLength"] },
	{ id: "dictionary/not-available-on-firmware", severity: "error", category: "dictionary",
		description: "A command or parameter the dictionary dates with since/until isn't present at the target firmware version.",
		sources: ["dwc-gcode-core dictionary/commands.json (task 10/12) CommandSpec.since/until, ParamSpec.since/until"] },
	{ id: "dictionary/not-available-on-platform", severity: "error", category: "dictionary",
		description: "A command or parameter the dictionary says exists only on one firmware build (platforms - e.g. M569.9, which only the STM32 fork of RepRapFirmware implements) is used when DiagnoseOptions.platform (or the mainboard named in DiagnoseOptions.boards) says the machine runs another. Skipped entirely when the platform isn't known - never guessed.",
		sources: ["dwc-gcode-core dictionary/commands.json (task 10) CommandSpec.platforms/ParamSpec.platforms - each cited to that platform's own source (gloomyandy/RepRapFirmware)"] },
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
	{ id: "project/pin-already-used", severity: "error", category: "project",
		description: "The same physical pin (after resolving modifiers, a CAN-address prefix, and - when a board is known - any alias to its canonical identity) is claimed by more than one unconditional kind:\"pin\" parameter site anywhere in the project. RRF itself refuses a second, conflicting allocation of the same pin at runtime (\"Pin '%s' is not free\") - this is a real RRF error, not a style preference.",
		sources: ["RRF 3.7.0-rc.2 Hardware/IoPorts.cpp IoPort::Allocate - portUsedBy[lp] tracking, \"Pin '%s' is not free\"", "dwc-gcode-core src/project.ts pinSymbolIdentity (task 17, Part B)"] },
	{ id: "project/unknown-pin-name", severity: "warning", category: "project",
		description: "A kind:\"pin\" parameter's value doesn't match any alias (or, for a community/TGBTC board, the generic port.pin syntax) in a known board's own pin table. Warning, not error, since an unmatched name might just mean the board isn't one this package's generated tables cover yet, not that the name is definitely wrong. Only checked when DiagnoseOptions.boards names a board for that pin's own CAN address - skipped entirely otherwise, never guessed.",
		sources: ["dwc-gcode-core src/pins/tables.ts lookupPinName (task 17, Part B, Steps 5/6)"] },

	// release
	{ id: "release/impact", severity: "warning", category: "release",
		description: "A command, parameter, object-model path or expression-syntax feature this file uses changed between the file's own stamped RRF version and the target version (task 12's impactOf) - in either direction.",
		sources: ["dwc-gcode-core src/releases/changes.ts, src/releases/impact.ts (task 12)"] },
	// The tiers `releases/diagnostics.ts`'s `impactToDiagnostics` reports a firmware-change scan in (`scanImpact`).
	{ id: "release/removed", severity: "warning", category: "release",
		description: "A command, parameter, object-model path or syntax feature this file uses is removed by the firmware change being checked (upgrading), or does not exist yet at the older version (downgrading). Reported by a scan between two firmware versions, not by diagnoseDocument.",
		sources: ["dwc-gcode-core src/releases/diagnostics.ts, src/releases/changes.ts"] },
	{ id: "release/changed", severity: "info", category: "release",
		description: "A command, parameter, object-model path or syntax feature this file uses behaves differently, or was added, between the two firmware versions being checked. Reported by a scan between two firmware versions, not by diagnoseDocument.",
		sources: ["dwc-gcode-core src/releases/diagnostics.ts, src/releases/changes.ts"] },
	{ id: "release/deprecated", severity: "info", category: "release",
		description: "A command, parameter or object-model path this file uses is deprecated by the firmware change being checked. Reported by a scan between two firmware versions, not by diagnoseDocument.",
		sources: ["dwc-gcode-core src/releases/diagnostics.ts, src/releases/changes.ts"] },
	{ id: "release/default-changed", severity: "info", category: "release",
		description: "A command in this file omits a parameter whose default (or whose being required) changed between the two firmware versions being checked. Fires on every such line, so a host normally lets the user dismiss it per change. Reported by a scan between two firmware versions, not by diagnoseDocument.",
		sources: ["dwc-gcode-core src/releases/diagnostics.ts, src/releases/changes.ts"] },

	// menu
	{ id: "menu/unknown-command", severity: "error", category: "menu",
		description: "A menu file's command word isn't one of the six RRF recognises (image, text, button, value, alter, files).",
		sources: ["RRF 3.7.0-rc.2 Display/Menu.cpp Menu::ParseMenuLine (task 08)"] },
	{ id: "menu/target-missing", severity: "error", category: "menu",
		description: "A \"menu\" action's target isn't a menu file present in the project - either the L parameter (the common \"A\\\"menu\\\" L\\\"name\\\"\" form: RRF's own case 'L' sets \"fname\", which is what \"menu\" chains to) or a name embedded right in the action text (\"menu <name>\", the separate form EncoderAction_ExecuteHelper also recognises).",
		sources: ["RRF 3.7.0-rc.2 src/Display/Menu.cpp:39 \"'menu' (chains to the menu file given in the L parameter)\"", "RRF 3.7.0-rc.2 src/Display/Menu.cpp:357-366 case 'L' sets fname", "RRF 3.7.0-rc.2 src/Display/Menu.cpp:580 EncoderAction_ExecuteHelper StringStartsWithIgnoreCase(cmd, \"menu \")"] },
	{ id: "menu/image-missing", severity: "error", category: "menu",
		description: "An image command's own file (its L parameter - RRF's \"fname\", the same letter \"menu\" chains through) isn't present in the project's 0:/menu/ directory.",
		sources: ["RRF 3.7.0-rc.2 src/Display/Menu.cpp:357-366 case 'L' sets fname", "RRF 3.7.0-rc.2 src/Display/Menu.cpp:407 new ImageMenuItem(row, column, fname)"] },
	{ id: "menu/parse-error", severity: "error", category: "menu",
		description: "A menu line RRF can't parse: a command word not cleanly followed by a space (\"Bad command\"), an unknown parameter letter (\"Bad arg letter\") or a T/L/A/I parameter without its quoted string (\"Missing string arg\"). RRF stops loading the WHOLE menu at the first such line and shows \"Error loading menu\" instead - so one bad line blanks the menu.",
		sources: ["RRF 3.7.0-rc.2 src/Display/Menu.cpp Menu::ParseMenuLine (returns the message)", "RRF 3.7.0-rc.2 src/Display/Menu.cpp Menu::Reload (LoadError(...); break;)"] },
	{ id: "menu/buffer-full", severity: "error", category: "menu",
		description: "A menu's strings (text, actions, file names, directories, expressions) outgrow RRF's 2500-byte menu buffer, so loading stops there and the display shows \"|Menu buffer full\" instead of the menu. Split the menu across files (a button with A\"menu\" L\"name\").",
		sources: ["RRF 3.7.0-rc.2 src/Display/Menu.h CommandBufferSize = 2500", "RRF 3.7.0-rc.2 src/Display/Menu.cpp Menu::Reload (commandBufferIndex == sizeof(commandBuffer))"] },
	{ id: "menu/line-too-long", severity: "warning", category: "menu",
		description: "A menu line of 120 characters or more. RRF reads menu files in 120-byte chunks (Menu::MaxMenuLineLength), so a longer line is split and the rest is parsed as a separate - almost certainly invalid - line.",
		sources: ["RRF 3.7.0-rc.2 src/Display/Menu.h MaxMenuLineLength = 120", "RRF 3.7.0-rc.2 src/Storage/FileStore.cpp FileStore::ReadLine (\"the line will be split\")"] },
	{ id: "menu/unknown-value-code", severity: "warning", category: "menu",
		description: "A value/alter item's N code isn't one RRF knows, so the display shows *** in its place (heater/fan/extruder groups 0-4, and the assigned misc items 500, 501, 510-515, 520, 521, 530-539).",
		sources: ["RRF 3.7.0-rc.2 src/Display/Menu.cpp header comment (value index table)", "RRF 3.7.0-rc.2 src/Display/ValueMenuItem.cpp ValueMenuItem::Draw (error = true)"] },

	// data
	{ id: "data/height-map-error", severity: "error", category: "data",
		description: "heightmap.csv failed to load - reported with exactly the message RRF's own loader would give.",
		sources: ["RRF 3.7.0-rc.2 Movement/BedProbing/Grid.cpp (task 08's parseHeightMap)"] },

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

const MAX_GCODE_STRING_LENGTH = 256; // RRF 3.7.0-rc.2 Config/Configuration.h:169 - includes the null terminator

/** Closing keywords from other languages (and near misses of RRF's own) and what RRF wants instead. */
const FOREIGN_KEYWORD_HINTS: ReadonlyMap<string, string> = new Map([
	["endif", "RRF has no endif - an if block ends where the indentation returns to the if's level"],
	["endwhile", "RRF has no endwhile - a while block ends where the indentation returns to the while's level"],
	["endfor", "RRF has no for loop or endfor - use a while loop; a block ends where the indentation returns"],
	["end", "RRF has no end keyword - a block ends where the indentation returns to its opening line's level"],
	["fi", "RRF has no fi - an if block ends where the indentation returns to the if's level"],
	["done", "RRF has no done - a while block ends where the indentation returns to the while's level"],
	["then", "RRF has no then - the condition is the whole of the if line; indent the lines that follow it"],
	["do", "RRF has no do - the condition is the whole of the while line; indent the lines that follow it"],
	["elseif", "RRF spells it elif"],
	["elsif", "RRF spells it elif"],
	["for", "RRF has no for loop - use a while loop with a var counter"],
	["return", "RRF has no return - use abort to stop a macro, or let the indentation end the block"],
]);

/**
 * A line of words where G-code was meant - a note that lost its `;`. RRF cannot read it: when it is not a command, a meta-command
 * or a comment, DecodeCommand makes it a "bad command" and ActOnCode answers `Bad command: <line>`. Also reported: a line that
 * starts with G, M or T followed straight by a letter instead of a number (`Move to the front`, `Tool change`, `go home`); the
 * lexer reads the first letter as a command with no number, which RRF would run as a bare G/M (an error) or T (a tool report), so
 * nothing in the line is what its author meant.
 *
 * A code WITH a number is not this rule's business - `dictionary/unknown-command` covers it, and knows the custom codes. A line
 * that could be the CNC/laser repeat of the last G0-G3 (a letter then something that is not a letter: `X10 Y20`) is never reported:
 * that is valid on a CNC or laser machine, whose mode a static check does not know. A line RRF rejects in every mode is: one that
 * starts with something other than a letter, and one whose first two characters are letters (`endif`, `foo`): RRF checks for that
 * to tell a meta command from an axis word.
 */
function checkBadCommand(line: GcodeDocument["lines"][number], options: DiagnoseOptions, path: string): Diagnostic | null {
	if (line.kind !== "fields" && line.kind !== "unrecognised" && line.kind !== "commands") return null;
	let at = line.lineNumber !== null ? line.lineNumber.end : line.indent;
	while (line.raw[at] === " " || line.raw[at] === "\t") at++;
	const content = line.raw.slice(at);
	if (content.length === 0) return null;
	const word = /^[^\s;{"(*]+/.exec(content)?.[0] ?? content[0];
	const lower = word.toLowerCase();
	if (line.kind === "commands") {
		// Only a first command that is a bare letter running straight into a word.
		const first = line.commands[0];
		if (first === undefined || first.start !== at || first.number !== null || !/[A-Za-z]/.test(content[1] ?? "")) return null;
	} else {
		// A capitalised meta keyword has its own, more specific rule.
		if (META_KEYWORDS.has(lower) && word !== lower) return null;
		const mayBeContinuation = line.kind === "fields" && !/[A-Za-z]/.test(content[1] ?? "") && !/^[GMTgmt]/.test(content);
		if (mayBeContinuation) return null;
	}
	const text = content.split(";")[0].trim();
	const looksLikeProse = /^[A-Za-z][A-Za-z'’,.:!?-]*(\s+[A-Za-z0-9'’,.:!?()-]+)+$/.test(text);
	const hint = FOREIGN_KEYWORD_HINTS.get(word);
	const note = "if this is a note, start the line with ; to make it a comment";
	const message = hint !== undefined ? `"${word}" is not a command: ${hint}. RRF reports "Bad command" for this line`
		: looksLikeProse ? `This line reads like text, not G-code (a G, M or T command is a letter and a number) - ${note}`
		: `"${word}" is not a G, M or T command, a meta-command or a comment - ${note}`;
	return makeDiag("syntax/bad-command", options, path, line.index, line.start + at, line.start + at + word.length, message,
		RULE_BY_ID.get("syntax/bad-command")!.sources,
		[{ title: "Turn the line into a comment", edits: [{ start: line.start + at, end: line.start + at, newText: "; " }] }]);
}

// ── text after a command ──

interface LineToken { start: number; end: number; text: string }

/** Whitespace-separated tokens of `raw[from, to)`, keeping a quoted string or a `{...}` expression in one piece. */
function tokensOf(raw: string, from: number, to: number): Array<LineToken> {
	const out: Array<LineToken> = [];
	let i = from;
	while (i < to) {
		if (raw[i] === " " || raw[i] === "\t") { i++; continue; }
		const start = i;
		let quoted = false;
		let depth = 0;
		while (i < to) {
			const c = raw[i];
			if (c === "\"") quoted = !quoted;
			else if (!quoted && c === "{") depth++;
			else if (!quoted && c === "}" && depth > 0) depth--;
			else if (!quoted && depth === 0 && (c === " " || c === "\t")) break;
			i++;
		}
		out.push({ start, end: i, text: raw.slice(start, i) });
	}
	return out;
}

const TEXT_START = /^[A-Za-z][a-z]{2,}$/;
const TEXT_MORE = /^[A-Za-z][a-z'’-]+$/;
const NUMBER_TOKEN = /^\d+(?:\.\d+)?$/;
const AXIS_LIKE = /^[xyzuvwabc]{1,3}$/i;
const STRINGISH_KINDS: ReadonlySet<string> = new Set(["string", "filename", "any"]);

function stripPunctuation(token: string): string {
	return token.replace(/^\(+/, "").replace(/[.,:;!?)]+$/, "");
}

interface TextGroup { start: number; end: number; command: LexedCommand }

interface CommandProfile { known: ReadonlyMap<string, ParamSpec>; lenient: boolean }

/** What a word after `cmd` is judged against, or null when the command's text is not letter parameters (or not judged). */
function profileOf(cmd: LexedCommand): CommandProfile | null {
	if (cmd.stringArgument !== null) return null;
	const spec = commandSpec(cmd.code);
	if (spec === null || spec.reviewed === undefined || spec.stringArgument === true) return null;
	const variant = selectedVariant(spec, cmd);
	const known = new Map(spec.parameters.map((p) => [p.letter.toUpperCase(), p]));
	if (variant !== undefined) for (const p of variant.parameters) known.set(p.letter.toUpperCase(), p);
	const catchAll = variant !== undefined ? variant.axisParameters !== undefined : spec.axisParameters !== undefined;
	// A catch-all (any axis letter) or a macro call (every letter is a macro parameter) accepts any letter, so only the shape judges.
	return { known, lenient: catchAll || passesParametersToMacro(spec, cmd) !== null };
}

function startsText(word: string, profile: CommandProfile): boolean {
	if (!TEXT_START.test(word)) return false;
	const letters = [...word.toUpperCase()];
	const first = profile.known.get(letters[0]);
	if (first !== undefined && STRINGISH_KINDS.has(first.kind)) return false; // `M550 Pname`: an unquoted string value
	if (profile.lenient) return !(word.length <= 3 && AXIS_LIKE.test(word)); // `g28 xyz` is lowercase axis letters
	return !letters.every((l) => profile.known.has(l)); // `m18 xy`: every letter is a real parameter
}

/**
 * Words after a command's parameters - `M104 S200 heat up`, `G28 home all axes`, `G1 X10 moves left`: a note that lost its `;`.
 * RRF reads every letter in them as a parameter, so they raise a string of unrelated parameter errors (or none, when the command
 * passes parameters to a macro). A group starts at a lowercase word of three or more letters that is not a parameter of that
 * command and runs over the lowercase words (and numbers) that follow it. Never reported: text a command takes as its argument
 * (M117, echo), a command the dictionary has no reviewed entry for (a custom code), a word that is only real parameter letters
 * (`M18 xy`), and an unquoted string value (`M550 Pname`). The lexer starts a "command" in the middle of such words (`moves`
 * has an `M`), so commands without a number and without an entry are not boundaries.
 */
function textGroupsOf(line: DocumentLine): Array<TextGroup> {
	if (line.kind !== "commands") return [];
	const real = line.commands.filter((c) => c.number !== null || commandSpec(c.code) !== null);
	if (real.length === 0) return [];
	const from = line.lineNumber !== null ? line.lineNumber.end : line.indent;
	const to = line.comment !== null ? line.comment.start : line.raw.length;
	const inBracket = (at: number): boolean => line.bracketedComments.some((b) => at >= b.start && at < b.end);
	const groups: Array<TextGroup> = [];
	let open: TextGroup | null = null;
	for (const tok of tokensOf(line.raw, from, to)) {
		if (inBracket(tok.start)) continue;
		let cmd: LexedCommand | undefined;
		for (const c of real) if (c.start <= tok.start) cmd = c;
		const word = stripPunctuation(tok.text);
		if (open !== null && cmd !== undefined && cmd === open.command && tok.start !== cmd.start) {
			if (TEXT_MORE.test(word)) { open.end = tok.end; continue; }
			if (NUMBER_TOKEN.test(word)) continue;
		}
		if (open !== null) { groups.push(open); open = null; }
		if (cmd === undefined || tok.start === cmd.start) continue;
		const profile = profileOf(cmd);
		if (profile !== null && startsText(word, profile)) open = { start: tok.start, end: tok.end, command: cmd };
	}
	if (open !== null) groups.push(open);
	return groups;
}

function checkTextAfterCommand(line: DocumentLine, options: DiagnoseOptions, path: string): Array<Diagnostic> {
	const out: Array<Diagnostic> = [];
	for (const g of textGroupsOf(line)) {
		const text = line.raw.slice(g.start, g.end);
		const start = line.start + g.start;
		const d = makeDiag("syntax/text-after-command", options, path, line.index, start, line.start + g.end,
			`"${text}" is text, not a parameter of ${g.command.code} - if it is a note, start it with ; to make it a comment`,
			RULE_BY_ID.get("syntax/text-after-command")!.sources,
			[{ title: "Turn into a comment", edits: [{ start, end: start, newText: "; " }] }]);
		if (d !== null) out.push(d);
	}
	return out;
}

function checkSyntax(doc: GcodeDocument, path: string, options: DiagnoseOptions): Array<Diagnostic> {
	const out: Array<Diagnostic> = [];
	for (const err of doc.errors) {
		const isStructural = ["elif-without-if", "else-without-if", "else-after-else", "break-outside-loop", "continue-outside-loop", "t-not-alone", "mixed-indentation"].includes(err.code);
		const ruleId = isStructural ? "structure/document-error" : "syntax/lexer-error";
		const d = makeDiag(ruleId, options, path, err.line, err.start, err.end, err.message, RULE_BY_ID.get(ruleId)!.sources);
		if (d !== null) out.push(d);
	}

	for (const line of doc.lines) {
		const bad = checkBadCommand(line, options, path);
		if (bad !== null) out.push(bad);
		else out.push(...checkTextAfterCommand(line, options, path)); // a whole line of text is one finding

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
						`"${match[1]}" is not a meta-command - RRF only recognises "${lower}" in all-lowercase; RRF reports "Bad command" for this line`,
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

/**
 * Whether a literal (non-expression) value's own text looks like the dictionary's declared kind -
 * deliberately loose (this is a lint, not a re-implementation of RRF's own number grammar from
 * Duet3D/RRFLibraries, out of scope per task 07's own Findings), EXCEPT for `"number"`, which reuses
 * `lex.ts`'s own `NUMBER_RE` rather than a second, independently-drifting copy: a real bug found this
 * way (`looksLikeKind`'s own regex rejected `7.06e-8`, a genuinely valid RRF float used for M308's C
 * coefficient among others, while `NUMBER_RE` already accepted it - the two had drifted apart).
 *
 * The other numeric-ish kinds (`integer`/`unsigned`/`heaterNumber`/`fanNumber`/`sensorNumber`/
 * `probeNumber`/`toolNumber`) deliberately do NOT get exponent support even though they share this
 * function's general "numeric" bucket: RRF reads every one of them through `ReadUIValue`/`ReadIValue`
 * → `StrToU32`/`StrToI32`, which call `NumericConverter::Accumulate` with `AcceptOnlyUnsignedDecimal`/
 * `AcceptNegative` - options that do NOT include `AcceptFloat`, so `Accumulate`'s own exponent-parsing
 * block (gated on `AcceptFloat`) never runs for them. Confirmed directly against the dictionary's own
 * cited sources: every `kind: "number"` parameter's source names a `Get`/`TryGetFValue`-family call
 * (the float path); every `integer`/`unsigned`/`sensorNumber` parameter's source names a
 * `Get`/`TryGetIValue`/`UIValue`-family call (the integer path) - no exceptions found in the current
 * dictionary. This bucket's own decimal-point tolerance for integer-ish kinds was already looser than
 * real RRF (which accepts no decimal point there either) - left as-is per this function's own
 * documented "not a precise re-implementation" stance, since that looseness only causes a false
 * negative (a lint miss), not a false positive like the exponent bug did.
 */
function looksLikeKind(value: string, kind: ParamSpec["kind"]): boolean {
	switch (kind) {
		case "number":
			return NUMBER_RE.test(value) || value.includes(":"); // a list is checked element-wise by the caller
		case "integer": case "unsigned":
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

/** RRF's `General/StringFunctions.cpp` `ReducedStringEquals` - case-insensitive, and `-`/`_` on
 *  either side are skipped rather than compared. Used only where a dictionary entry's own
 *  `valueMatch: "reduced"` cites it (M308's `Y`, `Heating/Sensors/TemperatureSensor.cpp`
 *  `TemperatureSensor::Create`'s `ReducedStringEquals(typeName, desc->GetName())`) - most RRF string
 *  enums use the stricter `NamedEnum`/`strcmp` instead (`valueMatch` omitted, the default). */
function reducedStringEquals(a: string, b: string): boolean {
	// A direct port of the C++ `while (*s1 != 0 && *s2 != 0) { ... } return *s1 == 0 && *s2 == 0;`
	// shape - a dash/underscore is only skipped while BOTH strings still have characters left, so a
	// trailing dash/underscore on one side after the other has already ended is NOT ignored (e.g.
	// "foo" != "foo-"). A naive per-side "skip trailing separators" helper gets this case wrong.
	let i = 0, j = 0;
	while (i < a.length && j < b.length) {
		if (a[i] === "-" || a[i] === "_") {
			i++;
		} else if (b[j] === "-" || b[j] === "_") {
			j++;
		} else if (a[i].toLowerCase() !== b[j].toLowerCase()) {
			return false;
		} else {
			i++; j++;
		}
	}
	return i === a.length && j === b.length;
}

/** Whether a user-defined macro for this G/M code (`/sys/<code>.g`) is known to exist - from the
 *  project's own files, or from `DiagnoseOptions.customCodes` when the caller has only a folder
 *  listing rather than a loaded project. */
function hasUserMacro(code: string, options: DiagnoseOptions, project: Project | undefined): boolean {
	if (project?.customCodes.has(code) === true) return true;
	const listed = options.customCodes;
	if (listed === undefined) return false;
	return listed instanceof Set ? listed.has(code) : (listed as ReadonlyArray<string>).includes(code);
}

/** The firmware build in play: `DiagnoseOptions.platform` if given, else whatever family the
 *  mainboard (`boards` key `0`) belongs to, else `undefined` - a platform-specific entry is never
 *  judged against a guess. */
function platformOf(options: DiagnoseOptions): FirmwarePlatform | undefined {
	if (options.platform !== undefined) return options.platform;
	const mainboard = options.boards?.get(0);
	return mainboard === undefined ? undefined : platformOfBoard(mainboard) ?? undefined;
}

function describePlatforms(platforms: ReadonlyArray<FirmwarePlatform>): string {
	return platforms.map((p) => (p === "stm32" ? "STM32 (gloomyandy fork)" : "Duet3D")).join("/");
}

/** The letters RRF reads for itself when this command runs a macro (so they are still checked
 *  against the entry), or `null` when it isn't handing its parameters to one on this line. Every
 *  other letter is a macro parameter (`CommandSpec.macroParameters`). */
function passesParametersToMacro(spec: CommandSpec, cmd: LexedCommand): ReadonlySet<string> | null {
	const macro = spec.macroParameters;
	if (macro === undefined) return null;
	if (macro.trigger !== undefined) {
		const trigger = macro.trigger.toUpperCase();
		if (!cmd.params.some((p) => p.letter.toUpperCase() === trigger)) return null;
	}
	return new Set((macro.except ?? []).map((l) => l.toUpperCase()));
}

function checkDictionaryForCommand(path: string, line: DocumentLine, cmd: LexedCommand, options: DiagnoseOptions, project: Project | undefined): Array<Diagnostic> {
	const out: Array<Diagnostic> = [];
	const spec = commandSpec(cmd.code);

	if (spec === null) {
		if (hasUserMacro(cmd.code, options, project)) return out; // a user-defined G/M code - its own macro gives it its meaning
		const macroFile = reachesMacroFile(cmd.code) ? macroFileForCode(cmd.code) : null;
		const message = macroFile !== null
			? `${cmd.code} isn't a known command - RRF would try to run /sys/${macroFile} for it`
			: `${cmd.code} isn't a known command, and RRF doesn't look for a macro for it`;
		const d = makeDiag("dictionary/unknown-command", options, path, line.index, line.start + cmd.start, line.start + cmd.end,
			message, RULE_BY_ID.get("dictionary/unknown-command")!.sources);
		if (d !== null) out.push(d);
		return out;
	}

	if (spec.reviewed === undefined) return out; // a draft entry's parameter list is a heuristic, not a fact - stay silent

	if (spec.since !== undefined && compareFirmwareVersions(options.firmwareVersion, spec.since) < 0) {
		const d = makeDiag("dictionary/not-available-on-firmware", options, path, line.index, line.start + cmd.start, line.start + cmd.end,
			`${cmd.code} isn't available until RRF ${spec.since}`, RULE_BY_ID.get("dictionary/not-available-on-firmware")!.sources);
		if (d !== null) out.push(d);
	}
	// A macro-only entry (`unimplemented`) that lost its `case` is still a legitimate `/sys/<code>.g` trigger, so it is not judged.
	if (spec.until !== undefined && spec.unimplemented !== true && compareFirmwareVersions(options.firmwareVersion, spec.until) > 0) {
		const d = makeDiag("dictionary/not-available-on-firmware", options, path, line.index, line.start + cmd.start, line.start + cmd.end,
			`${cmd.code} isn't available after RRF ${spec.until}`, RULE_BY_ID.get("dictionary/not-available-on-firmware")!.sources);
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

	const platform = platformOf(options);
	if (platform !== undefined && spec.platforms !== undefined && !spec.platforms.includes(platform)) {
		const d = makeDiag("dictionary/not-available-on-platform", options, path, line.index, line.start + cmd.start, line.start + cmd.end,
			`${cmd.code} only exists on ${describePlatforms(spec.platforms)} firmware, not ${describePlatforms([platform])}`,
			RULE_BY_ID.get("dictionary/not-available-on-platform")!.sources);
		if (d !== null) out.push(d);
	}

	if (spec.stringArgument === true) return out; // whole remainder is a string, not letter parameters

	const variant = selectedVariant(spec, cmd);
	const known = new Map(spec.parameters.map((p) => [p.letter.toUpperCase(), p]));
	if (variant !== undefined) for (const p of variant.parameters) known.set(p.letter.toUpperCase(), p);
	const hasAxisCatchAll = variant !== undefined ? variant.axisParameters !== undefined : spec.axisParameters !== undefined;
	const macroPassThrough = passesParametersToMacro(spec, cmd);
	const seen = new Set<string>();
	for (const param of cmd.params) {
		const letter = param.letter.toUpperCase();
		seen.add(letter);
		// A command that runs a macro hands every other letter to it as param.<letter> - RRF doesn't
		// read them, so there is nothing to check them against (CommandSpec.macroParameters).
		if (macroPassThrough !== null && !macroPassThrough.has(letter)) continue;
		const paramSpec = known.get(letter);
		if (paramSpec === undefined) {
			if (hasAxisCatchAll && /^[A-Z]$/.test(letter)) continue; // a generic axis letter
			const d = makeDiag("dictionary/unknown-parameter", options, path, line.index, line.start + param.start, line.start + param.end,
				`${cmd.code} doesn't have a ${letter} parameter${variant !== undefined ? ` for ${variant.label}` : ""}`, RULE_BY_ID.get("dictionary/unknown-parameter")!.sources);
			if (d !== null) out.push(d);
			continue;
		}

		if (platform !== undefined && paramSpec.platforms !== undefined && !paramSpec.platforms.includes(platform)) {
			const d = makeDiag("dictionary/not-available-on-platform", options, path, line.index, line.start + param.start, line.start + param.end,
				`${cmd.code}'s ${letter} only exists on ${describePlatforms(paramSpec.platforms)} firmware, not ${describePlatforms([platform])}`,
				RULE_BY_ID.get("dictionary/not-available-on-platform")!.sources);
			if (d !== null) out.push(d);
		}
		if (paramSpec.since !== undefined && compareFirmwareVersions(options.firmwareVersion, paramSpec.since) < 0) {
			const d = makeDiag("dictionary/not-available-on-firmware", options, path, line.index, line.start + param.start, line.start + param.end,
				`${cmd.code}'s ${letter} isn't available until RRF ${paramSpec.since}`, RULE_BY_ID.get("dictionary/not-available-on-firmware")!.sources);
			if (d !== null) out.push(d);
		}
		if (paramSpec.until !== undefined && compareFirmwareVersions(options.firmwareVersion, paramSpec.until) > 0) {
			const d = makeDiag("dictionary/not-available-on-firmware", options, path, line.index, line.start + param.start, line.start + param.end,
				`${cmd.code}'s ${letter} isn't available after RRF ${paramSpec.until}`, RULE_BY_ID.get("dictionary/not-available-on-firmware")!.sources);
			if (d !== null) out.push(d);
		}

		if (isExpression(param)) continue; // can't shape-check an expression statically

		const pieces = paramSpec.list ? param.value.split(":") : [param.value];
		if (!pieces.every((p) => looksLikeKind(p.trim(), paramSpec.kind))) {
			const d = makeDiag("dictionary/wrong-kind", options, path, line.index, line.start + param.start, line.start + param.end,
				`${cmd.code}'s ${letter} should be ${describeKind(paramSpec)}, not "${param.value}"`, RULE_BY_ID.get("dictionary/wrong-kind")!.sources);
			if (d !== null) out.push(d);
		} else if (paramSpec.listLength !== undefined && !paramSpec.listLength.includes(pieces.length)) {
			const d = makeDiag("dictionary/value-out-of-range", options, path, line.index, line.start + param.start, line.start + param.end,
				`${cmd.code}'s ${letter} takes ${paramSpec.listLength.join(" or ")} colon-separated value(s), not ${pieces.length}`,
				RULE_BY_ID.get("dictionary/value-out-of-range")!.sources);
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
		} else if (paramSpec.values !== undefined && pieces.length === 1 && !isOnAnotherBoard(paramSpec.valuesLocalOnlyVia, cmd)) {
			// A string-kind value keeps its quotes verbatim in LexedParam.value (lex.ts) - unquote
			// before comparing, or every quoted enum value would wrongly fail every values check.
			const actual = paramSpec.kind === "string" ? unquoteString(pieces[0].trim()) : pieces[0].trim();
			const matches = paramSpec.valueMatch === "reduced"
				? (a: string, b: string) => reducedStringEquals(a, b)
				: (a: string, b: string) => a === b;
			if (!paramSpec.values.some((v) => matches(v.value, actual))) {
				const d = makeDiag("dictionary/value-out-of-range", options, path, line.index, line.start + param.start, line.start + param.end,
					`${cmd.code}'s ${letter} value "${pieces[0]}" isn't one of ${paramSpec.values.map((v) => v.value).join("/")}`,
					RULE_BY_ID.get("dictionary/value-out-of-range")!.sources);
				if (d !== null) out.push(d);
			}
		}
	}

	for (const paramSpec of known.values()) {
		if (paramSpec.requiredSince !== undefined && compareFirmwareVersions(options.firmwareVersion, paramSpec.requiredSince) < 0) continue;
		if (isRequiredHere(paramSpec, cmd) && !seen.has(paramSpec.letter.toUpperCase())) {
			const why = typeof paramSpec.required === "object" ? ` when ${paramSpec.required.ifLetterPresent} is given` : "";
			const d = makeDiag("dictionary/missing-required", options, path, line.index, line.start + cmd.start, line.start + cmd.end,
				`${cmd.code} needs a ${paramSpec.letter} parameter${why}`, RULE_BY_ID.get("dictionary/missing-required")!.sources);
			if (d !== null) out.push(d);
		}
	}

	return out;
}

/** The `CommandSpec.selectorVariants` variant this line selects: its selector letter is a plain number matching one of
 *  the variant's `values`. `undefined` when the command has no variants, the selector is absent or an expression, or
 *  no variant names the value - then the line is judged as if there were no variants. */
function selectedVariant(spec: CommandSpec, cmd: LexedCommand): ParamVariant | undefined {
	const sv = spec.selectorVariants;
	if (sv === undefined) return undefined;
	const selector = cmd.params.find((p) => p.letter.toUpperCase() === sv.selector.toUpperCase());
	if (selector === undefined || isExpression(selector)) return undefined;
	const text = selector.value.trim();
	if (text === "" || !Number.isFinite(Number(text))) return undefined;
	return sv.variants.find((v) => v.values.some((value) => Number(value) === Number(text)));
}

/** Whether the command's `letter` parameter names a port on a CAN expansion board other than the main board
 *  (`123.dummy`, `121.temp0`): a leading number and a dot, not board 0. */
function isOnAnotherBoard(letter: string | undefined, cmd: LexedCommand): boolean {
	if (letter === undefined) return false;
	const param = cmd.params.find((p) => p.letter.toUpperCase() === letter.toUpperCase());
	if (param === undefined || param.kind === "expression") return false;
	const m = /^(\d+)\./.exec(unquoteString(param.value.trim()));
	return m !== null && Number(m[1]) !== 0;
}

/** `paramSpec.required`'s object form (`src/dictionary/schema.ts`) - a same-line condition on
 *  exactly one companion letter, mirroring the single `gb.Seen(...)` check every real case turned out
 *  to be. `"unknown"` and `undefined` both mean "never flag", same as before this form existed. */
function isRequiredHere(paramSpec: ParamSpec, cmd: LexedCommand): boolean {
	if (paramSpec.required === true) return true;
	if (typeof paramSpec.required !== "object") return false;
	const cond = paramSpec.required;
	const companion = cmd.params.find((p) => p.letter.toUpperCase() === cond.ifLetterPresent.toUpperCase());
	if (companion === undefined || companion.kind === "expression") return false; // can't evaluate a {...} condition statically
	const value = unquoteString(companion.value.trim());
	if (cond.valueOneOf !== undefined && !cond.valueOneOf.includes(value)) return false;
	if (cond.valueNot !== undefined && value === cond.valueNot) return false;
	return true;
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
	const syntax = checkSyntax(doc, path, options);
	// Where a line's text starts: the lexer reads letters in it as parameters and even as commands, and what the dictionary says
	// about those is noise next to "this is text".
	const textFrom = new Map<number, number>();
	for (const d of syntax) {
		if (d.rule !== "syntax/bad-command" && d.rule !== "syntax/text-after-command") continue;
		const at = textFrom.get(d.line);
		if (at === undefined || d.start < at) textFrom.set(d.line, d.start);
	}
	const rest = [
		...checkStructure(doc, path, options),
		...checkDictionary(doc, path, options, project),
		...checkObjectModel(doc, path, options),
		...checkRelease(doc, path, options),
	].filter((d) => {
		const at = textFrom.get(d.line);
		if (at === undefined) return true;
		if (d.rule === "structure/macro-command-not-last") return false;
		return !(d.rule.startsWith("dictionary/") && d.start >= at);
	});
	// `Tool change`: the T is a word, not a second command on the line.
	const kept = syntax.filter((d) => !(d.rule === "structure/document-error" && d.message.startsWith("A T command") && textFrom.has(d.line)));
	return [...kept, ...rest];
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
		if (symbol.type === "pin") {
			// Pin sites are always role:"use" (project.ts never marks one "define") - a SECOND
			// unconditional use of the same physical pin is the interesting case here, the opposite
			// shape from every other symbol type above.
			const unconditionalUses = symbol.uses.filter((s) => !s.conditional);
			if (unconditionalUses.length > 1) {
				for (const site of unconditionalUses.slice(1)) {
					const d = makeDiag("project/pin-already-used", options, site.file, site.line, site.start, site.end,
						`pin ${symbol.id} is already used elsewhere in this project`, RULE_BY_ID.get("project/pin-already-used")!.sources);
					if (d !== null) out.push(d);
				}
			}
			if (options.boards !== undefined) {
				const dotIndex = symbol.id.indexOf(".");
				const boardAddress = Number(symbol.id.slice(0, dotIndex));
				const baseName = symbol.id.slice(dotIndex + 1);
				const boardId = options.boards.get(boardAddress);
				// Re-resolves fresh here rather than trusting whatever ProjectOptions.boards the
				// project was loaded with (schema.ts's own doc comment on this field) - safe and
				// idempotent either way: if pinSymbolIdentity already resolved this to a real
				// canonicalName at load time, looking that same string up again still succeeds
				// (a board table's own canonical name is always one of its own aliases).
				if (boardId !== undefined && lookupPinName(boardId, baseName) === null) {
					for (const site of symbol.uses) {
						const d = makeDiag("project/unknown-pin-name", options, site.file, site.line, site.start, site.end,
							`pin "${baseName}" isn't a known pin name on board "${boardId}"`, RULE_BY_ID.get("project/unknown-pin-name")!.sources);
						if (d !== null) out.push(d);
					}
				}
			}
			continue; // pins don't participate in the generic duplicate-definition check below (they're never "defined")
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

	// Lines start at these absolute offsets (same "+1 for the newline" assumption as the loop below).
	const lineStarts: Array<number> = [];
	for (const l of menu.lines) {
		lineStarts.push(offset);
		offset += l.raw.length + 1;
	}
	offset = 0;

	// Problems that stop RRF loading the menu (Unknown command has its own rule, below).
	for (const err of menu.errors) {
		if (err.message === "Unknown command") continue;
		const start = lineStarts[err.line - 1] + err.column - 1;
		const d = makeDiag("menu/parse-error", options, path, err.line - 1, start, start + 1,
			`${err.message} - RRF stops loading the whole menu here`, RULE_BY_ID.get("menu/parse-error")!.sources);
		if (d !== null) out.push(d);
	}
	const resolved = resolveMenuDocument(menu);
	if (resolved.firstError?.message === "|Menu buffer full") {
		const at = resolved.firstError.line - 1;
		const d = makeDiag("menu/buffer-full", options, path, at, lineStarts[at], lineStarts[at] + menu.lines[at].raw.length,
			"the menu's strings no longer fit RRF's 2500-byte menu buffer, so RRF stops loading here", RULE_BY_ID.get("menu/buffer-full")!.sources);
		if (d !== null) out.push(d);
	}

	for (const [index, line] of menu.lines.entries()) {
		if (line.raw.length >= MENU_MAX_LINE_LENGTH) {
			const d = makeDiag("menu/line-too-long", options, path, index, offset + MENU_MAX_LINE_LENGTH - 1, offset + line.raw.length,
				`${line.raw.length} characters: RRF splits menu lines at ${MENU_MAX_LINE_LENGTH - 1}, so the rest is read as a separate line`,
				RULE_BY_ID.get("menu/line-too-long")!.sources);
			if (d !== null) out.push(d);
		}
		if (line.kind === "command" && (line.command?.toLowerCase() === "value" || line.command?.toLowerCase() === "alter")) {
			const nParams = line.params.filter((p) => p.letter === "N");
			const n = nParams[nParams.length - 1];
			// A plain number only: `value N{expression}` is evaluated by the object model, not looked up here.
			if (n !== undefined && n.kind === "number" && classifyMenuValueCode(Number.parseInt(n.value || "0", 10)) === null) {
				const d = makeDiag("menu/unknown-value-code", options, path, index, offset + n.start, offset + n.end,
					`N${n.value || "0"} isn't a value code RRF knows, so the display shows ***`, RULE_BY_ID.get("menu/unknown-value-code")!.sources);
				if (d !== null) out.push(d);
			}
		}
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
