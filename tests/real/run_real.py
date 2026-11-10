"""真实窗口连续启动检查：新手引导「不再提示」能不能挺过重启、新建设计是不是空白。
运行：.venv/bin/python tests/real/run_real.py     （Linux 无显示器也能跑；需要 Qt 后端：uv pip install PyQt6 PyQt6-WebEngine qtpy）

每次启动都是一个新的进程，跑软件真正的启动代码（app.main()）：pywebview 隐私模式、内置本地服务器、随机端口。
用户目录（HOME）指到临时文件夹，不碰真实的偏好。SEEDLASER_TEST_ROOT 可以指向另一份代码（比如 v0.5.1）做对照。

  第 1 次启动：引导自动出现 → 跳过（「不再提示」默认勾着）
  第 2 次启动：网页存储是空的（证明每次启动确实会清空），引导不再出现 → 从「帮助」菜单手动打开，取消勾选，跳过
  第 3 次启动：引导又出现
"""
import json, os, shutil, subprocess, sys, tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
HOME = tempfile.mkdtemp(prefix='seedlaser-real-')
ENV = {**os.environ, 'HOME': HOME, 'PYWEBVIEW_GUI': 'qt', 'QT_QPA_PLATFORM': os.environ.get('QT_QPA_PLATFORM', 'offscreen'),
       'QTWEBENGINE_CHROMIUM_FLAGS': '--no-sandbox --disable-gpu-compositing --use-angle=swiftshader-webgl --enable-unsafe-swiftshader --ignore-gpu-blocklist'}
ENV.pop('SEEDLASER_PROJECT_DIR', None)          # 设了它偏好就不读写（测试 / 调试模式），这里要的是真实行为
ENV.pop('SEEDLASER_PREFS_FILE', None)
PREFS = os.path.join(HOME, '.seedlaser', 'prefs.json')

try:
    import qtpy  # noqa: F401
except ImportError:
    print('SKIP run_real：没装 Qt 后端（uv pip install PyQt6 PyQt6-WebEngine qtpy）')
    sys.exit(0)


def launch(action):
    r = subprocess.run([sys.executable, os.path.join(HERE, 'launch_app.py'), action], env=ENV, capture_output=True, text=True, timeout=200)
    line = [l for l in r.stdout.splitlines() if l.startswith('RESULT ')]
    if not line:
        raise RuntimeError(f'窗口没给结果（退出码 {r.returncode}）：{r.stderr[-400:]}')
    return json.loads(line[-1][7:])


def prefs():
    try:
        return json.load(open(PREFS, encoding='utf-8'))
    except Exception as e:
        return f'没有偏好文件（{type(e).__name__}）'


a = launch('skip'); pa = prefs()
b = launch('uncheck'); pb = prefs()
c = launch('look')
shutil.rmtree(HOME, ignore_errors=True)
for name, r, extra in (('第 1 次', a, pa), ('第 2 次', b, pb), ('第 3 次', c, '')):
    print(name, json.dumps(r, ensure_ascii=False), '| 偏好文件：', json.dumps(extra, ensure_ascii=False) if extra != '' else '')
assert a['has_api'] and not a.get('error'), a
assert a['tour'] is True and a['shapes'] == 0, ('第 1 次启动：引导出现、新设计是空白', a)
assert isinstance(pa, dict) and pa.get('seedboxes.skTour') == '1', ('跳过后记到用户目录', pa)
assert b['stored_at_start'] == '1' and b['origin'] != a['origin'], ('第 2 次启动：偏好已放回网页存储；端口和上次不同', a['origin'], b)
assert b['tour'] is False and b['shapes'] == 0, ('第 2 次启动：引导不再自动出现', b)
assert b.get('manual_tour') is True, ('帮助菜单里仍能打开引导', b)
assert isinstance(pb, dict) and 'seedboxes.skTour' not in pb, ('取消勾选后从偏好文件里去掉', pb)
assert c['tour'] is True, ('第 3 次启动：取消勾选后引导又出现', c)
print('PASS run_real：真实窗口连续启动 3 次——跳过后不再提示、帮助里能再打开、取消勾选后重新出现；新建设计是空白的')
