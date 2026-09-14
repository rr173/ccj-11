import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dbPath = process.env.DB_PATH || path.join(rootDir, 'data', 'wizard.db');

export const config = {
  rootDir,
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  dbPath,
  tokenTtlMs: Number(process.env.TOKEN_TTL_MS || 10 * 60 * 1000),
  sessionTtlMs: Number(process.env.SESSION_TTL_MS || 12 * 60 * 60 * 1000),
  cookieSecure: process.env.COOKIE_SECURE === '1',
  demoPassword: process.env.DEMO_PASSWORD || 'password123',
  // 回执展示与编号日期使用的时区（仅影响展示，存储一律为 epoch 毫秒）
  displayTimezone: process.env.DISPLAY_TIMEZONE || 'Asia/Shanghai',
  // 免登录核验接口的限流（按来源 IP 的滑动窗口）
  verifyRateWindowMs: Number(process.env.VERIFY_RATE_WINDOW_MS || 15 * 60 * 1000),
  verifyRateMax: Number(process.env.VERIFY_RATE_MAX || 20),
  // 回执复核邀请：限时（默认最长 7 天）、链接只能使用一次；复核人免登录
  reviewInviteDefaultTtlMs: Number(process.env.REVIEW_INVITE_TTL_MS || 3 * 24 * 60 * 60 * 1000),
  reviewInviteMaxTtlMs: Number(process.env.REVIEW_INVITE_MAX_TTL_MS || 7 * 24 * 60 * 60 * 1000),
  reviewInviteMinTtlMs: Number(process.env.REVIEW_INVITE_MIN_TTL_MS || 5 * 60 * 1000),
  // 核验码由 HMAC 确定性派生：数据库不存核验码。
  // 优先使用 RECEIPT_SECRET；否则在数据目录生成 0600 权限的密钥文件（随 Docker volume 持久化）。
  receiptSecret: process.env.RECEIPT_SECRET || '',
  receiptSecretPath: process.env.RECEIPT_SECRET_PATH || path.join(path.dirname(dbPath), 'receipt-secret.key'),
  // 审计归档导出：后台任务分块生成（每块事件数与处理间隔可经环境变量调小以便测试）
  archiveExportChunkSize: Number(process.env.ARCHIVE_EXPORT_CHUNK_SIZE || 50),
  // 已完成导出文件与一次性下载凭证的保留期（到期后台清理）
  archiveExportTtlMs: Number(process.env.ARCHIVE_EXPORT_TTL_MS || 24 * 60 * 60 * 1000),
  // 一次性下载凭证 / 外部核验码的有效期
  archiveCredentialTtlMs: Number(process.env.ARCHIVE_CREDENTIAL_TTL_MS || 15 * 60 * 1000),
  archiveExternalCodeTtlMs: Number(process.env.ARCHIVE_EXTERNAL_CODE_TTL_MS || 24 * 60 * 60 * 1000),
  // 导出任务的后台扫描间隔（断点续传、过期清理；设 NO_ARCHIVE_SWEEP=1 关闭定时器）
  archiveSweepMs: Number(process.env.ARCHIVE_SWEEP_MS || 1000),
  // 受控重放审阅会话：有效期范围（分钟）与一次性提交令牌有效期
  replayMinTtlMs: Number(process.env.REPLAY_MIN_TTL_MS || 5 * 60 * 1000),
  replayMaxTtlMs: Number(process.env.REPLAY_MAX_TTL_MS || 7 * 24 * 60 * 60 * 1000),
  replayDefaultTtlMs: Number(process.env.REPLAY_DEFAULT_TTL_MS || 60 * 60 * 1000),
  replaySubmitTokenTtlMs: Number(process.env.REPLAY_SUBMIT_TOKEN_TTL_MS || 10 * 60 * 1000),
  // 回执撤销异议：默认处理期限（日历化后按【工作分钟】计算；旧异议沿用自然日 TTL）
  receiptObjectionTtlMs: Number(process.env.RECEIPT_OBJECTION_TTL_MS || 7 * 24 * 60 * 60 * 1000),
  // 新异议的办理时长（工作分钟，按异议创建时固定的工作日历版本计算）。
  // 默认 7 个工作日 × 8 小时（上午 3h + 下午 4h）= 3360 分钟。
  receiptObjectionSlaMinutes: Number(process.env.RECEIPT_OBJECTION_SLA_MINUTES
    || 7 * 8 * 60),
  // 主管批准一次延期后顺延的工作分钟（默认 3 个工作日 × 8 小时）
  objectionExtensionMinutes: Number(process.env.OBJECTION_EXTENSION_MINUTES || 3 * 8 * 60),
  // 测试 / 纯自然日语义部署：新异议固定使用全天 24 小时的 v0 兼容日历
  // （生产默认关闭，新异议使用当前发布的工作日历版本）
  calendarLegacyDefault: process.env.CALENDAR_LEGACY_DEFAULT === '1',
  // 异议超期升级与通知留痕：
  // 到期前提前提醒时间点（毫秒，逗号分隔；可多个，如 24 小时、2 小时）
  objectionReminderLeadMs: String(process.env.OBJECTION_REMINDER_LEAD_MS
    || `${24 * 60 * 60 * 1000},${2 * 60 * 60 * 1000}`)
    .split(',').map((v) => Number(v.trim())).filter((v) => Number.isFinite(v) && v > 0),
  // 批准一次延期后顺延的时长（默认 3 个自然日）
  objectionExtensionMs: Number(process.env.OBJECTION_EXTENSION_MS || 3 * 24 * 60 * 60 * 1000),
  // 后台扫描间隔（生成提醒/逾期升级、发送待发送通知；NO_OBJECTION_SWEEP=1 可关闭定时器）
  objectionSweepMs: Number(process.env.OBJECTION_SWEEP_MS || 1000),
  // ---------------------------------------------------------------------------
  // 回执线下领取预约与一次性交付
  // ---------------------------------------------------------------------------
  // 领取码 HMAC 密钥：优先环境变量，否则在数据目录生成 0600 权限密钥文件
  pickupCodeSecret: process.env.PICKUP_CODE_SECRET || '',
  pickupCodeSecretPath: process.env.PICKUP_CODE_SECRET_PATH
    || path.join(path.dirname(dbPath), 'pickup-code-secret.key'),
  // 允许的交付宽限时间：预约结束后该毫秒数内仍可确认交付（默认 15 分钟）
  pickupGraceMs: Number(process.env.PICKUP_GRACE_MS || 15 * 60 * 1000),
  // 超期未领取预约的落定扫描间隔（NO_PICKUP_SWEEP=1 关闭）
  pickupSweepMs: Number(process.env.PICKUP_SWEEP_MS || 1000),
};

config.isProduction = config.nodeEnv === 'production';
