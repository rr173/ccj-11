// ---------------------------------------------------------------------------
// 复核申诉回合的持久化与事务编排
//
// 申诉回合只能【引用】原批次的冻结快照：本模块不写任何 review_batches /
// review_batch_fields / review_batch_opinions 行（原批次的意见、决议、超时结果
// 一律不可修改）。所有终局状态变更都在 BEGIN IMMEDIATE 事务中以“当前状态 +
// 行级条件更新”为唯一判定：并发发起/决议/取消只有一个请求成功。
// ---------------------------------------------------------------------------
import { db, immediateTransaction, cryptoId, getActiveWorkflow, getSteps, userQueries, publicWorkflow } from './db.js';
import { sha256, tokenUrlSafe } from './crypto.js';
import {
  APPEAL_OPINION_MAX,
  APPEAL_OPINION_MIN,
  APPEAL_REJECT_REASON_MAX,
  APPEAL_ERRORS,
  appealFieldLabel,
  appealReasonLabel,
  buildAppealReviewView,
} from './appealReviews.js';
import { batchFieldKey, batchFieldTextValue } from './batchReviews.js';

function now() {
  return Date.now();
}

// 申诉事件写入原回执对应办理记录的审计时间线，与原批次事件流并列、按 type 区分
function addAppealEvent(receiptNo, type, detail) {
  const row = db.prepare('SELECT workflow_id FROM receipts WHERE receipt_no = ?').get(receiptNo);
  if (!row) return;
  db.prepare(`
    INSERT INTO events (workflow_id, type, step, detail_json, created_at)
    VALUES (?, ?, NULL, ?, ?)
  `).run(row.workflow_id, type, JSON.stringify({ receiptNo, ...detail }), now());
}

function loadRoundTx(roundId) {
  return db.prepare('SELECT * FROM review_appeal_rounds WHERE id = ?').get(roundId) || null;
}

function effectiveAppealInviteStatus(row) {
  if (row.status === 'active' && row.expires_at <= now()) {
    db.prepare("UPDATE review_appeal_invitations SET status = 'expired' WHERE id = ? AND status = 'active'").run(row.id);
    return 'expired';
  }
  return row.status;
}

// ---------------------------------------------------------------------------
// 可申诉字段：原批次中已被【办理人或系统超时策略】驳回、且未在未终结申诉回合中的字段
// ---------------------------------------------------------------------------
export function listAppealableFields({ userId, batchId }) {
  const batch = db.prepare('SELECT * FROM review_batches WHERE id = ? AND user_id = ?').get(batchId, userId);
  if (!batch) return null;
  const rows = db.prepare(`
    SELECT * FROM review_batch_fields WHERE batch_id = ? ORDER BY ordinal, step, field
  `).all(batchId);
  const openAppealByField = new Map(db.prepare(`
    SELECT af.source_field_id, af.round_id
    FROM review_appeal_fields af
    JOIN review_appeal_rounds ar ON ar.id = af.round_id
    WHERE ar.batch_id = ? AND ar.status IN ('collecting', 'in_review')
  `).all(batchId).map((row) => [row.source_field_id, row.round_id]));
  return rows
    .filter((row) => row.decision === 'rejected')
    .map((row) => ({
      sourceFieldId: row.id,
      key: batchFieldKey(row.step, row.field),
      step: row.step,
      field: row.field,
      label: row.field_label,
      decisionReason: row.decision_reason || '',
      decidedAt: row.decided_at || null,
      decidedByPolicy: row.decided_by_policy || '',
      correctionReceiptNo: row.correction_receipt_no || '',
      openAppealRoundId: openAppealByField.get(row.id) || null,
      opinions: db.prepare('SELECT id, reviewer_label, reason, value_snapshot, created_at FROM review_batch_opinions WHERE batch_field_id = ? ORDER BY created_at ASC')
        .all(row.id)
        .map((opinion) => ({
          id: opinion.id,
          label: opinion.reviewer_label,
          reason: opinion.reason,
          valueSnapshot: opinion.value_snapshot,
          submittedAt: opinion.created_at,
        })),
    }));
}

// ---------------------------------------------------------------------------
// 创建申诉回合
// ---------------------------------------------------------------------------
export function createAppealRound({ userId, batchId, config, ttlMs }) {
  try {
    return immediateTransaction(() => {
      const batch = db.prepare('SELECT * FROM review_batches WHERE id = ? AND user_id = ?').get(batchId, userId);
      if (!batch) {
        return { ok: false, status: 404, code: 'APPEAL_NOT_FOUND', message: '复核批次不存在' };
      }
      if (batch.status === 'cancelled' || batch.status === 'timed_out') {
        return { ok: false, status: 409, code: 'APPEAL_NOT_ACTIVE', message: `原批次已${batch.status === 'cancelled' ? '取消' : '超时失败'}，不能发起申诉` };
      }
      const openRound = db.prepare(`
        SELECT id FROM review_appeal_rounds
        WHERE batch_id = ? AND status IN ('collecting', 'in_review')
      `).get(batchId);
      if (openRound) {
        return { ok: false, status: 409, code: 'APPEAL_ALREADY_OPEN', message: APPEAL_ERRORS.APPEAL_ALREADY_OPEN };
      }
      const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ? AND user_id = ?')
        .get(batch.receipt_no, userId);
      if (!receipt) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND', message: '原回执不存在' };
      if (receipt.status === 'revoked') {
        return { ok: false, status: 409, code: 'RECEIPT_REVOKED', message: '已撤销的回执不能发起申诉回合' };
      }

      // 只读校验阶段（任何失败都发生在第一条 INSERT 之前：better-sqlite3 事务只在抛错时回滚，
      // 因此不能先写后“return 失败”，否则行会被提交）。
      const preparedFields = [];
      for (const spec of config.fields) {
        const sourceField = db.prepare(`
          SELECT * FROM review_batch_fields WHERE batch_id = ? AND step = ? AND field = ?
        `).get(batchId, spec.step, spec.field);
        if (!sourceField) {
          return { ok: false, status: 400, code: 'APPEAL_FIELD_NOT_REJECTED', message: `字段 ${spec.key} 不属于原批次` };
        }
        if (sourceField.decision !== 'rejected') {
          return {
            ok: false,
            status: 409,
            code: 'APPEAL_FIELD_NOT_REJECTED',
            message: `字段 ${spec.key}（${sourceField.field_label}）未被驳回，不能发起申诉`,
          };
        }
        const already = db.prepare(`
          SELECT ar.id FROM review_appeal_fields af
          JOIN review_appeal_rounds ar ON ar.id = af.round_id
          WHERE af.source_field_id = ? AND ar.status IN ('collecting', 'in_review')
        `).get(sourceField.id);
        if (already) {
          return { ok: false, status: 409, code: 'APPEAL_FIELD_DUPLICATE', message: `字段 ${spec.key} 已存在进行中的申诉回合` };
        }

        // 原批次意见按时间排序，授权披露的意见以“原复核人N”匿名化（N 为其在原意见序列中的位置）
        const sourceOpinions = db.prepare(`
          SELECT * FROM review_batch_opinions WHERE batch_field_id = ? ORDER BY created_at ASC, rowid ASC
        `).all(sourceField.id);
        const allowedIds = spec.evidenceOpinionIds || [];
        const evidenceRows = [];
        for (let index = 0; index < sourceOpinions.length; index += 1) {
          const opinion = sourceOpinions[index];
          if (allowedIds.includes(opinion.id)) {
            evidenceRows.push({ opinion, alias: `原复核人${index + 1}` });
          }
        }
        if (evidenceRows.length !== allowedIds.length) {
          return {
            ok: false,
            status: 400,
            code: 'INVALID_APPEAL_EVIDENCE',
            message: `字段 ${spec.key} 授权披露的证据不存在或不属于该字段`,
          };
        }
        preparedFields.push({ spec, sourceField, evidenceRows });
      }

      // 校验通过后才开始写入。申诉回合从创建即开放（独立限时自创建起算）：
      // 新复核人在限时内陆续完成一次性校验并提交意见，办理人在阈值满足后逐字段决议。
      const ts = now();
      const roundId = cryptoId();
      const expiresAt = ts + ttlMs;
      const reasonSummary = [...new Set(config.fields.map((field) => field.reason))]
        .map((code) => appealReasonLabel(code)).join('、');
      db.prepare(`
        INSERT INTO review_appeal_rounds
          (id, batch_id, receipt_no, workflow_id, user_id, status, reason_summary, note,
           created_at, expires_at, started_at, completed_at, cancelled_at, cancel_reason,
           expired_at, invitation_count)
        VALUES (?, ?, ?, ?, ?, 'in_review', ?, ?, ?, ?, ?, NULL, NULL, '', NULL, ?)
      `).run(roundId, batchId, receipt.receipt_no, receipt.workflow_id, userId, reasonSummary,
        config.note, ts, expiresAt, ts, config.invitations.length);

      const appealFieldIds = new Map();
      for (const { spec, sourceField, evidenceRows } of preparedFields) {
        const appealFieldId = cryptoId();
        db.prepare(`
          INSERT INTO review_appeal_fields
            (id, round_id, source_field_id, batch_id, step, field, field_label, reason_code,
             accept_threshold, reject_threshold, status, decision, decided_at, decided_by_user_id,
             decision_reason, correction_workflow_id, correction_receipt_no, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_review', NULL, NULL, NULL, '', NULL, '', ?)
        `).run(
          appealFieldId, roundId, sourceField.id, batchId, spec.step, spec.field,
          appealFieldLabel(spec.step, spec.field), spec.reason,
          spec.acceptThreshold, spec.rejectThreshold, ts,
        );
        appealFieldIds.set(spec.key, appealFieldId);

        // 证据授权：只落库办理人显式允许披露的原意见摘要（原复核人匿名化）
        for (const { opinion, alias } of evidenceRows) {
          db.prepare(`
            INSERT INTO review_appeal_evidence
              (id, round_id, appeal_field_id, source_opinion_id, source_alias,
               source_value_snapshot, source_reason, source_created_at, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            cryptoId(), roundId, appealFieldId, opinion.id, alias,
            opinion.value_snapshot, opinion.reason, opinion.created_at, ts,
          );
        }
      }

      const invitations = [];
      config.invitations.forEach((invite, ordinal) => {
        const raw = tokenUrlSafe();
        const inviteId = cryptoId();
        db.prepare(`
          INSERT INTO review_appeal_invitations
            (id, round_id, ordinal, receipt_no, user_id, label, token_hash, status,
             created_at, expires_at, used_at, used_ip, revoked_at, revoke_reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, '', NULL, '')
        `).run(inviteId, roundId, ordinal, receipt.receipt_no, userId, invite.label,
          sha256(raw), ts, expiresAt);
        for (const key of invite.scopeKeys) {
          const appealFieldId = appealFieldIds.get(key);
          const [step, field] = key.split('.');
          db.prepare(`
            INSERT INTO review_appeal_invitation_fields (invitation_id, appeal_field_id, step, field)
            VALUES (?, ?, ?, ?)
          `).run(inviteId, appealFieldId, Number(step), field);
        }
        invitations.push({ id: inviteId, label: invite.label, token: raw });
      });

      addAppealEvent(receipt.receipt_no, 'review.appeal.created', {
        roundId, batchId,
        fields: config.fields.map((field) => ({
          key: field.key, reason: field.reason,
          acceptThreshold: field.acceptThreshold, rejectThreshold: field.rejectThreshold,
          evidenceCount: field.evidenceOpinionIds.length,
        })),
        invitationCount: invitations.length,
        ttlMs,
      });
      return { ok: true, roundId, invitations };
    });
  } catch (error) {
    // 两个页面并发发起：未终结回合/未终结字段的部分唯一索引只放行一个
    if (String(error?.message || '').includes('UNIQUE')) {
      return { ok: false, status: 409, code: 'APPEAL_ALREADY_OPEN', message: APPEAL_ERRORS.APPEAL_ALREADY_OPEN };
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 视图辅助
// ---------------------------------------------------------------------------
function listEvidenceForField(appealFieldId) {
  return db.prepare(`
    SELECT * FROM review_appeal_evidence WHERE appeal_field_id = ? ORDER BY source_created_at ASC, rowid ASC
  `).all(appealFieldId).map((row) => ({
    id: row.id,
    sourceOpinionId: row.source_opinion_id,
    alias: row.source_alias,
    valueSnapshot: row.source_value_snapshot,
    reason: row.source_reason,
    originalSubmittedAt: row.source_created_at,
  }));
}

function listAppealOpinionsForField(appealFieldId) {
  return db.prepare(`
    SELECT * FROM review_appeal_opinions WHERE appeal_field_id = ? ORDER BY created_at ASC, rowid ASC
  `).all(appealFieldId).map((row) => appealOpinionView(row));
}

function originalDecisionSummary(sourceFieldId) {
  const source = db.prepare('SELECT * FROM review_batch_fields WHERE id = ?').get(sourceFieldId);
  if (!source) return null;
  let decidedBy = '';
  if (source.decided_by_user_id) {
    decidedBy = userQueries.findById(source.decided_by_user_id)?.display_name || '';
  }
  return {
    decision: source.decision,
    decidedAt: source.decided_at || null,
    reason: source.decision_reason || '',
    decidedByPolicy: source.decided_by_policy || '',
    decidedBy,
  };
}

function appealOpinionView(row) {
  return {
    id: row.id,
    roundId: row.round_id,
    appealFieldId: row.appeal_field_id,
    invitationId: row.appeal_invitation_id,
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
}

function appealFieldOwnerView(row) {
  const opinions = listAppealOpinionsForField(row.id);
  const evidence = listEvidenceForField(row.id);
  const reviewerIds = new Set(opinions.map((item) => item.invitationId));
  return {
    id: row.id,
    roundId: row.round_id,
    sourceFieldId: row.source_field_id,
    key: batchFieldKey(row.step, row.field),
    step: row.step,
    field: row.field,
    label: row.field_label,
    reasonCode: row.reason_code || '',
    reasonLabel: appealReasonLabel(row.reason_code || ''),
    acceptThreshold: row.accept_threshold,
    rejectThreshold: row.reject_threshold,
    status: row.status,
    decision: row.decision || null,
    decidedAt: row.decided_at || null,
    decidedBy: row.decided_by_user_id ? (userQueries.findById(row.decided_by_user_id)?.display_name || '') : '',
    decisionReason: row.decision_reason || '',
    correctionWorkflowId: row.correction_workflow_id || null,
    correctionReceiptNo: row.correction_receipt_no || '',
    opinionCount: opinions.length,
    distinctReviewerCount: reviewerIds.size,
    opinions,
    evidence,
    originalDecision: originalDecisionSummary(row.source_field_id),
  };
}

function listAppealFieldsTx(roundId) {
  return db.prepare('SELECT * FROM review_appeal_fields WHERE round_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(roundId).map((row) => appealFieldOwnerView(row));
}

function appealInvitationOwnerView(row) {
  const status = effectiveAppealInviteStatus(row);
  return {
    id: row.id,
    roundId: row.round_id,
    ordinal: row.ordinal,
    label: row.label,
    status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at || null,
    revokedAt: row.revoked_at || null,
    revokeReason: row.revoke_reason || '',
    fields: db.prepare(`
      SELECT s.appeal_field_id, s.step, s.field FROM review_appeal_invitation_fields s
      WHERE s.invitation_id = ? ORDER BY s.step, s.field
    `).all(row.id).map((item) => ({
      appealFieldId: item.appeal_field_id,
      key: batchFieldKey(item.step, item.field),
      label: appealFieldLabel(item.step, item.field),
    })),
  };
}

function roundOwnerView(row, { withDetails = true } = {}) {
  const invitations = db.prepare(`
    SELECT * FROM review_appeal_invitations WHERE round_id = ? ORDER BY ordinal ASC, created_at ASC
  `).all(row.id);
  const fields = withDetails ? listAppealFieldsTx(row.id) : [];
  const ts = now();
  const used = invitations.filter((item) => item.used_at).length;
  const decided = fields.filter((item) => item.decision).length;
  return {
    id: row.id,
    batchId: row.batch_id,
    receiptNo: row.receipt_no,
    status: row.status,
    reasonSummary: row.reason_summary || '',
    note: row.note || '',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    cancelledAt: row.cancelled_at || null,
    cancelReason: row.cancel_reason || '',
    expiredAt: row.expired_at || null,
    remainingMs: ['collecting', 'in_review'].includes(row.status) ? Math.max(0, row.expires_at - ts) : 0,
    invitationCount: row.invitation_count,
    validatedCount: used,
    revokedCount: invitations.filter((item) => item.status === 'revoked' || item.revoked_at).length,
    expiredCount: invitations.filter((item) => effectiveAppealInviteStatus(item) === 'expired').length,
    fieldCount: fields.length,
    decidedCount: decided,
    acceptedCount: fields.filter((item) => item.decision === 'accepted').length,
    rejectedCount: fields.filter((item) => item.decision === 'rejected').length,
    invitations: withDetails ? invitations.map((item) => appealInvitationOwnerView(item)) : [],
    fields,
  };
}

export function getAppealRoundForOwner({ userId, roundId }) {
  const row = db.prepare('SELECT * FROM review_appeal_rounds WHERE id = ? AND user_id = ?').get(roundId, userId);
  return row ? roundOwnerView(row) : null;
}

export function listAppealRoundsForOwner(userId, { batchId = '', receiptNo = '' } = {}) {
  let rows = db.prepare('SELECT * FROM review_appeal_rounds WHERE user_id = ? ORDER BY created_at ASC').all(userId);
  if (batchId) rows = rows.filter((row) => row.batch_id === batchId);
  if (receiptNo) rows = rows.filter((row) => row.receipt_no === receiptNo);
  return rows.map((row) => roundOwnerView(row));
}

// ---------------------------------------------------------------------------
// 取消申诉回合：已有字段完成申诉决议（或回合已完成）时历史不能删除
// ---------------------------------------------------------------------------
export function cancelAppealRound({ userId, roundId, reason }) {
  const text = String(reason || '').trim().slice(0, 200);
  return immediateTransaction(() => {
    settleExpiredAppealRoundTx(loadRoundTx(roundId));
    const row = loadRoundTx(roundId);
    if (!row || row.user_id !== userId) {
      return { ok: false, status: 404, code: 'APPEAL_NOT_FOUND', message: '申诉回合不存在' };
    }
    if (row.status === 'cancelled') {
      return { ok: false, status: 409, code: 'APPEAL_NOT_ACTIVE', message: '申诉回合已取消', round: roundOwnerView(row) };
    }
    if (row.status === 'expired') {
      return { ok: false, status: 409, code: 'APPEAL_DEADLINE_PASSED', message: '申诉回合已过期，不能取消', round: roundOwnerView(row) };
    }
    if (row.status === 'completed') {
      return { ok: false, status: 409, code: 'APPEAL_NOT_ACTIVE', message: '申诉回合已完成，不能取消', round: roundOwnerView(row) };
    }
    const decided = db.prepare(`
      SELECT COUNT(*) AS n FROM review_appeal_fields WHERE round_id = ? AND decision IS NOT NULL
    `).get(roundId).n;
    if (decided > 0) {
      return { ok: false, status: 409, code: 'APPEAL_HAS_DECISIONS', message: APPEAL_ERRORS.APPEAL_HAS_DECISIONS, round: roundOwnerView(row) };
    }
    const ts = now();
    // 未使用邀请立即失效；已校验复核人的会话保留只读能力（写接口按回合状态返回 410，
    // 上下文返回“回合已取消”的关闭视图），意见与字段行原样留档
    db.prepare(`
      UPDATE review_appeal_invitations
      SET status = 'revoked', revoked_at = ?, revoke_reason = '申诉回合取消'
      WHERE round_id = ? AND used_at IS NULL AND revoked_at IS NULL
    `).run(ts, roundId);
    db.prepare("UPDATE review_appeal_fields SET status = 'cancelled' WHERE round_id = ? AND decision IS NULL").run(roundId);
    db.prepare(`
      UPDATE review_appeal_rounds SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
      WHERE id = ?
    `).run(ts, text, roundId);
    addAppealEvent(row.receipt_no, 'review.appeal.cancelled', { roundId, batchId: row.batch_id, reason: text });
    return { ok: true, round: roundOwnerView(loadRoundTx(roundId)) };
  });
}

// ---------------------------------------------------------------------------
// 限时：截止后回合整体过期，未使用邀请失效、会话失效；写操作全部关闭。
// 以状态条件更新为唯一判定，定时器/惰性检查/重启恢复重复触发不产生第二次结果。
// ---------------------------------------------------------------------------
function settleExpiredAppealRoundTx(row) {
  if (!row) return false;
  if (!['collecting', 'in_review'].includes(row.status)) return false;
  if (row.expires_at > now()) return false;
  const ts = now();
  const updated = db.prepare(`
    UPDATE review_appeal_rounds
    SET status = 'expired', expired_at = ?
    WHERE id = ? AND status IN ('collecting', 'in_review') AND expires_at <= ?
  `).run(ts, row.id, ts);
  if (updated.changes === 0) return false;
  db.prepare(`
    UPDATE review_appeal_invitations
    SET status = 'expired' WHERE round_id = ? AND used_at IS NULL AND revoked_at IS NULL AND status = 'active'
  `).run(row.id);
  // 已校验复核人的会话保留为只读：历史意见可查看，写接口按回合状态显式拒绝（410）
  db.prepare(`
    UPDATE review_appeal_fields
    SET status = 'expired' WHERE round_id = ? AND decision IS NULL
  `).run(row.id);
  addAppealEvent(row.receipt_no, 'review.appeal.expired', {
    roundId: row.id, batchId: row.batch_id, expiredAt: ts,
  });
  return true;
}

export function sweepAppealTimeouts() {
  const rows = db.prepare(`
    SELECT * FROM review_appeal_rounds
    WHERE status IN ('collecting', 'in_review') AND expires_at <= ?
  `).all(now());
  let changed = 0;
  for (const row of rows) {
    if (immediateTransaction(() => settleExpiredAppealRoundTx(row))) changed += 1;
  }
  return changed;
}

// ---------------------------------------------------------------------------
// 复核人：一次性邀请校验 → 免登录申诉会话
// ---------------------------------------------------------------------------
export function consumeAppealInvitation({ rawToken, clientIp }) {
  return immediateTransaction(() => {
    const invite = db.prepare('SELECT * FROM review_appeal_invitations WHERE token_hash = ?').get(sha256(rawToken));
    if (!invite) return { ok: false, status: 404, code: 'APPEAL_INVITATION_NOT_FOUND' };
    const round = loadRoundTx(invite.round_id);
    if (!round) return { ok: false, status: 404, code: 'APPEAL_NOT_FOUND' };
    settleExpiredAppealRoundTx(round);
    const roundNow = loadRoundTx(invite.round_id);
    if (roundNow.status === 'cancelled' || invite.status === 'revoked' || invite.revoked_at) {
      return { ok: false, status: 410, code: 'APPEAL_INVITATION_REVOKED' };
    }
    if (roundNow.status === 'expired' || invite.expires_at <= now() || roundNow.expires_at <= now()) {
      if (invite.status === 'active') {
        db.prepare("UPDATE review_appeal_invitations SET status = 'expired' WHERE id = ?").run(invite.id);
      }
      return { ok: false, status: 410, code: 'APPEAL_INVITATION_EXPIRED' };
    }
    if (roundNow.status === 'completed') {
      return { ok: false, status: 410, code: 'APPEAL_NOT_ACTIVE', message: '申诉回合已完成' };
    }
    if (invite.used_at || invite.status === 'used') {
      return { ok: false, status: 410, code: 'APPEAL_INVITATION_ALREADY_USED' };
    }
    const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(invite.receipt_no);
    if (!receipt) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND' };
    if (receipt.status === 'revoked') return { ok: false, status: 410, code: 'RECEIPT_REVOKED' };

    const ts = now();
    db.prepare(`
      UPDATE review_appeal_invitations
      SET status = 'used', used_at = ?, used_ip = ?
      WHERE id = ? AND used_at IS NULL
    `).run(ts, String(clientIp || '').slice(0, 64), invite.id);

    const sessionRaw = tokenUrlSafe();
    const sessionId = cryptoId();
    const csrf = tokenUrlSafe();
    const expiry = Math.min(invite.expires_at, roundNow.expires_at);
    db.prepare(`
      INSERT INTO review_appeal_sessions
        (id, round_id, appeal_invitation_id, receipt_no, label, token_hash, csrf_secret,
         created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, roundNow.id, invite.id, receipt.receipt_no, invite.label,
      sha256(sessionRaw), csrf, ts, expiry, ts);

    addAppealEvent(receipt.receipt_no, 'review.appeal.invitation.consumed', {
      roundId: roundNow.id, invitationId: invite.id, label: invite.label,
    });

    // 最后一个邀请完成校验时自动进入复核（与平面批次一致）
    let autoStarted = false;
    const remaining = db.prepare(`
      SELECT COUNT(*) AS n FROM review_appeal_invitations
      WHERE round_id = ? AND used_at IS NULL AND revoked_at IS NULL AND status <> 'revoked'
    `).get(roundNow.id).n;
    if (remaining === 0 && roundNow.status === 'collecting') {
      db.prepare(`
        UPDATE review_appeal_rounds SET status = 'in_review', started_at = COALESCE(started_at, ?)
        WHERE id = ? AND status = 'collecting'
      `).run(ts, roundNow.id);
      db.prepare("UPDATE review_appeal_fields SET status = 'in_review' WHERE round_id = ? AND status = 'collecting'")
        .run(roundNow.id);
      autoStarted = true;
      addAppealEvent(receipt.receipt_no, 'review.appeal.started', { roundId: roundNow.id, auto: true });
    }

    return {
      ok: true,
      sessionToken: sessionRaw,
      sessionId,
      csrf,
      roundId: roundNow.id,
      receiptNo: receipt.receipt_no,
      label: invite.label,
      expiresAt: expiry,
      autoStarted,
    };
  });
}

export function getValidAppealSession(rawToken) {
  if (!rawToken) return null;
  const session = db.prepare('SELECT * FROM review_appeal_sessions WHERE token_hash = ?').get(sha256(rawToken));
  if (!session) return null;
  const invite = db.prepare('SELECT * FROM review_appeal_invitations WHERE id = ?').get(session.appeal_invitation_id);
  // 办理人显式撤销（未使用）邀请时会话失效；回合取消/过期不改已校验邀请，会话保留只读，
  // 写操作由提交接口按回合状态显式拒绝（410）。
  if (!invite || (invite.status === 'revoked' && !invite.used_at)) return null;
  const round = loadRoundTx(session.round_id);
  if (!round) return null;
  db.prepare('UPDATE review_appeal_sessions SET last_seen_at = ? WHERE id = ?').run(now(), session.id);
  return { session, invite, round };
}

export function deleteAppealSession(rawToken) {
  if (!rawToken) return;
  const session = db.prepare('SELECT * FROM review_appeal_sessions WHERE token_hash = ?').get(sha256(rawToken));
  if (session) db.prepare('DELETE FROM review_appeal_sessions WHERE id = ?').run(session.id);
}

function sessionAuthorizedFieldRows(sessionId) {
  return db.prepare(`
    SELECT s.* FROM review_appeal_invitation_fields s
    JOIN review_appeal_sessions aps ON aps.appeal_invitation_id = s.invitation_id
    WHERE aps.id = ?
  `).all(sessionId);
}

// ---------------------------------------------------------------------------
// 新复核人上下文：本回合授权的脱敏字段 + 原字段既有驳回决议 + 允许披露的证据摘要。
// 其他申诉字段、其他批次字段与原复核人的未授权隐私一律不出现。
// ---------------------------------------------------------------------------
export function getAppealReviewerContext(review) {
  const { session, invite } = review;
  const round = loadRoundTx(session.round_id);
  if (!round) return null;
  settleExpiredAppealRoundTx(round);
  const roundNow = loadRoundTx(session.round_id);
  const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(session.receipt_no);
  if (!receipt) return null;

  const locked = ['cancelled', 'expired'].includes(roundNow.status);
  // 回合取消/过期后字段视图不再下发，但本人被授权字段的合并意见/决议结果仍只读可见
  const scope = sessionAuthorizedFieldRows(session.id);
  const authorizedKeys = locked ? [] : scope.map((item) => batchFieldKey(item.step, item.field));
  const snapshot = JSON.parse(receipt.snapshot_json);
  const myOpinions = db.prepare(`
    SELECT * FROM review_appeal_opinions WHERE session_id = ? ORDER BY created_at ASC
  `).all(session.id).map((row) => appealOpinionView(row));

  const fieldRows = db.prepare(`
    SELECT * FROM review_appeal_fields WHERE round_id = ? ORDER BY created_at ASC, rowid ASC
  `).all(roundNow.id);
  const byId = new Map(scope.map((item) => [item.appeal_field_id, item]));
  const merged = fieldRows
    .filter((row) => byId.has(row.id))
    .map((row) => {
      const opinions = listAppealOpinionsForField(row.id);
      const original = originalDecisionSummary(row.source_field_id);
      return {
        key: batchFieldKey(row.step, row.field),
        step: row.step,
        field: row.field,
        label: row.field_label,
        appealReason: appealReasonLabel(row.reason_code || ''),
        acceptThreshold: row.accept_threshold,
        rejectThreshold: row.reject_threshold,
        status: row.status,
        decision: row.decision || null,
        decidedAt: row.decided_at || null,
        decisionReason: row.decision_reason || '',
        correctionReceiptNo: row.correction_receipt_no || '',
        opinionCount: opinions.length,
        opinions: opinions.map((opinion) => ({
          id: opinion.id,
          reviewerLabel: opinion.reviewerLabel,
          reason: opinion.reason,
          valueSnapshot: opinion.valueSnapshot,
          submittedAt: opinion.submittedAt,
          mine: opinion.invitationId === invite.id,
        })),
        // 原字段既有决议（驳回理由/超时策略）与办理人允许披露的证据摘要
        originalDecision: original ? {
          decision: original.decision,
          decidedAt: original.decidedAt,
          reason: original.reason,
          decidedByPolicy: original.decidedByPolicy,
        } : null,
        evidence: listEvidenceForField(row.id),
      };
    });

  const canSubmit = !locked && roundNow.status === 'in_review' && roundNow.expires_at > now();

  if (receipt.status === 'revoked' || locked) {
    return {
      roundId: roundNow.id,
      batchId: roundNow.batch_id,
      receiptNo: receipt.receipt_no,
      label: session.label,
      status: receipt.status === 'revoked' ? 'revoked' : roundNow.status,
      roundStatus: roundNow.status,
      expiresAt: session.expires_at,
      deadlineAt: roundNow.expires_at,
      reasonSummary: roundNow.reason_summary,
      // 关闭后不返回字段值，但本人被授权字段的意见合并与决议结果只读可见
      view: null,
      opinions: myOpinions,
      merged,
      canSubmit: false,
    };
  }

  return {
    roundId: roundNow.id,
    batchId: roundNow.batch_id,
    receiptNo: receipt.receipt_no,
    label: session.label,
    status: receipt.status,
    roundStatus: roundNow.status,
    collecting: roundNow.status === 'collecting',
    canSubmit,
    issuedAt: receipt.issued_at,
    completedAt: snapshot.completedAt,
    expiresAt: session.expires_at,
    deadlineAt: roundNow.expires_at,
    remainingMs: Math.max(0, roundNow.expires_at - now()),
    reasonSummary: roundNow.reason_summary,
    note: roundNow.note || '',
    view: buildAppealReviewView(snapshot, authorizedKeys),
    opinions: myOpinions,
    merged,
  };
}

// ---------------------------------------------------------------------------
// 新复核人提交申诉意见：只能针对本邀请授权字段；每邀请每字段至多一条；幂等重试
// ---------------------------------------------------------------------------
export function submitAppealOpinion({ review, key, reason, idempotencyKey, requestHash }) {
  return immediateTransaction(() => {
    const { session, invite } = review;
    settleExpiredAppealRoundTx(loadRoundTx(session.round_id));
    const round = loadRoundTx(session.round_id);
    if (round.status === 'cancelled') return { ok: false, status: 410, code: 'APPEAL_NOT_ACTIVE', message: '申诉回合已取消，写操作已关闭' };
    if (round.status === 'expired') {
      return { ok: false, status: 410, code: 'APPEAL_DEADLINE_PASSED', message: '申诉回合限时已过，写操作已关闭' };
    }
    if (invite.status === 'revoked' || invite.revoked_at) {
      return { ok: false, status: 410, code: 'APPEAL_INVITATION_REVOKED' };
    }
    if (round.expires_at <= now()) {
      settleExpiredAppealRoundTx(round);
      return { ok: false, status: 410, code: 'APPEAL_INVITATION_EXPIRED', message: '申诉邀请已超过有效期限' };
    }
    if (invite.expires_at <= now() || session.expires_at <= now()) {
      return { ok: false, status: 410, code: 'APPEAL_INVITATION_EXPIRED' };
    }
    const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(session.receipt_no);
    if (!receipt) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND' };
    if (receipt.status === 'revoked') return { ok: false, status: 410, code: 'RECEIPT_REVOKED' };
    if (round.status !== 'in_review') {
      return { ok: false, status: 409, code: 'APPEAL_NOT_ACTIVE', message: '申诉邀请尚未全部完成校验，暂不能提交意见' };
    }

    const parsed = typeof key === 'string'
      ? { step: Number(key.split('.')[0]), field: key.split('.')[1] }
      : null;
    if (!parsed || Number.isNaN(parsed.step) || !parsed.field) {
      return { ok: false, status: 400, code: 'APPEAL_FIELD_NOT_FOUND', message: '字段不存在' };
    }
    const appealField = db.prepare(`
      SELECT af.* FROM review_appeal_fields af
      JOIN review_appeal_invitation_fields aif
        ON aif.appeal_field_id = af.id AND aif.invitation_id = ?
      WHERE af.round_id = ? AND af.step = ? AND af.field = ?
    `).get(invite.id, round.id, parsed.step, parsed.field);
    if (!appealField) {
      return { ok: false, status: 403, code: 'APPEAL_FIELD_NOT_AUTHORIZED', message: APPEAL_ERRORS.APPEAL_FIELD_NOT_AUTHORIZED };
    }
    if (appealField.decision) {
      return { ok: false, status: 409, code: 'APPEAL_FIELD_ALREADY_DECIDED', message: '该申诉字段已有最终决议，不能再提交意见' };
    }
    const text = String(reason || '').trim();
    if (text.length < APPEAL_OPINION_MIN || text.length > APPEAL_OPINION_MAX) {
      return { ok: false, status: 400, code: 'INVALID_REASON', message: `意见说明需为 ${APPEAL_OPINION_MIN}-${APPEAL_OPINION_MAX} 个字符` };
    }

    const prior = db.prepare(`
      SELECT * FROM review_appeal_opinions WHERE session_id = ? AND idempotency_key = ?
    `).get(session.id, idempotencyKey);
    if (prior) {
      if (prior.request_hash !== requestHash) {
        return { ok: false, status: 409, code: 'OBJECTION_DUPLICATE_KEY', message: '该提交编号已用于其他内容' };
      }
      return { ok: true, replay: true, opinion: appealOpinionView(prior) };
    }

    const dup = db.prepare(`
      SELECT id FROM review_appeal_opinions WHERE appeal_invitation_id = ? AND appeal_field_id = ?
    `).get(invite.id, appealField.id);
    if (dup) {
      return { ok: false, status: 409, code: 'APPEAL_FIELD_DUPLICATE_OPINION', message: APPEAL_ERRORS.APPEAL_FIELD_DUPLICATE_OPINION };
    }

    const valueSnapshot = batchFieldTextValue(JSON.parse(receipt.snapshot_json), parsed.step, parsed.field);
    const ts = now();
    const id = cryptoId();
    try {
      db.prepare(`
        INSERT INTO review_appeal_opinions
          (id, round_id, appeal_field_id, appeal_invitation_id, session_id, receipt_no, user_id,
           step, field, reviewer_label, field_label, value_snapshot, reason,
           correction_receipt_no, idempotency_key, request_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
      `).run(
        id, round.id, appealField.id, invite.id, session.id, receipt.receipt_no, round.user_id,
        parsed.step, parsed.field, invite.label, appealField.field_label, valueSnapshot, text,
        idempotencyKey, requestHash, ts,
      );
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE')) {
        return { ok: false, status: 409, code: 'APPEAL_FIELD_DUPLICATE_OPINION', message: APPEAL_ERRORS.APPEAL_FIELD_DUPLICATE_OPINION };
      }
      throw error;
    }

    addAppealEvent(receipt.receipt_no, 'review.appeal.opinion.submitted', {
      roundId: round.id, invitationId: invite.id, appealFieldId: appealField.id, opinionId: id,
      label: invite.label, step: parsed.step, field: parsed.field,
    });
    return { ok: true, opinion: appealOpinionView(db.prepare('SELECT * FROM review_appeal_opinions WHERE id = ?').get(id)) };
  });
}

let appealCorrectionFactory = null;
export function bindAppealCorrectionFactory(fn) {
  appealCorrectionFactory = fn;
}

// ---------------------------------------------------------------------------
// 办理人逐字段决议申诉：独立阈值；接受必须在同一个新的更正办理中关联申诉意见
// 与原批次来源；驳回必须保存理由。
// ---------------------------------------------------------------------------
export function decideAppealField({ userId, roundId, appealFieldId, action, reason }) {
  const reasonText = String(reason || '').trim();
  return immediateTransaction(() => {
    settleExpiredAppealRoundTx(loadRoundTx(roundId));
    const round = loadRoundTx(roundId);
    if (!round || round.user_id !== userId) {
      return { ok: false, status: 404, code: 'APPEAL_NOT_FOUND', message: '申诉回合不存在' };
    }
    if (round.status === 'cancelled') return { ok: false, status: 410, code: 'APPEAL_NOT_ACTIVE', message: '申诉回合已取消' };
    if (round.status === 'expired') {
      return { ok: false, status: 410, code: 'APPEAL_DEADLINE_PASSED', message: '申诉回合限时已过，不能作出决议', round: roundOwnerView(round) };
    }
    if (round.status === 'completed') {
      const row = db.prepare('SELECT * FROM review_appeal_fields WHERE id = ? AND round_id = ?').get(appealFieldId, roundId);
      if (row) {
        return { ok: false, status: 409, code: 'APPEAL_FIELD_ALREADY_DECIDED', message: '申诉回合已完成', field: appealFieldOwnerView(row) };
      }
      return { ok: false, status: 404, code: 'APPEAL_FIELD_NOT_FOUND', message: '申诉字段不存在' };
    }
    if (round.status !== 'in_review') {
      return { ok: false, status: 409, code: 'APPEAL_NOT_ACTIVE', message: '申诉邀请尚未全部完成校验，不能作出决议', round: roundOwnerView(round) };
    }
    const fieldRow = db.prepare('SELECT * FROM review_appeal_fields WHERE id = ? AND round_id = ?').get(appealFieldId, roundId);
    if (!fieldRow) {
      return { ok: false, status: 404, code: 'APPEAL_FIELD_NOT_FOUND', message: '申诉字段不存在或不属于本回合' };
    }
    if (fieldRow.decision) {
      return {
        ok: false,
        status: 409,
        code: 'APPEAL_FIELD_ALREADY_DECIDED',
        message: `该申诉字段已决议为「${fieldRow.decision === 'accepted' ? '接受' : '驳回'}」，重复决议返回同一结果`,
        field: appealFieldOwnerView(fieldRow),
      };
    }

    const opinions = db.prepare('SELECT * FROM review_appeal_opinions WHERE appeal_field_id = ?').all(appealFieldId);
    const supportCount = new Set(opinions.map((item) => item.appeal_invitation_id)).size;
    // 阈值分母：本回合已完成校验且未撤销的邀请数
    const validatedInviteCount = db.prepare(`
      SELECT COUNT(DISTINCT id) AS n FROM review_appeal_invitations
      WHERE round_id = ? AND used_at IS NOT NULL AND revoked_at IS NULL
    `).get(roundId).n;

    if (action === 'accept') {
      if (supportCount < fieldRow.accept_threshold) {
        return {
          ok: false,
          status: 409,
          code: 'ACCEPT_THRESHOLD_NOT_MET',
          message: `该申诉字段只有 ${supportCount} 位新复核人提出意见，未达到接受阈值 ${fieldRow.accept_threshold}，不能接受`,
          field: appealFieldOwnerView(fieldRow),
        };
      }
      const source = db.prepare('SELECT * FROM receipts WHERE receipt_no = ? AND user_id = ?').get(round.receipt_no, userId);
      if (!source) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND', message: '原回执不存在' };
      let workflow = getActiveWorkflow(userId);
      if (workflow && workflow.source_receipt_no !== source.receipt_no) {
        return {
          ok: false,
          status: 409,
          code: 'OPEN_WORKFLOW_EXISTS',
          message: APPEAL_ERRORS.OPEN_WORKFLOW_EXISTS,
          workflow: publicWorkflow(workflow, getSteps(workflow.id)),
          field: appealFieldOwnerView(fieldRow),
        };
      }
      let created = false;
      if (!workflow) {
        if (!appealCorrectionFactory) throw new Error('appeal correction factory not bound');
        workflow = appealCorrectionFactory(source);
        created = true;
      }
      const ts = now();
      const updated = db.prepare(`
        UPDATE review_appeal_fields
        SET decision = 'accepted', status = 'accepted', decided_at = ?, decided_by_user_id = ?,
            decision_reason = '', correction_workflow_id = ?, correction_receipt_no = ''
        WHERE id = ? AND decision IS NULL
      `).run(ts, userId, workflow.id, appealFieldId);
      if (updated.changes === 0) {
        return {
          ok: false,
          status: 409,
          code: 'APPEAL_FIELD_ALREADY_DECIDED',
          message: '该申诉字段刚被另一个页面决议，重复决议返回同一结果',
          field: appealFieldOwnerView(db.prepare('SELECT * FROM review_appeal_fields WHERE id = ?').get(appealFieldId)),
        };
      }
      // 接受必须在同一份更正办理中关联申诉意见，并显式记录原批次/申诉回合来源
      // （round→batch→原回执链路可追溯，原批次行本身绝不被修改）
      for (const opinion of opinions) {
        db.prepare(`
          INSERT OR IGNORE INTO correction_objections
            (workflow_id, objection_id, batch_opinion_id, appeal_opinion_id,
             source_batch_id, source_round_id, created_at)
          VALUES (?, NULL, NULL, ?, ?, ?, ?)
        `).run(workflow.id, opinion.id, round.batch_id, roundId, ts);
      }
      addAppealEvent(round.receipt_no, 'review.appeal.field.accepted', {
        roundId, appealFieldId, sourceBatchId: round.batch_id,
        workflowId: workflow.id, created, opinionIds: opinions.map((item) => item.id),
      });
      const result = maybeCompleteRoundTx(round);
      return {
        ok: true,
        created,
        field: appealFieldOwnerView(db.prepare('SELECT * FROM review_appeal_fields WHERE id = ?').get(appealFieldId)),
        workflow: publicWorkflow(workflow, getSteps(workflow.id)),
        round: result.round,
        roundCompleted: result.completed,
      };
    }

    if (action === 'reject') {
      if (reasonText.length < APPEAL_OPINION_MIN || reasonText.length > APPEAL_REJECT_REASON_MAX) {
        return { ok: false, status: 400, code: 'REJECT_REASON_REQUIRED', message: `驳回理由需为 ${APPEAL_OPINION_MIN}-${APPEAL_REJECT_REASON_MAX} 个字符` };
      }
      const rejectSupport = validatedInviteCount - supportCount;
      if (rejectSupport < fieldRow.reject_threshold) {
        return {
          ok: false,
          status: 409,
          code: 'REJECT_THRESHOLD_NOT_MET',
          message: `该申诉字段有 ${supportCount} 位新复核人提出意见，支持驳回的新复核人仅 ${rejectSupport} 位，未达到驳回阈值 ${fieldRow.reject_threshold}，不能驳回`,
          field: appealFieldOwnerView(fieldRow),
        };
      }
      const ts = now();
      const updated = db.prepare(`
        UPDATE review_appeal_fields
        SET decision = 'rejected', status = 'rejected', decided_at = ?, decided_by_user_id = ?, decision_reason = ?
        WHERE id = ? AND decision IS NULL
      `).run(ts, userId, reasonText, appealFieldId);
      if (updated.changes === 0) {
        return {
          ok: false,
          status: 409,
          code: 'APPEAL_FIELD_ALREADY_DECIDED',
          message: '该申诉字段刚被另一个页面决议，重复决议返回同一结果',
          field: appealFieldOwnerView(db.prepare('SELECT * FROM review_appeal_fields WHERE id = ?').get(appealFieldId)),
        };
      }
      addAppealEvent(round.receipt_no, 'review.appeal.field.rejected', {
        roundId, appealFieldId, reason: reasonText,
      });
      const result = maybeCompleteRoundTx(round);
      return {
        ok: true,
        field: appealFieldOwnerView(db.prepare('SELECT * FROM review_appeal_fields WHERE id = ?').get(appealFieldId)),
        round: result.round,
        roundCompleted: result.completed,
      };
    }

    return { ok: false, status: 400, code: 'INVALID_ACTION', message: '决议类型必须是 accept 或 reject' };
  });
}

function maybeCompleteRoundTx(round) {
  const pending = db.prepare(`
    SELECT COUNT(*) AS n FROM review_appeal_fields WHERE round_id = ? AND decision IS NULL
  `).get(round.id).n;
  if (pending > 0) {
    return { completed: false, round: roundOwnerView(loadRoundTx(round.id)) };
  }
  const ts = now();
  db.prepare(`
    UPDATE review_appeal_rounds SET status = 'completed', completed_at = COALESCE(completed_at, ?)
    WHERE id = ? AND status IN ('in_review', 'collecting')
  `).run(ts, round.id);
  addAppealEvent(round.receipt_no, 'review.appeal.completed', { roundId: round.id });
  return { completed: true, round: roundOwnerView(loadRoundTx(round.id)) };
}

// ---------------------------------------------------------------------------
// 更正完成：新回执编号回填申诉字段与意见；放弃更正：接受决议回收为待决议
// （原批次的驳回决议始终不变）
// ---------------------------------------------------------------------------
export function attachCorrectionReceiptForAppeal({ workflowId, receiptNo }) {
  const links = db.prepare(`
    SELECT DISTINCT appeal_opinion_id FROM correction_objections
    WHERE workflow_id = ? AND appeal_opinion_id IS NOT NULL
  `).all(workflowId);
  if (links.length === 0) return;
  const opinionRows = db.prepare(`
    SELECT * FROM review_appeal_opinions WHERE id IN (${links.map(() => '?').join(',')})
  `).all(...links.map((item) => item.appeal_opinion_id));
  const fieldIds = [...new Set(opinionRows.map((row) => row.appeal_field_id))];
  for (const fieldId of fieldIds) {
    db.prepare('UPDATE review_appeal_fields SET correction_receipt_no = ? WHERE id = ?').run(receiptNo, fieldId);
  }
  for (const opinion of opinionRows) {
    db.prepare('UPDATE review_appeal_opinions SET correction_receipt_no = ? WHERE id = ?').run(receiptNo, opinion.id);
  }
  const roundIds = new Set(opinionRows.map((row) => row.round_id));
  for (const roundId of roundIds) {
    const round = loadRoundTx(roundId);
    if (round) {
      addAppealEvent(round.receipt_no, 'review.appeal.correction.completed', { roundId, receiptNo, fieldIds });
    }
  }
}

export function reopenAppealDecisionsForWorkflow(workflowId) {
  const links = db.prepare(`
    SELECT DISTINCT appeal_opinion_id FROM correction_objections
    WHERE workflow_id = ? AND appeal_opinion_id IS NOT NULL
  `).all(workflowId);
  if (links.length === 0) return [];
  const opinionRows = db.prepare(`
    SELECT * FROM review_appeal_opinions WHERE id IN (${links.map(() => '?').join(',')})
  `).all(...links.map((item) => item.appeal_opinion_id));
  const fieldIds = [...new Set(opinionRows.map((row) => row.appeal_field_id))];
  db.prepare(`
    UPDATE review_appeal_fields
    SET decision = NULL, status = 'in_review', decided_at = NULL, decided_by_user_id = NULL,
        decision_reason = '', correction_workflow_id = NULL, correction_receipt_no = ''
    WHERE id IN (${fieldIds.map(() => '?').join(',')}) AND decision = 'accepted'
  `).run(...fieldIds);
  db.prepare(`
    UPDATE review_appeal_opinions SET correction_receipt_no = ''
    WHERE id IN (${opinionRows.map(() => '?').join(',')})
  `).run(...opinionRows.map((row) => row.id));
  const roundIds = new Set(opinionRows.map((row) => row.round_id));
  for (const roundId of roundIds) {
    const round = loadRoundTx(roundId);
    if (!round) continue;
    if (round.status === 'completed') {
      db.prepare(`
        UPDATE review_appeal_rounds SET status = 'in_review', completed_at = NULL
        WHERE id = ? AND status = 'completed'
      `).run(roundId);
    }
    addAppealEvent(round.receipt_no, 'review.appeal.reopened', { roundId, fieldIds });
  }
  return fieldIds;
}

// ---------------------------------------------------------------------------
// 时间线：在对应批次条目之后插入申诉回合条目（含原批次关系、邀请状态、倒计时、
// 证据摘要、阈值进度、处理人、决议与更正回执来源、申诉审计事件）
// ---------------------------------------------------------------------------
export function buildAppealTimelineEntries(userId) {
  const rounds = db.prepare('SELECT * FROM review_appeal_rounds WHERE user_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(userId);
  return rounds.map((row) => {
    const view = roundOwnerView(row);
    const events = db.prepare(`
      SELECT type, detail_json, created_at FROM events
      WHERE workflow_id = ? AND json_extract(detail_json, '$.roundId') = ?
      ORDER BY id ASC
    `).all(row.workflow_id, row.id).map((event) => ({
      type: event.type,
      at: event.created_at,
      detail: JSON.parse(event.detail_json),
    }));
    return {
      kind: 'reviewAppeal',
      roundId: row.id,
      batchId: row.batch_id,
      receiptNo: row.receipt_no,
      status: view.status,
      reasonSummary: view.reasonSummary,
      note: view.note,
      createdAt: view.createdAt,
      expiresAt: view.expiresAt,
      remainingMs: view.remainingMs,
      startedAt: view.startedAt,
      completedAt: view.completedAt,
      cancelledAt: view.cancelledAt,
      cancelReason: view.cancelReason,
      expiredAt: view.expiredAt,
      invitationCount: view.invitationCount,
      validatedCount: view.validatedCount,
      fieldCount: view.fieldCount,
      decidedCount: view.decidedCount,
      acceptedCount: view.acceptedCount,
      rejectedCount: view.rejectedCount,
      invitations: view.invitations.map((invite) => ({
        id: invite.id,
        label: invite.label,
        status: invite.status,
        ordinal: invite.ordinal,
        usedAt: invite.usedAt,
        revokedAt: invite.revokedAt,
        expiresAt: invite.expiresAt,
        revokeReason: invite.revokeReason,
        fieldKeys: invite.fields.map((field) => field.key),
      })),
      fields: view.fields.map((field) => ({
        id: field.id,
        sourceFieldId: field.sourceFieldId,
        key: field.key,
        label: field.label,
        reasonCode: field.reasonCode,
        reasonLabel: field.reasonLabel,
        acceptThreshold: field.acceptThreshold,
        rejectThreshold: field.rejectThreshold,
        status: field.status,
        decision: field.decision,
        decidedAt: field.decidedAt,
        decidedBy: field.decidedBy,
        decisionReason: field.decisionReason,
        correctionWorkflowId: field.correctionWorkflowId,
        correctionReceiptNo: field.correctionReceiptNo,
        opinionCount: field.opinionCount,
        distinctReviewerCount: field.distinctReviewerCount,
        opinions: field.opinions.map((opinion) => ({
          id: opinion.id,
          reviewerLabel: opinion.reviewerLabel,
          reason: opinion.reason,
          valueSnapshot: opinion.valueSnapshot,
          submittedAt: opinion.submittedAt,
          correctionReceiptNo: opinion.correctionReceiptNo,
        })),
        evidence: field.evidence.map((item) => ({
          alias: item.alias,
          valueSnapshot: item.valueSnapshot,
          reason: item.reason,
          originalSubmittedAt: item.originalSubmittedAt,
        })),
        originalDecision: field.originalDecision ? {
          decision: field.originalDecision.decision,
          decidedAt: field.originalDecision.decidedAt,
          reason: field.originalDecision.reason,
          decidedByPolicy: field.originalDecision.decidedByPolicy,
        } : null,
      })),
      events,
    };
  });
}
