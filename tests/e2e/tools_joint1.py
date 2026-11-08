"""A6 ④ 卡榫、插槽、水口、修剪、测量。正常用法 + 常见误操作，带断言。
包括已知问题：点中圆的节点时，水口 / 修剪也要拾取得到边（paper.js 的同一个边界情况）。"""
import asyncio
from _kit import run, ED

SQ = lambda x, y, w, h: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
K = 0.5522847498


def circle(cx, cy, r):
    k = K * r
    return [[cx + r, cy, 0, -k, 0, k], [cx, cy + r, k, 0, -k, 0], [cx - r, cy, 0, k, 0, -k], [cx, cy - r, -k, 0, k, 0]]


async def body(k, case):
    pg = k.pg

    async def fresh():
        await k.ev(f"(()=>{{const e={ED}; e.opts.jointPeer=null; e.opts.jointType='a'; e.content.children.slice().forEach(c=>{{ if (c.data && c.data.mode) c.remove(); }}); e.sel.clear(); e.commit('清空');}})()")
        await pg.keyboard.press('Escape'); await k.tool('select')

    by_id = lambda its, i: [x for x in its if x['id'] == i][0]
    status = k.status

    # ---------------- 卡榫
    async def joint():
        await fresh()
        a = await k.add('cut', SQ(20, 20, 100, 60))
        await k.tool('joint')
        await k.click(70, 20)
        it = by_id(await k.items(), a)
        assert it['joints'] == 1 and it['n'] > 4, it
        await pg.keyboard.press('Escape')
    await case('卡榫：点矩形板的一条直边，做成指接卡榫', joint())

    async def joint_wrong():
        await fresh()
        c = await k.add('cut', circle(200, 100, 30))
        e = await k.add('engrave', SQ(20, 150, 60, 20))
        await k.tool('joint')
        await k.click(230, 100)                # 圆的边（正好是节点）
        await k.click(50, 150)                 # 雕刻线
        await k.click(300, 250)                # 空白
        its = await k.items()
        assert by_id(its, c)['joints'] == 0 and by_id(its, c)['n'] == 4, its
        assert by_id(its, e)['joints'] == 0 and by_id(its, e)['n'] == 4, its
        assert '直边' in await status(), await status()
    await case('误操作：卡榫点在圆、雕刻线、空白处 → 不改图形，提示要点直边', joint_wrong())

    async def joint_short():
        await fresh()
        a = await k.add('cut', SQ(20, 20, 2, 60))
        await k.tool('joint')
        await k.click(21, 20)
        it = by_id(await k.items(), a)
        # 2 mm 的边也能做出 1 个齿：几何要合法（闭合、面积 > 0），并且能一步撤销
        assert it['closed'] == [True] and it['area'] > 0, it
        await k.ev(f"{ED}.undo()"); await pg.wait_for_timeout(100)
        it = by_id(await k.items(), a)
        assert it['joints'] == 0 and it['n'] == 4, it
        await pg.keyboard.press('Escape')
    await case('误操作：卡榫点在很短的边（2 mm）→ 几何合法，能一步撤销', joint_short())

    # ---------------- 插槽
    async def mortise():
        await fresh()
        await k.add('cut', SQ(20, 20, 150, 100))
        await k.tool('mortise')
        await k.drag((50, 70), (130, 70), steps=10)
        its = await k.items()
        slots = [i for i in its if i['joints'] and i['n'] >= 4 and i['bounds'][2] - i['bounds'][0] < 100]
        assert slots, its
        await pg.keyboard.press('Escape')
    await case('插槽：在板面上拖出一排插槽孔', mortise())

    async def mortise_tiny():
        await fresh()
        await k.add('cut', SQ(20, 20, 150, 100))
        await k.tool('mortise')
        await k.drag((50, 70), (50.3, 70), steps=2)
        assert len(await k.items()) == 1, await k.items()
    await case('误操作：插槽只拖了一点点 → 不生成、提示太短', mortise_tiny())

    # ---------------- 水口
    async def bridge():
        await fresh()
        a = await k.add('cut', SQ(20, 20, 100, 60))
        await k.tool('bridge')
        await k.click(70, 20)
        assert by_id(await k.items(), a)['bridges'] == 1
        await k.click(70, 20)                                      # 再点一次同一处 → 删除
        assert by_id(await k.items(), a)['bridges'] == 0
    await case('水口：点切割线加水口，再点一次删除', bridge())

    async def bridge_node():
        await fresh()
        c = await k.add('cut', circle(200, 100, 30))
        await k.tool('bridge')
        await k.click(230, 100)                                    # 正好点在圆的节点上
        assert by_id(await k.items(), c)['bridges'] == 1, (await k.items(), await status())
    await case('已知问题：水口点中圆的节点也能加上', bridge_node())

    async def bridge_wrong():
        await fresh()
        e = await k.add('engrave', SQ(20, 20, 60, 20))
        await k.tool('bridge')
        await k.click(50, 20)
        await k.click(300, 250)
        assert by_id(await k.items(), e)['bridges'] == 0
        assert '切割线' in await status(), await status()
    await case('误操作：水口点在雕刻线 / 空白处 → 不加，提示点切割线', bridge_wrong())

    # ---------------- 修剪
    async def trim():
        await fresh()
        a = await k.add('score', [[0, 100], [100, 100]], closed=False)
        await k.add('score', [[50, 50], [50, 150]], closed=False)
        await k.tool('trim')
        await k.click(20, 100)
        its = await k.items()
        b = [i for i in its if i['bounds'][1] == 100 and i['bounds'][3] == 100]
        assert len(b) == 1 and b[0]['bounds'] == [50, 100, 100, 100], its
    await case('修剪：点两条交叉线中的一段，删掉到交点为止的那段', trim())

    async def trim_node():
        await fresh()
        c = await k.add('cut', circle(200, 100, 30))
        await k.add('score', [[150, 100], [250, 100]], closed=False)     # 横线正好穿过圆的左右两个节点
        await k.tool('trim')
        await k.click(200, 130)                                   # 正好点在圆顶部的节点上
        it = by_id(await k.items(), c)
        assert it['closed'] == [False] and abs(it['bounds'][3] - 100) < 1e-3, ('圆的上半圆应被剪掉', it)
    await case('已知问题：修剪点中圆的节点也能剪掉那一段', trim_node())

    async def trim_empty():
        await fresh()
        await k.add('cut', SQ(20, 20, 30, 30))
        await k.tool('trim')
        await k.click(300, 250)
        assert len(await k.items()) == 1
    await case('误操作：修剪点在空白处 → 什么都不变', trim_empty())

    # ---------------- 测量
    async def measure():
        await fresh()
        await k.add('cut', SQ(20, 20, 60, 40))
        await k.tool('measure')
        await k.click(20, 20); await k.click(80, 20)
        st = await status() + await pg.inner_text('#sk-host .sk-side')
        assert '60' in st, st
        await k.click(300, 250); await pg.keyboard.press('Escape')    # 量空白 / Esc：不报错
        assert len(await k.items()) == 1, '测量不应改动图形'
    await case('测量：点到点 60 mm；误操作：点空白、Esc 不报错、不改图形', measure())


if __name__ == "__main__": asyncio.run(run(body, "tools_joint1")) and print('PASS tools_joint1：卡榫 / 插槽 / 水口 / 修剪 / 测量的正常用法和常见误操作（含点中圆节点的情况）')
