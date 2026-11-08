// 二维草图的导入：DXF 解析、图片二值化（描摹的前半步，后半步在后端 sketch2d.trace_rects）。
// 坐标统一为 mm、y 向上。

// ------------------------------------------------------------------ DXF

const UNIT_MM = { 1: 25.4, 2: 304.8, 4: 1, 5: 10, 6: 1000, 0: 1 };

function bulgeArc(p1, p2, bulge, out) {
  // p1 → p2 之间的圆弧（bulge = tan(圆心角 / 4)，正数逆时针）
  const theta = 4 * Math.atan(bulge);
  const dx = p2[0] - p1[0]; const dy = p2[1] - p1[1];
  const chord = Math.hypot(dx, dy);
  if (chord < 1e-9 || Math.abs(theta) < 1e-9) { out.push(p2); return; }
  const d = (chord / 2) / Math.tan(theta / 2);           // 圆心到弦中点（带符号）
  const cx = (p1[0] + p2[0]) / 2 - dy / chord * d;
  const cy = (p1[1] + p2[1]) / 2 + dx / chord * d;
  const R = Math.hypot(p1[0] - cx, p1[1] - cy);
  const a0 = Math.atan2(p1[1] - cy, p1[0] - cx);
  const n = Math.max(4, Math.ceil(Math.abs(theta) / (Math.PI / 24)));
  for (let i = 1; i < n; i++) {
    const a = a0 + theta * i / n;
    out.push([cx + R * Math.cos(a), cy + R * Math.sin(a)]);
  }
  out.push(p2);
}

function arcPts(cx, cy, r, a0deg, a1deg) {
  let a0 = a0deg * Math.PI / 180;
  let a1 = a1deg * Math.PI / 180;
  while (a1 <= a0) a1 += Math.PI * 2;
  const n = Math.max(6, Math.ceil((a1 - a0) / (Math.PI / 36)));
  const out = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (a1 - a0) * i / n;
    out.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  return out;
}

function deBoor(ctrl, knots, degree, samples) {
  const n = ctrl.length;
  if (!knots || knots.length !== n + degree + 1) return ctrl.slice();
  const lo = knots[degree]; const hi = knots[n];
  const out = [];
  for (let s = 0; s <= samples; s++) {
    let t = lo + (hi - lo) * s / samples;
    if (s === samples) t = hi - 1e-9;
    let k = degree;
    while (k < n - 1 && t >= knots[k + 1]) k++;
    const d = [];
    for (let j = 0; j <= degree; j++) d.push(ctrl[k - degree + j].slice());
    for (let r = 1; r <= degree; r++) {
      for (let j = degree; j >= r; j--) {
        const i = k - degree + j;
        const den = knots[i + degree - r + 1] - knots[i];
        const a = den ? (t - knots[i]) / den : 0;
        d[j] = [(1 - a) * d[j - 1][0] + a * d[j][0], (1 - a) * d[j - 1][1] + a * d[j][1]];
      }
    }
    out.push(d[degree]);
  }
  return out;
}

/** DXF 文本 → { paths: [{ closed, pts: [[x, y]] }], unit }（单位换算成 mm） */
export function parseDXF(text) {
  const lines = text.split(/\r?\n/);
  const pairs = [];
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([parseInt(lines[i].trim(), 10), lines[i + 1].trim()]);
  let unit = 1;
  for (let i = 0; i < pairs.length; i++) {
    if (pairs[i][0] === 9 && pairs[i][1] === '$INSUNITS') {
      const v = pairs[i + 1] && parseInt(pairs[i + 1][1], 10);
      if (UNIT_MM[v]) unit = UNIT_MM[v];
    }
  }
  let i = pairs.findIndex(([c, v]) => c === 2 && v === 'ENTITIES');
  if (i < 0) i = 0;
  const paths = [];
  let poly = null;   // 旧式 POLYLINE
  const readEntity = () => {
    const type = pairs[i][1];
    const ent = { type, codes: [] };
    i++;
    while (i < pairs.length && pairs[i][0] !== 0) { ent.codes.push(pairs[i]); i++; }
    return ent;
  };
  const num = (ent, code, def = 0) => { const f = ent.codes.find((c) => c[0] === code); return f ? parseFloat(f[1]) : def; };
  const all = (ent, code) => ent.codes.filter((c) => c[0] === code).map((c) => parseFloat(c[1]));
  while (i < pairs.length) {
    if (pairs[i][0] !== 0) { i++; continue; }
    const t = pairs[i][1];
    if (t === 'ENDSEC' || t === 'EOF') break;
    const e = readEntity();
    if (e.type === 'LINE') {
      paths.push({ closed: false, pts: [[num(e, 10), num(e, 20)], [num(e, 11), num(e, 21)]] });
    } else if (e.type === 'CIRCLE') {
      const pts = arcPts(num(e, 10), num(e, 20), num(e, 40), 0, 360);
      pts.pop();
      paths.push({ closed: true, pts });
    } else if (e.type === 'ARC') {
      paths.push({ closed: false, pts: arcPts(num(e, 10), num(e, 20), num(e, 40), num(e, 50), num(e, 51)) });
    } else if (e.type === 'ELLIPSE') {
      const cx = num(e, 10); const cy = num(e, 20);
      const mx = num(e, 11); const my = num(e, 21);
      const ratio = num(e, 40, 1);
      let t0 = num(e, 41, 0); let t1 = num(e, 42, Math.PI * 2);
      while (t1 <= t0) t1 += Math.PI * 2;
      const a = Math.hypot(mx, my); const ang = Math.atan2(my, mx);
      const n = Math.max(12, Math.ceil((t1 - t0) / (Math.PI / 36)));
      const pts = [];
      for (let k = 0; k <= n; k++) {
        const tt = t0 + (t1 - t0) * k / n;
        const x = a * Math.cos(tt); const y = a * ratio * Math.sin(tt);
        pts.push([cx + x * Math.cos(ang) - y * Math.sin(ang), cy + x * Math.sin(ang) + y * Math.cos(ang)]);
      }
      const full = Math.abs(t1 - t0 - Math.PI * 2) < 1e-6;
      if (full) pts.pop();
      paths.push({ closed: full, pts });
    } else if (e.type === 'LWPOLYLINE') {
      const closed = (num(e, 70) & 1) === 1;
      const verts = [];
      let cur = null;
      e.codes.forEach(([c, v]) => {
        if (c === 10) { cur = { x: parseFloat(v), y: 0, b: 0 }; verts.push(cur); } else if (c === 20 && cur) cur.y = parseFloat(v);
        else if (c === 42 && cur) cur.b = parseFloat(v);
      });
      const pts = [];
      verts.forEach((vv, k) => {
        const p = [vv.x, vv.y];
        if (!k) pts.push(p);
        const nx = verts[k + 1] || (closed ? verts[0] : null);
        if (nx) { if (vv.b) bulgeArc(p, [nx.x, nx.y], vv.b, pts); else pts.push([nx.x, nx.y]); }
      });
      if (closed && pts.length > 1) pts.pop();
      paths.push({ closed, pts });
    } else if (e.type === 'POLYLINE') {
      poly = { closed: (num(e, 70) & 1) === 1, verts: [] };
    } else if (e.type === 'VERTEX' && poly) {
      poly.verts.push({ x: num(e, 10), y: num(e, 20), b: num(e, 42) });
    } else if (e.type === 'SEQEND' && poly) {
      const pts = [];
      poly.verts.forEach((vv, k) => {
        const p = [vv.x, vv.y];
        if (!k) pts.push(p);
        const nx = poly.verts[k + 1] || (poly.closed ? poly.verts[0] : null);
        if (nx) { if (vv.b) bulgeArc(p, [nx.x, nx.y], vv.b, pts); else pts.push([nx.x, nx.y]); }
      });
      if (poly.closed && pts.length > 1) pts.pop();
      paths.push({ closed: poly.closed, pts });
      poly = null;
    } else if (e.type === 'SPLINE') {
      const degree = num(e, 71, 3);
      const closed = (num(e, 70) & 1) === 1;
      const knots = all(e, 40);
      const cx = all(e, 10); const cy = all(e, 20);
      const fx = all(e, 11); const fy = all(e, 21);
      let pts;
      if (cx.length > degree) pts = deBoor(cx.map((x, k) => [x, cy[k]]), knots, degree, Math.max(24, cx.length * 8));
      else pts = fx.map((x, k) => [x, fy[k]]);
      if (pts.length >= 2) paths.push({ closed, pts });
    }
  }
  paths.forEach((p) => { p.pts = p.pts.map(([x, y]) => [x * unit, y * unit]); });
  return { paths: paths.filter((p) => p.pts.length >= 2), unit };
}

// ------------------------------------------------------------------ 图片二值化

export function loadImage(dataUrl) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('图片无法读取'));
    img.src = dataUrl;
  });
}

/** 图片 → 灰度数组（最长边不超过 maxPx），透明当白色 */
export function grayOf(img, maxPx = 500) {
  const k = Math.min(1, maxPx / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.max(1, Math.round(img.naturalWidth * k));
  const h = Math.max(1, Math.round(img.naturalHeight * k));
  const cv = document.createElement('canvas');
  cv.width = w; cv.height = h;
  const g = cv.getContext('2d');
  g.fillStyle = '#fff';
  g.fillRect(0, 0, w, h);
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h).data;
  const gray = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) gray[i] = Math.round(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
  return { gray, w, h };
}

export function otsu(gray) {
  const hist = new Float64Array(256);
  gray.forEach((v) => { hist[v]++; });
  const total = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0; let wB = 0; let best = 0; let thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB; const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > best) { best = between; thr = t; }
  }
  return thr;
}

/** 灰度 → 黑白预览（画到 canvas）+ 深色像素矩形（行段竖直合并） */
export function binarize({ gray, w, h }, thr, invert, canvas) {
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = (invert ? gray[i] > thr : gray[i] <= thr) ? 1 : 0;
  if (canvas) {
    canvas.width = w; canvas.height = h;
    const g = canvas.getContext('2d');
    const im = g.createImageData(w, h);
    for (let i = 0; i < w * h; i++) {
      const v = mask[i] ? 30 : 255;
      im.data[i * 4] = v; im.data[i * 4 + 1] = v; im.data[i * 4 + 2] = v; im.data[i * 4 + 3] = 255;
    }
    g.putImageData(im, 0, 0);
  }
  const rects = [];
  let open = new Map();
  for (let y = 0; y <= h; y++) {
    const runs = new Set();
    if (y < h) {
      let x = 0;
      while (x < w) {
        if (mask[y * w + x]) {
          const s = x;
          while (x < w && mask[y * w + x]) x++;
          runs.add(s + ',' + x);
        } else x++;
      }
    }
    const next = new Map();
    open.forEach((y0, key) => {
      if (runs.has(key)) next.set(key, y0);
      else { const [a, b] = key.split(',').map(Number); rects.push([a, y0, b, y]); }
    });
    runs.forEach((key) => { if (!next.has(key)) next.set(key, y); });
    open = next;
  }
  return rects;
}

export function readFile(file, asText) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('文件读取失败'));
    if (asText) r.readAsText(file); else r.readAsDataURL(file);
  });
}

/** 描摹前的调节（C10）：裁剪（各边裁掉的百分比）→ 亮度（−100 ~ 100）→ 对比度（−100 ~ 100）。返回新的 { gray, w, h }。
 *  对比度用常见的 259 公式：f = 259 (c + 255) / (255 (259 − c))，c = 对比度 × 2.55；新值 = f (v − 128) + 128 + 亮度 × 2.55 */
export function adjustGray({ gray, w, h }, { bright = 0, contrast = 0, crop = [0, 0, 0, 0] } = {}) {
  const [cl, ct, cr, cb] = crop.map((v) => Math.max(0, Math.min(95, Number(v) || 0)) / 100);
  const x0 = Math.min(w - 1, Math.round(w * cl)), x1 = Math.max(x0 + 1, Math.round(w * (1 - cr)));
  const y0 = Math.min(h - 1, Math.round(h * ct)), y1 = Math.max(y0 + 1, Math.round(h * (1 - cb)));
  const W = x1 - x0, H = y1 - y0;
  const c = Math.max(-254, Math.min(254, (Number(contrast) || 0) * 2.55));
  const f = (259 * (c + 255)) / (255 * (259 - c));
  const b = (Number(bright) || 0) * 2.55;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const v = f * (gray[(y + y0) * w + x + x0] - 128) + 128 + b;
      out[y * W + x] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
    }
  }
  return { gray: out, w: W, h: H };
}
