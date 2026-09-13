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
    if (result.user.role !== 'auditor') {
      $('#loginError').textContent = '该账号不是审计员角色，请使用 auditor 角色账号登录本页面';
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

async function boot(knownUser = null) {
  try {
    const state = await api('GET', '/api/state');
    if (state.user.role !== 'auditor') {
      $('#loginView').classList.remove('hidden');
      $('#appView').classList.add('hidden');
      return;
    }
    $('#userName').textContent = state.user.displayName;
    $('#loginView').classList.add('hidden');
    $('#appView').classList.remove('hidden');
    await loadArchives();
  } catch (error) {
    $('#loginView').classList.remove('hidden');
    $('#appView').classList.add('hidden');
  }
}

async function loadArchives() {
  const result = await api('GET', '/api/auditor/archives');
  const list = $('#archiveList');
  if (!result.archives.length) {
    list.innerHTML = '<p class="muted">当前没有授权给本审计员账号的归档（授权以每份归档创建瞬间的权限快照为准）。</p>';
    return;
  }
  list.innerHTML = result.archives.map((a) => `
    <div class="archive-item card-inner">
      <div class="record-main">
        <b>${escapeHtml(a.sourceTypeLabel)}归档 v${a.version}</b>
        <span class="mono small">${escapeHtml(a.archiveNo)}</span>
        ${a.chain?.continuous ? '<span class="tag tag-ok">摘要链连续</span>' : '<span class="tag tag-reject">摘要链校验失败</span>'}
      </div>
      <div class="muted small">
        冻结于 ${formatTime(a.frozenAt)} · 事件 ${a.eventCount} 条（${formatTime(a.firstEventAt)} ～ ${formatTime(a.lastEventAt)}）
      </div>
      <div class="record-actions">
        <button class="button secondary" type="button" data-detail="${escapeHtml(a.id)}">查阅脱敏视图</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-detail]').forEach((btn) => {
    btn.addEventListener('click', () => loadDetail(btn.dataset.detail));
  });
}

async function loadDetail(archiveId) {
  const view = $('#detailView');
  view.classList.remove('hidden');
  view.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  view.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const result = await api('GET', `/api/auditor/archives/${archiveId}`);
    const a = result.archive;
    view.innerHTML = `
      <h2>${escapeHtml(a.sourceTypeLabel)}归档 v${a.version}
        ${a.chain.continuous ? '<span class="tag tag-ok">摘要链连续</span>' : '<span class="tag tag-reject">摘要链校验失败</span>'}</h2>
      <p class="muted small">归档号 <span class="mono">${escapeHtml(a.archiveNo)}</span> ·
        冻结于 ${formatTime(a.frozenAt)} · 权限快照时间 ${formatTime(a.grantFrozenAt)}</p>

      <h3>最终状态（脱敏）</h3>
      <pre class="archive-pre">${escapeHtml(JSON.stringify(a.statusSummary, null, 2))}</pre>

      <h3>来源关系（${a.provenance.length}）</h3>
      <ul>${a.provenance.map((p) => `<li class="mono small">${escapeHtml(p.from)} → ${escapeHtml(p.to)}（${escapeHtml(p.relation)}）</li>`).join('') || '<li class="muted">无</li>'}</ul>

      <h3>摘要链校验</h3>
      <div class="small">连续：<b>${a.chain.continuous ? '是' : '否'}</b>；校验时间：${formatTime(a.chain.checkedAt)}
        ${a.chain.broken ? `；断点：第 ${a.chain.broken.ordinal} 条事件（${escapeHtml(a.chain.broken.reason)}）` : ''}</div>
      <div class="mono small">最终摘要：${escapeHtml(a.finalHash)}</div>

      <h3>脱敏事件（${a.events.length}）</h3>
      <p class="muted small">操作人统一只显示角色（不显示身份）；逐字意见、理由、标签等字段已按归档创建时冻结的脱敏规则剥离或遮罩。</p>
      <ol class="archive-events">
        ${a.events.map((e) => `
          <li>
            <span class="mono small">${escapeHtml(e.type)}</span>
            <span class="muted small">${formatTime(e.occurredAt)} · 角色：${escapeHtml(e.actor.role)}</span>
            <details><summary class="muted small">脱敏事件负载 / 摘要</summary>
              <pre class="archive-pre">${escapeHtml(JSON.stringify(e.detail, null, 2))}</pre>
              <div class="mono small">hash: ${escapeHtml(e.hash)}</div>
            </details>
          </li>`).join('')}
      </ol>`;
  } catch (error) {
    view.innerHTML = `<div class="alert error">${escapeHtml(error.message)}</div>`;
  }
}

boot();
