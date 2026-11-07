#!/bin/bash
# 双击运行：把 SeedLaser 推到 GitHub（makerseed201808/SeedLaser）
# 第一次会：检查 GitHub CLI → 浏览器登录 → 创建公开仓库 → 推送；以后每天收工双击一次就是推送最新提交和版本标签。
cd "$(dirname "$0")/.." || exit 1
REPO="makerseed201808/SeedLaser"
URL="https://github.com/$REPO.git"
BRANCH="$(git branch --show-current)"

pause() { echo; read -r -p "按回车键关闭窗口…" _; }

echo "== SeedLaser → GitHub ($REPO) =="
if ! command -v gh >/dev/null 2>&1; then
  if command -v brew >/dev/null 2>&1; then
    echo "正在安装 GitHub CLI（gh）…"
    brew install gh || { echo "安装失败，请手动安装：https://cli.github.com"; pause; exit 1; }
  else
    echo "没有找到 GitHub CLI（gh）。请先从 https://cli.github.com 下载安装（macOS 安装包），装好后再双击本脚本。"
    pause; exit 1
  fi
fi

if ! gh auth status -h github.com >/dev/null 2>&1; then
  echo "第一次使用：会打开浏览器登录 GitHub（用 makerseed201808 这个账号）。"
  gh auth login -h github.com -p https --web || { pause; exit 1; }
fi
gh auth setup-git -h github.com >/dev/null 2>&1

if ! gh repo view "$REPO" >/dev/null 2>&1; then
  echo "创建公开仓库 $REPO …"
  gh repo create "$REPO" --public \
    --description "面向 K12 的激光切割设计软件：二维设计 → 3D 装配 → 加工作业（原名 SeedBoxes，快速建模基于 Boxes.py）" \
    || { pause; exit 1; }
fi

if git remote get-url seedlaser >/dev/null 2>&1; then
  git remote set-url seedlaser "$URL"
else
  git remote add seedlaser "$URL"
fi

echo "推送 $BRANCH → main，以及所有版本标签…"
git push -u seedlaser "$BRANCH:main" && git push seedlaser --tags \
  && echo && echo "✅ 完成：https://github.com/$REPO" \
  || echo "❌ 推送失败，请把上面的报错发给 Claude"
pause
