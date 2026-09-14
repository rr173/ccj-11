// 主管：领取网点 / 时间段容量 / 预约占用 / 失败原因
const $ = (selector) => document.querySelector(selector);

let csrfToken = readCookie('csrf');
let locations = [];
let slotsByLocation = {};
let appointments = [];
let denials = [];

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

function showAlert(message, kind = 'error') {
  const el = $('#globalAlert');
  el.className = `alert ${kind === 'success' ? 'success' : 'warning'}`;
  el.textContent = message;
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const result = await api('POST', '/api/login', data);
    csrfToken = result.csrfToken;
    if (result.user.role !== 'supervisor') {
      $('#loginError').textContent = '该账号不是主管角色，请使用 supervisor1 登录本页面';
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
$('#refreshBtn').addEventListener('click', () => loadAll().catch((e) => showAlert(e.message)));
$('#newLocationBtn').addEventListener('click', () => $('#newLocationBox').classList.toggle('hidden'));
$('#cancelLocationBtn').addEventListener('click', () => $('#newLocationBox').classList.add('hidden'));
$('#saveLocationBtn').addEventListener('click', saveLocation);
$('#statusFilter').addEventListener('change', renderAppointments);

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
    await loadAll();
  } catch (error) {
    $('#loginView').classList.remove('hidden');
    $('#appView').classList.add('hidden');
  }
}

async function loadAll() {
  const data = await api('GET', '/api/supervisor/pickup/locations');
  locations = data.locations || [];
  appointments = data.appointments || [];
  denials = data.denials || [];
  slotsByLocation = {};
  for (const loc of locations) {
    const slotsData = await api('GET', `/api/supervisor/pickup/locations/${encodeURIComponent(loc.id)}/slots`);
    slotsByLocation[loc.id] = slotsData.slots || [];
  }
  renderLocations();
  renderAppointments();
  renderDenials();
}

async function saveLocation() {
  const name = $('#locName').value.trim();
  const address = $('#locAddress').value.trim();
  const note = $('#locNote').value.trim();
  try {
    await api('POST', '/api/supervisor/pickup/locations', { name, address, note });
    $('#locName').value = '';
    $('#locAddress').value = '';
    $('#locNote').value = '';
    $('#newLocationBox').classList.add('hidden');
    await loadAll();
  } catch (error) {
    showAlert(error.message);
  }
}

function renderLocations() {
  $('#locationList').innerHTML = locations.map((loc) => {
    const slots = slotsByLocation[loc.id] || [];
    const capacity = slots.reduce((sum, slot) => sum + slot.capacity, 0);
    const occupied = slots.reduce((sum, slot) => sum + slot.occupied, 0);
    return `
    <article class="card-inner" data-location-id="${escapeHtml(loc.id)}">
      <div class="receipt-head">
        <div>
          <b>${escapeHtml(loc.name)}</b>
          <span class="tag ${loc.status === 'active' ? 'tag-ok' : 'tag-reject'}">${escapeHtml(loc.statusLabel)}</span>
          <span class="tag tag-muted">v${loc.version}</span>
        </div>
        <div class="filter-bar">
          <button type="button" class="button secondary tiny" data-act="rename">改名/地址</button>
          ${loc.status === 'active' ? '<button type="button" class="button danger tiny" data-act="disable">停用网点</button>' : ''}
        </div>
      </div>
      <p class="muted small" style="margin:6px 0">${escapeHtml(loc.address)}${loc.note ? `｜${escapeHtml(loc.note)}` : ''}</p>
      <p class="muted small" style="margin:6px 0">合计容量 ${capacity}，占用 ${occupied}，剩余 ${Math.max(0, capacity - occupied)}</p>

      <div class="js-new-slot archive-create hidden">
        <label>开始 / 结束
          <div class="replay-create-row">
            <input type="datetime-local" class="js-start" step="60">
            <input type="datetime-local" class="js-end" step="60">
          </div>
        </label>
        <label>每段容量<input type="number" class="js-capacity" min="1" value="5" style="max-width:120px"></label>
        <label>备注（可选）<input class="js-note" maxlength="200"></label>
        <div class="form-actions">
          <button type="button" class="button primary tiny" data-act="save-slot">保存时间段</button>
          <button type="button" class="button secondary tiny" data-act="cancel-slot">取消</button>
        </div>
      </div>

      <div class="js-slots"></div>
      ${loc.status === 'active' ? '<button type="button" class="button secondary tiny" data-act="new-slot" style="margin-top:8px">+ 新增时间段</button>' : ''}
    </article>`;
  }).join('') || '<p class="muted small">尚无网点。点击“新建网点”开始维护。</p>';

  locations.forEach((loc) => {
    const card = document.querySelector(`article[data-location-id="${CSS.escape(loc.id)}"]`);
    if (!card) return;
    renderSlotList(card, loc);
    card.addEventListener('click', (event) => onLocationClick(event, card, loc));
  });
}

function renderSlotList(card, loc) {
  const box = card.querySelector('.js-slots');
  const slots = slotsByLocation[loc.id] || [];
  if (!slots.length) {
    box.innerHTML = '<p class="muted small">该网点尚无时间段。</p>';
    return;
  }
  box.innerHTML = `<table class="diff-table">
    <thead><tr><th>时间范围</th><th>容量版本</th><th>占用/容量</th><th>状态</th><th>操作</th></tr></thead>
    <tbody>${slots.map((slot) => `
      <tr data-slot-id="${escapeHtml(slot.id)}">
        <td>${formatTime(slot.startAt)}<br>${formatTime(slot.endAt)}${slot.note ? `<br><span class="muted small">${escapeHtml(slot.note)}</span>` : ''}</td>
        <td>v${slot.capacityVersion}</td>
        <td>${slot.occupied}/${slot.capacity}（剩 ${slot.remaining}）</td>
        <td><span class="tag ${slot.status === 'open' ? 'tag-ok' : 'tag-muted'}">${escapeHtml(slot.statusLabel)}</span></td>
        <td class="review-table">
          <button type="button" class="button secondary tiny" data-act="edit-slot">调整</button>
          ${slot.status === 'open' ? '<button type="button" class="button danger tiny" data-act="close-slot">关闭</button>' : ''}
        </td>
      </tr>`).join('')}
    </tbody></table>`;
}

function renderAppointments() {
  const status = $('#statusFilter').value;
  const rows = appointments.filter((item) => !status || item.status === status);
  $('#appointmentList').innerHTML = rows.map((appt) => `
    <article class="card-inner">
      <div class="receipt-head">
        <div>
          <b class="mono">${escapeHtml(appt.appointmentNo)}</b>
          <span class="tag ${appt.status === 'delivered' || appt.status === 'booked' ? 'tag-ok' : appt.status === 'cancelled' ? 'tag-muted' : 'tag-reject'}">${escapeHtml(appt.statusLabel)}</span>
        </div>
        <span class="muted small">回执 ${escapeHtml(appt.receiptNo)}｜预约版本 v${appt.version}</span>
      </div>
      <table class="kv">
        <tr><th>冻结领取信息</th><td>${escapeHtml(appt.frozen.locationName)}，${escapeHtml(appt.frozen.locationAddress)}<br>${formatTime(appt.frozen.startAt)} – ${formatTime(appt.frozen.endAt)}（容量版本 v${appt.frozen.capacityVersion}）</td></tr>
        <tr><th>当前时间段</th><td>${appt.currentSlot ? `${escapeHtml(appt.currentSlot.locationName)}｜占用 ${appt.currentSlot.occupied}/${appt.currentSlot.capacity}｜${appt.currentSlot.status === 'open' ? '开放' : '已关闭'}` : '（时间段已不存在）'}</td></tr>
        ${appt.deliveredAt ? `<tr><th>交付</th><td>${formatTime(appt.deliveredAt)}（${escapeHtml(appt.deliveredByLabel)}）</td></tr>` : ''}
        ${appt.cancelReason ? `<tr><th>取消原因</th><td>${escapeHtml(appt.cancelReason)}</td></tr>` : ''}
      </table>
    </article>`).join('') || '<p class="muted small">暂无预约。</p>';
}

function renderDenials() {
  $('#denialList').innerHTML = denials.map((row) => `
    <div class="material-box">
      <div><b>${formatTime(row.createdAt)}</b> <span class="tag tag-reject">${escapeHtml(row.typeLabel)}</span>
        <span class="mono small">${escapeHtml(row.appointmentNo || row.receiptNo || row.slotId || '')}</span>
      </div>
      <div class="muted small">${escapeHtml(row.detail.reason || '')}：${escapeHtml(row.detail.message || '')}（${escapeHtml(row.actorLabel || row.actorRole || '')}）</div>
    </div>`).join('') || '<p class="muted small">暂无拒绝记录。</p>';
}

async function onLocationClick(event, card, loc) {
  const button = event.target.closest('button[data-act]');
  if (!button) return;
  const act = button.dataset.act;
  try {
    if (act === 'rename') {
      const name = window.prompt('网点名称：', loc.name);
      if (name === null) return;
      const address = window.prompt('网点地址：', loc.address);
      if (address === null) return;
      await api('POST', `/api/supervisor/pickup/locations/${encodeURIComponent(loc.id)}`, { name: name.trim(), address: address.trim() });
      await loadAll();
    } else if (act === 'disable') {
      if (!window.confirm(`确认停用网点「${loc.name}」？停用后不能再新建时间段/预约，已有预约不受影响。`)) return;
      await api('POST', `/api/supervisor/pickup/locations/${encodeURIComponent(loc.id)}/disable`, {});
      await loadAll();
    } else if (act === 'new-slot') {
      card.querySelector('.js-new-slot').classList.remove('hidden');
    } else if (act === 'cancel-slot') {
      card.querySelector('.js-new-slot').classList.add('hidden');
    } else if (act === 'save-slot') {
      const startMs = new Date(card.querySelector('.js-start').value).getTime();
      const endMs = new Date(card.querySelector('.js-end').value).getTime();
      const capacity = Number(card.querySelector('.js-capacity').value);
      const note = card.querySelector('.js-note').value.trim();
      await api('POST', `/api/supervisor/pickup/locations/${encodeURIComponent(loc.id)}/slots`, {
        startAt: startMs, endAt: endMs, capacity, note,
      });
      card.querySelector('.js-new-slot').classList.add('hidden');
      await loadAll();
    } else if (act === 'close-slot') {
      const row = button.closest('tr[data-slot-id]');
      const slotId = row.dataset.slotId;
      if (!window.confirm('关闭后该时间段不能再被预约，已有预约不受影响。确认关闭？')) return;
      await api('POST', `/api/supervisor/pickup/slots/${encodeURIComponent(slotId)}/close`, {});
      await loadAll();
    } else if (act === 'edit-slot') {
      const row = button.closest('tr[data-slot-id]');
      const slot = (slotsByLocation[loc.id] || []).find((item) => item.id === row.dataset.slotId);
      await editSlot(slot);
      await loadAll();
    }
  } catch (error) {
    showAlert(error.message);
  }
}

async function editSlot(slot) {
  // 已有人预约时只允许调容量（时间范围锁定，后端同样强校验）
  const capacityAnswer = window.prompt(
    `调整容量（当前 ${slot.capacity}，已占用 ${slot.occupied}）：`,
    String(slot.capacity),
  );
  if (capacityAnswer === null) return;
  const capacity = Number(capacityAnswer.trim());
  const body = { capacity };
  if (slot.occupied === 0) {
    const startInput = window.prompt('开始时间（本地格式 YYYY-MM-DDTHH:mm；留空保持不变）：', toLocalInput(slot.startAt));
    if (startInput === null) return;
    const endInput = window.prompt('结束时间（本地格式 YYYY-MM-DDTHH:mm；留空保持不变）：', toLocalInput(slot.endAt));
    if (endInput === null) return;
    if (startInput.trim()) body.startAt = new Date(startInput.trim()).getTime();
    if (endInput.trim()) body.endAt = new Date(endInput.trim()).getTime();
  } else {
    const proceed = window.confirm('该时间段已有人预约，时间范围不能调整，仅会更新容量（容量版本 +1，不影响已有预约冻结信息）。继续？');
    if (!proceed) throw new Error('已取消调整');
  }
  await api('POST', `/api/supervisor/pickup/slots/${encodeURIComponent(slot.id)}`, body);
}

function toLocalInput(epochMs) {
  const d = new Date(epochMs);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

boot();
