"""新手引导「不再提示」要能挺过重启（2026-11-10 用户反馈：每次打开都提示）。

真实软件每次启动都会清空网页存储（pywebview 隐私模式：platforms/cocoa.py 启动时删掉全部网站数据；本地端口也是随机的），
所以这里每一次「启动」= 一个全新的浏览器（存储是空的）+ 一个新的后端进程，偏好只能靠磁盘上的偏好文件带过去。
不用假接口：自己起后端（端口 8791），读写真实的偏好文件。

  第 1 次启动：引导出现 → 点「跳过」（「不再提示」默认勾着）→ 偏好文件里记下了；顺手改一个别的设置（折叠面板）
  第 2 次启动：引导不出现；别的设置也回来了；「帮助 → 新手引导」仍能打开 → 取消勾选再跳过
  第 3 次启动：引导又出现（反向验证）
  删掉偏好文件 → 第 4 次启动：引导出现（等于第一次用）
  偏好文件内容损坏 → 第 5 次启动：软件照常打开、引导出现，跳过后文件恢复成正常内容
  偏好文件写不进去（上级路径是个文件）→ 第 6 次启动：软件照常打开、没有报错（只是记不住）

SEEDLASER_TEST_ROOT 可以指向另一份代码（比如 v0.5.1），用来确认这个测试在修之前是失败的。"""
import asyncio, json, os, shutil, subprocess, sys, tempfile, time, urllib.request
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.environ.get('SEEDLASER_TEST_ROOT') or os.path.dirname(os.path.dirname(HERE))
PY = sys.executable
PORT = int(os.environ.get('SEEDLASER_RESTART_PORT', '8791'))
URL = f'http://127.0.0.1:{PORT}/index.html?dev=1'
TMP = tempfile.mkdtemp(prefix='seedlaser-restart1-')
PREFS = os.path.join(TMP, 'home', 'prefs.json')
ED = 'window.__seedDebug.sketchEd'


def start(prefs_path):
    env = {**os.environ, 'SEEDLASER_PROJECT_DIR': os.path.join(TMP, 'proj'), 'SEEDLASER_PREFS_FILE': prefs_path}
    proc = subprocess.Popen([PY, os.path.join(ROOT, 'scripts', 'dev_server.py'), str(PORT)], cwd=ROOT, env=env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(80):
        try:
            urllib.request.urlopen(f'http://127.0.0.1:{PORT}/index.html', timeout=1).read(10)
            return proc
        except Exception:
            time.sleep(0.25)
    proc.kill()
    raise RuntimeError('后端没起来')


def stop(proc):
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()
    time.sleep(0.3)


async def launch(p, prefs_path, then=None):
    """一次完整的「打开软件 → 新建设计 → 关掉」。返回 {tour: 引导有没有自动出现, errors, extra}。"""
    proc = start(prefs_path)
    out = {'errors': []}
    try:
        b = await p.chromium.launch(args=['--use-gl=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
        pg = await b.new_page(viewport={'width': 1500, 'height': 900})          # 全新的浏览器环境：localStorage 是空的
        pg.on('pageerror', lambda e: out['errors'].append(str(e)[:200]))
        await pg.goto(URL)
        await pg.wait_for_function("document.querySelectorAll('.gen-item').length>0", timeout=60000)
        await pg.click('#free-entry'); await pg.wait_for_selector('#sk-host:not(.hidden)'); await pg.wait_for_timeout(1500)
        out['tour'] = await pg.is_visible('#sk-host .sk-tour .sk-tour-tip')
        out['shapes'] = await pg.evaluate(f"{ED}.content.children.filter(c=>c.data&&c.data.mode).length")
        if then:
            out['extra'] = await then(pg)
        await pg.wait_for_timeout(400)                                           # 让写偏好的请求发完
        await b.close()
    finally:
        stop(proc)
    return out


def read_prefs():
    try:
        return json.load(open(PREFS, encoding='utf-8'))
    except Exception as e:
        return f'读不了：{type(e).__name__}'


async def main():
    res = {}
    async with async_playwright() as p:
        async def skip_default(pg):
            checked = await pg.is_checked('#sk-host [data-t=never]') if await pg.query_selector('#sk-host [data-t=never]') else None
            await pg.click('#sk-host [data-t=skip]')
            await pg.evaluate(f"(()=>{{const e={ED}; const c=e.$('.sk-side [data-key=t-path]'); e.setCollapsed(c, false);}})()")   # 另一个设置：展开「路径」区块
            return checked
        res['1'] = await launch(p, PREFS, skip_default)
        res['prefs1'] = read_prefs()

        async def second(pg):
            collapsed = await pg.evaluate("localStorage.getItem('seedboxes.skCollapsed')")
            await pg.evaluate(f"{ED}.startTour()"); await pg.wait_for_timeout(200)     # 帮助 → 新手引导 走的就是它
            manual = await pg.is_visible('#sk-host .sk-tour .sk-tour-tip')
            if await pg.query_selector('#sk-host [data-t=never]'):
                await pg.click('#sk-host [data-t=never]')                              # 取消勾选
            await pg.click('#sk-host [data-t=skip]')
            return {'collapsed': collapsed, 'manual': manual}
        res['2'] = await launch(p, PREFS, second)
        res['prefs2'] = read_prefs()

        async def just_skip(pg):
            if await pg.is_visible('#sk-host [data-t=skip]'):
                await pg.click('#sk-host [data-t=skip]')
        res['3'] = await launch(p, PREFS, just_skip)

        if os.path.exists(PREFS):
            os.remove(PREFS)
        res['4'] = await launch(p, PREFS, just_skip)

        os.makedirs(os.path.dirname(PREFS), exist_ok=True)
        open(PREFS, 'w', encoding='utf-8').write('{这不是合法的 json')
        res['5'] = await launch(p, PREFS, just_skip)
        res['prefs5'] = read_prefs()

        blocker = os.path.join(TMP, 'afile'); open(blocker, 'w').write('x')
        res['6'] = await launch(p, os.path.join(blocker, 'sub', 'prefs.json'), just_skip)
    shutil.rmtree(TMP, ignore_errors=True)

    print(json.dumps({k: v for k, v in res.items()}, ensure_ascii=False))
    assert res['1']['tour'] is True, ('第 1 次启动应出现引导', res['1'])
    assert res['1']['extra'] is True, ('「不再提示」应默认勾上', res['1'])
    assert isinstance(res['prefs1'], dict) and res['prefs1'].get('seedboxes.skTour') == '1', ('跳过后偏好文件里应记下', res['prefs1'])
    assert res['2']['tour'] is False, ('第 2 次启动不应再出现引导', res['2'])
    assert res['2']['extra']['collapsed'] and '"t-path":false' in res['2']['extra']['collapsed'], ('别的界面设置也应挺过重启', res['2'])
    assert res['2']['extra']['manual'] is True, ('帮助里仍能手动打开引导', res['2'])
    assert 'seedboxes.skTour' not in res['prefs2'], ('取消勾选后偏好文件里应去掉', res['prefs2'])
    assert res['3']['tour'] is True, ('取消勾选后，下次启动应再出现', res['3'])
    assert res['4']['tour'] is True, ('删掉偏好文件后应再出现', res['4'])
    assert res['5']['tour'] is True and not res['5']['errors'], ('偏好文件损坏：照常打开，按默认出现引导', res['5'])
    assert isinstance(res['prefs5'], dict) and res['prefs5'].get('seedboxes.skTour') == '1', ('损坏的文件在下一次写入时恢复正常', res['prefs5'])
    assert res['6']['tour'] is True and not res['6']['errors'], ('偏好文件写不进去：照常打开、不报错', res['6'])
    assert all(res[k]['shapes'] == 0 for k in '123456'), ('每次新建设计都是空白的', {k: res[k]['shapes'] for k in '123456'})
    assert not any(res[k]['errors'] for k in '123456'), {k: res[k]['errors'] for k in '123456'}
    print('PASS restart1：引导「不再提示」挺过重启（真实偏好文件）、别的设置也回来；取消勾选 / 删文件后重新出现；文件损坏、写不进去时照常启动')


asyncio.run(main())
