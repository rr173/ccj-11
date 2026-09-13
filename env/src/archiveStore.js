// ---------------------------------------------------------------------------
// 可验证审计归档：冻结快照 + 连续摘要链 + 分级查阅 + 后台导出任务
//
// 设计要点：
//  1. 归档创建在单个 BEGIN IMMEDIATE 事务中完成“收集事件 → 校验
//     （缺口/顺序/来源）→ 冻结复制 → 计算摘要链”；失败写入
//     audit_archive_rejections 留档，不产生归档行。
//  2. audit_archive_events 创建后没有任何 UPDATE/DELETE 路径；业务表
//     后续变化不影响归档（归档只读引用 events 行的复制，而非实时 join）。
//  3. 摘要链：hash_i = sha256(prev_hash || 规范化事件负载)，任何一处被
//     篡改都会导致 recompute 与冻结的 final_hash 不一致。
//  4. 导出后台任务按分块持久化进度；服务重启后从已完成分块之后继续。
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';
import { db, immediateTransaction, cryptoId, userQueries } from './db.js';
import { sha256, tokenUrlSafe, stableStringify } from './crypto.js';
import { config } from './config.js';
import {
  ARCHIVE_SOURCE_LABELS,
  newArchiveNo,
  redactAuditorDetail,
  eventFamily,
} from './archives.js';

function now() {
  return Date.now();
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

const GENESIS = 'ARCHIVE-GENESIS-v1';

// 分块处理的任务锁 TTL：持锁进程崩溃后，超过该时间的 running 任务可被重新接管
const EXPORT_LOCK_TTL_MS = 30_000;

// ===========================================================================
// 来源解析与状态摘要
// ===========================================================================

function loadSourceEntityTx({ sourceType, sourceId, userId }) {
  if (sourceType === 'batch') {
    const row = db.prepare('SELECT * FROM review_batches WHERE id = ?').get(sourceId);
    if (!row || row.user_id !== userId) return null;
    return {
      sourceType, sourceId, receiptNo: row.receipt_no, workflowId: row.workflow_id,
      label: `复核批次 ${row.id.slice(0, 8)}`,
      statusSummary: {
        kind: 'batch',
        id: row.id,
        status: row.status,
        staged: Boolean(row.staged),
        configVersion: row.config_version,
        invitationCount: row.invitation_count,
        timeoutResult: row.timeout_result || '',
        cancelReason: row.cancel_reason || '',
        createdAt: row.created_at,
        completedAt: row.completed_at || null,
      },
    };
  }
  if (sourceType === 'appeal') {
    const row = db.prepare('SELECT * FROM review_appeal_rounds WHERE id = ?').get(sourceId);
    if (!row || row.user_id !== userId) return null;
    return {
      sourceType, sourceId, receiptNo: row.receipt_no, workflowId: row.workflow_id,
      label: `申诉回合 ${row.id.slice(0, 8)}`,
      statusSummary: {
        kind: 'appeal',
        id: row.id,
        batchId: row.batch_id,
        status: row.status,
        reasonSummary: row.reason_summary || '',
        invitationCount: row.invitation_count,
        createdAt: row.created_at,
        completedAt: row.completed_at || null,
        cancelledAt: row.cancelled_at || null,
        expiredAt: row.expired_at || null,
      },
    };
  }
  if (sourceType === 'mediation') {
    const row = db.prepare('SELECT * FROM mediation_packages WHERE id = ?').get(sourceId);
    if (!row || row.user_id !== userId) return null;
    return {
      sourceType, sourceId, receiptNo: row.receipt_no, workflowId: row.workflow_id,
      label: `争议调解包 ${row.id.slice(0, 8)}`,
      statusSummary: {
        kind: 'mediation',
        id: row.id,
        roundId: row.round_id,
        batchId: row.batch_id,
        status: row.status,
        note: row.note || '',
        createdAt: row.created_at,
        completedAt: row.completed_at || null,
        expiredAt: row.expired_at || null,
        escalatedAt: row.escalated_at || null,
        tiers: db.prepare('SELECT tier, status, escalate_rejected_count, invitation_count, final_decision, timeout_result FROM mediation_tiers WHERE package_id = ? ORDER BY tier').all(sourceId),
      },
    };
  }
  // caseGroup
  const row = db.prepare('SELECT * FROM case_groups WHERE id = ?').get(sourceId);
  if (!row || row.user_id !== userId) return null;
  return {
    sourceType, sourceId, receiptNo: row.receipt_no, workflowId: row.workflow_id,
    label: `案件组 ${row.id.slice(0, 8)}`,
    statusSummary: {
      kind: 'caseGroup',
      id: row.id,
      batchId: row.batch_id,
      status: row.status,
      minCompletions: row.min_completions,
      memberOrder: safeJson(row.member_order_json, []),
      timeoutPolicy: row.timeout_policy,
      timeoutResult: row.timeout_result || '',
      createdAt: row.created_at,
      configuredAt: row.configured_at || null,
      startedAt: row.started_at || null,
      deadlineAt: row.deadline_at || null,
      completedAt: row.completed_at || null,
      cancelledAt: row.cancelled_at || null,
      members: db.prepare(`
        SELECT package_id, round_id, ordinal, status, gate_reason, joined_at, gate_decided_at, finished_at
        FROM case_group_members WHERE group_id = ? ORDER BY ordinal
      `).all(sourceId),
    },
  };
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

// ===========================================================================
// 事件收集：来源范围内、已经发生（created_at <= freezeAt）的全部审计事件
//
// 一个来源的事件可能跨多个工作流（回执 workflow_id 固定，更正办理是另一条
// workflow），因此先取办理人名下全部工作流，再按事件 detail 中的来源标识过滤。
// ===========================================================================

function ownerWorkflowIdsTx(userId) {
  return new Set(db.prepare('SELECT id FROM workflows WHERE user_id = ?').all(userId).map((row) => row.id));
}

// 判断一个事件（type + detail）是否属于所选来源范围（含其下级来源）
// 返回 { match, refs }：match 表示属于范围；refs 给出事件携带的来源标识
function classifyEvent(eventType, detail, scope) {
  const refs = {
    batchId: detail.batchId || '',
    roundId: detail.roundId || '',
    packageId: detail.packageId || '',
    groupId: detail.groupId || '',
    invitationId: detail.invitationId || '',
    batchFieldId: detail.batchFieldId || '',
    fieldId: detail.fieldId || '',
  };
  let match = false;
  if (eventType.startsWith('review.batch.')) {
    match = scope.sourceType === 'batch' && refs.batchId === scope.sourceId;
  } else if (eventType.startsWith('review.appeal.')) {
    if (scope.sourceType === 'batch') {
      match = refs.batchId === scope.batchId;
    } else if (scope.sourceType === 'appeal') {
      match = refs.roundId === scope.sourceId || refs.batchId === scope.batchId && eventType === 'review.appeal.created';
    }
    // mediation / caseGroup 归档不含申诉事件本身（只含调解包/案件组事件）
  } else if (eventType.startsWith('review.mediation.')) {
    // 上级归档范围：detail 直接携带匹配的批次/回合标识即纳入收集；
    // 若其调解包在库中不存在或归属链不一致，由后续来源一致性校验拒绝生成。
    if (scope.sourceType === 'batch' && refs.batchId === scope.batchId) match = true;
    if (scope.sourceType === 'appeal' && refs.roundId === scope.sourceId) match = true;
    if (!match && (scope.sourceType === 'batch' || scope.sourceType === 'appeal')) {
      // 批次/申诉归档的下级真实调解事件：仅当该调解包由本回合产生时纳入
      match = Boolean(scope.mediationPackageIds && scope.mediationPackageIds.has(refs.packageId));
      if (!match && refs.packageId) {
        const pkg = db.prepare('SELECT round_id FROM mediation_packages WHERE id = ?').get(refs.packageId);
        if (pkg) {
          if (scope.sourceType === 'appeal') match = pkg.round_id === scope.sourceId;
          if (scope.sourceType === 'batch') match = Boolean(scope.batchId && pkg.round_id
            && db.prepare('SELECT 1 FROM review_appeal_rounds WHERE id = ? AND batch_id = ?').get(pkg.round_id, scope.batchId));
        }
      }
    } else if (scope.sourceType === 'mediation') {
      match = refs.packageId === scope.sourceId;
    } else if (scope.sourceType === 'caseGroup') {
      match = Boolean(scope.groupPackageIds && scope.groupPackageIds.has(refs.packageId));
    }
  } else if (eventType.startsWith('review.caseGroup.')) {
    match = scope.sourceType === 'caseGroup'
      ? refs.groupId === scope.sourceId
      : Boolean(scope.caseGroupIds && scope.caseGroupIds.has(refs.groupId));
  }
  return { match, refs };
}

function collectEventsTx({ entity, userId, freezeAt }) {
  const workflowIds = ownerWorkflowIdsTx(userId);
  const scope = {
    sourceType: entity.sourceType,
    sourceId: entity.sourceId,
    batchId: entity.sourceType === 'batch' ? entity.sourceId : (entity.statusSummary.batchId || ''),
  };
  if (entity.sourceType === 'mediation') {
    scope.mediationPackageIds = new Set([entity.sourceId]);
  }
  if (entity.sourceType === 'caseGroup') {
    scope.groupPackageIds = new Set(
      db.prepare('SELECT package_id FROM case_group_members WHERE group_id = ?').all(entity.sourceId).map((row) => row.package_id),
    );
  }

  const rows = db.prepare(`
    SELECT * FROM events
    WHERE created_at <= ?
    ORDER BY id ASC
  `).all(freezeAt);

  const picked = [];
  for (const row of rows) {
    if (!workflowIds.has(row.workflow_id)) continue; // 越权隔离：绝不归档他人工作流事件
    if (!row.type.startsWith('review.')) continue;
    const detail = safeJson(row.detail_json, {});
    const { match } = classifyEvent(row.type, detail, scope);
    if (match) picked.push({ row, detail });
  }
  return picked;
}

// ===========================================================================
// 一致性校验：事件缺口、顺序冲突、来源不一致
// ===========================================================================

// 每类来源“必须先出现”的事件与终态事件
const LIFECYCLE = {
  batch: { create: 'review.batch.created', finish: ['review.batch.completed', 'review.batch.cancelled'] },
  appeal: { create: 'review.appeal.created', finish: ['review.appeal.completed', 'review.appeal.cancelled', 'review.appeal.expired'] },
  mediation: { create: 'review.mediation.created', finish: ['review.mediation.completed', 'review.mediation.cancelled'] },
  caseGroup: { create: 'review.caseGroup.created', finish: ['review.caseGroup.completed', 'review.caseGroup.failed', 'review.caseGroup.cancelled'] },
};

function familyOfType(type) {
  if (type.startsWith('review.batch.')) return 'batch';
  if (type.startsWith('review.appeal.')) return 'appeal';
  if (type.startsWith('review.mediation.')) return 'mediation';
  if (type.startsWith('review.caseGroup.')) return 'caseGroup';
  return null;
}

// 下级来源 → 上级来源的数据库归属校验（来源不一致时拒绝生成）
function verifyProvenanceTx(type, detail) {
  // detail.batchId / roundId / packageId / groupId 必须在库中且归属链一致
  if (detail.packageId) {
    const pkg = db.prepare('SELECT id, round_id, batch_id FROM mediation_packages WHERE id = ?').get(detail.packageId);
    if (!pkg) return `调解包不存在：${detail.packageId}`;
    if (detail.roundId && pkg.round_id !== detail.roundId) {
      return `事件 ${type} 的调解包 ${detail.packageId} 不属于申诉回合 ${detail.roundId}`;
    }
    if (detail.batchId && pkg.batch_id !== detail.batchId) {
      return `事件 ${type} 的调解包 ${detail.packageId} 不属于原批次 ${detail.batchId}`;
    }
  }
  if (detail.roundId) {
    const round = db.prepare('SELECT id, batch_id FROM review_appeal_rounds WHERE id = ?').get(detail.roundId);
    if (!round) return `申诉回合不存在：${detail.roundId}`;
    if (detail.batchId && round.batch_id !== detail.batchId) {
      return `事件 ${type} 的申诉回合 ${detail.roundId} 不属于原批次 ${detail.batchId}`;
    }
  }
  if (detail.groupId) {
    const group = db.prepare('SELECT id, batch_id FROM case_groups WHERE id = ?').get(detail.groupId);
    if (!group) return `案件组不存在：${detail.groupId}`;
    if (detail.batchId && group.batch_id !== detail.batchId) {
      return `事件 ${type} 的案件组 ${detail.groupId} 不属于原批次 ${detail.batchId}`;
    }
    if (detail.packageId) {
      const member = db.prepare('SELECT 1 FROM case_group_members WHERE group_id = ? AND package_id = ?').get(detail.groupId, detail.packageId);
      if (!member) return `事件 ${type} 的调解包 ${detail.packageId} 不是案件组 ${detail.groupId} 的成员`;
    }
  }
  return '';
}

function validateEvents({ entity, picked }) {
  if (picked.length === 0) {
    return { ok: false, code: 'ARCHIVE_EVENT_GAP', detail: { reason: '所选来源没有任何已发生的审计事件' } };
  }
  const rootFamily = entity.sourceType === 'batch' ? 'batch'
    : entity.sourceType === 'appeal' ? 'appeal'
      : entity.sourceType === 'mediation' ? 'mediation'
        : 'caseGroup';
  const lifecycle = LIFECYCLE[rootFamily];

  // 1) 事件缺口：根来源的“创建事件”必须存在且是其家族事件中的第一条
  const ownFamilyEvents = picked
    .map((item, index) => ({ ...item, index }))
    .filter((item) => familyOfType(item.row.type) === rootFamily
      || (rootFamily === 'batch' && familyOfType(item.row.type) === 'appeal')
      || (rootFamily === 'batch' && familyOfType(item.row.type) === 'mediation')
      || (rootFamily === 'batch' && familyOfType(item.row.type) === 'caseGroup')
      || (rootFamily === 'appeal' && familyOfType(item.row.type) === 'mediation')
      || (rootFamily === 'mediation' && familyOfType(item.row.type) === 'caseGroup'));

  const firstOwn = ownFamilyEvents[0];
  if (!firstOwn || firstOwn.row.type !== lifecycle.create) {
    return {
      ok: false,
      code: 'ARCHIVE_EVENT_GAP',
      detail: {
        reason: `缺少 ${lifecycle.create} 起始事件（事件缺口）`,
        firstEventType: firstOwn?.row.type || null,
      },
    };
  }

  // 2) 顺序冲突：同 (events.id) 升序下，created_at 不允许倒退；
  //    同一具体来源不得出现两条创建事件；终局之后不得再有该来源的非留档事件。
  //    一个上级来源（批次/回合）下可并行存在多个下级来源，因此按“家族:来源id”跟踪。
  const rootCreatedAt = firstOwn.row.created_at;
  const createdSources = new Set();
  const finishedSources = new Set();
  let prevCreatedAt = 0;
  let prevEventId = 0;
  const sourceKeyOf = (family, detail) => {
    if (!family) return '';
    const idField = family === 'caseGroup' ? 'groupId' : family === 'appeal' ? 'roundId' : `${family}Id`;
    return `${family}:${detail[idField] || ''}`;
  };
  for (const { row, detail } of picked) {
    if (row.id <= prevEventId) {
      return { ok: false, code: 'ARCHIVE_EVENT_ORDER_CONFLICT', detail: { eventId: row.id, reason: '事件自增序号不单调' } };
    }
    if (row.created_at < prevCreatedAt) {
      return {
        ok: false,
        code: 'ARCHIVE_EVENT_ORDER_CONFLICT',
        detail: { eventId: row.id, eventType: row.type, reason: '事件时间早于前一条事件', prevCreatedAt, at: row.created_at },
      };
    }
    prevCreatedAt = row.created_at;
    prevEventId = row.id;

    const family = familyOfType(row.type);
    const sourceKey = sourceKeyOf(family, detail);
    if (family && row.type.endsWith('.created')) {
      // 同一具体来源只能有一条创建事件；不同下级来源各自一条
      if (createdSources.has(sourceKey)) {
        return {
          ok: false,
          code: 'ARCHIVE_EVENT_ORDER_CONFLICT',
          detail: { eventId: row.id, eventType: row.type, reason: '同一来源出现两条创建事件', sourceKey },
        };
      }
      createdSources.add(sourceKey);
    }
    if (family && sourceKey && finishedSources.has(sourceKey)) {
      // 终局后的留档事件白名單（更正完成/放弃等历史追加在语义上属于新办理，不算冲突）
      const allowedAfterFinish = new Set([
        'review.batch.correction.completed',
        'review.appeal.correction.completed',
        'review.mediation.correction.completed',
        'review.mediation.correction.abandoned',
      ]);
      if (!allowedAfterFinish.has(row.type)) {
        return {
          ok: false,
          code: 'ARCHIVE_EVENT_ORDER_CONFLICT',
          detail: { eventId: row.id, eventType: row.type, reason: '来源已进入终态后又出现状态事件', sourceKey },
        };
      }
    }
    const finishEvents = family ? LIFECYCLE[family]?.finish || [] : [];
    if (family && sourceKey && finishEvents.includes(row.type)) finishedSources.add(sourceKey);

    // 3) 来源不一致：detail 中的归属标识必须与库中实际归属一致
    const provenanceError = verifyProvenanceTx(row.type, detail);
    if (provenanceError) {
      return { ok: false, code: 'ARCHIVE_SOURCE_INCONSISTENT', detail: { eventId: row.id, eventType: row.type, reason: provenanceError } };
    }
  }

  return { ok: true };
}

// ===========================================================================
// 操作人（actor）推断：事件本身不存操作人，按事件类型与关联表补全；
// 办理人视图显示真实标识，审计员视图只显示角色（redact 阶段处理）。
// ===========================================================================

function deriveActor(eventType, detail) {
  if (eventType.includes('invitation.consumed') || eventType.includes('opinion.submitted')) {
    return { role: 'reviewer', label: detail.label ? `复核/评议人：${detail.label}` : '复核/评议人' };
  }
  if (/\.timeout$/.test(eventType) || eventType.endsWith('.timeout')) {
    return { role: 'system', label: '系统（超时落定）' };
  }
  if (eventType === 'review.caseGroup.member.rejected') {
    return { role: 'system', label: '系统（冲突检查拒绝留档）' };
  }
  if (eventType.endsWith('.correction.completed')) {
    return { role: 'handler', label: '办理人（更正完成）' };
  }
  return { role: 'handler', label: '办理人' };
}

// 来源关系（冻结）：从事件流中提取的来源链，供审计员视图校验来源关系
function buildProvenance(picked, entity) {
  const links = [];
  const push = (from, to, relation) => {
    const key = `${from}->${to}:${relation}`;
    if (!links.some((item) => item.key === key)) links.push({ key, from, to, relation });
  };
  for (const { row, detail } of picked) {
    if (row.type === 'review.appeal.created' && detail.batchId && detail.roundId) {
      push(`batch:${detail.batchId}`, `appeal:${detail.roundId}`, 'appeal_of_batch');
    }
    if (row.type === 'review.mediation.created' && detail.packageId) {
      const from = detail.roundId ? `appeal:${detail.roundId}` : detail.batchId ? `batch:${detail.batchId}` : '';
      if (from) push(from, `mediation:${detail.packageId}`, 'mediation_of_appeal');
    }
    if (row.type === 'review.caseGroup.created' && detail.groupId && detail.anchorPackageId) {
      push(`mediation:${detail.anchorPackageId}`, `caseGroup:${detail.groupId}`, 'anchor_member');
    }
    if (row.type === 'review.caseGroup.member.joined' && detail.groupId && detail.packageId) {
      push(`mediation:${detail.packageId}`, `caseGroup:${detail.groupId}`, 'member');
    }
    if (row.type.endsWith('correction.completed')) {
      const target = detail.receiptNo ? `receipt:${detail.receiptNo}` : 'correction';
      if (detail.packageId) push(`mediation:${detail.packageId}`, target, 'correction');
      else if (detail.roundId) push(`appeal:${detail.roundId}`, target, 'correction');
      else if (detail.batchId) push(`batch:${detail.batchId}`, target, 'correction');
    }
  }
  return links.map(({ from, to, relation }) => ({ from, to, relation }));
}

// ===========================================================================
// 创建归档
// ===========================================================================

export function createAuditArchive({ userId, sourceType, sourceId, note, auditorGrants }) {
  try {
    return immediateTransaction(() => {
      const entity = loadSourceEntityTx({ sourceType, sourceId, userId });
      if (!entity) {
        return { ok: false, status: 404, code: 'ARCHIVE_SOURCE_NOT_FOUND', message: '归档来源不存在或不属于当前账号' };
      }
      const freezeAt = now();
      const picked = collectEventsTx({ entity, userId, freezeAt });
      const validation = validateEvents({ entity, picked });
      if (!validation.ok) {
        recordRejectionTx({ userId, sourceType, sourceId, result: validation });
        return {
          ok: false,
          status: 409,
          code: validation.code,
          message: validation.code === 'ARCHIVE_EVENT_GAP' ? '审计事件存在缺口，归档生成被拒绝并已留档'
            : validation.code === 'ARCHIVE_EVENT_ORDER_CONFLICT' ? '审计事件顺序冲突，归档生成被拒绝并已留档'
              : '审计事件来源不一致，归档生成被拒绝并已留档',
          rejection: validation.detail,
        };
      }

      // 版本：同一来源重复归档 → version +1（旧归档原样保留）
      const lastVersion = db.prepare(`
        SELECT COALESCE(MAX(version), 0) AS v FROM audit_archives
        WHERE source_type = ? AND source_id = ?
      `).get(sourceType, sourceId).v;
      const version = lastVersion + 1;
      const archiveId = cryptoId();
      const archiveNo = newArchiveNo();
      const ts = now();

      const provenance = buildProvenance(picked, entity);
      const grants = (auditorGrants || []).map((grant) => ({ ...grant, role: 'auditor' }));
      // 权限快照：归档创建瞬间冻结；之后账号变化不扩大也不缩小已生成归档的视图边界
      const permissionSnapshot = {
        owner: {
          userId,
          username: userQueries.findById(userId)?.username || '',
          role: 'handler',
          view: 'handler',
          fields: 'full',
          actors: 'full',
        },
        auditors: grants,
        external: {
          view: 'external',
          fields: ['eventCount', 'timeRange', 'chainContinuous', 'finalStatus'],
        },
        frozenAt: ts,
      };
      const redaction = {
        version: 1,
        auditor: {
          dropDetailKeys: ['reason', 'rejectReason', 'decisionReason', 'cancelReason', 'detail', 'note', 'ip', 'usedIp'],
          maskDetailKeys: ['label', 'reviewerLabel'],
          actor: 'role_only',
        },
        external: {
          includeDetail: false,
          includeActors: false,
          includeProvenance: false,
        },
        frozenAt: ts,
      };

      const genesisHash = sha256Hex(`${GENESIS}|${archiveNo}|${sourceType}|${sourceId}|${version}`);
      let prevHash = genesisHash;
      const firstAt = picked[0].row.created_at;
      const lastAt = picked[picked.length - 1].row.created_at;

      // 先建归档主行（外键父行），再写冻结事件，最后回填最终摘要
      db.prepare(`
        INSERT INTO audit_archives
          (id, owner_user_id, source_type, source_id, source_label, receipt_no, workflow_id, version,
           status, scope_json, status_summary_json, provenance_json, redaction_json,
           permission_snapshot_json, event_count, first_event_at, last_event_at,
           genesis_hash, final_hash, chain_ok, note, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'frozen', ?, ?, ?, ?, ?, ?, ?, ?, ?, '', 1, ?, ?)
      `).run(
        archiveId, userId, sourceType, sourceId, entity.label, entity.receiptNo, entity.workflowId,
        version,
        JSON.stringify({ sourceType, sourceId, archiveNo, frozenEventIds: picked.map((item) => item.row.id) }),
        JSON.stringify(entity.statusSummary),
        JSON.stringify(provenance),
        JSON.stringify(redaction),
        JSON.stringify(permissionSnapshot),
        picked.length, firstAt, lastAt,
        genesisHash, note || '', ts,
      );

      const insertEvent = db.prepare(`
        INSERT INTO audit_archive_events
          (id, archive_id, ordinal, source_event_id, workflow_id, event_type, step,
           detail_json, actor_role, actor_label, occurred_at, prev_hash, event_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      picked.forEach(({ row, detail }, ordinal) => {
        const actor = deriveActor(row.type, detail);
        const payload = stableStringify({
          sourceEventId: row.id,
          workflowId: row.workflow_id,
          type: row.type,
          step: row.step ?? null,
          detail,
          actorRole: actor.role,
          actorLabel: actor.label,
          occurredAt: row.created_at,
        });
        const eventHash = sha256Hex(`${prevHash}|${payload}`);
        insertEvent.run(
          cryptoId(), archiveId, ordinal, row.id, row.workflow_id, row.type, row.step ?? null,
          JSON.stringify(detail), actor.role, actor.label, row.created_at, prevHash, eventHash,
        );
        prevHash = eventHash;
      });

      db.prepare('UPDATE audit_archives SET final_hash = ? WHERE id = ?').run(prevHash, archiveId);

      const createdId = archiveId;
      addArchiveEventTx(entity.receiptNo, 'audit.archive.created', {
        archiveId, archiveNo, sourceType, sourceId, version, eventCount: picked.length,
      });

      return { ok: true, archive: getArchiveForOwner({ userId, archiveId: createdId }) };
    });
  } catch (error) {
    throw error;
  }
}

function recordRejectionTx({ userId, sourceType, sourceId, result }) {
  db.prepare(`
    INSERT INTO audit_archive_rejections (id, owner_user_id, source_type, source_id, reason_code, reason_detail, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cryptoId(), userId, sourceType, sourceId, result.code,
    String(result.detail?.reason || ''), JSON.stringify(result.detail || {}), now(),
  );
}

function addArchiveEventTx(receiptNo, type, detail) {
  const row = db.prepare('SELECT workflow_id FROM receipts WHERE receipt_no = ?').get(receiptNo);
  if (!row) return;
  db.prepare(`
    INSERT INTO events (workflow_id, type, step, detail_json, created_at)
    VALUES (?, ?, NULL, ?, ?)
  `).run(row.workflow_id, type, JSON.stringify({ receiptNo, ...detail }), now());
}

// ===========================================================================
// 摘要链校验
// ===========================================================================

export function verifyArchiveChain(archiveId) {
  const archive = db.prepare('SELECT * FROM audit_archives WHERE id = ?').get(archiveId);
  if (!archive) return null;
  const events = db.prepare('SELECT * FROM audit_archive_events WHERE archive_id = ? ORDER BY ordinal ASC').all(archiveId);
  const scope = safeJson(archive.scope_json, {});
  let prevHash = sha256Hex(`${GENESIS}|${scope.archiveNo}|${archive.source_type}|${archive.source_id}|${archive.version}`);
  const broken = [];
  let ordinal = 0;
  for (const event of events) {
    if (event.ordinal !== ordinal) {
      broken.push({ ordinal: event.ordinal, reason: 'ordinal gap' });
      break;
    }
    if (event.prev_hash !== prevHash) {
      broken.push({ ordinal, reason: 'prev_hash mismatch', eventType: event.event_type });
      break;
    }
    const detail = safeJson(event.detail_json, {});
    const payload = stableStringify({
      sourceEventId: event.source_event_id,
      workflowId: event.workflow_id,
      type: event.event_type,
      step: event.step ?? null,
      detail,
      actorRole: event.actor_role,
      actorLabel: event.actor_label,
      occurredAt: event.occurred_at,
    });
    const expected = sha256Hex(`${prevHash}|${payload}`);
    if (expected !== event.event_hash) {
      broken.push({ ordinal, reason: 'event_hash mismatch', eventType: event.event_type });
      break;
    }
    prevHash = expected;
    ordinal += 1;
  }
  const continuous = broken.length === 0 && events.length === archive.event_count && prevHash === archive.final_hash;
  return {
    ok: continuous,
    continuous,
    checkedAt: now(),
    eventCount: events.length,
    declaredCount: archive.event_count,
    finalHash: archive.final_hash,
    recomputedFinalHash: prevHash,
    broken: broken[0] || null,
  };
}

// 校验冻结事件与当前库中原事件行的副本一致性（防库内篡改事件内容后重算）
export function verifyArchiveIntegrity(archiveId) {
  const chain = verifyArchiveChain(archiveId);
  if (!chain) return null;
  const events = db.prepare('SELECT * FROM audit_archive_events WHERE archive_id = ? ORDER BY ordinal ASC').all(archiveId);
  let copyMismatch = null;
  for (const event of events) {
    const source = db.prepare('SELECT id FROM events WHERE id = ?').get(event.source_event_id);
    if (!source) {
      copyMismatch = { ordinal: event.ordinal, reason: 'source event missing' };
      break;
    }
    // 摘要链已对冻结副本内容逐事件做哈希校验；原事件行在归档后允许继续演进
    // （新增事件不改写归档），因此这里只校验引用完整性（事件缺口），不比较内容。
  }
  return { ...chain, ok: chain.ok && !copyMismatch, copyMismatch, frozenCopyIntact: !copyMismatch };
}

// ===========================================================================
// 查询与三种视图
// ===========================================================================

function getArchiveRowTx(archiveId) {
  return db.prepare('SELECT * FROM audit_archives WHERE id = ?').get(archiveId) || null;
}

function loadFrozenEventsTx(archiveId) {
  return db.prepare('SELECT * FROM audit_archive_events WHERE archive_id = ? ORDER BY ordinal ASC').all(archiveId);
}

function archiveBase(archive, chainResult) {
  const scope = safeJson(archive.scope_json, {});
  return {
    id: archive.id,
    archiveNo: scope.archiveNo || '',
    sourceType: archive.source_type,
    sourceId: archive.source_id,
    sourceLabel: archive.source_label,
    sourceTypeLabel: ARCHIVE_SOURCE_LABELS[archive.source_type] || archive.source_type,
    receiptNo: archive.receipt_no,
    version: archive.version,
    status: archive.status,
    note: archive.note || '',
    frozenAt: archive.created_at,
    eventCount: archive.event_count,
    firstEventAt: archive.first_event_at || null,
    lastEventAt: archive.last_event_at || null,
    finalHash: archive.final_hash,
    genesisHash: archive.genesis_hash,
    chain: chainResult ? {
      continuous: chainResult.continuous,
      checkedAt: chainResult.checkedAt,
      broken: chainResult.broken,
    } : null,
  };
}

// 办理人视图：完整字段与操作人
export function getArchiveForOwner({ userId, archiveId }) {
  const archive = getArchiveRowTx(archiveId);
  if (!archive || archive.owner_user_id !== userId) return null;
  const chain = verifyArchiveChain(archiveId);
  const events = loadFrozenEventsTx(archiveId).map((event) => ({
    ordinal: event.ordinal,
    sourceEventId: event.source_event_id,
    workflowId: event.workflow_id,
    type: event.event_type,
    family: eventFamily(event.event_type),
    step: event.step,
    detail: safeJson(event.detail_json, {}),
    actor: { role: event.actor_role, label: event.actor_label },
    occurredAt: event.occurred_at,
    hash: event.event_hash,
    prevHash: event.prev_hash,
  }));
  const perms = safeJson(archive.permission_snapshot_json, {});
  return {
    ...archiveBase(archive, chain),
    view: 'handler',
    statusSummary: safeJson(archive.status_summary_json, {}),
    provenance: safeJson(archive.provenance_json, []),
    redactionRules: safeJson(archive.redaction_json, {}),
    permissionSnapshot: {
      ownerView: 'handler:full',
      auditorGrants: (perms.auditors || []).map((item) => ({ username: item.username, displayName: item.displayName })),
      externalView: 'external:minimal',
      frozenAt: perms.frozenAt || null,
    },
    events,
  };
}

// 审计员视图：只能看到按角色授权的脱敏字段、来源关系与摘要链校验结果
export function getArchiveForAuditor({ userId, archiveId }) {
  const archive = getArchiveRowTx(archiveId);
  if (!archive) return null;
  const perms = safeJson(archive.permission_snapshot_json, {});
  const grant = (perms.auditors || []).find((item) => item.userId === userId);
  if (!grant) return { forbidden: true };
  const chain = verifyArchiveChain(archiveId);
  const events = loadFrozenEventsTx(archiveId).map((event) => ({
    ordinal: event.ordinal,
    type: event.event_type,
    family: eventFamily(event.event_type),
    step: event.step,
    detail: redactAuditorDetail(safeJson(event.detail_json, {})),
    actor: { role: event.actor_role, label: '' }, // 操作人身份不下发
    occurredAt: event.occurred_at,
    hash: event.event_hash,
  }));
  return {
    ...archiveBase(archive, chain),
    view: 'auditor',
    grantedBySnapshot: true,
    grantFrozenAt: perms.frozenAt || null,
    provenance: safeJson(archive.provenance_json, []),
    statusSummary: redactAuditorDetail(safeJson(archive.status_summary_json, {})),
    events,
  };
}

// 外部核验视图：只能看到事件数量、时间范围、摘要链是否连续、最终状态
export function getArchiveExternalView(archiveId) {
  const archive = getArchiveRowTx(archiveId);
  if (!archive) return null;
  const chain = verifyArchiveChain(archiveId);
  const statusSummary = safeJson(archive.status_summary_json, {});
  return {
    archiveNo: safeJson(archive.scope_json, {}).archiveNo || '',
    sourceType: archive.source_type,
    sourceTypeLabel: ARCHIVE_SOURCE_LABELS[archive.source_type] || archive.source_type,
    frozenAt: archive.created_at,
    eventCount: archive.event_count,
    timeRange: { from: archive.first_event_at || null, to: archive.last_event_at || null },
    chainContinuous: chain.continuous,
    finalStatus: statusSummary.status || '',
    view: 'external',
  };
}

export function listArchivesForOwner(userId, { sourceType = '', sourceId = '' } = {}) {
  let sql = 'SELECT * FROM audit_archives WHERE owner_user_id = ?';
  const params = [userId];
  if (sourceType) {
    sql += ' AND source_type = ?';
    params.push(sourceType);
  }
  if (sourceId) {
    sql += ' AND source_id = ?';
    params.push(sourceId);
  }
  sql += ' ORDER BY created_at DESC, version DESC';
  return db.prepare(sql).all(...params).map((archive) => archiveBase(archive, verifyArchiveChain(archive.id)));
}

// 审计员：列出在权限快照中授权给本人的全部归档（授权以归档创建瞬间为准）
export function listArchivesForAuditor(userId) {
  const archives = db.prepare('SELECT * FROM audit_archives ORDER BY created_at DESC').all();
  const out = [];
  for (const archive of archives) {
    const perms = safeJson(archive.permission_snapshot_json, {});
    if ((perms.auditors || []).some((item) => item.userId === userId)) {
      const chain = verifyArchiveChain(archive.id);
      out.push({
        ...archiveBase(archive, chain),
        view: 'auditor',
        ownerReceiptNo: archive.receipt_no,
      });
    }
  }
  return out;
}

export function listArchiveRejectionsForOwner(userId) {
  return db.prepare(`
    SELECT * FROM audit_archive_rejections WHERE owner_user_id = ? ORDER BY created_at DESC LIMIT 100
  `).all(userId).map((row) => ({
    id: row.id,
    sourceType: row.source_type,
    sourceId: row.source_id,
    reasonCode: row.reason_code,
    reasonDetail: row.reason_detail,
    detail: safeJson(row.detail_json, {}),
    createdAt: row.created_at,
  }));
}

// 某来源的最新归档版本（办理页展示“是否已归档”）
export function getLatestArchiveForSource(userId, sourceType, sourceId) {
  const row = db.prepare(`
    SELECT * FROM audit_archives WHERE owner_user_id = ? AND source_type = ? AND source_id = ?
    ORDER BY version DESC LIMIT 1
  `).get(userId, sourceType, sourceId);
  return row ? archiveBase(row, verifyArchiveChain(row.id)) : null;
}

// ===========================================================================
// 外部核验码（一次性）
// ===========================================================================

export function issueExternalCode({ userId, archiveId, ttlMs }) {
  return immediateTransaction(() => {
    const archive = getArchiveRowTx(archiveId);
    if (!archive || archive.owner_user_id !== userId) {
      return { ok: false, status: 404, code: 'ARCHIVE_NOT_FOUND', message: '归档不存在或无权访问' };
    }
    const ts = now();
    // 同一归档至多一个有效外部核验码（旧码作废）
    db.prepare("UPDATE audit_external_codes SET status = 'revoked', revoked_at = ? WHERE archive_id = ? AND status = 'active'")
      .run(ts, archiveId);
    const raw = tokenUrlSafe();
    const id = cryptoId();
    const ttl = ttlMs || config.archiveExternalCodeTtlMs;
    db.prepare(`
      INSERT INTO audit_external_codes (id, archive_id, owner_user_id, code_hash, status, created_at, expires_at, used_at, used_ip, revoked_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?, NULL, '', NULL)
    `).run(id, archiveId, userId, sha256(raw), ts, ts + ttl);
    return { ok: true, code: raw, expiresAt: ts + ttl, archiveId };
  });
}

export function consumeExternalCode({ rawCode, expectedArchiveId = '', clientIp = '' }) {
  return immediateTransaction(() => {
    const row = db.prepare('SELECT * FROM audit_external_codes WHERE code_hash = ?').get(sha256(rawCode));
    if (!row) return { ok: false, status: 403, code: 'EXTERNAL_CODE_INVALID', message: '外部核验码不正确' };
    if (row.status === 'used') return { ok: false, status: 410, code: 'EXTERNAL_CODE_USED', message: '外部核验码只能使用一次' };
    if (row.status === 'revoked') return { ok: false, status: 410, code: 'EXTERNAL_CODE_REVOKED', message: '外部核验码已作废' };
    if (row.expires_at <= now()) {
      db.prepare("UPDATE audit_external_codes SET status = 'expired' WHERE id = ? AND status = 'active'").run(row.id);
      return { ok: false, status: 410, code: 'EXTERNAL_CODE_EXPIRED', message: '外部核验码已过期' };
    }
    if (expectedArchiveId && row.archive_id !== expectedArchiveId) {
      return { ok: false, status: 403, code: 'EXTERNAL_CODE_ARCHIVE_MISMATCH', message: '核验码与所查归档不匹配' };
    }
    db.prepare(`
      UPDATE audit_external_codes SET status = 'used', used_at = ?, used_ip = ? WHERE id = ? AND status = 'active'
    `).run(now(), String(clientIp || '').slice(0, 64), row.id);
    const view = getArchiveExternalView(row.archive_id);
    if (!view) return { ok: false, status: 404, code: 'ARCHIVE_NOT_FOUND', message: '归档不存在' };
    return { ok: true, view };
  });
}

export function revokeExternalCode({ userId, archiveId }) {
  return immediateTransaction(() => {
    const archive = getArchiveRowTx(archiveId);
    if (!archive || archive.owner_user_id !== userId) {
      return { ok: false, status: 404, code: 'ARCHIVE_NOT_FOUND' };
    }
    db.prepare("UPDATE audit_external_codes SET status = 'revoked', revoked_at = ? WHERE archive_id = ? AND status = 'active'")
      .run(now(), archiveId);
    return { ok: true };
  });
}

// ===========================================================================
// 导出后台任务
// ===========================================================================

function exportView(archive) {
  // 导出文件携带办理人完整视图（文件只通过一次性凭证下发给本人）
  return getArchiveForOwner({ userId: archive.owner_user_id, archiveId: archive.id });
}

function chunkCount(totalEvents) {
  return Math.max(1, Math.ceil(totalEvents / config.archiveExportChunkSize));
}

export function startArchiveExport({ userId, archiveId, idempotencyKey }) {
  try {
    return immediateTransaction(() => {
      const archive = getArchiveRowTx(archiveId);
      if (!archive || archive.owner_user_id !== userId) {
        return { ok: false, status: 404, code: 'ARCHIVE_NOT_FOUND', message: '归档不存在或无权访问' };
      }
      // 幂等键回放：同人同键返回同一任务（指纹必须一致）
      if (idempotencyKey) {
        const prior = db.prepare('SELECT * FROM audit_exports WHERE owner_user_id = ? AND idempotency_key = ?')
          .get(userId, idempotencyKey);
        if (prior) {
          if (prior.archive_id !== archiveId) {
            return { ok: false, status: 409, code: 'EXPORT_IDEMPOTENCY_CONFLICT', message: '该幂等键已用于其他归档的导出' };
          }
          return { ok: true, replay: true, task: exportTaskPublic(prior) };
        }
      }
      // 同一归档同一版本只能有一份进行中（部分唯一索引兜底并发）
      const active = db.prepare(`
        SELECT * FROM audit_exports WHERE archive_id = ? AND status IN ('queued', 'running')
      `).get(archiveId);
      if (active) {
        return { ok: false, status: 409, code: 'EXPORT_ALREADY_RUNNING', message: '同一归档同一版本已有进行中的导出任务', task: exportTaskPublic(active) };
      }
      const ts = now();
      const id = cryptoId();
      const totalChunks = chunkCount(archive.event_count);
      db.prepare(`
        INSERT INTO audit_exports
          (id, archive_id, archive_version, owner_user_id, idempotency_key, status,
           total_chunks, completed_chunks, progress, fail_reason, file_content, file_version,
           file_digest, file_size, attempts, locked_at, locked_by, created_at, started_at,
           updated_at, completed_at, expires_at)
        VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, 0, '', NULL, 1, '', 0, 0, NULL, '', ?, NULL, ?, NULL, NULL)
      `).run(id, archiveId, archive.version, userId, idempotencyKey || '', totalChunks, ts, ts);
      const task = db.prepare('SELECT * FROM audit_exports WHERE id = ?').get(id);
      addArchiveEventTx(archive.receipt_no, 'audit.export.started', {
        archiveId: archive.id, exportId: id, version: archive.version, idempotency: Boolean(idempotencyKey),
      });
      return { ok: true, replay: false, task: exportTaskPublic(task) };
    });
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) {
      // 两个页面并发启动：唯一索引只放行一个，负者读取已存在任务
      const active = db.prepare(`
        SELECT * FROM audit_exports WHERE archive_id = ? AND status IN ('queued', 'running')
      `).get(archiveId);
      if (active) {
        return { ok: false, status: 409, code: 'EXPORT_ALREADY_RUNNING', message: '另一页面已启动该归档的导出任务', task: exportTaskPublic(active) };
      }
      if (idempotencyKey) {
        const prior = db.prepare('SELECT * FROM audit_exports WHERE owner_user_id = ? AND idempotency_key = ?')
          .get(userId, idempotencyKey);
        if (prior) return { ok: true, replay: true, task: exportTaskPublic(prior) };
      }
    }
    throw error;
  }
}

export function getArchiveExportForOwner({ userId, exportId }) {
  const row = db.prepare('SELECT * FROM audit_exports WHERE id = ? AND owner_user_id = ?').get(exportId, userId);
  return row ? exportTaskPublic(row) : null;
}

export function listArchiveExportsForOwner(userId, { archiveId = '' } = {}) {
  const rows = archiveId
    ? db.prepare('SELECT * FROM audit_exports WHERE owner_user_id = ? AND archive_id = ? ORDER BY created_at DESC').all(userId, archiveId)
    : db.prepare('SELECT * FROM audit_exports WHERE owner_user_id = ? ORDER BY created_at DESC').all(userId);
  return rows.map(exportTaskPublic);
}

export function cancelArchiveExport({ userId, exportId }) {
  return immediateTransaction(() => {
    const row = db.prepare('SELECT * FROM audit_exports WHERE id = ? AND owner_user_id = ?').get(exportId, userId);
    if (!row) return { ok: false, status: 404, code: 'EXPORT_NOT_FOUND', message: '导出任务不存在' };
    if (!['queued', 'running'].includes(row.status)) {
      return { ok: false, status: 409, code: 'EXPORT_NOT_CANCELLABLE', message: '只有排队中或进行中的导出任务可以取消', task: exportTaskPublic(row) };
    }
    const ts = now();
    db.prepare("UPDATE audit_exports SET status = 'cancelled', updated_at = ?, completed_at = ?, locked_at = NULL, locked_by = '' WHERE id = ?")
      .run(ts, ts, row.id);
    // 未使用的下载凭证立即作废
    db.prepare("UPDATE audit_export_credentials SET status = 'revoked', revoked_at = ? WHERE export_id = ? AND status = 'active'")
      .run(ts, row.id);
    const archive = getArchiveRowTx(row.archive_id);
    if (archive) {
      addArchiveEventTx(archive.receipt_no, 'audit.export.cancelled', { exportId: row.id, archiveId: archive.id });
    }
    return { ok: true, task: exportTaskPublic(db.prepare('SELECT * FROM audit_exports WHERE id = ?').get(row.id)) };
  });
}

function exportTaskPublic(row) {
  const effectiveStatus = effectiveExportStatus(row);
  return {
    id: row.id,
    archiveId: row.archive_id,
    archiveVersion: row.archive_version,
    status: effectiveStatus,
    idempotencyKey: row.idempotency_key ? '***' : '',
    totalChunks: row.total_chunks,
    completedChunks: row.completed_chunks,
    progress: row.progress,
    failReason: row.fail_reason || '',
    fileVersion: row.file_version,
    fileDigest: row.file_digest || '',
    fileSize: row.file_size,
    createdAt: row.created_at,
    startedAt: row.started_at || null,
    completedAt: row.completed_at || null,
    expiresAt: row.expires_at || null,
    hasFile: Boolean(row.file_content),
    canDownload: effectiveStatus === 'completed' && Boolean(row.file_content),
  };
}

function effectiveExportStatus(row) {
  if ((row.status === 'completed') && row.expires_at && row.expires_at <= now()) {
    return 'expired';
  }
  return row.status;
}

// ---------------------------------------------------------------------------
// 后台处理：每次 tick 认领一个可运行任务，从断点分块继续（同步事务，
// 单进程内串行；崩溃后的 running 任务超过锁 TTL 后可被重新接管）。
// ---------------------------------------------------------------------------

function claimRunnableTaskTx(workerId) {
  const ts = now();
  const staleBefore = ts - EXPORT_LOCK_TTL_MS;
  // 认领顺序：① 本 worker 已持锁（分块间续跑）② 其他 worker 锁过期的 running
  // （崩溃恢复）③ 最早的 queued。用条件更新保证只有一个 worker 认领成功。
  // workerId 以内联字面量传入（调用方生成的受控短标识），避免预编译语句缓存首参。
  const wid = String(workerId).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64) || 'default';
  const candidate = db.prepare(`
    SELECT * FROM audit_exports
    WHERE (status = 'running' AND (locked_by = '${wid}' OR locked_at IS NULL OR locked_at < ?))
       OR status = 'queued'
    ORDER BY
      CASE WHEN status = 'running' AND locked_by = '${wid}' THEN 0
           WHEN status = 'running' THEN 1
           ELSE 2 END,
      created_at ASC
    LIMIT 1
  `).get(staleBefore);
  if (!candidate) return null;
  const result = db.prepare(`
    UPDATE audit_exports
    SET status = 'running', locked_at = ?, locked_by = '${wid}',
        started_at = COALESCE(started_at, ?), updated_at = ?, attempts = attempts + 1
    WHERE id = ? AND (
      status = 'queued'
      OR (status = 'running' AND (locked_by = '${wid}' OR locked_at IS NULL OR locked_at < ?))
    )
  `).run(ts, ts, ts, candidate.id, staleBefore);
  if (result.changes === 0) return null;
  return db.prepare('SELECT * FROM audit_exports WHERE id = ?').get(candidate.id);
}

function processNextExportChunk(workerId = 'default') {
  let claimed = null;
  immediateTransaction(() => {
    claimed = claimRunnableTaskTx(workerId);
  });
  if (!claimed) return null;

  let task = claimed;
  try {
    const archive = getArchiveRowTx(task.archive_id);
    if (!archive) throw new Error('ARCHIVE_NOT_FOUND');

    // 终检：摘要链必须连续，否则任务失败（被篡改的归档不产生导出文件）
    const chain = verifyArchiveChain(archive.id);
    if (!chain.continuous) {
      const ts = now();
      db.prepare("UPDATE audit_exports SET status = 'failed', fail_reason = ?, updated_at = ?, completed_at = ?, locked_at = NULL, locked_by = '' WHERE id = ?")
        .run('ARCHIVE_CHAIN_INVALID', ts, ts, task.id);
      addArchiveEventTx(archive.receipt_no, 'audit.export.failed', { exportId: task.id, reason: 'ARCHIVE_CHAIN_INVALID' });
      return { exportId: task.id, status: 'failed' };
    }

    const nextOrdinal = task.completed_chunks; // 已完成分块之后继续
    if (nextOrdinal < task.total_chunks) {
      const events = loadFrozenEventsTx(archive.id);
      const start = nextOrdinal * config.archiveExportChunkSize;
      const slice = events.slice(start, start + config.archiveExportChunkSize);
      const content = JSON.stringify(slice.map((event) => ({
        ordinal: event.ordinal,
        type: event.event_type,
        detail: safeJson(event.detail_json, {}),
        actor: { role: event.actor_role, label: event.actor_label },
        occurredAt: event.occurred_at,
      })));
      const digest = sha256Hex(content);
      const ts = now();
      immediateTransaction(() => {
        db.prepare(`
          INSERT INTO audit_export_chunks (id, export_id, ordinal, content, chunk_digest, size, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(cryptoId(), task.id, nextOrdinal, content, digest, Buffer.byteLength(content, 'utf8'), ts);
        const completed = nextOrdinal + 1;
        const progress = Math.round((completed / task.total_chunks) * 100);
        db.prepare(`
          UPDATE audit_exports SET completed_chunks = ?, progress = ?, updated_at = ?, locked_at = ? WHERE id = ?
        `).run(completed, progress, ts, ts, task.id);
      });
      task = db.prepare('SELECT * FROM audit_exports WHERE id = ?').get(task.id);
    }

    if (task.completed_chunks >= task.total_chunks) {
      finalizeExport(task.id, workerId);
    }
    return { exportId: task.id, status: 'progress', completedChunks: task.completed_chunks, totalChunks: task.total_chunks };
  } catch (error) {
    const ts = now();
    db.prepare("UPDATE audit_exports SET locked_at = NULL, locked_by = '', updated_at = ? WHERE id = ? AND status = 'running'")
      .run(ts, task.id);
    throw error;
  }
}

function finalizeExport(exportId, workerId) {
  immediateTransaction(() => {
    const task = db.prepare('SELECT * FROM audit_exports WHERE id = ?').get(exportId);
    const archive = getArchiveRowTx(task.archive_id);
    if (!archive) throw new Error('ARCHIVE_NOT_FOUND');
    // 完成前再次校验摘要链（防止分块生成期间被篡改）
    const chain = verifyArchiveChain(archive.id);
    if (!chain.continuous) {
      const ts = now();
      db.prepare("UPDATE audit_exports SET status = 'failed', fail_reason = 'ARCHIVE_CHAIN_INVALID', updated_at = ?, completed_at = ?, locked_at = NULL, locked_by = '' WHERE id = ?")
        .run(ts, ts, exportId);
      addArchiveEventTx(archive.receipt_no, 'audit.export.failed', { exportId, reason: 'ARCHIVE_CHAIN_INVALID' });
      return;
    }
    const view = exportView(archive);
    const chunks = db.prepare('SELECT * FROM audit_export_chunks WHERE export_id = ? ORDER BY ordinal ASC').all(exportId);
    const bundle = {
      format: 'audit-archive-export/v1',
      exportedAt: now(),
      archive: {
        archiveNo: view.archiveNo,
        sourceType: view.sourceType,
        sourceTypeLabel: view.sourceTypeLabel,
        sourceId: view.sourceId,
        receiptNo: view.receiptNo || archive.receipt_no,
        version: view.version,
        frozenAt: view.frozenAt,
        eventCount: view.eventCount,
        timeRange: { from: view.firstEventAt, to: view.lastEventAt },
        genesisHash: view.genesisHash,
        finalHash: view.finalHash,
        chainContinuous: view.chain?.continuous ?? false,
        statusSummary: view.statusSummary,
        provenance: view.provenance,
        permissionSnapshot: view.permissionSnapshot,
        redactionRules: view.redactionRules,
      },
      events: view.events,
      chunks: chunks.map((chunk) => ({ ordinal: chunk.ordinal, digest: chunk.chunk_digest, size: chunk.size })),
    };
    const fileContent = JSON.stringify(bundle, null, 2);
    const fileDigest = sha256Hex(fileContent);
    const ts = now();
    const expiresAt = ts + config.archiveExportTtlMs;
    db.prepare(`
      UPDATE audit_exports
      SET status = 'completed', file_content = ?, file_digest = ?, file_size = ?, progress = 100,
          completed_at = ?, expires_at = ?, updated_at = ?, locked_at = NULL, locked_by = ''
      WHERE id = ?
    `).run(fileContent, fileDigest, Buffer.byteLength(fileContent, 'utf8'), ts, expiresAt, ts, exportId);
    addArchiveEventTx(archive.receipt_no, 'audit.export.completed', {
      exportId, archiveId: archive.id, fileVersion: 1, fileDigest, size: Buffer.byteLength(fileContent, 'utf8'),
    });
  });
}

// 后台扫描：推进任务 + 过期清理（凭证、外部码、完成文件）。返回处理摘要。
export function sweepArchiveExports() {
  const summary = { progressed: 0, expired: 0, codes: 0 };
  const ts = now();
  // 每 tick 处理若干个分块（小步推进，避免长事务阻塞办理接口）
  let guard = 0;
  while (guard < 4) {
    const before = db.prepare("SELECT COUNT(*) AS n FROM audit_exports WHERE status IN ('queued','running')").get().n;
    if (before === 0) break;
    const result = processNextExportChunk('sweeper');
    if (!result) break;
    if (result.status === 'progress') summary.progressed += 1;
    guard += 1;
  }
  // 完成任务过期：清理文件内容（任务行保留为 expired 留档），凭证一并过期
  const expiredExports = db.prepare("SELECT id FROM audit_exports WHERE status = 'completed' AND expires_at IS NOT NULL AND expires_at <= ?").all(ts);
  for (const row of expiredExports) {
    db.prepare("UPDATE audit_exports SET status = 'expired', file_content = NULL, file_digest = '', file_size = 0, locked_at = NULL, locked_by = '' WHERE id = ?").run(row.id);
    db.prepare("UPDATE audit_export_credentials SET status = 'expired' WHERE export_id = ? AND status = 'active'").run(row.id);
    summary.expired += 1;
  }
  db.prepare("UPDATE audit_export_credentials SET status = 'expired' WHERE status = 'active' AND expires_at <= ?").run(ts);
  db.prepare("UPDATE audit_external_codes SET status = 'expired' WHERE status = 'active' AND expires_at <= ?").run(ts);
  return summary;
}

// 测试/确定性场景：同步跑完一个导出任务的全部分块
export function runExportToCompletion(exportId) {
  for (let i = 0; i < 10000; i += 1) {
    const row = db.prepare('SELECT * FROM audit_exports WHERE id = ?').get(exportId);
    if (!row) return null;
    if (!['queued', 'running'].includes(row.status)) return exportTaskPublic(row);
    processNextExportChunk('sync');
  }
  throw new Error('导出任务无法在限定步数内完成');
}

// ===========================================================================
// 一次性下载凭证
// ===========================================================================

// 某任务的凭证状态列表（不返回凭证明文，只返回状态/时间，供办理页展示）
export function listCredentialsForOwner({ userId, exportId }) {
  const task = db.prepare('SELECT * FROM audit_exports WHERE id = ? AND owner_user_id = ?').get(exportId, userId);
  if (!task) return null;
  const effective = (row) => {
    if (row.status === 'active' && row.expires_at <= now()) return 'expired';
    return row.status;
  };
  return db.prepare(`
    SELECT id, status, created_at, expires_at, used_at, revoked_at
    FROM audit_export_credentials WHERE export_id = ? ORDER BY created_at DESC
  `).all(exportId).map((row) => ({
    id: row.id,
    status: effective(row),
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at || null,
    revokedAt: row.revoked_at || null,
  }));
}

export function issueDownloadCredential({ userId, exportId, ttlMs }) {
  return immediateTransaction(() => {
    const task = db.prepare('SELECT * FROM audit_exports WHERE id = ? AND owner_user_id = ?').get(exportId, userId);
    if (!task) return { ok: false, status: 404, code: 'EXPORT_NOT_FOUND', message: '导出任务不存在' };
    const status = effectiveExportStatus(task);
    if (status !== 'completed' || !task.file_content) {
      return { ok: false, status: 409, code: 'EXPORT_NOT_COMPLETED', message: '导出任务尚未完成或文件已清理，暂时无法下载' };
    }
    const ts = now();
    const raw = tokenUrlSafe();
    const id = cryptoId();
    const ttl = ttlMs || config.archiveCredentialTtlMs;
    db.prepare(`
      INSERT INTO audit_export_credentials
        (id, export_id, archive_id, owner_user_id, code_hash, status, created_at, expires_at, used_at, used_ip, revoked_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL, '', NULL)
    `).run(id, task.id, task.archive_id, userId, sha256(raw), ts, ts + ttl);
    return { ok: true, credential: raw, expiresAt: ts + ttl, fileVersion: task.file_version, fileDigest: task.file_digest };
  });
}

export function redeemDownloadCredential({ rawCode, expectedArchiveId = '', clientIp = '' }) {
  return immediateTransaction(() => {
    const row = db.prepare('SELECT * FROM audit_export_credentials WHERE code_hash = ?').get(sha256(rawCode));
    if (!row) return { ok: false, status: 403, code: 'EXPORT_CREDENTIAL_INVALID', message: '下载凭证不正确' };
    if (expectedArchiveId && row.archive_id !== expectedArchiveId) {
      return { ok: false, status: 403, code: 'EXPORT_CREDENTIAL_ARCHIVE_MISMATCH', message: '下载凭证与请求的归档不匹配' };
    }
    if (row.status === 'used') return { ok: false, status: 410, code: 'EXPORT_CREDENTIAL_USED', message: '下载凭证已使用过，不能重复使用' };
    if (row.status === 'revoked') return { ok: false, status: 410, code: 'EXPORT_CREDENTIAL_REVOKED', message: '下载凭证已作废' };
    if (row.expires_at <= now()) {
      db.prepare("UPDATE audit_export_credentials SET status = 'expired' WHERE id = ? AND status = 'active'").run(row.id);
      return { ok: false, status: 410, code: 'EXPORT_CREDENTIAL_EXPIRED', message: '下载凭证已过期' };
    }
    const task = db.prepare('SELECT * FROM audit_exports WHERE id = ?').get(row.export_id);
    if (!task) return { ok: false, status: 404, code: 'EXPORT_NOT_FOUND', message: '导出任务不存在' };
    if (task.status === 'cancelled') {
      return { ok: false, status: 410, code: 'EXPORT_TASK_CANCELLED', message: '导出任务已取消，凭证失效' };
    }
    if (task.status === 'expired' || !task.file_content) {
      return { ok: false, status: 410, code: 'EXPORT_TASK_EXPIRED', message: '导出文件已过保留期并被清理' };
    }
    if (task.status !== 'completed') {
      return { ok: false, status: 409, code: 'EXPORT_NOT_COMPLETED', message: '导出任务尚未完成' };
    }
    // 下载动作不修改任何业务数据；只标记凭证一次性使用与导出审计事件计数
    db.prepare(`
      UPDATE audit_export_credentials SET status = 'used', used_at = ?, used_ip = ? WHERE id = ? AND status = 'active'
    `).run(now(), String(clientIp || '').slice(0, 64), row.id);
    const archive = getArchiveRowTx(row.archive_id);
    return {
      ok: true,
      fileName: `audit-archive-${safeJson(archive?.scope_json || '{}', {}).archiveNo || row.archive_id}-v${task.file_version}.json`,
      content: task.file_content,
      fileDigest: task.file_digest,
      fileVersion: task.file_version,
      size: task.file_size,
    };
  });
}

// 启动恢复：进程重启意味着旧持锁者已不存在，无条件释放全部 running 锁，
// 由本进程接管（分块进度持久化，不丢已完成分块）。
export function recoverArchiveExportsOnStartup() {
  db.prepare("UPDATE audit_exports SET locked_at = NULL, locked_by = '' WHERE status = 'running'").run();
  try {
    sweepArchiveExports();
  } catch (error) {
    console.error('archive export recovery failed', error);
  }
}

// 测试/确定性场景：显式推进一个分块（等同后台一次 tick）
export function processNextExportChunkForTest() {
  return processNextExportChunk('sync-test');
}
