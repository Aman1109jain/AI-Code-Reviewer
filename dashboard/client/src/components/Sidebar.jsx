import { lazy, Suspense, useState } from 'react';
import {
  LayoutGrid,
  GitBranch,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  ChevronRight,
  Star,
  Lock,
  RefreshCw,
  Code2,
  BarChart3,
  Github,
} from 'lucide-react';
import { useGithub } from '../context/GithubContext.jsx';
// The charting library is only downloaded once someone is connected and has data to chart.
const MiniChart = lazy(() => import('./MiniChart.jsx'));

export default function Sidebar({ collapsed, onToggle, route, onNavigate, activeRepo, onFilterRepo, onGoToChart }) {
  const { connected, loading, repos, reposLoading, connect } = useGithub();
  const [reposOpen, setReposOpen] = useState(true);

  const navItems = [
    { key: 'dashboard', label: 'Dashboard', icon: LayoutGrid, path: '/' },
    { key: 'review', label: 'Quick Check', icon: Code2, path: '/review' },
  ];

  return (
    <aside className={`sidebar ${collapsed ? 'is-collapsed' : ''}`}>
      <div className="sidebar-top">
        <button
          className="icon-btn sidebar-toggle"
          onClick={onToggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-label="Toggle sidebar"
        >
          {collapsed ? <ChevronsRight size={18} /> : <ChevronsLeft size={18} />}
        </button>
        {!collapsed && <span className="sidebar-brand">Menu</span>}
      </div>

      <nav className="sidebar-nav">
        {navItems.map(({ key, label, icon: Icon, path }) => {
          const active = route === path;
          return (
            <button
              key={key}
              className={`sidebar-nav-item ${active ? 'is-active' : ''}`}
              onClick={() => onNavigate(path)}
              title={label}
            >
              <Icon size={18} />
              {!collapsed && <span>{label}</span>}
            </button>
          );
        })}
      </nav>

      {!collapsed && (
        <>
          <button className="sidebar-section-label sidebar-section-toggle" onClick={() => setReposOpen((o) => !o)}>
            {reposOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            <GitBranch size={13} />
            <span>Your repos</span>
            {reposLoading && <RefreshCw size={12} className="spin" />}
          </button>

          {reposOpen && (
            <div className="sidebar-repos">
              {!connected && !loading && (
                <button className="btn-primary sidebar-connect" onClick={connect}>
                  <Github size={14} /> Connect GitHub
                </button>
              )}
              {!connected && !loading && <div className="sidebar-empty">Connect to see your repos.</div>}
              {connected && !reposLoading && repos.length === 0 && (
                <div className="sidebar-empty">No repos found for this account.</div>
              )}
              {connected &&
                repos.map((repo) => (
                  <div
                    key={repo.id}
                    className={`sidebar-repo ${activeRepo === repo.fullName ? 'is-active' : ''}`}
                    title={repo.description || repo.fullName}
                  >
                    <button
                      className="sidebar-repo-name-btn"
                      onClick={() => onFilterRepo(activeRepo === repo.fullName ? null : repo.fullName)}
                    >
                      <span className="sidebar-repo-name">{repo.name}</span>
                    </button>
                    {repo.private && <Lock size={11} className="sidebar-repo-lock" />}
                    {repo.stars > 0 && (
                      <span className="sidebar-repo-stars">
                        <Star size={11} /> {repo.stars}
                      </span>
                    )}
                  </div>
                ))}
              {connected && (
                <div className="sidebar-empty" title="In the repo's GitHub settings, add a webhook for Pull requests events (content type application/json) using your webhook URL and the same secret as GITHUB_WEBHOOK_SECRET in .env.">
                  Add a webhook on a repo (GitHub settings) to review its PRs.
                </div>
              )}
            </div>
          )}

          <button className="sidebar-section-label sidebar-section-toggle" onClick={onGoToChart} title="Jump to the full chart">
            <BarChart3 size={13} />
            <span>Findings by severity</span>
          </button>
          <div className="sidebar-chart">
            {connected ? (
              <Suspense fallback={<div className="sidebar-empty">Loading…</div>}>
                <MiniChart />
              </Suspense>
            ) : (
              <div className="sidebar-empty">No findings yet.</div>
            )}
          </div>
        </>
      )}
    </aside>
  );
}
