"""3D 预览 = 二维总览：不在板里的线也画在台面上并框进镜头；在预览里点板件 / 线条，画板上选中并移到中间。带断言（真实鼠标点击预览画面）。"""
import asyncio, os
from playwright.async_api import async_playwright

OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
D = 'window.__seedDebug'
ED = D + '.sketchEd'


async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)'); await pg.wait_for_timeout(1500)
        # 板外画一条直线（远在左边），再加一块六边形板
        await pg.evaluate(f"""(()=>{{const e={ED}; const ps=e.ps;
          const add=(path,mode)=>{{const it=e.addItem({{mode,paths:[]}}); it.remove(); path.data=it.data; e.content.addChild(path); e.style(path); return path;}};
          window.__L=add(new ps.Path.Line({{from:[-300,250],to:[-200,300],insert:false}}),'cut');
          window.__H=add(new ps.Path.RegularPolygon({{center:[250,120],sides:6,radius:40,insert:false}}),'cut');
          e.commit('t');}})()""")
        await pg.wait_for_function(f"{D}.view && {D}.view.overlay && {D}.view.overlay.children.filter(c=>c.userData.itemId).length===1 && {D}.view.overlay.children.length===2", timeout=20000)
        await pg.wait_for_timeout(800)
        # 镜头把线框进来：线的两个端点都在预览画面里
        inside = await pg.evaluate(f"""(()=>{{const v={D}.view, T={D}.THREE; v.root.updateMatrixWorld(true);
          return [[-300,250],[-200,300]].map(([x,y])=>{{const q=new T.Vector3(x,y,0.3).applyMatrix4(v.root.matrixWorld).project(v.camera); return Math.abs(q.x)<1 && Math.abs(q.y)<1;}});}})()""")
        assert all(inside), inside
        scr = lambda js_pt: pg.evaluate(f"""(()=>{{const v={D}.view, T={D}.THREE; v.root.updateMatrixWorld(true);
          const q=new T.Vector3(...{js_pt}).applyMatrix4(v.root.matrixWorld).project(v.camera); const r=v.renderer.domElement.getBoundingClientRect();
          return [r.left+(q.x+1)/2*r.width, r.top+(1-q.y)/2*r.height];}})()""")
        await pg.screenshot(path=OUT + 'overview1.png')
        # 点预览里的线 → 画板选中这条线
        x, y = await scr('[-250,275,0.3]')
        await pg.mouse.click(x, y); await pg.wait_for_timeout(300)
        assert await pg.evaluate(f"{ED}.sel.has(window.__L)"), '点预览里的线应在画板上选中它'
        c = await pg.evaluate(f"(()=>{{const c={ED}.center(); return [Math.round(c.x),Math.round(c.y)]}})()")
        assert abs(c[0] + 250) < 2 and abs(c[1] - 275) < 2, c
        # 点预览里的六边形板（板厚中间）→ 选中六边形
        th = await pg.evaluate(f"{D}.W.model.thickness")
        x, y = await scr(f'[250,120,{th}]')
        await pg.mouse.click(x, y); await pg.wait_for_timeout(300)
        assert await pg.evaluate(f"{ED}.sel.has(window.__H)"), '点预览里的板应在画板上选中它'
        assert '已定位' in await pg.inner_text('#sk-host .sk-status')
        await b.close()
    assert not errs, errs
    print('PASS overview1：板外的线显示在 3D 预览并框进镜头；点预览里的线 / 板 → 画板选中并居中')

asyncio.run(main())
