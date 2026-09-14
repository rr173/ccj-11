// 办理人：回执线下领取预约（预约 / 改约 / 取消 / 操作历史）
const $ = (selector) => document.querySelector(selector);

let csrfToken = readCookie('csrf');
let slots = [];
let appointments = [];

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

const STATUS_CLASS = {
  booked: 'tag-ok', rescheduled: 'tag-ok', delivered: 'tag-ok',
  cancelled: 'tag-muted', revoked: 'tag-reject', expired: 'tag-warn',
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

function showAlert(message, kind = 'error') {
  const el = $('#globalAlert');
  el.className = `alert ${kind === 'success' ? 'success' : kind === 'warning' ? 'warning' : 'error'}`;
  el.textContent = message;
}
function clearAlert() {
  const el = $('#globalAlert');
  el.className = 'alert hidden';
  el.textContent = '';
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const result = await api('POST', '/api/login', data);
    csrfToken = result.csrfToken;
    if (['auditor', 'processor', 'supervisor', 'pickup'].includes(result.user.role)) {
      $('#loginError').textContent = '该账号不是办理人角色，请使用 alice/bob 等办理人账号';
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
$('#refreshBtn').addEventListener('click', () => loadAll().catch(showGlobalError));
$('#bookForm').addEventListener('submit', onBook);

async function boot(knownUser = null) {
  try {
    const state = await api('GET', '/api/state');
    if (state.user.role !== 'handler') {
      $('#loginView').classList.remove('hidden');
      $('#appView').classList.add('hidden');
      return;
    }
    $('#userName').textContent = state.user.displayName;
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
    slots = state.bookableSlots || [];
    appointments = state.pickupAppointments || [];
    renderSlots();
    renderAppointments();
  } catch (error) {
    if (error.status === 401) {
      $('#loginView').classList.remove('hidden');
      $('#appView').classList.add('hidden');
    } else {
      showAlert(error.message);
    }
  }
}

function showGlobalError(error) {
  showAlert(error.message || String(error));
}

async function loadAll() {
  clearAlert();
  const data = await api('GET', '/api/pickup/appointments');
  slots = data.slots || [];
  appointments = data.appointments || [];
  renderSlots();
  renderAppointments();
}

function slotLabel(slot) {
  return `${slot.locationName}｜${formatTime(slot.startAt)} – ${formatTime(slot.endAt)}（剩 ${slot.remaining}/${slot.capacity}，容量版本 v${slot.capacityVersion}）`;
}

function renderSlots() {
  const select = $('#bookForm').elements.slotId;
  select.innerHTML = slots.length
    ? slots.map((slot) => `<option value="${escapeHtml(slot.id)}">${escapeHtml(slotLabel(slot))}</option>`).join('')
    : '<option value="">（暂无可预约时间段，请等待主管维护）</option>';
}

function statusBadge(appt) {
  const cls = STATUS_CLASS[appt.status] || 'tag-muted';
  return `<span class="tag ${cls}">${escapeHtml(appt.statusLabel)}</span>`;
}

function renderAppointments() {
  const container = $('#appointmentList');
  if (!appointments.length) {
    container.innerHTML = '<p class="muted small">暂无预约记录。</p>';
    return;
  }
  container.innerHTML = appointments.map(renderAppointmentCard).join('');
  container.querySelectorAll('[data-action]').forEach((button) => {
    button.addEventListener('click', () => onAction(button));
  });
}

function renderAppointmentCard(appt) {
  const active = appt.status === 'booked' || appt.status === 'rescheduled';
  const delivered = appt.status === 'delivered';
  return `
    <article class="card-inner" data-id="${escapeHtml(appt.id)}">
      <div class="receipt-head">
        <div>
          <b class="mono selectable">${escapeHtml(appt.appointmentNo)}</b>
          ${statusBadge(appt)}
        </div>
        <span class="muted small">回执 ${escapeHtml(appt.receiptNo)}</span>
      </div>
      <table class="kv">
        <tr><th>领取网点（冻结）</th><td>${escapeHtml(appt.frozen.locationName)}</td></tr>
        <tr><th>网点地址（冻结）</th><td>${escapeHtml(appt.frozen.locationAddress)}</td></tr>
        <tr><th>领取时间（冻结）</th><td>${formatTime(appt.frozen.startAt)} – ${formatTime(appt.frozen.endAt)}</td></tr>
        <tr><th>容量版本（冻结）</th><td>v${appt.frozen.capacityVersion}</td></tr>
        <tr><th>预约版本</th><td>v${appt.version}（改约/取消需携带此版本号）</td></tr>
        <tr><th>领取窗口</th><td>开始时间起，至结束时间后宽限 ${Math.round(appt.graceMs / 60000)} 分钟止（端点包含）</td></tr>
        <tr><th>创建时间</th><td>${formatTime(appt.createdAt)}</td></tr>
        ${appt.cancelReason ? `<tr><th>取消原因</th><td>${escapeHtml(appt.cancelReason)}</td></tr>` : ''}
        ${appt.revokeReason ? `<tr><th>失效原因</th><td>${escapeHtml(appt.revokeReason)}</td></tr>` : ''}
        ${delivered ? `<tr><th>交付时间</th><td>${formatTime(appt.deliveredAt)}（${escapeHtml(appt.deliveredByLabel)}）</td></tr>` : ''}
      </table>
      ${active ? `
        <div class="replay-actions">
          <select class="js-slot" style="max-width:420px">
            ${slots.map((slot) => `<option value="${escapeHtml(slot.id)}"${slot.id === appt.slotId ? ' selected' : ''}>${escapeHtml(slotLabel(slot))}</option>`).join('')}
          </select>
          <button type="button" class="button secondary" data-action="reschedule" data-id="${escapeHtml(appt.id)}" data-version="${appt.version}">改约（旧领取码立即失效）</button>
          <button type="button" class="button danger" data-action="cancel" data-id="${escapeHtml(appt.id)}" data-version="${appt.version}">取消并释放名额</button>
        </div>
        <div class="js-result" aria-live="polite"></div>
      ` : `<p class="muted small">该预约为只读终态：${escapeHtml(appt.statusLabel)}。</p>`}
      <details class="material-box">
        <summary>操作历史（只追加审计）</summary>
        <div class="js-history archive-pre">加载中…</div>
      </details>
    </article>`;
}

async function onAction(button) {
  const card = button.closest('.card-inner');
  const resultBox = card.querySelector('.js-result');
  resultBox.textContent = '';
  const action = button.dataset.action;
  const id = button.dataset.id;
  try {
    if (action === 'cancel') {
      const reason = window.prompt('取消原因（可选）：', '') ?? '';
      const expectedVersion = Number(button.dataset.version);
      const data = await api('POST', `/api/pickup/appointments/${encodeURIComponent(id)}/cancel`, { reason, expectedVersion });
      applyState(data);
      showAlert('已取消并释放名额。', 'success');
    } else if (action === 'reschedule') {
      const slotId = card.querySelector('.js-slot').value;
      const expectedVersion = Number(button.dataset.version);
      const note = window.prompt('改约备注（可选）：', '') ?? '';
      const data = await api('POST', `/api/pickup/appointments/${encodeURIComponent(id)}/reschedule`, {
        slotId, expectedVersion, note,
      });
      applyState(data);
      renderOneTimeCode(data);
    }
  } catch (error) {
    if (error.code === 'APPOINTMENT_VERSION_CONFLICT') {
      showAlert('预约已被其他操作改变（旧版本操作被拒绝），已为你刷新最新版本。', 'warning');
    } else {
      showAlert(error.message);
    }
    await loadAll().catch(() => {});
  }
}

async function onBook(event) {
  event.preventDefault();
  clearAlert();
  const form = event.currentTarget;
  const receiptNo = String(form.elements.receiptNo.value || '').trim();
  const slotId = form.elements.slotId.value;
  const note = form.elements.note.value;
  if (!slotId) {
    showAlert('暂无可预约时间段。');
    return;
  }
  try {
    const data = await api('POST', '/api/pickup/appointments', { receiptNo, slotId, note });
    applyState(data);
    form.elements.note.value = '';
    renderOneTimeCode(data);
  } catch (error) {
    showAlert(error.message);
    if (error.data?.slots) {
      slots = error.data.slots;
      renderSlots();
    }
  }
}

function applyState(data) {
  if (Array.isArray(data.appointments)) {
    appointments = data.appointments;
    renderAppointments();
  }
  if (Array.isArray(data.slots)) {
    slots = data.slots;
    renderSlots();
  }
}

function renderOneTimeCode(data) {
  // 明文领取码仅在本次响应中出现；刷新后无法找回
  const existing = document.querySelector('.code-once-banner');
  existing?.remove();
  const banner = document.createElement('div');
  banner.className = 'card code-once-banner';
  banner.innerHTML = `
    <div class="alert success" style="margin-bottom:0">
      <strong>预约编号与领取码只显示这一次，请立即抄写/截图：</strong>
      <div class="confirmation">
        <div>预约编号：<b class="mono selectable code-value">${escapeHtml(data.appointment.appointmentNo)}</b></div>
        <div>领取码：<b class="mono selectable code-value">${escapeHtml(data.pickupCode)}</b></div>
      </div>
      <span class="muted small">服务端仅保存可校验摘要，任何列表或接口都不会再次返回明文。领取人员页面凭“预约编号 + 领取码”交付。</span>
    </div>`;
  $('#appView').prepend(banner);
}

// 操作历史懒加载
$('#appointmentList').addEventListener('click', async (event) => {
  const summary = event.target.closest('details > summary.material-box, details summary');
  if (!summary) return;
  const details = summary.parentElement;
  if (!details.open) return;
  const card = details.closest('.card-inner');
  const box = card?.querySelector('.js-history');
  if (!box || box.dataset.loaded) return;
  const appt = appointments.find((item) => item.id === card.dataset.id);
  try {
    const data = await api('GET', `/api/pickup/appointments/${encodeURIComponent(appt.id)}/history`);
    box.dataset.loaded = '1';
    box.textContent = (data.history || []).map((row) => {
      const result = row.result === 'denied' ? '【拒绝】' : '【成功】';
      const detail = JSON.stringify(row.detail, null, 0);
      return `${formatTime(row.createdAt)} ${result}${row.typeLabel} ${row.actorLabel || row.actorRole} ${detail}`;
    }).join('\n') || '（暂无）';
  } catch (error) {
    box.textContent = `历史加载失败：${error.message}`;
  }
});

boot();
