// ---------------------------------------------------------------------------
// 可验证审计归档：输入校验、错误码、分级视图脱敏规则与归档编号
//
// 三种视图（在归档创建瞬间冻结权限快照，之后权限变化不会扩大已生成归档）：
//   - handler（办理人）：获准范围内的完整字段与操作人；
//   - auditor（审计员）：按角色授权的脱敏字段、来源关系、摘要链校验结果，
//                       看不到操作人身份、证件/地址等原文；
//   - external（外部核验）：只能凭一次性核验码看到事件数量、时间范围、
//                          摘要链是否连续与最终状态。
// ---------------------------------------------------------------------------

export const ARCHIVE_SOURCE_TYPES = ['batch', 'appeal', 'mediation', 'caseGroup'];

export const ARCHIVE_SOURCE_LABELS = {
  batch: '原批次',
  appeal: '申诉回合',
  mediation: '调解包',
  caseGroup: '案件组',
};

export const ARCHIVE_ERRORS = {
  ARCHIVE_SOURCE_INVALID: '归档来源类型不正确',
  ARCHIVE_SOURCE_NOT_FOUND: '归档来源不存在或不属于当前账号',
  ARCHIVE_NOT_FOUND: '归档不存在或无权访问',
  ARCHIVE_EVENT_GAP: '审计事件存在缺口，不能生成归档',
  ARCHIVE_EVENT_ORDER_CONFLICT: '审计事件顺序冲突，不能生成归档',
  ARCHIVE_SOURCE_INCONSISTENT: '审计事件来源关系不一致，不能生成归档',
  ARCHIVE_CHAIN_INVALID: '摘要链校验失败：归档内容可能已被篡改',
  ARCHIVE_REDACTION_INVALID: '脱敏规则无法应用，不能生成归档',
  ARCHIVE_VIEW_FORBIDDEN: '当前账号无权按该视图查阅此归档',
  EXPORT_NOT_FOUND: '导出任务不存在或无权访问',
  EXPORT_ALREADY_RUNNING: '同一归档同一版本已有进行中的导出任务',
  EXPORT_NOT_COMPLETED: '导出任务尚未完成，暂无文件可下载',
  EXPORT_TASK_CANCELLED: '导出任务已取消，凭证失效',
  EXPORT_TASK_EXPIRED: '导出文件已过保留期并被清理',
  EXPORT_CREDENTIAL_INVALID: '下载凭证不正确',
  EXPORT_CREDENTIAL_USED: '下载凭证已使用过，不能重复使用',
  EXPORT_CREDENTIAL_REVOKED: '下载凭证已作废',
  EXPORT_CREDENTIAL_EXPIRED: '下载凭证已过期',
  EXPORT_CREDENTIAL_ARCHIVE_MISMATCH: '下载凭证与请求的归档不匹配',
  EXPORT_IDEMPOTENCY_CONFLICT: '该幂等键已用于其他导出请求',
  EXPORT_NOT_CANCELLABLE: '只有排队中或进行中的导出任务可以取消',
  EXTERNAL_CODE_INVALID: '外部核验码不正确',
  EXTERNAL_CODE_USED: '外部核验码只能使用一次，已被使用',
  EXTERNAL_CODE_REVOKED: '外部核验码已作废',
  EXTERNAL_CODE_EXPIRED: '外部核验码已过期',
  EXTERNAL_CODE_ARCHIVE_MISMATCH: '核验码与归档不匹配',
};

export function isValidArchiveSourceType(value) {
  return ARCHIVE_SOURCE_TYPES.includes(value);
}

export function isValidId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,200}$/.test(value);
}

export function parseArchiveCreateInput(body) {
  const sourceType = String(body?.sourceType || '').trim();
  const sourceId = String(body?.sourceId || '').trim();
  const note = String(body?.note || '').trim().slice(0, 200);
  if (!isValidArchiveSourceType(sourceType)) {
    return { error: { code: 'ARCHIVE_SOURCE_INVALID', message: ARCHIVE_ERRORS.ARCHIVE_SOURCE_INVALID } };
  }
  if (!isValidId(sourceId)) {
    return { error: { code: 'ARCHIVE_SOURCE_NOT_FOUND', message: ARCHIVE_ERRORS.ARCHIVE_SOURCE_NOT_FOUND } };
  }
  return { value: { sourceType, sourceId, note } };
}

// 办理人可勾选授权的审计员用户名（必须是 auditor 角色账号）；归档创建后不可变
export function parseAuditorGrants(body, auditorUsers) {
  const raw = Array.isArray(body?.auditorGrants) ? body.auditorGrants : [];
  const usernames = [...new Set(raw.map((value) => String(value || '').trim()).filter(Boolean))];
  if (usernames.length > 10) {
    return { error: { code: 'INVALID_INPUT', message: '授权审计员最多 10 个' } };
  }
  const grants = [];
  for (const username of usernames) {
    const user = auditorUsers.find((item) => item.username === username);
    if (!user) {
      return { error: { code: 'INVALID_INPUT', message: `审计员账号不存在：${username}` } };
    }
    grants.push({ userId: user.id, username: user.username, displayName: user.display_name });
  }
  return { value: grants };
}

// 编号形如 GD-YYYYMMDD-XXXXXXXX（Crockford Base32，无易混字符）
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export function newArchiveNo(issuedAt = Date.now()) {
  const d = new Date(issuedAt);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  let randomPart = '';
  for (let i = 0; i < 8; i += 1) randomPart += CROCKFORD[Math.floor(Math.random() * 32)];
  return `GD-${y}${m}${day}-${randomPart}`;
}

// ---------------------------------------------------------------------------
// 审计员视图脱敏：审计事件 detail 中的敏感内容在服务端遮罩后才允许出现在
// 审计员响应中。审计事件本身记录的是协作流程元数据（编号/标识/结论），
// 不含证件/地址原值；以下规则对可能间接携带个人信息的字段做进一步遮罩，
// 并统一剥离操作人身份（actorLabel 由角色名替代）。
// ---------------------------------------------------------------------------

// 审计员视图中 detail 内需要完全移除的键（任何层级命中键名即剥离）
const AUDITOR_DROP_KEYS = new Set([
  'reason', // 逐字意见/驳回理由：审计员只看得到结论，看不到逐字内容
  'rejectReason',
  'decisionReason',
  'cancelReason',
  'detail', // caseGroup.member.rejected 的明细
  'note',
  'ip',
  'usedIp',
]);

// 审计员视图中需要遮罩的键（保留键，值替换为掩码标记）
const AUDITOR_MASK_KEYS = new Set([
  'label', // 邀请标签可能带人名
  'reviewerLabel',
]);

function redactAuditorValue(value, key) {
  if (AUDITOR_DROP_KEYS.has(key)) return undefined;
  if (AUDITOR_MASK_KEYS.has(key) && typeof value === 'string') {
    return value ? '***脱敏***' : value;
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) {
      const redacted = redactAuditorValue(item, key);
      if (redacted !== undefined) out.push(redacted);
    }
    return out;
  }
  if (value && typeof value === 'object') {
    return redactAuditorDetail(value);
  }
  return value;
}

export function redactAuditorDetail(detail) {
  if (!detail || typeof detail !== 'object') return detail;
  const out = {};
  for (const [key, value] of Object.entries(detail)) {
    const redacted = redactAuditorValue(value, key);
    if (redacted !== undefined) out[key] = redacted;
  }
  return out;
}

// 审计员视图的操作人：统一角色化，不含办理人/复核人身份
export function auditorActor(eventView) {
  return { role: eventView.actorRole || 'system', label: '' };
}

// 办理人视图的事件类型分类（来源关系展示用）
export function eventFamily(eventType) {
  if (eventType.startsWith('review.batch.')) return 'batch';
  if (eventType.startsWith('review.appeal.')) return 'appeal';
  if (eventType.startsWith('review.mediation.')) return 'mediation';
  if (eventType.startsWith('review.caseGroup.')) return 'caseGroup';
  return 'workflow';
}
