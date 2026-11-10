"""界面偏好存到用户目录（localStorage 每次启动会被清空）。运行：.venv/bin/python tests/py/test_prefs.py"""
import json, os, sys, tempfile
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
import backend  # noqa: E402

tmp = tempfile.mkdtemp()
f = os.path.join(tmp, 'sub', 'prefs.json')
os.environ['SEEDLASER_PREFS_FILE'] = f
api = backend.Api()
assert api.get_prefs() == {}, '没有文件时是空的'
assert api.set_pref('seedboxes.skTour', '1') == {'ok': True}
assert api.set_pref('seedlaser.exportBurn', 'nominal')['ok']
assert api.get_prefs() == {'seedboxes.skTour': '1', 'seedlaser.exportBurn': 'nominal'}
assert json.load(open(f, encoding='utf-8'))['seedboxes.skTour'] == '1', '写到文件里'
assert api.set_pref('seedboxes.skTour', None)['ok'] and 'seedboxes.skTour' not in api.get_prefs(), 'None = 删除'
for bad in ('other.key', 'seedboxes.', '../x', 'seedboxes.a b'):
    assert not api.set_pref(bad, 'x')['ok'], ('不认识的键不存', bad)
assert not api.set_pref('seedboxes.big', 'x' * 20001)['ok'], '太大的值不存'
open(f, 'w').write('{坏掉的 json')
assert api.get_prefs() == {}, '文件坏了也不报错'
blocker = os.path.join(tmp, 'afile'); open(blocker, 'w').write('x')
os.environ['SEEDLASER_PREFS_FILE'] = os.path.join(blocker, 'sub', 'prefs.json')      # 上级路径是个文件：建不了目录、写不进去
assert api.set_pref('seedboxes.skTour', '1') == {'ok': False} and api.get_prefs() == {}, '写不进去时不报错，只是记不住'
del os.environ['SEEDLASER_PREFS_FILE']
os.environ['SEEDLASER_PROJECT_DIR'] = tmp
assert backend._prefs_file() is None and not api.set_pref('seedboxes.skTour', '1')['ok'], '测试 / 调试模式不碰用户的偏好'
print('PASS test_prefs：偏好存取 / 删除、只认 seedboxes.* / seedlaser.*、坏文件不报错、写不进去不报错、测试模式不读写')
