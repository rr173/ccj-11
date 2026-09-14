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
  'receipt.objection.reminder.scheduled': '系统生成到期提醒',
  'receipt.objection.overdue': '逾期标记/升级',
  'receipt.objection.notification.read': '确认已读',
  'receipt.objection.extension.requested': '申请延期',
  'receipt.objection.extension.approved': '主管批准延期',
  'receipt.objection.extension.rejected': '主管拒绝延期',
  'receipt.objection.calendar.migrated': '日历版本迁移',
};

const NOTIF_KIND_TEXT = {
  reminder: '到期前提醒',
  overdue: '逾期升级',
  'extension-requested': '延期申请待审批',
  'extension-approved': '延期申请已批准',
  'extension-rejected': '延期申请已拒绝',
};
const NOTIF_KIND_CLASS = {
  reminder: 'tag-warn', overdue: 'tag-reject',
  'extension-requested': 'tag-warn', 'extension-approved': 'tag-ok', 'extension-rejected': 'tag-reject',
};
const EXT_STATUS_TEXT = { pending: '待主管审批', approved: '已批准', rejected: '已拒绝' };

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
$('#refreshNotifsBtn').addEventListener('click', loadNotifications);
$('#notificationStatusFilter').addEventListener('change', loadNotifications);
$('#notificationKindFilter').addEventListener('change', loadNotifications);

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
    await Promise.all([loadList(), loadNotifications()]);
  } catch {
    $('#loginView').classList.remove('hidden');
    $('#appView').classList.add('hidden');
  }
}

async function loadNotifications() {
  const status = $('#notificationStatusFilter').value;
  const kind = $('#notificationKindFilter').value;
  const params = new URLSearchParams();
  if (status) params.set('status', status);
  if (kind) params.set('kind', kind);
  const result = await api('GET', `/api/processor/notifications${params.size ? `?${params}` : ''}`);
  const list = $('#notificationList');
  if (!result.notifications.length) {
    list.innerHTML = '<p class="muted">暂无通知。</p>';
    return;
  }
  list.innerHTML = result.notifications.map((n) => `
    <div class="archive-item card-inner">
      <div class="record-main">
        <span class="tag ${NOTIF_KIND_CLASS[n.kind] || 'tag-warn'}">${escapeHtml(NOTIF_KIND_TEXT[n.kind] || n.kind)}</span>
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
        <button class="button secondary" type="button" data-detail="${escapeHtml(n.objectionNo)}">查看异议</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-read]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      try {
        await api('POST', `/api/processor/notifications/${encodeURIComponent(btn.dataset.read)}/read`, {});
        await Promise.all([loadNotifications(), loadList()]);
      } catch (error) {
        window.alert(`确认已读失败：${error.message}`);
      }
    });
  });
  list.querySelectorAll('[data-detail]').forEach((btn) => {
    btn.addEventListener('click', () => loadDetail(btn.dataset.detail));
  });
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
        ${o.overdueAt ? '<span class="badge invalidated">已逾处理期限</span>' : o.overdue ? '<span class="tag tag-reject">已逾处理期限</span>' : ''}
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

const TIMING_TEXT = {
  initial: '初始计时',
  deferral: '顺延',
  pause: '暂停（等待补充材料）',
  resume: '恢复计时（补交材料）',
  extension: '主管批准延期',
  migration: '日历版本迁移',
};

// 日历版本与逐段计时说明：每段非工作顺延、暂停/恢复、迁移都按发生顺序列出
function calendarTimingHtml(o) {
  if (!o.calendar) return '';
  const cal = o.calendar;
  const schedule = (cal.schedule || []).map((d) => `${d.weekdayLabel} ${
    d.closed ? '休息' : d.windows.map((w) => `${w.start}-${w.end}`).join('、')
  }`).join('；');
  const rows = (o.timing || []).map((t) => {
    const segments = (t.detail.segments || []).filter((s) => !s.working).map((s) =>
      `<li class="muted tiny">顺延：${formatTime(s.from)} → ${formatTime(s.to)} · ${escapeHtml(s.reason)}</li>`).join('');
    return `<li class="small">
      <b>#${t.ordinal} ${escapeHtml(TIMING_TEXT[t.type] || t.type)}</b>
      · ${formatTime(t.createdAt)}
      ${t.fromAt ? ` · 起 ${formatTime(t.fromAt)}` : ''}
      ${t.toAt ? ` · 止 ${formatTime(t.toAt)}` : ''}
      ${t.detail.note ? `<div>${escapeHtml(t.detail.note)}</div>` : ''}
      ${t.detail.calendarVersion !== undefined ? `<div class="muted tiny">日历版本 v${t.detail.calendarVersion} · 办理时长 ${t.detail.slaMinutes || t.detail.remainingMinutes || ''} 分钟</div>` : ''}
      ${t.detail.previousDeadlineAt ? `<div class="muted tiny">截止 ${formatTime(t.detail.previousDeadlineAt)} → ${formatTime(t.detail.newDeadlineAt)}</div>` : ''}
      ${segments ? `<ul class="batch-history-list">${segments}</ul>` : ''}
    </li>`;
  }).join('');
  const pauses = (o.pauses || []).map((p) => `
    <li class="small">#${p.ordinal} ${p.status === 'paused' ? '暂停中' : '已恢复'}
      · 暂停于 ${formatTime(p.pausedAt)}${p.resumedAt ? ` · 恢复于 ${formatTime(p.resumedAt)}` : ''}
      · 冻结剩余 ${p.remainingMinutesAtPause} 工作分钟
      ${p.note ? ` · ${escapeHtml(p.note)}` : ''}
    </li>`).join('');
  const migrations = (o.calendarMigrations || []).map((m) => `
    <li class="small">${formatTime(m.createdAt)} · ${formatTime(m.previousDeadlineAt)} → ${formatTime(m.newDeadlineAt)}</li>`).join('');
  return `
    <h3>工作日历与计时台账（版本固定，只追加）</h3>
    <div class="muted small">
      固定日历 <b>v${cal.calendarVersion}</b>${cal.legacy ? '（全天兼容日历，按自然时间）' : ''}
      · 时区 ${escapeHtml(cal.calendarTimezone)}
      · 办理时长 ${cal.slaMinutes} 工作分钟 · 剩余 ${cal.remainingMinutes} 工作分钟
      ${cal.paused ? ' · <b class="tag-warn">暂停中，不计时</b>' : ''}
      ${cal.calendarNote ? ` · ${escapeHtml(cal.calendarNote)}` : ''}
    </div>
    <details class="batch-history"><summary class="muted small">该版本每周工作时段</summary><div class="muted tiny">${escapeHtml(schedule)}</div></details>
    <ul class="batch-history-list">${rows || '<li class="muted small">暂无</li>'}</ul>
    ${pauses ? `<details class="batch-history" open><summary class="muted small">补充材料暂停段（${o.pauses.length}）</summary><ul class="batch-history-list">${pauses}</ul></details>` : ''}
    ${migrations ? `<details class="batch-history"><summary class="muted small">日历迁移记录（${o.calendarMigrations.length}）</summary><ul class="batch-history-list">${migrations}</ul></details>` : ''}`;
}

function escalationHtml(o) {
  const esc = o.escalation;
  if (!esc) return '';
  const notifs = (esc.notifications || []).map((n) => `
      <li class="muted small">
        ${formatTime(n.createdAt)} · ${escapeHtml(NOTIF_KIND_TEXT[n.kind] || n.kind)}
        · 接收方：${escapeHtml(n.audience === 'processor' ? '处理人（本人）' : n.audience)}
        · 状态：${({ pending: '待发送', sent: '已发送', read: '已读' })[n.status] || n.status}
        ${n.payload.deadlineAt ? ` · 截止 ${formatTime(n.payload.deadlineAt)}` : ''}
        ${n.readAt ? ` · 已读于 ${formatTime(n.readAt)}` : ''}
      </li>`).join('');
  const extensions = (esc.extensions || []).map((e) => `
      <li class="small">
        <b>${escapeHtml(EXT_STATUS_TEXT[e.status] || e.status)}</b>
        · 申请于 ${formatTime(e.requestedAt)}
        · 原截止 ${formatTime(e.previousDeadlineAt)} → 当前截止 ${formatTime(e.currentDeadlineAt)}
        <div>延期原因：${escapeHtml(e.reason)}</div>
        ${e.decidedAt ? `<div class="muted small">主管决议（${formatTime(e.decidedAt)}）：${escapeHtml(e.decisionNote || '—')}</div>` : ''}
      </li>`).join('');
  return `
    <h3>提醒 / 升级 / 延期留痕（只追加，不可覆盖）</h3>
    <details class="batch-history" open>
      <summary class="muted small">本异议的通知记录（${(esc.notifications || []).length} 条，仅含本人可见接收方）</summary>
      <ul class="batch-history-list">${notifs || '<li class="muted small">暂无</li>'}</ul>
    </details>
    <details class="batch-history">
      <summary class="muted small">延期申请（${(esc.extensions || []).length} 条，每异议至多一次）</summary>
      <ul class="batch-history-list">${extensions || '<li class="muted small">尚未申请</li>'}</ul>
    </details>`;
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
    const extensions = o.escalation?.extensions || [];
    const extension = extensions[0] || null;
    view.innerHTML = `
      <div class="receipt-head">
        <h2>撤销异议 <span class="mono">${escapeHtml(o.objectionNo)}</span>
          <span class="badge ${STATUS_CLASS[o.status]}">${STATUS_LABELS[o.status]}</span>
          ${o.overdueAt ? '<span class="badge invalidated">已逾处理期限</span>' : ''}
          ${extension ? `<span class="tag ${extension.status === 'approved' ? 'tag-ok' : extension.status === 'rejected' ? 'tag-reject' : 'tag-warn'}">延期：${escapeHtml(EXT_STATUS_TEXT[extension.status] || extension.status)}</span>` : ''}
        </h2>
      </div>
      <div class="receipt-meta">
        <div><span class="muted">来源回执</span><b class="mono">${escapeHtml(o.receiptNo)}</b></div>
        <div><span class="muted">原回执当前状态</span><b>${o.currentReceiptStatus === 'revoked' ? '已撤销' : '有效'}</b></div>
        <div><span class="muted">发起人</span><b>${escapeHtml(o.owner?.displayName || '—')}</b></div>
        <div><span class="muted">发起时间</span><b>${formatTime(o.createdAt)}</b></div>
        <div><span class="muted">处理期限</span><b>${formatTime(o.deadlineAt)}（${escapeHtml(formatRemaining(o.deadlineAt))}）</b></div>
        ${o.overdueAt ? `<div><span class="muted">首次逾期时刻</span><b>${formatTime(o.overdueAt)}</b></div>` : ''}
        <div><span class="muted">冻结快照摘要</span><b class="mono small">${escapeHtml(o.snapshotDigest.slice(0, 16))}…</b></div>
      </div>
      <div class="small"><b>异议原因：</b>${escapeHtml(o.reason)}</div>

      <h3>脱敏回执内容（仅授权可见的脱敏字段）</h3>
      ${maskedStepsHtml(o)}

      <h3>文本说明与补充材料（原文）</h3>
      ${materialsHtml(o) || '<p class="muted small">无</p>'}

      <h3>处理历史（只追加，不可覆盖）</h3>
      <ul class="batch-history-list">${eventsHtml(o)}</ul>

      ${calendarTimingHtml(o)}

      ${escalationHtml(o)}

      <div class="receipt-actions" data-actions>
        ${o.status === 'submitted' ? '<button class="button primary" data-act="accept">受理</button>' : ''}
        ${o.status === 'accepted' ? '<button class="button secondary" data-act="request-supplements">要求补充材料</button>' : ''}
        ${o.status === 'accepted' || o.status === 'supplementing' ? '<button class="button secondary" data-act="reject">驳回（需理由）</button>' : ''}
        ${o.status === 'accepted' ? '<button class="button danger" data-act="confirm-revocation">确认撤销回执</button>' : ''}
        ${!terminal && !extension ? '<button class="button secondary" data-act="request-extension">申请延期（仅一次）</button>' : ''}
        ${extension ? `<p class="muted small">延期申请：${escapeHtml(EXT_STATUS_TEXT[extension.status] || extension.status)}${extension.status === 'pending' ? '，等待主管审批，不能重复申请' : ''}</p>` : ''}
        ${terminal ? '<p class="muted small">该异议已处理完结，不能重复受理或覆盖历史。</p>' : ''}
        ${o.status === 'supplementing' ? '<p class="muted small">当前等待办理人补充材料，材料提交后异议将回到“已受理”。</p>' : ''}
      </div>
      ${o.status === 'revoked' ? '<div class="alert error">原回执已撤销：免登录核验将返回“已撤销”；原始冻结快照仍可供授权审计查看。</div>' : ''}
    `;
    view.querySelectorAll('[data-act]').forEach((btn) => {
      btn.addEventListener('click', () => {
        if (btn.dataset.act === 'request-extension') return requestExtension(o);
        return runAction(o, btn.dataset.act);
      });
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

async function requestExtension(o) {
  const reason = window.prompt('请填写延期原因（5-300 字）：', '');
  if (reason === null) return;
  if (reason.trim().length < 5 || reason.trim().length > 300) {
    window.alert('延期原因需为 5-300 个字符');
    return;
  }
  try {
    await api('POST', `/api/processor/objections/${encodeURIComponent(o.objectionNo)}/extension`, {
      reason: reason.trim(),
    });
    window.alert('延期申请已提交，等待主管审批');
    await Promise.all([loadList(), loadNotifications()]);
    if (currentDetailNo === o.objectionNo) await loadDetail(o.objectionNo);
  } catch (error) {
    window.alert(`延期申请被拒绝：${error.message}（${error.code || ''}）`);
    await Promise.all([loadList(), loadNotifications()]);
    if (currentDetailNo === o.objectionNo) await loadDetail(o.objectionNo);
  }
}

boot();
