/**
 * The public entry points (task 14's own API): `diagnoseDocument` for a single already-parsed file,
 * `diagnoseProject` for everything a loaded `Project` (task 13) can see - both are thin wrappers
 * around `rules.ts`'s registry-driven check functions, sorted into a stable, editor-friendly order.
 */

import type { GcodeDocument } from "../document.js";
import type { Project } from "../project.js";
import { diagnoseDocumentRules, diagnoseProjectRules } from "./rules.js";
import type { Diagnostic, DiagnoseOptions } from "./schema.js";

function bySite(a: Diagnostic, b: Diagnostic): number {
	if (a.file !== b.file) return a.file < b.file ? -1 : 1;
	if (a.line !== b.line) return a.line - b.line;
	if (a.start !== b.start) return a.start - b.start;
	return a.rule < b.rule ? -1 : a.rule > b.rule ? 1 : 0;
}

export function diagnoseDocument(doc: GcodeDocument, path: string, options: DiagnoseOptions): ReadonlyArray<Diagnostic> {
	return diagnoseDocumentRules(doc, path, options).sort(bySite);
}

export function diagnoseProject(project: Project, options: DiagnoseOptions): ReadonlyArray<Diagnostic> {
	return diagnoseProjectRules(project, options).sort(bySite);
}
