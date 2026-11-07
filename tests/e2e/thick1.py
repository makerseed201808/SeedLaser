"""二维画板的板厚：改板厚同步到左侧参数；已有卡榫按旧板厚做的会提醒，一键重做（一步撤销）。带断言。"""
import asyncio, os
from playwright.async_api import async_playwright

OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
ED = 'window.__seedDebug.sketchEd'
DEPTHS = f"{ED}.content.children.flatMap(c=>(c.data.joints||[]).map(j=>j.depth))"


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
        await pg.wait_for_timeout(600)
        cv = await pg.locator('.sk-canvas').bounding_box()
        x0, y0 = cv['x'] + 120, cv['y'] + 330
        for dx in (0, 300):
            await pg.keyboard.press('r')
            await pg.mouse.move(x0 + dx, y0); await pg.mouse.down(); await pg.mouse.move(x0 + dx + 200, y0 + 150, steps=5); await pg.mouse.up()
        await pg.keyboard.press('j')
        await pg.mouse.move(x0 + 200, y0 + 75); await pg.mouse.click(x0 + 200, y0 + 75)
        await pg.mouse.move(x0 + 300, y0 + 75); await pg.mouse.click(x0 + 300, y0 + 75)
        assert await pg.evaluate(DEPTHS) == [3, 3], await pg.evaluate(DEPTHS)
        await pg.keyboard.press('v'); await pg.keyboard.press('Escape')
        await pg.fill('[data-thick]', '4'); await pg.press('[data-thick]', 'Enter'); await pg.wait_for_timeout(400)
        assert await pg.evaluate("document.querySelector('#param-form [name=thickness]').value") == '4', '应同步到左侧参数'
        assert await pg.evaluate(f"{ED}.part.thickness") == 4
        warn = await pg.inner_text('.sk-boardinfo .sk-warn')
        assert '2' in warn and '3' in warn, warn
        await pg.screenshot(path=OUT + 'thick_warn.png')
        await pg.click('.sk-boardinfo [data-redo-joints]'); await pg.wait_for_timeout(300)
        assert await pg.evaluate(DEPTHS) == [4, 4], await pg.evaluate(DEPTHS)
        assert not await pg.query_selector('.sk-boardinfo .sk-warn')
        await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(300)
        assert await pg.evaluate(DEPTHS) == [3, 3], '一步撤销应回到重做前'
        # 卡榫工具里同样提醒
        await pg.keyboard.press('j')
        assert await pg.query_selector('.sk-toolopts .sk-warn')
        await b.close()
    assert not errs, errs
    print('PASS thick1：板厚同步到左侧参数；旧板厚卡榫提醒并一键重做（一步撤销）；卡榫工具里也提醒')

asyncio.run(main())
