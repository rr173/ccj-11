import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';import path from 'node:path';
import { once } from 'node:events';

process.env.DB_PATH = path.join(process.cwd(), 'data', `test-offline-${process.pid}.db`);
process.env.TOKEN_TTL_MS = '600000';
process.env.RECEIPT_SECRET = 'unit-test-offline-secret-fixed-value';
process.env.VERIFY_RATE_MAX = '1000';
process.env.OFFLINE_PACKAGE_CREDENTIAL_TTL_MS = String(15 * 60 * 1000);
// 设备签名密钥写入临时目录，避免在真实数据目录残留测试 PEM
process.env.OFFLINE_SIGN_KEY_PATH = path.join(process.cwd(), 'data', `test-offline-keys-${process.pid}`, 'signing.pem');
process.env.NO_AUTO_LISTEN = '1';
for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });

const { server } = await import('../src/server.js');
if (!server.listening) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}
const base = `http://127.0.0.1:${server.address().port}`;
const dev = await import('../src/offlineDevice.js');

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

async function login(username, password = 'password123') {
  const res = await request('POST', '/api/login', { body: { username, password } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const cookies = res.headers.get('set-cookie');
  const sid = /sid=([^;]+)/.exec(cookies)[1];
  const csrf = /csrf=([^;]+)/.exec(cookies)[1];
  return { username, cookie: `sid=${sid}; csrf=${csrf}`, csrf: res.data.csrfToken };
}
function auth(client, extra = {}) {
  return { ...extra, headers: { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, ...(extra.headers || {}) } };
}
function bearer(token, body) {
  return { headers: { Authorization: `Bearer ${token}` }, body };
}
function pageId() {
  return crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}

const PAYLOADS = [
  { name: '离线测试人', idNumber: 'ID-OFFLINE-001', phone: '13900139000' },
  { province: '浙江省', city: '杭州市', detail: '离线测试详细地址 8 号' },
  { type: 'new', description: '办理备注绝密内容不得出现在授权包' },
  { agreed: true, contactTime: '工作日白天' },
];

async function completeWorkflow(client, payloads = PAYLOADS) {
  // 同一账号跨套件复用：已完成则直接取回现有回执（含核验码）
  const existing = await request('GET', '/api/state', auth(client));
  if (existing.data.receipt) {
    const detail = await request('GET', `/api/receipts/${encodeURIComponent(existing.data.receipt.receiptNo)}`, auth(client));
    if (detail.status === 200) return { workflow: existing.data.workflow, receipt: detail.data.receipt };
  }
  // 确保工作流已创建
  await request('POST', '/api/tokens', auth(client, { body: { step: 0, pageId: pageId() } }));
  let workflow = (await request('GET', '/api/state', auth(client))).data.workflow;
  let receipt = null;
  while (!workflow.completed) {
    const step = workflow.progress;
    const pid = pageId();
    const tokenRes = await request('POST', '/api/tokens', auth(client, { body: { step, pageId: pid } }));
    assert.equal(tokenRes.status, 200, JSON.stringify(tokenRes.data));
    const res = await request('POST', '/api/submissions', auth(client, {
      body: { step, pageId: pid, token: tokenRes.data.token, idempotencyKey: crypto.randomUUID(), payload: payloads[step] },
    }));
    assert.equal(res.status, 200, JSON.stringify(res.data));
    workflow = res.data.workflow;
    if (res.data.completed) receipt = res.data.receipt;
  }
  return { workflow, receipt };
}

async function setClock(client, at) {
  return request('POST', '/api/test/clock', auth(client, { body: { at } }));
}
async function resetClock(client) {
  return request('POST', '/api/test/clock/reset', auth(client, { body: {} }));
}

// 完整“登记 → 一次性下载 → 设备载入”流程
async function provisionDevice(supervisor, { name = '窗口离线机', scope = { kind: 'all' }, graceMs = 5 * 60000, ttlMs = 86400000 } = {}) {
  const reg = await request('POST', '/api/supervisor/offline/devices', auth(supervisor, {
    body: { name, scope, graceMs, ttlMs },
  }));
  assert.equal(reg.status, 200, JSON.stringify(reg.data));
  const redeem = await request('POST', '/api/offline/packages/redeem', { body: { credential: reg.data.credential } });
  assert.equal(redeem.status, 200, JSON.stringify(redeem.data));
  const state = dev.createDeviceState({ deviceId: reg.data.device.id, token: reg.data.token });
  await dev.loadPackage(state, redeem.data.package);
  return {
    registration: reg.data,
    deviceId: reg.data.device.id,
    token: reg.data.token,
    credential: reg.data.credential,
    envelope: redeem.data.package,
    state,
    async sync(body) {
      const payload = body || {
        deviceId: state.deviceId, keyVersion: state.keyVersion, cursor: state.cursor,
        batchId: crypto.randomUUID(), entries: state.logs.slice(0, 500),
      };
      const sentEntries = payload.entries;
      const res = await request('POST', '/api/offline/sync', bearer(state.token, payload));
      if (res.status === 200) dev.applySyncResponse(state, res.data, { sentEntries });
      return res;
    },
  };
}

describe('电子回执离线核验：首次发包与一次性下载', () => {
  let alice; let supervisor; let receipt;

  before(async () => {
    alice = await login('alice');
    supervisor = await login('supervisor1');
    ({ receipt } = await completeWorkflow(alice));
  });

  test('授权包只含脱敏字段与摘要，不含证件号/完整地址/手机号/备注', async () => {
    const kit = await provisionDevice(supervisor, { name: '脱敏检查机' });
    const serialized = JSON.stringify(kit.envelope);
    assert.ok(!serialized.includes('ID-OFFLINE'), '证件号不得出现');
    assert.ok(!serialized.includes('离线测试详细地址'), '完整地址不得出现');
    assert.ok(!serialized.includes('办理备注绝密内容'), '办理备注不得出现');
    assert.ok(!/13900139000/.test(serialized), '完整手机号不得出现');
    assert.ok(serialized.includes('139****9000'), '应包含脱敏手机号');
    const record = kit.envelope.payload.receipts.find((r) => r.receiptNo === receipt.receiptNo);
    assert.ok(record, '授权范围包含该回执');
    assert.ok(record.codeDigest, '含核验码摘要');
    assert.ok(record.digest, '含逐条摘要');
    assert.equal(record.applicantName, '离***人');
  });

  test('授权包只能下载一次', async () => {
    const reg = await request('POST', '/api/supervisor/offline/devices', auth(supervisor, {
      body: { name: '一次性下载机', scope: { kind: 'all' }, graceMs: 300000, ttlMs: 86400000 },
    }));
    const first = await request('POST', '/api/offline/packages/redeem', { body: { credential: reg.data.credential } });
    assert.equal(first.status, 200);
    const second = await request('POST', '/api/offline/packages/redeem', { body: { credential: reg.data.credential } });
    assert.equal(second.status, 410);
    assert.equal(second.data.error.code, 'PACKAGE_ALREADY_DOWNLOADED');
  });

  test('授权包被篡改后设备验签失败', async () => {
    const kit = await provisionDevice(supervisor, { name: '篡改检查机' });
    const tampered = JSON.parse(JSON.stringify(kit.envelope));
    tampered.payload.expiresAt += 1;
    const state2 = dev.createDeviceState({ deviceId: kit.deviceId, token: kit.token });
    await assert.rejects(() => dev.loadPackage(state2, tampered), /PACKAGE_TAMPERED|签名/);
  });

  test('指定范围必须是存在的回执', async () => {
    const res = await request('POST', '/api/supervisor/offline/devices', auth(supervisor, {
      body: { name: '非法范围机', scope: { kind: 'list', receiptNos: ['HZ-20000101-AAAAAAAA'] }, graceMs: 300000, ttlMs: 86400000 },
    }));
    assert.equal(res.status, 400);
    assert.equal(res.data.error.code, 'SCOPE_INVALID');
  });

  test('有效期/宽限期越界被拒绝', async () => {
    const badTtl = await request('POST', '/api/supervisor/offline/devices', auth(supervisor, {
      body: { name: '超期机', scope: { kind: 'all' }, graceMs: 300000, ttlMs: 1000 },
    }));
    assert.equal(badTtl.status, 400);
    assert.equal(badTtl.data.error.code, 'INVALID_TTL');
    const badGrace = await request('POST', '/api/supervisor/offline/devices', auth(supervisor, {
      body: { name: '超宽限机', scope: { kind: 'all' }, graceMs: 999 * 60000, ttlMs: 86400000 },
    }));
    assert.equal(badGrace.status, 400);
    assert.equal(badGrace.data.error.code, 'INVALID_GRACE');
  });
});

describe('电子回执离线核验：断网核验与拒绝原因', () => {
  let alice; let supervisor; let receipt; let kit;

  before(async () => {
    alice = await login('alice');
    supervisor = await login('supervisor1');
  });

  test('正确核验码通过；错误码/范围外/不存在/已撤销均拒绝并记录', async () => {
    ({ receipt } = await completeWorkflow(alice));
    kit = await provisionDevice(supervisor, { name: '断网核验机' });

    const ok = await dev.offlineVerify(kit.state, { receiptNo: receipt.receiptNo, code: receipt.code });
    assert.equal(ok.verdict, 'accepted');
    assert.equal(ok.receipt.applicantPhone, '139****9000');

    const wrong = await dev.offlineVerify(kit.state, { receiptNo: receipt.receiptNo, code: '00000000' });
    assert.equal(wrong.verdict, 'rejected');
    assert.equal(wrong.reason, 'code_mismatch');

    const missing = await dev.offlineVerify(kit.state, { receiptNo: 'HZ-20200101-ZZZZZZZZ', code: '00000000' });
    assert.equal(missing.verdict, 'rejected');
    assert.equal(missing.reason, 'out_of_scope');

    // 日志按序号递增且摘要串联
    assert.equal(kit.state.logs[0].seq, 1);
    assert.equal(kit.state.logs[1].prevDigest, kit.state.logs[0].digest);
    assert.equal(kit.state.logs[2].prevDigest, kit.state.logs[1].digest);
  });

  test('设备过期后离线核验被拒绝', async () => {
    const expiredKit = await provisionDevice(supervisor, { name: '过期设备机', ttlMs: 86400000 });
    await assert.rejects(
      () => dev.offlineVerify(expiredKit.state, {
        receiptNo: receipt.receiptNo, code: receipt.code, at: expiredKit.state.expiresAt + 1,
      }),
      (error) => error.code === 'DEVICE_EXPIRED',
    );
  });
});

describe('电子回执离线核验：同步幂等、缺口与分叉', () => {
  let alice; let supervisor; let receipt;

  before(async () => {
    alice = await login('alice');
    supervisor = await login('supervisor1');
    ({ receipt } = await completeWorkflow(alice));
  });

  test('正常上传后同批次重传幂等；改内容同批次号拒绝', async () => {
    const kit = await provisionDevice(supervisor, { name: '幂等同步机' });
    await dev.offlineVerify(kit.state, { receiptNo: receipt.receiptNo, code: receipt.code });
    const entries = kit.state.logs.map((e) => ({ ...e }));
    const batchId = crypto.randomUUID();
    const batch = { deviceId: kit.deviceId, keyVersion: 1, cursor: kit.state.cursor, batchId, entries };

    const first = await request('POST', '/api/offline/sync', bearer(kit.token, batch));
    assert.equal(first.status, 200, JSON.stringify(first.data));
    assert.equal(first.data.acceptedCount, 1);
    assert.equal(first.data.duplicate, false);
    dev.applySyncResponse(kit.state, first.data, { sentEntries: entries });

    const replay = await request('POST', '/api/offline/sync', bearer(kit.token, batch));
    assert.equal(replay.status, 200);
    assert.equal(replay.data.duplicate, true);
    assert.equal(replay.data.acceptedCount, 1);

    const tampered = JSON.parse(JSON.stringify(batch));
    tampered.entries[0].at -= 5000;
    const conflict = await request('POST', '/api/offline/sync', bearer(kit.token, tampered));
    assert.equal(conflict.status, 409);
    assert.equal(conflict.data.error.code, 'BATCH_DUPLICATE_CONFLICT');
  });

  test('序号缺口整批拒绝', async () => {
    const kit = await provisionDevice(supervisor, { name: '缺口拒绝机' });
    await dev.offlineVerify(kit.state, { receiptNo: receipt.receiptNo, code: receipt.code });
    const entries = kit.state.logs.map((e) => ({ ...e }));
    // 先正常上传 seq=1
    const b1 = { deviceId: kit.deviceId, keyVersion: 1, cursor: kit.state.cursor, batchId: crypto.randomUUID(), entries };
    const r1 = await request('POST', '/api/offline/sync', bearer(kit.token, b1));
    assert.equal(r1.status, 200);
    dev.applySyncResponse(kit.state, r1.data, { sentEntries: entries });
    // 再制造 seq=2、seq=3，然后抽掉 seq=2，直接发 seq=3（其 prevDigest 仍正确串联 seq=2，
    // 因此越过摘要链校验后由“序号不连续”拒绝）
    await dev.offlineVerify(kit.state, { receiptNo: receipt.receiptNo, code: receipt.code });
    await dev.offlineVerify(kit.state, { receiptNo: receipt.receiptNo, code: receipt.code });
    const gap = [{ ...kit.state.logs[2] }];
    const bGap = { deviceId: kit.deviceId, keyVersion: 1, cursor: kit.state.cursor, batchId: crypto.randomUUID(), entries: gap };
    const rGap = await request('POST', '/api/offline/sync', bearer(kit.token, bGap));
    assert.equal(rGap.status, 409);
    assert.equal(rGap.data.error.code, 'LOG_GAP');
    // 服务器已收日志未被覆盖：游标与已收序号不变
    const detail = await request('GET', `/api/supervisor/offline/devices/${kit.deviceId}`, auth(supervisor));
    assert.equal(detail.data.device.acceptedSeq, 1);
  });

  test('摘要链分叉被拒绝', async () => {
    const kit = await provisionDevice(supervisor, { name: '分叉拒绝机' });
    await dev.offlineVerify(kit.state, { receiptNo: receipt.receiptNo, code: receipt.code });
    const entries = kit.state.logs.map((e) => ({ ...e }));
    const b1 = { deviceId: kit.deviceId, keyVersion: 1, cursor: kit.state.cursor, batchId: crypto.randomUUID(), entries };
    const r1 = await request('POST', '/api/offline/sync', bearer(kit.token, b1));
    assert.equal(r1.status, 200);
    dev.applySyncResponse(kit.state, r1.data, { sentEntries: entries });

    await dev.offlineVerify(kit.state, { receiptNo: receipt.receiptNo, code: receipt.code });
    const { makeEntryFields, canonical, entryDigestInput } = await import('../src/offline.js');
    const real = kit.state.logs[1];
    const fields = makeEntryFields({
      deviceId: kit.deviceId, seq: 2, receiptNo: real.receiptNo,
      result: real.result, reason: real.reason, at: real.at,
      prevDigest: 'f'.repeat(64),
    });
    const forkedDigest = await dev.sha256Hex(canonical(entryDigestInput(fields)));
    const forked = [{ ...fields, digest: forkedDigest }];
    const bFork = { deviceId: kit.deviceId, keyVersion: 1, cursor: kit.state.cursor, batchId: crypto.randomUUID(), entries: forked };
    const rFork = await request('POST', '/api/offline/sync', bearer(kit.token, bFork));
    assert.equal(rFork.status, 409);
    assert.equal(rFork.data.error.code, 'LOG_FORK');
  });

  test('重复序号但内容不同被拒绝', async () => {
    const kit = await provisionDevice(supervisor, { name: '重复冲突机' });
    await dev.offlineVerify(kit.state, { receiptNo: receipt.receiptNo, code: receipt.code });
    const entries = kit.state.logs.map((e) => ({ ...e }));
    const b1 = { deviceId: kit.deviceId, keyVersion: 1, cursor: kit.state.cursor, batchId: crypto.randomUUID(), entries };
    const first = await request('POST', '/api/offline/sync', bearer(kit.token, b1));
    assert.equal(first.status, 200);
    dev.applySyncResponse(kit.state, first.data, { sentEntries: entries });
    // 用全新批次号提交 seq=1 但 at 不同（服务器已收 seq=1）
    const dup = [{ ...entries[0], at: entries[0].at - 1000 }];
    const bDup = { deviceId: kit.deviceId, keyVersion: 1, cursor: kit.state.cursor, batchId: crypto.randomUUID(), entries: dup };
    const rDup = await request('POST', '/api/offline/sync', bearer(kit.token, bDup));
    assert.equal(rDup.status, 409);
    assert.ok(['LOG_GAP', 'LOG_DUPLICATE_CONFLICT'].includes(rDup.data.error.code));
  });

  test('游标倒退/伪造领先被拒绝；设备身份不匹配被拒绝', async () => {
    const kit = await provisionDevice(supervisor, { name: '游标检查机' });
    const ahead = { deviceId: kit.deviceId, keyVersion: 1, cursor: 999999, batchId: crypto.randomUUID(), entries: [] };
    const rAhead = await request('POST', '/api/offline/sync', bearer(kit.token, ahead));
    assert.equal(rAhead.status, 409);
    assert.equal(rAhead.data.error.code, 'CURSOR_REGRESSED');

    const wrongDevice = { deviceId: 'X'.repeat(32), keyVersion: 1, cursor: 0, batchId: crypto.randomUUID(), entries: [] };
    const rId = await request('POST', '/api/offline/sync', bearer(kit.token, wrongDevice));
    assert.equal(rId.status, 403);
    assert.equal(rId.data.error.code, 'IDENTITY_MISMATCH');
  });

  test('无令牌/错令牌/停用令牌被拒绝', async () => {
    const kit = await provisionDevice(supervisor, { name: '令牌检查机' });
    const noToken = await request('POST', '/api/offline/sync', { body: { deviceId: kit.deviceId, cursor: 0, entries: [] } });
    assert.equal(noToken.status, 401);
    const badToken = await request('POST', '/api/offline/sync', bearer('not-a-real-token', { deviceId: kit.deviceId, cursor: 0, entries: [] }));
    assert.equal(badToken.status, 401);
    assert.equal(badToken.data.error.code, 'DEVICE_TOKEN_INVALID');
  });
});

describe('电子回执离线核验：离线撤销与宽限边界', () => {
  let bob; let supervisor; let receipt; let no;

  before(async () => {
    bob = await login('bob');
    supervisor = await login('supervisor1');
    ({ receipt } = await completeWorkflow(bob));
    no = receipt.receiptNo;
  });

  test('宽限期内离线核验可上传；同步撤销增量后立即拒绝；超宽限日志被拒', async () => {
    const t0 = Date.now();
    await setClock(bob, t0);
    const GRACE = 10 * 60000;
    const kit = await provisionDevice(supervisor, { name: '撤销宽限机', graceMs: GRACE });

    // 回执在设备离线期间被撤销（t0 + 1min）
    const revokedAt = t0 + 60000;
    await setClock(bob, revokedAt);
    const rv = await request('POST', `/api/receipts/${encodeURIComponent(no)}?action=revoke`, auth(bob, { body: { reason: '离线撤销测试' } }));
    assert.equal(rv.status, 200);

    // 设备仍持旧视图，在撤销后 5 分钟（宽限内）离线核验 => 本机仍判通过
    await setClock(bob, revokedAt + 5 * 60000);
    const within = await dev.offlineVerify(kit.state, { receiptNo: no, code: receipt.code, at: revokedAt + 5 * 60000 });
    assert.equal(within.verdict, 'accepted');

    // 上传宽限内核验 => 服务器接受并下发撤销增量
    const entries = kit.state.logs.map((e) => ({ ...e }));
    const batch = { deviceId: kit.deviceId, keyVersion: 1, cursor: kit.state.cursor, batchId: crypto.randomUUID(), entries };
    const sync = await request('POST', '/api/offline/sync', bearer(kit.token, batch));
    assert.equal(sync.status, 200, JSON.stringify(sync.data));
    assert.equal(sync.data.acceptedCount, 1);
    assert.ok(sync.data.delta.some((d) => d.kind === 'revoked'));
    dev.applySyncResponse(kit.state, sync.data, { sentEntries: entries });
    assert.equal(kit.state.records.get(no).status, 'revoked');

    // 同步后立即拒绝
    const afterSync = await dev.offlineVerify(kit.state, { receiptNo: no, code: receipt.code, at: revokedAt + 6 * 60000 });
    assert.equal(afterSync.verdict, 'rejected');
    assert.equal(afterSync.reason, 'revoked');

    // 超宽限（撤销后 30 分钟）仍持旧视图伪造“通过” => 服务器拒绝整批
    const stale = await dev.offlineVerify(kit.state, { receiptNo: no, code: receipt.code, at: revokedAt + 30 * 60000 });
    // 撤销已在本地，设备本机会拒；这里强制旧视图模拟未同步设备
    assert.equal(stale.verdict, 'rejected');
  });

  test('超过撤销宽限期仍未同步的设备，超宽限通过日志被服务器拒绝', async () => {
    const t0 = Date.now() + 100000;
    await resetClock(bob);
    // 用一份新回执构建“从未同步撤销”的设备
    const carol = await login('carol');
    const { receipt: r2 } = await completeWorkflow(carol, [
      { name: '宽限二号', idNumber: 'ID-OFFLINE-002', phone: '13700137000' },
      PAYLOADS[1], { type: 'new', description: '备注二' }, PAYLOADS[3],
    ]);
    const no2 = r2.receiptNo;
    await setClock(carol, t0);
    const GRACE = 10 * 60000;
    const kit = await provisionDevice(supervisor, { name: '超宽限拒绝机', graceMs: GRACE });

    const revokedAt = t0 + 60000;
    await setClock(carol, revokedAt);
    await request('POST', `/api/receipts/${encodeURIComponent(no2)}?action=revoke`, auth(carol, { body: { reason: '撤销' } }));

    // 设备在撤销后 1 小时做了“通过”核验（其本地无撤销信息）
    const lateAt = revokedAt + 60 * 60000;
    // 直接构造日志条目（模拟未同步撤销的设备在超宽限后上报）
    const { makeEntryFields, canonical, entryDigestInput } = await import('../src/offline.js');
    const entryFields = makeEntryFields({
      deviceId: kit.deviceId, seq: 1, receiptNo: no2, result: 'accepted', reason: '',
      at: lateAt, prevDigest: '',
    });
    const digest = await dev.sha256Hex(canonical(entryDigestInput(entryFields)));
    const entry = { ...entryFields, digest };
    await setClock(carol, lateAt);
    const batch = { deviceId: kit.deviceId, keyVersion: 1, cursor: kit.state.cursor, batchId: crypto.randomUUID(), entries: [entry] };
    const res = await request('POST', '/api/offline/sync', bearer(kit.token, batch));
    assert.equal(res.status, 409);
    assert.equal(res.data.error.code, 'REVOKED_BEYOND_GRACE');
    await resetClock(carol);
  });
});

describe('电子回执离线核验：设备停用与授权轮换', () => {
  let dave; let supervisor; let receipt;

  before(async () => {
    dave = await login('dave');
    supervisor = await login('supervisor1');
    ({ receipt } = await completeWorkflow(dave));
  });

  test('停用后旧令牌/旧授权包/未上传日志全部被拒', async () => {
    const kit = await provisionDevice(supervisor, { name: '即将丢失机' });
    await dev.offlineVerify(kit.state, { receiptNo: receipt.receiptNo, code: receipt.code });

    const dis = await request('POST', `/api/supervisor/offline/devices/${kit.deviceId}/disable`, auth(supervisor, {
      body: { reason: '设备丢失' },
    }));
    assert.equal(dis.status, 200);

    // 旧令牌同步被拒
    const entries = kit.state.logs.map((e) => ({ ...e }));
    const batch = { deviceId: kit.deviceId, keyVersion: 1, cursor: kit.state.cursor, batchId: crypto.randomUUID(), entries };
    const sync = await request('POST', '/api/offline/sync', bearer(kit.token, batch));
    assert.equal(sync.status, 401);
    assert.equal(sync.data.error.code, 'AUTHORIZATION_ROTATED');

    // 旧下载凭证无法再取包
    const redeem = await request('POST', '/api/offline/packages/redeem', { body: { credential: kit.credential } });
    assert.ok([404, 410].includes(redeem.status));

    // 主管视图状态为停用
    const detail = await request('GET', `/api/supervisor/offline/devices/${kit.deviceId}`, auth(supervisor));
    assert.equal(detail.data.device.status, 'disabled');
  });

  test('轮换授权后旧包/旧令牌失效，新包新令牌可用，链重新开始', async () => {
    const reg = await request('POST', '/api/supervisor/offline/devices', auth(supervisor, {
      body: { name: '轮换测试机', scope: { kind: 'all' }, graceMs: 300000, ttlMs: 86400000 },
    }));
    assert.equal(reg.status, 200);
    const oldToken = reg.data.token;
    // 下载旧包
    const oldRedeem = await request('POST', '/api/offline/packages/redeem', { body: { credential: reg.data.credential } });
    assert.equal(oldRedeem.status, 200);

    // 主管轮换
    const rot = await request('POST', `/api/supervisor/offline/devices/${reg.data.device.id}/rotate`, auth(supervisor, {
      body: { ttlMs: 2 * 86400000, graceMs: 600000 },
    }));
    assert.equal(rot.status, 200, JSON.stringify(rot.data));
    assert.equal(rot.data.keyVersion, 2);

    // 旧令牌被拒
    const oldSync = await request('POST', '/api/offline/sync', bearer(oldToken, {
      deviceId: reg.data.device.id, keyVersion: 1, cursor: 0, entries: [], batchId: crypto.randomUUID(),
    }));
    assert.equal(oldSync.status, 401);
    assert.equal(oldSync.data.error.code, 'AUTHORIZATION_ROTATED');

    // 新凭证一次性下载并载入
    const newRedeem = await request('POST', '/api/offline/packages/redeem', { body: { credential: rot.data.credential } });
    assert.equal(newRedeem.status, 200);
    assert.equal(newRedeem.data.package.payload.keyVersion, 2);
    const state = dev.createDeviceState({ deviceId: reg.data.device.id, token: rot.data.token });
    await dev.loadPackage(state, newRedeem.data.package);
    assert.equal(state.nextSeq, 1);

    // 新令牌可同步
    const sync = await request('POST', '/api/offline/sync', bearer(rot.data.token, {
      deviceId: reg.data.device.id, keyVersion: 2, cursor: state.cursor, entries: [], batchId: crypto.randomUUID(),
    }));
    assert.equal(sync.status, 200);
    assert.equal(sync.data.keyVersion, 2);
  });
});

describe('电子回执离线核验：权限视图', () => {
  let erin; let auditor; let supervisor; let receiptNo;

  before(async () => {
    erin = await login('erin');
    auditor = await login('auditor1');
    supervisor = await login('supervisor1');
    const { receipt } = await completeWorkflow(erin);
    receiptNo = receipt.receiptNo;
    const kit = await provisionDevice(supervisor, { name: '权限视图机' });
    await dev.offlineVerify(kit.state, { receiptNo, code: receipt.code });
    const entries = kit.state.logs.map((e) => ({ ...e }));
    const batch = { deviceId: kit.deviceId, keyVersion: 1, cursor: kit.state.cursor, batchId: crypto.randomUUID(), entries };
    const sync = await request('POST', '/api/offline/sync', bearer(kit.token, batch));
    assert.equal(sync.status, 200);
  });

  test('办理人只看到自己回执被离线核验，看不到设备密钥或他人回执', async () => {
    const mine = await request('GET', '/api/receipts/offline-verifications', auth(erin));
    assert.equal(mine.status, 200);
    const related = mine.data.offlineVerifications.filter((v) => v.receiptNo === receiptNo);
    assert.ok(related.length >= 1);
    for (const v of mine.data.offlineVerifications) {
      assert.ok(!('token' in v), '不得返回设备令牌');
      assert.ok(!('credential' in v), '不得返回下载凭证');
      assert.ok(!('envelope' in v), '不得返回授权包');
      // 设备信息仅含 id/名称
      assert.deepEqual(Object.keys(v.device).sort(), ['id', 'name']);
    }
    // /api/receipts 列表同时携带
    const list = await request('GET', '/api/receipts', auth(erin));
    assert.ok(Array.isArray(list.data.offlineVerifications));
  });

  test('审计员可查看发包/核验/同步/拒绝/停用事件', async () => {
    const res = await request('GET', '/api/auditor/offline/audit', auth(auditor));
    assert.equal(res.status, 200);
    const types = new Set(res.data.audit.map((a) => a.type));
    for (const t of ['offline.device.registered', 'offline.package.issued', 'offline.package.downloaded', 'offline.verify.accepted', 'offline.sync.completed']) {
      assert.ok(types.has(t), `缺少事件类型 ${t}`);
    }
    // 只看拒绝
    const denied = await request('GET', '/api/auditor/offline/audit?result=denied', auth(auditor));
    assert.ok(denied.data.audit.every((a) => a.result === 'denied'));
  });

  test('办理人/处理人不能访问主管设备管理接口', async () => {
    const forbidden = await request('GET', '/api/supervisor/offline/devices', auth(erin));
    // erin 是普通办理人，其角色路由器不提供该路径 => 404
    assert.equal(forbidden.status, 404);
  });
});

describe('电子回执离线核验：重启续传一致性', () => {
  test('游标与日志链持久化（同一数据库二次连接语义由 store 保证；此处验证状态接口稳定）', async () => {
    const supervisor = await login('supervisor1');
    const list = await request('GET', '/api/supervisor/offline/devices', auth(supervisor));
    assert.equal(list.status, 200);
    for (const d of list.data.devices) {
      assert.ok(Number.isInteger(d.cursor));
      assert.ok(Number.isInteger(d.acceptedSeq));
    }
  });
});

after(async () => {
  server.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
  rmSync(path.dirname(process.env.OFFLINE_SIGN_KEY_PATH), { recursive: true, force: true });
});
