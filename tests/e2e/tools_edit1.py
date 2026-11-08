"""A6 ② 编辑工具：选择、节点、移动 / 缩放 / 旋转、对象原点、对齐、镜像。正常用法 + 常见误操作，带断言。"""
import asyncio
from _kit import run, ED


async def body(k, case):
    pg = k.pg

    async def fresh():
        await k.ev(f"(()=>{{const e={ED}; e.content.children.slice().forEach(c=>{{ if (c.data && c.data.mode) c.remove(); }}); e.sel.clear(); e.commit('清空');}})()")
        await pg.keyboard.press('Escape'); await k.tool('select')

    sel = lambda: k.ev(f"[...{ED}.sel].map(c=>c.data.id)")

    async def num(key, val):
        el = await pg.query_selector(f'#sk-host [data-num={key}]')
        await el.fill(str(val)); await el.press('Enter'); await pg.wait_for_timeout(150)

    def finite(its):
        return all(all(abs(v) < 1e6 for v in i['bounds']) for i in its)

    # ---------------- 选择
    async def select():
        await fresh()
        a = await k.add('cut', [[20, 20], [60, 20], [60, 60], [20, 60]])
        b = await k.add('cut', [[100, 20], [140, 20], [140, 60], [100, 60]])
        await k.click(20, 40)
        assert await sel() == [a], await sel()
        sx, sy = await k.scr(100, 40)
        await pg.keyboard.down('Shift'); await pg.mouse.click(sx, sy); await pg.keyboard.up('Shift'); await pg.wait_for_timeout(100)
        assert sorted(await sel()) == sorted([a, b]), await sel()
        await k.click(250, 200)                                   # 空白处单击 → 取消选择
        assert await sel() == [], await sel()
        await k.drag((10, 10), (80, 70))                         # 框住 a、只碰到 b 的一半 → 只选 a
        assert await sel() == [a], await sel()
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(100)
        assert await sel() == []
    await case('选择：单击、Shift 加选、空白处取消、框选只选完全框住的、Esc 取消', select())

    async def delete_nothing():
        await pg.keyboard.press('Delete'); await pg.wait_for_timeout(100)
        assert len(await k.items()) == 2
    await case('误操作：什么都没选按 Delete → 不删东西、不报错', delete_nothing())

    # ---------------- 节点
    async def node():
        await fresh()
        a = await k.add('cut', [[20, 20], [60, 20], [60, 60], [20, 60]])
        await k.select(a); await k.tool('node')
        await k.click(40, 20, dbl=True)                          # 双击边 → 加节点
        assert (await k.items())[0]['n'] == 5, await k.items()
        await k.drag((60, 60), (70, 70))                         # 拖节点
        assert (await k.items())[0]['bounds'] == [20, 20, 70, 70], await k.items()
    await case('节点：双击边加节点、拖动节点', node())

    async def node_delete_min():
        await fresh()
        a = await k.add('cut', [[20, 20], [60, 20], [40, 50]])
        await k.select(a); await k.tool('node')
        await k.click(40, 50)
        await pg.keyboard.press('Delete'); await pg.wait_for_timeout(150)
        its = await k.items()
        # 三角形删掉一个节点：要么不允许，要么整个删掉；不能留下只有 2 个点的「闭合」图形
        assert its and its[0]['n'] == 3 and its[0]['closed'] == [True], ('三角形不能再删节点', its)
        assert '至少要 3 个节点' in await pg.inner_text('body'), '应提示至少 3 个节点'
    await case('误操作：三角形再删节点 → 不允许并提示（不留下 2 个点的闭合图形）', node_delete_min())

    # ---------------- 移动 / 缩放 / 旋转（数值）
    async def numeric():
        await fresh()
        a = await k.add('cut', [[20, 20], [60, 20], [60, 50], [20, 50]])
        await k.select(a)
        await num('w', 80)
        b = (await k.items())[0]['bounds']
        assert abs((b[2] - b[0]) - 80) < 1e-6, b
        await num('rot', 90)
        b = (await k.items())[0]['bounds']
        assert abs((b[3] - b[1]) - 80) < 1e-3, ('旋转 90° 后宽高互换', b)
        await num('rot', -90)
        await num('w', 0)                                        # 宽 0：不接受
        b = (await k.items())[0]['bounds']
        assert abs((b[2] - b[0]) - 80) < 1e-3, b
        await num('w', -5)
        b = (await k.items())[0]['bounds']
        assert abs((b[2] - b[0]) - 80) < 1e-3, b
    await case('数值：改宽、旋转 90°；误操作：宽填 0 或负数不接受', numeric())

    async def line_height():
        await fresh()
        a = await k.add('score', [[20, 20], [80, 20]], closed=False)      # 水平线：高 = 0
        await k.select(a)
        await num('h', 10)
        its = await k.items()
        assert finite(its), ('水平线改高度后坐标变成无穷大', its)
        await num('w', 30)
        its = await k.items()
        assert finite(its) and abs(its[0]['bounds'][2] - its[0]['bounds'][0] - 30) < 1e-6, its
    await case('误操作：选中一条水平线改「高」→ 不出现无穷大坐标（宽仍可改）', line_height())

    async def arrows():
        await fresh()
        a = await k.add('cut', [[20, 20], [60, 20], [60, 50], [20, 50]])
        await k.select(a)
        await pg.keyboard.press('ArrowRight'); await pg.keyboard.press('ArrowUp'); await pg.wait_for_timeout(100)
        b = (await k.items())[0]['bounds']
        assert b[0] > 20 and b[1] != 20, ('方向键微移', b)
    await case('移动：方向键微移', arrows())

    async def drag_move():
        await fresh()
        a = await k.add('cut', [[20, 20], [60, 20], [60, 50], [20, 50]])
        await k.click(20, 35)
        await k.drag((40, 35), (70, 65))                          # 从图形内部拖（边上是缩放手柄）
        b = (await k.items())[0]['bounds']
        assert b == [50, 50, 90, 80], b
        await k.drag((70, 65), (70.05, 65.05), steps=2)          # 手抖：不到 3 像素不算拖动
        assert (await k.items())[0]['bounds'] == [50, 50, 90, 80]
    await case('移动：拖动移动（吸附网格）；误操作：手抖不会挪动', drag_move())

    # ---------------- 对象原点
    async def origin():
        await fresh()
        a = await k.add('cut', [[20, 20], [60, 20], [60, 50], [20, 50]])
        await k.select(a)
        await k.ev(f"(()=>{{const e={ED}; e.refKey='mc'; e.refresh();}})()")
        await num('w', 80)
        b = (await k.items())[0]['bounds']
        assert abs((b[0] + b[2]) / 2 - 40) < 1e-6, ('以中心为原点改宽，中心不动', b)
        await k.ev(f"(()=>{{const e={ED}; e.refKey='tl'; e.refresh();}})()")
        await num('w', 40)
        b2 = (await k.items())[0]['bounds']
        assert abs(b2[0] - b[0]) < 1e-6 and abs(b2[3] - b[3]) < 1e-6, ('以左上角为原点改宽，左上角不动', b, b2)
    await case('对象原点：改宽时原点不动', origin())

    # ---------------- 对齐
    async def align():
        await fresh()
        a = await k.add('cut', [[20, 20], [60, 20], [60, 50], [20, 50]])
        b = await k.add('cut', [[100, 40], [130, 40], [130, 90], [100, 90]])
        await k.select(a, b)
        await k.ev(f"{ED}.align('l')"); await pg.wait_for_timeout(150)
        its = await k.items()
        assert its[0]['bounds'][0] == its[1]['bounds'][0], its
        await k.select()
        await k.ev(f"{ED}.align('l')"); await pg.wait_for_timeout(150)     # 没选中就点对齐：提示、不报错
        await k.select(a)
        await k.ev(f"{ED}.align('hc')"); await pg.wait_for_timeout(150)    # 只选 1 个：对齐到板 / 材料
        its2 = await k.items()
        assert finite(its2), its2
    await case('对齐：两个左对齐；误操作：没选中 / 只选 1 个时点对齐不报错', align())

    # ---------------- 镜像
    async def mirror():
        await fresh()
        a = await k.add('cut', [[20, 20], [60, 20], [20, 50]])
        await k.select(a)
        before = (await k.items())[0]
        await k.ev(f"{ED}.act('flipH')"); await pg.wait_for_timeout(100)
        mid = (await k.items())[0]
        assert mid['bounds'] == before['bounds'], ('镜像不改位置', mid, before)
        await k.ev(f"{ED}.act('flipH')"); await pg.wait_for_timeout(100)
        segs = await k.ev(f"{ED}.content.children.filter(c=>c.data&&c.data.mode)[0].segments.map(s=>[Math.round(s.point.x*1e3)/1e3,Math.round(s.point.y*1e3)/1e3]).sort()")
        assert segs == sorted([[20, 20], [60, 20], [20, 50]]), ('镜像两次回到原样', segs)
        await k.select()
        await k.ev(f"{ED}.act('flipH')"); await pg.wait_for_timeout(100)    # 没选中：不报错
    await case('镜像：位置不变、镜像两次回到原样；误操作：没选中时点镜像不报错', mirror())


asyncio.run(run(body, 'tools_edit1')) and print('PASS tools_edit1：选择 / 节点 / 移动缩放旋转 / 对象原点 / 对齐 / 镜像的正常用法和常见误操作')
