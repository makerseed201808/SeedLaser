"""A4 不变量：二维 ↔ 3D 往返。画板 → 3D 装配（含自动拼装）→ 回画板，重复两次；
所有图形（板、孔、曲线、雕刻、描线、板外的线、旋转过的板）的节点和控制柄位置不变（误差 ≤ 0.001 mm）。带断言。"""
import asyncio, os
from _kit import seed_rect
from playwright.async_api import async_playwright

OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
D = 'window.__seedDebug'
ED = D + '.sketchEd'

SNAP = f"""(()=>{{const e={ED}; const out={{}};
  e.content.children.forEach(c=>{{ if(!c.data||!c.data.mode) return;
    const paths=(c.className==='CompoundPath'?c.children:[c]).map(p=>({{closed:p.closed, segs:p.segments.map(s=>[s.point.x,s.point.y,s.handleIn.x,s.handleIn.y,s.handleOut.x,s.handleOut.y])}}));
    out[c.data.id]={{mode:c.data.mode, paths}}; }});
  return out;}})()"""


def base(snap):
    """回画板时图形 id 会加上「板件 id§」前缀（按板件归属），按原始 id 对比。"""
    return {k.split('§')[-1]: v for k, v in snap.items()}


def compare(a, b, tag):
    a, b = base(a), base(b)
    assert set(a) == set(b), (tag, '图形数量变了', sorted(set(a) ^ set(b)))
    worst = 0.0
    for k in a:
        assert a[k]['mode'] == b[k]['mode'], (tag, k)
        pa, pb = a[k]['paths'], b[k]['paths']
        assert len(pa) == len(pb), (tag, k)
        for x, y in zip(pa, pb):
            assert x['closed'] == y['closed'] and len(x['segs']) == len(y['segs']), (tag, k)
            for s, t in zip(x['segs'], y['segs']):
                worst = max(worst, max(abs(u - v) for u, v in zip(s, t)))
    assert worst <= 0.001, (tag, '位置变了', worst)
    return worst


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
        await seed_rect(pg)          # 新建设计是空白的：这个测试要用的矩形板自己画
        await pg.evaluate(f"""(()=>{{const e={ED}; const ps=e.ps;
          const add=(path,mode)=>{{const it=e.addItem({{mode,paths:[]}}); it.remove(); path.data=it.data; e.content.addChild(path); e.style(path); return path;}};
          // 矩形板 + 圆孔 + 雕刻文字框 + 描线
          add(new ps.Path.Rectangle({{point:[150.123,20.457],size:[120.5,80.25],insert:false}}),'cut');
          add(new ps.Path.Circle({{center:[180.3,60.7],radius:12.345,insert:false}}),'cut');
          add(new ps.Path.Rectangle({{point:[210,40],size:[40,20],insert:false}}),'engrave');
          add(new ps.Path.Line({{from:[160,30],to:[260,32.5],insert:false}}),'score');
          // 圆形板（贝塞尔）+ 旋转 33.3° 的多边形板
          add(new ps.Path.Circle({{center:[330.77,140.11],radius:41.9,insert:false}}),'cut');
          const hex=add(new ps.Path.RegularPolygon({{center:[200,200],sides:6,radius:45.6,insert:false}}),'cut'); hex.rotate(33.3);
          // 板外的一条曲线
          const c=add(new ps.Path({{segments:[[20,250],[60,280]],insert:false}}),'cut'); c.segments[0].handleOut=new ps.Point(15,-30); c.segments[1].handleIn=new ps.Point(-10,25);
          e.commit('t');}})()""")
        await pg.wait_for_timeout(800)
        s0 = await pg.evaluate(SNAP)
        assert len(s0) >= 8, len(s0)
        worst = []
        ids = []
        for rnd in range(2):
            await pg.click('.sk-back'); await pg.wait_for_timeout(3500)                    # → 3D 装配
            if rnd == 0:
                auto = await pg.query_selector('#parts-panel [data-k=auto]')
                if auto:
                    await auto.click(); await pg.wait_for_timeout(3000)               # 自动拼装（只改 3D 姿态）
            await pg.click('#stage-bar [data-stage=design]'); await pg.wait_for_timeout(2000)   # → 回画板
            s1 = await pg.evaluate(SNAP)
            worst.append(compare(s0, s1, f'第 {rnd + 1} 次往返'))
            ids.append(sorted(s1))
        assert ids[0] == ids[1], ('第二次往返图形 id 又变了', ids)
        await pg.screenshot(path=OUT + 'roundtrip1.png')
        await b.close()
    assert not errs, errs
    print(f'PASS roundtrip1：画板 → 3D 装配 → 画板 × 2，{len(s0)} 个图形的节点 / 控制柄最大偏差 {max(worst):.2g} mm（≤ 0.001）')

asyncio.run(main())
