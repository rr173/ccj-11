import { createHash, randomBytes } from 'node:crypto';
import { config } from './config.js';
import { maskName, maskPhone } from './receipts.js';
import { maskAddressDetail, maskIdNumber } from './corrections.js';
import { buildReviewView } from './reviews.js';

// ---------------------------------------------------------------------------
// 回执撤销与异议处理（receipt objections / revocation requests）
//
// 办理人针对自己持有的有效回执发起一次“撤销异议”：填写原因并上传一份文本说明，
// 系统冻结提交时的回执快照，生成异议编号、当前状态与处理期限。
// 异议处理人（processor 角色）只能看到被分配给自己的异议与脱敏回执内容，
// 执行受理、补充材料、驳回或确认撤销；每次状态变化都只追加事件（操作人、时间、
// 原因、前后状态），已终结异议不能重复受理或覆盖历史。
//
// 状态机：
//   submitted（待受理）──受理──▶ accepted（已受理）
//   accepted ──要求补充──▶ supplementing（待补充）
//   supplementing ──办理人补充──▶ accepted
//   accepted ──确认撤销──▶ revoked（已确认撤销，终态，原回执随之置为 revoked）
//   accepted/supplementing ──驳回──▶ rejected（已驳回，终态）
// 非法跳转一律以 OBJECTION_INVALID_TRANSITION 明确拒绝。
// ---------------------------------------------------------------------------

export const RECEIPT_OBJECTION_STATUSES = [
  'submitted', 'accepted', 'supplementing', 'rejected', 'revoked',
];
export const RECEIPT_OBJECTION_TERMINAL_STATUSES = ['rejected', 'revoked'];
// 仍在进行中（占用“同一回执至多一条进行中异议”名额）的状态
export const RECEIPT_OBJECTION_OPEN_STATUSES = ['submitted', 'accepted', 'supplementing'];

// 处理动作（处理人）与补充动作（办理人）各自允许的来源状态
export const OBJECTION_TRANSITIONS = {
  accept: { from: new Set(['submitted']), to: 'accepted' },
  requestSupplements: { from: new Set(['accepted']), to: 'supplementing' },
  supplement: { from: new Set(['supplementing']), to: 'accepted' },
  reject: { from: new Set(['accepted', 'supplementing']), to: 'rejected' },
  confirmRevocation: { from: new Set(['accepted']), to: 'revoked' },
};

export const OBJECTION_STATUS_LABELS = {
  submitted: '待受理',
  accepted: '已受理',
  supplementing: '待补充材料',
  rejected: '已驳回',
  revoked: '已确认撤销',
};

export const OBJECTION_ACTION_LABELS = {
  submitted: '发起异议',
  accept: '受理',
  requestSupplements: '要求补充材料',
  supplement: '办理人补充材料',
  reject: '驳回',
  confirmRevocation: '确认撤销',
};

// 校验：当前状态是否允许该动作；不允许时返回 false（调用方明确拒绝）
export function canTransition(status, action) {
  const rule = OBJECTION_TRANSITIONS[action];
  return Boolean(rule && rule.from.has(status));
}

export function nextStatusFor(action) {
  return OBJECTION_TRANSITIONS[action]?.to || null;
}

export function isObjectionTerminal(status) {
  return RECEIPT_OBJECTION_TERMINAL_STATUSES.includes(status);
}

// ---------------------------------------------------------------------------
// 编号与处理期限
// ---------------------------------------------------------------------------
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function crockford(buffer) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

// 唯一异议编号，格式：YY-YYYYMMDD-XXXXXXXX（8 位 Crockford，无易混字符）
export function formatObjectionNo(dateInput, randomPart) {
  const d = new Date(dateInput);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `YY-${y}${m}${day}-${randomPart}`;
}

export function newObjectionNo(createdAt = Date.now()) {
  return formatObjectionNo(createdAt, crockford(randomBytes(5)).slice(0, 8));
}

export const OBJECTION_NO_PATTERN = /^YY-\d{8}-[0-9A-Z]{8}$/;

export function normalizeObjectionNo(input) {
  return String(input || '').replace(/[\s-]/g, '').toUpperCase();
}

export function formatObjectionNoInput(input) {
  const compact = normalizeObjectionNo(input);
  if (compact.length === 8) return compact;
  const m = /^YY(\d{8})([0-9A-Z]{8})$/.exec(compact);
  if (!m) return compact;
  return `YY-${m[1]}-${m[2]}`;
}

export function objectionDeadline(createdAt = Date.now()) {
  return createdAt + config.receiptObjectionTtlMs;
}

// ---------------------------------------------------------------------------
// 文本说明：只接受纯文本（.txt），大小与行数受限；服务端逐字冻结，不做改写
// ---------------------------------------------------------------------------
export const OBJECTION_REASON_MIN = 5;
export const OBJECTION_REASON_MAX = 500;
export const OBJECTION_ATTACHMENT_NAME_MAX = 120;
export const OBJECTION_ATTACHMENT_MAX_BYTES = 64 * 1024;
export const OBJECTION_NOTE_MAX = 500;
export const OBJECTION_SUPPLEMENT_REASON_MIN = 2;
export const OBJECTION_REJECT_REASON_MIN = 5;
export const OBJECTION_REJECT_REASON_MAX = 300;

// 返回 { ok, value: { filename, contentType, content }, error }
export function parseTextAttachment(input) {
  const filename = String(input?.filename || '').trim();
  const contentType = String(input?.contentType || 'text/plain').trim().slice(0, 100);
  const contentB64 = String(input?.contentBase64 || '');
  if (!filename) return { ok: false, code: 'ATTACHMENT_REQUIRED', message: '请上传一份文本说明' };
  if (filename.length > OBJECTION_ATTACHMENT_NAME_MAX) {
    return { ok: false, code: 'ATTACHMENT_NAME_TOO_LONG', message: `文件名不能超过 ${OBJECTION_ATTACHMENT_NAME_MAX} 个字符` };
  }
  if (!/^[\w一-龥.\- ()（）]+$/u.test(filename) || filename.includes('/') || filename.includes('\\')) {
    return { ok: false, code: 'ATTACHMENT_NAME_INVALID', message: '文件名包含不支持的字符' };
  }
  if (!/\.txt$/i.test(filename)) {
    return { ok: false, code: 'ATTACHMENT_NOT_TEXT', message: '只允许上传 .txt 纯文本说明' };
  }
  if (contentType && !/^text\/plain(?:;|$)/i.test(contentType)) {
    return { ok: false, code: 'ATTACHMENT_NOT_TEXT', message: '只允许上传 text/plain 纯文本说明' };
  }
  if (!contentB64) return { ok: false, code: 'ATTACHMENT_EMPTY', message: '文本说明内容为空' };
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(contentB64)) {
    return { ok: false, code: 'ATTACHMENT_ENCODING_INVALID', message: '文本说明必须以 Base64 编码上传' };
  }
  let content;
  try {
    content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64').toString('utf8');
  } catch {
    return { ok: false, code: 'ATTACHMENT_ENCODING_INVALID', message: '文本说明 Base64 解码失败' };
  }
  const trimmed = content.trim();
  if (!trimmed) return { ok: false, code: 'ATTACHMENT_EMPTY', message: '文本说明内容为空' };
  if (Buffer.byteLength(content, 'utf8') > OBJECTION_ATTACHMENT_MAX_BYTES) {
    return { ok: false, code: 'ATTACHMENT_TOO_LARGE', message: `文本说明不能超过 ${OBJECTION_ATTACHMENT_MAX_BYTES / 1024}KB` };
  }
  // 拒绝 UTF-8 NUL 等控制字符（换行/制表符除外）
  if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(content)) {
    return { ok: false, code: 'ATTACHMENT_CONTENT_INVALID', message: '文本说明包含不允许的控制字符' };
  }
  return { ok: true, value: { filename, contentType: 'text/plain; charset=utf-8', content } };
}

export function validateObjectionReason(reason) {
  const text = String(reason || '').trim();
  if (text.length < OBJECTION_REASON_MIN || text.length > OBJECTION_REASON_MAX) {
    return { ok: false, code: 'INVALID_REASON', message: `异议原因需为 ${OBJECTION_REASON_MIN}-${OBJECTION_REASON_MAX} 个字符` };
  }
  return { ok: true, value: text };
}

export function validateRejectReason(reason) {
  const text = String(reason || '').trim();
  if (text.length < OBJECTION_REJECT_REASON_MIN || text.length > OBJECTION_REJECT_REASON_MAX) {
    return {
      ok: false,
      code: 'REJECT_REASON_REQUIRED',
      message: `驳回理由需为 ${OBJECTION_REJECT_REASON_MIN}-${OBJECTION_REJECT_REASON_MAX} 个字符`,
    };
  }
  return { ok: true, value: text };
}

export function validateSupplementNote(note, { required = false } = {}) {
  const text = String(note || '').trim();
  if (required && text.length < OBJECTION_SUPPLEMENT_REASON_MIN) {
    return {
      ok: false,
      code: 'SUPPLEMENT_NOTE_REQUIRED',
      message: `补充说明至少 ${OBJECTION_SUPPLEMENT_REASON_MIN} 个字符`,
    };
  }
  if (text.length > OBJECTION_NOTE_MAX) {
    return { ok: false, code: 'NOTE_TOO_LONG', message: `备注不能超过 ${OBJECTION_NOTE_MAX} 个字符` };
  }
  return { ok: true, value: text };
}

// ---------------------------------------------------------------------------
// 脱敏视图：处理人按权限只能看到脱敏回执内容；审计员可按权限查看完整审计记录
// ---------------------------------------------------------------------------

// 处理人视角：整份回执脱敏（复用免登录复核视图的字段级脱敏规则）
export function maskedObjectionReceipt(snapshot) {
  return buildReviewView(snapshot);
}

// 列表/时间线中给办理人或处理人的脱敏申请人摘要
export function maskedApplicant(snapshot) {
  return {
    nameMasked: maskName(snapshot.applicantName),
    phoneMasked: maskPhone(snapshot.phone),
    matter: snapshot.matter?.typeLabel || '',
    completedAt: snapshot.completedAt || null,
  };
}

// 完整（未脱敏）申请人字段：仅审计视图使用
export function fullApplicant(snapshot) {
  return {
    name: snapshot.applicantName || '',
    phone: snapshot.phone || '',
    idNumber: snapshot.idNumber || '',
    address: snapshot.address || { province: '', city: '', detail: '' },
    matter: snapshot.matter || { type: '', typeLabel: '', description: '' },
  };
}

export { maskName, maskPhone, maskIdNumber, maskAddressDetail };

// ---------------------------------------------------------------------------
// 附件内容摘要：列表与处理人视图只回传摘要，正文在详情接口按需获取
// ---------------------------------------------------------------------------
export function attachmentSummary(item) {
  if (!item) return null;
  const content = item.content || '';
  return {
    ordinal: item.ordinal,
    filename: item.filename,
    contentType: item.content_type,
    sizeBytes: Buffer.byteLength(content, 'utf8'),
    lineCount: content.split(/\r\n|\r|\n/).length,
    uploadedAt: item.created_at,
    uploadedByRole: item.uploaded_by_role,
  };
}

// 冻结快照的完整性摘要（供审计视图确认冻结内容）
export function snapshotDigest(snapshotJson) {
  return createHash('sha256').update(snapshotJson).digest('hex');
}
