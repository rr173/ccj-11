// ---------------------------------------------------------------------------
// 案件组（case group）的纯配置解析与错误码
//
// 案件组把同一原批次下多个【已完成申诉回合】生成的调解包组成一个按冻结顺序
// 处理的协调单元：组级最少完成数（达到组级开放条件的成员数）、成员处理顺序、
// 组级超时策略（block_remaining / fail）与允许向仲裁人披露的跨包摘要。
// 本模块不接触数据库。
// ---------------------------------------------------------------------------

export const CASE_GROUP_NOTE_MAX = 200;
export const CASE_GROUP_MIN_MEMBERS = 1;
export const CASE_GROUP_MAX_MEMBERS = 5;
// 组级限时上下限（分钟），与复核邀请限时上下限一致
export const CASE_GROUP_TIMEOUT_POLICIES = ['block_remaining', 'fail'];

export const CASE_GROUP_ERRORS = {
  CASE_GROUP_NOT_FOUND: '案件组不存在或已不可用',
  CASE_GROUP_NOT_COLLECTING: '案件组已开始处理或已终结，不能再加入成员或修改配置',
  CASE_GROUP_NOT_PROCESSING: '案件组当前状态不允许启动处理',
  CASE_GROUP_ALREADY_STARTED: '同一案件组不能同时启动两次处理',
  CASE_GROUP_EMPTY: '案件组至少需要一个成员包才能开始处理',
  CASE_GROUP_MEMBER_NOT_FOUND: '调解包不属于该案件组',
  CASE_GROUP_MEMBER_LIMIT: `一个案件组最多 ${CASE_GROUP_MAX_MEMBERS} 个成员包`,
  CASE_PACKAGE_NOT_GROUPABLE: '只有同一原批次下、已完成申诉回合生成的进行中调解包才能加入案件组',
  CASE_PACKAGE_BATCH_MISMATCH: '调解包与案件组不属于同一原批次，冲突检查未通过，不能加入',
  CASE_PACKAGE_SOURCE_CONFLICT: '同一申诉回合生成的调解包不能重复进入同一案件组（申诉来源冲突）',
  CASE_PACKAGE_FIELD_CONFLICT: '调解包与案件组已有成员存在相同的申诉字段授权（字段冲突），不能加入',
  CASE_PACKAGE_CORRECTION_CONFLICT: '调解包已存在进行中的更正办理（当前更正冲突），不能加入',
  CASE_PACKAGE_STATUS_CONFLICT: '调解包当前状态不允许加入案件组（已有终局决议或非第一层处理中）',
  CASE_PACKAGE_ALREADY_IN_GROUP: '该调解包已经加入另一个未终结案件组，不能重复加入',
  CASE_PACKAGE_TIER2_OPEN: '调解包第二层仲裁已开放，不能再加入案件组',
  CASE_GROUP_ARBITRATION_NOT_OPEN: '该成员包尚未达到组级开放条件，第二层仲裁邀请必须继续拒绝',
  CASE_GROUP_ORDER_INVALID: '成员处理顺序必须包含且只包含案件组的全部成员包',
  CASE_GROUP_MIN_COMPLETIONS_INVALID: '组级最少完成数必须是 1 到成员数之间的整数',
  CASE_GROUP_TIMEOUT_POLICY_INVALID: `组级超时策略必须是 ${CASE_GROUP_TIMEOUT_POLICIES.join(' / ')} 之一`,
  CASE_GROUP_DISCLOSURE_INVALID: '允许披露的跨包摘要只能引用本案件组的成员包',
  CASE_GROUP_HAS_MEMBERS: '案件组已有成员包，不能在创建之外重复加入空锚点',
  CASE_GROUP_DEADLINE_PASSED: '案件组组级限时已过，正在按冻结策略处理',
};

function idList(value, { field }) {
  if (!Array.isArray(value)) return { error: `${field} 必须是数组` };
  const out = [];
  const seen = new Set();
  for (const item of value) {
    const text = String(item || '');
    if (!/^[A-Za-z0-9_-]{8,200}$/.test(text)) return { error: `${field} 包含无效标识` };
    if (seen.has(text)) return { error: `${field} 包含重复标识` };
    seen.add(text);
    out.push(text);
  }
  return { value: out };
}

// 创建案件组：anchorPackageId 为第一个成员（锚点，决定原批次）
export function parseCaseGroupCreateInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: { code: 'INVALID_CASE_GROUP', message: '案件组配置格式不正确' } };
  }
  const anchorPackageId = String(input.anchorPackageId || '');
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(anchorPackageId)) {
    return { error: { code: 'INVALID_CASE_GROUP', message: '锚点调解包标识不正确' } };
  }
  const note = String(input.note || '').trim().slice(0, CASE_GROUP_NOTE_MAX);
  return { value: { anchorPackageId, note } };
}

// 组级配置（开始处理前可反复保存；开始后冻结）：
// {
//   minCompletions: 2,                         // 组级最少完成数（达到开放条件的成员数）
//   memberOrder: [packageId, packageId, ...],  // 冻结处理顺序（必须是全部成员的一个排列）
//   timeoutPolicy: 'block_remaining' | 'fail', // 组级超时策略
//   ttlMinutes: 60,                            // 组级限时（开始处理时起算）
//   disclosedPackageIds: [packageId, ...],     // 允许披露的跨包摘要白名单（可空=不披露）
// }
export function parseCaseGroupConfigInput(input, { memberPackageIds, minMinutes, maxMinutes }) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { error: { code: 'INVALID_CASE_GROUP_CONFIG', message: '案件组配置格式不正确' } };
  }
  const memberCount = memberPackageIds.length;
  if (memberCount === 0) {
    return { error: { code: 'CASE_GROUP_EMPTY', message: CASE_GROUP_ERRORS.CASE_GROUP_EMPTY } };
  }
  const minCompletions = Number(input.minCompletions);
  if (!Number.isInteger(minCompletions) || minCompletions < 1 || minCompletions > memberCount) {
    return {
      error: {
        code: 'CASE_GROUP_MIN_COMPLETIONS_INVALID',
        message: CASE_GROUP_ERRORS.CASE_GROUP_MIN_COMPLETIONS_INVALID,
      },
    };
  }
  const order = idList(input.memberOrder, { field: 'memberOrder' });
  if (order.error) {
    return { error: { code: 'CASE_GROUP_ORDER_INVALID', message: order.error } };
  }
  const current = new Set(memberPackageIds);
  if (order.value.length !== memberCount || !order.value.every((id) => current.has(id))) {
    return { error: { code: 'CASE_GROUP_ORDER_INVALID', message: CASE_GROUP_ERRORS.CASE_GROUP_ORDER_INVALID } };
  }
  const timeoutPolicy = String(input.timeoutPolicy || 'block_remaining');
  if (!CASE_GROUP_TIMEOUT_POLICIES.includes(timeoutPolicy)) {
    return {
      error: {
        code: 'CASE_GROUP_TIMEOUT_POLICY_INVALID',
        message: CASE_GROUP_ERRORS.CASE_GROUP_TIMEOUT_POLICY_INVALID,
      },
    };
  }
  const ttlMinutes = Number(input.ttlMinutes);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < minMinutes || ttlMinutes > maxMinutes) {
    return { error: { code: 'INVALID_TTL', message: `组级限时需在 ${minMinutes} 分钟到 ${maxMinutes} 分钟之间` } };
  }
  let disclosedPackageIds = [];
  if (input.disclosedPackageIds !== undefined && input.disclosedPackageIds !== null) {
    const parsed = idList(input.disclosedPackageIds, { field: 'disclosedPackageIds' });
    if (parsed.error) {
      return { error: { code: 'CASE_GROUP_DISCLOSURE_INVALID', message: parsed.error } };
    }
    if (!parsed.value.every((id) => current.has(id))) {
      return { error: { code: 'CASE_GROUP_DISCLOSURE_INVALID', message: CASE_GROUP_ERRORS.CASE_GROUP_DISCLOSURE_INVALID } };
    }
    disclosedPackageIds = parsed.value;
  }
  return {
    value: {
      minCompletions,
      memberOrder: order.value,
      timeoutPolicy,
      ttlMinutes,
      ttlMs: ttlMinutes * 60000,
      disclosedPackageIds,
    },
  };
}
