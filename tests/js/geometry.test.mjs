// node tests/js/geometry.test.mjs —— A3 几何边界情况（前端 sketch2d.js 的纯函数，和后端 tests/py/test_geometry.py 对应）
import assert from 'node:assert/strict';
import { flattenPath, splitRing, loopArea, closeNearlyClosed, sketchPolys, curveSteps } from '../../web/sketch2d.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };
const P = (pts, closed = true) => ({ closed, segs: pts.map(([x, y]) => [x, y, 0, 0, 0, 0]) });
const area = (r) => { let a = 0; r.forEach((p, i) => { const q = r[(i + 1) % r.length]; a += p[0] * q[1] - q[0] * p[1]; }); return Math.abs(a / 2); };

t('蝴蝶结拆成两个三角形，面积 2 × 25（和 shapely make_valid 一致）', () => {
  const rings = splitRing([[0, 0], [10, 10], [10, 0], [0, 10]]);
  assert.equal(rings.length, 2);
  rings.forEach((r) => assert.ok(Math.abs(area(r) - 25) < 1e-9));
  assert.ok(Math.abs(loopArea([[0, 0], [10, 10], [10, 0], [0, 10]]) - 50) < 1e-9);
});

t('8 字形孔：3D 用的多边形里板 + 两个孔', () => {
  const sp = sketchPolys({ items: [
    { mode: 'cut', paths: [P([[0, 0], [100, 0], [100, 100], [0, 100]])] },
    { mode: 'cut', paths: [P([[20, 20], [40, 40], [40, 20], [20, 40]])] }] });
  assert.equal(sp.cut.length, 3);
  const holes = sp.cut.filter((r) => area(r) < 1000);
  assert.equal(holes.length, 2);
  assert.ok(Math.abs(holes.reduce((s, r) => s + area(r), 0) - 200) < 1e-9);
});

t('简单环不拆；多处交叉的星形（五角星）拆开后面积合理', () => {
  assert.equal(splitRing([[0, 0], [10, 0], [10, 10], [0, 10]]).length, 1);
  const star = [0, 1, 2, 3, 4].map((k) => { const a = Math.PI / 2 + k * 4 * Math.PI / 5; return [50 * Math.cos(a), 50 * Math.sin(a)]; });
  const rings = splitRing(star);
  assert.ok(rings.length >= 2, rings.length);
  assert.ok(rings.every((r) => r.length >= 3));
});

t('差 0.001 mm 没闭合 → 当成闭合；差 1 mm 不闭合', () => {
  const a = closeNearlyClosed(P([[0, 0], [100, 0], [100, 100], [0, 100], [0.001, 0]], false));
  assert.equal(a.closed, true); assert.equal(a.segs.length, 4);
  const b = closeNearlyClosed(P([[0, 0], [100, 0], [100, 100], [0, 100], [0, 1]], false));
  assert.equal(b.closed, false);
  const sp = sketchPolys({ items: [{ mode: 'cut', paths: [P([[0, 0], [100, 0], [100, 100], [0, 100], [0.001, 0]], false)] }] });
  assert.equal(sp.cut.length, 1); assert.equal(sp.open.length, 0);
});

t('零长度段 / 重合节点、退化路径不出错', () => {
  const sp = sketchPolys({ items: [
    { mode: 'cut', paths: [P([[0, 0], [0, 0], [100, 0], [100, 0], [100, 100], [0, 100], [0, 100]])] },
    { mode: 'cut', paths: [P([[5, 5], [5, 5], [5, 5]])] }] });
  assert.ok(sp.cut.some((r) => Math.abs(area(r) - 10000) < 1e-9));
  assert.equal(splitRing([[5, 5], [5, 5], [5, 5]]).length, 1);
});

// 曲线展平：和后端同样的检查——在真实曲线上密采样，到折线的最大距离 ≤ 0.05 mm
function dev(p0, p1, p2, p3) {
  const pts = flattenPath({ closed: false, segs: [[...p0, 0, 0, p1[0] - p0[0], p1[1] - p0[1]], [...p3, p2[0] - p3[0], p2[1] - p3[1], 0, 0]] });
  const dseg = (p, a, b) => {
    const vx = b[0] - a[0]; const vy = b[1] - a[1]; const L = vx * vx + vy * vy;
    const u = L ? Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / L)) : 0;
    return Math.hypot(p[0] - a[0] - u * vx, p[1] - a[1] - u * vy);
  };
  let worst = 0;
  for (let i = 0; i <= 2000; i++) {
    const s = i / 2000; const m = 1 - s;
    const q = [0, 1].map((k) => m ** 3 * p0[k] + 3 * m * m * s * p1[k] + 3 * m * s * s * p2[k] + s ** 3 * p3[k]);
    let best = Infinity;
    for (let j = 0; j + 1 < pts.length; j++) best = Math.min(best, dseg(q, pts[j], pts[j + 1]));
    worst = Math.max(worst, best);
  }
  return worst;
}

t('圆（半径 1 ~ 1000 mm）展平偏差 ≤ 0.05 mm', () => {
  [1, 5, 50, 150, 400, 1000].forEach((r) => {
    const k = 0.5522847498 * r;
    const d = dev([r, 0], [r, k], [k, r], [0, r]);
    assert.ok(d <= 0.05, `r=${r} 偏差 ${d}`);
  });
});

t('贝塞尔（S 形、尖弯）展平偏差 ≤ 0.05 mm；段数和后端 curve_steps 一致', () => {
  [[[0, 0], [300, 400], [-100, 400], [200, 0]], [[0, 0], [500, 0], [-500, 100], [0, 100]], [[0, 0], [0, 0], [10, 10], [10, 0]]]
    .forEach((c) => assert.ok(dev(...c) <= 0.05, JSON.stringify(c)));
  // 后端 sketch2d.curve_steps 对同样输入的结果（python 算出来写在这里）
  assert.equal(curveSteps([1000, 0], [1000, 552.2847498], [552.2847498, 1000], [0, 1000]), 132);
  assert.equal(curveSteps([0, 0], [300, 400], [-100, 400], [200, 0]), 174);
  assert.equal(curveSteps([5, 0], [5, 2.761423749], [2.761423749, 5], [0, 5]), 13);
});

console.log(`PASS geometry.test：${n} 项（自相交拆分、差一点闭合、重合节点、曲线展平精度）`);
