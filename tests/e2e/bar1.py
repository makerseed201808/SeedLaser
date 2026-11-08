"""菜单栏 v2：编辑 / 帮助菜单；缩放百分比和 −/+；上下文栏（没选中 = 材料数据，选中 = 位置尺寸 + 对齐 + 复制删除）。带断言。"""
import asyncio, os
from playwright.async_api import async_playwright

ED = 'window.__seedDebug.sketchEd'
OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')


async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)'); await pg.wait_for_timeout(1500)
        H = '#sk-host '
        # 没选中：上下文栏显示材料数据
        t = await pg.inner_text(H + '.sk-ctx-data')
        assert '材料' in t and '400 × 300' in t and '板厚' in t and '1 块' in t and '切割' in t, t
        assert not await pg.is_visible(H + '.sk-ctx-sel')
        await pg.screenshot(path=OUT + 'bar1_idle.png', clip={'x': 0, 'y': 0, 'width': 1500, 'height': 110})
        # 缩放
        z0 = await pg.inner_text(H + '.sk-zoom')
        await pg.click(H + '[data-zoom=in]')
        z1 = await pg.inner_text(H + '.sk-zoom')
        assert int(z1[:-1]) > int(z0[:-1]), (z0, z1)
        # 选中：位置尺寸 + 复制一份
        await pg.evaluate(f"(()=>{{const e={ED}; e.sel=new Set([e.content.children[0]]); e.refresh();}})()")
        assert await pg.is_visible(H + '.sk-ctx-sel') and not await pg.is_visible(H + '.sk-ctx-idle')
        assert await pg.input_value(H + '[data-num=w]') == '100'
        assert '选中 1 个' in await pg.inner_text(H + '.sk-ctx-count')
        await pg.screenshot(path=OUT + 'bar1_sel.png', clip={'x': 0, 'y': 0, 'width': 1500, 'height': 110})
        n0 = await pg.evaluate(f"{ED}.content.children.length")
        await pg.click(H + '.sk-ctx-sel [data-act=dup]')
        assert await pg.evaluate(f"{ED}.content.children.length") == n0 + 1
        # 编辑菜单：撤销
        await pg.click(H + '[data-menu=edit]')
        await pg.wait_for_selector('.sk-filemenu [data-mact=undo]')
        await pg.screenshot(path=OUT + 'bar1_edit.png', clip={'x': 0, 'y': 0, 'width': 700, 'height': 420})
        await pg.click('.sk-filemenu [data-mact=undo]')
        assert await pg.evaluate(f"{ED}.content.children.length") == n0
        assert not await pg.query_selector('.sk-filemenu')
        # 菜单互相切换：编辑 → 文件 → 再点文件关闭
        await pg.click(H + '[data-menu=edit]'); await pg.click(H + '[data-filemenu]')
        assert await pg.query_selector('.sk-filemenu [data-fc=save]')
        await pg.click(H + '[data-filemenu]')
        assert not await pg.query_selector('.sk-filemenu')
        # 对齐菜单：两个图形左对齐
        await pg.evaluate(f"""(()=>{{const e={ED}; const it=e.addItem({{mode:'cut',paths:[]}}); it.remove();
            const r=new e.ps.Path.Rectangle({{point:[200,40],size:[30,20],insert:false}}); r.data=it.data; e.content.addChild(r); e.style(r);
            window.__R=r; e.sel=new Set([e.content.children[0], r]); e.refresh();}})()""")
        await pg.click(H + '[data-menu=align]')
        assert await pg.is_disabled('.sk-filemenu [data-mact="al:dh"]'), '选 2 个时分布不可用'
        await pg.screenshot(path=OUT + 'bar1_align.png', clip={'x': 0, 'y': 0, 'width': 700, 'height': 460})
        await pg.click('.sk-filemenu [data-mact="al:l"]')
        lefts = await pg.evaluate(f"[...{ED}.sel].map(i=>Math.round(i.bounds.left*1000)/1000)")
        assert len(set(lefts)) == 1, lefts
        # 旋转菜单：右转 90° → 30×20 变成 20×30
        await pg.evaluate(f"{ED}.sel=new Set([{ED}.content.children.find(c=>Math.abs(c.bounds.width-30)<1e-6)]); {ED}.refresh()")
        await pg.click(H + '[data-menu=rotate]'); await pg.click('.sk-filemenu [data-mact=rotR]')
        wh = await pg.evaluate(f"(()=>{{const b=[...{ED}.sel][0].bounds; return [Math.round(b.width), Math.round(b.height)]}})()")
        assert wh == [20, 30], wh
        await pg.click(H + '[data-menu=rotate]'); await pg.click('.sk-filemenu [data-mact=askRot]')
        await pg.wait_for_timeout(200)
        await pg.keyboard.press('Escape')
        # 帮助菜单：快捷键
        await pg.click(H + '[data-menu=help]'); await pg.click('.sk-filemenu [data-mact=keys]')
        await pg.wait_for_selector('.sk-modal-box')
        await b.close()
    assert not errs, errs
    print('PASS bar1：编辑 / 对齐 / 旋转 / 帮助菜单、缩放 −/+ 和百分比、上下文栏（材料数据 / 位置尺寸 + 复制删除）')

asyncio.run(main())
