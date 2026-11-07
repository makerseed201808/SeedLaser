"""直线工具：逐点单击，按右键结束（不弹快捷菜单）；曲线工具同样。带断言。"""
import asyncio, os
from playwright.async_api import async_playwright

ED = 'window.__seedDebug.sketchEd'


async def main():
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
        cv = await pg.locator('.sk-canvas').bounding_box()
        x0, y0 = cv['x'] + 500, cv['y'] + 400
        for key in ['l', 'p']:
            n0 = await pg.evaluate(f"{ED}.content.children.length")
            await pg.keyboard.press(key)
            for dx, dy in [(0, 0), (80, 0), (80, 60)]:
                await pg.mouse.click(x0 + dx, y0 + dy); await pg.wait_for_timeout(80)
            await pg.mouse.click(x0 + 150, y0 + 150, button='right'); await pg.wait_for_timeout(200)
            assert await pg.evaluate(f"!{ED}.drawing"), key
            assert not await pg.query_selector('.sk-radial'), '右键结束时不应弹快捷菜单'
            assert await pg.evaluate(f"{ED}.content.children.length") == n0 + 1
            segs = await pg.evaluate(f"{ED}.content.lastChild.segments.length")
            assert segs == 3, (key, segs)                     # 右键那一下不加点
            y0 += 120
        # 不在画线时右键仍是快捷菜单
        await pg.mouse.click(x0 - 250, y0 - 200, button='right')   # 避开右下角 3D 预览框
        assert await pg.query_selector('.sk-radial')
        await b.close()
    assert not errs, errs
    print('PASS line1：直线 / 曲线按右键结束（3 个点，不弹菜单）；平时右键仍是快捷菜单')

asyncio.run(main())
