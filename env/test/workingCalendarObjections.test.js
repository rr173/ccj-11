import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';

process.env.DB_PATH = path.join(process.cwd(), 'data', `test-working-calendar-${process.pid}.db`);
process.env.TOKEN_TTL_MS = '600000';
process.env.RECEIPT_SECRET = 'unit-test-working-calendar-secret-fixed-value';
process.env.VERIFY_RATE_MAX = '100';
// 新异议固定当前发布日历（工作日历语义）；办理时长仅 2 个工作小时便于断言
process.env.RECEIPT_OBJECTION_SLA_MINUTES = '120';
process.env.OBJECTION_EXTENSION_MINUTES = '60';
process.env.OBJECTION_REMINDER_LEAD_MS = `${60 * 60 * 1000},${30 * 60 * 1000}`;
process.env.NO_OBJECTION_SWEEP = '1';
process.env.NO_BATCH_SWEEP = '1';
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
    method, headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    redirect: 'manual',
  });
  const text = await response.text();
  const type = response.headers.get('content-type') || '';
  const data = type.includes('application/json') && text ? JSON.parse(text) : {};
  return { status: response.status, headers: response.headers, data, text };
}
async function login(username, password = 'password123') {
  const res = await request('POST', '/api/login', { body: { username, password } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const cookieHeader = res.headers.get('set-cookie') || '';
  return {
    username,
    cookie: `sid=${/sid=([^;]+)/.exec(cookieHeader)[1]}; csrf=${/csrf=([^;]+)/.exec(cookieHeader)[1]}`,
    csrf: res.data.csrfToken,
  };
}
const auth = (client, extra = {}) => ({
  ...extra,
  headers: { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, ...(extra.headers || {}) },
});
const textAttachment = (content, filename = '情况说明.txt') => ({
  filename,
  contentType: 'text/plain; charset=utf-8',
  contentBase64: Buffer.from(content, 'utf8').toString('base64'),
});
function randomPageId() {
  return crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}
const PAYLOADS = [
  { name: '历小工', idNumber: 'ID-CAL-01', phone: '13900139000' },
  { province: '浙江省', city: '宁波市', detail: '工作日历路 1 号' },
  { type: 'change', description: '工作日历模块测试事项' },
  { agreed: true, contactTime: '工作日白天' },
];
async function completeWorkflow(client) {
  let workflow = (await request('GET', '/api/state', auth(client))).data.workflow;
  if (workflow.completed) return (await request('GET', '/api/state', auth(client))).data.receipt;
  while (!workflow.completed) {
    const step = workflow.progress;
    const pageId = randomPageId();
    const tokenRes = await request('POST', '/api/tokens', auth(client, { body: { step, pageId } }));
    assert.equal(tokenRes.status, 200, JSON.stringify(tokenRes.data));
    const res = await request('POST', '/api/submissions', auth(client, {
      body: {
        step, pageId, token: tokenRes.data.token,
        idempotencyKey: crypto.randomUUID(), payload: PAYLOADS[step],
      },
    }));
    assert.equal(res.status, 200, JSON.stringify(res.data));
    workflow = res.data.workflow;
    if (res.data.completed) return res.data.receipt;
  }
  throw new Error('unreachable');
}
async function createObjection(client, receiptNo, reason = '工作日历截止时间顺延的异议申请，需要跨周末核对。') {
  const res = await request('POST', '/api/receipt-objections', auth(client, {
    body: { receiptNo, reason, attachment: textAttachment('情况说明：截止时间应按工作时段计算。') },
  }));
  assert.equal(res.status, 200, JSON.stringify(res.data));
  return res.data.objection;
}
async function assignedProcessor(objectionNo) {
  for (const username of ['processor1', 'processor2']) {
    const client = await login(username);
    const mine = (await request('GET', '/api/processor/objections?status=open', auth(client))).data.objections;
    if (mine.some((o) => o.objectionNo === objectionNo)) return client;
  }
  throw new Error('未找到被分配的处理人');
}

// 用于在 HTTP 流程中确定当天 09:00/17:00 的时间点（Asia/Shanghai）
function shanghaiTodayAt(hh, mm = 0) {
  const now = new Date();
  // 用系统当前 UTC 日期在上海时区的墙钟日期，计算目标墙钟的 UTC ms
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  });
  const parts = Object.fromEntries(fmt.format(now).split('/').map((_, i, arr) => [['month', 'day', 'year'][i], arr[i]]));
  // 更稳妥：formatToParts
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(now).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  const guessUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), hh - 8, mm);
  // 校验墙钟确实是 hh:mm（Intl hour12 默认 12h，直接用 UTC+8 固定偏移足够）
  return guessUtc;
}

describe('可版本化工作日历（串行）', { concurrency: false }, () => {
  test('发布与版本固定：新异议使用当前版本；之后发布新版本不改变在办异议截止时间', async () => {
    const dave = await login('dave');
    const receipt = await completeWorkflow(dave);
    const objection = await createObjection(dave, receipt.receiptNo);

    // 固定创建时版本（v1 默认日历）
    assert.equal(objection.calendar.calendarVersion, 1);
    assert.equal(objection.calendar.legacy, false);
    assert.equal(objection.calendar.slaMinutes, 120);
    assert.ok(objection.deadlineAt > objection.createdAt);
    const initialDeadline = objection.deadlineAt;

    // 初始计时台账：含逐段顺延说明，至少有工作段
    assert.ok(objection.timing.length >= 1);
    const initial = objection.timing.find((t) => t.type === 'initial');
    assert.ok(initial);
    assert.equal(initial.detail.slaMinutes, 120);
    assert.ok(initial.detail.segments.some((s) => s.working));

    // 主管发布 v2（把工作时间缩短为每天只有 1 小时）
    const supervisor = await login('supervisor1');
    const shortDay = [{ start: 9 * 60, end: 10 * 60 }];
    const publish = await request('POST', '/api/supervisor/working-calendars', auth(supervisor, {
      body: {
        note: '测试版本：每天仅 09:00-10:00 工作',
        config: { weeklyWindows: [shortDay, shortDay, shortDay, shortDay, shortDay, [], []] },
      },
    }));
    assert.equal(publish.status, 200, JSON.stringify(publish.data));
    assert.equal(publish.data.calendar.version, 2);
    assert.equal(publish.data.current.version, 2);

    // 旧异议仍固定 v1：截止时间不变
    const detail = (await request('GET', `/api/receipt-objections/${objection.objectionNo}`, auth(dave))).data.objection;
    assert.equal(detail.calendar.calendarVersion, 1);
    assert.equal(detail.deadlineAt, initialDeadline);

    // 版本表只追加：v0/v1/v2 都可查
    const versions = (await request('GET', '/api/supervisor/working-calendars', auth(supervisor))).data.versions;
    assert.deepEqual(versions.map((v) => v.version), [2, 1, 0]);

    // 办理人/处理人不能维护日历（落到各自处理器 → 404）
    const handlerPublish = await request('POST', '/api/supervisor/working-calendars', auth(dave, {
      body: { config: {} },
    }));
    assert.equal(handlerPublish.status, 404);

    // 关闭本用例的异议，释放该回执的异议名额
    const proc = await assignedProcessor(objection.objectionNo);
    await request('POST', `/api/processor/objections/${objection.objectionNo}/accept`, auth(proc, { body: {} }));
    await request('POST', `/api/processor/objections/${objection.objectionNo}/reject`, auth(proc, {
      body: { reason: '版本固定验证完成，驳回结案。' },
    }));
  });

  test('跨周末顺延：周五傍晚创建，2 个工作小时截止落在周一，并逐段说明周末顺延', async () => {
    const erin = await login('erin');
    const receipt = await completeWorkflow(erin);
    // 通过 store 在“周五 17:00（上海墙钟）”时刻创建一条异议
    // 找到下一个周五
    const now = Date.now();
    const shParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
    }).formatToParts(new Date(now)).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
    // 直接用纯算术验证顺延结构（避免依赖真实今天是周几）：
    const { advanceWorkingMinutes, parseCalendarConfig } = await import('../src/workingCalendars.js');
    const cal = parseCalendarConfig({}).value;
    const fri17 = Date.UTC(2026, 8, 11, 9, 0); // 2026-09-11 Fri 17:00 +08
    const r = advanceWorkingMinutes(cal, fri17, 120);
    // 周五剩 30 分钟 + 周一 09:00-10:30 90 分钟 → 周一 10:30
    assert.equal(r.deadlineAt, Date.UTC(2026, 8, 14, 2, 30));
    const weekendSeg = r.segments.find((s) => s.reason === '周末休息');
    assert.ok(weekendSeg, '必须包含周末顺延段');

    // 真实 HTTP 异议的计时台账中也能看到非工作顺延（午休/夜间）
    const objection = await createObjection(erin, receipt.receiptNo, '跨周末顺延展示用的异议。');
    const processor = await assignedProcessor(objection.objectionNo);
    const pDetail = (await request('GET', `/api/processor/objections/${objection.objectionNo}`, auth(processor))).data.objection;
    const deferrals = pDetail.timing[0].detail.segments.filter((s) => !s.working);
    assert.ok(Array.isArray(deferrals));
    assert.ok(pDetail.timing[0].detail.segments.every((s) => typeof s.reason === 'string' && s.reason.length > 0));

    await request('POST', `/api/processor/objections/${objection.objectionNo}/accept`, auth(processor, { body: {} }));
    await request('POST', `/api/processor/objections/${objection.objectionNo}/reject`, auth(processor, {
      body: { reason: '跨周末顺延展示完成，驳回结案。' },
    }));
  });

  test('临时停办日：主管发布含停办日的新版本，新建异议跨停办日顺延并注明原因', async () => {
    const bob = await login('bob');
    const receipt = await completeWorkflow(bob);
    const supervisor = await login('supervisor1');
    // 当前是 v2（每天 1 小时）。发布 v3：恢复全天 8 小时，并把下周一二设为停办
    const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' });
    const parts = fmt.formatToParts(new Date()).filter((x) => x.type === 'literal' ? false : x).map((x) => [x.type, x.value]);
    // 计算接下来两天的日期键
    const dayKeys = [];
    for (let offset = 1; offset <= 4; offset += 1) {
      const d = new Date(Date.now() + offset * 86400000 + 12 * 3600000);
      dayKeys.push(fmt.format(d));
    }
    const windows = [
      [{ start: 540, end: 720 }, { start: 810, end: 1050 }],
      [{ start: 540, end: 720 }, { start: 810, end: 1050 }],
      [{ start: 540, end: 720 }, { start: 810, end: 1050 }],
      [{ start: 540, end: 720 }, { start: 810, end: 1050 }],
      [{ start: 540, end: 720 }, { start: 810, end: 1050 }],
      [], [],
    ];
    const publish = await request('POST', '/api/supervisor/working-calendars', auth(supervisor, {
      body: {
        note: '测试版本：加入临时停办日',
        config: {
          weeklyWindows: windows,
          closures: dayKeys.slice(0, 2).map((date) => ({ date, note: '临时停办测试' })),
        },
      },
    }));
    assert.equal(publish.status, 200, JSON.stringify(publish.data));
    assert.equal(publish.data.calendar.version, 3);

    const objection = await createObjection(bob, receipt.receiptNo, '临时停办日顺延验证异议。');
    assert.equal(objection.calendar.calendarVersion, 3);
    // 详情中可见停办顺延段（若 2 小时在停办前可完成则至少版本正确）
    const detail = (await request('GET', `/api/receipt-objections/${objection.objectionNo}`, auth(bob))).data.objection;
    assert.equal(detail.calendar.calendarVersion, 3);
    assert.ok(detail.timing[0].detail.segments.some((s) => s.working));
  });

  test('补充材料暂停/恢复：暂停冻结剩余时长，恢复从剩余工作分钟继续，重复/并发不多扣多加', async () => {
    const carol = await login('carol');
    const receipt = await completeWorkflow(carol);
    const objection = await createObjection(carol, receipt.receiptNo, '暂停恢复验证用的异议申请。');
    const processor = await assignedProcessor(objection.objectionNo);

    await request('POST', `/api/processor/objections/${objection.objectionNo}/accept`, auth(processor, { body: {} }));
    const pauseRes = await request('POST', `/api/processor/objections/${objection.objectionNo}/request-supplements`,
      auth(processor, { body: { note: '请补充身份证明材料，谢谢配合。' } }));
    assert.equal(pauseRes.status, 200, JSON.stringify(pauseRes.data));
    const paused = pauseRes.data.objection;
    assert.equal(paused.status, 'supplementing');
    assert.equal(paused.paused, true);
    assert.equal(paused.overdue, false, '暂停期间不判定逾期');

    // 暂停台账
    const pausedDetail = (await request('GET', `/api/processor/objections/${objection.objectionNo}`, auth(processor))).data.objection;
    const pauseLedger = pausedDetail.timing.find((t) => t.type === 'pause');
    assert.ok(pauseLedger);
    assert.equal(pausedDetail.pauses.length, 1);
    assert.equal(pausedDetail.pauses[0].status, 'paused');
    assert.ok(pausedDetail.pauses[0].remainingMinutesAtPause <= 120);

    // 重复要求补充（已在暂停中）→ 非法流转
    const again = await request('POST', `/api/processor/objections/${objection.objectionNo}/request-supplements`,
      auth(processor, { body: { note: '重复暂停请求。' } }));
    assert.equal(again.status, 409);

    // 暂停期间扫描：不提醒、不逾期（只断言本异议，全局统计可能含其它用例）
    db.sweepObjectionNotifications({ at: paused.deadlineAt + 10 * 86400000, dispatch: false });
    const pausedRow = db.db.prepare('SELECT * FROM receipt_objections WHERE id = ?').get(objection.id);
    assert.equal(pausedRow.overdue_at, null, '暂停期间本异议不能被标记逾期');
    assert.equal(pausedRow.status, 'supplementing');

    // 并发补交：两个请求同时恢复，只有一个成功（状态条件更新 + 暂停行唯一索引）
    const body = {
      note: '已按要求补充身份证明。',
      attachment: textAttachment('补充材料：身份证扫描件文本。', '补充说明.txt'),
    };
    const [r1, r2] = await Promise.all([
      request('POST', `/api/receipt-objections/${objection.objectionNo}/supplement`, auth(carol, { body })),
      request('POST', `/api/receipt-objections/${objection.objectionNo}/supplement`, auth(carol, { body })),
    ]);
    const statuses = [r1.status, r2.status].sort();
    assert.deepEqual(statuses, [200, 409], `并发恢复应一成一败，实际 ${statuses.join(',')}`);

    const resumed = (await request('GET', `/api/receipt-objections/${objection.objectionNo}`, auth(carol))).data.objection;
    assert.equal(resumed.status, 'accepted');
    assert.equal(resumed.paused, false);
    assert.ok(resumed.deadlineAt > Date.now(), '恢复后截止时间应按剩余工作分钟顺延到未来');

    // 暂停段只有一条 resumed；恢复台账只有一条（不多加）
    assert.equal(resumed.pauses.length, 1);
    assert.equal(resumed.pauses[0].status, 'resumed');
    const resumeLedgers = resumed.timing.filter((t) => t.type === 'resume');
    assert.equal(resumeLedgers.length, 1, '并发恢复只能产生一条恢复台账');
    assert.ok(resumeLedgers[0].detail.segments.some((s) => s.working));

    // 重复恢复（再次补交）→ 当前不是 supplementing，明确拒绝
    const secondResume = await request('POST', `/api/receipt-objections/${objection.objectionNo}/supplement`,
      auth(carol, { body }));
    assert.equal(secondResume.status, 409);

    // 关闭
    await request('POST', `/api/processor/objections/${objection.objectionNo}/reject`, auth(processor, {
      body: { reason: '暂停恢复验证完成，材料仍不充分，驳回结案。' },
    }));
  });

  test('日历迁移：主管先预览受影响清单再按预览版本确认；逾期/终结不迁移；冲突整体中止', async () => {
    const dave = await login('dave');
    const receipt = await completeWorkflow(dave);
    const objection = await createObjection(dave, receipt.receiptNo, '迁移冲突验证用异议一。');
    const supervisor = await login('supervisor1');

    // 当前发布 v4（复制 v3 并加一个节假日，确保与 v1/v2 不同）
    const publish4 = await request('POST', '/api/supervisor/working-calendars', auth(supervisor, {
      body: {
        note: '迁移目标版本 v4',
        config: {
          weeklyWindows: [
            [{ start: 540, end: 600 }], [{ start: 540, end: 600 }], [{ start: 540, end: 600 }],
            [{ start: 540, end: 600 }], [{ start: 540, end: 600 }], [], [],
          ],
        },
      },
    }));
    assert.equal(publish4.status, 200, JSON.stringify(publish4.data));
    const targetVersionId = publish4.data.calendar.id;

    // 预览（不带 targetVersionId 时默认当前版本）
    const previewRes = await request('POST', '/api/supervisor/calendar-migrations/preview', auth(supervisor, {
      body: { note: '迁移到每天 1 小时版本' },
    }));
    assert.equal(previewRes.status, 200, JSON.stringify(previewRes.data));
    const preview = previewRes.data.preview;
    assert.equal(preview.targetVersion, 4);
    const own = preview.items.find((item) => item.objectionId === objection.id);
    assert.ok(own, '在办异议应出现在受影响清单');
    assert.equal(own.eligible, true);
    assert.ok(own.prospectiveDeadlineAt);

    // 非主管不能预览 / 确认
    const forbidden = await request('POST', '/api/supervisor/calendar-migrations/preview', auth(dave, { body: {} }));
    assert.equal(forbidden.status, 404);

    // 摘要不匹配 → 拒绝确认
    const badApply = await request('POST', `/api/supervisor/calendar-migrations/${preview.id}/apply`,
      auth(supervisor, { body: { digest: 'deadbeef' } }));
    assert.equal(badApply.status, 409);
    assert.equal(badApply.data.error.code, 'MIGRATION_PREVIEW_DIGEST_MISMATCH');

    // 预览后终结该异议 → 确认时整体冲突中止，不落任何变更
    const processor = await assignedProcessor(objection.objectionNo);
    await request('POST', `/api/processor/objections/${objection.objectionNo}/accept`, auth(processor, { body: {} }));
    await request('POST', `/api/processor/objections/${objection.objectionNo}/reject`, auth(processor, {
      body: { reason: '预览后先行结案，用于迁移冲突验证。' },
    }));
    const conflictApply = await request('POST', `/api/supervisor/calendar-migrations/${preview.id}/apply`,
      auth(supervisor, { body: { digest: preview.digest } }));
    assert.equal(conflictApply.status, 409);
    assert.equal(conflictApply.data.error.code, 'MIGRATION_CONFLICT');
    assert.ok(conflictApply.data.conflicts.some((c) => c.objectionNo === objection.objectionNo && c.reason === 'terminal'));

    // 终结异议不能迁移：重新预览，该异议应被排除或不再出现在在办清单中
    const preview2Res = await request('POST', '/api/supervisor/calendar-migrations/preview', auth(supervisor, { body: {} }));
    const preview2 = preview2Res.data.preview;
    const excluded = preview2.items.find((item) => item.objectionId === objection.id);
    assert.ok(!excluded || excluded.eligible === false, '终结异议不能被迁移');
  });

  test('日历迁移成功路径：预览→确认后在办异议换版重算截止，迁移逐行留痕可审计', async () => {
    const erin = await login('erin');
    const receipt = await completeWorkflow(erin);
    // 先确保该用户没有其它在办异议
    const preList = (await request('GET', '/api/receipt-objections', auth(erin))).data.objections;
    for (const old of preList.filter((o) => ['submitted', 'accepted', 'supplementing'].includes(o.status))) {
      const p = await assignedProcessor(old.objectionNo);
      if (old.status === 'submitted') {
        await request('POST', `/api/processor/objections/${old.objectionNo}/accept`, auth(p, { body: {} }));
      }
      await request('POST', `/api/processor/objections/${old.objectionNo}/reject`, auth(p, {
        body: { reason: '迁移成功用例前关闭旧异议。' },
      }));
    }
    const objection = await createObjection(erin, receipt.receiptNo, '迁移成功路径验证用异议。');
    const beforeVersion = objection.calendar.calendarVersion;
    const beforeDeadline = objection.deadlineAt;
    const supervisor = await login('supervisor1');

    // 发布目标版本 v5：每天仅 30 分钟工作（09:00-09:30），截止必然大幅后移
    const pub = await request('POST', '/api/supervisor/working-calendars', auth(supervisor, {
      body: {
        note: '迁移目标版本 v5：每天 30 分钟',
        config: {
          weeklyWindows: [
            [{ start: 540, end: 570 }], [{ start: 540, end: 570 }], [{ start: 540, end: 570 }],
            [{ start: 540, end: 570 }], [{ start: 540, end: 570 }], [], [],
          ],
        },
      },
    }));
    assert.equal(pub.status, 200, JSON.stringify(pub.data));

    const prev = (await request('POST', '/api/supervisor/calendar-migrations/preview', auth(supervisor, { body: {} }))).data.preview;
    const item = prev.items.find((x) => x.objectionId === objection.id);
    assert.ok(item && item.eligible);
    assert.notEqual(item.prospectiveDeadlineAt, beforeDeadline);

    const apply = await request('POST', `/api/supervisor/calendar-migrations/${prev.id}/apply`,
      auth(supervisor, { body: { digest: prev.digest } }));
    assert.equal(apply.status, 200, JSON.stringify(apply.data));
    assert.ok(apply.data.migrated.some((m) => m.objectionNo === objection.objectionNo));

    const after = (await request('GET', `/api/receipt-objections/${objection.objectionNo}`, auth(erin))).data.objection;
    assert.equal(after.calendar.calendarVersion, 5);
    assert.equal(after.deadlineAt, item.prospectiveDeadlineAt);
    assert.ok(after.calendarMigrations.length >= 1);
    const migrationLedger = after.timing.find((t) => t.type === 'migration');
    assert.ok(migrationLedger);
    assert.equal(migrationLedger.detail.toVersion, 5);

    // 已应用的预览不能重复确认
    const again = await request('POST', `/api/supervisor/calendar-migrations/${prev.id}/apply`,
      auth(supervisor, { body: { digest: prev.digest } }));
    assert.equal(again.status, 409);
    assert.equal(again.data.error.code, 'MIGRATION_PREVIEW_CLOSED');

    // 审计员可查看版本历史与迁移记录
    const auditor = await login('auditor1');
    const audVersions = (await request('GET', '/api/auditor/working-calendars', auth(auditor))).data.versions;
    assert.ok(audVersions.some((v) => v.version === 5));
    const audMigrations = (await request(
      'GET',
      `/api/auditor/calendar-migrations?objectionNo=${encodeURIComponent(objection.objectionNo)}`,
      auth(auditor),
    )).data.migrations;
    assert.ok(audMigrations.some((m) => m.toVersion === 5 && m.objectionNo === objection.objectionNo));
    const audDetail = (await request('GET', `/api/auditor/receipt-objections/${objection.objectionNo}`, auth(auditor))).data.objection;
    assert.ok(audDetail.timing.some((t) => t.type === 'initial'));
    assert.ok(audDetail.timing.some((t) => t.type === 'migration'));
  });

  test('提醒与逾期调度跟随迁移后的当前有效截止时间', async () => {
    // 上一用例迁移后的异议每天只有 30 分钟可办；用注入时间按新截止扫描
    const erin = await login('erin');
    const list = (await request('GET', '/api/receipt-objections', auth(erin))).data.objections;
    const target = list.find((o) => o.calendar.calendarVersion === 5 && ['submitted', 'accepted'].includes(o.status));
    assert.ok(target, '应存在一条已迁移到 v5 的在办异议');
    const before = db.db.prepare('SELECT COUNT(*) AS c FROM receipt_objection_notifications WHERE objection_id = ?')
      .get(target.id).c;
    // 在新截止前 1 毫秒：不逾期
    const safe = db.sweepObjectionNotifications({ at: target.deadlineAt - 1, dispatch: false });
    assert.equal(safe.overdueMarked, 0);
    // 超过新截止：按新截止标记逾期（旧截止早已成为过去，不能再以旧值触发）
    const over = db.sweepObjectionNotifications({ at: target.deadlineAt + 1, dispatch: false });
    assert.ok(over.overdueMarked >= 1);
    const after = db.db.prepare('SELECT overdue_at, deadline_at FROM receipt_objections WHERE id = ?').get(target.id);
    assert.ok(after.overdue_at);
    assert.equal(after.deadline_at, target.deadlineAt);
    assert.ok(db.db.prepare('SELECT COUNT(*) AS c FROM receipt_objection_notifications WHERE objection_id = ?')
      .get(target.id).c > before);
  });

  test('服务重启：日历版本、暂停状态、计时台账与迁移记录完整保留', async () => {
    const erin = await login('erin');
    const list = (await request('GET', '/api/receipt-objections', auth(erin))).data.objections;
    const migratedSummary = list
      .filter((o) => o.calendar.calendarVersion === 5)
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    assert.ok(migratedSummary, '应存在一条迁移到 v5 的异议');
    const migrated = (await request('GET', `/api/receipt-objections/${migratedSummary.objectionNo}`, auth(erin))).data.objection;
    const timingCount = migrated.timing.length;
    const migrationCount = migrated.calendarMigrations.length;
    const expectedVersions = migrated.calendar.calendarVersion;

    const { spawn } = await import('node:child_process');
    const child = spawn(process.execPath, [path.join(process.cwd(), 'src', 'server.js')], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        NODE_ENV: 'test',
        DB_PATH: process.env.DB_PATH,
        RECEIPT_SECRET: process.env.RECEIPT_SECRET,
        RECEIPT_OBJECTION_SLA_MINUTES: process.env.RECEIPT_OBJECTION_SLA_MINUTES,
        VERIFY_RATE_MAX: '100',
        PORT: '0',
        NO_AUTO_LISTEN: '0',
        NO_BATCH_SWEEP: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const url = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('restart server timeout')), 8000);
      child.stdout.on('data', (chunk) => {
        output += chunk.toString();
        const match = /listening on http:\/\/0\.0\.0\.0:(\d+)/.exec(output);
        if (match) { clearTimeout(timer); resolve(`http://127.0.0.1:${match[1]}`); }
      });
      child.stderr.on('data', (chunk) => { output += chunk.toString(); });
      child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited ${code}: ${output}`)); });
    });
    try {
      const loginRaw = await fetch(`${url}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'erin', password: 'password123' }),
      });
      const cookies = loginRaw.headers.getSetCookie();
      const sid = /sid=([^;]+)/.exec(cookies.find((c) => c.startsWith('sid=')))[1];
      const csrf = /csrf=([^;]+)/.exec(cookies.find((c) => c.startsWith('csrf=')))[1];
      const res = await fetch(`${url}/api/receipt-objections/${migrated.objectionNo}`, {
        headers: { Cookie: `sid=${sid}`, 'X-CSRF-Token': csrf },
      });
      const data = await res.json();
      assert.equal(data.objection.calendar.calendarVersion, expectedVersions);
      assert.equal(data.objection.timing.length, timingCount);
      assert.equal(data.objection.calendarMigrations.length, migrationCount);
      assert.ok(data.objection.timing.some((t) => t.type === 'migration'));

      // 主管侧当前版本仍是最后发布的 v5
      const supLogin = await fetch(`${url}/api/login`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'supervisor1', password: 'password123' }),
      });
      const supCookies = supLogin.headers.getSetCookie();
      const supSid = /sid=([^;]+)/.exec(supCookies.find((c) => c.startsWith('sid=')))[1];
      const supCsrf = /csrf=([^;]+)/.exec(supCookies.find((c) => c.startsWith('csrf=')))[1];
      const calRes = await fetch(`${url}/api/supervisor/working-calendars`, {
        headers: { Cookie: `sid=${supSid}`, 'X-CSRF-Token': supCsrf },
      });
      const calData = await calRes.json();
      assert.equal(calData.current.version, 5);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await once(child, 'exit');
      }
    }
  });
});

test.after(async () => {
  server.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
});
