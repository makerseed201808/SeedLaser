"""右侧参数卡片跟左侧工具走：默认不显示功能卡片；点「对齐 / 运算 / 阵列 / 变换」只显示对应卡片，画布仍可选择；再点收起；换画图工具时收起。带断言。"""
import asyncio, os
from playwright.async_api import async_playwright

OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
SHOWN = "[...document.querySelectorAll('.sk-side [data-panel]')].filter(c=>!c.classList.contains('hidden')).map(c=>c.dataset.panel)"
ED = 'window.__seedDebug.sketchEd'


async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry')
        await pg.wait_for_selector('#sk-host:not(.hidden)', timeout=30000)
        await pg.wait_for_timeout(500)
        assert await pg.evaluate(SHOWN) == [], '默认不显示功能卡片'
        for tool, panel in [('p-align', 'align'), ('p-bool', 'bool'), ('p-array', 'array'), ('p-transform', 'transform')]:
            await pg.click(f'[data-tool={tool}]')
            shown = await pg.evaluate(SHOWN)
            assert shown and set(shown) == {panel}, (tool, shown)
            if panel == 'transform': assert len(shown) == 5, shown   # 变换分成 5 张卡片
            assert await pg.evaluate(f"{ED}.tool") == 'select'
        await pg.screenshot(path=OUT + 'panels_transform.png')
        # 面板打开时画布照常选择
        it = await pg.evaluate(f"(()=>{{const e={ED};const p=e.ps.view.projectToView(e.content.children[0].bounds.leftCenter);const r=e.canvas.getBoundingClientRect();return [p.x+r.left,p.y+r.top]}})()")
        await pg.mouse.click(it[0], it[1])
        assert await pg.evaluate(f"{ED}.sel.size") == 1
        assert set(await pg.evaluate(SHOWN)) == {'transform'}, '选中图形后面板不应消失'
        await pg.click('[data-tool=p-transform]')
        assert await pg.evaluate(SHOWN) == [], '再点同一个收起'
        await pg.click('[data-tool=p-array]')
        await pg.keyboard.press('r')
        assert await pg.evaluate(SHOWN) == [], '换画图工具时收起'
        assert await pg.evaluate("!document.querySelector('.sk-toolopts').classList.contains('hidden')"), '矩形工具的参数卡片应显示'
        await b.close()
    assert not errs, errs
    print('PASS panels1：功能卡片随左侧工具显示 / 收起，画布仍可选择')

asyncio.run(main())
