import { createContext, useContext } from 'react';
import { useLiveEvents } from '../hooks/useLiveEvents.js';
import { useGithub } from './GithubContext.jsx';

const LiveContext = createContext({ version: 0, live: false, lastEvent: null });

export function LiveProvider({ children }) {
  const { connected } = useGithub();
  const value = useLiveEvents(Boolean(connected));
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive() {
  return useContext(LiveContext);
}
