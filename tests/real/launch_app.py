"""启动一次真正的 SeedLaser 窗口（app.main()，真实的 pywebview：隐私模式、内置本地服务器、随机端口），
在窗口里新建一个设计，看新手引导有没有自动出现，然后按参数操作引导、关掉窗口。结果打印成一行 RESULT {json}。

    python tests/real/launch_app.py skip      # 引导出现就点「跳过」
    python tests/real/launch_app.py uncheck   # 手动打开引导（帮助 → 新手引导），取消「不再提示」，再跳过
    python tests/real/launch_app.py look      # 只看，不点

和 tests/e2e 的区别：那里是普通浏览器 + 调试桥（网页存储不会被清空）；这里走的是软件真正的启动代码，
网页存储每次启动都是空的——「不再提示」只能靠用户目录里的偏好文件记住。由 tests/real/run_real.py 连续启动几次来检查。
环境变量 SEEDLASER_TEST_ROOT 可以指向另一份代码（比如 v0.5.1）。HOME 请指到临时目录，别动真实的用户目录。"""
import json
import os
import sys
import threading
import time

ROOT = os.environ.get('SEEDLASER_TEST_ROOT') or os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
sys.path.insert(0, ROOT)
os.chdir(ROOT)
ACTION = sys.argv[1] if len(sys.argv) > 1 else 'look'

import webview  # noqa: E402

TOUR = "(()=>{const t=document.querySelector('#sk-host .sk-tour'); return !!t && !t.classList.contains('hidden') && !!t.querySelector('.sk-tour-tip');})()"
# 真实窗口里没有调试接口：从上下文栏的「图形 N 个」读数量，从「帮助」菜单打开引导（和用户操作一样）
SHAPES = "(()=>{const t=(document.querySelector('#sk-host .sk-ctx-idle')||{}).innerText||''; const m=/图形\\s*(\\d+)\\s*个/.exec(t); return m ? Number(m[1]) : -1;})()"


def driver(window):
    out = {'action': ACTION}
    js = window.evaluate_js
    try:
        end = time.time() + 90
        while time.time() < end:
            try:
                if (js("document.querySelectorAll('.gen-item').length") or 0) > 0:
                    break
            except Exception:
                pass
            time.sleep(0.5)
        time.sleep(1.0)
        out['origin'] = js('location.origin')
        out['has_api'] = js('!!(window.pywebview && window.pywebview.api)')
        out['stored_at_start'] = js("localStorage.getItem('seedboxes.skTour')")
        js("document.querySelector('#free-entry').click()")
        end = time.time() + 30
        while time.time() < end and not js("(()=>{const h=document.querySelector('#sk-host'); return !!h && !h.classList.contains('hidden');})()"):
            time.sleep(0.3)
        time.sleep(2.5)
        out['tour'] = js(TOUR)
        out['shapes'] = js(SHAPES)
        out['has_never_box'] = js("!!document.querySelector('#sk-host [data-t=never]')")
        if ACTION == 'skip' and out['tour']:
            js("document.querySelector('#sk-host [data-t=skip]').click()")
        elif ACTION == 'uncheck':
            if not out['tour']:
                js("document.querySelector('#sk-host [data-menu=help]').click()")
                time.sleep(0.4)
                js("document.querySelector('#sk-host .sk-filemenu [data-mact=tour]').click()")
                time.sleep(0.6)
            out['manual_tour'] = js(TOUR)
            js("(()=>{const c=document.querySelector('#sk-host [data-t=never]'); if (c && c.checked) c.click();})()")
            js("document.querySelector('#sk-host [data-t=skip]').click()")
        time.sleep(1.5)                                           # 让写偏好的调用跑完
        out['stored_at_end'] = js("localStorage.getItem('seedboxes.skTour')")
    except Exception as exc:  # noqa: BLE001
        out['error'] = f'{type(exc).__name__}: {exc}'
    finally:
        print('RESULT ' + json.dumps(out, ensure_ascii=False), flush=True)
        window.destroy()


# 走软件真正的启动代码：只在 webview.start 上加一个「窗口起来后自动操作」的函数，其余参数原样
_start = webview.start


def start(*a, **kw):
    kw['func'] = driver
    kw['args'] = (webview.windows[0],)
    return _start(*a, **kw)


webview.start = start
threading.Timer(150, lambda: os._exit(3)).start()               # 兜底：卡住时别一直挂着

import app  # noqa: E402

app.main()
os._exit(0)
