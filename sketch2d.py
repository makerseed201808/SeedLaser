"""板件二维草图（web/sketch2d.js 编辑）→ 导出图纸 / 3D 几何.

项目里的格式：project["sketches"][part_id] = {
    "base": 原始轮廓签名（参数改变后用来提示草图过期）,
    "items": [{"id", "mode": "cut" | "engrave" | "score", "role"?: "outline",
               "paths": [{"closed": bool, "segs": [[x, y, inx, iny, outx, outy], ...]}]}],
}
坐标：「从外面看」的板面坐标（与旧的 edits 相同）：原点 = 名义矩形左下角，单位 mm，y 向上。
segs 是 paper.js 的锚点 + 相对控制柄（三次贝塞尔）；控制柄全为 0 时就是直线段。

切割（cut）里的闭合路径按奇偶规则组成板的实体：最外圈是外轮廓，里面一圈是孔，孔里再一圈是岛……
导出时整体按激光补偿 burn 外扩（外轮廓向外、孔向内）。雕刻 / 划线原样输出。
"""
from __future__ import annotations

import math
from typing import Any, Iterable

from shapely.geometry import LineString, MultiPolygon, Polygon
from shapely.ops import unary_union

CURVE_STEPS = 16
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


def flatten_path(path: dict, steps: int = CURVE_STEPS) -> list[tuple[float, float]]:
    segs = path.get("segs") or []
    if not segs:
        return []
    pts = [(float(segs[0][0]), float(segs[0][1]))]
    for p0, p1, p2, p3, curved in _segments(path):
        if curved:
            # 长曲线多分几段
            span = math.dist(p0, p1) + math.dist(p1, p2) + math.dist(p2, p3)
            pts.extend(_cubic(p0, p1, p2, p3, max(4, min(64, int(span / 1.5) + steps // 2))))
        else:
            pts.append(p3)
    if path.get("closed") and len(pts) > 2 and math.dist(pts[0], pts[-1]) < 1e-6:
        pts.pop()
    return pts


def item_polylines(item: dict) -> list[tuple[list[tuple[float, float]], bool]]:
    out = []
    for path in item.get("paths") or []:
        pts = flatten_path(path)
        if len(pts) >= 2:
            out.append((pts, bool(path.get("closed")) and len(pts) >= 3))
    return out


# ------------------------------------------------------------------ 几何

def _valid(poly: Polygon):
    if poly.is_valid:
        return poly
    fixed = poly.buffer(0)
    return fixed


def cut_solid(sketch: dict):
    """切割闭合路径按奇偶规则组成的实体（shapely 几何，可能为空）."""
    geom = None
    for item in sketch.get("items") or []:
        if item.get("mode", "cut") != "cut":
            continue
        for pts, closed in item_polylines(item):
            if not closed:
                continue
            poly = _valid(Polygon(pts))
            if poly.is_empty:
                continue
            geom = poly if geom is None else geom.symmetric_difference(poly)
    if geom is None:
        return Polygon()
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
    有连接点（item["bridges"]）的轮廓在连接点处断开，留下 bridge_w 宽的材料不切。"""
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
            # 从第一个连接点之后开始，逐段输出（跳过每个连接点两侧 gap/2）
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


def draw(box: Any, sketch: dict, burn: float = 0.0, cut: bool = True, marks: bool = True) -> None:
    """在当前零件、当前坐标系（从外面看）里画出草图。调用前设好 surface._p 和 ctx._m.
    cut / marks：是否画切割部分 / 雕刻和划线部分（共边切割时切割部分另外画）。"""
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
        for pts, closed, outer in cut_polylines(sketch, burn):
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
    box.set_source_color(Color.BLACK)


# ------------------------------------------------------------------ 编辑辅助（前端调用）

def offset(paths: list[dict], distance: float, join: str = "round") -> list[list[tuple[float, float]]]:
    """闭合路径整体外扩（distance > 0）/ 内缩；开放路径变成两侧等距的闭合轮廓."""
    js = {"round": 1, "miter": 2, "bevel": 3}.get(join, 1)
    geoms = []
    for path in paths:
        pts = flatten_path(path)
        if len(pts) < 2:
            continue
        if path.get("closed") and len(pts) >= 3:
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
