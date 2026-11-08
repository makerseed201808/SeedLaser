"""内置 DXF 导出（dxfout.py：SVG → DXF R12）。运行：.venv/bin/python tests/py/test_dxfout.py
需要 ezdxf 读回来校验（uv sync --extra dev）。"""
import math
import os
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
import dxfout  # noqa: E402

try:
    import ezdxf
except ImportError:
    print('SKIP test_dxfout：没装 ezdxf（uv sync --extra dev），未验证')
    sys.exit(0)

tmp = tempfile.mkdtemp()


def read(svg):
    p = os.path.join(tmp, 'x.dxf')
    open(p, 'wb').write(dxfout.svg_to_dxf_bytes(svg))
    d = ezdxf.readfile(p)
    assert not d.audit().errors
    return d, list(d.modelspace())


def bbox(e):
    pts = [v.dxf.location for v in e.vertices] if e.dxftype() == 'POLYLINE' else [e.dxf.start, e.dxf.end]
    xs = [q[0] for q in pts]; ys = [q[1] for q in pts]
    return round(min(xs), 3), round(min(ys), 3), round(max(xs), 3), round(max(ys), 3)


S = lambda body, w=100, h=50, vb='0 0 100 50': f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}mm" height="{h}mm" viewBox="{vb}">{body}</svg>'

# 1) 单位 mm、y 翻转、图层 / 颜色
d, es = read(S('<path d="M10 5 H40 V25 H10 Z" stroke="rgb(0,0,0)" fill="none"/><path d="M15 10 h5 v5 h-5 z" style="stroke:#0000ff"/>'
               '<path d="M50 5 L90 5" stroke="rgb(255,0,255)"/><path d="M50 20 L60 20 L60 30 Z" stroke="rgb(0,255,0)"/>'))
assert d.header['$INSUNITS'] == 4 and d.dxfversion == 'AC1009'
lay = {e.dxf.layer: e for e in es}
assert set(lay) == {'CUT_OUTER', 'CUT_INNER', 'SCORE', 'ENGRAVE'}, set(lay)
assert bbox(lay['CUT_OUTER']) == (10, 25, 40, 45), bbox(lay['CUT_OUTER'])        # y 翻转：50 - 25 = 25
assert lay['CUT_OUTER'].is_closed and len(list(lay['CUT_OUTER'].vertices)) == 4
assert bbox(lay['CUT_INNER']) == (15, 35, 20, 40)                               # 相对坐标 h / v / z
assert lay['SCORE'].dxftype() == 'LINE'
# 2) viewBox 缩放（英寸）和 transform（matrix / translate / rotate）
d, es = read(S('<g transform="translate(1,0)"><rect x="0" y="0" width="1" height="0.5" stroke="black"/></g>', w=2, h=1, vb='0 0 2 1').replace('mm"', 'in"'))
assert bbox(es[0]) == (25.4, 12.7, 50.8, 25.4), bbox(es[0])
d, es = read(S('<g transform="rotate(90 50 25)"><path d="M40 25 L60 25" stroke="black"/></g>'))
assert bbox(es[0]) == (50, 15, 50, 35), bbox(es[0])
# 3) 曲线：圆（C 命令）展平偏差 ≤ 0.02 mm；S / Q 不报错
k = 0.5522847498 * 20
d, es = read(S(f'<path d="M70 25 C70 {25 + k} {50 + k} 45 50 45 C{50 - k} 45 30 {25 + k} 30 25 C30 {25 - k} {50 - k} 5 50 5 C{50 + k} 5 70 {25 - k} 70 25 Z" stroke="blue"/>'
               '<path d="M0 0 Q10 10 20 0 T40 0 S50 10 60 0" stroke="black"/>'))
c = [e for e in es if e.dxf.layer == 'CUT_INNER'][0]
pts = [v.dxf.location for v in c.vertices]
dev = max(abs(math.hypot(p[0] - 50, p[1] - 25) - 20) for p in pts)
mid = max(20 - math.hypot((a[0] + b[0]) / 2 - 50, (a[1] + b[1]) / 2 - 25) for a, b in zip(pts, pts[1:] + pts[:1]))
assert dev < 0.02 and mid <= 0.02 + 0.006, (dev, mid)                 # 0.006：贝塞尔圆本身和真圆的差
# 4) 中文标注文字、居中对齐
d, es = read(S('<text x="50" y="40" font-size="5" text-anchor="middle" style="fill:rgb(255,0,0)">校准尺 100 mm</text>'))
t = es[0]
assert t.dxftype() == 'TEXT' and t.dxf.text == '校准尺 100 mm' and t.dxf.layer == 'NOTE' and t.dxf.halign == 1, t.dxf.all_existing_dxf_attribs()
# 5) 不认识的颜色：单独图层、最接近的 ACI
d, es = read(S('<path d="M0 0 L10 10" stroke="#ff8800"/>'))
assert es[0].dxf.layer.startswith('COLOR_FF8800')
print('PASS test_dxfout：单位 mm / y 翻转 / 图层颜色 / 相对坐标 / 英寸 viewBox / transform / 曲线偏差 ≤ 0.02 mm / 中文文字居中 / 未知颜色')
