"""B4 3D 报告到「连接」级别：三块板两对连接，自动拼装后都 ✓；然后逐个制造错误，
每种都报到对应的那一对连接（不漏报）：穿透、没拼在一起（位置不对）、两条边不一样长、齿位 / 齿数不同、少了一块板（半个配对）。带断言。"""
import asyncio
from _kit import run, ED

D = 'window.__seedDebug'
SQ = lambda x, y, w, h: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
# 连接清单：每对的两块板名 + 原因
CONNS = f"""(()=>{{const c={ED}.connections(); return c.pairs.map(p=>({{pair:p.pair, ok:p.ok, why:p.reasons, pids:p.ends.map(e=>e.pid).sort()}}));}})()"""


async def body(k, case):
    pg = k.pg
    await k.add('cut', SQ(20, 20, 100, 60))      # A
    await k.add('cut', SQ(150, 20, 100, 60))     # B
    await k.add('cut', SQ(20, 120, 100, 60))     # C
    await k.tool('joint')
    await k.click(120, 50); await k.click(150, 50)       # A 右边 ↔ B 左边
    await k.click(70, 80); await k.click(70, 120)        # A 上边 ↔ C 下边
    await k.tool('select'); await pg.wait_for_timeout(1500)
    pids = await k.ev(f"(()=>{{const p={ED}.recognizeParts().parts; const at=(x,y)=>p.find(q=>q.bounds.contains(new {ED}.ps.Point(x,y))).item.data.pid; return {{A:at(70,50), B:at(200,50), C:at(70,150)}};}})()")
    A, B, C = pids['A'], pids['B'], pids['C']
    pair_of = lambda cs, x, y: [c for c in cs if c['pids'] == sorted([x, y])][0]

    async def state():
        await k.ev(f"{D}.checkPose()"); await pg.wait_for_timeout(1500)
        return await k.ev(f"{D}.connState"), await k.ev(CONNS)

    async def assemble():
        await pg.click('.sk-back'); await pg.wait_for_timeout(3500)
        await pg.click('#parts-panel [data-k=auto]'); await pg.wait_for_timeout(6000)
        await pg.click('#stage-bar [data-stage=design]'); await pg.wait_for_timeout(2000)
        cs3, cs = await state()
        assert len(cs3) == 2 and all(v['state'] == 'ok' for v in cs3.values()), cs3
        assert len(cs) == 2 and all(c['ok'] for c in cs), cs
    await case('自动拼装后两对连接 3D 都 ✓，连接清单全部 ✓', assemble())

    poses0 = await k.ev(f"JSON.stringify({D}.W.project.poses)")

    async def restore():
        await k.ev(f"{D}.W.project.poses = JSON.parse({poses0!r})")

    async def collide():
        await k.ev(f"(()=>{{const P={D}.W.project.poses; P['{B}'] = P['{A}'].slice();}})()")     # B 摆到和 A 同一个位置
        try:
            cs3, cs = await state()
            ab = pair_of(cs, A, B)
            assert not ab['ok'] and any('穿透' in w for w in ab['why']), ab
            assert pair_of(cs, A, C)['ok'], ('不相关的连接不能误报', cs)
        finally:
            await restore()
    await case('穿透：报在 A ↔ B 这一对上，A ↔ C 仍 ✓', collide())

    async def apart():
        await k.ev(f"(()=>{{const P={D}.W.project.poses; P['{C}'] = P['{C}'].slice(); P['{C}'][14] += 200;}})()")   # C 往上挪开 200 mm
        try:
            cs3, cs = await state()
            ac = pair_of(cs, A, C)
            assert not ac['ok'] and any('没拼在一起' in w for w in ac['why']), ac
            assert pair_of(cs, A, B)['ok'], cs
        finally:
            await restore()
        cs3, cs = await state()
        assert all(c['ok'] for c in cs), ('恢复后应全部 ✓', cs)
    await case('没拼在一起（位置不对）：报在 A ↔ C 这一对上；恢复后全部 ✓', apart())

    async def length():
        await k.add('cut', SQ(150, 120, 60, 60))      # D：60 mm 宽
        await k.tool('joint'); await k.click(250, 70); await k.click(180, 120)    # B 右边（60）↔ D 下边（60）先配一对正常的
        await k.tool('select'); await pg.wait_for_timeout(800)
        await k.add('cut', SQ(280, 230, 40, 40))      # E：40 mm（放在上面，避开右下角的 3D 预览）
        await k.tool('joint'); await k.click(180, 180); await k.click(300, 230)   # D 上边（60）↔ E 下边（40）：不一样长
        await k.tool('select')
        cs3, cs = await state()
        bad = [c for c in cs if any('不一样长' in w for w in c['why'])]
        assert len(bad) == 1, cs
    await case('两条边不一样长：报在那一对上（3D 拼不上，原因写清楚）', length())

    async def teeth():
        await k.ev(f"""(()=>{{const e={ED}; const it=e.content.children.find(c=>c.data&&c.data.pid==='{B}');
          const j=it.data.joints.find(q=>q.pair); e.remakeJoint(it, j, {{iv:[[5,15],[30,40]]}}); e.commit('改乱齿位');}})()""")
        cs3, cs = await state()
        ab = pair_of(cs, A, B)
        assert not ab['ok'] and any('齿位' in w or '拼不上' in w for w in ab['why']), ab
        await k.ev(f"{ED}.undo()")
    await case('齿位 / 齿数不同：报在 A ↔ B 这一对上', teeth())

    async def missing():
        await k.ev(f"(()=>{{const e={ED}; const it=e.content.children.find(c=>c.data&&c.data.pid==='{C}'); it.remove(); e.commit('删掉 C');}})()")
        cs3, cs = await state()
        half = [c for c in cs if len(c['pids']) == 1]
        assert half and any('找不到' in w for w in half[0]['why']) and half[0]['pids'] == [A], cs
    await case('少了一块板：A 上那条边报「另一条边找不到了」', missing())


asyncio.run(run(body, 'conn4')) and print('PASS conn4：自动拼装后连接 ✓；穿透 / 没拼在一起 / 不一样长 / 齿位不同 / 少一块板，每种都报到对应的那一对连接，不误报')
