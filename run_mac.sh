#!/usr/bin/env bash
# SeedLaser 开发模式启动（macOS / Linux）
set -euo pipefail
cd "$(dirname "$0")"

echo ""
echo "==== SeedLaser (开发模式) ===="
echo ""

if ! command -v uv >/dev/null 2>&1; then
    echo "[X] 未找到 uv，请先安装：brew install uv"
    echo "    或：curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
fi

echo "[1/3] 同步依赖 (uv sync) ..."
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

# 如需国内镜像加速：UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple ./run_mac.sh
uv sync

echo ""
echo "[2/3] 准备 boxes 资源（作品照片 + 中文翻译，首次需联网）..."
uv run python scripts/fetch_boxes_assets.py

echo ""
echo "[3/3] 启动客户端 ..."
uv run python app.py
