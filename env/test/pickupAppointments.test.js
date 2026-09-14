import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

process.env.DB_PATH = path.join(process.cwd(), 'data', `test-pickup-${process.pid}.db`);
process.env.TOKEN_TTL_MS = '600000';
process.env.RECEIPT_SECRET = 'unit-test-pickup-secret-fixed-value';
process.env.PICKUP_CODE_SECRET = 'unit-test-pickup-code-secret-fixed-value';
process.env.PICKUP_GRACE_MS = String(15 * 60 * 1000);
process.env.VERIFY_RATE_MAX = '1000';
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

async function login(username, password = 'password123') {
  const res = await request('POST', '/api/login', { body: { username, password } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const cookies = res.headers.get('set-cookie');
  const sid = /sid=([^;]+)/.exec(cookies)[1];
  const csrf = /csrf=([^;]+)/.exec(cookies)[1];
  return {
    username,
    cookie: `sid=${sid}; csrf=${csrf}`,
    csrf: res.data.csrfToken,
    state: res.data,
  };
}

function auth(client, extra = {}) {
  return { ...extra, headers: { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, ...(extra.headers || {}) } };
}

const PAYLOADS = [
  { name: '王预约', idNumber: 'ID-SECRET-88', phone: '13800138000' },
  { province: '浙江省', city: '杭州市', detail: '文三路 99 号领取大厦' },
  { type: 'new', description: '线下领取预约模块测试事项' },
  { agreed: true, contactTime: '工作日白天' },
];

function randomPageId() {
  return crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}

async function completeWorkflow(client, payloads = PAYLOADS) {
  let workflow = (await request('GET', '/api/state', auth(client))).data.workflow;
  if (workflow.completed) {
    const receipt = (await request('GET', '/api/state', auth(client))).data.receipt;
    return { workflow, receipt };
  }
  while (!workflow.completed) {
    const step = workflow.progress;
    const pageId = randomPageId();
    const tokenRes = await request('POST', '/api/tokens', auth(client, { body: { step, pageId } }));
    assert.equal(tokenRes.status, 200, JSON.stringify(tokenRes.data));
    const res = await request('POST', '/api/submissions', auth(client, {
      body: { step, pageId, token: tokenRes.data.token, idempotencyKey: crypto.randomUUID(), payload: payloads[step] },
    }));
    assert.equal(res.status, 200, JSON.stringify(res.data));
    workflow = res.data.workflow;
    if (res.data.completed) return { workflow, receipt: res.data.receipt };
  }
  throw new Error('unreachable');
}

// 受控时钟：通过测试专用接口固定当前时间（只影响领取模块的窗口判定与过期扫描）
async function setClock(client, epochMs) {
  return request('POST', '/api/test/clock', auth(client, { body: { at: epochMs } }));
}
async function resetClock(client) {
  return request('POST', '/api/test/clock/reset', auth(client, { body: {} }));
}

const DAY = 24 * 60 * 60 * 1000;
const HOUR = 60 * 60 * 1000;
const GRACE = 15 * 60 * 1000;

async function createLocationAndSlots(admin, { capacity = 1, baseAt } = {}) {
  const locRes = await request('POST', '/api/supervisor/pickup/locations', auth(admin, {
    body: { name: '市民中心领取处', address: '杭州市西湖区文三路 88 号', note: '主管维护的网点' },
  }));
  assert.equal(locRes.status, 200, JSON.stringify(locRes.data));
  const locationId = locRes.data.location.id;
  const at = baseAt || Date.now();
  const slotDefs = [
    { startAt: at + 1 * DAY, endAt: at + 1 * DAY + 2 * HOUR, capacity },
    { startAt: at + 2 * DAY, endAt: at + 2 * DAY + 2 * HOUR, capacity: 3 },
  ];
  const slots = [];
  for (const def of slotDefs) {
    const res = await request('POST', `/api/supervisor/pickup/locations/${locationId}/slots`, auth(admin, { body: def }));
    assert.equal(res.status, 200, JSON.stringify(res.data));
    slots.push(res.data.slot);
  }
  return { locationId, location: locRes.data.location, slots };
}

async function book(client, receiptNo, slotId, note = '') {
  return request('POST', '/api/pickup/appointments', auth(client, { body: { receiptNo, slotId, note } }));
}

async function deliver(staff, appointmentNo, code, note = '') {
  return request('POST', '/api/pickup-delivery/confirm', auth(staff, {
    body: { appointmentNo, code, note },
  }));
}

// 用例间隔离：取消该账号名下所有进行中预约（释放名额），避免跨用例状态串扰
async function cleanupActive(client) {
  const list = await request('GET', '/api/pickup/appointments', auth(client));
  for (const appt of list.data.appointments || []) {
    if (appt.status === 'booked' || appt.status === 'rescheduled') {
      await request('POST', `/api/pickup/appointments/${appt.id}/cancel`, auth(client, {
        body: { reason: '用例间清理', expectedVersion: appt.version },
      }));
    }
  }
}

// 把预约/时间段/时钟拉到指定状态的辅助
async function fixedSlot(admin, { startAt, endAt, capacity = 5 }) {
  const locRes = await request('POST', '/api/supervisor/pickup/locations', auth(admin, {
    body: { name: `时钟网点 ${startAt}`, address: '时钟测试地址 1 号' },
  }));
  const res = await request('POST', `/api/supervisor/pickup/locations/${locRes.data.location.id}/slots`, auth(admin, {
    body: { startAt, endAt, capacity },
  }));
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.slot;
}

test('主管可以维护领取网点与时间段容量，办理人可预约并看到冻结信息与一次性领取码', async () => {
  const admin = await login('supervisor1');
  const alice = await login('alice');
  const { receipt } = await completeWorkflow(alice);
  const { slots, location } = await createLocationAndSlots(admin);

  const list = await request('GET', '/api/pickup/bookable-slots', auth(alice));
  assert.equal(list.status, 200);
  assert.ok(list.data.slots.some((s) => s.id === slots[0].id && s.remaining === 1));

  const res = await book(alice, receipt.receiptNo, slots[0].id, '本人到场');
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.match(res.data.pickupCode, /^[0-9A-HJ-NP-TV-Z]{5}-[0-9A-HJ-NP-TV-Z]{5}$/);
  assert.equal(res.data.codeShownOnce, true);
  const appt = res.data.appointment;
  assert.match(appt.appointmentNo, /^YY-\d{8}-[0-9A-Z]{8}$/);
  assert.equal(appt.frozen.locationName, '市民中心领取处');
  assert.equal(appt.frozen.locationAddress, '杭州市西湖区文三路 88 号');
  assert.equal(appt.frozen.capacityVersion, 1);

  // 列表与详情接口不再返回明文领取码
  const mine = await request('GET', '/api/pickup/appointments', auth(alice));
  assert.equal(mine.status, 200);
  assert.ok(!JSON.stringify(mine.data).includes(res.data.pickupCode));
  assert.equal(mine.data.appointments[0].pickupCode, undefined);
  const detail = await request('GET', `/api/pickup/appointments/${appt.id}`, auth(alice));
  assert.equal(detail.data.appointment.pickupCode, undefined);
  // 容量已原子扣减
  assert.equal(mine.data.slots.find((s) => s.id === slots[0].id).occupied, 1);
  assert.equal(mine.data.slots.find((s) => s.id === slots[0].id).remaining, 0);

  // 非本人看不到预约；主管可以看到占用
  const bob = await login('bob');
  const otherDetail = await request('GET', `/api/pickup/appointments/${appt.id}`, auth(bob));
  assert.equal(otherDetail.status, 404);
  const adminList = await request('GET', '/api/supervisor/pickup/appointments', auth(admin));
  assert.ok(adminList.data.appointments.some((a) => a.appointmentNo === appt.appointmentNo));
  assert.equal(location.name, '市民中心领取处');
});

test('两个页面同时抢最后一个名额：恰好一个成功，另一个明确名额已满', async () => {
  const admin = await login('supervisor1');
  const { slots } = await createLocationAndSlots(admin, { capacity: 1 });
  const carol = await login('carol');
  await cleanupActive(carol);
  const { receipt } = await completeWorkflow(carol);
  const carol2 = await login('carol');

  const [a, b] = await Promise.all([
    book(carol, receipt.receiptNo, slots[0].id),
    book(carol2, receipt.receiptNo, slots[0].id),
  ]);
  const ok = [a, b].filter((r) => r.status === 200);
  const fail = [a, b].filter((r) => r.status !== 200);
  assert.equal(ok.length, 1, '只能一个预约成功');
  assert.equal(fail.length, 1);
  // 同一回执已有进行中预约也可能先命中；两种失败都必须是明确的业务拒绝
  assert.ok(['SLOT_CAPACITY_FULL', 'ACTIVE_APPOINTMENT_EXISTS'].includes(fail[0].data.error.code),
    `实际失败码：${fail[0].data.error.code}`);

  // 名额账不超卖：占用 == 容量，剩余为 0
  const someone = await login('dave');
  const bookable = await request('GET', '/api/pickup/bookable-slots', auth(someone));
  const slot = bookable.data.slots.find((s) => s.id === slots[0].id);
  assert.equal(slot.occupied, 1);
  assert.equal(slot.remaining, 0);

  // 另一份回执再抢该满额时间段，必须得到名额已满
  await completeWorkflow(someone);
  const receipts = (await request('GET', '/api/receipts', auth(someone))).data.receipts;
  const denied = await book(someone, receipts[0].receiptNo, slots[0].id);
  assert.equal(denied.status, 409);
  assert.equal(denied.data.error.code, 'SLOT_CAPACITY_FULL');
});

test('预约冻结创建时信息：主管后改网点/容量版本，已有预约不被悄悄改掉', async () => {
  const admin = await login('supervisor1');
  const erin = await login('erin');
  await cleanupActive(erin);
  const { receipt } = await completeWorkflow(erin);
  const { slots, locationId } = await createLocationAndSlots(admin, { capacity: 5 });

  const res = await book(erin, receipt.receiptNo, slots[0].id);
  assert.equal(res.status, 200);
  const appt = res.data.appointment;
  assert.equal(appt.frozen.capacityVersion, 1);

  // 主管调整容量（容量版本 +1）并修改网点名称/地址
  const capRes = await request('POST', `/api/supervisor/pickup/slots/${slots[0].id}`, auth(admin, {
    body: { capacity: 9 },
  }));
  assert.equal(capRes.status, 200);
  assert.equal(capRes.data.slot.capacityVersion, 2);
  const locRes = await request('POST', `/api/supervisor/pickup/locations/${locationId}`, auth(admin, {
    body: { name: '市民中心领取处（搬迁后）', address: '杭州市滨江区江南大道 1 号' },
  }));
  assert.equal(locRes.status, 200);

  const detail = await request('GET', `/api/pickup/appointments/${appt.id}`, auth(erin));
  assert.equal(detail.status, 200);
  assert.equal(detail.data.appointment.frozen.locationName, '市民中心领取处');
  assert.equal(detail.data.appointment.frozen.locationAddress, '杭州市西湖区文三路 88 号');
  assert.equal(detail.data.appointment.frozen.capacityVersion, 1);
  // 已有人预约的时间段时间范围不能改
  const timeEdit = await request('POST', `/api/supervisor/pickup/slots/${slots[0].id}`, auth(admin, {
    body: { startAt: Date.now() + 3 * DAY, endAt: Date.now() + 3 * DAY + HOUR },
  }));
  assert.equal(timeEdit.status, 409);
  assert.equal(timeEdit.data.error.code, 'SLOT_TIME_LOCKED');
  // 容量不能调到低于占用
  const below = await request('POST', `/api/supervisor/pickup/slots/${slots[0].id}`, auth(admin, {
    body: { capacity: 0 },
  }));
  assert.equal(below.status, 400);
});

test('旧版本改约被拒绝；成功改约原子释放旧名额/占用新名额，且旧领取码立即失效', async () => {
  const admin = await login('supervisor1');
  const alice = await login('alice');
  await cleanupActive(alice);
  const receipts = (await request('GET', '/api/receipts', auth(alice))).data.receipts;
  const { slots } = await createLocationAndSlots(admin, { capacity: 5 });
  const booked = await book(alice, receipts[0].receiptNo, slots[0].id);
  assert.equal(booked.status, 200, JSON.stringify(booked.data));
  const apptId = booked.data.appointment.id;
  const oldCode = booked.data.pickupCode;

  // 旧版本号（当前版本为 1，故意传 99）必须失败
  const stale = await request('POST', `/api/pickup/appointments/${apptId}/reschedule`, auth(alice, {
    body: { slotId: slots[1].id, expectedVersion: 99 },
  }));
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error.code, 'APPOINTMENT_VERSION_CONFLICT');

  // 成功改约到第二时间段
  const res = await request('POST', `/api/pickup/appointments/${apptId}/reschedule`, auth(alice, {
    body: { slotId: slots[1].id, expectedVersion: 1, note: '改到第二天' },
  }));
  assert.equal(res.status, 200, JSON.stringify(res.data));
  assert.equal(res.data.appointment.version, 2);
  assert.equal(res.data.appointment.status, 'rescheduled');
  assert.equal(res.data.appointment.slotId, slots[1].id);
  assert.match(res.data.pickupCode, /^[0-9A-HJ-NP-TV-Z]{5}-[0-9A-HJ-NP-TV-Z]{5}$/);
  assert.notEqual(res.data.pickupCode, oldCode);

  // 旧名额已释放、新名额已占用
  const bookable = (await request('GET', '/api/pickup/bookable-slots', auth(alice))).data.slots;
  assert.equal(bookable.find((s) => s.id === slots[0].id).occupied, 0);
  assert.equal(bookable.find((s) => s.id === slots[1].id).occupied, 1);

  // 旧领取码立即失效（明确提示），新领取码在窗口内有效
  const staff = await login('pickup1');
  const t0 = Date.now() + 2 * DAY + HOUR;
  await setClock(admin, t0);
  try {
    const oldUse = await deliver(staff, res.data.appointment.appointmentNo, oldCode);
    assert.equal(oldUse.status, 409);
    assert.equal(oldUse.data.error.code, 'PICKUP_CODE_OLD');
  } finally {
    await resetClock(admin);
  }
});

test('时间窗口边界：过早拒绝、端点包含、超过宽限拒绝', async () => {
  const admin = await login('supervisor1');
  const bob = await login('bob');
  await cleanupActive(bob);
  const { receipt } = await completeWorkflow(bob);
  const start = Date.now() + 10000;
  const end = start + HOUR;
  const slot = await fixedSlot(admin, { startAt: start, endAt: end, capacity: 5 });
  const booked = await book(bob, receipt.receiptNo, slot.id);
  assert.equal(booked.status, 200, JSON.stringify(booked.data));
  const no = booked.data.appointment.appointmentNo;
  const code = booked.data.pickupCode;
  const staff = await login('pickup1');

  try {
    // 过早（开始前 1ms / 前 5 分钟）
    await setClock(admin, start - 1);
    let r = await deliver(staff, no, code);
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'PICKUP_TOO_EARLY');

    // 开始边界包含
    await setClock(admin, start);
    r = await deliver(staff, no, code);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.delivery.status, 'delivered');

    // 已交付：重复交付拒绝
    await setClock(admin, start + 1000);
    r = await deliver(staff, no, code);
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'PICKUP_ALREADY_DELIVERED');

    // 另一份回执用于验证结束+宽限边界
    const endSlot = await fixedSlot(admin, { startAt: start + 2 * HOUR, endAt: start + 3 * HOUR, capacity: 5 });
    const booked2 = await book(bob, receipt.receiptNo, endSlot.id);
    // 同一回执已有 delivered 的预约不属于活跃预约，可以再约
    assert.equal(booked2.status, 200, JSON.stringify(booked2.data));
    const no2 = booked2.data.appointment.appointmentNo;
    const code2 = booked2.data.pickupCode;
    const end2 = start + 3 * HOUR;

    // 结束 + 宽限 边界包含
    await setClock(admin, end2 + GRACE);
    r = await deliver(staff, no2, code2);
    assert.equal(r.status, 200, `结束+宽限端点应可交付：${JSON.stringify(r.data)}`);

    // 超过宽限 1ms 拒绝（过期）
    const booked3Slot = await fixedSlot(admin, { startAt: start + 4 * HOUR, endAt: start + 5 * HOUR, capacity: 5 });
    const booked3 = await book(bob, receipt.receiptNo, booked3Slot.id);
    assert.equal(booked3.status, 200, JSON.stringify(booked3.data));
    const no3 = booked3.data.appointment.appointmentNo;
    const code3 = booked3.data.pickupCode;
    const end3 = start + 5 * HOUR;
    await setClock(admin, end3 + GRACE + 1);
    r = await deliver(staff, no3, code3);
    assert.equal(r.status, 409);
    assert.equal(r.data.error.code, 'PICKUP_TOO_LATE');
  } finally {
    await resetClock(admin);
  }
});

test('领取码错误与跨预约使用都被明确拒绝，且不泄露明文', async () => {
  const admin = await login('supervisor1');
  const carol = await login('carol');
  await cleanupActive(carol);
  const receipts = (await request('GET', '/api/receipts', auth(carol))).data.receipts;
  const { slots } = await createLocationAndSlots(admin, { capacity: 5 });
  // 两次码校验都落在第二天的时间段窗口内
  const r1 = await book(carol, receipts[0].receiptNo, slots[1].id);
  assert.equal(r1.status, 200, JSON.stringify(r1.data));

  // 第二份预约需要另一份回执：用 dave 的（同一时间段，容量 3）
  const dave = await login('dave');
  await cleanupActive(dave);
  const daveReceipt = (await request('GET', '/api/receipts', auth(dave))).data.receipts[0];
  const r2 = await book(dave, daveReceipt.receiptNo, slots[1].id);
  assert.equal(r2.status, 200, JSON.stringify(r2.data));

  const staff = await login('pickup1');
  await setClock(admin, Date.now() + 2 * DAY + HOUR);
  try {
    // 错码
    const wrong = await deliver(staff, r1.data.appointment.appointmentNo, 'AAAAA-BBBBB');
    assert.equal(wrong.status, 409);
    assert.equal(wrong.data.error.code, 'PICKUP_CODE_INVALID');
    // 跨预约：用 r2 的领取码去领 r1，必须明确返回跨预约拒绝（不是普通错码）
    const cross = await deliver(staff, r1.data.appointment.appointmentNo, r2.data.pickupCode);
    assert.equal(cross.status, 409);
    assert.equal(cross.data.error.code, 'PICKUP_MISMATCH');
    // 跨预约拒绝不得改变任何预约或领取码状态：两个预约仍为 booked、版本不变、名额不变
    const r1After = await request('GET', `/api/pickup/appointments/${r1.data.appointment.id}`, auth(carol));
    const r2After = await request('GET', `/api/pickup/appointments/${r2.data.appointment.id}`, auth(dave));
    assert.equal(r1After.data.appointment.status, 'booked');
    assert.equal(r1After.data.appointment.version, 1);
    assert.equal(r2After.data.appointment.status, 'booked');
    assert.equal(r2After.data.appointment.version, 1);
    const slotsAfter = (await request('GET', '/api/pickup/bookable-slots', auth(carol))).data.slots;
    assert.equal(slotsAfter.find((s) => s.id === slots[1].id).occupied, 2);
    // r2 的领取码仍是 r2 当前生效码：在窗口内可以正常交付（未被跨预约尝试消费）
    const ownUse = await deliver(staff, r2.data.appointment.appointmentNo, r2.data.pickupCode);
    assert.equal(ownUse.status, 200, JSON.stringify(ownUse.data));
    // 主管/办理人任何接口都不含领取码明文（含预约占用列表）
    const adminAppts = await request('GET', '/api/supervisor/pickup/appointments', auth(admin));
    const serialized = JSON.stringify(adminAppts.data);
    assert.ok(!serialized.includes(r1.data.pickupCode), '明文领取码不得出现在主管接口');
    assert.ok(!serialized.includes(r2.data.pickupCode));
  } finally {
    await resetClock(admin);
  }
});

test('回执撤销后未交付预约自动失效并释放名额；已交付预约保持只读', async () => {
  const admin = await login('supervisor1');
  const erin = await login('erin');
  await cleanupActive(erin);
  const receipts = (await request('GET', '/api/receipts', auth(erin))).data.receipts;
  const { slots } = await createLocationAndSlots(admin, { capacity: 5 });

  // 预约 A：交付后撤销回执 → 保持只读
  const a = await book(erin, receipts[0].receiptNo, slots[0].id);
  assert.equal(a.status, 200, JSON.stringify(a.data));
  const staff = await login('pickup1');
  await setClock(admin, Date.now() + 1 * DAY + HOUR);
  const delivered = await deliver(staff, a.data.appointment.appointmentNo, a.data.pickupCode);
  assert.equal(delivered.status, 200, JSON.stringify(delivered.data));

  // 预约 B：另一份回执（dave 的）撤销 → 未交付预约失效释放
  const dave = await login('dave');
  await cleanupActive(dave);
  const daveReceipts = (await request('GET', '/api/receipts', auth(dave))).data.receipts;
  const b = await book(dave, daveReceipts[0].receiptNo, slots[1].id);
  assert.equal(b.status, 200, JSON.stringify(b.data));
  await resetClock(admin);

  const revoke = await request('POST', `/api/receipts/${encodeURIComponent(daveReceipts[0].receiptNo)}?action=revoke`, auth(dave, {
    body: { reason: '测试撤销联动' },
  }));
  assert.equal(revoke.status, 200, JSON.stringify(revoke.data));

  // B 已失效、名额释放
  const bookable = (await request('GET', '/api/pickup/bookable-slots', auth(dave))).data.slots;
  assert.equal(bookable.find((s) => s.id === slots[1].id).occupied, 0);
  const bDetail = await request('GET', `/api/pickup/appointments/${b.data.appointment.id}`, auth(dave));
  assert.equal(bDetail.data.appointment.status, 'revoked');

  // 失效预约不能取消/改约/领取
  const cancel = await request('POST', `/api/pickup/appointments/${b.data.appointment.id}/cancel`, auth(dave, {
    body: { expectedVersion: b.data.appointment.version },
  }));
  assert.equal(cancel.status, 409);
  assert.equal(cancel.data.error.code, 'APPOINTMENT_NOT_ACTIVE');
  const staleDelivery = await deliver(staff, b.data.appointment.appointmentNo, b.data.pickupCode);
  assert.equal(staleDelivery.status, 409);

  // A 已交付保持只读：重复交付拒绝，列表中仍为 delivered
  const replay = await deliver(staff, a.data.appointment.appointmentNo, a.data.pickupCode);
  assert.equal(replay.status, 409);
  assert.equal(replay.data.error.code, 'PICKUP_ALREADY_DELIVERED');
  const aDetail = await request('GET', `/api/pickup/appointments/${a.data.appointment.id}`, auth(erin));
  assert.equal(aDetail.data.appointment.status, 'delivered');

  // 撤销后不能再预约该回执
  const rebook = await book(dave, daveReceipts[0].receiptNo, slots[1].id);
  assert.equal(rebook.status, 409);
  assert.equal(rebook.data.error.code, 'RECEIPT_REVOKED');
});

test('取消/改约与确认交付并发：两个动作只有一个成功', async () => {
  const admin = await login('supervisor1');
  const alice = await login('alice');
  await cleanupActive(alice);
  const receipts = (await request('GET', '/api/receipts', auth(alice))).data.receipts;
  const { slots } = await createLocationAndSlots(admin, { capacity: 5 });

  // 场景 2 需要两个同日且都落在固定时钟窗口内的时间段，必须在固定时钟之前创建
  const base = Date.now() + 1 * DAY;
  const loc2Res = await request('POST', '/api/supervisor/pickup/locations', auth(admin, {
    body: { name: '并发测试网点', address: '并发测试地址 2 号' },
  }));
  const loc2 = loc2Res.data.location.id;
  const saRes = await request('POST', `/api/supervisor/pickup/locations/${loc2}/slots`, auth(admin, {
    body: { startAt: base, endAt: base + 2 * HOUR, capacity: 5 },
  }));
  assert.equal(saRes.status, 200, JSON.stringify(saRes.data));
  const sbRes = await request('POST', `/api/supervisor/pickup/locations/${loc2}/slots`, auth(admin, {
    body: { startAt: base + 3 * HOUR, endAt: base + 5 * HOUR, capacity: 5 },
  }));
  assert.equal(sbRes.status, 200, JSON.stringify(sbRes.data));
  const slotA = saRes.data.slot.id;
  const slotB = sbRes.data.slot.id;

  const staff = await login('pickup1');
  await setClock(admin, base + HOUR);
  try {
    // 场景 1：取消 vs 交付
    const a = await book(alice, receipts[0].receiptNo, slots[0].id);
    assert.equal(a.status, 200, JSON.stringify(a.data));
    const alice2 = await login('alice');
    const [cancelRes, deliverRes] = await Promise.all([
      request('POST', `/api/pickup/appointments/${a.data.appointment.id}/cancel`, auth(alice2, {
        body: { reason: '并发取消', expectedVersion: a.data.appointment.version },
      })),
      deliver(staff, a.data.appointment.appointmentNo, a.data.pickupCode),
    ]);
    const outcomes = [cancelRes.status === 200, deliverRes.status === 200].filter(Boolean).length;
    assert.equal(outcomes, 1, '取消与交付只能一个成功');
    const final1 = await request('GET', `/api/pickup/appointments/${a.data.appointment.id}`, auth(alice));
    assert.ok(['cancelled', 'delivered'].includes(final1.data.appointment.status));
    if (final1.data.appointment.status === 'delivered') {
      assert.equal(deliverRes.status, 200);
      assert.equal(cancelRes.data.error.code, 'APPOINTMENT_DELIVERED_READONLY');
    } else {
      assert.equal(cancelRes.status, 200);
      assert.equal(deliverRes.data.error.code, 'PICKUP_NOT_ACTIVE');
    }

    // 场景 2：改约 vs 交付（两个时间段同日，时钟在窗口内）
    const erin = await login('erin');
    await cleanupActive(erin);
    const erinReceipts = (await request('GET', '/api/receipts', auth(erin))).data.receipts;
    const b = await book(erin, erinReceipts[0].receiptNo, slotA);
    assert.equal(b.status, 200, JSON.stringify(b.data));
    const erin2 = await login('erin');
    const [rescheduleRes, deliverRes2] = await Promise.all([
      request('POST', `/api/pickup/appointments/${b.data.appointment.id}/reschedule`, auth(erin2, {
        body: { slotId: slotB, expectedVersion: 1 },
      })),
      deliver(staff, b.data.appointment.appointmentNo, b.data.pickupCode),
    ]);
    const outcomes2 = [rescheduleRes.status === 200, deliverRes2.status === 200].filter(Boolean).length;
    assert.equal(outcomes2, 1, '改约与交付只能一个成功');
    const final2 = await request('GET', `/api/pickup/appointments/${b.data.appointment.id}`, auth(erin));
    if (final2.data.appointment.status === 'delivered') {
      assert.equal(deliverRes2.status, 200);
      // 已交付后改约必须只读拒绝
      assert.equal(rescheduleRes.data.error.code, 'APPOINTMENT_DELIVERED_READONLY');
    } else {
      assert.equal(rescheduleRes.status, 200);
      // 改约成功后旧领取码立即失效；时间窗口在码校验之前，故可能先返回过早，
      // 两种结果都是明确拒绝，且都不能交付成功。
      assert.ok(['PICKUP_CODE_OLD', 'PICKUP_TOO_EARLY'].includes(deliverRes2.data.error.code),
        `实际：${deliverRes2.data.error.code}`);
      // 用旧码在新窗口内再交付一次，必须精确命中“旧码已失效”
      await setClock(admin, base + 4 * HOUR);
      const oldCodeInWindow = await deliver(staff, b.data.appointment.appointmentNo, b.data.pickupCode);
      assert.equal(oldCodeInWindow.status, 409);
      assert.equal(oldCodeInWindow.data.error.code, 'PICKUP_CODE_OLD');
      await setClock(admin, base + HOUR);
    }
  } finally {
    await resetClock(admin);
  }
});

test('取消/改约/确认交付三方同时发起：只有一个动作成功，名额/版本/最终状态一致', async () => {
  const admin = await login('supervisor1');
  const alice = await login('alice');
  await cleanupActive(alice);
  const receipts = (await request('GET', '/api/receipts', auth(alice))).data.receipts;

  // 两个同日时间段：交付窗口与改约目标都落在固定时钟内
  const base = Date.now() + 1 * DAY;
  const locRes = await request('POST', '/api/supervisor/pickup/locations', auth(admin, {
    body: { name: '三方并发网点', address: '三方并发测试地址 1 号' },
  }));
  assert.equal(locRes.status, 200, JSON.stringify(locRes.data));
  const locId = locRes.data.location.id;
  const saRes = await request('POST', `/api/supervisor/pickup/locations/${locId}/slots`, auth(admin, {
    body: { startAt: base, endAt: base + 2 * HOUR, capacity: 5 },
  }));
  assert.equal(saRes.status, 200, JSON.stringify(saRes.data));
  const sbRes = await request('POST', `/api/supervisor/pickup/locations/${locId}/slots`, auth(admin, {
    body: { startAt: base + 3 * HOUR, endAt: base + 5 * HOUR, capacity: 5 },
  }));
  assert.equal(sbRes.status, 200, JSON.stringify(sbRes.data));
  const slotA = saRes.data.slot.id;
  const slotB = sbRes.data.slot.id;

  const staff = await login('pickup1');
  await setClock(admin, base + HOUR);
  try {
    const booked = await book(alice, receipts[0].receiptNo, slotA);
    assert.equal(booked.status, 200, JSON.stringify(booked.data));
    const appt = booked.data.appointment;
    assert.equal(appt.version, 1);
    const alice2 = await login('alice');
    const alice3 = await login('alice');

    // 同一预约（版本 1）同时发起取消、改约、确认交付
    const [cancelRes, rescheduleRes, deliverRes] = await Promise.all([
      request('POST', `/api/pickup/appointments/${appt.id}/cancel`, auth(alice2, {
        body: { reason: '三方并发取消', expectedVersion: 1 },
      })),
      request('POST', `/api/pickup/appointments/${appt.id}/reschedule`, auth(alice3, {
        body: { slotId: slotB, expectedVersion: 1 },
      })),
      deliver(staff, appt.appointmentNo, booked.data.pickupCode),
    ]);

    const results = [
      { name: 'cancel', res: cancelRes },
      { name: 'reschedule', res: rescheduleRes },
      { name: 'deliver', res: deliverRes },
    ];
    const winners = results.filter((r) => r.res.status === 200);
    const losers = results.filter((r) => r.res.status !== 200);
    assert.equal(winners.length, 1,
      `只能一个动作成功：${JSON.stringify(results.map((r) => [r.name, r.res.status, r.res.data?.error?.code]))}`);
    assert.equal(losers.length, 2);
    for (const loser of losers) {
      assert.equal(loser.res.status, 409, `${loser.name} 必须明确返回冲突`);
      assert.ok(loser.res.data.error.code, `${loser.name} 必须携带业务错误码`);
    }

    // 最终状态与胜者一致；版本只推进一格（不存在两个动作都落库）
    const final = (await request('GET', `/api/pickup/appointments/${appt.id}`, auth(alice))).data.appointment;
    assert.equal(final.version, 2, '版本只应推进一次');
    const slotsNow = (await request('GET', '/api/pickup/bookable-slots', auth(alice))).data.slots;
    const occA = slotsNow.find((s) => s.id === slotA).occupied;
    const occB = slotsNow.find((s) => s.id === slotB).occupied;
    const winner = winners[0].name;
    if (winner === 'cancel') {
      assert.equal(final.status, 'cancelled');
      assert.equal(occA, 0, '取消必须释放原名额');
      assert.equal(occB, 0);
      assert.equal(rescheduleRes.data.error.code, 'APPOINTMENT_NOT_ACTIVE');
      assert.equal(deliverRes.data.error.code, 'PICKUP_NOT_ACTIVE');
    } else if (winner === 'reschedule') {
      assert.equal(final.status, 'rescheduled');
      assert.equal(occA, 0, '改约必须释放旧名额');
      assert.equal(occB, 1, '改约必须占用新名额');
      // 取消携带的是旧版本号，必须明确版本冲突
      assert.equal(cancelRes.data.error.code, 'APPOINTMENT_VERSION_CONFLICT');
      // 交付用旧领取码：新窗口未到或旧码已失效，都是明确拒绝
      assert.ok(['PICKUP_CODE_OLD', 'PICKUP_TOO_EARLY'].includes(deliverRes.data.error.code),
        `实际：${deliverRes.data.error.code}`);
    } else {
      assert.equal(final.status, 'delivered');
      assert.equal(occA, 1, '交付消耗名额，不释放');
      assert.equal(occB, 0);
      assert.equal(cancelRes.data.error.code, 'APPOINTMENT_DELIVERED_READONLY');
      assert.equal(rescheduleRes.data.error.code, 'APPOINTMENT_DELIVERED_READONLY');
    }
  } finally {
    await resetClock(admin);
  }
});

test('交付后领取码重放、跨会话重放均被拒绝；失败原因进入主管视图与只追加审计', async () => {
  const admin = await login('supervisor1');
  const bob = await login('bob');
  await cleanupActive(bob);
  const receipts = (await request('GET', '/api/receipts', auth(bob))).data.receipts;
  const { slots } = await createLocationAndSlots(admin, { capacity: 5 });
  const booked = await book(bob, receipts[0].receiptNo, slots[0].id);
  assert.equal(booked.status, 200);
  const staff1 = await login('pickup1');
  const staff2 = await login('pickup1');
  await setClock(admin, Date.now() + 1 * DAY + HOUR);
  try {
    const ok = await deliver(staff1, booked.data.appointment.appointmentNo, booked.data.pickupCode);
    assert.equal(ok.status, 200);
    const replay1 = await deliver(staff1, booked.data.appointment.appointmentNo, booked.data.pickupCode);
    assert.equal(replay1.status, 409);
    assert.equal(replay1.data.error.code, 'PICKUP_ALREADY_DELIVERED');
    const replay2 = await deliver(staff2, booked.data.appointment.appointmentNo, booked.data.pickupCode);
    assert.equal(replay2.status, 409);
    assert.equal(replay2.data.error.code, 'PICKUP_ALREADY_DELIVERED');
  } finally {
    await resetClock(admin);
  }
  const apptId = booked.data.appointment.id;
  const detail = await request('GET', `/api/pickup/appointments/${apptId}`, auth(bob));
  const history = detail.data.history;
  assert.ok(history.some((row) => row.type === 'pickup.appointment.delivered'));
  assert.ok(history.some((row) => row.result === 'denied'
    && row.detail.reason === 'PICKUP_ALREADY_DELIVERED'), '拒绝事件必须进入该预约的只追加历史');
  // 主管全局最近失败列表也能看到
  const denials = (await request('GET', '/api/supervisor/pickup/appointments', auth(admin))).data.denials;
  assert.ok(denials.some((d) => d.detail.reason === 'PICKUP_ALREADY_DELIVERED'));
});

// 重启恢复：另起进程打开同一数据库，预约/容量/状态保持一致，已交付只读
test('刷新、重新登录与服务重启后预约/容量/审计保持一致', async () => {
  const admin = await login('supervisor1');
  const carol = await login('carol');
  await cleanupActive(carol);
  let receipts = (await request('GET', '/api/receipts', auth(carol))).data.receipts;
  if (!receipts.length) {
    const done = await completeWorkflow(carol);
    receipts = [{ receiptNo: done.receipt.receiptNo }];
  }
  const { slots } = await createLocationAndSlots(admin, { capacity: 4 });
  const booked = await book(carol, receipts[0].receiptNo, slots[0].id);
  assert.equal(booked.status, 200);
  const apptNo = booked.data.appointment.appointmentNo;
  const apptId = booked.data.appointment.id;

  // 刷新/重新登录（新会话）后状态一致
  const carol2 = await login('carol');
  const detail = await request('GET', `/api/pickup/appointments/${apptId}`, auth(carol2));
  assert.equal(detail.status, 200);
  assert.equal(detail.data.appointment.appointmentNo, apptNo);
  assert.equal(detail.data.appointment.frozen.locationName, '市民中心领取处');
  assert.ok(Array.isArray(detail.data.history) && detail.data.history.length >= 1);

  // 重启子进程
  const child = await startRestartServer(process.env.DB_PATH);
  try {
    const loginRes = await fetch(`${child.url}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'carol', password: 'password123' }),
    });
    assert.equal(loginRes.status, 200);
    const loginBody = await loginRes.json();
    const cookies = loginRes.headers.getSetCookie();
    const sid = /sid=([^;]+)/.exec(cookies.find((c) => c.startsWith('sid=')))[1];
    const csrf = loginBody.csrfToken;
    const headers = { Cookie: `sid=${sid}`, 'X-CSRF-Token': csrf };

    const stateRes = await fetch(`${child.url}/api/state`, { headers });
    const state = await stateRes.json();
    const found = state.pickupAppointments.find((a) => a.appointmentNo === apptNo);
    assert.ok(found, '重启后预约仍在');
    assert.equal(found.frozen.locationName, '市民中心领取处');
    assert.equal(found.frozen.locationAddress, '杭州市西湖区文三路 88 号');
    assert.equal(found.status, 'booked');
    const slotState = state.bookableSlots.find((s) => s.id === slots[0].id);
    assert.equal(slotState.occupied, 1, '重启后占用名额一致');
    assert.equal(slotState.capacity, 4);

    // 领取码摘要仍可校验（重启后用正确领取码在窗口内可以交付）
    const staffLogin = await fetch(`${child.url}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'pickup1', password: 'password123' }),
    });
    const staffLoginBody = await staffLogin.json();
    const staffCookies = staffLogin.headers.getSetCookie();
    const ssid = /sid=([^;]+)/.exec(staffCookies.find((c) => c.startsWith('sid=')))[1];
    const scsrfCookie = /csrf=([^;]+)/.exec(staffCookies.find((c) => c.startsWith('csrf=')))[1];
    const scsrf = staffLoginBody.csrfToken;
    assert.equal(scsrf, scsrfCookie);
    // 预约在明天，时钟不受控（子进程实时时钟），直接验证“过早”路径证明摘要可被服务端读取
    const tooEarly = await fetch(`${child.url}/api/pickup-delivery/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `sid=${ssid}; csrf=${scsrfCookie}`, 'X-CSRF-Token': scsrf },
      body: JSON.stringify({ appointmentNo: apptNo, code: booked.data.pickupCode }),
    });
    const tooEarlyBody = await tooEarly.json();
    // 码正确 → 走到时间校验并明确“过早”，而不是码错误
    assert.equal(tooEarly.status, 409);
    assert.equal(tooEarlyBody.error.code, 'PICKUP_TOO_EARLY');

    // 错误码在窗口外同样必须被拒绝（时间校验先于码校验，返回过早；
    // 绝不允许 200 成功或 500，错码本身的精确拒绝已由边界/跨预约用例覆盖）
    const wrong = await fetch(`${child.url}/api/pickup-delivery/confirm`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `sid=${ssid}; csrf=${scsrfCookie}`, 'X-CSRF-Token': scsrf },
      body: JSON.stringify({ appointmentNo: apptNo, code: 'XXXXX-YYYYY' }),
    });
    assert.equal(wrong.status, 409);
    assert.ok(['PICKUP_TOO_EARLY', 'PICKUP_CODE_INVALID'].includes((await wrong.json()).error.code));

    // 主管视图重启后仍含失败原因与审计
    const adminLogin = await fetch(`${child.url}/api/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'supervisor1', password: 'password123' }),
    });
    const adminCookies = adminLogin.headers.getSetCookie();
    const asid = /sid=([^;]+)/.exec(adminCookies.find((c) => c.startsWith('sid=')))[1];
    const acsrf = /csrf=([^;]+)/.exec(adminCookies.find((c) => c.startsWith('csrf=')))[1];
    const auditRes = await fetch(`${child.url}/api/supervisor/pickup/audit`, {
      headers: { Cookie: `sid=${asid}`, 'X-CSRF-Token': acsrf },
    });
    const auditBody = await auditRes.json();
    assert.ok(auditBody.audit.some((row) => row.appointmentNo === apptNo && row.type === 'pickup.appointment.booked'));
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
      PICKUP_CODE_SECRET: process.env.PICKUP_CODE_SECRET,
      PICKUP_GRACE_MS: process.env.PICKUP_GRACE_MS,
      VERIFY_RATE_MAX: '1000',
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
