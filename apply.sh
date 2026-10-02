#!/bin/sh
# Apply the midnight-shell Chinese localisation to a source tree.
#
#   ./apply.sh [TARGET_REPO]
#
# TARGET_REPO defaults to the current directory. It must be a midnight-shell
# checkout. Existing files are overwritten; the patched files are only touched
# if the patch still applies cleanly, so running this twice is safe.

set -eu

BUNDLE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET=${1:-$PWD}
TARGET=$(CDPATH= cd -- "$TARGET" && pwd)

if [ ! -d "$TARGET/plugin/src/Caelestia/I18n" ]; then
    echo "error: $TARGET does not look like a midnight-shell checkout" >&2
    exit 1
fi

echo "==> applying to $TARGET"

# ---------------------------------------------------------------- new files
(cd "$BUNDLE/files" && find . -type f -print) | while read -r rel; do
    rel=${rel#./}
    dest="$TARGET/$rel"
    mkdir -p "$(dirname -- "$dest")"
    cp -f "$BUNDLE/files/$rel" "$dest"
    echo "    added   $rel"
done

# ---------------------------------------------------------------- patches
#
# `patch` is preferred over `git apply` on purpose.  git resolves patch paths
# against the *repository root*, not the current directory, so when TARGET is a
# subdirectory of some other repository (or not a repository at all) git apply
# can silently skip every hunk and still exit 0.  patch(1) is cwd-relative and
# has no such notion.  Whichever tool runs, the result is verified by comparing
# the file before and after, so a silent skip can never be reported as success.
for p in "$BUNDLE"/patches/*.patch; do
    name=$(basename -- "$p")
    rel=$(sed -n 's|^+++ b/||p' "$p" | head -n 1)

    before=""
    [ -n "$rel" ] && [ -f "$TARGET/$rel" ] && before=$(cksum < "$TARGET/$rel")

    ok=0
    if command -v patch >/dev/null 2>&1; then
        if (cd "$TARGET" && patch -p1 --forward --no-backup-if-mismatch -s < "$p" >/dev/null 2>&1); then
            ok=1
        fi
    fi
    if [ "$ok" -eq 0 ] && (cd "$TARGET" && git apply --check "$p" >/dev/null 2>&1); then
        if (cd "$TARGET" && git apply "$p" >/dev/null 2>&1); then
            ok=1
        fi
    fi

    after=""
    [ -n "$rel" ] && [ -f "$TARGET/$rel" ] && after=$(cksum < "$TARGET/$rel")

    if [ -n "$before" ] && [ "$before" = "$after" ]; then
        echo "    SKIPPED $name (already applied, or $rel differs)"
    elif [ "$ok" -eq 1 ] && [ -n "$after" ]; then
        echo "    patched $name"
    else
        echo "    FAILED  $name -- apply it by hand from patches/" >&2
        exit 1
    fi
done

cat <<'EOF'

Done. Next, in the target tree:

    cmake -B build -G Ninja -DCMAKE_INSTALL_PREFIX=/ -DCMAKE_BUILD_TYPE=RelWithDebInfo
    ninja -C build caelestia-i18n
    node scripts/hanhua.mjs check
    node scripts/hanhua.mjs install
    qs -c caelestia

The catalogues are 100% translated, so no further editing is needed.
EOF
