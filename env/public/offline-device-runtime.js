// ---------------------------------------------------------------------------
// 离线核验设备本机逻辑（浏览器与 Node 测试共用，零外部依赖，全部使用 Web Crypto）：
//   - 载入授权包：验服务器 Ed25519 签名（包内嵌公钥）；验签失败一律拒绝。
//   - 离线核验：过期 / 停用 / 超期未同步（撤销宽限，自上次成功同步起算）/ 范围外 / 核验码不符 / 已撤销全部拒绝。
//   - 日志：按本机递增序号记录，每条摘要串联上一条摘要（prevDigest）。
//   - 同步后增量应用：新增/状态变化回执写入本地视图，撤销立即生效；游标单调推进。
//
// 说明：这里实现的是“真实离线设备”应有的全部本地判定，服务器同步时会独立复核，
// 二者任一侧拒绝都算拒绝。
// ---------------------------------------------------------------------------
import {
  canonical,
  decodeBase64Url,
  entryDigestInput,
  makeEntryFields,
  OFFLINE_ERRORS,
  packageSigningBytes,
  REJECT_REASONS,
  VERDICT,
} from './offline-core.js';

const encoder = new TextEncoder();

// 所有摘要统一为 SHA-256 的 hex 小写（与服务器 store 的摘要编码一致）
export async function sha256Hex(input) {
  const data = typeof input === 'string' ? encoder.encode(input) : new Uint8Array(input);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
export const sha256B64 = sha256Hex;

// 核验码摘要：与服务端派生方式一致（域分隔串 + 编号 + 规范化码）
export async function deriveCodeDigest(receiptNo, rawCode) {
  const code = String(rawCode || '').replace(/[\s-]/g, '').toUpperCase();
  return sha256Hex(`offline-code:${receiptNo}:${code}`);
}

export class DeviceError extends Error {
  constructor(code, message = OFFLINE_ERRORS[code] || code) {
    super(message);
    this.name = 'DeviceError';
    this.code = code;
  }
}

// 设备本机状态（可 JSON 序列化，刷新/重登后从持久化恢复）
export function createDeviceState({ deviceId, token, now = () => Date.now() }) {
  return {
    deviceId,
    token,
    now,
    packageVerified: false,
    envelope: null,
    records: new Map(),          // receiptNo -> 脱敏记录（含撤销状态）
    scope: null,
    keyVersion: 0,
    graceMs: 0,
    expiresAt: 0,
    disabled: false,
    cursor: 0,                  // 最后成功同步游标（也是发包时的 baselineCursor）
    lastSuccessfulSyncAt: 0,
    nextSeq: 1,
    lastDigest: '',             // 日志链头
    logs: [],                   // 全部日志（已上传的保留以延续摘要链）
    pending: [],                // 待上传日志
    syncDeadlineAt: 0,          // 服务器同步响应给出的“必须在此前再次同步”时刻（0=无）；本机生效期限见 effectiveSyncDeadline
  };
}

export function pendingEntries(state, { maxLogs = 500 } = {}) {
  return state.logs.filter((e) => !e.uploaded).slice(0, maxLogs);
}

export function serializeState(state) {
  return JSON.stringify({
    deviceId: state.deviceId, token: state.token,
    packageVerified: state.packageVerified, envelope: state.envelope,
    records: [...state.records.entries()],
    scope: state.scope, keyVersion: state.keyVersion, graceMs: state.graceMs,
    expiresAt: state.expiresAt, disabled: state.disabled, cursor: state.cursor,
    lastSuccessfulSyncAt: state.lastSuccessfulSyncAt, nextSeq: state.nextSeq,
    lastDigest: state.lastDigest, logs: state.logs, syncDeadlineAt: state.syncDeadlineAt,
  });
}
export function restoreState(json, { now = () => Date.now() } = {}) {
  const data = typeof json === 'string' ? JSON.parse(json) : json;
  const state = createDeviceState({ deviceId: data.deviceId, token: data.token, now });
  state.packageVerified = data.packageVerified;
  state.envelope = data.envelope;
  state.records = new Map(data.records || []);
  state.scope = data.scope;
  state.keyVersion = data.keyVersion;
  state.graceMs = data.graceMs;
  state.expiresAt = data.expiresAt;
  state.disabled = data.disabled;
  state.cursor = data.cursor;
  state.lastSuccessfulSyncAt = data.lastSuccessfulSyncAt;
  state.nextSeq = data.nextSeq;
  state.lastDigest = data.lastDigest;
  state.logs = data.logs || [];
  state.syncDeadlineAt = data.syncDeadlineAt || 0;
  return state;
}

// 本机生效的“必须再次同步”截止时刻：取服务器下发的撤销同步期限（syncDeadlineAt）
// 与“上次成功同步 + 撤销宽限期”的较早者（0 = 尚未载入授权包，无有效期限）。
// 撤销可能发生在上次同步后的任意时刻，离线设备无法察觉，因此宽限期一律自上次成功
// 同步（或授权包签发）起算：超过该时刻仍未同步，设备必须本机立即拒绝核验，不能等
// 日志上传服务器后才发现结果失效。
export function effectiveSyncDeadline(state) {
  const local = state.lastSuccessfulSyncAt ? state.lastSuccessfulSyncAt + state.graceMs : 0;
  if (state.syncDeadlineAt && (!local || state.syncDeadlineAt < local)) return state.syncDeadlineAt;
  return local;
}

// 载入授权包：验签 + 绑定设备 + 初始化本地视图与基线游标
export async function loadPackage(state, envelope, { expectedDeviceId = state.deviceId } = {}) {
  if (!envelope || !envelope.payload || !envelope.signature) {
    throw new DeviceError('PACKAGE_SIGNATURE_INVALID');
  }
  const { payload, signature } = envelope;
  if (payload.deviceId !== expectedDeviceId) throw new DeviceError('PACKAGE_DEVICE_MISMATCH');
  let publicKey;
  try {
    publicKey = await crypto.subtle.importKey(
      'spki',
      decodeBase64Url(payload.publicKey),
      { name: 'Ed25519' },
      false,
      ['verify'],
    );
  } catch {
    throw new DeviceError('PACKAGE_SIGNATURE_INVALID');
  }
  // 关键：对“签名时的规范字节”验签，任何字段被篡改都会失败
  const valid = await crypto.subtle.verify(
    'Ed25519',
    publicKey,
    decodeBase64Url(signature),
    packageSigningBytes(payload),
  );
  if (!valid) throw new DeviceError('PACKAGE_TAMPERED');

  state.envelope = envelope;
  state.packageVerified = true;
  state.scope = payload.scope;
  state.keyVersion = payload.keyVersion;
  state.graceMs = payload.graceMs;
  state.expiresAt = payload.expiresAt;
  state.records = new Map((payload.receipts || []).map((r) => [r.receiptNo, r]));
  state.cursor = payload.baselineCursor;
  state.lastSuccessfulSyncAt = payload.issuedAt;
  state.syncDeadlineAt = 0;
  // 设备换发授权包后日志链从头开始（旧授权的链在服务器侧已随轮换终结）
  state.nextSeq = 1;
  state.lastDigest = '';
  state.logs = [];
  return { receiptCount: state.records.size, baselineCursor: state.cursor };
}

function inScope(state, receiptNo) {
  if (!state.scope) return false;
  if (state.scope.kind === 'all') return state.records.has(receiptNo);
  return state.scope.receiptNos.includes(receiptNo);
}

// 离线核验：返回 { verdict, receipt? }；拒绝时 verdict='rejected' 并记录 reason 入摘要链，
// 抛 DeviceError 仅用于“设备自身不可用”（未载入有效授权包/过期/停用）。
export async function offlineVerify(state, { receiptNo, code, at = state.now() }) {
  if (!state.packageVerified) throw new DeviceError('PACKAGE_SIGNATURE_INVALID', '尚未载入有效的离线授权包');
  if (state.disabled) throw new DeviceError('DEVICE_DISABLED');
  if (at >= state.expiresAt) throw new DeviceError('DEVICE_EXPIRED');

  const normalized = String(receiptNo || '').replace(/[\s-]/g, '').toUpperCase();
  const no = /^\d{8}[0-9A-Z]{8}$/.test(normalized)
    ? `HZ-${normalized.slice(0, 8)}-${normalized.slice(8)}`
    : receiptNo;

  // 撤销宽限：超过本机“必须再次同步”的截止时刻仍未联网，立即明确拒绝并留痕入链——
  // 离线期间可能已发生撤销而本机无法察觉，不能等日志上传后才由服务器判定结果失效。
  const syncDeadline = effectiveSyncDeadline(state);
  if (syncDeadline && at >= syncDeadline) {
    const entry = await appendLog(state, {
      receiptNo: no, result: VERDICT.rejected, reason: REJECT_REASONS.SYNC_OVERDUE, at,
    });
    return { verdict: VERDICT.rejected, reason: REJECT_REASONS.SYNC_OVERDUE, receipt: null, entry };
  }

  const record = state.records.get(no);
  let verdict = VERDICT.rejected;
  let reason = '';
  let receiptView = null;

  if (!inScope(state, no)) {
    reason = REJECT_REASONS.OUT_OF_SCOPE;
  } else if (!record) {
    reason = REJECT_REASONS.NOT_FOUND;
  } else if (record.status === 'revoked' || record.revokedAt) {
    reason = REJECT_REASONS.REVOKED;
  } else {
    const given = await deriveCodeDigest(no, code);
    if (given !== record.codeDigest) {
      reason = REJECT_REASONS.CODE_MISMATCH;
    } else {
      verdict = VERDICT.accepted;
      receiptView = {
        receiptNo: record.receiptNo,
        applicantName: record.applicantName,
        applicantPhone: record.applicantPhone,
        matter: record.matter,
        completedAt: record.completedAt,
        status: record.status,
      };
    }
  }

  const entry = await appendLog(state, { receiptNo: no, result: verdict, reason, at });
  return { verdict, reason: reason || null, receipt: receiptView, entry };
}

// 追加一条日志（内部：摘要串联前一条）
export async function appendLog(state, { receiptNo, result, reason = '', at = state.now() }) {
  const fields = makeEntryFields({
    deviceId: state.deviceId,
    seq: state.nextSeq,
    receiptNo, result, reason, at,
    prevDigest: state.lastDigest,
  });
  const digest = await sha256B64(canonical(entryDigestInput(fields)));
  const entry = { ...fields, digest };
  state.logs.push(entry);
  state.lastDigest = digest;
  state.nextSeq += 1;
  return entry;
}

// 取下一批待上传日志（带游标快照）
export function nextUploadBatch(state, { maxLogs = 500 } = {}) {
  return {
    batchId: '', // 由调用方在真正发送时生成（见 buildUploadBatch）
    entries: state.logs.slice(0, maxLogs),
  };
}

// 构造幂等上传批次：batchId 在“首次发送”时生成；重试必须复用同一 batchId
export function buildUploadBatch(state, { firstSeq, entries, batchId }) {
  return {
    deviceId: state.deviceId,
    keyVersion: state.keyVersion,
    batchId,
    cursor: state.cursor,
    firstSeq,
    entries: entries.map((e) => ({ ...e })),
  };
}

// 应用服务器同步响应：校验设备/授权版本，写入增量，推进游标，清理已确认日志
export function applySyncResponse(state, response, { sentEntries = [], now = state.now() } = {}) {
  if (!response || response.deviceId !== state.deviceId) throw new DeviceError('IDENTITY_MISMATCH');
  if (response.keyVersion !== state.keyVersion) throw new DeviceError('KEY_VERSION_MISMATCH');
  if (response.cursor < state.cursor) throw new DeviceError('CURSOR_REGRESSED');

  for (const item of response.delta || []) {
    if (!item.scoped) continue; // 不在授权范围的增量不进入本地视图
    state.records.set(item.receiptNo, {
      v: 1,
      receiptNo: item.receiptNo,
      status: item.status,
      issuedAt: item.issuedAt,
      completedAt: item.completedAt,
      revokedAt: item.revokedAt,
      applicantName: item.applicantName,
      applicantPhone: item.applicantPhone,
      matter: item.matter,
      codeDigest: item.codeDigest,
      digest: item.digest,
    });
  }

  // 已被服务器确认接收的日志标记为已上传（保留在本机用于摘要链延续与审计），
  // 待传队列单独维护。注意不能删除：后续日志的 prevDigest 仍串联它们。
  if (response.acceptedCount > 0 && sentEntries.length > 0) {
    const acceptedSeqs = new Set(sentEntries.slice(0, response.acceptedCount).map((e) => e.seq));
    for (const e of state.logs) {
      if (acceptedSeqs.has(e.seq)) e.uploaded = true;
    }
  }
  state.pending = state.logs.filter((e) => !e.uploaded);
  state.cursor = response.cursor;
  state.lastSuccessfulSyncAt = response.serverAt || now();
  state.syncDeadlineAt = response.mustSyncBefore || 0;
  return state;
}
