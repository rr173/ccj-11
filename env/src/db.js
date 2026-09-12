import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';
import { hashPassword, sha256, tokenUrlSafe, verifyPassword } from './crypto.js';
import { STEPS } from './workflow.js';
import {
  buildSnapshot,
  newReceiptNo,
  ownerReceipt,
  receiptSummary,
  RECEIPT_NO_PATTERN,
} from './receipts.js';
import { buildCorrectionDiff } from './corrections.js';

mkdirSync(dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000');
db.pragma('foreign_keys = ON');

function columnInfo(table) {
  try {
    return db.prepare(`PRAGMA table_info(${table})`).all();
  } catch {
    return [];
  }
}

const hasDb = columnInfo('users').length > 0;
const legacyWorkflows = hasDb && columnInfo('workflows').some((c) => c.name === 'user_id')
  && !columnInfo('workflows').some((c) => c.name === 'sequence');
const hasReceipts = columnInfo('receipts').length > 0;

// 旧库迁移必须在 foreign_keys 开启前完成（SQLite 不允许在事务中切换该开关）
if (legacyWorkflows) {
  db.pragma('foreign_keys = OFF');
  // 保持子表外键仍引用 "workflows" 表名，不被 RENAME 改写
  db.pragma('legacy_alter_table = ON');
  db.exec('ALTER TABLE workflows RENAME TO workflows_old;');
  db.pragma('legacy_alter_table = OFF');
}

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

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  receipt_no TEXT NOT NULL UNIQUE,
  workflow_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'issued' CHECK (status IN ('issued', 'revoked')),
  snapshot_json TEXT NOT NULL,
  revoke_reason TEXT NOT NULL DEFAULT '',
  issued_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_receipts_user ON receipts(user_id, issued_at);
CREATE INDEX IF NOT EXISTS idx_receipts_workflow ON receipts(workflow_id);

-- 同一用户可有多条办理记录：首次办理 + 每次更正产生的新记录；
-- 旧的已完成记录与其回执永久冻结、不可覆盖。
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'completed')),
  source_receipt_no TEXT NOT NULL DEFAULT '',
  progress INTEGER NOT NULL DEFAULT 0,
  version INTEGER NOT NULL DEFAULT 0,
  completed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflows_user ON workflows(user_id, sequence);

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

// 每人至多一条进行中的办理（更正接口并发调用不会产生两条）
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_one_open
  ON workflows(user_id) WHERE status = 'open';
`);

// 同一份回执至多一条进行中的更正（与上一索引叠加，兜底并发与异常路径）
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_one_open_correction_per_receipt
  ON workflows(source_receipt_no) WHERE status = 'open' AND source_receipt_no <> '';
`);

if (legacyWorkflows) {
  db.transaction(() => {
    db.exec(`
      INSERT INTO workflows (id, user_id, sequence, status, source_receipt_no, progress, version, completed_at, created_at, updated_at)
      SELECT id, user_id, 1,
             CASE WHEN completed_at IS NOT NULL THEN 'completed' ELSE 'open' END,
             '', progress, version, completed_at, created_at, updated_at
      FROM workflows_old;
    `);
    db.exec('DROP TABLE workflows_old;');
  })();
  db.pragma('foreign_keys = ON');
}

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
seedUser('dave', 'Dave 回执测试用户');
seedUser('erin', 'Erin 回执测试用户');

// 旧库已完成但当时尚未签发回执的记录，在升级时补签（内容按已持久化的确认冻结）
if (legacyWorkflows || !hasReceipts) {
  backfillReceipts();
}

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

function createWorkflowRow(userId) {
  const ts = now();
  return immediateTransaction(() => {
    const maxSeq = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM workflows WHERE user_id = ?').get(userId).max_seq;
    const id = cryptoId();
    db.prepare(`
      INSERT INTO workflows (id, user_id, sequence, status, source_receipt_no, progress, version, completed_at, created_at, updated_at)
      VALUES (?, ?, ?, 'open', '', 0, 0, NULL, ?, ?)
    `).run(id, userId, maxSeq + 1, ts, ts);
    STEPS.forEach((_, step) => {
      db.prepare(`
        INSERT INTO workflow_steps (workflow_id, step, draft_json, confirmed_json, confirmed_at, updated_at)
        VALUES (?, ?, NULL, NULL, NULL, ?)
      `).run(id, step, ts);
    });
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
    addEvent(id, 'workflow.created', null, { sequence: workflow.sequence });
    return workflow;
  });
}

// 进行中的办理优先；首次访问时创建；已完成时返回最近的只读记录，
// 只有显式的“更正”接口才会创建新的办理记录。
export function getOrCreateWorkflow(userId) {
  const active = getActiveWorkflow(userId);
  if (active) return active;
  const latest = db.prepare('SELECT * FROM workflows WHERE user_id = ? ORDER BY sequence DESC LIMIT 1').get(userId);
  return latest || createWorkflowRow(userId);
}

export function getActiveWorkflow(userId) {
  return db.prepare(`
    SELECT * FROM workflows WHERE user_id = ? AND status = 'open'
    ORDER BY sequence DESC LIMIT 1
  `).get(userId) || null;
}

// 基于一份已签发回执发起更正：原回执与原办理冻结不变，另开一条新的办理记录；
// 新记录的各步草稿用原回执快照预填，办理人在此基础上修改，更正预览据此计算差异。
export function createCorrectionWorkflow({ userId, sourceReceiptNo }) {
  return immediateTransaction(() => {
    const source = db.prepare(`
      SELECT * FROM receipts WHERE receipt_no = ? AND user_id = ?
    `).get(sourceReceiptNo, userId);
    if (!source) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND', message: '回执不存在或不属于当前账号' };

    const existingOpen = getActiveWorkflow(userId);
    if (existingOpen) {
      const sameReceipt = existingOpen.source_receipt_no === source.receipt_no;
      return {
        ok: false,
        status: 409,
        code: sameReceipt ? 'CORRECTION_IN_PROGRESS' : 'OPEN_WORKFLOW_EXISTS',
        message: sameReceipt
          ? '该回执已存在一份进行中的更正，不能重复发起；请继续当前更正，或先放弃后再重新发起'
          : '已有进行中的办理，请先完成或放弃后再发起更正',
        workflow: publicWorkflow(existingOpen, getSteps(existingOpen.id)),
      };
    }

    const ts = now();
    const maxSeq = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM workflows WHERE user_id = ?').get(userId).max_seq;
    const id = cryptoId();
    const sourceSnapshot = JSON.parse(source.snapshot_json);
    try {
      db.prepare(`
        INSERT INTO workflows (id, user_id, sequence, status, source_receipt_no, progress, version, completed_at, created_at, updated_at)
        VALUES (?, ?, ?, 'open', ?, 0, 0, NULL, ?, ?)
      `).run(id, userId, maxSeq + 1, source.receipt_no, ts, ts);
    } catch (error) {
      // 两个页面同时发起：唯一索引只放行一个，另一个明确失败并重新读取最新状态
      if (String(error?.message || '').includes('UNIQUE')) {
        return {
          ok: false,
          status: 409,
          code: 'CORRECTION_IN_PROGRESS',
          message: '该回执的更正已由另一个页面发起，请重新读取最新状态',
        };
      }
      throw error;
    }
    STEPS.forEach((_, step) => {
      const data = sourceSnapshot.steps?.[step]?.data;
      db.prepare(`
        INSERT INTO workflow_steps (workflow_id, step, draft_json, confirmed_json, confirmed_at, updated_at)
        VALUES (?, ?, ?, NULL, NULL, ?)
      `).run(id, step, data ? JSON.stringify(data) : null, ts);
    });
    addEvent(id, 'workflow.created', null, { sequence: maxSeq + 1, correctionOf: source.receipt_no });
    return { ok: true, workflow: db.prepare('SELECT * FROM workflows WHERE id = ?').get(id) };
  });
}

// 放弃进行中的更正：只删除更正产生的新办理记录及其草稿/令牌/提交，
// 原回执（冻结快照、状态、核验码）与原办理记录完全不受影响。
export function abandonCorrectionWorkflow({ userId }) {
  return immediateTransaction(() => {
    const workflow = getActiveWorkflow(userId);
    if (!workflow) {
      return { ok: false, status: 404, code: 'NO_OPEN_WORKFLOW', message: '当前没有进行中的办理' };
    }
    if (!workflow.source_receipt_no) {
      return { ok: false, status: 409, code: 'NOT_A_CORRECTION', message: '当前进行中的办理不是更正，不能通过放弃更正关闭' };
    }
    const sourceReceiptNo = workflow.source_receipt_no;
    addEvent(workflow.id, 'correction.abandoned', null, { sourceReceiptNo });
    // 显式清理子表（同时有外键级联兜底）
    db.prepare('DELETE FROM submissions WHERE workflow_id = ?').run(workflow.id);
    db.prepare('DELETE FROM tokens WHERE workflow_id = ?').run(workflow.id);
    db.prepare('DELETE FROM workflow_steps WHERE workflow_id = ?').run(workflow.id);
    db.prepare('DELETE FROM workflows WHERE id = ?').run(workflow.id);
    return { ok: true, sourceReceiptNo };
  });
}

export function getWorkflowForUser(userId) {
  const active = getActiveWorkflow(userId);
  if (active) return active;
  return db.prepare('SELECT * FROM workflows WHERE user_id = ? ORDER BY sequence DESC LIMIT 1').get(userId);
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

    // 幂等回放必须先于“已完成”检查：最后一步的网络重试在完成后到达，
    // 仍应返回同一份提交结果与同一份回执，而不是报错或生成第二份。
    const priorSubmission = db.prepare(`
      SELECT * FROM submissions WHERE workflow_id = ? AND idempotency_key = ?
    `).get(workflowId, idempotencyKey);
    if (priorSubmission) {
      if (priorSubmission.request_hash !== requestHash || workflow.progress !== priorSubmission.step + 1) {
        return conflict(workflow, 'SUBMISSION_ALREADY_PROCESSED', '该提交已经处理或其确认已被退回失效，不能重复使用');
      }
      const refreshed = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId);
      return {
        ok: true,
        replay: true,
        submissionId: priorSubmission.id,
        confirmation: JSON.parse(priorSubmission.confirmation_json),
        nextStep: refreshed.progress >= STEPS.length ? null : refreshed.progress,
        workflow: publicRow(refreshed),
        receipt: getReceiptForWorkflow(workflowId),
      };
    }

    if (workflow.completed_at) {
      return {
        ok: false,
        status: 409,
        code: 'WORKFLOW_COMPLETED',
        message: '办理已完成，回执不可修改或覆盖；如需更正请发起新的办理记录',
        workflow: publicRow(workflow),
      };
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
    const isFinal = nextProgress >= STEPS.length;
    db.prepare(`
      UPDATE workflows
      SET progress = ?, version = version + 1, completed_at = ?,
          status = CASE WHEN ? >= ? THEN 'completed' ELSE 'open' END,
          updated_at = ?
      WHERE id = ?
    `).run(nextProgress, isFinal ? ts : null, nextProgress, STEPS.length, ts, workflowId);

    let receipt = null;
    if (isFinal) {
      const completed = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId);
      receipt = issueReceiptForWorkflow(completed);
      addEvent(workflowId, 'receipt.issued', step, { receiptNo: receipt.receiptNo });
    }
    addEvent(workflowId, isFinal ? 'workflow.completed' : 'step.confirmed', step, { submissionId });

    const refreshed = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId);
    return {
      ok: true,
      submissionId,
      confirmation,
      nextStep: isFinal ? null : nextProgress,
      workflow: publicRow(refreshed),
      receipt,
    };
  });
}

export function rollbackStep({ workflowId, userId, targetStep, expectedVersion }) {
  return immediateTransaction(() => {
    const workflow = db.prepare('SELECT * FROM workflows WHERE id = ? AND user_id = ?').get(workflowId, userId);
    if (!workflow) return { ok: false, status: 404, code: 'WORKFLOW_NOT_FOUND' };
    // 已完成（回执已签发）的办理不可退回修改
    if (workflow.completed_at) {
      return {
        ok: false,
        status: 409,
        code: 'WORKFLOW_COMPLETED',
        message: '已完成的回执不能退回修改；如需更正请发起新的办理记录',
        workflow: publicRow(workflow),
      };
    }
    if (!Number.isInteger(targetStep) || targetStep < 0 || targetStep >= workflow.progress) {
      return { ok: false, status: 400, code: 'INVALID_ROLLBACK_TARGET' };
    }
    if (expectedVersion !== undefined && expectedVersion !== workflow.version) {
      return { ok: false, status: 409, code: 'WORKFLOW_VERSION_CONFLICT', workflow: publicRow(workflow) };
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
      SET progress = ?, version = version + 1, completed_at = NULL, status = 'open', updated_at = ?
      WHERE id = ?
    `).run(targetStep, ts, workflowId);
    addEvent(workflowId, 'steps.invalidated', targetStep, { from: targetStep });

    const refreshed = db.prepare('SELECT * FROM workflows WHERE id = ?').get(workflowId);
    return { ok: true, workflow: publicRow(refreshed) };
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

function publicRow(workflow) {
  return publicWorkflow(workflow, getSteps(workflow.id));
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

// ---------------------------------------------------------------------------
// 回执
// ---------------------------------------------------------------------------

// 在事务内调用：编号碰撞时重试（编号含 40 位随机熵，碰撞概率可忽略，仅作严谨兜底）
function insertReceiptRow(workflow, issuedAt) {
  const steps = getSteps(workflow.id);
  const snapshot = buildSnapshot({ workflow, steps, sequence: workflow.sequence });
  const snapshotJson = JSON.stringify(snapshot);
  const insert = db.prepare(`
    INSERT INTO receipts (id, receipt_no, workflow_id, user_id, status, snapshot_json, revoke_reason, issued_at, revoked_at)
    VALUES (?, ?, ?, ?, 'issued', ?, '', ?, NULL)
  `);
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const receiptNo = newReceiptNo(issuedAt);
    try {
      const id = cryptoId();
      insert.run(id, receiptNo, workflow.id, workflow.user_id, snapshotJson, issuedAt);
      return db.prepare('SELECT * FROM receipts WHERE id = ?').get(id);
    } catch (error) {
      if (String(error?.message || '').includes('UNIQUE') && attempt < 4) continue;
      throw error;
    }
  }
  throw new Error('回执编号连续冲突，请重试');
}

function issueReceiptForWorkflow(workflow) {
  // 已存在则原样返回：网络重试、并发、回放都只能拿到同一份回执
  const existing = db.prepare('SELECT * FROM receipts WHERE workflow_id = ?').get(workflow.id);
  if (existing) return hydrateReceipt(existing);
  const row = insertReceiptRow(workflow, workflow.completed_at || now());
  return hydrateReceipt(row);
}

function backfillReceipts() {
  const rows = db.prepare(`
    SELECT w.* FROM workflows w
    LEFT JOIN receipts r ON r.workflow_id = w.id
    WHERE w.completed_at IS NOT NULL AND r.id IS NULL
  `).all();
  if (rows.length === 0) return;
  immediateTransaction(() => {
    for (const workflow of rows) {
      const receipt = issueReceiptForWorkflow(workflow);
      addEvent(workflow.id, 'receipt.issued', null, { receiptNo: receipt.receiptNo, backfilled: true });
    }
  });
}

function hydrateReceipt(row) {
  return ownerReceipt(row, JSON.parse(row.snapshot_json));
}

export function getReceiptForWorkflow(workflowId) {
  const row = db.prepare('SELECT * FROM receipts WHERE workflow_id = ?').get(workflowId);
  return row ? hydrateReceipt(row) : null;
}

export function getReceiptForOwner(receiptNo, userId) {
  const row = db.prepare('SELECT * FROM receipts WHERE receipt_no = ? AND user_id = ?').get(receiptNo, userId);
  return row ? hydrateReceipt(row) : null;
}

export function listReceiptsForUser(userId) {
  return db.prepare(`
    SELECT r.*, w.sequence, w.completed_at
    FROM receipts r
    JOIN workflows w ON w.id = r.workflow_id
    WHERE r.user_id = ?
    ORDER BY r.issued_at DESC, r.receipt_no DESC
  `).all(userId).map(receiptSummary);
}

export function findReceiptRowByNo(receiptNo) {
  if (!RECEIPT_NO_PATTERN.test(receiptNo)) return null;
  return db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(receiptNo) || null;
}

export function snapshotOfReceiptRow(row) {
  return JSON.parse(row.snapshot_json);
}

// 撤销：回执内容（snapshot_json）永不删除、永不修改，只变更状态
export function revokeReceipt({ userId, receiptNo, reason }) {
  return immediateTransaction(() => {
    const row = db.prepare('SELECT * FROM receipts WHERE receipt_no = ? AND user_id = ?').get(receiptNo, userId);
    if (!row) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND' };
    if (row.status === 'revoked') {
      return { ok: false, status: 409, code: 'RECEIPT_ALREADY_REVOKED', message: '该回执已经处于撤销状态', receipt: hydrateReceipt(row) };
    }
    const ts = now();
    db.prepare('UPDATE receipts SET status = ?, revoked_at = ?, revoke_reason = ? WHERE id = ?')
      .run('revoked', ts, String(reason || '').slice(0, 200), row.id);
    addEvent(row.workflow_id, 'receipt.revoked', null, { receiptNo: row.receipt_no, reason: String(reason || '').slice(0, 200) });
    return { ok: true, receipt: hydrateReceipt(db.prepare('SELECT * FROM receipts WHERE id = ?').get(row.id)) };
  });
}

// ---------------------------------------------------------------------------
// 对外视图
// ---------------------------------------------------------------------------

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
    sequence: workflow.sequence,
    status: workflow.status,
    sourceReceiptNo: workflow.source_receipt_no || '',
    progress: workflow.progress,
    version: workflow.version,
    completedAt: workflow.completed_at || null,
    completed: Boolean(workflow.completed_at),
    steps,
  };
}

// 状态信封：当前进行中的办理（无则最近一条只读记录）+ 该记录回执 + 历史回执清单
export function stateEnvelope(workflow) {
  const publicView = publicWorkflow(workflow, getSteps(workflow.id));
  const receipt = getReceiptForWorkflow(workflow.id);
  return { workflow: publicView, receipt };
}

// ---------------------------------------------------------------------------
// 回执版本时间线：按办理顺序（sequence 升序）展示每次办理产生的回执、
// 正在进行中的更正草稿，以及它们之间的来源关系（更正自哪份回执 / 被哪份更正）。
// 关系完全由 workflows.source_receipt_no 派生，该字段创建后不再改变，
// 因此新回执签发不会改变旧回执在时间线中的位置与关系。
// ---------------------------------------------------------------------------
export function getTimelineForUser(userId) {
  const workflows = db.prepare(`
    SELECT * FROM workflows WHERE user_id = ? ORDER BY sequence ASC, created_at ASC
  `).all(userId);
  const receipts = db.prepare('SELECT * FROM receipts WHERE user_id = ?').all(userId);
  const receiptByWorkflow = new Map(receipts.map((row) => [row.workflow_id, row]));

  const entries = [];
  for (const workflow of workflows) {
    const receipt = receiptByWorkflow.get(workflow.id);
    if (receipt) {
      entries.push({
        kind: 'receipt',
        sequence: workflow.sequence,
        receiptNo: receipt.receipt_no,
        status: receipt.status,
        issuedAt: receipt.issued_at,
        completedAt: workflow.completed_at,
        revokedAt: receipt.revoked_at || null,
        sourceReceiptNo: workflow.source_receipt_no || '',
        correctedBy: [],
      });
    } else if (workflow.status === 'open') {
      entries.push({
        kind: workflow.source_receipt_no ? 'correction' : 'initial',
        sequence: workflow.sequence,
        workflowId: workflow.id,
        status: 'in_progress',
        progress: workflow.progress,
        totalSteps: STEPS.length,
        startedAt: workflow.created_at,
        sourceReceiptNo: workflow.source_receipt_no || '',
      });
    }
  }

  // 挂接来源关系：每个更正条目记录到被更正回执的 correctedBy 上
  const receiptEntries = new Map(entries.filter((e) => e.kind === 'receipt').map((e) => [e.receiptNo, e]));
  for (const entry of entries) {
    if (!entry.sourceReceiptNo) continue;
    const source = receiptEntries.get(entry.sourceReceiptNo);
    if (!source) continue;
    source.correctedBy.push(entry.kind === 'receipt'
      ? { kind: 'receipt', receiptNo: entry.receiptNo, status: entry.status }
      : { kind: 'correction', workflowId: entry.workflowId, status: 'in_progress' });
  }
  return entries;
}

// 更正预览：原回执冻结快照 vs 当前更正草稿的字段级差异。
// 敏感字段（证件号码、详细地址）在服务端遮罩后才下发。
export function getCorrectionPreviewForUser(userId) {
  const workflow = getActiveWorkflow(userId);
  if (!workflow || !workflow.source_receipt_no) return null;
  const source = db.prepare('SELECT * FROM receipts WHERE receipt_no = ? AND user_id = ?')
    .get(workflow.source_receipt_no, userId);
  if (!source) return null;
  const snapshot = JSON.parse(source.snapshot_json);
  const drafts = getSteps(workflow.id).map((row) => {
    if (row.draft_json) return JSON.parse(row.draft_json);
    if (row.confirmed_json) return JSON.parse(row.confirmed_json);
    return {};
  });
  return {
    workflowId: workflow.id,
    sourceReceiptNo: source.receipt_no,
    sourceStatus: source.status,
    sourceIssuedAt: source.issued_at,
    startedAt: workflow.created_at,
    progress: workflow.progress,
    totalSteps: STEPS.length,
    diff: buildCorrectionDiff(snapshot, drafts),
  };
}

export function getStateForUser(userId) {
  const workflow = getOrCreateWorkflow(userId);
  const envelope = stateEnvelope(workflow);
  envelope.records = listReceiptsForUser(userId);
  envelope.timeline = getTimelineForUser(userId);
  envelope.correction = getCorrectionPreviewForUser(userId);
  return envelope;
}
