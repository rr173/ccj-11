import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import path from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { alignEvents } from '../src/archiveComparisons.js';
import { stableStringify } from '../src/crypto.js';

process.env.DB_PATH = path.join(process.cwd(), 'data', `test-compare-${process.pid}.db`);
process.env.TOKEN_TTL_MS = '600000';
process.env.RECEIPT_SECRET = 'unit-test-compare-secret-fixed-value';
process.env.VERIFY_RATE_MAX = '200';
process.env.REVIEW_INVITE_MIN_TTL_MS = '60000';
process.env.ARCHIVE_EXPORT_CHUNK_SIZE = '50';
process.env.ARCHIVE_SWEEP_MS = '60000';
process.env.REPLAY_MIN_TTL_MS = String(5 * 60 * 1000);
// 本文件不测超时落定：关闭后台批次/申诉/调解/案件组扫描，避免其事务在高负载下与
// 请求事务交叉产生 created_at 微小倒挂，触发既有归档的“事件顺序冲突”校验（偶发）
process.env.NO_BATCH_SWEEP = '1';
process.env.NO_AUTO_LISTEN = '1';
for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });

const { server } = await import('../src/server.js');
const { stopArchiveExportSweep } = await import('../src/server.js');
const { db, cryptoId, sweepReplaySessions } = await import('../src/db.js');
const { hashPassword } = await import('../src/crypto.js');
if (!server.listening) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
}
// 父服务器在“重启恢复”用例后会重新监听（端口可能变化），每次请求动态取地址
const base = () => `http://127.0.0.1:${server.address().port}`;

async function request(method, url, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${base()}${url}`, {
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
async function login(username, password = 'password123') {
  const res = await request('POST', '/api/login', { body: { username, password } });
  assert.equal(res.status, 200, JSON.stringify(res.data));
  const cookies = parsePair(res.headers.get('set-cookie') || '');
  return {
    username,
    role: res.data.user.role,
    cookie: `sid=${cookies.sid}; csrf=${cookies.csrf}`,
    csrf: res.data.csrfToken,
  };
}
function auth(client, extra = {}) {
  return { ...extra, headers: { Cookie: client.cookie, 'X-CSRF-Token': client.csrf, ...(extra.headers || {}) } };
}
function randomId() {
  return crypto.getRandomValues(new Uint8Array(16)).reduce((s, b) => s + b.toString(16).padStart(2, '0'), '');
}
const PAYLOADS = (phone = '13800138000', secret = 'COMPARE-SECRET-001') => ([
  { name: '对比测试人', idNumber: secret, phone },
  { province: '浙江省', city: '杭州市', detail: '对比秘密地址 1 号' },
  { type: 'change', description: '对比测试事项' },
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
async function freshHandler(prefix) {
  const username = `c_${prefix}_${process.pid}_${Date.now().toString(36)}`;
  const { salt, hash } = hashPassword('password123');
  db.prepare(`
    INSERT INTO users (id, username, display_name, role, password_salt, password_hash, created_at)
    VALUES (?, ?, ?, 'handler', ?, ?, ?)
  `).run(cryptoId(), username, `${prefix}办理人`, salt, hash, Date.now());
  return login(username);
}
async function setupRejectedBatch(client, receiptNo) {
  const created = await request('POST', '/api/review-batches', auth(client, {
    body: {
      receiptNo,
      ttlMinutes: 60,
      note: '对比前置批次',
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
  const s1 = await validateBatch(created.data.links[0].token);
  const s2 = await validateBatch(created.data.links[1].token);
  await request('POST', '/api/batch-review/opinions', {
    headers: { Cookie: s1.cookie, 'X-CSRF-Token': s1.csrf, 'Content-Type': 'application/json' },
    body: { key: '0.phone', reason: '证据A：手机号应核对', idempotencyKey: randomId() },
  });
  await request('POST', '/api/batch-review/opinions', {
    headers: { Cookie: s2.cookie, 'X-CSRF-Token': s2.csrf, 'Content-Type': 'application/json' },
    body: { key: '2.description', reason: '证据B：说明需补充', idempotencyKey: randomId() },
  });
  const detail = await request('GET', `/api/review-batches/${batchId}`, auth(client));
  for (const f of detail.data.batch.fields) {
    const r = await request('POST', `/api/review-batches/${batchId}/fields/${f.id}/reject`, auth(client, {
      body: { reason: '核对原申报无误，驳回' },
    }));
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  return { batchId };
}
async function createArchive(client, sourceType, sourceId, extra = {}) {
  return request('POST', '/api/archives', auth(client, {
    body: { sourceType, sourceId, note: '测试归档', ...extra, auditorGrants: extra.auditorGrants ?? ['auditor1'] },
  }));
}
// 产生属于该批次的新审计事件：发起申诉回合再取消
async function addNewBatchEvents(client, batchId) {
  const appeal = await request('POST', '/api/review-appeals', auth(client, {
    body: {
      batchId,
      ttlMinutes: 60,
      note: '版本间新增事件',
      fields: [{ key: '0.phone', reason: 'misjudged', acceptThreshold: 1, rejectThreshold: 2, evidenceOpinionIds: [] }],
      invitations: [
        { label: '申诉复核人1', fields: ['0.phone'] },
        { label: '申诉复核人2', fields: ['0.phone'] },
      ],
    },
  }));
  assert.equal(appeal.status, 200, JSON.stringify(appeal.data));
  const roundId = appeal.data.round.id;
  const cancelled = await request('POST', `/api/review-appeals/${roundId}/cancel`, auth(client, { body: { reason: '新增事件后取消' } }));
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
}

// 纯函数：新增/删除/修改/未变化分类
test('alignEvents 正确分类新增、删除、修改、未变化与无法对齐', () => {
  const e = (ordinal, sourceEventId, contentHash) => ({ ordinal, sourceEventId, type: `t${sourceEventId}`, occurredAt: ordinal, contentHash });
  const base = [e(0, 1, 'h1'), e(1, 2, 'h2'), e(2, 3, 'h3')];
  const target = [e(0, 1, 'h1'), e(1, 2, 'h2x'), e(2, 4, 'h4')];
  const r = alignEvents(base, target);
  const byKey = Object.fromEntries(r.entries.map((x) => [x.entryKey, x]));
  assert.equal(byKey.e1.status, 'unchanged');
  assert.equal(byKey.e2.status, 'modified');
  assert.equal(byKey.e3.status, 'deleted');
  assert.equal(byKey.e4.status, 'added');
  assert.deepEqual(r.counts, { added: 1, deleted: 1, modified: 1, unchanged: 1, unaligned: 0 });

  // 顺序冲突的共同事件标为 unaligned（LCS 之外）：3 个事件最长顺序一致子序列为 2
  const reordered = [e(0, 2, 'h2'), e(1, 1, 'h1'), e(2, 3, 'h3')];
  const r2 = alignEvents(base, reordered);
  assert.equal(r2.counts.unaligned, 1);
  assert.ok(r2.unalignedReasons.every((x) => x.reason.includes('相对顺序')));
});

// 前置：准备同来源的 v1 / v2 两个已冻结归档
async function prepareTwoVersions(client) {
  const { receipt } = await completeAll(client);
  const { batchId } = await setupRejectedBatch(client, receipt.receiptNo);
  const v1Res = await createArchive(client, 'batch', batchId);
  assert.equal(v1Res.status, 200, JSON.stringify(v1Res.data));
  const v1 = v1Res.data.archive;
  await addNewBatchEvents(client, batchId);
  const v2Res = await createArchive(client, 'batch', batchId, { note: '第二版' });
  assert.equal(v2Res.status, 200, JSON.stringify(v2Res.data));
  const v2 = v2Res.data.archive;
  assert.ok(v2.eventCount > v1.eventCount);
  return { receipt, batchId, v1, v2 };
}

// ① 不同版本事件新增/删除/修改/未变化分类；报告只读、生成后新增事件不改变报告
test('比较报告分类新增/删除/修改/未变化，且生成后新增事件不改变报告', async () => {
  const client = await freshHandler('cmp1');
  const { v1, v2, batchId } = await prepareTwoVersions(client);

  const created = await request('POST', '/api/archive-comparisons', auth(client, {
    body: { baseArchiveId: v1.id, targetArchiveId: v2.id, note: 'v1-v2' },
  }));
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const report = created.data.comparison;
  assert.equal(report.base.version, 1);
  assert.equal(report.target.version, 2);
  assert.ok(report.counts.added >= 2, `新增事件至少含申诉创建/取消：${JSON.stringify(report.counts)}`);
  assert.ok(report.counts.unchanged >= 1);
  assert.equal(report.counts.deleted, 0);
  assert.equal(report.verification.reportOk, true);
  assert.equal(report.verification.baseChain.continuous, true);
  assert.equal(report.verification.targetChain.continuous, true);
  // 条目按合并后事件顺序排列，且所有 entryKey 唯一
  const keys = report.entries.map((x) => x.entryKey);
  assert.equal(new Set(keys).size, keys.length);
  let ordinal = 0;
  for (const entry of report.entries) {
    assert.equal(entry.ordinal, ordinal += 1);
    assert.ok(['added', 'deleted', 'modified', 'unchanged', 'unaligned'].includes(entry.status));
  }
  // 来源关系/状态摘要/权限快照差异字段存在
  assert.ok(report.provenanceDiff);
  assert.ok(Array.isArray(report.statusSummaryDiff.changes));
  assert.equal(report.permissionSnapshotDiff.same, true);
  const digest = report.digest;

  // 报告生成后再产生新业务事件、再归档 v3：报告内容与 digest 不变
  await addNewBatchEvents(client, batchId);
  const v3Res = await createArchive(client, 'batch', batchId, { note: '第三版' });
  assert.equal(v3Res.status, 200);
  const refetch = (await request('GET', `/api/archive-comparisons/${report.id}`, auth(client))).data.comparison;
  assert.equal(refetch.digest, digest, '报告冻结摘要不变');
  assert.equal(refetch.entries.length, report.entries.length);
  assert.equal(refetch.counts.added, report.counts.added);
  assert.equal(refetch.base.version, 1);
  assert.equal(refetch.target.version, 2);
});

// ② 任一归档摘要链失效时比较被拒绝；已生成报告的校验状态显示失败
test('任一归档摘要链失效时比较被拒绝', async () => {
  const client = await freshHandler('cmp2');
  const { v1, v2 } = await prepareTwoVersions(client);

  // 篡改 v2 冻结事件：摘要链失效 → 比较拒绝
  const eventRow = db.prepare('SELECT * FROM audit_archive_events WHERE archive_id = ? ORDER BY ordinal ASC LIMIT 1').get(v2.id);
  const tampered = JSON.parse(eventRow.detail_json);
  tampered.tampered = true;
  db.prepare('UPDATE audit_archive_events SET detail_json = ? WHERE id = ?').run(JSON.stringify(tampered), eventRow.id);

  const rejected = await request('POST', '/api/archive-comparisons', auth(client, {
    body: { baseArchiveId: v1.id, targetArchiveId: v2.id },
  }));
  assert.equal(rejected.status, 409, JSON.stringify(rejected.data));
  assert.equal(rejected.data.error.code, 'ARCHIVE_CHAIN_INVALID');
  assert.equal(rejected.data.detail.side, 'target');
  assert.ok(rejected.data.detail.broken);

  // 恢复后可生成；生成后再篡改：报告 GET 显示校验失败但报告仍只读
  db.prepare('UPDATE audit_archive_events SET detail_json = ? WHERE id = ?').run(eventRow.detail_json, eventRow.id);
  const created = await request('POST', '/api/archive-comparisons', auth(client, {
    body: { baseArchiveId: v1.id, targetArchiveId: v2.id },
  }));
  assert.equal(created.status, 200, JSON.stringify(created.data));
  const reportId = created.data.comparison.id;

  const eventRow2 = db.prepare('SELECT * FROM audit_archive_events WHERE archive_id = ? ORDER BY ordinal ASC LIMIT 1').get(v1.id);
  const t2 = JSON.parse(eventRow2.detail_json);
  t2.tampered = true;
  db.prepare('UPDATE audit_archive_events SET detail_json = ? WHERE id = ?').run(JSON.stringify(t2), eventRow2.id);
  const brokenView = (await request('GET', `/api/archive-comparisons/${reportId}`, auth(client))).data.comparison;
  assert.equal(brokenView.verification.reportOk, false);
  assert.equal(brokenView.verification.baseChain.continuous, false);
  assert.ok(brokenView.verification.reasons.some((r) => r.side === 'base'));
  // 恢复（测试其余用例依赖该库不被污染；仅本账号数据）
  db.prepare('UPDATE audit_archive_events SET detail_json = ? WHERE id = ?').run(eventRow2.detail_json, eventRow2.id);
});

// 同源 / 存在性 / 越权校验
test('比较前置校验：不同来源、同一版本、他人归档均被拒绝', async () => {
  const client = await freshHandler('cmp3');
  const { v1, v2 } = await prepareTwoVersions(client);
  // 同一归档
  const same = await request('POST', '/api/archive-comparisons', auth(client, {
    body: { baseArchiveId: v1.id, targetArchiveId: v1.id },
  }));
  assert.equal(same.status, 400);
  assert.equal(same.data.error.code, 'COMPARE_SAME_ARCHIVE');
  // 不存在
  const missing = await request('POST', '/api/archive-comparisons', auth(client, {
    body: { baseArchiveId: v1.id, targetArchiveId: 'nonexistent-id-1234' },
  }));
  assert.equal(missing.status, 404);
  assert.equal(missing.data.error.code, 'COMPARE_ARCHIVE_NOT_FOUND');
  // 他人归档：用另一个办理人自己的版本与该版本比较
  const other = await freshHandler('cmp3x');
  const otherPrep = await prepareTwoVersions(other);
  const cross = await request('POST', '/api/archive-comparisons', auth(other, {
    body: { baseArchiveId: otherPrep.v1.id, targetArchiveId: v2.id },
  }));
  assert.equal(cross.status, 404);
  assert.equal(cross.data.error.code, 'COMPARE_ARCHIVE_NOT_FOUND');
  // 审计员不能调用办理人比较接口
  const auditor = await login('auditor1');
  const forAuditor = await request('POST', '/api/archive-comparisons', auth(auditor, {
    body: { baseArchiveId: v1.id, targetArchiveId: v2.id },
  }));
  // 审计员角色走 auditor 路由表，没有该 POST → 404
  assert.equal(forAuditor.status, 404);
});

async function makeReport(client) {
  const { v1, v2 } = await prepareTwoVersions(client);
  const created = await request('POST', '/api/archive-comparisons', auth(client, {
    body: { baseArchiveId: v1.id, targetArchiveId: v2.id },
  }));
  assert.equal(created.status, 200, JSON.stringify(created.data));
  return { v1, v2, report: created.data.comparison };
}

// ③ 重放只能选择报告中的已对齐事件；越权/未对齐事件被拒绝
test('重放事件子集越权被拒绝', async () => {
  const client = await freshHandler('cmp4');
  const { report } = await makeReport(client);
  const validKey = report.entries.find((e) => ['added', 'unchanged'].includes(e.status)).entryKey;

  // 空子集
  const empty = await request('POST', `/api/archive-comparisons/${report.id}/replays`, auth(client, {
    body: { entryKeys: [], ttlMinutes: 60 },
  }));
  assert.equal(empty.status, 400);
  assert.equal(empty.data.error.code, 'REPLAY_SUBSET_EMPTY');

  // 伪造条目
  const forged = await request('POST', `/api/archive-comparisons/${report.id}/replays`, auth(client, {
    body: { entryKeys: ['e99999999'], ttlMinutes: 60 },
  }));
  assert.equal(forged.status, 403);
  assert.equal(forged.data.error.code, 'REPLAY_EVENT_OUT_OF_SCOPE');

  // 合法选择成功（返回首枚一次性提交令牌）
  const ok = await request('POST', `/api/archive-comparisons/${report.id}/replays`, auth(client, {
    body: { entryKeys: [validKey], ttlMinutes: 60 },
  }));
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.ok(ok.data.submitToken, '创建时应签发提交令牌');
  assert.equal(ok.data.replay.selectedCount, 1);
  assert.equal(ok.data.replay.events[0].entryKey, validKey);
  assert.ok(ok.data.replay.events[0].detail, '重放读取报告冻结的事件副本');
  // 副本必须与目标归档中同一 sourceEventId 的冻结事件一致（防止 ordinal 偏移取错事件）
  const archiveDetail = (await request('GET', `/api/archives/${report.target.archiveId}`, auth(client))).data.archive;
  const sourceEventId = Number(validKey.slice(1));
  const targetEvent = archiveDetail.events.find((e) => e.sourceEventId === sourceEventId);
  assert.ok(targetEvent, '目标归档中应能找到该原始事件');
  assert.equal(ok.data.replay.events[0].sourceEventId, sourceEventId);
  assert.equal(ok.data.replay.events[0].type, targetEvent.type);
  assert.equal(ok.data.replay.events[0].occurredAt, targetEvent.occurredAt);
  assert.deepEqual(ok.data.replay.events[0].detail, targetEvent.detail);

  // 他人不能基于该报告创建重放
  const other = await freshHandler('cmp4x');
  const foreign = await request('POST', `/api/archive-comparisons/${report.id}/replays`, auth(other, {
    body: { entryKeys: [validKey], ttlMinutes: 60 },
  }));
  assert.equal(foreign.status, 404);
  assert.equal(foreign.data.error.code, 'COMPARE_NOT_FOUND');
});

// ④ 两个页面并发确认同一事件只有一个成功
test('两个页面并发确认同一事件只有一个成功', async () => {
  const client = await freshHandler('cmp5');
  const { report } = await makeReport(client);
  const key = report.entries.find((e) => e.status === 'unchanged' || e.status === 'added').entryKey;
  const created = await request('POST', `/api/archive-comparisons/${report.id}/replays`, auth(client, {
    body: { entryKeys: [key], ttlMinutes: 60 },
  }));
  assert.equal(created.status, 200);
  const replayId = created.data.replay.id;

  // 每个页面各自取一次性令牌
  const tokenA = (await request('POST', `/api/replay-sessions/${replayId}/submit-token`, auth(client, { body: {} }))).data.submitToken;
  const tokenB = (await request('POST', `/api/replay-sessions/${replayId}/submit-token`, auth(client, { body: {} }))).data.submitToken;
  assert.notEqual(tokenA, tokenB);
  // 后签发的令牌使旧令牌作废：A 的令牌已被 B 的签发作废
  const staleA = await request('POST', `/api/replay-sessions/${replayId}/opinions`, auth(client, {
    body: { entryKey: key, kind: 'confirm', comment: '', reason: '', idempotencyKey: randomId(), submitToken: tokenA, expectedVersion: 1 },
  }));
  assert.equal(staleA.status, 403);
  assert.equal(staleA.data.error.code, 'REPLAY_TOKEN_INVALID');

  // 重新各自取令牌后并发确认：唯一索引只放行一个
  const t1 = (await request('POST', `/api/replay-sessions/${replayId}/submit-token`, auth(client, { body: {} }))).data.submitToken;
  const t2 = (await request('POST', `/api/replay-sessions/${replayId}/submit-token`, auth(client, { body: {} }))).data.submitToken;
  // 严格模拟“两个页面同时持有有效提交令牌”：直接在库中放两枚同时有效的令牌，
  // 绕过“新签作废旧令牌”的页面级约束，直接压测同一事件结论的部分唯一索引竞争。
  const { sha256 } = await import('../src/crypto.js');
  const makeToken = async (ch) => {
    const raw = ch.repeat(43);
    db.prepare(`
      INSERT INTO audit_replay_submit_tokens (id, replay_id, token_hash, status, created_at, expires_at, used_at, used_opinion_id, revoked_at)
      VALUES (?, ?, ?, 'active', ?, ?, NULL, '', NULL)
    `).run(cryptoId(), replayId, sha256(raw), Date.now(), Date.now() + 600000);
    return raw;
  };
  const rawA = await makeToken('A');
  const rawB = await makeToken('B');
  const [r1, r2] = await Promise.all([
    request('POST', `/api/replay-sessions/${replayId}/opinions`, auth(client, {
      body: { entryKey: key, kind: 'confirm', idempotencyKey: randomId(), submitToken: rawA, expectedVersion: 1 },
    })),
    request('POST', `/api/replay-sessions/${replayId}/opinions`, auth(client, {
      body: { entryKey: key, kind: 'confirm', idempotencyKey: randomId(), submitToken: rawB, expectedVersion: 1 },
    })),
  ]);
  const oks = [r1, r2].filter((r) => r.status === 200);
  const conflicts = [r1, r2].filter((r) => r.status !== 200);
  assert.equal(oks.length, 1, `并发确认只应一个成功：${r1.status}/${r2.status} ${r1.text} ${r2.text}`);
  assert.equal(conflicts.length, 1);
  // 负者必须是“重复确认”语义（唯一索引竞争），而非成功两次
  assert.equal(conflicts[0].data.error.code, 'REPLAY_ALREADY_DECIDED');

  // 再确认一次（新版本+新令牌）仍被拒绝：重复确认明确错误
  const t3 = (await request('POST', `/api/replay-sessions/${replayId}/submit-token`, auth(client, { body: {} }))).data.submitToken;
  const again = await request('POST', `/api/replay-sessions/${replayId}/opinions`, auth(client, {
    body: { entryKey: key, kind: 'confirm', idempotencyKey: randomId(), submitToken: t3, expectedVersion: oks[0].data.version },
  }));
  assert.equal(again.status, 409);
  assert.equal(again.data.error.code, 'REPLAY_ALREADY_DECIDED');
});

// ⑤ 幂等键重试返回同一意见（含暂停/令牌用尽后的重试）
test('幂等键重试返回同一意见，换内容冲突', async () => {
  const client = await freshHandler('cmp6');
  const { report } = await makeReport(client);
  const key = report.entries.find((e) => e.status === 'unchanged' || e.status === 'added').entryKey;
  const created = await request('POST', `/api/archive-comparisons/${report.id}/replays`, auth(client, {
    body: { entryKeys: [key], ttlMinutes: 60 },
  }));
  const replayId = created.data.replay.id;
  const idemKey = randomId();
  const token1 = (await request('POST', `/api/replay-sessions/${replayId}/submit-token`, auth(client, { body: {} }))).data.submitToken;
  const first = await request('POST', `/api/replay-sessions/${replayId}/opinions`, auth(client, {
    body: { entryKey: key, kind: 'comment', comment: '请复核该事件时间', reason: '', idempotencyKey: idemKey, submitToken: token1, expectedVersion: 1 },
  }));
  assert.equal(first.status, 200, JSON.stringify(first.data));
  assert.equal(first.data.replay, false);
  assert.equal(first.data.opinion.comment, '请复核该事件时间');
  const opinionId = first.data.opinion.id;

  // 网络重试：新令牌、同键同内容 → 同一条意见，replay:true
  const token2 = first.data.nextSubmitToken;
  const retry = await request('POST', `/api/replay-sessions/${replayId}/opinions`, auth(client, {
    body: { entryKey: key, kind: 'comment', comment: '请复核该事件时间', reason: '', idempotencyKey: idemKey, submitToken: token2, expectedVersion: 99 },
  }));
  assert.equal(retry.status, 200, JSON.stringify(retry.data));
  assert.equal(retry.data.replay, true);
  assert.equal(retry.data.opinion.id, opinionId);

  // 同键换内容 → 冲突
  const token3 = (await request('POST', `/api/replay-sessions/${replayId}/submit-token`, auth(client, { body: {} }))).data.submitToken;
  const clash = await request('POST', `/api/replay-sessions/${replayId}/opinions`, auth(client, {
    body: { entryKey: key, kind: 'comment', comment: '完全不同的意见内容', reason: '', idempotencyKey: idemKey, submitToken: token3, expectedVersion: 2 },
  }));
  assert.equal(clash.status, 409);
  assert.equal(clash.data.error.code, 'REPLAY_IDEMPOTENCY_CONFLICT');
});

// ⑥ 暂停、恢复、取消和过期后的写操作拒绝
test('暂停/恢复/取消/过期的写操作与版本校验', async () => {
  const client = await freshHandler('cmp7');
  const { report } = await makeReport(client);
  const key = report.entries.find((e) => e.status === 'unchanged' || e.status === 'added').entryKey;
  const created = await request('POST', `/api/archive-comparisons/${report.id}/replays`, auth(client, {
    body: { entryKeys: [key], ttlMinutes: 60 },
  }));
  const replayId = created.data.replay.id;

  const controlToken = async () => (await request('POST', `/api/replay-sessions/${replayId}/submit-token`, auth(client, { body: {} }))).data.submitToken;
  const writeOpinion = async (submitToken, expectedVersion) => request('POST', `/api/replay-sessions/${replayId}/opinions`, auth(client, {
    body: { entryKey: key, kind: 'comment', comment: '暂停期间尝试写入', idempotencyKey: randomId(), submitToken, expectedVersion },
  }));

  // 暂停
  let t = await controlToken();
  const paused = await request('POST', `/api/replay-sessions/${replayId}/pause`, auth(client, {
    body: { submitToken: t, expectedVersion: 1, reason: '办理人暂停' },
  }));
  assert.equal(paused.status, 200, JSON.stringify(paused.data));
  assert.equal(paused.data.replay.status, 'paused');
  assert.equal(paused.data.replay.version, 2);

  // 暂停期间仍可获取控制令牌（只能恢复/取消）；写意见会被拒绝
  const controlTokenWhilePaused = await request('POST', `/api/replay-sessions/${replayId}/submit-token`, auth(client, { body: {} }));
  assert.equal(controlTokenWhilePaused.status, 200);

  // 旧版本号恢复 + 有效令牌 → 版本冲突，且令牌不被消费（随后仍可用同一令牌恢复）
  const resumeToken = controlTokenWhilePaused.data.submitToken;
  const staleResume = await request('POST', `/api/replay-sessions/${replayId}/resume`, auth(client, {
    body: { submitToken: resumeToken, expectedVersion: 1 },
  }));
  assert.equal(staleResume.status, 409);
  assert.equal(staleResume.data.error.code, 'REPLAY_VERSION_CONFLICT');
  assert.equal(staleResume.data.currentVersion, 2);

  // 恢复（正确版本，复用同一枚未被消费的令牌）：重新校验报告与摘要链
  const resumed = await request('POST', `/api/replay-sessions/${replayId}/resume`, auth(client, {
    body: { submitToken: resumeToken, expectedVersion: 2 },
  }));
  assert.equal(resumed.status, 200, JSON.stringify(resumed.data));
  assert.equal(resumed.data.replay.status, 'active');
  assert.equal(resumed.data.replay.version, 3);
  assert.ok(resumed.data.verification.reportOk);

  // 再次暂停，期间篡改目标归档摘要链：恢复必须被拒绝且令牌不被消费
  const pause2Token = await controlToken();
  const paused2 = await request('POST', `/api/replay-sessions/${replayId}/pause`, auth(client, {
    body: { submitToken: pause2Token, expectedVersion: 3 },
  }));
  assert.equal(paused2.status, 200, JSON.stringify(paused2.data));
  const tamperedRow = db.prepare('SELECT * FROM audit_archive_events WHERE archive_id = ? ORDER BY ordinal ASC LIMIT 1').get(report.target.archiveId);
  const tamperedDetail = JSON.parse(tamperedRow.detail_json);
  tamperedDetail.tamperedForResume = true;
  db.prepare('UPDATE audit_archive_events SET detail_json = ? WHERE id = ?').run(JSON.stringify(tamperedDetail), tamperedRow.id);
  const resumeWhileBrokenToken = await controlToken();
  const resumeBroken = await request('POST', `/api/replay-sessions/${replayId}/resume`, auth(client, {
    body: { submitToken: resumeWhileBrokenToken, expectedVersion: 4 },
  }));
  assert.equal(resumeBroken.status, 409, JSON.stringify(resumeBroken.data));
  assert.equal(resumeBroken.data.error.code, 'REPLAY_REPORT_INVALID');
  assert.equal(resumeBroken.data.verification.reportOk, false);
  // 会话仍处于暂停态（失败的恢复没有改状态）
  const stillPaused = (await request('GET', `/api/replay-sessions/${replayId}`, auth(client))).data.replay;
  assert.equal(stillPaused.status, 'paused');
  // 恢复归档后，同一枚令牌仍可成功恢复（失败的恢复没有消费令牌）
  db.prepare('UPDATE audit_archive_events SET detail_json = ? WHERE id = ?').run(tamperedRow.detail_json, tamperedRow.id);
  const resumeAgain = await request('POST', `/api/replay-sessions/${replayId}/resume`, auth(client, {
    body: { submitToken: resumeWhileBrokenToken, expectedVersion: 4 },
  }));
  assert.equal(resumeAgain.status, 200, JSON.stringify(resumeAgain.data));
  assert.equal(resumeAgain.data.replay.status, 'active');

  // 恢复后可继续写入（使用恢复补发的令牌）
  const writeAfterResume = await writeOpinion(resumeAgain.data.nextSubmitToken, 5);
  assert.equal(writeAfterResume.status, 200, JSON.stringify(writeAfterResume.data));

  // 旧版本号写入 → 409
  const t2 = writeAfterResume.data.nextSubmitToken;
  const oldVersion = await writeOpinion(t2, 1);
  assert.equal(oldVersion.status, 409);
  assert.equal(oldVersion.data.error.code, 'REPLAY_VERSION_CONFLICT');
  assert.equal(oldVersion.data.currentVersion, 6);

  // 取消
  const cancelToken = (await request('POST', `/api/replay-sessions/${replayId}/submit-token`, auth(client, { body: {} }))).data.submitToken;
  const cancelled = await request('POST', `/api/replay-sessions/${replayId}/cancel`, auth(client, {
    body: { submitToken: cancelToken, expectedVersion: 6, reason: '审阅完成取消' },
  }));
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.data));
  assert.equal(cancelled.data.replay.status, 'cancelled');
  // 历史意见与审计时间线保留、只读
  assert.ok(cancelled.data.replay.opinions.length >= 1);
  assert.ok(cancelled.data.replay.auditTimeline.some((a) => a.type === 'replay.created'));
  assert.ok(cancelled.data.replay.auditTimeline.some((a) => a.type === 'replay.paused'));
  assert.ok(cancelled.data.replay.auditTimeline.some((a) => a.type === 'replay.resumed'));
  assert.ok(cancelled.data.replay.auditTimeline.some((a) => a.type === 'replay.cancelled'));

  // 取消后写操作拒绝
  const writeAfterCancel = await request('POST', `/api/replay-sessions/${replayId}/opinions`, auth(client, {
    body: { entryKey: key, kind: 'comment', comment: '取消后', idempotencyKey: randomId(), submitToken: '0000000000000000000000000000000000000000', expectedVersion: 7 },
  }));
  assert.equal(writeAfterCancel.status, 409);
  assert.equal(writeAfterCancel.data.error.code, 'REPLAY_CANCELLED_READONLY');
  // GET 仍可读
  const get = await request('GET', `/api/replay-sessions/${replayId}`, auth(client));
  assert.equal(get.status, 200);
  assert.equal(get.data.replay.status, 'cancelled');

  // 过期：新建一个会话并直接置过期 + sweep，写操作返回 REPLAY_EXPIRED
  const created2 = await request('POST', `/api/archive-comparisons/${report.id}/replays`, auth(client, {
    body: { entryKeys: [key], ttlMinutes: 60 },
  }));
  const replay2 = created2.data.replay.id;
  db.prepare('UPDATE audit_replay_sessions SET expires_at = ? WHERE id = ?').run(Date.now() - 1000, replay2);
  sweepReplaySessions();
  const expiredWrite = await request('POST', `/api/replay-sessions/${replay2}/opinions`, auth(client, {
    body: { entryKey: key, kind: 'comment', comment: '过期后', idempotencyKey: randomId(), submitToken: created2.data.submitToken, expectedVersion: 1 },
  }));
  assert.equal(expiredWrite.status, 410);
  assert.equal(expiredWrite.data.error.code, 'REPLAY_EXPIRED');
  const expiredGet = await request('GET', `/api/replay-sessions/${replay2}`, auth(client));
  assert.equal(expiredGet.data.replay.status, 'expired');
});

// ⑦ 暂停期间的幂等重试仍返回原意见（暂停不影响已处理结果回放）
test('暂停/取消后幂等键重试仍返回同一条意见', async () => {
  const client = await freshHandler('cmp8');
  const { report } = await makeReport(client);
  const key = report.entries.find((e) => e.status === 'unchanged' || e.status === 'added').entryKey;
  const created = await request('POST', `/api/archive-comparisons/${report.id}/replays`, auth(client, {
    body: { entryKeys: [key], ttlMinutes: 60 },
  }));
  const replayId = created.data.replay.id;
  const idemKey = randomId();
  const t1 = (await request('POST', `/api/replay-sessions/${replayId}/submit-token`, auth(client, { body: {} }))).data.submitToken;
  const first = await request('POST', `/api/replay-sessions/${replayId}/opinions`, auth(client, {
    body: { entryKey: key, kind: 'comment', comment: '先发表意见', idempotencyKey: idemKey, submitToken: t1, expectedVersion: 1 },
  }));
  assert.equal(first.status, 200);
  const id = first.data.opinion.id;
  // 暂停
  const pauseToken = (await request('POST', `/api/replay-sessions/${replayId}/submit-token`, auth(client, { body: {} }))).data.submitToken;
  await request('POST', `/api/replay-sessions/${replayId}/pause`, auth(client, {
    body: { submitToken: pauseToken, expectedVersion: 2 },
  }));
  // 暂停后用同键重试：回放成功（不需要新令牌）
  const retry = await request('POST', `/api/replay-sessions/${replayId}/opinions`, auth(client, {
    body: { entryKey: key, kind: 'comment', comment: '先发表意见', idempotencyKey: idemKey, submitToken: 'invalid-token-value-xxxxxxxxxxxxxx', expectedVersion: 99 },
  }));
  assert.equal(retry.status, 200);
  assert.equal(retry.data.replay, true);
  assert.equal(retry.data.opinion.id, id);
});

// ⑧ 审计员只能看到被授权的脱敏比较内容，且不含重放意见；外部核验看不到意见
test('审计员分级视图与外部核验隔离重放意见', async () => {
  const owner = await freshHandler('cmp9');
  const { report } = await makeReport(owner);
  const key = report.entries.find((e) => e.status === 'unchanged' || e.status === 'added').entryKey;
  const created = await request('POST', `/api/archive-comparisons/${report.id}/replays`, auth(owner, {
    body: { entryKeys: [key], ttlMinutes: 60 },
  }));
  const replayId = created.data.replay.id;
  const t1 = (await request('POST', `/api/replay-sessions/${replayId}/submit-token`, auth(owner, { body: {} }))).data.submitToken;
  const secretComment = '审计员不应看到的重放意见原文-机密备注-XYZ';
  await request('POST', `/api/replay-sessions/${replayId}/opinions`, auth(owner, {
    body: { entryKey: key, kind: 'comment', comment: secretComment, idempotencyKey: randomId(), submitToken: t1, expectedVersion: 1 },
  }));

  // auditor1 同时被两个版本授权（创建归档时 auditorGrants=['auditor1']）
  const auditor = await login('auditor1');
  const list = await request('GET', '/api/auditor/comparisons', auth(auditor));
  assert.equal(list.status, 200);
  assert.ok(list.data.comparisons.some((c) => c.id === report.id));
  const view = await request('GET', `/api/auditor/comparisons/${report.id}`, auth(auditor));
  assert.equal(view.status, 200, JSON.stringify(view.data));
  const text = JSON.stringify(view.data);
  assert.ok(!text.includes(secretComment), '审计员视图不得包含重放意见原文');
  assert.ok(!text.includes('replay'), '审计员比较视图不得暴露重放会话信息');
  assert.ok(view.data.comparison.entries.length > 0);

  // auditor2 未授权：403，且列表不可见
  const outsider = await login('auditor2');
  const forbidden = await request('GET', `/api/auditor/comparisons/${report.id}`, auth(outsider));
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.data.error.code, 'COMPARE_VIEW_FORBIDDEN');
  const outsiderList = await request('GET', '/api/auditor/comparisons', auth(outsider));
  assert.ok(!outsiderList.data.comparisons.some((c) => c.id === report.id));

  // 外部核验视图不含重放意见原文
  const code = (await request('POST', `/api/archives/${report.target.archiveId}/external-code`, auth(owner, { body: {} }))).data.code;
  const ext = await request('POST', '/api/archives/external-verify', { body: { code, archiveId: report.target.archiveId } });
  assert.equal(ext.status, 200);
  assert.ok(!JSON.stringify(ext.data).includes(secretComment));
});

// ⑨ 服务重启后比较报告、重放会话、意见与审计时间线恢复一致
test('服务重启后报告与重放时间线恢复', async () => {
  const client = await freshHandler('cmp10');
  const { report } = await makeReport(client);
  const key = report.entries.find((e) => e.status === 'unchanged' || e.status === 'added').entryKey;
  const created = await request('POST', `/api/archive-comparisons/${report.id}/replays`, auth(client, {
    body: { entryKeys: [key], ttlMinutes: 60 },
  }));
  const replayId = created.data.replay.id;
  const t1 = (await request('POST', `/api/replay-sessions/${replayId}/submit-token`, auth(client, { body: {} }))).data.submitToken;
  const op = await request('POST', `/api/replay-sessions/${replayId}/opinions`, auth(client, {
    body: { entryKey: key, kind: 'object', comment: '', reason: '重启前提出的异议', idempotencyKey: randomId(), submitToken: t1, expectedVersion: 1 },
  }));
  assert.equal(op.status, 200, JSON.stringify(op.data));
  const beforeReport = (await request('GET', `/api/archive-comparisons/${report.id}`, auth(client))).data.comparison;
  const beforeReplay = (await request('GET', `/api/replay-sessions/${replayId}`, auth(client))).data.replay;

  stopArchiveExportSweep();
  await new Promise((resolve) => server.close(resolve));
  const child = spawn(process.execPath, [path.join(process.cwd(), 'src', 'server.js')], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      NODE_ENV: 'test',
      DB_PATH: process.env.DB_PATH,
      RECEIPT_SECRET: process.env.RECEIPT_SECRET,
      VERIFY_RATE_MAX: '200',
      PORT: '0',
      NO_AUTO_LISTEN: '0',
      ARCHIVE_SWEEP_MS: '60000',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childUrl = '';
  await new Promise((resolve2, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Restart server did not start')), 10000);
    child.stdout.on('data', (chunk) => {
      output += chunk.toString();
      const match = /listening on http:\/\/0\.0\.0\.0:(\d+)/.exec(output);
      if (match) { clearTimeout(timer); childUrl = `http://127.0.0.1:${match[1]}`; resolve2(); }
    });
    child.stderr.on('data', (chunk) => { output += chunk.toString(); });
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`Server exited early with code ${code}: ${output}`)); });
  });

  const loginRes = await fetch(`${childUrl}/api/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: client.username, password: 'password123' }),
  });
  const loginData = await loginRes.json();
  assert.equal(loginRes.status, 200);
  const cookies = parsePair(loginRes.headers.get('set-cookie') || '');
  const cc = { cookie: `sid=${cookies.sid}; csrf=${cookies.csrf}`, csrf: loginData.csrfToken };
  const h = { Cookie: cc.cookie, 'X-CSRF-Token': cc.csrf };

  const reportRes = await fetch(`${childUrl}/api/archive-comparisons/${report.id}`, { headers: h });
  const afterReport = (await reportRes.json()).comparison;
  assert.equal(afterReport.digest, beforeReport.digest, '报告摘要重启后一致');
  assert.equal(afterReport.verification.reportOk, true);
  assert.equal(afterReport.entries.length, beforeReport.entries.length);

  const replayRes = await fetch(`${childUrl}/api/replay-sessions/${replayId}`, { headers: h });
  const afterReplay = (await replayRes.json()).replay;
  assert.equal(afterReplay.version, beforeReplay.version);
  assert.equal(afterReplay.status, 'active');
  assert.equal(afterReplay.objectedCount, 1);
  assert.equal(afterReplay.opinions.length, beforeReplay.opinions.length);
  assert.equal(afterReplay.opinions[0].reason, '重启前提出的异议');
  assert.deepEqual(
    afterReplay.auditTimeline.map((a) => a.type),
    ['replay.created', 'replay.object'],
  );
  assert.equal(afterReplay.events.length, beforeReplay.events.length);
  // 倒计时/过期时间一致
  assert.equal(afterReplay.expiresAt, beforeReplay.expiresAt);

  child.kill('SIGTERM');
  await once(child, 'exit');
  if (!server.listening) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
  }
});

// ⑩ 原归档与业务记录在比较、审阅全过程保持只读
test('比较与重放全过程不改写任何归档、业务记录或导出文件', async () => {
  const client = await freshHandler('cmp11');
  const { v1, v2, report: report0 } = await makeReport(client);
  const v1Before = (await request('GET', `/api/archives/${v1.id}`, auth(client))).data.archive;
  const v2Before = (await request('GET', `/api/archives/${v2.id}`, auth(client))).data.archive;

  const key = report0.entries.find((e) => e.status === 'unchanged' || e.status === 'added').entryKey;
  const created = await request('POST', `/api/archive-comparisons/${report0.id}/replays`, auth(client, {
    body: { entryKeys: [key], ttlMinutes: 60 },
  }));
  const replayId = created.data.replay.id;
  let token = (await request('POST', `/api/replay-sessions/${replayId}/submit-token`, auth(client, { body: {} }))).data.submitToken;
  for (const kind of ['comment', 'confirm']) {
    const r = await request('POST', `/api/replay-sessions/${replayId}/opinions`, auth(client, {
      body: kind === 'comment'
        ? { entryKey: key, kind, comment: '只读保证意见', idempotencyKey: randomId(), submitToken: token, expectedVersion: kind === 'comment' ? 1 : 2 }
        : { entryKey: key, kind, comment: '', reason: '', idempotencyKey: randomId(), submitToken: token, expectedVersion: 2 },
    }));
    assert.equal(r.status, 200, JSON.stringify(r.data));
    token = r.data.nextSubmitToken;
  }
  // 暂停/恢复/取消一轮：每个控制动作都消费一枚一次性令牌，动作前重新获取
  const fetchToken = async () => (await request('POST', `/api/replay-sessions/${replayId}/submit-token`, auth(client, { body: {} }))).data.submitToken;
  for (const [action, version] of [['pause', 3], ['resume', 4], ['cancel', 5]]) {
    const controlToken = await fetchToken();
    const r = await request('POST', `/api/replay-sessions/${replayId}/${action}`, auth(client, {
      body: { submitToken: controlToken, expectedVersion: version, reason: '只读测试' },
    }));
    assert.equal(r.status, 200, `${action}: ${JSON.stringify(r.data)}`);
    if (action === 'resume') token = r.data.nextSubmitToken;
  }

  const v1After = (await request('GET', `/api/archives/${v1.id}`, auth(client))).data.archive;
  const v2After = (await request('GET', `/api/archives/${v2.id}`, auth(client))).data.archive;
  assert.equal(v1After.finalHash, v1Before.finalHash, '基准归档最终摘要不变');
  assert.equal(v2After.finalHash, v2Before.finalHash, '目标归档最终摘要不变');
  assert.equal(v1After.eventCount, v1Before.eventCount);
  assert.equal(v2After.eventCount, v2Before.eventCount);
  assert.equal(v1After.chain.continuous, true);
  assert.equal(v2After.chain.continuous, true);

  // 冻结副本行数未被比较/重放模块改动（直接核对 DB）
  const c1 = db.prepare('SELECT COUNT(*) AS n FROM audit_archive_events WHERE archive_id = ?').get(v1.id).n;
  const c2 = db.prepare('SELECT COUNT(*) AS n FROM audit_archive_events WHERE archive_id = ?').get(v2.id).n;
  assert.equal(c1, v1Before.eventCount);
  assert.equal(c2, v2Before.eventCount);
  // 重放冻结副本独立存放，且没有任何业务表被写（意见只在 audit_replay_opinions）
  const replayRows = db.prepare('SELECT COUNT(*) AS n FROM audit_replay_events WHERE replay_id = ?').get(replayId).n;
  assert.equal(replayRows, 1);
  const opinionRows = db.prepare('SELECT COUNT(*) AS n FROM audit_replay_opinions WHERE replay_id = ?').get(replayId).n;
  assert.equal(opinionRows, 2);
});

// 无法对齐事件（unaligned）永远不能加入重放会话（直接构造含 unaligned 条目的报告行验证服务端拒绝）
test('无法对齐事件不能加入重放会话', async () => {
  const client = await freshHandler('cmp12');
  const { v1, v2 } = await prepareTwoVersions(client);
  const userId = (await request('GET', '/api/state', auth(client))).data.user.id;
  const comparisonId = cryptoId();
  const ts = Date.now();
  const body = {
    format: 'audit-archive-comparison/v1',
    comparisonNo: 'BD-TEST-UNALIGNED',
    base: { archiveId: v1.id, version: 1, finalHash: v1.finalHash, chainContinuous: true },
    target: { archiveId: v2.id, version: 2, finalHash: v2.finalHash, chainContinuous: true },
    source: { sourceType: 'batch', sourceId: v1.sourceId, sourceLabel: v1.sourceLabel, receiptNo: v1.receiptNo },
    entries: [],
    counts: { added: 0, deleted: 0, modified: 0, unchanged: 0, unaligned: 1 },
    unalignedReasons: [{ entryKey: 'e1', reason: '相对顺序不一致' }],
    chainContinuity: { baseContinuous: true, targetContinuous: true, alignedAcrossVersions: false },
    provenanceDiff: { same: true, added: [], removed: [] },
    statusSummaryDiff: { changed: false, changes: [] },
    permissionSnapshotDiff: { same: true, auditorGrantsAdded: [], auditorGrantsRemoved: [] },
    note: '',
  };
  const digest = createHash('sha256').update(stableStringify(body)).digest('hex');
  db.prepare(`
    INSERT INTO audit_comparisons
      (id, owner_user_id, comparison_no, receipt_no, base_archive_id, target_archive_id,
       source_type, source_id, status, note, body_json, digest,
       count_added, count_deleted, count_modified, count_unchanged, count_unaligned,
       base_chain_ok, target_chain_ok, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'frozen', '', ?, ?, 0,0,0,0,1, 1, 1, ?, NULL)
  `).run(comparisonId, userId, body.comparisonNo, v1.receiptNo, v1.id, v2.id, 'batch', v1.sourceId,
    JSON.stringify(body), digest, ts);
  db.prepare(`
    INSERT INTO audit_comparison_entries
      (id, comparison_id, ordinal, entry_key, status, reason,
       base_ordinal, base_source_event_id, base_event_hash, base_event_type, base_occurred_at,
       target_ordinal, target_source_event_id, target_event_hash, target_event_type, target_occurred_at)
    VALUES (?, ?, 0, 'e1', 'unaligned', '相对顺序不一致',
       0, 1, '', 'x', ?, 0, 1, '', 'x', ?)
  `).run(cryptoId(), comparisonId, ts, ts);

  const { createReplaySession } = await import('../src/db.js');
  const result = createReplaySession({ userId, comparisonId, entryKeys: ['e1'], ttlMs: 60 * 60 * 1000 });
  assert.equal(result.ok, false);
  assert.equal(result.status, 403);
  assert.equal(result.code, 'REPLAY_EVENT_OUT_OF_SCOPE');

  // 伪造条目同样被拒绝
  const forged = createReplaySession({ userId, comparisonId, entryKeys: ['e999'], ttlMs: 60 * 60 * 1000 });
  assert.equal(forged.ok, false);
  assert.equal(forged.code, 'REPLAY_EVENT_OUT_OF_SCOPE');
});

test.after(async () => {
  try { stopArchiveExportSweep(); } catch { /* noop */ }
  try { server.close(); } catch { /* 已关闭 */ }
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${process.env.DB_PATH}${suffix}`, { force: true });
});
