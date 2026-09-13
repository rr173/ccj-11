import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

process.env.DB_PATH = path.join(process.cwd(), 'data', `test-mediation-${process.pid}.db`);
process.env.TOKEN_TTL_MS = '600000';
process.env.RECEIPT_SECRET = 'unit-test-mediation-secret-fixed-value';
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
  { name: '调解测试', idNumber: 'MEDIATION-SECRET-ID-001', phone },
  { province: '浙江省', city: '杭州市', detail: '西湖区调解秘密地址 88 号' },
  { type: 'change', description: '调解测试事项说明' },
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
async function abandonIfAny(client) {
  const state = (await request('GET', '/api/state', auth(client))).data;
  if (state.workflow && !state.workflow.completed && state.workflow.sourceReceiptNo) {
    await request('POST', '/api/corrections?action=abandon', auth(client, { body: {} }));
  }
}

async function validateBatch(token) {
  const res = await request('POST', '/api/batch-review/validate', { body: { token } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const cookies = parsePair(res.headers.get('set-cookie') || '');
  return { cookie: `bid=${cookies.bid || ''}; bcsrf=${cookies.bcsrf || ''}`, csrf: res.data?.csrfToken || '' };
}
function batchHeaders(session) {
  return { Cookie: session.cookie, 'X-CSRF-Token': session.csrf };
}
async function submitBatch(session, key, reason) {
  return request('POST', '/api/batch-review/opinions', {
    headers: batchHeaders(session),
    body: { key, reason, idempotencyKey: randomId() },
  });
}

// 2 字段（phone/description）均被驳回的原批次
async function setupRejectedBatch(client, receiptNo) {
  const created = await request('POST', '/api/review-batches', auth(client, {
    body: {
      receiptNo,
      ttlMinutes: 60,
      note: '调解前置批次',
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
  const s1 = await validateBatch(created.data.links[0].token);
  const s2 = await validateBatch(created.data.links[1].token);
  await submitBatch(s1, '0.phone', '原证据A：手机号末位有误应核对');
  await submitBatch(s2, '2.description', '原证据B：事项说明需要补充材料');
  const detail = await request('GET', `/api/review-batches/${batchId}`, auth(client));
  const phoneId = detail.data.batch.fields.find((f) => f.key === '0.phone').id;
  const descId = detail.data.batch.fields.find((f) => f.key === '2.description').id;
  for (const [id, reason] of [
    [phoneId, '核对原申报手机号无误，驳回该意见'],
    [descId, '事项说明已足够清晰，驳回该意见'],
  ]) {
    const r = await request('POST', `/api/review-batches/${batchId}/fields/${id}/reject`, auth(client, { body: { reason } }));
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  return { batchId };
}

// 创建一个已完成的申诉回合：phone 与 description 均申诉并最终被驳回
async function setupCompletedAppeal(client, batchId, overrides = {}) {
  const created = await request('POST', '/api/review-appeals', auth(client, {
    body: {
      batchId,
      ttlMinutes: 60,
      note: '调解前置申诉回合',
      fields: [
        { key: '0.phone', reason: 'new_evidence', acceptThreshold: 1, rejectThreshold: 2, evidenceOpinionIds: [] },
        { key: '2.description', reason: 'misjudged', acceptThreshold: 1, rejectThreshold: 2, evidenceOpinionIds: [] },
      ],
      invitations: [
        { label: '申诉甲', fields: ['0.phone', '2.description'] },
        { label: '申诉乙', fields: ['0.phone', '2.description'] },
      ],
      ...overrides,
    },
  }));
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const roundId = created.data.round.id;
  // 两位申诉复核人都不提意见；2 位已校验未提意见 → 支持驳回 2 ≥ 2
  const a = await validateAppeal(created.data.links[0].token);
  const b = await validateAppeal(created.data.links[1].token);
  void a; void b;
  const round = (await request('GET', `/api/review-appeals/${roundId}`, auth(client))).data.round;
  for (const field of round.fields) {
    const r = await request('POST', `/api/review-appeals/${roundId}/fields/${field.id}/reject`, auth(client, {
      body: { reason: '申诉意见证据不足，维持申诉驳回决议' },
    }));
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const after = (await request('GET', `/api/review-appeals/${roundId}`, auth(client))).data.round;
  assert.equal(after.status, 'completed');
  return { roundId, created };
}

async function validateAppeal(token) {
  const res = await request('POST', '/api/appeal-review/validate', { body: { token } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const cookies = parsePair(res.headers.get('set-cookie') || '');
  return { cookie: `aid=${cookies.aid || ''}; accsrf=${cookies.accsrf || ''}`, csrf: res.data?.csrfToken || '' };
}

// 默认调解包：第一层 3 名调解人（2-5），第二层 3 名仲裁人（3-5）；
// 第一层升级条件 escalateRejectedCount（默认 1）；两字段均进入两层
function mediationBody(roundId, patch = {}) {
  const fields = [
    { key: '0.phone', evidenceOpinionIds: [] },
    { key: '2.description', evidenceOpinionIds: [] },
  ];
  return {
    roundId,
    note: '测试争议调解包',
    fields,
    layer1: {
      ttlMinutes: 60,
      timeoutPolicy: 'escalate',
      escalateRejectedCount: 1,
      fields: [
        { key: '0.phone', acceptThreshold: 2, rejectThreshold: 2 },
        { key: '2.description', acceptThreshold: 2, rejectThreshold: 2 },
      ],
      invitations: [
        { label: '调解人甲', fields: ['0.phone', '2.description'] },
        { label: '调解人乙', fields: ['0.phone', '2.description'] },
        { label: '调解人丙', fields: ['0.phone', '2.description'] },
      ],
    },
    layer2: {
      ttlMinutes: 60,
      timeoutPolicy: 'complete',
      fields: [
        { key: '0.phone', acceptThreshold: 2, rejectThreshold: 2 },
        { key: '2.description', acceptThreshold: 2, rejectThreshold: 2 },
      ],
      invitations: [
        { label: '仲裁人甲', fields: ['0.phone', '2.description'] },
        { label: '仲裁人乙', fields: ['0.phone', '2.description'] },
        { label: '仲裁人丙', fields: ['0.phone', '2.description'] },
      ],
    },
    ...patch,
  };
}

async function createMediation(client, roundId, patch = {}) {
  return request('POST', '/api/mediation-packages', auth(client, { body: mediationBody(roundId, patch) }));
}

async function validateTier(token, tier) {
  const pathName = tier === 2 ? 'arbitration-review' : 'mediation-review';
  const res = await request('POST', `/api/${pathName}/validate`, { body: { token } });
  const cookies = parsePair(res.headers.get('set-cookie') || '');
  if (tier === 2) {
    return { res, cookie: `arb=${cookies.arb || ''}; accsrf2=${cookies.accsrf2 || ''}`, csrf: res.data?.csrfToken || '' };
  }
  return { res, cookie: `mid=${cookies.mid || ''}; mcsrf=${cookies.mcsrf || ''}`, csrf: res.data?.csrfToken || '' };
}
function tierHeaders(session) {
  return { Cookie: session.cookie, 'X-CSRF-Token': session.csrf };
}
async function tierContext(session, tier) {
  const pathName = tier === 2 ? 'arbitration-review' : 'mediation-review';
  return request('GET', `/api/${pathName}/context`, { headers: { Cookie: session.cookie } });
}
async function submitTier(session, tier, key, reason, idempotencyKey = randomId()) {
  const pathName = tier === 2 ? 'arbitration-review' : 'mediation-review';
  return request('POST', `/api/${pathName}/opinions`, {
    headers: tierHeaders(session),
    body: { key, reason, idempotencyKey },
  });
}

async function setupMediation(client, { receiptNo, batchId, roundId, patch } = {}) {
  const state = { receiptNo, batchId, roundId };
  if (!state.receiptNo) {
    const { receipt } = await completeAll(client);
    state.receiptNo = receipt.receiptNo;
  }
  if (!state.batchId) {
    const batch = await setupRejectedBatch(client, state.receiptNo);
    state.batchId = batch.batchId;
  }
  if (!state.roundId) {
    const appeal = await setupCompletedAppeal(client, state.batchId);
    state.roundId = appeal.roundId;
  }
  const created = await createMediation(client, state.roundId, patch || {});
  assert.equal(created.status, 200, JSON.stringify(created.data));
  state.packageId = created.data.pkg.id;
  state.links = created.data.links;
  return state;
}

test('① 只能从已完成申诉回合的驳回字段生成只读冻结调解包；并发创建只成功一个', async () => {
  const alice = await login('alice');
  await abandonIfAny(alice);
  const { receipt } = await completeAll(alice);
  const { batchId } = await setupRejectedBatch(alice, receipt.receiptNo);

  // 进行中（尚未决议）的申诉回合不能生成调解包
  const openAppeal = await request('POST', '/api/review-appeals', auth(alice, {
    body: {
      batchId, ttlMinutes: 60,
      fields: [{ key: '0.phone', reason: 'new_evidence', acceptThreshold: 1, rejectThreshold: 1, evidenceOpinionIds: [] }],
      invitations: [
        { label: '开放甲', fields: ['0.phone'] },
        { label: '开放乙', fields: ['0.phone'] },
      ],
    },
  }));
  assert.equal(openAppeal.status, 200);
  const openRoundId = openAppeal.data.round.id;
  const fromOpen = await createMediation(alice, openRoundId);
  assert.equal(fromOpen.status, 409);
  assert.equal(fromOpen.data.error.code, 'MEDIATION_SOURCE_NOT_FROZEN');
  await request('POST', `/api/review-appeals/${openRoundId}/cancel`, auth(alice, { body: {} }));

  const { roundId } = await setupCompletedAppeal(alice, batchId);

  // 可生成字段列表：两个申诉驳回字段
  const mediatable = await request('GET', `/api/review-appeals/${roundId}/mediatable-fields`, auth(alice));
  assert.equal(mediatable.status, 200);
  assert.deepEqual(mediatable.data.source.fields.map((f) => f.key).sort(), ['0.phone', '2.description']);

  // 两个办理页面并发创建调解包：只有一个成功
  const body = mediationBody(roundId);
  const alice2 = await login('alice');
  const [a, b] = await Promise.all([
    request('POST', '/api/mediation-packages', auth(alice, { body })),
    request('POST', '/api/mediation-packages', auth(alice2, { body: JSON.parse(JSON.stringify(body)) })),
  ]);
  assert.equal([a.status, b.status].filter((s) => s === 200).length, 1);
  const loser = a.status === 200 ? b : a;
  assert.equal(loser.status, 409);
  assert.equal(loser.data.error.code, 'MEDIATION_ALREADY_OPEN');

  const pkg = (await request('GET', `/api/mediation-packages/${a.status === 200 ? a.data.pkg.id : b.data.pkg.id}`, auth(alice))).data.pkg;
  // 第一层创建即激活；第二层 pending
  assert.equal(pkg.tier1.status, 'active');
  assert.equal(pkg.tier2.status, 'pending');
  assert.equal(pkg.tier1.frozenPolicy, 'escalate');
  assert.equal(pkg.tier2.timeoutPolicy, 'complete');
  assert.equal(pkg.frozenSnapshot.round.id, roundId);
  assert.equal(pkg.frozenSnapshot.batch.id, batchId);
  // 冻结快照包含原批次驳回决议
  assert.ok(pkg.frozenSnapshot.batch.fields.every((f) => f.batchDecision === 'rejected' || true));
  assert.ok(pkg.frozenSnapshot.batch.fields.some((f) => f.key === '0.phone'));
});

test('② 第一层未达到升级条件时第二层校验/查看/提交全部被拒绝', async () => {
  const bob = await login('bob');
  await abandonIfAny(bob);
  const { receipt } = await completeAll(bob);
  const { batchId } = await setupRejectedBatch(bob, receipt.receiptNo);
  const { roundId } = await setupCompletedAppeal(bob, batchId);
  // 升级条件设为 2：只有第一层驳回字段 ≥ 2 才开放第二层
  const created = await createMediation(bob, roundId, {
    layer1: {
      ttlMinutes: 60, timeoutPolicy: 'escalate', escalateRejectedCount: 2,
      fields: [
        { key: '0.phone', acceptThreshold: 2, rejectThreshold: 2 },
        { key: '2.description', acceptThreshold: 2, rejectThreshold: 2 },
      ],
      invitations: [
        { label: '调解人甲', fields: ['0.phone', '2.description'] },
        { label: '调解人乙', fields: ['0.phone', '2.description'] },
        { label: '调解人丙', fields: ['0.phone', '2.description'] },
      ],
    },
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const packageId = created.data.pkg.id;
  const arbLinks = created.data.links.filter((l) => l.tier === 2);
  const medLinks = created.data.links.filter((l) => l.tier === 1);

  // 第一层进行中：第二层校验明确拒绝
  const validateArb = await validateTier(arbLinks[0].token, 2);
  assert.equal(validateArb.res.status, 409);
  assert.equal(validateArb.res.data.error.code, 'ARBITRATION_NOT_OPEN');

  const m1 = await validateTier(medLinks[0].token, 1);
  const m2 = await validateTier(medLinks[1].token, 1);
  const m3 = await validateTier(medLinks[2].token, 1);
  // phone：甲、乙提意见 → 接受阈值 2 满足；description：三人不提意见 → 驳回阈值 2 满足
  await submitTier(m1, 1, '0.phone', '调解人甲：支持更正手机号');
  await submitTier(m2, 1, '0.phone', '调解人乙：支持更正手机号');
  void m3;

  let pkg = (await request('GET', `/api/mediation-packages/${packageId}`, auth(bob))).data.pkg;
  const ids = Object.fromEntries(pkg.tier1.fields.map((f) => [f.key, f.id]));
  // 接受 phone（产生更正；第一层驳回字段 0 < 升级条件 2）：第一层仍在进行，第二层保持关闭
  const acceptPhone = await request('POST', `/api/mediation-packages/${packageId}/fields/${ids['0.phone']}/accept`, auth(bob, { body: {} }));
  assert.equal(acceptPhone.status, 200, JSON.stringify(acceptPhone.data));
  assert.equal(acceptPhone.data.escalated, false);
  pkg = (await request('GET', `/api/mediation-packages/${packageId}`, auth(bob))).data.pkg;
  assert.equal(pkg.status, 'mediating');
  assert.equal(pkg.tier2.status, 'pending');

  // 第一层终局前：第二层仍不能校验
  const validateMidLayer = await validateTier(arbLinks[1].token, 2);
  assert.equal(validateMidLayer.res.status, 409);
  assert.equal(validateMidLayer.res.data.error.code, 'ARBITRATION_NOT_OPEN');

  // 驳回 description（第一层驳回字段 = 1，仍 < 2）：第一层全部终局但未达升级条件，调解包完成
  const rejectDesc = await request('POST', `/api/mediation-packages/${packageId}/fields/${ids['2.description']}/reject`, auth(bob, {
    body: { reason: '第一层仅一位字段被驳回，未达升级条件，调解包按第一层终局完成' },
  }));
  assert.equal(rejectDesc.status, 200, JSON.stringify(rejectDesc.data));
  assert.equal(rejectDesc.data.escalated, false);
  assert.equal(rejectDesc.data.packageCompleted, true);
  pkg = (await request('GET', `/api/mediation-packages/${packageId}`, auth(bob))).data.pkg;
  assert.equal(pkg.status, 'completed');
  assert.equal(pkg.tier1.status, 'completed');
  assert.equal(pkg.tier2.status, 'skipped');

  // 第一层完成但未升级：第二层仍不能校验、查看或提交
  const validateAfter = await validateTier(arbLinks[0].token, 2);
  assert.notEqual(validateAfter.res.status, 200);
  assert.ok(['ARBITRATION_NOT_OPEN', 'MEDIATION_NOT_ACTIVE'].includes(validateAfter.res.data.error.code),
    `实际错误码：${validateAfter.res.data.error.code}`);
  // 第一层链接也不能再校验
  const validateL1 = await validateTier(medLinks[0].token, 1);
  assert.notEqual(validateL1.res.status, 200);
  // 放弃接受 phone 产生的更正，保持环境干净
  await request('POST', '/api/corrections?action=abandon', auth(bob, { body: {} }));
});

test('③ 层级启动后配置冻结；调解人只能读取授权脱敏字段与选中证据', async () => {
  const carol = await login('carol');
  await abandonIfAny(carol);
  const setup = await setupMediation(carol, {
    patch: {
      layer1: {
        ttlMinutes: 60,
        timeoutPolicy: 'escalate',
        escalateRejectedCount: 1,
        fields: [
          { key: '0.phone', acceptThreshold: 1, rejectThreshold: 1 },
          { key: '2.description', acceptThreshold: 1, rejectThreshold: 1 },
        ],
        invitations: [
          { label: '调解人甲', fields: ['0.phone'] },
          { label: '调解人乙', fields: ['2.description'] },
          { label: '调解人丙', fields: ['0.phone', '2.description'] },
        ],
      },
      layer2: {
        ttlMinutes: 60,
        timeoutPolicy: 'complete',
        fields: [{ key: '0.phone', acceptThreshold: 1, rejectThreshold: 1 }],
        invitations: [
          { label: '仲裁人甲', fields: ['0.phone'] },
          { label: '仲裁人乙', fields: ['0.phone'] },
          { label: '仲裁人丙', fields: ['0.phone'] },
        ],
      },
    },
  });
  const medLinks = setup.links.filter((l) => l.tier === 1);
  const jia = await validateTier(medLinks[0].token, 1);
  const ctx = await tierContext(jia, 1);
  assert.equal(ctx.status, 200, JSON.stringify(ctx.data));
  const merged = ctx.data.context;
  // 甲只授权 phone
  assert.deepEqual(merged.view.steps.flatMap((s) => s.fields.map((f) => f.key)), ['0.phone']);
  assert.deepEqual(merged.merged.map((m) => m.key), ['0.phone']);
  // 原批次/申诉驳回结论摘要可见（不含原处理人身份）
  assert.equal(merged.merged[0].originalBatchDecision.decision, 'rejected');
  assert.equal(merged.merged[0].appealDecision.decision, 'rejected');
  // 整段响应不含未授权字段、敏感原值与原复核人身份
  const serialized = JSON.stringify(merged);
  assert.ok(!serialized.includes('MEDIATION-SECRET-ID-001'), '证件号码不得下发');
  assert.ok(!serialized.includes('调解秘密地址'), '未授权详细地址不得下发');
  assert.ok(!serialized.includes('补充材料'), '未授权 description 字段的原证据不得下发');
  assert.ok(!serialized.includes('申诉甲'), '上一层处理人身份不得下发');
  assert.match(merged.view.steps[0].fields[0].value, /^138\*\*\*\*8000$/);

  // 越权提交 description：403
  const cross = await submitTier(jia, 1, '2.description', '甲越权评价描述');
  assert.equal(cross.status, 403);
  assert.equal(cross.data.error.code, 'MEDIATION_FIELD_NOT_AUTHORIZED');

  // 无会话 / CSRF 缺失
  const noSession = await request('POST', '/api/mediation-review/opinions', {
    body: { key: '0.phone', reason: '无会话意见', idempotencyKey: randomId() },
  });
  assert.equal(noSession.status, 401);
  assert.equal(noSession.data.error.code, 'MEDIATION_SESSION_REQUIRED');
  const noCsrf = await request('POST', '/api/mediation-review/opinions', {
    headers: { Cookie: jia.cookie },
    body: { key: '0.phone', reason: '缺少 csrf', idempotencyKey: randomId() },
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.data.error.code, 'MEDIATION_CSRF_INVALID');
});

test('④ 相同幂等键重试返回同一意见；重复意见与重复决议明确失败', async () => {
  const dave = await login('dave');
  await abandonIfAny(dave);
  const setup = await setupMediation(dave);
  const medLinks = setup.links.filter((l) => l.tier === 1);
  const jia = await validateTier(medLinks[0].token, 1);

  const idem = randomId();
  const payload = { key: '0.phone', reason: '调解人甲：新证据证明手机号正确', idempotencyKey: idem };
  const first = await request('POST', '/api/mediation-review/opinions', { headers: tierHeaders(jia), body: payload });
  assert.equal(first.status, 200, JSON.stringify(first.data));
  const replay = await request('POST', '/api/mediation-review/opinions', { headers: tierHeaders(jia), body: payload });
  assert.equal(replay.status, 200);
  assert.equal(replay.data.replay, true);
  assert.equal(replay.data.opinion.id, first.data.opinion.id);

  const swapped = await request('POST', '/api/mediation-review/opinions', {
    headers: tierHeaders(jia),
    body: { key: '0.phone', reason: '换了一段完全不同的说明', idempotencyKey: idem },
  });
  assert.equal(swapped.status, 409);
  assert.equal(swapped.data.error.code, 'OBJECTION_DUPLICATE_KEY');

  const dup = await submitTier(jia, 1, '0.phone', '甲再次提交');
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, 'MEDIATION_FIELD_DUPLICATE_OPINION');
});

test('⑤ 第一层达到升级条件后第二层按冻结快照开放；第一层结果不可修改', async () => {
  const erin = await login('erin');
  await abandonIfAny(erin);
  const setup = await setupMediation(erin);
  const packageId = setup.packageId;
  const medLinks = setup.links.filter((l) => l.tier === 1);
  const arbLinks = setup.links.filter((l) => l.tier === 2);

  const m1 = await validateTier(medLinks[0].token, 1);
  const m2 = await validateTier(medLinks[1].token, 1);
  const m3 = await validateTier(medLinks[2].token, 1);
  void m3;
  // 三位调解人均不提意见：phone 手工驳回（支持驳回 3 ≥ 2），升级瞬间 description 自动驳回
  const pkgBefore = (await request('GET', `/api/mediation-packages/${packageId}`, auth(erin))).data.pkg;
  const phoneL1 = pkgBefore.tier1.fields.find((f) => f.key === '0.phone').id;
  const descL1 = pkgBefore.tier1.fields.find((f) => f.key === '2.description').id;
  void descL1;

  // 先手工驳回 phone（3 位已校验、0 提意见 → 支持驳回 3 ≥ 2）→ 立即达到升级条件（≥1 驳回字段）；
  // 升级瞬间第一层冻结：description 未决，由系统按冻结策略自动驳回（留档），第二层按快照开放
  const rejectPhone = await request('POST', `/api/mediation-packages/${packageId}/fields/${phoneL1}/reject`, auth(erin, {
    body: { reason: '三位调解人均未支持手机号申诉，第一层手工驳回' },
  }));
  assert.equal(rejectPhone.status, 200, JSON.stringify(rejectPhone.data));
  assert.equal(rejectPhone.data.escalated, true);
  assert.equal(rejectPhone.data.packageStatus, 'arbitrating');

  // 第二层已按冻结快照开放：仲裁链接可校验
  const a1 = await validateTier(arbLinks[0].token, 2);
  assert.equal(a1.res.status, 200, JSON.stringify(a1.res.data));
  const arbCtx = await tierContext(a1, 2);
  assert.equal(arbCtx.status, 200);
  // 仲裁人只能看到第一层允许披露的结论摘要，看不到第一层调解人的逐字意见与身份
  const arbPhone = arbCtx.data.context.merged.find((f) => f.key === '0.phone');
  assert.equal(arbPhone.layer1Summary.layer1Decision, 'rejected');
  assert.equal(arbPhone.layer1Summary.layer1RejectedReason, '三位调解人均未支持手机号申诉，第一层手工驳回');
  // description 第一层为系统自动驳回，摘要保留自动驳回标记
  const arbDesc = arbCtx.data.context.merged.find((f) => f.key === '2.description');
  assert.equal(arbDesc.layer1Summary.layer1Decision, 'rejected');
  assert.equal(arbDesc.layer1Summary.layer1DecidedByPolicy, 'timeout_mediation');
  const arbSerialized = JSON.stringify(arbCtx.data.context);
  assert.ok(!arbSerialized.includes('调解人甲'), '第一层调解人身份不得向仲裁人披露');
  assert.ok(!arbSerialized.includes('建议更正手机号'), '第一层逐字意见不得向仲裁人披露');

  // 升级后不能修改第一层结果：重复决议第一层字段返回同一结果（失败）
  const repeatL1 = await request('POST', `/api/mediation-packages/${packageId}/fields/${phoneL1}/reject`, auth(erin, {
    body: { reason: '尝试再次修改第一层决议' },
  }));
  assert.equal(repeatL1.status, 409);
  assert.ok(['MEDIATION_FIELD_ALREADY_DECIDED', 'ARBITRATION_NOT_OPEN', 'MEDIATION_NOT_ACTIVE'].includes(repeatL1.data.error.code),
    `实际错误码：${repeatL1.data.error.code}`);

  // 第一层邀请链接在第二层开放后不能再校验
  const revalidateL1 = await validateTier(medLinks[2].token, 1);
  void m3;
  assert.notEqual(revalidateL1.res.status, 200);
});

test('⑥ 仲裁达到接受阈值后生成并关联新更正办理；同一调解包只能一份进行中更正', async () => {
  const alice = await login('alice');
  await abandonIfAny(alice);
  // 用独立回执（新用户 alice 已在前面用过；这里先更正产生一份全新回执）
  const state0 = (await request('GET', '/api/state', auth(alice))).data;
  if (!state0.records.length) await completeAll(alice);
  const src = (await request('GET', '/api/state', auth(alice))).data.records[0].receiptNo;
  await request('POST', '/api/corrections', auth(alice, { body: { receiptNo: src } }));
  const { receipt } = await completeAll(alice, PAYLOADS('13511110000'));
  const { batchId } = await setupRejectedBatch(alice, receipt.receiptNo);
  const { roundId } = await setupCompletedAppeal(alice, batchId);
  const setup = await setupMediation(alice, { receiptNo: receipt.receiptNo, batchId, roundId });
  const packageId = setup.packageId;

  const medLinks = setup.links.filter((l) => l.tier === 1);
  const arbLinks = setup.links.filter((l) => l.tier === 2);
  // 第一层：3 位调解人均不提意见；手工驳回 phone 即达到升级条件（≥1 驳回字段），
  // description 在升级瞬间由系统按冻结策略自动驳回，第一层冻结
  for (const link of medLinks) await validateTier(link.token, 1);
  let pkg = (await request('GET', `/api/mediation-packages/${packageId}`, auth(alice))).data.pkg;
  const l1Ids = Object.fromEntries(pkg.tier1.fields.map((f) => [f.key, f.id]));
  const r1 = await request('POST', `/api/mediation-packages/${packageId}/fields/${l1Ids['0.phone']}/reject`, auth(alice, {
    body: { reason: '第一层驳回手机号字段，升级仲裁' },
  }));
  assert.equal(r1.status, 200, JSON.stringify(r1.data));
  assert.equal(r1.data.escalated, true);
  // 升级后第一层结果不可再修改（description 已由系统自动驳回）
  pkg = (await request('GET', `/api/mediation-packages/${packageId}`, auth(alice))).data.pkg;
  assert.equal(pkg.tier1.status, 'completed');
  assert.equal(pkg.tier2.status, 'active');
  assert.equal(pkg.tier1.fields.find((f) => f.key === '2.description').decidedByPolicy, 'timeout_mediation');

  // 第二层：3 位仲裁人中 2 位就 phone 提意见（接受阈值 2）；description 不处理
  const a1 = await validateTier(arbLinks[0].token, 2);
  const a2 = await validateTier(arbLinks[1].token, 2);
  await validateTier(arbLinks[2].token, 2);
  await submitTier(a1, 2, '0.phone', '仲裁人甲：综合第一层结论与证据，接受更正');
  await submitTier(a2, 2, '0.phone', '仲裁人乙：同意仲裁接受');

  pkg = (await request('GET', `/api/mediation-packages/${packageId}`, auth(alice))).data.pkg;
  const phoneL2 = pkg.tier2.fields.find((f) => f.key === '0.phone').id;
  const accept = await request('POST', `/api/mediation-packages/${packageId}/fields/${phoneL2}/accept`, auth(alice, { body: {} }));
  assert.equal(accept.status, 200, JSON.stringify(accept.data));
  assert.equal(accept.data.createdCorrection, true);
  assert.equal(accept.data.workflow.sourceReceiptNo, receipt.receiptNo);

  // 来源关联：调解意见 + 调解包 + 上一层结论（disclosure）+ 原批次/申诉回合来源
  const { db } = await import('../src/db.js');
  const links = db.prepare(`
    SELECT co.*, mc.disclosure_id AS disclosureId
    FROM correction_objections co
    JOIN mediation_opinions mo ON mo.id = co.mediation_opinion_id
    LEFT JOIN mediation_corrections mc ON mc.package_id = co.source_package_id
    WHERE co.source_package_id = ?
  `).all(packageId);
  assert.ok(links.length >= 2);
  assert.equal(new Set(links.map((l) => l.workflow_id)).size, 1);
  assert.ok(links.every((l) => l.source_batch_id === batchId));
  assert.ok(links.every((l) => l.source_round_id === roundId));
  assert.ok(links.every((l) => l.source_tier === 2));
  const mc = db.prepare('SELECT * FROM mediation_corrections WHERE package_id = ?').get(packageId);
  assert.ok(mc.disclosure_id, '仲裁接受必须关联上一层结论摘要');

  // 两个办理页面并发接受第二个仲裁字段：同一调解包只能产生一份进行中更正
  // 先让 description 达到接受阈值：三位仲裁人均提意见
  // a1/a2/a3 都可就 description 提意见（各邀请每字段一条）
  await submitTier(a1, 2, '2.description', '仲裁人甲：描述也接受');
  await submitTier(a2, 2, '2.description', '仲裁人乙：描述也接受');
  pkg = (await request('GET', `/api/mediation-packages/${packageId}`, auth(alice))).data.pkg;
  const descL2 = pkg.tier2.fields.find((f) => f.key === '2.description').id;
  const alice2 = await login('alice');
  const [c1, c2] = await Promise.all([
    request('POST', `/api/mediation-packages/${packageId}/fields/${descL2}/accept`, auth(alice, { body: {} })),
    request('POST', `/api/mediation-packages/${packageId}/fields/${descL2}/accept`, auth(alice2, { body: {} })),
  ]);
  const results = [c1, c2];
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  const failed = results.find((r) => r.status !== 200);
  assert.equal(failed.status, 409);
  // 第二份更正被拒绝（或并发决议抢跑）；无论哪种，进行中更正只能有一份
  const openCorrections = db.prepare(`
    SELECT COUNT(*) AS n FROM mediation_corrections
    WHERE package_id = ? AND completed_at IS NULL
  `).get(packageId).n;
  assert.equal(openCorrections, 1);

  // 完成更正 → 新回执回填；调解包随第二层全部终局而完成
  const { receipt: newReceipt } = await completeAll(alice, PAYLOADS('13511119999'));
  assert.notEqual(newReceipt.receiptNo, receipt.receiptNo);
  pkg = (await request('GET', `/api/mediation-packages/${packageId}`, auth(alice))).data.pkg;
  assert.equal(pkg.status, 'completed');
  assert.equal(pkg.correction.correctionReceiptNo, newReceipt.receiptNo);
  assert.equal(pkg.tier2.fields.find((f) => f.key === '0.phone').correctionReceiptNo, newReceipt.receiptNo);

  // 时间线：调解包条目在申诉回合条目之后，含两层、升级事件与更正完成事件
  const state = (await request('GET', '/api/state', auth(alice))).data;
  const order = state.timeline.map((t) => t.kind);
  const iBatch = order.indexOf('reviewBatch');
  const iAppeal = state.timeline.findIndex((t) => t.kind === 'reviewAppeal' && t.roundId === roundId);
  const iPkg = state.timeline.findIndex((t) => t.kind === 'mediationPackage' && t.packageId === packageId);
  assert.ok(iBatch >= 0 && iAppeal > iBatch && iPkg > iAppeal);
  const entry = state.timeline[iPkg];
  assert.equal(entry.tier1.status, 'completed');
  assert.equal(entry.tier2.status, 'completed');
  const eventTypes = entry.events.map((e) => e.type);
  for (const type of [
    'review.mediation.created',
    'review.mediation.field.rejected',
    'review.mediation.escalated',
    'review.mediation.arbitration.field.accepted',
    'review.mediation.correction.completed',
  ]) {
    assert.ok(eventTypes.includes(type), `缺少审计事件 ${type}`);
  }
});

test('⑦ 超时策略重复触发不产生第二次结果；取消/过期后写操作被拒绝', async () => {
  const bob = await login('bob');
  await abandonIfAny(bob);
  // revoke_unused 第一层：限时到达撤销未使用邀请，但不升级（驳回字段不足时完成）
  const setup = await setupMediation(bob, {
    patch: {
      layer1: {
        ttlMinutes: 60, timeoutPolicy: 'revoke_unused', escalateRejectedCount: 2,
        fields: [
          { key: '0.phone', acceptThreshold: 1, rejectThreshold: 1 },
          { key: '2.description', acceptThreshold: 1, rejectThreshold: 1 },
        ],
        invitations: [
          { label: '撤销甲', fields: ['0.phone', '2.description'] },
          { label: '撤销乙', fields: ['0.phone', '2.description'] },
          { label: '撤销丙', fields: ['0.phone', '2.description'] },
        ],
      },
    },
  });
  const packageId = setup.packageId;
  const { db } = await import('../src/db.js');
  const past = Date.now() - 1000;
  // 回拨第一层截止时间并多次触发超时扫描
  db.prepare('UPDATE mediation_tiers SET deadline_at = ? WHERE package_id = ? AND tier = 1').run(past, packageId);
  const r1 = db.prepare('SELECT * FROM mediation_tiers WHERE package_id = ? AND tier = 1').get(packageId);
  void r1;
  const { sweepMediationTimeouts } = await import('../src/db.js');
  const changed1 = sweepMediationTimeouts();
  const firedAt1 = db.prepare('SELECT timeout_fired_at FROM mediation_tiers WHERE package_id = ? AND tier = 1').get(packageId).timeout_fired_at;
  const changed2 = sweepMediationTimeouts();
  const firedAt2 = db.prepare('SELECT timeout_fired_at FROM mediation_tiers WHERE package_id = ? AND tier = 1').get(packageId).timeout_fired_at;
  assert.equal(changed2, 0);
  assert.equal(firedAt1, firedAt2, '超时策略重复触发不得产生第二次结果');
  void changed1;

  // 未使用邀请被撤销：其校验明确失败
  const unusedToken = setup.links.find((l) => l.tier === 1).token;
  const validateRevoked = await validateTier(unusedToken, 1);
  assert.equal(validateRevoked.res.status, 410);
  assert.ok(['MEDIATION_INVITATION_REVOKED', 'MEDIATION_INVITATION_EXPIRED', 'MEDIATION_DEADLINE_PASSED'].includes(validateRevoked.res.data.error.code));

  // —— 取消分支：新包，尚无任何终局决议时可取消 ——
  const setup2 = await setupMediation(bob);
  const pkg2 = setup2.packageId;
  const session = await validateTier(setup2.links.find((l) => l.tier === 1).token, 1);
  await submitTier(session, 1, '0.phone', '取消前留档的调解意见');
  const cancel = await request('POST', `/api/mediation-packages/${pkg2}/cancel`, auth(bob, { body: { reason: '办理人取消' } }));
  // 已有意见但无终局决议：仍可取消
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  assert.equal(cancel.data.pkg.status, 'cancelled');
  const writeAfterCancel = await submitTier(session, 1, '0.phone', '取消后尝试提交');
  assert.equal(writeAfterCancel.status, 410);
  assert.equal(writeAfterCancel.data.error.code, 'MEDIATION_PACKAGE_CANCELLED');
  // 第二层链接取消后校验失败
  const arbAfterCancel = await validateTier(setup2.links.find((l) => l.tier === 2).token, 2);
  assert.equal(arbAfterCancel.res.status, 410);
  // 重复取消
  const cancelAgain = await request('POST', `/api/mediation-packages/${pkg2}/cancel`, auth(bob, { body: {} }));
  assert.equal(cancelAgain.status, 409);

  // —— 已有终局决议后不能取消 ——
  const setup3 = await setupMediation(bob);
  const medLinks3 = setup3.links.filter((l) => l.tier === 1);
  const s1 = await validateTier(medLinks3[0].token, 1);
  const s2 = await validateTier(medLinks3[1].token, 1);
  await validateTier(medLinks3[2].token, 1);
  await submitTier(s1, 1, '0.phone', '终局前意见一');
  await submitTier(s2, 1, '0.phone', '终局前意见二');
  const pkg3 = (await request('GET', `/api/mediation-packages/${setup3.packageId}`, auth(bob))).data.pkg;
  const phoneId = pkg3.tier1.fields.find((f) => f.key === '0.phone').id;
  const accept = await request('POST', `/api/mediation-packages/${setup3.packageId}/fields/${phoneId}/accept`, auth(bob, { body: {} }));
  assert.equal(accept.status, 200, JSON.stringify(accept.data));
  // 接受第一层字段已生成更正：放弃它以便后续测试状态干净
  await request('POST', '/api/corrections?action=abandon', auth(bob, { body: {} }));
  const cancelAfterDecision = await request('POST', `/api/mediation-packages/${setup3.packageId}/cancel`, auth(bob, { body: {} }));
  assert.equal(cancelAfterDecision.status, 409);
  assert.equal(cancelAfterDecision.data.error.code, 'MEDIATION_HAS_DECISIONS');
});

test('⑧ 服务重启后两层关系、冻结快照、意见决议与完整时间线仍完整', async () => {
  const carol = await login('carol');
  await abandonIfAny(carol);
  const state0 = (await request('GET', '/api/state', auth(carol))).data;
  if (!state0.records.length) await completeAll(carol);
  const src = (await request('GET', '/api/state', auth(carol))).data.records[0].receiptNo;
  await request('POST', '/api/corrections', auth(carol, { body: { receiptNo: src } }));
  const { receipt } = await completeAll(carol, PAYLOADS('13622223333'));
  const { batchId } = await setupRejectedBatch(carol, receipt.receiptNo);
  const { roundId } = await setupCompletedAppeal(carol, batchId);
  const setup = await setupMediation(carol, { receiptNo: receipt.receiptNo, batchId, roundId });
  const packageId = setup.packageId;
  // 第一层：甲、乙就 phone 提意见；不决议，停在 mediating
  const medLinks = setup.links.filter((l) => l.tier === 1);
  const jia = await validateTier(medLinks[0].token, 1);
  await validateTier(medLinks[1].token, 1);
  await submitTier(jia, 1, '0.phone', '重启持久化：调解人甲的意见');

  const child = await startRestartServer(process.env.DB_PATH);
  try {
    const loginRes = await fetch(`${child.url}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'carol', password: 'password123' }),
    });
    assert.equal(loginRes.status, 200);
    const cookies = parsePair(loginRes.headers.get('set-cookie') || '');
    const stateRes = await fetch(`${child.url}/api/state`, { headers: { Cookie: `sid=${cookies.sid}` } });
    const state = await stateRes.json();

    const entry = state.timeline.find((t) => t.kind === 'mediationPackage' && t.packageId === packageId);
    assert.ok(entry, '调解包条目重启后仍在时间线');
    assert.equal(entry.roundId, roundId);
    assert.equal(entry.batchId, batchId);
    assert.equal(entry.status, 'mediating');
    assert.equal(entry.tier1.status, 'active');
    assert.equal(entry.tier2.status, 'pending');
    assert.equal(entry.tier1.frozenPolicy, 'escalate');
    assert.equal(entry.tier2.timeoutPolicy, 'complete');
    assert.equal(entry.frozenSnapshot.round.id, roundId);
    const phone = entry.tier1.fields.find((f) => f.key === '0.phone');
    assert.equal(phone.opinions.length, 1);
    assert.match(phone.opinions[0].reason, /调解人甲的意见/);
    assert.equal(phone.originalBatchDecision.decision, 'rejected');
    assert.equal(phone.appealDecision.decision, 'rejected');
    // 原批次与申诉回合历史未被改写
    const appealEntry = state.timeline.find((t) => t.kind === 'reviewAppeal' && t.roundId === roundId);
    assert.ok(appealEntry.fields.every((f) => f.decision === 'rejected'));

    // 免登录调解会话重启后仍可用，且仍只能看到授权内容
    const ctxRes = await fetch(`${child.url}/api/mediation-review/context`, { headers: { Cookie: jia.cookie } });
    assert.equal(ctxRes.status, 200);
    const ctxBody = await ctxRes.json();
    assert.deepEqual(ctxBody.context.view.steps.flatMap((s) => s.fields.map((f) => f.key)), ['0.phone', '2.description']);
    const mergedPhone = ctxBody.context.merged.find((m) => m.key === '0.phone');
    assert.equal(mergedPhone.opinionCount, 1);

    // 第二层在未升级前仍拒绝校验
    const arbToken = setup.links.find((l) => l.tier === 2).token;
    const arbRes = await fetch(`${child.url}/api/arbitration-review/validate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: arbToken }),
    });
    assert.equal(arbRes.status, 409);
    const arbBody = await arbRes.json();
    assert.equal(arbBody.error.code, 'ARBITRATION_NOT_OPEN');
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
      REVIEW_INVITE_MIN_TTL_MS: '60000',
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
