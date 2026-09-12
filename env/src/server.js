import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { timingSafeEqualBuffer } from './crypto.js';
import {
  abandonCorrectionWorkflow,
  confirmStep,
  createCorrectionWorkflow,
  createSession,
  deleteSession,
  findReceiptRowByNo,
  findUserByLogin,
  getCorrectionPreviewForUser,
  getOrCreateWorkflow,
  getReceiptForOwner,
  getReceiptForWorkflow,
  getStateForUser,
  getSteps,
  getTimelineForUser,
  getValidSession,
  issueToken,
  listReceiptsForUser,
  publicWorkflow,
  revokeReceipt,
  saveDraft,
  rollbackStep,
  snapshotOfReceiptRow,
  userQueries,
} from './db.js';
import { validateDraft, validateStepPayload } from './validation.js';
import { stableStringify } from './crypto.js';
import { STEPS } from './workflow.js';
import { peekRateLimit, recordFailure } from './rateLimit.js';
import {
  codeMatches,
  formatReceiptNoInput,
  normalizeCode,
  ownerReceipt,
  publicReceipt,
  renderReceiptDocument,
  RECEIPT_NO_PATTERN,
  CODE_PATTERN,
} from './receipts.js';

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    // 免登录公开接口：回执核验
    if (url.pathname === '/api/verify' && req.method === 'POST') {
      return publicVerify(req, res, url);
    }
    // 免登录公开页面与脱敏回执文档
    if (url.pathname === '/verify' && req.method === 'GET') {
      return serveStaticFile(req, res, '/verify.html');
    }
    const publicDocMatch = /^\/api\/public\/receipts\/([^/]+)\/print$/.exec(url.pathname);
    if (publicDocMatch && req.method === 'GET') {
      return servePublicReceiptDoc(req, res, url, publicDocMatch[1]);
    }

    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return serveStaticFile(req, res, url.pathname === '/' ? '/index.html' : url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: '服务端内部错误' } });
  }
});

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, securityHeaders());
    res.end();
    return;
  }

  if (!['GET', 'POST'].includes(req.method)) {
    return sendJson(res, 405, { error: { code: 'METHOD_NOT_ALLOWED' } });
  }

  if (url.pathname === '/api/login' && req.method === 'POST') {
    return login(req, res);
  }
  if (url.pathname === '/api/logout' && req.method === 'POST') {
    return logout(req, res);
  }

  const session = await requireAuth(req, res);
  if (!session) return;

  if (req.method === 'POST' && !checkCsrf(req, session)) {
    return sendJson(res, 403, { error: { code: 'CSRF_INVALID', message: '请求来源校验失败' } });
  }

  const user = userQueries.findById(session.user_id);
  if (!user) return sendJson(res, 401, { error: { code: 'UNAUTHENTICATED' } });

  if (url.pathname === '/api/state' && req.method === 'GET') {
    return sendJson(res, 200, { user: safeUser(user), ...getStateForUser(user.id) });
  }

  if (url.pathname === '/api/tokens' && req.method === 'POST') {
    return claimToken(req, res, user, session);
  }
  if (url.pathname === '/api/drafts' && req.method === 'POST') {
    return putDraft(req, res, user);
  }
  if (url.pathname === '/api/submissions' && req.method === 'POST') {
    return submitStep(req, res, user, session);
  }
  if (url.pathname === '/api/rollback' && req.method === 'POST') {
    return rollback(req, res, user);
  }

  // 回执相关
  if (url.pathname === '/api/receipts' && req.method === 'GET') {
    return sendJson(res, 200, { receipts: listReceiptsForUser(user.id) });
  }
  const receiptDocMatch = /^\/api\/receipts\/([^/]+)\/print$/.exec(url.pathname);
  if (receiptDocMatch && req.method === 'GET') {
    return serveOwnerReceiptDoc(req, res, user, receiptDocMatch[1]);
  }
  const receiptMatch = /^\/api\/receipts\/([^/]+)$/.exec(url.pathname);
  if (receiptMatch && req.method === 'GET') {
    const receipt = getReceiptForOwner(decodeURIComponent(receiptMatch[1]), user.id);
    if (!receipt) return sendJson(res, 404, { error: { code: 'RECEIPT_NOT_FOUND', message: '回执不存在' } });
    return sendJson(res, 200, { receipt });
  }
  if (receiptMatch && req.method === 'POST' && url.searchParams.get('action') === 'revoke') {
    return revokeOwnerReceipt(req, res, user, receiptMatch[1]);
  }
  if (url.pathname === '/api/corrections' && req.method === 'POST') {
    if (url.searchParams.get('action') === 'abandon') {
      return abandonCorrection(req, res, user);
    }
    return startCorrection(req, res, user);
  }
  if (url.pathname === '/api/corrections/preview' && req.method === 'GET') {
    const correction = getCorrectionPreviewForUser(user.id);
    if (!correction) {
      return sendJson(res, 404, { error: { code: 'NO_CORRECTION_IN_PROGRESS', message: '当前没有进行中的更正' } });
    }
    return sendJson(res, 200, { correction });
  }

  return sendJson(res, 404, { error: { code: 'NOT_FOUND' } });
}

async function login(req, res) {
  const body = await readJson(req, res);
  if (!body) return;
  const username = String(body.username || '').trim();
  const password = String(body.password || '');
  if (!username || !password) {
    return sendJson(res, 400, { error: { code: 'INVALID_LOGIN', message: '请输入用户名和密码' } });
  }
  const user = findUserByLogin(username, password);
  if (!user) {
    return sendJson(res, 401, { error: { code: 'BAD_CREDENTIALS', message: '用户名或密码错误' } });
  }
  const session = createSession(user.id);
  setSessionCookies(res, session);
  return sendJson(res, 200, {
    user: safeUser(user),
    csrfToken: session.csrf,
    ...getStateForUser(user.id),
  });
}

async function logout(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies.sid) deleteSession(cookies.sid);
  res.setHeader('Set-Cookie', [
    `sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`,
    `csrf=; SameSite=Lax; Path=/; Max-Age=0`,
  ]);
  return sendJson(res, 200, { ok: true });
}

async function claimToken(req, res, user, session) {
  const body = await readJson(req, res);
  if (!body) return;
  const step = integer(body.step);
  const pageId = String(body.pageId || '');
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(pageId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_PAGE_ID' } });
  }
  if (!Number.isInteger(step) || step < 0 || step >= STEPS.length) {
    return sendJson(res, 400, { error: { code: 'INVALID_STEP' } });
  }

  const workflow = getOrCreateWorkflow(user.id);
  if (workflow.completed_at) {
    return sendJson(res, 409, {
      error: { code: 'WORKFLOW_COMPLETED', message: '办理已完成' },
      ...envelopeOf(workflow),
    });
  }
  if (workflow.progress !== step) {
    return sendJson(res, 409, {
      error: { code: 'STEP_NOT_CURRENT', message: '只能为服务端当前步骤领取令牌' },
      ...envelopeOf(workflow),
    });
  }

  const issued = issueToken({
    workflowId: workflow.id,
    userId: user.id,
    sessionId: session.id,
    pageId,
    step,
  });
  return sendJson(res, 200, {
    token: issued.token,
    expiresAt: issued.expiresAt,
    ttlMs: config.tokenTtlMs,
    step,
    pageId,
  });
}

async function putDraft(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const step = integer(body.step);
  if (!Number.isInteger(step) || step < 0 || step >= STEPS.length) {
    return sendJson(res, 400, { error: { code: 'INVALID_STEP' } });
  }
  const validation = validateDraft(step, body.draft);
  if (validation.error) return sendJson(res, 400, { error: validation.error });

  const workflow = getOrCreateWorkflow(user.id);
  const result = saveDraft(workflow.id, step, validation.draft);
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: '只能保存服务端当前步骤的草稿' },
      ...envelopeOf(workflow),
    });
  }
  const refreshed = getOrCreateWorkflow(user.id);
  return sendJson(res, 200, { ok: true, savedAt: result.savedAt, version: refreshed.version });
}

async function submitStep(req, res, user, session) {
  const body = await readJson(req, res);
  if (!body) return;

  const step = integer(body.step);
  const pageId = String(body.pageId || '');
  const token = String(body.token || '');
  const idempotencyKey = String(body.idempotencyKey || '');
  if (!Number.isInteger(step) || step < 0 || step >= STEPS.length) {
    return sendJson(res, 400, { error: { code: 'INVALID_STEP' } });
  }
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(pageId)) {
    return sendJson(res, 400, { error: { code: 'INVALID_PAGE_ID' } });
  }
  if (!/^[A-Za-z0-9_-]{20,512}$/.test(token)) {
    return sendJson(res, 400, { error: { code: 'INVALID_TOKEN' } });
  }
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(idempotencyKey)) {
    return sendJson(res, 400, { error: { code: 'INVALID_IDEMPOTENCY_KEY' } });
  }

  const validation = validateStepPayload(step, body.payload);
  if (validation.error) return sendJson(res, 400, { error: validation.error });

  const workflow = getOrCreateWorkflow(user.id);
  const requestHash = requestFingerprint({ step, pageId, payload: validation.payload });
  const result = confirmStep({
    workflowId: workflow.id,
    userId: user.id,
    sessionId: session.id,
    pageId,
    step,
    token,
    idempotencyKey,
    payload: validation.payload,
    requestHash,
  });

  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message },
      replayed: false,
      workflow: result.workflow || null,
    });
  }

  return sendJson(res, 200, {
    replay: Boolean(result.replay),
    ok: true,
    submissionId: result.submissionId,
    confirmation: result.confirmation,
    nextStep: result.nextStep,
    completed: result.nextStep === null,
    workflow: result.workflow,
    receipt: result.receipt,
  });
}

async function rollback(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const targetStep = integer(body.targetStep);
  const expectedVersion = integer(body.expectedVersion);
  const workflow = getOrCreateWorkflow(user.id);
  const result = rollbackStep({
    workflowId: workflow.id,
    userId: user.id,
    targetStep,
    expectedVersion: Number.isInteger(expectedVersion) ? expectedVersion : undefined,
  });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '退回修改失败' },
      workflow: result.workflow,
    });
  }
  return sendJson(res, 200, { ok: true, workflow: result.workflow });
}

async function revokeOwnerReceipt(req, res, user, rawReceiptNo) {
  const body = await readJson(req, res);
  if (!body) return;
  const receiptNo = formatReceiptNoInput(decodeURIComponent(rawReceiptNo));
  const reason = String(body.reason || '').trim().slice(0, 200);
  const result = revokeReceipt({ userId: user.id, receiptNo, reason });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '撤销失败' },
      receipt: result.receipt || null,
    });
  }
  return sendJson(res, 200, { ok: true, receipt: result.receipt, records: listReceiptsForUser(user.id) });
}

async function startCorrection(req, res, user) {
  const body = await readJson(req, res);
  if (!body) return;
  const sourceReceiptNo = formatReceiptNoInput(String(body.receiptNo || ''));
  if (!RECEIPT_NO_PATTERN.test(sourceReceiptNo)) {
    return sendJson(res, 400, { error: { code: 'INVALID_RECEIPT_NO', message: '回执编号格式不正确' } });
  }
  const result = createCorrectionWorkflow({ userId: user.id, sourceReceiptNo });
  if (!result.ok) {
    // 并发发起只放行一个：失败响应携带最新办理与时间线，调用方据此重新读取最新状态
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '无法发起更正' },
      workflow: result.workflow || null,
      timeline: getTimelineForUser(user.id),
      correction: getCorrectionPreviewForUser(user.id),
    });
  }
  return sendJson(res, 200, {
    ok: true,
    workflow: envelopeOf(result.workflow).workflow,
    records: listReceiptsForUser(user.id),
    timeline: getTimelineForUser(user.id),
    correction: getCorrectionPreviewForUser(user.id),
  });
}

// 放弃更正：只关闭更正产生的新办理记录，原回执内容、状态与核验结果保持不变
async function abandonCorrection(req, res, user) {
  const result = abandonCorrectionWorkflow({ userId: user.id });
  if (!result.ok) {
    return sendJson(res, result.status || 409, {
      error: { code: result.code, message: result.message || '无法放弃更正' },
      timeline: getTimelineForUser(user.id),
    });
  }
  return sendJson(res, 200, { ok: true, sourceReceiptNo: result.sourceReceiptNo, ...getStateForUser(user.id) });
}

// 免登录核验：编号 + 核验码两者都正确才返回结果；按来源 IP 对失败尝试限流
async function publicVerify(req, res) {
  const clientIp = req.socket.remoteAddress || 'unknown';
  const limitKey = `verify:${clientIp}`;
  const rate = { windowMs: config.verifyRateWindowMs, max: config.verifyRateMax };
  const preview = peekRateLimit(limitKey, rate);
  if (!preview.allowed) {
    res.setHeader('Retry-After', String(Math.max(1, Math.ceil(preview.retryAfterMs / 1000))));
    return sendJson(res, 429, { error: { code: 'TOO_MANY_REQUESTS', message: '核验失败尝试过于频繁，请稍后再试' } });
  }

  const reject = (status, error) => {
    recordFailure(limitKey, rate);
    return sendJson(res, status, { error });
  };

  const body = await readJson(req, res);
  if (!body) return;
  const receiptNo = formatReceiptNoInput(String(body.receiptNo || ''));
  const code = normalizeCode(String(body.code || ''));
  if (!RECEIPT_NO_PATTERN.test(receiptNo) || !CODE_PATTERN.test(code)) {
    return reject(400, { code: 'INVALID_INPUT', message: '请输入格式正确的回执编号和核验码' });
  }

  const row = findReceiptRowByNo(receiptNo);
  if (!row) {
    return reject(404, { code: 'RECEIPT_NOT_FOUND', message: '回执编号不存在，请核对后重新输入' });
  }
  if (!codeMatches(receiptNo, code)) {
    return reject(403, { code: 'VERIFY_CODE_INVALID', message: '核验码错误，请核对后重新输入' });
  }
  if (row.status === 'revoked') {
    // 核验码正确：这是合法持有人的查询，不算失败尝试
    return sendJson(res, 410, {
      error: {
        code: 'RECEIPT_REVOKED',
        message: '该回执已被撤销，不再作为办理完成的有效凭证',
      },
      receipt: { receiptNo, status: 'revoked', revokedAt: row.revoked_at },
    });
  }

  return sendJson(res, 200, {
    ok: true,
    receipt: publicReceipt(row, snapshotOfReceiptRow(row)),
  });
}

function sendReceiptDocument(res, status, html, receiptNo) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(`receipt-${receiptNo}.html`)}`,
    ...securityHeaders(),
  });
  res.end(html);
}

function serveOwnerReceiptDoc(req, res, user, rawReceiptNo) {
  const receiptNo = formatReceiptNoInput(decodeURIComponent(rawReceiptNo));
  const receipt = getReceiptForOwner(receiptNo, user.id);
  if (!receipt) {
    return sendJson(res, 404, { error: { code: 'RECEIPT_NOT_FOUND', message: '回执不存在' } });
  }
  const html = renderReceiptDocument(receipt, { publicView: false });
  return sendReceiptDocument(res, 200, html, receipt.receiptNo);
}

// 公开文档同样要求先核验（只携带编号不能拿到页面）
async function servePublicReceiptDoc(req, res, url, rawReceiptNo) {
  const receiptNo = formatReceiptNoInput(decodeURIComponent(rawReceiptNo));
  const code = normalizeCode(url.searchParams.get('code') || '');
  if (!RECEIPT_NO_PATTERN.test(receiptNo) || !CODE_PATTERN.test(code)) {
    return sendJson(res, 400, { error: { code: 'INVALID_INPUT', message: '链接缺少有效的回执编号或核验码' } });
  }
  const row = findReceiptRowByNo(receiptNo);
  if (!row) {
    return sendJson(res, 404, { error: { code: 'RECEIPT_NOT_FOUND', message: '回执编号不存在' } });
  }
  if (!codeMatches(receiptNo, code)) {
    return sendJson(res, 403, { error: { code: 'VERIFY_CODE_INVALID', message: '核验码错误' } });
  }
  if (row.status === 'revoked') {
    return sendJson(res, 410, { error: { code: 'RECEIPT_REVOKED', message: '该回执已被撤销' } });
  }
  const receipt = ownerReceipt(row, snapshotOfReceiptRow(row));
  const html = renderReceiptDocument(receipt, { publicView: true });
  return sendReceiptDocument(res, 200, html, receipt.receiptNo);
}

function integer(value) {
  if (typeof value === 'boolean' || value === undefined || value === null || value === '') return NaN;
  return Number.isInteger(value) ? value : Number(value);
}

function requestFingerprint(value) {
  return Buffer.from(stableStringify(value)).toString('base64url');
}

function envelopeOf(workflow) {
  const rows = getSteps(workflow.id);
  return { workflow: publicWorkflow(workflow, rows), receipt: getReceiptForWorkflow(workflow.id) };
}

async function requireAuth(req, res) {
  const cookies = parseCookies(req.headers.cookie);
  const session = getValidSession(cookies.sid);
  if (!session) {
    sendJson(res, 401, { error: { code: 'UNAUTHENTICATED', message: '请先登录' } });
    return null;
  }
  return session;
}

function checkCsrf(req, session) {
  const header = req.headers['x-csrf-token'];
  const cookies = parseCookies(req.headers.cookie);
  return Boolean(header && cookies.csrf && header === session.csrf_secret && timingSafeEqualBuffer(header, session.csrf_secret));
}

function setSessionCookies(res, session) {
  const secure = config.cookieSecure ? '; Secure' : '';
  const maxAge = Math.floor(config.sessionTtlMs / 1000);
  res.setHeader('Set-Cookie', [
    `sid=${session.id}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`,
    `csrf=${session.csrf}; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`,
  ]);
}

function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'same-origin',
  };
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header.split(';').map((part) => part.trim().split('=').map(decodeURIComponent)).filter((pair) => pair.length === 2 && pair[0]),
  );
}

async function readJson(req, res) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') {
    sendJson(res, 415, { error: { code: 'UNSUPPORTED_MEDIA_TYPE' } });
    return null;
  }
  let raw = '';
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      sendJson(res, 413, { error: { code: 'PAYLOAD_TOO_LARGE' } });
      return null;
    }
    raw += chunk;
  }
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    sendJson(res, 400, { error: { code: 'INVALID_JSON' } });
    return null;
  }
}

function sendJson(res, status, body) {
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...securityHeaders(),
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function safeUser(user) {
  return { id: user.id, username: user.username, displayName: user.display_name || user.displayName };
}

async function serveStaticFile(req, res, pathname) {
  const filePath = path.normalize(path.join(config.rootDir, 'public', pathname));
  const publicDir = path.join(config.rootDir, 'public') + path.sep;
  if (!filePath.startsWith(publicDir) && filePath !== path.join(config.rootDir, 'public')) {
    return sendJson(res, 403, { error: { code: 'FORBIDDEN' } });
  }
  try {
    const content = await readFile(filePath);
    const ext = path.extname(filePath);
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.svg': 'image/svg+xml',
    };
    res.writeHead(200, {
      'Content-Type': types[ext] || 'application/octet-stream',
      'Cache-Control': ext === '.html' ? 'no-store' : 'no-cache',
      ...securityHeaders(),
    });
    res.end(content);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

if (process.env.NO_AUTO_LISTEN !== '1') {
  server.listen(config.port, () => {
    const port = server.address()?.port || config.port;
    console.log(`Server-authoritative wizard listening on http://0.0.0.0:${port}`);
    console.log(`SQLite database: ${config.dbPath}`);
  });
}

export { server };
