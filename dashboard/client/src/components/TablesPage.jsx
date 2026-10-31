import { useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import api from '../api.js';
import { useLive } from '../context/LiveContext.jsx';

function formatCell(value) {
  if (value === null || value === undefined) return <span className="cell-null">—</span>;
  if (typeof value === 'string' && value.length > 80) {
    return <span title={value}>{value.slice(0, 80)}…</span>;
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  return String(value);
}

export default function TablesPage() {
  const [tableNames, setTableNames] = useState([]);
  const [activeTable, setActiveTable] = useState(null);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const { version } = useLive();

  useEffect(() => {
    api
      .getTableNames()
      .then((names) => {
        setTableNames(names);
        setActiveTable((prev) => prev || names[0]);
      })
      .catch((err) => setError(err.message));
  }, []);

  useEffect(() => {
    if (!activeTable) return;
    setLoading(true);
    api
      .getTable(activeTable)
      .then(setData)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [activeTable, version]);

  return (
    <div className="tables-page">
      <div className="panel">
        <div className="panel-header">
          <h3>Database tables</h3>
          <span className="panel-header-hint">
            <RefreshCw size={12} className={loading ? 'spin' : ''} /> live — updates as PRs are reviewed
          </span>
        </div>

        <div className="table-tabs">
          {tableNames.map((name) => (
            <button
              key={name}
              className={`detail-tab ${activeTable === name ? 'is-active' : ''}`}
              onClick={() => setActiveTable(name)}
            >
              {name}
            </button>
          ))}
        </div>

        {error && <div className="state-msg state-error">{error}</div>}
        {loading && <div className="state-msg">Loading {activeTable}…</div>}

        {!loading && data && data.rows.length === 0 && (
          <div className="state-msg">No rows in "{activeTable}" yet.</div>
        )}

        {!loading && data && data.rows.length > 0 && (
          <div className="table-scroll">
            <table className="raw-table">
              <thead>
                <tr>
                  {data.columns.map((col) => (
                    <th key={col}>{col}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.rows.map((row, i) => (
                  <tr key={row.id ?? i}>
                    {data.columns.map((col) => (
                      <td key={col} className="mono-cell">
                        {formatCell(row[col])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
