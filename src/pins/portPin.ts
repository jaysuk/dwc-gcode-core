/**
 * The generic `PA1`/`PA_1`/`PA.1`/`A1`/`A_1`/`A.1` "port.pin" fallback syntax (task 17's Findings,
 * `docs/tasks/17-pin-names-and-validation.md`) - a fixed algorithm, not per-board data, so it's
 * implemented once here rather than generated. Faithfully ported from RRF's own
 * `BoardConfig::StringToPin` (`Duet3D fork of RepRapFirmware` gloomyandy/RepRapFirmware
 * `upstream/v3.7-dev:src/Hardware/TGBTC/BoardConfig.cpp:1052-1066`), whose own doc comment reads
 * verbatim: "Convert a pin string into a RRF Pin. Handle formats such as A.13, A_13, PA_13 or PA.13" -
 * confirming the user's own claimed forms exactly.
 */

export interface PortPin {
	/** 0 = A, 1 = B, ..., 8 = I (RRF's own `port <= 8` bound). */
	port: number;
	/** 0-15 (RRF's own `pin < 16` bound - a nibble, matching the packed `(port << 4) | pin` result). */
	pin: number;
}

/**
 * Parses the generic port.pin syntax; returns `null` for anything that doesn't fit, mirroring RRF's
 * own `NoPin` return rather than throwing. An optional leading `P`/`p` is skipped, the next character
 * must be a port letter `A`-`I`, an optional single `.` or `_` separator is skipped, and the rest must
 * be a decimal pin number `0`-`15`.
 *
 * One deliberate simplification versus the real C++: `StrToI32` there stops at the first non-digit
 * and still succeeds if at least one digit was consumed (so C++ `StringToPin("A1x")` would actually
 * accept `"A1"` and silently ignore the trailing `x`) - this port requires the ENTIRE remainder to be
 * digits instead. Real G-code parameter values reaching this function are already individually
 * tokenised (never embedded in a larger unparsed string), so trailing garbage like this can't arise
 * from valid G-code in practice; matching the leniency exactly would only widen what this function
 * accepts for no real benefit, so it isn't replicated (the same "not a precise re-implementation"
 * stance `src/diagnostics/rules.ts`'s `looksLikeKind` already documents for itself).
 */
export function parsePortPin(text: string): PortPin | null {
	let s = text;
	if (s.length > 0 && (s[0] === "P" || s[0] === "p")) s = s.slice(1);
	if (s.length < 2 || s.length > 4) return null;
	const port = s[0].toUpperCase().charCodeAt(0) - "A".charCodeAt(0);
	if (port < 0 || port > 8) return null;
	const rest = (s[1] === "." || s[1] === "_") ? s.slice(2) : s.slice(1);
	if (!/^\d+$/.test(rest)) return null;
	const pin = Number(rest);
	if (pin >= 16) return null;
	return { port, pin };
}
