// ---------------------------------------------------------------------------
// 归档版本对比 + 受控重放审阅：输入校验、错误码、常量、纯函数（事件对齐）
//
// 比较报告只读取两份【已冻结】归档的冻结副本，本身也是冻结只读文档：
//   - 报告生成后没有任何改写条目的路径，归档之后新增业务事件不影响报告；
//   - 重放会话只能读取报告冻结的事件副本，不能触碰归档、业务记录与导出文件。
// ---------------------------------------------------------------------------

export const COMPARISON_ERRORS = {
  COMPARE_ARCHIVE_NOT_FOUND: '归档版本不存在或无权访问',
  COMPARE_SAME_ARCHIVE: '必须选择两个不同的归档版本',
  COMPARE_NOT_SAME_SOURCE: '只能比较同一来源的两个归档版本',
  COMPARE_NOT_FOUND: '比较报告不存在或无权访问',
  COMPARE_VIEW_FORBIDDEN: '当前账号未同时获得两个归档版本的授权，不能查阅此比较报告',
  ARCHIVE_CHAIN_INVALID: '归档摘要链校验失败，不能生成比较报告',
  REPLAY_NOT_FOUND: '重放审阅会话不存在或无权访问',
  REPLAY_SUBSET_EMPTY: '请至少选择一个事件创建重放会话',
  REPLAY_EVENT_OUT_OF_SCOPE: '只能选择比较报告中已对齐的事件，越权或报告外事件被拒绝',
  REPLAY_EVENT_UNALIGNED: '未对齐事件不能加入重放会话',
  REPLAY_TTL_INVALID: '重放会话有效期不合法',
  REPLAY_TOKEN_INVALID: '一次性提交令牌不正确',
  REPLAY_PAUSED: '重放会话已暂停，暂停期间不能写入意见',
  REPLAY_NOT_PAUSED: '只有暂停中的重放会话可以恢复',
  REPLAY_CANCELLED_READONLY: '重放会话已取消，会话只读',
  REPLAY_ALREADY_CANCELLED: '重放会话已经处于取消状态',
  REPLAY_NOT_CANCELLABLE: '只有进行中或暂停中的重放会话可以取消',
  REPLAY_EXPIRED: '重放会话已过期，会话只读',
  REPLAY_VERSION_CONFLICT: '重放会话版本已变化，请刷新后重试',
  REPLAY_REPORT_INVALID: '比较报告校验未通过或归档摘要链已失效，不能恢复重放',
  REPLAY_ALREADY_DECIDED: '该事件已有审阅结论（确认/异议），重复提交被拒绝',
  REPLAY_INVALID_KIND: '意见类型不正确',
  REPLAY_TEXT_REQUIRED: '意见内容长度不合法',
  REPLAY_OBJECTION_REASON_REQUIRED: '异议需要填写理由',
  REPLAY_IDEMPOTENCY_CONFLICT: '该提交编号已用于其他内容',
};

export const REPLAY_KINDS = ['comment', 'confirm', 'object'];
export const REPLAY_ENTRY_STATUSES = ['added', 'deleted', 'modified', 'unchanged', 'unaligned'];
// 只有按事件顺序对齐成功的事件可以进入重放；unaligned 永远不可选
export const REPLAY_SELECTABLE_STATUSES = new Set(['added', 'deleted', 'modified', 'unchanged']);

export const COMPARISON_STATUS_LABELS = {
  added: '新增',
  deleted: '删除',
  modified: '修改',
  unchanged: '未变化',
  unaligned: '无法对齐',
};

// 编号形如 BD-YYYYMMDD-XXXXXXXX（比较报告）/ CF-YYYYMMDD-XXXXXXXX（重放会话）
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
function randomNo(prefix, issuedAt = Date.now()) {
  const d = new Date(issuedAt);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  let randomPart = '';
  for (let i = 0; i < 8; i += 1) randomPart += CROCKFORD[Math.floor(Math.random() * 32)];
  return `${prefix}-${y}${m}${day}-${randomPart}`;
}
export const newComparisonNo = (at) => randomNo('BD', at);
export const newReplayNo = (at) => randomNo('CF', at);

// ---------------------------------------------------------------------------
// 输入解析
// ---------------------------------------------------------------------------

function idError(field) {
  return { error: { code: 'INVALID_ID', message: field } };
}

export function parseComparisonCreateInput(body) {
  const baseArchiveId = String(body?.baseArchiveId || '').trim();
  const targetArchiveId = String(body?.targetArchiveId || '').trim();
  const note = String(body?.note || '').trim().slice(0, 200);
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(baseArchiveId)) return idError('基准归档版本标识不正确');
  if (!/^[A-Za-z0-9_-]{8,200}$/.test(targetArchiveId)) return idError('目标归档版本标识不正确');
  return { value: { baseArchiveId, targetArchiveId, note } };
}

export function parseReplayCreateInput(body, { minMinutes, maxMinutes }) {
  const rawKeys = Array.isArray(body?.entryKeys) ? body.entryKeys : [];
  const entryKeys = [...new Set(rawKeys.map((value) => String(value || '').trim()).filter(Boolean))];
  if (entryKeys.length === 0) {
    return { error: { code: 'REPLAY_SUBSET_EMPTY', message: COMPARISON_ERRORS.REPLAY_SUBSET_EMPTY } };
  }
  if (entryKeys.some((key) => !/^e\d{1,15}$/.test(key))) {
    return { error: { code: 'REPLAY_EVENT_OUT_OF_SCOPE', message: COMPARISON_ERRORS.REPLAY_EVENT_OUT_OF_SCOPE } };
  }
  if (entryKeys.length > 1000) {
    return { error: { code: 'INVALID_INPUT', message: '单次重放最多选择 1000 个事件' } };
  }
  const ttlMinutes = Number(body?.ttlMinutes);
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < minMinutes || ttlMinutes > maxMinutes) {
    return {
      error: {
        code: 'REPLAY_TTL_INVALID',
        message: `重放会话有效期需为 ${minMinutes}-${maxMinutes} 分钟之间的整数`,
      },
    };
  }
  const note = String(body?.note || '').trim().slice(0, 200);
  return { value: { entryKeys, ttlMinutes, note } };
}

export function parseReplayOpinionInput(body) {
  const entryKey = String(body?.entryKey || '').trim();
  const kind = String(body?.kind || '').trim();
  const comment = String(body?.comment || '').trim().slice(0, 1000);
  const reason = String(body?.reason || '').trim().slice(0, 500);
  const idempotencyKey = String(body?.idempotencyKey || '').trim();
  const submitToken = String(body?.submitToken || '').trim();
  const expectedVersion = Number(body?.expectedVersion);
  if (!/^e\d{1,15}$/.test(entryKey)) {
    return { error: { code: 'REPLAY_EVENT_OUT_OF_SCOPE', message: COMPARISON_ERRORS.REPLAY_EVENT_OUT_OF_SCOPE } };
  }
  if (!REPLAY_KINDS.includes(kind)) {
    return { error: { code: 'REPLAY_INVALID_KIND', message: COMPARISON_ERRORS.REPLAY_INVALID_KIND } };
  }
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
    return { error: { code: 'INVALID_IDEMPOTENCY_KEY', message: '提交编号需为 8-100 位字母数字或 _-' } };
  }
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(submitToken)) {
    return { error: { code: 'REPLAY_TOKEN_INVALID', message: COMPARISON_ERRORS.REPLAY_TOKEN_INVALID } };
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return { error: { code: 'REPLAY_VERSION_CONFLICT', message: COMPARISON_ERRORS.REPLAY_VERSION_CONFLICT } };
  }
  if (kind === 'comment' && (!comment || comment.length > 1000)) {
    return { error: { code: 'REPLAY_TEXT_REQUIRED', message: '意见内容需为 1-1000 个字符' } };
  }
  if (kind === 'object' && (reason.length < 2 || reason.length > 500)) {
    return { error: { code: 'REPLAY_OBJECTION_REASON_REQUIRED', message: '异议理由需为 2-500 个字符' } };
  }
  return {
    value: {
      entryKey, kind, comment, reason, idempotencyKey, submitToken, expectedVersion,
      requestText: kind === 'object' ? reason : comment,
    },
  };
}

export function parseReplayControlInput(body) {
  const submitToken = String(body?.submitToken || '').trim();
  const expectedVersion = Number(body?.expectedVersion);
  const reason = String(body?.reason || '').trim().slice(0, 200);
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(submitToken)) {
    return { error: { code: 'REPLAY_TOKEN_INVALID', message: COMPARISON_ERRORS.REPLAY_TOKEN_INVALID } };
  }
  if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
    return { error: { code: 'REPLAY_VERSION_CONFLICT', message: COMPARISON_ERRORS.REPLAY_VERSION_CONFLICT } };
  }
  return { value: { submitToken, expectedVersion, reason } };
}

// ---------------------------------------------------------------------------
// 纯函数：两个冻结版本的事件序列对齐（LCS 最长公共子序列）
//
// 输入事件（均按 ordinal 升序）：
//   { ordinal, sourceEventId, type, occurredAt, contentHash, payload }
// 输出按合并后的事件顺序排列的条目：
//   added    仅目标版本存在（新版本新增）
//   deleted  仅基准版本存在（新版本删除）
//   modified 共同事件、冻结内容不一致
//   unchanged 共同事件、冻结内容一致
//   unaligned 共同事件但在两版本中的相对顺序无法对齐（显式给出原因，不可重放）
// ---------------------------------------------------------------------------

export function alignEvents(baseEvents, targetEvents) {
  const keyOf = (event) => `e${event.sourceEventId}`;
  const targetIndexByKey = new Map(targetEvents.map((event, index) => [keyOf(event), index]));

  // 以“基准序列 → 目标下标”的最长递增子序列求 LCS（耐心排序 O(n log n)）
  const common = [];
  baseEvents.forEach((event, baseIndex) => {
    const targetIndex = targetIndexByKey.get(keyOf(event));
    if (targetIndex !== undefined) common.push({ baseIndex, targetIndex, key: keyOf(event) });
  });
  const tails = []; // tails[k] = 长度 k+1 的递增子序列最小末尾在 common 中的下标
  const prev = new Array(common.length).fill(-1);
  common.forEach((item, index) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (common[tails[mid]].targetIndex < item.targetIndex) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[index] = tails[lo - 1];
    tails[lo] = index;
  });
  const lcsKeys = new Set();
  if (tails.length > 0) {
    let cursor = tails[tails.length - 1];
    while (cursor !== -1) {
      lcsKeys.add(common[cursor].key);
      cursor = prev[cursor];
    }
  }

  // LCS 锚点：顺序一致的共同事件（unchanged/modified）。
  // 其余两侧事件：同 key 配成一对 → unaligned（只出现一次）；
  // 仅一侧出现 → added/deleted。最后按“在锚点序列中的区段 + ordinal”统一排序。
  const anchors = common.filter((item) => lcsKeys.has(item.key));
  const anchorBaseSet = new Set(anchors.map((item) => item.baseIndex));
  const anchorTargetSet = new Set(anchors.map((item) => item.targetIndex));

  const entries = [];

  // 非锚点事件全局配对：同 key 一定属于同一对（无论跨几个锚点切片）→ unaligned。
  // 排序位置取“两侧 ordinal 中较小者减 0.5”，使其落在相对位置之前的锚点与事件之间；
  // 仅一侧出现的事件按本侧 ordinal 排序。
  const nonAnchorBase = [];
  const nonAnchorTarget = [];
  baseEvents.forEach((event, index) => {
    if (!anchorBaseSet.has(index)) nonAnchorBase.push({ event, index });
  });
  targetEvents.forEach((event, index) => {
    if (!anchorTargetSet.has(index)) nonAnchorTarget.push({ event, index });
  });
  const nonAnchorTargetByKey = new Map(nonAnchorTarget.map((item) => [keyOf(item.event), item]));
  const nonAnchorBaseByKey = new Map(nonAnchorBase.map((item) => [keyOf(item.event), item]));

  for (const { event: baseEvent, index: baseIndex } of nonAnchorBase) {
    const other = nonAnchorTargetByKey.get(keyOf(baseEvent));
    if (other) {
      entries.push({
        position: Math.min(baseIndex, other.index) + 0.5,
        side: 0,
        entryKey: keyOf(baseEvent), status: 'unaligned',
        reason: '共同事件在两个归档版本中的相对顺序不一致，不能按事件顺序对齐',
        base: baseEvent, target: other.event,
      });
    } else {
      entries.push({
        position: baseIndex + 0.75, side: 2,
        entryKey: keyOf(baseEvent), status: 'deleted',
        reason: '该事件只存在于基准归档版本', base: baseEvent, target: null,
      });
    }
  }
  for (const { event: targetEvent, index: targetIndex } of nonAnchorTarget) {
    if (nonAnchorBaseByKey.has(keyOf(targetEvent))) continue; // 共同事件已作为 unaligned 发出
    entries.push({
      position: targetIndex + 0.25, side: 1,
      entryKey: keyOf(targetEvent), status: 'added',
      reason: '该事件只存在于目标归档版本', base: null, target: targetEvent,
    });
  }
  // 锚点事件：按目标 ordinal 定位
  for (const anchor of anchors) {
    const baseEvent = baseEvents[anchor.baseIndex];
    const targetEvent = targetEvents[anchor.targetIndex];
    entries.push({
      position: anchor.targetIndex + 1, side: -1,
      entryKey: anchor.key,
      status: baseEvent.contentHash !== targetEvent.contentHash ? 'modified' : 'unchanged',
      reason: '', base: baseEvent, target: targetEvent,
    });
  }

  entries.sort((a, b) => (a.position - b.position) || (a.side - b.side));
  const ordered = entries.map((entry, index) => ({
    ordinal: index + 1,
    entryKey: entry.entryKey,
    status: entry.status,
    reason: entry.reason,
    base: entry.base,
    target: entry.target,
  }));

  const counts = { added: 0, deleted: 0, modified: 0, unchanged: 0, unaligned: 0 };
  for (const entry of ordered) counts[entry.status] += 1;
  const unalignedReasons = [];
  for (const entry of ordered) {
    if (entry.status === 'unaligned') unalignedReasons.push({ entryKey: entry.entryKey, reason: entry.reason });
  }
  return { entries: ordered, counts, unalignedReasons };
}

// 状态摘要的浅层字段差异（数组/对象按规范化 JSON 整体比较）
export function diffStatusSummary(baseSummary, targetSummary) {
  const keys = new Set([...Object.keys(baseSummary || {}), ...Object.keys(targetSummary || {})]);
  const changes = [];
  for (const key of [...keys].sort()) {
    const from = baseSummary?.[key];
    const to = targetSummary?.[key];
    if (stableJson(from) !== stableJson(to)) {
      changes.push({ field: key, from: preview(from), to: preview(to) });
    }
  }
  return { changed: changes.length > 0, changes };
}

function stableJson(value) {
  if (value === undefined) return null;
  if (value && typeof value === 'object') return JSON.stringify(sortKeys(value));
  return JSON.stringify(value);
}
function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, sortKeys(value[key])]));
  }
  return value;
}
function preview(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'object') {
    const text = stableJson(value);
    return text.length > 500 ? `${text.slice(0, 500)}…` : text;
  }
  return value;
}
