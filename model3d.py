"""SeedBoxes 3D 模型与局部修改.

boxes 的 Surface 会把每个零件（一次 move(before=True) 到 move(after) 之间画的
东西）存成独立的 Part。我们在渲染时给实例挂钩 move / rectangularWall，记录：
  - 每个 Part 的局部坐标系矩阵（ctx._m）
  - rectangularWall 的名义尺寸 (x, y)、四条边类型
这样就能把每块板的精确轮廓（含卡榫）换算到「名义矩形」坐标系
（左下角为原点、单位 mm、y 向上），再按组装配方摆到 3D 里。

不修改 boxes 上游源码：全部通过实例属性覆盖实现。
"""
from __future__ import annotations

import math
from functools import lru_cache as functools_lru_cache
from dataclasses import dataclass, field
from typing import Any

from affine import Affine

# boxes Color 常量（避免循环导入，直接写值）
_ANNOTATION_RGB = (1.0, 0.0, 0.0)
_ETCH_RGBS = {(0.0, 1.0, 0.0), (0.0, 1.0, 1.0)}

_BEZIER_STEPS = 8
_EPS = 1e-3


@dataclass
class PartInfo:
    """一块零件的记录信息."""

    part: Any                      # boxes.drawing.Part
    kind: str                      # "rect"（rectangularWall）或 "other"
    matrix: Affine                 # 名义坐标 → 图纸坐标
    width: float                   # 名义宽度（rect）或整体宽度（other）
    height: float
    edges: str = ""                # rect：底、右、顶、左 四条边的类型字符
    label: str = ""
    seq: int = 0                   # 绘制顺序
    edge_objs: list = field(default_factory=list)


class Recorder:
    """挂到 boxes 实例上，记录每个零件的坐标系."""

    def __init__(self, box: Any) -> None:
        self.box = box
        self.infos: list[PartInfo] = []
        self._pending: list[dict] = []
        self._orig_move = box.move
        self._orig_rect = box.rectangularWall
        box.move = self._move           # 实例属性覆盖类方法
        box.rectangularWall = self._rect_wall

    # ------------------------------------------------------------ hooks

    def _rect_wall(self, x, y, edges="eeee", ignore_widths=[], *args, **kw):
        edges_list = list(edges) if isinstance(edges, str) else list(edges)
        self._pending.append({
            "kind": "rect", "x": float(x), "y": float(y),
            "edges": edges_list, "ignore": list(ignore_widths),
            "label": kw.get("label", ""),
        })
        depth = len(self._pending)
        try:
            return self._orig_rect(x, y, edges, ignore_widths, *args, **kw)
        finally:
            # move "only" 时不会消费 pending，这里统一清理
            del self._pending[depth - 1:]

    def _move(self, x, y, where, before=False, label=""):
        box = self.box
        result = self._orig_move(x, y, where, before=before, label=label)
        try:
            self._record(x, y, where, before, label, result)
        except Exception:
            pass  # 记录失败不能影响正常渲染
        return result

    def _record(self, x, y, where, before, label, result) -> None:
        box = self.box
        if before and not result:
            pend = self._pending[-1] if self._pending and not self._pending[-1].get("used") else None
            m = box.ctx._m
            terms = (where or "").split()
            if pend is not None:
                pend["used"] = True
                edges = [box.edges.get(e, e) for e in pend["edges"]]
                dx = 0.0 if 7 in pend["ignore"] else edges[3].spacing()
                # 名义（内部）矩形：边线在内部空间外 startwidth 处，起笔点在 margin 处
                dy = edges[0].margin() + edges[0].startwidth()
                info = PartInfo(
                    part=box.surface._p, kind="rect",
                    matrix=m * Affine.translation(dx, dy),
                    width=pend["x"], height=pend["y"],
                    edges="".join((getattr(e, "char", None) or "?") for e in edges),
                    label=pend["label"] or label, edge_objs=edges,
                )
            else:
                w, h = float(x), float(y)
                if "rotated" in terms:
                    w, h = h, w
                info = PartInfo(part=box.surface._p, kind="other", matrix=m,
                                width=w, height=h, label=label)
            info.seq = len(self.infos)
            self.infos.append(info)

    def detach(self) -> None:
        for name in ("move", "rectangularWall"):
            self.box.__dict__.pop(name, None)

    # ------------------------------------------------------------ geometry

    def info_for(self, part: Any) -> PartInfo | None:
        # 同一个 Part 可能被多次 move（空 Part 复用）；取最后一次
        found = None
        for info in self.infos:
            if info.part is part:
                found = info
        return found

    def extract(self) -> list[dict]:
        """返回每个有内容零件的几何（名义坐标系）."""
        box = self.box
        try:
            box.ctx.stroke()
        except Exception:
            pass
        out = []
        for idx, part in enumerate(box.surface.parts):
            if not part.pathes:
                continue
            info = self.info_for(part)
            if info is None:
                # 没经过 move() 直接画的内容（部分生成器如此）：按图纸坐标处理
                is_ref = any(c[0] == "T" and "burn:" in str(c[4])
                             for path in part.pathes for c in path.path)
                info = PartInfo(part=part, kind="other", matrix=Affine.identity(),
                                width=0.0, height=0.0, seq=1000 + idx,
                                label="校准尺" if is_ref else "")
            inv = ~info.matrix
            loops_cut, loops_etch, open_lines = [], [], []
            for path in part.pathes:
                rgb = tuple(float(c) for c in path.params.get("rgb", (0, 0, 0)))
                if _close_rgb(rgb, _ANNOTATION_RGB):
                    continue
                etch = any(_close_rgb(rgb, e) for e in _ETCH_RGBS)
                for poly in _path_to_polylines(path.path):
                    pts = [inv * p for p in poly]
                    if len(pts) < 2:
                        continue
                    closed = len(pts) > 2 and _dist(pts[0], pts[-1]) < 0.05
                    if closed:
                        pts = pts[:-1]
                        (loops_etch if etch else loops_cut).append(pts)
                    else:
                        open_lines.append(pts)
            if not loops_cut:
                continue
            # 最大面积的闭合轮廓为外轮廓，其余为孔
            loops_cut.sort(key=lambda l: abs(_area(l)), reverse=True)
            outer = loops_cut[0]
            holes = _merge_holes([l for l in loops_cut[1:] if _inside(l[0], outer)])
            extra = [l for l in loops_cut[1:] if not _inside(l[0], outer)]
            bb = _bbox(outer)
            w = info.width or (bb[2] - bb[0])
            h = info.height or (bb[3] - bb[1])
            out.append({
                "index": idx, "seq": info.seq, "kind": info.kind,
                "w": round(w, 4), "h": round(h, 4),
                "edges": info.edges, "label": info.label,
                "outer": _round_pts(_ccw(outer)),
                "holes": [_round_pts(_cw(h)) for h in holes],
                "extra": [_round_pts(l) for l in extra],
                "etch": [_round_pts(l) for l in loops_etch],
                "lines": [_round_pts(l) for l in open_lines],
                "bbox": _bbox(outer),
            })
        return out


# ------------------------------------------------------------------ helpers

def _merge_holes(holes):
    """重叠的孔合并成一个（如 TypeTray 提手孔与隔板卡榫孔）。
    实际切割时它们本来就连通；不合并的话 3D 三角剖分会出错。"""
    if len(holes) < 2:
        return holes
    try:
        from shapely.geometry import Polygon
        from shapely.ops import unary_union
    except Exception:
        return holes
    polys = []
    for h in holes:
        try:
            pg = Polygon(h)
            if not pg.is_valid:
                pg = pg.buffer(0)
            if not pg.is_empty:
                polys.append(pg)
        except Exception:
            continue
    # 快速路径：互不相交时原样返回
    overlap = False
    for i in range(len(polys)):
        for j in range(i + 1, len(polys)):
            if polys[i].intersects(polys[j]):
                overlap = True
                break
        if overlap:
            break
    if not overlap:
        return holes
    merged = unary_union(polys)
    geoms = getattr(merged, "geoms", [merged])
    return [list(g.exterior.coords)[:-1] for g in geoms if not g.is_empty]


def _close_rgb(a, b) -> bool:
    return all(abs(x - y) < 1e-3 for x, y in zip(a, b))


def _dist(a, b) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


def _path_to_polylines(cmds) -> list[list[tuple[float, float]]]:
    polys: list[list[tuple[float, float]]] = []
    cur: list[tuple[float, float]] = []
    for c in cmds:
        op = c[0]
        if op == "M":
            if len(cur) > 1:
                polys.append(cur)
            cur = [(c[1], c[2])]
        elif op == "L":
            if not cur:
                cur = [(c[1], c[2])]
            else:
                cur.append((c[1], c[2]))
        elif op == "C":
            if not cur:
                cur = [(c[1], c[2])]
                continue
            x0, y0 = cur[-1]
            x3, y3, x1, y1, x2, y2 = c[1], c[2], c[3], c[4], c[5], c[6]
            for i in range(1, _BEZIER_STEPS + 1):
                t = i / _BEZIER_STEPS
                mt = 1 - t
                cur.append((
                    mt**3 * x0 + 3 * mt**2 * t * x1 + 3 * mt * t**2 * x2 + t**3 * x3,
                    mt**3 * y0 + 3 * mt**2 * t * y1 + 3 * mt * t**2 * y2 + t**3 * y3,
                ))
        # "T"（文字）忽略
    if len(cur) > 1:
        polys.append(cur)
    return polys


def _area(pts) -> float:
    s = 0.0
    for i in range(len(pts)):
        x1, y1 = pts[i]
        x2, y2 = pts[(i + 1) % len(pts)]
        s += x1 * y2 - x2 * y1
    return s / 2


def _ccw(pts):
    return pts if _area(pts) > 0 else list(reversed(pts))


def _cw(pts):
    return pts if _area(pts) < 0 else list(reversed(pts))


def _inside(p, poly) -> bool:
    x, y = p
    inside = False
    n = len(poly)
    for i in range(n):
        x1, y1 = poly[i]
        x2, y2 = poly[(i + 1) % n]
        if (y1 > y) != (y2 > y):
            xi = x1 + (y - y1) * (x2 - x1) / (y2 - y1)
            if xi > x:
                inside = not inside
    return inside


def _bbox(pts):
    xs = [p[0] for p in pts]
    ys = [p[1] for p in pts]
    return [round(min(xs), 3), round(min(ys), 3), round(max(xs), 3), round(max(ys), 3)]


def _round_pts(pts):
    return [[round(x, 3), round(y, 3)] for x, y in pts]


# ================================================================== 组装配方
#
# 世界坐标（单位 mm）：x 向右、y 向后（前面板在 y=0）、z 向上。
# 内部空间为 [0,X]×[0,Y]×[0,H]，板材贴在内部空间外侧，厚度 t 向外。
#
# boxes 的约定（由 TypeTray 隔板孔位一致性推得）：四面墙和底板按「从盒内看」
# 绘制，顶板按「从上方看」绘制。下面每个面给出 局部 (u, v, w) → 世界 的映射，
# w ∈ [0, t] 为厚度方向（0 = 内表面，t = 外表面）。
#
#   mirror=True 表示图纸视角与「从外面看」左右相反；局部修改编辑器以「从外面看」
#   显示，导出时会把整块板翻面（见 apply_project）。

# face: (u 方向, v 方向, w 方向, 原点(用 X/Y/H 表达), mirror)
_FACES = {
    "front":  ((-1, 0, 0), (0, 0, 1), (0, -1, 0), ("X", 0, 0), True),
    "back":   ((1, 0, 0),  (0, 0, 1), (0, 1, 0),  (0, "Y", 0), True),
    "left":   ((0, 1, 0),  (0, 0, 1), (-1, 0, 0), (0, 0, 0),   True),
    "right":  ((0, -1, 0), (0, 0, 1), (1, 0, 0),  ("X", "Y", 0), True),
    "bottom": ((1, 0, 0),  (0, 1, 0), (0, 0, -1), (0, 0, 0),   True),
    "top":    ((1, 0, 0),  (0, 1, 0), (0, 0, 1),  (0, 0, "H"), False),
}

FACE_NAMES = {
    "front": "前板", "back": "后板", "left": "左侧板", "right": "右侧板",
    "bottom": "底板", "top": "顶板",
}

# 生成器标签 → 面
_LABEL_FACE = {
    "front": "front", "back": "back", "left": "left", "right": "right",
    "left side": "left", "right side": "right",
    "bottom": "bottom", "top": "top", "base": "bottom",
    "wall 1": "front", "wall 2": "right", "wall 3": "back", "wall 4": "left",
}

SUPPORTED_3D = {"ABox", "ClosedBox", "UniversalBox", "BasedBox", "TypeTray"}

# 自动装配能通过碰撞校验、但人工看过结果不对的生成器（继续平铺显示）
AUTO_DENY = {"HingeBox", "OrganPipe", "Rotary", "PirateChest",
             "Arcade", "CanStorage", "CoinDisplay", "DiceBox", "WallRack"}


def _box_dims(name: str, box: Any) -> tuple[float, float, float] | None:
    t = box.thickness
    if name == "TypeTray":
        x = sum(box.sx) + t * (len(box.sx) - 1)
        y = sum(box.sy) + t * (len(box.sy) - 1)
        return x, y, float(box.h)
    if name in ("ClosedBox", "BasedBox"):
        # 这两个生成器在 render 里用局部变量做 adjustSize，不回写 self.x
        x, y, h = box.x, box.y, box.h
        if box.outside:
            x, y, h = box.adjustSize(x), box.adjustSize(y), box.adjustSize(h)
        return x, y, h
    return float(box.x), float(box.y), float(box.h)


def _face_matrix(face: str, X: float, Y: float, H: float, offset=(0, 0, 0)) -> list[float]:
    """4×4 列主序矩阵（three.js Matrix4.fromArray 格式）."""
    u, v, w, o, _m = _FACES[face]
    sub = {"X": X, "Y": Y, "H": H}
    ox, oy, oz = (sub.get(c, c) if isinstance(c, str) else c for c in o)
    ox += offset[0]
    oy += offset[1]
    oz += offset[2]
    return [*u, 0, *v, 0, *w, 0, ox, oy, oz, 1]


def _matrix(u, v, w, origin) -> list[float]:
    return [*u, 0, *v, 0, *w, 0, *origin, 1]


def _close(a: float, b: float, tol: float = 0.01) -> bool:
    return abs(a - b) <= tol


def assemble(name: str, box: Any, parts: list[dict]) -> dict:
    """给每块零件分配 id / 中文名 / 3D 矩阵。修改 parts 原地，返回汇总信息."""
    t = float(box.thickness)
    dims = _box_dims(name, box) if name in SUPPORTED_3D else None
    assembled = dims is not None
    used: set[str] = set()
    floating: list[dict] = []

    if assembled:
        X, Y, H = dims
        inner_x = inner_y = 0
        xs = ys = []
        if name == "TypeTray":
            xs = [sum(box.sx[:i + 1]) + i * t for i in range(len(box.sx) - 1)]
            ys = [sum(box.sy[:i + 1]) + i * t for i in range(len(box.sy) - 1)]
        for p in parts:
            face = None
            label = (p.get("label") or "").strip().lower()
            if p["kind"] == "rect":
                if label.startswith("inner x") and name == "TypeTray" and inner_x < len(ys):
                    yy = ys[inner_x]
                    inner_x += 1
                    p.update(id=f"inner-x-{inner_x}", name=f"横隔板 {inner_x}", face=None,
                             mirror=False, matrix=_matrix((1, 0, 0), (0, 0, 1), (0, 1, 0), (0, yy, 0)))
                    continue
                if label.startswith("inner y") and name == "TypeTray" and inner_y < len(xs):
                    xx = xs[inner_y]
                    inner_y += 1
                    p.update(id=f"inner-y-{inner_y}", name=f"纵隔板 {inner_y}", face=None,
                             mirror=False, matrix=_matrix((0, 1, 0), (0, 0, 1), (1, 0, 0), (xx, 0, 0)))
                    continue
                cand = _LABEL_FACE.get(label)
                if cand and cand not in used:
                    face = cand
                elif not label or label in ("wall", ""):
                    face = _face_by_shape(p, X, Y, H, used)
            if face:
                used.add(face)
                p.update(id=face, name=FACE_NAMES[face], face=face,
                         mirror=_FACES[face][4],
                         matrix=_face_matrix(face, X, Y, H))
            else:
                floating.append(p)
        _layout_flat(floating, start_x=X + 30 + t, z=-t - 0.5, prefix="extra", grid=True)
        bounds = [-t, -t, -t, X + t, Y + t, H + t]
    else:
        auto = None
        if name not in AUTO_DENY:
            try:
                auto = auto_assemble(parts, t)
            except Exception:
                auto = None
        if auto is not None:
            return auto
        for p in parts:
            for k in ("id", "name", "face", "mirror", "matrix"):
                p.pop(k, None)
        _layout_flat(parts, start_x=0, z=0, prefix="part", grid=True)
        X = Y = H = 0.0
        bounds = None
    return {"assembled": assembled, "dims": [X, Y, H] if assembled else None,
            "thickness": t, "bounds": bounds}


def _face_by_shape(p: dict, X, Y, H, used) -> str | None:
    """无标签时按边类型 + 尺寸判断面。
    四边同型（ffff / hhhh）→ 底/顶板；侧边 F（卡榫凸出）→ 前/后；侧边 f → 左/右。"""
    w, h, e = p["w"], p["h"], p.get("edges") or "????"
    if len(e) == 4 and e[0] == e[1] == e[2] == e[3] and e[0] != "?":
        order = ["bottom", "top"]
    elif e[1:2] == "F" and e[3:4] == "F":
        order = ["front", "back"]
    elif e[1:2] == "f" and e[3:4] == "f":
        order = ["left", "right"]
    else:
        order = ["front", "back", "left", "right", "bottom", "top"]
    size = {"front": (X, H), "back": (X, H), "left": (Y, H), "right": (Y, H),
            "bottom": (X, Y), "top": (X, Y)}
    for face in order:
        a, b = size[face]
        if face not in used and _close(w, a) and _close(h, b):
            return face
    return None


def _layout_flat(parts: list[dict], start_x: float, z: float, prefix: str, grid: bool = False) -> None:
    """把零件平铺在地面（z 平面）上，图纸朝上."""
    if not parts:
        return
    gap = 10.0
    if grid:
        total = sum((p["bbox"][2] - p["bbox"][0] + gap) * (p["bbox"][3] - p["bbox"][1] + gap) for p in parts)
        row_w = max(math.sqrt(total) * 1.3, max(p["bbox"][2] - p["bbox"][0] for p in parts))
    else:
        row_w = float("inf")
    x, y, row_h = start_x, 0.0, 0.0
    n = 0
    for p in parts:
        if p.get("label") != "校准尺":
            n += 1
        bx0, by0, bx1, by1 = p["bbox"]
        pw, ph = bx1 - bx0, by1 - by0
        if grid and x > start_x and x + pw > start_x + row_w:
            x, y, row_h = start_x, y + row_h + gap, 0.0
        if p.get("label") == "校准尺":
            p.setdefault("id", "reference")
        p.setdefault("id", f"{prefix}-{p['seq'] + 1}")
        p.setdefault("name", _part_name(p, n))
        p.update(face=None, mirror=False,
                 matrix=_matrix((1, 0, 0), (0, 1, 0), (0, 0, 1), (x - bx0, y - by0, z)))
        x += pw + gap
        row_h = max(row_h, ph)


def _part_name(p: dict, n: int) -> str:
    label = (p.get("label") or "").strip()
    if label:
        try:
            import backend  # 延迟导入，避免循环
            return backend.tr(label)
        except Exception:
            return label
    return f"零件 {n}"


# ================================================================== 局部修改
#
# 编辑（edit）坐标系：「从外面看」这块板，原点 = 内部矩形左下角，单位 mm，y 向上。
#   {"id", "type": "circle"|"rect"|"rrect"|"text", "x", "y"（中心）,
#    "w", "h", "d"（圆直径）, "r"（圆角半径）, "angle"（度）,
#    "mode": "cut"|"engrave", "text", "size"（字高 mm）, "font"（字体 id）}
#
# 项目（project）：{"disabled": [part id...], "edits": {part id: [edit...]}}

_CIRCLE_SEGMENTS = 72


def _rot(pts, cx, cy, angle_deg):
    if not angle_deg:
        return pts
    a = math.radians(angle_deg)
    ca, sa = math.cos(a), math.sin(a)
    return [(cx + (x - cx) * ca - (y - cy) * sa, cy + (x - cx) * sa + (y - cy) * ca) for x, y in pts]


def _rounded_rect(cx, cy, w, h, r):
    r = max(0.0, min(r, w / 2, h / 2))
    if r <= 1e-6:
        return [(cx - w / 2, cy - h / 2), (cx + w / 2, cy - h / 2),
                (cx + w / 2, cy + h / 2), (cx - w / 2, cy + h / 2)]
    pts = []
    steps = 12
    corners = [(cx + w / 2 - r, cy - h / 2 + r, -90), (cx + w / 2 - r, cy + h / 2 - r, 0),
               (cx - w / 2 + r, cy + h / 2 - r, 90), (cx - w / 2 + r, cy - h / 2 + r, 180)]
    for ox, oy, start in corners:
        for i in range(steps + 1):
            a = math.radians(start + 90 * i / steps)
            pts.append((ox + r * math.cos(a), oy + r * math.sin(a)))
    return pts


def edit_polygons(edit: dict, burn: float = 0.0) -> tuple[list[list[tuple[float, float]]], list[str]]:
    """返回 (闭合多边形列表, 缺字列表)。切割孔按 burn（激光补偿）向内收."""
    typ = edit.get("type")
    cx, cy = float(edit.get("x", 0)), float(edit.get("y", 0))
    ang = float(edit.get("angle", 0) or 0)
    cut = edit.get("mode", "cut") == "cut"
    b = burn if cut else 0.0
    if typ == "circle":
        r = max(0.05, float(edit.get("d", 10)) / 2 - b)
        pts = [(cx + r * math.cos(2 * math.pi * i / _CIRCLE_SEGMENTS),
                cy + r * math.sin(2 * math.pi * i / _CIRCLE_SEGMENTS)) for i in range(_CIRCLE_SEGMENTS)]
        return [pts], []
    if typ in ("rect", "rrect"):
        w = max(0.1, float(edit.get("w", 20)) - 2 * b)
        h = max(0.1, float(edit.get("h", 10)) - 2 * b)
        r = float(edit.get("r", 3)) - b if typ == "rrect" else 0.0
        return [_rot(_rounded_rect(cx, cy, w, h, r), cx, cy, ang)], []
    if typ == "text":
        polys, missing = text_polygons(str(edit.get("text", "")), edit.get("font") or "",
                                       float(edit.get("size", 10)))
        polys = [[(cx + x, cy + y) for x, y in p] for p in polys]
        return [_rot(p, cx, cy, ang) for p in polys], missing
    return [], []


# ------------------------------------------------------------------ 字体

def _font_candidates() -> list[tuple[str, str, int]]:
    """(显示名, 路径, ttc 序号)。只列出存在的文件."""
    import os
    import sys
    c: list[tuple[str, str, int]] = []
    if sys.platform == "win32":
        root = os.path.join(os.environ.get("WINDIR", r"C:\\Windows"), "Fonts")
        c += [("微软雅黑", os.path.join(root, "msyh.ttc"), 0),
              ("微软雅黑 粗体", os.path.join(root, "msyhbd.ttc"), 0),
              ("黑体", os.path.join(root, "simhei.ttf"), 0),
              ("宋体", os.path.join(root, "simsun.ttc"), 0),
              ("楷体", os.path.join(root, "simkai.ttf"), 0),
              ("仿宋", os.path.join(root, "simfang.ttf"), 0)]
    elif sys.platform == "darwin":
        for root in ("/System/Library/Fonts", "/Library/Fonts", "/System/Library/Fonts/Supplemental"):
            c += [("苹方", os.path.join(root, "PingFang.ttc"), 0),
                  ("华文黑体", os.path.join(root, "STHeiti Medium.ttc"), 0),
                  ("华文细黑", os.path.join(root, "STHeiti Light.ttc"), 0),
                  ("冬青黑体", os.path.join(root, "Hiragino Sans GB.ttc"), 0),
                  ("宋体-简", os.path.join(root, "Songti.ttc"), 0)]
    else:
        for root in ("/usr/share/fonts/opentype/noto", "/usr/share/fonts/noto-cjk",
                     "/usr/share/fonts/google-noto-cjk"):
            c += [("思源黑体", os.path.join(root, "NotoSansCJK-Regular.ttc"), 2),
                  ("思源黑体 粗体", os.path.join(root, "NotoSansCJK-Bold.ttc"), 2),
                  ("思源宋体", os.path.join(root, "NotoSerifCJK-Regular.ttc"), 2)]
        c.append(("Droid Sans Fallback", "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf", 0))
    # 用户自带字体：项目 fonts/ 目录
    here = os.path.dirname(os.path.abspath(__file__))
    user_dir = os.path.join(getattr(sys, "_MEIPASS", here), "fonts")
    if os.path.isdir(user_dir):
        for fn in sorted(os.listdir(user_dir)):
            if fn.lower().endswith((".ttf", ".otf", ".ttc")):
                c.append((os.path.splitext(fn)[0], os.path.join(user_dir, fn), 0))
    seen, out = set(), []
    for name, path, idx in c:
        if path not in seen and os.path.isfile(path):
            seen.add(path)
            out.append((name, path, idx))
    return out


def list_fonts() -> list[dict]:
    return [{"id": f"{path}#{idx}", "name": name} for name, path, idx in _font_candidates()]


_FONT_CACHE: dict[str, Any] = {}


def _load_font(font_id: str):
    from fontTools.ttLib import TTFont
    if not font_id:
        cands = _font_candidates()
        if not cands:
            raise ValueError("找不到可用的中文字体")
        font_id = f"{cands[0][1]}#{cands[0][2]}"
    if font_id not in _FONT_CACHE:
        path, _, idx = font_id.rpartition("#")
        if not path:
            path, idx = font_id, "0"
        import os
        if not os.path.isfile(path):
            # 项目文件来自别的电脑：字体不存在时用本机第一个中文字体
            cands = _font_candidates()
            if not cands:
                raise ValueError("找不到可用的中文字体")
            path, idx = cands[0][1], str(cands[0][2])
        font = TTFont(path, fontNumber=int(idx or 0), lazy=True)
        _FONT_CACHE[font_id] = font
    return _FONT_CACHE[font_id]


class _FlattenPen:
    """fontTools pen：把字形轮廓展平成多边形."""

    def __init__(self, glyph_set, steps: int = 6):
        from fontTools.pens.basePen import BasePen

        outer = self

        class _P(BasePen):
            def _moveTo(self, pt):
                outer._start(pt)

            def _lineTo(self, pt):
                outer.cur.append(pt)

            def _curveToOne(self, p1, p2, p3):
                p0 = outer.cur[-1]
                for i in range(1, steps + 1):
                    t = i / steps
                    mt = 1 - t
                    outer.cur.append((
                        mt**3 * p0[0] + 3 * mt**2 * t * p1[0] + 3 * mt * t**2 * p2[0] + t**3 * p3[0],
                        mt**3 * p0[1] + 3 * mt**2 * t * p1[1] + 3 * mt * t**2 * p2[1] + t**3 * p3[1]))

            def _qCurveToOne(self, p1, p2):
                p0 = outer.cur[-1]
                for i in range(1, steps + 1):
                    t = i / steps
                    mt = 1 - t
                    outer.cur.append((mt**2 * p0[0] + 2 * mt * t * p1[0] + t**2 * p2[0],
                                      mt**2 * p0[1] + 2 * mt * t * p1[1] + t**2 * p2[1]))

            def _closePath(self):
                outer._finish()

            def _endPath(self):
                outer._finish()

        self.pen = _P(glyph_set)
        self.cur: list = []
        self.polys: list = []

    def _start(self, pt):
        self._finish()
        self.cur = [pt]

    def _finish(self):
        if len(self.cur) > 2:
            self.polys.append(self.cur)
        self.cur = []


@functools_lru_cache(maxsize=256)
def _text_polygons_cached(text: str, font_id: str, size: float):
    font = _load_font(font_id)
    cmap = font.getBestCmap() or {}
    gs = font.getGlyphSet()
    upm = font["head"].unitsPerEm
    hhea = font["hhea"]
    scale = size / upm
    polys, missing = [], []
    x = 0.0
    for ch in text:
        gname = cmap.get(ord(ch))
        if gname is None:
            if not ch.isspace():
                missing.append(ch)
            x += upm * 0.5
            continue
        g = gs[gname]
        pen = _FlattenPen(gs)
        g.draw(pen.pen)
        pen._finish()
        for poly in pen.polys:
            polys.append([(x + px, py) for px, py in poly])
        x += g.width
    # 水平居中；垂直以 (ascent + descent) / 2 居中
    mid_y = (hhea.ascent + hhea.descent) / 2
    out = [tuple((round((px - x / 2) * scale, 3), round((py - mid_y) * scale, 3)) for px, py in p)
           for p in polys]
    return tuple(out), tuple(missing)


def text_polygons(text: str, font_id: str, size: float):
    if not text.strip():
        return [], []
    polys, missing = _text_polygons_cached(text, font_id or "", round(size, 3))
    return [list(p) for p in polys], list(missing)


# ================================================================== 导出注入

def apply_project(name: str, box: Any, rec: Recorder, project: dict | None) -> list[str]:
    """把局部修改画进 boxes 的零件里，并移除禁用的零件。在 render() 之后、close() 之前调用。
    返回提示信息（如缺字）."""
    notes: list[str] = []
    if not project:
        return notes
    disabled = set(project.get("disabled") or [])
    edits = project.get("edits") or {}
    if not disabled and not any(edits.values()):
        return notes

    parts = rec.extract()
    assemble(name, box, parts)
    by_index = {p["index"]: p for p in parts}
    surface = box.surface
    ctx = box.ctx
    burn = float(getattr(box, "burn", 0) or 0)
    from boxes.Color import Color

    to_remove = []
    last_p = surface._p
    for idx, part in enumerate(surface.parts):
        meta = by_index.get(idx)
        if meta is None:
            continue
        if meta["id"] in disabled:
            to_remove.append(part)
            continue
        part_edits = [e for e in edits.get(meta["id"], []) if e]
        if not part_edits:
            continue
        info = rec.info_for(part)
        m = info.matrix if info is not None else Affine.identity()
        if meta.get("mirror"):
            # 整块板翻面：图纸视角变成「从外面看」，组装时雕刻面朝外
            flip = m * Affine.translation(meta["w"], 0) * Affine.scale(-1, 1) * ~m
            for path in part.pathes:
                path.transform(1, flip)
        surface._p = part
        ctx.save()
        ctx._m = m
        ctx._xy = (0, 0)
        ctx._mxy = m * (0, 0)
        for e in part_edits:
            polys, missing = edit_polygons(e, burn)
            if missing:
                notes.append(f"{meta['name']}：字体缺少「{''.join(missing)}」")
            color = Color.INNER_CUT if e.get("mode", "cut") == "cut" else Color.ETCHING
            box.set_source_color(color)
            for poly in polys:
                ctx.move_to(*poly[0])
                for pt in poly[1:]:
                    ctx.line_to(*pt)
                ctx.line_to(*poly[0])
                ctx.stroke()
        box.set_source_color(Color.BLACK)
        ctx.restore()
    surface._p = last_p
    for part in to_remove:
        surface.parts.remove(part)
    return notes


# ================================================================== 自动装配（试验）
#
# 没写配方的生成器：按 rectangularWall 板的尺寸推断盒子内部尺寸 X/Y/H，
# 逐块板尝试放到 6 个面（含旋转 90° / 翻面），在每块板的卡榫区域密集取样，
# 检查与已放置的板「不穿透、有接触」。全部通过且连通才认为装配成功。

_FACE_DIMS = {"front": ("X", "H"), "back": ("X", "H"), "left": ("Y", "H"),
              "right": ("Y", "H"), "bottom": ("X", "Y"), "top": ("X", "Y")}


def _np_matrix(cols16):
    import numpy as np
    return np.array(cols16, dtype=float).reshape(4, 4).T   # 列主序 → 行主序


def _variants(pw, ph, fu, fv):
    """板（宽 pw、高 ph）放到面（u 长 fu、v 长 fv）上的局部变换候选：(4×4, flip)."""
    import numpy as np
    out = []
    if _close(pw, fu) and _close(ph, fv):
        out.append((np.eye(4), False))
        # 翻面：绕 v 轴转 180°（u → W-u, w → t-w）在调用处补 t
        out.append((np.array([[-1, 0, 0, pw], [0, 1, 0, 0], [0, 0, -1, 0], [0, 0, 0, 1]], float), True))
    if _close(pw, fv) and _close(ph, fu):
        out.append((np.array([[0, 1, 0, 0], [-1, 0, 0, pw], [0, 0, 1, 0], [0, 0, 0, 1]], float), False))
        out.append((np.array([[0, -1, 0, ph], [1, 0, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], float), False))
    return out


class _Solid:
    """一块板的碰撞检测数据."""

    def __init__(self, p: dict, t: float):
        import numpy as np
        import shapely
        from shapely.geometry import Polygon
        self.p = p
        self.t = t
        poly = Polygon(p["outer"], [h for h in p["holes"] if len(h) >= 3])
        if not poly.is_valid:
            poly = poly.buffer(0)
        self.poly = poly
        self.shrunk = poly.buffer(-0.08)
        self.grown = poly.buffer(0.6)
        # 只在卡榫可能出现的边缘带取样
        band = poly.difference(poly.buffer(-1.6 * t))
        x0, y0, x1, y1 = poly.bounds
        step = max(0.5, min(1.0, t / 3))
        xs = np.arange(x0 + step / 2, x1, step)
        ys = np.arange(y0 + step / 2, y1, step)
        gx, gy = np.meshgrid(xs, ys)
        gx, gy = gx.ravel(), gy.ravel()
        keep = shapely.contains_xy(band, gx, gy)
        gx, gy = gx[keep], gy[keep]
        if len(gx) > 8000:
            idx = np.random.default_rng(0).choice(len(gx), 8000, replace=False)
            gx, gy = gx[idx], gy[idx]
        self.local = np.stack([gx, gy, np.full_like(gx, t / 2), np.ones_like(gx)])
        self.M = None
        self.Minv = None
        self.world = None

    def place(self, M):
        import numpy as np
        self.M = M
        self.Minv = np.linalg.inv(M)
        self.world = M @ self.local

    def hits(self, other: "_Solid"):
        """(穿透点数, 接触点数)：self 的取样点落在 other 实体里 / 贴着 other."""
        import shapely
        q = other.Minv @ self.world
        u, v, w = q[0], q[1], q[2]
        t = other.t
        inside_w = (w > 0.03 * t) & (w < 0.97 * t)
        near_w = (w > -0.6) & (w < t + 0.6)
        if not near_w.any():
            return 0, 0
        sel = near_w
        col = 0
        if (inside_w & sel).any():
            m = inside_w
            col = int(shapely.contains_xy(other.shrunk, u[m], v[m]).sum())
        con = int(shapely.contains_xy(other.grown, u[sel], v[sel]).sum())
        return col, con


def _infer_dims(rect_parts):
    import itertools
    vals = sorted({round(v, 3) for p in rect_parts for v in (p["w"], p["h"])})
    if len(vals) > 18:
        return []
    cands = []
    for X, Y, H in itertools.product(vals, repeat=3):
        n = {"xh": 0, "yh": 0, "xy": 0}
        for p in rect_parts:
            dims = {(round(p["w"], 3), round(p["h"], 3)), (round(p["h"], 3), round(p["w"], 3))}
            if (X, H) in dims:
                n["xh"] += 1
            elif (Y, H) in dims:
                n["yh"] += 1
            elif (X, Y) in dims:
                n["xy"] += 1
        if n["xh"] and n["yh"] and n["xh"] + n["yh"] + n["xy"] >= 4:
            score = min(n["xh"], 2) + min(n["yh"], 2) + min(n["xy"], 2)
            cands.append((score, X * Y * H, (X, Y, H)))
    cands.sort(reverse=True)
    return [c[2] for c in cands[:8]]


def self_place(p, placed, used, contacts, solids, sub, X, Y, H, t) -> bool:
    """把一块板放到最合适的面上；成功返回 True."""
    import numpy as np
    s = solids[id(p)]
    best = None
    for face, (a, b) in _FACE_DIMS.items():
        if face in used:
            continue
        fu, fv = sub[a], sub[b]
        F = _np_matrix(_face_matrix(face, X, Y, H))
        for L, flip in _variants(p["w"], p["h"], fu, fv):
            if flip:
                L = L.copy()
                L[2, 3] = t
            s.place(F @ L)
            col = con = 0
            touching = set()
            for q, _f, qs, _m in placed:
                c1, n1 = s.hits(qs)
                c2, n2 = qs.hits(s)
                col += c1 + c2
                if n1 + n2 > 8:
                    touching.add(id(q))
                con += n1 + n2
            if col > 0:
                continue
            if placed and not touching:
                continue
            key = (len(touching), con)
            if best is None or key > best[0]:
                best = (key, face, F @ L, flip, touching)
        if best is not None and not placed:
            break   # 第一块板：任意一个合法面即可
    if best is None:
        return False
    _k, face, M, flip, touching = best
    s.place(M)
    used.add(face)
    placed.append((p, face, s, flip))
    contacts[id(p)] = set(touching)
    for q in touching:
        contacts.setdefault(q, set()).add(id(p))
    return True


def auto_assemble(parts: list[dict], t: float) -> dict | None:
    """尝试自动装配；成功时给 parts 写入 id/name/face/mirror/matrix 并返回汇总，失败返回 None."""
    import numpy as np
    rect = [p for p in parts if p["kind"] == "rect" and p.get("label") != "校准尺"
            and p["w"] > t and p["h"] > t]
    if len(rect) < 4 or len(rect) > 40:
        return None
    solids = {id(p): _Solid(p, t) for p in rect}
    best_result = None
    for X, Y, H in _infer_dims(rect):
        sub = {"X": X, "Y": Y, "H": H}
        placed: list[tuple[dict, str, _Solid, bool]] = []
        used: set[str] = set()
        contacts: dict[int, set[int]] = {}
        # 大板先放（底板 / 侧板作为基准）；放不上的（如还没有相邻板）下一轮再试
        pending = sorted(rect, key=lambda q: -q["w"] * q["h"])
        progress = True
        while progress and pending:
            progress = False
            for p in list(pending):
                if self_place(p, placed, used, contacts, solids, sub, X, Y, H, t):
                    pending.remove(p)
                    progress = True
        if len(placed) < 4 or len({f for _p, f, _s, _m in placed} & {"front", "back", "left", "right"}) < 2:
            continue
        # 连通性
        start = id(placed[0][0])
        seen, stack = {start}, [start]
        while stack:
            for nb in contacts.get(stack.pop(), ()):
                if nb not in seen:
                    seen.add(nb)
                    stack.append(nb)
        if len(seen) != len(placed):
            continue
        score = (len(placed), X * Y * H)
        if best_result is None or score > best_result[0]:
            best_result = (score, (X, Y, H), [(p, f, s.M.copy(), m) for p, f, s, m in placed])
    if best_result is None:
        return None
    _score, (X, Y, H), placed_list = best_result
    # 四面墙只缺一面时，整体绕 z 轴转，让开口朝前（面向观察者）
    walls = ["front", "right", "back", "left"]          # 绕 z 轴 +90° 时 front→right→back→left
    used_walls = {f for _p, f, _M, _m in placed_list if f in walls}
    missing = [w for w in walls if w not in used_walls]
    if len(missing) == 1 and missing[0] != "front":
        k = (4 - walls.index(missing[0])) % 4             # 转 k 次后缺的那面变成 front
        ang = math.pi / 2 * k
        c, sn = round(math.cos(ang)), round(math.sin(ang))
        Rz = np.array([[c, -sn, 0, 0], [sn, c, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1]], float)
        corners = np.array([[0, 0, 0, 1], [X, 0, 0, 1], [0, Y, 0, 1], [X, Y, 0, 1]], float).T
        rc = Rz @ corners
        Rz[0, 3], Rz[1, 3] = -rc[0].min(), -rc[1].min()
        rename = {w: walls[(i + k) % 4] for i, w in enumerate(walls)}
        placed_list = [(p, rename.get(f, f), Rz @ M, m) for p, f, M, m in placed_list]
        if k % 2:
            X, Y = Y, X
    for p, face, M, flip in placed_list:
        solids[id(p)].place(M)
    placed = [(p, f, solids[id(p)], m) for p, f, M, m in placed_list]
    if True:
        floating = []
        placed_ids = {id(p) for p, *_ in placed}
        for p, face, s, flip in placed:
            m = s.M
            p.update(id=face, name=FACE_NAMES[face], face=face,
                     mirror=_FACES[face][4] != flip,
                     matrix=[float(x) for x in m.T.ravel()])
        for p in parts:
            if id(p) not in placed_ids:
                floating.append(p)
        _layout_flat(floating, start_x=X + 30 + t, z=-t - 0.5, prefix="extra", grid=True)
        return {"assembled": True, "auto": True, "dims": [X, Y, H], "thickness": t,
                "bounds": [-t, -t, -t, X + t, Y + t, H + t],
                "placed": len(placed), "floating": len(floating)}


def check_collisions(parts: list[dict], t: float) -> int:
    """（调试用）已摆好的板两两穿透点数总和."""
    import numpy as np
    sol = []
    for p in parts:
        if p.get("face") or p.get("id", "").startswith("inner"):
            s = _Solid(p, t)
            s.place(np.array(p["matrix"], float).reshape(4, 4).T)
            sol.append(s)
    total = 0
    for i in range(len(sol)):
        for j in range(len(sol)):
            if i != j:
                total += sol[i].hits(sol[j])[0]
    return total
