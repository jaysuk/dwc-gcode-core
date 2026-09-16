import { describe, expect, it } from "vitest";

import { formatStampLine, readStamp, recheckReasons, stampable, StampNotAllowedError, writeStamp } from "../src/stamp.js";

const STAMP = { rrf: "3.7.0-rc.1", pluginId: "GCodePostProcessor", pluginVersion: "1.2.1", at: "2026-09-14T10:00:00Z" };

describe("stampable", () => {
	it("is true for gcode/menu-syntax kinds, false for csv/text/binary/other", () => {
		for (const kind of ["config", "config-override", "system-macro", "user-macro", "filament-config", "filament-load", "filament-unload", "print-file", "menu"] as const) {
			expect(stampable(kind), kind).toBe(true);
		}
		for (const kind of ["height-map", "probe-points", "event-log", "accelerometer-data", "other", "out-of-scope", "menu-image"] as const) {
			expect(stampable(kind), kind).toBe(false);
		}
	});
});

describe("formatStampLine", () => {
	it("produces exactly the line writeStamp would insert - a streaming writer that can't hold a whole file in memory needs just this line, not a whole-document rewrite", () => {
		const viaWriteStamp = writeStamp("G90\n", STAMP, "config").split("\n")[0];
		expect(formatStampLine(STAMP)).toBe(viaWriteStamp);
	});

	it("readStamp accepts a line built this way exactly as it would one from writeStamp", () => {
		const line = formatStampLine(STAMP);
		const text = `${line}\nG90\nG1 X10\n`;
		expect(readStamp(text)).toMatchObject({ rrf: STAMP.rrf, pluginId: STAMP.pluginId, pluginVersion: STAMP.pluginVersion, at: STAMP.at });
	});
});

describe("writeStamp / readStamp round trip", () => {
	it("round-trips on every stampable kind", () => {
		for (const kind of ["config", "config-override", "system-macro", "user-macro", "filament-config", "filament-load", "filament-unload", "print-file", "menu"] as const) {
			const text = writeStamp("G90\nG1 X10\n", STAMP, kind);
			expect(readStamp(text), kind).toMatchObject({ rrf: STAMP.rrf, pluginId: STAMP.pluginId, pluginVersion: STAMP.pluginVersion, at: STAMP.at });
		}
	});

	it("matches the format's own worked example exactly for plain values (no unnecessary encoding)", () => {
		const text = writeStamp("G90\n", STAMP, "config");
		expect(text).toMatch(/^; dwc-gcode-core: checked rrf=3\.7\.0-rc\.1 plugin=GCodePostProcessor@1\.2\.1 core=\S+ at=2026-09-14T10:00:00Z\n/);
	});

	it("replaces an existing stamp in place rather than accumulating", () => {
		const first = writeStamp("G90\n", STAMP, "config");
		const second = writeStamp(first, { ...STAMP, pluginVersion: "1.3.0" }, "config");
		expect(second.split("\n").filter((l) => l.includes("dwc-gcode-core: checked"))).toHaveLength(1);
		expect(readStamp(second)?.pluginVersion).toBe("1.3.0");
	});

	it("preserves a UTF-8 BOM", () => {
		const text = writeStamp("﻿G90\n", STAMP, "config");
		expect(text.charCodeAt(0)).toBe(0xfeff);
		expect(readStamp(text)).not.toBeNull();
	});

	it("preserves CRLF line endings", () => {
		const text = writeStamp("G90\r\nG1 X10\r\n", STAMP, "config");
		expect(text).toContain("\r\n");
		expect(text.split("\r\n")[0]).toContain("dwc-gcode-core: checked");
	});

	it("percent-encodes a plugin id containing a space (DWC allows this - checkManifest)", () => {
		const text = writeStamp("G90\n", { ...STAMP, pluginId: "My Plugin" }, "config");
		expect(text).toContain("plugin=My%20Plugin@");
		expect(readStamp(text)?.pluginId).toBe("My Plugin");
	});

	it("round-trips a value containing a literal '%'", () => {
		const text = writeStamp("G90\n", { ...STAMP, pluginVersion: "1.0.0%beta" }, "config");
		expect(readStamp(text)?.pluginVersion).toBe("1.0.0%beta");
	});

	it("coexists with the post-processor's own 'postprocessed-by' stamp, in either write order", () => {
		const postprocessed = '; postprocessed-by: GCodePostProcessor v1.0.0 recipe="x" hash=abc at=2026-01-01T00:00:00Z\nG90\n';
		const withOurStamp = writeStamp(postprocessed, STAMP, "print-file");
		const lines = withOurStamp.split("\n");
		expect(lines[0]).toContain("postprocessed-by");
		expect(lines[1]).toContain("dwc-gcode-core: checked");
		expect(readStamp(withOurStamp)).not.toBeNull();

		// Writing our stamp again (e.g. a later re-check) still finds and replaces just our own line.
		const rewritten = writeStamp(withOurStamp, { ...STAMP, pluginVersion: "2.0.0" }, "print-file");
		const rewrittenLines = rewritten.split("\n");
		expect(rewrittenLines[0]).toContain("postprocessed-by");
		expect(rewrittenLines[1]).toContain("2.0.0");
		expect(rewrittenLines.filter((l) => l.includes("dwc-gcode-core: checked"))).toHaveLength(1);
	});

	it("throws StampNotAllowedError for a kind that must never be stamped", () => {
		expect(() => writeStamp("HeightMap...\n", STAMP, "height-map")).toThrow(StampNotAllowedError);
		expect(() => writeStamp("x\n", STAMP, "probe-points")).toThrow(StampNotAllowedError);
	});

	it("returns null for a file with no stamp", () => {
		expect(readStamp("G90\nG1 X10\n")).toBeNull();
	});

	it("returns null for a stamp missing a required field", () => {
		expect(readStamp("; dwc-gcode-core: checked rrf=3.7.0-rc.1 plugin=P@1\n")).toBeNull();
	});
});

describe("recheckReasons", () => {
	it("reports 'unstamped' for a null stamp", () => {
		expect(recheckReasons(null, { rrf: "3.7.0-rc.1", pluginId: "P", pluginVersion: "1" })).toEqual([{ kind: "unstamped" }]);
	});

	it("reports firmware-upgraded and firmware-downgraded correctly", () => {
		const text = writeStamp("G90\n", { ...STAMP, rrf: "3.6.3" }, "config");
		const stamp = readStamp(text)!;
		expect(recheckReasons(stamp, { rrf: "3.7.0-rc.1", pluginId: STAMP.pluginId, pluginVersion: STAMP.pluginVersion }))
			.toEqual([{ kind: "firmware-upgraded", from: "3.6.3", to: "3.7.0-rc.1" }]);
		expect(recheckReasons(readStamp(writeStamp("G90\n", { ...STAMP, rrf: "3.7.0-rc.1" }, "config"))!, { rrf: "3.6.3", pluginId: STAMP.pluginId, pluginVersion: STAMP.pluginVersion }))
			.toEqual([{ kind: "firmware-downgraded", from: "3.7.0-rc.1", to: "3.6.3" }]);
	});

	it("reports plugin-changed only when the SAME plugin id has a different version", () => {
		const stamp = readStamp(writeStamp("G90\n", STAMP, "config"))!;
		expect(recheckReasons(stamp, { rrf: STAMP.rrf, pluginId: STAMP.pluginId, pluginVersion: "9.9.9" }))
			.toEqual([{ kind: "plugin-changed", pluginId: STAMP.pluginId, from: STAMP.pluginVersion, to: "9.9.9" }]);
	});

	it("does NOT report plugin-changed when a different plugin id stamped the file (the user's own decision)", () => {
		const stamp = readStamp(writeStamp("G90\n", STAMP, "config"))!;
		expect(recheckReasons(stamp, { rrf: STAMP.rrf, pluginId: "SomeOtherPlugin", pluginVersion: "1.0.0" })).toEqual([]);
	});

	it("reports core-changed when the stamped core version differs from the running one", () => {
		const stamp = readStamp(writeStamp("G90\n", STAMP, "config"))!;
		const bumped = { ...stamp, core: "0.0.1" };
		expect(recheckReasons(bumped, { rrf: STAMP.rrf, pluginId: STAMP.pluginId, pluginVersion: STAMP.pluginVersion }))
			.toEqual([{ kind: "core-changed", from: "0.0.1", to: stamp.core }]);
	});

	it("reports nothing when everything matches", () => {
		const stamp = readStamp(writeStamp("G90\n", STAMP, "config"))!;
		expect(recheckReasons(stamp, { rrf: STAMP.rrf, pluginId: STAMP.pluginId, pluginVersion: STAMP.pluginVersion })).toEqual([]);
	});
});
