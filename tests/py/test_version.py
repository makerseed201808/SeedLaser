"""版本号一致 + 双击项目文件打开。运行：.venv/bin/python tests/py/test_version.py"""
import os, re, sys, tempfile
ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
sys.path.insert(0, ROOT)
import backend  # noqa: E402
from version import __version__  # noqa: E402

py = re.search(r'^version = "([^"]+)"', open(os.path.join(ROOT, 'pyproject.toml'), encoding='utf-8').read(), re.M).group(1)
assert py == __version__, f'pyproject.toml（{py}）和 version.py（{__version__}）的版本号不一致'
cl = open(os.path.join(ROOT, 'CHANGELOG.md'), encoding='utf-8').read()
assert f'## v{__version__} — ' in cl, f'CHANGELOG.md 里没有「## v{__version__} — 日期」这一节（GitHub 自动发版要用）'
lock = open(os.path.join(ROOT, 'uv.lock'), encoding='utf-8').read()
assert f'name = "seedboxes"\nversion = "{__version__}"' in lock, 'uv.lock 里的版本号没更新'

tmp = tempfile.mkdtemp()
f = os.path.join(tmp, '笔筒.seedlaser'); open(f, 'w').write('{}')
old = os.path.join(tmp, '旧.seedbox.json'); open(old, 'w').write('{}')
assert backend.launch_file_from_argv(['SeedLaser', '-psn_0_123', f]) == os.path.abspath(f)
assert backend.launch_file_from_argv(['SeedLaser', old]) == os.path.abspath(old)
assert backend.launch_file_from_argv(['SeedLaser', os.path.join(tmp, '不存在.seedlaser'), 'x.txt']) is None
api = backend.Api()
api.set_launch_file(f)
assert api.launch_file() == {'path': f} and api.launch_file() == {'path': None}, '只取一次'
print(f'PASS test_version：版本 {__version__}（pyproject / version.py / uv.lock / CHANGELOG 一致）；双击项目文件启动时带进来的路径能取到、只取一次')
