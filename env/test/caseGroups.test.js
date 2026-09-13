import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

process.env.DB_PATH = path.join(process.cwd(), 'data', `test-casegroup-${process.pid}.db`);
process.env.TOKEN_TTL_MS = '600000';
process.env.RECEIPT_SECRET = 'unit-test-casegroup-secret-fixed-value';
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

const PAYLOADS = (phone = '13800138000', secret = 'CASEGROUP-SECRET-ID-001') => ([
  { name: '案件组测试', idNumber: secret, phone },
  { province: '浙江省', city: '杭州市', detail: '案件组秘密地址 99 号' },
  { type: 'change', description: '案件组测试事项说明' },
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

// 原批次：phone 与 description 均驳回
async function setupRejectedBatch(client, receiptNo) {
  const created = await request('POST', '/api/review-batches', auth(client, {
    body: {
      receiptNo,
      ttlMinutes: 60,
      note: '案件组前置批次',
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

async function validateAppeal(token) {
  const res = await request('POST', '/api/appeal-review/validate', { body: { token } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const cookies = parsePair(res.headers.get('set-cookie') || '');
  return { cookie: `aid=${cookies.aid || ''}; accsrf=${cookies.accsrf || ''}`, csrf: res.data?.csrfToken || '' };
}

// 创建一个【已完成】申诉回合：仅申诉指定字段，邀请数 inviteCount，均不提意见 → 办理人驳回
async function setupCompletedAppeal(client, batchId, fieldKey, { inviteCount = 2, reasonText = '申诉意见证据不足，维持申诉驳回决议' } = {}) {
  const labels = Array.from({ length: inviteCount }, (_, i) => `申诉${fieldKey.replace('.', '_')}_${i + 1}`);
  const created = await request('POST', '/api/review-appeals', auth(client, {
    body: {
      batchId,
      ttlMinutes: 60,
      note: `案件组前置申诉回合 ${fieldKey}`,
      fields: [
        { key: fieldKey, reason: 'misjudged', acceptThreshold: 1, rejectThreshold: inviteCount, evidenceOpinionIds: [] },
      ],
      invitations: labels.map((label) => ({ label, fields: [fieldKey] })),
    },
  }));
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const roundId = created.data.round.id;
  for (const link of created.data.links) await validateAppeal(link.token);
  const round = (await request('GET', `/api/review-appeals/${roundId}`, auth(client))).data.round;
  for (const field of round.fields) {
    const r = await request('POST', `/api/review-appeals/${roundId}/fields/${field.id}/reject`, auth(client, {
      body: { reason: reasonText },
    }));
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const after = (await request('GET', `/api/review-appeals/${roundId}`, auth(client))).data.round;
  assert.equal(after.status, 'completed');
  return { roundId };
}

// 单字段调解包：第一层 N 名调解人，第二层 3 名仲裁人；升级条件 1
function mediationBodySingleField(roundId, fieldKey, { layer1Count = 3, layer2Count = 3 } = {}) {
  const l1Labels = Array.from({ length: layer1Count }, (_, i) => `调解${fieldKey.split('.')[1]}${i + 1}`);
  const l2Labels = Array.from({ length: layer2Count }, (_, i) => `仲裁${fieldKey.split('.')[1]}${i + 1}`);
  return {
    roundId,
    note: `案件组成员包 ${fieldKey}`,
    fields: [{ key: fieldKey, evidenceOpinionIds: [] }],
    layer1: {
      ttlMinutes: 60,
      timeoutPolicy: 'escalate',
      escalateRejectedCount: 1,
      fields: [{ key: fieldKey, acceptThreshold: 2, rejectThreshold: 2 }],
      invitations: l1Labels.map((label) => ({ label, fields: [fieldKey] })),
    },
    layer2: {
      ttlMinutes: 60,
      timeoutPolicy: 'complete',
      fields: [{ key: fieldKey, acceptThreshold: 2, rejectThreshold: 2 }],
      invitations: l2Labels.map((label) => ({ label, fields: [fieldKey] })),
    },
  };
}

async function createMediationSingle(client, roundId, fieldKey, opts = {}) {
  const res = await request('POST', '/api/mediation-packages', auth(client, {
    body: mediationBodySingleField(roundId, fieldKey, opts),
  }));
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
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
async function tierContext(session, tier) {
  const pathName = tier === 2 ? 'arbitration-review' : 'mediation-review';
  return request('GET', `/api/${pathName}/context`, { headers: { Cookie: session.cookie } });
}
async function submitTier(session, tier, key, reason) {
  const pathName = tier === 2 ? 'arbitration-review' : 'mediation-review';
  return request('POST', `/api/${pathName}/opinions`, {
    headers: { Cookie: session.cookie, 'X-CSRF-Token': session.csrf },
    body: { key, reason, idempotencyKey: randomId() },
  });
}

// 让一个成员包的第一层【手工驳回唯一字段】达到升级条件（3 位调解人均不提意见）
async function rejectPackageLayer1(client, created, packageId) {
  const medLinks = created.links.filter((l) => l.tier === 1);
  for (const link of medLinks) await validateTier(link.token, 1);
  const pkg = (await request('GET', `/api/mediation-packages/${packageId}`, auth(client))).data.pkg;
  const fieldId = pkg.tier1.fields[0].id;
  return request('POST', `/api/mediation-packages/${packageId}/fields/${fieldId}/reject`, auth(client, {
    body: { reason: '第一层三位调解人均未支持，手工驳回' },
  }));
}

async function getGroup(client, groupId) {
  return request('GET', `/api/case-groups/${groupId}`, auth(client));
}

// 准备同一原批次下两个已完成申诉回合（phone / description）与各自的调解包
async function setupTwoPackages(client, overrides = {}) {
  await abandonIfAny(client);
  const { receipt } = await completeAll(client);
  const { batchId } = await setupRejectedBatch(client, receipt.receiptNo);
  const appealPhone = await setupCompletedAppeal(client, batchId, '0.phone', { inviteCount: 2 });
  const pkgPhone = await createMediationSingle(client, appealPhone.roundId, '0.phone', overrides.phone || {});
  const appealDesc = await setupCompletedAppeal(client, batchId, '2.description', { inviteCount: 2 });
  const pkgDesc = await createMediationSingle(client, appealDesc.roundId, '2.description', overrides.desc || {});
  return {
    receiptNo: receipt.receiptNo,
    batchId,
    phone: { roundId: appealPhone.roundId, packageId: pkgPhone.pkg.id, created: pkgPhone },
    desc: { roundId: appealDesc.roundId, packageId: pkgDesc.pkg.id, created: pkgDesc },
  };
}

async function createGroupWith(client, anchorPackageId, note = '测试案件组') {
  return request('POST', '/api/case-groups', auth(client, { body: { anchorPackageId, note } }));
}

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

// ---------------------------------------------------------------------------
// ① 冲突成员包被拒绝加入（批次/字段/来源/更正/状态五类冲突留档）
// ---------------------------------------------------------------------------
test('① 未通过冲突检查的调解包不能进入案件组，拒绝原因留档', async () => {
  const alice = await login('alice');
  await abandonIfAny(alice);
  const { receipt } = await completeAll(alice);
  const { batchId } = await setupRejectedBatch(alice, receipt.receiptNo);
  const appealPhone = await setupCompletedAppeal(alice, batchId, '0.phone', { inviteCount: 2 });
  const pkgPhone = await createMediationSingle(alice, appealPhone.roundId, '0.phone');
  const appealDesc = await setupCompletedAppeal(alice, batchId, '2.description', { inviteCount: 2 });
  const pkgDesc = await createMediationSingle(alice, appealDesc.roundId, '2.description');

  const created = await createGroupWith(alice, pkgPhone.pkg.id);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const groupId = created.data.caseGroup.id;
  assert.equal(created.data.caseGroup.members.length, 1);
  assert.equal(created.data.caseGroup.status, 'collecting');
  // 锚点即冻结快照
  assert.equal(created.data.caseGroup.frozenSnapshot.members[0].packageId, pkgPhone.pkg.id);
  assert.deepEqual(created.data.caseGroup.frozenSnapshot.members[0].fieldKeys, ['0.phone']);

  // 字段冲突：再来一个含 phone 的包（同一原批次、不同申诉回合）
  const appealPhone2 = await setupCompletedAppeal(alice, batchId, '0.phone', { inviteCount: 2 });
  const pkgPhone2 = await createMediationSingle(alice, appealPhone2.roundId, '0.phone');
  const conflictField = await request('POST', `/api/case-groups/${groupId}/members`, auth(alice, {
    body: { packageId: pkgPhone2.pkg.id },
  }));
  assert.equal(conflictField.status, 409);
  assert.equal(conflictField.data.error.code, 'CASE_PACKAGE_FIELD_CONFLICT');

  // 重复加入同一个包：明确失败
  const dup = await request('POST', `/api/case-groups/${groupId}/members`, auth(alice, {
    body: { packageId: pkgPhone.pkg.id },
  }));
  assert.equal(dup.status, 409);
  assert.equal(dup.data.error.code, 'CASE_PACKAGE_SOURCE_CONFLICT');

  // 不同原批次的包不能加入
  const { receipt: receipt2 } = await completeAll(alice, PAYLOADS('13700001111', 'CASEGROUP-SECRET-OTHER'));
  const otherBatch = await setupRejectedBatch(alice, receipt2.receiptNo);
  const otherAppeal = await setupCompletedAppeal(alice, otherBatch.batchId, '0.phone', { inviteCount: 2 });
  const pkgOther = await createMediationSingle(alice, otherAppeal.roundId, '0.phone');
  const conflictBatch = await request('POST', `/api/case-groups/${groupId}/members`, auth(alice, {
    body: { packageId: pkgOther.pkg.id },
  }));
  assert.equal(conflictBatch.status, 409);
  assert.equal(conflictBatch.data.error.code, 'CASE_PACKAGE_BATCH_MISMATCH');

  // 无冲突的 description 包可以加入
  const ok = await request('POST', `/api/case-groups/${groupId}/members`, auth(alice, {
    body: { packageId: pkgDesc.pkg.id },
  }));
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.caseGroup.members.length, 2);

  // 拒绝留档：两条（字段冲突 + 批次冲突）
  const detail = await getGroup(alice, groupId);
  const codes = detail.data.caseGroup.rejections.map((r) => r.reasonCode);
  assert.ok(codes.includes('CASE_PACKAGE_FIELD_CONFLICT'));
  assert.ok(codes.includes('CASE_PACKAGE_BATCH_MISMATCH'));
  assert.ok(detail.data.caseGroup.rejections.every((r) => r.reasonDetail));

  // 组开始处理后不能再加入
  const config = await request('POST', `/api/case-groups/${groupId}/config`, auth(alice, {
    body: {
      minCompletions: 1,
      memberOrder: [pkgPhone.pkg.id, pkgDesc.pkg.id],
      timeoutPolicy: 'block_remaining',
      ttlMinutes: 60,
      disclosedPackageIds: [],
    },
  }));
  assert.equal(config.status, 200, JSON.stringify(config.data));
  const started = await request('POST', `/api/case-groups/${groupId}/start`, auth(alice, { body: {} }));
  assert.equal(started.status, 200, JSON.stringify(started.data));
  assert.equal(started.data.caseGroup.status, 'processing');
  const addAfterStart = await request('POST', `/api/case-groups/${groupId}/members`, auth(alice, {
    body: { packageId: pkgPhone2.pkg.id },
  }));
  assert.equal(addAfterStart.status, 409);
  assert.equal(addAfterStart.data.error.code, 'CASE_GROUP_NOT_COLLECTING');
});

// ---------------------------------------------------------------------------
// ② 两个办理页面并发加入同一成员包，只有一个成功
// ---------------------------------------------------------------------------
test('② 两个办理页面并发加入同一成员包只成功一个；成员包不能重复加入其他未终结组', async () => {
  const bob = await login('bob');
  const setup = await setupTwoPackages(bob);
  // 组A 以 phone 为锚点
  const gA = await createGroupWith(bob, setup.phone.packageId, '并发组A');
  assert.equal(gA.status, 200);
  // 两个办理页面同时把【同一个 desc 包】加入组A：只能一个成功
  const bob2 = await login('bob');
  const [r1, r2] = await Promise.all([
    request('POST', `/api/case-groups/${gA.data.caseGroup.id}/members`, auth(bob, { body: { packageId: setup.desc.packageId } })),
    request('POST', `/api/case-groups/${gA.data.caseGroup.id}/members`, auth(bob2, { body: { packageId: setup.desc.packageId } })),
  ]);
  assert.equal([r1, r2].filter((r) => r.status === 200).length, 1, '两个页面并发加入同一成员包只能一个成功');
  const loser = [r1, r2].find((r) => r.status !== 200);
  assert.equal(loser.status, 409);
  assert.ok(['CASE_PACKAGE_ALREADY_IN_GROUP', 'CASE_PACKAGE_SOURCE_CONFLICT'].includes(loser.data.error.code),
    `实际错误码：${loser.data.error.code}`);
  const winner = [r1, r2].find((r) => r.status === 200);
  assert.equal(winner.data.caseGroup.members.length, 2);

  // 已被未终结组占用的包不能作为另一个组的锚点
  const gOther = await createGroupWith(bob, setup.phone.packageId, '另一个组');
  assert.equal(gOther.status, 409);
  assert.equal(gOther.data.error.code, 'CASE_PACKAGE_ALREADY_IN_GROUP');

  // 取消组A后成员释放，可以加入新组
  const cancel = await request('POST', `/api/case-groups/${gA.data.caseGroup.id}/cancel`, auth(bob, { body: {} }));
  assert.equal(cancel.status, 200);
  const gB = await createGroupWith(bob, setup.desc.packageId, '取消后的新组');
  assert.equal(gB.status, 200);
  const addPhone = await request('POST', `/api/case-groups/${gB.data.caseGroup.id}/members`, auth(bob, {
    body: { packageId: setup.phone.packageId },
  }));
  assert.equal(addPhone.status, 200, JSON.stringify(addPhone.data));
});

// ---------------------------------------------------------------------------
// ②b 组配置开始处理即冻结；同一案件组不能启动两次
// ---------------------------------------------------------------------------
test('②b 组级配置开始处理后冻结；两个页面并发启动只成功一次', async () => {
  const carol = await login('carol');
  const setup = await setupTwoPackages(carol);
  const group = await createGroupWith(carol, setup.phone.packageId);
  const groupId = group.data.caseGroup.id;
  await request('POST', `/api/case-groups/${groupId}/members`, auth(carol, {
    body: { packageId: setup.desc.packageId },
  }));
  const configBody = {
    minCompletions: 1,
    memberOrder: [setup.phone.packageId, setup.desc.packageId],
    timeoutPolicy: 'block_remaining',
    ttlMinutes: 60,
    disclosedPackageIds: [],
  };
  const saveConfig = await request('POST', `/api/case-groups/${groupId}/config`, auth(carol, { body: configBody }));
  assert.equal(saveConfig.status, 200, JSON.stringify(saveConfig.data));

  // 两个页面并发启动：只成功一个
  const carol2 = await login('carol');
  const [s1, s2] = await Promise.all([
    request('POST', `/api/case-groups/${groupId}/start`, auth(carol, { body: {} })),
    request('POST', `/api/case-groups/${groupId}/start`, auth(carol2, { body: {} })),
  ]);
  assert.equal([s1, s2].filter((r) => r.status === 200).length, 1);
  const startLoser = [s1, s2].find((r) => r.status !== 200);
  assert.equal(startLoser.status, 409);
  assert.equal(startLoser.data.error.code, 'CASE_GROUP_ALREADY_STARTED');

  // 开始后配置冻结：再次保存/加入成员均被拒绝
  const reconfig = await request('POST', `/api/case-groups/${groupId}/config`, auth(carol, {
    body: { ...configBody, minCompletions: 2 },
  }));
  assert.equal(reconfig.status, 409);
  assert.equal(reconfig.data.error.code, 'CASE_GROUP_NOT_COLLECTING');
  const appealExtra = await setupCompletedAppeal(carol, setup.batchId, '0.phone', { inviteCount: 2 });
  const pkgExtra = await createMediationSingle(carol, appealExtra.roundId, '0.phone');
  const addAfter = await request('POST', `/api/case-groups/${groupId}/members`, auth(carol, {
    body: { packageId: pkgExtra.pkg.id },
  }));
  assert.equal(addAfter.status, 409);
  assert.equal(addAfter.data.error.code, 'CASE_GROUP_NOT_COLLECTING');

  // 冻结顺序与配置持久化
  const detail = await getGroup(carol, groupId);
  assert.equal(detail.data.caseGroup.status, 'processing');
  assert.deepEqual(detail.data.caseGroup.memberOrder, configBody.memberOrder);
  assert.equal(detail.data.caseGroup.minCompletions, 1);
});

test('③ 仅达到组级开放条件的成员包能进入第二层仲裁，其他成员仲裁邀请继续拒绝', async () => {
  const carol = await login('carol');
  const setup = await setupTwoPackages(carol);
  const group = await createGroupWith(carol, setup.phone.packageId);
  const groupId = group.data.caseGroup.id;
  const add = await request('POST', `/api/case-groups/${groupId}/members`, auth(carol, {
    body: { packageId: setup.desc.packageId },
  }));
  assert.equal(add.status, 200);
  // 最少完成数 1，顺序 phone → description：只有 phone 能进仲裁
  await request('POST', `/api/case-groups/${groupId}/config`, auth(carol, {
    body: {
      minCompletions: 1,
      memberOrder: [setup.phone.packageId, setup.desc.packageId],
      timeoutPolicy: 'block_remaining',
      ttlMinutes: 60,
      disclosedPackageIds: [setup.phone.packageId],
    },
  }));
  const started = await request('POST', `/api/case-groups/${groupId}/start`, auth(carol, { body: {} }));
  assert.equal(started.status, 200);

  // phone 第一层驳回 → 达到升级条件且为第 1 位（< minCompletions=1 的计数：ordinal 0 < 1）→ 开放仲裁
  const rejectPhone = await rejectPackageLayer1(carol, setup.phone.created, setup.phone.packageId);
  assert.equal(rejectPhone.status, 200, JSON.stringify(rejectPhone.data));
  assert.equal(rejectPhone.data.escalated, true);
  let detail = await getGroup(carol, groupId);
  const phoneMember = detail.data.caseGroup.members.find((m) => m.packageId === setup.phone.packageId);
  assert.equal(phoneMember.status, 'arbitrating');

  // phone 的仲裁链接可用
  const phoneArb = setup.phone.created.links.find((l) => l.tier === 2);
  const validated = await validateTier(phoneArb.token, 2);
  assert.equal(validated.res.status, 200, JSON.stringify(validated.res.data));

  // description 第一层驳回 → ordinal 1 ≥ minCompletions 1 → 阻止第二层，包按第一层终局完成
  const rejectDesc = await rejectPackageLayer1(carol, setup.desc.created, setup.desc.packageId);
  assert.equal(rejectDesc.status, 200, JSON.stringify(rejectDesc.data));
  assert.equal(rejectDesc.data.escalated, false);
  assert.equal(rejectDesc.data.packageCompleted, true);
  detail = await getGroup(carol, groupId);
  const descMember = detail.data.caseGroup.members.find((m) => m.packageId === setup.desc.packageId);
  assert.equal(descMember.status, 'arbitration_blocked');
  assert.match(descMember.gateReason, /超出组级最少完成数/);

  // description 的仲裁链接必须继续拒绝（未达组级开放条件）
  const descArb = setup.desc.created.links.find((l) => l.tier === 2);
  const blocked = await validateTier(descArb.token, 2);
  assert.ok([409, 410].includes(blocked.res.status), `实际状态：${blocked.res.status}`);
  assert.ok(
    ['CASE_GROUP_ARBITRATION_NOT_OPEN', 'ARBITRATION_NOT_OPEN', 'MEDIATION_NOT_ACTIVE'].includes(blocked.res.data.error.code),
    `实际错误码：${blocked.res.data.error.code}`,
  );

  // 组在 phone 仲裁也终局后完成（这里放弃 phone 已接受更正路径不走；直接核验 blocked 成员结果持久化）
  assert.ok(descMember.result, '成员结果（邀请状态/顺序/门控原因）必须固化');
  assert.equal(descMember.result.ordinal, 1);
  assert.match(descMember.result.gateReason, /超出组级最少完成数/);
});

// ---------------------------------------------------------------------------
// ④ 跨包摘要不得泄露其他包字段和原文
// ---------------------------------------------------------------------------
test('④ 仲裁人只能看到组级允许披露的脱敏跨包摘要，不含其他包字段与原文', async () => {
  const dave = await login('dave');
  const setup = await setupTwoPackages(dave);
  const group = await createGroupWith(dave, setup.phone.packageId);
  const groupId = group.data.caseGroup.id;
  await request('POST', `/api/case-groups/${groupId}/members`, auth(dave, {
    body: { packageId: setup.desc.packageId },
  }));
  await request('POST', `/api/case-groups/${groupId}/config`, auth(dave, {
    body: {
      minCompletions: 2,
      memberOrder: [setup.phone.packageId, setup.desc.packageId],
      timeoutPolicy: 'block_remaining',
      ttlMinutes: 60,
      disclosedPackageIds: [setup.desc.packageId], // phone 的仲裁人可以看到 desc 的聚合摘要
    },
  }));
  await request('POST', `/api/case-groups/${groupId}/start`, auth(dave, { body: {} }));

  // 先让 description（第 2 位）第一层驳回：按冻结顺序它应挂起（前置 phone 未终局）
  const rejectDesc = await rejectPackageLayer1(dave, setup.desc.created, setup.desc.packageId);
  assert.equal(rejectDesc.status, 200);
  assert.equal(rejectDesc.data.parked, true, '前置成员未终局时应挂起等待');
  let detail = await getGroup(dave, groupId);
  const descMember = detail.data.caseGroup.members.find((m) => m.packageId === setup.desc.packageId);
  assert.equal(descMember.status, 'parked');
  // 挂起期间仲裁链接继续被拒绝
  const descArbBlocked = await validateTier(setup.desc.created.links.find((l) => l.tier === 2).token, 2);
  assert.equal(descArbBlocked.res.status, 409);
  assert.equal(descArbBlocked.res.data.error.code, 'CASE_GROUP_ARBITRATION_NOT_OPEN');

  // phone 第一层驳回 → 第 1 位开放仲裁，并级联把 desc 也开放（minCompletions=2，前置 phone 已终局）
  const rejectPhone = await rejectPackageLayer1(dave, setup.phone.created, setup.phone.packageId);
  assert.equal(rejectPhone.status, 200);
  assert.equal(rejectPhone.data.escalated, true);
  detail = await getGroup(dave, groupId);
  const statuses = Object.fromEntries(detail.data.caseGroup.members.map((m) => [m.packageId, m.status]));
  assert.equal(statuses[setup.phone.packageId], 'arbitrating');
  assert.equal(statuses[setup.desc.packageId], 'arbitrating');

  // phone 仲裁人上下文：跨包摘要只含 desc 的聚合计数，不含任何字段/原文
  const phoneArb = await validateTier(setup.phone.created.links.find((l) => l.tier === 2).token, 2);
  assert.equal(phoneArb.res.status, 200);
  const ctx = await tierContext(phoneArb, 2);
  assert.equal(ctx.status, 200, JSON.stringify(ctx.data));
  const groupBlock = ctx.data.context.group;
  assert.ok(groupBlock, '仲裁上下文必须带组块');
  const serialized = JSON.stringify(groupBlock);
  assert.ok(!serialized.includes('description'), '跨包摘要不得包含其他包字段 key');
  assert.ok(!serialized.includes('2.description'), '跨包摘要不得包含其他包字段 key');
  assert.ok(!serialized.includes('事项说明'), '跨包摘要不得包含其他包字段原文/证据');
  assert.ok(!serialized.includes('调解'), '跨包摘要不得包含其他包处理人/邀请标签');
  assert.ok(!serialized.includes('CASEGROUP-SECRET'), '跨包摘要不得包含敏感原值');
  const summary = groupBlock.crossPackageSummary;
  assert.equal(summary.containsOtherPackageFields, false);
  assert.equal(summary.otherPackages.length, 1);
  assert.equal(summary.otherPackages[0].memberStatus, 'arbitrating');
  assert.equal(typeof summary.otherPackages[0].layer1.rejectedCount, 'number');

  // 仲裁人合并视图本身也只含本包字段 phone，看不到 desc 字段
  const mergedKeys = ctx.data.context.merged.map((m) => m.key);
  assert.deepEqual(mergedKeys, ['0.phone']);
  const full = JSON.stringify(ctx.data.context);
  assert.ok(!full.includes('补充材料'), '其他包原证据不得出现在仲裁上下文');
});

// ---------------------------------------------------------------------------
// ⑤ 成员包更正或取消时，组级状态原子变化
// ---------------------------------------------------------------------------
test('⑤ 成员包更正或取消时，组级状态与剩余成员按冻结规则原子更新', async () => {
  const erin = await login('erin');
  const setup = await setupTwoPackages(erin);
  const group = await createGroupWith(erin, setup.phone.packageId);
  const groupId = group.data.caseGroup.id;
  await request('POST', `/api/case-groups/${groupId}/members`, auth(erin, {
    body: { packageId: setup.desc.packageId },
  }));
  await request('POST', `/api/case-groups/${groupId}/config`, auth(erin, {
    body: {
      minCompletions: 2,
      memberOrder: [setup.phone.packageId, setup.desc.packageId],
      timeoutPolicy: 'block_remaining',
      ttlMinutes: 60,
      disclosedPackageIds: [],
    },
  }));
  await request('POST', `/api/case-groups/${groupId}/start`, auth(erin, { body: {} }));

  // 第一层留档意见但不决议：取消成员包 desc（尚无终局决议，可取消）→ 组成员 cancelled，组原子更新
  const descLink = setup.desc.created.links.filter((l) => l.tier === 1)[0];
  const ds = await validateTier(descLink.token, 1);
  await submitTier(ds, 1, '2.description', '取消前留档的调解意见');
  const cancel = await request('POST', `/api/mediation-packages/${setup.desc.packageId}/cancel`, auth(erin, {
    body: { reason: '办理人取消成员包' },
  }));
  assert.equal(cancel.status, 200, JSON.stringify(cancel.data));
  let detail = await getGroup(erin, groupId);
  const descMember = detail.data.caseGroup.members.find((m) => m.packageId === setup.desc.packageId);
  assert.equal(descMember.status, 'cancelled');
  assert.equal(descMember.result.status, 'cancelled');
  // 组仍 processing（phone 第一层未终局），取消事件已留档
  assert.equal(detail.data.caseGroup.status, 'processing');
  const eventTypes = detail.data.caseGroup.events.map((e) => e.type);
  assert.ok(eventTypes.includes('review.caseGroup.member.failed'));

  // phone 第一层驳回（3 人均不提意见）→ ordinal 0 前置已终局、minCompletions=2 → 开放仲裁；
  // 此时 desc 已取消，不影响 phone 按顺序开放
  const rejectPhone = await rejectPackageLayer1(erin, setup.phone.created, setup.phone.packageId);
  assert.equal(rejectPhone.status, 200, JSON.stringify(rejectPhone.data));
  assert.equal(rejectPhone.data.escalated, true);
  detail = await getGroup(erin, groupId);
  const phoneMember = detail.data.caseGroup.members.find((m) => m.packageId === setup.phone.packageId);
  assert.equal(phoneMember.status, 'arbitrating');
  // desc 终态不被改写
  const descAfter = detail.data.caseGroup.members.find((m) => m.packageId === setup.desc.packageId);
  assert.equal(descAfter.status, 'cancelled');
});

// ---------------------------------------------------------------------------
// ⑥ 组级超时重复触发不产生第二次结果
// ---------------------------------------------------------------------------
test('⑥ 组级超时落定只产生一次结果，重复扫描幂等', async () => {
  const alice = await login('alice');
  const setup = await setupTwoPackages(alice);
  const group = await createGroupWith(alice, setup.phone.packageId);
  const groupId = group.data.caseGroup.id;
  await request('POST', `/api/case-groups/${groupId}/members`, auth(alice, {
    body: { packageId: setup.desc.packageId },
  }));
  await request('POST', `/api/case-groups/${groupId}/config`, auth(alice, {
    body: {
      minCompletions: 2,
      memberOrder: [setup.phone.packageId, setup.desc.packageId],
      timeoutPolicy: 'block_remaining',
      ttlMinutes: 60,
      disclosedPackageIds: [],
    },
  }));
  await request('POST', `/api/case-groups/${groupId}/start`, auth(alice, { body: {} }));

  const { db } = await import('../src/db.js');
  const past = Date.now() - 1000;
  db.prepare('UPDATE case_groups SET deadline_at = ? WHERE id = ?').run(past, groupId);

  const { sweepCaseGroupTimeouts } = await import('../src/db.js');
  const changed1 = sweepCaseGroupTimeouts();
  const firedAt1 = db.prepare('SELECT timeout_fired_at FROM case_groups WHERE id = ?').get(groupId).timeout_fired_at;
  const membersAfter1 = db.prepare('SELECT status FROM case_group_members WHERE group_id = ?').all(groupId).map((r) => r.status);
  const changed2 = sweepCaseGroupTimeouts();
  const firedAt2 = db.prepare('SELECT timeout_fired_at FROM case_groups WHERE id = ?').get(groupId).timeout_fired_at;
  assert.ok(changed1 >= 1, '首次扫描应落定组超时');
  assert.equal(changed2, 0, '重复扫描不得产生第二次结果');
  assert.equal(firedAt1, firedAt2);
  // block_remaining：两个未开放仲裁的成员都被阻止，包按第一层终局完成；组完成
  assert.deepEqual(membersAfter1.sort(), ['arbitration_blocked', 'arbitration_blocked']);
  const groupRow = db.prepare('SELECT status, timeout_result FROM case_groups WHERE id = ?').get(groupId);
  assert.equal(groupRow.timeout_result, 'block_remaining');
  assert.equal(groupRow.status, 'completed');
  for (const packageId of [setup.phone.packageId, setup.desc.packageId]) {
    const pkg = db.prepare('SELECT status FROM mediation_packages WHERE id = ?').get(packageId);
    assert.equal(pkg.status, 'completed');
    // 仲裁链接继续被拒绝（包已完成，链接关闭：409 组门控或 410 链接失效）
    const created = packageId === setup.phone.packageId ? setup.phone.created : setup.desc.created;
    const blocked = await validateTier(created.links.find((l) => l.tier === 2).token, 2);
    assert.ok([409, 410].includes(blocked.res.status), `实际状态：${blocked.res.status}`);
  }
});

test('⑥b 组级 fail 超时强制终结未开放成员，审计结果完整', async () => {
  const bob = await login('bob');
  const setup = await setupTwoPackages(bob);
  const group = await createGroupWith(bob, setup.phone.packageId);
  const groupId = group.data.caseGroup.id;
  await request('POST', `/api/case-groups/${groupId}/members`, auth(bob, {
    body: { packageId: setup.desc.packageId },
  }));
  await request('POST', `/api/case-groups/${groupId}/config`, auth(bob, {
    body: {
      minCompletions: 2,
      memberOrder: [setup.phone.packageId, setup.desc.packageId],
      timeoutPolicy: 'fail',
      ttlMinutes: 60,
      disclosedPackageIds: [],
    },
  }));
  await request('POST', `/api/case-groups/${groupId}/start`, auth(bob, { body: {} }));
  const { db } = await import('../src/db.js');
  db.prepare('UPDATE case_groups SET deadline_at = ? WHERE id = ?').run(Date.now() - 1, groupId);
  const { sweepCaseGroupTimeouts } = await import('../src/db.js');
  sweepCaseGroupTimeouts();
  const row = db.prepare('SELECT status FROM case_groups WHERE id = ?').get(groupId);
  assert.equal(row.status, 'failed');
  const memberStatuses = db.prepare('SELECT package_id, status FROM case_group_members WHERE group_id = ?').all(groupId);
  assert.ok(memberStatuses.every((m) => m.status === 'failed'));
  for (const packageId of [setup.phone.packageId, setup.desc.packageId]) {
    const pkg = db.prepare('SELECT status FROM mediation_packages WHERE id = ?').get(packageId);
    assert.equal(pkg.status, 'failed');
  }
  // 组终结后成员包可加入新案件组（open_group_id 已清空）——这里仅核验不再被占用
  const occupied = db.prepare('SELECT COUNT(*) AS n FROM case_group_members WHERE open_group_id = ?').get(groupId).n;
  assert.equal(occupied, 0);
});

// ---------------------------------------------------------------------------
// ⑦ 处理顺序与权限在服务重启后仍保持一致
// ---------------------------------------------------------------------------
test('⑦ 服务重启后组快照、成员关系、权限摘要、门控状态与时间线一致', async () => {
  const carol = await login('carol');
  const setup = await setupTwoPackages(carol);
  const group = await createGroupWith(carol, setup.phone.packageId);
  const groupId = group.data.caseGroup.id;
  await request('POST', `/api/case-groups/${groupId}/members`, auth(carol, {
    body: { packageId: setup.desc.packageId },
  }));
  await request('POST', `/api/case-groups/${groupId}/config`, auth(carol, {
    body: {
      minCompletions: 1,
      memberOrder: [setup.phone.packageId, setup.desc.packageId],
      timeoutPolicy: 'block_remaining',
      ttlMinutes: 60,
      disclosedPackageIds: [setup.phone.packageId],
    },
  }));
  await request('POST', `/api/case-groups/${groupId}/start`, auth(carol, { body: {} }));
  // description 第一层先驳回 → 应挂起（顺序在 phone 之后）
  await rejectPackageLayer1(carol, setup.desc.created, setup.desc.packageId);
  let detail = await getGroup(carol, groupId);
  assert.equal(detail.data.caseGroup.members.find((m) => m.packageId === setup.desc.packageId).status, 'parked');

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

    // 时间线中的案件组条目：顺序、冻结快照、门控状态保持
    const entry = state.timeline.find((t) => t.kind === 'caseGroup' && t.id === groupId);
    assert.ok(entry, '案件组条目重启后仍在时间线');
    assert.equal(entry.status, 'processing');
    assert.equal(entry.minCompletions, 1);
    assert.deepEqual(entry.memberOrder, [setup.phone.packageId, setup.desc.packageId]);
    assert.equal(entry.timeoutPolicy, 'block_remaining');
    const descAfter = entry.members.find((m) => m.packageId === setup.desc.packageId);
    const phoneAfter = entry.members.find((m) => m.packageId === setup.phone.packageId);
    assert.equal(descAfter.status, 'parked');
    assert.equal(phoneAfter.status, 'layer1_open');
    assert.equal(descAfter.ordinal, 1);
    // 成员包各自冻结字段仍隔离
    assert.deepEqual(phoneAfter.frozenFieldKeys, ['0.phone']);
    assert.deepEqual(descAfter.frozenFieldKeys, ['2.description']);
    // 锚点快照内容不随后续变化改写
    assert.ok(entry.frozenSnapshot.members.length === 2);

    // 重启后让 phone 第一层驳回：级联把 desc 阻断（minCompletions=1，desc ordinal 1 超出）
    const loginBody = await loginRes.clone().json().catch(() => ({}));
    // CSRF 校验同时要求 csrf Cookie 与匹配的 X-CSRF-Token 头
    const authHeaders = {
      Cookie: `sid=${cookies.sid}; csrf=${loginBody.csrfToken || cookies.csrf}`,
      'X-CSRF-Token': loginBody.csrfToken,
      'Content-Type': 'application/json',
    };
    // 校验三位调解人并驳回 phone（子进程）
    for (const link of setup.phone.created.links.filter((l) => l.tier === 1)) {
      const v = await fetch(`${child.url}/api/mediation-review/validate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: link.token }),
      });
      assert.equal(v.status, 200, await v.text());
    }
    const pkgRes = await fetch(`${child.url}/api/mediation-packages/${setup.phone.packageId}`, {
      headers: { Cookie: `sid=${cookies.sid}` },
    });
    const pkgBody = await pkgRes.json();
    const fieldId = pkgBody.pkg.tier1.fields[0].id;
    const rejectRes = await fetch(`${child.url}/api/mediation-packages/${setup.phone.packageId}/fields/${fieldId}/reject`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ reason: '重启后第一层手工驳回手机号' }),
    });
    const rejectBody = await rejectRes.json().catch(() => ({}));
    assert.equal(rejectRes.status, 200, JSON.stringify(rejectBody));
    assert.equal(rejectBody.escalated, true);

    const groupRes = await fetch(`${child.url}/api/case-groups/${groupId}`, {
      headers: { Cookie: `sid=${cookies.sid}` },
    });
    const groupBody = await groupRes.json();
    const statuses = Object.fromEntries(groupBody.caseGroup.members.map((m) => [m.packageId, m.status]));
    assert.equal(statuses[setup.phone.packageId], 'arbitrating');
    assert.equal(statuses[setup.desc.packageId], 'arbitration_blocked');

    // 两次启动扫描幂等：再次恢复不改变状态
    const state2 = await (await fetch(`${child.url}/api/state`, { headers: { Cookie: `sid=${cookies.sid}` } })).json();
    const entry2 = state2.timeline.find((t) => t.kind === 'caseGroup' && t.id === groupId);
    const statuses2 = Object.fromEntries(entry2.members.map((m) => [m.packageId, m.status]));
    assert.deepEqual(statuses2, statuses);
  } finally {
    await stop(child);
  }
});

test.after(async () => {
  server.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
});
