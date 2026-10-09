import { useCallback, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useCoachTrackingFeed } from './data/useCoachTrackingFeed';
import { demoCoachRows } from './data/demoCoachRows';
import CoachTrackingView from './presentation/CoachTrackingView';

export default function TrackCoachesWorkspace() {
  const [params, setParams] = useSearchParams();
  const demo = params.get('demo') === '1';
  const [nowMs, setNowMs] = useState(Date.now);
  const [sampleCreatedAt, setSampleCreatedAt] = useState(Date.now);
  // Demo positions have fixed receipt times per entry; they age truthfully.
  const samples = useMemo(() => demo ? demoCoachRows(sampleCreatedAt) : null, [demo, sampleCreatedAt]);
  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 15_000);
    return () => clearInterval(timer);
  }, []);
  const onDemoChange = useCallback(value => {
    if (value) { const createdAt = Date.now(); setSampleCreatedAt(createdAt); setNowMs(createdAt); }
    setParams(previous => {
    const next = new URLSearchParams(previous);
    if (value) next.set('demo', '1'); else next.delete('demo');
    next.delete('tour');
    next.delete('q');
    next.delete('status');
    return next;
    }, { replace: true });
  }, [setParams]);
  if (!demo) return <LiveTrackingView nowMs={nowMs} onDemoChange={onDemoChange} />;
  const feed = { rows: samples, loaded: true, complete: true, connected: true,
    status: { schemaVersion: 1, state: 'ready' }, clockOffset: 0, error: null };
  return <CoachTrackingView feed={feed} nowMs={nowMs} demo onDemoChange={onDemoChange} />;
}

function LiveTrackingView({ nowMs, onDemoChange }) {
  const feed = useCoachTrackingFeed();
  return <CoachTrackingView feed={feed} nowMs={nowMs + feed.clockOffset} onDemoChange={onDemoChange} />;
}
