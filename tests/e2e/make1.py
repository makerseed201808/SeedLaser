"""C5 一键造物：
直角盒子（有盖）→ 6 块板、12 对卡榫，连接清单全部 ✓，「按卡榫自动拼装」6 块都拼上、无穿透、每对连接 3D ✓；
外部尺寸 → 底板 = 外部 − 2 × 板厚；没盖 → 5 块板 8 对；
圆角盒子 → 3 块板（侧壁带活铰链切缝）；
模数齿轮 m=2、20 齿 + 12 齿 → 齿数、齿顶圆、分度圆 = 模数 × 齿数（≤ 0.01 mm）、中心距 = m(z1+z2)/2；
徽章 / 印章：圆形 50 mm 外形切割、边框描线、文字雕刻；勾「镜像」后文字左右翻转。带断言。"""
import asyncio, math
from _kit import run, ED

D = 'window.__seedDebug'
CONNS = f"""(()=>{{const c={ED}.connections(); return {{pairs:c.pairs.map(p=>({{ok:p.ok, why:p.reasons}})), singles:c.singles.length}};}})()"""
PARTS = f"""(()=>{{const r={ED}.recognizeParts(); return {{n:r.parts.length, loose:r.loose.length, parts:r.parts.map(p=>({{w:Math.round(p.item.bounds.width*100)/100, h:Math.round(p.item.bounds.height*100)/100, m:p.members.length}}))}};}})()"""


async def body(k, case):
    pg = k.pg
    t = await k.ev(f"{ED}.part.thickness")

    async def clear():
        await k.ev(f"(()=>{{const e={ED}; e.content.children.slice().forEach(c=>{{ if (c.data && c.data.mode) c.remove(); }}); e.sel.clear(); e.commit('清空');}})()")

    async def gen(kind, **params):
        await k.ev(f"{ED}.setTool('make')"); await pg.wait_for_timeout(150)
        await pg.click(f'#sk-host [data-mkind={kind}]'); await pg.wait_for_timeout(150)
        for key, v in params.items():
            sel = f'#sk-host [data-mk="{kind}.{key}"]'
            if isinstance(v, bool):
                if await pg.is_checked(sel) != v:
                    await pg.click(sel)
            elif await pg.evaluate(f"document.querySelector('{sel}').tagName") == 'SELECT':
                await pg.select_option(sel, str(v))
            else:
                await pg.fill(sel, str(v)); await pg.press(sel, 'Enter')
            await pg.wait_for_timeout(80)
        await pg.click('#sk-host [data-mkgo]'); await pg.wait_for_timeout(1500)

    async def box():
        await gen('box', w=80, d=60, h=50, outer=False, lid=True)
        p = await k.ev(PARTS)
        assert p['n'] == 6 and p['loose'] == 0, p
        c = await k.ev(CONNS)
        assert len(c['pairs']) == 12 and c['singles'] == 0 and all(x['ok'] for x in c['pairs']), c
        assert '6 块板、12 对卡榫' in await k.status(), await k.status()
        # 板身（不含齿）= 内部尺寸：外框 = 内部尺寸 + 两侧齿深
        sizes = sorted((x['w'], x['h']) for x in p['parts'])
        assert (80 + 2 * t, 60 + 2 * t) in sizes or (80, 60 + 2 * t) in sizes or (80 + 2 * t, 60) in sizes, sizes
    await case('直角盒子（有盖）：6 块板、12 对卡榫，连接清单全部 ✓', box())

    async def assemble():
        await k.tool('select'); await pg.wait_for_timeout(1200)
        await pg.click('.sk-back'); await pg.wait_for_timeout(3500)
        try:
            await pg.click('#parts-panel [data-k=auto]'); await pg.wait_for_timeout(12000)
            poses = await k.ev(f"Object.keys({D}.W.project.poses || {{}}).length")
            assert poses == 6, ('6 块板都应拼上', poses)
            rep = await k.ev(f"{D}.W.pose.report")
            assert rep and not any(v['collide'] for v in rep.values()), ('拼装后不应穿透', rep)
            cs3 = await k.ev(f"{D}.connState")
            states = [v['state'] for v in cs3.values()]
            assert len(states) == 12 and all(s == 'ok' for s in states), [s for s in states]
            zs = await k.ev(f"Object.values({D}.W.project.poses).map(m=>m[14])")
            assert max(zs) - min(zs) > 40, ('盒子应立起来（各板高度不同）', zs)
        finally:
            await pg.click('#stage-bar [data-stage=design]'); await pg.wait_for_timeout(2500)
    await case('按卡榫自动拼装：6 块都拼上、无穿透、12 对连接 3D 全部 ✓', assemble())

    async def outer_nolid():
        await clear()
        await gen('box', w=80, d=60, h=50, outer=True, lid=False)
        p = await k.ev(PARTS)
        assert p['n'] == 5, p
        c = await k.ev(CONNS)
        assert len(c['pairs']) == 8 and all(x['ok'] for x in c['pairs']), c
        assert f'内部 {80 - 2 * t:g} × {60 - 2 * t:g} × {50 - t:g} mm' in await k.status(), await k.status()
    await case('外部尺寸、没盖：5 块板 8 对卡榫，内部尺寸 = 外部 − 板厚', outer_nolid())

    async def rbox():
        await clear()
        await gen('rbox', w=100, d=80, h=50, r=15, outer=False, top='closed')
        p = await k.ev(PARTS)
        assert p['n'] == 3, p
        strip = max(p['parts'], key=lambda x: x['w'])
        assert strip['m'] > 20, ('侧壁要有活铰链切缝', strip)
        assert abs(strip['h'] - (50 + 2 * t)) < 1.5, strip
        assert '已生成圆角盒子：3 块板' in await k.status(), await k.status()
    await case('圆角盒子：3 块板，侧壁带活铰链切缝', rbox())

    async def gear():
        await clear()
        await gen('gear', m=2, z1=20, z2=12, bore=5, lighten=True, pair=True)
        info = await k.ev(f"""(()=>{{const e={ED}; return e.content.children.filter(c=>c.data&&c.data.mode==='cut'&&c.data.gear).map(c=>{{
          const p=e.itemPaths(c)[0]; const bore=e.content.children.find(h=>h!==c&&h.data&&h.data.group===c.data.group&&Math.abs(h.bounds.width-5)<0.01); const ctr=bore?bore.bounds.center:c.bounds.center; const d=p.segments.map(s=>s.point.getDistance(ctr));
          const ra=Math.max(...d); let tips=0, on=false; p.segments.forEach(s=>{{ const at=Math.abs(s.point.getDistance(ctr)-ra)<0.01; if(at&&!on) tips++; on=at; }});
          if (on && Math.abs(p.segments[0].point.getDistance(ctr)-ra)<0.01) tips--;
          return {{z:c.data.gear.z, tips, ra, cx:ctr.x, cy:ctr.y}}; }});}})()""")
        assert len(info) == 2, info
        for g in info:
            assert g['tips'] == g['z'], ('齿数', g)
            m = 2 * g['ra'] / (g['z'] + 2)                       # 齿顶圆 da = m (z + 2) → 反推模数
            assert abs(m * g['z'] - 2 * g['z']) <= 0.01, ('分度圆 = 模数 × 齿数', g, m)
        # 中心距：两个齿轮外框中心的距离（20 齿偶数、外框中心就是圆心；12 齿也是偶数）
        a = math.hypot(info[0]['cx'] - info[1]['cx'], info[0]['cy'] - info[1]['cy'])
        assert abs(a - 2 * (20 + 12) / 2) < 0.05, a
        holes = await k.ev(f"{ED}.recognizeParts().parts.map(p=>p.members.length).sort()")
        assert holes == [2 + 4, 2 + 4] or holes == [2, 6] or all(h >= 2 for h in holes), holes
        assert '中心距 32 mm' in await k.status(), await k.status()
    await case('模数齿轮 m=2、20 + 12 齿：齿数对、分度圆 = 模数 × 齿数（≤0.01）、中心距 32', gear())

    async def badge():
        await clear()
        await gen('badge', shape='circle', d=50, text='AB', arc=False, border=True, mirror=False)
        its = await k.ev(f"{ED}.content.children.filter(c=>c.data&&c.data.mode).map(c=>({{mode:c.data.mode, w:Math.round(c.bounds.width*100)/100, l:c.bounds.left, r:c.bounds.right, cx:c.bounds.center.x}}))")
        modes = sorted(x['mode'] for x in its)
        assert modes == ['cut', 'engrave', 'score'], its
        cut = [x for x in its if x['mode'] == 'cut'][0]
        assert cut['w'] == 50, cut
        eng = [x for x in its if x['mode'] == 'engrave'][0]
        shape0 = await k.ev(f"(()=>{{const e={ED}; const it=e.content.children.find(c=>c.data&&c.data.mode==='engrave'); return e.itemPaths(it).map(p=>Math.round((p.firstSegment.point.x-it.bounds.center.x)*100)/100);}})()")
        await clear()
        await gen('badge', mirror=True)
        shape1 = await k.ev(f"(()=>{{const e={ED}; const it=e.content.children.find(c=>c.data&&c.data.mode==='engrave'); return e.itemPaths(it).map(p=>Math.round((p.firstSegment.point.x-it.bounds.center.x)*100)/100);}})()")
        assert sorted(shape0) == sorted(-x for x in shape1) and shape0 != shape1, ('镜像后文字左右翻转', shape0, shape1)
        assert '印章（已镜像）' in await k.status(), await k.status()
        assert eng['w'] > 5
    await case('徽章：外形切割 50 mm、边框描线、文字雕刻；印章镜像后文字左右翻转', badge())


asyncio.run(run(body, 'make1')) and print('PASS make1：直角盒子 6 块 12 对 ✓ 自动拼装无穿透、外部尺寸 / 无盖 5 块 8 对、圆角盒子 3 块带活铰链、齿轮齿数 / 分度圆 / 中心距、徽章三层 + 印章镜像')
