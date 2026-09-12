import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

process.env.DB_PATH = path.join(process.cwd(), 'data', `test-receipt-${process.pid}.db`);
process.env.TOKEN_TTL_MS = '600000';
process.env.RECEIPT_SECRET = 'unit-test-receipt-secret-fixed-value';
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
  return {
    cookie: `sid=${sid}; csrf=${csrf}`,
    csrf: res.data.csrfToken,
  };
}

function auth(client, extra = {}) {
  return { ...extra, headers: { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, ...(extra.headers || {}) } };
}

const PAYLOADS = [
  { name: '张三丰', idNumber: 'ID-SECRET-99', phone: '13800138000' },
  { province: '广东省', city: '深圳市', detail: '科技园路 100 号机密大厦' },
  { type: 'new', description: '回执测试事项' },
  { agreed: true, contactTime: '工作日' },
];

function randomPageId() {
  return crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}

async function completeAll(client) {
  let workflow;
  const stateRes = await request('GET', '/api/state', auth(client));
  workflow = stateRes.data.workflow;
  while (!workflow.completed) {
    const step = workflow.progress;
    const pageId = randomPageId();
    const tokenRes = await request('POST', '/api/tokens', auth(client, { body: { step, pageId } }));
    assert.equal(tokenRes.status, 200, JSON.stringify(tokenRes.data));
    const res = await request('POST', '/api/submissions', auth(client, {
      body: { step, pageId, token: tokenRes.data.token, idempotencyKey: crypto.randomUUID(), payload: PAYLOADS[step] },
    }));
    assert.equal(res.status, 200, JSON.stringify(res.data));
    workflow = res.data.workflow;
    if (res.data.completed) return { workflow, receipt: res.data.receipt };
  }
  const state = await request('GET', '/api/state', auth(client));
  return { workflow: state.data.workflow, receipt: state.data.receipt };
}

test('四步全部确认成功后生成唯一回执编号与核验码，内容固定且包含各步信息', async () => {
  const dave = await login('dave');
  const { receipt, workflow } = await completeAll(dave);
  assert.ok(receipt, '最终响应应携带回执');
  assert.match(receipt.receiptNo, /^HZ-\d{8}-[0-9A-Z]{8}$/);
  assert.match(receipt.code, /^[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/);
  assert.equal(receipt.status, 'issued');
  assert.ok(receipt.completedAt);
  assert.equal(receipt.completedAt, workflow.completedAt);
  assert.equal(receipt.snapshot.steps.length, 4);
  assert.ok(receipt.snapshot.steps.every((s) => s.confirmedAt && s.data));
  assert.equal(receipt.snapshot.applicantName, '张三丰');
  assert.equal(receipt.snapshot.matter.typeLabel, '新办');

  // 重新读取状态：同一份回执，不生成第二份
  const state = await request('GET', '/api/state', auth(dave));
  assert.equal(state.data.receipt.receiptNo, receipt.receiptNo);
  const list = await request('GET', '/api/receipts', auth(dave));
  assert.equal(list.data.receipts.length, 1);
  assert.equal(list.data.receipts[0].receiptNo, receipt.receiptNo);
});

test('最后一步网络重试（同一幂等键）返回同一份回执，不产生第二份', async () => {
  const erin = await login('erin');
  // 先完成前三步
  for (let step = 0; step < 3; step += 1) {
    const pageId = randomPageId();
    const t = (await request('POST', '/api/tokens', auth(erin, { body: { step, pageId } }))).data.token;
    const res = await request('POST', '/api/submissions', auth(erin, {
      body: { step, pageId, token: t, idempotencyKey: crypto.randomUUID(), payload: PAYLOADS[step] },
    }));
    assert.equal(res.status, 200, JSON.stringify(res.data));
  }
  const s = (await request('GET', '/api/state', auth(erin))).data.workflow;
  assert.equal(s.progress, 3);
  const pageId = randomPageId();
  const t = (await request('POST', '/api/tokens', auth(erin, { body: { step: 3, pageId } }))).data.token;
  const key = crypto.randomUUID();
  const first = await request('POST', '/api/submissions', auth(erin, {
    body: { step: 3, pageId, token: t, idempotencyKey: key, payload: PAYLOADS[3] },
  }));
  assert.equal(first.status, 200);
  assert.equal(first.data.completed, true);
  const second = await request('POST', '/api/submissions', auth(erin, {
    body: { step: 3, pageId, token: t, idempotencyKey: key, payload: PAYLOADS[3] },
  }));
  assert.equal(second.status, 200);
  assert.equal(second.data.replay, true);
  assert.equal(second.data.receipt.receiptNo, first.data.receipt.receiptNo);
  assert.equal(second.data.receipt.code, first.data.receipt.code);
  const list = await request('GET', '/api/receipts', auth(erin));
  assert.equal(list.data.receipts.length, 1);
});

test('不同办理人的回执编号互不相同', async () => {
  const dave = await login('dave');
  const erin = await login('erin');
  const noA = (await request('GET', '/api/state', auth(dave))).data.receipt.receiptNo;
  const noB = (await request('GET', '/api/state', auth(erin))).data.receipt.receiptNo;
  assert.notEqual(noA, noB);
});

test('已完成的回执不能退回修改、不能继续提交或保存草稿', async () => {
  const dave = await login('dave');
  const state = await request('GET', '/api/state', auth(dave));
  const version = state.data.workflow.version;

  const rollback = await request('POST', '/api/rollback', auth(dave, { body: { targetStep: 0, expectedVersion: version } }));
  assert.equal(rollback.status, 409);
  assert.equal(rollback.data.error.code, 'WORKFLOW_COMPLETED');
  assert.equal(rollback.data.workflow.progress, 4);

  const token = await request('POST', '/api/tokens', auth(dave, { body: { step: 0, pageId: randomPageId() } }));
  assert.equal(token.status, 409);
  assert.equal(token.data.error.code, 'WORKFLOW_COMPLETED');

  const draft = await request('POST', '/api/drafts', auth(dave, { body: { step: 0, draft: { name: '篡改' } } }));
  assert.equal(draft.status, 409);
});

test('回执访问需要登录且不能跨账号查看', async () => {
  const noAuth = await request('GET', '/api/receipts/HZ-20260101-AAAAAAAA/print');
  assert.equal(noAuth.status, 401);

  const dave = await login('dave');
  const erin = await login('erin');
  const daveNo = (await request('GET', '/api/state', auth(dave))).data.receipt.receiptNo;
  const cross = await request('GET', `/api/receipts/${encodeURIComponent(daveNo)}`, auth(erin));
  assert.equal(cross.status, 404);
  const crossDoc = await request('GET', `/api/receipts/${encodeURIComponent(daveNo)}/print`, auth(erin));
  assert.equal(crossDoc.status, 404);
});

test('本人可下载完整可打印回执，明确标注已完成', async () => {
  const dave = await login('dave');
  const no = (await request('GET', '/api/state', auth(dave))).data.receipt.receiptNo;
  const doc = await request('GET', `/api/receipts/${encodeURIComponent(no)}/print`, auth(dave));
  assert.equal(doc.status, 200);
  assert.match(doc.headers.get('content-type'), /text\/html/);
  assert.equal(doc.headers.get('cache-control'), 'no-store');
  assert.match(doc.text, /已完成/);
  assert.match(doc.text, new RegExp(no));
  // 本人文档包含完整申报内容
  assert.match(doc.text, /ID-SECRET-99/);
  assert.match(doc.text, /机密大厦/);
  assert.match(doc.text, /打印/);
});

test('免登录核验：编号不存在、核验码错误分别明确提示', async () => {
  const dave = await login('dave');
  const no = (await request('GET', '/api/state', auth(dave))).data.receipt.receiptNo;
  const code = (await request('GET', '/api/state', auth(dave))).data.receipt.code;

  const badNo = await request('POST', '/api/verify', { body: { receiptNo: 'HZ-20000101-ZZZZZZZZ', code } });
  assert.equal(badNo.status, 404);
  assert.equal(badNo.data.error.code, 'RECEIPT_NOT_FOUND');

  const badCode = await request('POST', '/api/verify', { body: { receiptNo: no, code: '0000-0000' } });
  assert.equal(badCode.status, 403);
  assert.equal(badCode.data.error.code, 'VERIFY_CODE_INVALID');

  const badInput = await request('POST', '/api/verify', { body: { receiptNo: 'abc', code: '1' } });
  assert.equal(badInput.status, 400);
});

test('免登录核验成功只展示脱敏信息，不泄露证件号或完整地址', async () => {
  const dave = await login('dave');
  const state = (await request('GET', '/api/state', auth(dave))).data;
  const no = state.receipt.receiptNo;
  const code = state.receipt.code;

  const ok = await request('POST', '/api/verify', { body: { receiptNo: no, code } });
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  const a = ok.data.receipt.applicant;
  assert.equal(a.nameMasked, '张*丰');
  assert.equal(a.phoneMasked, '138****8000');
  assert.equal(a.matter, '新办');
  assert.ok(a.completedAt);

  const serialized = JSON.stringify(ok.data);
  assert.ok(!serialized.includes('ID-SECRET-99'), '不得泄露证件号码');
  assert.ok(!serialized.includes('机密大厦'), '不得泄露完整地址');
  assert.ok(!serialized.includes('广东省'), '不得泄露省份');
  assert.ok(!/13800138000/.test(serialized), '不得泄露完整手机号');
});

test('免登录的脱敏回执文档也需核验码，且内容脱敏', async () => {
  const dave = await login('dave');
  const state = (await request('GET', '/api/state', auth(dave))).data;
  const no = state.receipt.receiptNo;
  const code = state.receipt.code.replace('-', '');

  const missing = await request('GET', `/api/public/receipts/${encodeURIComponent(no)}/print`);
  assert.equal(missing.status, 400);
  const wrong = await request('GET', `/api/public/receipts/${encodeURIComponent(no)}/print?code=00000000`);
  assert.equal(wrong.status, 403);

  const doc = await request('GET', `/api/public/receipts/${encodeURIComponent(no)}/print?code=${code}`);
  assert.equal(doc.status, 200);
  assert.match(doc.text, /已完成/);
  assert.ok(!doc.text.includes('ID-SECRET-99'));
  assert.ok(!doc.text.includes('机密大厦'));
  assert.match(doc.text, /138\*\*\*\*8000/);
  assert.match(doc.text, /张\*丰/);
});

test('撤销后公开核验明确提示已撤销，本人仍可查档；撤销不可重复', async () => {
  const dave = await login('dave');
  const state = (await request('GET', '/api/state', auth(dave))).data;
  const no = state.receipt.receiptNo;
  const code = state.receipt.code;

  const revoked = await request('POST', `/api/receipts/${encodeURIComponent(no)}?action=revoke`, auth(dave, {
    body: { reason: '申请人申请作废' },
  }));
  assert.equal(revoked.status, 200);
  assert.equal(revoked.data.receipt.status, 'revoked');

  const verify = await request('POST', '/api/verify', { body: { receiptNo: no, code } });
  assert.equal(verify.status, 410);
  assert.equal(verify.data.error.code, 'RECEIPT_REVOKED');

  const doc = await request('GET', `/api/receipts/${encodeURIComponent(no)}/print`, auth(dave));
  assert.equal(doc.status, 200);
  assert.match(doc.text, /已撤销/);

  const again = await request('POST', `/api/receipts/${encodeURIComponent(no)}?action=revoke`, auth(dave, { body: {} }));
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, 'RECEIPT_ALREADY_REVOKED');
});

test('更正产生新的办理记录与新回执，原回执固定不变', async () => {
  const dave = await login('dave');
  const before = (await request('GET', '/api/state', auth(dave))).data;
  const oldNo = before.receipt.receiptNo;
  const oldSnapshot = JSON.stringify(before.receipt.snapshot);

  const correction = await request('POST', '/api/corrections', auth(dave, { body: { receiptNo: oldNo } }));
  assert.equal(correction.status, 200, JSON.stringify(correction.data));
  assert.equal(correction.data.workflow.progress, 0);
  assert.equal(correction.data.workflow.sequence, before.workflow.sequence + 1);
  assert.equal(correction.data.workflow.status, 'open');

  // 新记录四步内容不同（更正手机号）
  const correctedPayloads = PAYLOADS.map((p, i) => (i === 0 ? { ...p, phone: '13900139000' } : p));
  let workflow = correction.data.workflow;
  while (!workflow.completed) {
    const step = workflow.progress;
    const pageId = randomPageId();
    const t = (await request('POST', '/api/tokens', auth(dave, { body: { step, pageId } }))).data.token;
    const res = await request('POST', '/api/submissions', auth(dave, {
      body: { step, pageId, token: t, idempotencyKey: crypto.randomUUID(), payload: correctedPayloads[step] },
    }));
    assert.equal(res.status, 200, JSON.stringify(res.data));
    workflow = res.data.workflow;
    if (res.data.completed) {
      assert.notEqual(res.data.receipt.receiptNo, oldNo, '必须生成新回执编号');
      assert.match(res.data.receipt.code, /^[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/);
    }
  }

  const list = (await request('GET', '/api/receipts', auth(dave))).data.receipts;
  assert.equal(list.length, 2);

  // 原回执内容固定不变（包括旧手机号），状态仍为撤销
  const oldDoc = await request('GET', `/api/receipts/${encodeURIComponent(oldNo)}`, auth(dave));
  assert.equal(oldDoc.status, 200);
  assert.equal(oldDoc.data.receipt.status, 'revoked');
  assert.equal(JSON.stringify(oldDoc.data.receipt.snapshot), oldSnapshot);
  assert.equal(oldDoc.data.receipt.snapshot.applicantName, '张三丰');
});

test('服务重启后仍能查看、下载和核验同一份回执，核验码保持不变', async () => {
  const dbFile = process.env.DB_PATH;
  const pageId = randomPageId();
  void pageId;

  let child = await startRestartServer(dbFile);
  try {
    // 重启后 dave 重新登录即可看到最近一次办理的回执
    const loginRes = await fetch(`${child.url}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'dave', password: 'password123' }),
    });
    const loginData = await loginRes.json();
    assert.equal(loginRes.status, 200);
    const cookies = loginRes.headers.getSetCookie();
    const sid = /sid=([^;]+)/.exec(cookies.find((c) => c.startsWith('sid=')))[1];
    const headers = { Cookie: `sid=${sid}` };
    const stateRes = await fetch(`${child.url}/api/state`, { headers });
    const stateData = await stateRes.json();
    assert.equal(stateRes.status, 200);
    assert.equal(stateData.workflow.completed, true);
    assert.ok(stateData.receipt, '重启后回执仍在');
    assert.match(stateData.receipt.code, /^[0-9A-HJ-NP-TV-Z]{4}-[0-9A-HJ-NP-TV-Z]{4}$/);
    const { receiptNo, code } = stateData.receipt;

    const doc = await fetch(`${child.url}/api/receipts/${encodeURIComponent(receiptNo)}/print`, { headers });
    assert.equal(doc.status, 200);

    const verifyRes = await fetch(`${child.url}/api/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ receiptNo, code }),
    });
    const verifyData = await verifyRes.json();
    assert.equal(verifyRes.status, 200);
    assert.equal(verifyData.receipt.applicant.phoneMasked, '139****9000');

    await stop(child);
    child = null;
  } finally {
    if (child) await stop(child);
  }
});

test('核验接口按来源限流，超限明确返回 429', async () => {
  // 该用例放在最后：耗尽本机 IP 的核验额度
  for (let i = 0; i < 100; i += 1) {
    await request('POST', '/api/verify', { body: { receiptNo: 'HZ-20000101-ZZZZZZZZ', code: '0000-0000' } });
  }
  const limited = await request('POST', '/api/verify', { body: { receiptNo: 'HZ-20000101-ZZZZZZZZ', code: '0000-0000' } });
  assert.equal(limited.status, 429);
  assert.equal(limited.data.error.code, 'TOO_MANY_REQUESTS');
}, { timeout: 30000 });

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
