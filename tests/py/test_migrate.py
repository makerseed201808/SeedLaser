"""项目文件版本迁移（A1）。运行：.venv/bin/python tests/py/test_migrate.py
样本在 tests/fixtures/projects/：SeedBoxes 时期（无 version）、只有快速建模参数、v0.2.0 自由设计（5 块板 + 孔 + 雕刻 + 板外描线）。
检查：都能打开；升到当前版本；板件 / 图形 / 装配姿态数量和原文件一致；打开再保存再打开，内容不变；迁移幂等；更新版本的文件给提示。"""
import copy, json, os, shutil, sys, tempfile
ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
sys.path.insert(0, ROOT)
import backend  # noqa: E402

FIX = os.path.join(ROOT, 'tests', 'fixtures', 'projects')
tmp = tempfile.mkdtemp()
backend._recent_file = lambda: os.path.join(tmp, '.seedlaser', 'recent.json')
api = backend.Api()


def counts(p):
    sk = p.get('sketches') or {}
    free = p.get('free') or {}
    return {'parts': len(free.get('parts') or []), 'poses': len(p.get('poses') or {}),
            'items': sum(len(v.get('items') or []) for v in sk.values()), 'loose': len(free.get('loose') or []),
            'params': len(p.get('params') or {}), 'generator': p.get('generator')}


names = sorted(f for f in os.listdir(FIX) if f.endswith('.json'))
assert len(names) >= 3, names
for name in names:
    src = os.path.join(FIX, name)
    raw = json.load(open(src, encoding='utf-8'))
    path = os.path.join(tmp, name)
    shutil.copy(src, path)
    r = api.open_project_path(path)
    assert 'project' in r, (name, r)
    p = r['project']
    assert p['version'] == backend.PROJECT_VERSION and p['app'] == 'SeedLaser', (name, p.get('version'), p.get('app'))
    assert counts(p) == counts(raw), (name, counts(p), counts(raw))
    for k in ('params', 'disabled', 'edits', 'poses', 'sketches'):
        assert k in p, (name, k)
    if p['generator'] == 'FreeDesign':
        assert p['free']['sheet']['w'] > 0 and isinstance(p['free']['loose'], list)
    assert json.load(open(path, encoding='utf-8')) == raw, '打开时不能改原文件'
    # 迁移幂等
    again, notes = backend._migrate_project(p)
    assert again == p and not notes, name
    # 打开 → 保存 → 再打开：内容不变
    r2 = api.save_project(p, os.path.join(tmp, 're_' + name))
    assert r2.get('path'), r2
    p2 = api.open_project_path(r2['path'])['project']
    assert p2 == p, name

# 只有 SeedBoxes 时期的文件标「从版本 1 升级」
r = api.open_project_path(os.path.join(tmp, 'seedboxes_era.seedbox.json'))
assert r.get('migrated_from') == 1, r.get('migrated_from')
# 更新版本的文件：能打开，给提示
fut = os.path.join(tmp, 'future.seedbox.json')
d = copy.deepcopy(json.load(open(os.path.join(FIX, 'quick_params_only.seedbox.json'), encoding='utf-8')))
d['version'] = 99
json.dump(d, open(fut, 'w', encoding='utf-8'))
r = api.open_project_path(fut)
assert 'project' in r and '更新版本' in r.get('warning', ''), r
# 不是项目文件 / 坏文件
bad = os.path.join(tmp, 'bad.json')
json.dump({'hello': 1}, open(bad, 'w'))
assert '不是' in api.open_project_path(bad)['error']
open(bad, 'w').write('{oops')
assert '无法读取' in api.open_project_path(bad)['error']
print(f'PASS test_migrate：{len(names)} 个旧作品样本都能打开并升到版本 {backend.PROJECT_VERSION}，数量一致、原文件不改、迁移幂等、保存再打开不变；新版本文件给提示；坏文件报错')
