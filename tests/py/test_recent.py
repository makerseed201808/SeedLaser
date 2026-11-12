"""最近项目 + 打开旧（SeedBoxes 时期）项目。运行：.venv/bin/python tests/py/test_recent.py"""
import json, os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
import backend  # noqa: E402

tmp = tempfile.mkdtemp()
backend._recent_file = lambda: os.path.join(tmp, '.seedlaser', 'recent.json')
api = backend.Api()

old = os.path.join(tmp, '笔筒.seedbox.json')
json.dump({'app': 'SeedBoxes', 'version': 1, 'generator': 'FreeDesign', 'free': {'parts': [{'id': 'p1'}, {'id': 'p2'}]}}, open(old, 'w'))
r = api.open_project_path(old)
assert 'project' in r, r                                   # 旧项目能打开
rec = api.recent_projects()
assert rec[0]['name'] == '笔筒' and rec[0]['parts'] == 2 and rec[0]['exists'], rec

new = os.path.join(tmp, '名牌.seedbox.json')
json.dump({'app': 'SeedLaser', 'version': 1, 'generator': 'FreeDesign', 'free': {'parts': []}}, open(new, 'w'))
api.open_project_path(new)
api.open_project_path(old)                                  # 再开一次：移到最前，不重复
assert [x['name'] for x in api.recent_projects()] == ['笔筒', '名牌']

bad = os.path.join(tmp, 'x.json')
json.dump({'app': 'Other'}, open(bad, 'w'))
assert 'error' in api.open_project_path(bad)

os.remove(new)
r = api.open_project_path(new)
assert 'error' in r and '已从最近项目里去掉' in r['error']
assert [x['name'] for x in api.recent_projects()] == ['笔筒']
# 测试 / 调试模式（设了 SEEDLASER_PROJECT_DIR，比如 tests/e2e 的调试服务器）不能改用户真正的「最近项目」（~/.seedlaser/recent.json）：
# 以前跑一遍端到端测试，用户主页上的最近项目会被 12 个 /tmp 下的测试文件顶掉（2026-11-12 检查发现）
import subprocess
home, pd = tempfile.mkdtemp(), tempfile.mkdtemp()
code = ("import backend, json, os; api = backend.Api(); "
        "r = api.save_project({'app': 'SeedLaser', 'version': 2, 'generator': 'FreeDesign', 'free': {'parts': []}}, "
        "os.path.join(os.environ['SEEDLASER_PROJECT_DIR'], 't.seedlaser')); print(json.dumps([r, api.recent_projects()]))")
out = subprocess.run([sys.executable, '-c', code], cwd=os.path.join(os.path.dirname(__file__), '..', '..'), capture_output=True, text=True,
                     env={**os.environ, 'HOME': home, 'USERPROFILE': home, 'SEEDLASER_PROJECT_DIR': pd})
assert out.returncode == 0, out.stderr[-500:]
saved, rec = json.loads(out.stdout.strip().splitlines()[-1])
assert 'path' in saved and rec and rec[0]['name'] == 't', (saved, rec)             # 测试模式下最近项目照常能用
assert not os.path.exists(os.path.join(home, '.seedlaser', 'recent.json')), '测试模式写了用户目录里的最近项目'
print('PASS test_recent：旧项目可打开、最近项目去重排序、不存在的文件自动移除；测试模式不碰用户目录里的最近项目')
