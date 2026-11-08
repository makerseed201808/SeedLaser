"""C8 改槽宽：导入一张 3 mm 槽的 SVG（轮廓上 2 个 U 形缺口、板里 1 个 3 × 20 长孔、底边 1 个 3 mm 凸齿、10 × 10 方孔、圆孔）
→ 全选 →「查找」标出 3 个槽 →「改槽宽」3 → 4：缺口和长孔都变 4 mm、槽中线不动；凸齿、方孔、圆孔、外形尺寸都不动；一步撤销。带断言。"""
import asyncio, json
from _kit import run, ED

SVG = '''<svg xmlns="http://www.w3.org/2000/svg" width="120mm" height="80mm" viewBox="0 0 120 80">
<path d="M10,10 H40 V20 H43 V10 H70 V20 H73 V10 H110 V70 H58 V75 H55 V70 H10 Z"/>
<rect x="50" y="35" width="3" height="20"/><rect x="20" y="40" width="10" height="10"/><circle cx="90" cy="45" r="5"/></svg>'''
# 在画板坐标（y 向上）里量：所有闭合切割图形的外框 + 轮廓上的缺口 / 凸齿
MEASURE = f"""(()=>{{const e={ED}; const its=e.content.children.filter(c=>c.data&&c.data.mode==='cut');
  const out=its.map(c=>{{const b=c.bounds; return {{w:Math.round(b.width*1000)/1000, h:Math.round(b.height*1000)/1000, cx:Math.round(b.center.x*1000)/1000, n:e.itemPaths(c)[0].segments.length}};}});
  const ol=its.reduce((a,c)=>a&&a.bounds.area>c.bounds.area?a:c,null); const p=e.itemPaths(ol)[0]; const B=ol.bounds;
  const top=p.segments.map(s=>s.point).filter(q=>Math.abs(q.y-(B.bottom-10))<1e-3||Math.abs(q.y-(B.bottom-10)-0)<1e-3);
  return {{items:out, B:[B.left,B.top,B.width,B.height].map(v=>Math.round(v*1000)/1000), xs:p.segments.map(s=>Math.round((s.point.x-B.left)*1000)/1000), ys:p.segments.map(s=>Math.round((s.point.y-B.top)*1000)/1000)}};}})()"""


async def body(k, case):
    pg = k.pg
    await k.ev(f"(async()=>{{ const f=new File([{json.dumps(SVG)}], 'slots.svg'); await {ED}.importFile(f); }})()"); await pg.wait_for_timeout(400)
    o = await pg.query_selector('[data-v=orig]')                      # 导入对话框：按原尺寸
    if o:
        await o.click()
    btn = await pg.query_selector('#sk-host [data-m=ok], [data-m=ok]')
    if btn:
        await btn.click()
    await pg.wait_for_timeout(600)
    await k.ev(f"(()=>{{const e={ED}; e.sel=new Set(e.content.children.filter(c=>c.data&&c.data.mode)); e.refresh();}})()")
    before = await k.ev(MEASURE)

    async def find():
        await k.ev(f"(()=>{{const e={ED}; e.$$('.sk-side [data-key=t-slot]').forEach(c=>e.setCollapsed(c,false));}})()")
        assert await pg.is_visible('#sk-host [data-act=slotFind]'), '变换面板里要有「改槽宽」'
        await pg.fill('#sk-host [data-opt=slotFrom]', '3'); await pg.press('#sk-host [data-opt=slotFrom]', 'Tab')
        await pg.fill('#sk-host [data-opt=slotTo]', '4'); await pg.press('#sk-host [data-opt=slotTo]', 'Tab')
        await pg.click('#sk-host [data-act=slotFind]'); await pg.wait_for_timeout(200)
        info = await pg.inner_text('#sk-host .sk-slot-info')
        assert '找到 3 个' in info and '2 个缺口、1 个孔' in info, info
        assert await k.ev(f"{ED}.slotLayer.children.length") == 3, '标出 3 个'
    await case('查找：标出 2 个缺口 + 1 个长孔（凸齿和方孔不算）', find())

    async def apply():
        await pg.click('#sk-host [data-act=slotApply]'); await pg.wait_for_timeout(300)
        after = await k.ev(MEASURE)
        assert '已把 3 个槽从 3 mm 改成 4 mm' in await k.status(), await k.status()
        assert after['B'][2:] == before['B'][2:], ('外形尺寸不动', before['B'], after['B'])
        assert await k.ev(f"(()=>{{const e={ED}; return [e.findSlots([...e.sel],4,0.01).length, e.findSlots([...e.sel],3,0.15).length];}})()") == [3, 0], '全部变成 4 mm'
        # 缺口：原来 x = 30..33、60..63（相对板左边）→ 29.5..33.5、59.5..63.5（中线不动）
        xs = sorted(set(after['xs']))
        for v in (29.5, 33.5, 59.5, 63.5):
            assert v in xs, (v, xs)
        for v in (30, 33, 60, 63):
            assert v not in xs, (v, xs)
        # 底边凸齿 45..48 不动
        assert 45 in xs and 48 in xs, xs
        hole = [x for x in after['items'] if x['n'] == 4 and x['h'] == 20][0]
        assert hole['w'] == 4 and hole['cx'] == [x for x in before['items'] if x['n'] == 4 and x['h'] == 20][0]['cx'], ('长孔 3 → 4、中线不动', hole)
        small = sorted((x['w'], x['h'], x['cx']) for x in after['items'] if x['w'] == 10 and x['h'] == 10)
        assert small == sorted((x['w'], x['h'], x['cx']) for x in before['items'] if x['w'] == 10 and x['h'] == 10) and len(small) == 2, ('方孔、圆孔不动', small)
    await case('改槽宽 3 → 4：缺口和长孔变 4、中线不动；外形、凸齿、方孔、圆孔不动', apply())

    async def undo():
        await k.ev(f"{ED}.undo()"); await pg.wait_for_timeout(150)
        assert await k.ev(MEASURE) == before, '一步撤销回原样'
    await case('一步撤销回原样', undo())


asyncio.run(run(body, 'slot1')) and print('PASS slot1：导入 3 mm 槽的 SVG → 查找标出 3 个 → 改成 4 mm：槽全变 4、中线不动，别的边不动；一步撤销')
