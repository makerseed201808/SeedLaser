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
| sf5 | 3D 编辑器里删板 → 不改「使用」，再打开自动补回（需要 web_sketchforge 和 WebGL） | `disabled []`，`scene objects after reopen 4 map 4` |

另有前端纯函数单元测试：`node tests/js/fit_calc.test.mjs`（卡扣测试样换算，含「以后切出的插槽 = 测试中最合适那条槽」不变量）。
