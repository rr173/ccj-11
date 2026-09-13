// ---------------------------------------------------------------------------
// 归档版本对比 + 受控重放审阅：冻结比较报告 + 只读写意见的重放会话
//
// 不可变边界（与 audit_archive 相同的“只有 INSERT，没有 UPDATE 冻结内容”约定）：
//  1. 比较报告与报告条目（audit_comparison_entries）创建后没有任何改写路径；
//     报告内容只来自两个已冻结归档的冻结副本，归档之后新增业务事件不影响报告。
//  2. 重放事件副本（audit_replay_events）在会话创建时从报告条目复制，之后不更新；
//     写操作只追加 opinions / audit 行与会话行状态，绝不触碰 audit_* / 业务表 / 导出文件。
//  3. 报告 digest 由规范化报告体计算并冻结；读取时重算比对，同时实时重算两份归档
//     的摘要链，任何一处失效都会让 verification.reportOk / archiveChains 置失败，
//     恢复重放与会话恢复都会因此被拒绝。
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';
import { db, immediateTransaction, cryptoId } from './db.js';
import { sha256, tokenUrlSafe, stableStringify } from './crypto.js';
import { config } from './config.js';
import { verifyArchiveChain, frozenEventContentHash } from './archiveStore.js';
import { redactAuditorDetail, eventFamily } from './archives.js';
import {
  alignEvents,
  diffStatusSummary,
  newComparisonNo,
  newReplayNo,
  COMPARISON_ERRORS,
} from './archiveComparisons.js';

function now() {
  return Date.now();
}

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}

function safeJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function addReplayAuditEventTx(receiptNo, type, detail) {
  const row = db.prepare('SELECT workflow_id FROM receipts WHERE receipt_no = ?').get(receiptNo || '');
  if (!row) return;
  db.prepare(`
    INSERT INTO events (workflow_id, type, step, detail_json, created_at)
    VALUES (?, ?, NULL, ?, ?)
  `).run(row.workflow_id, type, JSON.stringify(detail || {}), now());
}

// ===========================================================================
// 比较报告生成
// ===========================================================================

function frozenEventView(row) {
  return {
    ordinal: row.ordinal,
    sourceEventId: row.source_event_id,
    type: row.event_type,
    occurredAt: row.occurred_at,
    // 内容摘要（不含链 prev_hash）：同一原始事件在两版本中只有内容真的改变才标 modified
    contentHash: frozenEventContentHash(row),
    actorRole: row.actor_role,
    actorLabel: row.actor_label,
    detail: safeJson(row.detail_json, {}),
  };
}

function archiveMeta(archive, chain) {
  return {
    archiveId: archive.id,
    archiveNo: safeJson(archive.scope_json, {}).archiveNo || '',
    version: archive.version,
    sourceType: archive.source_type,
    sourceId: archive.source_id,
    sourceLabel: archive.source_label,
    frozenAt: archive.created_at,
    eventCount: archive.event_count,
    timeRange: { from: archive.first_event_at || null, to: archive.last_event_at || null },
    finalHash: archive.final_hash,
    genesisHash: archive.genesis_hash,
    chainContinuous: Boolean(chain?.continuous),
  };
}

function diffProvenance(base, target) {
  const keyOf = (link) => `${link.from}->${link.to}:${link.relation}`;
  const baseMap = new Map(base.map((link) => [keyOf(link), link]));
  const targetMap = new Map(target.map((link) => [keyOf(link), link]));
  const added = [];
  const removed = [];
  for (const [key, link] of targetMap) if (!baseMap.has(key)) added.push(link);
  for (const [key, link] of baseMap) if (!targetMap.has(key)) removed.push(link);
  return {
    same: added.length === 0 && removed.length === 0,
    added,
    removed,
    baseCount: base.length,
    targetCount: target.length,
  };
}

function permissionSnapshotSummary(archive) {
  const perms = safeJson(archive.permission_snapshot_json, {});
  return {
    owner: perms.owner ? { username: perms.owner.username || '', role: perms.owner.role || 'handler' } : null,
    auditors: (perms.auditors || []).map((item) => ({ username: item.username, displayName: item.displayName })),
    externalFields: perms.external?.fields || [],
    frozenAt: perms.frozenAt || archive.created_at,
  };
}

function diffPermissionSnapshots(baseSummary, targetSummary) {
  const baseNames = (baseSummary.auditors || []).map((item) => item.username);
  const targetNames = (targetSummary.auditors || []).map((item) => item.username);
  const granted = targetNames.filter((name) => !baseNames.includes(name));
  const revoked = baseNames.filter((name) => !targetNames.includes(name));
  return {
    same: granted.length === 0 && revoked.length === 0
      && JSON.stringify(baseSummary.externalFields) === JSON.stringify(targetSummary.externalFields),
    base: baseSummary,
    target: targetSummary,
    auditorGrantsAdded: granted,
    auditorGrantsRemoved: revoked,
  };
}

export function createArchiveComparison({
  userId, baseArchiveId, targetArchiveId, note,
}) {
  return immediateTransaction(() => {
    const a = db.prepare('SELECT * FROM audit_archives WHERE id = ?').get(baseArchiveId);
    const b = db.prepare('SELECT * FROM audit_archives WHERE id = ?').get(targetArchiveId);
    if (!a || a.owner_user_id !== userId || !b || b.owner_user_id !== userId) {
      return { ok: false, status: 404, code: 'COMPARE_ARCHIVE_NOT_FOUND', message: COMPARISON_ERRORS.COMPARE_ARCHIVE_NOT_FOUND };
    }
    if (a.id === b.id) {
      return { ok: false, status: 400, code: 'COMPARE_SAME_ARCHIVE', message: COMPARISON_ERRORS.COMPARE_SAME_ARCHIVE };
    }
    if (a.source_type !== b.source_type || a.source_id !== b.source_id) {
      return { ok: false, status: 409, code: 'COMPARE_NOT_SAME_SOURCE', message: COMPARISON_ERRORS.COMPARE_NOT_SAME_SOURCE };
    }
    const chainA = verifyArchiveChain(a.id);
    const chainB = verifyArchiveChain(b.id);
    if (!chainA.continuous || !chainB.continuous) {
      const brokenSide = !chainA.continuous ? 'base' : 'target';
      const broken = brokenSide === 'base' ? chainA.broken : chainB.broken;
      const brokenArchive = brokenSide === 'base' ? a : b;
      return {
        ok: false,
        status: 409,
        code: 'ARCHIVE_CHAIN_INVALID',
        message: COMPARISON_ERRORS.ARCHIVE_CHAIN_INVALID,
        detail: {
          side: brokenSide,
          archiveId: brokenArchive.id,
          archiveNo: safeJson(brokenArchive.scope_json, {}).archiveNo || '',
          version: brokenArchive.version,
          broken,
        },
      };
    }

    // 版本低者为基准（base），高者为目标（target）；同版本理论上不会出现（UNIQUE 约束）
    const low = a.version <= b.version ? a : b;
    const high = a.version <= b.version ? b : a;
    const chainLow = low === a ? chainA : chainB;
    const chainHigh = high === b ? chainB : chainA;

    const baseRows = db.prepare('SELECT * FROM audit_archive_events WHERE archive_id = ? ORDER BY ordinal ASC').all(low.id)
      .map(frozenEventView);
    const targetRows = db.prepare('SELECT * FROM audit_archive_events WHERE archive_id = ? ORDER BY ordinal ASC').all(high.id)
      .map(frozenEventView);
    const { entries, counts, unalignedReasons } = alignEvents(baseRows, targetRows);

    const baseProvenance = safeJson(low.provenance_json, []);
    const targetProvenance = safeJson(high.provenance_json, []);
    const baseSummary = safeJson(low.status_summary_json, {});
    const targetSummary = safeJson(high.status_summary_json, {});
    const basePerms = permissionSnapshotSummary(low);
    const targetPerms = permissionSnapshotSummary(high);

    const body = {
      format: 'audit-archive-comparison/v1',
      comparisonNo: '', // 生成后不影响 digest（digest 只覆盖冻结内容，不含自身编号/时间）
      base: archiveMeta(low, chainLow),
      target: archiveMeta(high, chainHigh),
      source: { sourceType: low.source_type, sourceId: low.source_id, sourceLabel: low.source_label, receiptNo: low.receipt_no },
      entries: entries.map((entry) => ({
        entryKey: entry.entryKey,
        ordinal: entry.ordinal,
        status: entry.status,
        reason: entry.reason,
        base: entry.base ? { ordinal: entry.base.ordinal, sourceEventId: entry.base.sourceEventId, eventHash: entry.base.contentHash, type: entry.base.type, occurredAt: entry.base.occurredAt } : null,
        target: entry.target ? { ordinal: entry.target.ordinal, sourceEventId: entry.target.sourceEventId, eventHash: entry.target.contentHash, type: entry.target.type, occurredAt: entry.target.occurredAt } : null,
      })),
      counts,
      unalignedReasons,
      chainContinuity: {
        baseContinuous: chainLow.continuous,
        targetContinuous: chainHigh.continuous,
        baseFinalHash: low.final_hash,
        targetFinalHash: high.final_hash,
        alignedAcrossVersions: unalignedReasons.length === 0,
      },
      provenanceDiff: diffProvenance(baseProvenance, targetProvenance),
      statusSummaryDiff: diffStatusSummary(baseSummary, targetSummary),
      permissionSnapshotDiff: diffPermissionSnapshots(basePerms, targetPerms),
      note: note || '',
    };

    const ts = now();
    const id = cryptoId();
    const comparisonNo = newComparisonNo(ts);
    body.comparisonNo = comparisonNo;
    const digest = sha256Hex(stableStringify(body));

    db.prepare(`
      INSERT INTO audit_comparisons
        (id, owner_user_id, comparison_no, receipt_no, base_archive_id, target_archive_id,
         source_type, source_id, status, note, body_json, digest,
         count_added, count_deleted, count_modified, count_unchanged, count_unaligned,
         base_chain_ok, target_chain_ok, created_at, expires_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'frozen', ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, ?, NULL)
    `).run(
      id, userId, comparisonNo, low.receipt_no, low.id, high.id,
      low.source_type, low.source_id, note || '', JSON.stringify(body), digest,
      counts.added, counts.deleted, counts.modified, counts.unchanged, counts.unaligned, ts,
    );

    const insertEntry = db.prepare(`
      INSERT INTO audit_comparison_entries
        (id, comparison_id, ordinal, entry_key, status, reason,
         base_ordinal, base_source_event_id, base_event_hash, base_event_type, base_occurred_at,
         target_ordinal, target_source_event_id, target_event_hash, target_event_type, target_occurred_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of body.entries) {
      insertEntry.run(
        cryptoId(), id, entry.ordinal - 1, entry.entryKey, entry.status, entry.reason,
        entry.base?.ordinal ?? null, entry.base?.sourceEventId ?? null, entry.base?.eventHash ?? '', entry.base?.type ?? '', entry.base?.occurredAt ?? null,
        entry.target?.ordinal ?? null, entry.target?.sourceEventId ?? null, entry.target?.eventHash ?? '', entry.target?.type ?? '', entry.target?.occurredAt ?? null,
      );
    }

    addReplayAuditEventTx(low.receipt_no, 'audit.comparison.created', {
      comparisonId: id, comparisonNo,
      baseArchiveId: low.id, baseVersion: low.version,
      targetArchiveId: high.id, targetVersion: high.version,
      counts,
    });

    return { ok: true, comparison: getComparisonForOwner({ userId, comparisonId: id }) };
  });
}

// ===========================================================================
// 报告校验：冻结 digest 重算 + 两份归档摘要链实时重算
// ===========================================================================

export function verifyComparison(comparisonId) {
  const row = db.prepare('SELECT * FROM audit_comparisons WHERE id = ?').get(comparisonId);
  if (!row) return null;
  const body = safeJson(row.body_json, null);
  const digestMatches = Boolean(body) && sha256Hex(stableStringify(body)) === row.digest;
  const baseChain = verifyArchiveChain(row.base_archive_id);
  const targetChain = verifyArchiveChain(row.target_archive_id);
  const chainsOk = Boolean(baseChain?.continuous && targetChain?.continuous);
  const reasons = [];
  if (!digestMatches) reasons.push({ code: 'COMPARISON_DIGEST_MISMATCH', reason: '比较报告冻结内容与摘要不一致，报告可能已被篡改' });
  if (!baseChain?.continuous) {
    reasons.push({ code: 'ARCHIVE_CHAIN_INVALID', side: 'base', reason: '基准归档版本摘要链失效', broken: baseChain?.broken || null });
  }
  if (!targetChain?.continuous) {
    reasons.push({ code: 'ARCHIVE_CHAIN_INVALID', side: 'target', reason: '目标归档版本摘要链失效', broken: targetChain?.broken || null });
  }
  return {
    reportOk: digestMatches && chainsOk,
    digestMatches,
    archiveChainsOk: chainsOk,
    baseChain: baseChain ? { continuous: baseChain.continuous, broken: baseChain.broken, checkedAt: baseChain.checkedAt } : null,
    targetChain: targetChain ? { continuous: targetChain.continuous, broken: targetChain.broken, checkedAt: targetChain.checkedAt } : null,
    reasons,
    checkedAt: now(),
  };
}

// ===========================================================================
// 报告查询：办理人视图 / 审计员视图（双版本都授权才可看，且看不到重放）
// ===========================================================================

function entryRowForReport(row) {
  return {
    ordinal: row.ordinal + 1, // 对外 1 基
    entryKey: row.entry_key,
    status: row.status,
    reason: row.reason || '',
    base: row.base_ordinal === null ? null : {
      ordinal: row.base_ordinal,
      sourceEventId: row.base_source_event_id,
      eventHash: row.base_event_hash,
      type: row.base_event_type,
      occurredAt: row.base_occurred_at,
    },
    target: row.target_ordinal === null ? null : {
      ordinal: row.target_ordinal,
      sourceEventId: row.target_source_event_id,
      eventHash: row.target_event_hash,
      type: row.target_event_type,
      occurredAt: row.target_occurred_at,
    },
  };
}

function comparisonPublic(row, { auditorView = false } = {}) {
  const body = safeJson(row.body_json, {});
  const verification = verifyComparison(row.id);
  const entryRows = db.prepare('SELECT * FROM audit_comparison_entries WHERE comparison_id = ? ORDER BY ordinal ASC').all(row.id);
  const out = {
    id: row.id,
    comparisonNo: row.comparison_no,
    sourceType: row.source_type,
    sourceId: row.source_id,
    sourceLabel: body.source?.sourceLabel || '',
    receiptNo: row.receipt_no,
    base: body.base,
    target: body.target,
    status: row.status,
    note: row.note || '',
    createdAt: row.created_at,
    counts: body.counts,
    unalignedReasons: body.unalignedReasons || [],
    chainContinuity: body.chainContinuity,
    provenanceDiff: auditorView ? redactAuditorDetail(body.provenanceDiff) : body.provenanceDiff,
    statusSummaryDiff: auditorView ? redactAuditorDetail(body.statusSummaryDiff) : body.statusSummaryDiff,
    digest: row.digest,
    verification,
    entries: entryRows.map(entryRowForReport),
    view: auditorView ? 'auditor' : 'handler',
  };
  // 权限快照差异只暴露授权用户名差异（无逐字敏感内容）；审计员视图只给布尔结论
  if (auditorView) {
    const diff = body.permissionSnapshotDiff || {};
    out.permissionSnapshotDiff = {
      same: Boolean(diff.same),
      auditorGrantsAdded: (diff.auditorGrantsAdded || []),
      auditorGrantsRemoved: (diff.auditorGrantsRemoved || []),
    };
  } else {
    out.permissionSnapshotDiff = body.permissionSnapshotDiff;
  }
  return out;
}

export function getComparisonForOwner({ userId, comparisonId }) {
  const row = db.prepare('SELECT * FROM audit_comparisons WHERE id = ? AND owner_user_id = ?').get(comparisonId, userId);
  return row ? comparisonPublic(row) : null;
}

export function listComparisonsForOwner(userId, { sourceType = '', sourceId = '' } = {}) {
  let sql = 'SELECT * FROM audit_comparisons WHERE owner_user_id = ?';
  const params = [userId];
  if (sourceType) { sql += ' AND source_type = ?'; params.push(sourceType); }
  if (sourceId) { sql += ' AND source_id = ?'; params.push(sourceId); }
  sql += ' ORDER BY created_at DESC';
  return db.prepare(sql).all(...params).map((row) => {
    const verification = verifyComparison(row.id);
    return {
      id: row.id,
      comparisonNo: row.comparison_no,
      sourceType: row.source_type,
      sourceId: row.source_id,
      receiptNo: row.receipt_no,
      base: safeJson(row.body_json, {}).base,
      target: safeJson(row.body_json, {}).target,
      status: row.status,
      note: row.note || '',
      createdAt: row.created_at,
      counts: safeJson(row.body_json, {}).counts,
      digest: row.digest,
      verification,
    };
  });
}

function auditorGrantedArchive(archiveId, userId) {
  const archive = db.prepare('SELECT permission_snapshot_json FROM audit_archives WHERE id = ?').get(archiveId);
  if (!archive) return false;
  const perms = safeJson(archive.permission_snapshot_json, {});
  return (perms.auditors || []).some((item) => item.userId === userId);
}

export function listComparisonsForAuditor(userId) {
  const rows = db.prepare('SELECT * FROM audit_comparisons ORDER BY created_at DESC').all();
  const out = [];
  for (const row of rows) {
    if (!auditorGrantedArchive(row.base_archive_id, userId)) continue;
    if (!auditorGrantedArchive(row.target_archive_id, userId)) continue;
    const verification = verifyComparison(row.id);
    out.push({
      id: row.id,
      comparisonNo: row.comparison_no,
      sourceType: row.source_type,
      sourceId: row.source_id,
      ownerReceiptNo: row.receipt_no,
      base: safeJson(row.body_json, {}).base,
      target: safeJson(row.body_json, {}).target,
      createdAt: row.created_at,
      counts: safeJson(row.body_json, {}).counts,
      digest: row.digest,
      verification,
      view: 'auditor',
    });
  }
  return out;
}

export function getComparisonForAuditor({ userId, comparisonId }) {
  const row = db.prepare('SELECT * FROM audit_comparisons WHERE id = ?').get(comparisonId);
  if (!row) return null;
  if (!auditorGrantedArchive(row.base_archive_id, userId) || !auditorGrantedArchive(row.target_archive_id, userId)) {
    return { forbidden: true };
  }
  const view = comparisonPublic(row, { auditorView: true });
  // 审计员看得到的条目按归档脱敏规则处理（无逐字理由/标签等）；事件类型与顺序仍可见
  view.entries = view.entries.map((entry) => ({
    ...entry,
    base: entry.base ? { ...entry.base } : null,
    target: entry.target ? { ...entry.target } : null,
  }));
  return view;
}

// ===========================================================================
// 重放审阅会话
// ===========================================================================

function effectiveReplayStatus(row, ts = now()) {
  if (row.status === 'active' || row.status === 'paused') {
    return row.expires_at <= ts ? 'expired' : row.status;
  }
  return row.status;
}

export function createReplaySession({ userId, comparisonId, entryKeys, ttlMs, note }) {
  return immediateTransaction(() => {
    const comparison = db.prepare('SELECT * FROM audit_comparisons WHERE id = ? AND owner_user_id = ?').get(comparisonId, userId);
    if (!comparison) {
      return { ok: false, status: 404, code: 'COMPARE_NOT_FOUND', message: COMPARISON_ERRORS.COMPARE_NOT_FOUND };
    }
    const verification = verifyComparison(comparison.id);
    if (!verification.reportOk) {
      return {
        ok: false, status: 409, code: 'REPLAY_REPORT_INVALID',
        message: COMPARISON_ERRORS.REPLAY_REPORT_INVALID, verification,
      };
    }
    const allowed = new Set(
      db.prepare(`
        SELECT entry_key FROM audit_comparison_entries
        WHERE comparison_id = ? AND status IN ('added', 'deleted', 'modified', 'unchanged')
      `).all(comparison.id).map((row) => row.entry_key),
    );
    for (const key of entryKeys) {
      if (!allowed.has(key)) {
        // 不存在 / 未对齐 / 报告外 一律越权拒绝（不区分以避免枚举）
        return {
          ok: false, status: 403, code: 'REPLAY_EVENT_OUT_OF_SCOPE',
          message: `${COMPARISON_ERRORS.REPLAY_EVENT_OUT_OF_SCOPE}：${key}`,
          entryKey: key,
        };
      }
    }

    const ts = now();
    const id = cryptoId();
    const replayNo = newReplayNo(ts);
    const entries = db.prepare(`
      SELECT * FROM audit_comparison_entries
      WHERE comparison_id = ? ORDER BY ordinal ASC
    `).all(comparison.id).filter((row) => allowed.has(row.entry_key) && entryKeys.includes(row.entry_key));
    const byKey = new Map(entries.map((row) => [row.entry_key, row]));
    const orderedKeys = [...entryKeys].sort(
      (x, y) => byKey.get(x).ordinal - byKey.get(y).ordinal,
    );

    db.prepare(`
      INSERT INTO audit_replay_sessions
        (id, owner_user_id, replay_no, comparison_id, receipt_no, status, version,
         note, selected_count, confirmed_count, objected_count, comment_count,
         submit_token_hash, submit_token_expires_at, created_at, expires_at,
         paused_at, resumed_at, cancelled_at, cancel_reason, completed_at)
      VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, 0, 0, 0, NULL, NULL, ?, ?, NULL, NULL, NULL, '', NULL)
    `).run(id, userId, replayNo, comparison.id, comparison.receipt_no, note || '', orderedKeys.length, ts, ts + ttlMs);

    // 冻结事件副本：优先采用目标（较新）版本，删除事件只有基准版本时用基准；
    // 全部复制进独立表，之后报告/归档/业务记录的变化都不影响重放。
    const insertEvent = db.prepare(`
      INSERT INTO audit_replay_events
        (id, replay_id, ordinal, entry_key, source_side, source_event_id,
         event_type, detail_json, actor_role, actor_label, occurred_at, event_content_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    orderedKeys.forEach((key, ordinal) => {
      const row = byKey.get(key);
      // 报告条目存的是归档冻结事件的原始 ordinal（0 基）；删除事件只有基准侧
      const useTarget = row.target_ordinal !== null;
      const side = useTarget ? 'target' : 'base';
      const frozen = db.prepare('SELECT * FROM audit_archive_events WHERE archive_id = ? AND ordinal = ?')
        .get(useTarget ? comparison.target_archive_id : comparison.base_archive_id,
          useTarget ? row.target_ordinal : row.base_ordinal);
      insertEvent.run(
        cryptoId(), id, ordinal, key, side,
        useTarget ? row.target_source_event_id : row.base_source_event_id,
        frozen.event_type, frozen.detail_json, frozen.actor_role, frozen.actor_label,
        frozen.occurred_at, frozen.event_hash, ts,
      );
    });

    addReplayAuditRowTx(id, 'replay.created', {
      replayId: id, replayNo, comparisonId: comparison.id,
      selectedCount: orderedKeys.length, ttlMs,
    });
    addReplayAuditEventTx(comparison.receipt_no, 'audit.replay.created', {
      replayId: id, comparisonId: comparison.id, selectedCount: orderedKeys.length,
    });

    return { ok: true, replay: getReplayForOwner({ userId, replayId: id }) };
  });
}

function addReplayAuditRowTx(replayId, type, detail) {
  const replay = db.prepare('SELECT receipt_no FROM audit_replay_sessions WHERE id = ?').get(replayId);
  db.prepare(`
    INSERT INTO audit_replay_audit (id, replay_id, type, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(cryptoId(), replayId, type, JSON.stringify(detail || {}), now());
  if (replay) {
    addReplayAuditEventTx(replay.receipt_no, `audit.${type}`, { replayId, ...(detail || {}) });
  }
}

export function issueReplaySubmitToken({ userId, replayId }) {
  return immediateTransaction(() => {
    const row = db.prepare('SELECT * FROM audit_replay_sessions WHERE id = ? AND owner_user_id = ?').get(replayId, userId);
    if (!row) return { ok: false, status: 404, code: 'REPLAY_NOT_FOUND', message: COMPARISON_ERRORS.REPLAY_NOT_FOUND };
    const status = effectiveReplayStatus(row);
    // 暂停态允许取令牌：该令牌只能用于“恢复/取消”等控制操作；写意见仍会被 REPLAY_PAUSED 拒绝
    if (status === 'cancelled') return { ok: false, status: 409, code: 'REPLAY_CANCELLED_READONLY', message: COMPARISON_ERRORS.REPLAY_CANCELLED_READONLY };
    if (status === 'expired') return { ok: false, status: 410, code: 'REPLAY_EXPIRED', message: COMPARISON_ERRORS.REPLAY_EXPIRED };

    const ts = now();
    // 每次签发新令牌：未使用的旧令牌立即作废，保证同一时刻只有一枚有效提交令牌
    db.prepare("UPDATE audit_replay_submit_tokens SET status = 'revoked', revoked_at = ? WHERE replay_id = ? AND status = 'active' AND used_at IS NULL")
      .run(ts, row.id);
    const raw = tokenUrlSafe();
    const ttl = config.replaySubmitTokenTtlMs;
    db.prepare(`
      INSERT INTO audit_replay_submit_tokens
        (id, replay_id, token_hash, status, created_at, expires_at, used_at, used_opinion_id, revoked_at)
      VALUES (?, ?, ?, 'active', ?, ?, NULL, '', NULL)
    `).run(cryptoId(), row.id, sha256(raw), ts, ts + ttl);
    return {
      ok: true,
      submitToken: raw,
      expiresAt: ts + ttl,
      ttlMs: ttl,
      version: row.version,
      status,
      replayStatus: status,
      expiresAtSession: row.expires_at,
    };
  });
}

function markReplayExpiredTx(row, ts) {
  db.prepare("UPDATE audit_replay_sessions SET status = 'expired', completed_at = ? WHERE id = ? AND status IN ('active', 'paused')")
    .run(ts, row.id);
  db.prepare("UPDATE audit_replay_submit_tokens SET status = 'expired' WHERE replay_id = ? AND status = 'active' AND used_at IS NULL").run(row.id);
}

function opinionPublic(row) {
  return {
    id: row.id,
    entryKey: row.entry_key,
    kind: row.kind,
    comment: row.comment,
    reason: row.reason,
    status: 'active',
    createdAt: row.created_at,
    replayVersion: row.replay_version,
  };
}

function replayTimelineTx(replayId) {
  return db.prepare('SELECT id, type, detail_json as detailJson, created_at as createdAt FROM audit_replay_audit WHERE replay_id = ? ORDER BY created_at ASC, rowid ASC').all(replayId)
    .map((row) => ({ id: row.id, type: row.type, detail: safeJson(row.detailJson, {}), createdAt: row.createdAt }));
}

export function getReplayForOwner({ userId, replayId }) {
  const row = db.prepare('SELECT * FROM audit_replay_sessions WHERE id = ? AND owner_user_id = ?').get(replayId, userId);
  if (!row) return null;
  const status = effectiveReplayStatus(row);
  const events = db.prepare('SELECT * FROM audit_replay_events WHERE replay_id = ? ORDER BY ordinal ASC').all(row.id);
  const opinions = db.prepare('SELECT * FROM audit_replay_opinions WHERE replay_id = ? ORDER BY created_at ASC').all(row.id);
  const decisions = new Map();
  for (const opinion of opinions) {
    if (opinion.kind === 'confirm' || opinion.kind === 'object') decisions.set(opinion.entry_key, opinion.kind);
  }
  const comparison = db.prepare('SELECT id, digest FROM audit_comparisons WHERE id = ?').get(row.comparison_id);
  return {
    id: row.id,
    replayNo: row.replay_no,
    comparisonId: row.comparison_id,
    status,
    storedStatus: row.status,
    version: row.version,
    note: row.note || '',
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    pausedAt: row.paused_at || null,
    resumedAt: row.resumed_at || null,
    cancelledAt: row.cancelled_at || null,
    cancelReason: row.cancel_reason || '',
    selectedCount: row.selected_count,
    confirmedCount: row.confirmed_count,
    objectedCount: row.objected_count,
    commentCount: row.comment_count,
    progress: {
      selected: row.selected_count,
      confirmed: row.confirmed_count,
      objected: row.objected_count,
      commented: row.comment_count,
      decided: row.confirmed_count + row.objected_count,
      remaining: Math.max(0, row.selected_count - row.confirmed_count - row.objected_count),
    },
    verification: comparison ? verifyComparison(row.comparison_id) : null,
    events: events.map((event) => ({
      ordinal: event.ordinal,
      entryKey: event.entry_key,
      sourceSide: event.source_side,
      sourceEventId: event.source_event_id,
      type: event.event_type,
      family: eventFamily(event.event_type),
      detail: safeJson(event.detail_json, {}),
      actor: { role: event.actor_role, label: event.actor_label },
      occurredAt: event.occurred_at,
      decision: decisions.get(event.entry_key) || null,
    })),
    opinions: opinions.map(opinionPublic),
    auditTimeline: replayTimelineTx(row.id),
  };
}

export function listReplaysForOwner(userId, { comparisonId = '' } = {}) {
  const rows = comparisonId
    ? db.prepare('SELECT * FROM audit_replay_sessions WHERE owner_user_id = ? AND comparison_id = ? ORDER BY created_at DESC').all(userId, comparisonId)
    : db.prepare('SELECT * FROM audit_replay_sessions WHERE owner_user_id = ? ORDER BY created_at DESC').all(userId);
  return rows.map((row) => ({
    id: row.id,
    replayNo: row.replay_no,
    comparisonId: row.comparison_id,
    status: effectiveReplayStatus(row),
    version: row.version,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    pausedAt: row.paused_at || null,
    cancelledAt: row.cancelled_at || null,
    selectedCount: row.selected_count,
    confirmedCount: row.confirmed_count,
    objectedCount: row.objected_count,
    commentCount: row.comment_count,
  }));
}

// 控制操作（暂停/恢复/取消）共用的版本+令牌校验；通过时消费一次性令牌
function consumeControlTokenTx({ row, submitToken, expectedVersion }) {
  const ts = now();
  // 版本先于令牌检查：旧版本提交不应让一枚有效令牌作废
  if (row.version !== expectedVersion) {
    return {
      ok: false, status: 409, code: 'REPLAY_VERSION_CONFLICT',
      message: COMPARISON_ERRORS.REPLAY_VERSION_CONFLICT, currentVersion: row.version,
    };
  }
  const tokenCheck = checkWriteTokenTx({ row, submitToken, ts });
  if (!tokenCheck.ok) return tokenCheck;
  db.prepare("UPDATE audit_replay_submit_tokens SET status = 'used', used_at = ?, used_opinion_id = 'control' WHERE id = ?")
    .run(ts, tokenCheck.token.id);
  return { ok: true, token: tokenCheck.token };
}

export function submitReplayOpinion({
  userId, replayId, entryKey, kind, comment, reason, idempotencyKey, submitToken, expectedVersion, requestText,
}) {
  try {
    return submitReplayOpinionTx({
      userId, replayId, entryKey, kind, comment, reason, idempotencyKey, submitToken, expectedVersion, requestText,
    });
  } catch (error) {
    // 两个页面并发确认/异议同一事件：部分唯一索引只放行一个，负者得到明确错误
    if (String(error?.message || '').includes('UNIQUE')
      && String(error?.message || '').includes('audit_replay_opinions')) {
      return {
        ok: false, status: 409, code: 'REPLAY_ALREADY_DECIDED',
        message: '该事件已被另一个页面确认或提出异议，只有一个提交成功',
      };
    }
    throw error;
  }
}

function submitReplayOpinionTx({
  userId, replayId, entryKey, kind, comment, reason, idempotencyKey, submitToken, expectedVersion, requestText,
}) {
  return immediateTransaction(() => {
    const row = db.prepare('SELECT * FROM audit_replay_sessions WHERE id = ? AND owner_user_id = ?').get(replayId, userId);
    if (!row) return { ok: false, status: 404, code: 'REPLAY_NOT_FOUND', message: COMPARISON_ERRORS.REPLAY_NOT_FOUND };

    // 幂等回放最先判断：暂停/过期/令牌用尽后的网络重试仍返回同一条意见
    const prior = db.prepare(`
      SELECT * FROM audit_replay_opinions WHERE replay_id = ? AND idempotency_key = ?
    `).get(row.id, idempotencyKey);
    if (prior) {
      const fingerprint = requestFingerprintOf({ entryKey, kind, comment, reason });
      if (prior.request_hash !== fingerprint) {
        return { ok: false, status: 409, code: 'REPLAY_IDEMPOTENCY_CONFLICT', message: COMPARISON_ERRORS.REPLAY_IDEMPOTENCY_CONFLICT };
      }
      return { ok: true, replay: true, opinion: opinionPublic(prior), version: row.version };
    }

    const status = effectiveReplayStatus(row);
    if (status === 'paused') return { ok: false, status: 409, code: 'REPLAY_PAUSED', message: COMPARISON_ERRORS.REPLAY_PAUSED };
    if (status === 'cancelled') return { ok: false, status: 409, code: 'REPLAY_CANCELLED_READONLY', message: COMPARISON_ERRORS.REPLAY_CANCELLED_READONLY };
    if (status === 'expired') {
      markReplayExpiredTx(row, now());
      return { ok: false, status: 410, code: 'REPLAY_EXPIRED', message: COMPARISON_ERRORS.REPLAY_EXPIRED };
    }

    const frozenEvent = db.prepare('SELECT * FROM audit_replay_events WHERE replay_id = ? AND entry_key = ?').get(row.id, entryKey);
    if (!frozenEvent) {
      return { ok: false, status: 403, code: 'REPLAY_EVENT_OUT_OF_SCOPE', message: `${COMPARISON_ERRORS.REPLAY_EVENT_OUT_OF_SCOPE}：${entryKey}` };
    }

    // 同一事件的结论（确认/异议）只能落一个；重复确认返回明确错误（先于令牌/版本检查，
    // 使另一个页面用有效令牌并发确认时得到“已决定”而非泛化的令牌错误）
    if (kind === 'confirm' || kind === 'object') {
      const existing = db.prepare(`
        SELECT id, kind FROM audit_replay_opinions
        WHERE replay_id = ? AND entry_key = ? AND kind IN ('confirm', 'object')
      `).get(row.id, entryKey);
      if (existing) {
        return {
          ok: false, status: 409,
          code: 'REPLAY_ALREADY_DECIDED',
          message: existing.kind === 'confirm'
            ? '该事件已经被另一个页面确认，重复确认被拒绝'
            : '该事件已有异议结论，不能重复确认或再提异议',
          existingKind: existing.kind,
          currentVersion: row.version,
        };
      }
    }

    if (row.version !== expectedVersion) {
      return {
        ok: false, status: 409, code: 'REPLAY_VERSION_CONFLICT',
        message: COMPARISON_ERRORS.REPLAY_VERSION_CONFLICT, currentVersion: row.version,
      };
    }
    // 令牌只在确定可以写入时才校验并消费（前面的业务/版本错误不应让有效令牌作废）
    const tokenCheck = checkWriteTokenTx({ row, submitToken, ts: now() });
    if (!tokenCheck.ok) return tokenCheck;

    const ts = now();
    const id = cryptoId();
    db.prepare(`
      INSERT INTO audit_replay_opinions
        (id, replay_id, replay_event_id, entry_key, kind, comment, reason,
         idempotency_key, request_hash, replay_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, row.id, frozenEvent.id, entryKey, kind,
      kind === 'comment' ? comment : '', kind === 'object' ? reason : '',
      idempotencyKey, requestFingerprintOf({ entryKey, kind, comment, reason }),
      row.version + 1, ts,
    );
    db.prepare("UPDATE audit_replay_submit_tokens SET status = 'used', used_at = ?, used_opinion_id = ? WHERE id = ?")
      .run(ts, id, tokenCheck.token.id);

    const nextVersion = row.version + 1;
    const increment = kind === 'confirm' ? 'confirmed_count = confirmed_count + 1'
      : kind === 'object' ? 'objected_count = objected_count + 1'
        : 'comment_count = comment_count + 1';
    db.prepare(`
      UPDATE audit_replay_sessions SET version = ?, ${increment} WHERE id = ?
    `).run(nextVersion, row.id);

    addReplayAuditRowTx(row.id, kind === 'comment' ? 'replay.opinion' : `replay.${kind}`, {
      entryKey, opinionId: id, replayVersion: nextVersion,
    });

    const inserted = db.prepare('SELECT * FROM audit_replay_opinions WHERE id = ?').get(id);
    return { ok: true, replay: false, opinion: opinionPublic(inserted), version: nextVersion };
  });
}

function requestFingerprintOf(value) {
  return Buffer.from(stableStringify(value)).toString('base64url');
}

// 写操作的一次性令牌校验（不消费；由调用方在事务内标记 used）
function checkWriteTokenTx({ row, submitToken, ts }) {
  const actual = db.prepare(`
    SELECT * FROM audit_replay_submit_tokens WHERE replay_id = ? AND token_hash = ?
  `).get(row.id, sha256(submitToken));
  if (!actual) return { ok: false, status: 403, code: 'REPLAY_TOKEN_INVALID', message: COMPARISON_ERRORS.REPLAY_TOKEN_INVALID };
  if (actual.status === 'used') return { ok: false, status: 403, code: 'REPLAY_TOKEN_INVALID', message: '一次性提交令牌已使用，请重新获取' };
  if (actual.status === 'revoked') return { ok: false, status: 403, code: 'REPLAY_TOKEN_INVALID', message: '提交令牌已作废，请重新获取' };
  if (actual.expires_at <= ts) {
    db.prepare("UPDATE audit_replay_submit_tokens SET status = 'expired' WHERE id = ? AND status = 'active'").run(actual.id);
    return { ok: false, status: 410, code: 'REPLAY_TOKEN_EXPIRED', message: '提交令牌已过期，请重新获取' };
  }
  return { ok: true, token: actual };
}

export function pauseReplaySession({ userId, replayId, submitToken, expectedVersion, reason }) {
  return immediateTransaction(() => {
    const row = db.prepare('SELECT * FROM audit_replay_sessions WHERE id = ? AND owner_user_id = ?').get(replayId, userId);
    if (!row) return { ok: false, status: 404, code: 'REPLAY_NOT_FOUND', message: COMPARISON_ERRORS.REPLAY_NOT_FOUND };
    const status = effectiveReplayStatus(row);
    if (status === 'expired') { markReplayExpiredTx(row, now()); return { ok: false, status: 410, code: 'REPLAY_EXPIRED', message: COMPARISON_ERRORS.REPLAY_EXPIRED }; }
    if (status === 'cancelled') return { ok: false, status: 409, code: 'REPLAY_CANCELLED_READONLY', message: COMPARISON_ERRORS.REPLAY_CANCELLED_READONLY };
    if (status !== 'active') return { ok: false, status: 409, code: 'REPLAY_NOT_ACTIVE', message: '只有进行中的重放会话可以暂停' };
    const control = consumeControlTokenTx({ row, submitToken, expectedVersion });
    if (!control.ok) return control;
    const ts = now();
    const nextVersion = row.version + 1;
    db.prepare("UPDATE audit_replay_sessions SET status = 'paused', paused_at = ?, version = ? WHERE id = ?")
      .run(ts, nextVersion, row.id);
    addReplayAuditRowTx(row.id, 'replay.paused', { replayVersion: nextVersion, reason: reason || '' });
    return { ok: true, replay: getReplayForOwner({ userId, replayId: row.id }) };
  });
}

export function resumeReplaySession({ userId, replayId, submitToken, expectedVersion }) {
  return immediateTransaction(() => {
    const row = db.prepare('SELECT * FROM audit_replay_sessions WHERE id = ? AND owner_user_id = ?').get(replayId, userId);
    if (!row) return { ok: false, status: 404, code: 'REPLAY_NOT_FOUND', message: COMPARISON_ERRORS.REPLAY_NOT_FOUND };
    const status = effectiveReplayStatus(row);
    if (status === 'expired') { markReplayExpiredTx(row, now()); return { ok: false, status: 410, code: 'REPLAY_EXPIRED', message: COMPARISON_ERRORS.REPLAY_EXPIRED }; }
    if (status === 'cancelled') return { ok: false, status: 409, code: 'REPLAY_CANCELLED_READONLY', message: COMPARISON_ERRORS.REPLAY_CANCELLED_READONLY };
    if (status !== 'paused') return { ok: false, status: 409, code: 'REPLAY_NOT_PAUSED', message: COMPARISON_ERRORS.REPLAY_NOT_PAUSED };
    if (row.version !== expectedVersion) {
      return {
        ok: false, status: 409, code: 'REPLAY_VERSION_CONFLICT',
        message: COMPARISON_ERRORS.REPLAY_VERSION_CONFLICT, currentVersion: row.version,
      };
    }

    // 恢复必须重新确认：比较报告未被改写、两份归档摘要链仍连续、会话版本未变化
    const verification = verifyComparison(row.comparison_id);
    if (!verification.reportOk) {
      return {
        ok: false, status: 409, code: 'REPLAY_REPORT_INVALID',
        message: COMPARISON_ERRORS.REPLAY_REPORT_INVALID, verification,
      };
    }
    // 所有业务/版本/报告校验通过后才消费一次性令牌
    const control = consumeControlTokenTx({ row, submitToken, expectedVersion });
    if (!control.ok) return control;
    const ts = now();
    const nextVersion = row.version + 1;
    db.prepare("UPDATE audit_replay_sessions SET status = 'active', resumed_at = ?, version = ? WHERE id = ?")
      .run(ts, nextVersion, row.id);
    addReplayAuditRowTx(row.id, 'replay.resumed', { replayVersion: nextVersion });
    return { ok: true, replay: getReplayForOwner({ userId, replayId: row.id }), verification };
  });
}

export function cancelReplaySession({ userId, replayId, submitToken, expectedVersion, reason }) {
  return immediateTransaction(() => {
    const row = db.prepare('SELECT * FROM audit_replay_sessions WHERE id = ? AND owner_user_id = ?').get(replayId, userId);
    if (!row) return { ok: false, status: 404, code: 'REPLAY_NOT_FOUND', message: COMPARISON_ERRORS.REPLAY_NOT_FOUND };
    const status = effectiveReplayStatus(row);
    if (status === 'expired') { markReplayExpiredTx(row, now()); return { ok: false, status: 410, code: 'REPLAY_EXPIRED', message: COMPARISON_ERRORS.REPLAY_EXPIRED }; }
    if (status === 'cancelled') return { ok: false, status: 409, code: 'REPLAY_ALREADY_CANCELLED', message: COMPARISON_ERRORS.REPLAY_ALREADY_CANCELLED };
    if (!['active', 'paused'].includes(status)) {
      return { ok: false, status: 409, code: 'REPLAY_NOT_CANCELLABLE', message: COMPARISON_ERRORS.REPLAY_NOT_CANCELLABLE };
    }
    const control = consumeControlTokenTx({ row, submitToken, expectedVersion });
    if (!control.ok) return control;
    const ts = now();
    const nextVersion = row.version + 1;
    db.prepare(`
      UPDATE audit_replay_sessions
      SET status = 'cancelled', cancelled_at = ?, cancel_reason = ?, version = ?, completed_at = ?
      WHERE id = ?
    `).run(ts, String(reason || '').slice(0, 200), nextVersion, ts, row.id);
    // 未使用令牌全部作废；历史意见与审计行原样保留
    db.prepare("UPDATE audit_replay_submit_tokens SET status = 'revoked', revoked_at = ? WHERE replay_id = ? AND status = 'active' AND used_at IS NULL")
      .run(ts, row.id);
    addReplayAuditRowTx(row.id, 'replay.cancelled', { replayVersion: nextVersion, reason: String(reason || '').slice(0, 200) });
    return { ok: true, replay: getReplayForOwner({ userId, replayId: row.id }) };
  });
}

// 后台扫描：过期会话落定为 expired（只改会话/令牌状态，历史意见与审计行不动）
export function sweepReplaySessions() {
  const ts = now();
  const expiredRows = db.prepare(`
    SELECT id FROM audit_replay_sessions WHERE status IN ('active', 'paused') AND expires_at <= ?
  `).all(ts);
  for (const row of expiredRows) {
    immediateTransaction(() => {
      const latest = db.prepare('SELECT * FROM audit_replay_sessions WHERE id = ?').get(row.id);
      if (!latest || !['active', 'paused'].includes(latest.status) || latest.expires_at > ts) return;
      db.prepare("UPDATE audit_replay_sessions SET status = 'expired', completed_at = ? WHERE id = ?").run(ts, latest.id);
      db.prepare("UPDATE audit_replay_submit_tokens SET status = 'expired' WHERE replay_id = ? AND status = 'active' AND used_at IS NULL").run(latest.id);
      db.prepare(`
        INSERT INTO audit_replay_audit (id, replay_id, type, detail_json, created_at)
        VALUES (?, ?, 'replay.expired', '{}', ?)
      `).run(cryptoId(), latest.id, ts);
    });
  }
  return { expired: expiredRows.length };
}
