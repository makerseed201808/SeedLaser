"""C1 自动排版：6 块大小不同的板（有重叠、有超出材料、一块带孔和雕刻）+ 1 条板外的线 → 上下文栏「自动排版」→
全部在材料内、两两不重叠、间距 ≥ 3 mm、孔跟着板走、板外的线不动；一步撤销回原样；编辑菜单里也有；材料放不下时提示。带断言。"""
import asyncio
from _kit import run, ED

SQ = lambda x, y, w, h: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]
K = 0.5522847498
circle = lambda cx, cy, r: [[cx + r, cy, 0, -K * r, 0, K * r], [cx, cy + r, K * r, 0, -K * r, 0], [cx - r, cy, 0, K * r, 0, -K * r], [cx, cy - r, -K * r, 0, K * r, 0]]
PARTS = f"""(()=>{{const e={ED}; const {{parts, loose}}=e.recognizeParts();
  return {{parts: parts.map(p=>{{let b=null; p.members.forEach(m=>{{b=b?b.unite(m.bounds):m.bounds.clone();}}); return {{pid:p.item.data.pid, n:p.members.length, b:[b.left,b.top,b.right,b.bottom].map(v=>Math.round(v*1000)/1000)}};}}),
    loose: loose.map(it=>it.bounds.center.x+','+it.bounds.center.y)}};}})()"""


def overlap(a, b):
    return not (a[2] <= b[0] or b[2] <= a[0] or a[3] <= b[1] or b[3] <= a[1])


def gap(a, b):
    dx = max(a[0] - b[2], b[0] - a[2], 0); dy = max(a[1] - b[3], b[1] - a[3], 0)
    return max(dx, dy)


async def body(k, case):
    pg = k.pg
    sheet = await k.ev(f"{ED}.part.sheet")
    W, H = sheet['w'], sheet['h']
    await k.add('cut', SQ(10, 10, 120, 80))                     # 1：带孔 + 雕刻
    await k.add('cut', circle(40, 50, 8))
    await k.add('engrave', SQ(70, 30, 30, 15))
    await k.add('cut', SQ(60, 40, 90, 60))                      # 2：和 1 重叠
    await k.add('cut', SQ(W - 40, H - 40, 100, 70))             # 3：超出材料
    await k.add('cut', SQ(200, 20, 150, 30))                    # 4
    await k.add('cut', SQ(200, 100, 60, 60))                    # 5
    await k.add('cut', SQ(300, 150, 50, 120))                   # 6
    await k.add('score', [[-60, 100], [-20, 140]], closed=False)  # 板外的线（材料左边）
    await pg.wait_for_timeout(300)
    before = await k.ev(PARTS)
    assert len(before['parts']) == 6 and len(before['loose']) == 1, before
    assert any(overlap(a['b'], b['b']) for a in before['parts'] for b in before['parts'] if a is not b), '测试前应有重叠'
    hole_part = [p for p in before['parts'] if p['n'] == 3][0]
    snap0 = await k.ev(f"JSON.stringify({ED}.serialize().items)")

    async def run_layout():
        n0 = len(await k.ev(f"{ED}.undoStack"))
        await pg.click('#sk-host [data-act=autoLayout]'); await pg.wait_for_timeout(1500)
        after = await k.ev(PARTS)
        assert len(await k.ev(f"{ED}.undoStack")) == n0 + 1, '只算一步撤销'
        for p in after['parts']:
            b = p['b']
            assert b[0] >= -1e-6 and b[1] >= -1e-6 and b[2] <= W + 1e-6 and b[3] <= H + 1e-6, ('应全部在材料内', b)
        for a in after['parts']:
            for b in after['parts']:
                if a is b:
                    continue
                assert not overlap(a['b'], b['b']), ('不应重叠', a, b)
                assert gap(a['b'], b['b']) >= 3 - 1e-6, ('间距 ≥ 3 mm', a, b, gap(a['b'], b['b']))
        hp = [p for p in after['parts'] if p['pid'] == hole_part['pid']][0]
        assert hp['n'] == 3, ('孔和雕刻要跟着板走', hp)
        # 孔仍在板内：圆孔中心相对板左上角的位置不变（没旋转时）
        assert after['loose'] == before['loose'], ('板外的线不应动', before['loose'], after['loose'])
        assert '已自动排版 6 块板' in await k.status(), await k.status()
    await case('自动排版：6 块板全部在材料内、互不重叠、间距 ≥ 3 mm；孔跟着板；板外的线不动；一步撤销', run_layout())

    async def undo():
        await k.ev(f"{ED}.undo()"); await pg.wait_for_timeout(200)
        assert await k.ev(f"JSON.stringify({ED}.serialize().items)") == snap0, '撤销后应和排版前一模一样'
    await case('撤销后回到排版前', undo())

    async def menu():
        await pg.click('#sk-host [data-menu=edit]'); await pg.wait_for_timeout(200)
        assert await pg.is_visible('#sk-host .sk-filemenu [data-mact=autoLayout]'), '编辑菜单里应有自动排版'
        await pg.click('#sk-host .sk-filemenu [data-mact=autoLayout]'); await pg.wait_for_timeout(1500)
        after = await k.ev(PARTS)
        assert all(p['b'][2] <= W + 1e-6 for p in after['parts']), after
    await case('编辑菜单里也能自动排版', menu())

    async def too_big():
        await k.ev(f"(()=>{{const e={ED}; e.part.sheet={{w:150,h:120}}; e.renderBoardInfo(); e.refresh();}})()")
        await pg.click('#sk-host [data-act=autoLayout]'); await pg.wait_for_timeout(1500)
        st = await k.status()
        assert '放不下' in st or '比材料还大' in st, ('材料太小时要提示', st)
    await case('材料太小：提示放不下 / 比材料还大，不报错', too_big())


asyncio.run(run(body, 'layout1')) and print('PASS layout1：自动排版把 6 块板（含重叠、超出）排进材料、互不重叠、间距 ≥ 3、孔跟着走、板外线不动、一步撤销；编辑菜单可用；材料太小有提示')
