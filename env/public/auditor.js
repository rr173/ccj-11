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
    await loadObjections();
    await loadObjectionNotifications();
    await loadObjectionExtensions();
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

// ---------------------------------------------------------------------------
// 回执撤销异议：审计员可查看全部异议的完整（未脱敏）审计记录（只读）
// ---------------------------------------------------------------------------
const OBJECTION_STATUS_LABELS = {
  submitted: '待受理', accepted: '已受理', supplementing: '待补充材料',
  rejected: '已驳回', revoked: '已确认撤销',
};
const OBJECTION_EVENT_TEXT = {
  'receipt.objection.submitted': '发起异议',
  'receipt.objection.accepted': '受理',
  'receipt.objection.supplement-requested': '要求补充材料',
  'receipt.objection.supplemented': '办理人补充材料',
  'receipt.objection.rejected': '驳回',
  'receipt.objection.revocation-confirmed': '确认撤销',
};

async function loadObjections() {
  const result = await api('GET', '/api/auditor/receipt-objections');
  const list = $('#objectionList');
  if (!result.objections.length) {
    list.innerHTML = '<p class="muted">当前没有撤销异议记录。</p>';
    return;
  }
  list.innerHTML = result.objections.map((o) => `
    <div class="archive-item card-inner">
      <div class="record-main">
        <b class="mono">${escapeHtml(o.objectionNo)}</b>
        <span class="tag ${o.status === 'revoked' ? 'tag-reject' : o.status === 'rejected' ? 'tag-warn' : 'tag-ok'}">
          ${escapeHtml(OBJECTION_STATUS_LABELS[o.status] || o.status)}
        </span>
      </div>
      <div class="muted small">
        来源回执 <span class="mono">${escapeHtml(o.receiptNo)}</span>
        · 发起人：${escapeHtml(o.owner?.displayName || '—')}
        · 处理人：${escapeHtml(o.assignee?.displayName || '—')}
      </div>
      <div class="muted small">
        发起于 ${formatTime(o.createdAt)} · 处理期限至 ${formatTime(o.deadlineAt)}
        ${o.resolvedAt ? ` · 完结于 ${formatTime(o.resolvedAt)}` : ''}
        · 历史事件 ${o.eventCount} 条 · 文本材料 ${o.materialCount} 份
      </div>
      <div class="record-actions">
        <button class="button secondary" type="button" data-objection="${escapeHtml(o.objectionNo)}">查阅完整审计记录</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('[data-objection]').forEach((btn) => {
    btn.addEventListener('click', () => loadObjectionDetail(btn.dataset.objection));
  });
}

async function loadObjectionDetail(objectionNo) {
  const view = $('#objectionView');
  view.classList.remove('hidden');
  view.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  view.innerHTML = '<p class="muted">加载中…</p>';
  try {
    const { objection: o } = await api('GET', `/api/auditor/receipt-objections/${encodeURIComponent(objectionNo)}`);
    const stepsHtml = (o.fullSnapshot.steps || []).map((s, i) => `
      <div class="confirmation">
        <strong>${i + 1}. ${escapeHtml(s.title)}</strong>
        <div class="muted small">确认时间：${formatTime(s.confirmedAt)}</div>
        <pre class="archive-pre">${escapeHtml(JSON.stringify(s.data, null, 2))}</pre>
      </div>`).join('');
    const materialsHtml = (o.materials || []).map((m) => `
      <details class="material-box">
        <summary>${escapeHtml(m.filename)} · ${m.sizeBytes} 字节 ·
          ${m.uploadedByRole === 'handler' ? '办理人' : '处理人'}${m.uploadedBy ? `：${escapeHtml(m.uploadedBy)}` : ''} ·
          上传于 ${formatTime(m.uploadedAt)}${m.note ? ` · ${escapeHtml(m.note)}` : ''}</summary>
        <pre class="archive-pre">${escapeHtml(m.content || '')}</pre>
      </details>`).join('');
    const eventsHtml = (o.events || []).map((e) => `
      <li>
        <span class="mono small">${escapeHtml(OBJECTION_EVENT_TEXT[e.type] || e.type)}</span>
        <span class="muted small">${formatTime(e.at)} · ${e.actorRole === 'handler' ? '办理人' : e.actorRole === 'processor' ? '处理人' : escapeHtml(e.actorRole)}${e.actorName ? `：${escapeHtml(e.actorName)}` : ''}
          ${e.fromStatus ? ` · ${escapeHtml(OBJECTION_STATUS_LABELS[e.fromStatus] || e.fromStatus)} → ${escapeHtml(OBJECTION_STATUS_LABELS[e.toStatus] || e.toStatus)}` : ''}</span>
        ${e.reason ? `<div class="small">原因：${escapeHtml(e.reason)}</div>` : ''}
        ${e.note ? `<div class="small">备注：${escapeHtml(e.note)}</div>` : ''}
      </li>`).join('');
    view.innerHTML = `
      <h2>撤销异议完整审计记录 <span class="mono">${escapeHtml(o.objectionNo)}</span>
        <span class="tag ${o.status === 'revoked' ? 'tag-reject' : 'tag-ok'}">${escapeHtml(OBJECTION_STATUS_LABELS[o.status] || o.status)}</span></h2>
      <p class="muted small">
        来源回执 <span class="mono">${escapeHtml(o.receiptNo)}</span> · 原回执当前状态：${o.currentReceiptStatus === 'revoked' ? '已撤销' : '有效'}
        ${o.currentReceiptRevokedAt ? `（撤销于 ${formatTime(o.currentReceiptRevokedAt)}）` : ''}
        · 冻结快照 SHA-256：<span class="mono small">${escapeHtml(o.snapshotDigest)}</span>
      </p>
      <div class="small"><b>异议原因：</b>${escapeHtml(o.reason)}</div>
      <div class="small">发起人：${escapeHtml(o.owner?.displayName || '—')} · 处理人：${escapeHtml(o.assignee?.displayName || '—')}
        · 发起于 ${formatTime(o.createdAt)} · 处理期限至 ${formatTime(o.deadlineAt)}</div>
      <h3>冻结回执快照（完整未脱敏，提交异议瞬间冻结）</h3>
      ${stepsHtml}
      <h3>文本说明与补充材料（原文）</h3>
      ${materialsHtml || '<p class="muted small">无</p>'}
      <h3>处理历史（${(o.events || []).length} 条，只追加不可覆盖）</h3>
      <ol class="archive-events">${eventsHtml}</ol>`;
  } catch (error) {
    view.innerHTML = `<div class="alert error">${escapeHtml(error.message)}</div>`;
  }
}

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

// ---------------------------------------------------------------------------
// 异议通知留痕 / 延期审批：审计员只读完整记录
// ---------------------------------------------------------------------------
const NOTIF_KIND_TEXT = {
  reminder: '到期前提醒',
  overdue: '逾期升级',
  'extension-requested': '延期申请待审批',
  'extension-approved': '延期已批准',
  'extension-rejected': '延期已拒绝',
};
const NOTIF_AUDIENCE_TEXT = { processor: '处理人', handler: '办理人', supervisor: '主管' };
const EXT_STATUS_TEXT = { pending: '待主管审批', approved: '已批准', rejected: '已拒绝' };

$('#refreshNotifsBtn')?.addEventListener('click', loadObjectionNotifications);
$('#notifKindFilter')?.addEventListener('change', loadObjectionNotifications);
$('#notifAudienceFilter')?.addEventListener('change', loadObjectionNotifications);

async function loadObjectionNotifications() {
  const kind = $('#notifKindFilter')?.value || '';
  const audience = $('#notifAudienceFilter')?.value || '';
  const params = new URLSearchParams();
  if (kind) params.set('kind', kind);
  if (audience) params.set('audience', audience);
  const result = await api('GET', `/api/auditor/receipt-objection-notifications${params.size ? `?${params}` : ''}`);
  const list = $('#objectionNotificationList');
  if (!result.notifications.length) {
    list.innerHTML = '<p class="muted">暂无通知记录。</p>';
    return;
  }
  list.innerHTML = result.notifications.map((n) => `
    <div class="archive-item card-inner">
      <div class="record-main">
        <span class="tag ${n.kind === 'overdue' ? 'tag-reject' : n.kind === 'reminder' ? 'tag-warn' : 'tag-ok'}">
          ${escapeHtml(NOTIF_KIND_TEXT[n.kind] || n.kind)}
        </span>
        <b class="mono">${escapeHtml(n.objectionNo)}</b>
        <span class="muted small">接收：${escapeHtml(NOTIF_AUDIENCE_TEXT[n.audience] || n.audience)}${n.targetUser ? `（${escapeHtml(n.targetUser.displayName)}）` : '（按角色广播）'}</span>
      </div>
      <div class="muted small">
        来源回执 <span class="mono">${escapeHtml(n.receiptNo)}</span>
        · 异议状态：${escapeHtml(n.payload.statusLabel || n.payload.status)}
        · 截止：${formatTime(n.payload.deadlineAt)}
        ${n.level > 1 ? ` · 升级第 ${n.level} 层` : ''}
      </div>
      <div class="muted small">
        生成 ${formatTime(n.createdAt)}${n.sentAt ? ` · 发送 ${formatTime(n.sentAt)}` : ''}${n.readAt ? ` · 已读 ${formatTime(n.readAt)}${n.readBy ? `（${escapeHtml(n.readBy)}）` : ''}` : ''}
        · 去重键 <span class="mono">${escapeHtml(n.dedupeKey)}</span>
      </div>
      <details><summary class="muted small">通知内容（已脱敏）</summary>
        <pre class="archive-pre">${escapeHtml(JSON.stringify(n.payload, null, 2))}</pre>
      </details>
    </div>`).join('');
}

async function loadObjectionExtensions() {
  const result = await api('GET', '/api/auditor/receipt-objection-extensions');
  const list = $('#objectionExtensionList');
  if (!result.extensions.length) {
    list.innerHTML = '<p class="muted">暂无延期申请。</p>';
    return;
  }
  list.innerHTML = result.extensions.map((e) => `
    <div class="archive-item card-inner">
      <div class="record-main">
        <b class="mono">${escapeHtml(e.objectionNo)}</b>
        <span class="tag ${e.status === 'approved' ? 'tag-ok' : e.status === 'rejected' ? 'tag-reject' : 'tag-warn'}">
          ${escapeHtml(EXT_STATUS_TEXT[e.status] || e.status)}
        </span>
        <span class="muted small">来源回执 <span class="mono">${escapeHtml(e.receiptNo)}</span></span>
      </div>
      <div class="small">延期原因：${escapeHtml(e.reason)}</div>
      <div class="muted small">
        申请人：${escapeHtml(e.requestedBy?.displayName || '—')} · 申请于 ${formatTime(e.requestedAt)}
        · 顺延 ${Math.round(e.requestedDurationMs / 3600000)} 小时
      </div>
      <div class="muted small">
        原截止 ${formatTime(e.previousDeadlineAt)} → 当前截止 ${formatTime(e.currentDeadlineAt)}
      </div>
      ${e.decidedAt ? `<div class="small review-obj-result">${e.status === 'approved' ? '批准' : '拒绝'}（${formatTime(e.decidedAt)}，${escapeHtml(e.decidedBy?.displayName || '—')}）：${escapeHtml(e.decisionNote || '—')}</div>` : ''}
    </div>`).join('');
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
