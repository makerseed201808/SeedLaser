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
p1 = os.path.join(tmp, 'SeedLaser', '小船.seedlaser')
assert r['path'] == p1 and os.path.exists(p1), r
assert api.save_project_named(proj, ' / : ')['error']
r = api.save_project_named(proj, '小船')                      # 没有当前文件 + 同名 → 不覆盖
assert r.get('exists'), r
r = api.save_project_named(proj, '小船', p1)                  # 同一个文件：直接保存
assert r['path'] == p1 and not r['renamed'], r
r = api.save_project_named(proj, '帆船.seedbox.json', p1)     # 改名（输入里带旧扩展名也行）：旧文件删掉
p2 = os.path.join(tmp, 'SeedLaser', '帆船.seedlaser')
assert r['path'] == p2 and r['renamed'] and os.path.exists(p2) and not os.path.exists(p1), r
assert [x['path'] for x in api.recent_projects()] == [p2], api.recent_projects()
assert json.load(open(p2, encoding='utf-8'))['free']['parts'][0]['id'] == 'p1'
assert api.recent_projects()[0]['name'] == '帆船'

# 另存为：对话框默认在项目文件夹、文件名 .seedlaser；对话框里留着 .json 也换成 .seedlaser
picked = os.path.join(tmp, 'other', '台灯.json')
os.makedirs(os.path.dirname(picked))
api.dev_set_pick(picked)
r = api.save_project(proj)
assert r['path'] == os.path.join(tmp, 'other', '台灯.seedlaser') and os.path.exists(r['path']), r
# 旧版 .seedbox.json：能打开；「保存」写回原文件，不改名
old = os.path.join(tmp, 'other', '旧作品.seedbox.json')
json.dump(proj, open(old, 'w', encoding='utf-8'))
assert api.open_project_path(old).get('project'), api.open_project_path(old)
assert api.save_project(proj, old)['path'] == old
assert api.recent_projects()[0]['name'] == '旧作品'
assert backend.project_stem('a.b.seedlaser') == 'a.b' and backend.project_stem('x.SEEDBOX.JSON') == 'x'
print('PASS test_named：首次保存到项目文件夹（.seedlaser）、非法名字、同名不覆盖、原地保存、改名删旧文件、最近项目更新；另存为换成 .seedlaser；旧版 .seedbox.json 能打开、原地保存')
