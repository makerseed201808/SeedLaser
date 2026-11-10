"""新建设计是空白的（2026-11-10 用户反馈）：把空白设计从头走一遍——
二维画板没有图形、标签上没有「未保存」圆点；去 3D 装配再回来仍然没有圆点（没改动不算改动）；3D 里提示「画板上还没有板件」；
加工作业清单 0 块；导出时直接提示没有可导出的板件（不弹补偿方式、不写空文件）；保存再打开仍是空的；
画一块矩形后才出现圆点，导出恢复正常。带断言。"""
import asyncio, json, os, tempfile
from _kit import run, ED

D = 'window.__seedDebug'
TMP = tempfile.mkdtemp(prefix='seedlaser-blank1-')
DOT = "!!document.querySelector('#doc-tabs .dt-tab.on .dt-dot')"
TOAST = "(()=>{const t=document.querySelector('#toast'); return t && !t.classList.contains('hidden') ? t.textContent : '';})()"


async def body(k, case):
    pg = k.pg

    async def fresh():
        await k.open(clear=False)
        await pg.wait_for_timeout(1800)                       # 等「干净状态」记下来
        assert await k.ev(f"{ED}.content.children.filter(c=>c.data&&c.data.mode).length") == 0
        assert await k.ev(f"({D}.W.project.free.parts || []).length") == 0
        chips = await pg.inner_text('#sk-host .sk-ctx-idle')
        assert '0 块' in chips and '0 个' in chips, chips
        assert not await pg.evaluate(DOT), '新建的空白设计不应显示「未保存」'
    await case('新建设计：画板上没有图形、板件 0 块、标签没有未保存圆点', fresh())

    async def stages():
        await pg.click('.sk-back'); await pg.wait_for_timeout(3000)
        note = await pg.inner_text('#view3d-note')
        assert '画板上还没有板件' in note and '生成器' not in note, note
        assert not await pg.evaluate(DOT), '只是去 3D 看一眼，不算改动'
        await pg.click('#stage-bar [data-stage=make]'); await pg.wait_for_timeout(2000)
        assert '0 块' in await pg.inner_text('#make-panel'), await pg.inner_text('#make-panel')
        await pg.click('#stage-bar [data-stage=design]'); await pg.wait_for_timeout(2000)
        assert not await pg.evaluate(DOT), '三个板块走一圈，仍然没有改动'
    await case('3D 装配提示「画板上还没有板件」；加工清单 0 块；走一圈回来仍不算改动', stages())

    async def export_empty():
        path = os.path.join(TMP, 'empty.svg')
        await pg.evaluate(f"window.pywebview.api.dev_set_pick({json.dumps(path)})")
        await pg.evaluate("void window.SeedApp.file('export', 'svg')"); await pg.wait_for_timeout(800)
        assert not await pg.query_selector('.burn-ask'), '空白设计导出不应先问补偿方式'
        assert '还没有可以导出的板件' in await pg.evaluate(TOAST), await pg.evaluate(TOAST)
        await pg.wait_for_timeout(1200)
        assert not os.path.exists(path), '不应写出空文件'
    await case('空白设计导出：直接说明没有板件，不弹补偿方式、不写空文件', export_empty())

    async def save_open():
        path = os.path.join(TMP, '空白.seedlaser')
        await pg.evaluate(f"window.pywebview.api.dev_set_pick({json.dumps(path)})")
        await pg.evaluate("window.SeedApp.file('saveas')"); await pg.wait_for_timeout(1200)
        data = json.load(open(path, encoding='utf-8'))
        assert (data.get('free') or {}).get('parts') == [] and not data.get('sketches'), data.get('free')
        await pg.evaluate(f"void window.SeedApp.file('openPath', {json.dumps(path)})"); await pg.wait_for_timeout(2500)
        assert await k.ev(f"{ED}.content.children.filter(c=>c.data&&c.data.mode).length") == 0, '保存再打开仍是空白（不会又冒出一块矩形）'
    await case('空白设计保存再打开：仍是空白', save_open())

    async def draw():
        await k.add('cut', [[20, 20], [120, 20], [120, 80], [20, 80]]); await pg.wait_for_timeout(1500)
        assert await pg.evaluate(DOT), '画了图形才算有改动'
        assert await k.ev(f"({D}.W.project.free.parts || []).length") == 1
        path = os.path.join(TMP, 'one.svg')
        await pg.evaluate(f"window.pywebview.api.dev_set_pick({json.dumps(path)})")
        await pg.evaluate("void window.SeedApp.file('export', 'svg')")
        await pg.wait_for_selector('.burn-ask'); await pg.click('.burn-ask [data-r=comp]'); await pg.wait_for_timeout(2500)
        assert os.path.getsize(path) > 500 and '<path' in open(path, encoding='utf-8').read()
    await case('画一块矩形后：出现未保存圆点、识别成 1 块板、导出正常', draw())


asyncio.run(run(body, 'blank1')) and print('PASS blank1：空白设计从二维到 3D、加工、导出、保存 / 打开全程：没有自动矩形、没有误报的未保存、提示说人话、不写空文件')
