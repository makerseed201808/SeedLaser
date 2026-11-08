"""A6 ⑤ 导入（SVG / DXF / 图片描摹）。正常用法 + 常见误操作，带断言。
（导出见 tests/py/test_export.py；文件新建 / 打开 / 保存 / 多开标签见 file1、tabs1、rename1、migrate1、test_named、test_migrate。）"""
import asyncio, json
from _kit import run, ED


async def body(k, case):
    pg = k.pg

    async def fresh():
        await k.ev(f"(()=>{{const e={ED}; document.querySelectorAll('.sk-modal, .sk-modal-bg').forEach(m=>m.remove()); e.content.children.slice().forEach(c=>{{ if (c.data && c.data.mode) c.remove(); }}); e.sel.clear(); e.commit('清空');}})()")
        await pg.keyboard.press('Escape'); await k.tool('select')

    async def imp(name, text, ok=True, orig=True):
        await k.ev(f"(async()=>{{ const f=new File([{json.dumps(text)}], {json.dumps(name)}); await {ED}.importFile(f); }})()")
        await pg.wait_for_timeout(300)
        btn = await pg.query_selector('#sk-host [data-m=ok], [data-m=ok]')
        if btn and ok:
            if orig:
                o = await pg.query_selector('[data-v=orig]')
                if o:
                    await o.click()
            await btn.click(); await pg.wait_for_timeout(300)
        return btn is not None

    toast = lambda: k.ev("[...document.querySelectorAll('.sk-toast, .toast, [class*=toast]')].map(t=>t.textContent).join(' | ')")

    def size(i):
        b = i['bounds']
        return (round(b[2] - b[0], 2), round(b[3] - b[1], 2))

    # ---------------- SVG
    async def svg_mm():
        await fresh()
        svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="60mm" viewBox="0 0 100 60"><rect x="10" y="10" width="50" height="30"/><circle cx="80" cy="30" r="10"/></svg>'
        assert await imp('a.svg', svg)
        its = await k.items()
        assert len(its) == 2 and all(i['closed'] == [True] for i in its), its
        assert sorted(size(i) for i in its) == [(20, 20), (50, 30)], [size(i) for i in its]
    await case('导入 SVG（mm + viewBox）：矩形 50 × 30、圆 Ø20，尺寸不变', svg_mm())

    async def svg_inch():
        await fresh()
        svg = '<svg xmlns="http://www.w3.org/2000/svg" width="2in" height="1in" viewBox="0 0 2 1"><rect x="0" y="0" width="2" height="1"/></svg>'
        assert await imp('b.svg', svg)
        its = await k.items()
        assert len(its) == 1 and size(its[0]) == (50.8, 25.4), [size(i) for i in its]
    await case('导入 SVG（英寸）：换算成 50.8 × 25.4 mm', svg_inch())

    async def svg_px():
        await fresh()
        svg = '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect x="0" y="0" width="96" height="48"/></svg>'
        assert await imp('c.svg', svg)
        its = await k.items()
        assert len(its) == 1 and size(its[0]) == (25.4, 12.7), [size(i) for i in its]
    await case('导入 SVG（没写单位 = 96 dpi 像素）：96 px = 25.4 mm', svg_px())

    async def svg_near():
        await fresh()
        svg = '<svg xmlns="http://www.w3.org/2000/svg" width="100mm" height="100mm" viewBox="0 0 100 100"><path d="M10 10 L60 10 L60 60 L10 60 L10.001 10"/></svg>'
        assert await imp('d.svg', svg)
        its = await k.items()
        assert len(its) == 1 and its[0]['closed'] == [True], its
    await case('导入 SVG：首尾差 0.001 mm 没闭合的路径 → 当成闭合', svg_near())

    async def svg_bad():
        await fresh()
        for name, text in [('e.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="10mm" height="10mm"></svg>'), ('f.svg', 'hello, not svg')]:
            shown = await imp(name, text, ok=False)
            assert not shown, f'{name}：没有图形时不应弹出导入对话框'
        assert await k.items() == []
        assert 'SVG' in await toast(), await toast()
    await case('误操作：导入空 SVG / 不是 SVG 的文件 → 提示、不导入', svg_bad())

    # ---------------- DXF
    def dxf(entities, units=4):
        head = f"0\nSECTION\n2\nHEADER\n9\n$INSUNITS\n70\n{units}\n0\nENDSEC\n"
        return head + "0\nSECTION\n2\nENTITIES\n" + entities + "0\nENDSEC\n0\nEOF\n"

    LINE = lambda x1, y1, x2, y2: f"0\nLINE\n8\n0\n10\n{x1}\n20\n{y1}\n11\n{x2}\n21\n{y2}\n"
    CIRCLE = lambda x, y, r: f"0\nCIRCLE\n8\n0\n10\n{x}\n20\n{y}\n40\n{r}\n"
    LWPOLY = lambda pts, closed: "0\nLWPOLYLINE\n8\n0\n90\n%d\n70\n%d\n" % (len(pts), 1 if closed else 0) + ''.join(f"10\n{x}\n20\n{y}\n" for x, y in pts)

    async def dxf_ok():
        await fresh()
        assert await imp('a.dxf', dxf(LWPOLY([(0, 0), (40, 0), (40, 30), (0, 30)], True) + CIRCLE(60, 15, 10)))
        its = await k.items()
        assert len(its) == 2 and all(i['closed'] == [True] for i in its), its
        assert sorted(size(i) for i in its) == [(20, 20), (40, 30)], [size(i) for i in its]
    await case('导入 DXF：闭合多段线 40 × 30、圆 Ø20', dxf_ok())

    async def dxf_lines():
        await fresh()
        # CAD 里很常见：矩形是 4 条独立的 LINE
        assert await imp('b.dxf', dxf(LINE(0, 0, 40, 0) + LINE(40, 0, 40, 30) + LINE(40, 30, 0, 30) + LINE(0, 30, 0, 0)))
        its = await k.items()
        assert len(its) == 1 and its[0]['closed'] == [True] and size(its[0]) == (40, 30), ('首尾相接的 4 条线应连成一个闭合矩形', its)
    await case('导入 DXF：4 条首尾相接的 LINE 连成一个闭合矩形（才能识别成板）', dxf_lines())

    async def dxf_inch():
        await fresh()
        assert await imp('c.dxf', dxf(LWPOLY([(0, 0), (2, 0), (2, 1), (0, 1)], True), units=1))
        its = await k.items()
        assert len(its) == 1 and size(its[0]) == (50.8, 25.4), [size(i) for i in its]
    await case('导入 DXF（单位英寸）：换算成 mm', dxf_inch())

    async def dxf_bad():
        await fresh()
        for name, text in [('d.dxf', dxf('')), ('e.dxf', 'garbage\nnot a dxf')]:
            assert not await imp(name, text, ok=False), name
        assert await k.items() == []
        assert 'DXF' in await toast(), await toast()
    await case('误操作：导入空 DXF / 坏文件 → 提示、不导入', dxf_bad())

    # ---------------- 图片描摹
    async def image():
        await fresh()
        await k.ev(f"(async()=>{{const c=document.createElement('canvas'); c.width=200; c.height=100; const g=c.getContext('2d'); g.fillStyle='#fff'; g.fillRect(0,0,200,100); g.fillStyle='#000'; g.fillRect(40,20,120,60); const b=await new Promise(r=>c.toBlob(r,'image/png')); await {ED}.importFile(new File([b], 'sq.png', {{type:'image/png'}})); }})()")
        await pg.wait_for_timeout(800)
        await pg.click('[data-m=ok]'); await pg.wait_for_timeout(1500)
        its = await k.items()
        assert len(its) >= 1 and any(i['closed'] == [True] for i in its), its
        b = max(its, key=lambda i: i['area'])
        w, h = size(b)
        assert abs(w / h - 2) < 0.15, ('黑色方块 120 × 60 → 宽高比 2', w, h)
    await case('图片描摹：黑色长方块描成闭合轮廓，宽高比正确', image())

    async def image_blank():
        await fresh()
        await k.ev(f"(async()=>{{const c=document.createElement('canvas'); c.width=100; c.height=100; const g=c.getContext('2d'); g.fillStyle='#fff'; g.fillRect(0,0,100,100); const b=await new Promise(r=>c.toBlob(r,'image/png')); await {ED}.importFile(new File([b], 'blank.png', {{type:'image/png'}})); }})()")
        await pg.wait_for_timeout(800)
        btn = await pg.query_selector('[data-m=ok]')
        if btn:
            await btn.click(); await pg.wait_for_timeout(1500)
        assert await k.items() == [], await k.items()
        await k.ev("document.querySelectorAll('.sk-modal, .sk-modal-bg').forEach(m=>m.remove())")
    await case('误操作：描摹一张全白的图片 → 不生成图形（提示调阈值）', image_blank())


asyncio.run(run(body, 'tools_io1')) and print('PASS tools_io1：导入 SVG（mm / 英寸 / 像素 / 差一点闭合）、DXF（多段线 / 圆 / 首尾相接的线 / 英寸）、图片描摹，以及空文件 / 坏文件 / 全白图片')
