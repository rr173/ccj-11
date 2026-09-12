const $ = (selector) => document.querySelector(selector);
const els = {
  validateView: $('#validateView'),
  reviewView: $('#reviewView'),
  validateForm: $('#validateForm'),
  validateError: $('#validateError'),
  alert: $('#reviewAlert'),
  status: $('#reviewStatus'),
  receiptNo: $('#receiptNo'),
  completedAt: $('#completedAt'),
  expiresAt: $('#expiresAt'),
  fields: $('#reviewFields'),
  objectionForm: $('#objectionForm'),
  objectionField: $('#objectionField'),
  objectionError: $('#objectionError'),
  objectionList: $('#objectionList'),
  exitBtn: $('#exitReview'),
};

let csrfToken = readCookie('rcsrf');
let context = null;
let submitting = false;

const FIELD_META = new Map();

document.addEventListener('DOMContentLoaded', boot);
els.validateForm.addEventListener('submit', validateInvitation);
els.objectionForm.addEventListener('submit', submitObjection);
els.exitBtn.addEventListener('click', exitReview);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}
function formatTime(epochMs) {
  if (!epochMs) return '—';
  return new Date(epochMs).toLocaleString('zh-CN', { hour12: false });
}

// 支持把“完整链接”粘贴进输入框：从中提取 t=…
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
    // 已有有效复核会话且就是该回执时，直接进入；否则先消费邀请（只能成功一次）
    if (!(await loadContext())) {
      await doValidate(urlToken);
    }
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
    showValidateError('请提供邀请令牌或完整邀请链接。');
    return;
  }
  try {
    const res = await fetch('/api/review/validate', {
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
    history.replaceState(null, '', '/review');
    await loadContext(true);
  } catch (error) {
    showValidateError(error.message || '网络错误，请稍后重试');
    showValidate();
  }
}

async function loadContext(forceEnter = false) {
  try {
    const res = await fetch('/api/review/context', { headers: { Accept: 'application/json' } });
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

function renderReview() {
  if (!context) return showValidate();
  showReview();
  hideAlert();

  els.receiptNo.textContent = context.receiptNo;
  els.completedAt.textContent = formatTime(context.completedAt);
  els.expiresAt.textContent = formatTime(context.expiresAt);

  if (context.status === 'revoked' || !context.view) {
    els.status.textContent = '回执已撤销';
    els.status.className = 'status-pill revoked';
    els.fields.innerHTML = '<div class="alert error">该回执已被办理人撤销，复核内容不再可查看；已提交异议的处理结果仍可在下方查看。</div>';
    els.objectionForm.classList.add('hidden');
  } else {
    els.status.textContent = '复核中（脱敏视图）';
    els.status.className = 'status-pill completed';
    els.objectionForm.classList.remove('hidden');
    renderFields();
  }
  renderObjections();
}

function renderFields() {
  els.fields.innerHTML = '';
  els.objectionField.innerHTML = '';
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
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link-button';
      btn.textContent = '对该字段提异议';
      btn.addEventListener('click', () => {
        els.objectionField.value = `${step.step}.${field.field}`;
        els.objectionForm.scrollIntoView({ behavior: 'smooth', block: 'center' });
        els.objectionForm.reason.focus();
      });
      td.append(btn);
      tr.append(td);
      table.append(tr);
      FIELD_META.set(`${step.step}.${field.field}`, { step: step.step, field: field.field, label: field.label });
      block.append(table);
    });
    els.fields.append(block);
  });

  const empty = document.createElement('option');
  empty.value = '';
  empty.textContent = '请选择字段';
  els.objectionField.append(empty);
  for (const [key, meta] of FIELD_META) {
    const option = document.createElement('option');
    option.value = key;
    option.textContent = meta.label;
    els.objectionField.append(option);
  }
}

function renderObjections() {
  const list = context.objections || [];
  els.objectionList.innerHTML = '';
  if (!list.length) {
    els.objectionList.innerHTML = '<li class="muted small">暂未提交异议。</li>';
    return;
  }
  list.forEach((item) => {
    const li = document.createElement('li');
    li.className = `objection-item ${item.status}`;
    let resultHtml = '';
    if (item.status === 'accepted') {
      const link = item.correctionReceiptNo
        ? `已进入更正办理，新回执编号：<b class="mono">${escapeHtml(item.correctionReceiptNo)}</b>`
        : '已接受，办理人正在进行更正办理';
      resultHtml = `<div class="objection-result accepted">✓ ${link}</div>`;
    } else if (item.status === 'rejected') {
      resultHtml = `<div class="objection-result rejected">✗ 办理人已驳回${item.resolveReason ? `，理由：${escapeHtml(item.resolveReason)}` : ''}</div>`;
    } else {
      resultHtml = '<div class="objection-result pending">待办理人处理</div>';
    }
    li.innerHTML = `
      <div class="objection-head">
        <b>${escapeHtml(item.fieldLabel)}</b>
        <span class="badge ${item.status === 'open' ? 'current' : item.status === 'accepted' ? 'confirmed' : 'invalidated'}">
          ${item.status === 'open' ? '待处理' : item.status === 'accepted' ? '已接受' : '已驳回'}
        </span>
      </div>
      <div class="muted small">提交于 ${formatTime(item.submittedAt)} · 提交时脱敏值：${escapeHtml(item.valueSnapshot || '—')}</div>
      <div class="objection-reason">${escapeHtml(item.reason)}</div>
      ${resultHtml}
      ${item.resolvedAt ? `<div class="muted small">处理时间：${formatTime(item.resolvedAt)}</div>` : ''}
    `;
    els.objectionList.append(li);
  });
}

async function submitObjection(event) {
  event.preventDefault();
  if (submitting) return;
  const meta = FIELD_META.get(els.objectionField.value);
  const reason = String(els.objectionForm.reason.value || '').trim();
  els.objectionError.classList.add('hidden');
  if (!meta) {
    showObjectionError('请先选择有异议的字段。');
    return;
  }
  if (reason.length < 2 || reason.length > 500) {
    showObjectionError('异议说明需为 2-500 个字符。');
    return;
  }
  submitting = true;
  const idempotencyKey = pendingKey || (pendingKey = randomId());
  try {
    const res = await api('/api/review/objections', {
      step: meta.step,
      field: meta.field,
      reason,
      idempotencyKey,
    });
    pendingKey = null;
    els.objectionForm.reset();
    showAlert(res.replay ? '网络重试命中同一提交，未重复创建异议。' : '异议已提交，办理人处理结果将显示在下方。', res.replay ? 'warning' : 'success');
    await loadContext();
  } catch (error) {
    showObjectionError(error.message || '提交失败，请稍后重试');
  } finally {
    submitting = false;
  }
}

let pendingKey = null;

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
  try { await fetch('/api/review/logout', { method: 'POST' }); } catch { /* ignore */ }
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
