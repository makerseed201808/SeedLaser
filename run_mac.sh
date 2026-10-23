#!/usr/bin/env bash
# SeedBoxes 开发模式启动（macOS / Linux）
set -euo pipefail
cd "$(dirname "$0")"

echo ""
echo "==== SeedBoxes (开发模式) ===="
echo ""

if ! command -v uv >/dev/null 2>&1; then
    echo "[X] 未找到 uv，请先安装：brew install uv"
    echo "    或：curl -LsSf https://astral.sh/uv/install.sh | sh"
    exit 1
fi

echo "[1/3] 同步依赖 (uv sync) ..."
# 如需国内镜像加速：UV_DEFAULT_INDEX=https://pypi.tuna.tsinghua.edu.cn/simple ./run_mac.sh
uv sync

echo ""
echo "[2/3] 准备 boxes 资源（作品照片 + 中文翻译，首次需联网）..."
uv run python scripts/fetch_boxes_assets.py

echo ""
echo "[3/3] 启动客户端 ..."
uv run python app.py
