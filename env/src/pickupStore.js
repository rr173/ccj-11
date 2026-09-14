// ---------------------------------------------------------------------------
// 回执线下领取预约与一次性交付：持久化与事务编排
//
// 并发模型：所有写操作走 BEGIN IMMEDIATE；名额占用/释放只以“条件 UPDATE
// … WHERE occupied < capacity / changes=1”作为唯一判定，不先读后写。
// 业务规则被触发（名额满、领取码错、过早、过期、跨预约、重复使用、状态不允许）
// 时抛出 PickupDenial 让事务回滚；对应的“拒绝”审计由外层在独立事务里补记，
// 因此拒绝不会留下半截业务数据，也不会丢失留痕。
// ---------------------------------------------------------------------------
import { db, immediateTransaction, cryptoId } from './db.js';
import { nowMs } from './clock.js';
import {
  APPOINTMENT_NO_PATTERN,
  PICKUP_ERRORS,
  auditView,
  codeDigestMatches,
  handlerAppointmentView,
  locationView,
  newAppointmentNo,
  newPickupCode,
  pickupCodeDigest,
  slotView,
  staffDeliveryView,
} from './pickup.js';
import { config } from './config.js';

export class PickupDenial extends Error {
  constructor(code, extra = {}) {
    super(PICKUP_ERRORS[code] || code);
    this.name = 'PickupDenial';
    this.code = code;
    this.extra = extra;
  }
}

function actorOf(user, userOverride) {
  const u = userOverride || user;
  return {
    actorUserId: u?.id || null,
    actorRole: u?.role || '',
    actorLabel: u?.display_name || u?.displayName || u?.username || '',
  };
}

// 只追加审计（本身在独立 IMMEDIATE 事务里写入；用于记录成功动作，以及在被
// PickupDenial 回滚的事务之外补记“拒绝”）
export function writeAuditTx({
  type, appointmentNo = '', receiptNo = '', slotId = '', locationId = '',
  actor, detail = {}, result = 'success', at = nowMs(),
}) {
  db.prepare(`
    INSERT INTO pickup_audit
      (type, appointment_no, receipt_no, slot_id, location_id,
       actor_user_id, actor_role, actor_label, detail_json, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    type, appointmentNo, receiptNo, slotId, locationId,
    actor.actorUserId, actor.actorRole, actor.actorLabel,
    JSON.stringify(detail), result, at,
  );
}

// 执行一个会抛 PickupDenial 的业务事务；拒绝时回滚并在库中补记拒绝原因，
// 返回统一的 { ok:false, status, code, message }。
function runPickupMutation({
  user, deniedType, auditRef = {}, fn,
}) {
  const actor = actorOf(user);
  try {
    return immediateTransaction(fn);
  } catch (error) {
    if (!(error instanceof PickupDenial)) throw error;
    immediateTransaction(() => {
      writeAuditTx({
        type: deniedType,
        actor,
        result: 'denied',
        appointmentNo: auditRef.appointmentNo || '',
        receiptNo: auditRef.receiptNo || '',
        slotId: auditRef.slotId || '',
        locationId: auditRef.locationId || '',
        detail: {
          reason: error.code,
          message: error.message,
          ...(error.extra || {}),
        },
      });
    });
    return {
      ok: false,
      status: 409,
      code: error.code,
      message: error.message,
    };
  }
}

// ===========================================================================
// 主管：领取网点
// ===========================================================================
export function createPickupLocation({ user, name, address, note = '' }) {
  const actor = actorOf(user);
  return immediateTransaction(() => {
    const ts = nowMs();
    const id = cryptoId();
    db.prepare(`
      INSERT INTO pickup_locations
        (id, name, address, status, note, version, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, 1, ?, ?, ?)
    `).run(id, name, address, note, user?.id || null, ts, ts);
    writeAuditTx({
      type: 'pickup.location.created', locationId: id, actor,
      detail: { name, address, note },
    });
    return { ok: true, location: getLocation(id) };
  });
}

// 更新网点名称/地址：只影响今后预约；已有预约冻结的网点名称/地址不变
export function updatePickupLocation({ user, locationId, name, address, note }) {
  const actor = actorOf(user);
  return immediateTransaction(() => {
    const row = db.prepare('SELECT * FROM pickup_locations WHERE id = ?').get(locationId);
    if (!row) return { ok: false, status: 404, code: 'LOCATION_NOT_FOUND', message: PICKUP_ERRORS.LOCATION_NOT_FOUND };
    const nextName = name === undefined ? row.name : name;
    const nextAddress = address === undefined ? row.address : address;
    const nextNote = note === undefined ? row.note : note;
    const ts = nowMs();
    db.prepare(`
      UPDATE pickup_locations SET name = ?, address = ?, note = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(nextName, nextAddress, nextNote, ts, row.id);
    writeAuditTx({
      type: 'pickup.location.updated', locationId: row.id, actor,
      detail: {
        from: { name: row.name, address: row.address, note: row.note },
        to: { name: nextName, address: nextAddress, note: nextNote },
      },
    });
    return { ok: true, location: getLocation(row.id) };
  });
}

export function disablePickupLocation({ user, locationId }) {
  const actor = actorOf(user);
  return immediateTransaction(() => {
    const row = db.prepare('SELECT * FROM pickup_locations WHERE id = ?').get(locationId);
    if (!row) return { ok: false, status: 404, code: 'LOCATION_NOT_FOUND', message: PICKUP_ERRORS.LOCATION_NOT_FOUND };
    const ts = nowMs();
    db.prepare("UPDATE pickup_locations SET status = 'disabled', version = version + 1, updated_at = ? WHERE id = ?")
      .run(ts, row.id);
    writeAuditTx({
      type: 'pickup.location.disabled', locationId: row.id, actor,
      detail: { openSlots: db.prepare("SELECT COUNT(*) AS c FROM pickup_slots WHERE location_id = ? AND status = 'open'").get(row.id).c },
    });
    return { ok: true, location: getLocation(row.id) };
  });
}

// ===========================================================================
// 主管：时间段与容量
// ===========================================================================
function slotsOverlapTx(locationId, startAt, endAt, ignoreSlotId = '') {
  return Boolean(db.prepare(`
    SELECT 1 FROM pickup_slots
    WHERE location_id = ? AND id <> ? AND start_at < ? AND end_at > ?
    LIMIT 1
  `).get(locationId, ignoreSlotId, endAt, startAt));
}

export function createPickupSlot({ user, locationId, startAt, endAt, capacity, note = '' }) {
  const actor = actorOf(user);
  return immediateTransaction(() => {
    const location = db.prepare('SELECT * FROM pickup_locations WHERE id = ?').get(locationId);
    if (!location) return { ok: false, status: 404, code: 'LOCATION_NOT_FOUND', message: PICKUP_ERRORS.LOCATION_NOT_FOUND };
    if (location.status === 'disabled') {
      return { ok: false, status: 409, code: 'LOCATION_DISABLED', message: PICKUP_ERRORS.LOCATION_DISABLED };
    }
    if (slotsOverlapTx(locationId, startAt, endAt)) {
      return { ok: false, status: 409, code: 'SLOT_TIME_CONFLICT', message: PICKUP_ERRORS.SLOT_TIME_CONFLICT };
    }
    const ts = nowMs();
    const id = cryptoId();
    db.prepare(`
      INSERT INTO pickup_slots
        (id, location_id, start_at, end_at, capacity, occupied, capacity_version,
         status, note, version, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 0, 1, 'open', ?, 1, ?, ?, ?)
    `).run(id, locationId, startAt, endAt, capacity, note, user?.id || null, ts, ts);
    writeAuditTx({
      type: 'pickup.slot.created', slotId: id, locationId, actor,
      detail: { startAt, endAt, capacity, note },
    });
    return { ok: true, slot: getSlot(id) };
  });
}

// 调整时间段：已有人预约时只允许改容量（时间范围锁定）；容量下调不得低于占用
export function updatePickupSlot({ user, slotId, capacity, startAt, endAt, note }) {
  const actor = actorOf(user);
  return immediateTransaction(() => {
    const row = db.prepare('SELECT * FROM pickup_slots WHERE id = ?').get(slotId);
    if (!row) return { ok: false, status: 404, code: 'SLOT_NOT_FOUND', message: PICKUP_ERRORS.SLOT_NOT_FOUND };
    const changingTime = startAt !== undefined || endAt !== undefined;
    const nextStart = startAt === undefined ? row.start_at : startAt;
    const nextEnd = endAt === undefined ? row.end_at : endAt;
    let nextCapacity = capacity === undefined ? row.capacity : capacity;
    const nextNote = note === undefined ? row.note : note;

    if (changingTime) {
      if (row.occupied > 0) {
        return { ok: false, status: 409, code: 'SLOT_TIME_LOCKED', message: PICKUP_ERRORS.SLOT_TIME_LOCKED };
      }
      if (slotsOverlapTx(row.location_id, nextStart, nextEnd, row.id)) {
        return { ok: false, status: 409, code: 'SLOT_TIME_CONFLICT', message: PICKUP_ERRORS.SLOT_TIME_CONFLICT };
      }
    }
    if (capacity !== undefined && nextCapacity < row.occupied) {
      return { ok: false, status: 409, code: 'SLOT_CAPACITY_BELOW_OCCUPIED', message: PICKUP_ERRORS.SLOT_CAPACITY_BELOW_OCCUPIED };
    }
    const capacityChanged = nextCapacity !== row.capacity;
    const ts = nowMs();
    db.prepare(`
      UPDATE pickup_slots
      SET start_at = ?, end_at = ?, capacity = ?,
          capacity_version = capacity_version + ?,
          note = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(nextStart, nextEnd, nextCapacity, capacityChanged ? 1 : 0, nextNote, ts, row.id);
    writeAuditTx({
      type: 'pickup.slot.updated', slotId: row.id, locationId: row.location_id, actor,
      detail: {
        from: { startAt: row.start_at, endAt: row.end_at, capacity: row.capacity, capacityVersion: row.capacity_version, note: row.note },
        to: { startAt: nextStart, endAt: nextEnd, capacity: nextCapacity, capacityVersion: row.capacity_version + (capacityChanged ? 1 : 0), note: nextNote },
      },
    });
    return { ok: true, slot: getSlot(row.id) };
  });
}

export function closePickupSlot({ user, slotId }) {
  const actor = actorOf(user);
  return immediateTransaction(() => {
    const row = db.prepare('SELECT * FROM pickup_slots WHERE id = ?').get(slotId);
    if (!row) return { ok: false, status: 404, code: 'SLOT_NOT_FOUND', message: PICKUP_ERRORS.SLOT_NOT_FOUND };
    const ts = nowMs();
    db.prepare("UPDATE pickup_slots SET status = 'closed', version = version + 1, updated_at = ? WHERE id = ?")
      .run(ts, row.id);
    writeAuditTx({
      type: 'pickup.slot.closed', slotId: row.id, locationId: row.location_id, actor,
      detail: { occupied: row.occupied },
    });
    return { ok: true, slot: getSlot(row.id) };
  });
}

// ===========================================================================
// 办理人：预约 / 改约 / 取消
// ===========================================================================
function eligibleReceiptForUserTx({ receiptNo, userId }) {
  const row = db.prepare('SELECT * FROM receipts WHERE receipt_no = ? AND user_id = ?').get(receiptNo, userId);
  if (!row) {
    throw new PickupDenial('RECEIPT_NOT_ELIGIBLE');
  }
  if (row.status === 'revoked') throw new PickupDenial('RECEIPT_REVOKED');
  return row;
}

function loadBookableSlotTx(slotId) {
  const slot = db.prepare('SELECT * FROM pickup_slots WHERE id = ?').get(slotId);
  if (!slot) throw new PickupDenial('SLOT_NOT_FOUND');
  if (slot.status !== 'open') throw new PickupDenial('SLOT_NOT_OPEN');
  return slot;
}

// 原子占用：唯一判定是条件 UPDATE 是否改动一行（含 CHECK occupied<=capacity）
function occupySlotTx(slotId) {
  const result = db.prepare(`
    UPDATE pickup_slots
    SET occupied = occupied + 1, updated_at = ?
    WHERE id = ? AND status = 'open' AND occupied < capacity
  `).run(nowMs(), slotId);
  if (result.changes !== 1) throw new PickupDenial('SLOT_CAPACITY_FULL');
}

function releaseSlotTx(slotId) {
  const result = db.prepare(`
    UPDATE pickup_slots
    SET occupied = occupied - 1, updated_at = ?
    WHERE id = ? AND occupied > 0
  `).run(nowMs(), slotId);
  if (result.changes !== 1) {
    // 容量账不能漂移：释放失败属于数据不一致，让事务整体失败而不是静默继续
    throw new PickupDenial('SLOT_NOT_FOUND');
  }
}

// 旧领取码摘要标记为 rotated（永不返回明文、永不能交付）；用于精确区分旧码/错码
function rotateCodesTx(appointmentId) {
  db.prepare("UPDATE pickup_codes SET status = 'rotated' WHERE appointment_id = ? AND status = 'current'")
    .run(appointmentId);
}

// 交付一次性消费：当前码标记 consumed（保留摘要，任何重放都无法再通过）
function consumeCodeTx(appointmentId) {
  db.prepare("UPDATE pickup_codes SET status = 'consumed' WHERE appointment_id = ? AND status = 'current'")
    .run(appointmentId);
}

function insertAppointmentWithCodeTx({
  userId, sessionId, receipt, slot, location, note,
}) {
  const ts = nowMs();
  const id = cryptoId();
  const appointmentNo = newAppointmentNo(ts);
  const codeSeq = 1;
  const rawCode = newPickupCode();
  db.prepare(`
    INSERT INTO pickup_appointments (
      id, appointment_no, receipt_no, workflow_id, user_id, slot_id, status,
      version, code_seq, grace_ms, frozen_slot_id, frozen_location_name,
      frozen_location_address, frozen_start_at, frozen_end_at,
      frozen_capacity_version, note, created_by_session_id, created_at, updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, 'booked', 1, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    )
  `).run(
    id, appointmentNo, receipt.receipt_no, receipt.workflow_id, userId, slot.id,
    config.pickupGraceMs, slot.id, location.name, location.address,
    slot.start_at, slot.end_at, slot.capacity_version, note, sessionId || '', ts, ts,
  );
  db.prepare(`
    INSERT INTO pickup_codes (appointment_id, code_seq, code_hash, created_at)
    VALUES (?, ?, ?, ?)
  `).run(id, codeSeq, pickupCodeDigest({ appointmentNo, codeSeq, rawCode: rawCode }), ts);
  return { id, appointmentNo, rawCode };
}

export function bookPickup({ user, sessionId, receiptNo, slotId, note = '' }) {
  const actor = actorOf(user);
  return runPickupMutation({
    user,
    deniedType: 'pickup.action.rejected',
    auditRef: { receiptNo, slotId },
    fn: () => {
      const receipt = eligibleReceiptForUserTx({ receiptNo, userId: user.id });
      const open = db.prepare(`
        SELECT id FROM pickup_appointments
        WHERE receipt_no = ? AND status IN ('booked', 'rescheduled')
      `).get(receipt.receipt_no);
      if (open) throw new PickupDenial('ACTIVE_APPOINTMENT_EXISTS');
      const slot = loadBookableSlotTx(slotId);
      const location = db.prepare('SELECT * FROM pickup_locations WHERE id = ?').get(slot.location_id);
      if (!location || location.status !== 'active') throw new PickupDenial('LOCATION_DISABLED');
      occupySlotTx(slot.id);
      const created = insertAppointmentWithCodeTx({
        userId: user.id, sessionId, receipt, slot, location, note,
      });
      writeAuditTx({
        type: 'pickup.appointment.booked',
        appointmentNo: created.appointmentNo, receiptNo: receipt.receipt_no,
        slotId: slot.id, locationId: location.id, actor,
        detail: { slot: { startAt: slot.start_at, endAt: slot.end_at, capacityVersion: slot.capacity_version } },
      });
      const appt = getOwnerAppointment(created.id, user.id);
      return {
        ok: true,
        appointment: appt,
        // 领取码明文只在本次响应出现一次；后续任何列表/详情接口都不再返回
        pickupCode: created.rawCode,
        codeShownOnce: true,
      };
    },
  });
}

export function reschedulePickup({ user, sessionId, appointmentId, expectedVersion, slotId, note = '' }) {
  const actor = actorOf(user);
  const auditRef = { slotId };
  return runPickupMutation({
    user,
    deniedType: 'pickup.action.rejected',
    auditRef,
    fn: () => {
      const appt = db.prepare(`
        SELECT * FROM pickup_appointments WHERE id = ? AND user_id = ?
      `).get(appointmentId, user.id);
      if (!appt) throw new PickupDenial('APPOINTMENT_NOT_FOUND');
      // 拒绝审计需要可归属到该预约
      auditRef.appointmentNo = appt.appointment_no;
      auditRef.receiptNo = appt.receipt_no;
      if (appt.status === 'delivered') throw new PickupDenial('APPOINTMENT_DELIVERED_READONLY');
      if (!['booked', 'rescheduled'].includes(appt.status)) throw new PickupDenial('APPOINTMENT_NOT_ACTIVE');
      // 乐观锁：版本不符说明已被其他页面的取消/改约/交付改变
      if (appt.version !== expectedVersion) throw new PickupDenial('APPOINTMENT_VERSION_CONFLICT');
      const newSlot = loadBookableSlotTx(slotId);
      if (newSlot.id === appt.slot_id) throw new PickupDenial('RESCHEDULE_SAME_SLOT');
      const location = db.prepare('SELECT * FROM pickup_locations WHERE id = ?').get(newSlot.location_id);
      if (!location || location.status !== 'active') throw new PickupDenial('LOCATION_DISABLED');

      // 原子：先占新名额（失败则整体回滚，旧名额不受影响），再释放旧名额
      occupySlotTx(newSlot.id);
      releaseSlotTx(appt.slot_id);

      const ts = nowMs();
      const nextVersion = appt.version + 1;
      const nextCodeSeq = appt.code_seq + 1;
      const rawCode = newPickupCode();
      const result = db.prepare(`
        UPDATE pickup_appointments
        SET slot_id = ?, status = 'rescheduled', version = ?, code_seq = ?,
            frozen_slot_id = ?, frozen_location_name = ?, frozen_location_address = ?,
            frozen_start_at = ?, frozen_end_at = ?, frozen_capacity_version = ?,
            note = CASE WHEN ? = '' THEN note ELSE ? END,
            updated_at = ?
        WHERE id = ? AND version = ? AND status IN ('booked', 'rescheduled')
      `).run(
        newSlot.id, nextVersion, nextCodeSeq,
        newSlot.id, location.name, location.address,
        newSlot.start_at, newSlot.end_at, newSlot.capacity_version,
        note, note, ts, appt.id, expectedVersion,
      );
      // 双重条件（先查 version + UPDATE WHERE version）兜底极端并发：
      // 另一个页面在本事务等待写锁期间改了状态/版本，此处必须整体回滚。
      if (result.changes !== 1) throw new PickupDenial('APPOINTMENT_VERSION_CONFLICT');
      // 旧领取码立即轮换为 rotated（保留摘要仅为精确识别旧码），保存新领取码摘要
      rotateCodesTx(appt.id);
      db.prepare(`
        INSERT INTO pickup_codes (appointment_id, code_seq, code_hash, created_at)
        VALUES (?, ?, ?, ?)
      `).run(appt.id, nextCodeSeq, pickupCodeDigest({
        appointmentNo: appt.appointment_no, codeSeq: nextCodeSeq, rawCode,
      }), ts);
      writeAuditTx({
        type: 'pickup.appointment.rescheduled',
        appointmentNo: appt.appointment_no, receiptNo: appt.receipt_no,
        slotId: newSlot.id, locationId: location.id, actor,
        detail: {
          fromSlotId: appt.slot_id,
          toSlotId: newSlot.id,
          fromVersion: expectedVersion,
          toVersion: nextVersion,
          oldCodeSeq: appt.code_seq,
          newCodeSeq: nextCodeSeq,
        },
      });
      return {
        ok: true,
        appointment: getOwnerAppointment(appt.id, user.id),
        // 新领取码只展示一次；旧领取码已立即失效
        pickupCode: rawCode,
        codeShownOnce: true,
      };
    },
  });
}

export function cancelPickup({ user, appointmentId, expectedVersion, reason = '' }) {
  const actor = actorOf(user);
  const auditRef = {};
  return runPickupMutation({
    user,
    deniedType: 'pickup.action.rejected',
    auditRef,
    fn: () => {
      const appt = db.prepare(`
        SELECT * FROM pickup_appointments WHERE id = ? AND user_id = ?
      `).get(appointmentId, user.id);
      if (!appt) throw new PickupDenial('APPOINTMENT_NOT_FOUND');
      auditRef.appointmentNo = appt.appointment_no;
      auditRef.receiptNo = appt.receipt_no;
      auditRef.slotId = appt.slot_id;
      if (appt.status === 'delivered') throw new PickupDenial('APPOINTMENT_DELIVERED_READONLY');
      if (!['booked', 'rescheduled'].includes(appt.status)) throw new PickupDenial('APPOINTMENT_NOT_ACTIVE');
      // 乐观锁：取消/改约/确认交付在同一版本上互斥——版本不符说明该预约
      // 已被并发的改约或交付改变，本次取消必须明确冲突而不是覆盖对方结果
      if (appt.version !== expectedVersion) throw new PickupDenial('APPOINTMENT_VERSION_CONFLICT');

      const ts = nowMs();
      const result = db.prepare(`
        UPDATE pickup_appointments
        SET status = 'cancelled', version = version + 1,
            cancel_reason = ?, cancelled_at = ?, updated_at = ?
        WHERE id = ? AND version = ? AND status IN ('booked', 'rescheduled')
      `).run(String(reason).slice(0, 200), ts, ts, appt.id, expectedVersion);
      // 双重条件（先查 version + UPDATE WHERE version）兜底极端并发：
      // 另一个页面在本事务等待写锁期间改了状态/版本，此处必须整体回滚。
      if (result.changes !== 1) throw new PickupDenial('APPOINTMENT_VERSION_CONFLICT');
      releaseSlotTx(appt.slot_id);
      rotateCodesTx(appt.id);
      writeAuditTx({
        type: 'pickup.appointment.cancelled',
        appointmentNo: appt.appointment_no, receiptNo: appt.receipt_no,
        slotId: appt.slot_id, actor,
        detail: { reason: String(reason).slice(0, 200) },
      });
      return { ok: true, appointment: getOwnerAppointment(appt.id, user.id) };
    },
  });
}

// ===========================================================================
// 领取人员：确认交付（一次性、窗口内、码必须匹配当前生效版本）
// ===========================================================================
function loadActiveForDeliveryTx(appointmentNo) {
  const appt = db.prepare('SELECT * FROM pickup_appointments WHERE appointment_no = ?').get(appointmentNo);
  if (!appt) throw new PickupDenial('APPOINTMENT_NOT_FOUND');
  if (appt.status === 'delivered') throw new PickupDenial('PICKUP_ALREADY_DELIVERED');
  if (['cancelled', 'revoked'].includes(appt.status)) throw new PickupDenial('PICKUP_NOT_ACTIVE');
  // expired 允许进入后续时间窗口校验，由其给出明确的“超过宽限时间”结果
  return appt;
}

// 码校验：先比对当前生效码（错码 / 其他预约码不匹配时，继续比对历史版本，
// 以便把“旧领取码”与“错码”明确区分）；命中 rotated 即旧码、consumed 即已交付。
// 本预约全部版本都不命中时，再比对其他预约的领取码：能命中说明是“拿别的预约
// 的码来领本预约”，必须明确返回跨预约拒绝（PICKUP_MISMATCH）而不是普通错码；
// 整个校验只读，任何拒绝都由外层回滚，不改变任何预约或领取码状态。
function verifyCurrentCodeTx(appt, rawCode) {
  const rows = db.prepare(`
    SELECT * FROM pickup_codes WHERE appointment_id = ? ORDER BY code_seq DESC
  `).all(appt.id);
  for (const row of rows) {
    if (!codeDigestMatches(row.code_hash, {
      appointmentNo: appt.appointment_no,
      codeSeq: row.code_seq,
      rawCode,
    })) continue;
    if (row.status === 'current') return;
    if (row.status === 'consumed') throw new PickupDenial('PICKUP_ALREADY_DELIVERED');
    throw new PickupDenial('PICKUP_CODE_OLD');
  }
  // 跨预约检测：该码是否属于其他预约（含其历史版本）。摘要绑定预约编号与
  // code_seq，只有真实签发过的领取码才可能命中，错码不会误判。
  const others = db.prepare(`
    SELECT c.code_hash, c.code_seq, a.appointment_no
    FROM pickup_codes c
    JOIN pickup_appointments a ON a.id = c.appointment_id
    WHERE c.appointment_id <> ?
  `).all(appt.id);
  for (const row of others) {
    if (codeDigestMatches(row.code_hash, {
      appointmentNo: row.appointment_no,
      codeSeq: row.code_seq,
      rawCode,
    })) {
      throw new PickupDenial('PICKUP_MISMATCH');
    }
  }
  throw new PickupDenial('PICKUP_CODE_INVALID');
}

export function confirmPickupDelivery({ user, appointmentNo, rawCode, note = '' }) {
  const actor = actorOf(user);
  const auditRef = { appointmentNo };
  return runPickupMutation({
    user,
    deniedType: 'pickup.denied',
    auditRef,
    fn: () => {
      const appt = loadActiveForDeliveryTx(appointmentNo);
      auditRef.receiptNo = appt.receipt_no;
      auditRef.slotId = appt.slot_id;
      // 先判时间窗口：过早 / 超过宽限是首要拒绝理由（即使预约已被扫描落定为 expired）
      const at = nowMs();
      if (at < appt.frozen_start_at) throw new PickupDenial('PICKUP_TOO_EARLY');
      if (at > appt.frozen_end_at + appt.grace_ms) throw new PickupDenial('PICKUP_TOO_LATE');
      // 再校验一次性领取码（错码 / 旧码 / 已消费码）
      verifyCurrentCodeTx(appt, rawCode);

      const ts = nowMs();
      const result = db.prepare(`
        UPDATE pickup_appointments
        SET status = 'delivered', version = version + 1,
            delivered_at = ?, delivered_by_user_id = ?, delivered_by_label = ?,
            updated_at = ?
        WHERE id = ? AND status IN ('booked', 'rescheduled')
      `).run(
        ts, user?.id || null,
        actor.actorLabel, ts, appt.id,
      );
      if (result.changes !== 1) throw new PickupDenial('PICKUP_NOT_ACTIVE');
      // 领取码一次性消费：标记 consumed，任何重放都无法再通过
      consumeCodeTx(appt.id);
      writeAuditTx({
        type: 'pickup.appointment.delivered',
        appointmentNo: appt.appointment_no, receiptNo: appt.receipt_no,
        slotId: appt.slot_id, actor,
        detail: { note: String(note).slice(0, 200), deliveredAt: ts },
      });
      return {
        ok: true,
        delivery: staffDeliveryView(db.prepare('SELECT * FROM pickup_appointments WHERE id = ?').get(appt.id)),
      };
    },
  });
}

// 领取人员按预约编号查看履约最小信息（不校验领取码；不显示办理人身份）
export function getDeliveryContextByNo({ user, appointmentNo }) {
  if (!APPOINTMENT_NO_PATTERN.test(appointmentNo)) {
    return { ok: false, status: 400, code: 'INVALID_INPUT', message: '预约编号格式不正确' };
  }
  const appt = db.prepare('SELECT * FROM pickup_appointments WHERE appointment_no = ?').get(appointmentNo);
  if (!appt) return { ok: false, status: 404, code: 'APPOINTMENT_NOT_FOUND', message: PICKUP_ERRORS.APPOINTMENT_NOT_FOUND };
  return { ok: true, context: staffDeliveryView(appt) };
}

// ===========================================================================
// 回执撤销联动（在外层撤销事务内调用：不单独开事务）
// ===========================================================================
export function invalidateAppointmentsForReceiptRevokedTx({ receiptNo, at = nowMs() }) {
  const rows = db.prepare(`
    SELECT * FROM pickup_appointments
    WHERE receipt_no = ? AND status IN ('booked', 'rescheduled')
  `).all(receiptNo);
  for (const appt of rows) {
    db.prepare(`
      UPDATE pickup_appointments
      SET status = 'revoked', version = version + 1,
          revoke_reason = ?, revoked_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('booked', 'rescheduled')
    `).run('回执被撤销', at, at, appt.id);
    releaseSlotTx(appt.slot_id);
    rotateCodesTx(appt.id);
    writeAuditTx({
      type: 'pickup.appointment.revoked',
      appointmentNo: appt.appointment_no, receiptNo: appt.receipt_no,
      slotId: appt.slot_id,
      actor: { actorUserId: null, actorRole: 'system', actorLabel: '系统（回执撤销联动）' },
      detail: { capacityReleased: true },
      at,
    });
  }
  return rows.length;
}

// 惰性过期：超过 endAt+grace 仍未交付的预约失效（与撤销不同：过期不释放
// 名额——名额在该时间段已被消耗；交付/取消仍按各自规则处理）。
function expireAppointmentIfDueTx(appt, at = nowMs()) {
  if (at <= appt.frozen_end_at + appt.grace_ms) return false;
  db.prepare(`
    UPDATE pickup_appointments
    SET status = 'expired', version = version + 1, expired_at = ?, updated_at = ?
    WHERE id = ? AND status IN ('booked', 'rescheduled')
  `).run(at, at, appt.id);
  rotateCodesTx(appt.id);
  writeAuditTx({
    type: 'pickup.appointment.expired',
    appointmentNo: appt.appointment_no, receiptNo: appt.receipt_no,
    slotId: appt.slot_id,
    actor: { actorUserId: null, actorRole: 'system', actorLabel: '系统（超时未领取）' },
    detail: { capacityReleased: false },
    at,
  });
  return true;
}

export function sweepExpiredPickups({ at = nowMs() } = {}) {
  return immediateTransaction(() => {
    const rows = db.prepare(`
      SELECT * FROM pickup_appointments
      WHERE status IN ('booked', 'rescheduled')
    `).all();
    let count = 0;
    for (const appt of rows) {
      if (expireAppointmentIfDueTx(appt, at)) count += 1;
    }
    return { ok: true, expired: count };
  });
}

// ===========================================================================
// 查询
// ===========================================================================
export function getSlot(slotId) {
  const row = db.prepare('SELECT * FROM pickup_slots WHERE id = ?').get(slotId);
  return row ? slotView(row, row.occupied) : null;
}

export function getLocation(locationId) {
  const row = db.prepare('SELECT * FROM pickup_locations WHERE id = ?').get(locationId);
  if (!row) return null;
  const slots = listSlotsForLocation(locationId).map((slot) => ({ ...slot, occupied: slot.occupied }));
  return locationView(row, slots);
}

export function listSlotsForLocation(locationId) {
  return db.prepare(`
    SELECT * FROM pickup_slots WHERE location_id = ? ORDER BY start_at ASC
  `).all(locationId).map((row) => slotView(row, row.occupied));
}

export function listAllLocations() {
  return db.prepare('SELECT * FROM pickup_locations ORDER BY created_at DESC').all()
    .map((row) => getLocation(row.id));
}

// 办理人视角：可预约的开放时间段（含网点；展示剩余名额）
export function listBookableSlots({ at = nowMs(), onlyFutureStart = true } = {}) {
  const rows = db.prepare(`
    SELECT * FROM pickup_slots
    WHERE status = 'open' AND (? = 0 OR end_at >= ?)
    ORDER BY start_at ASC
  `).all(onlyFutureStart ? 1 : 0, at);
  return rows.map((row) => {
    const location = db.prepare('SELECT * FROM pickup_locations WHERE id = ?').get(row.location_id);
    return {
      ...slotView(row, row.occupied),
      locationId: row.location_id,
      locationName: location?.name || '',
      locationStatus: location?.status || '',
    };
  }).filter((item) => item.locationStatus === 'active');
}

// 派生状态：尚未被扫描落定但已过 endAt+grace 的进行中预约，读取时呈现为过期；
// 真正的状态落定只发生在 sweepExpiredPickups 的写事务里，读路径绝不写库
// （避免读操作开 IMMEDIATE 锁与并发的取消/改约/交付争用）。
export function effectiveAppointmentStatus(row, at = nowMs()) {
  if (row.status === 'booked' || row.status === 'rescheduled') {
    if (at > row.frozen_end_at + row.grace_ms) return 'expired';
  }
  return row.status;
}

function ownerViewWithEffectiveStatus(row, at = nowMs()) {
  const view = handlerAppointmentView(row);
  const effective = effectiveAppointmentStatus(row, at);
  if (effective !== view.status) {
    view.status = effective;
    view.statusLabel = '已过期';
    view.effectiveStatus = true;
  }
  return view;
}

export function getOwnerAppointment(appointmentId, userId) {
  const row = db.prepare(`
    SELECT * FROM pickup_appointments WHERE id = ? AND user_id = ?
  `).get(appointmentId, userId);
  return row ? ownerViewWithEffectiveStatus(row) : null;
}

export function getOwnerAppointmentByNo(appointmentNo, userId) {
  const row = db.prepare(`
    SELECT * FROM pickup_appointments WHERE appointment_no = ? AND user_id = ?
  `).get(appointmentNo, userId);
  return row ? ownerViewWithEffectiveStatus(row) : null;
}

export function listAppointmentsForOwner(userId) {
  const at = nowMs();
  return db.prepare(`
    SELECT * FROM pickup_appointments WHERE user_id = ? ORDER BY created_at DESC
  `).all(userId).map((row) => ownerViewWithEffectiveStatus(row, at));
}

// 主管视角：全部预约（含网点/时间段占用与失败原因）
export function listAllAppointmentsForAdmin() {
  const rows = db.prepare(`
    SELECT a.*, l.name AS current_location_name, s.start_at AS current_start_at,
           s.end_at AS current_end_at, s.capacity AS current_capacity,
           s.occupied AS current_slot_occupied, s.status AS current_slot_status
    FROM pickup_appointments a
    LEFT JOIN pickup_slots s ON s.id = a.slot_id
    LEFT JOIN pickup_locations l ON l.id = s.location_id
    ORDER BY a.created_at DESC
  `).all();
  const at = nowMs();
  return rows.map((row) => ({
    ...ownerViewWithEffectiveStatus(row, at),
    currentSlot: row.current_start_at ? {
      locationName: row.current_location_name,
      startAt: row.current_start_at,
      endAt: row.current_end_at,
      capacity: row.current_capacity,
      occupied: row.current_slot_occupied,
      status: row.current_slot_status,
    } : null,
  }));
}

export function listAuditForAppointment(appointmentNo, { limit = 200 } = {}) {
  return db.prepare(`
    SELECT * FROM pickup_audit WHERE appointment_no = ? ORDER BY id ASC LIMIT ?
  `).all(appointmentNo, limit).map(auditView);
}

export function listRecentDenials({ limit = 100 } = {}) {
  return db.prepare(`
    SELECT * FROM pickup_audit WHERE result = 'denied' ORDER BY id DESC LIMIT ?
  `).all(limit).map(auditView);
}

export function listPickupAudit({ limit = 200 } = {}) {
  return db.prepare('SELECT * FROM pickup_audit ORDER BY id DESC LIMIT ?').all(limit).map(auditView);
}
