import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import api from '../api.js';

const GithubContext = createContext(null);

const ERROR_MESSAGES = {
  access_denied: 'GitHub connection was cancelled. You can try again any time.',
  invalid_state: 'That sign-in attempt expired. Please click "Connect GitHub" again.',
  token_exchange_failed: 'GitHub didn\'t accept the sign-in. Please try again.',
  not_configured: 'GitHub sign-in isn\'t set up on this server yet.',
  github_error: 'GitHub reported a problem. Please try again.',
  server_error: 'Something went wrong while connecting. Please try again.',
};

// Each visitor connects their own GitHub account with the "Connect GitHub"
// button (they paste their own token in a dialog; no server setup needed). The server remembers them with a long-lived cookie, so on
// later visits they're recognised automatically — no token, no second login.
export function GithubProvider({ children }) {
  const [status, setStatus] = useState({ loading: true, connected: false });
  const [repos, setRepos] = useState([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [connectOpen, setConnectOpen] = useState(false);

  // The server sends the browser back here with ?github_error=... if sign-in failed.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const code = params.get('github_error');
    if (code) {
      setAuthError(ERROR_MESSAGES[code] || ERROR_MESSAGES.github_error);
      params.delete('github_error');
      const qs = params.toString();
      window.history.replaceState({}, '', window.location.pathname + (qs ? `?${qs}` : '') + window.location.hash);
    }
  }, []);

  const refreshStatus = useCallback(() => {
    api
      .getGithubStatus()
      .then((data) => setStatus({ loading: false, ...data }))
      .catch((err) => setStatus({ loading: false, connected: false, reason: err.message }));
  }, []);

  useEffect(() => {
    refreshStatus();
  }, [refreshStatus]);

  useEffect(() => {
    if (!status.connected) {
      setRepos([]);
      return;
    }
    setReposLoading(true);
    api
      .getGithubRepos()
      .then(setRepos)
      .catch((err) => {
        setRepos([]);
        // Token was revoked on GitHub's side — fall back to the "Connect" state.
        if (err.response?.status === 401) {
          setAuthError('Your GitHub connection expired. Please connect again.');
          setStatus((s) => ({ ...s, connected: false }));
        }
      })
      .finally(() => setReposLoading(false));
  }, [status.connected]);

  // Opens the "Connect GitHub" dialog (see ConnectModal).
  const connect = useCallback(() => setConnectOpen(true), []);

  // Optional one-click route, only offered when the server has an OAuth app set up.
  const connectWithOAuth = useCallback(() => {
    const here = window.location.pathname + window.location.search;
    window.location.href = api.githubLoginUrl(here);
  }, []);

  // Paste-a-token route. Throws with a readable message on failure.
  const connectWithToken = useCallback(
    async (token) => {
      try {
        await api.connectWithToken(token);
      } catch (err) {
        throw new Error(err.response?.data?.error || 'Could not connect. Please try again.');
      }
      setAuthError(null);
      setConnectOpen(false);
      refreshStatus();
    },
    [refreshStatus]
  );

  const disconnect = useCallback(async () => {
    try {
      await api.githubLogout();
    } finally {
      setStatus((s) => ({ loading: false, connected: false, oauthConfigured: s.oauthConfigured }));
      setRepos([]);
    }
  }, []);

  return (
    <GithubContext.Provider
      value={{
        ...status,
        repos,
        reposLoading,
        authError,
        dismissAuthError: () => setAuthError(null),
        refreshStatus,
        connect,
        connectOpen,
        closeConnect: () => setConnectOpen(false),
        connectWithOAuth,
        connectWithToken,
        disconnect,
      }}
    >
      {children}
    </GithubContext.Provider>
  );
}

export function useGithub() {
  return useContext(GithubContext);
}
