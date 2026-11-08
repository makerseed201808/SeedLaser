"""C3 尺寸标注：标注工具点一条边 → 数字 = 边长；点两个节点 → 数字 = 距离；改图形宽度 → 数字跟着变；
默认导出的 SVG 里没有标注，勾选「标注一起导出」后有（描线层 + 文字）；拖动标注改引出距离；标注不算「不在板里」；保存再打开还在。带断言。"""
import asyncio, json, os, re, tempfile
from _kit import run, ED

SQ = lambda x, y, w, h: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
TMP = tempfile.mkdtemp(prefix='seedlaser-dim1-')
DIMS = f"""(()=>{{const e={ED}; return e.content.children.filter(c=>c.data&&c.data.mode==='dim').map(c=>{{const g=e.dimGeom(c); return {{id:c.data.id, L:Math.round(g.a.getDistance(g.b)*1000)/1000, off:g.off, ref:!!(c.data.dim&&c.data.dim.ref), n:e.itemPaths(c).length}};}});}})()"""
LABELS = f"{ED}.dimLayer.children.map(t=>t.content)"


async def body(k, case):
    pg = k.pg
    a = await k.add('cut', SQ(20, 20, 100, 60))
    await k.add('cut', SQ(200, 20, 50, 50))

    async def edge():
        await k.tool('dim')
        await k.click(70, 20)                                    # 下边（y = 20 这条边）
        await k.click(70, 5)                                     # 放在边的下方 15 mm 处
        d = await k.ev(DIMS)
        assert len(d) == 1 and d[0]['L'] == 100 and d[0]['ref'] and d[0]['n'] == 5, d
        assert abs(abs(d[0]['off']) - 15) < 0.6, d
        assert await k.ev(LABELS) == ['100'], await k.ev(LABELS)
        assert '已标注 100 mm' in await k.status(), await k.status()
    await case('标注工具点一条边 → 一条标注，数字 = 边长 100，引出距离按鼠标', edge())

    async def points():
        await k.click(20, 80); await k.click(200, 70); await k.click(100, 95)     # 板 1 左上角节点 → 板 2 左上角节点
        d = await k.ev(DIMS)
        assert len(d) == 2 and abs(d[1]['L'] - ((180 ** 2 + 10 ** 2) ** 0.5)) < 1e-3 and d[1]['ref'], d
    await case('点两个节点 → 数字 = 两点距离，记住引用的节点', points())

    async def follow():
        await k.tool('select'); await k.select(a)
        inp = await pg.query_selector('#sk-host [data-num=w]')
        await inp.fill('130'); await inp.press('Enter'); await pg.wait_for_timeout(300)
        d = await k.ev(DIMS)
        assert d[0]['L'] == 130, ('改宽度后标注要跟着变', d)
        assert '130' in await k.ev(LABELS), await k.ev(LABELS)
        await k.ev(f"{ED}.undo()"); await pg.wait_for_timeout(100)
        assert (await k.ev(DIMS))[0]['L'] == 100
    await case('改图形宽度 100 → 130：标注数字跟着变；撤销回 100', follow())

    async def drag():
        await k.tool('select')
        await k.drag((50, 5), (50, -5)); await pg.wait_for_timeout(200)    # 拖尺寸线：往外再拉 10 mm
        d = await k.ev(DIMS)
        assert d[0]['L'] == 100 and abs(abs(d[0]['off']) - 25) < 0.6, ('拖动标注改引出距离', d)
        ends = await k.ev(f"(()=>{{const e={ED}; const it=e.content.children.find(c=>c.data&&c.data.mode==='dim'); return e.itemPaths(it)[1].firstSegment.point.y;}})()")
        assert abs(ends - 20) < 1e-6, ('引出线仍从被标注的边开始', ends)
        await k.ev(f"{ED}.undo()"); await pg.wait_for_timeout(100)
        assert abs(abs((await k.ev(DIMS))[0]['off']) - 15) < 0.6
    await case('拖动标注：引出距离 15 → 25，引出线仍从边开始；撤销回 15', drag())

    async def not_loose():
        info = await k.ev(f"(()=>{{const r={ED}.recognizeParts(); return [r.parts.length, r.loose.length, r.parts.map(p=>p.members.length)];}})()")
        assert info[0] == 2 and info[1] == 0, ('标注不应算「不在板里」', info)
    await case('标注归到它量的板上，不算「不在板里」', not_loose())

    async def export():
        p1 = os.path.join(TMP, 'nodim.svg')
        await pg.evaluate(f"window.pywebview.api.dev_set_pick({json.dumps(p1)})")
        await pg.evaluate("void window.SeedApp.file('export', 'svg')")
        await pg.wait_for_selector('.burn-ask')
        assert await pg.query_selector('.burn-ask [data-dims]'), '有标注时导出框里应有「标注一起导出」'
        await pg.click('.burn-ask [data-r=comp]'); await pg.wait_for_timeout(2500)
        s1 = open(p1, encoding='utf-8').read()
        assert 'rgb(255,0,255)' not in s1 and '<text' not in s1, '默认不导出标注'
        p2 = os.path.join(TMP, 'dim.svg')
        await pg.evaluate(f"window.pywebview.api.dev_set_pick({json.dumps(p2)})")
        await pg.evaluate("void window.SeedApp.file('export', 'svg')")
        await pg.wait_for_selector('.burn-ask'); await pg.click('.burn-ask [data-dims]'); await pg.click('.burn-ask [data-r=comp]'); await pg.wait_for_timeout(2500)
        s2 = open(p2, encoding='utf-8').read()
        assert s2.count('rgb(255,0,255)') >= 5, ('勾选后标注的线在描线层', s2.count('rgb(255,0,255)'))
        txt = re.findall(r'<text[^>]*>([^<]*)</text>', s2)
        assert '100' in txt, ('数字作为文字导出', txt)
    await case('导出：默认没有标注；勾选后标注线在描线层、数字是文字', export())

    async def persist():
        path = os.path.join(TMP, '标注.seedlaser')
        await pg.evaluate(f"window.pywebview.api.dev_set_pick({json.dumps(path)})")
        await pg.evaluate("window.SeedApp.file('saveas')"); await pg.wait_for_timeout(1200)
        await pg.evaluate(f"void window.SeedApp.file('openPath', {json.dumps(path)})"); await pg.wait_for_timeout(2500)
        d = await k.ev(DIMS)
        assert len(d) == 2 and d[0]['L'] == 100 and all(x['ref'] for x in d), d
        assert len(await k.ev(LABELS)) == 2
    await case('保存再打开：两条标注都在、仍引用图形', persist())


asyncio.run(run(body, 'dim1')) and print('PASS dim1：点边 / 点两节点标注、数字随图形变、不算不在板里、默认不导出 / 勾选后导出到描线层、保存再打开还在')
