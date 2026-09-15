/**
 * Packaging audit C1 fixture (task 16, `docs/tasks/16-hardening-and-readiness.md`): a legacy
 * TypeScript `moduleResolution: "node"` consumer (the classic, pre-`exports`-map algorithm — what an
 * older webpack/Vue-CLI project still uses), importing the bare root specifier and every documented
 * subpath from the BUILT package (via `scripts/test-packaging-legacy.mjs`, which copies `package.json`
 * + `dist/` into this fixture's own `node_modules/dwc-gcode-core` first, so this is a real "npm
 * installed it" resolution, not a source-relative import). `npx tsc -p test/packaging/legacy
 * --noEmit` must succeed with zero errors; a re-introduced regression here is exactly the class of bug
 * that shipped once already (confirmed against a real DWC 3.6 build, resonance-lab's own dual DWC
 * 3.6/3.7 target — see README's "Known limitation" history).
 */

import { g10Form, tokenise } from "dwc-gcode-core";
import { lexLine } from "dwc-gcode-core/lex";
import { parseParams } from "dwc-gcode-core/params";
import { findDirectives } from "dwc-gcode-core/edit";
import { parseDocument } from "dwc-gcode-core/document";
import { classifyLine } from "dwc-gcode-core/meta";
import { supports } from "dwc-gcode-core/firmware";
import { g10Form as g10FormSub } from "dwc-gcode-core/commands/g10";
import { TOOL_PARAM_COMMANDS } from "dwc-gcode-core/commands/toolParams";
import { parseExpression } from "dwc-gcode-core/expr/parse";
import { EXPRESSION_FUNCTIONS } from "dwc-gcode-core/expr/tables";
import { classifyFile } from "dwc-gcode-core/files/kinds";
import { parseMenu } from "dwc-gcode-core/files/menu";
import { parseHeightMap } from "dwc-gcode-core/files/heightmap";
import { commandSpec } from "dwc-gcode-core/dictionary/commands";
import type { CommandSpec } from "dwc-gcode-core/dictionary/schema";
import { OBJECT_MODEL_BASELINE } from "dwc-gcode-core/objectmodel/versions";
import { objectModelPath } from "dwc-gcode-core/objectmodel/schema";
import type { ChangeEvent } from "dwc-gcode-core/releases/schema";
import { changesBetween } from "dwc-gcode-core/releases/changes";
import { impactOf } from "dwc-gcode-core/releases/impact";
import { RULES } from "dwc-gcode-core/diagnostics/rules";
import type { Diagnostic } from "dwc-gcode-core/diagnostics/schema";
import { toMonacoMarkers } from "dwc-gcode-core/diagnostics/monaco";
import { diagnoseDocument } from "dwc-gcode-core/diagnostics/diagnose";
import { loadProject } from "dwc-gcode-core/project";
import { compareDocuments } from "dwc-gcode-core/compare";
import { RRF_BASELINE } from "dwc-gcode-core/rrf";
import { CORE_VERSION } from "dwc-gcode-core/version";
import { readStamp } from "dwc-gcode-core/stamp";

// One trivial reference to each import, so a resolved-but-unused import can't hide behind
// `noUnusedLocals` being off, and so this file exercises real type positions, not just module
// resolution of the specifier string itself.
export const smoke = {
	root: [g10Form("G10"), tokenise("G1 X1")] as const,
	lex: lexLine("G1 X1"),
	params: parseParams("X1"),
	edit: typeof findDirectives,
	document: parseDocument("G1 X1\n"),
	meta: classifyLine("if true"),
	firmware: supports("3.7.0-rc.1", "m568"),
	g10: g10FormSub("G10"),
	toolParams: TOOL_PARAM_COMMANDS,
	expr: parseExpression("1+1", 0),
	exprTables: EXPRESSION_FUNCTIONS,
	fileKinds: classifyFile("config.g"),
	menu: parseMenu("text T\"hi\"\n"),
	heightmap: parseHeightMap(""),
	dictionaryCommand: commandSpec("G1"),
	dictionarySchemaType: null as CommandSpec | null,
	objectModelBaseline: OBJECT_MODEL_BASELINE,
	objectModelPath: objectModelPath("move.axes", RRF_BASELINE),
	releasesSchemaType: null as ChangeEvent | null,
	releasesChanges: changesBetween("3.6.3", RRF_BASELINE),
	releasesImpact: impactOf(parseDocument("G1 X1\n"), "3.6.3", RRF_BASELINE),
	diagnosticsRules: RULES,
	diagnosticsSchemaType: null as Diagnostic | null,
	diagnosticsMonaco: toMonacoMarkers([], ""),
	diagnosticsDiagnose: diagnoseDocument(parseDocument("G1 X1\n"), "test.g", { firmwareVersion: RRF_BASELINE }),
	project: loadProject([]),
	compare: compareDocuments(parseDocument("G1 X1\n"), parseDocument("G1 X2\n")),
	rrf: RRF_BASELINE,
	version: CORE_VERSION,
	stamp: readStamp("G1 X1\n"),
};
