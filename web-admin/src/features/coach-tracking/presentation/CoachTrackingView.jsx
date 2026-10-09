import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { Badge, Button, Checkbox, Group, Loader, Paper, SegmentedControl, Select, Stack, Text, TextInput, Title } from '@mantine/core';
import { IconBus, IconMap2, IconSearch, IconRefresh, IconList, IconPresentation } from '@tabler/icons-react';
import { buildCoachRows, filterCoachRows } from '../../../utils/coachTrackingPresentation';
import CoachMapPanel from './CoachMapPanel';
import CoachTourDetails from './CoachTourDetails';
import CoachFeedAlerts from './CoachFeedAlerts';
import CoachTourList, { COACH_LIST_PAGE_SIZE } from './CoachTourList';
import '../coachTracking.css';

const statusOptions = [
  { value: 'all', label: 'All tours' }, { value: 'live', label: 'Live positions' },
  { value: 'recent', label: 'Recent positions' }, { value: 'stale', label: 'Stale positions' },
  { value: 'low_accuracy', label: 'Low accuracy positions' },
  { value: 'attention', label: 'Recent, stale or low accuracy' }, { value: 'unavailable', label: 'No live position' },
];


export default function CoachTrackingView({ feed, nowMs, demo = false, onDemoChange }) {
  const [params, setParams] = useSearchParams();
  const [page, setPage] = useState(1);
  const detailsElement = useRef(null);
  const search = (params.get('q') || '').slice(0, 100);
  const status = statusOptions.some(option => option.value === params.get('status')) ? params.get('status') : 'all';
  const view = params.get('view') === 'list' ? 'list' : 'map';
  const pickups = params.get('pickups') === '1';
  const selectedTour = params.get('tour') || null;
  const rows = useMemo(() => buildCoachRows(feed.error ? {} : feed.rows, nowMs, { connected: demo || feed.connected }), [demo, feed.connected, feed.error, feed.rows, nowMs]);
  const filtered = useMemo(() => filterCoachRows(rows, { search, status }), [rows, search, status]);
  const selected = filtered.find(row => row.tourId === selectedTour) || null;
  const selectedId = selected?.tourId;
  useEffect(() => { if (selectedId) detailsElement.current?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' }); }, [selectedId, view]);
  const rawCount = Object.values(feed.rows || {}).filter(value => value?.listed !== false && value?.deleted !== true).length;
  const invalidRows = feed.error ? 0 : rawCount - rows.length;
  const currentPage = Math.min(page, Math.max(1, Math.ceil(filtered.length / COACH_LIST_PAGE_SIZE)));
  const live = rows.filter(row => row.state === 'live').length;
  const attention = rows.filter(row => ['recent', 'stale', 'low_accuracy'].includes(row.state)).length;
  const noPosition = rows.filter(row => !row.position).length;
  const change = useCallback((key, value, clearSelection = false) => {
    setParams(previous => {
      const next = new URLSearchParams(previous);
      if (value) next.set(key, value); else next.delete(key);
      if (clearSelection) next.delete('tour');
      return next;
    }, { replace: true });
    if (clearSelection) setPage(1);
  }, [setParams]);
  const onSelect = useCallback(tourId => change('tour', tourId), [change]);
  const prepared = feed.status?.schemaVersion === 1 && feed.status?.state === 'ready';
  const loading = !feed.loaded && !feed.error;
  const connection = demo ? 'Sample data' : feed.error ? 'Feed error' : !feed.connected ? (loading ? 'Connecting…' : 'Offline')
    : !prepared ? 'Setup pending' : !feed.complete ? 'Loading fleet…' : 'Connected';
  return <Stack gap="lg" className="coach-workspace">
    <Group justify="space-between" align="flex-start" gap="md">
      <div><Group gap="sm"><IconBus size={28} color="#007DC3" /><Title order={1} size="h2">Track Coaches</Title></Group>
        <Text c="dimmed" size="sm" mt={5}>Live tour positions, current driver assignments and sharing status.</Text></div>
      <Group gap="sm"><Badge size="lg" variant="light" color={demo ? 'orange' : feed.connected && prepared && !feed.error ? 'teal' : 'gray'}>{connection}</Badge>
        <Button variant={demo ? 'filled' : 'default'} color={demo ? 'orange' : undefined} leftSection={<IconPresentation size={16} />}
          onClick={() => onDemoChange(!demo)}>{demo ? 'Return to live tracking' : 'Demo mode'}</Button>
        {demo ? <Button variant="default" onClick={() => onDemoChange(true)}>Restart demo</Button> : null}
        {!demo ? <Button variant="default" leftSection={<IconRefresh size={16} />} onClick={feed.retry}>Reconnect</Button> : null}</Group>
    </Group>
    <CoachFeedAlerts feed={feed} demo={demo} loading={loading} prepared={prepared} invalidRows={invalidRows} />
    <div className="coach-summary" aria-label="Tracking summary">
      {[['Tours in feed', rows.length, 'Includes assigned tours without a position'], ['Live positions', live, 'Updated within four minutes'],
        ['Updates to check', attention, 'Recent, stale or low accuracy'], ['No live position', noPosition, 'Not shared, fixed pickup only or expired']].map(([label, count, hint], index) =>
        <Paper key={label} p="md" withBorder radius="md" className={`coach-summary-item coach-summary-item--${index}`}><Text size="sm" c="dimmed">{label}</Text>
          <Text className="coach-summary-number" fw={700}>{loading ? '—' : count.toLocaleString()}</Text><Text size="xs" c="dimmed">{hint}</Text></Paper>)}
    </div>
    <Paper withBorder p="md" radius="md"><Group align="flex-end" gap="md">
      <TextInput label="Find a tour or driver" placeholder="Tour name, code or assigned driver" value={search} maxLength={100}
        leftSection={<IconSearch size={16} />} onChange={event => change('q', event.currentTarget.value, true)} className="coach-search" />
      <Select label="Sharing status" value={status} data={statusOptions} allowDeselect={false} onChange={value => change('status', value === 'all' ? '' : value, true)} className="coach-status-select" />
      <SegmentedControl aria-label="Tracking view" value={view} onChange={value => change('view', value === 'map' ? '' : value)}
        data={[{ value: 'map', label: <Group gap={5} wrap="nowrap"><IconMap2 size={16} />Map</Group> }, { value: 'list', label: <Group gap={5} wrap="nowrap"><IconList size={16} />List</Group> }]} />
      <Checkbox label="Show fixed pickup pins" checked={pickups} onChange={event => change('pickups', event.currentTarget.checked ? '1' : '')} />
    </Group></Paper>
    {loading ? <Paper p="xl" withBorder><Group justify="center" role="status"><Loader size="sm" /><Text>Connecting to the tracking feed…</Text></Group></Paper> : null}
    {view === 'map' ? <div className="coach-map-layout"><CoachMapPanel key={demo ? 'demo' : 'live'} rows={filtered} selectedTour={selected?.tourId || null}
      onSelect={onSelect} showPickups={pickups} sourceKey={demo ? 'demo' : 'live'} />
      <Paper ref={detailsElement} withBorder radius="md"><CoachTourDetails row={selected} onClose={() => change('tour', '')} /></Paper></div>
      : selected ? <Paper ref={detailsElement} withBorder radius="md"><CoachTourDetails row={selected} onClose={() => change('tour', '')} /></Paper> : null}
    <CoachTourList rows={filtered} totalRows={rows.length} selectedTour={selected?.tourId} currentPage={currentPage}
      onPageChange={setPage} onSelect={onSelect} loading={loading} error={feed.error} filtered={Boolean(search || status !== 'all')}
      onClearFilters={() => {
        setParams(previous => { const next = new URLSearchParams(previous); ['q', 'status', 'tour'].forEach(key => next.delete(key)); return next; }, { replace: true });
        setPage(1);
      }} />
    <Text size="xs" c="dimmed">One selected live position per tour, which may have more than one driver or phone. Assigned driver names identify the tour assignment, not the individual phone supplying GPS. Live: under 4 minutes; recent: under 10 minutes; stale: under 30 minutes. Older positions are hidden. Times use UK local time.</Text>
  </Stack>;
}
