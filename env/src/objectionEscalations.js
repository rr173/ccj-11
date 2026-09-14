// ---------------------------------------------------------------------------
// 异议超期升级与通知留痕（objection escalation & notification audit trail）
//
// 在“回执撤销与异议处理”之上新增的只读监控 + 一次延期能力：
//   - 异议接近处理期限（按配置的提前提醒时间点）时，调度器生成【待发送】提醒通知；
//   - 超过处理期限后，自动标记逾期并按处理人 / 主管 / 审计员的权限分流升级记录；
//   - 通知负载只允许携带异议编号、当前状态、截止时间、来源回执等非敏感字段，
//     在构造瞬间定型，任何角色视角都不含证件号、完整地址、完整手机号；
//   - 处理人可确认已读、填写延期原因申请一次延期；主管可批准 / 拒绝延期；
//   - 每次提醒、升级、确认已读、延期申请 / 批准 / 拒绝都只追加事件，永不覆盖。
//
// 通知（receipt_objection_notifications）：
//   kind=reminder（到期前提醒）/ overdue（逾期升级记录）/ extension-requested /
//        extension-approved / extension-rejected
//   audience=processor | handler | supervisor（具体接收人由 target_user_id 锁定；
//   target_user_id 为空表示按角色广播，仅审计视图按权限展开）。
//   部分唯一索引 (objection_id, kind, dedupe_key, audience, target_user_id) 兜底
//   “重复调度不产生重复通知”。
//
// 延期（receipt_objection_extensions）：每份异议至多一条申请（ordinal 恒为 0），
// 处理人重复申请 / 两个页面并发申请只放行一个；主管只能在 pending 状态决议一次。
// ---------------------------------------------------------------------------

import { OBJECTION_STATUS_LABELS } from './receiptObjections.js';

// 通知类型（与 receipt_objection_notifications.kind 的 CHECK 对齐）
export const OBJECTION_NOTIFICATION_KINDS = [
  'reminder', 'overdue', 'extension-requested', 'extension-approved', 'extension-rejected',
];

const OBJECTION_NOTIFICATION_KIND_LABELS = {
  reminder: '到期前提醒',
  overdue: '逾期升级',
  'extension-requested': '延期申请待审批',
  'extension-approved': '延期申请已批准',
  'extension-rejected': '延期申请已拒绝',
};

export const EXTENSION_REASON_MIN = 5;
export const EXTENSION_REASON_MAX = 300;
export const EXTENSION_DECISION_NOTE_MAX = 300;

export function validateExtensionReason(reason) {
  const text = String(reason || '').trim();
  if (text.length < EXTENSION_REASON_MIN || text.length > EXTENSION_REASON_MAX) {
    return {
      ok: false,
      code: 'INVALID_EXTENSION_REASON',
      message: `延期原因需为 ${EXTENSION_REASON_MIN}-${EXTENSION_REASON_MAX} 个字符`,
    };
  }
  return { ok: true, value: text };
}

export function validateExtensionDecision(note, { required = false } = {}) {
  const text = String(note || '').trim();
  if (required && text.length < 2) {
    return { ok: false, code: 'EXTENSION_DECISION_NOTE_REQUIRED', message: '主管决议说明至少 2 个字符' };
  }
  if (text.length > EXTENSION_DECISION_NOTE_MAX) {
    return { ok: false, code: 'EXTENSION_NOTE_TOO_LONG', message: `说明不能超过 ${EXTENSION_DECISION_NOTE_MAX} 个字符` };
  }
  return { ok: true, value: text };
}

// ---------------------------------------------------------------------------
// 通知负载：构造瞬间定型，只含非敏感字段。
// 刻意不引用冻结快照中的申请人姓名 / 证件号 / 地址 / 手机号——
// “不能泄露未授权的证件号、完整地址或完整手机号”在数据源处保证，
// 后续按角色渲染时不可能因为漏脱敏而泄露。
// ---------------------------------------------------------------------------
export function buildNotificationPayload({
  objection, kind, status = '', deadlineAt = null, extension = null, extra = {},
}) {
  const payload = {
    objectionNo: objection.objection_no,
    kind,
    kindLabel: OBJECTION_NOTIFICATION_KIND_LABELS[kind] || kind,
    status: status || objection.status,
    statusLabel: OBJECTION_STATUS_LABELS[status || objection.status] || status || objection.status,
    deadlineAt: deadlineAt ?? objection.deadline_at,
    receiptNo: objection.receipt_no,
    createdAt: objection.created_at,
  };
  if (extension) {
    payload.extension = {
      ordinal: extension.ordinal,
      status: extension.status,
      reason: extension.reason,
      requestedDurationMs: extension.requested_duration_ms,
      requestedAt: extension.created_at,
      decidedAt: extension.decided_at || null,
      decisionNote: extension.decision_note || '',
      previousDeadlineAt: extension.previous_deadline_at || null,
    };
  }
  return Object.assign(payload, extra);
}

// 提醒去重键：同一截止时间的同一提醒序位只生成一次（恢复/迁移产生新的有效
// 截止时间后，其提醒是新的 dedupeKey，旧提醒通知永久留档）。
export function reminderDedupeKey(reminderOrdinal, deadlineAt) {
  return `reminder-${reminderOrdinal}@${deadlineAt}`;
}

// 升级层级：批准过几次延期，层级就往后排（首次逾期 level=1；延期后再逾期 level=2）
export function overdueDedupeKey(level) {
  return `overdue-l${level}`;
}
