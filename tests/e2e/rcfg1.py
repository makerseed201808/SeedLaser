"""右键快捷菜单自定义：⚙ 自定义 打开设置；换位置、清空、互换；保存后右键菜单立刻变化；恢复默认。带断言。"""
import asyncio, os
from playwright.async_api import async_playwright

OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
ED = 'window.__seedDebug.sketchEd'


async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1'); if(!sessionStorage.getItem('rc')){localStorage.removeItem('seedboxes.radialMenu'); sessionStorage.setItem('rc','1')}")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)'); await pg.wait_for_timeout(600)
        cv = await pg.evaluate(f"(()=>{{const r={ED}.canvas.getBoundingClientRect();return [r.left+r.width*0.35,r.top+r.height*0.4]}})()")
        labels = lambda: pg.evaluate("[...document.querySelectorAll('.sk-radial-item')].map(b=>b.textContent.trim())")

        await pg.mouse.click(*cv, button='right')
        assert (await labels())[:3] == ['╱直线', '▭矩形', '◯椭圆'], await labels()
        await pg.click('.sk-radial-cfg-btn')
        await pg.wait_for_selector('.sk-rcfg')
        assert not await pg.query_selector('.sk-radial'), '打开设置时圆盘应关闭'
        await pg.screenshot(path=OUT + 'rcfg1.png')
        # 第 2 个位置（矩形）换成「多边形」
        await pg.click('.sk-rcfg [data-slot="1"]')
        await pg.click('.sk-rcfg [data-cmd="t:polygon"]')
        # 把「椭圆」放到第 1 个位置：和原来的位置互换
        await pg.click('.sk-rcfg [data-slot="0"]')
        await pg.click('.sk-rcfg [data-cmd="t:ellipse"]')
        # 清空最后一个
        await pg.hover('.sk-rcfg [data-slot="7"]'); await pg.click('.sk-rcfg [data-clear="7"]')
        await pg.click('.sk-rcfg [data-x="close"]')
        await pg.mouse.click(*cv, button='right')
        L = await labels()
        assert L[:3] == ['◯椭圆', '⬡多边形', '╱直线'], L
        assert len(L) == 7, L
        # 刷新后还在
        await pg.keyboard.press('Escape')
        await pg.reload()
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)'); await pg.wait_for_timeout(600)
        await pg.mouse.click(*cv, button='right')
        assert (await labels())[:2] == ['◯椭圆', '⬡多边形'], await labels()
        # 「选中时」那一组，恢复默认
        await pg.click('.sk-radial-cfg-btn')
        await pg.click('.sk-rcfg [data-w="sel"]')
        await pg.click('.sk-rcfg [data-slot="0"]'); await pg.click('.sk-rcfg [data-cmd="a:rotR"]')
        assert await pg.inner_text('.sk-rcfg [data-slot="0"]') != ''
        await pg.click('.sk-rcfg [data-w="idle"]'); await pg.click('.sk-rcfg [data-x="reset"]')
        await pg.keyboard.press('Escape')
        assert not await pg.query_selector('.sk-rcfg')
        await pg.mouse.click(*cv, button='right')
        assert (await labels())[:2] == ['╱直线', '▭矩形'], await labels()
        sel = await pg.evaluate("JSON.parse(localStorage.getItem('seedboxes.radialMenu')).sel[0]")
        assert sel == 'a:rotR', sel
        await b.close()
    assert not errs, errs
    print('PASS rcfg1：⚙ 自定义 → 换命令 / 互换 / 清空，右键菜单立即生效、刷新后保留；选中时一组单独设置；恢复默认')

asyncio.run(main())
