"""C9 小项合并：
文字样式：粗体（轮廓变粗、比常规宽）、斜体（向右倾斜、变宽）、竖排（高 > 宽、列从右往左）；
上下文栏：缩放 50 %（对象原点不动）、ΔX = 10 / ΔY = 5（Y 往下为正，和标尺一样）；
圆角负半径：40 × 20 矩形挖 4 个 R5 圆弧缺口，面积 = 800 − 25π、外框不变；
连接线段：3 条首尾相接的线（有一条方向反着）→ 一条闭合三角形；2 条 → 一条开放折线。带断言。"""
import asyncio, math
from _kit import run, ED

SQ = lambda x, y, w, h: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
BOUNDS = lambda i: f"(()=>{{const c={ED}.content.children.find(x=>x.data&&x.data.id==='{i}'); return [c.bounds.left,c.bounds.top,c.bounds.width,c.bounds.height].map(v=>Math.round(v*1000)/1000);}})()"


async def body(k, case):
    pg = k.pg

    async def clear():
        await k.ev(f"(()=>{{const e={ED}; e.content.children.slice().forEach(c=>{{ if (c.data && c.data.mode) c.remove(); }}); e.sel.clear(); e.commit('清空');}})()")

    async def text_with(**style):
        await clear()
        await k.tool('text'); await pg.wait_for_timeout(100)
        await pg.fill('#sk-host .sk-toolopts [data-o=text]', '种子AB'); await pg.press('#sk-host .sk-toolopts [data-o=text]', 'Tab')
        for key in ('bold', 'italic', 'vertical'):
            sel = f'#sk-host .sk-toolopts [data-o={key}]'
            if await pg.is_checked(sel) != bool(style.get(key)):
                await pg.click(sel); await pg.wait_for_timeout(80)
        await k.click(150, 150); await pg.wait_for_timeout(1000)
        it = await k.ev(f"(()=>{{const c={ED}.content.children.find(x=>x.data&&x.data.text); return {{t:c.data.text, w:c.bounds.width, h:c.bounds.height, n:{ED}.itemPaths(c).length}};}})()")
        return it

    async def styles():
        base = await text_with()
        bold = await text_with(bold=True)
        assert bold['t']['bold'] and bold['w'] > base['w'] + 0.3 and bold['h'] > base['h'] + 0.3, (base, bold)
        ital = await text_with(italic=True)
        assert ital['t']['italic'] and ital['w'] > base['w'] + 0.5 and abs(ital['h'] - base['h']) < 0.05, (base, ital)
        vert = await text_with(vertical=True)
        assert vert['t']['vertical'] and vert['h'] > 3 * vert['w'], (vert)
        await text_with()                                                     # 复位，不影响后面的测试
    await case('文字样式：粗体变粗、斜体右倾变宽、竖排高 > 宽', styles())

    async def ctx():
        await clear()
        await k.tool('select')
        a = await k.add('cut', SQ(40, 40, 40, 20))
        await k.select(a); await pg.wait_for_timeout(150)
        b0 = await k.ev(BOUNDS(a))
        await pg.fill('#sk-host [data-num=pct]', '50'); await pg.press('#sk-host [data-num=pct]', 'Enter'); await pg.wait_for_timeout(150)
        b1 = await k.ev(BOUNDS(a))
        assert b1[2:] == [20, 10], b1
        assert await pg.input_value('#sk-host [data-num=pct]') == '100', '用完回到 100'
        await pg.fill('#sk-host [data-num=dx]', '10'); await pg.press('#sk-host [data-num=dx]', 'Enter'); await pg.wait_for_timeout(150)
        await pg.fill('#sk-host [data-num=dy]', '5'); await pg.press('#sk-host [data-num=dy]', 'Enter'); await pg.wait_for_timeout(150)
        b2 = await k.ev(BOUNDS(a))
        assert round(b2[0] - b1[0], 3) == 10 and round(b2[1] - b1[1], 3) == -5, ('ΔX 右移 10，ΔY 往下 5（数据 y −5）', b1, b2)
        assert '已移动 ΔY 5 mm' in await k.status(), await k.status()
    await case('上下文栏：缩放 50 % → 20 × 10；ΔX 10、ΔY 5（往下）', ctx())

    async def neg():
        await clear()
        a = await k.add('cut', SQ(40, 40, 40, 20))
        await k.select(a)
        await k.ev(f"{ED}.opts.cornerR = -5; {ED}.act('fillet')"); await pg.wait_for_timeout(150)
        r = await k.ev(f"(()=>{{const c={ED}.content.children.find(x=>x.data&&x.data.id==='{a}'); return {{area:Math.abs(c.area), n:c.segments.length, w:c.bounds.width, h:c.bounds.height}};}})()")
        assert abs(r['area'] - (800 - 25 * math.pi)) < 0.3 and r['n'] == 8 and r['w'] == 40 and r['h'] == 20, r
        assert '挖圆弧缺口' in await k.status(), await k.status()
    await case('圆角负半径 −5：4 个圆弧缺口，面积 800 − 25π，外框 40 × 20 不变', neg())

    async def join():
        await clear()
        a = await k.add('cut', [[20, 20], [60, 20]], closed=False)
        b = await k.add('cut', [[40, 50], [60, 20]], closed=False)          # 方向反着
        c = await k.add('cut', [[40, 50], [20, 20]], closed=False)
        await k.select(a, b, c)
        await k.ev(f"{ED}.act('joinPaths')"); await pg.wait_for_timeout(150)
        s = await k.ev(f"{ED}.content.children.filter(x=>x.data&&x.data.mode).map(x=>({{closed:x.closed, n:x.segments.length, L:Math.round(x.length*1000)/1000}}))")
        L = 40 + 2 * math.hypot(20, 30)
        assert len(s) == 1 and s[0]['closed'] and s[0]['n'] == 3 and abs(s[0]['L'] - L) < 0.01, (s, L)
        await clear()
        a = await k.add('cut', [[20, 20], [60, 20]], closed=False)
        b = await k.add('cut', [[60, 20], [60, 50]], closed=False)
        await k.select(a, b)
        await k.ev(f"{ED}.act('joinPaths')"); await pg.wait_for_timeout(150)
        s = await k.ev(f"{ED}.content.children.filter(x=>x.data&&x.data.mode).map(x=>({{closed:x.closed, n:x.segments.length}}))")
        assert s == [{'closed': False, 'n': 3}], s
    await case('连接线段：3 条（一条反向）→ 闭合三角形；2 条 → 开放折线', join())


asyncio.run(run(body, 'c9small1')) and print('PASS c9small1：粗体 / 斜体 / 竖排、缩放 % 和 ΔX ΔY、负半径圆角、连接线段')
