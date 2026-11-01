import { useEffect, useState } from 'react';

// Live updates (server-sent events). Only opened for a connected GitHub user: the
// server rejects anonymous streams, and only sends this user's own events.
export function useLiveEvents(enabled) {
  const [version, setVersion] = useState(0);
  const [live, setLive] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);

  useEffect(() => {
    if (!enabled) {
      setLive(false);
      return undefined;
    }
    const source = new EventSource('/api/events');

    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    source.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        if (payload.type === 'connected') {
          setLive(true);
          return;
        }
        setLastEvent(payload);
        setVersion((v) => v + 1);
      } catch {
        // ignore malformed frames
      }
    };

    return () => source.close();
  }, [enabled]);

  return { version, live, lastEvent };
}
