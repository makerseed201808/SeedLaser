"""智能辅助线：拖动图形靠近别的图形时，对齐 / 贴边 / 相切自动吸附并显示绿色辅助线；描线是实线。带断言。"""
import asyncio, os
from playwright.async_api import async_playwright

OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
ED = 'window.__seedDebug.sketchEd'
GREEN = f"{ED}.overlay.getItems({{match:(i)=>i.strokeColor && i.strokeColor.toCSS(true)==='#16a34a' || i.fillColor && i.fillColor.toCSS(true)==='#16a34a'}}).length"


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
        # 场景：一块 100×60 的板（x 0..100, y 0..60）和一个 r=10 的圆、一个 r=8 的圆，都放在板外面
        await pg.evaluate(f"""(()=>{{const e={ED}; const ps=e.ps;
          e.content.removeChildren();
          const add=(path,mode)=>{{const it=e.addItem({{mode,paths:[]}}); it.remove(); path.data=it.data; e.content.addChild(path); e.style(path); return path;}};
          window.__R=add(new ps.Path.Rectangle({{point:[0,0],size:[100,60],insert:false}}),'cut');
          window.__C=add(new ps.Path.Circle({{center:[150,30],radius:10,insert:false}}),'cut');
          window.__D=add(new ps.Path.Circle({{center:[150,120],radius:8,insert:false}}),'score');
          e.sel.clear(); e.refresh(); e.zoomFit && e.zoomFit(); e.refresh();}})()""")
        assert await pg.evaluate("window.__D.dashArray===null || window.__D.dashArray.length===0"), '描线应为实线'

        async def drag(item, to):     # 抓住圆的右端（线上才能点中），把圆心拖到 to（项目坐标）
            a = await pg.evaluate(f"(()=>{{const e={ED};const r=e.canvas.getBoundingClientRect();const f=(q)=>{{const v=e.ps.view.projectToView(new e.ps.Point(q[0],q[1]));return [v.x+r.left,v.y+r.top]}};const R={item}.bounds.width/2;const t={to};return [f([{item}.bounds.center.x+R,{item}.bounds.center.y]), f([t[0]+R,t[1]])]}})()")
            await pg.mouse.move(*a[0]); await pg.mouse.down()
            await pg.mouse.move(*a[1], steps=12)
            return a

        # 1) 圆拖到「左边贴着板右边 + 和板上下居中」附近（偏 0.6 mm）→ 吸附到 x=110, y=30
        await drag('window.__C', [110.6, 30.5])
        g = await pg.evaluate(GREEN)
        st = await pg.inner_text('.sk-status')
        await pg.screenshot(path=OUT + 'smart1_edge.png')
        await pg.mouse.up(); await pg.wait_for_timeout(200)
        c = await pg.evaluate("[window.__C.bounds.center.x, window.__C.bounds.center.y].map(v=>Math.round(v*1000)/1000)")
        assert c == [110, 30], c
        assert g >= 2, g
        assert '贴边' in st and '居中' in st, st
        # 选中静止时也显示
        assert await pg.evaluate(GREEN) >= 2

        # 2) 小圆拖到和大圆外切附近（圆心距 18.5，应吸到 18）
        import math
        await pg.mouse.click(10, 10)
        await drag('window.__D', [110 + 13.1, 30 + 13.1])   # 距离 ≈ 18.53
        st = await pg.inner_text('.sk-status')
        await pg.screenshot(path=OUT + 'smart1_tangent.png')
        await pg.mouse.up(); await pg.wait_for_timeout(200)
        dist = await pg.evaluate("window.__D.bounds.center.getDistance(window.__C.bounds.center)")
        assert abs(dist - 18) < 1e-3, dist
        assert '相切' in st, st

        # 3) 远离时没有绿线
        await drag('window.__D', [200, 200])
        await pg.mouse.up(); await pg.wait_for_timeout(200)
        assert await pg.evaluate(GREEN) == 0
        await b.close()
    assert not errs, errs
    print('PASS smart1：贴边 + 居中吸附显示绿线；圆和圆相切吸附；静止选中也显示；远离无绿线；描线为实线')

asyncio.run(main())
