"""C10 低优先级补全：
批量名牌从表格粘贴（Tab 分列、有表头）→ 每块名牌一个大字 + 每列一行小字，表头跳过；
四点变形：40 × 20 矩形拖右上角 +10 → 那个角到新位置、其它三个角不动；带文字时文字转成路径；
材料测试矩阵：4 行 × 5 列 → 20 个 10 mm 方块（雕刻）、10 个标签、外框把它们都包成一块板；
描摹前调节：灰色（150）图在阈值 128 下描不到 → 亮度 −40 后描到；对比度 +100 变白描不到、−100 变 128 描到；裁掉右边 50 % → 宽度减半；导入后宽高比跟着裁剪。带断言。"""
import asyncio
from _kit import run, ED

D = 'window.__seedDebug'
SQ = lambda x, y, w, h: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]


async def body(k, case):
    pg = k.pg

    async def clear():
        await k.ev(f"(()=>{{const e={ED}; e.content.children.slice().forEach(c=>{{ if (c.data && c.data.mode) c.remove(); }}); e.sel.clear(); e.commit('清空');}})()")

    async def warp():
        a = await k.add('cut', SQ(40, 40, 40, 20))
        await k.select(a)
        await k.ev(f"{ED}.act('warpStart')"); await pg.wait_for_timeout(150)
        assert await k.ev(f"!!{ED}.warp"), '进入变形'
        await k.drag((80, 60), (90, 60)); await pg.wait_for_timeout(150)
        assert await k.ev(f"{ED}.warp.dst[2]") == [90, 60], await k.ev(f"{ED}.warp.dst")
        await k.ev(f"{ED}.act('warpApply')"); await pg.wait_for_timeout(150)
        pts = await k.ev(f"(()=>{{const c={ED}.content.children.find(x=>x.data&&x.data.id==='{a}'); return c.segments.map(s=>[Math.round(s.point.x*1000)/1000, Math.round(s.point.y*1000)/1000]);}})()")
        assert sorted(pts) == sorted([[40, 40], [80, 40], [90, 60], [40, 60]]), pts
        assert '已四点变形 1 个图形' in await k.status(), await k.status()
        await k.ev(f"{ED}.undo()")
        tid = await k.ev(f"(async()=>{{const e={ED}; const it=await e.buildText({{text:'AB', font:e.opts.font, size:10, x:150, y:150, align:'center', lineHeight:1.25}}); e.sel=new Set([it]); e.commit('t'); return it.data.id;}})()"); await pg.wait_for_timeout(300)
        await k.ev(f"{ED}.act('warpStart')"); await pg.wait_for_timeout(100)
        await k.ev(f"(()=>{{const w={ED}.warp; w.dst[1][0]+=5; {ED}.act('warpApply');}})()"); await pg.wait_for_timeout(150)
        t = await k.ev(f"{ED}.content.children.filter(x=>x.data&&x.data.id==='{tid}').map(x=>!!x.data.text)")
        assert t == [False], ('文字变形后转成路径', t)
        await k.ev(f"{ED}.act('warpStart')"); await pg.keyboard.press('Escape'); await pg.wait_for_timeout(100)
        assert not await k.ev(f"!!{ED}.warp"), 'Esc 取消'
    await case('四点变形：拖一个角，另外三个不动；文字转成路径；Esc 取消', warp())

    async def matrix():
        await clear()
        await k.ev(f"{ED}.setTool('make')"); await pg.wait_for_timeout(150)
        await pg.click('#sk-host [data-mkind=test]'); await pg.wait_for_timeout(150)
        await pg.fill('#sk-host [data-mk="test.rows"]', '4'); await pg.press('#sk-host [data-mk="test.rows"]', 'Tab')
        await pg.fill('#sk-host [data-mk="test.cols"]', '5'); await pg.press('#sk-host [data-mk="test.cols"]', 'Tab')
        await pg.click('#sk-host [data-mkgo]'); await pg.wait_for_timeout(3000)
        r = await k.ev(f"""(()=>{{const e={ED}; const its=e.content.children.filter(c=>c.data&&c.data.mode);
          const sq=its.filter(c=>c.data.mode==='engrave'&&!c.data.text&&Math.abs(c.bounds.width-10)<1e-6&&Math.abs(c.bounds.height-10)<1e-6).length;
          const tx=its.filter(c=>c.data.text).map(c=>c.data.text.text); const rp=e.recognizeParts();
          return {{sq, tx, parts:rp.parts.length, loose:rp.loose.length}};}})()""")
        assert r['sq'] == 20 and len(r['tx']) == 10 and r['parts'] == 1 and r['loose'] == 0, r
        assert '20' in r['tx'] and '100' in r['tx'] and 'V\\P' in r['tx'], r['tx']
        assert '共 20 个方块' in await k.status(), await k.status()
    await case('材料测试矩阵 4 × 5：20 个方块、10 个标签、外框包成一块板', matrix())

    async def trace():
        await clear()
        await k.ev("""(async()=>{ const c=document.createElement('canvas'); c.width=200; c.height=100; const g=c.getContext('2d');
          g.fillStyle='#fff'; g.fillRect(0,0,200,100); g.fillStyle='rgb(150,150,150)'; g.fillRect(20,20,60,60);
          const img=new Image(); img.src=c.toDataURL(); await img.decode(); window.__img=img; })()""")
        await k.ev(f"{ED}.imageDialog('t.png', window.__img)"); await pg.wait_for_timeout(300)

        async def setv(key, val, evt='input'):
            await pg.evaluate(f"(()=>{{const el=document.querySelector('[data-v={key}]'); el.value={val}; el.dispatchEvent(new Event('{evt}'));}})()")
            await pg.wait_for_timeout(80)
            return await k.ev(f"{ED}.traceState()")
        s = await setv('thr', 128)
        assert s['rects'] == 0 and s['w'] == 200, ('灰 150 > 阈值 128：描不到', s)
        s = await setv('bright', -40)
        assert s['rects'] > 0, ('调暗后描到', s)
        await setv('bright', 0)
        s = await setv('contrast', 100)
        assert s['rects'] == 0, ('对比度拉满：灰变白', s)
        s = await setv('contrast', -100)
        assert s['rects'] > 0, ('对比度最低：全变 128 ≤ 阈值', s)
        await setv('contrast', 0); await setv('bright', -40)
        s = await setv('cr', 50, 'change')
        assert s['w'] == 100 and s['h'] == 100 and s['rects'] > 0, ('裁掉右边一半', s)
        await pg.evaluate("(()=>{const el=document.querySelector('[data-v=w]'); el.value=50;})()")
        await pg.click('[data-m=ok]'); await pg.wait_for_timeout(1500)
        b = await k.ev(f"(()=>{{const c={ED}.content.children.find(x=>x.data&&x.data.mode); return [c.bounds.width, c.bounds.height];}})()")
        assert abs(b[0] - 30) < 1.5 and abs(b[1] - 30) < 1.5, ('裁剪后 100 × 100 px → 50 mm 宽，60 px 的灰方块 = 30 mm', b)
    await case('描摹前调节：亮度、对比度改变黑白结果；裁剪改变尺寸；导入尺寸按裁剪后计算', trace())

    async def names():
        await pg.click('.sk-back'); await pg.wait_for_timeout(3000)
        await k.ev(f"void {D}.nameplateDialog()"); await pg.wait_for_selector('#names-modal [data-n=names]')
        await pg.fill('#names-modal [data-n=names]', '姓名\t班级\t编号\n张三\t三年二班\t07\nLi Si\t三年一班\t12')
        if await pg.is_checked('#names-modal [data-n=qr]'):
            await pg.click('#names-modal [data-n=qr]')
        await pg.click('#names-modal [data-m=ok]'); await pg.wait_for_timeout(5000)
        sk = await k.ev(f"Object.values({D}.W.project.sketches).filter(s=>s.items.some(i=>i.id==='text2')).map(s=>s.items.filter(i=>i.text).map(i=>[i.id, i.text.text, i.text.y]))")
        assert len(sk) == 2, sk
        got = sorted([t[1] for t in s] for s in sk)
        assert got == [['Li Si', '三年一班', '12'], ['张三', '三年二班', '07']], got
        for s in sk:
            ys = {i: y for i, _t, y in s}
            assert ys['text'] > ys['text2'] > ys['text3'], ('大字在上、小字往下排', ys)
        names = await k.ev(f"{D}.W.project.free.parts.map(p=>p.name)")
        assert '姓名' not in names and '张三' in names, ('表头跳过', names)
    await case('批量名牌表格粘贴：表头跳过，大字 + 每列一行小字', names())


asyncio.run(run(body, 'c10low1')) and print('PASS c10low1：四点变形、材料测试矩阵、描摹前亮度 / 对比度 / 裁剪、批量名牌表格粘贴')
