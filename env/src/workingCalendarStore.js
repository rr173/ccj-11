// ---------------------------------------------------------------------------
// 可版本化工作日历：持久化与事务编排
//
// 版本表 working_calendars 只追加：发布即冻结，没有任何 UPDATE/DELETE 路径；
// working_calendar_pointer 单行指向“当前生效版本”，新异议在创建时固定该版本。
// version=0 是兼容旧库的全天 24 小时日历（legacy-v0）：旧异议的 deadline_at
// 是自然日 TTL 直接相加，暂停/恢复按毫秒平移，不按工作时段重算。
//
// 异议时钟的统一模型：
//   anchor_at         本轮计时起点（创建/恢复/迁移/延期批准的时刻）
//   remaining_minutes 从 anchor 起还剩多少工作分钟（暂停时冻结）
//   deadline_at       advanceWorkingMinutes(anchor, remaining) 的结果
// 暂停（处理人要求补充材料）：按固定日历计算 anchor→now 已消耗的工作分钟，
//   扣减 remaining 并冻结；调度器不再提醒/标记逾期。
// 恢复（办理人补交）：以恢复时刻为新 anchor，重新推进剩余工作分钟得到新截止
//   时间，非工作时段自动顺延；逐段顺延原因写入计时台账。
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';
import { db, immediateTransaction, cryptoId } from './db.js';
import { config } from './config.js';
import { appendObjectionEventTx } from './receiptObjectionStore.js';
import {
  advanceWorkingMinutes,
  buildCalendar,
  deserializeCalendar,
  parseCalendarConfig,
  serializeCalendar,
  workingMinutesBetween,
} from './workingCalendars.js';

function now() {
  return Date.now();
}

export const LEGACY_CALENDAR_ID = 'legacy-v0';

// 兼容旧库的全天日历：advance 结果即自然时间相加
function buildLegacyCalendar() {
  return buildCalendar({
    timezone: 'UTC',
    weeklyWindows: Array.from({ length: 7 }, () => [[0, 24 * 60]]),
    holidays: new Map(),
    closures: new Map(),
  });
}

function digestOf(text) {
  return createHash('sha256').update(text).digest('hex');
}

// ---------------------------------------------------------------------------
// 初始化（db.js 建表后调用；幂等，旧库只补一次）
// ---------------------------------------------------------------------------
export function seedWorkingCalendars() {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM working_calendars').get().c;
  if (existing > 0) return;
  const ts = now();
  const legacyContent = serializeCalendar(buildLegacyCalendar());
  db.prepare(`
    INSERT INTO working_calendars (id, version, status, timezone, content_json, content_digest, note, created_by_user_id, created_at)
    VALUES (?, 0, 'legacy', 'UTC', ?, ?, '系统内置：全天 24 小时兼容日历（旧异议沿用自然日期限）', NULL, ?)
  `).run(LEGACY_CALENDAR_ID, legacyContent, digestOf(legacyContent), ts);

  const parsed = parseCalendarConfig({});
  if (!parsed.ok) throw new Error(`默认工作日历配置无效：${parsed.message}`);
  const content = serializeCalendar(parsed.value);
  const id = cryptoId();
  db.prepare(`
    INSERT INTO working_calendars (id, version, status, timezone, content_json, content_digest, note, created_by_user_id, created_at)
    VALUES (?, 1, 'published', ?, ?, ?, '系统初始化默认工作日历（周一至周五 09:00-12:00、13:30-17:30）', NULL, ?)
  `).run(id, parsed.value.timezone, content, digestOf(content), ts);
  db.prepare(`
    INSERT INTO working_calendar_pointer (id, calendar_version_id, version, updated_at)
    VALUES (1, ?, 1, ?)
  `).run(id, ts);
}

// ---------------------------------------------------------------------------
// 发布新版本（只追加；发布后即成为当前生效版本）
// ---------------------------------------------------------------------------
export function publishCalendarVersion({ userId, config: rawConfig, note = '' }) {
  const parsed = parseCalendarConfig(rawConfig);
  if (!parsed.ok) return parsed;
  const trimmedNote = String(note || '').trim().slice(0, 300);
  return immediateTransaction(() => {
    const nextVersion = (db.prepare('SELECT COALESCE(MAX(version), 0) + 1 AS v FROM working_calendars').get().v);
    const id = cryptoId();
    const ts = now();
    const content = serializeCalendar(parsed.value);
    db.prepare(`
      INSERT INTO working_calendars (id, version, status, timezone, content_json, content_digest, note, created_by_user_id, created_at)
      VALUES (?, ?, 'published', ?, ?, ?, ?, ?, ?)
    `).run(id, nextVersion, parsed.value.timezone, content, digestOf(content), trimmedNote, userId, ts);
    db.prepare(`
      INSERT INTO working_calendar_pointer (id, calendar_version_id, version, updated_at)
      VALUES (1, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        calendar_version_id = excluded.calendar_version_id,
        version = excluded.version,
        updated_at = excluded.updated_at
    `).run(id, nextVersion, ts);
    return { ok: true, calendar: calendarVersionRow(db.prepare('SELECT * FROM working_calendars WHERE id = ?').get(id)) };
  });
}

// ---------------------------------------------------------------------------
// 查询
// ---------------------------------------------------------------------------
export function getCurrentCalendarVersion() {
  const pointer = db.prepare('SELECT * FROM working_calendar_pointer WHERE id = 1').get();
  if (!pointer) return null;
  return calendarVersionRow(
    db.prepare('SELECT * FROM working_calendars WHERE id = ?').get(pointer.calendar_version_id),
  );
}

export function listCalendarVersions() {
  return db.prepare('SELECT * FROM working_calendars ORDER BY version DESC')
    .all()
    .map((row) => calendarVersionRow(row));
}

export function getCalendarVersionById(id) {
  const row = db.prepare('SELECT * FROM working_calendars WHERE id = ?').get(id);
  return row ? calendarVersionRow(row) : null;
}

export function getCalendarVersionByVersion(version) {
  const row = db.prepare('SELECT * FROM working_calendars WHERE version = ?').get(version);
  return row ? calendarVersionRow(row) : null;
}

// 取出异议固定日历的可计算对象；version=0 走内置全天日历
export function resolveObjectionCalendar(objection) {
  if (!objection.calendar_version_id || objection.calendar_version_id === LEGACY_CALENDAR_ID
    || objection.calendar_version === 0) {
    return {
      legacy: true,
      version: 0,
      versionId: LEGACY_CALENDAR_ID,
      calendar: buildLegacyCalendar(),
      row: null,
    };
  }
  const row = db.prepare('SELECT * FROM working_calendars WHERE id = ?').get(objection.calendar_version_id);
  if (!row) {
    // 异常防御：找不到已发布版本时退化为全天日历并明确标记，绝不静默改变计时
    return {
      legacy: true,
      version: objection.calendar_version,
      versionId: objection.calendar_version_id,
      calendar: buildLegacyCalendar(),
      row: null,
      missing: true,
    };
  }
  return {
    legacy: false,
    version: row.version,
    versionId: row.id,
    calendar: deserializeCalendar(row.content_json),
    row: calendarVersionRow(row),
  };
}

const WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function minuteToHHMM(min) {
  return `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
}

export function summarizeWeeklyWindows(weeklyWindows) {
  return weeklyWindows.map((windows, index) => ({
    weekday: index + 1,
    weekdayLabel: WEEKDAY_NAMES[index],
    windows: windows.map(([start, end]) => ({
      start: minuteToHHMM(start), end: minuteToHHMM(end), startMinute: start, endMinute: end,
    })),
    closed: windows.length === 0,
  }));
}

function calendarVersionRow(row) {
  if (!row) return null;
  const parsed = deserializeCalendar(row.content_json);
  return {
    id: row.id,
    version: row.version,
    status: row.status,
    legacy: row.version === 0,
    timezone: row.timezone,
    note: row.note || '',
    createdAt: row.created_at,
    createdByUserId: row.created_by_user_id || null,
    contentDigest: row.content_digest,
    config: {
      timezone: parsed.timezone,
      weeklyWindows: summarizeWeeklyWindows(parsed.weeklyWindows),
      holidays: [...parsed.holidays.entries()].map(([date, name]) => ({ date, name })),
      closures: [...parsed.closures.entries()].map(([date, note]) => ({ date, note })),
    },
  };
}

// ---------------------------------------------------------------------------
// 新异议：按当前生效版本计算初始截止时间（纯计算，须在写事务内调用）
// ---------------------------------------------------------------------------
export function initialScheduleForObjection(createdAt) {
  // 兼容模式（测试或纯自然日部署）：新异议固定 v0 全天日历，期限 = TTL 自然毫秒
  if (config.calendarLegacyDefault) {
    return {
      calendarVersionId: LEGACY_CALENDAR_ID,
      calendarVersion: 0,
      slaMinutes: Math.round(config.receiptObjectionTtlMs / 60000),
      anchorAt: createdAt,
      remainingMinutes: 0,
      deadlineAt: createdAt + config.receiptObjectionTtlMs,
      segments: [{
        from: createdAt, to: createdAt + config.receiptObjectionTtlMs,
        kind: 'work', working: true, reason: '全天 24 小时兼容日历：自然日期限直接相加',
      }],
    };
  }
  const current = getCurrentCalendarVersion();
  if (!current) throw new Error('工作日历尚未初始化');
  const slaMinutes = config.receiptObjectionSlaMinutes;
  const calendar = deserializeCalendar(
    db.prepare('SELECT content_json FROM working_calendars WHERE id = ?').get(current.id).content_json,
  );
  const result = advanceWorkingMinutes(calendar, createdAt, slaMinutes);
  return {
    calendarVersionId: current.id,
    calendarVersion: current.version,
    slaMinutes,
    anchorAt: createdAt,
    remainingMinutes: slaMinutes,
    deadlineAt: result.deadlineAt,
    segments: result.segments,
  };
}

// ---------------------------------------------------------------------------
// 暂停 / 恢复（由异议状态机事务调用）
// ---------------------------------------------------------------------------

// 暂停：冻结剩余办理时长。返回写入暂停行所需的字段。
export function pauseObjectionClockTx(objection, ts) {
  const resolved = resolveObjectionCalendar(objection);
  if (resolved.legacy) {
    // 旧异议：按自然毫秒冻结“截止时间与暂停时刻的差”，恢复时平移
    return {
      legacy: true,
      remainingMinutes: 0,
      pausedOffsetMs: Math.max(0, objection.deadline_at - ts),
    };
  }
  const anchorAt = objection.anchor_at || objection.created_at;
  const consumed = workingMinutesBetween(resolved.calendar, anchorAt, ts);
  const remainingMinutes = Math.max(0, (objection.remaining_minutes || objection.sla_minutes) - consumed);
  return { legacy: false, remainingMinutes, pausedOffsetMs: 0 };
}

// 恢复：从剩余工作分钟继续计算。返回新截止时间与逐段顺延说明。
export function resumeObjectionClockTx(objection, pauseRow, ts) {
  const resolved = resolveObjectionCalendar(objection);
  if (resolved.legacy) {
    const offsetMs = pauseRow.paused_offset_ms || Math.max(0, objection.deadline_at - pauseRow.paused_at);
    const deadlineAt = ts + offsetMs;
    return {
      legacy: true,
      deadlineAt,
      anchorAt: ts,
      remainingMinutes: 0,
      segments: offsetMs > 0 ? [{
        from: ts, to: deadlineAt, kind: 'work', working: true, reason: '全天 24 小时兼容日历：剩余自然时间直接平移',
      }] : [],
    };
  }
  const remainingMinutes = pauseRow.remaining_minutes_at_pause;
  const result = remainingMinutes > 0
    ? advanceWorkingMinutes(resolved.calendar, ts, remainingMinutes)
    : { deadlineAt: ts, segments: [] };
  return {
    legacy: false,
    deadlineAt: result.deadlineAt,
    anchorAt: ts,
    remainingMinutes,
    segments: result.segments,
  };
}

// 主管批准延期：日历版按工作分钟顺延；暂停期间只增加冻结的剩余时长
export function extendObjectionClockTx(objection, extensionMinutes, ts) {
  const resolved = resolveObjectionCalendar(objection);
  if (resolved.legacy) {
    const base = Math.max(objection.deadline_at, ts);
    return { legacy: true, deadlineAt: base + extensionMinutes * 60000, segments: [] };
  }
  const paused = objection.status === 'supplementing';
  if (paused) {
    // 暂停中：延期加到冻结的剩余分钟上，截止时间在恢复时才重算
    return { legacy: false, deadlineAt: objection.deadline_at, paused: true, addedMinutes: extensionMinutes };
  }
  const base = Math.max(objection.deadline_at, ts);
  const result = advanceWorkingMinutes(resolved.calendar, base, extensionMinutes);
  return { legacy: false, deadlineAt: result.deadlineAt, paused: false, addedMinutes: extensionMinutes, segments: result.segments };
}

// ---------------------------------------------------------------------------
// 计时台账（只追加）
// ---------------------------------------------------------------------------
export function appendTimingTx({ objection, type, fromAt = null, toAt = null, detail = {}, actorUserId = null, actorRole = 'system', createdAt = now() }) {
  const ordinal = db.prepare(`
    SELECT COALESCE(MAX(ordinal), -1) + 1 AS next_ordinal
    FROM receipt_objection_timing WHERE objection_id = ?
  `).get(objection.id).next_ordinal;
  const id = cryptoId();
  db.prepare(`
    INSERT INTO receipt_objection_timing
      (id, objection_id, ordinal, type, from_at, to_at, detail_json, actor_user_id, actor_role, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, objection.id, ordinal, type, fromAt, toAt,
    JSON.stringify(detail), actorUserId, actorRole, createdAt);
  return { id, ordinal };
}

function timingRow(row) {
  return {
    id: row.id,
    ordinal: row.ordinal,
    type: row.type,
    fromAt: row.from_at,
    toAt: row.to_at,
    detail: JSON.parse(row.detail_json || '{}'),
    actorRole: row.actor_role,
    actorUserId: row.actor_user_id,
    createdAt: row.created_at,
  };
}

export function listObjectionTiming(objectionId) {
  return db.prepare(`
    SELECT * FROM receipt_objection_timing WHERE objection_id = ? ORDER BY ordinal ASC
  `).all(objectionId).map(timingRow);
}

export function listObjectionPauses(objectionId) {
  return db.prepare(`
    SELECT * FROM receipt_objection_pauses WHERE objection_id = ? ORDER BY ordinal ASC
  `).all(objectionId).map((row) => ({
    id: row.id,
    ordinal: row.ordinal,
    status: row.status,
    pausedAt: row.paused_at,
    resumedAt: row.resumed_at || null,
    remainingMinutesAtPause: row.remaining_minutes_at_pause,
    pausedOffsetMs: row.paused_offset_ms || 0,
    note: row.note || '',
    requestedByUserId: row.requested_by_user_id || null,
    resumedByUserId: row.resumed_by_user_id || null,
  }));
}

export function listObjectionMigrations(objectionId) {
  return db.prepare(`
    SELECT * FROM objection_calendar_migrations WHERE objection_id = ? ORDER BY created_at ASC
  `).all(objectionId).map((row) => ({
    id: row.id,
    previewId: row.preview_id,
    fromVersionId: row.from_calendar_version_id,
    toVersionId: row.to_calendar_version_id,
    previousDeadlineAt: row.previous_deadline_at,
    newDeadlineAt: row.new_deadline_at,
    previousRemainingMinutes: row.previous_remaining_minutes,
    newRemainingMinutes: row.new_remaining_minutes,
    migratedByUserId: row.migrated_by_user_id || null,
    createdAt: row.created_at,
  }));
}

// ---------------------------------------------------------------------------
// 日历迁移：预览 → 按预览版本确认
// ---------------------------------------------------------------------------

const MIGRATION_SCOPE_OPEN = ['submitted', 'accepted', 'supplementing'];

function migrationItemCandidate(row, target, at) {
  const targetCalendar = deserializeCalendar(
    db.prepare('SELECT content_json FROM working_calendars WHERE id = ?').get(target.id).content_json,
  );
  const resolved = resolveObjectionCalendar(row);
  const overdue = Boolean(row.overdue_at) || row.deadline_at <= at;
  const base = {
    objectionId: row.id,
    objectionNo: row.objection_no,
    receiptNo: row.receipt_no,
    status: row.status,
    paused: row.status === 'supplementing',
    assigneeUserId: row.assignee_user_id,
    fromVersion: resolved.version,
    fromVersionId: resolved.versionId,
    toVersion: target.version,
    currentDeadlineAt: row.deadline_at,
    overdue,
  };
  // 终结异议永不迁移，在预览中明确列出排除原因
  if (!MIGRATION_SCOPE_OPEN.includes(row.status)) {
    return { ...base, eligible: false, excludeReason: 'terminal', prospectiveDeadlineAt: row.deadline_at };
  }
  if (overdue) {
    return { ...base, eligible: false, excludeReason: 'overdue', prospectiveDeadlineAt: row.deadline_at };
  }
  if (row.status === 'supplementing') {
    // 暂停期间不重算截止时间：恢复时自然按新版本继续
    return {
      ...base,
      eligible: true,
      remainingMinutes: row.remaining_minutes,
      prospectiveDeadlineAt: row.deadline_at,
      deadlineChange: 'on-resume',
    };
  }
  const anchorAt = row.anchor_at || row.created_at;
  const consumed = resolved.legacy
    ? Math.max(0, Math.round((at - anchorAt) / 60000))
    : workingMinutesBetween(resolved.calendar, anchorAt, at);
  const remainingMinutes = Math.max(0, (row.remaining_minutes || row.sla_minutes) - consumed);
  const prospective = remainingMinutes > 0
    ? advanceWorkingMinutes(targetCalendar, at, remainingMinutes)
    : { deadlineAt: at, segments: [] };
  return {
    ...base,
    eligible: true,
    remainingMinutes,
    prospectiveDeadlineAt: prospective.deadlineAt,
    prospectiveSegments: prospective.segments,
    deadlineChange: prospective.deadlineAt === row.deadline_at ? 'unchanged' : 'recomputed',
  };
}

export function previewObjectionCalendarMigration({ userId, targetVersionId = null, note = '' }) {
  return immediateTransaction(() => {
    const target = targetVersionId
      ? db.prepare('SELECT * FROM working_calendars WHERE id = ? AND status = ?').get(targetVersionId, 'published')
      : db.prepare(`
          SELECT c.* FROM working_calendars c
          JOIN working_calendar_pointer p ON p.calendar_version_id = c.id
          WHERE p.id = 1
        `).get();
    if (!target) {
      return { ok: false, status: 404, code: 'CALENDAR_VERSION_NOT_FOUND', message: '目标日历版本不存在或未发布' };
    }
    const at = now();
    const rows = db.prepare(`
      SELECT * FROM receipt_objections
      WHERE calendar_version_id <> ?
      ORDER BY created_at ASC
    `).all(target.id);
    const items = rows.map((row) => migrationItemCandidate(row, target, at));
    const eligible = items.filter((item) => item.eligible);
    const excluded = items.filter((item) => !item.eligible)
      .map((item) => ({
        objectionId: item.objectionId,
        objectionNo: item.objectionNo,
        receiptNo: item.receiptNo,
        status: item.status,
        reason: item.excludeReason,
        currentDeadlineAt: item.currentDeadlineAt,
      }));
    // 摘要只取会影响确认结果的稳定字段，渲染字段不入摘要
    const digestSource = JSON.stringify({
      targetVersion: target.version,
      items: items.map((item) => [
        item.objectionId, item.status, item.currentDeadlineAt, item.prospectiveDeadlineAt,
        item.eligible, item.excludeReason || '', item.fromVersionId,
      ]),
    });
    const digest = digestOf(digestSource);
    const id = cryptoId();
    db.prepare(`
      INSERT INTO objection_calendar_previews
        (id, from_calendar_version_id, target_calendar_version_id, target_version, digest,
         items_json, eligible_count, excluded_count, note, created_by_user_id, created_at, status)
      VALUES (?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open')
    `).run(
      id, target.id, target.version, digest,
      JSON.stringify({ items, at }), eligible.length, excluded.length,
      String(note || '').trim().slice(0, 300), userId, at,
    );
    return {
      ok: true,
      preview: migrationPreviewRow({
        ...db.prepare('SELECT * FROM objection_calendar_previews WHERE id = ?').get(id),
        items,
      }),
    };
  });
}

function migrationPreviewRow(row) {
  const parsed = JSON.parse(row.items_json || '{}');
  return {
    id: row.id,
    targetVersionId: row.target_calendar_version_id,
    targetVersion: row.target_version,
    digest: row.digest,
    status: row.status,
    note: row.note || '',
    createdAt: row.created_at,
    generatedAt: parsed.at || row.created_at,
    eligibleCount: row.eligible_count,
    excludedCount: row.excluded_count,
    items: (parsed.items || []).map((item) => ({
      objectionId: item.objectionId,
      objectionNo: item.objectionNo,
      receiptNo: item.receiptNo,
      status: item.status,
      paused: item.paused,
      fromVersion: item.fromVersion,
      currentDeadlineAt: item.currentDeadlineAt,
      prospectiveDeadlineAt: item.prospectiveDeadlineAt,
      remainingMinutes: item.remainingMinutes ?? null,
      deadlineChange: item.deadlineChange || (item.eligible ? 'recomputed' : 'none'),
      eligible: item.eligible,
      excludeReason: item.excludeReason || null,
      prospectiveSegments: item.prospectiveSegments || [],
    })),
  };
}

export function getMigrationPreview(previewId) {
  const row = db.prepare('SELECT * FROM objection_calendar_previews WHERE id = ?').get(previewId);
  return row ? migrationPreviewRow(row) : null;
}

export function listMigrationPreviews() {
  return db.prepare('SELECT * FROM objection_calendar_previews ORDER BY created_at DESC LIMIT 50')
    .all()
    .map((row) => migrationPreviewRow(row));
}

// 按预览版本确认迁移：任何一条候选在预览后变化（终结/逾期/已换版）都整体中止，
// 返回冲突清单；主管需重新生成预览。已经逾期或终结的异议绝不迁移。
export function confirmObjectionCalendarMigration({ userId, previewId, digest }) {
  return immediateTransaction(() => {
    const previewRow = db.prepare('SELECT * FROM objection_calendar_previews WHERE id = ?').get(previewId);
    if (!previewRow) {
      return { ok: false, status: 404, code: 'MIGRATION_PREVIEW_NOT_FOUND', message: '迁移预览不存在' };
    }
    if (previewRow.status !== 'open') {
      return { ok: false, status: 409, code: 'MIGRATION_PREVIEW_CLOSED', message: '该迁移预览已确认或已失效' };
    }
    if (digest !== previewRow.digest) {
      return {
        ok: false, status: 409, code: 'MIGRATION_PREVIEW_DIGEST_MISMATCH',
        message: '预览内容摘要不一致，请重新生成预览后再确认',
      };
    }
    const target = db.prepare('SELECT * FROM working_calendars WHERE id = ?').get(previewRow.target_calendar_version_id);
    if (!target) {
      return { ok: false, status: 404, code: 'CALENDAR_VERSION_NOT_FOUND', message: '目标日历版本不存在' };
    }
    const targetCalendar = deserializeCalendar(target.content_json);
    const parsed = JSON.parse(previewRow.items_json || '{}');
    const items = parsed.items || [];
    const at = now();

    // 1) 先做全部冲突检查（任一冲突则整体不落任何变更）
    const conflicts = [];
    for (const item of items.filter((candidate) => candidate.eligible)) {
      const current = db.prepare('SELECT * FROM receipt_objections WHERE id = ?').get(item.objectionId);
      if (!current) {
        conflicts.push({ objectionNo: item.objectionNo, reason: 'missing' });
        continue;
      }
      if (!MIGRATION_SCOPE_OPEN.includes(current.status)) {
        conflicts.push({ objectionNo: item.objectionNo, reason: 'terminal', status: current.status });
        continue;
      }
      if (current.overdue_at || current.deadline_at <= at) {
        conflicts.push({ objectionNo: item.objectionNo, reason: 'overdue' });
        continue;
      }
      if (current.calendar_version_id !== item.fromVersionId) {
        conflicts.push({ objectionNo: item.objectionNo, reason: 'version-changed', currentVersion: current.calendar_version });
        continue;
      }
    }
    if (conflicts.length > 0) {
      return {
        ok: false, status: 409, code: 'MIGRATION_CONFLICT',
        message: '清单中的异议在预览后发生变化，已中止迁移；请重新预览受影响清单',
        conflicts,
      };
    }

    // 2) 全部无冲突：逐条换版（运行中重算截止；暂停中只换版本，恢复时再重算）
    const migrated = [];
    for (const item of items.filter((candidate) => candidate.eligible)) {
      const current = db.prepare('SELECT * FROM receipt_objections WHERE id = ?').get(item.objectionId);
      const previousDeadline = current.deadline_at;
      const previousRemaining = current.remaining_minutes;
      let newDeadline = previousDeadline;
      let newRemaining = previousRemaining;
      let newAnchor = current.anchor_at;
      let prospectSegments = [];
      if (current.status !== 'supplementing') {
        const resolved = resolveObjectionCalendar(current);
        const anchorAt = current.anchor_at || current.created_at;
        const consumed = resolved.legacy
          ? Math.max(0, Math.round((at - anchorAt) / 60000))
          : workingMinutesBetween(resolved.calendar, anchorAt, at);
        newRemaining = Math.max(0, (current.remaining_minutes || current.sla_minutes) - consumed);
        const prospect = newRemaining > 0
          ? advanceWorkingMinutes(targetCalendar, at, newRemaining)
          : { deadlineAt: at, segments: [] };
        newDeadline = prospect.deadlineAt;
        newAnchor = at;
        prospectSegments = prospect.segments;
      }
      db.prepare(`
        UPDATE receipt_objections
        SET calendar_version_id = ?, calendar_version = ?,
            deadline_at = ?, anchor_at = ?, remaining_minutes = ?, overdue_at = NULL
        WHERE id = ?
      `).run(target.id, target.version, newDeadline, newAnchor, newRemaining, current.id);
      const migrationId = cryptoId();
      db.prepare(`
        INSERT INTO objection_calendar_migrations
          (id, preview_id, objection_id, from_calendar_version_id, to_calendar_version_id,
           previous_deadline_at, new_deadline_at, previous_remaining_minutes, new_remaining_minutes,
           migrated_by_user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        migrationId, previewRow.id, current.id, current.calendar_version_id, target.id,
        previousDeadline, newDeadline, previousRemaining, newRemaining, userId, at,
      );
      const updated = db.prepare('SELECT * FROM receipt_objections WHERE id = ?').get(current.id);
      appendObjectionEventTx({
        objection: updated,
        type: 'receipt.objection.calendar.migrated',
        actorUserId: userId,
        actorRole: 'supervisor',
        note: `日历版本迁移：v${item.fromVersion} → v${target.version}`,
        extra: {
          previewId: previewRow.id,
          fromVersion: item.fromVersion,
          toVersion: target.version,
          previousDeadlineAt: previousDeadline,
          newDeadlineAt: newDeadline,
          paused: current.status === 'supplementing',
        },
      });
      appendTimingTx({
        objection: updated,
        type: 'migration',
        fromAt: previousDeadline,
        toAt: newDeadline,
        actorUserId: userId,
        actorRole: 'supervisor',
        detail: {
          previewId: previewRow.id,
          fromVersion: item.fromVersion,
          fromVersionId: item.fromVersionId,
          toVersion: target.version,
          toVersionId: target.id,
          paused: current.status === 'supplementing',
          previousDeadlineAt: previousDeadline,
          newDeadlineAt: newDeadline,
          previousRemainingMinutes: previousRemaining,
          newRemainingMinutes: newRemaining,
          segments: prospectSegments,
        },
        createdAt: at,
      });
      migrated.push({ objectionNo: current.objection_no, previousDeadlineAt: previousDeadline, newDeadlineAt: newDeadline });
    }

    db.prepare(`
      UPDATE objection_calendar_previews SET status = 'applied' WHERE id = ?
    `).run(previewRow.id);
    return {
      ok: true,
      migratedCount: migrated.length,
      migrated,
      preview: migrationPreviewRow(db.prepare('SELECT * FROM objection_calendar_previews WHERE id = ?').get(previewRow.id)),
    };
  });
}

// 审计视图：全部迁移留档（可按异议过滤）
export function listAllCalendarMigrationsForAuditor({ objectionId = null } = {}) {
  const rows = objectionId
    ? db.prepare('SELECT * FROM objection_calendar_migrations WHERE objection_id = ? ORDER BY created_at ASC').all(objectionId)
    : db.prepare('SELECT * FROM objection_calendar_migrations ORDER BY created_at DESC LIMIT 500').all();
  return rows.map((row) => {
    const objection = db.prepare('SELECT objection_no, receipt_no FROM receipt_objections WHERE id = ?').get(row.objection_id);
    const fromVersion = db.prepare('SELECT version FROM working_calendars WHERE id = ?').get(row.from_calendar_version_id);
    const toVersion = db.prepare('SELECT version FROM working_calendars WHERE id = ?').get(row.to_calendar_version_id);
    return {
      id: row.id,
      objectionId: row.objection_id,
      objectionNo: objection?.objection_no || '',
      receiptNo: objection?.receipt_no || '',
      previewId: row.preview_id,
      fromVersion: fromVersion?.version ?? 0,
      toVersion: toVersion?.version ?? null,
      previousDeadlineAt: row.previous_deadline_at,
      newDeadlineAt: row.new_deadline_at,
      previousRemainingMinutes: row.previous_remaining_minutes,
      newRemainingMinutes: row.new_remaining_minutes,
      migratedByUserId: row.migrated_by_user_id || null,
      createdAt: row.created_at,
    };
  });
}

// 异议视图附加的日历/计时信息
export function calendarContextForObjection(objectionRow) {
  const resolved = resolveObjectionCalendar(objectionRow);
  return {
    calendarVersion: resolved.version,
    calendarVersionId: resolved.versionId,
    calendarTimezone: resolved.calendar.timezone,
    calendarNote: resolved.row?.note || (resolved.legacy ? '全天 24 小时兼容日历（自然日期限）' : ''),
    slaMinutes: objectionRow.sla_minutes || 0,
    remainingMinutes: objectionRow.remaining_minutes || 0,
    anchorAt: objectionRow.anchor_at || objectionRow.created_at,
    legacy: resolved.legacy,
    schedule: resolved.row
      ? resolved.row.config.weeklyWindows
      : summarizeWeeklyWindows(resolved.calendar.weeklyWindows),
    paused: objectionRow.status === 'supplementing',
  };
}
