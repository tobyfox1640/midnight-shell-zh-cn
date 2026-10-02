#!/usr/bin/env bash
set -euo pipefail

data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
bin_file="${HOME}/.local/bin/caelestia-zh-apply"
data_dir="$data_home/caelestia-zh-cn"

usage() {
    cat <<'EOF'
用法：./uninstall.sh [选项]

卸载中文翻译包工具；不会删除现有 Caelestia 用户配置。

选项：
  -h, --help    显示帮助
EOF
}

while (($#)); do
    case "$1" in
        -h|--help) usage; exit 0 ;;
        *) echo "未知选项：$1" >&2; usage >&2; exit 64 ;;
    esac
    shift
done

rm -f "$bin_file"
rm -rf "$data_dir"

echo "已卸载 Caelestia 中文翻译包工具。"
echo "现有用户配置未被删除：${XDG_CONFIG_HOME:-$HOME/.config}/quickshell/caelestia"
echo "可以在 Shell 的“语言和地区”中切换为 English 或跟随系统。"
