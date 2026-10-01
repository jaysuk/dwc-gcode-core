/**
 * Reading RRF's G-code handlers out of a tree at a commit, for the history scripts (`dictionary-history.mjs`,
 * `dictionary-param-history.mjs`). A candidate generator's parser: it follows the dispatcher's `case N:` and the
 * `GCodeBuffer` functions a case calls, and answers "does this handler read letter X". It does not understand C++
 * (`#if` blocks are all counted, overloads are merged), so every result is confirmed with `git show` before use.
 */
import { spawnSync } from "node:child_process";

import { git, lines } from "./rrfClone.mjs";

/** Strips `//` and block comments to spaces (newlines kept) and blanks string literals, so braces inside them do not
 *  count. A char literal is kept as `'X'` (its letter is the point), and a short all-letters string is kept so
 *  `SeenAny("XYZ")` can be read. */
export function blank(text) {
	let out = "";
	for (let i = 0; i < text.length; i++) {
		const c = text[i];
		const n = text[i + 1];
		if (c === "/" && n === "/") {
			while (i < text.length && text[i] !== "\n") { out += " "; i++; }
			out += "\n";
			continue;
		}
		if (c === "/" && n === "*") {
			i += 2;
			while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) { out += text[i] === "\n" ? "\n" : " "; i++; }
			i++;
			out += "  ";
			continue;
		}
		if (c === "'") {
			const m = /^'(?:\\.|[^\\'])'/.exec(text.slice(i, i + 4));
			if (m !== null) {
				out += m[0];
				i += m[0].length - 1;
				continue;
			}
		}
		if (c === '"') {
			let j = i + 1;
			while (j < text.length && text[j] !== '"' && text[j] !== "\n") { if (text[j] === "\\") j++; j++; }
			const inner = text.slice(i + 1, j);
			out += /^[A-Za-z]{1,12}$/.test(inner) ? `"${inner}"` : `"${" ".repeat(Math.max(0, j - i - 1))}"`;
			i = j;
			continue;
		}
		out += c;
	}
	return out;
}

/** `git cat-file --batch` over `paths` at `commit`: Map path -> text. One process, so a tree loads in a second or two. */
export function loadFiles(clone, commit, paths) {
	const input = paths.map((p) => `${commit}:${p}\n`).join("");
	const r = spawnSync("git", ["-C", clone, "cat-file", "--batch"], { input, maxBuffer: 1024 * 1024 * 1024 });
	if (r.status !== 0) throw new Error(`git cat-file failed: ${r.stderr?.toString()}`);
	const buf = r.stdout;
	const out = new Map();
	let pos = 0;
	for (const path of paths) {
		const nl = buf.indexOf(10, pos);
		const header = buf.subarray(pos, nl).toString();
		pos = nl + 1;
		const m = /^\S+ blob (\d+)$/.exec(header);
		if (m === null) continue; // "<ref> missing"
		const size = Number(m[1]);
		out.set(path, buf.subarray(pos, pos + size).toString("utf8"));
		pos += size + 1;
	}
	return out;
}

/** Every `.cpp` under `src/` at `commit`, blanked: Map path -> text. */
export function loadTree(clone, commit) {
	const paths = lines(git(clone, ["ls-tree", "-r", "--name-only", commit, "src/"])).filter((p) => p.endsWith(".cpp"));
	const raw = loadFiles(clone, commit, paths);
	const tree = new Map();
	for (const [p, t] of raw) tree.set(p, blank(t));
	return tree;
}

/** The text of the `{...}` block that opens at or after `from`. */
export function braceBlock(text, from) {
	const open = text.indexOf("{", from);
	if (open < 0) return null;
	let depth = 0;
	for (let i = open; i < text.length; i++) {
		if (text[i] === "{") depth++;
		else if (text[i] === "}" && --depth === 0) return text.slice(open, i + 1);
	}
	return null;
}

const HANDLERS = [
	{ letter: "G", fn: /bool\s+GCodes::HandleGcode\s*\(/ },
	{ letter: "M", fn: /bool\s+GCodes::HandleMcode\s*\(/ },
	{ letter: "T", fn: /bool\s+GCodes::HandleTcode\s*\(/ },
];

/** Integer case labels at the top level of every `switch (code)` in `body`: Map n -> text of that case. */
export function topLevelCases(body) {
	const found = new Map();
	const re = /switch\s*\(\s*code\s*\)\s*\{/g;
	let m;
	while ((m = re.exec(body)) !== null) {
		let depth = 1;
		let i = re.lastIndex;
		const labels = [];
		while (i < body.length && depth > 0) {
			const c = body[i];
			if (c === "{") depth++;
			else if (c === "}") depth--;
			else if (depth === 1) {
				const c2 = /^case\s+(\d+)\s*:/.exec(body.slice(i, i + 16));
				if (c2 !== null && /[\s;{}:]/.test(body[i - 1] ?? " ")) {
					labels.push({ n: Number(c2[1]), at: i });
					i += c2[0].length - 1;
				}
			}
			i++;
		}
		// consecutive labels (`case 140: case 141:`) share the body that follows the last one
		let below = "";
		for (let k = labels.length - 1; k >= 0; k--) {
			const seg = body.slice(labels[k].at, k + 1 < labels.length ? labels[k + 1].at : i);
			// a label followed only by whitespace or preprocessor lines (`#if ... case 917: #endif`) shares the next body
			const empty = seg.replace(/^case\s+\d+\s*:/, "").replace(/^[ \t]*#[^\n]*$/gm, "").trim() === "";
			if (!empty) below = seg;
			found.set(labels[k].n, empty ? below : seg);
		}
	}
	return found;
}

/** Map "M140" -> { file, body } for every implemented integer code (a case that only hands the line to a macro is not one). */
export function dispatchCases(tree) {
	const result = new Map();
	for (const [file, text] of tree) {
		if (!/\/GCodes\d*\.cpp$/.test(file)) continue;
		for (const { letter, fn } of HANDLERS) {
			const m = fn.exec(text);
			if (m === null) continue;
			const body = braceBlock(text, m.index);
			if (body === null) continue;
			for (const [n, caseBody] of topLevelCases(body)) {
				const onlyMacro = /^case\s+\d+\s*:\s*(?:result\s*=\s*)?TryMacroFile\s*\(\s*gb\s*\)\s*;?\s*(?:break\s*;)?\s*$/.test(caseBody.trim());
				if (!onlyMacro) result.set(`${letter}${n}`, { file, body: caseBody });
			}
		}
	}
	return result;
}

/** Map function-name -> [{ file, name, body }] for every definition whose parameter list mentions `GCodeBuffer`. */
export function gcodeFunctions(tree) {
	const defs = new Map();
	const re = /(\b(?:\w+::)*\w+)\s*\(([^(){};]*\bGCodeBuffer\b[^(){};]*)\)\s*(?:const\s*)?(?:noexcept\s*)?(?:THROWS\s*\([^)]*\)\s*)?(?:pre\s*\([^)]*\)\s*)?(?:_ecv_\w+\s*)?\{/g;
	for (const [file, text] of tree) {
		let m;
		re.lastIndex = 0;
		while ((m = re.exec(text)) !== null) {
			const full = m[1];
			const name = full.split("::").pop();
			if (/^(if|for|while|switch|return)$/.test(name)) continue;
			const body = braceBlock(text, m.index + m[0].length - 1);
			if (body === null) continue;
			const list = defs.get(name) ?? [];
			list.push({ file, name: full, body });
			defs.set(name, list);
		}
	}
	return defs;
}

/** Names called with `gb` among their arguments in `body` (the accessors that read a letter are not callees). */
export function calleesWithGb(body) {
	const names = new Set();
	const re = /\b(\w+)\s*\(([^;{}]*?)\)/g;
	let m;
	while ((m = re.exec(body)) !== null) {
		if (!/\bgb\b(?!\s*\.)/.test(m[2])) continue; // `gb` handed over, not just `gb.GetFValue()` used as an argument
		if (/^(if|for|while|switch|return|Seen|SeenAny|MustSee)$/.test(m[1]) || /^(Get|TryGet|Has)\w*$/.test(m[1])) continue;
		names.add(m[1]);
	}
	return names;
}

/** Does `body` read letter `X` from the G-code (`Seen('X')`, `MustSee('X')`, `TryGet...('X'`, `Get...('X'`, `SeenAny("..X..")`)? */
export function readsLetter(body, letter) {
	const l = letter.replace(/[^A-Za-z]/g, "");
	if (l.length !== 1) return false;
	if (new RegExp(`\\b(?:Seen|MustSee|TryGet\\w*|Get\\w*|Has\\w*)\\s*\\(\\s*'${l}'`).test(body)) return true;
	const many = /\bSeenAny\s*\(\s*"([A-Za-z]+)"/g;
	let m;
	while ((m = many.exec(body)) !== null) if (m[1].includes(l)) return true;
	return false;
}

/** Every letter `body` reads through the calls above. */
export function lettersRead(body) {
	const out = new Set();
	const single = /\b(?:Seen|MustSee|TryGet\w*|Get\w*|Has\w*)\s*\(\s*'([A-Za-z])'/g;
	let m;
	while ((m = single.exec(body)) !== null) out.add(m[1]);
	const many = /\bSeenAny\s*\(\s*"([A-Za-z]+)"/g;
	while ((m = many.exec(body)) !== null) for (const ch of m[1]) out.add(ch);
	return out;
}

/**
 * The handler text for `code` at one tree: its dispatch case plus, transitively (depth 3), the `GCodeBuffer` functions it
 * calls, looked up first in `files` (the files the dictionary entry cites) and only then anywhere (when few). `unresolved`
 * lists callees with no usable definition, so a missing helper reads as "cannot tell", not "letter absent".
 */
export function handlerText(cases, defs, code, files) {
	const c = cases.get(code);
	if (c === undefined) return null;
	const parts = [c.body];
	const seen = new Set();
	const unresolved = new Set();
	let frontier = [c.body];
	for (let depth = 0; depth < 3; depth++) {
		const next = [];
		for (const text of frontier) {
			for (const name of calleesWithGb(text)) {
				if (seen.has(name)) continue;
				seen.add(name);
				const all = defs.get(name) ?? [];
				const inFiles = all.filter((d) => files.some((f) => d.file.endsWith(f)));
				const use = inFiles.length > 0 ? inFiles : all.length <= 3 ? all : [];
				if (use.length === 0) {
					unresolved.add(all.length === 0 ? name : `${name} (${all.length} definitions, none in the cited files)`);
					continue;
				}
				for (const d of use) { parts.push(d.body); next.push(d.body); }
			}
		}
		frontier = next;
	}
	return { text: parts.join("\n"), unresolved: [...unresolved] };
}
