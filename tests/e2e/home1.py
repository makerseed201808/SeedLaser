"""SeedLaser 主页 + 快速建模放进设计。带断言：
  主页三个入口（无左侧模型库）；快速建模 → 选 ABox → 「放进设计」→ 二维画板里出现 5 块板，3D 装配位置带过来、没有穿透；
  设计中途去快速建模再放进来 = 放进当前设计（板件累加）。"""
import asyncio, json, os
from playwright.async_api import async_playwright

OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
D = 'window.__seedDebug'
VIS = lambda sel: f"(()=>{{const e=document.querySelector('{sel}');return !!e && e.offsetParent!==null}})()"


async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        assert await pg.title() == 'SeedLaser'
        assert await pg.evaluate(VIS('#home')) and not await pg.evaluate(VIS('.sidebar'))
        assert len(await pg.query_selector_all('.home-card')) == 3
        await pg.screenshot(path=OUT + 'home.png')
        # 快速建模：模型库有左侧列表
        await pg.click('#home-quick')
        assert await pg.evaluate(VIS('#welcome')) and await pg.evaluate(VIS('.sidebar'))
        await pg.screenshot(path=OUT + 'quick_lib.png')
        await pg.evaluate("window.SeedApp.select('ABox')"); await pg.wait_for_timeout(2500)
        assert await pg.evaluate(VIS('#btn-to-design'))
        assert (await pg.inner_text('#btn-to-design')).startswith('放进设计')
        await pg.click('#btn-to-design')
        await pg.wait_for_selector('#sk-host:not(.hidden)', timeout=40000)
        await pg.wait_for_timeout(800)
        n = await pg.evaluate(f"{D}.sketchEd.recognizeParts().parts.length")
        assert n == 5, n
        await pg.screenshot(path=OUT + 'quick_to_design.png')
        pr = json.loads(await pg.evaluate("JSON.stringify(window.SeedWorkshop.getProject())"))
        assert len(pr['poses']) == 5 and len(pr['free']['parts']) == 5
        # 去装配：5 块板按模型位置拼好、没有穿透
        await pg.click('.sk-back'); await pg.wait_for_timeout(6000)
        rep = await pg.evaluate(f"JSON.stringify({D}.W.pose.report)")
        rep = json.loads(rep) if rep and rep != 'null' else {}
        assert rep and not any(v['collide'] for v in rep.values()), rep
        await pg.screenshot(path=OUT + "quick_assembled.png")
        assert sum(1 for v in rep.values() if v["touch"]) >= 4, rep
        await pg.screenshot(path=OUT + 'quick_assembled.png')
        # 设计中途：去模型库再放一个 → 放进当前设计
        await pg.evaluate("window.SeedApp.select('ABox')"); await pg.wait_for_timeout(2500)
        assert (await pg.inner_text('#btn-to-design')).startswith('放进当前设计')
        await pg.click('#btn-to-design')
        await pg.wait_for_selector('#sk-host:not(.hidden)', timeout=40000)
        await pg.wait_for_timeout(800)
        assert await pg.evaluate(f"{D}.sketchEd.recognizeParts().parts.length") >= 10
        await b.close()
    assert not errs, errs
    print('PASS home1：主页三入口；快速建模 ABox 放进设计（5 块板、装配位置带过来、无穿透）；中途再放 = 放进当前设计')

asyncio.run(main())
