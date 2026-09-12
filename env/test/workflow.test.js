import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

process.env.DB_PATH = path.join(process.cwd(), 'data', `test-${process.pid}.db`);
process.env.TOKEN_TTL_MS = '1000';
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
  const data = text ? JSON.parse(text) : {};
  return { status: response.status, headers: response.headers, data };
}

async function login(username = 'alice') {
  const res = await request('POST', '/api/login', { body: { username, password: 'password123' } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const cookies = res.headers.get('set-cookie');
  const sid = /sid=([^;]+)/.exec(cookies)[1];
  const csrf = /csrf=([^;]+)/.exec(cookies)[1];
  return {
    cookie: `sid=${sid}; csrf=${csrf}`,
    csrf: res.data.csrfToken,
    workflow: res.data.workflow,
  };
}

function auth(client, extra = {}) {
  return { ...extra, headers: { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, ...(extra.headers || {}) } };
}

const PAYLOADS = [
  { name: '张三', idNumber: 'ID-001', phone: '13800138000' },
  { province: '广东省', city: '深圳市', detail: '科技园路 100 号' },
  { type: 'new', description: '测试事项' },
  { agreed: true, contactTime: '工作日' },
];

function randomPageId() {
  return crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}

async function state(client) {
  const res = await request('GET', '/api/state', auth(client));
  assert.equal(res.status, 200);
  return res.data.workflow;
}

async function claim(client, step, pageId = randomPageId()) {
  const res = await request('POST', '/api/tokens', auth(client, { body: { step, pageId } }));
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return { pageId, token: res.data.token, expiresAt: res.data.expiresAt };
}

async function submit(client, context, step, payload = PAYLOADS[step], idempotencyKey = crypto.randomUUID()) {
  return request('POST', '/api/submissions', auth(client, {
    body: { step, pageId: context.pageId, token: context.token, idempotencyKey, payload },
  }));
}

async function completeTo(client, targetProgress) {
  let workflow = await state(client);
  while (workflow.progress < targetProgress) {
    const step = workflow.progress;
    const context = await claim(client, step);
    const res = await submit(client, context, step);
    assert.equal(res.status, 200, JSON.stringify(res.data));
    workflow = res.data.workflow;
  }
  return workflow;
}

test('未登录不能读取或调用办理接口', async () => {
  assert.equal((await request('GET', '/api/state')).status, 401);
  assert.equal((await request('POST', '/api/submissions', { body: {} })).status, 401);
});

test('CSRF 缺失时变更请求被拒绝', async () => {
  const client = await login('bob');
  await resetWorkflowIfAhead(client, 0);
  const res = await request('POST', '/api/drafts', {
    headers: { Cookie: client.cookie, 'Content-Type': 'application/json' },
    body: { step: 0, draft: { name: 'x' } },
  });
  assert.equal(res.status, 403);
});

test('不能为非当前步骤领取令牌，也不能直接提交后续步骤', async () => {
  const client = await login('bob');
  await resetWorkflowIfAhead(client, 0);
  const tokenRes = await request('POST', '/api/tokens', auth(client, { body: { step: 1, pageId: randomPageId() } }));
  assert.equal(tokenRes.status, 409);
  assert.equal(tokenRes.data.error.code, 'STEP_NOT_CURRENT');

  const context = await claim(client, 0);
  const res = await request('POST', '/api/submissions', auth(client, {
    body: { step: 1, pageId: context.pageId, token: context.token, idempotencyKey: crypto.randomUUID(), payload: PAYLOADS[1] },
  }));
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, 'TOKEN_STEP_MISMATCH');
  assert.equal(res.data.workflow.progress, 0);
});

test('正常提交后只推进一次；令牌重放失败并返回服务端当前进度', async () => {
  const client = await login('bob');
  await resetWorkflowIfAhead(client, 0);
  const context = await claim(client, 0);
  const first = await submit(client, context, 0);
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.workflow.progress, 1);

  const replay = await submit(client, context, 0, PAYLOADS[0], crypto.randomUUID());
  assert.equal(replay.status, 409);
  assert.equal(replay.data.error.code, 'TOKEN_USED');
  assert.equal(replay.data.workflow.progress, 1);
});

test('网络重试使用同一幂等键不会重复生成确认或二次推进', async () => {
  const client = await login('bob');
  await resetWorkflowIfAhead(client, 0);
  const context = await claim(client, 0);
  const key = crypto.randomUUID();
  const first = await submit(client, context, 0, PAYLOADS[0], key);
  const second = await submit(client, context, 0, PAYLOADS[0], key);
  assert.equal(second.status, 200);
  assert.equal(second.data.replay, true);
  assert.equal(second.data.submissionId, first.data.submissionId);
  assert.equal(second.data.confirmation.confirmationNo, first.data.confirmation.confirmationNo);
  assert.equal(second.data.workflow.progress, 1);
});

test('令牌不能换页面或跨登录会话使用', async () => {
  const account = 'bob';
  await resetWorkflowIfAhead(await login(account), 0);
  const clientA = await login(account);
  const clientB = await login(account);
  const context = await claim(clientA, 0, randomPageId());
  const wrongPage = await request('POST', '/api/submissions', auth(clientA, {
    body: { step: 0, pageId: randomPageId(), token: context.token, idempotencyKey: crypto.randomUUID(), payload: PAYLOADS[0] },
  }));
  assert.equal(wrongPage.status, 409);
  assert.equal(wrongPage.data.error.code, 'TOKEN_PAGE_MISMATCH');

  const wrongSession = await request('POST', '/api/submissions', auth(clientB, {
    body: { step: 0, pageId: context.pageId, token: context.token, idempotencyKey: crypto.randomUUID(), payload: PAYLOADS[0] },
  }));
  assert.equal(wrongSession.status, 409);
  assert.equal(wrongSession.data.error.code, 'TOKEN_SESSION_MISMATCH');
});

test('令牌会过期，过期后明确失败', async () => {
  const client = await login('bob');
  await resetWorkflowIfAhead(client, 0);
  const context = await claim(client, 0);
  await new Promise((resolve) => setTimeout(resolve, 1100));
  const res = await submit(client, context, 0);
  assert.equal(res.status, 409);
  assert.equal(res.data.error.code, 'TOKEN_EXPIRED');
  assert.equal(res.data.workflow.progress, 0);
});

test('未完成草稿在重新读取进度时仍然存在', async () => {
  const client = await login('bob');
  await resetWorkflowIfAhead(client, 0);
  const draft = { name: '李草稿', idNumber: '', phone: '' };
  const saved = await request('POST', '/api/drafts', auth(client, { body: { step: 0, draft } }));
  assert.equal(saved.status, 200);
  const workflow = await state(client);
  assert.deepEqual(workflow.steps[0].draft, draft);
  assert.equal(workflow.steps[0].confirmed, null);
});

test('退回已确认步骤会使该步及后续确认失效，但保留内容为草稿', async () => {
  const client = await login('bob');
  await completeTo(client, 2);
  let workflow = await state(client);
  assert.equal(workflow.steps[0].status, 'confirmed');
  assert.equal(workflow.steps[1].status, 'confirmed');

  const rolled = await request('POST', '/api/rollback', auth(client, {
    body: { targetStep: 0, expectedVersion: workflow.version },
  }));
  assert.equal(rolled.status, 200, JSON.stringify(rolled.data));
  assert.equal(rolled.data.workflow.progress, 0);
  assert.equal(rolled.data.workflow.steps[0].status, 'current');
  assert.equal(rolled.data.workflow.steps[1].status, 'locked');
  assert.equal(rolled.data.workflow.steps[1].confirmed, null);
  assert.equal(rolled.data.workflow.steps[1].draft.city, '深圳市');

  workflow = await state(client);
  assert.equal(workflow.progress, 0);
});

test('同一人两个页面并发提交下一步，只允许一个成功', async () => {
  const client = await login('carol');
  await resetWorkflowIfAhead(client, 0);
  const pageA = randomPageId();
  const pageB = randomPageId();
  const tokenA = await request('POST', '/api/tokens', auth(client, { body: { step: 0, pageId: pageA } }));
  const tokenB = await request('POST', '/api/tokens', auth(client, { body: { step: 0, pageId: pageB } }));
  const [a, b] = await Promise.all([
    request('POST', '/api/submissions', auth(client, { body: { step: 0, pageId: pageA, token: tokenA.data.token, idempotencyKey: crypto.randomUUID(), payload: PAYLOADS[0] } })),
    request('POST', '/api/submissions', auth(client, { body: { step: 0, pageId: pageB, token: tokenB.data.token, idempotencyKey: crypto.randomUUID(), payload: PAYLOADS[0] } })),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const failed = [a, b].find((res) => res.status === 409);
  assert.equal(['CONCURRENT_PROGRESS_CHANGED', 'PROGRESS_MOVED'].includes(failed.data.error.code), true);
  assert.equal(failed.data.workflow.progress, 1);
});

test('完整办理最终完成，并持久化全部确认', async () => {
  const client = await login('bob');
  const workflow = await completeTo(client, 4);
  assert.equal(workflow.completed, true);
  assert.equal(workflow.progress, 4);
  assert.ok(workflow.steps.every((step) => step.status === 'confirmed'));
  const reread = await state(client);
  assert.equal(reread.completed, true);
  assert.equal(reread.steps[3].confirmed.agreed, true);
});

test('服务重启后进度、草稿、会话和令牌状态均保留，旧令牌不能重放', async () => {
  const dbFile = path.join(process.cwd(), 'data', `restart-${process.pid}.db`);
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true });
  const pageId = randomPageId();

  let server1 = await startRestartServer(dbFile);
  let server2 = null;
  try {
    let response = await fetch(`${server1.url}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'carol', password: 'password123' }),
    });
    let data = await response.json();
    assert.equal(response.status, 200);
    const cookies = response.headers.getSetCookie();
    const sid = /sid=([^;]+)/.exec(cookies.find((cookie) => cookie.startsWith('sid=')))[1];
    const csrf = data.csrfToken;
    const headers = {
      'Content-Type': 'application/json',
      Cookie: `sid=${sid}; csrf=${csrf}`,
      'X-CSRF-Token': csrf,
    };

    response = await fetch(`${server1.url}/api/drafts`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ step: 0, draft: { name: '重启草稿', idNumber: '', phone: '' } }),
    });
    assert.equal(response.status, 200);

    response = await fetch(`${server1.url}/api/tokens`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ step: 0, pageId }),
    });
    data = await response.json();
    assert.equal(response.status, 200);
    const tokenBeforeRestart = data.token;

    await stopRestartServer(server1);
    server1 = null;
    server2 = await startRestartServer(dbFile);

    response = await fetch(`${server2.url}/api/state`, { headers: { Cookie: `sid=${sid}` } });
    data = await response.json();
    assert.equal(response.status, 200);
    assert.equal(data.workflow.progress, 0);
    assert.equal(data.workflow.steps[0].draft.name, '重启草稿');

    const submission = {
      step: 0,
      pageId,
      token: tokenBeforeRestart,
      idempotencyKey: crypto.randomUUID(),
      payload: PAYLOADS[0],
    };
    response = await fetch(`${server2.url}/api/submissions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(submission),
    });
    data = await response.json();
    assert.equal(response.status, 200, JSON.stringify(data));
    assert.equal(data.workflow.progress, 1);

    response = await fetch(`${server2.url}/api/submissions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ...submission, idempotencyKey: crypto.randomUUID() }),
    });
    data = await response.json();
    assert.equal(response.status, 409);
    assert.equal(data.error.code, 'TOKEN_USED');
    assert.equal(data.workflow.progress, 1);

    await stopRestartServer(server2);
    server2 = null;
  } finally {
    if (server2) await stopRestartServer(server2);
    if (server1) await stopRestartServer(server1);
    for (const suffix of ['', '-wal', '-shm']) rmSync(`${dbFile}${suffix}`, { force: true });
  }
});

async function resetWorkflowIfAhead(client, target) {
  const workflow = await state(client);
  if (workflow.completed) return;
  if (workflow.progress > target) {
    const res = await request('POST', '/api/rollback', auth(client, {
      body: { targetStep: target, expectedVersion: workflow.version },
    }));
    assert.equal(res.status, 200, JSON.stringify(res.data));
  }
}

async function startRestartServer(dbFile) {
  const child = spawn(process.execPath, [path.join(process.cwd(), 'src', 'server.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DB_PATH: dbFile,
      PORT: '0',
      TOKEN_TTL_MS: '600000',
      NO_AUTO_LISTEN: '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const url = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Restart-test server did not start')), 5000);
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

async function stopRestartServer(running) {
  if (!running || running.child.exitCode !== null) return;
  running.child.kill('SIGTERM');
  await once(running.child, 'exit');
}

test.after(async () => {
  server.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
});
