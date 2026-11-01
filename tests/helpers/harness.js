'use strict';
require('./env');
const http = require('http');

// Integration tests run the real app against a REAL PostgreSQL database that you point
// at with TEST_DATABASE_URL. The tables are emptied at the start of each run, so use a
// throwaway database - never your real one (hosted databases are refused).
const url = process.env.TEST_DATABASE_URL || '';
const skip = !url ? 'set TEST_DATABASE_URL (a throwaway Postgres database) to run the integration tests' : false;
if (url && /neon\.tech|amazonaws\.com|supabase|render\.com|azure\.com|cloud\.google/i.test(url)) {
  throw new Error('TEST_DATABASE_URL looks like a hosted database. Use a local throwaway database for tests (they delete data).');
}

class Client {
  constructor(base) {
    this.base = base;
    this.origin = 'http://localhost:5173';
    this.jar = new Map();
    this.csrf = null;
  }

  cookie(name) { return this.jar.get(name); }

  storeCookies(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const expired = attrs.some((a) => /^\s*(max-age=0|expires=thu, 01 jan 1970)/i.test(a));
      if (expired || value === '') this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async request(method, path, { json, headers = {}, raw, csrf = true, origin = this.origin } = {}) {
    const h = { ...headers };
    const unsafe = !['GET', 'HEAD'].includes(method);
    // Fetch the CSRF token first (it sets the CSRF cookie), THEN build the Cookie header.
    if (unsafe && csrf && !h['x-csrf-token']) {
      if (!this.csrf) await this.refreshCsrf();
      h['x-csrf-token'] = this.csrf;
    }
    if (this.jar.size) h.cookie = [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (origin) h.origin = origin;
    let body;
    if (raw !== undefined) { body = raw; } else if (json !== undefined) { body = JSON.stringify(json); h['content-type'] = 'application/json'; }
    const res = await fetch(`${this.base}${path}`, { method, headers: h, body, redirect: 'manual' });
    this.storeCookies(res);
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    // Logging in/out changes the CSRF token (it is bound to the session): fetch a new one next time.
    if (/\/(login|logout|mfa\/enable|mfa\/verify|password)/.test(path) && res.ok) this.csrf = null;
    return { status: res.status, data, headers: res.headers };
  }

  async refreshCsrf() {
    const r = await this.request('GET', '/api/csrf');
    this.csrf = r.data.token;
  }

  get(path, o) { return this.request('GET', path, o); }
  post(path, json, o) { return this.request('POST', path, { json, ...o }); }
  patch(path, json, o) { return this.request('PATCH', path, { json, ...o }); }
  del(path, json, o) { return this.request('DELETE', path, { json, ...o }); }
}

async function start() {
  const { migrate } = require('../../scripts/migrate');
  const pool = require('../../database/connection');
  await migrate({ log() {} });
  await pool.query(`TRUNCATE reviews, findings, github_users, user_sessions, admin_users, admin_sessions,
                    admin_recovery_codes, admin_audit_log RESTART IDENTITY CASCADE`);
  const { createApp } = require('../../app');
  const server = http.createServer(createApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base, pool,
    client: () => new Client(base),
    async stop() {
      server.closeAllConnections?.();
      await new Promise((r) => server.close(r));
      await pool.end();
    },
  };
}

module.exports = { start, skip, Client };
