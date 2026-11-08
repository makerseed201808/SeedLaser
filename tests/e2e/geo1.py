"""A3 几何边界情况（前端）：蝴蝶结、8 字孔、差 0.001 mm 没闭合、重合节点、极小孔放进画板后——
识别板件正确、3D 预览能建出来、形状运算 / 偏移不报错。带断言。"""
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
        await pg.evaluate(f"""(()=>{{const e={ED};
          e.content.children.slice().forEach(c=>{{ if (c.data && c.data.mode) c.remove(); }});
          const P=(pts,closed=true)=>({{closed,segs:pts.map(([x,y])=>[x,y,0,0,0,0])}});
          window.__bow=e.addItem({{mode:'cut',paths:[P([[20,20],[60,60],[60,20],[20,60]])]}});
          e.addItem({{mode:'cut',paths:[P([[100,0],[200,0],[200,100],[100,100]])]}});
          e.addItem({{mode:'cut',paths:[P([[120,20],[160,60],[160,20],[120,60]])]}});
          window.__near=e.addItem({{mode:'cut',paths:[P([[250,0],[350,0],[350,100],[250,100],[250.001,0]],false)]}});
          e.addItem({{mode:'cut',paths:[P([[0,150],[0,150],[100,150],[100,150],[100,250],[0,250],[0,250]])]}});
          e.addItem({{mode:'cut',paths:[P([[150,150],[250,150],[250,250],[150,250]])]}});
          e.addItem({{mode:'cut',paths:[P([[200,200],[200.1,200],[200.1,200.1],[200,200.1]])]}});
          e.commit('t');}})()""")
        await pg.wait_for_function(f"{D}.view && {D}.view.objects.size===5", timeout=20000)
        await pg.wait_for_timeout(500)
        info = await pg.evaluate(f"""(()=>{{const W={D}.W, v={D}.view;
          return {{parts: W.project.free.parts.map(p=>[+p.w.toFixed(3), +p.h.toFixed(3)]).sort(),
                  loose: (W.project.free.loose||[]).length, nearClosed: window.__near.closed, nearSegs: window.__near.segments.length,
                  tri: [...v.objects.values()].map(o=>o.mesh.geometry.attributes.position ? o.mesh.geometry.attributes.position.count : 0)}};}})()""")
        # 5 块板：蝴蝶结 40×40、带 8 字孔的板、差一点闭合的板、有重合节点的板、带极小孔的板
        assert sorted(info['parts']) == [[40, 40], [100, 100], [100, 100], [100, 100], [100, 100]], info
        assert info['loose'] == 0, info
        assert info['nearClosed'] is True and info['nearSegs'] == 4, info
        assert all(t > 0 for t in info['tri']), info
        await pg.screenshot(path=OUT + 'geo1.png')
        # 蝴蝶结参与形状运算（合并）：不报错（偏移在后端，见 tests/py/test_geometry.py）
        await pg.evaluate(f"""(async()=>{{const e={ED}; const sq=e.addItem({{mode:'cut',paths:[{{closed:true,segs:[[30,30,0,0,0,0],[80,30,0,0,0,0],[80,50,0,0,0,0],[30,50,0,0,0,0]]}}]}});
          e.sel=new Set([window.__bow, sq]); e.boolean('unite'); }})()""")
        await pg.wait_for_timeout(800)
        await b.close()
    assert not errs, errs
    print('PASS geo1：蝴蝶结 / 8 字孔 / 差 0.001 mm 没闭合 / 重合节点 / 极小孔——识别成 5 块板、3D 预览建得出来、形状运算不报错')

asyncio.run(main())
