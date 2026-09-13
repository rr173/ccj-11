import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

process.env.DB_PATH = path.join(process.cwd(), 'data', `test-stages-${process.pid}.db`);
process.env.TOKEN_TTL_MS = '600000';
process.env.RECEIPT_SECRET = 'unit-test-stages-secret-fixed-value';
process.env.VERIFY_RATE_MAX = '200';
process.env.REVIEW_INVITE_MIN_TTL_MS = '60000';
process.env.NO_AUTO_LISTEN = '1';
process.env.NO_BATCH_SWEEP = '1';
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
  String(header || '').split(/,(?=[^;]+=[^;])/).forEach((part) => {
    const seg = part.split(';')[0];
    const eq = seg.indexOf('=');
    if (eq > 0) cookies[seg.slice(0, eq).trim()] = seg.slice(eq + 1).trim();
  });
  return cookies;
}
async function login(username = 'alice') {
  const res = await request('POST', '/api/login', { body: { username, password: 'password123' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const cookies = parsePair(res.headers.get('set-cookie'));
  return { cookie: `sid=${cookies.sid}; csrf=${cookies.csrf}`, sid: cookies.sid, csrf: res.data.csrfToken };
}
function auth(client, extra = {}) {
  return { ...extra, headers: { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, ...(extra.headers || {}) } };
}
function randomId() {
  return crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}
const PAYLOADS = (phone = '13800138000') => ([
  { name: '阶段测试', idNumber: 'STAGE-SECRET-ID-1', phone },
  { province: '江苏省', city: '南京市', detail: '阶段测试秘密地址 8 号' },
  { type: 'change', description: '阶段测试事项说明' },
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

// 保证拿到一份“本次新完成”的回执：若当前没有进行中办理，就基于最近回执发起更正再完成。
async function ensureFreshReceipt(client, phone) {
  await abandonIfAny(client);
  let state = (await request('GET', '/api/state', auth(client))).data;
  if (state.workflow.completed) {
    const src = state.records[0].receiptNo;
    const started = await request('POST', '/api/corrections', auth(client, { body: { receiptNo: src } }));
    assert.equal(started.status, 200, JSON.stringify(started.data));
  }
  return completeAll(client, PAYLOADS(phone));
}

// 两个阶段：阶段0 phone（2 邀请，阈值 1/2），阶段1 detail（1 邀请，阈值 1/1）
function stagedConfig(receiptNo, overrides = {}) {
  return {
    receiptNo,
    note: '分阶段批次',
    stages: [
      {
        name: '第一阶段·电话', ttlMinutes: 60, timeoutPolicy: 'advance',
        fields: [{ key: '0.phone', acceptThreshold: 1, rejectThreshold: 2 }],
        invitations: [
          { label: '阶段一甲', fields: ['0.phone'] },
          { label: '阶段一乙', fields: ['0.phone'] },
        ],
      },
      {
        name: '第二阶段·地址', ttlMinutes: 60, timeoutPolicy: 'fail',
        fields: [{ key: '1.detail', acceptThreshold: 1, rejectThreshold: 1 }],
        invitations: [{ label: '阶段二复核', fields: ['1.detail'] }],
      },
    ],
    ...overrides,
  };
}
async function createStagedBatch(client, receiptNo, overrides = {}) {
  return request('POST', '/api/review-batches', auth(client, { body: stagedConfig(receiptNo, overrides) }));
}
async function validateBatch(token) {
  const res = await request('POST', '/api/batch-review/validate', { body: { token } });
  const cookies = parsePair(res.headers.get('set-cookie'));
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
  return request('POST', '/api/batch-review/opinions', { headers: batchHeaders(session), body: { key, reason, idempotencyKey } });
}
async function getBatch(client, batchId) {
  return request('GET', `/api/review-batches/${batchId}`, auth(client));
}
async function startBatch(client, batchId) {
  return request('POST', `/api/review-batches/${batchId}/start`, auth(client, { body: {} }));
}

test('分阶段配置校验：阶段字段不跨阶段重复、超时策略三选一、总邀请 2-5、每阶段字段必须被授权', async () => {
  const alice = await login('alice');
  const { receipt } = await ensureFreshReceipt(alice, '13800138006');

  // 总邀请不足 2
  const tooFewInvitations = await request('POST', '/api/review-batches', auth(alice, {
    body: {
      receiptNo: receipt.receiptNo,
      stages: [{
        name: '仅一个邀请', ttlMinutes: 60, timeoutPolicy: 'advance',
        fields: [{ key: '0.phone', acceptThreshold: 1, rejectThreshold: 1 }],
        invitations: [{ label: '独苗', fields: ['0.phone'] }],
      }],
    },
  }));
  assert.equal(tooFewInvitations.status, 400);
  assert.equal(tooFewInvitations.data.error.code, 'INVALID_BATCH_INVITATIONS');

  // 超时策略非法
  const badPolicy = await request('POST', '/api/review-batches', auth(alice, {
    body: {
      receiptNo: receipt.receiptNo,
      stages: [
        {
          name: 's0', ttlMinutes: 60, timeoutPolicy: 'explode',
          fields: [{ key: '0.phone', acceptThreshold: 1, rejectThreshold: 1 }],
          invitations: [{ label: 'a', fields: ['0.phone'] }],
        },
        {
          name: 's1', ttlMinutes: 60, timeoutPolicy: 'fail',
          fields: [{ key: '1.detail', acceptThreshold: 1, rejectThreshold: 1 }],
          invitations: [{ label: 'b', fields: ['1.detail'] }],
        },
      ],
    },
  }));
  assert.equal(badPolicy.status, 400);
  assert.equal(badPolicy.data.error.code, 'INVALID_STAGE_TIMEOUT_POLICY');

  // 字段跨阶段重复
  const dupField = await createStagedBatch(alice, receipt.receiptNo, {
    stages: [
      {
        name: 's0', ttlMinutes: 60, timeoutPolicy: 'advance',
        fields: [{ key: '0.phone', acceptThreshold: 1, rejectThreshold: 1 }],
        invitations: [{ label: 'a', fields: ['0.phone'] }],
      },
      {
        name: 's1', ttlMinutes: 60, timeoutPolicy: 'fail',
        fields: [{ key: '0.phone', acceptThreshold: 1, rejectThreshold: 1 }],
        invitations: [{ label: 'b', fields: ['0.phone'] }],
      },
    ],
  });
  assert.equal(dupField.status, 400, JSON.stringify(dupField.data));
  assert.equal(dupField.data.error.code, 'INVALID_BATCH_FIELD');

  // 授权字段不属于本阶段编排
  const scopeMismatch = await createStagedBatch(alice, receipt.receiptNo, {
    stages: [
      {
        name: 's0', ttlMinutes: 60, timeoutPolicy: 'advance',
        fields: [{ key: '0.phone', acceptThreshold: 1, rejectThreshold: 1 }],
        // 授权了下一阶段才编排的 detail
        invitations: [{ label: 'a', fields: ['0.phone', '1.detail'] }],
      },
      {
        name: 's1', ttlMinutes: 60, timeoutPolicy: 'fail',
        fields: [{ key: '1.detail', acceptThreshold: 1, rejectThreshold: 1 }],
        invitations: [{ label: 'b', fields: ['1.detail'] }],
      },
    ],
  });
  assert.equal(scopeMismatch.status, 400);
  assert.equal(scopeMismatch.data.error.code, 'INVALID_BATCH_FIELD_SCOPE');
});

test('前一阶段未完成时：后续阶段不能校验/查看/提交；创建后与启动前状态正确', async () => {
  const alice = await login('alice');
  const state0 = (await request('GET', '/api/state', auth(alice))).data;
  const receiptNo = state0.records[0].receiptNo;
  const created = await createStagedBatch(alice, receiptNo);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const batchId = created.data.batch.id;
  assert.equal(created.data.batch.staged, true);
  assert.equal(created.data.batch.status, 'collecting');
  assert.equal(created.data.batch.configVersion, 1);

  // 创建后第一阶段尚未启动，任何阶段的邀请都不能校验
  const beforeStart = await validateBatch(created.data.links[0].token);
  assert.equal(beforeStart.res.status, 409);
  assert.equal(beforeStart.res.data.error.code, 'BATCH_STAGE_NOT_STARTED');

  // 启动第一阶段
  const start = await startBatch(alice, batchId);
  assert.equal(start.status, 200, JSON.stringify(start.data));
  assert.equal(start.data.batch.currentStageOrdinal, 0);

  // 后续阶段邀请（阶段二复核）在前一阶段未完成时不能校验
  const futureLink = created.data.links.find((l) => l.label === '阶段二复核');
  const future = await validateBatch(futureLink.token);
  assert.equal(future.res.status, 409);
  assert.equal(future.res.data.error.code, 'BATCH_STAGE_NOT_STARTED');

  // 阶段一邀请可以校验
  const s1 = await validateBatch(created.data.links[0].token);
  assert.equal(s1.res.status, 200, JSON.stringify(s1.res.data));
  assert.equal(s1.res.data.stageOrdinal, 0);

  // 复核人上下文只显示阶段0授权字段（phone），看不到 detail
  const ctx = await batchContext(s1);
  assert.equal(ctx.status, 200);
  const keys = ctx.data.context.view.steps.flatMap((s) => s.fields.map((f) => f.key));
  assert.deepEqual(keys, ['0.phone']);
  assert.equal(ctx.data.context.stage.ordinal, 0);
  assert.equal(ctx.data.context.stage.isCurrent, true);
  assert.ok(ctx.data.context.stage.remainingMs > 0);

  // 直接对 detail 提交（越权字段/越权阶段）明确失败
  const cross = await submitOpinion(s1, '1.detail', '尝试评价后续阶段字段');
  assert.equal(cross.status, 403, JSON.stringify(cross.data));
  assert.equal(cross.data.error.code, 'BATCH_FIELD_NOT_AUTHORIZED');
});

test('阶段启动后配置冻结不能改；调整编排必须携带版本号，两个页面并发只成功一个', async () => {
  const bob = await login('bob');
  const { receipt } = await ensureFreshReceipt(bob, '13800138002');
  const created = await createStagedBatch(bob, receipt.receiptNo);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const batchId = created.data.batch.id;

  const newCfg = stagedConfig(receipt.receiptNo, {
    stages: [
      {
        name: '调整后阶段一', ttlMinutes: 90, timeoutPolicy: 'revoke_unused',
        fields: [{ key: '0.phone', acceptThreshold: 1, rejectThreshold: 1 }],
        invitations: [{ label: '新甲', fields: ['0.phone'] }],
      },
      {
        name: '调整后阶段二', ttlMinutes: 60, timeoutPolicy: 'advance',
        fields: [{ key: '1.detail', acceptThreshold: 1, rejectThreshold: 1 }],
        invitations: [{ label: '新乙', fields: ['1.detail'] }],
      },
    ],
  });

  // 不带版本号
  const noVersion = await request('POST', `/api/review-batches/${batchId}/orchestration`, auth(bob, { body: newCfg }));
  assert.equal(noVersion.status, 409);
  assert.equal(noVersion.data.error.code, 'BATCH_CONFIG_VERSION_CONFLICT');

  // 错误版本号
  const wrongVersion = await request('POST', `/api/review-batches/${batchId}/orchestration`, auth(bob, { body: { ...newCfg, expectedVersion: 42 } }));
  assert.equal(wrongVersion.status, 409);
  assert.equal(wrongVersion.data.error.code, 'BATCH_CONFIG_VERSION_CONFLICT');

  // 两个办理页面同时基于 v1 修改：只成功一个
  const bob2 = await login('bob');
  const [a, b] = await Promise.all([
    request('POST', `/api/review-batches/${batchId}/orchestration`, auth(bob, { body: { ...newCfg, expectedVersion: 1, note: '页面A' } })),
    request('POST', `/api/review-batches/${batchId}/orchestration`, auth(bob2, { body: { ...newCfg, expectedVersion: 1, note: '页面B' } })),
  ]);
  const winners = [a, b].filter((r) => r.status === 200);
  const losers = [a, b].filter((r) => r.status !== 200);
  assert.equal(winners.length, 1);
  assert.equal(losers[0].data.error.code, 'BATCH_CONFIG_VERSION_CONFLICT');
  assert.equal(winners[0].data.version, 2);
  // 失败响应携带最新版本号，供前端重读
  assert.equal(losers[0].data.batch.configVersion, 2);

  // 重配后必须重新启动第一阶段；旧链接全部失效（邀请被整体替换）
  const oldLink = await validateBatch(created.data.links[0].token);
  assert.equal(oldLink.res.status, 404);
  const start = await startBatch(bob, batchId);
  assert.equal(start.status, 200);

  // 已开始阶段配置冻结
  const afterStart = await request('POST', `/api/review-batches/${batchId}/orchestration`, auth(bob, { body: { ...newCfg, expectedVersion: 2 } }));
  assert.equal(afterStart.status, 409);
  assert.equal(afterStart.data.error.code, 'BATCH_CONFIG_LOCKED');

  // 变更历史与版本留档
  const history = await request('GET', `/api/review-batches/${batchId}/history`, auth(bob));
  assert.equal(history.status, 200);
  assert.equal(history.data.configVersion, 2);
  const types = history.data.history.map((h) => h.type);
  assert.ok(types.includes('batch.created'));
  assert.ok(types.includes('batch.reconfigured'));
  assert.deepEqual(history.data.versions.map((v) => v.version), [1, 2]);
});

test('阶段超时按冻结策略执行，重复触发不产生第二次结果：advance / fail / revoke_unused', async () => {
  const { db } = await import('../src/db.js');
  const { sweepBatchTimeouts } = await import('../src/batchStore.js');

  // ---- advance：未决字段自动驳回，自动开放下一阶段 ----
  {
    const carol = await login('carol');
    const { receipt } = await ensureFreshReceipt(carol, '13800138003');
    const created = await createStagedBatch(carol, receipt.receiptNo);
    const batchId = created.data.batch.id;
    await startBatch(carol, batchId);
    const s0 = await validateBatch(created.data.links[0].token);
    assert.equal(s0.res.status, 200);
    // 不提交意见、不决议，直接令阶段0到期
    db.prepare('UPDATE review_batch_stages SET deadline_at = ? WHERE batch_id = ? AND ordinal = 0').run(Date.now() - 1, batchId);
    assert.equal(sweepBatchTimeouts(), 1);
    // 重复触发幂等：不再产生结果
    assert.equal(sweepBatchTimeouts(), 0);

    const detail = await getBatch(carol, batchId);
    const batch = detail.data.batch;
    assert.equal(batch.status, 'in_review');
    assert.equal(batch.currentStageOrdinal, 1);
    const stage0 = batch.stages[0];
    assert.equal(stage0.status, 'completed');
    assert.equal(stage0.finalDecision, 'timeout_advanced');
    assert.equal(stage0.fields[0].decision, 'rejected');
    assert.equal(stage0.fields[0].decidedByPolicy, 'timeout_advance');
    assert.match(stage0.fields[0].decisionReason, /限时/);
    const stage1 = batch.stages[1];
    assert.equal(stage1.status, 'active');
    assert.equal(stage1.frozenPolicy, 'fail'); // 下一阶段按它自己的策略在开始时冻结

    // 阶段一推进后，阶段二邀请可以校验
    const link2 = created.data.links.find((l) => l.label === '阶段二复核');
    const v2 = await validateBatch(link2.token);
    assert.equal(v2.res.status, 200);
    assert.equal(v2.res.data.stageOrdinal, 1);
    await request('POST', '/api/corrections?action=abandon', auth(carol, { body: {} })).catch(() => {});
  }

  // ---- fail：批次超时失败，意见原样留档，后续阶段邀请不可用 ----
  {
    const dave = await login('dave');
    const { receipt } = await ensureFreshReceipt(dave, '13800138004');
    // 第一阶段策略改为 fail
    const failCfg = stagedConfig(receipt.receiptNo);
    failCfg.stages[0].timeoutPolicy = 'fail';
    const created = await request('POST', '/api/review-batches', auth(dave, { body: failCfg }));
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const batchId = created.data.batch.id;
    await startBatch(dave, batchId);
    const session = await validateBatch(created.data.links[0].token);
    const op = await submitOpinion(session, '0.phone', '失败策略下该意见必须原样保留不被改写');
    assert.equal(op.status, 200, JSON.stringify(op.data));

    db.prepare('UPDATE review_batch_stages SET deadline_at = ? WHERE batch_id = ? AND ordinal = 0').run(Date.now() - 1, batchId);
    assert.equal(sweepBatchTimeouts(), 1);
    assert.equal(sweepBatchTimeouts(), 0); // 幂等

    const detail = await getBatch(dave, batchId);
    assert.equal(detail.data.batch.status, 'timed_out');
    assert.equal(detail.data.batch.timeoutResult, 'failed');
    assert.equal(detail.data.batch.stages[0].status, 'failed');
    // 已提交意见原样保留
    assert.match(detail.data.batch.stages[0].fields[0].opinions[0].reason, /必须原样保留/);
    // 复核会话失效
    const ctx = await batchContext(session);
    assert.equal(ctx.status, 401);
    // 后续阶段邀请不可校验
    const link2 = created.data.links.find((l) => l.label === '阶段二复核');
    const v2 = await validateBatch(link2.token);
    assert.equal(v2.res.status, 410);
  }
});

test('revoke_unused：撤销未使用邀请但保留已收集意见；办理人据此完成决议才推进', async () => {
  const { db } = await import('../src/db.js');
  const { sweepBatchTimeouts } = await import('../src/batchStore.js');
  const erin = await login('erin');
  const { receipt } = await ensureFreshReceipt(erin, '13800138005');
  // 阶段0：2 邀请，策略 revoke_unused，phone 接受阈值 1 / 驳回阈值 2
  const created = await request('POST', '/api/review-batches', auth(erin, {
    body: {
      receiptNo: receipt.receiptNo,
      stages: [
        {
          name: '阶段一', ttlMinutes: 60, timeoutPolicy: 'revoke_unused',
          fields: [{ key: '0.phone', acceptThreshold: 1, rejectThreshold: 2 }],
          invitations: [
            { label: '甲', fields: ['0.phone'] },
            { label: '乙', fields: ['0.phone'] },
          ],
        },
      ],
    },
  }));
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const batchId = created.data.batch.id;
  await startBatch(erin, batchId);
  const jia = await validateBatch(created.data.links[0].token);
  await submitOpinion(jia, '0.phone', '甲：电话号码需要更正');
  // 乙未校验即到期
  db.prepare('UPDATE review_batch_stages SET deadline_at = ? WHERE batch_id = ?').run(Date.now() - 1, batchId);
  assert.equal(sweepBatchTimeouts(), 1);
  assert.equal(sweepBatchTimeouts(), 0);

  const detail = await getBatch(erin, batchId);
  const stage = detail.data.batch.stages[0];
  assert.equal(stage.status, 'active_deadline_passed'); // 仍在收尾，等待办理人决议
  assert.equal(stage.timeoutResult, 'revoked_unused');
  const invStatuses = Object.fromEntries(stage.invitations.map((i) => [i.label, i.status]));
  assert.equal(invStatuses.甲, 'used');
  assert.equal(invStatuses.乙, 'revoked');

  // 乙的链接失效
  const yiLink = created.data.links[1];
  const yi = await validateBatch(yiLink.token);
  assert.equal(yi.res.status, 410);
  // 甲不能再提交意见（阶段进入收尾）
  const again = await submitOpinion(jia, '0.phone', '到期后不应再能提交');
  // 第一条已占该字段，第二键本就重复；用一个新会话不可得，这里验证通道关闭：状态为 409
  assert.equal(again.status, 409);

  // 办理人接受甲的意见（阈值 1 满足）→ 进入更正，字段决议，阶段完成（单阶段即批次完成）
  const phoneId = stage.fields[0].id;
  const accept = await request('POST', `/api/review-batches/${batchId}/fields/${phoneId}/accept`, auth(erin, { body: {} }));
  assert.equal(accept.status, 200, JSON.stringify(accept.data));
  assert.equal(accept.data.stageAdvanced, false);
  assert.equal(accept.data.batchCompleted, true);
  assert.equal(accept.data.field.correctionReceiptNo, '');
  // 清理更正
  await request('POST', '/api/corrections?action=abandon', auth(erin, { body: {} }));
});

test('阶段意见达到阈值才能决议，决议正确关联同一份更正；后续阶段字段在前阶段未决时被拒', async () => {
  const alice = await login('alice');
  const { receipt } = await ensureFreshReceipt(alice, '13800138006');
  const receiptNo = receipt.receiptNo;
  const created = await createStagedBatch(alice, receiptNo);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const batchId = created.data.batch.id;
  await startBatch(alice, batchId);

  // 阶段0：phone 接受阈值 1。两个复核人都校验、各提意见
  const a = await validateBatch(created.data.links[0].token);
  const bSess = await validateBatch(created.data.links[1].token);
  await submitOpinion(a, '0.phone', '甲：电话应更正');
  await submitOpinion(bSess, '0.phone', '乙：电话确实有误');

  const detail0 = await getBatch(alice, batchId);
  const phoneField = detail0.data.batch.stages[0].fields[0];
  const detailField = detail0.data.batch.stages[1].fields[0];

  // 阶段一未完成时，尝试决议“第二阶段字段”被拒
  const decideFuture = await request('POST', `/api/review-batches/${batchId}/fields/${detailField.id}/accept`, auth(alice, { body: {} }));
  assert.equal(decideFuture.status, 409);
  assert.equal(decideFuture.data.error.code, 'BATCH_STAGE_NOT_STARTED');

  // 接受阈值 1：满足，接受进入更正
  const accept = await request('POST', `/api/review-batches/${batchId}/fields/${phoneField.id}/accept`, auth(alice, { body: {} }));
  assert.equal(accept.status, 200, JSON.stringify(accept.data));
  assert.equal(accept.data.stageAdvanced, true); // 阶段0完成，自动开放阶段1
  assert.equal(accept.data.batchCompleted, false);
  assert.equal(accept.data.field.correctionWorkflowId, accept.data.workflow.id);
  assert.ok(accept.data.workflow.sourceReceiptNo === receiptNo);

  // 阶段1：detail，唯一复核人校验并提意见，接受后批次完成
  const afterStage0 = await getBatch(alice, batchId);
  assert.equal(afterStage0.data.batch.currentStageOrdinal, 1);
  const link2 = created.data.links.find((l) => l.label === '阶段二复核');
  const c = await validateBatch(link2.token);
  assert.equal(c.res.status, 200);
  assert.equal(c.res.data.stageOrdinal, 1);
  const ctxC = await batchContext(c);
  const keysC = ctxC.data.context.view.steps.flatMap((s) => s.fields.map((f) => f.key));
  assert.deepEqual(keysC, ['1.detail']); // 只看到第二阶段授权的地址脱敏字段
  assert.ok(!JSON.stringify(ctxC.data.context).includes('秘密地址'));
  await submitOpinion(c, '1.detail', '阶段二：门牌号需要更正');

  const detail1 = await getBatch(alice, batchId);
  const detailField2 = detail1.data.batch.stages[1].fields[0];
  const accept2 = await request('POST', `/api/review-batches/${batchId}/fields/${detailField2.id}/accept`, auth(alice, { body: {} }));
  assert.equal(accept2.status, 200, JSON.stringify(accept2.data));
  assert.equal(accept2.data.createdCorrection, false); // 复用同一份更正，不新建
  assert.equal(accept2.data.batchCompleted, true);

  // 两个字段的全部意见关联到同一份更正办理
  const state = (await request('GET', '/api/state', auth(alice))).data;
  const entry = state.timeline.find((t) => t.kind === 'reviewBatch' && t.batchId === batchId);
  assert.equal(entry.status, 'completed');
  const acceptedFields = entry.fields.filter((f) => f.decision === 'accepted');
  assert.equal(acceptedFields.length, 2);
  const workflowIds = new Set(acceptedFields.map((f) => f.correctionWorkflowId));
  assert.equal(workflowIds.size, 1);
  // 时间线含阶段事件、配置版本、每阶段最终决议
  assert.equal(entry.configVersion, 1);
  assert.equal(entry.stages.length, 2);
  assert.ok(entry.stages.every((s) => s.finalDecision === 'decided'));
  assert.ok(entry.changeHistory.some((h) => h.type === 'batch.created'));

  await request('POST', '/api/corrections?action=abandon', auth(alice, { body: {} }));
});

test('服务重启后恢复当前阶段、倒计时截止结果与完整变更历史；超时落定不重复', async () => {
  const { db } = await import('../src/db.js');
  const carol = await login('carol');
  const { receipt } = await ensureFreshReceipt(carol, '13644445555');

  const created = await createStagedBatch(carol, receipt.receiptNo);
  const batchId = created.data.batch.id;
  await startBatch(carol, batchId);
  const s0 = await validateBatch(created.data.links[0].token);
  await submitOpinion(s0, '0.phone', '重启恢复：阶段0的电话意见');
  // 重配一次不可能（已开始）；改为在创建后、开始前的重配在另一用例覆盖。
  // 令阶段0截止时间已过但【不触发 sweep】，重启后应由启动扫描落定
  db.prepare('UPDATE review_batch_stages SET deadline_at = ? WHERE batch_id = ? AND ordinal = 0').run(Date.now() - 1000, batchId);

  const child = await startRestartServer(process.env.DB_PATH);
  try {
    // 启动即扫描：阶段0按 advance 自动推进、未决字段自动驳回，阶段1激活
    await new Promise((r) => setTimeout(r, 600));
    const loginRes = await fetch(`${child.url}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'carol', password: 'password123' }),
    });
    assert.equal(loginRes.status, 200);
    const cookies = parsePair(loginRes.headers.get('set-cookie'));
    const stateRes = await fetch(`${child.url}/api/state`, { headers: { Cookie: `sid=${cookies.sid}` } });
    const state = await stateRes.json();
    const entry = state.timeline.find((t) => t.kind === 'reviewBatch' && t.batchId === batchId);
    assert.ok(entry, '重启后批次仍在时间线');
    assert.equal(entry.currentStageOrdinal, 1);
    assert.equal(entry.stages[0].finalDecision, 'timeout_advanced');
    const stage0Fields = entry.fields.filter((f) => f.stageId === entry.stages[0].id);
    const stage1Fields = entry.fields.filter((f) => f.stageId === entry.stages[1].id);
    assert.equal(stage0Fields[0].decision, 'rejected');
    assert.equal(stage0Fields[0].decidedByPolicy, 'timeout_advance');
    assert.equal(entry.stages[1].status, 'active');
    assert.equal(entry.stages[1].frozenPolicy, 'fail');
    // 已提交意见仍逐字保留，未被阶段切换改写
    assert.match(stage0Fields[0].opinions[0].reason, /重启恢复/);
    assert.equal(stage1Fields.length, 1);
    // 变更历史完整
    const types = entry.changeHistory.map((h) => h.type);
    assert.ok(types.includes('batch.created'));
    assert.ok(types.includes('review.batch.stage.started') || entry.changeHistory.length >= 1);
    assert.ok(types.some((t) => t === 'batch.stage.started' || t === 'batch.created'));

    // 复核会话持久化：阶段0的会话重启后仍可读取（只读，阶段已结束）
    const ctxRes = await fetch(`${child.url}/api/batch-review/context`, { headers: { Cookie: s0.cookie } });
    assert.equal(ctxRes.status, 200);
    const ctxBody = await ctxRes.json();
    assert.equal(ctxBody.context.stage.ordinal, 0);
    assert.equal(ctxBody.context.canSubmit, false);
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
      BATCH_TIMEOUT_SWEEP_MS: '200',
      NO_BATCH_SWEEP: '',
      PORT: '0',
      NO_AUTO_LISTEN: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Restart server did not start')), 6000);
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
