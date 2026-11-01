import { useEffect, useState } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Cell,
  CartesianGrid,
} from 'recharts';
import api from '../api.js';
import { useLive } from '../context/LiveContext.jsx';
import { useGithub } from '../context/GithubContext.jsx';

const COLORS = {
  blocking: '#fb5a7e',
  warning: '#ffb454',
  nitpick: '#8b93ac',
};

const LABELS = {
  blocking: 'Blocking',
  warning: 'Warning',
  nitpick: 'Nitpick',
};

export default function TrendsChart() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const { version } = useLive();
  const { connected } = useGithub();

  useEffect(() => {
    if (!connected) {
      setData([]);
      setLoading(false);
      return;
    }
    api
      .getSeverityCounts()
      .then((d) => setData(d.map((x) => ({ ...x, label: LABELS[x.severity] || x.severity }))))
      .catch(() => setData([]))
      .finally(() => setLoading(false));
  }, [version, connected]);

  return (
    <div className="panel chart-panel" id="findings-chart">
      <div className="panel-header">
        <h3>Findings by severity</h3>
        <span className="panel-header-hint">updates live</span>
      </div>
      {loading && <div className="state-msg">Loading chart…</div>}
      {!loading && data.length === 0 && (
        <div className="state-msg">No findings yet — they'll show up here once a PR is reviewed.</div>
      )}
      {!loading && data.length > 0 && (
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
            <defs>
              {data.map((entry) => (
                <linearGradient key={entry.severity} id={`grad-${entry.severity}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={COLORS[entry.severity] || '#7c6cff'} stopOpacity={0.95} />
                  <stop offset="100%" stopColor={COLORS[entry.severity] || '#7c6cff'} stopOpacity={0.55} />
                </linearGradient>
              ))}
            </defs>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" vertical={false} />
            <XAxis dataKey="label" stroke="var(--muted)" fontSize={12} tickLine={false} axisLine={false} />
            <YAxis stroke="var(--muted)" fontSize={12} allowDecimals={false} tickLine={false} axisLine={false} />
            <Tooltip
              cursor={{ fill: 'var(--hover)' }}
              contentStyle={{
                background: 'var(--panel)',
                border: '1px solid var(--border)',
                borderRadius: 10,
                fontSize: 13,
              }}
            />
            <Bar dataKey="count" radius={[8, 8, 0, 0]} maxBarSize={64}>
              {data.map((entry) => (
                <Cell key={entry.severity} fill={`url(#grad-${entry.severity})`} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      )}
    </div>
  );
}
