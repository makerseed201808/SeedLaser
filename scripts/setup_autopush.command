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
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
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
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>20</integer>
  <key>StandardOutPath</key><string>$LOG</string>
  <key>StandardErrorPath</key><string>$LOG</string>
</dict>
</plist>
EOF

DOMAIN="gui/$(id -u)"
SVC="$DOMAIN/$LABEL"
DIAG="$REPO/.git/seedlaser-autopush-setup.txt"   # 安装结果另存一份在仓库的 .git 里，方便远程查看

# 卸掉旧的。launchctl bootout 是异步的：命令返回时旧服务可能还没退出，
# 这时马上 bootstrap 会报「Bootstrap failed: 5: Input/output error」——所以先等它真正退出（最多 10 秒）
launchctl bootout "$SVC" 2>/dev/null || launchctl bootout "$DOMAIN" "$PLIST" 2>/dev/null
for _ in $(seq 1 20); do launchctl print "$SVC" >/dev/null 2>&1 || break; sleep 0.5; done
# 服务以前被停用过（disabled）时 bootstrap 也报 5，先解除停用
launchctl enable "$SVC" 2>/dev/null

ok=""; err=""
for _ in 1 2 3; do
  if err="$(launchctl bootstrap "$DOMAIN" "$PLIST" 2>&1)"; then ok=1; break; fi
  sleep 2
done
# 退路：老的 load 命令
if [ -z "$ok" ] && launchctl load -w "$PLIST" >/dev/null 2>&1 && launchctl print "$SVC" >/dev/null 2>&1; then ok=1; fi

if [ -z "$ok" ]; then
  {
    echo "== SeedLaser 自动推送安装失败 $(date '+%Y-%m-%d %H:%M:%S') =="
    echo "服务：$SVC"
    echo "bootstrap 的报错：$err"
    echo "-- 配置文件检查 --"
    if command -v plutil >/dev/null 2>&1; then plutil -lint "$PLIST" 2>&1; else echo "（没有 plutil）"; fi
    ls -l "$PLIST" 2>&1
    echo "-- 是否被停用 --"
    launchctl print-disabled "$DOMAIN" 2>&1 | grep -F "$LABEL" || echo "（没有被停用的记录）"
    echo "-- 当前状态 --"
    launchctl print "$SVC" 2>&1 | head -n 15
    echo "-- 最近的日志 --"
    tail -n 20 "$LOG" 2>&1
  } > "$DIAG.new" 2>&1
  mv "$DIAG.new" "$DIAG" 2>/dev/null || DIAG="$DIAG.new"
  echo "❌ 安装失败"
  echo
  echo "---- 诊断信息（也存在 .git/seedlaser-autopush-setup.txt，Claude 能直接读到）----"
  cat "$DIAG"
  pause; exit 1
fi
echo "== SeedLaser 自动推送已安装 $(date '+%Y-%m-%d %H:%M:%S') ==" > "$DIAG.new" 2>/dev/null && mv "$DIAG.new" "$DIAG" 2>/dev/null
echo "已安装。正在做第一次检查（约 15 秒）…"
echo "如果 macOS 弹出「bash 想访问『桌面』文件夹」，请点「允许」。"
: > "$LOG.new" 2>/dev/null; tail -n 50 "$LOG" > "$LOG.new" 2>/dev/null; echo "---- $(date '+%Y-%m-%d %H:%M:%S') 重新安装 ----" >> "$LOG.new"; mv "$LOG.new" "$LOG"
sleep 15
echo "---- 最近的日志 ----"
tail -n 5 "$LOG" 2>/dev/null || echo "（还没有日志：说明没有需要推送的内容）"
{ echo "-- 最近的日志 --"; tail -n 20 "$LOG" 2>/dev/null; } >> "$DIAG" 2>/dev/null
if tail -n 3 "$LOG" 2>/dev/null | grep -qE "进不了仓库文件夹|Operation not permitted"; then
  echo
  echo "⚠ macOS 不让后台程序访问「桌面」。请打开：系统设置 → 隐私与安全性 → 完全磁盘访问权限，"
  echo "  点「+」，按 ⌘⇧G 输入 /bin/bash 添加并打开开关，然后再双击本脚本一次。"
fi
pause
