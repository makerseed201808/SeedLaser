# CLAUDE.md

> 给 Claude Code（或其他 AI 助手）的项目说明。
> 详细开发历程见 [DEVELOPMENT.md](DEVELOPMENT.md)。

---

## 新 session 快速上手

**当前状态**：v0.1 已推 GitHub（liwlin/SeedBoxes）。分支 `feat/macos-support` 加了 macOS 支持，并修复了 git 安装 boxes 后缺少作品照片 / 中文翻译的问题。

**第一次进 session 要做的事**：
1. `git status` 确认仓库状态
2. `cat README.md` 了解用户视角
3. 阅读本文件下面的「关键架构事实」和「反模式」章节
4. 按需 `uv sync` 拉依赖（首次 2~3 分钟，国内可能需要镜像）
5. `uv run python scripts/fetch_boxes_assets.py` 下载上游 static/ + locale/ 到 boxes_assets/（否则无作品照片）

**用户场景**（K12 STEAM 教育，种子创客工坊）：
- 给学生/教师用，零门槛，必须中文界面
- 完全离线（教学场景常无网）
- Windows 单 .exe 分发（主要）；macOS .app（开发 + 可选分发）
- 后期可能：自定义生成器 / 预设管理 / 激光切割机直连

**用户偏好**：中文回复、代码 / commit 英文、注释中文可以、嵌入式硬件背景、大改动用双重 AI 审核。

---

## 待办任务（按优先级）

### 1. Cython 加密发布（脚本已就绪，未默认启用）
**目标**：把 `backend.py` 编译成 `backend.cp310-win_amd64.pyd`，反编译需 IDA / Ghidra（强度 ★★★★）。

**资源已全部就位**：
- `setup_ext.py`：Cython 编译配置
- `build_pyd.bat`：一键编译入口
- MSVC Build Tools **已装好**（详见下节，**不要重装**）
- 流程已验证可跑通：上次跑出 186 KB .pyd，烟雾测试全部通过

**操作**：
```cmd
build_pyd.bat   :: 编译 backend.py → backend.pyd（自动备份原 .py 为 .py.src）
build_uv.bat    :: PyInstaller 自动用 .pyd 重新打包
```

回到未加密：把 `backend.py.src` 重命名回 `backend.py`，删 `.pyd`。

### 2. 推送到 GitHub ✅
已推到 https://github.com/liwlin/SeedBoxes 。（pyproject 里的 URL 仍写 makerseed/SeedBoxes，如迁到组织账号再统一。）

### 3. 代码签名（远期）
未签名 → SmartScreen 弹警告。OV 证书 ¥2000+/年。

---

## MSVC Build Tools 现状（用户机器已装）

**位置**：`D:\Apps\MSVC Build Tools\`（独立路径，不在 SeedBoxes 仓库）

| 路径 | 内容 |
|---|---|
| `D:\Apps\MSVC Build Tools\VC\Tools\MSVC\14.44.35207\bin\Hostx64\x64\cl.exe` | C++ 编译器 |
| `D:\Apps\MSVC Build Tools\VC\Auxiliary\Build\vcvarsall.bat` | 环境加载 |

总占用 3.4 GB（D 盘）+ Windows SDK 1.5 GB（C 盘强制路径）。

**手动验证**：
```cmd
"D:\Apps\MSVC Build Tools\VC\Auxiliary\Build\vcvarsall.bat" amd64
cl     :: 应输出 Microsoft (R) C/C++ Optimizing Compiler Version 19.44.xxx
```

**重装**：跑 `install_msvc.bat`（仓库内），自动从 https://aka.ms/vs/17/release/vs_BuildTools.exe 装到 `D:\Apps\MSVC Build Tools\`。

---

## 文件结构

```
SeedBoxes/
├── app.py                  PyWebView 入口
├── backend.py              JS↔Python 桥接 API（核心业务）
├── web/                    前端
│   ├── index.html / app.js / styles.css
│   ├── seedboxes-logo.svg  主 logo
│   └── makerseed-logo.svg  种子创客工坊标识
├── pyproject.toml          uv 项目（boxes 通过 git URL @release-1.2 引用）
├── uv.lock                 依赖锁文件
├── SeedBoxes.spec          PyInstaller 配置（importlib 检测 BOXES_ROOT）
├── logo.ico                .exe 图标 + 开发模式窗口图标
├── SeedBoxes_logo_vector.svg   主 logo 源
├── run_uv.bat / build_uv.bat                       开发 / 打包（Windows）
├── run_mac.sh / build_mac.sh                       开发 / 打包（macOS）
├── scripts/fetch_boxes_assets.py                   下载上游 static/ + locale/ → boxes_assets/（gitignore）
├── .gitattributes                                   .bat 强制 CRLF / .sh 强制 LF
├── build_pyd.bat / setup_ext.py / install_msvc.bat 加密路径
├── README.md / DEVELOPMENT.md / CLAUDE.md / LICENSE   文档
```

---

## 关键架构事实（修改前必读）

1. **不修改 boxes 上游源码**。所有定制在 backend.py / web/
2. **`cls.UI = "web"`** 必须在 `_init_generators()` 时设到类属性 — boxes 生成器的 `__init__` 中读 `self.UI` 决定参数
3. **`tr()` 4 级翻译链** — 每级都有真实命中场景，不要短路
4. **`_render_lock`** 保护 `Boxes.ctx` — boxes 实例非线程安全
5. **PyWebView API 在独立线程跑** — 任何全局可变状态需要锁
6. **打包资源关键**：spec 必须显式 `extra_datas` 拷贝 `static/` 和 `locale/`，否则 frozen 后样图 + 中文翻译全失效。git 安装的 boxes **不带 static/**，locale 的 .mo 装在 `<venv>/share/locale`；统一用 `backend._find_asset_dir()`（spec 里有同顺序的 `_find_asset`）查找，优先 `boxes_assets/`
7. **format/output 字段**：从生成器表单中**隐藏**（编辑器顶部已有专门下拉框 + 保存对话框），但 `_params_to_args` 还要 skip 一遍
8. **跨平台分支**：`open_folder` 按 `sys.platform` 分 Windows（startfile）/ macOS（open -R）/ Linux（xdg-open）；图标 Windows 用 Win32 `WM_SETICON`，macOS 用 AppKit 设 Dock 图标；spec 按平台分 onefile .exe / onedir + BUNDLE .app

---

## 常用操作

```bash
# macOS 开发启动 / 打包
./run_mac.sh
./build_mac.sh
# macOS 调试（右键 → 检查元素）
SEEDBOXES_DEBUG=1 uv run python app.py
```

```cmd
:: 开发启动
run_uv.bat

:: DevTools 调试
set SEEDBOXES_DEBUG=1
.venv\Scripts\python.exe app.py

:: 生产打包
build_uv.bat

:: Cython 加密
build_pyd.bat && build_uv.bat

:: 烟雾测试
.venv\Scripts\python.exe -c "import backend; api=backend.Api(); print(api.ping(), len(api.list_groups()))"
```

---

## 反模式

| 不要 | 为什么 |
|---|---|
| ❌ 改 boxes 上游源码 | 升级困难，应在客户端层补丁 |
| ❌ 把 boxes 源码 vendor 进 git 仓库 | 维护成本高 |
| ❌ 在 instance 上设 `instance.UI = "web"` | 太晚，`__init__` 已读完 |
| ❌ 用 `innerHTML` 注入 SVG | 用 DOMParser + 移除 script/on* |
| ❌ 用 `SystemExit` 表达业务错误 | 父进程会被 kill，用 ValueError 子类 |
| ❌ 给 `_RENDER_CACHE` 无上限增长 | 长会话内存泄漏，用 OrderedDict LRU |
| ❌ 在 backend 抛 Python 异常给前端 | 信息泄漏 + 用户看不懂，统一返 `{error: 中文消息}` |

---

## 上游同步流程

如果上游 boxes 出 release-2.0：
1. `pyproject.toml` 改 `rev = "release-2.0"`
2. `uv sync --upgrade-package boxes`
3. 测试：`python -c "import backend; api=backend.Api(); api.list_groups()"`
4. 看 `_FAILED_GENERATORS`：如果有新生成器加载失败，按需调整
5. 查 zh_CN.po 是否有新字符串没翻译
6. 如果上游 UI 接口变了，重审 `_init_generators` 的 `cls.UI = "web"`
7. 重新打包测试

---

## 已知坑

1. **PyInstaller `boxes.generators.drillgauge` 报 Hidden import not found** — 上游某个生成器命名特殊，不影响实际打包，可忽略
2. **首次 `uv sync` 慢** — 国内拉 GitHub 慢；可临时改 `rev` 用镜像
3. **PyWebView 6.2.1 `create_window` 不支持 `icon` 参数** — 开发模式用 Win32 API `WM_SETICON` 注入；打包模式由 .spec 的 `icon` 控制
4. **`.bat` 文件必须 UTF-8 BOM + CRLF** — 否则 `chcp 65001` 无效，中文 echo 报"命令不存在"
5. **PyWebView JS API 在独立线程** — 不要假定 main thread
6. **git 安装的 boxes 不带 static/（作品照片）** — 由 `scripts/fetch_boxes_assets.py` 按 uv.lock 锁定的 commit 下载；升级 boxes 后要重新跑（commit 变化会自动重新下载）
7. **release-1.2 的生成器 / 照片数比旧 boxes-master 少** — 实测分组内 163 个生成器，145 个有照片、18 个自渲染
9. **连不上 GitHub 的电脑** — 在能访问 GitHub 的机器上跑 `scripts/make_boxes_mirror.sh` 生成 `third_party/boxes.git`（gitignore，约 30 MB），连同文件夹拷过去；`run_mac.sh` / `build_mac.sh` 检测到 GitHub 不通时用 `GIT_CONFIG_*` 环境变量把 boxes 的 git URL 临时改写到本地镜像（不改全局 git 配置）。`SEEDBOXES_USE_MIRROR=1` 可强制使用。Windows .bat 尚未接入
8. **macOS .app 未签名** — Gatekeeper 拦截，需右键打开；产物架构随打包机

---

© makerseed 种子创客工坊 · GPL-3.0-or-later
