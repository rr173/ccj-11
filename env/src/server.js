import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from './config.js';
import { timingSafeEqualBuffer } from './crypto.js';
import {
  confirmStep,
  createSession,
  deleteSession,
  findUserByLogin,
  getOrCreateWorkflow,
  getSteps,
  getValidSession,
  getWorkflowForUser,
  issueToken,
  publicWorkflow,
  rollbackStep,
  saveDraft,
  userQueries,
} from './db.js';
import { validateDraft, validateStepPayload } from './validation.js';
import { stableStringify } from './crypto.js';
import { STEPS } from './workflow.js';

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return handleApi(req, res, url);
    return handleStatic(req, res, url);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: '服务端内部错误' } });
  }
});

async function handleApi(req, res, url) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
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
    const workflow = getOrCreateWorkflow(user.id);
    return sendJson(res, 200, { user: safeUser(user), workflow: publicWorkflow(workflow, getSteps(workflow.id)) });
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
  const workflow = getOrCreateWorkflow(user.id);
  return sendJson(res, 200, {
    user: safeUser(user),
    csrfToken: session.csrf,
    workflow: publicWorkflow(workflow, getSteps(workflow.id)),
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
      workflow: publicWorkflow(workflow, getSteps(workflow.id)),
    });
  }
  if (workflow.progress !== step) {
    return sendJson(res, 409, {
      error: { code: 'STEP_NOT_CURRENT', message: '只能为服务端当前步骤领取令牌' },
      workflow: publicWorkflow(workflow, getSteps(workflow.id)),
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
      workflow: publicWorkflow(getWorkflowForUser(user.id), getSteps(workflow.id)),
    });
  }
  const refreshed = getWorkflowForUser(user.id);
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
      workflow: result.workflow || publicWorkflow(getWorkflowForUser(user.id), getSteps(workflow.id)),
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
      error: { code: result.code, message: '退回修改失败' },
      workflow: result.workflow,
    });
  }
  return sendJson(res, 200, { ok: true, workflow: result.workflow });
}

function integer(value) {
  if (typeof value === 'boolean' || value === undefined || value === null || value === '') return NaN;
  return Number.isInteger(value) ? value : Number(value);
}

function requestFingerprint(value) {
  return Buffer.from(stableStringify(value)).toString('base64url');
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

function corsHeaders() {
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
    ...corsHeaders(),
  };
  res.writeHead(status, headers);
  res.end(JSON.stringify(body));
}

function safeUser(user) {
  return { id: user.id, username: user.username, displayName: user.display_name || user.displayName };
}

async function handleStatic(req, res, url) {
  let pathname = url.pathname === '/' ? '/index.html' : url.pathname;
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
      ...corsHeaders(),
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
