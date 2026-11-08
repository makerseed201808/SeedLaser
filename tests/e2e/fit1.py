"""卡榫测试样：生成 → 取草图 → 用后端按补偿算出实际切割线，检查每条槽 / 方块的尺寸（带断言）。

期望（补偿 b0 时，切割线 = 名义 ± b0）：
  槽宽 = t0 + c − 2·b0；外方 = 40 + 2·b0；内孔 = 20 − 2·b0
"""
import asyncio, json, os, sys
from playwright.async_api import async_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
sys.path.insert(0, ROOT)
import sketch2d  # noqa: E402

OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
T0, B0 = 3.0, 0.1
STEPS = [-0.10, -0.05, 0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30]


def bbox(pts):
    xs = [p[0] for p in pts]; ys = [p[1] for p in pts]
    return min(xs), min(ys), max(xs), max(ys)


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
        await pg.click('.sk-back'); await pg.wait_for_timeout(3000)
        await pg.click('#stage-bar [data-stage=make]'); await pg.wait_for_timeout(2000)   # 卡榫测试样在「③ 加工作业」里
        await pg.evaluate("document.querySelector('#make-panel [data-k=fit]').click()"); await pg.wait_for_selector('#fit-modal:not(.hidden)')
        await pg.screenshot(path=OUT + 'fit_dialog.png')
        await pg.evaluate(f"window.__seedDebug.generateFitTest({T0}, {B0})")
        await pg.wait_for_timeout(2500)
        pr = json.loads(await pg.evaluate("JSON.stringify(window.SeedWorkshop.getProject())"))
        names = {q['id']: q['name'] for q in pr['free']['parts']}
        sk = {names[k]: v for k, v in pr['sketches'].items() if k in names}
        # 填测量结果 → 计算显示
        await pg.evaluate("document.querySelector('#make-panel [data-k=fit]').click()"); await pg.wait_for_selector('#fit-modal:not(.hidden)')
        await pg.fill('[data-f=tReal]', '2.85'); await pg.fill('[data-f=outer]', '39.9'); await pg.fill('[data-f=inner]', '20.1')
        await pg.select_option('[data-f=best]', '0.05')
        out = await pg.inner_text('.fit-out')
        await pg.screenshot(path=OUT + 'fit_result.png')
        await pg.click('[data-f=apply]'); await pg.wait_for_timeout(800)
        burn_after = await pg.evaluate("document.querySelector('#param-form [name=burn]').value")
        play_after = await pg.evaluate("localStorage.getItem('seedboxes.jointPlay')")
        await b.close()
    assert not errs, errs
    ladder = sk['测试样 · 插槽阶梯']; square = [v for k, v in sk.items() if k.startswith('测试样 · 测量方块')][0]
    holes = sorted((bbox(pts) for pts, closed, outer in sketch2d.cut_polylines(ladder, B0) if not outer), key=lambda q: q[0])
    assert len(holes) == 9, len(holes)
    for c, h in zip(STEPS, holes):
        w = h[2] - h[0]
        assert abs(w - (T0 + c - 2 * B0)) < 1e-3, (c, w)
    sq = sketch2d.cut_polylines(square, B0)
    o = [bbox(pts) for pts, _, outer in sq if outer][0]; i = [bbox(pts) for pts, _, outer in sq if not outer][0]
    assert abs((o[2] - o[0]) - (40 + 2 * B0)) < 1e-3 and abs((i[2] - i[0]) - (20 - 2 * B0)) < 1e-3, (o, i)
    assert '0.15' in out and '0.3' in out, out           # 补偿 0.15、间隙 0.3（见 tests/js/fit_calc.test.mjs）
    assert burn_after == '0.15' and play_after == '0.3', (burn_after, play_after)
    print('PASS fit1：9 条槽宽、外方 / 内孔尺寸、换算与应用全部正确')

asyncio.run(main())
