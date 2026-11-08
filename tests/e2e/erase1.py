"""C7 打断 / 橡皮擦（修剪工具的两种新方式）：
打断：开放的 100 mm 线中间点一下 → 两个图形、各 2 个节点、长度 40 + 60；闭合矩形（4 节点）边上点一下 → 变成开放路径、6 个节点、周长不变；
橡皮擦：100 mm 线中间点一下（宽 2）→ 剩两段，长度和 = 98（≤ 0.1）；拖过一段 → 擦掉的长度 ≈ 拖过的长度 + 擦除宽度；
擦矩形（闭合）→ 开放、周长 − 2；一步撤销；修剪模式照常。带断言。"""
import asyncio
from _kit import run, ED

SQ = lambda x, y, w, h: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
SHAPES = f"{ED}.content.children.filter(c=>c.data&&c.data.mode).map(c=>({{id:c.data.id, closed:{ED}.itemPaths(c).map(p=>p.closed), nodes:{ED}.itemPaths(c).map(p=>p.segments.length), L:{ED}.itemPaths(c).map(p=>Math.round(p.length*1000)/1000)}}))"


async def body(k, case):
    pg = k.pg

    async def mode(m):
        await k.tool('trim'); await pg.click(f'#sk-host [data-trm={m}]'); await pg.wait_for_timeout(100)

    async def clear():
        await k.ev(f"(()=>{{const e={ED}; e.content.children.slice().forEach(c=>{{ if (c.data && c.data.mode) c.remove(); }}); e.sel.clear(); e.commit('清空');}})()")

    async def brk_open():
        await k.add('cut', [[20, 40], [120, 40]], closed=False)
        await mode('break')
        await k.click(60, 40); await pg.wait_for_timeout(150)
        s = await k.ev(SHAPES)
        assert len(s) == 2 and all(x['nodes'] == [2] for x in s), s
        assert sorted(x['L'][0] for x in s) == [40, 60], s
        assert '分成 40 mm 和 60 mm 两段' in await k.status(), await k.status()
        await k.ev(f"{ED}.undo()")
        assert len(await k.ev(SHAPES)) == 1, '一步撤销'
    await case('打断开放的线：两个图形、各 2 节点、40 + 60；一步撤销', brk_open())

    async def brk_closed():
        await clear()
        await k.add('cut', SQ(20, 60, 80, 40))
        await mode('break')
        await k.click(50, 60); await pg.wait_for_timeout(150)
        s = await k.ev(SHAPES)
        assert len(s) == 1 and s[0]['closed'] == [False] and s[0]['nodes'] == [6] and s[0]['L'] == [240], s
    await case('打断闭合矩形：变开放、6 个节点、周长 240 不变', brk_closed())

    async def erase_click():
        await clear()
        await k.add('cut', [[20, 40], [120, 40]], closed=False)
        await mode('erase')
        await pg.fill('#sk-host [data-o=eraseW]', '2'); await pg.press('#sk-host [data-o=eraseW]', 'Enter')
        await k.click(70, 40); await pg.wait_for_timeout(150)
        s = await k.ev(SHAPES)
        assert len(s) == 2, s
        tot = sum(x['L'][0] for x in s)
        assert abs(tot - 98) <= 0.1, (tot, s)
        assert all(47.5 < x['L'][0] < 50.5 for x in s), ('擦在点击处', s)
    await case('橡皮擦点一下（宽 2）：剩两段，长度和 = 98（≤ 0.1）', erase_click())

    async def erase_drag():
        await clear()
        await k.add('cut', [[20, 40], [120, 40]], closed=False)
        await mode('erase')
        await k.drag((40, 40), (60, 40)); await pg.wait_for_timeout(150)
        s = await k.ev(SHAPES)
        assert len(s) == 2, s
        removed = 100 - sum(x['L'][0] for x in s)
        assert 20 + 2 - 0.1 <= removed <= 20 + 2 + 2.1, ('擦掉 ≈ 拖过的 20 + 擦除宽度', removed, s)
        assert len(await k.ev(f"{ED}.undoStack")) and await k.ev(f"(()=>{{{ED}.undo(); return {ED}.content.children.filter(c=>c.data&&c.data.mode).length;}})()") == 1, '拖动擦除算一步撤销'
    await case('橡皮擦拖过 20 mm：擦掉约 22 mm，一步撤销', erase_drag())

    async def erase_closed():
        await clear()
        await k.add('cut', SQ(20, 60, 80, 40))
        await mode('erase')
        await k.click(60, 100); await pg.wait_for_timeout(150)
        s = await k.ev(SHAPES)
        assert len(s) == 1 and s[0]['closed'] == [False] and abs(s[0]['L'][0] - 238) <= 0.1, s
    await case('橡皮擦擦闭合矩形：变开放、周长 240 − 2', erase_closed())

    async def trim_still():
        await clear()
        await k.add('cut', [[20, 40], [120, 40]], closed=False)
        await k.add('cut', [[70, 20], [70, 60]], closed=False)
        await mode('trim')
        await k.click(90, 40); await pg.wait_for_timeout(150)
        s = await k.ev(SHAPES)
        assert sorted(x['L'][0] for x in s) == [40, 50], ('修剪模式照常：删掉交点右边那段', s)
    await case('修剪模式照常工作', trim_still())


asyncio.run(run(body, 'erase1')) and print('PASS erase1：打断（开放线 / 闭合图形）、橡皮擦（点 / 拖 / 闭合图形）长度正确、一步撤销、修剪照常')
