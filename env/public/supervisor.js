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
    await Promise.all([
      loadNotifications(), loadExtensions(),
      loadCalendars(), loadMigrationHistory(),
    ]);
    initCalendarEditor();
    initMigrationControls();
  } catch {
    $('#loginView').classList.remove('hidden');
    $('#appView').classList.add('hidden');
  }
}

// ---------------------------------------------------------------------------
// 可版本化工作日历：版本列表 / 发布新版本
// ---------------------------------------------------------------------------
const WEEKDAY_LABELS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
const HHMM_OPTIONS = (() => {
  const opts = [];
  for (let m = 0; m <= 24 * 60; m += 30) {
    opts.push({ value: m, label: `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}` });
  }
  return opts;
})();

async function loadCalendars() {
  const data = await api('GET', '/api/supervisor/working-calendars');
  renderCurrentCalendar(data.current);
  renderVersionList(data.versions);
  renderMigrationTargets(data.versions);
}

function renderCurrentCalendar(current) {
  if (!current) { $('#currentCalendar').textContent = '尚无日历版本。'; return; }
  const workdays = current.config.weeklyWindows.filter((d) => !d.closed);
  $('#currentCalendar').innerHTML = `
    <div class="record-main">
      <span class="tag tag-ok">当前生效 v${current.version}${current.legacy ? '（全天兼容日历）' : ''}</span>
      <span class="muted">时区 ${escapeHtml(current.timezone)}</span>
    </div>
    <div>每周工作 <b>${workdays.length}</b> 天 · 节假日 <b>${current.config.holidays.length}</b> 天
      · 临时停办 <b>${current.config.closures.length}</b> 天
      ${current.note ? ` · ${escapeHtml(current.note)}` : ''}</div>`;
}

function renderVersionList(versions) {
  const list = $('#calendarVersionList');
  if (!versions.length) { list.innerHTML = '<p class="muted">暂无版本。</p>'; return; }
  list.innerHTML = versions.map((v) => `
    <details class="archive-item card-inner">
      <summary class="record-main">
        <span class="tag ${v.legacy ? 'tag-warn' : 'tag-ok'}">v${v.version}</span>
        <b>${v.legacy ? '全天 24 小时兼容日历' : '工作日历'}</b>
        <span class="muted small">${formatTime(v.createdAt)}</span>
      </summary>
      <div class="small">
        <div class="muted">时区 ${escapeHtml(v.timezone)}${v.note ? ` · ${escapeHtml(v.note)}` : ''}</div>
        <ul>${v.config.weeklyWindows.map((d) => `<li>${d.weekdayLabel}：${
          d.closed ? '<span class="tag tag-reject">休息</span>'
            : d.windows.map((w) => `${w.start}-${w.end}`).join('、')
        }</li>`).join('')}</ul>
        ${v.config.holidays.length ? `<div><b>节假日：</b>${v.config.holidays.map((h) => `${h.date} ${escapeHtml(h.name)}`).join('；')}</div>` : ''}
        ${v.config.closures.length ? `<div><b>临时停办：</b>${v.config.closures.map((c) => `${c.date} ${escapeHtml(c.note)}`).join('；')}</div>` : ''}
      </div>
    </details>`).join('');
}

function renderMigrationTargets(versions) {
  const select = $('#migrationTarget');
  if (!select) return;
  const published = versions.filter((v) => !v.legacy);
  select.innerHTML = published.map((v) => `<option value="${v.id}">v${v.version}${v.note ? ` — ${escapeHtml(v.note)}` : ''}</option>`).join('');
}

// 编辑器：从当前版本拷贝开始编辑（每周支持多个时段行）
let editorState = null;
function initCalendarEditor() {
  $('#newVersionBtn').onclick = () => openCalendarEditor();
  $('#cancelCalEditBtn').onclick = () => { $('#calendarEditorCard').classList.add('hidden'); };
  $('#publishCalBtn').onclick = publishCalendar;
}

async function openCalendarEditor() {
  $('#calEditError').classList.add('hidden');
  let source = null;
  try {
    const data = await api('GET', '/api/supervisor/working-calendars');
    source = data.current;
    renderMigrationTargets(data.versions);
  } catch { /* 无当前版本时用默认 */ }
  const weekly = source && !source.legacy
    ? source.config.weeklyWindows.map((d) => d.windows.map((w) => [w.startMinute, w.endMinute]))
    : [
      [[540, 720], [810, 1050]], [[540, 720], [810, 1050]],
      [[540, 720], [810, 1050]], [[540, 720], [810, 1050]],
      [[540, 720], [810, 1050]], [], [],
    ];
  editorState = {
    timezone: source?.legacy ? 'Asia/Shanghai' : (source?.timezone || 'Asia/Shanghai'),
    weekly,
    holidays: source ? source.config.holidays.map((h) => ({ ...h })) : [],
    closures: source ? source.config.closures.map((c) => ({ ...c })) : [],
  };
  $('#calTimezone').value = editorState.timezone;
  $('#calNote').value = '';
  renderWeeklyEditor();
  renderDateTable('holiday');
  renderDateTable('closure');
  $('#calendarEditorCard').classList.remove('hidden');
  $('#calendarEditorCard').scrollIntoView({ behavior: 'smooth' });
}

function timeSelect(value) {
  return `<select class="cal-time">${HHMM_OPTIONS.map((o) =>
    `<option value="${o.value}" ${o.value === value ? 'selected' : ''}>${o.label}</option>`).join('')}</select>`;
}

function renderWeeklyEditor() {
  const box = $('#weeklyEditor');
  box.innerHTML = editorState.weekly.map((windows, day) => `
    <div class="cal-day-row" data-day="${day}">
      <b class="cal-day-label">${WEEKDAY_LABELS[day]}</b>
      <div class="cal-windows">
        ${windows.map(([s, e], idx) => `
          <div class="cal-window" data-idx="${idx}">${timeSelect(s)} - ${timeSelect(e)}
            <button type="button" class="button danger tiny" data-remove-window="${idx}">删</button>
          </div>`).join('')}
        <button type="button" class="button secondary tiny" data-add-window>+ 时段</button>
      </div>
    </div>`).join('');
  box.querySelectorAll('.cal-day-row').forEach((row) => {
    const day = Number(row.dataset.day);
    row.querySelector('[data-add-window]').addEventListener('click', () => {
      collectWeeklyFromDom();
      editorState.weekly[day].push([540, 720]);
      renderWeeklyEditor();
    });
    row.querySelectorAll('[data-remove-window]').forEach((btn) => {
      btn.addEventListener('click', () => {
        collectWeeklyFromDom();
        editorState.weekly[day].splice(Number(btn.dataset.removeWindow), 1);
        renderWeeklyEditor();
      });
    });
  });
}

function collectWeeklyFromDom() {
  $('#weeklyEditor').querySelectorAll('.cal-day-row').forEach((row) => {
    const day = Number(row.dataset.day);
    editorState.weekly[day] = [...row.querySelectorAll('.cal-window')].map((win) => {
      const selects = win.querySelectorAll('select');
      return [Number(selects[0].value), Number(selects[1].value)];
    });
  });
}

function renderDateTable(kind) {
  const tbody = $(`#${kind}Table tbody`);
  const list = kind === 'holiday' ? editorState.holidays : editorState.closures;
  const labelKey = kind === 'holiday' ? 'name' : 'note';
  tbody.innerHTML = list.map((item, idx) => `
    <tr data-idx="${idx}">
      <td><input type="date" class="cal-date" value="${escapeHtml(item.date)}"></td>
      <td><input class="cal-label" maxlength="100" value="${escapeHtml(item[labelKey] || '')}"
                  placeholder="${kind === 'holiday' ? '节日名称（可选）' : '停办说明（可选）'}"></td>
      <td><button type="button" class="button danger tiny" data-remove-date="${idx}">删</button></td>
    </tr>`).join('');
  tbody.querySelectorAll('[data-remove-date]').forEach((btn) => {
    btn.addEventListener('click', () => {
      collectDatesFromDom();
      list.splice(Number(btn.dataset.removeDate), 1);
      renderDateTable(kind);
    });
  });
}

function collectDatesFromDom() {
  for (const kind of ['holiday', 'closure']) {
    const list = kind === 'holiday' ? editorState.holidays : editorState.closures;
    const labelKey = kind === 'holiday' ? 'name' : 'note';
    $(`#${kind}Table tbody`).querySelectorAll('tr').forEach((tr) => {
      const idx = Number(tr.dataset.idx);
      list[idx] = {
        date: tr.querySelector('.cal-date').value,
        [labelKey]: tr.querySelector('.cal-label').value.trim(),
      };
    });
  }
}

document.addEventListener('click', (event) => {
  const addBtn = event.target.closest?.('[data-add]');
  if (!addBtn || !editorState) return;
  const kind = addBtn.dataset.add;
  collectDatesFromDom();
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
  if (kind === 'holiday') editorState.holidays.push({ date: today, name: '' });
  else editorState.closures.push({ date: today, note: '' });
  renderDateTable(kind);
});

async function publishCalendar() {
  collectWeeklyFromDom();
  collectDatesFromDom();
  const calendarConfig = {
    timezone: $('#calTimezone').value.trim() || 'Asia/Shanghai',
    weeklyWindows: editorState.weekly,
    holidays: editorState.holidays.filter((h) => h.date),
    closures: editorState.closures.filter((c) => c.date),
  };
  try {
    await api('POST', '/api/supervisor/working-calendars', { note: $('#calNote').value.trim(), config: calendarConfig });
    $('#calendarEditorCard').classList.add('hidden');
    await loadCalendars();
    window.alert('新版本已发布。在办异议不会自动换版，请在下方生成迁移预览。');
  } catch (error) {
    const box = $('#calEditError');
    box.textContent = error.message;
    box.classList.remove('hidden');
  }
}

// ---------------------------------------------------------------------------
// 日历迁移：预览 → 按预览版本确认
// ---------------------------------------------------------------------------
let currentPreview = null;

function initMigrationControls() {
  $('#previewMigrationBtn').onclick = createPreview;
  $('#refreshMigrationBtn').onclick = loadMigrationHistory;
}

async function createPreview() {
  const targetVersionId = $('#migrationTarget').value;
  try {
    const data = await api('POST', '/api/supervisor/calendar-migrations/preview', { targetVersionId });
    currentPreview = data.preview;
    renderPreview(currentPreview);
  } catch (error) {
    window.alert(`生成预览失败：${error.message}`);
  }
}

function renderPreview(preview) {
  const box = $('#migrationPreview');
  const eligible = preview.items.filter((i) => i.eligible);
  box.innerHTML = `
    <div class="record-main">
      <span class="tag tag-ok">迁移预览 → v${preview.targetVersion}</span>
      <span>可迁移 <b>${eligible.length}</b> 条 · 排除 <b>${preview.items.length - eligible.length}</b> 条</span>
      <span class="muted">${formatTime(preview.createdAt)}</span>
    </div>
    <div class="muted tiny">预览摘要：<code>${preview.digest.slice(0, 16)}…</code>（确认时自动回传，清单变化会被拒绝）</div>
    <table class="cal-migration-table">
      <thead><tr><th>异议编号</th><th>状态</th><th>版本</th><th>当前截止</th><th>预计截止</th><th>结果</th></tr></thead>
      <tbody>
        ${preview.items.map((item) => `
          <tr class="${item.eligible ? '' : 'cal-row-excluded'}">
            <td class="mono">${escapeHtml(item.objectionNo)}</td>
            <td>${escapeHtml(OBJECTION_STATUS[item.status] || item.status)}${item.paused ? '（暂停中）' : ''}</td>
            <td>v${item.fromVersion} → v${item.targetVersion}</td>
            <td>${formatTime(item.currentDeadlineAt)}</td>
            <td>${item.eligible ? formatTime(item.prospectiveDeadlineAt) : '—'}</td>
            <td>${item.eligible
              ? (item.deadlineChange === 'on-resume' ? '暂停中：恢复时按新版本计算' : '将重算截止')
              : `<span class="tag tag-reject">${item.excludeReason === 'overdue' ? '已逾期，不迁移' : '已终结，不迁移'}</span>`}</td>
          </tr>`).join('')}
      </tbody>
    </table>
    <div class="record-actions">
      <button class="button primary" id="applyPreviewBtn" type="button" ${eligible.length ? '' : 'disabled'}>
        按此预览版本迁移 ${eligible.length} 条在办异议
      </button>
    </div>`;
  $('#applyPreviewBtn')?.addEventListener('click', applyPreview);
}

async function applyPreview() {
  if (!currentPreview) return;
  if (!window.confirm(`确认将 ${currentPreview.eligibleCount} 条异议迁移到 v${currentPreview.targetVersion}？此操作逐行留痕，且只对本次预览清单生效。`)) return;
  try {
    const data = await api('POST', `/api/supervisor/calendar-migrations/${currentPreview.id}/apply`, {
      digest: currentPreview.digest,
    });
    window.alert(`迁移完成：${data.migratedCount} 条异议已换版。`);
    currentPreview = null;
    $('#migrationPreview').innerHTML = '<p class="muted small">迁移已完成。可生成新的预览。</p>';
    await loadMigrationHistory();
  } catch (error) {
    let extra = '';
    if (error.code === 'MIGRATION_CONFLICT') extra = '\n\n清单中的异议在预览后已变化（终结/逾期/已换版），请重新生成预览后再确认。';
    window.alert(`迁移被拒绝：${error.message}${extra}`);
    const refreshed = await createPreviewSafe();
    if (refreshed) renderPreview(refreshed);
  }
}

async function createPreviewSafe() {
  try {
    const data = await api('POST', '/api/supervisor/calendar-migrations/preview', {
      targetVersionId: $('#migrationTarget').value,
    });
    currentPreview = data.preview;
    return data.preview;
  } catch { return null; }
}

async function loadMigrationHistory() {
  try {
    const data = await api('GET', '/api/supervisor/calendar-migrations');
    const list = $('#migrationHistory');
    const applied = data.previews.filter((p) => p.status === 'applied');
    if (!applied.length) { list.innerHTML = '<p class="muted">暂无已执行的迁移。</p>'; return; }
    list.innerHTML = applied.slice(0, 10).map((p) => `
      <div class="archive-item card-inner">
        <div class="record-main">
          <span class="tag tag-ok">已迁移 → v${p.targetVersion}</span>
          <span>共 ${p.eligibleCount} 条</span>
          <span class="muted small">${formatTime(p.createdAt)}</span>
        </div>
      </div>`).join('');
  } catch { /* 忽略历史加载失败 */ }
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
