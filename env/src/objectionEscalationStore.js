// ---------------------------------------------------------------------------
// 异议超期升级与通知留痕：持久化与事务编排
//
// 所有写操作都在 BEGIN IMMEDIATE 事务中完成，并发安全由三道防线保证：
//   1. 通知的部分唯一索引 (objection_id, kind, dedupe_key, audience, target_user_id)
//      ——重复调度 / 定时器重入 / 重启补扫只放行一条，其余 INSERT OR IGNORE 静默跳过；
//   2. 逾期标记使用 UPDATE ... WHERE overdue_at IS NULL 的条件更新，
//      只有首个事务会生成逾期事件与升级通知；
//   3. 延期申请的 UNIQUE(objection_id, ordinal) 与主管决议的
//      UPDATE ... WHERE status='pending' 条件更新——并发申请只成功一次，
//      主管重复点击 / 双击不会产生两次批准。
// 所有提醒、升级、确认已读、延期动作都向 receipt_objection_events 追加事件，
// 历史事件没有任何 UPDATE/DELETE 路径。
// ---------------------------------------------------------------------------
import { db, immediateTransaction, cryptoId, userQueries } from './db.js';
import { config } from './config.js';
import { appendObjectionEventTx } from './receiptObjectionStore.js';
import { RECEIPT_OBJECTION_OPEN_STATUSES } from './receiptObjections.js';
import {
  buildNotificationPayload,
  overdueDedupeKey,
  reminderDedupeKey,
} from './objectionEscalations.js';
import { appendTimingTx, extendObjectionClockTx } from './workingCalendarStore.js';

function now() {
  return Date.now();
}

const NOTIFICATION_INSERT = `
  INSERT OR IGNORE INTO receipt_objection_notifications
    (id, objection_id, receipt_no, kind, dedupe_key, audience, target_user_id,
     level, payload_json, status, created_at, sent_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, NULL)
`;

function prepareInsert(statement, {
  objection, kind, dedupeKey, audience, targetUserId = null, level = 1, payload, createdAt,
}) {
  return statement.run(
    cryptoId(), objection.id, objection.receipt_no, kind, dedupeKey,
    audience, targetUserId, level, JSON.stringify(payload), createdAt,
  );
}

// 为处理人（定向）与办理人（定向）生成同组通知；返回真正插入的接收方列表
function insertAudienceRowsTx(statement, {
  objection, kind, dedupeKey, level, payload, audiences, createdAt,
}) {
  const inserted = [];
  for (const audience of audiences) {
    const targetUserId = audience === 'processor'
      ? objection.assignee_user_id
      : audience === 'handler'
        ? objection.user_id
        : null;
    const result = prepareInsert(statement, {
      objection, kind, dedupeKey, audience, targetUserId, level, payload, createdAt,
    });
    if (result.changes > 0) inserted.push({ audience, targetUserId });
  }
  return inserted;
}

// ---------------------------------------------------------------------------
// 调度器：到期前提醒 + 逾期标记升级
//
// 幂等：可被定时器高频重复调用，也可在启动恢复时调用；
// 唯一索引保证同一提醒序位 / 同一升级层级只生成一次。
// at 参数仅用于测试（注入“当前时间”），生产环境取 Date.now()。
// ---------------------------------------------------------------------------
export function sweepObjectionNotifications({ at = Date.now(), dispatch = true } = {}) {
  // 生成与发送分属两个顺序执行的事务（同连接不嵌套事务）；
  // 重启后补扫只发送此前漏发的通知，不重复生成。
  let stats;
  immediateTransaction(() => {
    stats = generateDueNotificationsTx(at);
  });
  stats.dispatched = 0;
  if (dispatch) {
    stats.dispatched = dispatchPendingObjectionNotifications({ at }).dispatched;
  }
  return stats;
}

// 事务体：到点提醒 + 逾期标记升级。必须在 immediate 事务内调用。
function generateDueNotificationsTx(at) {
  const stats = { remindersCreated: 0, overdueMarked: 0, escalationsCreated: 0 };
  const open = db.prepare(`
    SELECT * FROM receipt_objections
    WHERE status IN (${RECEIPT_OBJECTION_OPEN_STATUSES.map(() => '?').join(', ')})
    ORDER BY deadline_at ASC
  `).all(...RECEIPT_OBJECTION_OPEN_STATUSES);
  const insertStmt = db.prepare(NOTIFICATION_INSERT);

  for (const objection of open) {
    // 暂停（等待办理人补充材料）期间不计时：既不提醒也不标记逾期，
    // 调度始终跟随恢复后的当前有效截止时间。
    if (objection.status === 'supplementing') continue;
    // 1) 到期前提醒：每个序位独立判断“是否已进入提醒窗口”。
    //
    // 编号 ordinal 按到期先后固定（提前量越大越早到期、序位越小）；
    // 处理顺序按提前量【升序】，这样先到期的大提前量序位已存在时，
    // 不会用 continue 把稍后才到期的小提前量序位一起挡掉。
    // 逾期扫描也会执行本段：服务停机期间错过的提醒点在恢复时补生成（留痕），
    // 唯一索引保证每序位每接收方至多一条。
    const leads = [...new Set(config.objectionReminderLeadMs)]
      .sort((a, b) => a - b)
      .map((leadMs, index, arr) => ({ ordinal: arr.length - 1 - index, leadMs }));
    for (const { ordinal, leadMs } of leads) {
      if (at < objection.deadline_at - leadMs) continue;
      // 去重键跟随“当前有效截止时间”：恢复/迁移使截止时间变化后，
      // 按新截止时间的提醒点可以再次提醒；旧提醒永久留档。
      const dedupeKey = reminderDedupeKey(ordinal, objection.deadline_at);
      const exists = db.prepare(`
        SELECT 1 FROM receipt_objection_notifications
        WHERE objection_id = ? AND kind = 'reminder' AND dedupe_key = ?
      `).get(objection.id, dedupeKey);
      if (exists) continue;
      const payload = buildNotificationPayload({
        objection,
        kind: 'reminder',
        extra: {
          reminderOrdinal: ordinal,
          leadMs,
          triggerAt: objection.deadline_at - leadMs,
          backfilled: at > objection.deadline_at,
        },
      });
      const inserted = insertAudienceRowsTx(insertStmt, {
        objection,
        kind: 'reminder',
        dedupeKey,
        level: 1,
        payload,
        audiences: ['processor', 'handler'],
        createdAt: at,
      });
      if (inserted.length > 0) {
        stats.remindersCreated += inserted.length;
        appendObjectionEventTx({
          objection,
          type: 'receipt.objection.reminder.scheduled',
          actorRole: 'system',
          note: at > objection.deadline_at
            ? `停机恢复补生成：到期前 ${Math.round(leadMs / 3600000)} 小时提醒`
            : `到期前 ${Math.round(leadMs / 3600000)} 小时提醒`,
          extra: {
            dedupeKey,
            deadlineAt: objection.deadline_at,
            audiences: inserted.map((item) => item.audience),
            backfilled: at > objection.deadline_at,
          },
        });
      }
    }

    // 尚未超过截止时间：只生成提醒，不进入逾期升级
    if (at < objection.deadline_at) continue;

    // 2) 超过处理期限：条件更新只放行首个事务标记 overdue_at
    if (!objection.overdue_at) {
      const marked = db.prepare(`
        UPDATE receipt_objections SET overdue_at = ?
        WHERE id = ? AND overdue_at IS NULL
      `).run(at, objection.id);
      if (marked.changes > 0) {
        stats.overdueMarked += 1;
        appendObjectionEventTx({
          objection,
          type: 'receipt.objection.overdue',
          actorRole: 'system',
          note: '超过处理期限，自动标记逾期并升级',
          extra: { deadlineAt: objection.deadline_at, overdueAt: at },
        });
      }
    }

    // 3) 逾期升级通知：层级 = 已批准延期次数 + 1（同一层级只升级一次）
    const approvedCount = db.prepare(`
      SELECT COUNT(*) AS c FROM receipt_objection_extensions
      WHERE objection_id = ? AND status = 'approved'
    `).get(objection.id).c;
    const level = approvedCount + 1;
    const dedupeKey = overdueDedupeKey(level);
    // 已生成过本层级升级则跳过，避免逾期期间被反复扫描时 level 继续爬升
    const overdueExists = db.prepare(`
      SELECT 1 FROM receipt_objection_notifications
      WHERE objection_id = ? AND kind = 'overdue' AND dedupe_key = ?
    `).get(objection.id, dedupeKey);
    if (overdueExists) continue;
    const payload = buildNotificationPayload({
      objection,
      kind: 'overdue',
      extra: { level, overdueAt: at, overdue: true },
    });
    // 按权限分流：处理人收到定向升级通知；主管收到按角色的升级记录；
    // 审计员不持有个人通知行，由审计接口按权限查看全部通知与升级记录。
    const inserted = insertAudienceRowsTx(insertStmt, {
      objection,
      kind: 'overdue',
      dedupeKey,
      level,
      payload,
      audiences: ['processor', 'supervisor'],
      createdAt: at,
    });
    if (inserted.length > 0) {
      stats.escalationsCreated += inserted.length;
      appendObjectionEventTx({
        objection,
        type: 'receipt.objection.overdue',
        actorRole: 'system',
        note: `逾期升级（第 ${level} 层）`,
        extra: {
          dedupeKey,
          level,
          deadlineAt: objection.deadline_at,
          overdueAt: at,
          audiences: inserted.map((item) => item.audience),
        },
      });
    }
  }
  return stats;
}

// 把全部 pending 通知标记为 sent（重启后可安全重放：WHERE status='pending' 兜底）
export function dispatchPendingObjectionNotifications({ at = Date.now() } = {}) {
  return immediateTransaction(() => {
    const pending = db.prepare(`
      SELECT id FROM receipt_objection_notifications WHERE status = 'pending' ORDER BY created_at ASC
    `).all();
    const mark = db.prepare(`
      UPDATE receipt_objection_notifications SET status = 'sent', sent_at = ?
      WHERE id = ? AND status = 'pending'
    `);
    let dispatched = 0;
    for (const row of pending) {
      dispatched += mark.run(at, row.id).changes;
    }
    return { dispatched };
  });
}

// ---------------------------------------------------------------------------
// 处理人：确认已读（按通知 id，带角色 + 接收人校验）
// 幂等：重复确认 / 双击返回同一条已读通知；首次确认追加一条只追加事件。
// ---------------------------------------------------------------------------
export function markObjectionNotificationRead({ userId, role, notificationId }) {
  return immediateTransaction(() => {
    const notification = db.prepare(`
      SELECT * FROM receipt_objection_notifications WHERE id = ?
    `).get(notificationId);
    if (!notification) {
      return { ok: false, status: 404, code: 'NOTIFICATION_NOT_FOUND', message: '通知不存在' };
    }
    if (!canViewNotification({ notification, userId, role })) {
      // 不暴露他人通知的存在
      return { ok: false, status: 404, code: 'NOTIFICATION_NOT_FOUND', message: '通知不存在' };
    }
    if (notification.read_at) {
      return { ok: true, idempotent: true, notification: notificationRow(notification.id) };
    }
    const ts = now();
    const result = db.prepare(`
      UPDATE receipt_objection_notifications
      SET status = 'read', read_at = ?, read_by_user_id = ?
      WHERE id = ? AND read_at IS NULL
    `).run(ts, userId, notificationId);
    if (result.changes === 0) {
      // 并发：另一个请求已确认，返回同一结果
      return { ok: true, idempotent: true, notification: notificationRow(notificationId) };
    }
    const objection = db.prepare('SELECT * FROM receipt_objections WHERE id = ?').get(notification.objection_id);
    appendObjectionEventTx({
      objection,
      type: 'receipt.objection.notification.read',
      actorUserId: userId,
      actorRole: role,
      note: `确认已读：${notification.kind}（${notification.dedupe_key}）`,
      extra: {
        notificationId: notification.id,
        kind: notification.kind,
        dedupeKey: notification.dedupe_key,
        audience: notification.audience,
      },
    });
    return { ok: true, notification: notificationRow(notificationId) };
  });
}

// 接收方校验：定向通知只允许其 target_user；主管广播允许任意主管；
// 审计员的读取走审计接口（不在个人通知中出现）。
function canViewNotification({ notification, userId, role }) {
  if (role === 'auditor') return true;
  if (notification.audience !== role) return false;
  if (notification.target_user_id && notification.target_user_id !== userId) return false;
  return true;
}

// ---------------------------------------------------------------------------
// 处理人：填写延期原因并申请一次延期
// ---------------------------------------------------------------------------
export function requestObjectionExtension({ userId, objectionId, reason }) {
  return immediateTransaction(() => {
    const objection = db.prepare('SELECT * FROM receipt_objections WHERE id = ?').get(objectionId);
    if (!objection) {
      return { ok: false, status: 404, code: 'OBJECTION_NOT_FOUND', message: '异议不存在' };
    }
    if (objection.assignee_user_id !== userId) {
      return { ok: false, status: 403, code: 'OBJECTION_NOT_ASSIGNED', message: '该异议未分配给当前处理人' };
    }
    if (!RECEIPT_OBJECTION_OPEN_STATUSES.includes(objection.status)) {
      return {
        ok: false,
        status: 409,
        code: 'OBJECTION_ALREADY_HANDLED',
        message: '该异议已处理完结，不能申请延期',
      };
    }
    const existing = db.prepare(`
      SELECT * FROM receipt_objection_extensions WHERE objection_id = ? AND ordinal = 0
    `).get(objectionId);
    if (existing) {
      return {
        ok: false,
        status: 409,
        code: 'EXTENSION_ALREADY_REQUESTED',
        message: existing.status === 'pending'
          ? '延期申请已提交，正在等待主管审批，不能重复申请'
          : existing.status === 'approved'
            ? '该异议已使用过唯一一次延期机会'
            : '该异议的延期申请已被主管拒绝，每份异议只能申请一次延期',
        extension: extensionRow(existing),
      };
    }

    const ts = now();
    // 日历化异议按工作分钟延期（暂停期间只增加冻结的剩余时长）；
    // 旧版全天日历沿用自然毫秒，行为与历史一致。
    const extensionMinutes = objection.calendar_version === 0
      ? Math.round(config.objectionExtensionMs / 60000)
      : config.objectionExtensionMinutes;
    const durationMs = extensionMinutes * 60000;
    const id = cryptoId();
    try {
      db.prepare(`
        INSERT INTO receipt_objection_extensions
          (id, objection_id, ordinal, status, reason, requested_duration_ms,
           requested_by_user_id, previous_deadline_at, created_at,
           decided_at, decided_by_user_id, decision_note)
        VALUES (?, ?, 0, 'pending', ?, ?, ?, ?, ?, NULL, NULL, '')
      `).run(id, objectionId, reason, durationMs, userId, objection.deadline_at, ts);
    } catch (error) {
      // 两个页面并发申请：UNIQUE(objection_id, ordinal) 只放行一个
      if (String(error?.message || '').includes('UNIQUE')) {
        const winner = db.prepare(`
          SELECT * FROM receipt_objection_extensions WHERE objection_id = ? AND ordinal = 0
        `).get(objectionId);
        return {
          ok: false,
          status: 409,
          code: 'EXTENSION_ALREADY_REQUESTED',
          message: '延期申请已由另一个页面提交，每份异议只能申请一次',
          extension: extensionRow(winner),
        };
      }
      throw error;
    }

    const extension = db.prepare('SELECT * FROM receipt_objection_extensions WHERE id = ?').get(id);
    appendObjectionEventTx({
      objection,
      type: 'receipt.objection.extension.requested',
      actorUserId: userId,
      actorRole: 'processor',
      reason,
      extra: {
        extensionId: id,
        requestedDurationMs: durationMs,
        previousDeadlineAt: objection.deadline_at,
      },
    });
    // 通知主管审批（按角色广播，唯一索引保证申请只生成一条主管通知）
    const payload = buildNotificationPayload({
      objection,
      kind: 'extension-requested',
      deadlineAt: objection.deadline_at,
      extension,
    });
    prepareInsert(db.prepare(NOTIFICATION_INSERT), {
      objection,
      kind: 'extension-requested',
      dedupeKey: `extension-${extension.ordinal}-requested`,
      audience: 'supervisor',
      targetUserId: null,
      level: 1,
      payload,
      createdAt: ts,
    });
    return { ok: true, extension: extensionRow(extension) };
  });
}

// ---------------------------------------------------------------------------
// 主管：批准 / 拒绝延期（每个 pending 申请只能决议一次）
// ---------------------------------------------------------------------------
export function decideObjectionExtension({ userId, extensionId, decision, note = '' }) {
  if (!['approve', 'reject'].includes(decision)) {
    return { ok: false, status: 400, code: 'INVALID_EXTENSION_DECISION', message: '未知的延期决议' };
  }
  return immediateTransaction(() => {
    const extension = db.prepare('SELECT * FROM receipt_objection_extensions WHERE id = ?').get(extensionId);
    if (!extension) {
      return { ok: false, status: 404, code: 'EXTENSION_NOT_FOUND', message: '延期申请不存在' };
    }
    if (extension.status !== 'pending') {
      return {
        ok: false,
        status: 409,
        code: 'EXTENSION_ALREADY_DECIDED',
        message: `该延期申请已${extension.status === 'approved' ? '批准' : '拒绝'}，不能重复决议`,
        extension: extensionRow(extension),
      };
    }
    const objection = db.prepare('SELECT * FROM receipt_objections WHERE id = ?').get(extension.objection_id);
    if (!objection) {
      return { ok: false, status: 404, code: 'OBJECTION_NOT_FOUND', message: '异议不存在' };
    }
    const ts = now();

    if (decision === 'approve') {
      // 条件更新兜底并发双击：只有一个决议事务成功
      const decided = db.prepare(`
        UPDATE receipt_objection_extensions
        SET status = 'approved', decided_at = ?, decided_by_user_id = ?, decision_note = ?
        WHERE id = ? AND status = 'pending'
      `).run(ts, userId, note, extensionId);
      if (decided.changes === 0) {
        const latest = db.prepare('SELECT * FROM receipt_objection_extensions WHERE id = ?').get(extensionId);
        return {
          ok: false,
          status: 409,
          code: 'EXTENSION_ALREADY_DECIDED',
          message: '该延期申请刚被其他操作决议，请刷新后重试',
          extension: extensionRow(latest),
        };
      }
      // 顺延截止时间；若此前已逾期，清除逾期标记——新截止时间之后的扫描
      // 会以新层级（level=2）再升级，旧升级记录永久保留。
      // 日历化异议：按工作分钟顺延（暂停中则只增加冻结剩余时长，恢复时才重算）。
      const extensionMinutes = objection.calendar_version === 0
        ? Math.round(config.objectionExtensionMs / 60000)
        : config.objectionExtensionMinutes;
      const clock = extendObjectionClockTx(objection, extensionMinutes, ts);
      const newDeadline = clock.deadlineAt;
      if (clock.paused) {
        db.prepare(`
          UPDATE receipt_objections
          SET remaining_minutes = remaining_minutes + ?, overdue_at = NULL
          WHERE id = ?
        `).run(clock.addedMinutes, objection.id);
      } else {
        // 旧版全天日历（remaining_minutes=0）：只移动截止时间与 anchor，不写剩余分钟
        if (clock.legacy) {
          db.prepare(`
            UPDATE receipt_objections SET deadline_at = ?, overdue_at = NULL WHERE id = ?
          `).run(newDeadline, objection.id);
        } else {
          db.prepare(`
            UPDATE receipt_objections
            SET deadline_at = ?, anchor_at = ?,
                remaining_minutes = remaining_minutes + ?, overdue_at = NULL
            WHERE id = ?
          `).run(newDeadline, ts, clock.addedMinutes || 0, objection.id);
        }
      }
      const updated = db.prepare('SELECT * FROM receipt_objections WHERE id = ?').get(objection.id);
      appendObjectionEventTx({
        objection: updated,
        type: 'receipt.objection.extension.approved',
        actorUserId: userId,
        actorRole: 'supervisor',
        reason: note,
        extra: {
          extensionId,
          previousDeadlineAt: extension.previous_deadline_at,
          newDeadlineAt: newDeadline,
        },
      });
      const approved = db.prepare('SELECT * FROM receipt_objection_extensions WHERE id = ?').get(extensionId);
      // 计时台账：延期批准段（暂停中只记录增加的工作分钟）
      appendTimingTx({
        objection: updated,
        type: 'extension',
        fromAt: extension.previous_deadline_at,
        toAt: newDeadline,
        actorUserId: userId,
        actorRole: 'supervisor',
        detail: {
          extensionId,
          extensionMinutes,
          previousDeadlineAt: extension.previous_deadline_at,
          newDeadlineAt: newDeadline,
          paused: Boolean(clock.paused),
          legacy: Boolean(clock.legacy),
          segments: clock.segments || [],
        },
        createdAt: ts,
      });
      notifyExtensionDecisionTx({
        objection: updated, extension: approved, decision: 'approved', actorUserId: userId, at: ts,
      });
      return {
        ok: true,
        extension: extensionRow(approved),
        newDeadlineAt: newDeadline,
      };
    }

    const decided = db.prepare(`
      UPDATE receipt_objection_extensions
      SET status = 'rejected', decided_at = ?, decided_by_user_id = ?, decision_note = ?
      WHERE id = ? AND status = 'pending'
    `).run(ts, userId, note, extensionId);
    if (decided.changes === 0) {
      const latest = db.prepare('SELECT * FROM receipt_objection_extensions WHERE id = ?').get(extensionId);
      return {
        ok: false,
        status: 409,
        code: 'EXTENSION_ALREADY_DECIDED',
        message: '该延期申请刚被其他操作决议，请刷新后重试',
        extension: extensionRow(latest),
      };
    }
    appendObjectionEventTx({
      objection,
      type: 'receipt.objection.extension.rejected',
      actorUserId: userId,
      actorRole: 'supervisor',
      reason: note,
      extra: { extensionId },
    });
    const rejected = db.prepare('SELECT * FROM receipt_objection_extensions WHERE id = ?').get(extensionId);
    notifyExtensionDecisionTx({
      objection, extension: rejected, decision: 'rejected', actorUserId: userId, at: ts,
    });
    return { ok: true, extension: extensionRow(rejected) };
  });
}

// 决议结果通知处理人（定向）；办理人也收到一条结果留痕
function notifyExtensionDecisionTx({ objection, extension, decision, actorUserId, at }) {
  const kind = decision === 'approved' ? 'extension-approved' : 'extension-rejected';
  const payload = buildNotificationPayload({
    objection,
    kind,
    deadlineAt: decision === 'approved' ? objection.deadline_at : extension.previous_deadline_at,
    extension,
    extra: { decidedBy: actorUserId },
  });
  const statement = db.prepare(NOTIFICATION_INSERT);
  insertAudienceRowsTx(statement, {
    objection,
    kind,
    dedupeKey: `extension-${extension.ordinal}-${decision}`,
    level: 1,
    payload,
    audiences: ['processor', 'handler'],
    createdAt: at,
  });
}

// ---------------------------------------------------------------------------
// 查询视图
// ---------------------------------------------------------------------------
function notificationRow(idOrRow) {
  const row = typeof idOrRow === 'object' && idOrRow !== null
    ? idOrRow
    : db.prepare('SELECT * FROM receipt_objection_notifications WHERE id = ?').get(idOrRow);
  if (!row) return null;
  return {
    id: row.id,
    objectionId: row.objection_id,
    objectionNo: JSON.parse(row.payload_json).objectionNo,
    receiptNo: row.receipt_no,
    kind: row.kind,
    kindLabel: JSON.parse(row.payload_json).kindLabel,
    dedupeKey: row.dedupe_key,
    audience: row.audience,
    level: row.level,
    status: row.status,
    payload: JSON.parse(row.payload_json),
    createdAt: row.created_at,
    sentAt: row.sent_at || null,
    readAt: row.read_at || null,
  };
}

function extensionRow(row) {
  if (!row) return null;
  const requester = row.requested_by_user_id ? userQueries.findById(row.requested_by_user_id) : null;
  const decider = row.decided_by_user_id ? userQueries.findById(row.decided_by_user_id) : null;
  const objection = db.prepare('SELECT objection_no, receipt_no, status, deadline_at FROM receipt_objections WHERE id = ?')
    .get(row.objection_id);
  return {
    id: row.id,
    objectionId: row.objection_id,
    objectionNo: objection?.objection_no || '',
    receiptNo: objection?.receipt_no || '',
    ordinal: row.ordinal,
    status: row.status,
    reason: row.reason,
    requestedDurationMs: row.requested_duration_ms,
    previousDeadlineAt: row.previous_deadline_at,
    currentDeadlineAt: objection?.deadline_at || row.previous_deadline_at,
    objectionStatus: objection?.status || '',
    requestedAt: row.created_at,
    requestedBy: requester ? { id: requester.id, displayName: requester.display_name } : null,
    decidedAt: row.decided_at || null,
    decidedBy: decider ? { id: decider.id, displayName: decider.display_name } : null,
    decisionNote: row.decision_note || '',
  };
}

// 个人通知：处理人 / 办理人各取自己定向接收的通知；主管取 supervisor 广播
export function listNotificationsForUser({ userId, role, status = '', kind = '' }) {
  const clauses = [];
  const params = [];
  if (role === 'supervisor') {
    clauses.push('audience = ?');
    params.push('supervisor');
  } else {
    clauses.push('audience = ?');
    params.push(role);
    if (role === 'processor' || role === 'handler') {
      clauses.push('(target_user_id = ? OR target_user_id IS NULL)');
      params.push(userId);
    }
  }
  if (status) {
    clauses.push('status = ?');
    params.push(status);
  }
  if (kind) {
    clauses.push('kind = ?');
    params.push(kind);
  }
  const rows = db.prepare(`
    SELECT * FROM receipt_objection_notifications
    WHERE ${clauses.join(' AND ')}
    ORDER BY created_at DESC, id DESC
  `).all(...params);
  return rows.map((row) => notificationRow(row));
}

// 处理人 / 办理人：自己可见通知的未读数（刷新、重新登录后恢复提醒状态）
export function unreadNotificationCount({ userId, role }) {
  const audience = role === 'processor' || role === 'handler' ? role : null;
  if (!audience) return 0;
  return db.prepare(`
    SELECT COUNT(*) AS c FROM receipt_objection_notifications
    WHERE audience = ? AND target_user_id = ? AND status <> 'read'
  `).get(audience, userId).c;
}

// 主管：待审批延期列表（附脱敏申请人摘要；主管视图不暴露证件号/完整地址/完整手机号）
export function listPendingExtensionsForSupervisor() {
  const rows = db.prepare(`
    SELECT e.* FROM receipt_objection_extensions e
    WHERE e.status = 'pending'
    ORDER BY e.created_at ASC
  `).all();
  return rows.map((row) => withObjectionContext(extensionRow(row), 'supervisor'));
}

export function listExtensionsForSupervisor({ status = '' } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM receipt_objection_extensions WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM receipt_objection_extensions ORDER BY created_at DESC').all();
  return rows.map((row) => withObjectionContext(extensionRow(row), 'supervisor'));
}

export function getExtensionForSupervisor(extensionId) {
  const row = db.prepare('SELECT * FROM receipt_objection_extensions WHERE id = ?').get(extensionId);
  return row ? withObjectionContext(extensionRow(row), 'supervisor') : null;
}

// 办理人：自己异议上的延期结论
export function listExtensionsForOwner(userId) {
  const rows = db.prepare(`
    SELECT e.* FROM receipt_objection_extensions e
    JOIN receipt_objections o ON o.id = e.objection_id
    WHERE o.user_id = ?
    ORDER BY e.created_at DESC
  `).all(userId);
  return rows.map((row) => extensionRow(row));
}

function withObjectionContext(extension, viewer) {
  if (!extension) return null;
  const objection = db.prepare('SELECT * FROM receipt_objections WHERE id = ?').get(extension.objectionId);
  if (!objection) return extension;
  const assignee = objection.assignee_user_id ? userQueries.findById(objection.assignee_user_id) : null;
  return {
    ...extension,
    objection: {
      objectionNo: objection.objection_no,
      receiptNo: objection.receipt_no,
      status: objection.status,
      deadlineAt: objection.deadline_at,
      overdueAt: objection.overdue_at || null,
      assignee: assignee ? { id: assignee.id, displayName: assignee.display_name } : null,
    },
  };
}

// 审计员：全部通知（完整通知留痕）。通知负载本身不含敏感字段，
// 完整证件号 / 地址 / 手机号仍只在异议的冻结快照审计视图中按需返回。
export function listAllNotificationsForAuditor({ kind = '', audience = '', status = '', objectionNo = '' } = {}) {
  const clauses = [];
  const params = [];
  if (kind) {
    clauses.push('n.kind = ?');
    params.push(kind);
  }
  if (audience) {
    clauses.push('n.audience = ?');
    params.push(audience);
  }
  if (status) {
    clauses.push('n.status = ?');
    params.push(status);
  }
  if (objectionNo) {
    clauses.push('(n.receipt_no = ? OR EXISTS (SELECT 1 FROM receipt_objections o WHERE o.id = n.objection_id AND o.objection_no = ?))');
    params.push(objectionNo, objectionNo);
  }
  const rows = db.prepare(`
    SELECT n.* FROM receipt_objection_notifications n
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY n.created_at DESC, n.id DESC
  `).all(...params);
  return rows.map((row) => {
    const item = notificationRow(row);
    const target = row.target_user_id ? userQueries.findById(row.target_user_id) : null;
    return {
      ...item,
      targetUser: target ? { id: target.id, username: target.username, displayName: target.display_name, role: target.role } : null,
      readBy: row.read_by_user_id ? (userQueries.findById(row.read_by_user_id)?.display_name || '') : '',
    };
  });
}

// 审计员：全部延期申请与决议（含主管决议说明）
export function listAllExtensionsForAuditor({ status = '' } = {}) {
  const rows = status
    ? db.prepare('SELECT * FROM receipt_objection_extensions WHERE status = ? ORDER BY created_at DESC').all(status)
    : db.prepare('SELECT * FROM receipt_objection_extensions ORDER BY created_at DESC').all();
  return rows.map((row) => extensionRow(row));
}

// 给异议视图附加“提醒/升级/延期”摘要（办理人 / 处理人详情接口使用）
export function escalationSummaryForObjection(objectionId, { viewer, userId = null } = {}) {
  const notificationRows = db.prepare(`
    SELECT * FROM receipt_objection_notifications
    WHERE objection_id = ?
    ORDER BY created_at ASC, id ASC
  `).all(objectionId);
  let notifications = notificationRows;
  if (viewer === 'processor') {
    notifications = notificationRows.filter((row) => row.audience === 'processor'
      && (!row.target_user_id || row.target_user_id === userId));
  } else if (viewer === 'handler') {
    notifications = notificationRows.filter((row) => row.audience === 'handler'
      && (!row.target_user_id || row.target_user_id === userId));
  }
  const extensionRows = db.prepare(`
    SELECT * FROM receipt_objection_extensions WHERE objection_id = ? ORDER BY ordinal ASC
  `).all(objectionId);
  return {
    notifications: notifications.map((row) => notificationRow(row)),
    extensions: extensionRows.map((row) => extensionRow(row)),
  };
}
