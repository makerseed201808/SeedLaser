"""Ctrl 拖动画正圆；新图形和已有图形重叠时不提示、不弹窗、不标色，直接用当前图层（切割）。带断言。"""
import asyncio, os
from _kit import seed_rect
from playwright.async_api import async_playwright

OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
ED = 'window.__seedDebug.sketchEd'


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
        await seed_rect(pg)          # 新建设计是空白的：这个测试要用的矩形板自己画
        await pg.wait_for_selector('#sk-host:not(.hidden)', timeout=30000)
        await pg.wait_for_timeout(600)
        c = await pg.evaluate(f"(()=>{{const e={ED};const it=e.content.children[0];const p=e.ps.view.projectToView(it.bounds.bottomRight);const r=e.canvas.getBoundingClientRect();return [p.x+r.left,p.y+r.top]}})()")
        await pg.keyboard.press('e')
        await pg.mouse.move(c[0] - 40, c[1] - 30); await pg.mouse.down()
        await pg.keyboard.down('Control')
        await pg.mouse.move(c[0] + 50, c[1] + 20, steps=6); await pg.mouse.up()
        await pg.keyboard.up('Control')
        await pg.wait_for_timeout(300)
        mode, w, h = await pg.evaluate(f"(()=>{{const it={ED}.content.lastChild;return [it.data.mode, Math.round(it.bounds.width*10)/10, Math.round(it.bounds.height*10)/10]}})()")
        assert mode == 'cut', mode                      # 直接用当前图层，不改成描线
        assert w == h, (w, h)                          # Ctrl = 正圆
        assert not await pg.query_selector('.sk-overlap'), '不应弹出重叠选择框'
        assert await pg.evaluate(f"{ED}.overlapWarn") == 0
        assert '重叠' not in await pg.inner_text('.sk-status') and '交叉' not in await pg.inner_text('.sk-status')
        assert await pg.evaluate(f"{ED}.boardLayer.children.filter(c=>c.fillColor && c.fillColor.red>0.9 && c.fillColor.green<0.6).length") == 0, '不应标橙色'
        await pg.screenshot(path=OUT + 'ov1.png')
        await b.close()
    assert not errs, errs
    print('PASS ov1：Ctrl 画正圆；重叠时不提示、不弹窗、不标色，按当前图层（切割）')

asyncio.run(main())
