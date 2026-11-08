"""B3 配对边联动：改一条卡榫边（齿数），配对的另一条自动按互补重做，同一步撤销；
连续改 5 次（两边轮流改）、再撤销 5 次，几何和最初一致（≤ 0.001 mm）；删掉一边的齿，另一边变回没配对（不留半个配对）。带断言。"""
import asyncio
from _kit import run, ED

SQ = lambda x, y, w, h: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
SNAP = f"""(()=>{{const e={ED}; return e.content.children.filter(c=>c.data&&c.data.mode).map(c=>({{id:c.data.id,
  segs:(c.className==='CompoundPath'?c.children:[c]).map(p=>p.segments.map(s=>[s.point.x,s.point.y])),
  joints:(c.data.joints||[]).map(j=>({{id:j.id,type:j.type,k:j.k,pair:j.pair||null}}))}}));}})()"""
PAIR = f"""(()=>{{const c={ED}.connections(); return c.pairs.map(p=>({{ok:p.ok,why:p.reasons,k:p.ends.map(e=>e.j.k),types:p.ends.map(e=>e.j.type).sort()}}));}})()"""


def close(a, b):
    if len(a) != len(b):
        return False
    for x, y in zip(a, b):
        if x['id'] != y['id'] or x['joints'] != y['joints'] or len(x['segs']) != len(y['segs']):
            return False
        for p, q in zip(x['segs'], y['segs']):
            if len(p) != len(q) or any(abs(u[0] - v[0]) > 1e-3 or abs(u[1] - v[1]) > 1e-3 for u, v in zip(p, q)):
                return False
    return True


async def body(k, case):
    pg = k.pg
    await k.add('cut', SQ(20, 20, 100, 60)); await k.add('cut', SQ(150, 20, 100, 60))
    await k.tool('joint')
    await k.click(120, 50); await k.click(150, 50)
    s0 = await k.ev(SNAP)
    assert (await k.ev(PAIR))[0]['ok']

    async def edit(px, py, count):
        """卡榫工具点已有的卡榫边 → 右侧改段数 → 应用修改（真实界面）"""
        await k.click(px, py); await pg.wait_for_timeout(200)
        inp = await pg.query_selector('#sk-host [data-o=jointCount]')
        await inp.fill(str(count)); await inp.dispatch_event('change'); await pg.wait_for_timeout(150)
        await pg.click('#sk-host [data-je=apply]'); await pg.wait_for_timeout(300)

    async def one():
        n0 = len(await k.ev(f"{ED}.undoStack"))
        await edit(118, 50, 7)                                  # 改左边板的右边：7 段 = 3 个 A 齿
        p = (await k.ev(PAIR))[0]
        assert p['ok'] and p['k'] == [3, 3] and p['types'] == ['a', 'b'], p
        assert len(await k.ev(f"{ED}.undoStack")) == n0 + 1, '两条边一起改只算一步撤销'
        assert '另一条边也跟着改了' in await k.status(), await k.status()
    await case('改一条边的齿数 → 配对的另一条自动按互补重做，只算一步撤销', one())

    async def five():
        for i, (pt, n) in enumerate([((118, 50), 9), ((152, 50), 5), ((118, 50), 11), ((152, 50), 3), ((118, 50), 7)]):
            await edit(*pt, n)
            p = (await k.ev(PAIR))[0]
            assert p['ok'] and p['k'][0] == p['k'][1] == (n - 1) // 2, (i, n, p)
        for _ in range(6):                                       # 5 次轮流改 + 上一项的 1 次
            await k.ev(f"{ED}.undo()"); await pg.wait_for_timeout(80)
        assert close(await k.ev(SNAP), s0), '撤销 6 次后应和最初一模一样'
        for _ in range(6):
            await k.ev(f"{ED}.redo()"); await pg.wait_for_timeout(80)
        assert (await k.ev(PAIR))[0]['ok']
    await case('两边轮流改 5 次都保持互补；全部撤销后几何和最初一致（≤ 0.001 mm），重做也正常', five())

    async def remove():
        await k.click(118, 50); await pg.wait_for_timeout(200)
        await pg.click('#sk-host [data-je=remove]'); await pg.wait_for_timeout(300)
        c = await k.ev(f"(()=>{{const c={ED}.connections(); return [c.pairs.length, c.singles.length];}})()")
        assert c == [0, 1], ('删掉一边的齿：另一边变回没配对，不留半个配对', c)
    await case('删掉一边的齿 → 另一边变回没配对的卡榫边（不留半个配对）', remove())


asyncio.run(run(body, 'conn3')) and print('PASS conn3：改一边另一边自动互补（一步撤销）、轮流改 5 次后撤销回到最初、删一边不留半个配对')
