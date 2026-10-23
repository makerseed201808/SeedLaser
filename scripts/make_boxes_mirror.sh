#!/usr/bin/env bash
# 在能访问 GitHub 的电脑上运行，生成 boxes 本地镜像 third_party/boxes.git（约 30 MB）。
# 把整个 SeedBoxes 文件夹（含 third_party/）拷到连不上 GitHub 的电脑，
# run_mac.sh / build_mac.sh 会自动改用这个镜像安装 boxes。
set -euo pipefail
cd "$(dirname "$0")/.."

COMMIT=$(grep -oE 'florianfesti/boxes\?rev=[^#"]+#[0-9a-f]{40}' uv.lock | head -1 | sed 's/.*#//')
REV=$(grep -oE 'florianfesti/boxes\?rev=[^#"]+' uv.lock | head -1 | sed 's/.*rev=//')
[[ -n "$COMMIT" ]] || { echo "[X] uv.lock 中找不到 boxes 的 commit"; exit 1; }

echo "[*] 镜像 boxes $REV ($COMMIT)"
rm -rf third_party/boxes.git
mkdir -p third_party
git clone --bare --depth 1 --branch "$REV" https://github.com/florianfesti/boxes third_party/boxes.git
git --git-dir third_party/boxes.git config uploadpack.allowAnySHA1InWant true
[[ "$(git --git-dir third_party/boxes.git rev-parse HEAD)" == "$COMMIT" ]] \
    || { echo "[X] 镜像 commit 与 uv.lock 不一致（$REV 标签被移动了？）"; exit 1; }
echo "[OK] third_party/boxes.git 已就绪"
