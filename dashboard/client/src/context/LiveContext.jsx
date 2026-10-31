import { createContext, useContext } from 'react';
import { useLiveEvents } from '../hooks/useLiveEvents.js';

const LiveContext = createContext({ version: 0, live: false, lastEvent: null });

export function LiveProvider({ children }) {
  const value = useLiveEvents();
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive() {
  return useContext(LiveContext);
}
