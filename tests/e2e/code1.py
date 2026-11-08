"""C6 二维码 / 条形码：文字工具右侧切到「二维码」→ 单击放置 → 雕刻层、边长 30、中心在单击处、记住内容；
条形码宽 50；选中二维码改边长 20 →「重新生成」→ 尺寸变、位置和编号不变；中文条形码报错不加图形；
保存再打开内容还在；批量名牌勾「加二维码」→ 每块名牌右边一个二维码，内容 = 模板里的 {名字} 换成名字。带断言。
（解码正确性见 tests/py/test_codes.py）"""
import asyncio, json, os, tempfile
from _kit import run, ED

D = 'window.__seedDebug'
TMP = tempfile.mkdtemp(prefix='seedlaser-code1-')
CODES = f"{ED}.content.children.filter(c=>c.data&&c.data.code).map(c=>({{id:c.data.id, mode:c.data.mode, code:c.data.code, w:Math.round(c.bounds.width*1000)/1000, h:Math.round(c.bounds.height*1000)/1000, cx:Math.round(c.bounds.center.x*1000)/1000, cy:Math.round(c.bounds.center.y*1000)/1000, n:{ED}.itemPaths(c).length}}))"


async def body(k, case):
    pg = k.pg

    async def qr():
        await k.tool('text')
        await pg.click('#sk-host [data-tk=qr]'); await pg.wait_for_timeout(150)
        await pg.fill('#sk-host [data-cd=text]', 'https://github.com/makerseed201808/SeedLaser'); await pg.press('#sk-host [data-cd=text]', 'Tab')
        await pg.fill('#sk-host [data-cd=size]', '30'); await pg.press('#sk-host [data-cd=size]', 'Tab')
        await k.click(80, 80); await pg.wait_for_timeout(800)
        c = await k.ev(CODES)
        assert len(c) == 1 and c[0]['mode'] == 'engrave' and c[0]['code']['kind'] == 'qr', c
        assert c[0]['w'] == 30 and c[0]['h'] == 30 and c[0]['cx'] == 80 and c[0]['cy'] == 80, c
        assert c[0]['code']['text'] == 'https://github.com/makerseed201808/SeedLaser' and c[0]['n'] > 10, c
        assert '已添加二维码（30 × 30 mm）' in await k.status(), await k.status()
    await case('二维码：单击放置，雕刻层、30 × 30、中心在单击处、记住内容', qr())

    async def bar():
        await k.tool('text')
        await pg.click('#sk-host [data-tk=bar]'); await pg.wait_for_timeout(150)
        await pg.fill('#sk-host [data-cd=text]', 'SeedLaser-01'); await pg.press('#sk-host [data-cd=text]', 'Tab')
        await pg.fill('#sk-host [data-cd=size]', '50'); await pg.press('#sk-host [data-cd=size]', 'Tab')
        await pg.fill('#sk-host [data-cd=h]', '12'); await pg.press('#sk-host [data-cd=h]', 'Tab')
        await k.click(200, 80); await pg.wait_for_timeout(800)
        c = [x for x in await k.ev(CODES) if x['code']['kind'] == 'bar']
        assert len(c) == 1 and abs(c[0]['w'] - 50) < 0.5 and c[0]['h'] == 12 and c[0]['code']['text'] == 'SeedLaser-01', c
    await case('条形码：宽约 50、条高 12、记住内容', bar())

    async def edit():
        q = [x for x in await k.ev(CODES) if x['code']['kind'] == 'qr'][0]
        await k.tool('select'); await k.select(q['id']); await pg.wait_for_timeout(200)
        assert '修改二维码' in await pg.inner_text('#sk-host .sk-toolopts'), '选中二维码时右侧显示修改'
        await pg.fill('#sk-host [data-cd=size]', '20')
        await pg.click('#sk-host [data-cd-apply]'); await pg.wait_for_timeout(800)
        q2 = [x for x in await k.ev(CODES) if x['code']['kind'] == 'qr'][0]
        assert q2['id'] == q['id'] and q2['w'] == 20 and q2['cx'] == 80 and q2['cy'] == 80 and q2['code']['size'] == 20, q2
        await k.ev(f"{ED}.undo()"); await pg.wait_for_timeout(150)
        assert [x for x in await k.ev(CODES) if x['code']['kind'] == 'qr'][0]['w'] == 30, '一步撤销'
    await case('选中二维码 → 改边长 20 → 重新生成：尺寸变、位置和编号不变；可撤销', edit())

    async def bad():
        n0 = len(await k.ev(CODES))
        await k.tool('text')
        await pg.click('#sk-host [data-tk=bar]'); await pg.wait_for_timeout(150)
        await pg.fill('#sk-host [data-cd=text]', '张三'); await pg.press('#sk-host [data-cd=text]', 'Tab')
        await k.click(200, 150); await pg.wait_for_timeout(800)
        assert len(await k.ev(CODES)) == n0, '内容不合法时不加图形'
        toast = await pg.evaluate("[...document.querySelectorAll('.toast, .sk-toast')].map(t=>t.textContent).join('|')")
        assert '不能有' in toast, toast
        await pg.click('#sk-host [data-tk=text]')                         # 切回文字
    await case('条形码内容是中文：提示，不加图形', bad())

    async def persist():
        path = os.path.join(TMP, '码.seedlaser')
        await pg.evaluate(f"window.pywebview.api.dev_set_pick({json.dumps(path)})")
        await pg.evaluate("window.SeedApp.file('saveas')"); await pg.wait_for_timeout(1200)
        await pg.evaluate(f"void window.SeedApp.file('openPath', {json.dumps(path)})"); await pg.wait_for_timeout(2500)
        c = await k.ev(CODES)
        assert sorted(x['code']['kind'] for x in c) == ['bar', 'qr'], c
    await case('保存再打开：二维码 / 条形码的内容还在（可重新生成）', persist())

    async def names():
        await pg.click('.sk-back'); await pg.wait_for_timeout(3000)
        await k.ev(f"void {D}.nameplateDialog()"); await pg.wait_for_selector('#names-modal [data-n=names]')
        await pg.fill('#names-modal [data-n=names]', '张三\nLi Si')
        await pg.fill('#names-modal [data-n=w]', '90'); await pg.fill('#names-modal [data-n=h]', '30')
        if not await pg.is_checked('#names-modal [data-n=qr]'):
            await pg.click('#names-modal [data-n=qr]')
        await pg.fill('#names-modal [data-n=qrText]', 'https://example.com/?n={名字}')
        await pg.click('#names-modal [data-m=ok]'); await pg.wait_for_timeout(4000)
        sk = await k.ev(f"Object.values({D}.W.project.sketches).map(s=>s.items.find(i=>i.id==='qr')).filter(Boolean).map(i=>({{t:i.code.text, s:i.code.size, xs:i.paths.flatMap(p=>p.segs.map(q=>q[0]))}}))")
        assert sorted(x['t'] for x in sk) == ['https://example.com/?n=Li Si', 'https://example.com/?n=张三'], sk
        for x in sk:
            assert x['s'] == 24 and abs(max(x['xs']) - 87) < 0.01 and abs(min(x['xs']) - 63) < 0.01, ('二维码在右边、边长 = 板高 − 6', x['s'], max(x['xs']), min(x['xs']))
    await case('批量名牌「加二维码」：每块右边一个 24 mm 二维码，内容按 {名字} 替换', names())


asyncio.run(run(body, 'code1')) and print('PASS code1：二维码 / 条形码放置（雕刻、尺寸、位置、内容）、重新生成、中文条形码报错、保存再打开、批量名牌加二维码')
