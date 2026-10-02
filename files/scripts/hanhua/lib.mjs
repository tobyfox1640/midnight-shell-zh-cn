// Shared helpers for the hanhua (localisation) toolchain.
//
// The shell carries two independent translation mechanisms, so this module
// knows how to read and write both:
//
//   1. The custom `Tr` system. Sources are scanned by scripts/trs.fish into
//      trs/raw.pot, translations live in trs/<lang>.po and are compiled by
//      msgfmt into <lang>.mo. The .mo is parsed at runtime by a hand-rolled
//      reader in plugin/src/Caelestia/I18n/translator.cpp.
//
//   2. Plain qsTr(). Qt's own scanner (lupdate) cannot parse this codebase, so
//      extraction is done by extract-qsTr.mjs. Translations live in
//      trs/<lang>.ts and are compiled by lrelease into <lang>.qm, which a
//      QTranslator installed by Translator serves to the QML engine.

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export const REPO_ROOT = resolve(new URL("../..", import.meta.url).pathname);
export const TRS_DIR = join(REPO_ROOT, "plugin/src/Caelestia/I18n/trs");

export const QML_SCAN_DIRS = ["components", "modules", "services", "utils", "plugin/src"];
export const SKIP_DIRS = new Set([".git", "build", "node_modules", ".hanhua-work", ".direnv"]);

// ---------------------------------------------------------------------------
// small utilities
// ---------------------------------------------------------------------------

export function ensureDir(path) {
    mkdirSync(path, { recursive: true });
}

export function readText(path) {
    return readFileSync(path, "utf8");
}

export function writeText(path, text) {
    ensureDir(dirname(path));
    writeFileSync(path, text);
}

export function toPosix(path) {
    return path.split(sep).join("/");
}

export function relToRepo(absPath) {
    return toPosix(relative(REPO_ROOT, absPath));
}

/** Recursively list files under `root` whose name matches `predicate`. */
export function walkFiles(root, predicate, out = []) {
    if (!existsSync(root)) return out;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const full = join(root, entry.name);
        if (entry.isDirectory()) walkFiles(full, predicate, out);
        else if (entry.isFile() && predicate(entry.name, full)) out.push(full);
    }
    return out;
}

export function collectQmlFiles() {
    const files = [];
    for (const dir of QML_SCAN_DIRS) {
        const abs = join(REPO_ROOT, dir);
        if (!existsSync(abs)) continue;
        walkFiles(abs, name => name.endsWith(".qml"), files);
    }
    return files.sort();
}

export function collectCppFiles() {
    const files = [];
    for (const dir of ["plugin/src", "plugin/include"]) {
        const abs = join(REPO_ROOT, dir);
        if (!existsSync(abs)) continue;
        walkFiles(abs, name => name.endsWith(".cpp") || name.endsWith(".hpp"), files);
    }
    return files.sort();
}

// ---------------------------------------------------------------------------
// placeholder handling
//
// Both catalogs use %1/%2/%n style placeholders. A translation is only valid
// if it mentions exactly the same set of placeholders as the source, otherwise
// the runtime either leaves a literal "%1" on screen or drops information.
// ---------------------------------------------------------------------------

const PLACEHOLDER_RE = /%(?:\d+|n|L\d+|Ln)/g;

export function placeholders(text) {
    return (text.match(PLACEHOLDER_RE) || []).sort();
}

export function samePlaceholders(source, target) {
    const a = placeholders(source);
    const b = placeholders(target);
    if (a.length !== b.length) return false;
    return a.every((value, index) => value === b[index]);
}

// NOTE: there is deliberately no printf-directive check here. This project
// declares its catalogues as qt-format, not c-format, so `%1h` / `%1m` / `%1d`
// are the Qt placeholder `%1` followed by a literal unit letter -- not a printf
// conversion. A c-format regex flags all five of those as mismatches against
// their perfectly correct translations. `msgfmt --check-format` (run by
// scripts/trs.fish compile) is the authority for the .po side; `samePlaceholders`
// above covers the .ts side.

// ---------------------------------------------------------------------------
// gettext .pot / .po reading and writing
// ---------------------------------------------------------------------------

/**
 * Parse a gettext catalogue into entries. Handles multi-line msgid/msgstr,
 * msgctxt, msgid_plural/msgstr[N] and the `#,` / `#.` / `#:` comment forms.
 */
export function parsePo(text) {
    const lines = text.split("\n");
    const entries = [];
    let current = null;
    let field = null;

    const push = () => {
        if (current && (current.msgid !== undefined || current.msgctxt !== undefined)) entries.push(current);
        current = null;
    };

    for (const raw of lines) {
        const line = raw.trimEnd();
        if (line === "") {
            push();
            field = null;
            continue;
        }
        if (line.startsWith("#")) {
            if (!current) current = { comments: [], refs: [], flags: [] };
            if (line.startsWith("#:")) current.refs.push(line.slice(2).trim());
            else if (line.startsWith("#,")) current.flags.push(line.slice(2).trim());
            else if (line.startsWith("#.") || line.startsWith("# ")) current.comments.push(line.replace(/^#\.?\s?/, ""));
            continue;
        }
        if (!current) current = { comments: [], refs: [], flags: [] };

        const m = line.match(/^(msgctxt|msgid_plural|msgid|msgstr(?:\[(\d+)\])?)\s+(.*)$/);
        if (m) {
            const [, key, pluralIndex, rest] = m;
            const value = unquotePo(rest);
            if (key === "msgctxt") current.msgctxt = value;
            else if (key === "msgid") current.msgid = value;
            else if (key === "msgid_plural") current.msgidPlural = value;
            else {
                current.msgstr = current.msgstr ?? [];
                current.msgstr[pluralIndex === undefined ? 0 : Number(pluralIndex)] = value;
            }
            field = key;
            continue;
        }
        if (line.startsWith('"')) {
            const value = unquotePo(line);
            if (field === "msgctxt") current.msgctxt += value;
            else if (field === "msgid") current.msgid += value;
            else if (field === "msgid_plural") current.msgidPlural += value;
            else if (field?.startsWith("msgstr")) {
                const idx = field.match(/\[(\d+)\]/);
                const i = idx ? Number(idx[1]) : 0;
                current.msgstr = current.msgstr ?? [];
                current.msgstr[i] = (current.msgstr[i] ?? "") + value;
            }
        }
    }
    push();
    return entries;
}

function unquotePo(text) {
    const m = text.match(/^"([\s\S]*)"$/);
    if (!m) return text;
    return m[1]
        .replace(/\\n/g, "\n")
        .replace(/\\t/g, "\t")
        .replace(/\\r/g, "\r")
        .replace(/\\"/g, '"')
        .replace(/\\\\/g, "\\");
}

function quotePo(text) {
    return `"${text
        .replace(/\\/g, "\\\\")
        .replace(/"/g, '\\"')
        .replace(/\n/g, "\\n")
        .replace(/\t/g, "\\t")
        .replace(/\r/g, "\\r")}"`;
}

/** Render entries as .po text. Empty msgstr marks an untranslated entry. */
export function writePo(entries, header) {
    const out = [];
    out.push('msgid ""');
    out.push('msgstr ""');
    // Every continuation line carries its own trailing newline, including the
    // last: without it msgfmt glues the final header line onto the next one and
    // misreads Content-Type.
    const headerLines = header.trimEnd().split("\n");
    for (let i = 0; i < headerLines.length; i++) {
        const isLast = i === headerLines.length - 1;
        out.push(quotePo(isLast ? headerLines[i] : headerLines[i] + "\n"));
    }
    out.push("");

    for (const entry of entries) {
        if (entry.msgid === "" && !entry.msgctxt) continue;
        if (entry.comments?.length) for (const c of entry.comments) out.push(`#. ${c}`);
        if (entry.refs?.length) for (const r of entry.refs) out.push(`#: ${r}`);
        if (entry.flags?.length) out.push(`#, ${entry.flags.join(", ")}`);
        if (entry.msgctxt !== undefined) out.push(`msgctxt ${quotePo(entry.msgctxt)}`);
        out.push(`msgid ${quotePo(entry.msgid)}`);
        if (entry.msgidPlural !== undefined) {
            out.push(`msgid_plural ${quotePo(entry.msgidPlural)}`);
            const forms = entry.msgstr?.length ? entry.msgstr : [""];
            forms.forEach((form, index) => out.push(`msgstr[${index}] ${quotePo(form ?? "")}`));
        } else {
            out.push(`msgstr ${quotePo(entry.msgstr?.[0] ?? "")}`);
        }
        out.push("");
    }
    return out.join("\n");
}

export const PO_HEADER = `Project-Id-Version: caelestia-shell
Report-Msgid-Bugs-To: https://github.com/dim-ghub/midnight-shell/issues
PO-Revision-Date: ${new Date().toISOString().replace("T", " ").slice(0, 16)}+0800
Last-Translator: hanhua
Language-Team: Chinese (Simplified)
Language: zh_CN
MIME-Version: 1.0
Content-Type: text/plain; charset=UTF-8
Content-Transfer-Encoding: 8bit
Plural-Forms: nplurals=1; plural=0;
X-Generator: scripts/hanhua.mjs`;

// ---------------------------------------------------------------------------
// Qt .ts reading and writing
// ---------------------------------------------------------------------------

function escapeXml(text) {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function unescapeXml(text) {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&");
}

/** Parse a Qt .ts file into { language, contexts: [{name, messages}] }. */
export function parseTs(text) {
    const language = text.match(/<TS[^>]*\blanguage="([^"]*)"/)?.[1] ?? "";
    const contexts = [];
    const contextRe = /<context>([\s\S]*?)<\/context>/g;
    let cm;
    while ((cm = contextRe.exec(text))) {
        const body = cm[1];
        const name = unescapeXml(body.match(/<name>([\s\S]*?)<\/name>/)?.[1] ?? "");
        const messages = [];
        const messageRe = /<message[^>]*>([\s\S]*?)<\/message>/g;
        let mm;
        while ((mm = messageRe.exec(body))) {
            const inner = mm[1];
            const source = unescapeXml(inner.match(/<source>([\s\S]*?)<\/source>/)?.[1] ?? "");
            const translationRaw = inner.match(/<translation([^>]*)>([\s\S]*?)<\/translation>/);
            const attrs = translationRaw?.[1] ?? "";
            const type = attrs.match(/type="([^"]*)"/)?.[1];
            const isPlural = /<numerusform/.test(inner);
            let translation = "";
            let numerus = [];
            if (isPlural) {
                const formRe = /<numerusform[^>]*>([\s\S]*?)<\/numerusform>/g;
                let fm;
                while ((fm = formRe.exec(inner))) numerus.push(unescapeXml(fm[1]));
                translation = numerus[0] ?? "";
            } else {
                translation = unescapeXml(translationRaw?.[2] ?? "");
            }
            const locations = [];
            const locRe = /<location\s+filename="([^"]*)"\s+line="(\d+)"/g;
            let lm;
            while ((lm = locRe.exec(inner))) locations.push({ file: unescapeXml(lm[1]), line: Number(lm[2]) });
            messages.push({ source, translation, numerus, type, locations, plural: isPlural });
        }
        contexts.push({ name, messages });
    }
    return { language, contexts };
}

/** Render parsed contexts back to a .ts file. */
export function writeTs(language, contexts) {
    const out = ['<?xml version="1.0" encoding="utf-8"?>', '<!DOCTYPE TS>', `<TS version="2.1" language="${escapeXml(language)}">`];
    for (const context of contexts) {
        out.push("<context>");
        out.push(`    <name>${escapeXml(context.name)}</name>`);
        for (const message of context.messages) {
            out.push("    <message>");
            for (const loc of message.locations ?? [])
                out.push(`        <location filename="${escapeXml(loc.file)}" line="${loc.line}"/>`);
            out.push(`        <source>${escapeXml(message.source)}</source>`);
            if (message.plural) {
                // Chinese has a single plural form, so one <numerusform> is enough.
                const form = message.numerus?.[0] ?? "";
                const attr = form ? "" : ' type="unfinished"';
                out.push(`        <translation${attr}><numerusform>${escapeXml(form)}</numerusform></translation>`);
            } else {
                const attr = message.translation ? "" : ' type="unfinished"';
                out.push(`        <translation${attr}>${escapeXml(message.translation ?? "")}</translation>`);
            }
            out.push("    </message>");
        }
        out.push("</context>");
    }
    out.push("</TS>");
    return out.join("\n") + "\n";
}

// ---------------------------------------------------------------------------
// qsTr() extraction
//
// lupdate cannot be used on this codebase: its QML parser rejects modern syntax
// (`v: var` annotations, optional chaining, `??`, template literals) and gives
// up on the whole file, so it only ever sees ~29% of the strings. This scanner
// is deliberately syntactic rather than a full parser: it walks each file once,
// skips comments and string literals, and reads the argument list of every
// qsTr() call. That is sufficient because every call site passes a plain string
// literal as its first argument.
//
// Qt attributes a qsTr() call to the file it appears in, using the basename as
// the context name. The root object's type is irrelevant, so files sharing a
// basename (Content.qml appears nine times) also share a context.
// ---------------------------------------------------------------------------

const QS_CALL_RE = /(?<![\w.])(qsTr|qsTranslate|qsTrId)\s*\(/g;

/** Walk `src` and yield the index of every real (non-comment, non-string) match. */
function* findCodeOccurrences(src, needle) {
    let i = 0;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (c === "/" && src[i + 1] === "/") {
            i = src.indexOf("\n", i);
            if (i < 0) return;
            continue;
        }
        if (c === "/" && src[i + 1] === "*") {
            const end = src.indexOf("*/", i + 2);
            i = end < 0 ? n : end + 2;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") {
            const quote = c;
            i++;
            while (i < n) {
                if (src[i] === "\\") i += 2;
                else if (src[i] === quote) {
                    i++;
                    break;
                } else i++;
            }
            continue;
        }
        if (src.startsWith(needle, i)) {
            yield i;
            i += needle.length;
            continue;
        }
        i++;
    }
}

/** Read a quoted JS string literal at `i`; returns { value, end } or null. */
function readStringLiteral(src, i) {
    const quote = src[i];
    if (quote !== '"' && quote !== "'" && quote !== "`") return null;
    let out = "";
    i++;
    while (i < src.length) {
        const c = src[i];
        if (c === "\\") {
            const next = src[i + 1];
            switch (next) {
                case "n": out += "\n"; break;
                case "t": out += "\t"; break;
                case "r": out += "\r"; break;
                case "\\": out += "\\"; break;
                case "'": out += "'"; break;
                case '"': out += '"'; break;
                case "`": out += "`"; break;
                case "$": out += "$"; break;
                case "u": {
                    if (src[i + 2] === "{") {
                        const close = src.indexOf("}", i + 3);
                        if (close < 0) return null;
                        out += String.fromCodePoint(parseInt(src.slice(i + 3, close), 16));
                        i = close + 1;
                        continue;
                    }
                    out += String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
                    i += 6;
                    continue;
                }
                default: out += next ?? "";
            }
            i += 2;
            continue;
        }
        if (c === quote) return { value: out, end: i + 1 };
        out += c;
        i++;
    }
    return null;
}

/** Split a call's argument list, honouring nesting. */
function readArgs(src, openParen) {
    const args = [];
    let depth = 1;
    let i = openParen + 1;
    let start = i;
    const n = src.length;
    while (i < n) {
        const c = src[i];
        if (c === "/" && src[i + 1] === "/") {
            const nl = src.indexOf("\n", i);
            i = nl < 0 ? n : nl;
            continue;
        }
        if (c === "/" && src[i + 1] === "*") {
            const end = src.indexOf("*/", i + 2);
            i = end < 0 ? n : end + 2;
            continue;
        }
        if (c === '"' || c === "'" || c === "`") {
            const lit = readStringLiteral(src, i);
            if (!lit) return null;
            i = lit.end;
            continue;
        }
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") {
            depth--;
            if (depth === 0) {
                args.push(src.slice(start, i).trim());
                return args;
            }
        } else if (c === "," && depth === 1) {
            args.push(src.slice(start, i).trim());
            start = i + 1;
        }
        i++;
    }
    return null;
}

function contextForFile(rel) {
    const base = rel.slice(rel.lastIndexOf("/") + 1);
    return base.endsWith(".qml") ? base.slice(0, -4) : base;
}

/**
 * Extract every qsTr() call from the QML sources.
 * @returns {{ entries: Array, unsupported: string[], files: number, callSites: number }}
 */
export function extractQsTr(root = REPO_ROOT) {
    const byContext = new Map();
    const unsupported = [];
    let files = 0;
    let callSites = 0;

    for (const dir of QML_SCAN_DIRS) {
        const abs = join(root, dir);
        if (!existsSync(abs)) continue;
        for (const file of walkFiles(abs, name => name.endsWith(".qml"))) {
            files++;
            const src = readText(file);
            const rel = toPosix(relative(root, file));
            QS_CALL_RE.lastIndex = 0;
            for (const at of findCodeOccurrences(src, "qsTr(")) {
                const paren = at + "qsTr".length;
                const args = readArgs(src, paren);
                if (!args || args.length === 0) continue;
                const lit = readStringLiteral(args[0], 0);
                if (!lit || lit.end !== args[0].length) {
                    unsupported.push(`${rel}: non-literal qsTr argument: ${args[0]}`);
                    continue;
                }
                if (args.length > 1) unsupported.push(`${rel}: qsTr with disambiguation: ${args[0]}`);
                const context = contextForFile(rel);
                const line = src.slice(0, at).split("\n").length;
                if (!byContext.has(context)) byContext.set(context, new Map());
                const sources = byContext.get(context);
                if (!sources.has(lit.value)) sources.set(lit.value, []);
                sources.get(lit.value).push({ file: rel, line });
                callSites++;
            }
            for (const name of ["qsTranslate", "qsTrId"]) {
                for (const at of findCodeOccurrences(src, name + "(")) {
                    const line = src.slice(0, at).split("\n").length;
                    unsupported.push(`${rel}:${line}: ${name} is not supported by this extractor`);
                }
            }
        }
    }

    const entries = [];
    for (const context of [...byContext.keys()].sort()) {
        const sources = byContext.get(context);
        for (const source of [...sources.keys()].sort()) {
            entries.push({
                context,
                source,
                locations: sources.get(source).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line),
            });
        }
    }
    return { entries, unsupported, files, callSites };
}

// ---------------------------------------------------------------------------
// catalogue statistics
// ---------------------------------------------------------------------------

export function poStats(entries) {
    const real = entries.filter(e => e.msgid !== "");
    const translated = real.filter(e => (e.msgstr?.[0] ?? "") !== "");
    const plurals = real.filter(e => e.msgidPlural !== undefined);
    return { total: real.length, translated: translated.length, missing: real.length - translated.length, plurals: plurals.length };
}

export function tsStats(contexts) {
    let total = 0;
    let translated = 0;
    for (const context of contexts)
        for (const message of context.messages) {
            total++;
            if (message.translation) translated++;
        }
    return { total, translated, missing: total - translated };
}
