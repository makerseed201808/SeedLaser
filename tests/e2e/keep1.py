import asyncio, os, json
from playwright.async_api import async_playwright
OUT=os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width':1500,'height':900})
        logs=[]; pg.on('pageerror', lambda e: logs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry')
        await pg.wait_for_selector('#sk-host:not(.hidden)', timeout=30000)
        await pg.wait_for_timeout(800)
        cv = await pg.locator('.sk-canvas').bounding_box()
        x0, y0 = cv['x']+120, cv['y']+400
        async def rect(ax, ay, bx, by):
            await pg.keyboard.press('r')
            await pg.mouse.move(ax, ay); await pg.mouse.down(); await pg.mouse.move(bx, by, steps=6); await pg.mouse.up()
            await pg.wait_for_timeout(200)
        await rect(x0, y0, x0+200, y0+150)
        await rect(x0+300, y0, x0+500, y0+150)
        await pg.keyboard.press('j')
        await pg.mouse.move(x0+200, y0+75); await pg.mouse.click(x0+200, y0+75); await pg.wait_for_timeout(200)
        await pg.mouse.move(x0+300, y0+75); await pg.mouse.click(x0+300, y0+75); await pg.wait_for_timeout(300)
        await pg.click('.sk-back'); await pg.wait_for_timeout(4000)
        await pg.click('#parts-panel [data-k=auto]'); await pg.wait_for_timeout(5000)
        P = "window.SeedWorkshop.getProject()"
        pr = json.loads(await pg.evaluate(f"JSON.stringify({P})"))
        pid = [k for k in pr['poses'] if pr['poses'][k] != [q for q in pr['free']['parts'] if q['id']==k][0].get('x')][-1]; print('poses', list(pr['poses']))
        pose0 = pr['poses'][pid]; sk0 = pr['sketches'][pid]['items']
        part0 = [q for q in pr['free']['parts'] if q['id']==pid][0]
        print('posed', pid, part0)
        # back to sheet: move the posed part, rotate the other, and extend posed part left edge
        await pg.click('#stage-bar [data-stage=design]'); await pg.wait_for_timeout(1500)
        ed = "window.__seedDebug.sketchEd"
        await pg.evaluate(f"""(()=>{{const e={ed};
          const it=e.content.children.find(c=>c.data.pid==='{pid}');
          it.translate(new e.ps.Point(30, -40));           // 整块板换位置（排版）
          const segs=it.segments; const minx=Math.min(...segs.map(s=>s.point.x));
          segs.forEach(s=>{{ if (Math.abs(s.point.x-minx)<1e-6) s.point.x -= 10; }});   // 左边加宽 10 mm（改形状）
          const other=e.content.children.find(c=>c.data.pid && c.data.pid!=='{pid}' && c.data.pid!=='p1');
          other.rotate(90);
          e.commit('test');
        }})()""")
        await pg.wait_for_timeout(500)
        await pg.click('.sk-back'); await pg.wait_for_timeout(4000)
        pr2 = json.loads(await pg.evaluate(f"JSON.stringify({P})"))
        part1 = [q for q in pr2['free']['parts'] if q['id']==pid][0]
        print('part after', part1)
        print('pose same', pr2['poses'].get(pid) == pose0)
        a = sorted({(round(g[0],2), round(g[1],2)) for it in sk0 for pa in it['paths'] for g in pa['segs']})
        bb = sorted({(round(g[0],2), round(g[1],2)) for it in pr2['sketches'][pid]['items'] for pa in it['paths'] for g in pa['segs']})
        print('right-side vertices kept', [q for q in a if q[0] > 20][:4], all(q in bb for q in a if q[0] > 1))
        print('min x now', min(q[0] for q in bb))
        print('other part sa', [q.get('sa') for q in pr2['free']['parts']])
        await pg.screenshot(path=OUT+'keep_3d.png')
        await pg.click('#stage-bar [data-stage=make]'); await pg.wait_for_timeout(3000)
        await pg.screenshot(path=OUT+'keep_2d.png')
        print(logs[:3])
        await b.close()
asyncio.run(main())
