/**
 * Turns a firmware-change scan's findings into the diagnostics engine's own `Diagnostic`s, so a host that
 * already renders `diagnoseDocument`'s output (Monaco markers, CM6 lint) can render these the same way.
 *
 * Severity tiers, by what the user has to do about it: a `removed` finding (or an `added` one when
 * downgrading, the same fact seen from the other side) is a `warning` - the line will stop working; a
 * `deprecated` or `changed` one is `info`; a `whenAbsent` parameter finding is `info` under its own rule id
 * because it fires on every line that omits the letter. `options.rules` disables or re-levels any of them,
 * exactly as it does for `diagnoseDocument`.
 */
import type { Diagnostic, DiagnoseOptions, Severity } from "../diagnostics/schema.js";
import { RULES } from "../diagnostics/rules.js";
import type { ImpactFinding } from "./impact.js";

const RULE_SEVERITY: ReadonlyMap<string, Severity> = new Map(RULES.map((r) => [r.id, r.severity]));

/** Which `release/*` rule id a finding is reported under. */
export function impactRuleId(finding: Pick<ImpactFinding, "event" | "direction">): string {
	const { event, direction } = finding;
	if (event.target.type === "parameter" && event.target.whenAbsent !== undefined) return "release/default-changed";
	if (event.kind === "deprecated") return direction === "upgrade" ? "release/deprecated" : "release/changed";
	if (direction === "upgrade") return event.kind === "removed" ? "release/removed" : "release/changed";
	return event.kind === "added" ? "release/removed" : "release/changed";
}

export interface ImpactDiagnosticsOptions {
	/** Reported as each diagnostic's `file`. */
	file: string;
	rules?: DiagnoseOptions["rules"];
}

/**
 * `findings` is `impactOf`'s output for ONE document (or `scanFile`'s, whose `line`/`start`/`end` mean the
 * same). Each diagnostic keeps the finding's offsets, carries the event's citations as `sources`, and puts
 * the event id in the message's trailing `[id]` so a host can offer "ignore this change" from a marker.
 */
export function impactToDiagnostics(
	findings: ReadonlyArray<Pick<ImpactFinding, "event" | "direction" | "line" | "start" | "end" | "message">>,
	options: ImpactDiagnosticsOptions,
): Array<Diagnostic> {
	const out: Array<Diagnostic> = [];
	for (const f of findings) {
		const rule = impactRuleId(f);
		if (options.rules?.disable?.includes(rule)) continue;
		const severity = options.rules?.severity?.[rule] ?? RULE_SEVERITY.get(rule)!;
		out.push({
			rule, severity, message: `${f.message} [${f.event.id}]`, file: options.file,
			line: f.line, start: f.start, end: f.end, sources: f.event.sources,
		});
	}
	return out;
}

/** The event id `impactToDiagnostics` appended to a message, or `undefined` for any other diagnostic. */
export function impactEventId(diagnostic: Pick<Diagnostic, "rule" | "message">): string | undefined {
	if (!diagnostic.rule.startsWith("release/")) return undefined;
	const m = / \[(\S+)\]$/.exec(diagnostic.message);
	return m === null ? undefined : m[1];
}
