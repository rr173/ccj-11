// ---------------------------------------------------------------------------
// 电子回执离线核验设备：持久化与事务编排
//
// 所有写操作走 BEGIN IMMEDIATE；业务拒绝抛 OfflineDenial 让事务回滚，并在事务外
// 补记“拒绝”审计（与 pickupStore 同一并发模型）。
// ---------------------------------------------------------------------------
import { createHash } from 'node:crypto';
import { db, immediateTransaction, cryptoId } from './db.js';
import { nowMs } from './clock.js';
import { config } from './config.js';
import { deriveCode } from './receipts.js';
import {
  assertNoForbiddenFields,
  batchEntriesFingerprint,
  buildPackagePayload,
  canonical,
  entryDigestInput,
  makeEntryFields,
  OFFLINE_ERRORS,
  offlineMaskedRecord,
  packageEnvelope,
  packageSigningBytes,
  parseLabel,
  parseScope,
  parseTtlMs,
  REJECT_REASONS,
  VERDICT,
} from './offline.js';
import {
  destroyDeviceKey,
  exportPublicKeySpki,
  generateDeviceKeyPair,
  signWith,
} from './offlineKeys.js';

export class OfflineDenial extends Error {
  constructor(code, extra = {}) {
    super(OFFLINE_ERRORS[code] || code);
    this.name = 'OfflineDenial';
    this.code = code;
    this.extra = extra;
  }
}

const at = (value) => (value === undefined ? nowMs() : value);

function sha256Hex(value) {
  return createHash('sha256').update(value).digest('hex');
}
function sha256Buffer(value) {
  return createHash('sha256').update(value).digest();
}
// 核验码摘要（域分隔）：设备在离线状态下比对，不掌握服务器核验码密钥
export function offlineCodeDigest(receiptNo, normalizedCode) {
  return sha256Hex(`offline-code:${receiptNo}:${normalizedCode}`);
}

function actorOf(user) {
  return {
    actorUserId: user?.id || null,
    actorRole: user?.role || (user?.actorRole ? 'device' : ''),
    actorLabel: user?.display_name || user?.displayName || user?.username || (user?.deviceId ? `设备 ${user.deviceId}` : ''),
  };
}

// 只追加审计
export function writeOfflineAuditTx({
  type, deviceId = '', deviceName = '', receiptNo = '', actor, detail = {}, result = 'success', at: when = at(),
}) {
  db.prepare(`
    INSERT INTO offline_audit
      (type, device_id, device_name, receipt_no, actor_user_id, actor_role, actor_label, detail_json, result, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    type, deviceId, deviceName, receiptNo,
    actor?.actorUserId ?? null, actor?.actorRole || '', actor?.actorLabel || '',
    JSON.stringify(detail), result, when,
  );
}

function runMutation(fn, { deniedType, auditRef = {}, actor, deniedStatus = 409 } = {}) {
  try {
    return immediateTransaction(fn);
  } catch (error) {
    if (!(error instanceof OfflineDenial)) throw error;
    immediateTransaction(() => {
      writeOfflineAuditTx({
        type: deniedType,
        actor: actor || auditRef.actor || { actorRole: 'device', actorLabel: '未知设备' },
        result: 'denied',
        deviceId: auditRef.deviceId || '',
        deviceName: auditRef.deviceName || '',
        receiptNo: auditRef.receiptNo || '',
        detail: { reason: error.code, message: error.message, ...(error.extra || {}) },
      });
    });
    const status = Number.isInteger(error.status) ? error.status : deniedStatus;
    return { ok: false, status, code: error.code, message: error.message, extra: error.extra };
  }
}

// ---------------------------------------------------------------------------
// 脱敏记录 / 增量 feed
// ---------------------------------------------------------------------------
function maskedFromReceiptRow(row, { statusOverride, revokedAtOverride } = {}) {
  const snapshot = JSON.parse(row.snapshot_json);
  const code = deriveVerifyCodeForRow(row);
  const record = offlineMaskedRecord({
    receiptNo: row.receipt_no,
    status: statusOverride || row.status,
    issuedAt: row.issued_at,
    completedAt: snapshot.completedAt || null,
    revokedAt: revokedAtOverride ?? row.revoked_at ?? null,
    snapshot,
    codeDigest: offlineCodeDigest(row.receipt_no, code),
  });
  assertNoForbiddenFields(record);
  const { digest: _omit, ...recordWithoutDigest } = record;
  record.digest = sha256Hex(canonical(recordWithoutDigest));
  return record;
}

// 从现有 HMAC 模块取核验码（与公开核验同一派生），只用于计算离线摘要。
// receipts.js 不依赖 db 实例，直接静态导入无循环问题。
function deriveVerifyCodeForRow(row) {
  // 与设备端 deriveCodeDigest 一致：使用去空格/连字符的大写码
  return deriveCode(row.receipt_no).replace(/[\s-]/g, '').toUpperCase();
}

export function appendFeedItemTx({ receiptNo, kind, status, masked, ownerUserId, createdAt }) {
  const info = db.prepare(`
    INSERT INTO offline_feed (receipt_no, kind, status, masked_json, digest, receipt_owner_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(receiptNo, kind, status, JSON.stringify(masked), masked.digest, ownerUserId || '', createdAt);
  return Number(info.lastInsertRowid);
}

function latestFeedRowsForReceiptsTx(receiptNos) {
  if (receiptNos.length === 0) return new Map();
  const placeholder = receiptNos.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT f.* FROM offline_feed f
    JOIN (SELECT receipt_no, MAX(seq) AS max_seq FROM offline_feed WHERE receipt_no IN (${placeholder}) GROUP BY receipt_no) m
      ON m.receipt_no = f.receipt_no AND f.seq = m.max_seq
  `).all(...receiptNos);
  return new Map(rows.map((r) => [r.receipt_no, r]));
}

function currentMaskedForDeviceTx(device, receiptNo) {
  const row = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(receiptNo);
  if (!row) return null;
  return maskedFromReceiptRow(row);
}

// 回执签发 / 撤销事务内挂钩（由 db.js 在同一事务中调用）
export function onReceiptIssuedTx(row) {
  const masked = maskedFromReceiptRow(row);
  appendFeedItemTx({
    receiptNo: row.receipt_no, kind: 'issued', status: 'issued',
    masked, ownerUserId: row.user_id, createdAt: row.issued_at,
  });
}
export function onReceiptRevokedTx(row, revokedAt) {
  const masked = maskedFromReceiptRow(row, { statusOverride: 'revoked', revokedAtOverride: revokedAt });
  appendFeedItemTx({
    receiptNo: row.receipt_no, kind: 'revoked', status: 'revoked',
    masked, ownerUserId: row.user_id, createdAt: revokedAt,
  });
}

// 为固定范围设备选取发包时刻的全部记录（已含最新状态）
function recordsForScopeTx(device) {
  const nos = device.scope_kind === 'all'
    ? db.prepare('SELECT receipt_no FROM receipts ORDER BY receipt_no').all().map((r) => r.receipt_no)
    : JSON.parse(device.scope_receipt_nos || '[]');
  const records = [];
  for (const no of nos) {
    const row = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(no);
    if (row) records.push(maskedFromReceiptRow(row));
  }
  return records;
}

function feedCursorNow() {
  const row = db.prepare('SELECT MAX(seq) AS max_seq FROM offline_feed').get();
  return Number(row.max_seq || 0);
}

function getDeviceRow(deviceId) {
  return db.prepare('SELECT * FROM offline_devices WHERE id = ?').get(deviceId) || null;
}

function deviceView(row) {
  if (!row) return null;
  const state = db.prepare('SELECT * FROM offline_device_state WHERE device_id = ?').get(row.id);
  const scopeNos = JSON.parse(row.scope_receipt_nos || '[]');
  const pending = pendingDeltaCount(row, state?.cursor_seq || 0);
  return {
    id: row.id,
    name: row.name,
    status: row.status,
    scope: { kind: row.scope_kind, receiptNos: scopeNos, count: row.scope_kind === 'all' ? null : scopeNos.length },
    expiresAt: row.expires_at,
    graceMs: row.grace_ms,
    keyVersion: row.key_version,
    registeredAt: row.created_at,
    registeredBy: row.registered_by_label,
    disabledAt: row.disabled_at || null,
    disableReason: row.disable_reason || '',
    cursor: state?.cursor_seq || 0,
    acceptedSeq: state?.accepted_seq || 0,
    lastSyncAt: state?.last_sync_at || 0,
    pendingDelta: pending,
    forkReason: latestForkReason(row.id),
  };
}

function pendingDeltaCount(device, afterCursor) {
  if (device.scope_kind === 'all') {
    return db.prepare('SELECT COUNT(*) AS c FROM offline_feed WHERE seq > ?').get(afterCursor).c;
  }
  const nos = JSON.parse(device.scope_receipt_nos || '[]');
  if (nos.length === 0) return 0;
  const ph = nos.map(() => '?').join(',');
  return db.prepare(
    `SELECT COUNT(*) AS c FROM offline_feed WHERE seq > ? AND receipt_no IN (${ph})`,
  ).get(afterCursor, ...nos).c;
}

function latestForkReason(deviceId) {
  const row = db.prepare(`
    SELECT detail_json FROM offline_audit
    WHERE device_id = ? AND result = 'denied'
      AND detail_json LIKE '%"reason":"LOG_%'
    ORDER BY id DESC LIMIT 1
  `).get(deviceId);
  if (!row) return '';
  try {
    const detail = JSON.parse(row.detail_json);
    return detail.reason || '';
  } catch {
    return '';
  }
}

// ---------------------------------------------------------------------------
// 主管：登记设备
// ---------------------------------------------------------------------------
export function registerDevice({ user, name, scope, ttlMs, graceMs }) {
  const actor = actorOf(user);
  return runMutation(() => {
    const labelCheck = parseLabel(name);
    if (!labelCheck.ok) throw new OfflineDenial(labelCheck.code, { message: labelCheck.message });
    const ttlCheck = parseTtlMs(ttlMs, {
      min: config.offlineTtlMinMs, max: config.offlineTtlMaxMs, fallback: config.offlineTtlDefaultMs,
    });
    if (ttlMs !== undefined && !ttlCheck.ok) {
      throw new OfflineDenial('INVALID_TTL', { message: '授权有效期不在允许范围内' });
    }
    const graceCheck = parseTtlMs(graceMs, {
      min: config.offlineGraceMinMs, max: config.offlineGraceMaxMs, fallback: config.offlineGraceDefaultMs,
    });
    if (graceMs !== undefined && !graceCheck.ok) {
      throw new OfflineDenial('INVALID_GRACE', { message: '撤销宽限期不在允许范围内' });
    }
    const validReceiptNos = db.prepare('SELECT receipt_no FROM receipts').all();
    const scopeCheck = parseScope(scope || { kind: 'all' }, { allReceiptNos: validReceiptNos });
    if (!scopeCheck.ok) throw new OfflineDenial(scopeCheck.code, { message: scopeCheck.message });

    const ts = at();
    const id = cryptoId();
    db.prepare(`
      INSERT INTO offline_devices
        (id, name, status, scope_kind, scope_receipt_nos, expires_at, grace_ms, key_version,
         registered_by_user_id, registered_by_label, created_at, updated_at)
      VALUES (?, ?, 'active', ?, ?, ?, ?, 1, ?, ?, ?, ?)
    `).run(
      id, labelCheck.value, scopeCheck.value.kind, JSON.stringify(scopeCheck.value.receiptNos),
      ts + ttlCheck.value, graceCheck.value,
      user?.id || null, actor.actorLabel, ts, ts,
    );
    db.prepare('INSERT INTO offline_device_state (device_id) VALUES (?)').run(id);
    writeOfflineAuditTx({
      type: 'offline.device.registered', deviceId: id, deviceName: labelCheck.value, actor,
      detail: {
        scope: scopeCheck.value,
        expiresAt: ts + ttlCheck.value,
        graceMs: graceCheck.value,
      },
    });
    return { ok: true, device: deviceView(getDeviceRow(id)) };
  }, { deniedType: 'offline.device.registered', actor, deniedStatus: 400 });
}

export function listDevicesForSupervisor() {
  return db.prepare('SELECT * FROM offline_devices ORDER BY created_at DESC').all().map(deviceView);
}
export function getDeviceForSupervisor(deviceId) {
  return deviceView(getDeviceRow(deviceId));
}

// ---------------------------------------------------------------------------
// 授权包：生成（主管），一次性下载凭证
// ---------------------------------------------------------------------------
function issuePackageTx({ device, actor, keyVersion, nowValue }) {
  const { privateKey, publicKey } = generateDeviceKeyPair(device.id, keyVersion);
  const baselineCursor = feedCursorNow();
  const records = recordsForScopeTx(device);
  const payload = buildPackagePayload({
    deviceId: device.id,
    deviceLabel: device.name,
    keyVersion,
    scope: { kind: device.scope_kind, receiptNos: JSON.parse(device.scope_receipt_nos || '[]') },
    issuedAt: nowValue,
    expiresAt: device.expires_at,
    graceMs: device.grace_ms,
    baselineCursor,
    publicKey: exportPublicKeySpki(publicKey),
    records,
  });
  assertNoForbiddenFields(payload);
  const signature = signWith(privateKey, packageSigningBytes(payload));
  const envelope = packageEnvelope(payload, signature);

  // 旧版授权包（同设备）全部作废（被新版本取代）
  db.prepare(`
    UPDATE offline_authorizations SET status = 'superseded', rotated_at = ?
    WHERE device_id = ? AND status IN ('pending', 'downloaded')
  `).run(nowValue, device.id);

  const id = cryptoId();
  db.prepare(`
    INSERT INTO offline_authorizations
      (id, device_id, key_version, status, scope_kind, scope_receipt_nos, envelope_json,
       baseline_cursor, receipt_count, grace_ms, expires_at, created_by_user_id, created_by_label, created_at)
    VALUES (?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, device.id, keyVersion, device.scope_kind, device.scope_receipt_nos,
    JSON.stringify(envelope), baselineCursor, records.length, device.grace_ms, device.expires_at,
    actor.actorUserId, actor.actorLabel, nowValue,
  );

  // 一次性下载凭证（明文只返回这一次）
  const credential = cryptoId() + cryptoId();
  const codeHash = sha256Buffer(credential);
  db.prepare(`
    INSERT INTO offline_pkg_credentials
      (id, authorization_id, device_id, code_hash, status, expires_at, created_at, used_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?, NULL)
  `).run(cryptoId(), id, device.id, codeHash, nowValue + config.offlinePackageCredentialTtlMs, nowValue);

  writeOfflineAuditTx({
    type: 'offline.package.issued', deviceId: device.id, deviceName: device.name, actor,
    detail: { keyVersion, baselineCursor, receiptCount: records.length, authorizationId: id },
  });

  return {
    ok: true,
    authorizationId: id,
    credential,
    keyVersion,
    baselineCursor,
    expiresAt: nowValue + config.offlinePackageCredentialTtlMs,
    device: deviceView(getDeviceRow(device.id)),
  };
}

export function generateAuthorization({ user, deviceId }) {
  const actor = actorOf(user);
  return runMutation(() => {
    const device = getDeviceRow(deviceId);
    if (!device) throw new OfflineDenial('DEVICE_NOT_FOUND');
    if (device.status === 'disabled') throw new OfflineDenial('DEVICE_DISABLED');
    if (device.expires_at <= at()) throw new OfflineDenial('DEVICE_EXPIRED');
    return issuePackageTx({ device, actor, keyVersion: device.key_version, nowValue: at() });
  }, { deniedType: 'offline.package.issued', auditRef: { deviceId, actor }, actor });
}

// 轮换授权：新版本密钥、新设备令牌、旧包与旧日志终结
export function rotateAuthorization({ user, deviceId, ttlMs, graceMs }) {
  const actor = actorOf(user);
  return runMutation(() => {
    const device = getDeviceRow(deviceId);
    if (!device) throw new OfflineDenial('DEVICE_NOT_FOUND');
    if (device.status === 'disabled') throw new OfflineDenial('DEVICE_DISABLED');
    const ts = at();

    const updates = [];
    const params = [];
    if (ttlMs !== undefined) {
      const check = parseTtlMs(ttlMs, { min: config.offlineTtlMinMs, max: config.offlineTtlMaxMs, fallback: device.expires_at - ts });
      if (!check.ok) throw new OfflineDenial('INVALID_TTL');
      updates.push('expires_at = ?'); params.push(ts + check.value);
    }
    if (graceMs !== undefined) {
      const check = parseTtlMs(graceMs, { min: config.offlineGraceMinMs, max: config.offlineGraceMaxMs, fallback: device.grace_ms });
      if (!check.ok) throw new OfflineDenial('INVALID_GRACE');
      updates.push('grace_ms = ?'); params.push(check.value);
    }
    const newKeyVersion = device.key_version + 1;
    updates.push('key_version = ?', 'updated_at = ?');
    params.push(newKeyVersion, ts, deviceId);
    db.prepare(`UPDATE offline_devices SET ${updates.join(', ')} WHERE id = ?`).run(...params);

    // 旧令牌作废、旧授权包标记轮换、旧密钥文件销毁
    db.prepare("UPDATE offline_device_tokens SET status = 'rotated' WHERE device_id = ? AND status = 'current'").run(deviceId);
    db.prepare(`
      UPDATE offline_authorizations SET status = 'rotated', rotated_at = ?
      WHERE device_id = ? AND key_version < ? AND status IN ('pending', 'downloaded')
    `).run(ts, deviceId, newKeyVersion);
    destroyDeviceKey(deviceId, device.key_version);

    // 新设备令牌（token_seq 单调递增；旧令牌标记 rotated 保留以备审计）
    const rawToken = cryptoId() + cryptoId();
    const nextTokenSeq = (db.prepare('SELECT COALESCE(MAX(token_seq), 0) + 1 AS n FROM offline_device_tokens WHERE device_id = ?').get(deviceId).n);
    db.prepare(`
      INSERT INTO offline_device_tokens (device_id, token_seq, token_hash, status, created_at)
      VALUES (?, ?, ?, 'current', ?)
    `).run(deviceId, nextTokenSeq, sha256Buffer(rawToken), ts);

    writeOfflineAuditTx({
      type: 'offline.device.rotated', deviceId, deviceName: device.name, actor,
      detail: { oldKeyVersion: device.key_version, newKeyVersion },
    });

    const refreshed = getDeviceRow(deviceId);
    const issued = issuePackageTx({ device: refreshed, actor, keyVersion: newKeyVersion, nowValue: ts });
    // 新授权的日志链重新开始；游标基线以新包 baselineCursor 为准
    db.prepare('UPDATE offline_device_state SET accepted_seq = 0, last_digest = ?, cursor_seq = ? WHERE device_id = ?')
      .run('', issued.baselineCursor, deviceId);
    return { ...issued, token: rawToken };
  }, { deniedType: 'offline.device.rotated', auditRef: { deviceId, actor }, actor });
}

// 登记设备时同时生成首个授权包与设备令牌（一次给出设备令牌与下载凭证）
export function registerDeviceWithPackage(input) {
  const base = registerDevice(input);
  if (!base.ok) return base;
  const deviceId = base.device.id;
  const issued = runMutation(() => {
    const device = getDeviceRow(deviceId);
    const ts = at();
    const rawToken = cryptoId() + cryptoId();
    db.prepare(`
      INSERT INTO offline_device_tokens (device_id, token_seq, token_hash, status, created_at)
      VALUES (?, 1, ?, 'current', ?)
    `).run(deviceId, sha256Buffer(rawToken), ts);
    const actor = actorOf(input.user);
    const pkg = issuePackageTx({ device, actor, keyVersion: 1, nowValue: ts });
    // 设备初始游标 = 授权包基线游标；日志链从序号 1 开始
    db.prepare('UPDATE offline_device_state SET cursor_seq = ? WHERE device_id = ?')
      .run(pkg.baselineCursor, deviceId);
    return { ...pkg, token: rawToken };
  }, { deniedType: 'offline.package.issued', auditRef: { deviceId }, actor: actorOf(input.user) });
  if (!issued.ok) return issued;
  return { ok: true, device: base.device, token: issued.token, authorizationId: issued.authorizationId, credential: issued.credential, keyVersion: issued.keyVersion, expiresAt: issued.expiresAt };
}

// 免登录：凭一次性下载凭证取授权包（只能成功一次）
export function redeemPackageCredential({ rawCredential }) {
  return runMutation(() => {
    const ts = at();
    const cred = db.prepare('SELECT * FROM offline_pkg_credentials WHERE code_hash = ?').get(sha256Buffer(String(rawCredential || '')));
    if (!cred) throw new OfflineDenial('PACKAGE_NOT_FOUND');
    if (cred.status === 'used' || cred.used_at) throw new OfflineDenial('PACKAGE_ALREADY_DOWNLOADED');
    if (cred.expires_at <= ts) {
      db.prepare("UPDATE offline_pkg_credentials SET status = 'expired' WHERE id = ?").run(cred.id);
      throw new OfflineDenial('PACKAGE_CREDENTIAL_EXPIRED');
    }
    const auth = db.prepare('SELECT * FROM offline_authorizations WHERE id = ?').get(cred.authorization_id);
    if (!auth) throw new OfflineDenial('PACKAGE_NOT_FOUND');
    if (auth.status === 'rotated' || auth.status === 'superseded') {
      throw new OfflineDenial('AUTHORIZATION_ROTATED');
    }
    const device = getDeviceRow(auth.device_id);
    if (!device || device.status === 'disabled') throw new OfflineDenial('DEVICE_DISABLED');

    // 一次性消费
    const updated = db.prepare(`
      UPDATE offline_pkg_credentials SET status = 'used', used_at = ?
      WHERE id = ? AND status = 'active'
    `).run(ts, cred.id);
    if (updated.changes !== 1) throw new OfflineDenial('PACKAGE_ALREADY_DOWNLOADED');
    db.prepare("UPDATE offline_authorizations SET status = 'downloaded', downloaded_at = ? WHERE id = ?")
      .run(ts, auth.id);

    writeOfflineAuditTx({
      type: 'offline.package.downloaded', deviceId: device.id, deviceName: device.name,
      actor: { actorRole: 'device', actorLabel: `设备 ${device.name}` },
      detail: { keyVersion: auth.key_version, authorizationId: auth.id },
    });

    return {
      ok: true,
      envelope: JSON.parse(auth.envelope_json),
      keyVersion: auth.key_version,
      expiresAt: device.expires_at,
    };
  }, { deniedType: 'offline.package.downloaded' });
}

// ---------------------------------------------------------------------------
// 主管：停用（设备丢失）
// ---------------------------------------------------------------------------
export function disableDevice({ user, deviceId, reason }) {
  const actor = actorOf(user);
  return runMutation(() => {
    const device = getDeviceRow(deviceId);
    if (!device) throw new OfflineDenial('DEVICE_NOT_FOUND');
    if (device.status === 'disabled') throw new OfflineDenial('ALREADY_DISABLED');
    const ts = at();
    db.prepare(`
      UPDATE offline_devices SET status = 'disabled', disabled_at = ?, disabled_by_user_id = ?,
        disable_reason = ?, updated_at = ? WHERE id = ?
    `).run(ts, user?.id || null, String(reason || '').slice(0, 200), ts, deviceId);
    db.prepare("UPDATE offline_device_tokens SET status = 'rotated' WHERE device_id = ? AND status = 'current'").run(deviceId);
    db.prepare(`
      UPDATE offline_authorizations SET status = 'rotated', rotated_at = ?
      WHERE device_id = ? AND status IN ('pending', 'downloaded')
    `).run(ts, deviceId);
    destroyDeviceKey(deviceId, device.key_version);
    writeOfflineAuditTx({
      type: 'offline.device.disabled', deviceId, deviceName: device.name, actor,
      detail: { reason: String(reason || '').slice(0, 200) },
    });
    return { ok: true, device: deviceView(getDeviceRow(deviceId)) };
  }, { deniedType: 'offline.device.disabled', auditRef: { deviceId, actor }, actor });
}

// ---------------------------------------------------------------------------
// 设备同步令牌认证
// ---------------------------------------------------------------------------
function authenticateDeviceToken(rawToken) {
  const tokenHash = sha256Buffer(String(rawToken || ''));
  const tokenRow = db.prepare(`
    SELECT t.*, d.name AS device_name FROM offline_device_tokens t
    JOIN offline_devices d ON d.id = t.device_id
    WHERE t.token_hash = ?
  `).get(tokenHash);
  if (!tokenRow) return { ok: false, code: 'DEVICE_TOKEN_INVALID' };
  if (tokenRow.status !== 'current') {
    return { ok: false, code: 'AUTHORIZATION_ROTATED', deviceId: tokenRow.device_id, deviceName: tokenRow.device_name };
  }
  const device = getDeviceRow(tokenRow.device_id);
  if (!device) return { ok: false, code: 'DEVICE_NOT_FOUND' };
  if (device.status === 'disabled') return { ok: false, code: 'DEVICE_DISABLED', deviceId: device.id, deviceName: device.name };
  return { ok: true, device, tokenRow };
}

// ---------------------------------------------------------------------------
// 增量拉取（在上传处理之后执行，复用同一游标）
// ---------------------------------------------------------------------------
function scopeReceiptsForDeltaTx(device) {
  if (device.scope_kind === 'all') return null;
  return JSON.parse(device.scope_receipt_nos || '[]');
}

function fetchDeltaTx(device, afterCursor, limit) {
  const scopedNos = scopeReceiptsForDeltaTx(device);
  let rows;
  if (scopedNos === null) {
    rows = db.prepare('SELECT * FROM offline_feed WHERE seq > ? ORDER BY seq ASC LIMIT ?').all(afterCursor, limit);
  } else if (scopedNos.length === 0) {
    rows = [];
  } else {
    const ph = scopedNos.map(() => '?').join(',');
    rows = db.prepare(
      `SELECT * FROM offline_feed WHERE seq > ? AND receipt_no IN (${ph}) ORDER BY seq ASC LIMIT ?`,
    ).all(afterCursor, ...scopedNos, limit);
  }
  return rows.map((r) => {
    const masked = JSON.parse(r.masked_json);
    return {
      seq: r.seq,
      receiptNo: r.receipt_no,
      kind: r.kind,
      scoped: true,
      ...masked,
    };
  });
}

// 撤销宽限：最近一次“设备仍在范围内但尚未同步”的撤销给出的最终同步期限
function mustSyncBeforeForDeviceTx(device, cursor) {
  const scopedNos = scopeReceiptsForDeltaTx(device);
  let pendingRevocations;
  if (scopedNos === null) {
    pendingRevocations = db.prepare(`
      SELECT * FROM offline_feed WHERE seq > ? AND kind = 'revoked'
    `).all(cursor);
  } else if (scopedNos.length === 0) {
    pendingRevocations = [];
  } else {
    const ph = scopedNos.map(() => '?').join(',');
    pendingRevocations = db.prepare(`
      SELECT * FROM offline_feed WHERE seq > ? AND kind = 'revoked' AND receipt_no IN (${ph})
    `).all(cursor, ...scopedNos);
  }
  if (pendingRevocations.length === 0) return 0;
  // 取最早撤销时间 + grace（最紧约束）
  let earliest = Infinity;
  for (const r of pendingRevocations) earliest = Math.min(earliest, r.created_at);
  return earliest + device.grace_ms;
}

// ---------------------------------------------------------------------------
// 设备同步：上传日志批次（幂等）+ 拉取增量
//
// 游标协议（cursor_seq 持久化在 offline_device_state，重启不丢）：
//  - 空批次 = 只拉取：设备游标可落后于服务器（补拉丢失的响应），但不能领先（伪造倒退）。
//  - 新批次（带日志）：设备游标必须等于服务器游标——保证日志链基于同一撤销视图。
//  - 同 batchId 重传：内容指纹必须一致；幂等成功并按服务器当前游标重新下发增量。
// 服务器每次成功同步都把本次下发到的新游标落库，因此“游标倒退”可被稳定识别。
// ---------------------------------------------------------------------------
export function deviceSync({ rawToken, body }) {
  const auth = authenticateDeviceToken(rawToken);
  const actor = { actorRole: 'device', actorLabel: `设备 ${auth.deviceName || '未知'}`, actorUserId: null };
  const auditRef = { deviceId: auth.deviceId || (body?.deviceId) || '', deviceName: auth.deviceName || '', actor };

  return runMutation(() => {
    if (!auth.ok) throw new OfflineDenial(auth.code);
    const device = auth.device;
    const ts = at();
    if (device.expires_at <= ts) throw new OfflineDenial('DEVICE_EXPIRED');

    const deviceId = String(body?.deviceId || '');
    if (deviceId !== device.id) throw new OfflineDenial('IDENTITY_MISMATCH');
    const keyVersion = Number(body?.keyVersion);
    if (!Number.isInteger(keyVersion) || keyVersion !== device.key_version) {
      throw new OfflineDenial('KEY_VERSION_MISMATCH');
    }
    const clientCursor = Number(body?.cursor);
    if (!Number.isInteger(clientCursor) || clientCursor < 0) throw new OfflineDenial('CURSOR_INVALID');

    const stateRow = db.prepare('SELECT * FROM offline_device_state WHERE device_id = ?').get(device.id);
    const serverCursor = stateRow.cursor_seq;
    // 客户端游标领先服务器 = 伪造/倒退
    if (clientCursor > serverCursor) {
      throw new OfflineDenial('CURSOR_REGRESSED', { serverCursor });
    }

    const batchId = String(body?.batchId || '');
    const entries = Array.isArray(body?.entries) ? body.entries : null;
    const hasEntries = entries && entries.length > 0;
    let acceptedCount = 0;
    let duplicate = false;
    let uploadCursor = serverCursor;

    if (hasEntries) {
      if (entries.length > config.offlineSyncMaxLogs) throw new OfflineDenial('BATCH_TOO_LARGE');
      if (!/^[A-Za-z0-9_-]{8,200}$/.test(batchId)) throw new OfflineDenial('BATCH_EMPTY', { message: '批次号不合法' });

      const fingerprint = batchEntriesFingerprint(entries);
      const existingBatch = db.prepare('SELECT * FROM offline_batches WHERE device_id = ? AND batch_id = ?')
        .get(device.id, batchId);
      if (existingBatch) {
        // 同 batchId 重传：内容不同即拒绝；内容一致即幂等，不重复落库、不覆盖已收日志
        if (existingBatch.fingerprint !== fingerprint) {
          throw new OfflineDenial('BATCH_DUPLICATE_CONFLICT', { batchId });
        }
        duplicate = true;
        acceptedCount = existingBatch.entry_count;
      } else {
        // 新批次：设备必须先追平服务器游标后才能上传，避免基于过期撤销视图记日志
        if (clientCursor !== serverCursor) {
          throw new OfflineDenial('CURSOR_REGRESSED', {
            serverCursor,
            hint: '设备游标落后，请先以空批次拉取增量后再上传',
          });
        }
        acceptedCount = acceptNewBatchTx({
          device, entries, batchId, fingerprint, cursor: serverCursor, state: stateRow, ts,
        });
      }
    }

    // 下发增量并把新游标持久化（上传与拉取在同一事务，要么都生效要么都回滚）
    const delta = fetchDeltaTx(device, uploadCursor, config.offlineSyncMaxDelta);
    const newCursor = delta.length > 0 ? delta[delta.length - 1].seq : uploadCursor;
    const hasMore = delta.length === config.offlineSyncMaxDelta;
    // 截止同步期限只统计“本次下发之后仍未送达”的撤销；本响应已送达的撤销立即生效，
    // 设备本机随之立即拒绝，无需再给宽限。
    const mustSyncBefore = mustSyncBeforeForDeviceTx(device, newCursor);

    db.prepare('UPDATE offline_device_state SET cursor_seq = ?, last_sync_at = ? WHERE device_id = ?')
      .run(newCursor, ts, device.id);

    writeOfflineAuditTx({
      type: 'offline.sync.completed', deviceId: device.id, deviceName: device.name, actor,
      detail: {
        batchId: batchId || null,
        acceptedCount,
        duplicate,
        clientCursor,
        cursorBefore: uploadCursor,
        cursorAfter: newCursor,
        deltaCount: delta.length,
        mustSyncBefore,
      },
    });

    return {
      ok: true,
      deviceId: device.id,
      keyVersion: device.key_version,
      serverAt: ts,
      cursor: newCursor,
      hasMore,
      acceptedCount,
      duplicate,
      acceptedSeq: db.prepare('SELECT accepted_seq FROM offline_device_state WHERE device_id = ?').get(device.id).accepted_seq,
      mustSyncBefore,
      graceMs: device.grace_ms,
      delta,
    };
  }, { deniedType: 'offline.sync.denied', auditRef, actor });
}

function acceptNewBatchTx({ device, entries, batchId, fingerprint, cursor, state, ts }) {
  const expectedFirstSeq = state.accepted_seq + 1;

  // 1) 结构与逐字段校验
  const clean = [];
  for (const e of entries) {
    if (!Number.isInteger(e?.seq) || e.seq <= 0) throw new OfflineDenial('LOG_GAP');
    if (!['accepted', 'rejected'].includes(e.result)) throw new OfflineDenial('LOG_DIGEST_INVALID');
    const entryAt = Number(e.at);
    if (!Number.isInteger(entryAt) || entryAt <= 0) throw new OfflineDenial('ENTRY_TIME_INVALID');
    if (entryAt > ts + 5 * 60 * 1000) throw new OfflineDenial('ENTRY_TIME_INVALID');
    if (e.deviceId && e.deviceId !== device.id) throw new OfflineDenial('IDENTITY_MISMATCH');
    clean.push(e);
  }
  clean.sort((a, b) => a.seq - b.seq);

  // 2) 序号连续：必须紧接服务器已接受序号
  for (let i = 0; i < clean.length; i += 1) {
    if (clean[i].seq !== expectedFirstSeq + i) {
      const conflict = db.prepare('SELECT digest, result, reason, receipt_no FROM offline_logs WHERE device_id = ? AND seq = ?')
        .get(device.id, clean[i].seq);
      if (conflict) {
        if (conflict.digest !== clean[i].digest) throw new OfflineDenial('LOG_DUPLICATE_CONFLICT', { seq: clean[i].seq });
      }
      throw new OfflineDenial('LOG_GAP', { expected: expectedFirstSeq + i, actual: clean[i].seq });
    }
  }

  // 3) 摘要链：首条必须承接服务器链头，逐条重算摘要
  let prev = state.last_digest;
  const scopedNos = scopeReceiptsForDeltaTx(device);
  for (const e of clean) {
    if ((e.prevDigest || '') !== prev) throw new OfflineDenial('LOG_FORK', { seq: e.seq });
    const fields = makeEntryFields({
      deviceId: device.id,
      seq: e.seq,
      receiptNo: e.receiptNo,
      result: e.result,
      reason: e.reason || '',
      at: Number(e.at),
      prevDigest: e.prevDigest || '',
    });
    const expectedDigest = sha256Hex(canonical(entryDigestInput(fields)));
    if (!e.digest || e.digest !== expectedDigest) throw new OfflineDenial('LOG_DIGEST_INVALID', { seq: e.seq });

    // 4) 范围：accepted 结果的回执必须在当前授权范围内
    if (e.result === VERDICT.accepted) {
      const inScope = scopedNos === null
        ? Boolean(db.prepare('SELECT 1 FROM receipts WHERE receipt_no = ?').get(e.receiptNo))
        : scopedNos.includes(e.receiptNo);
      if (!inScope) throw new OfflineDenial('RECEIPT_NOT_IN_SCOPE', { seq: e.seq, receiptNo: e.receiptNo });
    }

    // 5) 撤销宽限：被撤回执在宽限期之后仍被当作有效核验，服务器拒绝整批
    if (e.result === VERDICT.accepted) {
      const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(e.receiptNo);
      if (receipt?.status === 'revoked' && receipt.revoked_at
        && Number(e.at) > receipt.revoked_at + device.grace_ms) {
        throw new OfflineDenial('REVOKED_BEYOND_GRACE', {
          seq: e.seq, receiptNo: e.receiptNo,
          revokedAt: receipt.revoked_at, graceDeadline: receipt.revoked_at + device.grace_ms,
        });
      }
    }
    prev = e.digest;
  }

  // 6) 落库（UNIQUE(device_id, seq) 兜底并发）
  const insertLog = db.prepare(`
    INSERT INTO offline_logs
      (id, device_id, key_version, seq, receipt_no, result, reason, prev_digest, digest, entry_at, batch_id, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  for (const e of clean) {
    try {
      insertLog.run(
        cryptoId(), device.id, device.key_version, e.seq, String(e.receiptNo || ''),
        e.result, String(e.reason || ''), e.prevDigest || '', e.digest, Number(e.at), batchId, ts,
      );
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE')) throw new OfflineDenial('LOG_DUPLICATE_CONFLICT', { seq: e.seq });
      throw error;
    }
    writeOfflineAuditTx({
      type: e.result === 'accepted' ? 'offline.verify.accepted' : 'offline.verify.rejected',
      deviceId: device.id, deviceName: device.name, receiptNo: e.receiptNo || '',
      actor: { actorRole: 'device', actorLabel: `设备 ${device.name}` },
      detail: {
        seq: e.seq, reason: e.reason || '', at: Number(e.at), keyVersion: device.key_version, batchId,
      },
    });
  }

  db.prepare(`
    INSERT INTO offline_batches
      (batch_id, device_id, fingerprint, first_seq, last_seq, entry_count, cursor_before, received_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(batchId, device.id, fingerprint, clean[0].seq, clean[clean.length - 1].seq, clean.length, cursor, ts);

  db.prepare(`
    UPDATE offline_device_state SET accepted_seq = ?, last_digest = ?, last_sync_at = ? WHERE device_id = ?
  `).run(clean[clean.length - 1].seq, prev, ts, device.id);

  return clean.length;
}

// ---------------------------------------------------------------------------
// 审计与办理人视图
// ---------------------------------------------------------------------------
export function listOfflineAuditForAuditor({ type = '', result = '', deviceId = '', receiptNo = '', limit = 300 } = {}) {
  const where = [];
  const params = [];
  if (type) { where.push('type = ?'); params.push(type); }
  if (result) { where.push('result = ?'); params.push(result); }
  if (deviceId) { where.push('device_id = ?'); params.push(deviceId); }
  if (receiptNo) { where.push('receipt_no = ?'); params.push(receiptNo); }
  const sql = `SELECT * FROM offline_audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT ?`;
  return db.prepare(sql).all(...params, Math.min(Number(limit) || 300, 1000)).map((r) => ({
    id: r.id,
    type: r.type,
    deviceId: r.device_id,
    deviceName: r.device_name,
    receiptNo: r.receipt_no,
    actor: { userId: r.actor_user_id, role: r.actor_role, label: r.actor_label },
    detail: JSON.parse(r.detail_json),
    result: r.result,
    createdAt: r.created_at,
  }));
}

// 办理人：只能看到自己回执被离线核验的情况（看不到设备密钥/包内容/他人回执）
export function listOfflineVerificationsForOwner(userId) {
  const rows = db.prepare(`
    SELECT l.seq, l.receipt_no, l.result, l.reason, l.entry_at, l.received_at,
           l.device_id, d.name AS device_name, l.key_version
    FROM offline_logs l
    JOIN receipts r ON r.receipt_no = l.receipt_no
    JOIN offline_devices d ON d.id = l.device_id
    WHERE r.user_id = ?
    ORDER BY l.entry_at DESC, l.seq DESC
  `).all(userId);
  return rows.map((r) => ({
    seq: r.seq,
    receiptNo: r.receipt_no,
    result: r.result,
    reason: r.reason || null,
    verifiedAt: r.entry_at,
    syncedAt: r.received_at,
    device: { id: r.device_id, name: r.device_name },
    keyVersion: r.key_version,
  }));
}

export function getDeviceLogsForSupervisor(deviceId, { limit = 200 } = {}) {
  return db.prepare(`
    SELECT seq, receipt_no, result, reason, entry_at, received_at, key_version, batch_id
    FROM offline_logs WHERE device_id = ? ORDER BY seq DESC LIMIT ?
  `).all(deviceId, Math.min(Number(limit) || 200, 1000)).map((r) => ({
    seq: r.seq,
    receiptNo: r.receipt_no,
    result: r.result,
    reason: r.reason || null,
    entryAt: r.entry_at,
    receivedAt: r.received_at,
    keyVersion: r.key_version,
    batchId: r.batch_id,
  }));
}

// 设备初次注册时拉取全部现存回执的 feed 基线（使“all”范围设备的基线完整）
export function backfillFeedForExistingReceipts() {
  const count = db.prepare('SELECT COUNT(*) AS c FROM offline_feed').get().c;
  if (count > 0) return;
  const rows = db.prepare('SELECT * FROM receipts ORDER BY issued_at ASC').all();
  for (const row of rows) {
    const masked = maskedFromReceiptRow(row);
    appendFeedItemTx({
      receiptNo: row.receipt_no, kind: 'issued', status: row.status,
      masked, ownerUserId: row.user_id, createdAt: row.issued_at,
    });
  }
}

export { REJECT_REASONS, VERDICT };
