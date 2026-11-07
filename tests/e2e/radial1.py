"""右键圆形快捷菜单：空白处右键 = 画图工具；右键点图形 = 选中并显示编辑命令；中间重复上一个命令；右键拖动仍平移。带断言。"""
import asyncio, os
from playwright.async_api import async_playwright

OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
ED = 'window.__seedDebug.sketchEd'
LABELS = "[...document.querySelectorAll('.sk-radial-item')].map(b=>b.textContent.trim())"


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
        cv = await pg.locator('.sk-canvas').bounding_box()
        ex, ey = cv['x'] + cv['width'] * 0.6, cv['y'] + cv['height'] * 0.7      # 空白处
        await pg.mouse.click(ex, ey, button='right')
        labels = await pg.evaluate(LABELS)
        assert any('矩形' in l for l in labels) and len(labels) == 8, labels
        await pg.screenshot(path=OUT + 'radial_empty.png')
        await pg.click('.sk-radial-item:has-text("椭圆")')
        assert await pg.evaluate(f"{ED}.tool") == 'ellipse'
        assert not await pg.query_selector('.sk-radial')
        await pg.keyboard.press('v')
        # 右键点在图形边上：选中并显示编辑命令
        it = await pg.evaluate(f"(()=>{{const e={ED};const p=e.ps.view.projectToView(e.content.children[0].bounds.leftCenter);const r=e.canvas.getBoundingClientRect();return [p.x+r.left,p.y+r.top]}})()")
        await pg.mouse.click(it[0], it[1], button='right')
        assert await pg.evaluate(f"{ED}.sel.size") == 1
        labels = await pg.evaluate(LABELS)
        assert any('复制一份' in l for l in labels), labels
        await pg.screenshot(path=OUT + 'radial_sel.png')
        n0 = await pg.evaluate(f"{ED}.content.children.length")
        await pg.click('.sk-radial-item:has-text("复制一份")')
        assert await pg.evaluate(f"{ED}.content.children.length") == n0 + 1
        # 中间「重复」= 再复制一份
        await pg.mouse.click(ex, ey, button='right')
        assert '复制一份' in await pg.inner_text('.sk-radial-center')
        await pg.click('.sk-radial-center')
        assert await pg.evaluate(f"{ED}.content.children.length") == n0 + 2
        # Esc 关闭
        await pg.mouse.click(ex, ey, button='right'); await pg.keyboard.press('Escape')
        assert not await pg.query_selector('.sk-radial')
        # 右键拖动 = 平移，不弹菜单
        v0 = await pg.evaluate(f"{ED}.ps.view.center.x")
        await pg.mouse.move(ex, ey); await pg.mouse.down(button='right'); await pg.mouse.move(ex + 80, ey, steps=5); await pg.mouse.up(button='right')
        assert not await pg.query_selector('.sk-radial')
        assert abs(await pg.evaluate(f"{ED}.ps.view.center.x") - v0) > 1
        await b.close()
    assert not errs, errs
    print('PASS radial1：空白右键 = 画图工具，右键图形 = 选中 + 编辑命令，中间重复上一个，Esc 关闭，右键拖动仍平移')

asyncio.run(main())
