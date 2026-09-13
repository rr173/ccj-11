import {
  BATCH_MAX_INVITATIONS,
  BATCH_MIN_INVITATIONS,
  BATCH_OPINION_MAX,
  BATCH_OPINION_MIN,
  BATCH_REJECT_REASON_MAX,
  batchFieldKey,
  batchFieldLabel,
  buildBatchReviewView,
  parseBatchFieldKey,
} from './batchReviews.js';

// ---------------------------------------------------------------------------
// 复核申诉回合（review appeal rounds）
//
// 办理人可针对原复核批次中【已经作出驳回决议】的字段发起一次申诉回合：
//   - 独立的限时、2-5 个一次性邀请、逐邀请字段授权、独立的接受/驳回阈值；
//   - 申诉回合只能引用原批次的冻结快照：新复核人只能看到被授权的脱敏字段、
//     原字段的既有驳回决议与办理人显式允许披露的证据摘要（原复核人匿名化）；
//   - 不能修改原批次的意见、决议或超时结果；
//   - 申诉接受必须在同一个新的更正办理中关联申诉意见与原批次来源。
// ---------------------------------------------------------------------------

export const APPEAL_MIN_INVITATIONS = BATCH_MIN_INVITATIONS;
export const APPEAL_MAX_INVITATIONS = BATCH_MAX_INVITATIONS;
export const APPEAL_LABEL_MAX = 60;
export const APPEAL_NOTE_MAX = 200;
export const APPEAL_OPINION_MIN = BATCH_OPINION_MIN;
export const APPEAL_OPINION_MAX = BATCH_OPINION_MAX;
export const APPEAL_REJECT_REASON_MAX = BATCH_REJECT_REASON_MAX;
export const APPEAL_SESSION_COOKIE = 'aid';
export const APPEAL_CSRF_COOKIE = 'accsrf';

// 办理人发起申诉时必须选择的申诉理由
export const APPEAL_REASONS = [
  { code: 'new_evidence', label: '出现新的关键证据' },
  { code: 'misjudged', label: '原驳回决议认定事实有误' },
  { code: 'procedural', label: '原复核程序或字段授权存在瑕疵' },
  { code: 'other', label: '其他申诉理由' },
];
const APPEAL_REASON_CODES = new Set(APPEAL_REASONS.map((item) => item.code));

export function appealReasonLabel(code) {
  return APPEAL_REASONS.find((item) => item.code === code)?.label || code;
}

// ---------------------------------------------------------------------------
// 创建申诉回合请求的解析与严格校验（不接触数据库）。
//
// 输入形态：
// {
//   ttlMinutes, note,
//   fields: [{
//     key: '0.phone', reason: 'new_evidence',
//     acceptThreshold: 2, rejectThreshold: 1,
//     evidenceOpinionIds: ['原批次意见 id', ...],   // 允许向新复核人披露的原证据；[] = 不披露
//   }],
//   invitations: [{ label: '申诉复核人甲', fields: ['0.phone'] }, ...2-5 个]
// }
// ---------------------------------------------------------------------------
export function parseAppealCreateInput(input, { minMinutes, maxMinutes }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: { code: 'INVALID_APPEAL', message: '申诉回合配置格式不正确' } };
  }
  const note = String(input.note || '').trim().slice(0, APPEAL_NOTE_MAX);
  const ttlMinutes = Number(input.ttlMinutes);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < minMinutes || ttlMinutes > maxMinutes) {
    return { error: { code: 'INVALID_TTL', message: `申诉回合限时需在 ${minMinutes} 分钟到 ${maxMinutes} 分钟之间` } };
  }

  const rawInvitations = input.invitations;
  if (!Array.isArray(rawInvitations)
    || rawInvitations.length < APPEAL_MIN_INVITATIONS
    || rawInvitations.length > APPEAL_MAX_INVITATIONS) {
    return {
      error: {
        code: 'INVALID_APPEAL_INVITATIONS',
        message: `申诉回合必须指定 ${APPEAL_MIN_INVITATIONS}-${APPEAL_MAX_INVITATIONS} 个新复核人邀请`,
      },
    };
  }

  const rawFields = input.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    return { error: { code: 'INVALID_APPEAL_FIELDS', message: '申诉回合至少需要选择一个驳回字段' } };
  }

  const fieldMap = new Map();
  for (const item of rawFields) {
    if (!item || typeof item !== 'object') {
      return { error: { code: 'INVALID_APPEAL_FIELDS', message: '申诉字段配置格式不正确' } };
    }
    const parsedKey = parseBatchFieldKey(item.key);
    if (!parsedKey) {
      return { error: { code: 'INVALID_APPEAL_FIELD', message: `未知字段：${item.key}` } };
    }
    const key = batchFieldKey(parsedKey.step, parsedKey.field);
    if (fieldMap.has(key)) {
      return { error: { code: 'INVALID_APPEAL_FIELD', message: `字段重复申诉：${key}` } };
    }
    const reason = String(item.reason || '');
    if (!APPEAL_REASON_CODES.has(reason)) {
      return { error: { code: 'INVALID_APPEAL_REASON', message: `字段 ${key} 的申诉理由无效` } };
    }
    const accept = parseThreshold(item.acceptThreshold, rawInvitations.length);
    if (accept.error) {
      return { error: { code: 'INVALID_ACCEPT_THRESHOLD', message: `字段 ${key} 的接受阈值无效：${accept.error}` } };
    }
    const reject = parseThreshold(item.rejectThreshold, rawInvitations.length);
    if (reject.error) {
      return { error: { code: 'INVALID_REJECT_THRESHOLD', message: `字段 ${key} 的驳回阈值无效：${reject.error}` } };
    }
    let evidenceOpinionIds = [];
    if (item.evidenceOpinionIds !== undefined && item.evidenceOpinionIds !== null) {
      if (!Array.isArray(item.evidenceOpinionIds)) {
        return { error: { code: 'INVALID_APPEAL_EVIDENCE', message: `字段 ${key} 的证据授权格式不正确` } };
      }
      const seen = new Set();
      for (const id of item.evidenceOpinionIds) {
        const text = String(id || '');
        if (!/^[A-Za-z0-9_-]{8,200}$/.test(text)) {
          return { error: { code: 'INVALID_APPEAL_EVIDENCE', message: `字段 ${key} 的证据授权包含无效条目` } };
        }
        if (seen.has(text)) {
          return { error: { code: 'INVALID_APPEAL_EVIDENCE', message: `字段 ${key} 的证据授权重复` } };
        }
        seen.add(text);
        evidenceOpinionIds.push(text);
      }
    }
    fieldMap.set(key, {
      ...parsedKey,
      key,
      reason,
      acceptThreshold: accept.value,
      rejectThreshold: reject.value,
      evidenceOpinionIds,
    });
  }

  const invitations = [];
  const labels = new Set();
  for (let index = 0; index < rawInvitations.length; index += 1) {
    const raw = rawInvitations[index];
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fields)) {
      return { error: { code: 'INVALID_APPEAL_INVITATIONS', message: `第 ${index + 1} 个邀请的字段授权格式不正确` } };
    }
    const label = String(raw.label || `申诉复核人 ${index + 1}`).trim().slice(0, APPEAL_LABEL_MAX);
    if (!label) {
      return { error: { code: 'INVALID_APPEAL_INVITATIONS', message: `第 ${index + 1} 个邀请缺少名称` } };
    }
    if (labels.has(label)) {
      return { error: { code: 'INVALID_APPEAL_INVITATIONS', message: `邀请名称不能重复：${label}` } };
    }
    labels.add(label);
    if (raw.fields.length === 0) {
      return { error: { code: 'INVALID_APPEAL_FIELD_SCOPE', message: `邀请「${label}」至少需要授权一个字段` } };
    }
    const scopeKeys = [];
    const seen = new Set();
    for (const rawKey of raw.fields) {
      const parsedKey = parseBatchFieldKey(rawKey);
      if (!parsedKey) {
        return { error: { code: 'INVALID_APPEAL_FIELD_SCOPE', message: `邀请「${label}」包含未知字段：${rawKey}` } };
      }
      const key = batchFieldKey(parsedKey.step, parsedKey.field);
      if (!fieldMap.has(key)) {
        return { error: { code: 'INVALID_APPEAL_FIELD_SCOPE', message: `邀请「${label}」授权的字段 ${key} 不在本申诉回合中` } };
      }
      if (seen.has(key)) {
        return { error: { code: 'INVALID_APPEAL_FIELD_SCOPE', message: `邀请「${label}」的字段授权重复：${key}` } };
      }
      seen.add(key);
      scopeKeys.push(key);
    }
    invitations.push({ label, scopeKeys });
  }

  for (const [key] of fieldMap) {
    if (!invitations.some((invite) => invite.scopeKeys.includes(key))) {
      return { error: { code: 'INVALID_APPEAL_FIELD', message: `字段 ${key} 没有任何申诉邀请获得授权` } };
    }
  }

  return { value: { note, ttlMinutes, fields: [...fieldMap.values()], invitations } };
}

function parseThreshold(value, maxInvites) {
  if (!Number.isInteger(value)) return { error: '阈值必须是 1 到邀请数之间的整数' };
  if (value < 1 || value > maxInvites) return { error: `阈值必须在 1 到 ${maxInvites} 之间` };
  return { value };
}

// 新复核人侧脱敏视图：复用批次复核视图，只保留被授权字段（敏感字段服务端遮罩）。
export function buildAppealReviewView(snapshot, authorizedKeys) {
  return buildBatchReviewView(snapshot, authorizedKeys);
}

export function appealFieldLabel(step, field) {
  return batchFieldLabel(step, field);
}

export const APPEAL_ERRORS = {
  APPEAL_NOT_FOUND: '申诉回合不存在或已不可用',
  APPEAL_NOT_ACTIVE: '申诉回合当前状态不允许该操作',
  APPEAL_ALREADY_OPEN: '该复核批次已存在一个进行中的申诉回合，请先完成或取消',
  APPEAL_FIELD_NOT_REJECTED: '只能针对原批次中已经作出驳回决议的字段发起申诉',
  APPEAL_FIELD_DUPLICATE: '该字段已经发起过申诉回合，不能再次申诉',
  APPEAL_FIELD_NOT_FOUND: '申诉字段不存在或不属于本回合',
  APPEAL_FIELD_ALREADY_DECIDED: '该申诉字段已有最终决议，重复决议返回同一结果',
  APPEAL_HAS_DECISIONS: '申诉回合已有字段完成决议，历史不能删除，不能取消',
  APPEAL_DEADLINE_PASSED: '申诉回合限时已过，写操作已关闭',
  ACCEPT_THRESHOLD_NOT_MET: '支持接受的申诉意见数未达到接受阈值，不能接受',
  REJECT_THRESHOLD_NOT_MET: '支持驳回的新复核人数未达到驳回阈值，不能驳回',
  APPEAL_INVITATION_NOT_FOUND: '申诉邀请不存在或链接不正确',
  APPEAL_INVITATION_EXPIRED: '该申诉邀请已超过有效期限，链接失效',
  APPEAL_INVITATION_REVOKED: '该申诉邀请已被办理人撤销或申诉回合已取消，链接失效',
  APPEAL_INVITATION_ALREADY_USED: '该申诉邀请链接只能使用一次，已完成过校验',
  APPEAL_FIELD_NOT_AUTHORIZED: '本邀请未被授权查看该申诉字段，不能针对它提交意见',
  APPEAL_FIELD_DUPLICATE_OPINION: '你已就该申诉字段提交过意见，不能重复提交',
  APPEAL_SESSION_REQUIRED: '请先完成申诉邀请校验',
  APPEAL_CSRF_INVALID: '申诉复核会话校验失败，请重新打开邀请链接',
  APPEAL_RECEIPT_MISMATCH: '该邀请只能用于申诉回合绑定的那一份回执',
  INVALID_APPEAL_EVIDENCE: '授权披露的原复核证据不存在或不属于该字段',
  OPEN_WORKFLOW_EXISTS: '已有进行中的其他办理，请先完成或放弃后再处理申诉字段',
};
