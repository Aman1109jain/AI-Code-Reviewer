import { useEffect, useMemo, useState } from 'react';
import { Search, X, GitPullRequest, FileUp, Code2, Github } from 'lucide-react';
import api from '../api.js';
import { useLive } from '../context/LiveContext.jsx';
import { useGithub } from '../context/GithubContext.jsx';
import StatCards from './StatCards.jsx';
import TrendsChart from './TrendsChart.jsx';

const SOURCE_META = {
  github_pr: { label: 'PR', icon: GitPullRequest },
  upload: { label: 'Upload', icon: FileUp },
  quick_check: { label: 'Quick check', icon: Code2 },
};

function ScoreBadge({ score }) {
  if (score === null || score === undefined) return <span className="cell-null">—</span>;
  const tone = score >= 80 ? 'good' : score >= 50 ? 'mid' : 'bad';
  return <span className={`score-badge tone-${tone}`}>{score}</span>;
}

export default function Dashboard({ onSelectReview, activeRepo, onClearRepoFilter, pendingScroll, onScrollHandled }) {
  const [reviews, setReviews] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [search, setSearch] = useState('');
  const { version } = useLive();
  const { loading: ghLoading, connected, connect, authError, dismissAuthError } = useGithub();

  useEffect(() => {
    setLoading(true);
    api
      .getReviews()
      .then(setReviews)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [version]);

  useEffect(() => {
    if (pendingScroll === 'chart') {
      const el = document.getElementById('findings-chart');
      if (el) {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        onScrollHandled?.();
      }
    }
  }, [pendingScroll, onScrollHandled, loading]);

  const nameFor = (review) => {
    if (review.source_type === 'github_pr') return `${review.repo_owner}/${review.repo_name} #${review.pr_number}`;
    return review.file_name || '—';
  };

  const filtered = useMemo(() => {
    return reviews.filter((r) => {
      if (activeRepo) {
        const full = `${r.repo_owner}/${r.repo_name}`;
        if (full !== activeRepo) return false;
      }
      if (!search.trim()) return true;
      const haystack = `${nameFor(r)} ${r.source_type}`.toLowerCase();
      return haystack.includes(search.trim().toLowerCase());
    });
  }, [reviews, search, activeRepo]);

  return (
    <div className="dashboard">
      {authError && (
        <div className="state-msg state-error connect-error">
          {authError}
          <button className="btn-ghost-sm" onClick={dismissAuthError}>Dismiss</button>
        </div>
      )}

      {!ghLoading && !connected && (
        <div className="panel connect-card">
          <div className="connect-card-text">
            <h3>Connect your GitHub account</h3>
            <p>
              Connect GitHub to see your repos and get AI reviews on your pull requests.
              You only need to do this once on this browser.
            </p>
          </div>
          <button className="btn-primary" onClick={connect}>
            <Github size={16} /> Connect GitHub
          </button>
        </div>
      )}

      <StatCards reviews={reviews} />

      <div className="panel">
        <div className="panel-header">
          <h3>Reviews</h3>
          <div className="table-toolbar">
            {activeRepo && (
              <button className="chip chip-active" onClick={onClearRepoFilter}>
                {activeRepo} <X size={12} />
              </button>
            )}
            <div className="search-box">
              <Search size={14} />
              <input
                placeholder="Search reviews…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </div>
          </div>
        </div>

        {loading && <div className="state-msg">Loading reviews…</div>}
        {error && <div className="state-msg state-error">Couldn't load reviews: {error}</div>}
        {!loading && !error && filtered.length === 0 && (
          <div className="state-msg">
            {reviews.length === 0
              ? 'No reviews yet. Open a PR on a connected repo, or try Quick Check.'
              : 'No reviews match your search.'}
          </div>
        )}

        {!loading && !error && filtered.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Source</th>
                <th>Repo / File</th>
                <th>Date</th>
                <th>Score</th>
                <th>Findings</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((review) => {
                const meta = SOURCE_META[review.source_type] || SOURCE_META.upload;
                const Icon = meta.icon;
                return (
                  <tr key={review.id} onClick={() => onSelectReview(review.id)}>
                    <td>
                      <span className={`badge ${review.source_type}`}>
                        <Icon size={12} /> {meta.label}
                      </span>
                    </td>
                    <td className="mono-cell">{nameFor(review)}</td>
                    <td className="muted-cell">{new Date(review.created_at).toLocaleDateString()}</td>
                    <td><ScoreBadge score={review.overall_score} /></td>
                    <td>
                      <span className={`finding-count ${review.finding_count > 0 ? 'has-findings' : ''}`}>
                        {review.finding_count}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      <TrendsChart />
    </div>
  );
}
