'use strict';
// Single source of truth for configuration. Everything is validated once, at
// startup, so a typo in .env fails loudly instead of silently weakening security.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { z } = require('zod');

const SECRET_FILE = path.join(__dirname, '..', '.data', 'session-secret');

function parseTrustProxy(raw) {
  if (raw === undefined) return false;
  const v = String(raw).trim().toLowerCase();
  if (v === '' || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  if (/^\d+$/.test(v)) return Number(v); // number of proxy hops (recommended)
  return raw; // e.g. "loopback" or a CIDR list
}

const bool = (def) =>
  z.preprocess(
    (v) => (v === undefined ? def : /^(1|true|yes|on)$/i.test(String(v))),
    def === undefined ? z.boolean().optional() : z.boolean()
  );

const Schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  DATABASE_URL: z.string().min(1).optional(),
  // verify = check the server certificate (default). no-verify = encrypt but trust any cert
  // (not recommended). off = plain TCP, only for a local database.
  DATABASE_SSL: z.enum(['verify', 'no-verify', 'off']).default('verify'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters').optional(),
  GEMINI_API_KEY: z.string().min(1).optional(),
  GEMINI_MODEL: z.string().min(1).default('gemini-3.6-flash'),
  GITHUB_WEBHOOK_SECRET: z.string().min(16, 'GITHUB_WEBHOOK_SECRET must be at least 16 characters').optional(),
  WEBHOOK_PATH: z.string().regex(/^\/[A-Za-z0-9/_-]*$/).default('/webhook/github'),
  SMEE_URL: z.url().optional(),
  DASHBOARD_URL: z.url().default('http://localhost:5173'),
  ALLOWED_ORIGINS: z.string().default(''),
  TRUST_PROXY: z.string().optional(),
  SESSION_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  ADMIN_IDLE_MINUTES: z.coerce.number().int().min(5).max(240).default(30),
  ADMIN_MAX_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  SERVE_CLIENT: bool(undefined),
  FORCE_HTTPS: bool(false),
  LOG_LEVEL: z.enum(['error', 'warn', 'info']).default('info'),
});

let cached = null;

function readOrCreateDevSecret() {
  try {
    return fs.readFileSync(SECRET_FILE, 'utf8').trim();
  } catch {
    const secret = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(SECRET_FILE), { recursive: true });
    fs.writeFileSync(SECRET_FILE, secret, { mode: 0o600 });
    return secret;
  }
}

function load(env = process.env) {
  // Treat empty strings ("KEY=") as "not set".
  const cleaned = Object.fromEntries(Object.entries(env).filter(([, v]) => v !== undefined && v !== ''));
  const parsed = Schema.safeParse(cleaned);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(env)'}: ${i.message}`);
    throw new Error(`Invalid configuration:\n${lines.join('\n')}`);
  }
  const e = parsed.data;
  const isProd = e.NODE_ENV === 'production';
  const warnings = [];

  let sessionSecret = e.SESSION_SECRET;
  if (!sessionSecret) {
    if (isProd) {
      throw new Error('Invalid configuration:\n  - SESSION_SECRET is required in production (32+ random characters).');
    }
    sessionSecret = readOrCreateDevSecret();
    warnings.push('SESSION_SECRET is not set - using a generated development secret from .data/session-secret.');
  }

  const dashboardOrigin = new URL(e.DASHBOARD_URL).origin;
  const allowedOrigins = [
    ...new Set(
      [dashboardOrigin, ...e.ALLOWED_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)].map((o) => {
        try {
          return new URL(o).origin;
        } catch {
          throw new Error(`Invalid configuration:\n  - ALLOWED_ORIGINS contains an invalid URL: "${o}"`);
        }
      })
    ),
  ];

  const trustProxy = parseTrustProxy(e.TRUST_PROXY);
  if (isProd && trustProxy === false) {
    warnings.push('TRUST_PROXY is not set. If the app runs behind a reverse proxy, set it to the number of proxies (e.g. 1), otherwise rate limits will see only the proxy IP.');
  }
  if (trustProxy === true) {
    warnings.push('TRUST_PROXY=true trusts every X-Forwarded-For header, which clients can spoof. Prefer a hop count such as 1.');
  }
  if (e.DATABASE_SSL === 'no-verify') {
    warnings.push('DATABASE_SSL=no-verify: the database connection is encrypted but the server certificate is not checked.');
  }
  if (!e.GITHUB_WEBHOOK_SECRET) {
    warnings.push('GITHUB_WEBHOOK_SECRET is not set - incoming GitHub webhooks will be rejected until you set it (and the same secret in the GitHub webhook settings).');
  }

  return Object.freeze({
    nodeEnv: e.NODE_ENV,
    isProd,
    isTest: e.NODE_ENV === 'test',
    port: e.PORT,
    databaseUrl: e.DATABASE_URL,
    databaseSsl: e.DATABASE_SSL,
    sessionSecret,
    geminiApiKey: e.GEMINI_API_KEY,
    geminiModel: e.GEMINI_MODEL,
    webhookSecret: e.GITHUB_WEBHOOK_SECRET,
    webhookPath: e.WEBHOOK_PATH,
    smeeUrl: e.SMEE_URL,
    dashboardUrl: e.DASHBOARD_URL.replace(/\/+$/, ''),
    allowedOrigins,
    trustProxy,
    sessionDays: e.SESSION_DAYS,
    adminIdleMs: e.ADMIN_IDLE_MINUTES * 60 * 1000,
    adminMaxMs: e.ADMIN_MAX_HOURS * 60 * 60 * 1000,
    serveClient: e.SERVE_CLIENT === undefined ? isProd : e.SERVE_CLIENT,
    forceHttps: e.FORCE_HTTPS,
    logLevel: e.LOG_LEVEL,
    warnings,
  });
}

function getConfig() {
  if (!cached) cached = load();
  return cached;
}

// Tests build a fresh config from a custom environment.
function resetConfigForTests() {
  cached = null;
}

module.exports = { getConfig, load, resetConfigForTests };
