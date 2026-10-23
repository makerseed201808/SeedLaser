# 3D 编辑器（SketchForge-3D 改版）

SeedBoxes 的「🛠 3D 编辑器」是 [SketchForge-3D](https://github.com/Formsmith746/SketchForge-3D)
（AGPL-3.0-only）的改版，嵌在 3D 模型视图里使用。

- 上游：https://github.com/Formsmith746/SketchForge-3D ，基于提交 `e9cb8e8`
- 改动：`seedboxes.patch`（全部改动都在这个补丁里）
  - `?embed=seedboxes` 时通过 `postMessage` 接收 SeedBoxes 的命令（与 SketchForge MCP 命令集相同：
    `get_scene`、`import_mesh`、`update_object`、`delete_objects`…），场景变化时通知父窗口；
  - 「主页」按钮在嵌入时返回 SeedBoxes；
  - 主页视角（Home / F）自动框住较大的模型；
  - 激光模式（`lib/seedboxesEmbed.ts`）：嵌入时只保留装配检查用的工具——删除、撤销重做、显示 / 隐藏、对齐、落到台面、移动 / 旋转 / 升降手柄、标尺；隐藏形状库、草图、组合运算、修改（倒角 / 圆角 / 镜像）、导入导出、属性面板和缩放手柄，并屏蔽对应快捷键（这些改动不会影响切割图纸）；
  - `public/seedboxes-zh.js`：运行时简体中文界面（词典 + DOM 监听，不改组件源码，方便合并上游）。
- 构建产物：仓库根目录 `web_sketchforge/`（已提交，桌面端运行时不需要 Node）。
  重新构建：`bash sketchforge/build.sh`（需要 git、Node.js 20+）。

## 运行方式

`backend.py` 在首次打开编辑器时，用 Python 内置 HTTP 服务器把 `web_sketchforge/` 挂在
`http://127.0.0.1:47321/`（端口被占用时用随机端口），前端用 iframe 嵌入
`/?editor=1&embed=seedboxes`。SketchForge 的资源路径都是绝对路径（`/_next`、`/occt`），
所以必须单独占一个源（origin），不能放进 `web/` 子目录。

## 数据流

1. 打开：`workshop.js` 把启用的板件（含开孔）按当前摆放转成三角网格，用 `import_mesh` 导入
   （整体平移到工作平面中央、底面贴地）。模型 / 编辑 / 禁用没变时再次打开不会重新导入，
   在编辑器里另外加的形状会保留。
2. 回读：每块板记 3 个参考顶点；编辑器里移动 / 旋转后，用这 3 点前后的位置反求刚体变换，
   换算回 boxes 坐标，写进项目的 `poses`（与「✋ 摆放」共用，随项目保存）。
3. 在编辑器里删除一块板 = 板件清单里取消「使用」（不导出）；撤销删除会恢复。
4. 关闭后自动检查卡榫咬合 / 穿透，结果显示在板件清单和提示条里。

## 许可证

SketchForge-3D 以 AGPL-3.0-only 发布；分发包含它的 SeedBoxes 时，须同时提供对应源码
（上游地址 + 提交号 + `seedboxes.patch` 即构成完整对应源码）。许可证全文见
`web_sketchforge/LICENSE.SketchForge.txt`。
