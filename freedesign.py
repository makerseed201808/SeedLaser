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


class FreeDesign(boxes.Boxes):
    """自由设计：自己画板件（二维草图），再到 3D 里拼装并检查干涉"""

    ui_group = "FreeDesign"
    webinterface = True

    def __init__(self) -> None:
        boxes.Boxes.__init__(self)
        self.design: dict | None = None

    def render(self) -> None:
        burn = float(getattr(self, "burn", 0) or 0)
        for _p, sk, dx, dy, _b in layout(part_sketches(self.design)):
            with self.saved_context():
                self.moveTo(dx + self.spacing, dy + self.spacing)
                sketch2d.draw(self, sk, burn)


def model_parts(design: dict | None) -> list[dict]:
    """3D 用的零件列表（与 model3d.Recorder.extract + assemble 的输出字段一致），平铺在台面上."""
    out = []
    for p, sk, dx, dy, b in layout(part_sketches(design, include_disabled=True), gap=12.0):
        g = sketch2d.geometry_3d(sk)
        if g is None:
            continue
        x0, y0, x1, y1 = b
        out.append({
            "id": p["id"], "name": p.get("name") or "板件", "kind": "free", "seq": len(out),
            "w": round(x1 - x0, 4), "h": round(y1 - y0, 4), "edges": "", "label": "",
            "outer": g["outer"], "holes": g["holes"], "extra": g["extra"], "etch": g["etch"], "lines": [],
            "bbox": [x0, y0, x1, y1], "face": None, "mirror": False,
            "matrix": [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, dx, dy, 0, 1],
        })
    return out
