import { useEffect, useState } from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import api from '../api.js';
import { useLive } from '../context/LiveContext.jsx';

const COLORS = {
  blocking: 'var(--blocking)',
  warning: 'var(--warning)',
  nitpick: 'var(--nitpick)',
};

export default function MiniChart() {
  const [data, setData] = useState([]);
  const { version } = useLive();

  useEffect(() => {
    api.getSeverityCounts().then(setData).catch(() => setData([]));
  }, [version]);

  const total = data.reduce((sum, d) => sum + d.count, 0);

  if (total === 0) {
    return <div className="sidebar-empty">No findings yet.</div>;
  }

  return (
    <div className="mini-chart">
      <ResponsiveContainer width="100%" height={110}>
        <PieChart>
          <Pie
            data={data}
            dataKey="count"
            nameKey="severity"
            innerRadius={30}
            outerRadius={48}
            paddingAngle={3}
            stroke="none"
          >
            {data.map((entry) => (
              <Cell key={entry.severity} fill={COLORS[entry.severity] || 'var(--accent)'} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: 'var(--panel)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              fontSize: 12,
            }}
          />
        </PieChart>
      </ResponsiveContainer>
      <div className="mini-chart-legend">
        {data.map((d) => (
          <div key={d.severity} className="mini-chart-legend-item">
            <span className="dot" style={{ background: COLORS[d.severity] || 'var(--accent)' }} />
            {d.severity} · {d.count}
          </div>
        ))}
      </div>
    </div>
  );
}
