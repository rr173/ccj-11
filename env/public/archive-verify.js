const $ = (selector) => document.querySelector(selector);

function formatTime(epochMs) {
  if (!epochMs) return '—';
  return new Date(epochMs).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

const params = new URLSearchParams(location.search);
if (params.get('a')) $('#archiveId').value = params.get('a');

$('#verifyForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const errorBox = $('#verifyError');
  errorBox.classList.add('hidden');
  const form = new FormData(event.currentTarget);
  const code = String(form.get('code') || '').trim();
  const archiveId = String(form.get('archiveId') || '').trim();
  try {
    const response = await fetch('/api/archives/external-verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, archiveId }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `核验失败（${response.status}）`);
    renderResult(data.archive);
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.classList.remove('hidden');
    $('#resultView').classList.add('hidden');
  }
});

function renderResult(archive) {
  $('#resultView').classList.remove('hidden');
  const chain = archive.chainContinuous
    ? '<span class="tag tag-ok">摘要链连续，校验通过</span>'
    : '<span class="tag tag-reject">摘要链不连续，归档内容可能被篡改</span>';
  $('#resultBox').innerHTML = `
    <dl class="verify-list">
      <dt>归档编号</dt><dd class="mono">${archive.archiveNo || '—'}</dd>
      <dt>归档来源</dt><dd>${archive.sourceTypeLabel}（只读归档）</dd>
      <dt>冻结时间</dt><dd>${formatTime(archive.frozenAt)}</dd>
      <dt>事件数量</dt><dd>${archive.eventCount} 条</dd>
      <dt>事件时间范围</dt><dd>${formatTime(archive.timeRange.from)} ～ ${formatTime(archive.timeRange.to)}</dd>
      <dt>摘要链校验</dt><dd>${chain}</dd>
      <dt>最终状态</dt><dd>${escapeHtml(archive.finalStatus || '—')}</dd>
    </dl>
    <p class="muted small">外部核验视图不包含任何事件原文、操作人、证件号码或地址信息。核验码已一次性消费，不能重复使用。</p>`;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}
