import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { config } from './config.js';
import { STEPS } from './workflow.js';

// ---------------------------------------------------------------------------
// 密钥：核验码通过 HMAC 由 (secret, receiptNo) 确定性派生，数据库不保存核验码。
// 密钥丢失则已签发回执的核验码无法再核验，因此必须随数据卷持久化。
// ---------------------------------------------------------------------------
let cachedSecret = null;

function loadSecret() {
  if (cachedSecret) return cachedSecret;
  if (config.receiptSecret) {
    cachedSecret = Buffer.from(config.receiptSecret, 'utf8');
    return cachedSecret;
  }
  const file = config.receiptSecretPath;
  if (existsSync(file)) {
    cachedSecret = readFileSync(file);
    return cachedSecret;
  }
  const generated = randomBytes(32);
  try {
    writeFileSync(file, generated, { mode: 0o600 });
    chmodSync(file, 0o600);
  } catch (error) {
    // 只读环境应通过 RECEIPT_SECRET 或挂载密钥文件提供密钥
    throw new Error(`无法写入回执密钥文件 ${file}：${error.message}。请通过 RECEIPT_SECRET 提供密钥。`);
  }
  cachedSecret = generated;
  return cachedSecret;
}

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

// 唯一回执编号，格式：HZ-YYYYMMDD-XXXXXXXX（8 位 Crockford，无易混字符）
export function formatReceiptNo(dateInput, randomPart) {
  const d = new Date(dateInput);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `HZ-${y}${m}${day}-${randomPart}`;
}

export function newReceiptNo(issuedAt = Date.now()) {
  return formatReceiptNo(issuedAt, crockford(randomBytes(5)).slice(0, 8));
}

// 8 位核验码（展示为 XXXX-XXXX），由密钥对回执编号做 HMAC 派生
export function deriveCode(receiptNo) {
  const digest = createHmac('sha256', loadSecret()).update(`verify-code:${receiptNo}`).digest();
  const code = crockford(digest).slice(0, 8);
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function codeMatches(receiptNo, input) {
  const expected = Buffer.from(normalizeCode(deriveCode(receiptNo)));
  const actual = Buffer.from(normalizeCode(input));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// 编号与核验码输入规整：不区分大小写、去空格与连字符，统一大写
export function normalizeReceiptNo(input) {
  return String(input || '').replace(/[\s-]/g, '').toUpperCase();
}
export function formatReceiptNoInput(input) {
  const compact = normalizeReceiptNo(input);
  if (compact.length === 8) return compact;
  const m = /^HZ(\d{8})([0-9A-Z]{8})$/.exec(compact);
  if (!m) return compact;
  return `HZ-${m[1]}-${m[2]}`;
}
export function normalizeCode(input) {
  return String(input || '').replace(/[\s-]/g, '').toUpperCase();
}
export const RECEIPT_NO_PATTERN = /^HZ-\d{8}-[0-9A-Z]{8}$/;
export const CODE_PATTERN = /^[0-9A-HJ-NP-TV-Z]{8}$/;

// ---------------------------------------------------------------------------
// 脱敏
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

export const MATTER_LABELS = { new: '新办', renew: '续办', change: '变更' };

// ---------------------------------------------------------------------------
// 快照：回执内容在签发时冻结（含各步已确认信息、确认时间、最终完成时间）
// ---------------------------------------------------------------------------
export function buildSnapshot({ workflow, steps, sequence }) {
  const payloads = steps.map((row) => (row.confirmed_json ? JSON.parse(row.confirmed_json) : null));
  const stepRecords = steps.map((row, index) => {
    const definition = STEPS[index] || { title: `第 ${index + 1} 步`, key: '' };
    return {
      step: index,
      key: definition.key,
      title: definition.title,
      confirmedAt: row.confirmed_at || null,
      data: payloads[index],
    };
  });
  const applicant = payloads[0] || {};
  const address = payloads[1] || {};
  const matter = payloads[2] || {};
  return {
    schemaVersion: 1,
    sequence,
    workflowId: workflow.id,
    applicantName: applicant.name || '',
    phone: applicant.phone || '',
    idNumber: applicant.idNumber || '',
    address: {
      province: address.province || '',
      city: address.city || '',
      detail: address.detail || '',
    },
    matter: {
      type: matter.type || '',
      typeLabel: MATTER_LABELS[matter.type] || matter.type || '',
      description: matter.description || '',
    },
    steps: stepRecords,
    completedAt: workflow.completed_at || null,
  };
}

// 回执本人（登录后）完整视图
export function ownerReceipt(row, snapshot) {
  return {
    receiptNo: row.receipt_no,
    status: row.status,
    issuedAt: row.issued_at,
    completedAt: snapshot.completedAt,
    revokedAt: row.revoked_at || null,
    revokeReason: row.revoke_reason || '',
    sequence: snapshot.sequence,
    code: deriveCode(row.receipt_no),
    snapshot,
  };
}

// 列表项（不含完整快照）
export function receiptSummary(row) {
  return {
    receiptNo: row.receipt_no,
    status: row.status,
    issuedAt: row.issued_at,
    completedAt: row.completed_at,
    revokedAt: row.revoked_at || null,
    sequence: row.sequence,
    workflowId: row.workflow_id,
  };
}

// 免登录核验结果：只给脱敏姓名、手机号、事项、完成时间
export function publicReceipt(row, snapshot) {
  return {
    receiptNo: row.receipt_no,
    status: row.status,
    issuedAt: row.issued_at,
    completedAt: snapshot.completedAt,
    revokedAt: row.revoked_at || null,
    revokeReason: row.revoke_reason || '',
    applicant: {
      nameMasked: maskName(snapshot.applicantName),
      phoneMasked: maskPhone(snapshot.phone),
      matter: snapshot.matter.typeLabel,
      completedAt: snapshot.completedAt,
    },
  };
}

// ---------------------------------------------------------------------------
// 时间展示
// ---------------------------------------------------------------------------
export function formatTime(epochMs, timezone = config.displayTimezone) {
  if (!epochMs) return '—';
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).format(new Date(epochMs));
}

// ---------------------------------------------------------------------------
// 可打印回执文档（自包含 HTML，适合浏览器直接打印/另存 PDF）
// ---------------------------------------------------------------------------
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function stepDataRows(stepRecord) {
  const data = stepRecord.data || {};
  const labels = {
    name: '姓名', idNumber: '证件号码', phone: '手机号',
    province: '省份', city: '城市', detail: '详细地址',
    type: '事项类型', description: '事项说明',
    agreed: '确认声明', contactTime: '方便联系的时间',
  };
  const valueLabels = {
    new: '新办', renew: '续办', change: '变更',
  };
  return Object.entries(data).map(([key, value]) => {
    const display = value === true ? '已勾选确认'
      : value === false ? '未勾选'
        : key === 'type' ? (valueLabels[value] || value)
          : (String(value) || '—');
    return `<tr><th>${escapeHtml(labels[key] || key)}</th><td>${escapeHtml(display)}</td></tr>`;
  }).join('');
}

export function renderReceiptDocument(receipt, { publicView = false, baseUrl = '' } = {}) {
  const { snapshot } = receipt;
  const revoked = receipt.status === 'revoked';
  const stamp = revoked
    ? '<div class="stamp revoked">已撤销<br><small>本回执已失效，不作为办理完成凭证</small></div>'
    : '<div class="stamp completed">已完成</div>';

  const stepsHtml = snapshot.steps.map((stepRecord, index) => `
    <section class="step-block">
      <h3>步骤 ${index + 1}：${escapeHtml(stepRecord.title)}</h3>
      <p class="confirmed-at">确认时间：${escapeHtml(formatTime(stepRecord.confirmedAt))}</p>
      <table class="kv">${publicView ? publicStepRows(stepRecord) : stepDataRows(stepRecord)}</table>
    </section>
  `).join('');

  const revokeNotice = revoked ? `
    <section class="revoke-notice">
      <strong>本回执已于 ${escapeHtml(formatTime(receipt.revokedAt))} 被撤销。</strong>
      ${receipt.revokeReason ? `撤销原因：${escapeHtml(receipt.revokeReason)}` : ''}
      撤销后本回执不再作为办理完成的有效凭证；如对信息有更正，将以更正后重新办理产生的新回执为准。
    </section>` : '';

  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>电子回执 ${escapeHtml(receipt.receiptNo)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: "PingFang SC", "Microsoft YaHei", "Noto Sans CJK SC", sans-serif; color: #172033; margin: 0; background: #f0f2f6; }
  .page { max-width: 820px; margin: 0 auto; background: #fff; padding: 48px 56px; }
  .doc-head { text-align: center; border-bottom: 3px double #1d8a53; padding-bottom: 18px; margin-bottom: 24px; position: relative; }
  .doc-head h1 { margin: 0 0 6px; font-size: 26px; letter-spacing: 6px; }
  .doc-head p { margin: 0; color: #647084; font-size: 13px; }
  .status-line { display: flex; justify-content: center; align-items: center; gap: 12px; margin: 18px 0 6px; }
  .status-pill { border-radius: 999px; padding: 6px 18px; font-weight: 700; font-size: 16px; }
  .status-pill.completed { background: #d1fadf; color: #05603a; border: 1px solid #1d8a53; }
  .status-pill.revoked { background: #fee4e2; color: #b42318; border: 1px solid #b42318; }
  .meta-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 8px 28px; margin: 20px 0; }
  .meta-grid div { border-bottom: 1px dotted #cbd2de; padding-bottom: 6px; font-size: 14px; }
  .meta-grid b { font-weight: 600; }
  .receipt-no { font-family: ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace; font-size: 15px; letter-spacing: 1px; }
  h2 { font-size: 16px; margin: 28px 0 12px; border-left: 4px solid #2458d6; padding-left: 10px; }
  h3 { font-size: 14px; margin: 16px 0 6px; }
  .confirmed-at { margin: 0 0 6px; color: #647084; font-size: 13px; }
  table.kv { width: 100%; border-collapse: collapse; font-size: 13px; }
  table.kv th, table.kv td { border: 1px solid #d8dee9; padding: 7px 10px; text-align: left; vertical-align: top; }
  table.kv th { width: 130px; background: #f5f7fb; font-weight: 600; white-space: nowrap; }
  .revoke-notice { margin: 20px 0; padding: 14px 16px; background: #fef3f2; border: 1px solid #fecdca; color: #912018; border-radius: 10px; font-size: 13px; }
  .verify-note { margin-top: 28px; padding: 14px 16px; background: #f8fafc; border: 1px solid #e4e7ec; border-radius: 10px; font-size: 13px; color: #475467; }
  .stamp { position: absolute; right: 4px; top: 0; border: 3px solid #1d8a53; color: #1d8a53; border-radius: 12px; padding: 10px 18px; font-size: 24px; font-weight: 800; transform: rotate(-10deg); text-align: center; opacity: .92; }
  .stamp small { display: block; font-size: 11px; font-weight: 600; }
  .stamp.revoked { border-color: #b42318; color: #b42318; }
  .doc-foot { margin-top: 36px; text-align: center; color: #98a2b3; font-size: 12px; }
  .toolbar { text-align: center; margin: 18px 0 0; }
  .toolbar button { border: 0; background: #2458d6; color: #fff; border-radius: 8px; padding: 10px 22px; font-size: 15px; cursor: pointer; }
  @media print {
    body { background: #fff; }
    .page { max-width: none; padding: 12mm; }
    .toolbar { display: none; }
  }
</style>
</head>
<body>
  <main class="page">
    <header class="doc-head">
      <h1>电子办理回执</h1>
      <p>${revoked ? '本回执已撤销，仅作留档查询' : '本回执为办理完成的电子凭证，内容自签发之日起固定保存'}</p>
      ${stamp}
    </header>

    <div class="status-line">
      <span class="status-pill ${revoked ? 'revoked' : 'completed'}">${revoked ? '已撤销（失效）' : '办理状态：已完成'}</span>
    </div>

    <div class="meta-grid">
      <div><b>回执编号：</b><span class="receipt-no">${escapeHtml(receipt.receiptNo)}</span></div>
      <div><b>最终完成时间：</b>${escapeHtml(formatTime(snapshot.completedAt))}</div>
      <div><b>回执签发时间：</b>${escapeHtml(formatTime(receipt.issuedAt))}</div>
      <div><b>办理记录：</b>第 ${snapshot.sequence} 次办理</div>
    </div>

    ${revokeNotice}

    <h2>各步确认信息</h2>
    ${stepsHtml}

    <section class="verify-note">
      可通过官方核验页面（${escapeHtml(baseUrl || '/verify')}）输入回执编号与核验码核验本回执。
      公开核验仅展示脱敏后的姓名、手机号、办理事项和完成时间，不展示证件号码与完整地址。
      ${publicView ? '本文件由免登录核验通道生成，仅含脱敏信息。' : '本文件由办理本人登录后获取，包含完整申报内容。'}
    </section>

    <div class="toolbar">
      <button type="button" onclick="window.print()">打印 / 另存为 PDF</button>
    </div>

    <footer class="doc-foot">
      本电子回执由系统在四步全部确认成功时自动生成，内容固定、不可修改；后续更正将产生新的办理记录与新回执。
    </footer>
  </main>
</body>
</html>`;
}

function publicStepRows(stepRecord) {
  // 公开核验文档只展示脱敏的姓名、手机号、办理事项、完成时间
  const rows = [];
  if (stepRecord.step === 0) {
    const data = stepRecord.data || {};
    rows.push(['姓名（脱敏）', maskName(data.name)], ['手机号（脱敏）', maskPhone(data.phone)]);
  }
  if (stepRecord.step === 2) {
    const data = stepRecord.data || {};
    rows.push(['办理事项', data.type ? (MATTER_LABELS[data.type] || data.type) : '—']);
  }
  if (rows.length === 0) {
    return '<tr><th>公开信息</th><td>本步骤信息不对外展示（为保护隐私，证件号码、地址等已隐藏）。</td></tr>';
  }
  return rows.map(([k, v]) => `<tr><th>${escapeHtml(k)}</th><td>${escapeHtml(v)}</td></tr>`).join('');
}
