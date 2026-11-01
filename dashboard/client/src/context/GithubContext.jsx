import { createContext, useContext, useEffect, useState, useCallback } from 'react';
import api from '../api.js';

const GithubContext = createContext(null);

// Each visitor connects their own GitHub account with the "Connect GitHub" button
// (they paste their own token in a dialog). The server remembers them with a session
// cookie, so on later visits they're recognised automatically.
export function GithubProvider({ children }) {
  const [status, setStatus] = useState({ loading: true, connected: false });
  const [repos, setRepos] = useState([]);
  const [reposLoading, setReposLoading] = useState(false);
  const [authError, setAuthError] = useState(null);
  const [connectOpen, setConnectOpen] = useState(false);

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
        // Token was revoked on GitHub's side - fall back to the "Connect" state.
        if (err.response?.status === 401) {
          setAuthError('Your GitHub connection expired. Please connect again.');
          setStatus((s) => ({ ...s, connected: false }));
        }
      })
      .finally(() => setReposLoading(false));
  }, [status.connected]);

  const connect = useCallback(() => setConnectOpen(true), []);

  // Throws with a readable message on failure.
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
      setStatus({ loading: false, connected: false });
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
