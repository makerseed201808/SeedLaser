"""选择 / 移动 / 缩放的手感：单击内部可选中；手抖单击不挪图形；尺寸标签不挡手柄、能拉边；缩放不跳；
没有生成零件时不显示「外轮廓锁定」按钮。带断言（放大到 20 像素/mm，和真机截图一样）。"""
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
        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)'); await pg.wait_for_timeout(600)
        assert await pg.evaluate("document.querySelector('.sk-lock').classList.contains('hidden')"), '自由设计不应显示外轮廓锁定按钮'
        await pg.evaluate(f"""(()=>{{const e={ED}; const ps=e.ps; e.content.removeChildren();
          const it=e.addItem({{mode:'cut',paths:[]}}); it.remove(); const r=new ps.Path.Rectangle({{point:[10.37,10.37],size:[44,23],insert:false}});
          r.data=it.data; e.content.addChild(r); e.style(r); window.__R=r; e.sel.clear(); e.setView(20,32,22); e.refresh();}})()""")
        await pg.wait_for_timeout(200)
        V = lambda x, y: pg.evaluate(f"(()=>{{const e={ED};const r=e.canvas.getBoundingClientRect();const v=e.ps.view.projectToView(new e.ps.Point({x},{y}));return [v.x+r.left,v.y+r.top]}})()")
        B = lambda: pg.evaluate("[__R.bounds.x,__R.bounds.y,__R.bounds.width,__R.bounds.height].map(v=>Math.round(v*1000)/1000)")
        sel = lambda: pg.evaluate(f"{ED}.sel.size")

        # 1 单击内部选中
        x, y = await V(30, 20); await pg.mouse.click(x, y)
        assert await sel() == 1, '单击图形内部应选中'
        # 2 手抖单击（1~2 像素）不挪动
        x, y = await V(30, 10.37); await pg.mouse.move(x, y); await pg.mouse.down(); await pg.mouse.move(x + 2, y + 1); await pg.mouse.up()
        assert await B() == [10.37, 10.37, 44, 23], await B()
        # 3 已选中：从内部拖动可以移动
        x, y = await V(30, 20); await pg.mouse.move(x, y); await pg.mouse.down(); await pg.mouse.move(x + 100, y, steps=8); await pg.mouse.up()
        bb = await B(); assert abs(bb[0] - 15.37) < 0.7 and bb[2] == 44, bb
        # 4 尺寸标签不挡手柄：拉右边中点手柄（鼠标偏 3 像素），宽度按鼠标位移变化，不跳
        bb = await B(); hx, hy = await V(bb[0] + bb[2], bb[1] + bb[3] / 2)
        el = await pg.evaluate(f"document.elementFromPoint({hx},{hy}).tagName")
        assert el == 'CANVAS', f'右边手柄被 {el} 挡住'
        await pg.mouse.move(hx + 3, hy + 2); await pg.mouse.down()
        await pg.mouse.move(hx + 4, hy + 2)                      # 1 像素：还没开始拖
        assert (await B())[2] == 44
        await pg.mouse.move(hx + 3 + 40, hy + 2, steps=6)        # 40 像素 = 2 mm
        await pg.mouse.up()
        w = (await B())[2]; assert abs(w - 46) < 0.6, w
        # 4b 光标：旋转手柄 = 旋转箭头，右边手柄 = 左右箭头，选中图形内部 = 移动
        cur = lambda: pg.evaluate(f"{ED}.canvas.style.cursor")
        bb = await B(); rx, ry = await pg.evaluate(f"(()=>{{const e={ED};const r=e.canvas.getBoundingClientRect();const h=e.handles.find(h=>h.kind==='rotate');const v=e.ps.view.projectToView(h.at);return [v.x+r.left,v.y+r.top]}})()")
        await pg.mouse.move(rx + 1, ry); c = await cur(); assert 'svg' in c, c
        hx, hy = await V(bb[0] + bb[2], bb[1] + bb[3] / 2); await pg.mouse.move(hx, hy); assert await cur() == 'ew-resize', await cur()
        x, y = await V(bb[0] + 10, bb[1] + 10); await pg.mouse.move(x, y); assert await cur() == 'move', await cur()
        # 5 单击空白取消选择；在内部拖动（未选中）= 框选，不移动
        await pg.mouse.click(*(await V(5, 5)))
        assert await sel() == 0
        before = await B()
        x, y = await V(20, 15); await pg.mouse.move(x, y); await pg.mouse.down(); await pg.mouse.move(x + 60, y - 60, steps=5); await pg.mouse.up()
        assert await B() == before
        await b.close()
    assert not errs, errs
    print('PASS precise1：单击内部选中；手抖不挪；内部拖动移动；手柄不被尺寸挡、缩放不跳；未选中内部拖 = 框选；隐藏外轮廓锁定；手柄光标（旋转箭头 / 双向箭头 / 移动）')

asyncio.run(main())
