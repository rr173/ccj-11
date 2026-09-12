const $ = (selector) => document.querySelector(selector);
const els = {
  form: $('#verifyForm'),
  error: $('#verifyError'),
  result: $('#verifyResult'),
  button: $('#verifyBtn'),
};

els.form.addEventListener('submit', verify);

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));
}

function formatTime(epochMs) {
  if (!epochMs) return '—';
  return new Date(epochMs).toLocaleString('zh-CN', { hour12: false });
}

async function verify(event) {
  event.preventDefault();
  hideError();
  els.result.classList.add('hidden');
  els.result.innerHTML = '';
  const data = Object.fromEntries(new FormData(els.form));
  els.button.disabled = true;
  try {
    const response = await fetch('/api/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ receiptNo: String(data.receiptNo || ''), code: String(data.code || '') }),
    });
    let body = null;
    try { body = await response.json(); } catch { /* empty */ }

    if (response.ok && body?.ok) {
      renderSuccess(body.receipt);
      return;
    }
    showError(body?.error?.message || `核验失败（${response.status}）`);
  } catch (error) {
    showError(error.message || '网络错误，请稍后重试');
  } finally {
    els.button.disabled = false;
  }
}

function showError(message) {
  els.error.textContent = message;
  els.error.classList.remove('hidden');
}
function hideError() {
  els.error.textContent = '';
  els.error.classList.add('hidden');
}

function renderSuccess(receipt) {
  const a = receipt.applicant;
  els.result.innerHTML = `
    <div class="status-line">
      <span class="status-pill completed">已完成</span>
      <span class="muted small">核验通过</span>
    </div>
    <h2>核验结果</h2>
    <table class="kv-table">
      <tr><th>回执编号</th><td class="mono">${escapeHtml(receipt.receiptNo)}</td></tr>
      <tr><th>姓名（脱敏）</th><td>${escapeHtml(a.nameMasked)}</td></tr>
      <tr><th>手机号（脱敏）</th><td>${escapeHtml(a.phoneMasked)}</td></tr>
      <tr><th>办理事项</th><td>${escapeHtml(a.matter)}</td></tr>
      <tr><th>最终完成时间</th><td>${escapeHtml(formatTime(a.completedAt))}</td></tr>
      <tr><th>回执状态</th><td>有效（已完成）</td></tr>
    </table>
    <p class="muted small">证件号码与完整地址不在公开核验范围内。本结果仅证明该回执编号与核验码匹配且回执有效。</p>
  `;
  els.result.classList.remove('hidden');
}
