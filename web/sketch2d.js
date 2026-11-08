// SeedLaser 二维草图编辑器（板件级），交互参考 LightBurn / LaserMaker。
// 依赖 paper.js（web/vendor/paper/paper-core.min.js，MIT，由 index.html 以普通脚本加载 → window.paper）。
//
// 坐标：「从外面看」的板面坐标，单位 mm，y 向上（视图矩阵做 y 翻转）。
// 数据：{ base, items: [{ id, mode: cut|engrave|score, role?, locked?, text?, paths: [{ closed, segs: [[x,y,inx,iny,outx,outy]] }] }] }
// 后端 sketch2d.py 读取同样的格式输出图纸、做 3D 碰撞检查。

const MODES = {
  cut: { name: '切割', color: '#111827', hint: '激光切穿' },
  engrave: { name: '雕刻', color: '#16a34a', hint: '填充雕刻（闭合图形）' },
  score: { name: '描线', color: '#dc2626', hint: '沿线浅刻' },
};
const OUTLINE_COLOR = '#1c2733';

// 右键圆形快捷菜单里「重复上一个」能重复的命令（act 名 → 显示名）
const RADIAL_REPEAT = {
  dup: '复制一份', delete: '删除', unite: '并集', subtract: '差集', intersect: '交集', mirCopyH: '左右镜像复制', mirCopyV: '上下镜像复制',
  flipH: '水平镜像', flipV: '垂直镜像', rotL: '左转 90°', rotR: '右转 90°', fillet: '圆角', chamfer: '倒角', group: '编组', paste: '粘贴', offset: '偏移',
};
// 右键圆形快捷菜单可以放的命令（用户在「自定义」里挑）。sel = 需要先选中图形
const RADIAL_CATALOG = [
  { g: '画图工具', items: [['t:select', '选择', '➤'], ['t:node', '节点', '◇'], ['t:line', '直线', '╱'], ['t:pen', '曲线', '✒'], ['t:rect', '矩形', '▭'],
    ['t:ellipse', '椭圆', '◯'], ['t:polygon', '多边形', '⬡'], ['t:text', '文字', 'T'], ['t:joint', '卡榫', '⊓'], ['t:mortise', '插槽', '▤'],
    ['t:bridge', '水口', '⫶'], ['t:trim', '修剪', '✂'], ['t:measure', '测量', '📏'], ['t:dim', '标注', '⟷']] },
  { g: '编辑', items: [['a:undo', '撤销', '↶'], ['a:redo', '重做', '↷'], ['a:copy', '复制', '⎘', 1], ['a:paste', '粘贴', '📋'], ['a:dup', '复制一份', '⧉', 1],
    ['a:delete', '删除', '🗑', 1], ['a:group', '编组', '▣', 1], ['a:ungroup', '取消编组', '▢', 1], ['a:breakApart', '拆分', '⋔', 1],
    ['a:lock', '锁定', '🔒', 1], ['a:hide', '隐藏', '🙈', 1], ['a:unlockAll', '全部解锁', '🔓'], ['a:showAll', '全部显示', '👁']] },
  { g: '形状运算', items: [['a:unite', '并集', '⬭', 1], ['a:subtract', '差集', '◐', 1], ['a:intersect', '交集', '◑', 1], ['a:exclude', '异或', '◒', 1], ['a:offset', '偏移', '⧈', 1]] },
  { g: '变换', items: [['x:rotate', '旋转…', '⟲', 1], ['a:rotL', '左转 90°', '↺', 1], ['a:rotR', '右转 90°', '↻', 1], ['a:flipH', '水平镜像', '⇆', 1], ['a:flipV', '垂直镜像', '⇅', 1],
    ['a:mirCopyH', '镜像复制', '⇋', 1], ['a:mirCopyV', '上下镜像复制', '⥮', 1], ['a:fillet', '圆角', '◜', 1], ['a:chamfer', '倒角', '◸', 1]] },
  { g: '面板 / 视图', items: [['p:align', '对齐', '⫴'], ['p:array', '阵列', '⁙'], ['p:transform', '变换面板', '⟲'], ['a:fit', '适合窗口', '⤢']] },
];
const RADIAL_DEF = {
  idle: ['t:line', 't:rect', 't:ellipse', 't:text', 't:joint', 'a:paste', 'a:unlockAll', 'a:fit'],
  sel: ['a:dup', 'a:subtract', 'a:unite', 'a:mirCopyH', 'x:rotate', 'a:lock', 'p:array', 'a:delete'],
};
const RADIAL_KEY = 'seedboxes.radialMenu';
const WOOD = '#ead3ac';
const SELECT = '#0ea5e9';
const ROTATE_CURSOR = `url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'><g fill='none' stroke-linecap='round' stroke-linejoin='round'><path d='M19 12a7 7 0 1 1-2.05-4.95' stroke='white' stroke-width='4.5'/><path d='M19 4v4h-4' stroke='white' stroke-width='4.5'/><path d='M19 12a7 7 0 1 1-2.05-4.95' stroke='%230ea5e9' stroke-width='2'/><path d='M19 4v4h-4' stroke='%230ea5e9' stroke-width='2'/></g></svg>") 12 12, alias`;   // 旋转手柄的光标（带白边的圆形箭头）
const SMART = '#16a34a';
const PX_PER_MM = 96 / 25.4;      // 缩放 100% = 1 mm 显示为 96 dpi 屏幕上的 1 mm
const MEASURE = '#f97316';        // 测量线（橙色）
const DIM_COLOR = '#7c3aed';      // 尺寸标注（紫色；默认不导出）          // 智能辅助线（对齐 / 贴边 / 相切）

const TOOLS = [
  { id: 'select', key: 'v', icon: '➤', name: '选择', tip: '点选 / 框选，拖动移动；拖控制点缩放、旋转（V）' },
  { id: 'node', key: 'a', icon: '◇', name: '节点', tip: '拖动节点和控制柄；双击线段加节点，双击节点切换尖角 / 平滑，Delete 删节点（A）' },
  { id: 'line', key: 'l', icon: '╱', name: '直线', tip: '逐点单击画折线；点起点闭合，右键 / 双击 / 回车结束，Shift 锁 45°（L）' },
  { id: 'pen', key: 'p', icon: '✒', name: '曲线', tip: '单击 = 尖角点，按住拖动 = 平滑曲线点；点起点闭合，右键 / 回车结束（P）' },
  { id: 'rect', key: 'r', icon: '▭', name: '矩形', tip: '拖动画矩形，Shift 正方形，Alt 从中心（R）' },
  { id: 'ellipse', key: 'e', icon: '◯', name: '椭圆', tip: '拖动画椭圆，Shift 正圆，Alt 从中心（E）' },
  { id: 'polygon', key: 'g', icon: '⬡', name: '多边形', tip: '从中心拖出多边形 / 星形，边数在右侧设置（G）' },
  { id: 'text', key: 't', icon: 'T', name: '文字', tip: '单击放置文字，右侧修改内容、字体、字号（T）' },
  { id: 'joint', key: 'j', icon: '⊓', name: '卡榫', tip: '单击板的一条直边，把它做成指接卡榫 / 凹槽（深度 = 板厚）（J）' },
  { id: 'mortise', key: 'k', icon: '▤', name: '插槽', tip: '在板面上开一排插槽孔，让另一块板的指接 A 边插进来（T 型连接）；拖出插槽中线，或先在右侧选配对边再单击（K）' },
  { id: 'bridge', key: 'b', icon: '⫶', name: '水口', tip: '在切割线上点一下加水口：留一小段不切，板件切完还连在材料上不会掉，取下时用刀片划断；再点一次删除（B）' },
  { id: 'trim', key: 'x', icon: '✂', name: '修剪', tip: '单击或拖过线段，删掉两个交点之间的那一段（X）' },
  { id: 'measure', key: 'm', icon: '📏', name: '测量', tip: '测量：点到点 / 点到线 / 线到线（间距、夹角）/ 圆（半径、圆心距），方式在右侧选（M）' },
  { id: 'make', icon: '✦', name: '造物', tip: '一键造物：直角盒子、圆角盒子、模数齿轮、徽章 / 印章，填几个尺寸点「生成」，得到的是普通板件，可以继续改' },
  { id: 'lib', icon: '▦', name: '图库', tip: '图库：螺丝孔、舵机 / 主控板安装孔、轴孔、装饰图形，点一下放到画板中央；选中图形可以存进「我的图库」' },
  { id: 'dim', key: 'd', icon: '⟷', name: '标注', tip: '尺寸标注：点一条直边，或点两个点，再移动鼠标点一下放置数字；数字跟着图形变。默认不导出（D）' },
  // 下面是「功能面板」：画布上照常可以选择 / 移动，右侧只显示对应的参数卡片
  { id: 'p-align', panel: 'align', sep: true, icon: '⫴', name: '对齐', tip: '对齐与分布：先选中图形（Shift 多选或框选），再点右侧的对齐方式' },
  { id: 'p-bool', panel: 'bool', icon: '◑', name: '运算', tip: '形状运算（并集 / 差集 / 交集 / 异或）和偏移：先选中图形' },
  { id: 'p-array', panel: 'array', icon: '⁙', name: '阵列', tip: '阵列（直线 / 环形 / 沿路径 / 矩形）：先选中一个图形，右侧设置后点「阵列」' },
  { id: 'p-transform', panel: 'transform', icon: '⟲', name: '变换', tip: '圆角 / 倒角、镜像、旋转 90°、闭合、拆分、编组、删除重复图形：先选中图形' },
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
// 菜单栏的其他图标（16×16 线框，和对齐图标同一风格）
const BAR_ICONS = {
  undo: '<path d="M5 3.5L2 6.5l3 3"/><path d="M2.5 6.5H10a3.5 3.5 0 0 1 0 7H7"/>',
  redo: '<path d="M11 3.5l3 3-3 3"/><path d="M13.5 6.5H6a3.5 3.5 0 0 0 0 7h3"/>',
  rotL: '<path d="M3.2 9.5A5 5 0 1 0 4.6 4.2"/><path d="M2.5 1.8v3.4h3.4"/>',
  rotR: '<path d="M12.8 9.5A5 5 0 1 1 11.4 4.2"/><path d="M13.5 1.8v3.4h-3.4"/>',
  flipH: '<path d="M8 1v14" stroke-dasharray="1.6 1.6"/><path d="M6 4.5L2 12h4z"/><path d="M10 4.5l4 7.5h-4z" fill="currentColor" fill-opacity=".25"/>',
  flipV: '<path d="M1 8h14" stroke-dasharray="1.6 1.6"/><path d="M4.5 6L12 2v4z"/><path d="M4.5 10l7.5 4v-4z" fill="currentColor" fill-opacity=".25"/>',
  angle: '<path d="M2 13.5h12"/><path d="M2 13.5L11.5 3"/><path d="M7.2 13.5a5.2 5.2 0 0 0-1.6-3.8"/>',
  fit: '<path d="M2 5.5V2h3.5M10.5 2H14v3.5M14 10.5V14h-3.5M5.5 14H2v-3.5"/><rect x="5" y="5" width="6" height="6" rx="1"/>',
  file: '<path d="M4 1.5h5.5L12.5 4.5v10H4z"/><path d="M9.5 1.5v3h3"/><path d="M6 8.5h4.5M6 11h4.5"/>',
};
const barIcon = (k) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${BAR_ICONS[k]}</svg>`;
// 对象原点（参考点）：9 个位置，t / m / b = 屏幕上的上 / 中 / 下，l / c / r = 左 / 中 / 右
const REF_KEYS = ['tl', 'tc', 'tr', 'ml', 'mc', 'mr', 'bl', 'bc', 'br'];
const REF_NAMES = { tl: '左上角', tc: '上边中点', tr: '右上角', ml: '左边中点', mc: '中心', mr: '右边中点', bl: '左下角', bc: '下边中点', br: '右下角' };
const refIcon = (k, size = 18) => {
  const i = REF_KEYS.indexOf(k); const cx = 2.5 + (i % 3) * 5.5; const cy = 2.5 + Math.floor(i / 3) * 5.5;
  return `<svg viewBox="0 0 16 16" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.1">` +
    '<rect x="2.5" y="2.5" width="11" height="11" rx="0.5"/><path d="M8 2.5v11M2.5 8h11" stroke-opacity=".45"/>' +
    `<circle cx="${cx}" cy="${cy}" r="2.1" fill="#1f6feb" stroke="#fff" stroke-width="0.9"/></svg>`;
};
const alignIcon = (k) => `<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.3">${ALIGN_ICONS[k]}</svg>`;

import { parseDXF, loadImage, grayOf, otsu, binarize, readFile } from './sketch-import.js';

let uid = 0;
const newId = () => 's' + Date.now().toString(36) + (uid++).toString(36);
const r3 = (v) => Math.round(v * 1000) / 1000;
const fmt = (v) => (Math.round(v * 100) / 100).toString();

// 卡榫测试样校准出的插槽间隙（workshop.js 的测试样对话框写入）
function savedJointPlay() {
  try { const v = Number(localStorage.getItem('seedboxes.jointPlay')); return Number.isFinite(v) ? v : 0; } catch (e) { return 0; }
}

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
                  jointCount: 0, jointType: 'a', jointDepth: 0, jointMode: 'count', jointTab: 0, jointGap: 0, jointPlay: savedJointPlay() };
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
        <div class="sk-proj">
          <span class="sk-proj-ico">${barIcon('file')}</span>
          <div class="sk-title"><b class="sk-name">—</b><span class="sk-file" title="点一下输入项目名称，回车就保存"></span></div>
          <span class="sk-savestate" title="● = 有改动还没保存（⌘S 保存）"></span>
        </div>
        <button class="sk-menubtn sk-filebtn" data-filemenu title="新建、打开、保存、另存为、导入、导出">文件 ▾</button>
        <button class="sk-menubtn" data-menu="edit" title="复制、粘贴、删除、全选、编组……">编辑 ▾</button>
        <div class="sk-group">
          <button class="sk-ico" data-act="undo" title="撤销（⌘Z）">${barIcon('undo')}</button>
          <button class="sk-ico" data-act="redo" title="重做（⇧⌘Z）">${barIcon('redo')}</button>
        </div>
        <div class="sk-group" title="视图">
          <button class="sk-ico" data-act="fit" title="适合窗口：显示整块材料（F）">${barIcon('fit')}</button>
          <button class="sk-ico" data-zoom="out" title="缩小（滚轮也可以缩放）">−</button>
          <input class="sk-zoom" value="100%" title="缩放比例：点一下输入数字，回车生效（100% ≈ 屏幕上的实际大小）" spellcheck="false">
          <button class="sk-ico" data-zoom="in" title="放大">+</button>
        </div>
        <div class="sk-group" title="吸附">
          <span class="sk-glabel">吸附</span>
          <select data-opt="snap" title="网格吸附步长"><option value="0">网格 关</option><option value="0.5">网格 0.5</option>
            <option value="1" selected>网格 1 mm</option><option value="5">网格 5 mm</option></select>
          <label class="sk-toggle" title="吸附端点、中点、交点、圆心，以及绿色对齐辅助线"><input type="checkbox" data-opt="snapPoints" checked><span>端点</span></label>
        </div>
        <span class="sk-spacer"></span>
        <button class="sk-menubtn" data-menu="help" title="快捷键、新手引导">? 帮助 ▾</button>
        <button class="sk-lock" data-act="lockOutline" title="锁定后外轮廓（卡榫边）不会被误选、误改">🔒 外轮廓已锁定</button>
        <button data-act="reset" title="丢弃这块板的所有修改，恢复生成器画出的原样">恢复原板</button>
        <button class="sk-back" data-act="close">完成 ✓</button>
      </div>
      <div class="sk-numeric">
        <span class="sk-ctx-idle">
          <span class="sk-ctx-data"></span>
          <span class="sk-num-hint">选中图形后，这里显示位置和尺寸</span>
        </span>
        <span class="sk-ctx-sel hidden">
          <b class="sk-ctx-count"></b>
          <i class="sk-sep sk-num-sep"></i>
          <button class="sk-refbtn" data-refbtn title="对象原点：X / Y 用图形的哪个点；改宽高、输入角度时这个点不动"></button>
          <label class="sk-refx">X<input data-num="x" type="number" step="0.1"></label>
          <label class="sk-refy">Y<input data-num="y" type="number" step="0.1"></label>
          <label title="宽（回车生效）">宽<input data-num="w" type="number" step="0.1" min="0.1"></label>
          <button class="sk-ratio on" data-act="ratio" title="锁定宽高比">🔗</button>
          <label title="高（回车生效）">高<input data-num="h" type="number" step="0.1" min="0.1"></label>
          <label title="旋转角度，正数 = 逆时针（回车生效）">旋转<input data-num="rot" type="number" step="1" value="0"></label><span class="sk-unit">°</span>
          <label class="sk-num-sm" title="按倍率缩放：200 = 放大一倍，50 = 缩小一半（对象原点不动，回车生效）">缩放<input data-num="pct" type="number" step="10" min="1" value="100"></label><span class="sk-unit">%</span>
          <label class="sk-num-sm" title="向右移动多少 mm（负数向左，回车生效）">ΔX<input data-num="dx" type="number" step="1" value="0"></label>
          <label class="sk-num-sm" title="向下移动多少 mm（负数向上，和标尺方向一样，回车生效）">ΔY<input data-num="dy" type="number" step="1" value="0"></label>
          <span class="sk-seg2 sk-ctx-ico"><button class="sk-ico" data-act="rotL" title="左转 90°（逆时针）">${barIcon('rotL')}</button><button class="sk-ico" data-act="rotR" title="右转 90°（顺时针）">${barIcon('rotR')}</button></span>
          <i class="sk-sep sk-num-sep"></i>
          <span class="sk-glabel">镜像</span>
          <span class="sk-seg2 sk-ctx-ico"><button class="sk-ico" data-act="flipH" title="水平镜像（左右翻转）">${barIcon('flipH')}</button><button class="sk-ico" data-act="flipV" title="垂直镜像（上下翻转）">${barIcon('flipV')}</button></span>
          <i class="sk-sep sk-num-sep"></i>
          <span class="sk-glabel">对齐</span>
          <span class="sk-aligns" title="对齐：只选 1 个时对齐到整块材料；选多个时互相对齐">${['l', 'hc', 'r', 't', 'vc', 'b'].map((k) => `<button data-align="${k}" title="${ALIGN_NAMES[k]}">${alignIcon(k)}</button>`).join('')}
            <i class="sk-sep"></i>${['dh', 'dv'].map((k) => `<button data-align="${k}" title="${ALIGN_NAMES[k]}（选 3 个以上）">${alignIcon(k)}</button>`).join('')}</span>
          <i class="sk-sep sk-num-sep"></i>
          <button class="sk-ico" data-act="dup" title="复制一份（⌘D）">⧉</button>
          <button class="sk-ico sk-danger" data-act="delete" title="删除（Delete）">🗑</button>
        </span>
      </div>
      <div class="sk-main">
        <div class="sk-tools">${TOOLS.map((t) => `${t.sep ? '<i class="sk-tools-sep"></i>' : ''}<button data-tool="${t.id}" title="${t.tip}"><span class="i">${t.icon}</span>${t.name}</button>`).join('')}</div>
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
          <section class="sk-card sk-layers-card hidden">
            <h4>图层（加工方式）<button class="sk-card-x" data-act="hideLayers" title="收起（点左下角的颜色块可再打开）">✕</button></h4>
            <div class="sk-layers">${Object.entries(MODES).map(([k, m]) => `
              <span class="sk-layer-row"><button class="sk-layer" data-mode="${k}"><i style="background:${m.color}"></i><b>${m.name}</b><em>${m.hint}</em><span class="sk-count" data-count="${k}">0</span></button><button class="sk-eye" data-eye="${k}" title="显示 / 隐藏这个图层（只是不显示，仍会导出）">👁</button></span>`).join('')}
            </div>
            <p class="sk-small">选中图形后点图层（或下方色块）即可改加工方式；新画的图形使用当前图层。</p>
            <div class="sk-lockinfo hidden"><span class="sk-lockinfo-t"></span><button data-act="unlockAll">全部解锁</button><button data-act="showAll">全部显示</button></div>
          </section>
          <section class="sk-card sk-toolopts"></section>
          <section class="sk-card" data-panel="info" data-key="info">
            <h4>图形信息</h4>
            <div class="sk-info"></div>
          </section>
          <section class="sk-card" data-panel="align" data-key="align">
            <h4>对齐与分布</h4>
            <div class="sk-row"><label>对齐到<select data-opt="alignTo">
              <option value="sel">选区（所有选中图形的外框）</option>
              <option value="key">关键对象（最后点选的那个）</option>
              <option value="board">整块板</option></select></label></div>
            <div class="sk-align-grid">${['l', 'hc', 'r', 't', 'vc', 'b'].map((k) => `<button data-align="${k}">${alignIcon(k)}<span>${ALIGN_NAMES[k]}</span></button>`).join('')}</div>
            <div class="sk-align-grid two">${['dh', 'dv'].map((k) => `<button data-align="${k}">${alignIcon(k)}<span>${ALIGN_NAMES[k]}</span></button>`).join('')}</div>
            <p class="sk-small sk-align-hint">按住 Shift 点选多个图形（或框选），再点对齐方式。只选一个时对齐到整块板。</p>
          </section>
          <section class="sk-card" data-panel="bool" data-key="bool">
            <h4>形状运算</h4>
            <div class="sk-btns">
              <button data-act="unite" data-bh="unite">并集</button>
              <button data-act="subtract" data-bh="subtract">差集</button>
              <button data-act="intersect" data-bh="intersect">交集</button>
              <button data-act="exclude" data-bh="exclude">异或</button>
            </div>
            <div class="sk-boolhint"></div>
            <div class="sk-row"><label>偏移<input data-opt="offset" type="number" step="0.5" value="2"> mm</label>
              <select data-opt="offsetJoin"><option value="round">圆角</option><option value="miter">尖角</option></select>
              <button data-act="offset" title="生成外扩（正数）/ 内缩（负数）的新轮廓">偏移</button></div>
          </section>
          <section class="sk-card" data-panel="transform" data-key="t-corner">
            <h4>圆角 / 倒角</h4>
            <div class="sk-row"><label>半径<input data-opt="cornerR" type="number" step="0.5" value="3" title="负数 = 以角点为圆心挖一个圆弧缺口"> mm</label>
              <button data-act="fillet" title="把选中图形的尖角变圆（节点工具下只改当前节点）">圆角</button>
              <button data-act="chamfer" title="把尖角切成斜角">倒角</button></div>
            <p class="sk-small">作用于选中图形的所有尖角；用「节点」工具选中一个节点时只改这一个角。半径填负数 = 在角上挖圆弧缺口。</p>
          </section>
          <section class="sk-card" data-panel="transform" data-key="t-mirror">
            <h4>镜像</h4>
            <div class="sk-btns">
              <button data-act="flipH" title="左右翻过来">水平镜像</button><button data-act="flipV" title="上下翻过来">垂直镜像</button>
              <button data-act="mirCopyH" title="复制出左右对称的另一半：板上的孔 / 文字以这块板的中线对称；其他图形紧贴在右边">左右镜像复制</button>
              <button data-act="mirCopyV" title="复制出上下对称的另一半：板上的孔 / 文字以这块板的中线对称；其他图形紧贴在下边">上下镜像复制</button>
            </div>
            <p class="sk-small">「镜像」翻转选中的图形本身；「镜像复制」保留原图，再复制出对称的一份：板上的孔、文字按这块板的中线对称；独立的图形紧贴在右边（上下镜像紧贴在下边），画一半镜像一下就是完整的对称形状。</p>
          </section>
          <section class="sk-card" data-panel="transform" data-key="t-rotate">
            <h4>旋转</h4>
            <div class="sk-btns"><button data-act="rotL">左转 90°</button><button data-act="rotR">右转 90°</button></div>
            <p class="sk-small">任意角度：单击图形上方的蓝点输入角度，或按住蓝点左右拖动微调；也可以在上方「旋转」框输入。</p>
          </section>
          <section class="sk-card" data-panel="transform" data-key="t-path">
            <h4>路径</h4>
            <div class="sk-btns">
              <button data-act="close" data-close="path" title="把开放路径首尾相连">闭合路径</button>
              <button data-act="breakApart" title="把组合路径拆成独立图形">拆分</button>
              <button data-act="joinPaths" title="把首尾相接的几条开放线接成一条（首尾接上时自动闭合）">连接线段</button>
              <button data-act="dedupe" title="删除完全重合的重复图形（重复的线会被激光切两遍，边缘容易烧焦）">删除重复图形</button>
            </div>
            <p class="sk-small">只有闭合的切割路径才会切出一块板；重复的线会被切两遍。</p>
          </section>
          <section class="sk-card" data-panel="transform" data-key="t-slot">
            <h4>改槽宽</h4>
            <div class="sk-row"><label>原宽<input data-opt="slotFrom" type="number" min="0.5" step="0.1" placeholder="板厚"> mm</label>
              <label>改成<input data-opt="slotTo" type="number" min="0.5" step="0.1" placeholder="板厚"> mm</label></div>
            <div class="sk-btns"><button data-act="slotFind" title="在选中的图形里找出这个宽度的槽，标成橙色">查找</button>
              <button data-act="slotApply" title="把找到的槽改成新宽度（两侧各移一半，槽中线不动）">改槽宽</button></div>
            <div class="sk-slot-info sk-small"></div>
            <p class="sk-small">导入的图纸是按别的板厚画的：找出宽度 ≈ 原宽的缺口和长方形孔，改成新宽度，别的边不动。不填 = 当前板厚。</p>
          </section>
          <section class="sk-card" data-panel="transform" data-key="t-group">
            <h4>编组</h4>
            <div class="sk-btns">
              <button data-act="group" title="选中的图形编成一组，一起选中、移动（Ctrl+G）">编组</button>
              <button data-act="ungroup" title="取消编组（Ctrl+Shift+G）">取消编组</button>
              <button data-act="lock" title="锁定：不能选中、移动、删除（防止误碰）。解锁：右键空白处「全部解锁」">🔒 锁定</button>
              <button data-act="hide" title="隐藏：画板上不显示、不能选中，但仍会导出。显示：右侧「图层」卡片「全部显示」">🙈 隐藏</button>
            </div>
            <p class="sk-small">编成一组后点任意一个就整组选中、一起移动（Ctrl/⌘+G，取消 Ctrl/⌘+Shift+G）。</p>
          </section>
          <section class="sk-card" data-panel="array" data-key="array">
            <h4>阵列</h4>
            <div class="sk-array"></div>
          </section>
          <section class="sk-card sk-emptyhint">
            <h4>选中图形后</h4>
            <p class="sk-small">在画布上点选图形（Shift 多选，或拖框框选），这里会出现能对它做的操作：<b>运算</b>、<b>变换</b>（圆角、镜像、旋转…）、<b>阵列</b>；选中 2 个以上还有<b>对齐</b>。</p>
            <p class="sk-small">画图时这里显示当前工具的设置。右键画布有常用命令的快捷菜单。</p>
          </section>
          <section class="sk-card sk-boardinfo"></section>
          <section class="sk-card sk-conns hidden" data-key="conns">
            <h4>连接 <span class="sk-conn-n"></span></h4>
            <div class="sk-conn-list"></div>
          </section>
        </aside>
      </div>
      <div class="sk-bottom">
        <div class="sk-palette">${Object.entries(MODES).map(([k, m]) => `<button data-mode="${k}" title="${m.name}：${m.hint}" style="background:${m.color}">${m.name}</button>`).join('')}</div>
        <div class="sk-status"></div>
        <span class="sk-sub hidden"></span>
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
    // 图层卡片默认收起：点左下角的加工方式色块时展开（再点同一个已选中的色块收起）
    h.querySelectorAll('.sk-palette [data-mode]').forEach((b) => b.addEventListener('click', () => {
      const card = this.$('.sk-layers-card');
      const same = this.lastPalette === b.dataset.mode && !card.classList.contains('hidden');
      card.classList.toggle('hidden', same);
      this.lastPalette = same ? null : b.dataset.mode;
    }));
    h.querySelector('[data-act=hideLayers]').addEventListener('click', (ev) => {
      ev.stopPropagation();
      this.$('.sk-layers-card').classList.add('hidden');
      this.lastPalette = null;
    });
    h.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => this.act(b.dataset.act, b)));
    h.querySelectorAll('[data-eye]').forEach((b) => b.addEventListener('click', () => this.toggleLayer(b.dataset.eye)));
    h.querySelector('[data-filemenu]').addEventListener('click', (ev) => { ev.stopPropagation(); this.toggleFileMenu(); });
    h.querySelector('.sk-file').addEventListener('click', () => this.startRename());
    h.querySelector('[data-refbtn]').addEventListener('click', (ev) => { ev.stopPropagation(); this.toggleRefMenu(); });
    h.querySelectorAll('[data-menu]').forEach((b) => b.addEventListener('click', (ev) => { ev.stopPropagation(); this.toggleMenu(b.dataset.menu); }));
    h.querySelectorAll('[data-zoom]').forEach((b) => b.addEventListener('click', () => {
      const v = this.ps.view;
      this.zoomAt(new this.ps.Point(v.viewSize.width / 2, v.viewSize.height / 2), b.dataset.zoom === 'in' ? 1.25 : 0.8);
    }));
    // 缩放比例：直接输入（比如 150 或 150%），回车 / 点别处生效，Esc 取消；以画面中心为准
    const zi = h.querySelector('.sk-zoom');
    const zShow = () => { zi.value = `${Math.round(this.zoom / PX_PER_MM * 100)}%`; };
    zi.addEventListener('focus', () => { zi.value = String(Math.round(this.zoom / PX_PER_MM * 100)); zi.select(); zi._fresh = true; });
    zi.addEventListener('mouseup', (ev) => { if (zi._fresh) { ev.preventDefault(); zi._fresh = false; } });   // 点进来时保持全选，直接输入就替换
    zi.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') zi.blur();
      else if (ev.key === 'Escape') { zi.dataset.cancel = '1'; zi.blur(); }
    });
    zi.addEventListener('blur', () => {
      const v = parseFloat(String(zi.value).replace('%', ''));
      if (!zi.dataset.cancel && isFinite(v) && v > 0) {
        const c = this.center();
        this.setView(v / 100 * PX_PER_MM, c.x, c.y);
        const real = Math.round(this.zoom / PX_PER_MM * 100);
        if (real !== Math.round(v)) this.status(`缩放范围是 ${Math.round(0.2 / PX_PER_MM * 100)}% ~ ${Math.round(200 / PX_PER_MM * 100)}%，已设为 ${real}%`);
      }
      delete zi.dataset.cancel;
      zShow();
    });
    h.querySelectorAll('[data-opt]').forEach((el) => el.addEventListener('change', () => this.optChanged(el)));
    h.querySelectorAll('[data-num]').forEach((el) => {
      // 回车 = 失焦，由 change 统一应用一次（原来回车和 change 各应用一次，旋转会转两倍）
      el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') el.blur(); });
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
    this.measureLayer = L('measure');      // 测量结果：留到下一次测量 / 换工具 / Esc
    this.overlay = L('overlay');
    this.hlLayer = L('connhl');            // 连接清单点中的边（选择框重画时不清掉）
    this.dimLayer = L('dims');             // 尺寸标注的数字
    this.content.activate();
    this.zoom = 4;

    this.initBoolHints();
    this.initCollapsible();
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
    this.sheetMode = !!part.sheet;
    this.host.classList.toggle('sheet', this.sheetMode);   // 设计画板：项目名称在顶部标签上改，这里不再显示名称块
    const oldLabels = this.$('.sk-plabels');
    if (oldLabels) oldLabels.innerHTML = '';
    this.$('[data-act=reset]').classList.toggle('hidden', this.sheetMode);
    this.$('.sk-back').textContent = this.sheetMode ? '3D 装配 →' : '完成 ✓';
    this.$('.sk-back').title = this.sheetMode ? '进入 3D 装配：按画好的板件拼装和检查' : '保存修改，回到 3D';
    this.$('.sk-name').classList.toggle('hidden', this.sheetMode);   // 设计画板：标题位置只显示文件名
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
    } else if (!this.sheetMode) {
      this.seedFromPart(legacy);
    }
    this.current = JSON.stringify(this.serialize().items);
    this.drawReference();
    this.fit(true);
    this.setTool('select');
    this.refresh();
    this.renderBoardInfo();
    let seen = false;
    try { seen = localStorage.getItem('seedboxes.skTour') === '1'; } catch (e) { seen = true; }
    if (!seen) setTimeout(() => { if (this.opened) this.startTour(); }, 400);
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
    this.clearConnHighlight();
    this.content.removeChildren();
    sketch.items.forEach((it) => this.addItem(it));
  }

  addItem(it) {
    const ps = this.ps;
    const mk = (p0) => {
      const p = closeNearlyClosed(p0);            // 差一点闭合（导入文件常见）→ 闭合
      const path = new ps.Path({ insert: false });
      path.segments = p.segs.map((s) => new ps.Segment(new ps.Point(s[0], s[1]), new ps.Point(s[2], s[3]), new ps.Point(s[4], s[5])));
      path.closed = !!p.closed;
      return path;
    };
    let item;
    if (it.paths.length === 1) item = mk(it.paths[0]);
    else { item = new ps.CompoundPath({ insert: false }); item.addChildren(it.paths.map(mk)); }
    item.data = { id: it.id || newId(), mode: it.mode || 'cut', role: it.role || null, locked: !!it.locked, lock: !!it.lock, hidden: !!it.hidden, dim: it.dim ? JSON.parse(JSON.stringify(it.dim)) : null,
                  text: it.text ? { ...it.text } : null, code: it.code ? { ...it.code } : null, joints: it.joints ? it.joints.map((j) => ({ ...j })) : null,
                  group: it.group || null, pid: it.pid || null, origin: it.origin ? [...it.origin] : null, bridges: it.bridges ? it.bridges.map((b) => [...b]) : null };
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
    if (item.data.lock) out.lock = true;              // 用户锁定（不能选 / 动 / 删）
    if (item.data.hidden) out.hidden = true;          // 用户隐藏（不显示、不选，仍导出）
    if (item.data.dim) out.dim = JSON.parse(JSON.stringify(item.data.dim));   // 尺寸标注：引用的图形 / 节点 + 引出距离
    if (item.data.text) out.text = { ...item.data.text };
    if (item.data.code) out.code = { ...item.data.code };            // 二维码 / 条形码：内容和尺寸（可重新生成）
    if (item.data.group) out.group = item.data.group;
    if (item.data.pid) out.pid = item.data.pid;
    if (item.data.origin) out.origin = item.data.origin.map(r3);
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
    if (this.sheetMode) return this.serializeSheet();
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
    item.strokeWidth = outline ? 1.6 : d.mode === 'dim' ? 1 : 1.4;
    item.strokeColor = outline ? OUTLINE_COLOR : d.mode === 'dim' ? DIM_COLOR : m.color;
    item.fillColor = d.mode === 'engrave' ? new this.ps.Color(0.09, 0.64, 0.29, 0.28) : null;
    item.fillRule = 'evenodd';
    item.dashArray = null;                     // 描线也用实线（用户要求），只靠红色区分
    item.opacity = d.locked && this.outlineLocked !== false && outline ? 0.85 : 1;
    if (d.lock) item.opacity = 0.45;                                   // 锁定：变淡
    item.visible = !d.hidden && !this.layerHidden(d.mode);             // 隐藏：不画（仍导出）
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
      // 画板模式：板件的「原点」跟着整块板平移 / 旋转（排版用），缩放 / 镜像算改形状，原点不动
      if (m && this.data && this.data.origin) {
        const det = m.a * m.d - m.b * m.c;
        if (Math.abs(det - 1) < 1e-6 && Math.abs(m.a * m.a + m.b * m.b - 1) < 1e-6) {
          const o = this.data.origin;
          const p = tp(o);
          this.data.origin = [p[0], p[1], ((o[2] || 0) + Math.atan2(m.b, m.a) * 180 / Math.PI + 360) % 360];
        }
      }
      if (m && this.data && this.data.text) {
        // 只平移时保留可编辑的文字；旋转 / 缩放 / 镜像后转成路径
        const pure = Math.abs(m.a - 1) < 1e-9 && Math.abs(m.d - 1) < 1e-9 && Math.abs(m.b) < 1e-9 && Math.abs(m.c) < 1e-9;
        if (pure) {
          const t = this.data.text;
          this.data.text = { ...t, x: t.x + m.tx, y: t.y + m.ty, path: t.path ? t.path.map(tp) : t.path };
        } else this.data.text = null;
      }
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
    this.syncDims();
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
    this._emitT = setTimeout(() => { this._emitT = null; if (this.onChange) this.onChange(this.serializeForSave()); if (window.SeedApp && window.SeedApp.changed) window.SeedApp.changed(); }, 250);
  }

  // 保存 / 导出前：把还在等待（防抖）的改动立刻交出去
  flushChange() {
    if (!this._emitT) return;
    clearTimeout(this._emitT);
    this._emitT = null;
    if (this.onChange) this.onChange(this.serializeForSave());
  }

  // ---------------------------------------------------------------- 文件菜单（命令交给主程序 SeedApp.file 处理）
  fileCmd(cmd, arg) {
    this.closeFileMenu();
    if (cmd === 'import') { this.startImport(); return; }
    this.flushChange();
    if (window.SeedApp && window.SeedApp.file) window.SeedApp.file(cmd, arg);
  }

  async toggleFileMenu() {
    if (this.fileMenu) { const was = this.openMenuId; this.closeFileMenu(); if (was === 'file') return; }
    const app = window.SeedApp || {};
    const mac = /Mac/i.test(navigator.platform || navigator.userAgent);
    const K = (k, shift) => (mac ? `${shift ? '⇧' : ''}⌘${k}` : `Ctrl+${shift ? 'Shift+' : ''}${k}`);
    const fmts = (app.formats ? app.formats() : []).filter((f) => ['svg', 'dxf', 'pdf', 'lbrn2'].includes(f.value));
    const box = document.createElement('div');
    box.className = 'sk-filemenu';
    box.innerHTML = `
      <button data-fc="new"><span>新建设计</span><kbd>${K('N')}</kbd></button>
      <button data-fc="open"><span>打开…</span><kbd>${K('O')}</kbd></button>
      <div class="sk-fm-h">最近打开</div><div class="sk-fm-recent"><em>加载中…</em></div>
      <hr>
      <button data-fc="save"><span>保存</span><kbd>${K('S')}</kbd></button>
      <button data-fc="saveas"><span>另存为…</span><kbd>${K('S', true)}</kbd></button>
      <hr>
      <button data-fc="import"><span>导入 SVG / DXF / 图片…</span><kbd>${K('I')}</kbd></button>
      <div class="sk-fm-h">导出图纸（给激光机）</div>
      ${(fmts.length ? fmts : [{ value: 'svg', label: 'SVG' }]).map((f) => `<button data-fc="export" data-fa="${f.value}" class="sub"><span>${escAttr(f.label)}</span></button>`).join('')}
      <hr>
      <button data-fc="close"><span>关闭这个项目</span></button>
      <button data-fc="home"><span>回到主页</span></button>`;
    box.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-fc]');
      if (b) this.fileCmd(b.dataset.fc, b.dataset.fa);
    });
    const btn = this.$('[data-filemenu]');
    const r = btn.getBoundingClientRect(); const hr = this.host.getBoundingClientRect();
    box.style.left = `${r.left - hr.left}px`;
    box.style.top = `${r.bottom - hr.top + 4}px`;
    this.host.appendChild(box);
    this.fileMenu = box;
    this.openMenuId = 'file';
    btn.classList.add('on');
    this._fmClose = (ev) => { if (!box.contains(ev.target) && ev.target !== btn) this.closeFileMenu(); };
    setTimeout(() => document.addEventListener('pointerdown', this._fmClose), 0);
    let list = [];
    try { list = app.recent ? await app.recent() : []; } catch (e) { list = []; }
    const rec = box.querySelector('.sk-fm-recent');
    if (!rec) return;
    list = (Array.isArray(list) ? list : []).filter((q) => q.exists).slice(0, 6);
    rec.innerHTML = list.length ? list.map((q) => `<button data-fc="openPath" data-fa="${escAttr(q.path)}" class="sub" title="${escAttr(q.path)}"><span>${escAttr(q.name)}</span></button>`).join('') : '<em>还没有</em>';
  }

  closeFileMenu() {
    if (this.fileMenu) { this.fileMenu.remove(); this.fileMenu = null; }
    if (this._fmClose) { document.removeEventListener('pointerdown', this._fmClose); this._fmClose = null; }
    if (this.$) this.$$('.sk-menubtn.on').forEach((b) => b.classList.remove('on'));
    this.openMenuId = null;
  }

  // 「编辑 ▾」「? 帮助 ▾」下拉菜单（样式和文件菜单一样）
  toggleMenu(id) {
    const was = this.openMenuId;
    this.closeFileMenu();
    if (was === id) return;
    const mac = /Mac/i.test(navigator.platform || navigator.userAgent);
    const K = (k, shift) => (mac ? `${shift ? '⇧' : ''}⌘${k}` : `Ctrl+${shift ? 'Shift+' : ''}${k}`);
    const it = (act, label, key, dis) => `<button data-mact="${act}" ${dis ? 'disabled' : ''}><span>${label}</span><kbd>${key || ''}</kbd></button>`;
    const n = this.sel.size;
    const ai = (k) => `<button data-mact="al:${k}" ${(k === 'dh' || k === 'dv' ? n < 3 : n < 1) ? 'disabled' : ''}><span class="sk-mi">${alignIcon(k)}${ALIGN_NAMES[k]}</span><kbd></kbd></button>`;
    const html = id === 'align'
      ? ['l', 'hc', 'r'].map(ai).join('') + '<hr>' + ['t', 'vc', 'b'].map(ai).join('') + '<hr>' + ['dh', 'dv'].map(ai).join('') +
        `<div class="sk-fm-h">${n === 1 ? '只选了 1 个：对齐到整块材料' : n ? `已选 ${n} 个：互相对齐` : '先选中图形'}；分布要选 3 个以上</div>`
      : id === 'rotate'
      ? it('rotL', '↺ 左转 90°（逆时针）', '', !n) + it('rotR', '↻ 右转 90°（顺时针）', '', !n) + it('rot180', '⟲ 旋转 180°', '', !n) +
        it('askRot', '∠ 输入角度…', '', !n) + '<hr>' + it('flipH', '⇆ 水平镜像', '', !n) + it('flipV', '⇅ 垂直镜像', '', !n) +
        '<div class="sk-fm-h">也可以拖动图形上方的蓝点旋转</div>'
      : id === 'edit'
      ? it('undo', '撤销', K('Z')) + it('redo', '重做', K('Z', true)) + '<hr>' +
        it('copy', '复制', K('C'), !n) + it('paste', '粘贴', K('V')) + it('dup', '复制一份', K('D'), !n) + it('delete', '删除', 'Delete', !n) + '<hr>' +
        it('selectAll', '全选', K('A')) + it('group', '编组', K('G'), n < 2) + it('ungroup', '取消编组', K('G', true), !n) +
        (this.sheetMode ? '<hr>' + it('autoLayout', '自动排版（把板件排进材料）', '') : '')
      : it('keys', '快捷键一览', '?') + it('tour', '新手引导');
    const box = document.createElement('div');
    box.className = 'sk-filemenu';
    box.innerHTML = html;
    box.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-mact]');
      if (!b || b.disabled) return;
      this.closeFileMenu();
      const a = b.dataset.mact;
      if (a === 'selectAll') { this.sel = new Set(this.content.children.filter((c) => this.selectable(c))); this.setTool('select'); return; }
      if (a.startsWith('al:')) { this.align(a.slice(3)); return; }
      if (a === 'rot180') { this.transformSel((x, c) => x.rotate(180, c), '已旋转 180°'); return; }
      if (a === 'askRot') { const b = this.selBounds(); if (b) this.askRotate(b.center); return; }
      this.act(a, b);
    });
    const btn = this.$(`[data-menu=${id}]`);
    const r = btn.getBoundingClientRect(); const hr = this.host.getBoundingClientRect();
    box.style.left = `${Math.min(r.left - hr.left, hr.width - 260)}px`;
    box.style.top = `${r.bottom - hr.top + 4}px`;
    this.host.appendChild(box);
    this.fileMenu = box;
    this.openMenuId = id;
    btn.classList.add('on');
    this._fmClose = (ev) => { if (!box.contains(ev.target) && ev.target !== btn) this.closeFileMenu(); };
    setTimeout(() => document.addEventListener('pointerdown', this._fmClose), 0);
  }

  setFileLabel(text) {
    const el = this.$ && this.$('.sk-file');
    if (!el) return;
    const dirty = /●\s*$/.test(text);
    const name = text.replace(/\s*●\s*$/, '');
    if (!this.renaming && el.textContent !== name) el.textContent = name;
    const st = this.$('.sk-savestate');
    if (st) { st.classList.toggle('dirty', dirty); st.textContent = dirty ? '未保存' : (name === '未命名设计' ? '' : '已保存'); }
  }

  // 标题上直接改名：输入名字，回车 / 点别处 = 保存（没保存过的存到「文稿/SeedLaser」，保存过的原地改名）；Esc 取消
  startRename() {
    if (this.renaming) return;
    const el = this.$('.sk-file');
    const cur = (el.textContent || '').replace(/\s*●\s*$/, '');
    const blank = !cur || cur === '未命名设计';
    this.renaming = true;
    el.classList.add('editing');
    el.innerHTML = '';
    const inp = document.createElement('input');
    inp.className = 'sk-file-input';
    inp.value = blank ? '' : cur;
    inp.placeholder = '输入项目名称，回车保存';
    inp.maxLength = 80;
    el.appendChild(inp);
    inp.focus(); inp.select();
    let done = false;
    const finish = (save) => {
      if (done) return;
      done = true;
      this.renaming = false;
      el.classList.remove('editing');
      el.textContent = cur || '未命名设计';
      const name = inp.value.trim();
      if (save && name && (name !== cur || blank)) this.fileCmd('rename', name);
      else if (save && name && name === cur) this.fileCmd('save');
    };
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') finish(true);
      else if (ev.key === 'Escape') finish(false);
    });
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('click', (ev) => ev.stopPropagation());
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

  refresh(selOnly) {
    this.content.children.forEach((c) => { if (c.data && c.data.mode) this.style(c); });
    for (const it of [...this.sel]) if (!it.parent) this.sel.delete(it);
    this.content.children.forEach((c) => { c.fullySelected = this.tool === 'node' && this.sel.has(c); });
    if (!selOnly) this.drawBoard();         // 只改了选中（图形没变）时，板面不用重画
    this.drawDimLabels();
    this.drawSelection();
    this.updateNumeric();
    this.renderToolOpts();
    this.updateCounts();
    this.updateCards();
    const lockBtn = this.$('.sk-lock');
    lockBtn.textContent = this.outlineLocked ? '🔒 外轮廓已锁定' : '🔓 外轮廓可编辑';
    lockBtn.classList.toggle('on', !this.outlineLocked);
    // 只有带卡榫边的生成零件外轮廓（locked）才需要这个开关；自己画的图形没有，就不显示
    lockBtn.classList.toggle('hidden', !this.content.children.some((it) => it.data && it.data.locked && it.data.role === 'outline'));
  }

  // 左侧功能按钮：在属性面板里跳到对应区块（展开、滚到可见处、闪一下）
  revealPanel(panel) {
    const name = { align: '对齐', bool: '运算', array: '阵列', transform: '变换' }[panel];
    if (!this.sel.size) {
      this.status(`先在画布上选中图形（Shift 多选或拖框框选），右侧就会出现「${name}」`);
      this.flashCard(this.$('.sk-emptyhint'));
      return;
    }
    if (panel === 'align' && this.sel.size < 2) {
      this.status('对齐要选中 2 个以上图形；只选 1 个时，可用上方的对齐按钮把它对齐到整块板');
      return;
    }
    const cards = [...this.$$(`.sk-side [data-panel=${panel}]`)];
    cards.forEach((c) => this.setCollapsed(c, false));
    if (cards[0]) { cards[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' }); cards.forEach((c) => this.flashCard(c)); }
    this.status(TOOLS.find((q) => q.panel === panel).tip);
  }

  flashCard(c) {
    if (!c) return;
    c.classList.remove('sk-flash');
    void c.offsetWidth;            // 重新触发动画
    c.classList.add('sk-flash');
  }

  // 区块折叠：点标题切换，记在本机（下次打开还是这样）
  collapsedMap() {
    if (!this._collapsed) {
      try { this._collapsed = JSON.parse(localStorage.getItem('seedboxes.skCollapsed') || 'null'); } catch (e) { this._collapsed = null; }
      if (!this._collapsed) this._collapsed = { 't-path': true, 't-group': true, 't-slot': true, array: true };
    }
    return this._collapsed;
  }

  setCollapsed(card, on) {
    const k = card.dataset.key;
    if (!k) return;
    card.classList.toggle('collapsed', on);
    this.collapsedMap()[k] = on;
    try { localStorage.setItem('seedboxes.skCollapsed', JSON.stringify(this._collapsed)); } catch (e) { /* 只在本机 */ }
  }

  initCollapsible() {
    const m = this.collapsedMap();
    this.$$('.sk-side [data-key]').forEach((card) => {
      card.classList.toggle('collapsed', !!m[card.dataset.key]);
      const h = card.querySelector('h4');
      h.classList.add('sk-collapsible');
      h.addEventListener('click', () => this.setCollapsed(card, !card.classList.contains('collapsed')));
    });
  }

  // 右侧属性面板：每次刷新时按当前工具和选中内容决定显示哪些区块
  updateCards() {
    if (!this.$) return;
    if (this.rotLabel && !this.sel.size) this.closeRotLabel();
    // 右侧 = 属性面板（参考 Illustrator / Figma）：内容跟着「选中了什么」走
    //   画图工具：只显示该工具的设置；选择工具 + 没选中：板件信息和提示；
    //   选中 1 个以上：运算、变换、阵列；选中 2 个以上：再加对齐
    const n = this.sel.size;
    const editing = this.tool === 'select' || this.tool === 'node';
    const want = { info: editing && n >= 1, align: editing && n >= 2, bool: editing && n >= 1, transform: editing && n >= 1, array: editing && n >= 1 };
    this.$$('.sk-side [data-panel]').forEach((c) => c.classList.toggle('hidden', !want[c.dataset.panel]));
    const idle = this.tool === 'select' && n === 0;
    const board = this.$('.sk-boardinfo');
    if (board) board.classList.toggle('hidden', !idle);
    const hint = this.$('.sk-emptyhint');
    if (hint) hint.classList.toggle('hidden', !idle);
    if (this.arrActive && !want.array) { this.arrActive = false; this.drawSelection(); }
    if (want.info) this.renderInfo();
    this.renderConns(idle || this.tool === 'joint' || this.tool === 'mortise');
  }

  updateCounts() {
    const c = { cut: 0, engrave: 0, score: 0 };
    this.content.children.forEach((it) => { if (it.data && c[it.data.mode] !== undefined) c[it.data.mode]++; });
    Object.keys(c).forEach((k) => { this.$(`[data-count=${k}]`).textContent = c[k]; });
    const one = this.sel.size ? [...this.sel][0].data.mode : this.opts.mode;
    this.$$('.sk-layer').forEach((b) => b.classList.toggle('on', b.dataset.mode === one));
    this.$$('.sk-eye').forEach((b) => { const off = this.layerHidden(b.dataset.eye); b.classList.toggle('off', off); b.textContent = off ? '🙈' : '👁'; });
    const li = this.$('.sk-lockinfo');
    if (li) {
      let lk = 0; let hd = 0;
      this.content.children.forEach((it) => { if (it.data) { if (it.data.lock) lk++; if (it.data.hidden) hd++; } });
      const lh = this.hiddenLayers ? this.hiddenLayers.size : 0;
      li.classList.toggle('hidden', !lk && !hd && !lh);
      li.querySelector('.sk-lockinfo-t').textContent = [lk ? `🔒 ${lk} 个锁定` : '', hd ? `🙈 ${hd} 个隐藏` : '', lh ? `${lh} 个图层隐藏` : ''].filter(Boolean).join(' · ');
      li.querySelector('[data-act=unlockAll]').classList.toggle('hidden', !lk);
      li.querySelector('[data-act=showAll]').classList.toggle('hidden', !hd && !lh);
    }
  }

  // 板的实体（木色）：所有闭合切割路径按奇偶规则填充
  drawBoard() {
    this.boardLayer.removeChildren();
    if (this.reference) this.boardLayer.addChild(this.reference);
    const loops = [];
    const owner = [];
    this.content.children.forEach((it) => {
      if (!it.data || it.data.mode !== 'cut') return;
      this.itemPaths(it).forEach((p) => { if (p.closed && p.segments.length > 2) { loops.push(p.clone({ insert: false })); owner.push(it); } });
    });
    if (!loops.length) return;
    // 填充规则：完全落在另一个轮廓里面的才是孔；互相交叉的轮廓都算实体（重叠处不会变空）
    const { depth, parent } = SketchEditor.loopDepths(loops);
    let at = 0;
    loops.forEach((L, i) => {
      if (depth[i] % 2) return;
      const holes = loops.filter((_, k) => parent[k] === i && depth[k] % 2 === 1);
      const cp = new this.ps.CompoundPath({ children: [L, ...holes].map((q) => q.clone({ insert: false })), insert: false });
      cp.fillRule = 'evenodd';
      cp.fillColor = null;            // 切割只显示黑色实线轮廓，不填木色（用户要求）；保留这层结构给交叉检查用
      cp.strokeColor = null;
      this.boardLayer.insertChild(at++, cp);
    });
    this.drawMarks();
    this.overlapWarn = 0;             // 重叠不再标色、不提示（用户要求）
  }

  // 水口标记（橙色小横杠，跨在切割线上）
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

  // ---------------------------------------------------------------- 水口

  bridgeAt(pt) {
    const tol = 7 / this.zoom;
    // 点在已有水口上：删除
    for (const it of this.content.children) {
      const list = it.data && it.data.bridges;
      if (!list) continue;
      const i = list.findIndex(([x, y]) => Math.hypot(x - pt.x, y - pt.y) < tol);
      if (i >= 0) {
        it.data.bridges = list.filter((_, k) => k !== i);
        this.commit('已删除水口');
        return;
      }
    }
    const res = this.strokeAt(pt, tol, (h) => { const it = this.topItem(h.item); return it && it.data.mode === 'cut' && it.data.role !== 'outline-locked'; });
    if (!res || !res.location) { this.status('请点在切割线上'); return; }
    const it = this.topItem(res.item);
    const p = res.location.point;
    it.data.bridges = [...(it.data.bridges || []), [p.x, p.y]];
    this.commit(`已加水口（宽 ${fmt(this.opts.bridgeW)} mm）`);
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
    if (!count) { this.toast('没有可以加水口的闭合切割图形（先选中镂空图形）', 'error'); return; }
    this.commit(`已自动加 ${count} 个水口`);
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
    this.drawDimLabels();                    // 标注文字按屏幕像素定大小，缩放后重排
    this.drawSelection();
    if (this.marks) this.drawMarks();
    const zl = this.$ && this.$('.sk-zoom');
    if (zl && document.activeElement !== zl) zl.value = `${Math.round(this.zoom / PX_PER_MM * 100)}%`;   // 100% ≈ 屏幕上的实际大小（96 dpi）
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

  // 适合窗口。sheetOnly：只对准材料（打开画板时：材料左上角的原点 (0, 0) 在画面左上方）
  fit(sheetOnly) {
    const v = this.ps.view;
    v.viewSize = new this.ps.Size(this.canvas.clientWidth || 800, this.canvas.clientHeight || 600);
    let b = null;
    if (!(sheetOnly && this.sheetMode)) this.content.children.forEach((c) => { b = b ? b.unite(c.bounds) : c.bounds.clone(); });
    if (this.sheetMode) { const m = new this.ps.Rectangle(0, 0, this.part.sheet.w, this.part.sheet.h); b = b ? b.unite(m) : m; }
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
      // 拖节点时（opts.skipSeg）：这个节点自己、和它相连的边的中点、它所在图形的中心和交点都跟着动，不能当吸附点，
      // 否则节点会吸在自己的旧位置上拖不动
      const sk = opts.skipSeg;
      const movingItem = sk ? this.topItem(sk.path) : null;
      near.forEach((it) => this.itemPaths(it).forEach((p) => {
        p.segments.forEach((sg) => { if (sg !== sk) add(sg.point, '端点', 0); });
        p.curves.forEach((c) => { if (!sk || (c.segment1 !== sk && c.segment2 !== sk)) add(c.getPointAtTime(0.5), '中点', 2); });
      }));
      (opts.extra || []).forEach((q) => add(q, '端点', 0));
      near.forEach((it) => { if (it !== movingItem) add(it.bounds.center, it.className === 'Path' && it.segments.length === 4 && !it.segments[0].handleIn.isZero() ? '圆心' : '中心', 3); });
      if (near.length >= 1 && near.length <= 8) {
        const paths = near.filter((it) => it !== movingItem).flatMap((it) => this.itemPaths(it));
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
        this.lastSnapKind = best.kind;
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
    const onGuide = x !== null || y !== null;
    // 和其它图形的边 / 中线对齐（绿色辅助线）
    let ax = null; let ay = null;
    if (this.snapPoints && !opts.noPoints && !opts.noAlign) {
      // 拖节点时，它所在图形的外框跟着变，不能拿来对齐（否则吸在自己身上）
      const ex = opts.skipSeg ? new Set([...(opts.exclude || []), this.topItem(opts.skipSeg.path)]) : opts.exclude;
      this.alignTargets(ex).forEach((b) => {
        if (x === null) [b.left, b.center.x, b.right].forEach((v) => { if (Math.abs(pt.x - v) < tol && (ax === null || Math.abs(pt.x - v) < Math.abs(pt.x - ax.v))) ax = { v, b }; });
        if (y === null) [b.top, b.center.y, b.bottom].forEach((v) => { if (Math.abs(pt.y - v) < tol && (ay === null || Math.abs(pt.y - v) < Math.abs(pt.y - ay.v))) ay = { v, b }; });
      });
    }
    const q = new this.ps.Point(x !== null ? x : ax ? ax.v : gx(pt.x), y !== null ? y : ay ? ay.v : gx(pt.y));
    if (onGuide) this.showSnap(q, '参考线'); else this.showSnap(null);
    this.lastSnapKind = onGuide ? '参考线' : (ax || ay) ? '对齐' : null;
    if (ax || ay) {
      const g = new this.ps.Group({ parent: this.overlay });
      const ext = 6 / this.zoom;
      if (ax) this.greenLine(g, [ax.v, Math.min(ax.b.top, q.y) - ext], [ax.v, Math.max(ax.b.bottom, q.y) + ext]);
      if (ay) this.greenLine(g, [Math.min(ay.b.left, q.x) - ext, ay.v], [Math.max(ay.b.right, q.x) + ext, ay.v]);
      this.snapGuide = g;
    }
    return q;
  }

  showSnap(p, kind) {
    if (this.snapMark) { this.snapMark.remove(); this.snapMark = null; }
    if (this.snapGuide) { this.snapGuide.remove(); this.snapGuide = null; }
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


  // ================================================================ 智能辅助线（绿色）
  // 拖动 / 画图 / 选中时：和别的图形左右边、上下边、中线对齐，边贴边，圆和圆 / 圆和直边相切 → 自动吸附并画绿色辅助线

  alignTargets(exclude) {
    return this.content.children.filter((it) => it.data && it.data.mode && !it.data.drawing && it.visible
      && !(exclude && exclude.has(it))).map((it) => it.bounds);
  }

  circleOf(it) {
    if (!it || it.className !== 'Path' || !it.closed || it.segments.length !== 4) return null;
    if (it.segments.some((sg) => sg.handleIn.isZero())) return null;
    const b = it.bounds;
    if (Math.abs(b.width - b.height) > 1e-3 * Math.max(1, b.width)) return null;
    return { c: b.center, r: b.width / 2 };
  }

  greenLine(parent, a, b, dash) {
    const l = new this.ps.Path.Line({ from: a, to: b, parent, strokeColor: SMART, strokeWidth: 1, strokeScaling: false });
    if (dash) l.dashArray = [4, 3];
    l.data.ui = true;
    return l;
  }

  // 轴向对齐：返回最接近的 dx / dy（在 tol 内），没有则为 null
  alignDelta(box, targets, tol) {
    let dx = null; let dy = null;
    const bx = [box.left, box.center.x, box.right]; const by = [box.top, box.center.y, box.bottom];
    targets.forEach((t) => {
      [t.left, t.center.x, t.right].forEach((v) => bx.forEach((u) => { const d = v - u; if (Math.abs(d) < tol && (dx === null || Math.abs(d) < Math.abs(dx))) dx = d; }));
      [t.top, t.center.y, t.bottom].forEach((v) => by.forEach((u) => { const d = v - u; if (Math.abs(d) < tol && (dy === null || Math.abs(d) < Math.abs(dy))) dy = d; }));
    });
    return { dx, dy };
  }

  // 一个圆和别的圆 / 直边相切：返回把圆心挪到相切位置的位移
  tangentDelta(circ, exclude, tol) {
    let best = null;
    const take = (v, info) => { if (!best || v.length < best.v.length) best = { v, info }; };
    this.content.children.forEach((it) => {
      if (!it.data || !it.data.mode || it.data.drawing || !it.visible || (exclude && exclude.has(it))) return;
      if (!it.bounds.expand(circ.r * 2 + tol * 2).contains(circ.c)) return;
      const oc = this.circleOf(it);
      if (oc) {
        const dv = circ.c.subtract(oc.c); const dist = dv.length;
        if (dist < 1e-6) return;
        [circ.r + oc.r, Math.abs(circ.r - oc.r)].forEach((R) => {
          if (R < 1e-6 || Math.abs(dist - R) >= tol) return;
          take(dv.normalize(R - dist), { kind: 'cc', o: oc });
        });
        return;
      }
      this.itemPaths(it).forEach((p) => p.curves.forEach((cv) => {
        if (!cv.isStraight()) return;
        const a = cv.point1; const b = cv.point2; const ab = b.subtract(a); const L2 = ab.dot(ab);
        if (L2 < 1e-9) return;
        const t = circ.c.subtract(a).dot(ab) / L2;
        if (t <= 0 || t >= 1) return;
        const q = a.add(ab.multiply(t)); const dv = circ.c.subtract(q); const dist = dv.length;
        if (dist < 1e-6 || Math.abs(dist - circ.r) >= tol) return;
        take(dv.normalize(circ.r - dist), { kind: 'cl', a, b });
      }));
    });
    return best;
  }

  // 画出当前已经精确成立的对齐 / 贴边 / 相切关系（不吸附，只显示）；返回关系名称列表
  drawSmart(box, exclude, parent, circ) {
    const eps = 0.005;
    const kinds = new Set();
    const ext = 6 / this.zoom;
    const lines = new Map();
    const bx = [['l', box.left], ['c', box.center.x], ['r', box.right]];
    const by = [['l', box.top], ['c', box.center.y], ['r', box.bottom]];
    const note = (k1, k2) => (k1 === 'c' && k2 === 'c' ? '居中' : (k1 !== k2 && k1 !== 'c' && k2 !== 'c') ? '贴边' : '对齐');
    this.alignTargets(exclude).forEach((t) => {
      const tx = [['l', t.left], ['c', t.center.x], ['r', t.right]];
      const ty = [['l', t.top], ['c', t.center.y], ['r', t.bottom]];
      bx.forEach(([k1, u]) => tx.forEach(([k2, v]) => {
        if (Math.abs(u - v) > eps) return;
        const key = 'x' + v.toFixed(3); const o = lines.get(key) || { axis: 'x', v, lo: Math.min(box.top, t.top), hi: Math.max(box.bottom, t.bottom) };
        o.lo = Math.min(o.lo, t.top, box.top); o.hi = Math.max(o.hi, t.bottom, box.bottom); lines.set(key, o); kinds.add(note(k1, k2));
      }));
      by.forEach(([k1, u]) => ty.forEach(([k2, v]) => {
        if (Math.abs(u - v) > eps) return;
        const key = 'y' + v.toFixed(3); const o = lines.get(key) || { axis: 'y', v, lo: Math.min(box.left, t.left), hi: Math.max(box.right, t.right) };
        o.lo = Math.min(o.lo, t.left, box.left); o.hi = Math.max(o.hi, t.right, box.right); lines.set(key, o); kinds.add(note(k1, k2));
      }));
    });
    lines.forEach((o) => {
      if (o.axis === 'x') this.greenLine(parent, [o.v, o.lo - ext], [o.v, o.hi + ext]);
      else this.greenLine(parent, [o.lo - ext, o.v], [o.hi + ext, o.v]);
    });
    if (circ) {
      const tg = this.tangentDelta(circ, exclude, eps);
      if (tg) {
        kinds.add('相切');
        let tp;
        if (tg.info.kind === 'cc') {
          const o = tg.info.o; const dir = circ.c.subtract(o.c).normalize();
          const inner = Math.abs(circ.c.getDistance(o.c) - Math.abs(circ.r - o.r)) < Math.abs(circ.c.getDistance(o.c) - (circ.r + o.r));
          tp = inner ? (o.r > circ.r ? o.c.add(dir.multiply(o.r)) : circ.c.add(dir.multiply(circ.r))) : o.c.add(dir.multiply(o.r));
          this.greenLine(parent, o.c, circ.c, true);
        } else {
          const { a, b } = tg.info; const ab = b.subtract(a);
          tp = a.add(ab.multiply(circ.c.subtract(a).dot(ab) / ab.dot(ab)));
          this.greenLine(parent, circ.c, tp, true);
          const u = ab.normalize(12 / this.zoom);
          this.greenLine(parent, tp.subtract(u), tp.add(u));
        }
        const m = new this.ps.Path.Circle({ center: tp, radius: 3.5 / this.zoom, parent, fillColor: SMART });
        m.data.ui = true;
      }
    }
    return [...kinds];
  }

  // 拖动时：先端点吸附；没有吸到点时，按图形外框对齐 / 圆相切吸附
  smartMove(d, rawDelta, gridDelta) {
    if (['端点', '交点', '中点', '圆心', '中心'].includes(this.lastSnapKind) || !this.snapPoints) return gridDelta;
    const tol = 7 / this.zoom;
    if (d.circ) {
      const c = d.circ.c.add(rawDelta);
      const tg = this.tangentDelta({ c, r: d.circ.r }, this.sel, tol);
      if (tg && tg.info.kind === 'cc') return rawDelta.add(tg.v);
      if (tg) {   // 和直边相切：沿着这条边还可以继续对齐（例如贴着板边同时上下居中）
        const v = rawDelta.add(tg.v);
        const box = d.box0.clone(); box.center = d.box0.center.add(v);
        const { dx, dy } = this.alignDelta(box, d.targets, tol);
        const dir = tg.info.b.subtract(tg.info.a).normalize();
        return v.add(dir.multiply(dir.dot(new this.ps.Point(dx || 0, dy || 0))));
      }
    }
    const box = d.box0.clone(); box.center = d.box0.center.add(rawDelta);
    const { dx, dy } = this.alignDelta(box, d.targets, tol);
    return new this.ps.Point(dx !== null ? rawDelta.x + dx : gridDelta.x, dy !== null ? rawDelta.y + dy : gridDelta.y);
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
      if (isMajor) { gy.save(); gy.translate(9, sy - 2); gy.rotate(-Math.PI / 2); gy.fillText(String(Math.round(this.dispY(y))), 0, 0); gy.restore(); }
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

  // ---------------------------------------------------------------- 画板模式：识别板件
  // 最外层的闭合切割轮廓 = 一块板；轮廓里面的孔、雕刻、文字归这块板
  // 每个闭合轮廓的嵌套层数：只有「完全在里面、边界不相交」才算被包含。parent = 直接包住它的最小轮廓
  static loopDepths(loops) {
    const n = loops.length;
    const area = loops.map((p) => Math.abs(p.area));
    // 外框先算好成数字（paper 的 bounds 每次访问都要查缓存，200 个图形时是 4 万次）
    const bb = loops.map((p) => { const r = p.bounds; return [r.left, r.top, r.right, r.bottom]; });
    const boxIn = (a, b) => bb[b][0] <= bb[a][0] && bb[b][1] <= bb[a][1] && bb[b][2] >= bb[a][2] && bb[b][3] >= bb[a][3];
    const inside = (a, b) => a !== b && area[b] > area[a] && boxIn(a, b)
      && loops[b].contains(loops[a].firstSegment.point) && !loops[a].getIntersections(loops[b]).length;
    const depth = new Array(n).fill(0);
    const parent = new Array(n).fill(-1);
    for (let a = 0; a < n; a++) {
      for (let b = 0; b < n; b++) {
        if (!inside(a, b)) continue;
        depth[a]++;
        if (parent[a] < 0 || area[b] < area[parent[a]]) parent[a] = b;
      }
    }
    return { depth, parent };
  }

  static pathLoopArea(p) {
    // 平移 / 旋转不改变面积和周长：用它们做缓存键，拖动时不用每次重新展平、拆自相交
    const key = `${p.segments.length}|${p.area.toFixed(6)}|${p.length.toFixed(6)}`;
    if (p._loopKey === key) return p._loopArea;
    const segs = p.segments.map((sg) => [sg.point.x, sg.point.y, sg.handleIn.x, sg.handleIn.y, sg.handleOut.x, sg.handleOut.y]);
    p._loopKey = key;
    p._loopArea = loopArea(flattenPath({ closed: true, segs }));
    return p._loopArea;
  }

  // 同一个已提交状态只识别一次板件（只改选中、切工具时不重算）
  partsCached() {
    if (this.drag) return this._plR || this.recognizeParts();
    if (!this.current || this._plKey !== this.current) { this._plR = this.recognizeParts(); this._plKey = this.current; }
    return this._plR;
  }

  // ---------------------------------------------------------------- 连接清单（B1）
  // 连接 = 两条带同一个 pair 的卡榫边（数据就在各图形的 data.joints 里，项目文件里本来就有）。
  // 这里只是把它们整理成清单，不另存一份，避免两份数据对不上。
  static edgeSide(j, b) {
    if (j.type === 'mortise') return '插槽';
    const ax = j.a[0]; const ay = j.a[1]; const bx = j.b[0]; const by = j.b[1];
    const tol = Math.max(0.5, (j.depth || 3) + 0.5);
    if (Math.abs(ay - by) < 1e-6) {
      if (Math.abs(ay - b.bottom) <= tol) return '上边';         // y 向上：屏幕上方 = paper 的 bottom
      if (Math.abs(ay - b.top) <= tol) return '下边';
      return '水平边';
    }
    if (Math.abs(ax - bx) < 1e-6) {
      if (Math.abs(ax - b.left) <= tol) return '左边';
      if (Math.abs(ax - b.right) <= tol) return '右边';
      return '竖直边';
    }
    return '斜边';
  }

  connections() {
    const out = { pairs: [], singles: [], mortises: [] };
    if (!this.content) return out;
    const { parts } = this.sheetMode ? this.partsCached() : { parts: [] };
    const names = (this.part && this.part.names) || {};
    const hostOf = (it) => parts.find((p) => p.item === it || p.members.includes(it));
    const ends = [];
    this.content.children.forEach((it) => {
      (it.data && it.data.joints || []).forEach((j) => {
        const host = hostOf(it);
        const pid = host ? host.item.data.pid : null;
        const name = host ? (names[pid] || `新板件 ${parts.indexOf(host) + 1}`) : '不在板里的图形';
        ends.push({ item: it, j, pid, name, side: host ? SketchEditor.edgeSide(j, host.item.bounds) : '边' });
      });
    });
    const typeName = { a: '指接 A', b: '指接 B', slot: '凹槽', mortise: '插槽' };
    const byPair = new Map();
    ends.forEach((e) => {
      if (e.j.type === 'mortise' && !e.j.pair) { out.mortises.push({ key: `m:${e.j.id}`, ends: [e], L: e.j.L, k: e.j.k }); return; }
      if (!e.j.pair) { out.singles.push({ key: `s:${e.j.id}`, ends: [e], L: e.j.L, k: e.j.k, type: typeName[e.j.type] || e.j.type }); return; }
      if (!byPair.has(e.j.pair)) byPair.set(e.j.pair, []);
      byPair.get(e.j.pair).push(e);
    });
    const t = (this.part && this.part.thickness) || 3;
    // 每条边自己的问题：齿深和板厚不一致。
    // （板角上三块板会不会相碰，取决于在这个角相遇的三块板，只看一块板判断不了，交给 3D 检查，见 B4）
    const own = (e) => {
      const r = []; const f = [];
      if (e.j.depth && Math.abs(e.j.depth - t) > 0.01) { r.push(`${e.name} 的${e.side}按板厚 ${fmt(e.j.depth)} mm 做的，现在板厚是 ${fmt(t)} mm`); f.push('depth'); }
      return { r, f };
    };
    byPair.forEach((list, pair) => {
      const reasons = []; const fixes = [];
      if (list.length === 1) { reasons.push('另一条边找不到了（可能被删掉或改成了普通边）'); fixes.push('unpair'); }
      if (list.length > 2) { reasons.push(`有 ${list.length} 条边用了同一个配对`); fixes.push('unpair'); }
      if (list.length === 2) {
        const [p, q] = list;
        const sameL = Math.abs(p.j.L - q.j.L) <= 0.3;
        if (!sameL) reasons.push(`两条边不一样长（${fmt(p.j.L)} / ${fmt(q.j.L)} mm），要改板的尺寸`);
        const types = [p.j.type, q.j.type].sort().join('+');
        const mort = types.includes('mortise');                         // A 边 ↔ 插槽（T 型）：插槽没法自动重做齿，只提示
        if (types !== 'a+b' && types !== 'a+mortise') { reasons.push(`齿不能互补（${typeName[p.j.type] || p.j.type} + ${typeName[q.j.type] || q.j.type}）`); if (!mort) fixes.push('complement'); }
        else if (sameL && !SketchEditor.sameIv(p.j.iv, q.j.iv, p.j.L)) { reasons.push(mort ? '插槽的孔和 A 边的齿对不上（齿数或间隔不一样）' : '齿位对不上（齿数或间隔不一样）'); if (!mort) fixes.push('match'); }
        if (p.pid && p.pid === q.pid) { reasons.push('两条边在同一块板上'); fixes.push('unpair'); }
      }
      list.forEach((e) => { const o = own(e); reasons.push(...o.r); fixes.push(...o.f); });
      const s3 = this.conn3d && this.conn3d[pair];                       // B4：3D 拼装检查的结果（workshop 传进来）
      if (s3 && s3.state !== 'ok' && !(s3.state === 'nomate' && reasons.length)) reasons.push(s3.why);   // 拼不上的原因二维已经写了就不重复
      out.pairs.push({ key: `p:${pair}`, pair, ends: list, L: list[0].j.L, k: list[0].j.k, ok: !reasons.length, reasons, fixes: [...new Set(fixes)],
        tee: list.some((e) => e.j.type === 'mortise') });
    });
    [...out.singles, ...out.mortises].forEach((x) => {
      const o = own(x.ends[0]);
      x.reasons = o.r; x.fixes = [...new Set(o.f.filter((f) => f === 'depth'))]; x.ok = !o.r.length;
    });
    // 有问题的排前面，其余按板件名
    out.pairs.sort((u, v) => (u.ok - v.ok) || u.ends[0].name.localeCompare(v.ends[0].name, 'zh'));
    return out;
  }

  renderConns(show) {
    const card = this.$('.sk-conns');
    if (!card) return;
    if (!this.sheetMode || !show || this.drag) { card.classList.add('hidden'); return; }
    const c = this.connections();
    const total = c.pairs.length + c.singles.length + c.mortises.length;
    if (!total && this.tool !== 'joint' && this.tool !== 'mortise') { card.classList.add('hidden'); return; }
    card.classList.remove('hidden');
    const bad = [...c.pairs, ...c.singles, ...c.mortises].filter((p) => !p.ok).length;
    this.$('.sk-conn-n').textContent = total ? `${c.pairs.length} 对${bad ? ` · ⚠ ${bad}` : ''}` : '';
    const who = (e) => `${escAttr(e.name)} · ${escAttr(e.side)}`;
    const FIX = { depth: '按现在板厚重做', match: '按 A 边重做齿位', complement: '做成互补的齿', unpair: '解除配对' };
    const row = (x, title, sub, cls, why) => `<div class="sk-conn ${cls}" role="button" tabindex="0" data-ck="${escAttr(x.key)}" title="点一下：在画板和 3D 里高亮这${x.ends.length > 1 ? '两' : ''}条边">
      <span class="st">${cls === 'ok' ? '✓' : cls === 'warn' ? '⚠' : '·'}</span><span class="nm">${title}</span><span class="sub">${sub}</span>${why ? `<span class="why">${why}</span>` : ''}${(x.fixes || []).length ? `<span class="fixes">${x.fixes.map((f) => `<button data-fix="${f}">${FIX[f]}</button>`).join('')}</span>` : ''}</div>`;
    let html = '';
    c.pairs.forEach((x) => {
      const t = x.ends.length >= 2 ? `${who(x.ends[0])} ↔ ${who(x.ends[1])}` : `${who(x.ends[0])} ↔ ？`;
      html += row(x, t, `${x.tee ? '插槽（T 型）' : '指接卡榫'} · ${fmt(x.L)} mm · ${x.k} 个齿`, x.ok ? 'ok' : 'warn', x.reasons.map(escAttr).join('；'));
    });
    if (c.singles.length) {
      html += '<div class="sk-conn-h">还没配对的卡榫边</div>';
      c.singles.forEach((x) => { html += row(x, who(x.ends[0]), `${x.type} · ${fmt(x.L)} mm`, x.ok ? 'single' : 'warn', x.reasons.map(escAttr).join('；')); });
    }
    if (c.mortises.length) {
      html += '<div class="sk-conn-h">插槽</div>';
      c.mortises.forEach((x) => { html += row(x, escAttr(x.ends[0].name), `插槽 · ${fmt(x.L)} mm · ${x.k} 个孔`, x.ok ? 'single' : 'warn', x.reasons.map(escAttr).join('；')); });
    }
    if (!total) html = '<p class="sk-small">还没有连接：用「卡榫」工具先点一块板的边，再点另一块板要和它拼在一起的边，就配成一对。</p>';
    const list = this.$('.sk-conn-list');
    list.innerHTML = html;
    list.querySelectorAll('[data-ck]').forEach((b) => b.addEventListener('click', (ev) => {
      const f = ev.target.closest('[data-fix]');
      if (f) { ev.stopPropagation(); this.fixConn(b.dataset.ck, f.dataset.fix); return; }
      this.highlightConn(b.dataset.ck);
    }));
    if (this._hlKey) list.querySelectorAll('[data-ck]').forEach((b) => b.classList.toggle('on', b.dataset.ck === this._hlKey));
  }

  // 同一对边的齿位一致（B 边用的是 A 边的区间；方向相反时按镜像比）
  static sameIv(u, v, L) {
    const eq = (x, y) => x.length === y.length && x.every((q, i) => Math.abs(q[0] - y[i][0]) < 0.02 && Math.abs(q[1] - y[i][1]) < 0.02);
    const mir = (x) => x.map(([s0, e0]) => [L - e0, L - s0]).reverse();
    return eq(u || [], v || []) || eq(mir(u || []), v || []);
  }

  // 一键修复（B2）：整个修复只算一步撤销
  fixConn(key, kind) {
    const c = this.connections();
    const x = [...c.pairs, ...c.singles, ...c.mortises].find((q) => q.key === key);
    if (!x) return;
    const live = (e) => {
      const item = this.content.children.find((ch) => ch.data && ch.data.id === e.item.data.id);
      const joint = item && (item.data.joints || []).find((q) => q.id === e.j.id);
      return item && joint ? { item, joint } : null;
    };
    const t = (this.part && this.part.thickness) || 3;
    let done = 0; let failed = 0;
    const run = (e, opts) => { const L = live(e); if (L && this.remakeJoint(L.item, L.joint, opts)) done++; else failed++; };
    let label = '';
    if (kind === 'unpair') {
      x.ends.forEach((e) => { const L = live(e); if (L) { delete L.joint.pair; done++; } });
      label = '已解除配对（两条边保留为没配对的卡榫边）';
    } else if (kind === 'depth') {
      x.ends.filter((e) => e.j.depth && Math.abs(e.j.depth - t) > 0.01).forEach((e) => run(e, { depth: t }));
      label = `已按板厚 ${fmt(t)} mm 重做齿深`;
    } else if (kind === 'match' || kind === 'complement') {
      // 以 A 边为准（两条都是同一种时以第一条为准），另一条按它的齿位做成互补的
      const [p, q] = x.ends[0].j.type === 'a' || x.ends[1].j.type !== 'a' ? x.ends : [x.ends[1], x.ends[0]];
      run(q, { type: p.j.type === 'a' ? 'b' : 'a', iv: p.j.iv });
      label = `已按「${p.name} 的${p.side}」重做「${q.name} 的${q.side}」，两边的齿互补`;
    }
    if (!done) { this.toast(failed ? '这条边被改动过，没法自动修复；可以撤销后重做卡榫' : '没有需要修复的', 'error'); this.refresh(); return; }
    this.commit(label + (failed ? `；有 ${failed} 条边被改动过，没能自动修复` : ''));
    this.highlightConn(key);
  }

  // B4：workshop 每次 3D 检查后传进来 { pair: { state, why } }
  setConn3D(map) {
    const key = JSON.stringify(map || {});
    if (key === this._conn3dKey) return;
    this._conn3dKey = key;
    this.conn3d = map || {};
    if (this.opened && !this.drag) this.updateCards();
  }

  // 点连接清单的一行：画板上高亮这对边并移到画面中间；3D 预览里也高亮（onHighlight 由 workshop 接上）
  highlightConn(key) {
    const c = this.connections();
    const x = [...c.pairs, ...c.singles, ...c.mortises].find((q) => q.key === key);
    this.clearConnHighlight();
    if (!x) return;
    this._hlKey = key;
    const g = new this.ps.Group({ parent: this.hlLayer });
    let box = null;
    x.ends.forEach((e) => {
      const a = new this.ps.Point(e.j.a[0], e.j.a[1]);
      const b = new this.ps.Point(e.j.b[0], e.j.b[1]);
      const ln = new this.ps.Path.Line({ from: a, to: b, parent: g, strokeColor: '#f97316', strokeWidth: 7, strokeScaling: false, opacity: 0.75, strokeCap: 'round' });
      box = box ? box.unite(ln.bounds) : ln.bounds.clone();
    });
    if (box) {
      const v = this.ps.view;
      const z = Math.min(this.zoom, v.viewSize.width / (box.width * 1.6 + 60), v.viewSize.height / (box.height * 1.6 + 60));
      this.setView(z, box.center.x, box.center.y);
    }
    this.$$('.sk-conn').forEach((b) => b.classList.toggle('on', b.dataset.ck === key));
    if (this.onHighlight) this.onHighlight(x.ends.filter((e) => e.pid).map((e) => ({ pid: e.pid, a: e.j.a, b: e.j.b, depth: e.j.depth })));
    const why = x.reasons && x.reasons.length ? `  ⚠ ${x.reasons.join('；')}` : '';
    this.status(`${x.ends.map((e) => `${e.name} 的${e.side}`).join(' ↔ ')}${why}`);
  }

  clearConnHighlight() {
    if (this.hlLayer) this.hlLayer.removeChildren();
    if (this._hlKey) {
      this._hlKey = null;
      this.$$('.sk-conn.on').forEach((b) => b.classList.remove('on'));
      if (this.onHighlight) this.onHighlight(null);
    }
  }

  recognizeParts() {
    const loops = [];
    this.content.children.forEach((it) => {
      if (!it.data || it.data.mode !== 'cut') return;
      this.itemPaths(it).forEach((p) => {
        if (!p.closed || p.segments.length <= 2) return;
        // 自相交的环（蝴蝶结）paper 的 area 正负抵消接近 0，按拆开后的真实面积算
        const area = SketchEditor.pathLoopArea(p);
        if (area > 1) loops.push({ item: it, path: p, area });
      });
    });
    const dd = SketchEditor.loopDepths(loops.map((L) => L.path)).depth;
    loops.forEach((L, i) => { L.depth = dd[i]; });
    const outers = loops.filter((L) => L.depth % 2 === 0);
    const partItems = [...new Set(outers.map((L) => L.item))];
    const parts = partItems.map((item) => ({ item, members: [item],
      bounds: outers.filter((L) => L.item === item).reduce((b, L) => (b ? b.unite(L.path.bounds) : L.path.bounds.clone()), null) }));
    const loose = [];
    this.content.children.forEach((it) => {
      if (!it.data || !it.data.mode || partItems.includes(it)) return;
      if (it.data.mode === 'dim') {                                   // 标注：按它量的起点归到板；不算「不在板里」
        const g = this.dimGeom(it);
        const pt0 = g ? g.a : it.bounds.center;
        let host = null;
        outers.forEach((L) => { if (L.path.contains(pt0) && (!host || L.area < host.area)) host = L; });
        if (!host) outers.forEach((L) => { const d = L.path.getNearestPoint(pt0).getDistance(pt0); if (d < 1.5 && (!host || d < host._d)) { host = L; host._d = d; } });
        const part = host && parts.find((p) => p.item === host.item);
        if (part) part.members.push(it);
        return;
      }
      const c = it.bounds.center;
      let best = null;
      outers.forEach((L) => {
        if (!L.path.contains(c)) return;
        if (!best || L.depth > best.depth || (L.depth === best.depth && L.area < best.area)) best = L;
      });
      const part = best && parts.find((p) => p.item === best.item);
      if (part) part.members.push(it); else loose.push(it);
    });
    parts.sort((a, b) => (Math.abs(b.bounds.top - a.bounds.top) > 5 ? b.bounds.top - a.bounds.top : a.bounds.left - b.bounds.left));
    // 板件编号：沿用轮廓上记的 pid；复制出来的（pid 重复）换新的
    const seen = new Set();
    parts.forEach((p) => {
      if (!p.item.data.pid || seen.has(p.item.data.pid)) p.item.data.pid = 'p' + newId();
      seen.add(p.item.data.pid);
    });
    return { parts, loose };
  }

  serializeSheet() {
    const { parts, loose } = this.recognizeParts();
    const s = this.serialize();
    const byId = new Map(s.items.map((it) => [it.id, it]));
    return {
      sheet: true, size: { ...this.part.sheet }, bridge_w: s.bridge_w, guides: s.guides,
      parts: parts.map((p) => ({
        pid: p.item.data.pid, outline: p.item.data.id,
        bounds: [r3(p.bounds.left), r3(p.bounds.top), r3(p.bounds.right), r3(p.bounds.bottom)],
        origin: p.item.data.origin || null,
        items: p.members.map((m) => byId.get(m.data.id)).filter(Boolean).map((it) => ({ ...it, pid: it.id === p.item.data.id ? p.item.data.pid : undefined, origin: undefined })),
      })),
      loose: loose.map((m) => byId.get(m.data.id)).filter(Boolean),
    };
  }

  drawPartLabels() {
    let box = this.$('.sk-plabels');
    if (!box) {
      box = document.createElement('div');
      box.className = 'sk-plabels';
      this.$('.sk-dims').parentNode.appendChild(box);
    }
    box.innerHTML = '';
    if (this.drag) return;            // 拖动中不重新识别板件（每帧都算太慢），松手提交时再更新
    // 只改选中时图形没变：同一个已提交状态只识别一次
    const { parts, loose } = this.partsCached();
    const names = this.part.names || {};
    const v = this.ps.view;
    // 画布上不再贴「板件 N · 尺寸」标签（影响观感，用户要求）；选中后在右侧「图形信息」里看
    void names; void v;
    const sub = `材料 ${fmt(this.part.sheet.w)} × ${fmt(this.part.sheet.h)} mm · 板厚 ${fmt(this.part.thickness || 0)} mm · 识别到 ${parts.length} 块板` +
      (loose.length ? ` · ⚠ ${loose.length} 个图形不在任何板里（不会导出）` : '');
    this.$('.sk-sub').textContent = sub;
  }

  // 右侧「图形信息」：选中 1 个时显示详细参数；多个时显示数量和总范围
  renderInfo() {
    const box = this.$('.sk-info');
    if (!box) return;
    const items = [...this.sel];
    const row = (k, v) => `<div class="sk-info-row"><span>${k}</span><b>${v}</b></div>`;
    const len = (it) => this.itemPaths(it).reduce((a, p) => a + p.length, 0);
    let html = '';
    if (items.length === 1) {
      const it = items[0];
      const b = it.bounds;
      const m = MODES[it.data.mode] || MODES.cut;
      let where = '';
      if (this.sheetMode) {
        const { parts, loose } = this.recognizeParts();
        const names = (this.part && this.part.names) || {};
        const pname = (p) => names[p.item.data.pid] || `新板件 ${parts.indexOf(p) + 1}`;
        const own = parts.find((p) => p.item === it);
        const host = parts.find((p) => p.members.includes(it));
        if (own) where = `<b class="sk-info-part">${escAttr(pname(own))}</b>（一块板的外轮廓）`;
        else if (host) where = `在 <b>${escAttr(pname(host))}</b> 上的${it.data.mode === 'cut' ? '孔 / 镂空' : it.data.mode === 'engrave' ? '雕刻' : '描线'}`;
        else if (loose.includes(it)) where = '<span class="sk-warn-t">不在任何板里（不会导出）</span>';
      }
      const paths = this.itemPaths(it);
      const closed = paths.length && paths.every((p) => p.closed);
      const circ = this.circleOf(it);
      const nodes = paths.reduce((a, p) => a + p.segments.length, 0);
      const shape = it.data.text ? `文字「${escAttr(String(it.data.text.text || '').slice(0, 12))}」`
        : circ ? '圆' : (it.className === 'Path' && closed && nodes === 4 && paths[0].curves.every((c) => c.isStraight())) ? '四边形'
          : closed ? `闭合图形（${paths.length > 1 ? paths.length + ' 条轮廓' : nodes + ' 个节点'}）` : `开放路径（${nodes} 个节点）`;
      const area = closed ? Math.abs(paths.reduce((a, p) => a + p.area, 0)) : 0;
      html = (where ? `<div class="sk-info-where">${where}</div>` : '') +
        row('加工', `<i class="sk-dot" style="background:${m.color}"></i>${m.name}`) +
        row('形状', shape) +
        (circ ? row('直径', `${fmt(circ.r * 2)} mm`) + row('半径', `${fmt(circ.r)} mm`) : '') +
        row('宽 × 高', `${fmt(b.width)} × ${fmt(b.height)} mm`) +
        row('位置（左上角）', `X ${fmt(b.left)} · Y ${fmt(this.dispY(b.bottom))}`) +
        (closed ? row('面积', `${fmt(area / 100)} cm²`) : '') +
        row(it.data.mode === 'cut' ? '切割长度' : '线长', `${fmt(len(it))} mm`) +
        (it.data.bridges && it.data.bridges.length ? row('水口', `${it.data.bridges.length} 个`) : '');
    } else {
      const b = this.selBounds();
      const by = {};
      items.forEach((it) => { by[it.data.mode] = (by[it.data.mode] || 0) + 1; });
      html = row('选中', `${items.length} 个图形`) +
        row('其中', Object.entries(by).map(([k, n]) => `${(MODES[k] || MODES.cut).name} ${n}`).join(' · ')) +
        row('总范围', `${fmt(b.width)} × ${fmt(b.height)} mm`) +
        row('切割总长', `${fmt(items.filter((it) => it.data.mode === 'cut').reduce((a, it) => a + len(it), 0))} mm`);
    }
    box.innerHTML = html;
  }

  drawDims() {
    if (this.sheetMode) this.drawPartLabels();
    const box = this.$('.sk-dims');
    if (!box) return;
    box.innerHTML = '';
    if (this.sel.size !== 1 || !['select', 'node'].includes(this.tool) || (this.drag && this.drag.kind !== 'node')) return;
    const it = [...this.sel][0];
    const paths = this.itemPaths(it);
    const segCount = paths.reduce((n, p) => n + p.curves.length, 0);
    if (segCount > 60 || it.data.text) return;
    const v = this.ps.view;
    // 选择工具下，尺寸标签不能盖住缩放 / 旋转手柄（否则拉不动边）：挪到手柄旁边
    const hs = [];
    if (this.tool === 'select') {
      const b = it.bounds;
      [b.topLeft, b.topRight, b.bottomLeft, b.bottomRight, b.leftCenter, b.rightCenter, b.topCenter, b.bottomCenter,
        new this.ps.Point(b.center.x, b.bottom + 22 / this.zoom)].forEach((q) => hs.push(v.projectToView(q)));
    }
    paths.forEach((p) => p.curves.forEach((c) => {
      if (!c.isStraight() || c.length * this.zoom < 28) return;
      let at = null;
      // 标签离边线的距离按标签自身大小算（竖边留半个宽、横边留半个高），不压线
      const halfW = (String(fmt(c.length)).length * 8.5 + 20) / 2; const halfH = 12;
      for (const t of [0.5, 0.25, 0.75]) {
        const mid = c.getPointAtTime(t);
        const nu = c.getNormalAtTime(t).normalize();
        let n = nu.multiply((6 + Math.abs(nu.x) * halfW + Math.abs(nu.y) * halfH) / this.zoom);
        if (p.closed && p.contains(mid.add(n))) n = n.negate();
        const q = v.projectToView(mid.add(n));
        if (hs.every((h) => Math.abs(h.x - q.x) > 32 || Math.abs(h.y - q.y) > 20)) { at = q; break; }
      }
      if (!at) return;
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
    return it && it.data && it.data.mode && !(it.data.locked && this.outlineLocked && it.data.role === 'outline')
      && !it.data.lock && !it.data.hidden && !this.layerHidden(it.data.mode);
  }

  layerHidden(mode) { return !!(this.hiddenLayers && this.hiddenLayers.has(mode)); }

  // 点在锁定 / 隐藏图形上（选不中）：返回它，用来提示
  hitLocked(pt) {
    const res = this.content.hitTest(pt, { stroke: true, segments: true, tolerance: 6 / this.zoom,
      match: (h) => { const it = this.topItem(h.item); return it && it.data && it.data.lock && !it.data.hidden; } });
    return res ? this.topItem(res.item) : null;
  }

  // 锁定 / 隐藏 / 全部解锁 / 全部显示（C2）
  lockSel(on) {
    if (!this.need(1)) return;
    const n = this.sel.size;
    this.sel.forEach((it) => { it.data.lock = on; });
    if (on) { this.sel.clear(); this.$('.sk-layers-card').classList.remove('hidden'); }   // 让「全部解锁」看得见
    this.commit(on ? `已锁定 ${n} 个图形（不能选中、移动、删除；右键空白处「全部解锁」）` : `已解锁 ${n} 个图形`);
  }

  hideSel() {
    if (!this.need(1)) return;
    const n = this.sel.size;
    this.sel.forEach((it) => { it.data.hidden = true; });
    this.sel.clear();
    this.$('.sk-layers-card').classList.remove('hidden');                                  // 让「全部显示」看得见
    this.commit(`已隐藏 ${n} 个图形（仍会导出；右侧「图层」卡片里「全部显示」）`);
  }

  unlockAll() {
    let n = 0;
    this.content.children.forEach((it) => { if (it.data && it.data.lock) { it.data.lock = false; n++; } });
    if (!n) { this.toast('没有锁定的图形'); return; }
    this.commit(`已解锁 ${n} 个图形`);
  }

  showAll() {
    let n = 0;
    this.content.children.forEach((it) => { if (it.data && it.data.hidden) { it.data.hidden = false; n++; } });
    if (this.hiddenLayers && this.hiddenLayers.size) { n += this.hiddenLayers.size; this.hiddenLayers.clear(); }
    if (!n) { this.toast('没有隐藏的图形'); return; }
    this.commit('已全部显示');
  }

  toggleLayer(mode) {
    this.hiddenLayers = this.hiddenLayers || new Set();
    if (this.hiddenLayers.has(mode)) this.hiddenLayers.delete(mode); else this.hiddenLayers.add(mode);
    for (const it of [...this.sel]) if (!this.selectable(it)) this.sel.delete(it);
    this.refresh();
    this.status(this.hiddenLayers.has(mode) ? `已隐藏「${MODES[mode].name}」图层（只是不显示，仍会导出）` : `已显示「${MODES[mode].name}」图层`);
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
    const one = this.sel.size === 1 ? [...this.sel][0] : null;
    this.smartKinds = this.drawSmart(b, this.sel, this.overlay, one ? this.circleOf(one) : null);
    this.drawArrayPreview();
  }

  hitHandle(pt) {
    const tol = 7 / this.zoom;
    return (this.handles || []).find((h) => h.at.getDistance(pt) <= tol) || null;
  }

  // ================================================================ 工具

  setTool(id) {
    // 功能按钮（对齐 / 运算 / 阵列 / 变换）：不是一种工具，只是在右侧属性面板里跳到并展开对应区块
    const def = TOOLS.find((q) => q.id === id);
    if (def && def.panel) {
      if (this.tool !== 'select' && this.tool !== 'node') this.setTool('select');
      this.revealPanel(def.panel);
      return;
    }
    this.closeOverlap();
    this.finishDrawing();
    if (this.opts.jointPeer && this.opts.jointPeer.pair) this.cancelPairing(true);
    if (this.dimState) this.cancelDim();
    if (id !== 'lib') { this.libArmed = null; this.libDelArm = null; }
    if (id === 'text' && this.tool !== 'text') this.sel.clear();     // 文字工具：放新文字（不是改选中的）
    if (id !== this.tool) this.editJoint = null;
    this.tool = id;
    this.$$('.sk-tools [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === id));
    const t = TOOLS.find((q) => q.id === id);
    this.status(t ? t.tip : '');
    this.canvas.style.cursor = id === 'select' ? 'default' : id === 'trim' ? 'crosshair' : id === 'node' ? 'pointer' : 'crosshair';
    this.$('.sk-measure').classList.add('hidden');
    this.clearMeasure();
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
    this.clearConnHighlight();
    this.closeOverlap();
    this.closeRotateBox();
    this.closeRotLabel();
    this.downView = new this.ps.Point(ev.offsetX, ev.offsetY);
    this.closeRadial();
    // 画直线 / 曲线时按右键 = 结束这条线（和回车、双击一样），不弹菜单也不平移
    if (ev.button === 2 && this.drawing) { this.finishDrawing(); this.drag = null; return; }
    if (ev.button === 1 || ev.button === 2 || this.spacePan) { this.drag = { kind: 'pan', last: this.downView, start: this.downView, right: ev.button === 2 }; return; }
    const pt = e.point;
    if (this.tool === 'select' && !this.hitHandle(pt) && !this.hitItem(pt)) {
      const g = this.hitGuide(pt);
      if (g) { this.dragGuide(g, null); return; }
    }
    if (this.pickArrayPath) {
      this.pickArrayPath = false;
      const res = this.content.hitTest(pt, { stroke: true, fill: false, segments: true, tolerance: 7 / this.zoom, match: () => true });
      const path = res && (res.item.className === 'Path' ? res.item : res.location && res.location.path);
      if (!path) { this.status('没点到线，已取消'); return; }
      this.arrPath = path.clone({ insert: false });
      this.arrPathItem = this.topItem(path);
      this.opts.arrType = 'path';
      this.renderArray();
      this.drawSelection();
      this.status(`阵列路径：长 ${fmt(this.arrPath.length)} mm`);
      return;
    }
    if (this.pickPathFor) {
      const tid = this.pickPathFor;
      this.pickPathFor = null;
      const tx = this.content.children.find((c) => c.data && c.data.id === tid);
      const res = this.content.hitTest(pt, { stroke: true, fill: false, segments: true, tolerance: 7 / this.zoom, match: (h) => this.topItem(h.item) !== tx });
      const path = res && (res.item.className === 'Path' ? res.item : res.location && res.location.path);
      if (!tx || !tx.data.text || !path) { this.status('没点到线，已取消'); return; }
      const pts = [];
      const L = path.length;
      const n = Math.max(2, Math.min(400, Math.ceil(L / 0.5)));
      for (let i = 0; i <= n; i++) { const q = path.getPointAt(L * i / n); pts.push([q.x, q.y]); }
      this.buildText({ ...tx.data.text, path: pts, arc: 0 }, tx).then((it) => { if (it) { this.sel = new Set([it]); this.commit('文字已沿路径排列'); } });
      return;
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
    if (t === 'text') return (this.opts.textKind === 'qr' || this.opts.textKind === 'bar') ? this.placeCode(this.snap(pt)) : this.placeText(this.snap(pt));
    if (t === 'trim') {
      const tm = this.opts.trimMode || 'trim';
      if (tm === 'break') { this.breakAt(pt); return; }
      if (tm === 'erase') { this.drag = { kind: 'erase', changed: this.eraseAt(pt), last: pt }; this.drawBoard(); return; }
      this.drag = { kind: 'trim', changed: false }; this.trimAt(pt); return;
    }
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
    if (t === 'measure') this.measureDown(e, pt);
    if (t === 'dim') this.dimDown(e, pt);
    if (t === 'make') return this.selectDown(e, pt);                       // 造物：画布照常可以选择 / 移动
    if (t === 'lib') {
      const le = this.libArmed && this.libEntry(this.libArmed);
      if (le) { this.libPlace(le, this.snap(pt)); return; }
      return this.selectDown(e, pt);                                       // 没在放图形时，画布照常可以选择（选好再存进我的图库）
    }
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
    if ((d.kind === 'move' || d.kind === 'scale' || d.kind === 'marquee') && !this.dragStarted(d, ev)) return;
    if (d.kind === 'move') {
      if (this.snapGuide) { this.snapGuide.remove(); this.snapGuide = null; }
      const raw = pt.subtract(d.start);
      const target = this.snap(d.anchor.add(raw), { exclude: this.sel, noAlign: true });
      const want = this.smartMove(d, raw, target.subtract(d.anchor));
      const delta = want.subtract(d.moved);
      if (!delta.isZero()) { this.sel.forEach((it) => it.translate(delta)); d.moved = d.moved.add(delta); }
      this.drawSelection();
      this.updateNumeric();
      this.status(`移动 ΔX ${fmt(d.moved.x)}  ΔY ${fmt(d.moved.y)} mm${this.smartKinds && this.smartKinds.length ? '  ·  ' + this.smartKinds.join(' / ') : ''}`);
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
    else if (d.kind === 'erase') {
      const w = Math.max(0.2, Number(this.opts.eraseW) || 2);
      // 沿拖动轨迹每隔半个擦除宽度擦一次（只擦真的点在线上的地方，擦出的缺口两端不会被再擦）
      const n = Math.max(1, Math.ceil(pt.getDistance(d.last) / (w / 2)));
      for (let i = 1; i <= n; i++) if (this.eraseAt(d.last.add(pt.subtract(d.last).multiply(i / n)))) d.changed = true;
      d.last = pt;
      this.eraseHover(pt);
      this.drawBoard();
    }
    else if (d.kind === 'measure') { if (this.dragStarted(d, ev)) this.measureDrag(d, this.snap(pt), ev); }
    else if (d.kind === 'mortise') {
      let p = this.snap(pt);
      if (ev.shiftKey) p = this.constrain45(d.from, p);
      d.to = p;
      if (this.rubber) this.rubber.remove();
      this.rubber = this.mortisePreview(d.from, p);
    }
    // 移动 / 缩放 / 旋转 / 改节点时，木色板面实时跟着走（每帧最多重画一次）
    if (['move', 'scale', 'rotate', 'node'].includes(d.kind) && !this._boardRaf) {
      this._boardRaf = requestAnimationFrame(() => { this._boardRaf = null; if (this.drag) this.drawBoard(); });
    }
  }

  onUp(e) {
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    // 右键单击（没有拖动）：弹出圆形快捷菜单；右键拖动仍是平移画布
    if (d.kind === 'pan' && d.right && d.last.getDistance(d.start) < 4) {
      if (!this.drawing) {                              // 右键点在没选中的图形上：先选中它（和 Fusion 一样）
        const hit = this.hitItem(this.ps.view.viewToProject(d.start));
        if (hit && !this.sel.has(hit)) { this.sel = new Set([hit]); this.expandGroups(); this.refresh(); }
      }
      this.openRadial(d.start);
      return;
    }
    if (d.kind === 'rotate' && !d.moved) {           // 单击手柄：不算一次修改，改为输入角度
      this.undoStack.pop();
      this.askRotate(d.center);
    } else if (d.kind === 'rotate') {                 // 拖完：角度框留在上方，可以直接改成精确值
      this.commit(d.label);
      this.showRotLabel(d.center, -d.applied, true);
    } else if (d.kind === 'move' && !d.live && !this._altCopy) {
      // 单击选中、没有拖动：图形没变，按下时已经刷新过选中状态，不用再提交（200 个图形时省掉一次序列化和整板重画）
    } else if (d.kind === 'move' || d.kind === 'scale' || d.kind === 'rotate' || d.kind === 'node') this.commit(d.label || '已修改');
    else if (d.kind === 'marquee') {
      if (d.box) {
        const r = d.box.bounds;
        d.box.remove();
        const picked = this.content.children.filter((it) => this.selectable(it) && r.contains(it.bounds));
        if (!e.event.shiftKey) this.sel.clear();
        picked.forEach((it) => this.sel.add(it));
        this.expandGroups();
      } else if (d.clickPick) {                       // 单击图形内部 = 选中它
        if (!e.event.shiftKey) this.sel.clear();
        if (e.event.shiftKey && this.sel.has(d.clickPick)) this.groupOf(d.clickPick).forEach((c) => this.sel.delete(c));
        else { this.groupOf(d.clickPick).forEach((c) => this.sel.add(c)); this.keyItem = d.clickPick; }
      } else if (!e.event.shiftKey) this.sel.clear();
      this.refresh(true);
    } else if (d.kind === 'shape') this.shapeFinish(d);
    else if (d.kind === 'penHandle') { /* 点已加入 */ }
    else if (d.kind === 'trim') { if (d.changed) this.commit('已修剪'); }
    else if (d.kind === 'erase') { if (d.changed) this.commit('已擦除'); else this.status('没擦到线：橡皮擦要从线上拖过'); }
    else if (d.kind === 'measure') { if (d.live && d.last) { this.meas.a = null; this.showMeasurePP(d.from, d.last); } }
    else if (d.kind === 'mortise') { if (this.rubber) { this.rubber.remove(); this.rubber = null; } if (d.to) this.placeMortise(d.from, d.to); }
    this.showSnap(null);
  }

  onMove(e) {
    this.showCoords(e.point);
    if (this.tool === 'select' && !this.pickCenter) this.hoverCursor(e.point);
    if (this.tool === 'line' || this.tool === 'pen') this.pathHover(e.point, e.event);
    else if (this.tool === 'trim') { const tm = this.opts.trimMode || 'trim'; if (tm === 'erase') this.eraseHover(e.point); else if (tm === 'break') this.breakHover(e.point); else this.trimHover(e.point); }
    else if (this.tool === 'joint') this.jointHover(e.point);
    else if (this.tool === 'dim') this.dimHover(e.point);
    else if (this.tool === 'mortise' && this.opts.jointPeer && this.opts.jointPeer.type === 'a') {
      if (this.rubber) this.rubber.remove();
      const [f, t2] = this.mortiseEnds(this.snap(e.point));
      this.rubber = this.mortisePreview(f, t2);
    }
    else if (this.tool === 'measure') this.measureHover(e.point, e.event);
    else if (['rect', 'ellipse', 'polygon', 'text'].includes(this.tool)) this.snap(e.point);
  }

  // 选择工具：鼠标移到手柄上换成对应的光标（旋转 = 旋转箭头，边 / 角 = 双向箭头），移到选中的图形上 = 移动
  hoverCursor(pt) {
    const h = this.sel.size ? this.hitHandle(pt) : null;
    let c = 'default';
    if (h && h.kind === 'rotate') c = ROTATE_CURSOR;
    else if (h) {
      // y 向上：paper 的 bottom（b）在屏幕上方
      c = { l: 'ew-resize', r: 'ew-resize', t: 'ns-resize', b: 'ns-resize', bl: 'nwse-resize', tr: 'nwse-resize', br: 'nesw-resize', tl: 'nesw-resize' }[h.key] || 'default';
    } else if (this.sel.size) {
      const it = this.hitItem(pt) || this.hitInside(pt);
      if (it && this.sel.has(it)) c = 'move';
    }
    if (this.canvas.style.cursor !== c) this.canvas.style.cursor = c;
    if (this.hoverRot !== (h && h.kind === 'rotate')) {
      this.hoverRot = !!(h && h.kind === 'rotate');
      if (this.hoverRot) this.status('拖动旋转：向右 = 顺时针，Shift = 15° 一档；单击 = 输入角度');
    }
  }

  showCoords(pt) {
    this.$('.sk-coords').textContent = `X ${fmt(pt.x)}  Y ${fmt(this.dispY(pt.y))} mm`;
  }

  // ---------------------------------------------------------------- 选择工具

  selectDown(e, pt) {
    const h = this.hitHandle(pt);
    if (h && this.sel.size) {
      this.pushUndo();
      const b = this.selBounds();
      if (h.kind === 'rotate') {
        this.drag = { kind: 'rotate', center: b.center, x0: e.event.offsetX, moved: false, applied: 0, label: '已旋转', pushed: true };
      } else {
        // 按「手柄位置 + 鼠标位移」算，鼠标没点在手柄正中也不会一拖就跳
        this.drag = { kind: 'scale', key: h.key, bounds: b, sx: 1, sy: 1, label: '已缩放', grab: h.at.clone(), start: pt, v0: [e.event.offsetX, e.event.offsetY] };
      }
      this.undoStack.pop();   // commit 会自动比较并记录
      return;
    }
    let it = this.hitItem(pt);
    if (!it) {
      const lk = this.hitLocked(pt);
      if (lk) this.status('这个图形已锁定：不能选中、移动、删除。右键空白处 →「全部解锁」，或在右侧「图层」卡片里解锁');
      // 没点在线上：点在图形内部。已选中的图形可以从内部直接拖动；没选中的，单击（不拖）才选中，拖动仍是框选
      const inner = this.hitInside(pt);
      if (inner && this.sel.has(inner)) it = inner;
      else { this.drag = { kind: 'marquee', from: pt, v0: [e.event.offsetX, e.event.offsetY], clickPick: inner }; return; }
    }
    if (it) {
      if (e.event.shiftKey) {
        if (this.sel.has(it)) this.groupOf(it).forEach((c) => this.sel.delete(c)); else { this.groupOf(it).forEach((c) => this.sel.add(c)); this.keyItem = it; }
        this.refresh(true);
        return;
      }
      if (!this.sel.has(it)) { this.sel.clear(); this.groupOf(it).forEach((c) => this.sel.add(c)); this.refresh(true); }
      this.keyItem = it;
      if (e.event.altKey) {   // Alt 拖动 = 复制
        const copies = this.regroup([...this.sel].map((s) => this.cloneItem(s)));
        this.sel = new Set(copies);
        this._altCopy = true;
      } else this._altCopy = false;
      const b = this.selBounds();
      this.drag = { kind: 'move', start: pt, anchor: this.nearestCorner(b, pt), moved: new this.ps.Point(0, 0), label: '已移动',
        box0: b.clone(), targets: this.alignTargets(this.sel), circ: this.sel.size === 1 ? this.circleOf([...this.sel][0]) : null,
        v0: [e.event.offsetX, e.event.offsetY] };
      return;
    }
  }

  // 点在哪个闭合图形内部：取面积最小的那个（板里的孔优先于板）
  hitInside(pt) {
    let best = null; let area = Infinity;
    this.content.children.forEach((it) => {
      if (!this.selectable(it) || !it.visible || !it.bounds.contains(pt)) return;
      const ps = this.itemPaths(it).filter((q) => q.closed && q.contains(pt));
      if (!ps.length) return;
      const a = Math.min(...ps.map((q) => Math.abs(q.area) || q.bounds.area));
      if (a < area) { area = a; best = it; }
    });
    return best;
  }

  // 鼠标按下后要先挪动 3 像素才算拖动（手抖的单击不会把图形挪走或吸到网格上）
  dragStarted(d, ev) {
    if (d.live || !d.v0) return true;
    if (Math.hypot(ev.offsetX - d.v0[0], ev.offsetY - d.v0[1]) < 3) return false;
    d.live = true;
    return true;
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
    const p = this.snap(d.grab ? d.grab.add(pt.subtract(d.start)) : pt, { exclude: this.sel });
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

  // 按住旋转手柄左右拖：向右 = 顺时针，每 2 像素 1°（小幅度微调）；按住 Shift 按 15° 一档
  rotateDrag(d, pt, ev) {
    const dx = ev.offsetX - d.x0;
    if (Math.abs(dx) > 3) d.moved = true;
    if (!d.moved) return;
    let a = dx / 2;
    a = ev.shiftKey ? Math.round(a / 15) * 15 : Math.round(a);
    const delta = a - d.applied;
    if (delta) { this.sel.forEach((it) => it.rotate(-delta, d.center)); d.applied = a; }   // 向右拖 = 顺时针
    this.drawSelection();
    this.showRotLabel(d.center, -a, false);
    this.status(`${a >= 0 ? '顺时针' : '逆时针'} ${fmt(Math.abs(a))}°（左右拖动微调；Shift = 15° 一档；松开手柄不拖 = 输入角度）`);
  }

  // ---------------------------------------------------------------- 右键圆形快捷菜单（类似 Fusion 的标记菜单）
  // 有选中图形：常用编辑命令；没选中：常用画图工具。中间 = 重复上一个命令
  radialConfig() {
    let c = null;
    try { c = JSON.parse(localStorage.getItem(RADIAL_KEY) || 'null'); } catch (e) { c = null; }
    const ok = (a) => Array.isArray(a) && a.length === 8;
    return { idle: c && ok(c.idle) ? c.idle : [...RADIAL_DEF.idle], sel: c && ok(c.sel) ? c.sel : [...RADIAL_DEF.sel] };
  }

  saveRadialConfig(c) {
    try { localStorage.setItem(RADIAL_KEY, JSON.stringify(c)); } catch (e) { /* 存不了就只在这次有效 */ }
  }

  radialCmd(id) {
    for (const g of RADIAL_CATALOG) {
      const f = g.items.find((q) => q[0] === id);
      if (f) {
        const [kind, name] = id.split(':');
        const run = kind === 't' ? () => this.setTool(name) : kind === 'p' ? () => this.revealPanel(name)
          : id === 'x:rotate' ? () => { const b = this.selBounds(); if (b) this.askRotate(b.center); } : () => this.act(name);
        return { id, label: f[1], icon: f[2], needSel: !!f[3], run };
      }
    }
    return null;
  }

  // 有选中图形：「选中时」那一组；没选中：「没选中时」那一组。空位不显示
  radialItems() {
    const c = this.radialConfig();
    return (this.sel.size ? c.sel : c.idle).map((id) => (id ? this.radialCmd(id) : null)).filter(Boolean);
  }

  openRadial(viewPt) {
    this.closeRadial();
    const items = this.radialItems();
    const box = document.createElement('div');
    box.className = 'sk-radial';
    const R = 104;
    const n = items.length;
    box.innerHTML = '<div class="sk-radial-ring"></div>' + items.map((it, i) => {
      const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;           // 从正上方开始顺时针
      return `<button class="sk-radial-item" data-i="${i}" ${it.needSel && !this.sel.size ? 'disabled title="先选中图形"' : ''} style="left:${Math.round(Math.cos(a) * R)}px;top:${Math.round(Math.sin(a) * R)}px">` +
        `<span>${it.icon}</span>${it.label}</button>`;
    }).join('') + (this.lastCmd
      ? `<button class="sk-radial-center" data-i="c" title="重复上一个命令">重复<br><b>${this.lastCmd.label}</b></button>`
      : '<button class="sk-radial-center" data-i="c" title="切换到选择工具">选择</button>')
      + '<button class="sk-radial-cfg-btn" data-i="cfg" title="自己挑选这个圆盘里放哪些命令">⚙ 自定义</button>';
    // 靠近画布边缘时往里挪，整个圆盘都能看到
    const W0 = this.canvas.clientWidth; const H0 = this.canvas.clientHeight; const M = 166;   // 圆盘半径 142 + 标尺 20
    box.style.left = `${Math.min(Math.max(viewPt.x, M), Math.max(M, W0 - M))}px`;
    box.style.top = `${Math.min(Math.max(viewPt.y, M), Math.max(M, H0 - M))}px`;
    box.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    box.addEventListener('contextmenu', (ev) => ev.preventDefault());
    box.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => {
      const i = b.dataset.i;
      this.closeRadial();
      if (i === 'c') { if (this.lastCmd) this.lastCmd.run(); else this.setTool('select'); return; }
      if (i === 'cfg') { this.openRadialConfig(this.sel.size ? 'sel' : 'idle'); return; }
      items[Number(i)].run();
    }));
    this.$('.sk-dims').parentNode.appendChild(box);
    this.radialBox = box;
    this.status(this.sel.size ? '快捷菜单：常用编辑命令（Esc 或点别处关闭）' : '快捷菜单：常用画图工具（Esc 或点别处关闭）');
  }

  closeRadial() {
    if (this.radialBox) { this.radialBox.remove(); this.radialBox = null; }
  }

  // 自定义右键快捷菜单：两组（没选中时 / 选中时）各 8 个位置；点位置，再点右边的命令放进去
  openRadialConfig(which) {
    this.closeRadialConfig();
    const cfg = this.radialConfig();
    const st = { which: which || 'idle', slot: 0 };
    const box = document.createElement('div');
    box.className = 'sk-rcfg';
    box.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    box.addEventListener('contextmenu', (ev) => ev.preventDefault());
    const render = () => {
      const list = cfg[st.which];
      const R = 92;
      const ring = list.map((id, i) => {
        const a = -Math.PI / 2 + (i * 2 * Math.PI) / 8;
        const c = id && this.radialCmd(id);
        return `<button class="sk-rcfg-slot${i === st.slot ? ' on' : ''}${c ? '' : ' empty'}" data-slot="${i}" style="left:${125 + Math.round(Math.cos(a) * R)}px;top:${125 + Math.round(Math.sin(a) * R)}px">` +
          (c ? `<span>${c.icon}</span>${c.label}<i data-clear="${i}" title="清空这个位置">×</i>` : '<span>＋</span>空位') + '</button>';
      }).join('');
      const used = new Set(list);
      const cat = RADIAL_CATALOG.map((g) => `<div class="sk-rcfg-g"><h5>${g.g}</h5><div>` + g.items.map(([id, label, icon, ns]) =>
        `<button data-cmd="${id}" class="${used.has(id) ? 'used' : ''}" title="${ns ? '需要先选中图形' : ''}"><span>${icon}</span>${label}</button>`).join('') + '</div></div>').join('');
      box.innerHTML = `<div class="sk-rcfg-card">
        <div class="sk-rcfg-head"><b>自定义右键快捷菜单</b><button data-x="close" title="关闭">✕</button></div>
        <div class="sk-rcfg-tabs"><button data-w="idle" class="${st.which === 'idle' ? 'on' : ''}">没选中图形时</button><button data-w="sel" class="${st.which === 'sel' ? 'on' : ''}">选中图形时</button></div>
        <div class="sk-rcfg-body">
          <div class="sk-rcfg-ring"><div class="sk-rcfg-disc"></div>${ring}<div class="sk-rcfg-center">重复<br>上一个</div></div>
          <div class="sk-rcfg-cat"><p class="sk-small">先点左边圆盘上的一个位置（蓝框），再点下面的命令放进去；× 清空。改完马上生效。</p>${cat}</div>
        </div>
        <div class="sk-rcfg-foot"><button data-x="reset">恢复默认</button><button data-x="close" class="primary">完成</button></div></div>`;
    };
    box.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-clear],[data-slot],[data-cmd],[data-w],[data-x]');
      if (!t) return;
      const list = cfg[st.which];
      if (t.dataset.clear != null) { list[Number(t.dataset.clear)] = ''; st.slot = Number(t.dataset.clear); }
      else if (t.dataset.slot != null) st.slot = Number(t.dataset.slot);
      else if (t.dataset.cmd) {
        const id = t.dataset.cmd;
        const had = list.indexOf(id);
        if (had >= 0 && had !== st.slot) list[had] = list[st.slot];   // 已经在别的位置：两个位置互换
        list[st.slot] = id;
        st.slot = (st.slot + 1) % 8;
      } else if (t.dataset.w) { st.which = t.dataset.w; st.slot = 0; }
      else if (t.dataset.x === 'reset') { cfg[st.which] = [...RADIAL_DEF[st.which]]; this.status('已恢复默认'); }
      else if (t.dataset.x === 'close') { this.closeRadialConfig(); return; }
      this.saveRadialConfig(cfg);
      render();
    });
    render();
    this.$('.sk-dims').parentNode.appendChild(box);
    this.radialCfg = box;
  }

  closeRadialConfig() {
    if (this.radialCfg) { this.radialCfg.remove(); this.radialCfg = null; }
  }

  // 旋转角度标签：拖动时实时显示；松开后变成输入框，改数字回车 = 把这次旋转改成精确角度（正数 = 逆时针）
  showRotLabel(center, ccw, editable) {
    let box = this.rotLabel;
    if (!box) {
      box = document.createElement('div');
      box.className = 'sk-rotlabel';
      box.addEventListener('pointerdown', (ev) => ev.stopPropagation());
      this.$('.sk-dims').parentNode.appendChild(box);
      this.rotLabel = box;
    }
    const b = this.selBounds();
    if (!b) { this.closeRotLabel(); return; }
    const v = this.ps.view;
    const p1 = v.projectToView(b.topLeft); const p2 = v.projectToView(b.bottomRight);
    box.style.left = `${(p1.x + p2.x) / 2}px`;
    box.style.top = `${Math.max(4, Math.min(p1.y, p2.y) - 74)}px`;   // 留出旋转手柄的位置
    const dir = Math.abs(ccw) < 1e-9 ? '' : ccw > 0 ? '逆时针' : '顺时针';
    if (!editable) {
      box.classList.remove('edit');
      box.innerHTML = `<b>${fmt(Math.abs(ccw))}°</b> ${dir}`;
      return;
    }
    this.rotEdit = { center, ccw };
    box.classList.add('edit');
    box.innerHTML = `旋转<input type="number" step="0.1" value="${fmt(ccw)}">°<span class="sk-small">正 = 逆时针，回车生效</span>`;
    const inp = box.querySelector('input');
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Escape') { this.closeRotLabel(); return; }
      if (ev.key !== 'Enter') return;
      const want = Number(inp.value);
      const r = this.rotEdit;
      if (!Number.isFinite(want) || !r || !this.sel.size) return;
      const delta = want - r.ccw;
      if (Math.abs(delta) > 1e-9) {
        this.pushUndo();
        this.sel.forEach((it) => { this.convertTextIfRotated(it); it.rotate(delta, r.center); });
        r.ccw = want;
        this.commit(`已旋转到 ${fmt(Math.abs(want))}° ${want >= 0 ? '逆时针' : '顺时针'}`, true);
      }
      this.showRotLabel(r.center, want, true);
      const again = this.rotLabel && this.rotLabel.querySelector('input');
      if (again) { again.focus(); again.select(); }
    });
  }

  closeRotLabel() {
    if (this.rotLabel) { this.rotLabel.remove(); this.rotLabel = null; }
    this.rotEdit = null;
  }

  // 单击旋转手柄（没有拖动）：弹出小框输入角度
  askRotate(center) {
    this.closeRotateBox();
    const box = document.createElement('div');
    box.className = 'sk-rotbox';
    box.innerHTML = `<label>旋转<input type="number" step="1" value="90"> °</label>
      <div class="sk-rot-quick">${[-90, -45, -15, 15, 45, 90, 180].map((v) => `<button data-v="${v}">${v > 0 ? '+' : ''}${v}°</button>`).join('')}</div>
      <p class="sk-small">正数 = 逆时针（和上方「旋转」框一致）。回车确定，Esc 取消。</p>
      <div class="sk-rot-act"><button data-a="cancel">取消</button><button data-a="ok" class="primary">旋转</button></div>`;
    const v = this.ps.view;
    const b = this.selBounds();
    const p1 = v.projectToView(b.topLeft); const p2 = v.projectToView(b.bottomRight);
    box.style.left = `${Math.max(8, (p1.x + p2.x) / 2 - 110)}px`;
    const top = Math.min(p1.y, p2.y) - 160;
    box.style.top = `${top >= 8 ? top : Math.max(p1.y, p2.y) + 12}px`;   // 上方放不下就放到图形下方，不挡住图形
    box.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    const inp = box.querySelector('input');
    const apply = (deg) => {
      this.closeRotateBox();
      if (!Number.isFinite(deg) || !deg || !this.sel.size) return;
      this.pushUndo();
      this.sel.forEach((it) => { this.convertTextIfRotated(it); it.rotate(deg, center); });
      this.commit(`已旋转 ${deg > 0 ? '逆时针' : '顺时针'} ${fmt(Math.abs(deg))}°`, true);
    };
    box.querySelectorAll('[data-v]').forEach((btn) => btn.addEventListener('click', () => apply(Number(btn.dataset.v))));
    box.querySelector('[data-a=ok]').addEventListener('click', () => apply(Number(inp.value)));
    box.querySelector('[data-a=cancel]').addEventListener('click', () => this.closeRotateBox());
    inp.addEventListener('keydown', (ev) => {
      ev.stopPropagation();
      if (ev.key === 'Enter') apply(Number(inp.value));
      if (ev.key === 'Escape') this.closeRotateBox();
    });
    this.$('.sk-dims').parentNode.appendChild(box);
    this.rotateBox = box;
    setTimeout(() => { inp.focus(); inp.select(); }, 0);
  }

  closeRotateBox() {
    if (this.rotateBox) { this.rotateBox.remove(); this.rotateBox = null; }
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
      const p = this.snap(pt, { exclude: new Set(), extra: [], skipSeg: d.seg });
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
    // 在上一个点上又点了一下（双击结束、手抖重复点）：不加点，避免零长度段
    if (this.drawing.segments.length && p.getDistance(this.drawing.lastSegment.point) < 0.01) {
      if (this.tool === 'pen') this.drag = { kind: 'penHandle', seg: this.drawing.lastSegment };
      return;
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
    if (ev.shiftKey || ev.ctrlKey || ev.metaKey || (this.tool === 'polygon')) { const s = Math.max(Math.abs(w), Math.abs(h)); w = s * Math.sign(w || 1); h = s * Math.sign(h || 1); }
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
    d.ev = { shiftKey: ev.shiftKey, altKey: ev.altKey, ctrlKey: ev.ctrlKey, metaKey: ev.metaKey };
    if (!d.preview) return;
    d.preview.strokeColor = MODES[this.opts.mode].color;
    d.preview.strokeWidth = 1.4;
    d.preview.strokeScaling = false;
    this.overlay.addChild(d.preview);
    const b = d.preview.bounds;
    if (d.smart) d.smart.remove();
    d.smart = new this.ps.Group({ parent: this.overlay });
    const kinds = this.drawSmart(b, null, d.smart, this.circleOf(d.preview));
    this.status((this.tool === 'polygon' ? `半径 ${fmt(p.getDistance(d.from))} mm` : `${fmt(b.width)} × ${fmt(b.height)} mm`) + (kinds.length ? '  ·  ' + kinds.join(' / ') : ''));
  }

  shapeFinish(d) {
    if (!d.preview) return;
    const shape = d.preview;
    if (d.smart) { d.smart.remove(); d.smart = null; }
    shape.remove();
    const it = this.addItem({ mode: this.opts.mode, paths: [] });
    it.remove();
    shape.data = it.data;
    this.content.addChild(shape);
    this.style(shape);
    this.sel.clear();
    this.sel.add(shape);
    this.commit('已添加图形');                 // 和已有图形重叠也不提示（用户要求）；需要合并 / 挖掉时用「运算」
  }

  closeOverlap() {
    if (this.overlapBox) { this.overlapBox.remove(); this.overlapBox = null; }
  }

  // 形状运算按钮：鼠标移上去，下方显示示意图和用法
  initBoolHints() {
    const box = this.$('.sk-boolhint');
    if (!box) return;
    const sq = '<rect x="8" y="10" width="44" height="40"/>';
    const ci = '<circle cx="58" cy="34" r="22"/>';
    const fig = (body, defs = '') => `<svg viewBox="0 0 90 62" class="sk-bool-fig"><defs>${defs}</defs>${body}` +
      `<g fill="none" stroke="#94a3b8" stroke-dasharray="3 2">${sq}${ci}</g></svg>`;
    const W = '#e8cfa8';
    const H = {
      unite: { name: '并集', fig: fig(`<g fill="${W}">${sq}${ci}</g>`),
        text: '两个图形合成<b>一整块</b>，重叠的线消失。<br>用法：只选 1 个 → 和所有与它重叠的图形合并；或按 Shift 选多个再点。<br>例：圆形底座 + 长方形把手 → 一块勺子形的板。' },
      subtract: { name: '差集', fig: fig(`<rect x="8" y="10" width="44" height="40" fill="${W}" mask="url(#skm-sub)"/>` +
          '<circle cx="58" cy="34" r="22" fill="none" stroke="#ef4444" stroke-width="1.5"/>',
        '<mask id="skm-sub"><rect width="90" height="62" fill="#fff"/><circle cx="58" cy="34" r="22" fill="#000"/></mask>'),
        text: '把选中的图形<b>当成刀</b>（红圈），从重叠的图形上切掉这一块，<b>刀本身删除</b>。<br>用法：只选「刀」那个图形，再点差集。<br>例：用圆形在板边切出半圆缺口、开把手孔。' },
      intersect: { name: '交集', fig: fig(`<g clip-path="url(#skm-int)"><circle cx="58" cy="34" r="22" fill="${W}"/></g>`,
        '<clipPath id="skm-int"><rect x="8" y="10" width="44" height="40"/></clipPath>'),
        text: '只<b>保留重叠的部分</b>，其余都去掉。<br>用法：只选 1 个 → 它只留下和其他图形重叠的那块（其他图形不变）。<br>例：把圆形裁成 1/4 圆、做扇形。' },
      exclude: { name: '异或', fig: fig(`<path fill="${W}" fill-rule="evenodd" d="M8 10h44v40H8z M80 34a22 22 0 1 0-44 0a22 22 0 1 0 44 0z"/>`),
        text: '保留各自<b>不重叠的部分</b>，重叠的那块挖空。<br>用法：按 Shift 选中 2 个图形再点。<br>例：两个圆交叉做链环、镂空装饰图案。注意：挖空后可能分成几块。' },
    };
    const idle = '<p class="sk-small">鼠标移到按钮上可以看示意图和用法。</p>';
    box.innerHTML = idle;
    this.$$('[data-bh]').forEach((b) => {
      const show = () => { const h = H[b.dataset.bh]; box.innerHTML = `<div class="sk-bool-card">${h.fig}<div><b>${h.name}</b><p class="sk-small">${h.text}</p></div></div>`; };
      b.addEventListener('mouseenter', show);
      b.addEventListener('focus', show);
      b.addEventListener('mouseleave', () => { box.innerHTML = idle; });
      b.addEventListener('blur', () => { box.innerHTML = idle; });
    });
  }

  // 只选了 1 个图形：和与它交叉的图形做运算
  //   差集：选中的当刀，从重叠的图形上切掉，刀删除；交集：选中的只留重叠部分；并集：和重叠的图形合成一个
  booleanWithOverlaps(op) {
    const it = [...this.sel][0];
    const closed = (c) => this.itemPaths(c).every((p) => p.closed);
    if (!closed(it)) { this.toast('形状运算只能用于闭合图形（可先「闭合路径」）', 'error'); return; }
    const others = this.content.children.filter((c) => c !== it && c.data && c.data.mode && this.selectable(c) && closed(c)
      && c.bounds.intersects(it.bounds) && (it.getIntersections(c).length || c.contains(it.bounds.center) || it.contains(c.bounds.center)));
    if (!others.length) { this.toast('没有和它重叠的图形。要两个图形之间运算，请按 Shift 多选', 'error'); return; }
    const opts = { insert: false };
    let res = it;
    if (op === 'unite') {
      // 合并后沿用板件轮廓（有 pid / outline 的那个）的身份
      const all = [it, ...others];
      const keep = all.find((c) => c.data.pid) || all.find((c) => c.data.role === 'outline') || all.reduce((a, b) => (Math.abs(b.area) > Math.abs(a.area) ? b : a));
      all.forEach((o) => { if (o !== it) res = res.unite(o, opts); });
      res.data = { id: newId(), mode: keep.data.mode, role: keep.data.role, locked: false, text: null, pid: keep.data.pid || null,
                   origin: keep.data.origin ? [...keep.data.origin] : null };
      res.insertAbove(keep);
      all.forEach((o) => o.remove());
      this.style(res);
      this.sel = new Set([res]);
      this.commit(`已合并（并集）：${all.length} 个图形合成一个`);
      return;
    }
    if (op === 'subtract') {
      // 选中的图形当「刀」：从每个和它重叠的图形上切掉重叠部分，刀本身删除
      const fresh = [];
      others.forEach((o) => {
        const r = o.subtract(it, opts);
        if (!r || r.isEmpty()) { o.remove(); return; }
        r.data = { ...o.data, id: newId(), text: null, joints: null, bridges: null, origin: o.data.origin ? [...o.data.origin] : null };
        r.insertAbove(o);
        o.remove();
        this.style(r);
        fresh.push(r);
      });
      it.remove();
      this.sel = new Set(fresh);
      this.commit(`已差集：用选中的图形把 ${others.length} 个重叠的图形切掉一块，选中的图形本身已删除`);
      return;
    }
    others.forEach((o) => { res = res.intersect(o, opts); });
    if (!res || res.isEmpty()) { this.toast('结果为空，没有改动', 'error'); return; }
    res.data = { ...it.data, id: newId(), text: null, joints: null, bridges: null, origin: it.data.origin ? [...it.data.origin] : null };
    res.insertAbove(it);
    it.remove();
    this.style(res);
    this.sel = new Set([res]);
    this.commit('已交集：选中的图形只保留和其他图形重叠的部分（其他图形不变）');
  }

  // ---------------------------------------------------------------- 文字

  textParams(base) {
    const o = this.opts;
    return { text: o.text || '文字', font: o.font, size: o.size, spacing: o.textSpacing || 0, lineHeight: o.lineHeight || 1.25,
      align: o.textAlign || 'center', arc: o.textLayout === 'arc' ? (Number(o.textArc) || 50) : 0, weld: !!o.textWeld,
      bold: !!o.textBold, italic: !!o.textItalic, vertical: !!o.textVertical, ...base };
  }

  async placeText(pt) {
    const t = this.textParams({ x: pt.x, y: pt.y });
    const it = await this.buildText(t);
    if (!it) return;
    this.sel.clear();
    this.sel.add(it);
    this.commit('已添加文字');
    this.setTool('select');
  }

  async buildText(t, replace) {
    const r = await this.api.text_layout({ ...t, path: t.path || null });
    if (r.error) { this.toast(r.error, 'error'); return null; }
    if (r.missing && r.missing.length) this.toast(`字体缺少：${r.missing.join('')}`, 'error');
    if (!r.polys.length) { this.toast('没有可显示的文字', 'error'); return null; }
    const mode = replace ? replace.data.mode : this.opts.mode;
    const dx = t.path ? 0 : t.x;
    const dy = t.path ? 0 : t.y;
    const it = this.addItem({ mode, text: t, paths: r.polys.map((p) => this.polyPath(p.map(([x, y]) => [x + dx, y + dy]), true)),
      group: replace ? replace.data.group : undefined, bridges: replace && replace.data.bridges });
    if (replace) {
      it.data.id = replace.data.id;
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
    this.rubber.strokeColor = '#f97316';
    this.rubber.strokeWidth = 3;
    this.rubber.strokeScaling = false;
    this.overlay.addChild(this.rubber);
  }

  // 找到点击处两个交点之间的那一段
  trimPiece(pt) {
    const tol = 6 / this.zoom;
    const res = this.strokeAt(pt, tol, (h) => { const it = this.topItem(h.item); return it && this.selectable(it) && !it.data.drawing; });
    if (!res || !res.location) return null;
    const path = res.location.path || res.item;
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
    // 闭合路径的起点也可能正好是交点（比如横线穿过圆左右两个节点）：起点 = 终点 = 0，要保留；
    // 开放路径的两端本来就是断点，不算交点
    const r4 = (o) => Math.round(o * 1e4) / 1e4;
    const uniq = path.closed
      ? [...new Set(offs.map((o) => (o > L - 1e-4 || o < 1e-4 ? 0 : r4(o))))].sort((a, b) => a - b)
      : [...new Set(offs.map(r4))].filter((o) => o > 1e-6 && o < L - 1e-6).sort((a, b) => a - b);
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

  // ---------------------------------------------------------------- 打断 / 橡皮擦（C7：修剪工具的另外两种方式）

  // 点击处最近的线：{ path, owner, offset }（要真的点在线上）
  pathAtPoint(pt, tolPx = 6) {
    const res = this.strokeAt(pt, tolPx / this.zoom, (h) => { const it = this.topItem(h.item); return it && this.selectable(it) && !it.data.drawing && it.data.mode !== 'dim'; });
    if (!res || !res.location) return null;
    const path = res.location.path || res.item;
    if (!path || path.className !== 'Path') return null;
    const loc = path.getNearestLocation(pt);
    return { path, owner: this.topItem(path), offset: loc.offset, point: loc.point };
  }

  // 开放路径 split 出来的尾段：独立图形时变成一个新图形（编组、图层跟原来的一样）
  adoptTail(owner, path, tail) {
    if (!tail || owner !== path) return tail;
    const it = this.addItem({ mode: owner.data.mode, group: owner.data.group, paths: [] });
    it.remove();
    tail.remove();
    tail.data = { ...it.data };
    this.content.addChild(tail);
    this.style(tail);
    return tail;
  }

  // 打断：在点击处把线断开。闭合图形变成开放的（起点 = 终点 = 断点）；开放的线断成两个图形
  breakAt(pt) {
    const h = this.pathAtPoint(pt);
    if (!h) { this.status('请点在线上'); return false; }
    const { path, owner } = h;
    const L = path.length;
    // 断点吸附（网格 / 端点 / 中点）：吸附点投影回这条线上，离得不远才用
    const sp = this.snap(pt);
    const sl = path.getNearestLocation(sp);
    if (sl && sl.point.getDistance(sp) < 6 / this.zoom) { h.offset = sl.offset; h.point = sl.point; }
    if (owner.data.text) this.convertText(owner);
    if (path.closed) {
      path.splitAt(h.offset);
      if (owner.data.role === 'outline') owner.data.role = null;
      if (owner.data.joints) owner.data.joints = null;
      this.commit('已打断：闭合图形变成了开放的线（不再是一块板，切出来是一条缝）');
      return true;
    }
    if (h.offset < 1e-3 || h.offset > L - 1e-3) { this.status('点在线的端点上，不用打断'); return false; }
    const tail = path.splitAt(h.offset);
    this.adoptTail(owner, path, tail);
    this.commit(`已打断：分成 ${fmt(h.offset)} mm 和 ${fmt(L - h.offset)} mm 两段`);
    return true;
  }

  // 橡皮擦：以点击处为中心，沿线擦掉「擦除宽度」那么长的一段（不提交，拖动结束时一起提交）
  eraseAt(pt) {
    const h = this.pathAtPoint(pt, 4);
    if (!h) return false;
    const { path, owner } = h;
    const w = Math.max(0.2, Number(this.opts.eraseW) || 2);
    const L = path.length;
    if (owner.data.text) this.convertText(owner);
    if (owner.data.role === 'outline' && path.closed) owner.data.role = null;
    const drop = () => { if (owner === path || owner.children.length <= 1) { owner.remove(); this.sel.delete(owner); } else path.remove(); };
    if (L <= w + 1e-6) { drop(); return true; }
    if (path.closed) {
      path.splitAt((h.offset + w / 2) % L);                   // 打开：起点在擦除段的末端
      const piece = path.splitAt(L - w);                     // 最后 w 长的一段就是要擦掉的
      if (piece) piece.remove();
      if (owner.data.joints) owner.data.joints = null;
      return true;
    }
    const a = h.offset - w / 2, b = h.offset + w / 2;
    if (a <= 1e-6 && b >= L - 1e-6) { drop(); return true; }
    const tail = b < L - 1e-6 ? path.splitAt(b) : null;
    if (a > 1e-6) { const mid = path.splitAt(a); if (mid) mid.remove(); } else { path.remove(); if (owner === path) { this.sel.delete(owner); } }
    if (tail) {
      if (owner === path && a <= 1e-6) {                     // 前段整个擦掉了：尾段直接接替原来的图形
        tail.remove(); tail.data = { ...owner.data }; this.content.addChild(tail); this.style(tail);
      } else this.adoptTail(owner, path, tail);
    }
    return true;
  }

  eraseHover(pt) {
    if (this.rubber) { this.rubber.remove(); this.rubber = null; }
    const w = Math.max(0.2, Number(this.opts.eraseW) || 2);
    this.rubber = new this.ps.Path.Circle({ center: pt, radius: w / 2, parent: this.overlay, strokeColor: '#f97316', strokeWidth: 1.5, strokeScaling: false, dashArray: [3, 2] });
  }

  breakHover(pt) {
    if (this.rubber) { this.rubber.remove(); this.rubber = null; }
    const h = this.pathAtPoint(pt);
    if (!h) return;
    const g = new this.ps.Group({ parent: this.overlay });
    const r = 5 / this.zoom;
    g.addChild(new this.ps.Path.Line({ from: h.point.add([-r, -r]), to: h.point.add([r, r]), strokeColor: '#f97316', strokeWidth: 2, strokeScaling: false }));
    g.addChild(new this.ps.Path.Line({ from: h.point.add([-r, r]), to: h.point.add([r, -r]), strokeColor: '#f97316', strokeWidth: 2, strokeScaling: false }));
    this.rubber = g;
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
    const res = this.strokeAt(pt, tol, (h) => { const it = this.topItem(h.item); return it && this.selectable(it) && it.data.mode === 'cut'; });
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
    const meta = { id: newId(), ...this.jointMeta(this.opts.jointType, iv, depth, a, b, n) };
    let label = `已做成卡榫（${iv.length} 个 A 齿，边长 ${fmt(b.getDistance(a))} mm）`;
    let next = null;
    const peer = this.opts.jointPeer;
    if (this.sheetMode && peer && peer.pair) {          // 画板模式：第二条边 → 和第一条配成一对
      meta.pair = peer.pair;
      if (Math.abs(peer.L - meta.L) > 0.3) label += `  ⚠ 和第一条边（${fmt(peer.L)} mm）不一样长，拼不上`;
      else label = `已配对 ✔ 两条边会在 3D 里拼在一起（${iv.length} 个齿）`;
      this.opts.jointPeer = null; this.opts.jointType = 'a';
    } else if (this.sheetMode && this.opts.pairMode !== false && meta.type === 'a') {
      meta.pair = newId();
      next = { iv: meta.iv, L: meta.L, pair: meta.pair, part: '刚才那条边' };
    }
    e.item.data.joints = [...(e.item.data.joints || []), meta];
    this.commit(label);
    if (next) {
      this.opts.jointPeer = next; this.opts.jointType = 'b';
      this.renderToolOpts();
      this.status(`第一条边做好了（${fmt(meta.L)} mm）。现在点另一块板上要和它拼在一起的边，会自动做成配套的 B 齿；Esc 取消配对`);
    }
  }

  // 配对做了一半就取消（Esc / 换工具）：第一条边去掉配对号，变成「没配对的卡榫边」，不留半个配对
  cancelPairing(quiet) {
    const pair = this.opts.jointPeer && this.opts.jointPeer.pair;
    this.opts.jointPeer = null;
    this.opts.jointType = 'a';
    if (!pair) return;
    let n = 0;
    this.content.children.forEach((it) => (it.data && it.data.joints || []).forEach((j) => { if (j.pair === pair) { delete j.pair; n++; } }));
    if (n === 1) this.commit(quiet ? null : '已取消配对', true);
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
    const partner = joint.pair ? this.partnerOf(joint) : null;
    if (remove) {
      if (partner) delete partner.joint.pair;          // 另一条边变回没配对的卡榫边，不留半个配对
      this.commit(partner ? '已删除卡榫，恢复成直边（配对的另一条边保留，变成没配对的卡榫边）' : '已删除卡榫，恢复成直边');
      return;
    }
    const a = new this.ps.Point(joint.a[0], joint.a[1]);
    const b = new this.ps.Point(joint.b[0], joint.b[1]);
    const iv = this.jointIntervals(b.getDistance(a));
    if (!iv.length) { this.commit('边太短，放不下这样的齿（已恢复成直边）'); return; }
    const depth = this.jointDepth();
    const ia = path.segments.findIndex((s) => s.point.getDistance(a) < 1e-3);
    const { pts, n } = this.jointPoints(a, b, (q) => path.contains(q), this.opts.jointType, iv, depth);
    path.insertSegments(ia + 1, pts.map((q) => new this.ps.Segment(q)));
    // 配对号要留着（原来修改后丢了，配对的另一条边就变成「半个配对」）
    item.data.joints.push({ id: joint.id, ...(joint.pair ? { pair: joint.pair } : {}), ...this.jointMeta(this.opts.jointType, iv, depth, a, b, n) });
    // B3：配对的另一条边跟着改（齿位相同、A / B 互补、齿深一样），和这次修改算同一步撤销
    let linked = '';
    if (partner && ['a', 'b'].includes(this.opts.jointType) && Math.abs(partner.joint.L - b.getDistance(a)) <= 0.3) {
      const other = this.opts.jointType === 'a' ? 'b' : 'a';
      const ok = this.remakeJoint(partner.item, partner.joint, { type: other, iv, depth });
      if (ok) {
        const pj = partner.item.data.joints.find((q) => q.id === partner.joint.id);
        Object.assign(pj, { mode: this.opts.jointMode, count: Number(this.opts.jointCount) || 0, tab: Number(this.opts.jointTab) || 0, gap: Number(this.opts.jointGap) || 0 });
        linked = '，配对的另一条边也跟着改了';
      } else linked = '；配对的另一条边被改动过，没能跟着改（连接清单里会标 ⚠）';
    }
    this.commit(`已修改卡榫（${iv.length} 个 A 齿）${linked}`);
  }

  // 配对的另一条边 { item, joint }
  partnerOf(joint) {
    for (const it of this.content.children) {
      const j = (it.data && it.data.joints || []).find((q) => q.pair === joint.pair && q.id !== joint.id);
      if (j) return { item: it, joint: j };
    }
    return null;
  }

  // 按给定的类型 / 齿区间 / 齿深重做一条卡榫边（编号、配对号、齿数设置都保留）。不提交，调用方统一 commit。
  remakeJoint(item, joint, { type = joint.type, iv = joint.iv, depth = joint.depth } = {}) {
    if (joint.type === 'mortise') return false;
    const path = this.straightenEdge(item, joint);
    if (!path) return false;
    const a = new this.ps.Point(joint.a[0], joint.a[1]);
    const b = new this.ps.Point(joint.b[0], joint.b[1]);
    const ia = path.segments.findIndex((sg) => sg.point.getDistance(a) < 1e-3);
    const { pts, n } = this.jointPoints(a, b, (q) => path.contains(q), type, iv, depth);
    path.insertSegments(ia + 1, pts.map((q) => new this.ps.Segment(q)));
    const k = item.data.joints.findIndex((q) => q.id === joint.id);
    item.data.joints[k] = { ...joint, type, iv: iv.map(([s0, e0]) => [r3(s0), r3(e0)]), k: iv.length, depth, c: [a.x + n.x, a.y + n.y] };
    return true;
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
    const play = Math.max(-0.3, Number(this.opts.jointPlay) || 0);   // 负数 = 过盈（木板可压紧）
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
    // 二维画板里选了另一块板的 A 边（B5）：插槽和它配成一对（同一个配对号），3D 自动拼装就认这一对
    let pair = null;
    let a = null;
    if (peer && peer.sheet) {
      this.content.children.forEach((c) => (c.data && c.data.joints || []).forEach((j) => { if (j.id === peer.id && !j.pair) a = j; }));
      if (a) { pair = newId(); a.pair = pair; }
    }
    const it = this.addItem({ mode: 'cut', paths: r.rects.map((q) => ({ closed: true, segs: q.map((p) => [p.x, p.y, 0, 0, 0, 0]) })),
      joints: [{ id: newId(), ...(pair ? { pair } : {}), ...this.mortiseMeta(r, from, to) }] });
    this.sel = new Set([it]);
    if (pair) {
      this.opts.jointPeer = null;
      const warn = Math.abs(peer.L - r.L) > 0.3 ? `  ⚠ 和 A 边（${fmt(peer.L)} mm）不一样长，拼不上` : '';
      this.commit(`已开插槽并和「${peer.part}」配成一对（${r.rects.length} 个孔）${warn}`);
      this.renderToolOpts();
    } else this.commit(`已开插槽（${r.rects.length} 个孔，长 ${fmt(r.L)} mm）`);
  }

  applyEditMortise(item, joint, remove) {
    if (remove) { item.remove(); this.sel.delete(item); this.commit('已删除插槽'); return; }
    const from = new this.ps.Point(joint.a[0], joint.a[1]);
    const to = new this.ps.Point(joint.b[0], joint.b[1]);
    const r = this.mortiseRects(from, to);
    if (!r || !r.rects.length) { this.status('插槽太短'); this.refresh(); return; }
    const fresh = this.addItem({ mode: 'cut', paths: r.rects.map((q) => ({ closed: true, segs: q.map((p) => [p.x, p.y, 0, 0, 0, 0]) })),
      joints: [{ id: joint.id, ...(joint.pair ? { pair: joint.pair } : {}), ...this.mortiseMeta(r, from, to) }] });   // 配对号要留着
    fresh.data.id = item.data.id;
    fresh.insertAbove(item);
    item.remove();
    this.sel = new Set([fresh]);
    this.commit(`已修改插槽（${r.rects.length} 个孔）`);
  }

  // ---------------------------------------------------------------- 尺寸标注（C3）
  // 一条标注 = 独立图形（mode 'dim'）：paths[0] 尺寸线 A'B'、paths[1] / [2] 从 A、B 出发的引出线、paths[3..] 箭头；
  // data.dim = { ref: { a: {id, path, seg}, b: {...} } | null, off: 引出距离（带符号） }。
  // 数字不是路径（画在 dimLayer 的文字里，导出时后端按几何重算），所以随图形变化时只要重建路径。

  // 鼠标附近的图形节点：{ id, path, seg, point }
  nearNode(pt) {
    const tol = 7 / this.zoom;
    let best = null;
    this.content.children.forEach((it) => {
      if (!it.data || !it.data.mode || it.data.mode === 'dim' || !it.visible) return;
      this.itemPaths(it).forEach((p, pi) => p.segments.forEach((sg, si) => {
        const d = sg.point.getDistance(pt);
        if (d < tol && (!best || d < best.d)) best = { id: it.data.id, path: pi, seg: si, point: sg.point.clone(), d };
      }));
    });
    return best;
  }

  nodePoint(ref) {
    if (!ref) return null;
    const it = this.content.children.find((c) => c.data && c.data.id === ref.id);
    if (!it) return null;
    const p = this.itemPaths(it)[ref.path || 0];
    const sg = p && p.segments[ref.seg];
    return sg ? sg.point.clone() : null;
  }

  // 标注的几何 { a, b, a2, b2, off, n }（从它自己的路径读；引用的图形在的话以图形为准）
  dimGeom(it) {
    const ps = this.itemPaths(it);
    if (ps.length < 3) return null;
    const d = it.data.dim || {};
    const a = this.nodePoint(d.ref && d.ref.a) || ps[1].firstSegment.point.clone();
    const b = this.nodePoint(d.ref && d.ref.b) || ps[2].firstSegment.point.clone();
    const a2 = ps[0].firstSegment.point; const b2 = ps[0].lastSegment.point;
    const u = b.subtract(a);
    if (u.length < 1e-6) return null;
    const n = new this.ps.Point(-u.y, u.x).normalize();
    let off = d.off != null ? d.off : a2.subtract(a).dot(n);
    // 标注自己被拖动了（引用的点没变，但它自己的引出线起点变了）：按尺寸线现在的位置算新的引出距离
    const pa = ps[1].firstSegment.point;
    if (d.a && a.getDistance(new this.ps.Point(d.a[0], d.a[1])) < 1e-6 && pa.getDistance(a) > 1e-6) off = r3(a2.subtract(a).dot(n));
    return { a, b, a2, b2, off, n };
  }

  // 按 A、B、引出距离生成标注的路径（mm）
  dimPaths(a, b, off) {
    const ps = this.ps;
    const u = b.subtract(a);
    const L = u.length;
    if (L < 1e-6) return null;
    const d = u.normalize();
    const n = new ps.Point(-d.y, d.x);
    const a2 = a.add(n.multiply(off)); const b2 = b.add(n.multiply(off));
    const ext = n.multiply(Math.sign(off || 1) * 1.5);                 // 引出线比尺寸线长出 1.5 mm
    const ah = Math.min(2.5, L / 3);                                    // 箭头
    const arrow = (tip, dir) => [tip.subtract(dir.multiply(ah)).add(n.multiply(ah * 0.35)), tip, tip.subtract(dir.multiply(ah)).subtract(n.multiply(ah * 0.35))];
    const P = (pts, closed = false) => ({ closed, segs: pts.map((q) => [q.x, q.y, 0, 0, 0, 0]) });
    return [P([a2, b2]), P([a, a2.add(ext)]), P([b, b2.add(ext)]), P(arrow(a2, d.multiply(-1))), P(arrow(b2, d))];
  }

  makeDimItem(a, b, off, ref) {
    const paths = this.dimPaths(a, b, off);
    if (!paths) return null;
    return this.addItem({ mode: 'dim', paths, dim: { ref: ref || null, off, a: [r3(a.x), r3(a.y)] } });
  }

  // 引用的图形变了：按最新的 A、B 重建标注（在 commit 前跑，所以撤销 / 保存都带着）
  syncDims() {
    if (!this.content) return;
    const key = (paths) => JSON.stringify(paths.map((p) => p.segs.map((q) => [r3(q[0]), r3(q[1])])));
    this.content.children.slice().forEach((it) => {
      if (!it.data || it.data.mode !== 'dim') return;
      const g = this.dimGeom(it);
      if (!g) return;
      const paths = this.dimPaths(g.a, g.b, g.off);
      if (key(this.serializeItem(it).paths) === key(paths)) return;
      const ser = this.serializeItem(it);
      const fresh = this.addItem({ ...ser, paths, dim: { ...(ser.dim || {}), off: g.off, a: [r3(g.a.x), r3(g.a.y)] } });
      fresh.insertAbove(it);
      it.remove();
      if (this.sel.has(it)) { this.sel.delete(it); this.sel.add(fresh); }
    });
  }

  // 数字：画在 dimLayer（不是路径，不导出；后端导出时按几何重算同样的数字）
  drawDimLabels() {
    if (!this.dimLayer) return;
    this.dimLayer.removeChildren();
    this.content.children.forEach((it) => {
      if (!it.data || it.data.mode !== 'dim' || !it.visible) return;
      const g = this.dimGeom(it);
      if (!g) return;
      const L = g.a.getDistance(g.b);
      let ang = g.b2.subtract(g.a2).angle;
      if (ang > 90 || ang <= -90) ang += 180;
      const mid = g.a2.add(g.b2).divide(2);
      const nn = new this.ps.Point({ angle: ang + 90, length: 1 });
      const side = mid.subtract(g.a).dot(nn) >= 0 ? 1 : -1;
      const fs = Math.max(3.5, 11 / (this.zoom || 1));                  // 至少 11 像素高，缩小视图也看得清
      const t = new this.ps.PointText({ parent: this.dimLayer, point: mid, content: fmt(L), fillColor: DIM_COLOR,
        fontFamily: 'sans-serif', fontSize: fs, fontWeight: 'bold', justification: 'center' });
      t.scale(1, -1, t.point);                                            // 画布整体是 y 翻转的，文字先翻回来
      t.position = mid.add(new this.ps.Point(0, side * (t.bounds.height / 2 + 3 / (this.zoom || 1))));   // 放在尺寸线外侧，不压线
      t.rotate(ang, mid);
    });
  }

  dimDown(e, pt) {
    const st = this.dimState || (this.dimState = {});
    if (st.a && st.b) {                                                   // 第三下：放置
      const u = st.b.subtract(st.a).normalize(); const n = new this.ps.Point(-u.y, u.x);
      const off = Math.round(pt.subtract(st.a).dot(n) * 10) / 10 || 8;
      const it = this.makeDimItem(st.a, st.b, off, st.ref);
      const L = st.a.getDistance(st.b);
      this.dimState = null;
      if (this.rubber) { this.rubber.remove(); this.rubber = null; }
      if (it) { this.sel = new Set([it]); this.commit(`已标注 ${fmt(L)} mm（默认不导出；导出时可以勾选「标注一起导出」）`); }
      return;
    }
    const node = this.nearNode(pt);
    if (!st.a) {
      if (!node) {                                                        // 没点到节点：点一条直边 → 直接拿它的两端
        const c = this.pickCurve(pt);
        const owner = c && this.topItem(c.path);
        if (c && c.isStraight() && c.length > 0.5 && owner && owner.data.mode !== 'dim') {
          const pi = this.itemPaths(owner).indexOf(c.path);
          st.a = c.point1.clone(); st.b = c.point2.clone();
          st.ref = { a: { id: owner.data.id, path: pi, seg: c.segment1.index }, b: { id: owner.data.id, path: pi, seg: c.segment2.index } };
          this.status(`边长 ${fmt(c.length)} mm：移动鼠标选引出距离，点一下放置`);
          return;
        }
      }
      st.a = node ? node.point : this.snap(pt);
      st.ref = { a: node ? { id: node.id, path: node.path, seg: node.seg } : null, b: null };
      this.status('再点第二个点（点图形的节点，数字会跟着图形变）');
      return;
    }
    st.b = node ? node.point : this.snap(pt);
    st.ref.b = node ? { id: node.id, path: node.path, seg: node.seg } : null;
    if (!st.ref.a && !st.ref.b) st.ref = null;
    this.status(`${fmt(st.a.getDistance(st.b))} mm：移动鼠标选引出距离，点一下放置`);
  }

  dimHover(pt) {
    if (this.rubber) { this.rubber.remove(); this.rubber = null; }
    const st = this.dimState;
    if (!st || !st.a) {
      const node = this.nearNode(pt);
      if (node) this.rubber = new this.ps.Path.Circle({ center: node.point, radius: 4 / this.zoom, parent: this.overlay, strokeColor: DIM_COLOR, strokeWidth: 1.5, strokeScaling: false });
      return;
    }
    const b = st.b || this.snap(pt);
    let off = 8;
    if (st.b) { const u = st.b.subtract(st.a).normalize(); const n = new this.ps.Point(-u.y, u.x); off = pt.subtract(st.a).dot(n) || 8; }
    const paths = this.dimPaths(st.a, b, off);
    if (!paths) return;
    const g = new this.ps.Group({ parent: this.overlay });
    paths.forEach((p) => new this.ps.Path({ parent: g, segments: p.segs.map((q) => [q[0], q[1]]), strokeColor: DIM_COLOR, strokeWidth: 1, strokeScaling: false, dashArray: st.b ? null : [3, 2] }));
    this.rubber = g;
  }

  cancelDim() {
    this.dimState = null;
    if (this.rubber) { this.rubber.remove(); this.rubber = null; }
  }

  // ---------------------------------------------------------------- 图库（C4）
  // 内置件：web/library/builtin.json（scripts/make_library.py 生成，以 (0,0) 为中心）；
  // 我的图库：项目文件夹/图库/*.seedlaser-shape（后端 lib_list / lib_save / lib_delete）

  async loadLibrary(force) {
    if (!this.libBuiltin) {
      try { const r = await fetch('library/builtin.json'); this.libBuiltin = (await r.json()).items || []; } catch (e) { this.libBuiltin = []; }
    }
    if (force || !this.libMine) {
      try { const r = await this.api.lib_list(); this.libMine = (r && r.items) || []; this.libDir = r && r.dir; } catch (e) { this.libMine = []; }
    }
  }

  libEntry(key) {
    const [kind, id] = [key.slice(0, 1), key.slice(2)];
    if (kind === 'b') return (this.libBuiltin || []).find((x) => x.id === id) || null;
    const m = (this.libMine || []).find((x) => x.file === id);
    return m ? { id: m.file, name: m.name, items: m.items, verified: true } : null;
  }

  // 缩略图：SVG（y 向上的数据 → 翻转），线色 = 图层颜色
  libThumb(items) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    const ds = [];
    items.forEach((it) => it.paths.forEach((p) => {
      const s = p.segs;
      if (!s.length) return;
      let d = `M${s[0][0]} ${s[0][1]}`;
      const n = p.closed ? s.length : s.length - 1;
      for (let i = 0; i < n; i++) {
        const a = s[i], b = s[(i + 1) % s.length];
        d += `C${a[0] + a[4]} ${a[1] + a[5]} ${b[0] + b[2]} ${b[1] + b[3]} ${b[0]} ${b[1]}`;
      }
      if (p.closed) d += 'Z';
      s.forEach((q) => { x0 = Math.min(x0, q[0]); x1 = Math.max(x1, q[0]); y0 = Math.min(y0, q[1]); y1 = Math.max(y1, q[1]); });
      ds.push(`<path d="${d}" stroke="${(MODES[it.mode] || MODES.cut).color}" vector-effect="non-scaling-stroke"/>`);
    }));
    if (!ds.length) return '<svg class="sk-lib-svg"></svg>';
    const w = Math.max(x1 - x0, 1), h = Math.max(y1 - y0, 1), pad = Math.max(w, h) * 0.08;
    return `<svg class="sk-lib-svg" viewBox="${x0 - pad} ${-y1 - pad} ${w + 2 * pad} ${h + 2 * pad}"><g transform="scale(1,-1)" fill="none" stroke-width="1.4">${ds.join('')}</g></svg>`;
  }

  renderLib(box) {
    const tab = this.opts.libTab || 'builtin';
    const key = [tab, this.libBuiltin ? this.libBuiltin.length : -1, this.libMine ? this.libMine.map((x) => x.file).join('|') : '-',
      this.sel.size > 0, this.libArmed || '', this.libDelArm || ''].join('§');
    if (box.dataset.lib === key) return;
    const nameInp = box.querySelector('[data-libname]');
    const keepName = nameInp ? nameInp.value : '';
    box.dataset.lib = key;
    box.classList.remove('hidden');
    if (!this.libBuiltin || !this.libMine) {
      box.innerHTML = '<h4>图库</h4><p class="sk-small">加载中…</p>';
      this.loadLibrary().then(() => { if (this.tool === 'lib') { delete box.dataset.lib; this.renderLib(box); } });
      return;
    }
    const cell = (k, x, extra = '') => `<div class="sk-lib-cell"><button class="sk-lib-item${this.libArmed === k ? ' on' : ''}" data-lib="${escAttr(k)}"
        title="${escAttr(x.name + (x.note ? '\n' + x.note : '') + (x.source ? '\n出处：' + x.source : ''))}">${this.libThumb(x.items)}<span>${escAttr(x.name)}</span>${x.verified === false ? '<em class="sk-lib-warn">未核对</em>' : ''}</button>${extra}</div>`;
    let body = '';
    if (tab === 'builtin') {
      const cats = [];
      this.libBuiltin.forEach((x) => { if (!cats.includes(x.cat)) cats.push(x.cat); });
      body = cats.map((c) => `<div class="sk-lib-cat">${escAttr(c)}</div><div class="sk-lib-grid">${this.libBuiltin.filter((x) => x.cat === c).map((x) => cell('b:' + x.id, x)).join('')}</div>`).join('') +
        '<p class="sk-small">标「未核对」的是按公开资料的常见尺寸画的，元件批次不同会有差别，切之前用卡尺量一下实物。</p>';
    } else {
      const save = this.sel.size
        ? `<div class="sk-row sk-lib-save"><input data-libname type="text" maxlength="60" placeholder="起个名字" value="${escAttr(keepName)}"><button data-libsave class="sk-chip-btn">保存选中的 ${this.sel.size} 个图形</button></div>`
        : '<p class="sk-small">先选中要保存的图形（可以多选），这里会出现「保存」。</p>';
      const list = this.libMine.length
        ? `<div class="sk-lib-grid">${this.libMine.map((x) => cell('m:' + x.file, { name: x.name, items: x.items },
            `<button class="sk-lib-del${this.libDelArm === x.file ? ' arm' : ''}" data-libdel="${escAttr(x.file)}" title="${this.libDelArm === x.file ? '再点一次确认删除' : '删除'}">${this.libDelArm === x.file ? '删除?' : '✕'}</button>`)).join('')}</div>`
        : '<p class="sk-small">还没有自己的图形。</p>';
      body = save + list + `<p class="sk-small">存在「${escAttr(this.libDir || '文稿/SeedLaser/图库')}」，每个图形一个 .seedlaser-shape 文件，可以拷给别人。</p>`;
    }
    box.innerHTML = `<h4>图库</h4><div class="sk-seg">${[['builtin', '内置'], ['mine', '我的']].map(([k, n]) => `<button data-libtab="${k}" class="${tab === k ? 'on' : ''}">${n}</button>`).join('')}</div>
      <p class="sk-small">点一下放到画板中央；放完还可以在画布上单击再放一个（Esc 结束）。</p>${body}`;
    box.querySelectorAll('[data-libtab]').forEach((b) => b.addEventListener('click', () => { this.opts.libTab = b.dataset.libtab; this.libDelArm = null; this.renderLib(box); }));
    box.querySelectorAll('[data-lib]').forEach((b) => b.addEventListener('click', () => {
      const e = this.libEntry(b.dataset.lib);
      if (!e) return;
      this.libArmed = b.dataset.lib;
      this.libPlace(e, null);
    }));
    box.querySelectorAll('[data-libdel]').forEach((b) => b.addEventListener('click', (ev) => {
      ev.stopPropagation();
      const f = b.dataset.libdel;
      if (this.libDelArm !== f) { this.libDelArm = f; this.renderLib(box); return; }
      this.libDelArm = null;
      this.libDelete(f);
    }));
    const sb = box.querySelector('[data-libsave]');
    if (sb) {
      const inp = box.querySelector('[data-libname]');
      const go = () => this.libSave(inp.value.trim());
      sb.addEventListener('click', go);
      inp.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); go(); } ev.stopPropagation(); });
    }
  }

  libDropPoint() {
    const c = this.ps.view.center;
    return new this.ps.Point(Math.round(c.x * 2) / 2, Math.round(c.y * 2) / 2);
  }

  libPlace(entry, at) {
    const c = at || this.libDropPoint();
    const grp = entry.items.length > 1 ? newId() : null;           // 多个图形（比如孔 + 外形）编成一组，一起移动
    const made = entry.items.map((it) => this.addItem({ mode: it.mode, group: grp,
      paths: it.paths.map((p) => ({ closed: p.closed, segs: p.segs.map((s) => [s[0] + c.x, s[1] + c.y, s[2], s[3], s[4], s[5]]) })) }));
    this.sel = new Set(made);
    this.commit(`已放入「${entry.name}」`);
    this.status(`已放入「${entry.name}」：在画布上单击可以再放一个，Esc 结束`);
  }

  async libSave(name) {
    const its = [...this.sel].filter((it) => it.data.mode !== 'dim');
    if (!its.length) { this.toast('先选中要保存的图形', 'error'); return; }
    let b = null;
    its.forEach((it) => { b = b ? b.unite(it.bounds) : it.bounds.clone(); });
    const c = b.center;
    const items = its.map((it) => {
      const s = this.serializeItem(it);
      return { mode: s.mode, paths: s.paths.map((p) => ({ closed: p.closed, segs: p.segs.map((q) => [r3(q[0] - c.x), r3(q[1] - c.y), q[2], q[3], q[4], q[5]]) })) };
    });
    const r = await this.api.lib_save(name || '我的图形', items);
    if (!r || r.error) { this.toast((r && r.error) || '保存失败', 'error'); return; }
    await this.loadLibrary(true);
    this.opts.libTab = 'mine';
    this.status(`已保存到我的图库：「${r.name}」`);
    if (this.tool === 'lib') { const box = this.$('.sk-toolopts'); delete box.dataset.lib; const inp = box.querySelector('[data-libname]'); if (inp) inp.value = ''; this.renderLib(box); }
  }

  async libDelete(file) {
    const r = await this.api.lib_delete(file);
    if (!r || r.error) { this.toast((r && r.error) || '删除失败', 'error'); return; }
    if (this.libArmed === 'm:' + file) this.libArmed = null;
    await this.loadLibrary(true);
    this.status('已从我的图库删除');
    if (this.tool === 'lib') this.renderLib(this.$('.sk-toolopts'));
  }

  // ---------------------------------------------------------------- 一键造物（C5，参考 LaserMaker「一键造物」）
  // 生成的都是普通板件：可以继续改、加孔、改卡榫。直角盒子用画板自己的卡榫（自动配对 → 连接清单 ✓、3D 自动拼装）；
  // 圆角盒子用 Boxes.py 的 RoundedBox（侧壁是活铰链，一条长板弯过圆角）；齿轮按 ISO 53 标准基本齿廓（渐开线）计算。

  makeDefaults() {
    if (!this.opts.make) {
      this.opts.make = { kind: 'box', box: { w: 80, d: 60, h: 50, outer: false, lid: true, finger: 0 },
        rbox: { w: 100, d: 80, h: 50, r: 15, outer: false, top: 'closed' },
        gear: { m: 2, z1: 20, z2: 12, bore: 5, lighten: true, pair: true },
        badge: { shape: 'circle', d: 50, border: true, text: 'SeedLaser', arc: true, mirror: false } };
    }
    return this.opts.make;
  }

  makeSchematic(kind) {
    const s = 'fill="none" stroke="#475569" stroke-width="1.3" stroke-linejoin="round"';
    const acc = 'fill="none" stroke="#2563eb" stroke-width="1.3"';
    if (kind === 'box') return `<svg viewBox="0 0 120 70" class="sk-make-svg"><path ${s} d="M20 25 L60 12 L100 25 L100 58 L60 68 L20 58 Z M20 25 L60 38 L100 25 M60 38 L60 68"/>
      <path ${acc} d="M20 32h4v6h-4M20 44h4v6h-4M56 44h4v6h-4"/><text x="60" y="8" font-size="7" text-anchor="middle" fill="#64748b">指接卡榫 · 自动配对</text></svg>`;
    if (kind === 'rbox') return `<svg viewBox="0 0 120 70" class="sk-make-svg"><rect ${s} x="22" y="14" width="76" height="48" rx="14"/>
      <path ${acc} d="${Array.from({ length: 9 }, (_, i) => `M${30 + i * 7} 22v32`).join('')}"/><text x="60" y="8" font-size="7" text-anchor="middle" fill="#64748b">侧壁是活铰链（一条板弯过圆角）</text></svg>`;
    if (kind === 'gear') return `<svg viewBox="0 0 120 70" class="sk-make-svg"><circle ${s} cx="42" cy="38" r="24" stroke-dasharray="3 2"/><circle ${s} cx="84" cy="38" r="14" stroke-dasharray="3 2"/>
      <circle ${acc} cx="42" cy="38" r="3"/><circle ${acc} cx="84" cy="38" r="3"/><path ${s} d="M42 38H84"/><text x="63" y="35" font-size="6" text-anchor="middle" fill="#64748b">中心距</text>
      <text x="60" y="8" font-size="7" text-anchor="middle" fill="#64748b">分度圆直径 = 模数 × 齿数</text></svg>`;
    return `<svg viewBox="0 0 120 70" class="sk-make-svg"><circle ${s} cx="60" cy="38" r="27"/><circle fill="none" stroke="#dc2626" stroke-width="1" cx="60" cy="38" r="23"/>
      <path fill="none" stroke="#16a34a" stroke-width="1.3" d="M42 33 Q60 18 78 33"/><text x="60" y="8" font-size="7" text-anchor="middle" fill="#64748b">外形切割 · 边框描线 · 文字雕刻</text></svg>`;
  }

  renderMake(box) {
    const M = this.makeDefaults();
    const key = M.kind + '§' + this.sheetMode;
    if (box.dataset.make === key) return;
    box.dataset.make = key;
    box.classList.remove('hidden');
    const t = this.part.thickness || 3;
    const num = (grp, k, label, unit, attrs = 'min="0" step="1"') => `<label>${label}<input data-mk="${grp}.${k}" type="number" ${attrs} value="${M[grp][k]}">${unit ? ` ${unit}` : ''}</label>`;
    const chk = (grp, k, label) => `<label class="sk-check"><input data-mk="${grp}.${k}" type="checkbox" ${M[grp][k] ? 'checked' : ''}>${label}</label>`;
    let body = '';
    if (M.kind === 'box') {
      body = `<div class="sk-row">${num('box', 'w', '长', 'mm')}${num('box', 'd', '宽', 'mm')}</div>
        <div class="sk-row">${num('box', 'h', '高', 'mm')}<label>板厚<input data-mk="thick" type="number" min="0.5" max="30" step="0.1" value="${fmt(t)}"> mm</label></div>
        <div class="sk-row">${num('box', 'finger', '齿宽', 'mm', 'min="0" step="1" placeholder="自动"')}</div>
        <div class="sk-row">${chk('box', 'outer', '尺寸是外部尺寸（含板厚）')}${chk('box', 'lid', '有盖子')}</div>
        <p class="sk-small">生成 ${M.box.lid ? 6 : 5} 块板，所有边自动做成配对的指接卡榫（齿宽 0 = 按板厚自动，约 3 倍板厚）。之后「3D 装配 → 按卡榫自动拼装」就能拼成盒子。</p>`;
    } else if (M.kind === 'rbox') {
      body = `<div class="sk-row">${num('rbox', 'w', '长', 'mm')}${num('rbox', 'd', '宽', 'mm')}</div>
        <div class="sk-row">${num('rbox', 'h', '高', 'mm')}${num('rbox', 'r', '圆角', 'mm')}</div>
        <div class="sk-row"><label>板厚<input data-mk="thick" type="number" min="0.5" max="30" step="0.1" value="${fmt(t)}"> mm</label>
          <label>顶部<select data-mk="rbox.top">${[['closed', '封闭'], ['hole', '开口（环）'], ['lid', '带盖']].map(([v, n]) => `<option value="${v}" ${M.rbox.top === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>
        <div class="sk-row">${chk('rbox', 'outer', '尺寸是外部尺寸（含板厚）')}</div>
        <p class="sk-small">侧壁是一整条带活铰链（密集切缝）的板，切好后弯过圆角插进底板。适合 3 mm 椴木板；亚克力不能弯。3D 里不拼装（弯曲的板没法当平板摆）。</p>`;
    } else if (M.kind === 'gear') {
      body = `<div class="sk-row">${num('gear', 'm', '模数', 'mm', 'min="0.5" step="0.5"')}${num('gear', 'z1', '齿数', '', 'min="6" step="1"')}</div>
        <div class="sk-row">${num('gear', 'bore', '轴孔', 'mm', 'min="0" step="0.5"')}${chk('gear', 'lighten', '减重孔')}</div>
        <div class="sk-row">${chk('gear', 'pair', '再配一个齿轮')}${num('gear', 'z2', '齿数', '', 'min="6" step="1"')}</div>
        <p class="sk-small">压力角 20°，标准渐开线（ISO 53）。分度圆 ${fmt(M.gear.m * M.gear.z1)} mm、齿顶圆 ${fmt(M.gear.m * (M.gear.z1 + 2))} mm${M.gear.pair ? `；中心距 ${fmt(M.gear.m * (M.gear.z1 + M.gear.z2) / 2)} mm（两个轴孔按这个距离打）` : ''}。模数相同的齿轮才能啮合；激光切建议模数 ≥ 1.5。</p>`;
    } else {
      body = `<div class="sk-row"><label>形状<select data-mk="badge.shape">${[['circle', '圆形'], ['square', '方形'], ['shield', '盾牌']].map(([v, n]) => `<option value="${v}" ${M.badge.shape === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>${num('badge', 'd', '大小', 'mm', 'min="10" step="1"')}</div>
        <div class="sk-row"><label>文字<input data-mk="badge.text" type="text" maxlength="40" value="${escAttr(M.badge.text)}"></label></div>
        <div class="sk-row">${chk('badge', 'arc', '文字沿弧形')}${chk('badge', 'border', '边框')}${chk('badge', 'mirror', '镜像（做印章）')}</div>
        <p class="sk-small">外形切割，边框是描线，文字雕刻。做印章要勾「镜像」：印出来才是正的。</p>`;
    }
    const tabs = [['box', '直角盒子'], ['rbox', '圆角盒子'], ['gear', '模数齿轮'], ['badge', '徽章 / 印章']];
    box.innerHTML = `<h4>一键造物</h4><div class="sk-seg sk-make-tabs">${tabs.map(([k, n]) => `<button data-mkind="${k}" class="${M.kind === k ? 'on' : ''}">${n}</button>`).join('')}</div>
      ${this.makeSchematic(M.kind)}${body}
      ${this.sheetMode || M.kind === 'gear' || M.kind === 'badge' ? '' : '<p class="sk-warn">盒子要在自由设计的二维画板里生成（一块板的编辑里放不下多块板）。</p>'}
      <div class="sk-row"><button data-mkgo class="primary sk-make-go">生成</button></div>`;
    box.querySelectorAll('[data-mkind]').forEach((b) => b.addEventListener('click', () => { M.kind = b.dataset.mkind; delete box.dataset.make; this.renderMake(box); }));
    box.querySelectorAll('[data-mk]').forEach((inp) => {
      const upd = () => {
        const k = inp.dataset.mk;
        if (k === 'thick') return;
        const [g, f] = k.split('.');
        M[g][f] = inp.type === 'checkbox' ? inp.checked : inp.type === 'number' ? Number(inp.value) : inp.value;
        if (inp.type === 'checkbox' || inp.tagName === 'SELECT' || g === 'gear') { delete box.dataset.make; this.renderMake(box); }
      };
      inp.addEventListener('change', upd);
      inp.addEventListener('keydown', (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') inp.blur(); });
    });
    box.querySelector('[data-mkgo]').addEventListener('click', () => {
      const th = box.querySelector('[data-mk=thick]');
      if (th) this.makeSetThickness(Number(th.value));
      this.makeGo();
    });
  }

  makeSetThickness(v) {
    v = Math.min(30, Math.max(0.5, Number(v) || 3));
    if (Math.abs(v - (this.part.thickness || 0)) < 1e-9) return;
    this.part.thickness = v;
    if (this.onThickness) this.onThickness(v);
    if (this.renderBoardInfo) this.renderBoardInfo();
  }

  async makeGo() {
    const M = this.makeDefaults();
    try {
      if (M.kind === 'box') return this.makeBox(M.box);
      if (M.kind === 'rbox') return await this.makeRoundedBox(M.rbox);
      if (M.kind === 'gear') return this.makeGears(M.gear);
      return await this.makeBadge(M.badge);
    } catch (e) {
      this.toast(`生成失败：${e && e.message ? e.message : e}`, 'error');
      return null;
    }
  }

  rectSegs(x, y, w, h) { return [[x, y], [x + w, y], [x + w, y + h], [x, y + h]].map(([a, b]) => [r3(a), r3(b), 0, 0, 0, 0]); }

  // 在一条直边（a → b，是路径上相邻的两个节点）上做卡榫；不提交
  edgeJoint(item, a, b, type, iv, depth, pair) {
    const path = this.itemPaths(item)[0];
    const ia = path.segments.findIndex((s) => s.point.getDistance(a) < 1e-3);
    if (ia < 0) return false;
    const nb = path.segments[(ia + 1) % path.segments.length];
    if (nb.point.getDistance(b) > 1e-3) return false;
    const { pts, n } = this.jointPoints(a, b, (q) => path.contains(q), type, iv, depth);
    path.insertSegments(ia + 1, pts.map((q) => new this.ps.Segment(q)));
    item.data.joints = [...(item.data.joints || []), { id: newId(), pair, ...this.jointMeta(type, iv, depth, a, b, n) }];
    return true;
  }

  makeBox(o) {
    if (!this.sheetMode) { this.toast('盒子要在自由设计的二维画板里生成', 'error'); return null; }
    const t = this.part.thickness || 3;
    let W = Number(o.w), D = Number(o.d), H = Number(o.h);
    if (o.outer) { W -= 2 * t; D -= 2 * t; H -= t * (o.lid ? 2 : 1); }
    if (!(W > 4 * t && D > 4 * t && H > 3 * t)) { this.toast(`尺寸太小：内部至少要 ${fmt(4 * t)} × ${fmt(4 * t)} × ${fmt(3 * t)} mm`, 'error'); return null; }
    const f = Number(o.finger) > 0 ? Number(o.finger) : Math.max(2 * t, Math.round(t * 3));
    const saved = { jointMode: this.opts.jointMode, jointTab: this.opts.jointTab, jointGap: this.opts.jointGap, jointDepth: this.opts.jointDepth };
    Object.assign(this.opts, { jointMode: 'width', jointTab: f, jointGap: f, jointDepth: 0 });
    try {
      const gap = 2 * t + 6;
      const P = (name, w, h) => ({ name, w, h });
      const panels = [P('front', W, H), P('right', D, H), P('back', W, H), P('left', D, H), P('bottom', W, D)];
      if (o.lid) panels.push(P('top', W, D));
      // 摆放：上排四面侧板，下排底和盖，整体以视图中心为中心
      const row1 = panels.slice(0, 4), row2 = panels.slice(4);
      const w1 = row1.reduce((s, p) => s + p.w, 0) + gap * 3;
      const w2 = row2.reduce((s, p) => s + p.w, 0) + gap * (row2.length - 1);
      const totalH = H + gap + D;
      const c = this.libDropPoint();
      let x = c.x - w1 / 2;
      const y1 = c.y + totalH / 2 - H;
      row1.forEach((p) => { p.x = x; p.y = y1; x += p.w + gap; });
      x = c.x - w2 / 2;
      row2.forEach((p) => { p.x = x; p.y = y1 - gap - D; x += p.w + gap; });
      const by = {};
      panels.forEach((p) => { p.item = this.addItem({ mode: 'cut', paths: [{ closed: true, segs: this.rectSegs(p.x, p.y, p.w, p.h) }] }); by[p.name] = p; });
      const pt = (x0, y0) => new this.ps.Point(x0, y0);
      const edge = (p, side) => {
        const BL = pt(p.x, p.y), BR = pt(p.x + p.w, p.y), TR = pt(p.x + p.w, p.y + p.h), TL = pt(p.x, p.y + p.h);
        return { bottom: [BL, BR], right: [BR, TR], top: [TR, TL], left: [TL, BL] }[side];
      };
      const pairs = [['front', 'right', 'right', 'left'], ['right', 'right', 'back', 'left'], ['back', 'right', 'left', 'left'], ['left', 'right', 'front', 'left'],
        ['front', 'bottom', 'bottom', 'bottom'], ['back', 'bottom', 'bottom', 'top'], ['right', 'bottom', 'bottom', 'left'], ['left', 'bottom', 'bottom', 'right']];
      if (o.lid) pairs.push(['front', 'top', 'top', 'bottom'], ['back', 'top', 'top', 'top'], ['right', 'top', 'top', 'right'], ['left', 'top', 'top', 'left']);
      // 每块板都按「从盒子外面看」画：底板从下面看，左右和盖板相反（右侧板配底板的左边；已用穷举核对 12 对全部能同时对上）
      // A 边：前 / 后板的四条边、左 / 右板的上下边；B 边：左 / 右板的竖边、底板和盖板的四条边
      const typeOf = (name, side) => (name === 'bottom' || name === 'top' ? 'b' : (name === 'left' || name === 'right') && (side === 'left' || side === 'right') ? 'b' : 'a');
      let ok = 0;
      pairs.forEach(([pa, sa, pb, sb]) => {
        const [a1, b1] = edge(by[pa], sa);
        const [a2, b2] = edge(by[pb], sb);
        const L = a1.getDistance(b1);
        const iv = this.jointIntervals(L);
        const pair = newId();
        if (this.edgeJoint(by[pa].item, a1, b1, typeOf(pa, sa), iv, t, pair) && this.edgeJoint(by[pb].item, a2, b2, typeOf(pb, sb), iv, t, pair)) ok++;
      });
      this.sel = new Set(panels.map((p) => p.item));
      const label = `已生成直角盒子：${panels.length} 块板、${ok} 对卡榫（内部 ${fmt(W)} × ${fmt(D)} × ${fmt(H)} mm，板厚 ${fmt(t)} mm）`;
      this.commit(label);
      this.status(label + '。点「3D 装配 → 按卡榫自动拼装」看效果');
      return { parts: panels.length, pairs: ok };
    } finally {
      Object.assign(this.opts, saved);
    }
  }

  async makeRoundedBox(o) {
    if (!this.sheetMode) { this.toast('盒子要在自由设计的二维画板里生成', 'error'); return null; }
    const t = this.part.thickness || 3;
    const r = await this.api.get_model('RoundedBox', { x: Number(o.w), y: Number(o.d), sh: String(Number(o.h)), radius: Math.round(Number(o.r)),
      outside: !!o.outer, top: o.top, thickness: t, wallpieces: '1', edge_style: 'f', reference: 0 });
    if (!r || r.error || !r.parts) { this.toast((r && r.error) || '圆角盒子生成失败', 'error'); return null; }
    const src = r.parts.filter((p) => p.id !== 'reference');
    const gap = 2 * t + 6;
    const boxes = src.map((p) => { const [x0, y0, x1, y1] = p.bbox || [0, 0, p.w, p.h]; return { p, x0, y0, w: x1 - x0, h: y1 - y0 }; });
    // 摆放：底 / 盖一排，侧壁（长条）在下面一排
    const flat = boxes.filter((b) => b.w < 2.2 * b.h), strips = boxes.filter((b) => b.w >= 2.2 * b.h);
    const c = this.libDropPoint();
    const rows = [flat, strips].filter((rw) => rw.length);
    const rowH = rows.map((rw) => Math.max(...rw.map((b) => b.h)));
    const totalH = rowH.reduce((s, h) => s + h, 0) + gap * (rows.length - 1);
    let y = c.y + totalH / 2;
    const made = [];
    const P = (pts, dx, dy, closed) => ({ closed, segs: pts.map(([x0, y0]) => [r3(x0 + dx), r3(y0 + dy), 0, 0, 0, 0]) });
    rows.forEach((rw, i) => {
      y -= rowH[i];
      const wsum = rw.reduce((s, b) => s + b.w, 0) + gap * (rw.length - 1);
      let x = c.x - wsum / 2;
      rw.forEach((b) => {
        const dx = x - b.x0, dy = y - b.y0;
        made.push(this.addItem({ mode: 'cut', paths: [P(b.p.outer, dx, dy, true)] }));
        (b.p.holes || []).concat(b.p.extra || []).forEach((h) => { if (h.length > 2) made.push(this.addItem({ mode: 'cut', paths: [P(h, dx, dy, true)] })); });
        (b.p.lines || []).forEach((l) => { if (l.length > 1) made.push(this.addItem({ mode: 'cut', paths: [P(l, dx, dy, false)] })); });
        (b.p.etch || []).forEach((h) => { if (h.length > 2) made.push(this.addItem({ mode: 'engrave', paths: [P(h, dx, dy, true)] })); });
        x += b.w + gap;
      });
      y -= gap;
    });
    this.sel = new Set(made);
    const label = `已生成圆角盒子：${src.length} 块板（侧壁带活铰链，圆角 ${fmt(o.r)} mm，板厚 ${fmt(t)} mm）`;
    this.commit(label);
    this.status(label);
    return { parts: src.length };
  }

  // ISO 53 标准基本齿廓：压力角 α = 20°，齿顶高 ha = m，齿根高 hf = 1.25 m；齿廓为基圆渐开线
  //   分度圆 r = m·z/2，基圆 rb = r·cos α，齿顶圆 ra = r + m，齿根圆 rf = r − 1.25 m
  //   分度圆上齿厚 s = π·m/2 → 半齿角 ψ = π / (2z)；半径 ρ 处齿廓偏角 θ(ρ) = ψ + inv α − inv α_ρ，inv x = tan x − x，α_ρ = acos(rb / ρ)
  static gearPoints(m, z, rot = 0) {
    const al = 20 * Math.PI / 180;
    const inv = (x) => Math.tan(x) - x;
    const r = m * z / 2, rb = r * Math.cos(al), ra = r + m, rf = Math.max(r - 1.25 * m, 0.5);
    const psi = Math.PI / (2 * z);
    const th = (rho) => psi + inv(al) - inv(Math.acos(Math.min(1, rb / rho)));
    const r0 = Math.max(rb, rf);
    const N = 8;
    const flank = [];                                           // 从齿根往齿顶：[半径, 偏角]
    if (rf < rb) flank.push([rf, th(rb)]);                       // 基圆以下用径向直线
    for (let i = 0; i <= N; i++) { const rho = r0 + (ra - r0) * i / N; flank.push([rho, th(rho)]); }
    const pts = [];
    const P = (rho, a) => [rho * Math.cos(a), rho * Math.sin(a)];
    const pitch = 2 * Math.PI / z;
    for (let k = 0; k < z; k++) {
      const c = rot + k * pitch;
      flank.forEach(([rho, t]) => pts.push(P(rho, c - t)));              // 右侧齿廓（向上）
      const tipT = th(ra);
      for (let i = 1; i < 4; i++) pts.push(P(ra, c - tipT + 2 * tipT * i / 4));   // 齿顶圆弧
      for (let i = flank.length - 1; i >= 0; i--) pts.push(P(flank[i][0], c + flank[i][1]));   // 左侧齿廓（向下）
      const a0 = c + th(r0), a1 = c + pitch - th(r0);
      for (let i = 1; i < 4; i++) pts.push(P(rf, a0 + (a1 - a0) * i / 4));   // 齿根圆弧
    }
    return { pts, r, ra, rf, rb };
  }

  makeGears(o) {
    const m = Number(o.m), z1 = Math.round(Number(o.z1)), z2 = Math.round(Number(o.z2));
    if (!(m >= 0.5) || !(z1 >= 6) || (o.pair && !(z2 >= 6))) { this.toast('模数至少 0.5，齿数至少 6', 'error'); return null; }
    const c = this.libDropPoint();
    const a = o.pair ? m * (z1 + z2) / 2 : 0;
    const specs = [{ z: z1, x: c.x - a / 2, y: c.y, rot: 0 }];
    if (o.pair) specs.push({ z: z2, x: c.x + a / 2, y: c.y, rot: Math.PI + Math.PI / z2 });   // 第二个齿轮的齿槽对着第一个的齿
    const made = [];
    specs.forEach((s) => {
      const g = SketchEditor.gearPoints(m, s.z, s.rot);
      const grp = newId();
      const outer = this.addItem({ mode: 'cut', group: grp, paths: [{ closed: true, segs: g.pts.map(([x, y]) => [r3(x + s.x), r3(y + s.y), 0, 0, 0, 0]) }] });
      outer.data.gear = { m, z: s.z };
      made.push(outer);
      const circ = (cx, cy, d) => {
        const R = d / 2, K = 0.5522847498 * R;
        return { closed: true, segs: [[cx + R, cy, 0, -K, 0, K], [cx, cy + R, K, 0, -K, 0], [cx - R, cy, 0, K, 0, -K], [cx, cy - R, -K, 0, K, 0]].map((q) => q.map(r3)) };
      };
      const bore = Number(o.bore) || 0;
      if (bore > 0 && bore < 2 * g.rf - 2 * m) made.push(this.addItem({ mode: 'cut', group: grp, paths: [circ(s.x, s.y, bore)] }));
      if (o.lighten) {                                         // 减重孔：轮缘留 2m，轮毂留 max(3, 1.5m)
        const rIn = g.rf - 2 * m, rHub = bore / 2 + Math.max(3, 1.5 * m);
        const n = s.z >= 30 ? 6 : 4;
        const rc = (rIn + rHub) / 2;
        const hr = Math.min((rIn - rHub) / 2 * 0.85, rc * Math.sin(Math.PI / n) * 0.7);
        if (hr >= 2) for (let i = 0; i < n; i++) { const ang = s.rot + Math.PI / n + i * 2 * Math.PI / n; made.push(this.addItem({ mode: 'cut', group: grp, paths: [circ(s.x + rc * Math.cos(ang), s.y + rc * Math.sin(ang), 2 * hr)] })); }
      }
    });
    this.sel = new Set(made);
    const label = `已生成齿轮：模数 ${fmt(m)}、${z1} 齿（分度圆 ${fmt(m * z1)} mm）` + (o.pair ? ` + ${z2} 齿（分度圆 ${fmt(m * z2)} mm），中心距 ${fmt(a)} mm` : '');
    this.commit(label);
    this.status(label);
    return { gears: specs.length, a };
  }

  async makeBadge(o) {
    const D = Number(o.d);
    if (!(D >= 10)) { this.toast('大小至少 10 mm', 'error'); return null; }
    const c = this.libDropPoint();
    const R = D / 2, K = 0.5522847498;
    const shapePath = (inset) => {
      const r = R - inset;
      if (o.shape === 'square') {
        const rr = Math.max(0.5, D * 0.12 - inset * 0.5);
        const q = new this.ps.Path.Rectangle({ point: [c.x - r, c.y - r], size: [2 * r, 2 * r], radius: rr, insert: false });
        return { closed: true, segs: q.segments.map((sg) => [sg.point.x, sg.point.y, sg.handleIn.x, sg.handleIn.y, sg.handleOut.x, sg.handleOut.y].map(r3)) };
      }
      if (o.shape === 'shield') {
        const top = c.y + R * 1.05 - inset, w = r, mid = c.y + R * 0.1, bot = c.y - R * 1.05 + inset * 1.4;
        return { closed: true, segs: [[c.x - w, top, 0, 0, 0, 0], [c.x + w, top, 0, 0, 0, 0], [c.x + w, mid, 0, 0, 0, -R * 0.55],
          [c.x, bot, R * 0.62, R * 0.28, -R * 0.62, R * 0.28], [c.x - w, mid, 0, -R * 0.55, 0, 0]].map((q) => q.map(r3)) };
      }
      const k = K * r;
      return { closed: true, segs: [[c.x + r, c.y, 0, -k, 0, k], [c.x, c.y + r, k, 0, -k, 0], [c.x - r, c.y, 0, k, 0, -k], [c.x, c.y - r, -k, 0, k, 0]].map((q) => q.map(r3)) };
    };
    const made = [];
    const grp = newId();
    made.push(this.addItem({ mode: 'cut', group: grp, paths: [shapePath(0)] }));
    const bw = Math.max(1.5, D * 0.07);
    if (o.border) made.push(this.addItem({ mode: 'score', group: grp, paths: [shapePath(bw)] }));
    const text = String(o.text || '').trim();
    if (text) {
      const inner = R - (o.border ? bw : 0);
      const arc = !!o.arc && o.shape !== 'square';
      const size = arc ? Math.max(2, Math.min(inner * 0.32, (Math.PI * inner * 0.85) / Math.max(2, text.length))) : Math.max(2, Math.min(inner * 0.45, (1.6 * inner) / Math.max(1, text.length) * 1.6));
      const rt = inner - size * 0.75;
      const tp = { text, font: this.opts.font, size, spacing: 0, lineHeight: 1.25, align: 'center', arc: arc ? rt : 0, weld: false,
        x: c.x, y: arc ? c.y + rt : c.y };
      const keepMode = this.opts.mode;
      this.opts.mode = 'engrave';
      const it = await this.buildText(tp);
      this.opts.mode = keepMode;
      if (it) { it.data.group = grp; made.push(it); }
    }
    if (o.mirror) {                                          // 印章：雕刻 / 描线左右镜像（外形对称，不用动）
      made.forEach((it) => { if (it.data.mode !== 'cut') { it.scale(-1, 1, c); if (it.data.text) it.data.text = null; } });
    }
    this.sel = new Set(made);
    const label = `已生成${o.mirror ? '印章（已镜像）' : '徽章'}：${{ circle: '圆形', square: '方形', shield: '盾牌' }[o.shape] || ''} ${fmt(D)} mm`;
    this.commit(label);
    this.status(label);
    return { items: made.length };
  }

  // ---------------------------------------------------------------- 二维码 / 条形码（C6）
  // 文字工具右侧切到「二维码」「条形码」：单击放置（雕刻层）；选中后可以改内容 / 尺寸（重新生成，位置不变）

  codeOpts() {
    const o = this.opts;
    if (!o.code) o.code = { qr: { text: 'https://github.com/makerseed201808/SeedLaser', size: 30 }, bar: { text: 'SeedLaser-01', size: 50, h: 15 } };
    return o.code;
  }

  async buildCode(c, at, replace) {
    const r = await this.api.code_paths(c.kind, c.text, Number(c.size), c.kind === 'bar' ? Number(c.h) || null : null, 'M');
    if (!r || r.error) { this.toast((r && r.error) || '生成失败', 'error'); return null; }
    const it = this.addItem({ mode: replace ? replace.data.mode : 'engrave', code: { kind: c.kind, text: c.text, size: Number(c.size), ...(c.kind === 'bar' ? { h: r.h } : {}) },
      paths: r.polys.map((p) => this.polyPath(p.map(([x, y]) => [x + at.x, y + at.y]), true)), group: replace ? replace.data.group : undefined });
    if (replace) { it.data.id = replace.data.id; it.insertAbove(replace); replace.remove(); }
    return it;
  }

  async placeCode(pt) {
    const kind = this.opts.textKind;
    const c = { kind, ...this.codeOpts()[kind] };
    const it = await this.buildCode(c, pt);
    if (!it) return;
    this.setTool('select');                                  // 先换回选择工具，再提交（状态栏留着「已添加」）
    this.sel = new Set([it]);
    this.commit(kind === 'qr' ? `已添加二维码（${fmt(c.size)} × ${fmt(c.size)} mm）` : `已添加条形码（宽 ${fmt(c.size)} mm）`);
  }

  codeHtml(codeSel) {
    const kind = codeSel ? codeSel.data.code.kind : this.opts.textKind;
    const src = codeSel ? codeSel.data.code : this.codeOpts()[kind];
    const name = kind === 'qr' ? '二维码' : '条形码';
    return `<h4>${codeSel ? '修改' + name : name}</h4>
      <div class="sk-row"><textarea class="sk-wide" rows="2" data-cd="text" placeholder="${kind === 'qr' ? '网址或文字（中文也可以）' : '英文字母、数字、符号'}">${escAttr(src.text)}</textarea></div>
      <div class="sk-row"><label>${kind === 'qr' ? '边长' : '宽度'}<input data-cd="size" type="number" min="5" step="1" value="${fmt(src.size)}"> mm</label>
        ${kind === 'bar' ? `<label>条高<input data-cd="h" type="number" min="3" step="1" value="${fmt(src.h || 15)}"> mm</label>` : ''}</div>
      ${codeSel ? '<div class="sk-row"><button data-cd-apply class="sk-chip-btn">重新生成</button></div>' : ''}
      <p class="sk-small">${kind === 'qr' ? '雕刻在浅色木板上最好扫；每一格至少 0.8 mm（内容越长格子越多），四周留白至少 4 格。' : 'Code 128。每一条至少 0.3 mm 宽，左右留白至少 10 条宽。只能用英文、数字和常见符号。'}
        ${codeSel ? '' : '在板上单击放置。'}</p>`;
  }

  bindCode(box, codeSel) {
    const kind = codeSel ? codeSel.data.code.kind : this.opts.textKind;
    box.querySelectorAll('[data-cd]').forEach((inp) => {
      inp.addEventListener('change', () => {
        if (codeSel) return;                                   // 选中的码：点「重新生成」才改
        const v = inp.dataset.cd === 'text' ? inp.value : Number(inp.value);
        this.codeOpts()[kind][inp.dataset.cd] = v;
      });
      inp.addEventListener('keydown', (ev) => ev.stopPropagation());
    });
    const ap = box.querySelector('[data-cd-apply]');
    if (ap) ap.addEventListener('click', async () => {
      const get = (k) => { const el = box.querySelector(`[data-cd=${k}]`); return el ? el.value : null; };
      const c = { kind, text: get('text'), size: Number(get('size')), h: Number(get('h')) || null };
      const at = codeSel.bounds.center;
      const it = await this.buildCode(c, at, codeSel);
      if (!it) return;
      this.sel = new Set([it]);
      this.commit(`已重新生成${kind === 'qr' ? '二维码' : '条形码'}`);
    });
  }

  // ---------------------------------------------------------------- 改槽宽（C8：导入的图纸换了板厚）
  // 找两种槽：① 轮廓上的 U 形缺口（两条平行的边 + 槽底，槽底长 ≈ 原宽，中间是空的）；② 板里面的长方形孔（短边 ≈ 原宽）。
  // 改宽时两侧各往外移 (新宽 − 原宽) / 2，槽中线不动；别的边不动。只认直线段。

  slotParams() {
    const t = this.part.thickness || 3;
    const from = Number(this.opts.slotFrom) > 0 ? Number(this.opts.slotFrom) : t;
    const to = Number(this.opts.slotTo) > 0 ? Number(this.opts.slotTo) : t;
    const tol = Number(this.opts.slotTol) > 0 ? Number(this.opts.slotTol) : 0.15;
    return { from, to, tol };
  }

  findSlots(items, from, tol) {
    const out = [];
    const straight = (sg) => sg.handleIn.isZero() && sg.handleOut.isZero();
    const others = this.content.children.filter((c) => c.data && c.data.mode === 'cut' && this.itemPaths(c).some((p) => p.closed));
    items.forEach((it) => {
      if (!it.data || it.data.mode !== 'cut') return;
      this.itemPaths(it).forEach((path, pi) => {
        if (!path.closed) return;
        const sg = path.segments;
        const n = sg.length;
        if (n < 4 || !sg.every(straight)) return;
        const P = (i) => sg[((i % n) + n) % n].point;
        // ② 长方形孔：4 个节点、对边平行相等、有一组边长 ≈ 原宽；要在别的闭合切割图形里面（是孔，不是一块细长的板）
        if (n === 4) {
          const e = [0, 1, 2, 3].map((i) => P(i + 1).subtract(P(i)));
          const rect = Math.abs(e[0].dot(e[1])) < 1e-6 * e[0].length * e[1].length + 1e-6 && e[0].add(e[2]).length < 1e-3 && e[1].add(e[3]).length < 1e-3;
          if (rect) {
            const inside = (pi > 0 && it.className === 'CompoundPath') || others.some((o) => o !== it && o.bounds.contains(path.bounds) && this.itemPaths(o).some((q) => q.closed && q !== path && q.contains(path.bounds.center)));
            const short = Math.abs(e[0].length - from) <= tol ? 0 : Math.abs(e[1].length - from) <= tol ? 1 : -1;
            if (inside && short >= 0 && e[1 - short].length > from + tol) {
              out.push({ kind: 'hole', item: it, path: pi, i: short, w: e[short].length, pts: [0, 1, 2, 3].map((i) => P(i).clone()) });
              return;
            }
          }
        }
        // ① U 形缺口：边 e1 = P(i-1)→P(i)、槽底 e2 = P(i)→P(i+1)、e3 = P(i+1)→P(i+2)
        for (let i = 0; i < n; i++) {
          const e1 = P(i).subtract(P(i - 1)), e2 = P(i + 1).subtract(P(i)), e3 = P(i + 2).subtract(P(i + 1));
          const L2 = e2.length;
          if (Math.abs(L2 - from) > tol || e1.length < 0.3 || e3.length < 0.3) continue;
          const u = e2.divide(L2);
          if (Math.abs(e1.normalize().dot(u)) > 0.02 || Math.abs(e3.normalize().dot(u)) > 0.02) continue;     // 两边和槽底垂直
          if (e1.normalize().dot(e3.normalize()) > -0.999) continue;                                         // 两边平行、方向相反
          const q = P(i).add(e2.divide(2)).subtract(e1.normalize().multiply(Math.min(0.2, e1.length / 4)));  // 槽里的一点
          if (path.contains(q)) continue;                                                                    // 中间是材料：是凸齿，不是槽
          out.push({ kind: 'notch', item: it, path: pi, i, w: L2, pts: [P(i - 1).clone(), P(i).clone(), P(i + 1).clone(), P(i + 2).clone()] });
        }
      });
    });
    return out;
  }

  showSlots(list) {
    if (this.slotLayer) this.slotLayer.remove();
    this.slotLayer = new this.ps.Group({ parent: this.overlay });
    list.forEach((s) => this.slotLayer.addChild(new this.ps.Path({ segments: s.pts, closed: s.kind === 'hole', strokeColor: '#f97316', strokeWidth: 3, strokeScaling: false, opacity: 0.85 })));
  }

  slotFind() {
    if (!this.need(1, '先选中要改的图形（可以框选整张图）')) return null;
    const { from, tol } = this.slotParams();
    const list = this.findSlots([...this.sel], from, tol);
    this.showSlots(list);
    const info = this.$('.sk-slot-info');
    const msg = list.length ? `找到 ${list.length} 个宽 ${fmt(from)} mm 的槽（${list.filter((s) => s.kind === 'notch').length} 个缺口、${list.filter((s) => s.kind === 'hole').length} 个孔），已标成橙色`
      : `没找到宽 ${fmt(from)} mm（± ${fmt(tol)}）的槽`;
    if (info) info.textContent = msg;
    this.status(msg);
    return list;
  }

  slotApply() {
    if (!this.need(1, '先选中要改的图形（可以框选整张图）')) return;
    const { from, to, tol } = this.slotParams();
    if (Math.abs(to - from) < 1e-6) { this.toast('新槽宽和原槽宽一样', 'error'); return; }
    const list = this.findSlots([...this.sel], from, tol);
    if (!list.length) { this.slotFind(); return; }
    const d = (to - from) / 2;
    // 先算好每个节点要挪多少（相邻的槽共用节点时累加），再一起挪
    const moves = new Map();
    const add = (it, pi, idx, v) => { const k = `${it.data.id}|${pi}|${idx}`; const m = moves.get(k); moves.set(k, { it, pi, idx, v: m ? m.v.add(v) : v }); };
    list.forEach((s) => {
      const path = this.itemPaths(s.item)[s.path];
      const n = path.segments.length;
      if (s.kind === 'hole') {
        const P = (i) => path.segments[i % 4].point;
        const e = P(s.i + 1).subtract(P(s.i)).normalize();     // 短边方向：长边沿它往外移
        const mid = path.bounds.center;
        [0, 1, 2, 3].forEach((k) => { const side = P(k).subtract(mid).dot(e) >= 0 ? 1 : -1; add(s.item, s.path, k, e.multiply(side * d)); });
      } else {
        const u = s.pts[2].subtract(s.pts[1]).normalize();
        [-1, 0].forEach((k) => add(s.item, s.path, ((s.i + k) % n + n) % n, u.multiply(-d)));
        [1, 2].forEach((k) => add(s.item, s.path, (s.i + k) % n, u.multiply(d)));
      }
    });
    moves.forEach(({ it, pi, idx, v }) => { const sg = this.itemPaths(it)[pi].segments[idx]; sg.point = sg.point.add(v); });
    list.forEach((s) => { if (s.item.data.text) this.convertText(s.item); });
    if (this.slotLayer) { this.slotLayer.remove(); this.slotLayer = null; }
    const info = this.$('.sk-slot-info');
    if (info) info.textContent = '';
    this.commit(`已把 ${list.length} 个槽从 ${fmt(from)} mm 改成 ${fmt(to)} mm`);
  }

  // 连接线段（C9）：选中的开放线，端点重合（≤ 0.05 mm）的接成一条；整条首尾接上时闭合
  joinPaths() {
    const tol = 0.05;
    let its = [...this.sel].filter((it) => it.className === 'Path' && !it.closed && it.segments.length >= 2 && it.data && !it.data.text);
    if (its.length < 2) { this.toast('先选中两条以上首尾相接的开放线', 'error'); return; }
    const n0 = its.length;
    const ends = (p) => [p.firstSegment.point, p.lastSegment.point];
    let merged = true;
    while (merged) {
      merged = false;
      for (let a = 0; a < its.length && !merged; a++) {
        for (let b = 0; b < its.length && !merged; b++) {
          if (a === b) continue;
          const A = its[a], B = its[b];
          const [a0, a1] = ends(A), [b0, b1] = ends(B);
          if (a1.getDistance(b0) <= tol || a1.getDistance(b1) <= tol || a0.getDistance(b0) <= tol || a0.getDistance(b1) <= tol) {
            if (a0.getDistance(b0) <= tol || a1.getDistance(b1) <= tol) B.reverse();
            const [c0] = ends(B);
            if (A.lastSegment.point.getDistance(c0) <= tol) {        // A 尾 → B 头
              const segs = B.segments.slice(1).map((sg) => sg.clone());
              A.lastSegment.handleOut = B.firstSegment.handleOut.clone();
              A.addSegments(segs);
            } else {                                                  // B 尾 → A 头
              const segs = B.segments.slice(0, -1).map((sg) => sg.clone());
              A.firstSegment.handleIn = B.lastSegment.handleIn.clone();
              A.insertSegments(0, segs);
            }
            B.remove();
            this.sel.delete(B);
            its = its.filter((x) => x !== B);
            merged = true;
          }
        }
      }
    }
    let closed = 0;
    its.forEach((p) => {
      if (p.segments.length > 2 && p.firstSegment.point.getDistance(p.lastSegment.point) <= tol) {
        p.firstSegment.handleIn = p.lastSegment.handleIn.clone();
        p.lastSegment.remove();
        p.closed = true;
        closed++;
      }
    });
    if (its.length === n0) { this.toast('没有首尾相接的线（端点要重合，误差 ≤ 0.05 mm）', 'error'); return; }
    this.commit(`已把 ${n0} 条线连成 ${its.length} 条${closed ? `（${closed} 条首尾接上，已闭合）` : ''}`);
  }

  // ---------------------------------------------------------------- 测量

  // 四种方式：pp 点到点（拖动或点两下）/ pl 点到线（垂直距离）/ ll 线到线（平行间距、最近距离、夹角）/ cc 圆（半径直径、圆心距）
  get measMode() { return this.opts.measureMode || 'pp'; }

  clearMeasure() {
    if (this.measureLayer) this.measureLayer.removeChildren();
    this.meas = { a: null, has: false };
    const box = this.$ && this.$('.sk-measure');
    if (box) box.classList.add('hidden');
  }

  measureBox(html) {
    const box = this.$('.sk-measure');
    box.classList.remove('hidden');
    box.innerHTML = html;
    this.meas.text = box.textContent;
    const r = this.$('.sk-meas-result');
    if (r) r.innerHTML = html;
  }

  mDraw() {   // 新建一组测量图形（清掉上一组）
    this.measureLayer.removeChildren();
    return new this.ps.Group({ parent: this.measureLayer });
  }

  mLine(g, a, b, dash) {
    const l = new this.ps.Path.Line({ from: a, to: b, parent: g, strokeColor: MEASURE, strokeWidth: 1.5, strokeScaling: false });
    if (dash) l.dashArray = [4, 3];
    return l;
  }

  mDot(g, p) { new this.ps.Path.Circle({ center: p, radius: 3 / this.zoom, parent: g, fillColor: MEASURE }); }

  mHi(g, curve) {   // 高亮选中的边
    const c = curve.clone ? null : null;
    const path = new this.ps.Path({ segments: [curve.segment1.clone(), curve.segment2.clone()], parent: g,
      strokeColor: MEASURE, strokeWidth: 4, strokeScaling: false, opacity: 0.45 });
    path.firstSegment.handleIn = null; path.lastSegment.handleOut = null;
    return path;
  }

  // 鼠标下的线（返回带 location 的命中结果）。paper.js 在正好点中圆的节点时 stroke 命中会漏掉，
  // 所以没命中时再按节点找一次，换成这条路径上离鼠标最近的位置。水口、修剪、卡榫都用它。
  strokeAt(pt, tol, match) {
    const res = this.content.hitTest(pt, { stroke: true, tolerance: tol, match });
    if (res && res.location) return res;
    const seg = this.content.hitTest(pt, { segments: true, tolerance: tol, match });
    if (seg && seg.segment && seg.segment.path) {
      const path = seg.segment.path;
      return { type: 'stroke', item: seg.item, location: path.getNearestLocation(pt) };
    }
    return res;
  }

  // 鼠标下的一条边（线段 / 弧），任何图层的图形都可以量
  pickCurve(pt) {
    // segments: paper.js 在正好点中圆的节点时，stroke 命中会漏掉，所以节点也算
    const res = this.content.hitTest(pt, { stroke: true, curves: true, segments: true, tolerance: 7 / this.zoom, match: (h) => !!this.topItem(h.item) });
    if (!res) return null;
    if (res.location) return res.location.curve;
    if (res.segment) return res.segment.curve || (res.segment.previous && res.segment.previous.curve) || null;
    return null;
  }

  // 一条边所在的圆：整圆图形直接取；弧线用三点求圆
  circleOfCurve(curve) {
    const it = this.topItem(curve.path);
    const whole = it && this.circleOf(it.className === 'Path' ? it : curve.path);
    if (whole) return whole;
    if (curve.isStraight()) return null;
    const a = curve.getPointAtTime(0); const b = curve.getPointAtTime(0.5); const c = curve.getPointAtTime(1);
    const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
    if (Math.abs(d) < 1e-9) return null;
    const sq = (q) => q.x * q.x + q.y * q.y;
    const cx = (sq(a) * (b.y - c.y) + sq(b) * (c.y - a.y) + sq(c) * (a.y - b.y)) / d;
    const cy = (sq(a) * (c.x - b.x) + sq(b) * (a.x - c.x) + sq(c) * (b.x - a.x)) / d;
    const ctr = new this.ps.Point(cx, cy);
    return { c: ctr, r: ctr.getDistance(a), arc: true };
  }

  // 两条边之间最近的两点（相交时距离为 0）
  curveGap(A, B) {
    const ints = A.getIntersections(B);
    if (ints.length) return { d: 0, p: ints[0].point, q: ints[0].point };
    let best = null;
    const tryAt = (t) => { const p = A.getPointAtTime(t); const q = B.getNearestPoint(p); const d = p.getDistance(q); if (!best || d < best.d) best = { d, p, q, t }; };
    for (let i = 0; i <= 64; i++) tryAt(i / 64);
    for (let k = 0; k < 3; k++) { const t0 = best.t; for (let i = -16; i <= 16; i++) tryAt(Math.min(1, Math.max(0, t0 + i / (64 * Math.pow(16, k + 1))))); }
    [B.getPointAtTime(0), B.getPointAtTime(1)].forEach((q) => { const p = A.getNearestPoint(q); const d = p.getDistance(q); if (d < best.d) best = { d, p, q }; });
    return best;
  }

  measureDown(e, pt) {
    if (!this.meas) this.clearMeasure();
    const m = this.meas; const mode = this.measMode;
    if (mode === 'pp') {
      const p = this.snap(pt);
      if (m.a) { const a = m.a; m.a = null; this.showMeasurePP(a, p); return; }
      m.a = p;
      this.drag = { kind: 'measure', from: p, v0: [e.event.offsetX, e.event.offsetY] };
      this.status('拖到第二个点松开；或松开后再点第二个点');
      return;
    }
    if (mode === 'pl') {
      if (!m.a) { m.a = this.snap(pt); const g = this.mDraw(); this.mDot(g, m.a); this.status('再点一条线（或图形的一条边）'); return; }
      const c = this.pickCurve(pt);
      if (!c) { this.status('没点到线：请点在一条线上'); return; }
      const a = m.a; m.a = null; this.showMeasurePL(a, c);
      return;
    }
    const c = this.pickCurve(pt);
    if (!c) { this.status('没点到线：请点在一条线上'); return; }
    if (mode === 'll') {
      if (!m.a) { m.a = c; const g = this.mDraw(); this.mHi(g, c); this.status('再点第二条线'); return; }
      const a = m.a; m.a = null; this.showMeasureLL(a, c);
      return;
    }
    // cc
    const circ = this.circleOfCurve(c);
    if (!circ) { this.status('这条不是圆或圆弧'); return; }
    if (!m.a) { m.a = circ; this.showMeasureCircle(circ); return; }
    const a = m.a; m.a = null; this.showMeasureCC(a, circ);
  }

  measureHover(pt, ev) {
    const m = this.meas || {}; const mode = this.measMode;
    if (mode === 'pp' || (mode === 'pl' && !m.a)) {
      const p = this.snap(pt);
      if (mode === 'pp' && m.a && !this.drag) this.measureDrag({ from: m.a }, p, ev);
      return;
    }
    this.showSnap(null);
    if (this.mHover) { this.mHover.remove(); this.mHover = null; }
    const c = this.pickCurve(pt);
    if (c) { this.mHover = this.mHi(this.overlay, c); this.mHover.opacity = 0.3; }
  }

  // 拖动 / 第二个点跟着鼠标时的实时显示
  measureDrag(d, p, ev) {
    if (ev && ev.shiftKey) p = this.constrain45(d.from, p);
    d.last = p;
    this.showMeasurePP(d.from, p, true);
  }

  showMeasurePP(a, p, live) {
    const g = this.mDraw();
    this.mLine(g, a, p); this.mDot(g, a); this.mDot(g, p);
    const v = p.subtract(a);
    this.meas.has = !live;
    this.measureBox(`<b>点到点</b> 距离 <b>${fmt(v.length)}</b> mm · ΔX ${fmt(Math.abs(v.x))} · ΔY ${fmt(Math.abs(v.y))} · 角度 ${fmt(((v.angle % 360) + 360) % 360)}°`);
    if (!live) this.status('点到点：完成。再点一下开始新的测量；Esc 清除');
  }

  showMeasurePL(a, c) {
    const g = this.mDraw();
    this.mHi(g, c);
    let q; let ext = false;
    if (c.isStraight()) {
      const p1 = c.point1; const ab = c.point2.subtract(p1);
      const t = a.subtract(p1).dot(ab) / ab.dot(ab);
      q = p1.add(ab.multiply(t));
      if (t < 0 || t > 1) { ext = true; this.mLine(g, t < 0 ? p1 : c.point2, q, true); }
    } else q = c.getNearestPoint(a);
    this.mLine(g, a, q); this.mDot(g, a); this.mDot(g, q);
    this.meas.has = true;
    this.measureBox(`<b>点到线</b> 垂直距离 <b>${fmt(a.getDistance(q))}</b> mm${ext ? '（垂足在线的延长线上）' : ''}`);
    this.status('点到线：完成。再点一个点开始新的测量；Esc 清除');
  }

  showMeasureLL(A, B) {
    const g = this.mDraw();
    this.mHi(g, A); this.mHi(g, B);
    const gap = this.curveGap(A, B);
    let html = '<b>线到线</b> ';
    if (A.isStraight() && B.isStraight()) {
      const u = A.point2.subtract(A.point1); const w = B.point2.subtract(B.point1);
      let ang = Math.abs(u.getDirectedAngle(w)) % 180; if (ang > 90) ang = 180 - ang;
      if (ang < 0.05) {            // 平行：量两条线之间的垂直间距
        const m0 = A.getPointAtTime(0.5); const ab = w; const t = m0.subtract(B.point1).dot(ab) / ab.dot(ab);
        const q = B.point1.add(ab.multiply(t));
        this.mLine(g, m0, q); this.mDot(g, m0); this.mDot(g, q);
        html += `平行，间距 <b>${fmt(m0.getDistance(q))}</b> mm`;
        if (gap.d > m0.getDistance(q) + 0.01) html += ` · 两段最近 ${fmt(gap.d)} mm`;
      } else {
        this.mLine(g, gap.p, gap.q); this.mDot(g, gap.p); this.mDot(g, gap.q);
        html += gap.d < 1e-6 ? '相交' : `最近距离 <b>${fmt(gap.d)}</b> mm`;
        html += ` · 夹角 <b>${fmt(ang)}°</b>（${fmt(180 - ang)}°）`;
      }
    } else {
      this.mLine(g, gap.p, gap.q); this.mDot(g, gap.p); this.mDot(g, gap.q);
      html += gap.d < 1e-6 ? '相交（距离 0）' : `最近距离 <b>${fmt(gap.d)}</b> mm`;
    }
    this.meas.has = true;
    this.measureBox(html);
    this.status('线到线：完成。再点一条线开始新的测量；Esc 清除');
  }

  showMeasureCircle(c) {
    const g = this.mDraw();
    new this.ps.Path.Circle({ center: c.c, radius: c.r, parent: g, strokeColor: MEASURE, strokeWidth: 3, opacity: 0.45, strokeScaling: false });
    this.mDot(g, c.c);
    this.mLine(g, c.c, c.c.add(new this.ps.Point(c.r, 0)), true);
    this.meas.has = true;
    this.measureBox(`<b>${c.arc ? '圆弧' : '圆'}</b> 半径 <b>${fmt(c.r)}</b> mm · 直径 <b>${fmt(c.r * 2)}</b> mm · 圆心 (${fmt(c.c.x)}, ${fmt(c.c.y)})`);
    this.status('再点另一个圆量圆心距；或换个圆重新量；Esc 清除');
  }

  showMeasureCC(a, b) {
    const g = this.mDraw();
    [a, b].forEach((c) => { new this.ps.Path.Circle({ center: c.c, radius: c.r, parent: g, strokeColor: MEASURE, strokeWidth: 3, opacity: 0.45, strokeScaling: false }); this.mDot(g, c.c); });
    this.mLine(g, a.c, b.c);
    const d = a.c.getDistance(b.c);
    const edge = d - a.r - b.r;
    this.meas.has = true;
    this.measureBox(`<b>两个圆</b> 圆心距 <b>${fmt(d)}</b> mm · ${edge >= 0 ? `边缘间隙 <b>${fmt(edge)}</b> mm` : d + Math.min(a.r, b.r) <= Math.max(a.r, b.r) ? '一个在另一个里面' : '两圆相交'} · 半径 ${fmt(a.r)} / ${fmt(b.r)}`);
    this.status('两个圆：完成。再点一个圆开始新的测量；Esc 清除');
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
    if (RADIAL_REPEAT[a]) this.lastCmd = { label: RADIAL_REPEAT[a], run: () => this.act(a) };
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
      keys: () => this.showKeys(), tour: () => this.startTour(),
      mirCopyH: () => this.mirrorCopy(true), mirCopyV: () => this.mirrorCopy(false),
      autoLayout: () => this.autoLayout(),
      slotFind: () => this.slotFind(), slotApply: () => this.slotApply(), joinPaths: () => this.joinPaths(),
      lock: () => this.lockSel(true), hide: () => this.hideSel(), unlockAll: () => this.unlockAll(), showAll: () => this.showAll(),
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
      const min = seg.path.closed ? 3 : 2;      // 闭合图形至少 3 个节点，开放线至少 2 个
      if (seg.path.segments.length > min) { seg.remove(); this.commit('已删除节点'); return; }
      this.toast(seg.path.closed ? '闭合图形至少要 3 个节点，不能再删了（要删整个图形请用选择工具）' : '线至少要 2 个节点，不能再删了', 'error');
      return;
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
    if (this.sel.size === 1 && op !== 'exclude') { this.booleanWithOverlaps(op); return; }
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
    // 结果为空（比如两个图形根本不重叠时求交集）：原图形都保留，只提示。原来会把选中的图形全删掉
    if (!res || res.isEmpty() || Math.abs(res.area) < 1e-9) {
      this.toast(op === 'intersect' ? '选中的图形没有重叠的部分，交集为空，图形保持不变'
        : op === 'subtract' ? '相减后什么都不剩（被完全盖住了），图形保持不变；要删掉请直接删除' : '运算结果为空，图形保持不变', 'error');
      return;
    }
    items.forEach((it) => { if (it !== before) it.remove(); });
    res.data = { id: newId(), mode, role: op === 'subtract' || op === 'unite' ? role : null, locked: false, text: null,
      pid: op === 'subtract' || op === 'unite' ? base.data.pid || null : null };
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
    let r;
    try { r = await this.api.sketch_offset(paths, dist, this.opts.offsetJoin); } catch (e) { r = { error: `偏移失败：${e && e.message || e}` }; }
    if (!r || r.error) { this.toast((r && r.error) || '偏移失败', 'error'); return; }
    if (!r.rings.length) { this.toast('偏移后没有剩下图形（内缩太多？）', 'error'); return; }
    const it = this.addItem({ mode, paths: r.rings.map((ring) => this.polyPath(ring, true)) });
    this.sel = new Set([it]);
    this.commit(`已偏移 ${dist} mm`);
    // 新图形闪一下；偏移量在屏幕上太小（几乎和原图形重合）时提示放大
    this.flashItem(it);
    const tiny = Math.abs(dist) * this.zoom < 8;
    this.toast(`已${dist > 0 ? '外扩' : '内缩'} ${fmt(Math.abs(dist))} mm：生成了新图形（已选中），原图形保留${tiny ? '。离原图形很近，放大才看得清' : ''}`);
  }

  // 从 3D 预览定位：id = 板件 pid，或 'loose:<图形 id>'（不在板里的图形）。选中它、移到画面中间、闪一下
  locate(id) {
    let it = null; let label = '';
    if (id.startsWith('loose:')) {
      const iid = id.slice(6);
      it = this.content.children.find((c) => c.data && c.data.id === iid);
      label = '不在板里的图形';
    } else {
      const { parts } = this.recognizeParts();
      const p = parts.find((q) => q.item.data.pid === id);
      if (p) { it = p.item; label = (this.part && this.part.names && this.part.names[id]) || '板件'; }
    }
    if (!it) { this.status('在画板上没找到这个图形'); return; }
    this.setTool('select');
    this.sel = new Set(this.groupOf(it));
    this.keyItem = it;
    const v = this.ps.view;
    const b = it.bounds;
    const vw = v.viewSize.width / this.zoom; const vh = v.viewSize.height / this.zoom;
    const z = b.width > vw * 0.8 || b.height > vh * 0.8
      ? Math.min(v.viewSize.width / (b.width * 1.4 || 1), v.viewSize.height / (b.height * 1.4 || 1)) : this.zoom;
    this.setView(z, b.center.x, b.center.y);
    this.refresh();
    this.flashItem(it);
    this.status(`已定位：${label}（在 3D 预览里点板件或线条，就能在画板上找到它）`);
  }

  flashItem(it) {
    const g = it.clone({ insert: false });
    g.strokeColor = SMART; g.strokeWidth = 4; g.fillColor = null; g.opacity = 0.8; g.strokeScaling = false;
    this.measureLayer.addChild(g);
    let n = 0;
    const tick = () => { n += 1; g.visible = n % 2 === 0; if (n < 6) setTimeout(tick, 180); else g.remove(); };
    setTimeout(tick, 180);
  }

  // ---------------------------------------------------------------- 阵列（矩形 / 直线 / 环形）

  renderArray() {
    const o = this.opts;
    const box = this.$('.sk-array');
    const type = `<div class="sk-seg">${[['line', '直线'], ['circle', '环形'], ['path', '沿路径'], ['grid', '矩形']].map(([k, n]) =>
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
    } else if (o.arrType === 'path') {
      const L = this.arrPath ? this.arrPath.length : 0;
      rows = `<div class="sk-row"><button data-ap="pick">${this.arrPath ? '换一条路径' : '选择路径'}</button>
          <span class="sk-small">${this.arrPath ? `✓ 路径长 ${fmt(L)} mm` : '点按钮后在画布上点一条线'}</span></div>
        <div class="sk-row"><label>数量<input data-a="arrCount" type="number" min="2" step="1" value="${o.arrCount}"></label>
          <label class="sk-check"><input data-a="arrRotate" type="checkbox" ${o.arrRotate ? 'checked' : ''}>跟着路径转向</label></div>
        <p class="sk-small">选中的图形（不含路径本身）沿路径平均排开；闭合路径排一圈，开放路径首尾各放一个。原件会移到第一个位置。</p>`;
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
    box.querySelectorAll('[data-ap=pick]').forEach((b) => b.addEventListener('click', () => {
      this.pickArrayPath = true;
      this.status('在画布上点一条线（或图形的边）作为阵列路径');
    }));
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
  // 沿路径：第 i 份的变换（含第 0 份，原件用它移过去）
  pathMatrices() {
    const P = this.arrPath;
    const items = [...this.sel].filter((it) => it !== this.arrPathItem);
    if (!P || !items.length) return [];
    const o = this.opts;
    const n = Math.max(2, Math.round(o.arrCount));
    const L = P.length;
    let b = null;
    items.forEach((it) => { b = b ? b.unite(it.bounds) : it.bounds.clone(); });
    const c = b.center;
    const out = [];
    for (let i = 0; i < n; i++) {
      const s = P.closed ? L * i / n : L * i / (n - 1);
      const pt = P.getPointAt(Math.min(L, s));
      const tan = P.getTangentAt(Math.min(L, s));
      const m = new this.ps.Matrix().translate(pt.x, pt.y);
      if (o.arrRotate && tan) m.rotate(tan.angle);
      m.translate(-c.x, -c.y);
      out.push(m);
    }
    return out;
  }

  arrayMatrices() {
    const o = this.opts;
    const M = this.ps.Matrix;
    const out = [];
    if (o.arrType === 'path') {
      // 预览 / 复制用的「相对原件当前位置」的变换：Mi · M0⁻¹ 不对，原件也要移动，所以直接返回绝对变换
      return this.pathMatrices();
    }
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
      if (it === this.arrPathItem && this.opts.arrType === 'path') return;
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
    if (this.opts.arrType === 'path') {
      if (!this.arrPath) { this.toast('先点「选择路径」，再在画布上点一条线', 'error'); return; }
      const mats = this.pathMatrices();
      const src = [...this.sel].filter((it) => it !== this.arrPathItem);
      if (!src.length || !mats.length) { this.toast('选中要排列的图形（不含路径本身）', 'error'); return; }
      mats.slice(1).forEach((m) => this.regroup(src.map((it) => { const k = this.cloneItem(it); this.convertTextIfRotated(k); k.transform(m); return k; })));
      src.forEach((it) => { this.convertTextIfRotated(it); it.transform(mats[0]); });
      this.sel = new Set(src);
      this.arrDoneKey = this.arrayKey();
      this.commit(`已沿路径阵列（共 ${mats.length} 份）`);
      return;
    }
    const mats = this.arrayMatrices();
    if (!mats.length) { this.toast('数量至少为 2', 'error'); return; }
    // 间距为 0：复制品和原图形（或彼此）完全叠在一起，激光会把同一条线切两遍
    const seen = new Set(['0,0']);
    const stacked = mats.some((m) => {
      if (Math.abs(m.a - 1) > 1e-9 || Math.abs(m.b) > 1e-9 || Math.abs(m.c) > 1e-9 || Math.abs(m.d - 1) > 1e-9) return false;
      const key = `${Math.round(m.tx * 1e4)},${Math.round(m.ty * 1e4)}`;
      if (seen.has(key)) return true;
      seen.add(key);
      return false;
    });
    if (stacked) { this.toast('间距为 0：复制出来的图形会和原图形叠在一起（激光会重复切同一条线），请把间距改大一些', 'error'); return; }
    if (mats.length * this.sel.size > 2000) { this.toast('复制太多了（超过 2000 份）', 'error'); return; }
    const src = [...this.sel];
    let n = 0;
    mats.forEach((m) => this.regroup(src.map((it) => { const k = this.cloneItem(it); this.convertTextIfRotated(k); k.transform(m); n++; return k; })));
    // 只保留原来选中的对象（复制品不选中），并且不再显示同样的预览
    this.sel = new Set(src);
    this.arrDoneKey = this.arrayKey();
    const name = { grid: '矩形', line: '直线', circle: '环形', path: '沿路径' }[this.opts.arrType];
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
    if (doc.getElementsByTagName('parsererror').length || svg.nodeName.toLowerCase() !== 'svg') throw new Error('这不是有效的 SVG 文件（打不开）');
    const g = ps.project.importSVG(new XMLSerializer().serializeToString(svg), { insert: false, expandShapes: true });
    if (!g) throw new Error('这不是有效的 SVG 文件（打不开）');
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

  // 显示坐标（和激光机台面一致）：材料左上角 = (0, 0)，X 往右、Y 往下。
  // 内部数据仍然是 y 向上（左下角为 0），只在标尺、X / Y 输入、坐标显示时换算。
  originTopY() {
    if (this.sheetMode && this.part && this.part.sheet) return Number(this.part.sheet.h) || 0;
    return this.boardBounds().bottom;
  }

  dispY(y) { return this.originTopY() - y; }

  dataY(v) { return this.originTopY() - v; }

  boardBounds() {
    const outline = this.content.children.find((c) => c.data && c.data.role === 'outline');
    return outline ? outline.bounds : new this.ps.Rectangle(0, 0, 100, 100);
  }

  // 矢量导入：缩放、放到板中心、选加工方式
  vectorDialog(name, rawPaths) {
    // 首尾相接的开放线（CAD 里矩形常是 4 条独立的线）先连起来，连成环的就是闭合图形，才能识别成板
    const paths = joinOpenPaths(rawPaths.map((p) => (p.segs ? p : { closed: p.closed, segs: p.pts.map(([x, y]) => [x, y, 0, 0, 0, 0]) })));
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

  // 镜像复制：以整块板的中线为对称轴
  // 镜像复制的对称轴：
  //   选中的是某块板上的孔 / 刻字 / 描线 → 这块板自己的中线（在板上左右 / 上下对称）；
  //   其他（独立图形、整块板）→ 紧贴选中图形的右边线（上下：下边线），画一半镜像一下就是完整的对称形状
  mirrorAxis(horizontal) {
    const items = [...this.sel];
    const b = this.selBounds();
    if (!this.sheetMode) return { c: this.boardBounds().center, why: '以板的中线为对称轴' };
    const { parts } = this.recognizeParts();
    const host = parts.find((p) => items.every((it) => it !== p.item && p.members.includes(it)));
    if (host) {
      const names = (this.part && this.part.names) || {};
      return { c: host.bounds.center, why: `以「${names[host.item.data.pid] || '这块板'}」的${horizontal ? '竖直' : '水平'}中线为对称轴` };
    }
    // paper 的 top = y 小 = 屏幕下方
    return horizontal ? { c: new this.ps.Point(b.right, b.center.y), why: '紧贴在右边' }
      : { c: new this.ps.Point(b.center.x, b.top), why: '紧贴在下边' };
  }

  mirrorCopy(horizontal) {
    if (!this.need(1)) return;
    const { c, why } = this.mirrorAxis(horizontal);
    const copies = this.regroup([...this.sel].map((it) => { const k = this.cloneItem(it); this.convertTextIfRotated(k); return k; }));
    copies.forEach((k) => k.scale(horizontal ? -1 : 1, horizontal ? 1 : -1, c));
    this.sel = new Set([...this.sel, ...copies]);
    this.commit(`已${horizontal ? '左右' : '上下'}镜像复制（${why}）`);
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
    if (r < 0 && !chamfer) {                    // 负半径：以角点为圆心挖一个圆弧缺口（凹进去）
      const R = Math.min(-r, la * 0.49, lb * 0.49);
      const A = P.add(u1.multiply(R)), B = P.add(u2.multiply(R));
      const c = u1.dot(u2);
      const t1 = u2.subtract(u1.multiply(c)).normalize(), t2 = u1.subtract(u2.multiply(c)).normalize();   // 圆弧在两端的切线（朝角里面）
      const k = (4 / 3) * Math.tan(theta / 4) * R;
      seg.point = A;
      seg.handleOut = t1.multiply(k);
      path.insert(i + 1, new this.ps.Segment(B, t2.multiply(k), null));
      return true;
    }
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
    if (r === 0 || (chamfer && r < 0)) { this.toast(chamfer ? '倒角距离要大于 0' : '半径不能是 0（负数 = 挖圆弧缺口）', 'error'); return; }
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
    this.commit(r < 0 ? `已在 ${n} 个角挖圆弧缺口（半径 ${fmt(-r)} mm）` : `已${chamfer ? '倒角' : '圆角'} ${n} 个角（${fmt(r)} mm）`);
  }

  // ================================================================ 快捷键 / 新手引导

  showKeys() {
    const groups = [
      ['工具', [['V', '选择'], ['A', '节点编辑'], ['L', '直线'], ['P', '曲线（钢笔）'], ['R', '矩形'], ['E', '椭圆'], ['G', '多边形 / 星形'],
        ['T', '文字'], ['J', '卡榫'], ['K', '插槽'], ['B', '水口'], ['X', '修剪'], ['M', '测量']]],
      ['编辑', [['Ctrl/⌘ + Z', '撤销'], ['Ctrl/⌘ + Shift + Z', '重做'], ['Ctrl/⌘ + C / V', '复制 / 粘贴'], ['Ctrl/⌘ + D', '原位复制一份'],
        ['Delete', '删除（节点工具下删节点）'], ['Ctrl/⌘ + A', '全选'], ['Ctrl/⌘ + G', '编组'], ['Ctrl/⌘ + Shift + G', '取消编组'], ['Ctrl/⌘ + I', '导入']]],
      ['移动与视图', [['方向键', '移动（按吸附步长）'], ['Shift + 方向键', '移动 10 mm'], ['F', '适合窗口'], ['滚轮', '缩放'],
        ['空格 + 拖动 / 中键 / 右键拖动', '平移画布'], ['右键单击', '圆形快捷菜单（中间 = 重复上一个命令）'], ['从标尺拖出', '参考线（拖回标尺删除）']]],
      ['绘制时', [['Shift', '锁 45° / 正方形 / 正圆 / 等比缩放'], ['Alt', '从中心画 / 拖动复制'], ['右键 / 回车 / 双击', '结束路径'], ['Esc', '取消 / 取消选择']]],
    ];
    const { el } = this.modal(`<h3>快捷键</h3><div class="sk-keys">${groups.map(([t, rows]) => `<div><h4>${t}</h4>${rows.map(([k, d]) =>
      `<div class="sk-key"><kbd>${k}</kbd><span>${d}</span></div>`).join('')}</div>`).join('')}</div>
      <div class="sk-btns sk-right"><button data-m="cancel" class="sk-primary">知道了</button></div>`);
    el.querySelector('.sk-modal-box').classList.add('wide');
  }

  startTour() {
    const steps = [
      { sel: '.sk-tools', title: '① 画图工具', text: '直线、曲线、矩形、圆、文字……点一下就能用，鼠标停在按钮上会显示用法和快捷键。' },
      { sel: '.sk-palette', title: '② 加工方式', text: '黑色 = 切穿，绿色 = 雕刻，红色 = 描线。先选中图形，再点颜色就能改。' },
      { sel: '.sk-numeric', title: '③ 上下文栏', text: '没选中时显示材料、板厚、板件数；选中图形后变成位置、宽高、角度、对齐和复制 / 删除。也可以直接点图上的长度数字修改；单击图形上方的蓝点可以输入旋转角度。' },
      { sel: '.sk-side', title: '④ 属性面板', text: '右侧跟着你选中的内容变：画图时是工具设置；选中图形后出现运算、变换、阵列，选中 2 个以上还有对齐。点区块标题可以折叠。左边下面那组按钮能直接跳到对应区块。' },
      { sel: '.sk-3d', title: '⑤ 3D 实时预览', text: '每改一次，3D 都会更新，并检查和相邻的板会不会撞在一起（红色 = 穿透）。' },
      { sel: '.sk-back', title: '⑥ 完成', text: '画好了点这里回到主界面；修改会自动保存到项目里。' },
    ];
    let i = 0;
    let tour = this.$('.sk-tour');
    if (!tour) { tour = document.createElement('div'); tour.className = 'sk-tour'; this.host.appendChild(tour); }
    const end = () => {
      tour.classList.add('hidden');
      try { localStorage.setItem('seedboxes.skTour', '1'); } catch (e) { /* 忽略 */ }
    };
    const show = () => {
      const st = steps[i];
      const target = this.$(st.sel);
      const hr = this.host.getBoundingClientRect();
      const r = target ? target.getBoundingClientRect() : { left: hr.left + 100, top: hr.top + 100, width: 10, height: 10, right: hr.left + 110, bottom: hr.top + 110 };
      const pad = 4;
      const box = { x: r.left - hr.left - pad, y: r.top - hr.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 };
      const tipW = 300;
      let tx = box.x + box.w + 12; let ty = box.y;
      if (tx + tipW > hr.width - 10) { tx = Math.max(10, box.x - tipW - 12); }
      if (tx < 10 || box.w > hr.width * 0.5) { tx = Math.min(hr.width - tipW - 10, Math.max(10, box.x)); ty = box.y + box.h + 10; }
      if (ty + 150 > hr.height) ty = Math.max(10, box.y - 160);
      tour.innerHTML = `<div class="sk-tour-hole" style="left:${box.x}px;top:${box.y}px;width:${box.w}px;height:${box.h}px"></div>
        <div class="sk-tour-tip" style="left:${tx}px;top:${ty}px;width:${tipW}px"><b>${st.title}</b><p>${st.text}</p>
          <div class="sk-tour-btns"><span>${i + 1} / ${steps.length}</span><button data-t="skip">跳过</button>
          <button data-t="next" class="sk-primary">${i === steps.length - 1 ? '开始画图' : '下一步'}</button></div></div>`;
      tour.classList.remove('hidden');
      tour.querySelector('[data-t=skip]').onclick = end;
      tour.querySelector('[data-t=next]').onclick = () => { i++; if (i >= steps.length) end(); else show(); };
    };
    show();
  }

  // ================================================================ 数值栏

  updateNumeric() {
    const n = this.sel.size;
    this.$$('.sk-top [data-needsel]').forEach((btn) => { btn.disabled = !n; });
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
    // 上下文栏：没选中 = 材料 / 板厚 / 板件数 / 新图形的加工方式；选中 = 数量 + 位置尺寸 + 对齐 + 复制 / 删除
    this.$('.sk-ctx-idle').classList.toggle('hidden', !!b);
    this.$('.sk-ctx-sel').classList.toggle('hidden', !b);
    if (!b) { ['x', 'y', 'w', 'h'].forEach((k) => set(k, '')); set('rot', 0); set('pct', 100); set('dx', 0); set('dy', 0); this.renderCtxData(); return; }
    this.$('.sk-ctx-count').textContent = `选中 ${this.sel.size} 个`;
    this.renderRefBtn();
    const rp = this.refPoint(b);
    set('x', fmt(rp.x)); set('y', fmt(this.dispY(rp.y))); set('w', fmt(b.width)); set('h', fmt(b.height)); set('rot', 0);
    set('pct', 100); set('dx', 0); set('dy', 0);                   // 倍率 / 移动量是「这一次」的，用完回到 100 % / 0
  }

  renderCtxData() {
    const el = this.$('.sk-ctx-data');
    if (!el || !this.part) return;
    const m = MODES[this.opts.mode] || MODES.cut;
    const chip = (k, v) => `<span class="sk-chip"><i>${k}</i><b>${v}</b></span>`;
    let html = '';
    if (this.sheetMode && this.part.sheet) {
      const { parts, loose } = this.recognizeParts();
      html = chip('材料', `${fmt(this.part.sheet.w)} × ${fmt(this.part.sheet.h)} mm`) + chip('板厚', `${fmt(this.part.thickness || 0)} mm`) +
        chip('板件', `${parts.length} 块`) + (loose.length ? `<span class="sk-chip warn" title="不在任何板里的图形不会导出">⚠ ${loose.length} 个图形不在板里</span>` : '') +
        (parts.length ? `<button class="sk-chip sk-chip-btn" data-act="autoLayout" title="把所有板件（连同上面的孔、雕刻、文字）自动排进材料，互不重叠；一步撤销">⊞ 自动排版</button>` : '');
    } else if (this.part.sub) html = `<span class="sk-chip"><b>${escAttr(this.part.sub)}</b></span>`;
    html += chip('图形', `${this.content.children.filter((c) => c.data && c.data.mode && c.data.mode !== 'dim').length} 个`) +
      `<span class="sk-chip" title="新画的图形用这个加工方式（左下角可以换）"><i>新图形</i><b><i class="sk-dot" style="background:${m.color}"></i>${m.name}</b></span>`;
    el.innerHTML = html;
    const al = el.querySelector('[data-act=autoLayout]');
    if (al) al.addEventListener('click', () => this.autoLayout());
  }

  // ---------------------------------------------------------------- 自动排版（C1）
  // 每块板 = 外轮廓 + 它上面的孔 / 雕刻 / 文字（recognizeParts 的 members），按包围盒排进材料；不在板里的图形不动。
  async autoLayout() {
    if (!this.sheetMode || !this.part || !this.part.sheet) return;
    const { parts } = this.recognizeParts();
    if (!parts.length) { this.toast('画板上还没有板件（闭合的切割轮廓）', 'error'); return; }
    const sheet = this.part.sheet;
    const gap = Math.max(0, Number(this.opts.layoutGap) || 3);
    const boxes = parts.map((p) => {
      let b = null;
      p.members.forEach((m) => { b = b ? b.unite(m.bounds) : m.bounds.clone(); });
      return { p, b };
    });
    let r;
    try {
      r = await this.api.nest_rects(boxes.map(({ p, b }) => ({ id: p.item.data.pid, w: b.width, h: b.height })), sheet.w, sheet.h, gap);
    } catch (e) { r = { error: String(e && e.message || e) }; }
    if (!r || r.error) { this.toast((r && r.error) || '排版失败', 'error'); return; }
    const ps = this.ps;
    let moved = 0;
    let extra = 0;
    r.placed.forEach((q) => {
      const bx = boxes.find((x) => x.p.item.data.pid === q.id);
      if (!bx) return;
      const { p, b } = bx;
      const c = b.center;
      if (q.rot) p.members.forEach((m) => { this.convertTextIfRotated(m); m.rotate(90, c); });
      const nb = p.members.reduce((acc, m) => (acc ? acc.unite(m.bounds) : m.bounds.clone()), null);
      // 排版结果的 y 从 0 开始往上堆；用户看到的原点在材料左上角，所以从顶边往下排（数据 y 向上：顶边 = sheet.h）；第 2 张以后的材料排在右边
      const ox = q.sheet * (sheet.w + 20);
      const d = new ps.Point(ox + q.x - nb.left, (sheet.h - q.y - nb.height) - nb.top);
      if (d.length > 1e-6 || q.rot) { p.members.forEach((m) => m.translate(d)); moved++; }
      if (q.sheet > 0) extra++;
    });
    this.sel.clear();
    const big = (r.too_big || []).length;
    let label = `已自动排版 ${moved} 块板（间距 ${fmt(gap)} mm）`;
    if (extra) label += `；材料放不下，${extra} 块排在材料右边（需要第 ${r.sheets} 张材料）`;
    if (big) label += `；${big} 块比材料还大，没有动`;
    this.commit(label);
    this.toast(label, extra || big ? 'error' : 'success');
  }

  // ---------------------------------------------------------------- 对象原点（参考点）
  get refKey() {
    if (!this._refKey) { try { this._refKey = localStorage.getItem('seedboxes.refPoint') || 'tl'; } catch (e) { this._refKey = 'tl'; } }
    return REF_KEYS.includes(this._refKey) ? this._refKey : 'tl';
  }

  set refKey(k) {
    this._refKey = k;
    try { localStorage.setItem('seedboxes.refPoint', k); } catch (e) { /* 只在这次有效 */ }
  }

  // 外框上参考点的坐标（y 向上：屏幕上方 = paper 的 bottom）
  refPoint(b, key = this.refKey) {
    const x = key[1] === 'l' ? b.left : key[1] === 'r' ? b.right : b.center.x;
    const y = key[0] === 't' ? b.bottom : key[0] === 'b' ? b.top : b.center.y;
    return new this.ps.Point(x, y);
  }

  renderRefBtn() {
    const btn = this.$('[data-refbtn]');
    if (!btn) return;
    const k = this.refKey;
    btn.innerHTML = refIcon(k, 20);
    btn.title = `对象原点：${REF_NAMES[k]}（X / Y 是这个点的坐标；改宽高、输入角度时它不动）。点一下换`;
    this.$('.sk-refx').title = `${REF_NAMES[k]}的 X（回车生效）`;
    this.$('.sk-refy').title = `${REF_NAMES[k]}的 Y（回车生效）`;
  }

  toggleRefMenu() {
    if (this.refMenu) { this.closeRefMenu(); return; }
    const btn = this.$('[data-refbtn]');
    const box = document.createElement('div');
    box.className = 'sk-refmenu';
    box.innerHTML = `<div class="sk-refgrid">${REF_KEYS.map((k) => `<button data-ref="${k}" class="${k === this.refKey ? 'on' : ''}" title="${REF_NAMES[k]}">${refIcon(k, 22)}</button>`).join('')}</div>
      <div class="sk-refcap">对象原点：<b>${REF_NAMES[this.refKey]}</b></div>`;
    box.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    box.addEventListener('click', (ev) => {
      const b = ev.target.closest('[data-ref]');
      if (!b) return;
      this.refKey = b.dataset.ref;
      this.closeRefMenu();
      this.renderRefBtn();
      this.updateNumeric();
      this.status(`对象原点：${REF_NAMES[this.refKey]}。X / Y 显示这个点的坐标，改宽高、输入角度时它保持不动`);
    });
    const r = btn.getBoundingClientRect(); const hr = this.host.getBoundingClientRect();
    box.style.left = `${r.left - hr.left}px`;
    box.style.top = `${r.bottom - hr.top + 4}px`;
    this.host.appendChild(box);
    this.refMenu = box;
    btn.classList.add('on');
    this._refClose = (ev) => { if (!box.contains(ev.target) && ev.target !== btn) this.closeRefMenu(); };
    setTimeout(() => document.addEventListener('pointerdown', this._refClose), 0);
  }

  closeRefMenu() {
    if (this.refMenu) { this.refMenu.remove(); this.refMenu = null; }
    if (this._refClose) { document.removeEventListener('pointerdown', this._refClose); this._refClose = null; }
    const btn = this.$ && this.$('[data-refbtn]');
    if (btn) btn.classList.remove('on');
  }

  numericApply(k, val) {
    const v = Number(val);
    if (!this.sel.size || !isFinite(v)) return;
    const b = this.selBounds();
    const rp = this.refPoint(b);
    if (k === 'x') this.sel.forEach((it) => it.translate(new this.ps.Point(v - rp.x, 0)));
    else if (k === 'y') this.sel.forEach((it) => it.translate(new this.ps.Point(0, this.dataY(v) - rp.y)));   // 输入的是显示坐标（Y 往下）
    else if (k === 'w' || k === 'h') {
      if (v <= 0) return;
      // 水平线没有高度、竖直线没有宽度：不能按比例拉到指定尺寸（会除以 0）
      if ((k === 'w' && b.width < 1e-9) || (k === 'h' && b.height < 1e-9)) {
        this.toast(k === 'w' ? '选中的图形没有宽度（竖直线），不能改宽' : '选中的图形没有高度（水平线），不能改高', 'error');
        this.updateNumeric();
        return;
      }
      let sx = k === 'w' ? v / b.width : 1;
      let sy = k === 'h' ? v / b.height : 1;
      if (this.lockRatio) { if (k === 'w') sy = sx; else sx = sy; }
      this.sel.forEach((it) => { this.convertTextIfRotated(it); it.scale(sx, sy, rp); });       // 对象原点不动
    } else if (k === 'pct') {
      if (v <= 0 || Math.abs(v - 100) < 1e-9) { this.updateNumeric(); return; }
      this.sel.forEach((it) => { this.convertTextIfRotated(it); it.scale(v / 100, rp); });
      this.commit(`已缩放到 ${fmt(v)}%`);
      return;
    } else if (k === 'dx' || k === 'dy') {
      if (!v) return;
      const d = k === 'dx' ? new this.ps.Point(v, 0) : new this.ps.Point(0, -v);          // 显示坐标 Y 往下 = 数据 y 减小
      this.sel.forEach((it) => it.translate(d));
      this.commit(`已移动 ${k === 'dx' ? 'ΔX' : 'ΔY'} ${fmt(v)} mm`);
      return;
    } else if (k === 'rot') {
      if (!v) return;
      this.sel.forEach((it) => { this.convertTextIfRotated(it); it.rotate(v, rp); });           // 绕对象原点   // 正数 = 逆时针（数据坐标 y 向上，paper 的正角 = 逆时针）
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
    // 正在输入的框（比如修改文字）还没提交就要被重画：先让它失焦，触发 change 把内容应用上
    const focused = box.querySelector(':focus');
    if (focused && (focused.dataset.o || focused.dataset.cd)) focused.blur();
    const t = this.tool;
    if (t === 'lib') { delete box.dataset.make; this.renderLib(box); return; }
    if (t === 'make') { delete box.dataset.lib; this.renderMake(box); return; }
    delete box.dataset.lib;
    delete box.dataset.make;
    const textSel = this.sel.size === 1 && [...this.sel][0].data.text ? [...this.sel][0] : null;
    const codeSel = this.sel.size === 1 && [...this.sel][0].data.code ? [...this.sel][0] : null;
    const kindSeg = t === 'text' && !textSel && !codeSel ? `<div class="sk-seg sk-textkind">${[['text', '文字'], ['qr', '二维码'], ['bar', '条形码']].map(([k, n]) =>
      `<button data-tk="${k}" class="${(this.opts.textKind || 'text') === k ? 'on' : ''}">${n}</button>`).join('')}</div>` : '';
    let html = '';
    if (t === 'rect') html = `<h4>矩形</h4><div class="sk-row"><label>圆角半径<input data-o="radius" type="number" min="0" step="0.5" value="${this.opts.radius}"> mm</label></div>`;
    else if (t === 'polygon') {
      html = `<h4>多边形 / 星形</h4><div class="sk-row"><label>${this.opts.star ? '角数' : '边数'}<input data-o="sides" type="number" min="3" max="64" value="${this.opts.sides}"></label>
        <label class="sk-check"><input data-o="star" type="checkbox" ${this.opts.star ? 'checked' : ''}>星形</label></div>` +
        (this.opts.star ? `<div class="sk-row"><label>内外径比<input data-o="starRatio" type="number" min="0.1" max="0.95" step="0.05" value="${this.opts.starRatio}"></label></div>` : '');
    } else if (codeSel || (t === 'text' && (this.opts.textKind === 'qr' || this.opts.textKind === 'bar'))) {
      html = kindSeg + this.codeHtml(codeSel);
    } else if (t === 'text' || textSel) {
      const o = this.opts;
      const src = textSel ? textSel.data.text : this.textParams({});
      const layout = src.path ? 'path' : src.arc ? 'arc' : 'line';
      const fonts = (this.fonts || []).map((f) => `<option value="${f.id}" ${f.id === src.font ? 'selected' : ''}>${f.name}</option>`).join('');
      html = kindSeg + `<h4>${textSel ? '修改文字' : '文字'}</h4>
        <div class="sk-row"><textarea class="sk-wide" rows="2" data-o="text" placeholder="可以换行">${escAttr(src.text)}</textarea></div>
        <div class="sk-row"><label>字体<select data-o="font">${fonts}</select></label></div>
        <div class="sk-row"><label>字高<input data-o="size" type="number" min="1" step="0.5" value="${src.size}"> mm</label>
          <label>字距<input data-o="spacing" type="number" step="0.2" value="${src.spacing || 0}"> mm</label></div>
        <div class="sk-row"><label>行距<input data-o="lineHeight" type="number" min="0.5" step="0.05" value="${src.lineHeight || 1.25}"> 倍</label>
          <label>对齐<select data-o="align">${[['left', '左'], ['center', '中'], ['right', '右']].map(([k, n]) => `<option value="${k}" ${src.align === k ? 'selected' : ''}>${n}</option>`).join('')}</select></label></div>
        <div class="sk-row"><label>排列<select data-o="layout">
          <option value="line" ${layout === 'line' ? 'selected' : ''}>直排</option>
          <option value="arc" ${layout === 'arc' ? 'selected' : ''}>圆弧</option>
          <option value="path" ${layout === 'path' ? 'selected' : ''} ${textSel ? '' : 'disabled'}>沿路径（先放文字再选）</option></select></label></div>` +
        (layout === 'arc' ? `<div class="sk-row"><label>半径<input data-o="arc" type="number" step="5" value="${src.arc || o.textArc || 50}"> mm</label>
          <span class="sk-small">正数：沿圆弧上方；负数：下方</span></div>` : '') +
        (textSel && layout === 'path' ? `<div class="sk-row"><button data-o-btn="pickpath">${src.path ? '换一条路径' : '选择路径'}</button>
          <span class="sk-small">${src.path ? '✓ 已沿路径排列' : '点按钮后在画布上点一条线'}</span></div>` : '') + `
        <div class="sk-row"><label class="sk-check"><input data-o="bold" type="checkbox" ${src.bold ? 'checked' : ''}><b>粗体</b></label>
          <label class="sk-check"><input data-o="italic" type="checkbox" ${src.italic ? 'checked' : ''}><i>斜体</i></label>
          <label class="sk-check"><input data-o="vertical" type="checkbox" ${src.vertical ? 'checked' : ''} ${layout !== 'line' ? 'disabled' : ''}>竖排</label></div>
        <div class="sk-row"><label class="sk-check"><input data-o="weld" type="checkbox" ${src.weld ? 'checked' : ''}>焊接（笔画连成一体，镂空切割用）</label></div>
        <p class="sk-small">${textSel ? '修改后点别处（或回车）生效；只移动时文字保持可改，旋转 / 缩放 / 节点编辑后会转成路径。' : '在板上单击放置。'}</p>`;
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
            <label title="插槽比板厚宽多少；用「🧪 卡榫测试样」实测得到">间隙<input data-o="jointPlay" type="number" min="-0.3" step="0.05" value="${o.jointPlay || 0}"> mm</label></div>
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
      html = `<h4>水口（微连）</h4>
        <div class="sk-row"><label>宽度<input data-o="bridgeW" type="number" min="0.2" step="0.1" value="${this.opts.bridgeW}"> mm</label></div>
        <div class="sk-row"><label>每个图形<input data-o="bridgeN" type="number" min="1" step="1" value="${this.opts.bridgeN || 2}"> 个</label>
          <button data-bridge="auto">自动加</button><button data-bridge="clear">清除</button></div>
        <p class="sk-small">在切割线上单击加一个；点橙色标记删除。「自动加」作用于选中的图形（没选时作用于所有镂空）。切完用刀片划断水口即可取下。<br>建议：每块板件 2 个、放在相对的直边上；不要放在卡榫 / 插槽边上，留下的小凸起会让榫插不进去。</p>`;
    } else if (t === 'measure') {
      const mm = this.measMode;
      const tips = { pp: '拖动，或先后点两个点（会吸附端点、中点、圆心）。Shift = 水平 / 垂直 / 45°。',
        pl: '先点一个点，再点一条线：量点到这条线的垂直距离（线不够长时按延长线算）。',
        ll: '先后点两条线：平行时量间距（比如槽宽、板厚）；不平行时量最近距离和夹角。',
        cc: '点一个圆或圆弧：半径、直径、圆心；再点另一个圆：圆心距和边缘间隙。' };
      html = `<h4>测量</h4><div class="sk-seg">${[['pp', '点到点'], ['pl', '点到线'], ['ll', '线到线'], ['cc', '圆']].map(([k, n]) =>
        `<button data-mm="${k}" class="${mm === k ? 'on' : ''}">${n}</button>`).join('')}</div>
        <p class="sk-small">${tips[mm]}</p><div class="sk-meas-result sk-small">${this.meas && this.meas.has ? this.$('.sk-measure').innerHTML : '还没有测量结果'}</div>`;
    } else if (t === 'trim') {
      const tm = this.opts.trimMode || 'trim';
      const tips = { trim: '鼠标移到线上会标出将被删掉的一段（到最近的交点为止），单击或拖过即删除。没有交点的整条路径会被整个删掉。',
        break: '在线上单击，把线在这一点断开：开放的线变成两段（两个图形）；闭合图形变成开放的线（不再是一块板）。',
        erase: '从线上拖过去，擦掉经过的地方；每次擦掉的长度 = 擦除宽度。闭合图形擦一下就变成开放的线。' };
      html = `<h4>修剪</h4><div class="sk-seg">${[['trim', '修剪'], ['break', '打断'], ['erase', '橡皮擦']].map(([k, n]) => `<button data-trm="${k}" class="${tm === k ? 'on' : ''}">${n}</button>`).join('')}</div>` +
        (tm === 'erase' ? `<div class="sk-row"><label>擦除宽度<input data-o="eraseW" type="number" min="0.2" step="0.5" value="${this.opts.eraseW || 2}"> mm</label></div>` : '') +
        `<p class="sk-small">${tips[tm]}</p>`;
    }
    if ((t === 'joint' || t === 'mortise') && !this.findEdit()) html = this.staleJointsHtml() + html;
    box.innerHTML = html;
    box.classList.toggle('hidden', !html);
    this.bindRedoJoints(box);
    box.querySelectorAll('[data-tk]').forEach((b) => b.addEventListener('click', () => {
      this.opts.textKind = b.dataset.tk;
      this.renderToolOpts();
      this.status(b.dataset.tk === 'text' ? '文字：在板上单击放置' : `${b.dataset.tk === 'qr' ? '二维码' : '条形码'}：右侧填内容和尺寸，在板上单击放置（雕刻）`);
    }));
    if (box.querySelector('[data-cd]')) this.bindCode(box, codeSel);
    box.querySelectorAll('[data-trm]').forEach((b) => b.addEventListener('click', () => {
      this.opts.trimMode = b.dataset.trm;
      if (this.rubber) { this.rubber.remove(); this.rubber = null; }
      this.renderToolOpts();
      this.status({ trim: '修剪：单击或拖过线段，删掉两个交点之间的那一段', break: '打断：在线上单击，把线断开', erase: '橡皮擦：从线上拖过去擦掉一段' }[b.dataset.trm]);
    }));
    box.querySelectorAll('[data-peer]').forEach((b) => b.addEventListener('click', () => this.pickPeer(Number(b.dataset.peer))));
    box.querySelectorAll('[data-o-btn=pickpath]').forEach((b) => b.addEventListener('click', () => {
      if (!textSel) return;
      this.pickPathFor = textSel.data.id;
      this.status('在画布上点一条线（或图形的边），文字会沿着它排列');
    }));
    box.querySelectorAll('[data-mm]').forEach((b) => b.addEventListener('click', () => {
      this.opts.measureMode = b.dataset.mm;
      this.clearMeasure();
      this.renderToolOpts();
      this.status(TOOLS.find((q) => q.id === 'measure').tip);
    }));
    box.querySelectorAll('[data-bridge]').forEach((b) => b.addEventListener('click', () => {
      if (b.dataset.bridge === 'auto') this.autoBridges();
      else {
        const targets = this.sel.size ? [...this.sel] : this.content.children;
        let n = 0;
        targets.forEach((it) => { if (it.data && it.data.bridges && it.data.bridges.length) { n += it.data.bridges.length; it.data.bridges = null; } });
        if (n) this.commit(`已清除 ${n} 个水口`);
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
        const live = textSel && this.content.children.find((c) => c.data && c.data.id === textSel.data.id && c.data.text);
        if (textSel && !live) return;
        if (live) {
          const textSel = live;      // 用最新的对象（之前的可能已被重建替换）
          const t2 = { ...textSel.data.text };
          if (k === 'layout') {
            if (v === 'line') { t2.arc = 0; t2.path = null; }
            if (v === 'arc') { t2.path = null; t2.arc = t2.arc || this.opts.textArc || 50; }
            if (v === 'path') { this.pickPathFor = textSel.data.id; this.status('在画布上点一条线（或图形的边），文字会沿着它排列'); this.renderToolOpts(); return; }
          } else t2[k] = v;
          const it = await this.buildText(t2, textSel);
          if (it) { this.sel = new Set([it]); this.commit('已修改文字'); }
          return;
        }
        const tk = { spacing: 'textSpacing', align: 'textAlign', arc: 'textArc', weld: 'textWeld', layout: 'textLayout', bold: 'textBold', italic: 'textItalic', vertical: 'textVertical' }[k];
        if (tk) { this.opts[tk] = v; this.renderToolOpts(); return; }
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
      if (el.tagName === 'TEXTAREA') el.addEventListener('keydown', (ev) => { if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) el.blur(); });
    });
  }

  // 其他板上已有的卡榫：点一下就设成配对的类型和段数
  // 二维画板（B5）：配对对象就是这张画板上还没配对的 A 边（另一块板上的），插槽可以和它配成一对
  sheetPeers() {
    return this.connections().singles.filter((x) => x.ends[0].j.type === 'a').map((x) => {
      const { j, name, side } = x.ends[0];
      return { id: j.id, type: 'a', L: j.L, iv: j.iv, k: j.k, depth: j.depth, mode: j.mode, count: j.count, tab: j.tab, gap: j.gap, part: `${name} 的${side}`, sheet: true };
    });
  }

  peerHtml(tool) {
    this._peerSrc = this.sheetMode && tool === 'mortise' ? this.sheetPeers() : (this.peers || []);
    const list = this._peerSrc.filter((p) => (tool === 'mortise' ? p.type === 'a' : ['a', 'b', 'slot', 'mortise'].includes(p.type)));
    if (!list.length) {
      return this.sheetMode && tool === 'mortise'
        ? '<p class="sk-small">要和插槽配对，先用「卡榫」工具在另一块板的边上做一条 A 边（点一下后按 Esc，不和别的边配对），再回来这里选它。</p>'
        : '<p class="sk-small">其他板上还没有卡榫。先在一块板上做好，再回来这里配对。</p>';
    }
    const cur = this.opts.jointPeer;
    const names = { a: '指接 A', b: '指接 B', slot: '凹槽', mortise: '插槽' };
    return '<h4 class="sk-sub-h">和其他板配对</h4><div class="sk-peers">' + list.map((p) => {
      const i = this._peerSrc.indexOf(p);
      const on = cur && cur.id === p.id ? ' on' : '';
      const n = p.iv ? p.iv.length : Math.floor(p.k / 2);
      return `<button data-peer="${i}" class="sk-peer${on}" title="点一下套用它的齿的设置">${escAttr(p.part)} · ${names[p.type] || p.type} · ${fmt(p.L)} mm · ${n} 个 A 齿</button>`;
    }).join('') + '</div>';
  }

  pickPeer(i) {
    const p = (this._peerSrc || this.peers || [])[i];
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

  // 齿深 / 插槽宽和现在板厚不一致的卡榫（板厚改过之后）
  staleJoints() {
    const t = this.part.thickness || 3;
    const out = [];
    this.content.children.forEach((it) => (it.data && it.data.joints || []).forEach((j) => {
      if (['a', 'b', 'slot', 'mortise'].includes(j.type) && j.depth && Math.abs(j.depth - t) > 0.01) out.push({ item: it, joint: j });
    }));
    return out;
  }

  staleJointsHtml() {
    const st = this.staleJoints();
    if (!st.length) return '';
    const olds = [...new Set(st.map((q) => fmt(q.joint.depth)))].join(' / ');
    return `<div class="sk-warn">⚠ 有 <b>${st.length}</b> 处卡榫 / 插槽是按板厚 ${olds} mm 做的，现在板厚是 ${fmt(this.part.thickness || 3)} mm，切出来会插不进或太松。
      <button data-redo-joints class="primary">按现在的板厚重做</button></div>`;
  }

  bindRedoJoints(box) {
    const b = box.querySelector('[data-redo-joints]');
    if (b) b.addEventListener('click', () => this.redoStaleJoints());
  }

  // 把板厚不一致的卡榫 / 插槽按现在的板厚重新生成（齿数、齿宽设置不变）；整个操作只算一步撤销
  redoStaleJoints() {
    const st = this.staleJoints();
    if (!st.length) return;
    const n0 = this.undoStack.length;
    let ok = 0;
    const keepDepth = this.opts.jointDepth;
    st.forEach(({ item, joint }) => {
      const live = this.content.children.find((c) => c.data && c.data.id === item.data.id);
      const j = live && (live.data.joints || []).find((q) => q.id === joint.id);
      if (!j) return;
      this.startEditJoint({ item: live, joint: j });
      this.opts.jointDepth = 0;                      // 0 = 跟板厚走
      const before = JSON.stringify(j);
      this.applyEditJoint(false);
      const after = (live.data.joints || []).find((q) => q.id === joint.id);
      if (after && JSON.stringify(after) !== before) ok++;
    });
    this.opts.jointDepth = keepDepth && Math.abs(keepDepth - (this.part.thickness || 3)) > 0.01 ? 0 : keepDepth;
    if (this.undoStack.length > n0 + 1) this.undoStack.splice(n0 + 1);
    this.renderBoardInfo();
    this.refresh();
    const left = this.staleJoints().length;
    this.status(`已按板厚 ${fmt(this.part.thickness || 3)} mm 重做 ${ok} 处卡榫 / 插槽` + (left ? `；还有 ${left} 处的边被改动过，没法自动重做，请手动处理` : ''));
  }

  renderBoardInfo() {
    const p = this.part;
    if (this.sheetMode) {
      const box = this.$('.sk-boardinfo');
      box.innerHTML = `<h4>二维画板</h4>
        <p class="sk-small">材料（激光机台面）尺寸：
          <input type="number" data-sheet="w" value="${fmt(p.sheet.w)}" min="10" step="10" style="width:64px"> ×
          <input type="number" data-sheet="h" value="${fmt(p.sheet.h)}" min="10" step="10" style="width:64px"> mm</p>
        <p class="sk-small">板厚（材料厚度）：
          <input type="number" data-thick value="${fmt(p.thickness || 3)}" min="0.5" max="30" step="0.1" style="width:64px"> mm</p>
        <p class="sk-small">卡榫的齿深、插槽宽度和 3D 里板的厚度都按它来。最好用卡尺量实际厚度（或用「🧪 卡榫测试样」）。</p>
        ${this.staleJointsHtml()}
        <p class="sk-small">每个<b>最外层的闭合切割轮廓</b>就是一块板；画在它里面的孔、雕刻和文字都属于这块板。</p>
        <p class="sk-small">两块板要拼在一起：用「卡榫」工具先点 A 板的一条边，再点 B 板的一条边，自动配成一对，3D 里会按它自动拼装。</p>
        <p class="sk-small">画好后点右上角「3D 装配 →」。右下角的 3D 预览是整张图的总览：点里面的板件或线条，就能在画板上定位它。导出的图纸和画板上的位置一样。</p>`;
      const thick = box.querySelector('[data-thick]');
      thick.addEventListener('change', () => {
        const v = Math.min(30, Math.max(0.5, Number(thick.value) || 3));
        if (Math.abs(v - (p.thickness || 0)) < 1e-9) return;
        p.thickness = v;
        if (this.onThickness) this.onThickness(v);
        this.renderBoardInfo();
        this.refresh();
        const n = this.staleJoints().length;
        this.status(n ? `板厚改为 ${fmt(v)} mm：有 ${n} 处卡榫 / 插槽还是按旧板厚做的，可在右侧一键重做` : `板厚改为 ${fmt(v)} mm`);
      });
      thick.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') thick.blur(); });
      this.bindRedoJoints(box);
      box.querySelectorAll('[data-sheet]').forEach((inp) => inp.addEventListener('change', () => {
        const v = Math.max(10, Number(inp.value) || 0);
        p.sheet = { ...p.sheet, [inp.dataset.sheet]: v };
        p.outline = { outer: [[0, 0], [p.sheet.w, 0], [p.sheet.w, p.sheet.h], [0, p.sheet.h]], holes: [] };
        this.drawReference(); this.refresh(); this.drawDims(); this.emitChange();
      }));
      return;
    }
    this.$('.sk-boardinfo').innerHTML = `<h4>这块板</h4>
      <p class="sk-small">${p.sub || ''}</p>
      <p class="sk-small">板厚 <b>${fmt(p.thickness || 0)} mm</b>（在左侧参数里改）。卡榫边改动后，回到 3D 会自动检查能不能拼上（红色 = 穿透）。</p>
      ${this.staleJointsHtml()}
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
    else if (mod && k === 's') this.fileCmd(ev.shiftKey ? 'saveas' : 'save');
    else if (mod && k === 'o') this.fileCmd('open');
    else if (mod && k === 'n') this.fileCmd('new');
    else if (ev.key === 'Escape' && this.fileMenu) this.closeFileMenu();
    else if (ev.key === 'Escape' && this.refMenu) this.closeRefMenu();
    else if (ev.key === '?' || (ev.shiftKey && ev.key === '/')) this.showKeys();
    else if (mod && k === 'a') { this.sel = new Set(this.content.children.filter((c) => this.selectable(c))); this.setTool('select'); }
    else if (ev.key === 'Delete' || ev.key === 'Backspace') { if (this.drawing) this.cancelDrawing(); else this.deleteSel(); }
    else if (ev.key === 'Escape' && this.radialCfg) { this.closeRadialConfig(); }
    else if (ev.key === 'Escape' && this.tool === 'measure' && (this.meas && (this.meas.a || this.meas.has))) { this.clearMeasure(); this.status('已清除测量'); }
    else if (ev.key === 'Escape' && this.radialBox) { this.closeRadial(); } else if (ev.key === 'Escape' && this.overlapBox) { this.closeOverlap(); this.status('已保持为描线'); } else if (ev.key === 'Escape') { if (this.opts.jointPeer && this.opts.jointPeer.pair) { this.cancelPairing(); this.status('已取消配对：第一条边保留为没配对的卡榫边'); this.renderToolOpts(); } else if (this.drawing) this.cancelDrawing(); else if (this.dimState) { this.cancelDim(); this.status('已取消标注'); } else if (this.libArmed) { this.libArmed = null; this.status('已结束放置图库图形'); this.renderToolOpts(); } else { this.sel.clear(); this.refresh(); } }
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
// 与 sketch2d.py 的 flatten_path / curve_steps / is_closed 一致

const FLAT_TOL = 0.02;     // 曲线展平的最大偏差（mm）
const CLOSE_TOL = 0.01;    // 开放路径首尾距离小于它就当成闭合（导入的文件常差 0.001 mm）

/** 三次贝塞尔展平段数：按长度分段，再保证偏差 ≤ FLAT_TOL（偏差 ≤ max|B''| / 8n²，max|B''| ≤ 6 × 二阶差分）。 */
export function curveSteps(p0, p1, p2, p3, steps = 16) {
  const span = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]) + Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) + Math.hypot(p3[0] - p2[0], p3[1] - p2[1]);
  const m = Math.max(Math.hypot(p0[0] - 2 * p1[0] + p2[0], p0[1] - 2 * p1[1] + p2[1]),
    Math.hypot(p1[0] - 2 * p2[0] + p3[0], p1[1] - 2 * p2[1] + p3[1]));
  const need = m > 0 ? Math.ceil(Math.sqrt(6 * m / (8 * FLAT_TOL))) : 1;
  return Math.max(4, Math.min(64, Math.floor(span / 1.5) + steps / 2), Math.min(1024, need));
}

/** 首尾几乎重合（< CLOSE_TOL）的开放路径 → 闭合路径（去掉重合的终点，它的入控制柄给起点）。返回新对象，不改原数据。 */
export function closeNearlyClosed(p) {
  const segs = p.segs || [];
  if (p.closed || segs.length < 4) return p;
  const f = segs[0]; const l = segs[segs.length - 1];
  if (Math.hypot(f[0] - l[0], f[1] - l[1]) >= CLOSE_TOL) return p;
  const out = segs.slice(0, -1);
  out[0] = [f[0], f[1], l[2], l[3], f[4], f[5]];
  return { ...p, closed: true, segs: out };
}

function ringArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) { const p = pts[i]; const q = pts[(i + 1) % n]; a += p[0] * q[1] - q[0] * p[1]; }
  return a / 2;
}

/** 自相交的环（8 字形、蝴蝶结）在交叉点拆成几个简单环；没有自相交就原样返回 [pts]。与后端 make_valid 的结果一致。 */
export function splitRing(pts, depth = 0) {
  const n = pts.length;
  if (n < 4 || depth > 64) return [pts];
  const E = 1e-9;
  for (let i = 0; i < n; i++) {
    const a = pts[i]; const b = pts[(i + 1) % n];
    const minX = Math.min(a[0], b[0]); const maxX = Math.max(a[0], b[0]); const minY = Math.min(a[1], b[1]); const maxY = Math.max(a[1], b[1]);
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const c = pts[j]; const d = pts[(j + 1) % n];
      if (Math.max(c[0], d[0]) < minX || Math.min(c[0], d[0]) > maxX || Math.max(c[1], d[1]) < minY || Math.min(c[1], d[1]) > maxY) continue;
      const rx = b[0] - a[0]; const ry = b[1] - a[1]; const sx = d[0] - c[0]; const sy = d[1] - c[1];
      const den = rx * sy - ry * sx;
      if (Math.abs(den) < 1e-12) continue;
      const t = ((c[0] - a[0]) * sy - (c[1] - a[1]) * sx) / den;
      const u = ((c[0] - a[0]) * ry - (c[1] - a[1]) * rx) / den;
      if (t <= E || t >= 1 - E || u <= E || u >= 1 - E) continue;
      const x = [a[0] + t * rx, a[1] + t * ry];
      const r1 = [x, ...pts.slice(i + 1, j + 1)];
      const r2 = [x, ...pts.slice(j + 1), ...pts.slice(0, i + 1)];
      return [r1, r2].filter((r) => r.length >= 3 && Math.abs(ringArea(r)) > 1e-9).flatMap((r) => splitRing(r, depth + 1));
    }
  }
  return [pts];
}

/** 把首尾相接（< CLOSE_TOL）的开放路径连成一条；连成环的变成闭合路径。只在恰好两条线相接的点连（T 字路口不连）。
 *  paths: [{ closed, segs: [[x, y, inx, iny, outx, outy], ...] }]，返回新数组。 */
export function joinOpenPaths(paths) {
  const open = []; const out = [];
  paths.forEach((p) => { if (!p.closed && p.segs && p.segs.length >= 2) open.push({ segs: p.segs.map((s) => [...s]) }); else out.push(closeNearlyClosed(p)); });
  if (!open.length) return out;
  const key = (s) => `${Math.round(s[0] / CLOSE_TOL)},${Math.round(s[1] / CLOSE_TOL)}`;
  const deg = new Map();
  open.forEach((p) => [p.segs[0], p.segs[p.segs.length - 1]].forEach((s) => deg.set(key(s), (deg.get(key(s)) || 0) + 1)));
  const rev = (segs) => segs.slice().reverse().map((s) => [s[0], s[1], s[4], s[5], s[2], s[3]]);
  const used = new Array(open.length).fill(false);
  const ends = new Map();         // 端点 → [路径序号]
  open.forEach((p, i) => [p.segs[0], p.segs[p.segs.length - 1]].forEach((s) => { const k = key(s); if (!ends.has(k)) ends.set(k, []); ends.get(k).push(i); }));
  const take = (k, self) => {
    if (deg.get(k) !== 2) return -1;
    const j = (ends.get(k) || []).find((q) => q !== self && !used[q]);
    return j === undefined ? -1 : j;
  };
  for (let i = 0; i < open.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let segs = open[i].segs;
    for (let guard = 0; guard < open.length; guard++) {          // 往后接
      const k = key(segs[segs.length - 1]);
      const j = take(k, i);
      if (j < 0) break;
      used[j] = true;
      let nx = open[j].segs;
      if (key(nx[0]) !== k) nx = rev(nx);
      const last = segs[segs.length - 1];
      last[4] = nx[0][4]; last[5] = nx[0][5];                    // 接点：入控制柄留前一条的，出控制柄用后一条的
      segs = segs.concat(nx.slice(1));
    }
    for (let guard = 0; guard < open.length; guard++) {          // 往前接
      const k = key(segs[0]);
      if (key(segs[segs.length - 1]) === k) break;
      const j = take(k, i);
      if (j < 0) break;
      used[j] = true;
      let pv = open[j].segs;
      if (key(pv[pv.length - 1]) !== k) pv = rev(pv);
      const first = segs[0];
      first[2] = pv[pv.length - 1][2]; first[3] = pv[pv.length - 1][3];
      segs = pv.slice(0, -1).concat(segs);
    }
    out.push(closeNearlyClosed({ closed: false, segs }));
  }
  return out;
}

/** 闭合环的真实面积（自相交的按拆开后各瓣面积之和）。 */
export function loopArea(pts) {
  return splitRing(pts).reduce((s, r) => s + Math.abs(ringArea(r)), 0);
}

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
    const k = curveSteps(p0, p1, p2, p3, steps);
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

/** 草图 → { cut: 闭合切割环[], open: 开放切割线[], engrave: 闭合雕刻环[], lines: 描线 / 开放雕刻线[] } */
export function sketchPolys(sketch) {
  const out = { cut: [], open: [], engrave: [], lines: [] };
  (sketch.items || []).forEach((it) => {
    if (it.mode === 'dim') return;                       // 尺寸标注不进 3D、不进导出几何
    (it.paths || []).forEach((p0) => {
      const p = closeNearlyClosed(p0);
      const pts = flattenPath(p);
      if (pts.length < 2) return;
      const closed = p.closed && pts.length >= 3;
      if (it.mode === 'cut') { if (closed) out.cut.push(...splitRing(pts)); else out.open.push(pts); }
      else if (it.mode === 'engrave' && closed) out.engrave.push(...splitRing(pts));
      else out.lines.push(closed ? [...pts, pts[0]] : pts);
    });
  });
  return out;
}
