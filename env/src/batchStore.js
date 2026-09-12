// ---------------------------------------------------------------------------
// 多方复核批次的持久化与事务编排
//
// 所有终局状态变更（进入复核、提交意见、字段决议）都在 BEGIN IMMEDIATE 事务中
// 以“当前状态 + 行级条件更新”为唯一判定依据：两个页面并发决议同一字段时，
// 只有一个事务成功，另一个拿到已经存在的同一决议（重复决议明确失败）。
// ---------------------------------------------------------------------------
import { db, immediateTransaction, cryptoId, getActiveWorkflow, getSteps, userQueries, publicWorkflow } from './db.js';
import { sha256, tokenUrlSafe } from './crypto.js';
import { STEPS } from './workflow.js';
import {
  ALL_BATCH_FIELDS,
  BATCH_MAX_INVITATIONS,
  BATCH_OPINION_MAX,
  BATCH_OPINION_MIN,
  BATCH_REJECT_REASON_MAX,
  batchFieldKey,
  batchFieldLabel,
  batchFieldTextValue,
  buildBatchReviewView,
} from './batchReviews.js';

function now() {
  return Date.now();
}

function addBatchEvent(receiptNo, type, detail) {
  const row = db.prepare('SELECT workflow_id FROM receipts WHERE receipt_no = ?').get(receiptNo);
  if (!row) return;
  db.prepare(`
    INSERT INTO events (workflow_id, type, step, detail_json, created_at)
    VALUES (?, ?, NULL, ?, ?)
  `).run(row.workflow_id, type, JSON.stringify({ receiptNo, ...detail }), now());
}

function effectiveBatchInviteStatus(row) {
  if (row.status === 'active' && row.expires_at <= now()) {
    db.prepare("UPDATE review_batch_invitations SET status = 'expired' WHERE id = ? AND status = 'active'").run(row.id);
    return 'expired';
  }
  return row.status;
}

function loadBatchTx(batchId) {
  return db.prepare('SELECT * FROM review_batches WHERE id = ?').get(batchId) || null;
}

function loadBatchFieldRow(batchFieldId) {
  return db.prepare('SELECT * FROM review_batch_fields WHERE id = ?').get(batchFieldId) || null;
}

// ---------------------------------------------------------------------------
// 创建批次：一个事务内写批次、字段阈值、邀请（仅存令牌哈希）与字段授权
// ---------------------------------------------------------------------------
export function createReviewBatch({ userId, receipt, config, ttlMs }) {
  return immediateTransaction(() => {
    // 同一回执至多一个未终结批次（部分唯一索引 + 前置检查双保险）
    const openBatch = db.prepare(`
      SELECT id FROM review_batches
      WHERE receipt_no = ? AND status IN ('collecting', 'in_review')
    `).get(receipt.receipt_no);
    if (openBatch) {
      return { ok: false, status: 409, code: 'BATCH_ALREADY_OPEN', message: '该回执已存在一个进行中的多方复核批次，请先完成或取消' };
    }

    const ts = now();
    const batchId = cryptoId();
    db.prepare(`
      INSERT INTO review_batches
        (id, receipt_no, workflow_id, user_id, status, note, created_at, expires_at,
         started_at, completed_at, cancelled_at, cancel_reason, invitation_count)
      VALUES (?, ?, ?, ?, 'collecting', ?, ?, ?, NULL, NULL, NULL, '', ?)
    `).run(batchId, receipt.receipt_no, receipt.workflow_id, userId, config.note, ts, ts + ttlMs, config.invitations.length);

    const fieldIdByKey = new Map();
    for (const field of config.fields) {
      const fieldId = cryptoId();
      db.prepare(`
        INSERT INTO review_batch_fields
          (id, batch_id, step, field, field_label, accept_threshold, reject_threshold,
           decision, decided_at, decided_by_user_id, decision_reason,
           correction_workflow_id, correction_receipt_no)
        VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, '', NULL, '')
      `).run(fieldId, batchId, field.step, field.field, batchFieldLabel(field.step, field.field),
        field.acceptThreshold, field.rejectThreshold);
      fieldIdByKey.set(field.key, fieldId);
    }

    const invitations = [];
    for (const invite of config.invitations) {
      const raw = tokenUrlSafe();
      const inviteId = cryptoId();
      db.prepare(`
        INSERT INTO review_batch_invitations
          (id, batch_id, receipt_no, user_id, label, token_hash, status, created_at,
           expires_at, used_at, used_ip, revoked_at)
        VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, '', NULL)
      `).run(inviteId, batchId, receipt.receipt_no, userId, invite.label, sha256(raw), ts, ts + ttlMs);
      const scopeFieldIds = [];
      for (const key of invite.scopeKeys) {
        const batchFieldId = fieldIdByKey.get(key);
        const parsedKey = key.split('.');
        db.prepare(`
          INSERT INTO review_batch_invitation_fields (invitation_id, batch_field_id, step, field)
          VALUES (?, ?, ?, ?)
        `).run(inviteId, batchFieldId, Number(parsedKey[0]), parsedKey[1]);
        scopeFieldIds.push(batchFieldId);
      }
      invitations.push({ id: inviteId, label: invite.label, token: raw, scopeFieldIds });
    }

    addBatchEvent(receipt.receipt_no, 'review.batch.created', {
      batchId,
      invitationCount: invitations.length,
      fields: config.fields.map((f) => ({ key: f.key, acceptThreshold: f.acceptThreshold, rejectThreshold: f.rejectThreshold })),
    });
    return { ok: true, batchId, invitations };
  });
}

// ---------------------------------------------------------------------------
// 办理人：批次列表 / 详情
// ---------------------------------------------------------------------------
function listInvitationScope(invitationId) {
  return db.prepare(`
    SELECT batch_field_id, step, field FROM review_batch_invitation_fields
    WHERE invitation_id = ? ORDER BY step, field
  `).all(invitationId);
}

function invitationOwnerView(row) {
  const status = effectiveBatchInviteStatus(row);
  return {
    id: row.id,
    batchId: row.batch_id,
    label: row.label,
    status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at || null,
    revokedAt: row.revoked_at || null,
    fields: listInvitationScope(row.id).map((item) => ({
      batchFieldId: item.batch_field_id,
      key: batchFieldKey(item.step, item.field),
      step: item.step,
      field: item.field,
      label: batchFieldLabel(item.step, item.field),
    })),
  };
}

function listOpinionsForFieldTx(batchFieldId) {
  return db.prepare(`
    SELECT * FROM review_batch_opinions
    WHERE batch_field_id = ? ORDER BY created_at ASC
  `).all(batchFieldId).map((row) => opinionView(row));
}

function opinionView(row, { forOwner = false } = {}) {
  const out = {
    id: row.id,
    batchId: row.batch_id,
    batchFieldId: row.batch_field_id,
    invitationId: row.batch_invitation_id,
    step: row.step,
    field: row.field,
    key: batchFieldKey(row.step, row.field),
    fieldLabel: row.field_label,
    reviewerLabel: row.reviewer_label,
    valueSnapshot: row.value_snapshot,
    reason: row.reason,
    submittedAt: row.created_at,
    correctionReceiptNo: row.correction_receipt_no || '',
  };
  if (forOwner) out.sessionId = row.session_id;
  return out;
}

function fieldOwnerView(row) {
  const opinions = listOpinionsForFieldTx(row.id);
  const reviewerIds = new Set(opinions.map((item) => item.invitationId));
  return {
    id: row.id,
    batchId: row.batch_id,
    key: batchFieldKey(row.step, row.field),
    step: row.step,
    field: row.field,
    label: row.field_label,
    acceptThreshold: row.accept_threshold,
    rejectThreshold: row.reject_threshold,
    decision: row.decision || null,
    decidedAt: row.decided_at || null,
    decidedBy: row.decided_by_user_id ? (userQueries.findById(row.decided_by_user_id)?.display_name || '') : '',
    decisionReason: row.decision_reason || '',
    correctionWorkflowId: row.correction_workflow_id || null,
    correctionReceiptNo: row.correction_receipt_no || '',
    opinionCount: opinions.length,
    distinctReviewerCount: reviewerIds.size,
    opinions,
  };
}

function listBatchFieldsTx(batchId) {
  return db.prepare('SELECT * FROM review_batch_fields WHERE batch_id = ? ORDER BY step, field').all(batchId)
    .map((row) => fieldOwnerView(row));
}

function batchOwnerView(row, { withDetails = true } = {}) {
  const invitations = db.prepare(`
    SELECT * FROM review_batch_invitations WHERE batch_id = ? ORDER BY created_at ASC
  `).all(row.id);
  const fields = withDetails ? listBatchFieldsTx(row.id) : [];
  const status = effectiveBatchStatus(row);
  return {
    id: row.id,
    receiptNo: row.receipt_no,
    status,
    note: row.note || '',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    cancelledAt: row.cancelled_at || null,
    cancelReason: row.cancel_reason || '',
    invitationCount: row.invitation_count,
    validatedCount: invitations.filter((item) => item.used_at).length,
    revokedCount: invitations.filter((item) => item.status === 'revoked' || item.revoked_at).length,
    expiredCount: invitations.filter((item) => effectiveBatchInviteStatus(item) === 'expired').length,
    invitations: withDetails ? invitations.map((item) => invitationOwnerView(item)) : [],
    fields,
  };
}

// collecting 阶段若有邀请被撤销/过期：批次无法进入复核，办理人只能取消后重建
function effectiveBatchStatus(row) {
  if (row.status !== 'collecting') return row.status;
  const invites = db.prepare('SELECT * FROM review_batch_invitations WHERE batch_id = ?').all(row.id);
  if (invites.some((item) => item.status === 'revoked' || item.revoked_at || effectiveBatchInviteStatus(item) === 'expired')) {
    return 'collecting';
  }
  return 'collecting';
}

export function getBatchForOwner({ userId, batchId }) {
  const row = db.prepare('SELECT * FROM review_batches WHERE id = ? AND user_id = ?').get(batchId, userId);
  return row ? batchOwnerView(row) : null;
}

export function listBatchesForOwner(userId, { receiptNo = '' } = {}) {
  const rows = receiptNo
    ? db.prepare('SELECT * FROM review_batches WHERE user_id = ? AND receipt_no = ? ORDER BY created_at DESC').all(userId, receiptNo)
    : db.prepare('SELECT * FROM review_batches WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  return rows.map((row) => batchOwnerView(row));
}

// ---------------------------------------------------------------------------
// 进入复核（显式开启）：只有全部邀请都已完成一次性校验才允许
// ---------------------------------------------------------------------------
export function startReviewBatch({ userId, batchId }) {
  return immediateTransaction(() => {
    const row = loadBatchTx(batchId);
    if (!row || row.user_id !== userId) {
      return { ok: false, status: 404, code: 'BATCH_NOT_FOUND', message: '复核批次不存在' };
    }
    if (row.status === 'in_review') {
      return { ok: false, status: 409, code: 'BATCH_ALREADY_STARTED', message: '批次已进入复核', batch: batchOwnerView(row) };
    }
    if (row.status === 'completed' || row.status === 'cancelled') {
      return { ok: false, status: 409, code: 'BATCH_NOT_ACTIVE', message: '批次已终结，不能再进入复核', batch: batchOwnerView(row) };
    }
    const invites = db.prepare('SELECT * FROM review_batch_invitations WHERE batch_id = ?').all(batchId);
    const dead = invites.find((item) => item.status === 'revoked' || item.revoked_at || effectiveBatchInviteStatus(item) === 'expired');
    if (dead) {
      return {
        ok: false,
        status: 409,
        code: 'BATCH_GATE_INVITATION_INVALID',
        message: `邀请「${dead.label}」已撤销或过期，批次无法进入复核；请取消本批次后重新创建`,
        batch: batchOwnerView(row),
      };
    }
    const unvalidated = invites.filter((item) => !item.used_at);
    if (unvalidated.length > 0) {
      return {
        ok: false,
        status: 409,
        code: 'BATCH_GATE_NOT_SATISFIED',
        message: `尚有 ${unvalidated.length} 个邀请未完成一次性校验，批次不能进入复核`,
        pending: unvalidated.map((item) => ({ id: item.id, label: item.label })),
        batch: batchOwnerView(row),
      };
    }
    const ts = now();
    db.prepare("UPDATE review_batches SET status = 'in_review', started_at = ? WHERE id = ? AND status = 'collecting'")
      .run(ts, batchId);
    addBatchEvent(row.receipt_no, 'review.batch.started', { batchId });
    return { ok: true, batch: batchOwnerView(loadBatchTx(batchId)) };
  });
}

// ---------------------------------------------------------------------------
// 取消批次：仅 collecting 阶段允许（进入复核前，尚未产生任何决议）
// ---------------------------------------------------------------------------
export function cancelReviewBatch({ userId, batchId, reason }) {
  const text = String(reason || '').trim().slice(0, 200);
  return immediateTransaction(() => {
    const row = loadBatchTx(batchId);
    if (!row || row.user_id !== userId) {
      return { ok: false, status: 404, code: 'BATCH_NOT_FOUND', message: '复核批次不存在' };
    }
    if (row.status === 'cancelled') {
      return { ok: false, status: 409, code: 'BATCH_ALREADY_CANCELLED', message: '批次已取消', batch: batchOwnerView(row) };
    }
    if (row.status === 'completed') {
      return { ok: false, status: 409, code: 'BATCH_NOT_ACTIVE', message: '批次已完成，不能取消', batch: batchOwnerView(row) };
    }
    if (row.status === 'in_review') {
      const decided = db.prepare("SELECT COUNT(*) AS n FROM review_batch_fields WHERE batch_id = ? AND decision IS NOT NULL").get(batchId).n;
      if (decided > 0) {
        return { ok: false, status: 409, code: 'BATCH_HAS_DECISIONS', message: '批次已有字段决议，不能取消；请完成或通过放弃更正回收后处理', batch: batchOwnerView(row) };
      }
    }
    const ts = now();
    // 撤销全部仍可用的邀请并删除其会话；已提交的意见随批次状态留档
    db.prepare(`
      UPDATE review_batch_invitations
      SET status = 'revoked', revoked_at = ?
      WHERE batch_id = ? AND revoked_at IS NULL AND used_at IS NULL
    `).run(ts, batchId);
    db.prepare('DELETE FROM review_batch_sessions WHERE batch_id = ?').run(batchId);
    db.prepare(`
      UPDATE review_batches SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
      WHERE id = ?
    `).run(ts, text, batchId);
    addBatchEvent(row.receipt_no, 'review.batch.cancelled', { batchId, reason: text });
    return { ok: true, batch: batchOwnerView(loadBatchTx(batchId)) };
  });
}

// ---------------------------------------------------------------------------
// 撤销批次内单个邀请（使用前；已使用不能撤销）
// ---------------------------------------------------------------------------
export function revokeBatchInvitation({ userId, invitationId }) {
  return immediateTransaction(() => {
    const invite = db.prepare(`
      SELECT i.* FROM review_batch_invitations i
      JOIN review_batches b ON b.id = i.batch_id
      WHERE i.id = ? AND b.user_id = ?
    `).get(invitationId, userId);
    if (!invite) return { ok: false, status: 404, code: 'BATCH_INVITATION_NOT_FOUND', message: '批次邀请不存在' };
    if (invite.status === 'revoked' || invite.revoked_at) {
      return { ok: false, status: 409, code: 'BATCH_INVITATION_ALREADY_REVOKED', message: '邀请已撤销', invitation: invitationOwnerView(invite) };
    }
    if (invite.used_at) {
      return { ok: false, status: 409, code: 'INVITATION_ALREADY_USED', message: '邀请链接已被使用，不能撤销；该复核人的会话随批次状态管理', invitation: invitationOwnerView(invite) };
    }
    const ts = now();
    db.prepare("UPDATE review_batch_invitations SET status = 'revoked', revoked_at = ? WHERE id = ?").run(ts, invite.id);
    addBatchEvent(invite.receipt_no, 'review.batch.invitation.revoked', {
      batchId: invite.batch_id, invitationId: invite.id, label: invite.label,
    });
    return { ok: true, invitation: invitationOwnerView(db.prepare('SELECT * FROM review_batch_invitations WHERE id = ?').get(invite.id)) };
  });
}

// ---------------------------------------------------------------------------
// 复核人：一次性邀请校验 → 免登录批次会话（只能看到该邀请被授权的字段）
// ---------------------------------------------------------------------------
export function consumeBatchInvitation({ rawToken, clientIp }) {
  return immediateTransaction(() => {
    const invite = db.prepare('SELECT * FROM review_batch_invitations WHERE token_hash = ?').get(sha256(rawToken));
    if (!invite) return { ok: false, status: 404, code: 'BATCH_INVITATION_NOT_FOUND' };
    const batch = loadBatchTx(invite.batch_id);
    if (!batch) return { ok: false, status: 404, code: 'BATCH_NOT_FOUND' };
    if (batch.status === 'cancelled' || invite.status === 'revoked' || invite.revoked_at) {
      return { ok: false, status: 410, code: 'BATCH_INVITATION_REVOKED' };
    }
    if (batch.status === 'completed') {
      return { ok: false, status: 410, code: 'BATCH_NOT_ACTIVE' };
    }
    if (invite.used_at || invite.status === 'used') {
      return { ok: false, status: 410, code: 'BATCH_INVITATION_ALREADY_USED' };
    }
    if (invite.expires_at <= now() || batch.expires_at <= now()) {
      db.prepare("UPDATE review_batch_invitations SET status = 'expired' WHERE id = ?").run(invite.id);
      return { ok: false, status: 410, code: 'BATCH_INVITATION_EXPIRED' };
    }
    const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(invite.receipt_no);
    if (!receipt) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND' };
    if (receipt.status === 'revoked') return { ok: false, status: 410, code: 'RECEIPT_REVOKED' };

    const ts = now();
    db.prepare(`
      UPDATE review_batch_invitations
      SET status = 'used', used_at = ?, used_ip = ?
      WHERE id = ? AND used_at IS NULL
    `).run(ts, String(clientIp || '').slice(0, 64), invite.id);

    const sessionRaw = tokenUrlSafe();
    const sessionId = cryptoId();
    const csrf = tokenUrlSafe();
    const expiry = Math.min(invite.expires_at, batch.expires_at);
    db.prepare(`
      INSERT INTO review_batch_sessions
        (id, batch_id, batch_invitation_id, receipt_no, label, token_hash, csrf_secret,
         created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, batch.id, invite.id, receipt.receipt_no, invite.label, sha256(sessionRaw), csrf, ts, expiry, ts);

    addBatchEvent(receipt.receipt_no, 'review.batch.invitation.consumed', {
      batchId: batch.id, invitationId: invite.id, label: invite.label,
    });

    // 事务内探测是否刚好全部校验完成（自动开门），保证“全部校验后即可进入复核”
    const remaining = db.prepare(`
      SELECT COUNT(*) AS n FROM review_batch_invitations
      WHERE batch_id = ? AND used_at IS NULL
        AND revoked_at IS NULL AND status <> 'revoked' AND expires_at > ?
    `).get(batch.id, ts).n;
    let autoStarted = false;
    if (remaining === 0 && batch.status === 'collecting') {
      db.prepare("UPDATE review_batches SET status = 'in_review', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'collecting'")
        .run(ts, batch.id);
      autoStarted = true;
      addBatchEvent(receipt.receipt_no, 'review.batch.started', { batchId: batch.id, auto: true });
    }

    return {
      ok: true,
      sessionToken: sessionRaw,
      sessionId,
      csrf,
      batchId: batch.id,
      receiptNo: receipt.receipt_no,
      label: invite.label,
      expiresAt: expiry,
      autoStarted,
    };
  });
}

export function getValidBatchSession(rawToken) {
  if (!rawToken) return null;
  const session = db.prepare('SELECT * FROM review_batch_sessions WHERE token_hash = ?').get(sha256(rawToken));
  if (!session || session.expires_at <= now()) return null;
  const invite = db.prepare('SELECT * FROM review_batch_invitations WHERE id = ?').get(session.batch_invitation_id);
  if (!invite || invite.status === 'revoked' || invite.revoked_at) return null;
  if (invite.expires_at <= now()) return null;
  const batch = loadBatchTx(session.batch_id);
  // 批次取消后会话立即失效；批次完成后会话保留为只读（复核人仍可查看字段决议结果）
  if (!batch || batch.status === 'cancelled') return null;
  db.prepare('UPDATE review_batch_sessions SET last_seen_at = ? WHERE id = ?').run(now(), session.id);
  return { session, invite, batch };
}

export function deleteBatchSession(rawToken) {
  if (!rawToken) return;
  const session = db.prepare('SELECT * FROM review_batch_sessions WHERE token_hash = ?').get(sha256(rawToken));
  if (session) db.prepare('DELETE FROM review_batch_sessions WHERE id = ?').run(session.id);
}

function sessionAuthorizedFieldRows(sessionId) {
  return db.prepare(`
    SELECT s.* FROM review_batch_invitation_fields s
    JOIN review_batch_sessions bs ON bs.batch_invitation_id = s.invitation_id
    WHERE bs.id = ?
  `).all(sessionId);
}

// 复核人上下文：只返回本邀请被授权的脱敏字段 + 本人已提交意见 + 批次状态
export function getBatchReviewerContext(review) {
  const { session, invite, batch } = review;
  const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(session.receipt_no);
  if (!receipt) return null;
  if (receipt.status === 'revoked') {
    return {
      batchId: batch.id,
      receiptNo: receipt.receipt_no,
      label: session.label,
      status: 'revoked',
      batchStatus: batch.status,
      revokedAt: receipt.revoked_at,
      expiresAt: session.expires_at,
      view: null,
      opinions: [],
      canSubmit: false,
    };
  }
  const scope = sessionAuthorizedFieldRows(session.id);
  const authorizedKeys = scope.map((item) => batchFieldKey(item.step, item.field));
  const snapshot = JSON.parse(receipt.snapshot_json);
  const myOpinions = db.prepare(`
    SELECT * FROM review_batch_opinions WHERE session_id = ? ORDER BY created_at ASC
  `).all(session.id).map((row) => opinionView(row));

  // 同一字段的多份意见合并展示（只包含本邀请被授权字段），逐字保留每位复核人原始说明
  const fieldRows = db.prepare(`
    SELECT * FROM review_batch_fields WHERE batch_id = ? ORDER BY step, field
  `).all(batch.id);
  const byKey = new Map(scope.map((item) => [batchFieldKey(item.step, item.field), item.batch_field_id]));
  const merged = fieldRows
    .filter((fieldRow) => byKey.has(batchFieldKey(fieldRow.step, fieldRow.field)))
    .map((fieldRow) => {
      const opinions = listOpinionsForFieldTx(fieldRow.id);
      return {
        key: batchFieldKey(fieldRow.step, fieldRow.field),
        step: fieldRow.step,
        field: fieldRow.field,
        label: fieldRow.field_label,
        acceptThreshold: fieldRow.accept_threshold,
        rejectThreshold: fieldRow.reject_threshold,
        decision: fieldRow.decision || null,
        decidedAt: fieldRow.decided_at || null,
        decisionReason: fieldRow.decision_reason || '',
        opinionCount: opinions.length,
        opinions: opinions.map((opinion) => ({
          id: opinion.id,
          reviewerLabel: opinion.reviewerLabel,
          reason: opinion.reason,
          valueSnapshot: opinion.valueSnapshot,
          submittedAt: opinion.submittedAt,
          mine: opinion.invitationId === invite.id,
        })),
      };
    });

  return {
    batchId: batch.id,
    receiptNo: receipt.receipt_no,
    label: session.label,
    status: receipt.status,
    batchStatus: batch.status,
    collecting: batch.status === 'collecting',
    canSubmit: batch.status === 'in_review',
    issuedAt: receipt.issued_at,
    completedAt: snapshot.completedAt,
    expiresAt: session.expires_at,
    view: buildBatchReviewView(snapshot, authorizedKeys),
    opinions: myOpinions,
    merged,
  };
}

// ---------------------------------------------------------------------------
// 复核人提交字段意见：只能针对授权字段；批次必须在复核中；每邀请每字段至多一条
// ---------------------------------------------------------------------------
export function submitBatchOpinion({ review, key, reason, idempotencyKey, requestHash }) {
  return immediateTransaction(() => {
    const { session, invite, batch } = review;
    if (batch.status === 'cancelled') return { ok: false, status: 410, code: 'BATCH_NOT_ACTIVE' };
    if (invite.status === 'revoked' || invite.revoked_at) return { ok: false, status: 410, code: 'BATCH_INVITATION_REVOKED' };
    if (invite.expires_at <= now() || session.expires_at <= now()) return { ok: false, status: 410, code: 'BATCH_INVITATION_EXPIRED' };
    const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(session.receipt_no);
    if (!receipt) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND' };
    if (receipt.status === 'revoked') return { ok: false, status: 410, code: 'RECEIPT_REVOKED' };
    if (batch.status !== 'in_review') {
      return { ok: false, status: 409, code: 'BATCH_GATE_NOT_SATISFIED', message: '批次邀请尚未全部完成校验，暂不能提交意见' };
    }

    const parsed = typeof key === 'string'
      ? { step: Number(key.split('.')[0]), field: key.split('.')[1] }
      : null;
    if (!parsed || !STEPS[parsed.step] || !Object.prototype.hasOwnProperty.call(STEPS[parsed.step].fields, parsed.field)) {
      return { ok: false, status: 400, code: 'BATCH_FIELD_NOT_FOUND', message: '字段不存在' };
    }
    const batchField = db.prepare(`
      SELECT bf.* FROM review_batch_fields bf
      JOIN review_batch_invitation_fields bif
        ON bif.batch_field_id = bf.id AND bif.invitation_id = ?
      WHERE bf.batch_id = ? AND bf.step = ? AND bf.field = ?
    `).get(invite.id, batch.id, parsed.step, parsed.field);
    if (!batchField) {
      return { ok: false, status: 403, code: 'BATCH_FIELD_NOT_AUTHORIZED', message: '本邀请未被授权查看该字段，不能针对它提交意见' };
    }
    if (batchField.decision) {
      return { ok: false, status: 409, code: 'BATCH_FIELD_ALREADY_DECIDED', message: '该字段已有最终决议，不能再提交意见' };
    }
    const text = String(reason || '').trim();
    if (text.length < BATCH_OPINION_MIN || text.length > BATCH_OPINION_MAX) {
      return { ok: false, status: 400, code: 'INVALID_REASON', message: `意见说明需为 ${BATCH_OPINION_MIN}-${BATCH_OPINION_MAX} 个字符` };
    }

    const prior = db.prepare(`
      SELECT * FROM review_batch_opinions WHERE session_id = ? AND idempotency_key = ?
    `).get(session.id, idempotencyKey);
    if (prior) {
      if (prior.request_hash !== requestHash) {
        return { ok: false, status: 409, code: 'OBJECTION_DUPLICATE_KEY', message: '该提交编号已用于其他内容' };
      }
      return { ok: true, replay: true, opinion: opinionView(prior) };
    }

    // 同一邀请对同一字段至多一条意见（UNIQUE 兜底并发重复提交）
    const dup = db.prepare(`
      SELECT id FROM review_batch_opinions WHERE batch_invitation_id = ? AND batch_field_id = ?
    `).get(invite.id, batchField.id);
    if (dup) {
      return { ok: false, status: 409, code: 'BATCH_FIELD_DUPLICATE_OPINION', message: '你已就该字段提交过意见，不能重复提交' };
    }

    const snapshot = JSON.parse(receipt.snapshot_json);
    const valueSnapshot = batchFieldTextValue(snapshot, parsed.step, parsed.field);
    const ts = now();
    const id = cryptoId();
    try {
      db.prepare(`
        INSERT INTO review_batch_opinions
          (id, batch_id, batch_field_id, batch_invitation_id, session_id, receipt_no, user_id,
           step, field, reviewer_label, field_label, value_snapshot, reason,
           idempotency_key, request_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, batch.id, batchField.id, invite.id, session.id, receipt.receipt_no, batch.user_id,
        parsed.step, parsed.field, invite.label, batchField.field_label, valueSnapshot, text,
        idempotencyKey, requestHash, ts,
      );
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE')) {
        return { ok: false, status: 409, code: 'BATCH_FIELD_DUPLICATE_OPINION', message: '你已就该字段提交过意见，不能重复提交' };
      }
      throw error;
    }

    addBatchEvent(receipt.receipt_no, 'review.batch.opinion.submitted', {
      batchId: batch.id, invitationId: invite.id, batchFieldId: batchField.id, opinionId: id,
      label: invite.label, step: parsed.step, field: parsed.field,
    });
    return { ok: true, opinion: opinionView(db.prepare('SELECT * FROM review_batch_opinions WHERE id = ?').get(id)) };
  });
}

// 事务内：取得/创建指向 source 回执的更正办理（与普通复核接受逻辑一致）
function obtainCorrectionWorkflowTx(source) {
  let workflow = getActiveWorkflow(source.user_id);
  if (workflow && workflow.source_receipt_no !== source.receipt_no) {
    return { conflict: true, workflow };
  }
  let created = false;
  if (!workflow) {
    if (!correctionFactory) throw new Error('correction factory not bound');
    workflow = correctionFactory(source);
    created = true;
  }
  return { workflow, created };
}

// 由 db.js 在模块初始化后注入：避免 ESM 循环依赖导致的未初始化绑定
let correctionFactory = null;
export function bindCorrectionFactory(fn) {
  correctionFactory = fn;
}

function batchConflict(message) {
  return { ok: false, status: 409, code: 'BATCH_NOT_ACTIVE', message };
}

// ---------------------------------------------------------------------------
// 办理人逐字段决议：接受（必须达到接受阈值）或驳回（必须满足驳回阈值+理由）
// 同一字段接受的全部意见进入同一份更正办理并关联全部意见。
// ---------------------------------------------------------------------------
export function decideBatchField({ userId, batchId, batchFieldId, action, reason }) {
  const reasonText = String(reason || '').trim();
  return immediateTransaction(() => {
    const batch = loadBatchTx(batchId);
    if (!batch || batch.user_id !== userId) {
      return { ok: false, status: 404, code: 'BATCH_NOT_FOUND', message: '复核批次不存在' };
    }
    if (batch.status === 'cancelled') return batchConflict('批次已取消，不能作出决议');
    if (batch.status === 'completed') {
      const fieldRow = db.prepare('SELECT * FROM review_batch_fields WHERE id = ? AND batch_id = ?').get(batchFieldId, batchId);
      if (fieldRow) return { ok: false, status: 409, code: 'BATCH_FIELD_ALREADY_DECIDED', message: '批次已完成', field: fieldOwnerView(fieldRow) };
      return { ok: false, status: 404, code: 'BATCH_FIELD_NOT_FOUND', message: '字段不存在' };
    }
    if (batch.status !== 'in_review') {
      return { ok: false, status: 409, code: 'BATCH_GATE_NOT_SATISFIED', message: '批次尚未进入复核，不能作出决议', batch: batchOwnerView(batch) };
    }
    const fieldRow = db.prepare('SELECT * FROM review_batch_fields WHERE id = ? AND batch_id = ?').get(batchFieldId, batchId);
    if (!fieldRow) return { ok: false, status: 404, code: 'BATCH_FIELD_NOT_FOUND', message: '字段不存在或未纳入本批次编排' };

    // 重复决议：明确失败，并返回已经存在的同一结果
    if (fieldRow.decision) {
      return {
        ok: false,
        status: 409,
        code: 'BATCH_FIELD_ALREADY_DECIDED',
        message: `该字段已决议为「${fieldRow.decision === 'accepted' ? '接受' : '驳回'}」，重复决议返回同一结果`,
        field: fieldOwnerView(fieldRow),
      };
    }

    const opinions = db.prepare(`
      SELECT * FROM review_batch_opinions WHERE batch_field_id = ?
    `).all(batchFieldId);
    const distinctReviewers = new Set(opinions.map((item) => item.batch_invitation_id));
    const supportCount = distinctReviewers.size;

    if (action === 'accept') {
      if (supportCount < fieldRow.accept_threshold) {
        return {
          ok: false,
          status: 409,
          code: 'ACCEPT_THRESHOLD_NOT_MET',
          message: `该字段只有 ${supportCount} 位复核人提出意见，未达到接受阈值 ${fieldRow.accept_threshold}，不能接受`,
          field: fieldOwnerView(fieldRow),
        };
      }
      const source = db.prepare('SELECT * FROM receipts WHERE receipt_no = ? AND user_id = ?').get(batch.receipt_no, userId);
      if (!source) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND', message: '原回执不存在' };
      const obtained = obtainCorrectionWorkflowTx(source);
      if (obtained.conflict) {
        return {
          ok: false,
          status: 409,
          code: 'OPEN_WORKFLOW_EXISTS',
          message: '已有进行中的其他办理，请先完成或放弃后再接受字段意见',
          workflow: publicWorkflow(obtained.workflow, getSteps(obtained.workflow.id)),
          field: fieldOwnerView(fieldRow),
        };
      }
      const { workflow, created } = obtained;
      const ts = now();
      const updated = db.prepare(`
        UPDATE review_batch_fields
        SET decision = 'accepted', decided_at = ?, decided_by_user_id = ?, decision_reason = '',
            correction_workflow_id = ?, correction_receipt_no = ''
        WHERE id = ? AND decision IS NULL
      `).run(ts, userId, workflow.id, batchFieldId);
      if (updated.changes === 0) {
        // 并发决议抢跑：返回已存在的同一决议
        return {
          ok: false,
          status: 409,
          code: 'BATCH_FIELD_ALREADY_DECIDED',
          message: '该字段刚被另一个页面决议，重复决议返回同一结果',
          field: fieldOwnerView(loadBatchFieldRow(batchFieldId)),
        };
      }
      for (const opinion of opinions) {
        db.prepare(`
          INSERT OR IGNORE INTO correction_objections (workflow_id, objection_id, batch_opinion_id, created_at)
          VALUES (?, NULL, ?, ?)
        `).run(workflow.id, opinion.id, ts);
      }
      addBatchEvent(batch.receipt_no, 'review.batch.field.accepted', {
        batchId, batchFieldId, workflowId: workflow.id, created, opinionIds: opinions.map((item) => item.id),
      });
      const result = maybeCompleteBatchTx(batch);
      return {
        ok: true,
        created,
        field: fieldOwnerView(loadBatchFieldRow(batchFieldId)),
        workflow: publicWorkflow(workflow, getSteps(workflow.id)),
        batch: result.batch,
        batchCompleted: result.completed,
      };
    }

    if (action === 'reject') {
      if (reasonText.length < BATCH_OPINION_MIN || reasonText.length > BATCH_REJECT_REASON_MAX) {
        return { ok: false, status: 400, code: 'REJECT_REASON_REQUIRED', message: `驳回理由需为 ${BATCH_OPINION_MIN}-${BATCH_REJECT_REASON_MAX} 个字符` };
      }
      // 驳回阈值：没有提出异议（即支持驳回）的复核人数必须达到阈值。
      // 已撤销/过期邀请不计入分母：以“已完成校验的有效邀请”为复核人总数。
      const validatedInvites = db.prepare(`
        SELECT COUNT(DISTINCT id) AS n FROM review_batch_invitations
        WHERE batch_id = ? AND used_at IS NOT NULL AND revoked_at IS NULL
      `).get(batchId).n;
      const rejectSupport = validatedInvites - supportCount;
      if (rejectSupport < fieldRow.reject_threshold) {
        return {
          ok: false,
          status: 409,
          code: 'REJECT_THRESHOLD_NOT_MET',
          message: `该字段有 ${supportCount} 位复核人提出意见，支持驳回的复核人仅 ${rejectSupport} 位，未达到驳回阈值 ${fieldRow.reject_threshold}，不能驳回`,
          field: fieldOwnerView(fieldRow),
        };
      }
      const ts = now();
      const updated = db.prepare(`
        UPDATE review_batch_fields
        SET decision = 'rejected', decided_at = ?, decided_by_user_id = ?, decision_reason = ?
        WHERE id = ? AND decision IS NULL
      `).run(ts, userId, reasonText, batchFieldId);
      if (updated.changes === 0) {
        return {
          ok: false,
          status: 409,
          code: 'BATCH_FIELD_ALREADY_DECIDED',
          message: '该字段刚被另一个页面决议，重复决议返回同一结果',
          field: fieldOwnerView(loadBatchFieldRow(batchFieldId)),
        };
      }
      addBatchEvent(batch.receipt_no, 'review.batch.field.rejected', {
        batchId, batchFieldId, reason: reasonText,
      });
      const result = maybeCompleteBatchTx(batch);
      return {
        ok: true,
        field: fieldOwnerView(loadBatchFieldRow(batchFieldId)),
        batch: result.batch,
        batchCompleted: result.completed,
      };
    }

    return { ok: false, status: 400, code: 'INVALID_ACTION', message: '决议类型必须是 accept 或 reject' };
  });
}

// 全部字段都有终局决议后批次自动完成
function maybeCompleteBatchTx(batch) {
  const pending = db.prepare(`
    SELECT COUNT(*) AS n FROM review_batch_fields WHERE batch_id = ? AND decision IS NULL
  `).get(batch.id).n;
  if (pending > 0) return { completed: false, batch: batchOwnerView(loadBatchTx(batch.id)) };
  const ts = now();
  db.prepare("UPDATE review_batches SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'in_review'")
    .run(ts, batch.id);
  addBatchEvent(batch.receipt_no, 'review.batch.completed', { batchId: batch.id });
  return { completed: true, batch: batchOwnerView(loadBatchTx(batch.id)) };
}

// ---------------------------------------------------------------------------
// 更正完成：把新回执编号回填到批次字段与意见；放弃更正：决议回收为待决议
// ---------------------------------------------------------------------------
// 在调用方事务内执行（更正完成签发回执的同一事务）：回填新回执编号与来源关系
export function attachCorrectionReceiptForBatch({ workflowId, receiptNo }) {
  const links = db.prepare(`
    SELECT DISTINCT batch_opinion_id FROM correction_objections
    WHERE workflow_id = ? AND batch_opinion_id IS NOT NULL
  `).all(workflowId);
  if (links.length === 0) return;
  const opinionRows = db.prepare(`
    SELECT * FROM review_batch_opinions WHERE id IN (${links.map(() => '?').join(',')})
  `).all(...links.map((item) => item.batch_opinion_id));
  const fieldIds = [...new Set(opinionRows.map((row) => row.batch_field_id))];
  const batchIds = new Set(opinionRows.map((row) => row.batch_id));
  for (const fieldId of fieldIds) {
    db.prepare('UPDATE review_batch_fields SET correction_receipt_no = ? WHERE id = ?').run(receiptNo, fieldId);
  }
  for (const opinion of opinionRows) {
    db.prepare('UPDATE review_batch_opinions SET correction_receipt_no = ? WHERE id = ?').run(receiptNo, opinion.id);
  }
  for (const batchId of batchIds) {
    const batch = loadBatchTx(batchId);
    if (batch) addBatchEvent(batch.receipt_no, 'review.batch.correction.completed', { batchId, receiptNo, fieldIds });
  }
}

// 在调用方事务内执行（放弃更正的同一事务）：接受字段决议回收为待决议
export function reopenBatchDecisionsForWorkflow(workflowId) {
  const links = db.prepare(`
    SELECT DISTINCT batch_opinion_id FROM correction_objections
    WHERE workflow_id = ? AND batch_opinion_id IS NOT NULL
  `).all(workflowId);
  if (links.length === 0) return [];
  const opinionRows = db.prepare(`
    SELECT * FROM review_batch_opinions WHERE id IN (${links.map(() => '?').join(',')})
  `).all(...links.map((item) => item.batch_opinion_id));
  const fieldIds = [...new Set(opinionRows.map((row) => row.batch_field_id))];
  const batchIds = [...new Set(opinionRows.map((row) => row.batch_id))];
  db.prepare(`
    UPDATE review_batch_fields
    SET decision = NULL, decided_at = NULL, decided_by_user_id = NULL, decision_reason = '',
        correction_workflow_id = NULL, correction_receipt_no = ''
    WHERE id IN (${fieldIds.map(() => '?').join(',')}) AND decision = 'accepted'
  `).run(...fieldIds);
  db.prepare(`
    UPDATE review_batch_opinions SET correction_receipt_no = ''
    WHERE id IN (${opinionRows.map(() => '?').join(',')})
  `).run(...opinionRows.map((row) => row.id));
  // 批次从 completed 回到 in_review（放弃更正意味着接受的字段需要重新决议）
  db.prepare(`
    UPDATE review_batches SET status = 'in_review', completed_at = NULL
    WHERE id IN (${batchIds.map(() => '?').join(',')}) AND status = 'completed'
  `).run(...batchIds);
  for (const batchId of batchIds) {
    const batch = loadBatchTx(batchId);
    if (batch) addBatchEvent(batch.receipt_no, 'review.batch.reopened', { batchId, fieldIds });
  }
  return fieldIds;
}

// ---------------------------------------------------------------------------
// 时间线：在对应回执后插入批次条目（含逐字段意见合并与决议、来源关系）
// ---------------------------------------------------------------------------
export function buildBatchTimelineEntries(userId) {
  const batches = db.prepare('SELECT * FROM review_batches WHERE user_id = ? ORDER BY created_at ASC').all(userId);
  const result = [];
  for (const row of batches) {
    const view = batchOwnerView(row);
    const invitationSummaries = view.invitations.map((invite) => ({
      id: invite.id,
      label: invite.label,
      status: invite.status,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      usedAt: invite.usedAt,
      revokedAt: invite.revokedAt,
      fieldKeys: invite.fields.map((field) => field.key),
    }));
    const fields = view.fields.map((field) => ({
      id: field.id,
      key: field.key,
      step: field.step,
      field: field.field,
      label: field.label,
      acceptThreshold: field.acceptThreshold,
      rejectThreshold: field.rejectThreshold,
      decision: field.decision,
      decidedAt: field.decidedAt,
      decidedBy: field.decidedBy,
      decisionReason: field.decisionReason,
      correctionWorkflowId: field.correctionWorkflowId,
      correctionReceiptNo: field.correctionReceiptNo,
      opinionCount: field.opinionCount,
      // 同一字段多份意见合并展示，但保留每位复核人的原始说明
      opinions: field.opinions.map((opinion) => ({
        id: opinion.id,
        reviewerLabel: opinion.reviewerLabel,
        reason: opinion.reason,
        valueSnapshot: opinion.valueSnapshot,
        submittedAt: opinion.submittedAt,
        correctionReceiptNo: opinion.correctionReceiptNo,
      })),
    }));
    result.push({
      kind: 'reviewBatch',
      batchId: row.id,
      receiptNo: row.receipt_no,
      status: view.status,
      note: row.note,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      cancelledAt: row.cancelled_at,
      cancelReason: row.cancel_reason,
      invitationCount: row.invitation_count,
      validatedCount: view.validatedCount,
      invitations: invitationSummaries,
      fields,
    });
  }
  return result;
}

export { ALL_BATCH_FIELDS, BATCH_MAX_INVITATIONS };
