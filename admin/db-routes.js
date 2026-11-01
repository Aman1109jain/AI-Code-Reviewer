'use strict';
const express = require('express');
const pool = require('../database/connection');
const { withTransaction } = require('../database/tx');
const store = require('./store');
const { z } = require('zod');
const { validate } = require('../middleware/validate');
const { HttpError, wrap, pgToHttp } = require('../middleware/errors');
const { reviewEvents } = require('../lib/events');
const { TABLES, getTable, parsePk, coerce, selectList, describe, q } = require('./registry');

const router = express.Router();

const MAX_OPS = 100;
const idValue = z.union([z.number().int().min(1).max(2147483647), z.string().min(1).max(20)]);
const values = z.record(z.string().max(64), z.unknown());
const op = z.discriminatedUnion('op', [
  z.strictObject({ op: z.literal('insert'), table: z.string().max(40), values }),
  z.strictObject({ op: z.literal('update'), table: z.string().max(40), id: idValue, expectedVersion: z.number().int().min(1).optional(), values }),
  z.strictObject({ op: z.literal('delete'), table: z.string().max(40), id: idValue, expectedVersion: z.number().int().min(1).optional() }),
]);
const transactionBody = z.strictObject({ ops: z.array(op).min(1).max(MAX_OPS) });

const listQuery = z.strictObject({
  page: z.coerce.number().int().min(1).max(1000000).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.string().max(64).optional(),
  dir: z.enum(['asc', 'desc']).default('desc'),
  q: z.string().max(100).optional(),
});

// --- reading -----------------------------------------------------------------

router.get('/tables', wrap(async (req, res) => {
  const out = [];
  for (const table of Object.values(TABLES)) {
    const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM ${q(table.name)}`);
    out.push({ ...describe(table), rowCount: rows[0].n });
  }
  res.json({ tables: out, maxOpsPerTransaction: MAX_OPS });
}));

router.get('/tables/:table/rows', validate({ query: listQuery }), wrap(async (req, res) => {
  const table = getTable(req.params.table);
  const { page, pageSize, dir } = req.query;
  const sortCol = req.query.sort === undefined ? table.pk : req.query.sort;
  const col = table.byName.get(sortCol);
  if (!col || col.hidden) throw new HttpError(400, 'Cannot sort by that column.');

  const params = [];
  let where = '';
  if (req.query.q && table.search.length) {
    params.push(`%${req.query.q.replace(/[\\%_]/g, '\\$&')}%`);
    where = `WHERE ${table.search.map((c) => `${q(c)}::text ILIKE $1 ESCAPE '\\'`).join(' OR ')}`;
  }
  const total = (await pool.query(`SELECT COUNT(*)::int AS n FROM ${q(table.name)} ${where}`, params)).rows[0].n;
  const direction = dir === 'asc' ? 'ASC' : 'DESC';
  const { rows } = await pool.query(
    `SELECT ${selectList(table, { preview: true })} FROM ${q(table.name)} ${where}
      ORDER BY ${q(col.name)} ${direction}, ${q(table.pk)} ${direction}
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params
  );
  res.json({ rows, total, page, pageSize, pages: Math.max(1, Math.ceil(total / pageSize)) });
}));

router.get('/tables/:table/rows/:id', wrap(async (req, res) => {
  const table = getTable(req.params.table);
  const id = parsePk(table, req.params.id);
  const { rows } = await pool.query(`SELECT ${selectList(table, { preview: false })} FROM ${q(table.name)} WHERE ${q(table.pk)} = $1`, [id]);
  if (!rows.length) throw new HttpError(404, 'Row not found.');
  res.json({ row: rows[0] });
}));

// --- writing: ACID transactions -------------------------------------------------
//
// POST /api/admin/db/transactions  { ops: [ {op:'insert'|'update'|'delete', table, ...}, ... ] }
//
//  Atomicity   all operations run inside one BEGIN..COMMIT; if any one fails, ALL are rolled back.
//  Consistency foreign keys, NOT NULL, CHECK and UNIQUE constraints are enforced by PostgreSQL,
//              on top of the per-column validation in registry.js.
//  Isolation   each touched row is locked (SELECT ... FOR UPDATE) and compared with the
//              row_version the admin saw (optimistic concurrency) - two admins can't silently
//              overwrite each other.
//  Durability  COMMIT returns only after PostgreSQL has written the change to its WAL.
// The audit entry is written inside the same transaction, so a change and its record
// either both exist or neither does.

function opLabel(i, o) {
  return `Operation ${i + 1} (${o.op} ${o.table}${o.id !== undefined ? ` #${o.id}` : ''})`;
}

async function lockRow(client, table, id) {
  const cols = table.versioned ? `${q(table.pk)}, row_version` : q(table.pk);
  const { rows } = await client.query(`SELECT ${cols} FROM ${q(table.name)} WHERE ${q(table.pk)} = $1 FOR UPDATE`, [id]);
  return rows[0] || null;
}

function checkVersion(table, row, expected) {
  if (!table.versioned) return;
  if (expected === undefined) throw new HttpError(400, 'expectedVersion is required for this table. Reload the row and try again.');
  if (row.row_version !== expected) {
    throw new HttpError(409, 'This row was changed by someone else after you opened it. Reload it and redo your change.', { code: 'version_conflict' });
  }
}

function buildAssignments(table, input, { insert }) {
  const cols = [];
  const params = [];
  const placeholders = [];
  for (const [name, raw] of Object.entries(input)) {
    const col = table.byName.get(name);
    if (!col || col.hidden) throw new HttpError(400, `Unknown column "${name}".`);
    if (col.editable === false) throw new HttpError(400, `${name} cannot be edited.`);
    const { value, cast } = coerce(col, raw);
    params.push(value);
    cols.push(q(name));
    placeholders.push(`$${params.length}${cast}`);
  }
  if (insert) {
    for (const col of table.columns) {
      if (col.required && col.editable !== false && !(col.name in input)) throw new HttpError(400, `${col.name} is required.`);
    }
  }
  if (!cols.length) throw new HttpError(400, 'No values to save.');
  return { cols, params, placeholders };
}

async function applyOp(client, o) {
  const table = getTable(o.table);
  if (o.op === 'insert') {
    if (!table.canCreate) throw new HttpError(403, `${table.label} cannot be added to from here.`);
    const { cols, params, placeholders } = buildAssignments(table, o.values, { insert: true });
    const { rows } = await client.query(`INSERT INTO ${q(table.name)} (${cols.join(', ')}) VALUES (${placeholders.join(', ')}) RETURNING ${q(table.pk)}`, params);
    return { op: 'insert', table: table.name, id: rows[0][table.pk], columns: Object.keys(o.values) };
  }
  const id = parsePk(table, o.id);
  if (o.op === 'update') {
    if (!table.canUpdate) throw new HttpError(403, `${table.label} cannot be edited.`);
    const row = await lockRow(client, table, id);
    if (!row) throw new HttpError(404, 'Row not found (it may have been deleted).');
    checkVersion(table, row, o.expectedVersion);
    const { cols, params, placeholders } = buildAssignments(table, o.values, { insert: false });
    const sets = cols.map((c, i) => `${c} = ${placeholders[i]}`);
    if (table.touchUpdatedAt) sets.push('"updated_at" = NOW()');
    params.push(id);
    const { rows } = await client.query(`UPDATE ${q(table.name)} SET ${sets.join(', ')} WHERE ${q(table.pk)} = $${params.length} RETURNING ${table.versioned ? 'row_version' : q(table.pk)}`, params);
    return { op: 'update', table: table.name, id, columns: Object.keys(o.values), newVersion: rows[0].row_version };
  }
  // delete
  if (!table.canDelete) throw new HttpError(403, `${table.label} rows cannot be deleted.`);
  const row = await lockRow(client, table, id);
  if (!row) throw new HttpError(404, 'Row not found (it may have been deleted already).');
  checkVersion(table, row, o.expectedVersion);
  await client.query(`DELETE FROM ${q(table.name)} WHERE ${q(table.pk)} = $1`, [id]);
  return { op: 'delete', table: table.name, id };
}

router.post('/transactions', validate({ body: transactionBody }), wrap(async (req, res) => {
  const { ops } = req.body;
  let results;
  try {
    results = await withTransaction(async (client) => {
      await client.query(`SET LOCAL statement_timeout = '15s'`);
      const done = [];
      for (let i = 0; i < ops.length; i += 1) {
        try {
          done.push(await applyOp(client, ops[i]));
        } catch (err) {
          const base = err instanceof HttpError ? err : pgToHttp(err) || err;
          if (base instanceof HttpError) {
            throw new HttpError(base.status, `${opLabel(i, ops[i])}: ${base.message}. Nothing was saved.`, { code: base.code, failedOp: i });
          }
          throw err;
        }
      }
      await store.audit({
        adminId: req.admin.id, username: req.admin.username, ip: req.ip, action: 'db.transaction',
        target: `${ops.length} operation(s)`,
        details: { ops: done.map(({ op: o, table, id, columns }) => ({ op: o, table, id, columns })) },
      }, client);
      return done;
    });
  } catch (err) {
    if (err instanceof HttpError && err.failedOp !== undefined) err.details = [{ field: `ops.${err.failedOp}`, message: err.message }];
    throw err;
  }
  reviewEvents.emit('change', { type: 'admin-change' }); // refresh any open dashboards
  res.json({ ok: true, committed: results.length, results });
}));

module.exports = router;
