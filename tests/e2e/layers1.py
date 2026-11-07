"""图层卡片默认收起；点左下角加工方式色块展开（并切换加工方式），再点同一个收起，✕ 收起。带断言。"""
import asyncio, os
from playwright.async_api import async_playwright

OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
VIS = "!document.querySelector('.sk-layers-card').classList.contains('hidden')"


async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry')
        await pg.wait_for_selector('#sk-host:not(.hidden)', timeout=30000)
        await pg.wait_for_timeout(500)
        assert not await pg.evaluate(VIS), '默认应收起'
        await pg.click('.sk-palette [data-mode=engrave]')
        assert await pg.evaluate(VIS), '点色块应展开'
        assert await pg.evaluate("window.__seedDebug.sketchEd.opts.mode") == 'engrave'
        await pg.screenshot(path=OUT + 'layers_open.png')
        await pg.click('.sk-palette [data-mode=score]')
        assert await pg.evaluate(VIS), '换另一个色块仍展开'
        await pg.click('.sk-palette [data-mode=score]')
        assert not await pg.evaluate(VIS), '再点同一个应收起'
        await pg.click('.sk-palette [data-mode=cut]')
        await pg.click('[data-act=hideLayers]')
        assert not await pg.evaluate(VIS), '✕ 应收起'
        await b.close()
    assert not errs, errs
    print('PASS layers1：默认收起、点色块展开并切换、再点收起、✕ 收起')

asyncio.run(main())
