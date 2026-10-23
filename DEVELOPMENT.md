# SeedBoxes 开发历程

完整记录从 0 到 v0.1 的关键决策和迭代过程。供后期维护、二次开发参考。

---

## 一、项目背景

- 上游 [Boxes.py](https://github.com/florianfesti/boxes) 是激光切割盒子生成器，179 个生成器，但只有 Web 服务器和命令行工具
- **种子创客工坊（makerseed）K12 STEAM 教育**场景需要给学生 / 教师一个零门槛的 Windows 桌面 app
- 目标：完整中文界面 + 100% 离线 + Windows 单 .exe + 后期可二次开发自定义生成器

---

## 二、技术架构（参考 AUGClaw）

| 维度 | 选型 | 理由 |
|---|---|---|
| 桌面框架 | **PyWebView 6.x** + Windows WebView2 | 复用系统 WebView2，无需打包 Chromium |
| 前端 | Vanilla HTML/CSS/JS | 无构建工具，AI 可直接维护 |
| 后端 | Python 3.10 直接调用 boxes API | 不走 HTTP，性能高 |
| 通信 | `window.pywebview.api.<method>()` Promise | 标准 PyWebView 模式 |
| 打包 | PyInstaller 单文件 | 标准方案 |
| 包管理 | uv (Astral) | 比 pip 快 10 倍 |

### 关键架构决策
1. **不修改上游 boxes 源码**：通过 git URL 引用 `florianfesti/boxes#release-1.2`，所有定制在客户端层
2. **核心引擎复用**：`boxes.Boxes` 与 Web 解耦，可直接 `parseArgs()→open()→render()→close()`
3. **`cls.UI = "web"`**：必须在 `__init__` 前设到类上，否则 TypeTray 等会暴露 `label_file`（要文件路径，桌面没文件选择器）
4. **桌面环境关闭 QR Code/URL**

---

## 三、开发流程（按时间序）

### 阶段 0：双重审核 + 可行性分析
让 Codex + superpowers 两个 AI 审核员独立评估方案，确认技术可行性高，主要风险在 PyInstaller 打包资源遗漏 / WebView2 分发 / SVG XSS。

### 阶段 1：项目骨架（半天）
- `app.py`（27 行）+ `backend.py`（~230 行）+ `web/` 三视图 UI
- `pyproject.toml` 用 uv path 引用本地 boxes-1.2/boxes-master
- 烟雾测试：179 个生成器加载成功，ABox 渲染 22 KB SVG

### 阶段 2：保存导出 bug
**问题**：保存 PDF 报"参数解析失败: 2"（argparse exit code）
**根因**：系统没装 pstoedit/ps2pdf，boxes `--format` choices 只接受 base 格式
**修**：list_formats 自动检测；拦截 argparse error 钩子返回友好消息

### 阶段 3：UI 增强 + 中文化
#### 4 级翻译链
boxes 上游 1.2 的 help 加了 "in multiples of thickness"，旧 zh_CN.po 翻译失配。`tr()` 实现：
```
原文 → ① 客户端字典 _EXTRA_TR  → ② gettext (.po)
     → ③ 剥离 markdown 链接  → ④ 剥离 "in multiples of thickness"
```
覆盖率 **98.19%**（5570 个参数中只有 101 条未翻译）。

#### 作品图覆盖
- 169 个生成器有上游官方实物照片
- 10 个无图 → 自渲染 SVG 兜底（带"示意图"角标）
- **不联网搜图**（版权 + 准确性问题）
- 覆盖率 **100%**

#### 边缘字符代码翻译
boxes 用单字符 (e/f/F/i/...) 做选项值，UI 不直观。用 `boxes.edges.getDescriptions()` 映射为描述并翻译为中文，UI 显示 `直边（e）` 这种格式。

### 阶段 4：UI 多次迭代
按用户反馈：
- 「返回画廊」改气泡按钮 + 面包屑导航
- 编辑器顶部加二级面包屑「← 主页 › ← 分组名」
- 参数标签从「英文名 + 下方 help」改为「中文 help（英文名）+ 默认值」
- 左侧菜单 + 卡片改 「中文（英文）」格式
- 隐藏 format/output 表单字段（避免与编辑器顶部下拉重复）

### 阶段 5：品牌化
- 主品牌名 → SeedBoxes
- 主页底部加 GPL-3.0 attribution + 上游链接
- 左上角 SeedBoxes 彩色 logo + 主页底部 makerseed logo
- 窗口图标 + .exe 图标用 logo.ico

### 阶段 6：双重审核 + 修复
完成基本功能后再让 Codex + superpowers 审核，发现 **2 Critical + 7 Important** 问题：

**Critical**：
- `_boxes_root()` 在 frozen 模式找不到 static/locale → 检测 `sys.frozen` + `_MEIPASS`
- spec 没拷贝 `boxes-master/static/` + `locale/` → 显式 `extra_datas`

**Important**：
- `cls.UI = "desktop"` 致 TypeTray 暴露错误参数 → 改 `cls.UI = "web"`
- `_render_fallback_svg` 用 SystemExit 可能终止进程 → 自定义 `_ArgparseError(ValueError)`
- 渲染异常未清理 surface/ctx → 加 `try/finally` + `_close_quietly()`
- `_RENDER_CACHE` 无淘汰 → `OrderedDict` LRU 上限 64
- `tr()` 重复计算 → `@lru_cache(maxsize=4096)`
- `_init_generators` 无双检查 + 无 per-generator 异常隔离 → 锁外快返回 + `_FAILED_GENERATORS` 记录
- spec hidden imports 缺 pythonnet/clr_loader/bottle → 全部 `collect_all`
- `selectGenerator` 快速切换的请求竞态 → 加 `state.reqId`
- `mountSvg` 用 `innerHTML` → DOMParser + 移除 `<script>` 和 `on*`
- 没有 CSP → 加 `Content-Security-Policy` meta

### 阶段 7：PyInstaller 打包
首次打包 `ModuleNotFoundError: No module named 'shapely.ops'`。修：spec 用 `_safe_collect()` 工具 + 显式列出关键 C 扩展子模块。最终 `dist\SeedBoxes.exe` 约 100 MB。

### 阶段 8：Cython 加密路径预备
按用户选 Cython（强度 ★★★★）。文件就位：
- `setup_ext.py`：编译配置（关闭 docstring/注释）
- `build_pyd.bat`：一键编译
- `install_msvc.bat`：MSVC Build Tools 安装辅助
验证：`backend.py → backend.cp310-win_amd64.pyd`（186 KB）+ 全部 API 测试通过。

### 阶段 9：迁移 + git 仓库
从 `D:\Apps\boxes.py\客户端版本\` → 重命名为 `D:\Apps\boxes.py\SeedBoxes\`：
- pyproject.toml: path → `git URL @release-1.2`
- spec: 硬编码路径 → `importlib.util.find_spec('boxes')` 自动检测
- 加 LICENSE / README.md / DEVELOPMENT.md / CLAUDE.md
- `.gitignore` 完善
- git init + 首次 commit + tag v0.1

### 阶段 10：macOS 支持 + 资源修复
- `open_folder` 按平台分支（macOS 用 `open -R` 在访达中定位文件）
- `app.py` 开发模式用 AppKit 设置 Dock 图标
- `SeedBoxes.spec` 按平台分支：macOS 走 onedir + `BUNDLE` 生成 `SeedBoxes.app`，不再收集 pythonnet / clr_loader
- 新增 `run_mac.sh` / `build_mac.sh`
- **修复**：阶段 9 改为 git URL 引用 boxes 后，`uv.lock` 没有重新生成（仍指向本地 `../boxes-1.2/boxes-master`），且 git 安装的 boxes 不含 `static/`，新克隆的仓库会变成英文界面 + 无作品照片。现已重新 `uv lock`，并新增 `scripts/fetch_boxes_assets.py` 按锁定 commit 下载 `static/` + `locale/`
- `build_uv.bat` 引用了不存在的 `BoxesClient.spec`，改为 `SeedBoxes.spec`
- 新增 `.gitattributes`：`.bat` 强制 CRLF，`.sh` 强制 LF

### 阶段 11：3D 模型 + 局部修改（参考 Laserform 的交互）
- 需求：现有生成器做到 Laserform 那样的 3D 可视化，并能局部修改（开孔、刻字、禁用板、存项目）
- Laserform 无开源许可，只借鉴交互思路，代码全部自写
- 关键发现：boxes 的 Surface 本来就把每个零件存成独立 Part；挂钩 move 记录坐标系即可拿到每块板的精确轮廓（含卡榫），3D 与图纸几何完全一致
- 5 个常用方盒写了组装配方；其余生成器显示板件平铺
- 局部修改在 boxes 渲染管线内注入，所有输出格式都生效；中文字用 fontTools 读系统字体转轮廓
- 修复原有 bug：参数按 dest 名拼命令行，TypeTray 的 gh / gw（实际选项 --gripheight / --gripwidth）报「参数无效」
- 新增浏览器调试模式（scripts/dev_server.py），用 Chromium 截图核对 3D 拼装

### 阶段 12：自动装配（试验）
- 163 个生成器分四类：方形板盒柜（可自动装配）/ 多边形多面体（需单独配方）/ 柔性铰链盒（需弯曲）/ 单件与机构（平铺即正确）
- 只按尺寸匹配会误判（Rotary、OrganPipe 都能「匹配」），所以加了碰撞校验：板边缘带密集取样，检测板与板之间穿透和接触
- 逐板试放 + 多轮重试 + 连通检查；四面墙缺一面时自动转向让开口朝前
- 逐个截图人工复核，9 个形状不对的放进 AUTO_DENY；最终 36 个生成器能显示拼装
- 顺带修复：整数参数 "100.0"（Keypad）报错；切换生成器时 3D 用了上一个生成器的表单参数

### 阶段 13：手动摆放 + 实时校准
- 交互参考 Tinkercad（以及开源的 SketchForge-3D，AGPL-3.0，只参考交互、未复用代码）
- 拖动台面移动、黑色锥形手柄升降、三色弧形箭头旋转（90° / Shift 15°），吸附 0.5 / 1 / 板厚 / 5 mm，方向键、Ctrl+↑↓、R、D、Ctrl+Z / Ctrl+Shift+Z、Esc
- 放下后调用 check_pose：穿透标红，清单显示「咬合 n / 穿透 n / 未接触」，汇总提示以最大连通分量为主体
- 摆放位置保存进项目文件；参数改变后提示可能需要重新调整
- 第二版（用户反馈「效果一般」后，研读 SketchForge-3D 的 WorkplaneViewport 交互设计重写，代码自写）：
  - 鼠标分工改为 Tinkercad 方式：左键只选择 / 拖动 / 框选，右键转视角，中键或 Ctrl+左键平移，滚轮朝光标缩放
  - 手柄改成固定屏幕大小、放在朝相机一侧的小锥体 + 三段短弧箭头；旋转时显示量角器（45° / Shift 22.5°）
  - 拖动 / 升降时与其他板的包围盒边界对齐吸附（青色参考线，Alt 关闭）；拖回装配位置附近自动磁吸
  - 悬停高亮、光标提示；板件清单可收起，3D 画面中心右移让出清单；快捷键说明收进「⌨ 快捷键」面板
- 待做：把手动摆放「存为装配规则」，让改参数后位置自动跟随

---

### 阶段 14：深度集成 SketchForge 编辑器
- 用户反馈自写的摆放交互“效果一般”，决定维护 SketchForge-3D 改版（AGPL-3.0）：Next.js 静态导出，补丁加 postMessage 桥接、嵌入时「主页」返回、Home 视角自动框住模型、运行时中文词典（约 500 条）
- 资源路径是绝对路径，所以由后端单独起本地静态服务器（固定端口 47321）再 iframe 嵌入
- 打开时导入启用的板件；编辑后用 3 个参考顶点反求刚体变换写回 poses（SketchForge 会把旋转烘焙进网格，所以不能只读 rotation 字段）；关闭后进入摆放模式做咬合检查
- 「☰ 板件」按钮隐藏 / 显示板件清单（记在 localStorage）

## 四、关键设计决策详解

### 为什么不 fork boxes 上游？
- 上游持续更新，fork 同步成本高
- 客户端代码完全独立（PyWebView + 调用 boxes API）
- git URL 依赖能锁版本又能升级

### 为什么不用 Electron / Tauri / Qt？
- Electron：内置 Chromium 200+ MB，浪费
- Tauri：Rust 后端 + 子进程跑 boxes，更复杂
- Qt：Qt 6 学习成本 + 体积大
- PyWebView 最契合「Python 后端 + Web 前端」

### 为什么 cls.UI = "web" 而不是 "desktop"？
boxes 源码大量 `if self.UI == "web":` 判断决定参数（如 typetray.py:111）。设非 "web" 会让 TypeTray 暴露 `label_file`（要文件路径，桌面没选择器对接）。`cls.UI = "web"` 是上游 boxesserver 的标准做法。

### 为什么自渲染图用 SVG 而非 PNG？
- SVG 是 boxes 原生格式，零额外依赖
- 体积小（10 个图 < 5 MB）
- 浏览器原生支持

### 为什么 logo 是深色 / 白底背景？
SeedBoxes logo 含 `#FBF6EC` 浅色 + `#FF5A0A` 橙色 + `#127bd4` 蓝色。最初白底 + 白 logo 看不清，改为白底 + 浅灰边框（彩色 logo），makerseed 黑色 logo 直接展示在 sidebar 米色底。

### 为什么不联网搜图？
- 版权风险
- 准确性失控（搜 "Keypad" 可能搜到数字键盘）
- 自渲染图 100% 真实匹配

---

## 五、已知限制 + 未来工作

### 当前限制
- **未签名**：SmartScreen 首次运行弹"未知发布者"
- ~~**Windows-only**~~：阶段 10 已加 macOS 支持（Linux 理论可用，未测试）
- **依赖系统 WebView2 Runtime**：Win10/11 默认有，老 Windows 需手动装
- **桌面客户端不支持多语言切换**（写死 zh_CN）

### 未来可做
1. **代码签名**（消除 SmartScreen 警告）— OV 证书 ¥2000+/年
2. **Cython 加密发布**（已就绪，跑 build_pyd.bat 即可）
3. **自定义生成器**：`boxes/generators/_custom/` 子目录自动发现
4. **导出预设管理**：常用参数组合保存为 .json
5. ~~**跨平台**~~：macOS 已完成（阶段 10）；Linux 待测
6. **激光切割机直连**：通过串口发送 GCode

---

## 六、协作模式

### 用户负责
- 提供素材（logo SVG、品牌名、需求场景）
- UI 截图反馈具体细节
- 决策路径选择
- 测试客户端实际效果

### AI 负责
- 代码实现 + 烟雾测试
- 双重 AI 审核（Codex + superpowers）+ 交叉验证
- 写文档

### 工具链
- Claude Code：主开发
- Codex：技术准确性审核
- superpowers (code-reviewer)：严格代码质量审核

---

## 七、致谢

- [Florian Festi](https://github.com/florianfesti) — boxes.py 原作者
- 上游 zh_CN 翻译贡献者：裘炯涛 \<qiujiongtao@163.com\>
- AUGClaw 项目作者（架构参考）

© makerseed 种子创客工坊
