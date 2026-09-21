import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { loadProject, type Project, type ProjectFile } from "../src/project.js";
import type { GcodeDocument } from "../src/document.js";
import type { MenuDocument } from "../src/files/menu.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "corpus", "projects");

function readTree(dir: string, root: string): Array<ProjectFile> {
	const files: Array<ProjectFile> = [];
	for (const name of readdirSync(dir)) {
		if (name === "README.md") continue;
		const full = join(dir, name);
		if (statSync(full).isDirectory()) {
			files.push(...readTree(full, root));
		} else {
			const rel = relative(root, full).replace(/\\/g, "/");
			files.push({ path: `0:/${rel}`, text: readFileSync(full, "utf-8") });
		}
	}
	return files;
}

function loadFixture(name: string): Project {
	const root = join(ROOT, name);
	return loadProject(readTree(root, root));
}

function symbol(project: Project, type: string, id: string) {
	return project.symbols.find((s) => s.type === type && s.id === id);
}

function call(project: Project, fromFile: string, via: string) {
	return project.calls.filter((c) => c.from.file.endsWith(fromFile) && c.via === via);
}

describe("loadProject: fff-basic fixture", () => {
	const project = loadFixture("fff-basic");

	it("classifies every file", () => {
		expect(project.files.size).toBeGreaterThan(0);
		expect(project.files.get("0:/sys/config.g")?.kind).toBe("config");
		expect(project.files.get("0:/gcodes/test.gcode")?.kind).toBe("print-file");
		expect(project.files.get("0:/filaments/PLA/load.g")?.kind).toBe("filament-load");
		expect(project.files.get("0:/menu/main")?.kind).toBe("menu");
	});

	it("parses gcode files as GcodeDocument and menu files as MenuDocument", () => {
		const configDoc = project.files.get("0:/sys/config.g")?.doc as GcodeDocument;
		expect(configDoc.lines.length).toBeGreaterThan(0);
		const menuDoc = project.files.get("0:/menu/main")?.doc as MenuDocument;
		expect(menuDoc.lines.length).toBeGreaterThanOrEqual(2); // plus a trailing blank line from the fixture's own final newline
	});

	describe("calls", () => {
		it("resolves bare G28 to homeall.g", () => {
			const c = call(project, "test.gcode", "G28-homeall");
			expect(c).toHaveLength(1);
			expect(c[0].to).toBe("sys/homeall.g");
			expect(c[0].resolved).toBe(true);
		});

		it("reports G28 Y as unresolved (homey.g doesn't exist in this fixture)", () => {
			const c = call(project, "test.gcode", "G28-home-axis");
			expect(c).toHaveLength(1);
			expect(c[0].to).toBe("sys/homey.g");
			expect(c[0].resolved).toBe(false);
		});

		it("resolves M701 S\"PLA\" to the filament's own load.g", () => {
			const c = call(project, "test.gcode", "M701");
			expect(c).toHaveLength(1);
			expect(c[0].to).toBe("filaments/pla/load.g");
			expect(c[0].resolved).toBe(true);
		});

		it("resolves T0's tfree to the numbered file (present)", () => {
			const c = call(project, "test.gcode", "T-tfree");
			expect(c).toHaveLength(1);
			expect(c[0].to).toBe("sys/tfree0.g");
			expect(c[0].resolved).toBe(true);
		});

		it("resolves T0's tpre to the BARE fallback (tpre0.g is absent, tpre.g exists) - via stays \"T-tpre\" (the route), only `to` reflects which candidate resolved", () => {
			const c = call(project, "test.gcode", "T-tpre");
			expect(c).toHaveLength(1);
			expect(c[0].to).toBe("sys/tpre.g");
			expect(c[0].resolved).toBe(true);
		});

		it("resolves T0's tpost to the numbered file (present)", () => {
			const c = call(project, "test.gcode", "T-tpost");
			expect(c).toHaveLength(1);
			expect(c[0].to).toBe("sys/tpost0.g");
			expect(c[0].resolved).toBe(true);
		});

		it("resolves G32 to bed.g", () => {
			const c = call(project, "test.gcode", "G32");
			expect(c[0].to).toBe("sys/bed.g");
			expect(c[0].resolved).toBe(true);
		});

		it("reports M98 P\"missing.g\" as unresolved", () => {
			const c = call(project, "test.gcode", "M98");
			expect(c).toHaveLength(1);
			expect(c[0].to).toBe("sys/missing.g");
			expect(c[0].resolved).toBe(false);
		});

		it("resolves M0 to the cancel/stop fallback chain (cancel.g absent, stop.g present)", () => {
			const c = call(project, "test.gcode", "M0-cancel");
			expect(c).toHaveLength(1);
			expect(c[0].to).toBe("sys/stop.g");
			expect(c[0].resolved).toBe(true);
		});

		it("reports a dynamic T{...} call with the raw expression as its target, not a guess", () => {
			const c = call(project, "toolpick.g", "T");
			// T{var.n} isn't matched by any named route in rawCallsFor's own switch (it only special-
			// cases numbered T commands) - this asserts the ABSENCE of a fabricated numbered-tool call
			// for it, which is the correct, honest behaviour for a target this module can't resolve.
			expect(c).toHaveLength(0);
		});

		it("records a conditional M98 call from inside toolpick.g's own if block", () => {
			const c = project.calls.filter((cl) => cl.from.file.endsWith("toolpick.g") && cl.via === "M98");
			expect(c).toHaveLength(1);
			expect(c[0].to).toBe("sys/tfree0.g");
		});
	});

	describe("symbols", () => {
		it("tool 0 has a definition (M563 P0) and uses (G10, T0)", () => {
			const tool0 = symbol(project, "tool", "0");
			expect(tool0?.definitions.length).toBe(1);
			expect(tool0!.definitions[0].file).toBe("0:/sys/config.g");
			const useFiles = tool0!.uses.map((u) => u.file);
			expect(useFiles).toContain("0:/sys/config.g"); // G10 P0
			expect(useFiles).toContain("0:/gcodes/test.gcode"); // T0
		});

		it("heater 0 is defined by M950 H0 and used by M143/M563's H list", () => {
			const heater0 = symbol(project, "heater", "0");
			expect(heater0?.definitions.length).toBe(1);
			expect(heater0!.uses.length).toBeGreaterThanOrEqual(1);
		});

		it("sensor 0 is defined by M308 S0", () => {
			expect(symbol(project, "sensor", "0")?.definitions.length).toBe(1);
		});

		it("fan 0 is defined by M950 F0 and used by both M106 P0 and M563's own F0 tool-fan mapping", () => {
			const fan0 = symbol(project, "fan", "0");
			expect(fan0?.definitions.length).toBe(1);
			expect(fan0?.uses.length).toBe(2);
		});

		it("probe 0 is defined by M558 K0 and used by G31 K0", () => {
			const probe0 = symbol(project, "probe", "0");
			expect(probe0?.definitions.length).toBe(1);
			expect(probe0?.uses.length).toBe(1);
		});

		it("axis X is defined by M584 and used by every axis-letter parameter elsewhere", () => {
			const axisX = symbol(project, "axis", "X");
			expect(axisX?.definitions.length).toBe(1);
			expect(axisX!.definitions[0].file).toBe("0:/sys/config.g");
			expect(axisX!.uses.length).toBeGreaterThan(0); // M574 X1's own X, plus homing-file G1 X moves
		});

		it("endstop X is defined by M574 X1 (a distinct symbol type from the axis itself)", () => {
			expect(symbol(project, "endstop", "X")?.definitions.length).toBe(1);
		});

		it("the spindle definition inside config.g's own if block is marked conditional", () => {
			const spindle0 = symbol(project, "spindle", "0");
			expect(spindle0?.definitions.length).toBe(1);
			expect(spindle0!.definitions[0].conditional).toBe(true);
		});

		it("global toolTemp is defined once and used both in the if-condition and in G10's expression", () => {
			const g = symbol(project, "global", "toolTemp");
			expect(g?.definitions.length).toBe(1);
			expect(g?.uses.length).toBe(2);
			expect(g!.uses.every((u) => u.file === "0:/sys/config.g")).toBe(true);
		});

		it("filament PLA is defined by its own directory and used by M701", () => {
			const pla = symbol(project, "filament", "PLA");
			expect(pla?.definitions.length).toBeGreaterThanOrEqual(1); // one per file kind under filaments/PLA/
			expect(pla?.uses.length).toBe(1);
			expect(pla!.uses[0].file).toBe("0:/gcodes/test.gcode");
		});
	});
});

describe("loadProject: M950's two gpout forms", () => {
	// RRF's Platform::ConfigurePort indexes ONE gpoutPorts array from either letter
	// (Platform.cpp:4123-4132) - S passes the servo flag, P doesn't, but port 0 is port 0 either way.
	it("M950 P<n> defines a gpout symbol, not just M950 S<n>", () => {
		const project = loadProject([{ path: "0:/sys/config.g", text: 'M950 P0 C"out2"\nM950 S1 C"out3"\n' }]);
		expect(symbol(project, "gpout", "0")?.definitions.length).toBe(1);
		expect(symbol(project, "gpout", "1")?.definitions.length).toBe(1);
	});

	it("two M950 P<n> lines for the same port are two definitions of one symbol (so duplicates are catchable)", () => {
		const project = loadProject([{ path: "0:/sys/config.g", text: 'M950 P0 C"out2"\nM950 P0 C"out9"\n' }]);
		expect(symbol(project, "gpout", "0")?.definitions.length).toBe(2);
	});
});

describe("loadProject: M308 S/Y and M950 H/C are conditional defines (task 17)", () => {
	// Heat::ConfigureSensor only (re)creates the sensor `if (gb.Seen('Y'))` - S alone (no Y) expects
	// the sensor to already exist, so it's a use, not a second definition.
	it("M308 S0 Y\"thermistor\" defines sensor 0; a later M308 S0 A\"bed\" (no Y) is a use, not a second define", () => {
		const project = loadProject([{ path: "0:/sys/config.g", text: 'M308 S0 Y"thermistor" A"bed"\nM308 S0 A"renamed"\n' }]);
		const sensor0 = symbol(project, "sensor", "0");
		expect(sensor0?.definitions.length).toBe(1);
		expect(sensor0?.uses.length).toBe(1);
	});

	it("M308 S0 with no Y anywhere in the project has no definition at all", () => {
		const project = loadProject([{ path: "0:/sys/config.g", text: 'M308 S0 A"bed"\n' }]);
		const sensor0 = symbol(project, "sensor", "0");
		expect(sensor0?.definitions.length ?? 0).toBe(0);
		expect(sensor0?.uses.length).toBe(1);
	});

	// Heat::ConfigureHeater only (re)creates the heater `if (gb.Seen('C'))` - same shape as M308's Y.
	it("M950 H0 C\"out0\" T0 defines heater 0; a later M950 H0 Q100 (no C) is a use", () => {
		const project = loadProject([{ path: "0:/sys/config.g", text: 'M950 H0 C"out0" T0\nM950 H0 Q100\n' }]);
		const heater0 = symbol(project, "heater", "0");
		expect(heater0?.definitions.length).toBe(1);
		expect(heater0?.uses.length).toBe(1);
	});

	it("M950 H0 with no C anywhere in the project has no definition at all", () => {
		const project = loadProject([{ path: "0:/sys/config.g", text: "M950 H0 Q100\n" }]);
		const heater0 = symbol(project, "heater", "0");
		expect(heater0?.definitions.length ?? 0).toBe(0);
		expect(heater0?.uses.length).toBe(1);
	});
});

describe("loadProject: pin symbols (task 17, Part B, Step 7)", () => {
	it("every reviewed kind:\"pin\" parameter site becomes a pin symbol, always role \"use\"", () => {
		const project = loadProject([{ path: "0:/sys/config.g", text: 'M950 H0 C"out0" T0\nM308 S0 P"e0temp" Y"thermistor"\n' }]);
		const out0 = symbol(project, "pin", "0.out0");
		expect(out0?.definitions.length ?? 0).toBe(0);
		expect(out0?.uses.length).toBe(1);
		expect(symbol(project, "pin", "0.e0temp")?.uses.length).toBe(1);
	});

	it("\"nil\" (freeing a pin) is never tracked as a symbol site at all", () => {
		const project = loadProject([{ path: "0:/sys/config.g", text: 'M950 H0 C"nil"\n' }]);
		expect(project.symbols.some((s) => s.type === "pin")).toBe(false);
	});

	it("without a boards map, two DIFFERENT aliases for the same physical pin are NOT merged (raw-string fallback, task 17 Decision 7)", () => {
		const project = loadProject([{ path: "0:/sys/config.g", text: 'M950 H0 C"lcdsck"\nM950 H1 C"sck"\n' }]);
		expect(symbol(project, "pin", "0.lcdsck")?.uses.length).toBe(1);
		expect(symbol(project, "pin", "0.sck")?.uses.length).toBe(1);
	});

	it("WITH a boards map, two different aliases for the same physical pin (rrfpins-txt's own lcdsck/sck case) resolve to one symbol - the real point of alias resolution", () => {
		const boards = new Map([[0, "btt/octopuspro1_1_h723"]]);
		const project = loadProject(
			[{ path: "0:/sys/config.g", text: 'M950 H0 C"lcdsck"\nM950 H1 C"sck"\n' }],
			{ boards },
		);
		const merged = symbol(project, "pin", "0.A.5");
		expect(merged?.uses.length).toBe(2);
	});

	it("the same base pin name on two different CAN-address-prefixed boards is NOT a conflict - different symbols", () => {
		const project = loadProject([{ path: "0:/sys/config.g", text: 'M950 H0 C"121.out0"\nM950 H1 C"122.out0"\n' }]);
		expect(symbol(project, "pin", "121.out0")?.uses.length).toBe(1);
		expect(symbol(project, "pin", "122.out0")?.uses.length).toBe(1);
	});

	it("strips leading !/^/* modifiers before comparing identity (IoPort::Allocate's own parsing)", () => {
		const project = loadProject([{ path: "0:/sys/config.g", text: 'M950 H0 C"!out0"\nM950 H1 C"out0"\n' }]);
		const out0 = symbol(project, "pin", "0.out0");
		expect(out0?.uses.length).toBe(2);
	});

	// A single kind:"pin" value can itself name MULTIPLE physical pins, "+"-joined - a real, pervasive
	// RRF convention (IoPort::AssignPort(s)), confirmed for M574 P (up to MaxDriversPerAxis),
	// M558 C (up to 2), M955 C (exactly 2), and M308 P for a DHT sensor (2) - not M574-specific.
	it("M574 P\"io2.in+io3.in\" tracks TWO separate pin symbols, not one compound one", () => {
		const project = loadProject([{ path: "0:/sys/config.g", text: 'M574 Y1 S1 P"io2.in+io3.in"\n' }]);
		expect(symbol(project, "pin", "0.io2.in")?.uses.length).toBe(1);
		expect(symbol(project, "pin", "0.io3.in")?.uses.length).toBe(1);
		expect(project.symbols.filter((s) => s.type === "pin")).toHaveLength(2);
	});

	it("a \"+\"-joined pin correctly conflicts with a later single-pin use of one of its segments", () => {
		const project = loadProject([{ path: "0:/sys/config.g", text: 'M574 Y1 S1 P"io2.in+io3.in"\nM558 K0 C"io3.in"\n' }]);
		expect(symbol(project, "pin", "0.io3.in")?.uses.length).toBe(2);
	});

	it("each \"+\"-segment gets its own modifier stripped and CAN-address prefix parsed independently", () => {
		const project = loadProject([{ path: "0:/sys/config.g", text: 'M574 Y1 S1 P"!io2.in+121.io3.in"\n' }]);
		expect(symbol(project, "pin", "0.io2.in")).toBeDefined();
		expect(symbol(project, "pin", "121.io3.in")).toBeDefined();
	});
});

describe("loadProject: cnc-basic fixture", () => {
	const project = loadFixture("cnc-basic");

	it("classifies config.g and the print file", () => {
		expect(project.files.get("0:/sys/config.g")?.kind).toBe("config");
		expect(project.files.get("0:/gcodes/test.gcode")?.kind).toBe("print-file");
	});

	it("resolves G28 to homeall.g", () => {
		expect(call(project, "test.gcode", "G28-homeall")[0]?.resolved).toBe(true);
	});

	it("defines a spindle (M950 R0) and uses it via M563 R0 (attaching it to tool 0)", () => {
		const spindle0 = symbol(project, "spindle", "0");
		expect(spindle0?.definitions.length).toBe(1);
		expect(spindle0?.uses.length).toBe(1);
	});

	it("defines a probe (M558 K0) and an endstop referencing it (M574 Z2 S3 K0)", () => {
		expect(symbol(project, "probe", "0")?.definitions.length).toBe(1);
		expect(symbol(project, "probe", "0")?.uses.length).toBe(1);
		expect(symbol(project, "endstop", "Z")?.definitions.length).toBe(1);
	});
});

describe("loadProject: laser-basic fixture", () => {
	const project = loadFixture("laser-basic");

	it("classifies config.g and the print file", () => {
		expect(project.files.get("0:/sys/config.g")?.kind).toBe("config");
		expect(project.files.get("0:/gcodes/test.gcode")?.kind).toBe("print-file");
	});

	it("resolves G28 to homeall.g", () => {
		expect(call(project, "test.gcode", "G28-homeall")[0]?.resolved).toBe(true);
	});

	it("defines axes X and Y via M584, with no heater/tool symbols at all (a laser needs neither)", () => {
		expect(symbol(project, "axis", "X")).toBeDefined();
		expect(symbol(project, "axis", "Y")).toBeDefined();
		expect(symbol(project, "heater", "0")).toBeUndefined();
		expect(symbol(project, "tool", "0")).toBeUndefined();
	});
});
