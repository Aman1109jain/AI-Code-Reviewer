import { FileSearch, AlertTriangle, ShieldAlert, GitPullRequest } from 'lucide-react';

export default function StatCards({ reviews }) {
  const totalReviews = reviews.length;
  const totalFindings = reviews.reduce((sum, r) => sum + (r.finding_count || 0), 0);
  const prReviews = reviews.filter((r) => r.source_type === 'github_pr').length;
  const avgFindings = totalReviews ? (totalFindings / totalReviews).toFixed(1) : '0';

  const cards = [
    { label: 'Total reviews', value: totalReviews, icon: FileSearch, tone: 'violet' },
    { label: 'PRs reviewed', value: prReviews, icon: GitPullRequest, tone: 'teal' },
    { label: 'Total findings', value: totalFindings, icon: AlertTriangle, tone: 'amber' },
    { label: 'Avg findings / review', value: avgFindings, icon: ShieldAlert, tone: 'rose' },
  ];

  return (
    <div className="stat-cards">
      {cards.map(({ label, value, icon: Icon, tone }) => (
        <div key={label} className={`stat-card tone-${tone}`}>
          <div className="stat-card-icon">
            <Icon size={18} />
          </div>
          <div>
            <div className="stat-card-value">{value}</div>
            <div className="stat-card-label">{label}</div>
          </div>
        </div>
      ))}
    </div>
  );
}
