"""旋转手柄：单击 = 弹框输入角度；左右拖 = 微调（向右顺时针，2 像素 1°）。带断言。"""
import asyncio, math, os
from playwright.async_api import async_playwright

OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
ED = 'window.__seedDebug.sketchEd'
# 板件轮廓第一条边的方向角（数学方向，度）
ANG = f"(()=>{{const it={ED}.content.children[0];const s=it.segments;return Math.atan2(s[1].point.y-s[0].point.y,s[1].point.x-s[0].point.x)*180/Math.PI}})()"
HANDLE = f"(()=>{{const e={ED};const h=e.handles.find(q=>q.kind==='rotate');const p=e.ps.view.projectToView(h.at);const r=e.canvas.getBoundingClientRect();return [p.x+r.left,p.y+r.top]}})()"


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
        await pg.evaluate(f"(()=>{{const e={ED};e.sel=new Set([e.content.children[0]]);e.refresh()}})()")
        a0 = await pg.evaluate(ANG)
        hx, hy = await pg.evaluate(HANDLE)
        await pg.mouse.click(hx, hy)                      # 单击：弹框
        await pg.wait_for_selector('.sk-rotbox')
        await pg.screenshot(path=OUT + 'rot_box.png')
        await pg.fill('.sk-rotbox input', '30'); await pg.press('.sk-rotbox input', 'Enter')
        await pg.wait_for_timeout(200)
        a1 = await pg.evaluate(ANG)
        assert abs((a1 - a0) - 30) < 0.01, (a0, a1)       # 正数 = 逆时针
        assert not await pg.query_selector('.sk-rotbox')
        # 旋转后外框变大，手柄可能跑到画布外：把视图缩小、以图形为中心
        await pg.evaluate(f"(()=>{{const e={ED};const c=e.content.children[0].bounds.center;e.setView(e.zoom*0.6,c.x,c.y)}})()")
        hx, hy = await pg.evaluate(HANDLE)
        await pg.mouse.move(hx, hy); await pg.mouse.down()
        await pg.mouse.move(hx + 40, hy, steps=8)
        await pg.mouse.up()   # 向右 40 像素 = 顺时针 20°
        await pg.wait_for_timeout(200)
        a2 = await pg.evaluate(ANG)
        assert abs((a2 - a1) + 20) < 0.01, (a1, a2)
        # 拖完上方留下角度输入框：显示 -20（正 = 逆时针），改成 -45 回车 → 相对拖动前顺时针 45°
        assert await pg.input_value('.sk-rotlabel input') == '-20'
        await pg.screenshot(path=OUT + 'rot_label.png')
        await pg.fill('.sk-rotlabel input', '-45'); await pg.press('.sk-rotlabel input', 'Enter')
        await pg.wait_for_timeout(200)
        a3 = await pg.evaluate(ANG)
        assert abs((a3 - a1) + 45) < 0.01, (a1, a3)
        await pg.keyboard.press('Escape')
        await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(200)
        assert abs(await pg.evaluate(ANG) - a2) < 0.01          # 撤销输入框的修改 → 回到拖动结果
        await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(200)
        assert abs(await pg.evaluate(ANG) - a1) < 0.01          # 撤销一步回到拖动前
        await pg.keyboard.press('Control+z'); await pg.wait_for_timeout(200)
        assert abs(await pg.evaluate(ANG) - a0) < 0.01          # 再撤销回到最初（单击弹框不算一步）
        await b.close()
    assert not errs, errs
    print('PASS rot1：单击弹框输入 30° 逆时针；右拖 40px 顺时针 20°；拖完在角度框改成 -45°；撤销正确')

asyncio.run(main())
