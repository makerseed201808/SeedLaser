"""A6 工具测试共用：打开空白画板、mm ↔ 屏幕坐标、读图形、真实鼠标操作。"""
import os
from playwright.async_api import async_playwright

URL = os.environ.get('SEEDBOXES_URL', 'http://127.0.0.1:8765') + '/index.html?dev=1'
OUT = os.environ.get('E2E_OUT', '/tmp/seedboxes-e2e/')
D = 'window.__seedDebug'
ED = D + '.sketchEd'

# 编辑器里所有用户图形：[{id, mode, closed[], n(节点数), bounds[l,t,r,b], area, text?, joints, bridges}]
ITEMS = f"""(()=>{{const e={ED};
  return e.content.children.filter(c=>c.data&&c.data.mode).map(c=>{{const ps=(c.className==='CompoundPath'?c.children:[c]);
    const b=c.bounds; return {{id:c.data.id, mode:c.data.mode, cls:c.className, closed:ps.map(p=>p.closed), n:ps.reduce((a,p)=>a+p.segments.length,0),
      bounds:[b.left,b.top,b.right,b.bottom].map(v=>Math.round(v*1000)/1000), area:Math.round(Math.abs(c.area||0)*1000)/1000,
      text:c.data.text?c.data.text.text:null, joints:(c.data.joints||[]).length, bridges:(c.data.bridges||[]).length, group:c.data.group||null}};}});}})()"""


# 以前新建设计会自动带一块 100 × 60 的矩形板（在画板 (10, 230)），老测试直接拿它来用。
# 2026-11-10 起新建设计是空白的：需要那块板的测试自己明确画一块（画板上已有图形时不重复画）。
SEED_RECT = f"""(()=>{{const e={ED}; if (!e || !e.content) return null; if (e.content.children.some(c=>c.data&&c.data.mode)) return false;
  e.addItem({{mode:'cut', paths:[{{closed:true, segs:[[10,230,0,0,0,0],[110,230,0,0,0,0],[110,290,0,0,0,0],[10,290,0,0,0,0]]}}]}});
  e.sel.clear(); e.commit('测试用的矩形板'); return true;}})()"""


async def seed_rect(pg):
    """等二维画板打开后，放一块 100 × 60 的矩形板（等同于以前自动带的那块）。"""
    await pg.wait_for_selector('#sk-host:not(.hidden)', timeout=30000)
    for _ in range(40):
        if await pg.evaluate(SEED_RECT) is not None:
            break
        await pg.wait_for_timeout(100)
    await pg.wait_for_timeout(1300)          # 等板件识别和右下角 3D 预览跟上（原来打开时就有）


class Kit:
    def __init__(self, pg):
        self.pg = pg
        self.errs = []
        pg.on('pageerror', lambda e: self.errs.append(str(e)))

    async def open(self, clear=True):
        pg = self.pg
        await pg.add_init_script("localStorage.setItem('seedboxes.skTour','1')")
        await pg.goto(URL)
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)'); await pg.wait_for_timeout(1200)
        if clear:
            await pg.evaluate(f"(()=>{{const e={ED}; e.content.children.slice().forEach(c=>{{ if (c.data && c.data.mode) c.remove(); }}); e.sel.clear(); e.commit('清空');}})()")
        await pg.evaluate(f"{ED}.fit(true)")
        await pg.wait_for_timeout(300)

    async def scr(self, x, y):
        return await self.pg.evaluate(f"""(()=>{{const e={ED}; const q=e.ps.view.projectToView(new e.ps.Point({x},{y})); const r=e.ps.view.element.getBoundingClientRect(); return [r.left+q.x, r.top+q.y];}})()""")

    async def items(self):
        return await self.pg.evaluate(ITEMS)

    async def tool(self, key):
        await self.pg.keyboard.press('Escape')
        await self.pg.evaluate(f"{ED}.setTool({key!r})")
        await self.pg.wait_for_timeout(100)

    async def click(self, x, y, button='left', dbl=False):
        sx, sy = await self.scr(x, y)
        await self.pg.mouse.move(sx, sy)
        if dbl:
            await self.pg.mouse.dblclick(sx, sy)
        else:
            await self.pg.mouse.click(sx, sy, button=button)
        await self.pg.wait_for_timeout(120)

    async def drag(self, a, b, steps=8, mods=()):
        ax, ay = await self.scr(*a)
        bx, by = await self.scr(*b)
        for m in mods:
            await self.pg.keyboard.down(m)
        await self.pg.mouse.move(ax, ay); await self.pg.mouse.down()
        await self.pg.mouse.move(bx, by, steps=steps)
        await self.pg.mouse.up()
        for m in mods:
            await self.pg.keyboard.up(m)
        await self.pg.wait_for_timeout(200)

    async def status(self):
        return await self.pg.inner_text('#sk-host .sk-status')

    async def ev(self, js):
        return await self.pg.evaluate(js)

    async def add(self, mode, segs_list, closed=True):
        """直接放一个图形（不经过画图工具），返回 id。segs_list：[[x,y], ...] 或 [[x,y,ix,iy,ox,oy], ...]"""
        import json
        segs = [s if len(s) == 6 else [s[0], s[1], 0, 0, 0, 0] for s in segs_list]
        return await self.pg.evaluate(f"(()=>{{const e={ED}; const it=e.addItem({{mode:{json.dumps(mode)},paths:[{{closed:{'true' if closed else 'false'},segs:{json.dumps(segs)}}}]}}); e.commit('t'); return it.data.id;}})()")

    async def select(self, *ids):
        import json
        await self.pg.evaluate(f"(()=>{{const e={ED}; const ids={json.dumps(list(ids))}; e.sel=new Set(e.content.children.filter(c=>c.data&&ids.includes(c.data.id))); e.refresh();}})()")


async def run(fn, name):
    async with async_playwright() as p:
        b = await p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})
        k = Kit(pg)
        await k.open()
        fails = []

        async def case(title, coro):
            try:
                await coro
                print('ok', title)
            except AssertionError as e:
                fails.append(title)
                print('FAIL', title, '→', str(e)[:400])
            except Exception as e:      # noqa: BLE001
                fails.append(title)
                print('FAIL', title, '→', type(e).__name__, str(e)[:400])
        await fn(k, case)
        os.makedirs(OUT, exist_ok=True)
        await pg.screenshot(path=OUT + name + '.png')
        await b.close()
    assert not k.errs, k.errs
    assert not fails, f'{len(fails)} 项失败：{fails}'
    return True
