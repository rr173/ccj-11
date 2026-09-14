const $ = (selector) => document.querySelector(selector);

let csrfToken = readCookie('csrf');
let currentDetailNo = null;

function readCookie(name) {
  return document.cookie.split('; ').reduce((value, part) => part.startsWith(`${name}=`) ? decodeURIComponent(part.slice(name.length + 1)) : value, '');
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
function formatTime(epochMs) {
  if (!epochMs) return '—';
  return new Date(epochMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}
function formatRemaining(deadlineMs) {
  const ms = deadlineMs - Date.now();
  if (ms <= 0) return '已逾处理期限';
  const days = Math.floor(ms / 86400000);
  const hours = Math.floor((ms % 86400000) / 3600000);
  return days > 0 ? `剩余 ${days} 天 ${hours} 小时` : `剩余 ${hours} 小时`;
}

const STATUS_LABELS = {
  submitted: '待受理', accepted: '已受理', supplementing: '待补充材料',
  rejected: '已驳回', revoked: '已确认撤销',
};
const STATUS_CLASS = {
  submitted: 'current', accepted: 'confirmed', supplementing: 'warn',
  rejected: 'invalidated', revoked: 'invalidated',
};
const EVENT_TEXT = {
  'receipt.objection.submitted': '发起异议',
  'receipt.objection.accepted': '受理',
  'receipt.objection.supplement-requested': '要求补充材料',
  'receipt.objection.supplemented': '办理人补充材料',
  'receipt.objection.rejected': '驳回',
  'receipt.objection.revocation-confirmed': '确认撤销',
};

async function api(method, url, body) {
  const headers = { Accept: 'application/json' };
  const options = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  if (csrfToken) headers['X-CSRF-Token'] = csrfToken;
  const response = await fetch(url, options);
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error?.message || `请求失败（${response.status}）`);
    error.status = response.status;
    error.code = data?.error?.code;
    error.data = data;
    throw error;
  }
  return data;
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const result = await api('POST', '/api/login', data);
    csrfToken = result.csrfToken;
    if (result.user.role !== 'processor') {
      $('#loginError').textContent = '该账号不是异议处理人角色，请使用 processor 角色账号登录本页面';
      $('#loginError').classList.remove('hidden');
      return;
    }
    boot(result.user);
  } catch (error) {
    $('#loginError').textContent = error.message;
    $('#loginError').classList.remove('hidden');
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/logout', {}); } finally { location.reload(); }
});
$('#refreshBtn').addEventListener('click', loadList);
$('#statusFilter').addEventListener('change', loadList);

async function boot(knownUser = null) {
  try {
    const state = await api('GET', '/api/state');
    if (state.user.role !== 'processor') {
      $('#loginView').classList.remove('hidden');
      $('#appView').classList.add('hidden');
      return;
    }
    $('#userName').textContent = state.user.displayName;
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
    await loadList();
  } catch {
    $('#loginView').classList.remove('hidden');
    $('#appView').classList.add('hidden');
  }
}

async function loadList() {
  const status = $('#statusFilter').value;
  const result = await api('GET', `/api/processor/objections${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  const list = $('#objectionList');
  if (!result.objections.length) {
    list.innerHTML = '<p class="muted">当前没有符合条件、且分配给你的异议。</p>';
    return;
  }
  list.innerHTML = result.objections.map((o) => `
    <div class="archive-item card-inner">
      <div class="record-main">
        <b class="mono">${escapeHtml(o.objectionNo)}</b>
        <span class="badge ${STATUS_CLASS[o.status] || 'current'}">${STATUS_LABELS[o.status] || o.status}</span>
      </div>
      <div class="muted small">
        来源回执 <span class="mono">${escapeHtml(o.receiptNo)}</span>
        · 申请人（脱敏）${escapeHtml(o.applicant.nameMasked)} / ${escapeHtml(o.applicant.phoneMasked)}
        · 事项：${escapeHtml(o.applicant.matter)}
      </div>
      <div class="muted small">
        发起于 ${formatTime(o.createdAt)} · 处理期限至 ${formatTime(o.deadlineAt)}
        （${escapeHtml(formatRemaining(o.deadlineAt))}）
      </div>
      <div class="small">${escapeHtml(o.reason)}</div>
      <div class="record-actions">
        <button class="button secondary" type="button" data-detail="${escapeHtml(o.objectionNo)}">处理 / 查看脱敏内容与历史</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-detail]').forEach((btn) => {
    btn.addEventListener('click', () => loadDetail(btn.dataset.detail));
  });
}

function maskedStepsHtml(o) {
  return (o.maskedReceipt?.steps || []).map((step) => `
    <div class="confirmation">
      <strong>${step.step + 1}. ${escapeHtml(step.title)}</strong>
      <table class="kv">
        ${step.fields.map((f) => `<tr><th>${escapeHtml(f.label)}</th><td>${escapeHtml(f.value)}${f.masked ? ' <span class="muted small">（已脱敏）</span>' : ''}</td></tr>`).join('')}
      </table>
    </div>`).join('');
}

function materialsHtml(o) {
  return (o.materials || []).map((m) => `
    <details class="material-box">
      <summary>${escapeHtml(m.filename)} · ${m.sizeBytes} 字节 · ${m.uploadedByRole === 'handler' ? '办理人' : '处理人'} 上传于 ${formatTime(m.uploadedAt)}${m.note ? ` · ${escapeHtml(m.note)}` : ''}</summary>
      <pre class="archive-pre">${escapeHtml(m.content || '')}</pre>
    </details>`).join('');
}

function eventsHtml(o) {
  return (o.events || []).map((e) => `
    <li class="muted small">
      #${e.ordinal} · ${formatTime(e.at)} · ${escapeHtml(EVENT_TEXT[e.type] || e.type)}
      （${e.actorRole === 'handler' ? '办理人' : e.actorRole === 'processor' ? '处理人' : escapeHtml(e.actorRole)}${e.actorName ? `：${escapeHtml(e.actorName)}` : ''}）
      ${e.fromStatus ? ` · ${escapeHtml(STATUS_LABELS[e.fromStatus] || e.fromStatus)} → ${escapeHtml(STATUS_LABELS[e.toStatus] || e.toStatus)}` : ''}
      ${e.reason ? ` · ${escapeHtml(e.reason)}` : ''}${e.note ? ` · ${escapeHtml(e.note)}` : ''}
    </li>`).join('');
}

async function loadDetail(objectionNo) {
  currentDetailNo = objectionNo;
  const view = $('#detailView');
  view.classList.remove('hidden');
  view.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  view.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const { objection: o } = await api('GET', `/api/processor/objections/${encodeURIComponent(objectionNo)}`);
    const terminal = o.status === 'rejected' || o.status === 'revoked';
    view.innerHTML = `
      <div class="receipt-head">
        <h2>撤销异议 <span class="mono">${escapeHtml(o.objectionNo)}</span>
          <span class="badge ${STATUS_CLASS[o.status]}">${STATUS_LABELS[o.status]}</span></h2>
      </div>
      <div class="receipt-meta">
        <div><span class="muted">来源回执</span><b class="mono">${escapeHtml(o.receiptNo)}</b></div>
        <div><span class="muted">原回执当前状态</span><b>${o.currentReceiptStatus === 'revoked' ? '已撤销' : '有效'}</b></div>
        <div><span class="muted">发起人</span><b>${escapeHtml(o.owner?.displayName || '—')}</b></div>
        <div><span class="muted">发起时间</span><b>${formatTime(o.createdAt)}</b></div>
        <div><span class="muted">处理期限</span><b>${formatTime(o.deadlineAt)}（${escapeHtml(formatRemaining(o.deadlineAt))}）</b></div>
        <div><span class="muted">冻结快照摘要</span><b class="mono small">${escapeHtml(o.snapshotDigest.slice(0, 16))}…</b></div>
      </div>
      <div class="small"><b>异议原因：</b>${escapeHtml(o.reason)}</div>

      <h3>脱敏回执内容（仅授权可见的脱敏字段）</h3>
      ${maskedStepsHtml(o)}

      <h3>文本说明与补充材料（原文）</h3>
      ${materialsHtml(o) || '<p class="muted small">无</p>'}

      <h3>处理历史（只追加，不可覆盖）</h3>
      <ul class="batch-history-list">${eventsHtml(o)}</ul>

      <div class="receipt-actions" data-actions>
        ${o.status === 'submitted' ? '<button class="button primary" data-act="accept">受理</button>' : ''}
        ${o.status === 'accepted' ? '<button class="button secondary" data-act="request-supplements">要求补充材料</button>' : ''}
        ${o.status === 'accepted' || o.status === 'supplementing' ? '<button class="button secondary" data-act="reject">驳回（需理由）</button>' : ''}
        ${o.status === 'accepted' ? '<button class="button danger" data-act="confirm-revocation">确认撤销回执</button>' : ''}
        ${terminal ? '<p class="muted small">该异议已处理完结，不能重复受理或覆盖历史。</p>' : ''}
        ${o.status === 'supplementing' ? '<p class="muted small">当前等待办理人补充材料，材料提交后异议将回到“已受理”。</p>' : ''}
      </div>
      ${o.status === 'revoked' ? '<div class="alert error">原回执已撤销：免登录核验将返回“已撤销”；原始冻结快照仍可供授权审计查看。</div>' : ''}
    `;
    view.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => runAction(o, btn.dataset.act));
    });
  } catch (error) {
    view.innerHTML = `<div class="alert error">${escapeHtml(error.message)}</div>`;
  }
}

async function runAction(o, action) {
  let body = {};
  if (action === 'reject') {
    const reason = window.prompt('请填写驳回理由（5-300 字）：', '');
    if (reason === null) return;
    if (reason.trim().length < 5) { window.alert('驳回理由至少 5 个字符'); return; }
    body = { reason: reason.trim() };
  } else if (action === 'request-supplements') {
    const note = window.prompt('请填写需要办理人补充的材料说明：', '');
    if (note === null) return;
    if (note.trim().length < 2) { window.alert('补充说明至少 2 个字符'); return; }
    body = { note: note.trim() };
  } else if (action === 'confirm-revocation') {
    const reason = window.prompt('确认撤销该回执？可填写审查意见（可留空，最多 300 字）：', '');
    if (reason === null) return;
    const ok = window.confirm('确认撤销后原回执核验将返回“已撤销”，此操作不可撤销。是否继续？');
    if (!ok) return;
    body = { reason: reason.trim() };
  }
  try {
    await api('POST', `/api/processor/objections/${encodeURIComponent(o.objectionNo)}/${action}`, body);
    window.alert('操作成功');
    await loadList();
    if (currentDetailNo === o.objectionNo) await loadDetail(o.objectionNo);
  } catch (error) {
    window.alert(`操作被拒绝：${error.message}（${error.code || ''}）`);
    await loadList();
    if (currentDetailNo === o.objectionNo) await loadDetail(o.objectionNo);
  }
}

boot();
