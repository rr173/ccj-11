const $ = (selector) => document.querySelector(selector);
const els = {
  validateView: $('#validateView'),
  reviewView: $('#reviewView'),
  validateForm: $('#validateForm'),
  validateError: $('#validateError'),
  alert: $('#reviewAlert'),
  status: $('#reviewStatus'),
  roundStatus: $('#roundStatus'),
  reviewerLabel: $('#reviewerLabel'),
  receiptNo: $('#receiptNo'),
  deadlineAt: $('#deadlineAt'),
  expiresAt: $('#expiresAt'),
  gateNotice: $('#gateNotice'),
  fields: $('#reviewFields'),
  opinionCard: $('#opinionCard'),
  objectionForm: $('#opinionForm'),
  objectionField: $('#opinionField'),
  objectionError: $('#opinionError'),
  mergedList: $('#mergedList'),
  exitBtn: $('#exitReview'),
};

const VALIDATE_PATH = '/api/arbitration-review/validate';
const CONTEXT_PATH = '/api/arbitration-review/context';
const OPINIONS_PATH = '/api/arbitration-review/opinions';
const LOGOUT_PATH = '/api/arbitration-review/logout';
const CSRF_COOKIE = 'accsrf2';

let csrfToken = readCookie(CSRF_COOKIE);
let context = null;
let submitting = false;
let pendingKey = null;
const FIELD_META = new Map();

document.addEventListener('DOMContentLoaded', boot);
els.validateForm.addEventListener('submit', validateInvitation);
els.objectionForm.addEventListener('submit', submitOpinion);
els.exitBtn.addEventListener('click', exitReview);

setInterval(() => {
  if (context?.deadlineAt) $('#countdown').textContent = formatRemaining(context.deadlineAt);
}, 1000);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}
function formatTime(epochMs) {
  if (!epochMs) return '—';
  return new Date(epochMs).toLocaleString('zh-CN', { hour12: false });
}
function formatRemaining(deadline) {
  const ms = Math.max(0, deadline - Date.now());
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (ms <= 0) return '已到限时';
  return h > 0 ? `${h} 小时 ${m} 分 ${s} 秒` : m > 0 ? `${m} 分 ${s} 秒` : `${s} 秒`;
}
function extractToken(input) {
  const text = String(input || '').trim();
  const m = /[?&]t=([A-Za-z0-9_\-]+)/.exec(text);
  return m ? decodeURIComponent(m[1]) : text;
}

async function boot() {
  const params = new URLSearchParams(location.search);
  const urlToken = params.get('t');
  if (urlToken) {
    els.validateForm.token.value = urlToken;
    if (!(await loadContext())) await doValidate(urlToken);
    return;
  }
  await loadContext();
}

async function validateInvitation(event) {
  event.preventDefault();
  await doValidate(extractToken(els.validateForm.token.value));
}

async function doValidate(token) {
  hideValidateError();
  if (!token) { showValidateError('请提供仲裁邀请令牌或完整邀请链接。'); return; }
  try {
    const res = await fetch(VALIDATE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      showValidateError(data?.error?.message || `邀请校验失败（${res.status}）`);
      showValidate();
      return;
    }
    csrfToken = data.csrfToken;
    history.replaceState(null, '', '/arbitration-review');
    await loadContext(true);
  } catch (error) {
    showValidateError(error.message || '网络错误，请稍后重试');
    showValidate();
  }
}

async function loadContext(forceEnter = false) {
  try {
    const res = await fetch(CONTEXT_PATH, { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      if (forceEnter) showValidateError((await res.json().catch(() => ({})))?.error?.message || '校验失败');
      showValidate();
      return false;
    }
    const data = await res.json();
    csrfToken = data.csrfToken || csrfToken;
    context = data.context;
    renderReview();
    return true;
  } catch {
    showValidate();
    return false;
  }
}

function showValidate() { els.validateView.classList.remove('hidden'); els.reviewView.classList.add('hidden'); }
function showReview() { els.validateView.classList.add('hidden'); els.reviewView.classList.remove('hidden'); }
function showValidateError(message) { els.validateError.textContent = message; els.validateError.classList.remove('hidden'); }
function hideValidateError() { els.validateError.textContent = ''; els.validateError.classList.add('hidden'); }
function showAlert(message, type = 'error') { els.alert.className = `alert ${type}`; els.alert.textContent = message; }

const STATUS_TEXT = {
  mediating: '第一层调解中（仲裁尚未开放）',
  arbitrating: '第二层仲裁中',
  completed: '已完成全部处理',
  cancelled: '已取消',
  expired: '第一层超时终结',
  failed: '第二层超时失败',
};

function renderReview() {
  if (!context) return showValidate();
  showReview();
  els.reviewerLabel.textContent = context.label || '仲裁人';
  els.roundStatus.textContent = STATUS_TEXT[context.packageStatus || context.status] || context.packageStatus;
  els.receiptNo.textContent = context.receiptNo;
  els.deadlineAt.textContent = formatTime(context.deadlineAt);
  els.expiresAt.textContent = formatTime(context.expiresAt);
  $('#countdown').textContent = context.deadlineAt ? formatRemaining(context.deadlineAt) : '—';

  if (context.status === 'revoked' || !context.view) {
    els.status.textContent = context.status === 'revoked' ? '回执已撤销' : '调解包已关闭';
    els.status.className = 'status-pill revoked';
    els.fields.innerHTML = `<div class="alert error">${
      context.status === 'revoked'
        ? '该回执已被办理人撤销。'
        : context.packageStatus === 'cancelled'
          ? '该调解包已被办理人取消，写操作已关闭；你此前提交的意见仍原样留档。'
          : '调解包已超时终结，写操作已关闭；你此前提交的意见仍原样留档。'
    }</div>`;
    els.opinionCard.classList.add('hidden');
    els.gateNotice.classList.add('hidden');
  } else {
    els.status.textContent = '第二层仲裁（脱敏视图）';
    els.status.className = 'status-pill completed';
    renderFields();
    if (context.canSubmit) {
      els.gateNotice.classList.add('hidden');
      els.opinionCard.classList.remove('hidden');
    } else {
      els.gateNotice.textContent = '本层限时已到或已结束，不能再提交仲裁意见。';
      els.gateNotice.classList.remove('hidden');
      els.opinionCard.classList.add('hidden');
    }
  }
  renderMerged();
}

function renderFields() {
  els.fields.innerHTML = '';
  FIELD_META.clear();
  context.view.steps.forEach((step) => {
    const block = document.createElement('section');
    block.className = 'confirmation review-step';
    block.innerHTML = `<strong>${escapeHtml(step.title)}</strong>`;
    const table = document.createElement('table');
    table.className = 'kv-table review-table';
    step.fields.forEach((field) => {
      const value = field.kind === 'boolean' ? (field.value ? '已勾选确认' : '未勾选') : (field.value || '—');
      const tr = document.createElement('tr');
      tr.innerHTML = `<th>${escapeHtml(field.label)}${field.masked ? ' <span class="mask-tag">已脱敏</span>' : ''}</th><td>${escapeHtml(value)}</td>`;
      const td = document.createElement('td');
      td.className = 'review-cell-action';
      if (context.canSubmit) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'link-button';
        btn.textContent = '对该字段提仲裁意见';
        btn.addEventListener('click', () => {
          els.objectionField.value = field.key;
          els.objectionForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
          els.objectionForm.reason.focus();
        });
        td.append(btn);
      }
      tr.append(td);
      table.append(tr);
      FIELD_META.set(field.key, { key: field.key, label: field.label });
    });
    block.append(table);
    els.fields.append(block);
  });

  els.objectionField.innerHTML = '';
  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '请选择字段';
  els.objectionField.append(empty);
  const mineKeys = new Set((context.opinions || []).map((o) => o.key));
  for (const [key, meta] of FIELD_META) {
    if (mineKeys.has(key)) continue;
    const option = document.createElement('option');
    option.value = key;
    option.textContent = meta.label;
    els.objectionField.append(option);
  }
}

function renderMerged() {
  const list = context.merged || [];
  els.mergedList.innerHTML = '';
  if (!list.length) {
    els.mergedList.innerHTML = '<p class="muted small">暂无可展示的仲裁字段。</p>';
    return;
  }
  list.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'objection-item batch-merged';
    const decisionBadge = item.decision === 'accepted'
      ? '<span class="badge confirmed">仲裁终局：接受</span>'
      : item.decision === 'rejected'
        ? '<span class="badge invalidated">仲裁终局：驳回</span>'
        : '<span class="badge current">待第二层仲裁决议</span>';
    const opinions = (item.opinions || []).map((op) => `
      <li class="batch-opinion ${op.mine ? 'mine' : ''}">
        <div class="record-main">
          <b>${escapeHtml(op.reviewerLabel)}</b>
          <span class="muted small">${formatTime(op.submittedAt)}${op.mine ? ' · 我的意见' : ''}</span>
        </div>
        <div>${escapeHtml(op.reason)}</div>
      </li>`).join('');

    // 第一层允许披露的结论摘要（聚合结论，不含第一层调解人身份与逐字意见）
    const summary = item.layer1Summary;
    const summaryHtml = summary ? `
      <div class="appeal-evidence">
        <div class="muted small"><b>第一层结论摘要</b>${summary.layer1DecidedByPolicy ? '（按第一层冻结策略自动驳回）' : ''}</div>
        <div class="small">第一层决议：${summary.layer1Decision === 'rejected' ? '驳回' : '接受'}
          · 第一层意见 ${summary.layer1OpinionCount} 份
          · 接受阈值 ${summary.layer1AcceptedThreshold} · 驳回阈值 ${summary.layer1RejectedThreshold}
        </div>
        ${summary.layer1RejectedReason ? `<div class="small">第一层驳回理由：${escapeHtml(summary.layer1RejectedReason)}</div>` : ''}
      </div>` : '';

    const evidence = (item.evidence || []).map((ev) => `
      <li class="batch-opinion evidence-opinion">
        <div class="record-main"><b>${escapeHtml(ev.alias)}</b>
          <span class="muted small">选中证据 · ${formatTime(ev.originalSubmittedAt)}</span></div>
        ${ev.valueSnapshot ? `<div class="muted small">当时脱敏值：${escapeHtml(ev.valueSnapshot)}</div>` : ''}
        <div class="small">${escapeHtml(ev.reason)}</div>
      </li>`).join('');
    const evidenceHtml = `
      <div class="appeal-evidence">
        <div class="muted small"><b>允许查看的选中证据</b>（${item.evidence.length} 条；原复核人已匿名）</div>
        <ul class="batch-opinion-list">${evidence || '<li class="muted small">办理人未为该字段选择证据。</li>'}</ul>
      </div>`;

    let result = '';
    if (item.decision === 'accepted') {
      result = item.correctionReceiptNo
        ? `<div class="objection-result accepted">✓ 仲裁接受并进入更正办理，新回执：<b class="mono">${escapeHtml(item.correctionReceiptNo)}</b></div>`
        : '<div class="objection-result accepted">✓ 仲裁接受，更正办理进行中</div>';
    } else if (item.decision === 'rejected') {
      const policy = item.decidedByPolicy ? '（按本层冻结的超时策略自动驳回）' : '';
      result = `<div class="objection-result rejected">✗ 仲裁驳回${policy}${item.decisionReason ? `，理由：${escapeHtml(item.decisionReason)}` : ''}</div>`;
    }
    div.innerHTML = `
      <div class="record-main"><b>${escapeHtml(item.label)}</b>${decisionBadge}</div>
      <div class="muted small">
        接受阈值 ${item.acceptThreshold} · 驳回阈值 ${item.rejectThreshold} ·
        当前仲裁意见 ${item.opinionCount} 份${item.decidedAt ? ` · 终局于 ${formatTime(item.decidedAt)}` : ''}
      </div>
      ${summaryHtml}
      ${evidenceHtml}
      <ul class="batch-opinion-list">${opinions || '<li class="muted small">该字段暂无仲裁人意见</li>'}</ul>
      ${result}`;
    els.mergedList.append(div);
  });
}

async function submitOpinion(event) {
  event.preventDefault();
  if (submitting) return;
  const key = els.objectionField.value;
  const reason = String(els.objectionForm.reason.value || '').trim();
  els.objectionError.classList.add('hidden');
  if (!key || !FIELD_META.has(key)) { showObjectionError('请先选择本邀请被授权的仲裁字段。'); return; }
  if (reason.length < 2 || reason.length > 500) { showObjectionError('意见说明需为 2-500 个字符。'); return; }
  submitting = true;
  const idempotencyKey = pendingKey || (pendingKey = randomId());
  try {
    const res = await fetch(OPINIONS_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken || '' },
      body: JSON.stringify({ key, reason, idempotencyKey }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) throw new Error(data?.error?.message || `请求失败（${res.status}）`);
    pendingKey = null;
    els.objectionForm.reset();
    showAlert(data.replay ? '网络重试命中同一提交，未重复创建意见。' : '仲裁意见已提交。', data.replay ? 'warning' : 'success');
    await loadContext();
  } catch (error) {
    showObjectionError(error.message || '提交失败，请稍后重试');
  } finally {
    submitting = false;
  }
}

function showObjectionError(message) { els.objectionError.textContent = message; els.objectionError.classList.remove('hidden'); }

async function exitReview() {
  try { await fetch(LOGOUT_PATH, { method: 'POST' }); } catch { /* ignore */ }
  context = null;
  csrfToken = null;
  showValidate();
}

function readCookie(name) {
  return document.cookie.split('; ').reduce((value, part) => part.startsWith(`${name}=`) ? decodeURIComponent(part.slice(name.length + 1)) : value, '');
}
function randomId() {
  return crypto.getRandomValues(new Uint8Array(24)).reduce((out, byte) => out + byte.toString(16).padStart(2, '0'), '');
}
