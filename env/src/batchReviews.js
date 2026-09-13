import { STEPS } from './workflow.js';
import { maskReviewFieldValue } from './reviews.js';

// ---------------------------------------------------------------------------
// 多方复核批次（multi-party review batches）
//
// 办理人为同一份已签发回执创建一个复核批次：
//   - 2～5 个限时、一次性邀请，每个邀请有独立的可查看字段范围；
//   - 批次对每个纳入编排的字段配置接受阈值与驳回阈值；
//   - 批次必须等全部邀请完成一次性校验后才能进入复核（collecting → in_review）；
//   - 复核人只能针对本邀请被授权的字段提交意见；同一字段的多份意见合并展示，
//     但逐字保留每位复核人的原始说明；
//   - 办理人逐字段作出接受/驳回决议，决议必须满足批次配置的对应阈值；
//   - 被接受的字段意见全部进入同一份新的更正办理并关联全部意见。
// ---------------------------------------------------------------------------

export const BATCH_MIN_INVITATIONS = 2;
export const BATCH_MAX_INVITATIONS = 5;
export const BATCH_LABEL_MAX = 60;
export const BATCH_NOTE_MAX = 200;
export const BATCH_INVITATION_LABEL_MAX = 60;
export const BATCH_OPINION_MIN = 2;
export const BATCH_OPINION_MAX = 500;
export const BATCH_REJECT_REASON_MAX = 200;
export const BATCH_SESSION_COOKIE = 'bid';
export const BATCH_CSRF_COOKIE = 'bcsrf';

// 分阶段编排：阶段数量上限、阶段名称长度、超时策略三选一
export const BATCH_MAX_STAGES = 5;
export const BATCH_STAGE_NAME_MAX = 60;
export const BATCH_STAGE_TIMEOUT_POLICIES = ['advance', 'revoke_unused', 'fail'];
export const BATCH_TIMEOUT_AUTO_REJECT_REASON = '阶段限时到达：未在时限内决议，系统按冻结策略自动驳回'

// 全部可被纳入批次编排的字段（step.field），顺序固定：按步骤与字段定义
export const ALL_BATCH_FIELDS = STEPS.flatMap((definition, step) =>
  Object.keys(definition.fields).map((field) => ({ step, field, label: definition.fields[field].label })));

export function batchFieldKey(step, field) {
  return `${step}.${field}`;
}

export function parseBatchFieldKey(key) {
  const m = /^(\d+)\.([A-Za-z][A-Za-z0-9_]*)$/.exec(String(key || ''));
  if (!m) return null;
  const step = Number(m[1]);
  const field = m[2];
  if (!STEPS[step] || !Object.prototype.hasOwnProperty.call(STEPS[step].fields, field)) return null;
  return { step, field };
}

function parseThreshold(value, maxInvites) {
  if (!Number.isInteger(value)) return { error: '阈值必须是 1 到邀请数之间的整数' };
  if (value < 1 || value > maxInvites) return { error: `阈值必须在 1 到 ${maxInvites} 之间` };
  return { value };
}

// 解析并严格校验创建批次请求；返回归一化后的配置（不接触数据库）。
//
// 输入形态：
// {
//   receiptNo, note, ttlMinutes,
//   fields: [{ key: '0.phone', acceptThreshold: 2, rejectThreshold: 1 }],
//   invitations: [{ label: '财务复核', fields: ['0.phone', '1.detail'] }, ...2-5 个]
// }
export function parseBatchCreateInput(input, { minMinutes, maxMinutes }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: { code: 'INVALID_BATCH', message: '批次配置格式不正确' } };
  }
  const note = String(input.note || '').trim().slice(0, BATCH_NOTE_MAX);

  const ttlMinutes = Number(input.ttlMinutes);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < minMinutes || ttlMinutes > maxMinutes) {
    return { error: { code: 'INVALID_TTL', message: `邀请有效期需在 ${minMinutes} 分钟到 ${maxMinutes} 分钟之间` } };
  }

  const rawInvitations = input.invitations;
  if (!Array.isArray(rawInvitations)
    || rawInvitations.length < BATCH_MIN_INVITATIONS
    || rawInvitations.length > BATCH_MAX_INVITATIONS) {
    return {
      error: {
        code: 'INVALID_BATCH_INVITATIONS',
        message: `复核批次必须指定 ${BATCH_MIN_INVITATIONS}-${BATCH_MAX_INVITATIONS} 个邀请`,
      },
    };
  }

  const rawFields = input.fields;
  if (!Array.isArray(rawFields) || rawFields.length === 0) {
    return { error: { code: 'INVALID_BATCH_FIELDS', message: '批次至少需要编排一个字段' } };
  }

  const fieldMap = new Map();
  for (const item of rawFields) {
    if (!item || typeof item !== 'object') {
      return { error: { code: 'INVALID_BATCH_FIELDS', message: '字段配置格式不正确' } };
    }
    const parsedKey = parseBatchFieldKey(item.key);
    if (!parsedKey) {
      return { error: { code: 'INVALID_BATCH_FIELD', message: `未知字段：${item.key}` } };
    }
    const key = batchFieldKey(parsedKey.step, parsedKey.field);
    if (fieldMap.has(key)) {
      return { error: { code: 'INVALID_BATCH_FIELD', message: `字段重复配置：${key}` } };
    }
    const accept = parseThreshold(item.acceptThreshold, rawInvitations.length);
    if (accept.error) {
      return { error: { code: 'INVALID_ACCEPT_THRESHOLD', message: `字段 ${key} 的接受阈值无效：${accept.error}` } };
    }
    const reject = parseThreshold(item.rejectThreshold, rawInvitations.length);
    if (reject.error) {
      return { error: { code: 'INVALID_REJECT_THRESHOLD', message: `字段 ${key} 的驳回阈值无效：${reject.error}` } };
    }
    fieldMap.set(key, {
      ...parsedKey,
      key,
      acceptThreshold: accept.value,
      rejectThreshold: reject.value,
    });
  }

  const invitations = [];
  const labels = new Set();
  for (let index = 0; index < rawInvitations.length; index += 1) {
    const raw = rawInvitations[index];
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fields)) {
      return { error: { code: 'INVALID_BATCH_INVITATIONS', message: `第 ${index + 1} 个邀请的字段授权格式不正确` } };
    }
    const label = String(raw.label || `复核人 ${index + 1}`).trim().slice(0, BATCH_LABEL_MAX);
    if (!label) {
      return { error: { code: 'INVALID_BATCH_INVITATIONS', message: `第 ${index + 1} 个邀请缺少名称` } };
    }
    if (labels.has(label)) {
      return { error: { code: 'INVALID_BATCH_INVITATIONS', message: `邀请名称不能重复：${label}` } };
    }
    labels.add(label);
    if (raw.fields.length === 0) {
      return { error: { code: 'INVALID_BATCH_FIELD_SCOPE', message: `邀请「${label}」至少需要授权一个字段` } };
    }
    const scopeKeys = [];
    const seen = new Set();
    for (const rawKey of raw.fields) {
      const parsedKey = parseBatchFieldKey(rawKey);
      if (!parsedKey) {
        return { error: { code: 'INVALID_BATCH_FIELD_SCOPE', message: `邀请「${label}」包含未知字段：${rawKey}` } };
      }
      const key = batchFieldKey(parsedKey.step, parsedKey.field);
      // 每个邀请可查看的字段范围必须是批次编排字段的子集：不允许看到无法被决议的字段
      if (!fieldMap.has(key)) {
        return { error: { code: 'INVALID_BATCH_FIELD_SCOPE', message: `邀请「${label}」授权的字段 ${key} 未纳入批次编排` } };
      }
      if (seen.has(key)) {
        return { error: { code: 'INVALID_BATCH_FIELD_SCOPE', message: `邀请「${label}」的字段授权重复：${key}` } };
      }
      seen.add(key);
      scopeKeys.push(key);
    }
    invitations.push({ label, scopeKeys });
  }

  // 每个被编排字段至少要被一个邀请授权，否则该字段永远不可能收集到意见
  for (const [key, field] of fieldMap) {
    if (!invitations.some((invite) => invite.scopeKeys.includes(key))) {
      return { error: { code: 'INVALID_BATCH_FIELD', message: `字段 ${key}（${field.label}）没有任何邀请获得授权` } };
    }
  }

  return {
    value: {
      note,
      ttlMinutes,
      fields: [...fieldMap.values()],
      invitations,
    },
  };
}

// ---------------------------------------------------------------------------
// 分阶段编排的解析与严格校验（不接触数据库）。
//
// 输入形态（stages 非空即按分阶段批次创建）：
// {
//   receiptNo, note,
//   stages: [{
//     name: '第一阶段·基础信息',
//     ttlMinutes: 30,                       // 本阶段限时；阶段开始后才起算倒计时
//     timeoutPolicy: 'advance' | 'revoke_unused' | 'fail',   // 阶段开始时冻结，三选一
//     fields: [{ key: '0.phone', acceptThreshold: 1, rejectThreshold: 1 }],
//     invitations: [{ label: '财务复核', fields: ['0.phone'] }],
//   }, ...2-5 个按顺序执行的阶段]
// }
//
// 规则：
//   - 每阶段 1-5 个邀请，整个批次邀请总数 2-5；
//   - 邀请名称在整个批次内唯一；
//   - 每阶段至少编排一个字段；字段在整个批次内不允许跨阶段重复；
//   - 阈值 1..本阶段邀请数；每阶段字段至少被本阶段一个邀请授权；
//   - 邀请字段授权必须是“本阶段编排字段”的子集；
//   - 全部纳入编排的字段必须被至少一个邀请授权。
// ---------------------------------------------------------------------------
function parseStagedInput(input, { minMinutes, maxMinutes }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: { code: 'INVALID_BATCH', message: '批次配置格式不正确' } };
  }
  const note = String(input.note || '').trim().slice(0, BATCH_NOTE_MAX);
  const rawStages = input.stages;
  if (!Array.isArray(rawStages) || rawStages.length === 0 || rawStages.length > BATCH_MAX_STAGES) {
    return { error: { code: 'INVALID_BATCH_STAGES', message: `分阶段批次必须指定 1-${BATCH_MAX_STAGES} 个阶段` } };
  }

  const stages = [];
  const allFieldKeys = new Set();
  const allLabels = new Set();
  let totalInvitations = 0;

  for (let s = 0; s < rawStages.length; s += 1) {
    const rawStage = rawStages[s];
    const stageLabel = `第 ${s + 1} 阶段`;
    if (!rawStage || typeof rawStage !== 'object') {
      return { error: { code: 'INVALID_BATCH_STAGES', message: `${stageLabel}配置格式不正确` } };
    }
    const name = String(rawStage.name || stageLabel).trim().slice(0, BATCH_STAGE_NAME_MAX) || stageLabel;

    const ttlMinutes = Number(rawStage.ttlMinutes);
    if (!Number.isInteger(ttlMinutes) || ttlMinutes < minMinutes || ttlMinutes > maxMinutes) {
      return { error: { code: 'INVALID_TTL', message: `${stageLabel}有效期需在 ${minMinutes} 分钟到 ${maxMinutes} 分钟之间` } };
    }
    const timeoutPolicy = String(rawStage.timeoutPolicy || 'advance');
    if (!BATCH_STAGE_TIMEOUT_POLICIES.includes(timeoutPolicy)) {
      return {
        error: {
          code: 'INVALID_STAGE_TIMEOUT_POLICY',
          message: `${stageLabel}的超时策略必须是 ${BATCH_STAGE_TIMEOUT_POLICIES.join(' / ')} 之一`,
        },
      };
    }

    const rawInvitations = rawStage.invitations;
    if (!Array.isArray(rawInvitations) || rawInvitations.length < 1 || rawInvitations.length > BATCH_MAX_INVITATIONS) {
      return {
        error: {
          code: 'INVALID_BATCH_INVITATIONS',
          message: `${stageLabel}必须指定 1-${BATCH_MAX_INVITATIONS} 个邀请`,
        },
      };
    }
    totalInvitations += rawInvitations.length;
    if (totalInvitations > BATCH_MAX_INVITATIONS) {
      return {
        error: {
          code: 'INVALID_BATCH_INVITATIONS',
          message: `整个批次最多 ${BATCH_MAX_INVITATIONS} 个邀请（当前 ${totalInvitations} 个）`,
        },
      };
    }

    const rawFields = rawStage.fields;
    if (!Array.isArray(rawFields) || rawFields.length === 0) {
      return { error: { code: 'INVALID_BATCH_FIELDS', message: `${stageLabel}至少需要编排一个字段` } };
    }

    const fieldMap = new Map();
    for (const item of rawFields) {
      if (!item || typeof item !== 'object') {
        return { error: { code: 'INVALID_BATCH_FIELDS', message: `${stageLabel}字段配置格式不正确` } };
      }
      const parsedKey = parseBatchFieldKey(item.key);
      if (!parsedKey) return { error: { code: 'INVALID_BATCH_FIELD', message: `未知字段：${item.key}` } };
      const key = batchFieldKey(parsedKey.step, parsedKey.field);
      if (allFieldKeys.has(key)) {
        return { error: { code: 'INVALID_BATCH_FIELD', message: `字段 ${key} 不能在多个阶段重复编排` } };
      }
      if (fieldMap.has(key)) {
        return { error: { code: 'INVALID_BATCH_FIELD', message: `${stageLabel}字段重复配置：${key}` } };
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
    for (let i = 0; i < rawInvitations.length; i += 1) {
      const raw = rawInvitations[i];
      if (!raw || typeof raw !== 'object' || !Array.isArray(raw.fields)) {
        return { error: { code: 'INVALID_BATCH_INVITATIONS', message: `${stageLabel}第 ${i + 1} 个邀请的字段授权格式不正确` } };
      }
      const label = String(raw.label || `${stageLabel}-复核人${i + 1}`).trim().slice(0, BATCH_INVITATION_LABEL_MAX);
      if (!label) return { error: { code: 'INVALID_BATCH_INVITATIONS', message: `${stageLabel}第 ${i + 1} 个邀请缺少名称` } };
      if (allLabels.has(label)) return { error: { code: 'INVALID_BATCH_INVITATIONS', message: `邀请名称在批次内不能重复：${label}` } };
      allLabels.add(label);
      if (raw.fields.length === 0) {
        return { error: { code: 'INVALID_BATCH_FIELD_SCOPE', message: `邀请「${label}」至少需要授权一个字段` } };
      }
      const scopeKeys = [];
      const seen = new Set();
      for (const rawKey of raw.fields) {
        const parsedKey = parseBatchFieldKey(rawKey);
        if (!parsedKey) return { error: { code: 'INVALID_BATCH_FIELD_SCOPE', message: `邀请「${label}」包含未知字段：${rawKey}` } };
        const key = batchFieldKey(parsedKey.step, parsedKey.field);
        if (!fieldMap.has(key)) {
          return { error: { code: 'INVALID_BATCH_FIELD_SCOPE', message: `邀请「${label}」授权的 ${key} 不属于${stageLabel}编排字段` } };
        }
        if (seen.has(key)) {
          return { error: { code: 'INVALID_BATCH_FIELD_SCOPE', message: `邀请「${label}」的字段授权重复：${key}` } };
        }
        seen.add(key);
        scopeKeys.push(key);
      }
      invitations.push({ label, scopeKeys });
    }

    for (const [key] of fieldMap) {
      if (!invitations.some((invite) => invite.scopeKeys.includes(key))) {
        return { error: { code: 'INVALID_BATCH_FIELD', message: `${stageLabel}字段 ${key} 没有任何邀请获得授权` } };
      }
      allFieldKeys.add(key);
    }

    stages.push({ name, ttlMinutes, timeoutPolicy, fields: [...fieldMap.values()], invitations });
  }

  if (totalInvitations < BATCH_MIN_INVITATIONS) {
    return { error: { code: 'INVALID_BATCH_INVITATIONS', message: `整个批次至少需要 ${BATCH_MIN_INVITATIONS} 个邀请（当前 ${totalInvitations} 个）` } };
  }

  return {
    value: {
      kind: 'staged',
      note,
      stages,
      totalInvitations,
      // 供平面存储列兼容使用
      ttlMinutes: Math.max(...stages.map((stage) => stage.ttlMinutes)),
    },
  };
}

// 统一入口：stages 非空走分阶段解析，否则走原平面批次解析
export function parseBatchInput(input, bounds) {
  if (input && Array.isArray(input.stages)) return parseStagedInput(input, bounds);
  return parseBatchCreateInput(input, bounds);
}

// 复核人侧脱敏视图：只保留被授权的字段；按步骤分组，未授权字段整列不出现。
// 敏感字段与普通复核一样在服务端完成遮罩，原始值不下发。
export function buildBatchReviewView(snapshot, authorizedKeys) {
  const allow = new Set(authorizedKeys);
  return {
    completedAt: snapshot.completedAt || null,
    sequence: snapshot.sequence,
    steps: STEPS.map((definition, step) => {
      const data = snapshot.steps?.[step]?.data || {};
      const fields = Object.entries(definition.fields)
        .map(([field, rule]) => ({ field, rule, step }))
        .filter(({ field, step: s }) => allow.has(batchFieldKey(s, field)))
        .map(({ field, rule }) => {
          const display = maskReviewFieldValue(field, data[field]);
          return {
            step,
            key: batchFieldKey(step, field),
            field,
            label: rule.label,
            value: display.value,
            kind: display.kind,
            masked: Boolean(display.masked),
          };
        });
      return { step, key: definition.key, title: definition.title, fields };
    }).filter((step) => step.fields.length > 0),
  };
}

export function batchFieldLabel(step, field) {
  return STEPS[step]?.fields?.[field]?.label || field;
}

// 提交时记录的脱敏字段值快照（与普通复核一致，不含原值）
export function batchFieldTextValue(snapshot, step, field) {
  const raw = snapshot.steps?.[step]?.data?.[field];
  const display = maskReviewFieldValue(field, raw);
  if (display.kind === 'boolean') return display.value ? '已勾选确认' : '未勾选';
  return display.value;
}

export const BATCH_ERRORS = {
  BATCH_NOT_FOUND: '复核批次不存在或已不可用',
  BATCH_NOT_ACTIVE: '复核批次当前状态不允许该操作',
  BATCH_GATE_NOT_SATISFIED: '前一阶段尚未达到终局条件，后续阶段不能校验、查看或提交意见',
  BATCH_INVITATION_NOT_FOUND: '批次邀请不存在或链接不正确',
  BATCH_INVITATION_EXPIRED: '该批次邀请已超过有效期限，链接失效',
  BATCH_INVITATION_REVOKED: '该批次邀请已被办理人撤销，链接失效',
  BATCH_INVITATION_ALREADY_USED: '该批次邀请链接只能使用一次，已完成过校验',
  BATCH_FIELD_NOT_AUTHORIZED: '本邀请未被授权查看该字段，不能针对它提交意见',
  BATCH_FIELD_DUPLICATE_OPINION: '你已就该字段提交过意见，不能重复提交',
  BATCH_FIELD_NOT_FOUND: '字段不存在或未纳入本批次编排',
  BATCH_FIELD_ALREADY_DECIDED: '该字段已有最终决议，重复决议被拒绝，返回同一结果',
  BATCH_FIELD_UNDECIDABLE: '该字段尚不能作出该决议（邀请未全部校验或尚无意见）',
  ACCEPT_THRESHOLD_NOT_MET: '支持接受的意见数未达到阶段配置的接受阈值，不能接受该字段',
  REJECT_THRESHOLD_NOT_MET: '支持驳回的意见数未满足阶段配置的驳回阈值，不能驳回该字段',
  BATCH_SESSION_REQUIRED: '请先完成批次邀请校验',
  BATCH_CSRF_INVALID: '批次复核会话校验失败，请重新打开邀请链接',
  BATCH_RECEIPT_MISMATCH: '该邀请只能用于指定批次绑定的那一份回执',
  OPEN_WORKFLOW_EXISTS: '已有进行中的其他办理，请先完成或放弃后再处理批次字段',
  // 分阶段编排
  INVALID_BATCH_STAGES: '分阶段编排配置无效',
  INVALID_STAGE_TIMEOUT_POLICY: '阶段超时策略必须是自动转入下一阶段 / 撤销未使用邀请 / 标记超时失败之一',
  BATCH_STAGE_NOT_FOUND: '阶段不存在或不属于本批次',
  BATCH_STAGE_NOT_STARTED: '该阶段尚未开始：前一阶段未达到终局条件前不能校验、查看或提交意见',
  BATCH_STAGE_NOT_CURRENT: '只能在当前进行中的阶段提交意见或作出决议',
  BATCH_STAGE_DEADLINE_PASSED: '该阶段限时已过，正在按阶段开始时冻结的超时策略处理',
  BATCH_STAGE_TIMED_OUT: '批次已因阶段超时失败而终止，不能再进行任何复核操作',
  BATCH_CONFIG_VERSION_CONFLICT: '编排已被另一个页面修改并产生新版本，请刷新后基于最新版本重新编辑',
  BATCH_CONFIG_LOCKED: '阶段已开始，其配置已冻结，不能再修改',
  BATCH_TIMEOUT_ALREADY_FIRED: '该阶段超时已按冻结策略处理过一次，重复触发不会产生第二次结果',
};
