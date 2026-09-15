// 离线核验设备页面：模拟真实设备的初始化、断网核验、摘要链日志与增量同步。
// 本机状态持久化到 localStorage（刷新/重开页面后恢复），令牌只保存在本机。
import * as runtime from '/offline-device.js';

const LS_KEY = 'offline-device-state-v1';
const $ = (id) => document.getElementById(id);
let state = null;
let lastBatch = null; // 最近一次发送的批次（含 batchId），用于幂等重试

function show(el, kind, html) {
  el.className = `alert ${kind}`;
  el.innerHTML = html;
}
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function fmt(ms) {
  return ms ? new Date(ms).toLocaleString('zh-CN', { hour12: false }) : '—';
}

function persist() {
  if (state) localStorage.setItem(LS_KEY, runtime.serializeState(state));
}

function renderDevice() {
  if (!state || !state.packageVerified) {
    $('deviceCard').classList.add('hidden');
    $('verifyCard').classList.add('hidden');
    $('syncCard').classList.add('hidden');
    $('logsCard').classList.add('hidden');
    return;
  }
  $('deviceCard').classList.remove('hidden');
  $('verifyCard').classList.remove('hidden');
  $('syncCard').classList.add('hidden'); // 同步需要联网，由断网开关控制显示
  $('logsCard').classList.remove('hidden');
  renderSyncCard();

  const expired = state.now() >= state.expiresAt;
  const deadlineMissed = state.syncDeadlineAt && state.now() >= state.syncDeadlineAt;
  const scopeText = state.scope.kind === 'all'
    ? `全部回执（当前载入 ${state.records.size} 份）`
    : `指定 ${state.scope.receiptNos.length} 份`;
  $('deviceStatus').innerHTML = `
    <div>设备：<b>${esc(state.envelope.payload.deviceLabel)}</b>（授权版本 v${state.keyVersion}）</div>
    <div>授权范围：${esc(scopeText)}</div>
    <div>授权有效期至：${fmt(state.expiresAt)} ${expired ? '<span class="pill-reject">已过期</span>' : ''}</div>
    <div>撤销宽限：${state.graceMs / 1000} 秒</div>
    <div>同步游标：<b>${state.cursor}</b>｜上次成功同步：${fmt(state.lastSuccessfulSyncAt)}</div>
    <div>下一日志序号：${state.nextSeq}｜链头：<code>${esc((state.lastDigest || '∅').slice(0, 16))}…</code></div>
    ${state.syncDeadlineAt ? `<div>撤销同步期限：${fmt(state.syncDeadlineAt)} ${deadlineMissed ? '<span class="pill-reject">已超期未同步，本机已暂停核验</span>' : ''}</div>` : ''}
    ${state.disabled ? '<div class="pill-reject">设备已停用</div>' : ''}
  `;
  renderLogs();
}

function renderSyncCard() {
  const offline = $('offlineMode').checked;
  $('syncCard').classList.toggle('hidden', offline);
}

function renderLogs() {
  $('pendingCount').textContent = runtime.pendingEntries(state).length;
  $('logList').innerHTML = state.logs.length === 0
    ? '<p class="muted small">暂无核验日志。</p>'
    : state.logs.slice(-20).reverse().map((e) => `
      <div class="log-row">
        <div><b>#${e.seq}</b> ${e.result === 'accepted' ? '<span class="pill-accept">核验通过</span>' : '<span class="pill-reject">拒绝</span>'}
        ${e.reason ? `<span class="muted small">${esc(e.reason)}</span>` : ''}</div>
        <div class="muted small">${esc(e.receiptNo)} · ${fmt(e.at)}</div>
        <div class="muted small mono">digest ${esc(e.digest.slice(0, 20))}… ← ${esc((e.prevDigest || '∅').slice(0, 16))}…</div>
      </div>`).join('');
}

async function api(path, body, token) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(path, { method: 'POST', headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

$('loadPackageBtn').addEventListener('click', async () => {
  const token = $('tokenInput').value.trim();
  const credential = $('credentialInput').value.trim();
  show($('provisionError'), 'info', '正在下载授权包…');
  if (!token || !credential) {
    show($('provisionError'), 'error', '请填写设备令牌与一次性下载凭证。');
    return;
  }
  const { status, data } = await api('/api/offline/packages/redeem', { credential });
  if (status !== 200 || !data.ok) {
    show($('provisionError'), 'error', `授权包下载被拒绝：${esc(data.error?.message || data.error?.code || status)}`);
    return;
  }
  // deviceId 必须来自服务器签名的包内，不能由页面自报
  const deviceId = data.package.payload.deviceId;
  state = runtime.createDeviceState({ deviceId, token });
  try {
    await runtime.loadPackage(state, data.package);
  } catch (error) {
    show($('provisionError'), 'error', `授权包验签失败：${esc(error.message)}`);
    state = null;
    return;
  }
  persist();
  lastBatch = null;
  show($('provisionError'), 'success', `授权包已验签并载入（${state.records.size} 份回执，基线游标 ${state.cursor}）。`);
  renderDevice();
});

$('restoreBtn').addEventListener('click', () => {
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) { alert('本机没有已保存的设备状态。'); return; }
  try {
    const saved = JSON.parse(raw);
    state = runtime.restoreState(raw);
    lastBatch = null;
    renderDevice();
    alert(`已恢复设备 ${state.deviceId.slice(0, 8)}… 的本机状态（游标 ${state.cursor}，待传日志 \${runtime.pendingEntries(state).length} 条）。`);
  } catch (error) {
    alert('恢复失败：' + error.message);
  }
});

$('wipeBtn').addEventListener('click', () => {
  if (!confirm('确定清除本机保存的设备状态？（不影响服务器记录）')) return;
  localStorage.removeItem(LS_KEY);
  state = null;
  lastBatch = null;
  renderDevice();
});

$('offlineMode').addEventListener('change', renderSyncCard);

$('verifyBtn').addEventListener('click', async () => {
  const receiptNo = $('verifyNo').value.trim();
  const code = $('verifyCode').value.trim();
  if (!state) return;
  try {
    const result = await runtime.offlineVerify(state, { receiptNo, code });
    persist();
    if (result.verdict === 'accepted') {
      const r = result.receipt;
      show($('verifyResult'), 'success', `
        <b>核验通过</b><br>
        回执编号：${esc(r.receiptNo)}<br>
        姓名（脱敏）：${esc(r.applicantName)}　手机（脱敏）：${esc(r.applicantPhone)}<br>
        事项：${esc(r.matter)}　完成时间：${fmt(r.completedAt)}<br>
        <span class="muted small">本机日志序号 #${result.entry.seq}</span>`);
    } else {
      const reasons = {
        not_found: '回执不存在', code_mismatch: '核验码不符', revoked: '回执已撤销',
        out_of_scope: '回执不在本设备授权范围',
      };
      show($('verifyResult'), 'error', `<b>核验被拒绝：</b>${esc(reasons[result.reason] || result.reason)}<br><span class="muted small">已记录本机日志 #${result.entry.seq}</span>`);
    }
    renderDevice();
  } catch (error) {
    show($('verifyResult'), 'error', `设备无法核验：${esc(error.message)}（${esc(error.code)}）`);
    renderDevice();
  }
});

async function doSync(batch) {
  const entries = batch ? batch.entries : runtime.pendingEntries(state);
  const payload = {
    deviceId: state.deviceId,
    keyVersion: state.keyVersion,
    cursor: state.cursor,
    batchId: batch ? batch.batchId : (entries.length ? crypto.randomUUID() : crypto.randomUUID()),
    entries,
  };
  if (!batch && entries.length) lastBatch = payload;
  if (!batch && entries.length === 0) lastBatch = null;
  const { status, data } = await api('/api/offline/sync', payload, state.token);
  if (status !== 200 || !data.ok) {
    $('syncResult').innerHTML = `<span class="pill-reject">同步被拒绝：${esc(data.error?.message || data.error?.code || status)}</span>`;
    return null;
  }
  runtime.applySyncResponse(state, data, { sentEntries: entries });
  persist();
  renderDevice();
  $('syncResult').innerHTML = `<span class="pill-accept">同步成功</span>
    接收日志 ${data.acceptedCount} 条${data.duplicate ? '（幂等重传）' : ''}｜
    下发增量 ${data.delta.length} 条｜新游标 <b>${data.cursor}</b>${data.hasMore ? '（仍有更多，请继续同步）' : ''}
    ${data.mustSyncBefore ? `｜<span class="pill-reject">须在 ${fmt(data.mustSyncBefore)} 前再次同步</span>` : ''}`;
  return data;
}

$('syncBtn').addEventListener('click', async () => {
  if (!state) return;
  // 游标落后时先空批次补拉增量，再上传（避免新批次因游标落后被拒）
  let probe;
  {
    const { status, data } = await api('/api/offline/sync', {
      deviceId: state.deviceId, keyVersion: state.keyVersion, cursor: state.cursor,
      batchId: crypto.randomUUID(), entries: [],
    }, state.token);
    if (status !== 200) {
      $('syncResult').innerHTML = `<span class="pill-reject">同步被拒绝：${esc(data.error?.message || data.error?.code)}</span>`;
      return;
    }
    probe = data;
    runtime.applySyncResponse(state, probe, { sentEntries: [] });
    persist();
  }
  await doSync(null);
  // 若仍有增量或待传日志，循环至收敛（受单批上限约束）
  let guard = 0;
  while ((runtime.pendingEntries(state).length > 0 || (probe && probe.hasMore)) && guard < 20) {
    const prev = runtime.pendingEntries(state).length;
    const r = await doSync(null);
    if (!r) break;
    probe = r;
    guard += 1;
    if (runtime.pendingEntries(state).length === prev && r.delta.length === 0) break;
  }
});

$('retryLastBtn').addEventListener('click', async () => {
  if (!lastBatch) { $('syncResult').textContent = '没有可重试的批次。'; return; }
  // 复用同一 batchId，内容不变 => 服务器幂等处理
  const { status, data } = await api('/api/offline/sync', lastBatch, state.token);
  if (status !== 200) {
    $('syncResult').innerHTML = `<span class="pill-reject">重试被拒绝：${esc(data.error?.message || data.error?.code || status)}</span>`;
    return;
  }
  runtime.applySyncResponse(state, data, { sentEntries: lastBatch.entries });
  persist();
  renderDevice();
  $('syncResult').innerHTML = `<span class="pill-accept">批次幂等重传成功</span>（接收 ${data.acceptedCount} 条，重复批次=${data.duplicate}）`;
});

// 启动时尝试恢复
(function init() {
  const raw = localStorage.getItem(LS_KEY);
  if (raw) {
    try {
      state = runtime.restoreState(raw);
      renderDevice();
    } catch {
      localStorage.removeItem(LS_KEY);
    }
  }
})();
