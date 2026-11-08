"""A4 不变量：形状运算。随机 200 组图形（矩形、旋转矩形、圆、星形 / 凹多边形），
1) 面积守恒（前端 paper.js）：|A ∪ B| = |A| + |B| − |A ∩ B|，|A − B| = |A| − |A ∩ B|，|A ⊕ B| = |A ∪ B| − |A ∩ B|；
2) 前后端一致：同一组（展平后的）多边形，paper.js 和 shapely 的并 / 交 / 差面积相差 ≤ 0.1%。
带断言。固定随机种子，失败可复现。"""
import asyncio, json, math, os, random, sys
from playwright.async_api import async_playwright

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
import sketch2d as S  # noqa: E402
from shapely.geometry import Polygon  # noqa: E402

OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
D = 'window.__seedDebug'
ED = D + '.sketchEd'
N = 200
K = 0.5522847498


def shape(rng):
    kind = rng.choice(['rect', 'rot', 'circle', 'star'])
    cx, cy = rng.uniform(0, 70), rng.uniform(0, 70)
    if kind == 'circle':
        r = rng.uniform(8, 60)
        pts = [(cx + r, cy), (cx, cy + r), (cx - r, cy), (cx, cy - r)]
        hs = [(0, -K * r, 0, K * r), (K * r, 0, -K * r, 0), (0, K * r, 0, -K * r), (-K * r, 0, K * r, 0)]
        return {'closed': True, 'segs': [[x, y, *h] for (x, y), h in zip(pts, hs)]}
    if kind == 'star':
        n = rng.randint(4, 8)
        r1, r2 = rng.uniform(25, 60), rng.uniform(8, 24)
        a0 = rng.uniform(0, math.pi)
        pts = [(cx + (r1 if i % 2 == 0 else r2) * math.cos(a0 + i * math.pi / n), cy + (r1 if i % 2 == 0 else r2) * math.sin(a0 + i * math.pi / n)) for i in range(2 * n)]
    else:
        w, h = rng.uniform(10, 90), rng.uniform(10, 90)
        a = rng.uniform(0, math.pi) if kind == 'rot' else 0
        c, s = math.cos(a), math.sin(a)
        pts = [(cx + x * c - y * s, cy + x * s + y * c) for x, y in [(-w / 2, -h / 2), (w / 2, -h / 2), (w / 2, h / 2), (-w / 2, h / 2)]]
    return {'closed': True, 'segs': [[x, y, 0, 0, 0, 0] for x, y in pts]}


def flat(p):
    return {'closed': True, 'segs': [[x, y, 0, 0, 0, 0] for x, y in S.flatten_path(p)]}


JS = f"""(pairs)=>{{const ps={ED}.ps;
  const mk=(p)=>{{const q=new ps.Path({{insert:false}}); q.segments=p.segs.map(s=>new ps.Segment(new ps.Point(s[0],s[1]),new ps.Point(s[2],s[3]),new ps.Point(s[4],s[5]))); q.closed=true; return q;}};
  const ar=(x)=>{{ if (x.reorient) x.reorient(false, true); return Math.abs(x.area); }};   // 按奇偶规则统一方向（和板的实体判定一致）再算面积
  return pairs.map(([a,b])=>{{const A=mk(a), B=mk(b);
    return [ar(A), ar(B), ar(A.unite(B,{{insert:false}})), ar(A.intersect(B,{{insert:false}})), ar(A.subtract(B,{{insert:false}})), ar(A.exclude(B,{{insert:false}}))];}});}}"""


async def main():
    os.makedirs(OUT, exist_ok=True)
    rng = random.Random(20261108)
    pairs = [(shape(rng), shape(rng)) for _ in range(N)]
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)'); await pg.wait_for_timeout(1000)
        curved = await pg.evaluate(JS, pairs)
        flats = [(flat(a), flat(b)) for a, b in pairs]
        poly = await pg.evaluate(JS, flats)
        await b.close()
    assert not errs, errs
    # 1) 面积守恒（含曲线）
    bad = []
    for i, (A, B, U, I, Sb, X) in enumerate(curved):
        tol = 1e-6 * (A + B) + 1e-6
        for name, l, r in [('并', U, A + B - I), ('差', Sb, A - I), ('异或', X, U - I)]:
            if abs(l - r) > tol:
                bad.append((i, name, l, r))
    assert not bad, ('面积不守恒', bad[:5], len(bad))
    overlap = sum(1 for r in curved if r[3] > 1e-6)
    assert overlap >= N // 2, f'相交的组太少（{overlap}），测试没意义'
    # 2) 前后端一致（同样的展平多边形）
    worst = 0.0
    diff = []
    for i, ((fa, fb), (A, B, U, I, Sb, X)) in enumerate(zip(flats, poly)):
        pa = S._valid(Polygon([s[:2] for s in fa['segs']]))
        pb = S._valid(Polygon([s[:2] for s in fb['segs']]))
        for name, js, py in [('A', A, pa.area), ('并', U, pa.union(pb).area), ('交', I, pa.intersection(pb).area), ('差', Sb, pa.difference(pb).area)]:
            ref = max(js, py)
            if ref < 1e-6:
                continue
            rel = abs(js - py) / ref
            if rel > 0.001 and abs(js - py) > 1e-4:     # 极小的交集（< 0.0001 mm²）只比绝对值
                diff.append((i, name, js, py))
            worst = max(worst, rel if abs(js - py) > 1e-4 else 0)
    assert not diff, ('paper.js 和 shapely 不一致', diff[:5], len(diff))
    print(f'PASS boolinv1：{N} 组随机图形——面积守恒（并 / 差 / 异或）全部成立（{overlap} 组有重叠）；paper.js 与 shapely 面积最大相差 {worst * 100:.4f}%（≤ 0.1%）')

asyncio.run(main())
