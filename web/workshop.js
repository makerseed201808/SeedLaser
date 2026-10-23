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
  multi: new Set(),        // 摆放模式下的多选（W.selected 为主选）
  pose: { on: false, report: null, undo: [], redo: [], snap: 1 },
};

function freshProject() { return { disabled: [], edits: {}, poses: {} }; }

// 板件当前摆放矩阵：手动摆放过的优先
function poseOf(p) { return (W.project.poses && W.project.poses[p.id]) || p.matrix; }
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
    el.addEventListener('pointerdown', (ev) => { down = ev.button === 0 ? [ev.clientX, ev.clientY] : null; });
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
    // 板件清单展开时，画面中心右移半个清单宽，避免模型和手柄被挡住
    const panel = document.getElementById('parts-panel');
    const off = panel && !panel.classList.contains('collapsed') && panel.offsetWidth && w > 700 ? (panel.offsetWidth + 12) / 2 : 0;
    if (off) this.camera.setViewOffset(w, h, -off, 0, w, h); else this.camera.clearViewOffset();
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
    if (this.onPick) this.onPick(id, ev);
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
    group.matrix.fromArray(poseOf(p));
    this.root.add(group);
    this.objects.set(p.id, { group, mesh, edges, mat, color, part: p });
  }

  refreshStates() {
    const dis = new Set(W.project.disabled);
    this.objects.forEach((o, id) => {
      const off = dis.has(id);
      o.mat.transparent = off;
      o.mat.opacity = off ? 0.12 : 1;
      o.mat.depthWrite = !off;
      const sel = id === W.selected || W.multi.has(id);
      const bad = W.pose.report && W.pose.report[id] && W.pose.report[id].collide.length > 0;
      const hov = W.pose.on && W.pose.hover === id && !sel;
      o.mat.emissive.setHex(bad ? 0xff2020 : sel ? SELECT_COLOR : hov ? 0x2f80ed : 0x000000);
      o.mat.emissiveIntensity = bad ? 0.5 : sel ? 0.3 : hov ? 0.12 : 0;
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
  head.innerHTML = `<span>板件清单</span><span class="pp-count">${m.parts.length} 片 · 启用 ${on}</span>` +
    `<button class="pp-fold" title="收起 / 展开">${panel.classList.contains('collapsed') ? '▸' : '▾'}</button>`;
  head.querySelector('.pp-fold').addEventListener('click', () => {
    panel.classList.toggle('collapsed');
    renderPartsPanel();
    if (view) view.resize();
  });
  panel.appendChild(head);
  m.parts.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pp-row' + (p.id === W.selected ? ' sel' : '') + (dis.has(p.id) ? ' off' : '');
    const n = (W.project.edits[p.id] || []).length;
    const rep = W.pose.on && W.pose.report && W.pose.report[p.id];
    const badge = !rep || dis.has(p.id) ? ''
      : rep.collide.length ? `<i class="pp-bad" title="与 ${esc(rep.collide.map(nameOf).join('、'))} 穿透">穿透 ${rep.collide.length}</i>`
      : rep.touch.length ? `<i class="pp-ok" title="与 ${esc(rep.touch.map(nameOf).join('、'))} 咬合">咬合 ${rep.touch.length}</i>`
      : '<i class="pp-free" title="没有和其他板接触">未接触</i>';
    const moved = W.project.poses && W.project.poses[p.id] ? '<b class="pp-moved" title="手动摆放过">✋</b>' : '';
    row.className += W.multi.has(p.id) ? ' sel' : '';
    row.innerHTML = `
      <span class="pp-chip" style="background:#${WOOD[i % WOOD.length].toString(16)}">${String.fromCharCode(65 + (i % 26))}</span>
      <span class="pp-name" title="${esc(p.name)}">${moved}${esc(p.name)}${n ? `<em>${n}</em>` : ''}${badge}</span>
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
  if (W.pose.on) {
    const bar = document.createElement('div');
    bar.className = 'pp-posebar';
    bar.innerHTML = '<button id="pose-reset-sel">所选复位</button><button id="pose-reset-all">全部复位</button>';
    panel.appendChild(bar);
    bar.querySelector('#pose-reset-sel').addEventListener('click', () => resetPoses(false));
    bar.querySelector('#pose-reset-all').addEventListener('click', () => resetPoses(true));
  }
  const tip = document.createElement('div');
  tip.className = 'pp-tip';
  tip.textContent = W.pose.on ? '点选板件后拖动摆放；Shift+点击多选' : '双击 3D 里的板件也可以编辑';
  panel.appendChild(tip);
}

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function nameOf(id) {
  const p = W.model && W.model.parts.find((q) => q.id === id);
  return p ? p.name : id;
}

function select(id, add, keepMulti) {
  if (keepMulti) {
    /* 框选：W.multi 已设好 */
  } else if (add && id) {
    if (W.multi.has(id)) W.multi.delete(id); else W.multi.add(id);
    if (W.selected && W.selected !== id) W.multi.add(W.selected);
    W.selected = W.multi.size ? [...W.multi][W.multi.size - 1] : null;
  } else {
    W.multi.clear();
    if (id) W.multi.add(id);
    W.selected = id;
  }
  if (W.pose.on && poser) poser.updateGizmo();
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
let poser = null;

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
    view.onPick = (id, ev) => select(id, ev && ev.shiftKey);
    view.onEdit = (id) => openEditor(id);
    poser = new Poser(view);
    poser.applyMouseMapping(W.pose.on);
  }
  view.setModel(m);
  W.multi.clear();
  if (W.selected && !m.parts.some((q) => q.id === W.selected)) W.selected = null;
  if (W.selected) W.multi.add(W.selected);
  W.pose.report = null;
  renderPartsPanel();
  view.resize();          // 清单宽度确定后再算画面偏移
  if (W.pose.on) { poser.updateGizmo(); checkPose(); }
  if (W.pose.on && Object.keys(W.project.poses || {}).length && W.paramsDirty) {
    setNote('参数已改变，手动摆放过的板件位置可能需要重新调整（可点「全部复位」）。', 'info');
    W.paramsDirty = false;
  } else if (!m.parts.length) setNote('这个生成器没有可识别的闭合板件，无法生成 3D 模型。', 'info');
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


// ------------------------------------------------------------------ 手动摆放（仿 Tinkercad）
//
// 坐标都在 root 局部空间（即 boxes 世界坐标：x 右、y 后、z 上，单位 mm）。
// 摆放结果存在 W.project.poses[id]（16 位列主序矩阵），只影响 3D 显示，不影响导出图纸。

const AXIS_COLORS = { x: 0xe5484d, y: 0x30a46c, z: 0x2f80ed };
const GUIDE_COLOR = 0x00b8d9;
const ROT_SNAP = 45;          // 与 Tinkercad / SketchForge 一致：45°，Shift 22.5°
const ROT_SNAP_FINE = 22.5;

const _v = new THREE.Vector3();

class Poser {
  constructor(v) {
    this.v = v;
    this.gizmo = new THREE.Group();      // 手柄（root 局部坐标）
    this.guides = new THREE.Group();     // 吸附参考线 / 量角器
    this.gizmo.visible = false;
    v.root.add(this.gizmo);
    v.root.add(this.guides);
    this.handles = [];
    this.drag = null;
    this.marquee = null;
    this.hover = null;
    this.label = document.createElement('div');
    this.label.className = 'pose-label hidden';
    v.host.appendChild(this.label);
    this.box = document.createElement('div');
    this.box.className = 'pose-marquee hidden';
    v.host.appendChild(this.box);
    const el = v.renderer.domElement;
    // 捕获阶段先于 OrbitControls / 普通点选处理
    el.addEventListener('pointerdown', (ev) => this.onDown(ev), { capture: true });
    el.addEventListener('pointermove', (ev) => this.onMove(ev));
    el.addEventListener('pointerup', (ev) => this.onUp(ev));
    el.addEventListener('pointerleave', () => this.setHover(null));
    // 相机变化后手柄保持固定的屏幕大小、朝向相机一侧
    let raf = 0;
    v.controls.addEventListener('change', () => {
      if (!W.pose.on || this.drag || raf) return;
      raf = requestAnimationFrame(() => { raf = 0; this.updateGizmo(); });
    });
  }

  // ---- 鼠标分工（仿 Tinkercad）：左键选择 / 拖动，右键转视角，中键或 Ctrl+左键平移 ----
  applyMouseMapping(on) {
    const c = this.v.controls;
    c.mouseButtons = on
      ? { LEFT: null, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE }
      : { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    c.zoomToCursor = true;
    c.screenSpacePanning = true;
  }

  // ---- 坐标工具 ----
  ndc(ev) {
    const r = this.v.renderer.domElement.getBoundingClientRect();
    return new THREE.Vector2(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  }

  localRay(ev) {
    const v = this.v;
    v.raycaster.setFromCamera(this.ndc(ev), v.camera);
    const inv = new THREE.Matrix4().copy(v.root.matrixWorld).invert();
    return v.raycaster.ray.clone().applyMatrix4(inv);
  }

  toScreen(local) {
    const w = this.v.root.localToWorld(local.clone()).project(this.v.camera);
    const r = this.v.renderer.domElement.getBoundingClientRect();
    return [(w.x + 1) / 2 * r.width, (1 - w.y) / 2 * r.height];
  }

  // 1 屏幕像素对应多少 mm（在 point 附近）
  mmPerPixel(local) {
    const cam = this.v.camera;
    const w = this.v.root.localToWorld(local.clone());
    const dist = cam.position.distanceTo(w);
    const h = this.v.renderer.domElement.clientHeight || 1;
    return 2 * dist * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) / h;
  }

  camLocal() {
    return this.v.root.worldToLocal(this.v.camera.position.clone());
  }

  selectedIds() {
    const ids = new Set(W.multi);
    if (W.selected) ids.add(W.selected);
    return [...ids].filter((id) => this.v.objects.has(id));
  }

  partBox(id, matrix) {
    const o = this.v.objects.get(id);
    o.mesh.geometry.computeBoundingBox();
    return o.mesh.geometry.boundingBox.clone().applyMatrix4(matrix || o.group.matrix);
  }

  selBox(ids) {
    const box = new THREE.Box3();
    ids.forEach((id) => box.union(this.partBox(id)));
    return box;
  }

  floorZ() {
    const box = new THREE.Box3();
    const dis = new Set(W.project.disabled);
    this.v.objects.forEach((o, id) => { if (id !== 'reference' && !dis.has(id)) box.union(this.partBox(id)); });
    return box.isEmpty() ? 0 : box.min.z;
  }

  // ---- 手柄：小巧、固定屏幕大小、放在朝相机的一侧 ----
  updateGizmo() {
    disposeChildren(this.gizmo);
    this.handles = [];
    const ids = W.pose.on ? this.selectedIds() : [];
    if (!ids.length || (this.drag && this.drag.mode === 'rot')) { this.gizmo.visible = !!(this.drag && ids.length); if (!ids.length) this.gizmo.visible = false; return; }
    const box = this.selBox(ids);
    const c = box.getCenter(new THREE.Vector3());
    const s = this.mmPerPixel(c);                 // 1px 的 mm 数
    const cam = this.camLocal();
    const sx = cam.x >= c.x ? 1 : -1;             // 朝相机的一侧
    const sy = cam.y >= c.y ? 1 : -1;
    const near = new THREE.Vector3(sx > 0 ? box.max.x : box.min.x, sy > 0 ? box.max.y : box.min.y, 0);
    const mat = (color, opacity = 1) => new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true, opacity });
    const add = (obj, kind, axis) => {
      obj.renderOrder = 999;
      obj.userData = { kind, axis };
      this.gizmo.add(obj);
      if (kind) this.handles.push(obj);
      return obj;
    };
    // 选中框（细线）
    const bx = new THREE.Box3Helper(box, 0x2f80ed);
    bx.material.depthTest = false; bx.material.transparent = true; bx.material.opacity = 0.55;
    add(bx);
    // 台面投影
    const fz = this.floorZ();
    const pts = [[box.min.x, box.min.y], [box.max.x, box.min.y], [box.max.x, box.max.y], [box.min.x, box.max.y], [box.min.x, box.min.y]]
      .map(([x, y]) => new THREE.Vector3(x, y, fz - 0.3));
    const foot = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineDashedMaterial({ color: 0x2f80ed, dashSize: 6 * s, gapSize: 4 * s }));
    foot.computeLineDistances();
    add(foot);
    // 升降：顶部黑色小锥体 + 虚线
    const coneH = 22 * s;
    const cone = add(new THREE.Mesh(new THREE.ConeGeometry(coneH * 0.42, coneH, 20), mat(0x1f2933)), 'lift', 'z');
    cone.rotation.x = Math.PI / 2;
    cone.position.set(c.x, c.y, box.max.z + 46 * s + coneH / 2);
    const coneHit = add(new THREE.Mesh(new THREE.SphereGeometry(coneH * 0.7, 8, 8), mat(0x000000, 0)), 'lift', 'z');
    // 锥体到选中框顶部的虚线
    const stem = new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(c.x, c.y, box.max.z), new THREE.Vector3(c.x, c.y, cone.position.z - coneH / 2)]),
      new THREE.LineDashedMaterial({ color: 0x1f2933, dashSize: 4 * s, gapSize: 3 * s, depthTest: false }));
    stem.computeLineDistances();
    add(stem);
    coneHit.position.copy(cone.position);
    // 旋转：三段短弧 + 箭头（各自在旋转平面内，靠相机一侧）
    const R = 26 * s;
    const gap = 16 * s;
    const arcSpec = {
      z: { pos: new THREE.Vector3(near.x + sx * gap, near.y + sy * gap, box.min.z), rot: new THREE.Euler(0, 0, 0) },
      // X / Y 弧放在顶部、朝相机两侧的边上，并错开中心，避免和升降锥重叠
      x: { pos: new THREE.Vector3(near.x + sx * gap, c.y + sy * (box.max.y - box.min.y) * 0.3, box.max.z + gap), rot: new THREE.Euler(0, Math.PI / 2, 0) },
      y: { pos: new THREE.Vector3(c.x - sx * (box.max.x - box.min.x) * 0.3, near.y + sy * gap, box.max.z + gap), rot: new THREE.Euler(Math.PI / 2, 0, 0) },
    };
    Object.entries(arcSpec).forEach(([axis, spec]) => {
      const g = new THREE.Group();
      g.position.copy(spec.pos);
      g.rotation.copy(spec.rot);
      const arc = new THREE.Mesh(new THREE.TorusGeometry(R, 2.2 * s, 6, 24, Math.PI * 0.7), mat(AXIS_COLORS[axis]));
      arc.rotation.z = Math.PI * 0.15;
      const tip = new THREE.Mesh(new THREE.ConeGeometry(6 * s, 13 * s, 12), mat(AXIS_COLORS[axis]));
      const a = Math.PI * 0.85;
      tip.position.set(Math.cos(a) * R, Math.sin(a) * R, 0);
      tip.rotation.z = a;
      const hit = new THREE.Mesh(new THREE.TorusGeometry(R, 6 * s, 6, 16, Math.PI * 0.8), mat(0x000000, 0));
      hit.rotation.z = Math.PI * 0.1;
      [arc, tip, hit].forEach((m) => { m.renderOrder = 999; m.userData = { kind: 'rot', axis }; g.add(m); this.handles.push(m); });
      add(g);
    });
    this.gizmo.visible = true;
  }

  hitHandle(ev) {
    if (!this.gizmo.visible || !this.handles.length) return null;
    this.v.root.updateMatrixWorld(true);
    this.v.raycaster.setFromCamera(this.ndc(ev), this.v.camera);
    const hits = this.v.raycaster.intersectObjects(this.handles, false);
    return hits.length ? hits[0] : null;
  }

  hitPart(ev) {
    this.v.raycaster.setFromCamera(this.ndc(ev), this.v.camera);
    const dis = new Set(W.project.disabled);
    const meshes = [...this.v.objects.entries()].filter(([id]) => !dis.has(id)).map(([, o]) => o.mesh);
    const hits = this.v.raycaster.intersectObjects(meshes, false);
    return hits.length ? hits[0] : null;
  }

  setHover(id) {
    if (this.hover === id) return;
    this.hover = id;
    W.pose.hover = id;
    this.v.refreshStates();
  }

  // ---- 按下 ----
  onDown(ev) {
    if (!W.pose.on) return;
    const c = this.v.controls;
    // Ctrl/⌘ + 左键：平移视角（与 SketchForge 一致）
    c.mouseButtons.LEFT = ev.button === 0 && (ev.ctrlKey || ev.metaKey) ? THREE.MOUSE.PAN : null;
    if (ev.button !== 0 || ev.ctrlKey || ev.metaKey) return;
    ev.stopImmediatePropagation();
    ev.preventDefault();
    const el = this.v.renderer.domElement;
    const h = this.hitHandle(ev);
    let mode = null;
    if (h) {
      mode = h.object.userData.kind;
    } else {
      const ph = this.hitPart(ev);
      if (!ph) {
        // 空白处：框选
        const r = el.getBoundingClientRect();
        this.marquee = { x0: ev.clientX - r.left, y0: ev.clientY - r.top, x1: ev.clientX - r.left, y1: ev.clientY - r.top, add: ev.shiftKey, moved: false };
        el.setPointerCapture(ev.pointerId);
        return;
      }
      const id = ph.object.userData.partId;
      if (ev.shiftKey) { select(id, true); return; }
      if (!W.multi.has(id)) select(id);
      mode = 'move';
    }
    c.enabled = false;
    el.setPointerCapture(ev.pointerId);
    const ids = this.selectedIds();
    const start = {};
    ids.forEach((pid) => { start[pid] = this.v.objects.get(pid).group.matrix.clone(); });
    const ray = this.localRay(ev);
    const box0 = this.selBox(ids);
    const center = box0.getCenter(new THREE.Vector3());
    const d = { mode, ids, start, center, box0, moved: false, axis: h && h.object.userData.axis, targets: this.snapTargets(ids) };
    if (mode === 'move') {
      const ph = this.hitPart(ev);
      const z0 = ph ? this.v.root.worldToLocal(ph.point.clone()).z : center.z;
      d.plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), -z0);
      d.p0 = ray.intersectPlane(d.plane, new THREE.Vector3()) || center.clone();
      el.style.cursor = 'grabbing';
    } else if (mode === 'lift') {
      const cam = this.camLocal();
      const n = new THREE.Vector3(cam.x - center.x, cam.y - center.y, 0);
      if (n.lengthSq() < 1e-6) n.set(0, -1, 0);
      n.normalize();
      d.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(n, center);
      d.p0 = ray.intersectPlane(d.plane, new THREE.Vector3()) || center.clone();
    } else if (mode === 'rot') {
      const ax = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) }[d.axis];
      d.axisVec = ax;
      d.plane = new THREE.Plane().setFromNormalAndCoplanarPoint(ax, center);
      const p = ray.intersectPlane(d.plane, new THREE.Vector3());
      d.v0 = p ? p.sub(center) : null;
      d.radius = Math.max(box0.getSize(new THREE.Vector3()).length() * 0.5, 20);
      this.gizmo.visible = false;
    }
    pushUndo();
    this.drag = d;
  }

  // 其余板件的包围盒边界：拖动时用来对齐吸附
  snapTargets(ids) {
    const set = new Set(ids);
    const dis = new Set(W.project.disabled);
    const t = { x: [], y: [], z: [] };
    this.v.objects.forEach((o, id) => {
      if (set.has(id) || dis.has(id) || id === 'reference') return;
      const b = this.partBox(id);
      ['x', 'y', 'z'].forEach((k) => t[k].push({ v: b.min[k], box: b }, { v: b.max[k], box: b }));
    });
    return t;
  }

  // ---- 拖动 ----
  onMove(ev) {
    if (this.marquee) { this.updateMarquee(ev); return; }
    const d = this.drag;
    if (!d) {
      if (!W.pose.on) return;
      const el = this.v.renderer.domElement;
      const h = this.hitHandle(ev);
      const ph = h ? null : this.hitPart(ev);
      el.style.cursor = h ? 'pointer' : ph ? 'grab' : '';
      this.setHover(ph ? ph.object.userData.partId : null);
      return;
    }
    const ray = this.localRay(ev);
    const step = snapStep();
    let T = new THREE.Matrix4();
    let text = '';
    disposeChildren(this.guides);
    if (d.mode === 'move' || d.mode === 'lift') {
      const p = ray.intersectPlane(d.plane, new THREE.Vector3());
      if (!p) return;
      const delta = p.sub(d.p0);
      const thr = 8 * this.mmPerPixel(d.center);          // 吸附阈值：约 8 像素
      const snapped = { x: false, y: false, z: false };
      const axes = d.mode === 'move' ? ['x', 'y'] : ['z'];
      if (d.mode === 'move') delta.z = 0; else { delta.x = 0; delta.y = 0; }
      axes.forEach((k) => {
        // 先尝试对齐其他板的边界，否则按网格
        let best = null;
        [d.box0.min[k], d.box0.max[k]].forEach((edge) => {
          d.targets[k].forEach((tg) => {
            const diff = tg.v - (edge + delta[k]);
            if (Math.abs(diff) <= thr && (!best || Math.abs(diff) < Math.abs(best.diff))) best = { diff, tg, at: tg.v };
          });
        });
        if (best && !ev.altKey) {
          delta[k] += best.diff;
          snapped[k] = true;
          this.drawGuide(k, best.at, d.box0, delta, best.tg.box);
        } else {
          delta[k] = snapTo(delta[k], step);
        }
      });
      text = d.mode === 'move'
        ? `X ${fmtSigned(delta.x)} · Y ${fmtSigned(delta.y)} mm${snapped.x || snapped.y ? ' · 对齐' : ''}`
        : `高度 ${fmtSigned(delta.z)} mm${snapped.z ? ' · 对齐' : ''}`;
      T.makeTranslation(delta.x, delta.y, delta.z);
    } else if (d.mode === 'rot' && d.v0) {
      const p = ray.intersectPlane(d.plane, new THREE.Vector3());
      if (!p) return;
      const v1 = p.sub(d.center);
      const cross = new THREE.Vector3().crossVectors(d.v0, v1).dot(d.axisVec);
      let ang = THREE.MathUtils.radToDeg(Math.atan2(cross, d.v0.dot(v1)));
      const step = ev.shiftKey ? ROT_SNAP_FINE : ROT_SNAP;
      ang = Math.round(ang / step) * step;
      text = `${'XYZ'['xyz'.indexOf(d.axis)]} 轴 ${ang > 0 ? '+' : ''}${ang}°`;
      this.drawProtractor(d, ang, ev.shiftKey ? ROT_SNAP_FINE : ROT_SNAP);
      const rad = THREE.MathUtils.degToRad(ang);
      T = new THREE.Matrix4().makeTranslation(d.center.x, d.center.y, d.center.z)
        .multiply(new THREE.Matrix4().makeRotationAxis(d.axisVec, rad))
        .multiply(new THREE.Matrix4().makeTranslation(-d.center.x, -d.center.y, -d.center.z));
    }
    // 装配位磁吸：单块板接近它原本的装配位置时直接吸过去
    if (d.ids.length === 1 && d.mode !== 'rot') {
      const p = W.model.parts.find((q) => q.id === d.ids[0]);
      const home = new THREE.Matrix4().fromArray(p.matrix);
      const cand = T.clone().multiply(d.start[d.ids[0]]);
      if (matricesClose(cand, home, 4)) {
        T = home.clone().multiply(d.start[d.ids[0]].clone().invert());
        text = '吸附到装配位置';
      }
    }
    d.moved = true;
    d.ids.forEach((pid) => {
      const o = this.v.objects.get(pid);
      o.group.matrix.copy(T.clone().multiply(d.start[pid]));
      o.group.matrixWorldNeedsUpdate = true;
    });
    if (d.mode !== 'rot') this.updateGizmo();
    this.showLabel(ev, text);
  }

  drawGuide(axis, at, box0, delta, targetBox) {
    const b = box0.clone().translate(delta);
    const u = b.clone().union(targetBox);
    const pad = 6;
    const pts = [];
    if (axis === 'x') pts.push(new THREE.Vector3(at, u.min.y - pad, u.min.z), new THREE.Vector3(at, u.max.y + pad, u.min.z),
                               new THREE.Vector3(at, u.min.y - pad, u.max.z), new THREE.Vector3(at, u.max.y + pad, u.max.z));
    if (axis === 'y') pts.push(new THREE.Vector3(u.min.x - pad, at, u.min.z), new THREE.Vector3(u.max.x + pad, at, u.min.z),
                               new THREE.Vector3(u.min.x - pad, at, u.max.z), new THREE.Vector3(u.max.x + pad, at, u.max.z));
    if (axis === 'z') pts.push(new THREE.Vector3(u.min.x - pad, u.min.y, at), new THREE.Vector3(u.max.x + pad, u.min.y, at),
                               new THREE.Vector3(u.min.x - pad, u.max.y, at), new THREE.Vector3(u.max.x + pad, u.max.y, at));
    const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: GUIDE_COLOR, depthTest: false, transparent: true }));
    line.renderOrder = 998;
    this.guides.add(line);
  }

  // 旋转时的量角器：整圈刻度 + 当前角度扇形
  drawProtractor(d, ang, step) {
    const g = new THREE.Group();
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, 1), d.axisVec);
    g.quaternion.copy(q);
    g.position.copy(d.center);
    const R = d.radius;
    const color = AXIS_COLORS[d.axis];
    const ring = [];
    for (let i = 0; i <= 96; i++) { const a = i / 96 * Math.PI * 2; ring.push(new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0)); }
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(ring), new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true, opacity: 0.8 })));
    const ticks = [];
    for (let deg = 0; deg < 360; deg += step) {
      const a = THREE.MathUtils.degToRad(deg);
      const r0 = deg % 90 === 0 ? R * 0.84 : R * 0.92;
      ticks.push(new THREE.Vector3(Math.cos(a) * r0, Math.sin(a) * r0, 0), new THREE.Vector3(Math.cos(a) * R, Math.sin(a) * R, 0));
    }
    g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(ticks), new THREE.LineBasicMaterial({ color, depthTest: false })));
    // 起始方向（v0 投影到量角器平面）
    const inv = q.clone().invert();
    const v0 = d.v0.clone().applyQuaternion(inv);
    const a0 = Math.atan2(v0.y, v0.x);
    const a1 = a0 + THREE.MathUtils.degToRad(ang);
    const fan = new THREE.Shape();
    fan.moveTo(0, 0);
    const n = Math.max(2, Math.ceil(Math.abs(ang) / 5));
    for (let i = 0; i <= n; i++) { const a = a0 + (a1 - a0) * i / n; fan.lineTo(Math.cos(a) * R * 0.8, Math.sin(a) * R * 0.8); }
    fan.lineTo(0, 0);
    g.add(new THREE.Mesh(new THREE.ShapeGeometry(fan), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.18, depthTest: false, side: THREE.DoubleSide })));
    g.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3(Math.cos(a1) * R, Math.sin(a1) * R, 0)]),
      new THREE.LineBasicMaterial({ color, depthTest: false })));
    g.traverse((o) => { o.renderOrder = 998; });
    this.guides.add(g);
  }

  updateMarquee(ev) {
    const m = this.marquee;
    const r = this.v.renderer.domElement.getBoundingClientRect();
    m.x1 = ev.clientX - r.left;
    m.y1 = ev.clientY - r.top;
    if (Math.hypot(m.x1 - m.x0, m.y1 - m.y0) > 4) m.moved = true;
    if (!m.moved) return;
    Object.assign(this.box.style, {
      left: `${Math.min(m.x0, m.x1)}px`, top: `${Math.min(m.y0, m.y1)}px`,
      width: `${Math.abs(m.x1 - m.x0)}px`, height: `${Math.abs(m.y1 - m.y0)}px`,
    });
    this.box.classList.remove('hidden');
  }

  finishMarquee() {
    const m = this.marquee;
    this.marquee = null;
    this.box.classList.add('hidden');
    if (!m.moved) { if (!m.add) select(null); return; }
    const x0 = Math.min(m.x0, m.x1), x1 = Math.max(m.x0, m.x1), y0 = Math.min(m.y0, m.y1), y1 = Math.max(m.y0, m.y1);
    const dis = new Set(W.project.disabled);
    const hit = [];
    this.v.objects.forEach((o, id) => {
      if (dis.has(id)) return;
      const b = this.partBox(id);
      let minx = Infinity, maxx = -Infinity, miny = Infinity, maxy = -Infinity;
      [b.min.x, b.max.x].forEach((x) => [b.min.y, b.max.y].forEach((y) => [b.min.z, b.max.z].forEach((z) => {
        const [sx, sy] = this.toScreen(new THREE.Vector3(x, y, z));
        minx = Math.min(minx, sx); maxx = Math.max(maxx, sx); miny = Math.min(miny, sy); maxy = Math.max(maxy, sy);
      })));
      if (maxx >= x0 && minx <= x1 && maxy >= y0 && miny <= y1) hit.push(id);
    });
    if (!m.add) { W.multi.clear(); W.selected = null; }
    hit.forEach((id) => W.multi.add(id));
    W.selected = hit.length ? hit[hit.length - 1] : W.selected;
    select(W.selected, false, true);
  }

  onUp(ev) {
    this.v.controls.mouseButtons.LEFT = W.pose.on ? null : THREE.MOUSE.ROTATE;
    if (this.marquee) { this.finishMarquee(); return; }
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    this.v.controls.enabled = true;
    this.v.renderer.domElement.style.cursor = '';
    this.label.classList.add('hidden');
    disposeChildren(this.guides);
    if (!d.moved) { W.pose.undo.pop(); this.updateGizmo(); return; }
    d.ids.forEach((pid) => this.commit(pid));
    this.updateGizmo();
    afterPoseChange();
  }

  commit(pid) {
    const o = this.v.objects.get(pid);
    const p = W.model.parts.find((q) => q.id === pid);
    W.project.poses = W.project.poses || {};
    // 回到装配位置时不再记录（等于复位）
    if (p && matricesClose(o.group.matrix, new THREE.Matrix4().fromArray(p.matrix), 0.01)) {
      delete W.project.poses[pid];
      return;
    }
    W.project.poses[pid] = o.group.matrix.toArray().map((x) => Math.round(x * 1e4) / 1e4);
  }

  applyAll(T) {
    const ids = this.selectedIds();
    if (!ids.length) return;
    pushUndo();
    ids.forEach((pid) => {
      const o = this.v.objects.get(pid);
      o.group.matrix.premultiply(T);
      o.group.matrixWorldNeedsUpdate = true;
      this.commit(pid);
    });
    this.updateGizmo();
    afterPoseChange();
  }

  showLabel(ev, text) {
    if (!text) return;
    const r = this.v.host.getBoundingClientRect();
    this.label.textContent = text;
    this.label.style.left = `${ev.clientX - r.left + 16}px`;
    this.label.style.top = `${ev.clientY - r.top - 30}px`;
    this.label.classList.remove('hidden');
  }

  screenAxes() {
    const cam = this.camLocal();
    const tgt = this.v.root.worldToLocal(this.v.controls.target.clone());
    const f = new THREE.Vector3(tgt.x - cam.x, tgt.y - cam.y, 0);
    if (f.lengthSq() < 1e-6) f.set(0, 1, 0);
    const fwd = Math.abs(f.x) > Math.abs(f.y) ? new THREE.Vector3(Math.sign(f.x), 0, 0) : new THREE.Vector3(0, Math.sign(f.y), 0);
    const right = new THREE.Vector3(fwd.y, -fwd.x, 0);
    return { fwd, right };
  }
}

function matricesClose(a, b, tol) {
  const ea = a.elements, eb = b.elements;
  for (let i = 0; i < 16; i++) {
    const lim = (i === 12 || i === 13 || i === 14) ? tol : 1e-3;
    if (Math.abs(ea[i] - eb[i]) > lim) return false;
  }
  return true;
}

function disposeChildren(group) {
  [...group.children].forEach((c) => { group.remove(c); disposeTree(c); });
}

function snapStep() {
  const v = W.pose.snap;
  if (v === 't') return (W.model && W.model.thickness) || 3;
  return Number(v) || 0;
}
function snapTo(x, step) { return step ? Math.round(x / step) * step : Math.round(x * 100) / 100; }
function fmtSigned(x) { const r = Math.round(x * 100) / 100; return (r > 0 ? '+' : '') + r; }

function pushUndo() {
  W.pose.undo.push(JSON.stringify(W.project.poses || {}));
  if (W.pose.undo.length > 60) W.pose.undo.shift();
  W.pose.redo = [];
}

function restorePoses(json) {
  W.project.poses = JSON.parse(json);
  if (!view || !W.model) return;
  W.model.parts.forEach((p) => {
    const o = view.objects.get(p.id);
    if (o) { o.group.matrix.fromArray(poseOf(p)); o.group.matrixWorldNeedsUpdate = true; }
  });
  if (poser) poser.updateGizmo();
  afterPoseChange();
}

function undoPose() {
  if (!W.pose.undo.length) return;
  W.pose.redo.push(JSON.stringify(W.project.poses || {}));
  restorePoses(W.pose.undo.pop());
}
function redoPose() {
  if (!W.pose.redo.length) return;
  W.pose.undo.push(JSON.stringify(W.project.poses || {}));
  restorePoses(W.pose.redo.pop());
}

function resetPoses(all) {
  pushUndo();
  const poses = { ...(W.project.poses || {}) };
  if (all) Object.keys(poses).forEach((k) => delete poses[k]);
  else poser.selectedIds().forEach((id) => delete poses[id]);
  restorePoses(JSON.stringify(poses));
}

let poseCheckSeq = 0;
const checkPose = debounce(async () => {
  if (!W.pose.on || !W.model || !W.model.token) return;
  const seq = ++poseCheckSeq;
  const dis = new Set(W.project.disabled);
  const ids = W.model.parts.map((p) => p.id).filter((id) => !dis.has(id) && id !== 'reference');
  const r = await api().check_pose(W.model.token, W.project.poses || {}, ids);
  if (seq !== poseCheckSeq) return;
  if (r.error) { setNote(r.error, 'error'); return; }
  W.pose.report = r.report;
  if (view) view.refreshStates();
  renderPartsPanel();
  // 汇总：全部咬合且连通？
  const rep = r.report;
  const bad = ids.filter((id) => rep[id] && rep[id].collide.length);
  // 连通分量：最大的一组视为主体
  const comp = new Map();
  let biggest = [];
  ids.forEach((start) => {
    if (comp.has(start)) return;
    const group = [];
    const stack = [start];
    while (stack.length) {
      const id = stack.pop();
      if (comp.has(id)) continue;
      comp.set(id, start);
      group.push(id);
      (rep[id] ? rep[id].touch.concat(rep[id].collide) : []).forEach((n) => { if (ids.includes(n)) stack.push(n); });
    }
    if (group.length > biggest.length) biggest = group;
  });
  const loose = ids.filter((id) => !biggest.includes(id));
  if (bad.length) setNote(`有 ${bad.length} 块板互相穿透（红色）：${bad.map(nameOf).join('、')}`, 'error');
  else if (!loose.length && ids.length > 1) setNote('✓ 所有板件都已咬合，没有穿透', 'ok');
  else setNote(`没有穿透；${loose.map(nameOf).join('、')} 还没有和主体连在一起`, 'info');
}, 150);

function afterPoseChange() {
  if (view) view.refreshStates();
  renderPartsPanel();
  checkPose();
}

function setPoseMode(on) {
  W.pose.on = on;
  $('#btn-pose').classList.toggle('on', on);
  $('#pose-snap').classList.toggle('hidden', !on);
  $('.view3d-hint').innerHTML = on
    ? '左键拖板件 · 右键转视角 · 中键平移 · 滚轮缩放 <button class="kbd-btn" id="kbd-btn">⌨ 快捷键</button>'
    : '拖动旋转 · 右键拖动平移 · 滚轮缩放 · 单击选中板件 · 双击编辑';
  const kb = document.getElementById('kbd-btn');
  if (kb) kb.addEventListener('click', () => $('#kbd-help').classList.toggle('hidden'));
  if (!on) $('#kbd-help').classList.add('hidden');
  if (poser) poser.applyMouseMapping(on);
  if (!on) { W.pose.hover = null; }
  if (!on) { W.pose.report = null; setNote(''); }
  if (poser) poser.updateGizmo();
  if (view) view.refreshStates();
  renderPartsPanel();
  if (on) checkPose();
}

document.addEventListener('keydown', (ev) => {
  if (!W.pose.on || W.mode !== '3d' || ED.part || !poser) return;
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement && document.activeElement.tagName)) return;
  const mod = ev.ctrlKey || ev.metaKey;
  if (mod && (ev.key === 'z' || ev.key === 'Z')) { ev.preventDefault(); if (ev.shiftKey) redoPose(); else undoPose(); return; }
  if (mod && (ev.key === 'y' || ev.key === 'Y')) { ev.preventDefault(); redoPose(); return; }
  if (ev.key === 'Escape') { select(null); return; }
  const ids = poser.selectedIds();
  if (!ids.length) return;
  const step = snapStep() || 1;
  const s = ev.shiftKey ? step * 10 : step;
  const { fwd, right } = poser.screenAxes();
  let T = null;
  if (mod && ev.key === 'ArrowUp') T = new THREE.Matrix4().makeTranslation(0, 0, s);
  else if (mod && ev.key === 'ArrowDown') T = new THREE.Matrix4().makeTranslation(0, 0, -s);
  else if (ev.key === 'ArrowUp') T = new THREE.Matrix4().makeTranslation(fwd.x * s, fwd.y * s, 0);
  else if (ev.key === 'ArrowDown') T = new THREE.Matrix4().makeTranslation(-fwd.x * s, -fwd.y * s, 0);
  else if (ev.key === 'ArrowRight') T = new THREE.Matrix4().makeTranslation(right.x * s, right.y * s, 0);
  else if (ev.key === 'ArrowLeft') T = new THREE.Matrix4().makeTranslation(-right.x * s, -right.y * s, 0);
  else if (ev.key === 'r' || ev.key === 'R') {
    const c = poser.selBox(ids).getCenter(new THREE.Vector3());
    T = new THREE.Matrix4().makeTranslation(c.x, c.y, c.z)
      .multiply(new THREE.Matrix4().makeRotationZ(ev.shiftKey ? -Math.PI / 2 : Math.PI / 2))
      .multiply(new THREE.Matrix4().makeTranslation(-c.x, -c.y, -c.z));
  } else if (ev.key === 'd' || ev.key === 'D') {
    const others = poser.floorZ();
    const box = poser.selBox(ids);
    T = new THREE.Matrix4().makeTranslation(0, 0, others - box.min.z);
  }
  if (T) { ev.preventDefault(); poser.applyAll(T); }
});

// ------------------------------------------------------------------ 对外接口（app.js 调用）

function hasContent() {
  return W.project.disabled.length > 0 || Object.values(W.project.edits).some((l) => l && l.length)
    || Object.keys(W.project.poses || {}).length > 0;
}

window.SeedWorkshop = {
  reset(name) {
    W.name = name;
    W.model = null;
    W.project = freshProject();
    W.selected = null;
    W.multi.clear();
    W.pose.report = null;
    W.pose.undo = []; W.pose.redo = [];
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
    return { disabled: [...W.project.disabled], edits, poses: { ...(W.project.poses || {}) } };
  },
  setProject(p) {
    W.project = { disabled: [...(p.disabled || [])], edits: JSON.parse(JSON.stringify(p.edits || {})),
                  poses: JSON.parse(JSON.stringify(p.poses || {})) };
    W.pose.undo = []; W.pose.redo = [];
    W.stale = true;
    if (W.mode === '3d') loadModel();
  },
  hasContent,
  paramsChanged: debounce(() => {
    W.stale = true;
    W.paramsDirty = true;
    if (W.mode === '3d') loadModel();
  }, 600),
  refresh() { W.stale = true; if (W.mode === '3d') loadModel(); },
  get mode() { return W.mode; },
};

// ------------------------------------------------------------------ 绑定

$('#tab-2d').addEventListener('click', () => setMode('2d'));
$('#tab-3d').addEventListener('click', () => setMode('3d'));
$('#btn-pose').addEventListener('click', () => setPoseMode(!W.pose.on));
$('#pose-snap select').addEventListener('change', (ev) => { W.pose.snap = ev.target.value; });
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => view && view.view(b.dataset.view)));
$('#pe-close').addEventListener('click', closeEditor);
document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', async () => {
  if (b.dataset.tool === 'text' && !W.fonts) W.fonts = await api().list_fonts();
  addEdit(b.dataset.tool);
}));

// 浏览器调试模式（?dev=1）下暴露内部状态，供自动化测试
if (new URLSearchParams(location.search).has('dev')) {
  window.__seedDebug = {
    W, THREE,
    get view() { return view; },
    get poser() { return poser; },
    // 板件在屏幕上的位置（像素，相对视口）
    screenOf(id) {
      const o = view.objects.get(id);
      o.mesh.geometry.computeBoundingBox();
      const c = o.mesh.geometry.boundingBox.getCenter(new THREE.Vector3()).applyMatrix4(o.mesh.matrixWorld);
      c.project(view.camera);
      const r = view.renderer.domElement.getBoundingClientRect();
      return [r.left + (c.x + 1) / 2 * r.width, r.top + (1 - c.y) / 2 * r.height];
    },
    handleScreen(kind, axis) {
      const h = poser.handles.find((m) => m.userData.kind === kind && (!axis || m.userData.axis === axis)
        && (kind !== 'rot' || m.geometry.type === 'ConeGeometry'));
      const c = new THREE.Vector3().setFromMatrixPosition(h.matrixWorld);
      c.project(view.camera);
      const r = view.renderer.domElement.getBoundingClientRect();
      return [r.left + (c.x + 1) / 2 * r.width, r.top + (1 - c.y) / 2 * r.height];
    },
  };
}
