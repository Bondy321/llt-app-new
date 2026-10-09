import { useCallback, useEffect, useState } from 'react';
import { db } from '../../../firebase';
import { subscribeCoachTracking } from '../../../services/coachTrackingService';

const initial = { rows: {}, status: null, loaded: false, connected: false, clockOffset: 0,
  complete: false, capped: false, error: null };

export function useCoachTrackingFeed(enabled = true) {
  const [feed, setFeed] = useState(initial);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    let failed = false;
    let receivedRows = false;
    const patch = value => { if (active) setFeed(previous => ({ ...previous, ...value })); };
    const unsubscribe = subscribeCoachTracking(db, {
      onRows: value => { if (!failed) { receivedRows = true; patch({ ...value, loaded: true }); } },
      onStatus: status => { if (!failed) patch({ status }); },
      onConnection: connected => patch({ connected }),
      onClock: clockOffset => patch({ clockOffset }),
      // Permission/subscription errors clear cached rows. Connectivity loss
      // alone may retain stale, explicitly labelled information.
      onError: error => { failed = true; patch({ error, rows: {}, loaded: true, complete: false }); },
    });
    const timer = setTimeout(() => {
      if (!receivedRows && !failed) {
        failed = true;
        patch({ error: 'The tracking feed did not respond. Check your connection and retry.', rows: {}, loaded: true, complete: false });
      }
    }, 25_000);
    return () => { active = false; clearTimeout(timer); unsubscribe(); };
  }, [attempt, enabled]);
  const retry = useCallback(() => { setFeed(initial); setAttempt(value => value + 1); }, []);
  return { ...feed, retry };
}
