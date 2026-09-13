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
  reasonSummary: $('#reasonSummary'),
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

let csrfToken = readCookie('accsrf');
let context = null;
let submitting = false;
let pendingKey = null;
const FIELD_META = new Map();

document.addEventListener('DOMContentLoaded', boot);
els.validateForm.addEventListener('submit', validateInvitation);
els.objectionForm.addEventListener('submit', submitOpinion);
els.exitBtn.addEventListener('click', exitReview);

setInterval(() => {
  if (context?.deadlineAt) {
    $('#countdown').textContent = formatRemaining(context.deadlineAt);
  }
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
  if (!token) {
    showValidateError('请提供申诉邀请令牌或完整邀请链接。');
    return;
  }
  try {
    const res = await fetch('/api/appeal-review/validate', {
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
    history.replaceState(null, '', '/appeal-review');
    await loadContext(true);
  } catch (error) {
    showValidateError(error.message || '网络错误，请稍后重试');
    showValidate();
  }
}

async function loadContext(forceEnter = false) {
  try {
    const res = await fetch('/api/appeal-review/context', { headers: { Accept: 'application/json' } });
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

function showValidate() {
  els.validateView.classList.remove('hidden');
  els.reviewView.classList.add('hidden');
}
function showReview() {
  els.validateView.classList.add('hidden');
  els.reviewView.classList.remove('hidden');
}
function showValidateError(message) {
  els.validateError.textContent = message;
  els.validateError.classList.remove('hidden');
}
function hideValidateError() {
  els.validateError.textContent = '';
  els.validateError.classList.add('hidden');
}
function showAlert(message, type = 'error') {
  els.alert.className = `alert ${type}`;
  els.alert.textContent = message;
}
function hideAlert() {
  els.alert.className = 'alert hidden';
  els.alert.textContent = '';
}

const ROUND_STATUS_TEXT = {
  collecting: '邀请校验中（尚未全部完成）',
  in_review: '申诉评议中',
  completed: '已完成全部字段决议',
  cancelled: '已取消',
  expired: '已过期',
};

function renderReview() {
  if (!context) return showValidate();
  showReview();
  hideAlert();

  els.reviewerLabel.textContent = context.label || '新复核人';
  els.roundStatus.textContent = ROUND_STATUS_TEXT[context.roundStatus || context.status] || context.roundStatus || context.status;
  els.reasonSummary.textContent = context.reasonSummary || '—';
  els.receiptNo.textContent = context.receiptNo;
  els.deadlineAt.textContent = formatTime(context.deadlineAt);
  els.expiresAt.textContent = formatTime(context.expiresAt);
  $('#countdown').textContent = context.deadlineAt ? formatRemaining(context.deadlineAt) : '—';

  if (context.status === 'revoked' || !context.view) {
    els.status.textContent = context.status === 'revoked' ? '回执已撤销' : '申诉回合已关闭';
    els.status.className = 'status-pill revoked';
    els.fields.innerHTML = `<div class="alert error">${
      context.status === 'revoked'
        ? '该回执已被办理人撤销。'
        : context.status === 'cancelled'
          ? '该申诉回合已被办理人取消，写操作已关闭；你此前提交的意见仍原样留档。'
          : '该申诉回合限时已过，写操作已关闭；你此前提交的意见仍原样留档。'
    }</div>`;
    els.opinionCard.classList.add('hidden');
    els.gateNotice.classList.add('hidden');
  } else {
    els.status.textContent = '申诉评议（脱敏视图）';
    els.status.className = 'status-pill completed';
    renderFields();
    if (context.canSubmit) {
      els.gateNotice.classList.add('hidden');
      els.opinionCard.classList.remove('hidden');
    } else {
      els.gateNotice.textContent = context.collecting
        ? '本回合邀请尚未全部完成校验，暂不能提交意见，请稍后刷新页面。'
        : '本回合限时已到或已结束，不能再提交意见，请等待办理人完成决议。';
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
        btn.textContent = '对该字段提申诉意见';
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
      block.append(table);
    });
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
    els.mergedList.innerHTML = '<p class="muted small">暂无可展示的申诉字段。</p>';
    return;
  }
  list.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'objection-item batch-merged';
    const decisionBadge = item.decision === 'accepted'
      ? '<span class="badge confirmed">办理人已接受申诉</span>'
      : item.decision === 'rejected'
        ? '<span class="badge invalidated">申诉被驳回</span>'
        : '<span class="badge current">待决议</span>';
    const opinions = (item.opinions || []).map((op) => `
      <li class="batch-opinion ${op.mine ? 'mine' : ''}">
        <div class="record-main">
          <b>${escapeHtml(op.reviewerLabel)}</b>
          <span class="muted small">${formatTime(op.submittedAt)}${op.mine ? ' · 我的意见' : ''}</span>
        </div>
        <div>${escapeHtml(op.reason)}</div>
      </li>`).join('');

    // 原字段既有驳回决议（只能看到被授权字段的）
    const original = item.originalDecision;
    const originalHtml = original ? `
      <div class="appeal-evidence">
        <div class="muted small"><b>原复核既有决议：驳回</b>${original.decidedByPolicy ? '（按阶段超时策略自动驳回）' : ''}${original.decidedAt ? ` · ${formatTime(original.decidedAt)}` : ''}</div>
        ${original.reason ? `<div class="small">驳回理由：${escapeHtml(original.reason)}</div>` : ''}
      </div>` : '';

    // 允许披露的证据摘要：原复核人匿名化，逐字保留说明
    const evidence = (item.evidence || []).map((ev) => `
      <li class="batch-opinion evidence-opinion">
        <div class="record-main">
          <b>${escapeHtml(ev.alias)}</b>
          <span class="muted small">原复核证据 · ${formatTime(ev.originalSubmittedAt)}</span>
        </div>
        ${ev.valueSnapshot ? `<div class="muted small">当时脱敏值：${escapeHtml(ev.valueSnapshot)}</div>` : ''}
        <div class="small">${escapeHtml(ev.reason)}</div>
      </li>`).join('');
    const evidenceHtml = `
      <div class="appeal-evidence">
        <div class="muted small"><b>允许查看的原复核证据</b>（${item.evidence.length} 条；原复核人已匿名）</div>
        <ul class="batch-opinion-list">${evidence || '<li class="muted small">办理人未授权披露该字段的原复核证据。</li>'}</ul>
      </div>`;

    let result = '';
    if (item.decision === 'accepted') {
      result = item.correctionReceiptNo
        ? `<div class="objection-result accepted">✓ 申诉已接受并进入更正办理，新回执：<b class="mono">${escapeHtml(item.correctionReceiptNo)}</b></div>`
        : '<div class="objection-result accepted">✓ 申诉已接受，更正办理进行中</div>';
    } else if (item.decision === 'rejected') {
      result = `<div class="objection-result rejected">✗ 申诉被驳回${item.decisionReason ? `，理由：${escapeHtml(item.decisionReason)}` : ''}</div>`;
    }
    div.innerHTML = `
      <div class="record-main">
        <b>${escapeHtml(item.label)}</b>
        ${decisionBadge}
      </div>
      <div class="muted small">
        申诉理由：${escapeHtml(item.appealReason)} · 接受阈值 ${item.acceptThreshold} · 驳回阈值 ${item.rejectThreshold} ·
        当前申诉意见 ${item.opinionCount} 份${item.decidedAt ? ` · 决议于 ${formatTime(item.decidedAt)}` : ''}
      </div>
      ${originalHtml}
      ${evidenceHtml}
      <ul class="batch-opinion-list">${opinions || '<li class="muted small">该字段暂无新复核人意见</li>'}</ul>
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
  if (!key || !FIELD_META.has(key)) {
    showObjectionError('请先选择本邀请被授权的申诉字段。');
    return;
  }
  if (reason.length < 2 || reason.length > 500) {
    showObjectionError('意见说明需为 2-500 个字符。');
    return;
  }
  submitting = true;
  const idempotencyKey = pendingKey || (pendingKey = randomId());
  try {
    const res = await api('/api/appeal-review/opinions', { key, reason, idempotencyKey });
    pendingKey = null;
    els.objectionForm.reset();
    showAlert(res.replay ? '网络重试命中同一提交，未重复创建意见。' : '申诉意见已提交。', res.replay ? 'warning' : 'success');
    await loadContext();
  } catch (error) {
    showObjectionError(error.message || '提交失败，请稍后重试');
  } finally {
    submitting = false;
  }
}

function showObjectionError(message) {
  els.objectionError.textContent = message;
  els.objectionError.classList.remove('hidden');
}

async function api(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-CSRF-Token': csrfToken || '' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error?.message || `请求失败（${res.status}）`);
  return data;
}

async function exitReview() {
  try { await fetch('/api/appeal-review/logout', { method: 'POST' }); } catch { /* ignore */ }
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
