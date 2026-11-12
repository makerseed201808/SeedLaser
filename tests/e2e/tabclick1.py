"""顶部标签栏：内容没变时不重画（2026-11-12 检查发现）。
标题上的「未保存」圆点靠每 3 秒刷新一次标签栏；以前每次刷新都把整条标签栏重画一遍，
鼠标按下和松开之间如果正好赶上重画，被按的按钮已经换成了新的，这一下点击就丢了（点标签不切换、点 × 不关闭）。
检查：空闲 7 秒标签栏不重画；按住标签超过 3 秒再松开仍然切过去；有改动时圆点照常出现；标签上改名、Esc 取消后名字还在。带断言。"""
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
        names = lambda: pg.evaluate("[...document.querySelectorAll('#doc-tabs .dt-tab')].map(t=>(t.querySelector('.dt-name')||{textContent:'?'}).textContent+(t.querySelector('.dt-dot')?'●':'')+(t.classList.contains('on')?'*':''))")
        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)'); await pg.wait_for_timeout(2500)
        await pg.click('#doc-tabs .dt-new'); await pg.wait_for_timeout(3000)
        assert [n[-1] for n in await names()] == ['计', '*'], await names()          # 两个标签，第二个是当前的

        # 1) 空闲 7 秒（跨过两次 3 秒刷新）：标签栏一次都不重画
        await pg.evaluate("""(()=>{ window.__tabMut = 0; new MutationObserver((ms)=>{ window.__tabMut += ms.length; }).observe(document.querySelector('#doc-tabs'), {childList: true, subtree: true}); })()""")
        await pg.wait_for_timeout(7000)
        mut = await pg.evaluate("window.__tabMut")
        assert mut == 0, f'空闲时标签栏被重画了 {mut} 次'

        # 2) 按住第一个标签 3.4 秒再松开（中间跨过一次刷新）：仍然切过去
        box = await pg.locator('#doc-tabs .dt-tab:nth-child(1) .dt-ico').bounding_box()
        await pg.mouse.move(box['x'] + box['width'] / 2, box['y'] + box['height'] / 2)
        await pg.mouse.down(); await pg.wait_for_timeout(3400); await pg.mouse.up()
        await pg.wait_for_timeout(2500)
        nm = await names()
        assert nm[0].endswith('*') and not nm[1].endswith('*'), ('按住超过 3 秒的点击丢了', nm)

        # 3) 有改动：圆点照常出现（内容变了就重画）
        assert '●' not in nm[0], nm
        await pg.evaluate(f"""(()=>{{const e={ED}; const it=e.addItem({{mode:'cut',paths:[]}}); it.remove();
            const r=new e.ps.Path.Circle({{center:[200,150],radius:8,insert:false}}); r.data=it.data; e.content.addChild(r); e.style(r); e.commit('t');}})()""")
        await pg.wait_for_timeout(800)
        assert (await names())[0].endswith('●*'), await names()

        # 4) 点当前标签的名字 → 变成输入框；Esc 取消 → 名字回来（输入框不能留在上面）
        await pg.click('#doc-tabs .dt-tab.on .dt-name'); await pg.wait_for_timeout(300)
        assert await pg.locator('#doc-tabs .dt-input').count() == 1
        await pg.keyboard.press('Escape'); await pg.wait_for_timeout(300)
        assert await pg.locator('#doc-tabs .dt-input').count() == 0 and (await names())[0].endswith('●*'), await names()
        await pg.screenshot(path=OUT + 'tabclick1.png', clip={'x': 0, 'y': 0, 'width': 1500, 'height': 130})
        await b.close()
    assert not errs, errs
    print('PASS tabclick1：空闲时标签栏不重画；按住超过 3 秒的点击不丢；有改动时圆点照常出现；标签改名取消后恢复')


asyncio.run(main())
