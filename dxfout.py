"""SVG（Boxes 的输出）→ DXF。内置实现，不需要 pstoedit、不需要额外的库。

- 格式：DXF R12（AC1009），激光软件（LightBurn、LaserMaker、RDWorks）兼容性最好；单位 mm（$INSUNITS = 4）。
- 图层按颜色分：CUT_OUTER（外轮廓，白 / 黑）、CUT_INNER（内孔，蓝）、ENGRAVE（雕刻，绿）、SCORE（描线，品红）、NOTE（标注，红）。
  图形颜色都是 BYLAYER，换颜色只要改图层。
- 曲线（三次贝塞尔）展平成折线，偏差 ≤ 0.02 mm（和 sketch2d.curve_steps 同样的规则）。
- 坐标：SVG 的 y 向下，DXF 的 y 向上，导出时翻转，保持图纸看起来一样。
"""
from __future__ import annotations

import math
import re
import xml.etree.ElementTree as ET

FLAT_TOL = 0.02

# 颜色 → (图层名, ACI 颜色号)
LAYERS = {
    (0, 0, 0): ("CUT_OUTER", 7),
    (0, 0, 255): ("CUT_INNER", 5),
    (0, 255, 0): ("ENGRAVE", 3),
    (255, 0, 255): ("SCORE", 6),
    (255, 0, 0): ("NOTE", 1),
}
_ACI_BASIC = {1: (255, 0, 0), 2: (255, 255, 0), 3: (0, 255, 0), 4: (0, 255, 255), 5: (0, 0, 255), 6: (255, 0, 255), 7: (0, 0, 0)}


# ------------------------------------------------------------------ 解析

def _color(v: str | None):
    if not v or v == "none":
        return None
    v = v.strip()
    m = re.match(r"rgb\(\s*([\d.]+)%?\s*,\s*([\d.]+)%?\s*,\s*([\d.]+)%?\s*\)", v)
    if m:
        pct = "%" in v
        return tuple(int(round(float(x) * (2.55 if pct else 1))) for x in m.groups())
    if v.startswith("#"):
        h = v[1:]
        if len(h) == 3:
            h = "".join(c * 2 for c in h)
        if len(h) == 6:
            return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))
    named = {"black": (0, 0, 0), "blue": (0, 0, 255), "red": (255, 0, 0), "green": (0, 128, 0), "lime": (0, 255, 0), "magenta": (255, 0, 255), "fuchsia": (255, 0, 255)}
    return named.get(v.lower())


def _style(el, key):
    v = el.get(key)
    if v is None:
        m = re.search(rf"(?:^|;)\s*{key}\s*:\s*([^;]+)", el.get("style") or "")
        v = m.group(1).strip() if m else None
    return v


def _mul(a, b):
    """仿射矩阵 (a, b, c, d, e, f) 相乘：先 b 后 a。"""
    return (a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
            a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
            a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5])


def _transform(s: str | None):
    m = (1.0, 0.0, 0.0, 1.0, 0.0, 0.0)
    for name, args in re.findall(r"(\w+)\s*\(([^)]*)\)", s or ""):
        v = [float(x) for x in re.split(r"[\s,]+", args.strip()) if x]
        if name == "matrix" and len(v) == 6:
            t = tuple(v)
        elif name == "translate":
            t = (1, 0, 0, 1, v[0], v[1] if len(v) > 1 else 0)
        elif name == "scale":
            t = (v[0], 0, 0, v[1] if len(v) > 1 else v[0], 0, 0)
        elif name == "rotate":
            a = math.radians(v[0])
            c, si = math.cos(a), math.sin(a)
            t = (c, si, -si, c, 0, 0)
            if len(v) == 3:
                t = _mul(_mul((1, 0, 0, 1, v[1], v[2]), t), (1, 0, 0, 1, -v[1], -v[2]))
        else:
            continue
        m = _mul(m, t)
    return m


def _apply(m, x, y):
    return (m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5])


def _steps(p0, p1, p2, p3):
    mx = max(math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]),
             math.hypot(p1[0] - 2 * p2[0] + p3[0], p1[1] - 2 * p2[1] + p3[1]))
    need = math.ceil(math.sqrt(6 * mx / (8 * FLAT_TOL))) if mx > 0 else 1
    return max(4, min(1024, need))


def _path(d: str):
    """path 的 d → [(点列, 是否闭合)]（用户坐标，没有变换）。支持 M L H V C S Q T Z（大小写）；A 弧线按直线连到终点（Boxes 不输出）。"""
    toks = re.findall(r"[MmLlHhVvCcSsQqTtAaZz]|-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?", d)
    out = []
    pts = []
    cur = (0.0, 0.0)
    start = (0.0, 0.0)
    last_c = None
    cmd = None
    i = 0

    def num():
        nonlocal i
        v = float(toks[i])
        i += 1
        return v

    def flush(closed):
        nonlocal pts
        if len(pts) >= 2:
            if closed and len(pts) > 2 and math.dist(pts[0], pts[-1]) < 1e-9:
                pts = pts[:-1]
            out.append((pts, closed))
        pts = []

    def cubic(p1, p2, p3):
        nonlocal cur
        p0 = cur
        n = _steps(p0, p1, p2, p3)
        for k in range(1, n + 1):
            t = k / n
            mt = 1 - t
            pts.append((mt ** 3 * p0[0] + 3 * mt * mt * t * p1[0] + 3 * mt * t * t * p2[0] + t ** 3 * p3[0],
                        mt ** 3 * p0[1] + 3 * mt * mt * t * p1[1] + 3 * mt * t * t * p2[1] + t ** 3 * p3[1]))
        cur = p3

    while i < len(toks):
        t = toks[i]
        if re.match(r"[A-Za-z]", t):
            cmd = t
            i += 1
            if cmd in "Zz":
                if pts:
                    pts.append(start)
                flush(True)
                cur = start
                last_c = None
                continue
        if cmd is None:
            i += 1
            continue
        rel = cmd.islower()
        ox, oy = cur if rel else (0.0, 0.0)
        c = cmd.upper()
        if c == "M":
            flush(False)
            cur = (num() + ox, num() + oy)
            start = cur
            pts = [cur]
            cmd = "l" if rel else "L"            # M 后面的坐标按 L
            last_c = None
        elif c == "L":
            cur = (num() + ox, num() + oy)
            pts.append(cur)
            last_c = None
        elif c == "H":
            cur = (num() + ox, cur[1])
            pts.append(cur)
            last_c = None
        elif c == "V":
            cur = (cur[0], num() + (cur[1] if rel else 0.0))
            pts.append(cur)
            last_c = None
        elif c == "C":
            p1 = (num() + ox, num() + oy)
            p2 = (num() + ox, num() + oy)
            p3 = (num() + ox, num() + oy)
            cubic(p1, p2, p3)
            last_c = p2
        elif c == "S":
            p1 = (2 * cur[0] - last_c[0], 2 * cur[1] - last_c[1]) if last_c else cur
            p2 = (num() + ox, num() + oy)
            p3 = (num() + ox, num() + oy)
            cubic(p1, p2, p3)
            last_c = p2
        elif c in "QT":
            if c == "Q":
                q = (num() + ox, num() + oy)
            else:
                q = (2 * cur[0] - last_c[0], 2 * cur[1] - last_c[1]) if last_c else cur
            p3 = (num() + ox, num() + oy)
            p0 = cur
            cubic((p0[0] + 2 / 3 * (q[0] - p0[0]), p0[1] + 2 / 3 * (q[1] - p0[1])),
                  (p3[0] + 2 / 3 * (q[0] - p3[0]), p3[1] + 2 / 3 * (q[1] - p3[1])), p3)
            last_c = q
        elif c == "A":
            for _ in range(5):
                num()
            cur = (num() + ox, num() + oy)
            pts.append(cur)
            last_c = None
        else:
            i += 1
    flush(False)
    return out


def _local(tag):
    return tag.rsplit("}", 1)[-1]


def parse_svg(svg_text: str):
    """→ (宽 mm, 高 mm, [(图层颜色, 点列 mm, 是否闭合)], [(文字, x, y, 字高, 颜色)])，坐标 y 向下。"""
    root = ET.fromstring(svg_text.encode("utf-8") if isinstance(svg_text, str) else svg_text)

    def mm(v, default):
        m = re.match(r"\s*([\d.]+)\s*(mm|cm|in|pt|px)?", v or "")
        if not m:
            return default
        return float(m.group(1)) * {"mm": 1, "cm": 10, "in": 25.4, "pt": 25.4 / 72, "px": 25.4 / 96, None: 25.4 / 96}[m.group(2)]

    vb = [float(x) for x in re.split(r"[\s,]+", (root.get("viewBox") or "").strip()) if x]
    W = mm(root.get("width"), vb[2] * 25.4 / 96 if len(vb) == 4 else 0)
    H = mm(root.get("height"), vb[3] * 25.4 / 96 if len(vb) == 4 else 0)
    if len(vb) == 4 and vb[2] > 0 and vb[3] > 0:
        base = (W / vb[2], 0, 0, H / vb[3], -vb[0] * W / vb[2], -vb[1] * H / vb[3])
    else:
        base = (25.4 / 96, 0, 0, 25.4 / 96, 0, 0)
    lines, texts = [], []

    def walk(el, m, stroke, fsize, anchor="start"):
        tag = _local(el.tag)
        if tag in ("metadata", "title", "desc", "defs", "style", "clipPath", "mask"):
            return
        m = _mul(m, _transform(el.get("transform")))
        s = _style(el, "stroke")
        stroke = _color(s) if s is not None else stroke
        anchor = _style(el, "text-anchor") or anchor
        f = _style(el, "font-size")
        if f:
            try:
                fsize = float(re.match(r"[\d.]+", f).group(0))
            except Exception:
                pass
        if tag == "path":
            for pts, closed in _path(el.get("d") or ""):
                lines.append((stroke, [_apply(m, x, y) for x, y in pts], closed))
        elif tag in ("line", "polyline", "polygon", "rect", "circle", "ellipse"):
            for pts, closed in _shape(tag, el):
                lines.append((stroke, [_apply(m, x, y) for x, y in pts], closed))
        elif tag == "text":
            txt = "".join(el.itertext()).strip()
            if txt:
                x = float(el.get("x") or 0)
                y = float(el.get("y") or 0)
                px, py = _apply(m, x, y)
                scale = math.hypot(m[2], m[3]) or 1
                fill = _color(_style(el, "fill")) or stroke
                if (_style(el, "dominant-baseline") or "") in ("hanging", "text-before-edge"):
                    py += 0.8 * (fsize or 3) * scale         # SVG 按字顶对齐，DXF 按基线：往下挪约一个字高
                texts.append((txt, px, py, (fsize or 3) * scale, fill, anchor))
            return
        for ch in el:
            walk(ch, m, stroke, fsize, anchor)

    walk(root, base, None, None)
    return W, H, lines, texts


def _shape(tag, el):
    g = lambda k: float(el.get(k) or 0)
    if tag == "line":
        return [([(g("x1"), g("y1")), (g("x2"), g("y2"))], False)]
    if tag in ("polyline", "polygon"):
        v = [float(x) for x in re.split(r"[\s,]+", (el.get("points") or "").strip()) if x]
        return [(list(zip(v[0::2], v[1::2])), tag == "polygon")]
    if tag == "rect":
        x, y, w, h = g("x"), g("y"), g("width"), g("height")
        return [([(x, y), (x + w, y), (x + w, y + h), (x, y + h)], True)]
    if tag in ("circle", "ellipse"):
        cx, cy = g("cx"), g("cy")
        rx = g("r") if tag == "circle" else g("rx")
        ry = g("r") if tag == "circle" else g("ry")
        r = max(rx, ry)
        n = max(16, min(1024, math.ceil(math.pi / math.acos(max(-1.0, 1 - FLAT_TOL / r))) if r > FLAT_TOL else 16))
        return [([(cx + rx * math.cos(2 * math.pi * k / n), cy + ry * math.sin(2 * math.pi * k / n)) for k in range(n)], True)]
    return []


# ------------------------------------------------------------------ 写 DXF

def _layer(color):
    if color in LAYERS:
        return LAYERS[color]
    if color is None:
        return LAYERS[(0, 0, 0)]
    aci = min(_ACI_BASIC, key=lambda k: sum((a - b) ** 2 for a, b in zip(_ACI_BASIC[k], color)))
    return ("COLOR_%02X%02X%02X" % color, aci)


def _f(v: float) -> str:
    s = f"{v:.4f}".rstrip("0").rstrip(".")
    return "0" if s in ("-0", "") else s


def svg_to_dxf_bytes(svg_text: str) -> bytes:
    """写文件用：GBK 编码（和 $DWGCODEPAGE = ANSI_936 对应），换行 CRLF."""
    return svg_to_dxf(svg_text).replace("\n", "\r\n").encode("gbk", errors="replace")


def svg_to_dxf(svg_text: str) -> str:
    W, H, lines, texts = parse_svg(svg_text)
    used = {}
    for color, _pts, _c in lines:
        name, aci = _layer(color)
        used[name] = aci
    for _t, _x, _y, _h, color, _a in texts:
        name, aci = _layer(color if color in LAYERS else (255, 0, 0))
        used[name] = aci
    out = []
    w = out.append

    def pair(code, value):
        w(f"{code:>3}\n{value}\n")

    # HEADER
    pair(0, "SECTION"); pair(2, "HEADER")
    pair(9, "$ACADVER"); pair(1, "AC1009")
    pair(9, "$DWGCODEPAGE"); pair(3, "ANSI_936")       # 中文（GBK）：文字标注里的中文不乱码
    pair(9, "$INSUNITS"); pair(70, 4)           # 4 = 毫米
    pair(9, "$MEASUREMENT"); pair(70, 1)        # 公制
    pair(9, "$EXTMIN"); pair(10, 0); pair(20, 0)
    pair(9, "$EXTMAX"); pair(10, _f(W)); pair(20, _f(H))
    pair(0, "ENDSEC")
    # TABLES：线型 + 图层
    pair(0, "SECTION"); pair(2, "TABLES")
    pair(0, "TABLE"); pair(2, "LTYPE"); pair(70, 1)
    pair(0, "LTYPE"); pair(2, "CONTINUOUS"); pair(70, 0); pair(3, "Solid line"); pair(72, 65); pair(73, 0); pair(40, 0)
    pair(0, "ENDTAB")
    pair(0, "TABLE"); pair(2, "LAYER"); pair(70, len(used) + 1)
    for name, aci in [("0", 7)] + sorted(used.items()):
        pair(0, "LAYER"); pair(2, name); pair(70, 0); pair(62, aci); pair(6, "CONTINUOUS")
    pair(0, "ENDTAB")
    pair(0, "ENDSEC")
    # ENTITIES
    pair(0, "SECTION"); pair(2, "ENTITIES")
    for color, pts, closed in lines:
        name, _aci = _layer(color)
        P = [(x, H - y) for x, y in pts]
        if closed and len(P) > 2 and math.dist(P[0], P[-1]) < 1e-6:
            P = P[:-1]
        if len(P) < 2:
            continue
        if len(P) == 2 and not closed:
            pair(0, "LINE"); pair(8, name)
            pair(10, _f(P[0][0])); pair(20, _f(P[0][1])); pair(30, 0)
            pair(11, _f(P[1][0])); pair(21, _f(P[1][1])); pair(31, 0)
            continue
        pair(0, "POLYLINE"); pair(8, name); pair(66, 1); pair(10, 0); pair(20, 0); pair(30, 0); pair(70, 1 if closed else 0)
        for x, y in P:
            pair(0, "VERTEX"); pair(8, name); pair(10, _f(x)); pair(20, _f(y)); pair(30, 0)
        pair(0, "SEQEND"); pair(8, name)
    for txt, x, y, h, color, anchor in texts:
        name, _aci = _layer(color if color in LAYERS else (255, 0, 0))
        safe = txt.replace("\n", " ")
        pair(0, "TEXT"); pair(8, name); pair(10, _f(x)); pair(20, _f(H - y)); pair(30, 0); pair(40, _f(h)); pair(1, safe)
        if anchor in ("middle", "end"):                # 水平对齐：1 = 居中，2 = 右对齐（对齐点 11/21）
            pair(72, 1 if anchor == "middle" else 2); pair(11, _f(x)); pair(21, _f(H - y)); pair(31, 0)
    pair(0, "ENDSEC")
    pair(0, "EOF")
    return "".join(out)
