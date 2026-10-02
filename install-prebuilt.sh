#!/bin/sh
# Install (or restore) the prebuilt I18n plugin -- no compiler, no cmake, no fish.
#
#   ./install-prebuilt.sh            install
#   ./install-prebuilt.sh --restore  put the stock libraries back
#
# The prebuilt libraries were built for the exact source revision and Qt
# version recorded in MANIFEST.txt. Do not use them after updating the shell.

set -eu

BUNDLE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
QMLROOT=${QMLROOT:-/usr/lib/qt6/qml}
MOD="$QMLROOT/Caelestia/I18n"
LIB="$QMLROOT/Caelestia/lib"

if [ ! -d "$MOD" ] || [ ! -d "$LIB" ]; then
    echo "error: $QMLROOT/Caelestia not found (set QMLROOT to override)" >&2
    exit 1
fi

if [ "${1:-}" = "--restore" ]; then
    sudo sh -c "set -e
        for d in '$LIB' '$MOD'; do
            for f in \"\$d\"/*.hanhua-bak; do
                [ -e \"\$f\" ] || continue
                mv -f \"\$f\" \"\${f%.hanhua-bak}\"
                echo \"restored \${f%.hanhua-bak}\"
            done
        done"
    echo "Restart the shell for the rollback to take effect."
    exit 0
fi

# backing library first: the plugin resolves it through $ORIGIN/../lib
for f in libcaelestia-i18n.so libcaelestia-i18nplugin.so; do
    case $f in
        libcaelestia-i18n.so)         d=$LIB ;;
        libcaelestia-i18nplugin.so)   d=$MOD ;;
    esac
    sudo sh -c "set -e
        if [ -e '$d/$f' ] && [ ! -e '$d/$f.hanhua-bak' ]; then cp -f '$d/$f' '$d/$f.hanhua-bak'; fi
        cp -f '$BUNDLE/prebuilt/$f' '$d/$f.hanhua-new'
        mv -f '$d/$f.hanhua-new' '$d/$f'"
    echo "    installed $d/$f"
done

echo
echo "Restart the shell:  qs -c caelestia"
echo "Roll back with:     ./install-prebuilt.sh --restore"
