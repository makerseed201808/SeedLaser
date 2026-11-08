// 卡榫测试样：几何参数和测量结果的换算（纯函数，前端和 node 测试共用）
//
// 测试样（按切割时的「板厚 t0、补偿 b0」生成）：
//   · 插槽阶梯：一排插槽，名义宽 = t0 + c（c 见 FIT_STEPS），导出时孔按补偿内收 → 实际宽 = t0 + c − 2·b0 + 切缝
//   · 测量方块：外方 40 mm、内孔 20 mm → 实际外方 = 40 + 2·b0 − 切缝，实际内孔 = 20 − 2·b0 + 切缝
//   · 插片：用同一张板切出的小条，插进每条槽试松紧
// 换算：切缝 k 由外方 / 内孔反推（两者都量就取平均）→ 正确补偿 = k / 2；
//   最合适那条槽的实际宽度 = t0 + c − 2·b0 + k；以后用正确补偿切插槽，实际宽 = 实测板厚 + 间隙 → 间隙 = 上式 − 实测板厚

export const FIT_STEPS = [-0.10, -0.05, 0, 0.05, 0.10, 0.15, 0.20, 0.25, 0.30];
export const FIT_SQ = { outer: 40, inner: 20 };
export const FIT_LADDER = { pitch: 11, margin: 6, slotLen: 15, slotY: 6, height: 42 };

const r3 = (x) => Math.round(x * 1000) / 1000;

export function stepLabel(c) {
  if (Math.abs(c) < 1e-9) return '0';
  return (c > 0 ? '+' : '-') + Math.abs(c).toFixed(2).replace(/^0/, '');
}

// 插槽阶梯里每条槽的名义宽度（mm）
export function ladderSlots(t0) {
  return FIT_STEPS.map((c) => ({ c, width: r3(t0 + c), label: stepLabel(c) }));
}

/**
 * @param {{t0:number,b0:number,tReal?:number,outer?:number,inner?:number,bestStep?:number|null}} m
 * @returns {{kerf:number|null, burn:number|null, thickness:number, play:number|null, warn:string[]}}
 */
export function fitResult({ t0, b0, tReal, outer, inner, bestStep }) {
  const warn = [];
  const ks = [];
  const kOuter = outer > 0 ? FIT_SQ.outer + 2 * b0 - outer : null;
  const kInner = inner > 0 ? inner - FIT_SQ.inner + 2 * b0 : null;
  if (kOuter != null) ks.push(kOuter);
  if (kInner != null) ks.push(kInner);
  if (kOuter != null && kInner != null && Math.abs(kOuter - kInner) > 0.1) {
    warn.push(`外方和内孔算出的切缝相差 ${r3(Math.abs(kOuter - kInner))} mm，建议重新量一次（卡尺要卡正、不要压）`);
  }
  let kerf = ks.length ? ks.reduce((a, b) => a + b, 0) / ks.length : null;
  if (kerf != null && (kerf < 0 || kerf > 0.6)) {
    warn.push(`算出的切缝 ${r3(kerf)} mm 不在常见范围（0～0.6 mm），请检查读数`);
  }
  if (kerf != null) kerf = r3(kerf);
  const burn = kerf != null ? r3(Math.max(0, kerf / 2)) : null;
  const thickness = tReal > 0 ? r3(tReal) : t0;
  if (tReal > 0 && Math.abs(tReal - t0) > 0.5) warn.push(`实测板厚和设置的 ${t0} mm 相差较大，确认是同一张板`);
  let play = null;
  if (bestStep != null && Number.isFinite(bestStep)) {
    const k = kerf != null ? kerf : 2 * b0;          // 没量切缝：假设当前补偿是对的
    if (kerf == null) warn.push('没有量测量方块：按「当前补偿是对的」估算间隙');
    play = r3(t0 + bestStep - 2 * b0 + k - thickness);
  }
  return { kerf, burn, thickness, play, warn };
}
