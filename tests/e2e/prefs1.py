"""用户反馈（2026-11-10）：
新建设计是空白画板（不再自动放一块矩形）；新手引导有「不再提示」（默认勾上：跳过后不再自动出现；取消勾选：下次还会出现）；
界面偏好（seedboxes.* / seedlaser.*）启动时从用户目录放回 localStorage，之后写入的同时存到用户目录（其它键不存）。带断言。"""
import asyncio
from _kit import run, ED

D = 'window.__seedDebug'


async def body(k, case):
    pg = k.pg

    async def blank():
        await k.open(clear=False)
        n = await k.ev(f"{ED}.content.children.filter(c=>c.data&&c.data.mode).length")
        parts = await k.ev(f"({D}.W.project.free && {D}.W.project.free.parts || []).length")
        assert n == 0 and parts == 0, ('新建设计不应自动有图形', n, parts)
    await case('新建设计是空白画板：没有自动的矩形', blank())

    async def tour():
        await k.ev("localStorage.removeItem('seedboxes.skTour')")
        await k.ev(f"{ED}.startTour()"); await pg.wait_for_timeout(200)
        assert await pg.is_visible('#sk-host .sk-tour-never'), '要有「不再提示」'
        assert await pg.is_checked('#sk-host [data-t=never]'), '默认勾上'
        await pg.click('#sk-host [data-t=skip]'); await pg.wait_for_timeout(100)
        assert await k.ev("localStorage.getItem('seedboxes.skTour')") == '1'
        assert '不会再自动出现' in await k.status(), await k.status()
        await k.ev(f"{ED}.startTour()"); await pg.wait_for_timeout(200)
        await pg.click('#sk-host [data-t=never]')
        await pg.click('#sk-host [data-t=next]'); await pg.wait_for_timeout(100)      # 取消勾选后走完 / 跳过都一样
        await pg.click('#sk-host [data-t=skip]'); await pg.wait_for_timeout(100)
        assert await k.ev("localStorage.getItem('seedboxes.skTour')") is None, '取消勾选：下次还会显示'
        assert not await pg.is_visible('#sk-host .sk-tour-tip')
    await case('新手引导：「不再提示」默认勾上；取消勾选则下次还会显示', tour())

    async def persist():
        r = await k.ev("""(async()=>{ const calls=[]; const f0=window.fetch;
          // 调试模式的 api 是 fetch('/api/<名字>')：拦下这两个接口
          window.fetch = async(url, opt)=>{ const n=String(url).split('/api/')[1];
            if (n==='get_prefs') return new Response(JSON.stringify({'seedboxes.skTour':'1','seedlaser.exportBurn':'nominal'}));
            if (n==='set_pref') { const a=JSON.parse(opt.body); calls.push([a[0], a.length>1?a[1]:null]); return new Response('{"ok":true}'); }
            return f0(url, opt); };
          try {
            localStorage.clear();
            await window.SeedApp.restorePrefs();
            const back=[localStorage.getItem('seedboxes.skTour'), localStorage.getItem('seedlaser.exportBurn')];
            localStorage.setItem('seedboxes.skCollapsed', '{"a":true}');
            localStorage.removeItem('seedboxes.skTour');
            localStorage.setItem('somethingElse', 'x');
            await new Promise((ok)=>setTimeout(ok, 50));
            return {back, calls};
          } finally { window.fetch=f0; } })()""")
        assert r['back'] == ['1', 'nominal'], ('启动时放回 localStorage', r)
        assert r['calls'] == [['seedboxes.skCollapsed', '{"a":true}'], ['seedboxes.skTour', None]], ('只存 seedboxes.* / seedlaser.*，删除也同步', r['calls'])
    await case('偏好：启动时从用户目录放回；之后的写入 / 删除同步到用户目录，其它键不存', persist())


asyncio.run(run(body, 'prefs1')) and print('PASS prefs1：新建设计空白、新手引导「不再提示」、界面偏好存到用户目录')
