"""多开项目（顶部标签栏）：两个设计来回切换内容不串；未保存标记跟着标签走；回主页再回来；
从设计里去快速建模「放进当前设计」回到原标签；关闭标签。带断言。"""
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
        ntabs = lambda: pg.evaluate("document.querySelectorAll('#doc-tabs .dt-tab').length")
        names = lambda: pg.evaluate("[...document.querySelectorAll('#doc-tabs .dt-tab')].map(t=>t.querySelector('.dt-name').textContent+(t.querySelector('.dt-dot')?'●':'')+(t.classList.contains('on')?'*':''))")
        count = lambda: pg.evaluate(f"{ED}.content.children.length")
        add = lambda x, y: pg.evaluate(f"""(()=>{{const e={ED}; const it=e.addItem({{mode:'cut',paths:[]}}); it.remove();
            const r=new e.ps.Path.Circle({{center:[{x},{y}],radius:8,insert:false}}); r.data=it.data; e.content.addChild(r); e.style(r); e.commit('t');}})()""")
        assert await ntabs() == 0 and await pg.is_visible('#doc-tabs .dt-home.on')
        # 标签 1：两个圆
        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)'); await pg.wait_for_timeout(2000)
        n0 = await count()
        await add(200, 150); await add(250, 150); await pg.wait_for_timeout(600)
        assert await ntabs() == 1 and (await names())[0].endswith('●*'), await names()
        # 标签 2（＋）：一个圆
        await pg.click('#doc-tabs .dt-new'); await pg.wait_for_timeout(2500)
        assert await ntabs() == 2 and await count() == n0
        await add(300, 100); await pg.wait_for_timeout(600)
        nm = await names()
        assert nm[0].endswith('●') and not nm[0].endswith('*') and nm[1].endswith('●*'), nm
        await pg.screenshot(path=OUT + 'tabs1.png', clip={'x': 0, 'y': 0, 'width': 1500, 'height': 130})
        # 切回标签 1：还是两个圆；切到标签 2：一个圆
        await pg.click('#doc-tabs .dt-tab:nth-child(1)'); await pg.wait_for_timeout(2500)
        assert await count() == n0 + 2, await count()
        assert '●' in await pg.inner_text('#sk-host .sk-savestate') or await pg.evaluate("document.querySelector('#sk-host .sk-savestate').classList.contains('dirty')")
        await pg.click('#doc-tabs .dt-tab:nth-child(2)'); await pg.wait_for_timeout(2500)
        assert await count() == n0 + 1, await count()
        # 回主页再回来
        await pg.click('#doc-tabs .dt-home'); await pg.wait_for_timeout(500)
        assert await pg.is_visible('#home') and not await pg.is_visible('#sk-host')
        await pg.click('#doc-tabs .dt-tab:nth-child(2)'); await pg.wait_for_timeout(2500)
        assert await count() == n0 + 1
        # 从设计去快速建模，「放进当前设计」→ 回到标签 2，不新开标签
        await pg.click('#doc-tabs .dt-home'); await pg.click('#home-quick'); await pg.wait_for_timeout(500)
        await pg.evaluate("window.SeedApp.select('ABox')"); await pg.wait_for_timeout(2500)
        assert (await pg.inner_text('#btn-to-design')).startswith('放进「'), await pg.inner_text('#btn-to-design')
        assert await pg.is_visible('#btn-to-new')
        await pg.click('#btn-to-design'); await pg.wait_for_selector('#sk-host:not(.hidden)', timeout=40000); await pg.wait_for_timeout(1500)
        assert await ntabs() == 2, await names()
        assert await count() > n0 + 1, await count()            # 标签 2 原来的圆 + 盒子的板
        assert (await names())[1].endswith('●*'), await names()
        # 关闭标签 2（有改动 → 先问，选不保存）→ 回到标签 1
        await pg.click('#doc-tabs .dt-tab.on .dt-x'); await pg.wait_for_selector('.sk-confirm')
        await pg.click('.sk-confirm [data-r=discard]'); await pg.wait_for_timeout(2500)
        assert await ntabs() == 1 and await count() == n0 + 2, (await names(), await count())
        await b.close()
    assert not errs, errs
    print('PASS tabs1：多开标签——切换内容不串、未保存标记跟着标签、回主页再回来、快速建模放进当前设计回原标签、关闭先确认')

asyncio.run(main())
