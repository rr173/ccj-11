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
  reviewPanel: $('#reviewPanel'), objectionPanel: $('#objectionPanel'), batchPanel: $('#batchPanel'),
  archivePanel: $('#archivePanel'),
  comparisonPanel: $('#comparisonPanel'),
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
  receiptObjections: [],
  reviewBatches: [],
  reviewAppeals: [],
  mediationPackages: [],
  archives: [],
  archiveRejections: [],
  archiveExports: [],
  archiveComparisons: [],
  replaySessions: [],
  // 重放会话运行态（页面级）：一次性提交令牌、版本号与倒计时；刷新后从服务端重新拉取
  replayRuntime: new Map(),
  auditorOptions: [],
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
  state.receiptObjections = Array.isArray(result.receiptObjections) ? result.receiptObjections : [];
  state.reviewBatches = Array.isArray(result.reviewBatches) ? result.reviewBatches : [];
  state.reviewAppeals = Array.isArray(result.reviewAppeals) ? result.reviewAppeals : [];
  state.mediationPackages = Array.isArray(result.mediationPackages) ? result.mediationPackages : [];
  state.archives = Array.isArray(result.archives) ? result.archives : [];
  state.archiveRejections = Array.isArray(result.archiveRejections) ? result.archiveRejections : [];
  state.archiveExports = Array.isArray(result.archiveExports) ? result.archiveExports : [];
  state.archiveComparisons = Array.isArray(result.archiveComparisons) ? result.archiveComparisons : [];
  state.replaySessions = Array.isArray(result.replaySessions) ? result.replaySessions : [];
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
    state.receiptObjections = [];
    state.reviewBatches = [];
    state.reviewAppeals = [];
    state.mediationPackages = [];
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
    renderObjectionPanel();
    renderReviewPanel();
    renderBatchPanel();
    renderArchivePanel();
    renderComparisonPanel();
    return;
  }
  if (state.viewingReceipt) {
    renderReceipt(state.viewingReceipt);
    renderObjectionPanel();
    renderReviewPanel();
    renderBatchPanel();
    renderArchivePanel();
    renderComparisonPanel();
    return;
  }
  state.viewingReceipt = null;
  els.receiptPanel.classList.add('hidden');
  els.receiptPanel.innerHTML = '';
  if (els.objectionPanel) { els.objectionPanel.classList.add('hidden'); els.objectionPanel.innerHTML = ''; }
  els.reviewPanel.classList.add('hidden');
  els.reviewPanel.innerHTML = '';
  els.batchPanel.classList.add('hidden');
  els.batchPanel.innerHTML = '';
  els.archivePanel.classList.add('hidden');
  els.archivePanel.innerHTML = '';
  els.comparisonPanel.classList.add('hidden');
  els.comparisonPanel.innerHTML = '';
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
    } else if (entry.kind === 'mediationPackage') {
      li.className = 'record-item mediation-item';
      li.append(renderMediationTimelineCard(entry));
    } else if (entry.kind === 'receiptObjection') {
      li.className = 'record-item receipt-objection-item';
      li.append(renderReceiptObjectionTimelineCard(entry));
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

// ---------------------------------------------------------------------------
// 回执撤销与异议处理（办理人侧）
// ---------------------------------------------------------------------------

const RECEIPT_OBJECTION_STATUS = {
  submitted: ['待受理', 'current'],
  accepted: ['已受理', 'confirmed'],
  supplementing: ['待补充材料', 'warn'],
  rejected: ['已驳回', 'invalidated'],
  revoked: ['已确认撤销', 'invalidated'],
};
const RECEIPT_OBJECTION_EVENT_TEXT = {
  'receipt.objection.submitted': '发起异议',
  'receipt.objection.accepted': '受理',
  'receipt.objection.supplement-requested': '要求补充材料',
  'receipt.objection.supplemented': '办理人补充材料',
  'receipt.objection.rejected': '驳回',
  'receipt.objection.revocation-confirmed': '确认撤销',
};

function renderReceiptObjectionTimelineCard(entry) {
  const card = document.createElement('div');
  const [statusText, statusCls] = RECEIPT_OBJECTION_STATUS[entry.status] || [entry.status, 'current'];
  const eventsHtml = (entry.events || []).map((event) => `
    <li class="muted small">
      ${formatTime(event.at)} · ${escapeHtml(RECEIPT_OBJECTION_EVENT_TEXT[event.type] || event.type)}
      （${event.actorRole === 'handler' ? '办理人' : event.actorRole === 'processor' ? '处理人' : escapeHtml(event.actorRole)}${event.actorName ? `：${escapeHtml(event.actorName)}` : ''}）
      ${event.reason ? ` · ${escapeHtml(event.reason)}` : ''}${event.note ? ` · ${escapeHtml(event.note)}` : ''}
    </li>`).join('');
  card.innerHTML = `
    <div class="record-main">
      <span>↳ 撤销异议 <span class="mono small">${escapeHtml(entry.objectionNo)}</span>
        （来源回执 <span class="mono small">${escapeHtml(entry.receiptNo)}</span>）</span>
      <span class="badge ${statusCls}">${statusText}${entry.overdue ? ' · 已逾处理期限' : ''}</span>
    </div>
    <div class="muted small">发起于 ${formatTime(entry.createdAt)} · 处理期限至 ${formatTime(entry.deadlineAt)}
      ${entry.resolvedAt ? ` · 处理完结于 ${formatTime(entry.resolvedAt)}` : ''}</div>
    <details class="batch-history" open>
      <summary class="muted small">处理历史（${(entry.events || []).length} 条，只追加不可覆盖）</summary>
      <ul class="batch-history-list">${eventsHtml}</ul>
    </details>
    <div class="record-actions"></div>`;
  const actions = card.querySelector('.record-actions');
  const detailBtn = document.createElement('button');
  detailBtn.type = 'button';
  detailBtn.className = 'link-button muted-link';
  detailBtn.textContent = '查看异议详情';
  detailBtn.addEventListener('click', () => loadReceiptObjection(entry.objectionNo));
  actions.append(detailBtn);
  if (entry.status === 'supplementing') {
    const supplementBtn = document.createElement('button');
    supplementBtn.type = 'button';
    supplementBtn.className = 'link-button';
    supplementBtn.textContent = '补充材料';
    supplementBtn.addEventListener('click', () => supplementReceiptObjection(entry.objectionNo));
    actions.append(supplementBtn);
  }
  return card;
}

function renderObjectionPanel() {
  const panel = els.objectionPanel;
  if (!panel) return;
  const receiptNo = state.receipt?.receiptNo || state.viewingReceipt?.receiptNo;
  if (!receiptNo) {
    panel.classList.add('hidden');
    panel.innerHTML = '';
    return;
  }
  panel.classList.remove('hidden');
  const receipt = state.receipt?.receiptNo === receiptNo ? state.receipt : state.viewingReceipt;
  const revoked = receipt?.status === 'revoked';
  const objections = (state.receiptObjections || []).filter((o) => o.receiptNo === receiptNo);
  const openObjection = objections.find((o) => ['submitted', 'accepted', 'supplementing'].includes(o.status));

  const cardsHtml = objections.map((o) => {
    const [statusText, statusCls] = RECEIPT_OBJECTION_STATUS[o.status] || [o.status, 'current'];
    const materials = (o.materials || []).map((m) => `
      <li class="muted small">${escapeHtml(m.filename)} · ${m.sizeBytes} 字节 · ${m.lineCount} 行
        · ${m.uploadedByRole === 'handler' ? '办理人' : '处理人'} 上传于 ${formatTime(m.uploadedAt)}</li>`).join('');
    const events = (o.events || []).map((event) => `
      <li class="muted small">
        ${formatTime(event.at)} · ${escapeHtml(RECEIPT_OBJECTION_EVENT_TEXT[event.type] || event.type)}
        （${event.actorRole === 'handler' ? '办理人' : event.actorRole === 'processor' ? '处理人' : escapeHtml(event.actorRole)}）
        ${event.reason ? ` · ${escapeHtml(event.reason)}` : ''}${event.note ? ` · ${escapeHtml(event.note)}` : ''}
      </li>`).join('');
    return `
      <li class="objection-item receipt-objection-card ${o.status}" data-no="${escapeHtml(o.objectionNo)}">
        <div class="record-main">
          <b class="mono">${escapeHtml(o.objectionNo)}</b>
          <span class="badge ${statusCls}">${statusText}${o.overdue ? ' · 已逾期限' : ''}</span>
        </div>
        <div class="muted small">发起于 ${formatTime(o.createdAt)} · 处理期限至 ${formatTime(o.deadlineAt)}
          ${o.assignee ? ` · 处理人：${escapeHtml(o.assignee.displayName)}` : ''}</div>
        <div class="small">异议原因：${escapeHtml(o.reason)}</div>
        ${o.supplementNote ? `<div class="small review-obj-result">处理人要求补充：${escapeHtml(o.supplementNote)}</div>` : ''}
        ${o.resolveNote ? `<div class="small review-obj-result">处理意见：${escapeHtml(o.resolveNote)}（${formatTime(o.resolvedAt)}）</div>` : ''}
        ${o.receiptRevokedAt ? `<div class="small review-obj-result">原回执已于 ${formatTime(o.receiptRevokedAt)} 被撤销，核验接口将返回“已撤销”；冻结快照仍可供审计查看。</div>` : ''}
        <ul class="batch-invite-list">${materials || '<li class="muted small">文本说明加载中…</li>'}</ul>
        <details class="batch-history"><summary class="muted small">完整处理历史（${(o.events || []).length}）</summary>
          <ul class="batch-history-list">${events}</ul></details>
        <div class="record-actions" data-ro-actions="${escapeHtml(o.objectionNo)}"></div>
      </li>`;
  }).join('');

  panel.innerHTML = `
    <div class="receipt-head">
      <h2>回执撤销与异议</h2>
      <span class="muted small">对本回执内容有异议可申请撤销；提交时冻结回执快照，处理期限 7 天</span>
    </div>
    ${revoked
      ? '<p class="muted small">本回执已撤销，不能再发起撤销异议；原始快照仍留档可查。</p>'
      : openObjection
        ? `<p class="muted small">该回执存在一份进行中的异议（<b class="mono">${escapeHtml(openObjection.objectionNo)}</b>：${escapeHtml((RECEIPT_OBJECTION_STATUS[openObjection.status] || [openObjection.status])[0])}），处理完成前不能重复发起。</p>`
        : '<div class="receipt-actions"><button class="button danger" type="button" data-action="new-objection">发起撤销异议（填写原因并上传文本说明）</button></div>'}
    <h3>我的撤销异议</h3>
    <ul class="objection-list">${cardsHtml || '<li class="muted small">尚未发起撤销异议。</li>'}</ul>`;

  panel.querySelector('[data-action="new-objection"]')?.addEventListener('click', () => openObjectionBuilder(receiptNo));
  objections.forEach((o) => {
    const box = panel.querySelector(`[data-ro-actions="${cssEscape(o.objectionNo)}"]`);
    if (!box) return;
    const detailBtn = document.createElement('button');
    detailBtn.type = 'button';
    detailBtn.className = 'link-button muted-link';
    detailBtn.textContent = '刷新详情（处理意见/历史）';
    detailBtn.addEventListener('click', () => loadReceiptObjection(o.objectionNo));
    box.append(detailBtn);
    if (o.status === 'supplementing') {
      const supplementBtn = document.createElement('button');
      supplementBtn.type = 'button';
      supplementBtn.className = 'link-button';
      supplementBtn.textContent = '补充材料（上传文本）';
      supplementBtn.addEventListener('click', () => supplementReceiptObjection(o.objectionNo));
      box.append(supplementBtn);
    }
  });
}

function readTextFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result || '');
      const comma = result.indexOf(',');
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error || new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

async function pickTextAttachment() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.txt,text/plain';
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0];
      if (!file) return resolve(null);
      if (!/\.txt$/i.test(file.name)) {
        showAlert('只允许上传 .txt 纯文本说明。', 'error');
        return resolve(null);
      }
      if (file.size > 64 * 1024) {
        showAlert('文本说明不能超过 64KB。', 'error');
        return resolve(null);
      }
      try {
        const contentBase64 = await readTextFileAsBase64(file);
        resolve({ filename: file.name, contentType: 'text/plain; charset=utf-8', contentBase64 });
      } catch (error) {
        showAlert(error.message || '文件读取失败', 'error');
        resolve(null);
      }
    }, { once: true });
    // 取消选择时 resolve(null)（cancel 事件在文件选择框取消时触发）
    input.addEventListener('cancel', () => resolve(null), { once: true });
    input.click();
  });
}

async function openObjectionBuilder(receiptNo) {
  const reason = window.prompt('请填写异议原因（5-500 字）：', '');
  if (reason === null) return;
  if (reason.trim().length < 5 || reason.trim().length > 500) {
    showAlert('异议原因需为 5-500 个字符。', 'error');
    return;
  }
  const attachment = await pickTextAttachment();
  if (!attachment) {
    showAlert('必须上传一份 .txt 文本说明。', 'error');
    return;
  }
  if (state.busy) return;
  state.busy = true;
  try {
    const result = await api('POST', '/api/receipt-objections', { receiptNo, reason: reason.trim(), attachment });
    state.receiptObjections = result.receiptObjections || state.receiptObjections;
    state.timeline = result.timeline || state.timeline;
    showAlert(`异议已提交，编号 ${result.objection.objectionNo}，请在“我的撤销异议”中查看处理进度。`, 'success');
    await refreshState();
  } catch (error) {
    showAlert(error.message || '发起异议失败', 'error');
    await refreshStateSilent();
  } finally {
    state.busy = false;
  }
}

async function supplementReceiptObjection(objectionNo) {
  const note = window.prompt('请填写补充说明（将与文本材料一并提交给处理人）：', '');
  if (note === null) return;
  if (note.trim().length < 2) {
    showAlert('补充说明至少 2 个字符。', 'error');
    return;
  }
  const attachment = await pickTextAttachment();
  if (!attachment) {
    showAlert('必须上传一份 .txt 文本说明。', 'error');
    return;
  }
  try {
    const result = await api('POST', `/api/receipt-objections/${encodeURIComponent(objectionNo)}/supplement`, {
      note: note.trim(), attachment,
    });
    state.receiptObjections = result.receiptObjections || state.receiptObjections;
    state.timeline = result.timeline || state.timeline;
    showAlert('补充材料已提交，异议回到“已受理”。', 'success');
    await refreshState();
  } catch (error) {
    showAlert(error.message || '补充材料失败', 'error');
    await refreshStateSilent();
  }
}

async function loadReceiptObjection(objectionNo) {
  try {
    const result = await api('GET', `/api/receipt-objections/${encodeURIComponent(objectionNo)}`);
    const index = (state.receiptObjections || []).findIndex((o) => o.objectionNo === objectionNo);
    if (index >= 0) state.receiptObjections[index] = result.objection;
    else state.receiptObjections = [...(state.receiptObjections || []), result.objection];
    render();
    els.objectionPanel?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } catch (error) {
    showAlert(error.message || '异议详情加载失败', 'error');
  }
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
    <div class="mediation-list"></div>
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
  renderMediationSection(panel.querySelector('.mediation-list'), batches, receiptNo);
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
  container.querySelectorAll('[data-mediation-launch]').forEach((btn) => {
    btn.addEventListener('click', () => openMediationBuilder(btn.dataset.mediationLaunch));
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
      ${round.status === 'completed'
        ? `<button class="link-button" type="button" data-mediation-launch="${escapeHtml(round.id)}">从申诉驳回字段生成争议调解包（两层处理）</button>`
        : ''}
      ${canCreate ? '' : ''}
    </div>
    <div class="mediation-builder-slot" data-mediation-builder="${escapeHtml(round.id)}"></div>
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

// ---------------------------------------------------------------------------
// 争议调解包区块：展示调解包↔申诉回合↔原批次关系、两层状态、邀请、倒计时、
// 证据摘要、阈值进度、处理人与审计结果
// ---------------------------------------------------------------------------
function renderMediationSection(container, batches, receiptNo) {
  const packages = (state.mediationPackages || []).filter((pkg) => pkg.receiptNo === receiptNo);
  if (!batches.length || !packages.length) {
    container.innerHTML = '';
    return;
  }
  const rounds = (state.reviewAppeals || []).filter((round) => round.receiptNo === receiptNo);
  const blocks = rounds.map((round) => {
    const roundPackages = packages.filter((pkg) => pkg.roundId === round.id);
    if (!roundPackages.length) return '';
    const cards = roundPackages.map((pkg) => renderMediationPackageCard(pkg, round)).join('');
    return `<div class="appeal-group">
      <h3 class="appeal-group-title">申诉回合 <span class="mono small">${escapeHtml(round.id.slice(0, 12))}…</span> 的争议调解包</h3>
      ${cards}
    </div>`;
  }).join('');
  container.innerHTML = blocks;
  // 简要卡片（列表接口无详情）：需要操作时点开时间线中的完整卡片
}

const MEDIATION_STATUS_TEXT = {
  mediating: '第一层调解中',
  arbitrating: '第二层仲裁中',
  completed: '已完成',
  cancelled: '已取消',
  expired: '第一层超时终结',
  failed: '第二层超时失败',
};
const MEDIATION_TIER_STATUS_TEXT = {
  pending: '未开放', active: '进行中', active_deadline_passed: '限时已到',
  completed: '已完成', skipped: '未升级/已跳过', cancelled: '已取消', timed_out: '已超时', failed: '已失败',
};
const MEDIATION_L1_POLICY_TEXT = { escalate: '自动升级第二层', revoke_unused: '撤销未使用邀请', fail: '超时终结调解包' };
const MEDIATION_L2_POLICY_TEXT = { complete: '自动驳回并完成', revoke_unused: '撤销未使用邀请', fail: '超时终结调解包' };

// 完整卡片由时间线条目渲染（含两层字段详情）；列表中的包只给简要摘要与“查看时间线”
function renderMediationPackageCard(pkg, round) {
  const statusCls = {
    mediating: 'current', arbitrating: 'confirmed', completed: 'confirmed',
    cancelled: 'invalidated', expired: 'invalidated', failed: 'invalidated',
  }[pkg.status] || 'current';
  return `<div class="objection-item batch-card appeal-card mediation-card ${pkg.status}">
    <div class="record-main">
      <span>调解包 <span class="mono small">${escapeHtml(pkg.id.slice(0, 12))}…</span> · 来自申诉回合 <span class="mono small">${escapeHtml(round.id.slice(0, 8))}…</span></span>
      <span class="badge ${statusCls}">${MEDIATION_STATUS_TEXT[pkg.status] || pkg.status}</span>
    </div>
    <div class="muted small">创建于 ${formatTime(pkg.createdAt)}${pkg.note ? ` · 备注：${escapeHtml(pkg.note)}` : ''}</div>
    <div class="muted small">两层字段决议、邀请链接、阈值进度与完整时间线请见下方时间线条目。</div>
  </div>`;
}

// 时间线中的调解包完整卡片：两层状态/邀请/倒计时/字段阈值进度/决议操作/审计事件
function renderMediationTimelineCard(entry) {
  const card = document.createElement('div');
  card.className = `mediation-timeline-card mediation-${entry.status}`;
  const statusText = MEDIATION_STATUS_TEXT[entry.status] || entry.status;
  const statusCls = {
    mediating: 'current', arbitrating: 'confirmed', completed: 'confirmed',
    cancelled: 'invalidated', expired: 'invalidated', failed: 'invalidated',
  }[entry.status] || 'current';

  const tierBlock = (tierView, tier) => {
    if (!tierView) return '';
    const tStatus = MEDIATION_TIER_STATUS_TEXT[tierView.status] || tierView.status;
    const policyMap = tier === 1 ? MEDIATION_L1_POLICY_TEXT : MEDIATION_L2_POLICY_TEXT;
    const countdown = (tierView.status === 'active' || tierView.status === 'active_deadline_passed') && tierView.deadlineAt
      ? ` · 剩余 <b data-countdown="${tierView.deadlineAt}">${formatRemaining(tierView.deadlineAt)}</b>` : '';
    const inviteHtml = (tierView.invitations || []).map((inv) => {
      const invStatus = { active: '待使用', used: '已校验', revoked: '已撤销', expired: '已过期' }[inv.status] || inv.status;
      return `<li class="muted small">${escapeHtml(inv.label)}：${invStatus} · 授权 ${inv.fieldKeys.length} 个字段${inv.usedAt ? ` · 校验于 ${formatTime(inv.usedAt)}` : ''}</li>`;
    }).join('');
    const fieldsHtml = (tierView.fields || []).map((field) => {
      const badge = field.decision === 'accepted'
        ? '<span class="badge confirmed">已接受</span>'
        : field.decision === 'rejected'
          ? '<span class="badge invalidated">已驳回</span>'
          : '<span class="badge current">待决议</span>';
      const opinions = (field.opinions || []).map((o) => `
        <li class="batch-opinion">
          <div class="record-main"><b>${escapeHtml(o.reviewerLabel)}</b><span class="muted small">${formatTime(o.submittedAt)}</span></div>
          <div class="small">${escapeHtml(o.reason)}</div>
        </li>`).join('');
      const evidence = tier === 1 ? (field.evidence || []) : (field.layer1Summary?.evidence || []);
      const evidenceHtml = (evidence || []).map((ev) => `
        <li class="batch-opinion evidence-opinion">
          <div class="record-main"><b>${escapeHtml(ev.alias)}</b><span class="muted small">选中证据 · ${formatTime(ev.originalSubmittedAt)}</span></div>
          <div class="small">${escapeHtml(ev.reason)}</div>
        </li>`).join('');
      const summary = tier === 2 && field.layer1Summary ? `
        <div class="muted small">第一层结论摘要：${field.layer1Summary.layer1Decision === 'rejected' ? '驳回' : '接受'}
          ${field.layer1Summary.layer1DecidedByPolicy ? '（第一层冻结策略自动驳回）' : ''}
          · 第一层意见 ${field.layer1Summary.layer1OpinionCount} 份
          ${field.layer1Summary.layer1RejectedReason ? ` · 理由：${escapeHtml(field.layer1Summary.layer1RejectedReason)}` : ''}
        </div>` : '';
      const originals = tier === 1 ? `
        <div class="muted small">原批次决议：驳回${field.originalBatchDecision?.reason ? `（${escapeHtml(field.originalBatchDecision.reason)}）` : ''}
          ；申诉回合决议：驳回${field.appealDecision?.reason ? `（${escapeHtml(field.appealDecision.reason)}）` : ''}</div>` : '';
      const result = field.correctionReceiptNo
        ? `<div class="small review-obj-result">→ 更正回执 <span class="mono">${escapeHtml(field.correctionReceiptNo)}</span></div>`
        : field.decision === 'rejected'
          ? `<div class="small review-obj-result">${field.decidedByPolicy ? '系统按冻结策略自动驳回：' : '驳回理由：'}${escapeHtml(field.decisionReason || '—')} · 处理人 ${escapeHtml(field.decidedBy || '系统')}</div>`
          : '';
      return `<li class="batch-field mediation-field tier${tier} ${field.decision || 'pending'}">
        <div class="record-main">
          <span>${escapeHtml(field.label)}
            <span class="muted small">（接受阈值 ${field.acceptThreshold} / 驳回阈值 ${field.rejectThreshold}，${field.opinionCount} 份本层意见）</span>
          </span>${badge}
        </div>
        ${originals}${summary}
        <details class="appeal-evidence-box">
          <summary class="muted small">调解包选中证据（${(evidence || []).length} 条，原复核人匿名）</summary>
          <ul class="batch-opinion-list">${evidenceHtml || '<li class="muted small">未选择证据</li>'}</ul>
        </details>
        <div class="muted small">本层意见：</div>
        <ul class="batch-opinion-list">${opinions || '<li class="muted small">暂无意见</li>'}</ul>
        ${result}
        <span class="record-actions" data-mediation-field="${escapeHtml(entry.packageId)}|${escapeHtml(field.id)}|${tier}"></span>
      </li>`;
    }).join('');
    const escalation = tier === 1
      ? `<div class="muted small">升级条件：第一层驳回字段 ≥ <b>${tierView.escalateRejectedCount}</b> 时开放第二层仲裁</div>` : '';
    return `<div class="mediation-tier tier-${tier}">
      <div class="record-main">
        <b>第 ${tier} 层 · ${tier === 1 ? '调解' : '仲裁'}</b>
        <span class="badge ${tierView.status === 'active' ? 'confirmed' : tierView.status === 'pending' ? 'current' : 'invalidated'}">${tStatus} · ${tierView.validatedCount}/${tierView.invitationCount} · 决议 ${tierView.decidedCount}/${tierView.fieldCount}</span>
      </div>
      <div class="muted small">限时 ${Math.round(tierView.durationMs / 60000)} 分钟 · 冻结策略：${escapeHtml(policyMap[tierView.timeoutPolicy] || tierView.timeoutPolicy)}${countdown}</div>
      ${escalation}
      <ul class="batch-invite-list">${inviteHtml}</ul>
      <ul class="batch-field-list">${fieldsHtml}</ul>
    </div>`;
  };

  const correction = entry.correction ? `
    <div class="muted small">关联更正：${escapeHtml(entry.correction.workflowId.slice(0, 10))}… · 第 ${entry.correction.sourceTier} 层接受
      ${entry.correction.correctionReceiptNo ? ` · 新回执 <span class="mono">${escapeHtml(entry.correction.correctionReceiptNo)}</span>` : ' · 进行中'}
    </div>` : '';
  const events = (entry.events || []).length ? `
    <details class="batch-history"><summary class="muted small">调解包审计事件（${entry.events.length}）</summary>
    <ul class="batch-history-list">
      ${entry.events.map((event) => `<li class="muted small">${formatTime(event.at)} · ${escapeHtml(event.type)}</li>`).join('')}
    </ul></details>` : '';

  card.innerHTML = `
    <div class="record-main">
      <span>↳ 争议调解包（申诉回合 <span class="mono small">${escapeHtml(entry.roundId.slice(0, 10))}…</span> · 原批次 <span class="mono small">${escapeHtml(entry.batchId.slice(0, 8))}…</span>）</span>
      <span class="badge ${statusCls}">${statusText}</span>
    </div>
    <div class="muted small">
      创建于 ${formatTime(entry.createdAt)}
      ${entry.escalatedAt ? ` · 升级于 ${formatTime(entry.escalatedAt)}` : ''}
      ${entry.cancelledAt ? ` · 取消于 ${formatTime(entry.cancelledAt)}（${escapeHtml(entry.cancelReason || '—')}）` : ''}
      ${entry.completedAt ? ` · 完成于 ${formatTime(entry.completedAt)}` : ''}
      · 针对回执 <span class="mono">${escapeHtml(entry.receiptNo)}</span>
    </div>
    ${correction}
    ${tierBlock(entry.tier1, 1)}
    ${tierBlock(entry.tier2, 2)}
    ${events}
    <div class="record-actions">
      ${['mediating', 'arbitrating'].includes(entry.status)
        ? `<button class="link-button danger-link" type="button" data-mediation-cancel="${escapeHtml(entry.packageId)}">取消调解包（任何一层尚无字段终局决议时可取消）</button>`
        : ''}
    </div>`;

  card.querySelectorAll('[data-mediation-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => cancelMediationPackage(btn.dataset.mediationCancel));
  });
  card.querySelectorAll('[data-mediation-field]').forEach((slot) => {
    const [packageId, fieldId, tier] = slot.dataset.mediationField.split('|');
    const tierView = tier === '1' ? entry.tier1 : entry.tier2;
    const field = tierView?.fields?.find((f) => f.id === fieldId);
    if (!field || field.decision || tierView.status !== 'active') return;
    const acceptBtn = document.createElement('button');
    acceptBtn.type = 'button';
    acceptBtn.className = 'link-button';
    acceptBtn.textContent = `接受（第${tier === '1' ? '一' : '二'}层，阈值 ${field.acceptThreshold}）`;
    acceptBtn.addEventListener('click', () => acceptMediationField(packageId, fieldId));
    const rejectBtn = document.createElement('button');
    rejectBtn.type = 'button';
    rejectBtn.className = 'link-button muted-link';
    rejectBtn.textContent = `驳回（阈值 ${field.rejectThreshold}）`;
    rejectBtn.addEventListener('click', () => rejectMediationField(packageId, fieldId));
    slot.append(acceptBtn, rejectBtn);
  });
  return card;
}

async function cancelMediationPackage(packageId) {
  const reason = window.prompt('取消后所有未使用邀请立即失效，写操作全部关闭；任何一层已有字段终局决议后不能取消。请输入取消原因（可留空）：', '');
  if (reason === null || state.busy) return;
  try {
    const result = await api('POST', `/api/mediation-packages/${encodeURIComponent(packageId)}/cancel`, { reason });
    state.mediationPackages = result.mediationPackages || state.mediationPackages;
    showAlert('调解包已取消，历史记录保留。', 'warning');
    await boot();
  } catch (error) {
    showAlert(`取消调解包失败：${error.message}`, 'error');
  }
}

async function acceptMediationField(packageId, fieldId) {
  const ok = window.confirm(
    '接受该字段后，本层意见将进入一个新的更正办理，同时关联调解包、上一层结论与原批次来源：\n\n'
    + '· 提出意见的处理人数必须达到本层冻结的接受阈值；\n'
    + '· 第一层接受字段不再交付仲裁；第一层驳回字段达到升级条件才开放第二层；\n'
    + '· 同一调解包至多一份进行中的更正；原批次、申诉回合与原回执保持冻结。',
  );
  if (!ok || state.busy) return;
  try {
    const result = await api('POST', `/api/mediation-packages/${encodeURIComponent(packageId)}/fields/${encodeURIComponent(fieldId)}/accept`, {});
    showAlert(result.escalated
      ? '第一层驳回字段已达到升级条件：第二层仲裁已按冻结快照开放。'
      : result.createdCorrection
        ? '已创建新的更正办理，并关联调解包、上一层结论与原批次来源。'
        : '已关联到该调解包进行中的同源更正办理。', result.escalated ? 'warning' : 'success');
    await boot();
  } catch (error) {
    showAlert(`接受失败：${error.message}`, 'error');
    await boot();
  }
}

async function rejectMediationField(packageId, fieldId) {
  const reason = window.prompt('请填写驳回理由（2-200 字）。驳回需要本层已校验但未提出意见的处理人数达到驳回阈值。', '');
  if (reason === null || state.busy) return;
  const trimmed = String(reason).trim();
  if (trimmed.length < 2 || trimmed.length > 200) {
    showAlert('驳回理由需为 2-200 个字符。', 'error');
    return;
  }
  try {
    const result = await api('POST', `/api/mediation-packages/${encodeURIComponent(packageId)}/fields/${encodeURIComponent(fieldId)}/reject`, { reason: trimmed });
    showAlert(result.escalated
      ? '已驳回且第一层达到升级条件：第二层仲裁已按冻结快照开放。'
      : result.packageCompleted
        ? '已驳回，调解包按本层终局完成（未达到升级条件）。'
        : '驳回理由已保存。', 'warning');
    await boot();
  } catch (error) {
    showAlert(`驳回失败：${error.message}`, 'error');
    await boot();
  }
}

// ---------------------------------------------------------------------------
// 争议调解包构建器（办理人侧）：从已完成申诉回合的驳回字段中选择，
// 配置两层各自的字段范围、阈值、限时、超时策略与一次性邀请
// ---------------------------------------------------------------------------
async function openMediationBuilder(roundId) {
  if (state.busy) return;
  let data;
  try {
    data = await api('GET', `/api/review-appeals/${encodeURIComponent(roundId)}/mediatable-fields`);
  } catch (error) {
    showAlert(`读取可生成调解包的字段失败：${error.message}`, 'error');
    return;
  }
  const source = data.source;
  if (!source || !source.frozen) {
    showAlert('只能为已完成全部字段决议的申诉回合生成调解包。', 'warning');
    return;
  }
  const fields = source.fields || [];
  if (!fields.length) {
    showAlert('该申诉回合没有已驳回字段可生成调解包。', 'warning');
    return;
  }
  const slot = document.querySelector(`[data-mediation-builder="${CSS.escape(roundId)}"]`);
  if (!slot) return;
  slot.innerHTML = '';

  const builder = document.createElement('div');
  builder.className = 'batch-builder card-inner mediation-builder';
  const fieldRows = fields.map((field) => {
    const evidence = (field.evidence || []).map((ev) => `
      <label class="appeal-evidence-row">
        <input type="checkbox" data-evidence value="${escapeHtml(ev.id)}">
        <span>${escapeHtml(ev.alias)}：${escapeHtml((ev.reason || '').slice(0, 60))}…</span>
      </label>`).join('');
    return `<div class="appeal-field-row" data-key="${escapeHtml(field.key)}">
      <label class="bb-field-name">
        <input type="checkbox" data-pkg-field="${escapeHtml(field.key)}" checked>
        <b>${escapeHtml(field.label)}</b>
        <span class="muted small">（${escapeHtml(field.key)}，申诉已驳回）</span>
      </label>
      <div class="muted small">申诉驳回理由：${escapeHtml(field.appealDecisionReason || '—')}</div>
      <details class="appeal-evidence-box">
        <summary>调解包中选中的申诉授权证据（${(field.evidence || []).length} 条可选；原复核人匿名）</summary>
        ${evidence || '<p class="muted small">该申诉字段没有可披露的证据。</p>'}
      </details>
    </div>`;
  }).join('');

  const layerSection = (tier, title, minInvites, maxInvites, policies) => {
    const checkedFields = selectedKeys();
    const fieldThresholds = checkedFields.map((key) => `
      <label class="appeal-scope-row">
        <input type="checkbox" data-${tier}-field="${escapeHtml(key)}" checked>
        ${escapeHtml(key)}
        <span class="bb-thresholds">接受≥<input type="number" min="1" max="${maxInvites}" value="2" data-${tier}-accept="${escapeHtml(key)}">
        驳回≥<input type="number" min="1" max="${maxInvites}" value="2" data-${tier}-reject="${escapeHtml(key)}"></span>
      </label>`).join('');
    const policyOptions = Object.entries(policies).map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
    const escalation = tier === 'l1' ? `
      <label>升级条件：第一层驳回字段 ≥
        <input type="number" min="1" max="5" value="1" data-l1-escalation> 时开放第二层
      </label>` : '';
    return `<div class="mediation-tier-config" data-tier-config="${tier}">
      <h4>${title}</h4>
      <label>本层限时（分钟，5-10080）<input type="number" data-${tier}-ttl value="60" min="5" max="10080"></label>
      <label>超时策略<select data-${tier}-policy>${policyOptions}</select></label>
      ${escalation}
      <div class="muted small">字段范围与阈值（必须是调解包选中字段的子集）</div>
      <div class="appeal-scope" data-${tier}-fields>${fieldThresholds || '<span class="muted small">请先勾选上方调解包字段</span>'}</div>
      <div class="form-actions">
        <button class="button secondary" type="button" data-${tier}-add-invite>增加一个邀请</button>
        <span class="muted small">${minInvites}-${maxInvites} 个一次性邀请</span>
      </div>
      <div data-${tier}-invites></div>
    </div>`;
  };
  const selectedKeys = () => [...builder.querySelectorAll('input[data-pkg-field]:checked')].map((i) => i.dataset.pkgField);

  builder.innerHTML = `
    <h3>生成争议调解包</h3>
    <p class="muted small">
      调解包是只读冻结快照：原批次决议、申诉意见、授权证据与当前更正来源在生成瞬间固定；
      原批次与申诉回合历史不能被改写。第一层 2-5 位新调解人独立收集意见；
      只有第一层驳回字段达到升级条件，第二层 3-5 位仲裁人才会按冻结快照开放。
    </p>
    <label>备注（可选）<input type="text" data-note maxlength="200" placeholder="例如：跨部门争议终局调解"></label>
    <div class="bb-section">
      <strong>① 选择进入调解包的申诉驳回字段与证据</strong>
      <div class="bb-fields">${fieldRows}</div>
    </div>
    <div class="bb-section">
      <strong>② 第一层（调解）配置</strong>
      <div data-tier-l1></div>
    </div>
    <div class="bb-section">
      <strong>③ 第二层（仲裁）配置（第一层升级后才开放；字段必须是第一层子集）</strong>
      <div data-tier-l2></div>
    </div>
    <div class="alert error hidden" data-error></div>
    <div class="form-actions">
      <button class="button primary" type="button" data-create>生成调解包并返回两层一次性链接</button>
      <button class="button secondary" type="button" data-close>取消</button>
    </div>`;
  slot.append(builder);

  const l1Policies = { escalate: '超时自动升级第二层', revoke_unused: '撤销未使用邀请', fail: '超时终结调解包' };
  const l2Policies = { complete: '超时自动驳回并完成', revoke_unused: '撤销未使用邀请', fail: '超时终结调解包' };
  builder.querySelector('[data-tier-l1]').innerHTML = layerSection('l1', '第一层 · 调解（2-5 位调解人）', 2, 5, l1Policies);
  builder.querySelector('[data-tier-l2]').innerHTML = layerSection('l2', '第二层 · 仲裁（3-5 位仲裁人）', 3, 5, l2Policies);

  const syncTierFields = () => {
    const selected = selectedKeys();
    for (const tier of ['l1', 'l2']) {
      const box = builder.querySelector(`[data-${tier}-fields]`);
      const previous = new Set([...box.querySelectorAll('input:checked')].map((i) => i.dataset[`${tier}Field`]));
      const maxInvites = tier === 'l1' ? 5 : 5;
      box.innerHTML = selected.map((key) => `
        <label class="appeal-scope-row">
          <input type="checkbox" data-${tier}-field="${escapeHtml(key)}" ${previous.has(key) || tier === 'l1' ? 'checked' : ''}>
          ${escapeHtml(key)}
          <span class="bb-thresholds">接受≥<input type="number" min="1" max="${maxInvites}" value="2" data-${tier}-accept="${escapeHtml(key)}">
          驳回≥<input type="number" min="1" max="${maxInvites}" value="2" data-${tier}-reject="${escapeHtml(key)}"></span>
        </label>`).join('') || '<span class="muted small">请先勾选上方调解包字段</span>';
      builder.querySelectorAll(`[data-${tier}-invites] .bb-invite`).forEach((invite) => {
        const holder = invite.querySelector('[data-invite-fields]');
        const checked = new Set([...holder.querySelectorAll('input:checked')].map((i) => i.value));
        holder.innerHTML = selected.filter((key) => {
          const tierField = box.querySelector(`[data-${tier}-field="${CSS.escape(key)}"]`);
          return tierField?.checked;
        }).map((key) => `
          <label class="appeal-scope-row"><input type="checkbox" value="${escapeHtml(key)}" ${checked.has(key) || checked.size === 0 ? 'checked' : ''}> ${escapeHtml(key)}</label>
        `).join('');
      });
    }
  };
  builder.querySelector('.bb-fields').addEventListener('change', syncTierFields);

  const addInvite = (tier, minCount) => {
    const box = builder.querySelector(`[data-${tier}-invites]`);
    const count = box.children.length;
    const maxInvites = tier === 'l1' ? 5 : 5;
    if (count >= maxInvites) { showAlert(`第${tier === 'l1' ? '一' : '二'}层最多 ${maxInvites} 个邀请。`, 'warning'); return; }
    const div = document.createElement('div');
    div.className = 'bb-invite card-inner';
    const defaultLabel = `${tier === 'l1' ? '调解人' : '仲裁人'}${count + 1}`;
    div.innerHTML = `
      <label>名称<input data-invite-label maxlength="60" value="${defaultLabel}"></label>
      <div class="muted small">授权字段：</div>
      <div class="appeal-scope" data-invite-fields></div>`;
    box.append(div);
    syncTierFields();
  };
  builder.querySelector('[data-l1-add-invite]').addEventListener('click', () => addInvite('l1'));
  builder.querySelector('[data-l2-add-invite]').addEventListener('click', () => addInvite('l2'));
  addInvite('l1'); addInvite('l1'); addInvite('l1');
  addInvite('l2'); addInvite('l2'); addInvite('l2');
  syncTierFields();

  builder.querySelector('[data-close]').addEventListener('click', () => { slot.innerHTML = ''; });
  builder.querySelector('[data-create]').addEventListener('click', async () => {
    const errBox = builder.querySelector('[data-error]');
    errBox.classList.add('hidden');
    const fail = (message) => { errBox.textContent = message; errBox.classList.remove('hidden'); };
    const selected = selectedKeys();
    if (!selected.length) return fail('请至少选择一个申诉驳回字段。');
    const collectLayer = (tier) => {
      const keys = [...builder.querySelectorAll(`input[data-${tier}-field]:checked`)].map((i) => i.dataset[`${tier}Field`]);
      return {
        ttlMinutes: Number(builder.querySelector(`[data-${tier}-ttl]`).value),
        timeoutPolicy: builder.querySelector(`[data-${tier}-policy]`).value,
        fields: keys.map((key) => ({
          key,
          acceptThreshold: Number(builder.querySelector(`[data-${tier}-accept="${CSS.escape(key)}"]`).value),
          rejectThreshold: Number(builder.querySelector(`[data-${tier}-reject="${CSS.escape(key)}"]`).value),
        })),
        invitations: [...builder.querySelectorAll(`[data-${tier}-invites] .bb-invite`)].map((invite) => ({
          label: String(invite.querySelector('[data-invite-label]').value || '').trim(),
          fields: [...invite.querySelectorAll('[data-invite-fields] input:checked')].map((i) => i.value),
        })),
      };
    };
    const layer1 = collectLayer('l1');
    const layer2 = collectLayer('l2');
    layer1.escalateRejectedCount = Number(builder.querySelector('[data-l1-escalation]').value);
    const packageFields = selected.map((key) => {
      const row = builder.querySelector(`.appeal-field-row[data-key="${CSS.escape(key)}"]`);
      return { key, evidenceOpinionIds: [...row.querySelectorAll('input[data-evidence]:checked')].map((i) => i.value) };
    });
    try {
      const result = await api('POST', '/api/mediation-packages', {
        roundId,
        note: String(builder.querySelector('[data-note]').value || ''),
        fields: packageFields,
        layer1,
        layer2,
      });
      state.mediationPackages = result.mediationPackages || state.mediationPackages;
      state.timeline = result.timeline || state.timeline;
      const links = (result.links || []).map((l) =>
        `${l.tier === 1 ? '第一层调解人' : '第二层仲裁人'} ${l.label}：${location.origin}${l.url}`).join('\n');
      window.prompt('调解包已生成（只读冻结）。两层一次性链接仅展示这一次，第二层链接需在第一层升级后才能使用：', links);
      slot.innerHTML = '';
      render();
    } catch (error) {
      fail(error.message || '生成调解包失败');
    }
  });
}

// ---------------------------------------------------------------------------
// 可验证审计归档（办理人侧面板）
// 展示：归档来源、冻结时间、事件数量、摘要链校验、三种视图权限、导出进度、
// 凭证状态与失败原因；归档与导出内容完全只读。
// ---------------------------------------------------------------------------

const ARCHIVE_SOURCE_TEXT = { batch: '原批次', appeal: '申诉回合', mediation: '调解包', caseGroup: '案件组' };
const ARCHIVE_SOURCES = [
  { type: 'batch', label: '原批次', list: () => state.reviewBatches },
  { type: 'appeal', label: '申诉回合', list: () => state.reviewAppeals },
  { type: 'mediation', label: '调解包', list: () => state.mediationPackages },
  { type: 'caseGroup', label: '案件组', list: () => (state.caseGroups || []) },
];

function archiveSourcesForCurrentReceipt() {
  const receiptNo = currentBatchReceiptNo();
  const out = [];
  for (const source of ARCHIVE_SOURCES) {
    for (const item of source.list()) {
      if (receiptNo && item.receiptNo && item.receiptNo !== receiptNo) continue;
      out.push({ type: source.type, typeLabel: source.label, id: item.id, status: item.status });
    }
  }
  return out;
}

function renderArchivePanel() {
  const panel = els.archivePanel;
  panel.classList.remove('hidden');
  const sources = archiveSourcesForCurrentReceipt();
  const receiptNo = currentBatchReceiptNo();
  const archives = state.archives.filter((a) => !receiptNo || a.receiptNo === receiptNo);
  const rejections = state.archiveRejections.filter((r) => sources.some((s) => s.type === r.sourceType && s.id === r.sourceId));

  panel.innerHTML = `
    <h2>可验证审计归档（只读）</h2>
    <p class="muted small">对已发生的审计事件创建只读归档：创建瞬间冻结事件顺序、来源关系、状态摘要与脱敏规则，并计算可连续校验的摘要链。事件缺口、顺序冲突或来源不一致时拒绝生成并留档。</p>
    <div class="archive-create">
      <label>归档来源
        <select data-archive-source>
          ${sources.length
            ? sources.map((s) => `<option value="${s.type}:${escapeHtml(s.id)}">${s.typeLabel} · ${escapeHtml(s.id.slice(0, 10))}…（${escapeHtml(s.status)}）</option>`).join('')
            : '<option value="">（当前回执暂无可归档来源：需先有原批次/申诉回合/调解包/案件组事件）</option>'}
        </select>
      </label>
      <label class="archive-grants">授权审计员（角色 auditor，按归档创建时快照生效）
        <div data-archive-auditors class="appeal-scope">加载中…</div>
      </label>
      <label>备注（可选）<input data-archive-note maxlength="200" placeholder="本次归档说明"></label>
      <div class="form-actions">
        <button class="button primary" type="button" data-archive-create ${sources.length ? '' : 'disabled'}>创建只读归档</button>
      </div>
      <div class="alert error hidden" data-archive-error></div>
    </div>
    <div data-archive-rejections>
      ${rejections.length ? `<h3>归档拒绝留档（${rejections.length}）</h3>` : ''}
      ${rejections.slice(0, 5).map((r) => `
        <div class="archive-rejection card-inner">
          <b>${escapeHtml(ARCHIVE_SOURCE_TEXT[r.sourceType] || r.sourceType)}</b>
          <span class="tag tag-reject">${escapeHtml(r.reasonCode)}</span>
          <span class="muted small">${formatTime(r.createdAt)}</span>
          <div class="small">${escapeHtml(r.reasonDetail || (r.detail && r.detail.reason) || '')}</div>
        </div>`).join('')}
    </div>
    <div data-archive-list>
      ${archives.map(archiveCardHtml).join('') || '<p class="muted small">尚无归档。</p>'}
    </div>`;

  loadAuditorOptions(panel);
  panel.querySelector('[data-archive-create]')?.addEventListener('click', () => createArchive(panel));
  panel.querySelectorAll('[data-archive-detail-btn]').forEach((btn) => {
    btn.addEventListener('click', () => toggleArchiveDetail(panel, btn.dataset.archiveDetailBtn));
  });
  panel.querySelectorAll('[data-archive-export]').forEach((btn) => {
    btn.addEventListener('click', () => startExport(panel, btn.dataset.archiveExport));
  });
  panel.querySelectorAll('[data-archive-cancel-export]').forEach((btn) => {
    btn.addEventListener('click', () => cancelExport(panel, btn.dataset.archiveCancelExport));
  });
  panel.querySelectorAll('[data-archive-credential]').forEach((btn) => {
    btn.addEventListener('click', () => issueCredential(panel, btn.dataset.archiveCredential));
  });
  panel.querySelectorAll('[data-archive-external]').forEach((btn) => {
    btn.addEventListener('click', () => issueExternalCode(panel, btn.dataset.archiveExternal));
  });
}

function archiveCardHtml(archive) {
  const chain = archive.chain || {};
  const chainText = chain.continuous
    ? '<span class="tag tag-ok">摘要链连续</span>'
    : '<span class="tag tag-reject">摘要链校验失败</span>';
  return `
    <div class="archive-item card-inner" data-archive-card="${escapeHtml(archive.id)}">
      <div class="record-main">
        <b>${escapeHtml(archive.sourceTypeLabel)}归档 v${archive.version}</b>
        <span class="mono small">${escapeHtml(archive.archiveNo)}</span>
        ${chainText}
      </div>
      <div class="muted small">
        来源：${escapeHtml(archive.sourceLabel)} · 冻结于 ${formatTime(archive.frozenAt)} ·
        事件 ${archive.eventCount} 条（${formatTime(archive.firstEventAt)} ～ ${formatTime(archive.lastEventAt)}）
      </div>
      <div class="small archive-perms">
        视图权限（创建时快照）：办理人=完整字段/操作人 · 审计员=脱敏字段/来源关系/摘要链结果 · 外部核验=事件数量/时间范围/摘要链连续性/最终状态
      </div>
      <div class="record-actions">
        <button class="button secondary" type="button" data-archive-detail-btn="${escapeHtml(archive.id)}">查看冻结内容</button>
        <button class="button primary" type="button" data-archive-export="${escapeHtml(archive.id)}">启动后台导出</button>
        <button class="button secondary" type="button" data-archive-external="${escapeHtml(archive.id)}">生成外部一次性核验码</button>
      </div>
      <div data-archive-detail="${escapeHtml(archive.id)}" class="archive-detail hidden"></div>
    </div>`;
}

async function loadAuditorOptions(panel) {
  const box = panel.querySelector('[data-archive-auditors]');
  if (!box) return;
  try {
    if (!state.auditorOptions.length) {
      const result = await api('GET', '/api/archives/auditors');
      state.auditorOptions = result.auditors || [];
    }
    box.innerHTML = state.auditorOptions.length
      ? state.auditorOptions.map((a) => `<label class="appeal-scope-row"><input type="checkbox" value="${escapeHtml(a.username)}"> ${escapeHtml(a.displayName)}（${escapeHtml(a.username)}）</label>`).join('')
      : '<span class="muted small">没有 auditor 角色账号</span>';
  } catch {
    box.innerHTML = '<span class="muted small">审计员列表加载失败</span>';
  }
}

async function createArchive(panel) {
  const errBox = panel.querySelector('[data-archive-error]');
  errBox.classList.add('hidden');
  const raw = String(panel.querySelector('[data-archive-source]').value || '');
  const [sourceType, ...rest] = raw.split(':');
  const sourceId = rest.join(':');
  if (!sourceType || !sourceId) {
    errBox.textContent = '请选择归档来源';
    errBox.classList.remove('hidden');
    return;
  }
  const auditorGrants = [...panel.querySelectorAll('[data-archive-auditors] input:checked')].map((i) => i.value);
  const note = String(panel.querySelector('[data-archive-note]').value || '');
  try {
    await api('POST', '/api/archives', { sourceType, sourceId, note, auditorGrants });
    await refreshState();
    showAlert('只读归档已创建，事件顺序与摘要链已冻结', 'success');
  } catch (error) {
    const detail = error.body?.rejection?.reason || error.body?.error?.detail?.reason || '';
    errBox.textContent = `${error.message}${detail ? `：${detail}` : ''}`;
    errBox.classList.remove('hidden');
    await refreshState();
  }
}

async function refreshState() {
  const result = await api('GET', '/api/state');
  applyState(result);
  render();
}

async function toggleArchiveDetail(panel, archiveId) {
  const slot = panel.querySelector(`[data-archive-detail="${CSS.escape(archiveId)}"]`);
  if (!slot) return;
  if (!slot.classList.contains('hidden')) { slot.classList.add('hidden'); return; }
  try {
    const result = await api('GET', `/api/archives/${archiveId}`);
    const a = result.archive;
    slot.innerHTML = `
      <div class="small"><b>状态摘要：</b><pre class="archive-pre">${escapeHtml(JSON.stringify(a.statusSummary, null, 2))}</pre></div>
      <div class="small"><b>来源关系（${a.provenance.length}）：</b>
        <ul>${a.provenance.map((p) => `<li class="mono small">${escapeHtml(p.from)} → ${escapeHtml(p.to)}（${escapeHtml(p.relation)}）</li>`).join('') || '<li class="muted">无</li>'}</ul>
      </div>
      <div class="small"><b>冻结事件（${a.events.length}）：</b>
        <ol class="archive-events">
          ${a.events.map((e) => `
            <li>
              <span class="mono small">${escapeHtml(e.type)}</span>
              <span class="muted small">${formatTime(e.occurredAt)} · ${escapeHtml(e.actor.role)}：${escapeHtml(e.actor.label)}</span>
              <details><summary class="muted small">事件负载/摘要</summary>
                <pre class="archive-pre">${escapeHtml(JSON.stringify(e.detail, null, 2))}</pre>
                <div class="mono small">hash: ${escapeHtml(e.hash)}</div>
              </details>
            </li>`).join('')}
        </ol>
      </div>
      <div data-export-actions></div>
      <div data-export-list>${(result.exports || []).map((t) => exportItemHtml(t, result.credentialsByTask?.[t.id] || [])).join('') || '<p class="muted small">尚无导出任务。</p>'}</div>`;
    slot.classList.remove('hidden');
    bindExportItemActions(slot, archiveId);
  } catch (error) {
    slot.textContent = error.message;
    slot.classList.remove('hidden');
  }
}

function exportItemHtml(task, credentials = []) {
  const statusTag = {
    queued: '排队中', running: '导出中', completed: '已完成', failed: '失败', cancelled: '已取消', expired: '已过期清理',
  }[task.status] || task.status;
  const progress = task.status === 'completed' ? 100 : task.progress;
  const credentialStatus = { active: '有效（未使用）', used: '已使用', revoked: '已作废', expired: '已过期' };
  return `
    <div class="export-item card-inner" data-export-card="${escapeHtml(task.id)}">
      <div class="record-main"><b>导出任务</b><span class="tag">${escapeHtml(statusTag)}</span>
        <span class="muted small">v${task.archiveVersion} · 分块 ${task.completedChunks}/${task.totalChunks} · ${progress}%</span></div>
      <div class="progress-bar"><div class="progress-fill" style="width:${progress}%"></div></div>
      ${task.failReason ? `<div class="small tag-reject-text">失败原因：${escapeHtml(task.failReason)}</div>` : ''}
      ${task.fileDigest ? `<div class="mono small">文件摘要 v${task.fileVersion}：${escapeHtml(task.fileDigest)}（${task.fileSize} 字节）${task.expiresAt ? ` · 保留至 ${formatTime(task.expiresAt)}` : ''}</div>` : ''}
      ${credentials.length ? `
        <div class="small">下载凭证：
          <ul class="credential-list">
            ${credentials.slice(0, 5).map((c) => `<li><span class="tag ${c.status === 'active' ? 'tag-ok' : c.status === 'used' ? '' : 'tag-reject'}">${escapeHtml(credentialStatus[c.status] || c.status)}</span>
              <span class="muted small">签发 ${formatTime(c.createdAt)}${c.usedAt ? ` · 使用 ${formatTime(c.usedAt)}` : ''} · 失效 ${formatTime(c.expiresAt)}</span></li>`).join('')}
          </ul>
        </div>` : ''}
      <div class="record-actions">
        ${['queued', 'running'].includes(task.status) ? `<button class="button secondary" type="button" data-export-cancel="${escapeHtml(task.id)}">取消任务</button>` : ''}
        ${task.canDownload ? `<button class="button primary" type="button" data-export-credential="${escapeHtml(task.id)}">生成一次性下载凭证</button>` : ''}
      </div>
      <div data-credential-slot></div>
    </div>`;
}

function bindExportItemActions(slot, archiveId) {
  slot.querySelectorAll('[data-export-cancel]').forEach((btn) => {
    btn.addEventListener('click', () => cancelExport(slot, btn.dataset.exportCancel));
  });
  slot.querySelectorAll('[data-export-credential]').forEach((btn) => {
    btn.addEventListener('click', () => issueCredential(slot, btn.dataset.exportCredential));
  });
}

async function startExport(container, archiveId) {
  try {
    const idempotencyKey = randomId().slice(0, 40);
    const result = await api('POST', `/api/archives/${archiveId}/exports`, { idempotencyKey });
    await refreshState();
    const panel = els.archivePanel;
    const detail = panel.querySelector(`[data-archive-detail="${CSS.escape(archiveId)}"]`);
    if (detail && !detail.classList.contains('hidden')) {
      await toggleArchiveDetail(panel, archiveId);
      const reopened = panel.querySelector(`[data-archive-detail="${CSS.escape(archiveId)}"]`);
      reopened.classList.remove('hidden');
    }
    if (result.task.status === 'completed') showAlert('导出已完成（后台任务已从断点处理完毕）', 'success');
    else scheduleExportPolling(archiveId);
  } catch (error) {
    showAlert(error.message, 'error');
    await refreshState();
  }
}

let archivePollTimers = new Map();
function scheduleExportPolling(archiveId) {
  if (archivePollTimers.has(archiveId)) return;
  const timer = setInterval(async () => {
    try {
      const result = await api('GET', `/api/archives/${archiveId}`);
      const task = (result.exports || [])[0];
      if (!task || ['completed', 'failed', 'cancelled', 'expired'].includes(task.status)) {
        clearInterval(timer);
        archivePollTimers.delete(archiveId);
      }
      await refreshStateSilent(archiveId);
    } catch { /* 下次轮询 */ }
  }, 1000);
  archivePollTimers.set(archiveId, timer);
}

async function refreshStateSilent(archiveId) {
  const result = await api('GET', '/api/state');
  applyState(result);
  render();
  const panel = els.archivePanel;
  const detail = panel.querySelector(`[data-archive-detail="${CSS.escape(archiveId)}"]`);
  if (detail && !detail.classList.contains('hidden')) {
    const fresh = await api('GET', `/api/archives/${archiveId}`).catch(() => null);
    if (fresh) {
      const list = detail.querySelector('[data-export-list]');
      if (list) {
        list.innerHTML = (fresh.exports || []).map((t) => exportItemHtml(t, fresh.credentialsByTask?.[t.id] || [])).join('') || '<p class="muted small">尚无导出任务。</p>';
      }
      bindExportItemActions(detail, archiveId);
    }
  }
}

async function cancelExport(container, exportId) {
  try {
    await api('POST', `/api/archives/exports/${exportId}?action=cancel`, {});
    await refreshState();
    showAlert('导出任务已取消，其下载凭证一并作废', 'success');
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

async function issueCredential(container, exportId) {
  try {
    const result = await api('POST', `/api/archives/exports/${exportId}?action=credential`, {});
    const card = (container.closest('[data-export-card]') || document.querySelector(`[data-export-card="${CSS.escape(exportId)}"]`));
    const slot = card?.querySelector('[data-credential-slot]');
    const task = await api('GET', `/api/archives/exports/${exportId}`);
    const downloadUrl = `${location.origin}/api/archives/exports/${encodeURIComponent(exportId)}/download?credential=${encodeURIComponent(result.credential)}`;
    if (slot) {
      slot.innerHTML = `
        <div class="alert success small">
          <div>一次性下载凭证（仅展示这一次，重复使用/取消/过期后均拒绝下载），有效期至 ${formatTime(result.expiresAt)}：</div>
          <div class="mono small word-break">${escapeHtml(result.credential)}</div>
          <div><a class="button primary" href="${escapeHtml(downloadUrl)}">立即下载文件（v${result.fileVersion}）</a></div>
          <div class="muted small">文件摘要：<span class="mono">${escapeHtml(result.fileDigest)}</span></div>
        </div>`;
    }
    showAlert('一次性下载凭证已生成，请立即下载；离开后只能重新生成', 'success');
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

async function issueExternalCode(panel, archiveId) {
  try {
    const result = await api('POST', `/api/archives/${archiveId}/external-code`, {});
    const url = `${location.origin}/archive-verify?a=${encodeURIComponent(archiveId)}`;
    window.prompt(
      `外部一次性核验码（仅展示这一次）。外部核验页面：${url}\n核验页只能看到事件数量、时间范围、摘要链是否连续与最终状态，得不到原文/证件/地址。`,
      result.code,
    );
  } catch (error) {
    showAlert(error.message, 'error');
  }
}

// ===========================================================================
// 归档版本对比 + 受控重放审阅（办理人页面）
// ===========================================================================

const COMPARE_STATUS_TEXT = {
  added: '新增', deleted: '删除', modified: '修改', unchanged: '未变化', unaligned: '无法对齐',
};
const COMPARE_STATUS_CLASS = {
  added: 'tag-ok', deleted: 'tag-reject', modified: 'tag-warn', unchanged: 'tag-muted', unaligned: 'tag-reject',
};
const REPLAY_STATUS_TEXT = {
  active: '进行中', paused: '已暂停', completed: '已完成', cancelled: '已取消', expired: '已过期',
};

function currentReceiptNoForCompare() {
  return currentBatchReceiptNo();
}

function renderComparisonPanel() {
  const panel = els.comparisonPanel;
  panel.classList.remove('hidden');
  const receiptNo = currentReceiptNoForCompare();
  // 同来源版本分组：只能选择同一 sourceType+sourceId 的两个已冻结版本
  const archives = (state.archives || []).filter((a) => !receiptNo || a.receiptNo === receiptNo);
  const groups = new Map();
  for (const archive of archives) {
    const key = `${archive.sourceType}:${archive.sourceId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(archive);
  }
  const groupOptions = [...groups.entries()]
    .filter(([, list]) => list.length >= 2)
    .map(([key, list]) => ({ key, list: [...list].sort((a, b) => a.version - b.version) }));
  const comparisons = (state.archiveComparisons || [])
    .filter((c) => !receiptNo || c.receiptNo === receiptNo);
  const replays = (state.replaySessions || [])
    .filter((r) => comparisons.some((c) => c.id === r.comparisonId));

  panel.innerHTML = `
    <h2>归档版本对比与受控重放审阅（只读）</h2>
    <p class="muted small">选择同一来源的两个已冻结归档版本生成只读比较报告：按事件顺序标出新增/删除/修改/未变化/无法对齐事件，并比较摘要链连续性、来源关系、状态摘要与权限快照。报告生成后不能改写任一归档；可从获准的已对齐事件创建重放审阅会话。</p>
    <div class="archive-create">
      <label>同一来源的两个版本
        <select data-compare-group>
          ${groupOptions.length
            ? groupOptions.map((g) => `<option value="${escapeHtml(g.key)}">${escapeHtml(g.list[0].sourceTypeLabel)} · v${g.list.map((a) => a.version).join('/')}（${g.list.length} 个版本）</option>`).join('')
            : '<option value="">（当前回执需要至少两个同来源归档版本）</option>'}
        </select>
      </label>
      <div data-compare-versions class="compare-versions"></div>
      <label>备注（可选）<input data-compare-note maxlength="200" placeholder="本次比较说明"></label>
      <div class="form-actions">
        <button class="button primary" type="button" data-compare-create ${groupOptions.length ? '' : 'disabled'}>生成只读比较报告</button>
      </div>
      <div class="alert error hidden" data-compare-error></div>
    </div>
    <div data-compare-list>
      <h3>比较报告（${comparisons.length}）</h3>
      ${comparisons.map(comparisonCardHtml).join('') || '<p class="muted small">尚无比较报告。</p>'}
    </div>
    <div data-replay-list>
      <h3>重放审阅会话（${replays.length}）</h3>
      ${replays.map(replayCardHtml).join('') || '<p class="muted small">尚无重放审阅会话。</p>'}
    </div>`;

  const groupSelect = panel.querySelector('[data-compare-group]');
  const versionBox = panel.querySelector('[data-compare-versions]');
  const renderVersionPickers = () => {
    const group = groupOptions.find((g) => g.key === groupSelect.value);
    if (!group) { versionBox.innerHTML = ''; return; }
    const opts = (selected) => group.list.map((a) =>
      `<option value="${escapeHtml(a.id)}" ${a.id === selected ? 'selected' : ''}>v${a.version} · ${escapeHtml(a.archiveNo)} · ${a.eventCount} 事件</option>`).join('');
    versionBox.innerHTML = `
      <label>基准版本（较旧）<select data-compare-base>${opts(group.list[0].id)}</select></label>
      <label>目标版本（较新）<select data-compare-target>${opts(group.list[group.list.length - 1].id)}</select></label>`;
  };
  groupSelect?.addEventListener('change', renderVersionPickers);
  renderVersionPickers();

  panel.querySelector('[data-compare-create]')?.addEventListener('click', () => createComparison(panel));
  panel.querySelectorAll('[data-compare-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => toggleComparisonDetail(panel, btn.dataset.compareToggle));
  });
  panel.querySelectorAll('[data-replay-toggle]').forEach((btn) => {
    btn.addEventListener('click', () => toggleReplayDetail(panel, btn.dataset.replayToggle));
  });
}

function comparisonCardHtml(c) {
  const v = c.verification || {};
  const verifyTag = v.reportOk
    ? '<span class="tag tag-ok">报告校验通过</span>'
    : '<span class="tag tag-reject">报告校验失败</span>';
  const counts = c.counts || {};
  return `
    <div class="archive-item card-inner" data-comparison-card="${escapeHtml(c.id)}">
      <div class="record-main">
        <b>比较报告 ${escapeHtml(c.comparisonNo)}</b>
        <span class="mono small">${escapeHtml(c.base?.archiveNo || '')} v${c.base?.version} ⇄ ${escapeHtml(c.target?.archiveNo || '')} v${c.target?.version}</span>
        ${verifyTag}
      </div>
      <div class="muted small">生成于 ${formatTime(c.createdAt)} · ${escapeHtml(c.sourceType ? ARCHIVE_SOURCE_TEXT[c.sourceType] || c.sourceType : '')}</div>
      <div class="small compare-counts">
        <span class="tag tag-ok">新增 ${counts.added || 0}</span>
        <span class="tag tag-reject">删除 ${counts.deleted || 0}</span>
        <span class="tag tag-warn">修改 ${counts.modified || 0}</span>
        <span class="tag tag-muted">未变化 ${counts.unchanged || 0}</span>
        <span class="tag tag-reject">无法对齐 ${counts.unaligned || 0}</span>
      </div>
      <div class="record-actions">
        <button class="button secondary" type="button" data-compare-toggle="${escapeHtml(c.id)}">查看报告 / 创建重放</button>
      </div>
      <div data-comparison-detail="${escapeHtml(c.id)}" class="archive-detail hidden"></div>
    </div>`;
}

async function createComparison(panel) {
  const errBox = panel.querySelector('[data-compare-error]');
  errBox.classList.add('hidden');
  const baseArchiveId = String(panel.querySelector('[data-compare-base]')?.value || '');
  const targetArchiveId = String(panel.querySelector('[data-compare-target]')?.value || '');
  const note = String(panel.querySelector('[data-compare-note]').value || '');
  if (!baseArchiveId || !targetArchiveId) {
    errBox.textContent = '请选择两个归档版本';
    errBox.classList.remove('hidden');
    return;
  }
  try {
    await api('POST', '/api/archive-comparisons', { baseArchiveId, targetArchiveId, note });
    await refreshState();
    showAlert('只读比较报告已生成；两个归档均未被改写', 'success');
  } catch (error) {
    const side = error.body?.detail?.side ? `（${error.body.detail.side === 'base' ? '基准' : '目标'}版本摘要链失效）` : '';
    errBox.textContent = `${error.message}${side}`;
    errBox.classList.remove('hidden');
  }
}

async function toggleComparisonDetail(panel, comparisonId) {
  const slot = panel.querySelector(`[data-comparison-detail="${CSS.escape(comparisonId)}"]`);
  if (!slot) return;
  if (!slot.classList.contains('hidden')) { slot.classList.add('hidden'); return; }
  slot.innerHTML = '<p class="muted small">加载中…</p>';
  try {
    const { comparison: c } = await api('GET', `/api/archive-comparisons/${comparisonId}`);
    const v = c.verification || {};
    const provenance = c.provenanceDiff || {};
    const statusDiff = c.statusSummaryDiff || { changes: [] };
    const perms = c.permissionSnapshotDiff || {};
    slot.innerHTML = `
      <div class="small compare-verify ${v.reportOk ? 'tag-ok-text' : 'tag-reject-text'}">
        报告校验：${v.reportOk ? '通过（冻结摘要一致）' : '未通过'}；
        基准链 ${v.baseChain?.continuous ? '连续' : '失效'} · 目标链 ${v.targetChain?.continuous ? '连续' : '失效'}
        ${v.reasons?.length ? `<ul>${v.reasons.map((r) => `<li>${escapeHtml(r.reason)}${r.broken ? `（断点 ordinal ${r.broken.ordinal}: ${escapeHtml(r.broken.reason)}）` : ''}</li>`).join('')}</ul>` : ''}
      </div>
      <div class="mono small word-break">报告摘要：${escapeHtml(c.digest)}</div>
      <h4>摘要链连续性</h4>
      <div class="small">基准最终摘要：<span class="mono">${escapeHtml(c.base?.finalHash || '')}</span><br>
        目标最终摘要：<span class="mono">${escapeHtml(c.target?.finalHash || '')}</span><br>
        跨版本顺序${c.chainContinuity?.alignedAcrossVersions ? '可对齐' : '不能完全对齐（见无法对齐条目）'}</div>
      <h4>来源关系差异</h4>
      <div class="small">${provenance.same ? '两版来源关系一致' : `新增关系 ${provenance.added?.length || 0} 条，移除 ${provenance.removed?.length || 0} 条`}
        ${(provenance.added || []).map((p) => `<div class="tag-ok-text small">+ ${escapeHtml(p.from)} → ${escapeHtml(p.to)}（${escapeHtml(p.relation)}）</div>`).join('')}
        ${(provenance.removed || []).map((p) => `<div class="tag-reject-text small">- ${escapeHtml(p.from)} → ${escapeHtml(p.to)}（${escapeHtml(p.relation)}）</div>`).join('')}
      </div>
      <h4>状态摘要差异（${statusDiff.changes?.length || 0} 个字段）</h4>
      ${(statusDiff.changes || []).length ? `<table class="diff-table small">
        <tr><th>字段</th><th>基准 v${c.base?.version}</th><th>目标 v${c.target?.version}</th></tr>
        ${statusDiff.changes.map((d) => `<tr><td class="mono">${escapeHtml(d.field)}</td><td>${escapeHtml(JSON.stringify(d.from))}</td><td>${escapeHtml(JSON.stringify(d.to))}</td></tr>`).join('')}
      </table>` : '<p class="muted small">状态摘要无变化</p>'}
      <h4>权限快照差异</h4>
      <div class="small">${perms.same ? '两版权限快照一致' : ''}
        ${perms.auditorGrantsAdded?.length ? `<div>新增授权审计员：${perms.auditorGrantsAdded.map(escapeHtml).join('、')}</div>` : ''}
        ${perms.auditorGrantsRemoved?.length ? `<div>移除授权审计员：${perms.auditorGrantsRemoved.map(escapeHtml).join('、')}</div>` : ''}
      </div>
      <h4>事件差异（按事件顺序，${c.entries.length}）</h4>
      <div class="small replay-pick">
        <label class="compare-all"><input type="checkbox" data-replay-all> 全选可重放事件</label>
        <ol class="archive-events compare-entries">
          ${c.entries.map((e) => `
            <li data-entry-row="${escapeHtml(e.entryKey)}" class="compare-entry compare-${e.status}">
              <span class="tag ${COMPARE_STATUS_CLASS[e.status] || ''}">${COMPARE_STATUS_TEXT[e.status] || e.status}</span>
              ${['added', 'deleted', 'modified', 'unchanged'].includes(e.status)
                ? `<label class="compare-pick"><input type="checkbox" data-replay-pick="${escapeHtml(e.entryKey)}"> 加入重放</label>`
                : '<span class="tag tag-reject">不可重放</span>'}
              <span class="mono small">${escapeHtml(e.target?.type || e.base?.type || '')}</span>
              <span class="muted small">基准 #${e.base?.ordinal ?? '—'} → 目标 #${e.target?.ordinal ?? '—'}</span>
              ${e.reason ? `<div class="tag-reject-text small">${escapeHtml(e.reason)}</div>` : ''}
            </li>`).join('')}
        </ol>
      </div>
      <div class="form-actions replay-create-row">
        <label>重放有效期（分钟，5-10080）<input type="number" min="5" max="10080" value="60" data-replay-ttl></label>
        <button class="button primary" type="button" data-replay-create="${escapeHtml(c.id)}">用所选事件创建重放审阅会话</button>
      </div>
      <div class="alert error hidden" data-replay-create-error></div>`;

    const allBox = slot.querySelector('[data-replay-all]');
    allBox?.addEventListener('change', () => {
      slot.querySelectorAll('[data-replay-pick]').forEach((box) => { box.checked = allBox.checked; });
    });
    slot.querySelector('[data-replay-create]')?.addEventListener('click', () => createReplaySession(slot, comparisonId));
  } catch (error) {
    slot.textContent = error.message;
    slot.classList.remove('hidden');
  }
}

async function createReplaySession(container, comparisonId) {
  const errBox = container.querySelector('[data-replay-create-error]') || els.comparisonPanel.querySelector('[data-replay-create-error]');
  const entryKeys = [...container.querySelectorAll('[data-replay-pick]:checked')].map((box) => box.dataset.replayPick);
  const ttlMinutes = Number(container.querySelector('[data-replay-ttl]')?.value || 60);
  if (errBox) errBox.classList.add('hidden');
  if (!entryKeys.length) {
    if (errBox) { errBox.textContent = '请至少选择一个已对齐事件'; errBox.classList.remove('hidden'); }
    return;
  }
  try {
    const result = await api('POST', `/api/archive-comparisons/${comparisonId}/replays`, { entryKeys, ttlMinutes, note: '' });
    if (result.submitToken) state.replayRuntime.set(result.replay.id, { submitToken: result.submitToken, submitTokenExpiresAt: result.submitTokenExpiresAt });
    await refreshState();
    showAlert(`重放审阅会话 ${result.replay.replayNo} 已创建（只读冻结副本，v${result.replay.version}）`, 'success');
    const panel = els.comparisonPanel;
    await toggleReplayDetail(panel, result.replay.id, true);
  } catch (error) {
    if (errBox) { errBox.textContent = error.message; errBox.classList.remove('hidden'); }
  }
}

function replayCardHtml(r) {
  const statusText = REPLAY_STATUS_TEXT[r.status] || r.status;
  const tagClass = r.status === 'active' ? 'tag-ok' : r.status === 'paused' ? 'tag-warn' : 'tag-muted';
  return `
    <div class="archive-item card-inner" data-replay-card="${escapeHtml(r.id)}">
      <div class="record-main">
        <b>重放会话 ${escapeHtml(r.replayNo)}</b>
        <span class="tag ${tagClass}">${statusText}</span>
        <span class="muted small">v${r.version}</span>
      </div>
      <div class="muted small">
        ${formatTime(r.createdAt)} ～ 过期 ${formatTime(r.expiresAt)} ·
        已选 ${r.selectedCount} · 已确认 ${r.confirmedCount} · 异议 ${r.objectedCount} · 意见 ${r.commentCount}
      </div>
      <div class="record-actions">
        <button class="button secondary" type="button" data-replay-toggle="${escapeHtml(r.id)}">进入重放审阅</button>
      </div>
      <div data-replay-detail="${escapeHtml(r.id)}" class="archive-detail hidden"></div>
    </div>`;
}

async function toggleReplayDetail(panel, replayId, forceOpen = false) {
  let slot = panel.querySelector(`[data-replay-detail="${CSS.escape(replayId)}"]`);
  if (!slot) {
    await refreshState();
    slot = els.comparisonPanel.querySelector(`[data-replay-detail="${CSS.escape(replayId)}"]`);
  }
  if (!slot) return;
  if (!forceOpen && !slot.classList.contains('hidden')) { slot.classList.add('hidden'); return; }
  await renderReplayDetail(slot, replayId);
}

async function renderReplayDetail(slot, replayId) {
  if (slot._countdownTimer) { clearInterval(slot._countdownTimer); slot._countdownTimer = null; }
  slot.innerHTML = '<p class="muted small">加载中…</p>';
  try {
    const { replay } = await api('GET', `/api/replay-sessions/${replayId}`);
    state.replayRuntime.delete(`${replayId}:stale`);
    const writable = replay.status === 'active';
    const readOnlyNotice = replay.status === 'paused' ? '会话已暂停：暂停期间不能写入意见，恢复前会重新校验报告与归档摘要链。'
      : replay.status === 'cancelled' ? '会话已取消：只读保留，历史意见与审计事件不删除。'
        : replay.status === 'expired' ? '会话已过期：只读保留。' : '';
    const v = replay.verification || {};
    slot.innerHTML = `
      <div class="small ${v.reportOk ? 'tag-ok-text' : 'tag-reject-text'}">
        报告校验：${v.reportOk ? '通过' : '未通过'} · 基准链 ${v.baseChain?.continuous ? '连续' : '失效'} · 目标链 ${v.targetChain?.continuous ? '连续' : '失效'}
      </div>
      <div class="small">会话状态：<b>${REPLAY_STATUS_TEXT[replay.status] || replay.status}</b> · 版本 <b data-replay-version>${replay.version}</b>
        · 进度 ${replay.progress.decided}/${replay.progress.selected}（剩余 ${replay.progress.remaining}）</div>
      <div class="small" data-replay-countdown>过期倒计时：${countdownText(replay.expiresAt)}</div>
      ${readOnlyNotice ? `<div class="alert ${writable ? '' : 'error'} small">${escapeHtml(readOnlyNotice)}</div>` : ''}
      <div class="record-actions">
        ${writable ? '<button class="button secondary" type="button" data-replay-pause>暂停</button>' : ''}
        ${replay.status === 'paused' ? '<button class="button primary" type="button" data-replay-resume>恢复</button>' : ''}
        ${['active', 'paused'].includes(replay.status) ? '<button class="button secondary" type="button" data-replay-cancel>取消会话（只读留档）</button>' : ''}
        <button class="button secondary" type="button" data-replay-refresh>刷新状态 / 重新获取提交令牌</button>
      </div>
      <h4>冻结事件（只读副本，按归档视图脱敏由服务端完成）</h4>
      <ol class="archive-events">
        ${replay.events.map((e) => `
          <li data-replay-event="${escapeHtml(e.entryKey)}" class="replay-event">
            <div class="record-main">
              <span class="mono small">${escapeHtml(e.type)}</span>
              <span class="muted small">#${e.ordinal} · ${escapeHtml(e.actor.role)}：${escapeHtml(e.actor.label)} · ${formatTime(e.occurredAt)}</span>
              ${e.decision === 'confirm' ? '<span class="tag tag-ok">已确认</span>' : e.decision === 'object' ? '<span class="tag tag-reject">已异议</span>' : ''}
            </div>
            <details><summary class="muted small">冻结事件负载</summary><pre class="archive-pre">${escapeHtml(JSON.stringify(e.detail, null, 2))}</pre></details>
            ${writable ? `
            <div class="replay-actions small">
              <input type="text" maxlength="1000" placeholder="添加意见（1-1000 字）" data-replay-comment="${escapeHtml(e.entryKey)}">
              <button type="button" data-replay-op="comment:${escapeHtml(e.entryKey)}">提交意见</button>
              <button type="button" data-replay-op="confirm:${escapeHtml(e.entryKey)}">标记已确认</button>
              <input type="text" maxlength="500" placeholder="异议理由（2-500 字）" data-replay-object="${escapeHtml(e.entryKey)}">
              <button type="button" data-replay-op="object:${escapeHtml(e.entryKey)}">提出异议</button>
            </div>` : ''}
            <ul class="replay-opinions">
              ${replay.opinions.filter((o) => o.entryKey === e.entryKey).map((o) => `
                <li class="small"><span class="tag ${o.kind === 'confirm' ? 'tag-ok' : o.kind === 'object' ? 'tag-reject' : 'tag-warn'}">${o.kind === 'confirm' ? '已确认' : o.kind === 'object' ? '异议' : '意见'}</span>
                  ${escapeHtml(o.comment || o.reason || '')} <span class="muted">${formatTime(o.createdAt)} · v${o.replayVersion}</span></li>`).join('')}
            </ul>
          </li>`).join('')}
      </ol>
      <h4>审计时间线</h4>
      <ol class="archive-events">
        ${replay.auditTimeline.map((a) => `<li class="small"><span class="mono">${escapeHtml(a.type)}</span> <span class="muted">${formatTime(a.createdAt)}</span>
          <pre class="archive-pre">${escapeHtml(JSON.stringify(a.detail))}</pre></li>`).join('')}
      </ol>
      <div class="alert error hidden" data-replay-error></div>`;

    bindReplayActions(slot, replay);
    startReplayCountdown(slot, replay.expiresAt);
  } catch (error) {
    slot.textContent = error.message;
    slot.classList.remove('hidden');
  }
}

function countdownText(expiresAt) {
  const ms = Math.max(0, expiresAt - Date.now());
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  const s = Math.floor((ms % 60000) / 1000);
  return ms <= 0 ? '已过期' : `${h}小时${String(m).padStart(2, '0')}分${String(s).padStart(2, '0')}秒`;
}

function startReplayCountdown(slot, expiresAt) {
  const box = slot.querySelector('[data-replay-countdown]');
  if (!box) return;
  if (slot._countdownTimer) clearInterval(slot._countdownTimer);
  slot._countdownTimer = setInterval(() => {
    if (!document.body.contains(slot)) { clearInterval(slot._countdownTimer); return; }
    box.textContent = `过期倒计时：${countdownText(expiresAt)}`;
  }, 1000);
}

async function ensureSubmitToken(slot, replay) {
  const runtime = state.replayRuntime.get(replay.id);
  if (runtime?.submitToken && runtime.submitTokenExpiresAt > Date.now() + 2000) return runtime.submitToken;
  const result = await api('POST', `/api/replay-sessions/${replay.id}/submit-token`, {});
  state.replayRuntime.set(replay.id, { submitToken: result.submitToken, submitTokenExpiresAt: result.expiresAt });
  return result.submitToken;
}

function bindReplayActions(slot, replay) {
  const showError = (message) => {
    const box = slot.querySelector('[data-replay-error]');
    if (box) { box.textContent = message; box.classList.remove('hidden'); }
    else showAlert(message, 'error');
  };
  const control = async (action, reason = '') => {
    try {
      const submitToken = await ensureSubmitToken(slot, replay);
      const expectedVersion = replay.version;
      const result = await api('POST', `/api/replay-sessions/${replay.id}/${action}`, { submitToken, expectedVersion, reason });
      if (result.nextSubmitToken) state.replayRuntime.set(replay.id, { submitToken: result.nextSubmitToken, submitTokenExpiresAt: result.nextSubmitTokenExpiresAt });
      await refreshState();
      const reopened = els.comparisonPanel.querySelector(`[data-replay-detail="${CSS.escape(replay.id)}"]`);
      if (reopened) await renderReplayDetail(reopened, replay.id);
      showAlert(`重放会话已${action === 'pause' ? '暂停' : action === 'resume' ? '恢复' : '取消'}`, 'success');
    } catch (error) {
      if (error.body?.currentVersion) {
        await refreshState();
        const reopened = els.comparisonPanel.querySelector(`[data-replay-detail="${CSS.escape(replay.id)}"]`);
        if (reopened) await renderReplayDetail(reopened, replay.id);
      }
      showError(error.message);
    }
  };
  slot.querySelector('[data-replay-pause]')?.addEventListener('click', () => control('pause'));
  slot.querySelector('[data-replay-resume]')?.addEventListener('click', () => control('resume'));
  slot.querySelector('[data-replay-cancel]')?.addEventListener('click', () => {
    const reason = window.prompt('取消原因（可选，留空确认取消）', '') ?? null;
    if (reason !== null) control('cancel', reason);
  });
  slot.querySelector('[data-replay-refresh]')?.addEventListener('click', async () => {
    state.replayRuntime.delete(replay.id);
    try { await ensureSubmitToken(slot, replay); } catch { /* 只读/暂停时允许无令牌刷新 */ }
    await renderReplayDetail(slot, replay.id);
  });

  slot.querySelectorAll('[data-replay-op]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const [kind, entryKey] = btn.dataset.replayOp.split(':');
      const comment = String(slot.querySelector(`[data-replay-comment="${CSS.escape(entryKey)}"]`)?.value || '');
      const reason = String(slot.querySelector(`[data-replay-object="${CSS.escape(entryKey)}"]`)?.value || '');
      const idempotencyKey = randomId().slice(0, 40);
      try {
        const submitToken = await ensureSubmitToken(slot, replay);
        const result = await api('POST', `/api/replay-sessions/${replay.id}/opinions`, {
          entryKey, kind, comment, reason, idempotencyKey, submitToken, expectedVersion: replay.version,
        });
        if (result.nextSubmitToken) state.replayRuntime.set(replay.id, { submitToken: result.nextSubmitToken, submitTokenExpiresAt: result.nextSubmitTokenExpiresAt });
        await renderReplayDetail(slot, replay.id);
        if (result.replay) showAlert('幂等重试：返回同一条意见', 'success');
      } catch (error) {
        if (error.body?.currentVersion) {
          // 版本冲突/重复确认：以服务端为准重渲染（两个页面并发时只有一个成功）
          await renderReplayDetail(slot, replay.id);
        }
        showError(error.message);
      }
    });
  });
}
