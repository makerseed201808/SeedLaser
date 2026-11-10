"""对象原点（参考点）：9 个位置可选；X / Y 是该点坐标；改 X / Y 移动到该点；改宽高、输入角度时该点不动；设置记住。带断言。"""
import asyncio, os
from _kit import seed_rect
from playwright.async_api import async_playwright

ED = 'window.__seedDebug.sketchEd'
OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1'); if(!sessionStorage.getItem('r')){localStorage.removeItem('seedboxes.refPoint'); sessionStorage.setItem('r','1')}")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)'); await pg.wait_for_timeout(1500)
        await seed_rect(pg)          # 新建设计是空白的：这个测试要用的矩形板自己画
        H = '#sk-host '
        B = lambda: pg.evaluate(f"(()=>{{const b=[...{ED}.sel][0].bounds;return [b.left,b.top,b.right,b.bottom].map(v=>Math.round(v*1000)/1000)}})()")
        await pg.evaluate(f"(()=>{{const e={ED}; e.sel=new Set([e.content.children[0]]); e.refresh();}})()")
        l, bt, r, tp = await B()                                   # bt = 屏幕下边（paper top），tp = 屏幕上边
        SH = await pg.evaluate(f"{ED}.part.sheet.h")
        # 默认左上角；显示坐标和激光机一样：材料左上角 = (0, 0)，Y 往下
        assert float(await pg.input_value(H + '[data-num=x]')) == l and float(await pg.input_value(H + '[data-num=y]')) == SH - tp
        # 输入 (0, 0) → 图形贴在材料左上角
        await pg.fill(H + '[data-num=x]', '0'); await pg.keyboard.press('Enter')
        await pg.fill(H + '[data-num=y]', '0'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(200)
        l, bt, r, tp = await B()
        assert l == 0 and tp == SH, (l, tp, SH)
        # 标尺 / 右下角坐标也按左上角为原点
        await pg.mouse.move(*(await pg.evaluate(f"(()=>{{const e={ED};const r=e.canvas.getBoundingClientRect();const v=e.ps.view.projectToView(new e.ps.Point(10, {SH}-20));return [v.x+r.left,v.y+r.top]}})()")))
        import re as _re
        cy = float(_re.search(r'Y (-?[\d.]+)', await pg.inner_text(H + '.sk-coords')).group(1))
        assert abs(cy - 20) < 1, cy
        await pg.evaluate(f"(()=>{{const e={ED}; e.sel=new Set([e.content.children[0]]); e.refresh();}})()")
        # 选中心
        await pg.click(H + '[data-refbtn]'); await pg.wait_for_selector('.sk-refmenu')
        await pg.screenshot(path=OUT + 'ref1.png', clip={'x': 0, 'y': 40, 'width': 600, 'height': 260})
        await pg.click('.sk-refmenu [data-ref=mc]')
        assert not await pg.query_selector('.sk-refmenu')
        assert float(await pg.input_value(H + '[data-num=x]')) == (l + r) / 2
        await pg.fill(H + '[data-num=x]', '150'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(200)
        l2, bt2, r2, tp2 = await B()
        assert abs((l2 + r2) / 2 - 150) < 1e-6 and bt2 == bt, (l2, r2)
        # 左上角：改宽度 → 左边、上边不动
        await pg.click(H + '[data-refbtn]'); await pg.click('.sk-refmenu [data-ref=tl]')
        await pg.click(H + '.sk-ratio') if await pg.evaluate(f"{ED}.lockRatio") else None
        await pg.fill(H + '[data-num=w]', '50'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(200)
        l3, bt3, r3, tp3 = await B()
        assert l3 == l2 and tp3 == tp2 and abs(r3 - l3 - 50) < 1e-6, (l3, r3, tp3, tp2)
        # 右下角：旋转 90° → 右下角这个点不动
        await pg.click(H + '[data-refbtn]'); await pg.click('.sk-refmenu [data-ref=br]')
        await pg.fill(H + '[data-num=rot]', '90'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(200)
        # 旋转后原来的右下角 (r3, bt3) 仍然是图形上的一个顶点（外框会变，但这个点不动）
        pts = await pg.evaluate(f"(()=>{{const it=[...{ED}.sel][0]; return (it.segments||it.children[0].segments).map(s=>[Math.round(s.point.x*1000)/1000, Math.round(s.point.y*1000)/1000])}})()")
        assert [r3, bt3] in pts, (pts, r3, bt3)
        l4, bt4, r4, tp4 = await B()
        assert abs((r4 - l4) - 60) < 1e-6 and abs((tp4 - bt4) - 50) < 1e-6, (l4, bt4, r4, tp4)
        # 记住设置
        await pg.reload(); await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        assert await pg.evaluate("localStorage.getItem('seedboxes.refPoint')") == 'br'
        await b.close()
    assert not errs, errs
    print('PASS ref1：默认左上角、材料左上角为 (0,0)（Y 往下）；对象原点 9 选 1；X / Y 为该点坐标并按它移动；改宽高、旋转时该点不动；设置记住')

asyncio.run(main())
