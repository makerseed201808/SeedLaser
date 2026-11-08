"""C4 图库：内置 30 个件分组显示（未核对的有标记）→ 点「M3 通孔」放到画板中央、直径 3.4；点「Arduino UNO」= 4 孔 + 描线外形编成一组；
放完在画布上单击再放一个、Esc 结束；选中图形「保存到我的图库」→ 文件在图库文件夹 → 重开画板后还在、能放、尺寸对、能删（两次确认）。带断言。"""
import asyncio, os
from _kit import run, ED

SQ = lambda x, y, w, h: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
LIBDIR = os.path.join(os.environ.get('SEEDLASER_PROJECT_DIR', '/tmp/sl-proj'), '图库')
ITEMS = f"{ED}.content.children.filter(c=>c.data&&c.data.mode).map(c=>({{id:c.data.id, mode:c.data.mode, group:c.data.group, w:Math.round(c.bounds.width*100)/100, h:Math.round(c.bounds.height*100)/100, cx:Math.round(c.bounds.center.x*10)/10, cy:Math.round(c.bounds.center.y*10)/10}}))"


async def body(k, case):
    pg = k.pg
    for f in os.listdir(LIBDIR) if os.path.isdir(LIBDIR) else []:
        if f.endswith('.seedlaser-shape') and f.startswith('测试'):
            os.remove(os.path.join(LIBDIR, f))

    async def builtin():
        await k.tool('lib'); await pg.wait_for_selector('#sk-host [data-lib="b:hole-m3"]')
        n = await pg.eval_on_selector_all('#sk-host .sk-toolopts [data-lib^="b:"]', 'e=>e.length')
        assert n == 30, n
        cats = await pg.eval_on_selector_all('#sk-host .sk-lib-cat', 'e=>e.map(x=>x.textContent)')
        assert cats == ['螺丝孔', '舵机 / 主控', '轴孔 / 元件孔', '结构孔', '装饰'], cats
        warn = await pg.eval_on_selector_all('#sk-host [data-lib="b:servo-sg90"] .sk-lib-warn', 'e=>e.length')
        assert warn == 1, '未核对的件要有标记'
        assert await pg.eval_on_selector_all('#sk-host [data-lib="b:hole-m3"] .sk-lib-warn', 'e=>e.length') == 0
        c = await k.ev(f"(()=>{{const c={ED}.libDropPoint(); return [c.x,c.y];}})()")
        await pg.click('#sk-host [data-lib="b:hole-m3"]'); await pg.wait_for_timeout(200)
        its = await k.ev(ITEMS)
        assert len(its) == 1 and its[0]['w'] == 3.4 and its[0]['h'] == 3.4 and its[0]['mode'] == 'cut', its
        assert abs(its[0]['cx'] - c[0]) < 0.11 and abs(its[0]['cy'] - c[1]) < 0.11, ('放在画板中央', its, c)
        assert '已放入「M3 通孔 ø3.4」' in await k.status(), await k.status()
        assert len(await k.ev(f"[...{ED}.sel]")) == 1, '放完选中它'
    await case('内置 30 个分 5 组、未核对有标记；点 M3 通孔 → 画板中央一个 ø3.4 的孔', builtin())

    async def again():
        await k.click(60, 60); await pg.wait_for_timeout(150)
        its = await k.ev(ITEMS)
        assert len(its) == 2 and its[1]['cx'] == 60 and its[1]['cy'] == 60, its
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(100)
        await k.click(100, 100)
        assert len(await k.ev(ITEMS)) == 2, 'Esc 之后单击不再放'
    await case('放完在画布上单击再放一个；Esc 结束放置', again())

    async def group():
        await pg.click('#sk-host [data-lib="b:board-uno"]'); await pg.wait_for_timeout(200)
        its = (await k.ev(ITEMS))[2:]
        assert len(its) == 5 and len({x['group'] for x in its}) == 1 and its[0]['group'], its
        assert sorted(x['mode'] for x in its) == ['cut'] * 4 + ['score'], its
        sc = [x for x in its if x['mode'] == 'score'][0]
        assert (sc['w'], sc['h']) == (68.58, 53.34), sc
        assert all(x['w'] == 3.2 for x in its if x['mode'] == 'cut'), its
        await pg.keyboard.press('Escape')
        await k.ev(f"{ED}.undo()")
        assert len(await k.ev(ITEMS)) == 2, '一步撤销'
    await case('Arduino UNO：4 个 ø3.2 孔 + 68.58×53.34 描线外形，编成一组；一步撤销', group())

    async def save():
        await k.tool('select')
        a = await k.add('cut', SQ(150, 150, 40, 20))
        b = await k.add('engrave', SQ(160, 155, 10, 10))
        await k.select(a, b)
        await k.ev(f"{ED}.setTool('lib')"); await pg.wait_for_timeout(200)      # 不用 k.tool：它会先按 Esc 取消选中
        await pg.click('#sk-host [data-libtab=mine]'); await pg.wait_for_timeout(300)
        await pg.fill('#sk-host [data-libname]', '测试名牌')
        await pg.click('#sk-host [data-libsave]'); await pg.wait_for_timeout(600)
        assert os.path.isfile(os.path.join(LIBDIR, '测试名牌.seedlaser-shape')), os.listdir(LIBDIR)
        assert '已保存到我的图库：「测试名牌」' in await k.status(), await k.status()
        assert await pg.is_visible('#sk-host [data-lib="m:测试名牌.seedlaser-shape"]')
    await case('选中两个图形 → 保存到我的图库：文件在「图库」文件夹、列表里出现', save())

    async def reopen():
        await k.open()
        await k.tool('lib'); await pg.wait_for_selector('#sk-host [data-libtab]')
        await pg.click('#sk-host [data-libtab=mine]'); await pg.wait_for_timeout(500)
        await pg.click('#sk-host [data-lib="m:测试名牌.seedlaser-shape"]'); await pg.wait_for_timeout(200)
        its = await k.ev(ITEMS)
        assert sorted((x['mode'], x['w'], x['h']) for x in its) == [('cut', 40, 20), ('engrave', 10, 10)], its
        cut = [x for x in its if x['mode'] == 'cut'][0]; eng = [x for x in its if x['mode'] == 'engrave'][0]
        assert (round(eng['cx'] - cut['cx'], 1), round(eng['cy'] - cut['cy'], 1)) == (-5, 0), ('相对位置不变', its)
    await case('重新打开后「我的」里还在，能放，尺寸和相对位置不变', reopen())

    async def delete():
        sel = '#sk-host [data-libdel="测试名牌.seedlaser-shape"]'
        await pg.click(sel); await pg.wait_for_timeout(150)
        assert os.path.isfile(os.path.join(LIBDIR, '测试名牌.seedlaser-shape')), '点一次只是确认，不删'
        assert '删除?' in await pg.inner_text(sel)
        await pg.click(sel); await pg.wait_for_timeout(500)
        assert not os.path.exists(os.path.join(LIBDIR, '测试名牌.seedlaser-shape'))
        assert not await pg.query_selector('#sk-host [data-lib="m:测试名牌.seedlaser-shape"]')
    await case('删除：点 ✕ 变「删除?」，再点一次才删掉文件', delete())


asyncio.run(run(body, 'lib1')) and print('PASS lib1：内置 30 件分组、未核对有标记、放到中央尺寸正确、再点再放 / Esc、UNO 成组；我的图库保存 → 重开还在 → 能放 → 两次确认删除')
