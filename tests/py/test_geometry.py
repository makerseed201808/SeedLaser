"""A3 几何边界情况（后端 sketch2d.py）：自相交、零长度段 / 重合节点、差一点闭合、细尖角、极小孔、曲线展平精度。
每种情况都要：不崩溃、不卡死、结果合理。
运行：.venv/bin/python tests/py/test_geometry.py
"""
import math
import os
import sys
import time

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
import sketch2d as S  # noqa: E402


def P(pts, closed=True, handles=None):
    segs = []
    for i, (x, y) in enumerate(pts):
        h = (handles or {}).get(i, (0, 0, 0, 0))
        segs.append([x, y, *h])
    return {'closed': closed, 'segs': segs}


def sk(*paths, mode='cut'):
    return {'items': [{'id': f'i{k}', 'mode': mode, 'paths': [p]} for k, p in enumerate(paths)]}


def board(*inner):
    return sk(P([(0, 0), (100, 0), (100, 100), (0, 100)]), *inner)


def timed(fn, limit=2.0):
    t = time.time()
    r = fn()
    dt = time.time() - t
    assert dt < limit, f'太慢：{dt:.2f}s'
    return r


done = []
failed = []


def case(name):
    def deco(fn):
        try:
            fn()
        except Exception as e:      # 收集全部失败再一起报
            failed.append(name)
            print('FAIL', name, '→', type(e).__name__, str(e)[:300])
            return fn
        done.append(name)
        print('ok', name)
        return fn
    return deco


# ------------------------------------------------------------------ 自相交

@case('蝴蝶结（自相交）当板：两个三角形都保留，面积 = 2 × 25')
def _():
    bow = sk(P([(0, 0), (10, 10), (10, 0), (0, 10)]))
    g = timed(lambda: S.cut_solid(bow))
    assert abs(g.area - 50) < 1e-6, g.area
    assert len(S.cut_polylines(bow, 0)) == 2                     # 不补偿：两个三角形
    polys = timed(lambda: S.cut_polylines(bow, 0.1))            # 补偿后两瓣在交点处连成一个轮廓
    xs = [x for pts, _, _ in polys for x, _ in pts]
    assert abs(min(xs) + 0.1) < 1e-3 and abs(max(xs) - 10.1) < 1e-3, polys
    assert S.geometry_3d(bow) is not None


@case('8 字形孔（自相交）在板里：两个洞都挖掉')
def _():
    eight = P([(20, 20), (40, 40), (40, 20), (20, 40)])
    g = timed(lambda: S.cut_solid(board(eight)))
    assert abs(g.area - (10000 - 200)) < 1e-6, g.area
    lines = S.cut_polylines(board(eight), 0.1)
    assert sum(1 for _, _, outer in lines if not outer) == 2, lines


@case('自相交路径的偏移不崩溃，两半都偏移')
def _():
    r = timed(lambda: S.offset([P([(0, 0), (10, 10), (10, 0), (0, 10)])], 1.0))
    assert r and all(len(x) >= 3 for x in r)
    from shapely.geometry import Polygon
    area = sum(Polygon(x).area for x in r)
    assert area > 50, area


# ------------------------------------------------------------------ 零长度段、重合节点

@case('零长度段 / 连续重合节点：面积不变、导出点列里没有重复点')
def _():
    sq = P([(0, 0), (0, 0), (100, 0), (100, 0), (100, 0), (100, 100), (0, 100), (0, 100)])
    g = timed(lambda: S.cut_solid(sk(sq)))
    assert abs(g.area - 10000) < 1e-6
    for pts, closed, _ in S.cut_polylines(sk(sq), 0):
        for a, b in zip(pts, pts[1:] + pts[:1]):
            assert math.dist(a, b) > 1e-6, pts


@case('只有重合节点的路径（退化成一个点 / 一条线）：忽略，不崩溃')
def _():
    dot = P([(5, 5), (5, 5), (5, 5)])
    line = P([(0, 0), (10, 0), (0, 0)])
    assert S.cut_solid(sk(dot)).is_empty
    assert S.cut_solid(sk(line)).is_empty
    assert S.geometry_3d(sk(dot, line)) is None
    assert S.cut_polylines(sk(dot, line), 0.1) == []
    S.offset([dot, line], 1.0)


# ------------------------------------------------------------------ 差一点闭合

@case('看起来闭合、实际没闭合（首尾差 0.001 mm）：当成闭合')
def _():
    almost = P([(0, 0), (100, 0), (100, 100), (0, 100), (0.001, 0)], closed=False)
    g = timed(lambda: S.cut_solid(sk(almost)))
    assert abs(g.area - 10000) < 0.5, g.area
    assert S.geometry_3d(sk(almost)) is not None


@case('首尾差得远（1 mm）的开放路径不会被自动闭合')
def _():
    gap = P([(0, 0), (100, 0), (100, 100), (0, 100), (0, 1)], closed=False)
    assert S.cut_solid(sk(gap)).is_empty


# ------------------------------------------------------------------ 细尖角、极小孔

@case('很细的尖角：补偿后尖角长度有上限（mitre），不会冒出很长的尖刺')
def _():
    spike = P([(0, 0), (100, 0), (100, 0.5), (0, 0.25)])    # 很细的楔形，尖角约 0.14°
    lines = timed(lambda: S.cut_polylines(sk(spike), 0.1))
    xs = [p[0] for pts, _, _ in lines for p in pts]
    assert min(xs) > -1.0, min(xs)


@case('极小的孔（直径 0.3 mm）：补偿后仍然保留')
def _():
    k = 0.5523 * 0.15
    tiny = P([(50.15, 50), (50, 50.15), (49.85, 50), (50, 49.85)],
             handles={0: (0, -k, 0, k), 1: (k, 0, -k, 0), 2: (0, k, 0, -k), 3: (-k, 0, k, 0)})
    lines = S.cut_polylines(board(tiny), 0.1)
    holes = [pts for pts, _, outer in lines if not outer]
    assert len(holes) == 1, lines
    xs = [p[0] for p in holes[0]]
    assert 0.05 < max(xs) - min(xs) < 0.3, (max(xs) - min(xs))


@case('补偿后会消失的孔（比 2 × 补偿还小）：导出时给出提示')
def _():
    tiny = P([(50, 50), (50.15, 50), (50.15, 50.15), (50, 50.15)])
    notes = S.export_warnings(board(tiny), 0.1)
    assert any('太小' in n for n in notes), notes
    assert S.export_warnings(board(P([(40, 40), (60, 40), (60, 60), (40, 60)])), 0.1) == []


# ------------------------------------------------------------------ 曲线展平精度

def bezier_dev(p0, p1, p2, p3):
    """展平后的折线和真实贝塞尔曲线的最大偏差（在曲线上密采样，取到折线的最大距离）。"""
    from shapely.geometry import LineString, Point
    path = {'closed': False, 'segs': [[*p0, 0, 0, p1[0] - p0[0], p1[1] - p0[1]],
                                      [*p3, p2[0] - p3[0], p2[1] - p3[1], 0, 0]]}
    line = LineString(S.flatten_path(path))
    dev = 0.0
    for i in range(2001):
        t = i / 2000
        mt = 1 - t
        x = mt ** 3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t ** 3 * p3[0]
        y = mt ** 3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t ** 3 * p3[1]
        dev = max(dev, line.distance(Point(x, y)))
    return dev, len(line.coords)


@case('圆（半径 1 ~ 1000 mm）展平后和真实曲线偏差 ≤ 0.05 mm')
def _():
    for r in (1, 5, 50, 150, 400, 1000):
        k = 0.5522847498 * r
        dev, n = bezier_dev((r, 0), (r, k), (k, r), (0, r))
        assert dev <= 0.05, (r, dev, n)


@case('贝塞尔曲线（S 形、尖弯）展平后偏差 ≤ 0.05 mm')
def _():
    for c in [((0, 0), (300, 400), (-100, 400), (200, 0)),
              ((0, 0), (500, 0), (-500, 100), (0, 100)),
              ((0, 0), (0, 0), (10, 10), (10, 0))]:
        dev, n = bezier_dev(*c)
        assert dev <= 0.05, (c, dev, n)


assert not failed, f'{len(failed)} 个失败：{failed}'
print(f'PASS test_geometry：{len(done)} 个边界情况——自相交、零长度段 / 重合节点、差一点闭合、细尖角、极小孔、曲线展平精度')

# 导出时提示会消失的小孔（freedesign → 导出结果的 info）
import json, tempfile  # noqa: E402
import backend  # noqa: E402
api = backend.Api()
proj, _ = backend._migrate_project(json.load(open(os.path.join(os.path.dirname(__file__), '..', 'fixtures', 'projects', 'free_v020.seedbox.json'), encoding='utf-8')))
pid = proj['free']['parts'][0]['id']
proj['sketches'][pid]['items'].append({'id': 'tiny', 'mode': 'cut', 'paths': [P([(30, 30), (30.1, 30), (30.1, 30.1), (30, 30.1)])]})
out = os.path.join(tempfile.mkdtemp(), 'tiny.svg')
api.dev_set_pick(out)
r = api.save('FreeDesign', proj['params'], 'svg', {k: proj[k] for k in ('disabled', 'edits', 'poses', 'sketches', 'free')}, None, 'free')
assert any('太小' in x for x in r.get('notes', [])), r          # notes 会显示在导出提示里
# 一块板都没有（都在加工清单里取消了）：导出时提示
d2 = {k: proj[k] for k in ('disabled', 'edits', 'poses', 'sketches', 'free')}
d2['disabled'] = [q['id'] for q in proj['free']['parts']]
out2 = os.path.join(tempfile.mkdtemp(), 'none.svg')
api.dev_set_pick(out2)
r2 = api.save('FreeDesign', proj['params'], 'svg', d2, None, 'none')
assert any('没有可以导出的板件' in x for x in r2.get('notes', [])), r2
print('PASS test_geometry：导出时提示补偿后会消失的小孔、没有板件可导出')
