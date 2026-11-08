"""板件二维草图（web/sketch2d.js 编辑）→ 导出图纸 / 3D 几何.

项目里的格式：project["sketches"][part_id] = {
    "base": 原始轮廓签名（参数改变后用来提示草图过期）,
    "items": [{"id", "mode": "cut" | "engrave" | "score", "role"?: "outline",
               "paths": [{"closed": bool, "segs": [[x, y, inx, iny, outx, outy], ...]}]}],
}
坐标：「从外面看」的板面坐标（与旧的 edits 相同）：原点 = 名义矩形左下角，单位 mm，y 向上。
segs 是 paper.js 的锚点 + 相对控制柄（三次贝塞尔）；控制柄全为 0 时就是直线段。

切割（cut）里的闭合路径按奇偶规则组成板的实体：最外圈是外轮廓，里面一圈是孔，孔里再一圈是岛……
导出时整体按激光补偿 burn 外扩（外轮廓向外、孔向内）。雕刻 / 描线原样输出。
"""
from __future__ import annotations

import math
from typing import Any, Iterable

from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.ops import unary_union

CURVE_STEPS = 16
FLAT_TOL = 0.02        # 曲线展平的最大偏差（mm），保证 ≤ 0.05 mm 的精度要求
CLOSE_TOL = 0.01       # 开放路径首尾距离小于它就当成闭合（导入的文件常差 0.001 mm）
MODES = ("cut", "engrave", "score")


# ------------------------------------------------------------------ 展平

def _cubic(p0, p1, p2, p3, steps):
    out = []
    for i in range(1, steps + 1):
        t = i / steps
        mt = 1 - t
        a, b, c, d = mt * mt * mt, 3 * mt * mt * t, 3 * mt * t * t, t * t * t
        out.append((a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
                    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]))
    return out


def _segments(path: dict) -> Iterable[tuple]:
    """逐段返回 (起点, 控制点 1, 控制点 2, 终点, 是否曲线)."""
    segs = path.get("segs") or []
    n = len(segs)
    if n < 2:
        return
    count = n if path.get("closed") else n - 1
    for i in range(count):
        a, b = segs[i], segs[(i + 1) % n]
        p0 = (float(a[0]), float(a[1]))
        p3 = (float(b[0]), float(b[1]))
        p1 = (p0[0] + float(a[4]), p0[1] + float(a[5]))
        p2 = (p3[0] + float(b[2]), p3[1] + float(b[3]))
        curved = any(abs(float(v)) > 1e-9 for v in (a[4], a[5], b[2], b[3]))
        yield p0, p1, p2, p3, curved


def curve_steps(p0, p1, p2, p3, steps: int = CURVE_STEPS) -> int:
    """三次贝塞尔展平的段数：按长度分段，再保证偏差 ≤ FLAT_TOL。
    均匀分 n 段时折线偏差 ≤ max|B''| / (8 n²)，而 max|B''| ≤ 6 × max(|p0 − 2p1 + p2|, |p1 − 2p2 + p3|)。
    和 web/sketch2d.js 的 curveSteps 一致。"""
    span = math.dist(p0, p1) + math.dist(p1, p2) + math.dist(p2, p3)
    m = max(math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]),
            math.hypot(p1[0] - 2 * p2[0] + p3[0], p1[1] - 2 * p2[1] + p3[1]))
    need = math.ceil(math.sqrt(6 * m / (8 * FLAT_TOL))) if m > 0 else 1
    return max(4, min(64, int(span / 1.5) + steps // 2), min(1024, need))


def is_closed(path: dict, pts: list) -> bool:
    """闭合，或者首尾几乎重合（< CLOSE_TOL）的开放路径。"""
    if len(pts) < 3:
        return False
    if path.get("closed"):
        return True
    return len(path.get("segs") or []) >= 4 and math.dist(pts[0], pts[-1]) < CLOSE_TOL


def flatten_path(path: dict, steps: int = CURVE_STEPS) -> list[tuple[float, float]]:
    segs = path.get("segs") or []
    if not segs:
        return []
    pts = [(float(segs[0][0]), float(segs[0][1]))]
    for p0, p1, p2, p3, curved in _segments(path):
        if curved:
            pts.extend(_cubic(p0, p1, p2, p3, curve_steps(p0, p1, p2, p3, steps)))
        else:
            pts.append(p3)
    if path.get("closed") and len(pts) > 2 and math.dist(pts[0], pts[-1]) < 1e-6:
        pts.pop()
    return pts


def item_polylines(item: dict) -> list[tuple[list[tuple[float, float]], bool]]:
    out = []
    for path in item.get("paths") or []:
        pts = flatten_path(path)
        if len(pts) < 2:
            continue
        closed = is_closed(path, pts)
        if closed and not path.get("closed"):
            pts = pts[:-1]          # 差一点闭合：去掉和起点几乎重合的终点
        out.append((pts, closed))
    return out


# ------------------------------------------------------------------ 几何

def _valid(poly: Polygon):
    """修复无效多边形。自相交（8 字形、蝴蝶结）用 make_valid 保留每一瓣；buffer(0) 会丢掉反向的那一瓣。"""
    if poly.is_valid:
        return poly
    from shapely import make_valid
    fixed = unary_union(_polygons(make_valid(poly)))
    return fixed if not fixed.is_empty else poly.buffer(0)


def cut_solid(sketch: dict):
    """切割闭合路径组成的实体（shapely 几何，可能为空）。
    完全落在另一个轮廓里面（边界不相交）的才是孔；互相交叉的轮廓都算实体（并集），和编辑器的显示一致。"""
    polys = []
    for item in sketch.get("items") or []:
        if item.get("mode", "cut") != "cut":
            continue
        for pts, closed in item_polylines(item):
            if not closed:
                continue
            poly = _valid(Polygon(pts))
            if not poly.is_empty:
                polys.append(poly)
    if not polys:
        return Polygon()
    depth = [sum(1 for k, o in enumerate(polys) if k != i and o.area > p.area and o.contains(p)) for i, p in enumerate(polys)]
    geom = Polygon()
    for d in range(max(depth) + 1):
        layer = [p for p, dp in zip(polys, depth) if dp == d]
        if not layer:
            continue
        u = unary_union(layer)
        geom = geom.union(u) if d % 2 == 0 else geom.difference(u)
    return geom.buffer(0)


def _polygons(geom) -> list[Polygon]:
    if geom.is_empty:
        return []
    if isinstance(geom, Polygon):
        return [geom]
    if isinstance(geom, MultiPolygon):
        return list(geom.geoms)
    return [g for g in getattr(geom, "geoms", []) if isinstance(g, Polygon)]


def _ring(coords) -> list[tuple[float, float]]:
    pts = [(round(x, 4), round(y, 4)) for x, y in coords]
    if len(pts) > 1 and pts[0] == pts[-1]:
        pts.pop()
    return pts


def geometry_3d(sketch: dict) -> dict | None:
    """3D / 碰撞检查用：{outer, holes, extra, etch}（从外面看坐标）。没有实体时返回 None."""
    polys = sorted(_polygons(cut_solid(sketch)), key=lambda p: p.area, reverse=True)
    if not polys:
        return None
    main = polys[0]
    etch = []
    for item in sketch.get("items") or []:
        if item.get("mode") in ("engrave", "score"):
            etch.extend(pts for pts, closed in item_polylines(item) if closed)
    return {
        "outer": _ring(main.exterior.coords),
        "holes": [_ring(r.coords) for r in main.interiors],
        "extra": [_ring(p.exterior.coords) for p in polys[1:]],
        "etch": [[(round(x, 4), round(y, 4)) for x, y in pts] for pts in etch],
    }


# ------------------------------------------------------------------ 导出

def cut_polylines(sketch: dict, burn: float = 0.0) -> list[tuple[list, bool, bool]]:
    """闭合切割轮廓（按 burn 补偿后）→ [(点列, 是否闭合, 是否外轮廓)]。
    有水口（item["bridges"]）的轮廓在水口处断开，留下 bridge_w 宽的材料不切。"""
    from shapely.geometry import LineString, Point
    from shapely.ops import substring

    solid = cut_solid(sketch)
    if burn > 0 and not solid.is_empty:
        solid = solid.buffer(burn, join_style=2, mitre_limit=4)
    bridges = []
    for item in sketch.get("items") or []:
        if item.get("mode", "cut") == "cut":
            bridges.extend(Point(float(b[0]), float(b[1])) for b in item.get("bridges") or [])
    gap = max(0.0, float(sketch.get("bridge_w", 1.0) or 0)) + 2 * burn
    out = []
    polys = sorted(_polygons(solid), key=lambda q: q.area, reverse=True)
    for i, p in enumerate(polys):
        for k, ring in enumerate([p.exterior, *p.interiors]):
            pts = _ring(ring.coords)
            outer = i == 0 and k == 0
            near = [b for b in bridges if ring.distance(b) < burn + 1.5] if bridges and gap > 0 else []
            if not near:
                out.append((pts, True, outer))
                continue
            line = LineString(list(ring.coords))
            L = line.length
            cuts = sorted(line.project(b) for b in near)
            # 从第一个水口之后开始，逐段输出（跳过每个水口两侧 gap/2）
            for j, d in enumerate(cuts):
                start = d + gap / 2
                end = cuts[(j + 1) % len(cuts)] - gap / 2 + (L if j == len(cuts) - 1 else 0)
                if end - start < 0.05:
                    continue
                segs = []
                if end <= L:
                    segs.append(substring(line, start % L, end))
                else:
                    if start < L:
                        segs.append(substring(line, start, L))
                    segs.append(substring(line, 0, end - L))
                coords = []
                for sg in segs:
                    c = [(round(x, 4), round(y, 4)) for x, y in sg.coords]
                    coords.extend(c if not coords else c[1:])
                if len(coords) >= 2:
                    out.append((coords, False, outer))
    return out


def draw(box: Any, sketch: dict, burn: float = 0.0, cut: bool = True, marks: bool = True, dims: bool = False) -> None:
    """在当前零件、当前坐标系（从外面看）里画出草图。调用前设好 surface._p 和 ctx._m.
    cut / marks：是否画切割部分 / 雕刻和描线部分（共边切割时切割部分另外画）。
    dims：是否把尺寸标注（mode = dim）一起画出来（描线颜色 + 数字文字）；默认不画。"""
    from boxes.Color import Color

    ctx = box.ctx

    def poly(pts, closed):
        ctx.move_to(*pts[0])
        for pt in pts[1:]:
            ctx.line_to(*pt)
        if closed:
            ctx.line_to(*pts[0])
        ctx.stroke()

    def curves(path):
        segs = path["segs"]
        ctx.move_to(float(segs[0][0]), float(segs[0][1]))
        for p0, p1, p2, p3, curved in _segments(path):
            if curved:
                ctx.curve_to(p1[0], p1[1], p2[0], p2[1], p3[0], p3[1])
            else:
                ctx.line_to(*p3)
        ctx.stroke()

    if cut:
        # 先切内孔、最后切外轮廓（外轮廓先切断，零件会松动，再切内孔就会切偏）
        for pts, closed, outer in sorted(cut_polylines(sketch, burn), key=lambda t: bool(t[2])):
            box.set_source_color(Color.OUTER_CUT if outer else Color.INNER_CUT)
            poly(pts, closed)
        box.set_source_color(Color.INNER_CUT)
        for item in sketch.get("items") or []:
            if item.get("mode", "cut") != "cut":
                continue
            for path in item.get("paths") or []:
                if not path.get("closed") and len(path.get("segs") or []) >= 2:
                    curves(path)
    if not marks:
        box.set_source_color(Color.BLACK)
        return

    for mode, color in (("engrave", Color.ETCHING), ("score", Color.MAGENTA)):
        box.set_source_color(color)
        for item in sketch.get("items") or []:
            if item.get("mode") != mode:
                continue
            for path in item.get("paths") or []:
                if len(path.get("segs") or []) >= 2:
                    if path.get("closed"):
                        path = {**path, "segs": path["segs"] + [path["segs"][0]], "closed": False}
                    curves(path)
    if dims:
        box.set_source_color(Color.MAGENTA)
        for item in sketch.get("items") or []:
            if item.get("mode") != "dim":
                continue
            for path in item.get("paths") or []:
                if len(path.get("segs") or []) >= 2:
                    curves(path)
            d = dim_label(item)
            if d:
                text, x, y, ang = d
                box.text(text, x, y, ang, align="center", fontsize=3.5, color=Color.MAGENTA)
    box.set_source_color(Color.BLACK)


def dim_points(item: dict):
    """尺寸标注的几何：paths[0] = 尺寸线 A'B'，paths[1] / paths[2] = 从 A、B 出发的引出线。返回 (A, B, A', B') 或 None."""
    paths = item.get("paths") or []
    if len(paths) < 3:
        return None
    try:
        a2 = (float(paths[0]["segs"][0][0]), float(paths[0]["segs"][0][1]))
        b2 = (float(paths[0]["segs"][-1][0]), float(paths[0]["segs"][-1][1]))
        a = (float(paths[1]["segs"][0][0]), float(paths[1]["segs"][0][1]))
        b = (float(paths[2]["segs"][0][0]), float(paths[2]["segs"][0][1]))
    except (KeyError, IndexError, TypeError, ValueError):
        return None
    return a, b, a2, b2


def dim_label(item: dict):
    """标注数字：(文字, x, y, 角度°)，放在尺寸线中点偏上 1.5 mm，字沿尺寸线方向、保持正立。"""
    g = dim_points(item)
    if not g:
        return None
    a, b, a2, b2 = g
    L = math.dist(a, b)
    ang = math.degrees(math.atan2(b2[1] - a2[1], b2[0] - a2[0]))
    if ang > 90 or ang <= -90:
        ang += 180
    r = math.radians(ang)
    nx, ny = -math.sin(r), math.cos(r)
    # 数字放在尺寸线「离被标注的边远」的那一侧
    mx, my = (a2[0] + b2[0]) / 2, (a2[1] + b2[1]) / 2
    side = 1 if (mx - a[0]) * nx + (my - a[1]) * ny >= 0 else -1
    return f"{L:.2f}".rstrip("0").rstrip("."), mx + nx * 1.5 * side, my + ny * 1.5 * side, ang


def export_warnings(sketch: dict, burn: float = 0.0) -> list[str]:
    """导出前的提示：比 2 × 补偿还小的孔，补偿后会消失（不会被切出来）。"""
    out = []
    if burn <= 0:
        return out
    gone = 0
    for p in _polygons(cut_solid(sketch)):
        for r in p.interiors:
            if Polygon(r).buffer(-burn).is_empty:
                gone += 1
    if gone:
        out.append(f"有 {gone} 个孔太小（比 2 × 激光补偿 {2 * burn:g} mm 还窄），补偿后会消失，不会切出来")
    return out


# ------------------------------------------------------------------ 编辑辅助（前端调用）

def offset(paths: list[dict], distance: float, join: str = "round") -> list[list[tuple[float, float]]]:
    """闭合路径整体外扩（distance > 0）/ 内缩；开放路径变成两侧等距的闭合轮廓."""
    js = {"round": 1, "miter": 2, "bevel": 3}.get(join, 1)
    geoms = []
    for path in paths:
        pts = flatten_path(path)
        if len(pts) < 2:
            continue
        if is_closed(path, pts):
            geoms.append(_valid(Polygon(pts)).buffer(distance, join_style=js, mitre_limit=4))
        else:
            geoms.append(LineString(pts).buffer(abs(distance), join_style=js, mitre_limit=4))
    out = []
    for p in _polygons(unary_union(geoms) if geoms else Polygon()):
        out.append(_ring(p.exterior.coords))
        out.extend(_ring(r.coords) for r in p.interiors)
    return out


# ------------------------------------------------------------------ 位图描摹
# 图片的解码、灰度、阈值在前端（浏览器 canvas）做，这里只收「深色像素矩形」（竖直方向已合并的行段），
# 合并成多边形、简化、换算成 mm。这样不需要 Pillow。

def trace_rects(rects: list, w: int, h: int, smooth: float = 1.0, min_area: float = 4.0,
                width_mm: float = 50.0) -> dict:
    """rects: [[x0, y0, x1, y1], ...] 像素坐标（y 向下）。返回 {"polys": [{"outer", "holes"}], "size"}，
    单位 mm、y 向上、以图片中心为原点。"""
    from shapely.geometry import box as sbox

    w = max(1, int(w))
    h = max(1, int(h))
    if not rects:
        return {"polys": [], "size": [width_mm, width_mm * h / w]}
    geom = unary_union([sbox(*r) for r in rects])
    if smooth > 0:
        geom = geom.simplify(float(smooth), preserve_topology=True)
    scale = float(width_mm) / w

    def conv(coords):
        return [(round((x - w / 2) * scale, 3), round((h / 2 - y) * scale, 3)) for x, y in list(coords)[:-1]]

    out = []
    for p in _polygons(geom):
        if p.area < min_area:
            continue
        holes = [conv(r.coords) for r in p.interiors if Polygon(r).area >= min_area]
        out.append({"outer": conv(p.exterior.coords), "holes": holes})
    return {"polys": out, "size": [round(width_mm, 3), round(width_mm * h / w, 3)]}


# ------------------------------------------------------------------ 共边切割：删除重叠线

def dedupe_lines(polylines: list[tuple[list, bool, bool]], tol: float = 0.02) -> tuple[list, float]:
    """多条折线里共线重叠的直线段只保留一次（先出现的保留）。
    返回 (新的折线列表 [(点列, 是否闭合, 是否外轮廓)], 省掉的长度 mm)。"""
    segs = []   # (折线号, 段号, p, q)
    for li, (pts, closed, _o) in enumerate(polylines):
        n = len(pts)
        for k in range(n if closed else n - 1):
            p, q = pts[k], pts[(k + 1) % n]
            if math.dist(p, q) > 1e-6:
                segs.append((li, k, p, q))
    groups: dict[tuple, list] = {}
    for idx, (_li, _k, p, q) in enumerate(segs):
        dx, dy = q[0] - p[0], q[1] - p[1]
        a = math.atan2(dy, dx) % math.pi
        if abs(a - math.pi) < 1e-6:
            a = 0.0
        nx, ny = -math.sin(a), math.cos(a)
        off = p[0] * nx + p[1] * ny
        key = (round(a / 1e-3), round(off / tol))
        groups.setdefault(key, []).append(idx)
    keep: dict[int, list[tuple[float, float]]] = {}   # 段号 → 保留的参数区间（0~1）
    saved = 0.0
    for idxs in groups.values():
        if len(idxs) < 2:
            continue
        a = math.atan2(segs[idxs[0]][3][1] - segs[idxs[0]][2][1], segs[idxs[0]][3][0] - segs[idxs[0]][2][0])
        ux, uy = math.cos(a), math.sin(a)
        covered: list[tuple[float, float]] = []
        for idx in idxs:
            _li, _k, p, q = segs[idx]
            t0, t1 = p[0] * ux + p[1] * uy, q[0] * ux + q[1] * uy
            lo, hi = min(t0, t1), max(t0, t1)
            rest = [(lo, hi)]
            for c0, c1 in covered:
                nxt = []
                for r0, r1 in rest:
                    if c1 <= r0 + tol or c0 >= r1 - tol:
                        nxt.append((r0, r1))
                        continue
                    if c0 > r0 + tol:
                        nxt.append((r0, c0))
                    if c1 < r1 - tol:
                        nxt.append((c1, r1))
                rest = nxt
            covered.append((lo, hi))
            length = hi - lo
            kept = sum(r1 - r0 for r0, r1 in rest)
            if length - kept > tol:
                saved += length - kept
                # 换成 0~1 参数（沿 p→q）
                span = t1 - t0
                keep[idx] = sorted(((r0 - t0) / span, (r1 - t0) / span) if span > 0 else ((t0 - r1) / -span, (t0 - r0) / -span)
                                   for r0, r1 in rest)
                keep[idx] = [(min(u, v), max(u, v)) for u, v in keep[idx]]
    if not keep:
        return polylines, 0.0
    by_line: dict[int, dict[int, list]] = {}
    for idx, iv in keep.items():
        li, k, _p, _q = segs[idx]
        by_line.setdefault(li, {})[k] = iv
    out = []
    for li, (pts, closed, outer) in enumerate(polylines):
        mods = by_line.get(li)
        if not mods:
            out.append((pts, closed, outer))
            continue
        n = len(pts)
        cur: list = []
        pieces = []
        for k in range(n if closed else n - 1):
            p, q = pts[k], pts[(k + 1) % n]
            lerp = lambda t: (p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t)
            ivs = mods.get(k)
            if ivs is None:
                if not cur:
                    cur = [p]
                cur.append(q)
                continue
            for u, v in ivs:
                if u < 1e-6 and cur:
                    cur.append(lerp(v))
                else:
                    if len(cur) >= 2:
                        pieces.append(cur)
                    cur = [lerp(u), lerp(v)]
                if v < 1 - 1e-6:
                    pieces.append(cur)
                    cur = []
            if not ivs:
                if len(cur) >= 2:
                    pieces.append(cur)
                cur = []
        if len(cur) >= 2:
            pieces.append(cur)
        out.extend((pc, False, outer) for pc in pieces if len(pc) >= 2)
    return out, saved


# ------------------------------------------------------------------ 文字排版（多行 / 字距 / 圆弧 / 沿路径 / 焊接）

def _glyph_cache():
    if not hasattr(_glyph_cache, "c"):
        _glyph_cache.c = {}
    return _glyph_cache.c


def _glyph(font_id: str, ch: str, size: float):
    """单个字：(轮廓列表（以基线左端为原点，mm）, 前进宽度 mm, 是否缺字)."""
    import model3d
    key = (font_id, ch, round(size, 3))
    cache = _glyph_cache()
    if key in cache:
        return cache[key]
    font = model3d._load_font(font_id)
    cmap = font.getBestCmap() or {}
    gs = font.getGlyphSet()
    scale = size / font["head"].unitsPerEm
    gname = cmap.get(ord(ch))
    if gname is None:
        res = ([], font["head"].unitsPerEm * 0.5 * scale, not ch.isspace())
    else:
        g = gs[gname]
        pen = model3d._FlattenPen(gs)
        g.draw(pen.pen)
        pen._finish()
        polys = [[(x * scale, y * scale) for x, y in p] for p in pen.polys]
        res = (polys, g.width * scale, False)
    cache[key] = res
    return res


def _path_at(pts, cum, s):
    """折线上弧长 s 处的点和切线角."""
    s = max(0.0, min(cum[-1], s))
    for i in range(1, len(pts)):
        if cum[i] >= s or i == len(pts) - 1:
            seg = cum[i] - cum[i - 1] or 1e-9
            t = (s - cum[i - 1]) / seg
            (x0, y0), (x1, y1) = pts[i - 1], pts[i]
            return (x0 + (x1 - x0) * t, y0 + (y1 - y0) * t), math.atan2(y1 - y0, x1 - x0)
    return pts[0], 0.0


def text_layout(text: str, font_id: str, size: float, spacing: float = 0.0, line_height: float = 1.25,
                align: str = "center", arc: float = 0.0, path: list | None = None, weld: bool = False) -> dict:
    """返回 {"polys": [环...], "missing": [...], "size": [w, h]}。
    普通 / 圆弧：以文字块中心为原点；沿路径：直接是路径所在的坐标。"""
    import model3d
    font = model3d._load_font(font_id or "")
    hhea = font["hhea"]
    scale = size / font["head"].unitsPerEm
    mid_y = (hhea.ascent + hhea.descent) / 2 * scale
    lines = (text or "").split("\n")
    missing: list[str] = []
    glyph_lines = []   # 每行：[(轮廓, 字左端 x, 前进宽度)]
    for line in lines:
        x = 0.0
        row = []
        for ch in line:
            polys, adv, miss = _glyph(font_id or "", ch, size)
            if miss:
                missing.append(ch)
            row.append((polys, x, adv))
            x += adv + spacing
        width = x - spacing if row else 0.0
        glyph_lines.append((row, width))
    max_w = max((w for _r, w in glyph_lines), default=0.0)
    lh = size * line_height
    n = len(glyph_lines)
    out: list[list[tuple[float, float]]] = []

    def rot(pts, ang, ox, oy, tx, ty):
        c, s_ = math.cos(ang), math.sin(ang)
        return [(tx + (x - ox) * c - (y - oy) * s_, ty + (x - ox) * s_ + (y - oy) * c) for x, y in pts]

    if path and len(path) >= 2:
        pts = [(float(p[0]), float(p[1])) for p in path]
        cum = [0.0]
        for i in range(1, len(pts)):
            cum.append(cum[-1] + math.dist(pts[i - 1], pts[i]))
        for li, (row, w) in enumerate(glyph_lines):
            s0 = (cum[-1] - w) / 2
            for polys, gx, adv in row:
                (px, py), ang = _path_at(pts, cum, s0 + gx + adv / 2)
                nx, ny = -math.sin(ang), math.cos(ang)
                off = -li * lh
                for p in polys:
                    out.append(rot(p, ang, adv / 2, 0.0, px + nx * off, py + ny * off))
    else:
        for li, (row, w) in enumerate(glyph_lines):
            ox = {"left": -max_w / 2, "right": max_w / 2 - w}.get(align, -w / 2)
            base_y = (n - 1) / 2 * lh - li * lh - mid_y
            for polys, gx, adv in row:
                if abs(arc) < 1e-6:
                    for p in polys:
                        out.append([(x + ox + gx, y + base_y) for x, y in p])
                    continue
                # 先按直排算出字的参考点（字中心、基线），再映射到圆弧上并旋转
                u = ox + gx + adv / 2
                v = base_y
                R = abs(arc)
                if arc > 0:   # 文字在圆弧外侧上方（圆心在下面）
                    phi = u / R
                    rad = R + v
                    tx, ty, ang = rad * math.sin(phi), rad * math.cos(phi) - R, -phi
                else:         # 文字在圆弧下方（圆心在上面），字头朝圆心
                    phi = u / R
                    rad = R - v
                    tx, ty, ang = rad * math.sin(phi), R - rad * math.cos(phi), phi
                for p in polys:
                    out.append(rot(p, ang, adv / 2, 0.0, tx, ty))
    if weld and out:
        geom = None
        for p in out:
            if len(p) < 3:
                continue
            g = _valid(Polygon(p))
            geom = g if geom is None else geom.symmetric_difference(g)
        geom = geom.buffer(0) if geom is not None else Polygon()
        rings = []
        for pg in _polygons(geom):
            rings.append(_ring(pg.exterior.coords))
            rings.extend(_ring(r.coords) for r in pg.interiors)
        out = rings
    else:
        out = [[(round(x, 3), round(y, 3)) for x, y in p] for p in out]
    xs = [x for p in out for x, _ in p]
    ys = [y for p in out for _, y in p]
    size_wh = [round(max(xs) - min(xs), 3), round(max(ys) - min(ys), 3)] if xs else [0, 0]
    return {"polys": out, "missing": sorted(set(missing)), "size": size_wh}
