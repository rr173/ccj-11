import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';

process.env.DB_PATH = path.join(process.cwd(), 'data', `test-objection-${process.pid}.db`);
process.env.TOKEN_TTL_MS = '600000';
process.env.RECEIPT_SECRET = 'unit-test-objection-secret-fixed-value';
process.env.VERIFY_RATE_MAX = '100';
process.env.RECEIPT_OBJECTION_TTL_MS = String(7 * 24 * 60 * 60 * 1000);
// 本用例验证既有“自然日期限”语义：新异议固定全天 v0 日历
process.env.CALENDAR_LEGACY_DEFAULT = '1';
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
  { name: '李明明', idNumber: 'ID-SECRET-77', phone: '13700137000' },
  { province: '浙江省', city: '杭州市', detail: '文三路 88 号异议大厦' },
  { type: 'change', description: '异议模块测试事项' },
  { agreed: true, contactTime: '工作日白天' },
];

function randomPageId() {
  return crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}

function textAttachment(content, filename = '情况说明.txt') {
  return {
    filename,
    contentType: 'text/plain; charset=utf-8',
    contentBase64: Buffer.from(content, 'utf8').toString('base64'),
  };
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

async function createObjectionApi(client, receiptNo, bodyOverride = {}) {
  return request('POST', '/api/receipt-objections', auth(client, {
    body: {
      receiptNo,
      reason: '回执内容与实际办理情况不符，申请核查并撤销该回执。',
      attachment: textAttachment('本人承诺所说明情况属实：回执记载的手机号有误。'),
      ...bodyOverride,
    },
  }));
}

// 处理人按“最少在办数”自动分配；测试中动态查出异议实际分配给了哪个处理人
async function assignedProcessor(objectionNo) {
  const p1 = await login('processor1');
  const mine1 = (await request('GET', '/api/processor/objections?status=open', auth(p1))).data.objections;
  if (mine1.some((o) => o.objectionNo === objectionNo)) return p1;
  const p2 = await login('processor2');
  const mine2 = (await request('GET', '/api/processor/objections?status=open', auth(p2))).data.objections;
  if (mine2.some((o) => o.objectionNo === objectionNo)) return p2;
  // 已终结时在全量列表中查找
  const all1 = (await request('GET', '/api/processor/objections', auth(p1))).data.objections;
  if (all1.some((o) => o.objectionNo === objectionNo)) return p1;
  const all2 = (await request('GET', '/api/processor/objections', auth(p2))).data.objections;
  if (all2.some((o) => o.objectionNo === objectionNo)) return p2;
  throw new Error(`异议 ${objectionNo} 未找到被分配的处理人`);
}

async function processorPost(processor, objectionNo, action, body = {}) {
  return request('POST', `/api/processor/objections/${objectionNo}/${action}`, auth(processor, { body }));
}

// 所有用例串行执行：共享演示账号与自动分配逻辑，避免并发用例相互占用
// “同一回执至多一条进行中异议”的名额
describe('回执撤销与异议处理（串行）', { concurrency: false }, () => {
  test('未登录不能发起异议；办理人发起成功后得到异议编号、状态、处理期限与冻结快照', async () => {
    const dave = await login('dave');
    const { receipt } = await completeWorkflow(dave);

    const noAuth = await request('POST', '/api/receipt-objections', {
      body: { receiptNo: receipt.receiptNo, reason: 'x'.repeat(10), attachment: textAttachment('说明') },
    });
    assert.equal(noAuth.status, 401);

    const created = await createObjectionApi(dave, receipt.receiptNo);
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const objection = created.data.objection;
    assert.match(objection.objectionNo, /^YY-\d{8}-[0-9A-Z]{8}$/);
    assert.equal(objection.status, 'submitted');
    assert.equal(objection.statusLabel, '待受理');
    assert.ok(objection.deadlineAt > objection.createdAt, '必须返回处理期限');
    assert.equal(objection.deadlineAt - objection.createdAt, 7 * 24 * 60 * 60 * 1000);
    assert.equal(objection.receiptNo, receipt.receiptNo);
    assert.ok(objection.snapshotDigest, '冻结快照应有摘要');
    assert.equal(objection.materials.length, 1);
    assert.equal(objection.materials[0].filename, '情况说明.txt');
    assert.equal(objection.materials[0].sizeBytes, Buffer.byteLength('本人承诺所说明情况属实：回执记载的手机号有误。'));
    assert.equal(objection.events.length, 1);
    assert.equal(objection.events[0].type, 'receipt.objection.submitted');
    assert.equal(objection.events[0].toStatus, 'submitted');
    assert.equal(objection.events[0].actorRole, 'handler');

    // 终结该异议（受理→驳回），释放名额给后续用例；顺带验证处理人被自动分配
    const processor = await assignedProcessor(objection.objectionNo);
    const accept = await processorPost(processor, objection.objectionNo, 'accept', {});
    assert.equal(accept.status, 200);
    const reject = await processorPost(processor, objection.objectionNo, 'reject', {
      reason: '经核查异议不成立，驳回该撤销申请。',
    });
    assert.equal(reject.status, 200);
  });

  test('无权回执、不存在的回执、已撤销回执不能发起异议', async () => {
    const dave = await login('dave');
    const erin = await login('erin');
    const { receipt: daveReceipt } = await completeWorkflow(dave);
    await completeWorkflow(erin);

    // 他人回执
    const cross = await createObjectionApi(erin, daveReceipt.receiptNo);
    assert.equal(cross.status, 404);
    assert.equal(cross.data.error.code, 'RECEIPT_NOT_FOUND');

    // 不存在的编号
    const missing = await createObjectionApi(dave, 'HZ-20000101-ZZZZZZZZ');
    assert.equal(missing.status, 404);
    assert.equal(missing.data.error.code, 'RECEIPT_NOT_FOUND');

    // 办理人自行撤销回执后不能再发起异议（存在进行中异议也不影响本人撤销）
    const revoke = await request('POST', `/api/receipts/${encodeURIComponent(daveReceipt.receiptNo)}?action=revoke`, auth(dave, {
      body: { reason: '本人申请作废' },
    }));
    assert.equal(revoke.status, 200);
    const onRevoked = await createObjectionApi(dave, daveReceipt.receiptNo);
    assert.equal(onRevoked.status, 409);
    assert.equal(onRevoked.data.error.code, 'RECEIPT_REVOKED');
  });

  test('同一回执不能同时存在两份进行中的异议；终态后可再次发起', async () => {
    const alice = await login('alice');
    const { receipt } = await completeWorkflow(alice);

    const first = await createObjectionApi(alice, receipt.receiptNo);
    assert.equal(first.status, 200, JSON.stringify(first.data));

    const second = await createObjectionApi(alice, receipt.receiptNo);
    assert.equal(second.status, 409);
    assert.equal(second.data.error.code, 'OBJECTION_IN_PROGRESS');
    assert.equal(second.data.objectionNo, first.data.objection.objectionNo);

    const processor = await assignedProcessor(first.data.objection.objectionNo);
    const accept = await processorPost(processor, first.data.objection.objectionNo, 'accept', {});
    assert.equal(accept.status, 200, JSON.stringify(accept.data));
    const reject = await processorPost(processor, first.data.objection.objectionNo, 'reject', {
      reason: '经核查回执内容与办理记录一致，不予撤销。',
    });
    assert.equal(reject.status, 200, JSON.stringify(reject.data));
    assert.equal(reject.data.objection.status, 'rejected');

    // 终态后允许再次发起
    const third = await createObjectionApi(alice, receipt.receiptNo);
    assert.equal(third.status, 200, JSON.stringify(third.data));
    assert.notEqual(third.data.objection.objectionNo, first.data.objection.objectionNo);

    // 终结第三条，释放“进行中”名额给后续用例
    const processor2 = await assignedProcessor(third.data.objection.objectionNo);
    await processorPost(processor2, third.data.objection.objectionNo, 'accept', {});
    const reject2 = await processorPost(processor2, third.data.objection.objectionNo, 'reject', {
      reason: '补充事实仍不足以支持撤销，再次驳回。',
    });
    assert.equal(reject2.status, 200, JSON.stringify(reject2.data));
  });

  test('处理人只能看到被分配的异议与脱敏回执内容；未分配处理人 404', async () => {
    const bob = await login('bob');
    const { receipt } = await completeWorkflow(bob);
    const created = await createObjectionApi(bob, receipt.receiptNo, {
      reason: '手机号登记错误，请核实后撤销并重办。',
    });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const objectionNo = created.data.objection.objectionNo;

    const processors = [await login('processor1'), await login('processor2')];
    const assigned = [];
    const unassigned = [];
    for (const p of processors) {
      const detail = await request('GET', `/api/processor/objections/${objectionNo}`, auth(p));
      if (detail.status === 200) assigned.push({ p, detail });
      else {
        assert.equal(detail.status, 404);
        assert.equal(detail.data.error.code, 'OBJECTION_NOT_FOUND');
        unassigned.push(p);
      }
    }
    assert.equal(assigned.length, 1, '恰有一个被分配处理人');
    assert.equal(unassigned.length, 1);

    // 被分配处理人看到的是脱敏回执，不泄露证件号/完整地址/完整手机号
    const { detail } = assigned[0];
    const serialized = JSON.stringify(detail.data.objection);
    assert.ok(!serialized.includes('ID-SECRET-77'), '处理人视图不得泄露证件号');
    assert.ok(!serialized.includes('文三路'), '处理人视图不得泄露详细地址');
    assert.ok(!/13700137000/.test(serialized), '处理人视图不得泄露完整手机号');
    const nameField = detail.data.objection.maskedReceipt.steps[0].fields.find((f) => f.field === 'name');
    assert.equal(nameField.value, '李*明');
    const phoneField = detail.data.objection.maskedReceipt.steps[0].fields.find((f) => f.field === 'phone');
    assert.equal(phoneField.value, '137****7000');
    // 处理人可读取文本说明原文
    assert.equal(detail.data.objection.materials[0].content, '本人承诺所说明情况属实：回执记载的手机号有误。');

    // 办理人在自己的列表/详情中也只能看到脱敏申请人
    const ownerList = await request('GET', `/api/receipt-objections?receiptNo=${encodeURIComponent(receipt.receiptNo)}`, auth(bob));
    assert.equal(ownerList.status, 200);
    assert.ok(!JSON.stringify(ownerList.data).includes('ID-SECRET-77'));
    const ownerDetail = await request('GET', `/api/receipt-objections/${objectionNo}`, auth(bob));
    assert.equal(ownerDetail.status, 200);
    assert.ok(!JSON.stringify(ownerDetail.data).includes('ID-SECRET-77'));
    // 列表不含材料正文（只有摘要）
    assert.ok(ownerList.data.objections.every((o) => o.materials === undefined || o.materials.every((m) => m.content === undefined)));

    // 终结该异议，释放名额
    const processor = assigned[0].p;
    await processorPost(processor, objectionNo, 'accept', {});
    const reject = await processorPost(processor, objectionNo, 'reject', { reason: '经核查不存在登记错误，予以驳回。' });
    assert.equal(reject.status, 200, JSON.stringify(reject.data));
  });

  test('状态机：受理→补充材料→补充→确认撤销 全链路，原回执核验返回已撤销但快照可审计', async () => {
    const carol = await login('carol');
    const { receipt } = await completeWorkflow(carol);
    const created = await createObjectionApi(carol, receipt.receiptNo);
    assert.equal(created.status, 200);
    const objectionNo = created.data.objection.objectionNo;
    const code = receipt.code;

    const processor = await assignedProcessor(objectionNo);

    // 未受理不能驳回/确认撤销/要求补充
    for (const action of ['reject', 'confirm-revocation', 'request-supplements']) {
      const res = await processorPost(processor, objectionNo, action, { reason: '测试非法跳转', note: '测试非法跳转' });
      assert.equal(res.status, 409, `${action} 不应在 submitted 状态成功`);
      assert.equal(res.data.error.code, 'OBJECTION_INVALID_TRANSITION');
    }

    // 受理
    const accept = await processorPost(processor, objectionNo, 'accept', {});
    assert.equal(accept.status, 200, JSON.stringify(accept.data));
    assert.equal(accept.data.objection.status, 'accepted');

    // 已受理不能重复受理
    const acceptAgain = await processorPost(processor, objectionNo, 'accept', {});
    assert.equal(acceptAgain.status, 409);
    assert.equal(acceptAgain.data.error.code, 'OBJECTION_INVALID_TRANSITION');

    // 要求补充材料（必须给说明）
    const noNote = await processorPost(processor, objectionNo, 'request-supplements', { note: '' });
    assert.equal(noNote.status, 400);
    const requestSupplements = await processorPost(processor, objectionNo, 'request-supplements', {
      note: '请补充能证明手机号的凭证文字说明',
    });
    assert.equal(requestSupplements.status, 200, JSON.stringify(requestSupplements.data));
    assert.equal(requestSupplements.data.objection.status, 'supplementing');

    // 处理人在 supplementing 不能确认撤销（必须先回到受理）
    const badConfirm = await processorPost(processor, objectionNo, 'confirm-revocation', {});
    assert.equal(badConfirm.status, 409);
    assert.equal(badConfirm.data.error.code, 'OBJECTION_INVALID_TRANSITION');

    // 他人不能补充；本人补充时必须上传文本与说明
    const bob = await login('bob');
    const crossSupplement = await request('POST', `/api/receipt-objections/${objectionNo}/supplement`, auth(bob, {
      body: { attachment: textAttachment('恶意补充'), note: '补充' },
    }));
    assert.equal(crossSupplement.status, 404);

    const badAttachment = await request('POST', `/api/receipt-objections/${objectionNo}/supplement`, auth(carol, {
      body: { attachment: { filename: 'proof.png', contentType: 'image/png', contentBase64: Buffer.from('x').toString('base64') }, note: '补充' },
    }));
    assert.equal(badAttachment.status, 400);
    assert.equal(badAttachment.data.error.code, 'ATTACHMENT_NOT_TEXT');

    const noNoteSupplement = await request('POST', `/api/receipt-objections/${objectionNo}/supplement`, auth(carol, {
      body: { attachment: textAttachment('补充内容'), note: '' },
    }));
    assert.equal(noNoteSupplement.status, 400);

    const supplement = await request('POST', `/api/receipt-objections/${objectionNo}/supplement`, auth(carol, {
      body: {
        attachment: textAttachment('补充说明：本人手机号实际为 13911112222，附运营商受理单文字摘录。', '补充凭证.txt'),
        note: '已按要求补充凭证说明',
      },
    }));
    assert.equal(supplement.status, 200, JSON.stringify(supplement.data));
    assert.equal(supplement.data.objection.status, 'accepted');
    assert.equal(supplement.data.objection.materials.length, 2);

    // 确认撤销：原回执核验接口必须返回已撤销
    const confirm = await processorPost(processor, objectionNo, 'confirm-revocation', {
      reason: '情况属实，确认撤销该回执。',
    });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.data));
    assert.equal(confirm.data.objection.status, 'revoked');
    assert.equal(confirm.data.receiptStatus, 'revoked');

    // 免登录核验返回 410 RECEIPT_REVOKED
    const verify = await request('POST', '/api/verify', { body: { receiptNo: receipt.receiptNo, code } });
    assert.equal(verify.status, 410);
    assert.equal(verify.data.error.code, 'RECEIPT_REVOKED');

    // 已处理异议不能重复受理或重复确认
    const repeated = await processorPost(processor, objectionNo, 'accept', {});
    assert.equal(repeated.status, 409);
    assert.equal(repeated.data.error.code, 'OBJECTION_ALREADY_HANDLED');
    const repeatedConfirm = await processorPost(processor, objectionNo, 'confirm-revocation', {});
    assert.equal(repeatedConfirm.status, 409);

    // 审计员可以查看完整冻结快照（含原始敏感值）、材料原文与完整时间线
    const auditor = await login('auditor2');
    const auditDetail = await request('GET', `/api/auditor/receipt-objections/${objectionNo}`, auth(auditor));
    assert.equal(auditDetail.status, 200, JSON.stringify(auditDetail.data));
    const auditSerialized = JSON.stringify(auditDetail.data.objection);
    assert.ok(auditSerialized.includes('ID-SECRET-77'), '审计视图应包含完整证件号');
    assert.ok(auditSerialized.includes('文三路'), '审计视图应包含完整地址');
    assert.ok(/13700137000/.test(auditSerialized), '审计视图应包含完整手机号');
    assert.equal(auditDetail.data.objection.currentReceiptStatus, 'revoked');
    assert.ok(auditDetail.data.objection.materials.every((m) => m.content));
    const types = auditDetail.data.objection.events.map((e) => e.type);
    assert.deepEqual(types, [
      'receipt.objection.submitted',
      'receipt.objection.accepted',
      'receipt.objection.supplement-requested',
      'receipt.objection.supplemented',
      'receipt.objection.revocation-confirmed',
    ]);
    // 每个事件都有操作人、时间、前后状态；历史不可覆盖（顺序连续）
    auditDetail.data.objection.events.forEach((event, index) => {
      assert.equal(event.ordinal, index);
      assert.ok(event.at);
      assert.ok(event.actorRole);
      if (index > 0) assert.ok(event.fromStatus);
      assert.ok(event.toStatus);
    });
  });

  test('驳回路径：受理后驳回必须填写理由，驳回为终态且历史事件不被覆盖', async () => {
    // alice 的回执此前的异议均已终态，可再次发起
    const alice = await login('alice');
    const state0 = (await request('GET', '/api/state', auth(alice))).data;
    const receiptNo = state0.receipt.receiptNo;
    const created = await createObjectionApi(alice, receiptNo, { reason: '再次申请撤销，补充新的事实依据。' });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const objectionNo = created.data.objection.objectionNo;

    const processor = await assignedProcessor(objectionNo);
    const accept = await processorPost(processor, objectionNo, 'accept', {});
    assert.equal(accept.status, 200, JSON.stringify(accept.data));

    const noReason = await processorPost(processor, objectionNo, 'reject', { reason: '短' });
    assert.equal(noReason.status, 400);
    assert.equal(noReason.data.error.code, 'REJECT_REASON_REQUIRED');

    const reject = await processorPost(processor, objectionNo, 'reject', {
      reason: '回执与原始办理记录一致，异议理由不成立，予以驳回。',
    });
    assert.equal(reject.status, 200, JSON.stringify(reject.data));
    assert.equal(reject.data.objection.status, 'rejected');
    assert.ok(reject.data.objection.resolvedAt);
    assert.match(reject.data.objection.resolveNote, /异议理由不成立/);

    // 办理人看到处理意见
    const ownerDetail = await request('GET', `/api/receipt-objections/${objectionNo}`, auth(alice));
    assert.equal(ownerDetail.status, 200);
    assert.match(ownerDetail.data.objection.resolveNote, /异议理由不成立/);

    // 重复驳回被明确拒绝，历史事件不被覆盖（受理+驳回各一次）
    const again = await processorPost(processor, objectionNo, 'reject', { reason: '再次驳回尝试' });
    assert.equal(again.status, 409);
    assert.equal(again.data.error.code, 'OBJECTION_ALREADY_HANDLED');
    const detail = await request('GET', `/api/processor/objections/${objectionNo}`, auth(processor));
    const statusEvents = detail.data.objection.events.map((e) => e.type);
    assert.deepEqual(statusEvents, [
      'receipt.objection.submitted',
      'receipt.objection.accepted',
      'receipt.objection.rejected',
    ]);
  });

  test('角色隔离：办理人不能访问处理人/审计接口；处理人不能访问办理与审计接口；审计员只读', async () => {
    const alice = await login('alice');
    const processor = await login('processor1');
    const auditor = await login('auditor1');

    // 处理人不能触发办理流程
    const tokens = await request('POST', '/api/tokens', auth(processor, { body: { step: 0, pageId: randomPageId() } }));
    assert.equal(tokens.status, 404);
    // 处理人不能查审计列表
    const processorAudit = await request('GET', '/api/auditor/receipt-objections', auth(processor));
    assert.equal(processorAudit.status, 404);
    // 处理人能访问自己的工作台状态
    const pState = await request('GET', '/api/state', auth(processor));
    assert.equal(pState.status, 200);
    assert.equal(pState.data.user.role, 'processor');

    // 办理人不能访问处理人列表与审计列表
    const handlerProcess = await request('GET', '/api/processor/objections', auth(alice));
    assert.equal(handlerProcess.status, 404);
    const handlerAudit = await request('GET', '/api/auditor/receipt-objections', auth(alice));
    assert.equal(handlerAudit.status, 404);

    // 审计员不能发起异议（POST 落到审计只读处理器 → 404）
    const auditorWrite = await request('POST', '/api/receipt-objections', auth(auditor, {
      body: { receiptNo: 'HZ-20000101-ZZZZZZZZ', reason: 'x'.repeat(10), attachment: textAttachment('x') },
    }));
    assert.equal(auditorWrite.status, 404);
    // 审计员可以列全部异议
    const auditorList = await request('GET', '/api/auditor/receipt-objections', auth(auditor));
    assert.equal(auditorList.status, 200);
    assert.ok(Array.isArray(auditorList.data.objections));
    assert.ok(auditorList.data.objections.length >= 1, '前序用例已产生异议');
    // 审计列表为脱敏摘要：不含证件号原文，完整内容仅详情接口返回
    assert.ok(!JSON.stringify(auditorList.data).includes('ID-SECRET-77'));
  });

  test('输入校验：原因长度、非文本附件、超大附件、编号格式均被明确拒绝', async () => {
    const erin = await login('erin');
    const { receipt } = await completeWorkflow(erin);

    const shortReason = await createObjectionApi(erin, receipt.receiptNo, { reason: '太短' });
    assert.equal(shortReason.status, 400);
    assert.equal(shortReason.data.error.code, 'INVALID_REASON');

    const missingAttachment = await request('POST', '/api/receipt-objections', auth(erin, {
      body: { receiptNo: receipt.receiptNo, reason: '原因足够长的一条异议申请。' },
    }));
    assert.equal(missingAttachment.status, 400);
    assert.equal(missingAttachment.data.error.code, 'ATTACHMENT_REQUIRED');

    const bigFile = await request('POST', '/api/receipt-objections', auth(erin, {
      body: {
        receiptNo: receipt.receiptNo,
        reason: '原因足够长的一条异议申请。',
        attachment: textAttachment('啊'.repeat(40000)),
      },
    }));
    assert.equal(bigFile.status, 400);
    assert.equal(bigFile.data.error.code, 'ATTACHMENT_TOO_LARGE');

    const badNo = await request('POST', '/api/receipt-objections', auth(erin, {
      body: { receiptNo: 'not-a-number', reason: '原因足够长的一条异议申请。', attachment: textAttachment('x') },
    }));
    assert.equal(badNo.status, 400);
    assert.equal(badNo.data.error.code, 'INVALID_RECEIPT_NO');

    const notFound = await request('GET', '/api/receipt-objections/YY-20000101-AAAAAAAA', auth(erin));
    assert.equal(notFound.status, 404);
    assert.equal(notFound.data.error.code, 'OBJECTION_NOT_FOUND');

    const malformed = await request('GET', '/api/receipt-objections/not-a-number', auth(erin));
    assert.equal(malformed.status, 400);
    assert.equal(malformed.data.error.code, 'INVALID_OBJECTION_NO');
  });

  test('时间线展示异议来源关系与处理历史；刷新/重登/服务重启后一致', async () => {
    const bob = await login('bob');
    const { receipt } = await completeWorkflow(bob);
    const created = await createObjectionApi(bob, receipt.receiptNo, { reason: '申请撤销该回执，情况说明见附件文本。' });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const objectionNo = created.data.objection.objectionNo;

    const processor = await assignedProcessor(objectionNo);
    const accept = await processorPost(processor, objectionNo, 'accept', {});
    assert.equal(accept.status, 200, JSON.stringify(accept.data));

    // 时间线包含异议条目，挂在对应回执之下
    const timeline = (await request('GET', '/api/state', auth(bob))).data.timeline;
    const entry = timeline.find((e) => e.kind === 'receiptObjection' && e.objectionNo === objectionNo);
    assert.ok(entry, '时间线应包含异议条目');
    assert.equal(entry.receiptNo, receipt.receiptNo);
    assert.equal(entry.status, 'accepted');
    assert.ok(entry.events.length >= 2);
    assert.ok(entry.events.some((e) => e.type === 'receipt.objection.accepted'));

    // 模拟刷新：重新登录
    const bobAgain = await login('bob');
    const state = (await request('GET', '/api/state', auth(bobAgain))).data;
    const again = state.receiptObjections.find((o) => o.objectionNo === objectionNo);
    assert.ok(again);
    assert.equal(again.status, 'accepted');
    assert.equal(again.overdue, false);

    // 服务重启后异议、处理意见与完整时间线保持一致
    const dbFile = process.env.DB_PATH;
    let child = await startRestartServer(dbFile);
    try {
      const loginRes = await fetch(`${child.url}/api/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'bob', password: 'password123' }),
      });
      assert.equal(loginRes.status, 200);
      const loginData = await loginRes.json();
      const cookies = loginRes.headers.getSetCookie();
      const sid = /sid=([^;]+)/.exec(cookies.find((c) => c.startsWith('sid=')))[1];
      const csrf = /csrf=([^;]+)/.exec(cookies.find((c) => c.startsWith('csrf=')))[1];
      const headers = { Cookie: `sid=${sid}`, 'X-CSRF-Token': csrf };

      const stateRes = await fetch(`${child.url}/api/state`, { headers });
      const stateData = await stateRes.json();
      assert.equal(stateRes.status, 200);
      const after = stateData.receiptObjections.find((o) => o.objectionNo === objectionNo);
      assert.ok(after, '重启后异议仍在');
      assert.equal(after.status, 'accepted');
      assert.equal(after.reason, '申请撤销该回执，情况说明见附件文本。');

      const detailRes = await fetch(`${child.url}/api/receipt-objections/${objectionNo}`, { headers });
      const detailData = await detailRes.json();
      assert.equal(detailRes.status, 200);
      assert.deepEqual(
        detailData.objection.events.map((e) => e.type),
        ['receipt.objection.submitted', 'receipt.objection.accepted'],
        '重启后完整处理历史保持一致',
      );
      assert.equal(detailData.objection.materials[0].filename, '情况说明.txt');
      assert.equal(detailData.objection.snapshotDigest, created.data.objection.snapshotDigest);

      const timelineAfter = stateData.timeline.find((e) => e.kind === 'receiptObjection' && e.objectionNo === objectionNo);
      assert.ok(timelineAfter);
      assert.equal(timelineAfter.events.length, 2);

      await stop(child);
      child = null;
    } finally {
      if (child) await stop(child);
    }
  });

  test('撤销确认后：办理人可查原始快照留档，核验返回已撤销，审计冻结快照仍可查', async () => {
    const erin = await login('erin');
    const state0 = (await request('GET', '/api/state', auth(erin))).data;
    const receipt = state0.receipt;
    const created = await createObjectionApi(erin, receipt.receiptNo, { reason: '申请撤销回执，详细情况见上传的文本说明附件。' });
    assert.equal(created.status, 200, JSON.stringify(created.data));
    const objectionNo = created.data.objection.objectionNo;

    const processor = await assignedProcessor(objectionNo);
    await processorPost(processor, objectionNo, 'accept', {});
    const confirm = await processorPost(processor, objectionNo, 'confirm-revocation', {
      reason: '审查确认撤销。',
    });
    assert.equal(confirm.status, 200, JSON.stringify(confirm.data));

    // 本人仍可查看完整回执内容（原始快照留档）
    const ownerReceipt = await request('GET', `/api/receipts/${encodeURIComponent(receipt.receiptNo)}`, auth(erin));
    assert.equal(ownerReceipt.status, 200);
    assert.equal(ownerReceipt.data.receipt.status, 'revoked');
    assert.equal(ownerReceipt.data.receipt.snapshot.applicantName, '李明明');
    // 审计视图的冻结快照与原回执一致
    const auditor = await login('auditor1');
    const audit = await request('GET', `/api/auditor/receipt-objections/${objectionNo}`, auth(auditor));
    assert.equal(audit.status, 200);
    assert.equal(audit.data.objection.fullSnapshot.applicantName, '李明明');
    assert.equal(audit.data.objection.status, 'revoked');
    // 审计列表包含已撤销异议，可按状态过滤
    const revokedList = await request('GET', '/api/auditor/receipt-objections?status=revoked', auth(auditor));
    assert.equal(revokedList.status, 200);
    assert.ok(revokedList.data.objections.some((o) => o.objectionNo === objectionNo));
  });
});

async function startRestartServer(dbFile) {
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
  if (!running || running.child.exitCode !== null) return;
  running.child.kill('SIGTERM');
  await once(running.child, 'exit');
}

process.on('exit', () => {
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
});

test.after(async () => {
  server.close();
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
});
