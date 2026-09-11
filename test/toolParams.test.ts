import { describe, expect, it } from "vitest";

import { TOOL_PARAM_COMMANDS } from "../src/commands/toolParams.js";

function entry(command: string) {
	return TOOL_PARAM_COMMANDS.find((c) => c.command === command);
}

describe("TOOL_PARAM_COMMANDS", () => {
	it("treats G10's P as a tool only in its tool-settings form", () => {
		const when = entry("G10")?.when;
		expect(when).toBeDefined();
		expect(when!("G10 P1 S200 R150")).toBe(true);
		expect(when!("G10 L1 P1 X10")).toBe(true);
		// P is a coordinate-system number here, and a bare G10 is a retraction
		expect(when!("G10 L2 P1 X0 Y0")).toBe(false);
		expect(when!("G10 L20 P2 Z0")).toBe(false);
		expect(when!("G10")).toBe(false);
	});

	it("never lists a command whose P is a fan or probe number", () => {
		for (const command of ["M106", "M107", "M585"]) {
			expect(entry(command)).toBeUndefined();
		}
	});

	it("keeps command names in tokenise()'s uppercase form", () => {
		for (const { command } of TOOL_PARAM_COMMANDS) {
			expect(command).toBe(command.toUpperCase());
		}
	});
});
