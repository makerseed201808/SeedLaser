#!/usr/bin/env bash
# 从上游源码重新构建 3D 编辑器（SketchForge-3D 改版）→ ../web_sketchforge/
# 需要：git、Node.js 20+（npm）。用法：bash sketchforge/build.sh
set -euo pipefail
UPSTREAM=https://github.com/Formsmith746/SketchForge-3D.git
COMMIT=e9cb8e8
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/../web_sketchforge"
WORK="${SKETCHFORGE_WORKDIR:-$HERE/.build}"

if [ ! -d "$WORK/.git" ]; then git clone "$UPSTREAM" "$WORK"; fi
cd "$WORK"
git fetch -q origin || true
git checkout -q -f "$COMMIT"
git clean -fdq apps/web/public
git apply "$HERE/seedboxes.patch"
npm ci
npm run copy:occt
# 静态导出不支持 API 路由（编辑器在桌面端不需要它们），构建时临时移走
mv apps/web/src/app/api "$WORK/../_sf_api_aside"
trap 'mv "$WORK/../_sf_api_aside" "$WORK/apps/web/src/app/api" 2>/dev/null || true' EXIT
STATIC_EXPORT=true NEXT_TELEMETRY_DISABLED=1 npx next build apps/web

rm -rf "$OUT"
cp -R apps/web/.next-export "$OUT"
rm -rf "$OUT/assets/occt"          # 重复的 OpenCascade（实际加载 /occt/）
cp LICENSE "$OUT/LICENSE.SketchForge.txt"
echo "完成：$OUT"
