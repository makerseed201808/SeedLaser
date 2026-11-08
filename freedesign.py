"""自由设计：不用生成器，自己在二维草图里画板件，再到 3D 里装配检查.

作为一个特殊的 boxes 生成器（FreeDesign）注册，复用参数表单（板厚、激光补偿……）、预览和所有导出格式。
板件来自项目：project["free"] = {"parts": [{"id", "name", "w", "h"}]}，
每块板的形状在 project["sketches"][id]（格式见 sketch2d.py；坐标即板面坐标，y 向上）。
没有草图的板按 w × h 矩形处理。
"""
from __future__ import annotations

import math
from typing import Any

import boxes

import sketch2d

GAP = 6.0


def rect_sketch(w: float, h: float) -> dict:
    return {"items": [{"id": "outline", "mode": "cut", "role": "outline",
                       "paths": [{"closed": True, "segs": [[0, 0, 0, 0, 0, 0], [w, 0, 0, 0, 0, 0],
                                                           [w, h, 0, 0, 0, 0], [0, h, 0, 0, 0, 0]]}]}]}


def part_sketches(design: dict | None, include_disabled: bool = False) -> list[tuple[dict, dict]]:
    design = design or {}
    parts = ((design.get("free") or {}).get("parts")) or []
    sketches = design.get("sketches") or {}
    disabled = set(design.get("disabled") or [])
    out = []
    for p in parts:
        if p.get("id") in disabled and not include_disabled:
            continue
        sk = sketches.get(p.get("id"))
        if not sk or not sk.get("items"):
            sk = rect_sketch(float(p.get("w") or 100), float(p.get("h") or 60))
        out.append((p, sk))
    return out


def _bounds(sk: dict):
    xs, ys = [], []
    for item in sk.get("items") or []:
        for pts, _closed in sketch2d.item_polylines(item):
            xs.extend(x for x, _ in pts)
            ys.extend(y for _, y in pts)
    if not xs:
        return 0.0, 0.0, 0.0, 0.0
    return min(xs), min(ys), max(xs), max(ys)


def layout(items: list[tuple[dict, dict]], gap: float = GAP) -> list[tuple[dict, dict, float, float, tuple]]:
    """简单的行排版：返回 (part, sketch, 平移 dx, dy, 包围盒)."""
    boxes_ = [(p, sk, _bounds(sk)) for p, sk in items]
    if not boxes_:
        return []
    area = sum((b[2] - b[0] + gap) * (b[3] - b[1] + gap) for _, _, b in boxes_)
    row_w = max(math.sqrt(area) * 1.4, max(b[2] - b[0] for _, _, b in boxes_))
    x = y = row_h = 0.0
    out = []
    for p, sk, b in boxes_:
        w, h = b[2] - b[0], b[3] - b[1]
        if x > 0 and x + w > row_w:
            x, y, row_h = 0.0, y + row_h + gap, 0.0
        out.append((p, sk, x - b[0], y - b[1], b))
        x += w + gap
        row_h = max(row_h, h)
    return out


def _part_area(sk: dict) -> float:
    try:
        return float(sketch2d.cut_solid(sk).area)
    except Exception:
        return 0.0


def nest(items: list[tuple[dict, dict]], sheet_w: float, sheet_h: float, gap: float):
    """把板件（按包围盒）排进若干张 sheet_w × sheet_h 的材料，允许旋转 90°。
    返回 (放置列表 [(part, sketch, 第几张, x, y, 是否旋转, 包围盒)], 张数, 放不下的板)。
    用「天际线左下角」法：每张材料维护一条天际线，挑能放下且最低、最靠左的位置。"""
    boxes_ = []
    for p, sk in items:
        b = _bounds(sk)
        boxes_.append((p, sk, b, b[2] - b[0], b[3] - b[1]))
    boxes_.sort(key=lambda q: max(q[3], q[4]) * min(q[3], q[4]), reverse=True)
    sheets: list[list[list[float]]] = []      # 每张：天际线段 [x, y, 宽]
    placed, too_big = [], []

    def fit(sky, w, h):
        best = None
        for i, (sx, _sy, _sw) in enumerate(sky):
            if sx + w > sheet_w + 1e-6:
                continue
            # 从第 i 段开始覆盖 w 宽，高度取覆盖段的最大值
            top, x_end, j = 0.0, sx + w, i
            while j < len(sky) and sky[j][0] < x_end - 1e-9:
                top = max(top, sky[j][1])
                j += 1
            if top + h > sheet_h + 1e-6:
                continue
            if best is None or (top, sx) < (best[0], best[1]):
                best = (top, sx)
        return best

    def put(sky, x, y, w, h):
        x_end = x + w
        new = []
        for sx, sy, sw in sky:
            ex = sx + sw
            if ex <= x or sx >= x_end:
                new.append([sx, sy, sw])
                continue
            if sx < x:
                new.append([sx, sy, x - sx])
            if ex > x_end:
                new.append([x_end, sy, ex - x_end])
        new.append([x, y + h, w])
        new.sort(key=lambda q: q[0])
        sky[:] = new

    for p, sk, b, w, h in boxes_:
        gw, gh = w + gap, h + gap
        done = False
        for si, sky in enumerate(sheets + [None]):
            if sky is None:
                sky = [[0.0, 0.0, sheet_w + gap]]
            options = []
            for rot, ww, hh in ((False, gw, gh), (True, gh, gw)):
                if ww - gap > sheet_w + 1e-6 or hh - gap > sheet_h + 1e-6:
                    continue
                f = fit(sky, ww, hh)
                if f is not None:
                    options.append((f[0] + hh, f[1], rot, ww, hh, f))
            if not options:
                continue
            options.sort(key=lambda q: (q[0], q[1]))
            _top, _x, rot, ww, hh, (y, x) = options[0]
            if si == len(sheets):
                sheets.append(sky)
            put(sky, x, y, ww, hh)
            placed.append((p, sk, si, x, y, rot, b))
            done = True
            break
        if not done:
            too_big.append(p)
    return placed, len(sheets), too_big


class FreeDesign(boxes.Boxes):
    """自由设计：自己画板件（二维草图），再到 3D 里拼装并检查干涉"""

    ui_group = "FreeDesign"
    webinterface = True

    def __init__(self) -> None:
        boxes.Boxes.__init__(self)
        self.argparser.add_argument(
            "--sheet_w", action="store", type=float, default=0.0,
            help="材料（激光机台面）宽度 mm；0 = 不排版，按行简单摆放")
        self.argparser.add_argument(
            "--sheet_h", action="store", type=float, default=0.0,
            help="材料（激光机台面）高度 mm")
        self.argparser.add_argument(
            "--part_gap", action="store", type=float, default=3.0,
            help="板件之间的间距 mm")
        self.argparser.add_argument(
            "--common_line", action="store", type=boxes.boolarg, default=False,
            help="共边切割：排版时板件紧挨着，相邻的边只切一次（省时间，边缘不易烧焦）")
        self.design: dict | None = None
        self.notes: list[str] = []

    def render(self) -> None:
        from boxes.Color import Color

        burn = float(getattr(self, "burn", 0) or 0)
        items = part_sketches(self.design)
        sw, sh = float(self.sheet_w or 0), float(self.sheet_h or 0)
        gap = max(0.0, float(self.part_gap or 0)) + 2 * burn
        for p, sk in items:
            for w in sketch2d.export_warnings(sk, burn):
                self.notes.append(f"{p.get('name') or '板件'}：{w}")
        if (sw <= 0 or sh <= 0) and placed_on_sheet(items):
            # 二维画板：所见即所切，按画板上的位置导出
            sheet = ((self.design or {}).get("free") or {}).get("sheet") or {}
            for p, sk in items:
                with self.saved_context():
                    self.moveTo(float(p["sx"]) + self.spacing, float(p["sy"]) + self.spacing, float(p.get("sa") or 0))
                    sketch2d.draw(self, sk, burn)
            if sheet.get("w") and sheet.get("h"):
                with self.saved_context():
                    self.set_source_color(Color.ANNOTATIONS)
                    self.ctx.rectangle(self.spacing, self.spacing, float(sheet["w"]), float(sheet["h"]))
                    self.ctx.stroke()
                    self.set_source_color(Color.BLACK)
                self.notes.append(f"按二维画板上的位置导出（材料 {float(sheet['w']):g}×{float(sheet['h']):g} mm）")
            loose = ((self.design or {}).get("free") or {}).get("loose") or []
            if loose:
                self.notes.append(f"有 {len(loose)} 个图形不在任何板件里，没有导出")
            return
        if sw <= 0 or sh <= 0:
            for _p, sk, dx, dy, _b in layout(items, gap=max(gap, 1.0)):
                with self.saved_context():
                    self.moveTo(dx + self.spacing, dy + self.spacing)
                    sketch2d.draw(self, sk, burn)
            return
        common = bool(getattr(self, "common_line", False))
        if common:
            gap = 2 * burn          # 补偿后相邻的边正好重合
        placed, n_sheets, too_big = nest(items, sw, sh, gap)
        sheet_gap = 20.0
        used = [0.0] * n_sheets
        shared: list[list] = [[] for _ in range(n_sheets)]
        for p, sk, si, x, y, rot, b in placed:
            ox = self.spacing + si * (sw + sheet_gap)
            oy = self.spacing
            x0, y0, x1, y1 = b
            if rot:   # 逆时针 90°：(x, y) → (−y, x)
                tx, ty, ang = ox + x + y1, oy + y - x0, 90
            else:
                tx, ty, ang = ox + x - x0, oy + y - y0, 0
            with self.saved_context():
                self.moveTo(tx, ty, ang)
                sketch2d.draw(self, sk, burn, cut=not common)
            if common:
                for pts, closed, outer in sketch2d.cut_polylines(sk, burn):
                    if ang:
                        pts = [(tx - py, ty + px) for px, py in pts]
                    else:
                        pts = [(tx + px, ty + py) for px, py in pts]
                    shared[si].append((pts, closed, outer))
            used[si] += _part_area(sk)
        if common:
            saved_total = 0.0
            for lines in shared:
                lines, saved = sketch2d.dedupe_lines(lines)
                saved_total += saved
                for pts, closed, outer in sorted(lines, key=lambda t: bool(t[2])):     # 先内孔、后外轮廓
                    self.set_source_color(Color.OUTER_CUT if outer else Color.INNER_CUT)
                    self.ctx.move_to(*pts[0])
                    for pt in pts[1:]:
                        self.ctx.line_to(*pt)
                    if closed:
                        self.ctx.line_to(*pts[0])
                    self.ctx.stroke()
            self.set_source_color(Color.BLACK)
            self.notes.append(f"共边切割：重叠的切割线省掉 {saved_total:.0f} mm")
        for si in range(n_sheets):
            ox = self.spacing + si * (sw + sheet_gap)
            with self.saved_context():
                self.set_source_color(Color.ANNOTATIONS)
                self.ctx.rectangle(ox, self.spacing, sw, sh)
                self.ctx.stroke()
                self.text(f"材料 {si + 1}/{n_sheets} · {sw:g}×{sh:g} mm · 利用率 {used[si] / (sw * sh) * 100:.0f}%",
                          ox, self.spacing + sh + 3, fontsize=6, color=Color.ANNOTATIONS)
                self.set_source_color(Color.BLACK)
        total = sum(used) / (sw * sh * max(1, n_sheets)) * 100
        self.notes.append(f"需要 {n_sheets} 张 {sw:g}×{sh:g} mm 的材料，平均利用率 {total:.0f}%")
        if too_big:
            names = "、".join(str(p.get("name") or p.get("id")) for p in too_big)
            self.notes.append(f"放不下（比材料还大）：{names}")


def _flat_matrix(a: float, dx: float, dy: float) -> list[float]:
    c, s = math.cos(a), math.sin(a)
    return [c, s, 0, 0, -s, c, 0, 0, 0, 0, 1, 0, dx, dy, 0, 1]


def placed_on_sheet(items) -> bool:
    return bool(items) and all(p.get("sx") is not None and p.get("sy") is not None for p, _ in items)


def model_parts(design: dict | None) -> list[dict]:
    """3D 用的零件列表（与 model3d.Recorder.extract + assemble 的输出字段一致），平铺在台面上."""
    out = []
    items = part_sketches(design, include_disabled=True)
    if placed_on_sheet(items):      # 二维画板上画的：3D 平铺位置和画板一致
        placed = [(p, sk, float(p["sx"]), float(p["sy"]), _bounds(sk)) for p, sk in items]
        rot = {p["id"]: math.radians(float(p.get("sa") or 0)) for p, _ in items}
    else:
        placed = layout(items, gap=12.0)
    for p, sk, dx, dy, b in placed:
        g = sketch2d.geometry_3d(sk)
        if g is None:
            continue
        x0, y0, x1, y1 = b
        out.append({
            "id": p["id"], "name": p.get("name") or "板件", "kind": "free", "seq": len(out),
            "w": round(x1 - x0, 4), "h": round(y1 - y0, 4), "edges": "", "label": "",
            "outer": g["outer"], "holes": g["holes"], "extra": g["extra"], "etch": g["etch"], "lines": [],
            "bbox": [x0, y0, x1, y1], "face": None, "mirror": False,
            "matrix": _flat_matrix(rot.get(p["id"], 0.0) if placed_on_sheet(items) else 0.0, dx, dy),
        })
    return out
