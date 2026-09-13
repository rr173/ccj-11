import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

process.env.DB_PATH = path.join(process.cwd(), 'data', `test-archive-${process.pid}.db`);
process.env.TOKEN_TTL_MS = '600000';
process.env.RECEIPT_SECRET = 'unit-test-archive-secret-fixed-value';
process.env.VERIFY_RATE_MAX = '200';
process.env.REVIEW_INVITE_MIN_TTL_MS = '60000';
process.env.ARCHIVE_EXPORT_CHUNK_SIZE = '2';
process.env.ARCHIVE_SWEEP_MS = '60000';
process.env.ARCHIVE_CREDENTIAL_TTL_MS = String(60 * 60 * 1000);
process.env.ARCHIVE_EXTERNAL_CODE_TTL_MS = String(60 * 60 * 1000);
process.env.NO_AUTO_LISTEN = '1';
for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });

const { server } = await import('../src/server.js');
const { stopArchiveExportSweep } = await import('../src/server.js');
const { db, cryptoId, userQueries } = await import('../src/db.js');
const { hashPassword } = await import('../src/crypto.js');
if (!server.listening) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}
const base = `http://127.0.0.1:${server.address().port}`;

async function request(method, url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base}${url}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  });
  const text = await response.text();
  const type = response.headers.get('content-type') || '';
  let data = {};
  if (type.includes('application/json') && text) data = JSON.parse(text);
  return { status: response.status, headers: response.headers, data, text };
}

function parsePair(header) {
  const cookies = {};
  header.split(/,(?=[^;]+=[^;])/).forEach((part) => {
    const seg = part.split(';')[0];
    const eq = seg.indexOf('=');
    if (eq > 0) cookies[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
  });
  return cookies;
}

async function login(username, password = 'password123') {
  const res = await request('POST', '/api/login', { body: { username, password } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const cookies = parsePair(res.headers.get('set-cookie') || '');
  return {
    username,
    role: res.data.user.role,
    cookie: `sid=${cookies.sid}; csrf=${cookies.csrf}`,
    sid: cookies.sid,
    csrf: res.data.csrfToken,
  };
}
function auth(client, extra = {}) {
  return { ...extra, headers: { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, ...(extra.headers || {}) } };
}
function randomId() {
  return crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}

const PAYLOADS = (phone = '13800138000', secret = 'ARCHIVE-SECRET-ID-001') => ([
  { name: '归档测试人', idNumber: secret, phone },
  { province: '浙江省', city: '杭州市', detail: '归档秘密地址 1 号' },
  { type: 'change', description: '归档测试事项说明' },
  { agreed: true, contactTime: '工作日' },
]);

async function confirmStep(client, workflow, payload) {
  const step = workflow.progress;
  const pageId = randomId();
  const tokenRes = await request('POST', '/api/tokens', auth(client, { body: { step, pageId } }));
  assert.equal(tokenRes.status, 200, JSON.stringify(tokenRes.data));
  const res = await request('POST', '/api/submissions', auth(client, {
    body: { step, pageId, token: tokenRes.data.token, idempotencyKey: randomId(), payload },
  }));
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}
async function completeAll(client, payloads = PAYLOADS()) {
  let state = (await request('GET', '/api/state', auth(client))).data;
  let workflow = state.workflow;
  let receipt = state.receipt || null;
  while (!workflow.completed) {
    const result = await confirmStep(client, workflow, payloads[workflow.progress]);
    workflow = result.workflow;
    if (result.receipt) receipt = result.receipt;
  }
  return { workflow, receipt };
}
// 每个测试使用独立办理人账号，彻底隔离同一 DB 内跨测试的办理/回执/批次状态
async function freshHandler(prefix) {
  const username = `h_${prefix}_${process.pid}_${Date.now().toString(36)}`;
  const { salt, hash } = hashPassword('password123');
  db.prepare(`
    INSERT INTO users (id, username, display_name, role, password_salt, password_hash, created_at)
    VALUES (?, ?, ?, 'handler', ?, ?, ?)
  `).run(cryptoId(), username, `${prefix}办理人`, salt, hash, Date.now());
  return login(username);
}

async function abandonIfAny(client) {
  const state = (await request('GET', '/api/state', auth(client))).data;
  if (state.workflow && !state.workflow.completed && state.workflow.sourceReceiptNo) {
    await request('POST', '/api/corrections?action=abandon', auth(client, { body: {} }));
  }
}

// 准备一个已完成、带已驳回字段的原批次（2 邀请、2 字段，均驳回）
async function setupRejectedBatch(client, receiptNo) {
  const created = await request('POST', '/api/review-batches', auth(client, {
    body: {
      receiptNo,
      ttlMinutes: 60,
      note: '归档前置批次',
      fields: [
        { key: '0.phone', acceptThreshold: 1, rejectThreshold: 1 },
        { key: '2.description', acceptThreshold: 1, rejectThreshold: 1 },
      ],
      invitations: [
        { label: '原复核人A', fields: ['0.phone', '2.description'] },
        { label: '原复核人B', fields: ['0.phone', '2.description'] },
      ],
    },
  }));
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const batchId = created.data.batch.id;
  async function validateBatch(token) {
    const res = await request('POST', '/api/batch-review/validate', { body: { token } });
    assert.equal(res.status, 200, JSON.stringify(res.data));
    const cookies = parsePair(res.headers.get('set-cookie') || '');
    return { cookie: `bid=${cookies.bid || ''}; bcsrf=${cookies.bcsrf || ''}`, csrf: res.data?.csrfToken || '' };
  }
  async function submitBatch(session, key, reason) {
    return request('POST', '/api/batch-review/opinions', {
      headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrf },
      body: { key, reason, idempotencyKey: randomId() },
    });
  }
  const s1 = await validateBatch(created.data.links[0].token);
  const s2 = await validateBatch(created.data.links[1].token);
  await submitBatch(s1, '0.phone', '原证据A：手机号末位应核对');
  await submitBatch(s2, '2.description', '原证据B：事项说明需要补充');
  const detail = await request('GET', `/api/review-batches/${batchId}`, auth(client));
  for (const f of detail.data.batch.fields) {
    const r = await request('POST', `/api/review-batches/${batchId}/fields/${f.id}/reject`, auth(client, {
      body: { reason: '核对原申报内容无误，驳回该意见' },
    }));
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  return { batchId };
}

async function createArchive(client, sourceType, sourceId, extra = {}) {
  const res = await request('POST', '/api/archives', auth(client, {
    body: { sourceType, sourceId, note: '测试归档', ...extra, auditorGrants: extra.auditorGrants ?? ['auditor1'] },
  }));
  return res;
}

// ① 正常创建归档：冻结事件顺序、摘要链；归档后新增事件不改变冻结内容
test('归档创建冻结事件与摘要链，之后新增事件不改变归档', async () => {
  const client = await freshHandler('t1');
  const { receipt } = await completeAll(client);
  const { batchId } = await setupRejectedBatch(client, receipt.receiptNo);

  const created = await createArchive(client, 'batch', batchId);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const archive = created.data.archive;
  assert.equal(archive.sourceType, 'batch');
  assert.equal(archive.version, 1);
  assert.ok(archive.archiveNo.startsWith('GD-'));
  assert.ok(archive.eventCount >= 8, `事件数应包含创建/校验/意见/决议等，实际 ${archive.eventCount}`);
  assert.equal(archive.chain.continuous, true);
  assert.equal(archive.chain.broken, null);
  const frozenCount = archive.eventCount;
  const frozenLastHash = archive.finalHash;
  const frozenLastEventAt = archive.lastEventAt;

  // 归档后原批次/业务上再发生新事件（撤销一个未使用邀请不可能：均已校验；改由再归档 v2 前写审计事件）
  // 通过发起一次复核申诉回合再取消，产生新的 review.appeal.* 事件（属于同批次）
  const appeal = await request('POST', '/api/review-appeals', auth(client, {
    body: {
      batchId,
      ttlMinutes: 60,
      note: '归档后新增事件',
      fields: [{ key: '0.phone', reason: 'misjudged', acceptThreshold: 1, rejectThreshold: 2, evidenceOpinionIds: [] }],
      invitations: [{ label: '申诉新复核人1', fields: ['0.phone'] }, { label: '申诉新复核人2', fields: ['0.phone'] }],
    },
  }));
  assert.equal(appeal.status, 200, JSON.stringify(appeal.data));
  const roundId = appeal.data.round.id;
  const cancelled = await request('POST', `/api/review-appeals/${roundId}/cancel`, auth(client, { body: { reason: '归档后取消' } }));
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));

  const refetched = (await request('GET', `/api/archives/${archive.id}`, auth(client))).data.archive;
  assert.equal(refetched.eventCount, frozenCount, '冻结事件数不变');
  assert.equal(refetched.finalHash, frozenLastHash, '冻结最终摘要不变');
  assert.equal(refetched.lastEventAt, frozenLastEventAt, '冻结时间范围不变');
  assert.equal(refetched.chain.continuous, true);
  // 重新归档同来源得到 v2，事件更多；v1 原样保留
  const v2 = await createArchive(client, 'batch', batchId, { note: '第二版' });
  assert.equal(v2.status, 200, JSON.stringify(v2.data));
  assert.equal(v2.data.archive.version, 2);
  assert.ok(v2.data.archive.eventCount > frozenCount);
  const v1Again = (await request('GET', `/api/archives/${archive.id}`, auth(client))).data.archive;
  assert.equal(v1Again.eventCount, frozenCount);
  assert.equal(v1Again.version, 1);
});

// ② 事件来源不一致时归档生成被拒绝并留档（注入一条归属伪造事件）
test('来源不一致 / 顺序冲突时归档被拒绝并留档', async () => {
  const client = await freshHandler('t2');
  const { receipt } = await completeAll(client, PAYLOADS('13800138001', 'BOB-SECRET-ID-002'));
  const { batchId } = await setupRejectedBatch(client, receipt.receiptNo);

  // 直接向 events 注入一条“来源不一致”的调解包事件（packageId 不属于任何真实调解链）。
  // 注入到批次最后一条事件与冻结时刻之间，确保被收集（created_at <= freezeAt）。
  const workflowId = (await request('GET', '/api/state', auth(client))).data.workflow.id;
  const lastBatchEvent = db.prepare(`
    SELECT created_at FROM events
    WHERE workflow_id = ? AND type LIKE 'review.batch.%' ORDER BY id DESC LIMIT 1
  `).get(workflowId);
  db.prepare(`
    INSERT INTO events (workflow_id, type, step, detail_json, created_at)
    VALUES (?, 'review.mediation.created', NULL, ?, ?)
  `).run(
    workflowId,
    JSON.stringify({ receiptNo: receipt.receiptNo, packageId: 'fake-package-id-1234567890', roundId: 'fake-round-id-1234567890', batchId, fields: [], layer1: {}, layer2: {} }),
    lastBatchEvent.created_at + 1,
  );

  const rejected = await createArchive(client, 'batch', batchId);
  assert.equal(rejected.status, 409, JSON.stringify(rejected.data));
  assert.equal(rejected.data.error.code, 'ARCHIVE_SOURCE_INCONSISTENT');
  assert.ok(rejected.data.rejection.reason.includes('调解包不存在'));

  const state = (await request('GET', '/api/state', auth(client))).data;
  const rej = state.archiveRejections.find((r) => r.sourceType === 'batch' && r.sourceId === batchId);
  assert.ok(rej, '拒绝原因必须留档');
  assert.equal(rej.reasonCode, 'ARCHIVE_SOURCE_INCONSISTENT');

  // 移除伪造来源事件，再注入一条时间顺序冲突的事件
  db.prepare("DELETE FROM events WHERE type = 'review.mediation.created' AND detail_json LIKE '%fake-package-id%'").run();
  // 顺序冲突：注入一条 created_at 早于批次起始事件的同批次事件
  const batchCreated = db.prepare(`
    SELECT created_at FROM events
    WHERE workflow_id = ? AND type = 'review.batch.created' ORDER BY id ASC LIMIT 1
  `).get(workflowId);
  db.prepare(`
    INSERT INTO events (workflow_id, type, step, detail_json, created_at)
    VALUES (?, 'review.batch.opinion.submitted', NULL, ?, ?)
  `).run(
    workflowId,
    JSON.stringify({ receiptNo: receipt.receiptNo, batchId, invitationId: 'inv-x', batchFieldId: 'f-x', label: 'x', step: 0, field: 'phone' }),
    batchCreated.created_at - 5000,
  );
  const conflict = await createArchive(client, 'batch', batchId);
  assert.equal(conflict.status, 409);
  assert.equal(conflict.data.error.code, 'ARCHIVE_EVENT_ORDER_CONFLICT');
});

// ③ 三种视图脱敏边界
test('办理人/审计员/外部核验三种视图边界', async () => {
  const owner = await freshHandler('t3');
  const { receipt } = await completeAll(owner, PAYLOADS('13800138002', 'CAROL-SECRET-ID-003'));
  const { batchId } = await setupRejectedBatch(owner, receipt.receiptNo);
  const created = await createArchive(owner, 'batch', batchId);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const archiveId = created.data.archive.id;

  // 办理人视图：完整字段与操作人
  const ownerView = (await request('GET', `/api/archives/${archiveId}`, auth(owner))).data.archive;
  const opinionEvent = ownerView.events.find((e) => e.type === 'review.batch.opinion.submitted');
  assert.ok(opinionEvent);
  assert.ok(opinionEvent.detail.label, '办理人可见邀请标签（操作人）');
  assert.equal(opinionEvent.actor.label.length > 0, true);

  // 归档响应整段不得含证件号/详细地址原文（事件流本身不记录这些；双保险断言）
  const ownerText = JSON.stringify(ownerView);
  assert.ok(!ownerText.includes('CAROL-SECRET-ID-003'), '证件号原文不得出现在归档视图');
  assert.ok(!ownerText.includes('归档秘密地址 1 号'), '地址原文不得出现在归档视图');

  // 审计员视图（auditor1 被授权）：脱敏字段、来源关系、摘要链校验结果；无操作人标签/逐字理由
  const auditor = await login('auditor1');
  const auditorList = await request('GET', '/api/auditor/archives', auth(auditor));
  assert.equal(auditorList.status, 200);
  assert.ok(auditorList.data.archives.some((a) => a.id === archiveId));
  const auditorView = (await request('GET', `/api/auditor/archives/${archiveId}`, auth(auditor))).data.archive;
  assert.equal(auditorView.view, 'auditor');
  assert.equal(auditorView.chain.continuous, true);
  assert.ok(Array.isArray(auditorView.provenance) && auditorView.provenance.length >= 0);
  for (const event of auditorView.events) {
    assert.equal(event.actor.label, '', '审计员视图不得包含操作人身份');
    const json = JSON.stringify(event.detail);
    assert.ok(!json.includes('"reason"'), `逐字理由必须剥离：${event.type}`);
    assert.ok(!json.includes('原复核人'), `邀请标签必须遮罩：${event.type} ${json}`);
  }
  const auditorText = JSON.stringify(auditorView);
  assert.ok(!auditorText.includes('CAROL-SECRET-ID-003'));
  assert.ok(!auditorText.includes('核对原申报内容无误'), '驳回理由逐字内容不得下发给审计员');

  // 未授权审计员：看不到该归档
  const outsider = await login('auditor2');
  const forbidden = await request('GET', `/api/auditor/archives/${archiveId}`, auth(outsider));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.data.error.code, 'ARCHIVE_VIEW_FORBIDDEN');
  const outsiderList = await request('GET', '/api/auditor/archives', auth(outsider));
  assert.ok(!outsiderList.data.archives.some((a) => a.id === archiveId));

  // 审计员不能访问办理人接口
  const ownerApiForAuditor = await request('GET', `/api/archives/${archiveId}`, auth(auditor));
  assert.equal(ownerApiForAuditor.status, 404);

  // 外部核验：只能看到事件数量/时间范围/摘要链连续性/最终状态
  const codeRes = await request('POST', `/api/archives/${archiveId}/external-code`, auth(owner, { body: {} }));
  assert.equal(codeRes.status, 200, JSON.stringify(codeRes.data));
  const code = codeRes.data.code;
  const verify1 = await request('POST', '/api/archives/external-verify', { body: { code, archiveId } });
  assert.equal(verify1.status, 200, JSON.stringify(verify1.data));
  const ext = verify1.data.archive;
  assert.equal(ext.eventCount, ownerView.eventCount);
  assert.equal(ext.chainContinuous, true);
  assert.equal(ext.finalStatus, 'completed');
  assert.ok(ext.timeRange.from && ext.timeRange.to);
  const extKeys = Object.keys(ext).sort().join(',');
  assert.equal(extKeys, ['archiveNo', 'chainContinuous', 'eventCount', 'finalStatus', 'frozenAt', 'sourceType', 'sourceTypeLabel', 'timeRange', 'view'].sort().join(','));
  const extText = JSON.stringify(ext);
  assert.ok(!extText.includes('CAROL-SECRET-ID-003'));
  assert.ok(!extText.includes('归档秘密地址'));
  assert.ok(!extText.includes('review.batch.created'), '外部视图不得包含任何事件原文/类型明细');

  // 一次性核验码重复使用被拒绝
  const verify2 = await request('POST', '/api/archives/external-verify', { body: { code, archiveId } });
  assert.equal(verify2.status, 410);
  assert.equal(verify2.data.error.code, 'EXTERNAL_CODE_USED');
});

// ④ 导出：并发只成功一个、幂等键回放、进度、取消拒绝下载
test('导出并发唯一/幂等/取消后凭证与下载拒绝', async () => {
  const client = await freshHandler('t4');
  const { receipt } = await completeAll(client, PAYLOADS('13800138003', 'DAVE-SECRET-ID-004'));
  const { batchId } = await setupRejectedBatch(client, receipt.receiptNo);
  const archive = (await createArchive(client, 'batch', batchId)).data.archive;

  // 两个页面用不同幂等键并发启动：只有一个成功
  const keyA = randomId();
  const keyB = randomId();
  const [a, b] = await Promise.all([
    request('POST', `/api/archives/${archive.id}/exports`, auth(client, { body: { idempotencyKey: keyA } })),
    request('POST', `/api/archives/${archive.id}/exports`, auth(client, { body: { idempotencyKey: keyB } })),
  ]);
  const ok = [a, b].filter((r) => r.status === 200);
  const conflict = [a, b].find((r) => r.status === 409);
  assert.equal(ok.length, 1, `并发启动应有且仅有一个成功：${a.status}/${b.status}`);
  assert.ok(conflict);
  assert.equal(conflict.data.error.code, 'EXPORT_ALREADY_RUNNING');

  // 相同幂等键回放：返回同一任务
  const replay = await request('POST', `/api/archives/${archive.id}/exports`, auth(client, { body: { idempotencyKey: keyA } }));
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replay, true);
  assert.equal(replay.data.task.id, ok[0].data.task.id);

  // 幂等键换归档使用被拒绝（用新归档 v2 也同 source；这里直接验证键冲突）
  const keyConflict = await request('POST', `/api/archives/${archive.id}/exports`, auth(client, { body: { idempotencyKey: keyB } }));
  // keyB 的请求当时冲突未落任务行 → 返回 EXPORT_ALREADY_RUNNING（已有进行中任务）
  assert.equal(keyConflict.status, 409);

  // 任务推进到完成（分块大小为 2，事件数较多 → 多分块；同步跑至完成）
  let task = ok[0].data.task;
  const { runExportToCompletion } = await import('../src/db.js');
  task = runExportToCompletion(task.id);
  assert.equal(task.status, 'completed', JSON.stringify(task));
  assert.equal(task.progress, 100);
  assert.equal(task.completedChunks, task.totalChunks);
  assert.ok(task.fileDigest);
  assert.ok(task.expiresAt > Date.now());

  // 未完成任务不存在第二份；再次启动同归档导出（无进行中）允许新任务 —— 先不验证，改为下载凭证流
  // 下载凭证一次性
  const cred = await request('POST', `/api/archives/exports/${task.id}?action=credential`, auth(client, { body: {} }));
  assert.equal(cred.status, 200, JSON.stringify(cred.data));
  assert.equal(cred.data.fileVersion, 1);
  const credential = cred.data.credential;
  const dl1 = await request('GET', `/api/archives/exports/${task.id}/download?credential=${encodeURIComponent(credential)}`);
  assert.equal(dl1.status, 200);
  assert.equal(dl1.headers.get('x-file-version'), '1');
  const digestHeader = dl1.headers.get('x-content-digest') || '';
  assert.match(digestHeader, /^sha-256=[0-9a-f]{64}$/);
  const { createHash } = await import('node:crypto');
  assert.equal(digestHeader, `sha-256=${createHash('sha256').update(dl1.text).digest('hex')}`);
  const fileJson = JSON.parse(dl1.text);
  assert.equal(fileJson.format, 'audit-archive-export/v1');
  assert.equal(fileJson.archive.finalHash, archive.finalHash);
  assert.equal(fileJson.events.length, archive.eventCount);
  // 下载动作不修改业务数据：归档冻结哈希仍一致
  const afterDl = (await request('GET', `/api/archives/${archive.id}`, auth(client))).data.archive;
  assert.equal(afterDl.finalHash, archive.finalHash);

  // 凭证重复使用 → 拒绝
  const dl2 = await request('GET', `/api/archives/exports/${task.id}/download?credential=${encodeURIComponent(credential)}`);
  assert.equal(dl2.status, 410);
  assert.equal(dl2.data.error.code, 'EXPORT_CREDENTIAL_USED');

  // 越权：其他人不能查询/凭证下载该归档导出（凭证兑换本身无需登录，但其他账号看不到任务）
  const erin = await login('erin');
  const otherTask = await request('GET', `/api/archives/exports/${task.id}`, auth(erin));
  assert.equal(otherTask.status, 404);

  // 取消一个新任务：取消后其凭证下载被拒绝
  const archive2 = (await createArchive(client, 'batch', batchId, { note: '取消测试' })).data.archive;
  const started = await request('POST', `/api/archives/${archive2.id}/exports`, auth(client, { body: { idempotencyKey: randomId() } }));
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const cancel = await request('POST', `/api/archives/exports/${started.data.task.id}?action=cancel`, auth(client, { body: {} }));
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.task.status, 'cancelled');
  // 已取消任务不能再签凭证
  const credAfterCancel = await request('POST', `/api/archives/exports/${started.data.task.id}?action=credential`, auth(client, { body: {} }));
  assert.equal(credAfterCancel.status, 409);
  assert.equal(credAfterCancel.data.error.code, 'EXPORT_NOT_COMPLETED');
  // 再次取消被拒绝
  const cancelAgain = await request('POST', `/api/archives/exports/${started.data.task.id}?action=cancel`, auth(client, { body: {} }));
  assert.equal(cancelAgain.status, 409);
  assert.equal(cancelAgain.data.error.code, 'EXPORT_NOT_CANCELLABLE');
});

// ⑤ 凭证过期/任务过期后下载拒绝（调短 TTL，走 sweep 清理）
test('凭证过期与导出文件过期清理后下载被拒绝', async () => {
  const client = await freshHandler('t5');
  const { receipt } = await completeAll(client, PAYLOADS('13800138007', 'T5-SECRET-ID-007'));
  const { batchId } = await setupRejectedBatch(client, receipt.receiptNo);
  const archive = (await createArchive(client, 'batch', batchId)).data.archive;
  assert.ok(archive, '应有归档');

  // 先完成一份导出，再验证过期清理
  const firstExport = await request('POST', `/api/archives/${archive.id}/exports`, auth(client, { body: { idempotencyKey: randomId() } }));
  assert.equal(firstExport.status, 200, JSON.stringify(firstExport.data));
  const { runExportToCompletion, issueDownloadCredential } = await import('../src/db.js');
  runExportToCompletion(firstExport.data.task.id);
  const completed = (await request('GET', `/api/archives/exports/${firstExport.data.task.id}`, auth(client))).data.task;
  assert.equal(completed.status, 'completed');

  // 直接把任务置为过期，调用 sweep 验证文件清理
  db.prepare("UPDATE audit_exports SET expires_at = ? WHERE id = ?").run(Date.now() - 1000, completed.id);
  const { sweepArchiveExports } = await import('../src/db.js');
  sweepArchiveExports();
  const swept = (await request('GET', `/api/archives/exports/${completed.id}`, auth(client))).data.task;
  assert.equal(swept.status, 'expired');
  assert.equal(swept.hasFile, false);
  // 过期任务再签凭证被拒绝
  const cred = await request('POST', `/api/archives/exports/${completed.id}?action=credential`, auth(client, { body: {} }));
  assert.equal(cred.status, 409);
  assert.equal(cred.data.error.code, 'EXPORT_NOT_COMPLETED');

  // 过期凭证（数据库中置过期）兑换被拒绝
  const archiveFresh = (await createArchive(client, 'batch', batchId, { note: '凭证过期测试' })).data.archive;
  const started = await request('POST', `/api/archives/${archiveFresh.id}/exports`, auth(client, { body: { idempotencyKey: randomId() } }));
  assert.equal(started.status, 200, JSON.stringify(started.data));
  runExportToCompletion(started.data.task.id);
  const userId = (await request('GET', '/api/state', auth(client))).data.user.id;
  const issued = issueDownloadCredential({ userId, exportId: started.data.task.id });
  assert.equal(issued.ok, true);
  db.prepare("UPDATE audit_export_credentials SET expires_at = ? WHERE export_id = ? AND status='active'").run(Date.now() - 1, started.data.task.id);
  const dl = await request('GET', `/api/archives/exports/${started.data.task.id}/download?credential=${encodeURIComponent(issued.credential)}`);
  assert.equal(dl.status, 410);
  assert.equal(dl.data.error.code, 'EXPORT_CREDENTIAL_EXPIRED');
});

// ⑥ 摘要链/冻结副本被篡改时校验失败，但归档仍只读、拒绝导出
test('摘要链被篡改时校验失败且归档保持只读', async () => {
  const client = await freshHandler('t6');
  const { receipt } = await completeAll(client, PAYLOADS('13800138008', 'T6-SECRET-ID-008'));
  const { batchId } = await setupRejectedBatch(client, receipt.receiptNo);
  const archiveRow = (await createArchive(client, 'batch', batchId)).data.archive;
  assert.ok(archiveRow);
  const before = (await request('GET', `/api/archives/${archiveRow.id}`, auth(client))).data.archive;
  assert.equal(before.chain.continuous, true);

  // 篡改冻结事件的 detail（模拟存储层被改）：校验立即失败
  const eventRow = db.prepare('SELECT * FROM audit_archive_events WHERE archive_id = ? ORDER BY ordinal ASC LIMIT 1').get(archiveRow.id);
  const tampered = JSON.parse(eventRow.detail_json);
  tampered.tampered = true;
  db.prepare('UPDATE audit_archive_events SET detail_json = ? WHERE id = ?').run(JSON.stringify(tampered), eventRow.id);

  const after = (await request('GET', `/api/archives/${archiveRow.id}`, auth(client))).data.archive;
  assert.equal(after.chain.continuous, false);
  assert.ok(after.chain.broken);
  assert.equal(after.chain.broken.ordinal, 0);

  // 审计员视图同样显示校验失败
  const auditor = await login('auditor1');
  const auditorView = (await request('GET', `/api/auditor/archives/${archiveRow.id}`, auth(auditor))).data.archive;
  assert.equal(auditorView.chain.continuous, false);

  // 外部核验显示不连续
  const code = (await request('POST', `/api/archives/${archiveRow.id}/external-code`, auth(client, { body: {} }))).data.code;
  const ext = (await request('POST', '/api/archives/external-verify', { body: { code, archiveId: archiveRow.id } })).data.archive;
  assert.equal(ext.chainContinuous, false);

  // 篡改后的归档不能导出：启动的任务完成时终检失败
  const started = await request('POST', `/api/archives/${archiveRow.id}/exports`, auth(client, { body: { idempotencyKey: randomId() } }));
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const { runExportToCompletion } = await import('../src/db.js');
  const task = runExportToCompletion(started.data.task.id);
  assert.equal(task.status, 'failed');
  assert.equal(task.failReason, 'ARCHIVE_CHAIN_INVALID');
  assert.equal(task.hasFile, false);

  // 归档没有任何“修复/改写内容”的接口：重新归档只产生新版本，被篡改的 v1 原样留档
  const list = (await request('GET', '/api/archives', auth(client))).data.archives;
  const v1 = list.find((a) => a.id === archiveRow.id);
  assert.equal(v1.chain.continuous, false);
});

// ⑥b 调解包/案件组来源可归档；归档后来源继续演进，已生成归档内容不变
test('调解包与案件组来源归档，来源演进不改变已生成归档', async () => {
  const client = await freshHandler('t6b');
  const { receipt } = await completeAll(client, PAYLOADS('13800138009', 'T6B-SECRET-ID-009'));
  const { batchId } = await setupRejectedBatch(client, receipt.receiptNo);

  // 已完成申诉回合（1 字段、2 邀请、均不提意见 → 办理人驳回）
  const appeal = await request('POST', '/api/review-appeals', auth(client, {
    body: {
      batchId,
      ttlMinutes: 60,
      note: '调解前置申诉',
      fields: [{ key: '0.phone', reason: 'misjudged', acceptThreshold: 1, rejectThreshold: 2, evidenceOpinionIds: [] }],
      invitations: [
        { label: '申诉复核人P', fields: ['0.phone'] },
        { label: '申诉复核人Q', fields: ['0.phone'] },
      ],
    },
  }));
  assert.equal(appeal.status, 200, JSON.stringify(appeal.data));
  const roundId = appeal.data.round.id;
  for (const link of appeal.data.links) {
    const v = await request('POST', '/api/appeal-review/validate', { body: { token: link.token } });
    assert.equal(v.status, 200);
  }
  const round = (await request('GET', `/api/review-appeals/${roundId}`, auth(client))).data.round;
  for (const f of round.fields) {
    const r = await request('POST', `/api/review-appeals/${roundId}/fields/${f.id}/reject`, auth(client, {
      body: { reason: '申诉意见证据不足，维持驳回' },
    }));
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }

  // 调解包（单字段、第一层 2 人，第二层 3 人）
  const mediation = await request('POST', '/api/mediation-packages', auth(client, {
    body: {
      roundId,
      note: '调解包归档前置',
      fields: [{ key: '0.phone', evidenceOpinionIds: [] }],
      layer1: {
        ttlMinutes: 60, timeoutPolicy: 'escalate', escalateRejectedCount: 1,
        fields: [{ key: '0.phone', acceptThreshold: 2, rejectThreshold: 2 }],
        invitations: [
          { label: '调解人1', fields: ['0.phone'] },
          { label: '调解人2', fields: ['0.phone'] },
        ],
      },
      layer2: {
        ttlMinutes: 60, timeoutPolicy: 'complete',
        fields: [{ key: '0.phone', acceptThreshold: 2, rejectThreshold: 2 }],
        invitations: [
          { label: '仲裁人1', fields: ['0.phone'] },
          { label: '仲裁人2', fields: ['0.phone'] },
          { label: '仲裁人3', fields: ['0.phone'] },
        ],
      },
    },
  }));
  assert.equal(mediation.status, 200, JSON.stringify(mediation.data));
  const packageId = mediation.data.pkg.id;

  // 调解包归档（创建瞬间至少包含 mediation.created）
  const medArchiveRes = await createArchive(client, 'mediation', packageId);
  assert.equal(medArchiveRes.status, 200, JSON.stringify(medArchiveRes.data));
  const medArchive = medArchiveRes.data.archive;
  assert.ok(medArchive.eventCount >= 1);
  assert.equal(medArchive.chain.continuous, true);
  assert.ok(medArchive.events.every((e) => e.family === 'mediation'));
  const frozenMedCount = medArchive.eventCount;
  const frozenFinalHash = medArchive.finalHash;

  // 案件组（锚定该调解包）
  const group = await request('POST', '/api/case-groups', auth(client, {
    body: { anchorPackageId: packageId, note: '案件组归档前置' },
  }));
  assert.equal(group.status, 200, JSON.stringify(group.data));
  const groupId = group.data.caseGroup.id;
  const groupArchiveRes = await createArchive(client, 'caseGroup', groupId);
  assert.equal(groupArchiveRes.status, 200, JSON.stringify(groupArchiveRes.data));
  const groupArchive = groupArchiveRes.data.archive;
  assert.ok(groupArchive.eventCount >= 2, '案件组至少有 created + member.joined 事件');
  assert.equal(groupArchive.chain.continuous, true);
  assert.ok(groupArchive.events.some((e) => e.type === 'review.caseGroup.created'));
  assert.ok(groupArchive.events.some((e) => e.type === 'review.caseGroup.member.joined'));
  // 案件组事件流也包含锚定调解包的事件（跨包顺序一致）
  assert.ok(groupArchive.events.some((e) => e.family === 'mediation'));

  // 校验第一层两个调解人邀请（产生新的 mediation 事件：来源在归档后继续演进）
  const l1Links = mediation.data.links.filter((l) => l.tier === 1);
  for (const link of l1Links) {
    const v = await request('POST', '/api/mediation-review/validate', { body: { token: link.token } });
    assert.equal(v.status, 200, JSON.stringify(v.data));
  }

  // 已生成的调解包归档：事件数与最终摘要不变
  const after = (await request('GET', `/api/archives/${medArchive.id}`, auth(client))).data.archive;
  assert.equal(after.eventCount, frozenMedCount, '归档后来源新增事件不改变归档事件数');
  assert.equal(after.finalHash, frozenFinalHash, '归档后来源新增事件不改变最终摘要');
  assert.equal(after.chain.continuous, true);
});

// ⑦ 服务重启后导出进度恢复并继续完成
test('服务重启后未完成导出从持久化进度继续', async () => {
  // 在当前进程准备一个进行到中段的导出
  const client = await freshHandler('t7');
  const { receipt } = await completeAll(client, PAYLOADS('13800138005', 'ERIN-SECRET-ID-005'));
  const { batchId } = await setupRejectedBatch(client, receipt.receiptNo);
  const archive = (await createArchive(client, 'batch', batchId)).data.archive;
  const started = await request('POST', `/api/archives/${archive.id}/exports`, auth(client, { body: { idempotencyKey: randomId() } }));
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const exportId = started.data.task.id;

  // 手动只推进一个分块（模拟崩溃前进度）
  const { processNextExportChunkForTest } = await import('../src/archiveStore.js');
  assert.equal(typeof processNextExportChunkForTest, 'function');
  processNextExportChunkForTest();
  const midTask = (await request('GET', `/api/archives/exports/${exportId}`, auth(client))).data.task;
  assert.ok(midTask.completedChunks >= 1);
  const frozenChunks = midTask.completedChunks;
  assert.ok(midTask.status === 'running' || midTask.status === 'completed');
  if (midTask.status === 'completed') return; // 事件少一次处理完成也可接受

  // 停止父进程后台扫描并关闭 HTTP 服务，避免与重启后的子进程竞争同一任务
  stopArchiveExportSweep();
  await new Promise((resolve) => server.close(resolve));
  const child = spawn(process.execPath, [path.join(process.cwd(), 'src', 'server.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DB_PATH: process.env.DB_PATH,
      RECEIPT_SECRET: process.env.RECEIPT_SECRET,
      VERIFY_RATE_MAX: '200',
      PORT: '0',
      NO_AUTO_LISTEN: '0',
      ARCHIVE_SWEEP_MS: '100',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childUrl = '';
  await new Promise((resolve2, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Restart server did not start')), 10000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = /listening on http:\/\/0\.0\.0\.0:(\d+)/.exec(output);
      if (match) { clearTimeout(timer); childUrl = `http://127.0.0.1:${match[1]}`; resolve2(); }
    });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited early with code ${code}: ${output}`)); });
  });

  // 等待后台任务完成
  const loginAgain = async () => {
    const res = await fetch(`${childUrl}/api/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: client.username, password: 'password123' }),
    });
    const data = await res.json();
    assert.equal(res.status, 200, `子进程登录失败：${JSON.stringify(data)}`);
    const cookies = parsePair(res.headers.get('set-cookie') || '');
    return { cookie: `sid=${cookies.sid}; csrf=${cookies.csrf}`, csrf: data.csrfToken };
  };
  const childClient = await loginAgain();
  let finalTask = null;
  for (let i = 0; i < 50; i += 1) {
    const res = await fetch(`${childUrl}/api/archives/exports/${exportId}`, {
      headers: { Cookie: childClient.cookie, 'X-CSRF-Token': childClient.csrf },
    });
    finalTask = (await res.json()).task;
    if (finalTask && ['completed', 'failed', 'cancelled', 'expired'].includes(finalTask.status)) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  assert.ok(finalTask, '重启后应能查询到任务');
  assert.equal(finalTask.status, 'completed', `任务应在重启后续跑完成：${JSON.stringify(finalTask)}`);
  assert.ok(finalTask.completedChunks >= frozenChunks, '已完成分块进度不得丢失');
  assert.equal(finalTask.progress, 100);

  // 重启后归档内容与摘要链仍一致（时间线恢复）
  const res = await fetch(`${childUrl}/api/archives/${archive.id}`, {
    headers: { Cookie: childClient.cookie, 'X-CSRF-Token': childClient.csrf },
  });
  const restartedArchive = (await res.json()).archive;
  assert.equal(restartedArchive.chain.continuous, true);
  assert.equal(restartedArchive.eventCount, archive.eventCount);

  child.kill('SIGTERM');
  await once(child, 'exit');

  // 恢复父进程监听与后台扫描，供后续清理及其他文件复用进程
  if (!server.listening) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
});

test.after(async () => {
  try { stopArchiveExportSweep(); } catch { /* noop */ }
  try { server.close(); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
});
