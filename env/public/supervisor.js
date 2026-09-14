const $ = (selector) => document.querySelector(selector);

let csrfToken = readCookie('csrf');

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

const KIND_LABELS = {
  reminder: '到期前提醒',
  overdue: '逾期升级',
  'extension-requested': '延期申请待审批',
  'extension-approved': '延期已批准',
  'extension-rejected': '延期已拒绝',
};
const KIND_CLASS = {
  reminder: 'tag-warn',
  overdue: 'tag-reject',
  'extension-requested': 'tag-warn',
  'extension-approved': 'tag-ok',
  'extension-rejected': 'tag-reject',
};
const EXT_STATUS = {
  pending: ['待主管审批', 'tag-warn'],
  approved: ['已批准', 'tag-ok'],
  rejected: ['已拒绝', 'tag-reject'],
};
const OBJECTION_STATUS = {
  submitted: '待受理', accepted: '已受理', supplementing: '待补充材料',
  rejected: '已驳回', revoked: '已确认撤销',
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
    if (result.user.role !== 'supervisor') {
      $('#loginError').textContent = '该账号不是主管角色，请使用 supervisor 角色账号登录本页面';
      $('#loginError').classList.remove('hidden');
      return;
    }
    boot();
  } catch (error) {
    $('#loginError').textContent = error.message;
    $('#loginError').classList.remove('hidden');
  }
});
$('#logoutBtn').addEventListener('click', async () => {
  try { await api('POST', '/api/logout', {}); } finally { location.reload(); }
});
$('#refreshNotifsBtn').addEventListener('click', loadNotifications);
$('#refreshExtBtn').addEventListener('click', loadExtensions);
$('#kindFilter').addEventListener('change', loadNotifications);
$('#extensionFilter').addEventListener('change', loadExtensions);

async function boot() {
  try {
    const state = await api('GET', '/api/state');
    if (state.user.role !== 'supervisor') {
      $('#loginView').classList.remove('hidden');
      $('#appView').classList.add('hidden');
      return;
    }
    $('#userName').textContent = state.user.displayName;
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
    await Promise.all([loadNotifications(), loadExtensions()]);
  } catch {
    $('#loginView').classList.remove('hidden');
    $('#appView').classList.add('hidden');
  }
}

async function loadNotifications() {
  const kind = $('#kindFilter').value;
  const { notifications } = await api('GET', `/api/supervisor/notifications${kind ? `?kind=${encodeURIComponent(kind)}` : ''}`);
  const list = $('#notificationList');
  if (!notifications.length) {
    list.innerHTML = '<p class="muted">暂无通知记录。</p>';
    return;
  }
  list.innerHTML = notifications.map((n) => `
    <div class="archive-item card-inner">
      <div class="record-main">
        <span class="tag ${KIND_CLASS[n.kind] || 'tag-warn'}">${escapeHtml(KIND_LABELS[n.kind] || n.kind)}</span>
        <b class="mono">${escapeHtml(n.objectionNo)}</b>
        <span class="muted small">来源回执 <span class="mono">${escapeHtml(n.receiptNo)}</span></span>
      </div>
      <div class="muted small">
        异议状态：${escapeHtml(n.payload.statusLabel || n.payload.status)}
        · 处理截止：${formatTime(n.payload.deadlineAt)}
        ${n.level > 1 ? ` · 升级第 ${n.level} 层` : ''}
      </div>
      <div class="muted small">
        生成于 ${formatTime(n.createdAt)}${n.sentAt ? ` · 发送于 ${formatTime(n.sentAt)}` : ''}
        ${n.readAt ? ` · 已读于 ${formatTime(n.readAt)}` : ' · <b>未读</b>'}
      </div>
      <div class="record-actions">
        ${n.readAt ? '' : `<button class="button secondary" type="button" data-read="${escapeHtml(n.id)}">确认已读</button>`}
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-read]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('POST', `/api/supervisor/notifications/${encodeURIComponent(btn.dataset.read)}/read`, {});
        await loadNotifications();
      } catch (error) {
        window.alert(`确认已读失败：${error.message}`);
      }
    });
  });
}

async function loadExtensions() {
  const status = $('#extensionFilter').value;
  const { extensions } = await api('GET', `/api/supervisor/extensions${status ? `?status=${encodeURIComponent(status)}` : ''}`);
  const list = $('#extensionList');
  if (!extensions.length) {
    list.innerHTML = '<p class="muted">暂无符合条件的延期申请。</p>';
    return;
  }
  list.innerHTML = extensions.map((e) => {
    const [statusText, statusCls] = EXT_STATUS[e.status] || [e.status, 'tag-warn'];
    return `
    <div class="archive-item card-inner" data-extension="${escapeHtml(e.id)}">
      <div class="record-main">
        <b class="mono">${escapeHtml(e.objectionNo)}</b>
        <span class="tag ${statusCls}">${statusText}</span>
        <span class="muted small">来源回执 <span class="mono">${escapeHtml(e.receiptNo)}</span></span>
      </div>
      <div class="muted small">
        异议当前状态：${escapeHtml(OBJECTION_STATUS[e.objectionStatus] || e.objectionStatus)}
        · 处理人：${escapeHtml(e.requestedBy?.displayName || '—')}
        · 申请于 ${formatTime(e.requestedAt)}
      </div>
      <div class="small"><b>延期原因：</b>${escapeHtml(e.reason)}</div>
      <div class="muted small">
        原截止 ${formatTime(e.previousDeadlineAt)} · 当前截止 ${formatTime(e.currentDeadlineAt)}
        · 申请顺延 ${Math.round(e.requestedDurationMs / 3600000)} 小时
      </div>
      ${e.decidedAt ? `<div class="small review-obj-result">主管${e.status === 'approved' ? '批准' : '拒绝'}（${formatTime(e.decidedAt)}）：${escapeHtml(e.decisionNote || '—')}</div>` : ''}
      <div class="record-actions">
        ${e.status === 'pending'
          ? `<button class="button primary" type="button" data-decision="approve">批准延期</button>
             <button class="button danger" type="button" data-decision="reject">拒绝（需说明）</button>`
          : '<span class="muted small">该申请已决议，记录不可覆盖。</span>'}
      </div>
    </div>`;
  }).join('');
  list.querySelectorAll('[data-extension]').forEach((card) => {
    const extensionId = card.dataset.extension;
    card.querySelectorAll('[data-decision]').forEach((btn) => {
      btn.addEventListener('click', () => decide(extensionId, btn.dataset.decision));
    });
  });
}

async function decide(extensionId, decision) {
  let note = '';
  if (decision === 'approve') {
    note = (window.prompt('批准延期说明（可留空，最多 300 字）：', '') ?? '').trim();
  } else {
    note = (window.prompt('请填写拒绝理由（至少 2 个字符）：', '') ?? '').trim();
    if (note.length < 2) { window.alert('拒绝理由至少 2 个字符'); return; }
  }
  if (note.length > 300) { window.alert('说明不能超过 300 字'); return; }
  try {
    const result = await api('POST', `/api/supervisor/extensions/${encodeURIComponent(extensionId)}/${decision}`, { note });
    window.alert(decision === 'approve'
      ? `已批准，新处理截止：${formatTime(result.newDeadlineAt)}`
      : '已拒绝该延期申请');
    await Promise.all([loadNotifications(), loadExtensions()]);
  } catch (error) {
    window.alert(`决议失败：${error.message}（${error.code || ''}）`);
    await loadExtensions();
  }
}

boot();
