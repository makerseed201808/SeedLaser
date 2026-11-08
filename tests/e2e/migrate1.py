"""在界面里打开旧作品样本（tests/fixtures/projects）：自由设计的板件、图形、板外的线都在，3D 装配无穿透；
SeedBoxes 时期的快速建模项目打开到模型页、参数带回来。带断言。"""
import asyncio, json, os, shutil, tempfile
from playwright.async_api import async_playwright

ROOT = os.path.join(os.path.dirname(__file__), '..', '..')
FIX = os.path.join(ROOT, 'tests', 'fixtures', 'projects')
D = 'window.__seedDebug'
ED = D + '.sketchEd'


async def main():
    tmp = tempfile.mkdtemp(prefix='sl-migrate-')
    for n in os.listdir(FIX):
        shutil.copy(os.path.join(FIX, n), tmp)
    free = json.load(open(os.path.join(FIX, 'free_v020.seedbox.json'), encoding='utf-8'))
    n_items = sum(len(v['items']) for v in free['sketches'].values()) + len(free['free'].get('loose') or [])
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        errs = []; pg.on('pageerror', lambda e: errs.append(str(e)))
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1')
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        pick = lambda path: pg.evaluate(f"window.pywebview.api.dev_set_pick({json.dumps(path)})")
        # v0.2.0 自由设计
        await pick(os.path.join(tmp, 'free_v020.seedbox.json')); await pg.click('#home-open')
        await pg.wait_for_selector('#sk-host:not(.hidden)', timeout=40000); await pg.wait_for_timeout(2500)
        assert await pg.evaluate(f"{ED}.content.children.length") == n_items, (await pg.evaluate(f"{ED}.content.children.length"), n_items)
        assert await pg.evaluate(f"{ED}.recognizeParts().parts.length") == len(free['free']['parts'])
        assert await pg.evaluate(f"{ED}.recognizeParts().loose.length") == len(free['free']['loose'])
        assert await pg.inner_text('#sk-host .sk-file') == 'free_v020'
        await pg.click('#sk-host .sk-back'); await pg.wait_for_timeout(7000)
        rep = json.loads(await pg.evaluate(f"JSON.stringify({D}.W.pose.report || {{}})"))
        assert rep and not any(v['collide'] for v in rep.values()), rep
        # SeedBoxes 时期的快速建模项目（新标签）
        await pick(os.path.join(tmp, 'seedboxes_era.seedbox.json'))
        await pg.click('#doc-tabs .dt-home'); await pg.click('#home-open'); await pg.wait_for_timeout(3500)
        old = json.load(open(os.path.join(FIX, 'seedboxes_era.seedbox.json'), encoding='utf-8'))
        params = await pg.evaluate("window.SeedApp.collectParams()")
        same = [k for k, v in old['params'].items() if str(params.get(k)) == str(v)]
        assert len(same) == len(old['params']), [k for k in old['params'] if k not in same]
        assert await pg.evaluate("document.querySelectorAll('#doc-tabs .dt-tab').length") == 2
        await b.close()
    assert not errs, errs
    print(f'PASS migrate1：v0.2.0 自由设计打开后 {n_items} 个图形 / {len(free["free"]["parts"])} 块板 / 板外线都在、3D 无穿透；SeedBoxes 时期项目参数全部带回、开在新标签')

asyncio.run(main())
