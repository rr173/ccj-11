// ---------------------------------------------------------------------------
// 案件组（case group）的持久化与事务编排
//
// 案件组把【同一原批次】下多个已完成申诉回合生成的调解包按冻结顺序协调处理。
// 本模块只【冻结引用】 mediation_* 表的状态，不修改调解包的字段授权、两层配置
// 与历史；对调解包的强制动作（组级 fail 策略）通过注入的调解包事务原语完成。
//
// 并发安全：所有判定都在 BEGIN IMMEDIATE 事务中以“当前状态 + 行级条件更新”
// 为唯一判定；成员包加入用部分唯一索引兜底，组启动以 status='collecting' 条件
// 更新为唯一判定，组超时以 timeout_fired_at IS NULL 为唯一判定。
// ---------------------------------------------------------------------------
import { db, immediateTransaction, cryptoId } from './db.js';
import {
  CASE_GROUP_ERRORS,
  CASE_GROUP_MAX_MEMBERS,
  CASE_GROUP_TIMEOUT_POLICIES,
} from './caseGroups.js';
import {
  bindMediationGroupGate,
  bindMediationGroupSync,
  bindMediationCrossPackageDisclosure,
  bindCaseGroupMemberInfoHook,
  loadMediationPackageTx,
  mediationLayer1StateTx,
  openLayer2NativeTx,
  finalizeLayer1WithoutArbitrationTx,
  forceFinishPackageByGroupTx,
} from './mediationStore.js';

function now() {
  return Date.now();
}

// 注入的调解包事务原语（由 db.js 完成与 mediationStore 的接线，避免 ESM 初始化环）
const mediation = {
  loadPackageTx: loadMediationPackageTx,
  layer1StateTx: mediationLayer1StateTx,
  openLayer2NativeTx,
  finalizeLayer1WithoutArbitrationTx,
  forceFinishPackageByGroupTx,
};

export function bindMediationPrimitives(primitives) {
  Object.assign(mediation, primitives);
}

function addCaseGroupEvent(receiptNo, type, detail) {
  const row = db.prepare('SELECT workflow_id FROM receipts WHERE receipt_no = ?').get(receiptNo);
  if (!row) return;
  db.prepare(`
    INSERT INTO events (workflow_id, type, step, detail_json, created_at)
    VALUES (?, ?, NULL, ?, ?)
  `).run(row.workflow_id, type, JSON.stringify({ receiptNo, ...detail }), now());
}

function loadGroupTx(groupId) {
  return db.prepare('SELECT * FROM case_groups WHERE id = ?').get(groupId) || null;
}

function loadMembersTx(groupId) {
  return db.prepare(`
    SELECT * FROM case_group_members WHERE group_id = ? ORDER BY ordinal ASC, joined_at ASC
  `).all(groupId);
}

function loadMemberByPackageTx(packageId) {
  return db.prepare('SELECT * FROM case_group_members WHERE package_id = ?').get(packageId) || null;
}

// ---------------------------------------------------------------------------
// 加入冲突检查：原批次字段、申诉来源、当前更正、调解包状态四个维度
// 返回 { ok:true } 或 { ok:false, code, detail }
// ---------------------------------------------------------------------------
function evaluateJoinConflictsTx({ group, candidate, memberRows, packageSnapshots }) {
  // 1) 原批次字段：调解包必须与案件组属于同一原批次
  if (candidate.pkg.batch_id !== group.batch_id) {
    return {
      ok: false,
      code: 'CASE_PACKAGE_BATCH_MISMATCH',
      detail: `调解包来自原批次 ${candidate.pkg.batch_id}，案件组原批次为 ${group.batch_id}`,
    };
  }
  // 2) 调解包状态：必须处于第一层处理中（mediating），且第二层尚未开放、无终局决议
  if (candidate.pkg.status !== 'mediating') {
    if (candidate.pkg.status === 'arbitrating') {
      return { ok: false, code: 'CASE_PACKAGE_TIER2_OPEN', detail: '调解包第二层仲裁已开放' };
    }
    return {
      ok: false,
      code: 'CASE_PACKAGE_STATUS_CONFLICT',
      detail: `调解包状态为 ${candidate.pkg.status}，只能加入第一层处理中的调解包`,
    };
  }
  const layer1 = mediation.layer1StateTx(candidate.pkg.id);
  if (!layer1 || layer1.tier1Status !== 'active' || layer1.tier2Status !== 'pending') {
    return {
      ok: false,
      code: 'CASE_PACKAGE_STATUS_CONFLICT',
      detail: '调解包第一层已冻结或第二层已开放，不能加入案件组',
    };
  }
  const decidedCount = db.prepare(`
    SELECT COUNT(*) AS n FROM mediation_fields
    WHERE package_id = ? AND tier = 1 AND decision IS NOT NULL
  `).get(candidate.pkg.id).n;
  if (decidedCount > 0) {
    return {
      ok: false,
      code: 'CASE_PACKAGE_STATUS_CONFLICT',
      detail: '调解包第一层已有字段终局决议，不能加入案件组',
    };
  }
  // 3) 申诉来源：同一申诉回合至多一个成员包
  if (memberRows.some((member) => member.round_id === candidate.pkg.round_id)) {
    return {
      ok: false,
      code: 'CASE_PACKAGE_SOURCE_CONFLICT',
      detail: `申诉回合 ${candidate.pkg.round_id} 已有成员包，同一申诉来源不能重复加入`,
    };
  }
  // 4) 字段授权冲突：与既有成员包不得包含相同的【原批次字段】。
  // 同一原批次字段可在不同申诉回合被反复申诉，appeal_field_id 不同但 source_field_id 相同，
  // 跨包协调针对原批次字段，因此按 source_field_id 判重。
  const candidateFieldIds = new Set(candidate.fields.map((f) => f.source_field_id));
  for (const member of memberRows) {
    const snapshot = packageSnapshots.get(member.id);
    const overlap = (snapshot.fieldSourceIds || []).filter((id) => candidateFieldIds.has(id));
    if (overlap.length > 0) {
      return {
        ok: false,
        code: 'CASE_PACKAGE_FIELD_CONFLICT',
        detail: `与成员包 ${member.package_id} 在 ${overlap.length} 个申诉字段上授权重叠`,
        overlapCount: overlap.length,
      };
    }
  }
  // 5) 当前更正：调解包不能已有进行中的更正办理
  const openCorrection = db.prepare(`
    SELECT id FROM mediation_corrections WHERE package_id = ? AND completed_at IS NULL
  `).get(candidate.pkg.id);
  if (openCorrection) {
    return {
      ok: false,
      code: 'CASE_PACKAGE_CORRECTION_CONFLICT',
      detail: '调解包已存在进行中的更正办理',
    };
  }
  return { ok: true };
}

// 加入瞬间的成员冻结快照：来源、字段授权、两层配置、邀请状态、当前包状态
function buildMemberSnapshotTx(pkg) {
  const tierRows = db.prepare('SELECT * FROM mediation_tiers WHERE package_id = ? ORDER BY tier').all(pkg.id);
  const fields = db.prepare(`
    SELECT * FROM mediation_fields WHERE package_id = ? ORDER BY tier, ordinal
  `).all(pkg.id);
  const invitations = db.prepare(`
    SELECT id, tier, ordinal, label, status, used_at, revoked_at, expires_at
    FROM mediation_invitations WHERE package_id = ? ORDER BY tier, ordinal
  `).all(pkg.id);
  const round = db.prepare('SELECT id, status, reason_summary FROM review_appeal_rounds WHERE id = ?').get(pkg.round_id);
  return {
    frozenAt: now(),
    package: {
      id: pkg.id,
      status: pkg.status,
      roundId: pkg.round_id,
      batchId: pkg.batch_id,
      receiptNo: pkg.receipt_no,
      createdAt: pkg.created_at,
    },
    round: round ? { id: round.id, status: round.status, reasonSummary: round.reason_summary } : null,
    fieldAppealIds: fields.filter((f) => f.tier === 1).map((f) => f.appeal_field_id),
    fieldSourceIds: fields.filter((f) => f.tier === 1).map((f) => f.source_field_id),
    fields: fields.map((f) => ({
      tier: f.tier,
      key: `${f.step}.${f.field}`,
      appealFieldId: f.appeal_field_id,
      l1AcceptThreshold: f.l1_accept_threshold,
      l1RejectThreshold: f.l1_reject_threshold,
      l2AcceptThreshold: f.l2_accept_threshold,
      l2RejectThreshold: f.l2_reject_threshold,
    })),
    tiers: tierRows.map((t) => ({
      tier: t.tier,
      status: t.status,
      escalateRejectedCount: t.escalate_rejected_count,
      invitationCount: t.invitation_count,
      durationMs: t.duration_ms,
      timeoutPolicy: t.timeout_policy,
      frozenPolicy: t.frozen_policy,
    })),
    invitations: invitations.map((invite) => ({
      id: invite.id,
      tier: invite.tier,
      ordinal: invite.ordinal,
      label: invite.label,
      status: invite.status,
      used: Boolean(invite.used_at),
      revoked: Boolean(invite.revoked_at),
      expiresAt: invite.expires_at,
    })),
  };
}

function recordRejectionTx(group, pkg, code, detail) {
  const id = cryptoId();
  db.prepare(`
    INSERT INTO case_group_rejections
      (id, group_id, package_id, round_id, batch_id, reason_code, reason_detail, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, group.id, pkg.id, pkg.round_id, pkg.batch_id, code, String(detail || ''), now());
  addCaseGroupEvent(group.receipt_no, 'review.caseGroup.member.rejected', {
    groupId: group.id, packageId: pkg.id, roundId: pkg.round_id, code, detail: String(detail || ''),
  });
  return id;
}

function prepareCandidateTx(packageId) {
  const pkg = mediation.loadPackageTx(packageId);
  if (!pkg) return null;
  const fields = db.prepare(`
    SELECT appeal_field_id, source_field_id FROM mediation_fields WHERE package_id = ? AND tier = 1
  `).all(packageId);
  return { pkg, fields };
}

// ---------------------------------------------------------------------------
// 创建案件组（锚点成员必须先通过同一套冲突检查）
// ---------------------------------------------------------------------------
export function createCaseGroup({ userId, anchorPackageId, note }) {
  try {
    return immediateTransaction(() => {
      const candidate = prepareCandidateTx(anchorPackageId);
      if (!candidate) {
        return { ok: false, status: 404, code: 'MEDIATION_NOT_FOUND', message: '调解包不存在' };
      }
      const { pkg } = candidate;
      if (pkg.user_id !== userId) {
        return { ok: false, status: 404, code: 'MEDIATION_NOT_FOUND', message: '调解包不存在' };
      }
      // 已在未终结案件组中的包不能再作为锚点
      const occupied = loadMemberByPackageTx(pkg.id);
      if (occupied && occupied.open_group_id) {
        return {
          ok: false,
          status: 409,
          code: 'CASE_PACKAGE_ALREADY_IN_GROUP',
          message: CASE_GROUP_ERRORS.CASE_PACKAGE_ALREADY_IN_GROUP,
        };
      }
      const ts = now();
      const groupId = cryptoId();
      const groupRow = {
        id: groupId,
        batch_id: pkg.batch_id,
        receipt_no: pkg.receipt_no,
        workflow_id: pkg.workflow_id,
        user_id: userId,
        status: 'collecting',
        note: note || '',
        config_json: '{}',
        frozen_snapshot_json: '{}',
        min_completions: 1,
        member_order_json: '[]',
        timeout_policy: 'block_remaining',
        disclosures_json: '[]',
        created_at: ts,
        configured_at: null,
        started_at: null,
        deadline_at: null,
        completed_at: null,
        cancelled_at: null,
        cancel_reason: '',
        timeout_fired_at: null,
        timeout_result: '',
      };
      // 空成员集先做一次冲突检查（批次/状态/更正维度）
      const probeGroup = { id: groupId, batch_id: pkg.batch_id, receipt_no: pkg.receipt_no };
      const conflict = evaluateJoinConflictsTx({
        group: probeGroup, candidate, memberRows: [], packageSnapshots: new Map(),
      });
      if (!conflict.ok) {
        return {
          ok: false,
          status: conflict.code === 'CASE_PACKAGE_TIER2_OPEN' ? 409 : 409,
          code: conflict.code,
          message: CASE_GROUP_ERRORS[conflict.code] || conflict.detail,
          detail: conflict.detail,
        };
      }
      insertGroupRowTx(groupRow);
      const snapshot = buildMemberSnapshotTx(pkg);
      insertMemberTx({
        groupId, pkg, ordinal: 0, snapshot, status: 'joined', openGroupId: groupId, joinedAt: ts,
      });
      rebuildGroupSnapshotTx(groupId);
      addCaseGroupEvent(pkg.receipt_no, 'review.caseGroup.created', {
        groupId, batchId: pkg.batch_id, anchorPackageId: pkg.id, roundId: pkg.round_id,
      });
      addCaseGroupEvent(pkg.receipt_no, 'review.caseGroup.member.joined', {
        groupId, packageId: pkg.id, roundId: pkg.round_id, ordinal: 0,
      });
      return { ok: true, groupId, group: getCaseGroupForOwnerTx(groupId, userId) };
    });
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) {
      return {
        ok: false,
        status: 409,
        code: 'CASE_PACKAGE_ALREADY_IN_GROUP',
        message: CASE_GROUP_ERRORS.CASE_PACKAGE_ALREADY_IN_GROUP,
      };
    }
    throw error;
  }
}

function insertGroupRowTx(row) {
  db.prepare(`
    INSERT INTO case_groups
      (id, batch_id, receipt_no, workflow_id, user_id, status, note, config_json,
       frozen_snapshot_json, min_completions, member_order_json, timeout_policy, disclosures_json,
       created_at, configured_at, started_at, deadline_at, completed_at, cancelled_at,
       cancel_reason, timeout_fired_at, timeout_result)
    VALUES (@id, @batch_id, @receipt_no, @workflow_id, @user_id, @status, @note, @config_json,
            @frozen_snapshot_json, @min_completions, @member_order_json, @timeout_policy,
            @disclosures_json, @created_at, @configured_at, @started_at, @deadline_at,
            @completed_at, @cancelled_at, @cancel_reason, @timeout_fired_at, @timeout_result)
  `).run(row);
}

function insertMemberTx({ groupId, pkg, ordinal, snapshot, status, openGroupId, joinedAt }) {
  const id = cryptoId();
  db.prepare(`
    INSERT INTO case_group_members
      (id, group_id, package_id, round_id, batch_id, receipt_no, ordinal, status,
       open_group_id, gate_reason, member_snapshot_json, result_json, joined_at,
       gate_decided_at, finished_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?, '{}', ?, NULL, NULL)
  `).run(id, groupId, pkg.id, pkg.round_id, pkg.batch_id, pkg.receipt_no, ordinal,
    status, openGroupId, JSON.stringify(snapshot), joinedAt);
  return id;
}

// 重新生成组级只读冻结快照（加入/配置/启动瞬间）；启动后不再调用
function rebuildGroupSnapshotTx(groupId) {
  const group = loadGroupTx(groupId);
  if (!group) return;
  const members = loadMembersTx(groupId);
  const snapshots = members.map((member) => ({
    packageId: member.package_id,
    roundId: member.round_id,
    ordinal: member.ordinal,
    status: member.status,
    snapshot: JSON.parse(member.member_snapshot_json),
  }));
  const snapshot = {
    frozenAt: now(),
    batchId: group.batch_id,
    status: group.status,
    minCompletions: group.min_completions,
    memberOrder: JSON.parse(group.member_order_json || '[]'),
    timeoutPolicy: group.timeout_policy,
    disclosedPackageIds: JSON.parse(group.disclosures_json || '[]'),
    members: snapshots.map((item) => ({
      packageId: item.packageId,
      roundId: item.roundId,
      ordinal: item.ordinal,
      status: item.status,
      packageStatus: item.snapshot.package.status,
      fieldKeys: item.snapshot.fields.filter((f) => f.tier === 1).map((f) => f.key),
      layer1: item.snapshot.tiers.find((t) => t.tier === 1) || null,
      layer2: item.snapshot.tiers.find((t) => t.tier === 2) || null,
    })),
  };
  db.prepare('UPDATE case_groups SET frozen_snapshot_json = ? WHERE id = ?')
    .run(JSON.stringify(snapshot), groupId);
}

// ---------------------------------------------------------------------------
// 加入成员：必须在 collecting 阶段；冲突检查不通过则拒绝并留档
// ---------------------------------------------------------------------------
export function addCaseGroupMember({ userId, groupId, packageId }) {
  try {
    return immediateTransaction(() => {
      const group = loadGroupTx(groupId);
      if (!group || group.user_id !== userId) {
        return { ok: false, status: 404, code: 'CASE_GROUP_NOT_FOUND', message: CASE_GROUP_ERRORS.CASE_GROUP_NOT_FOUND };
      }
      if (group.status !== 'collecting') {
        return {
          ok: false,
          status: 409,
          code: 'CASE_GROUP_NOT_COLLECTING',
          message: CASE_GROUP_ERRORS.CASE_GROUP_NOT_COLLECTING,
          group: getCaseGroupForOwnerTx(groupId, userId),
        };
      }
      const candidate = prepareCandidateTx(packageId);
      if (!candidate) {
        return { ok: false, status: 404, code: 'MEDIATION_NOT_FOUND', message: '调解包不存在' };
      }
      if (candidate.pkg.user_id !== userId) {
        return { ok: false, status: 404, code: 'MEDIATION_NOT_FOUND', message: '调解包不存在' };
      }
      const members = loadMembersTx(groupId);
      if (members.length >= CASE_GROUP_MAX_MEMBERS) {
        recordRejectionTx(group, candidate.pkg, 'CASE_GROUP_MEMBER_LIMIT', CASE_GROUP_ERRORS.CASE_GROUP_MEMBER_LIMIT);
        return {
          ok: false,
          status: 409,
          code: 'CASE_GROUP_MEMBER_LIMIT',
          message: CASE_GROUP_ERRORS.CASE_GROUP_MEMBER_LIMIT,
        };
      }
      if (members.some((member) => member.package_id === packageId)) {
        return {
          ok: false,
          status: 409,
          code: 'CASE_PACKAGE_SOURCE_CONFLICT',
          message: '该调解包已经是案件组成员',
        };
      }
      const occupied = loadMemberByPackageTx(packageId);
      if (occupied && occupied.open_group_id && occupied.open_group_id !== groupId) {
        recordRejectionTx(group, candidate.pkg, 'CASE_PACKAGE_ALREADY_IN_GROUP', CASE_GROUP_ERRORS.CASE_PACKAGE_ALREADY_IN_GROUP);
        return {
          ok: false,
          status: 409,
          code: 'CASE_PACKAGE_ALREADY_IN_GROUP',
          message: CASE_GROUP_ERRORS.CASE_PACKAGE_ALREADY_IN_GROUP,
        };
      }
      const snapshotMap = new Map(members.map((member) => [
        member.id,
        {
          fieldSourceIds: JSON.parse(member.member_snapshot_json).fieldSourceIds
            || JSON.parse(member.member_snapshot_json).fieldAppealIds
            || [],
        },
      ]));
      const conflict = evaluateJoinConflictsTx({
        group, candidate, memberRows: members, packageSnapshots: snapshotMap,
      });
      if (!conflict.ok) {
        recordRejectionTx(group, candidate.pkg, conflict.code, conflict.detail);
        return {
          ok: false,
          status: 409,
          code: conflict.code,
          message: CASE_GROUP_ERRORS[conflict.code] || conflict.detail,
          detail: conflict.detail,
          group: getCaseGroupForOwnerTx(groupId, userId),
        };
      }
      const ts = now();
      const ordinal = members.length;
      const snapshot = buildMemberSnapshotTx(candidate.pkg);
      insertMemberTx({
        groupId, pkg: candidate.pkg, ordinal, snapshot,
        status: 'joined', openGroupId: groupId, joinedAt: ts,
      });
      rebuildGroupSnapshotTx(groupId);
      addCaseGroupEvent(group.receipt_no, 'review.caseGroup.member.joined', {
        groupId, packageId, roundId: candidate.pkg.round_id, ordinal,
      });
      return { ok: true, group: getCaseGroupForOwnerTx(groupId, userId) };
    });
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) {
      return immediateTransaction(() => {
        const group = loadGroupTx(groupId);
        if (group) {
          const candidate = prepareCandidateTx(packageId);
          if (candidate) {
            recordRejectionTx(group, candidate.pkg, 'CASE_PACKAGE_ALREADY_IN_GROUP',
              CASE_GROUP_ERRORS.CASE_PACKAGE_ALREADY_IN_GROUP);
          }
        }
        return {
          ok: false,
          status: 409,
          code: 'CASE_PACKAGE_ALREADY_IN_GROUP',
          message: CASE_GROUP_ERRORS.CASE_PACKAGE_ALREADY_IN_GROUP,
        };
      });
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 保存组级配置（仅 collecting）：最少完成数、处理顺序、超时策略、限时、披露白名单
// ---------------------------------------------------------------------------
export function configureCaseGroup({ userId, groupId, config }) {
  return immediateTransaction(() => {
    const group = loadGroupTx(groupId);
    if (!group || group.user_id !== userId) {
      return { ok: false, status: 404, code: 'CASE_GROUP_NOT_FOUND', message: CASE_GROUP_ERRORS.CASE_GROUP_NOT_FOUND };
    }
    if (group.status !== 'collecting') {
      return {
        ok: false,
        status: 409,
        code: 'CASE_GROUP_NOT_COLLECTING',
        message: CASE_GROUP_ERRORS.CASE_GROUP_NOT_COLLECTING,
        group: getCaseGroupForOwnerTx(groupId, userId),
      };
    }
    const members = loadMembersTx(groupId);
    const memberPackageIds = members.map((member) => member.package_id);
    // 白名单只能引用本组成员
    if (Array.isArray(config.disclosedPackageIds)
      && !config.disclosedPackageIds.every((id) => memberPackageIds.includes(id))) {
      return {
        ok: false,
        status: 400,
        code: 'CASE_GROUP_DISCLOSURE_INVALID',
        message: CASE_GROUP_ERRORS.CASE_GROUP_DISCLOSURE_INVALID,
      };
    }
    if (!CASE_GROUP_TIMEOUT_POLICIES.includes(config.timeoutPolicy)) {
      return {
        ok: false,
        status: 400,
        code: 'CASE_GROUP_TIMEOUT_POLICY_INVALID',
        message: CASE_GROUP_ERRORS.CASE_GROUP_TIMEOUT_POLICY_INVALID,
      };
    }
    const ts = now();
    db.prepare(`
      UPDATE case_groups
      SET min_completions = ?, member_order_json = ?, timeout_policy = ?,
          disclosures_json = ?, config_json = ?, configured_at = COALESCE(configured_at, ?)
      WHERE id = ? AND status = 'collecting'
    `).run(
      config.minCompletions,
      JSON.stringify(config.memberOrder),
      config.timeoutPolicy,
      JSON.stringify(config.disclosedPackageIds),
      JSON.stringify({ ...config, savedAt: ts }),
      ts,
      groupId,
    );
    // 处理顺序同步到成员 ordinal
    config.memberOrder.forEach((packageId, ordinal) => {
      db.prepare('UPDATE case_group_members SET ordinal = ? WHERE group_id = ? AND package_id = ?')
        .run(ordinal, groupId, packageId);
    });
    rebuildGroupSnapshotTx(groupId);
    addCaseGroupEvent(group.receipt_no, 'review.caseGroup.configured', {
      groupId,
      minCompletions: config.minCompletions,
      order: config.memberOrder,
      timeoutPolicy: config.timeoutPolicy,
      ttlMs: config.ttlMs,
      disclosedPackageIds: config.disclosedPackageIds,
    });
    return { ok: true, group: getCaseGroupForOwnerTx(groupId, userId) };
  });
}

// ---------------------------------------------------------------------------
// 启动组处理：以 status='collecting' 条件更新为唯一判定，两个页面并发只成功一个；
// 启动瞬间冻结配置、起算组级倒计时。
// ---------------------------------------------------------------------------
export function startCaseGroup({ userId, groupId }) {
  return immediateTransaction(() => {
    settleCaseGroupTimeoutTx(loadGroupTx(groupId));
    const group = loadGroupTx(groupId);
    if (!group || group.user_id !== userId) {
      return { ok: false, status: 404, code: 'CASE_GROUP_NOT_FOUND', message: CASE_GROUP_ERRORS.CASE_GROUP_NOT_FOUND };
    }
    if (group.status === 'processing') {
      return {
        ok: false,
        status: 409,
        code: 'CASE_GROUP_ALREADY_STARTED',
        message: CASE_GROUP_ERRORS.CASE_GROUP_ALREADY_STARTED,
        group: getCaseGroupForOwnerTx(groupId, userId),
      };
    }
    if (group.status !== 'collecting') {
      return {
        ok: false,
        status: 409,
        code: 'CASE_GROUP_NOT_COLLECTING',
        message: CASE_GROUP_ERRORS.CASE_GROUP_NOT_COLLECTING,
        group: getCaseGroupForOwnerTx(groupId, userId),
      };
    }
    const members = loadMembersTx(groupId);
    if (members.length === 0) {
      return { ok: false, status: 409, code: 'CASE_GROUP_EMPTY', message: CASE_GROUP_ERRORS.CASE_GROUP_EMPTY };
    }
    const savedConfig = JSON.parse(group.config_json || '{}');
    if (!savedConfig.memberOrder || !Array.isArray(savedConfig.memberOrder)
      || savedConfig.memberOrder.length !== members.length) {
      // 未显式配置时使用加入顺序作为冻结顺序
      const order = members.map((member) => member.package_id);
      db.prepare(`
        UPDATE case_groups
        SET min_completions = ?, member_order_json = ?, timeout_policy = ?,
            disclosures_json = '[]', config_json = ?
        WHERE id = ?
      `).run(1, JSON.stringify(order), 'block_remaining',
        JSON.stringify({ minCompletions: 1, memberOrder: order, timeoutPolicy: 'block_remaining',
          disclosedPackageIds: [], ttlMs: 0, implicit: true }),
        groupId);
    }
    const ts = now();
    const ready = db.prepare("SELECT id FROM case_groups WHERE id = ? AND status = 'collecting'").get(groupId);
    if (!ready) {
      return {
        ok: false,
        status: 409,
        code: 'CASE_GROUP_ALREADY_STARTED',
        message: CASE_GROUP_ERRORS.CASE_GROUP_ALREADY_STARTED,
      };
    }
    const finalGroup = loadGroupTx(groupId);
    const config = JSON.parse(finalGroup.config_json || '{}');
    const ttlMs = Number(config.ttlMs) > 0 ? Number(config.ttlMs) : 0;
    const updated = db.prepare(`
      UPDATE case_groups
      SET status = 'processing', started_at = ?, deadline_at = ?, frozen_snapshot_json = ?
      WHERE id = ? AND status = 'collecting'
    `).run(ts, ttlMs > 0 ? ts + ttlMs : null, finalGroup.frozen_snapshot_json, groupId);
    if (updated.changes === 0) {
      return {
        ok: false,
        status: 409,
        code: 'CASE_GROUP_ALREADY_STARTED',
        message: CASE_GROUP_ERRORS.CASE_GROUP_ALREADY_STARTED,
      };
    }
    // 启动后成员包不能再加入其他未终结组：open_group_id 保持指向本组
    addCaseGroupEvent(group.receipt_no, 'review.caseGroup.started', {
      groupId,
      minCompletions: finalGroup.min_completions,
      order: JSON.parse(finalGroup.member_order_json),
      timeoutPolicy: finalGroup.timeout_policy,
      deadlineAt: ttlMs > 0 ? ts + ttlMs : null,
    });
    // 启动时按冻结规则同步一次（正常情况下成员都仍在第一层处理中）
    syncMembershipTx(groupId, ts);
    return { ok: true, group: getCaseGroupForOwnerTx(groupId, userId) };
  });
}

// ---------------------------------------------------------------------------
// 取消收集组（仅 collecting、无任何终局）：成员包释放，恢复为独立调解包
// ---------------------------------------------------------------------------
export function cancelCaseGroup({ userId, groupId, reason }) {
  return immediateTransaction(() => {
    const group = loadGroupTx(groupId);
    if (!group || group.user_id !== userId) {
      return { ok: false, status: 404, code: 'CASE_GROUP_NOT_FOUND', message: CASE_GROUP_ERRORS.CASE_GROUP_NOT_FOUND };
    }
    if (group.status !== 'collecting') {
      return {
        ok: false,
        status: 409,
        code: 'CASE_GROUP_NOT_COLLECTING',
        message: '案件组已开始处理，不能取消',
        group: getCaseGroupForOwnerTx(groupId, userId),
      };
    }
    const ts = now();
    const text = String(reason || '').trim().slice(0, 200);
    // 成员释放：清空 open_group_id，标记 released（历史保留）
    db.prepare(`
      UPDATE case_group_members
      SET status = 'released', open_group_id = NULL, gate_reason = '案件组取消',
          gate_decided_at = ?, finished_at = ?
      WHERE group_id = ?
    `).run(ts, ts, groupId);
    db.prepare(`
      UPDATE case_groups
      SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?
      WHERE id = ?
    `).run(ts, text, groupId);
    addCaseGroupEvent(group.receipt_no, 'review.caseGroup.cancelled', { groupId, reason: text });
    return { ok: true, group: getCaseGroupForOwnerTx(groupId, userId) };
  });
}

// ---------------------------------------------------------------------------
// 组级开放条件判定（组已开始处理后）：
//   - 成员在冻结顺序中的位置（0-based）必须 < minCompletions；
//   - 该成员前置成员的第一层都已终局（completed/arbitration_blocked/failed/cancelled）；
//   - 该成员自身第一层已达到升级条件并冻结（由调用方保证）。
// mode: open / park / block
// ---------------------------------------------------------------------------
function gateDecisionTx(group, member, members, ts) {
  if (group.status !== 'processing') {
    // collecting 阶段第一层即使达到升级也挂起，等待组启动；终态组一律阻止第二层
    if (group.status === 'collecting') {
      return { mode: 'park', reason: '案件组尚未开始处理，第二层仲裁暂不开放' };
    }
    return { mode: 'block', reason: `案件组已${group.status === 'cancelled' ? '取消' : '终结'}，第二层仲裁不开放` };
  }
  if (member.status === 'arbitrating' || member.status === 'completed' || member.status === 'failed') {
    return { mode: 'open' };
  }
  // 组级超时已落定：未开放的成员一律阻止
  if (group.timeout_fired_at) {
    return {
      mode: 'block',
      reason: group.timeout_policy === 'fail'
        ? '案件组已按 fail 策略超时失败，第二层仲裁不开放'
        : '案件组限时到达：该成员未达到组级开放条件，第二层仲裁不开放',
    };
  }
  // 按冻结顺序：前置成员第一层未终局时先挂起等待（即使该成员超出最少完成数，
  // 也要等前置终局后再明确阻断，避免重启恢复时把“等待中”误判为“已阻断”）。
  const terminal = new Set(['arbitration_blocked', 'completed', 'failed', 'cancelled', 'arbitrating']);
  for (const predecessor of members) {
    if (predecessor.ordinal >= member.ordinal) continue;
    if (!terminal.has(predecessor.status)) {
      return {
        mode: 'park',
        reason: `前置成员包（第 ${predecessor.ordinal + 1} 位）第一层尚未终局，按冻结顺序等待`,
      };
    }
  }
  if (member.ordinal >= group.min_completions) {
    return {
      mode: 'block',
      reason: `该成员处理顺序为第 ${member.ordinal + 1} 位，超出组级最少完成数 ${group.min_completions}，第二层仲裁不开放`,
    };
  }
  return { mode: 'open' };
}

// 门控钩子：供 mediationStore 在第一层达到升级条件时（事务内）调用
function mediationGroupGate(packageId, ts) {
  const member = loadMemberByPackageTx(packageId);
  if (!member || !member.open_group_id) return null;
  const group = loadGroupTx(member.open_group_id);
  if (!group) return null;
  const members = loadMembersTx(group.id);
  const decision = gateDecisionTx(group, member, members, ts);
  // block 判定在调解包置 completed 之前先把成员落为 arbitration_blocked，
  // 这样后续同步不会把它归一为普通 completed
  if (decision.mode === 'block') {
    db.prepare(`
      UPDATE case_group_members
      SET status = 'arbitration_blocked', gate_reason = ?, gate_decided_at = COALESCE(gate_decided_at, ?)
      WHERE id = ? AND status NOT IN ('arbitration_blocked', 'completed', 'failed', 'cancelled')
    `).run(decision.reason, ts, member.id);
    persistMemberResultTx(member.package_id);
    addCaseGroupEvent(group.receipt_no, 'review.caseGroup.member.arbitration.blocked', {
      groupId: group.id, packageId, ordinal: member.ordinal, reason: decision.reason,
    });
  }
  if (decision.mode === 'open' && member.status !== 'arbitrating') {
    // 第二层开放瞬间生成跨包摘要（幂等：ON CONFLICT DO NOTHING）
    buildCrossPackageDisclosureTx(group, member, ts);
  }
  return decision;
}

// 状态同步钩子：调解包任何终局/更正变化后（事务内）按冻结规则原子更新组与剩余成员
function mediationGroupSync(packageId, ts = now()) {
  const member = loadMemberByPackageTx(packageId);
  if (!member || !member.group_id) return;
  // released/cancelled 组成员历史行不再参与同步
  if (member.status === 'released') return;
  syncMembershipTx(member.group_id, ts);
}

// 核心：根据各成员包当前状态与组冻结配置，推进成员状态、级联门控、组终局
function syncMembershipTx(groupId, ts) {
  settleCaseGroupTimeoutTx(loadGroupTx(groupId));
  const group = loadGroupTx(groupId);
  if (!group || group.status === 'cancelled') return;
  const members = loadMembersTx(groupId);
  let changed = true;
  let iterations = 0;
  while (changed && iterations < members.length + 2) {
    changed = false;
    iterations += 1;
    for (const member of members) {
      const next = resolveMemberStatusTx(group, member, members, ts);
      if (next && next !== member.status) {
        applyMemberStatusTx(group, member, next.status, next, ts);
        member.status = next.status;
        changed = true;
      }
    }
  }
  // 固定点收敛后：为所有已开放第二层仲裁的成员刷新跨包摘要（成员状态此时已稳定）
  for (const member of loadMembersTx(groupId)) {
    if (member.status === 'arbitrating') {
      buildCrossPackageDisclosureTx(group, member, ts);
    }
  }
  maybeFinishGroupTx(groupId, ts);
}

// 计算成员应有状态；返回 null 表示不变
function resolveMemberStatusTx(group, member, members, ts) {
  if (['completed', 'failed', 'cancelled', 'released', 'arbitration_blocked'].includes(member.status)) {
    return null;
  }
  const state = mediation.layer1StateTx(member.package_id);
  if (!state) return null;

  // 包级终态优先：取消/超时失败/完成
  if (state.status === 'cancelled') {
    return { status: 'cancelled', reason: '成员调解包已取消' };
  }
  if (state.status === 'expired' || state.status === 'failed') {
    return { status: 'failed', reason: `成员调解包已${state.status === 'expired' ? '超时' : '失败'}终结` };
  }
  if (state.status === 'completed') {
    // 成员已被组门控显式置为 arbitration_blocked：保持该终态
    if (member.status === 'arbitration_blocked') return null;
    return { status: 'completed', reason: state.tier2Status === 'skipped' ? '第一层终局完成，第二层未开放' : '两层处理完成' };
  }
  if (state.status === 'arbitrating') {
    if (member.status !== 'arbitrating') {
      return { status: 'arbitrating', reason: '达到组级开放条件，第二层仲裁开放' };
    }
    return null;
  }
  // state.status === 'mediating'
  const layer1Frozen = state.tier1Status === 'completed';
  if (!layer1Frozen) {
    if (member.status !== 'joined' && member.status !== 'layer1_open') {
      return { status: 'layer1_open', reason: '第一层处理中' };
    }
    if (member.status === 'joined') return { status: 'layer1_open', reason: '第一层处理中' };
    return null;
  }
  // 第一层已冻结：按组门控决定 park/open/block
  const gate = gateDecisionTx(group, member, members, ts);
  if (gate.mode === 'open') {
    if (member.status === 'arbitrating') return null;
    // 组允许开放：执行原生第二层开放（条件更新保证只开放一次）
    const pkg = mediation.loadPackageTx(member.package_id);
    const opened = mediation.openLayer2NativeTx(pkg, ts);
    if (opened) {
      buildCrossPackageDisclosureTx(group, member, ts);
      return { status: 'arbitrating', reason: gate.reason || '达到组级开放条件，第二层仲裁开放' };
    }
    return null;
  }
  if (gate.mode === 'park') {
    if (member.status === 'parked') {
      return null;
    }
    return { status: 'parked', reason: gate.reason };
  }
  // block：第二层永不开放，第一层终局完成（包置 completed、第二层 skipped）
  return { status: 'arbitration_blocked', reason: gate.reason, block: true };
}

function applyMemberStatusTx(group, member, next, ctx, ts) {
  if (next === 'arbitration_blocked') {
    const pkg = mediation.loadPackageTx(member.package_id);
    const tier1 = db.prepare('SELECT * FROM mediation_tiers WHERE package_id = ? AND tier = 1').get(member.package_id);
    if (pkg.status === 'mediating' && tier1 && tier1.status === 'completed') {
      mediation.finalizeLayer1WithoutArbitrationTx(pkg, tier1, ts, { park: false, reason: ctx.reason });
    }
  }
  const isGateDecision = ['parked', 'arbitrating', 'arbitration_blocked', 'failed', 'cancelled', 'completed'].includes(next);
  const isFinished = ['arbitration_blocked', 'failed', 'cancelled', 'completed'].includes(next);
  db.prepare(`
    UPDATE case_group_members
    SET status = ?, gate_reason = ?,
        gate_decided_at = COALESCE(gate_decided_at, ?),
        finished_at = CASE WHEN ? THEN COALESCE(finished_at, ?) ELSE finished_at END
    WHERE id = ?
  `).run(next, ctx.reason || '', isGateDecision ? ts : null,
    isFinished ? 1 : 0, isFinished ? ts : null, member.id);

  if (next === 'arbitrating') {
    addCaseGroupEvent(group.receipt_no, 'review.caseGroup.member.arbitration.opened', {
      groupId: group.id, packageId: member.package_id, ordinal: member.ordinal,
    });
  } else if (next === 'parked') {
    addCaseGroupEvent(group.receipt_no, 'review.caseGroup.member.parked', {
      groupId: group.id, packageId: member.package_id, ordinal: member.ordinal, reason: ctx.reason,
    });
  } else if (next === 'arbitration_blocked') {
    addCaseGroupEvent(group.receipt_no, 'review.caseGroup.member.arbitration.blocked', {
      groupId: group.id, packageId: member.package_id, ordinal: member.ordinal, reason: ctx.reason,
    });
  } else if (next === 'failed' || next === 'cancelled') {
    addCaseGroupEvent(group.receipt_no, 'review.caseGroup.member.failed', {
      groupId: group.id, packageId: member.package_id, ordinal: member.ordinal, status: next, reason: ctx.reason,
    });
  }
  persistMemberResultTx(member.package_id);
}

// 成员结果快照：结果、冲突原因、处理顺序、邀请状态、倒计时（终局时固化）
function persistMemberResultTx(packageId) {
  const member = loadMemberByPackageTx(packageId)
    || db.prepare('SELECT * FROM case_group_members WHERE package_id = ? ORDER BY joined_at DESC LIMIT 1').get(packageId);
  if (!member) return;
  const group = loadGroupTx(member.group_id);
  const snapshot = JSON.parse(member.member_snapshot_json);
  const invites = db.prepare(`
    SELECT tier, status, used_at, revoked_at, expires_at FROM mediation_invitations
    WHERE package_id = ? ORDER BY tier, ordinal
  `).all(packageId);
  const tier2 = db.prepare('SELECT * FROM mediation_tiers WHERE package_id = ? AND tier = 2').get(packageId);
  const result = {
    status: member.status,
    ordinal: member.ordinal,
    gateReason: member.gate_reason,
    recordedAt: now(),
    invitationStatus: invites.map((invite) => ({
      tier: invite.tier,
      status: invite.status === 'active' && invite.expires_at <= now() ? 'expired' : invite.status,
      used: Boolean(invite.used_at),
      revoked: Boolean(invite.revoked_at),
    })),
    countdown: group && group.deadline_at ? {
      groupDeadlineAt: group.deadline_at,
      remainingMs: Math.max(0, group.deadline_at - now()),
    } : null,
    layer2: tier2 ? {
      status: tier2.status,
      deadlineAt: tier2.deadline_at,
      remainingMs: tier2.deadline_at ? Math.max(0, tier2.deadline_at - now()) : 0,
      timeoutFiredAt: tier2.timeout_fired_at,
      timeoutResult: tier2.timeout_result,
    } : null,
    frozenFieldKeys: snapshot.fields.filter((f) => f.tier === 1).map((f) => f.key),
  };
  db.prepare('UPDATE case_group_members SET result_json = ? WHERE id = ?')
    .run(JSON.stringify(result), member.id);
}

// 跨包摘要：成员开放第二层仲裁瞬间生成。严格只含其他成员包的聚合信息，
// 不含任何字段 key/原文/意见逐字内容/处理人身份；仅包含组白名单内的包。
function buildCrossPackageDisclosureTx(group, viewerMember, ts) {
  const allowed = new Set(JSON.parse(group.disclosures_json || '[]'));
  const members = loadMembersTx(group.id);
  const summaries = [];
  for (const member of members) {
    if (member.package_id === viewerMember.package_id) continue;
    if (!allowed.has(member.package_id)) continue;
    const state = mediation.layer1StateTx(member.package_id);
    const l1Tier = db.prepare('SELECT * FROM mediation_tiers WHERE package_id = ? AND tier = 1').get(member.package_id);
    const autoRejected = db.prepare(`
      SELECT COUNT(*) AS n FROM mediation_fields
      WHERE package_id = ? AND tier = 1 AND decided_by_policy = 'timeout_mediation' AND decision = 'rejected'
    `).get(member.package_id).n;
    // 只暴露聚合计数与状态，不暴露字段
    summaries.push({
      ordinal: member.ordinal,
      memberStatus: member.status,
      packageStatus: state ? state.status : 'unknown',
      layer1: {
        status: l1Tier ? l1Tier.status : 'unknown',
        rejectedCount: state ? state.rejectedCount : 0,
        autoRejectedCount: autoRejected,
      },
    });
  }
  const summary = {
    generatedAt: ts,
    batchId: group.batch_id,
    minCompletions: group.min_completions,
    viewerOrdinal: viewerMember.ordinal,
    // 显式声明：不含其他包字段与原文
    containsOtherPackageFields: false,
    otherPackages: summaries,
  };
  db.prepare(`
    INSERT INTO case_group_disclosures (id, group_id, viewer_package_id, summary_json, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(group_id, viewer_package_id) DO UPDATE SET summary_json = excluded.summary_json
  `).run(cryptoId(), group.id, viewerMember.package_id, JSON.stringify(summary), ts);
}

// ---------------------------------------------------------------------------
// 组终局：全部成员终局 → completed；fail 策略超时由 settle 直接置 failed
// ---------------------------------------------------------------------------
function maybeFinishGroupTx(groupId, ts) {
  const group = loadGroupTx(groupId);
  if (!group || group.status !== 'processing') return;
  const members = loadMembersTx(groupId);
  const terminal = new Set(['arbitration_blocked', 'completed', 'failed', 'cancelled']);
  if (members.length > 0 && members.every((member) => terminal.has(member.status))) {
    const failed = members.filter((member) => member.status === 'failed' || member.status === 'cancelled').length;
    const status = failed === members.length && group.timeout_fired_at && group.timeout_policy === 'fail'
      ? 'failed'
      : 'completed';
    db.prepare(`
      UPDATE case_groups SET status = ?, completed_at = COALESCE(completed_at, ?) WHERE id = ?
    `).run(status, ts, groupId);
    // 组终结：成员 open_group_id 清空（历史行保留），包此后可以加入其他案件组
    db.prepare('UPDATE case_group_members SET open_group_id = NULL WHERE group_id = ?').run(groupId);
    addCaseGroupEvent(group.receipt_no, 'review.caseGroup.completed', {
      groupId, status,
      results: members.map((member) => ({ packageId: member.package_id, status: member.status, ordinal: member.ordinal })),
    });
  }
}

// ---------------------------------------------------------------------------
// 组级超时落定：timeout_fired_at IS NULL 条件更新为唯一判定，重复扫描不产生第二份结果
// ---------------------------------------------------------------------------
function settleCaseGroupTimeoutTx(group) {
  if (!group) return false;
  if (group.status !== 'processing') return false;
  if (!group.deadline_at || group.deadline_at > now()) return false;
  if (group.timeout_fired_at) return false;
  const ts = now();
  const fired = db.prepare(`
    UPDATE case_groups SET timeout_fired_at = ?, timeout_result = ?
    WHERE id = ? AND timeout_fired_at IS NULL AND status = 'processing'
  `).run(ts, group.timeout_policy, group.id);
  if (fired.changes === 0) return false;

  addCaseGroupEvent(group.receipt_no, 'review.caseGroup.timeout', {
    groupId: group.id, policy: group.timeout_policy,
  });

  if (group.timeout_policy === 'fail') {
    // fail：尚未进入第二层仲裁的成员包全部强制失败终结；已在仲裁中的包继续走完
    const members = loadMembersTx(group.id);
    for (const member of members) {
      if (['arbitrating', 'completed', 'failed', 'cancelled', 'arbitration_blocked'].includes(member.status)) {
        continue;
      }
      const pkg = mediation.loadPackageTx(member.package_id);
      if (pkg && pkg.status === 'mediating') {
        mediation.forceFinishPackageByGroupTx(pkg, ts, { packageStatus: 'failed', reason: '组级 fail 超时' });
      }
      db.prepare(`
        UPDATE case_group_members
        SET status = 'failed', gate_reason = '案件组按 fail 策略超时失败',
            gate_decided_at = COALESCE(gate_decided_at, ?), finished_at = COALESCE(finished_at, ?)
        WHERE id = ? AND status NOT IN ('arbitrating', 'completed', 'failed', 'cancelled', 'arbitration_blocked')
      `).run(ts, ts, member.id);
      persistMemberResultTx(member.package_id);
      addCaseGroupEvent(group.receipt_no, 'review.caseGroup.member.failed', {
        groupId: group.id, packageId: member.package_id, ordinal: member.ordinal,
        status: 'failed', reason: '案件组按 fail 策略超时失败',
      });
    }
    db.prepare("UPDATE case_groups SET status = 'failed', completed_at = ? WHERE id = ?").run(ts, group.id);
    db.prepare('UPDATE case_group_members SET open_group_id = NULL WHERE group_id = ?').run(group.id);
    addCaseGroupEvent(group.receipt_no, 'review.caseGroup.failed', { groupId: group.id, policy: 'fail' });
    return true;
  }
  // block_remaining：组级限时到达，尚未进入第二层仲裁的成员一律阻止第二层。
  // 第一层仍 active 的成员先按冻结策略把第一层终局（未决字段自动驳回留档），
  // 再由同步循环置为 arbitration_blocked；已在仲裁中的成员继续，全部终局后组完成。
  const membersToBlock = loadMembersTx(group.id).filter(
    (member) => !['arbitrating', 'completed', 'failed', 'cancelled', 'arbitration_blocked'].includes(member.status),
  );
  for (const member of membersToBlock) {
    const pkg = mediation.loadPackageTx(member.package_id);
    if (pkg && pkg.status === 'mediating') {
      const tier1 = db.prepare('SELECT * FROM mediation_tiers WHERE package_id = ? AND tier = 1').get(member.package_id);
      if (tier1 && tier1.status === 'active') {
        mediation.finalizeLayer1WithoutArbitrationTx(pkg, tier1, ts, {
          park: false,
          reason: '案件组限时到达：未达到组级开放条件，第二层仲裁不开放',
        });
      }
    }
    db.prepare(`
      UPDATE case_group_members
      SET status = 'arbitration_blocked',
          gate_reason = '案件组限时到达：未达到组级开放条件，第二层仲裁不开放',
          gate_decided_at = COALESCE(gate_decided_at, ?),
          finished_at = COALESCE(finished_at, ?)
      WHERE id = ? AND status NOT IN ('arbitrating', 'completed', 'failed', 'cancelled', 'arbitration_blocked')
    `).run(ts, ts, member.id);
    persistMemberResultTx(member.package_id);
    addCaseGroupEvent(group.receipt_no, 'review.caseGroup.member.arbitration.blocked', {
      groupId: group.id, packageId: member.package_id, ordinal: member.ordinal, timedOut: true,
    });
  }
  syncMembershipTx(group.id, ts);
  return true;
}

export function sweepCaseGroupTimeouts() {
  const rows = db.prepare(`
    SELECT * FROM case_groups
    WHERE status = 'processing' AND deadline_at IS NOT NULL AND deadline_at <= ?
      AND timeout_fired_at IS NULL
  `).all(now());
  let changed = 0;
  for (const group of rows) {
    const did = immediateTransaction(() => settleCaseGroupTimeoutTx(group));
    if (did) changed += 1;
    // 即便超时已在更早落定，也顺带同步一次成员推进（幂等）
    immediateTransaction(() => syncMembershipTx(group.id, now()));
  }
  // 恢复扫描：服务重启后把进行中组的成员状态按冻结规则对齐（幂等）
  const processing = db.prepare("SELECT id FROM case_groups WHERE status = 'processing'").all();
  for (const row of processing) {
    immediateTransaction(() => syncMembershipTx(row.id, now()));
  }
  return changed;
}

// 启动恢复：对齐全部进行中/收集中组（幂等）
export function recoverCaseGroupsOnStartup() {
  const rows = db.prepare("SELECT id FROM case_groups WHERE status IN ('processing', 'collecting')").all();
  for (const row of rows) {
    try {
      immediateTransaction(() => {
        settleCaseGroupTimeoutTx(loadGroupTx(row.id));
        syncMembershipTx(row.id, now());
      });
    } catch {
      /* 单组恢复失败不阻塞启动 */
    }
  }
}

// ---------------------------------------------------------------------------
// 视图
// ---------------------------------------------------------------------------
function memberOwnerView(member) {
  const snapshot = JSON.parse(member.member_snapshot_json);
  const result = member.result_json && member.result_json !== '{}' ? JSON.parse(member.result_json) : null;
  const state = mediation.layer1StateTx(member.package_id);
  return {
    id: member.id,
    packageId: member.package_id,
    roundId: member.round_id,
    batchId: member.batch_id,
    receiptNo: member.receipt_no,
    ordinal: member.ordinal,
    status: member.status,
    gateReason: member.gate_reason || '',
    joinedAt: member.joined_at,
    gateDecidedAt: member.gate_decided_at || null,
    finishedAt: member.finished_at || null,
    frozenFieldKeys: snapshot.fields.filter((f) => f.tier === 1).map((f) => f.key),
    packageStatus: state ? state.status : null,
    layer1Status: state ? state.tier1Status : null,
    layer2Status: state ? state.tier2Status : null,
    liveInvitationStatus: snapshot.invitations.map((invite) => ({
      tier: invite.tier,
      ordinal: invite.ordinal,
      label: invite.label,
      used: invite.used,
      revoked: invite.revoked,
    })),
    result,
  };
}

function groupOwnerView(row, { withSnapshot = true, withMembers = true } = {}) {
  const ts = now();
  const members = withMembers ? loadMembersTx(row.id).map(memberOwnerView) : [];
  const rejections = db.prepare(`
    SELECT id, package_id, round_id, reason_code, reason_detail, created_at
    FROM case_group_rejections WHERE group_id = ? ORDER BY created_at ASC
  `).all(row.id);
  const events = db.prepare(`
    SELECT type, detail_json, created_at FROM events
    WHERE workflow_id = ? AND json_extract(detail_json, '$.groupId') = ?
    ORDER BY id ASC
  `).all(row.workflow_id, row.id).map((event) => ({
    type: event.type,
    at: event.created_at,
    detail: JSON.parse(event.detail_json),
  }));
  return {
    id: row.id,
    batchId: row.batch_id,
    receiptNo: row.receipt_no,
    status: row.status,
    note: row.note || '',
    minCompletions: row.min_completions,
    memberOrder: JSON.parse(row.member_order_json || '[]'),
    timeoutPolicy: row.timeout_policy,
    disclosedPackageIds: JSON.parse(row.disclosures_json || '[]'),
    config: row.config_json ? JSON.parse(row.config_json) : {},
    frozenSnapshot: withSnapshot ? JSON.parse(row.frozen_snapshot_json || '{}') : null,
    createdAt: row.created_at,
    configuredAt: row.configured_at || null,
    startedAt: row.started_at || null,
    deadlineAt: row.deadline_at || null,
    remainingMs: row.status === 'processing' && row.deadline_at ? Math.max(0, row.deadline_at - ts) : 0,
    completedAt: row.completed_at || null,
    cancelledAt: row.cancelled_at || null,
    cancelReason: row.cancel_reason || '',
    timeoutFiredAt: row.timeout_fired_at || null,
    timeoutResult: row.timeout_result || '',
    members,
    rejections: rejections.map((item) => ({
      id: item.id,
      packageId: item.package_id,
      roundId: item.round_id,
      reasonCode: item.reason_code,
      reasonDetail: item.reason_detail,
      at: item.created_at,
    })),
    events,
  };
}

function getCaseGroupForOwnerTx(groupId, userId) {
  const row = db.prepare('SELECT * FROM case_groups WHERE id = ? AND user_id = ?').get(groupId, userId);
  return row ? groupOwnerView(row) : null;
}

export function getCaseGroupForOwner({ userId, groupId }) {
  return immediateTransaction(() => {
    settleCaseGroupTimeoutTx(loadGroupTx(groupId));
    syncMembershipTx(groupId, now());
    return getCaseGroupForOwnerTx(groupId, userId);
  });
}

export function listCaseGroupsForOwner(userId, { batchId = '', receiptNo = '' } = {}) {
  let rows = db.prepare('SELECT * FROM case_groups WHERE user_id = ? ORDER BY created_at ASC').all(userId);
  if (batchId) rows = rows.filter((row) => row.batch_id === batchId);
  if (receiptNo) rows = rows.filter((row) => row.receipt_no === receiptNo);
  return rows.map((row) => groupOwnerView(row, { withSnapshot: false, withMembers: false }));
}

// 可加入案件组的候选调解包：同一原批次、第一层处理中、无终局决议、不在未终结组中
export function listGroupablePackages({ userId, groupId }) {
  return immediateTransaction(() => {
    const group = loadGroupTx(groupId);
    if (!group || group.user_id !== userId) return null;
    const existing = new Set(loadMembersTx(groupId).map((member) => member.package_id));
    const packages = db.prepare(`
      SELECT * FROM mediation_packages
      WHERE user_id = ? AND batch_id = ? AND status = 'mediating'
      ORDER BY created_at ASC
    `).all(userId, group.batch_id);
    return {
      groupId,
      batchId: group.batch_id,
      candidates: packages.map((pkg) => {
        const layer1 = mediation.layer1StateTx(pkg.id);
        const occupied = db.prepare(`
          SELECT open_group_id FROM case_group_members WHERE package_id = ?
          ORDER BY joined_at DESC LIMIT 1
        `).get(pkg.id);
        const decided = db.prepare(`
          SELECT COUNT(*) AS n FROM mediation_fields WHERE package_id = ? AND tier = 1 AND decision IS NOT NULL
        `).get(pkg.id).n;
        const openCorrection = db.prepare(`
          SELECT COUNT(*) AS n FROM mediation_corrections WHERE package_id = ? AND completed_at IS NULL
        `).get(pkg.id).n;
        let eligible = true;
        let reasonCode = '';
        if (existing.has(pkg.id)) { eligible = false; reasonCode = 'ALREADY_MEMBER'; }
        else if (occupied?.open_group_id) { eligible = false; reasonCode = 'CASE_PACKAGE_ALREADY_IN_GROUP'; }
        else if (!layer1 || layer1.tier1Status !== 'active' || layer1.tier2Status !== 'pending' || decided > 0) {
          eligible = false; reasonCode = 'CASE_PACKAGE_STATUS_CONFLICT';
        } else if (openCorrection > 0) {
          eligible = false; reasonCode = 'CASE_PACKAGE_CORRECTION_CONFLICT';
        }
        return {
          packageId: pkg.id,
          roundId: pkg.round_id,
          status: pkg.status,
          createdAt: pkg.created_at,
          eligible,
          reasonCode,
        };
      }),
    };
  });
}

// ---------------------------------------------------------------------------
// 仲裁人跨包摘要：只返回组级允许披露的、已脱敏且不含其他包原文的关联摘要
// ---------------------------------------------------------------------------
export function getCrossPackageDisclosureForSession(packageId) {
  const row = db.prepare(`
    SELECT * FROM case_group_disclosures WHERE viewer_package_id = ?
  `).get(packageId);
  return row ? JSON.parse(row.summary_json) : null;
}

export function getCaseGroupMemberInfo(packageId) {
  const member = db.prepare(`
    SELECT * FROM case_group_members
    WHERE package_id = ? AND open_group_id IS NOT NULL
    ORDER BY joined_at DESC LIMIT 1
  `).get(packageId);
  if (!member) return null;
  const group = loadGroupTx(member.group_id);
  if (!group) return null;
  return {
    groupId: group.id,
    status: group.status,
    memberStatus: member.status,
    ordinal: member.ordinal,
    minCompletions: group.min_completions,
    gateReason: member.gate_reason || '',
  };
}

// ---------------------------------------------------------------------------
// 时间线条目（办理人）
// ---------------------------------------------------------------------------
export function buildCaseGroupTimelineEntries(userId) {
  const groups = db.prepare('SELECT * FROM case_groups WHERE user_id = ? ORDER BY created_at ASC, rowid ASC').all(userId);
  return groups.map((row) => groupOwnerView(row));
}

// 完成注入：mediationStore 的钩子指向本模块实现
bindMediationGroupGate(mediationGroupGate);
bindMediationGroupSync(mediationGroupSync);
bindMediationCrossPackageDisclosure(getCrossPackageDisclosureForSession);
bindCaseGroupMemberInfoHook(getCaseGroupMemberInfo);
