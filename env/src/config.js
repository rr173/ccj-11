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
};

config.isProduction = config.nodeEnv === 'production';
