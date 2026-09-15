// ---------------------------------------------------------------------------
// 电子回执离线核验：纯领域逻辑（不依赖 node:crypto，可同时被 store/测试与浏览器页面复用）
//
// 设计要点：
//  - 授权包是自描述 JSON：payload（脱敏回执 + 摘要 + 范围/有效期/宽限期/公钥）+ 服务器
//    Ed25519 签名；设备离线时仅凭包内嵌公钥即可验签，任何字节被篡改都会验签失败。
//  - 授权包内【只允许】出现核验必需的脱敏字段与摘要：脱敏姓名、脱敏手机号、事项类型、
//    完成时间、核验码摘要、逐条摘要；严禁出现证件号、完整地址、完整手机号、办理备注
//    （matter.description）或任何步骤原始数据。
//  - 离线核验日志按设备本机递增序号排列，每条摘要串联上一条摘要（prevDigest）。
// ---------------------------------------------------------------------------

export const PACKAGE_FORMAT = 'offline-receipt-authorization/v1';
export const ENTRY_VERSION = 1;

// 与 crypto.js 的 stableStringify 保持一致的规范序列化（此处复制实现以保持本文件零依赖）
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
}

export const OFFLINE_ERRORS = {
  DEVICE_NOT_FOUND: '核验设备不存在',
  DEVICE_DISABLED: '设备已停用，授权与同步均被拒绝',
  DEVICE_EXPIRED: '设备授权已过期',
  DEVICE_TOKEN_INVALID: '设备令牌无效',
  AUTHORIZATION_ROTATED: '授权已轮换，旧授权包与旧令牌不再被接受',
  IDENTITY_MISMATCH: '设备身份不匹配',
  PACKAGE_NOT_FOUND: '离线授权包不存在',
  PACKAGE_ALREADY_DOWNLOADED: '授权包只能下载一次，下载凭证已失效',
  PACKAGE_CREDENTIAL_EXPIRED: '下载凭证已过期，请重新生成授权包',
  PACKAGE_SIGNATURE_INVALID: '授权包签名校验失败：包已被篡改或不是本服务器签发',
  PACKAGE_TAMPERED: '授权包内容与签名不一致（疑似被篡改）',
  PACKAGE_DEVICE_MISMATCH: '授权包与当前设备不匹配',
  SCOPE_INVALID: '授权回执范围不合法',
  RECEIPT_NOT_IN_SCOPE: '回执不在该设备的授权核验范围内',
  INVALID_TTL: '授权有效期不合法',
  INVALID_GRACE: '撤销宽限期不合法',
  INVALID_LABEL: '设备名称不合法',
  BATCH_EMPTY: '同步批次为空',
  BATCH_TOO_LARGE: '同步批次超过单批上限',
  BATCH_DUPLICATE_CONFLICT: '相同批次号但内容不同，批次被拒绝',
  LOG_GAP: '日志序号存在缺口，整批拒绝',
  LOG_DUPLICATE_CONFLICT: '重复序号的日志内容与服务器已接收内容不同',
  LOG_FORK: '摘要链分叉：前一条摘要与服务器记录不一致',
  LOG_DIGEST_INVALID: '日志条目摘要不匹配（条目被篡改）',
  CURSOR_INVALID: '同步游标不合法',
  CURSOR_REGRESSED: '游标倒退：不能从更小的游标重新拉取',
  REVOKED_BEYOND_GRACE: '超过撤销宽限期仍未同步的核验结果，服务器不予接受',
  ENTRY_TIME_INVALID: '日志时间不合法（未来时间或时间格式错误）',
  KEY_VERSION_MISMATCH: '授权版本不匹配，请重新下载授权包',
  ALREADY_DISABLED: '设备已处于停用状态',
};

// 离线核验可能给出的结论（result/reason 会原样进入日志与审计）
export const VERDICT = {
  accepted: 'accepted',
  rejected: 'rejected',
};
export const REJECT_REASONS = {
  NOT_FOUND: 'not_found',
  CODE_MISMATCH: 'code_mismatch',
  REVOKED: 'revoked',
  OUT_OF_SCOPE: 'out_of_scope',
  SYNC_OVERDUE: 'sync_overdue',
  DEVICE_EXPIRED: 'device_expired',
};

// ---------------------------------------------------------------------------
// 脱敏：只保留核验所需字段；这里集中定义白名单，任何调用方都不能加回敏感字段
// ---------------------------------------------------------------------------
export function maskName(name) {
  const value = String(name || '').trim();
  if (!value) return '';
  if (value.length === 1) return value;
  if (value.length === 2) return `${value[0]}*`;
  return `${value[0]}${'*'.repeat(value.length - 2)}${value[value.length - 1]}`;
}
export function maskPhone(phone) {
  const value = String(phone || '').trim();
  if (value.length < 7) return value.replace(/.(?=.)/g, '*');
  return `${value.slice(0, 3)}****${value.slice(-4)}`;
}

// 由回执行 + 冻结快照构造离线脱敏记录（codeDigest 由调用方用核验码摘要传入）。
// 这里的键名就是授权包最终字段名；codeDigest 必须保持原名（不是 digest）。
export function offlineMaskedRecord({ receiptNo, status, issuedAt, completedAt, revokedAt, snapshot, codeDigest }) {
  return {
    v: 1,
    receiptNo,
    status: status === 'revoked' ? 'revoked' : 'issued',
    issuedAt,
    completedAt: completedAt || null,
    revokedAt: revokedAt || null,
    // 仅脱敏姓名/手机号与事项类型；证件号、地址、办理备注一律不进入
    applicantName: maskName(snapshot?.applicantName),
    applicantPhone: maskPhone(snapshot?.phone),
    matter: snapshot?.matter?.typeLabel || snapshot?.matter?.type || '',
    codeDigest,
  };
}

// 逐条摘要的规范输入（不含 digest 字段本身；注意不得修改原记录）
export function recordDigestInput(record) {
  return canonical(Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'digest')));
}

// ---------------------------------------------------------------------------
// 输入校验
// ---------------------------------------------------------------------------
const RECEIPT_NO_RE = /^HZ-\d{8}-[0-9A-Z]{8}$/;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{20,200}$/;

export function isValidDeviceId(id) {
  return DEVICE_ID_RE.test(String(id || ''));
}

export function parseScope(input, { allReceiptNos }) {
  const kind = String(input?.kind || '').trim();
  if (kind === 'all') {
    return { ok: true, value: { kind: 'all', receiptNos: [] } };
  }
  if (kind !== 'list') return { ok: false, code: 'SCOPE_INVALID', message: OFFLINE_ERRORS.SCOPE_INVALID };
  const raw = Array.isArray(input.receiptNos) ? input.receiptNos : [];
  const receiptNos = [...new Set(raw.map((v) => String(v || '').trim().toUpperCase()).filter(Boolean))].sort();
  if (receiptNos.length === 0 || receiptNos.length > 1000) {
    return { ok: false, code: 'SCOPE_INVALID', message: '授权回执至少 1 份、至多 1000 份' };
  }
  if (!receiptNos.every((no) => RECEIPT_NO_RE.test(no))) {
    return { ok: false, code: 'SCOPE_INVALID', message: '回执编号格式不正确' };
  }
  const known = new Set((allReceiptNos || []).map((r) => (typeof r === 'string' ? r : r.receipt_no || r.receiptNo)));
  const missing = receiptNos.filter((no) => !known.has(no));
  if (missing.length > 0) {
    return { ok: false, code: 'SCOPE_INVALID', message: `回执不存在：${missing.slice(0, 3).join('、')}${missing.length > 3 ? ' 等' : ''}` };
  }
  return { ok: true, value: { kind: 'list', receiptNos } };
}

export function parseLabel(value) {
  const label = String(value || '').trim().slice(0, 80);
  if (label.length < 2) return { ok: false, code: 'INVALID_LABEL', message: '设备名称至少 2 个字符' };
  return { ok: true, value: label };
}

export function parseTtlMs(value, { min, max, fallback }) {
  const num = Number(value);
  if (!Number.isFinite(num)) return { ok: false, value: fallback, code: 'INVALID_TTL' };
  const ms = Math.trunc(num);
  if (ms < min || ms > max) return { ok: false, value: fallback, code: 'INVALID_TTL' };
  return { ok: true, value: ms };
}

// ---------------------------------------------------------------------------
// 日志条目：规范摘要输入与链式校验（哈希由宿主环境注入：Node 用 sha256，浏览器用 subtle）
// ---------------------------------------------------------------------------
export function entryDigestInput(entry) {
  return canonical({
    v: ENTRY_VERSION,
    deviceId: entry.deviceId,
    seq: entry.seq,
    receiptNo: entry.receiptNo,
    result: entry.result,
    reason: entry.reason || '',
    at: entry.at,
    prevDigest: entry.prevDigest || '',
  });
}

// 直接对已规范的条目摘要输入计算 SHA-256（注入哈希函数）
export function digestEntry(entry, hasher) {
  return hasher(entryDigestInput(entry));
}

export function makeEntryFields({ deviceId, seq, receiptNo, result, reason = '', at, prevDigest }) {
  return {
    v: ENTRY_VERSION, deviceId, seq,
    receiptNo: String(receiptNo || ''),
    result, reason: reason || '', at,
    prevDigest: prevDigest || '',
  };
}

// 校验一批条目的内部连续性（不涉及服务器游标）；返回 { ok, code, message }
export function validateEntryChain(entries, { expectedFirstSeq, expectedPrevDigest }) {
  if (!Array.isArray(entries) || entries.length === 0) {
    return { ok: false, code: 'BATCH_EMPTY', message: OFFLINE_ERRORS.BATCH_EMPTY };
  }
  const seen = new Set();
  let prev = expectedPrevDigest || '';
  for (let i = 0; i < entries.length; i += 1) {
    const e = entries[i];
    const expectedSeq = expectedFirstSeq + i;
    if (!Number.isInteger(e.seq) || e.seq !== expectedSeq) {
      return { ok: false, code: 'LOG_GAP', message: `${OFFLINE_ERRORS.LOG_GAP}（期望序号 ${expectedSeq}，实际 ${e.seq}）` };
    }
    if (seen.has(e.seq)) {
      return { ok: false, code: 'LOG_DUPLICATE_CONFLICT', message: OFFLINE_ERRORS.LOG_DUPLICATE_CONFLICT };
    }
    seen.add(e.seq);
    if ((e.prevDigest || '') !== prev) {
      return { ok: false, code: 'LOG_FORK', message: `${OFFLINE_ERRORS.LOG_FORK}（序号 ${e.seq}）` };
    }
    prev = e.digest || '';
  }
  return { ok: true, lastDigest: prev, lastSeq: expectedFirstSeq + entries.length - 1 };
}

// 批次内容指纹：重传同一 batchId 时必须逐字节一致（幂等），否则拒绝
export function batchEntriesFingerprint(entries) {
  return canonical(entries.map((e) => ({
    seq: e.seq, receiptNo: e.receiptNo, result: e.result, reason: e.reason || '',
    at: e.at, digest: e.digest, prevDigest: e.prevDigest || '',
  })));
}

// ---------------------------------------------------------------------------
// 授权包：组装 payload（签名由 node 侧 offlineKeys 完成；浏览器只做验签）
// ---------------------------------------------------------------------------
export function buildPackagePayload({
  deviceId, deviceLabel, keyVersion, scope, issuedAt, expiresAt, graceMs,
  baselineCursor, publicKey, records,
}) {
  // 强制按回执编号排序，保证同内容同字节
  const receipts = [...records].map((r) => {
    if (!r.digest) throw new Error('离线回执记录缺少摘要');
    return {
      v: 1,
      receiptNo: r.receiptNo,
      status: r.status,
      issuedAt: r.issuedAt,
      completedAt: r.completedAt,
      revokedAt: r.revokedAt,
      applicantName: r.applicantName,
      applicantPhone: r.applicantPhone,
      matter: r.matter,
      codeDigest: r.codeDigest,
      digest: r.digest,
    };
  }).sort((a, b) => a.receiptNo.localeCompare(b.receiptNo));

  return {
    format: PACKAGE_FORMAT,
    deviceId,
    deviceLabel,
    keyVersion,
    scope: {
      kind: scope.kind,
      count: scope.kind === 'all' ? receipts.length : scope.receiptNos.length,
      receiptNos: scope.kind === 'list' ? [...scope.receiptNos].sort() : [],
    },
    issuedAt,
    expiresAt,
    graceMs,
    baselineCursor,
    publicKey,
    receipts,
  };
}

// 服务端签名前/设备验签前的规范字节（Node 与浏览器均可运行，统一 UTF-8 编码）
export function packageSigningBytes(payload) {
  return new TextEncoder().encode(canonical(payload));
}

// 最终下发文件形态（签名 base64url；输入可为 Uint8Array/Buffer/字符串）
export function packageEnvelope(payload, signature) {
  let encoded;
  if (typeof signature === 'string') encoded = signature;
  else {
    let binary = '';
    for (const byte of signature) binary += String.fromCharCode(byte);
    encoded = btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }
  return { payload, signature: encoded };
}

// base64url 字符串解码为 Uint8Array（浏览器与 Node 通用）
export function decodeBase64Url(value) {
  const b64 = String(value).replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64.padEnd(Math.ceil(b64.length / 4) * 4, '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

// 防御性检查：任何离线记录都不得携带敏感字段（单测与发包时各调用一次）
const FORBIDDEN_KEYS = ['idNumber', 'phone', 'address', 'detail', 'province', 'city', 'description', 'steps', 'note', 'snapshot'];
export function assertNoForbiddenFields(value, path = '') {
  if (value && typeof value === 'object') {
    for (const key of Object.keys(value)) {
      const next = path ? `${path}.${key}` : key;
      if (FORBIDDEN_KEYS.includes(key)) {
        throw new Error(`离线数据包含禁止字段：${next}`);
      }
      assertNoForbiddenFields(value[key], next);
    }
  }
}

// 规范化编号输入（与 receipts.formatReceiptNoInput 行为一致，但不依赖其模块）
export function normalizeReceiptNoInput(input) {
  const compact = String(input || '').replace(/[\s-]/g, '').toUpperCase();
  if (compact.length === 8) return compact;
  const m = /^HZ(\d{8})([0-9A-Z]{8})$/.exec(compact);
  if (!m) return compact;
  return `HZ-${m[1]}-${m[2]}`;
}
export { RECEIPT_NO_RE as RECEIPT_NO_PATTERN };
