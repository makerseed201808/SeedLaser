"""自动推送安装脚本（scripts/setup_autopush.command）。运行：.venv/bin/python tests/py/test_setup_autopush.py
macOS 的 launchctl 在这里没有，用一个假的 launchctl 模拟它的几种行为（不碰真正的系统）：
  - bootout 是异步的：命令返回后旧的服务还要过一会儿才真正退出，这期间 bootstrap 报「Bootstrap failed: 5: Input/output error」；
  - 服务被停用（disabled）时 bootstrap 也报 5，要先 launchctl enable。
2026-11-12 用户双击安装脚本得到的正是「Bootstrap failed: 5: Input/output error」「❌ 安装失败」。检查：
  1) 第一次安装 → 成功；2) 已经装过、重新安装 → 成功（以前：bootout 后马上 bootstrap，报 5）；
  3) 服务被停用过 → 成功（以前报 5）；4) 怎么都装不上 → 退出码 1，屏幕上和 .git/seedlaser-autopush-setup.txt 里有诊断信息。"""
import os
import shutil
import stat
import subprocess
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPT = os.path.join(ROOT, os.environ.get('SEEDLASER_SETUP_SCRIPT') or os.path.join('scripts', 'setup_autopush.command'))
if not shutil.which('bash') or not shutil.which('git'):
    print('SKIP test_setup_autopush：没有 bash / git，未验证')
    sys.exit(0)

LABEL = 'com.makerseed.seedlaser.autopush'

FAKE_LAUNCHCTL = r'''#!/bin/bash
# 假的 launchctl：状态存在 $FAKE_LAUNCHD 目录里
S="$FAKE_LAUNCHD"; echo "$*" >> "$S/calls"
# bootout 之后，旧服务还要再过几次调用才真正退出（模拟异步）
if [ -f "$S/unloading" ]; then
  n=$(cat "$S/unloading"); n=$((n-1))
  if [ "$n" -le 0 ]; then rm -f "$S/unloading" "$S/loaded"; else echo "$n" > "$S/unloading"; fi
fi
case "$1" in
  bootout) if [ -f "$S/loaded" ]; then [ -f "$S/unloading" ] || echo 3 > "$S/unloading"; exit 0; fi
           echo "Boot-out failed: 3: No such process" >&2; exit 3 ;;
  print) [ -f "$S/loaded" ] && { echo "$2 = { state = running }"; exit 0; }
         echo "Could not find service \"$2\"" >&2; exit 113 ;;
  print-disabled) echo "disabled services = {"; [ -f "$S/disabled" ] && echo "	\"com.makerseed.seedlaser.autopush\" => disabled"; echo "}"; exit 0 ;;
  enable) rm -f "$S/disabled"; exit 0 ;;
  disable) touch "$S/disabled"; exit 0 ;;
  bootstrap|load)
    if [ "$1" = load ] && [ "$2" = -w ]; then rm -f "$S/disabled"; fi
    if [ -f "$S/always_fail" ] || [ -f "$S/disabled" ] || [ -f "$S/loaded" ]; then
      echo "Bootstrap failed: 5: Input/output error" >&2; echo "Try re-running the command as root for richer errors." >&2; exit 5
    fi
    touch "$S/loaded"; echo x >> "$S/bootstrapped"; exit 0 ;;
  kickstart) exit 0 ;;
esac
exit 0
'''
FAKE_GH = '#!/bin/bash\nexit 0\n'
FAKE_SLEEP = '#!/bin/bash\nexit 0\n'


def write_exec(path, text):
    with open(path, 'w') as f:
        f.write(text)
    os.chmod(path, os.stat(path).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


tmp = tempfile.mkdtemp(prefix='seedlaser-setup-')
home, repo, fake, state = (os.path.join(tmp, n) for n in ('home', 'repo', 'bin', 'launchd'))
for d in (home, fake, state, os.path.join(repo, 'scripts')):
    os.makedirs(d)
write_exec(os.path.join(fake, 'launchctl'), FAKE_LAUNCHCTL)
write_exec(os.path.join(fake, 'gh'), FAKE_GH)
write_exec(os.path.join(fake, 'sleep'), FAKE_SLEEP)
shutil.copy(SCRIPT, os.path.join(repo, 'scripts', 'setup_autopush.command'))
shutil.copy(os.path.join(ROOT, 'scripts', 'autopush.sh'), os.path.join(repo, 'scripts', 'autopush.sh'))
subprocess.run(['git', 'init', '-q', repo], check=True)
ENV = {**os.environ, 'HOME': home, 'FAKE_LAUNCHD': state, 'PATH': fake + os.pathsep + os.environ.get('PATH', '')}
PLIST = os.path.join(home, 'Library', 'LaunchAgents', LABEL + '.plist')
DIAG = os.path.join(repo, '.git', 'seedlaser-autopush-setup.txt')


def run():
    r = subprocess.run(['bash', os.path.join(repo, 'scripts', 'setup_autopush.command')], env=ENV,
                       input='\n\n\n', capture_output=True, text=True, timeout=120)
    return r.returncode, r.stdout + r.stderr


def flag(name, on=True):
    p = os.path.join(state, name)
    if on:
        open(p, 'w').close()
    elif os.path.exists(p):
        os.remove(p)


def loaded():
    return os.path.exists(os.path.join(state, 'loaded'))


# 1) 第一次安装
code, out = run()
assert code == 0 and '已安装' in out and loaded() and os.path.exists(PLIST), (code, out)
assert '<string>' + os.path.realpath(repo) in open(PLIST).read() or '<string>' + repo in open(PLIST).read()
assert os.path.exists(os.path.join(home, 'Library', 'Application Support', 'SeedLaser', 'autopush.sh'))

# 2) 已经装过（服务正在运行）→ 重新安装：要等旧的退出再装
assert loaded()
code, out = run()
assert code == 0 and '已安装' in out and loaded(), ('重新安装失败（bootout 后马上 bootstrap 会报 5）', code, out)

# 3) 服务被停用过 → 先 enable 再装
flag('loaded', False)
flag('disabled')
code, out = run()
assert code == 0 and '已安装' in out and loaded(), ('停用过的服务装不上', code, out)

# 4) 怎么都装不上 → 失败，给出诊断（屏幕上 + .git 里的文件，方便远程查看）
flag('loaded', False)
flag('always_fail')
code, out = run()
assert code == 1 and '安装失败' in out, (code, out)
assert 'Input/output error' in out and '诊断' in out, out
assert os.path.exists(DIAG), '诊断信息要写进 .git/seedlaser-autopush-setup.txt'
diag = open(DIAG, encoding='utf-8').read()
assert 'Input/output error' in diag and LABEL in diag, diag
flag('always_fail', False)

# 5) 装好后诊断文件记的是成功
code, out = run()
assert code == 0, (code, out)
assert '已安装' in open(DIAG, encoding='utf-8').read()

shutil.rmtree(tmp, ignore_errors=True)
print('test_setup_autopush: OK（首次安装 / 重新安装 / 停用过 / 装不上时的诊断）')
