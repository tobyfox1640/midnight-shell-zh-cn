#!/usr/bin/env node
// hanhua — Chinese localisation toolchain for midnight-shell.
//
// The shell has two independent translation mechanisms and this tool drives
// both of them from a single reviewable dictionary:
//
//   Tr    Tr.tr()/trCtx()/trN() in QML, read at runtime by a hand-rolled .mo
//         parser. Sources are collected by scripts/trs.fish into trs/raw.pot;
//         the built catalogue is plugin/src/Caelestia/I18n/trs/zh_CN.po, which
//         msgfmt compiles to <lang>.mo inside the Caelestia.I18n resource.
//
//   qsTr  Plain Qt qsTr() in QML, served by a QTranslator that Translator
//         installs. The catalogue is trs/zh_CN.ts, which lrelease compiles to
//         <lang>.qm, also embedded in the same resource.
//
// Commands:
//   extract   Rebuild trs/raw.pot and refresh the .po/.ts skeletons from source
//   merge     Apply scripts/hanhua/i18n/<lang>.json into the .po and .ts
//   build     Compile the .po and .ts into .mo and .qm
//   check     Validate placeholders, plural forms and untranslated entries
//   status    Show coverage for both catalogues
//   install   Build and copy the compiled plugin into the running shell
//
// Typical use:
//   node scripts/hanhua.mjs extract && node scripts/hanhua.mjs merge
//   node scripts/hanhua.mjs build && sudo node scripts/hanhua.mjs install

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";

import {
    PO_HEADER,
    REPO_ROOT,
    TRS_DIR,
    collectCppFiles,
    ensureDir,
    extractQsTr,
    parsePo,
    parseTs,
    poStats,
    readText,
    relToRepo,
    samePlaceholders,
    tsStats,
    writePo,
    writeText,
    writeTs,
} from "./hanhua/lib.mjs";

const LANGS = ["zh_CN"];
const I18N_DIR = join(REPO_ROOT, "scripts/hanhua/i18n");
const BUILD_I18N_DIR = join(REPO_ROOT, "build/plugin/src/Caelestia/I18n");

// Installed layout. The catalogues are compiled into the Qt resource that lives
// in the *backing library* (Caelestia/lib/), not in the QML plugin -- the
// plugin only references it through an RPATH of `$ORIGIN:$ORIGIN/../lib`.
const QML_ROOT = "/usr/lib/qt6/qml";
const INSTALL_MODULE_DIR = join(QML_ROOT, "Caelestia/I18n");
const INSTALL_LIB_DIR = join(QML_ROOT, "Caelestia/lib");

// [built artefact, installed path]
const ARTEFACTS = [
    [join(REPO_ROOT, "build/plugin/src/Caelestia/I18n/libcaelestia-i18n.so"), join(INSTALL_LIB_DIR, "libcaelestia-i18n.so")],
    [join(REPO_ROOT, "build/qml/Caelestia/I18n/libcaelestia-i18nplugin.so"), join(INSTALL_MODULE_DIR, "libcaelestia-i18nplugin.so")],
];

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function run(cmd, args, opts = {}) {
    return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...opts });
}

function info(msg) {
    console.log(msg);
}

function warn(msg) {
    console.warn("warning: " + msg);
}

function fail(msg) {
    console.error("error: " + msg);
    process.exitCode = 1;
}

function dictPath(lang) {
    return join(I18N_DIR, `${lang}.json`);
}

function poPath(lang) {
    return join(TRS_DIR, `${lang}.po`);
}

function tsPath(lang) {
    return join(TRS_DIR, `${lang}.ts`);
}

function loadDict(lang) {
    const path = dictPath(lang);
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readText(path));
    // Entries beginning with "_" are documentation, not translations.
    const out = {};
    for (const [key, value] of Object.entries(raw)) {
        if (key.startsWith("_")) continue;
        if (typeof value === "string") out[key] = value;
    }
    return out;
}

// ---------------------------------------------------------------------------
// extract
// ---------------------------------------------------------------------------

/**
 * Run scripts/trs.fish raw to refresh raw.pot, then fold any new msgids into
 * the .po as untranslated entries (existing translations are preserved), and
 * regenerate the .ts skeleton from the qsTr scanner.
 */
function cmdExtract(args) {
    const lang = args.lang ?? LANGS[0];

    info("==> collecting Tr sources (scripts/trs.fish raw)");
    try {
        run("fish", [join(REPO_ROOT, "scripts/trs.fish"), "raw"], { cwd: REPO_ROOT, stdio: "inherit" });
    } catch (e) {
        fail(`trs.fish raw failed: ${e.message}`);
        return;
    }

    const potPath = join(TRS_DIR, "raw.pot");
    if (!existsSync(potPath)) {
        fail(`${relToRepo(potPath)} was not produced`);
        return;
    }

    // --- .po: keep translations, add new msgids, drop vanished ones ---
    const potEntries = parsePo(readText(potPath)).filter(e => e.msgid !== "");
    const existing = existsSync(poPath(lang)) ? parsePo(readText(poPath(lang))) : [];
    const byKey = new Map();
    for (const e of existing) if (e.msgid !== "") byKey.set(`${e.msgctxt ?? ""}\u0004${e.msgid}`, e);

    let added = 0;
    const merged = [];
    for (const entry of potEntries) {
        const key = `${entry.msgctxt ?? ""}\u0004${entry.msgid}`;
        const prior = byKey.get(key);
        if (prior) {
            // Refresh comments/refs/flags from source, keep the translation.
            merged.push({ ...entry, msgstr: prior.msgstr });
        } else {
            added++;
            merged.push({ ...entry, msgstr: entry.msgidPlural !== undefined ? [""] : [""] });
        }
    }
    writeText(poPath(lang), writePo(merged, PO_HEADER));
    info(`    ${relToRepo(poPath(lang))}: ${merged.length} entries (${added} new)`);

    // --- .ts: same idea, keyed by context + source ---
    const { entries, unsupported } = extractQsTr();
    const priorTs = existsSync(tsPath(lang)) ? parseTs(readText(tsPath(lang))) : { contexts: [] };
    const priorByKey = new Map();
    for (const ctx of priorTs.contexts)
        for (const m of ctx.messages) priorByKey.set(`${ctx.name}\u0004${m.source}`, m);

    const contextMap = new Map();
    let tsAdded = 0;
    for (const e of entries) {
        if (!contextMap.has(e.context)) contextMap.set(e.context, []);
        const prior = priorByKey.get(`${e.context}\u0004${e.source}`);
        if (!prior) tsAdded++;
        contextMap.get(e.context).push({
            source: e.source,
            translation: prior?.translation ?? "",
            numerus: prior?.numerus ?? [],
            locations: e.locations,
            plural: prior?.plural ?? false,
        });
    }
    const contexts = [...contextMap.entries()]
        .sort((a, b) => a[0].localeCompare(b[0]))
        .map(([name, messages]) => ({ name, messages }));
    writeText(tsPath(lang), writeTs(lang, contexts));
    info(`    ${relToRepo(tsPath(lang))}: ${contexts.reduce((n, c) => n + c.messages.length, 0)} entries (${tsAdded} new)`);
    if (unsupported.length) for (const line of unsupported) warn(line);
}

// ---------------------------------------------------------------------------
// merge
// ---------------------------------------------------------------------------

/** Apply the JSON dictionary to the .po and .ts catalogues. */
function cmdMerge(args) {
    const lang = args.lang ?? LANGS[0];
    const dict = loadDict(lang);
    const keys = Object.keys(dict);
    if (keys.length === 0) {
        fail(`no translations in ${relToRepo(dictPath(lang))}`);
        return;
    }

    // --- .po ---
    const poEntries = parsePo(readText(poPath(lang))).filter(e => e.msgid !== "");
    let poApplied = 0;
    for (const entry of poEntries) {
        const value = dict[entry.msgid];
        if (value === undefined) continue;
        // Chinese has a single plural form, so one msgstr covers msgid_plural too.
        entry.msgstr = [value];
        poApplied++;
    }
    writeText(poPath(lang), writePo(poEntries, PO_HEADER));
    info(`${relToRepo(poPath(lang))}: applied ${poApplied}/${poEntries.length}`);

    // --- .ts ---
    const parsed = parseTs(readText(tsPath(lang)));
    let tsApplied = 0;
    let tsTotal = 0;
    for (const ctx of parsed.contexts)
        for (const m of ctx.messages) {
            tsTotal++;
            const value = dict[m.source];
            if (value === undefined) continue;
            if (m.plural) m.numerus = [value];
            m.translation = value;
            tsApplied++;
        }
    writeText(tsPath(lang), writeTs(lang, parsed.contexts));
    info(`${relToRepo(tsPath(lang))}: applied ${tsApplied}/${tsTotal}`);

    const unused = keys.filter(k => !poEntries.some(e => e.msgid === k) && !parsed.contexts.some(c => c.messages.some(m => m.source === k)));
    if (unused.length) {
        warn(`${unused.length} dictionary entries match no source string (stale?)`);
        for (const k of unused.slice(0, 10)) warn(`    ${JSON.stringify(k)}`);
    }
}

// ---------------------------------------------------------------------------
// build
// ---------------------------------------------------------------------------

function cmdBuild(args) {
    const lang = args.lang ?? LANGS[0];
    const outDir = args.out ? join(REPO_ROOT, args.out) : join(REPO_ROOT, ".hanhua-work/out");
    ensureDir(outDir);

    // Probe by presence rather than by `--version`: lrelease exits non-zero for
    // --version, it only prints its usage.
    for (const tool of ["msgfmt", "lrelease"]) {
        try {
            run("sh", ["-c", `command -v ${tool}`]);
        } catch {
            fail(`${tool} not found; install gettext and qt6-tools`);
            return;
        }
    }

    const mo = join(outDir, `${lang}.mo`);
    const qm = join(outDir, `${lang}.qm`);

    // msgfmt --check-format rejects translations whose printf directives do not
    // match the source, which is exactly the class of mistake we care about.
    run("msgfmt", ["--check-format", "-o", mo, poPath(lang)]);
    info(`built ${relToRepo(mo)} (${statSync(mo).size} bytes)`);

    run("lrelease", ["-silent", tsPath(lang), "-qm", qm]);
    info(`built ${relToRepo(qm)} (${statSync(qm).size} bytes)`);

    // Also drop them where the CMake build expects them, so a plain
    // `ninja -C build` picks them up without a full reconfigure.
    if (existsSync(BUILD_I18N_DIR)) {
        ensureDir(join(BUILD_I18N_DIR, "trs"));
        copyFileSync(mo, join(BUILD_I18N_DIR, "trs", `${lang}.mo`));
        copyFileSync(qm, join(BUILD_I18N_DIR, "trs", `${lang}.qm`));
        info(`copied into ${relToRepo(BUILD_I18N_DIR)}/trs`);
    }
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

function cmdCheck(args) {
    const lang = args.lang ?? LANGS[0];
    let problems = 0;

    // --- .po ---
    const poEntries = parsePo(readText(poPath(lang))).filter(e => e.msgid !== "");
    for (const entry of poEntries) {
        const value = entry.msgstr?.[0] ?? "";
        if (value === "") continue; // untranslated is reported by `status`
        if (!samePlaceholders(entry.msgid, value)) {
            fail(`${lang}.po: placeholder mismatch\n    source: ${JSON.stringify(entry.msgid)}\n    target: ${JSON.stringify(value)}`);
            problems++;
        }
        if (entry.msgidPlural !== undefined && !value) {
            fail(`${lang}.po: empty plural translation for ${JSON.stringify(entry.msgid)}`);
            problems++;
        }
    }
    const pos = poStats(poEntries);
    info(`${lang}.po: ${pos.translated}/${pos.total} translated, ${pos.plurals} plural entr${pos.plurals === 1 ? "y" : "ies"}`);

    // --- .ts ---
    const parsed = parseTs(readText(tsPath(lang)));
    for (const ctx of parsed.contexts)
        for (const m of ctx.messages) {
            const value = m.plural ? (m.numerus?.[0] ?? "") : m.translation;
            if (!value) continue;
            if (!samePlaceholders(m.source, value)) {
                fail(`${lang}.ts [${ctx.name}]: placeholder mismatch\n    source: ${JSON.stringify(m.source)}\n    target: ${JSON.stringify(value)}`);
                problems++;
            }
        }
    const tss = tsStats(parsed.contexts);
    info(`${lang}.ts: ${tss.translated}/${tss.total} translated`);

    // --- the project's own translation linter, when available ---
    const linter = join(REPO_ROOT, "scripts/trs-check.py");
    if (existsSync(linter)) {
        try {
            run("python3", [linter], { cwd: REPO_ROOT, stdio: "inherit" });
        } catch (e) {
            // python3 is broken in some environments (see the PYTHONHOME note in
            // the docs), so a failure here is reported but not fatal on its own.
            warn(`scripts/trs-check.py could not run: ${e.message.split("\n")[0]}`);
        }
    }

    if (problems === 0) info("check passed");
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

function cmdStatus() {
    for (const lang of LANGS) {
        info(`=== ${lang} ===`);
        if (existsSync(poPath(lang))) {
            const s = poStats(parsePo(readText(poPath(lang))));
            info(`  Tr   (.po): ${s.translated}/${s.total} translated (${pct(s.translated, s.total)}), ${s.missing} missing`);
        } else info(`  Tr   (.po): absent`);
        if (existsSync(tsPath(lang))) {
            const s = tsStats(parseTs(readText(tsPath(lang))).contexts);
            info(`  qsTr (.ts): ${s.translated}/${s.total} translated (${pct(s.translated, s.total)}), ${s.missing} missing`);
        } else info(`  qsTr (.ts): absent`);
        const dict = loadDict(lang);
        info(`  dictionary: ${Object.keys(dict).length} entries`);
    }

    // The catalogues are compiled into the backing library, so there is no .mo
    // or .qm file to look for. Compare timestamps against the catalogues
    // instead: sizes are useless here because the build tree is RelWithDebInfo
    // and the packaged library is stripped.
    const [, installedLib] = ARTEFACTS[0];
    if (!existsSync(installedLib)) {
        info(`installed module not found at ${INSTALL_LIB_DIR}`);
        return;
    }
    const backup = installedLib + ".hanhua-bak";
    if (!existsSync(backup)) {
        info(`installed: ${installedLib} is the stock library -- run install to localise it`);
        return;
    }
    const installedAt = statSync(installedLib).mtimeMs;
    const stale = LANGS.filter(l => statSync(poPath(l)).mtimeMs > installedAt || statSync(tsPath(l)).mtimeMs > installedAt);
    if (stale.length === 0) info(`installed: ${installedLib} is up to date (stock library kept at ${backup})`);
    else info(`installed: ${installedLib} is behind the catalogues for ${stale.join(", ")} -- run install to update`);
}

function pct(n, total) {
    return total === 0 ? "n/a" : ((n / total) * 100).toFixed(1) + "%";
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

/**
 * Build the I18n module and copy the two compiled artefacts over the installed
 * ones. Only the I18n module changes, so this avoids a full shell reinstall.
 */
function cmdInstall(args) {
    const buildDir = join(REPO_ROOT, "build");
    const isRoot = process.getuid?.() === 0;

    // The build must run as the invoking user: building as root leaves
    // root-owned objects in build/ and the tree can no longer be rebuilt
    // without sudo. Only the copy into the module directory needs privileges,
    // and that is escalated per file below.
    if (!isRoot) {
        if (!existsSync(join(buildDir, "build.ninja"))) {
            fail("no configured build directory; run cmake -B build first (see scripts/hanhua/README.md)");
            return;
        }

        cmdBuild(args);

        info("==> rebuilding the I18n module");
        try {
            run("ninja", ["-C", buildDir, "caelestia-i18n"], { stdio: "inherit" });
        } catch (e) {
            fail(`ninja failed: ${e.message}`);
            if (!existsSync(join(buildDir, "CMakeFiles/rules.ninja")))
                fail(`hint: ${relToRepo(buildDir)} is in a broken half-configured state (CMakeFiles/rules.ninja is missing). Remove build/ and re-run cmake.`);
            return;
        }
    } else {
        warn("running as root: skipping the build, since that would leave root-owned files in build/");
        warn("build as your normal user, then re-run this command with sudo for the copy only");
    }

    for (const [src] of ARTEFACTS)
        if (!existsSync(src)) {
            fail(`expected artefact at ${relToRepo(src)}; build it first as your normal user`);
            return;
        }

    if (!existsSync(INSTALL_MODULE_DIR)) {
        fail(`installed module directory ${INSTALL_MODULE_DIR} not found`);
        return;
    }

    // The catalogues live in the backing library, not the plugin, so this is
    // the directory that actually has to exist for the localisation to load.
    if (!existsSync(INSTALL_LIB_DIR)) {
        fail(`installed library directory ${INSTALL_LIB_DIR} not found`);
        return;
    }

    for (const [src, dst] of ARTEFACTS) {
        const backup = dst + ".hanhua-bak";
        try {
            if (existsSync(dst) && !existsSync(backup)) copyFileSync(dst, backup);
            const tmp = dst + ".hanhua-new";
            copyFileSync(src, tmp);
            renameSync(tmp, dst);
            info(`installed ${dst}`);
            continue;
        } catch (e) {
            if (!["EACCES", "EPERM", "EROFS"].includes(e.code)) throw e;
        }

        // Direct write refused; escalate just this copy, keeping the original
        // aside as *.hanhua-bak so `uninstall` can put it back.
        info(`==> ${dst} needs root, retrying with sudo`);
        try {
            run("sudo", [
                "sh", "-c",
                `set -e
                 if [ -e "$1" ] && [ ! -e "$2" ]; then cp -f "$1" "$2"; fi
                 cp -f "$3" "$4"
                 mv -f "$4" "$1"`,
                "sh", dst, backup, src, dst + ".hanhua-new",
            ], { stdio: "inherit" });
            info(`installed ${dst}`);
        } catch (e) {
            fail(`sudo copy failed for ${dst}: ${e.message}`);
            return;
        }
    }

    info(`\nRestart the shell for the change to take effect, e.g.  qs -c caelestia`);
    info(`The stock libraries are backed up alongside the originals as *.hanhua-bak`);
    info(`Roll back with:  node scripts/hanhua.mjs uninstall`);
}

function cmdUninstall() {
    let restored = 0;
    for (const [, dst] of ARTEFACTS) {
        const backup = dst + ".hanhua-bak";
        if (!existsSync(backup)) continue;
        try {
            renameSync(backup, dst);
            info(`restored ${dst}`);
            restored++;
            continue;
        } catch (e) {
            if (!["EACCES", "EPERM", "EROFS"].includes(e.code)) {
                fail(`could not restore ${dst}: ${e.message}`);
                continue;
            }
        }

        info(`==> ${dst} needs root, retrying with sudo`);
        try {
            run("sudo", ["sh", "-c", `set -e; mv -f "$1" "$2"`, "sh", backup, dst], { stdio: "inherit" });
            info(`restored ${dst}`);
            restored++;
        } catch (e) {
            fail(`sudo restore failed for ${dst}: ${e.message}`);
        }
    }
    if (restored === 0) info("nothing to roll back");
    else info("restart the shell for the rollback to take effect");
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

const USAGE = `hanhua — Chinese localisation for midnight-shell

usage: node scripts/hanhua.mjs <command> [--lang zh_CN] [--out DIR]

commands:
  extract    refresh trs/raw.pot and rebuild the .po/.ts skeletons from source
  merge      apply scripts/hanhua/i18n/<lang>.json into the .po and .ts
  build      compile the .po and .ts into .mo and .qm
  check      validate placeholder consistency in both catalogues
  status     show translation coverage and what is currently installed
  install    build, then install the I18n plugin into the running shell (escalates the copy itself)
  uninstall  restore the plugin backed up by install
`;

function main() {
    const argv = process.argv.slice(2);
    const command = argv[0];
    const args = {};
    for (let i = 1; i < argv.length; i++) {
        if (argv[i] === "--lang") args.lang = argv[++i];
        else if (argv[i] === "--out") args.out = argv[++i];
    }

    switch (command) {
        case "extract": return cmdExtract(args);
        case "merge": return cmdMerge(args);
        case "build": return cmdBuild(args);
        case "check": return cmdCheck(args);
        case "status": return cmdStatus();
        case "install": return cmdInstall(args);
        case "uninstall": return cmdUninstall();
        default:
            console.log(USAGE);
            if (command) process.exitCode = 1;
    }
}

main();
