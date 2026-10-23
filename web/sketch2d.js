// SeedBoxes 二维草图编辑器（板件级），交互参考 LightBurn / LaserMaker。
// 依赖 paper.js（web/vendor/paper/paper-core.min.js，MIT，由 index.html 以普通脚本加载 → window.paper）。
//
// 坐标：「从外面看」的板面坐标，单位 mm，y 向上（视图矩阵做 y 翻转）。
// 数据：{ base, items: [{ id, mode: cut|engrave|score, role?, locked?, text?, paths: [{ closed, segs: [[x,y,inx,iny,outx,outy]] }] }] }
// 后端 sketch2d.py 读取同样的格式输出图纸、做 3D 碰撞检查。

const MODES = {
  cut: { name: '切割', color: '#1f6feb', hint: '激光切穿' },
  engrave: { name: '雕刻', color: '#16a34a', hint: '填充雕刻（闭合图形）' },
  score: { name: '划线', color: '#c026d3', hint: '沿线浅刻' },
};
const OUTLINE_COLOR = '#1c2733';
const WOOD = '#ead3ac';
const SELECT = '#0ea5e9';

const TOOLS = [
  { id: 'select', key: 'v', icon: '➤', name: '选择', tip: '点选 / 框选，拖动移动；拖控制点缩放、旋转（V）' },
  { id: 'node', key: 'a', icon: '◇', name: '节点', tip: '拖动节点和控制柄；双击线段加节点，双击节点切换尖角 / 平滑，Delete 删节点（A）' },
  { id: 'line', key: 'l', icon: '╱', name: '直线', tip: '逐点单击画折线；点起点闭合，双击 / 回车结束，Shift 锁 45°（L）' },
  { id: 'pen', key: 'p', icon: '✒', name: '曲线', tip: '单击 = 尖角点，按住拖动 = 平滑曲线点；点起点闭合，回车结束（P）' },
  { id: 'rect', key: 'r', icon: '▭', name: '矩形', tip: '拖动画矩形，Shift 正方形，Alt 从中心（R）' },
  { id: 'ellipse', key: 'e', icon: '◯', name: '椭圆', tip: '拖动画椭圆，Shift 正圆，Alt 从中心（E）' },
  { id: 'polygon', key: 'g', icon: '⬡', name: '多边形', tip: '从中心拖出多边形 / 星形，边数在右侧设置（G）' },
  { id: 'text', key: 't', icon: 'T', name: '文字', tip: '单击放置文字，右侧修改内容、字体、字号（T）' },
  { id: 'trim', key: 'x', icon: '✂', name: '修剪', tip: '单击或拖过线段，删掉两个交点之间的那一段（X）' },
  { id: 'measure', key: 'm', icon: '📏', name: '测量', tip: '拖动测量距离和角度（M）' },
];

let uid = 0;
const newId = () => 's' + Date.now().toString(36) + (uid++).toString(36);
const r3 = (v) => Math.round(v * 1000) / 1000;
const fmt = (v) => (Math.round(v * 100) / 100).toString();

export class SketchEditor {
  constructor(host, { api, toast }) {
    this.host = host;
    this.api = api;
    this.toast = toast || (() => {});
    this.opened = false;
    this.tool = 'select';
    this.sel = new Set();
    this.snapStep = 1;
    this.snapPoints = true;
    this.lockRatio = true;
    this.opts = { mode: 'cut', radius: 0, sides: 6, star: false, starRatio: 0.5, text: '文字', font: '', size: 12,
                  offset: 2, offsetJoin: 'round', arrRows: 2, arrCols: 3, arrDx: 20, arrDy: 20 };
    this.undoStack = [];
    this.redoStack = [];
    this.clip = null;
    this.buildDom();
  }

  // ================================================================ DOM

  buildDom() {
    const h = this.host;
    h.innerHTML = `
      <div class="sk-top">
        <button class="sk-back" data-act="close">← 完成 · 返回</button>
        <div class="sk-title"><b class="sk-name">—</b><span class="sk-sub"></span></div>
        <div class="sk-group">
          <button data-act="undo" title="撤销（Ctrl+Z）">↶</button>
          <button data-act="redo" title="重做（Ctrl+Shift+Z）">↷</button>
        </div>
        <div class="sk-group">
          <button data-act="copy" title="复制（Ctrl+C）">复制</button>
          <button data-act="paste" title="粘贴（Ctrl+V）">粘贴</button>
          <button data-act="dup" title="原位复制一份（Ctrl+D）">复制一份</button>
          <button data-act="delete" title="删除（Delete）">删除</button>
        </div>
        <div class="sk-group">
          <button data-act="fit" title="显示整块板（F）">适合窗口</button>
          <label class="sk-snap">吸附
            <select data-opt="snap"><option value="0">关</option><option value="0.5">0.5 mm</option>
              <option value="1" selected>1 mm</option><option value="5">5 mm</option></select></label>
          <label class="sk-check"><input type="checkbox" data-opt="snapPoints" checked>吸附端点</label>
        </div>
        <span class="sk-spacer"></span>
        <button class="sk-lock" data-act="lockOutline" title="锁定后外轮廓（卡榫边）不会被误选、误改">🔒 外轮廓已锁定</button>
        <button data-act="reset" title="丢弃这块板的所有修改，恢复生成器画出的原样">恢复原板</button>
      </div>
      <div class="sk-numeric">
        <span class="sk-num-label">位置 / 尺寸</span>
        <label>X<input data-num="x" type="number" step="0.1"></label>
        <label>Y<input data-num="y" type="number" step="0.1"></label>
        <label>宽<input data-num="w" type="number" step="0.1" min="0.1"></label>
        <label>高<input data-num="h" type="number" step="0.1" min="0.1"></label>
        <button class="sk-ratio on" data-act="ratio" title="锁定宽高比">🔗</button>
        <label>旋转<input data-num="rot" type="number" step="1" value="0"></label><span class="sk-unit">°</span>
        <span class="sk-num-hint">选中图形后输入数值，回车生效（X / Y 为左下角）</span>
      </div>
      <div class="sk-main">
        <div class="sk-tools">${TOOLS.map((t) => `<button data-tool="${t.id}" title="${t.tip}"><span class="i">${t.icon}</span>${t.name}</button>`).join('')}</div>
        <div class="sk-canvas-wrap"><canvas class="sk-canvas" resize></canvas>
          <div class="sk-banner hidden"></div>
          <div class="sk-measure hidden"></div>
          <div class="sk-3d">
            <div class="sk-3d-head"><b>3D 实时预览</b><span class="sk-3d-status"></span>
              <button data-act="toggle3d" title="收起 / 展开 3D 预览">—</button></div>
            <div class="sk-3d-body"></div>
          </div>
        </div>
        <aside class="sk-side">
          <section class="sk-card">
            <h4>图层（加工方式）</h4>
            <div class="sk-layers">${Object.entries(MODES).map(([k, m]) => `
              <button class="sk-layer" data-mode="${k}"><i style="background:${m.color}"></i><b>${m.name}</b><em>${m.hint}</em><span class="sk-count" data-count="${k}">0</span></button>`).join('')}
            </div>
            <p class="sk-small">选中图形后点图层（或下方色块）即可改加工方式；新画的图形使用当前图层。</p>
          </section>
          <section class="sk-card sk-toolopts"></section>
          <section class="sk-card">
            <h4>形状运算</h4>
            <div class="sk-btns">
              <button data-act="unite" title="选中的闭合图形合成一个（焊接）">并集</button>
              <button data-act="subtract" title="最下面的图形减去其他图形">差集</button>
              <button data-act="intersect" title="只保留所有图形重叠的部分">交集</button>
              <button data-act="exclude" title="保留不重叠的部分">异或</button>
            </div>
            <div class="sk-row"><label>偏移<input data-opt="offset" type="number" step="0.5" value="2"> mm</label>
              <select data-opt="offsetJoin"><option value="round">圆角</option><option value="miter">尖角</option></select>
              <button data-act="offset" title="生成外扩（正数）/ 内缩（负数）的新轮廓">偏移</button></div>
            <div class="sk-row"><label>阵列<input data-opt="arrRows" type="number" min="1" value="2">行</label>
              <label><input data-opt="arrCols" type="number" min="1" value="3">列</label></div>
            <div class="sk-row"><label>间距 X<input data-opt="arrDx" type="number" step="1" value="20"></label>
              <label>Y<input data-opt="arrDy" type="number" step="1" value="20"></label>
              <button data-act="array">阵列</button></div>
          </section>
          <section class="sk-card">
            <h4>排列</h4>
            <div class="sk-btns sk-align">
              <button data-act="alignL" title="左对齐">⇤</button><button data-act="alignHC" title="水平居中">↔</button>
              <button data-act="alignR" title="右对齐">⇥</button><button data-act="alignT" title="顶对齐">⤒</button>
              <button data-act="alignVC" title="垂直居中">↕</button><button data-act="alignB" title="底对齐">⤓</button>
            </div>
            <p class="sk-small">选一个图形时对齐到整块板，选多个时对齐到选区。</p>
            <div class="sk-btns">
              <button data-act="flipH">水平镜像</button><button data-act="flipV">垂直镜像</button>
              <button data-act="rotL">左转 90°</button><button data-act="rotR">右转 90°</button>
              <button data-act="close" data-close="path" title="把开放路径首尾相连">闭合路径</button>
              <button data-act="breakApart" title="把组合路径拆成独立图形">拆分</button>
            </div>
          </section>
          <section class="sk-card sk-boardinfo"></section>
        </aside>
      </div>
      <div class="sk-bottom">
        <div class="sk-palette">${Object.entries(MODES).map(([k, m]) => `<button data-mode="${k}" title="${m.name}：${m.hint}" style="background:${m.color}">${m.name}</button>`).join('')}</div>
        <div class="sk-status"></div>
        <div class="sk-coords"></div>
      </div>`;
    this.canvas = h.querySelector('.sk-canvas');
    this.previewHost = h.querySelector('.sk-3d-body');
    this.$ = (s) => h.querySelector(s);
    this.$$ = (s) => h.querySelectorAll(s);

    h.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
    h.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => this.applyMode(b.dataset.mode)));
    h.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => this.act(b.dataset.act, b)));
    h.querySelectorAll('[data-opt]').forEach((el) => el.addEventListener('change', () => this.optChanged(el)));
    h.querySelectorAll('[data-num]').forEach((el) => {
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { this.numericApply(el.dataset.num, el.value); el.blur(); } });
      el.addEventListener('change', () => this.numericApply(el.dataset.num, el.value));
    });

    // paper.js
    const paper = window.paper;
    this.ps = new paper.PaperScope();
    this.ps.setup(this.canvas);
    this.ps.settings.handleSize = 7;
    this.ps.settings.hitTolerance = 0;
    const L = (name) => { const l = new this.ps.Layer(); l.name = name; return l; };
    this.gridLayer = L('grid');
    this.boardLayer = L('board');
    this.content = L('content');
    this.overlay = L('overlay');
    this.content.activate();
    this.zoom = 4;

    const tool = new this.ps.Tool();
    tool.minDistance = 0;
    tool.onMouseDown = (e) => this.onDown(e);
    tool.onMouseDrag = (e) => this.onDrag(e);
    tool.onMouseUp = (e) => this.onUp(e);
    tool.onMouseMove = (e) => this.onMove(e);
    this.ps.view.onResize = () => this.redrawGrid();

    this.canvas.addEventListener('wheel', (ev) => {
      ev.preventDefault();
      const f = Math.exp(-ev.deltaY * (ev.ctrlKey ? 0.01 : 0.0018));
      this.zoomAt(this.viewPoint(ev), f);
    }, { passive: false });
    this.canvas.addEventListener('dblclick', (ev) => this.onDouble(this.ps.view.viewToProject(this.viewPoint(ev))));
    this.canvas.addEventListener('contextmenu', (ev) => ev.preventDefault());
    this.keyHandler = (ev) => this.onKey(ev);
    this.keyUpHandler = (ev) => { if (ev.key === ' ') this.spacePan = false; };
  }

  viewPoint(ev) {
    const r = this.canvas.getBoundingClientRect();
    return new this.ps.Point(ev.clientX - r.left, ev.clientY - r.top);
  }

  // ================================================================ 打开 / 关闭

  /**
   * part: { name, sub, outline: {outer, holes}（从外面看）, base, thickness }
   * sketch: 已有草图或 null；legacy: [{ polys, mode }]（旧版开孔 / 刻字，迁移成图形）
   */
  async open({ part, sketch, legacy, onChange, onClose, fonts }) {
    this.ps.activate();
    this.part = part;
    this.onChange = onChange;
    this.onClose = onClose;
    this.fonts = fonts || [];
    if (!this.opts.font && this.fonts.length) this.opts.font = this.fonts[0].id;
    this.$('.sk-name').textContent = part.name;
    this.$('.sk-sub').textContent = part.sub || '';
    this.host.classList.remove('hidden');
    this.opened = true;
    document.addEventListener('keydown', this.keyHandler, true);
    document.addEventListener('keyup', this.keyUpHandler, true);
    this.ps.view.viewSize = new this.ps.Size(this.canvas.clientWidth, this.canvas.clientHeight);

    this.undoStack = [];
    this.redoStack = [];
    this.outlineLocked = true;
    this.content.removeChildren();
    this.sel.clear();
    const banner = this.$('.sk-banner');
    banner.classList.add('hidden');
    if (sketch && sketch.items && sketch.items.length) {
      this.load(sketch);
      if (sketch.base && part.base && sketch.base !== part.base) {
        banner.innerHTML = '生成器参数改过了：这块板的草图是按旧尺寸画的，卡榫可能对不上。' +
          '<button data-b="keep">保留草图</button><button data-b="reset">按新尺寸重新开始</button>';
        banner.classList.remove('hidden');
        banner.querySelector('[data-b=keep]').onclick = () => banner.classList.add('hidden');
        banner.querySelector('[data-b=reset]').onclick = () => { banner.classList.add('hidden'); this.resetToOriginal(); };
      }
    } else {
      this.seedFromPart(legacy);
    }
    this.current = JSON.stringify(this.serialize().items);
    this.drawReference();
    this.fit();
    this.setTool('select');
    this.refresh();
    this.renderBoardInfo();
  }

  close() {
    if (!this.opened) return;
    this.finishDrawing();
    this.opened = false;
    document.removeEventListener('keydown', this.keyHandler, true);
    document.removeEventListener('keyup', this.keyUpHandler, true);
    this.host.classList.add('hidden');
    if (this.onClose) this.onClose(this.serializeForSave());
  }

  seedFromPart(legacy) {
    const { outer, holes } = this.part.outline;
    this.addItem({ mode: 'cut', role: 'outline', locked: true, paths: [this.polyPath(outer, true)] });
    holes.forEach((h) => this.addItem({ mode: 'cut', paths: [this.polyPath(h, true)] }));
    (legacy || []).forEach((l) => {
      if (l.polys && l.polys.length) this.addItem({ mode: l.mode || 'cut', paths: l.polys.map((p) => this.polyPath(p, true)) });
    });
  }

  resetToOriginal() {
    this.pushUndo();
    this.content.removeChildren();
    this.sel.clear();
    this.seedFromPart([]);
    this.commit('恢复原板', true);
  }

  polyPath(pts, closed) {
    return { closed, segs: pts.map(([x, y]) => [x, y, 0, 0, 0, 0]) };
  }

  // ================================================================ 数据 ↔ paper

  load(sketch) {
    this.content.removeChildren();
    sketch.items.forEach((it) => this.addItem(it));
  }

  addItem(it) {
    const ps = this.ps;
    const mk = (p) => {
      const path = new ps.Path({ insert: false });
      path.segments = p.segs.map((s) => new ps.Segment(new ps.Point(s[0], s[1]), new ps.Point(s[2], s[3]), new ps.Point(s[4], s[5])));
      path.closed = !!p.closed;
      return path;
    };
    let item;
    if (it.paths.length === 1) item = mk(it.paths[0]);
    else { item = new ps.CompoundPath({ insert: false }); item.addChildren(it.paths.map(mk)); }
    item.data = { id: it.id || newId(), mode: it.mode || 'cut', role: it.role || null, locked: !!it.locked,
                  text: it.text ? { ...it.text } : null };
    this.content.addChild(item);
    this.style(item);
    return item;
  }

  itemPaths(item) {
    return item.className === 'CompoundPath' ? item.children : [item];
  }

  serializeItem(item) {
    const paths = this.itemPaths(item).filter((p) => p.segments.length >= 2).map((p) => ({
      closed: p.closed,
      segs: p.segments.map((s) => [r3(s.point.x), r3(s.point.y), r3(s.handleIn.x), r3(s.handleIn.y), r3(s.handleOut.x), r3(s.handleOut.y)]),
    }));
    const out = { id: item.data.id, mode: item.data.mode, paths };
    if (item.data.role) out.role = item.data.role;
    if (item.data.locked) out.locked = true;
    if (item.data.text) out.text = { ...item.data.text };
    return out;
  }

  serialize() {
    return { base: this.part.base, items: this.content.children.filter((c) => c.data && c.data.mode)
      .map((c) => this.serializeItem(c)).filter((it) => it.paths.length) };
  }

  serializeForSave() {
    const s = this.serialize();
    return { ...s, modified: this.isModified(s) };
  }

  // 和生成器原图相同（没改过）时不保存草图
  isModified(s) {
    const seed = [this.part.outline.outer, ...this.part.outline.holes];
    const cut = s.items;
    if (cut.length !== seed.length) return true;
    return cut.some((it, i) => {
      if (it.mode !== 'cut' || it.paths.length !== 1 || !it.paths[0].closed) return true;
      const segs = it.paths[0].segs;
      const ref = seed[i];
      if (!ref || segs.length !== ref.length) return true;
      return segs.some((g, k) => Math.abs(g[0] - ref[k][0]) > 1e-3 || Math.abs(g[1] - ref[k][1]) > 1e-3
        || g.slice(2).some((v) => Math.abs(v) > 1e-6));
    });
  }

  style(item) {
    const d = item.data;
    const m = MODES[d.mode] || MODES.cut;
    const outline = d.role === 'outline';
    item.strokeScaling = false;
    item.strokeWidth = outline ? 1.6 : 1.4;
    item.strokeColor = outline ? OUTLINE_COLOR : m.color;
    item.fillColor = d.mode === 'engrave' ? new this.ps.Color(0.09, 0.64, 0.29, 0.28) : null;
    item.fillRule = 'evenodd';
    item.dashArray = d.mode === 'score' ? [5, 3] : null;
    item.opacity = d.locked && this.outlineLocked !== false && outline ? 0.85 : 1;
  }

  // ================================================================ 刷新 / 撤销

  pushUndo() {
    this.undoStack.push(this.current);
    if (this.undoStack.length > 120) this.undoStack.shift();
    this.redoStack = [];
  }

  // 一次修改完成：记录撤销点（调用前须 pushUndo，或传 skipPush=false 自动比较）
  commit(label, pushed) {
    const now = JSON.stringify(this.serialize().items);
    if (!pushed) {
      if (now === this.current) { this.refresh(); return; }
      this.undoStack.push(this.current);
      this.redoStack = [];
    }
    this.current = now;
    this.refresh();
    if (label) this.status(label);
    this.emitChange();
  }

  emitChange() {
    clearTimeout(this._emitT);
    this._emitT = setTimeout(() => { if (this.onChange) this.onChange(this.serializeForSave()); }, 250);
  }

  restore(json) {
    const sel = [...this.sel].map((i) => i.data.id);
    this.content.removeChildren();
    JSON.parse(json).forEach((it) => this.addItem(it));
    this.current = json;
    this.sel = new Set(this.content.children.filter((c) => sel.includes(c.data.id)));
    this.refresh();
    this.emitChange();
  }

  undo() {
    this.finishDrawing();
    if (!this.undoStack.length) return;
    this.redoStack.push(this.current);
    this.restore(this.undoStack.pop());
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this.current);
    this.restore(this.redoStack.pop());
  }

  refresh() {
    this.content.children.forEach((c) => { if (c.data && c.data.mode) this.style(c); });
    for (const it of [...this.sel]) if (!it.parent) this.sel.delete(it);
    this.content.children.forEach((c) => { c.fullySelected = this.tool === 'node' && this.sel.has(c); });
    this.drawBoard();
    this.drawSelection();
    this.updateNumeric();
    this.renderToolOpts();
    this.updateCounts();
    const lockBtn = this.$('.sk-lock');
    lockBtn.textContent = this.outlineLocked ? '🔒 外轮廓已锁定' : '🔓 外轮廓可编辑';
    lockBtn.classList.toggle('on', !this.outlineLocked);
  }

  updateCounts() {
    const c = { cut: 0, engrave: 0, score: 0 };
    this.content.children.forEach((it) => { if (it.data && c[it.data.mode] !== undefined) c[it.data.mode]++; });
    Object.keys(c).forEach((k) => { this.$(`[data-count=${k}]`).textContent = c[k]; });
    const one = this.sel.size ? [...this.sel][0].data.mode : this.opts.mode;
    this.$$('.sk-layer').forEach((b) => b.classList.toggle('on', b.dataset.mode === one));
  }

  // 板的实体（木色）：所有闭合切割路径按奇偶规则填充
  drawBoard() {
    this.boardLayer.removeChildren();
    if (this.reference) this.boardLayer.addChild(this.reference);
    const loops = [];
    this.content.children.forEach((it) => {
      if (!it.data || it.data.mode !== 'cut') return;
      this.itemPaths(it).forEach((p) => { if (p.closed && p.segments.length > 2) loops.push(p.clone({ insert: false })); });
    });
    if (!loops.length) return;
    const cp = new this.ps.CompoundPath({ children: loops, insert: false });
    cp.fillRule = 'evenodd';
    cp.fillColor = WOOD;
    cp.strokeColor = null;
    this.boardLayer.insertChild(0, cp);
  }

  // 生成器原始轮廓（虚线参考）
  drawReference() {
    const { outer } = this.part.outline;
    const ref = new this.ps.Path({ insert: false, closed: true, segments: outer.map(([x, y]) => [x, y]) });
    ref.strokeColor = new this.ps.Color(0.4, 0.4, 0.45, 0.45);
    ref.dashArray = [3, 3];
    ref.strokeScaling = false;
    ref.strokeWidth = 1;
    this.reference = ref;
  }

  // ================================================================ 视图

  setView(z, cx, cy) {
    const v = this.ps.view;
    this.zoom = Math.max(0.2, Math.min(200, z));
    const w = v.viewSize.width;
    const h = v.viewSize.height;
    v.matrix = new this.ps.Matrix(this.zoom, 0, 0, -this.zoom, w / 2 - cx * this.zoom, h / 2 + cy * this.zoom);
    this.redrawGrid();
    this.drawSelection();
  }

  center() {
    const v = this.ps.view;
    const c = v.viewToProject(new this.ps.Point(v.viewSize.width / 2, v.viewSize.height / 2));
    return c;
  }

  zoomAt(viewPt, f) {
    const v = this.ps.view;
    const before = v.viewToProject(viewPt);
    const z = Math.max(0.2, Math.min(200, this.zoom * f));
    const c = this.center();
    this.setView(z, c.x, c.y);
    const after = v.viewToProject(viewPt);
    const c2 = this.center();
    this.setView(z, c2.x + before.x - after.x, c2.y + before.y - after.y);
  }

  panBy(dxView, dyView) {
    const c = this.center();
    this.setView(this.zoom, c.x - dxView / this.zoom, c.y + dyView / this.zoom);
  }

  fit() {
    const v = this.ps.view;
    v.viewSize = new this.ps.Size(this.canvas.clientWidth || 800, this.canvas.clientHeight || 600);
    let b = null;
    this.content.children.forEach((c) => { b = b ? b.unite(c.bounds) : c.bounds.clone(); });
    if (!b) b = new this.ps.Rectangle(0, 0, 100, 100);
    const pad = 40;
    const z = Math.min((v.viewSize.width - 2 * pad) / Math.max(1, b.width), (v.viewSize.height - 2 * pad) / Math.max(1, b.height));
    this.setView(z, b.center.x, b.center.y);
  }

  redrawGrid() {
    const ps = this.ps;
    this.gridLayer.removeChildren();
    const v = ps.view;
    const b = v.bounds;   // 投影坐标下的可见范围
    const z = this.zoom;
    const steps = [1, 2, 5, 10, 20, 50, 100];
    const minor = steps.find((s) => s * z >= 8) || 100;
    const major = minor * (minor === 2 || minor === 20 ? 5 : minor === 5 || minor === 50 ? 2 : 10);
    const lines = (step, color, w) => {
      const g = new ps.Group({ parent: this.gridLayer });
      for (let x = Math.floor(b.left / step) * step; x <= b.right; x += step) {
        g.addChild(new ps.Path.Line({ from: [x, b.top], to: [x, b.bottom], insert: false }));
      }
      for (let y = Math.floor(b.top / step) * step; y <= b.bottom; y += step) {
        g.addChild(new ps.Path.Line({ from: [b.left, y], to: [b.right, y], insert: false }));
      }
      g.strokeColor = color;
      g.strokeWidth = w;
      g.strokeScaling = false;
    };
    lines(minor, '#eef1f4', 1);
    lines(major, '#dbe1e8', 1);
    const axes = new ps.Group({ parent: this.gridLayer });
    axes.addChild(new ps.Path.Line({ from: [0, b.top], to: [0, b.bottom], insert: false }));
    axes.addChild(new ps.Path.Line({ from: [b.left, 0], to: [b.right, 0], insert: false }));
    axes.strokeColor = '#b8c4d2';
    axes.strokeWidth = 1;
    axes.strokeScaling = false;
  }

  // ================================================================ 吸附

  snap(pt, opts = {}) {
    const tol = 7 / this.zoom;
    if (this.snapPoints && !opts.noPoints) {
      let best = null;
      let bd = tol;
      const consider = (q) => { const d = q.getDistance(pt); if (d < bd) { bd = d; best = q; } };
      this.content.children.forEach((it) => {
        if (!it.data || (opts.exclude && opts.exclude.has(it))) return;
        if (!it.bounds.expand(tol * 2).contains(pt)) return;
        this.itemPaths(it).forEach((p) => p.segments.forEach((s) => consider(s.point)));
      });
      (opts.extra || []).forEach(consider);
      if (best) { this.showSnap(best); return best.clone(); }
    }
    this.showSnap(null);
    const st = this.snapStep;
    if (!st || opts.noGrid) return pt.clone();
    return new this.ps.Point(Math.round(pt.x / st) * st, Math.round(pt.y / st) * st);
  }

  showSnap(p) {
    if (this.snapMark) { this.snapMark.remove(); this.snapMark = null; }
    if (!p) return;
    const r = 5 / this.zoom;
    this.snapMark = new this.ps.Path.Rectangle({ point: [p.x - r, p.y - r], size: [2 * r, 2 * r], parent: this.overlay,
      strokeColor: '#f97316', strokeWidth: 1.5, strokeScaling: false });
  }

  // ================================================================ 命中

  selectable(it) {
    return it && it.data && it.data.mode && !(it.data.locked && this.outlineLocked && it.data.role === 'outline');
  }

  hitItem(pt, opts = {}) {
    const tol = 6 / this.zoom;
    const res = this.content.hitTest(pt, { stroke: true, segments: true, fill: false, tolerance: tol,
      match: (h) => this.selectable(this.topItem(h.item)) || opts.any });
    if (res) return this.topItem(res.item);
    // 雕刻图形可以点内部选中
    const f = this.content.hitTest(pt, { fill: true, stroke: false, tolerance: 0,
      match: (h) => { const it = this.topItem(h.item); return it && it.data.mode === 'engrave' && this.selectable(it); } });
    return f ? this.topItem(f.item) : null;
  }

  topItem(item) {
    let it = item;
    while (it && it.parent && it.parent !== this.content) it = it.parent;
    return it && it.parent === this.content ? it : null;
  }

  selBounds() {
    let b = null;
    this.sel.forEach((it) => { b = b ? b.unite(it.bounds) : it.bounds.clone(); });
    return b;
  }

  // ================================================================ 选择框

  drawSelection() {
    this.overlay.removeChildren();
    this.snapMark = null;
    this.handles = [];
    if (!this.sel.size || this.tool !== 'select') return;
    const ps = this.ps;
    const b = this.selBounds();
    if (!b) return;
    const frame = new ps.Path.Rectangle({ rectangle: b, parent: this.overlay, strokeColor: SELECT,
      strokeWidth: 1, dashArray: [4, 3], strokeScaling: false });
    frame.data.ui = true;
    const s = 4.5 / this.zoom;
    const pts = {
      bl: b.bottomLeft, br: b.bottomRight, tl: b.topLeft, tr: b.topRight,
      l: b.leftCenter, r: b.rightCenter, t: b.topCenter, b: b.bottomCenter,
    };
    // 注意：y 向上，paper 的 top 是 y 小的一边 = 屏幕下方
    Object.entries(pts).forEach(([k, p]) => {
      const h = new ps.Path.Rectangle({ point: [p.x - s, p.y - s], size: [2 * s, 2 * s], parent: this.overlay,
        fillColor: '#fff', strokeColor: SELECT, strokeWidth: 1.2, strokeScaling: false });
      this.handles.push({ kind: 'scale', key: k, at: p, item: h });
    });
    const top = new ps.Point(b.center.x, b.bottom + 22 / this.zoom);   // 屏幕上方
    const stem = new ps.Path.Line({ from: b.bottomCenter, to: top, parent: this.overlay, strokeColor: SELECT, strokeWidth: 1, strokeScaling: false });
    stem.data.ui = true;
    const rot = new ps.Path.Circle({ center: top, radius: 5 / this.zoom, parent: this.overlay, fillColor: SELECT });
    this.handles.push({ kind: 'rotate', at: top, item: rot });
  }

  hitHandle(pt) {
    const tol = 7 / this.zoom;
    return (this.handles || []).find((h) => h.at.getDistance(pt) <= tol) || null;
  }

  // ================================================================ 工具

  setTool(id) {
    this.finishDrawing();
    this.tool = id;
    this.$$('.sk-tools [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === id));
    const t = TOOLS.find((q) => q.id === id);
    this.status(t ? t.tip : '');
    this.canvas.style.cursor = id === 'select' ? 'default' : id === 'trim' ? 'crosshair' : id === 'node' ? 'pointer' : 'crosshair';
    this.$('.sk-measure').classList.add('hidden');
    this.refresh();
  }

  status(text) { this.$('.sk-status').textContent = text || ''; }

  // 3D 预览框里的咬合 / 穿透结果
  setPreviewStatus(text, kind) {
    const el = this.$('.sk-3d-status');
    el.textContent = text || '';
    el.className = 'sk-3d-status' + (kind ? ' ' + kind : '');
  }

  onDown(e) {
    const ev = e.event;
    this.downView = new this.ps.Point(ev.offsetX, ev.offsetY);
    if (ev.button === 1 || ev.button === 2 || this.spacePan) { this.drag = { kind: 'pan', last: this.downView }; return; }
    const pt = e.point;
    const t = this.tool;
    if (t === 'select') return this.selectDown(e, pt);
    if (t === 'node') return this.nodeDown(e, pt);
    if (t === 'line' || t === 'pen') return this.pathDown(e, pt);
    if (t === 'rect' || t === 'ellipse' || t === 'polygon') {
      this.drag = { kind: 'shape', from: this.snap(pt), alt: ev.altKey };
      return;
    }
    if (t === 'text') return this.placeText(this.snap(pt));
    if (t === 'trim') { this.drag = { kind: 'trim', changed: false }; this.trimAt(pt); return; }
    if (t === 'measure') { this.drag = { kind: 'measure', from: this.snap(pt) }; }
  }

  onDrag(e) {
    const d = this.drag;
    if (!d) return;
    const ev = e.event;
    if (d.kind === 'pan') {
      const now = new this.ps.Point(ev.offsetX, ev.offsetY);
      this.panBy(now.x - d.last.x, now.y - d.last.y);
      d.last = now;
      return;
    }
    const pt = e.point;
    this.showCoords(pt);
    if (d.kind === 'move') {
      const target = this.snap(d.anchor.add(pt.subtract(d.start)), { exclude: this.sel });
      const delta = target.subtract(d.anchor).subtract(d.moved);
      if (!delta.isZero()) { this.sel.forEach((it) => it.translate(delta)); d.moved = d.moved.add(delta); }
      this.drawSelection();
      this.updateNumeric();
      this.status(`移动 ΔX ${fmt(d.moved.x)}  ΔY ${fmt(d.moved.y)} mm`);
    } else if (d.kind === 'scale') this.scaleDrag(d, pt, ev);
    else if (d.kind === 'rotate') this.rotateDrag(d, pt, ev);
    else if (d.kind === 'marquee') {
      if (d.box) d.box.remove();
      d.box = new this.ps.Path.Rectangle({ from: d.from, to: pt, parent: this.overlay, strokeColor: SELECT,
        dashArray: [3, 3], strokeWidth: 1, strokeScaling: false, fillColor: new this.ps.Color(0.05, 0.6, 0.9, 0.06) });
    } else if (d.kind === 'shape') this.shapePreview(d, this.snap(pt), ev);
    else if (d.kind === 'node') this.nodeDrag(d, pt, ev);
    else if (d.kind === 'penHandle') this.penHandleDrag(d, pt);
    else if (d.kind === 'trim') this.trimAt(pt);
    else if (d.kind === 'measure') this.measureDrag(d, this.snap(pt), ev);
  }

  onUp(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'move' || d.kind === 'scale' || d.kind === 'rotate' || d.kind === 'node') this.commit(d.label || '已修改');
    else if (d.kind === 'marquee') {
      if (d.box) {
        const r = d.box.bounds;
        d.box.remove();
        const picked = this.content.children.filter((it) => this.selectable(it) && r.contains(it.bounds));
        if (!e.event.shiftKey) this.sel.clear();
        picked.forEach((it) => this.sel.add(it));
      } else if (!e.event.shiftKey) this.sel.clear();
      this.refresh();
    } else if (d.kind === 'shape') this.shapeFinish(d);
    else if (d.kind === 'penHandle') { /* 点已加入 */ }
    else if (d.kind === 'trim') { if (d.changed) this.commit('已修剪'); }
    this.showSnap(null);
  }

  onMove(e) {
    this.showCoords(e.point);
    if (this.tool === 'line' || this.tool === 'pen') this.pathHover(e.point, e.event);
    else if (this.tool === 'trim') this.trimHover(e.point);
    else if (['rect', 'ellipse', 'polygon', 'text', 'measure'].includes(this.tool)) this.snap(e.point);
  }

  showCoords(pt) {
    this.$('.sk-coords').textContent = `X ${fmt(pt.x)}  Y ${fmt(pt.y)} mm`;
  }

  // ---------------------------------------------------------------- 选择工具

  selectDown(e, pt) {
    const h = this.hitHandle(pt);
    if (h && this.sel.size) {
      this.pushUndo();
      const b = this.selBounds();
      if (h.kind === 'rotate') {
        this.drag = { kind: 'rotate', center: b.center, start: pt.subtract(b.center).angle, applied: 0, label: '已旋转', pushed: true };
      } else {
        this.drag = { kind: 'scale', key: h.key, bounds: b, sx: 1, sy: 1, label: '已缩放' };
      }
      this.undoStack.pop();   // commit 会自动比较并记录
      return;
    }
    const it = this.hitItem(pt);
    if (it) {
      if (e.event.shiftKey) {
        if (this.sel.has(it)) this.sel.delete(it); else this.sel.add(it);
        this.refresh();
        return;
      }
      if (!this.sel.has(it)) { this.sel.clear(); this.sel.add(it); this.refresh(); }
      if (e.event.altKey) {   // Alt 拖动 = 复制
        const copies = [...this.sel].map((s) => this.cloneItem(s));
        this.sel = new Set(copies);
      }
      const b = this.selBounds();
      this.drag = { kind: 'move', start: pt, anchor: this.nearestCorner(b, pt), moved: new this.ps.Point(0, 0), label: '已移动' };
      return;
    }
    this.drag = { kind: 'marquee', from: pt };
  }

  nearestCorner(b, pt) {
    const cands = [b.topLeft, b.topRight, b.bottomLeft, b.bottomRight, b.center];
    return cands.reduce((a, c) => (c.getDistance(pt) < a.getDistance(pt) ? c : a)).clone();
  }

  scaleDrag(d, pt, ev) {
    const b = d.bounds;
    const k = d.key;
    // 对边（固定点）
    const fx = k.includes('l') ? b.right : k.includes('r') ? b.left : b.center.x;
    const fy = k === 'b' || k.startsWith('t') ? b.bottom : k === 't' || k.startsWith('b') ? b.top : b.center.y;
    // 拖动点坐标（paper 的 top = y 小）
    const p = this.snap(pt, { exclude: this.sel });
    let sx = k === 't' || k === 'b' ? 1 : (p.x - fx) / ((k.includes('l') ? b.left : b.right) - fx);
    let sy = k === 'l' || k === 'r' ? 1 : (p.y - fy) / ((k === 't' || k.startsWith('t') ? b.top : b.bottom) - fy);
    if (!isFinite(sx) || Math.abs(sx) < 0.01) sx = 0.01 * Math.sign(sx || 1);
    if (!isFinite(sy) || Math.abs(sy) < 0.01) sy = 0.01 * Math.sign(sy || 1);
    const corner = k.length === 2;
    if (corner && (this.lockRatio !== ev.shiftKey)) { const s = Math.abs(sx) > Math.abs(sy) ? sx : sy; sx = s; sy = s; }
    const fxp = new this.ps.Point(fx, fy);
    this.sel.forEach((it) => it.scale(sx / d.sx, sy / d.sy, fxp));
    d.sx = sx; d.sy = sy;
    this.drawSelection();
    this.updateNumeric();
    const nb = this.selBounds();
    this.status(`尺寸 ${fmt(nb.width)} × ${fmt(nb.height)} mm`);
  }

  rotateDrag(d, pt, ev) {
    let a = pt.subtract(d.center).angle - d.start;
    const step = ev.shiftKey ? 1 : 15;
    a = Math.round(a / step) * step;
    const delta = a - d.applied;
    if (delta) { this.sel.forEach((it) => it.rotate(delta, d.center)); d.applied = a; }
    this.drawSelection();
    this.status(`旋转 ${fmt(((a % 360) + 360) % 360)}°（Shift 取消 15° 吸附）`);
  }

  cloneItem(it) {
    const c = it.clone();
    c.data = { ...it.data, id: newId(), role: null, locked: false, text: it.data.text ? { ...it.data.text } : null };
    this.style(c);
    return c;
  }

  // ---------------------------------------------------------------- 节点工具

  nodeDown(e, pt) {
    const tol = 6 / this.zoom;
    // 先找已选图形的节点 / 控制柄
    const res = this.content.hitTest(pt, { segments: true, handles: true, stroke: true, tolerance: tol,
      match: (h) => this.selectable(this.topItem(h.item)) });
    if (!res) { this.sel.clear(); this.refresh(); this.drag = { kind: 'marquee', from: pt }; return; }
    const it = this.topItem(res.item);
    if (!this.sel.has(it)) { this.sel.clear(); this.sel.add(it); this.refresh(); }
    if (it.data.text) this.convertText(it);
    if (res.type === 'segment') {
      if (e.event.altKey) { res.segment.remove(); this.commit('已删除节点'); return; }
      this.activeSeg = res.segment;
      this.drag = { kind: 'node', seg: res.segment, part: 'point', label: '已移动节点' };
    } else if (res.type === 'handle-in' || res.type === 'handle-out') {
      this.drag = { kind: 'node', seg: res.segment, part: res.type, label: '已调整曲线' };
    } else if (res.type === 'stroke' && res.location) {
      this.drag = { kind: 'node', curve: res.location.curve, start: pt, label: '已调整曲线' };
    }
    this.refresh();
  }

  nodeDrag(d, pt, ev) {
    if (d.seg && d.part === 'point') {
      const p = this.snap(pt, { exclude: new Set() , extra: [] });
      d.seg.point = p;
    } else if (d.seg) {
      const rel = pt.subtract(d.seg.point);
      if (d.part === 'handle-in') {
        d.seg.handleIn = rel;
        if (!ev.altKey && !d.seg.handleOut.isZero()) d.seg.handleOut = rel.normalize(-d.seg.handleOut.length);
      } else {
        d.seg.handleOut = rel;
        if (!ev.altKey && !d.seg.handleIn.isZero()) d.seg.handleIn = rel.normalize(-d.seg.handleIn.length);
      }
    } else if (d.curve) {
      // 拖动线段：把直线变成曲线（两端控制柄跟着动）
      const delta = pt.subtract(d.start);
      d.start = pt;
      const c = d.curve;
      if (c.handle1.isZero() && c.handle2.isZero()) {
        const v = c.point2.subtract(c.point1).divide(3);
        c.handle1 = v; c.handle2 = v.negate();
      }
      c.handle1 = c.handle1.add(delta.multiply(1.5));
      c.handle2 = c.handle2.add(delta.multiply(1.5));
    }
  }

  // ---------------------------------------------------------------- 直线 / 曲线

  pathDown(e, pt) {
    const ps = this.ps;
    let p = this.snap(pt, { extra: this.drawing ? [this.drawing.firstSegment.point] : [] });
    const d = this.drawing;
    if (d && e.event.shiftKey && d.segments.length) p = this.constrain45(d.lastSegment.point, p);
    if (d && d.segments.length > 2 && p.getDistance(d.firstSegment.point) < 7 / this.zoom) {
      d.closed = true;
      this.finishDrawing();
      return;
    }
    if (!d) {
      this.drawing = new ps.Path({ parent: this.content, strokeColor: MODES[this.opts.mode].color, strokeWidth: 1.4, strokeScaling: false });
      this.drawing.data = { id: newId(), mode: this.opts.mode, drawing: true };
    }
    this.drawing.add(p);
    if (this.tool === 'pen') this.drag = { kind: 'penHandle', seg: this.drawing.lastSegment };
    this.status(this.tool === 'line' ? '继续单击加点；点起点闭合，双击或回车结束，Esc 取消' : '按住拖动拉出曲线；点起点闭合，回车结束，Esc 取消');
  }

  penHandleDrag(d, pt) {
    const rel = pt.subtract(d.seg.point);
    if (rel.length * this.zoom < 3) return;
    d.seg.handleOut = rel;
    d.seg.handleIn = rel.negate();
  }

  constrain45(from, p) {
    const v = p.subtract(from);
    const a = Math.round(v.angle / 45) * 45;
    const len = v.length;
    return from.add(new this.ps.Point({ angle: a, length: len }));
  }

  pathHover(pt, ev) {
    const d = this.drawing;
    if (this.rubber) { this.rubber.remove(); this.rubber = null; }
    let p = this.snap(pt, { extra: d ? [d.firstSegment.point] : [] });
    if (!d) return;
    if (ev && ev.shiftKey) p = this.constrain45(d.lastSegment.point, p);
    const last = d.lastSegment;
    this.rubber = new this.ps.Path({ parent: this.overlay, strokeColor: MODES[this.opts.mode].color, dashArray: [4, 3],
      strokeWidth: 1, strokeScaling: false });
    this.rubber.add(new this.ps.Segment(last.point, null, last.handleOut));
    this.rubber.add(p);
    const v = p.subtract(last.point);
    this.status(`长度 ${fmt(v.length)} mm  角度 ${fmt(((v.angle % 360) + 360) % 360)}°`);
  }

  finishDrawing() {
    if (this.rubber) { this.rubber.remove(); this.rubber = null; }
    const d = this.drawing;
    this.drawing = null;
    if (!d) return;
    if (d.segments.length < 2) { d.remove(); return; }
    delete d.data.drawing;
    this.style(d);
    this.sel.clear();
    this.sel.add(d);
    this.commit(d.closed ? '已闭合路径' : '已画路径');
  }

  cancelDrawing() {
    if (this.rubber) { this.rubber.remove(); this.rubber = null; }
    if (this.drawing) { this.drawing.remove(); this.drawing = null; }
    this.refresh();
  }

  // ---------------------------------------------------------------- 矩形 / 椭圆 / 多边形

  shapeRect(d, p, ev) {
    let from = d.from;
    let w = p.x - from.x;
    let h = p.y - from.y;
    if (ev.shiftKey || (this.tool === 'polygon')) { const s = Math.max(Math.abs(w), Math.abs(h)); w = s * Math.sign(w || 1); h = s * Math.sign(h || 1); }
    if (ev.altKey || d.alt) from = from.subtract(new this.ps.Point(w, h));
    return new this.ps.Rectangle(from, from.add(new this.ps.Point(ev.altKey || d.alt ? 2 * w : w, ev.altKey || d.alt ? 2 * h : h)));
  }

  makeShape(d, p, ev) {
    const ps = this.ps;
    if (this.tool === 'polygon') {
      const r = p.getDistance(d.from);
      if (r < 0.1) return null;
      const n = Math.max(3, Math.min(64, Math.round(this.opts.sides)));
      const rot = p.subtract(d.from).angle;
      if (this.opts.star) {
        const s = new ps.Path.Star({ center: d.from, points: n, radius1: r, radius2: r * this.opts.starRatio, insert: false });
        s.rotate(rot - 90 + 90, d.from);
        return s;
      }
      const s = new ps.Path.RegularPolygon({ center: d.from, sides: n, radius: r, insert: false });
      s.rotate(rot - 90, d.from);
      return s;
    }
    const rect = this.shapeRect(d, p, ev);
    if (rect.width < 0.1 || rect.height < 0.1) return null;
    if (this.tool === 'ellipse') return new ps.Path.Ellipse({ rectangle: rect, insert: false });
    const r = Math.min(this.opts.radius, rect.width / 2, rect.height / 2);
    return r > 0 ? new ps.Path.Rectangle({ rectangle: rect, radius: r, insert: false }) : new ps.Path.Rectangle({ rectangle: rect, insert: false });
  }

  shapePreview(d, p, ev) {
    if (d.preview) d.preview.remove();
    d.preview = this.makeShape(d, p, ev);
    d.last = p;
    d.ev = { shiftKey: ev.shiftKey, altKey: ev.altKey };
    if (!d.preview) return;
    d.preview.strokeColor = MODES[this.opts.mode].color;
    d.preview.strokeWidth = 1.4;
    d.preview.strokeScaling = false;
    this.overlay.addChild(d.preview);
    const b = d.preview.bounds;
    this.status(this.tool === 'polygon' ? `半径 ${fmt(p.getDistance(d.from))} mm` : `${fmt(b.width)} × ${fmt(b.height)} mm`);
  }

  shapeFinish(d) {
    if (!d.preview) return;
    const shape = d.preview;
    shape.remove();
    const it = this.addItem({ mode: this.opts.mode, paths: [] });
    it.remove();
    shape.data = it.data;
    this.content.addChild(shape);
    this.style(shape);
    this.sel.clear();
    this.sel.add(shape);
    this.commit('已添加图形');
  }

  // ---------------------------------------------------------------- 文字

  async placeText(pt) {
    const t = { text: this.opts.text || '文字', font: this.opts.font, size: this.opts.size, x: pt.x, y: pt.y };
    const it = await this.buildText(t);
    if (!it) return;
    this.sel.clear();
    this.sel.add(it);
    this.commit('已添加文字');
    this.setTool('select');
  }

  async buildText(t, replace) {
    const r = await this.api.text_outline(t.text, t.font, t.size);
    if (r.error) { this.toast(r.error, 'error'); return null; }
    if (r.missing && r.missing.length) this.toast(`字体缺少：${r.missing.join('')}`, 'error');
    if (!r.polys.length) { this.toast('没有可显示的文字', 'error'); return null; }
    const mode = replace ? replace.data.mode : this.opts.mode;
    const it = this.addItem({ mode, text: t, paths: r.polys.map((p) => this.polyPath(p.map(([x, y]) => [x + t.x, y + t.y]), true)) });
    if (replace) {
      it.data.id = replace.data.id;
      if (t.angle) it.rotate(t.angle, new this.ps.Point(t.x, t.y));
      it.insertAbove(replace);
      replace.remove();
    }
    return it;
  }

  convertText(it) {
    if (it.data.text) { it.data.text = null; this.status('文字已转成路径（不能再改文字内容）'); }
  }

  // ---------------------------------------------------------------- 修剪（橡皮擦）

  allPaths(except) {
    const out = [];
    this.content.children.forEach((it) => {
      if (!it.data || !it.data.mode || it === except) return;
      this.itemPaths(it).forEach((p) => out.push(p));
    });
    return out;
  }

  trimHover(pt) {
    if (this.rubber) { this.rubber.remove(); this.rubber = null; }
    const piece = this.trimPiece(pt);
    if (!piece) return;
    this.rubber = piece.preview;
    this.rubber.strokeColor = '#ef4444';
    this.rubber.strokeWidth = 3;
    this.rubber.strokeScaling = false;
    this.overlay.addChild(this.rubber);
  }

  // 找到点击处两个交点之间的那一段
  trimPiece(pt) {
    const tol = 6 / this.zoom;
    const res = this.content.hitTest(pt, { stroke: true, tolerance: tol,
      match: (h) => { const it = this.topItem(h.item); return it && this.selectable(it) && !it.data.drawing; } });
    if (!res || !res.location) return null;
    const path = res.item.className === 'Path' ? res.item : res.location.path;
    if (!path) return null;
    const L = path.length;
    const off = path.getNearestLocation(pt).offset;
    const offs = [];
    this.allPaths().forEach((other) => {
      if (!other.bounds.intersects(path.bounds.expand(0.01))) return;
      const ints = other === path ? path.getIntersections() : path.getIntersections(other);
      ints.forEach((i) => offs.push(i.offset));
    });
    // 路径自己的节点不算交点；开放路径两端是天然断点
    const uniq = [...new Set(offs.map((o) => Math.round(o * 1e4) / 1e4))].filter((o) => o > 1e-6 && o < L - 1e-6).sort((a, b) => a - b);
    let a; let b;
    if (path.closed) {
      if (uniq.length < 2) return { path, whole: true, preview: path.clone({ insert: false }) };
      a = uniq.filter((o) => o < off).pop(); if (a === undefined) a = uniq[uniq.length - 1];
      b = uniq.find((o) => o > off); if (b === undefined) b = uniq[0];
    } else {
      a = uniq.filter((o) => o < off).pop(); if (a === undefined) a = 0;
      b = uniq.find((o) => o > off); if (b === undefined) b = L;
      if (a === 0 && b === L) return { path, whole: true, preview: path.clone({ insert: false }) };
    }
    // 预览这一段
    const tmp = path.clone({ insert: false });
    let piece;
    if (tmp.closed) {
      tmp.splitAt(b);                       // 在 b 处断开，路径从 b 开始
      const na = (a - b + L) % L;
      piece = tmp.splitAt(na);              // na 之后到结尾 = a→b
    } else {
      const tail = b < L ? tmp.splitAt(b) : null;
      piece = a > 0 ? tmp.splitAt(a) : tmp;
      if (tail) tail.remove();
    }
    return { path, a, b, whole: false, preview: piece ? piece.clone({ insert: false }) : tmp };
  }

  trimAt(pt) {
    const t = this.trimPiece(pt);
    if (this.rubber) { this.rubber.remove(); this.rubber = null; }
    if (!t) return;
    const path = t.path;
    const owner = this.topItem(path);
    if (owner.data.text) this.convertText(owner);
    if (t.whole) {
      if (owner === path || owner.children.length <= 1) { owner.remove(); this.sel.delete(owner); } else path.remove();
    } else {
      const L = path.length;
      if (path.closed) {
        path.splitAt(t.b);
        const na = (t.a - t.b + L) % L;
        const piece = path.splitAt(na);
        if (piece) piece.remove();
      } else {
        const tail = t.b < L - 1e-6 ? path.splitAt(t.b) : null;
        if (t.a > 1e-6) { const mid = path.splitAt(t.a); if (mid) mid.remove(); } else path.remove();
        if (tail && owner === path) {
          // 独立的开放路径：尾段成为新图形
          const it = this.addItem({ mode: owner.data.mode, paths: [] });
          it.remove();
          tail.remove();
          tail.data = { ...it.data };
          this.content.addChild(tail);
          this.style(tail);
        }
      }
      if (owner.data.role === 'outline') owner.data.role = null;
    }
    if (this.drag && this.drag.kind === 'trim') this.drag.changed = true; else this.commit('已修剪');
    this.drawBoard();
  }

  // ---------------------------------------------------------------- 测量

  measureDrag(d, p, ev) {
    if (d.line) d.line.remove();
    if (ev.shiftKey) p = this.constrain45(d.from, p);
    d.line = new this.ps.Path.Line({ from: d.from, to: p, parent: this.overlay, strokeColor: '#f97316', strokeWidth: 1.5, strokeScaling: false });
    const v = p.subtract(d.from);
    const box = this.$('.sk-measure');
    box.classList.remove('hidden');
    box.innerHTML = `距离 <b>${fmt(v.length)}</b> mm · ΔX ${fmt(v.x)} · ΔY ${fmt(v.y)} · 角度 ${fmt(((v.angle % 360) + 360) % 360)}°`;
  }

  // ---------------------------------------------------------------- 双击

  onDouble(pt) {
    if (this.drawing) { this.drawing.removeSegment(this.drawing.segments.length - 1); this.finishDrawing(); return; }
    if (this.tool === 'select') {
      const it = this.hitItem(pt);
      if (it) { this.sel.clear(); this.sel.add(it); this.setTool('node'); }
      return;
    }
    if (this.tool !== 'node') return;
    const tol = 6 / this.zoom;
    const res = this.content.hitTest(pt, { segments: true, stroke: true, tolerance: tol,
      match: (h) => this.selectable(this.topItem(h.item)) });
    if (!res) return;
    const it = this.topItem(res.item);
    this.convertText(it);
    if (res.type === 'segment') {
      const s = res.segment;
      if (s.handleIn.isZero() && s.handleOut.isZero()) s.smooth({ type: 'catmull-rom' }); else { s.handleIn = null; s.handleOut = null; }
      this.commit(s.handleIn.isZero() ? '已设为尖角' : '已设为平滑');
    } else if (res.location) {
      res.location.path.divideAt(res.location);
      this.commit('已添加节点');
    }
  }

  // ================================================================ 操作

  act(a, btn) {
    const m = {
      close: () => (btn && btn.dataset.close === 'path' ? this.closePaths() : this.close()),
      undo: () => this.undo(), redo: () => this.redo(), copy: () => this.copy(), paste: () => this.paste(),
      dup: () => this.duplicate(), delete: () => this.deleteSel(), fit: () => this.fit(),
      ratio: () => { this.lockRatio = !this.lockRatio; this.$('.sk-ratio').classList.toggle('on', this.lockRatio); },
      lockOutline: () => { this.outlineLocked = !this.outlineLocked; this.sel.forEach((it) => { if (!this.selectable(it)) this.sel.delete(it); }); this.refresh(); },
      reset: () => { if (window.confirm('丢弃这块板的所有修改，恢复成生成器画出的样子？')) this.resetToOriginal(); },
      unite: () => this.boolean('unite'), subtract: () => this.boolean('subtract'),
      intersect: () => this.boolean('intersect'), exclude: () => this.boolean('exclude'),
      offset: () => this.offsetSel(), array: () => this.arraySel(),
      alignL: () => this.align('l'), alignR: () => this.align('r'), alignHC: () => this.align('hc'),
      alignT: () => this.align('t'), alignB: () => this.align('b'), alignVC: () => this.align('vc'),
      flipH: () => this.transformSel((it, c) => it.scale(-1, 1, c), '已水平镜像'),
      flipV: () => this.transformSel((it, c) => it.scale(1, -1, c), '已垂直镜像'),
      rotL: () => this.transformSel((it, c) => it.rotate(90, c), '已旋转'),
      rotR: () => this.transformSel((it, c) => it.rotate(-90, c), '已旋转'),
      breakApart: () => this.breakApart(),
      toggle3d: () => {
        const box = this.$('.sk-3d');
        box.classList.toggle('min');
        this.$('[data-act=toggle3d]').textContent = box.classList.contains('min') ? '▢' : '—';
        if (this.onPreviewResize) this.onPreviewResize();
      },
    };
    if (m[a]) m[a]();
  }

  need(n, msg) {
    if (this.sel.size < n) { this.toast(msg || (n > 1 ? `请先选中至少 ${n} 个图形` : '请先选中图形'), 'error'); return false; }
    return true;
  }

  transformSel(fn, label) {
    if (!this.need(1)) return;
    const c = this.selBounds().center;
    this.sel.forEach((it) => { this.convertTextIfRotated(it); fn(it, c); });
    this.commit(label);
  }

  convertTextIfRotated(it) { if (it.data.text) this.convertText(it); }

  applyMode(mode) {
    this.opts.mode = mode;
    if (this.sel.size) {
      this.sel.forEach((it) => { it.data.mode = mode; if (it.data.role === 'outline' && mode !== 'cut') it.data.role = null; });
      this.commit(`已改为${MODES[mode].name}`);
    } else {
      this.status(`新画的图形使用「${MODES[mode].name}」`);
      this.updateCounts();
    }
  }

  copy() {
    if (!this.need(1)) return;
    this.clip = [...this.sel].map((it) => this.serializeItem(it));
    this.status(`已复制 ${this.clip.length} 个图形`);
  }

  paste() {
    if (!this.clip) return;
    this.sel.clear();
    const off = 5;
    this.clip = this.clip.map((it) => ({ ...it, paths: it.paths.map((p) => ({ ...p, segs: p.segs.map((s) => [s[0] + off, s[1] - off, ...s.slice(2)]) })) }));
    this.clip.forEach((it) => this.sel.add(this.addItem({ ...it, id: newId(), role: null, locked: false })));
    this.commit('已粘贴');
  }

  duplicate() {
    if (!this.need(1)) return;
    const copies = [...this.sel].map((it) => this.cloneItem(it));
    copies.forEach((c) => c.translate(new this.ps.Point(5, -5)));
    this.sel = new Set(copies);
    this.commit('已复制一份');
  }

  deleteSel() {
    if (this.tool === 'node' && this.activeSeg && this.activeSeg.path) {
      const seg = this.activeSeg;
      this.activeSeg = null;
      if (seg.path.segments.length > 2) { seg.remove(); this.commit('已删除节点'); return; }
    }
    if (!this.need(1)) return;
    this.sel.forEach((it) => it.remove());
    this.sel.clear();
    this.commit('已删除');
  }

  closePaths() {
    if (!this.need(1)) return;
    let n = 0;
    this.sel.forEach((it) => this.itemPaths(it).forEach((p) => { if (!p.closed && p.segments.length > 2) { p.closed = true; n++; } }));
    if (!n) { this.toast('没有可闭合的开放路径', 'error'); return; }
    this.commit(`已闭合 ${n} 条路径`);
  }

  breakApart() {
    if (!this.need(1)) return;
    const out = [];
    [...this.sel].forEach((it) => {
      if (it.className !== 'CompoundPath') { out.push(it); return; }
      it.children.slice().forEach((ch) => {
        const ni = this.addItem({ mode: it.data.mode, paths: [] });
        ni.remove();
        ch.remove();
        ch.data = { ...ni.data };
        ch.insertAbove(it);
        this.style(ch);
        out.push(ch);
      });
      it.remove();
    });
    this.sel = new Set(out);
    this.commit('已拆分');
  }

  boolean(op) {
    if (!this.need(2, '形状运算需要选中至少 2 个闭合图形')) return;
    const items = this.content.children.filter((c) => this.sel.has(c));   // 按层次从下到上
    if (items.some((it) => this.itemPaths(it).some((p) => !p.closed))) {
      this.toast('形状运算只能用于闭合图形（可先「闭合路径」）', 'error');
      return;
    }
    const base = items[0];
    const mode = base.data.mode;
    const role = base.data.role;
    let res = base;
    const opts = { insert: false };
    for (let i = 1; i < items.length; i++) {
      const o = items[i];
      if (op === 'unite') res = res.unite(o, opts);
      else if (op === 'subtract') res = res.subtract(o, opts);
      else if (op === 'intersect') res = res.intersect(o, opts);
      else res = res.exclude(o, opts);
    }
    const before = base;
    items.forEach((it) => { if (it !== before) it.remove(); });
    if (!res || res.isEmpty()) { before.remove(); this.sel.clear(); this.commit('结果为空'); return; }
    res.data = { id: newId(), mode, role: op === 'subtract' || op === 'unite' ? role : null, locked: false, text: null };
    if (res.data.role === 'outline') res.data.locked = true;
    res.insertAbove(before);
    before.remove();
    this.style(res);
    this.sel = new Set([res]);
    this.commit({ unite: '已合并（并集）', subtract: '已相减（差集）', intersect: '已求交（交集）', exclude: '已异或' }[op]);
  }

  async offsetSel() {
    if (!this.need(1)) return;
    const dist = Number(this.opts.offset) || 0;
    if (!dist) { this.toast('偏移距离不能为 0', 'error'); return; }
    const paths = [];
    this.sel.forEach((it) => paths.push(...this.serializeItem(it).paths));
    const mode = [...this.sel][0].data.mode;
    const r = await this.api.sketch_offset(paths, dist, this.opts.offsetJoin);
    if (r.error) { this.toast(r.error, 'error'); return; }
    if (!r.rings.length) { this.toast('偏移后没有剩下图形（内缩太多？）', 'error'); return; }
    const it = this.addItem({ mode, paths: r.rings.map((ring) => this.polyPath(ring, true)) });
    this.sel = new Set([it]);
    this.commit(`已偏移 ${dist} mm`);
  }

  arraySel() {
    if (!this.need(1)) return;
    const rows = Math.max(1, Math.round(this.opts.arrRows));
    const cols = Math.max(1, Math.round(this.opts.arrCols));
    const dx = Number(this.opts.arrDx) || 0;
    const dy = Number(this.opts.arrDy) || 0;
    const src = [...this.sel];
    const all = [...src];
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        if (!r && !c) continue;
        src.forEach((it) => { const k = this.cloneItem(it); k.translate(new this.ps.Point(c * dx, -r * dy)); all.push(k); });
      }
    }
    this.sel = new Set(all);
    this.commit(`已阵列 ${rows} × ${cols}`);
  }

  align(how) {
    if (!this.need(1)) return;
    let ref;
    if (this.sel.size === 1) {
      const outline = this.content.children.find((c) => c.data && c.data.role === 'outline');
      ref = outline ? outline.bounds : null;
      if (!ref) { this.toast('只选一个图形时会对齐到外轮廓，但找不到外轮廓', 'error'); return; }
    } else ref = this.selBounds();
    this.sel.forEach((it) => {
      const b = it.bounds;
      let dx = 0; let dy = 0;
      if (how === 'l') dx = ref.left - b.left;
      if (how === 'r') dx = ref.right - b.right;
      if (how === 'hc') dx = ref.center.x - b.center.x;
      if (how === 'b') dy = ref.top - b.top;          // y 向上：paper 的 top = 屏幕下方
      if (how === 't') dy = ref.bottom - b.bottom;
      if (how === 'vc') dy = ref.center.y - b.center.y;
      it.translate(new this.ps.Point(dx, dy));
    });
    this.commit('已对齐');
  }

  // ================================================================ 数值栏

  updateNumeric() {
    const b = this.sel.size ? this.selBounds() : null;
    const set = (k, v) => { const el = this.$(`[data-num=${k}]`); if (document.activeElement !== el) el.value = v; };
    this.$$('.sk-numeric input').forEach((el) => { el.disabled = !b; });
    if (!b) { ['x', 'y', 'w', 'h'].forEach((k) => set(k, '')); set('rot', 0); return; }
    set('x', fmt(b.left)); set('y', fmt(b.top)); set('w', fmt(b.width)); set('h', fmt(b.height)); set('rot', 0);
  }

  numericApply(k, val) {
    const v = Number(val);
    if (!this.sel.size || !isFinite(v)) return;
    const b = this.selBounds();
    if (k === 'x') this.sel.forEach((it) => it.translate(new this.ps.Point(v - b.left, 0)));
    else if (k === 'y') this.sel.forEach((it) => it.translate(new this.ps.Point(0, v - b.top)));
    else if (k === 'w' || k === 'h') {
      if (v <= 0) return;
      let sx = k === 'w' ? v / b.width : 1;
      let sy = k === 'h' ? v / b.height : 1;
      if (this.lockRatio) { if (k === 'w') sy = sx; else sx = sy; }
      this.sel.forEach((it) => { this.convertTextIfRotated(it); it.scale(sx, sy, b.topLeft); });
    } else if (k === 'rot') {
      if (!v) return;
      this.sel.forEach((it) => { this.convertTextIfRotated(it); it.rotate(-v, b.center); });   // 正数 = 逆时针（数学方向）
    }
    this.commit('已修改尺寸 / 位置');
  }

  // ================================================================ 右侧：工具选项 / 板信息

  optChanged(el) {
    const k = el.dataset.opt;
    if (k === 'snap') { this.snapStep = Number(el.value); return; }
    if (k === 'snapPoints') { this.snapPoints = el.checked; return; }
    this.opts[k] = el.type === 'number' ? Number(el.value) : el.type === 'checkbox' ? el.checked : el.value;
  }

  renderToolOpts() {
    const box = this.$('.sk-toolopts');
    const t = this.tool;
    const textSel = this.sel.size === 1 && [...this.sel][0].data.text ? [...this.sel][0] : null;
    let html = '';
    if (t === 'rect') html = `<h4>矩形</h4><div class="sk-row"><label>圆角半径<input data-o="radius" type="number" min="0" step="0.5" value="${this.opts.radius}"> mm</label></div>`;
    else if (t === 'polygon') {
      html = `<h4>多边形 / 星形</h4><div class="sk-row"><label>${this.opts.star ? '角数' : '边数'}<input data-o="sides" type="number" min="3" max="64" value="${this.opts.sides}"></label>
        <label class="sk-check"><input data-o="star" type="checkbox" ${this.opts.star ? 'checked' : ''}>星形</label></div>` +
        (this.opts.star ? `<div class="sk-row"><label>内外径比<input data-o="starRatio" type="number" min="0.1" max="0.95" step="0.05" value="${this.opts.starRatio}"></label></div>` : '');
    } else if (t === 'text' || textSel) {
      const src = textSel ? textSel.data.text : this.opts;
      const fonts = (this.fonts || []).map((f) => `<option value="${f.id}" ${f.id === src.font ? 'selected' : ''}>${f.name}</option>`).join('');
      html = `<h4>${textSel ? '修改文字' : '文字'}</h4>
        <div class="sk-row"><input class="sk-wide" data-o="text" value="${escAttr(src.text)}"></div>
        <div class="sk-row"><label>字体<select data-o="font">${fonts}</select></label></div>
        <div class="sk-row"><label>字高<input data-o="size" type="number" min="1" step="0.5" value="${src.size}"> mm</label></div>
        <p class="sk-small">${textSel ? '修改后回车生效。旋转、节点编辑、形状运算后文字会转成路径。' : '在板上单击放置。'}</p>`;
    } else if (t === 'node') html = '<h4>节点编辑</h4><p class="sk-small">拖节点移动；拖线段把直线拉成曲线；拖控制柄调弧度（Alt 单独调一侧）。双击线段加节点，双击节点切换尖角 / 平滑，Alt+单击或 Delete 删节点。</p>';
    else if (t === 'trim') html = '<h4>修剪</h4><p class="sk-small">鼠标移到线上会标红将被删掉的一段（到最近的交点为止），单击或拖过即删除。没有交点的整条路径会被整个删掉。</p>';
    box.innerHTML = html;
    box.classList.toggle('hidden', !html);
    box.querySelectorAll('[data-o]').forEach((el) => {
      const handler = async () => {
        const k = el.dataset.o;
        const v = el.type === 'number' ? Number(el.value) : el.type === 'checkbox' ? el.checked : el.value;
        if (textSel) {
          const t2 = { ...textSel.data.text, [k]: v };
          const it = await this.buildText(t2, textSel);
          if (it) { this.sel = new Set([it]); this.commit('已修改文字'); }
          return;
        }
        this.opts[k] = v;
        if (k === 'star') this.renderToolOpts();
      };
      el.addEventListener('change', handler);
      if (el.tagName === 'INPUT' && el.type !== 'checkbox') el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') el.blur(); });
    });
  }

  renderBoardInfo() {
    const p = this.part;
    this.$('.sk-boardinfo').innerHTML = `<h4>这块板</h4>
      <p class="sk-small">${p.sub || ''}</p>
      <p class="sk-small">板厚 <b>${fmt(p.thickness || 0)} mm</b>。卡榫边改动后，回到 3D 会自动检查能不能拼上（红色 = 穿透）。</p>
      <p class="sk-small">灰色虚线是生成器画的原始轮廓；木色区域是切出来的板。</p>`;
  }

  // ================================================================ 键盘

  onKey(ev) {
    if (!this.opened) return;
    const tag = document.activeElement && document.activeElement.tagName;
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(tag)) return;
    const mod = ev.ctrlKey || ev.metaKey;
    const k = ev.key.toLowerCase();
    let used = true;
    if (ev.key === ' ') { this.spacePan = true; }
    else if (mod && k === 'z') { if (ev.shiftKey) this.redo(); else this.undo(); }
    else if (mod && k === 'y') this.redo();
    else if (mod && k === 'c') this.copy();
    else if (mod && k === 'v') this.paste();
    else if (mod && k === 'd') this.duplicate();
    else if (mod && k === 'a') { this.sel = new Set(this.content.children.filter((c) => this.selectable(c))); this.setTool('select'); }
    else if (ev.key === 'Delete' || ev.key === 'Backspace') { if (this.drawing) this.cancelDrawing(); else this.deleteSel(); }
    else if (ev.key === 'Escape') { if (this.drawing) this.cancelDrawing(); else { this.sel.clear(); this.refresh(); } }
    else if (ev.key === 'Enter') this.finishDrawing();
    else if (ev.key.startsWith('Arrow') && this.sel.size) {
      const s = ev.shiftKey ? 10 : (this.snapStep || 1);
      const v = { ArrowLeft: [-s, 0], ArrowRight: [s, 0], ArrowUp: [0, s], ArrowDown: [0, -s] }[ev.key];
      this.sel.forEach((it) => it.translate(new this.ps.Point(v[0], v[1])));
      this.commit('已移动');
    } else if (!mod && k === 'f') this.fit();
    else if (!mod && !ev.altKey) {
      const t = TOOLS.find((q) => q.key === k);
      if (t) this.setTool(t.id); else used = false;
    } else used = false;
    if (used) { ev.preventDefault(); ev.stopPropagation(); }
  }
}

function escAttr(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// ================================================================== 3D / 预览用：草图 → 多边形
// 与 sketch2d.py 的 flatten_path 一致

export function flattenPath(path, steps = 16) {
  const segs = path.segs || [];
  if (!segs.length) return [];
  const pts = [[segs[0][0], segs[0][1]]];
  const n = segs.length;
  const count = path.closed ? n : n - 1;
  for (let i = 0; i < count; i++) {
    const a = segs[i];
    const b = segs[(i + 1) % n];
    const curved = [a[4], a[5], b[2], b[3]].some((v) => Math.abs(v) > 1e-9);
    if (!curved) { pts.push([b[0], b[1]]); continue; }
    const p0 = [a[0], a[1]]; const p1 = [a[0] + a[4], a[1] + a[5]];
    const p2 = [b[0] + b[2], b[1] + b[3]]; const p3 = [b[0], b[1]];
    const span = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
    const k = Math.max(4, Math.min(64, Math.floor(span / 1.5) + steps / 2));
    for (let j = 1; j <= k; j++) {
      const t = j / k; const mt = 1 - t;
      const c0 = mt * mt * mt; const c1 = 3 * mt * mt * t; const c2 = 3 * mt * t * t; const c3 = t * t * t;
      pts.push([c0 * p0[0] + c1 * p1[0] + c2 * p2[0] + c3 * p3[0], c0 * p0[1] + c1 * p1[1] + c2 * p2[1] + c3 * p3[1]]);
    }
  }
  if (path.closed && pts.length > 2) {
    const f = pts[0]; const l = pts[pts.length - 1];
    if (Math.hypot(f[0] - l[0], f[1] - l[1]) < 1e-6) pts.pop();
  }
  return pts;
}

/** 草图 → { cut: 闭合切割环[], open: 开放切割线[], engrave: 闭合雕刻环[], lines: 划线 / 开放雕刻线[] } */
export function sketchPolys(sketch) {
  const out = { cut: [], open: [], engrave: [], lines: [] };
  (sketch.items || []).forEach((it) => {
    (it.paths || []).forEach((p) => {
      const pts = flattenPath(p);
      if (pts.length < 2) return;
      const closed = p.closed && pts.length >= 3;
      if (it.mode === 'cut') (closed ? out.cut : out.open).push(pts);
      else if (it.mode === 'engrave' && closed) out.engrave.push(pts);
      else out.lines.push(closed ? [...pts, pts[0]] : pts);
    });
  });
  return out;
}
