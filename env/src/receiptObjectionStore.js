// ---------------------------------------------------------------------------
// 回执撤销与异议处理：持久化与事务编排
//
// 所有状态变化都在 BEGIN IMMEDIATE 事务中以“当前状态 + 行级条件更新”为唯一
// 判定依据：两个处理人/页面并发处理同一条异议时，只有一个事务成功；终态异议
// 的重复动作一律明确失败，返回同一历史，绝不覆盖。事件表只追加、永不改写。
// ---------------------------------------------------------------------------
import { db, immediateTransaction, cryptoId, userQueries } from './db.js';
import {
  OBJECTION_ACTION_LABELS,
  OBJECTION_STATUS_LABELS,
  RECEIPT_OBJECTION_OPEN_STATUSES,
  attachmentSummary,
  canTransition,
  isObjectionTerminal,
  maskedApplicant,
  maskedObjectionReceipt,
  newObjectionNo,
  nextStatusFor,
  objectionDeadline,
  snapshotDigest,
  fullApplicant,
} from './receiptObjections.js';

function now() {
  return Date.now();
}

// 事件同时写入只追加的异议事件表（完整审计来源）与回执所属办理记录的 events
// 时间线（办理人在回执版本时间线即可看到来源关系）。
function addObjectionEventTx({
  objection, type, fromStatus, toStatus, actorUserId, actorRole, reason = '', note = '', extra = {},
}) {
  return appendObjectionEventTx({
    objection, type, fromStatus, toStatus, actorUserId, actorRole, reason, note, extra,
  });
}

// 异议超期升级模块复用的事务内事件追加（INSERT-only，ordinal 连续分配）。
// 必须在 immediate 事务内调用：MAX(ordinal)+1 与 INSERT 同事务，并发调用由写锁串行化。
export function appendObjectionEventTx({
  objection, type, fromStatus = '', toStatus = '', actorUserId = null, actorRole = '',
  reason = '', note = '', extra = {},
}) {
  const ordinalRow = db.prepare(`
    SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
    FROM receipt_objection_events WHERE objection_id = ?
  `).get(objection.id);
  const ordinal = ordinalRow.next_ordinal;
  const eventId = cryptoId();
  const ts = now();
  db.prepare(`
    INSERT INTO receipt_objection_events
      (id, objection_id, ordinal, type, from_status, to_status,
       actor_user_id, actor_role, reason, note, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    eventId, objection.id, ordinal, type, fromStatus || '', toStatus || '',
    actorUserId || null, actorRole || '', reason, note, ts,
  );
  db.prepare(`
    INSERT INTO events (workflow_id, type, step, detail_json, created_at)
    VALUES (?, ?, NULL, ?, ?)
  `).run(
    objection.workflow_id, type,
    JSON.stringify({
      receiptNo: objection.receipt_no,
      objectionNo: objection.objection_no,
      objectionId: objection.id,
      fromStatus: fromStatus || '',
      toStatus: toStatus || '',
      reason, note, ...extra,
    }),
    ts,
  );
  return { id: eventId, ordinal };
}

// ---------------------------------------------------------------------------
// 创建异议（办理人本人）
// ---------------------------------------------------------------------------
export function createReceiptObjection({ userId, receiptNo, reason, attachment }) {
  try {
    return immediateTransaction(() => {
      const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ? AND user_id = ?')
        .get(receiptNo, userId);
      if (!receipt) {
        return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND', message: '回执不存在或不属于当前账号' };
      }
      if (receipt.status === 'revoked') {
        return { ok: false, status: 409, code: 'RECEIPT_REVOKED', message: '已撤销的回执不能发起撤销异议' };
      }
      const open = db.prepare(`
        SELECT * FROM receipt_objections
        WHERE receipt_no = ? AND status IN (${RECEIPT_OBJECTION_OPEN_STATUSES.map(() => '?').join(', ')})
      `).get(receiptNo, ...RECEIPT_OBJECTION_OPEN_STATUSES);
      if (open) {
        return {
          ok: false,
          status: 409,
          code: 'OBJECTION_IN_PROGRESS',
          message: '该回执已存在一份进行中的异议，处理完成前不能重复发起',
          objectionNo: open.objection_no,
        };
      }

      // 分配：当前进行中异议数量最少的处理人（无处理人账号则明确失败，不静默吞掉）
      const assignee = pickAssigneeTx();
      if (!assignee) {
        return { ok: false, status: 503, code: 'NO_PROCESSOR_AVAILABLE', message: '当前没有可分配的异议处理人，请稍后再试' };
      }

      const ts = now();
      // 提交时冻结回执快照：独立复制一份 snapshot_json，与原回执之后的任何变化无关
      const snapshotJson = receipt.snapshot_json;
      const id = cryptoId();
      const objectionNo = uniqueObjectionNoTx(ts);
      db.prepare(`
        INSERT INTO receipt_objections
          (id, objection_no, receipt_no, workflow_id, user_id, assignee_user_id,
           status, reason, snapshot_json, receipt_status_snapshot, snapshot_digest, note,
           created_at, deadline_at, accepted_at, accepted_by_user_id,
           supplement_requested_at, supplement_requested_by_user_id, supplement_request_note,
           supplemented_at, resolved_at, resolved_by_user_id, resolve_note, revoked_receipt_at)
        VALUES (?, ?, ?, ?, ?, ?, 'submitted', ?, ?, 'issued', ?, '', ?, ?, NULL, NULL,
                NULL, NULL, '', NULL, NULL, NULL, '', NULL)
      `).run(
        id, objectionNo, receipt.receipt_no, receipt.workflow_id, userId, assignee.id,
        reason, snapshotJson, snapshotDigest(snapshotJson), ts, objectionDeadline(ts),
      );
      const objection = db.prepare('SELECT * FROM receipt_objections WHERE id = ?').get(id);
      db.prepare(`
        INSERT INTO receipt_objection_materials
          (id, objection_id, ordinal, filename, content_type, content, note,
           uploaded_by_user_id, uploaded_by_role, created_at)
        VALUES (?, ?, 0, ?, ?, ?, '', ?, 'handler', ?)
      `).run(cryptoId(), id, attachment.filename, attachment.contentType, attachment.content, userId, ts);
      addObjectionEventTx({
        objection,
        type: 'receipt.objection.submitted',
        fromStatus: '',
        toStatus: 'submitted',
        actorUserId: userId,
        actorRole: 'handler',
        reason,
        extra: { assigneeUserId: assignee.id, attachment: attachment.filename },
      });
      return { ok: true, objection: getOwnerObjection(id) };
    });
  } catch (error) {
    // 两个页面并发：部分唯一索引只放行一个，另一个重新读取明确失败
    if (String(error?.message || '').includes('UNIQUE')) {
      const existing = db.prepare(`
        SELECT * FROM receipt_objections
        WHERE receipt_no = ? AND status IN (${RECEIPT_OBJECTION_OPEN_STATUSES.map(() => '?').join(', ')})
      `).get(receiptNo, ...RECEIPT_OBJECTION_OPEN_STATUSES);
      if (existing) {
        return {
          ok: false,
          status: 409,
          code: 'OBJECTION_IN_PROGRESS',
          message: '该回执的撤销异议已由另一个页面发起，请重新读取最新状态',
          objectionNo: existing.objection_no,
        };
      }
    }
    throw error;
  }
}

function uniqueObjectionNoTx(ts) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const objectionNo = newObjectionNo(ts);
    const exists = db.prepare('SELECT 1 FROM receipt_objections WHERE objection_no = ?').get(objectionNo);
    if (!exists) return objectionNo;
  }
  throw new Error('异议编号连续冲突，请重试');
}

function pickAssigneeTx() {
  const processors = userListProcessorsTx();
  if (processors.length === 0) return null;
  const counts = db.prepare(`
    SELECT assignee_user_id AS assignee, COUNT(*) AS open_count
    FROM receipt_objections
    WHERE status IN (${RECEIPT_OBJECTION_OPEN_STATUSES.map(() => '?').join(', ')})
    GROUP BY assignee_user_id
  `).all(...RECEIPT_OBJECTION_OPEN_STATUSES);
  const countByUser = new Map(counts.map((row) => [row.assignee, row.open_count]));
  return processors
    .map((user) => ({ ...user, openCount: countByUser.get(user.id) || 0 }))
    .sort((a, b) => (a.openCount - b.openCount) || a.username.localeCompare(b.username))[0];
}

function userListProcessorsTx() {
  return db.prepare(`
    SELECT id, username, display_name, role FROM users WHERE role = 'processor' ORDER BY username ASC
  `).all();
}

// ---------------------------------------------------------------------------
// 状态变化（处理人 / 办理人补充）：统一的条件更新，非法跳转明确拒绝
// ---------------------------------------------------------------------------
function transitionObjection({
  userId, role, objectionId, action, reason = '', note = '', supplement = null,
}) {
  return immediateTransaction(() => {
    const objection = db.prepare('SELECT * FROM receipt_objections WHERE id = ?').get(objectionId);
    if (!objection) {
      return { ok: false, status: 404, code: 'OBJECTION_NOT_FOUND', message: '异议不存在' };
    }
    // 处理动作只有被分配的处理人能执行；补充材料只有发起的办理人本人能执行
    if (action === 'supplement') {
      if (role !== 'handler' || objection.user_id !== userId) {
        return { ok: false, status: 403, code: 'FORBIDDEN', message: '只有异议发起人可以补充材料' };
      }
    } else if (role !== 'processor' || objection.assignee_user_id !== userId) {
      return { ok: false, status: 403, code: 'OBJECTION_NOT_ASSIGNED', message: '该异议未分配给当前处理人' };
    }

    const fromStatus = objection.status;
    if (!canTransition(fromStatus, action)) {
      if (isObjectionTerminal(fromStatus)) {
        return {
          ok: false,
          status: 409,
          code: 'OBJECTION_ALREADY_HANDLED',
          message: `该异议已处理完结（${OBJECTION_STATUS_LABELS[fromStatus] || fromStatus}），不能重复受理或覆盖历史`,
          objection: role === 'handler' ? getOwnerObjection(objection.id) : getProcessorObjection(objection.id),
        };
      }
      return {
        ok: false,
        status: 409,
        code: 'OBJECTION_INVALID_TRANSITION',
        message: `当前状态（${OBJECTION_STATUS_LABELS[fromStatus] || fromStatus}）不允许执行“${OBJECTION_ACTION_LABELS[action] || action}”`,
        objection: role === 'handler' ? getOwnerObjection(objection.id) : getProcessorObjection(objection.id),
      };
    }

    const toStatus = nextStatusFor(action);
    const ts = now();
    const type = {
      accept: 'receipt.objection.accepted',
      requestSupplements: 'receipt.objection.supplement-requested',
      supplement: 'receipt.objection.supplemented',
      reject: 'receipt.objection.rejected',
      confirmRevocation: 'receipt.objection.revocation-confirmed',
    }[action];

    // 先做副作用（确认撤销要把原回执置为 revoked），再以条件更新兜底并发
    let receiptRevokedAt = null;
    if (action === 'confirmRevocation') {
      const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(objection.receipt_no);
      if (!receipt) {
        return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND', message: '原回执不存在' };
      }
      if (receipt.status === 'revoked') {
        // 回执已通过其他途径撤销：仍把异议落为已确认撤销（结果一致），记录实际撤销时间
        receiptRevokedAt = receipt.revoked_at || ts;
      } else {
        receiptRevokedAt = ts;
        const revokeReason = `撤销异议 ${objection.objection_no} 经审查确认撤销${reason ? `：${String(reason).slice(0, 180)}` : ''}`;
        db.prepare(`
          UPDATE receipts SET status = 'revoked', revoked_at = ?, revoke_reason = ?
          WHERE id = ? AND status = 'issued'
        `).run(ts, revokeReason.slice(0, 200), receipt.id);
        db.prepare(`
          INSERT INTO events (workflow_id, type, step, detail_json, created_at)
          VALUES (?, 'receipt.revoked', NULL, ?, ?)
        `).run(receipt.workflow_id, JSON.stringify({
          receiptNo: receipt.receipt_no,
          reason: revokeReason,
          viaObjectionNo: objection.objection_no,
        }), ts);
      }
    }

    const result = applyStatusUpdate({ objection, action, toStatus, userId, ts, note, reason, receiptRevokedAt });
    if (result.changes === 0) {
      // 并发：另一事务已先行流转，返回最新状态明确拒绝覆盖
      const latest = db.prepare('SELECT * FROM receipt_objections WHERE id = ?').get(objection.id);
      return {
        ok: false,
        status: 409,
        code: 'OBJECTION_STATE_CHANGED',
        message: '该异议状态刚被其他操作改变，请刷新后重试',
        objection: role === 'handler' ? getOwnerObjection(objection.id) : getProcessorObjection(objection.id),
      };
    }

    if (action === 'supplement' && supplement) {
      const ordinalRow = db.prepare(`
        SELECT COALESCE(MAX(ordinal), 0) + 1 AS next_ordinal
        FROM receipt_objection_materials WHERE objection_id = ?
      `).get(objection.id);
      db.prepare(`
        INSERT INTO receipt_objection_materials
          (id, objection_id, ordinal, filename, content_type, content, note,
           uploaded_by_user_id, uploaded_by_role, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'handler', ?)
      `).run(
        cryptoId(), objection.id, ordinalRow.next_ordinal,
        supplement.filename, supplement.contentType, supplement.content, note, userId, ts,
      );
    }

    const updated = db.prepare('SELECT * FROM receipt_objections WHERE id = ?').get(objection.id);
    addObjectionEventTx({
      objection: updated,
      type,
      fromStatus,
      toStatus,
      actorUserId: userId,
      actorRole: role,
      reason,
      note,
      extra: action === 'supplement' && supplement ? { attachment: supplement.filename } : {},
    });

    return {
      ok: true,
      objection: role === 'handler' ? getOwnerObjection(objection.id) : getProcessorObjection(objection.id),
      receiptStatus: action === 'confirmRevocation'
        ? db.prepare('SELECT status FROM receipts WHERE receipt_no = ?').get(objection.receipt_no)?.status
        : undefined,
    };
  });
}

// 每个动作只更新它负责的列，且 WHERE 带“当前状态”条件（并发兜底）
function applyStatusUpdate({ objection, action, toStatus, userId, ts, note, reason, receiptRevokedAt }) {
  if (action === 'accept') {
    return db.prepare(`
      UPDATE receipt_objections
      SET status = 'accepted', accepted_at = ?, accepted_by_user_id = ?
      WHERE id = ? AND status = 'submitted'
    `).run(ts, userId, objection.id);
  }
  if (action === 'requestSupplements') {
    return db.prepare(`
      UPDATE receipt_objections
      SET status = 'supplementing', supplement_requested_at = ?,
          supplement_requested_by_user_id = ?, supplement_request_note = ?
      WHERE id = ? AND status = 'accepted'
    `).run(ts, userId, String(note || reason || '').slice(0, 500), objection.id);
  }
  if (action === 'supplement') {
    return db.prepare(`
      UPDATE receipt_objections
      SET status = 'accepted', supplemented_at = ?
      WHERE id = ? AND status = 'supplementing'
    `).run(ts, objection.id);
  }
  if (action === 'reject') {
    return db.prepare(`
      UPDATE receipt_objections
      SET status = 'rejected', resolved_at = ?, resolved_by_user_id = ?, resolve_note = ?
      WHERE id = ? AND status IN ('accepted', 'supplementing')
    `).run(ts, userId, String(reason).slice(0, 500), objection.id);
  }
  if (action === 'confirmRevocation') {
    return db.prepare(`
      UPDATE receipt_objections
      SET status = 'revoked', resolved_at = ?, resolved_by_user_id = ?,
          resolve_note = ?, revoked_receipt_at = ?
      WHERE id = ? AND status = 'accepted'
    `).run(ts, userId, String(reason || note || '').slice(0, 500), receiptRevokedAt || ts, objection.id);
  }
  throw new Error(`未知异议动作：${action}`);
}

// 处理人动作
export function acceptReceiptObjection(params) {
  return transitionObjection({ ...params, action: 'accept', role: 'processor' });
}
export function requestObjectionSupplements(params) {
  return transitionObjection({ ...params, action: 'requestSupplements', role: 'processor' });
}
export function rejectReceiptObjection(params) {
  return transitionObjection({ ...params, action: 'reject', role: 'processor' });
}
export function confirmObjectionRevocation(params) {
  return transitionObjection({ ...params, action: 'confirmRevocation', role: 'processor' });
}
// 办理人补充材料
export function supplementReceiptObjection(params) {
  return transitionObjection({ ...params, action: 'supplement', role: 'handler' });
}

// ---------------------------------------------------------------------------
// 查询视图
// ---------------------------------------------------------------------------
function eventsForObjection(objectionId) {
  return db.prepare(`
    SELECT * FROM receipt_objection_events WHERE objection_id = ? ORDER BY ordinal ASC
  `).all(objectionId).map(eventRow);
}

function eventRow(row) {
  const actor = row.actor_user_id ? userQueries.findById(row.actor_user_id) : null;
  return {
    id: row.id,
    ordinal: row.ordinal,
    type: row.type,
    fromStatus: row.from_status || null,
    toStatus: row.to_status || null,
    statusLabel: row.to_status ? (OBJECTION_STATUS_LABELS[row.to_status] || row.to_status) : '',
    actorRole: row.actor_role,
    actorName: actor ? actor.display_name : '',
    reason: row.reason || '',
    note: row.note || '',
    at: row.created_at,
  };
}

function materialsForObjection(objectionId, { includeContent = false } = {}) {
  const rows = db.prepare(`
    SELECT * FROM receipt_objection_materials WHERE objection_id = ? ORDER BY ordinal ASC
  `).all(objectionId);
  return rows.map((row) => {
    const summary = attachmentSummary(row);
    const uploadedBy = row.uploaded_by_user_id ? userQueries.findById(row.uploaded_by_user_id) : null;
    return {
      ...summary,
      uploadedBy: uploadedBy ? uploadedBy.display_name : '',
      note: row.note || '',
      ...(includeContent ? { content: row.content } : {}),
    };
  });
}

function objectionBase(row, viewer) {
  const snapshot = JSON.parse(row.snapshot_json);
  const overdue = !isObjectionTerminal(row.status) && row.deadline_at <= now();
  const assignee = row.assignee_user_id ? userQueries.findById(row.assignee_user_id) : null;
  const owner = userQueries.findById(row.user_id);
  return {
    id: row.id,
    objectionNo: row.objection_no,
    receiptNo: row.receipt_no,
    status: row.status,
    statusLabel: OBJECTION_STATUS_LABELS[row.status] || row.status,
    reason: row.reason,
    createdAt: row.created_at,
    deadlineAt: row.deadline_at,
    overdue,
    overdueAt: row.overdue_at || null,
    acceptedAt: row.accepted_at || null,
    supplementRequestedAt: row.supplement_requested_at || null,
    supplementNote: row.supplement_request_note || '',
    supplementedAt: row.supplemented_at || null,
    resolvedAt: row.resolved_at || null,
    resolveNote: row.resolve_note || '',
    receiptRevokedAt: row.revoked_receipt_at || null,
    receiptStatusSnapshot: row.receipt_status_snapshot,
    snapshotDigest: row.snapshot_digest,
    assignee: assignee ? { id: assignee.id, displayName: assignee.display_name } : null,
    owner: viewer === 'processor' && owner
      ? { displayName: owner.display_name, username: owner.username }
      : undefined,
    applicant: maskedApplicant(snapshot),
  };
}

// 办理人视图：自己的异议，含脱敏申请人（本人其实知情，但响应只给脱敏结果）与完整时间线
export function getOwnerObjection(objectionId, { userId = null } = {}) {
  const row = db.prepare('SELECT * FROM receipt_objections WHERE id = ?').get(objectionId);
  if (!row || (userId && row.user_id !== userId)) return null;
  return {
    ...objectionBase(row, 'owner'),
    materials: materialsForObjection(row.id),
    events: eventsForObjection(row.id),
  };
}

// 办理人视图：按异议编号（YY-...）查询，带归属校验
export function getOwnerObjectionByNo(objectionNo, userId) {
  const row = db.prepare('SELECT * FROM receipt_objections WHERE objection_no = ?').get(objectionNo);
  if (!row || (userId && row.user_id !== userId)) return null;
  return {
    ...objectionBase(row, 'owner'),
    materials: materialsForObjection(row.id),
    events: eventsForObjection(row.id),
  };
}

// 处理人视图：按异议编号查询，带分配校验
export function getProcessorObjectionByNo(objectionNo, userId) {
  const row = db.prepare('SELECT * FROM receipt_objections WHERE objection_no = ?').get(objectionNo);
  if (!row || (userId && row.assignee_user_id !== userId)) return null;
  return getProcessorObjection(row.id, { userId });
}

// 审计视图：按异议编号查询（审计角色均可查看完整记录）
export function getAuditorObjectionByNo(objectionNo) {
  const row = db.prepare('SELECT * FROM receipt_objections WHERE objection_no = ?').get(objectionNo);
  return row ? getAuditorObjection(row.id) : null;
}

// 处理人视图：分配给自己的异议，含脱敏回执内容、材料正文与处理历史
export function getProcessorObjection(objectionId, { userId = null } = {}) {
  const row = db.prepare('SELECT * FROM receipt_objections WHERE id = ?').get(objectionId);
  if (!row || (userId && row.assignee_user_id !== userId)) return null;
  const snapshot = JSON.parse(row.snapshot_json);
  const currentReceipt = db.prepare('SELECT status, revoked_at, revoke_reason FROM receipts WHERE receipt_no = ?')
    .get(row.receipt_no);
  return {
    ...objectionBase(row, 'processor'),
    maskedReceipt: maskedObjectionReceipt(snapshot),
    currentReceiptStatus: currentReceipt?.status || 'unknown',
    currentReceiptRevokedAt: currentReceipt?.revoked_at || null,
    materials: materialsForObjection(row.id, { includeContent: true }),
    events: eventsForObjection(row.id),
  };
}

// 审计视图：完整（未脱敏）冻结快照、完整材料正文与完整处理历史
export function getAuditorObjection(objectionId) {
  const row = db.prepare('SELECT * FROM receipt_objections WHERE id = ?').get(objectionId);
  if (!row) return null;
  const snapshot = JSON.parse(row.snapshot_json);
  const currentReceipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(row.receipt_no);
  return {
    ...objectionBase(row, 'auditor'),
    fullSnapshot: snapshot,
    fullApplicant: fullApplicant(snapshot),
    frozenSnapshot: snapshot,
    currentReceiptStatus: currentReceipt?.status || 'unknown',
    currentReceiptRevokedAt: currentReceipt?.revoked_at || null,
    currentReceiptRevokeReason: currentReceipt?.revoke_reason || '',
    materials: materialsForObjection(row.id, { includeContent: true }),
    events: eventsForObjection(row.id),
  };
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------
function listSummaryRows(whereClause, params) {
  return db.prepare(`
    SELECT * FROM receipt_objections ${whereClause} ORDER BY created_at DESC, objection_no DESC
  `).all(...params).map((row) => objectionBase(row, 'owner'));
}

// 办理人列表：返回完整本人记录（材料摘要 + 完整处理历史；材料正文不在列表下发）
export function listReceiptObjectionsForOwner(userId, { receiptNo = '' } = {}) {
  const rows = receiptNo
    ? db.prepare('SELECT * FROM receipt_objections WHERE user_id = ? AND receipt_no = ? ORDER BY created_at DESC, objection_no DESC').all(userId, receiptNo)
    : db.prepare('SELECT * FROM receipt_objections WHERE user_id = ? ORDER BY created_at DESC, objection_no DESC').all(userId);
  return rows.map((row) => ({
    ...objectionBase(row, 'owner'),
    materials: materialsForObjection(row.id),
    events: eventsForObjection(row.id),
  }));
}

export function listAssignedObjections(userId, { status = '' } = {}) {
  const allowed = new Set(['submitted', 'accepted', 'supplementing', 'rejected', 'revoked', 'open', '']);
  if (!allowed.has(status)) return [];
  if (status === 'open') {
    return listSummaryRows(
      `WHERE assignee_user_id = ? AND status IN (${RECEIPT_OBJECTION_OPEN_STATUSES.map(() => '?').join(', ')})`,
      [userId, ...RECEIPT_OBJECTION_OPEN_STATUSES],
    );
  }
  if (status) {
    return listSummaryRows('WHERE assignee_user_id = ? AND status = ?', [userId, status]);
  }
  return listSummaryRows('WHERE assignee_user_id = ?', [userId]);
}

// 审计员：全部异议（权限按角色，审计角色即可见完整审计记录）
export function listAllObjectionsForAuditor({ receiptNo = '', status = '' } = {}) {
  const clauses = [];
  const params = [];
  if (receiptNo) {
    clauses.push('receipt_no = ?');
    params.push(receiptNo);
  }
  if (status && status !== 'open') {
    clauses.push('status = ?');
    params.push(status);
  } else if (status === 'open') {
    clauses.push(`status IN (${RECEIPT_OBJECTION_OPEN_STATUSES.map(() => '?').join(', ')})`);
    params.push(...RECEIPT_OBJECTION_OPEN_STATUSES);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  // 列表只给脱敏摘要 + 历史计数；完整快照在详情接口获取
  return db.prepare(`
    SELECT * FROM receipt_objections ${where} ORDER BY created_at DESC, objection_no DESC
  `).all(...params).map((row) => {
    const base = objectionBase(row, 'auditor');
    const eventCount = db.prepare(
      'SELECT COUNT(*) AS c FROM receipt_objection_events WHERE objection_id = ?',
    ).get(row.id).c;
    const materialCount = db.prepare(
      'SELECT COUNT(*) AS c FROM receipt_objection_materials WHERE objection_id = ?',
    ).get(row.id).c;
    const owner = userQueries.findById(row.user_id);
    const assignee = row.assignee_user_id ? userQueries.findById(row.assignee_user_id) : null;
    return {
      ...base,
      owner: owner ? { displayName: owner.display_name, username: owner.username } : null,
      assignee: assignee ? { id: assignee.id, displayName: assignee.display_name } : null,
      eventCount,
      materialCount,
    };
  });
}

// 回执版本时间线条目（办理人）：每条异议一个条目，附最新状态与完整处理历史
export function buildObjectionTimelineEntries(userId) {
  const rows = db.prepare(`
    SELECT * FROM receipt_objections WHERE user_id = ? ORDER BY created_at ASC
  `).all(userId);
  return rows.map((row) => ({
    kind: 'receiptObjection',
    receiptNo: row.receipt_no,
    objectionNo: row.objection_no,
    status: row.status,
    statusLabel: OBJECTION_STATUS_LABELS[row.status] || row.status,
    createdAt: row.created_at,
    deadlineAt: row.deadline_at,
    resolvedAt: row.resolved_at || null,
    receiptRevokedAt: row.revoked_receipt_at || null,
    events: eventsForObjection(row.id).map((event) => ({
      type: event.type,
      at: event.at,
      actorRole: event.actorRole,
      actorName: event.actorName,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      reason: event.reason,
      note: event.note,
    })),
  }));
}
