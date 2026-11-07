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
print('PASS test_recent：旧项目可打开、最近项目去重排序、不存在的文件自动移除')
