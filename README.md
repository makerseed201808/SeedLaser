<h1 align="center">SeedBoxes</h1>

<p align="center">
  基于开源项目 <a href="https://github.com/florianfesti/boxes">Boxes.py</a> 二次开发的桌面客户端<br/>
  中文界面 · 100% 离线 · Windows 单 exe / macOS .app
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-GPLv3-blue.svg" alt="License: GPL v3" /></a>
  <img src="https://img.shields.io/badge/python-3.10-blue.svg" alt="Python" />
  <img src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS-lightgrey.svg" alt="Platform" />
  <a href="https://github.com/liwlin/SeedBoxes/releases/tag/v0.1"><img src="https://img.shields.io/badge/release-v0.1-brightgreen.svg" alt="Release" /></a>
</p>

<p align="center">
  <img src="docs/screenshots/init.png" alt="SeedBoxes 主界面" width="900" />
</p>

<p align="center">
  <em>主界面：左侧分组导航 + 中央分组卡片画廊 + 底部 GPL 致谢</em>
</p>

---

## 简介

SeedBoxes 是基于 [Boxes.py](https://github.com/florianfesti/boxes)（激光切割盒子生成器）开发的桌面客户端，由 [makerseed 种子创客工坊](https://github.com/makerseed) 维护。它把上游 Web 服务器版包装为本地 Windows / macOS 桌面 app（PyWebView），并补齐了完整中文界面。

### 主要特性
- **179 个生成器** — 完整覆盖上游 boxes 所有可视化生成器
- **完整中文化** — 加载 boxes 自带的 zh_CN.po 翻译，覆盖率 ~98%；客户端层补 4 级 fallback 翻译链处理上游漏译
- **作品参考图** — 169 个生成器配实物照片，10 个无图的自动渲染 SVG 示意图（带角标区分）
- **3 视图导航** — 主页画廊 → 分组浏览 → 编辑器（带面包屑返回）
- **本地渲染** — 所有 SVG 渲染在本地完成，无需联网，无服务器
- **多种输出** — SVG / SVG_Ponoko / PostScript / Lightburn (lbrn2) 直接生成；DXF / GCode / PDF 需系统装 `pstoedit` / `ps2pdf`
- **单文件 .exe** — PyInstaller 打包约 100 MB，复制即用，依赖 Windows 10/11 默认的 WebView2 Runtime
- **macOS 支持** — 使用系统自带的 WKWebView，可打包为 `SeedBoxes.app`
- **3D 模型预览** — 预览区切到「3D 模型」：36 个盒、柜、机箱类生成器显示拼好的样子（其中 31 个为自动装配，经碰撞校验确认卡榫咬合），其余显示所有板件平铺
- **局部修改** — 板件清单里可禁用某块板；「编辑」进入单块板编辑器，开圆孔 / 方孔 / 圆角矩形孔、刻中文字（系统中文字体转轮廓），导出的 SVG / PDF / DXF 等都会带上
- **手动摆放（仿 Tinkercad）** — 3D 视图点「✋ 摆放」：拖动板件、黑色锥形手柄升降、彩色弧形箭头旋转，吸附网格、方向键微移、撤销；每次放下自动做碰撞校验，穿透的板标红、咬合的板在清单里注明
- **二维草图编辑（参考 LightBurn / LaserMaker）** — 3D 视图里点板件的「编辑」：直线、曲线（钢笔）、矩形、椭圆、多边形 / 星形、文字、修剪（橡皮擦）、节点编辑，并集 / 差集 / 交集 / 异或、偏移、阵列、对齐、镜像；切割 / 雕刻 / 划线三个图层；外轮廓（卡榫边）也能改。右下角 3D 实时预览，每次修改后自动检查与相邻板是否穿透
- **3D 编辑器（SketchForge 改版）** — 3D 视图点「🛠 3D 编辑器」：在完整的 SketchForge 编辑界面（中文）里移动、旋转、对齐、组合板件，点「✓ 完成 · 返回 SeedBoxes」或左上角「主页」后，摆放结果同步回来并自动做咬合检查；「☰ 板件」可隐藏板件清单
- **项目文件** — 参数、局部修改和手动摆放位置保存为 `.seedbox.json`，随时打开继续改

---

## 开发模式

依赖 [uv](https://docs.astral.sh/uv/)（Astral Python 包管理器）。

```cmd
git clone https://github.com/makerseed/SeedBoxes.git
cd SeedBoxes
run_uv.bat
```

macOS / Linux：

```bash
./run_mac.sh
```

首次运行会自动 `uv sync` 拉取依赖（包含从 GitHub 拉 boxes release-1.2），并运行 `scripts/fetch_boxes_assets.py` 下载上游的作品照片和翻译文件到 `boxes_assets/`（约 30 MB），约 2~3 分钟。后续启动秒开，可离线。

> 连不上 GitHub？在能访问 GitHub 的电脑上运行 `scripts/make_boxes_mirror.sh`，把整个文件夹（含 `third_party/`）拷过去，`run_mac.sh` 会自动改用本地镜像。
>
> 为什么要单独下载：boxes 通过 git 安装进 `.venv` 时只安装 `boxes` 包本身，上游仓库根目录的 `static/`（作品照片）不会被安装。

---

## 浏览器调试模式

不开桌面窗口，用普通浏览器调试前端（可以用浏览器开发者工具）：

```bash
uv run python scripts/dev_server.py
# 浏览器打开 http://127.0.0.1:8765/index.html?dev=1
```

此模式下「保存到文件」「打开 / 保存项目」的系统对话框不可用。

---

## 打包发布

```cmd
build_uv.bat
```

产物：`dist\SeedBoxes.exe`（约 100 MB，单文件，含 boxes 源码 + Python 运行时 + 全部依赖）。

复制到任意 Windows 10/11 机器即可运行（依赖系统默认的 WebView2 Runtime）。

### macOS

```bash
./build_mac.sh
```

产物：`dist/SeedBoxes.app` 和分发用的 `dist/SeedBoxes-macOS.zip`。只能在 Mac 上打包，产物架构与打包机一致（Apple 芯片打出的是 arm64）。

未签名的 .app 首次打开会被 Gatekeeper 拦截：右键 → 打开，或在「系统设置 → 隐私与安全性」中点「仍要打开」。

---

## 启用 PDF / DXF / GCode 输出

默认只能输出 SVG / PS / LBRN2。要输出 DXF/GCode/PLT/PDF：

```cmd
winget install --id=Cybernetic.pstoedit         :: DXF / GCode / PLT
winget install --id=ArtifexSoftware.GhostScript :: PDF (内含 ps2pdf)
```

macOS：

```bash
brew install pstoedit      # DXF / GCode / PLT
brew install ghostscript   # PDF (内含 ps2pdf)
```

安装后重启客户端，下拉框会自动出现新格式选项。

---

## 加密路径（可选）

`backend.py` 是核心业务代码。如需防反编译，可用 Cython 编译为 `.pyd`（目前脚本仅支持 Windows）：

```cmd
install_msvc.bat        :: 一次性装 MSVC Build Tools (~4 GB)
build_pyd.bat           :: backend.py → backend.cp310-win_amd64.pyd
build_uv.bat            :: 重新打包，自动用 .pyd 替代 .py
```

加密后反编译需 IDA / Ghidra 等逆向工具，强度约 ★★★★。

---

## 项目结构

```
SeedBoxes/
├── app.py                  PyWebView 入口
├── backend.py              JS↔Python 桥接 API（含 i18n / 自渲染兜底 / 边缘字符映射）
├── sketch2d.py             二维草图：展平、导出（激光补偿）、3D 轮廓、偏移
├── model3d.py              3D 模型：零件捕获、组装配方、局部修改注入、中文字转轮廓
├── web/                    前端
│   ├── index.html / app.js / styles.css
│   ├── workshop.js         3D 视图 + 板件清单 + 单块板编辑器 + 3D 编辑器桥接（ES 模块）
│   ├── vendor/three/       three.js r169（MIT，离线打包）
│   ├── seedboxes-logo.svg  主软件 logo
│   └── makerseed-logo.svg  种子创客工坊标识
├── pyproject.toml          uv 项目（boxes 通过 git 引用上游 release-1.2）
├── uv.lock                 依赖锁文件
├── SeedBoxes.spec          PyInstaller 打包配置
├── logo.ico                .exe / .app 图标（多尺寸）
├── run_uv.bat / build_uv.bat                       开发 / 打包（Windows）
├── run_mac.sh / build_mac.sh                       开发 / 打包（macOS）
├── scripts/fetch_boxes_assets.py                   下载上游作品照片 + 翻译到 boxes_assets/
├── build_pyd.bat / setup_ext.py / install_msvc.bat 加密路径预备
├── README.md / DEVELOPMENT.md / CLAUDE.md          文档
├── sketchforge/            3D 编辑器改版：补丁、构建脚本、说明
├── web_sketchforge/        3D 编辑器构建产物（SketchForge-3D 改版，AGPL-3.0）
└── LICENSE                 GPL-3.0
```

---

## 许可

本项目采用 **GPL-3.0-or-later**，与上游 boxes 一致。

依赖：
- [boxes](https://github.com/florianfesti/boxes) (GPL-3.0) by Florian Festi — 核心渲染引擎
- [pywebview](https://github.com/r0x0r/pywebview) (BSD-3-Clause) — 桌面框架
- [paper.js](http://paperjs.org/) (MIT) — 二维草图编辑（web/vendor/paper）
- [SketchForge-3D](https://github.com/Formsmith746/SketchForge-3D) (AGPL-3.0-only) — 3D 编辑器；改版构建在 `web_sketchforge/`，对应源码 = 上游提交 `e9cb8e8` + `sketchforge/seedboxes.patch`（见 `sketchforge/README.md`）

如分发本程序，需附带源码或源码获取方式（GPL 要求）。

---

## 致谢

- [Florian Festi](https://github.com/florianfesti) — boxes.py 原作者
- 上游 zh_CN 翻译贡献者：裘炯涛 \<qiujiongtao@163.com\>

© makerseed 种子创客工坊
