"""自由设计三个板块：① 二维设计 → ② 3D 装配 → ③ 加工作业。带断言。
  设计 / 装配阶段不显示板件清单；加工作业显示加工清单（可取消某块不切）和左侧排版参数。"""
import asyncio, os
from playwright.async_api import async_playwright

OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
D = 'window.__seedDebug'
STAGE = "[...document.querySelectorAll('#stage-bar [data-stage].on')].map(b=>b.dataset.stage)[0]"
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
        await pg.click('#free-entry')
        await pg.wait_for_selector('#sk-host:not(.hidden)', timeout=30000)
        assert await pg.evaluate(STAGE) == 'design'
        # 画第二块板，然后「生成 3D」→ 装配
        cv = await pg.locator('.sk-canvas').bounding_box()
        await pg.keyboard.press('r')
        await pg.mouse.move(cv['x'] + 450, cv['y'] + 300); await pg.mouse.down(); await pg.mouse.move(cv['x'] + 600, cv['y'] + 400, steps=5); await pg.mouse.up()
        await pg.click('.sk-back'); await pg.wait_for_timeout(3500)
        assert await pg.evaluate(STAGE) == 'assemble'
        assert await pg.evaluate(VIS('#view3d')) and not await pg.evaluate(VIS('#form-pane'))
        assert await pg.query_selector('#parts-panel .pp-row') is None, '装配阶段不显示板件清单'
        assert await pg.evaluate(VIS('#parts-panel [data-k=auto]'))
        assert not await pg.evaluate(VIS('#preview-toolbar .seg'))
        await pg.screenshot(path=OUT + 'stage_assemble.png')
        # ③ 加工作业
        await pg.click('#stage-bar [data-stage=make]'); await pg.wait_for_timeout(3000)
        assert await pg.evaluate(STAGE) == 'make'
        assert await pg.evaluate(VIS('#preview-host')) and await pg.evaluate(VIS('#form-pane'))
        rows = await pg.query_selector_all('#make-panel .mk-row')
        assert len(rows) == 2, len(rows)
        svg0 = await pg.evaluate("document.querySelector('#preview-host').innerHTML.length")
        await pg.screenshot(path=OUT + 'stage_make.png')
        await pg.click('#make-panel .mk-row:nth-of-type(2) input'); await pg.wait_for_timeout(2500)
        assert len(await pg.evaluate(f"{D}.W.project.disabled")) == 1
        assert '要切 1' in await pg.inner_text('#make-panel .pp-count')
        svg1 = await pg.evaluate("document.querySelector('#preview-host').innerHTML.length")
        assert svg1 < svg0, (svg0, svg1)                       # 取消的那块不再出现在图纸里
        # 回到 ① 二维设计：打开画板，板件都在
        await pg.click('#stage-bar [data-stage=design]'); await pg.wait_for_selector('#sk-host:not(.hidden)', timeout=20000)
        assert await pg.evaluate(STAGE) == 'design'
        assert await pg.evaluate(f"{D}.sketchEd.recognizeParts().parts.length") == 2
        await b.close()
    assert not errs, errs
    print('PASS stage1：设计 → 装配（无板件清单）→ 加工作业（清单 + 排版，取消一块后图纸变小）→ 回到设计')

asyncio.run(main())
