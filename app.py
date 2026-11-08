"""SeedLaser 桌面客户端入口（Windows / macOS）."""
from __future__ import annotations

import os
import sys

import webview

from backend import Api, launch_file_from_argv
from version import __version__


def _apply_win_icon(window: webview.Window, ico_path: str, title: str) -> None:
    """开发模式下把 Windows 窗口图标设为指定 .ico
    （PyWebView 6.2.1 的 create_window 不支持 icon 参数）."""
    if sys.platform != "win32" or not os.path.isfile(ico_path):
        return
    def _apply() -> None:
        try:
            import ctypes
            user32 = ctypes.windll.user32
            WM_SETICON, ICON_BIG, ICON_SMALL = 0x0080, 1, 0
            IMAGE_ICON, LR_LOADFROMFILE = 1, 0x10
            big = user32.LoadImageW(0, ico_path, IMAGE_ICON, 256, 256, LR_LOADFROMFILE)
            small = user32.LoadImageW(0, ico_path, IMAGE_ICON, 32, 32, LR_LOADFROMFILE)
            hwnd = user32.FindWindowW(None, title)
            if hwnd:
                if big:
                    user32.SendMessageW(hwnd, WM_SETICON, ICON_BIG, big)
                if small:
                    user32.SendMessageW(hwnd, WM_SETICON, ICON_SMALL, small)
        except Exception:
            pass
    try:
        window.events.shown += _apply
    except Exception:
        pass


def _apply_mac_icon(ico_path: str) -> None:
    """开发模式下把 macOS 程序坞（Dock）图标设为指定图标.
    打包为 .app 后由 .spec 的 BUNDLE icon 控制（不依赖此函数）。
    必须在主线程、webview.start() 之前调用。"""
    if sys.platform != "darwin" or not os.path.isfile(ico_path):
        return
    try:
        from AppKit import NSApplication, NSImage  # pyobjc，pywebview 在 macOS 上的依赖

        image = NSImage.alloc().initWithContentsOfFile_(ico_path)
        if image is not None:
            NSApplication.sharedApplication().setApplicationIconImage_(image)
    except Exception:
        pass


def get_web_path() -> str:
    if hasattr(sys, "_MEIPASS"):
        return os.path.join(sys._MEIPASS, "web")
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "web")


def main() -> None:
    api = Api()
    web_dir = get_web_path()
    title = f"SeedLaser v{__version__}"
    window = webview.create_window(
        title=title,
        url=os.path.join(web_dir, "index.html"),
        js_api=api,
        width=1400,
        height=880,
        min_size=(1080, 680),
        background_color="#FAFAF7",
        text_select=False,
    )
    api.set_window(window)
    # 双击 .seedlaser 打开（macOS 打包时 argv_emulation 把「打开文件」事件变成命令行参数；Windows 是「打开方式」传进来的路径）
    api.set_launch_file(launch_file_from_argv(sys.argv))
    # 开发模式下替换窗口 / 任务栏（Windows）或程序坞（macOS）图标。
    # PyInstaller 打包后由 .spec 的 icon 参数控制（不依赖这两个函数）。
    if hasattr(sys, "_MEIPASS"):
        ico = os.path.join(sys._MEIPASS, "logo.ico")
    else:
        ico = os.path.join(os.path.dirname(os.path.abspath(__file__)), "logo.ico")
    _apply_win_icon(window, ico, title)
    if not hasattr(sys, "_MEIPASS"):
        _apply_mac_icon(ico)
    debug = os.environ.get("SEEDBOXES_DEBUG", "0") == "1"
    # 用 pywebview 内置本地 HTTP 服务器（仅监听 127.0.0.1，完全离线）提供 web/ 目录：
    #  - 3D 视图的 three.js 是 ES 模块，file:// 下 WebView2 / WKWebView 都会拦截模块加载
    #  - macOS WKWebView 对 file:// 页面的 CSP 'self' 匹配不可靠
    webview.start(debug=debug, http_server=True)


if __name__ == "__main__":
    main()
