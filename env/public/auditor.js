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
    await loadComparisons();
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

// 比较报告：只有同时被两个版本授权时才出现在列表中；条目按归档脱敏规则处理
const COMPARE_STATUS_TEXT = {
  added: '新增', deleted: '删除', modified: '修改', unchanged: '未变化', unaligned: '无法对齐',
};
async function loadComparisons() {
  const result = await api('GET', '/api/auditor/comparisons');
  const list = $('#comparisonList');
  if (!result.comparisons.length) {
    list.innerHTML = '<p class="muted">当前没有同时授权给本审计员账号两个版本的比较报告。</p>';
    return;
  }
  list.innerHTML = result.comparisons.map((c) => `
    <div class="archive-item card-inner">
      <div class="record-main">
        <b>比较报告 ${escapeHtml(c.comparisonNo)}</b>
        <span class="mono small">v${c.base.version} ⇄ v${c.target.version}</span>
        ${c.verification?.reportOk ? '<span class="tag tag-ok">报告校验通过</span>' : '<span class="tag tag-reject">报告校验失败</span>'}
      </div>
      <div class="muted small">生成于 ${formatTime(c.createdAt)} ·
        新增 ${c.counts.added} · 删除 ${c.counts.deleted} · 修改 ${c.counts.modified} · 未变化 ${c.counts.unchanged} · 无法对齐 ${c.counts.unaligned}</div>
      <div class="record-actions">
        <button class="button secondary" type="button" data-compare="${escapeHtml(c.id)}">查阅脱敏比较内容</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-compare]').forEach((btn) => {
    btn.addEventListener('click', () => loadComparisonDetail(btn.dataset.compare));
  });
}

async function loadComparisonDetail(comparisonId) {
  const view = $('#comparisonView');
  view.classList.remove('hidden');
  view.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  view.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const { comparison: c } = await api('GET', `/api/auditor/comparisons/${comparisonId}`);
    const statusDiff = c.statusSummaryDiff || { changes: [] };
    const provenance = c.provenanceDiff || {};
    view.innerHTML = `
      <h2>比较报告 ${escapeHtml(c.comparisonNo)}
        ${c.verification?.reportOk ? '<span class="tag tag-ok">报告校验通过</span>' : '<span class="tag tag-reject">报告校验失败</span>'}</h2>
      <p class="muted small">基准 v${c.base.version}（${escapeHtml(c.base.archiveNo)}）⇄ 目标 v${c.target.version}（${escapeHtml(c.target.archiveNo)}）·
        报告摘要 <span class="mono">${escapeHtml(c.digest)}</span></p>
      <div class="small ${c.verification?.reportOk ? 'tag-ok-text' : 'tag-reject-text'}">
        基准摘要链 ${c.verification?.baseChain?.continuous ? '连续' : '失效'} ·
        目标摘要链 ${c.verification?.targetChain?.continuous ? '连续' : '失效'}
      </div>
      <h3>来源关系差异</h3>
      <div class="small">${provenance.same ? '两版来源关系一致' : `新增 ${provenance.added?.length || 0} 条 / 移除 ${provenance.removed?.length || 0} 条`}</div>
      <h3>状态摘要差异（${statusDiff.changes?.length || 0} 个字段，已脱敏）</h3>
      ${(statusDiff.changes || []).length ? `<table class="diff-table small">
        <tr><th>字段</th><th>基准</th><th>目标</th></tr>
        ${(statusDiff.changes || []).map((d) => `<tr><td class="mono">${escapeHtml(d.field)}</td><td>${escapeHtml(JSON.stringify(d.from))}</td><td>${escapeHtml(JSON.stringify(d.to))}</td></tr>`).join('')}
      </table>` : '<p class="muted small">无变化</p>'}
      <h3>事件差异顺序（${c.entries.length}，不含重放意见）</h3>
      <ol class="archive-events">
        ${c.entries.map((e) => `
          <li class="compare-entry compare-${e.status}">
            <span class="tag ${e.status === 'added' ? 'tag-ok' : e.status === 'deleted' || e.status === 'unaligned' ? 'tag-reject' : e.status === 'modified' ? 'tag-warn' : 'tag-muted'}">${COMPARE_STATUS_TEXT[e.status] || e.status}</span>
            <span class="mono small">${escapeHtml(e.target?.type || e.base?.type || '')}</span>
            <span class="muted small">基准 #${e.base?.ordinal ?? '—'} → 目标 #${e.target?.ordinal ?? '—'}</span>
            ${e.reason ? `<div class="tag-reject-text small">${escapeHtml(e.reason)}</div>` : ''}
          </li>`).join('')}
      </ol>`;
  } catch (error) {
    view.innerHTML = `<div class="alert error">${escapeHtml(error.message)}</div>`;
  }
}
