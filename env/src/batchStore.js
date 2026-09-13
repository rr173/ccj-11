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
  BATCH_MAX_STAGES,
  BATCH_OPINION_MAX,
  BATCH_OPINION_MIN,
  BATCH_REJECT_REASON_MAX,
  BATCH_STAGE_TIMEOUT_POLICIES,
  BATCH_TIMEOUT_AUTO_REJECT_REASON,
  batchFieldKey,
  batchFieldLabel,
  batchFieldTextValue,
  buildBatchReviewView,
} from './batchReviews.js';

function now() {
  return Date.now();
}

// 一个足够远的“阶段尚未开始”占位有效期：真正的截止时间在阶段启动时冻结
const STAGE_PENDING_EXPIRES_MS = 365 * 24 * 60 * 60 * 1000;

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
// 创建批次：一个事务内写批次、阶段、字段阈值、邀请（仅存令牌哈希）与字段授权。
//
// 平面批次（config.kind 非 'staged'）内部包装为唯一一个阶段：
//   - 该阶段在批次进入复核（全部邀请校验完成或显式 start）时激活；
//   - 无独立限时（沿用批次有效期），超时策略仅对分阶段批次生效。
// 分阶段批次（config.kind === 'staged'）第一个阶段在创建后立即激活并起算限时，
// 其超时策略在激活瞬间冻结；其余阶段保持 pending，顺序开放。
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

    const staged = config.kind === 'staged';
    const ts = now();
    const batchId = cryptoId();
    const batchExpiresAt = staged
      ? ts + config.stages.reduce((sum, stage) => sum + stage.ttlMinutes * 60000, 0)
      : ts + ttlMs;
    db.prepare(`
      INSERT INTO review_batches
        (id, receipt_no, workflow_id, user_id, status, note, staged, config_version, timeout_result,
         created_at, expires_at, started_at, completed_at, cancelled_at, cancel_reason, invitation_count)
      VALUES (?, ?, ?, ?, 'collecting', ?, ?, 1, '', ?, ?, NULL, NULL, NULL, '', ?)
    `).run(
      batchId, receipt.receipt_no, receipt.workflow_id, userId, config.note,
      staged ? 1 : 0, ts, batchExpiresAt,
      config.kind === 'staged' ? config.totalInvitations : config.invitations.length,
    );

    // 归一化成统一的阶段描述
    const stageSpecs = staged
      ? config.stages.map((stage, ordinal) => ({
        name: stage.name,
        ordinal,
        durationMs: stage.ttlMinutes * 60000,
        timeoutPolicy: stage.timeoutPolicy,
        fields: stage.fields,
        invitations: stage.invitations,
      }))
      : [{
        name: '统一复核', ordinal: 0, durationMs: ttlMs, timeoutPolicy: 'advance',
        fields: config.fields, invitations: config.invitations,
      }];

    const stageRowById = new Map();
    const fieldIdByKey = new Map();
    const invitations = [];

    // 创建后所有阶段均为 pending：办理人显式“启动第一阶段”后才开始倒计时与冻结策略，
    // 在此之前可以凭版本号调整编排（两个办理页面并发修改只放行一个）。
    stageSpecs.forEach((spec) => {
      const stageId = cryptoId();
      db.prepare(`
        INSERT INTO review_batch_stages
          (id, batch_id, ordinal, name, status, duration_ms, timeout_policy, frozen_policy,
           created_at, started_at, deadline_at, completed_at, final_decision,
           timeout_fired_at, timeout_result)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, '', ?, NULL, NULL, NULL, '', NULL, '')
      `).run(stageId, batchId, spec.ordinal, spec.name, spec.durationMs, spec.timeoutPolicy, ts);
      const stageRow = db.prepare('SELECT * FROM review_batch_stages WHERE id = ?').get(stageId);
      stageRowById.set(stageId, stageRow);

      spec.fields.forEach((field, fieldOrdinal) => {
        const fieldId = cryptoId();
        db.prepare(`
          INSERT INTO review_batch_fields
            (id, batch_id, stage_id, ordinal, step, field, field_label, accept_threshold,
             reject_threshold, decided_by_policy, decision, decided_at, decided_by_user_id,
             decision_reason, correction_workflow_id, correction_receipt_no)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', NULL, NULL, NULL, '', NULL, '')
        `).run(fieldId, batchId, stageId, fieldOrdinal, field.step, field.field,
          batchFieldLabel(field.step, field.field), field.acceptThreshold, field.rejectThreshold);
        fieldIdByKey.set(`${spec.ordinal}:${field.key}`, fieldId);
      });

      spec.invitations.forEach((invite, inviteOrdinal) => {
        const raw = tokenUrlSafe();
        const inviteId = cryptoId();
        // 分阶段批次：阶段未开始时邀请不能被使用，用远期占位有效期，激活时重定为阶段截止。
        // 平面批次：邀请沿用批次有效期（门控期间也会过期）。
        const inviteExpiresAt = staged ? ts + STAGE_PENDING_EXPIRES_MS : batchExpiresAt;
        db.prepare(`
          INSERT INTO review_batch_invitations
            (id, batch_id, stage_id, ordinal, receipt_no, user_id, label, token_hash, status,
             created_at, expires_at, used_at, used_ip, revoked_at, revoke_reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, '', NULL, '')
        `).run(inviteId, batchId, stageId, inviteOrdinal, receipt.receipt_no, userId,
          invite.label, sha256(raw), ts, inviteExpiresAt);
        const scopeFieldIds = [];
        for (const key of invite.scopeKeys) {
          const batchFieldId = fieldIdByKey.get(`${spec.ordinal}:${key}`);
          const parsedKey = key.split('.');
          db.prepare(`
            INSERT INTO review_batch_invitation_fields (invitation_id, batch_field_id, step, field)
            VALUES (?, ?, ?, ?)
          `).run(inviteId, batchFieldId, Number(parsedKey[0]), parsedKey[1]);
          scopeFieldIds.push(batchFieldId);
        }
        invitations.push({ id: inviteId, stageId, label: invite.label, token: raw, scopeFieldIds });
      });
    });

    // 初始编排版本（v1）：创建本身也是一次变更历史
    const snapshot = snapshotOrchestrationTx(batchId);
    recordOrchestrationVersionTx({
      batchId, version: 1, config: snapshot, note: staged ? '创建分阶段复核批次' : '创建复核批次', ts,
    });
    recordChangeHistoryTx({
      batchId, type: 'batch.created', fromVersion: null, toVersion: 1,
      detail: { staged, stageCount: stageSpecs.length, invitationCount: invitations.length }, ts,
    });

    addBatchEvent(receipt.receipt_no, 'review.batch.created', {
      batchId,
      staged,
      stageCount: stageSpecs.length,
      invitationCount: invitations.length,
      fields: stageSpecs.flatMap((spec) => spec.fields.map((f) => ({
        stage: spec.ordinal, key: f.key, acceptThreshold: f.acceptThreshold, rejectThreshold: f.rejectThreshold,
      }))),
    });
    if (staged) {
      addBatchEvent(receipt.receipt_no, 'review.batch.staged.created', {
        batchId, stageCount: stageSpecs.length, stages: stageSpecs.map((s) => ({
          ordinal: s.ordinal, name: s.name, durationMs: s.durationMs, timeoutPolicy: s.timeoutPolicy,
        })),
      });
    }
    return { ok: true, batchId, invitations };
  });
}

// 事务内：记录某一版编排配置
function recordOrchestrationVersionTx({ batchId, version, config, note, ts }) {
  db.prepare(`
    INSERT INTO review_batch_orchestration_versions (batch_id, version, config_json, change_note, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(batchId, version, JSON.stringify(config), String(note || '').slice(0, 200), ts);
}

// 事务内：写一条配置变更历史
function recordChangeHistoryTx({ batchId, type, fromVersion, toVersion, detail, ts }) {
  db.prepare(`
    INSERT INTO review_batch_change_history (id, batch_id, type, from_version, to_version, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(cryptoId(), batchId, type, fromVersion ?? null, toVersion ?? null, JSON.stringify(detail || {}), ts);
}

// 事务内：导出当前编排（阶段/字段阈值/邀请授权），用于版本留档与“重配前对比”
function snapshotOrchestrationTx(batchId) {
  const stages = db.prepare(`
    SELECT * FROM review_batch_stages WHERE batch_id = ? ORDER BY ordinal ASC
  `).all(batchId);
  return {
    stages: stages.map((stage) => ({
      ordinal: stage.ordinal,
      name: stage.name,
      durationMs: stage.duration_ms,
      timeoutPolicy: stage.timeout_policy,
      fields: db.prepare('SELECT step, field, accept_threshold, reject_threshold FROM review_batch_fields WHERE stage_id = ? ORDER BY ordinal')
        .all(stage.id).map((f) => ({
          key: batchFieldKey(f.step, f.field),
          acceptThreshold: f.accept_threshold,
          rejectThreshold: f.reject_threshold,
        })),
      invitations: db.prepare('SELECT id, label FROM review_batch_invitations WHERE stage_id = ? ORDER BY ordinal')
        .all(stage.id).map((inv) => ({
          invitationId: inv.id,
          label: inv.label,
          fields: db.prepare(`
            SELECT step, field FROM review_batch_invitation_fields WHERE invitation_id = ? ORDER BY step, field
          `).all(inv.id).map((scope) => batchFieldKey(scope.step, scope.field)),
        })),
    })),
  };
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
    stageId: row.stage_id || null,
    stageOrdinal: row.ordinal >= 0 ? stageOrdinalOf(row.stage_id) : null,
    label: row.label,
    status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at || null,
    revokedAt: row.revoked_at || null,
    revokeReason: row.revoke_reason || '',
    fields: listInvitationScope(row.id).map((item) => ({
      batchFieldId: item.batch_field_id,
      key: batchFieldKey(item.step, item.field),
      step: item.step,
      field: item.field,
      label: batchFieldLabel(item.step, item.field),
    })),
  };
}

function stageOrdinalOf(stageId) {
  if (!stageId) return null;
  const row = db.prepare('SELECT ordinal FROM review_batch_stages WHERE id = ?').get(stageId);
  return row ? row.ordinal : null;
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
    stageId: row.stage_id || null,
    key: batchFieldKey(row.step, row.field),
    step: row.step,
    field: row.field,
    label: row.field_label,
    acceptThreshold: row.accept_threshold,
    rejectThreshold: row.reject_threshold,
    decidedByPolicy: row.decided_by_policy || '',
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
  return db.prepare('SELECT * FROM review_batch_fields WHERE batch_id = ? ORDER BY ordinal, step, field').all(batchId)
    .map((row) => fieldOwnerView(row));
}

// 办理人视角的阶段视图：状态、冻结策略、倒计时（deadline）、邀请、字段与阈值进度
function stageOwnerView(row) {
  const invites = db.prepare(`
    SELECT * FROM review_batch_invitations WHERE stage_id = ? ORDER BY ordinal, created_at
  `).all(row.id);
  const fieldRows = db.prepare(`
    SELECT * FROM review_batch_fields WHERE stage_id = ? ORDER BY ordinal, step, field
  `).all(row.id);
  const fields = fieldRows.map((fieldRow) => fieldOwnerView(fieldRow));
  const ts = now();
  const opinionCounts = { total: 0, accepted: 0, rejected: 0, pending: 0 };
  for (const field of fields) {
    opinionCounts.total += field.opinionCount;
    if (field.decision === 'accepted') opinionCounts.accepted += 1;
    else if (field.decision === 'rejected') opinionCounts.rejected += 1;
    else opinionCounts.pending += 1;
  }
  return {
    id: row.id,
    ordinal: row.ordinal,
    name: row.name,
    status: stageEffectiveStatus(row),
    durationMs: row.duration_ms,
    timeoutPolicy: row.timeout_policy,
    // frozenPolicy 仅在阶段开始后有值：开始瞬间冻结，此后编排修改不影响本阶段
    frozenPolicy: row.frozen_policy || '',
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    deadlineAt: row.deadline_at || null,
    remainingMs: row.status === 'active' && row.deadline_at ? Math.max(0, row.deadline_at - ts) : 0,
    completedAt: row.completed_at || null,
    finalDecision: row.final_decision || '',
    timeoutFiredAt: row.timeout_fired_at || null,
    timeoutResult: row.timeout_result || '',
    invitationCount: invites.length,
    validatedCount: invites.filter((item) => item.used_at).length,
    revokedCount: invites.filter((item) => item.status === 'revoked' || item.revoked_at).length,
    expiredCount: invites.filter((item) => effectiveBatchInviteStatus(item) === 'expired').length,
    invitations: invites.map((item) => invitationOwnerView(item)),
    fieldCount: fields.length,
    acceptedCount: opinionCounts.accepted,
    rejectedCount: opinionCounts.rejected,
    pendingFieldCount: opinionCounts.pending,
    opinionTotal: opinionCounts.total,
    fields,
  };
}

function listBatchStagesTx(batchId) {
  return db.prepare('SELECT * FROM review_batch_stages WHERE batch_id = ? ORDER BY ordinal ASC').all(batchId)
    .map((row) => stageOwnerView(row));
}

// pending 阶段不做惰性过期；active 阶段的“已到截止时间但尚未被扫描落定”在此显形
function stageEffectiveStatus(row) {
  if (row.status === 'active' && row.deadline_at && row.deadline_at <= now()) {
    return 'active_deadline_passed';
  }
  return row.status;
}

function batchOwnerView(row, { withDetails = true } = {}) {
  const invitations = db.prepare(`
    SELECT * FROM review_batch_invitations WHERE batch_id = ? ORDER BY created_at ASC
  `).all(row.id);
  const fields = withDetails ? listBatchFieldsTx(row.id) : [];
  const stages = withDetails ? listBatchStagesTx(row.id) : [];
  const status = effectiveBatchStatus(row);
  const currentStage = stages.find((stage) => stage.status === 'active' || stage.status === 'active_deadline_passed') || null;
  return {
    id: row.id,
    receiptNo: row.receipt_no,
    status,
    note: row.note || '',
    staged: Boolean(row.staged),
    configVersion: row.config_version,
    timeoutResult: row.timeout_result || '',
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
    currentStageOrdinal: currentStage ? currentStage.ordinal : null,
    currentStageDeadlineAt: currentStage?.deadlineAt || null,
    invitations: withDetails ? invitations.map((item) => invitationOwnerView(item)) : [],
    fields,
    stages,
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
// 阶段推进（事务内）：
//   1. 惰性落定已到截止时间的当前阶段（按其开始时冻结的策略，幂等）；
//   2. 显式开启：平面批次等全部邀请校验通过后激活唯一阶段；
//      分阶段批次第一阶段创建即激活，此接口仅用于平面批次门控。
// ---------------------------------------------------------------------------
export function startReviewBatch({ userId, batchId }) {
  return immediateTransaction(() => {
    const row = loadBatchTx(batchId);
    if (!row || row.user_id !== userId) {
      return { ok: false, status: 404, code: 'BATCH_NOT_FOUND', message: '复核批次不存在' };
    }
    // 任何写操作前先按冻结策略落定超时（幂等：只产生一次结果）
    const fired = settleExpiredStagesTx(row);
    const refreshed = loadBatchTx(batchId);
    if (refreshed.status === 'timed_out') {
      return {
        ok: false,
        status: 409,
        code: 'BATCH_STAGE_TIMED_OUT',
        message: '批次已因阶段超时失败而终止',
        batch: batchOwnerView(refreshed),
        timedOut: fired.map((item) => ({ stageOrdinal: item.ordinal, timeoutResult: item.timeoutResult })),
      };
    }
    if (refreshed.status === 'in_review') {
      return { ok: false, status: 409, code: 'BATCH_ALREADY_STARTED', message: '批次已进入复核', batch: batchOwnerView(refreshed) };
    }
    if (refreshed.status === 'completed' || refreshed.status === 'cancelled') {
      return { ok: false, status: 409, code: 'BATCH_NOT_ACTIVE', message: '批次已终结，不能再进入复核', batch: batchOwnerView(refreshed) };
    }
    if (refreshed.staged) {
      // 分阶段批次：显式启动第一个 pending 阶段（冻结策略 + 起算倒计时），
      // 不要求邀请全部校验——阶段内邀请在开放时间内各自完成一次性校验。
      const firstPending = db.prepare(`
        SELECT * FROM review_batch_stages WHERE batch_id = ? AND status = 'pending'
        ORDER BY ordinal ASC LIMIT 1
      `).get(batchId);
      if (!firstPending) {
        return { ok: false, status: 409, code: 'BATCH_ALREADY_STARTED', message: '批次所有阶段都已开始', batch: batchOwnerView(refreshed) };
      }
      if (firstPending.ordinal !== 0) {
        return { ok: false, status: 409, code: 'BATCH_ALREADY_STARTED', message: '后续阶段由系统在上一阶段终局后自动开放，不能手动启动', batch: batchOwnerView(refreshed) };
      }
      const ts2 = now();
      activateStageTx(refreshed, firstPending, ts2);
      addBatchEvent(refreshed.receipt_no, 'review.batch.stage.started', {
        batchId, stageOrdinal: 0, stageName: firstPending.name,
        deadlineAt: ts2 + firstPending.duration_ms, timeoutPolicy: firstPending.timeout_policy, frozen: true,
      });
      recordChangeHistoryTx({
        batchId, type: 'batch.stage.started', fromVersion: null, toVersion: refreshed.config_version,
        detail: { stageOrdinal: 0, stageName: firstPending.name, deadlineAt: ts2 + firstPending.duration_ms, timeoutPolicy: firstPending.timeout_policy }, ts: ts2,
      });
      return { ok: true, batch: batchOwnerView(loadBatchTx(batchId)), stageStarted: true };
    }
    const invites = db.prepare('SELECT * FROM review_batch_invitations WHERE batch_id = ?').all(batchId);
    const dead = invites.find((item) => item.status === 'revoked' || item.revoked_at || effectiveBatchInviteStatus(item) === 'expired');
    if (dead) {
      return {
        ok: false,
        status: 409,
        code: 'BATCH_GATE_INVITATION_INVALID',
        message: `邀请「${dead.label}」已撤销或过期，批次无法进入复核；请取消本批次后重新创建`,
        batch: batchOwnerView(refreshed),
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
        batch: batchOwnerView(refreshed),
      };
    }
    const ts = now();
    activateFlatStageTx(refreshed, ts);
    addBatchEvent(refreshed.receipt_no, 'review.batch.started', { batchId });
    return { ok: true, batch: batchOwnerView(loadBatchTx(batchId)) };
  });
}

// 平面批次门控通过：激活唯一阶段并把邀请有效期收敛到批次有效期
function activateFlatStageTx(batch, ts) {
  const stage = db.prepare("SELECT * FROM review_batch_stages WHERE batch_id = ? AND ordinal = 0").get(batch.id);
  const deadline = Math.min(batch.expires_at, ts + (stage?.duration_ms || batch.expires_at - ts));
  db.prepare("UPDATE review_batches SET status = 'in_review', started_at = COALESCE(started_at, ?) WHERE id = ? AND status = 'collecting'")
    .run(ts, batch.id);
  if (stage) {
    db.prepare(`
      UPDATE review_batch_stages
      SET status = 'active', started_at = ?, deadline_at = ?, frozen_policy = ?
      WHERE id = ? AND status = 'pending'
    `).run(ts, deadline, '', stage.id);
    db.prepare('UPDATE review_batch_invitations SET expires_at = ? WHERE stage_id = ? AND used_at IS NULL')
      .run(deadline, stage.id);
  }
}

// 激活某个 pending 阶段（分阶段批次）：进入 in_review，开始时冻结超时策略、起算倒计时，
// 并把该阶段邀请有效期从“远期占位”收敛到阶段截止时间。
function activateStageTx(batch, stage, ts) {
  const deadline = ts + stage.duration_ms;
  db.prepare("UPDATE review_batches SET status = 'in_review', started_at = COALESCE(started_at, ?) WHERE id = ?")
    .run(ts, batch.id);
  db.prepare(`
    UPDATE review_batch_stages
    SET status = 'active', started_at = ?, deadline_at = ?, frozen_policy = ?
    WHERE id = ? AND status = 'pending'
  `).run(ts, deadline, stage.timeout_policy, stage.id);
  db.prepare(`
    UPDATE review_batch_invitations
    SET expires_at = ?
    WHERE stage_id = ? AND used_at IS NULL AND revoked_at IS NULL
  `).run(deadline, stage.id);
  return deadline;
}

// ---------------------------------------------------------------------------
// 超时落定（核心）：找到“active 且 deadline 已到”的阶段，按其【开始时冻结】的
// 策略只执行一次。三种策略互斥：
//   advance       自动转入下一阶段：本阶段未决字段系统自动驳回（留档），激活下一阶段；
//                 最后一阶段则批次完成。
//   revoke_unused 撤销本阶段未使用邀请，阶段进入 closing：复核人不能再提交，
//                 办理人仍须用已收集意见完成剩余字段决议，之后才开放下一阶段。
//   fail          批次标记为超时失败（timed_out）：撤销全部未使用邀请、会话失效。
// 重复触发（定时器 + 惰性扫描 + 重启后恢复）不会产生第二次结果。
// ---------------------------------------------------------------------------
function settleExpiredStagesTx(batch) {
  const fired = [];
  if (batch.status === 'completed' || batch.status === 'cancelled') return fired;
  let current = batch;
  for (;;) {
    const stage = db.prepare(`
      SELECT * FROM review_batch_stages
      WHERE batch_id = ? AND status = 'active' AND deadline_at IS NOT NULL AND deadline_at <= ?
      ORDER BY ordinal ASC LIMIT 1
    `).get(current.id, now());
    if (!stage) break;
    // 已落定（timeout_fired_at 非空）则只可能是 revoke_unused 的 closing 等待，直接退出
    if (stage.timeout_fired_at) break;
    const policy = stage.frozen_policy || stage.timeout_policy;
    const ts = now();
    if (policy === 'fail') {
      applyTimeoutFailTx(current, stage, ts);
      fired.push({ ordinal: stage.ordinal, timeoutResult: 'failed' });
      break;
    }
    if (policy === 'revoke_unused') {
      applyTimeoutRevokeUnusedTx(current, stage, ts);
      fired.push({ ordinal: stage.ordinal, timeoutResult: 'revoked_unused' });
      break;
    }
    // advance：系统自动驳回本阶段所有未决字段，随后激活下一阶段或完成批次
    applyTimeoutAdvanceTx(current, stage, ts);
    fired.push({ ordinal: stage.ordinal, timeoutResult: 'advanced' });
    current = loadBatchTx(current.id);
    if (current.status !== 'in_review') break;
  }
  return fired;
}

function applyTimeoutAdvanceTx(batch, stage, ts) {
  // 未决字段系统自动驳回（意见原样保留，不被改写）；已达终局的字段不动
  const pendingFields = db.prepare(`
    SELECT * FROM review_batch_fields WHERE stage_id = ? AND decision IS NULL ORDER BY ordinal
  `).all(stage.id);
  for (const field of pendingFields) {
    db.prepare(`
      UPDATE review_batch_fields
      SET decision = 'rejected', decided_at = ?, decided_by_user_id = NULL,
          decision_reason = ?, decided_by_policy = 'timeout_advance'
      WHERE id = ? AND decision IS NULL
    `).run(ts, BATCH_TIMEOUT_AUTO_REJECT_REASON, field.id);
  }
  db.prepare(`
    UPDATE review_batch_stages
    SET status = 'completed', completed_at = ?, final_decision = 'timeout_advanced',
        timeout_fired_at = ?, timeout_result = 'advanced'
    WHERE id = ?
  `).run(ts, ts, stage.id);
  addBatchEvent(batch.receipt_no, 'review.batch.stage.timeout', {
    batchId: batch.id, stageOrdinal: stage.ordinal, policy: 'advance',
    autoRejectedFields: pendingFields.map((f) => batchFieldKey(f.step, f.field)),
  });
  recordChangeHistoryTx({
    batchId: batch.id, type: 'batch.stage.timeout', fromVersion: null, toVersion: null,
    detail: { stageOrdinal: stage.ordinal, policy: 'advance', timeoutResult: 'advanced' }, ts,
  });
  activateNextStageOrCompleteTx(batch, stage, ts);
}

function applyTimeoutRevokeUnusedTx(batch, stage, ts) {
  // 撤销本阶段未使用邀请（含会话）；已校验邀请的会话保留为只读
  const unused = db.prepare(`
    SELECT id FROM review_batch_invitations
    WHERE stage_id = ? AND used_at IS NULL AND revoked_at IS NULL
  `).all(stage.id);
  for (const invite of unused) {
    db.prepare(`
      UPDATE review_batch_invitations
      SET status = 'revoked', revoked_at = ?, revoke_reason = '阶段限时到达：撤销未使用邀请'
      WHERE id = ?
    `).run(ts, invite.id);
  }
  db.prepare(`
    UPDATE review_batch_stages
    SET timeout_fired_at = ?, timeout_result = 'revoked_unused'
    WHERE id = ? AND timeout_fired_at IS NULL
  `).run(ts, stage.id);
  addBatchEvent(batch.receipt_no, 'review.batch.stage.timeout', {
    batchId: batch.id, stageOrdinal: stage.ordinal, policy: 'revoke_unused', revokedInvitationIds: unused.map((i) => i.id),
  });
  recordChangeHistoryTx({
    batchId: batch.id, type: 'batch.stage.timeout', fromVersion: null, toVersion: null,
    detail: { stageOrdinal: stage.ordinal, policy: 'revoke_unused', timeoutResult: 'revoked_unused', revokedCount: unused.length }, ts,
  });
}

function applyTimeoutFailTx(batch, stage, ts) {
  // 撤销全部未使用邀请；已校验复核人的【会话置为过期】而不是删除——
  // 意见表对会话有外键级联，删除会话会连带删除必须留档的意见。
  const unused = db.prepare(`
    SELECT id FROM review_batch_invitations WHERE batch_id = ? AND used_at IS NULL AND revoked_at IS NULL
  `).all(batch.id);
  for (const invite of unused) {
    db.prepare(`
      UPDATE review_batch_invitations
      SET status = 'revoked', revoked_at = ?, revoke_reason = '批次阶段超时失败'
      WHERE id = ?
    `).run(ts, invite.id);
  }
  db.prepare('UPDATE review_batch_sessions SET expires_at = 0 WHERE batch_id = ?').run(batch.id);
  db.prepare(`
    UPDATE review_batch_stages
    SET status = 'failed', completed_at = ?, final_decision = 'timeout_failed',
        timeout_fired_at = ?, timeout_result = 'failed'
    WHERE id = ?
  `).run(ts, ts, stage.id);
  // 其余 pending 阶段标记为未开放失败
  db.prepare(`
    UPDATE review_batch_stages SET final_decision = 'skipped_timeout'
    WHERE batch_id = ? AND status = 'pending'
  `).run(batch.id);
  db.prepare(`
    UPDATE review_batches SET status = 'timed_out', completed_at = ?, timeout_result = 'failed'
    WHERE id = ?
  `).run(ts, batch.id);
  addBatchEvent(batch.receipt_no, 'review.batch.stage.timeout', {
    batchId: batch.id, stageOrdinal: stage.ordinal, policy: 'fail', batchTimedOut: true,
  });
  recordChangeHistoryTx({
    batchId: batch.id, type: 'batch.stage.timeout', fromVersion: null, toVersion: null,
    detail: { stageOrdinal: stage.ordinal, policy: 'fail', timeoutResult: 'failed', batchTimedOut: true }, ts,
  });
}

// 阶段正常/超时终局后的统一推进：还有后续阶段则激活（冻结策略、起算倒计时、
// 重定邀请有效期），否则批次完成。
function activateNextStageOrCompleteTx(batch, finishedStage, ts) {
  const next = db.prepare(`
    SELECT * FROM review_batch_stages WHERE batch_id = ? AND ordinal > ? AND status = 'pending'
    ORDER BY ordinal ASC LIMIT 1
  `).get(batch.id, finishedStage.ordinal);
  if (!next) {
    const pending = db.prepare(`
      SELECT COUNT(*) AS n FROM review_batch_fields WHERE batch_id = ? AND decision IS NULL
    `).get(batch.id).n;
    if (pending === 0) {
      db.prepare("UPDATE review_batches SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'in_review'")
        .run(ts, batch.id);
      addBatchEvent(batch.receipt_no, 'review.batch.completed', { batchId: batch.id });
      recordChangeHistoryTx({
        batchId: batch.id, type: 'batch.completed', fromVersion: null, toVersion: null,
        detail: { afterStage: finishedStage.ordinal }, ts,
      });
    }
    return null;
  }
  const deadline = activateStageTx(batch, next, ts);
  addBatchEvent(batch.receipt_no, 'review.batch.stage.started', {
    batchId: batch.id, stageOrdinal: next.ordinal, stageName: next.name,
    deadlineAt: deadline, timeoutPolicy: next.timeout_policy, frozen: true,
  });
  recordChangeHistoryTx({
    batchId: batch.id, type: 'batch.stage.started', fromVersion: null, toVersion: null,
    detail: { stageOrdinal: next.ordinal, stageName: next.name, deadlineAt: deadline, timeoutPolicy: next.timeout_policy }, ts,
  });
  return next;
}

// ---------------------------------------------------------------------------
// 取消批次：仅 collecting 阶段允许（进入复核前，尚未产生任何决议）
// ---------------------------------------------------------------------------
export function cancelReviewBatch({ userId, batchId, reason }) {
  const text = String(reason || '').trim().slice(0, 200);
  return immediateTransaction(() => {
    settleExpiredStagesTx(loadBatchTx(batchId));
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
    if (row.status === 'timed_out') {
      return { ok: false, status: 409, code: 'BATCH_STAGE_TIMED_OUT', message: '批次已超时失败，不能取消', batch: batchOwnerView(row) };
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
      SET status = 'revoked', revoked_at = ?, revoke_reason = '批次取消'
      WHERE batch_id = ? AND revoked_at IS NULL AND used_at IS NULL
    `).run(ts, batchId);
    // 置为过期而非删除：意见表对会话有外键级联，删除会连带删除需要留档的意见
    db.prepare('UPDATE review_batch_sessions SET expires_at = 0 WHERE batch_id = ?').run(batchId);
    db.prepare(`
      UPDATE review_batch_stages
      SET final_decision = CASE WHEN status = 'pending' THEN 'skipped_cancelled' ELSE final_decision END
      WHERE batch_id = ? AND status = 'pending'
    `).run(batchId);
    db.prepare(`
      UPDATE review_batches SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
      WHERE id = ?
    `).run(ts, text, batchId);
    addBatchEvent(row.receipt_no, 'review.batch.cancelled', { batchId, reason: text });
    recordChangeHistoryTx({
      batchId, type: 'batch.cancelled', fromVersion: row.config_version, toVersion: row.config_version,
      detail: { reason: text }, ts,
    });
    return { ok: true, batch: batchOwnerView(loadBatchTx(batchId)) };
  });
}

// ---------------------------------------------------------------------------
// 撤销批次内单个邀请（使用前；已使用不能撤销）。分阶段批次只允许撤销“尚未开始”
// 阶段的邀请：当前进行中阶段的邀请撤销会破坏该阶段冻结的邀请范围与阈值分母。
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
    if (invite.stage_id) {
      const stage = db.prepare('SELECT * FROM review_batch_stages WHERE id = ?').get(invite.stage_id);
      if (stage && stage.status !== 'pending') {
        return {
          ok: false,
          status: 409,
          code: 'BATCH_CONFIG_LOCKED',
          message: stage.status === 'active'
            ? '该邀请所属阶段已经开始，邀请范围已冻结，不能再撤销'
            : '该邀请所属阶段已经终局，不能再撤销',
          invitation: invitationOwnerView(invite),
        };
      }
    }
    const ts = now();
    db.prepare("UPDATE review_batch_invitations SET status = 'revoked', revoked_at = ?, revoke_reason = '办理人撤销' WHERE id = ?")
      .run(ts, invite.id);
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
    // 惰性落定超时（例如 fail 策略批次可能已被后台扫描终结）
    settleExpiredStagesTx(batch);
    const batchNow = loadBatchTx(invite.batch_id);
    if (batchNow.status === 'cancelled' || invite.status === 'revoked' || invite.revoked_at) {
      return { ok: false, status: 410, code: 'BATCH_INVITATION_REVOKED' };
    }
    if (batchNow.status === 'timed_out') {
      return { ok: false, status: 410, code: 'BATCH_STAGE_TIMED_OUT', message: '批次已超时失败' };
    }
    if (batchNow.status === 'completed') {
      return { ok: false, status: 410, code: 'BATCH_NOT_ACTIVE' };
    }
    if (invite.used_at || invite.status === 'used') {
      return { ok: false, status: 410, code: 'BATCH_INVITATION_ALREADY_USED' };
    }
    if (invite.expires_at <= now() || batchNow.expires_at <= now()) {
      db.prepare("UPDATE review_batch_invitations SET status = 'expired' WHERE id = ?").run(invite.id);
      return { ok: false, status: 410, code: 'BATCH_INVITATION_EXPIRED' };
    }
    // 阶段门控：分阶段批次只能校验“当前进行中的阶段”的邀请；
    // 前序阶段未达终局时，后续阶段的邀请不能校验。
    // 平面批次的唯一阶段在门控通过前保持 pending，属于正常 collecting 状态，不拦截。
    let stage = null;
    if (invite.stage_id) {
      stage = db.prepare('SELECT * FROM review_batch_stages WHERE id = ?').get(invite.stage_id);
      if (batchNow.staged && stage.status === 'pending') {
        return {
          ok: false,
          status: 409,
          code: 'BATCH_STAGE_NOT_STARTED',
          message: `「${stage.name}」尚未开始：需等前一阶段达到终局条件后才开放校验`,
          stageOrdinal: stage.ordinal,
        };
      }
      if (batchNow.staged && stage.status !== 'active') {
        return {
          ok: false,
          status: 410,
          code: 'BATCH_STAGE_NOT_CURRENT',
          message: `「${stage.name}」已结束，邀请链接不再可用`,
          stageOrdinal: stage.ordinal,
        };
      }
      if (batchNow.staged && stage.deadline_at && stage.deadline_at <= now()) {
        // 极端竞态：截止刚到但尚未落定，直接拒绝并触发一次落定
        settleExpiredStagesTx(batchNow);
        return { ok: false, status: 410, code: 'BATCH_STAGE_DEADLINE_PASSED', message: '该阶段限时已过，邀请链接已失效' };
      }
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
    // 会话有效期不超过阶段截止（阶段未开始的平面批次则不超过批次/邀请有效期）
    const expiry = Math.min(invite.expires_at, batchNow.expires_at, stage?.deadline_at || invite.expires_at);
    db.prepare(`
      INSERT INTO review_batch_sessions
        (id, batch_id, batch_invitation_id, receipt_no, label, token_hash, csrf_secret,
         created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, batchNow.id, invite.id, receipt.receipt_no, invite.label, sha256(sessionRaw), csrf, ts, expiry, ts);

    addBatchEvent(receipt.receipt_no, 'review.batch.invitation.consumed', {
      batchId: batchNow.id, invitationId: invite.id, label: invite.label,
      stageOrdinal: stage ? stage.ordinal : null,
    });

    // 平面批次：全部校验完成时自动开门（分阶段批次不在此处推进阶段）。
    // 注意 pending 阶段邀请使用“远期占位”有效期，因此门控只看未校验/未撤销，不看 expires_at。
    let autoStarted = false;
    if (!batchNow.staged) {
      const remaining = db.prepare(`
        SELECT COUNT(*) AS n FROM review_batch_invitations
        WHERE batch_id = ? AND used_at IS NULL AND revoked_at IS NULL AND status <> 'revoked'
      `).get(batchNow.id).n;
      if (remaining === 0 && batchNow.status === 'collecting') {
        activateFlatStageTx(loadBatchTx(batchNow.id), ts);
        autoStarted = true;
        addBatchEvent(receipt.receipt_no, 'review.batch.started', { batchId: batchNow.id, auto: true });
      }
    }

    return {
      ok: true,
      sessionToken: sessionRaw,
      sessionId,
      csrf,
      batchId: batchNow.id,
      receiptNo: receipt.receipt_no,
      label: invite.label,
      expiresAt: expiry,
      stageOrdinal: stage ? stage.ordinal : null,
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
  // 批次取消或超时失败后会话立即失效；批次完成后会话保留为只读（复核人仍可查看字段决议结果）
  if (!batch || batch.status === 'cancelled' || batch.status === 'timed_out') return null;
  db.prepare('UPDATE review_batch_sessions SET last_seen_at = ? WHERE id = ?').run(now(), session.id);
  const stage = invite.stage_id
    ? db.prepare('SELECT * FROM review_batch_stages WHERE id = ?').get(invite.stage_id)
    : null;
  return { session, invite, batch, stage };
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

// 复核人上下文：只返回本邀请被授权、且属于【当前开放阶段】的脱敏字段 + 本人意见 + 阶段状态
export function getBatchReviewerContext(review) {
  const { session, invite, batch } = review;
  // 任何读取前先按冻结策略落定超时（幂等）；这里可能已处于路由事务之外，
  // 用独立写事务即可（sweep 与惰性落定都以 timeout_fired_at/状态条件更新为唯一判定）。
  settleExpiredStagesTopLevel(batch.id);
  const batchNow = loadBatchTx(batch.id);
  const stage = invite.stage_id
    ? db.prepare('SELECT * FROM review_batch_stages WHERE id = ?').get(invite.stage_id)
    : db.prepare("SELECT * FROM review_batch_stages WHERE batch_id = ? AND ordinal = 0").get(batch.id);
  const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(session.receipt_no);
  if (!receipt) return null;

  // 阶段状态摘要：复核人只应看到当前阶段的倒计时与结果
  const stageView = stage ? reviewerStageView(stage, batchNow) : null;
  const timedOut = batchNow.status === 'timed_out';
  // 后续阶段在“前一阶段未达终局”时不能查看：pending【分阶段】批次的后续阶段只返回门控信息，
  // 不下发任何字段；平面批次唯一阶段在 collecting 时也为 pending，但复核人仍可查看授权字段（仅提交受限）。
  const stageLocked = batchNow.staged && stage && stage.status === 'pending';
  // 分阶段已结束阶段只读；平面批次的 pending 是 collecting 门控期，字段仍可查看
  const stageClosed = batchNow.staged && (!stage || ['completed', 'timed_out', 'failed'].includes(stage.status));

  if (receipt.status === 'revoked' || timedOut) {
    return {
      batchId: batchNow.id,
      receiptNo: receipt.receipt_no,
      label: session.label,
      status: receipt.status === 'revoked' ? 'revoked' : 'batch_timed_out',
      batchStatus: batchNow.status,
      revokedAt: receipt.revoked_at,
      expiresAt: session.expires_at,
      stage: stageView,
      view: null,
      opinions: [],
      merged: [],
      canSubmit: false,
    };
  }
  const scope = stageLocked ? [] : sessionAuthorizedFieldRows(session.id);
  const authorizedKeys = scope.map((item) => batchFieldKey(item.step, item.field));
  const snapshot = JSON.parse(receipt.snapshot_json);
  const myOpinions = db.prepare(`
    SELECT * FROM review_batch_opinions WHERE session_id = ? ORDER BY created_at ASC
  `).all(session.id).map((row) => opinionView(row));

  // 同一字段的多份意见合并展示（只包含本邀请被授权字段），逐字保留每位复核人原始说明
  const fieldRows = stage
    ? db.prepare('SELECT * FROM review_batch_fields WHERE stage_id = ? ORDER BY ordinal, step, field').all(stage.id)
    : db.prepare('SELECT * FROM review_batch_fields WHERE batch_id = ? ORDER BY step, field').all(batchNow.id);
  const byKey = new Map(scope.map((item) => [batchFieldKey(item.step, item.field), item.batch_field_id]));
  const merged = stageLocked ? [] : fieldRows
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
        decidedByPolicy: fieldRow.decided_by_policy || '',
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

  // 仅在“当前进行中、截止时间未到、批次在复核中”的阶段允许提交
  const stageActive = stage && stage.status === 'active'
    && (!stage.deadline_at || stage.deadline_at > now());
  // revoke_unused 超时落定后阶段仍是 active，但未使用邀请已撤销：已校验会话不应再提交
  const revokedUnusedFired = stage && stage.timeout_fired_at && (stage.frozen_policy || stage.timeout_policy) === 'revoke_unused';
  const canSubmit = Boolean(stageActive) && batchNow.status === 'in_review' && !revokedUnusedFired;

  return {
    batchId: batchNow.id,
    receiptNo: receipt.receipt_no,
    label: session.label,
    status: receipt.status,
    batchStatus: batchNow.status,
    staged: Boolean(batchNow.staged),
    collecting: batchNow.status === 'collecting',
    canSubmit,
    stageLocked: Boolean(stageLocked),
    stageClosed: Boolean(stageClosed),
    issuedAt: receipt.issued_at,
    completedAt: snapshot.completedAt,
    expiresAt: session.expires_at,
    stage: stageView,
    view: buildBatchReviewView(snapshot, authorizedKeys),
    opinions: myOpinions,
    merged,
  };
}

// 复核人侧的阶段视图：序号、名称、状态、冻结策略与倒计时（不暴露其他阶段的配置细节）
function reviewerStageView(stage, batch) {
  const ts = now();
  const isCurrent = stage.status === 'active';
  return {
    ordinal: stage.ordinal,
    name: stage.name,
    status: stage.status === 'active' && stage.deadline_at && stage.deadline_at <= ts ? 'deadline_passed' : stage.status,
    startedAt: stage.started_at || null,
    deadlineAt: stage.deadline_at || null,
    remainingMs: isCurrent && stage.deadline_at ? Math.max(0, stage.deadline_at - ts) : 0,
    completedAt: stage.completed_at || null,
    finalDecision: stage.final_decision || '',
    timeoutResult: stage.timeout_result || '',
    isCurrent,
    stageCount: db.prepare('SELECT COUNT(*) AS n FROM review_batch_stages WHERE batch_id = ?').get(batch.id).n,
  };
}

// ---------------------------------------------------------------------------
// 复核人提交字段意见：只能针对授权字段；批次必须在复核中；每邀请每字段至多一条
// ---------------------------------------------------------------------------
export function submitBatchOpinion({ review, key, reason, idempotencyKey, requestHash }) {
  return immediateTransaction(() => {
    const { session, invite, batch } = review;
    // 提交前先按冻结策略落定超时（advance/fail 会改变阶段与批次状态）
    settleExpiredStagesTx(loadBatchTx(batch.id));
    const batchNow = loadBatchTx(batch.id);
    if (batchNow.status === 'cancelled') return { ok: false, status: 410, code: 'BATCH_NOT_ACTIVE' };
    if (batchNow.status === 'timed_out') return { ok: false, status: 410, code: 'BATCH_STAGE_TIMED_OUT', message: '批次已超时失败' };
    if (invite.status === 'revoked' || invite.revoked_at) return { ok: false, status: 410, code: 'BATCH_INVITATION_REVOKED' };
    if (invite.expires_at <= now() || session.expires_at <= now()) return { ok: false, status: 410, code: 'BATCH_INVITATION_EXPIRED' };
    const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(session.receipt_no);
    if (!receipt) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND' };
    if (receipt.status === 'revoked') return { ok: false, status: 410, code: 'RECEIPT_REVOKED' };

    // 阶段门控：只能在本邀请所属阶段处于 active、未到截止时间时提交
    const stage = invite.stage_id
      ? db.prepare('SELECT * FROM review_batch_stages WHERE id = ?').get(invite.stage_id)
      : db.prepare("SELECT * FROM review_batch_stages WHERE batch_id = ? AND ordinal = 0").get(batch.id);
    if (batchNow.staged) {
      if (!stage || stage.status === 'pending') {
        return { ok: false, status: 409, code: 'BATCH_STAGE_NOT_STARTED', message: '该阶段尚未开始：前一阶段未达终局前不能提交意见' };
      }
      if (stage.status !== 'active') {
        return { ok: false, status: 409, code: 'BATCH_STAGE_NOT_CURRENT', message: '该阶段已结束，不能再提交意见；已提交意见不会被改写' };
      }
      if (stage.deadline_at && stage.deadline_at <= now() && !stage.timeout_fired_at) {
        settleExpiredStagesTx(batchNow);
        return { ok: false, status: 410, code: 'BATCH_STAGE_DEADLINE_PASSED', message: '该阶段限时已过，意见提交通道已关闭' };
      }
      // revoke_unused 超时落定：阶段进入收尾，复核人不能再提交（办理人仍须用已收集意见决议）
      if (stage.timeout_fired_at) {
        return { ok: false, status: 409, code: 'BATCH_STAGE_NOT_CURRENT', message: '该阶段限时已过，未使用邀请已撤销，不能再提交意见' };
      }
    } else if (batchNow.status !== 'in_review') {
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
    // 越权阶段：字段虽在本邀请授权范围，但属于另一个（后续）阶段——不能提交
    if (stage && batchField.stage_id !== stage.id) {
      return { ok: false, status: 403, code: 'BATCH_STAGE_NOT_STARTED', message: '该字段属于尚未开放的后续阶段，不能提前提交意见' };
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
      stageOrdinal: stage ? stage.ordinal : null,
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
    // 决议前先按冻结策略落定超时
    settleExpiredStagesTx(batch);
    const batchNow = loadBatchTx(batchId);
    if (batchNow.status === 'cancelled') return batchConflict('批次已取消，不能作出决议');
    if (batchNow.status === 'timed_out') {
      return { ok: false, status: 409, code: 'BATCH_STAGE_TIMED_OUT', message: '批次已超时失败，不能作出决议', batch: batchOwnerView(batchNow) };
    }
    if (batchNow.status === 'completed') {
      const fieldRow = db.prepare('SELECT * FROM review_batch_fields WHERE id = ? AND batch_id = ?').get(batchFieldId, batchId);
      if (fieldRow) return { ok: false, status: 409, code: 'BATCH_FIELD_ALREADY_DECIDED', message: '批次已完成', field: fieldOwnerView(fieldRow) };
      return { ok: false, status: 404, code: 'BATCH_FIELD_NOT_FOUND', message: '字段不存在' };
    }
    if (batchNow.status !== 'in_review') {
      return { ok: false, status: 409, code: 'BATCH_GATE_NOT_SATISFIED', message: '批次尚未进入复核，不能作出决议', batch: batchOwnerView(batchNow) };
    }
    const fieldRow = db.prepare('SELECT * FROM review_batch_fields WHERE id = ? AND batch_id = ?').get(batchFieldId, batchId);
    if (!fieldRow) return { ok: false, status: 404, code: 'BATCH_FIELD_NOT_FOUND', message: '字段不存在或未纳入本批次编排' };

    // 阶段门控：只能决议“当前进行中的阶段”的字段；后续阶段字段、已结束阶段字段都被拒绝
    const stage = fieldRow.stage_id
      ? db.prepare('SELECT * FROM review_batch_stages WHERE id = ?').get(fieldRow.stage_id)
      : db.prepare("SELECT * FROM review_batch_stages WHERE batch_id = ? AND ordinal = 0").get(batchId);
    if (batchNow.staged) {
      if (!stage || stage.status === 'pending') {
        return {
          ok: false, status: 409, code: 'BATCH_STAGE_NOT_STARTED',
          message: `「${stage?.name || '后续阶段'}」尚未开始，前一阶段未达终局前不能校验、查看或提交意见`,
          batch: batchOwnerView(batchNow),
        };
      }
      if (stage.status !== 'active') {
        return { ok: false, status: 409, code: 'BATCH_STAGE_NOT_CURRENT', message: `「${stage.name}」已结束，不能再对其字段作出决议`, batch: batchOwnerView(batchNow) };
      }
      if (stage.deadline_at && stage.deadline_at <= now() && !stage.timeout_fired_at) {
        settleExpiredStagesTx(batchNow);
        return { ok: false, status: 409, code: 'BATCH_STAGE_DEADLINE_PASSED', message: '该阶段限时已过，正在按冻结策略处理', batch: batchOwnerView(loadBatchTx(batchId)) };
      }
    }

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
    // 阈值分母只统计“本阶段”已完成校验且未撤销的邀请
    const stageInviteCount = stage
      ? db.prepare(`
        SELECT COUNT(DISTINCT id) AS n FROM review_batch_invitations
        WHERE stage_id = ? AND used_at IS NOT NULL AND revoked_at IS NULL
      `).get(stage.id).n
      : 0;

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
            correction_workflow_id = ?, correction_receipt_no = '', decided_by_policy = ''
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
          INSERT OR IGNORE INTO correction_objections
            (workflow_id, objection_id, batch_opinion_id, source_batch_id, source_round_id, created_at)
          VALUES (?, NULL, ?, ?, '', ?)
        `).run(workflow.id, opinion.id, batchId, ts);
      }
      addBatchEvent(batch.receipt_no, 'review.batch.field.accepted', {
        batchId, batchFieldId, stageOrdinal: stage ? stage.ordinal : null,
        workflowId: workflow.id, created, opinionIds: opinions.map((item) => item.id),
      });
      const result = maybeCompleteStageTx(batchNow, stage);
      return {
        ok: true,
        created,
        field: fieldOwnerView(loadBatchFieldRow(batchFieldId)),
        workflow: publicWorkflow(workflow, getSteps(workflow.id)),
        batch: result.batch,
        batchCompleted: result.completed,
        stageAdvanced: result.advanced,
      };
    }

    if (action === 'reject') {
      if (reasonText.length < BATCH_OPINION_MIN || reasonText.length > BATCH_REJECT_REASON_MAX) {
        return { ok: false, status: 400, code: 'REJECT_REASON_REQUIRED', message: `驳回理由需为 ${BATCH_OPINION_MIN}-${BATCH_REJECT_REASON_MAX} 个字符` };
      }
      // 驳回阈值：本阶段已校验有效邀请中，没有提出异议（即支持驳回）的复核人数必须达到阈值。
      const rejectSupport = stageInviteCount - supportCount;
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
        SET decision = 'rejected', decided_at = ?, decided_by_user_id = ?, decision_reason = ?, decided_by_policy = ''
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
        batchId, batchFieldId, stageOrdinal: stage ? stage.ordinal : null, reason: reasonText,
      });
      const result = maybeCompleteStageTx(batchNow, stage);
      return {
        ok: true,
        field: fieldOwnerView(loadBatchFieldRow(batchFieldId)),
        batch: result.batch,
        batchCompleted: result.completed,
        stageAdvanced: result.advanced,
      };
    }

    return { ok: false, status: 400, code: 'INVALID_ACTION', message: '决议类型必须是 accept 或 reject' };
  });
}

// 当前阶段全部字段都有终局决议后：阶段完成，并按顺序开放下一阶段（激活/冻结/倒计时）；
// 最后一个阶段完成 → 批次 completed。revoke_unused 超时收尾时同样走这里。
function maybeCompleteStageTx(batch, stage) {
  if (stage) {
    const pendingInStage = db.prepare(`
      SELECT COUNT(*) AS n FROM review_batch_fields WHERE stage_id = ? AND decision IS NULL
    `).get(stage.id).n;
    if (pendingInStage > 0) {
      return { completed: false, advanced: false, batch: batchOwnerView(loadBatchTx(batch.id)) };
    }
    const ts = now();
    db.prepare(`
      UPDATE review_batch_stages
      SET status = 'completed', completed_at = COALESCE(completed_at, ?),
          final_decision = CASE WHEN final_decision = '' THEN 'decided' ELSE final_decision END
      WHERE id = ? AND status = 'active'
    `).run(ts, stage.id);
    addBatchEvent(batch.receipt_no, 'review.batch.stage.completed', {
      batchId: batch.id, stageOrdinal: stage.ordinal, stageName: stage.name,
      timedOut: Boolean(stage.timeout_fired_at),
    });
    recordChangeHistoryTx({
      batchId: batch.id, type: 'batch.stage.completed', fromVersion: null, toVersion: null,
      detail: { stageOrdinal: stage.ordinal, stageName: stage.name, timedOut: Boolean(stage.timeout_fired_at) }, ts,
    });
    const next = activateNextStageOrCompleteTx(batch, stage, ts);
    const refreshed = loadBatchTx(batch.id);
    return {
      completed: refreshed.status === 'completed',
      advanced: Boolean(next),
      batch: batchOwnerView(refreshed),
    };
  }

  // 平面批次（无显式阶段）：全部字段决议完成 → 批次完成
  const pending = db.prepare(`
    SELECT COUNT(*) AS n FROM review_batch_fields WHERE batch_id = ? AND decision IS NULL
  `).get(batch.id).n;
  if (pending > 0) return { completed: false, advanced: false, batch: batchOwnerView(loadBatchTx(batch.id)) };
  const ts = now();
  db.prepare("UPDATE review_batches SET status = 'completed', completed_at = ? WHERE id = ? AND status = 'in_review'")
    .run(ts, batch.id);
  db.prepare("UPDATE review_batch_stages SET status = 'completed', completed_at = ?, final_decision = 'decided' WHERE batch_id = ? AND status = 'active'")
    .run(ts, batch.id);
  addBatchEvent(batch.receipt_no, 'review.batch.completed', { batchId: batch.id });
  recordChangeHistoryTx({
    batchId: batch.id, type: 'batch.completed', fromVersion: null, toVersion: null,
    detail: { flat: true }, ts,
  });
  return { completed: true, advanced: false, batch: batchOwnerView(loadBatchTx(batch.id)) };
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

// 在调用方事务内执行（放弃更正的同一事务）：接受字段决议回收为待决议。
// 分阶段批次下，被回收字段所属的阶段重新激活（批次从 completed/timed 后续状态回到
// in_review）：阶段切换不改写已提交意见，决议按当前阶段重新作出。
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
        correction_workflow_id = NULL, correction_receipt_no = '', decided_by_policy = ''
    WHERE id IN (${fieldIds.map(() => '?').join(',')}) AND decision = 'accepted'
  `).run(...fieldIds);
  db.prepare(`
    UPDATE review_batch_opinions SET correction_receipt_no = ''
    WHERE id IN (${opinionRows.map(() => '?').join(',')})
  `).run(...opinionRows.map((row) => row.id));
  for (const batchId of batchIds) {
    const batch = loadBatchTx(batchId);
    if (!batch) continue;
    if (batch.staged) {
      // 找到含被回收字段的（已完成/超时推进）阶段：重新置为 active，批次回到 in_review
      const stageIds = [...new Set(fieldIds
        .map((id) => db.prepare('SELECT stage_id FROM review_batch_fields WHERE id = ?').get(id)?.stage_id)
        .filter(Boolean))];
      for (const stageId of stageIds) {
        db.prepare(`
          UPDATE review_batch_stages
          SET status = 'active', completed_at = NULL, final_decision = '',
              timeout_fired_at = NULL, timeout_result = ''
          WHERE id = ? AND status IN ('completed', 'timed_out', 'failed')
        `).run(stageId);
      }
      // 后续已激活阶段回退为 pending（顺序约束：一次只能有一个进行中阶段）
      if (stageIds.length) {
        const minOrdinal = Math.min(...stageIds.map((id) => db.prepare('SELECT ordinal FROM review_batch_stages WHERE id = ?').get(id).ordinal));
        db.prepare(`
          UPDATE review_batch_stages
          SET status = 'pending', started_at = NULL, deadline_at = NULL, completed_at = NULL,
              final_decision = CASE WHEN final_decision IN ('skipped_cancelled') THEN final_decision ELSE '' END,
              timeout_fired_at = NULL, timeout_result = '', frozen_policy = ''
          WHERE batch_id = ? AND ordinal > ? AND status IN ('active', 'completed')
        `).run(batchId, minOrdinal);
      }
      db.prepare(`
        UPDATE review_batches SET status = 'in_review', completed_at = NULL, timeout_result = ''
        WHERE id = ? AND status IN ('completed', 'timed_out')
      `).run(batchId);
    } else {
      // 平面批次：批次从 completed 回到 in_review
      db.prepare(`
        UPDATE review_batches SET status = 'in_review', completed_at = NULL
        WHERE id = ? AND status = 'completed'
      `).run(batchId);
    }
    addBatchEvent(batch.receipt_no, 'review.batch.reopened', { batchId, fieldIds });
  }
  return fieldIds;
}

// ---------------------------------------------------------------------------
// 编排重配（仅阶段尚未开始前）：乐观锁版本号 + 整体替换。
// 两个办理页面同时修改时，UPDATE … WHERE config_version = expectedVersion 只放行一个；
// 已开始（任何阶段进入 active/completed/timed_out/failed）的批次明确拒绝。
// ---------------------------------------------------------------------------
export function reconfigureBatch({ userId, batchId, expectedVersion, config, ttlMs }) {
  return immediateTransaction(() => {
    const row = loadBatchTx(batchId);
    if (!row || row.user_id !== userId) {
      return { ok: false, status: 404, code: 'BATCH_NOT_FOUND', message: '复核批次不存在' };
    }
    if (row.status === 'cancelled' || row.status === 'completed' || row.status === 'timed_out') {
      return { ok: false, status: 409, code: 'BATCH_NOT_ACTIVE', message: '批次已终结，不能再调整编排', batch: batchOwnerView(row) };
    }
    // 乐观锁：必须携带当前版本号
    if (!Number.isInteger(expectedVersion)) {
      return { ok: false, status: 409, code: 'BATCH_CONFIG_VERSION_CONFLICT', message: '调整编排必须携带当前配置版本号', batch: batchOwnerView(row) };
    }
    if (expectedVersion !== row.config_version) {
      return {
        ok: false,
        status: 409,
        code: 'BATCH_CONFIG_VERSION_CONFLICT',
        message: `编排已更新到 v${row.config_version}（你基于 v${expectedVersion} 编辑），请刷新后基于最新版本重新编辑`,
        currentVersion: row.config_version,
        batch: batchOwnerView(row),
      };
    }
    // 已开始阶段的配置冻结：任何已激活/已终局阶段都不允许重配
    const started = db.prepare(`
      SELECT * FROM review_batch_stages WHERE batch_id = ? AND status <> 'pending'
      ORDER BY ordinal ASC LIMIT 1
    `).get(batchId);
    if (started) {
      return {
        ok: false,
        status: 409,
        code: 'BATCH_CONFIG_LOCKED',
        message: `「${started.name}」已经开始，阶段配置在开始时冻结，不能再修改`,
        batch: batchOwnerView(row),
      };
    }
    // 安全兜底：已有任何一次性校验/意见时不允许替换编排
    const used = db.prepare(`
      SELECT COUNT(*) AS n FROM review_batch_invitations WHERE batch_id = ? AND used_at IS NOT NULL
    `).get(batchId).n;
    if (used > 0) {
      return { ok: false, status: 409, code: 'BATCH_CONFIG_LOCKED', message: '已有邀请完成校验，编排不能再修改', batch: batchOwnerView(row) };
    }

    const ts = now();
    // 重配只发生在任何邀请校验之前：无会话与意见，可安全整体替换
    db.prepare('DELETE FROM review_batch_invitation_fields WHERE invitation_id IN (SELECT id FROM review_batch_invitations WHERE batch_id = ?)').run(batchId);
    db.prepare('DELETE FROM review_batch_invitations WHERE batch_id = ?').run(batchId);
    db.prepare('DELETE FROM review_batch_fields WHERE batch_id = ?').run(batchId);
    db.prepare('DELETE FROM review_batch_stages WHERE batch_id = ?').run(batchId);

    const staged = config.kind === 'staged';
    const stageSpecs = staged
      ? config.stages.map((stage, ordinal) => ({
        name: stage.name, ordinal, durationMs: stage.ttlMinutes * 60000,
        timeoutPolicy: stage.timeoutPolicy, fields: stage.fields, invitations: stage.invitations,
      }))
      : [{ name: '统一复核', ordinal: 0, durationMs: ttlMs, timeoutPolicy: 'advance', fields: config.fields, invitations: config.invitations }];

    const fieldIdByKey = new Map();
    const invitations = [];
    // 重配后所有阶段仍为 pending：办理人需要再次显式启动第一阶段
    stageSpecs.forEach((spec) => {
      const stageId = cryptoId();
      db.prepare(`
        INSERT INTO review_batch_stages
          (id, batch_id, ordinal, name, status, duration_ms, timeout_policy, frozen_policy,
           created_at, started_at, deadline_at, completed_at, final_decision, timeout_fired_at, timeout_result)
        VALUES (?, ?, ?, ?, 'pending', ?, ?, '', ?, NULL, NULL, NULL, '', NULL, '')
      `).run(stageId, batchId, spec.ordinal, spec.name, spec.durationMs, spec.timeoutPolicy, ts);

      spec.fields.forEach((field, fieldOrdinal) => {
        const fieldId = cryptoId();
        db.prepare(`
          INSERT INTO review_batch_fields
            (id, batch_id, stage_id, ordinal, step, field, field_label, accept_threshold,
             reject_threshold, decided_by_policy, decision, decided_at, decided_by_user_id,
             decision_reason, correction_workflow_id, correction_receipt_no)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', NULL, NULL, NULL, '', NULL, '')
        `).run(fieldId, batchId, stageId, fieldOrdinal, field.step, field.field,
          batchFieldLabel(field.step, field.field), field.acceptThreshold, field.rejectThreshold);
        fieldIdByKey.set(`${spec.ordinal}:${field.key}`, fieldId);
      });

      spec.invitations.forEach((invite, inviteOrdinal) => {
        const raw = tokenUrlSafe();
        const inviteId = cryptoId();
        const inviteExpiresAt = staged ? ts + STAGE_PENDING_EXPIRES_MS : ts + ttlMs;
        db.prepare(`
          INSERT INTO review_batch_invitations
            (id, batch_id, stage_id, ordinal, receipt_no, user_id, label, token_hash, status,
             created_at, expires_at, used_at, used_ip, revoked_at, revoke_reason)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, '', NULL, '')
        `).run(inviteId, batchId, stageId, inviteOrdinal, row.receipt_no, userId,
          invite.label, sha256(raw), ts, inviteExpiresAt);
        for (const key of invite.scopeKeys) {
          const batchFieldId = fieldIdByKey.get(`${spec.ordinal}:${key}`);
          const parsedKey = key.split('.');
          db.prepare(`
            INSERT INTO review_batch_invitation_fields (invitation_id, batch_field_id, step, field)
            VALUES (?, ?, ?, ?)
          `).run(inviteId, batchFieldId, Number(parsedKey[0]), parsedKey[1]);
        }
        invitations.push({ id: inviteId, stageId, label: invite.label, token: raw });
      });
    });

    // 乐观锁落库：只有版本号仍是 expectedVersion 的事务能把版本 +1（并发的第二个改动 0 行）
    const bumped = db.prepare(`
      UPDATE review_batches
      SET staged = ?, invitation_count = ?, note = ?, status = 'collecting',
          started_at = NULL, expires_at = ?
      WHERE id = ? AND config_version = ?
    `).run(
      staged ? 1 : 0, invitations.length, config.note,
      staged ? ts + stageSpecs.reduce((sum, spec) => sum + spec.durationMs, 0) : ts + ttlMs,
      batchId, expectedVersion,
    );
    if (bumped.changes === 0) {
      // 理论上不会到这里（同事务已读版本），仍显式失败让调用方重读
      return {
        ok: false, status: 409, code: 'BATCH_CONFIG_VERSION_CONFLICT',
        message: '编排刚被另一个页面修改，本次调整未生效，请刷新重试',
        batch: batchOwnerView(loadBatchTx(batchId)),
      };
    }
    const newVersion = expectedVersion + 1;
    db.prepare('UPDATE review_batches SET config_version = ? WHERE id = ?').run(newVersion, batchId);
    const snapshot = snapshotOrchestrationTx(batchId);
    recordOrchestrationVersionTx({ batchId, version: newVersion, config: snapshot, note: '办理人调整编排', ts });
    recordChangeHistoryTx({
      batchId, type: 'batch.reconfigured', fromVersion: expectedVersion, toVersion: newVersion,
      detail: { staged, invitationCount: invitations.length, stageCount: stageSpecs.length }, ts,
    });
    addBatchEvent(row.receipt_no, 'review.batch.reconfigured', {
      batchId, fromVersion: expectedVersion, toVersion: newVersion,
    });
    return {
      ok: true, version: newVersion, batch: batchOwnerView(loadBatchTx(batchId)),
      links: invitations.map((invite) => ({
        invitationId: invite.id, label: invite.label, token: invite.token,
        url: `/batch-review?t=${encodeURIComponent(invite.token)}`,
      })),
    };
  });
}

// 编排配置版本与变更历史（办理人页面）
export function getBatchOrchestrationHistory({ userId, batchId }) {
  const row = loadBatchTx(batchId);
  if (!row || row.user_id !== userId) return null;
  const versions = db.prepare(`
    SELECT * FROM review_batch_orchestration_versions WHERE batch_id = ? ORDER BY version ASC
  `).all(batchId).map((item) => ({
    version: item.version,
    note: item.change_note,
    createdAt: item.created_at,
    config: JSON.parse(item.config_json),
  }));
  const history = db.prepare(`
    SELECT * FROM review_batch_change_history WHERE batch_id = ? ORDER BY created_at ASC, rowid ASC
  `).all(batchId).map((item) => ({
    id: item.id,
    type: item.type,
    fromVersion: item.from_version,
    toVersion: item.to_version,
    detail: JSON.parse(item.detail_json),
    createdAt: item.created_at,
  }));
  return { configVersion: row.config_version, versions, history };
}

// 后台/启动时扫描：把所有已到截止时间的活动阶段按冻结策略落定（幂等）。
// 供 server.js 的定时器与启动恢复调用；重复触发不会产生第二次结果。
export function sweepBatchTimeouts() {
  const candidates = db.prepare(`
    SELECT b.* FROM review_batches b
    JOIN review_batch_stages s ON s.batch_id = b.id
    WHERE b.status IN ('collecting', 'in_review')
      AND s.status = 'active' AND s.deadline_at IS NOT NULL AND s.deadline_at <= ?
      AND s.timeout_fired_at IS NULL
  `).all(now());
  let changed = 0;
  for (const batch of candidates) {
    const result = immediateTransaction(() => settleExpiredStagesTx(batch));
    changed += result.length;
  }
  return changed;
}

// 读路径上的惰性落定：独立事务，幂等
function settleExpiredStagesTopLevel(batchId) {
  const batch = loadBatchTx(batchId);
  if (!batch) return [];
  if (batch.status === 'completed' || batch.status === 'cancelled' || batch.status === 'timed_out') return [];
  const due = db.prepare(`
    SELECT COUNT(*) AS n FROM review_batch_stages
    WHERE batch_id = ? AND status = 'active' AND deadline_at IS NOT NULL AND deadline_at <= ?
      AND timeout_fired_at IS NULL
  `).get(batchId, now()).n;
  if (due === 0) return [];
  return immediateTransaction(() => settleExpiredStagesTx(loadBatchTx(batchId)));
}

// ---------------------------------------------------------------------------
// 时间线：在对应回执后插入批次条目（含阶段事件、配置版本、逐阶段最终决议、
// 逐字段意见合并、超时结果、变更历史与更正来源关系）
// ---------------------------------------------------------------------------
export function buildBatchTimelineEntries(userId) {
  const batches = db.prepare('SELECT * FROM review_batches WHERE user_id = ? ORDER BY created_at ASC').all(userId);
  const result = [];
  for (const row of batches) {
    const view = batchOwnerView(row);
    const invitationSummaries = view.invitations.map((invite) => ({
      id: invite.id,
      stageId: invite.stageId,
      stageOrdinal: invite.stageOrdinal,
      label: invite.label,
      status: invite.status,
      createdAt: invite.createdAt,
      expiresAt: invite.expiresAt,
      usedAt: invite.usedAt,
      revokedAt: invite.revokedAt,
      revokeReason: invite.revokeReason,
      fieldKeys: invite.fields.map((field) => field.key),
    }));
    const fields = view.fields.map((field) => ({
      id: field.id,
      stageId: field.stageId,
      key: field.key,
      step: field.step,
      field: field.field,
      label: field.label,
      acceptThreshold: field.acceptThreshold,
      rejectThreshold: field.rejectThreshold,
      decidedByPolicy: field.decidedByPolicy,
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
    const stages = view.stages.map((stage) => ({
      id: stage.id,
      ordinal: stage.ordinal,
      name: stage.name,
      status: stage.status,
      durationMs: stage.durationMs,
      timeoutPolicy: stage.timeoutPolicy,
      frozenPolicy: stage.frozenPolicy,
      startedAt: stage.startedAt,
      deadlineAt: stage.deadlineAt,
      completedAt: stage.completedAt,
      finalDecision: stage.finalDecision,
      timeoutFiredAt: stage.timeoutFiredAt,
      timeoutResult: stage.timeoutResult,
      invitationCount: stage.invitationCount,
      validatedCount: stage.validatedCount,
      revokedCount: stage.revokedCount,
      fieldCount: stage.fieldCount,
      acceptedCount: stage.acceptedCount,
      rejectedCount: stage.rejectedCount,
      pendingFieldCount: stage.pendingFieldCount,
      opinionTotal: stage.opinionTotal,
      invitationIds: stage.invitations.map((invite) => invite.id),
    }));
    const historyRows = db.prepare(`
      SELECT * FROM review_batch_change_history WHERE batch_id = ? ORDER BY created_at ASC, rowid ASC
    `).all(row.id);
    const changeHistory = historyRows.map((item) => ({
      type: item.type,
      fromVersion: item.from_version,
      toVersion: item.to_version,
      detail: JSON.parse(item.detail_json),
      at: item.created_at,
    }));
    result.push({
      kind: 'reviewBatch',
      batchId: row.id,
      receiptNo: row.receipt_no,
      status: view.status,
      note: row.note,
      staged: Boolean(row.staged),
      configVersion: row.config_version,
      timeoutResult: row.timeout_result || '',
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      cancelledAt: row.cancelled_at,
      cancelReason: row.cancel_reason,
      invitationCount: row.invitation_count,
      validatedCount: view.validatedCount,
      currentStageOrdinal: view.currentStageOrdinal,
      currentStageDeadlineAt: view.currentStageDeadlineAt,
      invitations: invitationSummaries,
      stages,
      fields,
      changeHistory,
    });
  }
  return result;
}

export { ALL_BATCH_FIELDS, BATCH_MAX_INVITATIONS, BATCH_MAX_STAGES, BATCH_STAGE_TIMEOUT_POLICIES };
