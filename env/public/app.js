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
  reviewPanel: $('#reviewPanel'), batchPanel: $('#batchPanel'),
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
  reviewBatches: [],
  reviewAppeals: [],
  appealReasons: [],
  batchFieldOptions: [],
  batchMaxInvitations: 5,
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
  state.reviewBatches = Array.isArray(result.reviewBatches) ? result.reviewBatches : [];
  state.reviewAppeals = Array.isArray(result.reviewAppeals) ? result.reviewAppeals : [];
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
    state.reviewBatches = [];
    state.reviewAppeals = [];
    state.appealReasons = [];
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
    renderBatchPanel();
    return;
  }
  if (state.viewingReceipt) {
    renderReceipt(state.viewingReceipt);
    renderReviewPanel();
    renderBatchPanel();
    return;
  }
  state.viewingReceipt = null;
  els.receiptPanel.classList.add('hidden');
  els.receiptPanel.innerHTML = '';
  els.reviewPanel.classList.add('hidden');
  els.reviewPanel.innerHTML = '';
  els.batchPanel.classList.add('hidden');
  els.batchPanel.innerHTML = '';
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
      const batchBtn = document.createElement('button');
      batchBtn.type = 'button';
      batchBtn.className = 'link-button muted-link';
      batchBtn.textContent = '创建多方复核批次';
      batchBtn.addEventListener('click', () => openBatchBuilder(entry.receiptNo));
      actions.append(batchBtn);
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
    } else if (entry.kind === 'reviewBatch') {
      li.className = 'record-item batch-item';
      const statusMap = {
        collecting: ['邀请校验中', 'current'],
        in_review: ['复核中', 'confirmed'],
        completed: ['已完成决议', 'confirmed'],
        cancelled: ['已取消', 'invalidated'],
        timed_out: ['已超时失败', 'invalidated'],
      };
      const [statusText, statusCls] = statusMap[entry.status] || [entry.status, 'current'];
      const corrHtml = (field) => field.correctionReceiptNo
        ? `<div class="small review-obj-result">→ 更正回执 <span class="mono">${escapeHtml(field.correctionReceiptNo)}</span></div>`
        : field.decision === 'rejected'
          ? `<div class="small review-obj-result">${field.decidedByPolicy ? '系统自动驳回：' : '驳回理由：'}${escapeHtml(field.decisionReason || '—')}</div>`
          : '';
      const fieldBlock = (field) => {
        const badge = field.decision === 'accepted'
          ? '<span class="badge confirmed">已接受</span>'
          : field.decision === 'rejected'
            ? '<span class="badge invalidated">已驳回</span>'
            : '<span class="badge current">待决议</span>';
        const opinionHtml = (field.opinions || []).map((o) => `
          <li class="batch-opinion">
            <div class="record-main"><b>${escapeHtml(o.reviewerLabel)}</b><span class="muted small">${formatTime(o.submittedAt)}</span></div>
            <div class="small">${escapeHtml(o.reason)}</div>
          </li>`).join('');
        return `
          <div class="batch-field ${field.decision || 'pending'}">
            <div class="record-main">
              <span>${escapeHtml(field.label)} <span class="muted small">（接受阈值 ${field.acceptThreshold} / 驳回阈值 ${field.rejectThreshold}，${field.opinionCount} 份意见）</span></span>
              ${badge}
            </div>
            <ul class="batch-opinion-list">${opinionHtml || '<li class="muted small">暂无意见</li>'}</ul>
            ${corrHtml(field)}
            <div class="record-actions" data-bf-actions data-bf-batch="${escapeHtml(entry.batchId)}" data-bf-field="${escapeHtml(field.id)}"></div>
          </div>`;
      };
      // 分阶段批次：按阶段分组渲染字段、邀请、倒计时与阶段最终决议
      const STAGE_STATUS = {
        pending: '未开始', active: '进行中', active_deadline_passed: '限时已到',
        completed: '已完成', timed_out: '已超时', failed: '已失败',
      };
      const POLICY_TEXT = { advance: '超时自动进入下一阶段', revoke_unused: '超时撤销未使用邀请', fail: '超时标记批次失败' };
      const stageHtml = (entry.stages || []).map((stage) => {
        const countdown = (stage.status === 'active' || stage.status === 'active_deadline_passed') && stage.deadlineAt
          ? `<span class="muted small"> · 剩余 <b data-countdown="${stage.deadlineAt}">${formatRemaining(stage.deadlineAt)}</b></span>`
          : '';
        const timeoutLine = stage.timeoutFiredAt
          ? `<div class="small review-obj-result">超时策略（开始时冻结：${escapeHtml(POLICY_TEXT[stage.frozenPolicy || stage.timeoutPolicy] || stage.timeoutPolicy)}）已于 ${formatTime(stage.timeoutFiredAt)} 触发，结果：${escapeHtml(stage.timeoutResult || '—')}</div>`
          : '';
        const stageFieldIds = new Set((entry.fields || []).filter((f) => f.stageId === stage.id).map((f) => f.id));
        const stageFields = (entry.fields || []).filter((f) => f.stageId === stage.id);
        const stageInvites = (entry.invitations || []).filter((inv) => inv.stageId === stage.id);
        const invHtml = stageInvites.map((inv) => {
          const invStatus = { active: '待使用', used: '已校验', revoked: '已撤销', expired: '已过期' }[inv.status] || inv.status;
          return `<li class="muted small">${escapeHtml(inv.label)}：${invStatus} · 授权 ${inv.fieldKeys.length} 个字段${inv.usedAt ? ` · 校验于 ${formatTime(inv.usedAt)}` : ''}${inv.revokedAt ? ` · 撤销于 ${formatTime(inv.revokedAt)}` : ''}</li>`;
        }).join('');
        return `
          <div class="batch-stage ${escapeHtml(stage.status)}">
            <div class="record-main">
              <b>阶段 ${stage.ordinal + 1} · ${escapeHtml(stage.name)}</b>
              <span class="badge ${stage.status === 'active' ? 'confirmed' : stage.status === 'pending' ? 'current' : 'invalidated'}">${STAGE_STATUS[stage.status] || stage.status}</span>
            </div>
            <div class="muted small">
              限时 ${Math.round(stage.durationMs / 60000)} 分钟 · 策略：${escapeHtml(POLICY_TEXT[stage.timeoutPolicy] || stage.timeoutPolicy)}
              ${stage.startedAt ? ` · 开始于 ${formatTime(stage.startedAt)}` : ''}
              ${stage.deadlineAt ? ` · 截止 ${formatTime(stage.deadlineAt)}` : ''}
              ${countdown}
              ${stage.completedAt ? ` · 结束于 ${formatTime(stage.completedAt)}` : ''}
              · 邀请 ${stage.validatedCount}/${stage.invitationCount}
              · 字段决议 ${stage.acceptedCount + stage.rejectedCount}/${stage.fieldCount}
              ${stage.finalDecision ? ` · 最终决议：${escapeHtml(stage.finalDecision)}` : ''}
            </div>
            ${timeoutLine}
            <ul class="batch-invite-list">${invHtml}</ul>
            <div class="batch-fields">${stageFields.map(fieldBlock).join('')}</div>
          </div>`;
      }).join('');
      const flatInviteHtml = (entry.invitations || []).map((inv) => {
        const invStatus = {
          active: '待使用', used: '已校验', revoked: '已撤销', expired: '已过期',
        }[inv.status] || inv.status;
        return `<li class="muted small">${escapeHtml(inv.label)}：${invStatus} · 授权 ${inv.fieldKeys.length} 个字段${inv.usedAt ? ` · 校验于 ${formatTime(inv.usedAt)}` : ''}</li>`;
      }).join('');
      const historyHtml = (entry.changeHistory || []).length ? `
        <details class="batch-history"><summary class="muted small">配置版本 v${entry.configVersion} · 变更历史（${entry.changeHistory.length}）</summary>
        <ul class="batch-history-list">
          ${entry.changeHistory.map((h) => `<li class="muted small">${formatTime(h.at)} · ${escapeHtml(historyTypeText(h.type))}${h.fromVersion ? ` v${h.fromVersion}→v${h.toVersion}` : ` v${h.toVersion}`}</li>`).join('')}
        </ul></details>` : `<div class="muted small">配置版本 v${entry.configVersion}</div>`;
      li.innerHTML = `
        <div class="record-main">
          <span>${entry.staged ? '多方分阶段复核批次' : '多方复核批次'}</span>
          <span class="badge ${statusCls}">${statusText}${entry.staged && entry.currentStageOrdinal !== null && entry.status === 'in_review' ? ` · 第 ${entry.currentStageOrdinal + 1} 阶段` : ''}</span>
        </div>
        <div class="muted small">
          创建于 ${formatTime(entry.createdAt)} · 有效期至 ${formatTime(entry.expiresAt)}
          · 邀请 ${entry.validatedCount}/${entry.invitationCount} 已完成校验
          ${entry.cancelledAt ? `· 取消于 ${formatTime(entry.cancelledAt)}` : ''}
          ${entry.completedAt ? `· 完成于 ${formatTime(entry.completedAt)}` : ''}
          ${entry.timeoutResult ? `· 超时结果：${escapeHtml(entry.timeoutResult)}` : ''}
        </div>
        <div class="muted small">针对回执 <span class="mono">${escapeHtml(entry.receiptNo)}</span>${entry.note ? ` · 备注：${escapeHtml(entry.note)}` : ''}</div>
        ${entry.staged ? stageHtml : `<ul class="batch-invite-list">${flatInviteHtml}</ul><div class="batch-fields">${(entry.fields || []).map(fieldBlock).join('')}</div>`}
        ${historyHtml}
        <div class="record-actions" data-batch-actions="${escapeHtml(entry.batchId)}"></div>
      `;
      // 只有“当前进行中阶段”的待决议字段显示决议按钮
      const currentStageId = entry.stages && entry.currentStageOrdinal !== null && entry.stages[entry.currentStageOrdinal]
        ? entry.stages[entry.currentStageOrdinal].id
        : null;
      (entry.fields || []).forEach((field) => {
        if (entry.status !== 'in_review' || field.decision) return;
        if (entry.staged && field.stageId !== currentStageId) return;
        const box = li.querySelector(`[data-bf-field="${cssEscape(field.id)}"]`);
        if (!box) return;
        const acceptBtn = document.createElement('button');
        acceptBtn.type = 'button';
        acceptBtn.className = 'link-button';
        acceptBtn.textContent = `接受全部意见（阈值 ${field.acceptThreshold}）`;
        acceptBtn.addEventListener('click', () => acceptBatchField(entry.batchId, field.id));
        box.append(acceptBtn);
        const rejectBtn = document.createElement('button');
        rejectBtn.type = 'button';
        rejectBtn.className = 'link-button muted-link';
        rejectBtn.textContent = `驳回（阈值 ${field.rejectThreshold}，需理由）`;
        rejectBtn.addEventListener('click', () => rejectBatchField(entry.batchId, field.id));
        box.append(rejectBtn);
      });
      const batchActions = li.querySelector(`[data-batch-actions="${cssEscape(entry.batchId)}"]`);
      // 分阶段批次：第一阶段尚未开始时可“启动第一阶段/调整编排/取消”；平面批次：收集期可进入复核/取消
      const firstStage = entry.staged && entry.stages ? entry.stages[0] : null;
      const canStartStaged = entry.staged && firstStage && firstStage.status === 'pending'
        && !(entry.stages || []).some((s) => s.status !== 'pending');
      if (entry.status === 'collecting' || canStartStaged) {
        const startBtn = document.createElement('button');
        startBtn.type = 'button';
        startBtn.className = 'link-button';
        startBtn.textContent = entry.staged ? '启动第一阶段（开始倒计时并冻结策略）' : '全部已校验，进入复核';
        startBtn.addEventListener('click', () => startBatch(entry.batchId));
        batchActions.append(startBtn);
        if (entry.staged) {
          const editBtn = document.createElement('button');
          editBtn.type = 'button';
          editBtn.className = 'link-button';
          editBtn.textContent = '调整编排（需当前版本号）';
          editBtn.addEventListener('click', () => reconfigureBatch(entry.batchId, entry.configVersion));
          batchActions.append(editBtn);
        }
        const cancelBtn = document.createElement('button');
        cancelBtn.type = 'button';
        cancelBtn.className = 'link-button danger-link';
        cancelBtn.textContent = '取消批次';
        cancelBtn.addEventListener('click', () => cancelBatch(entry.batchId));
        batchActions.append(cancelBtn);
        (entry.invitations || []).forEach((inv) => {
          if (inv.status !== 'active') return;
          if (entry.staged && inv.stageOrdinal !== null && inv.stageOrdinal !== 0) return;
          const revokeBtn = document.createElement('button');
          revokeBtn.type = 'button';
          revokeBtn.className = 'link-button danger-link';
          revokeBtn.textContent = `撤销邀请「${inv.label}」`;
          revokeBtn.addEventListener('click', () => revokeBatchInvitation(inv.id));
          batchActions.append(revokeBtn);
        });
      }
    } else if (entry.kind === 'reviewAppeal') {
      li.className = 'record-item appeal-item';
      const appealStatusMap = {
        collecting: ['邀请校验中', 'current'],
        in_review: ['申诉评议中', 'confirmed'],
        completed: ['已完成决议', 'confirmed'],
        cancelled: ['已取消', 'invalidated'],
        expired: ['已过期', 'invalidated'],
      };
      const [appealStatusText, appealStatusCls] = appealStatusMap[entry.status] || [entry.status, 'current'];
      const inviteHtml = (entry.invitations || []).map((inv) => {
        const invStatus = { active: '待使用', used: '已校验', revoked: '已撤销', expired: '已过期' }[inv.status] || inv.status;
        return `<li class="muted small">${escapeHtml(inv.label)}：${invStatus} · 授权 ${inv.fieldKeys.length} 个字段${inv.usedAt ? ` · 校验于 ${formatTime(inv.usedAt)}` : ''}</li>`;
      }).join('');
      const fieldHtml = (entry.fields || []).map((field) => {
        const badge = field.decision === 'accepted'
          ? '<span class="badge confirmed">申诉成立</span>'
          : field.decision === 'rejected'
            ? '<span class="badge invalidated">申诉驳回</span>'
            : '<span class="badge current">待决议</span>';
        const evidenceHtml = (field.evidence || []).map((ev) => `
          <li class="batch-opinion evidence-opinion">
            <div class="record-main"><b>${escapeHtml(ev.alias)}</b><span class="muted small">原复核证据 · ${formatTime(ev.originalSubmittedAt)}</span></div>
            <div class="small">${escapeHtml(ev.reason)}</div>
          </li>`).join('');
        const opinionHtml = (field.opinions || []).map((o) => `
          <li class="batch-opinion">
            <div class="record-main"><b>${escapeHtml(o.reviewerLabel)}</b><span class="muted small">${formatTime(o.submittedAt)}</span></div>
            <div class="small">${escapeHtml(o.reason)}</div>
          </li>`).join('');
        const result = field.correctionReceiptNo
          ? `<div class="small review-obj-result">→ 更正回执 <span class="mono">${escapeHtml(field.correctionReceiptNo)}</span></div>`
          : field.decision === 'rejected'
            ? `<div class="small review-obj-result">申诉驳回理由：${escapeHtml(field.decisionReason || '—')} · 处理人 ${escapeHtml(field.decidedBy || '—')}</div>`
            : '';
        const original = field.originalDecision;
        return `
          <div class="batch-field appeal-field ${field.decision || 'pending'}">
            <div class="record-main">
              <span>${escapeHtml(field.label)}
                <span class="muted small">（申诉理由：${escapeHtml(field.reasonLabel)}，接受阈值 ${field.acceptThreshold} / 驳回阈值 ${field.rejectThreshold}，${field.opinionCount} 份意见）</span>
              </span>
              ${badge}
            </div>
            <div class="muted small">原批次决议：驳回${original?.decidedByPolicy ? '（超时策略自动驳回）' : ''}${original?.decidedAt ? ` · ${formatTime(original.decidedAt)}` : ''}；原驳回理由：${escapeHtml(original?.reason || '—')}</div>
            <details class="appeal-evidence-box" ${field.evidence.length ? 'open' : ''}>
              <summary class="muted small">允许披露的原复核证据（${field.evidence.length} 条，原复核人匿名）</summary>
              <ul class="batch-opinion-list">${evidenceHtml || '<li class="muted small">未授权披露</li>'}</ul>
            </details>
            <div class="muted small">新复核人申诉意见：</div>
            <ul class="batch-opinion-list">${opinionHtml || '<li class="muted small">暂无申诉意见</li>'}</ul>
            ${result}
          </div>`;
      }).join('');
      const eventHtml = (entry.events || []).length ? `
        <details class="batch-history"><summary class="muted small">申诉审计事件（${entry.events.length}）</summary>
        <ul class="batch-history-list">
          ${entry.events.map((event) => `<li class="muted small">${formatTime(event.at)} · ${escapeHtml(event.type)}</li>`).join('')}
        </ul></details>` : '';
      li.innerHTML = `
        <div class="record-main">
          <span>↳ 复核申诉回合（原批次 <span class="mono small">${escapeHtml(entry.batchId.slice(0, 10))}…</span>）</span>
          <span class="badge ${appealStatusCls}">${appealStatusText} · ${entry.validatedCount}/${entry.invitationCount} · 决议 ${entry.decidedCount}/${entry.fieldCount}</span>
        </div>
        <div class="muted small">
          创建于 ${formatTime(entry.createdAt)} · 截止 ${formatTime(entry.expiresAt)}
          ${['collecting', 'in_review'].includes(entry.status) ? ` · 剩余 <b data-countdown="${entry.expiresAt}">${formatRemaining(entry.expiresAt)}</b>` : ''}
          ${entry.cancelledAt ? ` · 取消于 ${formatTime(entry.cancelledAt)}` : ''}
          ${entry.expiredAt ? ` · 过期于 ${formatTime(entry.expiredAt)}` : ''}
          ${entry.completedAt ? ` · 完成于 ${formatTime(entry.completedAt)}` : ''}
        </div>
        <div class="muted small">申诉理由：${escapeHtml(entry.reasonSummary || '—')} · 针对回执 <span class="mono">${escapeHtml(entry.receiptNo)}</span></div>
        <ul class="batch-invite-list">${inviteHtml}</ul>
        <div class="batch-fields">${fieldHtml}</div>
        ${eventHtml}
      `;
    } else {
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
      ${revoked ? '' : '<button class="button secondary" type="button" data-action="batch">创建多方复核批次</button>'}
      ${revoked ? '' : '<button class="button danger" type="button" data-action="revoke">撤销本回执</button>'}    </div>
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
  els.receiptPanel.querySelector('[data-action="batch"]')?.addEventListener('click', () => openBatchBuilder(receipt.receiptNo));
  if (!revoked) {
    els.receiptPanel.querySelector('[data-action="revoke"]').addEventListener('click', () => revokeCurrentReceipt(receipt));
  }
}

function formatTime(epochMs) {
  if (!epochMs) return '—';
  return new Date(epochMs).toLocaleString('zh-CN', { hour12: false });
}

function formatRemaining(deadlineMs) {
  const ms = Math.max(0, deadlineMs - Date.now());
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (ms <= 0) return '已到限时';
  if (h > 0) return `${h} 小时 ${m} 分 ${s} 秒`;
  if (m > 0) return `${m} 分 ${s} 秒`;
  return `${s} 秒`;
}

function historyTypeText(type) {
  return ({
    'batch.created': '创建批次',
    'batch.reconfigured': '调整编排',
    'batch.cancelled': '取消批次',
    'batch.stage.started': '阶段开始',
    'batch.stage.completed': '阶段完成',
    'batch.stage.timeout': '阶段超时落定',
  }[type]) || type;
}

// 倒计时与阶段状态每秒刷新（页面打开期间）
setInterval(() => {
  document.querySelectorAll('[data-countdown]').forEach((el) => {
    el.textContent = formatRemaining(Number(el.dataset.countdown));
  });
}, 1000);

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

// ---------------------------------------------------------------------------
// 多方复核批次（办理人侧）
// ---------------------------------------------------------------------------

async function ensureBatchFieldOptions() {
  if (state.batchFieldOptions.length) return;
  try {
    const result = await api('GET', '/api/review-batches/field-options');
    state.batchFieldOptions = result.fields || [];
    state.batchMaxInvitations = result.maxInvitations || 5;
  } catch {
    state.batchFieldOptions = [];
  }
}

function currentBatchReceiptNo() {
  return state.receipt?.receiptNo || state.viewingReceipt?.receiptNo;
}

function renderBatchPanel() {
  const panel = els.batchPanel;
  if (!panel) return;
  const receiptNo = currentBatchReceiptNo();
  if (!receiptNo) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }
  panel.classList.remove('hidden');
  const batches = (state.reviewBatches || []).filter((batch) => batch.receiptNo === receiptNo);
  panel.innerHTML = `
    <div class="receipt-head">
      <h2>多方复核批次</h2>
      <span class="record-actions">
        <button class="button secondary" type="button" data-action="new-batch">创建复核批次（2-5 方）</button>
        <button class="button secondary" type="button" data-action="new-staged-batch">创建分阶段批次</button>
      </span>
    </div>
    <p class="muted small">
      为同一份回执创建包含 2-5 个限时、一次性邀请的复核批次，逐字段配置接受/驳回阈值；
      全部邀请完成校验后批次才进入复核，复核人只能查看并评价各自被授权的脱敏字段。
      分阶段批次可把复核拆成按顺序执行的多个阶段，逐阶段配置邀请范围、字段范围、阈值、限时与超时策略。
    </p>
    <div data-batch-builder></div>
    <div class="batch-list"></div>
    <div class="appeal-list"></div>
  `;
  panel.querySelector('[data-action="new-batch"]').addEventListener('click', () => openBatchBuilder(receiptNo));
  panel.querySelector('[data-action="new-staged-batch"]').addEventListener('click', () => openStagedBuilder(receiptNo));
  const list = panel.querySelector('.batch-list');
  if (!batches.length) {
    list.innerHTML = '<p class="muted small">尚无复核批次。</p>';
  } else {
    batches.forEach((batch) => list.append(renderBatchCard(batch)));
  }
  renderAppealSection(panel.querySelector('.appeal-list'), batches, receiptNo);
}

// 申诉回合区块：展示原批次↔申诉回合关系、邀请状态、倒计时、证据摘要、阈值进度与处理人
function renderAppealSection(container, batches, receiptNo) {
  const rounds = (state.reviewAppeals || []).filter((round) => round.receiptNo === receiptNo);
  if (!batches.length || !rounds.length) {
    container.innerHTML = '';
    return;
  }
  const blocks = batches.map((batch) => {
    const batchRounds = rounds.filter((round) => round.batchId === batch.id);
    if (!batchRounds.length) return '';
    const cards = batchRounds.map((round) => renderAppealRoundCard(round, batch)).join('');
    return `<div class="appeal-group">
      <h3 class="appeal-group-title">批次 <span class="mono small">${escapeHtml(batch.id.slice(0, 12))}…</span> 的复核申诉回合</h3>
      ${cards}
    </div>`;
  }).join('');
  container.innerHTML = blocks;
  container.querySelectorAll('[data-appeal-create]').forEach((btn) => {
    btn.addEventListener('click', () => openAppealBuilder(btn.dataset.appealCreate));
  });
  container.querySelectorAll('[data-appeal-copy]').forEach((btn) => {
    btn.addEventListener('click', () => {
      showAlert('出于安全设计，完整申诉链接只在创建回合当次展示；如链接丢失，请取消本回合并重新发起。', 'warning');
    });
  });
  container.querySelectorAll('[data-appeal-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => cancelAppealRound(btn.dataset.appealCancel));
  });
  container.querySelectorAll('[data-appeal-accept]').forEach((btn) => {
    btn.addEventListener('click', () => acceptAppealField(btn.dataset.appealAccept.split('|')[0], btn.dataset.appealAccept.split('|')[1]));
  });
  container.querySelectorAll('[data-appeal-reject]').forEach((btn) => {
    btn.addEventListener('click', () => rejectAppealField(btn.dataset.appealReject.split('|')[0], btn.dataset.appealReject.split('|')[1]));
  });
}

const APPEAL_STATUS_TEXT = {
  collecting: '邀请校验中', in_review: '申诉评议中', completed: '已完成决议', cancelled: '已取消', expired: '已过期',
};

function renderAppealRoundCard(round, batch) {
  const statusCls = {
    collecting: 'current', in_review: 'confirmed', completed: 'confirmed', cancelled: 'invalidated', expired: 'invalidated',
  }[round.status] || 'current';
  const invites = round.invitations.map((inv) => {
    const invStatus = { active: '待使用', used: '已校验', revoked: '已撤销', expired: '已过期' }[inv.status] || inv.status;
    const linkBtn = inv.status === 'active' && ['collecting', 'in_review'].includes(round.status)
      ? `<button class="link-button" type="button" data-appeal-copy="${escapeHtml(inv.id)}">复制链接</button>`
      : '';
    return `<li class="muted small">
      <b>${escapeHtml(inv.label)}</b> · ${invStatus} · 授权字段：${inv.fields.map((f) => escapeHtml(f.label)).join('、')}
      ${inv.usedAt ? ` · 校验于 ${formatTime(inv.usedAt)}` : ''}
      <span class="record-actions">${linkBtn}</span>
    </li>`;
  }).join('');
  const fields = round.fields.map((field) => {
    const opinions = field.opinions.map((o) => `
      <li class="batch-opinion">
        <div class="record-main"><b>${escapeHtml(o.reviewerLabel)}</b><span class="muted small">${formatTime(o.submittedAt)}</span></div>
        <div class="small">${escapeHtml(o.reason)}</div>
      </li>`).join('');
    const badge = field.decision === 'accepted'
      ? '<span class="badge confirmed">申诉成立·已接受</span>'
      : field.decision === 'rejected'
        ? '<span class="badge invalidated">申诉驳回</span>'
        : '<span class="badge current">待决议</span>';
    const original = field.originalDecision;
    const originalLine = original ? `
      <div class="small muted">原批次决议：驳回${original.decidedByPolicy ? '（超时策略自动驳回）' : ''}${original.decidedAt ? ` · ${formatTime(original.decidedAt)}` : ''} · 处理人 ${escapeHtml(original.decidedBy || '系统')}</div>
      ${original.reason ? `<div class="small muted">原驳回理由：${escapeHtml(original.reason)}</div>` : ''}` : '';
    const evidence = (field.evidence || []).map((ev) => `
      <li class="batch-opinion evidence-opinion">
        <div class="record-main"><b>${escapeHtml(ev.alias)}</b><span class="muted small">原复核证据 · ${formatTime(ev.originalSubmittedAt)}</span></div>
        <div class="small">${escapeHtml(ev.reason)}</div>
      </li>`).join('');
    const corr = field.correctionReceiptNo
      ? `<div class="small review-obj-result">→ 更正回执 <span class="mono">${escapeHtml(field.correctionReceiptNo)}</span></div>`
      : field.decision === 'rejected'
        ? `<div class="small review-obj-result">申诉驳回理由：${escapeHtml(field.decisionReason || '—')}</div>`
        : '';
    const actions = (!field.decision && round.status === 'in_review')
      ? `<span class="record-actions">
           <button class="link-button" type="button" data-appeal-accept="${escapeHtml(round.id)}|${escapeHtml(field.id)}">接受申诉（阈值 ${field.acceptThreshold}）</button>
           <button class="link-button muted-link" type="button" data-appeal-reject="${escapeHtml(round.id)}|${escapeHtml(field.id)}">驳回申诉（阈值 ${field.rejectThreshold}）</button>
         </span>`
      : '';
    return `<li class="batch-field appeal-field ${field.decision || 'pending'}">
      <div class="record-main">
        <b>${escapeHtml(field.label)}</b>
        <span class="muted small">申诉理由：${escapeHtml(field.reasonLabel)} · 接受≥${field.acceptThreshold} / 驳回≥${field.rejectThreshold} · ${field.opinionCount} 份申诉意见</span>
        ${badge}
      </div>
      ${originalLine}
      <div class="muted small">允许披露原证据 ${field.evidence.length} 条（原复核人匿名）</div>
      <ul class="batch-opinion-list">${evidence || '<li class="muted small">未授权披露原复核证据</li>'}</ul>
      <div class="muted small">新复核人申诉意见：</div>
      <ul class="batch-opinion-list">${opinions || '<li class="muted small">暂无申诉意见</li>'}</ul>
      ${corr}${actions}
    </li>`;
  }).join('');
  const canCreate = ['completed', 'in_review'].includes(batch.status);
  const remaining = ['collecting', 'in_review'].includes(round.status) ? formatRemaining(round.expiresAt) : null;
  return `<div class="objection-item batch-card appeal-card ${round.status}">
    <div class="record-main">
      <span>申诉回合 <span class="mono small">${escapeHtml(round.id.slice(0, 12))}…</span> · 来自批次 <span class="mono small">${escapeHtml(batch.id.slice(0, 8))}…</span></span>
      <span class="badge ${statusCls}">${APPEAL_STATUS_TEXT[round.status] || round.status} · ${round.validatedCount}/${round.invitationCount} · 决议 ${round.decidedCount}/${round.fieldCount}</span>
    </div>
    <div class="muted small">
      申诉理由：${escapeHtml(round.reasonSummary || '—')}
      · 创建于 ${formatTime(round.createdAt)} · 截止 ${formatTime(round.expiresAt)}
      ${remaining ? ` · 剩余 <b data-countdown="${round.expiresAt}">${remaining}</b>` : ''}
      ${round.completedAt ? ` · 完成于 ${formatTime(round.completedAt)}` : ''}
      ${round.cancelledAt ? ` · 取消于 ${formatTime(round.cancelledAt)}（${escapeHtml(round.cancelReason || '—')}）` : ''}
      ${round.expiredAt ? ` · 过期于 ${formatTime(round.expiredAt)}` : ''}
      ${round.note ? ` · 备注：${escapeHtml(round.note)}` : ''}
    </div>
    <ul class="batch-invite-list">${invites}</ul>
    <ul class="batch-field-list">${fields}</ul>
    <div class="record-actions">
      ${['collecting', 'in_review'].includes(round.status) && round.decidedCount === 0
        ? `<button class="link-button danger-link" type="button" data-appeal-cancel="${escapeHtml(round.id)}">取消申诉回合（尚无字段决议时可取消）</button>`
        : ''}
      ${canCreate ? '' : ''}
    </div>
  </div>`;
}

function renderBatchCard(batch) {
  const card = document.createElement('div');
  card.className = `objection-item batch-card ${batch.status}`;
  const statusText = {
    collecting: '邀请校验中', in_review: '复核中', completed: '已完成决议', cancelled: '已取消', timed_out: '已超时失败',
  }[batch.status] || batch.status;
  const statusCls = {
    collecting: 'current', in_review: 'confirmed', completed: 'confirmed', cancelled: 'invalidated', timed_out: 'invalidated',
  }[batch.status] || 'current';
  const STAGE_STATUS = {
    pending: '未开始', active: '进行中', active_deadline_passed: '限时已到',
    completed: '已完成', timed_out: '已超时', failed: '已失败',
  };
  const POLICY_TEXT = { advance: '自动进入下一阶段', revoke_unused: '撤销未使用邀请', fail: '标记超时失败' };
  const stageBlocks = (batch.staged && Array.isArray(batch.stages)) ? batch.stages.map((stage) => {
    const countdown = (stage.status === 'active' || stage.status === 'active_deadline_passed') && stage.deadlineAt
      ? ` · 剩余 <b data-countdown="${stage.deadlineAt}">${formatRemaining(stage.deadlineAt)}</b>`
      : '';
    const timeoutLine = stage.timeoutFiredAt
      ? `<li class="muted small">超时策略（${escapeHtml(POLICY_TEXT[stage.frozenPolicy || stage.timeoutPolicy] || stage.timeoutPolicy)}）已于 ${formatTime(stage.timeoutFiredAt)} 触发，结果：${escapeHtml(stage.timeoutResult)}</li>`
      : '';
    return `<li class="batch-stage-summary ${escapeHtml(stage.status)}">
      <b>阶段 ${stage.ordinal + 1} · ${escapeHtml(stage.name)}</b>
      <span class="badge ${stage.status === 'active' ? 'confirmed' : stage.status === 'pending' ? 'current' : 'invalidated'}">${STAGE_STATUS[stage.status] || stage.status}</span>
      <div class="muted small">限时 ${Math.round(stage.durationMs / 60000)} 分钟 · 策略：${escapeHtml(POLICY_TEXT[stage.timeoutPolicy] || stage.timeoutPolicy)}${countdown} · 邀请 ${stage.validatedCount}/${stage.invitationCount} · 决议 ${stage.acceptedCount + stage.rejectedCount}/${stage.fieldCount}${stage.finalDecision ? ` · 最终决议：${escapeHtml(stage.finalDecision)}` : ''}</div>
      <ul class="batch-opinion-list">${timeoutLine}</ul>
    </li>`;
  }).join('') : '';
  const invites = batch.invitations.map((inv) => {
    const invStatus = { active: '待使用', used: '已校验', revoked: '已撤销', expired: '已过期' }[inv.status] || inv.status;
    const linkBtn = inv.status === 'active'
      ? `<button class="link-button" type="button" data-copy="${escapeHtml(inv.id)}">复制链接</button>
         <button class="link-button danger-link" type="button" data-revoke-invite="${escapeHtml(inv.id)}">撤销</button>`
      : '';
    return `<li class="muted small">
      <b>${escapeHtml(inv.label)}</b> · ${invStatus} · 授权字段：${inv.fields.map((f) => escapeHtml(f.label)).join('、')}
      <span class="record-actions">${linkBtn}</span>
    </li>`;
  }).join('');
  const currentStageId = batch.staged && batch.currentStageOrdinal !== null && batch.stages[batch.currentStageOrdinal]
    ? batch.stages[batch.currentStageOrdinal].id
    : null;
  const fields = batch.fields.map((field) => {
    const stageLocked = batch.staged && field.stageId !== currentStageId;
    const opinions = field.opinions.map((o) => `
      <li class="batch-opinion">
        <div class="record-main"><b>${escapeHtml(o.reviewerLabel)}</b><span class="muted small">${formatTime(o.submittedAt)}</span></div>
        <div class="small">${escapeHtml(o.reason)}</div>
      </li>`).join('');
    const badge = field.decision === 'accepted'
      ? '<span class="badge confirmed">已接受</span>'
      : field.decision === 'rejected'
        ? '<span class="badge invalidated">已驳回</span>'
        : '<span class="badge current">待决议</span>';
    const corr = field.correctionReceiptNo
      ? ` → <span class="mono">${escapeHtml(field.correctionReceiptNo)}</span>`
      : field.decision === 'rejected'
        ? `<div class="small">${field.decidedByPolicy ? '系统自动驳回：' : '驳回理由：'}${escapeHtml(field.decisionReason || '—')}</div>`
        : '';
    const actions = (!field.decision && batch.status === 'in_review' && !stageLocked)
      ? `<span class="record-actions">
           <button class="link-button" type="button" data-accept="${escapeHtml(field.id)}">接受（阈值 ${field.acceptThreshold}）</button>
           <button class="link-button muted-link" type="button" data-reject="${escapeHtml(field.id)}">驳回（阈值 ${field.rejectThreshold}）</button>
         </span>`
      : '';
    return `<li class="batch-field ${field.decision || 'pending'}">
      <div class="record-main">
        <b>${escapeHtml(field.label)}</b>
        <span class="muted small">接受≥${field.acceptThreshold} / 驳回≥${field.rejectThreshold} · ${field.opinionCount} 份意见${stageLocked ? ' · 阶段未开放' : ''}</span>
        ${badge}
      </div>
      <ul class="batch-opinion-list">${opinions || '<li class="muted small">暂无意见</li>'}</ul>
      ${corr}${actions}
    </li>`;
  }).join('');
  const allPending = batch.staged && Array.isArray(batch.stages) && batch.stages.every((s) => s.status === 'pending');
  const canStart = batch.status === 'collecting' || (batch.staged && allPending && batch.status !== 'completed' && batch.status !== 'cancelled' && batch.status !== 'timed_out');
  card.innerHTML = `
    <div class="record-main">
      <span>批次 <span class="mono small">${escapeHtml(batch.id.slice(0, 12))}…</span>${batch.staged ? ' · <b>分阶段</b>' : ''}</span>
      <span class="badge ${statusCls}">${statusText} · ${batch.validatedCount}/${batch.invitationCount} · v${batch.configVersion}</span>
    </div>
    <div class="muted small">有效期至 ${formatTime(batch.expiresAt)}${batch.note ? ` · 备注：${escapeHtml(batch.note)}` : ''}${batch.timeoutResult ? ` · 超时结果：${escapeHtml(batch.timeoutResult)}` : ''}</div>
    ${batch.staged ? `<ul class="batch-stage-list">${stageBlocks}</ul>` : `<ul class="batch-invite-list">${invites}</ul>`}
    <ul class="batch-field-list">${fields}</ul>
    <div class="record-actions">
      ${canStart ? `
        <button class="link-button" type="button" data-start>${batch.staged ? '启动第一阶段（冻结策略、开始倒计时）' : '进入复核（需全部校验）'}</button>
        ${batch.staged ? `<button class="link-button" type="button" data-reconfigure>调整编排（基于 v${batch.configVersion}）</button>` : ''}
        <button class="link-button danger-link" type="button" data-cancel>取消批次</button>` : ''}
      ${batch.status === 'completed' || batch.status === 'in_review'
        ? '<button class="link-button" type="button" data-appeal-launch>对驳回字段发起申诉回合</button>'
        : ''}
    </div>
  `;
  card.querySelectorAll('[data-copy]').forEach((btn) => {
    btn.addEventListener('click', () => copyBatchLink(batch, btn.dataset.copy));
  });
  card.querySelectorAll('[data-revoke-invite]').forEach((btn) => {
    btn.addEventListener('click', () => revokeBatchInvitation(btn.dataset.revokeInvite));
  });
  card.querySelectorAll('[data-accept]').forEach((btn) => {
    btn.addEventListener('click', () => acceptBatchField(batch.id, btn.dataset.accept));
  });
  card.querySelectorAll('[data-reject]').forEach((btn) => {
    btn.addEventListener('click', () => rejectBatchField(batch.id, btn.dataset.reject));
  });
  card.querySelector('[data-start]')?.addEventListener('click', () => startBatch(batch.id));
  card.querySelector('[data-cancel]')?.addEventListener('click', () => cancelBatch(batch.id));
  card.querySelector('[data-reconfigure]')?.addEventListener('click', () => reconfigureBatch(batch.id, batch.configVersion));
  card.querySelector('[data-appeal-launch]')?.addEventListener('click', () => openAppealBuilder(batch.id));
  return card;
}

async function openBatchBuilder(receiptNo) {
  if (state.busy) return;
  await ensureBatchFieldOptions();
  const panel = els.batchPanel.querySelector('[data-batch-builder]');
  if (!panel) return;
  const fieldOptions = state.batchFieldOptions;
  panel.innerHTML = `
    <div class="batch-builder card-inner">
      <h3>配置多方复核批次</h3>
      <label>统一有效期（分钟，5-10080）
        <input type="number" id="bbTtl" value="60" min="5" max="10080">
      </label>
      <label>批次备注（可选）
        <input type="text" id="bbNote" maxlength="200" placeholder="例如：财务+人事联合复核">
      </label>
      <div class="bb-section">
        <strong>① 选择纳入编排的字段与阈值</strong>
        <p class="muted small">每个字段分别设置“接受阈值”（多少位复核人提出意见即可接受）与“驳回阈值”（多少位复核人未提出异议即可驳回），范围 1-邀请数。</p>
        <div class="bb-fields"></div>
      </div>
      <div class="bb-section">
        <strong>② 配置 2-5 个复核邀请</strong>
        <div class="form-actions">
          <button class="button secondary" type="button" data-add-invite>增加一个邀请</button>
          <span class="muted small">每个邀请独立的一次性链接与字段授权。</span>
        </div>
        <div class="bb-invites"></div>
      </div>
      <div id="bbError" class="alert error hidden"></div>
      <div class="form-actions">
        <button class="button primary" type="button" data-create>创建批次并生成一次性链接</button>
        <button class="button secondary" type="button" data-close>取消</button>
      </div>
    </div>`;

  const fieldsBox = panel.querySelector('.bb-fields');
  fieldOptions.forEach((option) => {
    const label = document.createElement('label');
    label.className = 'bb-field-row';
    label.innerHTML = `
      <span class="bb-field-name">
        <input type="checkbox" data-key="${escapeHtml(option.step + '.' + option.field)}">
        ${escapeHtml(option.label)} <span class="muted small">（${escapeHtml(option.step + 1 + ' 步 · ' + option.step + '.' + option.field)}）</span>
      </span>
      <span class="bb-thresholds">
        接受≥<input type="number" min="1" max="5" value="1" data-accept="${escapeHtml(option.step + '.' + option.field)}" disabled>
        驳回≥<input type="number" min="1" max="5" value="1" data-reject="${escapeHtml(option.step + '.' + option.field)}" disabled>
      </span>`;
    fieldsBox.append(label);
  });
  fieldsBox.addEventListener('change', () => {
    fieldsBox.querySelectorAll('input[type=checkbox]').forEach((box) => {
      const key = box.dataset.key;
      fieldsBox.querySelector(`[data-accept="${CSS.escape(key)}"]`).disabled = !box.checked;
      fieldsBox.querySelector(`[data-reject="${CSS.escape(key)}"]`).disabled = !box.checked;
    });
  });

  const invitesBox = panel.querySelector('.bb-invites');
  let inviteCount = 0;
  function addInviteRow() {
    if (inviteCount >= state.batchMaxInvitations) {
      showAlert(`一个批次最多 ${state.batchMaxInvitations} 个邀请。`, 'warning');
      return;
    }
    inviteCount += 1;
    const div = document.createElement('div');
    div.className = 'bb-invite';
    div.innerHTML = `
      <div class="record-main">
        <b>复核人 ${inviteCount}</b>
        <button class="link-button danger-link" type="button" data-remove>移除</button>
      </div>
      <input type="text" maxlength="60" placeholder="邀请名称（如：财务复核）" data-label>
      <div class="bb-scope"></div>`;
    const scope = div.querySelector('.bb-scope');
    const renderScope = () => {
      const selected = [...fieldsBox.querySelectorAll('input[type=checkbox]:checked')].map((b) => b.dataset.key);
      scope.innerHTML = selected.length
        ? selected.map((key) => {
          const meta = fieldOptions.find((f) => (f.step + '.' + f.field) === key);
          return `<label class="bb-scope-field"><input type="checkbox" data-scope-key="${escapeHtml(key)}" checked> ${escapeHtml(meta.label)}</label>`;
        }).join('')
        : '<span class="muted small">请先在上方勾选纳入编排的字段</span>';
    };
    fieldsBox.addEventListener('change', renderScope);
    renderScope();
    div.querySelector('[data-remove]').addEventListener('click', () => {
      div.remove();
      inviteCount -= 1;
    });
    invitesBox.append(div);
  }
  panel.querySelector('[data-add-invite]').addEventListener('click', addInviteRow);
  addInviteRow();
  addInviteRow();

  panel.querySelector('[data-close]').addEventListener('click', () => { panel.innerHTML = ''; });
  panel.querySelector('[data-create]').addEventListener('click', async () => {
    const ttlMinutes = Number(panel.querySelector('#bbTtl').value);
    const note = panel.querySelector('#bbNote').value;
    const fields = [...fieldsBox.querySelectorAll('input[type=checkbox]:checked')].map((box) => {
      const key = box.dataset.key;
      return {
        key,
        acceptThreshold: Number(fieldsBox.querySelector(`[data-accept="${CSS.escape(key)}"]`).value),
        rejectThreshold: Number(fieldsBox.querySelector(`[data-reject="${CSS.escape(key)}"]`).value),
      };
    });
    const invitations = [...invitesBox.querySelectorAll('.bb-invite')].map((div) => ({
      label: div.querySelector('[data-label]').value || '',
      fields: [...div.querySelectorAll('[data-scope-key]:checked')].map((b) => b.dataset.scopeKey),
    }));
    try {
      const result = await api('POST', '/api/review-batches', { receiptNo, ttlMinutes, note, fields, invitations });
      state.reviewBatches = result.reviewBatches || state.reviewBatches;
      state.timeline = result.timeline || state.timeline;
      panel.innerHTML = '';
      showBatchLinks(result);
      showAlert('多方复核批次已创建。请把每个一次性链接分别发给对应复核人（链接只展示这一次）。', 'success');
      render();
    } catch (error) {
      const err = panel.querySelector('#bbError');
      err.textContent = error.message || '创建失败';
      err.classList.remove('hidden');
    }
  });
}

// ---------------------------------------------------------------------------
// 分阶段复核编排：创建 / 启动前调整（携带配置版本号，乐观锁）
// ---------------------------------------------------------------------------

// 打开分阶段编排构建器。editBatch 非空时为“调整编排”：预填当前编排、携带版本号。
async function openStagedBuilder(receiptNo, editBatch = null) {
  if (state.busy) return;
  await ensureBatchFieldOptions();
  const panel = els.batchPanel.querySelector('[data-batch-builder]');
  if (!panel) return;
  const fieldOptions = state.batchFieldOptions;
  const editStages = editBatch && Array.isArray(editBatch.stages)
    ? editBatch.stages.map((stage) => ({
      name: stage.name,
      ttlMinutes: Math.max(1, Math.round(stage.durationMs / 60000)),
      timeoutPolicy: stage.timeoutPolicy,
      fields: stage.fields.map((f) => ({ key: f.key, acceptThreshold: f.acceptThreshold, rejectThreshold: f.rejectThreshold })),
      invitations: stage.invitations.map((inv) => ({ label: inv.label, fields: inv.fields.map((f) => f.key) })),
    }))
    : null;

  panel.innerHTML = `
    <div class="batch-builder card-inner">
      <h3>${editBatch ? '调整分阶段复核编排' : '配置分阶段复核批次'}</h3>
      ${editBatch
        ? `<p class="muted small">基于配置版本 <b>v${editBatch.configVersion}</b> 调整。任何阶段一旦启动即冻结，不能再修改；两个页面同时保存时只有一个成功。</p>`
        : '<p class="muted small">把复核拆成按顺序执行的多个阶段；每阶段独立配置邀请范围、字段范围、阈值、限时与超时策略（三选一）。前一阶段未达终局时后续阶段不能校验、查看或提交意见。</p>'}
      <label>批次备注（可选）<input type="text" id="sbNote" maxlength="200" value="${escapeHtml(editBatch?.note || '')}"></label>
      <div class="bb-section">
        <strong>阶段（按顺序执行）</strong>
        <div class="form-actions"><button class="button secondary" type="button" data-add-stage>增加一个阶段</button></div>
        <div class="sb-stages"></div>
      </div>
      <div id="sbError" class="alert error hidden"></div>
      <div class="form-actions">
        <button class="button primary" type="button" data-save>${editBatch ? '保存调整（乐观锁）' : '创建分阶段批次并生成一次性链接'}</button>
        <button class="button secondary" type="button" data-close>取消</button>
      </div>
    </div>`;

  const stagesBox = panel.querySelector('.sb-stages');
  const fieldChoices = () => fieldOptions.map((opt) => `<option value="${escapeHtml(opt.step + '.' + opt.field)}">${escapeHtml(opt.label)}</option>`).join('');

  function fieldRowHtml(field = null) {
    return `
      <div class="sb-field-row" data-sb-field-row>
        <select data-sb-field-key>${fieldChoices()}</select>
        接受≥<input type="number" min="1" max="5" value="${field?.acceptThreshold ?? 1}" data-sb-accept>
        驳回≥<input type="number" min="1" max="5" value="${field?.rejectThreshold ?? 1}" data-sb-reject>
        <button type="button" class="link-button danger-link" data-sb-remove-field>移除</button>
      </div>`;
  }
  function inviteRowHtml(invite = null) {
    const selected = new Set(invite?.fields || []);
    return `
      <div class="sb-invite" data-sb-invite>
        <div class="record-main"><b>复核邀请</b><button type="button" class="link-button danger-link" data-sb-remove-invite>移除</button></div>
        <input type="text" maxlength="60" placeholder="邀请名称（如：财务复核）" data-sb-invite-label value="${escapeHtml(invite?.label || '')}">
        <div class="sb-scope">${fieldOptions.map((opt) => {
    const key = opt.step + '.' + opt.field;
    return `<label class="bb-scope-field"><input type="checkbox" data-sb-scope value="${escapeHtml(key)}" ${selected.has(key) ? 'checked' : ''}>${escapeHtml(opt.label)}</label>`;
  }).join('')}</div>
      </div>`;
  }
  function stageCardHtml(stage = null, index = 0) {
    const div = document.createElement('div');
    div.className = 'sb-stage card-inner';
    div.dataset.sbStage = '';
    div.innerHTML = `
      <div class="record-main">
        <b>第 <span data-sb-ordinal>${index + 1}</span> 阶段</b>
        <button type="button" class="link-button danger-link" data-sb-remove-stage>移除阶段</button>
      </div>
      <input type="text" maxlength="60" placeholder="阶段名称" data-sb-stage-name value="${escapeHtml(stage?.name || '')}">
      <label>限时（分钟，5-10080）<input type="number" min="5" max="10080" value="${stage?.ttlMinutes ?? 60}" data-sb-ttl></label>
      <label>阶段超时策略（开始时冻结）
        <select data-sb-policy>
          <option value="advance"${stage?.timeoutPolicy === 'advance' ? ' selected' : ''}>自动转入下一阶段（未决字段自动驳回）</option>
          <option value="revoke_unused"${stage?.timeoutPolicy === 'revoke_unused' ? ' selected' : ''}>撤销未使用邀请（办理人仍须完成已收集意见的决议）</option>
          <option value="fail"${stage?.timeoutPolicy === 'fail' ? ' selected' : ''}>标记批次超时失败</option>
        </select>
      </label>
      <div class="sb-fields"><strong>字段范围与阈值</strong><div class="sb-field-list"></div>
        <button type="button" class="link-button" data-sb-add-field>增加字段</button></div>
      <div class="sb-invites"><strong>邀请范围</strong><div class="sb-invite-list"></div>
        <button type="button" class="link-button" data-sb-add-invite>增加邀请</button></div>`;
    const fieldList = div.querySelector('.sb-field-list');
    const inviteList = div.querySelector('.sb-invite-list');
    (stage?.fields || []).forEach((f) => {
      fieldList.insertAdjacentHTML('beforeend', fieldRowHtml(f));
      const row = fieldList.lastElementChild;
      row.querySelector('[data-sb-field-key]').value = f.key;
    });
    (stage?.invitations || []).forEach((inv) => inviteList.insertAdjacentHTML('beforeend', inviteRowHtml(inv)));
    div.addEventListener('click', (event) => {
      if (event.target.matches('[data-sb-add-field]')) fieldList.insertAdjacentHTML('beforeend', fieldRowHtml());
      if (event.target.matches('[data-sb-remove-field]')) event.target.closest('[data-sb-field-row]')?.remove();
      if (event.target.matches('[data-sb-add-invite]')) inviteList.insertAdjacentHTML('beforeend', inviteRowHtml());
      if (event.target.matches('[data-sb-remove-invite]')) event.target.closest('[data-sb-invite]')?.remove();
      if (event.target.matches('[data-sb-remove-stage]')) { div.remove(); renumberStages(); }
    });
    return div;
  }
  function renumberStages() {
    [...stagesBox.children].forEach((card, i) => {
      card.querySelector('[data-sb-ordinal]').textContent = i + 1;
    });
  }
  function addStage(stage) {
    if (stagesBox.children.length >= 5) { showAlert('一个批次最多 5 个阶段。', 'warning'); return; }
    stagesBox.append(stageCardHtml(stage, stagesBox.children.length));
  }
  panel.querySelector('[data-add-stage]').addEventListener('click', () => addStage(null));
  if (editStages) editStages.forEach(addStage); else { addStage(null); addStage(null); }

  panel.querySelector('[data-close]').addEventListener('click', () => { panel.innerHTML = ''; });
  panel.querySelector('[data-save]').addEventListener('click', async () => {
    const stages = [...stagesBox.querySelectorAll('[data-sb-stage]')].map((card) => ({
      name: card.querySelector('[data-sb-stage-name]').value.trim(),
      ttlMinutes: Number(card.querySelector('[data-sb-ttl]').value),
      timeoutPolicy: card.querySelector('[data-sb-policy]').value,
      fields: [...card.querySelectorAll('[data-sb-field-row]')].map((row) => ({
        key: row.querySelector('[data-sb-field-key]').value,
        acceptThreshold: Number(row.querySelector('[data-sb-accept]').value),
        rejectThreshold: Number(row.querySelector('[data-sb-reject]').value),
      })),
      invitations: [...card.querySelectorAll('[data-sb-invite]')].map((inv) => ({
        label: inv.querySelector('[data-sb-invite-label]').value.trim(),
        fields: [...inv.querySelectorAll('[data-sb-scope]:checked')].map((box) => box.value),
      })),
    }));
    const body = { receiptNo, note: panel.querySelector('#sbNote').value, stages };
    const err = panel.querySelector('#sbError');
    err.classList.add('hidden');
    try {
      let result;
      if (editBatch) {
        result = await api('POST', `/api/review-batches/${encodeURIComponent(editBatch.id)}/orchestration`, { ...body, expectedVersion: editBatch.configVersion });
      } else {
        result = await api('POST', '/api/review-batches', body);
      }
      state.reviewBatches = result.reviewBatches || result.batch ? state.reviewBatches.map((b) => (b.id === result.batch.id ? result.batch : b)) : state.reviewBatches;
      state.timeline = result.timeline || state.timeline;
      panel.innerHTML = '';
      showBatchLinks(result);
      showAlert(editBatch ? `编排已更新到 v${result.version}，新的一次性链接如下（旧链接全部失效）。` : '分阶段复核批次已创建。', 'success');
      render();
    } catch (error) {
      if (error.body?.batch) {
        state.reviewBatches = state.reviewBatches.map((b) => (b.id === error.body.batch.id ? error.body.batch : b));
        render();
      }
      err.textContent = error.message || '保存失败';
      err.classList.remove('hidden');
    }
  });
}

// 时间线/批次卡片触发：调整尚未开始的编排（乐观锁版本号）
async function reconfigureBatch(batchId, expectedVersion) {
  const batch = (state.reviewBatches || []).find((b) => b.id === batchId)
    || (await api('GET', `/api/review-batches/${encodeURIComponent(batchId)}`).then((r) => r.batch).catch(() => null));
  if (!batch) { showAlert('批次不存在或已不可用。', 'error'); return; }
  if (!batch.staged) {
    showAlert('该批次不是分阶段编排，暂不支持通过此入口调整；如需变更请取消后重建。', 'warning');
    return;
  }
  await openStagedBuilder(batch.receiptNo, batch);
}

function showBatchLinks(result) {
  const list = result.links.map((link) => `
    <li class="bb-link">
      <div class="record-main"><b>${escapeHtml(link.label)}</b>
        <button class="link-button" type="button" data-copy-link="${escapeHtml(link.invitationId)}">复制该复核人链接</button>
      </div>
      <code class="mono small selectable" data-link-url="${escapeHtml(link.invitationId)}">${escapeHtml(location.origin + link.url)}</code>
    </li>`).join('');
  showAlert(`批次已创建：${result.links.length} 个一次性链接如下，请逐个复制发送（离开后仅可在批次未使用前重新复制）：`, 'success');
  const holder = document.createElement('div');
  holder.className = 'card batch-links-dialog';
  holder.innerHTML = `
    <div class="receipt-head"><h3>批次一次性邀请链接（仅本次完整展示）</h3><button class="button secondary" type="button" data-close-links>知道了</button></div>
    <ul class="batch-link-list">${list}</ul>`;
  holder.querySelectorAll('[data-copy-link]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const link = result.links.find((l) => l.invitationId === btn.dataset.copyLink);
      copyText(location.origin + link.url, '链接已复制');
    });
  });
  holder.querySelector('[data-close-links]').addEventListener('click', () => holder.remove());
  els.batchPanel.prepend(holder);
}

async function copyBatchLink(batch, invitationId) {
  // 完整令牌只在创建当次返回；此处无令牌时无法重建链接，明确提示
  showAlert('出于安全设计，完整邀请链接只在创建批次当次展示；如链接丢失，请撤销该邀请后重新创建批次。', 'warning');
}

// 单个复核邀请同样只在创建当次返回完整链接（数据库仅存哈希）
async function copyReviewLink(invitationId) {
  showAlert('出于安全设计，完整邀请链接只在创建当次展示；如链接丢失，请撤销该邀请后重新创建。', 'warning');
}

async function startBatch(batchId) {
  if (state.busy) return;
  try {
    const result = await api('POST', `/api/review-batches/${encodeURIComponent(batchId)}/start`, {});
    state.reviewBatches = result.reviewBatches || state.reviewBatches;
    state.timeline = result.timeline || state.timeline;
    showAlert('批次已进入复核，复核人可开始提交字段意见。', 'success');
    render();
  } catch (error) {
    if (error.body?.batch) {
      state.reviewBatches = state.reviewBatches.map((b) => (b.id === error.body.batch.id ? error.body.batch : b));
      render();
    }
    showAlert(`进入复核失败：${error.message}`, 'error');
  }
}

async function cancelBatch(batchId) {
  const reason = window.prompt('取消后所有未使用邀请立即失效，已提交意见留档但批次终止。请输入取消原因（可留空）：', '');
  if (reason === null || state.busy) return;
  state.busy = true;
  try {
    const result = await api('POST', `/api/review-batches/${encodeURIComponent(batchId)}/cancel`, { reason });
    state.reviewBatches = result.reviewBatches || state.reviewBatches;
    state.timeline = result.timeline || state.timeline;
    showAlert('批次已取消。', 'warning');
    render();
  } catch (error) {
    showAlert(`取消失败：${error.message}`, 'error');
  } finally {
    state.busy = false;
  }
}

async function revokeBatchInvitation(invitationId) {
  const ok = window.confirm('撤销后该邀请链接立即失效；若批次仍在校验阶段，需取消批次后重建才能补齐复核人。确定撤销吗？');
  if (!ok || state.busy) return;
  state.busy = true;
  try {
    const result = await api('POST', `/api/review-batches/invitations/${encodeURIComponent(invitationId)}/revoke`, {});
    state.reviewBatches = result.reviewBatches || state.reviewBatches;
    showAlert('邀请已撤销。', 'warning');
    await boot();
  } catch (error) {
    showAlert(`撤销失败：${error.message}`, 'error');
  } finally {
    state.busy = false;
  }
}

async function acceptBatchField(batchId, fieldId) {
  const ok = window.confirm(
    '接受该字段的全部意见后，它们将进入同一份新的更正办理（复用进行中的同源更正）：\n\n'
    + '· 接受意见数必须达到批次配置的接受阈值；\n'
    + '· 原回执保持冻结，不会被覆盖；\n'
    + '· 更正完成后生成新回执，时间线展示来源关系。',
  );
  if (!ok || state.busy) return;
  state.busy = true;
  try {
    const result = await api('POST', `/api/review-batches/${encodeURIComponent(batchId)}/fields/${encodeURIComponent(fieldId)}/accept`, {});
    state.reviewBatches = result.reviewBatches || state.reviewBatches;
    state.timeline = result.timeline || state.timeline;
    state.correction = result.correction || state.correction;
    showAlert(result.createdCorrection
      ? '已接受意见并创建新的更正办理记录（关联全部意见），可在更正预览中修改后逐步确认。'
      : '已接受意见，已关联到当前进行中的同源更正办理。', 'success');
    await boot();
  } catch (error) {
    if (error.body?.alreadyDecided && error.body?.field) {
      showAlert('该字段已被另一个页面决议，重复决议被拒绝，已刷新为同一结果。', 'warning');
    } else {
      showAlert(`接受失败：${error.message}`, 'error');
    }
    await boot();
  } finally {
    state.busy = false;
  }
}

async function rejectBatchField(batchId, fieldId) {
  const reason = window.prompt('请填写驳回理由（2-200 字）。驳回需要未提出异议的复核人数达到批次配置的驳回阈值。', '');
  if (reason === null || state.busy) return;
  const trimmed = String(reason).trim();
  if (trimmed.length < 2 || trimmed.length > 200) {
    showAlert('驳回理由需为 2-200 个字符。', 'error');
    return;
  }
  state.busy = true;
  try {
    const result = await api('POST', `/api/review-batches/${encodeURIComponent(batchId)}/fields/${encodeURIComponent(fieldId)}/reject`, { reason: trimmed });
    state.reviewBatches = result.reviewBatches || state.reviewBatches;
    state.timeline = result.timeline || state.timeline;
    showAlert(result.batchCompleted ? '该字段已驳回，全部字段决议完成，批次结束。' : '该字段已驳回，理由已保存。', 'warning');
    await boot();
  } catch (error) {
    if (error.body?.alreadyDecided) {
      showAlert('该字段已被另一个页面决议，重复决议被拒绝，已刷新为同一结果。', 'warning');
    } else {
      showAlert(`驳回失败：${error.message}`, 'error');
    }
    await boot();
  } finally {
    state.busy = false;
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

// ---------------------------------------------------------------------------
// 复核申诉回合（办理人侧）
// ---------------------------------------------------------------------------

async function openAppealBuilder(batchId) {
  if (state.busy) return;
  const panel = els.batchPanel;
  if (!panel) return;
  let data;
  try {
    data = await api('GET', `/api/review-batches/${encodeURIComponent(batchId)}/appealable-fields`);
  } catch (error) {
    showAlert(`读取可申诉字段失败：${error.message}`, 'error');
    return;
  }
  const fields = data.fields || [];
  const reasons = data.reasons || [];
  if (!fields.length) {
    showAlert('该批次没有可申诉的字段：只能针对已经作出驳回决议的字段发起申诉。', 'warning');
    return;
  }
  const existing = document.getElementById('appealBuilder');
  if (existing) existing.remove();

  const builder = document.createElement('div');
  builder.id = 'appealBuilder';
  builder.className = 'batch-builder card-inner';
  const reasonOptions = reasons.map((r) => `<option value="${escapeHtml(r.code)}">${escapeHtml(r.label)}</option>`).join('');
  const fieldRows = fields.map((field) => {
    const evidence = (field.opinions || []).map((op, index) => `
      <label class="appeal-evidence-row">
        <input type="checkbox" data-evidence="${escapeHtml(field.sourceFieldId)}" value="${escapeHtml(op.id)}">
        <span>原复核人${index + 1}（${escapeHtml(op.label)}，仅对办理人显示）：${escapeHtml((op.reason || '').slice(0, 60))}…</span>
      </label>`).join('');
    return `<div class="appeal-field-row" data-source-field="${escapeHtml(field.sourceFieldId)}" data-key="${escapeHtml(field.key)}">
      <label class="bb-field-name">
        <input type="checkbox" data-appeal-field="${escapeHtml(field.key)}">
        <b>${escapeHtml(field.label)}</b>
        <span class="muted small">（${escapeHtml(field.key)}，原批次已驳回${field.decidedByPolicy ? '·超时策略自动驳回' : ''}）</span>
      </label>
      <div class="appeal-field-config">
        <label>申诉理由
          <select data-reason="${escapeHtml(field.key)}">${reasonOptions}</select>
        </label>
        <span class="bb-thresholds">
          接受≥<input type="number" min="1" max="5" value="1" data-accept="${escapeHtml(field.key)}" disabled>
          驳回≥<input type="number" min="1" max="5" value="1" data-reject="${escapeHtml(field.key)}" disabled>
        </span>
      </div>
      <div class="muted small">原驳回理由：${escapeHtml(field.reason || '—')}</div>
      <details class="appeal-evidence-box">
        <summary>允许新复核人查看的原复核证据（${(field.opinions || []).length} 条可选；原复核人将匿名化）</summary>
        ${evidence || '<p class="muted small">该字段原批次没有可披露的证据意见。</p>'}
      </details>
    </div>`;
  }).join('');
  builder.innerHTML = `
    <h3>发起复核申诉回合</h3>
    <p class="muted small">
      申诉回合有独立限时、2-5 个一次性新邀请与独立阈值；只能引用原批次冻结快照，
      不能修改原批次的意见、决议或超时结果。只有原批次的驳回字段可被申诉，每个字段至多一次进行中的申诉。
    </p>
    <label>回合限时（分钟，5-10080）
      <input type="number" id="abTtl" value="60" min="5" max="10080">
    </label>
    <label>备注（可选）
      <input type="text" id="abNote" maxlength="200" placeholder="例如：补充关键证据后的二次复核">
    </label>
    <div class="bb-section">
      <strong>① 选择申诉字段、申诉理由、证据授权与阈值</strong>
      <div class="bb-fields">${fieldRows}</div>
    </div>
    <div class="bb-section">
      <strong>② 配置 2-5 位新复核人邀请</strong>
      <div class="form-actions">
        <button class="button secondary" type="button" data-add-invite>增加一个邀请</button>
        <span class="muted small">每个新邀请独立的一次性链接与申诉字段授权。</span>
      </div>
      <div class="bb-invites"></div>
    </div>
    <div id="abError" class="alert error hidden"></div>
    <div class="form-actions">
      <button class="button primary" type="button" data-create>创建申诉回合并生成一次性链接</button>
      <button class="button secondary" type="button" data-close>取消</button>
    </div>`;
  panel.insertBefore(builder, panel.querySelector('.appeal-list'));

  const fieldsBox = builder.querySelector('.bb-fields');
  const syncSelected = () => {
    const selected = [...fieldsBox.querySelectorAll('input[data-appeal-field]:checked')].map((i) => i.dataset.appealField);
    fieldsBox.querySelectorAll('input[type=checkbox][data-appeal-field]').forEach((box) => {
      const key = box.dataset.appealField;
      fieldsBox.querySelector(`[data-accept="${CSS.escape(key)}"]`).disabled = !box.checked;
      fieldsBox.querySelector(`[data-reject="${CSS.escape(key)}"]`).disabled = !box.checked;
    });
    builder.querySelectorAll('[data-invite-fields]').forEach((holder) => {
      holder.innerHTML = selected.map((key) => `
        <label class="appeal-scope-row">
          <input type="checkbox" value="${escapeHtml(key)}" checked> ${escapeHtml(key)}
        </label>`).join('');
    });
    return selected;
  };
  fieldsBox.addEventListener('change', syncSelected);

  const invitesBox = builder.querySelector('.bb-invites');
  const addInvite = () => {
    const count = invitesBox.children.length;
    if (count >= 5) { showAlert('最多 5 个邀请。', 'warning'); return; }
    const div = document.createElement('div');
    div.className = 'bb-invite card-inner';
    div.innerHTML = `
      <label>新复核人名称<input data-invite-label maxlength="60" value="申诉复核人${count + 1}"></label>
      <div class="muted small">授权字段：</div>
      <div class="appeal-scope" data-invite-fields></div>`;
    invitesBox.append(div);
    syncSelected();
  };
  builder.querySelector('[data-add-invite]').addEventListener('click', addInvite);
  addInvite();
  addInvite();

  builder.querySelector('[data-close]').addEventListener('click', () => builder.remove());
  builder.querySelector('[data-create]').addEventListener('click', async () => {
    const err = builder.querySelector('#abError');
    err.classList.add('hidden');
    const ttlMinutes = Number(builder.querySelector('#abTtl').value);
    const appealFields = [...fieldsBox.querySelectorAll('.appeal-field-row')].flatMap((row) => {
      const key = row.dataset.key;
      if (!row.querySelector(`[data-appeal-field="${CSS.escape(key)}"]`).checked) return [];
      const sourceField = fields.find((f) => f.key === key);
      const evidenceOpinionIds = [...row.querySelectorAll('input[data-evidence]:checked')].map((i) => i.value);
      return [{
        key,
        reason: row.querySelector(`[data-reason="${CSS.escape(key)}"]`).value,
        acceptThreshold: Number(row.querySelector(`[data-accept="${CSS.escape(key)}"]`).value),
        rejectThreshold: Number(row.querySelector(`[data-reject="${CSS.escape(key)}"]`).value),
        evidenceOpinionIds,
      }].map((item) => ({ ...item, _source: sourceField }));
    });
    if (!appealFields.length) {
      err.textContent = '请至少选择一个驳回字段发起申诉。';
      err.classList.remove('hidden');
      return;
    }
    const invitations = [...invitesBox.children].map((row) => ({
      label: String(row.querySelector('[data-invite-label]').value || '').trim(),
      fields: [...row.querySelectorAll('[data-invite-fields] input:checked')].map((i) => i.value),
    }));
    if (invitations.length < 2 || invitations.length > 5) {
      err.textContent = '申诉回合必须配置 2-5 个新复核人邀请。';
      err.classList.remove('hidden');
      return;
    }
    try {
      const result = await api('POST', '/api/review-appeals', {
        batchId,
        ttlMinutes,
        note: String(builder.querySelector('#abNote').value || ''),
        fields: appealFields.map(({ _source, ...rest }) => rest),
        invitations,
      });
      state.reviewAppeals = result.reviewAppeals || state.reviewAppeals;
      state.timeline = result.timeline || state.timeline;
      const links = (result.links || []).map((l) => `${l.label}：${location.origin}${l.url}`).join('\n');
      window.prompt('申诉回合已创建。完整一次性链接仅展示这一次，请立即复制分发：', links);
      builder.remove();
      render();
    } catch (error) {
      err.textContent = error.message || '创建申诉回合失败';
      err.classList.remove('hidden');
    }
  });

  syncSelected();
}

async function cancelAppealRound(roundId) {
  const reason = window.prompt('取消后所有未使用邀请立即失效，写操作全部关闭；已有字段完成申诉决议后不能取消。请输入取消原因（可留空）：', '');
  if (reason === null || state.busy) return;
  try {
    const result = await api('POST', `/api/review-appeals/${encodeURIComponent(roundId)}/cancel`, { reason });
    state.reviewAppeals = result.reviewAppeals || state.reviewAppeals;
    showAlert('申诉回合已取消，历史记录保留。', 'warning');
    render();
  } catch (error) {
    showAlert(`取消申诉回合失败：${error.message}`, 'error');
  }
}

async function acceptAppealField(roundId, fieldId) {
  const ok = window.confirm(
    '接受该申诉字段后，申诉意见将在同一个新的更正办理中与原批次来源关联：\n\n'
    + '· 提出申诉意见的新复核人数必须达到本回合接受阈值；\n'
    + '· 原批次与原回执保持冻结，不会被修改；\n'
    + '· 更正完成后生成新回执并回填来源关系。',
  );
  if (!ok || state.busy) return;
  try {
    const result = await api('POST', `/api/review-appeals/${encodeURIComponent(roundId)}/fields/${encodeURIComponent(fieldId)}/accept`, {});
    state.reviewAppeals = result.reviewAppeals || state.reviewAppeals;
    state.timeline = result.timeline || state.timeline;
    showAlert(result.createdCorrection
      ? '申诉成立：已创建新的更正办理并关联申诉意见与原批次来源。'
      : '申诉成立：已关联到进行中的同源更正办理。', 'success');
    await boot();
  } catch (error) {
    if (error.body?.alreadyDecided) showAlert('该申诉字段已被另一个页面决议，已刷新为同一结果。', 'warning');
    else showAlert(`接受申诉失败：${error.message}`, 'error');
    await boot();
  }
}

async function rejectAppealField(roundId, fieldId) {
  const reason = window.prompt('请填写申诉驳回理由（2-200 字）。驳回需要未提出申诉意见的新复核人数达到本回合驳回阈值。', '');
  if (reason === null || state.busy) return;
  const trimmed = String(reason).trim();
  if (trimmed.length < 2 || trimmed.length > 200) {
    showAlert('驳回理由需为 2-200 个字符。', 'error');
    return;
  }
  try {
    const result = await api('POST', `/api/review-appeals/${encodeURIComponent(roundId)}/fields/${encodeURIComponent(fieldId)}/reject`, { reason: trimmed });
    state.reviewAppeals = result.reviewAppeals || state.reviewAppeals;
    state.timeline = result.timeline || state.timeline;
    showAlert(result.roundCompleted ? '申诉已驳回，回合全部字段决议完成。' : '申诉已驳回，理由已保存。', 'warning');
    await boot();
  } catch (error) {
    if (error.body?.alreadyDecided) showAlert('该申诉字段已被另一个页面决议，已刷新为同一结果。', 'warning');
    else showAlert(`驳回申诉失败：${error.message}`, 'error');
    await boot();
  }
}
