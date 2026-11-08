"""在顶部标签上直接改项目名称：点当前标签的名字 → 输入回车 → 保存（不弹框）；双击改名 = 原地改名；Esc 取消；画板里不再有名称块。带断言。
调试服务器需要用 SEEDLASER_PROJECT_DIR=/tmp/sl-proj 启动（run.sh 会设置）。"""
import asyncio, os
from playwright.async_api import async_playwright

ED = 'window.__seedDebug.sketchEd'
DIR = os.environ.get('SEEDLASER_PROJECT_DIR', '/tmp/sl-proj')


async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(); pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)'); await pg.wait_for_timeout(1800)
        label = lambda: pg.inner_text('#doc-tabs .dt-tab.on .dt-name')
        TAB = '#doc-tabs .dt-tab.on .dt-name'
        name = f'测试小船{os.getpid()}'
        f1 = os.path.join(DIR, name + '.seedlaser')
        assert not await pg.is_visible('#sk-host .sk-proj'), '画板里不再显示项目名称块'
        # Esc 取消：什么都不存
        await pg.click(TAB); await pg.keyboard.type('不要保存'); await pg.keyboard.press('Escape')
        assert not os.path.exists(os.path.join(DIR, '不要保存.seedlaser')) and await label() == '未命名设计'
        # 输入名字回车 → 保存到项目文件夹
        await pg.click(TAB)
        assert await pg.input_value('#doc-tabs .dt-input') == ''
        await pg.keyboard.type(name); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(800)
        assert os.path.exists(f1), os.listdir(DIR) if os.path.isdir(DIR) else 'no dir'
        await pg.wait_for_timeout(300)
        assert await label() == name, await label()
        # 输入框里按快捷键（比如 v / Delete）不应触发画板命令
        n = await pg.evaluate(f"{ED}.content.children.length")
        await pg.dblclick('#doc-tabs .dt-tab.on'); await pg.keyboard.press('End'); await pg.keyboard.type('号')
        await pg.keyboard.press('Backspace'); await pg.keyboard.type('2号'); await pg.keyboard.press('Enter'); await pg.wait_for_timeout(800)
        assert await pg.evaluate(f"{ED}.content.children.length") == n
        f2 = os.path.join(DIR, name + '2号.seedlaser')
        assert os.path.exists(f2) and not os.path.exists(f1), os.listdir(DIR)
        assert await label() == name + '2号'
        await b.close()
    assert not errs, errs
    print('PASS rename1：标签上输入名字回车保存到项目文件夹；再改名 = 原地改名（旧文件去掉）；Esc 取消；输入时不触发画板快捷键')

asyncio.run(main())
