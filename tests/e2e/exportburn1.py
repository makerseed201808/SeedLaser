"""导出图纸前选尺寸：「已补偿」文件里外轮廓 = 画的尺寸 + 2 × 激光补偿；「原尺寸」= 画的尺寸；取消不导出。
用 DXF 读回来量（需要 ezdxf），也检查导出里没有材料边框 / 校准尺。带断言。"""
import asyncio, json, os, tempfile
from _kit import run, ED

TMP = tempfile.mkdtemp(prefix='seedlaser-burn-')


async def body(k, case):
    pg = k.pg
    pick = lambda path: pg.evaluate(f"window.pywebview.api.dev_set_pick({json.dumps(path)})")
    await k.add('cut', [[50, 50], [150, 50], [150, 110], [50, 110]])          # 100 × 60 的板
    await pg.wait_for_timeout(500)
    burn = float(await pg.evaluate("document.querySelector('#param-form [name=burn]') ? document.querySelector('#param-form [name=burn]').value : 0.1"))

    def size(path):
        import ezdxf
        doc = ezdxf.readfile(path)
        es = list(doc.modelspace())
        assert all(e.dxf.layer != 'NOTE' and e.dxftype() != 'TEXT' for e in es), '导出里不应有边框 / 文字'
        outs = [e for e in es if e.dxf.layer == 'CUT_OUTER']
        assert len(outs) == 1, [e.dxf.layer for e in es]                      # 没有 100 mm 校准尺
        xs = [v.dxf.location[0] for v in outs[0].vertices]; ys = [v.dxf.location[1] for v in outs[0].vertices]
        return round(max(xs) - min(xs), 3), round(max(ys) - min(ys), 3)

    async def export(name, choice):
        path = os.path.join(TMP, name)
        await pick(path)
        await pg.evaluate("void window.SeedApp.file('export', 'dxf')")
        await pg.wait_for_selector('.burn-ask', timeout=5000)
        await pg.click(f'.burn-ask [data-r={choice}]')
        await pg.wait_for_timeout(2500)
        return path

    async def comp():
        p = await export('comp.dxf', 'comp')
        assert os.path.exists(p)
        w, h = size(p)
        assert abs(w - (100 + 2 * burn)) < 0.005 and abs(h - (60 + 2 * burn)) < 0.005, (w, h, burn)
    await case('已补偿：100 × 60 的板导出为 (100 + 2 × 补偿) × (60 + 2 × 补偿)', comp())

    async def nominal():
        p = await export('nominal.dxf', 'nominal')
        w, h = size(p)
        assert abs(w - 100) < 0.005 and abs(h - 60) < 0.005, (w, h)
        assert await pg.evaluate("document.querySelector('#param-form [name=burn]') ? document.querySelector('#param-form [name=burn]').value : '0.1'") != '0', '原尺寸导出不应改掉激光补偿设置'
    await case('原尺寸：导出正好 100.00 × 60.00（补偿交给激光软件），设置里的补偿不变', nominal())

    async def cancel():
        p = await export('cancel.dxf', 'cancel')
        assert not os.path.exists(p), '取消不应导出'
    await case('取消：不导出', cancel())

    async def remember():
        on = await pg.evaluate("(async()=>{ window.SeedApp.file('export','dxf'); await new Promise(r=>setTimeout(r,400)); const on=document.querySelector('.burn-ask .opt.on'); const r=on&&on.dataset.r; document.querySelector('.burn-ask [data-r=cancel]').click(); return r; })()")
        assert on == 'nominal', ('应记住上次选的「原尺寸」', on)
    await case('记住上次的选择（高亮）', remember())


asyncio.run(run(body, 'exportburn1')) and print('PASS exportburn1：导出前选「已补偿 / 原尺寸」，DXF 尺寸分别是 100.2 × 60.2 和 100 × 60；取消不导出；记住上次选择；没有边框 / 校准尺')
