# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for SeedBoxes 桌面客户端.

Windows：单文件 dist/SeedBoxes.exe
macOS  ：dist/SeedBoxes.app（onedir + BUNDLE，PyInstaller 6 对 .app 不推荐 onefile）
"""
import os
import sys
import importlib.util
from PyInstaller.utils.hooks import collect_all, collect_submodules

block_cipher = None
IS_WIN = sys.platform == 'win32'
IS_MAC = sys.platform == 'darwin'
APP_VERSION = '0.1.0'

# boxes 项目根目录（含 locale/、static/）— 从已安装的 boxes 包反推。
# uv sync 时从上游 git 拉到 .venv，也兼容编辑式 path 安装。
def _detect_boxes_root() -> str:
    spec = importlib.util.find_spec('boxes')
    if spec is None or not spec.origin:
        raise RuntimeError("找不到 boxes 包，请先 `uv sync` 安装依赖")
    return os.path.abspath(os.path.join(os.path.dirname(spec.origin), '..'))

BOXES_ROOT = _detect_boxes_root()
print(f"[spec] BOXES_ROOT = {BOXES_ROOT}")

# 收集 boxes 包的数据 + 子模块（生成器是动态导入的）
boxes_datas, boxes_binaries, boxes_hiddenimports = collect_all('boxes')
webview_datas, webview_binaries, webview_hiddenimports = collect_all('webview')

# pywebview Windows 后端依赖（EdgeChromium 通过 .NET 桥接需要这些）
# macOS 用 Cocoa/WebKit 后端（pyobjc），不需要 .NET 桥接
if IS_WIN:
    pythonnet_datas, pythonnet_binaries, pythonnet_hiddenimports = collect_all('pythonnet')
    clr_loader_datas, clr_loader_binaries, clr_loader_hiddenimports = collect_all('clr_loader')
else:
    pythonnet_datas, pythonnet_binaries, pythonnet_hiddenimports = [], [], []
    clr_loader_datas, clr_loader_binaries, clr_loader_hiddenimports = [], [], []

# pywebview 内部 HTTP 服务器
try:
    bottle_datas, bottle_binaries, bottle_hiddenimports = collect_all('bottle')
except Exception:
    bottle_datas, bottle_binaries, bottle_hiddenimports = [], [], []

# boxes 运行时关键 C 扩展依赖（必须 collect_all，否则子模块/动态库丢失）
def _safe_collect(name):
    try:
        return collect_all(name)
    except Exception:
        return [], [], []

shapely_datas, shapely_binaries, shapely_hiddenimports = _safe_collect('shapely')
numpy_datas, numpy_binaries, numpy_hiddenimports = _safe_collect('numpy')
pil_datas, pil_binaries, pil_hiddenimports = _safe_collect('PIL')
qrcode_datas, qrcode_binaries, qrcode_hiddenimports = _safe_collect('qrcode')
markdown_datas, markdown_binaries, markdown_hiddenimports = _safe_collect('markdown')
svgpath_datas, svgpath_binaries, svgpath_hiddenimports = _safe_collect('svgpathtools')

# 全部生成器子模块（pkgutil 动态发现需要在打包时落实）
gen_modules = collect_submodules('boxes.generators')

# 中文刻字：fontTools 按表名动态导入 ttLib.tables.* 子模块
fonttools_modules = collect_submodules('fontTools.ttLib.tables') + [
    'fontTools.ttLib', 'fontTools.cffLib', 'fontTools.pens.basePen', 'fontTools.misc.psCharStrings',
]

# Critical: boxes 项目根目录下的 static/ 和 locale/ 不在 boxes 包内
# 必须显式拷贝，否则打包后中文翻译失效 + 168 张样图全部丢失
extra_datas = [
    ('web', 'web'),
    ('web_sketchforge', 'web_sketchforge'),   # 3D 编辑器（SketchForge 改版，AGPL-3.0）
    ('logo.ico', '.'),
    ('i18n', 'i18n'),   # 较新的 zh_CN.po（backend._load_translation 优先使用）
]
# 查找顺序与 backend._find_asset_dir 一致：
#   boxes_assets/（scripts/fetch_boxes_assets.py 下载）→ BOXES_ROOT → <venv>/share/locale
def _find_asset(kind):
    candidates = [os.path.join('boxes_assets', kind), os.path.join(BOXES_ROOT, kind)]
    if kind == 'locale':
        candidates.append(os.path.join(sys.prefix, 'share', 'locale'))
    for path in candidates:
        if os.path.isdir(path):
            return os.path.abspath(path)
    return None

for _kind in ('static', 'locale'):
    _path = _find_asset(_kind)
    if _path is None:
        raise RuntimeError(
            f"找不到 boxes 的 {_kind}/ 目录，请先运行 "
            "`uv run python scripts/fetch_boxes_assets.py`")
    print(f"[spec] {_kind} = {_path}")
    extra_datas.append((_path, _kind))

datas = (extra_datas + boxes_datas + webview_datas + pythonnet_datas + clr_loader_datas
         + bottle_datas + shapely_datas + numpy_datas + pil_datas + qrcode_datas
         + markdown_datas + svgpath_datas)
binaries = (boxes_binaries + webview_binaries + pythonnet_binaries + clr_loader_binaries
            + bottle_binaries + shapely_binaries + numpy_binaries + pil_binaries
            + qrcode_binaries + markdown_binaries + svgpath_binaries)

hiddenimports = list({
    *boxes_hiddenimports,
    *webview_hiddenimports,
    *pythonnet_hiddenimports,
    *clr_loader_hiddenimports,
    *bottle_hiddenimports,
    *shapely_hiddenimports,
    *numpy_hiddenimports,
    *pil_hiddenimports,
    *qrcode_hiddenimports,
    *markdown_hiddenimports,
    *svgpath_hiddenimports,
    *gen_modules,
    *fonttools_modules,
    'model3d',
    'sketch2d',
    # 关键子模块（boxes/__init__.py 直接 import 的）
    'shapely',
    'shapely.geometry',
    'shapely.ops',
    'shapely.affinity',
    'shapely.geometry.polygon',
    'numpy',
    'PIL',
    'PIL.Image',
    'qrcode',
    'qrcode.image.svg',
    'rectpack',
    'svgpathtools',
    'markdown',
    'affine',
    'yaml',
    'proxy_tools',
})
if IS_WIN:
    # pywebview Windows 后端关键模块
    hiddenimports += [
        'webview.platforms.edgechromium',
        'webview.platforms.winforms',
        'pythonnet',
        'clr_loader',
    ]
elif IS_MAC:
    # pywebview macOS 后端（Cocoa + WKWebView，经 pyobjc 调用）
    hiddenimports += [
        'webview.platforms.cocoa',
        'objc',
        'AppKit',
        'Foundation',
        'WebKit',
        'Quartz',
        'Security',
        'UniformTypeIdentifiers',
    ]

a = Analysis(
    ['app.py'],
    pathex=[],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'tkinter',
        'matplotlib',
        'IPython',
        'jupyter',
        'pytest',
        'sphinx',
        'sphinxcontrib',
        'mypy',
        'lxml',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

if IS_MAC:
    # macOS：onedir → COLLECT → BUNDLE 生成 SeedBoxes.app
    # icon 用 logo.ico，PyInstaller 会借助 Pillow 自动转为 .icns
    exe = EXE(
        pyz,
        a.scripts,
        [],
        exclude_binaries=True,
        name='SeedBoxes',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=False,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        icon='logo.ico',
    )
    coll = COLLECT(
        exe,
        a.binaries,
        a.zipfiles,
        a.datas,
        strip=False,
        upx=False,
        upx_exclude=[],
        name='SeedBoxes',
    )
    app = BUNDLE(
        coll,
        name='SeedBoxes.app',
        icon='logo.ico',
        bundle_identifier='com.makerseed.seedboxes',
        version=APP_VERSION,
        info_plist={
            'CFBundleName': 'SeedBoxes',
            'CFBundleDisplayName': 'SeedBoxes',
            'CFBundleShortVersionString': APP_VERSION,
            'CFBundleDevelopmentRegion': 'zh_CN',
            'NSHighResolutionCapable': True,
            'LSMinimumSystemVersion': '11.0',
        },
    )
else:
    # Windows：单文件 .exe
    exe = EXE(
        pyz,
        a.scripts,
        a.binaries,
        a.zipfiles,
        a.datas,
        [],
        name='SeedBoxes',
        debug=False,
        bootloader_ignore_signals=False,
        strip=False,
        upx=True,
        upx_exclude=[],
        runtime_tmpdir=None,
        console=False,
        disable_windowed_traceback=False,
        argv_emulation=False,
        target_arch=None,
        codesign_identity=None,
        entitlements_file=None,
        icon='logo.ico',
    )
