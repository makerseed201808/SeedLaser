"""镜像复制的对称轴：独立图形紧贴右边 / 下边；板上的孔按这块板的中线对称。带断言。"""
import asyncio, os
from playwright.async_api import async_playwright

ED = 'window.__seedDebug.sketchEd'


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)'); await pg.wait_for_timeout(1200)
        await pg.evaluate(f"""(()=>{{const e={ED}; const ps=e.ps;
          const add=(path,mode)=>{{const it=e.addItem({{mode,paths:[]}}); it.remove(); path.data=it.data; e.content.addChild(path); e.style(path); return path;}};
          window.__T=add(new ps.Path({{segments:[[-140,250],[-80,280],[-80,200]],closed:true,insert:false}}),'cut');   // 独立的三角形（不在板里）
          const board=e.content.children[0];
          window.__O=add(new ps.Path.Circle({{center:[board.bounds.left+20, board.bounds.center.y],radius:5,insert:false}}),'cut'); // 板上的孔
          window.__B=board; e.commit('t');}})()""")
        bb = lambda it: pg.evaluate(f"(()=>{{const b=[...{ED}.sel].find(x=>x!=={it}).bounds;return [b.left,b.right,b.top,b.bottom].map(v=>Math.round(v*1000)/1000)}})()")
        # 独立图形：左右镜像复制 → 紧贴右边
        await pg.evaluate(f"{ED}.sel=new Set([window.__T]); {ED}.act('mirCopyH')")
        r = await bb('window.__T')
        assert r[:2] == [-80, -20], r
        assert '紧贴在右边' in await pg.inner_text('#sk-host .sk-status')
        await pg.evaluate(f"{ED}.undo()")
        # 上下镜像复制 → 紧贴下边（paper top = 屏幕下方）
        await pg.evaluate(f"(()=>{{const e={ED}; window.__T=e.content.children.find(c=>Math.abs(c.bounds.left+140)<1e-6); e.sel=new Set([window.__T]); e.act('mirCopyV');}})()")
        r = await bb('window.__T')
        assert r[2:] == [120, 200], r
        await pg.evaluate(f"{ED}.undo()")
        # 板上的孔：按这块板的中线对称
        cx = await pg.evaluate(f"(()=>{{const B=[...{ED}.content.children].find(c=>c.data.pid); return B.bounds.center.x}})()")
        await pg.evaluate(f"(()=>{{const e={ED}; const O=e.content.children.find(c=>c.bounds.width<11 && c.bounds.width>9); e.sel=new Set([O]); window.__O2=O; e.act('mirCopyH');}})()")
        r = await bb('window.__O2')
        ox = await pg.evaluate("window.__O2.bounds.center.x")
        assert abs((r[0] + r[1]) / 2 - (2 * cx - ox)) < 1e-3, (r, cx, ox)
        assert '中线' in await pg.inner_text('#sk-host .sk-status')
        await b.close()
    assert not errs, errs
    print('PASS mirror1：独立图形镜像复制紧贴右边 / 下边；板上的孔按这块板的中线对称')

asyncio.run(main())
