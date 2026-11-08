"""导出校验（A2）。运行：.venv/bin/python tests/py/test_export.py
用 tests/fixtures/projects/free_v020（5 块指接板 + 圆孔 + 雕刻 + 板外描线），再在一块板上加一条描线，导出 SVG，检查：
单位 mm、尺寸；颜色分层（切割外轮廓黑 / 内孔蓝 / 雕刻绿 / 描线品红 / 标注红）；切割路径闭合；没有重复线；
每块板先切内孔、后切外轮廓；外轮廓尺寸 = 板件尺寸 + 2×切缝补偿；和 golden 摘要一致。
有 pstoedit 时再导出 DXF，用 ezdxf 读回来检查图层和尺寸。"""
import copy, json, os, re, shutil, sys, tempfile
ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
sys.path.insert(0, ROOT)
import backend  # noqa: E402

FIX = os.path.join(ROOT, 'tests', 'fixtures')
GOLD = os.path.join(FIX, 'export', 'free_v020.svg.json')
tmp = tempfile.mkdtemp()
api = backend.Api()
p, _ = backend._migrate_project(json.load(open(os.path.join(FIX, 'projects', 'free_v020.seedbox.json'), encoding='utf-8')))
# 在最大的板上加一条描线（导出应为品红）
big = max(p['free']['parts'], key=lambda q: q['w'] * q['h'])
p['sketches'][big['id']]['items'].append({'id': 'score1', 'mode': 'score', 'paths': [{'closed': False, 'segs': [[5, 5, 0, 0, 0, 0], [25, 5, 0, 0, 0, 0]]}]})
design = {k: p[k] for k in ('disabled', 'edits', 'poses', 'sketches', 'free')}
burn = float(p['params'].get('burn', 0.1))

COL = {'rgb(0,0,0)': 'outer', 'rgb(0,0,255)': 'inner', 'rgb(0,255,0)': 'engrave', 'rgb(255,0,255)': 'score', 'rgb(255,0,0)': 'note'}


def pts_of(d):
    out = []; x = y = 0.0; cur = []
    for cmd, args in re.findall(r'([MLHVZC])([^MLHVZC]*)', d):
        n = [float(v) for v in args.split()]
        if cmd == 'M':
            if cur: out.append(cur)
            x, y = n[0], n[1]; cur = [(x, y)]
        elif cmd == 'L': x, y = n[0], n[1]; cur.append((x, y))
        elif cmd == 'H': x = n[0]; cur.append((x, y))
        elif cmd == 'V': y = n[0]; cur.append((x, y))
        elif cmd == 'C': x, y = n[4], n[5]; cur.append((x, y))
        elif cmd == 'Z': cur.append(cur[0]); cur.append('Z')
    if cur: out.append(cur)
    return out


def parse(svg):
    groups = []
    for g in re.findall(r'<g id="p-\d+"[^>]*>(.*?)</g>', svg, re.S):
        groups.append([(COL.get(c, c), d) for d, c in re.findall(r'<path d="([^"]*)"[^>]*stroke="([^"]*)"', g, re.S)])
    return groups


svg_path = os.path.join(tmp, 'free.svg')
api.dev_set_pick(svg_path)
r = api.save('FreeDesign', p['params'], 'svg', design, None, 'free')
assert r.get('path') == svg_path, r
svg = open(svg_path, encoding='utf-8').read()
# 单位 mm，宽高和 viewBox 一致
m = re.search(r'height="([\d.]+)mm" viewBox="0.0 0.0 ([\d.]+) ([\d.]+)" width="([\d.]+)mm"', svg)
assert m and abs(float(m.group(1)) - float(m.group(3))) < 1e-6 and abs(float(m.group(4)) - float(m.group(2))) < 1e-6, m
groups = parse(svg)
allp = [x for g in groups for x in g]
kinds = {k for k, _ in allp}
assert {'outer', 'inner', 'engrave', 'score', 'note'} <= kinds, kinds
# 材料边框（红色标注）= 400×300
sheet = p['free']['sheet']
notes = [pts_of(d)[0] for k, d in allp if k == 'note']
assert any(abs(max(q[0] for q in pl if q != 'Z') - min(q[0] for q in pl if q != 'Z') - sheet['w']) < 0.01
           and abs(max(q[1] for q in pl if q != 'Z') - min(q[1] for q in pl if q != 'Z') - sheet['h']) < 0.01 for pl in notes), '材料边框尺寸不对'
# 切割路径闭合、没有重复线
seen = set()
for k, d in allp:
    if k not in ('outer', 'inner'):
        continue
    for pl in pts_of(d):
        pts = [q for q in pl if q != 'Z']
        assert 'Z' in pl or (abs(pts[0][0] - pts[-1][0]) < 1e-3 and abs(pts[0][1] - pts[-1][1]) < 1e-3), f'切割路径没闭合：{d[:80]}'
        key = tuple(sorted({(round(a, 2), round(b, 2)) for a, b in pts}))
        assert key not in seen, f'重复的切割线：{d[:80]}'
        seen.add(key)
# 每块板：先内孔、后外轮廓（每个内孔都排在包住它的外轮廓前面）；外轮廓尺寸 = 板件尺寸 + 2×切缝补偿
def bbox(d):
    pts = [q for pl in pts_of(d) for q in pl if q != 'Z']
    return (min(a for a, _ in pts), min(b for _, b in pts), max(a for a, _ in pts), max(b for _, b in pts))


seq = [(k, bbox(d)) for k, d in allp if k in ('outer', 'inner')]
outers = []
for j, (k, ob) in enumerate(seq):
    if k != 'outer':
        continue
    for i, (k2, ib) in enumerate(seq):
        if k2 == 'inner' and ib[0] >= ob[0] - 1e-6 and ib[1] >= ob[1] - 1e-6 and ib[2] <= ob[2] + 1e-6 and ib[3] <= ob[3] + 1e-6:
            assert i < j, f'应先切内孔、再切外轮廓：内孔 #{i} 排在外轮廓 #{j} 后面'
    outers.append((round(ob[2] - ob[0], 3), round(ob[3] - ob[1], 3)))
want = sorted((round(q['w'] + 2 * burn, 3), round(q['h'] + 2 * burn, 3)) for q in p['free']['parts'])
got = sorted(o for o in outers if o != (100.0, 10.0))     # 去掉 100 mm 校准尺
assert all(abs(a[0] - b[0]) < 0.01 and abs(a[1] - b[1]) < 0.01 for a, b in zip(got, want)) and len(got) == len(want), (got, want)
# golden 摘要：每种颜色的路径数、外轮廓尺寸
summary = {'counts': {k: sum(1 for x, _ in allp if x == k) for k in sorted(kinds)}, 'outers': got}
if os.environ.get('UPDATE_GOLDEN') or not os.path.exists(GOLD):
    os.makedirs(os.path.dirname(GOLD), exist_ok=True)
    json.dump(summary, open(GOLD, 'w', encoding='utf-8'), ensure_ascii=False, indent=1)
assert json.load(open(GOLD, encoding='utf-8')) == json.loads(json.dumps(summary)), (summary, '和 golden 不一致；确认是有意改动后用 UPDATE_GOLDEN=1 重新生成')
msg = f'SVG：{len(groups)} 组、{len(allp)} 条路径，颜色分层 / 闭合 / 无重复 / 先内后外 / 尺寸 / golden 全部正确'
# DXF（需要 pstoedit + ezdxf）
if shutil.which('pstoedit'):
    try:
        import ezdxf
    except ImportError:
        ezdxf = None
    dxf_path = os.path.join(tmp, 'free.dxf')
    api.dev_set_pick(dxf_path)
    r = api.save('FreeDesign', p['params'], 'dxf', design, None, 'free')
    assert r.get('path') == dxf_path, r
    if ezdxf:
        doc = ezdxf.readfile(dxf_path)
        ents = list(doc.modelspace())
        assert ents, 'DXF 里没有图形'
        # pstoedit 用 ACI 颜色区分：0/7 黑=外轮廓，5 蓝=内孔，3 绿=雕刻，6 品红=描线，1 红=标注
        ACI = {0: 'outer', 7: 'outer', 5: 'inner', 3: 'engrave', 6: 'score', 1: 'note'}
        dcount = {}
        douters = []
        for e in ents:
            if e.dxftype() != 'POLYLINE':
                continue
            kind = ACI.get(e.dxf.color, f'aci{e.dxf.color}')
            dcount[kind] = dcount.get(kind, 0) + 1
            pts = [v.dxf.location for v in e.vertices]
            if kind != 'score':
                assert e.is_closed or (abs(pts[0][0] - pts[-1][0]) < 1e-3 and abs(pts[0][1] - pts[-1][1]) < 1e-3), f'DXF 有没闭合的{kind}'
            if kind == 'outer':
                xs = [q[0] for q in pts]; ys = [q[1] for q in pts]
                douters.append((round(max(xs) - min(xs), 2), round(max(ys) - min(ys), 2)))
        assert dcount == summary['counts'], f'DXF 颜色分层和 SVG 不一致：{dcount} vs {summary["counts"]}'
        big_d = sorted(douters, reverse=True)[:len(summary['outers'])]
        for a, b in zip(big_d, sorted(map(tuple, summary['outers']), reverse=True)):
            assert abs(a[0] - b[0]) <= 0.01 and abs(a[1] - b[1]) <= 0.01, f'DXF 外形尺寸 {a} ≠ SVG {b}'
        msg += f'；DXF：{len(ents)} 个图形，颜色分层 / 闭合 / 尺寸和 SVG 一致'
    else:
        msg += '；DXF 已导出（没装 ezdxf，未校验内容）'
else:
    msg += '；DXF：本机没有 pstoedit，跳过（未验证）'
print('PASS test_export：' + msg)
