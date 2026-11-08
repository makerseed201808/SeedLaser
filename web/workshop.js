// SeedLaser 工坊：3D 模型视图 + 板件清单 + 单块板 2D 编辑（开孔 / 刻字）
// 坐标约定见 model3d.py：后端给出每块板「名义坐标系」轮廓和 4×4 摆放矩阵（x 右、y 后、z 上）。
// 编辑（edit）存在「从外面看」坐标系：原点 = 内部矩形左下角，单位 mm，y 向上。
import * as THREE from './vendor/three/three.module.min.js';
import { OrbitControls } from './vendor/three/OrbitControls.js';
import { SketchEditor, sketchPolys, flattenPath } from './sketch2d.js';
import { FIT_SQ, FIT_STEPS, FIT_LADDER, ladderSlots, fitResult, stepLabel } from './fit-calc.js';

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

function freshProject() { return { disabled: [], edits: {}, poses: {}, sketches: {}, free: null }; }
const isFree = () => W.name === 'FreeDesign';

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

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
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
    if (hits.length) return hits[0].object.userData.partId;
    // 不在板里的线（画在台面上）：按屏幕上约 6 像素的范围拾取
    if (this.overlay && this.overlay.children.length) {
      const d = this.camera.position.distanceTo(this.controls.target);
      this.raycaster.params.Line = { threshold: d * Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * 2 / (r.height || 1) * 6 };
      const lh = this.raycaster.intersectObjects(this.overlay.children.filter((o) => o.userData.itemId), false);
      if (lh.length) return `loose:${lh[0].object.userData.itemId}`;
    }
    return null;
  }

  pick(ev) {
    const id = this.hit(ev);
    if (this.onPick) this.onPick(id, ev);
  }

  clear() {
    this.objects.forEach((o) => { this.root.remove(o.group); disposeTree(o.group); });
    this.objects.clear();
  }

  setModel(model, overlay) {
    this.clear();
    model.parts.forEach((p, i) => this.buildPart(p, model.thickness, i));
    this.setOverlay(overlay);
    this.refreshStates();
    this.fit(model);
  }

  // 台面上的二维线条（自由设计里不在任何板件里的图形）：[{ id, pts: [[x,y]...], color }]，画板坐标 = 台面坐标
  setOverlay(list) {
    if (this.overlay) { this.root.remove(this.overlay); disposeTree(this.overlay); this.overlay = null; }
    if (!list || !list.length) return;
    const g = new THREE.Group();
    list.forEach((L) => {
      const geo = new THREE.BufferGeometry().setFromPoints(L.pts.map(([x, y]) => new THREE.Vector3(x, y, 0.3)));
      const mat = L.dash ? new THREE.LineDashedMaterial({ color: L.color, dashSize: L.dash, gapSize: L.dash * 0.6 })
        : new THREE.LineBasicMaterial({ color: L.color });
      const line = new THREE.Line(geo, mat);
      if (L.dash) line.computeLineDistances();
      line.userData.itemId = L.id;
      g.add(line);
    });
    this.overlay = g;
    this.root.add(g);
  }

  buildPart(p, t, i) {
    const old = this.objects.get(p.id);
    if (old) { this.root.remove(old.group); disposeTree(old.group); }
    const sk = sketchOf(p.id);
    if (sk) return this.buildSketchPart(p, t, i, sk);
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

  // 有二维草图的板：切割闭合路径按奇偶嵌套成实体（可能有多块），雕刻画在外表面
  buildSketchPart(p, t, i, sk) {
    const sp = sketchPolys(sk);
    const shapes = nestContours(sp.cut.map((pl) => toLocal(p, pl))).map((s) => {
      const sh = new THREE.Shape(s.outer.map(v2));
      s.holes.forEach((h) => sh.holes.push(new THREE.Path(h.map(v2))));
      return sh;
    });
    const color = WOOD[i % WOOD.length];
    const mat = new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, side: THREE.DoubleSide });
    let geo;
    try {
      geo = new THREE.ExtrudeGeometry(shapes, { depth: t, bevelEnabled: false, curveSegments: 1, steps: 1 });
    } catch (e) {
      geo = new THREE.BufferGeometry();
    }
    const mesh = new THREE.Mesh(geo, mat);
    mesh.userData.partId = p.id;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo, 25),
      new THREE.LineBasicMaterial({ color: 0x7a5530, transparent: true, opacity: 0.55 }));
    const group = new THREE.Group();
    group.add(mesh, edges);
    const zTop = t + 0.05;
    const engr = nestContours(sp.engrave.map((pl) => toLocal(p, pl)));
    if (engr.length) {
      const es = engr.map((s) => { const sh = new THREE.Shape(s.outer.map(v2)); s.holes.forEach((h) => sh.holes.push(new THREE.Path(h.map(v2)))); return sh; });
      const em = new THREE.Mesh(new THREE.ShapeGeometry(es, 1),
        new THREE.MeshBasicMaterial({ color: ENGRAVE_COLOR, side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -2 }));
      em.position.z = zTop;
      group.add(em);
    }
    const lines = [...sp.lines, ...sp.open].map((pl) => toLocal(p, pl));
    if (lines.length) {
      const pos = [];
      lines.forEach((pl) => { for (let k = 0; k + 1 < pl.length; k++) pos.push(pl[k][0], pl[k][1], zTop, pl[k + 1][0], pl[k + 1][1], zTop); });
      const lg = new THREE.BufferGeometry();
      lg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
      group.add(new THREE.LineSegments(lg, new THREE.LineBasicMaterial({ color: 0x9d2bb5 })));
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
    if (!model.assembled && this.overlay) box.expandByObject(this.overlay);     // 二维总览：散落的线也要框进来
    if (box.isEmpty()) this.objects.forEach((o) => box.expandByObject(o.mesh));
    if (box.isEmpty()) return;
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const radius = size.length() / 2 + 10;
    const fovV = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const fovH = Math.atan(Math.tan(fovV) * this.camera.aspect);
    const dist = radius / Math.sin(Math.min(fovV, fovH)) * 1.2;
    // 二维画板右下角的预览 = 图纸总览：接近俯视
    const dir = this.topDown ? new THREE.Vector3(0, 1, 0.32)
      : model.assembled ? new THREE.Vector3(0.75, 0.62, 1.0) : new THREE.Vector3(0.2, 1.4, 0.9);
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
    if (this.overlay) all.expandByObject(this.overlay);
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
  if (isFree()) { renderAssemblePanel(panel); if (W.stage === 'make') renderMakePanel(); return; }
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
  if (isFree()) panel.appendChild(freePartForm());
  panel.classList.toggle('free', isFree());
  m.parts.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pp-row' + (p.id === W.selected ? ' sel' : '') + (dis.has(p.id) ? ' off' : '');
    const n = sketchOf(p.id) ? '✎' : (W.project.edits[p.id] || []).length;
    const rep = W.pose.report && W.pose.report[p.id];
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
      <button class="pp-edit" title="二维草图编辑">编辑</button>` +
      (isFree() ? `<button class="pp-mini" data-free="dup" title="复制这块板">⧉</button><button class="pp-mini" data-free="del" title="删除这块板">✕</button>` : '');
    row.addEventListener('click', (ev) => {
      if (ev.target.closest('.pp-use') || ev.target.closest('.pp-edit') || ev.target.closest('.pp-mini') || ev.target.closest('input')) return;
      select(p.id === W.selected ? null : p.id);
    });
    row.querySelector('input').addEventListener('change', (ev) => setEnabled(p.id, ev.target.checked));
    row.querySelector('.pp-edit').addEventListener('click', () => openEditor(p.id));
    if (isFree()) {
      row.querySelector('[data-free=dup]').addEventListener('click', () => freeDuplicate(p.id));
      row.querySelector('[data-free=del]').addEventListener('click', (ev) => freeDelete(p.id, ev.currentTarget));
      row.querySelector('.pp-name').addEventListener('dblclick', () => freeRename(p.id, row.querySelector('.pp-name')));
    }
    panel.appendChild(row);
  });
  if (Object.keys(W.project.poses || {}).length) {
    const bar = document.createElement('div');
    bar.className = 'pp-posebar';
    bar.innerHTML = '<button id="pose-reset-sel">所选复位</button><button id="pose-reset-all">全部复位</button>';
    panel.appendChild(bar);
    bar.querySelector('#pose-reset-sel').addEventListener('click', () => resetPoses(false));
    bar.querySelector('#pose-reset-all').addEventListener('click', () => resetPoses(true));
  }
  const tip = document.createElement('div');
  tip.className = 'pp-tip';
  tip.textContent = isFree() ? '双击板名改名；用「🛠 3D 编辑器」把板拼起来，自动检查干涉' : '双击 3D 里的板件也可以编辑';
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
  if (sketchEd && sketchEd.opened) sketchEd.setPreviewStatus(text, kind);
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
    m = await api().get_model(name, window.SeedApp.collectParams(),
      isFree() ? { free: W.project.free, sketches: W.project.sketches, disabled: W.project.disabled } : null);
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
    view.onPick = (id, ev) => {
      // 二维画板开着（右下角是 3D 预览）：点板件 / 线 = 在画板上定位它
      if (sketchEd && sketchEd.opened && sketchEd.sheetMode) { if (id) sketchEd.locate(id); return; }
      if (id && id.startsWith('loose:')) return;
      select(id, ev && ev.shiftKey);
    };
    view.onEdit = (id) => (isFree() ? setStage('design') : openEditor(id));
    poser = new Poser(view);
    poser.applyMouseMapping(W.pose.on);
  }
  view.setModel(m, looseOverlay());
  W.multi.clear();
  if (W.selected && !m.parts.some((q) => q.id === W.selected)) W.selected = null;
  if (W.selected) W.multi.add(W.selected);
  W.pose.report = null;
  renderPartsPanel();
  view.resize();          // 清单宽度确定后再算画面偏移
  const posed = Object.keys(W.project.poses || {}).length > 0;
  if (posed || Object.keys(W.project.sketches || {}).length) checkPose(W.paramsDirty);
  if (posed && W.paramsDirty) {
    setNote('参数已改变，3D 编辑器里摆放过的板件位置可能需要重新调整（可点板件清单下方的「全部复位」）。', 'info');
    W.paramsDirty = false;
  } else if (!m.parts.length) setNote('这个生成器没有可识别的闭合板件，无法生成 3D 模型。', 'info');
  else if (m.free) setNote('自由设计：板件按二维画板上的位置平放。拖动板件靠近会自动吸附，或点「🧩 按卡榫自动拼装」；拼好后自动检查干涉。', 'info');
  else if (m.auto) {
    setNote(`自动装配（试验）：已拼上 ${m.placed} 块板${m.floating ? `，另有 ${m.floating} 块（隔板、盖子等）放在旁边` : ''}。` +
            '形状仅供参考，以图纸为准。', 'info');
  } else setNote(m.assembled ? '' : '这个生成器暂不支持拼装预览，下面是所有板件平铺的样子（仍可开孔、刻字、禁用）。',
               m.assembled ? '' : 'info');
  if (W.wantSheet && isFree()) { W.wantSheet = false; W.stage = 'design'; updateStageBar(); openSheet(); }
  if (isFree() && W.stage === 'make') { renderMakePanel(); if (window.SeedApp) window.SeedApp.doPreview(); }
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
  if (mode !== '3d' && SF.open) closeSketchForge();
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

// ------------------------------------------------------------------ 二维草图编辑（web/sketch2d.js）

let sketchEd = null;

// 原始轮廓签名：生成器参数变化后，提示草图是按旧尺寸画的
function baseSig(p) {
  const o = partOutline(p);
  const str = JSON.stringify([o.outer, o.holes].flat(2).map((v) => Math.round(v * 100)));
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h * 33) ^ str.charCodeAt(i)) >>> 0;
  return h.toString(36) + '-' + str.length.toString(36);
}

function sketchOf(id) { return W.project.sketches && W.project.sketches[id]; }

// 其他板上的卡榫（草图里记录的），给编辑器做「配对」
function peerJoints(id) {
  const out = [];
  Object.entries(W.project.sketches || {}).forEach(([pid, sk]) => {
    if (pid === id || !sk) return;
    const name = nameOf(pid);
    (sk.items || []).forEach((it) => (it.joints || []).forEach((j) => {
      const L = j.L || Math.hypot(j.b[0] - j.a[0], j.b[1] - j.a[1]);
      out.push({ ...j, L, part: name, pid });
    }));
  });
  return out;
}

async function openEditor(id) {
  if (!W.model) return;
  const p = W.model.parts.find((q) => q.id === id);
  if (!p) return;
  if (SF.open) await closeSketchForge();
  if (sketchEd && sketchEd.opened) sketchEd.close();      // 在 3D 预览里双击了另一块板：切换
  select(id);
  if (!sketchEd) {
    sketchEd = new SketchEditor($('#sk-host'), { api: api(), toast });
    sketchEd.onPreviewResize = () => { if (view) { view.resize(); } };
  }
  if (!W.fonts) W.fonts = await api().list_fonts();
  const legacyEdits = (W.project.edits[id] || []).filter(Boolean);
  if (legacyEdits.length) await ensureShapes(legacyEdits);
  const legacy = legacyEdits.map((e) => ({ polys: editPolys(e), mode: e.mode === 'cut' ? 'cut' : 'engrave' }));
  ED.part = p;
  const sub = p.kind === 'rect'
    ? `内部尺寸 ${fmt(p.w)} × ${fmt(p.h)} mm · 从外面看${p.mirror ? '（导出时这块板会翻面，刻字面朝外）' : ''}`
    : `约 ${fmt(p.bbox[2] - p.bbox[0])} × ${fmt(p.bbox[3] - p.bbox[1])} mm`;
  await sketchEd.open({
    part: { name: p.name, sub: isFree() ? `约 ${fmt(p.w)} × ${fmt(p.h)} mm · 自由设计的板，外轮廓可以随意改` : sub, outline: partOutline(p),
            base: isFree() ? undefined : baseSig(p), thickness: W.model.thickness, free: isFree() },
    sketch: sketchOf(id), legacy, fonts: W.fonts, peers: peerJoints(id),
    onChange: (sk) => saveSketch(id, sk),
    onClose: (sk) => { saveSketch(id, sk); ED.part = null; attachView($('#view3d-canvas')); renderPartsPanel(); },
  });
  attachView(sketchEd.previewHost);
  const noteEl = $('#view3d-note');
  sketchEd.setPreviewStatus(noteEl.classList.contains('hidden') ? '' : noteEl.textContent,
    (noteEl.className.match(/\b(ok|error|info)\b/) || [])[1]);
}

// 3D 视图的画布在主界面和草图编辑器的预览框之间移动（同一个 three.js 场景，实时同步）
// 自由设计：不在任何板件里的图形，画在 3D 台面上（和画板位置一致），点它可以在画板上定位
const OVERLAY_COLORS = { cut: 0x111827, engrave: 0x16a34a, score: 0xdc2626 };
function looseOverlay() {
  if (!isFree() || !W.project.free) return null;
  const out = [];
  const sh = W.project.free.sheet;
  if (sh && sh.w && sh.h) {      // 材料边框（虚线），看得出零件在材料上的位置
    out.push({ id: null, pts: [[0, 0], [sh.w, 0], [sh.w, sh.h], [0, sh.h], [0, 0]], color: 0x7c8ba1, dash: Math.max(sh.w, sh.h) / 60 });
  }
  (W.project.free.loose || []).forEach((it) => {
    (it.paths || []).forEach((p) => {
      const pts = flattenPath(p);
      if (pts.length < 2) return;
      if (p.closed) pts.push(pts[0]);
      out.push({ id: it.id, pts, color: OVERLAY_COLORS[it.mode] || OVERLAY_COLORS.cut });
    });
  });
  return out;
}

function attachView(el) {
  if (!view || !el || view.host === el) return;
  view.host = el;
  view.topDown = el.id !== 'view3d-canvas';       // 画板里的小预览：俯视总览
  view.ro.observe(el);
  el.appendChild(view.renderer.domElement);
  view.resize();
  if (W.model) view.fit(W.model);
}

function saveSketch(id, sk) {
  W.project.sketches = W.project.sketches || {};
  if (sk.modified || isFree()) {
    const { modified, ...keep } = sk;
    W.project.sketches[id] = keep;
    delete W.project.edits[id];          // 旧版开孔 / 刻字已迁移进草图
  } else {
    delete W.project.sketches[id];
  }
  rebuildPart(id);
  projectChanged();
  renderPartsPanel();
  checkPose();                           // 实时检查：改过的板还能不能拼上
}

// ------------------------------------------------------------------ 自由设计：二维画板（所有板件画在一张材料上）

// 旋转 ang 度（绕原点）再平移 (dx, dy)；局部坐标 ↔ 画板坐标
function placeItem(it, ang, dx, dy) {
  if (!ang) return translateItem(it, dx, dy);
  const c = Math.cos(ang * Math.PI / 180); const s = Math.sin(ang * Math.PI / 180);
  const R = ([x, y]) => [x * c - y * s, x * s + y * c];
  const t = (q) => { const [x, y] = R(q); return [Math.round((x + dx) * 1e3) / 1e3, Math.round((y + dy) * 1e3) / 1e3]; };
  const out = { ...it, paths: it.paths.map((p) => ({ ...p, segs: p.segs.map((g) => [...t(g), ...R([g[2], g[3]]), ...R([g[4], g[5]])]) })) };
  if (it.joints) out.joints = it.joints.map((j) => ({ ...j, a: t(j.a), b: t(j.b), c: t(j.c) }));
  if (it.bridges) out.bridges = it.bridges.map(t);
  if (it.text) delete out.text;                 // 转过角度的文字变成路径
  return out;
}
function unplaceItem(it, ang, ox, oy) {          // placeItem 的逆变换
  const back = translateItem(it, -ox, -oy);
  return ang ? placeItem(back, -ang, 0, 0) : back;
}

function translateItem(it, dx, dy) {
  const t = ([x, y]) => [Math.round((x + dx) * 1e3) / 1e3, Math.round((y + dy) * 1e3) / 1e3];
  const out = { ...it, paths: it.paths.map((p) => ({ ...p, segs: p.segs.map((g) => [...t(g), g[2], g[3], g[4], g[5]]) })) };
  if (it.joints) out.joints = it.joints.map((j) => ({ ...j, a: t(j.a), b: t(j.b), c: t(j.c) }));
  if (it.bridges) out.bridges = it.bridges.map(t);
  if (it.text) out.text = { ...it.text, x: it.text.x + dx, y: it.text.y + dy, path: it.text.path ? it.text.path.map(t) : it.text.path };
  return out;
}

function freeSheet() {
  const f = W.project.free || (W.project.free = { parts: [] });
  if (!f.sheet) f.sheet = { w: 400, h: 300 };
  return f.sheet;
}

// 把各板件的草图按它在画板上的位置拼成一张大草图
function composeSheet() {
  const sheet = freeSheet();
  const items = [];
  let cx = 10, cy = sheet.h - 10, rowH = 0;
  freeParts().forEach((p) => {
    const sk = (W.project.sketches || {})[p.id] || rectSketch(p.w, p.h);
    if (p.sx == null) {                       // 旧项目 / 新建的板：自动找个空位
      if (cx + p.w > sheet.w - 10 && cx > 10) { cx = 10; cy -= rowH + 10; rowH = 0; }
      p.sx = cx; p.sy = cy - p.h; cx += p.w + 10; rowH = Math.max(rowH, p.h);
    }
    const outlineIdx = Math.max(0, sk.items.findIndex((it) => it.role === 'outline'));
    const sa = p.sa || 0;
    // 图形 id 在整张画板里必须唯一（各板的 id 可能都叫 outline）：加上板件前缀，存回时去掉
    sk.items.forEach((it, i) => items.push({ ...placeItem(it, sa, p.sx, p.sy), id: `${p.id}§${it.id || i}`, role: undefined,
      pid: i === outlineIdx ? p.id : undefined, origin: i === outlineIdx ? [p.sx, p.sy, sa] : undefined }));
  });
  (W.project.free.loose || []).forEach((it) => items.push(it));
  return { items, bridge_w: W.project.free.bridge_w, guides: W.project.free.guides };
}

// 画板 → 各板件：识别结果拆回 project.free.parts / sketches（板件坐标从 0 开始）
function applySheet(res) {
  if (!res || !res.sheet) return;
  const f = W.project.free;
  const old = new Map(freeParts().map((p) => [p.id, p]));
  const parts = [];
  W.project.sketches = W.project.sketches || {};
  res.parts.forEach((rp, i) => {
    const [x0, y0, x1, y1] = rp.bounds;
    const prev = old.get(rp.pid);
    // 局部坐标系跟着「原点」走：改形状不会让 3D 里装配好的板错位；新板以左下角为原点
    const [ox, oy, oa] = rp.origin || [x0, y0, 0];
    const items = rp.items.map((it) => {
      const { pid, origin, ...rest } = unplaceItem(it, oa || 0, ox, oy);
      if (rest.id && rest.id.startsWith(`${rp.pid}§`)) rest.id = rest.id.slice(rp.pid.length + 1);
      if (it.id === rp.outline) rest.role = 'outline'; else delete rest.role;
      return rest;
    });
    W.project.sketches[rp.pid] = { items, ...(res.bridge_w != null ? { bridge_w: res.bridge_w } : {}) };
    parts.push({ ...(prev || {}), id: rp.pid, name: prev ? prev.name : nextPartName([...old.values(), ...parts]), w: Math.round((x1 - x0) * 100) / 100,
                 h: Math.round((y1 - y0) * 100) / 100, sx: ox, sy: oy, sa: oa || 0 });
    old.delete(rp.pid);
  });
  old.forEach((_p, id) => {                          // 画板上删掉的板
    delete W.project.sketches[id];
    if (W.project.poses) delete W.project.poses[id];
  });
  f.parts = parts;
  if (res.size) f.sheet = res.size;
  f.loose = res.loose;
  f.bridge_w = res.bridge_w;
  f.guides = res.guides;
  projectChanged();
}

function nextPartName(list) {
  const nums = list.map((p) => Number((/^板件 (\d+)$/.exec(p.name || '') || [])[1]) || 0);
  return `板件 ${Math.max(0, ...nums) + 1}`;
}

let sheetTimer = null;
async function openSheet() {
  for (let i = 0; i < 50 && !isFree(); i++) await new Promise((r) => setTimeout(r, 100));
  if (!isFree()) return;
  if (SF.open) await closeSketchForge();
  if (sketchEd && sketchEd.opened) sketchEd.close();
  if (!sketchEd) {
    sketchEd = new SketchEditor($('#sk-host'), { api: api(), toast });
    sketchEd.onPreviewResize = () => { if (view) view.resize(); };
  }
  if (!W.fonts) W.fonts = await api().list_fonts();
  const sheet = freeSheet();
  const names = Object.fromEntries(freeParts().map((p) => [p.id, p.name]));
  ED.part = null;
  await sketchEd.open({
    part: { name: '自由设计 · 二维画板', sub: '', free: true, sheet, names, thickness: W.model ? W.model.thickness : (Number((window.SeedApp.collectParams() || {}).thickness) || 3),
            outline: { outer: [[0, 0], [sheet.w, 0], [sheet.w, sheet.h], [0, sheet.h]], holes: [] } },
    sketch: composeSheet(), fonts: W.fonts, peers: [],
    onChange: (res) => {
      applySheet(res);
      if (sketchEd.part) sketchEd.part.names = Object.fromEntries(freeParts().map((p) => [p.id, p.name]));
      clearTimeout(sheetTimer);
      sheetTimer = setTimeout(() => loadModel(), 900);    // 右下角 3D 实时预览
    },
    onClose: async (res) => {
      clearTimeout(sheetTimer);
      applySheet(res);
      if (W.quietClose) return;          // 换设计（新建 / 打开）时关画板：只写回内容，不去 3D
      attachView($('#view3d-canvas'));
      const fromDesign = W.stage === 'design';
      if (fromDesign) { W.stage = 'assemble'; updateStageBar(); setMode('3d'); }
      await loadModel();
      renderPartsPanel();
      if (fromDesign && W.model && W.model.parts.length) toast(`已生成 ${W.model.parts.length} 块板的 3D 模型：拖动板件靠近会自动吸附，或点「按卡榫自动拼装」`, 'ok');
    },
  });
  sketchEd.onThickness = (v) => { setFormNum('thickness', v); };   // 画板里改板厚 = 改左侧参数（导出、3D 都用它）
  attachView(sketchEd.previewHost);
}

function closeEditor(quiet) {
  W.quietClose = !!quiet;
  try { if (sketchEd && sketchEd.opened) sketchEd.close(); } finally { W.quietClose = false; }
  clearTimeout(sheetTimer);
  ED.part = null;
}

// ------------------------------------------------------------------ 自由设计（FreeDesign）：板件增删改

function rectSketch(w, h) {
  return { items: [{ id: 'outline', mode: 'cut', role: 'outline',
    paths: [{ closed: true, segs: [[0, 0, 0, 0, 0, 0], [w, 0, 0, 0, 0, 0], [w, h, 0, 0, 0, 0], [0, h, 0, 0, 0, 0]] }] }] };
}

function freeParts() {
  if (!W.project.free) W.project.free = { parts: [] };
  return W.project.free.parts;
}

// ------------------------------------------------------------------ 自由设计的三个板块：① 二维设计 → ② 3D 装配 → ③ 加工作业
// 板件数量 / 使用与否只在「加工作业」里管；设计和装配阶段不显示板件清单

function updateStageBar() {
  const free = isFree();
  $('#stage-bar').classList.toggle('hidden', !free);
  $('#preview-toolbar .seg').classList.toggle('hidden', free);
  $('#btn-parts').classList.toggle('stage-hide', free);
  document.querySelectorAll('#stage-bar [data-stage]').forEach((b) => b.classList.toggle('on', free && b.dataset.stage === W.stage));
  const body = $('.editor-body');
  body.classList.toggle('stage-assemble', free && W.stage === 'assemble');
  body.classList.toggle('stage-make', free && W.stage === 'make');
}

function setStage(st) {
  if (!isFree()) return;
  W.stage = st;
  updateStageBar();
  if (st === 'design') { openSheet(); return; }
  if (sketchEd && sketchEd.opened) sketchEd.close();      // 画板 onClose 会保存，并看到 W.stage 已不是 design
  if (st === 'assemble') {
    setMode('3d');
    renderPartsPanel();
    if (view) setTimeout(() => view.resize(), 0);
  } else if (st === 'make') {
    setMode('2d');
    renderMakePanel();
    if (window.SeedApp) window.SeedApp.doPreview();
  }
}

function renderAssemblePanel(panel) {
  const rep = W.pose.report || {};
  const dis = new Set(W.project.disabled);
  const parts = W.model.parts.filter((p) => !dis.has(p.id));
  const bad = parts.filter((p) => rep[p.id] && rep[p.id].collide.length);
  const loose = parts.filter((p) => rep[p.id] && !rep[p.id].collide.length && !rep[p.id].touch.length);
  panel.classList.add('free');
  panel.innerHTML = `<div class="pp-head"><span>② 3D 装配</span></div>
    <div class="asm-actions">
      <button class="primary" data-k="auto" title="按画板里配对好的卡榫把板自动拼起来">🧩 按卡榫自动拼装</button>
      <button data-k="sf" title="在完整的 3D 编辑器里移动、旋转板件；靠近时自动吸附">🛠 手动摆放</button>
      <button data-k="flat" title="所有板平放在台面上（按画板上的位置）">拆开平铺</button>
    </div>
    <div class="asm-check">${!W.pose.report ? '<span class="pp-free">拼装后会自动检查有没有穿透</span>'
      : bad.length ? `<span class="pp-bad">穿透：${bad.map((p) => esc(p.name)).join('、')}</span>`
      : '<span class="pp-ok">✓ 没有穿透</span>'}${loose.length && W.pose.report ? `<span class="pp-free">还没连上：${loose.map((p) => esc(p.name)).join('、')}</span>` : ''}</div>
    <p class="asm-tip">要改形状：点上方「① 二维设计」。确认拼对了：点「③ 加工作业」排版导出。</p>`;
  panel.querySelector('[data-k=auto]').addEventListener('click', () => freeAutoAssemble());
  panel.querySelector('[data-k=sf]').addEventListener('click', () => openSketchForge());
  panel.querySelector('[data-k=flat]').addEventListener('click', () => {
    W.project.poses = {};
    W.model.parts.forEach((p) => { const o = view && view.objects.get(p.id); if (o) { o.group.matrix.fromArray(p.matrix); o.group.matrixWorldNeedsUpdate = true; } });
    if (view) view.fit(W.model);
    projectChanged(); renderPartsPanel(); checkPose();
  });
}

// ③ 加工作业：板件清单（是否切这块）、批量名牌、卡扣测试样；排版 / 补偿在左侧表单，导出用右上角「保存到文件」
function renderMakePanel() {
  const panel = $('#make-panel');
  if (!panel) return;
  if (!isFree() || W.stage !== 'make' || !W.model) { panel.innerHTML = ''; return; }
  const dis = new Set(W.project.disabled);
  const parts = W.model.parts;
  const on = parts.filter((p) => !dis.has(p.id)).length;
  panel.innerHTML = `<div class="pp-head"><span>③ 加工清单</span><span class="pp-count">${parts.length} 块 · 要切 ${on}</span></div>
    ${parts.map((p, i) => `<label class="mk-row${dis.has(p.id) ? ' off' : ''}"><input type="checkbox" data-id="${p.id}" ${dis.has(p.id) ? '' : 'checked'}>
      <span class="pp-chip" style="background:#${WOOD[i % WOOD.length].toString(16)}">${String.fromCharCode(65 + (i % 26))}</span>
      <span class="mk-name">${esc(p.name)}</span><span class="mk-size">${fmt(p.w)}×${fmt(p.h)}</span></label>`).join('')}
    <div class="asm-actions">
      <button data-k="names" title="粘贴一列名字，自动生成一排名牌">📛 批量名牌</button>
      <button data-k="fit" title="切一组小样，量出这台机器、这种板的切缝、实际板厚和插槽松紧">🧪 卡扣测试样</button>
    </div>
    <p class="asm-tip">左侧「排版」填材料尺寸可自动排版、共边切割；右上角「⚙ 加工参数」设速度功率，「保存到文件」导出图纸。</p>`;
  panel.querySelectorAll('input[data-id]').forEach((cb) => cb.addEventListener('change', () => {
    setEnabled(cb.dataset.id, cb.checked);
    renderMakePanel();
    if (window.SeedApp) window.SeedApp.doPreview();
  }));
  panel.querySelector('[data-k=names]').addEventListener('click', () => nameplateDialog());
  panel.querySelector('[data-k=fit]').addEventListener('click', () => fitTestDialog());
}

// ------------------------------------------------------------------ 快速建模 → 设计：把模型的板件（含装配位置）放进二维画板

function polySegs(pts) { return pts.map(([x, y]) => [Math.round(x * 1e3) / 1e3, Math.round(y * 1e3) / 1e3, 0, 0, 0, 0]); }

async function importToDesign() {
  if (isFree() || !W.name) return;
  if (!W.model || W.stale) await loadModel();
  const dis = new Set(W.project.disabled);
  const src = (W.model ? W.model.parts : []).filter((p) => !dis.has(p.id) && p.id !== 'reference');
  if (!src.length) { toast('这个模型没有可识别的板件，放不进设计', 'error'); return; }
  const parts = []; const sketches = {}; const poses = {};
  src.forEach((p) => {
    const id = 'p' + Date.now().toString(36) + (uidCounter++).toString(36);
    // 板件局部坐标 = 模型里的轮廓坐标，这样模型的装配矩阵可以直接当 3D 装配位置用
    const items = [{ id: 'outline', mode: 'cut', role: 'outline', paths: [{ closed: true, segs: polySegs(p.outer) }] }];
    (p.holes || []).forEach((h, i) => items.push({ id: 'hole' + i, mode: 'cut', paths: [{ closed: true, segs: polySegs(h) }] }));
    (p.extra || []).forEach((h, i) => { if (h.length > 2) items.push({ id: 'extra' + i, mode: 'cut', paths: [{ closed: true, segs: polySegs(h) }] }); });
    (p.etch || []).forEach((h, i) => { if (h.length > 2) items.push({ id: 'etch' + i, mode: 'engrave', paths: [{ closed: true, segs: polySegs(h) }] }); });
    sketches[id] = { items };
    const [x0, y0, x1, y1] = p.bbox || [0, 0, p.w, p.h];
    parts.push({ id, name: p.name, w: Math.round((x1 - x0) * 100) / 100, h: Math.round((y1 - y0) * 100) / 100 });
    if (W.model.assembled) poses[id] = p.matrix.slice();
  });
  const params = window.SeedApp.collectParams();
  W.pendingImport = { from: W.name, parts, sketches, poses, thickness: Number(params.thickness), burn: Number(params.burn), assembled: !!W.model.assembled };
  await window.SeedApp.select('FreeDesign');
}

function applyPendingImport() {
  const imp = W.pendingImport;
  W.pendingImport = null;
  const into = !!W.freeStash;
  if (into) { W.project = W.freeStash; W.freeStash = null; }
  W.project.free = W.project.free || { parts: [] };
  W.project.free.parts = (W.project.free.parts || []).concat(imp.parts);
  W.project.sketches = { ...(W.project.sketches || {}), ...imp.sketches };
  W.project.poses = { ...(W.project.poses || {}), ...imp.poses };
  const p0 = into ? W.freeStashParams : null;
  W.freeStashParams = null;
  if (p0) { if (p0.thickness != null) setFormNum('thickness', p0.thickness); if (p0.burn != null) setFormNum('burn', p0.burn); }
  else { if (imp.thickness) setFormNum('thickness', imp.thickness); if (imp.burn >= 0) setFormNum('burn', imp.burn); }
  W.wantSheet = true;
  W.stage = 'design';
  W.quietParamsUntil = Date.now() + 2000;   // 放进设计时改板厚 / 切缝是有意的，位置也随模型带来，不提示「参数已改变」
  const warn = p0 && Number(p0.thickness) !== imp.thickness ? `；注意：模型按 ${imp.thickness} mm 板厚生成，当前设计是 ${p0.thickness} mm` : '';
  toast(`已把「${imp.from}」的 ${imp.parts.length} 块板放进${into ? '当前' : '新'}设计${imp.assembled ? '，3D 装配位置也带过来了' : ''}${warn}`, warn ? 'info' : 'success');
}

function startExample() {
  const ex = W.startEx;
  W.startEx = null;
  W.wantSheet = false;
  W.stage = 'make';
  updateStageBar();
  setMode('2d');
  loadModel().then(() => {
    renderMakePanel();
    if (ex === 'fit') fitTestDialog(); else nameplateDialog();
  });
}

function freePartForm() {
  const box = document.createElement('div');
  box.className = 'pp-free-new';
  box.innerHTML = `<b>＋ 新建板件</b>
    <label>宽<input type="number" data-k="w" value="${W.freeW || 100}" min="1" step="1"></label>
    <label>高<input type="number" data-k="h" value="${W.freeH || 60}" min="1" step="1"></label>
    <button class="primary" data-k="sheet" title="所有板件画在一张材料上，所见即所切">📐 打开二维画板</button>
    <button data-k="add">添加并编辑</button>
    <button data-k="auto" title="按卡榫配对把板自动拼起来">🧩 按卡榫自动拼装</button>
    <button data-k="flat" title="所有板平放在台面上">平铺</button>
    <button data-k="names" title="粘贴一列名字，自动生成一排名牌">📛 批量名牌</button>
    <button data-k="fit" title="切一组小样，量出这台机器、这种板的切缝、实际板厚和插槽松紧">🧪 卡扣测试样</button>`;
  box.querySelector('[data-k=sheet]').addEventListener('click', () => openSheet());
  box.querySelector('[data-k=names]').addEventListener('click', () => nameplateDialog());
  box.querySelector('[data-k=fit]').addEventListener('click', () => fitTestDialog());
  box.querySelector('[data-k=auto]').addEventListener('click', () => freeAutoAssemble());
  box.querySelector('[data-k=flat]').addEventListener('click', () => {
    W.project.poses = {};
    W.model.parts.forEach((p) => { const o = view && view.objects.get(p.id); if (o) { o.group.matrix.fromArray(p.matrix); o.group.matrixWorldNeedsUpdate = true; } });
    if (view) view.fit(W.model);
    projectChanged(); renderPartsPanel(); checkPose();
  });
  box.querySelector('[data-k=add]').addEventListener('click', () => {
    const w = Math.max(1, Number(box.querySelector('[data-k=w]').value) || 100);
    const h = Math.max(1, Number(box.querySelector('[data-k=h]').value) || 60);
    W.freeW = w; W.freeH = h;
    freeAdd(w, h, true);
  });
  return box;
}

async function freeAdd(w, h, edit, name, sketch) {
  const id = 'p' + Date.now().toString(36) + (uidCounter++).toString(36);
  const parts = freeParts();
  parts.push({ id, name: name || `板件 ${parts.length + 1}`, w, h });
  W.project.sketches[id] = sketch || rectSketch(w, h);
  projectChanged();
  await loadModel();
  if (edit) openEditor(id);
  return id;
}

function freeDuplicate(id) {
  const src = freeParts().find((q) => q.id === id);
  if (!src) return;
  const sk = JSON.parse(JSON.stringify(W.project.sketches[id] || rectSketch(src.w, src.h)));
  freeAdd(src.w, src.h, false, `${src.name} 副本`, sk);
}

function freeDelete(id, btn) {
  if (!btn.classList.contains('confirm')) {          // 再点一次确认（WKWebView 里不用 confirm 对话框）
    btn.classList.add('confirm');
    btn.textContent = '删除?';
    setTimeout(() => { btn.classList.remove('confirm'); btn.textContent = '✕'; }, 2500);
    return;
  }
  W.project.free.parts = freeParts().filter((q) => q.id !== id);
  delete W.project.sketches[id];
  if (W.project.poses) delete W.project.poses[id];
  W.project.disabled = W.project.disabled.filter((x) => x !== id);
  if (W.selected === id) W.selected = null;
  projectChanged();
  loadModel();
}

function freeRename(id, el) {
  const part = freeParts().find((q) => q.id === id);
  if (!part) return;
  const input = document.createElement('input');
  input.className = 'pp-rename';
  input.value = part.name;
  el.replaceWith(input);
  input.focus();
  input.select();
  const done = (save) => {
    if (save && input.value.trim()) {
      part.name = input.value.trim();
      const mp = W.model && W.model.parts.find((q) => q.id === id);
      if (mp) mp.name = part.name;
      projectChanged();
    }
    renderPartsPanel();
  };
  input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); });
  input.addEventListener('blur', () => done(true));
}

function debounce(fn, ms) {
  if (!ms) return fn;
  let t = null;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function fmt(v) { return Math.round(v * 10) / 10; }

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
    if (p && !isFree() && matricesClose(o.group.matrix, new THREE.Matrix4().fromArray(p.matrix), 0.01)) {
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
// 咬合 / 穿透检查：只在有手动摆放（3D 编辑器里移动过）时运行；quiet 时只更新清单标记、不改提示
const checkPose = debounce(async (quiet) => {
  if (!W.model || !W.model.token) return;
  if (!Object.keys(W.project.poses || {}).length && !Object.keys(W.project.sketches || {}).length) {
    W.pose.report = null;
    if (view) view.refreshStates();
    renderPartsPanel();
    return;
  }
  const seq = ++poseCheckSeq;
  const dis = new Set(W.project.disabled);
  const ids = W.model.parts.map((p) => p.id).filter((id) => !dis.has(id) && id !== 'reference');
  const r = await api().check_pose(W.model.token, W.project.poses || {}, ids, W.project.sketches || {});
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
  if (quiet) return;
  if (bad.length) setNote(`有 ${bad.length} 块板互相穿透（红色）：${bad.map(nameOf).join('、')}`, 'error');
  else if (!loose.length && ids.length > 1) setNote('✓ 所有板件都已咬合，没有穿透', 'ok');
  else setNote(`没有穿透；${loose.map(nameOf).join('、')} 还没有和主体连在一起`, 'info');
}, 150);

function afterPoseChange() {
  if (view) view.refreshStates();
  renderPartsPanel();
  checkPose();
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

// ------------------------------------------------------------------ 3D 编辑器（SketchForge 改版）
// 打开时把启用的板件（含开孔）按当前摆放导入 SketchForge；在编辑器里移动 / 旋转后，
// 用每块板上 3 个顶点前后的位置反求刚体变换，写回 W.project.poses（和「✋ 摆放」共用）。
// 坐标：boxes（z 向上）经 view.root（绕 X -90°）变成 three / SketchForge（y 向上）。

const SNAP_DIST = 10;     // mm：中心偏差在这以内
const SNAP_ANGLE = 20;    // 度：方向偏差在这以内
const SNAP_DIST_FREE = 25;   // 自由设计：手摆得比较粗，范围放宽
const SNAP_ANGLE_FREE = 35;

const SF = {
  snap: true, neighbors: null, prevPoses: {},
  frame: null, origin: '*', ready: null, open: false,
  seq: 0, pending: new Map(),
  key: null,            // 已导入场景对应的 模型 token + 编辑 + 禁用
  map: new Map(),       // SketchForge 对象 id → { pid, idx:[3], ref:[Vector3×3], base:Matrix4（导入时的摆放） }
  syncing: false, dirty: false, stats: null,
  off: new THREE.Vector3(),
};

function sfCommand(action, params) {
  return new Promise((resolve, reject) => {
    const id = 'sb' + (++SF.seq);
    const timer = setTimeout(() => { SF.pending.delete(id); reject(new Error('3D 编辑器无响应')); }, 30000);
    SF.pending.set(id, (msg) => {
      clearTimeout(timer);
      if (msg.ok) resolve(msg.data); else reject(new Error(msg.error || '命令失败'));
    });
    SF.frame.contentWindow.postMessage({ type: 'seedboxes:command', id, action, params: params || {} }, SF.origin);
  });
}

window.addEventListener('message', (ev) => {
  if (!SF.frame || ev.source !== SF.frame.contentWindow) return;
  const msg = ev.data || {};
  if (msg.type === 'seedboxes:ready') { if (SF.ready) SF.ready.resolve(); }
  else if (msg.type === 'seedboxes:result') {
    const cb = SF.pending.get(msg.id);
    if (cb) { SF.pending.delete(msg.id); cb(msg); }
  } else if (msg.type === 'seedboxes:changed') { if (SF.open && !SF.syncing) sfSync(); }
  else if (msg.type === 'seedboxes:home') closeSketchForge();
});

async function sfEnsureFrame() {
  if (SF.frame) return SF.ready.promise;
  const r = await api().sketchforge_url();
  if (r.error) throw new Error(r.error);
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  SF.ready = { promise, resolve };
  SF.origin = new URL(r.url).origin;
  const f = document.createElement('iframe');
  f.src = r.url;
  f.title = '3D 编辑器';
  f.allow = 'clipboard-read; clipboard-write';
  $('#sf-host').appendChild(f);
  SF.frame = f;
  const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('3D 编辑器加载超时')), 90000));
  return Promise.race([promise, timeout]);
}

function sfSceneKey() {
  return JSON.stringify([W.model && W.model.token, W.project.edits, W.project.sketches, [...W.project.disabled].sort()]);
}

// 板件 → three 世界坐标下的三角形（非索引）
function partWorldPositions(o) {
  view.root.updateMatrixWorld(true);
  let g = o.mesh.geometry;
  if (g.index) g = g.toNonIndexed();
  const m = new THREE.Matrix4().multiplyMatrices(view.root.matrix, o.group.matrix);
  const pos = g.attributes.position;
  const out = new Float64Array(pos.count * 3);
  const v = new THREE.Vector3();
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(m);
    out[i * 3] = v.x; out[i * 3 + 1] = v.y; out[i * 3 + 2] = v.z;
  }
  if (g !== o.mesh.geometry) g.dispose();
  return out;
}

// 选 3 个相距较远、不共线的顶点，作为回读姿态的参考点
function pickRefIdx(p) {
  const n = p.length / 3;
  const at = (i) => new THREE.Vector3(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
  const a = at(0);
  let b = 0, bd = -1;
  for (let i = 1; i < n; i++) { const d = at(i).distanceToSquared(a); if (d > bd) { bd = d; b = i; } }
  const ab = at(b).sub(a).normalize();
  let c = 0, cd = -1;
  for (let i = 1; i < n; i++) {
    const w = at(i).sub(a);
    const d = w.sub(ab.clone().multiplyScalar(w.dot(ab))).lengthSq();
    if (d > cd) { cd = d; c = i; }
  }
  return [0, b, c];
}

function frameOf(a, b, c) {
  const x = b.clone().sub(a).normalize();
  const y = c.clone().sub(a);
  y.sub(x.clone().multiplyScalar(y.dot(x))).normalize();
  const z = new THREE.Vector3().crossVectors(x, y);
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(a);
}

async function sfLoadScene() {
  const scene = await sfCommand('get_scene');
  const ids = (scene.shapes || []).map((s) => s.id);
  SF.syncing = true;
  try {
    if (ids.length) await sfCommand('delete_objects', { ids });
    SF.map.clear();
    const dis = new Set(W.project.disabled);
    const parts = W.model.parts.filter((p) => !dis.has(p.id) && p.id !== 'reference' && view.objects.get(p.id));
    // 整体平移：模型放到工作平面中央、底面贴地（SF.off 为 three 世界 → 编辑器 的偏移）
    const worlds = parts.map((p) => partWorldPositions(view.objects.get(p.id)));
    const all = new THREE.Box3();
    worlds.forEach((w) => { for (let k = 0; k < w.length; k += 3) all.expandByPoint(new THREE.Vector3(w[k], w[k + 1], w[k + 2])); });
    const ctr = all.getCenter(new THREE.Vector3());
    SF.off = new THREE.Vector3(-Math.round(ctr.x), -all.min.y, -Math.round(ctr.z));
    for (let i = 0; i < parts.length; i++) await sfImportPart(parts[i], worlds[i]);
    if (SF.map.size) await sfCommand('select_objects', { ids: [] });
    await sfCommand('seedboxes_fit_view').catch(() => {});
    SF.key = sfSceneKey();
    SF.prevPoses = currentPoses();
    await sfLoadNeighbors(parts);
  } finally {
    SF.syncing = false;
  }
}

// 一块板 → 编辑器里的网格（w：three 世界坐标三角形，省略时按当前摆放计算）
async function sfImportPart(p, w) {
  if (!w) w = partWorldPositions(view.objects.get(p.id));
  for (let k = 0; k < w.length; k += 3) { w[k] += SF.off.x; w[k + 1] += SF.off.y; w[k + 2] += SF.off.z; }
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
  for (let k = 0; k < w.length; k += 3) {
    minX = Math.min(minX, w[k]); maxX = Math.max(maxX, w[k]);
    minY = Math.min(minY, w[k + 1]);
    minZ = Math.min(minZ, w[k + 2]); maxZ = Math.max(maxZ, w[k + 2]);
  }
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const local = new Array(w.length);
  for (let k = 0; k < w.length; k += 3) {
    local[k] = Math.round((w[k] - cx) * 1e4) / 1e4;
    local[k + 1] = Math.round((w[k + 1] - minY) * 1e4) / 1e4;
    local[k + 2] = Math.round((w[k + 2] - cz) * 1e4) / 1e4;
  }
  const idx = pickRefIdx(local);
  const ref = idx.map((j) => new THREE.Vector3(local[j * 3] + cx, local[j * 3 + 1] + minY, local[j * 3 + 2] + cz).sub(SF.off));
  const color = '#' + WOOD[W.model.parts.indexOf(p) % WOOD.length].toString(16).padStart(6, '0');
  const r = await sfCommand('import_mesh', { positions: local, name: p.name, color, x: cx, z: cz, elevation: minY });
  SF.map.set(r.object.id, { pid: p.id, idx, ref, base: new THREE.Matrix4().fromArray(poseOf(p)) });
  return r.object.id;
}

// ---- 磁吸：板拖到和相邻板「正确的相对位置」附近时自动对准
// 相邻关系取自生成器的装配结果（默认摆放下接触的板）。目标 = A 当前摆放 · A 默认⁻¹ · B 默认。

function partById(id) { return W.model.parts.find((q) => q.id === id); }
function currentPoses() {
  const out = {};
  SF.map.forEach((info) => { out[info.pid] = poseOf(partById(info.pid)).slice(); });
  return out;
}

async function sfLoadNeighbors(parts) {
  SF.neighbors = null;
  if (!W.model.assembled || !W.model.token) return;
  const ids = parts.map((p) => p.id);
  const r = await api().check_pose(W.model.token, {}, ids, W.project.sketches || {});
  if (r.error) return;
  SF.neighbors = {};
  ids.forEach((id) => { const q = r.report[id]; SF.neighbors[id] = q ? [...new Set([...q.touch, ...q.collide])] : []; });
}

function partCenter(p) {
  const xs = p.outer.map((q) => q[0]); const ys = p.outer.map((q) => q[1]);
  return new THREE.Vector3((Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, (W.model.thickness || 3) / 2);
}

function poseError(M, T, c) {
  const d = c.clone().applyMatrix4(M).distanceTo(c.clone().applyMatrix4(T));
  // 相对旋转 M⁻¹T 的转角（两者含同样的镜像时也成立）
  const e = M.clone().invert().multiply(T).elements;
  const cos = Math.max(-1, Math.min(1, (e[0] + e[5] + e[10] - 1) / 2));
  return { d, a: THREE.MathUtils.radToDeg(Math.acos(cos)) };
}

// ---- 自由设计的磁吸：按草图里记录的卡榫配对
//   指接 A ↔ 指接 B：两板垂直、成直角拼接（一块板的边线落在另一块板的内表面）
//   指接 A ↔ 凹槽：两板在同一平面，像拼图一样连上
//   指接 A ↔ 插槽：A 边插进另一块板板面上的一排孔（T 型）
// 在板件局部坐标（x、y = 草图坐标，z = 板厚方向）里算出目标，再乘以另一块板当前的摆放。

function jointsOf(pid) {
  const sk = sketchOf(pid);
  const out = [];
  if (sk) (sk.items || []).forEach((it) => (it.joints || []).forEach((j) => out.push(j)));
  return out;
}

function jointFrame(j) {
  const a = new THREE.Vector3(j.a[0], j.a[1], 0);
  const b = new THREE.Vector3(j.b[0], j.b[1], 0);
  const c = new THREE.Vector3(j.c[0], j.c[1], 0);
  const u = b.clone().sub(a);
  const L = u.length();
  u.normalize();
  const n = c.clone().sub(a);
  n.sub(u.clone().multiplyScalar(n.dot(u))).normalize();
  return { a, b, u, n, L };
}

function basis(x, y, z, o) {
  return new THREE.Matrix4().makeBasis(x, y, z).setPosition(o);
}

// Q 的卡榫 jq 配到 P 的卡榫 jp：返回 P 局部坐标里的若干候选（Q 局部 → P 局部）
// A 齿区间（旧数据只有段数 k：奇数段）
function jointIv(j, L) {
  if (j.iv) return j.iv;
  const k = Math.max(1, j.k || 1);
  const out = [];
  for (let i = 1; i < k; i += 2) out.push([i * L / k, (i + 1) * L / k]);
  return out;
}

function sameIv(a, b, L, reversed) {
  if (a.length !== b.length) return false;
  const bb = reversed ? b.map(([s, e]) => [L - e, L - s]).reverse() : b;
  return a.every(([s, e], i) => Math.abs(s - bb[i][0]) < 0.2 && Math.abs(e - bb[i][1]) < 0.2);
}

function mateOptions(jq, jp, t) {
  const Q = jointFrame(jq);
  const P = jointFrame(jp);
  if (Math.abs(Q.L - P.L) > 0.6) return [];
  const ivQ = jointIv(jq, Q.L);
  const ivP = jointIv(jp, P.L);
  const sigOk = { 1: sameIv(ivQ, ivP, P.L, false), '-1': sameIv(ivQ, ivP, P.L, true) };
  if (!sigOk[1] && !sigOk[-1]) return [];
  const ez = new THREE.Vector3(0, 0, 1);
  const Lq = basis(Q.u, Q.n, ez, Q.a);
  const det = Math.sign(Lq.determinant());
  const pair = [jq.type, jp.type].sort().join('+');
  const out = [];
  const add = (x, y, z, o) => {
    const T = basis(x, y, z, o);
    if (Math.sign(T.determinant()) !== det) return;
    out.push(T.multiply(Lq.clone().invert()));
  };
  const at = (sig) => (sig > 0 ? P.a.clone() : P.b.clone());
  for (const sig of [1, -1]) {
    if (!sigOk[sig]) continue;
    const ux = P.u.clone().multiplyScalar(sig);
    if (pair === 'a+b') {
      for (const sd of [1, -1]) {
        add(ux, ez.clone().multiplyScalar(-sd), P.n.clone(), at(sig).add(ez.clone().multiplyScalar(sd > 0 ? t : 0)));
      }
    } else if (pair === 'a+slot') {
      for (const zs of [1, -1]) {
        add(ux, P.n.clone().negate(), ez.clone().multiplyScalar(zs), at(sig).add(ez.clone().multiplyScalar(zs < 0 ? t : 0)));
      }
    } else if (pair === 'a+mortise' && jq.type === 'a') {
      const v = new THREE.Vector3(-P.u.y, P.u.x, 0);
      for (const sd of [1, -1]) {
        for (const zs of [1, -1]) {
          add(ux, ez.clone().multiplyScalar(-sd), v.clone().multiplyScalar(zs),
            at(sig).add(ez.clone().multiplyScalar(sd > 0 ? t : 0)).add(v.clone().multiplyScalar(-zs * t / 2)));
        }
      }
    }
  }
  return out;
}

async function sfTrySnapFree(moved, prev) {
  if (!SF.snap || !moved.length) return false;
  const t = W.model.thickness || 3;
  const movedSet = new Set(moved);
  const M = (id, poses) => new THREE.Matrix4().fromArray(poses ? poses[id] : poseOf(partById(id)));
  const others = [...SF.map.values()].map((i) => i.pid).filter((id) => !movedSet.has(id));
  let best = null;
  moved.forEach((qid) => {
    const c = partCenter(partById(qid));
    jointsOf(qid).forEach((jq) => others.forEach((pid) => jointsOf(pid).forEach((jp) => {
      mateOptions(jq, jp, t).forEach((F) => {
        const target = M(pid).multiply(F);
        const now = poseError(M(qid), target, c);
        const before = prev[qid] ? poseError(M(qid, prev), target, c) : { d: Infinity, a: 0 };
        if (now.d < 1e-3 && now.a < 0.05) return;
        if (now.d > SNAP_DIST_FREE || now.a > SNAP_ANGLE_FREE) return;
        if (now.d >= before.d - 1e-6 && now.a >= before.a - 1e-6) return;
        const score = now.d + now.a * 0.5;
        if (!best || score < best.score) best = { b: qid, a: pid, target, score };
      });
    })));
  });
  if (!best) return false;
  return sfApplySnap(best, moved);
}

async function sfTrySnap(moved, prev) {
  if (isFree()) return sfTrySnapFree(moved, prev);
  if (!SF.snap || !SF.neighbors || !moved.length) return false;
  const movedSet = new Set(moved);
  const M = (id, poses) => new THREE.Matrix4().fromArray(poses ? poses[id] : poseOf(partById(id)));
  const D = (id) => new THREE.Matrix4().fromArray(partById(id).matrix);
  let best = null;
  moved.forEach((b) => {
    const c = partCenter(partById(b));
    (SF.neighbors[b] || []).forEach((a) => {
      if (movedSet.has(a) || !prev[a]) return;
      const target = M(a).multiply(D(a).invert()).multiply(D(b));
      const now = poseError(M(b), target, c);
      const before = prev[b] ? poseError(M(b, prev), target, c) : { d: Infinity, a: 0 };
      if (now.d < 1e-3 && now.a < 0.05) return;                 // 已经对准
      if (now.d > SNAP_DIST || now.a > SNAP_ANGLE) return;
      if (now.d >= before.d - 1e-6 && now.a >= before.a - 1e-6) return;   // 正在远离：不抢回去
      if (!best || now.d < best.d) best = { b, a, target, d: now.d };
    });
  });
  if (!best) return false;
  return sfApplySnap(best, moved);
}

async function sfApplySnap(best, moved) {
  const movedSet = new Set(moved);
  const M = (id) => new THREE.Matrix4().fromArray(poseOf(partById(id)));
  const delta = best.target.clone().multiply(M(best.b).invert());
  W.project.poses = W.project.poses || {};
  // 自由设计：被吸附的那块也记下装配位置，之后在画板里挪动 / 旋转它，3D 装配不受影响
  if (isFree() && best.a && !W.project.poses[best.a]) W.project.poses[best.a] = M(best.a).toArray().map((x) => Math.round(x * 1e4) / 1e4);
  moved.forEach((id) => {
    const p = partById(id);
    const arr = delta.clone().multiply(M(id)).toArray().map((x) => Math.round(x * 1e4) / 1e4);
    if (!isFree() && arr.every((x, k) => Math.abs(x - p.matrix[k]) < 1e-3)) delete W.project.poses[id]; else W.project.poses[id] = arr;
    const o = view.objects.get(id);
    if (o) { o.group.matrix.fromArray(poseOf(p)); o.group.matrixWorldNeedsUpdate = true; }
  });
  // 编辑器里换成对准后的网格
  const old = [...SF.map.entries()].filter(([, info]) => movedSet.has(info.pid)).map(([sid]) => sid);
  await sfCommand('delete_objects', { ids: old });
  old.forEach((sid) => SF.map.delete(sid));
  const fresh = [];
  for (const id of moved) fresh.push(await sfImportPart(partById(id)));
  await sfCommand('select_objects', { ids: fresh });
  sfFlash(`🧲 ${nameOf(best.b)} 已吸附到 ${nameOf(best.a)}`);
  return true;
}

function sfFlash(text) {
  const el = $('#sf-msg');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  clearTimeout(sfFlash.t);
  sfFlash.t = setTimeout(() => el.classList.add('hidden'), 2200);
}

// 一键装配：全部回到生成器的装配位置；拆开平铺：所有板平放在台面上
async function sfAssembleAll() {
  if (isFree()) {
    const msg = await freeAutoAssemble();
    if (msg) await sfReloadPoses(msg);
    return;
  }
  W.project.poses = {};
  await sfReloadPoses('✓ 已一键装配');
}

// ---- 自由设计：批量名牌（每个名字一块板：圆角外框 + 挂孔 + 文字）

function roundRectSegs(w, h, r) {
  r = Math.max(0, Math.min(r, w / 2, h / 2));
  if (r < 1e-6) return [[0, 0, 0, 0, 0, 0], [w, 0, 0, 0, 0, 0], [w, h, 0, 0, 0, 0], [0, h, 0, 0, 0, 0]];
  const k = 0.5523 * r;
  return [
    [r, 0, -k, 0, 0, 0], [w - r, 0, 0, 0, k, 0], [w, r, 0, -k, 0, 0], [w, h - r, 0, 0, 0, k],
    [w - r, h, k, 0, 0, 0], [r, h, 0, 0, -k, 0], [0, h - r, 0, k, 0, 0], [0, r, 0, 0, 0, -k],
  ];
}

function circleSegs(cx, cy, r) {
  const k = 0.5523 * r;
  return [[cx + r, cy, 0, -k, 0, k], [cx, cy + r, k, 0, -k, 0], [cx - r, cy, 0, k, 0, -k], [cx, cy - r, -k, 0, k, 0]];
}

// ------------------------------------------------------------------ 卡扣测试样（实测切缝 / 板厚 / 插槽间隙）

function rectSegs(x0, y0, w, h) {
  return [[x0, y0, 0, 0, 0, 0], [x0 + w, y0, 0, 0, 0, 0], [x0 + w, y0 + h, 0, 0, 0, 0], [x0, y0 + h, 0, 0, 0, 0]];
}

function formNum(name) {
  const el = document.querySelector(`#param-form [name=${name}]`);
  return el ? Number(el.value) : NaN;
}

function setFormNum(name, v) {
  const el = document.querySelector(`#param-form [name=${name}]`);
  if (!el) return false;
  el.value = v;
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

async function engraveText(text, size, cx, cy) {
  const font = (W.fonts && W.fonts[0] || {}).id || '';
  const r = await api().text_layout({ text, font, size, weld: false });
  if (r.error) return null;
  return { id: 'tx' + (uidCounter++).toString(36), mode: 'engrave', text: { text, font, size, x: cx, y: cy, spacing: 0, lineHeight: 1.25, align: 'center', arc: 0, weld: false },
           paths: r.polys.map((p) => ({ closed: true, segs: p.map(([x, y]) => [x + cx, y + cy, 0, 0, 0, 0]) })) };
}

async function generateFitTest(t0, b0) {
  const L = FIT_LADDER;
  const slots = ladderSlots(t0);
  const W0 = L.margin * 2 + slots.length * L.pitch;
  const ladder = [{ id: 'outline', mode: 'cut', role: 'outline', paths: [{ closed: true, segs: rectSegs(0, 0, W0, L.height) }] }];
  for (let i = 0; i < slots.length; i++) {
    const s = slots[i];
    const cx = L.margin + L.pitch * (i + 0.5);
    ladder.push({ id: 'slot' + i, mode: 'cut', paths: [{ closed: true, segs: rectSegs(cx - s.width / 2, L.slotY, s.width, L.slotLen) }] });
    const lab = await engraveText(s.label, 3, cx, L.slotY + L.slotLen + 4);
    if (lab) ladder.push(lab);
  }
  const title = await engraveText(`板厚 ${t0} · 补偿 ${b0}`, 3, W0 / 2, L.height - 4);
  if (title) ladder.push(title);
  const O = FIT_SQ.outer, I = FIT_SQ.inner;
  const square = [{ id: 'outline', mode: 'cut', role: 'outline', paths: [{ closed: true, segs: rectSegs(0, 0, O, O) }] },
                  { id: 'hole', mode: 'cut', paths: [{ closed: true, segs: rectSegs((O - I) / 2, (O - I) / 2, I, I) }] }];
  const key = [{ id: 'outline', mode: 'cut', role: 'outline', paths: [{ closed: true, segs: rectSegs(0, 0, 10, 40) }] }];
  const parts = freeParts();
  const add = (name, w, h, items) => {
    const id = 'p' + Date.now().toString(36) + (uidCounter++).toString(36);
    parts.push({ id, name, w, h });
    W.project.sketches[id] = { items };
  };
  add('测试样 · 插槽阶梯', W0, L.height, ladder);
  add(`测试样 · 测量方块 ${O}/${I}`, O, O, square);
  add('测试样 · 插片', 10, 40, key);
  W.project.free.fitTest = { t0, b0, at: new Date().toISOString().slice(0, 10) };
  projectChanged();
  await loadModel();
}

async function fitTestDialog() {
  if (!isFree()) { toast('请在「自由设计」里使用卡扣测试样', 'error'); return; }
  if (!W.fonts) W.fonts = await api().list_fonts();
  let m = document.getElementById('fit-modal');
  if (!m) { m = document.createElement('div'); m.id = 'fit-modal'; m.className = 'app-modal'; document.body.appendChild(m); }
  const t0Now = formNum('thickness') || 3;
  const b0Now = formNum('burn') || 0;
  const ft = (W.project.free && W.project.free.fitTest) || null;
  const meas = W.fitMeas || {};
  m.innerHTML = `<div class="app-modal-box fit-box">
    <h3>🧪 卡扣测试样</h3>
    <p class="muted">同一种板，不同机器、不同批次的切缝和实际厚度都不一样。切一组小样量一下，卡榫和插槽就能做到不松不紧。</p>
    <h4>① 生成测试样</h4>
    <p class="sk-small">按当前设置 <b>板厚 ${t0Now} mm · 补偿 ${b0Now} mm</b> 生成 3 块：插槽阶梯（9 条槽，比板厚窄 0.10 到宽 0.30 mm）、测量方块（外 ${FIT_SQ.outer} / 内 ${FIT_SQ.inner} mm）、插片。<b>切的时候不要改这两个参数。</b></p>
    <button data-f="gen" class="primary">生成测试样（加到板件清单）</button>
    <h4>② 切好后，填测量结果</h4>
    ${ft ? `<p class="sk-small">测试样是按 板厚 ${ft.t0} · 补偿 ${ft.b0} 生成的（${ft.at}）。</p>` : '<p class="sk-small">还没生成过测试样；也可以先填，按当前设置计算。</p>'}
    <div class="np-grid">
      <label>实测板厚<input data-f="tReal" type="number" step="0.01" min="0" value="${meas.tReal ?? ''}" placeholder="卡尺量 3 处取平均"> mm</label>
      <label>测量方块·外边<input data-f="outer" type="number" step="0.01" min="0" value="${meas.outer ?? ''}" placeholder="${FIT_SQ.outer}"> mm</label>
      <label>测量方块·内孔<input data-f="inner" type="number" step="0.01" min="0" value="${meas.inner ?? ''}" placeholder="${FIT_SQ.inner}"> mm</label>
      <label>最合适的槽<select data-f="best"><option value="">（还没试）</option>
        ${FIT_STEPS.map((c) => `<option value="${c}" ${meas.best === String(c) ? 'selected' : ''}>${stepLabel(c)}</option>`).join('')}</select></label>
    </div>
    <p class="sk-small">「最合适」= 插片用手能按进去、不用敲、插好后拿起来不会掉的那一条槽。</p>
    <div class="fit-out"></div>
    <div class="app-modal-actions"><button data-f="close">关闭</button><button data-f="apply" class="primary" disabled>应用到当前设置</button></div></div>`;
  m.classList.remove('hidden');
  const q = (k) => m.querySelector(`[data-f=${k}]`);
  const base = () => ({ t0: ft ? ft.t0 : t0Now, b0: ft ? ft.b0 : b0Now });
  let res = null;
  const update = () => {
    const v = (k) => Number(q(k).value) || 0;
    W.fitMeas = { tReal: q('tReal').value, outer: q('outer').value, inner: q('inner').value, best: q('best').value };
    res = fitResult({ ...base(), tReal: v('tReal'), outer: v('outer'), inner: v('inner'), bestStep: q('best').value === '' ? null : Number(q('best').value) });
    const rows = [];
    if (res.kerf != null) rows.push(`切缝 <b>${res.kerf}</b> mm → 补偿应设为 <b>${res.burn}</b> mm`);
    if (v('tReal') > 0) rows.push(`板厚设为 <b>${res.thickness}</b> mm`);
    if (res.play != null) rows.push(`插槽间隙 <b>${res.play}</b> mm（${res.play < 0 ? '略小于板厚，靠木板压紧' : '比板厚宽一点'}）`);
    q('apply').disabled = !rows.length;
    m.querySelector('.fit-out').innerHTML = (rows.length ? `<div class="fit-res">${rows.join('<br>')}</div>` : '') +
      res.warn.map((w) => `<p class="fit-warn">⚠ ${w}</p>`).join('');
  };
  ['tReal', 'outer', 'inner', 'best'].forEach((k) => q(k).addEventListener('input', update));
  update();
  q('close').addEventListener('click', () => m.classList.add('hidden'));
  q('gen').addEventListener('click', async () => {
    q('gen').disabled = true;
    await generateFitTest(t0Now, b0Now);
    m.classList.add('hidden');
    toast('已生成 3 块测试样。切的时候不要改板厚和补偿；切好后再点「🧪 卡扣测试样」填测量结果', 'success');
  });
  q('apply').addEventListener('click', () => {
    if (!res) return;
    const done = [];
    if (res.burn != null && setFormNum('burn', res.burn)) done.push(`补偿 ${res.burn}`);
    if (Number(q('tReal').value) > 0 && setFormNum('thickness', res.thickness)) done.push(`板厚 ${res.thickness}`);
    if (res.play != null) {
      try { localStorage.setItem('seedboxes.jointPlay', String(res.play)); } catch (e) { /* 只在本机生效 */ }
      if (sketchEd) sketchEd.opts.jointPlay = res.play;
      done.push(`插槽间隙 ${res.play}`);
    }
    m.classList.add('hidden');
    toast(`已应用：${done.join('，')} mm。已经画好的卡榫 / 插槽要重新生成才会按新值`, 'success');
  });
}

async function nameplateDialog() {
  if (!W.fonts) W.fonts = await api().list_fonts();
  let m = document.getElementById('names-modal');
  if (!m) { m = document.createElement('div'); m.id = 'names-modal'; m.className = 'app-modal'; document.body.appendChild(m); }
  const o = W.namesOpts || { w: 80, h: 28, r: 5, hole: true, holeD: 4, size: 12, font: (W.fonts[0] || {}).id || '', mode: 'engrave', border: false };
  m.innerHTML = `<div class="app-modal-box">
    <h3>📛 批量名牌</h3>
    <p class="muted">每行一个名字，每个名字生成一块名牌板（会加到板件清单里）。文字太长会自动缩小。</p>
    <textarea data-n="names" rows="6" style="width:100%;box-sizing:border-box" placeholder="张三&#10;李四&#10;王五">${W.namesText || ''}</textarea>
    <div class="np-grid">
      <label>宽<input data-n="w" type="number" min="10" step="1" value="${o.w}"> mm</label>
      <label>高<input data-n="h" type="number" min="8" step="1" value="${o.h}"> mm</label>
      <label>圆角<input data-n="r" type="number" min="0" step="0.5" value="${o.r}"> mm</label>
      <label><input data-n="hole" type="checkbox" ${o.hole ? 'checked' : ''}>左边打挂孔</label>
      <label>孔径<input data-n="holeD" type="number" min="1" step="0.5" value="${o.holeD}"> mm</label>
      <label>字高<input data-n="size" type="number" min="3" step="0.5" value="${o.size}"> mm</label>
      <label>字体<select data-n="font">${W.fonts.map((f) => `<option value="${f.id}" ${f.id === o.font ? 'selected' : ''}>${f.name}</option>`).join('')}</select></label>
      <label>文字<select data-n="mode"><option value="engrave" ${o.mode === 'engrave' ? 'selected' : ''}>雕刻</option>
        <option value="cut" ${o.mode === 'cut' ? 'selected' : ''}>镂空切割（自动焊接笔画）</option><option value="score" ${o.mode === 'score' ? 'selected' : ''}>描线</option></select></label>
      <label><input data-n="border" type="checkbox" ${o.border ? 'checked' : ''}>内圈装饰边框（描线）</label>
    </div>
    <div class="app-modal-actions"><button data-m="close">取消</button><button data-m="ok" class="primary">生成名牌</button></div></div>`;
  m.classList.remove('hidden');
  m.querySelector('[data-m=close]').addEventListener('click', () => m.classList.add('hidden'));
  m.querySelector('[data-m=ok]').addEventListener('click', async () => {
    const v = (k) => m.querySelector(`[data-n=${k}]`);
    const names = v('names').value.split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
    if (!names.length) { toast('先输入名字（每行一个）', 'error'); return; }
    const opt = { w: Number(v('w').value) || 80, h: Number(v('h').value) || 28, r: Number(v('r').value) || 0, hole: v('hole').checked,
      holeD: Number(v('holeD').value) || 4, size: Number(v('size').value) || 12, font: v('font').value, mode: v('mode').value, border: v('border').checked };
    W.namesOpts = opt;
    W.namesText = v('names').value;
    const btn = m.querySelector('[data-m=ok]');
    btn.disabled = true;
    btn.textContent = `生成中… 0/${names.length}`;
    const parts = freeParts();
    const holeR = opt.holeD / 2;
    const left = opt.hole ? holeR * 2 + 4 + 2 : 4;          // 挂孔占掉的宽度
    const avail = opt.w - left - 4;
    let done = 0;
    for (const name of names) {
      let size = opt.size;
      const params = { text: name, font: opt.font, size, weld: opt.mode === 'cut' };
      let r = await api().text_layout(params);
      if (r.error) { toast(r.error, 'error'); break; }
      const maxH = opt.h - 8;
      const k = Math.min(1, avail / Math.max(1e-6, r.size[0]), maxH / Math.max(1e-6, r.size[1]));
      if (k < 0.999) { size = Math.max(2, size * k * 0.98); r = await api().text_layout({ ...params, size }); }
      const cx = left + avail / 2;
      const cy = opt.h / 2;
      const items = [{ id: 'outline', mode: 'cut', role: 'outline', paths: [{ closed: true, segs: roundRectSegs(opt.w, opt.h, opt.r) }] }];
      if (opt.hole) items.push({ id: 'hole', mode: 'cut', paths: [{ closed: true, segs: circleSegs(holeR + 3, opt.h / 2, holeR) }] });
      if (opt.border) {
        const segs = roundRectSegs(opt.w - 4, opt.h - 4, Math.max(0, opt.r - 2)).map((sg) => [sg[0] + 2, sg[1] + 2, sg[2], sg[3], sg[4], sg[5]]);
        items.push({ id: 'border', mode: 'score', paths: [{ closed: true, segs }] });
      }
      items.push({ id: 'text', mode: opt.mode, text: { ...params, size, x: cx, y: cy, spacing: 0, lineHeight: 1.25, align: 'center', arc: 0 },
        paths: r.polys.map((p) => ({ closed: true, segs: p.map(([x, y]) => [x + cx, y + cy, 0, 0, 0, 0]) })) });
      const id = 'p' + Date.now().toString(36) + (uidCounter++).toString(36);
      parts.push({ id, name, w: opt.w, h: opt.h });
      W.project.sketches[id] = { items };
      done++;
      btn.textContent = `生成中… ${done}/${names.length}`;
    }
    btn.disabled = false;
    btn.textContent = '生成名牌';
    m.classList.add('hidden');
    projectChanged();
    await loadModel();
    toast(`已生成 ${done} 块名牌。在左侧「排版」里填材料尺寸，预览 / 保存时会自动排好`, 'success');
  });
}

// ---- 自由设计：按卡榫配对自动拼装
// 从卡榫最多的板开始（保持原位），每次挑一对「已放好的板 ↔ 还没放的板」的配对卡榫，
// 在候选姿态里选不穿透、接触最多、离已拼部分最近（第一块优先往上搭）的那个。
async function freeAutoAssemble() {
  if (!W.model || !W.model.token) return null;
  const t = W.model.thickness || 3;
  const dis = new Set(W.project.disabled);
  const ids = W.model.parts.filter((p) => !dis.has(p.id) && jointsOf(p.id).length).map((p) => p.id);
  if (ids.length < 2) { toast('至少要有两块带卡榫的板才能自动拼装（用草图里的「卡榫」「插槽」工具做）', 'error'); return null; }
  const links = [];
  for (let i = 0; i < ids.length; i++) {
    for (let k = i + 1; k < ids.length; k++) {
      jointsOf(ids[i]).forEach((ja) => jointsOf(ids[k]).forEach((jb) => {
        if (ja.pair && jb.pair && ja.pair !== jb.pair) return;     // 画板里配过对的边只和自己的另一半拼
        if (mateOptions(ja, jb, t).length || mateOptions(jb, ja, t).length) links.push({ a: ids[i], b: ids[k], ja, jb });
      }));
    }
  }
  if (!links.length) { toast('没找到能配对的卡榫：两条边的长度和齿的设置要一样（A 配 B、A 配凹槽、A 配插槽）', 'error'); return null; }
  const degree = (id) => links.filter((l) => l.a === id || l.b === id).length;
  const root = ids.slice().sort((x, y) => degree(y) - degree(x))[0];
  const poses = {};                               // 记录拼装后的姿态（root 也记：之后画板里挪动它不影响装配）
  const placed = new Set([root]);
  poses[root] = partById(root).matrix.map((x) => Math.round(x * 1e4) / 1e4);
  const used = new Set();
  const M = (id) => new THREE.Matrix4().fromArray(poses[id] || partById(id).matrix);
  const centerW = (id, m) => partCenter(partById(id)).applyMatrix4(m || M(id));
  setNote('正在按卡榫自动拼装…', 'info');
  for (;;) {
    const cands = [];
    links.forEach((l) => {
      if (used.has(l.ja.id) || used.has(l.jb.id)) return;
      const aIn = placed.has(l.a); const bIn = placed.has(l.b);
      if (aIn === bIn) return;
      const q = aIn ? l.b : l.a; const pp = aIn ? l.a : l.b;
      const jq = aIn ? l.jb : l.ja; const jp = aIn ? l.ja : l.jb;
      mateOptions(jq, jp, t).forEach((F) => cands.push({ q, pp, jq, jp, T: M(pp).multiply(F) }));
    });
    if (!cands.length) break;
    const centroid = new THREE.Vector3();
    placed.forEach((id) => centroid.add(centerW(id)));
    centroid.divideScalar(placed.size);
    let best = null;
    for (const c of cands) {
      const tryPoses = {};
      placed.forEach((id) => { tryPoses[id] = M(id).toArray(); });
      tryPoses[c.q] = c.T.toArray();
      const r = await api().check_pose(W.model.token, tryPoses, [...placed, c.q], W.project.sketches || {});
      if (r.error) continue;
      const rep = r.report[c.q] || { collide: [], touch: [] };
      if (rep.collide.length) continue;
      const cw = centerW(c.q, c.T);
      const score = rep.touch.length * 1000 - cw.distanceTo(centroid) + (placed.size === 1 ? cw.z * 0.5 : 0);
      if (!best || score > best.score) best = { ...c, score };
    }
    if (!best) break;
    poses[best.q] = best.T.toArray().map((x) => Math.round(x * 1e4) / 1e4);
    placed.add(best.q);
    used.add(best.jq.id); used.add(best.jp.id);
  }
  W.project.poses = poses;
  W.model.parts.forEach((p) => {
    const o = view && view.objects.get(p.id);
    if (o) { o.group.matrix.fromArray(poseOf(p)); o.group.matrixWorldNeedsUpdate = true; }
  });
  if (view) view.fit({ ...W.model, assembled: true });
  projectChanged();
  renderPartsPanel();
  checkPose();
  const left = ids.filter((id) => !placed.has(id));
  const msg = `🧩 已按卡榫拼好 ${placed.size} 块板` + (left.length ? `；${left.map(nameOf).join('、')} 没找到能配上的卡榫` : '');
  toast(msg, left.length ? '' : 'success');
  return msg;
}

async function sfExplode() {
  const dis = new Set(W.project.disabled);
  const parts = W.model.parts.filter((p) => !dis.has(p.id) && p.id !== 'reference');
  const gap = 12;
  const boxes = parts.map((p) => {
    const xs = p.outer.map((q) => q[0]); const ys = p.outer.map((q) => q[1]);
    return { p, x0: Math.min(...xs), y0: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  });
  const total = boxes.reduce((s, b) => s + (b.w + gap) * (b.h + gap), 0);
  const rowW = Math.max(Math.sqrt(total) * 1.3, ...boxes.map((b) => b.w));
  let x = 0, y = 0, rowH = 0;
  const placed = [];
  boxes.sort((a, b) => b.h - a.h).forEach((b) => {
    if (x > 0 && x + b.w > rowW) { x = 0; y += rowH + gap; rowH = 0; }
    placed.push({ b, x, y });
    x += b.w + gap; rowH = Math.max(rowH, b.h);
  });
  const W0 = Math.max(...placed.map((q) => q.x + q.b.w)), H0 = y + rowH;
  W.project.poses = {};
  placed.forEach(({ b, x: px, y: py }) => {
    W.project.poses[b.p.id] = new THREE.Matrix4().makeTranslation(px - b.x0 - W0 / 2, py - b.y0 - H0 / 2, 0).toArray();
  });
  await sfReloadPoses('已拆开平铺：把板一块块拖回去试试（靠近正确位置会自动吸附）');
}

async function sfReloadPoses(msg) {
  if (!W.model) return;
  W.model.parts.forEach((p) => {
    const o = view.objects.get(p.id);
    if (o) { o.group.matrix.fromArray(poseOf(p)); o.group.matrixWorldNeedsUpdate = true; }
  });
  projectChanged();
  await sfLoadScene();
  sfFlash(msg);
}

// SketchForge 对象 → 指定顶点的世界坐标（与 WorkplaneViewport 的变换一致）
function sfVertex(s, j) {
  const m = s.importedMesh;
  const h = s.height;
  const sx = (s.width ?? s.size) / Math.max(0.001, m.baseWidth);
  const sy = h / Math.max(0.001, m.baseHeight);
  const sz = (s.depth ?? s.size) / Math.max(0.001, m.baseDepth);
  const v = new THREE.Vector3(m.positions[j * 3] * sx, m.positions[j * 3 + 1] * sy - h / 2, m.positions[j * 3 + 2] * sz);
  v.multiply(new THREE.Vector3(s.mirrorX ? -1 : 1, s.mirrorY ? -1 : 1, s.mirrorZ ? -1 : 1));
  v.applyEuler(new THREE.Euler(THREE.MathUtils.degToRad(s.rotationX || 0), THREE.MathUtils.degToRad(s.rotation || 0),
                               THREE.MathUtils.degToRad(s.rotationZ || 0), 'XYZ'));
  return v.add(new THREE.Vector3(s.x, (s.elevation || 0) + h / 2, s.z));
}

// 编辑器里是不是每块启用的板都在（防止场景和板件清单不一致）
async function sfSceneComplete() {
  try {
    const scene = await sfCommand('get_scene');
    const ids = new Set((scene.objects || scene.shapes || []).map((o) => o.id));
    const dis = new Set(W.project.disabled);
    const want = W.model.parts.filter((p) => !dis.has(p.id) && p.id !== 'reference' && view.objects.get(p.id)).map((p) => p.id);
    const have = new Set([...SF.map].filter(([sid]) => ids.has(sid)).map(([, info]) => info.pid));
    return want.every((id) => have.has(id));
  } catch (e) { return false; }
}

// 读回编辑器里的摆放 → W.project.poses
async function sfSync() {
  if (!SF.frame || !W.model || SF.syncing) { SF.dirty = true; return; }
  SF.syncing = true;
  try {
    const scene = await sfCommand('get_scene', { includeRawShapes: true });
    const raw = new Map((scene.rawShapes || []).map((s) => [s.id, s]));
    const C = view.root.matrix.clone();
    const Ci = C.clone().invert();
    const stats = { moved: 0, removed: [], reshaped: [], scaled: [] };
    const disabled = new Set(W.project.disabled);
    W.project.poses = W.project.poses || {};
    SF.map.forEach((info, sid) => {
      const s = raw.get(sid);
      // 3D 编辑器里删掉的板：只是从装配场景里拿走，不改图纸（要不导出请取消「使用」）；下次打开会重新放回
      if (!s) { stats.removed.push(info.pid); return; }
      const m = s.importedMesh;
      if (!m || !m.positions || m.positions.length / 3 <= Math.max(...info.idx)) { stats.reshaped.push(info.pid); return; }
      const now = info.idx.map((j) => sfVertex(s, j).sub(SF.off));
      const d01 = now[1].distanceTo(now[0]), r01 = info.ref[1].distanceTo(info.ref[0]);
      if (Math.abs(d01 - r01) > 0.05 + r01 * 0.002) stats.scaled.push(info.pid);
      const delta = frameOf(...now).multiply(frameOf(...info.ref).invert());   // three 世界中的刚体变换
      const pose = Ci.clone().multiply(delta).multiply(C).multiply(info.base);
      const arr = pose.toArray().map((x) => Math.round(x * 1e4) / 1e4);
      const p = W.model.parts.find((q) => q.id === info.pid);
      const same = !isFree() && arr.every((x, k) => Math.abs(x - p.matrix[k]) < 1e-3);
      if (same) delete W.project.poses[info.pid]; else { W.project.poses[info.pid] = arr; stats.moved++; }
      const o = view.objects.get(info.pid);
      if (o) { o.group.matrix.fromArray(poseOf(p)); o.group.matrixWorldNeedsUpdate = true; }
    });
    W.project.disabled = [...disabled];
    if (stats.removed.length) {
      stats.removed.forEach((pid) => { for (const [sid, info] of SF.map) if (info.pid === pid) SF.map.delete(sid); });
      SF.key = null;                                // 下次打开 3D 编辑器时重新导入全部板件
    }
    SF.stats = stats;
    projectChanged();
    const prev = SF.prevPoses || {};
    const now = currentPoses();
    const moved = Object.keys(now).filter((id) => prev[id] && now[id].some((v, k) => Math.abs(v - prev[id][k]) > 1e-3));
    if (moved.length) await sfTrySnap(moved, prev);
    SF.prevPoses = currentPoses();
  } catch (err) {
    console.warn('sfSync', err);
  } finally {
    SF.syncing = false;
    if (SF.dirty) { SF.dirty = false; setTimeout(sfSync, 50); }
  }
}

async function openSketchForge() {
  if (SF.open) return;
  if (!W.model || W.stale) await loadModel();
  if (!W.model || !W.model.parts.length || !view) { toast('没有可编辑的 3D 模型', 'error'); return; }
  closeEditor();
  SF.open = true;
  $('#btn-sf').classList.add('on');
  $('#sf-host').classList.remove('hidden');
  const loading = $('#sf-loading');
  loading.classList.remove('hidden');
  loading.textContent = '正在启动 3D 编辑器…';
  try {
    await sfEnsureFrame();
    if (SF.key === sfSceneKey() && !(await sfSceneComplete())) SF.key = null;   // 编辑器里少了板 → 重新导入
    if (SF.key !== sfSceneKey()) {
      loading.textContent = '正在导入板件…';
      pushUndo();
      await sfLoadScene();
    }
    loading.classList.add('hidden');
    if (!$('#sf-host .sf-bar')) {
      const bar = document.createElement('div');
      bar.className = 'sf-bar';
      bar.innerHTML = '<button data-sf="assemble" title="所有板回到生成器算好的装配位置">一键装配</button>' +
        '<button data-sf="explode" title="把所有板平放在台面上，练习手动拼装">拆开平铺</button>' +
        '<button data-sf="snap" class="on" title="板拖到正确位置附近时自动对准相邻的板">🧲 磁吸</button>' +
        '<button data-sf="back" class="sf-back">✓ 完成 · 返回 SeedLaser</button>';
      bar.querySelector('[data-sf=back]').addEventListener('click', closeSketchForge);
      bar.querySelector('[data-sf=assemble]').addEventListener('click', () => sfAssembleAll());
      bar.querySelector('[data-sf=explode]').addEventListener('click', () => sfExplode());
      bar.querySelector('[data-sf=snap]').addEventListener('click', (ev) => {
        SF.snap = !SF.snap;
        ev.currentTarget.classList.toggle('on', SF.snap);
        sfFlash(SF.snap ? '磁吸已打开' : '磁吸已关闭');
      });
      const msg = document.createElement('div');
      msg.id = 'sf-msg';
      msg.className = 'sf-msg hidden';
      $('#sf-host').append(bar, msg);
      bar.querySelector('[data-sf=assemble]').disabled = !W.model.assembled && !isFree();
      bar.querySelector('[data-sf=snap]').disabled = !W.model.assembled && !isFree();
      if (!W.model.assembled) bar.querySelector('[data-sf=assemble]').title = isFree() ? '按卡榫配对把板自动拼起来' : '这个生成器没有装配信息';
    }
  } catch (err) {
    loading.textContent = String(err.message || err);
    toast(String(err.message || err), 'error');
    setTimeout(() => { if (SF.open && !SF.frame) closeSketchForge(); }, 2500);
  }
}

async function closeSketchForge() {
  if (!SF.open) return;
  SF.open = false;
  $('#btn-sf').classList.remove('on');
  if (SF.frame && SF.key) {
    if (SF.syncing) await new Promise((r) => { const t = setInterval(() => { if (!SF.syncing) { clearInterval(t); r(); } }, 40); });
    await sfSync();
  }
  $('#sf-host').classList.add('hidden');
  if (view) { view.refreshStates(); view.resize(); }
  renderPartsPanel();
  const st = SF.stats;
  if (!st) return;
  const warn = [];
  if (st.removed.length) warn.push(`${st.removed.map(nameOf).join('、')} 在 3D 编辑器里被删掉了：这只影响装配场景，图纸里仍然保留，下次打开 3D 编辑器会放回。不想切这块板，请在「③ 加工作业」的加工清单里取消勾选`);
  if (st.reshaped.length) warn.push(`${st.reshaped.map(nameOf).join('、')} 形状被修改，位置未同步`);
  if (st.scaled.length) warn.push(`${st.scaled.map(nameOf).join('、')} 尺寸改动不会影响图纸（请改左侧参数）`);
  checkPose();   // 显示咬合 / 穿透检查结果（没有摆放时清除标记）
  if (warn.length) setTimeout(() => setNote(warn.join('；'), 'info'), st.moved ? 700 : 0);
}

function setPartsPanelVisible(on) {
  $('#parts-panel').classList.toggle('gone', !on);
  $('#btn-parts').classList.toggle('on', on);
  try { localStorage.setItem('seedboxes.partsPanel', on ? '1' : '0'); } catch (e) { /* 忽略 */ }
  if (view) view.resize();
}

// ------------------------------------------------------------------ 对外接口（app.js 调用）

function hasContent() {
  if (isFree()) return true;
  return W.project.disabled.length > 0 || Object.values(W.project.edits).some((l) => l && l.length)
    || Object.keys(W.project.poses || {}).length > 0 || Object.keys(W.project.sketches || {}).length > 0;
}

window.SeedWorkshop = {
  wantSheet() { W.wantSheet = true; W.freeStash = null; },          // 新建设计：不接着上一个
  startWith(ex) { W.startEx = ex; W.freeStash = null; },
  hasDesign() { return !!W.freeStash; },
  // 多开：快速建模「放进某个标签的设计」——把那个标签的项目数据当作要接着用的设计；null = 放进新设计
  setStash(data) {
    if (!data) { W.freeStash = null; W.freeStashParams = null; return; }
    W.freeStash = JSON.parse(JSON.stringify({ disabled: data.disabled || [], edits: data.edits || {}, poses: data.poses || {},
      sketches: data.sketches || {}, free: data.free || null }));
    W.freeStashParams = data.params ? { ...data.params } : null;
  },
  importToDesign() { return importToDesign(); },
  openSheet() { return openSheet(); },
  reset(name) {
    closeEditor(true);      // 先关画板：把画板内容写回当前项目（必须在换成新项目之前），不触发去 3D
    // 从「设计」去快速建模：先把当前设计留着，之后「放进当前设计」时接着用
    if (W.name === 'FreeDesign' && name !== 'FreeDesign' && hasContent()) {
      W.freeStash = JSON.parse(JSON.stringify(W.project));
      W.freeStashParams = window.SeedApp ? window.SeedApp.collectParams() : null;
    }
    W.name = name;
    W.stage = name === 'FreeDesign' ? 'design' : null;
    W.model = null;
    W.project = freshProject();
    W.selected = null;
    W.multi.clear();
    W.pose.report = null;
    W.pose.undo = []; W.pose.redo = [];
    W.stale = true;
    W.previewStale = false;
    closeEditor();
    if (SF.open) { SF.open = false; $('#sf-host').classList.add('hidden'); $('#btn-sf').classList.remove('on'); }
    SF.key = null; SF.map.clear(); SF.stats = null;
    if (view) view.clear();
    $('#parts-panel').innerHTML = '';
    setNote('');
    // 不在这里加载：此时左侧表单还是上一个生成器的参数，等 formReady()
  },
  formReady() {
    W.stale = true;
    if (isFree() && W.pendingImport) applyPendingImport();
    else if (isFree() && W.startEx) { startExample(); return; }
    if (isFree()) {
      if (!freeParts().length) {
        freeParts().push({ id: 'p1', name: '板件 1', w: 100, h: 60 });
        W.project.sketches.p1 = rectSketch(100, 60);
      }
      if (!W.wantSheet) W.stage = 'assemble';
      updateStageBar();
      if (W.mode !== '3d') { setMode('3d'); return; }
    }
    if (W.mode === '3d') loadModel();
  },
  getProject() {
    if (!hasContent()) return null;
    const edits = {};
    Object.entries(W.project.edits).forEach(([k, v]) => { if (v && v.length) edits[k] = v; });
    return { disabled: [...W.project.disabled], edits, poses: { ...(W.project.poses || {}) },
             sketches: JSON.parse(JSON.stringify(W.project.sketches || {})),
             free: W.project.free ? JSON.parse(JSON.stringify(W.project.free)) : null };
  },
  setProject(p) {
    W.project = { disabled: [...(p.disabled || [])], edits: JSON.parse(JSON.stringify(p.edits || {})),
                  poses: JSON.parse(JSON.stringify(p.poses || {})),
                  sketches: JSON.parse(JSON.stringify(p.sketches || {})),
                  free: p.free ? JSON.parse(JSON.stringify(p.free)) : null };
    W.pose.undo = []; W.pose.redo = [];
    W.stale = true;
    if (W.mode === '3d') loadModel();
  },
  hasContent,
  flush() { if (sketchEd && sketchEd.opened) sketchEd.flushChange(); },
  // 多开项目：切到别的标签 / 回主页前，把画板内容写回项目并关掉画板（不去 3D）
  park() {
    if (sketchEd && sketchEd.opened) sketchEd.flushChange();
    closeEditor(true);
    if (SF.open) { SF.open = false; $('#sf-host').classList.add('hidden'); $('#btn-sf').classList.remove('on'); }
  },
  get stage() { return W.stage; },
  setFileLabel(t) { if (sketchEd) sketchEd.setFileLabel(t); },
  paramsChanged: debounce(() => {
    W.stale = true;
    if (!(W.quietParamsUntil && Date.now() < W.quietParamsUntil)) W.paramsDirty = true;
    if (W.mode === '3d') loadModel();
  }, 600),
  refresh() { W.stale = true; if (W.mode === '3d') loadModel(); },
  get mode() { return W.mode; },
};

// ------------------------------------------------------------------ 绑定

$('#tab-2d').addEventListener('click', () => setMode('2d'));
document.querySelectorAll('#stage-bar [data-stage]').forEach((b) => b.addEventListener('click', () => setStage(b.dataset.stage)));
$('#tab-3d').addEventListener('click', () => setMode('3d'));
$('#btn-sf').addEventListener('click', () => (SF.open ? closeSketchForge() : openSketchForge()));
$('#btn-parts').addEventListener('click', () => setPartsPanelVisible($('#parts-panel').classList.contains('gone')));
try { if (localStorage.getItem('seedboxes.partsPanel') === '0') setPartsPanelVisible(false); else $('#btn-parts').classList.add('on'); }
catch (e) { $('#btn-parts').classList.add('on'); }
document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => view && view.view(b.dataset.view)));

// 浏览器调试模式（?dev=1）下暴露内部状态，供自动化测试
if (new URLSearchParams(location.search).has('dev')) {
  window.__seedDebug = {
    W, THREE,
    get view() { return view; },
    get poser() { return poser; },
    get sketchEd() { return sketchEd; },
    SF, sfCommand, sfSync, freeAutoAssemble, openSheet, setStage, fitTestDialog, generateFitTest, openSketchForge, closeSketchForge, sfReloadPoses, mateOptions, jointsOf, freeAdd, openEditor, partById,
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
