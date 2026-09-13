const $ = (selector) => document.querySelector(selector);
const els = {
  validateView: $('#validateView'),
  reviewView: $('#reviewView'),
  validateForm: $('#validateForm'),
  validateError: $('#validateError'),
  alert: $('#reviewAlert'),
  status: $('#reviewStatus'),
  batchStatus: $('#batchStatus'),
  reviewerLabel: $('#reviewerLabel'),
  receiptNo: $('#receiptNo'),
  completedAt: $('#completedAt'),
  expiresAt: $('#expiresAt'),
  gateNotice: $('#gateNotice'),
  stageNotice: $('#stageNotice'),
  stageName: $('#stageName'),
  stageStatus: $('#stageStatus'),
  stageDeadline: $('#stageDeadline'),
  stageCountdown: $('#stageCountdown'),
  fields: $('#reviewFields'),
  opinionCard: $('#opinionCard'),
  objectionForm: $('#opinionForm'),
  objectionField: $('#opinionField'),
  objectionError: $('#objectionError'),
  mergedList: $('#mergedList'),
  exitBtn: $('#exitReview'),
};

let csrfToken = readCookie('bcsrf');
let context = null;
let submitting = false;
let pendingKey = null;
const FIELD_META = new Map();

document.addEventListener('DOMContentLoaded', boot);
els.validateForm.addEventListener('submit', validateInvitation);
els.objectionForm.addEventListener('submit', submitOpinion);
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
const BATCH_STATUS_TEXT = {
  collecting: '邀请校验中（尚未全部完成）',
  in_review: '复核中',
  completed: '已完成全部字段决议',
  cancelled: '已取消',
  timed_out: '已超时失败',
};
const STAGE_STATUS_TEXT = {
  pending: '未开始（前一阶段尚未完成）',
  active: '进行中',
  active_deadline_passed: '限时已到',
  deadline_passed: '限时已到',
  completed: '已完成',
  timed_out: '已超时',
  failed: '已失败',
};
const STAGE_POLICY_TEXT = {
  advance: '超时自动进入下一阶段（未决字段自动驳回）',
  revoke_unused: '超时撤销未使用邀请',
  fail: '超时标记批次失败',
};

let currentContext = null;
setInterval(() => {
  if (currentContext?.stage?.deadlineAt && currentContext.stage.isCurrent) {
    els.stageCountdown.textContent = formatRemaining(currentContext.stage.deadlineAt);
  }
}, 1000);
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
    showValidateError('请提供批次邀请令牌或完整邀请链接。');
    return;
  }
  try {
    const res = await fetch('/api/batch-review/validate', {
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
    history.replaceState(null, '', '/batch-review');
    await loadContext(true);
  } catch (error) {
    showValidateError(error.message || '网络错误，请稍后重试');
    showValidate();
  }
}

async function loadContext(forceEnter = false) {
  try {
    const res = await fetch('/api/batch-review/context', { headers: { Accept: 'application/json' } });
    if (!res.ok) {
      if (forceEnter) showValidateError((await res.json().catch(() => ({})))?.error?.message || '校验失败');
      showValidate();
      return false;
    }
    const data = await res.json();
    csrfToken = data.csrfToken || csrfToken;
    context = data.context;
    currentContext = context;
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

function renderReview() {
  if (!context) return showValidate();
  showReview();
  hideAlert();

  els.reviewerLabel.textContent = context.label || '复核人';
  els.batchStatus.textContent = BATCH_STATUS_TEXT[context.batchStatus] || context.batchStatus;
  els.receiptNo.textContent = context.receiptNo;
  els.completedAt.textContent = formatTime(context.completedAt);
  els.expiresAt.textContent = formatTime(context.expiresAt);

  // 当前阶段信息
  const stage = context.stage;
  if (stage) {
    els.stageName.textContent = `第 ${stage.ordinal + 1}/${stage.stageCount} 阶段 · ${stage.name}`;
    els.stageStatus.textContent = STAGE_STATUS_TEXT[stage.status] || stage.status;
    els.stageDeadline.textContent = stage.deadlineAt ? formatTime(stage.deadlineAt) : '—';
    els.stageCountdown.textContent = stage.isCurrent && stage.deadlineAt ? formatRemaining(stage.deadlineAt) : '—';
  } else {
    els.stageName.textContent = '—';
    els.stageStatus.textContent = '—';
    els.stageDeadline.textContent = '—';
    els.stageCountdown.textContent = '—';
  }

  if (context.status === 'revoked' || !context.view) {
    els.status.textContent = context.status === 'batch_timed_out' ? '批次已超时失败' : '回执已撤销';
    els.status.className = 'status-pill revoked';
    els.fields.innerHTML = `<div class="alert error">${context.status === 'batch_timed_out'
      ? '该批次的某个阶段超时并按“标记超时失败”策略终止；你此前已提交的意见仍原样留档。'
      : '该回执已被办理人撤销；你已提交意见的处理结果仍可在下方查看。'}</div>`;
    els.opinionCard.classList.add('hidden');
    els.stageNotice.classList.add('hidden');
    els.gateNotice.classList.add('hidden');
  } else if (context.stageLocked) {
    // 后续阶段：前序阶段未达终局，不能查看字段或提交意见
    els.status.textContent = '阶段尚未开放';
    els.status.className = 'status-pill revoked';
    els.fields.innerHTML = '';
    els.opinionCard.classList.add('hidden');
    els.stageNotice.textContent = `「${stage?.name || '该阶段'}」尚未开始：需等前一阶段达到终局条件后才开放校验、查看与提交。你已完成邀请校验，请等待办理人推进。`;
    els.stageNotice.classList.remove('hidden');
    els.gateNotice.classList.add('hidden');
  } else if (context.stageClosed) {
    els.status.textContent = '阶段已结束';
    els.status.className = 'status-pill revoked';
    renderFields();
    els.opinionCard.classList.add('hidden');
    els.stageNotice.textContent = `「${stage?.name || '该阶段'}」已结束（${STAGE_STATUS_TEXT[stage?.status] || ''}），结果已留档；不能再提交意见。`;
    els.stageNotice.classList.remove('hidden');
    els.gateNotice.classList.add('hidden');
  } else {
    els.status.textContent = '批次复核中（脱敏视图）';
    els.status.className = 'status-pill completed';
    els.stageNotice.classList.add('hidden');
    renderFields();
    if (context.canSubmit) {
      els.gateNotice.classList.add('hidden');
      els.opinionCard.classList.remove('hidden');
    } else {
      els.gateNotice.textContent = stage?.timeoutResult
        ? '该阶段限时已过，未使用邀请已按冻结策略撤销；提交通道已关闭，请等待办理人完成决议。'
        : '本阶段尚不能提交意见（邀请校验未完成或批次未在复核中），请稍后刷新页面。';
      els.gateNotice.classList.remove('hidden');
      els.opinionCard.classList.add('hidden');
    }
  }
  renderMerged();
}

function hideAlert() {
  els.alert.className = 'alert hidden';
  els.alert.textContent = '';
}

// 本邀请被授权的脱敏字段（未授权字段根本不出现在响应中）
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
        btn.textContent = '对该字段提意见';
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
  // 本人已提交过意见的字段不再出现在可提交下拉中
  const mineKeys = new Set((context.opinions || []).map((o) => o.key));
  for (const [key, meta] of FIELD_META) {
    if (mineKeys.has(key)) continue;
    const option = document.createElement('option');
    option.value = key;
    option.textContent = meta.label;
    els.objectionField.append(option);
  }
}

// 同一字段的多份意见合并展示，但逐字保留每位复核人的原始说明
function renderMerged() {
  const list = context.merged || [];
  els.mergedList.innerHTML = '';
  if (!list.length) {
    els.mergedList.innerHTML = '<p class="muted small">暂无可展示的字段意见。</p>';
    return;
  }
  list.forEach((item) => {
    const div = document.createElement('div');
    div.className = 'objection-item batch-merged';
    const decisionBadge = item.decision === 'accepted'
      ? '<span class="badge confirmed">办理人已接受</span>'
      : item.decision === 'rejected'
        ? '<span class="badge invalidated">办理人已驳回</span>'
        : '<span class="badge current">待决议</span>';
    const opinions = (item.opinions || []).map((op) => `
      <li class="batch-opinion ${op.mine ? 'mine' : ''}">
        <div class="record-main">
          <b>${escapeHtml(op.reviewerLabel)}</b>
          <span class="muted small">${formatTime(op.submittedAt)}${op.mine ? ' · 我的意见' : ''}</span>
        </div>
        <div>${escapeHtml(op.reason)}</div>
      </li>`).join('');
    let result = '';
    if (item.decision === 'accepted') {
      const corr = item.opinions.find((o) => o.correctionReceiptNo)?.correctionReceiptNo;
      result = corr
        ? `<div class="objection-result accepted">✓ 已接受并进入更正办理，新回执：<b class="mono">${escapeHtml(corr)}</b></div>`
        : '<div class="objection-result accepted">✓ 办理人已接受，更正办理进行中</div>';
    } else if (item.decision === 'rejected') {
      result = `<div class="objection-result rejected">✗ 办理人已驳回${item.decisionReason ? `，理由：${escapeHtml(item.decisionReason)}` : ''}</div>`;
    }
    div.innerHTML = `
      <div class="record-main">
        <b>${escapeHtml(item.label)}</b>
        ${decisionBadge}
      </div>
      <div class="muted small">
        接受阈值 ${item.acceptThreshold} · 驳回阈值 ${item.rejectThreshold} ·
        当前意见 ${item.opinionCount} 份${item.decidedAt ? ` · 决议于 ${formatTime(item.decidedAt)}` : ''}
      </div>
      <ul class="batch-opinion-list">${opinions || '<li class="muted small">该字段暂无人提出意见</li>'}</ul>
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
    showObjectionError('请先选择本邀请被授权的字段。');
    return;
  }
  if (reason.length < 2 || reason.length > 500) {
    showObjectionError('意见说明需为 2-500 个字符。');
    return;
  }
  submitting = true;
  const idempotencyKey = pendingKey || (pendingKey = randomId());
  try {
    const res = await api('/api/batch-review/opinions', { key, reason, idempotencyKey });
    pendingKey = null;
    els.objectionForm.reset();
    showAlert(res.replay ? '网络重试命中同一提交，未重复创建意见。' : '意见已提交。', res.replay ? 'warning' : 'success');
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
  try { await fetch('/api/batch-review/logout', { method: 'POST' }); } catch { /* ignore */ }
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
