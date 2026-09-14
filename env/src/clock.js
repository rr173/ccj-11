// ---------------------------------------------------------------------------
// 受控时钟：默认与 Date.now() 一致；测试可固定时间，用于确定性验证时间窗口
// 边界（过早 / 窗口内含边界 / 超过宽限即过期）。除测试外不要修改。
// ---------------------------------------------------------------------------
let fixedAt = null;

export function nowMs() {
  return fixedAt === null ? Date.now() : fixedAt;
}

export function setClock(epochMs) {
  fixedAt = Number.isFinite(epochMs) ? Number(epochMs) : null;
}

export function resetClock() {
  fixedAt = null;
}
