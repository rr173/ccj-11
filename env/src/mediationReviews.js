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
// 争议调解包（dispute mediation packages）
//
// 办理人从【已完成或已驳回的申诉回合】中选择字段生成只读调解包：冻结原批次决议、
// 申诉意见、授权证据摘要与当前更正来源。调解包按顺序执行两个处理层级：
//   - 第一层 mediation（2-5 名新调解人独立意见）；
//   - 第二层 arbitration（3-5 名仲裁人），仅当第一层达到创建时配置并冻结的
//     升级条件（第一层被驳回字段数 ≥ escalateRejectedCount）后，
//     才按第一层结束时的冻结快照开放。
// 调解包一旦生成，原批次/申诉回合历史不能被改写，未选中字段与未授权证据
// 一律不进入调解包。
// ---------------------------------------------------------------------------

export const MEDIATION_MIN_LAYER1 = 2;
export const MEDIATION_MAX_LAYER1 = 5;
export const MEDIATION_MIN_LAYER2 = 3;
export const MEDIATION_MAX_LAYER2 = 5;
export const MEDIATION_LABEL_MAX = 60;
export const MEDIATION_NOTE_MAX = 200;
export const MEDIATION_OPINION_MIN = BATCH_OPINION_MIN;
export const MEDIATION_OPINION_MAX = BATCH_OPINION_MAX;
export const MEDIATION_REJECT_REASON_MAX = BATCH_REJECT_REASON_MAX;
export const MEDIATION_SESSION_COOKIE = 'mid';
export const MEDIATION_CSRF_COOKIE = 'mcsrf';
export const ARBITRATION_SESSION_COOKIE = 'arb';
export const ARBITRATION_CSRF_COOKIE = 'accsrf2';
export { BATCH_MIN_INVITATIONS, BATCH_MAX_INVITATIONS };

// 两层各自三选一的超时策略（层级开始时冻结）：
//  第一层：escalate  按冻结快照升级到第二层（未决字段系统自动驳回，留档）
//          revoke_unused 撤销未使用邀请，办理人仍须用已收集意见完成决议后才判定升级
//          fail 调解包超时失败，终态锁定
//  第二层：complete   未决字段系统自动驳回，调解包完成
//          revoke_unused 撤销未使用邀请，办理人仍须决议剩余字段
//          fail 调解包超时失败
export const MEDIATION_LAYER1_TIMEOUT_POLICIES = ['escalate', 'revoke_unused', 'fail'];
export const MEDIATION_LAYER2_TIMEOUT_POLICIES = ['complete', 'revoke_unused', 'fail'];
export const MEDIATION_TIMEOUT_AUTO_REJECT_REASON = '层级限时到达：未在时限内决议，系统按冻结策略自动驳回';

export function mediationFieldLabel(step, field) {
  return batchFieldLabel(step, field);
}

function parseThreshold(value, maxInvites) {
  if (!Number.isInteger(value)) return { error: '阈值必须是 1 到邀请数之间的整数' };
  if (value < 1 || value > maxInvites) return { error: `阈值必须在 1 到 ${maxInvites} 之间` };
  return { value };
}

// ---------------------------------------------------------------------------
// 调解包创建请求的解析与严格校验（不接触数据库）。
//
// 输入形态：
// {
//   roundId, note,
//   fields: [{ key: '0.phone', evidenceOpinionIds: ['申诉意见 id', ...] }],  // 选中字段；证据白名单可空
//   layer1: {
//     ttlMinutes, timeoutPolicy: 'escalate'|'revoke_unused'|'fail',
//     escalateRejectedCount: 1,            // 第一层驳回字段达到该数才开放第二层（1..第一层字段数）
//     fields: [{ key, acceptThreshold, rejectThreshold }],
//     invitations: [{ label, fields: ['0.phone'] }, ...2-5 个],
//   },
//   layer2: {
//     ttlMinutes, timeoutPolicy: 'complete'|'revoke_unused'|'fail',
//     fields: [{ key, acceptThreshold, rejectThreshold }],                    // 必须是第一层字段子集
//     invitations: [{ label, fields: ['0.phone'] }, ...3-5 个],
//   },
// }
// ---------------------------------------------------------------------------
export function parseMediationCreateInput(input, { minMinutes, maxMinutes }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: { code: 'INVALID_MEDIATION', message: '调解包配置格式不正确' } };
  }
  const roundId = String(input.roundId || '');
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(roundId)) {
    return { error: { code: 'INVALID_MEDIATION', message: '申诉回合标识不正确' } };
  }
  const note = String(input.note || '').trim().slice(0, MEDIATION_NOTE_MAX);

  const rawFields = input.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    return { error: { code: 'INVALID_MEDIATION_FIELDS', message: '调解包至少需要选择一个字段' } };
  }
  const packageFields = new Map();
  for (const item of rawFields) {
    if (!item || typeof item !== 'object') {
      return { error: { code: 'INVALID_MEDIATION_FIELDS', message: '调解字段配置格式不正确' } };
    }
    const parsedKey = parseBatchFieldKey(item.key);
    if (!parsedKey) return { error: { code: 'INVALID_MEDIATION_FIELD', message: `未知字段：${item.key}` } };
    const key = batchFieldKey(parsedKey.step, parsedKey.field);
    if (packageFields.has(key)) {
      return { error: { code: 'INVALID_MEDIATION_FIELD', message: `字段重复选择：${key}` } };
    }
    let evidenceOpinionIds = [];
    if (item.evidenceOpinionIds !== undefined && item.evidenceOpinionIds !== null) {
      if (!Array.isArray(item.evidenceOpinionIds)) {
        return { error: { code: 'INVALID_MEDIATION_EVIDENCE', message: `字段 ${key} 的证据授权格式不正确` } };
      }
      const seen = new Set();
      for (const id of item.evidenceOpinionIds) {
        const text = String(id || '');
        if (!/^[A-Za-z0-9_-]{8,200}$/.test(text)) {
          return { error: { code: 'INVALID_MEDIATION_EVIDENCE', message: `字段 ${key} 的证据授权包含无效条目` } };
        }
        if (seen.has(text)) {
          return { error: { code: 'INVALID_MEDIATION_EVIDENCE', message: `字段 ${key} 的证据授权重复` } };
        }
        seen.add(text);
        evidenceOpinionIds.push(text);
      }
    }
    packageFields.set(key, { ...parsedKey, key, evidenceOpinionIds });
  }

  const layer1 = parseLayerInput(input.layer1, {
    name: '第一层（调解）',
    minInvitations: MEDIATION_MIN_LAYER1,
    maxInvitations: MEDIATION_MAX_LAYER1,
    policies: MEDIATION_LAYER1_TIMEOUT_POLICIES,
    packageFields,
    minMinutes,
    maxMinutes,
    requireSubsetOfPackage: true,
    codePrefix: 'L1',
  });
  if (layer1.error) return { error: layer1.error };

  // 升级条件：第一层驳回字段达到该数才开放第二层（创建时配置，层级启动后冻结）
  const escalateRejectedCount = Number(input.layer1.escalateRejectedCount);
  if (!Number.isInteger(escalateRejectedCount)
    || escalateRejectedCount < 1 || escalateRejectedCount > layer1.value.fields.length) {
    return {
      error: {
        code: 'INVALID_MEDIATION_ESCALATION',
        message: `第一层升级条件需为 1 到 ${layer1.value.fields.length}（第一层字段数）之间的整数`,
      },
    };
  }
  layer1.value.escalateRejectedCount = escalateRejectedCount;

  const layer2 = parseLayerInput(input.layer2, {
    name: '第二层（仲裁）',
    minInvitations: MEDIATION_MIN_LAYER2,
    maxInvitations: MEDIATION_MAX_LAYER2,
    policies: MEDIATION_LAYER2_TIMEOUT_POLICIES,
    packageFields,
    minMinutes,
    maxMinutes,
    requireSubsetOfPackage: true,
    codePrefix: 'L2',
  });
  if (layer2.error) return { error: layer2.error };

  // 第二层字段必须是第一层字段子集：第一层未独立处理的字段不能交给仲裁
  const layer1Keys = new Set(layer1.value.fields.map((field) => field.key));
  for (const field of layer2.value.fields) {
    if (!layer1Keys.has(field.key)) {
      return {
        error: {
          code: 'INVALID_MEDIATION_LAYER2_SCOPE',
          message: `第二层字段 ${field.key} 不在第一层字段范围内，仲裁只能针对第一层处理过的字段`,
        },
      };
    }
  }

  // 调解包选中字段必须至少被第一层覆盖（第二层字段已证明是第一层子集）
  for (const key of packageFields.keys()) {
    if (!layer1Keys.has(key)) {
      return { error: { code: 'INVALID_MEDIATION_FIELDS', message: `选中字段 ${key} 未纳入第一层范围` } };
    }
  }

  return {
    value: {
      roundId,
      note,
      fields: [...packageFields.values()],
      layer1: layer1.value,
      layer2: layer2.value,
    },
  };
}

function parseLayerInput(rawLayer, options) {
  const {
    name, minInvitations, maxInvitations, policies, packageFields,
    minMinutes, maxMinutes, codePrefix,
  } = options;
  if (!rawLayer || typeof rawLayer !== 'object' || Array.isArray(rawLayer)) {
    return { error: { code: `INVALID_MEDIATION_${codePrefix}`, message: `${name}配置格式不正确` } };
  }
  const ttlMinutes = Number(rawLayer.ttlMinutes);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < minMinutes || ttlMinutes > maxMinutes) {
    return { error: { code: 'INVALID_TTL', message: `${name}限时需在 ${minMinutes} 分钟到 ${maxMinutes} 分钟之间` } };
  }
  const timeoutPolicy = String(rawLayer.timeoutPolicy || '');
  if (!policies.includes(timeoutPolicy)) {
    return {
      error: {
        code: 'INVALID_MEDIATION_TIMEOUT_POLICY',
        message: `${name}超时策略必须是 ${policies.join(' / ')} 之一`,
      },
    };
  }
  const rawInvitations = rawLayer.invitations;
  if (!Array.isArray(rawInvitations)
    || rawInvitations.length < minInvitations || rawInvitations.length > maxInvitations) {
    return {
      error: {
        code: `INVALID_MEDIATION_${codePrefix}_INVITATIONS`,
        message: `${name}必须指定 ${minInvitations}-${maxInvitations} 个一次性邀请`,
      },
    };
  }
  const rawFields = rawLayer.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    return { error: { code: `INVALID_MEDIATION_${codePrefix}_FIELDS`, message: `${name}至少需要编排一个字段` } };
  }
  const fieldMap = new Map();
  for (const item of rawFields) {
    if (!item || typeof item !== 'object') {
      return { error: { code: `INVALID_MEDIATION_${codePrefix}_FIELDS`, message: `${name}字段配置格式不正确` } };
    }
    const parsedKey = parseBatchFieldKey(item.key);
    if (!parsedKey) return { error: { code: 'INVALID_MEDIATION_FIELD', message: `未知字段：${item.key}` } };
    const key = batchFieldKey(parsedKey.step, parsedKey.field);
    if (fieldMap.has(key)) {
      return { error: { code: 'INVALID_MEDIATION_FIELD', message: `${name}字段重复：${key}` } };
    }
    if (!packageFields.has(key)) {
      return { error: { code: 'INVALID_MEDIATION_FIELD_SCOPE', message: `${name}字段 ${key} 不在调解包选中字段中` } };
    }
    const accept = parseThreshold(item.acceptThreshold, rawInvitations.length);
    if (accept.error) {
      return { error: { code: 'INVALID_ACCEPT_THRESHOLD', message: `字段 ${key} 的接受阈值无效：${accept.error}` } };
    }
    const reject = parseThreshold(item.rejectThreshold, rawInvitations.length);
    if (reject.error) {
      return { error: { code: 'INVALID_REJECT_THRESHOLD', message: `字段 ${key} 的驳回阈值无效：${reject.error}` } };
    }
    fieldMap.set(key, { ...parsedKey, key, acceptThreshold: accept.value, rejectThreshold: reject.value });
  }

  const invitations = [];
  const labels = new Set();
  for (let index = 0; index < rawInvitations.length; index += 1) {
    const raw = rawInvitations[index];
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fields)) {
      return { error: { code: `INVALID_MEDIATION_${codePrefix}_INVITATIONS`, message: `${name}第 ${index + 1} 个邀请的字段授权格式不正确` } };
    }
    const label = String(raw.label || `${name}人 ${index + 1}`).trim().slice(0, MEDIATION_LABEL_MAX);
    if (!label) return { error: { code: `INVALID_MEDIATION_${codePrefix}_INVITATIONS`, message: `${name}第 ${index + 1} 个邀请缺少名称` } };
    if (labels.has(label)) {
      return { error: { code: `INVALID_MEDIATION_${codePrefix}_INVITATIONS`, message: `邀请名称不能重复：${label}` } };
    }
    labels.add(label);
    if (raw.fields.length === 0) {
      return { error: { code: 'INVALID_MEDIATION_FIELD_SCOPE', message: `邀请「${label}」至少需要授权一个字段` } };
    }
    const scopeKeys = [];
    const seen = new Set();
    for (const rawKey of raw.fields) {
      const parsedKey = parseBatchFieldKey(rawKey);
      if (!parsedKey) return { error: { code: 'INVALID_MEDIATION_FIELD_SCOPE', message: `邀请「${label}」包含未知字段：${rawKey}` } };
      const key = batchFieldKey(parsedKey.step, parsedKey.field);
      if (!fieldMap.has(key)) {
        return { error: { code: 'INVALID_MEDIATION_FIELD_SCOPE', message: `邀请「${label}」授权的 ${key} 不属于${name}字段范围` } };
      }
      if (seen.has(key)) {
        return { error: { code: 'INVALID_MEDIATION_FIELD_SCOPE', message: `邀请「${label}」字段授权重复：${key}` } };
      }
      seen.add(key);
      scopeKeys.push(key);
    }
    invitations.push({ label, scopeKeys });
  }
  for (const [key] of fieldMap) {
    if (!invitations.some((invite) => invite.scopeKeys.includes(key))) {
      return { error: { code: `INVALID_MEDIATION_${codePrefix}_FIELDS`, message: `字段 ${key} 没有任何邀请获得授权` } };
    }
  }
  return {
    value: {
      ttlMinutes,
      ttlMs: ttlMinutes * 60000,
      timeoutPolicy,
      fields: [...fieldMap.values()],
      invitations,
    },
  };
}

// 调解人/仲裁人侧脱敏视图：复用批次复核视图，只保留本层授权字段（敏感字段服务端遮罩）。
export function buildMediationReviewView(snapshot, authorizedKeys) {
  return buildBatchReviewView(snapshot, authorizedKeys);
}

export const MEDIATION_ERRORS = {
  MEDIATION_NOT_FOUND: '调解包不存在或已不可用',
  MEDIATION_NOT_ACTIVE: '调解包当前状态不允许该操作',
  MEDIATION_ALREADY_OPEN: '该申诉回合已存在一个进行中的调解包，请先完成或取消',
  MEDIATION_SOURCE_NOT_FROZEN: '只能为已完成全部字段决议的申诉回合生成调解包',
  MEDIATION_FIELD_NOT_REJECTED: '调解包只能选择申诉回合中已被驳回的字段',
  MEDIATION_FIELD_DUPLICATE: '该字段已存在进行中的调解包',
  MEDIATION_HAS_DECISIONS: '调解包已有字段终局决议，历史不能删除，不能取消',
  MEDIATION_DEADLINE_PASSED: '调解包层级限时已过，写操作已关闭',
  MEDIATION_PACKAGE_CANCELLED: '调解包已取消，写操作已关闭',
  MEDIATION_PACKAGE_TIMED_OUT: '调解包已超时失败，写操作已关闭',
  MEDIATION_FIELD_NOT_FOUND: '调解字段不存在或不属于本层',
  MEDIATION_FIELD_ALREADY_DECIDED: '该字段已有最终决议，重复决议返回同一结果',
  MEDIATION_FIELD_DUPLICATE_OPINION: '你已就该字段提交过意见，不能重复提交',
  MEDIATION_FIELD_NOT_AUTHORIZED: '本邀请未被授权查看该字段，不能针对它提交意见',
  MEDIATION_INVITATION_NOT_FOUND: '调解邀请不存在或链接不正确',
  MEDIATION_INVITATION_EXPIRED: '该调解邀请已超过有效期限，链接失效',
  MEDIATION_INVITATION_REVOKED: '该调解邀请已被办理人撤销或调解包已取消，链接失效',
  MEDIATION_INVITATION_ALREADY_USED: '该调解邀请链接只能使用一次，已完成过校验',
  MEDIATION_SESSION_REQUIRED: '请先完成调解邀请校验',
  MEDIATION_CSRF_INVALID: '调解会话校验失败，请重新打开邀请链接',
  MEDIATION_RECEIPT_MISMATCH: '该邀请只能用于调解包绑定的那一份回执',
  ARBITRATION_NOT_FOUND: '仲裁邀请不存在或链接不正确',
  ARBITRATION_INVITATION_EXPIRED: '该仲裁邀请已超过有效期限，链接失效',
  ARBITRATION_INVITATION_REVOKED: '该仲裁邀请已被办理人撤销或调解包已取消，链接失效',
  ARBITRATION_INVITATION_ALREADY_USED: '该仲裁邀请链接只能使用一次，已完成过校验',
  ARBITRATION_SESSION_REQUIRED: '请先完成仲裁邀请校验',
  ARBITRATION_CSRF_INVALID: '仲裁会话校验失败，请重新打开邀请链接',
  ARBITRATION_RECEIPT_MISMATCH: '该邀请只能用于调解包绑定的那一份回执',
  ARBITRATION_NOT_OPEN: '第一层尚未达到升级条件，第二层不能校验、查看或提交意见',
  ARBITRATION_FIELD_NOT_AUTHORIZED: '本仲裁邀请未被授权查看该字段，不能针对它提交意见',
  ARBITRATION_FIELD_DUPLICATE_OPINION: '你已就该字段提交过仲裁意见，不能重复提交',
  ARBITRATION_FIELD_ALREADY_DECIDED: '该仲裁字段已有最终决议，重复决议返回同一结果',
  INVALID_MEDIATION_EVIDENCE: '授权冻结的申诉证据不存在或不属于该字段',
  INVALID_MEDIATION_SNAPSHOT: '冻结快照不完整，不能生成第二层邀请',
  OPEN_WORKFLOW_EXISTS: '已有进行中的其他办理，请先完成或放弃后再处理调解字段',
  MEDIATION_CORRECTION_IN_PROGRESS: '该调解包已存在一份进行中的更正办理，不能再创建第二份',
  ACCEPT_THRESHOLD_NOT_MET: '支持接受的意见数未达到本层冻结的接受阈值，不能接受',
  REJECT_THRESHOLD_NOT_MET: '支持驳回的人数未满足本层冻结的驳回阈值，不能驳回',
};
