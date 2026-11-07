// node tests/js/fit_calc.test.mjs —— 卡扣测试样换算的单元测试
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const src = readFileSync(new URL('../../web/fit-calc.js', import.meta.url), 'utf8');
const m = await import('data:text/javascript,' + encodeURIComponent(src));
const { fitResult, ladderSlots, stepLabel } = m;
let n = 0;
const t = (name, fn) => { fn(); n++; console.log('ok', name); };

t('标签', () => {
  assert.equal(stepLabel(0), '0'); assert.equal(stepLabel(0.05), '+.05'); assert.equal(stepLabel(-0.1), '-.10');
});
t('插槽名义宽', () => {
  const s = ladderSlots(3);
  assert.equal(s.length, 9); assert.equal(s[0].width, 2.9); assert.equal(s[8].width, 3.3);
});
t('补偿正好等于切缝一半：外方量出 40、内孔 20', () => {
  const r = fitResult({ t0: 3, b0: 0.1, outer: 40, inner: 20 });
  assert.equal(r.kerf, 0.2); assert.equal(r.burn, 0.1); assert.deepEqual(r.warn, []);
});
t('切缝比补偿大：外方偏小、内孔偏大', () => {
  // 真实切缝 0.3，用 b0=0.1 切：外方 = 40.2-0.3 = 39.9，内孔 = 19.8+0.3 = 20.1
  const r = fitResult({ t0: 3, b0: 0.1, outer: 39.9, inner: 20.1 });
  assert.equal(r.kerf, 0.3); assert.equal(r.burn, 0.15);
});
t('间隙：最合适的是 +.05 槽，板实测 2.85', () => {
  // 槽实际宽 = 3 + 0.05 − 0.2 + 0.3 = 3.15；以后插槽实际宽 = 2.85 + play → play = 0.3
  const r = fitResult({ t0: 3, b0: 0.1, tReal: 2.85, outer: 39.9, inner: 20.1, bestStep: 0.05 });
  assert.equal(r.thickness, 2.85); assert.equal(r.play, 0.3);
});
t('不变量：按算出的补偿和间隙，以后切出的插槽宽度 = 最合适那条槽的实际宽度', () => {
  for (const kerf of [0.1, 0.2, 0.35]) for (const b0 of [0, 0.08, 0.15]) for (const c of [-0.1, 0, 0.2]) {
    const tReal = 2.8, t0 = 3;
    const outer = 40 + 2 * b0 - kerf;
    const r = fitResult({ t0, b0, tReal, outer, bestStep: c });
    const testSlot = t0 + c - 2 * b0 + kerf;                   // 测试时那条槽的实际宽
    const future = (tReal + r.play) - 2 * r.burn + kerf;      // 以后：名义 tReal+play，按新补偿内收
    assert.ok(Math.abs(future - testSlot) < 2e-3, `kerf ${kerf} b0 ${b0} c ${c}: ${future} vs ${testSlot}`);
  }
});
t('读数可疑时给提示', () => {
  assert.ok(fitResult({ t0: 3, b0: 0.1, outer: 39.2, inner: 20.0 }).warn.length >= 1);
  assert.ok(fitResult({ t0: 3, b0: 0.1, outer: 41 }).warn.some((w) => w.includes('常见范围')));
});
t('没量方块也能给出间隙（并提示）', () => {
  const r = fitResult({ t0: 3, b0: 0.1, tReal: 3, bestStep: 0.1 });
  assert.equal(r.kerf, null); assert.equal(r.play, 0.1); assert.ok(r.warn.length);
});
console.log(`\n${n} passed`);
