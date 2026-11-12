"""自动推送脚本（scripts/autopush.sh）。运行：.venv/bin/python tests/py/test_autopush.py
用本机的临时仓库当「GitHub」（file:// 远程），不联网、不碰真正的仓库。检查：
  1) 有新提交 / 新标签 → 推上去；2) 没有新东西 → 什么都不做；
  3) 上一次运行被强制结束留下的锁（超过 10 分钟）→ 清掉并照常推送（以前：之后每次都悄悄退出，再也不推，也不留日志）；
  4) 另一次运行正在进行（锁是新的）→ 这次让开，不动锁；5) 远程有本地没有的提交 → 不推（避免覆盖），退出码非 0。
macOS 的通知（osascript）在别的系统上没有，脚本里本来就忽略失败。"""
import os
import shutil
import subprocess
import sys
import tempfile
import time

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCRIPT = os.path.join(ROOT, os.environ.get('SEEDLASER_AUTOPUSH_SCRIPT') or os.path.join('scripts', 'autopush.sh'))
if not shutil.which('bash') or not shutil.which('git'):
    print('SKIP test_autopush：没有 bash / git，未验证')
    sys.exit(0)

tmp = tempfile.mkdtemp(prefix='seedlaser-autopush-')
remote, work, other, lock = (os.path.join(tmp, n) for n in ('remote.git', 'work', 'other', 'lock'))
ENV = {**os.environ, 'GIT_AUTHOR_NAME': 't', 'GIT_AUTHOR_EMAIL': 't@example.com', 'GIT_COMMITTER_NAME': 't', 'GIT_COMMITTER_EMAIL': 't@example.com',
       'SEEDLASER_AUTOPUSH_LOCK': lock, 'SEEDLASER_AUTOPUSH_WAIT': '0'}


def git(cwd, *a):
    return subprocess.run(['git', *a], cwd=cwd, env=ENV, capture_output=True, text=True, check=True).stdout.strip()


def commit(cwd, name):
    open(os.path.join(cwd, name), 'w').write(name)
    git(cwd, 'add', '-A')
    git(cwd, 'commit', '-q', '-m', name)
    return git(cwd, 'rev-parse', 'HEAD')


def run():
    r = subprocess.run(['bash', SCRIPT, work], env=ENV, capture_output=True, text=True, timeout=120)
    return r.returncode, r.stdout + r.stderr


def remote_main():
    try:
        return git(remote, 'rev-parse', 'refs/heads/main')
    except subprocess.CalledProcessError:
        return None


subprocess.run(['git', 'init', '-q', '--bare', remote], check=True)
subprocess.run(['git', 'init', '-q', '-b', 'feat/x', work], check=True)
git(work, 'remote', 'add', 'seedlaser', 'file://' + remote)

# 1) 新提交 + 新标签 → 推到远程的 main
h1 = commit(work, 'a.txt')
git(work, 'tag', 'v0.0.1')
code, out = run()
assert code == 0 and remote_main() == h1 and '已推送' in out, (code, out)
assert git(remote, 'tag') == 'v0.0.1', git(remote, 'tag')
assert not os.path.exists(lock), '运行结束后锁要删掉'

# 2) 没有新东西 → 什么都不做、不报错
code, out = run()
assert code == 0 and out.strip() == '' and remote_main() == h1, (code, out)

# 3) 残留的锁（上一次运行被强制结束）→ 清掉、照常推送
h2 = commit(work, 'b.txt')
os.mkdir(lock)
old = time.time() - 20 * 60
os.utime(lock, (old, old))
code, out = run()
assert code == 0 and remote_main() == h2, ('残留的锁挡住了推送', code, out, remote_main(), h2)
assert '残留' in out and not os.path.exists(lock), out

# 4) 另一次运行正在进行（锁是刚建的）→ 让开，不推、不动锁
h3 = commit(work, 'c.txt')
os.mkdir(lock)
code, out = run()
assert code == 0 and remote_main() == h2 and os.path.isdir(lock), (code, out)
os.rmdir(lock)
code, out = run()
assert code == 0 and remote_main() == h3, (code, out)

# 5) 远程有本地没有的提交 → 不推，退出码非 0，日志里说明
subprocess.run(['git', 'clone', '-q', '-b', 'main', 'file://' + remote, other], check=True, env=ENV)
h_other = commit(other, 'z.txt')
git(other, 'push', '-q', 'origin', 'HEAD:main')
commit(work, 'd.txt')
code, out = run()
assert code != 0 and remote_main() == h_other and '没有自动推送' in out, (code, out)
assert not os.path.exists(lock)

shutil.rmtree(tmp, ignore_errors=True)
print('PASS test_autopush：新提交 / 新标签推到 main；没有新东西不动；残留的锁会清掉并照常推送；正在运行时让开；远程有别的提交时不覆盖')
