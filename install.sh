#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
bin_dir="$HOME/.local/bin"
apply_after_install=true

usage() {
    cat <<'EOF'
用法：./install.sh [选项]

选项：
  --no-apply    只安装翻译包和工具，暂不切换界面语言
  -h, --help    显示帮助
EOF
}

while (($#)); do
    case "$1" in
        --no-apply) apply_after_install=false ;;
        -h|--help) usage; exit 0 ;;
        *) echo "未知选项：$1" >&2; usage >&2; exit 64 ;;
    esac
    shift
done

install -Dm644 "$repo_dir/i18n/qml_zh_CN.qm" \
    "$data_home/caelestia-zh-cn/i18n/qml_zh_CN.qm"
install -Dm644 "$repo_dir/i18n/qml_zh_CN.ts" \
    "$data_home/caelestia-zh-cn/i18n/qml_zh_CN.ts"
install -Dm644 "$repo_dir/i18n/zh_CN.json" \
    "$data_home/caelestia-zh-cn/i18n/zh_CN.json"
install -Dm755 "$repo_dir/bin/caelestia-zh-apply" \
    "$bin_dir/caelestia-zh-apply"

echo "已安装：$bin_dir/caelestia-zh-apply"
echo "简体中文翻译包：$data_home/caelestia-zh-cn/i18n/qml_zh_CN.qm"

if $apply_after_install; then
    "$bin_dir/caelestia-zh-apply"
fi
