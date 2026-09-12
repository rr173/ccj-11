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
  stepForm: $('#stepForm'), receiptPanel: $('#receiptPanel'), correctionPanel: $('#correctionPanel'),
  reviewPanel: $('#reviewPanel'),
  recordsPanel: $('#recordsPanel'), recordsList: $('#recordsList'),
};

const state = {
  csrfToken: readCookie('csrf'),
  workflow: null,
  receipt: null,
  viewingReceipt: null,
  records: [],
  timeline: [],
  correction: null,
  reviews: { invitations: [], objections: [] },
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
  busy: false,
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
    applyState(result);
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

function applyState(result) {
  state.user = result.user;
  state.workflow = result.workflow;
  state.receipt = result.receipt || null;
  state.records = Array.isArray(result.records) ? result.records : [];
  state.timeline = Array.isArray(result.timeline) ? result.timeline : [];
  state.correction = result.correction || null;
  state.reviews = result.reviews || { invitations: [], objections: [] };
}

async function login(event) {
  event.preventDefault();
  hideAlert();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  try {
    const result = await api('POST', '/api/login', data, false);
    state.csrfToken = result.csrfToken;
    applyState(result);
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
    state.receipt = null;
    state.records = [];
    state.timeline = [];
    state.correction = null;
    state.reviews = { invitations: [], objections: [] };
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

  renderTimeline();
  renderCorrectionPanel();
  if (state.workflow.completed) {
    renderReceipt(state.receipt || state.viewingReceipt || null);
    renderReviewPanel();
    return;
  }
  if (state.viewingReceipt) {
    renderReceipt(state.viewingReceipt);
    renderReviewPanel();
    return;
  }
  state.viewingReceipt = null;
  els.receiptPanel.classList.add('hidden');
  els.receiptPanel.innerHTML = '';
  els.reviewPanel.classList.add('hidden');
  els.reviewPanel.innerHTML = '';
  renderCurrentStep();
}

// 回执版本时间线：按办理顺序展示原始回执、更正中的草稿与后续回执，
// 以及它们之间的来源关系（更正自哪份回执、被哪份回执/草稿更正）和当前状态。
function renderTimeline() {
  const entries = state.timeline.length
    ? state.timeline
    : state.records.map((r) => ({ kind: 'receipt', ...r, correctedBy: [] })).reverse();
  if (!entries.length) {
    els.recordsPanel.classList.add('hidden');
    els.recordsList.innerHTML = '';
    return;
  }
  els.recordsPanel.classList.remove('hidden');
  els.recordsList.innerHTML = '';
  entries.forEach((entry) => {
    const li = document.createElement('li');
    if (entry.kind === 'receipt') {
      li.className = `record-item ${entry.status}`;
      const statusText = entry.status === 'revoked' ? '已撤销' : '有效';
      const relations = [];
      if (entry.sourceReceiptNo) relations.push(`更正自 <span class="mono">${escapeHtml(entry.sourceReceiptNo)}</span>`);
      (entry.correctedBy || []).forEach((next) => {
        relations.push(next.kind === 'receipt'
          ? `被 <span class="mono">${escapeHtml(next.receiptNo)}</span> 更正`
          : '有一份更正正在进行中');
      });
      li.innerHTML = `
        <div class="record-main">
          <span class="mono">${escapeHtml(entry.receiptNo)}</span>
          <span class="badge ${entry.status === 'revoked' ? 'invalidated' : 'confirmed'}">${statusText}</span>
        </div>
        <div class="muted small">第 ${entry.sequence} 次办理 · 完成于 ${formatTime(entry.completedAt)}</div>
        ${relations.length ? `<div class="timeline-relations small">${relations.map((r) => `<div>↳ ${r}</div>`).join('')}</div>` : ''}
        <div class="record-actions"></div>
      `;
      const actions = li.querySelector('.record-actions');
      const viewBtn = document.createElement('button');
      viewBtn.type = 'button';
      viewBtn.className = 'link-button';
      viewBtn.textContent = '查看 / 打印回执';
      viewBtn.addEventListener('click', () => openReceiptDoc(entry.receiptNo));
      actions.append(viewBtn);
      const detailBtn = document.createElement('button');
      detailBtn.type = 'button';
      detailBtn.className = 'link-button muted-link';
      detailBtn.textContent = '加载完整内容';
      detailBtn.addEventListener('click', () => loadReceipt(entry.receiptNo));
      actions.append(detailBtn);
      const correctBtn = document.createElement('button');
      correctBtn.type = 'button';
      correctBtn.className = 'link-button muted-link';
      correctBtn.textContent = '基于本回执发起更正';
      correctBtn.addEventListener('click', () => startCorrection(entry.receiptNo));
      actions.append(correctBtn);
      const reviewBtn = document.createElement('button');
      reviewBtn.type = 'button';
      reviewBtn.className = 'link-button muted-link';
      reviewBtn.textContent = '发起复核邀请';
      reviewBtn.addEventListener('click', () => createReviewInvitation(entry.receiptNo));
      actions.append(reviewBtn);
    } else if (entry.kind === 'review') {
      li.className = 'record-item review-item';
      const statusMap = {
        active: ['待使用', 'current'], used: ['已使用', 'confirmed'],
        revoked: ['已撤销', 'invalidated'], expired: ['已过期', 'invalidated'],
      };
      const [statusText, statusCls] = statusMap[entry.status] || [entry.status, 'current'];
      li.innerHTML = `
        <div class="record-main">
          <span>复核邀请</span>
          <span class="badge ${statusCls}">${statusText}</span>
        </div>
        <div class="muted small">
          发起于 ${formatTime(entry.createdAt)} · 有效期至 ${formatTime(entry.expiresAt)}
          ${entry.usedAt ? `· 使用于 ${formatTime(entry.usedAt)}` : ''}
        </div>
        <div class="muted small">针对回执 <span class="mono">${escapeHtml(entry.receiptNo)}</span> ·
          异议 ${entry.objectionCount} 条（待处理 ${entry.openCount} / 已接受 ${entry.acceptedCount} / 已驳回 ${entry.rejectedCount}）
        </div>
        <div class="review-objections"></div>
        <div class="record-actions"></div>
      `;
      const objBox = li.querySelector('.review-objections');
      (entry.objections || []).forEach((obj) => {
        const div = document.createElement('div');
        div.className = `review-obj ${obj.status}`;
        const badge = { open: '待处理', accepted: '已接受', rejected: '已驳回' }[obj.status];
        let result = '';
        if (obj.status === 'accepted') {
          result = obj.correctionReceiptNo
            ? `→ 更正回执 <span class="mono">${escapeHtml(obj.correctionReceiptNo)}</span>`
            : '→ 已进入更正办理（进行中）';
        } else if (obj.status === 'rejected') {
          result = `驳回理由：${escapeHtml(obj.resolveReason || '—')}`;
        }
        div.innerHTML = `
          <div class="record-main">
            <span>${escapeHtml(obj.fieldLabel)}（提交于 ${formatTime(obj.submittedAt)}）</span>
            <span class="badge ${obj.status === 'open' ? 'current' : obj.status === 'accepted' ? 'confirmed' : 'invalidated'}">${badge}</span>
          </div>
          <div class="small">${escapeHtml(obj.reason)}</div>
          ${result ? `<div class="small review-obj-result">${result}</div>` : ''}
          <div class="review-obj-actions"></div>`;
        const objActions = div.querySelector('.review-obj-actions');
        if (obj.status === 'open') {
          const acceptBtn = document.createElement('button');
          acceptBtn.type = 'button';
          acceptBtn.className = 'link-button';
          acceptBtn.textContent = '接受（进入更正办理）';
          acceptBtn.addEventListener('click', () => acceptObjection(obj.id));
          objActions.append(acceptBtn);
          const rejectBtn = document.createElement('button');
          rejectBtn.type = 'button';
          rejectBtn.className = 'link-button muted-link';
          rejectBtn.textContent = '驳回（填写理由）';
          rejectBtn.addEventListener('click', () => rejectObjection(obj.id));
          objActions.append(rejectBtn);
        }
        objBox.append(div);
      });
      const actions = li.querySelector('.record-actions');
      if (entry.status === 'active') {
        const revokeBtn = document.createElement('button');
        revokeBtn.type = 'button';
        revokeBtn.className = 'link-button danger-link';
        revokeBtn.textContent = '撤销邀请（立即失效）';
        revokeBtn.addEventListener('click', () => revokeInvitation(entry.invitationId));
        actions.append(revokeBtn);
      }
    } else {
      const isCorrection = entry.kind === 'correction';
      li.className = 'record-item in-progress';
      li.innerHTML = `
        <div class="record-main">
          <span>${isCorrection ? '更正草稿' : '首次办理'}</span>
          <span class="badge current">进行中 · 第 ${entry.progress + 1 > entry.totalSteps ? entry.totalSteps : entry.progress + 1}/${entry.totalSteps} 步</span>
        </div>
        <div class="muted small">第 ${entry.sequence} 次办理 · 开始于 ${formatTime(entry.startedAt)}</div>
        ${isCorrection ? `<div class="timeline-relations small"><div>↳ 更正自 <span class="mono">${escapeHtml(entry.sourceReceiptNo)}</span>，完成后将生成新回执</div></div>` : ''}
        <div class="record-actions"></div>
      `;
      if (isCorrection) {
        const abandonBtn = document.createElement('button');
        abandonBtn.type = 'button';
        abandonBtn.className = 'link-button';
        abandonBtn.textContent = '放弃本次更正（不影响原回执）';
        abandonBtn.addEventListener('click', () => abandonCorrection());
        li.querySelector('.record-actions').append(abandonBtn);
      }
    }
    els.recordsList.append(li);
  });
}

// 更正预览：在提交任何新步骤前，展示原回执与当前草稿的字段级差异，
// 新增 / 修改 / 删除分别标注；证件号码与详细地址由服务端遮罩后下发。
function renderCorrectionPanel() {
  const correction = state.correction;
  if (!correction || !state.workflow || state.workflow.completed) {
    els.correctionPanel.classList.add('hidden');
    els.correctionPanel.innerHTML = '';
    return;
  }
  els.correctionPanel.classList.remove('hidden');
  const { diff } = correction;
  const changeMeta = {
    added: { text: '新增', cls: 'added' },
    modified: { text: '修改', cls: 'modified' },
    deleted: { text: '删除', cls: 'deleted' },
    unchanged: { text: '未变更', cls: 'unchanged' },
  };
  const rows = diff.fields.map((field) => {
    const meta = changeMeta[field.change];
    const display = (v) => (v === '' ? '<span class="muted">（空）</span>' : escapeHtml(v));
    return `
      <tr class="diff-row ${meta.cls}">
        <td>${escapeHtml(field.stepTitle)}</td>
        <td>${escapeHtml(field.label)}${field.masked ? ' <span class="mask-tag" title="敏感字段，仅显示遮罩内容">已遮罩</span>' : ''}</td>
        <td>${display(field.before)}</td>
        <td>${display(field.after)}</td>
        <td><span class="badge diff-${meta.cls}">${meta.text}</span></td>
      </tr>`;
  }).join('');
  els.correctionPanel.innerHTML = `
    <div class="receipt-head">
      <h2>更正预览（第 ${correction.progress + 1 > correction.totalSteps ? correction.totalSteps : correction.progress + 1}/${correction.totalSteps} 步进行中）</h2>
      <span class="badge current">更正中</span>
    </div>
    <p class="muted small">
      本预览对比原回执 <span class="mono">${escapeHtml(correction.sourceReceiptNo)}</span> 与当前更正草稿的字段级差异；
      提交任何新步骤前请先核对。证件号码与详细地址仅显示遮罩内容。
    </p>
    <p class="diff-summary">
      <span class="badge diff-added">新增 ${diff.summary.added}</span>
      <span class="badge diff-modified">修改 ${diff.summary.modified}</span>
      <span class="badge diff-deleted">删除 ${diff.summary.deleted}</span>
      <span class="badge diff-unchanged">未变更 ${diff.summary.unchanged}</span>
    </p>
    <table class="diff-table">
      <thead><tr><th>步骤</th><th>字段</th><th>原回执</th><th>当前草稿</th><th>变更</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <div class="form-actions">
      <button class="button secondary" type="button" data-action="abandon">放弃本次更正（原回执不受影响）</button>
    </div>
  `;
  els.correctionPanel.querySelector('[data-action="abandon"]').addEventListener('click', () => abandonCorrection());
}

async function refreshCorrectionPreview() {
  if (!state.workflow || state.workflow.completed || !state.workflow.sourceReceiptNo) return;
  try {
    const result = await api('GET', '/api/corrections/preview');
    state.correction = result.correction || null;
  } catch (error) {
    if (error.status === 404) state.correction = null;
  }
  renderCorrectionPanel();
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
    if (result.receipt) state.receipt = result.receipt;
    state.pendingIdempotencyKey = null;
    clearToken();
    showAlert(result.replay
      ? '网络重试命中了同一次提交的幂等记录；服务端返回原确认，未重复推进、未重复生成回执。'
      : result.receipt
        ? '全部四步已确认成功，电子回执已生成并固定保存。'
        : `第 ${step + 1} 步已由服务端确认。`, result.replay ? 'warning' : 'success');
    if (result.receipt) {
      await boot(); // 完成后重新读取：时间线出现新回执，更正预览关闭
    } else {
      await refreshCorrectionPreview();
      render();
    }
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
    void refreshCorrectionPreview();
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

function renderReceipt(receipt = state.receipt) {
  els.stepForm.innerHTML = '';
  els.receiptPanel.classList.remove('hidden');
  if (!receipt) {
    els.receiptPanel.innerHTML = `
      <h2>办理完成</h2>
      <p class="muted">回执数据加载中。如长时间未显示，请<a href="#" id="reloadState">重新加载状态</a>。</p>`;
    els.receiptPanel.querySelector('#reloadState')?.addEventListener('click', async (e) => {
      e.preventDefault();
      await boot();
    });
    return;
  }
  const revoked = receipt.status === 'revoked';
  const stepsHtml = receipt.snapshot.steps.map((s, i) => `
    <div class="confirmation">
      <strong>${i + 1}. ${escapeHtml(s.title)}</strong>
      <div class="muted small">确认时间：${formatTime(s.confirmedAt)}</div>
      <pre>${escapeHtml(JSON.stringify(s.data, null, 2))}</pre>
    </div>
  `).join('');
  els.receiptPanel.innerHTML = `
    <div class="receipt-head">
      <h2>电子办理回执</h2>
      <span class="status-pill ${revoked ? 'revoked' : 'completed'}">${revoked ? '已撤销（失效）' : '已完成'}</span>
    </div>
    <div class="receipt-meta">
      <div><span class="muted">回执编号</span><b class="mono selectable">${escapeHtml(receipt.receiptNo)}</b></div>
      <div><span class="muted">核验码（请与编号分开保管）</span><b class="mono selectable code-value">${escapeHtml(receipt.code)}</b></div>
      <div><span class="muted">最终完成时间</span><b>${formatTime(receipt.completedAt)}</b></div>
      <div><span class="muted">回执签发时间</span><b>${formatTime(receipt.issuedAt)}</b></div>
      <div><span class="muted">办理记录</span><b>第 ${receipt.snapshot.sequence} 次办理</b></div>
      <div><span class="muted">公开核验</span><b><a href="/verify" target="_blank" rel="noopener">/verify</a>（无需登录，仅显示脱敏信息）</b></div>
    </div>
    ${revoked ? `<div class="alert error">本回执已于 ${formatTime(receipt.revokedAt)} 撤销${receipt.revokeReason ? `，原因：${escapeHtml(receipt.revokeReason)}` : ''}，不再作为办理完成的有效凭证。回执内容仍按原始记录留档。</div>` : ''}
    <div class="receipt-actions">
      <button class="button primary" type="button" data-action="print">查看 / 下载可打印回执</button>
      <button class="button secondary" type="button" data-action="copy-no">复制回执编号</button>
      <button class="button secondary" type="button" data-action="copy-code">复制核验码</button>
      <button class="button secondary" type="button" data-action="correct">基于本回执发起更正（生成新办理记录）</button>
      ${revoked ? '' : '<button class="button danger" type="button" data-action="revoke">撤销本回执</button>'}
    </div>
    <p class="muted small">
      回执内容在签发时已固定保存，包含各步已确认信息、各步确认时间和最终完成时间；
      刷新页面、重新登录或服务重启后看到的都是同一份回执。已完成的回执不能退回修改或被覆盖。
    </p>
    <h3>各步已确认信息</h3>
    ${stepsHtml}
  `;
  els.receiptPanel.querySelector('[data-action="print"]').addEventListener('click', () => openReceiptDoc(receipt.receiptNo));
  els.receiptPanel.querySelector('[data-action="copy-no"]').addEventListener('click', () => copyText(receipt.receiptNo, '回执编号已复制'));
  els.receiptPanel.querySelector('[data-action="copy-code"]').addEventListener('click', () => copyText(receipt.code, '核验码已复制'));
  els.receiptPanel.querySelector('[data-action="correct"]').addEventListener('click', () => startCorrection(receipt.receiptNo));
  if (!revoked) {
    els.receiptPanel.querySelector('[data-action="revoke"]').addEventListener('click', () => revokeCurrentReceipt(receipt));
  }
}

function formatTime(epochMs) {
  if (!epochMs) return '—';
  return new Date(epochMs).toLocaleString('zh-CN', { hour12: false });
}

function openReceiptDoc(receiptNo) {
  window.open(`/api/receipts/${encodeURIComponent(receiptNo)}/print`, '_blank', 'noopener');
}

async function loadReceipt(receiptNo) {
  try {
    const result = await api('GET', `/api/receipts/${encodeURIComponent(receiptNo)}`);
    state.viewingReceipt = result.receipt;
    if (result.reviews) state.reviews = result.reviews;
    renderReceipt(result.receipt);
    renderReviewPanel();
    els.reviewPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    showAlert(error.message || '回执加载失败', 'error');
  }
}

async function copyText(text, okMessage) {
  try {
    await navigator.clipboard.writeText(text);
    showAlert(okMessage, 'success');
  } catch {
    window.prompt('请手动复制：', text);
  }
}

async function startCorrection(receiptNo) {
  const ok = window.confirm(
    '将基于该回执发起一次更正办理：\n\n'
    + '· 原回执与原办理记录固定保留，不会被修改或覆盖；\n'
    + '· 系统会创建一条全新的办理记录，各步草稿用原回执内容预填；\n'
    + '· 提交每一步前都可以查看与原回执的字段级差异预览；\n'
    + '· 新流程全部完成后会生成新的回执编号与核验码。\n\n'
    + '确定发起更正吗？',
  );
  if (!ok || state.busy) return;
  state.busy = true;
  try {
    const result = await api('POST', '/api/corrections', { receiptNo });
    state.workflow = result.workflow;
    state.receipt = null;
    state.viewingReceipt = null;
    state.records = result.records || state.records;
    state.timeline = result.timeline || state.timeline;
    state.correction = result.correction || null;
    state.pendingIdempotencyKey = null;
    clearToken();
    showAlert('已创建新的更正办理记录，各步草稿已用原回执内容预填。提交每一步前请先在上方“更正预览”核对与原回执的差异。', 'warning');
    render();
  } catch (error) {
    // 同一回执不能同时存在两份进行中的更正：并发发起只放行一个，
    // 失败方明确提示并重新读取服务端最新状态。
    showAlert(`发起更正失败：${error.message || explainConflict(error.body?.error?.code)} 已重新读取最新状态。`, 'error');
    await boot();
  } finally {
    state.busy = false;
  }
}

async function abandonCorrection() {
  const ok = window.confirm(
    '确定放弃本次更正吗？\n\n'
    + '· 更正产生的新办理记录与草稿将被删除；\n'
    + '· 原回执的内容、状态与核验结果完全不受影响；\n'
    + '· 放弃后可以重新基于原回执再次发起更正。',
  );
  if (!ok || state.busy) return;
  state.busy = true;
  try {
    const result = await api('POST', '/api/corrections?action=abandon', {});
    applyState(result);
    state.viewingReceipt = null;
    state.pendingIdempotencyKey = null;
    clearToken();
    showAlert('已放弃本次更正，原回执保持不变。', 'warning');
    render();
  } catch (error) {
    showAlert(`放弃更正失败：${error.message || explainConflict(error.body?.error?.code)} 已重新读取最新状态。`, 'error');
    await boot();
  } finally {
    state.busy = false;
  }
}

async function revokeCurrentReceipt(receipt) {
  const reason = window.prompt(
    `撤销后回执 ${receipt.receiptNo} 将立即失效，公开核验会明确提示“已撤销”，\n`
    + '回执内容仍固定留档，且该操作不能恢复。请输入撤销原因（可留空）：',
    '',
  );
  if (reason === null || state.busy) return;
  state.busy = true;
  try {
    const result = await api('POST', `/api/receipts/${encodeURIComponent(receipt.receiptNo)}?action=revoke`, {
      reason: reason.slice(0, 200),
    });
    if (state.receipt?.receiptNo === receipt.receiptNo) state.receipt = result.receipt;
    state.viewingReceipt = result.receipt;
    state.records = result.records || state.records;
    showAlert('回执已撤销。如需办理，请发起更正以生成新的办理记录与回执。', 'warning');
    render();
  } catch (error) {
    if (error.body?.receipt) state.receipt = error.body.receipt;
    showAlert(`撤销失败：${error.message || '请稍后重试'}`, 'error');
    render();
  } finally {
    state.busy = false;
  }
}

// ---------------------------------------------------------------------------
// 回执复核协作（办理人侧）
// ---------------------------------------------------------------------------

// 当前回执的复核邀请与异议（仅完成视图下展示）
function renderReviewPanel() {
  const panel = els.reviewPanel;
  if (!panel) return;
  const receiptNo = state.receipt?.receiptNo || state.viewingReceipt?.receiptNo;
  if (!receiptNo) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }
  panel.classList.remove('hidden');
  const invitations = (state.reviews.invitations || []).filter((inv) => inv.receiptNo === receiptNo);
  const objections = (state.reviews.objections || []).filter((obj) => obj.receiptNo === receiptNo);
  if (!invitations.length && !objections.length) {
    panel.innerHTML = `
      <div class="receipt-head"><h2>回执复核协作</h2></div>
      <p class="muted small">尚未发起复核邀请。办理人可创建一个限时、只能使用一次的复核链接；复核人无需登录，完成邀请校验后只能查看这一份回执的脱敏内容，并针对具体字段提交异议。</p>
      <div class="receipt-actions">
        <button class="button secondary" type="button" data-action="new-review">创建限时复核邀请</button>
      </div>`;
    panel.querySelector('[data-action="new-review"]')?.addEventListener('click', () => createReviewInvitation(receiptNo));
    return;
  }

  const counts = { open: 0, accepted: 0, rejected: 0 };
  objections.forEach((o) => { counts[o.status] += 1; });
  const invHtml = invitations.map((inv) => {
    const badge = {
      active: ['待使用', 'current'], used: ['已使用', 'confirmed'],
      revoked: ['已撤销', 'invalidated'], expired: ['已过期', 'invalidated'],
    }[inv.status] || [inv.status, 'current'];
    return `
      <li class="review-invite ${inv.status}">
        <div class="record-main">
          <span>邀请 · 有效期至 ${formatTime(inv.expiresAt)}</span>
          <span class="badge ${badge[1]}">${badge[0]}</span>
        </div>
        <div class="muted small">发起于 ${formatTime(inv.createdAt)}${inv.usedAt ? ` · 使用于 ${formatTime(inv.usedAt)}` : ''} · 异议 ${inv.objectionCount} 条</div>
        <div class="record-actions" data-invite="${escapeHtml(inv.id)}"></div>
      </li>`;
  }).join('');
  const objHtml = objections.map((obj) => {
    const badge = { open: ['待处理', 'current'], accepted: ['已接受', 'confirmed'], rejected: ['已驳回', 'invalidated'] }[obj.status];
    let result = '';
    if (obj.status === 'accepted') {
      result = obj.correctionReceiptNo
        ? `已进入更正办理，新回执：<b class="mono">${escapeHtml(obj.correctionReceiptNo)}</b>`
        : '已接受，更正办理进行中';
    } else if (obj.status === 'rejected') {
      result = `驳回理由：${escapeHtml(obj.resolveReason || '—')}`;
    }
    return `
      <li class="objection-item ${obj.status}" data-objection="${escapeHtml(obj.id)}">
        <div class="record-main">
          <b>${escapeHtml(obj.fieldLabel)}</b>
          <span class="badge ${badge[1]}">${badge[0]}</span>
        </div>
        <div class="muted small">提交于 ${formatTime(obj.submittedAt)} · 提交时脱敏值：${escapeHtml(obj.valueSnapshot || '—')}</div>
        <div>${escapeHtml(obj.reason)}</div>
        ${result ? `<div class="small review-obj-result">${result}${obj.resolvedAt ? ` · 处理于 ${formatTime(obj.resolvedAt)}` : ''}</div>` : ''}
        <div class="record-actions" data-obj-actions="${escapeHtml(obj.id)}"></div>
      </li>`;
  }).join('');
  panel.innerHTML = `
    <div class="receipt-head">
      <h2>回执复核协作</h2>
      <span class="badge current">待处理 ${counts.open} · 已接受 ${counts.accepted} · 已驳回 ${counts.rejected}</span>
    </div>
    <div class="receipt-actions">
      <button class="button secondary" type="button" data-action="new-review">创建限时复核邀请</button>
    </div>
    <h3>复核邀请（限时、一次性）</h3>
    <ul class="objection-list">${invHtml || '<li class="muted small">无</li>'}</ul>
    <h3>字段异议与处理结果</h3>
    <ul class="objection-list">${objHtml || '<li class="muted small">暂无异议</li>'}</ul>`;
  panel.querySelector('[data-action="new-review"]')?.addEventListener('click', () => createReviewInvitation(receiptNo));
  invitations.forEach((inv) => {
    const box = panel.querySelector(`[data-invite="${cssEscape(inv.id)}"]`);
    if (!box) return;
    if (inv.status === 'active') {
      const copyBtn = document.createElement('button');
      copyBtn.type = 'button';
      copyBtn.className = 'link-button';
      copyBtn.textContent = '复制邀请链接';
      copyBtn.addEventListener('click', () => copyReviewLink(inv.id));
      box.append(copyBtn);
      const revokeBtn = document.createElement('button');
      revokeBtn.type = 'button';
      revokeBtn.className = 'link-button danger-link';
      revokeBtn.textContent = '撤销邀请';
      revokeBtn.addEventListener('click', () => revokeInvitation(inv.id));
      box.append(revokeBtn);
    }
  });
  objections.forEach((obj) => {
    if (obj.status !== 'open') return;
    const box = panel.querySelector(`[data-obj-actions="${cssEscape(obj.id)}"]`);
    if (!box) return;
    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'link-button';
    acceptBtn.textContent = '接受（进入新的更正办理）';
    acceptBtn.addEventListener('click', () => acceptObjection(obj.id));
    box.append(acceptBtn);
    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'link-button muted-link';
    rejectBtn.textContent = '驳回（保留理由）';
    rejectBtn.addEventListener('click', () => rejectObjection(obj.id));
    box.append(rejectBtn);
  });
}

function cssEscape(value) {
  if (window.CSS && CSS.escape) return CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

async function createReviewInvitation(receiptNo) {
  const input = window.prompt('复核邀请有效期（小时，1-168，默认 72）：', '72');
  if (input === null) return;
  let hours = Number(String(input).trim() || '72');
  if (!Number.isFinite(hours) || hours < 1 / 60 || hours > 168) {
    showAlert('有效期需在 1 小时到 168 小时（7 天）之间。', 'error');
    return;
  }
  const note = window.prompt('给本次复核的备注（可留空）：', '') || '';
  if (note === null || state.busy) return;
  state.busy = true;
  try {
    const result = await api('POST', '/api/reviews/invitations', {
      receiptNo,
      ttlMinutes: Math.round(hours * 60),
      note: String(note).slice(0, 200),
    });
    state.reviews.invitations = [result.invitation, ...(state.reviews.invitations || [])];
    const link = `${location.origin}${result.url}`;
    await copyText(link, '复核邀请链接已复制（只能使用一次）');
    showAlert('复核邀请已创建，链接已复制：' + link, 'success');
    render();
  } catch (error) {
    showAlert(`创建复核邀请失败：${error.message || '请稍后重试'}`, 'error');
  } finally {
    state.busy = false;
  }
}

async function revokeInvitation(invitationId) {
  const ok = window.confirm('撤销后该邀请链接立即失效，复核人即使打开过页面也不能继续查看或提交异议。确定撤销吗？');
  if (!ok || state.busy) return;
  state.busy = true;
  try {
    const result = await api('POST', `/api/reviews/invitations/${encodeURIComponent(invitationId)}/revoke`, {});
    if (result.reviews) state.reviews = result.reviews;
    showAlert('复核邀请已撤销。', 'warning');
    await boot();
  } catch (error) {
    showAlert(`撤销失败：${error.message || '请稍后重试'}`, 'error');
  } finally {
    state.busy = false;
  }
}

async function acceptObjection(objectionId) {
  const ok = window.confirm(
    '接受该异议后将立即进入一次新的更正办理：\n\n'
    + '· 原回执内容保持冻结，不会被覆盖；\n'
    + '· 系统创建新的办理记录并以原回执预填草稿；\n'
    + '· 新流程完成后生成新回执，时间线会展示来源关系。',
  );
  if (!ok || state.busy) return;
  state.busy = true;
  try {
    // 先尝试加锁，避免两个页面同时处理
    try {
      await api('POST', `/api/reviews/objections/${encodeURIComponent(objectionId)}/lock`, {});
    } catch { /* 锁失败时由最终接受接口判定 */ }
    const result = await api('POST', `/api/reviews/objections/${encodeURIComponent(objectionId)}/accept`, {});
    state.reviews = result.reviews || state.reviews;
    state.records = result.records || state.records;
    state.timeline = result.timeline || state.timeline;
    state.correction = result.correction || null;
    showAlert(result.createdCorrection
      ? '已接受异议并创建新的更正办理记录，可在更正预览中修改内容后逐步确认。'
      : '已接受异议，已关联到当前进行中的同源更正办理。', 'success');
    await boot();
  } catch (error) {
    if (error.body?.alreadyHandled && error.body.objection) {
      showAlert(`该异议已被另一个页面处理（状态：${error.body.objection.status === 'accepted' ? '已接受' : '已驳回'}），刷新后展示同一结果。`, 'warning');
    } else {
      showAlert(`接受失败：${error.message || explainConflict(error.body?.error?.code)}`, 'error');
    }
    await boot();
  } finally {
    state.busy = false;
  }
}

async function rejectObjection(objectionId) {
  const reason = window.prompt('请填写驳回理由（2-200 字，将保留并展示给办理人侧留档）：', '');
  if (reason === null || state.busy) return;
  const trimmed = String(reason).trim();
  if (trimmed.length < 2 || trimmed.length > 200) {
    showAlert('驳回理由需为 2-200 个字符。', 'error');
    return;
  }
  state.busy = true;
  try {
    try {
      await api('POST', `/api/reviews/objections/${encodeURIComponent(objectionId)}/lock`, {});
    } catch { /* ignore */ }
    const result = await api('POST', `/api/reviews/objections/${encodeURIComponent(objectionId)}/reject`, { reason: trimmed });
    state.reviews = result.reviews || state.reviews;
    showAlert('异议已驳回，理由已保留。', 'warning');
    render();
  } catch (error) {
    if (error.body?.alreadyHandled && error.body.objection) {
      showAlert(`该异议已被另一个页面处理（状态：${error.body.objection.status === 'accepted' ? '已接受' : '已驳回'}），刷新后展示同一结果。`, 'warning');
    } else {
      showAlert(`驳回失败：${error.message || '请稍后重试'}`, 'error');
    }
    await boot();
  } finally {
    state.busy = false;
  }
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
    WORKFLOW_COMPLETED: '办理已完成，回执不能退回修改或覆盖；如需更正请发起新的办理记录。',
    OPEN_WORKFLOW_EXISTS: '已有进行中的办理，请先完成或放弃后再发起更正。',
    CORRECTION_IN_PROGRESS: '该回执已存在一份进行中的更正，不能重复发起。',
    NOT_A_CORRECTION: '当前进行中的办理不是更正，不能通过放弃更正关闭。',
    NO_OPEN_WORKFLOW: '当前没有进行中的办理。',
    NO_CORRECTION_IN_PROGRESS: '当前没有进行中的更正。',
    RECEIPT_NOT_FOUND: '回执不存在或不属于当前账号。',
    RECEIPT_ALREADY_REVOKED: '该回执已经处于撤销状态。',
    OBJECTION_ALREADY_HANDLED: '该异议已被处理，重复提交返回同一结果。',
    OBJECTION_LOCKED_BY_OTHER: '另一个页面正在处理该异议，请稍后刷新查看结果。',
    OBJECTION_NOT_FOUND: '异议不存在。',
    OPEN_WORKFLOW_EXISTS: '已有进行中的办理，请先完成或放弃后再接受异议。',
    INVITATION_ALREADY_USED: '邀请链接已被使用，不能撤销。',
    INVITATION_ALREADY_REVOKED: '邀请已处于撤销状态。',
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
