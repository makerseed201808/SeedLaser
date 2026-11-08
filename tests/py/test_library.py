"""图库内置件（web/library/builtin.json）：30 个、id 不重复、路径闭合、外框尺寸和名字里写的一致、出处齐全。
运行：.venv/bin/python tests/py/test_library.py"""
import json
import os
import subprocess
import sys

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
PATH = os.path.join(ROOT, 'web', 'library', 'builtin.json')


def bez(p0, c0, c1, p1, n=24):
    for i in range(n + 1):
        t = i / n
        u = 1 - t
        yield (u ** 3 * p0[0] + 3 * u * u * t * c0[0] + 3 * u * t * t * c1[0] + t ** 3 * p1[0],
               u ** 3 * p0[1] + 3 * u * u * t * c0[1] + 3 * u * t * t * c1[1] + t ** 3 * p1[1])


def pts(path):
    s = path['segs']
    n = len(s) if path['closed'] else len(s) - 1
    for i in range(n):
        a, b = s[i], s[(i + 1) % len(s)]
        yield from bez((a[0], a[1]), (a[0] + a[4], a[1] + a[5]), (b[0] + b[2], b[1] + b[3]), (b[0], b[1]))


def bbox(items, mode=None):
    xs, ys = [], []
    for it in items:
        if mode and it['mode'] != mode:
            continue
        for p in it['paths']:
            for x, y in pts(p):
                xs.append(x); ys.append(y)
    return round(max(xs) - min(xs), 2), round(max(ys) - min(ys), 2), round((max(xs) + min(xs)) / 2, 2), round((max(ys) + min(ys)) / 2, 2)


def main():
    # 生成脚本和提交的 json 一致
    before = open(PATH, encoding='utf-8').read()
    subprocess.run([sys.executable, os.path.join(ROOT, 'scripts', 'make_library.py')], check=True, capture_output=True)
    assert open(PATH, encoding='utf-8').read() == before, 'builtin.json 和 scripts/make_library.py 不一致：重新运行生成脚本'

    lib = json.load(open(PATH, encoding='utf-8'))['items']
    assert len(lib) == 30, len(lib)
    assert len({x['id'] for x in lib}) == 30
    by = {x['id']: x for x in lib}
    for x in lib:
        assert x['name'] and x['cat'] and x['source'], x['id']
        assert x['verified'] or '未用卡尺核对' in x['source'], ('没核对的要写明', x['id'])
        for it in x['items']:
            assert it['mode'] in ('cut', 'engrave', 'score'), x['id']
            for p in it['paths']:
                assert p['closed'] and len(p['segs']) >= 3, x['id']
        w, h, cx, cy = bbox(x['items'])
        assert abs(cx) < 0.05 and abs(cy) < 0.05, ('以 (0,0) 为中心', x['id'], cx, cy)

    def size(i, mode=None):
        return bbox(by[i]['items'], mode)[:2]
    for i, d in (('hole-m3', 3.4), ('hole-m4', 4.5), ('hole-m5', 5.5), ('cbore-m3', 6.5), ('shaft-8', 8), ('led-5', 5), ('btn-12', 12)):
        assert size(i) == (d, d), (i, size(i))
    assert size('board-uno', 'score') == (68.58, 53.34), size('board-uno', 'score')
    assert size('board-microbit') == (51.6, 42.0)
    assert size('handle') == (80, 25)
    assert size('rounded-plate') == (60, 40)
    assert size('usb-c') == (9.5, 3.8)
    assert size('vent') == (28, 22), size('vent')
    assert size('keyhole') == (8, 16), size('keyhole')
    assert len(by['vent']['items']) == 20
    assert len(by['board-uno']['items']) == 5
    print('PASS test_library：30 个内置件，闭合、居中、尺寸和名字一致、出处齐全（未核对的已标注）')


if __name__ == '__main__':
    main()
