"""B5 插槽跨板配对（T 型）：隔板的下边做 A 边（不配对）→ 插槽工具右侧选它 → 在底板上单击开插槽，
插槽和 A 边配成一对；连接清单里是「插槽（T 型）」✓；自动拼装成功、无穿透、这对连接 3D ✓；修改插槽后配对还在。带断言。"""
import asyncio
from _kit import run, ED

D = 'window.__seedDebug'
SQ = lambda x, y, w, h: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
CONNS = f"""(()=>{{const c={ED}.connections(); return {{pairs:c.pairs.map(p=>({{ok:p.ok, why:p.reasons, tee:p.tee, types:p.ends.map(e=>e.j.type).sort(), pids:p.ends.map(e=>e.pid)}})), singles:c.singles.length, mortises:c.mortises.length}};}})()"""


async def body(k, case):
    pg = k.pg
    await k.add('cut', SQ(20, 20, 160, 100))      # 底板
    await k.add('cut', SQ(220, 160, 100, 60))     # 隔板（放在上面，避开右下角的 3D 预览）

    async def make():
        await k.tool('joint')
        await k.click(270, 160); await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)   # 隔板下边：A 边，不配对
        c = await k.ev(CONNS)
        assert c['singles'] == 1 and not c['pairs'], c
        await k.tool('mortise'); await pg.wait_for_timeout(300)
        btn = await pg.query_selector('#sk-host [data-peer]')
        assert btn, '插槽工具右侧应列出画板上没配对的 A 边'
        assert '下边' in await btn.inner_text(), await btn.inner_text()
        await btn.click(); await pg.wait_for_timeout(200)
        await k.click(100, 70); await pg.wait_for_timeout(300)              # 在底板中间单击开插槽
        c = await k.ev(CONNS)
        assert len(c['pairs']) == 1 and c['pairs'][0]['tee'] and c['pairs'][0]['types'] == ['a', 'mortise'], c
        assert c['pairs'][0]['ok'], c
        assert c['singles'] == 0 and c['mortises'] == 0, c
        assert '配成一对' in await k.status(), await k.status()
    await case('隔板 A 边 + 底板插槽配成一对：连接清单里是「插槽（T 型）」✓', make())

    async def assemble():
        await k.tool('select'); await pg.wait_for_timeout(1200)
        await pg.click('.sk-back'); await pg.wait_for_timeout(3500)
        await pg.click('#parts-panel [data-k=auto]'); await pg.wait_for_timeout(6000)
        poses = await k.ev(f"Object.keys({D}.W.project.poses || {{}}).length")
        assert poses == 2, ('两块板都应拼上', poses)
        rep = await k.ev(f"{D}.W.pose.report")
        assert rep and not any(v['collide'] for v in rep.values()), ('T 型拼装后不应穿透', rep)
        cs3 = await k.ev(f"{D}.connState")
        assert list(v['state'] for v in cs3.values()) == ['ok'], cs3
        await pg.click('#stage-bar [data-stage=design]'); await pg.wait_for_timeout(2000)
        c = await k.ev(CONNS)
        assert c['pairs'][0]['ok'], c
    await case('自动拼装：隔板插进插槽、无穿透，这对连接 3D ✓', assemble())

    async def edit():
        await k.ev(f"""(()=>{{const e={ED}; const it=e.content.children.find(c=>c.data&&(c.data.joints||[]).some(j=>j.type==='mortise'));
          e.setTool('mortise'); e.startEditJoint({{item: it, joint: it.data.joints[0]}}); e.opts.jointPlay = 0.1; e.applyEditJoint(false);}})()""")
        c = await k.ev(CONNS)
        assert len(c['pairs']) == 1 and c['pairs'][0]['tee'], ('修改插槽后配对号不能丢', c)
    await case('修改插槽（加间隙）后，它和 A 边的配对还在', edit())


asyncio.run(run(body, 'conn5')) and print('PASS conn5：插槽和另一块板的 A 边配成一对（T 型），清单 ✓、自动拼装无穿透、3D ✓、修改插槽不丢配对')
