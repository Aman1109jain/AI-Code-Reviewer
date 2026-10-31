import { useEffect, useState, useCallback } from 'react';

// A tiny History-API router. No dependency needed for a handful of routes.
//
// Why this fixes the "mouse back button leaves the app" problem:
// the old dashboard never called history.pushState, so as far as the browser
// was concerned the whole app was a single page. The first "back" therefore
// popped the browser's real history stack — e.g. back to whatever tab/page
// you'd visited before opening the dashboard. By pushing a history entry
// every time you navigate inside the app (open a review, go to Tables, go
// back to the list), the browser back/forward buttons move between *those*
// app states first, exactly like a normal multi-page site.

function normalize(path) {
  return path.startsWith('/') ? path : `/${path}`;
}

export function navigate(path, { replace = false } = {}) {
  const target = normalize(path);
  if (target === window.location.pathname) return;
  if (replace) {
    window.history.replaceState({}, '', target);
  } else {
    window.history.pushState({}, '', target);
  }
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function useRoute() {
  const [path, setPath] = useState(window.location.pathname);

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const go = useCallback((p, opts) => navigate(p, opts), []);

  return [path, go];
}
