#!/usr/bin/env node
'use strict';
require('dotenv').config({ quiet: true });
const fs = require('fs');
const pool = require('../database/connection');
const store = require('../admin/store');
const pw = require('../lib/password');
const { getConfig } = require('../config/env');

// Terminal tool for admin accounts (the equivalent of Django's createsuperuser /
// changepassword). The first admin can only be created here, on the server, by
// someone with access to the machine and the database credentials.
//
//   npm run create-admin                      create a superadmin (asks for everything)
//   npm run admin -- list                     list admin accounts
//   npm run admin -- reset-password <user>    set a new password (also unlocks the account)
//   npm run admin -- reset-mfa <user>         remove the authenticator (re-enrolled at next sign-in)
//   npm run admin -- unlock <user>            clear a lockout after failed sign-ins

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// --- input ------------------------------------------------------------------
let pipedLines = null;
function ask(question, { hidden = false } = {}) {
  process.stdout.write(question);
  if (!process.stdin.isTTY) {
    // Input is piped (scripts / tests): take the next line.
    if (!pipedLines) pipedLines = fs.readFileSync(0, 'utf8').split(/\r?\n/);
    process.stdout.write('\n');
    return Promise.resolve(pipedLines.shift() ?? '');
  }
  return new Promise((resolve) => {
    const { stdin, stdout } = process;
    let buf = '';
    const done = (value) => {
      stdin.removeListener('data', onData);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      resolve(value);
    };
    const onData = (chunk) => {
      for (const ch of String(chunk)) {
        if (ch === '\u0003') { // Ctrl+C
          stdin.setRawMode(false);
          stdout.write('\n');
          process.exit(130);
        } else if (ch === '\r' || ch === '\n') {
          return done(buf);
        } else if (ch === '\u007f' || ch === '\b') {
          if (buf.length) { buf = buf.slice(0, -1); if (!hidden) stdout.write('\b \b'); }
        } else if (ch >= ' ') {
          buf += ch;
          if (!hidden) stdout.write(ch);
        }
      }
      return undefined;
    };
    stdin.setEncoding('utf8');
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
  });
}

async function askValid(question, validate, opts) {
  for (let i = 0; i < 3; i += 1) {
    const value = (await ask(question, opts)).trim();
    const problem = validate(value);
    if (!problem) return value;
    console.log(`  ${problem}`);
  }
  throw new Error('Too many invalid answers.');
}

async function askNewPassword(identity) {
  for (let i = 0; i < 3; i += 1) {
    const first = await ask('Password: ', { hidden: true });
    const problems = pw.checkPasswordPolicy(first, identity);
    if (problems.length) { problems.forEach((p) => console.log(`  ${p}`)); continue; }
    const second = await ask('Password (again): ', { hidden: true });
    if (first !== second) { console.log('  The two passwords do not match.'); continue; }
    return first;
  }
  throw new Error('Too many invalid answers.');
}

async function requireUser(username) {
  if (!username) throw new Error('Give a username, e.g.  npm run admin -- reset-password alice');
  const user = await store.findByUsername(username);
  if (!user) throw new Error(`No admin named "${store.normUsername(username)}".`);
  return user;
}

// --- commands ---------------------------------------------------------------
const commands = {
  async create(args) {
    const roleArg = args.find((a) => a.startsWith('--role='));
    const role = roleArg ? roleArg.split('=')[1] : 'superadmin';
    if (!['admin', 'superadmin'].includes(role)) throw new Error('--role must be admin or superadmin');

    const username = await askValid('Username: ', (v) => (USERNAME_RE.test(v.toLowerCase()) ? null : '3-32 characters: letters, digits, dot, underscore, hyphen.'));
    if (await store.findByUsername(username)) throw new Error('That username is already taken.');
    const email = await askValid('Email address: ', (v) => (v.length <= 254 && EMAIL_RE.test(v) ? null : 'Enter a valid email address.'));
    const password = await askNewPassword({ username, email });

    const user = await store.createAdmin({ username, email, passwordHash: await pw.hashPassword(password), role });
    await store.audit({ username: 'cli', action: 'cli.create_admin', target: user.username, details: { role } });
    console.log(`\n${role === 'superadmin' ? 'Superadmin' : 'Admin'} "${user.username}" created.`);
    console.log(`Sign in at ${getConfig().dashboardUrl}/admin - you will be asked to set up an authenticator app (MFA) on first sign-in.`);
  },

  async list() {
    const admins = await store.listAdmins();
    if (!admins.length) return console.log('No admin accounts yet. Create one with: npm run create-admin');
    console.log('USERNAME'.padEnd(20), 'ROLE'.padEnd(11), 'ACTIVE'.padEnd(7), 'MFA'.padEnd(5), 'LAST SIGN-IN'.padEnd(26), 'EMAIL');
    for (const a of admins) {
      console.log(
        a.username.padEnd(20), a.role.padEnd(11), (a.is_active ? 'yes' : 'no').padEnd(7), (a.totp_enabled ? 'yes' : 'no').padEnd(5),
        (a.last_login_at ? new Date(a.last_login_at).toISOString() : 'never').padEnd(26), a.email
      );
    }
    return undefined;
  },

  async 'reset-password'([username]) {
    const user = await requireUser(username);
    const password = await askNewPassword({ username: user.username, email: user.email });
    await store.setPassword(user.id, await pw.hashPassword(password), { mustChange: false });
    await store.destroyAllSessions(user.id);
    await store.audit({ username: 'cli', action: 'cli.reset_password', target: user.username });
    console.log(`Password updated for "${user.username}". All their sessions were signed out and any lockout was cleared.`);
  },

  async 'reset-mfa'([username]) {
    const user = await requireUser(username);
    const sure = (await ask(`Remove the authenticator and recovery codes for "${user.username}"? [y/N] `)).trim().toLowerCase();
    if (sure !== 'y' && sure !== 'yes') return console.log('Cancelled.');
    await store.resetMfa(user.id);
    await store.destroyAllSessions(user.id);
    await store.audit({ username: 'cli', action: 'cli.reset_mfa', target: user.username });
    console.log(`MFA reset for "${user.username}". They will set up a new authenticator at their next sign-in.`);
    return undefined;
  },

  async unlock([username]) {
    const user = await requireUser(username);
    await store.unlock(user.id);
    await store.audit({ username: 'cli', action: 'cli.unlock', target: user.username });
    console.log(`"${user.username}" is unlocked.`);
  },
};

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || !commands[command]) {
    console.log('Usage: npm run create-admin | npm run admin -- <list|reset-password|reset-mfa|unlock> [username]');
    return;
  }
  const { rows } = await pool.query(`SELECT to_regclass('public.admin_users') AS t`);
  if (!rows[0].t) throw new Error('The admin tables do not exist yet. Run  npm run migrate  first.');
  await commands[command](args);
}

main()
  .catch((err) => {
    console.error(`\nError: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
