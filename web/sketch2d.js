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
  { id: 'joint', key: 'j', icon: '⊓', name: '卡榫', tip: '单击板的一条直边，把它做成指接卡榫 / 凹槽（深度 = 板厚）（J）' },
  { id: 'mortise', key: 'k', icon: '▤', name: '插槽', tip: '在板面上开一排插槽孔，让另一块板的指接 A 边插进来（T 型连接）；拖出插槽中线，或先在右侧选配对边再单击（K）' },
  { id: 'bridge', key: 'b', icon: '⫶', name: '连接点', tip: '在切割线上点一下加连接点（留一小段不切），镂空的部分切完不会掉下来；再点一次删除（B）' },
  { id: 'trim', key: 'x', icon: '✂', name: '修剪', tip: '单击或拖过线段，删掉两个交点之间的那一段（X）' },
  { id: 'measure', key: 'm', icon: '📏', name: '测量', tip: '拖动测量距离和角度（M）' },
];

// 对齐 / 分布图标（16×16 线框）
const ALIGN_ICONS = {
  l: '<path d="M2 1v14"/><rect x="4" y="3" width="9" height="3"/><rect x="4" y="9" width="5" height="3"/>',
  hc: '<path d="M8 1v14"/><rect x="2.5" y="3" width="11" height="3"/><rect x="5" y="9" width="6" height="3"/>',
  r: '<path d="M14 1v14"/><rect x="3" y="3" width="9" height="3"/><rect x="7" y="9" width="5" height="3"/>',
  t: '<path d="M1 2h14"/><rect x="3" y="4" width="3" height="9"/><rect x="9" y="4" width="3" height="5"/>',
  vc: '<path d="M1 8h14"/><rect x="3" y="2.5" width="3" height="11"/><rect x="9" y="5" width="3" height="6"/>',
  b: '<path d="M1 14h14"/><rect x="3" y="3" width="3" height="9"/><rect x="9" y="7" width="3" height="5"/>',
  dh: '<path d="M1 2v12M15 2v12"/><rect x="3.5" y="4" width="3" height="8"/><rect x="9.5" y="4" width="3" height="8"/>',
  dv: '<path d="M2 1h12M2 15h12"/><rect x="4" y="3.5" width="8" height="3"/><rect x="4" y="9.5" width="8" height="3"/>',
};
const ALIGN_NAMES = { l: '左对齐', hc: '水平居中', r: '右对齐', t: '顶对齐', vc: '垂直居中', b: '底对齐', dh: '水平等距分布', dv: '垂直等距分布' };
const alignIcon = (k) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3">${ALIGN_ICONS[k]}</svg>`;

import { parseDXF, loadImage, grayOf, otsu, binarize, readFile } from './sketch-import.js';

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
                  offset: 2, offsetJoin: 'round', arrRows: 2, arrCols: 3, arrDx: 20, arrDy: 20,
                  arrType: 'line', arrCount: 5, arrDist: 15, arrAngle: 0, arrCenter: 'board', arrCx: 0, arrCy: 0,
                  arrSweep: 360, arrRotate: true, arrPreview: true, alignTo: 'sel', cornerR: 3, bridgeW: 1, bridgeN: 2,
                  jointCount: 0, jointType: 'a', jointDepth: 0, jointMode: 'count', jointTab: 0, jointGap: 0, jointPlay: 0 };
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
          <button data-act="import" title="导入 SVG / DXF 矢量图，或把图片描摹成矢量（Ctrl+I）">📥 导入</button>
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
        <span class="sk-num-hint">回车生效（X / Y 为左下角）</span>
        <span class="sk-spacer"></span>
        <span class="sk-num-label">对齐</span>
        <span class="sk-aligns">${['l', 'hc', 'r', 't', 'vc', 'b'].map((k) => `<button data-align="${k}" title="${ALIGN_NAMES[k]}">${alignIcon(k)}</button>`).join('')}
          <i class="sk-sep"></i>${['dh', 'dv'].map((k) => `<button data-align="${k}" title="${ALIGN_NAMES[k]}（选 3 个以上）">${alignIcon(k)}</button>`).join('')}</span>
      </div>
      <div class="sk-main">
        <div class="sk-tools">${TOOLS.map((t) => `<button data-tool="${t.id}" title="${t.tip}"><span class="i">${t.icon}</span>${t.name}</button>`).join('')}</div>
        <div class="sk-canvas-wrap"><canvas class="sk-canvas" resize></canvas>
          <canvas class="sk-ruler-x" title="从标尺往画布上拖，拉出参考线"></canvas><canvas class="sk-ruler-y" title="从标尺往画布上拖，拉出参考线"></canvas>
          <div class="sk-ruler-corner" title="清除所有参考线">✕</div>
          <div class="sk-dims"></div>
          <div class="sk-snaptag hidden"></div>
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
          <section class="sk-card">
            <h4>对齐与分布</h4>
            <div class="sk-row"><label>对齐到<select data-opt="alignTo">
              <option value="sel">选区（所有选中图形的外框）</option>
              <option value="key">关键对象（最后点选的那个）</option>
              <option value="board">整块板</option></select></label></div>
            <div class="sk-align-grid">${['l', 'hc', 'r', 't', 'vc', 'b'].map((k) => `<button data-align="${k}">${alignIcon(k)}<span>${ALIGN_NAMES[k]}</span></button>`).join('')}</div>
            <div class="sk-align-grid two">${['dh', 'dv'].map((k) => `<button data-align="${k}">${alignIcon(k)}<span>${ALIGN_NAMES[k]}</span></button>`).join('')}</div>
            <p class="sk-small sk-align-hint">按住 Shift 点选多个图形（或框选），再点对齐方式。只选一个时对齐到整块板。</p>
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
          </section>
          <section class="sk-card">
            <h4>阵列</h4>
            <div class="sk-array"></div>
          </section>
          <section class="sk-card">
            <h4>变换</h4>
            <div class="sk-row"><label>圆角 / 倒角<input data-opt="cornerR" type="number" min="0.1" step="0.5" value="3"> mm</label>
              <button data-act="fillet" title="把选中图形的尖角变圆（节点工具下只改当前节点）">圆角</button>
              <button data-act="chamfer" title="把尖角切成斜角">倒角</button></div>
            <div class="sk-btns">
              <button data-act="flipH">水平镜像</button><button data-act="flipV">垂直镜像</button>
              <button data-act="rotL">左转 90°</button><button data-act="rotR">右转 90°</button>
              <button data-act="close" data-close="path" title="把开放路径首尾相连">闭合路径</button>
              <button data-act="breakApart" title="把组合路径拆成独立图形">拆分</button>
              <button data-act="group" title="选中的图形编成一组，一起选中、移动（Ctrl+G）">编组</button>
              <button data-act="ungroup" title="取消编组（Ctrl+Shift+G）">取消编组</button>
              <button data-act="dedupe" title="删除完全重合的重复图形（重复的线会被激光切两遍，边缘容易烧焦）">删除重复图形</button>
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
    this.renderArray();
    const arrCard = this.$('.sk-array').closest('.sk-card');
    const setArr = (on) => { if (this.arrActive !== on) { this.arrActive = on; if (this.opened) this.drawSelection(); } };
    arrCard.addEventListener('mouseenter', () => setArr(true));
    arrCard.addEventListener('mouseleave', () => { if (!arrCard.contains(document.activeElement)) setArr(false); });
    arrCard.addEventListener('focusin', () => setArr(true));
    arrCard.addEventListener('focusout', () => setTimeout(() => { if (!arrCard.matches(':hover') && !arrCard.contains(document.activeElement)) setArr(false); }, 0));

    h.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => this.setTool(b.dataset.tool)));
    h.querySelectorAll('[data-align]').forEach((b) => b.addEventListener('click', () => this.align(b.dataset.align)));
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
    this.marks = L('marks');
    this.guideLayer = L('guides');
    this.overlay = L('overlay');
    this.content.activate();
    this.zoom = 4;

    this.$('.sk-ruler-x').addEventListener('pointerdown', (ev) => this.rulerDown(ev, 'y'));
    this.$('.sk-ruler-y').addEventListener('pointerdown', (ev) => this.rulerDown(ev, 'x'));
    this.$('.sk-ruler-corner').addEventListener('click', () => { if (this.guides.length) { this.guides = []; this.drawGuides(); this.emitChange(); this.status('已清除参考线'); } });
    const tool = new this.ps.Tool();
    tool.minDistance = 0;
    tool.onMouseDown = (e) => this.onDown(e);
    tool.onMouseDrag = (e) => this.onDrag(e);
    tool.onMouseUp = (e) => this.onUp(e);
    tool.onMouseMove = (e) => this.onMove(e);
    this.ps.view.onResize = () => { this.redrawGrid(); this.drawGuides(); this.drawRulers(); this.drawSelection(); };

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
  async open({ part, sketch, legacy, onChange, onClose, fonts, peers }) {
    this.peers = peers || [];
    this.opts.jointPeer = null;
    this.ps.activate();
    this.part = part;
    this.onChange = onChange;
    this.onClose = onClose;
    this.fonts = fonts || [];
    if (!this.opts.font && this.fonts.length) this.opts.font = this.fonts[0].id;
    this.$('.sk-name').textContent = part.name;
    this.$('.sk-sub').textContent = part.sub || '';
    this.$('[data-act=reset]').textContent = part.free ? '恢复矩形' : '恢复原板';
    this.host.classList.remove('hidden');
    this.opened = true;
    document.addEventListener('keydown', this.keyHandler, true);
    document.addEventListener('keyup', this.keyUpHandler, true);
    this.ps.view.viewSize = new this.ps.Size(this.canvas.clientWidth, this.canvas.clientHeight);

    this.undoStack = [];
    this.redoStack = [];
    this.outlineLocked = !part.free;
    this.content.removeChildren();
    this.sel.clear();
    const banner = this.$('.sk-banner');
    banner.classList.add('hidden');
    this.opts.bridgeW = sketch && sketch.bridge_w != null ? Number(sketch.bridge_w) : 1;
    this.guides = sketch && sketch.guides ? sketch.guides.map((g) => ({ ...g })) : [];
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
    this.addItem({ mode: 'cut', role: 'outline', locked: !this.part.free, paths: [this.polyPath(outer, true)] });
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
                  text: it.text ? { ...it.text } : null, joints: it.joints ? it.joints.map((j) => ({ ...j })) : null,
                  group: it.group || null, bridges: it.bridges ? it.bridges.map((b) => [...b]) : null };
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
    if (item.data.group) out.group = item.data.group;
    if (item.data.bridges && item.data.bridges.length) out.bridges = item.data.bridges.map((b) => b.map(r3));
    if (item.data.joints && item.data.joints.length) {
      out.joints = item.data.joints.map((j) => ({ ...j, a: j.a.map(r3), b: j.b.map(r3), c: j.c.map(r3) }));
    }
    return out;
  }

  serialize() {
    const out = { base: this.part.base, items: this.content.children.filter((c) => c.data && c.data.mode)
      .map((c) => this.serializeItem(c)).filter((it) => it.paths.length) };
    if (this.opts.bridgeW !== 1) out.bridge_w = this.opts.bridgeW;
    if (this.guides && this.guides.length) out.guides = this.guides.map((g) => ({ ...g }));
    return out;
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
    this.hookJoints(item);
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

  // 卡榫信息（a、b = 边的两端，c = a + 朝外法线）跟着图形的移动 / 旋转 / 缩放 / 镜像一起变换
  hookJoints(item) {
    if (item._jointHook) return;
    item._jointHook = true;
    const orig = item.transform;
    const ps = this.ps;
    item.transform = function (m, ...rest) {
      const tp = (q) => { const r = m.transform(new ps.Point(q[0], q[1])); return [r.x, r.y]; };
      if (m && this.data && this.data.joints) {
        this.data.joints = this.data.joints.map((j) => ({ ...j, a: tp(j.a), b: tp(j.b), c: tp(j.c) }));
      }
      if (m && this.data && this.data.bridges) this.data.bridges = this.data.bridges.map(tp);
      return orig.call(this, m, ...rest);
    };
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
    this.drawMarks();
  }

  // 连接点标记（橙色小横杠，跨在切割线上）
  drawMarks() {
    this.marks.removeChildren();
    const w = Math.max(0.3, Number(this.opts.bridgeW) || 1);
    this.content.children.forEach((it) => {
      (it.data && it.data.bridges || []).forEach(([x, y]) => {
        const pt = new this.ps.Point(x, y);
        const p = this.itemPaths(it).reduce((best, q) => {
          const d = q.getNearestPoint(pt).getDistance(pt);
          return !best || d < best.d ? { q, d } : best;
        }, null);
        if (!p) return;
        const loc = p.q.getNearestLocation(pt);
        const tan = loc.tangent.normalize(w / 2);
        const nrm = loc.normal.normalize(6 / this.zoom);
        const c = loc.point;
        const mark = new this.ps.Path({ parent: this.marks, closed: true, fillColor: '#f97316',
          segments: [c.subtract(tan).subtract(nrm), c.add(tan).subtract(nrm), c.add(tan).add(nrm), c.subtract(tan).add(nrm)] });
        mark.opacity = 0.9;
      });
    });
  }

  // ---------------------------------------------------------------- 连接点

  bridgeAt(pt) {
    const tol = 7 / this.zoom;
    // 点在已有连接点上：删除
    for (const it of this.content.children) {
      const list = it.data && it.data.bridges;
      if (!list) continue;
      const i = list.findIndex(([x, y]) => Math.hypot(x - pt.x, y - pt.y) < tol);
      if (i >= 0) {
        it.data.bridges = list.filter((_, k) => k !== i);
        this.commit('已删除连接点');
        return;
      }
    }
    const res = this.content.hitTest(pt, { stroke: true, tolerance: tol,
      match: (h) => { const it = this.topItem(h.item); return it && it.data.mode === 'cut' && it.data.role !== 'outline-locked'; } });
    if (!res || !res.location) { this.status('请点在切割线上'); return; }
    const it = this.topItem(res.item);
    const p = res.location.point;
    it.data.bridges = [...(it.data.bridges || []), [p.x, p.y]];
    this.commit(`已加连接点（宽 ${fmt(this.opts.bridgeW)} mm）`);
  }

  autoBridges() {
    const n = Math.max(1, Math.round(Number(this.opts.bridgeN) || 2));
    const targets = this.sel.size ? [...this.sel] : this.content.children.filter((c) => c.data && c.data.mode === 'cut' && c.data.role !== 'outline');
    let count = 0;
    targets.forEach((it) => {
      if (!it.data || it.data.mode !== 'cut') return;
      const list = [];
      this.itemPaths(it).forEach((p) => {
        if (!p.closed || p.length < 4) return;
        for (let k = 0; k < n; k++) { const q = p.getPointAt(p.length * (k + 0.5) / n); list.push([q.x, q.y]); }
      });
      if (list.length) { it.data.bridges = list; count += list.length; }
    });
    if (!count) { this.toast('没有可以加连接点的闭合切割图形（先选中镂空图形）', 'error'); return; }
    this.commit(`已自动加 ${count} 个连接点`);
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
    this.drawGuides();
    this.drawRulers();
    this.drawSelection();
    if (this.marks) this.drawMarks();
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

  // 智能吸附：端点 > 交点 > 中点 > 圆心 / 中心 > 参考线 > 网格
  snap(pt, opts = {}) {
    const tol = 7 / this.zoom;
    if (this.snapPoints && !opts.noPoints) {
      const near = this.content.children.filter((it) => it.data && it.data.mode && !it.data.drawing
        && !(opts.exclude && opts.exclude.has(it)) && it.bounds.expand(tol * 2).contains(pt));
      const cands = [];
      const add = (q, kind, prio) => { const d = q.getDistance(pt); if (d < tol) cands.push({ q, kind, prio, d }); };
      near.forEach((it) => this.itemPaths(it).forEach((p) => {
        p.segments.forEach((sg) => add(sg.point, '端点', 0));
        p.curves.forEach((c) => add(c.getPointAtTime(0.5), '中点', 2));
      }));
      (opts.extra || []).forEach((q) => add(q, '端点', 0));
      near.forEach((it) => add(it.bounds.center, it.className === 'Path' && it.segments.length === 4 && !it.segments[0].handleIn.isZero() ? '圆心' : '中心', 3));
      if (near.length >= 1 && near.length <= 8) {
        const paths = near.flatMap((it) => this.itemPaths(it));
        for (let i = 0; i < paths.length; i++) {
          for (let k = i; k < paths.length; k++) {
            const ints = k === i ? paths[i].getIntersections() : paths[i].getIntersections(paths[k]);
            ints.forEach((loc) => add(loc.point, '交点', 1));
          }
        }
      }
      if (cands.length) {
        cands.sort((u, v) => u.prio - v.prio || u.d - v.d);
        const best = cands[0];
        this.showSnap(best.q, best.kind);
        return best.q.clone();
      }
    }
    // 参考线：x、y 分别吸附
    let x = null; let y = null;
    (this.guides || []).forEach((g) => {
      if (g.axis === 'x' && Math.abs(pt.x - g.v) < tol && (x === null || Math.abs(pt.x - g.v) < Math.abs(pt.x - x))) x = g.v;
      if (g.axis === 'y' && Math.abs(pt.y - g.v) < tol && (y === null || Math.abs(pt.y - g.v) < Math.abs(pt.y - y))) y = g.v;
    });
    const st = this.snapStep;
    const gx = (v) => (!st || opts.noGrid ? v : Math.round(v / st) * st);
    const q = new this.ps.Point(x !== null ? x : gx(pt.x), y !== null ? y : gx(pt.y));
    if (x !== null || y !== null) this.showSnap(q, '参考线'); else this.showSnap(null);
    return q;
  }

  showSnap(p, kind) {
    if (this.snapMark) { this.snapMark.remove(); this.snapMark = null; }
    const tag = this.$('.sk-snaptag');
    if (!p) { if (tag) tag.classList.add('hidden'); return; }
    const r = 5 / this.zoom;
    const shape = kind === '中点' ? new this.ps.Path.RegularPolygon({ center: p, sides: 3, radius: r * 1.3, insert: false })
      : kind === '交点' ? new this.ps.Path({ segments: [[p.x - r, p.y - r], [p.x + r, p.y + r], [p.x, p.y], [p.x - r, p.y + r], [p.x + r, p.y - r]], insert: false })
        : kind === '圆心' || kind === '中心' ? new this.ps.Path.Circle({ center: p, radius: r, insert: false })
          : new this.ps.Path.Rectangle({ point: [p.x - r, p.y - r], size: [2 * r, 2 * r], insert: false });
    shape.strokeColor = '#f97316';
    shape.strokeWidth = 1.5;
    shape.strokeScaling = false;
    this.overlay.addChild(shape);
    this.snapMark = shape;
    if (tag && kind) {
      const v = this.ps.view.projectToView(p);
      tag.textContent = kind;
      tag.style.left = `${v.x + 10}px`;
      tag.style.top = `${v.y - 22}px`;
      tag.classList.remove('hidden');
    }
  }

  // ================================================================ 标尺 / 参考线

  drawRulers() {
    const wrap = this.$('.sk-canvas-wrap');
    const top = this.$('.sk-ruler-x');
    const left = this.$('.sk-ruler-y');
    if (!top || !wrap.clientWidth) return;
    const W = wrap.clientWidth; const H = wrap.clientHeight; const R = 20;
    const dpr = window.devicePixelRatio || 1;
    const prep = (cv, w, h) => { cv.width = w * dpr; cv.height = h * dpr; cv.style.width = w + 'px'; cv.style.height = h + 'px'; const g = cv.getContext('2d'); g.scale(dpr, dpr); return g; };
    const steps = [1, 2, 5, 10, 20, 50, 100, 200];
    const minor = steps.find((st) => st * this.zoom >= 6) || 200;
    const major = steps.find((st) => st * this.zoom >= 50) || 200;
    const v = this.ps.view;
    const p0 = v.viewToProject(new this.ps.Point(0, 0));
    const p1 = v.viewToProject(new this.ps.Point(W, H));
    const gx = prep(top, W, R);
    gx.fillStyle = '#f7f8fa'; gx.fillRect(0, 0, W, R);
    gx.strokeStyle = '#9aa5b1'; gx.fillStyle = '#5b6672'; gx.font = '10px sans-serif';
    gx.beginPath();
    for (let x = Math.floor(p0.x / minor) * minor; x <= p1.x; x += minor) {
      const sx = v.projectToView(new this.ps.Point(x, 0)).x + 0.5;
      const isMajor = Math.abs(x / major - Math.round(x / major)) < 1e-6;
      gx.moveTo(sx, R); gx.lineTo(sx, isMajor ? 6 : 14);
      if (isMajor) gx.fillText(String(Math.round(x)), sx + 2, 10);
    }
    gx.stroke();
    const gy = prep(left, R, H);
    gy.fillStyle = '#f7f8fa'; gy.fillRect(0, 0, R, H);
    gy.strokeStyle = '#9aa5b1'; gy.fillStyle = '#5b6672'; gy.font = '10px sans-serif';
    gy.beginPath();
    for (let y = Math.floor(p1.y / minor) * minor; y <= p0.y; y += minor) {
      const sy = v.projectToView(new this.ps.Point(0, y)).y + 0.5;
      const isMajor = Math.abs(y / major - Math.round(y / major)) < 1e-6;
      gy.moveTo(R, sy); gy.lineTo(isMajor ? 6 : 14, sy);
      if (isMajor) { gy.save(); gy.translate(9, sy - 2); gy.rotate(-Math.PI / 2); gy.fillText(String(Math.round(y)), 0, 0); gy.restore(); }
    }
    gy.stroke();
  }

  drawGuides() {
    if (!this.guideLayer) return;
    this.guideLayer.removeChildren();
    const b = this.ps.view.bounds;
    (this.guides || []).forEach((g) => {
      const line = g.axis === 'x'
        ? new this.ps.Path.Line({ from: [g.v, b.top], to: [g.v, b.bottom], parent: this.guideLayer })
        : new this.ps.Path.Line({ from: [b.left, g.v], to: [b.right, g.v], parent: this.guideLayer });
      line.strokeColor = '#06b6d4';
      line.strokeWidth = 1;
      line.dashArray = [6, 4];
      line.strokeScaling = false;
    });
  }

  hitGuide(pt) {
    const tol = 5 / this.zoom;
    return (this.guides || []).find((g) => Math.abs((g.axis === 'x' ? pt.x : pt.y) - g.v) < tol) || null;
  }

  // 从标尺上按下：拖出新参考线
  rulerDown(ev, axis) {
    ev.preventDefault();
    const g = { axis, v: 0 };
    this.guides.push(g);
    this.dragGuide(g, ev);
  }

  dragGuide(g, ev0) {
    const wrap = this.$('.sk-canvas-wrap');
    const move = (ev) => {
      const r = wrap.getBoundingClientRect();
      const p = this.ps.view.viewToProject(new this.ps.Point(ev.clientX - r.left, ev.clientY - r.top));
      let v = g.axis === 'x' ? p.x : p.y;
      const st = this.snapStep || 0;
      if (st && !ev.altKey) v = Math.round(v / st) * st;
      g.v = v;
      this.drawGuides();
      this.status(`参考线 ${g.axis === 'x' ? 'X' : 'Y'} = ${fmt(v)} mm（拖回标尺上删除）`);
    };
    const up = (ev) => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      const r = wrap.getBoundingClientRect();
      const out = ev.clientX < r.left + 20 || ev.clientY < r.top + 20 || ev.clientX > r.right || ev.clientY > r.bottom;
      if (out) { this.guides = this.guides.filter((q) => q !== g); this.status('已删除参考线'); }
      this.drawGuides();
      this.emitChange();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    if (ev0) move(ev0);
  }

  // ================================================================ 尺寸标注（选中图形的直线段长度，点一下可改）

  drawDims() {
    const box = this.$('.sk-dims');
    if (!box) return;
    box.innerHTML = '';
    if (this.sel.size !== 1 || !['select', 'node'].includes(this.tool) || (this.drag && this.drag.kind !== 'node')) return;
    const it = [...this.sel][0];
    const paths = this.itemPaths(it);
    const segCount = paths.reduce((n, p) => n + p.curves.length, 0);
    if (segCount > 60 || it.data.text) return;
    const v = this.ps.view;
    paths.forEach((p) => p.curves.forEach((c) => {
      if (!c.isStraight() || c.length * this.zoom < 28) return;
      const mid = c.getPointAtTime(0.5);
      let n = c.getNormalAtTime(0.5).normalize(10 / this.zoom);
      if (p.closed && p.contains(mid.add(n))) n = n.negate();
      const at = v.projectToView(mid.add(n));
      const lab = document.createElement('button');
      lab.className = 'sk-dim';
      lab.textContent = fmt(c.length);
      lab.title = '点一下改这条边的长度（终点沿原方向移动）';
      lab.style.left = `${at.x}px`;
      lab.style.top = `${at.y}px`;
      lab.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      lab.addEventListener('click', () => this.editDim(c, lab));
      box.appendChild(lab);
    }));
  }

  editDim(curve, lab) {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = '0.1';
    inp.value = fmt(curve.length);
    inp.className = 'sk-dim-input';
    inp.style.left = lab.style.left;
    inp.style.top = lab.style.top;
    lab.replaceWith(inp);
    inp.focus();
    inp.select();
    const done = (ok) => {
      const L = Number(inp.value);
      if (ok && L > 0 && Math.abs(L - curve.length) > 1e-6) {
        const p1 = curve.point1.clone();
        const dir = curve.point2.subtract(p1).normalize();
        const it = this.topItem(curve.path);
        if (it && it.data.text) this.convertText(it);
        const delta = p1.add(dir.multiply(L)).subtract(curve.point2);
        // 矩形的一条边：对边一起挪，保持直角
        const nx = curve.next;
        const nn = nx && nx.next;
        const perp = nx && nx.isStraight() && Math.abs(nx.point2.subtract(nx.point1).normalize().dot(dir)) < 1e-3;
        const para = nn && nn.isStraight() && Math.abs(Math.abs(nn.point2.subtract(nn.point1).normalize().dot(dir)) - 1) < 1e-3;
        if (perp && para && nx.segment2 !== curve.segment1) {
          nx.segment2.point = nx.segment2.point.add(delta);
        }
        curve.segment2.point = curve.segment2.point.add(delta);
        this.commit(`边长改为 ${fmt(L)} mm`);
      } else this.drawDims();
    };
    inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); done(true); } if (ev.key === 'Escape') done(false); });
    inp.addEventListener('blur', () => done(true));
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

  // 编组：同一组的图形一起选中
  groupOf(it) {
    const g = it && it.data && it.data.group;
    return g ? this.content.children.filter((c) => c.data && c.data.group === g && this.selectable(c)) : [it];
  }

  expandGroups() {
    [...this.sel].forEach((it) => this.groupOf(it).forEach((c) => this.sel.add(c)));
  }

  // 一批复制品：组号换成新的（同一批里原来同组的仍然同组）
  regroup(items) {
    const map = new Map();
    items.forEach((it) => {
      const g = it.data.group;
      if (!g) return;
      if (!map.has(g)) map.set(g, newId());
      it.data.group = map.get(g);
    });
    return items;
  }

  groupSel() {
    if (this.sel.size < 2) { this.toast('选中 2 个以上图形再编组', 'error'); return; }
    const g = newId();
    this.sel.forEach((it) => { it.data.group = g; });
    this.commit(`已编组（${this.sel.size} 个图形）`);
  }

  ungroupSel() {
    let n = 0;
    this.sel.forEach((it) => { if (it.data.group) { it.data.group = null; n++; } });
    if (!n) { this.toast('选中的图形没有编组', 'error'); return; }
    this.commit('已取消编组');
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
    this.drawDims();
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
    if (this.opts.alignTo === 'key' && this.sel.size > 1 && this.keyItem && this.sel.has(this.keyItem)) {
      new ps.Path.Rectangle({ rectangle: this.keyItem.bounds.expand(2 / this.zoom), parent: this.overlay,
        strokeColor: '#1f6feb', strokeWidth: 2.5, strokeScaling: false });
    }
    this.drawArrayPreview();
  }

  hitHandle(pt) {
    const tol = 7 / this.zoom;
    return (this.handles || []).find((h) => h.at.getDistance(pt) <= tol) || null;
  }

  // ================================================================ 工具

  setTool(id) {
    this.finishDrawing();
    if (id !== this.tool) this.editJoint = null;
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
    if (this.tool === 'select' && !this.hitHandle(pt) && !this.hitItem(pt)) {
      const g = this.hitGuide(pt);
      if (g) { this.dragGuide(g, null); return; }
    }
    if (this.pickCenter) {
      this.pickCenter = false;
      const c = this.snap(pt);
      Object.assign(this.opts, { arrCenter: 'pick', arrCx: c.x, arrCy: c.y, arrType: 'circle' });
      this.renderArray();
      this.setTool(this.tool);
      this.status(`环形阵列中心：(${fmt(c.x)}, ${fmt(c.y)})`);
      return;
    }
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
    if (t === 'joint') { this.jointAt(pt); return; }
    if (t === 'bridge') { this.bridgeAt(pt); return; }
    if (t === 'mortise') {
      const ex = this.existingJoint(pt, ['mortise']);
      if (ex && !this.editJoint) { this.startEditJoint(ex); return; }
      const peer = this.opts.jointPeer;
      if (peer && peer.type === 'a') { this.placeMortise(this.snap(pt), null); return; }
      this.drag = { kind: 'mortise', from: this.snap(pt) };
      return;
    }
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
    else if (d.kind === 'mortise') {
      let p = this.snap(pt);
      if (ev.shiftKey) p = this.constrain45(d.from, p);
      d.to = p;
      if (this.rubber) this.rubber.remove();
      this.rubber = this.mortisePreview(d.from, p);
    }
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
        this.expandGroups();
      } else if (!e.event.shiftKey) this.sel.clear();
      this.refresh();
    } else if (d.kind === 'shape') this.shapeFinish(d);
    else if (d.kind === 'penHandle') { /* 点已加入 */ }
    else if (d.kind === 'trim') { if (d.changed) this.commit('已修剪'); }
    else if (d.kind === 'mortise') { if (this.rubber) { this.rubber.remove(); this.rubber = null; } if (d.to) this.placeMortise(d.from, d.to); }
    this.showSnap(null);
  }

  onMove(e) {
    this.showCoords(e.point);
    if (this.tool === 'line' || this.tool === 'pen') this.pathHover(e.point, e.event);
    else if (this.tool === 'trim') this.trimHover(e.point);
    else if (this.tool === 'joint') this.jointHover(e.point);
    else if (this.tool === 'mortise' && this.opts.jointPeer && this.opts.jointPeer.type === 'a') {
      if (this.rubber) this.rubber.remove();
      const [f, t2] = this.mortiseEnds(this.snap(e.point));
      this.rubber = this.mortisePreview(f, t2);
    }
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
        if (this.sel.has(it)) this.groupOf(it).forEach((c) => this.sel.delete(c)); else { this.groupOf(it).forEach((c) => this.sel.add(c)); this.keyItem = it; }
        this.refresh();
        return;
      }
      if (!this.sel.has(it)) { this.sel.clear(); this.groupOf(it).forEach((c) => this.sel.add(c)); this.refresh(); }
      this.keyItem = it;
      if (e.event.altKey) {   // Alt 拖动 = 复制
        const copies = this.regroup([...this.sel].map((s) => this.cloneItem(s)));
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
    c.data = { ...it.data, id: newId(), role: null, locked: false, text: it.data.text ? { ...it.data.text } : null,
               joints: it.data.joints ? it.data.joints.map((j) => ({ ...j, id: newId() })) : null };
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

  // ---------------------------------------------------------------- 卡榫
  //
  // 卡榫用「A 齿区间」描述：沿边从起点量起的 [开始, 结束]（mm）。
  //   指接 A：这些区间凸出；指接 B：其余部分凸出；凹槽：这些区间凹进；插槽：这些区间开孔。
  // 区间对称排在边的中间，所以边反过来也能配对。

  jointDepth() { return Number(this.opts.jointDepth) || this.part.thickness || 3; }

  // 按当前设置算 A 齿区间
  jointIntervals(L) {
    const t = this.jointDepth();
    if (this.opts.jointMode === 'width') {
      const wt = Math.max(0.5, Number(this.opts.jointTab) || 2 * t);
      const wg = Math.max(0.5, Number(this.opts.jointGap) || wt);
      const n = Math.max(1, Math.floor((L - wg) / (wt + wg)));
      const total = n * wt + (n - 1) * wg;
      if (total > L) return [];
      const start = (L - total) / 2;
      return Array.from({ length: n }, (_, i) => [start + i * (wt + wg), start + i * (wt + wg) + wt]);
    }
    let k = Math.round(Number(this.opts.jointCount) || 0);
    if (k <= 0) { k = Math.max(3, Math.floor(L / (t * 3))); if (k % 2 === 0) k -= 1; }
    k = Math.max(1, k);
    const step = L / k;
    const out = [];
    for (let i = 1; i < k; i += 2) out.push([i * step, (i + 1) * step]);
    if (!out.length) out.push([0, L]);   // 只有 1 段：整段
    return out;
  }

  static complement(iv, L) {
    const out = [];
    let x = 0;
    iv.forEach(([s, e]) => { if (s > x + 1e-6) out.push([x, s]); x = e; });
    if (L > x + 1e-6) out.push([x, L]);
    return out;
  }

  jointEdge(pt) {
    const tol = 6 / this.zoom;
    const res = this.content.hitTest(pt, { stroke: true, tolerance: tol,
      match: (h) => { const it = this.topItem(h.item); return it && this.selectable(it) && it.data.mode === 'cut'; } });
    if (!res || !res.location) return null;
    const curve = res.location.curve;
    if (!curve || !curve.isStraight() || curve.length < 1) return null;
    const path = curve.path;
    if (!path.closed) return null;
    return { curve, path, item: this.topItem(path) };
  }

  // 点击处是不是已有的卡榫（返回 { item, joint }）
  existingJoint(pt, types) {
    const tol = 6 / this.zoom;
    for (const it of this.content.children) {
      if (!it.data || !it.data.joints || !this.selectable(it)) continue;
      for (const j of it.data.joints) {
        if (!types.includes(j.type)) continue;
        const a = new this.ps.Point(j.a[0], j.a[1]);
        const b = new this.ps.Point(j.b[0], j.b[1]);
        const u = b.subtract(a);
        const L = u.length;
        if (L < 1e-6) continue;
        const d = u.divide(L);
        const w = pt.subtract(a);
        const s = w.dot(d);
        const off = Math.abs(w.x * -d.y + w.y * d.x);
        const reach = (j.type === 'mortise' ? (j.depth || 3) / 2 : (j.depth || 3)) + tol;
        if (s >= -tol && s <= L + tol && off <= reach) return { item: it, joint: j };
      }
    }
    return null;
  }

  // 边上的卡榫折线（不含两端点）
  jointPoints(a, b, inside, type, iv, depth) {
    const L = b.getDistance(a);
    const dir = b.subtract(a).normalize();
    let n = new this.ps.Point(-dir.y, dir.x);                       // 法线：朝外
    const mid = a.add(b).divide(2);
    if (inside(mid.add(n.multiply(Math.min(0.5, depth / 4))))) n = n.negate();
    const raised = type === 'b' ? SketchEditor.complement(iv, L) : iv;
    const off = type === 'slot' ? n.multiply(-depth) : n.multiply(depth);
    const out = [];
    raised.forEach(([s, e]) => {
      const p0 = a.add(dir.multiply(s));
      const p1 = a.add(dir.multiply(e));
      out.push(p0, p0.add(off), p1.add(off), p1);
    });
    const clean = out.filter((q, i) => !((i === 0 && q.getDistance(a) < 1e-6) || (i === out.length - 1 && q.getDistance(b) < 1e-6)));
    return { pts: clean, n };
  }

  jointMeta(type, iv, depth, a, b, n) {
    return { type, iv: iv.map(([s, e]) => [r3(s), r3(e)]), k: iv.length, depth, L: r3(b.getDistance(a)),
      mode: this.opts.jointMode, count: Number(this.opts.jointCount) || 0, tab: Number(this.opts.jointTab) || 0,
      gap: Number(this.opts.jointGap) || 0, a: [a.x, a.y], b: [b.x, b.y], c: [a.x + n.x, a.y + n.y] };
  }

  jointHover(pt) {
    if (this.rubber) { this.rubber.remove(); this.rubber = null; }
    const ex = !this.editJoint && this.existingJoint(pt, ['a', 'b', 'slot']);
    if (ex) {
      const j = ex.joint;
      this.rubber = new this.ps.Path.Line({ from: j.a, to: j.b, parent: this.overlay, strokeColor: '#0ea5e9', strokeWidth: 4, strokeScaling: false, opacity: 0.6 });
      this.status(`已有卡榫：边长 ${fmt(j.L)} mm · ${j.k} 个齿 · 单击修改它的大小 / 数量`);
      return;
    }
    const e = this.jointEdge(pt);
    if (!e) return;
    const a = e.curve.point1;
    const b = e.curve.point2;
    const iv = this.jointIntervals(e.curve.length);
    const { pts } = this.jointPoints(a, b, (q) => e.path.contains(q), this.opts.jointType, iv, this.jointDepth());
    this.rubber = new this.ps.Path({ parent: this.overlay, segments: [a, ...pts, b], strokeColor: '#f97316', strokeWidth: 2, strokeScaling: false });
    const peer = this.opts.jointPeer;
    const warn = peer && Math.abs(peer.L - e.curve.length) > 0.3 ? `  ⚠ 和配对边（${fmt(peer.L)} mm）不一样长，拼不上` : '';
    this.status(`边长 ${fmt(e.curve.length)} mm · ${iv.length} 个 A 齿 · 单击应用${warn}`);
  }

  jointAt(pt) {
    if (this.rubber) { this.rubber.remove(); this.rubber = null; }
    const ex = this.existingJoint(pt, ['a', 'b', 'slot']);
    if (ex) { this.startEditJoint(ex); return; }
    const e = this.jointEdge(pt);
    if (!e) { this.status('请点在闭合切割轮廓的一条直边上'); return; }
    const a = e.curve.point1.clone();
    const b = e.curve.point2.clone();
    const iv = this.opts.jointPeer && this.opts.jointPeer.iv && Math.abs(this.opts.jointPeer.L - e.curve.length) < 0.3
      ? this.opts.jointPeer.iv.map((q) => [...q]) : this.jointIntervals(e.curve.length);
    if (!iv.length) { this.status('边太短，放不下这样的齿'); return; }
    const depth = this.jointDepth();
    const { pts, n } = this.jointPoints(a, b, (q) => e.path.contains(q), this.opts.jointType, iv, depth);
    if (e.item.data.text) this.convertText(e.item);
    e.path.insertSegments(e.curve.segment1.index + 1, pts.map((q) => new this.ps.Segment(q)));
    e.item.data.joints = [...(e.item.data.joints || []), { id: newId(), ...this.jointMeta(this.opts.jointType, iv, depth, a, b, n) }];
    this.commit(`已做成卡榫（${iv.length} 个 A 齿，边长 ${fmt(b.getDistance(a))} mm）`);
  }

  // ---- 修改已有的卡榫：载入参数 → 右侧改 → 应用（先恢复成直边再重做）

  startEditJoint({ item, joint }) {
    this.editJoint = { itemId: item.data.id, jointId: joint.id };
    const t = this.part.thickness || 3;
    this.opts.jointType = joint.type === 'mortise' ? this.opts.jointType : joint.type;
    this.opts.jointMode = joint.mode || 'count';
    this.opts.jointCount = joint.count || (joint.mode === 'width' ? 0 : 2 * joint.k + 1);
    this.opts.jointTab = joint.tab || 2 * t;
    this.opts.jointGap = joint.gap || joint.tab || 2 * t;
    this.opts.jointDepth = joint.depth || t;
    this.opts.jointPeer = null;
    this.sel = new Set([item]);
    this.refresh();
    this.status(`正在修改这条卡榫（边长 ${fmt(joint.L)} mm）：在右侧调整后点「应用修改」`);
  }

  findEdit() {
    const ed = this.editJoint;
    if (!ed) return null;
    const item = this.content.children.find((c) => c.data && c.data.id === ed.itemId);
    const joint = item && (item.data.joints || []).find((j) => j.id === ed.jointId);
    return item && joint ? { item, joint } : null;
  }

  // 把边恢复成直线（删掉 a、b 之间插入的节点）；成功时返回所在路径
  straightenEdge(item, j) {
    const a = new this.ps.Point(j.a[0], j.a[1]);
    const b = new this.ps.Point(j.b[0], j.b[1]);
    for (const p of this.itemPaths(item)) {
      const segs = p.segments;
      const ia = segs.findIndex((s) => s.point.getDistance(a) < 1e-3);
      const ib = segs.findIndex((s) => s.point.getDistance(b) < 1e-3);
      if (ia < 0 || ib < 0) continue;
      const n = segs.length;
      const count = (ib - ia - 1 + n) % n;
      if (count > n - 3) return null;
      const segA = segs[ia];
      for (let k = 0; k < count; k++) p.removeSegment((segA.index + 1) % p.segments.length);
      return p;
    }
    return null;
  }

  applyEditJoint(remove) {
    const f = this.findEdit();
    this.editJoint = null;
    if (!f) { this.status('找不到要修改的卡榫'); this.refresh(); return; }
    const { item, joint } = f;
    if (joint.type === 'mortise') return this.applyEditMortise(item, joint, remove);
    const path = this.straightenEdge(item, joint);
    if (!path) { this.status('这条边被改动过，没法自动修改；可以撤销后重做'); this.refresh(); return; }
    item.data.joints = item.data.joints.filter((j) => j.id !== joint.id);
    if (remove) { this.commit('已删除卡榫，恢复成直边'); return; }
    const a = new this.ps.Point(joint.a[0], joint.a[1]);
    const b = new this.ps.Point(joint.b[0], joint.b[1]);
    const iv = this.jointIntervals(b.getDistance(a));
    if (!iv.length) { this.commit('边太短，放不下这样的齿（已恢复成直边）'); return; }
    const depth = this.jointDepth();
    const ia = path.segments.findIndex((s) => s.point.getDistance(a) < 1e-3);
    const { pts, n } = this.jointPoints(a, b, (q) => path.contains(q), this.opts.jointType, iv, depth);
    path.insertSegments(ia + 1, pts.map((q) => new this.ps.Segment(q)));
    item.data.joints.push({ id: joint.id, ...this.jointMeta(this.opts.jointType, iv, depth, a, b, n) });
    this.commit(`已修改卡榫（${iv.length} 个 A 齿）`);
  }

  // ---------------------------------------------------------------- 插槽（T 型连接）

  mortiseEnds(center) {
    const L = this.opts.jointPeer.L;
    const d = this.opts.mortiseVertical ? new this.ps.Point(0, L / 2) : new this.ps.Point(L / 2, 0);
    return [center.subtract(d), center.add(d)];
  }

  mortiseRects(from, to, ivForce) {
    const L = to.getDistance(from);
    if (L < 1) return null;
    const t = this.jointDepth();
    const play = Math.max(0, Number(this.opts.jointPlay) || 0);
    const iv = ivForce || this.jointIntervals(L);
    const u = to.subtract(from).normalize();
    const v = new this.ps.Point(-u.y, u.x);
    const w = t / 2 + play / 2;
    const rects = iv.map(([s, e]) => {
      const p0 = from.add(u.multiply(s - play / 2));
      const p1 = from.add(u.multiply(e + play / 2));
      return [p0.add(v.multiply(-w)), p1.add(v.multiply(-w)), p1.add(v.multiply(w)), p0.add(v.multiply(w))];
    });
    return { rects, iv, t, L, u, v };
  }

  mortisePreview(from, to) {
    const peer = this.opts.jointPeer;
    const r = this.mortiseRects(from, to, peer && peer.iv && Math.abs(peer.L - to.getDistance(from)) < 0.3 ? peer.iv : null);
    const g = new this.ps.Group({ parent: this.overlay });
    g.addChild(new this.ps.Path.Line({ from, to, strokeColor: '#f97316', dashArray: [4, 3], strokeWidth: 1, strokeScaling: false }));
    if (r) {
      r.rects.forEach((q) => g.addChild(new this.ps.Path({ segments: q, closed: true, strokeColor: '#f97316', strokeWidth: 1.5, strokeScaling: false })));
      this.status(`插槽长 ${fmt(r.L)} mm · ${r.rects.length} 个孔 · 孔宽 ${fmt(r.t)} mm`);
    }
    return g;
  }

  mortiseMeta(r, from, to) {
    return { type: 'mortise', iv: r.iv.map(([s, e]) => [r3(s), r3(e)]), k: r.iv.length, depth: r.t, L: r3(r.L),
      play: Number(this.opts.jointPlay) || 0, mode: this.opts.jointMode, count: Number(this.opts.jointCount) || 0,
      tab: Number(this.opts.jointTab) || 0, gap: Number(this.opts.jointGap) || 0,
      a: [from.x, from.y], b: [to.x, to.y], c: [from.x + r.v.x, from.y + r.v.y] };
  }

  placeMortise(from, to) {
    if (!to) [from, to] = this.mortiseEnds(from);
    if (this.rubber) { this.rubber.remove(); this.rubber = null; }
    const peer = this.opts.jointPeer;
    const r = this.mortiseRects(from, to, peer && peer.iv && Math.abs(peer.L - to.getDistance(from)) < 0.3 ? peer.iv : null);
    if (!r || !r.rects.length) { this.status('插槽太短'); return; }
    const it = this.addItem({ mode: 'cut', paths: r.rects.map((q) => ({ closed: true, segs: q.map((p) => [p.x, p.y, 0, 0, 0, 0]) })),
      joints: [{ id: newId(), ...this.mortiseMeta(r, from, to) }] });
    this.sel = new Set([it]);
    this.commit(`已开插槽（${r.rects.length} 个孔，长 ${fmt(r.L)} mm）`);
  }

  applyEditMortise(item, joint, remove) {
    if (remove) { item.remove(); this.sel.delete(item); this.commit('已删除插槽'); return; }
    const from = new this.ps.Point(joint.a[0], joint.a[1]);
    const to = new this.ps.Point(joint.b[0], joint.b[1]);
    const r = this.mortiseRects(from, to);
    if (!r || !r.rects.length) { this.status('插槽太短'); this.refresh(); return; }
    const fresh = this.addItem({ mode: 'cut', paths: r.rects.map((q) => ({ closed: true, segs: q.map((p) => [p.x, p.y, 0, 0, 0, 0]) })),
      joints: [{ id: joint.id, ...this.mortiseMeta(r, from, to) }] });
    fresh.data.id = item.data.id;
    fresh.insertAbove(item);
    item.remove();
    this.sel = new Set([fresh]);
    this.commit(`已修改插槽（${r.rects.length} 个孔）`);
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
      reset: () => {                      // 再点一次确认（WKWebView 不支持 confirm 对话框）
        const b = this.$('[data-act=reset]');
        if (!b.classList.contains('confirm')) {
          b.classList.add('confirm');
          b.textContent = '确定恢复？再点一次';
          setTimeout(() => { b.classList.remove('confirm'); b.textContent = this.part.free ? '恢复矩形' : '恢复原板'; }, 3000);
          return;
        }
        b.classList.remove('confirm');
        b.textContent = this.part.free ? '恢复矩形' : '恢复原板';
        this.resetToOriginal();
      },
      unite: () => this.boolean('unite'), subtract: () => this.boolean('subtract'),
      intersect: () => this.boolean('intersect'), exclude: () => this.boolean('exclude'),
      offset: () => this.offsetSel(), array: () => this.arraySel(),
      flipH: () => this.transformSel((it, c) => it.scale(-1, 1, c), '已水平镜像'),
      flipV: () => this.transformSel((it, c) => it.scale(1, -1, c), '已垂直镜像'),
      rotL: () => this.transformSel((it, c) => it.rotate(90, c), '已旋转'),
      rotR: () => this.transformSel((it, c) => it.rotate(-90, c), '已旋转'),
      breakApart: () => this.breakApart(),
      import: () => this.startImport(),
      group: () => this.groupSel(), ungroup: () => this.ungroupSel(),
      fillet: () => this.cornerSel(false), chamfer: () => this.cornerSel(true),
      dedupe: () => this.dedupeItems(),
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
    this.regroup(this.clip.map((it) => this.addItem({ ...it, id: newId(), role: null, locked: false }))).forEach((it) => this.sel.add(it));
    this.commit('已粘贴');
  }

  duplicate() {
    if (!this.need(1)) return;
    const copies = this.regroup([...this.sel].map((it) => this.cloneItem(it)));
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

  // ---------------------------------------------------------------- 阵列（矩形 / 直线 / 环形）

  renderArray() {
    const o = this.opts;
    const box = this.$('.sk-array');
    const type = `<div class="sk-seg">${[['line', '直线'], ['circle', '环形'], ['grid', '矩形']].map(([k, n]) =>
      `<button data-at="${k}" class="${o.arrType === k ? 'on' : ''}">${n}</button>`).join('')}</div>`;
    let rows = '';
    if (o.arrType === 'grid') {
      rows = `<div class="sk-row"><label>行<input data-a="arrRows" type="number" min="1" step="1" value="${o.arrRows}"></label>
          <label>列<input data-a="arrCols" type="number" min="1" step="1" value="${o.arrCols}"></label></div>
        <div class="sk-row"><label>间距 X<input data-a="arrDx" type="number" step="1" value="${o.arrDx}"></label>
          <label>Y<input data-a="arrDy" type="number" step="1" value="${o.arrDy}"> mm</label></div>
        <p class="sk-small">间距是相邻两份对应点之间的距离；行往下排。</p>`;
    } else if (o.arrType === 'line') {
      rows = `<div class="sk-row"><label>数量<input data-a="arrCount" type="number" min="2" step="1" value="${o.arrCount}"></label>
          <label>间距<input data-a="arrDist" type="number" step="0.5" value="${o.arrDist}"> mm</label></div>
        <div class="sk-row"><label>方向<input data-a="arrAngle" type="number" step="15" value="${o.arrAngle}"> °</label>
          <span class="sk-small">0 = 向右，90 = 向上</span></div>`;
    } else {
      const cname = { board: '板中心', sel: '选区中心', pick: `点选（${fmt(o.arrCx)}, ${fmt(o.arrCy)}）` }[o.arrCenter];
      rows = `<div class="sk-row"><label>数量<input data-a="arrCount" type="number" min="2" step="1" value="${o.arrCount}"></label>
          <label>总角度<input data-a="arrSweep" type="number" step="15" value="${o.arrSweep}"> °</label></div>
        <div class="sk-row"><span>中心</span>
          <button data-ac="board" class="${o.arrCenter === 'board' ? 'on' : ''}">板中心</button>
          <button data-ac="pick" class="${o.arrCenter === 'pick' ? 'on' : ''}" title="在画布上单击一点作为中心">点选</button></div>
        <div class="sk-row"><label class="sk-check"><input data-a="arrRotate" type="checkbox" ${o.arrRotate ? 'checked' : ''}>复制品跟着旋转</label></div>
        <p class="sk-small">当前中心：${cname}。总角度 360° 时平均分布一整圈；小于 360° 时首尾各放一个。</p>`;
    }
    box.innerHTML = type + rows + `<div class="sk-row"><label class="sk-check"><input data-a="arrPreview" type="checkbox" ${o.arrPreview ? 'checked' : ''}>预览</label>
      <span class="sk-spacer"></span><button data-act2="array" class="sk-primary">阵列</button></div>`;
    box.querySelectorAll('[data-at]').forEach((b) => b.addEventListener('click', () => { o.arrType = b.dataset.at; this.renderArray(); this.drawSelection(); }));
    box.querySelectorAll('[data-ac]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.ac === 'pick') { this.pickCenter = true; this.status('在画布上单击一点作为环形阵列的中心'); this.canvas.style.cursor = 'crosshair'; return; }
      o.arrCenter = b.dataset.ac; this.renderArray(); this.drawSelection();
    }));
    box.querySelectorAll('[data-a]').forEach((el) => {
      const upd = () => { o[el.dataset.a] = el.type === 'checkbox' ? el.checked : Number(el.value); this.drawSelection(); };
      el.addEventListener('input', upd);
      el.addEventListener('change', upd);
    });
    box.querySelector('[data-act2=array]').addEventListener('click', () => this.arraySel());
  }

  arrayCenter() {
    const o = this.opts;
    if (o.arrCenter === 'pick') return new this.ps.Point(o.arrCx, o.arrCy);
    const outline = this.content.children.find((c) => c.data && c.data.role === 'outline');
    if (outline) return outline.bounds.center;
    const b = this.selBounds();
    return b ? b.center : new this.ps.Point(0, 0);
  }

  // 每一份复制品的变换矩阵（不含原件）
  arrayMatrices() {
    const o = this.opts;
    const M = this.ps.Matrix;
    const out = [];
    if (o.arrType === 'grid') {
      const rows = Math.max(1, Math.round(o.arrRows));
      const cols = Math.max(1, Math.round(o.arrCols));
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) if (r || c) out.push(new M().translate(c * (Number(o.arrDx) || 0), -r * (Number(o.arrDy) || 0)));
      }
    } else if (o.arrType === 'line') {
      const n = Math.max(2, Math.round(o.arrCount));
      const a = (Number(o.arrAngle) || 0) * Math.PI / 180;
      const d = Number(o.arrDist) || 0;
      for (let i = 1; i < n; i++) out.push(new M().translate(Math.cos(a) * d * i, Math.sin(a) * d * i));
    } else {
      const n = Math.max(2, Math.round(o.arrCount));
      const sweep = Number(o.arrSweep) || 360;
      const step = Math.abs(Math.abs(sweep) - 360) < 1e-6 ? sweep / n : sweep / (n - 1);
      const c = this.arrayCenter();
      const sc = this.selBounds() ? this.selBounds().center : c;
      for (let i = 1; i < n; i++) {
        const R = new M().rotate(step * i, c);
        if (o.arrRotate) out.push(R);
        else { const q = R.transform(sc); out.push(new M().translate(q.x - sc.x, q.y - sc.y)); }
      }
    }
    return out;
  }

  // 选区 + 阵列参数：刚阵列过同样的东西时不再显示预览
  arrayKey() {
    const o = this.opts;
    return JSON.stringify([[...this.sel].map((i) => i.data.id).sort(), o.arrType, o.arrCount, o.arrDist, o.arrAngle, o.arrRows,
      o.arrCols, o.arrDx, o.arrDy, o.arrSweep, o.arrRotate, o.arrCenter, o.arrCx, o.arrCy]);
  }

  drawArrayPreview() {
    // 只在鼠标停在「阵列」卡片上（或正在改里面的数值）时预览，免得做别的操作时干扰
    if (!this.arrActive || !this.opts.arrPreview || !this.sel.size || this.tool !== 'select') return;
    if (this.arrDoneKey && this.arrDoneKey === this.arrayKey()) return;
    const mats = this.arrayMatrices();
    if (mats.length > 400) return;
    const g = new this.ps.Group({ parent: this.overlay });
    mats.forEach((m) => this.sel.forEach((it) => {
      const k = it.clone({ insert: false });
      k.transform(m);
      k.fillColor = null;
      k.strokeColor = '#f97316';
      k.dashArray = [3, 3];
      k.strokeWidth = 1;
      k.strokeScaling = false;
      k.opacity = 0.8;
      g.addChild(k);
    }));
    if (this.opts.arrType === 'circle') {
      const c = this.arrayCenter();
      const r = 4 / this.zoom;
      g.addChild(new this.ps.Path.Line({ from: [c.x - r, c.y], to: [c.x + r, c.y], strokeColor: '#f97316', strokeWidth: 1.5, strokeScaling: false }));
      g.addChild(new this.ps.Path.Line({ from: [c.x, c.y - r], to: [c.x, c.y + r], strokeColor: '#f97316', strokeWidth: 1.5, strokeScaling: false }));
    }
  }

  arraySel() {
    if (!this.need(1, '先选中要阵列的图形')) return;
    const mats = this.arrayMatrices();
    if (!mats.length) { this.toast('数量至少为 2', 'error'); return; }
    if (mats.length * this.sel.size > 2000) { this.toast('复制太多了（超过 2000 份）', 'error'); return; }
    const src = [...this.sel];
    let n = 0;
    mats.forEach((m) => this.regroup(src.map((it) => { const k = this.cloneItem(it); this.convertTextIfRotated(k); k.transform(m); n++; return k; })));
    // 只保留原来选中的对象（复制品不选中），并且不再显示同样的预览
    this.sel = new Set(src);
    this.arrDoneKey = this.arrayKey();
    const name = { grid: '矩形', line: '直线', circle: '环形' }[this.opts.arrType];
    this.commit(`已${name}阵列（共 ${mats.length + 1} 份）`);
  }

  align(how) {
    const items = [...this.sel];
    if (how === 'dh' || how === 'dv') return this.distribute(how, items);
    if (!items.length) { this.toast('先选中要对齐的图形（Shift 点选或框选多个）', 'error'); return; }
    const outline = this.content.children.find((c) => c.data && c.data.role === 'outline');
    let mode = this.opts.alignTo;
    if (items.length === 1) mode = 'board';
    let ref;
    let fixed = null;
    if (mode === 'board') {
      ref = outline ? outline.bounds : null;
      if (!ref) { this.toast('找不到外轮廓，没法对齐到整块板', 'error'); return; }
    } else if (mode === 'key') {
      fixed = this.keyItem && this.sel.has(this.keyItem) ? this.keyItem : items[items.length - 1];
      ref = fixed.bounds;
    } else ref = this.selBounds();
    items.forEach((it) => {
      if (it === fixed) return;
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
    const to = { board: '整块板', key: '关键对象', sel: '选区' }[mode];
    this.commit(`已${ALIGN_NAMES[how]}（对齐到${to}）`);
  }

  // 等距分布：最外两个不动，中间的按间隙相等排开
  distribute(how, items) {
    if (items.length < 3) { this.toast('等距分布要选中至少 3 个图形', 'error'); return; }
    const h = how === 'dh';
    const lo = (b) => (h ? b.left : b.top);
    const size = (b) => (h ? b.width : b.height);
    const sorted = items.slice().sort((p, q) => lo(p.bounds) + size(p.bounds) / 2 - (lo(q.bounds) + size(q.bounds) / 2));
    const first = sorted[0].bounds;
    const last = sorted[sorted.length - 1].bounds;
    const span = lo(last) + size(last) - lo(first);
    const total = sorted.reduce((sum, it) => sum + size(it.bounds), 0);
    const gap = (span - total) / (sorted.length - 1);
    let x = lo(first);
    sorted.forEach((it, i) => {
      const b = it.bounds;
      if (i > 0 && i < sorted.length - 1) {
        const d = x - lo(b);
        it.translate(h ? new this.ps.Point(d, 0) : new this.ps.Point(0, d));
      }
      x += size(b) + gap;
    });
    this.commit(`已${ALIGN_NAMES[how]}（间隙 ${fmt(gap)} mm）`);
  }

  // ================================================================ 导入（SVG / DXF / 图片描摹）

  startImport() {
    let inp = this.$('.sk-file');
    if (!inp) {
      inp = document.createElement('input');
      inp.type = 'file';
      inp.className = 'sk-file';
      inp.accept = '.svg,.dxf,.png,.jpg,.jpeg,.gif,.webp,.bmp,image/*';
      inp.style.display = 'none';
      inp.addEventListener('change', () => { const f = inp.files && inp.files[0]; inp.value = ''; if (f) this.importFile(f); });
      this.host.appendChild(inp);
    }
    inp.click();
  }

  async importFile(file) {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    try {
      if (ext === 'svg') {
        const paths = this.svgToPaths(await readFile(file, true));
        if (!paths.length) throw new Error('SVG 里没有找到图形');
        this.vectorDialog(file.name, paths);
      } else if (ext === 'dxf') {
        const r = parseDXF(await readFile(file, true));
        if (!r.paths.length) throw new Error('DXF 里没有找到可识别的图形（支持直线、多段线、圆、圆弧、椭圆、样条）');
        this.vectorDialog(file.name, r.paths);
      } else {
        const url = await readFile(file, false);
        this.imageDialog(file.name, await loadImage(url));
      }
    } catch (err) {
      this.toast(String(err.message || err), 'error');
    }
  }

  // SVG → [{ closed, segs }]（单位 mm、y 向上）
  svgToPaths(text) {
    const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
    const svg = doc.documentElement;
    const toMM = (v) => {
      const m = /^([\d.]+)\s*(mm|cm|in|pt|px)?$/.exec((v || '').trim());
      if (!m) return null;
      return parseFloat(m[1]) * ({ mm: 1, cm: 10, in: 25.4, pt: 25.4 / 72, px: 25.4 / 96 }[m[2] || 'px']);
    };
    const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
    const wmm = toMM(svg.getAttribute('width'));
    let unit = 25.4 / 96;                                      // 没写单位：按 96 dpi 的像素
    if (wmm && vb.length === 4 && vb[2] > 0) unit = wmm / vb[2];
    else if (wmm && !vb.length) unit = 1 * (wmm / parseFloat(svg.getAttribute('width')));
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    const ps = this.ps;
    ps.activate();
    const g = ps.project.importSVG(new XMLSerializer().serializeToString(svg), { insert: false, expandShapes: true });
    const out = [];
    const chain = (it) => {
      const m = new ps.Matrix();
      let p = it.parent;
      while (p) { m.prepend(p.matrix); p = p.parent; }
      return m;
    };
    g.getItems({ match: (it) => (it.className === 'Path' || it.className === 'CompoundPath') && !(it.parent && it.parent.className === 'CompoundPath') })
      .forEach((it) => {
        const c = it.clone({ insert: false });
        c.transform(chain(it));
        c.scale(unit, -unit, new ps.Point(0, 0));
        (c.className === 'CompoundPath' ? c.children : [c]).forEach((p) => {
          if (p.segments.length < 2) return;
          out.push({ closed: p.closed, segs: p.segments.map((sg) => [sg.point.x, sg.point.y, sg.handleIn.x, sg.handleIn.y, sg.handleOut.x, sg.handleOut.y]) });
        });
      });
    return out;
  }

  modal(html) {
    let m = this.$('.sk-modal');
    if (!m) { m = document.createElement('div'); m.className = 'sk-modal'; this.host.appendChild(m); }
    m.innerHTML = `<div class="sk-modal-box">${html}</div>`;
    m.classList.remove('hidden');
    const close = () => m.classList.add('hidden');
    m.querySelectorAll('[data-m=cancel]').forEach((b) => b.addEventListener('click', close));
    return { el: m, close };
  }

  boardBounds() {
    const outline = this.content.children.find((c) => c.data && c.data.role === 'outline');
    return outline ? outline.bounds : new this.ps.Rectangle(0, 0, 100, 100);
  }

  // 矢量导入：缩放、放到板中心、选加工方式
  vectorDialog(name, rawPaths) {
    const paths = rawPaths.map((p) => (p.segs ? p : { closed: p.closed, segs: p.pts.map(([x, y]) => [x, y, 0, 0, 0, 0]) }));
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    paths.forEach((p) => p.segs.forEach((s) => { x0 = Math.min(x0, s[0]); x1 = Math.max(x1, s[0]); y0 = Math.min(y0, s[1]); y1 = Math.max(y1, s[1]); }));
    const w = Math.max(0.01, x1 - x0); const h = Math.max(0.01, y1 - y0);
    const bb = this.boardBounds();
    const fitW = Math.min(w, (w / h > bb.width / bb.height ? bb.width : bb.height * w / h) * 0.8);
    const closedN = paths.filter((p) => p.closed).length;
    const { el, close } = this.modal(`
      <h3>导入 ${escAttr(name)}</h3>
      <p class="sk-small">${paths.length} 条路径（${closedN} 条闭合）· 原始尺寸 ${fmt(w)} × ${fmt(h)} mm</p>
      <div class="sk-row"><label>宽度<input data-v="w" type="number" min="0.1" step="1" value="${fmt(fitW)}"> mm</label>
        <span class="sk-small">高 <b data-v="h">${fmt(fitW * h / w)}</b> mm（等比）</span>
        <button data-v="orig">原始尺寸</button></div>
      <div class="sk-row"><label>加工方式<select data-v="mode">
        ${Object.entries(MODES).map(([k, m]) => `<option value="${k}" ${k === (closedN ? 'cut' : 'score') ? 'selected' : ''}>${m.name}</option>`).join('')}</select></label>
        <label class="sk-check"><input data-v="center" type="checkbox" checked>放到板中心</label></div>
      <div class="sk-btns sk-right"><button data-m="cancel">取消</button><button data-m="ok" class="sk-primary">导入</button></div>`);
    const wIn = el.querySelector('[data-v=w]');
    const upd = () => { el.querySelector('b[data-v=h]').textContent = fmt((Number(wIn.value) || w) * h / w); };
    wIn.addEventListener('input', upd);
    el.querySelector('[data-v=orig]').addEventListener('click', () => { wIn.value = fmt(w); upd(); });
    el.querySelector('[data-m=ok]').addEventListener('click', () => {
      const k = (Number(wIn.value) || w) / w;
      const mode = el.querySelector('[data-v=mode]').value;
      const center = el.querySelector('[data-v=center]').checked;
      const c = bb.center;
      const ox = center ? c.x - (x0 + w / 2) * k : 0;
      const oy = center ? c.y - (y0 + h / 2) * k : 0;
      const gid = newId();
      const made = paths.map((p) => this.addItem({ mode, group: paths.length > 1 ? gid : undefined,
        paths: [{ closed: p.closed, segs: p.segs.map((s) => [s[0] * k + ox, s[1] * k + oy, s[2] * k, s[3] * k, s[4] * k, s[5] * k]) }] }));
      close();
      this.setTool('select');
      this.sel = new Set(made);
      this.commit(`已导入 ${made.length} 个图形`);
    });
  }

  // 图片描摹：阈值 → 黑白预览 → 后端合并成多边形
  imageDialog(name, img) {
    const g = grayOf(img, 500);
    const auto = otsu(g.gray);
    const bb = this.boardBounds();
    const defW = Math.round(Math.min(bb.width, bb.height * g.w / g.h) * 0.6);
    const { el, close } = this.modal(`
      <h3>描摹图片 ${escAttr(name)}</h3>
      <div class="sk-trace">
        <canvas class="sk-trace-cv"></canvas>
        <div class="sk-trace-opts">
          <div class="sk-row"><label>阈值<input data-v="thr" type="range" min="1" max="254" value="${auto}"></label><b data-v="thrv">${auto}</b>
            <button data-v="auto">自动</button></div>
          <div class="sk-row"><label class="sk-check"><input data-v="inv" type="checkbox">反色（描浅色部分）</label></div>
          <div class="sk-row"><label>平滑<input data-v="smooth" type="range" min="0" max="4" step="0.25" value="1"></label></div>
          <div class="sk-row"><label>忽略小斑点<input data-v="minA" type="range" min="0" max="300" step="5" value="20"></label></div>
          <div class="sk-row"><label>宽度<input data-v="w" type="number" min="1" step="1" value="${defW}"> mm</label></div>
          <div class="sk-row"><label>加工方式<select data-v="mode">
            ${Object.entries(MODES).map(([k, m]) => `<option value="${k}" ${k === 'engrave' ? 'selected' : ''}>${m.name}</option>`).join('')}</select></label></div>
          <p class="sk-small">黑色部分会变成图形。线稿、剪影、图标效果最好；照片先调高对比度。</p>
        </div>
      </div>
      <div class="sk-btns sk-right"><button data-m="cancel">取消</button><button data-m="ok" class="sk-primary">描摹并导入</button></div>`);
    const cv = el.querySelector('.sk-trace-cv');
    const thr = el.querySelector('[data-v=thr]');
    const inv = el.querySelector('[data-v=inv]');
    let rects = [];
    const redraw = () => { el.querySelector('[data-v=thrv]').textContent = thr.value; rects = binarize(g, Number(thr.value), inv.checked, cv); };
    thr.addEventListener('input', redraw);
    inv.addEventListener('change', redraw);
    el.querySelector('[data-v=auto]').addEventListener('click', () => { thr.value = auto; redraw(); });
    redraw();
    el.querySelector('[data-m=ok]').addEventListener('click', async () => {
      const btn = el.querySelector('[data-m=ok]');
      btn.disabled = true;
      btn.textContent = '描摹中…';
      const wmm = Number(el.querySelector('[data-v=w]').value) || defW;
      const r = await this.api.trace_rects(rects, g.w, g.h, Number(el.querySelector('[data-v=smooth]').value),
        Number(el.querySelector('[data-v=minA]').value), wmm);
      btn.disabled = false;
      btn.textContent = '描摹并导入';
      if (r.error) { this.toast(r.error, 'error'); return; }
      if (!r.polys.length) { this.toast('没有描出图形：调一下阈值或反色', 'error'); return; }
      const c = bb.center;
      const paths = [];
      r.polys.forEach((p) => { paths.push(this.polyPath(p.outer, true)); p.holes.forEach((hh) => paths.push(this.polyPath(hh, true))); });
      paths.forEach((p) => p.segs.forEach((s) => { s[0] += c.x; s[1] += c.y; }));
      const it = this.addItem({ mode: el.querySelector('[data-v=mode]').value, paths });
      close();
      this.setTool('select');
      this.sel = new Set([it]);
      this.commit(`已描摹导入（${r.polys.length} 块，${fmt(r.size[0])} × ${fmt(r.size[1])} mm）`);
    });
  }

  // 删除完全重合的图形（起点不同、方向相反的也算重合）
  dedupeItems() {
    const keyOf = (it) => {
      const paths = this.serializeItem(it).paths.map((p) => {
        const pts = p.segs.map((sg) => sg.map((v) => Math.round(v * 50) / 50).join(','));
        if (!p.closed) { const f = pts.join(';'); const r = pts.slice().reverse().join(';'); return 'o' + (f < r ? f : r); }
        let best = null;
        [pts, pts.slice().reverse()].forEach((arr) => {
          for (let i = 0; i < arr.length; i++) {
            const k = arr.slice(i).concat(arr.slice(0, i)).join(';');
            if (best === null || k < best) best = k;
          }
        });
        return 'c' + best;
      }).sort();
      return it.data.mode + '|' + paths.join('|');
    };
    const seen = new Map();
    let n = 0;
    this.content.children.slice().forEach((it) => {
      if (!it.data || !it.data.mode) return;
      const k = keyOf(it);
      if (seen.has(k)) {
        if (it.data.role === 'outline') { seen.get(k).remove(); seen.set(k, it); } else it.remove();
        this.sel.delete(it);
        n++;
      } else seen.set(k, it);
    });
    if (!n) { this.toast('没有重复的图形', ''); return; }
    this.commit(`已删除 ${n} 个重复图形`);
  }

  // ================================================================ 圆角 / 倒角

  // 把一个尖角节点（两边都是直线）改成圆角或斜角；返回是否改了
  roundCorner(seg, r, chamfer) {
    const path = seg.path;
    if (!path) return false;
    const n = path.segments.length;
    const i = seg.index;
    if (!path.closed && (i === 0 || i === n - 1)) return false;
    const prev = path.segments[(i - 1 + n) % n];
    const next = path.segments[(i + 1) % n];
    if (!seg.handleIn.isZero() || !seg.handleOut.isZero() || !prev.handleOut.isZero() || !next.handleIn.isZero()) return false;
    const P = seg.point.clone();          // 注意：seg.point 是活引用，改了 seg.point 会跟着变
    const la = prev.point.getDistance(P);
    const lb = next.point.getDistance(P);
    if (la < 1e-6 || lb < 1e-6) return false;
    const u1 = prev.point.subtract(P).divide(la);
    const u2 = next.point.subtract(P).divide(lb);
    const theta = Math.acos(Math.max(-1, Math.min(1, u1.dot(u2))));
    if (theta > Math.PI * 179 / 180 || theta < 1e-3) return false;
    let d = chamfer ? r : r / Math.tan(theta / 2);
    d = Math.min(d, la * 0.49, lb * 0.49);
    const T1 = P.add(u1.multiply(d));
    const T2 = P.add(u2.multiply(d));
    seg.point = T1;
    if (chamfer) {
      path.insert(i + 1, new this.ps.Segment(T2));
    } else {
      const reff = d * Math.tan(theta / 2);
      const k = (4 / 3) * Math.tan((Math.PI - theta) / 4) * reff;
      seg.handleOut = P.subtract(T1).normalize(k);
      path.insert(i + 1, new this.ps.Segment(T2, P.subtract(T2).normalize(k), null));
    }
    return true;
  }

  cornerSel(chamfer) {
    const r = Number(this.opts.cornerR) || 0;
    if (r <= 0) { this.toast('半径要大于 0', 'error'); return; }
    let n = 0;
    if (this.tool === 'node' && this.activeSeg && this.activeSeg.path) {
      const it = this.topItem(this.activeSeg.path);
      if (it && it.data.text) this.convertText(it);
      if (this.roundCorner(this.activeSeg, r, chamfer)) n = 1;
      this.activeSeg = null;
    } else {
      if (!this.need(1, '先选中图形（或用节点工具点一个角）')) return;
      this.sel.forEach((it) => {
        let touched = false;
        this.itemPaths(it).forEach((p) => {
          p.segments.slice().forEach((sg) => { if (this.roundCorner(sg, r, chamfer)) { n++; touched = true; } });
        });
        if (touched && it.data.text) this.convertText(it);
      });
    }
    if (!n) { this.toast('没有可以处理的尖角（只处理两边都是直线的角）', 'error'); return; }
    this.commit(`已${chamfer ? '倒角' : '圆角'} ${n} 个角（${fmt(r)} mm）`);
  }

  // ================================================================ 数值栏

  updateNumeric() {
    const n = this.sel.size;
    this.$$('[data-align]').forEach((btn) => {
      const k = btn.dataset.align;
      btn.disabled = k === 'dh' || k === 'dv' ? n < 3 : n < 1;
    });
    const hint = this.$('.sk-align-hint');
    if (hint) {
      hint.textContent = n === 0 ? '按住 Shift 点选多个图形（或框选），再点对齐方式。'
        : n === 1 ? '只选了 1 个：会对齐到整块板。Shift 点选更多图形可以互相对齐。'
        : `已选 ${n} 个图形${this.opts.alignTo === 'key' && this.keyItem && this.sel.has(this.keyItem) ? '（关键对象有蓝色粗框）' : ''}。`;
    }
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
    if (k === 'alignTo') this.refresh();
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
    else if (t === 'joint' || t === 'mortise') {
      const o = this.opts;
      const th = this.part.thickness || 3;
      const depth = o.jointDepth || th;
      const editing = this.findEdit();
      const sizeRows = `
        <div class="sk-row"><label>齿的大小<select data-o="jointMode">
          <option value="count" ${o.jointMode !== 'width' ? 'selected' : ''}>按段数平均分</option>
          <option value="width" ${o.jointMode === 'width' ? 'selected' : ''}>按齿宽（mm）</option></select></label></div>` +
        (o.jointMode === 'width'
          ? `<div class="sk-row"><label>齿宽<input data-o="jointTab" type="number" min="0.5" step="0.5" value="${o.jointTab || 2 * th}"> mm</label>
               <label>间隔<input data-o="jointGap" type="number" min="0.5" step="0.5" value="${o.jointGap || o.jointTab || 2 * th}"> mm</label></div>
             <p class="sk-small">齿会排在边的中间，两头留出间隔；齿数由边长自动算出。</p>`
          : `<div class="sk-row"><label>段数<input data-o="jointCount" type="number" min="0" step="1" value="${o.jointCount}"></label>
               <span class="sk-small">0 = 自动；段数 5 = 2 个 A 齿</span></div>`);
      if (t === 'joint') {
        html = `<h4>${editing ? '修改卡榫' : '卡榫'}</h4>
          <div class="sk-row"><label>类型<select data-o="jointType">
            <option value="a" ${o.jointType === 'a' ? 'selected' : ''}>指接 A</option>
            <option value="b" ${o.jointType === 'b' ? 'selected' : ''}>指接 B（和 A 配对）</option>
            <option value="slot" ${o.jointType === 'slot' ? 'selected' : ''}>凹槽（凹进）</option></select></label></div>` + sizeRows + `
          <div class="sk-row"><label>齿深<input data-o="jointDepth" type="number" min="0.1" step="0.1" value="${depth}"> mm</label><span class="sk-small">通常 = 板厚 ${fmt(th)}</span></div>`;
      } else {
        html = `<h4>${editing ? '修改插槽' : '插槽（T 型连接）'}</h4>` + sizeRows + `
          <div class="sk-row"><label>孔宽<input data-o="jointDepth" type="number" min="0.1" step="0.1" value="${depth}"> mm</label>
            <label>间隙<input data-o="jointPlay" type="number" min="0" step="0.05" value="${o.jointPlay || 0}"> mm</label></div>
          <div class="sk-row"><label class="sk-check"><input data-o="mortiseVertical" type="checkbox" ${o.mortiseVertical ? 'checked' : ''}>竖向放置</label></div>`;
      }
      if (editing) {
        html += `<div class="sk-btns sk-editbar"><button data-je="apply" class="on">应用修改</button><button data-je="remove">${t === 'joint' ? '删除卡榫（恢复直边）' : '删除插槽'}</button><button data-je="cancel">取消</button></div>`;
      } else {
        html += t === 'joint'
          ? '<p class="sk-small">两块板相交的边：一块做「指接 A」，另一块做「指接 B」，齿的设置和边长一样就能咬合。<b>单击已有的卡榫可以修改。</b></p>'
          : '<p class="sk-small">另一块板的边做成「指接 A」，设置和长度一样就能插进这排孔。孔太紧时加一点间隙。<b>单击已有的插槽可以修改。</b></p>';
        html += this.peerHtml(t);
      }
    } else if (t === 'bridge') {
      html = `<h4>连接点（搭桥）</h4>
        <div class="sk-row"><label>宽度<input data-o="bridgeW" type="number" min="0.2" step="0.1" value="${this.opts.bridgeW}"> mm</label></div>
        <div class="sk-row"><label>每个图形<input data-o="bridgeN" type="number" min="1" step="1" value="${this.opts.bridgeN || 2}"> 个</label>
          <button data-bridge="auto">自动加</button><button data-bridge="clear">清除</button></div>
        <p class="sk-small">在切割线上单击加一个；点橙色标记删除。「自动加」作用于选中的图形（没选时作用于所有镂空）。切完用刀片划断连接点即可取下。</p>`;
    } else if (t === 'trim') html = '<h4>修剪</h4><p class="sk-small">鼠标移到线上会标红将被删掉的一段（到最近的交点为止），单击或拖过即删除。没有交点的整条路径会被整个删掉。</p>';
    box.innerHTML = html;
    box.classList.toggle('hidden', !html);
    box.querySelectorAll('[data-peer]').forEach((b) => b.addEventListener('click', () => this.pickPeer(Number(b.dataset.peer))));
    box.querySelectorAll('[data-bridge]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.bridge === 'auto') this.autoBridges();
      else {
        const targets = this.sel.size ? [...this.sel] : this.content.children;
        let n = 0;
        targets.forEach((it) => { if (it.data && it.data.bridges && it.data.bridges.length) { n += it.data.bridges.length; it.data.bridges = null; } });
        if (n) this.commit(`已清除 ${n} 个连接点`);
      }
    }));
    box.querySelectorAll('[data-je]').forEach((b) => b.addEventListener('click', () => {
      const a = b.dataset.je;
      if (a === 'cancel') { this.editJoint = null; this.renderToolOpts(); this.status(''); return; }
      this.applyEditJoint(a === 'remove');
    }));
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
        if (k === 'bridgeW') { this.drawMarks(); this.emitChange(); }
        if (['jointType', 'jointCount', 'jointMode', 'jointTab', 'jointGap'].includes(k)) {
          this.opts.jointPeer = null;
          if (k === 'jointTab' && !this.opts.jointGap) this.opts.jointGap = v;
          this.renderToolOpts();
        }
      };
      el.addEventListener('change', handler);
      if (el.tagName === 'INPUT' && el.type !== 'checkbox') el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') el.blur(); });
    });
  }

  // 其他板上已有的卡榫：点一下就设成配对的类型和段数
  peerHtml(tool) {
    const list = (this.peers || []).filter((p) => (tool === 'mortise' ? p.type === 'a' : ['a', 'b', 'slot', 'mortise'].includes(p.type)));
    if (!list.length) return '<p class="sk-small">其他板上还没有卡榫。先在一块板上做好，再回来这里配对。</p>';
    const cur = this.opts.jointPeer;
    const names = { a: '指接 A', b: '指接 B', slot: '凹槽', mortise: '插槽' };
    return '<h4 class="sk-sub-h">和其他板配对</h4><div class="sk-peers">' + list.map((p) => {
      const i = this.peers.indexOf(p);
      const on = cur && cur.id === p.id ? ' on' : '';
      const n = p.iv ? p.iv.length : Math.floor(p.k / 2);
      return `<button data-peer="${i}" class="sk-peer${on}" title="点一下套用它的齿的设置">${escAttr(p.part)} · ${names[p.type] || p.type} · ${fmt(p.L)} mm · ${n} 个 A 齿</button>`;
    }).join('') + '</div>';
  }

  pickPeer(i) {
    const p = (this.peers || [])[i];
    if (!p) return;
    this.opts.jointPeer = p;
    this.opts.jointMode = p.mode || 'count';
    this.opts.jointCount = p.count || (p.iv ? 2 * p.iv.length + 1 : p.k);
    this.opts.jointTab = p.tab || 0;
    this.opts.jointGap = p.gap || 0;
    if (p.depth) this.opts.jointDepth = p.depth;
    if (this.tool === 'joint') this.opts.jointType = p.type === 'a' ? 'b' : p.type === 'b' ? 'a' : p.type === 'slot' ? 'a' : 'a';
    this.renderToolOpts();
    this.status(this.tool === 'mortise' ? `单击板面放置 ${fmt(p.L)} mm 长的插槽` : `去点一条 ${fmt(p.L)} mm 长的直边`);
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
    else if (mod && k === 'g') { if (ev.shiftKey) this.ungroupSel(); else this.groupSel(); }
    else if (mod && k === 'i') this.startImport();
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
