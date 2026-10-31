import { useEffect, useState } from 'react';
import Sidebar from './components/Sidebar.jsx';
import Topbar from './components/Topbar.jsx';
import Dashboard from './components/Dashboard.jsx';
import PRDetail from './components/PRDetail.jsx';
import TablesPage from './components/TablesPage.jsx';
import QuickReview from './components/QuickReview.jsx';
import ConnectModal from './components/ConnectModal.jsx';
import { useRoute } from './utils/router.js';
import { useLive } from './context/LiveContext.jsx';

function parseReviewId(path) {
  const match = path.match(/^\/reviews\/(\d+)$/);
  return match ? match[1] : null;
}

export default function App() {
  const [path, go] = useRoute();
  const { live } = useLive();
  const [collapsed, setCollapsed] = useState(() => window.innerWidth < 900);
  const [activeRepo, setActiveRepo] = useState(null);
  const [pendingScroll, setPendingScroll] = useState(null);

  useEffect(() => {
    if (window.innerWidth < 900) setCollapsed(true);
  }, [path]);

  const reviewId = parseReviewId(path);
  const route = reviewId ? '/reviews/:id' : path;

  const openReview = (id) => go(`/reviews/${id}`);
  const closeReview = () => go('/');

  const goToChart = () => {
    setPendingScroll('chart');
    if (path !== '/') go('/');
  };

  return (
    <div className="app-shell">
      <Topbar onToggleSidebar={() => setCollapsed((c) => !c)} live={live} onNavigate={go} />
      <div className="app-body">
        <Sidebar
          collapsed={collapsed}
          onToggle={() => setCollapsed((c) => !c)}
          route={path.startsWith('/reviews/') ? '/' : path}
          onNavigate={go}
          activeRepo={activeRepo}
          onFilterRepo={(repo) => {
            setActiveRepo(repo);
            if (path !== '/') go('/');
          }}
          onGoToChart={goToChart}
        />
        <main className="app-main">
          {reviewId && <PRDetail reviewId={reviewId} onBack={closeReview} />}
          {!reviewId && path === '/tables' && <TablesPage />}
          {!reviewId && path === '/review' && <QuickReview onOpenReview={openReview} />}
          {!reviewId && path !== '/tables' && path !== '/review' && (
            <Dashboard
              onSelectReview={openReview}
              activeRepo={activeRepo}
              onClearRepoFilter={() => setActiveRepo(null)}
              pendingScroll={pendingScroll}
              onScrollHandled={() => setPendingScroll(null)}
            />
          )}
        </main>
      </div>
      <ConnectModal />
    </div>
  );
}
