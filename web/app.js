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
  view: 'welcome',
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
  const myReq = ++state.reqId;
  state.current = name;
  state.hasPreview = false;
  if (window.SeedWorkshop) window.SeedWorkshop.reset(name);
  $$('#group-list .gen-item').forEach((el) => {
    el.classList.toggle('active', el.dataset.name === name);
  });
  $('#gen-name').textContent = name === 'FreeDesign' ? '自由设计' : name;
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
  { key: 'cut', name: '切割', color: '黑色 / 蓝色', swatch: '#1f6feb', hint: '外轮廓（黑）和内孔（蓝）' },
  { key: 'engrave', name: '雕刻', color: '绿色', swatch: '#16a34a', hint: '填充雕刻' },
  { key: 'score', name: '描线', color: '品红', swatch: '#c026d3', hint: '沿线浅刻' },
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

async function doSave() {
  if (!state.current) return;
  const fmt = $('#format-select').value;
  setStatus('准备保存…');
  $('#btn-save').disabled = true;
  try {
    const params = collectParams();
    const project = window.SeedWorkshop ? window.SeedWorkshop.getProject() : null;
    const result = await window.pywebview.api.save(state.current, params, fmt, project, state.laser);
    if (result.cancelled) { setStatus('已取消'); return; }
    if (result.error) { toast(result.error, 'error'); setStatus('保存失败'); return; }
    if (result.path) {
      const extra = result.notes && result.notes.length ? `（注意：${result.notes.join('；')}）` : '';
      const side = result.sidecar ? `，加工参数说明：${result.sidecar.split(/[\\/]/).pop()}` : '';
      toast(`已保存：${result.path}${side}${extra}`, extra ? 'error' : 'success');
      setStatus('已保存');
    }
  } catch (err) {
    toast('保存失败: ' + err, 'error');
    setStatus('就绪');
  } finally {
    $('#btn-save').disabled = false;
  }
}

// ---- 项目文件（.seedbox.json）----
async function doSaveProject() {
  if (!state.current) return;
  const ws = window.SeedWorkshop ? window.SeedWorkshop.getProject() : null;
  const project = {
    app: 'SeedBoxes',
    version: 1,
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
  try {
    const r = await window.pywebview.api.save_project(project);
    if (r.cancelled) return;
    if (r.error) { toast(r.error, 'error'); return; }
    toast(`项目已保存：${r.path}`, 'success');
  } catch (err) {
    toast('保存项目失败: ' + err, 'error');
  }
}

async function doOpenProject() {
  let r;
  try {
    r = await window.pywebview.api.open_project();
  } catch (err) {
    toast('打开项目失败: ' + err, 'error');
    return;
  }
  if (!r || r.cancelled) return;
  if (r.error) { toast(r.error, 'error'); return; }
  const p = r.project;
  await selectGenerator(p.generator);
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
  toast('项目已载入', 'success');
  doPreview();
}

// ---- 事件 ----
function bindEvents() {
  $('#btn-preview').addEventListener('click', doPreview);
  $('#btn-laser').addEventListener('click', openLaserDialog);
  $('#free-entry').addEventListener('click', () => { if (window.SeedWorkshop) window.SeedWorkshop.wantSheet(); selectGenerator('FreeDesign'); });
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
  $('#editor-back-home').addEventListener('click', () => showView('welcome'));
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
};

// ---- 启动 ----
(async () => {
  bindEvents();
  await whenApiReady();
  await Promise.all([loadFormats(), loadGroups()]);
})();
