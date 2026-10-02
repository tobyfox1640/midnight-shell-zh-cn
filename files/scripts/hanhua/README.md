# hanhua — Chinese localisation for midnight-shell

The shell carries **two independent translation mechanisms**, and this tool
drives both of them from one reviewable JSON dictionary.

| | `Tr` | `qsTr` |
|---|---|---|
| Used as | `Tr.tr()` / `trCtx()` / `trN()` / `trCtxN()` / `trMarked()` | plain Qt `qsTr()` |
| Catalogue | `plugin/src/Caelestia/I18n/trs/zh_CN.po` | `plugin/src/Caelestia/I18n/trs/zh_CN.ts` |
| Compiled by | `msgfmt` (via `scripts/trs.fish compile`) | `lrelease` |
| Runtime | hand-rolled `.mo` parser in `translator.cpp` | a `QTranslator` that `Translator` installs |
| Extracted by | `xgettext` (via `scripts/trs.fish raw`) | `scripts/hanhua/extract-qsTr.mjs` |

Both catalogues end up as `<lang>.mo` / `<lang>.qm` **inside the
`Caelestia.I18n` Qt resource**, because `Translator::resourceDir()` is
hard-coded to `:/qt/qml/Caelestia/I18n/`. There is no way to load a catalogue
from disk at runtime, so **adding a language always requires rebuilding the
`caelestia-i18n` plugin.** That is what `install` automates.

## Quick start

```sh
cmake -B build -G Ninja -DCMAKE_BUILD_TYPE=RelWithDebInfo \
      -DVERSION=1.0.0 -DGIT_REVISION=$(git rev-parse --short HEAD) \
      -DCMAKE_INSTALL_PREFIX=/
ninja -C build caelestia-i18n

node scripts/hanhua.mjs status     # coverage of both catalogues
node scripts/hanhua.mjs check      # placeholder consistency
node scripts/hanhua.mjs install    # builds, then asks for sudo for the copy
qs -c caelestia                    # restart the shell
```

`-DVERSION` must be a valid semver (`1.0.0-local` is rejected) and both
`-DVERSION` and `-DGIT_REVISION` must be given, otherwise CMake tries to query
the *upstream* repository over the network.

## Commands

```
node scripts/hanhua.mjs <command> [--lang zh_CN] [--out DIR]
```

| Command | What it does |
|---|---|
| `extract` | Runs `scripts/trs.fish raw`, then folds new msgids into the `.po` (keeping existing translations) and regenerates the `.ts` skeleton with the qsTr scanner. |
| `merge` | Applies `scripts/hanhua/i18n/<lang>.json` to both catalogues. Reports dictionary entries that match no source string. |
| `build` | Compiles the `.po` with `msgfmt --check-format` and the `.ts` with `lrelease`. Output defaults to `.hanhua-work/out/`. |
| `check` | Verifies that every translation keeps the same `%1`/`%n`/`%Ln` placeholders as its source. Exits non-zero on a mismatch. |
| `status` | Coverage for both catalogues, dictionary size, and the catalogues currently installed on the system. |
| `install` | `build`, then `ninja -C build caelestia-i18n`, then copies the two plugin `.so` files into the QML module tree. Run it as your normal user: it escalates just the copy with `sudo`, because building as root would leave root-owned objects in `build/`. |
| `uninstall` | Restores the `.so` files backed up by `install`. |

## The dictionary

`scripts/hanhua/i18n/zh_CN.json` is the single source of truth for the
translations. Keys are English source strings; keys beginning with `_` are
documentation (the glossary and translation rules) and are skipped by `merge`.
One dictionary entry can serve both mechanisms at once, since the two
catalogues share many strings.

To translate a new string, add it to the JSON and re-run `merge`:

```sh
$EDITOR scripts/hanhua/i18n/zh_CN.json
node scripts/hanhua.mjs merge
node scripts/hanhua.mjs check
node scripts/hanhua.mjs install
```

## Why the qsTr scanner is hand-written

`lupdate` **cannot parse this codebase.** Its QML parser predates `v: var`
type annotations, optional chaining, `??` and template literals, so it aborts
on most files; a full run reported 228 `Expected token` errors across 263
files and recovered only 221 of the 769 `qsTr()` calls. `extract-qsTr.mjs` is
a plain token scan that skips comments and string literals and therefore
handles the whole tree. (`lrelease` is unaffected — it only reads `.ts`.)

## Notes

- Language names are matched against `QLocale::system().uiLanguages()` with
  **underscores** (`zh_CN`, not `zh-CN`), because `Translator::langForLocale()`
  asks for `TagSeparator::Underscore` and then does an exact string compare.
- `general.language` in `shell.json` overrides the locale. Leaving it empty
  makes the shell pick the catalogue matching the system locale, so a machine
  already running `zh_CN.UTF-8` needs no configuration change.
- `translator.cpp` installs its `QTranslator` only for the `qsTr` half; the
  `Tr` half never touches Qt's translation machinery. Both are reloaded
  together in `Translator::setLanguage()`.
- The `.po` is compiled by `scripts/trs.fish compile`, so **`fish` is required
  to build the translation catalogue.**
- `scripts/trs-check.py` is the project's own translation linter. `check`
  invokes it when `python3` is available; a failure to run it is a warning,
  not an error.
- `.envrc` passes `-DCMAKE_CXX_COMPILER=clazy` only when `clazy` is actually
  installed. It used to pass it unconditionally, which made every `direnv`
  reload fail the configure step and leave `build/` without
  `CMakeFiles/rules.ninja` — after which even a plain `ninja` could not start.
  If you hit `build.ninja:35: loading 'CMakeFiles/rules.ninja': No such file`,
  delete `build/` and reconfigure.
