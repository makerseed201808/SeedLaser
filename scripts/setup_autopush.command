#!/bin/bash
# 双击运行一次：安装 SeedLaser 自动推送。
# 装好后，仓库有新提交 / 新版本标签，Mac 会在后台自动推到 GitHub（makerseed201808/SeedLaser），并弹通知。
# 卸载：launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.makerseed.seedlaser.autopush.plist
cd "$(dirname "$0")/.." || exit 1
REPO="$(pwd)"
LABEL="com.makerseed.seedlaser.autopush"
DIR="$HOME/Library/Application Support/SeedLaser"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG="$HOME/Library/Logs/SeedLaser-autopush.log"
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
pause() { echo; read -r -p "按回车键关闭窗口…" _; }

echo "== 安装 SeedLaser 自动推送 =="
if ! command -v gh >/dev/null 2>&1 || ! gh auth status -h github.com >/dev/null 2>&1; then
  echo "需要先登录 GitHub：请先双击 scripts/push_github.command 完成一次推送，再运行本脚本。"
  pause; exit 1
fi
gh auth setup-git -h github.com >/dev/null 2>&1
git remote get-url seedlaser >/dev/null 2>&1 || git remote add seedlaser https://github.com/makerseed201808/SeedLaser.git

mkdir -p "$DIR" "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
cp scripts/autopush.sh "$DIR/autopush.sh" && chmod +x "$DIR/autopush.sh"

cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/bash</string><string>$DIR/autopush.sh</string><string>$REPO</string></array>
  <key>WatchPaths</key>
  <array><string>$REPO/.git/logs/HEAD</string><string>$REPO/.git/refs/tags</string></array>
  <key>StartInterval</key><integer>1800</integer>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>20</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$(id -u)" "$PLIST" 2>/dev/null
launchctl bootstrap "gui/$(id -u)" "$PLIST" || { echo "❌ 安装失败"; pause; exit 1; }
echo "已安装。正在做第一次检查（约 15 秒）…"
echo "如果 macOS 弹出「bash 想访问『桌面』文件夹」，请点「允许」。"
sleep 15
echo "---- 最近的日志 ----"
tail -n 5 "$LOG" 2>/dev/null || echo "（还没有日志：说明没有需要推送的内容）"
if tail -n 3 "$LOG" 2>/dev/null | grep -q "进不了仓库文件夹"; then
  echo
  echo "⚠ macOS 不让后台程序访问「桌面」。请打开：系统设置 → 隐私与安全性 → 完全磁盘访问权限，"
  echo "  点「+」，按 ⌘⇧G 输入 /bin/bash 添加并打开开关，然后再双击本脚本一次。"
fi
pause
