// ---------------------------------------------------------------------------
// 回执线下领取预约：领域常量、编号 / 领取码派生、输入解析、对外视图。
// 不含任何数据库访问，便于在路由层与存储层共享同一份规则。
// ---------------------------------------------------------------------------
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { config } from './config.js';
import { CROCKFORD } from './receipts.js';
import { nowMs } from './clock.js';

function crockford(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

// 预约编号：YY-YYYYMMDD-XXXXXXXX（8 位 Crockford，无易混字符）
export function newAppointmentNo(ts = nowMs()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `YY-${y}${m}${day}-${crockford(randomBytes(5)).slice(0, 8)}`;
}

export const APPOINTMENT_NO_PATTERN = /^YY-\d{8}-[0-9A-Z]{8}$/;

export function formatAppointmentNoInput(input) {
  const compact = String(input || '').replace(/[\s-]/g, '').toUpperCase();
  const m = /^YY(\d{8})([0-9A-Z]{8})$/.exec(compact);
  return m ? `YY-${m[1]}-${m[2]}` : compact;
}

// 领取码：10 位 Crockford（展示为 XXXXX-XXXXX），只在预约/改约当次明文返回一次
export function newPickupCode() {
  const raw = crockford(randomBytes(8)).slice(0, 10).padEnd(10, '0');
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export function normalizePickupCode(input) {
  return String(input || '').replace(/[\s-]/g, '').toUpperCase();
}

export const PICKUP_CODE_PATTERN = /^[0-9A-HJ-NP-TV-Z]{10}$/;

// ---------------------------------------------------------------------------
// 领取码密钥：服务端只保存 HMAC 摘要，不保存明文。优先环境变量，否则在数据
// 目录生成 0600 权限密钥文件（随数据卷持久化；密钥丢失后旧领取码将无法校验）。
// ---------------------------------------------------------------------------
let cachedPickupSecret = null;

function loadPickupSecret() {
  if (cachedPickupSecret) return cachedPickupSecret;
  if (config.pickupCodeSecret) {
    cachedPickupSecret = Buffer.from(config.pickupCodeSecret, 'utf8');
    return cachedPickupSecret;
  }
  const file = config.pickupCodeSecretPath;
  if (existsSync(file)) {
    cachedPickupSecret = readFileSync(file);
    return cachedPickupSecret;
  }
  const generated = randomBytes(32);
  try {
    writeFileSync(file, generated, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (error) {
    throw new Error(`无法写入领取码密钥文件 ${file}：${error.message}。请通过 PICKUP_CODE_SECRET 提供密钥。`);
  }
  cachedPickupSecret = generated;
  return cachedPickupSecret;
}

// 摘要绑定到“当前生效的那一枚”：code_seq 随改约递增，旧领取码天然失配。
export function pickupCodeDigest({ appointmentNo, codeSeq, rawCode }) {
  return createHmac('sha256', loadPickupSecret())
    .update(`pickup-code:${appointmentNo}:${codeSeq}:${normalizePickupCode(rawCode)}`)
    .digest();
}

export function codeDigestMatches(digest, { appointmentNo, codeSeq, rawCode }) {
  const expected = pickupCodeDigest({ appointmentNo, codeSeq, rawCode });
  const actual = Buffer.isBuffer(digest) ? digest : Buffer.from(digest || '');
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

// ---------------------------------------------------------------------------
// 状态与审计事件
// ---------------------------------------------------------------------------
export const APPOINTMENT_STATUS = ['booked', 'rescheduled', 'cancelled', 'delivered', 'revoked', 'expired'];
export const STATUS_LABELS = {
  booked: '已预约',
  rescheduled: '已改约',
  cancelled: '已取消',
  delivered: '已交付',
  revoked: '回执撤销已失效',
  expired: '已过期',
};
export const SLOT_STATUS_LABELS = { open: '开放预约', closed: '已关闭' };
export const LOCATION_STATUS_LABELS = { active: '可用', disabled: '已停用' };

export const AUDIT_LABELS = {
  'pickup.appointment.booked': '预约领取',
  'pickup.appointment.rescheduled': '改约',
  'pickup.appointment.cancelled': '取消预约',
  'pickup.appointment.delivered': '确认交付',
  'pickup.appointment.revoked': '回执撤销致预约失效',
  'pickup.appointment.expired': '超时未领取自动失效',
  'pickup.location.created': '新建领取网点',
  'pickup.location.updated': '更新网点信息',
  'pickup.location.disabled': '停用网点',
  'pickup.slot.created': '新建时间段',
  'pickup.slot.updated': '调整时间段/容量',
  'pickup.slot.closed': '关闭时间段',
  'pickup.denied': '领取被拒绝',
  'pickup.action.rejected': '操作被拒绝',
};

// ---------------------------------------------------------------------------
// 输入解析（路由层在进入事务前校验，错误码与存储层共享）
// ---------------------------------------------------------------------------
export const PICKUP_ERRORS = {
  LOCATION_NOT_FOUND: '领取网点不存在',
  LOCATION_DISABLED: '该领取网点已停用，不能再新增预约',
  SLOT_NOT_FOUND: '可预约时间段不存在',
  SLOT_NOT_OPEN: '该时间段已关闭，不能再预约',
  SLOT_NOT_BOOKABLE: '该时间段不在可预约范围',
  SLOT_CAPACITY_FULL: '该时间段名额已满，请选择其他时间段',
  SLOT_TIME_CONFLICT: '同一网点的时间段不能重叠',
  SLOT_CAPACITY_BELOW_OCCUPIED: '容量不能小于当前已占用名额',
  SLOT_TIME_LOCKED: '该时间段已有人预约，时间范围不能调整；可新建时间段或仅调整容量',
  RECEIPT_NOT_ELIGIBLE: '只有已签发且未撤销回执的办理人可以预约领取',
  RECEIPT_REVOKED: '回执已撤销，不能预约领取',
  ACTIVE_APPOINTMENT_EXISTS: '该回执已有进行中的预约，请先取消或改约',
  APPOINTMENT_NOT_FOUND: '预约不存在或不属于当前账号',
  APPOINTMENT_NOT_ACTIVE: '预约当前状态不允许该操作',
  APPOINTMENT_VERSION_CONFLICT: '预约已被其他操作改变，请刷新后携带最新版本号重试',
  APPOINTMENT_DELIVERED_READONLY: '预约已交付，记录只读，不能取消、改约或重复交付',
  RESCHEDULE_SAME_SLOT: '新时间段与当前时间段相同，无需改约',
  PICKUP_TOO_EARLY: '未到预约领取时间',
  PICKUP_TOO_LATE: '已超过预约领取时间（含宽限时间）',
  PICKUP_CODE_INVALID: '领取码错误',
  PICKUP_CODE_OLD: '领取码已失效（预约改过约，请使用改约后显示的新领取码）',
  PICKUP_ALREADY_DELIVERED: '该预约已经交付，不能重复领取',
  PICKUP_NOT_ACTIVE: '预约已取消、失效或过期，不能领取',
  PICKUP_MISMATCH: '领取码与预约编号不匹配（不能跨预约使用领取码）',
};

export function parseLocationInput(body, { partial = false } = {}) {
  const errors = [];
  const value = {};
  const name = String(body?.name ?? '').trim();
  const address = String(body?.address ?? '').trim();
  if (!partial || body.name !== undefined) {
    if (name.length < 2 || name.length > 60) errors.push('网点名称需为 2-60 个字符');
    value.name = name;
  }
  if (!partial || body.address !== undefined) {
    if (address.length < 4 || address.length > 120) errors.push('网点地址需为 4-120 个字符');
    value.address = address;
  }
  const note = String(body?.note ?? '').trim();
  if (note.length > 200) errors.push('备注不超过 200 个字符');
  value.note = note;
  return errors.length ? { error: { code: 'INVALID_INPUT', message: errors.join('；') } } : { value };
}

function parseEpoch(value, field) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return { ok: false, error: `${field}必须是毫秒时间戳` };
  }
  return { ok: true, value: n };
}

export function parseSlotInput(body, { now = nowMs() } = {}) {
  const errors = [];
  const start = parseEpoch(body?.startAt, '开始时间');
  const end = parseEpoch(body?.endAt, '结束时间');
  if (!start.ok) errors.push(start.error);
  if (!end.ok) errors.push(end.error);
  const capacity = Number(body?.capacity);
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100000) {
    errors.push('每段容量需为 1-100000 的整数');
  }
  if (start.ok && end.ok) {
    if (end.value <= start.value) errors.push('结束时间必须晚于开始时间');
    if (end.value - start.value > 24 * 60 * 60 * 1000) errors.push('单个时间段不能超过 24 小时');
    if (start.value < now - 60 * 1000) errors.push('开始时间不能早于当前时间');
  }
  const note = String(body?.note ?? '').trim();
  if (note.length > 200) errors.push('备注不超过 200 个字符');
  if (errors.length) return { error: { code: 'INVALID_INPUT', message: errors.join('；') } };
  return { value: { startAt: start.value, endAt: end.value, capacity, note } };
}

export function parseSlotUpdateInput(body, { now = nowMs() } = {}) {
  const errors = [];
  const value = {};
  if (body?.capacity !== undefined) {
    const capacity = Number(body.capacity);
    if (!Number.isInteger(capacity) || capacity < 1 || capacity > 100000) {
      errors.push('每段容量需为 1-100000 的整数');
    } else {
      value.capacity = capacity;
    }
  }
  if (body?.startAt !== undefined || body?.endAt !== undefined) {
    const start = parseEpoch(body?.startAt, '开始时间');
    const end = parseEpoch(body?.endAt, '结束时间');
    if (!start.ok) errors.push(start.error);
    if (!end.ok) errors.push(end.error);
    if (start.ok && end.ok) {
      if (end.value <= start.value) errors.push('结束时间必须晚于开始时间');
      if (end.value - start.value > 24 * 60 * 60 * 1000) errors.push('单个时间段不能超过 24 小时');
      if (start.value < now - 60 * 1000) errors.push('开始时间不能早于当前时间');
      value.startAt = start.value;
      value.endAt = end.value;
    }
  }
  if (body?.note !== undefined) {
    const note = String(body.note ?? '').trim();
    if (note.length > 200) errors.push('备注不超过 200 个字符');
    value.note = note;
  }
  if (errors.length) return { error: { code: 'INVALID_INPUT', message: errors.join('；') } };
  return { value };
}

export function parseBookingInput(body) {
  const slotId = String(body?.slotId || '').trim();
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(slotId)) {
    return { error: { code: 'INVALID_INPUT', message: '请选择有效的时间段' } };
  }
  const note = String(body?.note ?? '').trim();
  if (note.length > 200) {
    return { error: { code: 'INVALID_INPUT', message: '备注不超过 200 个字符' } };
  }
  return { value: { slotId, note } };
}

export function parseRescheduleInput(body) {
  const slotId = String(body?.slotId || '').trim();
  const version = Number(body?.expectedVersion ?? body?.version);
  if (!Number.isInteger(version) || version < 1) {
    return { error: { code: 'INVALID_INPUT', message: '改约必须携带当前预约版本号（≥1 的整数）' } };
  }
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(slotId)) {
    return { error: { code: 'INVALID_INPUT', message: '请选择有效的新时间段' } };
  }
  const note = String(body?.note ?? '').trim();
  if (note.length > 200) {
    return { error: { code: 'INVALID_INPUT', message: '备注不超过 200 个字符' } };
  }
  return { value: { slotId, expectedVersion: version, note } };
}

export function parseCancelInput(body) {
  const reason = String(body?.reason ?? '').trim();
  if (reason.length > 200) return { error: { code: 'INVALID_INPUT', message: '取消原因不超过 200 个字符' } };
  return { value: { reason } };
}

export function parseConfirmDeliveryInput(body) {
  const appointmentNo = formatAppointmentNoInput(String(body?.appointmentNo || ''));
  if (!APPOINTMENT_NO_PATTERN.test(appointmentNo)) {
    return { error: { code: 'INVALID_INPUT', message: '预约编号格式不正确' } };
  }
  const code = normalizePickupCode(String(body?.code || ''));
  if (!PICKUP_CODE_PATTERN.test(code)) {
    return { error: { code: 'INVALID_INPUT', message: '领取码格式不正确（应为 10 位字符）' } };
  }
  const note = String(body?.note ?? '').trim();
  if (note.length > 200) return { error: { code: 'INVALID_INPUT', message: '交付备注不超过 200 个字符' } };
  return { value: { appointmentNo, code, note } };
}

// ---------------------------------------------------------------------------
// 对外视图
// ---------------------------------------------------------------------------
// 办理人视图：状态 + 冻结领取信息；任何视图都不回传领取码明文/摘要
export function handlerAppointmentView(row) {
  return {
    id: row.id,
    appointmentNo: row.appointment_no,
    receiptNo: row.receipt_no,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] || row.status,
    version: row.version,
    codeSeq: row.code_seq,
    graceMs: row.grace_ms,
    frozen: {
      locationName: row.frozen_location_name,
      locationAddress: row.frozen_location_address,
      startAt: row.frozen_start_at,
      endAt: row.frozen_end_at,
      capacityVersion: row.frozen_capacity_version,
    },
    slotId: row.frozen_slot_id,
    note: row.note || '',
    cancelReason: row.cancel_reason || '',
    revokeReason: row.revoke_reason || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    cancelledAt: row.cancelled_at || null,
    deliveredAt: row.delivered_at || null,
    expiredAt: row.expired_at || null,
    revokedAt: row.revoked_at || null,
    deliveredByLabel: row.delivered_by_label || '',
  };
}

// 领取人员视图：只展示履约所需最小信息（不含办理人身份与备注）
export function staffDeliveryView(row, { graceMs } = {}) {
  return {
    appointmentNo: row.appointment_no,
    status: row.status,
    statusLabel: STATUS_LABELS[row.status] || row.status,
    locationName: row.frozen_location_name,
    locationAddress: row.frozen_location_address,
    startAt: row.frozen_start_at,
    endAt: row.frozen_end_at,
    graceMs: Number.isFinite(graceMs) ? graceMs : row.grace_ms,
    deliveredAt: row.delivered_at || null,
    version: row.version,
  };
}

export function slotView(row, occupied) {
  const occ = occupied === undefined ? row.occupied : occupied;
  return {
    id: row.id,
    locationId: row.location_id,
    startAt: row.start_at,
    endAt: row.end_at,
    capacity: row.capacity,
    capacityVersion: row.capacity_version,
    occupied: occ,
    remaining: Math.max(0, row.capacity - occ),
    status: row.status,
    statusLabel: SLOT_STATUS_LABELS[row.status] || row.status,
    note: row.note || '',
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function locationView(row, slots = []) {
  const capacity = slots.reduce((sum, slot) => sum + slot.capacity, 0);
  const occupied = slots.reduce((sum, slot) => sum + (slot.occupied ?? 0), 0);
  return {
    id: row.id,
    name: row.name,
    address: row.address,
    status: row.status,
    statusLabel: LOCATION_STATUS_LABELS[row.status] || row.status,
    note: row.note || '',
    version: row.version,
    slotCount: slots.length,
    capacityTotal: capacity,
    occupiedTotal: occupied,
    remainingTotal: Math.max(0, capacity - occupied),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function auditView(row) {
  return {
    id: row.id,
    type: row.type,
    typeLabel: AUDIT_LABELS[row.type] || row.type,
    appointmentNo: row.appointment_no || '',
    receiptNo: row.receipt_no || '',
    slotId: row.slot_id || '',
    actorRole: row.actor_role || '',
    actorLabel: row.actor_label || '',
    detail: safeJson(row.detail_json, {}),
    result: row.result,
    createdAt: row.created_at,
  };
}

function safeJson(value, fallback) {
  try {
    return JSON.parse(value || '');
  } catch {
    return fallback;
  }
}
