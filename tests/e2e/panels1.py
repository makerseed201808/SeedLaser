"""右侧属性面板跟着「选中了什么」走（参考 Illustrator / Figma）。带断言：
  没选中：板件信息 + 提示，无功能区块；画图工具：只有工具设置；选中 1 个：运算 / 变换 / 阵列；选中 2 个：再加对齐；
  左侧功能按钮 = 跳到并展开对应区块；区块标题可折叠，且记住状态。"""
import asyncio, os
from playwright.async_api import async_playwright

OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
SHOWN = "[...new Set([...document.querySelectorAll('.sk-side [data-panel]')].filter(c=>!c.classList.contains('hidden')).map(c=>c.dataset.panel))].sort()"
VIS = lambda sel: f"!!document.querySelector('{sel}') && !document.querySelector('{sel}').classList.contains('hidden')"
ED = 'window.__seedDebug.sketchEd'


async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch()
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []
        pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1'); if(!sessionStorage.getItem('e2eInit')){localStorage.removeItem('seedboxes.skCollapsed');sessionStorage.setItem('e2eInit','1')}")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry')
        await pg.wait_for_selector('#sk-host:not(.hidden)', timeout=30000)
        await pg.wait_for_timeout(500)
        assert await pg.evaluate(SHOWN) == [], await pg.evaluate(SHOWN)
        assert await pg.evaluate(VIS('.sk-emptyhint')) and await pg.evaluate(VIS('.sk-boardinfo'))
        # 没选中时点左侧「阵列」：只提示，不出区块
        await pg.click('[data-tool=p-array]')
        assert await pg.evaluate(SHOWN) == []
        assert '先在画布上选中图形' in await pg.inner_text('.sk-status')
        # 画图工具：只有工具设置
        await pg.keyboard.press('r')
        assert await pg.evaluate(SHOWN) == [] and await pg.evaluate(VIS('.sk-toolopts')) and not await pg.evaluate(VIS('.sk-emptyhint'))
        # 画第二个矩形 → 自动选中它：运算 / 变换 / 阵列
        cv = await pg.locator('.sk-canvas').bounding_box()
        x0, y0 = cv['x'] + 500, cv['y'] + 300
        await pg.mouse.move(x0, y0); await pg.mouse.down(); await pg.mouse.move(x0 + 100, y0 + 60, steps=5); await pg.mouse.up()
        await pg.keyboard.press('v')
        assert await pg.evaluate(f"{ED}.sel.size") == 1
        assert await pg.evaluate(SHOWN) == ['array', 'bool', 'info', 'transform'], await pg.evaluate(SHOWN)
        # 默认折叠：阵列、路径、编组
        col = "(k)=>document.querySelector(`.sk-side [data-key=${k}]`).classList.contains('collapsed')"
        assert await pg.evaluate(f"({col})('array')") and await pg.evaluate(f"({col})('t-path')") and not await pg.evaluate(f"({col})('bool')")
        # 左侧「阵列」：展开阵列区块
        await pg.click('[data-tool=p-array]')
        assert not await pg.evaluate(f"({col})('array')")
        # 点标题折叠「运算」，刷新后仍折叠（记住状态）
        await pg.click('.sk-side [data-key=bool] h4')
        assert await pg.evaluate(f"({col})('bool')")
        # 全选（2 个）：多出对齐
        await pg.keyboard.press('Control+a')
        assert await pg.evaluate(SHOWN) == ['align', 'array', 'bool', 'info', 'transform'], await pg.evaluate(SHOWN)
        await pg.screenshot(path=OUT + 'props_two.png')
        await pg.reload()
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)', timeout=30000)
        assert await pg.evaluate(f"({col})('bool')"), '折叠状态应记住'
        await b.close()
    assert not errs, errs
    print('PASS panels1：属性面板随选中内容变化；功能按钮跳到区块；折叠并记住')

asyncio.run(main())
