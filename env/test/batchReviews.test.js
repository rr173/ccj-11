import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

process.env.DB_PATH = path.join(process.cwd(), 'data', `test-batch-${process.pid}.db`);
process.env.TOKEN_TTL_MS = '600000';
process.env.RECEIPT_SECRET = 'unit-test-batch-secret-fixed-value';
process.env.VERIFY_RATE_MAX = '200';
process.env.REVIEW_INVITE_MIN_TTL_MS = '60000';
process.env.NO_AUTO_LISTEN = '1';
for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });

const { server } = await import('../src/server.js');
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

async function login(username) {
  const res = await request('POST', '/api/login', { body: { username, password: 'password123' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const cookies = parsePair(res.headers.get('set-cookie') || '');
  return { cookie: `sid=${cookies.sid}; csrf=${cookies.csrf}`, sid: cookies.sid, csrf: res.data.csrfToken };
}
function auth(client, extra = {}) {
  return { ...extra, headers: { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, ...(extra.headers || {}) } };
}
function randomId() {
  return crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}

const PAYLOADS = (phone = '13800138000') => ([
  { name: '批次测试', idNumber: 'BATCH-SECRET-ID-999', phone },
  { province: '江苏省', city: '南京市', detail: '玄武区批次秘密地址 8 号' },
  { type: 'change', description: '批次测试事项说明' },
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
  let workflow = (await request('GET', '/api/state', auth(client))).data.workflow;
  let receipt = null;
  while (!workflow.completed) {
    const result = await confirmStep(client, workflow, payloads[workflow.progress]);
    workflow = result.workflow;
    if (result.receipt) receipt = result.receipt;
  }
  return { workflow, receipt };
}
async function abandonIfAny(client) {
  const state = (await request('GET', '/api/state', auth(client))).data;
  if (state.workflow && !state.workflow.completed && state.workflow.sourceReceiptNo) {
    await request('POST', '/api/corrections?action=abandon', auth(client, { body: {} }));
  }
}

// 创建一个 3 邀请批次：phone 三个邀请均授权（accept 2 / reject 2），
// detail 仅前两个邀请授权（accept 1 / reject 3）
async function createDefaultBatch(client, receiptNo, overrides = {}) {
  const body = {
    receiptNo,
    ttlMinutes: 60,
    note: '测试批次',
    fields: [
      { key: '0.phone', acceptThreshold: 2, rejectThreshold: 2 },
      { key: '1.detail', acceptThreshold: 1, rejectThreshold: 3 },
    ],
    invitations: [
      { label: '复核人甲', fields: ['0.phone', '1.detail'] },
      { label: '复核人乙', fields: ['0.phone', '1.detail'] },
      { label: '复核人丙', fields: ['0.phone'] },
    ],
    ...overrides,
  };
  return request('POST', '/api/review-batches', auth(client, { body }));
}

async function validateBatch(token) {
  const res = await request('POST', '/api/batch-review/validate', { body: { token } });
  const cookies = parsePair(res.headers.get('set-cookie') || '');
  return {
    res,
    cookie: `bid=${cookies.bid || ''}; bcsrf=${cookies.bcsrf || ''}`,
    csrf: res.data?.csrfToken || '',
  };
}
function batchHeaders(session, extra = {}) {
  return { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, ...(extra.headers || {}) };
}
async function batchContext(session) {
  return request('GET', '/api/batch-review/context', { headers: { Cookie: session.cookie } });
}
async function submitOpinion(session, key, reason, idempotencyKey = randomId()) {
  return request('POST', '/api/batch-review/opinions', {
    headers: batchHeaders(session),
    body: { key, reason, idempotencyKey },
  });
}

test('批次创建配置校验：邀请数 2-5、阈值范围、字段授权必须是编排字段子集', async () => {
  await abandonIfAny(await login('alice'));
  const alice = await login('alice');
  const { receipt } = await completeAll(alice);

  // 邀请数不足
  const tooFew = await request('POST', '/api/review-batches', auth(alice, {
    body: {
      receiptNo: receipt.receiptNo, ttlMinutes: 60,
      fields: [{ key: '0.phone', acceptThreshold: 1, rejectThreshold: 1 }],
      invitations: [{ label: 'A', fields: ['0.phone'] }],
    },
  }));
  assert.equal(tooFew.status, 400);
  assert.equal(tooFew.data.error.code, 'INVALID_BATCH_INVITATIONS');

  // 超过 5 个
  const tooMany = await request('POST', '/api/review-batches', auth(alice, {
    body: {
      receiptNo: receipt.receiptNo, ttlMinutes: 60,
      fields: [{ key: '0.phone', acceptThreshold: 1, rejectThreshold: 1 }],
      invitations: Array.from({ length: 6 }, (_, i) => ({ label: `I${i}`, fields: ['0.phone'] })),
    },
  }));
  assert.equal(tooMany.status, 400);
  assert.equal(tooMany.data.error.code, 'INVALID_BATCH_INVITATIONS');

  // 接受阈值超出邀请数
  const badThreshold = await request('POST', '/api/review-batches', auth(alice, {
    body: {
      receiptNo: receipt.receiptNo, ttlMinutes: 60,
      fields: [{ key: '0.phone', acceptThreshold: 3, rejectThreshold: 1 }],
      invitations: [
        { label: 'A', fields: ['0.phone'] },
        { label: 'B', fields: ['0.phone'] },
      ],
    },
  }));
  assert.equal(badThreshold.status, 400);
  assert.equal(badThreshold.data.error.code, 'INVALID_ACCEPT_THRESHOLD');

  // 邀请授权了未纳入编排的字段
  const scopeOutOfSet = await request('POST', '/api/review-batches', auth(alice, {
    body: {
      receiptNo: receipt.receiptNo, ttlMinutes: 60,
      fields: [{ key: '0.phone', acceptThreshold: 1, rejectThreshold: 1 }],
      invitations: [
        { label: 'A', fields: ['0.phone', '1.detail'] },
        { label: 'B', fields: ['0.phone'] },
      ],
    },
  }));
  assert.equal(scopeOutOfSet.status, 400);
  assert.equal(scopeOutOfSet.data.error.code, 'INVALID_BATCH_FIELD_SCOPE');

  // 编排字段没有任何邀请授权
  const nobodyAuthorized = await request('POST', '/api/review-batches', auth(alice, {
    body: {
      receiptNo: receipt.receiptNo, ttlMinutes: 60,
      fields: [
        { key: '0.phone', acceptThreshold: 1, rejectThreshold: 1 },
        { key: '1.detail', acceptThreshold: 1, rejectThreshold: 1 },
      ],
      invitations: [
        { label: 'A', fields: ['0.phone'] },
        { label: 'B', fields: ['0.phone'] },
      ],
    },
  }));
  assert.equal(nobodyAuthorized.status, 400);
  assert.equal(nobodyAuthorized.data.error.code, 'INVALID_BATCH_FIELD');

  // 他人回执
  const bob = await login('bob');
  const foreign = await createDefaultBatch(bob, receipt.receiptNo);
  assert.equal(foreign.status, 404);
  assert.equal(foreign.data.error.code, 'RECEIPT_NOT_FOUND');

  // 正常创建：返回 2-5 个一次性链接（令牌只出现一次）
  const ok = await createDefaultBatch(alice, receipt.receiptNo);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.links.length, 3);
  assert.equal(ok.data.batch.status, 'collecting');
  assert.ok(ok.data.links.every((l) => /^\/batch-review\?t=/.test(l.url)));

  // 同一回执同时只能有一个未终结批次
  const second = await createDefaultBatch(alice, receipt.receiptNo);
  assert.equal(second.status, 409);
  assert.equal(second.data.error.code, 'BATCH_ALREADY_OPEN');

  // 清理：取消批次，供后续用例复用同一回执
  const cancel = await request('POST', `/api/review-batches/${ok.data.batch.id}/cancel`, auth(alice, { body: {} }));
  assert.equal(cancel.status, 200);
});

test('批次门控：未全部校验不能进入复核/提交意见；邀请一次性、可撤销、会过期', async () => {
  const alice = await login('alice');
  const state = (await request('GET', '/api/state', auth(alice))).data;
  const receiptNo = state.records[0].receiptNo;
  const created = await createDefaultBatch(alice, receiptNo);
  const batchId = created.data.batch.id;
  const tokens = created.data.links.map((l) => ({ token: l.token, id: l.invitationId, label: l.label }));

  // 门控未满足
  const startEarly = await request('POST', `/api/review-batches/${batchId}/start`, auth(alice, { body: {} }));
  assert.equal(startEarly.status, 409);
  assert.equal(startEarly.data.error.code, 'BATCH_GATE_NOT_SATISFIED');
  assert.equal(startEarly.data.pending.length, 3);

  // 只校验第一个
  const s1 = await validateBatch(tokens[0].token);
  assert.equal(s1.res.status, 200);
  assert.equal(s1.res.data.autoStarted, false);
  // 此时提交意见：批次仍 collecting
  const earlyOpinion = await submitOpinion(s1, '0.phone', '门控未开不能提交');
  assert.equal(earlyOpinion.status, 409);
  assert.equal(earlyOpinion.data.error.code, 'BATCH_GATE_NOT_SATISFIED');

  // 同一链接重复校验：一次性
  const dup = await validateBatch(tokens[0].token);
  assert.equal(dup.res.status, 410);
  assert.equal(dup.res.data.error.code, 'BATCH_INVITATION_ALREADY_USED');

  // 撤销第三个（未使用）
  const revoke = await request('POST', `/api/review-batches/invitations/${tokens[2].id}/revoke`, auth(alice, { body: {} }));
  assert.equal(revoke.status, 200);
  // 已撤销链接校验失败
  const useRevoked = await validateBatch(tokens[2].token);
  assert.equal(useRevoked.res.status, 410);
  assert.equal(useRevoked.res.data.error.code, 'BATCH_INVITATION_REVOKED');
  // 已使用的邀请不能撤销
  const revokeUsed = await request('POST', `/api/review-batches/invitations/${tokens[0].id}/revoke`, auth(alice, { body: {} }));
  assert.equal(revokeUsed.status, 409);
  assert.equal(revokeUsed.data.error.code, 'INVITATION_ALREADY_USED');

  // 门控被破坏：批次无法进入复核，只能取消
  const blocked = await request('POST', `/api/review-batches/${batchId}/start`, auth(alice, { body: {} }));
  assert.equal(blocked.status, 409);
  assert.equal(blocked.data.error.code, 'BATCH_GATE_INVITATION_INVALID');

  // 过期邀请校验失败（直接回拨数据库）
  const { db } = await import('../src/db.js');
  // 先取消卡住的批次
  const cancel = await request('POST', `/api/review-batches/${batchId}/cancel`, auth(alice, { body: { reason: '测试取消' } }));
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.batch.status, 'cancelled');
  // 取消后旧会话立即失效
  const ctxAfterCancel = await batchContext(s1);
  assert.equal(ctxAfterCancel.status, 401);

  // 重新创建用于过期测试
  const fresh = await createDefaultBatch(alice, receiptNo);
  const freshId = fresh.data.batch.id;
  db.prepare('UPDATE review_batch_invitations SET expires_at = ? WHERE batch_id = ?')
    .run(Date.now() - 1000, freshId);
  const expired = await validateBatch(fresh.data.links[0].token);
  assert.equal(expired.res.status, 410);
  assert.equal(expired.res.data.error.code, 'BATCH_INVITATION_EXPIRED');
  // 含过期邀请的批次不能进入复核
  const startExpired = await request('POST', `/api/review-batches/${freshId}/start`, auth(alice, { body: {} }));
  assert.equal(startExpired.status, 409);
  assert.equal(startExpired.data.error.code, 'BATCH_GATE_INVITATION_INVALID');
});

test('复核页面与接口只返回本邀请授权的脱敏字段；越权提交明确失败', async () => {
  const bob = await login('bob');
  await abandonIfAny(bob);
  const { receipt } = await completeAll(bob);
  const created = await createDefaultBatch(bob, receipt.receiptNo);
  const batchId = created.data.batch.id;
  const sessions = [];
  for (const link of created.data.links) {
    const s = await validateBatch(link.token);
    assert.equal(s.res.status, 200, JSON.stringify(s.res.data));
    sessions.push(s);
  }
  // 最后一个邀请校验完成后自动进入复核
  assert.equal(sessions[2].res.data.autoStarted, true);

  // 复核人丙：仅授权 phone
  const ctx3 = await batchContext(sessions[2]);
  assert.equal(ctx3.status, 200);
  const c3 = ctx3.data.context;
  assert.deepEqual(c3.view.steps.flatMap((s) => s.fields.map((f) => f.key)), ['0.phone']);
  assert.equal(c3.canSubmit, true);
  const serialized = JSON.stringify(c3);
  assert.ok(!serialized.includes('BATCH-SECRET-ID-999'), '证件号码不得下发');
  assert.ok(!serialized.includes('秘密地址'), '详细地址原值不得下发（丙未被授权）');
  assert.ok(!serialized.includes('13800138000'), '完整手机号不得下发');
  assert.match(c3.view.steps[0].fields[0].value, /^138\*\*\*\*8000$/);

  // 复核人甲：授权 phone+detail，地址只给脱敏值
  const ctx1 = await batchContext(sessions[0]);
  const c1 = ctx1.data.context;
  assert.deepEqual(c1.view.steps.flatMap((s) => s.fields.map((f) => f.key)).sort(), ['0.phone', '1.detail']);
  assert.ok(JSON.stringify(c1).includes('玄武'), '甲可看到地址脱敏值前缀');
  assert.ok(!JSON.stringify(c1).includes('秘密地址'), '甲也拿不到地址原值');

  // 越权：丙对 detail 提交意见
  const cross = await submitOpinion(sessions[2], '1.detail', '丙越权提交地址意见');
  assert.equal(cross.status, 403);
  assert.equal(cross.data.error.code, 'BATCH_FIELD_NOT_AUTHORIZED');

  // 伪造不存在字段
  const badField = await submitOpinion(sessions[0], '9.nope', '不存在字段');
  assert.equal(badField.status, 400);
  assert.equal(badField.data.error.code, 'BATCH_FIELD_NOT_FOUND');

  // 携带其他回执编号：回执不匹配
  const mismatch = await request('POST', '/api/batch-review/opinions', {
    headers: batchHeaders(sessions[0]),
    body: { key: '0.phone', reason: '尝试他份回执', idempotencyKey: randomId(), receiptNo: 'HZ-20000101-AAAAAAAA' },
  });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.data.error.code, 'BATCH_RECEIPT_MISMATCH');

  // 无会话 / CSRF 缺失
  const noSession = await request('POST', '/api/batch-review/opinions', {
    body: { key: '0.phone', reason: '无会话', idempotencyKey: randomId() },
  });
  assert.equal(noSession.status, 401);
  assert.equal(noSession.data.error.code, 'BATCH_SESSION_REQUIRED');
  const noCsrf = await request('POST', '/api/batch-review/opinions', {
    headers: { Cookie: sessions[0].cookie },
    body: { key: '0.phone', reason: '无 csrf', idempotencyKey: randomId() },
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.data.error.code, 'BATCH_CSRF_INVALID');
  void batchId;
});

test('字段意见：每邀请每字段至多一份；幂等重放同一结果，换内容失败；合并展示保留原始说明', async () => {
  const carol = await login('carol');
  await abandonIfAny(carol);
  const { receipt } = await completeAll(carol);
  const created = await createDefaultBatch(carol, receipt.receiptNo);
  const batchId = created.data.batch.id;
  const sessions = [];
  for (const link of created.data.links) sessions.push(await validateBatch(link.token));

  const idem = randomId();
  const payload = { key: '0.phone', reason: '甲：手机号末位应为 1234', idempotencyKey: idem };
  const first = await request('POST', '/api/batch-review/opinions', { headers: batchHeaders(sessions[0]), body: payload });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  // 网络重试：同一幂等键+相同指纹
  const replay = await request('POST', '/api/batch-review/opinions', { headers: batchHeaders(sessions[0]), body: payload });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replay, true);
  assert.equal(replay.data.opinion.id, first.data.opinion.id);
  // 同键换内容
  const swapped = await request('POST', '/api/batch-review/opinions', {
    headers: batchHeaders(sessions[0]),
    body: { key: '0.phone', reason: '完全不同的另一段说明内容', idempotencyKey: idem },
  });
  assert.equal(swapped.status, 409);
  assert.equal(swapped.data.error.code, 'OBJECTION_DUPLICATE_KEY');
  // 同一邀请对同一字段再次提交（新幂等键）：重复意见失败
  const dup2 = await submitOpinion(sessions[0], '0.phone', '甲又想提交一次');
  assert.equal(dup2.status, 409);
  assert.equal(dup2.data.error.code, 'BATCH_FIELD_DUPLICATE_OPINION');
  // 说明长度
  const badReason = await submitOpinion(sessions[1], '0.phone', 'x');
  assert.equal(badReason.status, 400);
  assert.equal(badReason.data.error.code, 'INVALID_REASON');

  await submitOpinion(sessions[1], '0.phone', '乙：手机号确实有误，请核对');
  await submitOpinion(sessions[2], '0.phone', '丙：我也认为电话错了');

  // 办理人视角：同一字段多份意见合并展示，逐字保留每位复核人原始说明
  const detail = await request('GET', `/api/review-batches/${batchId}`, auth(carol));
  assert.equal(detail.status, 200);
  const phone = detail.data.batch.fields.find((f) => f.key === '0.phone');
  assert.equal(phone.opinionCount, 3);
  assert.deepEqual(phone.opinions.map((o) => o.reviewerLabel), ['复核人甲', '复核人乙', '复核人丙']);
  assert.match(phone.opinions[0].reason, /1234/);
  assert.match(phone.opinions[1].reason, /请核对/);
});

test('逐字段决议必须满足阈值；驳回必须保存理由；重复决议返回同一结果', async () => {
  const dave = await login('dave');
  await abandonIfAny(dave);
  const { receipt } = await completeAll(dave);
  const created = await createDefaultBatch(dave, receipt.receiptNo);
  const batchId = created.data.batch.id;
  const sessions = [];
  for (const link of created.data.links) sessions.push(await validateBatch(link.token));

  const batch = () => request('GET', `/api/review-batches/${batchId}`, auth(dave));
  const fieldId = async (key) => (await batch()).data.batch.fields.find((f) => f.key === key).id;
  const phoneId = await fieldId('0.phone');
  const detailId = await fieldId('1.detail');

  // 无意见时：phone accept 阈值 2 不满足
  const noOpinionAccept = await request('POST', `/api/review-batches/${batchId}/fields/${phoneId}/accept`, auth(dave, { body: {} }));
  assert.equal(noOpinionAccept.status, 409);
  assert.equal(noOpinionAccept.data.error.code, 'ACCEPT_THRESHOLD_NOT_MET');
  // 无意见时 phone reject：3 位已校验、0 人反对 → 支持驳回 3 人 ≥ 2，可驳回，但理由必填
  const rejectNoReason = await request('POST', `/api/review-batches/${batchId}/fields/${phoneId}/reject`, auth(dave, { body: { reason: 'x' } }));
  assert.equal(rejectNoReason.status, 400);
  assert.equal(rejectNoReason.data.error.code, 'REJECT_REASON_REQUIRED');
  const rejectOk = await request('POST', `/api/review-batches/${batchId}/fields/${phoneId}/reject`, auth(dave, {
    body: { reason: '无复核人就电话提出异议，核对原申报无误，驳回' },
  }));
  assert.equal(rejectOk.status, 200, JSON.stringify(rejectOk.data));
  assert.equal(rejectOk.data.field.decision, 'rejected');
  // 重复决议：接受/再次驳回都明确失败，返回同一条已存在决议与理由
  const repeatReject = await request('POST', `/api/review-batches/${batchId}/fields/${phoneId}/reject`, auth(dave, {
    body: { reason: '换一个理由再驳回一次' },
  }));
  assert.equal(repeatReject.status, 409);
  assert.equal(repeatReject.data.error.code, 'BATCH_FIELD_ALREADY_DECIDED');
  assert.equal(repeatReject.data.alreadyDecided, true);
  assert.match(repeatReject.data.field.decisionReason, /原申报无误/);
  const acceptAfter = await request('POST', `/api/review-batches/${batchId}/fields/${phoneId}/accept`, auth(dave, { body: {} }));
  assert.equal(acceptAfter.status, 409);
  assert.equal(acceptAfter.data.field.decision, 'rejected');

  // detail：阈值 accept 1 / reject 3。先只有 1 人（丙未授权该字段，分母仅校验者=3）
  await submitOpinion(sessions[0], '1.detail', '甲：地址门牌号错误');
  // 接受阈值 1：可以接受；驳回阈值 3：反对者 2 人（乙、丙未提意见）<3 不可驳回
  const rejectDetail = await request('POST', `/api/review-batches/${batchId}/fields/${detailId}/reject`, auth(dave, {
    body: { reason: '尝试驳回地址：支持驳回人数不足' },
  }));
  assert.equal(rejectDetail.status, 409);
  assert.equal(rejectDetail.data.error.code, 'REJECT_THRESHOLD_NOT_MET');

  // 取消已有决议的批次必须失败
  const cancel = await request('POST', `/api/review-batches/${batchId}/cancel`, auth(dave, { body: {} }));
  assert.equal(cancel.status, 409);
  assert.equal(cancel.data.error.code, 'BATCH_HAS_DECISIONS');
});

test('两个页面并发决议同一字段：只有一个成功，另一个拿到同一决议', async () => {
  const erin = await login('erin');
  await abandonIfAny(erin);
  const { receipt } = await completeAll(erin);
  const created = await createDefaultBatch(erin, receipt.receiptNo);
  const batchId = created.data.batch.id;
  const sessions = [];
  for (const link of created.data.links) sessions.push(await validateBatch(link.token));
  await submitOpinion(sessions[0], '0.phone', '甲并发意见');
  await submitOpinion(sessions[1], '0.phone', '乙并发意见');

  const detail = await request('GET', `/api/review-batches/${batchId}`, auth(erin));
  const phoneId = detail.data.batch.fields.find((f) => f.key === '0.phone').id;

  const erin2 = await login('erin');
  const [a, b] = await Promise.all([
    request('POST', `/api/review-batches/${batchId}/fields/${phoneId}/accept`, auth(erin, { body: {} })),
    request('POST', `/api/review-batches/${batchId}/fields/${phoneId}/accept`, auth(erin2, { body: {} })),
  ]);
  assert.equal([a.status, b.status].filter((s) => s === 200).length, 1);
  const loser = a.status === 200 ? b : a;
  const winner = a.status === 200 ? a : b;
  assert.equal(loser.status, 409);
  assert.equal(loser.data.error.code, 'BATCH_FIELD_ALREADY_DECIDED');
  assert.equal(loser.data.field.decision, 'accepted');
  assert.equal(winner.data.field.decision, 'accepted');

  // 只有一份更正办理（接受方），关联全部 2 份意见
  const state = (await request('GET', '/api/state', auth(erin))).data;
  assert.equal(state.workflow.completed, false);
  assert.equal(state.workflow.sourceReceiptNo, receipt.receiptNo);
  const after = await request('GET', `/api/review-batches/${batchId}`, auth(erin));
  const phone = after.data.batch.fields.find((f) => f.key === '0.phone');
  assert.equal(phone.opinions.length, 2);
  // 清理：放弃更正，字段决议回收
  await request('POST', '/api/corrections?action=abandon', auth(erin, { body: {} }));
  const reopened = await request('GET', `/api/review-batches/${batchId}`, auth(erin));
  const phoneReopened = reopened.data.batch.fields.find((f) => f.key === '0.phone');
  assert.equal(phoneReopened.decision, null);
});

test('接受字段进入同一份更正办理并关联全部意见；完成后新回执回填，原回执冻结', async () => {
  const alice = await login('alice');
  // alice 前序用例已取消/过期批次，回执仍有效；重新办一份避免被 open-batch 限制影响
  const records0 = (await request('GET', '/api/receipts', auth(alice))).data.receipts;
  await abandonIfAny(alice);
  // 直接基于最近回执发起更正得到新回执，再对新回执建批次
  const src = records0[0].receiptNo;
  const started = await request('POST', '/api/corrections', auth(alice, { body: { receiptNo: src } }));
  assert.equal(started.status, 200, JSON.stringify(started.data));
  const { receipt } = await completeAll(alice, PAYLOADS('13700001111'));
  assert.notEqual(receipt.receiptNo, src);
  const oldSnapshot = JSON.stringify(receipt.snapshot);

  const created = await createDefaultBatch(alice, receipt.receiptNo);
  const batchId = created.data.batch.id;
  const sessions = [];
  for (const link of created.data.links) sessions.push(await validateBatch(link.token));
  await submitOpinion(sessions[0], '0.phone', '甲：电话需更正为新号码');
  await submitOpinion(sessions[1], '0.phone', '乙：电话同样有误');
  await submitOpinion(sessions[0], '1.detail', '甲：地址也需微调');

  const phoneId = (await request('GET', `/api/review-batches/${batchId}`, auth(alice))).data.batch.fields
    .find((f) => f.key === '0.phone').id;
  const accepted = await request('POST', `/api/review-batches/${batchId}/fields/${phoneId}/accept`, auth(alice, { body: {} }));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.createdCorrection, true);
  assert.equal(accepted.data.workflow.sourceReceiptNo, receipt.receiptNo);

  // 再接受 detail（阈值 1）：复用同一份更正，不新建
  const detailId = (await request('GET', `/api/review-batches/${batchId}`, auth(alice))).data.batch.fields
    .find((f) => f.key === '1.detail').id;
  const accepted2 = await request('POST', `/api/review-batches/${batchId}/fields/${detailId}/accept`, auth(alice, { body: {} }));
  assert.equal(accepted2.status, 200);
  assert.equal(accepted2.data.createdCorrection, false);
  assert.equal(accepted2.data.workflow.id, accepted.data.workflow.id);
  // 两个字段都已接受 → 全部字段决议完成，批次 completed
  assert.equal(accepted2.data.batchCompleted, true);

  // 完成更正
  const { receipt: newReceipt } = await completeAll(alice, PAYLOADS('13922223333'));
  assert.notEqual(newReceipt.receiptNo, receipt.receiptNo);

  // 批次字段与意见都回填新回执编号
  const after = await request('GET', `/api/review-batches/${batchId}`, auth(alice));
  for (const field of after.data.batch.fields) {
    assert.equal(field.decision, 'accepted');
    assert.equal(field.correctionReceiptNo, newReceipt.receiptNo);
    assert.ok(field.opinions.every((o) => o.correctionReceiptNo === newReceipt.receiptNo));
  }

  // 原回执冻结不变
  const oldRow = await request('GET', `/api/receipts/${encodeURIComponent(receipt.receiptNo)}`, auth(alice));
  assert.equal(JSON.stringify(oldRow.data.receipt.snapshot), oldSnapshot);
  assert.equal(oldRow.data.receipt.snapshot.steps[0].data.phone, '13700001111');

  // 时间线：原回执 → 批次（事件/逐字段决议/意见）→ 更正回执（来源关系）
  const state = (await request('GET', '/api/state', auth(alice))).data;
  const batchEntry = state.timeline.find((t) => t.kind === 'reviewBatch' && t.batchId === batchId);
  assert.ok(batchEntry);
  assert.equal(batchEntry.status, 'completed');
  const phone = batchEntry.fields.find((f) => f.key === '0.phone');
  assert.equal(phone.decision, 'accepted');
  assert.equal(phone.opinions.length, 2);
  assert.equal(phone.correctionReceiptNo, newReceipt.receiptNo);
  const receiptNos = state.timeline.filter((t) => t.kind === 'receipt').map((t) => t.receiptNo);
  assert.ok(receiptNos.includes(receipt.receiptNo));
  assert.ok(receiptNos.includes(newReceipt.receiptNo));
  const newEntry = state.timeline.find((t) => t.kind === 'receipt' && t.receiptNo === newReceipt.receiptNo);
  assert.equal(newEntry.sourceReceiptNo, receipt.receiptNo);

  // 审计事件
  const { db } = await import('../src/db.js');
  const eventTypes = db.prepare(`
    SELECT type FROM events WHERE workflow_id = ? ORDER BY id
  `).all(oldRow.data.receipt.snapshot.workflowId).map((e) => e.type);
  for (const type of ['review.batch.created', 'review.batch.started', 'review.batch.field.accepted', 'review.batch.completed', 'review.batch.correction.completed']) {
    assert.ok(eventTypes.includes(type), `缺少审计事件 ${type}`);
  }
});

test('批次、邀请、授权、意见、阈值、决议与来源关系在服务重启后保留', async () => {
  const bob = await login('bob');
  const records = (await request('GET', '/api/receipts', auth(bob))).data.receipts;
  const target = records[0];
  // bob 的批次仍处于 in_review（前序用例），新建前先取消
  const state0 = (await request('GET', '/api/state', auth(bob))).data;
  for (const batch of state0.reviewBatches || []) {
    if (batch.receiptNo === target.receiptNo && ['collecting', 'in_review'].includes(batch.status)) {
      // 有决议不能取消：改用一份新回执
    }
  }
  // 直接基于 target 发起更正→新回执→新批次，保证干净
  await abandonIfAny(bob);
  await request('POST', '/api/corrections', auth(bob, { body: { receiptNo: target.receiptNo } }));
  const { receipt } = await completeAll(bob, PAYLOADS('13655556666'));

  const created = await createDefaultBatch(bob, receipt.receiptNo);
  const batchId = created.data.batch.id;
  const inviteIds = created.data.links.map((l) => l.invitationId);
  const sessions = [];
  for (const link of created.data.links) sessions.push(await validateBatch(link.token));
  await submitOpinion(sessions[0], '0.phone', '重启持久化：甲的电话意见');
  await submitOpinion(sessions[1], '0.phone', '重启持久化：乙的电话意见');

  const child = await startRestartServer(process.env.DB_PATH);
  try {
    const loginRes = await fetch(`${child.url}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'password123' }),
    });
    assert.equal(loginRes.status, 200);
    const cookies = parsePair(loginRes.headers.get('set-cookie') || '');
    const stateRes = await fetch(`${child.url}/api/state`, { headers: { Cookie: `sid=${cookies.sid}` } });
    const state = await stateRes.json();
    const entry = state.timeline.find((t) => t.kind === 'reviewBatch' && t.batchId === batchId);
    assert.ok(entry, '重启后批次仍在时间线');
    assert.equal(entry.status, 'in_review');
    assert.equal(entry.invitationCount, 3);
    assert.equal(entry.validatedCount, 3);
    assert.deepEqual(entry.invitations.map((i) => i.id).sort(), [...inviteIds].sort());
    const phone = entry.fields.find((f) => f.key === '0.phone');
    assert.equal(phone.acceptThreshold, 2);
    assert.equal(phone.rejectThreshold, 2);
    assert.equal(phone.opinions.length, 2);
    assert.match(phone.opinions[0].reason, /甲的电话意见/);
    assert.match(phone.opinions[1].reason, /乙的电话意见/);
    assert.equal(phone.decision, null);
    const detail = entry.fields.find((f) => f.key === '1.detail');
    assert.deepEqual(detail.opinions.length, 0);

    // 复核会话也持久化：重启后凭 cookie 仍能读到仅授权字段
    const ctxRes = await fetch(`${child.url}/api/batch-review/context`, { headers: { Cookie: sessions[2].cookie } });
    assert.equal(ctxRes.status, 200);
    const ctxBody = await ctxRes.json();
    assert.deepEqual(ctxBody.context.view.steps.flatMap((s) => s.fields.map((f) => f.key)), ['0.phone']);
    const mergedPhone = ctxBody.context.merged.find((m) => m.key === '0.phone');
    assert.equal(mergedPhone.opinions.length, 2);
  } finally {
    await stop(child);
  }
});

async function startRestartServer(dbFile) {
  const child = spawn(process.execPath, [path.join(process.cwd(), 'src', 'server.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DB_PATH: dbFile,
      RECEIPT_SECRET: process.env.RECEIPT_SECRET,
      VERIFY_RATE_MAX: '200',
      PORT: '0',
      NO_AUTO_LISTEN: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Restart server did not start')), 5000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = /listening on http:\/\/0\.0\.0\.0:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(`http://127.0.0.1:${match[1]}`);
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early with code ${code}`));
    });
  });
  return { child, url };
}
async function stop(running) {
  if (!running || running.child.exitCode !== null) return;
  running.child.kill('SIGTERM');
  await once(running.child, 'exit');
}

test.after(async () => {
  server.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
});
