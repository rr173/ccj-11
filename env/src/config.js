import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const config = {
  rootDir,
  port: Number(process.env.PORT || 3000),
  nodeEnv: process.env.NODE_ENV || 'development',
  dbPath: process.env.DB_PATH || path.join(rootDir, 'data', 'wizard.db'),
  tokenTtlMs: Number(process.env.TOKEN_TTL_MS || 10 * 60 * 1000),
  sessionTtlMs: Number(process.env.SESSION_TTL_MS || 12 * 60 * 60 * 1000),
  cookieSecure: process.env.COOKIE_SECURE === '1',
  demoPassword: process.env.DEMO_PASSWORD || 'password123',
};

config.isProduction = config.nodeEnv === 'production';
