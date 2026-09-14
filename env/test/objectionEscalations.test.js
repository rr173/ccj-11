import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

process.env.DB_PATH = path.join(process.cwd(), 'data', `test-escalation-${process.pid}.db`);
process.env.TOKEN_TTL_MS = '600000';
process.env.RECEIPT_SECRET = 'unit-test-escalation-secret-fixed-value';
process.env.VERIFY_RATE_MAX = '100';
// 极短处理期限 + 两个提醒点（60 分钟、30 分钟）+ 10 分钟延期，全部用注入时间驱动
process.env.RECEIPT_OBJECTION_TTL_MS = String(60 * 60 * 1000);
process.env.OBJECTION_REMINDER_LEAD_MS = `${60 * 60 * 1000},${30 * 60 * 1000}`;
process.env.OBJECTION_EXTENSION_MS = String(10 * 60 * 1000);
process.env.OBJECTION_SWEEP_MS = String(60 * 60 * 1000);
// 父测试进程不靠定时器驱动（全部用注入时间显式扫描）；重启恢复由子进程启动扫描覆盖
process.env.NO_OBJECTION_SWEEP = '1';
process.env.NO_AUTO_LISTEN = '1';
for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });

const { server } = await import('../src/server.js');
const db = await import('../src/db.js');
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
  return { username, cookie: `sid=${sid}; csrf=${csrf}`, csrf: res.data.csrfToken };
}
function auth(client, extra = {}) {
  return { ...extra, headers: { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, ...(extra.headers || {}) } };
}
const textAttachment = (content, filename = '情况说明.txt') => ({
  filename,
  contentType: 'text/plain; charset=utf-8',
  contentBase64: Buffer.from(content, 'utf8').toString('base64'),
});
function randomPageId() {
  return crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}
const PAYLOADS = [
  { name: '李明明', idNumber: 'ID-SECRET-99', phone: '13800138000' },
  { province: '浙江省', city: '宁波市', detail: '升级路 66 号秘密弄堂' },
  { type: 'change', description: '超期升级模块测试事项' },
  { agreed: true, contactTime: '工作日白天' },
];
async function completeWorkflow(client, payloads = PAYLOADS) {
  let workflow = (await request('GET', '/api/state', auth(client))).data.workflow;
  if (workflow.completed) return (await request('GET', '/api/state', auth(client))).data.receipt;
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
    if (res.data.completed) return res.data.receipt;
  }
  throw new Error('unreachable');
}
async function createObjection(client, receiptNo, reason = '回执记载信息与事实不符，申请核查撤销，需要延期核对。') {
  const res = await request('POST', '/api/receipt-objections', auth(client, {
    body: { receiptNo, reason, attachment: textAttachment('情况说明：本人承诺所述属实，证件号不应在通知中出现。') },
  }));
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.objection;
}
async function assignedProcessor(objectionNo) {
  const p1 = await login('processor1');
  const mine = (await request('GET', '/api/processor/objections?status=open', auth(p1))).data.objections;
  if (mine.some((o) => o.objectionNo === objectionNo)) return p1;
  const p2 = await login('processor2');
  const mine2 = (await request('GET', '/api/processor/objections?status=open', auth(p2))).data.objections;
  if (mine2.some((o) => o.objectionNo === objectionNo)) return p2;
  throw new Error(`异议 ${objectionNo} 未找到被分配的处理人`);
}

// 以“创建时刻 + 偏移”驱动扫描（避免真实等待）
const HOUR = 60 * 60 * 1000;
function sweepAt(createdAt, offsetMs, opts = {}) {
  return db.sweepObjectionNotifications({ at: createdAt + offsetMs, ...opts });
}
function countNotifs(objectionNo) {
  return db.db.prepare(`
    SELECT COUNT(*) AS c FROM receipt_objection_notifications
    WHERE objection_id = (SELECT id FROM receipt_objections WHERE objection_no = ?)
  `).get(objectionNo).c;
}

describe('异议超期升级与通知留痕（串行）', { concurrency: false }, () => {
  test('正常期限：临近时生成待发送提醒并自动发送，处理人/办理人各自可见且通知不含敏感信息', async () => {
    const dave = await login('dave');
    const receipt = await completeWorkflow(dave);
    const objection = await createObjection(dave, receipt.receiptNo);
    const createdAt = objection.createdAt;
    const deadlineAt = objection.deadlineAt;
    assert.equal(deadlineAt - createdAt, HOUR);

    // 创建初期（尚未到达最早提醒点：60 分钟提前量恰好在发起时刻到期，
    // 取发起前 1 毫秒）不应有任何提醒
    assert.deepEqual(sweepAt(createdAt, -1), {
      remindersCreated: 0, overdueMarked: 0, escalationsCreated: 0, dispatched: 0,
    });

    // 到达 60 分钟提醒点（恰好等于 TTL，发起即触发第一序位）：生成处理人 + 办理人两条
    const stats = sweepAt(createdAt, 0);
    assert.equal(stats.remindersCreated, 2);
    assert.equal(stats.overdueMarked, 0);
    assert.equal(stats.dispatched, 2, '待发送通知应在同次扫描中发送');

    // 提醒点之间（如到期前 45 分钟）重复扫描不产生任何新通知——
    // 这是“重复调度不产生重复通知”的核心场景
    assert.deepEqual(sweepAt(createdAt, 15 * 60 * 1000), {
      remindersCreated: 0, overdueMarked: 0, escalationsCreated: 0, dispatched: 0,
    });

    // 到达 30 分钟提醒点再生成一组（两个提醒点彼此独立）
    const second = sweepAt(createdAt, 31 * 60 * 1000);
    assert.equal(second.remindersCreated, 2);

    const processor = await assignedProcessor(objection.objectionNo);
    const pNotifsAll = (await request('GET', '/api/processor/notifications?kind=reminder', auth(processor))).data.notifications
      .filter((n) => n.objectionNo === objection.objectionNo);
    assert.equal(pNotifsAll.length, 2, '处理人应在两个提醒点各收到一条');
    const reminder = pNotifsAll[0];
    assert.equal(reminder.objectionNo, objection.objectionNo);
    assert.equal(reminder.payload.status, 'submitted');
    assert.equal(reminder.payload.statusLabel, '待受理');
    assert.equal(reminder.payload.deadlineAt, deadlineAt);
    assert.equal(reminder.payload.receiptNo, receipt.receiptNo);
    assert.equal(reminder.status, 'sent');
    assert.ok(reminder.sentAt);
    assert.equal(reminder.readAt, null);

    // 通知负载不含证件号 / 完整地址 / 完整手机号
    const serialized = JSON.stringify(reminder);
    assert.ok(!serialized.includes('ID-SECRET-99'), '通知不得泄露证件号');
    assert.ok(!serialized.includes('升级路'), '通知不得泄露完整地址');
    assert.ok(!/13800138000/.test(serialized), '通知不得泄露完整手机号');

    // 办理人也收到自己的一条，且 /api/state 恢复提醒状态（刷新/重登场景）
    const state = (await request('GET', '/api/state', auth(dave))).data;
    const mine = state.objectionNotifications.find((n) => n.objectionNo === objectionNo(objection));
    assert.ok(mine, '/api/state 应带回办理人的通知');
    assert.equal(state.objectionUnreadCount >= 1, true);

    // 处理人确认已读：首次成功、重复确认幂等；每次确认只追加一个已读事件
    const readRes = await request('POST', `/api/processor/notifications/${reminder.id}/read`, auth(processor, { body: {} }));
    assert.equal(readRes.status, 200, JSON.stringify(readRes.data));
    assert.equal(readRes.data.notification.status, 'read');
    assert.ok(readRes.data.notification.readAt);
    const readAgain = await request('POST', `/api/processor/notifications/${reminder.id}/read`, auth(processor, { body: {} }));
    assert.equal(readAgain.status, 200);
    assert.equal(readAgain.data.idempotent, true);

    const detail = (await request('GET', `/api/processor/objections/${objection.objectionNo}`, auth(processor))).data.objection;
    const readEvents = detail.events.filter((e) => e.type === 'receipt.objection.notification.read');
    assert.equal(readEvents.length, 1, '重复确认不能重复追加事件');
    // 提醒生成事件：每个逻辑提醒点一条（含两个接收方），共两条
    const scheduledEvents = detail.events.filter((e) => e.type === 'receipt.objection.reminder.scheduled');
    assert.equal(scheduledEvents.length, 2);

    // 终结释放名额
    await request('POST', `/api/processor/objections/${objection.objectionNo}/accept`, auth(processor, { body: {} }));
    const reject = await request('POST', `/api/processor/objections/${objection.objectionNo}/reject`, auth(processor, {
      body: { reason: '经核查该异议不成立，予以驳回处理。' },
    }));
    assert.equal(reject.status, 200, JSON.stringify(reject.data));
  });

  test('逾期：自动标记逾期，按处理人/主管权限分流升级；终态异议不再升级；重复调度不产生重复', async () => {
    const erin = await login('erin');
    const receipt = await completeWorkflow(erin);
    const objection = await createObjection(erin, receipt.receiptNo, '逾期升级链路验证用的异议申请。');
    const { createdAt, deadlineAt } = objection;

    // 0 时刻：60 分钟提醒点生成（全局统计只断言本异议带来的增量）
    const before0 = countNotifs(objection.objectionNo);
    sweepAt(createdAt, 0);
    assert.equal(countNotifs(objection.objectionNo) - before0, 2);
    // 31 分钟：30 分钟提醒点生成（处理人 + 办理人，共再增 2 条）
    const before31 = countNotifs(objection.objectionNo);
    const mid = sweepAt(createdAt, 31 * 60 * 1000);
    assert.ok(mid.remindersCreated >= 2);
    assert.equal(countNotifs(objection.objectionNo) - before31, 2);

    // 超过截止 1 秒：标记逾期 + 按权限生成升级（处理人 + 主管 = 2 条）
    const beforeOverdue = countNotifs(objection.objectionNo);
    const overdue = sweepAt(createdAt, HOUR + 1);
    assert.equal(overdue.overdueMarked >= 1, true);
    assert.ok(overdue.escalationsCreated >= 2);
    assert.equal(countNotifs(objection.objectionNo) - beforeOverdue, 2);

    const processor = await assignedProcessor(objection.objectionNo);
    const pNotifs = (await request('GET', '/api/processor/notifications', auth(processor))).data.notifications;
    const esc = pNotifs.filter((n) => n.kind === 'overdue');
    assert.equal(esc.length, 1);
    assert.equal(esc[0].level, 1);
    assert.equal(esc[0].payload.deadlineAt, deadlineAt);
    assert.equal(esc[0].payload.objectionNo, objection.objectionNo);
    assert.equal(esc[0].payload.receiptNo, receipt.receiptNo);

    // 主管收到升级广播；主管工作台状态可查
    const supervisor = await login('supervisor1');
    const sNotifs = (await request('GET', '/api/supervisor/notifications', auth(supervisor))).data.notifications;
    assert.ok(sNotifs.some((n) => n.kind === 'overdue' && n.objectionNo === objection.objectionNo));

    // 办理人没有逾期通知行（其可见的是处理进度；逾期升级按权限只给处理人/主管）
    const ownerNotifs = (await request('GET', '/api/receipt-objection-notifications', auth(erin))).data.notifications;
    assert.ok(!ownerNotifs.some((n) => n.kind === 'overdue'));
    assert.equal(ownerNotifs.filter((n) => n.kind === 'reminder').length, 2,
      '办理人在两个提醒点各收到一条（共 2 条；接收方只有本人，处理人的不算在内）');

    // 异议视图带 overdueAt 标记
    const pDetail = (await request('GET', `/api/processor/objections/${objection.objectionNo}`, auth(processor))).data.objection;
    assert.ok(pDetail.overdueAt, '超过截止时间后必须记录首次逾期时刻');

    // 重复调度（模拟定时器重入 / 多实例 / 重启补扫）：本异议不再产生任何通知
    const countAfterOverdue = countNotifs(objection.objectionNo);
    for (let i = 0; i < 3; i += 1) {
      const again = sweepAt(createdAt, HOUR + 1000 + i * 1000);
      assert.equal(again.remindersCreated, 0);
      assert.equal(again.overdueMarked, 0);
      assert.equal(again.escalationsCreated, 0);
    }
    assert.equal(countNotifs(objection.objectionNo), countAfterOverdue);
    const escAfter = (await request('GET', '/api/processor/notifications?kind=overdue', auth(processor))).data.notifications
      .filter((n) => n.objectionNo === objection.objectionNo);
    assert.equal(escAfter.length, 1, '重复调度不能产生重复升级通知');
    const supervisorEsc = (await request('GET', '/api/supervisor/notifications?kind=overdue', auth(supervisor))).data.notifications
      .filter((n) => n.objectionNo === objection.objectionNo);
    assert.equal(supervisorEsc.length, 1);

    // 逾期事件：一条标记事件 + 一条升级事件（记录接收方分流）
    const events = pDetail.events.map((e) => e.type);
    assert.equal(events.filter((t) => t === 'receipt.objection.overdue').length, 2);

    // 终结异议：之后扫描不再产生任何通知
    await request('POST', `/api/processor/objections/${objection.objectionNo}/accept`, auth(processor, { body: {} }));
    const reject = await request('POST', `/api/processor/objections/${objection.objectionNo}/reject`, auth(processor, {
      body: { reason: '虽已逾期但经核查异议不成立，驳回并关闭。' },
    }));
    assert.equal(reject.status, 200);
    const afterClose = sweepAt(createdAt, 2 * HOUR);
    assert.equal(afterClose.escalationsCreated, 0);
    assert.equal(afterClose.overdueMarked, 0);
  });

  test('延期：处理人申请一次→主管批准顺延截止时间；逾期再升级为第 2 层；旧记录保留', async () => {
    const bob = await login('bob');
    const receipt = await completeWorkflow(bob);
    const objection = await createObjection(bob, receipt.receiptNo, '需要更多时间核对回执登记信息，申请延期处理。');
    const { createdAt } = objection;
    const processor = await assignedProcessor(objection.objectionNo);
    const supervisor = await login('supervisor1');

    // 先让其逾期（第 1 层升级）
    sweepAt(createdAt, HOUR + 1000);

    // 非被分配处理人不能申请（运行时确定“另一个处理人”账号）
    const assignedUsername = processor.username;
    const otherProcessorClient = await login(assignedUsername === 'processor1' ? 'processor2' : 'processor1');
    const forbidden = await request('POST', `/api/processor/objections/${objection.objectionNo}/extension`,
      auth(otherProcessorClient, { body: { reason: '恶意代申请延期，原因足够长的一段文字。' } }));
    assert.equal(forbidden.status, 404, '未分配处理人连存在性都不可见');

    // 原因长度校验
    const badReason = await request('POST', `/api/processor/objections/${objection.objectionNo}/extension`,
      auth(processor, { body: { reason: '短' } }));
    assert.equal(badReason.status, 400);
    assert.equal(badReason.data.error.code, 'INVALID_EXTENSION_REASON');

    // 正常申请
    const applied = await request('POST', `/api/processor/objections/${objection.objectionNo}/extension`,
      auth(processor, { body: { reason: '需向第三方核验原始凭证，申请顺延十个工作日时间核对。' } }));
    assert.equal(applied.status, 200, JSON.stringify(applied.data));
    assert.equal(applied.data.extension.status, 'pending');
    const extensionId = applied.data.extension.id;
    assert.equal(applied.data.extension.previousDeadlineAt, objection.deadlineAt);

    // 主管待审批列表可见，且不含敏感快照字段
    const pending = (await request('GET', '/api/supervisor/extensions?status=pending', auth(supervisor))).data.extensions;
    assert.ok(pending.some((e) => e.id === extensionId));
    assert.ok(!JSON.stringify(pending).includes('ID-SECRET-99'), '主管列表不得泄露证件号');

    // 重复申请被拒（每份异议只能一次）
    const duplicate = await request('POST', `/api/processor/objections/${objection.objectionNo}/extension`,
      auth(processor, { body: { reason: '重复申请延期，这是另一段足够长的原因说明。' } }));
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.data.error.code, 'EXTENSION_ALREADY_REQUESTED');

    // 主管收到待审批通知
    const reqNotifs = (await request('GET', '/api/supervisor/notifications?kind=extension-requested', auth(supervisor))).data.notifications;
    assert.ok(reqNotifs.some((n) => n.objectionNo === objection.objectionNo));

    // 非主管不能审批（办理人命中 404）
    const bobReject = await request('POST', `/api/supervisor/extensions/${extensionId}/reject`, auth(bob, { body: {} }));
    assert.equal(bobReject.status, 404);

    // 批准（顺延 10 分钟；逾期标记清除）
    const approved = await request('POST', `/api/supervisor/extensions/${extensionId}/approve`,
      auth(supervisor, { body: { note: '同意延期，请尽快完成核验。' } }));
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    assert.equal(approved.data.extension.status, 'approved');
    const newDeadline = approved.data.newDeadlineAt;
    assert.equal(newDeadline, objection.deadlineAt + 10 * 60 * 1000);

    // 重复决议（并发双击场景的串行等价）：已终结不能再批准/拒绝
    const again = await request('POST', `/api/supervisor/extensions/${extensionId}/approve`,
      auth(supervisor, { body: { note: '再次批准' } }));
    assert.equal(again.status, 409);
    assert.equal(again.data.error.code, 'EXTENSION_ALREADY_DECIDED');

    // 处理人收到批准通知；办理人收到结果留痕
    const approvedNotifs = (await request('GET', '/api/processor/notifications?kind=extension-approved', auth(processor))).data.notifications;
    assert.ok(approvedNotifs.some((n) => n.objectionNo === objection.objectionNo));
    const ownerApproved = (await request('GET', '/api/receipt-objection-notifications?kind=extension-approved', auth(bob))).data.notifications;
    assert.equal(ownerApproved.length, 1);

    // 新截止时间前：可能补生成新期限的提醒（按新截止的提醒点），但不得再标记逾期
    const beforeNew = db.sweepObjectionNotifications({ at: newDeadline - 1000 });
    assert.equal(beforeNew.overdueMarked, 0);
    assert.equal(beforeNew.escalationsCreated, 0);
    // 超过新截止后升级为第 2 层（旧的第 1 层升级永久保留）
    const beforeOverdueCount = countNotifs(objection.objectionNo);
    const secondOverdue = db.sweepObjectionNotifications({ at: newDeadline + 1000 });
    assert.ok(secondOverdue.overdueMarked >= 1);
    assert.ok(secondOverdue.escalationsCreated >= 2);
    assert.equal(countNotifs(objection.objectionNo) - beforeOverdueCount, 2, '仅新增第 2 层两条升级通知');

    const l2 = (await request('GET', '/api/processor/notifications?kind=overdue', auth(processor))).data.notifications
      .filter((n) => n.objectionNo === objection.objectionNo);
    const levels = l2.map((n) => n.level).sort();
    assert.deepEqual(levels, [1, 2]);

    // 事件链完整且只追加
    const detail = (await request('GET', `/api/processor/objections/${objection.objectionNo}`, auth(processor))).data.objection;
    const types = detail.events.map((e) => e.type);
    assert.ok(types.includes('receipt.objection.extension.requested'));
    assert.ok(types.includes('receipt.objection.extension.approved'));
    assert.deepEqual(
      types.filter((t) => t === 'receipt.objection.overdue').length >= 3,
      true,
      '逾期标记与两次升级均应有事件',
    );

    // 关闭
    await request('POST', `/api/processor/objections/${objection.objectionNo}/accept`, auth(processor, { body: {} }));
    const close = await request('POST', `/api/processor/objections/${objection.objectionNo}/reject`, auth(processor, {
      body: { reason: '延期核验完成，异议仍不成立，驳回结案。' },
    }));
    assert.equal(close.status, 200);
  });

  test('延期被拒绝：截止时间不变，拒绝理由留痕，且不能再次申请', async () => {
    const carol = await login('carol');
    const receipt = await completeWorkflow(carol);
    const objection = await createObjection(carol, receipt.receiptNo, '申请延期但可能理由不充分的一条异议。');
    const { createdAt } = objection;
    const processor = await assignedProcessor(objection.objectionNo);
    const supervisor = await login('supervisor1');

    const applied = await request('POST', `/api/processor/objections/${objection.objectionNo}/extension`,
      auth(processor, { body: { reason: '等待外部材料中，希望能够多给一些处理时间。' } }));
    assert.equal(applied.status, 200);
    const extensionId = applied.data.extension.id;

    // 拒绝必须填写理由
    const noNote = await request('POST', `/api/supervisor/extensions/${extensionId}/reject`, auth(supervisor, { body: { note: '' } }));
    assert.equal(noNote.status, 400);
    assert.equal(noNote.data.error.code, 'EXTENSION_DECISION_NOTE_REQUIRED');

    const rejected = await request('POST', `/api/supervisor/extensions/${extensionId}/reject`,
      auth(supervisor, { body: { note: '理由不充分，不同意延期，请按期办结。' } }));
    assert.equal(rejected.status, 200);
    assert.equal(rejected.data.extension.status, 'rejected');
    assert.equal(rejected.data.extension.currentDeadlineAt, objection.deadlineAt, '拒绝不得改变截止时间');

    // 处理人收到拒绝通知
    const rejNotifs = (await request('GET', '/api/processor/notifications?kind=extension-rejected', auth(processor))).data.notifications;
    assert.ok(rejNotifs.some((n) => n.objectionNo === objection.objectionNo));

    // 不能再次申请（每异议一次机会）
    const second = await request('POST', `/api/processor/objections/${objection.objectionNo}/extension`,
      auth(processor, { body: { reason: '被拒后再次尝试申请，这是足够长的原因文本。' } }));
    assert.equal(second.status, 409);
    assert.equal(second.data.error.code, 'EXTENSION_ALREADY_REQUESTED');

    // 逾期仍按原截止时间升级（第 1 层，处理人 + 主管两条）；
    // 同时补齐此前停机期间错过的两个提醒点（2 点 × 2 接收方 = 4 条留痕）
    const beforeCount = countNotifs(objection.objectionNo);
    const stats = sweepAt(createdAt, HOUR + 5000);
    assert.ok(stats.overdueMarked >= 1);
    assert.ok(stats.escalationsCreated >= 2);
    assert.equal(countNotifs(objection.objectionNo) - beforeCount, 6);
    // 逾期升级本身恰好两条
    const overdueNotifs = db.db.prepare(`
      SELECT COUNT(*) AS c FROM receipt_objection_notifications
      WHERE objection_id = (SELECT id FROM receipt_objections WHERE objection_no = ?) AND kind = 'overdue'
    `).get(objection.objectionNo).c;
    assert.equal(overdueNotifs, 2);

    await request('POST', `/api/processor/objections/${objection.objectionNo}/accept`, auth(processor, { body: {} }));
    await request('POST', `/api/processor/objections/${objection.objectionNo}/reject`, auth(processor, {
      body: { reason: '逾期且异议不成立，驳回结案。' },
    }));
  });

  test('并发延期：两个请求同时申请同一异议，只有一个成功', async () => {
    const alice = await login('alice');
    const receipt = await completeWorkflow(alice);
    const objection = await createObjection(alice, receipt.receiptNo, '专门用于并发延期申请测试的一条异议记录。');
    const processor = await assignedProcessor(objection.objectionNo);

    const reason = '并发申请延期，两个处理页面同时提交时只能有一个成功。';
    const results = await Promise.all([
      request('POST', `/api/processor/objections/${objection.objectionNo}/extension`, auth(processor, { body: { reason } })),
      request('POST', `/api/processor/objections/${objection.objectionNo}/extension`, auth(processor, { body: { reason } })),
    ]);
    const statuses = results.map((r) => r.status).sort();
    assert.deepEqual(statuses, [200, 409]);
    const ok = results.find((r) => r.status === 200);
    const fail = results.find((r) => r.status === 409);
    assert.equal(fail.data.error.code, 'EXTENSION_ALREADY_REQUESTED');

    // 主管并发双击批准/拒绝：只能落一个决议
    const supervisor = await login('supervisor1');
    const extensionId = ok.data.extension.id;
    const decisions = await Promise.all([
      request('POST', `/api/supervisor/extensions/${extensionId}/approve`, auth(supervisor, { body: { note: '并发批准一' } })),
      request('POST', `/api/supervisor/extensions/${extensionId}/reject`, auth(supervisor, { body: { note: '并发拒绝二，理由足够长。' } })),
    ]);
    const decisionStatuses = decisions.map((r) => r.status).sort();
    assert.deepEqual(decisionStatuses, [200, 409], '批准与拒绝并发时只允许一个成功');
    const finalRes = (await request('GET', '/api/supervisor/extensions', auth(supervisor))).data.extensions
      .find((e) => e.id === extensionId);
    assert.ok(['approved', 'rejected'].includes(finalRes.status));
    // 通知只各生成一条（用被分配处理人自己的会话查询）
    const resultNotifs = (await request('GET', '/api/processor/notifications', auth(processor))).data.notifications
      .filter((n) => n.objectionNo === objection.objectionNo
        && (n.kind === 'extension-approved' || n.kind === 'extension-rejected'));
    assert.equal(resultNotifs.length, 1, '并发决议不能产生两条互相矛盾的结果通知');

    await request('POST', `/api/processor/objections/${objection.objectionNo}/accept`, auth(processor, { body: {} }));
    await request('POST', `/api/processor/objections/${objection.objectionNo}/reject`, auth(processor, {
      body: { reason: '并发测试结束，驳回结案处理。' },
    }));
  });

  test('越权查看：处理人看不到他人通知；主管不能办理；办理人/处理人不能审计；审计员只读完整记录', async () => {
    const dave = await login('dave');
    const receipt = await completeWorkflow(dave);
    const objection = await createObjection(dave, receipt.receiptNo, '越权场景使用的一条异议记录。');
    const { createdAt } = objection;
    const processor = await assignedProcessor(objection.objectionNo);
    // 创建时刻触发 60 分钟提醒点，逾期时刻再触发 30 分钟提醒点与升级
    sweepAt(createdAt, 0);
    sweepAt(createdAt, HOUR + 1000);
    const otherProcessor = processor.username === 'processor1' ? await login('processor2') : await login('processor1');

    // 取处理人通知 id（逾期升级）
    const own = (await request('GET', '/api/processor/notifications', auth(processor))).data.notifications
      .find((n) => n.kind === 'overdue');
    assert.ok(own);

    // 未分配处理人确认已读 → 404（不暴露存在性）
    const crossRead = await request('POST', `/api/processor/notifications/${own.id}/read`,
      auth(otherProcessor, { body: {} }));
    assert.equal(crossRead.status, 404);
    assert.equal(crossRead.data.error.code, 'NOTIFICATION_NOT_FOUND');

    // 办理人不能确认处理人的通知（角色不匹配）
    const handlerRead = await request('POST', `/api/processor/notifications/${own.id}/read`, auth(dave, { body: {} }));
    assert.equal(handlerRead.status, 404);

    // 办理人用自己的已读接口也不能读处理人通知
    const ownerRead = await request('POST', `/api/receipt-objection-notifications/${own.id}/read`, auth(dave, { body: {} }));
    assert.equal(ownerRead.status, 404);

    // 处理人不能走主管审批接口 / 主管列表
    const processorExt = await request('GET', '/api/supervisor/extensions', auth(processor));
    assert.equal(processorExt.status, 404);
    // 主管不能办理（受理接口落到主管处理器 → 404）
    const supervisor = await login('supervisor1');
    const supervisorAccept = await request('POST', `/api/processor/objections/${objection.objectionNo}/accept`,
      auth(supervisor, { body: {} }));
    assert.equal(supervisorAccept.status, 404);
    // 主管不能访问办理人状态
    const supervisorState = await request('GET', '/api/receipt-objections', auth(supervisor));
    assert.equal(supervisorState.status, 404);

    // 办理人/处理人不能访问审计通知全集
    const handlerAudit = await request('GET', '/api/auditor/receipt-objection-notifications', auth(dave));
    assert.equal(handlerAudit.status, 404);
    const processorAudit = await request('GET', '/api/auditor/receipt-objection-notifications', auth(processor));
    assert.equal(processorAudit.status, 404);
    // 审计员不能写（确认已读落到审计只读处理器 → 404）
    const auditor = await login('auditor1');
    const auditorWrite = await request('POST', `/api/processor/notifications/${own.id}/read`, auth(auditor, { body: {} }));
    assert.equal(auditorWrite.status, 404);

    // 审计员可查看完整通知留痕与升级/延期记录
    const allNotifs = (await request('GET', '/api/auditor/receipt-objection-notifications', auth(auditor))).data.notifications;
    const mine = allNotifs.filter((n) => n.objectionNo === objection.objectionNo);
    // 2 个提醒点（60 分钟、30 分钟）× 2 接收方 + 2 个逾期升级（处理人+主管）= 6
    assert.equal(mine.length, 6);
    assert.ok(mine.every((n) => n.targetUser || n.audience === 'supervisor'));
    // 通知记录本身不含敏感字段（即使是审计视角）
    assert.ok(!JSON.stringify(mine).includes('ID-SECRET-99'));
    assert.ok(!JSON.stringify(mine).includes('升级路'));
    // 敏感完整值仍只能在异议冻结快照审计视图中按需获取
    const auditDetail = (await request('GET', `/api/auditor/receipt-objections/${objection.objectionNo}`, auth(auditor))).data.objection;
    assert.equal(auditDetail.fullSnapshot.applicant?.idNumber || auditDetail.fullSnapshot.steps[0].data.idNumber, 'ID-SECRET-99');
    // 审计异议详情含完整通知与延期摘要
    assert.equal(auditDetail.escalation.notifications.length, 6);

    await request('POST', `/api/processor/objections/${objection.objectionNo}/accept`, auth(processor, { body: {} }));
    await request('POST', `/api/processor/objections/${objection.objectionNo}/reject`, auth(processor, {
      body: { reason: '越权测试结束，驳回结案。' },
    }));
  });

  test('重启恢复：提醒状态、已读、逾期升级、延期审批在服务重启后完整一致，启动扫描不产生重复', async () => {
    const erin = await login('erin');
    const receipt = await completeWorkflow(erin);
    // erin 可能在更早用例中留下进行中异议（串行共享演示账号）：先终结它，保证拿到全新异议
    const preList = (await request('GET', `/api/receipt-objections?receiptNo=${encodeURIComponent(receipt.receiptNo)}`, auth(erin))).data.objections;
    for (const old of preList.filter((o) => ['submitted', 'accepted', 'supplementing'].includes(o.status))) {
      const oldProcessor = await assignedProcessor(old.objectionNo);
      if (old.status === 'submitted') {
        await request('POST', `/api/processor/objections/${old.objectionNo}/accept`, auth(oldProcessor, { body: {} }));
      }
      await request('POST', `/api/processor/objections/${old.objectionNo}/reject`, auth(oldProcessor, {
        body: { reason: '重启用例开始前关闭此前进行中的异议。' },
      }));
    }
    const objection = await createObjection(erin, receipt.receiptNo, '重启恢复验证用异议，需要保留全部通知状态。');
    const { createdAt } = objection;
    const processor = await assignedProcessor(objection.objectionNo);
    const supervisor = await login('supervisor1');

    // 生成第一提醒并由处理人已读
    sweepAt(createdAt, 0);
    const reminder = (await request('GET', '/api/processor/notifications?kind=reminder', auth(processor))).data.notifications
      .find((n) => n.objectionNo === objection.objectionNo);
    await request('POST', `/api/processor/notifications/${reminder.id}/read`, auth(processor, { body: {} }));
    // 逾期升级
    sweepAt(createdAt, HOUR + 2000);
    // 申请延期并批准
    const applied = await request('POST', `/api/processor/objections/${objection.objectionNo}/extension`,
      auth(processor, { body: { reason: '重启恢复测试需要延期，请主管批准这一次申请。' } }));
    const extensionId = applied.data.extension.id;
    const approved = await request('POST', `/api/supervisor/extensions/${extensionId}/approve`,
      auth(supervisor, { body: { note: '同意' } }));
    assert.equal(approved.status, 200);
    const newDeadline = approved.data.newDeadlineAt;

    const expectedEvents = (await request('GET', `/api/processor/objections/${objection.objectionNo}`, auth(processor)))
      .data.objection.events.map((e) => ({ type: e.type, ordinal: e.ordinal }));

    // 重启子进程（会执行启动恢复扫描）
    const child = await startRestartServer(process.env.DB_PATH, {
      OBJECTION_REMINDER_LEAD_MS: process.env.OBJECTION_REMINDER_LEAD_MS,
      OBJECTION_EXTENSION_MS: process.env.OBJECTION_EXTENSION_MS,
    });
    try {
      const loginRaw = await fetch(`${child.url}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'processor1', password: 'password123' }),
      });
      const loginData = await loginRaw.json();
      const cookies = loginRaw.headers.getSetCookie();
      const sid = /sid=([^;]+)/.exec(cookies.find((c) => c.startsWith('sid=')))[1];
      const csrf = /csrf=([^;]+)/.exec(cookies.find((c) => c.startsWith('csrf=')))[1];
      const pHeaders = { Cookie: `sid=${sid}`, 'X-CSRF-Token': csrf };

      // 重启后处理人仍能看到已读提醒与逾期升级状态
      const stateRes = await fetch(`${child.url}/api/state`, { headers: pHeaders });
      const stateData = await stateRes.json();
      assert.equal(stateData.unreadCount >= 0, true);
      const notifsRes = await fetch(`${child.url}/api/processor/notifications`, { headers: pHeaders });
      const notifsData = await notifsRes.json();
      const mine = notifsData.notifications.filter((n) => n.objectionNo === objection.objectionNo);
      const reminderAfter = mine.find((n) => n.kind === 'reminder' && n.audience === 'processor' && n.status === 'read');
      assert.ok(reminderAfter, '至少一条提醒的已读状态必须跨重启保留');
      assert.ok(reminderAfter.readAt);
      assert.ok(mine.some((n) => n.kind === 'overdue' && n.level === 1));

      // 截止时间为延期后的新值
      const detailRes = await fetch(`${child.url}/api/processor/objections/${objection.objectionNo}`, { headers: pHeaders });
      const detailData = await detailRes.json();
      assert.equal(detailData.objection.deadlineAt, newDeadline);
      assert.deepEqual(
        detailData.objection.events.map((e) => ({ type: e.type, ordinal: e.ordinal })),
        expectedEvents,
        '事件历史（含提醒/逾期/延期）重启后逐条一致且无新增',
      );

      // 主管待审批列表不含已决议申请；延期结论保留
      const supLogin = await fetch(`${child.url}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'supervisor1', password: 'password123' }),
      });
      const supData = await supLogin.json();
      const supCookies = supLogin.headers.getSetCookie();
      const supSid = /sid=([^;]+)/.exec(supCookies.find((c) => c.startsWith('sid=')))[1];
      const supCsrf = /csrf=([^;]+)/.exec(supCookies.find((c) => c.startsWith('csrf=')))[1];
      const supHeaders = { Cookie: `sid=${supSid}`, 'X-CSRF-Token': supCsrf };
      const pendingRes = await fetch(`${child.url}/api/supervisor/extensions?status=pending`, { headers: supHeaders });
      const pendingData = await pendingRes.json();
      assert.ok(!pendingData.extensions.some((e) => e.id === extensionId));
      const decidedRes = await fetch(`${child.url}/api/supervisor/extensions?status=approved`, { headers: supHeaders });
      const decidedData = await decidedRes.json();
      assert.ok(decidedData.extensions.some((e) => e.id === extensionId));

      // 重启扫描后通知数量不变（启动恢复不重复生成）
      const auditorLogin = await fetch(`${child.url}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'auditor2', password: 'password123' }),
      });
      const auditorData = await auditorLogin.json();
      const auditorCookies = auditorLogin.headers.getSetCookie();
      const aSid = /sid=([^;]+)/.exec(auditorCookies.find((c) => c.startsWith('sid=')))[1];
      const aCsrf = /csrf=([^;]+)/.exec(auditorCookies.find((c) => c.startsWith('csrf=')))[1];
      const auditRes = await fetch(
        `${child.url}/api/auditor/receipt-objection-notifications?objectionNo=${encodeURIComponent(objection.objectionNo)}`,
        { headers: { Cookie: `sid=${aSid}`, 'X-CSRF-Token': aCsrf } },
      );
      const auditData = await auditRes.json();
      // 2 提醒点 × 2 接收方（逾期扫描时 30 分钟点一并补入）
      // + 2 逾期 + 1 主管延期申请 + 2 决议结果（处理人+办理人）= 9
      assert.equal(auditData.notifications.length, 9, '重启恢复扫描不能重复生成通知');

      await stop(child);
    } finally {
      if (child.child.exitCode === null && child.child.signalCode === null) await stop(child);
    }
  });
});

function objectionNo(o) {
  return o.objectionNo;
}

async function startRestartServer(dbFile, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(process.cwd(), 'src', 'server.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DB_PATH: dbFile,
      RECEIPT_SECRET: process.env.RECEIPT_SECRET,
      RECEIPT_OBJECTION_TTL_MS: process.env.RECEIPT_OBJECTION_TTL_MS,
      VERIFY_RATE_MAX: '100',
      PORT: '0',
      NO_AUTO_LISTEN: '0',
      NO_BATCH_SWEEP: '1',
      ...extraEnv,
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
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`Server exited early with code ${code}: ${output}`));
    });
  });
  return { child, url };
}
async function stop(running) {
  if (!running) return;
  const child = running.child;
  // 进程已结束时 exitCode 或 signalCode 必有一个非空；否则 once('exit') 会永久等待
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await once(child, 'exit');
}

process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
});
test.after(async () => {
  server.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
});
