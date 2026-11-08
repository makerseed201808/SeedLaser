"""标题直接输入名字保存（save_project_named）。运行：.venv/bin/python tests/py/test_named.py"""
import json, os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
import backend  # noqa: E402

tmp = tempfile.mkdtemp()
backend._recent_file = lambda: os.path.join(tmp, '.seedlaser', 'recent.json')
os.environ['SEEDLASER_PROJECT_DIR'] = os.path.join(tmp, 'SeedLaser')
api = backend.Api()
proj = {'app': 'SeedLaser', 'version': 1, 'generator': 'FreeDesign', 'free': {'parts': [{'id': 'p1'}]}}

r = api.save_project_named(proj, '小船')
p1 = os.path.join(tmp, 'SeedLaser', '小船.seedbox.json')
assert r['path'] == p1 and os.path.exists(p1), r
assert api.save_project_named(proj, ' / : ')['error']
r = api.save_project_named(proj, '小船')                      # 没有当前文件 + 同名 → 不覆盖
assert r.get('exists'), r
r = api.save_project_named(proj, '小船', p1)                  # 同一个文件：直接保存
assert r['path'] == p1 and not r['renamed'], r
r = api.save_project_named(proj, '帆船.seedbox.json', p1)     # 改名：旧文件删掉
p2 = os.path.join(tmp, 'SeedLaser', '帆船.seedbox.json')
assert r['path'] == p2 and r['renamed'] and os.path.exists(p2) and not os.path.exists(p1), r
assert [x['path'] for x in api.recent_projects()] == [p2], api.recent_projects()
assert json.load(open(p2, encoding='utf-8'))['free']['parts'][0]['id'] == 'p1'
print('PASS test_named：首次保存到项目文件夹、非法名字、同名不覆盖、原地保存、改名删旧文件、最近项目更新')
