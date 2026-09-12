import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

process.env.DB_PATH = path.join(process.cwd(), 'data', `test-review-${process.pid}.db`);
process.env.TOKEN_TTL_MS = '600000';
process.env.RECEIPT_SECRET = 'unit-test-review-secret-fixed-value';
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
  const setCookie = () => parsePair(response.headers.get('set-cookie') || '');
  return { status: response.status, headers: response.headers, data, text, setCookie };
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

const PAYLOADS = [
  { name: '王复核', idNumber: 'SECRET-ID-REVIEW-001', phone: '13800138000' },
  { province: '江苏省', city: '南京市', detail: '玄武区秘密路 99 号' },
  { type: 'change', description: '复核测试事项说明' },
  { agreed: true, contactTime: '上午' },
];

function randomPageId() {
  return crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}

async function confirmCurrentStep(client, workflow, payload) {
  const step = workflow.progress;
  const pageId = randomPageId();
  const tokenRes = await request('POST', '/api/tokens', auth(client, { body: { step, pageId } }));
  assert.equal(tokenRes.status, 200, JSON.stringify(tokenRes.data));
  const res = await request('POST', '/api/submissions', auth(client, {
    body: { step, pageId, token: tokenRes.data.token, idempotencyKey: crypto.randomUUID(), payload },
  }));
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data;
}

async function completeAll(client, payloads = PAYLOADS) {
  let workflow = (await request('GET', '/api/state', auth(client))).data.workflow;
  let receipt = null;
  while (!workflow.completed) {
    const result = await confirmCurrentStep(client, workflow, payloads[workflow.progress]);
    workflow = result.workflow;
    if (result.receipt) receipt = result.receipt;
  }
  return { workflow, receipt };
}

async function createInvite(client, receiptNo, ttlMinutes = 60 * 24) {
  const res = await request('POST', '/api/reviews/invitations', auth(client, { body: { receiptNo, ttlMinutes } }));
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.match(res.data.url, /^\/review\?t=/);
  assert.ok(res.data.token.length >= 20);
  return res.data;
}

// 完成一次性邀请校验，返回复核会话（cookie + csrf）
async function validateInvite(token, expectOk = true) {
  const res = await request('POST', '/api/review/validate', { body: { token } });
  if (expectOk) assert.equal(res.status, 200, JSON.stringify(res.data));
  const cookies = parsePair(res.headers.get('set-cookie') || '');
  const sessionCookie = `rid=${cookies.rid || ''}; rcsrf=${cookies.rcsrf || ''}`;
  return { res, cookie: sessionCookie, csrf: res.data?.csrfToken || '' };
}

function reviewHeaders(session, extra = {}) {
  return { Cookie: session.cookie, 'X-CSRF-Token': session.csrf, ...(extra.headers || {}) };
}

async function getContext(session) {
  return request('GET', '/api/review/context', { headers: { Cookie: session.cookie } });
}

test('复核邀请校验：成功一次；过期/撤销/重复使用/伪造令牌都明确失败', async () => {
  const alice = await login('alice');
  const { receipt } = await completeAll(alice);

  // 未登录/无会话访问复核上下文：必须先校验
  const noSession = await request('GET', '/api/review/context');
  assert.equal(noSession.status, 401);
  assert.equal(noSession.data.error.code, 'REVIEW_SESSION_REQUIRED');

  const invite = await createInvite(alice, receipt.receiptNo);
  const token = invite.token;

  // 伪造令牌
  const bogus = await request('POST', '/api/review/validate', { body: { token: 'A'.repeat(43) } });
  assert.equal(bogus.status, 404);
  assert.equal(bogus.data.error.code, 'INVITATION_NOT_FOUND');

  // 正常校验成功
  const first = await validateInvite(token);
  assert.equal(first.res.status, 200);
  assert.equal(first.res.data.receiptNo, receipt.receiptNo);

  // 链接只能使用一次：重复校验明确失败
  const second = await request('POST', '/api/review/validate', { body: { token } });
  assert.equal(second.status, 410);
  assert.equal(second.data.error.code, 'INVITATION_ALREADY_USED');

  // 已使用后再撤销：明确提示已使用（不能再产生新会话）
  const list = await request('GET', '/api/reviews/invitations', auth(alice));
  const usedInv = list.data.invitations.find((i) => i.id === invite.invitation.id);
  assert.equal(usedInv.status, 'used');
  const revokeUsed = await request('POST', `/api/reviews/invitations/${invite.invitation.id}/revoke`, auth(alice, { body: {} }));
  assert.equal(revokeUsed.status, 409);
  assert.equal(revokeUsed.data.error.code, 'INVITATION_ALREADY_USED');
  // 撤销尝试不影响已建立的复核会话语义；但“使用过的邀请不可撤销”被明确拒绝

  // 过期邀请：短 TTL 邀请过期后校验失败
  const short = await request('POST', '/api/reviews/invitations', auth(alice, {
    body: { receiptNo: receipt.receiptNo, ttlMinutes: 1 },
  }));
  assert.equal(short.status, 200);
  // 直接把数据库里的过期时间回拨
  const { db } = await import('../src/db.js');
  db.prepare('UPDATE review_invitations SET expires_at = ? WHERE id = ?')
    .run(Date.now() - 1000, short.data.invitation.id);
  const expired = await request('POST', '/api/review/validate', { body: { token: short.data.token } });
  assert.equal(expired.status, 410);
  assert.equal(expired.data.error.code, 'INVITATION_EXPIRED');

  // 撤销：未使用的活跃邀请撤销后校验失败，且已发出的会话失效
  const revInvite = await createInvite(alice, receipt.receiptNo);
  const revoked = await request('POST', `/api/reviews/invitations/${revInvite.invitation.id}/revoke`, auth(alice, { body: {} }));
  assert.equal(revoked.status, 200);
  const useRevoked = await request('POST', '/api/review/validate', { body: { token: revInvite.token } });
  assert.equal(useRevoked.status, 410);
  assert.equal(useRevoked.data.error.code, 'INVITATION_REVOKED');

  // TTL 越界
  const badTtl = await request('POST', '/api/reviews/invitations', auth(alice, {
    body: { receiptNo: receipt.receiptNo, ttlMinutes: 99999 },
  }));
  assert.equal(badTtl.status, 400);
  assert.equal(badTtl.data.error.code, 'INVALID_TTL');

  // 他人账号不能为不属于自己的回执创建邀请
  const bob = await login('bob');
  const foreign = await request('POST', '/api/reviews/invitations', auth(bob, {
    body: { receiptNo: receipt.receiptNo, ttlMinutes: 60 },
  }));
  assert.equal(foreign.status, 404);
  assert.equal(foreign.data.error.code, 'RECEIPT_NOT_FOUND');
});

test('复核上下文只返回这一份回执的脱敏内容，敏感原值不下发', async () => {
  const bob = await login('bob');
  const { receipt } = await completeAll(bob);
  const invite = await createInvite(bob, receipt.receiptNo);
  const session = await validateInvite(invite.token);

  const ctx = await getContext(session);
  assert.equal(ctx.status, 200, JSON.stringify(ctx.data));
  const { context } = ctx.data;
  assert.equal(context.receiptNo, receipt.receiptNo);
  assert.ok(context.view, '应包含脱敏视图');

  const serialized = JSON.stringify(context);
  assert.ok(!serialized.includes('SECRET-ID-REVIEW-001'), '证件号码不得下发');
  assert.ok(!serialized.includes('秘密路'), '详细地址原值不得下发');
  assert.ok(!serialized.includes('13800138000'), '完整手机号不得下发');

  const step0 = Object.fromEntries(context.view.steps[0].fields.map((f) => [f.field, f]));
  assert.equal(step0.name.value, '王*核');
  assert.match(step0.phone.value, /^138\*\*\*\*8000$/);
  assert.match(step0.idNumber.value, /^SE\*+01$/);
  assert.equal(step0.idNumber.masked, true);
  const step1 = Object.fromEntries(context.view.steps[1].fields.map((f) => [f.field, f]));
  assert.match(step1.detail.value, /^玄武\*+$/);
  assert.equal(step1.province.value, '江苏省');

  // 拿这个会话尝试访问“别的回执”：提交异议时携带其他回执编号必须明确失败
  const mismatch = await request('POST', '/api/review/objections', {
    headers: reviewHeaders(session),
    body: {
      step: 0, field: 'phone', reason: '尝试查看其他回执',
      idempotencyKey: crypto.randomUUID().replace(/-/g, ''),
      receiptNo: 'HZ-20000101-AAAAAAAA',
    },
  });
  assert.equal(mismatch.status, 403);
  assert.equal(mismatch.data.error.code, 'REVIEW_RECEIPT_MISMATCH');

  // 无会话提交异议必须先校验
  const noAuth = await request('POST', '/api/review/objections', {
    body: { step: 0, field: 'phone', reason: 'x', idempotencyKey: crypto.randomUUID().replace(/-/g, '') },
  });
  assert.equal(noAuth.status, 401);

  // CSRF 缺失/错误
  const noCsrf = await request('POST', '/api/review/objections', {
    headers: { Cookie: session.cookie },
    body: { step: 0, field: 'phone', reason: '无csrf', idempotencyKey: crypto.randomUUID().replace(/-/g, '') },
  });
  assert.equal(noCsrf.status, 403);
  assert.equal(noCsrf.data.error.code, 'REVIEW_CSRF_INVALID');
});

test('复核人提交字段异议：校验字段、幂等重试只得到同一条，办理人可查收', async () => {
  const carol = await login('carol');
  const { receipt } = await completeAll(carol);
  const invite = await createInvite(carol, receipt.receiptNo);
  const session = await validateInvite(invite.token);

  const submit = (body, headers = reviewHeaders(session)) =>
    request('POST', '/api/review/objections', { headers, body });

  // 非法字段 / 步骤
  const badField = await submit({ step: 0, field: 'notExist', reason: '字段不存在', idempotencyKey: randomPageId() });
  assert.equal(badField.status, 400);
  assert.equal(badField.data.error.code, 'INVALID_FIELD');
  const badReason = await submit({ step: 0, field: 'phone', reason: 'x', idempotencyKey: randomPageId() });
  assert.equal(badReason.status, 400);
  assert.equal(badReason.data.error.code, 'INVALID_REASON');

  // 正常提交
  const idem = randomPageId();
  const payload = { step: 0, field: 'phone', reason: '手机号末位应为 1234，请核对', idempotencyKey: idem };
  const ok = await submit(payload);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(ok.data.objection.status, 'open');
  assert.match(ok.data.objection.valueSnapshot, /^138\*\*\*\*8000$/);
  assert.ok(ok.data.objection.submittedAt);

  // 网络重试（同一幂等键+相同内容）：同一条结果，replay=true，不产生第二条
  const retry = await submit(payload);
  assert.equal(retry.status, 200);
  assert.equal(retry.data.replay, true);
  assert.equal(retry.data.objection.id, ok.data.objection.id);

  // 同一幂等键换内容：明确失败
  const swapped = await submit({ ...payload, reason: '换成另一个完全不同的异议说明内容' });
  assert.equal(swapped.status, 409);
  assert.equal(swapped.data.error.code, 'OBJECTION_DUPLICATE_KEY');

  // 再提交一条针对地址的异议
  const second = await submit({ step: 1, field: 'detail', reason: '详细地址中的门牌号有误', idempotencyKey: randomPageId() });
  assert.equal(second.status, 200);

  // 办理人侧看到两条异议，时间线包含复核条目
  const ownerList = await request('GET', '/api/reviews/objections', auth(carol));
  assert.equal(ownerList.data.objections.length, 2);
  const ownerOne = ownerList.data.objections.find((o) => o.id === ok.data.objection.id);
  assert.equal(ownerOne.status, 'open');
  assert.equal(ownerOne.fieldLabel, '手机号');

  const state = (await request('GET', '/api/state', auth(carol))).data;
  const reviewEntries = state.timeline.filter((e) => e.kind === 'review');
  assert.equal(reviewEntries.length, 1);
  assert.equal(reviewEntries[0].receiptNo, receipt.receiptNo);
  assert.equal(reviewEntries[0].objectionCount, 2);
  assert.equal(reviewEntries[0].openCount, 2);

  // 复核人上下文列出本人异议（脱敏视图内不含处理人信息）
  const ctx = await getContext(session);
  assert.equal(ctx.data.context.objections.length, 2);
});

test('办理人驳回异议必须保留理由；重复处理得到同一结果并显示已处理', async () => {
  const dave = await login('dave');
  const { receipt } = await completeAll(dave);
  const invite = await createInvite(dave, receipt.receiptNo);
  const session = await validateInvite(invite.token);
  const created = await request('POST', '/api/review/objections', {
    headers: reviewHeaders(session),
    body: { step: 2, field: 'description', reason: '事项说明与实际不符，请重新核实', idempotencyKey: randomPageId() },
  });
  const objectionId = created.data.objection.id;

  // 驳回理由过短
  const noReason = await request('POST', `/api/reviews/objections/${objectionId}/reject`, auth(dave, { body: { reason: 'x' } }));
  assert.equal(noReason.status, 400);
  assert.equal(noReason.data.error.code, 'REJECT_REASON_REQUIRED');

  const rejected = await request('POST', `/api/reviews/objections/${objectionId}/reject`, auth(dave, {
    body: { reason: '经核对原申报材料，说明内容正确，无需更正' },
  }));
  assert.equal(rejected.status, 200, JSON.stringify(rejected.data));
  assert.equal(rejected.data.objection.status, 'rejected');
  assert.ok(rejected.data.objection.resolvedAt);
  assert.match(rejected.data.objection.resolveReason, /原申报材料/);

  // 重复驳回 / 再接受：都返回同一结果并明确已处理
  const again = await request('POST', `/api/reviews/objections/${objectionId}/reject`, auth(dave, {
    body: { reason: '再次驳回的另一个理由内容' },
  }));
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, 'OBJECTION_ALREADY_HANDLED');
  assert.equal(again.data.alreadyHandled, true);
  assert.equal(again.data.objection.status, 'rejected');
  assert.match(again.data.objection.resolveReason, /原申报材料/);

  const acceptAfter = await request('POST', `/api/reviews/objections/${objectionId}/accept`, auth(dave, { body: {} }));
  assert.equal(acceptAfter.status, 409);
  assert.equal(acceptAfter.data.objection.status, 'rejected');

  // 复核人侧看到驳回状态与理由
  const ctx = await getContext(session);
  const item = ctx.data.context.objections.find((o) => o.id === objectionId);
  assert.equal(item.status, 'rejected');
  assert.match(item.resolveReason, /原申报材料/);
  assert.ok(item.resolvedAt);
});

test('接受异议进入新的更正办理；原回执不被覆盖，完成后生成新回执并挂接来源', async () => {
  const erin = await login('erin');
  const { receipt } = await completeAll(erin);
  const oldSnapshot = JSON.stringify(receipt.snapshot);
  const invite = await createInvite(erin, receipt.receiptNo);
  const session = await validateInvite(invite.token);
  const created = await request('POST', '/api/review/objections', {
    headers: reviewHeaders(session),
    body: { step: 0, field: 'phone', reason: '手机号需要更正为新号码', idempotencyKey: randomPageId() },
  });
  const objectionId = created.data.objection.id;

  const accepted = await request('POST', `/api/reviews/objections/${objectionId}/accept`, auth(erin, { body: {} }));
  assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.createdCorrection, true);
  assert.equal(accepted.data.objection.status, 'accepted');
  assert.equal(accepted.data.workflow.sourceReceiptNo, receipt.receiptNo);
  assert.equal(accepted.data.workflow.sequence, 2);

  // 重复接受：已处理，且当前已有进行中的更正
  const twice = await request('POST', `/api/reviews/objections/${objectionId}/accept`, auth(erin, { body: {} }));
  assert.equal(twice.status, 409);
  assert.equal(twice.data.error.code, 'OBJECTION_ALREADY_HANDLED');
  assert.equal(twice.data.objection.status, 'accepted');

  // 接受另一条异议时复用同一份进行中的同源更正（不再新建）
  const created2 = await request('POST', '/api/review/objections', {
    headers: reviewHeaders(session),
    body: { step: 3, field: 'contactTime', reason: '联系时间需要调整', idempotencyKey: randomPageId() },
  });
  const accept2 = await request('POST', `/api/reviews/objections/${created2.data.objection.id}/accept`, auth(erin, { body: {} }));
  assert.equal(accept2.status, 200);
  assert.equal(accept2.data.createdCorrection, false);
  assert.equal(accept2.data.workflow.id, accepted.data.workflow.id);

  // 原回执内容仍固定不变
  const oldRow = await request('GET', `/api/receipts/${encodeURIComponent(receipt.receiptNo)}`, auth(erin));
  assert.equal(JSON.stringify(oldRow.data.receipt.snapshot), oldSnapshot);

  // 完成更正：新回执，异议回填新回执编号
  const corrected = PAYLOADS.map((p, i) => (i === 0 ? { ...p, phone: '13900139000' } : p));
  const { receipt: newReceipt } = await completeAll(erin, corrected);
  assert.notEqual(newReceipt.receiptNo, receipt.receiptNo);

  const ownerList = await request('GET', '/api/reviews/objections', auth(erin));
  const objAfter = ownerList.data.objections.find((o) => o.id === objectionId);
  assert.equal(objAfter.status, 'accepted');
  assert.equal(objAfter.correctionReceiptNo, newReceipt.receiptNo);

  // 时间线：原回执 → 复核（异议已接受，关联新回执）→ 新回执
  const state = (await request('GET', '/api/state', auth(erin))).data;
  const reviewEntry = state.timeline.find((e) => e.kind === 'review');
  const acceptedObj = reviewEntry.objections.find((o) => o.id === objectionId);
  assert.equal(acceptedObj.status, 'accepted');
  assert.equal(acceptedObj.correctionReceiptNo, newReceipt.receiptNo);
  const receiptNos = state.timeline.filter((e) => e.kind === 'receipt').map((e) => e.receiptNo);
  assert.deepEqual(receiptNos, [receipt.receiptNo, newReceipt.receiptNo]);

  // 复核人侧同样看到处理结果与新回执编号
  const ctx = await getContext(session);
  const reviewerObj = ctx.data.context.objections.find((o) => o.id === objectionId);
  assert.equal(reviewerObj.correctionReceiptNo, newReceipt.receiptNo);
});

test('同一条异议不能被两个会话同时处理：只有一个成功，另一个看到已处理', async () => {
  const carol = await login('carol');
  // carol 已在前面的用例完成首次办理并已完成更正；直接找一份有效回执
  const records = (await request('GET', '/api/receipts', auth(carol))).data.receipts;
  const target = records[records.length - 1];
  // carol 当前无进行中办理（上一用例已完成更正）
  const invite = await createInvite(carol, target.receiptNo);
  const session = await validateInvite(invite.token);
  const created = await request('POST', '/api/review/objections', {
    headers: reviewHeaders(session),
    body: { step: 0, field: 'name', reason: '并发处理测试：姓名用字需要核对', idempotencyKey: randomPageId() },
  });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const objectionId = created.data.objection.id;

  // 两个不同登录会话各自先加锁
  const carol2 = await login('carol');
  const lock1 = await request('POST', `/api/reviews/objections/${objectionId}/lock`, auth(carol, { body: {} }));
  assert.equal(lock1.status, 200);
  const lock2 = await request('POST', `/api/reviews/objections/${objectionId}/lock`, auth(carol2, { body: {} }));
  assert.equal(lock2.status, 409);
  assert.equal(lock2.data.error.code, 'OBJECTION_LOCKED_BY_OTHER');

  // 两个会话同时做终局决定：一个接受、一个驳回，只有一个成功
  const [acceptRes, rejectRes] = await Promise.all([
    request('POST', `/api/reviews/objections/${objectionId}/accept`, auth(carol, { body: {} })),
    request('POST', `/api/reviews/objections/${objectionId}/reject`, auth(carol2, {
      body: { reason: '并发驳回方的处理理由内容' },
    })),
  ]);
  const winner = acceptRes.status === 200 ? 'accept' : 'reject';
  const loser = winner === 'accept' ? rejectRes : acceptRes;
  assert.equal([acceptRes.status, rejectRes.status].filter((s) => s === 200).length, 1);
  assert.equal(loser.status, 409);
  assert.equal(loser.data.error.code, 'OBJECTION_ALREADY_HANDLED');
  assert.equal(loser.data.objection.status, winner === 'accept' ? 'accepted' : 'rejected');

  // 放弃因接受而创建的更正（若接受方获胜），异议应回到待处理；否则清理现场
  if (winner === 'accept') {
    const abandon = await request('POST', '/api/corrections?action=abandon', auth(carol, { body: {} }));
    assert.equal(abandon.status, 200, JSON.stringify(abandon.data));
    const reopened = (await request('GET', '/api/reviews/objections', auth(carol))).data.objections
      .find((o) => o.id === objectionId);
    assert.equal(reopened.status, 'open', '放弃更正后关联异议应重新打开');
  }
});

test('复核邀请、异议与处理结果在服务重启后仍保留', async () => {
  const bob = await login('bob');
  const records = (await request('GET', '/api/receipts', auth(bob))).data.receipts;
  const target = records[0];
  const invite = await createInvite(bob, target.receiptNo);
  const session = await validateInvite(invite.token);
  const created = await request('POST', '/api/review/objections', {
    headers: reviewHeaders(session),
    body: { step: 2, field: 'type', reason: '重启持久化测试：事项类型存疑', idempotencyKey: randomPageId() },
  });
  const objectionId = created.data.objection.id;
  await request('POST', `/api/reviews/objections/${objectionId}/reject`, auth(bob, {
    body: { reason: '重启前已驳回：事项类型核对无误' },
  }));

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
    assert.equal(stateRes.status, 200);
    const reviewEntries = state.timeline.filter((e) => e.kind === 'review');
    assert.ok(reviewEntries.length >= 1);
    const entry = reviewEntries.find((e) => e.invitationId === invite.invitation.id);
    assert.ok(entry, '重启后复核邀请仍在时间线中');
    assert.equal(entry.status, 'used');
    const obj = entry.objections.find((o) => o.id === objectionId);
    assert.ok(obj, '重启后异议仍在');
    assert.equal(obj.status, 'rejected');
    assert.match(obj.resolveReason, /重启前已驳回/);

    // 复核会话也持久化：重启后仍可凭 Cookie 读取上下文（邀请未过期）
    const ctxRes = await fetch(`${child.url}/api/review/context`, { headers: { Cookie: session.cookie } });
    assert.equal(ctxRes.status, 200, '复核会话在重启后仍有效');
    const ctxBody = await ctxRes.json();
    const reviewerObj = ctxBody.context.objections.find((o) => o.id === objectionId);
    assert.equal(reviewerObj.status, 'rejected');
  } finally {
    await stop(child);
  }
});

test('接受异议后放弃更正：异议回到待处理；同源更正被复用而不是重复创建', async () => {
  const dave = await login('dave');
  // 清理可能残留的进行中更正
  const state0 = (await request('GET', '/api/state', auth(dave))).data;
  if (state0.workflow && !state0.workflow.completed && state0.workflow.sourceReceiptNo) {
    await request('POST', '/api/corrections?action=abandon', auth(dave, { body: {} }));
  }
  const records = (await request('GET', '/api/receipts', auth(dave))).data.receipts;
  const receiptA = records[records.length - 1];
  const invite = await createInvite(dave, receiptA.receiptNo);
  const session = await validateInvite(invite.token);
  const created = await request('POST', '/api/review/objections', {
    headers: reviewHeaders(session),
    body: { step: 0, field: 'idNumber', reason: '证件号码末位有误需要更正', idempotencyKey: randomPageId() },
  });
  const accepted = await request('POST', `/api/reviews/objections/${created.data.objection.id}/accept`, auth(dave, { body: {} }));
  assert.equal(accepted.status, 200);

  // 更正进行中，再对同回执的新异议接受：应复用，不冲突
  const other = await request('POST', '/api/review/objections', {
    headers: reviewHeaders(session),
    body: { step: 1, field: 'city', reason: '城市名称需要更新', idempotencyKey: randomPageId() },
  });
  const acceptOther = await request('POST', `/api/reviews/objections/${other.data.objection.id}/accept`, auth(dave, { body: {} }));
  assert.equal(acceptOther.status, 200);
  assert.equal(acceptOther.data.createdCorrection, false);

  const abandon = await request('POST', '/api/corrections?action=abandon', auth(dave, { body: {} }));
  assert.equal(abandon.status, 200);
  const reopened = (await request('GET', '/api/reviews/objections', auth(dave))).data.objections
    .filter((o) => [created.data.objection.id, other.data.objection.id].includes(o.id));
  assert.equal(reopened.length, 2);
  assert.ok(reopened.every((o) => o.status === 'open'), '两条异议都应重新待处理');
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
