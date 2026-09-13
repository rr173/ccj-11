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
import { buildReviewView, reviewFieldDef, reviewTextValue } from './reviews.js';
import {
  attachCorrectionReceiptForBatch,
  reopenBatchDecisionsForWorkflow,
  buildBatchTimelineEntries,
  listBatchesForOwner,
  bindCorrectionFactory,
} from './batchStore.js';
import {
  attachCorrectionReceiptForAppeal,
  reopenAppealDecisionsForWorkflow,
  buildAppealTimelineEntries,
  listAppealRoundsForOwner,
  bindAppealCorrectionFactory,
} from './appealStore.js';
import {
  attachCorrectionReceiptForMediation,
  resolveMediationCorrectionAbandonment,
  buildMediationTimelineEntries,
  listMediationPackagesForOwner,
  bindMediationCorrectionFactory,
} from './mediationStore.js';
import {
  buildCaseGroupTimelineEntries,
  listCaseGroupsForOwner,
  recoverCaseGroupsOnStartup,
  sweepCaseGroupTimeouts,
  getCrossPackageDisclosureForSession,
} from './caseGroupStore.js';
// 归档模块在文件末尾重导出；这里仅用命名空间在请求期惰性访问，规避 db ↔ archiveStore 循环
import * as archiveNs from './archiveStore.js';
// 版本对比 / 受控重放模块同样惰性访问（其依赖 db.js）
import * as comparisonNs from './comparisonStore.js';

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

// 分阶段编排升级：在主建表语句（含 stage_id 索引）之前，先给旧库的既有批次表补列，
// 否则后续 CREATE INDEX ... (stage_id) 会在旧结构上报 “no such column”。
const STAGE_LEGACY_COLUMNS = [
  ['review_batches', 'staged', 'INTEGER NOT NULL DEFAULT 0'],
  ['review_batches', 'config_version', 'INTEGER NOT NULL DEFAULT 1'],
  ['review_batches', 'timeout_result', "TEXT NOT NULL DEFAULT ''"],
  ['review_batch_fields', 'stage_id', 'TEXT'],
  ['review_batch_fields', 'ordinal', 'INTEGER NOT NULL DEFAULT 0'],
  ['review_batch_fields', 'decided_by_policy', "TEXT NOT NULL DEFAULT ''"],
  ['review_batch_invitations', 'stage_id', 'TEXT'],
  ['review_batch_invitations', 'ordinal', 'INTEGER NOT NULL DEFAULT 0'],
  ['review_batch_invitations', 'revoke_reason', "TEXT NOT NULL DEFAULT ''"],
];
for (const [table, column, ddl] of STAGE_LEGACY_COLUMNS) {
  const cols = columnInfo(table);
  if (cols.length > 0 && !cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl};`);
  }
}

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'handler' CHECK (role IN ('handler', 'auditor')),
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

-- 回执复核：办理人发起的限时、一次性、绑定单份回执的复核邀请
CREATE TABLE IF NOT EXISTS review_invitations (
  id TEXT PRIMARY KEY,
  receipt_no TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash BLOB NOT NULL UNIQUE,
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'revoked', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_ip TEXT NOT NULL DEFAULT '',
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_review_invitations_receipt ON review_invitations(receipt_no, created_at);
CREATE INDEX IF NOT EXISTS idx_review_invitations_user ON review_invitations(user_id, created_at);

-- 复核会话：邀请校验成功（一次性消费）后为该复核人生成，免登录；
-- 原始令牌只存在浏览器 Cookie 中，数据库仅存哈希。
CREATE TABLE IF NOT EXISTS review_sessions (
  id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES review_invitations(id) ON DELETE CASCADE,
  receipt_no TEXT NOT NULL,
  token_hash BLOB NOT NULL UNIQUE,
  csrf_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_sessions_invitation ON review_sessions(invitation_id);

-- 字段级异议：状态、提交时间、处理人、处理结果与后续更正来源全部持久化
CREATE TABLE IF NOT EXISTS review_objections (
  id TEXT PRIMARY KEY,
  invitation_id TEXT NOT NULL REFERENCES review_invitations(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES review_sessions(id) ON DELETE CASCADE,
  receipt_no TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  field TEXT NOT NULL,
  field_label TEXT NOT NULL DEFAULT '',
  value_snapshot TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'accepted', 'rejected')),
  idempotency_key TEXT NOT NULL DEFAULT '',
  request_hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  resolved_at INTEGER,
  resolved_by_user_id TEXT,
  resolve_reason TEXT NOT NULL DEFAULT '',
  correction_workflow_id TEXT,
  correction_receipt_no TEXT NOT NULL DEFAULT '',
  lock_session_id TEXT,
  locked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_review_objections_receipt ON review_objections(receipt_no, created_at);
CREATE INDEX IF NOT EXISTS idx_review_objections_user ON review_objections(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_review_objections_workflow ON review_objections(correction_workflow_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_objections_idempotency
  ON review_objections(session_id, idempotency_key) WHERE idempotency_key <> '';

-- 接受的意见与更正办理的多对多关联（多对多：一次更正可回应多条意见）。
-- objection_id 为普通复核异议；batch_opinion_id 为多方复核批次字段意见，二者至少有一个。
-- 新结构在下方“增量迁移”区按库况创建/重建（旧库的 objection_id 为 NOT NULL，需重建）。

-- ---------------------------------------------------------------------------
-- 多方复核批次：办理人为同一份已签发回执编排 2-5 个限时一次性邀请，
-- 逐字段配置接受/驳回阈值；批次只有在全部邀请校验完成后才能进入复核。
--
-- 分阶段编排（stages）：批次可拆成按顺序执行的多个阶段，每阶段独立配置
-- 邀请范围、字段范围、阈值、限时与超时策略（advance/revoke_unused/fail）。
-- 阶段状态机：pending → active → completed | timed_out | failed。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_batches (
  id TEXT PRIMARY KEY,
  receipt_no TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting', 'in_review', 'completed', 'cancelled', 'timed_out')),
  note TEXT NOT NULL DEFAULT '',
  staged INTEGER NOT NULL DEFAULT 0,
  config_version INTEGER NOT NULL DEFAULT 1,
  timeout_result TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  cancelled_at INTEGER,
  cancel_reason TEXT NOT NULL DEFAULT '',
  invitation_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_batches_receipt ON review_batches(receipt_no, created_at);
CREATE INDEX IF NOT EXISTS idx_review_batches_user ON review_batches(user_id, created_at);

-- 同一回执至多存在一个未终结（collecting/in_review）的批次
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_batches_one_open_per_receipt
  ON review_batches(receipt_no) WHERE status IN ('collecting', 'in_review');

-- 分阶段编排：顺序、状态、限时与“阶段开始时冻结”的超时策略
CREATE TABLE IF NOT EXISTS review_batch_stages (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES review_batches(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'completed', 'timed_out', 'failed')),
  duration_ms INTEGER NOT NULL,
  timeout_policy TEXT NOT NULL DEFAULT 'advance'
    CHECK (timeout_policy IN ('advance', 'revoke_unused', 'fail')),
  frozen_policy TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  deadline_at INTEGER,
  completed_at INTEGER,
  final_decision TEXT NOT NULL DEFAULT '',
  timeout_fired_at INTEGER,
  timeout_result TEXT NOT NULL DEFAULT '',
  UNIQUE(batch_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_review_batch_stages_batch ON review_batch_stages(batch_id, ordinal);

-- 编排配置版本：乐观锁（expectedVersion）与逐版本配置留档
CREATE TABLE IF NOT EXISTS review_batch_orchestration_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id TEXT NOT NULL REFERENCES review_batches(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  config_json TEXT NOT NULL DEFAULT '{}',
  change_note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(batch_id, version)
);
CREATE INDEX IF NOT EXISTS idx_review_batch_versions_batch ON review_batch_orchestration_versions(batch_id, version);

-- 配置变更历史（谁、何时、从哪版到哪版）
CREATE TABLE IF NOT EXISTS review_batch_change_history (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES review_batches(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  from_version INTEGER,
  to_version INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_batch_history_batch ON review_batch_change_history(batch_id, created_at);

-- 批次逐字段配置与决议：阈值在所属阶段开始时冻结；决议结果、理由、处理人与时间全部留档
CREATE TABLE IF NOT EXISTS review_batch_fields (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES review_batches(id) ON DELETE CASCADE,
  stage_id TEXT REFERENCES review_batch_stages(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL DEFAULT 0,
  step INTEGER NOT NULL,
  field TEXT NOT NULL,
  field_label TEXT NOT NULL DEFAULT '',
  accept_threshold INTEGER NOT NULL,
  reject_threshold INTEGER NOT NULL,
  decided_by_policy TEXT NOT NULL DEFAULT '',
  decision TEXT CHECK (decision IS NULL OR decision IN ('accepted', 'rejected')),
  decided_at INTEGER,
  decided_by_user_id TEXT,
  decision_reason TEXT NOT NULL DEFAULT '',
  correction_workflow_id TEXT,
  correction_receipt_no TEXT NOT NULL DEFAULT '',
  UNIQUE(batch_id, step, field)
);
CREATE INDEX IF NOT EXISTS idx_review_batch_fields_batch ON review_batch_fields(batch_id);
CREATE INDEX IF NOT EXISTS idx_review_batch_fields_stage ON review_batch_fields(stage_id);

CREATE TABLE IF NOT EXISTS review_batch_invitations (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES review_batches(id) ON DELETE CASCADE,
  stage_id TEXT REFERENCES review_batch_stages(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL DEFAULT 0,
  receipt_no TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  token_hash BLOB NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'revoked', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_ip TEXT NOT NULL DEFAULT '',
  revoked_at INTEGER,
  revoke_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_review_batch_invitations_batch ON review_batch_invitations(batch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_review_batch_invitations_stage ON review_batch_invitations(stage_id);

-- 每个邀请可查看/可提交意见的字段范围（字段必须已纳入批次编排）
CREATE TABLE IF NOT EXISTS review_batch_invitation_fields (
  invitation_id TEXT NOT NULL REFERENCES review_batch_invitations(id) ON DELETE CASCADE,
  batch_field_id TEXT NOT NULL REFERENCES review_batch_fields(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  field TEXT NOT NULL,
  PRIMARY KEY (invitation_id, step, field)
);
CREATE INDEX IF NOT EXISTS idx_review_batch_inv_fields_field ON review_batch_invitation_fields(batch_field_id);

-- 批次邀请校验成功后建立的免登录会话（独立于单份复核邀请的 rid 会话）
CREATE TABLE IF NOT EXISTS review_batch_sessions (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES review_batches(id) ON DELETE CASCADE,
  batch_invitation_id TEXT NOT NULL REFERENCES review_batch_invitations(id) ON DELETE CASCADE,
  receipt_no TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  token_hash BLOB NOT NULL UNIQUE,
  csrf_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_batch_sessions_invitation ON review_batch_sessions(batch_invitation_id);

-- 字段意见：同一邀请对同一字段至多一条（UNIQUE 兜底并发）；逐字保留复核人原始说明
CREATE TABLE IF NOT EXISTS review_batch_opinions (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES review_batches(id) ON DELETE CASCADE,
  batch_field_id TEXT NOT NULL REFERENCES review_batch_fields(id) ON DELETE CASCADE,
  batch_invitation_id TEXT NOT NULL REFERENCES review_batch_invitations(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES review_batch_sessions(id) ON DELETE CASCADE,
  receipt_no TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  field TEXT NOT NULL,
  reviewer_label TEXT NOT NULL DEFAULT '',
  field_label TEXT NOT NULL DEFAULT '',
  value_snapshot TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  correction_receipt_no TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  request_hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(batch_invitation_id, batch_field_id)
);
CREATE INDEX IF NOT EXISTS idx_review_batch_opinions_receipt ON review_batch_opinions(receipt_no, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_batch_opinions_idempotency
  ON review_batch_opinions(session_id, idempotency_key) WHERE idempotency_key <> '';

-- ---------------------------------------------------------------------------
-- 复核申诉回合：办理人针对原批次【已驳回】字段发起的一次独立复核。
-- 只能引用原批次冻结快照；原批次的意见/决议/超时结果不被修改。
-- 状态机：collecting（邀请校验中）→ in_review → completed；终态 cancelled / expired。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS review_appeal_rounds (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL REFERENCES review_batches(id),
  receipt_no TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting', 'in_review', 'completed', 'cancelled', 'expired')),
  reason_summary TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  started_at INTEGER,
  completed_at INTEGER,
  cancelled_at INTEGER,
  cancel_reason TEXT NOT NULL DEFAULT '',
  expired_at INTEGER,
  invitation_count INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_appeal_rounds_batch ON review_appeal_rounds(batch_id, created_at);
CREATE INDEX IF NOT EXISTS idx_review_appeal_rounds_receipt ON review_appeal_rounds(receipt_no, created_at);

-- 同一批次至多一个未终结（collecting/in_review）的申诉回合（两个页面并发只放行一个）
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_appeal_rounds_one_open
  ON review_appeal_rounds(batch_id) WHERE status IN ('collecting', 'in_review');

-- 申诉逐字段配置：独立的接受/驳回阈值、申诉理由、原驳回决议摘要、逐字段决议与更正来源
CREATE TABLE IF NOT EXISTS review_appeal_fields (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES review_appeal_rounds(id) ON DELETE CASCADE,
  source_field_id TEXT NOT NULL REFERENCES review_batch_fields(id),
  batch_id TEXT NOT NULL,
  step INTEGER NOT NULL,
  field TEXT NOT NULL,
  field_label TEXT NOT NULL DEFAULT '',
  reason_code TEXT NOT NULL DEFAULT '',
  accept_threshold INTEGER NOT NULL,
  reject_threshold INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting', 'in_review', 'accepted', 'rejected', 'expired', 'cancelled')),
  decision TEXT CHECK (decision IS NULL OR decision IN ('accepted', 'rejected')),
  decided_at INTEGER,
  decided_by_user_id TEXT,
  decision_reason TEXT NOT NULL DEFAULT '',
  correction_workflow_id TEXT,
  correction_receipt_no TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(round_id, source_field_id)
);
CREATE INDEX IF NOT EXISTS idx_review_appeal_fields_round ON review_appeal_fields(round_id);
CREATE INDEX IF NOT EXISTS idx_review_appeal_fields_source ON review_appeal_fields(source_field_id);

-- 每个被申诉字段（原批次字段）在【未终结】回合中至多出现一次
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_appeal_fields_one_open
  ON review_appeal_fields(source_field_id) WHERE status IN ('collecting', 'in_review');

-- 申诉回合的限时一次性邀请（令牌只存哈希）
CREATE TABLE IF NOT EXISTS review_appeal_invitations (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES review_appeal_rounds(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL DEFAULT 0,
  receipt_no TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  token_hash BLOB NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'revoked', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_ip TEXT NOT NULL DEFAULT '',
  revoked_at INTEGER,
  revoke_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_review_appeal_invitations_round ON review_appeal_invitations(round_id, created_at);

-- 每个申诉邀请可查看/可评价的申诉字段范围
CREATE TABLE IF NOT EXISTS review_appeal_invitation_fields (
  invitation_id TEXT NOT NULL REFERENCES review_appeal_invitations(id) ON DELETE CASCADE,
  appeal_field_id TEXT NOT NULL REFERENCES review_appeal_fields(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  field TEXT NOT NULL,
  PRIMARY KEY (invitation_id, step, field)
);
CREATE INDEX IF NOT EXISTS idx_review_appeal_inv_fields_field ON review_appeal_invitation_fields(appeal_field_id);

-- 申诉邀请校验后的免登录会话（独立 Cookie aid / CSRF accsrf）
CREATE TABLE IF NOT EXISTS review_appeal_sessions (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES review_appeal_rounds(id) ON DELETE CASCADE,
  appeal_invitation_id TEXT NOT NULL REFERENCES review_appeal_invitations(id) ON DELETE CASCADE,
  receipt_no TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  token_hash BLOB NOT NULL UNIQUE,
  csrf_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_appeal_sessions_invitation ON review_appeal_sessions(appeal_invitation_id);

-- 申诉意见：每邀请每申诉字段至多一条（UNIQUE 兜底并发），幂等键重放
CREATE TABLE IF NOT EXISTS review_appeal_opinions (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES review_appeal_rounds(id) ON DELETE CASCADE,
  appeal_field_id TEXT NOT NULL REFERENCES review_appeal_fields(id) ON DELETE CASCADE,
  appeal_invitation_id TEXT NOT NULL REFERENCES review_appeal_invitations(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES review_appeal_sessions(id) ON DELETE CASCADE,
  receipt_no TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  field TEXT NOT NULL,
  reviewer_label TEXT NOT NULL DEFAULT '',
  field_label TEXT NOT NULL DEFAULT '',
  value_snapshot TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  correction_receipt_no TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  request_hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(appeal_invitation_id, appeal_field_id)
);
CREATE INDEX IF NOT EXISTS idx_review_appeal_opinions_receipt ON review_appeal_opinions(receipt_no, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_review_appeal_opinions_idempotency
  ON review_appeal_opinions(session_id, idempotency_key) WHERE idempotency_key <> '';

-- 允许向新复核人披露的原批次证据摘要：原复核人匿名化（source_alias 为本回合内稳定别名），
-- 仅保留原意见的脱敏值快照与说明，不含任何未授权隐私。
CREATE TABLE IF NOT EXISTS review_appeal_evidence (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL REFERENCES review_appeal_rounds(id) ON DELETE CASCADE,
  appeal_field_id TEXT NOT NULL REFERENCES review_appeal_fields(id) ON DELETE CASCADE,
  source_opinion_id TEXT NOT NULL REFERENCES review_batch_opinions(id),
  source_alias TEXT NOT NULL DEFAULT '',
  source_value_snapshot TEXT NOT NULL DEFAULT '',
  source_reason TEXT NOT NULL DEFAULT '',
  source_created_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(appeal_field_id, source_opinion_id)
);
CREATE INDEX IF NOT EXISTS idx_review_appeal_evidence_field ON review_appeal_evidence(appeal_field_id);

-- ---------------------------------------------------------------------------
-- 争议调解包：从已完成（全部字段已决议）的申诉回合中选择字段生成的只读包。
-- 冻结原批次决议、申诉意见、授权证据摘要与当前更正来源；原批次/申诉回合的
-- 历史永远不被本模块修改（无任何对其行的 UPDATE）。
-- 状态机：mediating（第一层进行/等待升级判定）→ arbitrating（第二层开放）
--         → completed；终态 cancelled / expired（第一层 fail）/ failed（第二层 fail）。
-- 同一申诉回合至多一个未终结调解包（部分唯一索引 + 事务双保险）。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS mediation_packages (
  id TEXT PRIMARY KEY,
  round_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  receipt_no TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'mediating'
    CHECK (status IN ('mediating', 'arbitrating', 'completed', 'cancelled', 'expired', 'failed')),
  note TEXT NOT NULL DEFAULT '',
  frozen_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  cancelled_at INTEGER,
  cancel_reason TEXT NOT NULL DEFAULT '',
  completed_at INTEGER,
  expired_at INTEGER,
  escalated_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_mediation_packages_round ON mediation_packages(round_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mediation_packages_receipt ON mediation_packages(receipt_no, created_at);

CREATE UNIQUE INDEX IF NOT EXISTS idx_mediation_packages_one_open
  ON mediation_packages(round_id) WHERE status IN ('mediating', 'arbitrating');

-- 两个按顺序执行的处理层级：第一层调解（2-5 邀请），第二层仲裁（3-5 邀请）。
-- 阈值、字段范围、限时、超时策略在各自层级开始时冻结；第二层开始时按第一层的
-- 冻结快照开放，不能修改第一层结果。
CREATE TABLE IF NOT EXISTS mediation_tiers (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES mediation_packages(id) ON DELETE CASCADE,
  tier INTEGER NOT NULL CHECK (tier IN (1, 2)),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'completed', 'skipped', 'cancelled', 'timed_out', 'failed')),
  escalate_rejected_count INTEGER NOT NULL DEFAULT 0,
  invitation_count INTEGER NOT NULL,
  duration_ms INTEGER NOT NULL,
  timeout_policy TEXT NOT NULL DEFAULT '',
  frozen_policy TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  deadline_at INTEGER,
  completed_at INTEGER,
  final_decision TEXT NOT NULL DEFAULT '',
  timeout_fired_at INTEGER,
  timeout_result TEXT NOT NULL DEFAULT '',
  UNIQUE(package_id, tier)
);
CREATE INDEX IF NOT EXISTS idx_mediation_tiers_package ON mediation_tiers(package_id, tier);

-- 调解逐字段配置与决议：l1_* 为第一层（调解），l2_* 为第二层（仲裁）。
-- 一个字段最多属于一层一次（UNIQUE(package_id, tier, step, field)）。
CREATE TABLE IF NOT EXISTS mediation_fields (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES mediation_packages(id) ON DELETE CASCADE,
  tier_id TEXT NOT NULL REFERENCES mediation_tiers(id) ON DELETE CASCADE,
  round_id TEXT NOT NULL,
  appeal_field_id TEXT NOT NULL,
  source_field_id TEXT NOT NULL,
  tier INTEGER NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  step INTEGER NOT NULL,
  field TEXT NOT NULL,
  field_label TEXT NOT NULL DEFAULT '',
  l1_accept_threshold INTEGER NOT NULL DEFAULT 0,
  l1_reject_threshold INTEGER NOT NULL DEFAULT 0,
  l2_accept_threshold INTEGER NOT NULL DEFAULT 0,
  l2_reject_threshold INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'accepted', 'rejected', 'skipped', 'cancelled', 'timed_out')),
  decision TEXT CHECK (decision IS NULL OR decision IN ('accepted', 'rejected')),
  decided_at INTEGER,
  decided_by_user_id TEXT,
  decision_reason TEXT NOT NULL DEFAULT '',
  decided_by_policy TEXT NOT NULL DEFAULT '',
  correction_workflow_id TEXT,
  correction_receipt_no TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(package_id, tier, step, field)
);
CREATE INDEX IF NOT EXISTS idx_mediation_fields_package ON mediation_fields(package_id, tier);
CREATE INDEX IF NOT EXISTS idx_mediation_fields_appeal ON mediation_fields(appeal_field_id);

-- 冻结的申诉意见（调解包生成瞬间复制；原申诉意见之后的任何变化都不影响调解包）
CREATE TABLE IF NOT EXISTS mediation_frozen_opinions (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES mediation_packages(id) ON DELETE CASCADE,
  mediation_field_id TEXT NOT NULL REFERENCES mediation_fields(id) ON DELETE CASCADE,
  tier INTEGER NOT NULL,
  step INTEGER NOT NULL,
  field TEXT NOT NULL,
  source_appeal_opinion_id TEXT NOT NULL,
  source_alias TEXT NOT NULL DEFAULT '',
  source_value_snapshot TEXT NOT NULL DEFAULT '',
  source_reason TEXT NOT NULL DEFAULT '',
  source_created_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(mediation_field_id, source_appeal_opinion_id)
);
CREATE INDEX IF NOT EXISTS idx_mediation_frozen_opinions_field ON mediation_frozen_opinions(mediation_field_id);

-- 冻结的授权证据摘要（办理人在调解包中显式选择的申诉回合授权证据；
-- 未被选中的证据不进入调解包）。原复核人以“原复核人N”匿名化。
CREATE TABLE IF NOT EXISTS mediation_frozen_evidence (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES mediation_packages(id) ON DELETE CASCADE,
  mediation_field_id TEXT NOT NULL REFERENCES mediation_fields(id) ON DELETE CASCADE,
  tier INTEGER NOT NULL,
  source_evidence_id TEXT NOT NULL,
  source_alias TEXT NOT NULL DEFAULT '',
  source_value_snapshot TEXT NOT NULL DEFAULT '',
  source_reason TEXT NOT NULL DEFAULT '',
  source_created_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  UNIQUE(mediation_field_id, source_evidence_id)
);
CREATE INDEX IF NOT EXISTS idx_mediation_frozen_evidence_field ON mediation_frozen_evidence(mediation_field_id);

-- 两层各自的限时一次性邀请（令牌只存哈希）；第二层邀请在第一层升级前为 pending，
-- 使用“远期占位”有效期，升级瞬间按冻结快照重定为第二层截止时间。
CREATE TABLE IF NOT EXISTS mediation_invitations (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES mediation_packages(id) ON DELETE CASCADE,
  tier_id TEXT NOT NULL REFERENCES mediation_tiers(id) ON DELETE CASCADE,
  tier INTEGER NOT NULL,
  ordinal INTEGER NOT NULL DEFAULT 0,
  receipt_no TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label TEXT NOT NULL DEFAULT '',
  token_hash BLOB NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'used', 'revoked', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_ip TEXT NOT NULL DEFAULT '',
  revoked_at INTEGER,
  revoke_reason TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_mediation_invitations_package ON mediation_invitations(package_id, tier, created_at);

-- 逐邀请字段授权：只能查看/评价本层本邀请被授权的字段
CREATE TABLE IF NOT EXISTS mediation_invitation_fields (
  invitation_id TEXT NOT NULL REFERENCES mediation_invitations(id) ON DELETE CASCADE,
  mediation_field_id TEXT NOT NULL REFERENCES mediation_fields(id) ON DELETE CASCADE,
  tier INTEGER NOT NULL,
  step INTEGER NOT NULL,
  field TEXT NOT NULL,
  PRIMARY KEY (invitation_id, tier, step, field)
);
CREATE INDEX IF NOT EXISTS idx_mediation_inv_fields_field ON mediation_invitation_fields(mediation_field_id);

-- 两层邀请校验后的免登录会话（第一层 Cookie mid/mcsrf，第二层 Cookie arb/accsrf2）
CREATE TABLE IF NOT EXISTS mediation_sessions (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES mediation_packages(id) ON DELETE CASCADE,
  tier_id TEXT NOT NULL REFERENCES mediation_tiers(id) ON DELETE CASCADE,
  invitation_id TEXT NOT NULL REFERENCES mediation_invitations(id) ON DELETE CASCADE,
  tier INTEGER NOT NULL,
  receipt_no TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  token_hash BLOB NOT NULL UNIQUE,
  csrf_secret TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_mediation_sessions_invitation ON mediation_sessions(invitation_id);

-- 逐字段意见：每邀请每字段至多一条（UNIQUE 兜底并发）；幂等键网络重试
CREATE TABLE IF NOT EXISTS mediation_opinions (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES mediation_packages(id) ON DELETE CASCADE,
  mediation_field_id TEXT NOT NULL REFERENCES mediation_fields(id) ON DELETE CASCADE,
  invitation_id TEXT NOT NULL REFERENCES mediation_invitations(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES mediation_sessions(id) ON DELETE CASCADE,
  tier INTEGER NOT NULL,
  receipt_no TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  step INTEGER NOT NULL,
  field TEXT NOT NULL,
  reviewer_label TEXT NOT NULL DEFAULT '',
  field_label TEXT NOT NULL DEFAULT '',
  value_snapshot TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL,
  correction_receipt_no TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  request_hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(invitation_id, mediation_field_id)
);
CREATE INDEX IF NOT EXISTS idx_mediation_opinions_receipt ON mediation_opinions(receipt_no, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mediation_opinions_idempotency
  ON mediation_opinions(session_id, idempotency_key) WHERE idempotency_key <> '';

-- 第一层结束升级到第二层时，按冻结快照生成的“允许向仲裁人披露的第一层结论摘要”。
-- 只含结论/阈值结果等聚合信息，不含第一层调解人的逐字意见与身份。
CREATE TABLE IF NOT EXISTS mediation_disclosures (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES mediation_packages(id) ON DELETE CASCADE,
  l1_mediation_field_id TEXT NOT NULL REFERENCES mediation_fields(id) ON DELETE CASCADE,
  l2_mediation_field_id TEXT NOT NULL REFERENCES mediation_fields(id) ON DELETE CASCADE,
  tier INTEGER NOT NULL,
  step INTEGER NOT NULL,
  field TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(l2_mediation_field_id)
);
CREATE INDEX IF NOT EXISTS idx_mediation_disclosures_package ON mediation_disclosures(package_id);

-- 调解包接受（第一层或第二层）与因此进入的更正办理的来源关系。
-- 无外键约束（更正被放弃时工作流行会删除，关系行一并清理，历史通过审计事件保留）；
-- 部分唯一索引保证同一调解包至多一份进行中的更正，两个办理页面并发只放行一个。
CREATE TABLE IF NOT EXISTS mediation_corrections (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES mediation_packages(id) ON DELETE CASCADE,
  workflow_id TEXT NOT NULL,
  source_batch_id TEXT NOT NULL DEFAULT '',
  source_round_id TEXT NOT NULL DEFAULT '',
  source_tier INTEGER NOT NULL,
  disclosure_id TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  completed_at INTEGER,
  correction_receipt_no TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_mediation_corrections_one_open
  ON mediation_corrections(package_id) WHERE completed_at IS NULL;

-- ---------------------------------------------------------------------------
-- 案件组（case group）：同一原批次下、多个【已完成申诉回合】生成的调解包的
-- 跨包冲突协调与按冻结顺序处理。加入时做冲突检查并生成只读组级冻结快照；
-- 组开始处理后配置冻结，成员包不能重复加入其他未终结案件组。
-- 状态机：collecting（加入/配置阶段）→ processing（按冻结顺序处理）
--         → completed；终态 failed / cancelled。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS case_groups (
  id TEXT PRIMARY KEY,
  batch_id TEXT NOT NULL,
  receipt_no TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'collecting'
    CHECK (status IN ('collecting', 'processing', 'completed', 'failed', 'cancelled')),
  note TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '{}',
  frozen_snapshot_json TEXT NOT NULL DEFAULT '{}',
  min_completions INTEGER NOT NULL DEFAULT 1,
  member_order_json TEXT NOT NULL DEFAULT '[]',
  timeout_policy TEXT NOT NULL DEFAULT 'block_remaining',
  disclosures_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL,
  configured_at INTEGER,
  started_at INTEGER,
  deadline_at INTEGER,
  completed_at INTEGER,
  cancelled_at INTEGER,
  cancel_reason TEXT NOT NULL DEFAULT '',
  timeout_fired_at INTEGER,
  timeout_result TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_case_groups_user ON case_groups(user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_case_groups_batch ON case_groups(batch_id, created_at);

-- 组成员：加入瞬间冻结来源/字段授权/两层配置/包状态（member_snapshot_json）。
-- open_group_id 为该包当前归属的未终结案件组：组终结（completed/failed/cancelled）
-- 时清空，部分唯一索引保证成员包不能同时处于两个未终结案件组。
CREATE TABLE IF NOT EXISTS case_group_members (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES case_groups(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL,
  round_id TEXT NOT NULL,
  batch_id TEXT NOT NULL,
  receipt_no TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'joined'
    CHECK (status IN ('joined', 'layer1_open', 'parked', 'arbitrating',
                      'arbitration_blocked', 'completed', 'failed', 'cancelled', 'released')),
  open_group_id TEXT,
  gate_reason TEXT NOT NULL DEFAULT '',
  member_snapshot_json TEXT NOT NULL DEFAULT '{}',
  result_json TEXT NOT NULL DEFAULT '{}',
  joined_at INTEGER NOT NULL,
  gate_decided_at INTEGER,
  finished_at INTEGER,
  UNIQUE(group_id, package_id)
);
CREATE INDEX IF NOT EXISTS idx_case_group_members_group ON case_group_members(group_id, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS idx_case_group_members_one_open
  ON case_group_members(package_id) WHERE open_group_id IS NOT NULL;

-- 加入时未通过冲突检查的调解包留档（不能进入案件组，原因持久化）
CREATE TABLE IF NOT EXISTS case_group_rejections (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES case_groups(id) ON DELETE CASCADE,
  package_id TEXT NOT NULL,
  round_id TEXT NOT NULL DEFAULT '',
  batch_id TEXT NOT NULL DEFAULT '',
  reason_code TEXT NOT NULL,
  reason_detail TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_case_group_rejections_group ON case_group_rejections(group_id, created_at);

-- 组级允许披露的跨包摘要：成员包开放第二层仲裁瞬间按冻结规则生成，
-- 只含其他成员包的聚合结论（计数/状态/自动驳回标记），不含任何其他包字段原文。
CREATE TABLE IF NOT EXISTS case_group_disclosures (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES case_groups(id) ON DELETE CASCADE,
  viewer_package_id TEXT NOT NULL,
  summary_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL,
  UNIQUE(group_id, viewer_package_id)
);

-- ---------------------------------------------------------------------------
-- 可验证审计归档：办理人按【原批次 / 申诉回合 / 调解包 / 案件组】选择一段
-- 已经发生的审计事件，创建只读归档。创建瞬间冻结事件顺序、来源关系、状态摘要
-- 与脱敏规则，并为事件计算可连续校验的 SHA-256 摘要链；此后业务记录如何变化
-- 都不影响归档内容。事件缺口 / 顺序冲突 / 来源不一致时拒绝生成并在
-- audit_archive_rejections 留档原因。归档一经创建只有版本递增（重新归档），
-- 没有任何更新冻结内容的接口。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_archives (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL CHECK (source_type IN ('batch', 'appeal', 'mediation', 'caseGroup')),
  source_id TEXT NOT NULL,
  source_label TEXT NOT NULL DEFAULT '',
  receipt_no TEXT NOT NULL,
  workflow_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'frozen' CHECK (status IN ('frozen')),
  scope_json TEXT NOT NULL DEFAULT '{}',
  status_summary_json TEXT NOT NULL DEFAULT '{}',
  provenance_json TEXT NOT NULL DEFAULT '[]',
  redaction_json TEXT NOT NULL DEFAULT '{}',
  permission_snapshot_json TEXT NOT NULL DEFAULT '{}',
  event_count INTEGER NOT NULL,
  first_event_at INTEGER,
  last_event_at INTEGER,
  genesis_hash TEXT NOT NULL,
  final_hash TEXT NOT NULL,
  chain_ok INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(source_type, source_id, version)
);
CREATE INDEX IF NOT EXISTS idx_audit_archives_owner ON audit_archives(owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_archives_source ON audit_archives(source_type, source_id, version);

-- 冻结的审计事件（顺序与摘要链在创建瞬间确定；归档后永不 UPDATE/DELETE）
CREATE TABLE IF NOT EXISTS audit_archive_events (
  id TEXT PRIMARY KEY,
  archive_id TEXT NOT NULL REFERENCES audit_archives(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  source_event_id INTEGER NOT NULL,
  workflow_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  step INTEGER,
  detail_json TEXT NOT NULL DEFAULT '{}',
  actor_role TEXT NOT NULL DEFAULT '',
  actor_label TEXT NOT NULL DEFAULT '',
  occurred_at INTEGER NOT NULL,
  prev_hash TEXT NOT NULL,
  event_hash TEXT NOT NULL,
  UNIQUE(archive_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_audit_archive_events_archive ON audit_archive_events(archive_id, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_archive_events_source
  ON audit_archive_events(archive_id, source_event_id);

-- 归档创建被拒绝（事件缺口 / 顺序冲突 / 来源不一致）时的留档
CREATE TABLE IF NOT EXISTS audit_archive_rejections (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL,
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason_detail TEXT NOT NULL DEFAULT '',
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_archive_rejections_owner ON audit_archive_rejections(owner_user_id, created_at);

-- 导出后台任务：幂等键、分块断点续传、同归档同版本至多一份进行中。
-- 文件内容在任务完成时由冻结事件重算（不触碰任何业务表）；重启后
-- pending/running 任务从已完成分块之后继续。
CREATE TABLE IF NOT EXISTS audit_exports (
  id TEXT PRIMARY KEY,
  archive_id TEXT NOT NULL REFERENCES audit_archives(id) ON DELETE CASCADE,
  archive_version INTEGER NOT NULL,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'expired')),
  total_chunks INTEGER NOT NULL,
  completed_chunks INTEGER NOT NULL DEFAULT 0,
  progress INTEGER NOT NULL DEFAULT 0,
  fail_reason TEXT NOT NULL DEFAULT '',
  file_content TEXT,
  file_version INTEGER NOT NULL DEFAULT 1,
  file_digest TEXT NOT NULL DEFAULT '',
  file_size INTEGER NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  locked_at INTEGER,
  locked_by TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  updated_at INTEGER NOT NULL,
  completed_at INTEGER,
  expires_at INTEGER,
  UNIQUE(owner_user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_audit_exports_archive ON audit_exports(archive_id, status);
-- 同一归档同一版本只能有一份进行中（queued/running）的导出：两个页面并发启动只放行一个
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_exports_one_active
  ON audit_exports(archive_id) WHERE status IN ('queued', 'running');
CREATE INDEX IF NOT EXISTS idx_audit_exports_owner ON audit_exports(owner_user_id, created_at);

-- 导出分块进度（断点续传）：已完成的分块行在重启/重试后不重新生成
CREATE TABLE IF NOT EXISTS audit_export_chunks (
  id TEXT PRIMARY KEY,
  export_id TEXT NOT NULL REFERENCES audit_exports(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  chunk_digest TEXT NOT NULL DEFAULT '',
  size INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  UNIQUE(export_id, ordinal)
);

-- 一次性下载凭证：完成时签发；重复使用 / 越权归档 / 取消 / 过期均明确拒绝
CREATE TABLE IF NOT EXISTS audit_export_credentials (
  id TEXT PRIMARY KEY,
  export_id TEXT NOT NULL REFERENCES audit_exports(id) ON DELETE CASCADE,
  archive_id TEXT NOT NULL,
  owner_user_id TEXT NOT NULL,
  code_hash BLOB NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'used', 'revoked', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_ip TEXT NOT NULL DEFAULT '',
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_export_credentials_export ON audit_export_credentials(export_id);

-- 外部核验码：免登录、一次性，只能看到事件数量/时间范围/摘要链是否连续/最终状态
CREATE TABLE IF NOT EXISTS audit_external_codes (
  id TEXT PRIMARY KEY,
  archive_id TEXT NOT NULL REFERENCES audit_archives(id) ON DELETE CASCADE,
  owner_user_id TEXT NOT NULL,
  code_hash BLOB NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'used', 'revoked', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_ip TEXT NOT NULL DEFAULT '',
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_external_codes_archive ON audit_external_codes(archive_id, status);

-- ---------------------------------------------------------------------------
-- 归档版本比较报告：办理人为同一来源选择两个【已冻结】归档版本生成的只读文档。
-- 报告生成时复制对齐结果（新增/删除/修改/未变化/无法对齐）、摘要链连续性、
-- 来源关系差异、状态摘要差异与权限快照差异；body_json 规范化后计算 digest
-- 冻结。报告与条目创建后没有任何改写路径，归档之后新增业务事件不影响报告。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_comparisons (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  comparison_no TEXT NOT NULL,
  receipt_no TEXT NOT NULL DEFAULT '',
  base_archive_id TEXT NOT NULL REFERENCES audit_archives(id),
  target_archive_id TEXT NOT NULL REFERENCES audit_archives(id),
  source_type TEXT NOT NULL,
  source_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'frozen' CHECK (status IN ('frozen')),
  note TEXT NOT NULL DEFAULT '',
  body_json TEXT NOT NULL DEFAULT '{}',
  digest TEXT NOT NULL,
  count_added INTEGER NOT NULL DEFAULT 0,
  count_deleted INTEGER NOT NULL DEFAULT 0,
  count_modified INTEGER NOT NULL DEFAULT 0,
  count_unchanged INTEGER NOT NULL DEFAULT 0,
  count_unaligned INTEGER NOT NULL DEFAULT 0,
  base_chain_ok INTEGER NOT NULL DEFAULT 1,
  target_chain_ok INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  expires_at INTEGER,
  UNIQUE(base_archive_id, target_archive_id)
);
CREATE INDEX IF NOT EXISTS idx_audit_comparisons_owner ON audit_comparisons(owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_comparisons_source ON audit_comparisons(source_type, source_id);

-- 比较报告条目（按合并后的事件顺序）；entry_key 为 e{source_event_id}
CREATE TABLE IF NOT EXISTS audit_comparison_entries (
  id TEXT PRIMARY KEY,
  comparison_id TEXT NOT NULL REFERENCES audit_comparisons(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  entry_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('added', 'deleted', 'modified', 'unchanged', 'unaligned')),
  reason TEXT NOT NULL DEFAULT '',
  base_ordinal INTEGER,
  base_source_event_id INTEGER,
  base_event_hash TEXT NOT NULL DEFAULT '',
  base_event_type TEXT NOT NULL DEFAULT '',
  base_occurred_at INTEGER,
  target_ordinal INTEGER,
  target_source_event_id INTEGER,
  target_event_hash TEXT NOT NULL DEFAULT '',
  target_event_type TEXT NOT NULL DEFAULT '',
  target_occurred_at INTEGER,
  UNIQUE(comparison_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_audit_comparison_entries_report ON audit_comparison_entries(comparison_id, ordinal);
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_comparison_entries_key
  ON audit_comparison_entries(comparison_id, entry_key);

-- ---------------------------------------------------------------------------
-- 受控重放审阅：从比较报告获准条目（可对齐事件）创建的只读重放会话。
-- 会话只能读取创建时从报告复制的冻结事件副本（audit_replay_events），
-- 写操作只追加意见/审计行、推进会话版本与状态；绝不修改归档、业务记录、导出文件。
-- 状态机：active ⇄ paused → completed（全部结论落定，不强制）/ cancelled / expired。
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_replay_sessions (
  id TEXT PRIMARY KEY,
  owner_user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  replay_no TEXT NOT NULL,
  comparison_id TEXT NOT NULL REFERENCES audit_comparisons(id),
  receipt_no TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'paused', 'completed', 'cancelled', 'expired')),
  version INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT '',
  selected_count INTEGER NOT NULL,
  confirmed_count INTEGER NOT NULL DEFAULT 0,
  objected_count INTEGER NOT NULL DEFAULT 0,
  comment_count INTEGER NOT NULL DEFAULT 0,
  submit_token_hash BLOB,
  submit_token_expires_at INTEGER,
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  paused_at INTEGER,
  resumed_at INTEGER,
  cancelled_at INTEGER,
  cancel_reason TEXT NOT NULL DEFAULT '',
  completed_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_replay_owner ON audit_replay_sessions(owner_user_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_replay_comparison ON audit_replay_sessions(comparison_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_replay_status ON audit_replay_sessions(status, expires_at);

-- 重放冻结事件副本：会话创建时从比较报告引用的归档冻结事件复制，之后永不更新
CREATE TABLE IF NOT EXISTS audit_replay_events (
  id TEXT PRIMARY KEY,
  replay_id TEXT NOT NULL REFERENCES audit_replay_sessions(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  entry_key TEXT NOT NULL,
  source_side TEXT NOT NULL CHECK (source_side IN ('base', 'target')),
  source_event_id INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  actor_role TEXT NOT NULL DEFAULT '',
  actor_label TEXT NOT NULL DEFAULT '',
  occurred_at INTEGER NOT NULL,
  event_content_hash TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  UNIQUE(replay_id, ordinal),
  UNIQUE(replay_id, entry_key)
);
CREATE INDEX IF NOT EXISTS idx_audit_replay_events_replay ON audit_replay_events(replay_id, ordinal);

-- 重放意见：comment（意见，可多次追加）/ confirm（已确认）/ object（异议）。
-- 同一事件至多一条 confirm/object 结论（部分唯一索引兜底并发，两个页面只能一个成功）；
-- 幂等键支持同内容网络重试，返回同一条意见。
CREATE TABLE IF NOT EXISTS audit_replay_opinions (
  id TEXT PRIMARY KEY,
  replay_id TEXT NOT NULL REFERENCES audit_replay_sessions(id) ON DELETE CASCADE,
  replay_event_id TEXT NOT NULL REFERENCES audit_replay_events(id) ON DELETE CASCADE,
  entry_key TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('comment', 'confirm', 'object')),
  comment TEXT NOT NULL DEFAULT '',
  reason TEXT NOT NULL DEFAULT '',
  idempotency_key TEXT NOT NULL DEFAULT '',
  request_hash TEXT NOT NULL DEFAULT '',
  replay_version INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_replay_opinions_replay ON audit_replay_opinions(replay_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_replay_opinions_idempotency
  ON audit_replay_opinions(replay_id, idempotency_key) WHERE idempotency_key <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_audit_replay_opinions_decision
  ON audit_replay_opinions(replay_id, entry_key) WHERE kind IN ('confirm', 'object');

-- 重放一次性提交令牌：每次写操作（意见/暂停/恢复/取消）必须携带并消费一枚
CREATE TABLE IF NOT EXISTS audit_replay_submit_tokens (
  id TEXT PRIMARY KEY,
  replay_id TEXT NOT NULL REFERENCES audit_replay_sessions(id) ON DELETE CASCADE,
  token_hash BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'used', 'revoked', 'expired')),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  used_opinion_id TEXT NOT NULL DEFAULT '',
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_audit_replay_tokens_replay ON audit_replay_submit_tokens(replay_id, status);

-- 重放审计时间线（只追加）：会话所有受控动作留档；服务重启后从表恢复
CREATE TABLE IF NOT EXISTS audit_replay_audit (
  id TEXT PRIMARY KEY,
  replay_id TEXT NOT NULL REFERENCES audit_replay_sessions(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_replay_audit_replay ON audit_replay_audit(replay_id, created_at);
`);

// 每人至多一条进行中的办理（更正接口并发调用不会产生两条）
db.exec(`
  CREATE UNIQUE INDEX IF NOT EXISTS idx_workflows_one_open
  ON workflows(user_id) WHERE status = 'open';
`);

// 增量迁移：分阶段编排新增列已在主建表前补齐（见 STAGE_LEGACY_COLUMNS）；
// 这里仅补早期批次意见表的后加列。
// 审计归档：旧库 users 表补角色列（全新库建表语句已含 role）
if (columnInfo('users').length > 0 && !columnInfo('users').some((c) => c.name === 'role')) {
  db.exec("ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'handler';");
}
for (const [table, column, ddl] of [
  ['review_batch_opinions', 'correction_receipt_no', "TEXT NOT NULL DEFAULT ''"],
]) {
  if (columnInfo(table).length > 0 && !columnInfo(table).some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl};`);
  }
}

// 旧库的 review_batches 状态 CHECK 不含 timed_out：用“改名重建”方式拓宽约束，
// 子表通过显式表名外键引用，重建期间关闭 foreign_keys（SQLite 不允许事务内切换）。
{
  const batchesColumns = columnInfo('review_batches');
  if (batchesColumns.length > 0) {
    const checkSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'review_batches'").get()?.sql || '';
    if (!checkSql.includes('timed_out')) {
      db.pragma('foreign_keys = OFF');
      db.pragma('legacy_alter_table = ON');
      db.exec('ALTER TABLE review_batches RENAME TO review_batches_old;');
      db.pragma('legacy_alter_table = OFF');
      db.exec(`
        CREATE TABLE review_batches (
          id TEXT PRIMARY KEY,
          receipt_no TEXT NOT NULL,
          workflow_id TEXT NOT NULL,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL DEFAULT 'collecting'
            CHECK (status IN ('collecting', 'in_review', 'completed', 'cancelled', 'timed_out')),
          note TEXT NOT NULL DEFAULT '',
          staged INTEGER NOT NULL DEFAULT 0,
          config_version INTEGER NOT NULL DEFAULT 1,
          timeout_result TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          started_at INTEGER,
          completed_at INTEGER,
          cancelled_at INTEGER,
          cancel_reason TEXT NOT NULL DEFAULT '',
          invitation_count INTEGER NOT NULL
        );
        INSERT INTO review_batches
          (id, receipt_no, workflow_id, user_id, status, note, staged, config_version, timeout_result,
           created_at, expires_at, started_at, completed_at, cancelled_at, cancel_reason, invitation_count)
        SELECT id, receipt_no, workflow_id, user_id, status, note, 0, 1, '',
               created_at, expires_at, started_at, completed_at, cancelled_at, cancel_reason, invitation_count
        FROM review_batches_old;
        DROP TABLE review_batches_old;
      `);
      db.pragma('foreign_keys = ON');
    }
  }
}

// 旧库的既有批次没有阶段记录：为每个批次回填“唯一的统一阶段”，把字段与邀请挂到该阶段，
// 状态/截止时间沿用批次原值，保证升级后旧批次仍可正常展示、提交与决议。
if (columnInfo('review_batch_stages').length > 0) {
  const legacyBatches = db.prepare(`
    SELECT b.* FROM review_batches b
    WHERE NOT EXISTS (SELECT 1 FROM review_batch_stages s WHERE s.batch_id = b.id)
  `).all();
  for (const batch of legacyBatches) {
    const stageId = cryptoId();
    const stageStatus = batch.status === 'completed' ? 'completed'
      : batch.status === 'cancelled' || batch.status === 'timed_out' ? 'failed'
        : batch.status === 'in_review' ? 'active'
          : 'pending';
    db.prepare(`
      INSERT INTO review_batch_stages
        (id, batch_id, ordinal, name, status, duration_ms, timeout_policy, frozen_policy,
         created_at, started_at, deadline_at, completed_at, final_decision, timeout_fired_at, timeout_result)
      VALUES (?, ?, 0, '统一复核', ?, ?, 'advance', '', ?, ?, ?, ?, '', NULL, '')
    `).run(
      stageId, batch.id, stageStatus,
      Math.max(0, batch.expires_at - batch.created_at),
      batch.created_at, batch.started_at,
      batch.status === 'collecting' ? null : batch.expires_at,
      batch.completed_at,
    );
    db.prepare('UPDATE review_batch_fields SET stage_id = ?, ordinal = 0 WHERE batch_id = ? AND stage_id IS NULL')
      .run(stageId, batch.id);
    db.prepare('UPDATE review_batch_invitations SET stage_id = ?, ordinal = 0 WHERE batch_id = ? AND stage_id IS NULL')
      .run(stageId, batch.id);
  }
}

// correction_objections：普通复核异议与多方批次意见共用的更正来源关联。
// 全新库直接建（objection_id/batch_opinion_id 均可空）；旧库为 NOT NULL 三列结构，
// 需要数据搬迁后重建以容纳批次意见（无外键约束，删除重建安全）。
{
  const columns = columnInfo('correction_objections');
  if (columns.length === 0) {
    db.exec(`
      CREATE TABLE correction_objections (
        workflow_id TEXT NOT NULL,
        objection_id TEXT,
        batch_opinion_id TEXT,
        appeal_opinion_id TEXT,
        mediation_opinion_id TEXT,
        source_batch_id TEXT NOT NULL DEFAULT '',
        source_round_id TEXT NOT NULL DEFAULT '',
        source_package_id TEXT NOT NULL DEFAULT '',
        source_tier INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX idx_correction_objections_obj
        ON correction_objections(workflow_id, objection_id) WHERE objection_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_correction_objections_batch
        ON correction_objections(workflow_id, batch_opinion_id) WHERE batch_opinion_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_correction_objections_appeal
        ON correction_objections(workflow_id, appeal_opinion_id) WHERE appeal_opinion_id IS NOT NULL;
      CREATE UNIQUE INDEX idx_correction_objections_mediation
        ON correction_objections(workflow_id, mediation_opinion_id) WHERE mediation_opinion_id IS NOT NULL;
    `);
  } else if (!columns.some((c) => c.name === 'batch_opinion_id')) {
    db.exec(`
      ALTER TABLE correction_objections ADD COLUMN batch_opinion_id TEXT;
    `);
  }
  if (columns.length > 0 && !columns.some((c) => c.name === 'appeal_opinion_id')) {
    db.exec('ALTER TABLE correction_objections ADD COLUMN appeal_opinion_id TEXT;');
  }
  if (columns.length > 0 && !columns.some((c) => c.name === 'source_batch_id')) {
    db.exec("ALTER TABLE correction_objections ADD COLUMN source_batch_id TEXT NOT NULL DEFAULT '';");
  }
  if (columns.length > 0 && !columns.some((c) => c.name === 'source_round_id')) {
    db.exec("ALTER TABLE correction_objections ADD COLUMN source_round_id TEXT NOT NULL DEFAULT '';");
  }
  if (columns.length > 0 && !columns.some((c) => c.name === 'mediation_opinion_id')) {
    db.exec('ALTER TABLE correction_objections ADD COLUMN mediation_opinion_id TEXT;');
  }
  if (columns.length > 0 && !columns.some((c) => c.name === 'source_package_id')) {
    db.exec("ALTER TABLE correction_objections ADD COLUMN source_package_id TEXT NOT NULL DEFAULT '';");
  }
  if (columns.length > 0 && !columns.some((c) => c.name === 'source_tier')) {
    db.exec('ALTER TABLE correction_objections ADD COLUMN source_tier INTEGER NOT NULL DEFAULT 0;');
  }
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_correction_objections_obj
      ON correction_objections(workflow_id, objection_id) WHERE objection_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_correction_objections_batch
      ON correction_objections(workflow_id, batch_opinion_id) WHERE batch_opinion_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_correction_objections_appeal
      ON correction_objections(workflow_id, appeal_opinion_id) WHERE appeal_opinion_id IS NOT NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_correction_objections_mediation
      ON correction_objections(workflow_id, mediation_opinion_id) WHERE mediation_opinion_id IS NOT NULL;
  `);
}

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

function seedUser(username, displayName, role = 'handler') {
  const existing = db.prepare('SELECT id FROM users WHERE username = ?').get(username);
  if (existing) return existing.id;
  const { salt, hash } = hashPassword(config.demoPassword);
  const id = cryptoId();
  db.prepare(`
    INSERT INTO users (id, username, display_name, role, password_salt, password_hash, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, username, displayName, role, salt, hash, now());
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
// 审计员账号：只能按归档创建时冻结的角色授权查看脱敏字段、来源关系与摘要链校验结果
seedUser('auditor1', '审计员一号（角色：auditor）', 'auditor');
seedUser('auditor2', '审计员二号（角色：auditor，未授权对照）', 'auditor');

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
    return db.prepare('SELECT id, username, display_name, role, created_at FROM users WHERE id = ?').get(id);
  },
  listByRole(role) {
    return db.prepare('SELECT id, username, display_name, role, created_at FROM users WHERE role = ? ORDER BY username ASC').all(role);
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
  try {
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

      return { ok: true, workflow: insertCorrectionWorkflowTx(source) };
    });
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
}

// 事务内调用：为指定回执创建 sequence+1 的更正办理，草稿用原回执预填。
// 调用方负责完成归属校验、进行中办理冲突等前置检查。
export function insertCorrectionWorkflowTx(source) {
  const ts = now();
  const maxSeq = db.prepare('SELECT COALESCE(MAX(sequence), 0) AS max_seq FROM workflows WHERE user_id = ?')
    .get(source.user_id).max_seq;
  const id = cryptoId();
  db.prepare(`
    INSERT INTO workflows (id, user_id, sequence, status, source_receipt_no, progress, version, completed_at, created_at, updated_at)
    VALUES (?, ?, ?, 'open', ?, 0, 0, NULL, ?, ?)
  `).run(id, source.user_id, maxSeq + 1, source.receipt_no, ts, ts);
  const sourceSnapshot = JSON.parse(source.snapshot_json);
  STEPS.forEach((_, step) => {
    const data = sourceSnapshot.steps?.[step]?.data;
    db.prepare(`
      INSERT INTO workflow_steps (workflow_id, step, draft_json, confirmed_json, confirmed_at, updated_at)
      VALUES (?, ?, ?, NULL, NULL, ?)
    `).run(id, step, data ? JSON.stringify(data) : null, ts);
  });
  addEvent(id, 'workflow.created', null, { sequence: maxSeq + 1, correctionOf: source.receipt_no });
  return db.prepare('SELECT * FROM workflows WHERE id = ?').get(id);
}
// 注入给多方复核批次模块在其事务内复用（打破 ESM 循环依赖的初始化时序）
bindCorrectionFactory(insertCorrectionWorkflowTx);
bindAppealCorrectionFactory(insertCorrectionWorkflowTx);
bindMediationCorrectionFactory(insertCorrectionWorkflowTx);

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
    // 随该更正进入办理的已接受异议：更正被放弃，异议回到待处理，可再次处理
    const linked = db.prepare(`
      SELECT id FROM review_objections
      WHERE correction_workflow_id = ? AND status = 'accepted'
    `).all(workflow.id);
    if (linked.length > 0) {
      db.prepare(`
        UPDATE review_objections
        SET status = 'open',
            correction_workflow_id = NULL,
            correction_receipt_no = '',
            resolved_at = NULL,
            resolved_by_user_id = NULL,
            resolve_reason = '',
            lock_session_id = NULL,
            locked_at = NULL
        WHERE correction_workflow_id = ? AND status = 'accepted'
      `).run(workflow.id);
      db.prepare('DELETE FROM correction_objections WHERE workflow_id = ?').run(workflow.id);
      for (const item of linked) {
        addReviewEvent(workflow.user_id, sourceReceiptNo, 'review.objection.reopened', { objectionId: item.id });
      }
    }
    // 多方复核批次：因接受字段而进入的更正被放弃，相关字段决议回收为待决议
    const reopenedBatchFieldIds = reopenBatchDecisionsForWorkflow(workflow.id);
    db.prepare('DELETE FROM correction_objections WHERE workflow_id = ?').run(workflow.id);
    if (reopenedBatchFieldIds.length > 0) {
      addReviewEvent(workflow.user_id, sourceReceiptNo, 'review.batch.fields.reopened', { batchFieldIds: reopenedBatchFieldIds });
    }
    // 复核申诉回合：因接受申诉而进入的更正被放弃，申诉字段决议回收（原批次驳回决议不变）
    const reopenedAppealFieldIds = reopenAppealDecisionsForWorkflow(workflow.id);
    if (reopenedAppealFieldIds.length > 0) {
      addReviewEvent(workflow.user_id, sourceReceiptNo, 'review.appeal.fields.reopened', { appealFieldIds: reopenedAppealFieldIds });
    }
    // 争议调解包：调解接受进入的更正被放弃时，按调解包不可改写规则只清理来源关系，
    // 第一层终局保留（第二层是否已开放决定是否还能回收第一层决议）；仲裁接受不回收。
    resolveMediationCorrectionAbandonment(workflow.id);
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
      // 若本次更正由已接受的复核异议进入，把新回执编号回填到异议与时间线来源关系上
      const linkedObjections = db.prepare(`
        SELECT id FROM review_objections WHERE correction_workflow_id = ?
      `).all(workflowId);
      if (linkedObjections.length > 0 && workflow.source_receipt_no) {
        db.prepare(`
          UPDATE review_objections SET correction_receipt_no = ? WHERE correction_workflow_id = ?
        `).run(receipt.receiptNo, workflowId);
        addReviewEvent(userId, workflow.source_receipt_no, 'review.correction.completed', {
          receiptNo: receipt.receiptNo,
          objectionIds: linkedObjections.map((item) => item.id),
        });
      }
      // 多方复核批次：接受字段进入的更正完成后，回填新回执编号与来源关系
      attachCorrectionReceiptForBatch({ workflowId, receiptNo: receipt.receiptNo });
      // 复核申诉回合：接受申诉进入的更正完成后，回填新回执编号与来源关系
      attachCorrectionReceiptForAppeal({ workflowId, receiptNo: receipt.receiptNo });
      // 争议调解包：仲裁/调解接受进入的更正完成后，回填新回执编号并关闭调解包
      attachCorrectionReceiptForMediation({ workflowId, receiptNo: receipt.receiptNo });
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
// 回执复核协作：限时一次性邀请、免登录复核会话、字段级异议与处理结果
// ---------------------------------------------------------------------------

const OBJECTION_REASON_MIN = 2;
const OBJECTION_REASON_MAX = 500;
export const OBJECTION_LOCK_TTL_MS = 60 * 1000;

function reviewEventWorkflowId(receiptNo) {
  const row = db.prepare('SELECT workflow_id FROM receipts WHERE receipt_no = ?').get(receiptNo);
  return row?.workflow_id || null;
}

// 复核事件写入回执对应办理记录的审计时间线；回执刚被撤销等极端情况下也不阻塞主流程
function addReviewEvent(userId, receiptNo, type, detail) {
  const workflowId = reviewEventWorkflowId(receiptNo);
  if (!workflowId) return;
  db.prepare(`
    INSERT INTO events (workflow_id, type, step, detail_json, created_at)
    VALUES (?, ?, NULL, ?, ?)
  `).run(workflowId, type, JSON.stringify({ receiptNo, ...detail }), now());
}

function effectiveInvitationStatus(row) {
  if (row.status === 'active' && row.expires_at <= now()) {
    db.prepare("UPDATE review_invitations SET status = 'expired' WHERE id = ? AND status = 'active'").run(row.id);
    return 'expired';
  }
  return row.status;
}

export function createReviewInvitation({ userId, receiptNo, ttlMs, note }) {
  return immediateTransaction(() => {
    const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ? AND user_id = ?').get(receiptNo, userId);
    if (!receipt) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND', message: '回执不存在或不属于当前账号' };
    if (receipt.status === 'revoked') {
      return { ok: false, status: 409, code: 'RECEIPT_REVOKED', message: '已撤销的回执不能发起复核邀请' };
    }
    const raw = tokenUrlSafe();
    const ts = now();
    const id = cryptoId();
    db.prepare(`
      INSERT INTO review_invitations
        (id, receipt_no, workflow_id, user_id, token_hash, note, status, created_at, expires_at, used_at, used_ip, revoked_at)
      VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL, '', NULL)
    `).run(id, receipt.receipt_no, receipt.workflow_id, userId, sha256(raw), String(note || '').slice(0, 200), ts, ts + ttlMs);
    addReviewEvent(userId, receipt.receipt_no, 'review.invitation.created', { invitationId: id, expiresAt: ts + ttlMs });
    return { ok: true, invitation: getInvitationForOwnerTx(id), token: raw };
  });
}

export function revokeReviewInvitation({ userId, invitationId }) {
  return immediateTransaction(() => {
    const row = db.prepare('SELECT * FROM review_invitations WHERE id = ? AND user_id = ?').get(invitationId, userId);
    if (!row) return { ok: false, status: 404, code: 'INVITATION_NOT_FOUND', message: '复核邀请不存在' };
    const status = effectiveInvitationStatus(row);
    if (status === 'revoked') {
      return { ok: false, status: 409, code: 'INVITATION_ALREADY_REVOKED', message: '邀请已处于撤销状态', invitation: getInvitationForOwnerTx(row.id) };
    }
    if (row.used_at) {
      return { ok: false, status: 409, code: 'INVITATION_ALREADY_USED', message: '邀请链接已被使用，不能撤销；复核人已持有的复核会话将同步失效', invitation: getInvitationForOwnerTx(row.id) };
    }
    const ts = now();
    db.prepare("UPDATE review_invitations SET status = 'revoked', revoked_at = ? WHERE id = ?").run(ts, row.id);
    // 邀请撤销：该邀请尚未产生会话；若有残留会话（理论上不会）一并失效
    db.prepare('DELETE FROM review_sessions WHERE invitation_id = ?').run(row.id);
    addReviewEvent(userId, row.receipt_no, 'review.invitation.revoked', { invitationId: row.id });
    return { ok: true, invitation: getInvitationForOwnerTx(row.id) };
  });
}

// 邀请校验：一次性消费，成功后创建免登录复核会话（只绑定这一份回执）
export function consumeReviewInvitation({ rawToken, clientIp }) {
  return immediateTransaction(() => {
    const invite = db.prepare('SELECT * FROM review_invitations WHERE token_hash = ?').get(sha256(rawToken));
    if (!invite) {
      return { ok: false, status: 404, code: 'INVITATION_NOT_FOUND' };
    }
    if (invite.status === 'revoked' || invite.revoked_at) {
      return { ok: false, status: 410, code: 'INVITATION_REVOKED' };
    }
    if (invite.used_at || invite.status === 'used') {
      return { ok: false, status: 410, code: 'INVITATION_ALREADY_USED' };
    }
    if (invite.expires_at <= now()) {
      db.prepare("UPDATE review_invitations SET status = 'expired' WHERE id = ?").run(invite.id);
      return { ok: false, status: 410, code: 'INVITATION_EXPIRED' };
    }
    const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(invite.receipt_no);
    if (!receipt) {
      return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND' };
    }
    if (receipt.status === 'revoked') {
      return { ok: false, status: 410, code: 'RECEIPT_REVOKED' };
    }

    const ts = now();
    db.prepare(`
      UPDATE review_invitations
      SET status = 'used', used_at = ?, used_ip = ?
      WHERE id = ? AND used_at IS NULL
    `).run(ts, String(clientIp || '').slice(0, 64), invite.id);

    const sessionRaw = tokenUrlSafe();
    const sessionId = cryptoId();
    const csrf = tokenUrlSafe();
    db.prepare(`
      INSERT INTO review_sessions
        (id, invitation_id, receipt_no, token_hash, csrf_secret, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(sessionId, invite.id, receipt.receipt_no, sha256(sessionRaw), csrf, ts, invite.expires_at, ts);

    addReviewEvent(invite.user_id, receipt.receipt_no, 'review.invitation.consumed', {
      invitationId: invite.id,
    });
    return {
      ok: true,
      sessionToken: sessionRaw,
      sessionId,
      csrf,
      receiptNo: receipt.receipt_no,
      expiresAt: invite.expires_at,
    };
  });
}

export function getValidReviewSession(rawToken) {
  if (!rawToken) return null;
  const session = db.prepare('SELECT * FROM review_sessions WHERE token_hash = ?').get(sha256(rawToken));
  if (!session || session.expires_at <= now()) return null;
  const invite = db.prepare('SELECT * FROM review_invitations WHERE id = ?').get(session.invitation_id);
  if (!invite) return null;
  // 办理人撤销邀请后，已发出的复核会话立即失效；邀请过期同理
  if (invite.status === 'revoked' || invite.revoked_at) return null;
  if (invite.expires_at <= now() || effectiveInvitationStatus(invite) === 'expired') return null;
  db.prepare('UPDATE review_sessions SET last_seen_at = ? WHERE id = ?').run(now(), session.id);
  return { session, invite };
}

export function deleteReviewSession(rawToken) {
  if (!rawToken) return;
  const session = db.prepare('SELECT * FROM review_sessions WHERE token_hash = ?').get(sha256(rawToken));
  if (session) db.prepare('DELETE FROM review_sessions WHERE id = ?').run(session.id);
}

// 复核人上下文：只能拿到会话绑定的这一份回执的脱敏内容与本人提交的异议
export function getReviewerContext(reviewSession) {
  const { session, invite } = reviewSession;
  const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(session.receipt_no);
  if (!receipt) return null;
  if (receipt.status === 'revoked') {
    return {
      receiptNo: receipt.receipt_no,
      status: 'revoked',
      revokedAt: receipt.revoked_at,
      expiresAt: Math.min(session.expires_at, invite.expires_at),
      view: null,
      objections: [],
    };
  }
  const snapshot = JSON.parse(receipt.snapshot_json);
  return {
    receiptNo: receipt.receipt_no,
    status: receipt.status,
    issuedAt: receipt.issued_at,
    completedAt: snapshot.completedAt,
    expiresAt: Math.min(session.expires_at, invite.expires_at),
    view: buildReviewView(snapshot),
    objections: listObjectionsForReviewerTx(session.id),
  };
}

function objectionPublic(row, { forOwner = false } = {}) {
  const out = {
    id: row.id,
    receiptNo: row.receipt_no,
    step: row.step,
    field: row.field,
    fieldLabel: row.field_label,
    valueSnapshot: row.value_snapshot,
    reason: row.reason,
    status: row.status,
    submittedAt: row.created_at,
    resolvedAt: row.resolved_at || null,
    resolveReason: row.resolve_reason || '',
    correctionWorkflowId: row.correction_workflow_id || null,
    correctionReceiptNo: row.correction_receipt_no || '',
  };
  if (forOwner) {
    const handler = row.resolved_by_user_id ? userQueries.findById(row.resolved_by_user_id) : null;
    out.resolvedBy = handler ? handler.display_name : '';
    out.invitationId = row.invitation_id;
    out.locked = Boolean(row.lock_session_id && row.status === 'open' && now() - row.locked_at < OBJECTION_LOCK_TTL_MS);
  }
  return out;
}

function listObjectionsForReviewerTx(sessionId) {
  return db.prepare(`
    SELECT * FROM review_objections WHERE session_id = ? ORDER BY created_at ASC
  `).all(sessionId).map((row) => objectionPublic(row));
}

// 办理人视角：异议列表（默认全部，可按回执过滤）
export function listObjectionsForOwner(userId, { receiptNo = '' } = {}) {
  const rows = receiptNo
    ? db.prepare('SELECT * FROM review_objections WHERE user_id = ? AND receipt_no = ? ORDER BY created_at ASC').all(userId, receiptNo)
    : db.prepare('SELECT * FROM review_objections WHERE user_id = ? ORDER BY created_at ASC').all(userId);
  return rows.map((row) => objectionPublic(row, { forOwner: true }));
}

export function submitReviewObjection({ reviewSession, step, field, reason, idempotencyKey, requestHash }) {
  return immediateTransaction(() => {
    const { session, invite } = reviewSession;
    if (invite.status === 'revoked' || invite.revoked_at) {
      return { ok: false, status: 410, code: 'INVITATION_REVOKED' };
    }
    if (invite.expires_at <= now()) {
      return { ok: false, status: 410, code: 'INVITATION_EXPIRED' };
    }
    const receipt = db.prepare('SELECT * FROM receipts WHERE receipt_no = ?').get(session.receipt_no);
    if (!receipt) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND' };
    if (receipt.status === 'revoked') return { ok: false, status: 410, code: 'RECEIPT_REVOKED' };

    if (!Number.isInteger(step) || step < 0 || step >= STEPS.length) {
      return { ok: false, status: 400, code: 'INVALID_FIELD', message: '异议字段不存在' };
    }
    const fieldInfo = reviewFieldDef(step, String(field || ''));
    if (!fieldInfo) return { ok: false, status: 400, code: 'INVALID_FIELD', message: '异议字段不存在' };
    const text = String(reason || '').trim();
    if (text.length < OBJECTION_REASON_MIN || text.length > OBJECTION_REASON_MAX) {
      return {
        ok: false,
        status: 400,
        code: 'INVALID_REASON',
        message: `异议说明需为 ${OBJECTION_REASON_MIN}-${OBJECTION_REASON_MAX} 个字符`,
      };
    }

    // 网络重试：同一幂等键 + 同一请求指纹返回同一结果；换内容重放明确失败
    const prior = db.prepare(`
      SELECT * FROM review_objections WHERE session_id = ? AND idempotency_key = ?
    `).get(session.id, idempotencyKey);
    if (prior) {
      if (prior.request_hash !== requestHash) {
        return { ok: false, status: 409, code: 'OBJECTION_DUPLICATE_KEY', message: '该提交编号已用于其他内容' };
      }
      return { ok: true, replay: true, objection: objectionPublic(prior) };
    }

    const snapshot = JSON.parse(receipt.snapshot_json);
    const rawValue = snapshot.steps?.[step]?.data?.[field];
    const valueSnapshot = reviewTextValue(field, rawValue);
    const ts = now();
    const id = cryptoId();
    db.prepare(`
      INSERT INTO review_objections
        (id, invitation_id, session_id, receipt_no, user_id, step, field, field_label,
         value_snapshot, reason, status, idempotency_key, request_hash, created_at,
         resolved_at, resolved_by_user_id, resolve_reason, correction_workflow_id,
         correction_receipt_no, lock_session_id, locked_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?, NULL, NULL, '', NULL, '', NULL, NULL)
    `).run(
      id, invite.id, session.id, receipt.receipt_no, invite.user_id,
      step, field, fieldInfo.rule.label, valueSnapshot, text,
      idempotencyKey, requestHash, ts,
    );
    addReviewEvent(invite.user_id, receipt.receipt_no, 'review.objection.submitted', {
      invitationId: invite.id, objectionId: id, step, field,
    });
    return { ok: true, objection: objectionPublic(db.prepare('SELECT * FROM review_objections WHERE id = ?').get(id)) };
  });
}

// 办理人打开处理框时尝试加锁：防止两个页面同时处理同一条异议（咨询锁，最终以状态为准）
export function lockObjectionForUser({ userId, objectionId, loginSessionId }) {
  return immediateTransaction(() => {
    const row = db.prepare('SELECT * FROM review_objections WHERE id = ? AND user_id = ?').get(objectionId, userId);
    if (!row) return { ok: false, status: 404, code: 'OBJECTION_NOT_FOUND', message: '异议不存在' };
    if (row.status !== 'open') {
      return {
        ok: false,
        status: 409,
        code: 'OBJECTION_ALREADY_HANDLED',
        message: `该异议已处理：${row.status === 'accepted' ? '已接受' : '已驳回'}`,
        objection: objectionPublic(row, { forOwner: true }),
      };
    }
    if (row.lock_session_id && row.lock_session_id !== loginSessionId && now() - row.locked_at < OBJECTION_LOCK_TTL_MS) {
      return { ok: false, status: 409, code: 'OBJECTION_LOCKED_BY_OTHER', message: '另一个页面正在处理该异议，请稍后刷新查看结果', objection: objectionPublic(row, { forOwner: true }) };
    }
    db.prepare('UPDATE review_objections SET lock_session_id = ?, locked_at = ? WHERE id = ?').run(loginSessionId, now(), row.id);
    return { ok: true, objection: objectionPublic(db.prepare('SELECT * FROM review_objections WHERE id = ?').get(row.id), { forOwner: true }) };
  });
}

function handledConflict(row) {
  return {
    ok: false,
    status: 409,
    code: 'OBJECTION_ALREADY_HANDLED',
    message: `该异议已处理：${row.status === 'accepted' ? '已接受并进入更正办理' : '已驳回'}，重复提交返回同一结果`,
    objection: objectionPublic(row, { forOwner: true }),
  };
}

// 接受异议：必须进入一次新的更正办理（复用进行中的同源更正，或当场新建）
export function acceptObjection({ userId, objectionId, loginSessionId }) {
  try {
    return immediateTransaction(() => {
      const row = db.prepare('SELECT * FROM review_objections WHERE id = ? AND user_id = ?').get(objectionId, userId);
      if (!row) return { ok: false, status: 404, code: 'OBJECTION_NOT_FOUND', message: '异议不存在' };
      if (row.status !== 'open') return handledConflict(row);

      const source = db.prepare('SELECT * FROM receipts WHERE receipt_no = ? AND user_id = ?').get(row.receipt_no, userId);
      if (!source) return { ok: false, status: 404, code: 'RECEIPT_NOT_FOUND', message: '原回执不存在' };

      let workflow = getActiveWorkflow(userId);
      if (workflow && workflow.source_receipt_no !== source.receipt_no) {
        return {
          ok: false,
          status: 409,
          code: 'OPEN_WORKFLOW_EXISTS',
          message: '已有进行中的其他办理，请先完成或放弃后再接受异议',
          workflow: publicWorkflow(workflow, getSteps(workflow.id)),
        };
      }
      let created = false;
      if (!workflow) {
        workflow = insertCorrectionWorkflowTx(source);
        created = true;
      }

      const ts = now();
      db.prepare(`
        UPDATE review_objections
        SET status = 'accepted', resolved_at = ?, resolved_by_user_id = ?, resolve_reason = '',
            correction_workflow_id = ?, lock_session_id = NULL, locked_at = NULL
        WHERE id = ? AND status = 'open'
      `).run(ts, userId, workflow.id, row.id);
      db.prepare(`
        INSERT OR IGNORE INTO correction_objections (workflow_id, objection_id, created_at)
        VALUES (?, ?, ?)
      `).run(workflow.id, row.id, ts);
      addReviewEvent(userId, source.receipt_no, 'review.objection.accepted', {
        objectionId: row.id, workflowId: workflow.id, created,
      });
      const updated = db.prepare('SELECT * FROM review_objections WHERE id = ?').get(row.id);
      return {
        ok: true,
        created,
        objection: objectionPublic(updated, { forOwner: true }),
        workflow: publicWorkflow(workflow, getSteps(workflow.id)),
      };
    });
  } catch (error) {
    if (String(error?.message || '').includes('UNIQUE')) {
      const row = db.prepare('SELECT * FROM review_objections WHERE id = ?').get(objectionId);
      if (row && row.status !== 'open') return handledConflict(row);
    }
    throw error;
  }
}

// 驳回异议：必须保留理由
export function rejectObjection({ userId, objectionId, loginSessionId, reason }) {
  const text = String(reason || '').trim();
  if (text.length < OBJECTION_REASON_MIN || text.length > 200) {
    return { ok: false, status: 400, code: 'REJECT_REASON_REQUIRED', message: `驳回理由需为 ${OBJECTION_REASON_MIN}-200 个字符` };
  }
  return immediateTransaction(() => {
    const row = db.prepare('SELECT * FROM review_objections WHERE id = ? AND user_id = ?').get(objectionId, userId);
    if (!row) return { ok: false, status: 404, code: 'OBJECTION_NOT_FOUND', message: '异议不存在' };
    if (row.status !== 'open') return handledConflict(row);
    const ts = now();
    db.prepare(`
      UPDATE review_objections
      SET status = 'rejected', resolved_at = ?, resolved_by_user_id = ?, resolve_reason = ?,
          lock_session_id = NULL, locked_at = NULL
      WHERE id = ? AND status = 'open'
    `).run(ts, userId, text, row.id);
    addReviewEvent(userId, row.receipt_no, 'review.objection.rejected', { objectionId: row.id });
    return { ok: true, objection: objectionPublic(db.prepare('SELECT * FROM review_objections WHERE id = ?').get(row.id), { forOwner: true }) };
  });
}

function getInvitationForOwnerTx(invitationId) {
  const row = db.prepare('SELECT * FROM review_invitations WHERE id = ?').get(invitationId);
  return ownerInvitation(row);
}

function ownerInvitation(row) {
  if (!row) return null;
  const status = row.status === 'active' && row.expires_at <= now() ? 'expired' : row.status;
  const objections = db.prepare(`
    SELECT * FROM review_objections WHERE invitation_id = ? ORDER BY created_at ASC
  `).all(row.id).map((item) => objectionPublic(item, { forOwner: true }));
  const counts = { open: 0, accepted: 0, rejected: 0 };
  for (const item of objections) counts[item.status] += 1;
  return {
    id: row.id,
    receiptNo: row.receipt_no,
    note: row.note || '',
    status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    usedAt: row.used_at || null,
    revokedAt: row.revoked_at || null,
    objectionCount: objections.length,
    counts,
    objections,
  };
}

export function listInvitationsForOwner(userId, { receiptNo = '' } = {}) {
  const rows = receiptNo
    ? db.prepare('SELECT * FROM review_invitations WHERE user_id = ? AND receipt_no = ? ORDER BY created_at DESC').all(userId, receiptNo)
    : db.prepare('SELECT * FROM review_invitations WHERE user_id = ? ORDER BY created_at DESC').all(userId);
  return rows.map((row) => ownerInvitation(row));
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

  // 复核协作条目：紧跟在对应回执之后，展示邀请与字段级异议的处理结果，
  // 以及“接受异议 → 更正办理 → 新回执”的来源关系。
  const invitations = db.prepare(`
    SELECT * FROM review_invitations WHERE user_id = ? ORDER BY created_at ASC
  `).all(userId);
  const objectionsByReceipt = new Map();
  for (const item of db.prepare('SELECT * FROM review_objections WHERE user_id = ? ORDER BY created_at ASC').all(userId)) {
    if (!objectionsByReceipt.has(item.receipt_no)) objectionsByReceipt.set(item.receipt_no, []);
    objectionsByReceipt.get(item.receipt_no).push(item);
  }
  const withReviews = [];
  const batchEntriesByReceipt = new Map();
  for (const batchEntry of buildBatchTimelineEntries(userId)) {
    if (!batchEntriesByReceipt.has(batchEntry.receiptNo)) batchEntriesByReceipt.set(batchEntry.receiptNo, []);
    batchEntriesByReceipt.get(batchEntry.receiptNo).push(batchEntry);
  }
  // 申诉回合按原批次归组：时间线中紧跟其原批次条目，区分原批次决议与申诉事件
  const appealEntriesByBatch = new Map();
  for (const appealEntry of buildAppealTimelineEntries(userId)) {
    if (!appealEntriesByBatch.has(appealEntry.batchId)) appealEntriesByBatch.set(appealEntry.batchId, []);
    appealEntriesByBatch.get(appealEntry.batchId).push(appealEntry);
  }
  // 调解包按申诉回合归组：时间线中紧跟其申诉回合条目（不修改原批次/申诉条目）
  const mediationEntriesByRound = new Map();
  for (const mediationEntry of buildMediationTimelineEntries(userId)) {
    if (!mediationEntriesByRound.has(mediationEntry.roundId)) mediationEntriesByRound.set(mediationEntry.roundId, []);
    mediationEntriesByRound.get(mediationEntry.roundId).push(mediationEntry);
  }
  // 案件组按其锚点成员包归组：时间线中插入到该调解包条目之后
  const caseGroups = buildCaseGroupTimelineEntries(userId);
  const caseGroupIdsByPackage = new Map();
  for (const groupEntry of caseGroups) {
    const anchor = (groupEntry.memberOrder || [])[0]
      || (groupEntry.members || [])[0]?.packageId
      || '';
    if (anchor) {
      if (!caseGroupIdsByPackage.has(anchor)) caseGroupIdsByPackage.set(anchor, []);
      caseGroupIdsByPackage.get(anchor).push(groupEntry);
    }
  }
  for (const entry of entries) {
    withReviews.push(entry);
    if (entry.kind !== 'receipt') continue;
    const invs = invitations.filter((inv) => inv.receipt_no === entry.receiptNo);
    const reviewLike = invs.map((inv) => ({ type: 'review', at: inv.created_at, inv }));
    for (const batchEntry of batchEntriesByReceipt.get(entry.receiptNo) || []) {
      reviewLike.push({ type: 'reviewBatch', at: batchEntry.createdAt, batch: batchEntry });
    }
    reviewLike.sort((a, b) => a.at - b.at);
    for (const item of reviewLike) {
      if (item.type === 'reviewBatch') {
        withReviews.push({ sequence: entry.sequence, ...item.batch });
        for (const appealEntry of appealEntriesByBatch.get(item.batch.batchId) || []) {
          withReviews.push({ sequence: entry.sequence, ...appealEntry });
          for (const mediationEntry of mediationEntriesByRound.get(appealEntry.roundId) || []) {
            withReviews.push({ sequence: entry.sequence, ...mediationEntry });
            // 案件组条目插入到其锚点调解包之后
            for (const caseGroupEntry of caseGroupIdsByPackage.get(mediationEntry.packageId) || []) {
              withReviews.push({ sequence: entry.sequence, ...caseGroupEntry, kind: 'caseGroup' });
            }
          }
        }
        continue;
      }
      const inv = item.inv;
      const invStatus = inv.status === 'active' && inv.expires_at <= now() ? 'expired' : inv.status;
      const objs = (objectionsByReceipt.get(inv.receipt_no) || []).filter((o) => o.invitation_id === inv.id);
      withReviews.push({
        kind: 'review',
        sequence: entry.sequence,
        receiptNo: entry.receiptNo,
        invitationId: inv.id,
        status: invStatus,
        createdAt: inv.created_at,
        expiresAt: inv.expires_at,
        usedAt: inv.used_at || null,
        revokedAt: inv.revoked_at || null,
        objectionCount: objs.length,
        openCount: objs.filter((o) => o.status === 'open').length,
        acceptedCount: objs.filter((o) => o.status === 'accepted').length,
        rejectedCount: objs.filter((o) => o.status === 'rejected').length,
        objections: objs.map((o) => ({
          id: o.id,
          step: o.step,
          field: o.field,
          fieldLabel: o.field_label,
          reason: o.reason,
          status: o.status,
          submittedAt: o.created_at,
          resolvedAt: o.resolved_at || null,
          resolveReason: o.resolve_reason || '',
          correctionReceiptNo: o.correction_receipt_no || '',
          correctionInProgress: Boolean(o.correction_workflow_id && !o.correction_receipt_no),
        })),
      });
    }
  }
  return withReviews;
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
  envelope.reviews = {
    invitations: listInvitationsForOwner(userId),
    objections: listObjectionsForOwner(userId),
  };
  envelope.reviewBatches = listBatchesForOwner(userId);
  envelope.reviewAppeals = listAppealRoundsForOwner(userId);
  envelope.mediationPackages = listMediationPackagesForOwner(userId);
  envelope.caseGroups = listCaseGroupsForOwner(userId);
  // 归档模块通过重导出供路由使用；经命名空间惰性访问，规避模块求值期循环依赖
  envelope.archives = archiveNs.listArchivesForOwner(userId);
  envelope.archiveRejections = archiveNs.listArchiveRejectionsForOwner(userId);
  envelope.archiveExports = archiveNs.listArchiveExportsForOwner(userId);
  // 归档版本比较报告与受控重放会话（同样惰性访问）
  envelope.archiveComparisons = comparisonNs.listComparisonsForOwner(userId);
  envelope.replaySessions = comparisonNs.listReplaysForOwner(userId);
  return envelope;
}

// 多方复核批次：统一从 db.js 重导出，路由层只依赖 db.js 一个模块
export {
  createReviewBatch,
  listBatchesForOwner,
  getBatchForOwner,
  startReviewBatch,
  cancelReviewBatch,
  revokeBatchInvitation,
  consumeBatchInvitation,
  getValidBatchSession,
  deleteBatchSession,
  getBatchReviewerContext,
  submitBatchOpinion,
  decideBatchField,
  reconfigureBatch,
  getBatchOrchestrationHistory,
  sweepBatchTimeouts,
} from './batchStore.js';

// 复核申诉回合：同样统一从 db.js 重导出
export {
  createAppealRound,
  listAppealRoundsForOwner,
  getAppealRoundForOwner,
  listAppealableFields,
  cancelAppealRound,
  consumeAppealInvitation,
  getValidAppealSession,
  deleteAppealSession,
  getAppealReviewerContext,
  submitAppealOpinion,
  decideAppealField,
  sweepAppealTimeouts,
} from './appealStore.js';

// 争议调解包：统一从 db.js 重导出
export {
  listMediatableAppealFields,
  createMediationPackage,
  listMediationPackagesForOwner,
  getMediationPackageForOwner,
  cancelMediationPackage,
  decideMediationField,
  consumeMediationInvitation,
  getValidMediationSession,
  deleteMediationSession,
  getMediationReviewerContext,
  submitMediationOpinion,
  sweepMediationTimeouts,
} from './mediationStore.js';

// 案件组（跨包冲突协调）：统一从 db.js 重导出
export {
  createCaseGroup,
  addCaseGroupMember,
  configureCaseGroup,
  startCaseGroup,
  cancelCaseGroup,
  getCaseGroupForOwner,
  listCaseGroupsForOwner,
  listGroupablePackages,
  sweepCaseGroupTimeouts,
  recoverCaseGroupsOnStartup,
  getCaseGroupMemberInfo,
  getCrossPackageDisclosureForSession,
  buildCaseGroupTimelineEntries,
} from './caseGroupStore.js';

// 可验证审计归档与分级查阅：统一从 db.js 重导出
export {
  createAuditArchive,
  getArchiveForOwner,
  getArchiveForAuditor,
  getArchiveExternalView,
  listArchivesForOwner,
  listArchivesForAuditor,
  listArchiveRejectionsForOwner,
  getLatestArchiveForSource,
  verifyArchiveChain,
  verifyArchiveIntegrity,
  issueExternalCode,
  consumeExternalCode,
  revokeExternalCode,
  startArchiveExport,
  getArchiveExportForOwner,
  listArchiveExportsForOwner,
  cancelArchiveExport,
  issueDownloadCredential,
  redeemDownloadCredential,
  listCredentialsForOwner,
  sweepArchiveExports,
  recoverArchiveExportsOnStartup,
  runExportToCompletion,
} from './archiveStore.js';

// 归档版本对比 + 受控重放审阅：统一从 db.js 重导出
export {
  createArchiveComparison,
  verifyComparison,
  getComparisonForOwner,
  listComparisonsForOwner,
  listComparisonsForAuditor,
  getComparisonForAuditor,
  createReplaySession,
  getReplayForOwner,
  listReplaysForOwner,
  issueReplaySubmitToken,
  submitReplayOpinion,
  pauseReplaySession,
  resumeReplaySession,
  cancelReplaySession,
  sweepReplaySessions,
} from './comparisonStore.js';
