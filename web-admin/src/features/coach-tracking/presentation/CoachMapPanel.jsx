import { useEffect, useRef, useState } from 'react';
import { Alert, Button, Group, Text } from '@mantine/core';
import { createCoachMap } from '../map/createCoachMap';

export default function CoachMapPanel({ rows, selectedTour, onSelect, showPickups, sourceKey }) {
  const element = useRef(null);
  const renderer = useRef(null);
  const selectRef = useRef(onSelect);
  const [tileStatus, setTileStatus] = useState('loading');
  const [failed, setFailed] = useState(false);
  const canFocus = rows.some(row => row.tourId === selectedTour && (row.position || (showPickups && row.pickup)));
  useEffect(() => { selectRef.current = onSelect; }, [onSelect]);
  useEffect(() => {
    let active = true;
    try {
      renderer.current = createCoachMap(element.current, { onSelect: value => selectRef.current(value),
        onTileStatus: value => { if (active) setTileStatus(value); } });
    } catch { queueMicrotask(() => { if (active) setFailed(true); }); }
    return () => { active = false; renderer.current?.destroy(); renderer.current = null; };
  }, []);
  useEffect(() => { renderer.current?.update(rows, selectedTour, showPickups); }, [rows, selectedTour, showPickups, sourceKey]);
  useEffect(() => { if (selectedTour) renderer.current?.focus(selectedTour); }, [selectedTour, sourceKey]);
  return <section className="coach-map-panel" aria-label="Coach location map">
    <Group justify="space-between" px="md" py="sm" className="coach-map-toolbar">
      <div><Text fw={700} size="sm">Tour positions</Text><Text size="xs" c="dimmed">{rows.filter(row => row.position).length} live or last-known positions · scroll the page; use + / − to zoom</Text></div>
      <Group gap="xs">
        {selectedTour ? <Button variant="light" size="xs" onClick={() => renderer.current?.focus(selectedTour)} disabled={failed || !canFocus}>Focus selected tour</Button> : null}
        <Button variant="default" size="xs" onClick={() => renderer.current?.fit()} disabled={failed}>Show all positions</Button>
      </Group>
    </Group>
    {tileStatus === 'error' ? <Alert color="orange" title="Map tiles are unavailable" role="status" radius={0}>
      Positions and the tour list remain available. <Button size="compact-xs" variant="subtle" onClick={() => renderer.current?.retryTiles()}>Retry map tiles</Button>
    </Alert> : null}
    {failed ? <Alert color="orange" title="The map could not start">Use the tour list to inspect positions, timestamps and accuracy.</Alert> : null}
    <div ref={element} className="coach-map-canvas" aria-label="Interactive coach map. Tour selection is also available in the list." />
    <div className="coach-map-key" aria-label="Map key">
      <span><i className="coach-key-live" />Live</span><span><i className="coach-key-recent" />Recent</span>
      <span><i className="coach-key-stale" />Stale / approximate</span>{showPickups ? <span><i className="coach-key-pickup" />P · Fixed pickup</span> : null}
    </div>
  </section>;
}
