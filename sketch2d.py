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

def draw(box: Any, sketch: dict, burn: float = 0.0) -> None:
    """在当前零件、当前坐标系（从外面看）里画出草图。调用前设好 surface._p 和 ctx._m."""
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

    # 切割：闭合部分整体补偿；开放线原样
    solid = cut_solid(sketch)
    if burn > 0 and not solid.is_empty:
        solid = solid.buffer(burn, join_style=2, mitre_limit=4)
    for i, p in enumerate(sorted(_polygons(solid), key=lambda q: q.area, reverse=True)):
        box.set_source_color(Color.OUTER_CUT if i == 0 else Color.INNER_CUT)
        poly(_ring(p.exterior.coords), True)
        box.set_source_color(Color.INNER_CUT)
        for r in p.interiors:
            poly(_ring(r.coords), True)
    box.set_source_color(Color.INNER_CUT)
    for item in sketch.get("items") or []:
        if item.get("mode", "cut") != "cut":
            continue
        for path in item.get("paths") or []:
            if not path.get("closed") and len(path.get("segs") or []) >= 2:
                curves(path)

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
