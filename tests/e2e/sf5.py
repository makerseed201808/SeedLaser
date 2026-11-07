import asyncio, os, json
from playwright.async_api import async_playwright
OUT=os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=swiftshader','--enable-unsafe-swiftshader','--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width':1500,'height':900})
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry')
        await pg.wait_for_selector('#sk-host:not(.hidden)', timeout=30000)
        await pg.wait_for_timeout(800)
        cv = await pg.locator('.sk-canvas').bounding_box()
        x0, y0 = cv['x']+150, cv['y']+380
        for i in range(3):
            await pg.keyboard.press('r')
            await pg.mouse.move(x0+i*220, y0); await pg.mouse.down(); await pg.mouse.move(x0+i*220+180, y0+120, steps=5); await pg.mouse.up()
            await pg.wait_for_timeout(200)
        await pg.click('.sk-back'); await pg.wait_for_timeout(4000)
        D="window.__seedDebug"
        await pg.evaluate(f"{D}.openSketchForge()"); await pg.wait_for_timeout(9000)
        sid = await pg.evaluate(f"[...{D}.SF.map.keys()][1]")
        await pg.evaluate(f"{D}.sfCommand('delete_objects', {{ids:['{sid}']}})"); await pg.wait_for_timeout(1500)
        await pg.evaluate(f"{D}.closeSketchForge()"); await pg.wait_for_timeout(1500)
        print('disabled', await pg.evaluate(f"JSON.stringify({D}.W.project.disabled)"))
        print('note', await pg.evaluate("document.querySelector('#view3d-note').textContent"))
        await pg.evaluate(f"{D}.openSketchForge()"); await pg.wait_for_timeout(9000)
        sc = await pg.evaluate(f"{D}.sfCommand('get_scene').then(s=>(s.objects||s.shapes||[]).length)")
        print('scene objects after reopen', sc, 'map', await pg.evaluate(f"{D}.SF.map.size"))
        await b.close()
asyncio.run(main())
