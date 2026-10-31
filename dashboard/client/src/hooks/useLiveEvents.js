import { useEffect, useRef, useState } from "react";
import api from "../api.js";

export function useLiveEvents() {
  const [version, setVersion] = useState(0);
  const [live, setLive] = useState(false);
  const [lastEvent, setLastEvent] = useState(null);
  const sourceRef = useRef(null);

  useEffect(() => {
    const source = new EventSource(`${api.API_BASE}/api/events`);
    sourceRef.current = source;

    source.onopen = () => setLive(true);
    source.onerror = () => setLive(false);
    source.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        if (payload.type === "connected") {
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
  }, []);

  return { version, live, lastEvent };
}
