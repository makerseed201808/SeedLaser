# 端到端冒烟测试（Playwright）

在浏览器里用 `?dev=1` 跑整个前端（`scripts/dev_server.py` + `web/dev-bridge.js`），按学生的操作顺序走一遍，打印关键数据并截图。
目前是「打印 + 截图」式的冒烟脚本，还不是断言式测试——**把它们改成带断言的测试是待办**（见 docs/ROADMAP.md）。

```bash
uv pip install playwright && .venv/bin/playwright install chromium   # 首次
tests/e2e/run.sh            # 全部
tests/e2e/run.sh keep1      # 单个
```

| 脚本 | 覆盖 | 期望输出 |
|---|---|---|
| sheet1 | 自由设计画板：画两块板、跨板卡榫配对、生成 3D、自动拼装、按画板位置导出、改材料尺寸 | `识别到 3 块板`；第二次点边提示「已配对 ✔」；`poses` 非空；`sheet {"w":500,...}` |
| keep1 | 排版位置和 3D 装配位置互相独立（挪板、旋转、加宽左边） | `pose same True`；右侧顶点不变；`sa` 出现 90 |
| drag1 | 拖动时板面跟随 | 两个数相等（轮廓左边 = 板面左边） |
| ov1 | Ctrl 画正圆；交叉时弹出选择；选「切割」 | `['score', 38, 38, True]`，之后两个 cut |
| tx1 | 修改文字后直接点画布生效；文字自身不标红 | `red lens 0`，`['种子创客']` |
| bool1 | 单选差集 = 刀 | 只剩一块板，面积 < 6000 |
| bh | 形状运算按钮悬停示意图 | 无报错，4 张截图 |
| fit1 | 🧪 卡扣测试样：生成 → 后端按补偿算切割线，断言 9 条槽宽 / 方块尺寸；填测量结果 → 应用 | `PASS fit1`（带断言） |
| rot1 | 旋转手柄：单击弹框输入角度（正数逆时针）；左右拖动微调（向右顺时针，2 像素 1°）；撤销 | `PASS rot1`（带断言） |
| layers1 | 图层卡片默认收起，点左下角色块展开 / 再点收起 / ✕ 收起 | `PASS layers1`（带断言） |
| panels1 | 右侧功能卡片随左侧「对齐 / 运算 / 阵列 / 变换」显示，画布仍可选择，再点或换工具收起 | `PASS panels1`（带断言） |
| radial1 | 右键圆形快捷菜单：空白处 = 画图工具，右键图形 = 选中 + 编辑命令，中间重复上一个，Esc 关闭，右键拖动仍平移 | `PASS radial1`（带断言） |
| line1 | 直线 / 曲线工具按右键结束（不弹快捷菜单），平时右键仍是快捷菜单 | `PASS line1`（带断言） |
| thick1 | 二维画板改板厚：同步左侧参数；旧板厚做的卡榫提醒并一键重做（一步撤销）；卡榫工具里也提醒 | `PASS thick1`（带断言） |
| stage1 | 自由设计三个板块：① 二维设计 → ② 3D 装配（无板件清单）→ ③ 加工作业（加工清单 + 排版，取消一块后图纸变小）→ 回到设计 | `PASS stage1`（带断言） |
| home1 | SeedLaser 主页三入口；快速建模 ABox「放进设计」：5 块板 + 装配位置带过来、无穿透；设计中途再放 = 放进当前设计 | `PASS home1`（带断言） |
| sf5 | 3D 编辑器里删板 → 不改「使用」，再打开自动补回（需要 web_sketchforge 和 WebGL） | `disabled []`，`scene objects after reopen 4 map 4` |

另有前端纯函数单元测试：`node tests/js/fit_calc.test.mjs`（卡扣测试样换算，含「以后切出的插槽 = 测试中最合适那条槽」不变量）。

后端测试：`.venv/bin/python tests/py/test_recent.py`（最近项目、打开 SeedBoxes 时期的旧项目）。
