const STEP_FORMS = [
  {
    key: 'applicant',
    title: '申请人信息',
    fields: [
      { name: 'name', label: '姓名', type: 'text', required: true, placeholder: '张三' },
      { name: 'idNumber', label: '证件号码', type: 'text', required: true, placeholder: '6-30 位字母、数字或连字符' },
      { name: 'phone', label: '手机号', type: 'tel', required: true, placeholder: '13800000000' },
    ],
  },
  {
    key: 'address',
    title: '联系地址',
    fields: [
      { name: 'province', label: '省份', type: 'text', required: true },
      { name: 'city', label: '城市', type: 'text', required: true },
      { name: 'detail', label: '详细地址', type: 'textarea', required: true },
    ],
  },
  {
    key: 'matter',
    title: '办理事项',
    fields: [
      { name: 'type', label: '事项类型', type: 'select', required: true, options: [['new', '新办'], ['renew', '续办'], ['change', '变更']] },
      { name: 'description', label: '事项说明', type: 'textarea', required: false },
    ],
  },
  {
    key: 'declaration',
    title: '确认声明',
    fields: [
      { name: 'agreed', label: '我确认所填信息真实、准确、完整，并愿意承担相应责任。', type: 'checkbox', required: true },
      { name: 'contactTime', label: '方便联系的时间（可选）', type: 'text', required: false },
    ],
  },
];

const $ = (selector) => document.querySelector(selector);
const els = {
  loginView: $('#loginView'), appView: $('#appView'), loginForm: $('#loginForm'), loginError: $('#loginError'),
  userBox: $('#userBox'), userName: $('#userName'), logoutBtn: $('#logoutBtn'), stepList: $('#stepList'),
  stateVersion: $('#stateVersion'), currentStepLabel: $('#currentStepLabel'), globalAlert: $('#globalAlert'),
  stepForm: $('#stepForm'), receiptPanel: $('#receiptPanel'),
};

const state = {
  csrfToken: readCookie('csrf'),
  workflow: null,
  user: null,
  pageId: getPageId(),
  token: null,
  tokenExpiresAt: 0,
  pendingIdempotencyKey: null,
  submitting: false,
  saveTimer: null,
  saving: false,
  formController: null,
  tokenRequestId: 0,
};

document.addEventListener('DOMContentLoaded', boot);
window.addEventListener('pageshow', (event) => {
  if (event.persisted) boot();
});
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && state.user) boot();
});
els.loginForm.addEventListener('submit', login);
els.logoutBtn.addEventListener('click', logout);

async function boot() {
  try {
    const result = await api('GET', '/api/state');
    state.user = result.user;
    state.workflow = result.workflow;
    showApp();
  } catch (error) {
    if (error.status === 401) {
      showLogin();
    } else {
      showAlert(error.message || '服务暂时不可用', 'error');
      showLogin();
    }
  }
}

async function login(event) {
  event.preventDefault();
  hideAlert();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try {
    const result = await api('POST', '/api/login', data, false);
    state.csrfToken = result.csrfToken;
    state.user = result.user;
    state.workflow = result.workflow;
    form.reset();
    showApp();
  } catch (error) {
    els.loginError.textContent = error.message || '登录失败';
    els.loginError.classList.remove('hidden');
  }
}

async function logout() {
  try { await api('POST', '/api/logout', {}, false); } finally {
    state.csrfToken = null;
    state.workflow = null;
    showLogin();
  }
}

function showApp() {
  els.loginView.classList.add('hidden');
  els.appView.classList.remove('hidden');
  els.userBox.classList.remove('hidden');
  els.userName.textContent = state.user.displayName;
  clearToken();
  render();
}

function showLogin() {
  els.loginView.classList.remove('hidden');
  els.appView.classList.add('hidden');
  els.userBox.classList.add('hidden');
}

function render() {
  if (!state.workflow) return;
  renderProgress();
  els.stateVersion.textContent = state.workflow.version;

  if (state.workflow.completed) {
    renderReceipt();
    return;
  }
  els.receiptPanel.classList.add('hidden');
  renderCurrentStep();
}

function renderProgress() {
  const current = state.workflow.progress;
  els.currentStepLabel.textContent = state.workflow.completed ? '已完成' : `${current + 1}. ${STEP_FORMS[current].title}`;
  els.stepList.innerHTML = '';
  state.workflow.steps.forEach((stepState, index) => {
    const li = document.createElement('li');
    li.className = `step-item ${stepState.status}`;
    const badgeText = {
      confirmed: '已确认', current: '当前', locked: '未开放', invalidated: '已失效',
    }[stepState.status];
    li.innerHTML = `
      <div class="step-main">
        <span>${index + 1}. ${escapeHtml(stepState.title)}</span>
        <span class="badge ${stepState.status}">${badgeText}</span>
      </div>
      <div class="step-actions"></div>
    `;
    if (stepState.status === 'confirmed' && !state.workflow.completed) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link-button';
      btn.textContent = '退回修改（使后续确认失效）';
      btn.addEventListener('click', () => requestRollback(index));
      li.querySelector('.step-actions').append(btn);
    }
    els.stepList.append(li);
  });
}

function renderCurrentStep() {
  state.formController?.abort();
  state.formController = new AbortController();
  state.tokenRequestId += 1;
  const signal = { signal: state.formController.signal };
  const step = state.workflow.progress;
  const definition = STEP_FORMS[step];
  const stepState = state.workflow.steps[step];
  const values = stepState.draft || stepState.confirmed || {};
  els.stepForm.innerHTML = `
    <h2>${step + 1}. ${escapeHtml(definition.title)}</h2>
    <p class="muted">草稿会自动保存。提交前需领取只绑定当前办理人、当前步骤、当前登录和当前页面的一次性令牌。</p>
    <div id="stepError"></div>
    <div class="fields"></div>
    <div class="form-actions">
      <button class="button primary" type="submit">确认并进入下一步</button>
      <button class="button secondary" type="button" data-action="save">保存草稿</button>
      <button class="button secondary" type="button" data-action="token">领取/刷新当前步骤令牌</button>
      <span class="inline-hint" data-token-status></span>
    </div>
  `;

  const fields = els.stepForm.querySelector('.fields');
  definition.fields.forEach((field) => fields.append(renderField(field, values[field.name], state.formController.signal)));
  els.stepForm.querySelector('[data-action="save"]').addEventListener('click', () => saveDraft(true), signal);
  els.stepForm.querySelector('[data-action="token"]').addEventListener('click', () => claimToken(step), signal);
  els.stepForm.addEventListener('submit', submitStep, signal);
  updateTokenStatus();
  void claimToken(step);
}

function renderField(field, value = '', signal) {
  const wrapper = document.createElement('label');
  if (field.type === 'checkbox') {
    wrapper.className = 'checkbox';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.name = field.name;
    input.checked = value === true;
    input.addEventListener('change', scheduleDraftSave, { signal });
    wrapper.append(input, document.createTextNode(field.label));
    return wrapper;
  }

  const label = document.createElement('span');
  label.textContent = field.label + (field.required ? ' *' : '');
  wrapper.append(label);

  let input;
  if (field.type === 'textarea') {
    input = document.createElement('textarea');
  } else if (field.type === 'select') {
    input = document.createElement('select');
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = '请选择';
    input.append(empty);
    field.options.forEach(([optionValue, text]) => {
      const option = document.createElement('option');
      option.value = optionValue;
      option.textContent = text;
      if (value === optionValue) option.selected = true;
      input.append(option);
    });
  } else {
    input = document.createElement('input');
    input.type = field.type;
    if (field.placeholder) input.placeholder = field.placeholder;
    input.value = value || '';
  }
  input.name = field.name;
  if (field.type !== 'select') input.value = value || '';
  input.addEventListener('input', scheduleDraftSave, { signal });
  input.addEventListener('change', scheduleDraftSave, { signal });
  wrapper.append(input);
  return wrapper;
}

async function submitStep(event) {
  event.preventDefault();
  if (state.submitting) return;
  const step = state.workflow?.progress;
  const payload = collectPayload(step);

  if (!state.token) {
    showStepError('当前没有一次性令牌，请先领取令牌。');
    return;
  }
  if (state.tokenExpiresAt <= Date.now()) {
    showStepError('令牌已明确过期。请重新读取进度后领取新令牌；旧令牌未用于本次提交。');
    clearToken();
    render();
    return;
  }

  if (!state.pendingIdempotencyKey) state.pendingIdempotencyKey = randomId();
  state.submitting = true;
  setSubmitBusy(true);
  try {
    const result = await api('POST', '/api/submissions', {
      step,
      pageId: state.pageId,
      token: state.token,
      idempotencyKey: state.pendingIdempotencyKey,
      payload,
    });
    state.workflow = result.workflow;
    state.pendingIdempotencyKey = null;
    clearToken();
    showAlert(result.replay
      ? '网络重试命中了同一次提交的幂等记录；服务端返回原确认，未重复推进、未重复生成确认。'
      : `第 ${step + 1} 步已由服务端确认。`, result.replay ? 'warning' : 'success');
    render();
  } catch (error) {
    if (error.body?.workflow) state.workflow = error.body.workflow;
    state.pendingIdempotencyKey = null;
    clearToken();
    showAlert(`${explainConflict(error.body?.error?.code)} 已重新读取服务端最新进度。`, 'error');
    render();
  } finally {
    state.submitting = false;
    setSubmitBusy(false);
  }
}

function setSubmitBusy(busy) {
  const button = els.stepForm.querySelector('button[type="submit"]');
  if (button) button.disabled = busy;
}

async function claimToken(step) {
  if (state.workflow?.progress !== step || state.workflow?.completed) return;
  const requestId = ++state.tokenRequestId;
  updateTokenStatus('正在领取令牌…');
  try {
    const result = await api('POST', '/api/tokens', { step, pageId: state.pageId });
    if (requestId !== state.tokenRequestId || state.workflow.progress !== step) return;
    state.token = result.token;
    state.tokenExpiresAt = result.expiresAt;
    updateTokenStatus();
  } catch (error) {
    if (requestId !== state.tokenRequestId) return;
    clearToken();
    if (error.body?.workflow) state.workflow = error.body.workflow;
    showAlert(`领取令牌失败：${explainConflict(error.body?.error?.code)} 已重新读取服务端最新进度。`, 'error');
    render();
  }
}

function collectPayload(step) {
  const payload = {};
  STEP_FORMS[step].fields.forEach((field) => {
    const formEl = els.stepForm.elements[field.name];
    if (field.type === 'checkbox') payload[field.name] = formEl.checked;
    else payload[field.name] = String(formEl.value || '').trim();
  });
  return payload;
}

function scheduleDraftSave() {
  clearTimeout(state.saveTimer);
  updateTokenStatus();
  state.saveTimer = setTimeout(() => saveDraft(false), 500);
}

async function saveDraft(manual) {
  if (!state.workflow || state.workflow.completed) return;
  const step = state.workflow.progress;
  const draft = collectPayload(step);
  state.saving = true;
  updateTokenStatus(manual ? '正在保存草稿…' : undefined);
  try {
    const result = await api('POST', '/api/drafts', { step, draft });
    state.workflow.version = result.version;
    els.stateVersion.textContent = result.version;
    if (manual) showAlert('草稿已保存到服务端。', 'success');
    updateTokenStatus();
  } catch (error) {
    if (error.body?.workflow) state.workflow = error.body.workflow;
    showAlert(`草稿保存失败：${explainConflict(error.body?.error?.code)} 已重新读取最新进度。`, 'error');
    render();
  } finally {
    state.saving = false;
  }
}

async function requestRollback(targetStep) {
  const confirmedStep = state.workflow.steps[targetStep];
  const ok = window.confirm(`确定修改第 ${targetStep + 1} 步吗？该步及其之后所有服务端确认都会立即失效，页面将停在第 ${targetStep + 1} 步。`);
  if (!ok) return;
  try {
    const result = await api('POST', '/api/rollback', {
      targetStep,
      expectedVersion: state.workflow.version,
    });
    state.workflow = result.workflow;
    clearToken();
    showAlert(`已退回第 ${targetStep + 1} 步；后续确认均已失效。原确认内容保留为可修改草稿。`, 'warning');
    render();
  } catch (error) {
    if (error.body?.workflow) state.workflow = error.body.workflow;
    showAlert(`退回失败：${explainConflict(error.body?.error?.code)} 已重新读取最新进度。`, 'error');
    render();
  }
}

function renderReceipt() {
  els.stepForm.innerHTML = '';
  els.receiptPanel.classList.remove('hidden');
  const confirmations = state.workflow.steps.map((s, i) => `
    <div class="confirmation">
      <strong>${i + 1}. ${escapeHtml(s.title)}</strong>
      <div>确认时间：${s.confirmedAt ? new Date(s.confirmedAt).toLocaleString() : '无'}</div>
      <pre>${escapeHtml(JSON.stringify(s.confirmed, null, 2))}</pre>
    </div>
  `).join('');
  els.receiptPanel.innerHTML = `
    <h2>办理完成</h2>
    <p>所有步骤都由服务端确认。完成时间：${new Date(state.workflow.completedAt).toLocaleString()}</p>
    ${confirmations}
  `;
}

function updateTokenStatus(prefix = '') {
  const el = els.stepForm?.querySelector('[data-token-status]');
  if (!el) return;
  if (state.saving) {
    el.textContent = prefix || '正在保存草稿…';
  } else if (!state.token) {
    el.textContent = prefix || '尚未领取一次性令牌';
  } else if (state.tokenExpiresAt <= Date.now()) {
    el.textContent = '令牌已过期';
  } else {
    const seconds = Math.ceil((state.tokenExpiresAt - Date.now()) / 1000);
    el.textContent = `${prefix ? `${prefix}，` : ''}令牌有效，剩余 ${seconds} 秒；只能用于当前页面当前步骤一次`;
  }
}

setInterval(() => {
  if (document.hidden || !state.workflow || state.workflow.completed) return;
  updateTokenStatus();
  if (state.token && state.tokenExpiresAt <= Date.now() && !state.submitting) {
    clearToken();
    void claimToken(state.workflow.progress);
  }
}, 1000);

function explainConflict(code) {
  return {
    PROGRESS_MOVED: '另一个页面已经推进或退回办理。',
    CONCURRENT_PROGRESS_CHANGED: '并发冲突：另一个页面已经使用有效提交。',
    TOKEN_USED: '令牌已经使用过，拒绝重放。',
    TOKEN_EXPIRED: '令牌已过期。',
    TOKEN_STEP_MISMATCH: '令牌不能跨步骤使用。',
    TOKEN_PAGE_MISMATCH: '令牌不能换到另一个页面使用。',
    TOKEN_SESSION_MISMATCH: '令牌不能跨登录会话使用。',
    TOKEN_NOT_FOUND: '令牌不存在或不属于当前办理人。',
    STEP_NOT_CURRENT: '该步骤不是服务端记录的当前步骤。',
    WORKFLOW_VERSION_CONFLICT: '进度已在其他页面变化。',
    SUBMISSION_ALREADY_PROCESSED: '提交已处理或其确认已失效，拒绝重复使用。',
    WORKFLOW_COMPLETED: '办理已完成。',
  }[code] || '请求被服务端拒绝。';
}

function showStepError(message) {
  let el = $('#stepError');
  if (!el) return;
  el.innerHTML = `<div class="alert error">${escapeHtml(message)}</div>`;
}

function showAlert(message, type = 'error') {
  clearTimeout(showAlert.timer);
  els.globalAlert.className = `alert ${type}`;
  els.globalAlert.textContent = message;
  if (type !== 'error') {
    showAlert.timer = setTimeout(() => hideAlert(), 5000);
  }
  els.globalAlert.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}
function hideAlert() {
  els.globalAlert.className = 'alert hidden';
  els.globalAlert.textContent = '';
}

function clearToken() {
  state.token = null;
  state.tokenExpiresAt = 0;
}

async function api(method, url, body, auth = true) {
  const headers = { Accept: 'application/json' };
  const options = { method, headers, credentials: 'same-origin' };
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  if (auth && state.csrfToken) headers['X-CSRF-Token'] = state.csrfToken;

  const response = await fetch(url, options);
  let data = null;
  try { data = await response.json(); } catch { /* empty */ }
  if (!response.ok) {
    const error = new Error(data?.error?.message || `请求失败（${response.status}）`);
    error.status = response.status;
    error.body = data;
    throw error;
  }
  return data;
}

function getPageId() {
  // 不复用 sessionStorage：复制标签页/后退恢复会复制它，导致两个真实页面共用 ID。
  // 刷新当前页面会生成新 ID，旧页面未使用的令牌随即不能在刷新后的页面使用。
  return randomId();
}
function randomId() {
  return crypto.getRandomValues(new Uint8Array(24)).reduce((out, byte) => out + byte.toString(16).padStart(2, '0'), '');
}
function readCookie(name) {
  return document.cookie.split('; ').reduce((value, part) => part.startsWith(`${name}=`) ? decodeURIComponent(part.slice(name.length + 1)) : value, '');
}
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}
