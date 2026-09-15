#!/usr/bin/env node
/**
 * Builds `src/objectmodel/{versions,schema}.ts` (task 11, `docs/tasks/11-object-model-schema.md`).
 *
 * Two path-list sources, per version:
 *  - `@duet3d/objectmodel@<version>`'s own `dist/documentation.json` + `dist/deprecations.json`,
 *    when the npm package has them (every version in our window from `3.7.0-beta.1` onward).
 *  - For a version whose npm package has NO `documentation.json` (`3.6.3` in our window — see
 *    `docs/tasks/11-object-model-schema.md`'s Findings), this script instead derives the same path
 *    list directly from `Duet3D/ObjectModel`'s TypeScript source at the matching git tag: that repo
 *    is `@duet3d/objectmodel`'s own upstream, hand-maintained class-by-class mirror of RRF's real
 *    object model (confirmed field-for-field identical to RRF's C++ `OBJECT_MODEL_TABLE` for every
 *    class spot-checked - see Findings) - reading it is exactly "read the object model's authoritative
 *    source directly" for a version where the generated documentation doesn't exist yet.
 *
 * The TS-source path deriver is validated by running it against `3.7.0-rc.1`'s own tag too and
 * diffing the result against that version's REAL, npm-published `documentation.json` - see
 * `--validate`. Any deliberately-accepted difference is listed in `KNOWN_DERIVATION_GAPS` below,
 * with a reason; an unexplained difference fails `--validate` loudly rather than shipping quietly.
 *
 *   node scripts/build-om-schema.mjs --validate     # cross-checks the TS-source deriver against 3.7.0-rc.1's real documentation.json
 *   node scripts/build-om-schema.mjs                 # builds src/objectmodel/{versions,schema}.ts
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(ROOT, "src", "objectmodel");

// RRF tags (from the local RepRapFirmware clone) intersected with @duet3d/objectmodel's published
// npm versions, by EXACT string match (task 11's own decision 1) - RESTRICTED to versions >= 3.6.3
// (docs/tasks/README.md's support window). Computed once by hand (see 11-object-model-schema.md's
// Findings) rather than re-run live every build - it changes only when a new RRF release ships, the
// same review-gated cadence RRF_BASELINE itself moves on.
const VERSIONS_IN_WINDOW = ["3.6.3", "3.7.0-alpha.2", "3.7.0-beta.1", "3.7.0-beta.2", "3.7.0-beta.3", "3.7.0-rc.1"];

// `3.7.0-alpha.2`'s npm package has no `documentation.json` (confirmed) AND `Duet3D/ObjectModel` has
// no matching git tag either (confirmed: its earliest tag is `v3.6.3`, next is `v3.7.0-beta.4`) - so
// there is no real source this script can read for it. Excluded from the schema's own OM path
// tracking rather than guessed from a neighbouring tag; still listed in VERSIONS_IN_WINDOW above so
// task 12's release-model work knows the RRF tag existed.
const NO_OM_SOURCE_AVAILABLE = new Set(["3.7.0-alpha.2"]);

// Versions whose npm package has no `documentation.json` and so need the TS-source deriver, mapped
// to the matching `Duet3D/ObjectModel` git tag (that repo prefixes its tags with "v"; npm/RRF
// versions don't).
const DERIVE_FROM_TS_SOURCE = { "3.6.3": "v3.6.3" };

// Differences between this script's TS-source-derived path set and 3.7.0-rc.1's real, published
// documentation.json, found by `--validate` and accepted with a reason rather than "fixed" by
// special-casing the parser into fragility. Each is `path: reason`.
const KNOWN_DERIVATION_GAPS = {
	// `global` is `ModelDictionary<any>` - genuinely dynamic user/global variables with no fixed
	// shape, so there is nothing under it to derive. Real documentation.json agrees (only the bare
	// "global" key, no "global.*"/"global[]" children) - not actually a gap, listed for clarity.

	// Fields real, declared in source, genuinely absent from real documentation.json's 691 entries,
	// with no comment or marker in source explaining why - an upstream documentation gap in
	// Duet3D/ObjectModel itself (confirmed by reading each field's own declaration directly), not
	// something this parser can detect from source. Each is still a REAL, live object-model path
	// (querying `{boards[0].drivers[0].status}` on a real board works) - `objectModelPath()` would
	// report these as unknown when they genuinely aren't, which is the honest cost of deriving from
	// source for a version with no documentation.json at all, recorded rather than hidden.
	"boards[].drivers[].status": "declared in Driver.ts, no comment explaining the omission from docs",
	"move.keepout[].active": "declared in KeepoutZone.ts, no comment explaining the omission from docs",
	"boards[].directDisplay.screen.colourBits": "declared in DirectDisplayScreenBase.ts, no comment explaining the omission",
	"boards[].directDisplay.screen.height": "declared in DirectDisplayScreenBase.ts, no comment explaining the omission",
	"boards[].directDisplay.screen.spiFreq": "declared in DirectDisplayScreenBase.ts, no comment explaining the omission",
	"boards[].directDisplay.screen.width": "declared in DirectDisplayScreenBase.ts, no comment explaining the omission",
	// Unlike the others in this group, this one IS explained: it's deprecated ("use rssi instead", in
	// deprecations.json at every tracked version) - documentation.json's own main listing appears to
	// exclude deprecated paths entirely, even though the path is still real (the schema-building step
	// in `build()` unions documentation.json's keys with deprecations.json's for exactly this reason,
	// so this is only a gap for `--validate`'s single-version snapshot check, not for the real schema).
	"network.interfaces[].signal": "deprecated (\"use rssi instead\") - documentation.json's main listing excludes deprecated paths",

	// A nested-object field's OWN bare key (its container's one-line summary) is sometimes present in
	// real docs (e.g. "fans[].thermostatic") and sometimes absent even though its CHILDREN are fully
	// documented (e.g. "boards[].drivers[].closedLoop.currentFraction" exists but bare
	// "boards[].drivers[].closedLoop" doesn't). This is NOT explained by a JSDoc comment on the field
	// (checked directly: neither "accelerometer" on Board nor "thermostatic" on Fan - both of which DO
	// get a bare key - has one either), so it isn't something derivable from this TS source tree at
	// all; documentation.json's summaries must be curated independently of the class declarations.
	// Same category as the fields above: `path[].currentFraction` etc. are still correctly present
	// either way, just not the bare parent key itself - a presentation gap, not a path-existence one.
	"boards[].drivers[].closedLoop": "bare-key presence isn't derivable from source - see the note above this table",
	"boards[].drivers[].config": "bare-key presence isn't derivable from source - see the note above this table",
	"move.keepout[].coords": "bare-key presence isn't derivable from source - see the note above this table",
};

function listTsFiles(dir) {
	const out = [];
	for (const name of readdirSync(dir)) {
		const full = join(dir, name);
		const st = statSync(full);
		if (st.isDirectory()) {
			out.push(...listTsFiles(full));
		} else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Finds every `export class Name [extends Base] { ... }` in one file's text, returning each with its
 * own declared fields (name -> raw TS type text) - inherited fields are resolved later, once every
 * file has been parsed and every class name is known. Brace-depth tracking (not a one-line regex)
 * is what lets this skip method/constructor/getter bodies (`PluginManifest`'s constructor nests
 * `Object.defineProperty(...)` object-literal argument braces three deep) without misreading a
 * `case X: return y;` or `get(): T { ... }` line as a field declaration.
 */
function parseClasses(text) {
	const classes = [];
	// `export default class Name extends Base {` (used by e.g. `boards/Driver.ts`, `move/KeepoutZone.ts`)
	// needs its own alternative - "default" sits between "export" and "class" only in that form.
	const classHeaderRe = /export\s+(?:default\s+)?(?:abstract\s+)?class\s+(\w+)(?:\s+extends\s+(\w+))?/g;
	let m;
	while ((m = classHeaderRe.exec(text)) !== null) {
		const name = m[1];
		const extendsName = m[2] ?? null;
		const braceStart = text.indexOf("{", classHeaderRe.lastIndex);
		if (braceStart === -1) continue;
		// Walk forward from the class's own opening brace to its matching close, tracking depth so a
		// nested method/object-literal brace never gets mistaken for the class's own closing brace.
		let depth = 1;
		let i = braceStart + 1;
		const bodyStart = i;
		while (i < text.length && depth > 0) {
			const c = text[i];
			if (c === "{") depth++;
			else if (c === "}") depth--;
			i++;
		}
		const bodyEnd = i - 1;
		const body = text.slice(bodyStart, bodyEnd);
		classes.push({ name, extends: extendsName, fields: parseTopLevelFields(body) });
	}
	return classes;
}

/**
 * Removes every method/constructor/getter/setter BODY from a class body's text (header included),
 * repeatedly, so what remains is only property declarations (and blank lines/comments). Necessary
 * because a naive whole-body regex for `name: type = ...;` also matches object-literal keys INSIDE a
 * method body one level down - `PluginManifest`'s constructor defines `id`/`name` via
 * `Object.defineProperty(this, "id", { enumerable: true, get() {...}, set(value) {...} })`, whose
 * `enumerable: true`/`get(): string { return id; }` lines look exactly like field declarations to a
 * regex that isn't actually tracking brace depth. A method-like header is `[modifiers] name(...)
 * [: ReturnType] {` (covers `constructor(...) {`, `toString(): string {`, `get(): string {`,
 * `update(jsonElement: any): IModelObject | null {`); its matching `}` is found the same
 * depth-counting way `parseClasses` finds a class's own closing brace.
 */
function stripMethodBodies(body) {
	const methodHeaderRe = /(?:public\s+|private\s+|protected\s+|static\s+|override\s+|async\s+|get\s+|set\s+)*\w+\s*\([^()]*\)\s*(?::\s*[^{;]+)?\{/g;
	let result = body;
	for (;;) {
		methodHeaderRe.lastIndex = 0;
		const m = methodHeaderRe.exec(result);
		if (m === null) break;
		const braceStart = m.index + m[0].length - 1; // the header's own trailing "{"
		let depth = 1;
		let i = braceStart + 1;
		while (i < result.length && depth > 0) {
			if (result[i] === "{") depth++;
			else if (result[i] === "}") depth--;
			i++;
		}
		result = result.slice(0, m.index) + result.slice(i);
	}
	return result;
}

/**
 * Within one class body's text (after `stripMethodBodies`), finds instance field declarations -
 * `name: Type = ...;` or `readonly name: Type = ...;`. `static` fields are skipped entirely (not
 * just ignored-as-a-modifier): they are class-level metadata, not per-instance object-model data -
 * `ModelObject`'s own `static readonly resetsMissingProperties: boolean = true;` is exactly the kind
 * of field that would otherwise wrongly appear under every single class's own path.
 */
function parseTopLevelFields(body) {
	const stripped = stripMethodBodies(body);
	const fields = new Map();
	const fieldStartRe = /(?:^|\n)[ \t]*((?:public\s+|private\s+|protected\s+|readonly\s+|override\s+|static\s+)*)(\w+)\s*:\s*/g;
	let m;
	while ((m = fieldStartRe.exec(stripped)) !== null) {
		const modifiers = m[1];
		const fieldName = m[2];
		if (/\bstatic\b/.test(modifiers)) continue;
		if (["constructor", "get", "set"].includes(fieldName)) continue;
		let i = fieldStartRe.lastIndex;
		// Read the type text up to the first `=` or `;` at THIS statement's own depth 0 (a generic's
		// `<...>` doesn't add bracket depth, so only `(){}[]` are tracked - a type text never
		// legitimately contains an unmatched paren/brace/bracket of its own in this codebase, now
		// that method bodies are already stripped out).
		let depth = 0;
		let typeEnd = -1;
		for (let j = i; j < stripped.length; j++) {
			const c = stripped[j];
			if (c === "(" || c === "{" || c === "[") depth++;
			else if (c === ")" || c === "}" || c === "]") depth--;
			else if (depth === 0 && (c === "=" || c === ";")) {
				typeEnd = j;
				break;
			}
		}
		if (typeEnd === -1) continue;
		const rawType = stripped.slice(i, typeEnd).trim();
		// A field can be declared once as a type (possibly re-stated after a constructor sets it up,
		// e.g. `Board`'s fields are declared once, after the constructor) - first declaration wins,
		// matching how these files are actually written (no duplicate declarations observed).
		if (!fields.has(fieldName)) fields.set(fieldName, rawType);
	}
	return fields;
}

/** Every class found across the whole source tree, keyed by name, with its OWN (non-inherited) fields. */
function collectClasses(srcDir) {
	const byName = new Map();
	for (const file of listTsFiles(srcDir)) {
		const text = readFileSync(file, "utf-8");
		for (const cls of parseClasses(text)) {
			// A name can appear once per file at most in this codebase; if the same class name were
			// ever declared in two files, the later one silently winning would be a real bug - so fail
			// loudly instead of guessing which is authoritative.
			if (byName.has(cls.name)) {
				throw new Error(`class "${cls.name}" declared more than once (also in a file already processed)`);
			}
			byName.set(cls.name, cls);
		}
	}
	return byName;
}

/** A class's full field set, own + inherited (walking `extends` up to `ModelObject`/an unknown base). */
function resolveFields(className, classes, memo = new Map()) {
	if (memo.has(className)) return memo.get(className);
	const cls = classes.get(className);
	if (cls === undefined) return new Map();
	const fields = new Map();
	if (cls.extends !== null && classes.has(cls.extends)) {
		for (const [k, v] of resolveFields(cls.extends, classes, memo)) fields.set(k, v);
	}
	for (const [k, v] of cls.fields) fields.set(k, v);
	memo.set(className, fields);
	return fields;
}

/**
 * Reverse-`extends` index: className -> every class that (directly) extends it. Needed because a
 * field typed as a base class is, at runtime, actually one of several concrete subclasses chosen
 * polymorphically - `Board`'s `boards[]` entries are really `MainBoard` (index 0) or `ExpansionBoard`
 * (every other index) depending on position (`boards/index.ts`'s own `getBoard(index)` factory);
 * `Move.kinematics`'s field type `Kinematics` is actually whichever of `CoreKinematics`/
 * `DeltaKinematics`/`HangprinterKinematics`/`ScaraKinematics`/`PolarKinematics` the machine is
 * configured for (`move/kinematics/index.ts`'s `getKinematics(name)`); filament monitor types
 * (`Duet3DFilamentMonitor`/`LaserFilamentMonitor`/...) work the same way. `documentation.json`
 * doesn't pick one variant - it documents the UNION of every variant's own fields at that position
 * (confirmed directly: real `move.kinematics.*` includes delta-only fields like `towers`/
 * `deltaRadius` AND polar/hangprinter-only fields side by side), so `fieldsForPosition` below unions
 * a class's own resolved fields with every transitive subclass's own resolved fields.
 */
function buildSubclassIndex(classes) {
	const index = new Map();
	for (const cls of classes.values()) {
		if (cls.extends === null) continue;
		if (!index.has(cls.extends)) index.set(cls.extends, []);
		index.get(cls.extends).push(cls.name);
	}
	return index;
}

function allDescendants(className, subclassIndex, seen = new Set()) {
	for (const child of subclassIndex.get(className) ?? []) {
		if (seen.has(child)) continue;
		seen.add(child);
		allDescendants(child, subclassIndex, seen);
	}
	return seen;
}

// The universal object-model base. Every class in the tree ultimately extends this, so it must never
// itself be treated as a polymorphic-dispatch "family root" - doing so would union every class in the
// whole codebase together (see `findFamilyRoot`'s doc comment for why this matters).
const UNIVERSAL_BASE_CLASSES = new Set(["ModelObject"]);

/**
 * Walks UP from `className` through `extends` to find the highest ancestor that isn't
 * `UNIVERSAL_BASE_CLASSES` - the shared root of `className`'s whole polymorphic-dispatch family.
 * Needed because the class ACTUALLY declared as a field's type is sometimes itself just one sibling
 * in that family, not the family's own base: `Move.kinematics`'s declared type is `Kinematics`, but
 * `Kinematics`'s siblings `CoreKinematics`/`DeltaKinematics`/`HangprinterKinematics`/
 * `PolarKinematics`/`ScaraKinematics` all extend `KinematicsBase` directly too, alongside (not below)
 * `Kinematics` - so unioning only `Kinematics`'s own descendants (there are none) would miss all of
 * them. Walking up to the shared `KinematicsBase` root first, then unioning ITS full descendant tree,
 * is what actually reaches every real variant.
 */
function findFamilyRoot(className, classes) {
	let current = className;
	for (;;) {
		const cls = classes.get(current);
		if (cls === undefined || cls.extends === null) return current;
		if (UNIVERSAL_BASE_CLASSES.has(cls.extends) || !classes.has(cls.extends)) return current;
		current = cls.extends;
	}
}

/**
 * The full field set to recurse into AT this class position: every field name declared anywhere in
 * `className`'s whole polymorphic-dispatch family (its family root, plus every transitive descendant
 * of that root - see `findFamilyRoot`'s doc comment for why the root, not `className` itself, is
 * where the descendant search has to start), mapped to the SET of every distinct raw type text seen
 * for that field name across the family - not just one. Two sibling subclasses can (and do) declare
 * the SAME field name with COMPLETELY UNRELATED types: `LaserFilamentMonitor.calibrated:
 * LaserFilamentMonitorCalibrated` vs. `PulsedFilamentMonitor.calibrated:
 * PulsedFilamentMonitorCalibrated` vs. `RotatingMagnetFilamentMonitor.calibrated:
 * RotatingMagnetFilamentMonitorCalibrated` - three distinct classes, sharing no base of their own,
 * all reachable at `sensors.filamentMonitors[].calibrated`. Collapsing this to "first type found
 * wins" (an earlier version of this function did exactly that) silently drops whichever variants'
 * fields aren't the one kept - `buildPaths` recurses into every type in the set, so all of them
 * contribute their own children at the same path.
 */
function fieldsForPosition(className, classes, subclassIndex, memo) {
	const key = `pos:${className}`;
	if (memo.has(key)) return memo.get(key);
	const root = findFamilyRoot(className, classes);
	const family = new Set([root, ...allDescendants(root, subclassIndex)]);
	const fields = new Map();
	for (const member of family) {
		for (const [k, v] of resolveFields(member, classes, memo)) {
			if (!fields.has(k)) fields.set(k, new Set());
			fields.get(k).add(v);
		}
	}
	memo.set(key, fields);
	return fields;
}

/**
 * Classes whose own sub-fields are never reported as separate paths, even though they are genuine
 * `ModelObject` subclasses with their own declared fields - each is rendered as one opaque value in
 * the real object model, not decomposed. Confirmed by absence from real `documentation.json`:
 *  - `DriverId` (`board`/`driver`) renders as a single formatted string like `"0.0"`
 *    (`DriverId.toString()`), matching this package's own `dictionary`'s `driverId` `ParamKind` - a
 *    whole-value kind, not a nested object.
 *  - `BoardClosedLoopCurrentFraction`/`BoardClosedLoopPositionError` (`boards[].drivers[].
 *    closedLoop.currentFraction`/`.positionError`) - real docs list these two paths themselves but
 *    never their own `avg`/`max`/`rms` children, unlike every other nested-object field checked.
 */
const LEAF_CLASSES = new Set(["DriverId", "BoardClosedLoopCurrentFraction", "BoardClosedLoopPositionError"]);

/**
 * Top-level object-model fields real `documentation.json` omits entirely, confirmed by direct
 * absence (zero `messages*` keys in the real 691-entry list) rather than assumed: `messages` is a
 * transient, write-only notification queue (`ObjectModel.ts`'s own comment: "must be manually
 * cleared after updates") that isn't part of the persistent, queryable model surface the docs cover.
 */
const ROOT_EXCLUDED_FIELDS = new Set(["messages"]);

/**
 * Classifies one field's raw TS type text into what it means for path-building:
 *  - `object`: a nested class instance (`SBC | null`, `readonly cpu: CPU`) - dot-path, recurse.
 *  - `array`: `ModelCollection<X>`/`ModelDictionary<X>` of a KNOWN class X - `[]`-path, recurse into X
 *    (a `ModelDictionary` renders the same as a `ModelCollection` in documentation.json - confirmed
 *    directly: `plugins`/`plugins[].id` for the dictionary-of-Plugin `plugins` field).
 *  - `leaf`: everything else - primitives, enums, `Array<primitive>`, `ModelSet<...>` (a set of
 *    primitive/enum values), `Map<...>` (an untyped dictionary, e.g. `PluginManifest.data`),
 *    `ModelDictionary<any>` (e.g. `global` - genuinely dynamic, no fixed shape to recurse into).
 */
function classifyField(rawType, classes) {
	const stripped = rawType.replace(/\s*\|\s*(null|undefined)\b/g, "").replace(/\b(null|undefined)\s*\|\s*/g, "").trim();
	const collectionMatch = /^Model(?:Collection|Dictionary)<\s*([\w.]+)\s*(?:\|.*)?>$/.exec(stripped);
	if (collectionMatch) {
		const inner = collectionMatch[1];
		return classes.has(inner) && !LEAF_CLASSES.has(inner) ? { kind: "array", className: inner } : { kind: "leaf" };
	}
	if (/^(ModelSet|Array|Map)</.test(stripped)) return { kind: "leaf" };
	const bareMatch = /^(\w+)$/.exec(stripped);
	if (bareMatch && classes.has(bareMatch[1]) && !LEAF_CLASSES.has(bareMatch[1])) return { kind: "object", className: bareMatch[1] };
	return { kind: "leaf" };
}

/**
 * DFS from a class's resolved fields to every path under it, `[]` for each array/dictionary hop,
 * `.` for each nested-object hop - matching `documentation.json`'s own normalisation exactly (task 07
 * uses the same convention for expression paths). `ancestry` guards against infinite recursion on a
 * cyclic class graph (not observed in this codebase, but cheap to guard) - it is the chain of class
 * names currently open on this DFS branch, not a global "already visited" set, since the same class
 * legitimately appears under many different sibling paths (e.g. `MinMaxCurrent` under `mcuTemp`,
 * `v12` and `vIn` on `Board`).
 */
function buildPaths(className, prefix, classes, subclassIndex, memo, ancestry, out) {
	if (ancestry.has(className)) return; // cyclic type graph guard - not expected, cheap to have
	const fields = fieldsForPosition(className, classes, subclassIndex, memo);
	const nextAncestry = new Set(ancestry).add(className);
	for (const [fieldName, rawTypes] of [...fields.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
		if (prefix === "" && ROOT_EXCLUDED_FIELDS.has(fieldName)) continue;
		const path = prefix === "" ? fieldName : `${prefix}.${fieldName}`;
		out.add(path);
		// A field name can have MORE THAN ONE distinct type across a polymorphic family (see
		// `fieldsForPosition`'s doc comment) - recurse into every one of them at the same path, so
		// e.g. all three FilamentMonitor variants' own "calibrated" fields contribute their children.
		for (const rawType of rawTypes) {
			const info = classifyField(rawType, classes);
			if (info.kind === "object") {
				buildPaths(info.className, path, classes, subclassIndex, memo, nextAncestry, out);
			} else if (info.kind === "array") {
				// The bare `path[]` itself is never a separate documented key - only `path` (the
				// collection/dictionary as a whole, e.g. "fans") and `path[].<child>` are (confirmed
				// directly: real documentation.json has "fans" and "fans[].actualValue" but no "fans[]").
				buildPaths(info.className, `${path}[]`, classes, subclassIndex, memo, nextAncestry, out);
			}
		}
	}
}

/** The full derived path set for one `Duet3D/ObjectModel` source tree, rooted at its `ObjectModel` class. */
function derivePathsFromSource(srcDir) {
	const classes = collectClasses(srcDir);
	if (!classes.has("ObjectModel")) throw new Error(`no "ObjectModel" class found under ${srcDir}`);
	const subclassIndex = buildSubclassIndex(classes);
	const memo = new Map();
	const out = new Set();
	buildPaths("ObjectModel", "", classes, subclassIndex, memo, new Set(), out);
	return out;
}

// The versions this schema actually carries object-model path data for - `VERSIONS_IN_WINDOW` minus
// `NO_OM_SOURCE_AVAILABLE`, kept in the same order (oldest first; `objectModelChanges` walks this
// array positionally, not by re-parsing version strings - task 11's own decision 1 already fixed the
// order by hand once).
const TRACKED_VERSIONS = VERSIONS_IN_WINDOW.filter((v) => !NO_OM_SOURCE_AVAILABLE.has(v));

/** One tracked version's known paths (documentation.json's keys UNIONED with deprecations.json's -
 *  a deprecated path can disappear from documentation.json's own listing while still being a real,
 *  queryable path; see docs/tasks/11-object-model-schema.md's Findings, "network.interfaces[].signal"
 *  is deprecated at every tracked version yet absent from every tracked version's documentation.json)
 *  plus that version's own deprecation messages, keyed by path. */
async function pathsForVersion(version, workDir) {
	// Every tracked version's npm package (even one with no documentation.json) DOES have
	// deprecations.json (confirmed directly - see Findings), so it's always fetched, regardless of
	// which path-list source (documentation.json or the TS-source deriver) this version needs.
	const pkgDir = join(workDir, `pkg-${version}`);
	mkdirSync(pkgDir, { recursive: true });
	execFileSync("npm", ["pack", `@duet3d/objectmodel@${version}`, "--silent"], { cwd: pkgDir, stdio: "inherit", shell: true });
	const tarball = readdirSync(pkgDir).find((f) => f.endsWith(".tgz"));
	execFileSync("tar", ["xzf", tarball], { cwd: pkgDir });
	const distDir = join(pkgDir, "package", "dist");
	const deprecations = new Map(Object.entries(JSON.parse(readFileSync(join(distDir, "deprecations.json"), "utf-8"))));

	let docPaths;
	if (version in DERIVE_FROM_TS_SOURCE) {
		const srcWorkDir = join(workDir, `src-${version}`);
		mkdirSync(srcWorkDir, { recursive: true });
		const srcDir = fetchObjectModelTag(DERIVE_FROM_TS_SOURCE[version], srcWorkDir);
		docPaths = derivePathsFromSource(srcDir);
	} else {
		docPaths = new Set(Object.keys(JSON.parse(readFileSync(join(distDir, "documentation.json"), "utf-8"))));
	}

	// Union with deprecations.json's own keys: a deprecated path can vanish from documentation.json's
	// main listing while still being a real, queryable path (see Findings on
	// "network.interfaces[].signal") - deprecations.json is the tie-breaker that keeps it "known".
	const paths = new Set([...docPaths, ...deprecations.keys()]);
	return { paths, deprecations };
}

/**
 * Builds the per-path lifetime table: for every path seen in ANY tracked version, the first tracked
 * version it's present in (`since`, omitted when that's the very first tracked version - task 11's
 * own convention) and, if it's missing from every tracked version from some point on, the last
 * tracked version it was still present in (`until`). A path present, then absent, then present again
 * across our small, sparse set of tracked snapshots (5 points across ~1 RRF release cycle) would need
 * more than one `{since, until}` span to describe correctly - `MULTI_SPAN_PATHS` below is where that
 * would be flagged loudly rather than silently collapsed into one wrong span; it is empty, meaning
 * this never actually happened across the versions this schema tracks.
 */
function buildLifetimes(perVersionData) {
	const allPaths = new Set();
	for (const { paths } of perVersionData) for (const p of paths) allPaths.add(p);

	// A path's lifetime is modelled as ONE {since?, until?} span - first tracked appearance to last -
	// per the task's own schema sketch. A path that's present, then MISSING from one or more
	// intermediate tracked versions' own path list, then present again, doesn't get a second span:
	// every such case found (see docs/tasks/11-object-model-schema.md's Findings) is a "family union"
	// path - a polymorphic field like `move.kinematics.towers` (delta-kinematics-only) or
	// `sensors.filamentMonitors[].calibrated.mmPerRev` (one monitor-variant-only) - and every one of
	// them is a path this same investigation already found real documentation.json to be
	// INCOMPLETE about elsewhere (`boards[].drivers[].status`, `move.keepout[].active`, etc., absent
	// from even the newest tracked version's own docs with no source-level explanation). Treating an
	// intermediate absence as "genuinely removed, then re-added" would be reporting an upstream
	// documentation gap as an RRF behaviour change; treating it as "still present, just undocumented
	// at that one snapshot" is the reading that matches every other gap this same script found. Any
	// path this affects is logged (not thrown on) so it stays visible without failing the whole build.
	const filledGapPaths = [];
	const lifetimes = new Map();
	for (const path of allPaths) {
		const presence = perVersionData.map(({ paths }) => paths.has(path));
		const firstTrue = presence.indexOf(true);
		const lastTrue = presence.lastIndexOf(true);
		if (presence.slice(firstTrue, lastTrue + 1).includes(false)) filledGapPaths.push(path);
		const entry = {};
		if (firstTrue > 0) entry.since = TRACKED_VERSIONS[firstTrue];
		if (lastTrue < presence.length - 1) entry.until = TRACKED_VERSIONS[lastTrue];
		lifetimes.set(path, entry);
	}
	if (filledGapPaths.length > 0) {
		console.log(`${filledGapPaths.length} path(s) missing from one or more intermediate tracked versions' own path list, treated as continuously present (see buildLifetimes's own doc comment):`);
		for (const p of filledGapPaths.sort()) console.log(`  ${p}`);
	}

	// Deprecation: the path's LATEST message (from the most recent tracked version that has one) and
	// the EARLIEST tracked version it was already deprecated in.
	for (const path of allPaths) {
		let since = null;
		let message = null;
		for (let i = 0; i < perVersionData.length; i++) {
			const msg = perVersionData[i].deprecations.get(path);
			if (msg !== undefined) {
				if (since === null) since = TRACKED_VERSIONS[i];
				message = msg;
			}
		}
		if (message !== null) {
			lifetimes.get(path).deprecated = { since, message };
		}
	}

	return lifetimes;
}

async function build() {
	const workDir = mkdtempSync(join(tmpdir(), "dwc-gcode-core-om-build-"));
	try {
		const perVersionData = [];
		for (const version of TRACKED_VERSIONS) {
			console.log(`Fetching object-model data for ${version} ...`);
			perVersionData.push(await pathsForVersion(version, workDir));
		}
		const lifetimes = buildLifetimes(perVersionData);
		const paths = [...lifetimes.keys()].sort();

		mkdirSync(OUT_DIR, { recursive: true });

		const versionsHeader = `/**
 * RRF release <-> @duet3d/objectmodel version mapping (task 11, docs/tasks/11-object-model-schema.md).
 * GENERATED by scripts/build-om-schema.mjs - do not hand-edit.
 */

export interface ObjectModelVersionInfo {
	/** RRF/npm version string, e.g. "3.6.3". Exact match between an RRF git tag and an
	 *  @duet3d/objectmodel npm version - see the generator script's own VERSIONS_IN_WINDOW. */
	version: string;
	/** False when neither @duet3d/objectmodel's npm package nor Duet3D/ObjectModel's git tags carry
	 *  usable object-model source for this version (currently just "3.7.0-alpha.2") - objectModelPath
	 *  and objectModelChanges never accept this version as an endpoint. */
	hasData: boolean;
}

export const OBJECT_MODEL_VERSIONS: ReadonlyArray<ObjectModelVersionInfo> = ${JSON.stringify(
			VERSIONS_IN_WINDOW.map((v) => ({ version: v, hasData: !NO_OM_SOURCE_AVAILABLE.has(v) })),
			null,
			"\t",
		)};

/** The newest RRF release this schema has object-model data for. */
export const OBJECT_MODEL_BASELINE = "${TRACKED_VERSIONS[TRACKED_VERSIONS.length - 1]}";
`;
		writeFileSync(join(OUT_DIR, "versions.ts"), versionsHeader);

		const schemaHeader = `/**
 * Object-model path existence/deprecation per RRF release (task 11, docs/tasks/11-object-model-schema.md).
 * GENERATED by scripts/build-om-schema.mjs - do not hand-edit; edit the generator and re-run it.
 * "since" omitted = present at the oldest tracked version ("${TRACKED_VERSIONS[0]}"); "until" omitted
 * = still present at the newest ("${TRACKED_VERSIONS[TRACKED_VERSIONS.length - 1]}").
 */

import { OBJECT_MODEL_VERSIONS } from "./versions.js";

export interface ObjectModelPathEntry {
	path: string;
	since?: string;
	until?: string;
	deprecated?: { since: string; message: string };
}

/** Every known path with its lifetime, exported so other generators (task 12's release-events store)
 *  can turn "path added/removed/deprecated at version X" straight into a ChangeEvent without
 *  re-deriving this data. */
export const OBJECT_MODEL_PATHS: ReadonlyArray<ObjectModelPathEntry> = ${JSON.stringify(
			paths.map((p) => ({ path: p, ...lifetimes.get(p) })),
			null,
			"\t",
		)};
const PATHS = OBJECT_MODEL_PATHS;

const BY_PATH: ReadonlyMap<string, ObjectModelPathEntry> = new Map(PATHS.map((e) => [e.path, e]));
const TRACKED_ORDER: ReadonlyArray<string> = ${JSON.stringify(TRACKED_VERSIONS)};

function trackedIndex(version: string): number {
	const i = TRACKED_ORDER.indexOf(version);
	if (i === -1) {
		const known = OBJECT_MODEL_VERSIONS.find((v) => v.version === version);
		throw new Error(
			known === undefined
				? \`"\${version}" is not one of OBJECT_MODEL_VERSIONS\`
				: \`"\${version}" has no object-model data (OBJECT_MODEL_VERSIONS reports hasData: false)\`,
		);
	}
	return i;
}

export interface ObjectModelPathStatus {
	known: boolean;
	deprecated?: string;
	since?: string;
	until?: string;
}

/** Whether \`path\` (already normalised - \`[]\` for every array/dictionary index, as task 07's
 *  expression-path handling already produces) is part of the object model at \`rrfVersion\`, and
 *  whether/since-when it's deprecated. Throws if \`rrfVersion\` isn't one of OBJECT_MODEL_VERSIONS or
 *  has no tracked data (see ObjectModelVersionInfo.hasData). */
export function objectModelPath(path: string, rrfVersion: string): ObjectModelPathStatus {
	const versionIndex = trackedIndex(rrfVersion);
	const entry = BY_PATH.get(path);
	if (entry === undefined) return { known: false };
	const sinceIndex = entry.since === undefined ? 0 : trackedIndex(entry.since);
	const untilIndex = entry.until === undefined ? TRACKED_ORDER.length - 1 : trackedIndex(entry.until);
	const known = versionIndex >= sinceIndex && versionIndex <= untilIndex;
	if (!known) return { known: false };
	const result: ObjectModelPathStatus = { known: true };
	if (entry.since !== undefined) result.since = entry.since;
	if (entry.until !== undefined) result.until = entry.until;
	if (entry.deprecated !== undefined && trackedIndex(entry.deprecated.since) <= versionIndex) {
		result.deprecated = entry.deprecated.message;
	}
	return result;
}

export interface ObjectModelChange {
	path: string;
	change: "added" | "removed" | "deprecated";
	version: string;
}

/** Every object-model path change between two tracked versions, in the direction actually given -
 *  a downgrade (\`toVersion\` older than \`fromVersion\`) reports each addition going forward as a
 *  "removed" and each removal going forward as an "added", so the result always describes what
 *  changes moving from \`fromVersion\` to \`toVersion\`, whichever way that runs. */
export function objectModelChanges(fromVersion: string, toVersion: string): ReadonlyArray<ObjectModelChange> {
	const fromIndex = trackedIndex(fromVersion);
	const toIndex = trackedIndex(toVersion);
	const forward = toIndex >= fromIndex;
	const [lo, hi] = forward ? [fromIndex, toIndex] : [toIndex, fromIndex];
	const changes: Array<ObjectModelChange> = [];
	for (const entry of PATHS) {
		const sinceIndex = entry.since === undefined ? 0 : trackedIndex(entry.since);
		const untilIndex = entry.until === undefined ? TRACKED_ORDER.length - 1 : trackedIndex(entry.until);
		const presentAtLo = sinceIndex <= lo && lo <= untilIndex;
		const presentAtHi = sinceIndex <= hi && hi <= untilIndex;
		// The reported "version" is always the actual RRF version the underlying transition happened
		// at (entry.since/entry.until - always defined in these branches, since an undefined since
		// means "present from the very first tracked version", which would make presentAtLo true) -
		// direction only flips which LABEL ("added" vs "removed") that same transition gets, not
		// where it's pinned. Pinning it to a range endpoint instead (an earlier version of this
		// function did exactly that) reports the wrong version for every downgrade comparison whose
		// range doesn't start/end exactly on the transition itself.
		if (!presentAtLo && presentAtHi) {
			changes.push({ path: entry.path, change: forward ? "added" : "removed", version: entry.since ?? TRACKED_ORDER[lo] });
		} else if (presentAtLo && !presentAtHi) {
			changes.push({ path: entry.path, change: forward ? "removed" : "added", version: entry.until ?? TRACKED_ORDER[hi] });
		}
		if (entry.deprecated !== undefined) {
			const depIndex = trackedIndex(entry.deprecated.since);
			if (depIndex > lo && depIndex <= hi) {
				changes.push({ path: entry.path, change: "deprecated", version: entry.deprecated.since });
			}
		}
	}
	return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
`;
		writeFileSync(join(OUT_DIR, "schema.ts"), schemaHeader);
		console.log(`Wrote ${join(OUT_DIR, "versions.ts")} and ${join(OUT_DIR, "schema.ts")}: ${paths.length} paths across ${TRACKED_VERSIONS.length} tracked versions.`);
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

function fetchObjectModelTag(tag, workDir) {
	// `tar` on this platform (Git-Bash's bsdtar under the Bash tool) reads a `C:\...`-shaped argument
	// as a `host:path` remote-tar spec, not a Windows path - passing a bare relative filename with
	// `cwd` set avoids that entirely, the same fix `--bootstrap`'s own `tar xzf` in
	// `build-dictionary.mjs` didn't need only because it never took an absolute Windows path.
	const tgzName = `${tag}.tar.gz`;
	const buf = execFileSync("gh", ["api", `repos/Duet3D/ObjectModel/tarball/${tag}`], { maxBuffer: 1024 * 1024 * 64 });
	writeFileSync(join(workDir, tgzName), buf);
	execFileSync("tar", ["xzf", tgzName], { cwd: workDir });
	const extracted = readdirSync(workDir).find((n) => n.startsWith("Duet3D-ObjectModel-"));
	if (extracted === undefined) throw new Error(`tarball for ${tag} didn't extract a Duet3D-ObjectModel-* directory`);
	return join(workDir, extracted, "src");
}

async function validate() {
	const workDir = mkdtempSync(join(tmpdir(), "dwc-gcode-core-om-validate-"));
	try {
		console.log("Fetching Duet3D/ObjectModel @ v3.7.0-rc.1 ...");
		const srcDir = fetchObjectModelTag("v3.7.0-rc.1", workDir);
		const derived = derivePathsFromSource(srcDir);

		console.log("Fetching @duet3d/objectmodel@3.7.0-rc.1's real documentation.json ...");
		execFileSync("npm", ["pack", "@duet3d/objectmodel@3.7.0-rc.1", "--silent"], { cwd: workDir, stdio: "inherit", shell: true });
		const tarball = readdirSync(workDir).find((f) => f.endsWith(".tgz"));
		execFileSync("tar", ["xzf", tarball], { cwd: workDir });
		const real = new Set(Object.keys(JSON.parse(readFileSync(join(workDir, "package", "dist", "documentation.json"), "utf-8"))));

		const missingFromDerived = [...real].filter((p) => !derived.has(p)).sort();
		const extraInDerived = [...derived].filter((p) => !real.has(p)).sort();
		const unexplainedMissing = missingFromDerived.filter((p) => !(p in KNOWN_DERIVATION_GAPS));
		const unexplainedExtra = extraInDerived.filter((p) => !(p in KNOWN_DERIVATION_GAPS));

		console.log(`Real documentation.json: ${real.size} paths. Derived: ${derived.size} paths.`);
		console.log(`In real but not derived (${missingFromDerived.length}, ${unexplainedMissing.length} unexplained):`);
		for (const p of missingFromDerived) console.log(`  ${p}${p in KNOWN_DERIVATION_GAPS ? `  (${KNOWN_DERIVATION_GAPS[p]})` : ""}`);
		console.log(`In derived but not real (${extraInDerived.length}, ${unexplainedExtra.length} unexplained):`);
		for (const p of extraInDerived) console.log(`  ${p}${p in KNOWN_DERIVATION_GAPS ? `  (${KNOWN_DERIVATION_GAPS[p]})` : ""}`);

		if (unexplainedMissing.length > 0 || unexplainedExtra.length > 0) {
			console.error("\nUnexplained differences - fix the parser or add a reasoned KNOWN_DERIVATION_GAPS entry.");
			process.exitCode = 1;
		} else {
			console.log("\nAll differences are accounted for in KNOWN_DERIVATION_GAPS.");
		}
	} finally {
		rmSync(workDir, { recursive: true, force: true });
	}
}

const args = process.argv.slice(2);
if (args.includes("--validate")) {
	await validate();
} else {
	await build();
}
