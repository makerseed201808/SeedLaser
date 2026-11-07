#!/bin/bash
# SeedLaser 自动推送（由 macOS 的 launchd 在后台运行，不需要手动执行）
# 仓库有新提交或新标签时触发：把当前分支推到 GitHub 的 main，并推送所有版本标签。
# 日志：~/Library/Logs/SeedLaser-autopush.log
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
REPO="$1"
log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*"; }
notify() { osascript -e "display notification \"$1\" with title \"SeedLaser\"" >/dev/null 2>&1; }

cd "$REPO" 2>/dev/null || { log "❌ 进不了仓库文件夹 $REPO（多半是 macOS 隐私权限：需要允许 bash 访问「桌面」文件夹）"; exit 1; }

# 同一时间只跑一个；等几秒让提交 / 打标签写完
LOCK="/tmp/seedlaser-autopush.lock"
mkdir "$LOCK" 2>/dev/null || exit 0
trap 'rmdir "$LOCK" 2>/dev/null' EXIT
sleep 5

BR="$(git branch --show-current)"
[ -n "$BR" ] || exit 0
git remote get-url seedlaser >/dev/null 2>&1 || { log "没有 seedlaser 远程，跳过"; exit 0; }
[ -e .git/index.lock ] && exit 0          # 正在提交，下次再推

git fetch -q seedlaser 2>/dev/null
L="$(git rev-parse HEAD)"
R="$(git rev-parse -q --verify refs/remotes/seedlaser/main 2>/dev/null)"
pushed=""

if [ "$L" != "$R" ]; then
  if [ -z "$R" ] || git merge-base --is-ancestor "$R" "$L"; then
    if out="$(git push -q seedlaser "$BR:main" 2>&1)"; then
      pushed="提交 $(git log -1 --format=%h)"
    else
      log "❌ 推送分支失败：$out"; notify "推送到 GitHub 失败，详见日志"; exit 1
    fi
  else
    log "⚠ GitHub 上的 main 有本地没有的提交，没有自动推送（避免覆盖）。请让 Claude 处理。"
    notify "GitHub 上有本地没有的提交，暂停自动推送"
    exit 1
  fi
fi

missing="$(comm -23 <(git tag | sort) <(git ls-remote --tags seedlaser 2>/dev/null | sed -n 's#.*refs/tags/\([^^]*\)$#\1#p' | sort -u))"
if [ -n "$missing" ]; then
  if out="$(git push -q seedlaser --tags 2>&1)"; then
    pushed="${pushed:+$pushed，}标签 $(echo $missing)"
  else
    log "❌ 推送标签失败：$out"; notify "推送标签失败，详见日志"; exit 1
  fi
fi

if [ -n "$pushed" ]; then
  log "✅ 已推送：$pushed"
  notify "已推送到 GitHub：$pushed"
fi
