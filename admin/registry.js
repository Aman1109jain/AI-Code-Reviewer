'use strict';
const { HttpError } = require('../middleware/errors');

// The admin console can only touch what is declared here. Table and column names in
// SQL come from this file, never from the request, so there is nothing to inject into.
// `hidden` columns (token ciphertext, session hashes) are never selected at all.

const INT_MAX = 2147483647;
const SEVERITIES = ['blocking', 'warning', 'nitpick'];
const CATEGORIES = ['security', 'performance', 'maintainability', 'readability'];
const SOURCES = ['github_pr', 'upload', 'quick_check'];
const LONG = 5 * 1000 * 1000;

const sys = (name, type = 'int', extra = {}) => ({ name, type, editable: false, ...extra });

const TABLES = {
  reviews: {
    label: 'Reviews',
    description: 'One row per PR review or Quick Check. Deleting a review also deletes its findings.',
    pk: 'id', canCreate: true, canUpdate: true, canDelete: true, versioned: true,
    search: ['repo_owner', 'repo_name', 'file_name', 'source_type'],
    columns: [
      sys('id'),
      { name: 'source_type', type: 'enum', values: SOURCES, required: true },
      { name: 'repo_owner', type: 'text', max: 255 },
      { name: 'repo_name', type: 'text', max: 255 },
      { name: 'pr_number', type: 'int', min: 0, max: INT_MAX },
      { name: 'file_name', type: 'text', max: 255 },
      { name: 'overall_score', type: 'int', min: 0, max: 100 },
      { name: 'diff_text', type: 'text', max: LONG, long: true },
      { name: 'source_code', type: 'text', max: LONG, long: true },
      { name: 'source_files', type: 'json', max: LONG, long: true },
      { name: 'owner_user_id', type: 'int', min: 1, max: INT_MAX, ref: 'github_users' },
      sys('created_at', 'timestamp'),
      sys('row_version', 'int', { system: true }),
    ],
  },
  findings: {
    label: 'Findings',
    description: 'Individual issues found in a review.',
    pk: 'id', canCreate: true, canUpdate: true, canDelete: true, versioned: true,
    search: ['file_path', 'issue', 'suggestion', 'severity', 'category'],
    columns: [
      sys('id'),
      { name: 'review_id', type: 'int', min: 1, max: INT_MAX, required: true, ref: 'reviews' },
      { name: 'file_path', type: 'text', max: 500 },
      { name: 'severity', type: 'enum', values: SEVERITIES, required: true },
      { name: 'category', type: 'enum', values: CATEGORIES },
      { name: 'issue', type: 'text', max: 20000, long: true },
      { name: 'suggestion', type: 'text', max: 20000, long: true },
      sys('created_at', 'timestamp'),
      sys('row_version', 'int', { system: true }),
    ],
  },
  github_users: {
    label: 'GitHub logins',
    description: 'People who connected GitHub. Tokens are encrypted and never shown. Deleting a user signs them out everywhere.',
    pk: 'id', canCreate: false, canUpdate: true, canDelete: true, versioned: true, touchUpdatedAt: true,
    search: ['login', 'name'],
    columns: [
      sys('id'),
      sys('github_id', 'int'),
      { name: 'login', type: 'text', max: 39, required: true, pattern: /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/, patternHint: 'a GitHub username' },
      { name: 'name', type: 'text', max: 255 },
      { name: 'avatar_url', type: 'text', max: 1000, pattern: /^https:\/\/[^\s]+$/, patternHint: 'an https:// link' },
      { name: 'access_token_enc', type: 'text', hidden: true, editable: false },
      sys('created_at', 'timestamp'),
      sys('updated_at', 'timestamp'),
      sys('row_version', 'int', { system: true }),
    ],
  },
  user_sessions: {
    label: 'Login sessions',
    description: 'Active GitHub-user browser sessions. Delete a row to sign that browser out.',
    pk: 'id', canCreate: false, canUpdate: false, canDelete: true, versioned: false,
    search: [],
    columns: [
      sys('id'),
      { name: 'session_hash', type: 'text', hidden: true, editable: false },
      sys('user_id', 'int'),
      sys('created_at', 'timestamp'),
      sys('expires_at', 'timestamp'),
    ],
  },
  admin_audit_log: {
    label: 'Audit log',
    description: 'Append-only record of admin sign-ins and changes. Read-only (the database itself refuses edits).',
    pk: 'id', canCreate: false, canUpdate: false, canDelete: false, versioned: false,
    search: ['admin_username', 'action', 'target'],
    columns: [
      sys('id'), sys('admin_id'), sys('admin_username', 'text'), sys('action', 'text'), sys('target', 'text'),
      sys('ip', 'text'), sys('details', 'json'), sys('created_at', 'timestamp'),
    ],
  },
  schema_migrations: {
    label: 'Schema migrations',
    description: 'Which database migrations have been applied. Read-only.',
    pk: 'version', pkType: 'text', canCreate: false, canUpdate: false, canDelete: false, versioned: false,
    search: ['name'],
    columns: [sys('version', 'text'), sys('name', 'text'), sys('applied_at', 'timestamp')],
  },
};

for (const [name, t] of Object.entries(TABLES)) {
  t.name = name;
  t.pkType = t.pkType || 'int';
  t.visible = t.columns.filter((c) => !c.hidden);
  t.byName = new Map(t.columns.map((c) => [c.name, c]));
}

const q = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

function getTable(name) {
  if (typeof name !== 'string' || !Object.prototype.hasOwnProperty.call(TABLES, name)) {
    throw new HttpError(404, 'Unknown table.');
  }
  return TABLES[name];
}

function parsePk(table, raw) {
  if (table.pkType === 'int') {
    const n = typeof raw === 'number' ? raw : /^\d{1,9}$/.test(String(raw)) ? Number(raw) : NaN;
    if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid row id.');
    return n;
  }
  if (!/^[0-9A-Za-z_-]{1,20}$/.test(String(raw))) throw new HttpError(400, 'Invalid row id.');
  return String(raw);
}

// Turns one user-supplied value into a safe SQL parameter. Throws HttpError on bad input.
function coerce(col, value) {
  const fail = (msg) => new HttpError(400, `${col.name}: ${msg}`);
  if (value === null || value === undefined || (typeof value === 'string' && value === '' && col.type !== 'text')) {
    if (col.required) throw fail('is required');
    return { value: null, cast: '' };
  }
  switch (col.type) {
    case 'int': {
      const n = typeof value === 'number' ? value : /^-?\d+$/.test(String(value).trim()) ? Number(value) : NaN;
      if (!Number.isInteger(n)) throw fail('must be a whole number');
      if (n < (col.min ?? 0) || n > (col.max ?? INT_MAX)) throw fail(`must be between ${col.min ?? 0} and ${col.max ?? INT_MAX}`);
      return { value: n, cast: '' };
    }
    case 'text': {
      if (typeof value !== 'string') throw fail('must be text');
      if (value.includes('\u0000')) throw fail('contains an invalid character');
      if (value.length > (col.max ?? 20000)) throw fail(`is too long (max ${col.max ?? 20000} characters)`);
      if (value === '' && !col.required) return { value: null, cast: '' };
      if (col.required && value.trim() === '') throw fail('is required');
      if (col.pattern && !col.pattern.test(value)) throw fail(`must be ${col.patternHint || 'in a valid format'}`);
      return { value, cast: '' };
    }
    case 'enum': {
      if (!col.values.includes(value)) throw fail(`must be one of: ${col.values.join(', ')}`);
      return { value, cast: '' };
    }
    case 'json': {
      let parsed = value;
      if (typeof value === 'string') {
        try { parsed = JSON.parse(value); } catch { throw fail('is not valid JSON'); }
      }
      if (parsed === null || typeof parsed !== 'object') throw fail('must be a JSON object or array');
      const text = JSON.stringify(parsed);
      if (text.length > (col.max ?? LONG)) throw fail('is too large');
      if (text.includes('\\u0000')) throw fail('contains an invalid character');
      return { value: text, cast: '::jsonb' };
    }
    case 'bool': {
      if (typeof value !== 'boolean') throw fail('must be true or false');
      return { value, cast: '' };
    }
    default:
      throw fail('cannot be edited');
  }
}

// Columns as shown in the grid: long text is cut to a short preview.
function selectList(table, { preview }) {
  return table.visible
    .map((c) => (preview && c.long ? `LEFT(${q(c.name)}::text, 200) AS ${q(c.name)}` : q(c.name)))
    .join(', ');
}

function describe(table) {
  return {
    name: table.name, label: table.label, description: table.description, pk: table.pk,
    canCreate: table.canCreate, canUpdate: table.canUpdate, canDelete: table.canDelete, versioned: table.versioned,
    columns: table.visible.map((c) => ({
      name: c.name, type: c.type, editable: c.editable !== false, required: Boolean(c.required),
      long: Boolean(c.long), values: c.values, max: c.max, system: Boolean(c.system), ref: c.ref,
    })),
  };
}

module.exports = { TABLES, getTable, parsePk, coerce, selectList, describe, q };
