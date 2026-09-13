import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

process.env.DB_PATH = path.join(process.cwd(), 'data', `test-appeal-${process.pid}.db`);
process.env.TOKEN_TTL_MS = '600000';
process.env.RECEIPT_SECRET = 'unit-test-appeal-secret-fixed-value';
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
  { name: '申诉测试', idNumber: 'APPEAL-SECRET-ID-001', phone },
  { province: '浙江省', city: '杭州市', detail: '西湖区申诉秘密地址 66 号' },
  { type: 'change', description: '申诉测试事项说明' },
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

// 2 邀请、2 字段（phone/description）的批次；两位复核人各提一个字段意见后，办理人把两个字段都驳回
async function setupRejectedBatch(client, receiptNo, labels = ['复核人A', '复核人B']) {
  const body = {
    receiptNo,
    ttlMinutes: 60,
    note: '申诉前置批次',
    fields: [
      { key: '0.phone', acceptThreshold: 1, rejectThreshold: 1 },
      { key: '2.description', acceptThreshold: 1, rejectThreshold: 1 },
    ],
    invitations: [
      { label: labels[0], fields: ['0.phone', '2.description'] },
      { label: labels[1], fields: ['0.phone', '2.description'] },
    ],
  };
  const created = await request('POST', '/api/review-batches', auth(client, { body }));
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const batchId = created.data.batch.id;
  const sessions = [];
  for (const link of created.data.links) sessions.push(await validateBatch(link.token));
  await submitBatch(sessions[0], '0.phone', 'A：手机号末位有误，应核对');
  await submitBatch(sessions[1], '2.description', 'B：事项说明需要补充材料');

  const detail = await request('GET', `/api/review-batches/${batchId}`, auth(client));
  const phoneId = detail.data.batch.fields.find((f) => f.key === '0.phone').id;
  const descId = detail.data.batch.fields.find((f) => f.key === '2.description').id;
  const r1 = await request('POST', `/api/review-batches/${batchId}/fields/${phoneId}/reject`, auth(client, {
    body: { reason: '核对原申报手机号无误，驳回该意见' },
  }));
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  const r2 = await request('POST', `/api/review-batches/${batchId}/fields/${descId}/reject`, auth(client, {
    body: { reason: '事项说明已足够清晰，驳回该意见' },
  }));
  assert.equal(r2.status, 200, JSON.stringify(r2.data));
  const batch = (await request('GET', `/api/review-batches/${batchId}`, auth(client))).data.batch;
  return { batchId, batch, sessions };
}

async function validateBatch(token) {
  const res = await request('POST', '/api/batch-review/validate', { body: { token } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
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
async function submitBatch(session, key, reason, idempotencyKey = randomId()) {
  const res = await request('POST', '/api/batch-review/opinions', {
    headers: batchHeaders(session),
    body: { key, reason, idempotencyKey },
  });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}

// 创建申诉回合：默认 2 个新邀请，均授权传入字段
async function createAppeal(client, batchId, fieldSpecs, invitationSpecs, overrides = {}) {
  const fields = fieldSpecs.map((spec) => ({
    key: spec.key,
    reason: spec.reason || 'new_evidence',
    acceptThreshold: spec.acceptThreshold ?? 1,
    rejectThreshold: spec.rejectThreshold ?? 1,
    evidenceOpinionIds: spec.evidenceOpinionIds || [],
  }));
  const invitations = invitationSpecs || [
    { label: '申诉复核人甲', fields: fieldSpecs.map((f) => f.key) },
    { label: '申诉复核人乙', fields: fieldSpecs.map((f) => f.key) },
  ];
  return request('POST', '/api/review-appeals', auth(client, {
    body: { batchId, ttlMinutes: 60, note: '测试申诉回合', fields, invitations, ...overrides },
  }));
}
async function validateAppeal(token) {
  const res = await request('POST', '/api/appeal-review/validate', { body: { token } });
  const cookies = parsePair(res.headers.get('set-cookie') || '');
  return {
    res,
    cookie: `aid=${cookies.aid || ''}; accsrf=${cookies.accsrf || ''}`,
    csrf: res.data?.csrfToken || '',
  };
}
function appealHeaders(session, extra = {}) {
  return { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, ...(extra.headers || {}) };
}
async function appealContext(session) {
  return request('GET', '/api/appeal-review/context', { headers: { Cookie: session.cookie } });
}
async function submitAppeal(session, key, reason, idempotencyKey = randomId()) {
  return request('POST', '/api/appeal-review/opinions', {
    headers: appealHeaders(session),
    body: { key, reason, idempotencyKey },
  });
}

test('① 只能针对驳回字段发起申诉；配置校验与一次性开放限制', async () => {
  const alice = await login('alice');
  await abandonIfAny(alice);
  const { receipt } = await completeAll(alice);
  const { batchId } = await setupRejectedBatch(alice, receipt.receiptNo);

  // 可申诉字段列表：只有两个已驳回字段
  const appealable = await request('GET', `/api/review-batches/${batchId}/appealable-fields`, auth(alice));
  assert.equal(appealable.status, 200);
  assert.deepEqual(appealable.data.fields.map((f) => f.key).sort(), ['0.phone', '2.description']);
  assert.ok(appealable.data.reasons.length >= 3);

  // 申诉理由非法
  const badReason = await createAppeal(alice, batchId,
    [{ key: '0.phone', reason: 'not-a-reason' }], null);
  assert.equal(badReason.status, 400);
  assert.equal(badReason.data.error.code, 'INVALID_APPEAL_REASON');

  // 邀请数必须 2-5
  const tooFew = await request('POST', '/api/review-appeals', auth(alice, {
    body: {
      batchId, ttlMinutes: 60,
      fields: [{ key: '0.phone', reason: 'new_evidence', acceptThreshold: 1, rejectThreshold: 1, evidenceOpinionIds: [] }],
      invitations: [{ label: '仅一位', fields: ['0.phone'] }],
    },
  }));
  assert.equal(tooFew.status, 400);
  assert.equal(tooFew.data.error.code, 'INVALID_APPEAL_INVITATIONS');

  // 授权字段不在申诉回合中
  const badScope = await createAppeal(alice, batchId, [{ key: '0.phone' }],
    [{ label: '甲', fields: ['0.phone'] }, { label: '乙', fields: ['1.province'] }]);
  assert.equal(badScope.status, 400);
  assert.equal(badScope.data.error.code, 'INVALID_APPEAL_FIELD_SCOPE');

  // 证据授权了不存在的原意见
  const badEvidence = await createAppeal(alice, batchId,
    [{ key: '0.phone', evidenceOpinionIds: [randomId()] }], null);
  assert.equal(badEvidence.status, 400);
  assert.equal(badEvidence.data.error.code, 'INVALID_APPEAL_EVIDENCE');

  // 正常创建
  const ok = await createAppeal(alice, batchId, [{ key: '0.phone' }]);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.round.status, 'in_review'); // 申诉回合创建即开放，独立限时起算
  assert.equal(ok.data.links.length, 2);
  assert.ok(ok.data.links.every((l) => /^\/appeal-review\?t=/.test(l.url)));

  // 同批次只能有一个未终结申诉回合
  const second = await createAppeal(alice, batchId, [{ key: '2.description' }], null);
  assert.equal(second.status, 409);
  assert.equal(second.data.error.code, 'APPEAL_ALREADY_OPEN');

  // 已在进行中申诉的字段不能重复申诉（即使另起回合）
  // —— 取消后历史保留，且可对其他字段再发起
  const cancel = await request('POST', `/api/review-appeals/${ok.data.round.id}/cancel`, auth(alice, { body: {} }));
  assert.equal(cancel.status, 200);
  assert.equal(cancel.data.round.status, 'cancelled');

  // 取消后原批次驳回决议仍在，可对该字段再次发起（历史回合不删除）
  const again = await createAppeal(alice, batchId, [{ key: '0.phone' }], null);
  assert.equal(again.status, 200, JSON.stringify(again.data));
  const rounds = (await request('GET', '/api/review-appeals?batchId=' + batchId, auth(alice))).data.appeals;
  assert.equal(rounds.length, 2);
  assert.ok(rounds.some((r) => r.status === 'cancelled'));
});

test('② 新复核人只能看到授权脱敏字段、原驳回决议与授权证据；越权读取/提交被拒绝', async () => {
  const bob = await login('bob');
  await abandonIfAny(bob);
  const { receipt } = await completeAll(bob);
  const { batchId } = await setupRejectedBatch(bob, receipt.receiptNo);

  // 找到 phone 字段 A 的原意见 id，作为授权证据
  const batch = (await request('GET', `/api/review-batches/${batchId}`, auth(bob))).data.batch;
  const phoneField = batch.fields.find((f) => f.key === '0.phone');
  const aOpinion = phoneField.opinions.find((o) => /应核对/.test(o.reason));
  assert.ok(aOpinion);

  // 甲只授权 phone；乙授权 phone+description；只披露 phone 的 A 意见
  const created = await createAppeal(bob, batchId,
    [
      { key: '0.phone', evidenceOpinionIds: [aOpinion.id] },
      { key: '2.description', evidenceOpinionIds: [] },
    ],
    [
      { label: '申诉甲', fields: ['0.phone'] },
      { label: '申诉乙', fields: ['0.phone', '2.description'] },
    ]);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const roundId = created.data.round.id;

  const jia = await validateAppeal(created.data.links[0].token);
  const yi = await validateAppeal(created.data.links[1].token);
  // 第二个邀请校验完成 → 自动进入复核
  assert.equal(yi.res.data.autoStarted, false); // 回合创建即开放，无需等待全部校验

  const ctxJia = await appealContext(jia);
  assert.equal(ctxJia.status, 200);
  const cj = ctxJia.data.context;
  // 只有被授权的 phone 出现在脱敏视图中
  assert.deepEqual(cj.view.steps.flatMap((s) => s.fields.map((f) => f.key)), ['0.phone']);
  // 合并视图也只含 phone
  assert.deepEqual(cj.merged.map((m) => m.key), ['0.phone']);
  const mergedPhone = cj.merged[0];
  // 原字段既有驳回决议（理由/时间）可见，但处理人等未授权隐私不下发
  assert.equal(mergedPhone.originalDecision.decision, 'rejected');
  assert.match(mergedPhone.originalDecision.reason, /原申报手机号无误/);
  assert.equal(mergedPhone.originalDecision.decidedBy, undefined);
  // 证据：仅授权的 1 条，原复核人匿名化为“原复核人N”，不出现原邀请名称
  assert.equal(mergedPhone.evidence.length, 1);
  assert.match(mergedPhone.evidence[0].alias, /^原复核人\d+$/);
  assert.match(mergedPhone.evidence[0].reason, /应核对/);
  // 整段响应不含原复核人标签、原始敏感值
  const serialized = JSON.stringify(cj);
  assert.ok(!serialized.includes('复核人A'), '原复核人身份不得泄露');
  assert.ok(!serialized.includes('复核人B'), '未授权字段的原复核人不得出现');
  assert.ok(!serialized.includes('APPEAL-SECRET-ID-001'), '证件号码不得下发');
  assert.ok(!serialized.includes('申诉秘密地址'), '未授权详细地址原值不得下发');
  assert.ok(!serialized.includes('补充材料'), '未授权字段的原证据不得下发');
  assert.match(cj.view.steps[0].fields[0].value, /^138\*\*\*\*8000$/);

  // 越权提交未授权字段
  const cross = await submitAppeal(jia, '2.description', '甲越权评价描述字段');
  assert.equal(cross.status, 403);
  assert.equal(cross.data.error.code, 'APPEAL_FIELD_NOT_AUTHORIZED');

  // 越权读取：乙的视图包含两个字段，甲永远拿不到 description
  const ctxYi = await appealContext(yi);
  assert.deepEqual(ctxYi.data.context.merged.map((m) => m.key).sort(), ['0.phone', '2.description']);
  // description 未授权证据：证据列表为空
  const descMerged = ctxYi.data.context.merged.find((m) => m.key === '2.description');
  assert.deepEqual(descMerged.evidence, []);

  // 无会话 / CSRF 缺失
  const noSession = await request('POST', '/api/appeal-review/opinions', {
    body: { key: '0.phone', reason: '无会话意见', idempotencyKey: randomId() },
  });
  assert.equal(noSession.status, 401);
  assert.equal(noSession.data.error.code, 'APPEAL_SESSION_REQUIRED');
  const noCsrf = await request('POST', '/api/appeal-review/opinions', {
    headers: { Cookie: jia.cookie },
    body: { key: '0.phone', reason: '缺少 csrf', idempotencyKey: randomId() },
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.data.error.code, 'APPEAL_CSRF_INVALID');

  // 携带其他回执编号：回执不匹配
  const mismatch = await request('POST', '/api/appeal-review/opinions', {
    headers: appealHeaders(jia),
    body: { key: '0.phone', reason: '尝试他份回执', idempotencyKey: randomId(), receiptNo: 'HZ-20000101-BBBBBBBB' },
  });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.data.error.code, 'APPEAL_RECEIPT_MISMATCH');

  // 原批次决议未被申诉流程修改
  const batchAfter = (await request('GET', `/api/review-batches/${batchId}`, auth(bob))).data.batch;
  for (const f of batchAfter.fields) assert.equal(f.decision, 'rejected');
  void roundId;
});

test('③ 同一申诉字段的意见按复核人合并展示；相同幂等键重试返回同一意见，换内容失败', async () => {
  const carol = await login('carol');
  await abandonIfAny(carol);
  const { receipt } = await completeAll(carol);
  const { batchId } = await setupRejectedBatch(carol, receipt.receiptNo);
  const created = await createAppeal(carol, batchId, [
    { key: '0.phone', acceptThreshold: 2, rejectThreshold: 1 },
  ]);
  const roundId = created.data.round.id;
  const jia = await validateAppeal(created.data.links[0].token);
  const yi = await validateAppeal(created.data.links[1].token);

  const idem = randomId();
  const payload = { key: '0.phone', reason: '申诉甲：新证据显示号码应为 13900000000', idempotencyKey: idem };
  const first = await request('POST', '/api/appeal-review/opinions', { headers: appealHeaders(jia), body: payload });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const replay = await request('POST', '/api/appeal-review/opinions', { headers: appealHeaders(jia), body: payload });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replay, true);
  assert.equal(replay.data.opinion.id, first.data.opinion.id);

  const swapped = await request('POST', '/api/appeal-review/opinions', {
    headers: appealHeaders(jia),
    body: { key: '0.phone', reason: '换了一段完全不同的说明', idempotencyKey: idem },
  });
  assert.equal(swapped.status, 409);
  assert.equal(swapped.data.error.code, 'OBJECTION_DUPLICATE_KEY');

  // 同一邀请对同一字段只能一条
  const dup = await submitAppeal(jia, '0.phone', '甲再次提交');
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, 'APPEAL_FIELD_DUPLICATE_OPINION');

  await submitAppeal(yi, '0.phone', '申诉乙：我也支持更正手机号');

  // 办理人视角：同一字段意见按复核人合并
  const round = (await request('GET', `/api/review-appeals/${roundId}`, auth(carol))).data.round;
  const phone = round.fields.find((f) => f.key === '0.phone');
  assert.equal(phone.opinionCount, 2);
  assert.deepEqual(phone.opinions.map((o) => o.reviewerLabel), ['申诉复核人甲', '申诉复核人乙']);
});

test('④ 两个办理页面并发发起申诉：只有一个成功', async () => {
  const dave = await login('dave');
  await abandonIfAny(dave);
  const { receipt } = await completeAll(dave);
  const { batchId } = await setupRejectedBatch(dave, receipt.receiptNo);
  const body = {
    batchId,
    ttlMinutes: 60,
    fields: [{ key: '0.phone', reason: 'procedural', acceptThreshold: 1, rejectThreshold: 1, evidenceOpinionIds: [] }],
    invitations: [
      { label: '并发甲', fields: ['0.phone'] },
      { label: '并发乙', fields: ['0.phone'] },
    ],
  };
  const dave2 = await login('dave');
  const [a, b] = await Promise.all([
    request('POST', '/api/review-appeals', auth(dave, { body })),
    request('POST', '/api/review-appeals', auth(dave2, { body })),
  ]);
  assert.equal([a.status, b.status].filter((s) => s === 200).length, 1);
  const loser = a.status === 200 ? b : a;
  assert.equal(loser.status, 409);
  assert.equal(loser.data.error.code, 'APPEAL_ALREADY_OPEN');
  const rounds = (await request('GET', `/api/review-appeals?batchId=${batchId}`, auth(dave))).data.appeals;
  assert.equal(rounds.filter((r) => ['collecting', 'in_review'].includes(r.status)).length, 1);
});

test('⑤ 阈值不足不能决议；达到阈值接受生成并关联新更正办理；驳回保存理由；有决议不能取消', async () => {
  const erin = await login('erin');
  await abandonIfAny(erin);
  const { receipt } = await completeAll(erin);
  const { batchId } = await setupRejectedBatch(erin, receipt.receiptNo);
  const created = await createAppeal(erin, batchId, [
    { key: '0.phone', acceptThreshold: 2, rejectThreshold: 2 },
    { key: '2.description', acceptThreshold: 1, rejectThreshold: 1 },
  ]);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const roundId = created.data.round.id;
  const getField = async (key) => {
    const round = (await request('GET', `/api/review-appeals/${roundId}`, auth(erin))).data.round;
    return round.fields.find((f) => f.key === key);
  };
  const jia = await validateAppeal(created.data.links[0].token);
  const yi = await validateAppeal(created.data.links[1].token);

  const phoneId = (await getField('0.phone')).id;
  const descId = (await getField('2.description')).id;

  // 尚无意见：接受阈值 2 不足
  const acceptEarly = await request('POST', `/api/review-appeals/${roundId}/fields/${phoneId}/accept`, auth(erin, { body: {} }));
  assert.equal(acceptEarly.status, 409);
  assert.equal(acceptEarly.data.error.code, 'ACCEPT_THRESHOLD_NOT_MET');

  // 驳回无理由 → 400
  const rejectNoReason = await request('POST', `/api/review-appeals/${roundId}/fields/${phoneId}/reject`, auth(erin, { body: { reason: 'x' } }));
  assert.equal(rejectNoReason.status, 400);
  assert.equal(rejectNoReason.data.error.code, 'REJECT_REASON_REQUIRED');

  // 甲就 phone 提意见：接受 1 < 2 仍不足
  await submitAppeal(jia, '0.phone', '甲：新证据证明手机号正确');
  const acceptOne = await request('POST', `/api/review-appeals/${roundId}/fields/${phoneId}/accept`, auth(erin, { body: {} }));
  assert.equal(acceptOne.status, 409);
  assert.equal(acceptOne.data.error.code, 'ACCEPT_THRESHOLD_NOT_MET');

  // description：2 位已校验、0 人提意见 → 支持驳回 2 ≥ 2，驳回成立并保存理由
  const rejectDesc = await request('POST', `/api/review-appeals/${roundId}/fields/${descId}/reject`, auth(erin, {
    body: { reason: '申诉阶段无新复核人支持该字段申诉，维持原驳回决议' },
  }));
  assert.equal(rejectDesc.status, 200, JSON.stringify(rejectDesc.data));
  assert.equal(rejectDesc.data.field.decision, 'rejected');
  assert.match(rejectDesc.data.field.decisionReason, /维持原驳回决议/);

  // 已有字段决议 → 不能取消，历史不能删除
  const cancelAfterDecision = await request('POST', `/api/review-appeals/${roundId}/cancel`, auth(erin, { body: {} }));
  assert.equal(cancelAfterDecision.status, 409);
  assert.equal(cancelAfterDecision.data.error.code, 'APPEAL_HAS_DECISIONS');

  // 乙再就 phone 提意见：达到接受阈值 2 → 接受，生成新的更正办理
  await submitAppeal(yi, '0.phone', '乙：证据链完整，建议更正');
  const accept = await request('POST', `/api/review-appeals/${roundId}/fields/${phoneId}/accept`, auth(erin, { body: {} }));
  assert.equal(accept.status, 200, JSON.stringify(accept.data));
  assert.equal(accept.data.createdCorrection, true);
  assert.equal(accept.data.workflow.sourceReceiptNo, receipt.receiptNo);
  assert.equal(accept.data.roundCompleted, true);

  // 重复决议：返回同一结果
  const repeat = await request('POST', `/api/review-appeals/${roundId}/fields/${phoneId}/accept`, auth(erin, { body: {} }));
  assert.equal(repeat.status, 409);
  assert.equal(repeat.data.error.code, 'APPEAL_FIELD_ALREADY_DECIDED');
  assert.equal(repeat.data.field.decision, 'accepted');

  // 来源关联：同一份更正办理同时关联两条申诉意见，且可追溯到原批次
  const { db } = await import('../src/db.js');
  const links = db.prepare(`
    SELECT co.* FROM correction_objections co
    JOIN review_appeal_opinions ao ON ao.id = co.appeal_opinion_id
    WHERE ao.round_id = ?
  `).all(roundId);
  assert.equal(links.length, 2);
  assert.equal(new Set(links.map((l) => l.workflow_id)).size, 1);
  // 同一份更正显式关联原批次与申诉回合来源
  assert.ok(links.every((l) => l.source_batch_id === batchId));
  assert.ok(links.every((l) => l.source_round_id === roundId));
  const workflowId = links[0].workflow_id;
  const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId);
  assert.equal(workflow.source_receipt_no, receipt.receiptNo);
  const roundRow = db.prepare('SELECT * FROM review_appeal_rounds WHERE id = ?').get(roundId);
  assert.equal(roundRow.batch_id, batchId);

  // 完成更正 → 新回执回填申诉字段与意见；原批次字段仍为 rejected（未被修改）
  const { receipt: newReceipt } = await completeAll(erin, PAYLOADS('13900009999'));
  assert.notEqual(newReceipt.receiptNo, receipt.receiptNo);
  const roundAfter = (await request('GET', `/api/review-appeals/${roundId}`, auth(erin))).data.round;
  const phoneAfter = roundAfter.fields.find((f) => f.key === '0.phone');
  assert.equal(phoneAfter.correctionReceiptNo, newReceipt.receiptNo);
  assert.ok(phoneAfter.opinions.every((o) => o.correctionReceiptNo === newReceipt.receiptNo));
  const batchAfter = (await request('GET', `/api/review-batches/${batchId}`, auth(erin))).data.batch;
  assert.ok(batchAfter.fields.every((f) => f.decision === 'rejected'), '原批次决议不得被申诉修改');

  // 时间线区分：原批次决议、申诉事件、后续更正回执
  const state = (await request('GET', '/api/state', auth(erin))).data;
  const appealEntry = state.timeline.find((t) => t.kind === 'reviewAppeal' && t.roundId === roundId);
  assert.ok(appealEntry, '时间线包含申诉回合条目');
  assert.equal(appealEntry.batchId, batchId);
  const eventTypes = appealEntry.events.map((e) => e.type);
  for (const type of ['review.appeal.created', 'review.appeal.field.rejected', 'review.appeal.field.accepted', 'review.appeal.correction.completed']) {
    assert.ok(eventTypes.includes(type), `缺少申诉事件 ${type}`);
  }
  const appealIndex = state.timeline.findIndex((t) => t.kind === 'reviewAppeal' && t.roundId === roundId);
  const batchIndex = state.timeline.findIndex((t) => t.kind === 'reviewBatch' && t.batchId === batchId);
  assert.ok(batchIndex >= 0 && appealIndex > batchIndex, '申诉条目紧跟原批次之后');
  const newReceiptEntry = state.timeline.find((t) => t.kind === 'receipt' && t.receiptNo === newReceipt.receiptNo);
  assert.equal(newReceiptEntry.sourceReceiptNo, receipt.receiptNo);
});

test('⑥ 申诉回合取消或邀请过期后写操作被拒绝', async () => {
  const alice = await login('alice');
  await abandonIfAny(alice);
  const state0 = (await request('GET', '/api/state', auth(alice))).data;
  // 基于最近回执走一次更正得到全新回执；尚无回执时先办理一份
  if (!state0.records.length) {
    await completeAll(alice, PAYLOADS('13500001111'));
  }
  const state1 = (await request('GET', '/api/state', auth(alice))).data;
  const src = state1.records[0].receiptNo;
  await request('POST', '/api/corrections', auth(alice, { body: { receiptNo: src } }));
  const { receipt } = await completeAll(alice, PAYLOADS('13511112222'));
  const { batchId } = await setupRejectedBatch(alice, receipt.receiptNo);

  // —— 取消分支 ——
  const created = await createAppeal(alice, batchId, [{ key: '0.phone' }]);
  const roundId = created.data.round.id;
  const session = await validateAppeal(created.data.links[0].token);
  // 取消前先提交一份意见：取消后会话只读、本人意见仍可见
  const beforeCancel = await submitAppeal(session, '0.phone', '取消前留档的申诉意见');
  assert.equal(beforeCancel.status, 200, JSON.stringify(beforeCancel.data));
  const cancel = await request('POST', `/api/review-appeals/${roundId}/cancel`, auth(alice, { body: { reason: '办理人取消测试' } }));
  assert.equal(cancel.status, 200);
  // 未使用邀请立即失效：校验明确失败
  const rawValidate = await request('POST', '/api/appeal-review/validate', { body: { token: created.data.links[1].token } });
  assert.equal(rawValidate.status, 410);
  assert.equal(rawValidate.data.error.code, 'APPEAL_INVITATION_REVOKED');
  // 已持有会话的复核人不能再提交，但上下文只读可见本人已提交意见
  const submitAfterCancel = await submitAppeal(session, '0.phone', '取消后尝试提交');
  assert.equal(submitAfterCancel.status, 410);
  assert.equal(submitAfterCancel.data.error.code, 'APPEAL_NOT_ACTIVE');
  const ctxAfterCancel = await appealContext(session);
  assert.equal(ctxAfterCancel.status, 200);
  assert.equal(ctxAfterCancel.data.context.canSubmit, false);
  assert.equal(ctxAfterCancel.data.context.view, null);
  assert.equal(ctxAfterCancel.data.context.opinions.length, 1);
  assert.match(ctxAfterCancel.data.context.opinions[0].reason, /取消前留档/);
  // 办理人不能再决议
  const fieldId = cancel.data.round.fields[0].id;
  const decideAfterCancel = await request('POST', `/api/review-appeals/${roundId}/fields/${fieldId}/accept`, auth(alice, { body: {} }));
  assert.equal(decideAfterCancel.status, 410);
  assert.equal(decideAfterCancel.data.error.code, 'APPEAL_NOT_ACTIVE');
  // 重复取消明确失败
  const cancelAgain = await request('POST', `/api/review-appeals/${roundId}/cancel`, auth(alice, { body: {} }));
  assert.equal(cancelAgain.status, 409);

  // —— 过期分支：新回合，校验后回拨时间 ——
  const created2 = await createAppeal(alice, batchId, [{ key: '0.phone' }, { key: '2.description' }],
    [
      { label: '过期甲', fields: ['0.phone', '2.description'] },
      { label: '过期乙', fields: ['0.phone', '2.description'] },
      { label: '过期丙（不校验）', fields: ['0.phone'] },
    ]);
  assert.equal(created2.status, 200, JSON.stringify(created2.data));
  const roundId2 = created2.data.round.id;
  // 第三个邀请保持未使用：过期后它的校验必须明确失败
  const unusedToken = created2.data.links[2].token;
  const expSession = await validateAppeal(created2.data.links[0].token);
  await validateAppeal(created2.data.links[1].token);
  await submitAppeal(expSession, '2.description', '过期前提交的意见');

  const { db } = await import('../src/db.js');
  const past = Date.now() - 1000;
  db.prepare('UPDATE review_appeal_rounds SET expires_at = ? WHERE id = ?').run(past, roundId2);
  db.prepare('UPDATE review_appeal_invitations SET expires_at = ? WHERE round_id = ?').run(past, roundId2);
  db.prepare('UPDATE review_appeal_sessions SET expires_at = ? WHERE round_id = ?').run(past, roundId2);

  // 未使用邀请过期后校验失败
  const validateUnusedExpired = await request('POST', '/api/appeal-review/validate', { body: { token: unusedToken } });
  assert.equal(validateUnusedExpired.status, 410);
  assert.equal(validateUnusedExpired.data.error.code, 'APPEAL_INVITATION_EXPIRED');

  // 复核人写操作：回合限时已过，写操作明确拒绝（410）
  const submitAfterExpiry = await submitAppeal(expSession, '0.phone', '过期后尝试提交');
  assert.equal(submitAfterExpiry.status, 410);
  assert.ok(['APPEAL_DEADLINE_PASSED', 'APPEAL_INVITATION_EXPIRED'].includes(submitAfterExpiry.data.error.code));
  // 已使用邀请重复校验失败（一次性）；回合已过期时也可能先返回过期
  const validateExpired = await request('POST', '/api/appeal-review/validate', { body: { token: created2.data.links[0].token } });
  assert.equal(validateExpired.status, 410);
  assert.ok(['APPEAL_INVITATION_ALREADY_USED', 'APPEAL_INVITATION_EXPIRED'].includes(validateExpired.data.error.code));
  // 办理人决议：惰性落定后明确失败
  const field2 = created2.data.round.fields.find((f) => f.key === '0.phone').id;
  const decideAfterExpiry = await request('POST', `/api/review-appeals/${roundId2}/fields/${field2}/reject`, auth(alice, {
    body: { reason: '过期后尝试决议理由足够长' },
  }));
  assert.equal(decideAfterExpiry.status, 410);
  assert.equal(decideAfterExpiry.data.error.code, 'APPEAL_DEADLINE_PASSED');
  // 回合已被惰性落定为 expired，且历史保留
  const round2View = (await request('GET', `/api/review-appeals/${roundId2}`, auth(alice))).data.round;
  assert.equal(round2View.status, 'expired');
  assert.equal(round2View.fields.find((f) => f.key === '2.description').opinionCount, 1);

  // 过期回合不删除；可对同字段重新发起申诉
  const created3 = await createAppeal(alice, batchId, [{ key: '0.phone' }]);
  assert.equal(created3.status, 200, JSON.stringify(created3.data));
  const rounds = (await request('GET', `/api/review-appeals?batchId=${batchId}`, auth(alice))).data.appeals;
  assert.ok(rounds.some((r) => r.status === 'cancelled'));
  assert.ok(rounds.some((r) => r.status === 'expired'));
  assert.ok(rounds.some((r) => r.status === 'in_review'));
});

test('⑦ 服务重启后原批次与申诉回合的关系、时间线与申诉会话仍完整', async () => {
  const bob = await login('bob');
  await abandonIfAny(bob);
  // 用一份全新回执；尚无回执时先办理一份
  const state0 = (await request('GET', '/api/state', auth(bob))).data;
  if (!state0.records.length) {
    await completeAll(bob, PAYLOADS('13600000000'));
  }
  const state1 = (await request('GET', '/api/state', auth(bob))).data;
  const src = state1.records[0].receiptNo;
  await request('POST', '/api/corrections', auth(bob, { body: { receiptNo: src } }));
  const { receipt } = await completeAll(bob, PAYLOADS('13677778888'));
  const { batchId } = await setupRejectedBatch(bob, receipt.receiptNo);

  const batch = (await request('GET', `/api/review-batches/${batchId}`, auth(bob))).data.batch;
  const aOpinion = batch.fields.find((f) => f.key === '0.phone').opinions.find((o) => /应核对/.test(o.reason));
  assert.ok(aOpinion, '原批次 phone 字段存在 A 的意见');
  const created = await createAppeal(bob, batchId,
    [{ key: '0.phone', acceptThreshold: 2, evidenceOpinionIds: [aOpinion.id] }]);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const roundId = created.data.round.id;
  const sessionJia = await validateAppeal(created.data.links[0].token);
  await submitAppeal(sessionJia, '0.phone', '重启持久化：甲的申诉意见');

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

    const batchEntry = state.timeline.find((t) => t.kind === 'reviewBatch' && t.batchId === batchId);
    assert.ok(batchEntry, '原批次仍在时间线');
    const appealEntry = state.timeline.find((t) => t.kind === 'reviewAppeal' && t.roundId === roundId);
    assert.ok(appealEntry, '申诉回合仍在时间线');
    assert.equal(appealEntry.batchId, batchId, '申诉与原批次关系保持');
    assert.equal(appealEntry.status, 'in_review');
    assert.equal(appealEntry.invitationCount, 2);
    assert.equal(appealEntry.validatedCount, 1);
    const phone = appealEntry.fields.find((f) => f.key === '0.phone');
    assert.equal(phone.decision, null);
    assert.equal(phone.originalDecision.decision, 'rejected');
    assert.equal(phone.evidence.length, 1);
    assert.match(phone.evidence[0].alias, /^原复核人\d+$/);
    assert.equal(phone.opinions.length, 1);
    assert.match(phone.opinions[0].reason, /甲的申诉意见/);
    // 原批次字段决议仍是驳回
    const batchPhone = batchEntry.fields.find((f) => f.key === '0.phone');
    assert.equal(batchPhone.decision, 'rejected');
    // 审计事件持久化
    assert.ok(appealEntry.events.some((e) => e.type === 'review.appeal.created'));
    assert.ok(appealEntry.events.some((e) => e.type === 'review.appeal.opinion.submitted'));
    // 位置关系：申诉条目在原批次条目之后
    assert.ok(state.timeline.indexOf(appealEntry) > state.timeline.indexOf(batchEntry));

    // 免登录申诉会话也持久化：重启后凭 cookie 仍只能读到授权内容
    const ctxRes = await fetch(`${child.url}/api/appeal-review/context`, { headers: { Cookie: sessionJia.cookie } });
    assert.equal(ctxRes.status, 200);
    const ctxBody = await ctxRes.json();
    assert.deepEqual(ctxBody.context.view.steps.flatMap((s) => s.fields.map((f) => f.key)), ['0.phone']);
    const merged = ctxBody.context.merged[0];
    assert.equal(merged.opinionCount, 1);
    assert.equal(merged.evidence.length, 1);
    assert.equal(merged.originalDecision.decision, 'rejected');
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
    const timer = setTimeout(() => reject(new Error('Restart server did not start')), 8000);
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
      reject(new Error(`Server exited early with code ${code}: ${output}`));
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
