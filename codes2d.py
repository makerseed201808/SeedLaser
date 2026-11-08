"""二维码（QR）/ 条形码（Code 128）→ 矢量轮廓（C6）。

坐标单位 mm，y 向上（和二维画板一致），以 (0, 0) 为中心。
相邻的黑块合并成多边形（有洞的带内环），雕刻时按奇偶规则填充，不会出现一格一格的接缝。
QR 用 qrcode 库（Boxes.py 的依赖，程序里一定有）；Code 128 的码表按 ISO/IEC 15417。
"""
from __future__ import annotations

from typing import Any

import qrcode
from shapely.geometry import Polygon, box as sbox
from shapely.ops import unary_union

# Code 128 码表：值 0 ~ 105 的条空图案（1 = 条，0 = 空，每个 11 个模块）。103 / 104 / 105 = 起始符 A / B / C
CODE128 = (
    '11011001100', '11001101100', '11001100110', '10010011000', '10010001100', '10001001100', '10011001000', '10011000100',
    '10001100100', '11001001000', '11001000100', '11000100100', '10110011100', '10011011100', '10011001110', '10111001100',
    '10011101100', '10011100110', '11001110010', '11001011100', '11001001110', '11011100100', '11001110100', '11101101110',
    '11101001100', '11100101100', '11100100110', '11101100100', '11100110100', '11100110010', '11011011000', '11011000110',
    '11000110110', '10100011000', '10001011000', '10001000110', '10110001000', '10001101000', '10001100010', '11010001000',
    '11000101000', '11000100010', '10110111000', '10110001110', '10001101110', '10111011000', '10111000110', '10001110110',
    '11101110110', '11010001110', '11000101110', '11011101000', '11011100010', '11011101110', '11101011000', '11101000110',
    '11100010110', '11101101000', '11101100010', '11100011010', '11101111010', '11001000010', '11110001010', '10100110000',
    '10100001100', '10010110000', '10010000110', '10000101100', '10000100110', '10110010000', '10110000100', '10011010000',
    '10011000010', '10000110100', '10000110010', '11000010010', '11001010000', '11110111010', '11000010100', '10001111010',
    '10100111100', '10010111100', '10010011110', '10111100100', '10011110100', '10011110010', '11110100100', '11110010100',
    '11110010010', '11011011110', '11011110110', '11110110110', '10101111000', '10100011110', '10001011110', '10111101000',
    '10111100010', '11110101000', '11110100010', '10111011110', '10111101110', '11101011110', '11110101110', '11010000100',
    '11010010000', '11010011100',
)
CODE128_STOP = '1100011101011'          # 终止符（含最后的 2 模块终止条）
START_B, START_C = 104, 105


def code128_bits(text: str) -> str:
    """Code 128 编码：全是数字且位数为偶数时用 C 集（两位一个码，更短），否则用 B 集（ASCII 32 ~ 126）。"""
    if not text:
        raise ValueError("条形码内容不能为空")
    if text.isdigit() and len(text) % 2 == 0 and text.isascii():
        vals = [START_C] + [int(text[i:i + 2]) for i in range(0, len(text), 2)]
    else:
        bad = [c for c in text if not (32 <= ord(c) <= 126)]
        if bad:
            raise ValueError(f"条形码只能用英文字母、数字和常见符号，不能有：{''.join(dict.fromkeys(bad))}")
        vals = [START_B] + [ord(c) - 32 for c in text]
    check = (vals[0] + sum(i * v for i, v in enumerate(vals[1:], 1))) % 103
    return ''.join(CODE128[v] for v in vals + [check]) + CODE128_STOP


def qr_matrix(text: str, ec: str = "M") -> list[list[bool]]:
    if not text:
        raise ValueError("二维码内容不能为空")
    level = {"L": qrcode.constants.ERROR_CORRECT_L, "M": qrcode.constants.ERROR_CORRECT_M,
             "Q": qrcode.constants.ERROR_CORRECT_Q, "H": qrcode.constants.ERROR_CORRECT_H}.get(ec, qrcode.constants.ERROR_CORRECT_M)
    q = qrcode.QRCode(error_correction=level, border=0)
    q.add_data(text)
    q.make(fit=True)
    return q.get_matrix()


def _rings(rects: list) -> list[list[list[float]]]:
    geom = unary_union(rects)
    polys = [geom] if isinstance(geom, Polygon) else list(getattr(geom, "geoms", []))
    out = []
    for pg in polys:
        out.append([[round(x, 4), round(y, 4)] for x, y in list(pg.exterior.coords)[:-1]])
        out.extend([[round(x, 4), round(y, 4)] for x, y in list(r.coords)[:-1]] for r in pg.interiors)
    return out


def code_paths(kind: str, text: str, size: float, height: float | None = None, ec: str = "M") -> dict[str, Any]:
    """kind = 'qr'：size = 边长（mm）；kind = 'bar'：size = 宽度（mm），height = 条高（默认宽度的 0.3，至少 8 mm）。
    返回 {polys, w, h, module, n}；polys 以 (0, 0) 为中心。"""
    size = float(size)
    if size <= 0:
        raise ValueError("尺寸要大于 0")
    rects = []
    if kind == "qr":
        mat = qr_matrix(text, ec)
        n = len(mat)
        m = size / n
        for r, row in enumerate(mat):
            c = 0
            while c < n:                                    # 一行里连续的黑块合成一个长条
                if not row[c]:
                    c += 1
                    continue
                c0 = c
                while c < n and row[c]:
                    c += 1
                x0, x1 = -size / 2 + c0 * m, -size / 2 + c * m
                y1 = size / 2 - r * m
                rects.append(sbox(x0, y1 - m, x1, y1))
        w = h = size
    elif kind == "bar":
        bits = code128_bits(text)
        n = len(bits)
        m = size / n
        h = float(height) if height else max(8.0, size * 0.3)
        i = 0
        while i < n:
            if bits[i] != "1":
                i += 1
                continue
            i0 = i
            while i < n and bits[i] == "1":
                i += 1
            rects.append(sbox(-size / 2 + i0 * m, -h / 2, -size / 2 + i * m, h / 2))
        w = size
    else:
        raise ValueError(f"不认识的类型：{kind}")
    return {"polys": _rings(rects), "w": w, "h": h, "module": m, "n": n}
