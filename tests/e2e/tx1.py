import asyncio, os
from playwright.async_api import async_playwright
OUT=os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width':1500,'height':900})
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry')
        await pg.wait_for_selector('#sk-host:not(.hidden)', timeout=30000)
        await pg.wait_for_timeout(800)
        ed = "window.__seedDebug.sketchEd"
        c = await pg.evaluate(f"(()=>{{const e={ed};const it=e.content.children[0];const p=e.ps.view.projectToView(it.bounds.center);const r=e.canvas.getBoundingClientRect();return [p.x+r.left,p.y+r.top]}})()")
        await pg.keyboard.press('t'); await pg.mouse.click(c[0]-40, c[1]); await pg.wait_for_timeout(1500)
        await pg.keyboard.press('a')   # node tool, text stays selected
        await pg.wait_for_timeout(300)
        print('red lens', await pg.evaluate(f"{ed}.overlapWarn"))
        ta = pg.locator('.sk-toolopts textarea')
        await ta.fill('种子创客')
        await pg.mouse.click(c[0]+300, c[1]+250)   # click empty canvas
        await pg.wait_for_timeout(2000)
        print(await pg.evaluate(f"{ed}.content.children.filter(c=>c.data.text).map(c=>c.data.text.text||c.data.text.value||JSON.stringify(c.data.text).slice(0,80))"))
        await pg.screenshot(path=OUT+'tx1.png')
        await b.close()
asyncio.run(main())
