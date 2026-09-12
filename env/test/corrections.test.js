import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

process.env.DB_PATH = path.join(process.cwd(), 'data', `test-correction-${process.pid}.db`);
process.env.TOKEN_TTL_MS = '600000';
process.env.RECEIPT_SECRET = 'unit-test-correction-secret-fixed-value';
process.env.VERIFY_RATE_MAX = '100';
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

async function login(username) {
  const res = await request('POST', '/api/login', { body: { username, password: 'password123' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const cookies = res.headers.get('set-cookie');
  const sid = /sid=([^;]+)/.exec(cookies)[1];
  const csrf = /csrf=([^;]+)/.exec(cookies)[1];
  return { cookie: `sid=${sid}; csrf=${csrf}`, csrf: res.data.csrfToken };
}

function auth(client, extra = {}) {
  return { ...extra, headers: { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, ...(extra.headers || {}) } };
}

const PAYLOADS = [
  { name: '李四海', idNumber: 'IDNUMBER-SECRET-123', phone: '13800138000' },
  { province: '浙江省', city: '杭州市', detail: '西湖区机密巷 88 号' },
  { type: 'new', description: '' },
  { agreed: true, contactTime: '工作日' },
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

test('发起更正后：时间线展示来源关系，预览给出字段级差异且敏感字段遮罩', async () => {
  const alice = await login('alice');
  const { receipt } = await completeAll(alice);
  const oldNo = receipt.receiptNo;

  const correction = await request('POST', '/api/corrections', auth(alice, { body: { receiptNo: oldNo } }));
  assert.equal(correction.status, 200, JSON.stringify(correction.data));
  assert.equal(correction.data.workflow.sequence, 2);
  assert.equal(correction.data.workflow.sourceReceiptNo, oldNo);

  // 各步草稿已用原回执内容预填
  assert.equal(correction.data.workflow.steps[0].draft.phone, '13800138000');
  assert.equal(correction.data.workflow.steps[1].draft.detail, '西湖区机密巷 88 号');

  // 时间线：原始回执 → 更正中的草稿，来源关系与状态清晰
  const timeline = correction.data.timeline;
  assert.equal(timeline.length, 2);
  assert.equal(timeline[0].kind, 'receipt');
  assert.equal(timeline[0].receiptNo, oldNo);
  assert.equal(timeline[0].status, 'issued');
  assert.equal(timeline[0].correctedBy.length, 1);
  assert.equal(timeline[0].correctedBy[0].kind, 'correction');
  assert.equal(timeline[1].kind, 'correction');
  assert.equal(timeline[1].status, 'in_progress');
  assert.equal(timeline[1].sourceReceiptNo, oldNo);

  // 更正刚发起、尚未修改任何内容：全部字段未变更
  const initial = await request('GET', '/api/corrections/preview', auth(alice));
  assert.equal(initial.status, 200);
  assert.equal(initial.data.correction.sourceReceiptNo, oldNo);
  assert.equal(initial.data.correction.diff.summary.unchanged, 10);
  assert.equal(initial.data.correction.diff.summary.modified, 0);

  // 修改第 1 步草稿（手机号、证件号码）并确认；第 2 步原样确认
  const step0Draft = { ...PAYLOADS[0], phone: '13900139000', idNumber: 'NEWID-777' };
  let res = await request('POST', '/api/drafts', auth(alice, { body: { step: 0, draft: step0Draft } }));
  assert.equal(res.status, 200, JSON.stringify(res.data));
  let state = (await request('GET', '/api/state', auth(alice))).data;
  let result = await confirmCurrentStep(alice, state.workflow, step0Draft);
  result = await confirmCurrentStep(alice, result.workflow, PAYLOADS[1]);

  // 第 3 步：填写原本为空的“事项说明”（新增）
  res = await request('POST', '/api/drafts', auth(alice, { body: { step: 2, draft: { type: 'new', description: '补充说明内容' } } }));
  assert.equal(res.status, 200);
  result = await confirmCurrentStep(alice, result.workflow, { type: 'new', description: '补充说明内容' });

  // 第 4 步草稿：清空“方便联系的时间”（删除）
  res = await request('POST', '/api/drafts', auth(alice, { body: { step: 3, draft: { agreed: true, contactTime: '' } } }));
  assert.equal(res.status, 200);

  const preview = await request('GET', '/api/corrections/preview', auth(alice));
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  const { diff } = preview.data.correction;
  assert.equal(diff.summary.added, 1);
  assert.equal(diff.summary.modified, 2);
  assert.equal(diff.summary.deleted, 1);
  assert.equal(diff.summary.unchanged, 6);

  const byField = Object.fromEntries(diff.fields.map((f) => [f.field, f]));
  assert.equal(byField.phone.change, 'modified');
  assert.equal(byField.phone.before, '13800138000');
  assert.equal(byField.phone.after, '13900139000');
  assert.equal(byField.description.change, 'added');
  assert.equal(byField.description.after, '补充说明内容');
  assert.equal(byField.contactTime.change, 'deleted');
  assert.equal(byField.contactTime.before, '工作日');
  assert.equal(byField.contactTime.after, '');
  assert.equal(byField.name.change, 'unchanged');

  // 证件号码与详细地址在预览中只有遮罩内容
  assert.equal(byField.idNumber.masked, true);
  assert.equal(byField.detail.masked, true);
  assert.match(byField.idNumber.before, /^ID\*+23$/);
  assert.match(byField.idNumber.after, /^NE\*+77$/);
  assert.match(byField.detail.before, /^西湖\*+$/);
  const serialized = JSON.stringify(preview.data);
  assert.ok(!serialized.includes('IDNUMBER-SECRET-123'), '预览不得泄露原证件号码');
  assert.ok(!serialized.includes('NEWID-777'), '预览不得泄露新证件号码');
  assert.ok(!serialized.includes('机密巷'), '预览不得泄露详细地址');

  // /api/state 同样携带更正预览，页面刷新后直接可见
  state = (await request('GET', '/api/state', auth(alice))).data;
  assert.ok(state.correction, 'state 应包含更正预览');
  assert.equal(state.correction.diff.summary.modified, 2);
});

test('同一回执不能同时存在两份进行中的更正：并发发起只放行一个', async () => {
  const bob1 = await login('bob');
  const { receipt } = await completeAll(bob1);
  const oldNo = receipt.receiptNo;

  // 两个页面（两个登录会话）同时发起更正
  const bob2 = await login('bob');
  const [first, second] = await Promise.all([
    request('POST', '/api/corrections', auth(bob1, { body: { receiptNo: oldNo } })),
    request('POST', '/api/corrections', auth(bob2, { body: { receiptNo: oldNo } })),
  ]);
  const results = [first, second];
  const succeeded = results.filter((r) => r.status === 200);
  const failed = results.filter((r) => r.status === 409);
  assert.equal(succeeded.length, 1, '并发发起只能成功一个');
  assert.equal(failed.length, 1, '另一个必须明确失败');
  assert.equal(failed[0].data.error.code, 'CORRECTION_IN_PROGRESS');
  // 失败响应携带最新状态，调用方可直接重新读取
  assert.ok(Array.isArray(failed[0].data.timeline));
  assert.ok(failed[0].data.workflow);
  assert.equal(failed[0].data.timeline.filter((e) => e.kind === 'correction').length, 1);

  // 再次发起仍然被拒绝；时间线里始终只有一份进行中的更正
  const retry = await request('POST', '/api/corrections', auth(bob2, { body: { receiptNo: oldNo } }));
  assert.equal(retry.status, 409);
  assert.equal(retry.data.error.code, 'CORRECTION_IN_PROGRESS');
  const state = (await request('GET', '/api/state', auth(bob2))).data;
  assert.equal(state.timeline.filter((e) => e.kind === 'correction').length, 1);
});

test('更正草稿在重新登录与服务重启后仍保留，预览差异不丢失', async () => {
  const carol = await login('carol');
  const { receipt } = await completeAll(carol);
  const oldNo = receipt.receiptNo;

  await request('POST', '/api/corrections', auth(carol, { body: { receiptNo: oldNo } }));
  const draft = { ...PAYLOADS[0], phone: '13700137000' };
  const saved = await request('POST', '/api/drafts', auth(carol, { body: { step: 0, draft } }));
  assert.equal(saved.status, 200);

  // 重新登录（新会话）
  const carol2 = await login('carol');
  let state = (await request('GET', '/api/state', auth(carol2))).data;
  assert.equal(state.workflow.steps[0].draft.phone, '13700137000');
  assert.equal(state.correction.sourceReceiptNo, oldNo);
  assert.equal(state.correction.diff.summary.modified, 1);

  // 服务重启
  const child = await startRestartServer(process.env.DB_PATH);
  try {
    const loginRes = await fetch(`${child.url}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'carol', password: 'password123' }),
    });
    assert.equal(loginRes.status, 200);
    const cookies = loginRes.headers.getSetCookie();
    const sid = /sid=([^;]+)/.exec(cookies.find((c) => c.startsWith('sid=')))[1];
    const csrf = loginRes.headers.getSetCookie().find((c) => c.startsWith('csrf='));
    void csrf;
    const headers = { Cookie: `sid=${sid}` };
    const stateRes = await fetch(`${child.url}/api/state`, { headers });
    state = (await stateRes.json());
    assert.equal(stateRes.status, 200);
    assert.equal(state.workflow.status, 'open');
    assert.equal(state.workflow.steps[0].draft.phone, '13700137000', '重启后更正草稿仍在');
    assert.ok(state.correction, '重启后更正预览仍在');
    assert.equal(state.correction.sourceReceiptNo, oldNo);
    assert.equal(state.correction.diff.summary.modified, 1);
    const phoneField = state.correction.diff.fields.find((f) => f.field === 'phone');
    assert.equal(phoneField.change, 'modified');
    assert.equal(phoneField.after, '13700137000');
    assert.equal(state.timeline.filter((e) => e.kind === 'correction').length, 1);
  } finally {
    await stop(child);
  }
});

test('放弃更正不改变原回执，且可以重新发起', async () => {
  const dave = await login('dave');
  const { receipt } = await completeAll(dave);
  const oldNo = receipt.receiptNo;
  const snapshotBefore = JSON.stringify(receipt.snapshot);

  await request('POST', '/api/corrections', auth(dave, { body: { receiptNo: oldNo } }));
  const draft = { ...PAYLOADS[0], phone: '13600136000' };
  await request('POST', '/api/drafts', auth(dave, { body: { step: 0, draft } }));

  const abandoned = await request('POST', '/api/corrections?action=abandon', auth(dave, { body: {} }));
  assert.equal(abandoned.status, 200, JSON.stringify(abandoned.data));
  assert.equal(abandoned.data.sourceReceiptNo, oldNo);
  assert.equal(abandoned.data.correction, null);
  assert.equal(abandoned.data.workflow.completed, true, '放弃后回到已完成的原办理');
  assert.equal(abandoned.data.receipt.receiptNo, oldNo);
  assert.equal(abandoned.data.timeline.length, 1, '时间线中不再存在更正草稿');
  assert.equal(abandoned.data.timeline[0].correctedBy.length, 0);

  // 原回执内容、状态完全不变
  const oldReceipt = await request('GET', `/api/receipts/${encodeURIComponent(oldNo)}`, auth(dave));
  assert.equal(oldReceipt.status, 200);
  assert.equal(oldReceipt.data.receipt.status, 'issued');
  assert.equal(JSON.stringify(oldReceipt.data.receipt.snapshot), snapshotBefore);

  // 预览接口明确提示没有进行中的更正
  const preview = await request('GET', '/api/corrections/preview', auth(dave));
  assert.equal(preview.status, 404);
  assert.equal(preview.data.error.code, 'NO_CORRECTION_IN_PROGRESS');

  // 放弃后可以重新发起更正
  const again = await request('POST', '/api/corrections', auth(dave, { body: { receiptNo: oldNo } }));
  assert.equal(again.status, 200, JSON.stringify(again.data));
  assert.equal(again.data.workflow.sourceReceiptNo, oldNo);
});

test('新回执签发后：旧回执内容、核验结果与时间线关系保持不变', async () => {
  const erin = await login('erin');
  const { receipt } = await completeAll(erin);
  const oldNo = receipt.receiptNo;
  const oldCode = receipt.code;
  const oldSnapshot = JSON.stringify(receipt.snapshot);

  const verifyBefore = await request('POST', '/api/verify', { body: { receiptNo: oldNo, code: oldCode } });
  assert.equal(verifyBefore.status, 200);
  assert.equal(verifyBefore.data.receipt.applicant.phoneMasked, '138****8000');

  // 完成更正（修改手机号），签发新回执
  await request('POST', '/api/corrections', auth(erin, { body: { receiptNo: oldNo } }));
  const corrected = PAYLOADS.map((p, i) => (i === 0 ? { ...p, phone: '13900139000' } : p));
  const { receipt: newReceipt } = await completeAll(erin, corrected);
  assert.notEqual(newReceipt.receiptNo, oldNo);

  // 旧回执内容不变
  const oldAfter = await request('GET', `/api/receipts/${encodeURIComponent(oldNo)}`, auth(erin));
  assert.equal(oldAfter.status, 200);
  assert.equal(JSON.stringify(oldAfter.data.receipt.snapshot), oldSnapshot);
  assert.equal(oldAfter.data.receipt.code, oldCode);

  // 旧回执核验结果不变（仍是旧手机号的脱敏）
  const verifyAfter = await request('POST', '/api/verify', { body: { receiptNo: oldNo, code: oldCode } });
  assert.equal(verifyAfter.status, 200);
  assert.equal(verifyAfter.data.receipt.applicant.phoneMasked, '138****8000');

  // 时间线按办理顺序展示两份回执及来源关系；更正预览已关闭
  const state = (await request('GET', '/api/state', auth(erin))).data;
  assert.equal(state.correction, null);
  assert.equal(state.timeline.length, 2);
  const [first, second] = state.timeline;
  assert.equal(first.kind, 'receipt');
  assert.equal(first.receiptNo, oldNo);
  assert.equal(first.sequence, 1);
  assert.equal(first.correctedBy.length, 1);
  assert.equal(first.correctedBy[0].receiptNo, newReceipt.receiptNo);
  assert.equal(second.kind, 'receipt');
  assert.equal(second.receiptNo, newReceipt.receiptNo);
  assert.equal(second.sequence, 2);
  assert.equal(second.sourceReceiptNo, oldNo);
  assert.equal(second.status, 'issued');
});

async function startRestartServer(dbFile) {
  const child = spawn(process.execPath, [path.join(process.cwd(), 'src', 'server.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DB_PATH: dbFile,
      RECEIPT_SECRET: process.env.RECEIPT_SECRET,
      VERIFY_RATE_MAX: '100',
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
