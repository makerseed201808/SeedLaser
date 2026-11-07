import asyncio, os
from playwright.async_api import async_playwright
OUT=os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width':1500,'height':900})
        errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry')
        await pg.wait_for_selector('#sk-host:not(.hidden)', timeout=30000)
        await pg.wait_for_timeout(800)
        await pg.click('[data-tool=p-bool]')
        card = pg.locator('[data-bh=unite]').locator('xpath=ancestor::*[contains(@class,"sk-card")][1]')
        for k in ['unite','subtract','intersect','exclude']:
            await pg.hover(f'[data-bh={k}]'); await pg.wait_for_timeout(150)
            await card.screenshot(path=OUT+f'bh_{k}.png')
        print(errs)
        await b.close()
asyncio.run(main())
