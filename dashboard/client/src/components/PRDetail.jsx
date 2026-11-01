import { useEffect, useState } from 'react';
import { ArrowLeft, ExternalLink, Code2, ListChecks } from 'lucide-react';
import api from '../api.js';
import DiffViewer from './DiffViewer.jsx';

// Fetches GET /api/reviews/:id/findings, which returns { review, findings }.
export default function PRDetail({ reviewId, onBack }) {
  const [review, setReview] = useState(null);
  const [findings, setFindings] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [tab, setTab] = useState('findings');

  useEffect(() => {
    setLoading(true);
    api
      .getReview(reviewId)
      .then((data) => {
        setReview(data.review);
        setFindings(data.findings);
      })
      .catch((err) => setError(err.response?.data?.error || err.message))
      .finally(() => setLoading(false));
  }, [reviewId]);

  const title = review
    ? review.source_type === 'github_pr'
      ? `${review.repo_owner}/${review.repo_name} — PR #${review.pr_number}`
      : review.file_name
    : '';

  const githubUrl =
    review?.source_type === 'github_pr'
      ? `https://github.com/${review.repo_owner}/${review.repo_name}/pull/${review.pr_number}`
      : null;

  return (
    <div className="pr-detail">
      <button className="back-link" onClick={onBack}>
        <ArrowLeft size={15} /> Back to all reviews
      </button>

      {loading && <div className="state-msg">Loading findings…</div>}
      {error && <div className="state-msg state-error">Couldn't load review: {error}</div>}

      {!loading && !error && review && (
        <>
          <div className="detail-header">
            <div>
              <h2>{title}</h2>
              <div className="meta">
                {new Date(review.created_at).toLocaleDateString()} · {findings.length} finding
                {findings.length === 1 ? '' : 's'}
                {review.overall_score !== null && review.overall_score !== undefined && (
                  <> · Score {review.overall_score}</>
                )}
              </div>
            </div>
            <div className="detail-actions">
              {githubUrl && (
                <a className="btn-ghost-sm" href={githubUrl} target="_blank" rel="noreferrer">
                  <ExternalLink size={14} /> View on GitHub
                </a>
              )}
            </div>
          </div>

          <div className="detail-tabs">
            <button
              className={`detail-tab ${tab === 'findings' ? 'is-active' : ''}`}
              onClick={() => setTab('findings')}
            >
              <ListChecks size={14} /> Findings ({findings.length})
            </button>
            <button
              className={`detail-tab ${tab === 'diff' ? 'is-active' : ''}`}
              onClick={() => setTab('diff')}
            >
              <Code2 size={14} /> Changes
            </button>
          </div>

          {tab === 'findings' && (
            <div className="panel">
              {findings.length === 0 && (
                <div className="state-msg">No issues found in this review. 🎉</div>
              )}
              {findings.map((finding) => (
                <div className="finding-card" key={finding.id}>
                  <div className="finding-card-head">
                    <div className="file-path">{finding.file_path}</div>
                    <div className="finding-card-tags">
                      <span className={`severity-pill ${finding.severity}`}>{finding.severity}</span>
                      {finding.category && <span className="category-pill">{finding.category}</span>}
                    </div>
                  </div>
                  <p className="issue">{finding.issue}</p>
                  <p className="suggestion">{finding.suggestion}</p>
                </div>
              ))}
            </div>
          )}

          {tab === 'diff' && (
            <div className="panel">
              <DiffViewer diff={review.diff_text} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
