"""生成二维画板「图库」的内置件：web/library/builtin.json。

    python scripts/make_library.py

坐标单位 mm，y 向上（和画板数据一致），每个件以 (0, 0) 为中心。
每个件写明尺寸出处；按标准查得到的标 verified=True，元件外形 / 孔位来自公开资料但还没用卡尺核对实物的标 verified=False（界面上显示「未核对」）。
"""
from __future__ import annotations

import json
import math
import os

K = 0.5522847498307936          # 90° 圆弧的贝塞尔控制柄系数


class P:
    """一条路径：节点 [x, y, 入柄 dx, dy, 出柄 dx, dy]（柄是相对节点的偏移，和 paper.js 一样）。"""

    def __init__(self, x, y):
        self.n = [[x, y, 0, 0, 0, 0]]

    def line(self, x, y):
        self.n.append([x, y, 0, 0, 0, 0])
        return self

    def arc(self, cx, cy, a1):
        """从当前点绕 (cx, cy) 转到角度 a1（度，逆时针为正方向增加；a1 < 当前角 = 顺时针）。"""
        x0, y0 = self.n[-1][0], self.n[-1][1]
        r = math.hypot(x0 - cx, y0 - cy)
        a0 = math.degrees(math.atan2(y0 - cy, x0 - cx))
        sweep = a1 - a0
        k = max(1, math.ceil(abs(sweep) / 90 - 1e-9))
        step = math.radians(sweep / k)
        h = 4 / 3 * math.tan(step / 4) * r
        a = math.radians(a0)
        for _ in range(k):
            b = a + step
            self.n[-1][4] = -math.sin(a) * h
            self.n[-1][5] = math.cos(a) * h
            self.n.append([cx + r * math.cos(b), cy + r * math.sin(b), math.sin(b) * h, -math.cos(b) * h, 0, 0])
            a = b
        return self

    def close(self):
        f, l = self.n[0], self.n[-1]
        if len(self.n) > 1 and abs(f[0] - l[0]) < 1e-6 and abs(f[1] - l[1]) < 1e-6:
            f[2], f[3] = l[2], l[3]
            self.n.pop()
        return {"closed": True, "segs": [[round(v, 4) for v in s] for s in self.n]}


def circle(cx, cy, d):
    r = d / 2
    return P(cx + r, cy).arc(cx, cy, 360).close()


def rect(cx, cy, w, h, r=0.0):
    x0, y0, x1, y1 = cx - w / 2, cy - h / 2, cx + w / 2, cy + h / 2
    if r <= 0:
        return P(x0, y0).line(x1, y0).line(x1, y1).line(x0, y1).line(x0, y0).close()
    r = min(r, w / 2, h / 2)
    p = P(x0 + r, y0).line(x1 - r, y0).arc(x1 - r, y0 + r, 0).line(x1, y1 - r).arc(x1 - r, y1 - r, 90)
    p.line(x0 + r, y1).arc(x0 + r, y1 - r, 180).line(x0, y0 + r).arc(x0 + r, y0 + r, 270)
    return p.close()


def poly(pts):
    p = P(*pts[0])
    for q in pts[1:]:
        p.line(*q)
    p.line(*pts[0])
    return p.close()


def item(mode, *paths):
    return {"mode": mode, "paths": list(paths)}


def cut(*paths):
    return [item("cut", p) for p in paths]


LIB: list[dict] = []
ISO273 = "ISO 273 通孔（中等）"
DIN974 = "DIN 974-1（ISO 4762 内六角圆柱头螺钉沉孔）"
UNVERIFIED = "公开资料常见值，未用卡尺核对实物"


def _bbox_center(items):
    xs, ys = [], []
    for it in items:
        for p in it["paths"]:
            s = p["segs"]
            for i in range(len(s)):
                a, b = s[i], s[(i + 1) % len(s)]
                p0, c0, c1, p1 = (a[0], a[1]), (a[0] + a[4], a[1] + a[5]), (b[0] + b[2], b[1] + b[3]), (b[0], b[1])
                for k in range(65):
                    t = k / 64
                    u = 1 - t
                    xs.append(u ** 3 * p0[0] + 3 * u * u * t * c0[0] + 3 * u * t * t * c1[0] + t ** 3 * p1[0])
                    ys.append(u ** 3 * p0[1] + 3 * u * u * t * c0[1] + 3 * u * t * t * c1[1] + t ** 3 * p1[1])
    return (max(xs) + min(xs)) / 2, (max(ys) + min(ys)) / 2


def add(id_, cat, name, items, source, verified, note=""):
    cx, cy = _bbox_center(items)                      # 外框中心挪到原点（放到画板上时以中心对准）
    for it in items:
        for p in it["paths"]:
            p["segs"] = [[round(q[0] - cx, 4), round(q[1] - cy, 4), *q[2:]] for q in p["segs"]]
    LIB.append({"id": id_, "cat": cat, "name": name, "items": items, "source": source, "verified": verified, "note": note})


# ---- 螺丝孔 -------------------------------------------------------------------------------------
for m, d in (("M3", 3.4), ("M4", 4.5), ("M5", 5.5)):
    add(f"hole-{m.lower()}", "螺丝孔", f"{m} 通孔 ø{d}", cut(circle(0, 0, d)), ISO273, True, "螺丝穿过的孔")
for m, d in (("M3", 6.5), ("M4", 8.0), ("M5", 10.0)):
    add(f"cbore-{m.lower()}", "螺丝孔", f"{m} 沉孔层 ø{d:g}", cut(circle(0, 0, d)), DIN974, True,
        "激光切不出台阶：把这个大孔切在最上面一层板，下面一层用同心的通孔，螺丝头就埋进去了")

# ---- 舵机 / 主控板 ------------------------------------------------------------------------------
add("servo-sg90", "舵机 / 主控", "SG90 舵机开口",
    cut(rect(0, 0, 22.8, 12.4), circle(-13.75, 0, 2.0), circle(13.75, 0, 2.0)),
    "TowerPro SG90 数据手册（机身 22.2 × 11.8，孔距约 27.5）；开口每边留 0.3 间隙；" + UNVERIFIED, False)
add("servo-mg996r", "舵机 / 主控", "MG996R 舵机开口",
    cut(rect(0, 0, 41.3, 20.3), *(circle(sx * 24.25, sy * 5.0, 4.3) for sx in (-1, 1) for sy in (-1, 1))),
    "TowerPro MG996R 数据手册（机身 40.7 × 19.7，安装孔约 48.5 × 10）；" + UNVERIFIED, False)
UNO_HOLES = [(13.97, 2.54), (15.24, 50.8), (66.04, 7.62), (66.04, 35.56)]       # 官方板框文件里的 mil 坐标换算
add("board-uno", "舵机 / 主控", "Arduino UNO 安装孔",
    cut(*(circle(x - 68.58 / 2, y - 53.34 / 2, 3.2) for x, y in UNO_HOLES)) + [item("score", rect(0, 0, 68.58, 53.34))],
    "Arduino UNO R3 板框（68.58 × 53.34，4 个 ø3.2 孔，坐标按官方 Eagle 文件 mil 换算）；" + UNVERIFIED, False,
    "描线是板子外形，方便对位；只切 4 个孔")
add("board-microbit", "舵机 / 主控", "micro:bit 外形 51.6×42",
    [item("score", rect(0, 0, 51.6, 42.0, 2.0))],
    "micro:bit 官方尺寸 51.6 × 42 mm；" + UNVERIFIED, False, "只有描线外形（micro:bit 没有螺丝孔，用边缘大孔或卡槽固定）")
add("board-esp32", "舵机 / 主控", "ESP32 DevKitC 外形 54.4×27.9",
    [item("score", rect(0, 0, 54.4, 27.9))],
    "Espressif ESP32-DevKitC V4 板子尺寸；" + UNVERIFIED, False, "只有描线外形（这块板没有螺丝孔）")

# ---- 轴孔 / 元件孔 ------------------------------------------------------------------------------
for d in (3, 4, 5, 6, 8):
    add(f"shaft-{d}", "轴孔 / 元件孔", f"轴孔 ø{d}", cut(circle(0, 0, d)), "名义尺寸（激光切的孔会因割缝略大，紧配时用「已补偿」导出）", True)
add("led-5", "轴孔 / 元件孔", "LED 5 mm 孔", cut(circle(0, 0, 5.0)), "5 mm LED 灯体直径 5.0（底部法兰约 5.8，卡在孔上）", True)
add("led-3", "轴孔 / 元件孔", "LED 3 mm 孔", cut(circle(0, 0, 3.0)), "3 mm LED 灯体直径 3.0", True)
add("btn-12", "轴孔 / 元件孔", "按钮 12 mm 孔", cut(circle(0, 0, 12.0)), "面板安装按钮 12 mm 规格（开孔 = 螺纹直径）", True)
add("btn-16", "轴孔 / 元件孔", "按钮 16 mm 孔", cut(circle(0, 0, 16.0)), "面板安装按钮 16 mm 规格（开孔 = 螺纹直径）", True)
add("usb-a", "轴孔 / 元件孔", "USB-A 开口 13.5×6", cut(rect(0, 0, 13.5, 6.0, 0.5)),
    "USB-A 母座外壳约 13.1 × 5.7，四周留间隙；" + UNVERIFIED, False)
add("usb-c", "轴孔 / 元件孔", "USB-C 开口 9.5×3.8", cut(rect(0, 0, 9.5, 3.8, 1.6)),
    "USB-C 插座外壳约 8.9 × 3.2，四周留间隙（插头外壳更大时要放宽）；" + UNVERIFIED, False)

# ---- 结构孔 ------------------------------------------------------------------------------------
add("vent", "结构孔", "散热孔阵 5×4", cut(*(circle((i - 2) * 6, (j - 1.5) * 6, 4) for j in range(4) for i in range(5))),
    "ø4 孔、间距 6 mm（孔间留 2 mm 筋）", True)
add("handle", "结构孔", "把手孔 80×25", cut(rect(0, 0, 80, 25, 12.5)), "四指把手常用尺寸（手掌宽约 80）", True)
_ky = math.sqrt(4 ** 2 - 2 ** 2)
key = P(2, _ky - 4).line(2, 6).arc(0, 6, 180).line(-2, _ky - 4)          # 整体下移 4 mm，外框中心在原点
key.arc(0, -4, 360 + math.degrees(math.atan2(_ky, 2)))
add("keyhole", "结构孔", "挂孔（葫芦孔）ø8", cut(key.close()), "大圆 ø8 套进螺丝头，往上推进 4 mm 宽的槽挂住（适合 M3 / M4 沉头）", True)

# ---- 装饰 --------------------------------------------------------------------------------------
add("rounded-plate", "装饰", "圆角板 60×40", cut(rect(0, 0, 60, 40, 5)), "—", True)
star = [((30 if i % 2 == 0 else 12) * math.cos(math.radians(90 + i * 36)), (30 if i % 2 == 0 else 12) * math.sin(math.radians(90 + i * 36))) for i in range(10)]
add("star", "装饰", "五角星 60", cut(poly(star)), "—", True)
heart = P(0, -18)
heart.n[-1][4:6] = [-6, 6]
heart.n.append([-20, 6, 0, -10, 0, 9])
heart.n.append([-10, 16, -6, 0, 6, 0])
heart.n.append([0, 8, -2, 4, 2, 4])
heart.n.append([10, 16, -6, 0, 6, 0])
heart.n.append([20, 6, 0, 9, 0, -10])
heart.n.append([0, -18, 6, 6, 0, 0])
add("heart", "装饰", "心形 40", cut(heart.close()), "—", True)
add("arrow", "装饰", "箭头 60", cut(poly([(-30, -6), (10, -6), (10, -15), (30, 0), (10, 15), (10, 6), (-30, 6)])), "—", True)
teeth, ro, rr = 12, 25.0, 21.0
g = []
for i in range(teeth):
    a = 360 / teeth * i
    for da, r in ((-9, rr), (-5, ro), (5, ro), (9, rr)):
        g.append((r * math.cos(math.radians(a + da)), r * math.sin(math.radians(a + da))))
add("gear-deco", "装饰", "齿轮轮廓 ø50", cut(poly(g), circle(0, 0, 5)), "装饰用梯形齿（不是渐开线；要能啮合的齿轮请用「造物 → 模数齿轮」）", True)


def main():
    assert len(LIB) == 30, len(LIB)
    assert len({x["id"] for x in LIB}) == len(LIB)
    out = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "web", "library", "builtin.json")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "items": LIB}, f, ensure_ascii=False, separators=(",", ":"))
    print(f"wrote {len(LIB)} shapes → {out}")


if __name__ == "__main__":
    main()
