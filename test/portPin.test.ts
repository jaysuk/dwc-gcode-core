import { describe, expect, it } from "vitest";

import { parsePortPin } from "../src/pins/portPin.js";

describe("parsePortPin", () => {
	it("accepts all six of the user-reported forms for the same pin (A, port 0, pin 1)", () => {
		for (const text of ["PA1", "PA_1", "PA.1", "A1", "A_1", "A.1"]) {
			expect(parsePortPin(text), text).toEqual({ port: 0, pin: 1 });
		}
	});

	it("is case-insensitive on both the P prefix and the port letter", () => {
		expect(parsePortPin("pa1")).toEqual({ port: 0, pin: 1 });
		expect(parsePortPin("pA1")).toEqual({ port: 0, pin: 1 });
	});

	it("supports every port letter A-I (0-8)", () => {
		expect(parsePortPin("A0")).toEqual({ port: 0, pin: 0 });
		expect(parsePortPin("I0")).toEqual({ port: 8, pin: 0 });
	});

	it("rejects a port letter past I", () => {
		expect(parsePortPin("J0")).toBeNull();
		expect(parsePortPin("Z1")).toBeNull();
	});

	it("supports a two-digit pin number", () => {
		expect(parsePortPin("A15")).toEqual({ port: 0, pin: 15 });
	});

	it("rejects a pin number of 16 or more (RRF's own pin < 16 bound)", () => {
		expect(parsePortPin("A16")).toBeNull();
		expect(parsePortPin("A99")).toBeNull();
	});

	it("rejects text too short or too long to be this syntax", () => {
		expect(parsePortPin("A")).toBeNull();
		expect(parsePortPin("PA")).toBeNull();
		expect(parsePortPin("PA.123")).toBeNull();
	});

	it("rejects a non-letter first character", () => {
		expect(parsePortPin("1.1")).toBeNull();
	});

	it("rejects a named alias, which this function is never meant to resolve", () => {
		expect(parsePortPin("bedtemp")).toBeNull();
	});

	it("rejects a separator with nothing after it", () => {
		expect(parsePortPin("A.")).toBeNull();
	});
});
