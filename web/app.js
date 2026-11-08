// Boxes.py 客户端前端逻辑
'use strict';

const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const state = {
  groups: [],
  byName: new Map(),       // 生成器名 → 所属分组
  current: null,
  currentInfo: null,
  zoom: 1.0,
  view: 'home',
  reqId: 0,                // 单调递增请求标识，防止快速切换的回调写入过期视图
};

// ---- 等待 pywebview 桥接就绪 ----
function whenApiReady() {
  return new Promise((resolve) => {
    if (window.pywebview && window.pywebview.api) return resolve();
    window.addEventListener('pywebviewready', resolve);
  });
}

// ---- toast ----
let toastTimer = null;
function toast(msg, kind = '') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = 'toast ' + kind;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2400);
}
function setStatus(msg) { $('#status').textContent = msg; }

// ---- 视图切换 ----
function showView(view) {
  state.view = view;
  setTimeout(() => { if (typeof renderTabs === 'function') renderTabs(); }, 0);
  // 主页和自由设计不显示左侧模型库；模型库 / 分组 / 模型参数页显示
  const free = view === 'editor' && state.current === 'FreeDesign';
  $('#app').classList.toggle('no-sidebar', view === 'home' || free);
  $('#home').classList.toggle('hidden', view !== 'home');
  if (view === 'home') renderRecent();
  $('#welcome').classList.toggle('hidden', view !== 'welcome');
  $('#browse').classList.toggle('hidden', view !== 'browse');
  $('#editor').classList.toggle('hidden', view !== 'editor');
}

// ---- 加载格式 ----
async function loadFormats() {
  try {
    const info = await window.pywebview.api.list_formats();
    const sel = $('#format-select');
    sel.innerHTML = '';
    (info.formats || []).forEach((f) => {
      const opt = document.createElement('option');
      opt.value = f.value;
      opt.textContent = f.label;
      sel.appendChild(opt);
    });
    if (!info.pstoedit && !info.ps2pdf) {
      sel.title = '提示：未检测到 pstoedit 与 ps2pdf，仅可输出 SVG / PS / LBRN2。\n如需 DXF/GCode/PDF，请安装相应工具后重启客户端。';
    } else if (!info.pstoedit) {
      sel.title = '未检测到 pstoedit，DXF/GCode/PLT 不可用。';
    } else if (!info.ps2pdf) {
      sel.title = '未检测到 ps2pdf，PDF 输出不可用。';
    }
  } catch (err) {
    toast('加载格式失败: ' + err, 'error');
  }
}

// ---- 加载分组数据 ----
async function loadGroups() {
  setStatus('加载生成器…');
  try {
    const groups = await window.pywebview.api.list_groups();
    state.groups = groups || [];
    state.byName.clear();
    state.groups.forEach((g) => g.generators.forEach((x) => state.byName.set(x.name, g)));
    renderSidebar();
    renderGallery();
    const total = state.groups.reduce((s, g) => s + g.generators.length, 0);
    setStatus(`共 ${total} 个生成器，分 ${state.groups.length} 组`);
  } catch (err) {
    setStatus('加载失败');
    toast('加载生成器失败: ' + err, 'error');
  }
}

// ---- 渲染左侧分组 ----
function renderSidebar(filter = '') {
  const container = $('#group-list');
  container.innerHTML = '';
  const f = filter.trim().toLowerCase();
  state.groups.forEach((group) => {
    const items = group.generators.filter(
      (g) => !f || g.name.toLowerCase().includes(f) || (g.description || '').toLowerCase().includes(f)
    );
    if (items.length === 0) return;
    const groupEl = document.createElement('div');
    groupEl.className = 'group';
    if (!f) groupEl.classList.add('collapsed');
    const header = document.createElement('div');
    header.className = 'group-header';
    header.innerHTML = `<span class="caret">▾</span><span>${escapeHtml(group.title)}</span><span style="margin-left:auto;font-weight:400;opacity:0.6">${items.length}</span>`;
    header.addEventListener('click', () => groupEl.classList.toggle('collapsed'));
    const list = document.createElement('div');
    list.className = 'group-items';
    items.forEach((g) => {
      const item = document.createElement('div');
      item.className = 'gen-item';
      item.dataset.name = g.name;
      item.title = g.description ? `${g.description}（${g.name}）` : g.name;
      // 中文描述在前，英文名在括号里
      if (g.description) {
        item.innerHTML = `<span class="gen-item-zh">${escapeHtml(g.description)}</span><span class="gen-item-en">${escapeHtml(g.name)}</span>`;
      } else {
        item.textContent = g.name;
      }
      item.addEventListener('click', () => selectGenerator(g.name));
      list.appendChild(item);
    });
    groupEl.appendChild(header);
    groupEl.appendChild(list);
    container.appendChild(groupEl);
  });
  if (container.children.length === 0) {
    container.innerHTML = '<div class="loading">没有匹配的生成器</div>';
  }
}

// ---- 渲染欢迎页：分组卡片画廊 ----
function renderGallery() {
  const grid = $('#group-gallery');
  grid.innerHTML = '';
  state.groups.forEach((group) => {
    if (!group.generators.length) return;
    const card = document.createElement('div');
    card.className = 'group-card';
    card.addEventListener('click', () => browseGroup(group.name));
    const thumb = document.createElement('div');
    thumb.className = 'card-thumb';
    if (group.thumbnail) {
      // group.thumbnail 是 "RoundedBox-thumb.jpg" 这种，直接按生成器名取
      const repName = group.thumbnail.replace(/-thumb\.jpg$/, '');
      loadThumb(thumb, repName);
    } else {
      thumb.textContent = group.title;
    }
    const body = document.createElement('div');
    body.className = 'card-body';
    body.innerHTML = `
      <div class="card-title">${escapeHtml(group.title)}</div>
      <div class="card-meta">${group.generators.length} 个生成器</div>
      ${group.description ? `<div class="card-desc">${escapeHtml(group.description)}</div>` : ''}
    `;
    card.appendChild(thumb);
    card.appendChild(body);
    grid.appendChild(card);
  });
}

// ---- 浏览某个分组 ----
function browseGroup(groupName) {
  const group = state.groups.find((g) => g.name === groupName);
  if (!group) return;
  $('#browse-title').textContent = group.title;
  $('#browse-title-big').textContent = group.title;
  $('#browse-desc').textContent = group.description
    ? `${group.description} · 共 ${group.generators.length} 个生成器`
    : `共 ${group.generators.length} 个生成器`;
  const grid = $('#browse-grid');
  grid.innerHTML = '';
  group.generators.forEach((g) => {
    const card = document.createElement('div');
    card.className = 'gen-card';
    card.addEventListener('click', () => selectGenerator(g.name));
    const thumb = document.createElement('div');
    thumb.className = 'thumb loading';
    loadThumb(thumb, g.name);
    const name = document.createElement('div');
    name.className = 'name';
    if (g.description) {
      name.innerHTML = `${escapeHtml(g.description)} <span class="card-en">(${escapeHtml(g.name)})</span>`;
    } else {
      name.textContent = g.name;
    }
    const desc = document.createElement('div');
    desc.className = 'desc';
    desc.textContent = g.description ? '' : ''; // 描述已并入标题，留空
    card.appendChild(thumb);
    card.appendChild(name);
    card.appendChild(desc);
    grid.appendChild(card);
  });
  showView('browse');
  $('#browse').scrollTop = 0;
}

// ---- 缩略图懒加载（IntersectionObserver）----
const thumbCache = new Map();
const thumbObserver = ('IntersectionObserver' in window) ? new IntersectionObserver((entries) => {
  entries.forEach((entry) => {
    if (entry.isIntersecting) {
      const el = entry.target;
      thumbObserver.unobserve(el);
      _fetchThumb(el, el.dataset.gen);
    }
  });
}, { rootMargin: '120px' }) : null;

function loadThumb(el, name) {
  el.dataset.gen = name;
  if (thumbObserver) {
    thumbObserver.observe(el);
  } else {
    _fetchThumb(el, name);
  }
}
async function _fetchThumb(el, name) {
  if (thumbCache.has(name)) {
    const [uri, kind] = thumbCache.get(name);
    applyThumb(el, uri, kind);
    return;
  }
  try {
    const r = await window.pywebview.api.get_thumbnail(name);
    const uri = r.data || '';
    const kind = r.kind || '';
    thumbCache.set(name, [uri, kind]);
    applyThumb(el, uri, kind);
  } catch (err) { /* 缩略图失败不影响主流程 */ }
}
function applyThumb(el, uri, kind) {
  el.classList.remove('loading');
  el.classList.toggle('is-rendered', kind === 'rendered');
  if (uri) {
    el.style.backgroundImage = `url("${uri}")`;
  } else {
    el.textContent = '无图';
    el.style.color = 'var(--text-mute)';
    el.style.display = 'flex';
    el.style.alignItems = 'center';
    el.style.justifyContent = 'center';
    el.style.fontSize = '11px';
  }
}

// ---- 选择生成器 → 进入编辑器 ----
async function selectGenerator(name) {
  if (!tabs.loading) {
    // 在设计里去模型库：当前标签先暂存（之后「放进当前设计」回到这个标签）
    if (name !== 'FreeDesign' && tabs.active) { tabs.returnTo = tabs.active; parkActiveKeepStash(); }
    // 从模型库「放进设计」：回到原来的标签，或开一个新标签
    if (name === 'FreeDesign' && !tabs.active) {
      const back = tabs.returnTo && window.SeedWorkshop && window.SeedWorkshop.hasDesign() ? tabs.list.find((t) => t.id === tabs.returnTo) : null;
      if (back) { back.data = null; tabs.active = back.id; state.projectPath = back.path || null; state.forcedDirty = true; }
      else { const t = { id: `t${++tabs.seq}`, path: null, data: null, dirty: false }; tabs.list.push(t); tabs.active = t.id; state.projectPath = null; state.forcedDirty = false; }
      tabs.returnTo = null;
      setTimeout(renderTabs, 0);
    }
  }
  const myReq = ++state.reqId;
  state.current = name;
  state.hasPreview = false;
  if (window.SeedWorkshop) window.SeedWorkshop.reset(name);
  $$('#group-list .gen-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.name === name);
  });
  $('#gen-name').textContent = name === 'FreeDesign' ? '设计' : name;
  $('#btn-to-design').classList.toggle('hidden', name === 'FreeDesign');
  // 多开：主按钮放进最近编辑的那个设计（标签），旁边「放进新设计」开新标签
  const target = tabs.list.find((t) => t.id === tabs.lastActive);
  $('#btn-to-design').textContent = target ? `放进「${tabTitle(target)}」→` : '放进新设计 →';
  $('#btn-to-new').classList.toggle('hidden', name === 'FreeDesign' || !target);
  $('#editor-back-home').querySelector('span:last-child').textContent = name === 'FreeDesign' ? '主页' : '模型库';
  $('#gen-desc').textContent = '加载中…';
  const ownerGroup = state.byName.get(name);
  $('#editor-bc-group').textContent = ownerGroup ? ownerGroup.title : '分组';
  $('#editor-back-group').style.display = ownerGroup ? '' : 'none';
  $('#param-form').innerHTML = '<div class="loading">加载参数…</div>';
  $('#preview-host').innerHTML = '<div class="preview-empty">点击「预览」即可渲染当前参数</div>';
  $('#preview-info').textContent = '未渲染';
  $('#sample-card').classList.add('hidden');
  showView('editor');

  const [info, imgRes] = await Promise.allSettled([
    window.pywebview.api.get_generator(name),
    window.pywebview.api.get_image(name),
  ]);
  // 过期请求：用户已经切走，不要写入新视图
  if (myReq !== state.reqId) return;

  if (info.status === 'fulfilled' && info.value && !info.value.error) {
    state.currentInfo = info.value;
    $('#gen-desc').textContent = info.value.description || '';
    renderForm(info.value);
    if (window.SeedWorkshop) window.SeedWorkshop.formReady();
  } else {
    let err = '';
    if (info.status === 'fulfilled') {
      err = (info.value && info.value.error) || '未知错误';
    } else {
      err = info.reason ? (info.reason.message || String(info.reason)) : '请求失败';
    }
    $('#param-form').innerHTML = `<div class="preview-error">加载失败：${escapeHtml(String(err))}</div>`;
  }

  if (name !== 'FreeDesign' && imgRes.status === 'fulfilled' && imgRes.value && imgRes.value.data) {
    $('#sample-img').src = imgRes.value.data;
    $('#sample-card').classList.remove('hidden');
    const isRendered = imgRes.value.kind === 'rendered';
    $('#sample-card').classList.toggle('is-rendered', isRendered);
    $('.sample-caption').textContent = isRendered ? '示意图（自动渲染）' : '作品参考图';
  }
}

// 常用材料：选中后填入板厚和激光补偿（burn）
const MATERIALS = [
  { name: '椴木板 3 mm', t: 3, burn: 0.1 },
  { name: '椴木板 5 mm', t: 5, burn: 0.1 },
  { name: '亚克力 3 mm', t: 3, burn: 0.08 },
  { name: '亚克力 5 mm', t: 5, burn: 0.1 },
  { name: '密度板 3 mm', t: 3, burn: 0.12 },
  { name: '瓦楞纸板 3 mm', t: 3, burn: 0.05 },
];

function materialField(form) {
  const th = form.querySelector('[name=thickness]');
  const burn = form.querySelector('[name=burn]');
  if (!th || !burn) return null;
  const fs = document.createElement('fieldset');
  fs.className = 'material-fs';
  fs.innerHTML = `<legend>材料</legend><div class="field"><label for="f_material"><span class="pmain">选择材料，自动填入板厚和激光补偿</span></label>
    <select id="f_material" data-skip="1"><option value="">自定义（直接改下方「材料厚度」「burn」）</option>
    ${MATERIALS.map((m, i) => `<option value="${i}">${m.name} · 补偿 ${m.burn} mm</option>`).join('')}</select>
    <div class="material-tip">实测板厚和标称常有差别（如标称 3 mm 实测 2.8 mm），以实测为准，卡榫才会松紧合适。</div></div>`;
  const sel = fs.querySelector('select');
  const sync = () => {
    const i = MATERIALS.findIndex((m) => Math.abs(m.t - Number(th.value)) < 1e-6 && Math.abs(m.burn - Number(burn.value)) < 1e-6);
    sel.value = i >= 0 ? String(i) : '';
  };
  sel.addEventListener('change', () => {
    const m = MATERIALS[Number(sel.value)];
    if (!m || sel.value === '') return;
    th.value = m.t;
    burn.value = m.burn;
    th.dispatchEvent(new Event('change', { bubbles: true }));
  });
  th.addEventListener('input', sync);
  burn.addEventListener('input', sync);
  sync();
  return fs;
}

function renderForm(info) {
  const form = $('#param-form');
  form.innerHTML = '';
  (info.groups || []).forEach((g) => {
    if (!g.params || g.params.length === 0) return;
    const fs = document.createElement('fieldset');
    if (g.title) {
      const lg = document.createElement('legend');
      lg.textContent = g.title;
      fs.appendChild(lg);
    }
    g.params.forEach((p) => fs.appendChild(buildField(p)));
    form.appendChild(fs);
  });
  const mat = materialField(form);
  if (mat) form.insertBefore(mat, form.firstChild);
}

function buildField(param) {
  const wrap = document.createElement('div');
  wrap.className = 'field';
  const help = (param.help || '').trim();
  // 主标签：中文 help（无则退回英文名）；副标签：英文参数名
  const mainLabel = help || param.name;
  const subLabel = help ? param.name : '';
  const labelHtml = `<span class="pmain">${escapeHtml(mainLabel)}${
    subLabel ? ` <span class="pname">(${escapeHtml(subLabel)})</span>` : ''
  }</span>`;

  if (param.type === 'bool') {
    wrap.classList.add('field-bool');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.name = param.name;
    cb.id = `f_${param.name}`;
    cb.checked = param.default === 'True' || param.default === '1' || param.default === 'true';
    const lbl = document.createElement('label');
    lbl.htmlFor = cb.id;
    lbl.innerHTML = labelHtml;
    wrap.appendChild(cb);
    wrap.appendChild(lbl);
    return wrap;
  }

  const lbl = document.createElement('label');
  lbl.htmlFor = `f_${param.name}`;
  lbl.innerHTML = `${labelHtml}<span class="pdefault">默认：${escapeHtml(param.default || '')}</span>`;
  wrap.appendChild(lbl);

  let input;
  if (param.type === 'choice') {
    input = document.createElement('select');
    (param.choices || []).forEach((c) => {
      const opt = document.createElement('option');
      const val = (typeof c === 'object') ? c.value : String(c);
      const lblText = (typeof c === 'object') ? c.label : String(c);
      opt.value = val;
      opt.textContent = lblText !== val ? `${lblText}（${val}）` : val;
      if (val === param.default) opt.selected = true;
      input.appendChild(opt);
    });
  } else if (param.type === 'int' || param.type === 'float') {
    input = document.createElement('input');
    input.type = 'number';
    if (param.type === 'float') input.step = 'any';
    input.value = param.default;
  } else {
    input = document.createElement('input');
    input.type = 'text';
    input.value = param.default;
  }
  input.name = param.name;
  input.id = `f_${param.name}`;
  wrap.appendChild(input);
  return wrap;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}

function collectParams() {
  const params = {};
  $('#param-form').querySelectorAll('input, select').forEach((el) => {
    if (el.dataset.skip || !el.name) return;
    if (el.type === 'checkbox') {
      params[el.name] = el.checked ? 1 : 0;
    } else if (el.value !== '') {
      params[el.name] = el.value;
    }
  });
  return params;
}

// ---- 预览 ----
async function doPreview() {
  if (!state.current) return;
  const myReq = ++state.reqId;
  const targetName = state.current;
  setStatus('渲染中…');
  $('#btn-preview').disabled = true;
  try {
    const params = collectParams();
    const project = window.SeedWorkshop ? window.SeedWorkshop.getProject() : null;
    if (window.SeedWorkshop && window.SeedWorkshop.mode === '3d') window.SeedWorkshop.refresh();
    const result = await window.pywebview.api.preview(targetName, params, project);
    // 过期：用户已切走或重新点了预览
    if (myReq !== state.reqId || targetName !== state.current) return;
    if (result.error) {
      $('#preview-host').innerHTML = '';
      const err = document.createElement('div');
      err.className = 'preview-error';
      err.textContent = result.error;
      $('#preview-host').appendChild(err);
      $('#preview-info').textContent = '渲染失败';
      setStatus('渲染失败');
      return;
    }
    if (result.svg) {
      state.zoom = 1.0;
      mountSvg(result.svg);
      state.hasPreview = true;
      $('#preview-info').textContent = `SVG · ${formatBytes(result.svg.length)}` + (result.info && result.info.length ? ` · ${result.info.join('；')}` : '');
      if (result.notes && result.notes.length) toast(result.notes.join('；'), 'error');
      setStatus('就绪');
    }
  } catch (err) {
    if (myReq !== state.reqId) return;
    toast('预览失败: ' + err, 'error');
    setStatus('就绪');
  } finally {
    $('#btn-preview').disabled = false;
  }
}

// 用 DOMParser 解析 SVG 后挂载，避免 innerHTML 引入潜在的 <script>/事件
function mountSvg(svgText) {
  const host = $('#preview-host');
  host.innerHTML = '';
  let svg = null;
  try {
    const doc = new DOMParser().parseFromString(svgText, 'image/svg+xml');
    const root = doc.documentElement;
    if (root && root.localName === 'svg') {
      // 移除任何 <script> 节点和 on* 事件属性（纵深防御）
      root.querySelectorAll('script').forEach((el) => el.remove());
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      let node = walker.currentNode;
      do {
        if (node.attributes) {
          for (let i = node.attributes.length - 1; i >= 0; i--) {
            const a = node.attributes[i];
            if (a.name.toLowerCase().startsWith('on')) node.removeAttributeNode(a);
          }
        }
        node = walker.nextNode();
      } while (node);
      svg = document.importNode(root, true);
      host.appendChild(svg);
    }
  } catch (e) {
    host.innerHTML = '<div class="preview-error">SVG 解析失败</div>';
    return;
  }
  if (svg) {
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.style.transformOrigin = 'center center';
    applyZoom();
  }
}
function applyZoom() {
  const svg = $('#preview-host svg');
  if (svg) svg.style.transform = `scale(${state.zoom})`;
}
function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1024 / 1024).toFixed(2) + ' MB';
}

// ---- 保存 ----
// ---- 加工参数（每个图层的速度 / 功率 / 遍数）----
const LASER_LAYERS = [
  { key: 'cut', name: '切割', color: '黑色 / 蓝色', swatch: '#111827', hint: '外轮廓（黑）和内孔（蓝）；编辑器里统一显示为黑色' },
  { key: 'engrave', name: '雕刻', color: '绿色', swatch: '#16a34a', hint: '填充雕刻' },
  { key: 'score', name: '描线', color: '品红', swatch: '#dc2626', hint: '沿线浅刻（编辑器里显示为红色，导出文件仍是品红）' },
];
const LASER_PRESETS = {
  '椴木板 3 mm': { cut: [10, 70, 1], engrave: [200, 22, 1], score: [40, 18, 1] },
  '椴木板 5 mm': { cut: [6, 85, 1], engrave: [200, 25, 1], score: [40, 20, 1] },
  '亚克力 3 mm': { cut: [8, 75, 1], engrave: [250, 20, 1], score: [50, 15, 1] },
  '密度板 3 mm': { cut: [8, 80, 1], engrave: [200, 25, 1], score: [40, 20, 1] },
  '瓦楞纸板': { cut: [30, 35, 1], engrave: [300, 10, 1], score: [80, 8, 1] },
};

function loadLaser() {
  try {
    const v = JSON.parse(localStorage.getItem('seedboxes.laser') || 'null');
    if (v && v.cut) return v;
  } catch (e) { /* 忽略 */ }
  const p = LASER_PRESETS['椴木板 3 mm'];
  return { preset: '椴木板 3 mm', cut: { speed: p.cut[0], power: p.cut[1], passes: p.cut[2] },
    engrave: { speed: p.engrave[0], power: p.engrave[1], passes: p.engrave[2] }, score: { speed: p.score[0], power: p.score[1], passes: p.score[2] } };
}
state.laser = loadLaser();

function saveLaser() {
  try { localStorage.setItem('seedboxes.laser', JSON.stringify(state.laser)); } catch (e) { /* 忽略 */ }
}

function openLaserDialog() {
  let m = document.getElementById('laser-modal');
  if (!m) { m = document.createElement('div'); m.id = 'laser-modal'; m.className = 'app-modal'; document.body.appendChild(m); }
  const L = state.laser;
  m.innerHTML = `<div class="app-modal-box">
    <h3>加工参数</h3>
    <p class="muted">保存图纸时会在同一个文件夹写一份「加工参数说明」，照着它在激光软件（LaserMaker、LightBurn 等）里按颜色设置图层。</p>
    <div class="laser-presets">参考值：${Object.keys(LASER_PRESETS).map((k) => `<button data-preset="${k}" class="${L.preset === k ? 'on' : ''}">${k}</button>`).join('')}</div>
    <table class="laser-table"><thead><tr><th>图层</th><th>颜色</th><th>速度 mm/s</th><th>功率 %</th><th>遍数</th></tr></thead><tbody>
    ${LASER_LAYERS.map((l) => `<tr><td><i style="background:${l.swatch}"></i>${l.name}<em>${l.hint}</em></td><td>${l.color}</td>
      <td><input type="number" min="0.1" step="1" data-l="${l.key}.speed" value="${L[l.key].speed}"></td>
      <td><input type="number" min="1" max="100" step="1" data-l="${l.key}.power" value="${L[l.key].power}"></td>
      <td><input type="number" min="1" max="20" step="1" data-l="${l.key}.passes" value="${L[l.key].passes}"></td></tr>`).join('')}
    </tbody></table>
    <p class="muted">参考值按 40～60W CO₂ 激光机估计，不同机器差别很大：第一次请先在边角料上试切，再微调。红色是标注，不要加工。</p>
    <div class="app-modal-actions"><button data-m="close">取消</button><button data-m="ok" class="primary">保存</button></div></div>`;
  m.classList.remove('hidden');
  const fill = (name) => {
    const p = LASER_PRESETS[name];
    LASER_LAYERS.forEach((l) => ['speed', 'power', 'passes'].forEach((f, i) => { m.querySelector(`[data-l="${l.key}.${f}"]`).value = p[l.key][i]; }));
    m.querySelectorAll('[data-preset]').forEach((b) => b.classList.toggle('on', b.dataset.preset === name));
    m.dataset.preset = name;
  };
  m.querySelectorAll('[data-preset]').forEach((b) => b.addEventListener('click', () => fill(b.dataset.preset)));
  m.querySelector('[data-m=close]').addEventListener('click', () => m.classList.add('hidden'));
  m.querySelector('[data-m=ok]').addEventListener('click', () => {
    const next = { preset: m.dataset.preset || L.preset };
    LASER_LAYERS.forEach((l) => {
      next[l.key] = {};
      ['speed', 'power', 'passes'].forEach((f) => { next[l.key][f] = Number(m.querySelector(`[data-l="${l.key}.${f}"]`).value) || 0; });
    });
    state.laser = next;
    saveLaser();
    m.classList.add('hidden');
    toast('加工参数已保存，保存图纸时会一起写出说明', 'success');
  });
}

// 导出图纸前选尺寸：已补偿（文件里外轮廓外扩、内孔内缩 burn）还是原尺寸（补偿交给激光软件）。返回 'comp' / 'nominal' / null（取消）
// 返回 { mode: 'comp' | 'nominal', dims: bool } 或 null（取消）。burn = 0 时没有尺寸选项，只问要不要导出标注（有标注时才弹）
function askBurnMode(burn, hasDims) {
  let last = 'comp';
  try { last = localStorage.getItem('seedlaser.exportBurn') || 'comp'; } catch (e) { /* 只在这次有效 */ }
  if (!(burn > 0) && !hasDims) return Promise.resolve({ mode: 'comp', dims: false });
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'sk-confirm';
    const b = fmtNum(burn);
    const burnHtml = burn > 0 ? `<p><b>导出图纸：尺寸怎么处理？</b><br>现在的激光补偿是 ${b} mm。</p>
      <button data-r="comp" class="opt ${last === 'comp' ? 'on' : ''}"><b>已补偿</b><span>外轮廓每边外扩 ${b} mm、内孔每边内缩 ${b} mm（100 mm 的板在文件里是 ${fmtNum(100 + 2 * burn)} mm）。激光软件里<em>不要</em>再开补偿，切出来正好 100 mm。</span></button>
      <button data-r="nominal" class="opt ${last === 'nominal' ? 'on' : ''}"><b>原尺寸</b><span>文件里就是画的尺寸（100.00 mm）。在 LaserMaker / LightBurn 里设补偿（偏移）${b} mm。</span></button>` : '<p><b>导出图纸</b></p>';
    const dimsHtml = hasDims ? `<label class="burn-dims"><input type="checkbox" data-dims> 把尺寸标注一起导出（放在描线层，数字是文字）</label>` : '';
    box.innerHTML = `<div class="burn-ask">${burnHtml}${dimsHtml}
      <div class="row"><button data-r="cancel">取消</button>${burn > 0 ? '' : '<button data-r="comp" class="primary">导出</button>'}</div></div>`;
    document.body.appendChild(box);
    box.addEventListener('click', (ev) => {
      const t = ev.target.closest('[data-r]');
      if (!t) return;
      const dims = !!(box.querySelector('[data-dims]') && box.querySelector('[data-dims]').checked);
      box.remove();
      const r = t.dataset.r === 'cancel' ? null : t.dataset.r;
      if (r && burn > 0) { try { localStorage.setItem('seedlaser.exportBurn', r); } catch (e) { /* 忽略 */ } }
      resolve(r ? { mode: r, dims } : null);
    });
  });
}

function fmtNum(v) { return String(Math.round(Number(v) * 1000) / 1000); }

async function doSave(fmtArg) {
  if (!state.current) return;
  const fmt = typeof fmtArg === 'string' ? fmtArg : $('#format-select').value;
  const params0 = collectParams();
  const burn = Number(params0.burn) || 0;
  let mode = 'comp';
  let withDims = false;
  const project0 = window.SeedWorkshop ? window.SeedWorkshop.getProject() : null;
  const hasDims = !!(project0 && project0.sketches && Object.values(project0.sketches).some((sk) => (sk.items || []).some((it) => it.mode === 'dim')));
  if (['svg', 'svg_Ponoko', 'dxf', 'lbrn2', 'pdf', 'ps', 'plt', 'gcode'].includes(fmt)) {
    const ans = await askBurnMode(burn, hasDims);
    if (!ans) { setStatus('已取消'); return; }
    mode = ans.mode; withDims = ans.dims;
  }
  setStatus('准备保存…');
  $('#btn-save').disabled = true;
  try {
    const params = mode === 'nominal' ? { ...params0, burn: 0 } : params0;
    const project = project0 ? { ...project0, export_dims: withDims } : null;
    const result = await window.pywebview.api.save(state.current, params, fmt, project, state.laser, fileBase(true));
    if (result.cancelled) { setStatus('已取消'); return; }
    if (result.error) { toast(result.error, 'error'); setStatus('保存失败'); return; }
    if (result.path) {
      const extra = result.notes && result.notes.length ? `（注意：${result.notes.join('；')}）` : '';
      const side = result.sidecar ? `，加工参数说明：${result.sidecar.split(/[\\/]/).pop()}` : '';
      const how = burn > 0 ? (mode === 'nominal' ? `（原尺寸：激光软件里要设补偿 ${fmtNum(burn)} mm）` : `（已含激光补偿 ${fmtNum(burn)} mm：激光软件里不要再补偿）`) : '';
      toast(`已保存：${result.path}${how}${side}${extra}`, extra ? 'error' : 'success');
      setStatus('已保存');
    }
  } catch (err) {
    toast('保存失败: ' + err, 'error');
    setStatus('就绪');
  } finally {
    $('#btn-save').disabled = false;
  }
}

// ---- 项目文件（.seedlaser，内容是 JSON；旧版 .seedbox.json 照样能打开）----
// 当前文件：state.projectPath（null = 还没保存过）；state.savedSnap = 上次保存 / 打开时的内容，用来判断有没有改动
function buildProject() {
  const ws = window.SeedWorkshop ? window.SeedWorkshop.getProject() : null;
  return {
    app: 'SeedLaser',
    version: 2,                 // 项目文件版本（backend.PROJECT_VERSION）
    generator: state.current,
    params: collectParams(),
    format: $('#format-select').value,
    laser: state.laser,
    disabled: ws ? ws.disabled : [],
    edits: ws ? ws.edits : {},
    poses: ws ? ws.poses : {},
    sketches: ws ? ws.sketches : {},
    free: ws ? ws.free : null,
  };
}

function projectSnap() {
  if (!state.current) return '';
  const p = buildProject();
  return JSON.stringify([p.generator, p.params, p.disabled, p.edits, p.poses, p.sketches, p.free]);
}

function fileBase(forExport) {
  if (state.projectPath) return state.projectPath.split(/[\\/]/).pop().replace(/\.seedlaser$|\.seedbox\.json$|\.json$/i, '');
  if (forExport) return state.current === 'FreeDesign' ? '我的设计' : state.current;
  return null;
}

function isDirty() {
  if (!state.current) return false;
  if (state.forcedDirty) return true;               // 从标签切回来、之前就有没保存的改动
  if (state.savedSnap == null) return false;
  return projectSnap() !== state.savedSnap;
}

// 新建 / 打开之后，等界面把内容整理好再记下「干净」的状态
function settleSnap() {
  const gen = (state.snapGen = (state.snapGen || 0) + 1);
  state.savedSnap = null;
  setTimeout(() => { if (gen === state.snapGen) { state.savedSnap = projectSnap(); refreshFileLabel(); } }, 1500);
}

function refreshFileLabel() {
  const ws = window.SeedWorkshop;
  if (!ws || !ws.setFileLabel) return;
  const name = fileBase(false) || (state.current === 'FreeDesign' ? '未命名设计' : state.current || '');
  ws.setFileLabel(`${name}${isDirty() ? ' ●' : ''}`);
  renderTabs();
  document.title = `${name}${isDirty() ? ' ●' : ''} — SeedLaser`;
}

async function doSaveProject(asNew) {
  if (!state.current) return false;
  if (window.SeedWorkshop && window.SeedWorkshop.flush) window.SeedWorkshop.flush();
  const project = buildProject();
  const path = asNew === true || typeof asNew !== 'boolean' ? null : state.projectPath;
  try {
    const r = await window.pywebview.api.save_project(project, path || null, fileBase(true));
    if (r.cancelled) return false;
    if (r.error) { toast(r.error, 'error'); return false; }
    state.projectPath = r.path;
    state.forcedDirty = false;
    state.savedSnap = projectSnap();
    refreshFileLabel();
    toast(`已保存：${r.path.split(/[\\/]/).pop()}`, 'success');
    return true;
  } catch (err) {
    toast('保存项目失败: ' + err, 'error');
    return false;
  }
}

// 标题上直接输入名字保存：没保存过 → 存到「文稿/SeedLaser」；保存过 → 原地改名并保存
async function saveNamed(name) {
  if (!state.current) return false;
  if (window.SeedWorkshop && window.SeedWorkshop.flush) window.SeedWorkshop.flush();
  const project = buildProject();
  try {
    const r = await window.pywebview.api.save_project_named(project, name, state.projectPath || null);
    if (r.error) { toast(r.error, 'error'); refreshFileLabel(); return false; }
    state.projectPath = r.path;
    state.forcedDirty = false;
    state.savedSnap = projectSnap();
    refreshFileLabel();
    const where = r.renamed ? '已改名并保存' : '已保存';
    toast(`${where}：${r.path.split(/[\\/]/).pop()}（${r.folder}）`, 'success');
    return true;
  } catch (err) {
    toast('保存失败: ' + err, 'error');
    return false;
  }
}

// 有没保存的改动时先问一下：保存 / 不保存 / 取消（WKWebView 没有 confirm，自己画一个）
function askSaveFirst(what) {
  if (!isDirty()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const box = document.createElement('div');
    box.className = 'sk-confirm';
    box.innerHTML = `<div><p>「${escapeHtml(fileBase(false) || '未命名设计')}」有改动还没保存。<br>${what}之前要先保存吗？</p>
      <div class="row"><button data-r="cancel">取消</button><button data-r="discard">不保存</button><button data-r="save" class="primary">保存</button></div></div>`;
    document.body.appendChild(box);
    box.addEventListener('click', async (ev) => {
      const b = ev.target.closest('[data-r]');
      if (!b) return;
      box.remove();
      if (b.dataset.r === 'cancel') resolve(false);
      else if (b.dataset.r === 'discard') resolve(true);
      else resolve(await doSaveProject(false));
    });
  });
}

// 二维画板「文件 ▾」菜单
async function fileCommand(cmd, arg) {
  if (cmd === 'save') { await doSaveProject(false); return; }
  if (cmd === 'saveas') { await doSaveProject(true); return; }
  if (cmd === 'export') { await doSave(arg); return; }
  if (cmd === 'rename') { await saveNamed(arg); return; }
  if (cmd === 'new') { await newTab(); return; }                     // 多开：新建 = 新标签，当前项目留着
  if (cmd === 'open' || cmd === 'openPath') { await doOpenProject(cmd === 'openPath' ? arg : undefined); return; }
  if (cmd === 'close') { if (tabs.active) await closeTab(tabs.active); return; }
  if (cmd === 'home') { goHome(); }
}

// 打开项目文件（对话框或路径）→ 在标签里打开：已经开着就切过去，当前是空白设计就复用，否则开新标签
async function doOpenProject(path) {
  let r;
  try {
    r = typeof path === 'string' ? await window.pywebview.api.open_project_path(path) : await window.pywebview.api.open_project();
  } catch (err) {
    toast('打开项目失败: ' + err, 'error');
    return;
  }
  if (!r || r.cancelled) return;
  if (r.error) { toast(r.error, 'error'); if (state.view === 'home') renderRecent(); return; }
  if (r.warning) toast(r.warning, 'info');
  const same = r.path && tabs.list.find((t) => t.path && samePath(t.path, r.path));
  if (same) { await activateTab(same.id); toast(`「${tabTitle(same)}」已经开着，切换过去了`, 'info'); return; }
  const cur = activeTab();
  if (cur && !state.projectPath && !isDirty() && !state.forcedDirty) {        // 空白新设计：直接用这个标签
    await loadProjectData(r.project, r.path);
  } else {
    parkActive();
    const t = { id: `t${++tabs.seq}`, path: r.path, data: null, dirty: false };
    tabs.list.push(t);
    tabs.active = t.id;
    await loadProjectData(r.project, r.path);
  }
  toast(`已打开：${fileBase(false) || '项目'}`, 'success');
  renderTabs();
}

// 把项目数据载入到当前界面（打开文件、切换标签共用）
async function loadProjectData(p, path, opts = {}) {
  tabs.loading = true;
  try {
    if (p.generator === 'FreeDesign' && window.SeedWorkshop) window.SeedWorkshop.wantSheet();   // 设计项目：直接进二维画板
    await selectGenerator(p.generator);
    state.projectPath = path || null;
    const form = $('#param-form');
    Object.entries(p.params || {}).forEach(([k, v]) => {
      const el = form.querySelector(`[name="${CSS.escape(k)}"]`);
      if (!el) return;
      if (el.type === 'checkbox') el.checked = String(v) === '1' || v === true || String(v).toLowerCase() === 'true';
      else el.value = v;
    });
    if (p.laser && p.laser.cut) { state.laser = p.laser; saveLaser(); }
    if (p.format) {
      const opt = $('#format-select').querySelector(`option[value="${CSS.escape(p.format)}"]`);
      if (opt) $('#format-select').value = p.format;
    }
    if (window.SeedWorkshop) window.SeedWorkshop.setProject({ disabled: p.disabled, edits: p.edits, poses: p.poses, sketches: p.sketches, free: p.free });
    state.forcedDirty = !!opts.dirty;
    doPreview();
    settleSnap();
  } finally {
    tabs.loading = false;
  }
}

// 去模型库时用：标签记下文件和改动状态，但设计内容由 workshop 的 freeStash 带着（为了「放进当前设计」）
function parkActiveKeepStash() {
  const t = activeTab();
  if (!t) return;
  if (window.SeedWorkshop) window.SeedWorkshop.flush();
  t.data = state.current ? buildProject() : null;
  t.path = state.projectPath;
  t.dirty = isDirty() || !!state.forcedDirty;
  t.title = tabTitle(t);
  tabs.lastActive = t.id;
  tabs.active = null;
  renderTabs();
}

// ---- 多开项目：顶部标签栏（参考 Fusion）----
// 当前标签的内容就是界面上的内容；其他标签把项目数据（buildProject）暂存在 t.data 里，切回来时再载入
const tabs = { list: [], active: null, seq: 0, loading: false, returnTo: null };
const activeTab = () => tabs.list.find((t) => t.id === tabs.active) || null;
const samePath = (a, b) => String(a).replace(/\\/g, '/').toLowerCase() === String(b).replace(/\\/g, '/').toLowerCase();

function tabTitle(t) {
  if (t.id === tabs.active) return fileBase(false) || (state.current && state.current !== 'FreeDesign' ? state.current : '未命名设计');
  return t.title || '未命名设计';
}

function tabDirty(t) {
  return t.id === tabs.active ? (isDirty() || !!state.forcedDirty) : !!t.dirty;
}

// 当前标签 → 暂存（数据、文件、是否有改动），关掉画板。之后 tabs.active = null（调用方再决定去哪）
function parkActive() {
  const t = activeTab();
  if (!t) return;
  if (window.SeedWorkshop) window.SeedWorkshop.flush();
  t.data = state.current ? buildProject() : null;
  t.path = state.projectPath;
  t.dirty = isDirty() || !!state.forcedDirty;
  t.title = tabTitle(t);
  if (window.SeedWorkshop && window.SeedWorkshop.park) window.SeedWorkshop.park();
  tabs.lastActive = t.id;
  tabs.active = null;
}

async function activateTab(id) {
  if (tabs.active === id && state.view !== 'home') return;
  const t = tabs.list.find((q) => q.id === id);
  if (!t) return;
  if (tabs.active !== id) parkActive();
  tabs.active = id;
  if (t.data) await loadProjectData(t.data, t.path, { dirty: t.dirty });
  else await startBlankDesign();
  t.data = null;
  renderTabs();
}

async function startBlankDesign() {
  tabs.loading = true;
  try {
    state.projectPath = null;
    state.forcedDirty = false;
    if (window.SeedWorkshop) window.SeedWorkshop.wantSheet();
    await selectGenerator('FreeDesign');
    settleSnap();
  } finally {
    tabs.loading = false;
  }
}

async function newTab() {
  parkActive();
  const t = { id: `t${++tabs.seq}`, path: null, data: null, dirty: false };
  tabs.list.push(t);
  tabs.active = t.id;
  await startBlankDesign();
  renderTabs();
}

async function closeTab(id) {
  const t = tabs.list.find((q) => q.id === id);
  if (!t) return;
  if (tabDirty(t)) {
    if (tabs.active !== id) await activateTab(id);           // 先切过去，再问要不要保存
    if (!(await askSaveFirst('关闭'))) return;
  }
  const i = tabs.list.indexOf(t);
  const wasActive = tabs.active === id;
  if (wasActive && window.SeedWorkshop && window.SeedWorkshop.park) window.SeedWorkshop.park();
  tabs.list.splice(i, 1);
  if (wasActive) {
    tabs.active = null;
    const next = tabs.list[i] || tabs.list[i - 1];
    if (next) await activateTab(next.id); else goHome();
  }
  renderTabs();
}

function goHome() {
  parkActive();
  showView('home');
  renderTabs();
}

function renderTabs() {
  const bar = $('#doc-tabs');
  if (!bar || tabs.renaming) return;                 // 正在标签上改名：不重画（会把输入框冲掉）
  const esc = escapeHtml;
  const home = state.view === 'home' || !tabs.active;
  bar.innerHTML = `<button class="dt-home${home ? ' on' : ''}" data-dt="home" title="主页">⌂</button>
    <div class="dt-list">${tabs.list.map((t) => {
      const on = t.id === tabs.active && !home;
      const dirty = tabDirty(t);
      return `<div class="dt-tab${on ? ' on' : ''}" data-tab="${t.id}" title="${esc(t.path || tabTitle(t))}">
        <span class="dt-ico">◆</span><span class="dt-name" title="${on ? '点一下改名并保存' : '双击改名'}">${esc(tabTitle(t))}</span>${dirty ? '<i class="dt-dot" title="有改动还没保存"></i>' : ''}
        <button class="dt-x" data-close="${t.id}" title="关闭">×</button></div>`;
    }).join('')}</div>
    <button class="dt-new" data-dt="new" title="新建设计（新标签）">＋</button>`;
}

// 在标签上直接改项目名称：回车 / 点别处 = 保存（没保存过的存到「文稿/SeedLaser」，保存过的原地改名）；Esc 取消
function startTabRename(id) {
  if (tabs.renaming || id !== tabs.active) return;
  const el = $(`#doc-tabs [data-tab="${id}"] .dt-name`);
  if (!el) return;
  const t = activeTab();
  const cur = tabTitle(t);
  const blank = !state.projectPath;
  tabs.renaming = true;
  const inp = document.createElement('input');
  inp.className = 'dt-input';
  inp.value = blank && cur === '未命名设计' ? '' : cur;
  inp.placeholder = '输入项目名称，回车保存';
  inp.maxLength = 80;
  el.replaceWith(inp);
  inp.focus(); inp.select();
  let done = false;
  const finish = async (save) => {
    if (done) return;
    done = true;
    tabs.renaming = false;
    const name = inp.value.trim();
    renderTabs();
    if (!save || !name) return;
    if (name !== cur || blank) await saveNamed(name);
    else await doSaveProject(false);
  };
  inp.addEventListener('keydown', (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Enter') finish(true);
    else if (ev.key === 'Escape') finish(false);
  });
  inp.addEventListener('blur', () => finish(true));
  inp.addEventListener('click', (ev) => ev.stopPropagation());
  inp.addEventListener('dblclick', (ev) => ev.stopPropagation());
}

function bindTabs() {
  const bar = $('#doc-tabs');
  bar.addEventListener('click', async (ev) => {
    const x = ev.target.closest('[data-close]');
    if (x) { ev.stopPropagation(); await closeTab(x.dataset.close); return; }
    const b = ev.target.closest('[data-dt]');
    if (b && b.dataset.dt === 'home') { goHome(); return; }
    if (b && b.dataset.dt === 'new') { await newTab(); return; }
    const t = ev.target.closest('[data-tab]');
    if (!t) return;
    // 点当前标签的名字 = 改名
    if (t.dataset.tab === tabs.active && state.view !== 'home' && ev.target.closest('.dt-name')) { startTabRename(t.dataset.tab); return; }
    await activateTab(t.dataset.tab);
  });
  bar.addEventListener('dblclick', async (ev) => {          // 双击任意标签 = 切过去并改名
    const t = ev.target.closest('[data-tab]');
    if (!t || ev.target.closest('[data-close]')) return;
    if (t.dataset.tab !== tabs.active || state.view === 'home') await activateTab(t.dataset.tab);
    startTabRename(t.dataset.tab);
  });
  bar.addEventListener('auxclick', (ev) => { const t = ev.target.closest('[data-tab]'); if (t && ev.button === 1) closeTab(t.dataset.tab); });  // 中键关闭
  renderTabs();
}

// ---- 主页：最近项目、示例 ----
async function renderRecent() {
  const box = $('#home-recent');
  let list = [];
  try { list = await window.pywebview.api.recent_projects(); } catch (e) { list = []; }
  if (!Array.isArray(list) || !list.length) {
    box.innerHTML = '<div class="muted">还没有项目。保存过或打开过的项目会出现在这里。</div>';
    return;
  }
  const when = (t) => { const d = new Date(t * 1000); return `${d.getMonth() + 1}月${d.getDate()}日 ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  box.innerHTML = list.slice(0, 8).map((r, i) => `<button class="recent-item${r.exists ? '' : ' gone'}" data-i="${i}" title="${escapeHtml(r.path)}">
      <b>${escapeHtml(r.name)}</b>
      <em>${r.generator === 'FreeDesign' ? `设计${r.parts != null ? ` · ${r.parts} 块板` : ''}` : `快速建模 · ${escapeHtml(r.generator || '')}`}${r.exists ? '' : ' · 文件不在了'}</em>
      <span>${when(r.time || 0)}</span></button>`).join('');
  box.querySelectorAll('.recent-item').forEach((b) => b.addEventListener('click', () => doOpenProject(list[Number(b.dataset.i)].path)));
}

async function startExample(ex) {
  if (ex === 'box') { await selectGenerator('ABox'); return; }
  if (window.SeedWorkshop) window.SeedWorkshop.startWith(ex);     // 新设计 → 打开对应对话框
  await selectGenerator('FreeDesign');
}

// ---- 事件 ----
function bindEvents() {
  bindTabs();
  $('#btn-preview').addEventListener('click', doPreview);
  $('#btn-laser').addEventListener('click', openLaserDialog);
  $('#free-entry').addEventListener('click', () => newTab());
  $('#btn-save').addEventListener('click', doSave);
  $('#btn-save-project').addEventListener('click', doSaveProject);
  $('#btn-open-project').addEventListener('click', doOpenProject);
  const onParam = () => { if (window.SeedWorkshop) window.SeedWorkshop.paramsChanged(); };
  $('#param-form').addEventListener('input', onParam);
  $('#param-form').addEventListener('change', onParam);
  $('#search').addEventListener('input', (e) => renderSidebar(e.target.value));
  $('#btn-zoom-in').addEventListener('click', () => { state.zoom = Math.min(8, state.zoom * 1.25); applyZoom(); });
  $('#btn-zoom-out').addEventListener('click', () => { state.zoom = Math.max(0.1, state.zoom / 1.25); applyZoom(); });
  $('#btn-zoom-reset').addEventListener('click', () => { state.zoom = 1.0; applyZoom(); });
  $('#browse-back').addEventListener('click', () => showView('welcome'));
  $('#editor-back-home').addEventListener('click', () => showView(state.current === 'FreeDesign' ? 'home' : 'welcome'));
  $('#home-quick').addEventListener('click', () => showView('welcome'));
  $('#home-open').addEventListener('click', doOpenProject);
  document.querySelectorAll('[data-go-home]').forEach((b) => b.addEventListener('click', () => showView('home')));
  document.querySelectorAll('#home [data-ex]').forEach((b) => b.addEventListener('click', () => startExample(b.dataset.ex)));
  $('#btn-to-design').addEventListener('click', () => {
    if (!window.SeedWorkshop) return;
    const target = tabs.list.find((t) => t.id === tabs.lastActive);
    window.SeedWorkshop.setStash(target ? target.data : null);
    tabs.returnTo = target ? target.id : null;
    window.SeedWorkshop.importToDesign();
  });
  $('#btn-to-new').addEventListener('click', () => {
    if (!window.SeedWorkshop) return;
    window.SeedWorkshop.setStash(null);
    tabs.returnTo = null;
    window.SeedWorkshop.importToDesign();
  });
  $('#editor-back-group').addEventListener('click', () => {
    const g = state.byName.get(state.current);
    if (g) browseGroup(g.name); else showView('welcome');
  });
}

// 供 workshop.js（ES 模块）调用
window.toast = toast;
window.SeedApp = {
  collectParams,
  doPreview,
  hasPreview: () => !!state.hasPreview,
  select: (name) => selectGenerator(name),
  file: (cmd, arg) => fileCommand(cmd, arg),
  recent: () => window.pywebview.api.recent_projects(),
  formats: () => [...$('#format-select').options].map((o) => ({ value: o.value, label: o.textContent })),
  isDirty,
  changed: () => setTimeout(refreshFileLabel, 50),      // 画板有改动：马上刷新标题上的 ●
};
setInterval(refreshFileLabel, 3000);
window.addEventListener('beforeunload', (ev) => { if (tabs.list.some(tabDirty)) { ev.preventDefault(); ev.returnValue = ''; } });

// ---- 启动 ----
(async () => {
  bindEvents();
  await whenApiReady();
  showView('home');
  await Promise.all([loadFormats(), loadGroups()]);
  // 双击 .seedlaser 文件启动：直接打开它
  try {
    const lf = await window.pywebview.api.launch_file();
    if (lf && lf.path) await doOpenProject(lf.path);
  } catch (e) { /* 没有就算了 */ }
})();
