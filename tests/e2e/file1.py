"""二维画板「文件 ▾」菜单：新建 / 保存（首次另存为，之后直接写）/ 另存为 / 导出 SVG / 有改动时新建先确认 / 打开 / 最近打开；
标题区紧凑（只显示文件名 ●），材料信息在底部，「3D 装配 →」在右端。带断言。
没有真窗口：用 dev_set_pick 预先给出对话框要返回的路径。"""
import asyncio, json, os, tempfile
from playwright.async_api import async_playwright

ED = 'window.__seedDebug.sketchEd'
TMP = tempfile.mkdtemp(prefix='seedlaser-file1-')
PROJ = os.path.join(TMP, '测试设计.seedbox.json')
SVG = os.path.join(TMP, '测试设计.svg')


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e) + ' @ ' + (e.stack or '')[:600]))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        pick = lambda path: pg.evaluate(f"window.pywebview.api.dev_set_pick({json.dumps(path)})")
        label = lambda: pg.evaluate("(()=>{const n=document.querySelector('#sk-host .sk-file').textContent; const d=document.querySelector('#sk-host .sk-savestate').classList.contains('dirty'); return n+(d?' ●':'')})()")
        count = lambda: pg.evaluate(f"{ED}.content.children.length")
        add_rect = lambda x: pg.evaluate(f"""(()=>{{const e={ED}; const it=e.addItem({{mode:'cut',paths:[]}}); it.remove();
            const r=new e.ps.Path.Rectangle({{point:[{x},10],size:[20,20],insert:false}}); r.data=it.data; e.content.addChild(r); e.style(r); e.commit('t');}})()""")
        mod = 'Meta'

        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)'); await pg.wait_for_timeout(1800)
        assert await pg.is_visible('#sk-host .sk-filebtn')
        assert (await pg.inner_text('#sk-host .sk-back')).startswith('3D 装配'), await pg.inner_text('#sk-host .sk-back')
        assert '材料' in await pg.inner_text('#sk-host .sk-ctx-data')
        assert not await pg.is_visible('#sk-host .sk-name')
        assert await label() == '未命名设计', await label()
        n0 = await count()
        await add_rect(30); await pg.wait_for_timeout(1700)
        assert await label() == '未命名设计 ●', await label()

        # 保存（第一次 = 另存为对话框）
        await pick(PROJ)
        await pg.keyboard.press(f'{mod}+s'); await pg.wait_for_timeout(800)
        assert os.path.exists(PROJ)
        await pg.wait_for_timeout(1600)
        assert await label() == '测试设计', await label()
        # 再改再保存：不弹对话框（没有 pick 也能存），内容更新
        await add_rect(60); await pg.wait_for_timeout(300)
        await pg.click('#sk-host .sk-filebtn'); await pg.click('.sk-filemenu [data-fc=save]'); await pg.wait_for_timeout(800)
        data = json.load(open(PROJ, encoding='utf-8'))
        assert data['generator'] == 'FreeDesign' and json.dumps(data['sketches']).count('"cut"') >= n0 + 2 - 1, '保存的内容应包含新图形'
        await pg.wait_for_timeout(1600); assert await label() == '测试设计'

        # 导出 SVG
        await pick(SVG)
        await pg.click('#sk-host .sk-filebtn')
        assert await pg.is_visible('.sk-filemenu [data-fc=export][data-fa=svg]')
        await pg.wait_for_timeout(400)
        assert '测试设计' in await pg.inner_text('.sk-filemenu .sk-fm-recent'), '最近打开里应有刚保存的文件'
        await pg.click('.sk-filemenu [data-fc=export][data-fa=svg]'); await pg.wait_for_timeout(2500)
        assert os.path.exists(SVG) and '<path' in open(SVG, encoding='utf-8').read(), '应导出 SVG'

        # 改动后「新建」：先问；选「不保存」→ 空白新设计
        await add_rect(90); await pg.wait_for_timeout(300)
        await pg.keyboard.press(f'{mod}+n')
        await pg.wait_for_selector('.sk-confirm')
        await pg.click('.sk-confirm [data-r=cancel]')
        assert await label() in ('测试设计 ●', '测试设计'), await label()
        await pg.keyboard.press(f'{mod}+n'); await pg.click('.sk-confirm [data-r=discard]')
        await pg.wait_for_timeout(2500)
        assert await label() == '未命名设计', await label()
        assert await count() == n0, await count()

        # 打开刚才的文件：回到 2 个新图形的版本
        await pick(PROJ)
        await pg.keyboard.press(f'{mod}+o'); await pg.wait_for_timeout(3000)
        await pg.wait_for_selector('#sk-host:not(.hidden)')
        assert await label() == '测试设计', await label()
        assert await count() == n0 + 2, (await count(), n0)
        await pg.screenshot(path='/tmp/seedboxes-e2e/file1.png')
        await b.close()
    assert not errs, errs
    print('PASS file1：文件菜单 新建 / 保存 / 再保存不弹框 / 导出 SVG / 改动确认 / 打开 / 最近打开；标题紧凑')

asyncio.run(main())
