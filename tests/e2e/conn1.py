"""B1 连接清单：用卡榫工具建 3 对（2 对正常 + 1 对不一样长）+ 1 条没配对（Esc 取消配对）→ 清单 3 + 1；
点一行：画板和 3D 预览都高亮这两条边；去 3D 装配再回来，清单不变；配对做一半就 Esc 不留半个配对。带断言。"""
import asyncio, json, os, tempfile
from _kit import run, ED

D = 'window.__seedDebug'
SQ = lambda x, y, w, h: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


async def body(k, case):
    pg = k.pg
    conns = lambda: k.ev(f"(()=>{{const c={ED}.connections(); return {{pairs:c.pairs.map(p=>({{ok:p.ok,n:p.ends.length,why:p.reasons,who:p.ends.map(e=>e.name+'·'+e.side)}})), singles:c.singles.length, mortises:c.mortises.length}};}})()")
    for sq in [SQ(20, 20, 100, 60), SQ(150, 20, 100, 60), SQ(20, 120, 100, 60), SQ(150, 120, 100, 60), SQ(20, 220, 60, 40)]:
        await k.add('cut', sq)
    await k.tool('joint')

    async def build():
        await k.click(120, 50); await k.click(150, 50)          # 板 A 右边 ↔ 板 B 左边
        await k.click(120, 150); await k.click(150, 150)        # 板 C 右边 ↔ 板 D 左边
        await k.click(70, 20); await k.click(50, 260)           # 板 A 下边（100 mm）↔ 板 E 上边（60 mm）：不一样长
        await k.click(250, 150); await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)   # 板 D 右边：Esc 取消配对
        c = await conns()
        assert len(c['pairs']) == 3 and c['singles'] == 1, c
        assert sum(1 for p in c['pairs'] if p['ok']) == 2, c
        bad = [p for p in c['pairs'] if not p['ok']][0]
        assert any('不一样长' in w for w in bad['why']), bad
        assert all(p['n'] == 2 for p in c['pairs']), ('Esc 取消后不应留下半个配对', c)
    await case('建 3 对 + 1 条没配对 → 清单 3 对（1 对 ⚠ 不一样长）+ 1 条没配对', build())

    async def card():
        await k.tool('select'); await pg.keyboard.press('Escape'); await pg.wait_for_timeout(200)
        assert await pg.is_visible('#sk-host .sk-conns'), '没选中东西时应显示连接清单'
        rows = await pg.query_selector_all('#sk-host .sk-conn')
        assert len(rows) == 4, len(rows)
        assert len(await pg.query_selector_all('#sk-host .sk-conn.warn')) == 1
        txt = await pg.inner_text('#sk-host .sk-conns')
        assert '右边' in txt and '左边' in txt and '不一样长' in txt, txt
        await k.add('cut', SQ(300, 220, 20, 20)); await k.select((await k.items())[-1]['id'])
        assert not await pg.is_visible('#sk-host .sk-conns'), '选中图形时连接清单让位给属性面板'
        await k.select(); await pg.wait_for_timeout(150)
    await case('右侧连接卡片：4 行（1 行 ⚠）、写出板件和边；选中图形时隐藏', card())

    async def highlight():
        await pg.wait_for_timeout(1500)                                      # 等预览和板件名更新完（清单会重画）
        await pg.click('#sk-host .sk-conn.ok'); await pg.wait_for_timeout(1200)
        n2d = await k.ev(f"{ED}.hlLayer.children[0] ? {ED}.hlLayer.children[0].children.length : 0")
        assert n2d == 2, n2d
        n3d = await k.ev(f"({D}.view && {D}.view.hl) ? {D}.view.hl.length : -1")
        assert n3d == 2, ('3D 预览里也要高亮两条边', n3d)
        assert await pg.is_visible('#sk-host .sk-conn.on')
        await k.click(330, 290); await pg.wait_for_timeout(200)              # 点画布别处 → 取消高亮
        assert await k.ev(f"{ED}.hlLayer.children.length") == 0
        assert await k.ev(f"{D}.view.hl.length") == 0
    await case('点一行：画板上两条边高亮、3D 预览里也高亮；点画布别处取消', highlight())

    async def roundtrip():
        before = await conns()
        await pg.click('.sk-back'); await pg.wait_for_timeout(3000)
        await pg.click('#stage-bar [data-stage=design]'); await pg.wait_for_timeout(2000)
        after = await conns()
        key = lambda c: (sorted((p['ok'], tuple(sorted(p['who']))) for p in c['pairs']), c['singles'])
        assert key(before) == key(after), (before, after)
    await case('去 3D 装配再回画板：连接清单不变', roundtrip())


    async def files():
        tmp = tempfile.mkdtemp(prefix='seedlaser-conn1-')
        path = os.path.join(tmp, '连接.seedlaser')
        before = await conns()
        await pg.evaluate(f"window.pywebview.api.dev_set_pick({json.dumps(path)})")
        await pg.evaluate("window.SeedApp.file('saveas')"); await pg.wait_for_timeout(1200)
        assert os.path.exists(path)
        await pg.evaluate(f"void window.SeedApp.file('openPath', {json.dumps(path)})"); await pg.wait_for_timeout(2500)
        c = await conns()
        assert len(c['pairs']) == len(before['pairs']) and c['singles'] == before['singles'], ('保存再打开清单要一样', before, c)
        # 旧版本做的卡榫没有配对号（pair）：打开后都算「没配对的卡榫边」，不报错
        data = json.load(open(path, encoding='utf-8'))
        n = 0
        for sk in data['sketches'].values():
            for it in sk['items']:
                for j in it.get('joints') or []:
                    if j.pop('pair', None):
                        n += 1
        old = os.path.join(tmp, '旧作品.seedlaser')
        json.dump(data, open(old, 'w', encoding='utf-8'), ensure_ascii=False)
        await pg.evaluate(f"void window.SeedApp.file('openPath', {json.dumps(old)})"); await pg.wait_for_timeout(2500)
        c2 = await conns()
        assert not c2['pairs'] and c2['singles'] == n + before['singles'], (n, c2)
    await case('保存再打开清单不变；旧版本（没有配对号）的卡榫打开后都列为没配对，不报错', files())


asyncio.run(run(body, 'conn1')) and print('PASS conn1：连接清单 3 对 + 1 条没配对、⚠ 写原因、点一行画板和 3D 都高亮、往返不变、Esc 不留半个配对')
