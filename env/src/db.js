import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { hashPassword, sha256, tokenUrlSafe, verifyPassword } from './crypto.js';
import { STEPS } from './workflow.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  progress INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS workflow_steps (
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  draft_json TEXT,
  confirmed_json TEXT,
  confirmed_at INTEGER,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (workflow_id, step)
);

CREATE TABLE IF NOT EXISTS tokens (
  id TEXT PRIMARY KEY,
  hash BLOB NOT NULL UNIQUE,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL,
  page_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tokens_lookup ON tokens(workflow_id, session_id, page_id, step);
CREATE INDEX IF NOT EXISTS idx_tokens_cleanup ON tokens(expires_at);

CREATE TABLE IF NOT EXISTS submissions (
  id TEXT PRIMARY KEY,
  workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
  token_id TEXT NOT NULL REFERENCES tokens(id),
  step INTEGER NOT NULL,
  page_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  confirmation_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(workflow_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_submissions_token ON submissions(token_id);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workflow_id TEXT NOT NULL,
  type TEXT NOT NULL,
  step INTEGER,
  detail_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

function now() {
  return Date.now();
}

export function immediateTransaction(fn) {
  return db.transaction(fn).immediate();
}

function seedUser(username, displayName) {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return existing.id;
  const { salt, hash } = hashPassword(config.demoPassword);
  const id = cryptoId();
  db.prepare(`
    INSERT INTO users (id, username, display_name, password_salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, username, displayName, salt, hash, now());
  return id;
}

export function cryptoId() {
  return tokenUrlSafe();
}

seedUser('alice', 'Alice 示例用户');
seedUser('bob', 'Bob 示例用户');
seedUser('carol', 'Carol 并发测试用户');

export function findUserByLogin(username, password) {
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  if (!user) return null;
  return verifyPassword(password, user.password_salt, user.password_hash) ? user : null;
}

export const userQueries = {
  findByUsername(username) {
    return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
  },
  findById(id) {
    return db.prepare('SELECT id, username, display_name, created_at FROM users WHERE id = ?').get(id);
  },
};

export function createSession(userId) {
  const id = cryptoId();
  const csrf = tokenUrlSafe();
  const ts = now();
  db.prepare(`
    INSERT INTO sessions (id, user_id, csrf_secret, created_at, expires_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(id, userId, csrf, ts, ts + config.sessionTtlMs);
  return { id, csrf };
}

export function getValidSession(sessionId) {
  if (!sessionId) return null;
  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  if (!session || session.expires_at <= now()) return null;
  db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?').run(now() + config.sessionTtlMs, sessionId);
  return session;
}

export function deleteSession(sessionId) {
  db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
}

export function getOrCreateWorkflow(userId) {
  const ts = now();
  return immediateTransaction(() => {
    let workflow = db.prepare('SELECT * FROM workflows WHERE user_id = ?').get(userId);
    if (!workflow) {
      const id = cryptoId();
      db.prepare(`
        INSERT INTO workflows (id, user_id, progress, version, completed_at, created_at, updated_at)
        VALUES (?, ?, 0, 0, NULL, ?, ?)
      `).run(id, userId, ts, ts);
      STEPS.forEach((_, step) => {
        db.prepare(`
          INSERT INTO workflow_steps (workflow_id, step, draft_json, confirmed_json, confirmed_at, updated_at)
          VALUES (?, ?, NULL, NULL, NULL, ?)
        `).run(id, step, ts);
      });
      workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
      addEvent(id, 'workflow.created', null, {});
    }
    return workflow;
  });
}

export function getWorkflowForUser(userId) {
  return db.prepare('SELECT * FROM workflows WHERE user_id = ?').get(userId);
}

export function getSteps(workflowId) {
  return db.prepare('SELECT * FROM workflow_steps WHERE workflow_id = ? ORDER BY step').all(workflowId);
}

export function saveDraft(workflowId, step, draft) {
  const ts = now();
  return immediateTransaction(() => {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId);
    if (!workflow || workflow.progress !== step || workflow.completed_at) {
      return { ok: false, code: 'STEP_NOT_CURRENT' };
    }
    db.prepare(`
      UPDATE workflow_steps
      SET draft_json = ?, updated_at = ?
      WHERE workflow_id = ? AND step = ?
    `).run(JSON.stringify(draft), ts, workflowId, step);
    bumpWorkflow(workflowId);
    addEvent(workflowId, 'draft.saved', step, {});
    return { ok: true, savedAt: ts };
  });
}

export function issueToken({ workflowId, userId, sessionId, pageId, step }) {
  const raw = tokenUrlSafe();
  const id = cryptoId();
  const ts = now();
  immediateTransaction(() => {
    db.prepare(`
      UPDATE tokens
      SET revoked_at = ?
      WHERE workflow_id = ? AND session_id = ? AND page_id = ? AND step = ?
        AND used_at IS NULL AND revoked_at IS NULL
    `).run(ts, workflowId, sessionId, pageId, step);
    db.prepare(`
      INSERT INTO tokens
        (id, hash, workflow_id, user_id, session_id, page_id, step, expires_at, used_at, revoked_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
    `).run(id, sha256(raw), workflowId, userId, sessionId, pageId, step, ts + config.tokenTtlMs, ts);
  });
  return { token: raw, tokenId: id, expiresAt: ts + config.tokenTtlMs };
}

export function confirmStep({ workflowId, userId, sessionId, pageId, step, token, idempotencyKey, payload, requestHash }) {
  return immediateTransaction(() => {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ? AND user_id = ?').get(workflowId, userId);
    if (!workflow) return { ok: false, status: 404, code: 'WORKFLOW_NOT_FOUND' };
    if (workflow.completed_at) {
      return { ok: false, status: 409, code: 'WORKFLOW_COMPLETED', workflow: publicWorkflow(workflow, getSteps(workflowId)) };
    }

    const priorSubmission = db.prepare(`
      SELECT * FROM submissions WHERE workflow_id = ? AND idempotency_key = ?
    `).get(workflowId, idempotencyKey);
    if (priorSubmission) {
      if (priorSubmission.request_hash !== requestHash || workflow.progress !== priorSubmission.step + 1) {
        return conflict(workflow, 'SUBMISSION_ALREADY_PROCESSED', '该提交已经处理或其确认已被退回失效，不能重复使用');
      }
      if (workflow.progress === priorSubmission.step + 1) {
        return {
          ok: true,
          replay: true,
          submissionId: priorSubmission.id,
          confirmation: JSON.parse(priorSubmission.confirmation_json),
          nextStep: workflow.progress >= STEPS.length ? null : workflow.progress,
          workflow: publicWorkflow(workflow, getSteps(workflowId)),
        };
      }
    }

    const tokenRow = db.prepare('SELECT * FROM tokens WHERE hash = ?').get(sha256(token));
    if (!tokenRow || tokenRow.workflow_id !== workflowId || tokenRow.user_id !== userId) {
      return conflict(workflow, 'TOKEN_NOT_FOUND', '令牌不存在或不属于当前办理');
    }
    if (tokenRow.session_id !== sessionId) {
      return conflict(workflow, 'TOKEN_SESSION_MISMATCH', '令牌不能跨登录会话使用');
    }
    if (tokenRow.page_id !== pageId) {
      return conflict(workflow, 'TOKEN_PAGE_MISMATCH', '令牌不能换到另一个页面使用');
    }
    if (tokenRow.step !== step) {
      return conflict(workflow, 'TOKEN_STEP_MISMATCH', '令牌不能跨步骤使用');
    }
    if (tokenRow.used_at) {
      return conflict(workflow, 'TOKEN_USED', '令牌已经使用过，不能重放');
    }
    if (workflow.progress !== step) {
      return conflict(workflow, 'PROGRESS_MOVED', '服务端当前进度已变化');
    }
    if (tokenRow.revoked_at) {
      return conflict(workflow, 'CONCURRENT_PROGRESS_CHANGED', '另一个页面已推进办理，请重新读取最新进度');
    }
    if (tokenRow.expires_at <= now()) {
      db.prepare('UPDATE tokens SET revoked_at = ? WHERE id = ?').run(now(), tokenRow.id);
      return conflict(workflow, 'TOKEN_EXPIRED', '令牌已过期，请重新领取');
    }

    const ts = now();
    const submissionId = cryptoId();
    const confirmation = {
      confirmationNo: `C-${workflow.id.slice(0, 8)}-${step + 1}-${ts.toString(36)}`.toUpperCase(),
      step,
      confirmedAt: ts,
      payload,
    };

    db.prepare(`
      UPDATE workflow_steps
      SET confirmed_json = ?, confirmed_at = ?, draft_json = ?, updated_at = ?
      WHERE workflow_id = ? AND step = ?
    `).run(JSON.stringify(payload), ts, JSON.stringify(payload), ts, workflowId, step);

    db.prepare('UPDATE tokens SET used_at = ? WHERE id = ?').run(ts, tokenRow.id);
    db.prepare(`
      UPDATE tokens
      SET revoked_at = ?
      WHERE workflow_id = ? AND id <> ? AND step >= ? AND used_at IS NULL AND revoked_at IS NULL
    `).run(ts, workflowId, tokenRow.id, step);

    db.prepare(`
      INSERT INTO submissions
        (id, workflow_id, token_id, step, page_id, idempotency_key, request_hash,
         payload_json, confirmation_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      submissionId,
      workflowId,
      tokenRow.id,
      step,
      pageId,
      idempotencyKey,
      requestHash,
      JSON.stringify(payload),
      JSON.stringify(confirmation),
      ts,
    );

    const nextProgress = step + 1;
    const completedAt = nextProgress >= STEPS.length ? ts : null;
    db.prepare(`
      UPDATE workflows
      SET progress = ?, version = version + 1, completed_at = ?, updated_at = ?
      WHERE id = ?
    `).run(nextProgress, completedAt, ts, workflowId);

    addEvent(workflowId, completedAt ? 'workflow.completed' : 'step.confirmed', step, { submissionId });

    const refreshed = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId);
    return {
      ok: true,
      submissionId,
      confirmation,
      nextStep: completedAt ? null : nextProgress,
      workflow: publicWorkflow(refreshed, getSteps(workflowId)),
    };
  });
}

export function rollbackStep({ workflowId, userId, targetStep, expectedVersion }) {
  return immediateTransaction(() => {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ? AND user_id = ?').get(workflowId, userId);
    if (!workflow) return { ok: false, status: 404, code: 'WORKFLOW_NOT_FOUND' };
    if (workflow.completed_at) return { ok: false, status: 409, code: 'WORKFLOW_COMPLETED' };
    if (!Number.isInteger(targetStep) || targetStep < 0 || targetStep >= workflow.progress) {
      return { ok: false, status: 400, code: 'INVALID_ROLLBACK_TARGET' };
    }
    if (expectedVersion !== undefined && expectedVersion !== workflow.version) {
      return { ok: false, status: 409, code: 'WORKFLOW_VERSION_CONFLICT', workflow: publicWorkflow(workflow, getSteps(workflowId)) };
    }

    const ts = now();
    const rows = getSteps(workflowId);
    for (let step = targetStep; step < STEPS.length; step += 1) {
      const row = rows[step];
      if (!row) continue;
      if (step === targetStep) {
        db.prepare(`
          UPDATE workflow_steps
          SET confirmed_json = NULL,
              confirmed_at = NULL,
              draft_json = COALESCE(confirmed_json, draft_json),
              updated_at = ?
          WHERE workflow_id = ? AND step = ?
        `).run(ts, workflowId, step);
      } else {
        db.prepare(`
          UPDATE workflow_steps
          SET confirmed_json = NULL,
              confirmed_at = NULL,
              draft_json = COALESCE(draft_json, confirmed_json),
              updated_at = ?
          WHERE workflow_id = ? AND step = ?
        `).run(ts, workflowId, step);
      }
    }

    db.prepare(`
      UPDATE tokens
      SET revoked_at = ?
      WHERE workflow_id = ? AND step >= ? AND used_at IS NULL AND revoked_at IS NULL
    `).run(ts, workflowId, targetStep);

    db.prepare(`
      UPDATE workflows
      SET progress = ?, version = version + 1, completed_at = NULL, updated_at = ?
      WHERE id = ?
    `).run(targetStep, ts, workflowId);
    addEvent(workflowId, 'steps.invalidated', targetStep, { from: targetStep });

    const refreshed = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId);
    return { ok: true, workflow: publicWorkflow(refreshed, getSteps(workflowId)) };
  });
}

function conflict(workflow, code, message) {
  return {
    ok: false,
    status: 409,
    code,
    message,
    workflow: publicWorkflow(workflow, getSteps(workflow.id)),
  };
}

function bumpWorkflow(workflowId) {
  db.prepare('UPDATE workflows SET version = version + 1, updated_at = ? WHERE id = ?').run(now(), workflowId);
}

function addEvent(workflowId, type, step, detail) {
  db.prepare(`
    INSERT INTO events (workflow_id, type, step, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?)
  `).run(workflowId, type, step ?? null, JSON.stringify(detail), now());
}

export function publicWorkflow(workflow, rows) {
  const steps = rows.map((row) => {
    const confirmed = row.confirmed_json ? JSON.parse(row.confirmed_json) : null;
    const draft = row.draft_json ? JSON.parse(row.draft_json) : null;
    return {
      step: row.step,
      key: STEPS[row.step]?.key,
      title: STEPS[row.step]?.title,
      draft,
      confirmed,
      confirmedAt: row.confirmed_at || null,
      status: row.confirmed_at
        ? 'confirmed'
        : row.step < workflow.progress
          ? 'invalidated'
          : row.step === workflow.progress
            ? 'current'
            : 'locked',
    };
  });
  return {
    id: workflow.id,
    progress: workflow.progress,
    version: workflow.version,
    completedAt: workflow.completed_at || null,
    completed: Boolean(workflow.completed_at),
    steps,
  };
}
