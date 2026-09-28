import { describe, expect, it } from "vitest";

import {
	commandDispatch, customCodeOfFile, customCodesOf, macroFileForCode, reachesMacroFile,
} from "../src/files/customCodes.js";
import { commandSpec } from "../src/dictionary/commands.js";
import { classifyFile } from "../src/files/kinds.js";
import { loadProject } from "../src/project.js";

describe("customCodeOfFile", () => {
	it("reads a G or M macro's code from its filename, in the form LexedCommand.code uses", () => {
		expect(customCodeOfFile("M1234.g")).toEqual({ letter: "M", number: 1234, fraction: null, code: "M1234", file: "M1234.g" });
		expect(customCodeOfFile("0:/sys/G38.9.g")).toEqual({ letter: "G", number: 38, fraction: 9, code: "G38.9", file: "G38.9.g" });
		expect(customCodeOfFile("sys/m600.1.G")?.code).toBe("M600.1"); // the SD card is FAT: case-insensitive
	});

	it("only counts a file directly in the system folder", () => {
		expect(customCodeOfFile("0:/macros/M1234.g")).toBeNull();
		expect(customCodeOfFile("0:/sys/sub/M1234.g")).toBeNull();
		expect(customCodeOfFile("0:/gcodes/M1234.g")).toBeNull();
	});

	it("rejects names RRF's TryMacroFile would never look for", () => {
		expect(customCodeOfFile("T5.g")).toBeNull(); // TryMacroFile is never reached for a T command
		expect(customCodeOfFile("M05.g")).toBeNull(); // printed with %d, so no leading zero
		expect(customCodeOfFile("M10000.g")).toBeNull(); // code < 10000
		expect(customCodeOfFile("M5.0.g")).toBeNull(); // a zero fraction prints as plain M5.g
		expect(customCodeOfFile("M5.12.g")).toBeNull(); // RRF reads one fractional digit
		expect(customCodeOfFile("M1234.gcode")).toBeNull();
		expect(customCodeOfFile("config.g")).toBeNull();
	});
});

describe("customCodesOf", () => {
	it("collects the codes a folder listing defines and ignores everything else", () => {
		const codes = customCodesOf(["config.g", "M1234.g", "G38.9.g", "0:/sys/M600.1.g", "0:/macros/M99.g", "homex.g", "T1.g"]);
		expect([...codes].sort()).toEqual(["G38.9", "M1234", "M600.1"]);
	});
});

describe("macroFileForCode", () => {
	it("prints the name the way TryMacroFile does", () => {
		expect(macroFileForCode("M1234")).toBe("M1234.g");
		expect(macroFileForCode("g38.9")).toBe("G38.9.g");
		expect(macroFileForCode("T0")).toBeNull();
		expect(macroFileForCode("M10000")).toBeNull();
	});
});

describe("reachesMacroFile", () => {
	it("is true for a code RRF has no case for", () => {
		expect(reachesMacroFile("M1234")).toBe(true);
		expect(reachesMacroFile("G9999")).toBe(true);
	});

	it("is false for a code RRF implements - a sys/M104.g is never run", () => {
		expect(reachesMacroFile("M104")).toBe(false);
		expect(reachesMacroFile("G1")).toBe(false);
	});

	it("is true for a known code the dictionary marks unimplemented", () => {
		expect(commandSpec("M301")?.unimplemented).toBe(true);
		expect(reachesMacroFile("M301")).toBe(true);
		expect(reachesMacroFile("M900")).toBe(true);
	});

	it("sends a fractional form to a macro unless RRF handles fractions of that number itself", () => {
		expect(reachesMacroFile("G1.1")).toBe(true);
		expect(reachesMacroFile("M104.1")).toBe(true);
		expect(reachesMacroFile("G38.2")).toBe(false);
		expect(reachesMacroFile("G59.3")).toBe(false);
		expect(reachesMacroFile("M569.9")).toBe(false);
		expect(reachesMacroFile("M586.5")).toBe(false);
	});

	it("treats M558's fractions 5 and up as macro codes, and 1-4 as its own", () => {
		expect(reachesMacroFile("M558.4")).toBe(false);
		expect(reachesMacroFile("M558.5")).toBe(true);
	});

	it("is never true for a T code or something that isn't a G/M code", () => {
		expect(reachesMacroFile("T1")).toBe(false);
		expect(reachesMacroFile("nonsense")).toBe(false);
	});
});

describe("commandDispatch", () => {
	it("a built-in code is builtin even if a same-named file exists", () => {
		const d = commandDispatch("M104", new Set(["M104"]));
		expect(d.kind).toBe("builtin");
	});
	it("an unknown code with its macro present is a custom macro, present", () => {
		expect(commandDispatch("M1234", ["M1234"])).toEqual({ kind: "custom-macro", file: "M1234.g", present: true });
	});
	it("an unknown code with no macro is a custom macro, absent - and unknown when nothing was listed", () => {
		expect(commandDispatch("M1234", new Set())).toEqual({ kind: "custom-macro", file: "M1234.g", present: false });
		expect(commandDispatch("m1234")).toEqual({ kind: "custom-macro", file: "M1234.g", present: undefined });
	});
	it("an exempt fractional form nobody implements is neither", () => {
		expect(commandDispatch("M569.11").kind).toBe("unknown");
	});
});

describe("the project model sees user-defined codes", () => {
	const files = [
		{ path: "0:/sys/config.g", text: "M1234 A1 B2\nM104 S200\nG38.9 X1\n" },
		{ path: "0:/sys/M1234.g", text: "echo {param.A}\n" },
		{ path: "0:/sys/M104.g", text: "; never run: RRF implements M104\n" },
	];

	it("lists the codes its /sys folder defines", () => {
		expect([...loadProject(files).customCodes].sort()).toEqual(["M104", "M1234"]);
	});

	it("records a call to the macro for a user-defined code, and none for a built-in", () => {
		const calls = loadProject(files).calls;
		expect(calls).toEqual([
			{ from: { file: "0:/sys/config.g", line: 0 }, to: "sys/m1234.g", resolved: true, dynamic: false, via: "custom-code" },
		]);
	});

	it("does not invent an unresolved call for a code with no macro (M1235 above), nor for a fraction RRF handles itself (G38.9)", () => {
		const calls = loadProject(files).calls;
		expect(calls.some((c) => c.to.includes("m1235"))).toBe(false);
		expect(calls.some((c) => c.to.includes("g38"))).toBe(false);
	});
});

describe("classifyFile", () => {
	it("no longer calls a T<n>.g file a custom code", () => {
		expect(classifyFile("0:/sys/T5.g").kind).toBe("user-macro");
		expect(classifyFile("0:/sys/M1234.g")).toEqual({ kind: "system-macro", syntax: "gcode", role: "custom-code" });
	});
});
