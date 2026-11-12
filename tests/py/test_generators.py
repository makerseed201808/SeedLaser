"""快速建模的模型清单：每个模型只出现一次，界面和说明里写的数量和实际一致。运行：.venv/bin/python tests/py/test_generators.py

背景（2026-11-12 检查发现）：Boxes.py 的 getAllBoxGenerators() 按「模块路径.类名」返回，一个生成器模块 import 了另一个生成器的类时，
同一个类会出现好几次（比如 BayonetBox 出现在 bayonetbox / filamentspool / regularbox 三个模块下）。上游的网页服务先按类名去重再分组；
这里以前没去重，模型库里 8 个模型重复出现（共多出 9 条），底部显示「共 172 个生成器」，实际是 163 个。"""
import collections
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
sys.path.insert(0, ROOT)
import backend  # noqa: E402

api = backend.Api()
groups = api.list_groups()
names = [e['name'] for g in groups for e in g['generators']]
dup = {k: v for k, v in collections.Counter(names).items() if v > 1}
assert not dup, ('模型清单里有重复的模型', dup)
assert 'FreeDesign' not in names, '自由设计不进模型库'
assert set(names) == set(backend._GENERATORS) - {'FreeDesign'}, set(names) ^ (set(backend._GENERATORS) - {'FreeDesign'})
assert not backend._FAILED_GENERATORS, backend._FAILED_GENERATORS
assert [e['name'] for g in api.list_groups() for e in g['generators']] == names, '再取一次清单不变'
for g in groups:
    assert g['title'] and (not g['generators'] or g['thumbnail']), g['name']

# 主页、README 里写的「N 多个」要和实际数量对得上（N ≤ 实际 < N + 10）
n = len(names)
for rel, pat in (('web/index.html', r'从 (\d+) 多个盒子'), ('README.md', r'(\d+) 多个')):
    text = open(os.path.join(ROOT, rel), encoding='utf-8').read()
    found = [int(x) for x in re.findall(pat, text)]
    assert found, (rel, '没找到写数量的地方')
    for v in found:
        assert v <= n < v + 10, (rel, f'写的是「{v} 多个」，实际 {n} 个')
print(f'PASS test_generators：模型库 {n} 个模型、{len(groups)} 组，没有重复；主页和 README 写的数量和实际一致')
