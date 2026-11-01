import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Plus, Pencil, Trash2, Search, ChevronLeft, ChevronRight, ArrowUp, ArrowDown, Check, Undo2, Lock, Database } from 'lucide-react';
import adminApi from '../../adminApi.js';
import { errorMessage } from '../../http.js';
import { Field, Notice, Spinner, Modal } from './ui.jsx';

// Database console.
//
// Edits are STAGED in the browser first and only written when you press "Commit":
// everything staged goes to the server as ONE transaction - all of it is saved, or (if
// any single change is rejected) none of it is. Rows carry a version number, so if
// someone else changed a row after you opened it, your change is refused instead of
// silently overwriting theirs.

const uid = () => Math.random().toString(36).slice(2);

function Cell({ col, value }) {
  if (value === null || value === undefined) return <span className="adm-null">null</span>;
  if (col.type === 'timestamp') return <>{new Date(value).toLocaleString()}</>;
  if (col.type === 'json') return <>{typeof value === 'string' ? value : JSON.stringify(value)}</>;
  if (col.name === 'severity') return <span className={`severity-pill ${value}`}>{value}</span>;
  return <>{String(value)}</>;
}

function opLabel(op, tableMeta) {
  const cols = op.values ? Object.keys(op.values).join(', ') : '';
  if (op.op === 'insert') return `Add to ${op.table}${cols ? ` (${cols})` : ''}`;
  if (op.op === 'update') return `Edit ${op.table} #${op.rowId} - ${cols}`;
  return `Delete ${op.table} #${op.rowId}`;
}

export default function DbManager() {
  const [meta, setMeta] = useState(null);
  const [table, setTable] = useState('reviews');
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState(null);
  const [dir, setDir] = useState('desc');
  const [search, setSearch] = useState('');
  const [q, setQ] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [pending, setPending] = useState([]);
  const [editor, setEditor] = useState(null);
  const [committing, setCommitting] = useState(false);
  const [commitError, setCommitError] = useState(null);
  const [flash, setFlash] = useState(null);

  const tableMeta = useMemo(() => meta?.tables.find((t) => t.name === table), [meta, table]);

  const loadMeta = useCallback(() => adminApi.dbTables().then(setMeta).catch((e) => setError(errorMessage(e))), []);
  useEffect(() => { loadMeta(); }, [loadMeta]);

  // debounce the search box
  useEffect(() => {
    const t = setTimeout(() => { setQ(search.trim()); setPage(1); }, 300);
    return () => clearTimeout(t);
  }, [search]);

  useEffect(() => {
    if (!tableMeta) return undefined;
    let cancelled = false;
    setLoading(true);
    adminApi
      .dbRows(table, { page, pageSize: 25, ...(sort ? { sort } : {}), dir, ...(q ? { q } : {}) })
      .then((r) => { if (!cancelled) { setData(r); setError(null); } })
      .catch((e) => { if (!cancelled) setError(errorMessage(e)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [table, tableMeta, page, sort, dir, q, reloadKey]);

  // Warn before closing the tab with uncommitted changes.
  useEffect(() => {
    if (!pending.length) return undefined;
    const warn = (e) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [pending.length]);

  const pendingByRow = useMemo(() => {
    const map = new Map();
    for (const op of pending) if (op.table === table && op.rowId !== undefined) map.set(String(op.rowId), op.op);
    return map;
  }, [pending, table]);

  const switchTable = (name) => {
    setTable(name); setPage(1); setSort(null); setDir('desc'); setSearch(''); setQ(''); setData(null); setError(null);
  };

  const toggleSort = (col) => {
    if (sort === col) setDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    else { setSort(col); setDir('asc'); }
    setPage(1);
  };

  // --- staging ---
  const stageUpdate = (row, values) => setPending((list) => {
    const rowId = row[tableMeta.pk];
    const existing = list.find((o) => o.op === 'update' && o.table === table && o.rowId === rowId);
    if (existing) return list.map((o) => (o === existing ? { ...o, values: { ...o.values, ...values } } : o));
    return [...list, { uid: uid(), op: 'update', table, rowId, expectedVersion: tableMeta.versioned ? row.row_version : undefined, values }];
  });
  const stageDelete = (row) => setPending((list) => {
    const rowId = row[tableMeta.pk];
    const rest = list.filter((o) => !(o.table === table && o.rowId === rowId));
    return [...rest, { uid: uid(), op: 'delete', table, rowId, expectedVersion: tableMeta.versioned ? row.row_version : undefined }];
  });
  const stageInsert = (values) => setPending((list) => [...list, { uid: uid(), op: 'insert', table, values }]);
  const unstage = (id) => setPending((list) => list.filter((o) => o.uid !== id));

  const commit = async () => {
    const deletes = pending.filter((o) => o.op === 'delete').length;
    if (deletes && !window.confirm(`This will permanently delete ${deletes} row${deletes === 1 ? '' : 's'} (and anything that depends on them). Commit the transaction?`)) return;
    setCommitting(true);
    setCommitError(null);
    setFlash(null);
    try {
      const ops = pending.map(({ op, table: t, rowId, expectedVersion, values }) => ({
        op, table: t,
        ...(op !== 'insert' ? { id: rowId } : {}),
        ...(expectedVersion !== undefined ? { expectedVersion } : {}),
        ...(values ? { values } : {}),
      }));
      const r = await adminApi.dbTransaction(ops);
      setPending([]);
      setFlash(`Committed ${r.committed} change${r.committed === 1 ? '' : 's'} in one transaction.`);
      setReloadKey((k) => k + 1);
      loadMeta();
    } catch (err) {
      setCommitError(errorMessage(err));
      if (err.response?.data?.code === 'version_conflict') setReloadKey((k) => k + 1);
    } finally {
      setCommitting(false);
    }
  };

  if (error && !meta) return <Notice kind="error">{error}</Notice>;
  if (!meta) return <div className="state-msg"><Spinner /></div>;

  const canWrite = tableMeta && (tableMeta.canUpdate || tableMeta.canDelete);
  const columns = tableMeta.columns;

  return (
    <div className="adm-stack">
      <div className="adm-table-tabs" role="tablist">
        {meta.tables.map((t) => (
          <button key={t.name} role="tab" aria-selected={t.name === table} className={`adm-chip ${t.name === table ? 'is-active' : ''}`} onClick={() => switchTable(t.name)}>
            {t.label} <span className="adm-count">{t.rowCount}</span>
            {!t.canCreate && !t.canUpdate && !t.canDelete && <Lock size={11} aria-label="read-only" />}
          </button>
        ))}
      </div>

      {pending.length > 0 && (
        <div className="panel adm-pending">
          <div className="adm-pending-head">
            <strong><Database size={14} /> Transaction - {pending.length} pending change{pending.length === 1 ? '' : 's'}</strong>
            <span className="adm-muted adm-small">Nothing is saved until you commit. All changes are applied together or not at all.</span>
          </div>
          <ul className="adm-pending-list">
            {pending.map((op) => (
              <li key={op.uid} className={`adm-op adm-op-${op.op}`}>
                <span className="adm-op-kind">{op.op}</span>
                <span className="adm-op-text">{opLabel(op)}</span>
                <button className="icon-btn" title="Remove from transaction" onClick={() => unstage(op.uid)}><Undo2 size={14} /></button>
              </li>
            ))}
          </ul>
          <Notice kind="error">{commitError}</Notice>
          <div className="adm-actions">
            <button className="btn-ghost-sm" onClick={() => { setPending([]); setCommitError(null); }} disabled={committing}>Discard all</button>
            <button className="btn-primary" onClick={commit} disabled={committing}>{committing ? <Spinner /> : <Check size={15} />} Commit transaction</button>
          </div>
        </div>
      )}
      <Notice kind="ok">{flash}</Notice>

      <div className="panel">
        <div className="panel-header">
          <div>
            <h3>{tableMeta.label}</h3>
            <p className="adm-muted adm-small adm-table-desc">{tableMeta.description}</p>
          </div>
          <div className="table-toolbar">
            <label className="search-box"><Search size={13} /><input placeholder="Search…" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search rows" /></label>
            {tableMeta.canCreate && <button className="btn-primary" onClick={() => setEditor({ mode: 'add' })}><Plus size={15} /> Add row</button>}
          </div>
        </div>

        <Notice kind="error">{error}</Notice>
        {loading && !data && <div className="state-msg"><Spinner /></div>}
        {data && (
          <>
            <div className="adm-grid-wrap" aria-busy={loading}>
              <table className="adm-table">
                <thead>
                  <tr>
                    {columns.map((c) => (
                      <th key={c.name} className={c.system ? 'adm-sys' : ''}>
                        <button className="adm-th" onClick={() => toggleSort(c.name)} title={`Sort by ${c.name}`}>
                          {c.name}
                          {(sort === c.name || (!sort && c.name === tableMeta.pk)) && (dir === 'asc' ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}
                        </button>
                      </th>
                    ))}
                    {canWrite && <th aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody>
                  {data.rows.length === 0 && <tr><td colSpan={columns.length + 1} className="adm-empty">No rows{q ? ' match your search' : ''}.</td></tr>}
                  {data.rows.map((row) => {
                    const state = pendingByRow.get(String(row[tableMeta.pk]));
                    return (
                      <tr key={row[tableMeta.pk]} className={state ? `adm-row-${state}` : ''}>
                        {columns.map((c) => (
                          <td key={c.name} className={c.system ? 'adm-sys' : ''} title={typeof row[c.name] === 'string' ? row[c.name] : undefined}>
                            <div className="adm-cell"><Cell col={c} value={row[c.name]} /></div>
                          </td>
                        ))}
                        {canWrite && (
                          <td className="adm-row-actions">
                            {state && <span className="badge adm-warn">{state === 'delete' ? 'to delete' : 'edited'}</span>}
                            {tableMeta.canUpdate && state !== 'delete' && <button className="icon-btn" title="Edit" onClick={() => setEditor({ mode: 'edit', row })}><Pencil size={15} /></button>}
                            {tableMeta.canDelete && state !== 'delete' && <button className="icon-btn danger" title="Delete" onClick={() => stageDelete(row)}><Trash2 size={15} /></button>}
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="adm-pager">
              <span className="adm-muted adm-small">{data.total} row{data.total === 1 ? '' : 's'} · page {data.page} of {data.pages}</span>
              <div>
                <button className="icon-btn" disabled={page <= 1} onClick={() => setPage((p) => p - 1)} aria-label="Previous page"><ChevronLeft size={16} /></button>
                <button className="icon-btn" disabled={page >= data.pages} onClick={() => setPage((p) => p + 1)} aria-label="Next page"><ChevronRight size={16} /></button>
              </div>
            </div>
          </>
        )}
      </div>

      {editor && (
        <RowEditor
          tableMeta={tableMeta}
          mode={editor.mode}
          row={editor.row}
          onClose={() => setEditor(null)}
          onSubmit={(values, fullRow) => {
            if (editor.mode === 'add') stageInsert(values);
            else stageUpdate(fullRow || editor.row, values); // fullRow carries the freshest version number
            setEditor(null);
            setFlash(null);
          }}
        />
      )}
    </div>
  );
}

// --- add / edit form, generated from the column list the server sent ------------------

const toInput = (col, v) => {
  if (v === null || v === undefined) return '';
  if (col.type === 'json') return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return String(v);
};

function RowEditor({ tableMeta, mode, row, onClose, onSubmit }) {
  const fields = tableMeta.columns.filter((c) => c.editable);
  const [full, setFull] = useState(mode === 'edit' ? null : {});
  const [form, setForm] = useState({});
  const [error, setError] = useState(null);
  const initial = useRef({});

  useEffect(() => {
    if (mode !== 'edit') {
      const init = Object.fromEntries(fields.map((c) => [c.name, c.type === 'enum' && c.required ? c.values[0] : '']));
      initial.current = init;
      setForm(init);
      return undefined;
    }
    let cancelled = false;
    adminApi
      .dbRow(tableMeta.name, row[tableMeta.pk])
      .then((r) => {
        if (cancelled) return;
        setFull(r.row);
        const init = Object.fromEntries(fields.map((c) => [c.name, toInput(c, r.row[c.name])]));
        initial.current = init;
        setForm(init);
      })
      .catch((e) => !cancelled && setError(errorMessage(e)));
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = (e) => {
    e.preventDefault();
    const values = {};
    for (const c of fields) {
      const now = form[c.name] ?? '';
      if (mode === 'edit' && now === initial.current[c.name]) continue;
      if (mode === 'add' && now === '' && !c.required) continue;
      if (c.type === 'int') values[c.name] = now === '' ? null : /^-?\d+$/.test(now.trim()) ? Number(now) : now;
      else values[c.name] = now;
    }
    if (mode === 'edit' && Object.keys(values).length === 0) { setError('You have not changed anything.'); return; }
    if (mode === 'add' && Object.keys(values).length === 0) { setError('Fill in at least one field.'); return; }
    onSubmit(values, full);
  };

  const set = (name, v) => setForm((f) => ({ ...f, [name]: v }));
  const title = mode === 'add' ? `Add to ${tableMeta.label}` : `Edit ${tableMeta.label} #${row[tableMeta.pk]}`;

  return (
    <Modal title={title} onClose={onClose} wide>
      {!full ? (
        <div className="state-msg">{error ? <Notice kind="error">{error}</Notice> : <Spinner />}</div>
      ) : (
        <form onSubmit={submit}>
          <div className="adm-form-grid">
            {fields.map((c) => (
              <Field key={c.name} label={`${c.name}${c.required ? ' *' : ''}`} hint={c.ref ? `id of a row in ${c.ref}` : c.max && c.type === 'text' && !c.long ? `up to ${c.max} characters` : undefined}>
                {c.type === 'enum' ? (
                  <select className="modal-input" value={form[c.name] ?? ''} onChange={(e) => set(c.name, e.target.value)}>
                    {!c.required && <option value="">(none)</option>}
                    {c.values.map((v) => <option key={v} value={v}>{v}</option>)}
                  </select>
                ) : c.long || c.type === 'json' ? (
                  <textarea className="modal-input adm-textarea" rows={c.type === 'json' ? 8 : 5} spellCheck={false} value={form[c.name] ?? ''} onChange={(e) => set(c.name, e.target.value)} />
                ) : (
                  <input className="modal-input" inputMode={c.type === 'int' ? 'numeric' : undefined} value={form[c.name] ?? ''} onChange={(e) => set(c.name, e.target.value)} />
                )}
              </Field>
            ))}
          </div>
          <p className="adm-muted adm-small">This stages the change. It is written to the database when you commit the transaction.</p>
          <Notice kind="error">{error}</Notice>
          <div className="adm-actions">
            <button type="button" className="btn-ghost-sm" onClick={onClose}>Cancel</button>
            <button className="btn-primary">{mode === 'add' ? 'Stage new row' : 'Stage changes'}</button>
          </div>
        </form>
      )}
    </Modal>
  );
}
