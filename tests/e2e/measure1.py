"""测量：右侧有方式面板；点到点（拖 / 点两下）、点到线、线到线（平行间距、夹角）、圆（半径 / 圆心距）；
新测量会清掉旧的，换工具清除。偏移：生成新图形并提示。带断言。"""
import asyncio, os, re
from playwright.async_api import async_playwright

OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
ED = 'window.__seedDebug.sketchEd'


async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)'); await pg.wait_for_timeout(600)
        # 场景：矩形 0..100 × 0..60；斜线 (130,0)-(130+30,30)（45°）；圆 c(40,30) r10；圆 c(70,30) r5
        await pg.evaluate(f"""(()=>{{const e={ED}; const ps=e.ps; e.content.removeChildren();
          const add=(path)=>{{const it=e.addItem({{mode:'cut',paths:[]}}); it.remove(); path.data=it.data; e.content.addChild(path); e.style(path); return path;}};
          window.__R=add(new ps.Path.Rectangle({{point:[0,0],size:[100,60],insert:false}}));
          add(new ps.Path.Line({{from:[130,0],to:[160,30],insert:false}}));
          add(new ps.Path.Circle({{center:[40,30],radius:10,insert:false}}));
          add(new ps.Path.Circle({{center:[75,30],radius:5,insert:false}}));
          e.sel.clear(); e.setView(4,110,-10); e.refresh();}})()""")
        V = lambda x, y: pg.evaluate(f"(()=>{{const e={ED};const r=e.canvas.getBoundingClientRect();const v=e.ps.view.projectToView(new e.ps.Point({x},{y}));return [v.x+r.left,v.y+r.top]}})()")
        box = lambda: pg.inner_text('.sk-measure')
        def num(t, key):
            m = re.search(key + r'\s*([-\d.]+)', t)
            assert m, (key, t)
            return float(m.group(1))
        groups = lambda: pg.evaluate(f"{ED}.measureLayer.children.length")
        click = lambda x, y: V(x, y)

        await pg.keyboard.press('m')
        assert await pg.is_visible('.sk-toolopts [data-mm=pp]'), '右侧应有测量面板'
        # 点到点：拖动（吸附矩形角 0,0 → 100,60）
        a = await V(0.3, 0.2); c = await V(99.7, 59.8)
        await pg.mouse.move(*a); await pg.mouse.down(); await pg.mouse.move(*c, steps=8); await pg.mouse.up()
        t = await box(); assert abs(num(t, '距离') - 116.619) < 0.01, t
        assert '116.62' in await pg.inner_text('.sk-meas-result'), '结果也显示在右侧'
        # 点到点：点两下（新测量清掉旧的）
        await pg.mouse.click(*(await V(0, 60))); await pg.mouse.click(*(await V(100, 60)))
        t = await box(); assert abs(num(t, '距离') - 100) < 0.01, t
        assert await groups() == 1
        # 点到线：点 (0,0) 到斜线（延长线）的垂直距离 = 130/√2
        await pg.click('[data-mm=pl]')
        await pg.mouse.click(*(await V(0, 0))); await pg.mouse.click(*(await V(145, 15)))
        t = await box(); assert abs(num(t, '垂直距离') - 91.924) < 0.01 and '延长线' in t, t
        # 线到线：矩形上下边 → 平行间距 60
        await pg.click('[data-mm=ll]')
        await pg.mouse.click(*(await V(20, 0))); await pg.mouse.click(*(await V(20, 60)))
        t = await box(); assert '平行' in t and abs(num(t, '间距') - 60) < 0.01, t
        # 线到线：矩形右边 和 斜线 → 夹角 45°，最近距离 30（(100,0) 到 (130,0)）
        await pg.mouse.click(*(await V(100, 30))); await pg.mouse.click(*(await V(145, 15)))
        t = await box(); assert abs(num(t, '夹角') - 45) < 0.01 and abs(num(t, '最近距离') - 30) < 0.01, t
        await pg.screenshot(path=OUT + 'measure1.png')
        # 圆：半径 / 直径；再点另一个圆：圆心距 35、间隙 20
        await pg.click('[data-mm=cc]')
        await pg.mouse.click(*(await V(50, 30)))
        t = await box(); assert abs(num(t, '半径') - 10) < 0.01 and abs(num(t, '直径') - 20) < 0.01, t
        await pg.mouse.click(*(await V(80, 30)))
        t = await box(); assert abs(num(t, '圆心距') - 35) < 0.01 and abs(num(t, '边缘间隙') - 20) < 0.01, t
        # 换工具：清除
        await pg.keyboard.press('v')
        assert await groups() == 0 and not await pg.is_visible('.sk-measure')

        # 偏移：选中矩形，-5 尖角 → 新增 90×50
        await pg.evaluate(f"{ED}.sel=new Set([window.__R]); {ED}.refresh()")
        await pg.fill('[data-opt=offset]', '-5'); await pg.select_option('[data-opt=offsetJoin]', 'miter')
        n0 = await pg.evaluate(f"{ED}.content.children.length")
        await pg.click('[data-act=offset]'); await pg.wait_for_timeout(1200)
        bb = await pg.evaluate(f"(()=>{{const it=[...{ED}.sel][0];return [it.bounds.x,it.bounds.y,it.bounds.width,it.bounds.height].map(v=>Math.round(v*1000)/1000)}})()")
        assert await pg.evaluate(f"{ED}.content.children.length") == n0 + 1 and bb == [5, 5, 90, 50], bb
        await b.close()
    assert not errs, errs
    print('PASS measure1：测量面板 4 种方式（点到点 / 点到线 / 线到线平行间距和夹角 / 圆半径和圆心距）数值正确，旧结果自动清除；偏移生成新图形')

asyncio.run(main())
