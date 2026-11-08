"""二维码 / 条形码（C6，codes2d.py）：生成的矢量轮廓栅格化后用 zxing-cpp 解码，内容要和输入一致。
运行：.venv/bin/python tests/py/test_codes.py（没装 zxing-cpp 时只做不需要解码的检查：uv pip install zxing-cpp）"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..'))
import codes2d  # noqa: E402

try:
    import numpy as np
    import zxingcpp
except ImportError:
    zxingcpp = None


def raster(res, px_per_mm, margin_mm):
    """奇偶规则扫描线填充：黑 = 0，白 = 255。"""
    w, h = res['w'] + 2 * margin_mm, res['h'] + 2 * margin_mm
    W, H = int(round(w * px_per_mm)), int(round(h * px_per_mm))
    img = np.full((H, W), 255, np.uint8)
    edges = []
    for ring in res['polys']:
        for i in range(len(ring)):
            (x0, y0), (x1, y1) = ring[i], ring[(i + 1) % len(ring)]
            if y0 != y1:
                edges.append((x0, y0, x1, y1))
    for row in range(H):
        y = h / 2 - (row + 0.5) / px_per_mm                     # 像素中心（y 向上）
        xs = sorted(x0 + (y - y0) * (x1 - x0) / (y1 - y0) for x0, y0, x1, y1 in edges if (y0 <= y < y1) or (y1 <= y < y0))
        for a, b in zip(xs[0::2], xs[1::2]):
            c0 = int(round((a + w / 2) * px_per_mm)); c1 = int(round((b + w / 2) * px_per_mm))
            img[row, max(0, c0):max(0, c1)] = 0
    return img


def decode(img):
    return [(r.format.name if hasattr(r.format, 'name') else str(r.format), r.text) for r in zxingcpp.read_barcodes(img)]


def main():
    # 不需要解码的检查
    bits = codes2d.code128_bits('SeedLaser-01')
    assert bits.startswith(codes2d.CODE128[104]) and bits.endswith(codes2d.CODE128_STOP)
    assert len(bits) == 11 * (1 + 12 + 1) + 13
    assert codes2d.code128_bits('20261109').startswith(codes2d.CODE128[105]), '偶数位纯数字用 C 集'
    try:
        codes2d.code128_bits('名牌')
        raise AssertionError('中文不能做 Code 128')
    except ValueError as e:
        assert '不能有' in str(e)
    q = codes2d.code_paths('qr', 'https://github.com/makerseed201808/SeedLaser', 30)
    assert q['w'] == 30 and q['h'] == 30 and q['polys']
    xs = [p[0] for r in q['polys'] for p in r]; ys = [p[1] for r in q['polys'] for p in r]
    assert abs(min(xs) + 15) < 1e-6 and abs(max(xs) - 15) < 1e-6 and abs(min(ys) + 15) < 1e-6 and abs(max(ys) - 15) < 1e-6, '以原点为中心、边长 30'
    if zxingcpp is None:
        print('SKIP test_codes 解码部分：没装 zxing-cpp（uv pip install zxing-cpp）；编码检查通过')
        return
    cases = [('qr', 'https://github.com/makerseed201808/SeedLaser', 30), ('qr', '种子创客工坊 SeedLaser 2026', 25), ('qr', 'A', 12),
             ('bar', 'SeedLaser-01', 60), ('bar', '20261109', 40), ('bar', 'Class 3A #07', 70)]
    for kind, text, size in cases:
        res = codes2d.code_paths(kind, text, size)
        img = raster(res, px_per_mm=12, margin_mm=size * 0.25)
        got = decode(img)
        assert any(t == text for _, t in got), (kind, text, got)
        fmt = [f for f, t in got if t == text][0]
        assert ('QR' in fmt) if kind == 'qr' else ('128' in fmt), (kind, fmt)
    print(f'PASS test_codes：{len(cases)} 个二维码 / 条形码（含中文、纯数字 C 集）矢量轮廓栅格化后解码内容一致；编码检查通过')


if __name__ == '__main__':
    main()
