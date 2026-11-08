"""B2 连接检查 + 一键修复：每类问题先造出来（清单里 ⚠ 并写原因），点修复按钮后变 ✓，并且一步撤销能回去。
覆盖：不一样长（只提示）、齿不互补、齿位对不上、板厚改了、半个配对；相邻两条 B 边不误报；以及「修改已有卡榫后配对号丢失」的修复。带断言。"""
import asyncio
from _kit import run, ED

SQ = lambda x, y, w, h: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]

CONNS = f"""(()=>{{const c={ED}.connections(); const f=(x)=>({{key:x.key, ok:x.ok, why:x.reasons||[], fixes:x.fixes||[], n:x.ends.length, types:x.ends.map(e=>e.j.type)}});
  return {{pairs:c.pairs.map(f), singles:c.singles.map(f)}};}})()"""


async def body(k, case):
    pg = k.pg
    conns = lambda: k.ev(CONNS)

    async def fresh(*rects):
        await k.ev(f"(()=>{{const e={ED}; e.opts.jointPeer=null; e.opts.jointType='a'; e.content.children.slice().forEach(c=>{{ if (c.data && c.data.mode) c.remove(); }}); e.sel.clear(); e.commit('清空');}})()")
        for r in rects:
            await k.add('cut', r)
        await k.tool('joint')

    async def pair(p, q):
        await k.click(*p); await k.click(*q)

    async def fix(kind):
        before = len(await k.ev(f"{ED}.undoStack"))
        await k.tool('select'); await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
        await pg.click(f'#sk-host .sk-conn.warn [data-fix={kind}]'); await pg.wait_for_timeout(500)
        assert len(await k.ev(f"{ED}.undoStack")) == before + 1, '修复应只算一步撤销'

    async def mutate(js):
        """直接改一条边制造问题（模拟学生改过板 / 改过卡榫）。js 里 e = 编辑器，J = 第二条卡榫边 {item, joint}。"""
        await k.ev(f"""(()=>{{const e={ED}; const all=[]; e.content.children.forEach(it=>(it.data&&it.data.joints||[]).forEach(j=>all.push({{item:it, joint:j}})));
          const J=all[all.length-1]; {js}; e.commit('造问题');}})()""")

    async def mismatch():
        await fresh(SQ(20, 20, 100, 60), SQ(150, 20, 60, 60))
        await pair((70, 20), (180, 20))
        c = await conns()
        assert not c['pairs'][0]['ok'] and any('不一样长' in w for w in c['pairs'][0]['why']), c
        assert 'match' not in c['pairs'][0]['fixes'] and 'complement' not in c['pairs'][0]['fixes'], '长度不一样不能自动修'
    await case('两条边不一样长：⚠ 写原因、提示改板的尺寸（不能自动修）', mismatch())

    async def complement():
        await fresh(SQ(20, 20, 100, 60), SQ(150, 20, 100, 60))
        await pair((120, 50), (150, 50))
        assert (await conns())['pairs'][0]['ok']
        await mutate("e.remakeJoint(J.item, J.joint, {type:'a'})")           # 第二条也变成 A 齿
        c = await conns()
        assert not c['pairs'][0]['ok'] and any('互补' in w for w in c['pairs'][0]['why']) and 'complement' in c['pairs'][0]['fixes'], c
        await fix('complement')
        c = await conns()
        assert c['pairs'][0]['ok'] and sorted(c['pairs'][0]['types']) == ['a', 'b'], c
        await k.ev(f"{ED}.undo()"); assert not (await conns())['pairs'][0]['ok'], '撤销后回到修之前'
    await case('齿不能互补（A + A）：⚠ →「做成互补的齿」→ ✓；一步撤销回去', complement())

    async def match():
        await fresh(SQ(20, 20, 100, 60), SQ(150, 20, 100, 60))
        await pair((120, 50), (150, 50))
        await mutate("e.remakeJoint(J.item, J.joint, {iv:[[5,15],[30,40]]})")    # 齿位改乱
        c = await conns()
        assert not c['pairs'][0]['ok'] and any('齿位对不上' in w for w in c['pairs'][0]['why']), c
        await fix('match')
        assert (await conns())['pairs'][0]['ok'], await conns()
    await case('齿位对不上：⚠ →「按 A 边重做齿位」→ ✓', match())

    async def depth():
        await fresh(SQ(20, 20, 100, 60), SQ(150, 20, 100, 60))
        await pair((120, 50), (150, 50))
        await k.tool('select'); await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
        inp = await pg.query_selector('#sk-host [data-thick]')
        await inp.fill('4'); await inp.dispatch_event('change'); await pg.wait_for_timeout(600)
        c = await conns()
        assert not c['pairs'][0]['ok'] and any('板厚' in w for w in c['pairs'][0]['why']) and 'depth' in c['pairs'][0]['fixes'], c
        await fix('depth')
        c = await conns()
        assert c['pairs'][0]['ok'], c
        assert await k.ev(f"(()=>{{let d=[]; {ED}.content.children.forEach(it=>(it.data&&it.data.joints||[]).forEach(j=>d.push(j.depth))); return d;}})()") == [4, 4]
        inp = await pg.query_selector('#sk-host [data-thick]')
        await inp.fill('3'); await inp.dispatch_event('change'); await pg.wait_for_timeout(400)
    await case('板厚改了（3 → 4 mm）：⚠ →「按现在板厚重做」→ ✓、齿深都是 4', depth())

    async def half():
        await fresh(SQ(20, 20, 100, 60), SQ(150, 20, 100, 60))
        await pair((120, 50), (150, 50))
        await k.ev(f"(()=>{{const e={ED}; const b=e.content.children.filter(c=>c.data&&c.data.mode)[1]; b.remove(); e.commit('删掉一块板');}})()")
        c = await conns()
        assert len(c['pairs']) == 1 and c['pairs'][0]['n'] == 1 and 'unpair' in c['pairs'][0]['fixes'], c
        await fix('unpair')
        c = await conns()
        assert not c['pairs'] and len(c['singles']) == 1 and c['singles'][0]['ok'], c
    await case('另一块板删掉了（半个配对）：⚠ →「解除配对」→ 变成没配对的卡榫边', half())

    async def corner_ok():
        # 同一块板相邻两条 B 边（比如盒底四边）：两条边的角齿在角的两侧，不会相碰，不能误报
        await fresh(SQ(150, 20, 100, 100), SQ(280, 20, 100, 100), SQ(150, 160, 100, 60))
        await pair((280, 70), (250, 70))      # 右边板的左边（A）↔ 板 X 的右边（B）
        await pair((200, 160), (200, 120))    # 上面板的下边（A）↔ 板 X 的上边（B）
        c = await conns()
        assert len(c['pairs']) == 2 and all(p['ok'] for p in c['pairs']), ('相邻两条 B 边不应报错', c)
    await case('不误报：同一块板相邻两条 B 边（盒底常见）全部 ✓', corner_ok())

    async def edit_keeps_pair():
        await fresh(SQ(20, 20, 100, 60), SQ(150, 20, 100, 60))
        await pair((120, 50), (150, 50))
        await k.ev(f"""(()=>{{const e={ED}; const it=e.content.children.find(c=>c.data&&c.data.joints&&c.data.joints.length);
          e.startEditJoint({{item: it, joint: it.data.joints[0]}}); e.applyEditJoint(false);}})()""")
        c = await conns()
        assert len(c['pairs']) == 1 and c['pairs'][0]['n'] == 2, ('修改卡榫后配对号不能丢', c)
    await case('修改已有的卡榫（应用修改）后配对号还在（原来会丢）', edit_keeps_pair())


asyncio.run(run(body, 'conn2')) and print('PASS conn2：不一样长 / 齿不互补 / 齿位对不上 / 板厚改了 / 半个配对——⚠ 写原因，相邻 B 边不误报，修复后 ✓、一步撤销；修改卡榫不丢配对')
