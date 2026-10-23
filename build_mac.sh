#!/usr/bin/env bash
# SeedBoxes macOS 打包：生成 dist/SeedBoxes.app 和 dist/SeedBoxes-macOS.zip
set -euo pipefail
cd "$(dirname "$0")"

echo ""
echo "==== SeedBoxes - PyInstaller 打包 (macOS) ===="
echo ""

if [[ "$(uname)" != "Darwin" ]]; then
    echo "[X] 此脚本只能在 macOS 上运行（Windows 请用 build_uv.bat）"
    exit 1
fi
if ! command -v uv >/dev/null 2>&1; then
    echo "[X] 未找到 uv，请先安装：brew install uv"
    exit 1
fi

echo "[1/4] 同步依赖（含 build extras）..."
# 如需国内镜像加速：UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple ./build_mac.sh
uv sync --extra build
uv run python scripts/fetch_boxes_assets.py

echo ""
echo "[2/4] 清理旧产物 ..."
rm -rf build dist

echo ""
echo "[3/4] 运行 PyInstaller ..."
uv run pyinstaller --noconfirm --clean SeedBoxes.spec

echo ""
echo "[4/4] 打包 zip（ditto 保留 .app 的权限与符号链接）..."
ditto -c -k --sequesterRsrc --keepParent dist/SeedBoxes.app dist/SeedBoxes-macOS.zip

echo ""
echo "=========================================="
echo " [OK] 打包完成！"
echo " 产物：dist/SeedBoxes.app"
echo "       dist/SeedBoxes-macOS.zip（分发用）"
echo " 注意：未签名，首次打开需右键 → 打开（或在"
echo "       系统设置 → 隐私与安全性 中点「仍要打开」）"
echo "=========================================="
