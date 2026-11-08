"""C2 锁定 / 隐藏：锁定后点 / 拖 / 框选 / Delete / Ctrl+A 都碰不到它、点到时提示；全部解锁后恢复；
隐藏后画板上看不到、选不中、导出的 SVG 里仍有；图层眼睛能隐藏整层；保存再打开状态还在。带断言。"""
import asyncio, json, os, tempfile
from _kit import run, ED

SQ = lambda x, y, w, h: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
TMP = tempfile.mkdtemp(prefix='seedlaser-lock1-')


async def body(k, case):
    pg = k.pg
    a = await k.add('cut', SQ(20, 20, 60, 40))
    b = await k.add('cut', SQ(120, 20, 60, 40))
    sel = lambda: k.ev(f"[...{ED}.sel].map(c=>c.data.id)")

    async def act(name):
        # 变换面板里的按钮（面板可能折叠着）：直接走按钮绑定的同一个入口
        await k.ev(f"(()=>{{const e={ED}; e.setCollapsed && e.$$('.sk-side [data-key=t-group]').forEach(c=>e.setCollapsed(c,false));}})()")
        btn = await pg.query_selector(f'#sk-host [data-act={name}]')
        if btn and await btn.is_visible():
            await btn.click()
        else:
            await k.ev(f"{ED}.act({name!r})")
        await pg.wait_for_timeout(200)
    bounds = lambda i: k.ev(f"(()=>{{const c={ED}.content.children.find(x=>x.data&&x.data.id==='{i}'); return c?[c.bounds.left,c.bounds.top]:null;}})()")

    async def lock():
        await k.select(a)
        await act('lock')
        assert await sel() == [], '锁定后应取消选中'
        await k.click(20, 40)                                        # 点它的边
        assert await sel() == [] and '已锁定' in await k.status(), await k.status()
        await k.drag((40, 40), (80, 80))                             # 从内部拖：不动（变成框选）
        assert await bounds(a) == [20, 20], await bounds(a)
        await k.drag((5, 5), (200, 100))                             # 框选两块：只选到 b
        assert await sel() == [b], await sel()
        await pg.keyboard.press('Escape')
        await pg.keyboard.press('Control+a'); await pg.wait_for_timeout(100)
        assert a not in await sel(), 'Ctrl+A 不选锁定的'
        await k.select(b); await pg.keyboard.press('Delete'); await pg.wait_for_timeout(100)
        assert await k.ev(f"{ED}.content.children.some(c=>c.data&&c.data.id==='{a}')"), 'Delete 不删锁定的'
        await k.ev(f"{ED}.undo()")
    await case('锁定：点不中（有提示）、拖不动、框选选不到、Ctrl+A 不选、Delete 不删', lock())

    async def unlock():
        await k.ev(f"{ED}.$('.sk-layers-card').classList.remove('hidden')")      # 图层卡片默认收起，点左下角色块可打开
        assert await pg.is_visible('#sk-host .sk-lockinfo'), '图层卡片应显示锁定统计'
        await pg.click('#sk-host .sk-lockinfo [data-act=unlockAll]'); await pg.wait_for_timeout(200)
        await k.click(20, 40)
        assert await sel() == [a], await sel()
        await k.drag((40, 40), (60, 60))
        assert await bounds(a) == [40, 40], await bounds(a)
        await k.ev(f"{ED}.undo()"); await pg.keyboard.press('Escape')
    await case('全部解锁后能选、能拖', unlock())

    async def hide():
        await k.select(a)
        await act('hide')
        vis = await k.ev(f"{ED}.content.children.find(x=>x.data&&x.data.id==='{a}').visible")
        assert vis is False, '隐藏后不显示'
        await k.click(20, 40)
        assert await sel() == []
        path = os.path.join(TMP, 'hidden.svg')
        await pg.evaluate(f"window.pywebview.api.dev_set_pick({json.dumps(path)})")
        await pg.evaluate("void window.SeedApp.file('export', 'svg')")
        await pg.wait_for_selector('.burn-ask'); await pg.click('.burn-ask [data-r=comp]'); await pg.wait_for_timeout(2500)
        svg = open(path, encoding='utf-8').read()
        assert svg.count('<path') >= 2, ('隐藏的图形仍要导出', svg.count('<path'))
    await case('隐藏：画板上不显示、选不中，导出里仍有', hide())

    async def layer_eye():
        await k.ev(f"{ED}.$('.sk-layers-card').classList.remove('hidden')")
        await pg.click('#sk-host .sk-eye[data-eye=cut]'); await pg.wait_for_timeout(200)
        assert await k.ev(f"{ED}.content.children.find(x=>x.data&&x.data.id==='{b}').visible") is False
        await k.click(120, 40)
        assert await sel() == []
        await pg.click('#sk-host .sk-lockinfo [data-act=showAll]'); await pg.wait_for_timeout(200)
        assert await k.ev(f"{ED}.content.children.filter(x=>x.data&&x.data.mode).every(x=>x.visible)")
        assert not await pg.is_visible('#sk-host .sk-lockinfo')
    await case('图层眼睛：隐藏整层 → 选不中；「全部显示」恢复（含被隐藏的图形）', layer_eye())

    async def persist():
        await k.select(a); await act('lock')
        await k.select(b); await act('hide')
        path = os.path.join(TMP, '锁定.seedlaser')
        await pg.evaluate(f"window.pywebview.api.dev_set_pick({json.dumps(path)})")
        await pg.evaluate("window.SeedApp.file('saveas')"); await pg.wait_for_timeout(1200)
        await pg.evaluate(f"void window.SeedApp.file('openPath', {json.dumps(path)})"); await pg.wait_for_timeout(2500)
        st = await k.ev(f"(()=>{{const o={{}}; {ED}.content.children.forEach(c=>{{ if(c.data&&c.data.mode) o[c.data.id.split('§').pop()]=[!!c.data.lock, !!c.data.hidden]; }}); return o;}})()")
        assert st.get(a) == [True, False] and st.get(b) == [False, True], st
    await case('保存再打开：锁定 / 隐藏状态还在', persist())


asyncio.run(run(body, 'lock1')) and print('PASS lock1：锁定碰不到（点 / 拖 / 框选 / Ctrl+A / Delete）、全部解锁恢复；隐藏不显示仍导出；图层眼睛；保存再打开状态还在')
