import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { RELEASES, NEWEST_TRACKED_RELEASE, OLDEST_TRACKED_RELEASE, isTrackedRelease } from "../src/releases/releases.js";
import { CHANGES, changesBetween } from "../src/releases/changes.js";
import { impactOf, isDetectable, undetectableReason } from "../src/releases/impact.js";
import { buildImpactReport, isScannable, scanFile, scanImpact } from "../src/releases/scan.js";
import { impactEventId, impactRuleId, impactToDiagnostics } from "../src/releases/diagnostics.js";
import { parseDocument } from "../src/document.js";
import { compareFirmwareVersions } from "../src/versionCompare.js";
import { OBJECT_MODEL_VERSIONS } from "../src/objectmodel/versions.js";
import { RRF_BASELINE } from "../src/rrf.js";

const CONFIG = ["; config.g", "M408 S0", "M955 P2 C0", "echo move.motionSystems[0].currentTool", "G1 X10", ""].join("\n");
const MACRO = "if {a ^ b}\n  M118 P0 S\"x\"\nendif\n";

describe("RELEASES", () => {
	it("is in ascending version order, and starts and ends where the window does", () => {
		for (let i = 1; i < RELEASES.length; i++) {
			expect(compareFirmwareVersions(RELEASES[i - 1].version, RELEASES[i].version), RELEASES[i].version).toBeLessThan(0);
		}
		expect(OLDEST_TRACKED_RELEASE).toBe("3.6.3");
		expect(NEWEST_TRACKED_RELEASE).toBe(RRF_BASELINE);
	});

	it("every build-only entry names the tag it follows, and every tag has a date", () => {
		for (const r of RELEASES) {
			if (r.kind === "build") expect(RELEASES.find((t) => t.version === r.after)?.kind, r.version).toBe("tag");
			else expect(r.date, r.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		}
	});

	it("every object-model version is a tracked release", () => {
		for (const v of OBJECT_MODEL_VERSIONS) expect(isTrackedRelease(v.version), v.version).toBe(true);
	});

	it("every change event inside the window is pinned to a tracked release", () => {
		// Older events (3.01, 3.3 ... 3.6.0) predate the window and are not releases we track.
		for (const e of CHANGES) {
			if (compareFirmwareVersions(e.version, OLDEST_TRACKED_RELEASE) <= 0) continue;
			expect(isTrackedRelease(e.version), `${e.id} @ ${e.version}`).toBe(true);
		}
	});

	it("matches a board's own version string, suffix and all", () => {
		expect(isTrackedRelease("3.7.0-rc.2(CAN0)")).toBe(true);
		expect(isTrackedRelease("3.7.0-rc.1+2")).toBe(true);
		expect(isTrackedRelease("3.7.1")).toBe(false);
	});
});

describe("changesBetween: partition property", () => {
	// A change belongs to exactly one interval between consecutive releases, so any range is the union of its parts.
	const ids = (from: string, to: string): Array<string> => changesBetween(from, to).map((e) => e.id).sort();
	it("(a,c] is (a,b] plus (b,c] for every triple of tracked releases", () => {
		for (let i = 0; i < RELEASES.length; i++) {
			for (let j = i + 1; j < RELEASES.length; j++) {
				for (let k = j + 1; k < RELEASES.length; k++) {
					const [a, b, c] = [RELEASES[i].version, RELEASES[j].version, RELEASES[k].version];
					expect(ids(a, c), `${a} ${b} ${c}`).toEqual([...ids(a, b), ...ids(b, c)].sort());
				}
			}
		}
	}, 60_000);
});

describe("version strings", () => {
	it("accepts a board's (CAN0) suffix, a +N build and a version outside RELEASES", () => {
		const plain = changesBetween("3.6.3", "3.7.0-rc.2").map((e) => e.id);
		expect(changesBetween("3.6.3", "3.7.0-rc.2(CAN0)").map((e) => e.id)).toEqual(plain);
		expect(changesBetween("3.6.3(no 3rd order motion)", "3.7.0-rc.2").map((e) => e.id)).toEqual(plain);
		expect(changesBetween("3.7.0-rc.1", "3.7.0-rc.1+2").map((e) => e.id)).toEqual(changesBetween("3.7.0-rc.1", "3.7.0-rc.1+2(CAN0)").map((e) => e.id));
		expect(changesBetween("3.6.3", "3.7.1").map((e) => e.id)).toEqual(plain);
		expect(changesBetween("3.7.1", "3.6.3").map((e) => e.id).sort()).toEqual([...plain].sort());
	});

	it("scanImpact takes the same forms", () => {
		const files = [{ path: "0:/sys/config.g", text: CONFIG }];
		const a = scanImpact(files, "3.6.3", "3.7.0-rc.2");
		const b = scanImpact(files, "3.6.3", "3.7.0-rc.2(CAN0)");
		expect(b.totals).toEqual(a.totals);
		expect(a.totals.occurrences).toBeGreaterThan(0);
	});
});

describe("catalogue coverage", () => {
	const files = [{ path: "0:/sys/config.g", text: CONFIG }];
	it("says when the range leaves the tracked window on either side", () => {
		expect(scanImpact(files, "3.6.3", "3.7.0-rc.2").coverage).toEqual({ predatesCatalogue: false, beyondCatalogue: false });
		expect(scanImpact(files, "3.5.4", "3.7.0-rc.2").coverage).toEqual({ predatesCatalogue: true, beyondCatalogue: false });
		expect(scanImpact(files, "3.7.0-rc.2", "3.5.4").coverage.predatesCatalogue).toBe(true);
		expect(scanImpact(files, "3.6.3", "3.7.1").coverage).toEqual({ predatesCatalogue: false, beyondCatalogue: true });
		expect(scanImpact(files, "3.7.0-rc.2(CAN0)", "3.6.3").coverage).toEqual({ predatesCatalogue: false, beyondCatalogue: false });
	});
});

describe("event ids are a contract", () => {
	it("keeps every id a released core shipped (test/fixtures/event-ids.json)", () => {
		const snapshot = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/event-ids.json", import.meta.url)), "utf8")) as { ids: Array<string>; retired: Record<string, string> };
		const now = new Set(CHANGES.map((e) => e.id));
		// A persisted acknowledgement names one of these ids; losing or renaming one silently re-shows (or hides) a change.
		// An id may leave only by being RETIRED with a reason (a wrong fact, or a duplicate of another id); the reason is the audit trail.
		expect(snapshot.ids.filter((id) => !now.has(id) && snapshot.retired[id] === undefined)).toEqual([]);
	});

	it("a retired id is really gone, and says why", () => {
		const snapshot = JSON.parse(readFileSync(fileURLToPath(new URL("./fixtures/event-ids.json", import.meta.url)), "utf8")) as { ids: Array<string>; retired: Record<string, string> };
		const now = new Set(CHANGES.map((e) => e.id));
		for (const [id, why] of Object.entries(snapshot.retired)) {
			expect(snapshot.ids, id).toContain(id);
			expect(now.has(id), `${id} is retired but still an event`).toBe(false);
			expect(why.length, id).toBeGreaterThan(20);
		}
	});
});

describe("isDetectable", () => {
	it("agrees with what impactOf really matches", () => {
		expect(CHANGES.filter((e) => !isDetectable(e)).map((e) => e.id).sort()).toEqual([
			"axis-limit-absolute-moves-error", "comment-indent-insignificant", "expr-basic", "fileinfo-preflight-layer-count", "input-shaping-unshaped-move-start-gap", "lowercase-axis-letters", "meta-variables", "network-http-not-enabled-by-default", "planner-junction-extrusion-ratio-mb6hc",
		]);
		for (const e of CHANGES) expect(undetectableReason(e) === null, e.id).toBe(isDetectable(e));
	});

	it("exists(#x) and exists(x[0]) are recognised, exists(x) is not", () => {
		const hit = (src: string): boolean => impactOf(parseDocument(`echo {${src}}\n`), "3.7.0-alpha.2", "3.6.3").some((f) => f.event.id === "expr-exists-argument-forms");
		expect(hit("exists(#x)")).toBe(true);
		expect(hit("exists(x[0])")).toBe(true);
		expect(hit("exists(x)")).toBe(false);
		expect(hit("exists(global.y)")).toBe(false);
	});
});

describe("impactOf spans", () => {
	it("are absolute offsets into the text for every kind of target, on any line", () => {
		const text = ["; c", "M955 P2 C0", "  echo {move.motionSystems[0].currentTool}", "if {a ^ b}", "  M118 P0", "endif", "M408", ""].join("\n");
		const doc = parseDocument(text);
		const slice = (id: string): string => {
			const f = impactOf(doc, "3.6.3", "3.7.0-rc.2").find((x) => x.event.id === id)!;
			return text.slice(f.start, f.end);
		};
		expect(slice("m408-removed")).toBe("M408");
		expect(slice("m955-p-uncapped")).toBe("P2");
		expect(slice("om-move.motionSystems[].currentTool-added")).toBe("move.motionSystems[0].currentTool");
		expect(slice("expr-array-concat")).toBe("a ^ b");
	});
});

describe("isScannable", () => {
	it("scans config, macros and system macros, and skips everything else", () => {
		expect(isScannable("0:/sys/config.g")).toEqual({ scan: true });
		expect(isScannable("0:/macros/Heat/bed.g")).toEqual({ scan: true });
		expect(isScannable("0:/sys/bed.g")).toEqual({ scan: true });
		expect(isScannable("0:/gcodes/benchy.gcode")).toEqual({ scan: false, reason: "print-file" });
		expect(isScannable("0:/menu/main")).toMatchObject({ scan: false, reason: "not-gcode" });
		expect(isScannable("0:/sys/heightmap.csv")).toMatchObject({ scan: false, reason: "not-gcode" });
		expect(isScannable("0:/sys/board.txt")).toMatchObject({ scan: false, reason: "not-gcode" });
	});
});

describe("scanImpact", () => {
	const files = [
		{ path: "0:/sys/config.g", text: CONFIG },
		{ path: "0:/macros/mix.g", text: MACRO },
		{ path: "0:/gcodes/print.gcode", text: "M408 S0\n" },
		{ path: "0:/menu/main", text: "text T\"x\"\n" },
	];

	it("finds the changed lines, with file, 0-based line, offsets into the text and a snippet", () => {
		const report = scanImpact(files, "3.6.3", "3.7.0-rc.2");
		expect(report.direction).toBe("upgrade");
		const m408 = report.byEvent.find((g) => g.event.id === "m408-removed")!;
		expect(m408.occurrences).toHaveLength(1);
		const [o] = m408.occurrences;
		expect(o).toMatchObject({ path: "0:/sys/config.g", line: 1, snippet: "M408 S0" });
		expect(CONFIG.slice(o.start, o.end)).toBe("M408 S0");
		// The print file's M408 and the menu file are never looked at.
		expect(report.byFile.map((f) => f.path)).not.toContain("0:/gcodes/print.gcode");
		expect(report.skipped).toEqual([
			{ path: "0:/gcodes/print.gcode", reason: "print-file" },
			{ path: "0:/menu/main", reason: "not-gcode" },
		]);
		expect(report.totals.filesScanned).toBe(2);
		expect(report.totals.filesSkipped).toBe(2);
	});

	it("groups the same occurrences by event and by file, and the totals agree", () => {
		const report = scanImpact(files, "3.6.3", "3.7.0-rc.2");
		const perEvent = report.byEvent.reduce((n, g) => n + g.occurrences.length, 0);
		const perFile = report.byFile.reduce((n, f) => n + f.occurrences.length, 0);
		expect(perEvent).toBe(report.totals.occurrences);
		expect(perFile).toBe(report.totals.occurrences);
		expect(report.totals.filesAffected).toBe(report.byFile.length);
		expect(report.byFile.map((f) => f.path)).toEqual([...report.byFile.map((f) => f.path)].sort());
		for (const f of report.byFile) {
			const lines = f.occurrences.map((o) => o.line);
			expect(lines).toEqual([...lines].sort((a, b) => a - b));
		}
		const versions = report.byEvent.map((g) => g.event.version);
		for (let i = 1; i < versions.length; i++) expect(compareFirmwareVersions(versions[i - 1], versions[i])).toBeLessThanOrEqual(0);
	});

	it("moves acknowledged events to their own bucket instead of dropping them", () => {
		const all = scanImpact(files, "3.6.3", "3.7.0-rc.2");
		const some = scanImpact(files, "3.6.3", "3.7.0-rc.2", { acknowledged: new Set(["m408-removed"]) });
		expect(some.byEvent.map((g) => g.event.id)).not.toContain("m408-removed");
		expect(some.acknowledged.map((g) => g.event.id)).toEqual(["m408-removed"]);
		expect(some.totals.acknowledgedOccurrences).toBe(1);
		expect(some.totals.occurrences).toBe(all.totals.occurrences - 1);
		expect(some.byFile.flatMap((f) => f.occurrences).some((o) => o.event.id === "m408-removed")).toBe(false);
		// an array works as well as a set
		expect(scanImpact(files, "3.6.3", "3.7.0-rc.2", { acknowledged: ["m408-removed"] }).totals).toEqual(some.totals);
	});

	it("reverses on a downgrade", () => {
		const report = scanImpact([{ path: "0:/sys/config.g", text: CONFIG }, { path: "0:/macros/mix.g", text: MACRO }], "3.7.0-rc.2", "3.6.3");
		expect(report.direction).toBe("downgrade");
		expect(report.byEvent.every((g) => g.event.direction === "downgrade")).toBe(true);
		expect(report.byEvent.map((g) => g.event.id)).toContain("expr-array-concat");
	});

	it("says how many known changes it could not check, so an empty result is not read as all clear", () => {
		const report = scanImpact([{ path: "0:/sys/config.g", text: "G1 X10\n" }], "3.6.3", "3.7.0-rc.2");
		expect(report.totals.occurrences).toBe(0);
		expect(report.byEvent).toEqual([]);
		expect(report.totals.eventsInRange).toBeGreaterThan(50);
		expect(report.totals.eventsCheckable + report.totals.eventsUndetectable).toBe(report.totals.eventsInRange);
		expect(report.undetectable.map((e) => e.id)).toContain("fileinfo-preflight-layer-count");
		expect(report.totals.eventsUndetectable).toBe(report.undetectable.length);
	});

	it("is empty for an empty range", () => {
		const report = scanImpact(files, "3.7.0-rc.2", "3.7.0-rc.2");
		expect(report.totals).toMatchObject({ occurrences: 0, eventsInRange: 0, eventsUndetectable: 0 });
	});

	it("handles a BOM, CRLF and a very long line", () => {
		const text = `﻿M408 S0\r\n; ${"x".repeat(500)}\r\nM408 ${"y".repeat(400)}\r\n`;
		const report = scanImpact([{ path: "/sys/config.g", text }], "3.6.3", "3.7.0-rc.2");
		const occ = report.byEvent.find((g) => g.event.id === "m408-removed")!.occurrences;
		expect(occ.map((o) => o.line)).toEqual([0, 2]);
		expect(occ[0].snippet).toBe("M408 S0");
		expect(occ[1].snippet.length).toBeLessThanOrEqual(160);
		expect(occ[1].snippet.endsWith("…")).toBe(true);
	});

	it("scanFile returns null for a file it would not scan, and buildImpactReport matches scanImpact", () => {
		expect(scanFile({ path: "0:/gcodes/a.gcode", text: "M408\n" }, "3.6.3", "3.7.0-rc.2")).toBeNull();
		const scans = files.map((f) => scanFile(f, "3.6.3", "3.7.0-rc.2")).filter((s): s is NonNullable<typeof s> => s !== null);
		const skipped = files.flatMap((f) => {
			const v = isScannable(f.path);
			return v.scan ? [] : [{ path: f.path, reason: v.reason }];
		});
		expect(buildImpactReport(scans, skipped, "3.6.3", "3.7.0-rc.2")).toEqual(scanImpact(files, "3.6.3", "3.7.0-rc.2"));
	});
});

describe("impactToDiagnostics", () => {
	const findings = impactOf(parseDocument(`${CONFIG}${MACRO}`), "3.6.3", "3.7.0-rc.2");

	it("puts a removal at warning and a plain change at info", () => {
		const diags = impactToDiagnostics(findings, { file: "0:/sys/config.g" });
		expect(diags).toHaveLength(findings.length);
		const removed = diags.find((d) => d.message.endsWith("[m408-removed]"))!;
		expect(removed).toMatchObject({ rule: "release/removed", severity: "warning", file: "0:/sys/config.g", line: 1 });
		expect(removed.sources.length).toBeGreaterThan(0);
		const om = diags.find((d) => d.message.endsWith("[om-move.motionSystems[].currentTool-added]"));
		expect(om).toMatchObject({ rule: "release/changed", severity: "info" });
	});

	it("reads the same event the other way round on a downgrade", () => {
		const down = impactOf(parseDocument(MACRO), "3.7.0-rc.2", "3.6.3");
		const [d] = impactToDiagnostics(down.filter((f) => f.event.id === "expr-array-concat"), { file: "x.g" });
		expect(d.rule).toBe("release/removed"); // an added feature is not there in the older firmware
		expect(d.severity).toBe("warning");
	});

	it("reports a whenAbsent finding under its own rule so it can be switched off alone", () => {
		const absent = CHANGES.find((e) => e.target.type === "parameter" && e.target.whenAbsent !== undefined)!;
		expect(absent).toBeDefined();
		expect(impactRuleId({ event: absent, direction: "upgrade" })).toBe("release/default-changed");
		const f = { event: absent, direction: "upgrade" as const, line: 0, start: 0, end: 1, message: "m" };
		expect(impactToDiagnostics([f], { file: "a.g" })[0].severity).toBe("info");
		expect(impactToDiagnostics([f], { file: "a.g", rules: { disable: ["release/default-changed"] } })).toEqual([]);
		expect(impactToDiagnostics([f], { file: "a.g", rules: { severity: { "release/default-changed": "hint" } } })[0].severity).toBe("hint");
	});

	it("keeps the event id recoverable from the message", () => {
		const diags = impactToDiagnostics(findings, { file: "x.g" });
		for (const [i, d] of diags.entries()) expect(impactEventId(d)).toBe(findings[i].event.id);
		expect(impactEventId({ rule: "dictionary/unknown-parameter", message: "nope [x]" })).toBeUndefined();
	});
});
