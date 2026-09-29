/**
 * What a `value`/`alter` item's `N<code>` means - the legacy "value index" table at the top of RRF's
 * `Display/Menu.cpp` and `ValueMenuItem::Draw` (`3.7.0-rc.2`). `N` is `100 * group + item`:
 *
 * | N        | Shows                                                     | Unit / type      |
 * |----------|-----------------------------------------------------------|------------------|
 * | 0-99     | heater/tool current temperature (`N80`-`N99`: bed etc.)   | float            |
 * | 100-199  | active temperature                                        | float            |
 * | 200-299  | standby temperature                                       | float            |
 * | 300-399  | fan speed (`N399` = the print-cooling fan) - percent      | float, `%`       |
 * | 400-499  | extrusion factor - percent                                | float, `%`       |
 * | 500      | speed factor - percent                                    | float, `%`       |
 * | 501      | the latest `M117` message                                 | text             |
 * | 510-515  | axis position X Y Z U V W                                 | float            |
 * | 520      | selected tool number                                      | integer          |
 * | 521      | Z baby-step offset                                        | float            |
 * | 530-533  | IP address octet 1-4                                      | unsigned integer |
 * | 534      | IP address                                                | text             |
 * | 535      | percentage of the file processed                          | float, `%`       |
 * | 536, 537 | time left (file-based, filament-based)                    | `h:mm:ss`        |
 * | 538, 539 | requested / top speed                                     | float            |
 *
 * Anything else shows `***`. RRF treats groups 0-2 (temperatures), 3 (fans), 4 (extruders) and 5 (misc) as
 * above, so an `N` of `600` or above, or an unassigned misc item, is an error the display shows in place of
 * a value.
 */

export type MenuValueType = "float" | "int" | "uint" | "text" | "duration";

export interface MenuValueCode {
	type: MenuValueType;
	/** Shown with a trailing `%` (`asPercent` in `ValueMenuItem::Draw`). */
	percent: boolean;
	/** Whether an `alter` item can meaningfully change it (heater targets, fans, extruder/speed factors, tool, axis jog, baby-step). */
	adjustable: boolean;
}

const MISC: Record<number, MenuValueCode> = {
	0: { type: "float", percent: true, adjustable: true },
	1: { type: "text", percent: false, adjustable: false },
	10: { type: "float", percent: false, adjustable: true },
	11: { type: "float", percent: false, adjustable: true },
	12: { type: "float", percent: false, adjustable: true },
	13: { type: "float", percent: false, adjustable: true },
	14: { type: "float", percent: false, adjustable: true },
	15: { type: "float", percent: false, adjustable: true },
	20: { type: "int", percent: false, adjustable: true },
	21: { type: "float", percent: false, adjustable: true },
	30: { type: "uint", percent: false, adjustable: false },
	31: { type: "uint", percent: false, adjustable: false },
	32: { type: "uint", percent: false, adjustable: false },
	33: { type: "uint", percent: false, adjustable: false },
	34: { type: "text", percent: false, adjustable: false },
	35: { type: "float", percent: true, adjustable: false },
	36: { type: "duration", percent: false, adjustable: false },
	37: { type: "duration", percent: false, adjustable: false },
	38: { type: "float", percent: false, adjustable: false },
	39: { type: "float", percent: false, adjustable: false },
};

/** Describe a legacy `N` value code, or `null` when RRF would show `***` for it. */
export function classifyMenuValueCode(code: number): MenuValueCode | null {
	const group = Math.floor(code / 100);
	switch (group) {
		case 0:
			return { type: "float", percent: false, adjustable: false };
		case 1:
		case 2:
			return { type: "float", percent: false, adjustable: true };
		case 3:
		case 4:
			return { type: "float", percent: true, adjustable: true };
		case 5:
			return MISC[code % 100] ?? null;
		default:
			return null;
	}
}

/** `printf("%.*f", decimals, value)`. (JavaScript rounds an exact decimal tie up, C to even; ties are rare.) */
export function formatFixed(value: number, decimals: number): string {
	return value.toFixed(Math.min(Math.max(decimals, 0), 100));
}

/** ExpressionValue `Duration`: seconds as `h:mm:ss` (`ObjectModel.cpp` `AppendAsString`). */
export function formatDuration(totalSeconds: number): string {
	const s = Math.max(0, Math.trunc(totalSeconds));
	const hours = Math.floor(s / 3600);
	const minutes = Math.floor(s / 60) % 60;
	const seconds = s % 60;
	return `${hours}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
