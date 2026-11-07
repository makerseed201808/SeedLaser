"""画布上不显示「板件 N · 尺寸」标签；选中图形后右侧「图形信息」显示详细参数。带断言。"""
import asyncio, os
from playwright.async_api import async_playwright

ED = 'window.__seedDebug.sketchEd'


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)'); await pg.wait_for_timeout(1500)
        assert await pg.evaluate("document.querySelectorAll('#sk-host .sk-plabel').length") == 0, '画布上不应有板件标签'
        assert not await pg.is_visible('#sk-host [data-panel=info]'), '没选中时不显示图形信息'
        # 选中默认的 100×60 板；再加一个板上的圆孔 r=5
        await pg.evaluate(f"""(()=>{{const e={ED}; const board=e.content.children[0]; const it=e.addItem({{mode:'cut',paths:[]}}); it.remove();
            const c=new e.ps.Path.Circle({{center:[board.bounds.center.x, board.bounds.center.y],radius:5,insert:false}}); c.data=it.data; e.content.addChild(c); e.style(c);
            window.__B=board; window.__C=c; e.sel=new Set([board]); e.refresh();}})()""")
        t = await pg.inner_text('#sk-host .sk-info')
        assert '板件 1' in t and '外轮廓' in t and '100 × 60' in t and '60 cm²' in t and '切割长度' in t and '320' in t, t
        await pg.evaluate(f"{ED}.sel=new Set([window.__C]); {ED}.refresh()")
        t = await pg.inner_text('#sk-host .sk-info')
        assert '板件 1' in t and '孔' in t and '直径' in t and '10 mm' in t, t
        await pg.evaluate(f"{ED}.sel=new Set([window.__B, window.__C]); {ED}.refresh()")
        t = await pg.inner_text('#sk-host .sk-info')
        assert '2 个图形' in t and '切割 2' in t, t
        await pg.screenshot(path='/tmp/seedboxes-e2e/info1.png')
        await b.close()
    assert not errs, errs
    print('PASS info1：画布无板件标签；图形信息显示 板件归属 / 加工 / 形状 / 尺寸 / 面积 / 切割长度 / 直径；多选显示汇总')

asyncio.run(main())
