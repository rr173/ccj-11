// ---------------------------------------------------------------------------
// 争议调解包的持久化与事务编排
//
// 调解包只能【冻结引用】申诉回合与原批次的历史：本模块不写任何 review_batches /
// review_batch_fields / review_appeal_rounds / review_appeal_fields /
// review_appeal_opinions 行。所有终局状态变更都在 BEGIN IMMEDIATE 事务中以
// “当前状态 + 行级条件更新”为唯一判定：并发创建/决议/取消只有一个请求成功。
// ---------------------------------------------------------------------------
import { db, immediateTransaction, cryptoId, getActiveWorkflow, getSteps, userQueries, publicWorkflow } from './db.js';
import { sha256, tokenUrlSafe } from './crypto.js';
import { batchFieldKey, batchFieldTextValue } from './batchReviews.js';
import {
  MEDIATION_OPINION_MIN,
  MEDIATION_OPINION_MAX,
  MEDIATION_REJECT_REASON_MAX,
  MEDIATION_ERRORS,
  MEDIATION_TIMEOUT_AUTO_REJECT_REASON,
  mediationFieldLabel,
  buildMediationReviewView,
} from './mediationReviews.js';

function now() {
  return Date.now();
}

// 第二层 pending 期间的“远期占位”有效期：真正截止时间在第一层升级冻结第二层时确定
const TIER_PENDING_EXPIRES_MS = 365 * 24 * 60 * 60 * 1000;

function addMediationEvent(receiptNo, type, detail) {
  const row = db.prepare('SELECT workflow_id FROM receipts WHERE receipt_no = ?').get(receiptNo);
  if (!row) return;
  db.prepare(`
    INSERT INTO events (workflow_id, type, step, detail_json, created_at)
    VALUES (?, ?, NULL, ?, ?)
  `).run(row.workflow_id, type, JSON.stringify({ receiptNo, ...detail }), now());
}

function loadPackageTx(packageId) {
  return db.prepare('SELECT * FROM mediation_packages WHERE id = ?').get(packageId) || null;
}

function loadTierTx(packageId, tier) {
  return db.prepare('SELECT * FROM mediation_tiers WHERE package_id = ? AND tier = ?').get(packageId, tier) || null;
}

function effectiveInviteStatus(row) {
  if (row.status === 'active' && row.expires_at <= now()) {
    db.prepare("UPDATE mediation_invitations SET status = 'expired' WHERE id = ? AND status = 'active'").run(row.id);
    return 'expired';
  }
  return row.status;
}

// ---------------------------------------------------------------------------
// 可生成调解包的申诉字段：来自【已完成全部字段决议】的申诉回合中 decision='rejected'
// 的字段（含被系统超时策略自动驳回）。进行中/取消/过期回合不能生成调解包。
// ---------------------------------------------------------------------------
export function listMediatableAppealFields({ userId, roundId }) {
  const round = db.prepare(`
    SELECT * FROM review_appeal_rounds WHERE id = ? AND user_id = ?
  `).get(roundId, userId);
  if (!round) return null;
  if (round.status !== 'completed') {
    return { roundId, frozen: false, status: round.status, fields: [] };
  }
  const fields = db.prepare(`
    SELECT * FROM review_appeal_fields WHERE round_id = ? ORDER BY created_at ASC, rowid ASC
  `).all(roundId);
  return {
    roundId,
    frozen: true,
    status: round.status,
    batchId: round.batch_id,
    receiptNo: round.receipt_no,
    fields: fields
      .filter((row) => row.decision === 'rejected')
      .map((row) => {
        const appealOpinions = db.prepare(`
          SELECT id, reviewer_label, reason, value_snapshot, created_at
          FROM review_appeal_opinions WHERE appeal_field_id = ? ORDER BY created_at ASC, rowid ASC
        `).all(row.id);
        // 申诉回合中办理人显式授权并已冻结的证据（调解包只能从这些证据中选择）
        const evidence = db.prepare(`
          SELECT id, source_alias, source_value_snapshot, source_reason, source_created_at
          FROM review_appeal_evidence WHERE appeal_field_id = ? ORDER BY source_created_at ASC, rowid ASC
        `).all(row.id);
        const original = db.prepare('SELECT decision, decision_reason, decided_at, decided_by_policy, decided_by_user_id FROM review_batch_fields WHERE id = ?')
          .get(row.source_field_id);
        return {
          appealFieldId: row.id,
          sourceFieldId: row.source_field_id,
          key: batchFieldKey(row.step, row.field),
          step: row.step,
          field: row.field,
          label: row.field_label,
          appealDecision: row.decision,
          appealDecisionReason: row.decision_reason || '',
          appealDecidedAt: row.decided_at || null,
          originalDecision: original ? {
            decision: original.decision,
            reason: original.decision_reason || '',
            decidedAt: original.decided_at || null,
            decidedByPolicy: original.decided_by_policy || '',
          } : null,
          appealOpinions: appealOpinions.map((opinion) => ({
            id: opinion.id,
            label: opinion.reviewer_label,
            reason: opinion.reason,
            valueSnapshot: opinion.value_snapshot,
            submittedAt: opinion.created_at,
          })),
          evidence: evidence.map((item) => ({
            id: item.id,
            alias: item.source_alias,
            valueSnapshot: item.source_value_snapshot,
            reason: item.source_reason,
            originalSubmittedAt: item.source_created_at,
          })),
        };
      }),
  };
}

// ---------------------------------------------------------------------------
// 生成只读调解包
// ---------------------------------------------------------------------------
export function createMediationPackage({ userId, config }) {
  try {
    return immediateTransaction(() => {
      const round = db.prepare(`
        SELECT * FROM review_appeal_rounds WHERE id = ? AND user_id = ?
      `).get(config.roundId, userId);
      if (!round) {
        return { ok: false, status: 404, code: 'MEDIATION_NOT_FOUND', message: '申诉回合不存在' };
      }
      if (round.status !== 'completed') {
        return {
          ok: false,
          status: 409,
          code: 'MEDIATION_SOURCE_NOT_FROZEN',
          message: MEDIATION_ERRORS.MEDIATION_SOURCE_NOT_FROZEN,
        };
      }
      const openPackage = db.prepare(`
        SELECT id FROM mediation_packages
        WHERE round_id = ? AND status IN ('mediating', 'arbitrating')
      `).get(round.id);
      if (openPackage) {
        return { ok: false, status: 409, code: 'MEDIATION_ALREADY_OPEN', message: MEDIATION_ERRORS.MEDIATION_ALREADY_OPEN };
      }
      const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ? AND user_id = ?')
        .get(round.receipt_no, userId);
      if (!receipt) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND', message: '原回执不存在' };
      if (receipt.status === 'revoked') {
        return { ok: false, status: 409, code: 'RECEIPT_REVOKED', message: '已撤销的回执不能生成调解包' };
      }

      // ---- 只读校验（任何失败都在第一条 INSERT 之前返回）----
      const appealFieldRows = db.prepare('SELECT * FROM review_appeal_fields WHERE round_id = ?').all(round.id);
      const appealByKey = new Map(appealFieldRows.map((row) => [batchFieldKey(row.step, row.field), row]));
      const preparedFields = [];
      for (const spec of config.fields) {
        const appealField = appealByKey.get(spec.key);
        if (!appealField) {
          return { ok: false, status: 400, code: 'MEDIATION_FIELD_NOT_REJECTED', message: `字段 ${spec.key} 不属于该申诉回合` };
        }
        if (appealField.decision !== 'rejected') {
          return {
            ok: false,
            status: 409,
            code: 'MEDIATION_FIELD_NOT_REJECTED',
            message: `字段 ${spec.key} 的申诉未被驳回，不能选入调解包`,
          };
        }
        const sourceField = db.prepare('SELECT * FROM review_batch_fields WHERE id = ?').get(appealField.source_field_id);
        if (!sourceField) {
          return { ok: false, status: 400, code: 'MEDIATION_NOT_FOUND', message: `字段 ${spec.key} 的原批次决议不存在` };
        }
        // 证据白名单：只能选择该申诉字段下已授权冻结的证据（review_appeal_evidence 行）；
        // 调解包不能混入未授权证据
        const evidenceRows = spec.evidenceOpinionIds.length
          ? db.prepare(`
              SELECT * FROM review_appeal_evidence
              WHERE appeal_field_id = ? AND id IN (${spec.evidenceOpinionIds.map(() => '?').join(',')})
              ORDER BY source_created_at ASC, rowid ASC
            `).all(appealField.id, ...spec.evidenceOpinionIds)
          : [];
        if (evidenceRows.length !== spec.evidenceOpinionIds.length) {
          return {
            ok: false,
            status: 400,
            code: 'INVALID_MEDIATION_EVIDENCE',
            message: `字段 ${spec.key} 授权冻结的证据不存在或不属于该字段`,
          };
        }
        preparedFields.push({ spec, appealField, sourceField, evidenceRows });
      }

      // 第一层/第二层字段都必须是选中字段的子集（解析器已保证第二层 ⊆ 第一层 ⊆ 选中字段）
      const selectedKeys = new Set(config.fields.map((field) => field.key));
      for (const layer of [config.layer1, config.layer2]) {
        for (const field of layer.fields) {
          if (!selectedKeys.has(field.key)) {
            return { ok: false, status: 400, code: 'INVALID_MEDIATION_FIELD_SCOPE', message: `层级字段 ${field.key} 不在调解包选中字段中` };
          }
        }
      }

      // ---- 校验通过，冻结写入 ----
      const ts = now();
      const packageId = cryptoId();
      // 当前更正来源快照：回执当前是否已有进行中同源更正（仅记录冻结时点状态）
      const activeCorrection = getActiveWorkflow(userId);
      const frozenSnapshot = buildFrozenSnapshot({
        round, receipt, preparedFields, activeCorrection, config, frozenAt: ts,
      });
      db.prepare(`
        INSERT INTO mediation_packages
          (id, round_id, batch_id, receipt_no, workflow_id, user_id, status, note,
           frozen_snapshot_json, created_at, cancelled_at, cancel_reason, completed_at,
           expired_at, escalated_at)
        VALUES (?, ?, ?, ?, ?, ?, 'mediating', ?, ?, ?, NULL, '', NULL, NULL, NULL)
      `).run(packageId, round.id, round.batch_id, receipt.receipt_no, receipt.workflow_id, userId,
        config.note, JSON.stringify(frozenSnapshot), ts);

      const l1Id = cryptoId();
      const l2Id = cryptoId();
      // 第一层创建即激活并起算独立限时，超时策略在激活瞬间冻结
      db.prepare(`
        INSERT INTO mediation_tiers
          (id, package_id, tier, status, escalate_rejected_count, invitation_count,
           duration_ms, timeout_policy, frozen_policy, created_at, started_at, deadline_at,
           completed_at, final_decision, timeout_fired_at, timeout_result)
        VALUES (?, ?, 1, 'active', ?, ?, ?, ?, ?, ?, ?, ?, NULL, '', NULL, '')
      `).run(l1Id, packageId, config.layer1.escalateRejectedCount,
        config.layer1.invitations.length, config.layer1.ttlMs,
        config.layer1.timeoutPolicy, config.layer1.timeoutPolicy,
        ts, ts, ts + config.layer1.ttlMs);
      // 第二层保持 pending：只有第一层达到升级条件后才按冻结快照激活
      db.prepare(`
        INSERT INTO mediation_tiers
          (id, package_id, tier, status, escalate_rejected_count, invitation_count,
           duration_ms, timeout_policy, frozen_policy, created_at, started_at, deadline_at,
           completed_at, final_decision, timeout_fired_at, timeout_result)
        VALUES (?, ?, 2, 'pending', 0, ?, ?, ?, '', ?, NULL, NULL, NULL, '', NULL, '')
      `).run(l2Id, packageId, config.layer2.invitations.length,
        config.layer2.ttlMs, config.layer2.timeoutPolicy, ts);

      const fieldIds = new Map();
      const insertField = db.prepare(`
        INSERT INTO mediation_fields
          (id, package_id, tier_id, round_id, appeal_field_id, source_field_id, tier, ordinal,
           step, field, field_label, l1_accept_threshold, l1_reject_threshold,
           l2_accept_threshold, l2_reject_threshold, status, decision, decided_at,
           decided_by_user_id, decision_reason, decided_by_policy, correction_workflow_id,
           correction_receipt_no, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, NULL, NULL, '', '', NULL, '', ?)
      `);
      const createTierFields = (layer, tier, tierId) => {
        layer.fields.forEach((field, ordinal) => {
          const prepared = preparedFields.find((item) => item.spec.key === field.key);
          const id = cryptoId();
          insertField.run(
            id, packageId, tierId, round.id, prepared.appealField.id, prepared.sourceField.id,
            tier, ordinal, field.step, field.field, mediationFieldLabel(field.step, field.field),
            tier === 1 ? field.acceptThreshold : 0,
            tier === 1 ? field.rejectThreshold : 0,
            tier === 2 ? field.acceptThreshold : 0,
            tier === 2 ? field.rejectThreshold : 0,
            ts,
          );
          fieldIds.set(`${tier}:${field.key}`, { id, prepared });
        });
      };
      createTierFields(config.layer1, 1, l1Id);
      createTierFields(config.layer2, 2, l2Id);

      // 冻结申诉意见与授权证据（仅第一层字段需要冻结展示；第二层结论摘要在升级时另生成）
      for (const [mapKey, { id: mediationFieldId, prepared }] of fieldIds) {
        const tier = Number(mapKey.split(':')[0]);
        if (tier !== 1) continue;
        const opinions = db.prepare(`
          SELECT * FROM review_appeal_opinions WHERE appeal_field_id = ? ORDER BY created_at ASC, rowid ASC
        `).all(prepared.appealField.id);
        opinions.forEach((opinion, index) => {
          db.prepare(`
            INSERT INTO mediation_frozen_opinions
              (id, package_id, mediation_field_id, tier, step, field, source_appeal_opinion_id,
               source_alias, source_value_snapshot, source_reason, source_created_at, created_at)
            VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(cryptoId(), packageId, mediationFieldId, opinion.step, opinion.field,
            opinion.id, `申诉复核人${index + 1}`, opinion.value_snapshot, opinion.reason,
            opinion.created_at, ts);
        });
        for (const evidence of prepared.evidenceRows) {
          db.prepare(`
            INSERT INTO mediation_frozen_evidence
              (id, package_id, mediation_field_id, tier, source_evidence_id, source_alias,
               source_value_snapshot, source_reason, source_created_at, created_at)
            VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?)
          `).run(cryptoId(), packageId, mediationFieldId, evidence.id, evidence.source_alias,
            evidence.source_value_snapshot, evidence.source_reason, evidence.source_created_at, ts);
        }
      }

      // 两层邀请（令牌只存哈希；第二层邀请先挂远期占位有效期）
      const invitations = [];
      const createInvitations = (layer, tier, tierId) => {
        layer.invitations.forEach((invite, ordinal) => {
          const raw = tokenUrlSafe();
          const inviteId = cryptoId();
          const expiresAt = tier === 1 ? ts + layer.ttlMs : ts + TIER_PENDING_EXPIRES_MS;
          db.prepare(`
            INSERT INTO mediation_invitations
              (id, package_id, tier_id, tier, ordinal, receipt_no, user_id, label, token_hash,
               status, created_at, expires_at, used_at, used_ip, revoked_at, revoke_reason)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, '', NULL, '')
          `).run(inviteId, packageId, tierId, tier, ordinal, receipt.receipt_no, userId,
            invite.label, sha256(raw), ts, expiresAt);
          for (const key of invite.scopeKeys) {
            const entry = fieldIds.get(`${tier}:${key}`);
            const [step, field] = key.split('.');
            db.prepare(`
              INSERT INTO mediation_invitation_fields (invitation_id, mediation_field_id, tier, step, field)
              VALUES (?, ?, ?, ?, ?)
            `).run(inviteId, entry.id, tier, Number(step), field);
          }
          invitations.push({ id: inviteId, tier, label: invite.label, token: raw });
        });
      };
      createInvitations(config.layer1, 1, l1Id);
      createInvitations(config.layer2, 2, l2Id);

      addMediationEvent(receipt.receipt_no, 'review.mediation.created', {
        packageId, roundId: round.id, batchId: round.batch_id,
        fields: config.fields.map((field) => ({ key: field.key, evidenceCount: field.evidenceOpinionIds.length })),
        layer1: {
          ttlMs: config.layer1.ttlMs, timeoutPolicy: config.layer1.timeoutPolicy,
          escalateRejectedCount: config.layer1.escalateRejectedCount,
          invitationCount: config.layer1.invitations.length,
        },
        layer2: {
          ttlMs: config.layer2.ttlMs, timeoutPolicy: config.layer2.timeoutPolicy,
          invitationCount: config.layer2.invitations.length,
          fieldKeys: config.layer2.fields.map((field) => field.key),
        },
      });
      return { ok: true, packageId, invitations };
    });
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) {
      return { ok: false, status: 409, code: 'MEDIATION_ALREADY_OPEN', message: MEDIATION_ERRORS.MEDIATION_ALREADY_OPEN };
    }
    throw error;
  }
}

// 调解包冻结快照：原批次决议、申诉意见与决议、授权证据、更正来源在生成瞬间固定
function buildFrozenSnapshot({ round, receipt, preparedFields, activeCorrection, config, frozenAt }) {
  return {
    frozenAt,
    round: {
      id: round.id,
      status: round.status,
      reasonSummary: round.reason_summary,
      note: round.note,
      createdAt: round.created_at,
      completedAt: round.completed_at,
    },
    batch: {
      id: round.batch_id,
      fields: preparedFields.map(({ sourceField }) => ({
        key: batchFieldKey(sourceField.step, sourceField.field),
        decision: sourceField.decision,
        decisionReason: sourceField.decision_reason || '',
        decidedAt: sourceField.decided_at || null,
        decidedByPolicy: sourceField.decided_by_policy || '',
      })),
    },
    receipt: {
      receiptNo: receipt.receipt_no,
      status: receipt.status,
      issuedAt: receipt.issued_at,
    },
    correctionSource: activeCorrection && activeCorrection.source_receipt_no === receipt.receipt_no ? {
      workflowId: activeCorrection.id,
      status: activeCorrection.status,
      progress: activeCorrection.progress,
      sourceReceiptNo: activeCorrection.source_receipt_no,
    } : null,
    fields: preparedFields.map(({ spec, appealField, sourceField, evidenceRows }) => ({
      key: spec.key,
      batchDecision: sourceField.decision,
      batchDecisionReason: sourceField.decision_reason || '',
      appealDecision: appealField.decision,
      appealDecisionReason: appealField.decision_reason || '',
      evidenceIds: evidenceRows.map((row) => row.id),
    })),
    config: {
      layer1EscalateRejectedCount: config.layer1.escalateRejectedCount,
      layer1TimeoutPolicy: config.layer1.timeoutPolicy,
      layer2TimeoutPolicy: config.layer2.timeoutPolicy,
    },
  };
}

// ---------------------------------------------------------------------------
// 视图辅助
// ---------------------------------------------------------------------------
function listFrozenOpinions(fieldId) {
  return db.prepare(`
    SELECT * FROM mediation_frozen_opinions WHERE mediation_field_id = ? ORDER BY created_at ASC, rowid ASC
  `).all(fieldId).map((row) => ({
    id: row.id,
    alias: row.source_alias,
    valueSnapshot: row.source_value_snapshot,
    reason: row.source_reason,
    originalSubmittedAt: row.source_created_at,
  }));
}

function listFrozenEvidence(fieldId) {
  return db.prepare(`
    SELECT * FROM mediation_frozen_evidence WHERE mediation_field_id = ? ORDER BY created_at ASC, rowid ASC
  `).all(fieldId).map((row) => ({
    id: row.id,
    alias: row.source_alias,
    valueSnapshot: row.source_value_snapshot,
    reason: row.source_reason,
    originalSubmittedAt: row.source_created_at,
  }));
}

function listLayerOpinions(fieldId) {
  return db.prepare(`
    SELECT * FROM mediation_opinions WHERE mediation_field_id = ? ORDER BY created_at ASC, rowid ASC
  `).all(fieldId).map(opinionView);
}

function opinionView(row) {
  return {
    id: row.id,
    packageId: row.package_id,
    mediationFieldId: row.mediation_field_id,
    invitationId: row.invitation_id,
    tier: row.tier,
    key: batchFieldKey(row.step, row.field),
    fieldLabel: row.field_label,
    reviewerLabel: row.reviewer_label,
    valueSnapshot: row.value_snapshot,
    reason: row.reason,
    submittedAt: row.created_at,
    correctionReceiptNo: row.correction_receipt_no || '',
  };
}

function fieldOwnerView(row) {
  const opinions = listLayerOpinions(row.id);
  const distinct = new Set(opinions.map((item) => item.invitationId));
  const acceptThreshold = row.tier === 1 ? row.l1_accept_threshold : row.l2_accept_threshold;
  const rejectThreshold = row.tier === 1 ? row.l1_reject_threshold : row.l2_reject_threshold;
  const out = {
    id: row.id,
    packageId: row.package_id,
    tier: row.tier,
    tierId: row.tier_id,
    appealFieldId: row.appeal_field_id,
    sourceFieldId: row.source_field_id,
    key: batchFieldKey(row.step, row.field),
    step: row.step,
    field: row.field,
    label: row.field_label,
    acceptThreshold,
    rejectThreshold,
    status: row.status,
    decision: row.decision || null,
    decidedAt: row.decided_at || null,
    decidedBy: row.decided_by_user_id ? (userQueries.findById(row.decided_by_user_id)?.display_name || '') : '',
    decisionReason: row.decision_reason || '',
    decidedByPolicy: row.decided_by_policy || '',
    correctionWorkflowId: row.correction_workflow_id || null,
    correctionReceiptNo: row.correction_receipt_no || '',
    opinionCount: opinions.length,
    distinctReviewerCount: distinct.size,
    opinions,
  };
  if (row.tier === 1) {
    out.frozenAppealOpinions = listFrozenOpinions(row.id);
    out.frozenEvidence = listFrozenEvidence(row.id);
    // 原批次/申诉驳回决议摘要（从冻结行读，保证不随后续变化改变）
    const snapshot = loadPackageSnapshot(row.package_id);
    const frozenField = snapshot?.fields?.find((item) => item.key === batchFieldKey(row.step, row.field));
    out.originalBatchDecision = frozenField ? {
      decision: frozenField.batchDecision,
      reason: frozenField.batchDecisionReason,
    } : null;
    out.appealDecision = frozenField ? {
      decision: frozenField.appealDecision,
      reason: frozenField.appealDecisionReason,
    } : null;
  } else {
    // 第二层只能看到第一层允许披露的结论摘要
    const disclosure = db.prepare('SELECT * FROM mediation_disclosures WHERE l2_mediation_field_id = ?').get(row.id);
    out.layer1Summary = disclosure ? JSON.parse(disclosure.summary_json) : null;
  }
  return out;
}

function loadPackageSnapshot(packageId) {
  const row = db.prepare('SELECT frozen_snapshot_json FROM mediation_packages WHERE id = ?').get(packageId);
  return row ? JSON.parse(row.frozen_snapshot_json) : null;
}

function listFieldsTx(packageId, tier) {
  return db.prepare(`
    SELECT * FROM mediation_fields WHERE package_id = ? AND tier = ? ORDER BY ordinal, step, field
  `).all(packageId, tier).map(fieldOwnerView);
}

function invitationOwnerView(row) {
  return {
    id: row.id,
    packageId: row.package_id,
    tier: row.tier,
    ordinal: row.ordinal,
    label: row.label,
    status: effectiveInviteStatus(row),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at || null,
    revokedAt: row.revoked_at || null,
    revokeReason: row.revoke_reason || '',
    fields: db.prepare(`
      SELECT mediation_field_id, tier, step, field FROM mediation_invitation_fields
      WHERE invitation_id = ? ORDER BY step, field
    `).all(row.id).map((item) => ({
      mediationFieldId: item.mediation_field_id,
      key: batchFieldKey(item.step, item.field),
      label: mediationFieldLabel(item.step, item.field),
    })),
  };
}

function tierOwnerView(row) {
  const invites = db.prepare(`
    SELECT * FROM mediation_invitations WHERE tier_id = ? ORDER BY ordinal, created_at
  `).all(row.id);
  const fields = db.prepare(`
    SELECT * FROM mediation_fields WHERE tier_id = ? ORDER BY ordinal, step, field
  `).all(row.id).map(fieldOwnerView);
  const ts = now();
  return {
    id: row.id,
    tier: row.tier,
    status: tierEffectiveStatus(row),
    escalateRejectedCount: row.escalate_rejected_count,
    invitationCount: row.invitation_count,
    validatedCount: invites.filter((item) => item.used_at).length,
    revokedCount: invites.filter((item) => item.status === 'revoked' || item.revoked_at).length,
    expiredCount: invites.filter((item) => effectiveInviteStatus(item) === 'expired').length,
    durationMs: row.duration_ms,
    timeoutPolicy: row.timeout_policy,
    frozenPolicy: row.frozen_policy || '',
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    deadlineAt: row.deadline_at || null,
    remainingMs: row.status === 'active' && row.deadline_at ? Math.max(0, row.deadline_at - ts) : 0,
    completedAt: row.completed_at || null,
    finalDecision: row.final_decision || '',
    timeoutFiredAt: row.timeout_fired_at || null,
    timeoutResult: row.timeout_result || '',
    fieldCount: fields.length,
    activeFieldCount: fields.filter((item) => item.status !== 'skipped').length,
    skippedCount: fields.filter((item) => item.status === 'skipped').length,
    decidedCount: fields.filter((item) => item.decision).length,
    acceptedCount: fields.filter((item) => item.decision === 'accepted').length,
    rejectedCount: fields.filter((item) => item.decision === 'rejected').length,
    invitations: invites.map(invitationOwnerView),
    fields,
  };
}

function tierEffectiveStatus(row) {
  if (row.status === 'active' && row.deadline_at && row.deadline_at <= now()) {
    return 'active_deadline_passed';
  }
  return row.status;
}

function packageOwnerView(row, { withDetails = true } = {}) {
  const tier1Row = loadTierTx(row.id, 1);
  const tier2Row = loadTierTx(row.id, 2);
  const tier1 = withDetails && tier1Row ? tierOwnerView(tier1Row) : null;
  const tier2 = withDetails && tier2Row ? tierOwnerView(tier2Row) : null;
  const correction = db.prepare(`
    SELECT * FROM mediation_corrections WHERE package_id = ? ORDER BY created_at DESC LIMIT 1
  `).get(row.id);
  return {
    id: row.id,
    roundId: row.round_id,
    batchId: row.batch_id,
    receiptNo: row.receipt_no,
    status: row.status,
    note: row.note || '',
    createdAt: row.created_at,
    cancelledAt: row.cancelled_at || null,
    cancelReason: row.cancel_reason || '',
    completedAt: row.completed_at || null,
    expiredAt: row.expired_at || null,
    escalatedAt: row.escalated_at || null,
    frozenSnapshot: withDetails ? loadPackageSnapshot(row.id) : null,
    tier1,
    tier2,
    correction: correction ? {
      workflowId: correction.workflow_id,
      sourceTier: correction.source_tier,
      createdAt: correction.created_at,
      completedAt: correction.completed_at || null,
      correctionReceiptNo: correction.correction_receipt_no || '',
      inProgress: !correction.completed_at,
    } : null,
  };
}

export function getMediationPackageForOwner({ userId, packageId }) {
  const row = db.prepare('SELECT * FROM mediation_packages WHERE id = ? AND user_id = ?').get(packageId, userId);
  return row ? packageOwnerView(row) : null;
}

export function listMediationPackagesForOwner(userId, { roundId = '', receiptNo = '' } = {}) {
  let rows = db.prepare('SELECT * FROM mediation_packages WHERE user_id = ? ORDER BY created_at ASC').all(userId);
  if (roundId) rows = rows.filter((row) => row.round_id === roundId);
  if (receiptNo) rows = rows.filter((row) => row.receipt_no === receiptNo);
  return rows.map((row) => packageOwnerView(row, { withDetails: false }));
}

// ---------------------------------------------------------------------------
// 取消调解包：任何一层尚无字段终局决议前允许；已有终局决议只能保留历史。
// ---------------------------------------------------------------------------
export function cancelMediationPackage({ userId, packageId, reason }) {
  const text = String(reason || '').trim().slice(0, 200);
  return immediateTransaction(() => {
    settleMediationTimeoutsTx(loadPackageTx(packageId));
    const row = loadPackageTx(packageId);
    if (!row || row.user_id !== userId) {
      return { ok: false, status: 404, code: 'MEDIATION_NOT_FOUND', message: '调解包不存在' };
    }
    if (row.status === 'cancelled') {
      return { ok: false, status: 409, code: 'MEDIATION_NOT_ACTIVE', message: '调解包已取消', pkg: packageOwnerView(row) };
    }
    if (['completed', 'expired', 'failed'].includes(row.status)) {
      return { ok: false, status: 409, code: 'MEDIATION_NOT_ACTIVE', message: `调解包已${row.status === 'completed' ? '完成' : '超时终结'}，不能取消`, pkg: packageOwnerView(row) };
    }
    const decided = db.prepare(`
      SELECT COUNT(*) AS n FROM mediation_fields WHERE package_id = ? AND decision IS NOT NULL
    `).get(packageId).n;
    if (decided > 0) {
      return { ok: false, status: 409, code: 'MEDIATION_HAS_DECISIONS', message: MEDIATION_ERRORS.MEDIATION_HAS_DECISIONS, pkg: packageOwnerView(row) };
    }
    const ts = now();
    // 未使用邀请立即失效；已校验会话保留只读（写接口按调解包状态显式拒绝 410）
    db.prepare(`
      UPDATE mediation_invitations
      SET status = 'revoked', revoked_at = ?, revoke_reason = '调解包取消'
      WHERE package_id = ? AND used_at IS NULL AND revoked_at IS NULL
    `).run(ts, packageId);
    db.prepare(`
      UPDATE mediation_fields SET status = 'cancelled' WHERE package_id = ? AND decision IS NULL
    `).run(packageId);
    db.prepare(`
      UPDATE mediation_tiers
      SET status = CASE WHEN status = 'pending' THEN 'skipped' ELSE 'cancelled' END,
          final_decision = CASE WHEN status = 'pending' THEN 'skipped_cancelled' ELSE final_decision END
      WHERE package_id = ?
    `).run(packageId);
    db.prepare(`
      UPDATE mediation_packages SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
      WHERE id = ?
    `).run(ts, text, packageId);
    addMediationEvent(row.receipt_no, 'review.mediation.cancelled', { packageId, reason: text });
    if (mediationGroupSync) mediationGroupSync(packageId, now());
    return { ok: true, pkg: packageOwnerView(loadPackageTx(packageId)) };
  });
}

// ---------------------------------------------------------------------------
// 超时落定：第一层（escalate/revoke_unused/fail）与第二层（complete/revoke_unused/fail）。
// 以 timeout_fired_at IS NULL 的条件更新为唯一判定；定时器/惰性检查/启动恢复
// 重复触发不产生第二次结果。
// ---------------------------------------------------------------------------
function settleMediationTimeoutsTx(pkg) {
  const fired = [];
  if (!pkg) return fired;
  if (['completed', 'cancelled', 'expired', 'failed'].includes(pkg.status)) return fired;
  for (;;) {
    const activeTier = db.prepare(`
      SELECT * FROM mediation_tiers
      WHERE package_id = ? AND status = 'active' AND deadline_at IS NOT NULL AND deadline_at <= ?
      ORDER BY tier ASC LIMIT 1
    `).get(pkg.id, now());
    if (!activeTier) break;
    if (activeTier.timeout_fired_at) break;
    const ts = now();
    const policy = activeTier.frozen_policy || activeTier.timeout_policy;
    if (activeTier.tier === 1) {
      if (policy === 'fail') {
        applyMediationFailTx(pkg, activeTier, ts, 'expired');
        fired.push({ tier: 1, result: 'failed' });
        break;
      }
      if (policy === 'revoke_unused') {
        applyTierRevokeUnusedTx(pkg, activeTier, ts);
        fired.push({ tier: 1, result: 'revoked_unused' });
        break;
      }
      // escalate：第一层未决字段系统自动驳回（留档），随后按冻结快照评估升级
      autoRejectPendingFieldsTx(pkg, activeTier, ts);
      applyLayer1TimeoutEscalateTx(pkg, activeTier, ts);
      fired.push({ tier: 1, result: 'escalated' });
      pkg = loadPackageTx(pkg.id);
      if (pkg.status !== 'arbitrating') break;
      continue; // 极端情况下第二层截止也已到（占位有效期不会，正常不会进入）
    }
    // 第二层
    if (policy === 'fail') {
      applyMediationFailTx(pkg, activeTier, ts, 'failed');
      fired.push({ tier: 2, result: 'failed' });
      break;
    }
    if (policy === 'revoke_unused') {
      applyTierRevokeUnusedTx(pkg, activeTier, ts);
      fired.push({ tier: 2, result: 'revoked_unused' });
      break;
    }
    // complete：第二层未决字段系统自动驳回，调解包完成
    autoRejectPendingFieldsTx(pkg, activeTier, ts);
    db.prepare(`
      UPDATE mediation_tiers
      SET status = 'completed', completed_at = ?, final_decision = 'timeout_completed',
          timeout_fired_at = ?, timeout_result = 'completed'
      WHERE id = ?
    `).run(ts, ts, activeTier.id);
    db.prepare(`
      UPDATE mediation_packages SET status = 'completed', completed_at = COALESCE(completed_at, ?) WHERE id = ?
    `).run(ts, pkg.id);
    addMediationEvent(pkg.receipt_no, 'review.mediation.tier.timeout', {
      packageId: pkg.id, tier: 2, policy: 'complete',
    });
    fired.push({ tier: 2, result: 'completed' });
    if (mediationGroupSync) mediationGroupSync(pkg.id, ts);
    break;
  }
  return fired;
}

function autoRejectPendingFieldsTx(pkg, tier, ts) {
  const pending = db.prepare(`
    SELECT * FROM mediation_fields
    WHERE tier_id = ? AND decision IS NULL AND status <> 'skipped' ORDER BY ordinal
  `).all(tier.id);
  for (const field of pending) {
    db.prepare(`
      UPDATE mediation_fields
      SET decision = 'rejected', status = 'rejected', decided_at = ?, decided_by_user_id = NULL,
          decision_reason = ?, decided_by_policy = 'timeout_mediation'
      WHERE id = ? AND decision IS NULL
    `).run(ts, MEDIATION_TIMEOUT_AUTO_REJECT_REASON, field.id);
  }
  return pending;
}

function applyMediationFailTx(pkg, tier, ts, packageStatus) {
  db.prepare(`
    UPDATE mediation_invitations
    SET status = 'revoked', revoked_at = ?, revoke_reason = '层级超时失败'
    WHERE package_id = ? AND used_at IS NULL AND revoked_at IS NULL
  `).run(ts, pkg.id);
  db.prepare('UPDATE mediation_sessions SET expires_at = 0 WHERE package_id = ?').run(pkg.id);
  db.prepare(`
    UPDATE mediation_fields SET status = 'timed_out' WHERE package_id = ? AND decision IS NULL
  `).run(pkg.id);
  db.prepare(`
    UPDATE mediation_tiers
    SET status = 'failed', completed_at = ?, final_decision = 'timeout_failed',
        timeout_fired_at = ?, timeout_result = 'failed'
    WHERE id = ?
  `).run(ts, ts, tier.id);
  db.prepare(`
    UPDATE mediation_tiers SET final_decision = 'skipped_timeout'
    WHERE package_id = ? AND tier > ? AND status = 'pending'
  `).run(pkg.id, tier.tier);
  db.prepare(`
    UPDATE mediation_packages SET status = ?, expired_at = ? WHERE id = ?
  `).run(packageStatus, ts, pkg.id);
  addMediationEvent(pkg.receipt_no, 'review.mediation.tier.timeout', {
    packageId: pkg.id, tier: tier.tier, policy: 'fail', packageStatus,
  });
  if (mediationGroupSync) mediationGroupSync(pkg.id, ts);
}

function applyTierRevokeUnusedTx(pkg, tier, ts) {
  const unused = db.prepare(`
    SELECT id FROM mediation_invitations
    WHERE tier_id = ? AND used_at IS NULL AND revoked_at IS NULL
  `).all(tier.id);
  for (const invite of unused) {
    db.prepare(`
      UPDATE mediation_invitations
      SET status = 'revoked', revoked_at = ?, revoke_reason = '层级限时到达：撤销未使用邀请'
      WHERE id = ?
    `).run(ts, invite.id);
  }
  db.prepare(`
    UPDATE mediation_tiers
    SET timeout_fired_at = ?, timeout_result = 'revoked_unused'
    WHERE id = ? AND timeout_fired_at IS NULL
  `).run(ts, tier.id);
  addMediationEvent(pkg.receipt_no, 'review.mediation.tier.timeout', {
    packageId: pkg.id, tier: tier.tier, policy: 'revoke_unused', revokedCount: unused.length,
  });
}

// 第一层超时升级：与正常终局相同的升级判定（按冻结快照，只产生一次结果）
function applyLayer1TimeoutEscalateTx(pkg, tier, ts) {
  // 案件组门控：超时自动驳回后同样要先判定组级开放条件
  let gate = null;
  if (mediationGroupGate) gate = mediationGroupGate(pkg.id, ts);
  if (gate && gate.mode === 'park') {
    finalizeLayer1WithoutArbitrationTx(pkg, tier, ts, { park: true, reason: gate.reason || '' });
    if (mediationGroupSync) mediationGroupSync(pkg.id, ts);
    return;
  }
  if (gate && gate.mode === 'block') {
    finalizeLayer1WithoutArbitrationTx(pkg, tier, ts, { park: false, reason: gate.reason || '' });
    if (mediationGroupSync) mediationGroupSync(pkg.id, ts);
    return;
  }
  db.prepare(`
    UPDATE mediation_tiers
    SET status = 'completed', completed_at = COALESCE(completed_at, ?),
        final_decision = 'timeout_escalated', timeout_fired_at = ?, timeout_result = 'escalated'
    WHERE id = ?
  `).run(ts, ts, tier.id);
  addMediationEvent(pkg.receipt_no, 'review.mediation.tier.timeout', {
    packageId: pkg.id, tier: 1, policy: 'escalate',
  });
  const escalated = maybeOpenLayer2Tx(pkg, ts);
  if (mediationGroupSync) mediationGroupSync(pkg.id, ts);
  if (!escalated) {
    // 自动驳回后仍未达到升级条件：第二层永不开放，调解包按第一层终局完成
    db.prepare(`
      UPDATE mediation_tiers SET status = 'skipped', final_decision = 'not_escalated'
      WHERE package_id = ? AND tier = 2 AND status = 'pending'
    `).run(pkg.id);
    db.prepare(`
      UPDATE mediation_packages SET status = 'completed', completed_at = COALESCE(completed_at, ?) WHERE id = ?
    `).run(ts, pkg.id);
    addMediationEvent(pkg.receipt_no, 'review.mediation.completed', {
      packageId: pkg.id, afterTier: 1, escalated: false, timedOut: true,
    });
  }
}

export function sweepMediationTimeouts() {
  const rows = db.prepare(`
    SELECT p.* FROM mediation_packages p
    JOIN mediation_tiers t ON t.package_id = p.id
    WHERE p.status IN ('mediating', 'arbitrating')
      AND t.status = 'active' AND t.deadline_at IS NOT NULL AND t.deadline_at <= ?
      AND t.timeout_fired_at IS NULL
  `).all(now());
  let changed = 0;
  for (const row of rows) {
    if (immediateTransaction(() => settleMediationTimeoutsTx(row)).length > 0) changed += 1;
  }
  return changed;
}

function settleMediationTimeoutsTopLevel(packageId) {
  const pkg = loadPackageTx(packageId);
  if (!pkg || ['completed', 'cancelled', 'expired', 'failed'].includes(pkg.status)) return [];
  const due = db.prepare(`
    SELECT COUNT(*) AS n FROM mediation_tiers
    WHERE package_id = ? AND status = 'active' AND deadline_at IS NOT NULL AND deadline_at <= ?
      AND timeout_fired_at IS NULL
  `).get(packageId, now()).n;
  if (due === 0) return [];
  return immediateTransaction(() => settleMediationTimeoutsTx(loadPackageTx(packageId)));
}

// ---------------------------------------------------------------------------
// 第一层/第二层邀请的一次性校验 → 免登录会话
//   - 第一层邀请：仅在第一层 active 且未到截止时可用；
//   - 第二层邀请：第一层未达到升级条件前明确拒绝（ARBITRATION_NOT_OPEN），
//     只有升级后按冻结快照激活时才能校验（一次性）。
// ---------------------------------------------------------------------------
export function consumeMediationInvitation({ rawToken, clientIp, expectedTier }) {
  return immediateTransaction(() => {
    const invite = db.prepare('SELECT * FROM mediation_invitations WHERE token_hash = ?').get(sha256(rawToken));
    if (!invite) {
      return {
        ok: false,
        status: 404,
        code: expectedTier === 2 ? 'ARBITRATION_NOT_FOUND' : 'MEDIATION_INVITATION_NOT_FOUND',
      };
    }
    if (expectedTier && invite.tier !== expectedTier) {
      // 调解链接不能用于仲裁入口，反之亦然
      return {
        ok: false,
        status: 404,
        code: expectedTier === 2 ? 'ARBITRATION_NOT_FOUND' : 'MEDIATION_INVITATION_NOT_FOUND',
      };
    }
    const pkg = loadPackageTx(invite.package_id);
    if (!pkg) {
      return { ok: false, status: 404, code: 'MEDIATION_NOT_FOUND' };
    }
    settleMediationTimeoutsTx(pkg);
    const pkgNow = loadPackageTx(invite.package_id);
    const tier = loadTierTx(invite.package_id, invite.tier);
    const revokedCodes = {
      1: ['MEDIATION_INVITATION_REVOKED'],
      2: ['ARBITRATION_INVITATION_REVOKED'],
    };
    const expiredCodes = {
      1: ['MEDIATION_INVITATION_EXPIRED'],
      2: ['ARBITRATION_INVITATION_EXPIRED'],
    };
    const usedCodes = {
      1: ['MEDIATION_INVITATION_ALREADY_USED'],
      2: ['ARBITRATION_INVITATION_ALREADY_USED'],
    };
    if (pkgNow.status === 'cancelled' || invite.status === 'revoked' || invite.revoked_at) {
      return { ok: false, status: 410, code: revokedCodes[invite.tier][0] };
    }
    if (['expired', 'failed'].includes(pkgNow.status)) {
      return { ok: false, status: 410, code: 'MEDIATION_DEADLINE_PASSED', message: '调解包已超时终结，链接失效' };
    }
    if (pkgNow.status === 'completed') {
      return { ok: false, status: 410, code: 'MEDIATION_NOT_ACTIVE', message: '调解包已完成' };
    }
    // 层级门控：只能校验当前进行中层级的邀请
    if (invite.tier === 1 && pkgNow.status !== 'mediating') {
      return { ok: false, status: 410, code: 'MEDIATION_NOT_ACTIVE', message: '第一层已结束，调解邀请链接不再可用' };
    }
    if (invite.tier === 2) {
      if (pkgNow.status !== 'arbitrating' || !tier || tier.status !== 'active') {
        // 案件组成员未达到组级开放条件时，仲裁邀请必须继续拒绝
        let gateReason = '';
        if (mediationGroupGate) {
          const gate = mediationGroupGate(invite.package_id, now());
          gateReason = gate ? gate.reason : '';
        }
        return {
          ok: false,
          status: 409,
          code: gateReason ? 'CASE_GROUP_ARBITRATION_NOT_OPEN' : 'ARBITRATION_NOT_OPEN',
          message: gateReason || MEDIATION_ERRORS.ARBITRATION_NOT_OPEN,
        };
      }
    }
    if (tier.status !== 'active') {
      return {
        ok: false,
        status: invite.tier === 2 ? 409 : 409,
        code: invite.tier === 2 ? 'ARBITRATION_NOT_OPEN' : 'MEDIATION_NOT_ACTIVE',
        message: invite.tier === 2 ? MEDIATION_ERRORS.ARBITRATION_NOT_OPEN : '第一层尚未开始或已结束',
      };
    }
    if (invite.used_at || invite.status === 'used') {
      return { ok: false, status: 410, code: usedCodes[invite.tier][0] };
    }
    if (invite.expires_at <= now() || (tier.deadline_at && tier.deadline_at <= now())) {
      if (invite.status === 'active') {
        db.prepare("UPDATE mediation_invitations SET status = 'expired' WHERE id = ?").run(invite.id);
      }
      return { ok: false, status: 410, code: expiredCodes[invite.tier][0] };
    }
    const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(invite.receipt_no);
    if (!receipt) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND' };
    if (receipt.status === 'revoked') return { ok: false, status: 410, code: 'RECEIPT_REVOKED' };

    const ts = now();
    db.prepare(`
      UPDATE mediation_invitations
      SET status = 'used', used_at = ?, used_ip = ?
      WHERE id = ? AND used_at IS NULL
    `).run(ts, String(clientIp || '').slice(0, 64), invite.id);

    const sessionRaw = tokenUrlSafe();
    const sessionId = cryptoId();
    const csrf = tokenUrlSafe();
    const expiry = Math.min(invite.expires_at, tier.deadline_at || invite.expires_at);
    db.prepare(`
      INSERT INTO mediation_sessions
        (id, package_id, tier_id, invitation_id, tier, receipt_no, label, token_hash,
         csrf_secret, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, pkgNow.id, tier.id, invite.id, invite.tier, receipt.receipt_no,
      invite.label, sha256(sessionRaw), csrf, ts, expiry, ts);

    addMediationEvent(receipt.receipt_no, invite.tier === 1 ? 'review.mediation.invitation.consumed' : 'review.mediation.arbitration.invitation.consumed', {
      packageId: pkgNow.id, tier: invite.tier, invitationId: invite.id, label: invite.label,
    });

    return {
      ok: true,
      sessionToken: sessionRaw,
      sessionId,
      csrf,
      packageId: pkgNow.id,
      tier: invite.tier,
      receiptNo: receipt.receipt_no,
      label: invite.label,
      expiresAt: expiry,
    };
  });
}

export function getValidMediationSession(rawToken) {
  if (!rawToken) return null;
  const session = db.prepare('SELECT * FROM mediation_sessions WHERE token_hash = ?').get(sha256(rawToken));
  if (!session || session.expires_at <= now()) return null;
  const invite = db.prepare('SELECT * FROM mediation_invitations WHERE id = ?').get(session.invitation_id);
  if (!invite) return null;
  // 办理人撤销未使用邀请时会话失效；包取消/超时后已校验会话保留只读（写接口显式拒绝 410）
  if ((invite.status === 'revoked' || invite.revoked_at) && !invite.used_at) return null;
  if (invite.used_at === null) return null;
  if (invite.expires_at <= now()) return null;
  const pkg = loadPackageTx(session.package_id);
  if (!pkg) return null;
  const tier = loadTierTx(session.package_id, session.tier);
  if (!tier) return null;
  db.prepare('UPDATE mediation_sessions SET last_seen_at = ? WHERE id = ?').run(now(), session.id);
  return { session, invite, pkg, tier };
}

export function deleteMediationSession(rawToken) {
  if (!rawToken) return;
  const session = db.prepare('SELECT * FROM mediation_sessions WHERE token_hash = ?').get(sha256(rawToken));
  if (session) db.prepare('DELETE FROM mediation_sessions WHERE id = ?').run(session.id);
}

function sessionAuthorizedFieldRows(sessionId) {
  return db.prepare(`
    SELECT s.* FROM mediation_invitation_fields s
    JOIN mediation_sessions ms ON ms.invitation_id = s.invitation_id
    WHERE ms.id = ?
  `).all(sessionId);
}

// ---------------------------------------------------------------------------
// 调解人/仲裁人上下文：只返回本层授权的脱敏字段、上一层允许披露的结论摘要
// 与被选中的冻结证据；其他字段、其他层处理人身份、未授权原文一律不下发。
// ---------------------------------------------------------------------------
export function getMediationReviewerContext(review) {
  const { session, invite } = review;
  settleMediationTimeoutsTopLevel(session.package_id);
  const pkg = loadPackageTx(session.package_id);
  if (!pkg) return null;
  const tier = loadTierTx(pkg.id, session.tier);
  const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(session.receipt_no);
  if (!receipt) return null;

  const locked = ['cancelled', 'expired', 'failed'].includes(pkg.status);
  const tierClosed = locked || tier.status !== 'active'
    || (tier.deadline_at && tier.deadline_at <= now() && tier.timeout_fired_at !== null);
  const scope = (tier.status === 'active' && !locked) ? sessionAuthorizedFieldRows(session.id) : [];
  const authorizedKeys = scope.map((item) => batchFieldKey(item.step, item.field));
  const snapshot = JSON.parse(receipt.snapshot_json);
  const myOpinions = db.prepare(`
    SELECT * FROM mediation_opinions WHERE session_id = ? ORDER BY created_at ASC
  `).all(session.id).map(opinionView);

  const fieldRows = db.prepare(`
    SELECT * FROM mediation_fields WHERE tier_id = ? ORDER BY ordinal, step, field
  `).all(tier.id).filter((row) => row.status !== 'skipped');
  const byFieldId = new Map(scope.map((item) => [item.mediation_field_id, item]));
  const merged = fieldRows
    .filter((row) => byFieldId.has(row.id))
    .map((row) => buildReviewerMergedField(row, invite, session.tier));

  const canSubmit = !locked && tier.status === 'active'
    && (!tier.deadline_at || tier.deadline_at > now())
    && !tier.timeout_fired_at
    && (session.tier === 1 ? pkg.status === 'mediating' : pkg.status === 'arbitrating');

  if (receipt.status === 'revoked' || locked) {
    return {
      packageId: pkg.id,
      receiptNo: receipt.receipt_no,
      label: session.label,
      tier: session.tier,
      status: receipt.status === 'revoked' ? 'revoked' : pkg.status,
      packageStatus: pkg.status,
      expiresAt: session.expires_at,
      deadlineAt: tier.deadline_at,
      view: null,
      opinions: myOpinions,
      merged,
      canSubmit: false,
    };
  }

  return {
    packageId: pkg.id,
    roundId: pkg.round_id,
    batchId: pkg.batch_id,
    receiptNo: receipt.receipt_no,
    label: session.label,
    tier: session.tier,
    status: receipt.status,
    packageStatus: pkg.status,
    canSubmit,
    tierStatus: tier.status,
    issuedAt: receipt.issued_at,
    completedAt: snapshot.completedAt,
    expiresAt: session.expires_at,
    deadlineAt: tier.deadline_at,
    remainingMs: tier.deadline_at ? Math.max(0, tier.deadline_at - now()) : 0,
    timeoutPolicy: tier.frozen_policy || tier.timeout_policy,
    escalateRejectedCount: session.tier === 1 ? tier.escalate_rejected_count : 0,
    view: buildMediationReviewView(snapshot, authorizedKeys),
    opinions: myOpinions,
    merged,
    // 第二层仲裁人：案件组允许披露的跨包摘要（脱敏聚合，不含其他包字段原文）
    ...(session.tier === 2 ? {
      group: mediationCrossPackageDisclosure
        ? {
            member: getCaseGroupMemberInfoSafe(pkg.id),
            crossPackageSummary: mediationCrossPackageDisclosure(pkg.id),
          }
        : null,
    } : {}),
  };
}

function getCaseGroupMemberInfoSafe(packageId) {
  try {
    return caseGroupMemberInfoHook ? caseGroupMemberInfoHook(packageId) : null;
  } catch {
    return null;
  }
}

let caseGroupMemberInfoHook = null;
export function bindCaseGroupMemberInfoHook(fn) {
  caseGroupMemberInfoHook = fn;
}

// 组装复核人侧单个字段的合并视图（本层意见 + 允许披露的上一层摘要/冻结证据）
function buildReviewerMergedField(row, invite, tier) {
  const opinions = listLayerOpinions(row.id);
  const base = {
    key: batchFieldKey(row.step, row.field),
    label: row.field_label,
    tier: row.tier,
    acceptThreshold: row.tier === 1 ? row.l1_accept_threshold : row.l2_accept_threshold,
    rejectThreshold: row.tier === 1 ? row.l1_reject_threshold : row.l2_reject_threshold,
    decision: row.decision || null,
    decidedAt: row.decided_at || null,
    decidedByPolicy: row.decided_by_policy || '',
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
  };
  if (tier === 1) {
    // 第一层调解人：被选中的冻结申诉证据（原复核人匿名化）与原驳回结论
    const pkgSnapshot = loadPackageSnapshot(row.package_id);
    const frozenField = pkgSnapshot?.fields?.find((item) => item.key === base.key);
    base.originalBatchDecision = frozenField ? {
      decision: frozenField.batchDecision,
      reason: frozenField.batchDecisionReason,
    } : null;
    base.appealDecision = frozenField ? {
      decision: frozenField.appealDecision,
      reason: frozenField.appealDecisionReason,
    } : null;
    base.frozenAppealOpinions = listFrozenOpinions(row.id);
    base.evidence = listFrozenEvidence(row.id);
  } else {
    // 第二层仲裁人：只能看到第一层允许披露的结论摘要 + 第一层授权透传的冻结证据
    const disclosure = db.prepare('SELECT * FROM mediation_disclosures WHERE l2_mediation_field_id = ?').get(row.id);
    base.layer1Summary = disclosure ? JSON.parse(disclosure.summary_json) : null;
    base.frozenAppealOpinions = [];
    base.evidence = disclosure ? JSON.parse(disclosure.summary_json).evidence || [] : [];
  }
  return base;
}

// ---------------------------------------------------------------------------
// 调解人/仲裁人提交意见：只能针对本层本邀请授权字段；每邀请每字段至多一条；幂等重试
// ---------------------------------------------------------------------------
export function submitMediationOpinion({ review, key, reason, idempotencyKey, requestHash }) {
  return immediateTransaction(() => {
    const { session, invite } = review;
    settleMediationTimeoutsTx(loadPackageTx(session.package_id));
    const pkg = loadPackageTx(session.package_id);
    const tier = loadTierTx(pkg.id, session.tier);
    if (pkg.status === 'cancelled') {
      return { ok: false, status: 410, code: 'MEDIATION_PACKAGE_CANCELLED', message: '调解包已取消，写操作已关闭' };
    }
    if (pkg.status === 'expired' || pkg.status === 'failed') {
      return { ok: false, status: 410, code: 'MEDIATION_PACKAGE_TIMED_OUT', message: '调解包已超时终结，写操作已关闭' };
    }
    if (invite.status === 'revoked' || invite.revoked_at) {
      return {
        ok: false, status: 410,
        code: session.tier === 2 ? 'ARBITRATION_INVITATION_REVOKED' : 'MEDIATION_INVITATION_REVOKED',
      };
    }
    if (invite.expires_at <= now() || session.expires_at <= now()) {
      return {
        ok: false, status: 410,
        code: session.tier === 2 ? 'ARBITRATION_INVITATION_EXPIRED' : 'MEDIATION_INVITATION_EXPIRED',
      };
    }
    const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(session.receipt_no);
    if (!receipt) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND' };
    if (receipt.status === 'revoked') return { ok: false, status: 410, code: 'RECEIPT_REVOKED' };
    if (tier.status !== 'active') {
      return session.tier === 2
        ? { ok: false, status: 409, code: 'ARBITRATION_NOT_OPEN', message: MEDIATION_ERRORS.ARBITRATION_NOT_OPEN }
        : { ok: false, status: 409, code: 'MEDIATION_NOT_ACTIVE', message: '第一层当前不能提交意见' };
    }
    if (tier.deadline_at && tier.deadline_at <= now()) {
      settleMediationTimeoutsTx(pkg);
      return { ok: false, status: 410, code: 'MEDIATION_DEADLINE_PASSED', message: '本层限时已过，写操作已关闭' };
    }
    if (tier.timeout_fired_at) {
      return { ok: false, status: 409, code: 'MEDIATION_NOT_ACTIVE', message: '本层限时已过，未使用邀请已撤销，不能再提交意见' };
    }
    if (session.tier === 1 && pkg.status !== 'mediating') {
      return { ok: false, status: 410, code: 'MEDIATION_NOT_ACTIVE', message: '第一层已结束' };
    }
    if (session.tier === 2 && pkg.status !== 'arbitrating') {
      return { ok: false, status: 409, code: 'ARBITRATION_NOT_OPEN', message: MEDIATION_ERRORS.ARBITRATION_NOT_OPEN };
    }

    const parsed = typeof key === 'string'
      ? { step: Number(key.split('.')[0]), field: key.split('.')[1] }
      : null;
    if (!parsed || Number.isNaN(parsed.step) || !parsed.field) {
      return { ok: false, status: 400, code: 'MEDIATION_FIELD_NOT_FOUND', message: '字段不存在' };
    }
    const mediationField = db.prepare(`
      SELECT mf.* FROM mediation_fields mf
      JOIN mediation_invitation_fields mif
        ON mif.mediation_field_id = mf.id AND mif.invitation_id = ?
      WHERE mf.package_id = ? AND mf.tier = ? AND mf.step = ? AND mf.field = ?
    `).get(invite.id, pkg.id, session.tier, parsed.step, parsed.field);
    if (!mediationField) {
      return {
        ok: false, status: 403,
        code: session.tier === 2 ? 'ARBITRATION_FIELD_NOT_AUTHORIZED' : 'MEDIATION_FIELD_NOT_AUTHORIZED',
        message: session.tier === 2
          ? MEDIATION_ERRORS.ARBITRATION_FIELD_NOT_AUTHORIZED
          : MEDIATION_ERRORS.MEDIATION_FIELD_NOT_AUTHORIZED,
      };
    }
    if (mediationField.status === 'skipped') {
      return {
        ok: false, status: 403,
        code: session.tier === 2 ? 'ARBITRATION_FIELD_NOT_AUTHORIZED' : 'MEDIATION_FIELD_NOT_AUTHORIZED',
        message: '该字段不属于本层开放范围',
      };
    }
    if (mediationField.decision) {
      return {
        ok: false, status: 409,
        code: session.tier === 2 ? 'ARBITRATION_FIELD_ALREADY_DECIDED' : 'MEDIATION_FIELD_ALREADY_DECIDED',
        message: '该字段已有最终决议，不能再提交意见',
      };
    }
    const text = String(reason || '').trim();
    if (text.length < MEDIATION_OPINION_MIN || text.length > MEDIATION_OPINION_MAX) {
      return { ok: false, status: 400, code: 'INVALID_REASON', message: `意见说明需为 ${MEDIATION_OPINION_MIN}-${MEDIATION_OPINION_MAX} 个字符` };
    }

    const prior = db.prepare(`
      SELECT * FROM mediation_opinions WHERE session_id = ? AND idempotency_key = ?
    `).get(session.id, idempotencyKey);
    if (prior) {
      if (prior.request_hash !== requestHash) {
        return { ok: false, status: 409, code: 'OBJECTION_DUPLICATE_KEY', message: '该提交编号已用于其他内容' };
      }
      return { ok: true, replay: true, opinion: opinionView(prior) };
    }
    const dup = db.prepare(`
      SELECT id FROM mediation_opinions WHERE invitation_id = ? AND mediation_field_id = ?
    `).get(invite.id, mediationField.id);
    if (dup) {
      return {
        ok: false, status: 409,
        code: session.tier === 2 ? 'ARBITRATION_FIELD_DUPLICATE_OPINION' : 'MEDIATION_FIELD_DUPLICATE_OPINION',
        message: session.tier === 2
          ? MEDIATION_ERRORS.ARBITRATION_FIELD_DUPLICATE_OPINION
          : MEDIATION_ERRORS.MEDIATION_FIELD_DUPLICATE_OPINION,
      };
    }

    const valueSnapshot = batchFieldTextValue(JSON.parse(receipt.snapshot_json), parsed.step, parsed.field);
    const ts = now();
    const id = cryptoId();
    try {
      db.prepare(`
        INSERT INTO mediation_opinions
          (id, package_id, mediation_field_id, invitation_id, session_id, tier, receipt_no, user_id,
           step, field, reviewer_label, field_label, value_snapshot, reason,
           correction_receipt_no, idempotency_key, request_hash, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?, ?)
      `).run(
        id, pkg.id, mediationField.id, invite.id, session.id, session.tier, receipt.receipt_no,
        pkg.user_id, parsed.step, parsed.field, invite.label, mediationField.field_label,
        valueSnapshot, text, idempotencyKey, requestHash, ts,
      );
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE')) {
        return {
          ok: false, status: 409,
          code: session.tier === 2 ? 'ARBITRATION_FIELD_DUPLICATE_OPINION' : 'MEDIATION_FIELD_DUPLICATE_OPINION',
          message: '你已就该字段提交过意见，不能重复提交',
        };
      }
      throw error;
    }
    addMediationEvent(receipt.receipt_no, session.tier === 1 ? 'review.mediation.opinion.submitted' : 'review.mediation.arbitration.opinion.submitted', {
      packageId: pkg.id, tier: session.tier, invitationId: invite.id,
      mediationFieldId: mediationField.id, opinionId: id, label: invite.label,
      step: parsed.step, field: parsed.field,
    });
    return { ok: true, opinion: opinionView(db.prepare('SELECT * FROM mediation_opinions WHERE id = ?').get(id)) };
  });
}

let mediationCorrectionFactory = null;
export function bindMediationCorrectionFactory(fn) {
  mediationCorrectionFactory = fn;
}

// 案件组门控钩子：由 caseGroupStore 注入，避免 ESM 循环依赖。
// 契约见 caseGroupStore.bindMediationGroupGate。返回：
//   null            非案件组成员：按原调解包逻辑处理
//   { mode:'open' }        达到组级开放条件：正常开放第二层
//   { mode:'park' }        未轮到/前置成员未完成：第一层终局挂起，第二层继续拒绝
//   { mode:'block' }       明确不开放（组超时策略/收集组取消）：第一层终局完成
let mediationGroupGate = null;
export function bindMediationGroupGate(fn) {
  mediationGroupGate = fn;
}

// 案件组状态同步钩子：包取消/超时等任何终局变化后，按冻结规则原子更新组状态
let mediationGroupSync = null;
export function bindMediationGroupSync(fn) {
  mediationGroupSync = fn;
}

// 案件组跨包摘要查询钩子：仲裁人上下文只取组级允许披露的脱敏摘要
let mediationCrossPackageDisclosure = null;
export function bindMediationCrossPackageDisclosure(fn) {
  mediationCrossPackageDisclosure = fn;
}

export function loadMediationPackageTx(packageId) {
  return loadPackageTx(packageId);
}

// 事务内：对已达到第一层升级条件的调解包执行【原生第二层开放】（不含是否开放的判定）。
// 从 maybeOpenLayer2Tx 抽出，供案件组门控在 mode='open' 时复用。
export function openLayer2NativeTx(pkg, ts) {
  return maybeOpenLayer2Tx(pkg, ts);
}

// 事务内：第一层终局但第二层不开放（组门控 park/block 之外的原生“不升级”路径之外，
// 由案件组门控显式调用）：标记第二层 skipped、调解包按第一层终局完成。
// park=true 时仅冻结第一层并挂起（包保持 mediating，等待前置成员完成）。
export function finalizeLayer1WithoutArbitrationTx(pkg, tier, ts, { park = false, reason = '' } = {}) {
  const autoRejected = autoRejectPendingFieldsTx(pkg, tier, ts);
  db.prepare(`
    UPDATE mediation_tiers SET status = 'completed', completed_at = COALESCE(completed_at, ?),
      final_decision = CASE WHEN final_decision = '' THEN 'escalated_pending_group' ELSE final_decision END
    WHERE id = ? AND status = 'active'
  `).run(ts, tier.id);
  addMediationEvent(pkg.receipt_no, 'review.mediation.tier.completed', {
    packageId: pkg.id, tier: 1, escalated: false, parked: park,
    autoRejectedFields: autoRejected.map((f) => batchFieldKey(f.step, f.field)),
  });
  if (park) {
    addMediationEvent(pkg.receipt_no, 'review.mediation.group.parked', { packageId: pkg.id, reason });
    return { parked: true };
  }
  db.prepare(`
    UPDATE mediation_tiers SET status = 'skipped', final_decision = 'group_gate_blocked'
    WHERE package_id = ? AND tier = 2 AND status = 'pending'
  `).run(pkg.id);
  db.prepare(`
    UPDATE mediation_packages SET status = 'completed', completed_at = COALESCE(completed_at, ?) WHERE id = ?
  `).run(ts, pkg.id);
  addMediationEvent(pkg.receipt_no, 'review.mediation.completed', {
    packageId: pkg.id, afterTier: 1, escalated: false, groupGateBlocked: true, reason,
  });
  return { parked: false, completed: true };
}

// 事务内：组级 fail 策略强制终结一个成员包（未使用邀请失效、未决字段超时留档）。
export function forceFinishPackageByGroupTx(pkg, ts, { packageStatus = 'failed', reason = '' } = {}) {
  db.prepare(`
    UPDATE mediation_invitations
    SET status = 'revoked', revoked_at = ?, revoke_reason = '案件组超时失败'
    WHERE package_id = ? AND used_at IS NULL AND revoked_at IS NULL
  `).run(ts, pkg.id);
  db.prepare('UPDATE mediation_sessions SET expires_at = 0 WHERE package_id = ?').run(pkg.id);
  db.prepare(`
    UPDATE mediation_fields SET status = 'timed_out' WHERE package_id = ? AND decision IS NULL
  `).run(pkg.id);
  for (const tierId of db.prepare('SELECT id FROM mediation_tiers WHERE package_id = ?').all(pkg.id).map((r) => r.id)) {
    db.prepare(`
      UPDATE mediation_tiers
      SET status = CASE WHEN status = 'active' THEN 'failed' WHEN status = 'pending' THEN 'skipped' ELSE status END,
          completed_at = COALESCE(completed_at, ?),
          final_decision = CASE WHEN status = 'active' THEN 'group_timeout_failed' ELSE final_decision END,
          timeout_fired_at = COALESCE(timeout_fired_at, ?),
          timeout_result = CASE WHEN status = 'active' THEN 'group_fail' ELSE timeout_result END
      WHERE id = ?
    `).run(ts, ts, tierId);
  }
  db.prepare('UPDATE mediation_packages SET status = ?, expired_at = COALESCE(expired_at, ?) WHERE id = ?')
    .run(packageStatus, ts, pkg.id);
  addMediationEvent(pkg.receipt_no, 'review.mediation.group.forced', { packageId: pkg.id, packageStatus, reason });
}

// 供案件组在事务内查询第二层门控所需的包/层状态
export function mediationLayer1StateTx(packageId) {
  const pkg = loadPackageTx(packageId);
  if (!pkg) return null;
  const tier1 = loadTierTx(packageId, 1);
  const tier2 = loadTierTx(packageId, 2);
  const rejectedCount = db.prepare(`
    SELECT COUNT(*) AS n FROM mediation_fields WHERE tier_id = ? AND decision = 'rejected'
  `).get(tier1.id).n;
  const pendingCount = db.prepare(`
    SELECT COUNT(*) AS n FROM mediation_fields
    WHERE tier_id = ? AND decision IS NULL AND status <> 'skipped'
  `).get(tier1.id).n;
  return {
    packageId: pkg.id,
    batchId: pkg.batch_id,
    roundId: pkg.round_id,
    receiptNo: pkg.receipt_no,
    status: pkg.status,
    tier1Status: tier1.status,
    tier2Status: tier2.status,
    rejectedCount,
    pendingCount,
  };
}

// ---------------------------------------------------------------------------
// 办理人逐字段决议（第一层调解 / 第二层仲裁）：
//   - 接受：本层提出意见的不同处理人数达到该层冻结的接受阈值；
//     仲裁接受必须在新的更正办理中同时关联调解包、上一层结论与原批次来源；
//     同一调解包至多一份进行中的更正（部分唯一索引 + 事务双保险）。
//   - 驳回：已校验且未提意见人数达到驳回阈值，理由持久化；第一层全部终局后评估升级。
// ---------------------------------------------------------------------------
export function decideMediationField({ userId, packageId, mediationFieldId, action, reason }) {
  const reasonText = String(reason || '').trim();
  try {
    return immediateTransaction(() => {
      settleMediationTimeoutsTx(loadPackageTx(packageId));
      const pkg = loadPackageTx(packageId);
      if (!pkg || pkg.user_id !== userId) {
        return { ok: false, status: 404, code: 'MEDIATION_NOT_FOUND', message: '调解包不存在' };
      }
      if (pkg.status === 'cancelled') {
        return { ok: false, status: 410, code: 'MEDIATION_PACKAGE_CANCELLED', message: '调解包已取消，不能决议' };
      }
      if (pkg.status === 'expired' || pkg.status === 'failed') {
        return { ok: false, status: 410, code: 'MEDIATION_PACKAGE_TIMED_OUT', message: '调解包已超时终结，不能决议', pkg: packageOwnerView(pkg) };
      }
      const fieldRow = db.prepare('SELECT * FROM mediation_fields WHERE id = ? AND package_id = ?')
        .get(mediationFieldId, packageId);
      if (!fieldRow) {
        return { ok: false, status: 404, code: 'MEDIATION_FIELD_NOT_FOUND', message: '调解字段不存在或不属于本调解包' };
      }
      const tier = loadTierTx(packageId, fieldRow.tier);
      if (!tier || tier.status !== 'active') {
        return {
          ok: false, status: 409,
          code: fieldRow.tier === 2 ? 'ARBITRATION_NOT_OPEN' : 'MEDIATION_NOT_ACTIVE',
          message: fieldRow.tier === 2 ? MEDIATION_ERRORS.ARBITRATION_NOT_OPEN : '该层当前不能作出决议',
          pkg: packageOwnerView(pkg),
        };
      }
      if (tier.deadline_at && tier.deadline_at <= now() && !tier.timeout_fired_at) {
        settleMediationTimeoutsTx(pkg);
        return { ok: false, status: 410, code: 'MEDIATION_DEADLINE_PASSED', message: '该层限时已过，正在按冻结策略处理', pkg: packageOwnerView(loadPackageTx(packageId)) };
      }
      if (fieldRow.status === 'skipped') {
        return {
          ok: false, status: 409, code: 'MEDIATION_FIELD_NOT_FOUND',
          message: '该字段在本层已跳过，不能作出决议', pkg: packageOwnerView(pkg),
        };
      }
      if (fieldRow.decision) {
        return {
          ok: false, status: 409,
          code: fieldRow.tier === 2 ? 'ARBITRATION_FIELD_ALREADY_DECIDED' : 'MEDIATION_FIELD_ALREADY_DECIDED',
          message: `该字段已决议为「${fieldRow.decision === 'accepted' ? '接受' : '驳回'}」，重复决议返回同一结果`,
          field: fieldOwnerView(fieldRow),
        };
      }

      const opinions = db.prepare('SELECT * FROM mediation_opinions WHERE mediation_field_id = ?').all(mediationFieldId);
      const supportCount = new Set(opinions.map((item) => item.invitation_id)).size;
      const validatedInviteCount = db.prepare(`
        SELECT COUNT(DISTINCT id) AS n FROM mediation_invitations
        WHERE tier_id = ? AND used_at IS NOT NULL AND revoked_at IS NULL
      `).get(tier.id).n;
      const acceptThreshold = fieldRow.tier === 1 ? fieldRow.l1_accept_threshold : fieldRow.l2_accept_threshold;
      const rejectThreshold = fieldRow.tier === 1 ? fieldRow.l1_reject_threshold : fieldRow.l2_reject_threshold;

      if (action === 'accept') {
        if (supportCount < acceptThreshold) {
          return {
            ok: false, status: 409, code: 'ACCEPT_THRESHOLD_NOT_MET',
            message: `该字段只有 ${supportCount} 位${fieldRow.tier === 2 ? '仲裁人' : '调解人'}提出意见，未达到接受阈值 ${acceptThreshold}，不能接受`,
            field: fieldOwnerView(fieldRow),
          };
        }
        const source = db.prepare('SELECT * FROM receipts WHERE receipt_no = ? AND user_id = ?').get(pkg.receipt_no, userId);
        if (!source) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND', message: '原回执不存在' };
        let workflow = getActiveWorkflow(userId);
        if (workflow && workflow.source_receipt_no !== source.receipt_no) {
          return {
            ok: false, status: 409, code: 'OPEN_WORKFLOW_EXISTS',
            message: MEDIATION_ERRORS.OPEN_WORKFLOW_EXISTS,
            workflow: publicWorkflow(workflow, getSteps(workflow.id)),
            field: fieldOwnerView(fieldRow),
          };
        }
        // 同一调解包只能产生一份进行中的更正
        const openLink = db.prepare(`
          SELECT * FROM mediation_corrections WHERE package_id = ? AND completed_at IS NULL
        `).get(packageId);
        if (openLink && (!workflow || workflow.id !== openLink.workflow_id)) {
          return {
            ok: false, status: 409, code: 'MEDIATION_CORRECTION_IN_PROGRESS',
            message: MEDIATION_ERRORS.MEDIATION_CORRECTION_IN_PROGRESS,
            field: fieldOwnerView(fieldRow),
          };
        }
        let created = false;
        if (!workflow) {
          if (!mediationCorrectionFactory) throw new Error('mediation correction factory not bound');
          workflow = mediationCorrectionFactory(source);
          created = true;
        }
        const ts = now();
        const updated = db.prepare(`
          UPDATE mediation_fields
          SET decision = 'accepted', status = 'accepted', decided_at = ?, decided_by_user_id = ?,
              decision_reason = '', correction_workflow_id = ?, correction_receipt_no = '',
              decided_by_policy = ''
          WHERE id = ? AND decision IS NULL
        `).run(ts, userId, workflow.id, mediationFieldId);
        if (updated.changes === 0) {
          return {
            ok: false, status: 409,
            code: fieldRow.tier === 2 ? 'ARBITRATION_FIELD_ALREADY_DECIDED' : 'MEDIATION_FIELD_ALREADY_DECIDED',
            message: '该字段刚被另一个页面决议，重复决议返回同一结果',
            field: fieldOwnerView(db.prepare('SELECT * FROM mediation_fields WHERE id = ?').get(mediationFieldId)),
          };
        }
        // 本层全部意见进入同一份更正；第二层接受还要带上第一层结论摘要与原批次/申诉回合来源
        let disclosureId = '';
        let sourceTier = fieldRow.tier;
        if (fieldRow.tier === 2) {
          const disclosure = db.prepare('SELECT * FROM mediation_disclosures WHERE l2_mediation_field_id = ?').get(mediationFieldId);
          disclosureId = disclosure?.id || '';
        }
        // 同一调解包至多一份进行中的更正：已有开放关系则复用（同一 workflow），绝不新建第二份
        let link = openLink || null;
        if (!link) {
          try {
            const linkId = cryptoId();
            db.prepare(`
              INSERT INTO mediation_corrections
                (id, package_id, workflow_id, source_batch_id, source_round_id, source_tier,
                 disclosure_id, created_at, completed_at, correction_receipt_no)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, '')
            `).run(linkId, packageId, workflow.id, pkg.batch_id, pkg.round_id, sourceTier,
              disclosureId, ts);
            link = db.prepare('SELECT * FROM mediation_corrections WHERE id = ?').get(linkId);
          } catch (error) {
            if (String(error?.message || '').includes('UNIQUE')) {
              throw error; // 由外层事务回滚并转为明确失败
            }
            throw error;
          }
        } else if (fieldRow.tier === 2 && disclosureId) {
          db.prepare('UPDATE mediation_corrections SET disclosure_id = ? WHERE id = ?')
            .run(disclosureId, link.id);
        }
        for (const opinion of opinions) {
          db.prepare(`
            INSERT OR IGNORE INTO correction_objections
              (workflow_id, objection_id, batch_opinion_id, appeal_opinion_id, mediation_opinion_id,
               source_batch_id, source_round_id, source_package_id, source_tier, created_at)
            VALUES (?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)
          `).run(workflow.id, opinion.id, pkg.batch_id, pkg.round_id, packageId, fieldRow.tier, ts);
        }
        addMediationEvent(pkg.receipt_no, fieldRow.tier === 1 ? 'review.mediation.field.accepted' : 'review.mediation.arbitration.field.accepted', {
          packageId, mediationFieldId, tier: fieldRow.tier, workflowId: workflow.id, created,
          opinionIds: opinions.map((item) => item.id), disclosureId,
        });
        const result = afterFieldDecisionTx(pkg, tier, ts);
        return {
          ok: true, created, link: { id: link.id, inProgress: true },
          field: fieldOwnerView(db.prepare('SELECT * FROM mediation_fields WHERE id = ?').get(mediationFieldId)),
          workflow: publicWorkflow(workflow, getSteps(workflow.id)),
          pkg: result.pkg,
          packageStatus: result.status,
          escalated: result.escalated,
          packageCompleted: result.completed,
          parked: result.parked,
        };
      }

      if (action === 'reject') {
        if (reasonText.length < MEDIATION_OPINION_MIN || reasonText.length > MEDIATION_REJECT_REASON_MAX) {
          return { ok: false, status: 400, code: 'REJECT_REASON_REQUIRED', message: `驳回理由需为 ${MEDIATION_OPINION_MIN}-${MEDIATION_REJECT_REASON_MAX} 个字符` };
        }
        const rejectSupport = validatedInviteCount - supportCount;
        if (rejectSupport < rejectThreshold) {
          return {
            ok: false, status: 409, code: 'REJECT_THRESHOLD_NOT_MET',
            message: `该字段有 ${supportCount} 位处理人提出意见，支持驳回的仅 ${rejectSupport} 位，未达到驳回阈值 ${rejectThreshold}，不能驳回`,
            field: fieldOwnerView(fieldRow),
          };
        }
        const ts = now();
        const updated = db.prepare(`
          UPDATE mediation_fields
          SET decision = 'rejected', status = 'rejected', decided_at = ?, decided_by_user_id = ?,
              decision_reason = ?, decided_by_policy = ''
          WHERE id = ? AND decision IS NULL
        `).run(ts, userId, reasonText, mediationFieldId);
        if (updated.changes === 0) {
          return {
            ok: false, status: 409,
            code: fieldRow.tier === 2 ? 'ARBITRATION_FIELD_ALREADY_DECIDED' : 'MEDIATION_FIELD_ALREADY_DECIDED',
            message: '该字段刚被另一个页面决议，重复决议返回同一结果',
            field: fieldOwnerView(db.prepare('SELECT * FROM mediation_fields WHERE id = ?').get(mediationFieldId)),
          };
        }
        addMediationEvent(pkg.receipt_no, fieldRow.tier === 1 ? 'review.mediation.field.rejected' : 'review.mediation.arbitration.field.rejected', {
          packageId, mediationFieldId, tier: fieldRow.tier, reason: reasonText,
        });
        const result = afterFieldDecisionTx(pkg, tier, ts);
        return {
          ok: true,
          field: fieldOwnerView(db.prepare('SELECT * FROM mediation_fields WHERE id = ?').get(mediationFieldId)),
          pkg: result.pkg,
          packageStatus: result.status,
          escalated: result.escalated,
          packageCompleted: result.completed,
          parked: result.parked,
        };
      }
      return { ok: false, status: 400, code: 'INVALID_ACTION', message: '决议类型必须是 accept 或 reject' };
    });
  } catch (error) {
    // 并发的第二份更正（部分唯一索引）或并发决议：明确失败并返回当前状态
    if (String(error?.message || '').includes('UNIQUE')) {
      return immediateTransaction(() => {
        const pkg = loadPackageTx(packageId);
        const existing = db.prepare('SELECT * FROM mediation_corrections WHERE package_id = ? AND completed_at IS NULL').get(packageId);
        return {
          ok: false, status: 409,
          code: existing ? 'MEDIATION_CORRECTION_IN_PROGRESS' : 'MEDIATION_FIELD_ALREADY_DECIDED',
          message: existing ? MEDIATION_ERRORS.MEDIATION_CORRECTION_IN_PROGRESS : '该字段刚被另一个页面决议，重复决议返回同一结果',
          pkg: pkg ? packageOwnerView(pkg) : null,
        };
      });
    }
    throw error;
  }
}

// 字段终局后的统一收尾：
//   第一层：驳回字段数达到冻结的升级条件即冻结第一层（其余未决字段按策略自动驳回留档），
//           并按冻结快照开放第二层；第一层全部终局仍未达到条件则调解包完成、第二层永不开放。
//   第二层：全部字段终局 → 调解包完成。
function afterFieldDecisionTx(pkg, tier, ts) {
  // 第一层已接受的字段在升级时被标记为 skipped（status='skipped', decision IS NULL），
  // 不计入第二层待决议字段
  const pendingInTier = db.prepare(`
    SELECT COUNT(*) AS n FROM mediation_fields
    WHERE tier_id = ? AND decision IS NULL AND status <> 'skipped'
  `).get(tier.id).n;

  if (tier.tier === 1) {
    const rejectedCount = db.prepare(`
      SELECT COUNT(*) AS n FROM mediation_fields WHERE tier_id = ? AND decision = 'rejected'
    `).get(tier.id).n;
    if (rejectedCount >= tier.escalate_rejected_count && tier.status === 'active') {
      // 达到第一层升级条件。是否开放第二层还要过【案件组组级开放条件】：
      //   open → 正常按冻结快照开放；park → 第一层终局挂起等待前置成员；
      //   block → 第一层终局完成，第二层永不开放。
      let gate = null;
      if (mediationGroupGate) {
        gate = mediationGroupGate(pkg.id, ts);
      }
      if (gate && gate.mode === 'park') {
        finalizeLayer1WithoutArbitrationTx(pkg, tier, ts, { park: true, reason: gate.reason || '' });
        if (mediationGroupSync) mediationGroupSync(pkg.id, ts);
        return { completed: false, escalated: false, parked: true, status: pkg.status, pkg: packageOwnerView(loadPackageTx(pkg.id)) };
      }
      if (gate && gate.mode === 'block') {
        finalizeLayer1WithoutArbitrationTx(pkg, tier, ts, { park: false, reason: gate.reason || '' });
        if (mediationGroupSync) mediationGroupSync(pkg.id, ts);
        return { completed: true, escalated: false, status: 'completed', pkg: packageOwnerView(loadPackageTx(pkg.id)) };
      }
      // 达到升级条件：第一层立即冻结终局。第一层剩余未决字段由系统自动驳回（留档），
      // 其意见原样保留；已被第一层接受的字段不动。
      const autoRejected = autoRejectPendingFieldsTx(pkg, tier, ts);
      db.prepare(`
        UPDATE mediation_tiers SET status = 'completed', completed_at = COALESCE(completed_at, ?),
          final_decision = CASE WHEN final_decision = '' THEN 'escalated' ELSE final_decision END
        WHERE id = ? AND status = 'active'
      `).run(ts, tier.id);
      addMediationEvent(pkg.receipt_no, 'review.mediation.tier.completed', {
        packageId: pkg.id, tier: 1, escalated: true,
        autoRejectedFields: autoRejected.map((f) => batchFieldKey(f.step, f.field)),
      });
      const escalated = maybeOpenLayer2Tx(pkg, ts);
      if (mediationGroupSync) mediationGroupSync(pkg.id, ts);
      if (escalated) {
        return { completed: false, escalated: true, status: 'arbitrating', pkg: packageOwnerView(loadPackageTx(pkg.id)) };
      }
      // 极端兜底：达到驳回数但第二层配置无字段可仲裁（解析器保证不会发生）
      return { completed: true, escalated: false, status: 'completed', pkg: packageOwnerView(loadPackageTx(pkg.id)) };
    }
    if (pendingInTier > 0) {
      return { completed: false, escalated: false, status: pkg.status, pkg: packageOwnerView(loadPackageTx(pkg.id)) };
    }
    // 第一层全部终局但未达到升级条件：第二层永不开放，调解包完成
    db.prepare(`
      UPDATE mediation_tiers SET status = 'completed', completed_at = COALESCE(completed_at, ?),
        final_decision = CASE WHEN final_decision = '' THEN 'decided' ELSE final_decision END
      WHERE id = ? AND status = 'active'
    `).run(ts, tier.id);
    addMediationEvent(pkg.receipt_no, 'review.mediation.tier.completed', { packageId: pkg.id, tier: 1, escalated: false });
    db.prepare(`
      UPDATE mediation_tiers SET status = 'skipped', final_decision = 'not_escalated'
      WHERE package_id = ? AND tier = 2 AND status = 'pending'
    `).run(pkg.id);
    db.prepare(`
      UPDATE mediation_packages SET status = 'completed', completed_at = COALESCE(completed_at, ?) WHERE id = ?
    `).run(ts, pkg.id);
    addMediationEvent(pkg.receipt_no, 'review.mediation.completed', { packageId: pkg.id, afterTier: 1, escalated: false });
    return { completed: true, escalated: false, status: 'completed', pkg: packageOwnerView(loadPackageTx(pkg.id)) };
  }

  // 第二层
  if (pendingInTier > 0) {
    return { completed: false, escalated: false, status: pkg.status, pkg: packageOwnerView(loadPackageTx(pkg.id)) };
  }
  db.prepare(`
    UPDATE mediation_tiers SET status = 'completed', completed_at = COALESCE(completed_at, ?),
      final_decision = CASE WHEN final_decision = '' THEN 'decided' ELSE final_decision END
    WHERE id = ? AND status = 'active'
  `).run(ts, tier.id);
  db.prepare(`
    UPDATE mediation_packages SET status = 'completed', completed_at = COALESCE(completed_at, ?) WHERE id = ?
  `).run(ts, pkg.id);
  addMediationEvent(pkg.receipt_no, 'review.mediation.completed', { packageId: pkg.id, afterTier: 2 });
  return { completed: true, escalated: false, status: 'completed', pkg: packageOwnerView(loadPackageTx(pkg.id)) };
}

// 第一层达到升级条件后【按冻结快照】开放第二层：
// 只根据冻结的 tier1 配置（escalate_rejected_count）判定，不修改第一层结果；
// 为每个第二层字段生成第一层结论摘要（不含第一层调解人身份与逐字意见），
// 并冻结第二层策略、起算倒计时、重定第二层邀请有效期。
function maybeOpenLayer2Tx(pkg, ts) {
  const tier1 = loadTierTx(pkg.id, 1);
  const tier2 = loadTierTx(pkg.id, 2);
  if (!tier1 || !tier2 || tier2.status !== 'pending') return false;
  const rejectedCount = db.prepare(`
    SELECT COUNT(*) AS n FROM mediation_fields
    WHERE tier_id = ? AND decision = 'rejected'
  `).get(tier1.id).n;
  if (rejectedCount < tier1.escalate_rejected_count) return false;

  // 按第一层结束时的冻结快照生成第二层的字段结论摘要与授权证据透传
  const l1Fields = db.prepare('SELECT * FROM mediation_fields WHERE tier_id = ? ORDER BY ordinal').all(tier1.id);
  const l1ByKey = new Map(l1Fields.map((row) => [batchFieldKey(row.step, row.field), row]));
  const l2Fields = db.prepare('SELECT * FROM mediation_fields WHERE tier_id = ? ORDER BY ordinal').all(tier2.id);
  const arbitrableKeys = [];
  for (const l2 of l2Fields) {
    const l1 = l1ByKey.get(batchFieldKey(l2.step, l2.field));
    if (!l1) continue;
    if (l1.decision === 'accepted') {
      // 第一层已接受并进入更正的字段不再交付仲裁：第二层标记跳过，仲裁人不可见也不可提交
      db.prepare("UPDATE mediation_fields SET status = 'skipped' WHERE id = ? AND decision IS NULL").run(l2.id);
      continue;
    }
    arbitrableKeys.push(batchFieldKey(l2.step, l2.field));
    const l1Opinions = db.prepare('SELECT * FROM mediation_opinions WHERE mediation_field_id = ?').all(l1.id);
    // 允许向仲裁人披露的第一层“结论摘要”：只有聚合结论，没有调解人身份/逐字意见
    const summary = {
      key: batchFieldKey(l2.step, l2.field),
      layer1Decision: l1.decision,
      layer1RejectedReason: l1.decision_reason || '',
      layer1DecidedByPolicy: l1.decided_by_policy || '',
      layer1OpinionCount: l1Opinions.length,
      layer1AcceptedThreshold: l1.l1_accept_threshold,
      layer1RejectedThreshold: l1.l1_reject_threshold,
      // 仅透传办理人在调解包中选中的冻结证据（原复核人匿名化），第一层调解人意见不下发
      evidence: listFrozenEvidence(l1.id),
    };
    db.prepare(`
      INSERT INTO mediation_disclosures
        (id, package_id, l1_mediation_field_id, l2_mediation_field_id, tier, step, field,
         summary_json, created_at)
      VALUES (?, ?, ?, ?, 2, ?, ?, ?, ?)
    `).run(cryptoId(), pkg.id, l1.id, l2.id, l2.step, l2.field, JSON.stringify(summary), ts);
  }

  const deadline = ts + tier2.duration_ms;
  db.prepare(`
    UPDATE mediation_tiers
    SET status = 'active', started_at = ?, deadline_at = ?, frozen_policy = timeout_policy
    WHERE id = ? AND status = 'pending'
  `).run(ts, deadline, tier2.id);
  db.prepare(`
    UPDATE mediation_invitations
    SET expires_at = ?
    WHERE tier_id = ? AND used_at IS NULL AND revoked_at IS NULL
  `).run(deadline, tier2.id);
  db.prepare(`
    UPDATE mediation_packages SET status = 'arbitrating', escalated_at = COALESCE(escalated_at, ?)
    WHERE id = ? AND status IN ('mediating')
  `).run(ts, pkg.id);
  addMediationEvent(pkg.receipt_no, 'review.mediation.escalated', {
    packageId: pkg.id, rejectedCount, required: tier1.escalate_rejected_count,
    l2FieldKeys: arbitrableKeys, deadlineAt: deadline,
  });
  return true;
}

// ---------------------------------------------------------------------------
// 更正完成：新回执编号回填调解字段、意见与来源关系，并在全部字段终局时完成调解包
// ---------------------------------------------------------------------------
export function attachCorrectionReceiptForMediation({ workflowId, receiptNo }) {
  const links = db.prepare(`
    SELECT * FROM mediation_corrections WHERE workflow_id = ?
  `).all(workflowId);
  if (links.length === 0) return;
  const opinionLinks = db.prepare(`
    SELECT DISTINCT mediation_opinion_id FROM correction_objections
    WHERE workflow_id = ? AND mediation_opinion_id IS NOT NULL
  `).all(workflowId);
  const opinionIds = opinionLinks.map((item) => item.mediation_opinion_id);
  if (opinionIds.length) {
    const opinionRows = db.prepare(`
      SELECT * FROM mediation_opinions WHERE id IN (${opinionIds.map(() => '?').join(',')})
    `).all(...opinionIds);
    const fieldIds = [...new Set(opinionRows.map((row) => row.mediation_field_id))];
    for (const fieldId of fieldIds) {
      db.prepare('UPDATE mediation_fields SET correction_receipt_no = ? WHERE id = ?').run(receiptNo, fieldId);
    }
    db.prepare(`
      UPDATE mediation_opinions SET correction_receipt_no = ?
      WHERE id IN (${opinionIds.map(() => '?').join(',')})
    `).run(receiptNo, ...opinionIds);
  }
  for (const link of links) {
    db.prepare(`
      UPDATE mediation_corrections SET completed_at = ?, correction_receipt_no = ? WHERE id = ?
    `).run(now(), receiptNo, link.id);
    const pkg = loadPackageTx(link.package_id);
    if (!pkg) continue;
    addMediationEvent(pkg.receipt_no, 'review.mediation.correction.completed', {
      packageId: pkg.id, receiptNo, workflowId, sourceTier: link.source_tier,
    });
    // 若更正来自某层接受且该层其余字段都已终局，调解包可据此完成（正常情况下接受时已推进）
    const pending = db.prepare(`
      SELECT COUNT(*) AS n FROM mediation_fields
      WHERE package_id = ? AND decision IS NULL AND status <> 'skipped'
    `).get(pkg.id).n;
    if (pending === 0 && ['mediating', 'arbitrating'].includes(pkg.status)) {
      const ts = now();
      db.prepare(`
        UPDATE mediation_tiers SET status = 'completed', completed_at = COALESCE(completed_at, ?),
          final_decision = CASE WHEN final_decision = '' THEN 'decided' ELSE final_decision END
        WHERE package_id = ? AND status = 'active'
      `).run(ts, pkg.id);
      db.prepare("UPDATE mediation_packages SET status = 'completed', completed_at = COALESCE(completed_at, ?) WHERE id = ?")
        .run(ts, pkg.id);
      addMediationEvent(pkg.receipt_no, 'review.mediation.completed', { packageId: pkg.id, afterCorrection: receiptNo });
      if (mediationGroupSync) mediationGroupSync(pkg.id, ts);
    }
  }
}

// 放弃更正：清理调解包的更正来源关系。调解包历史不能改写——第一层字段终局保留；
// 若第一层尚无终局决议（理论上不会，因接受即终局），仅标记关系关闭，允许后续接受复用。
// 仲裁（第二层）接受进入的更正被放弃时，仲裁终局同样保留，可再次接受其他字段时新建更正。
export function resolveMediationCorrectionAbandonment(workflowId) {
  const links = db.prepare(`
    SELECT * FROM mediation_corrections WHERE workflow_id = ?
  `).all(workflowId);
  if (links.length === 0) return [];
  const packageIds = [];
  for (const link of links) {
    // 标记旧关系关闭：不再算作“进行中的更正”，同一调解包可再次接受并新建更正
    db.prepare(`
      UPDATE mediation_corrections SET completed_at = ?, correction_receipt_no = 'abandoned'
      WHERE id = ? AND completed_at IS NULL
    `).run(now(), link.id);
    packageIds.push(link.package_id);
    const pkg = loadPackageTx(link.package_id);
    if (pkg) {
      addMediationEvent(pkg.receipt_no, 'review.mediation.correction.abandoned', {
        packageId: pkg.id, workflowId, sourceTier: link.source_tier,
      });
    }
    if (mediationGroupSync) mediationGroupSync(link.package_id, now());
  }
  return packageIds;
}

// ---------------------------------------------------------------------------
// 时间线：调解包条目（原批次/申诉回合关系、两层状态、邀请状态、倒计时、证据摘要、
// 阈值进度、处理人、审计事件与更正来源）
// ---------------------------------------------------------------------------
export function buildMediationTimelineEntries(userId) {
  const packages = db.prepare('SELECT * FROM mediation_packages WHERE user_id = ? ORDER BY created_at ASC, rowid ASC')
    .all(userId);
  return packages.map((row) => {
    const view = packageOwnerView(row);
    const events = db.prepare(`
      SELECT type, detail_json, created_at FROM events
      WHERE workflow_id = ? AND json_extract(detail_json, '$.packageId') = ?
      ORDER BY id ASC
    `).all(row.workflow_id, row.id).map((event) => ({
      type: event.type,
      at: event.created_at,
      detail: JSON.parse(event.detail_json),
    }));
    const tierView = (tier) => {
      const t = tier === 1 ? view.tier1 : view.tier2;
      if (!t) return null;
      return {
        tier,
        id: t.id,
        status: t.status,
        escalateRejectedCount: t.escalateRejectedCount,
        durationMs: t.durationMs,
        timeoutPolicy: t.timeoutPolicy,
        frozenPolicy: t.frozenPolicy,
        startedAt: t.startedAt,
        deadlineAt: t.deadlineAt,
        remainingMs: t.remainingMs,
        completedAt: t.completedAt,
        finalDecision: t.finalDecision,
        timeoutFiredAt: t.timeoutFiredAt,
        timeoutResult: t.timeoutResult,
        invitationCount: t.invitationCount,
        validatedCount: t.validatedCount,
        revokedCount: t.revokedCount,
        expiredCount: t.expiredCount,
        fieldCount: t.fieldCount,
        decidedCount: t.decidedCount,
        acceptedCount: t.acceptedCount,
        rejectedCount: t.rejectedCount,
        invitations: t.invitations.map((invite) => ({
          id: invite.id,
          label: invite.label,
          ordinal: invite.ordinal,
          status: invite.status,
          usedAt: invite.usedAt,
          revokedAt: invite.revokedAt,
          expiresAt: invite.expiresAt,
          revokeReason: invite.revokeReason,
          fieldKeys: invite.fields.map((field) => field.key),
        })),
        fields: t.fields.map((field) => ({
          id: field.id,
          key: field.key,
          label: field.label,
          acceptThreshold: field.acceptThreshold,
          rejectThreshold: field.rejectThreshold,
          status: field.status,
          decision: field.decision,
          decidedAt: field.decidedAt,
          decidedBy: field.decidedBy,
          decisionReason: field.decisionReason,
          decidedByPolicy: field.decidedByPolicy,
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
          ...(tier === 1 ? {
            frozenAppealOpinions: (field.frozenAppealOpinions || []).map((opinion) => ({
              alias: opinion.alias,
              valueSnapshot: opinion.valueSnapshot,
              reason: opinion.reason,
              originalSubmittedAt: opinion.originalSubmittedAt,
            })),
            evidence: (field.frozenEvidence || []).map((item) => ({
              alias: item.alias,
              valueSnapshot: item.valueSnapshot,
              reason: item.reason,
              originalSubmittedAt: item.originalSubmittedAt,
            })),
            originalBatchDecision: field.originalBatchDecision,
            appealDecision: field.appealDecision,
          } : {
            layer1Summary: field.layer1Summary ? {
              layer1Decision: field.layer1Summary.layer1Decision,
              layer1RejectedReason: field.layer1Summary.layer1RejectedReason,
              layer1DecidedByPolicy: field.layer1Summary.layer1DecidedByPolicy,
              layer1OpinionCount: field.layer1Summary.layer1OpinionCount,
              evidence: field.layer1Summary.evidence,
            } : null,
          }),
        })),
      };
    };
    return {
      kind: 'mediationPackage',
      packageId: row.id,
      roundId: row.round_id,
      batchId: row.batch_id,
      receiptNo: row.receipt_no,
      status: view.status,
      note: view.note,
      createdAt: view.createdAt,
      cancelledAt: view.cancelledAt,
      cancelReason: view.cancelReason,
      completedAt: view.completedAt,
      expiredAt: view.expiredAt,
      escalatedAt: view.escalatedAt,
      correction: view.correction,
      frozenSnapshot: view.frozenSnapshot,
      tier1: tierView(1),
      tier2: tierView(2),
      events,
    };
  });
}
