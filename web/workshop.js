// SeedBoxes 工坊：3D 模型视图 + 板件清单 + 单块板 2D 编辑（开孔 / 刻字）
// 坐标约定见 model3d.py：后端给出每块板「名义坐标系」轮廓和 4×4 摆放矩阵（x 右、y 后、z 上）。
// 编辑（edit）存在「从外面看」坐标系：原点 = 内部矩形左下角，单位 mm，y 向上。
import * as THREE from './vendor/three/three.module.min.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';

const api = () => window.pywebview.api;
const $ = (s) => document.querySelector(s);

const WOOD = [0xd9b382, 0xd4ad7a, 0xdfba8c, 0xcfa673, 0xdbb487, 0xd6b07f];
const ENGRAVE_COLOR = 0x5a3a1c;
const SELECT_COLOR = 0x3b82f6;

const W = {
  name: null,
  model: null,
  project: freshProject(),
  mode: '2d',
  selected: null,
  shapes: new Map(),      // edit.id → { key, polys, missing }（以 (0,0) 为中心）
  stale: true,
  loadSeq: 0,
  fonts: null,
};

function freshProject() { return { disabled: [], edits: {} }; }
let uidCounter = 0;
const newId = () => 'e' + Date.now().toString(36) + (uidCounter++).toString(36);

function toast(msg, kind) { if (window.toast) window.toast(msg, kind); }

// ------------------------------------------------------------------ 几何工具

function shapeKey(e) {
  return JSON.stringify([e.type, e.d, e.w, e.h, e.r, e.angle, e.text, e.size, e.font]);
}

async function ensureShapes(edits) {
  const need = edits.filter((e) => {
    const c = W.shapes.get(e.id);
    return !c || c.key !== shapeKey(e);
  });
  if (!need.length) return;
  // 以 (0,0) 为中心求多边形，平移在前端做（拖动时不用再请求后端）
  const req = need.map((e) => ({ ...e, x: 0, y: 0, mode: 'engrave' }));
  const res = await api().edit_shapes(req);
  res.forEach((r, i) => {
    W.shapes.set(need[i].id, { key: shapeKey(need[i]), polys: r.polys || [], missing: r.missing || [] });
  });
}

function editPolys(e) {
  const s = W.shapes.get(e.id);
  if (!s) return [];
  return s.polys.map((p) => p.map(([x, y]) => [x + e.x, y + e.y]));
}

function signedArea(p) {
  let s = 0;
  for (let i = 0; i < p.length; i++) {
    const [x1, y1] = p[i];
    const [x2, y2] = p[(i + 1) % p.length];
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

function pointInPoly([x, y], poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// 字形轮廓 → [{outer, holes}]：按包含层数判断外轮廓 / 孔
function nestContours(polys) {
  const info = polys.map((p) => ({ p, area: Math.abs(signedArea(p)), depth: 0, parent: null }));
  info.forEach((a) => {
    let best = null;
    info.forEach((b) => {
      if (a === b || b.area <= a.area) return;
      if (pointInPoly(a.p[0], b.p)) {
        a.depth++;
        if (!best || b.area < best.area) best = b;
      }
    });
    a.parent = best;
  });
  const shapes = [];
  const map = new Map();
  info.forEach((a) => {
    if (a.depth % 2 === 0) { const s = { outer: a.p, holes: [] }; shapes.push(s); map.set(a, s); }
  });
  info.forEach((a) => {
    if (a.depth % 2 === 1 && a.parent && map.has(a.parent)) map.get(a.parent).holes.push(a.p);
  });
  return shapes;
}

const v2 = ([x, y]) => new THREE.Vector2(x, y);

// 编辑坐标（从外面看）→ 板的名义坐标
function toLocal(part, poly) {
  return part.mirror ? poly.map(([x, y]) => [part.w - x, y]) : poly;
}

// ------------------------------------------------------------------ 3D 视图

class View3D {
  constructor(host) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0xf4f3ee);
    host.appendChild(this.renderer.domElement);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(35, 1, 1, 20000);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.12;

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb9a88f, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(0.6, 1.0, 0.8);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.5);
    fill.position.set(-0.8, 0.4, -0.6);
    this.scene.add(fill);

    // boxes 坐标（z 向上）→ three（y 向上）
    this.root = new THREE.Group();
    this.root.rotation.x = -Math.PI / 2;
    this.scene.add(this.root);
    this.grid = null;
    this.objects = new Map();   // part id → { group, mesh, edges, mat }
    this.onPick = null;

    this.raycaster = new THREE.Raycaster();
    let down = null;
    const el = this.renderer.domElement;
    el.addEventListener('pointerdown', (ev) => { down = [ev.clientX, ev.clientY]; });
    el.addEventListener('pointerup', (ev) => {
      if (!down) return;
      const moved = Math.hypot(ev.clientX - down[0], ev.clientY - down[1]);
      down = null;
      if (moved < 4) this.pick(ev);
    });
    el.addEventListener('dblclick', (ev) => {
      const id = this.hit(ev);
      if (id && this.onEdit) this.onEdit(id);
    });

    new ResizeObserver(() => this.resize()).observe(host);
    this.resize();
    const loop = () => {
      requestAnimationFrame(loop);
      if (!this.host.offsetParent) return;   // 不可见时不渲染
      this.controls.update();
      this.renderer.render(this.scene, this.camera);
    };
    loop();
  }

  resize() {
    const w = this.host.clientWidth || 1;
    const h = this.host.clientHeight || 1;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  hit(ev) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    const meshes = [...this.objects.values()].map((o) => o.mesh);
    const hits = this.raycaster.intersectObjects(meshes, false);
    return hits.length ? hits[0].object.userData.partId : null;
  }

  pick(ev) {
    const id = this.hit(ev);
    if (this.onPick) this.onPick(id);
  }

  clear() {
    this.objects.forEach((o) => { this.root.remove(o.group); disposeTree(o.group); });
    this.objects.clear();
  }

  setModel(model) {
    this.clear();
    model.parts.forEach((p, i) => this.buildPart(p, model.thickness, i));
    this.refreshStates();
    this.fit(model);
  }

  buildPart(p, t, i) {
    const old = this.objects.get(p.id);
    if (old) { this.root.remove(old.group); disposeTree(old.group); }
    const shape = new THREE.Shape(p.outer.map(v2));
    p.holes.forEach((h) => shape.holes.push(new THREE.Path(h.map(v2))));
    const engr = [];
    (W.project.edits[p.id] || []).forEach((e) => {
      const polys = editPolys(e).map((pl) => toLocal(p, pl));
      if (e.mode === 'cut') {
        nestContours(polys).forEach((s) => shape.holes.push(new THREE.Path(s.outer.map(v2))));
      } else {
        engr.push(...nestContours(polys));
      }
    });
    let geo;
    try {
      geo = new THREE.ExtrudeGeometry(shape, { depth: t, bevelEnabled: false, curveSegments: 1, steps: 1 });
    } catch (e) {
      geo = new THREE.ExtrudeGeometry(new THREE.Shape(p.outer.map(v2)), { depth: t, bevelEnabled: false });
    }
    const color = WOOD[i % WOOD.length];
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.partId = p.id;
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(geo, 25),
      new THREE.LineBasicMaterial({ color: 0x7a5530, transparent: true, opacity: 0.55 }),
    );
    const group = new THREE.Group();
    group.add(mesh, edges);
    if (engr.length) {
      const eshapes = engr.map((s) => {
        const sh = new THREE.Shape(s.outer.map(v2));
        s.holes.forEach((h) => sh.holes.push(new THREE.Path(h.map(v2))));
        return sh;
      });
      const em = new THREE.Mesh(
        new THREE.ShapeGeometry(eshapes, 1),
        new THREE.MeshBasicMaterial({ color: ENGRAVE_COLOR, side: THREE.DoubleSide,
                                      polygonOffset: true, polygonOffsetFactor: -2 }),
      );
      em.position.z = t + 0.05;   // 外表面
      group.add(em);
    }
    group.matrixAutoUpdate = false;
    group.matrix.fromArray(p.matrix);
    this.root.add(group);
    this.objects.set(p.id, { group, mesh, edges, mat, color });
  }

  refreshStates() {
    const dis = new Set(W.project.disabled);
    this.objects.forEach((o, id) => {
      const off = dis.has(id);
      o.mat.transparent = off;
      o.mat.opacity = off ? 0.12 : 1;
      o.mat.depthWrite = !off;
      o.mat.emissive.setHex(id === W.selected ? SELECT_COLOR : 0x000000);
      o.mat.emissiveIntensity = id === W.selected ? 0.35 : 0;
      o.edges.material.opacity = off ? 0.15 : 0.55;
      o.group.children.slice(2).forEach((c) => { c.visible = !off; });
    });
  }

  fit(model) {
    const box = new THREE.Box3();
    this.root.updateMatrixWorld(true);   // 先应用 z 向上 → y 向上的旋转
    // 拼装模式只对准拼好的部分（旁边散放的零件、校准尺不参与取景）
    const core = model.assembled ? new Set(model.parts.filter((p) => p.face || (p.id || '').startsWith('inner')).map((p) => p.id)) : null;
    this.objects.forEach((o, id) => { if (!core || core.has(id)) box.expandByObject(o.mesh); });
    if (box.isEmpty()) this.objects.forEach((o) => box.expandByObject(o.mesh));
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = size.length() / 2 + 10;
    const fovV = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const fovH = Math.atan(Math.tan(fovV) * this.camera.aspect);
    const dist = radius / Math.sin(Math.min(fovV, fovH)) * 1.05;
    const dir = model.assembled ? new THREE.Vector3(0.75, 0.62, 1.0) : new THREE.Vector3(0.2, 1.4, 0.9);
    dir.normalize();
    this.camera.position.copy(center).addScaledVector(dir, dist);
    this.camera.near = dist / 100;
    this.camera.far = dist * 20;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
    // 地面网格
    if (this.grid) { this.scene.remove(this.grid); disposeTree(this.grid); }
    const all = new THREE.Box3();
    this.objects.forEach((o) => all.expandByObject(o.mesh));
    const allSize = all.getSize(new THREE.Vector3());
    const span = Math.ceil(Math.max(size.x, size.z, allSize.x, allSize.z) * 1.6 / 10) * 10;
    this.grid = new THREE.GridHelper(span, Math.max(4, span / 10), 0xd8d3c6, 0xe7e3d8);
    this.grid.position.set(center.x, box.min.y - 0.5, center.z);
    this.scene.add(this.grid);
  }

  view(dir) {
    const c = this.controls.target.clone();
    const d = this.camera.position.distanceTo(c);
    const dirs = { front: [0, 0, 1], top: [0, 1, 0.001], side: [1, 0, 0], iso: [0.75, 0.62, 1] };
    const v = new THREE.Vector3(...dirs[dir]).normalize();
    this.camera.position.copy(c).addScaledVector(v, d);
    this.controls.update();
  }
}

function disposeTree(obj) {
  obj.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach((m) => m.dispose());
  });
}

// ------------------------------------------------------------------ 板件清单

function renderPartsPanel() {
  const panel = $('#parts-panel');
  const m = W.model;
  if (!m) { panel.innerHTML = ''; return; }
  const dis = new Set(W.project.disabled);
  const on = m.parts.filter((p) => !dis.has(p.id)).length;
  panel.innerHTML = '';
  const head = document.createElement('div');
  head.className = 'pp-head';
  head.innerHTML = `<span>板件清单</span><span class="pp-count">${m.parts.length} 片 · 启用 ${on}</span>`;
  panel.appendChild(head);
  m.parts.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pp-row' + (p.id === W.selected ? ' sel' : '') + (dis.has(p.id) ? ' off' : '');
    const n = (W.project.edits[p.id] || []).length;
    row.innerHTML = `
      <span class="pp-chip" style="background:#${WOOD[i % WOOD.length].toString(16)}">${String.fromCharCode(65 + (i % 26))}</span>
      <span class="pp-name" title="${esc(p.name)}">${esc(p.name)}${n ? `<em>${n}</em>` : ''}</span>
      <label class="pp-use" title="是否输出这块板"><input type="checkbox" ${dis.has(p.id) ? '' : 'checked'}>使用</label>
      <button class="pp-edit" title="开孔 / 刻字">编辑</button>`;
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('.pp-use') || ev.target.closest('.pp-edit')) return;
      select(p.id === W.selected ? null : p.id);
    });
    row.querySelector('input').addEventListener('change', (ev) => setEnabled(p.id, ev.target.checked));
    row.querySelector('.pp-edit').addEventListener('click', () => openEditor(p.id));
    panel.appendChild(row);
  });
  const tip = document.createElement('div');
  tip.className = 'pp-tip';
  tip.textContent = '双击 3D 里的板件也可以编辑';
  panel.appendChild(tip);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function select(id) {
  W.selected = id;
  if (view) view.refreshStates();
  renderPartsPanel();
}

function setEnabled(id, on) {
  const s = new Set(W.project.disabled);
  if (on) s.delete(id); else s.add(id);
  W.project.disabled = [...s];
  if (view) view.refreshStates();
  renderPartsPanel();
  projectChanged();
}

function projectChanged() {
  W.previewStale = true;
}

// ------------------------------------------------------------------ 模型加载

let view = null;

function setNote(text, kind) {
  const el = $('#view3d-note');
  if (!text) { el.classList.add('hidden'); return; }
  el.textContent = text;
  el.className = 'view3d-note' + (kind ? ' ' + kind : '');
}

async function loadModel() {
  if (!W.name || !window.SeedApp) return;
  const seq = ++W.loadSeq;
  const name = W.name;
  setNote('正在生成 3D 模型…');
  let m;
  try {
    m = await api().get_model(name, window.SeedApp.collectParams());
  } catch (err) {
    if (seq === W.loadSeq) setNote('3D 模型生成失败：' + err, 'error');
    return;
  }
  if (seq !== W.loadSeq || name !== W.name) return;
  if (m.error) { setNote(m.error, 'error'); return; }
  W.model = m;
  W.stale = false;
  const all = Object.values(W.project.edits).flat();
  if (all.length) await ensureShapes(all);
  if (seq !== W.loadSeq) return;
  if (!view) {
    view = new View3D($('#view3d-canvas'));
    view.onPick = (id) => select(id);
    view.onEdit = (id) => openEditor(id);
  }
  view.setModel(m);
  renderPartsPanel();
  if (!m.parts.length) setNote('这个生成器没有可识别的闭合板件，无法生成 3D 模型。', 'info');
  else if (m.auto) {
    setNote(`自动装配（试验）：已拼上 ${m.placed} 块板${m.floating ? `，另有 ${m.floating} 块（隔板、盖子等）放在旁边` : ''}。` +
            '形状仅供参考，以图纸为准。', 'info');
  } else setNote(m.assembled ? '' : '这个生成器暂不支持拼装预览，下面是所有板件平铺的样子（仍可开孔、刻字、禁用）。',
               m.assembled ? '' : 'info');
}

function rebuildPart(id) {
  if (!view || !W.model) return;
  const i = W.model.parts.findIndex((p) => p.id === id);
  if (i < 0) return;
  view.buildPart(W.model.parts[i], W.model.thickness, i);
  view.refreshStates();
}

// ------------------------------------------------------------------ 视图切换

function setMode(mode) {
  W.mode = mode;
  $('#tab-2d').classList.toggle('on', mode === '2d');
  $('#tab-3d').classList.toggle('on', mode === '3d');
  $('#preview-host').classList.toggle('hidden', mode !== '2d');
  $('#view3d').classList.toggle('hidden', mode !== '3d');
  document.querySelectorAll('.zoom-2d').forEach((b) => b.classList.toggle('hidden', mode !== '2d'));
  document.querySelectorAll('.view-3d-btn').forEach((b) => b.classList.toggle('hidden', mode !== '3d'));
  if (mode === '3d' && (W.stale || !W.model)) loadModel();
  if (mode === '2d' && W.previewStale && window.SeedApp && window.SeedApp.hasPreview()) {
    W.previewStale = false;
    window.SeedApp.doPreview();
  }
}

// ------------------------------------------------------------------ 单块板 2D 编辑器

const ED = { part: null, sel: null, drag: null, svg: null, g: null };
const SVGNS = 'http://www.w3.org/2000/svg';

function partOutline(p) {
  // 「从外面看」：镜像板左右翻转
  const f = (pts) => (p.mirror ? pts.map(([x, y]) => [p.w - x, y]) : pts);
  return { outer: f(p.outer), holes: p.holes.map(f) };
}

function pathD(polys) {
  return polys.map((pl) => 'M' + pl.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join('L') + 'Z').join('');
}

async function openEditor(id) {
  if (!W.model) return;
  const p = W.model.parts.find((q) => q.id === id);
  if (!p) return;
  ED.part = p;
  ED.sel = null;
  select(id);
  if (!W.project.edits[id]) W.project.edits[id] = [];
  $('#pe-title').textContent = p.name;
  $('#pe-sub').textContent = p.kind === 'rect'
    ? `内部尺寸 ${fmt(p.w)} × ${fmt(p.h)} mm · 从外面看${p.mirror ? '（导出时这块板会翻面，刻字面朝外组装）' : ''}`
    : `约 ${fmt(p.bbox[2] - p.bbox[0])} × ${fmt(p.bbox[3] - p.bbox[1])} mm`;
  $('#part-editor').classList.remove('hidden');
  await ensureShapes(W.project.edits[id]);
  drawEditor(true);
  renderProps();
}

function closeEditor() {
  $('#part-editor').classList.add('hidden');
  ED.part = null;
  ED.sel = null;
  renderPartsPanel();
}

function curEdits() { return ED.part ? W.project.edits[ED.part.id] : []; }

function drawEditor(refit) {
  const p = ED.part;
  const host = $('#pe-canvas');
  const o = partOutline(p);
  const xs = o.outer.map((q) => q[0]);
  const ys = o.outer.map((q) => q[1]);
  const pad = 10;
  const minx = Math.min(...xs) - pad;
  const maxx = Math.max(...xs) + pad;
  const miny = Math.min(...ys) - pad;
  const maxy = Math.max(...ys) + pad;
  if (refit || !ED.svg) {
    host.innerHTML = '';
    const svg = document.createElementNS(SVGNS, 'svg');
    svg.setAttribute('viewBox', `${minx} ${-maxy} ${maxx - minx} ${maxy - miny}`);
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    const g = document.createElementNS(SVGNS, 'g');
    g.setAttribute('transform', 'scale(1,-1)');
    svg.appendChild(g);
    host.appendChild(svg);
    ED.svg = svg;
    ED.g = g;
    svg.addEventListener('pointerdown', (ev) => {
      if (ev.target === svg || ev.target.classList.contains('pe-board')) { ED.sel = null; drawEditor(); renderProps(); }
    });
  }
  const g = ED.g;
  g.innerHTML = '';
  // 1 mm / 10 mm 网格
  const grid = document.createElementNS(SVGNS, 'path');
  let d = '';
  for (let x = Math.ceil(minx / 10) * 10; x <= maxx; x += 10) d += `M${x},${miny}V${maxy}`;
  for (let y = Math.ceil(miny / 10) * 10; y <= maxy; y += 10) d += `M${minx},${y}H${maxx}`;
  grid.setAttribute('d', d);
  grid.setAttribute('class', 'pe-grid');
  g.appendChild(grid);
  // 板
  const board = document.createElementNS(SVGNS, 'path');
  board.setAttribute('d', pathD([o.outer, ...o.holes]));
  board.setAttribute('fill-rule', 'evenodd');
  board.setAttribute('class', 'pe-board');
  g.appendChild(board);
  if (p.kind === 'rect') {
    const r = document.createElementNS(SVGNS, 'rect');
    r.setAttribute('x', 0); r.setAttribute('y', 0);
    r.setAttribute('width', p.w); r.setAttribute('height', p.h);
    r.setAttribute('class', 'pe-inner');
    g.appendChild(r);
  }
  // 编辑图形
  curEdits().forEach((e) => {
    const el = document.createElementNS(SVGNS, 'path');
    const s = W.shapes.get(e.id);
    el.setAttribute('d', s ? pathD(s.polys) : '');
    el.setAttribute('fill-rule', 'evenodd');
    el.setAttribute('transform', `translate(${e.x},${e.y})`);
    el.setAttribute('class', `pe-shape ${e.mode}` + (e.id === ED.sel ? ' sel' : ''));
    el.dataset.id = e.id;
    el.addEventListener('pointerdown', (ev) => startDrag(ev, e));
    g.appendChild(el);
  });
}

function svgPoint(ev) {
  const pt = ED.svg.createSVGPoint();
  pt.x = ev.clientX;
  pt.y = ev.clientY;
  return pt.matrixTransform(ED.g.getScreenCTM().inverse());
}

const snap = (v) => ($('#pe-snap').checked ? Math.round(v) : Math.round(v * 10) / 10);

function startDrag(ev, e) {
  ev.preventDefault();
  ev.stopPropagation();
  if (ED.sel !== e.id) { ED.sel = e.id; renderProps(); }
  const p0 = svgPoint(ev);
  ED.drag = { e, x0: e.x, y0: e.y, p0 };
  const el = ev.target;
  el.setPointerCapture(ev.pointerId);
  [...ED.g.querySelectorAll('.pe-shape')].forEach((n) => n.classList.toggle('sel', n.dataset.id === e.id));
  const move = (mv) => {
    const p = svgPoint(mv);
    e.x = snap(ED.drag.x0 + p.x - ED.drag.p0.x);
    e.y = snap(ED.drag.y0 + p.y - ED.drag.p0.y);
    el.setAttribute('transform', `translate(${e.x},${e.y})`);
    syncPosInputs(e);
  };
  const up = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    ED.drag = null;
    editsChanged();
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
}

function syncPosInputs(e) {
  const fx = $('#pe-props [data-k="x"]');
  const fy = $('#pe-props [data-k="y"]');
  if (fx) fx.value = e.x;
  if (fy) fy.value = e.y;
}

function editsChanged() {
  rebuildPart(ED.part.id);
  projectChanged();
}

function addEdit(type) {
  const p = ED.part;
  const cx = p.kind === 'rect' ? p.w / 2 : (p.bbox[0] + p.bbox[2]) / 2;
  const cy = p.kind === 'rect' ? p.h / 2 : (p.bbox[1] + p.bbox[3]) / 2;
  const base = { id: newId(), type, x: Math.round(cx), y: Math.round(cy), angle: 0, mode: 'cut' };
  const e = {
    circle: { ...base, d: 10 },
    rect: { ...base, w: 20, h: 10 },
    rrect: { ...base, w: 30, h: 15, r: 4 },
    text: { ...base, mode: 'engrave', text: '种子创客', size: 10, font: (W.fonts && W.fonts[0] && W.fonts[0].id) || '' },
  }[type];
  curEdits().push(e);
  ED.sel = e.id;
  refreshEdit(e);
}

async function refreshEdit(e) {
  await ensureShapes([e]);
  const s = W.shapes.get(e.id);
  if (s && s.missing && s.missing.length) toast(`当前字体缺少：${s.missing.join('')}`, 'error');
  drawEditor();
  renderProps();
  editsChanged();
}

function removeSelected() {
  const list = curEdits();
  const i = list.findIndex((e) => e.id === ED.sel);
  if (i < 0) return;
  list.splice(i, 1);
  ED.sel = null;
  drawEditor();
  renderProps();
  editsChanged();
}

function duplicateSelected() {
  const e = curEdits().find((q) => q.id === ED.sel);
  if (!e) return;
  const c = { ...e, id: newId(), x: e.x + 5, y: e.y - 5 };
  curEdits().push(c);
  ED.sel = c.id;
  refreshEdit(c);
}

const TYPE_NAMES = { circle: '圆孔', rect: '方孔', rrect: '圆角矩形', text: '文字' };

async function renderProps() {
  const box = $('#pe-props');
  const e = curEdits().find((q) => q.id === ED.sel);
  if (!e) {
    const n = curEdits().length;
    box.innerHTML = `<div class="pe-empty">
      <p>用左边的工具在板上添加图形，拖动可以移动。</p>
      <p>· <b>切割</b>：激光切穿，适合开孔（蓝色线）<br>· <b>雕刻</b>：只刻表面，适合写字（绿色线）</p>
      <p>这块板上已有 ${n} 个图形。</p></div>`;
    return;
  }
  if (e.type === 'text' && !W.fonts) {
    W.fonts = await api().list_fonts();
  }
  const num = (k, label, step = 0.5, min = '') =>
    `<label class="pe-f"><span>${label}</span><input type="number" data-k="${k}" step="${step}" ${min !== '' ? `min="${min}"` : ''} value="${e[k] ?? ''}"></label>`;
  let html = `<div class="pe-ptitle">${TYPE_NAMES[e.type]}</div>`;
  html += `<div class="pe-mode">
      <button data-mode="cut" class="${e.mode === 'cut' ? 'on' : ''}">切割</button>
      <button data-mode="engrave" class="${e.mode === 'engrave' ? 'on' : ''}">雕刻</button></div>`;
  if (e.type === 'text') {
    html += `<label class="pe-f wide"><span>文字</span><input type="text" data-k="text" value="${esc(e.text)}"></label>`;
    html += num('size', '字高 mm', 0.5, 1);
    const fonts = W.fonts || [];
    html += `<label class="pe-f wide"><span>字体</span><select data-k="font">${
      fonts.map((f) => `<option value="${esc(f.id)}" ${f.id === e.font ? 'selected' : ''}>${esc(f.name)}</option>`).join('')
    }${fonts.length ? '' : '<option value="">（未找到中文字体）</option>'}</select></label>`;
  }
  html += num('x', '中心 X mm') + num('y', '中心 Y mm');
  if (e.type === 'circle') html += num('d', '直径 mm', 0.5, 0.5);
  if (e.type === 'rect' || e.type === 'rrect') html += num('w', '宽 mm', 0.5, 0.5) + num('h', '高 mm', 0.5, 0.5);
  if (e.type === 'rrect') html += num('r', '圆角半径 mm', 0.5, 0);
  if (e.type !== 'circle') html += num('angle', '旋转 °', 5);
  html += `<div class="pe-actions"><button id="pe-dup">复制</button><button id="pe-del" class="danger">删除</button></div>`;
  const s = W.shapes.get(e.id);
  if (s && s.missing && s.missing.length) html += `<div class="pe-warn">字体缺少：${esc(s.missing.join(''))}</div>`;
  box.innerHTML = html;
  box.querySelectorAll('[data-mode]').forEach((b) => b.addEventListener('click', () => {
    e.mode = b.dataset.mode; drawEditor(); renderProps(); editsChanged();
  }));
  box.querySelectorAll('[data-k]').forEach((inp) => {
    const k = inp.dataset.k;
    const apply = () => {
      if (k === 'text' || k === 'font') e[k] = inp.value;
      else { const v = parseFloat(inp.value); if (!Number.isFinite(v)) return; e[k] = v; }
      if (k === 'x' || k === 'y') {
        const el = ED.g.querySelector(`[data-id="${e.id}"]`);
        if (el) el.setAttribute('transform', `translate(${e.x},${e.y})`);
        editsChanged();
      } else {
        refreshEdit(e);
      }
    };
    inp.addEventListener(k === 'text' ? 'input' : 'change', debounce(apply, k === 'text' ? 350 : 0));
  });
  $('#pe-del').addEventListener('click', removeSelected);
  $('#pe-dup').addEventListener('click', duplicateSelected);
}

function debounce(fn, ms) {
  if (!ms) return fn;
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function fmt(v) { return Math.round(v * 10) / 10; }

document.addEventListener('keydown', (ev) => {
  if (!ED.part || !ED.sel) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement && document.activeElement.tagName)) return;
  const e = curEdits().find((q) => q.id === ED.sel);
  if (!e) return;
  const step = ev.shiftKey ? 10 : 1;
  const moves = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
  if (moves[ev.key]) {
    ev.preventDefault();
    e.x = fmt(e.x + moves[ev.key][0]);
    e.y = fmt(e.y + moves[ev.key][1]);
    const el = ED.g.querySelector(`[data-id="${e.id}"]`);
    if (el) el.setAttribute('transform', `translate(${e.x},${e.y})`);
    syncPosInputs(e);
    editsChanged();
  } else if (ev.key === 'Delete' || ev.key === 'Backspace') {
    ev.preventDefault();
    removeSelected();
  }
});

// ------------------------------------------------------------------ 对外接口（app.js 调用）

function hasContent() {
  return W.project.disabled.length > 0 || Object.values(W.project.edits).some((l) => l && l.length);
}

window.SeedWorkshop = {
  reset(name) {
    W.name = name;
    W.model = null;
    W.project = freshProject();
    W.selected = null;
    W.stale = true;
    W.previewStale = false;
    closeEditor();
    if (view) view.clear();
    $('#parts-panel').innerHTML = '';
    setNote('');
    // 不在这里加载：此时左侧表单还是上一个生成器的参数，等 formReady()
  },
  formReady() {
    W.stale = true;
    if (W.mode === '3d') loadModel();
  },
  getProject() {
    if (!hasContent()) return null;
    const edits = {};
    Object.entries(W.project.edits).forEach(([k, v]) => { if (v && v.length) edits[k] = v; });
    return { disabled: [...W.project.disabled], edits };
  },
  setProject(p) {
    W.project = { disabled: [...(p.disabled || [])], edits: JSON.parse(JSON.stringify(p.edits || {})) };
    W.stale = true;
    if (W.mode === '3d') loadModel();
  },
  hasContent,
  paramsChanged: debounce(() => {
    W.stale = true;
    if (W.mode === '3d') loadModel();
  }, 600),
  refresh() { W.stale = true; if (W.mode === '3d') loadModel(); },
  get mode() { return W.mode; },
};

// ------------------------------------------------------------------ 绑定

$('#tab-2d').addEventListener('click', () => setMode('2d'));
$('#tab-3d').addEventListener('click', () => setMode('3d'));
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => view && view.view(b.dataset.view)));
$('#pe-close').addEventListener('click', closeEditor);
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', async () => {
  if (b.dataset.tool === 'text' && !W.fonts) W.fonts = await api().list_fonts();
  addEdit(b.dataset.tool);
}));
