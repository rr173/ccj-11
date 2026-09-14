// 领取人员：在预约时间窗口（含宽限）内凭预约编号 + 一次性领取码确认交付
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
  el.className = `alert ${kind === 'success' ? 'success' : 'error'}`;
  el.textContent = message;
}

$('#loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.currentTarget));
  try {
    const result = await api('POST', '/api/login', data);
    csrfToken = result.csrfToken;
    if (result.user.role !== 'pickup') {
      $('#loginError').textContent = '该账号不是领取人员角色，请使用 pickup1 账号登录本页面';
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

async function boot() {
  try {
    const state = await api('GET', '/api/state');
    if (state.user.role !== 'pickup') {
      $('#loginView').classList.remove('hidden');
      $('#appView').classList.add('hidden');
      return;
    }
    $('#userName').textContent = state.user.displayName;
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
  } catch (error) {
    $('#loginView').classList.remove('hidden');
    $('#appView').classList.add('hidden');
  }
}

$('#lookupForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#globalAlert').className = 'alert hidden';
  const appointmentNo = String(event.currentTarget.elements.appointmentNo.value || '').trim();
  try {
    const data = await api('GET', `/api/pickup-delivery/context?appointmentNo=${encodeURIComponent(appointmentNo)}`);
    renderContext(data.context);
  } catch (error) {
    $('#contextBox').classList.add('hidden');
    showAlert(error.message);
  }
});

$('#confirmForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  $('#globalAlert').className = 'alert hidden';
  const form = event.currentTarget;
  const appointmentNo = String(form.elements.appointmentNo.value || '').trim();
  const code = String(form.elements.code.value || '').trim();
  const note = form.elements.note.value;
  try {
    const data = await api('POST', '/api/pickup-delivery/confirm', { appointmentNo, code, note });
    showAlert(`交付成功：${data.delivery.appointmentNo}（${formatTime(data.delivery.deliveredAt)}）。领取码已一次性消费。`, 'success');
    form.elements.code.value = '';
    renderContext(data.delivery);
  } catch (error) {
    showAlert(error.message);
  }
});

function renderContext(ctx) {
  const box = $('#contextBox');
  box.classList.remove('hidden');
  const graceMinutes = Math.round(ctx.graceMs / 60000);
  box.innerHTML = `
    <div><b class="mono">${escapeHtml(ctx.appointmentNo)}</b>
      <span class="tag ${ctx.status === 'delivered' ? 'tag-ok' : ['cancelled', 'revoked', 'expired'].includes(ctx.status) ? 'tag-reject' : 'tag-warn'}">${escapeHtml(ctx.statusLabel)}</span>
    </div>
    <dl class="verify-list">
      <dt>领取网点</dt><dd>${escapeHtml(ctx.locationName)}</dd>
      <dt>网点地址</dt><dd>${escapeHtml(ctx.locationAddress)}</dd>
      <dt>预约时间</dt><dd>${formatTime(ctx.startAt)} – ${formatTime(ctx.endAt)}</dd>
      <dt>允许宽限</dt><dd>结束后 ${graceMinutes} 分钟（端点包含）</dd>
      ${ctx.deliveredAt ? `<dt>已交付</dt><dd>${formatTime(ctx.deliveredAt)}</dd>` : ''}
    </dl>`;
}

boot();
