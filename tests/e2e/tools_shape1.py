"""A6 ③ 形状运算、偏移、圆角 / 倒角、阵列、编组。正常用法 + 常见误操作，带断言。"""
import asyncio
from _kit import run, ED

SQ = lambda x, y, w, h: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


async def body(k, case):
    pg = k.pg

    async def fresh():
        await k.ev(f"(()=>{{const e={ED}; e.content.children.slice().forEach(c=>{{ if (c.data && c.data.mode) c.remove(); }}); e.sel.clear(); e.commit('清空');}})()")
        await pg.keyboard.press('Escape'); await k.tool('select')

    act = lambda a: k.ev(f"(async()=>{{ await {ED}.act({a!r}); }})()")
    opt = lambda key, v: k.ev(f"{ED}.opts[{key!r}]={v!r}")
    toast = lambda: k.ev("[...document.querySelectorAll('.sk-toast, .toast')].map(t=>t.textContent).join(' | ')")

    # ---------------- 形状运算
    async def boolean_ok():
        await fresh()
        a = await k.add('cut', SQ(20, 20, 40, 40)); b = await k.add('cut', SQ(40, 40, 40, 40))
        await k.select(a, b); await act('unite'); await pg.wait_for_timeout(200)
        its = await k.items()
        assert len(its) == 1 and abs(its[0]['area'] - 2800) < 1e-3, its
        await k.ev(f"{ED}.undo()"); await k.select(a, b); await act('intersect'); await pg.wait_for_timeout(200)
        its = await k.items()
        assert any(abs(i['area'] - 400) < 1e-3 for i in its), its
    await case('形状运算：两个重叠方块并集 2800、交集 400', boolean_ok())

    async def boolean_apart():
        await fresh()
        a = await k.add('cut', SQ(20, 20, 20, 20)); b = await k.add('cut', SQ(100, 20, 20, 20))
        await k.select(a, b); await act('intersect'); await pg.wait_for_timeout(200)
        its = await k.items()
        assert len(its) == 2 and all(i['n'] > 0 and i['area'] > 0 for i in its), ('不重叠的图形求交集，原图形应保持不变', its)
    await case('误操作：不重叠的两个图形求交集 → 原图形保持不变（原来会全删掉）', boolean_apart())

    async def boolean_open():
        await fresh()
        a = await k.add('cut', SQ(20, 20, 40, 40)); b = await k.add('score', [[0, 30], [100, 30]], closed=False)
        await k.select(a, b); await act('unite'); await pg.wait_for_timeout(200)
        assert len(await k.items()) == 2, await k.items()
    await case('误操作：开放线参与形状运算 → 不运算并提示', boolean_open())

    # ---------------- 偏移
    async def offset():
        await fresh()
        a = await k.add('cut', SQ(50, 50, 40, 40))
        await k.select(a); await opt('offset', 5); await opt('offsetJoin', 'miter')
        await act('offset'); await pg.wait_for_timeout(800)
        its = await k.items()
        assert len(its) == 2 and any(i['bounds'] == [45, 45, 95, 95] for i in its), its
        await k.select(a); await opt('offset', -30)
        await act('offset'); await pg.wait_for_timeout(800)
        assert len(await k.items()) == 2, ('内缩过头不应生成图形', await k.items())
        await opt('offset', 0); await act('offset'); await pg.wait_for_timeout(300)
        assert len(await k.items()) == 2
    await case('偏移：外扩 5 mm 得 50 × 50；误操作：内缩过头 / 距离 0 → 不生成并提示', offset())

    async def offset_line():
        await fresh()
        a = await k.add('score', [[20, 100], [80, 100]], closed=False)
        await k.select(a); await opt('offset', 2); await opt('offsetJoin', 'round')
        await act('offset'); await pg.wait_for_timeout(800)
        its = await k.items()
        assert len(its) == 2 and any(i['closed'] == [True] for i in its), its
    await case('偏移：开放线偏移成两侧等距的闭合轮廓', offset_line())

    # ---------------- 圆角 / 倒角
    async def corner():
        await fresh()
        a = await k.add('cut', SQ(20, 20, 40, 40))
        await k.select(a); await opt('cornerR', 5); await act('fillet'); await pg.wait_for_timeout(200)
        its = await k.items()
        assert its[0]['n'] == 8 and its[0]['bounds'] == [20, 20, 60, 60], its
        await k.ev(f"{ED}.undo()"); await k.select(a); await opt('cornerR', 100); await act('chamfer'); await pg.wait_for_timeout(200)
        its = await k.items()
        assert its[0]['area'] > 0 and its[0]['bounds'] == [20, 20, 60, 60], ('半径太大时按边长截短，不翻转', its)
    await case('圆角：方块 4 个角变 8 个节点；误操作：半径比边还长 → 自动截短、不出错', corner())

    async def corner_circle():
        await fresh()
        K = 0.5523 * 20
        a = await k.add('cut', [[120, 100, 0, -K, 0, K], [100, 120, K, 0, -K, 0], [80, 100, 0, K, 0, -K], [100, 80, -K, 0, K, 0]])
        await k.select(a); await opt('cornerR', 3); await act('fillet'); await pg.wait_for_timeout(200)
        assert (await k.items())[0]['n'] == 4
    await case('误操作：对圆做圆角 → 没有尖角，提示、不改图形', corner_circle())

    # ---------------- 阵列
    async def array():
        await fresh()
        a = await k.add('cut', SQ(20, 20, 10, 10))
        await k.select(a); await opt('arrType', 'line'); await opt('arrCount', 4); await opt('arrDist', 15); await opt('arrAngle', 0)
        await act('array'); await pg.wait_for_timeout(200)
        its = await k.items()
        assert len(its) == 4 and sorted(i['bounds'][0] for i in its) == [20, 35, 50, 65], its
    await case('阵列：直线阵列 4 份、间距 15', array())

    async def array_zero():
        await fresh()
        a = await k.add('cut', SQ(20, 20, 10, 10))
        await k.select(a); await opt('arrType', 'line'); await opt('arrCount', 4); await opt('arrDist', 0)
        await act('array'); await pg.wait_for_timeout(200)
        its = await k.items()
        assert len(its) == 1, ('间距 0 会把复制品叠在原地（激光会重复切同一条线）', len(its))
    await case('误操作：阵列间距填 0 → 不生成叠在一起的复制品', array_zero())

    async def array_grid_zero():
        await fresh()
        a = await k.add('cut', SQ(20, 20, 10, 10))
        await k.select(a); await opt('arrType', 'grid'); await opt('arrRows', 2); await opt('arrCols', 3); await opt('arrDx', 0); await opt('arrDy', 15)
        await act('array'); await pg.wait_for_timeout(200)
        its = await k.items()
        keys = {tuple(i['bounds']) for i in its}
        assert len(keys) == len(its), ('矩形阵列有一个方向间距为 0，产生了重叠的复制品', len(its), len(keys))
    await case('误操作：矩形阵列某个方向间距 0 → 不产生完全重叠的复制品', array_grid_zero())

    # ---------------- 编组
    async def group():
        await fresh()
        a = await k.add('cut', SQ(20, 20, 10, 10)); b = await k.add('cut', SQ(40, 20, 10, 10))
        await k.select(a, b); await act('group'); await pg.wait_for_timeout(100)
        its = await k.items()
        assert its[0]['group'] and its[0]['group'] == its[1]['group'], its
        await k.select(); await k.click(20, 25)                   # 点其中一个 → 整组选中
        assert len(await k.ev(f"[...{ED}.sel]")) == 2
        await act('ungroup'); await pg.wait_for_timeout(100)
        its = await k.items()
        assert not its[0]['group'] and not its[1]['group'], its
        await k.select(a); await act('ungroup'); await pg.wait_for_timeout(100)   # 没编组的再取消编组：不报错
        await k.select(a); await act('group'); await pg.wait_for_timeout(100)     # 只选 1 个编组：不报错、不产生只有 1 个成员的组
        its = await k.items()
        assert not [i for i in its if i['group'] and sum(1 for j in its if j['group'] == i['group']) == 1], its
    await case('编组：编组后点一个选整组、取消编组；误操作：单个图形编组 / 取消编组不出错', group())


asyncio.run(run(body, 'tools_shape1')) and print('PASS tools_shape1：形状运算 / 偏移 / 圆角倒角 / 阵列 / 编组的正常用法和常见误操作')
