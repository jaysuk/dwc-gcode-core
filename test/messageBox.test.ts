import { describe, expect, it } from "vitest";

import { lexLine, type LexedCommand } from "../src/lex.js";
import { parseBlockingMessageBox } from "../src/messageBox.js";

function commandOf(raw: string): LexedCommand {
	const cmd = lexLine(raw).commands[0];
	if (cmd === undefined) throw new Error(`not a command line: ${raw}`);
	return cmd;
}

describe("parseBlockingMessageBox", () => {
	it("returns null for anything that isn't M291", () => {
		expect(parseBlockingMessageBox(commandOf('M117 P"hi"'))).toBeNull();
		expect(parseBlockingMessageBox(commandOf("G1 X1"))).toBeNull();
	});

	it("returns null for the non-blocking modes (S0/S1), including when S is omitted", () => {
		expect(parseBlockingMessageBox(commandOf('M291 P"hi" S0 T5'))).toBeNull();
		expect(parseBlockingMessageBox(commandOf('M291 P"hi" S1'))).toBeNull();
		expect(parseBlockingMessageBox(commandOf('M291 P"hi"'))).toBeNull(); // S omitted - RRF default is 1
	});

	it("returns null for the not-yet-supported choice mode (S4)", () => {
		expect(parseBlockingMessageBox(commandOf('M291 P"pick one" S4 K{"a","b"}'))).toBeNull();
	});

	it("parses S2 (OK only)", () => {
		const box = parseBlockingMessageBox(commandOf('M291 P"Ready?" R"Confirm" S2'));
		expect(box).toEqual({ prompt: { mode: "ok", message: "Ready?", title: "Confirm" }, cancelAborts: true });
	});

	it("parses S3 (OK/Cancel), defaulting cancelAborts to true when J is absent", () => {
		const box = parseBlockingMessageBox(commandOf('M291 P"Continue?" S3'));
		expect(box).toEqual({ prompt: { mode: "okCancel", message: "Continue?", title: null }, cancelAborts: true });
	});

	it("J2 makes cancelling NOT abort the macro", () => {
		const box = parseBlockingMessageBox(commandOf('M291 P"Continue?" S3 J2'));
		expect(box?.cancelAborts).toBe(false);
	});

	it("parses S5 (integer) with L/H/F limits", () => {
		const box = parseBlockingMessageBox(commandOf('M291 P"Enter a count" S5 L0 H10 F5'));
		expect(box).toEqual({
			prompt: { mode: "integer", message: "Enter a count", title: null, min: 0, max: 10, defaultValue: 5 },
			cancelAborts: true,
		});
	});

	it("parses S6 (float)", () => {
		const box = parseBlockingMessageBox(commandOf('M291 P"Enter a temperature" S6 L0 H300'));
		expect(box).toEqual({
			prompt: { mode: "float", message: "Enter a temperature", title: null, min: 0, max: 300, defaultValue: null },
			cancelAborts: true,
		});
	});

	it("parses S7 (string) with a quoted default", () => {
		const box = parseBlockingMessageBox(commandOf('M291 P"Enter a name" S7 F"default"'));
		expect(box).toEqual({
			prompt: { mode: "string", message: "Enter a name", title: null, minLength: null, maxLength: null, defaultValue: "default" },
			cancelAborts: true,
		});
	});

	it("unquotes an embedded '\"\"' escape in the message, same as any other quoted string", () => {
		const box = parseBlockingMessageBox(commandOf('M291 P"Say ""hi""" S2'));
		expect(box?.prompt.message).toBe('Say "hi"');
	});

	it("returns null when the message is an RRF expression rather than a literal string", () => {
		expect(parseBlockingMessageBox(commandOf("M291 P{var.msg} S2"))).toBeNull();
	});

	it("treats an expression-valued title the same as an absent one, without rejecting the whole box", () => {
		const box = parseBlockingMessageBox(commandOf('M291 P"hi" R{var.title} S2'));
		expect(box?.prompt.title).toBeNull();
	});
});
