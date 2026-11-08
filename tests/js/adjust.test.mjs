// 描摹前调节（C10）：adjustGray 的裁剪、亮度、对比度。运行：node tests/js/adjust.test.mjs
import assert from 'node:assert/strict';
import { adjustGray } from '../../web/sketch-import.js';

const w = 10, h = 4;
const gray = new Uint8Array(w * h).map((_, i) => (i % w) * 20);          // 每列 0, 20, …, 180
let r = adjustGray({ gray, w, h });
assert.deepEqual([r.w, r.h], [10, 4]);
assert.deepEqual([...r.gray], [...gray], '不调节 = 原样');
r = adjustGray({ gray, w, h }, { crop: [20, 25, 30, 0] });
assert.deepEqual([r.w, r.h], [5, 3], '裁掉左 20 %、上 25 %、右 30 %');
assert.equal(r.gray[0], 40, '裁剪后第一列 = 原来第 3 列');
r = adjustGray({ gray, w, h }, { bright: 100 });
assert.equal(r.gray[0], 255, '亮度 +100：0 → 255（截断）');
r = adjustGray({ gray, w, h }, { bright: -50 });
assert.equal(r.gray[9], Math.round(180 - 127.5), '亮度 −50：180 → 52.5');
r = adjustGray({ gray, w, h }, { contrast: -100 });
assert.ok([...r.gray].every((v) => v === 128), '对比度 −100：全部变成 128');
r = adjustGray({ gray, w, h }, { contrast: 50 });
assert.ok(r.gray[0] < 0 + 1 && r.gray[9] > 180, '对比度 +50：暗的更暗、亮的更亮');
console.log('PASS adjust.test：裁剪、亮度、对比度');
