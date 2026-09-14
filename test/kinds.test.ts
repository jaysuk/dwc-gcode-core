import { describe, expect, it } from "vitest";

import { classifyFile } from "../src/files/kinds.js";

// Every row of docs/file-kinds.md, both as a bare filename and as a full 0:/-rooted path - the
// classifier must handle both forms the same way (see its own module doc comment).
describe("classifyFile — every row of docs/file-kinds.md", () => {
	const CASES: ReadonlyArray<[path: string, expected: { kind: string; syntax: string; role?: string }]> = [
		["config.g", { kind: "config", syntax: "gcode" }],
		["config.g.bak", { kind: "config", syntax: "gcode" }],
		["config-override.g", { kind: "config-override", syntax: "gcode" }],
		["bed.g", { kind: "system-macro", syntax: "gcode", role: "bed" }],
		["mesh.g", { kind: "system-macro", syntax: "gcode", role: "mesh" }],
		["pause.g", { kind: "system-macro", syntax: "gcode", role: "pause" }],
		["resume.g", { kind: "system-macro", syntax: "gcode", role: "resume" }],
		["cancel.g", { kind: "system-macro", syntax: "gcode", role: "cancel" }],
		["start.g", { kind: "system-macro", syntax: "gcode", role: "start" }],
		["stop.g", { kind: "system-macro", syntax: "gcode", role: "stop" }],
		["daemon.g", { kind: "system-macro", syntax: "gcode", role: "daemon" }],
		["runonce.g", { kind: "system-macro", syntax: "gcode", role: "runonce" }],
		["resurrect.g", { kind: "system-macro", syntax: "gcode", role: "resurrect" }],
		["resurrect-prologue.g", { kind: "system-macro", syntax: "gcode", role: "resurrect-prologue" }],
		["filament-change.g", { kind: "system-macro", syntax: "gcode", role: "filament-change" }],
		["filament-error.g", { kind: "system-macro", syntax: "gcode", role: "filament-error" }],
		["homeall.g", { kind: "system-macro", syntax: "gcode", role: "homeall" }],
		["homex.g", { kind: "system-macro", syntax: "gcode", role: "home" }],
		["homeu.g", { kind: "system-macro", syntax: "gcode", role: "home" }],
		["home'a.g", { kind: "system-macro", syntax: "gcode", role: "home" }],
		["deployprobe.g", { kind: "system-macro", syntax: "gcode", role: "deployprobe" }],
		["deployprobe1.g", { kind: "system-macro", syntax: "gcode", role: "deployprobe" }],
		["retractprobe.g", { kind: "system-macro", syntax: "gcode", role: "retractprobe" }],
		["retractprobe2.g", { kind: "system-macro", syntax: "gcode", role: "retractprobe" }],
		["tfree.g", { kind: "system-macro", syntax: "gcode", role: "tfree" }],
		["tfree0.g", { kind: "system-macro", syntax: "gcode", role: "tfree" }],
		["tpre1.g", { kind: "system-macro", syntax: "gcode", role: "tpre" }],
		["tpost1.g", { kind: "system-macro", syntax: "gcode", role: "tpost" }],
		["trigger0.g", { kind: "system-macro", syntax: "gcode", role: "trigger" }],
		["G27.g", { kind: "system-macro", syntax: "gcode", role: "custom-code" }],
		["M577.g", { kind: "system-macro", syntax: "gcode", role: "custom-code" }],
		["G38.2.g", { kind: "system-macro", syntax: "gcode", role: "custom-code" }],
		["heightmap.csv", { kind: "height-map", syntax: "csv" }],
		["probePoints.csv", { kind: "probe-points", syntax: "csv" }],
		["eventlog.txt", { kind: "event-log", syntax: "text" }],
	];

	for (const [path, expected] of CASES) {
		it(`bare "${path}"`, () => {
			expect(classifyFile(path)).toEqual(expected);
		});
		it(`full path "0:/sys/${path}"`, () => {
			expect(classifyFile(`0:/sys/${path}`)).toEqual(expected);
		});
	}

	it("accelerometer capture files", () => {
		expect(classifyFile("0:/sys/accelerometer/121_2026-09-14_10.30.00.csv"))
			.toEqual({ kind: "accelerometer-data", syntax: "csv" });
	});

	it("print files under 0:/gcodes/, any extension or subfolder", () => {
		expect(classifyFile("0:/gcodes/benchy.gcode")).toEqual({ kind: "print-file", syntax: "gcode" });
		expect(classifyFile("0:/gcodes/subdir/part.g")).toEqual({ kind: "print-file", syntax: "gcode" });
	});

	it("user macros under 0:/macros/, including nested folders", () => {
		expect(classifyFile("0:/macros/Prime Line.g")).toEqual({ kind: "user-macro", syntax: "gcode" });
		expect(classifyFile("0:/macros/Bed/Level Corners.g")).toEqual({ kind: "user-macro", syntax: "gcode" });
	});

	it("filament config/load/unload - ONLY under filaments/<name>/, not /sys", () => {
		expect(classifyFile("0:/filaments/PLA/config.g")).toEqual({ kind: "filament-config", syntax: "gcode" });
		expect(classifyFile("0:/filaments/PLA/load.g")).toEqual({ kind: "filament-load", syntax: "gcode" });
		expect(classifyFile("0:/filaments/PLA/unload.g")).toEqual({ kind: "filament-unload", syntax: "gcode" });
		// The SAME filenames directly under /sys are NOT filament files - config.g is THE config file,
		// and load.g/unload.g (with no filaments/<name>/ prefix) aren't referenced anywhere in RRF
		// (see docs/file-kinds.md's correction) - they fall back to plain user-macro.
		expect(classifyFile("0:/sys/config.g").kind).toBe("config");
		expect(classifyFile("0:/sys/load.g").kind).toBe("user-macro");
	});

	it("menu files, classified by directory (they have no fixed extension)", () => {
		expect(classifyFile("0:/menu/main")).toEqual({ kind: "menu", syntax: "menu" });
		expect(classifyFile("0:/sys/menu/main")).toEqual({ kind: "menu", syntax: "menu" });
		expect(classifyFile("0:/menu/logo.img")).toEqual({ kind: "menu-image", syntax: "binary" });
	});

	it("out-of-scope: firmware and www", () => {
		expect(classifyFile("0:/firmware/Duet3Firmware.bin").kind).toBe("out-of-scope");
		expect(classifyFile("0:/www/index.html").kind).toBe("out-of-scope");
	});

	it("falls back to 'other' for an unrecognised file", () => {
		expect(classifyFile("0:/sys/notes.txt")).toEqual({ kind: "other", syntax: "text" });
		expect(classifyFile("0:/sys/data.json")).toEqual({ kind: "other", syntax: "text" });
	});

	it("is case-insensitive on filenames (FAT semantics)", () => {
		expect(classifyFile("CONFIG.G").kind).toBe("config");
		expect(classifyFile("HEIGHTMAP.CSV").kind).toBe("height-map");
	});

	it("tolerates a path with no volume prefix and/or no leading slash", () => {
		expect(classifyFile("sys/config.g").kind).toBe("config");
		expect(classifyFile("/sys/config.g").kind).toBe("config");
		expect(classifyFile("0:/sys/config.g").kind).toBe("config");
	});
});
