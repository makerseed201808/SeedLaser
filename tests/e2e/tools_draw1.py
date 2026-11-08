"""A6 ① 画图工具：直线、曲线、矩形、椭圆、多边形、文字。每个工具「正常用法 + 常见误操作」，真实鼠标，带断言。"""
import asyncio
from _kit import run, ED


async def body(k, case):
    pg = k.pg

    async def fresh():
        await k.ev(f"(()=>{{const e={ED}; e.cancelDrawing&&e.cancelDrawing(); e.content.children.slice().forEach(c=>{{ if (c.data && c.data.mode) c.remove(); }}); e.sel.clear(); e.commit('清空');}})()")
        await pg.keyboard.press('Escape')

    # ---------------- 直线
    async def line_closed():
        await fresh(); await k.tool('line')
        for pt in [(20, 20), (80, 20), (80, 70), (20, 20)]:
            await k.click(*pt)
        its = await k.items()
        assert len(its) == 1 and its[0]['closed'] == [True] and its[0]['n'] == 3, its
        assert its[0]['bounds'] == [20, 20, 80, 70], its
    await case('直线：逐点单击，点回起点闭合成三角形', line_closed())

    async def line_open_right():
        await fresh(); await k.tool('line')
        for pt in [(20, 100), (60, 100), (60, 140)]:
            await k.click(*pt)
        await k.click(60, 140, button='right')
        its = await k.items()
        assert len(its) == 1 and its[0]['closed'] == [False] and its[0]['n'] == 3, its
        assert not await k.ev("!!document.querySelector('.sk-radial')"), '画线时右键结束，不应弹出快捷菜单'
    await case('直线：右键结束得到开放折线（不弹快捷菜单）', line_open_right())

    async def line_esc():
        await fresh(); await k.tool('line')
        await k.click(20, 20)
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(100)
        assert await k.items() == [], await k.items()
    await case('误操作：直线只点了一个点就按 Esc → 不留下任何东西', line_esc())

    async def line_double():
        await fresh(); await k.tool('line')
        await k.click(20, 20); await k.click(50, 20); await k.click(50, 20); await k.click(50, 50)
        await pg.keyboard.press('Enter'); await pg.wait_for_timeout(100)
        its = await k.items()
        assert len(its) == 1, its
        segs = await k.ev(f"{ED}.content.children.filter(c=>c.data&&c.data.mode)[0].segments.map(s=>[s.point.x,s.point.y])")
        for a, b in zip(segs, segs[1:]):
            assert abs(a[0] - b[0]) + abs(a[1] - b[1]) > 1e-6, ('同一点点两次留下了零长度段', segs)
    await case('误操作：画线时在同一点连点两次 → 不产生零长度段', line_double())

    # ---------------- 曲线
    async def pen_curve():
        await fresh(); await k.tool('pen')
        await k.click(20, 200)
        a = await k.scr(70, 200); b = await k.scr(90, 230)
        await pg.mouse.move(*a); await pg.mouse.down(); await pg.mouse.move(*b, steps=6); await pg.mouse.up(); await pg.wait_for_timeout(100)
        await k.click(120, 200)
        await pg.keyboard.press('Enter'); await pg.wait_for_timeout(150)
        its = await k.items()
        assert len(its) == 1 and its[0]['n'] == 3 and its[0]['closed'] == [False], its
        h = await k.ev(f"(()=>{{const s={ED}.content.children.filter(c=>c.data&&c.data.mode)[0].segments[1]; return [s.handleIn.length, s.handleOut.length];}})()")
        assert h[0] > 1 and h[1] > 1, ('按住拖动的点应是平滑点', h)
    await case('曲线：单击尖角点、按住拖动平滑点，回车结束', pen_curve())

    async def pen_single():
        await fresh(); await k.tool('pen')
        await k.click(20, 200)
        await pg.keyboard.press('Enter'); await pg.wait_for_timeout(100)
        assert await k.items() == [], await k.items()
    await case('误操作：曲线只点一个点就回车 → 不留下单点路径', pen_single())

    # ---------------- 矩形
    async def rect_norm():
        await fresh(); await k.tool('rect')
        await k.drag((30, 30), (90, 70))
        its = await k.items()
        assert len(its) == 1 and its[0]['bounds'] == [30, 30, 90, 70] and its[0]['closed'] == [True], its
    await case('矩形：拖出 60 × 40', rect_norm())

    async def rect_rev():
        await fresh(); await k.tool('rect')
        await k.drag((90, 70), (30, 30))
        its = await k.items()
        assert len(its) == 1 and its[0]['bounds'] == [30, 30, 90, 70], its
        assert its[0]['area'] == 2400, its
    await case('矩形：反方向拖（右下 → 左上）结果一样', rect_rev())

    async def rect_shift():
        await fresh(); await k.tool('rect')
        await k.drag((30, 30), (90, 50), mods=('Shift',))
        its = await k.items()
        b = its[0]['bounds']
        assert abs((b[2] - b[0]) - (b[3] - b[1])) < 1e-6, ('Shift 应是正方形', b)
    await case('矩形：按住 Shift 画正方形', rect_shift())

    async def rect_click():
        await fresh(); await k.tool('rect')
        await k.click(50, 50)
        await k.drag((50, 50), (50.2, 50.2), steps=2)
        its = await k.items()
        assert its == [] or all(min(i['bounds'][2] - i['bounds'][0], i['bounds'][3] - i['bounds'][1]) > 0.5 for i in its), ('单击 / 手抖不应生成零尺寸矩形', its)
    await case('误操作：矩形工具单击或手抖 → 不生成零尺寸矩形', rect_click())

    # ---------------- 椭圆
    async def ellipse():
        await fresh(); await k.tool('ellipse')
        await k.drag((100, 30), (160, 70))
        await k.drag((100, 100), (140, 120), mods=('Shift',))
        its = await k.items()
        assert len(its) == 2 and all(i['closed'] == [True] for i in its), its
        a, c = its
        assert a['bounds'] == [100, 30, 160, 70], a
        cb = c['bounds']
        assert abs((cb[2] - cb[0]) - (cb[3] - cb[1])) < 1e-6, ('Shift 应是正圆', cb)
        assert abs(a['area'] - 3.14159 * 30 * 20) / (3.14159 * 30 * 20) < 0.01, a
    await case('椭圆：拖出 60 × 40 椭圆；Shift 正圆', ellipse())

    async def ellipse_click():
        await fresh(); await k.tool('ellipse')
        await k.click(150, 150)
        its = await k.items()
        assert its == [], its
    await case('误操作：椭圆工具单击 → 不生成零尺寸椭圆', ellipse_click())

    # ---------------- 多边形
    async def polygon():
        await fresh(); await k.tool('polygon')
        await k.drag((200, 100), (230, 100))
        its = await k.items()
        assert len(its) == 1 and its[0]['closed'] == [True] and its[0]['n'] >= 3, its
        b = its[0]['bounds']
        assert 50 <= b[2] - b[0] <= 61 and 50 <= b[3] - b[1] <= 61, ('从中心拖出半径 30', b)
    await case('多边形：从中心拖出（半径 30）', polygon())

    async def polygon_click():
        await fresh(); await k.tool('polygon')
        await k.click(200, 200)
        assert await k.items() == [], await k.items()
    await case('误操作：多边形工具单击 → 不生成零尺寸多边形', polygon_click())

    # ---------------- 文字
    async def text():
        await fresh(); await k.tool('text')
        await k.click(60, 150)
        await pg.wait_for_timeout(1500)
        its = await k.items()
        assert len(its) == 1 and its[0]['text'], its
        assert its[0]['mode'] in ('engrave', 'cut', 'score'), its
    await case('文字：单击放置一段文字', text())

    async def text_empty():
        its = await k.items()
        tid = its[0]['id']
        await k.select(tid)
        inp = await pg.query_selector('#sk-host [data-t=text], #sk-host .sk-text-input, #sk-host textarea')
        assert inp, '右侧应有文字内容输入框'
        await inp.fill('')
        await inp.dispatch_event('change'); await pg.wait_for_timeout(800)
        its2 = await k.items()
        # 清空内容：要么删掉这个文字，要么保留原文字，不能留下一个看不见的空图形
        assert all(i['n'] > 0 for i in its2), its2
    await case('误操作：把文字内容清空 → 不留下看不见的空图形', text_empty())

    # 撤销：每种画图操作都能一步撤销
    async def undo():
        await fresh(); await k.tool('rect')
        await k.drag((30, 30), (90, 70))
        await k.tool('ellipse')
        await k.drag((100, 30), (160, 70))
        await pg.keyboard.press('Escape')
        await k.ev(f"{ED}.undo()"); await pg.wait_for_timeout(100)
        assert len(await k.items()) == 1
        await k.ev(f"{ED}.undo()"); await pg.wait_for_timeout(100)
        assert len(await k.items()) == 0
        await k.ev(f"{ED}.redo()"); await pg.wait_for_timeout(100)
        assert len(await k.items()) == 1
    await case('画完的每个图形都能一步撤销 / 重做', undo())


asyncio.run(run(body, 'tools_draw1')) and print('PASS tools_draw1：直线 / 曲线 / 矩形 / 椭圆 / 多边形 / 文字的正常用法和常见误操作')
