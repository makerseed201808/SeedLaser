// 模数齿轮（C5）：SketchEditor.gearPoints 的渐开线齿廓。运行：node tests/js/gear.test.mjs
// 核对 ISO 53：齿顶圆 = m(z+2)、齿根圆 = m(z−2.5)、分度圆上的齿厚 = πm/2、每个齿两侧对称、齿数 = z
import fs from 'node:fs';
import assert from 'node:assert/strict';

const src = fs.readFileSync(new URL('../../web/sketch2d.js', import.meta.url), 'utf8');
const i = src.indexOf('  static gearPoints(');
let k = src.indexOf('{', i), depth = 0;
for (;; k++) { if (src[k] === '{') depth++; else if (src[k] === '}' && --depth === 0) break; }
const body = src.slice(src.indexOf('{', i), k + 1);
const gearPoints = new Function('m', 'z', 'rot', `rot = rot || 0; ${body.slice(1, -1)}`);

for (const [m, z] of [[2, 20], [2, 12], [1.5, 40], [3, 9]]) {
  const g = gearPoints(m, z, 0);
  const R = g.pts.map(([x, y]) => Math.hypot(x, y));
  assert.ok(Math.abs(Math.max(...R) - m * (z + 2) / 2) < 1e-9, `齿顶圆 m=${m} z=${z}`);
  assert.ok(Math.abs(Math.min(...R) - m * (z - 2.5) / 2) < 1e-9, `齿根圆 m=${m} z=${z}`);
  assert.ok(Math.abs(g.r * 2 - m * z) < 1e-9, '分度圆 = m·z');
  // 分度圆上的齿厚：第一个齿（中心角 0）两侧齿廓和分度圆的交点
  const per = g.pts.length / z;
  const tooth = g.pts.slice(0, per);
  const cross = [];
  for (let j = 0; j + 1 < tooth.length; j++) {
    const [a, b] = [tooth[j], tooth[j + 1]];
    const ra = Math.hypot(...a), rb = Math.hypot(...b);
    if ((ra - g.r) * (rb - g.r) <= 0 && ra !== rb) {
      const t = (g.r - ra) / (rb - ra);
      cross.push(Math.atan2(a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t));
    }
  }
  assert.equal(cross.length, 2, `第一个齿和分度圆有两个交点（m=${m} z=${z}）`);
  const s = Math.abs(cross[1] - cross[0]) * g.r;            // 弧长
  assert.ok(Math.abs(s - Math.PI * m / 2) < 0.02 * m, `分度圆齿厚 ${s} ≈ πm/2（m=${m} z=${z}）`);
  assert.ok(Math.abs(cross[0] + cross[1]) < 1e-9, '齿两侧对称');
  // 齿数：齿顶点成簇
  let tips = 0, on = false;
  R.forEach((r) => { const at = Math.abs(r - m * (z + 2) / 2) < 1e-9; if (at && !on) tips++; on = at; });
  assert.equal(tips, z, '齿数');
}
console.log('PASS gear.test：齿顶圆 / 齿根圆 / 分度圆 / 分度圆齿厚 πm/2 / 对称 / 齿数（4 组模数和齿数）');
