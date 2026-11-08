# CLAUDE.md

> 给 Claude Code（或其他 AI 助手）的项目说明。
> 详细开发历程见 [DEVELOPMENT.md](DEVELOPMENT.md)。

---

## 新 session 快速上手

**当前状态（2026-11-07）**：在分支 `feat/3d-model` 开发（比 main 多 33 个提交，**未推送**，push 前先问用户）。
二维编辑器 + 自由设计二维画板 + 3D 装配校验已成型。**产品定位、计划、开发要求和验收标准见 [docs/ROADMAP.md](docs/ROADMAP.md)——开工前必读。**
之前的工作在 Cowork 云端会话里完成（用浏览器 + Playwright 验证）；端到端冒烟脚本已放进 `tests/e2e/`（`tests/e2e/run.sh`）。

**改名（2026-11-07）**：产品改名 **SeedLaser**（界面、窗口标题、打包产物 SeedLaser.app / SeedLaser.exe、Logo 文字、文档）。**内部保持兼容**：仓库 / 文件夹名、pyproject 包名、项目文件扩展名 `.seedbox.json`、localStorage 键 `seedboxes.*`、postMessage `seedboxes:*`、logo 文件名都没改；打开项目同时认 `app: SeedBoxes / SeedLaser`，新保存写 `SeedLaser`。
**结构**：主页（#home：新建设计 / 快速建模 / 打开项目 + 最近项目 + 示例）→ 「设计」= FreeDesign 的三个板块（① 二维设计 ② 3D 装配 ③ 加工作业）；原 SeedBoxes 生成器 = 「快速建模」模型库（#welcome / #browse / #editor，左侧栏只在这里显示），模型页「放进设计 →」(workshop.importToDesign) 把板件 + 装配矩阵放进设计（板件局部坐标 = 模型轮廓坐标，poses = 模型 matrix）；在设计里中途去快速建模再放 = 放进当前设计（W.freeStash）。最近项目存 `~/.seedlaser/recent.json`（backend.recent_projects / open_project_path）。
**画板 id 约定**：composeSheet 给每个图形 id 加「板件id§」前缀保证整张画板唯一，applySheet 存回时去掉（以前各板都叫 outline 会串板）。

**第一次进 session 要做的事**：
1. `git status` 确认仓库状态
2. `cat README.md` 了解用户视角
3. 阅读本文件下面的「关键架构事实」和「反模式」章节
4. 读 docs/ROADMAP.md（定位 / 计划 / 每次必做的测试与验收）
5. 按需 `uv sync` 拉依赖（首次 2~3 分钟，国内可能需要镜像）
6. `uv run python scripts/fetch_boxes_assets.py` 下载上游 static/ + locale/ 到 boxes_assets/（否则无作品照片）

**用户场景**（K12 STEAM 教育，种子创客工坊）：
- 给学生/教师用，零门槛，必须中文界面
- 完全离线（教学场景常无网）
- Windows 单 .exe 分发（主要）；macOS .app（开发 + 可选分发）
- 后期可能：自定义生成器 / 预设管理 / 激光切割机直连

**用户偏好**：中文回复；注释中文可以；commit 信息近期用中文（feat(sketch)/fix(free) 前缀 + 中文说明）；大改动用双重 AI 审核；界面术语统一（切割 / 雕刻 / **描线**（不叫划线）/ 卡榫 / 插槽 / 连接点）；任务要「做深」不要「扩大」。

---

## 待办任务

当前开发计划（A 线：二维基本功打磨；B 线：连接与定位）见 **docs/ROADMAP.md**。

发布相关（远期）：
- Cython 加密发布（脚本已就绪：`build_pyd.bat` → `build_uv.bat`；回退：`backend.py.src` 改回 `backend.py`，删 `.pyd`）
- 代码签名：未签名会弹 SmartScreen / Gatekeeper 警告

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

## 术语表（界面文字统一用这些词）

| 用词 | 意思 / 用法 | 不要再用 |
|---|---|---|
| 切割 | 加工方式：激光切穿（黑 = 外轮廓，蓝 = 内孔） | — |
| 雕刻 | 加工方式：激光在表面刻出图案 / 文字（绿） | 蚀刻、刻字（说「文字」） |
| 描线 | 加工方式：只在表面划一道线，不切穿（品红） | 划线、刻线 |
| 板件 | 一块要切出来的板（画板上最外层的闭合切割轮廓 = 一块板件） | 零件（指板时）、板子 |
| 材料 | 放在激光机台面上的整张板材；「材料（激光机台面）尺寸」 | 板材、板料 |
| 板厚 | 材料厚度，卡榫深度 / 插槽宽度都按它 | — |
| 卡榫 | 指接卡榫：板边上的齿（A 边）和对应的凹槽（B 边） | 榫卯结构、卡扣 |
| 凹槽 | 卡榫的 B 边（和 A 边的齿互补） | — |
| 插槽 | 板面上的一排孔，让另一块板的 A 边插进来（T 型连接） | 槽孔 |
| 水口 | 切割线上留一小段不切，板件切完还连在材料上 | 连接点 |
| 对象原点 | X / Y / 宽 / 高 / 旋转的参考点（9 个位置，默认左上角） | 参考点（界面上） |
| 激光补偿 | 按切缝把外轮廓外扩、内孔内缩的量（burn） | 切缝补偿 |
| 卡榫测试样 | 新机器 / 新材料先切的校准样，量出切缝、板厚、插槽松紧 | 卡扣测试样 |
| 二维画板 → 3D 装配 → 加工作业 | 三个阶段的名字（顶部 ① ② ③） | 生成 3D · 去装配 |
| 校准尺 | 导出图纸里 100 mm 的参考尺 | — |

上游 Boxes.py 的通用词（比如生成器分类「零件与示例」里的「零件」= 齿轮、铰链这类机械零件）不在此列。改界面文字时先查这张表；`tests` 里不要按旧叫法选元素。

## 文件结构

```
SeedBoxes/
├── app.py                  PyWebView 入口
├── backend.py              JS↔Python 桥接 API（核心业务）
├── model3d.py              3D 模型 / 局部修改（见上节）
├── web/                    前端
│   ├── index.html / app.js / styles.css
│   ├── workshop.js         3D 视图 + 板件清单 + 单块板编辑器
│   ├── dev-bridge.js       浏览器调试桥（?dev=1 时生效）
│   ├── vendor/three/       three.js r169 + OrbitControls（MIT）
│   ├── seedboxes-logo.svg  主 logo
│   └── makerseed-logo.svg  种子创客工坊标识
├── pyproject.toml          uv 项目（boxes 通过 git URL @release-1.2 引用）
├── uv.lock                 依赖锁文件
├── SeedLaser.spec          PyInstaller 配置（importlib 检测 BOXES_ROOT）
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

## 3D 模型 / 局部修改（model3d.py + web/workshop.js）

- **零件捕获**：渲染时用实例属性覆盖 `move` / `rectangularWall`（`model3d.Recorder`），记录每个 Part 的 `ctx._m`。rectangularWall 的「名义（内部）矩形」原点 = 起笔点 + (左边 spacing, 底边 margin + 底边 startwidth)——boxes 的边线画在内部空间外 startwidth 处
- **组装配方**：`SUPPORTED_3D` 里的 5 个方盒按标签（front / Wall 1 …）或「边类型 + 尺寸」分配到面；TypeTray 隔板按 sx / sy 算位置。`_FACES` 给出每个面的 (u, v, w) → 世界坐标映射。boxes 约定：四面墙和底板按「从盒内看」画，顶板按「从上方看」画（由 TypeTray 孔位一致性推得）
- **mirror**：从盒内看画的板，编辑器以「从外面看」显示；导出时有修改的板会整块翻面（`apply_project`），保证刻字面朝外组装、几何不变
- **编辑坐标**：从外面看，原点 = 内部矩形左下角，mm，y 向上；文字由 `fontTools` 读系统中文字体转轮廓（`_font_candidates` 按平台列字体，项目 `fonts/` 目录可放自带字体）
- **导出**：切割孔 = INNER_CUT 蓝色（按 burn 内收），雕刻 = ETCHING 绿色；禁用的板从 `surface.parts` 移除
- **3D 用 burn=0 渲染**；重叠的孔用 shapely 合并（TypeTray 提手孔与卡榫孔重叠）
- **前端是 ES 模块** → 必须走 pywebview 内置 HTTP 服务器（`http_server=True`），file:// 会拦截模块
- **调试**：`scripts/dev_server.py` + `web/dev-bridge.js`（`?dev=1`）在浏览器里跑整个前端
- 新增生成器的 3D 拼装：在 `SUPPORTED_3D` 加名字，确认 `_box_dims` 和标签映射；用 dev_server 截图检查卡榫是否咬合
- **自动装配（试验）**：没写配方的生成器走 `auto_assemble`——按 rect 板尺寸推断 X/Y/H（取前 8 个候选），多轮逐板试放到 6 个面（含旋转 90°、翻面），`_Solid.hits` 在板边缘带取样做穿透 / 接触检测，要求零穿透、≥4 块、全部连通；选放上板最多、体积最大的方案；四面墙只缺一面时整体转向让开口朝前。目前 31 个通过（另 5 个配方，共 36 个拼装）
- **手动摆放**（workshop.js 的 `Poser`，交互参考 Tinkercad / SketchForge，代码自写）：位置存 `W.project.poses[id]`（16 位列主序矩阵，boxes 世界坐标），只影响 3D、不影响导出；`get_model` 返回 `token`，后端缓存几何，`check_pose(token, poses, ids)` 用 `pose_report` 返回每块板的穿透 / 接触；`?dev=1` 下有 `window.__seedDebug` 供自动化测试
- **二维草图**（web/sketch2d.js + sketch2d.py，paper.js）：`project.sketches[part id] = {base, items:[{id, mode: cut|engrave|score, role?: 'outline', locked?, text?, paths:[{closed, segs:[[x,y,inx,iny,outx,outy]]}]}]}`，「从外面看」坐标、y 向上；有草图的板导出时整块替换（切割闭合路径成实体：**只有完全落在另一个轮廓里、边界不相交的才是孔，交叉的轮廓取并集**——sketch2d.cut_solid 与前端 SketchEditor.loopDepths 规则一致；按 burn 外扩），3D（buildSketchPart）和 check_pose(…, sketches) 都用草图轮廓；旧的 edits 在打开编辑器时迁移进草图；草图和原图一样时不保存；`base` 是原始轮廓签名，参数改后提示。编辑器打开时把 3D 画布挪进右下角预览框（attachView）
- **自由设计**（freedesign.py）：注册为特殊生成器 `FreeDesign`（不进分组），表单只留 thickness / burn / reference；板件在 `project.free.parts`（id、name、w、h），形状在 `project.sketches`；`get_model(name, params, project)` 直接由草图生成零件（平铺），`_render` 对它走单独分支（不用 Recorder / apply_project）
- **自由设计磁吸**（sfTrySnapFree / mateOptions）：草图 item.joints = [{type: a|b|slot|mortise, iv（A 齿区间，沿边 mm，居中对称）, k（A 齿数）, depth, L, mode: count|width, count, tab, gap, play?, a, b, c(=a+朝外法线)}]；配对比较 iv（正向或反向）；旧数据只有 k（段数）时按奇数段推算；卡榫 / 插槽工具单击已有的可修改（先 straightenEdge 恢复直边再重做），随图形变换（sketch2d.js hookJoints 包装 item.transform）；按板件局部坐标构造目标帧（只取行列式同号的真旋转），乘以另一块板当前摆放；范围 25 mm / 35°
- **自由设计自动拼装**（freeAutoAssemble）：卡榫最多的板做基准，逐对挑候选姿态（check_pose 不穿透 → 接触多 → 离已拼部分近，第一块优先往上）；**排版**（freedesign.nest）：天际线左下角法，允许 90° 旋转，sheet_w/sheet_h/part_gap 是 FreeDesign 的参数，结果说明放在预览返回的 info
- **磁吸**（workshop.js sfTrySnap）：相邻关系 = 默认摆放下 check_pose 的 touch / collide；目标 = A 当前 · A 默认⁻¹ · B 默认；中心 10 mm / 20° 内且正在靠近才吸附；吸附后在编辑器里删掉旧网格重新导入
- **二维编辑进阶**：导入在 web/sketch-import.js（DXF 解析、图片在浏览器里二值化成矩形）+ 后端 sketch2d.trace_rects（shapely 合并，不依赖 Pillow）；文字排版 sketch2d.text_layout（逐字形、圆弧 / 沿路径、焊接）；连接点存 item.bridges，导出时 cut_polylines 在连接点处断开（缺口 = 宽度 + 2×burn）；共边切割 freedesign common_line（间距 = 2×burn，dedupe_lines 去重叠线）；item.transform 被包装（hookJoints）：卡榫、连接点、可编辑文字的参数跟着变换（非平移时文字转成路径）；参考线 / 连接点宽度存在草图根上（guides / bridge_w）
- **自由设计二维画板**（sketch2d.js sheetMode + workshop.js composeSheet / applySheet / openSheet）：首页「自由设计」直接进画板，part.sheet={w,h}（存 project.free.sheet）。recognizeParts：最外层闭合切割轮廓（loopDepths 深度为偶数）= 一块板，其余图形按包围盒中心归最内层的板，归不进去的存 free.loose（不导出）。板件轮廓 item 带 `pid` 和 `origin=[x,y,角度]`：整块平移 / 旋转时 origin 跟着变（排版），改节点 / 缩放不动（改形状）；存回时按 origin 把坐标变回板件局部坐标 → free.parts[{id,name,w,h,sx,sy,sa}]。**排版位置和 3D 装配位置互相独立**：freedesign.model_parts / render 用 sx,sy,sa；装配 / 吸附后所有参与的板都写 W.project.poses（自由设计不因「等于平铺矩阵」而删 pose）
- **跨板卡榫配对**：画板里卡榫工具先点 A 边（做 A 齿）→ 自动切到 B 型并带 jointPeer → 再点另一块板的边，两个 joint 写同一个 `pair` id；freeAutoAssemble 中带不同 pair 的不配
- **二维交互约定**：新图形和已有图形交叉 → 暂作描线并弹窗（切割 / 雕刻 / 描线 / 并入板 / 从板上减去）；交叉的两个切割轮廓重叠区标淡红（实际会切出单独小块）；单选形状运算 = 和重叠图形运算（差集：选中的当「刀」切掉别人、刀删除；交集：选中的只留重叠；并集：合并，沿用带 pid 的那个；异或仍需 Shift 选 2 个）；Ctrl/⌘ 拖动画正圆 / 正方形；renderToolOpts 重画前先 blur 正在输入的框（否则改文字不生效）
- **3D 编辑器同步**：打开时 sfSceneComplete 校验每块启用的板都在场景里，缺了就重新导入；编辑器里删掉的板只从装配场景拿走（不改「使用」），下次打开放回
- **加工参数**：app.js state.laser（localStorage + 项目文件），save(…, laser) 时 backend._write_laser_sheet 写 `<图纸名>_加工参数.txt`
- **3D 编辑器**（SketchForge-3D 改版，AGPL-3.0，详见 `sketchforge/README.md`）：`backend.sketchforge_url()` 首次调用时用 http.server 把 `web_sketchforge/` 挂到 127.0.0.1:47321（占用则随机端口）；workshop.js 用 iframe（`#sf-host`，全窗口）+ postMessage（`seedboxes:command/result/ready/changed/home`，命令同 SketchForge MCP）驱动。导入：板件三角网格（含开孔）整体平移到原点、底面贴地（`SF.off`）；回读：每块板 3 个参考顶点反求刚体变换 → `W.project.poses`。改界面文字：`sketchforge/` 里改补丁中的 `public/seedboxes-zh.js` 词典后 `bash sketchforge/build.sh` 重建；index.html 的 CSP 需保留 `frame-src http://127.0.0.1:*`
- `AUTO_DENY`：能通过校验但人工看过形状不对的（HingeBox、OrganPipe、Rotary、PirateChest、Arcade、CanStorage、CoinDisplay、DiceBox、WallRack），继续平铺
- 校验器自检：5 个配方方盒全部 0 穿透；把前板上移 1.5mm 能检出 84 个穿透点

---

## 关键架构事实（修改前必读）

1. **不修改 boxes 上游源码**。所有定制在 backend.py / web/
2. **`cls.UI = "web"`** 必须在 `_init_generators()` 时设到类属性 — boxes 生成器的 `__init__` 中读 `self.UI` 决定参数
3. **`tr()` 4 级翻译链** — 每级都有真实命中场景，不要短路；gettext 这一级的数据源是 `i18n/zh_CN.po`（上游 master 的较新翻译，运行时由 `_parse_po` 直接解析）优先，回退到 boxes 自带 .mo。release-1.2 自带翻译只覆盖 ~39%，换用 i18n/ 后 ~98%（993/1013）
4. **`_render_lock`** 保护 `Boxes.ctx` — boxes 实例非线程安全
5. **PyWebView API 在独立线程跑** — 任何全局可变状态需要锁
6. **打包资源关键**：spec 必须显式 `extra_datas` 拷贝 `static/` 和 `locale/`，否则 frozen 后样图 + 中文翻译全失效。git 安装的 boxes **不带 static/**，locale 的 .mo 装在 `<venv>/share/locale`；统一用 `backend._find_asset_dir()`（spec 里有同顺序的 `_find_asset`）查找，优先 `boxes_assets/`
7. **format/output 字段**：从生成器表单中**隐藏**（编辑器顶部已有专门下拉框 + 保存对话框），但 `_params_to_args` 还要 skip 一遍
8. **跨平台分支**：`open_folder` 按 `sys.platform` 分 Windows（startfile）/ macOS（open -R）/ Linux（xdg-open）；图标 Windows 用 Win32 `WM_SETICON`，macOS 用 AppKit 设 Dock 图标；spec 按平台分 onefile .exe / onedir + BUNDLE .app

---

## 常用操作

```bash
# 浏览器调试（不开窗口）：http://127.0.0.1:8765/index.html?dev=1 ，window.__seedDebug 可访问 W / view / sketchEd / SF …
.venv/bin/python scripts/dev_server.py 8765
# 端到端冒烟测试（需 playwright，见 tests/e2e/README.md）
tests/e2e/run.sh
```

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
7. **release-1.2 自带的 zh_CN 翻译过时** — 已用 `i18n/zh_CN.po`（上游 master，pinned commit 见 i18n/README.md）覆盖，spec 会打包 i18n/
10. **release-1.2 的生成器 / 照片数比旧 boxes-master 少** — 实测分组内 163 个生成器，145 个有照片、18 个自渲染
9. **连不上 GitHub 的电脑** — 在能访问 GitHub 的机器上跑 `scripts/make_boxes_mirror.sh` 生成 `third_party/boxes.git`（gitignore，约 30 MB），连同文件夹拷过去；`run_mac.sh` / `build_mac.sh` 检测到 GitHub 不通时用 `GIT_CONFIG_*` 环境变量把 boxes 的 git URL 临时改写到本地镜像（不改全局 git 配置）。`SEEDBOXES_USE_MIRROR=1` 可强制使用。Windows .bat 尚未接入
8. **macOS .app 未签名** — Gatekeeper 拦截，需右键打开；产物架构随打包机

---

© makerseed 种子创客工坊 · GPL-3.0-or-later
