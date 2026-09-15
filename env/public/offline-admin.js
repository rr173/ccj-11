// 主管离线设备管理页
const $ = (id) => document.getElementById(id);
let me = null;

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(ms) { return ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—'; }

async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(path, {
    method,
    credentials: 'same-origin',
    headers: { ...headers, 'X-CSRF-Token': me?.csrf || '' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

function alertBox(el, kind, html) { el.className = `alert ${kind}`; el.innerHTML = html; }

async function login(username, password) {
  const res = await fetch('/api/login', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  });
  const data = await res.json();
  if (res.status !== 200) throw new Error(data.error?.message || '登录失败');
  me = { username, csrf: data.csrfToken, user: data.user };
  $('userName').textContent = `${data.user.displayName}（${data.user.username}）`;
  $('loginView').classList.add('hidden');
  $('appView').classList.remove('hidden');
  await loadDevices();
  await loadAudit();
}

function statusPill(device) {
  if (device.status === 'disabled') return '<span class="pill-reject">已停用</span>';
  if (device.expiresAt <= Date.now()) return '<span class="pill-reject">已过期</span>';
  return '<span class="pill-accept">启用中</span>';
}

async function loadDevices() {
  const { status, data } = await api('GET', '/api/supervisor/offline/devices');
  if (status !== 200) { $('deviceList').textContent = '加载失败'; return; }
  if (data.devices.length === 0) {
    $('deviceList').innerHTML = '<p class="muted small">尚未登记任何设备。</p>';
    return;
  }
  $('deviceList').innerHTML = data.devices.map((d) => `
    <div class="device-item" data-id="${esc(d.id)}">
      <div class="device-head"><b>${esc(d.name)}</b> ${statusPill(d)} <span class="muted small">v${d.keyVersion}</span></div>
      <div class="muted small">
        范围：${d.scope.kind === 'all' ? '全部回执' : `指定 ${d.scope.count} 份`}｜
        有效期至 ${fmt(d.expiresAt)}｜撤销宽限 ${d.graceMs / 1000} 秒
      </div>
      <div class="muted small">
        最后同步游标 <b>${d.cursor}</b>｜已收日志序号 ${d.acceptedSeq}｜上次同步 ${fmt(d.lastSyncAt)}｜
        待同步增量 <b class="${d.pendingDelta ? 'pill-warn-text' : ''}">${d.pendingDelta}</b>
        ${d.forkReason ? `｜<span class="pill-reject">分叉/缺口：${esc(d.forkReason)}</span>` : ''}
      </div>
      <div class="record-actions">
        <button type="button" class="button secondary" data-act="detail">详情/日志</button>
        <button type="button" class="button secondary" data-act="authorize">重新生成授权包</button>
        <button type="button" class="button secondary" data-act="rotate">轮换授权（设备找回前/疑似泄露）</button>
        <button type="button" class="button danger" data-act="disable">停用（设备丢失）</button>
      </div>
    </div>`).join('');
}

function oneTimeIssued(title, data) {
  const box = $('issueResult');
  box.classList.remove('hidden');
  box.innerHTML = `
    <h3>${esc(title)}</h3>
    <div class="alert success"><b>以下内容只显示这一次，请立即安全转交给核验设备：</b></div>
    <label class="form-row">设备令牌（用于联网同步，请保密）
      <textarea rows="2" readonly>${esc(data.token)}</textarea>
    </label>
    <label class="form-row">一次性下载凭证（15 分钟内、仅可下载一次）
      <textarea rows="2" readonly>${esc(data.credential)}</textarea>
    </label>
    <p class="muted small">设备端打开<a href="/offline-device" target="_blank">离线核验设备页</a>录入以上两项即可下载并验签授权包。授权版本 v${esc(data.keyVersion)}。</p>`;
}

$('deviceList').addEventListener('click', async (ev) => {
  const btn = ev.target.closest('button[data-act]');
  if (!btn) return;
  const item = btn.closest('.device-item');
  const id = item.dataset.id;
  const act = btn.dataset.act;
  if (act === 'detail') return showDetail(id);
  if (act === 'authorize') {
    const { status, data } = await api('POST', `/api/supervisor/offline/devices/${encodeURIComponent(id)}/authorize`, {});
    if (status !== 200) return alert(`生成失败：${data.error?.message || status}`);
    // 重新生成授权包不更换设备令牌；只给出新的一次性下载凭证
    const box = $('issueResult');
    box.classList.remove('hidden');
    box.innerHTML = `
      <h3>已重新生成授权包 v${esc(data.keyVersion)}</h3>
      <div class="alert success"><b>下载凭证只显示这一次（15 分钟内有效），设备令牌不变：</b></div>
      <label class="form-row">一次性下载凭证<textarea rows="2" readonly>${esc(data.credential)}</textarea></label>`;
    return loadDevices();
  }
  if (act === 'rotate') {
    const ttlDays = Number(prompt('新授权有效期（天，1-365）', '30'));
    const graceMinutes = Number(prompt('新撤销宽限期（分钟，1-60）', '5'));
    const { status, data } = await api('POST', `/api/supervisor/offline/devices/${encodeURIComponent(id)}/rotate`, {
      ttlMs: ttlDays * 86400000, graceMs: graceMinutes * 60000,
    });
    if (status !== 200) return alert(`轮换失败：${data.error?.message || status}`);
    oneTimeIssued(`授权已轮换到 v${data.keyVersion}（旧包与旧令牌立即失效）`, data);
    return loadDevices();
  }
  if (act === 'disable') {
    const reason = prompt('停用原因（例如：设备丢失）', '设备丢失');
    if (reason === null) return;
    const { status, data } = await api('POST', `/api/supervisor/offline/devices/${encodeURIComponent(id)}/disable`, { reason });
    if (status !== 200) return alert(`停用失败：${data.error?.message || status}`);
    alert('设备已停用：旧授权包、旧令牌立即失效，未上传日志不再被接受。');
    return loadDevices();
  }
});

async function showDetail(id) {
  const { status, data } = await api('GET', `/api/supervisor/offline/devices/${encodeURIComponent(id)}`);
  if (status !== 200) return;
  const d = data.device;
  $('deviceDetail').classList.remove('hidden');
  $('deviceDetail').innerHTML = `
    <h2>${esc(d.name)}</h2>
    <div class="muted small">设备标识 <code>${esc(d.id)}</code></div>
    <div class="muted small">状态 ${statusPill(d)}｜授权版本 v${d.keyVersion}｜范围 ${d.scope.kind === 'all' ? '全部' : d.scope.count + ' 份'}｜有效期至 ${fmt(d.expiresAt)}｜宽限 ${d.graceMs / 1000}s</div>
    <div class="muted small">同步游标 ${d.cursor}｜已收日志序号 ${d.acceptedSeq}｜待同步增量 ${d.pendingDelta}｜上次同步 ${fmt(d.lastSyncAt)}</div>
    <h3>服务器已接收的离线核验日志（最近 200 条）</h3>
    <div class="archive-list">${(data.logs || []).map((l) => `
      <div class="log-row">
        <div><b>#${l.seq}</b> ${l.result === 'accepted' ? '<span class="pill-accept">通过</span>' : '<span class="pill-reject">拒绝</span>'} ${l.reason ? esc(l.reason) : ''}</div>
        <div class="muted small">${esc(l.receiptNo)} · 核验时刻 ${fmt(l.entryAt)} · 同步到达 ${fmt(l.receivedAt)} · v${l.keyVersion}</div>
      </div>`).join('') || '<p class="muted small">暂无</p>'}</div>`;
  $('deviceDetail').scrollIntoView({ behavior: 'smooth' });
}

$('registerForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = new FormData(ev.target);
  const kind = form.get('scopeKind');
  const nos = String(form.get('receiptNos') || '').split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const ttlDays = Number(form.get('ttlDays')) || 30;
  const graceMinutes = Number(form.get('graceMinutes')) || 5;
  const body = {
    name: form.get('name'),
    scope: kind === 'all' ? { kind: 'all' } : { kind: 'list', receiptNos: nos },
    ttlMs: ttlDays * 86400000,
    graceMs: graceMinutes * 60000,
  };
  const { status, data } = await api('POST', '/api/supervisor/offline/devices', body);
  if (status !== 200) {
    alertBox($('issueResult'), 'error', `登记失败：${data.error?.message || status}`);
    $('issueResult').classList.remove('hidden');
    return;
  }
  oneTimeIssued('设备已登记并生成首个授权包', data);
  ev.target.reset();
  loadDevices();
});

document.querySelectorAll('input[name="scopeKind"]').forEach((r) => r.addEventListener('change', (e) => {
  document.querySelector('textarea[name="receiptNos"]').disabled = e.target.value !== 'list' || !e.target.checked;
}));
document.querySelectorAll('input[name="scopeKind"]').forEach((r) => r.addEventListener('click', () => {
  document.querySelector('textarea[name="receiptNos"]').disabled = r.value !== 'list' || !r.checked;
}));

async function loadAudit() {
  const result = $('auditResult').value;
  const qs = result ? `?result=${result}` : '';
  const { status, data } = await api('GET', `/api/supervisor/offline/audit${qs}`);
  if (status !== 200) { $('auditList').textContent = '加载失败'; return; }
  $('auditList').innerHTML = data.audit.map((a) => `
    <div class="audit-row ${a.result === 'denied' ? 'audit-denied' : ''}">
      <div><b>${esc(a.type)}</b> ${a.result === 'denied' ? '<span class="pill-reject">拒绝</span>' : '<span class="pill-accept">成功</span>'}</div>
      <div class="muted small">${fmt(a.createdAt)} · 设备 ${esc(a.deviceName || a.deviceId.slice(0, 8))} · ${a.receiptNo ? '回执 ' + esc(a.receiptNo) : ''} · 操作人 ${esc(a.actor.label || a.actor.role)}</div>
      ${Object.keys(a.detail || {}).length ? `<div class="muted small mono">${esc(JSON.stringify(a.detail))}</div>` : ''}
    </div>`).join('') || '<p class="muted small">暂无事件</p>';
}

$('refreshBtn').addEventListener('click', loadDevices);
$('refreshAuditBtn').addEventListener('click', loadAudit);
$('auditResult').addEventListener('change', loadAudit);

$('loginForm').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const form = new FormData(ev.target);
  $('loginError').classList.add('hidden');
  try {
    await login(form.get('username'), form.get('password'));
  } catch (error) {
    $('loginError').textContent = error.message;
    $('loginError').classList.remove('hidden');
  }
});
$('logoutBtn').addEventListener('click', async () => {
  await fetch('/api/logout', { method: 'POST', headers: { 'X-CSRF-Token': me?.csrf || '' } });
  location.reload();
});
