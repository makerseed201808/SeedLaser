#!/usr/bin/env bash
# SeedLaser macOS 打包：生成 dist/SeedLaser.app 和 dist/SeedLaser-macOS.zip
set -euo pipefail
cd "$(dirname "$0")"

echo ""
echo "==== SeedLaser - PyInstaller 打包 (macOS) ===="
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
# ---- GitHub 连不上时，改用本地 boxes 镜像（third_party/boxes.git，见 scripts/make_boxes_mirror.sh）----
MIRROR="$PWD/third_party/boxes.git"
if [[ -d "$MIRROR" ]]; then
    if [[ "${SEEDBOXES_USE_MIRROR:-}" == "1" ]] || ! curl -s --max-time 5 -o /dev/null https://github.com; then
        echo "[*] 连不上 GitHub，改用本地镜像 third_party/boxes.git"
        # 只对本脚本启动的 git 生效（不改全局 git 配置），需要 git >= 2.31
        export GIT_CONFIG_COUNT=1
        export GIT_CONFIG_KEY_0="url.file://$MIRROR.insteadOf"
        export GIT_CONFIG_VALUE_0="https://github.com/florianfesti/boxes"
        export SEEDBOXES_USE_MIRROR=1
    fi
fi

# 如需国内镜像加速：UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple ./build_mac.sh
uv sync --extra build
uv run python scripts/fetch_boxes_assets.py

echo ""
echo "[2/4] 清理旧产物 ..."
rm -rf build dist

echo ""
echo "[3/4] 运行 PyInstaller ..."
uv run pyinstaller --noconfirm --clean SeedLaser.spec

echo ""
echo "[4/4] 打包 zip（ditto 保留 .app 的权限与符号链接）..."
ditto -c -k --sequesterRsrc --keepParent dist/SeedLaser.app dist/SeedLaser-macOS.zip

echo ""
echo "=========================================="
echo " [OK] 打包完成！"
echo " 产物：dist/SeedLaser.app"
echo "       dist/SeedLaser-macOS.zip（分发用）"
echo " 注意：未签名，首次打开需右键 → 打开（或在"
echo "       系统设置 → 隐私与安全性 中点「仍要打开」）"
echo "=========================================="
