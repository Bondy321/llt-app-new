import { Badge, Button, Group, Pagination, Paper, Text } from '@mantine/core';
import { IconBus } from '@tabler/icons-react';
import { formatCoachTime, formatPositionAge } from '../../../utils/coachTrackingPresentation';

export const COACH_LIST_PAGE_SIZE = 50;

export default function CoachTourList({ rows, totalRows, selectedTour, currentPage, onPageChange, onSelect,
  filtered, onClearFilters, loading, error }) {
  const visible = rows.slice((currentPage - 1) * COACH_LIST_PAGE_SIZE, currentPage * COACH_LIST_PAGE_SIZE);
  return <Paper withBorder radius="md" className="coach-tour-list">
    <Group justify="space-between" p="md"><div><Text fw={700}>Tours and assigned drivers</Text><Text size="sm" c="dimmed">
      {rows.length === totalRows ? `${rows.length} tours` : `${rows.length} of ${totalRows} tours match`}
      {rows.length > COACH_LIST_PAGE_SIZE ? ` · showing ${(currentPage - 1) * COACH_LIST_PAGE_SIZE + 1}–${Math.min(currentPage * COACH_LIST_PAGE_SIZE, rows.length)}` : ''}</Text></div>
      {filtered ? <Button size="xs" variant="subtle" onClick={onClearFilters}>Clear filters</Button> : null}</Group>
    {!loading && rows.length === 0 ? <div className="coach-empty"><IconBus size={36} color="#64748b" />
      <Text fw={600}>{totalRows ? 'No tours match these filters' : error ? 'Tracking data is unavailable' : 'No assigned tours or shared locations yet'}</Text>
      <Text size="sm" c="dimmed">{totalRows ? 'Try a different tour name or sharing status.' : 'Assigned tours appear here even before a driver starts sharing a position.'}</Text></div> : null}
    <div className="coach-list-rows">{visible.map(row => <button type="button" key={row.tourId} className={`coach-tour-row${selectedTour === row.tourId ? ' coach-tour-row--selected' : ''}`}
      onClick={() => onSelect(row.tourId)} aria-label={`View ${row.tourCode}, ${row.name}`} aria-pressed={selectedTour === row.tourId}>
      <div className="coach-tour-identity"><span className={`coach-tour-dot coach-tour-dot--${row.state}`} /><div><Text fw={600} size="sm">{row.name}</Text><Text size="xs" c="dimmed">{row.tourCode}{row.isActive ? '' : ' · Inactive tour'}</Text></div></div>
      <div><Text size="xs" c="dimmed">Assigned drivers</Text><Text size="sm">{row.assignedDrivers.map(driver => driver.name).join(', ') || 'Unassigned'}</Text></div>
      <div><Badge variant="light" color={row.meta.color}>{row.meta.label}</Badge><Text size="xs" c="dimmed" mt={4}>{row.pickup && !row.position ? 'Fixed pickup available' : formatPositionAge(row.ageMs)}</Text></div>
      <div><Text size="sm">{row.accuracy === null ? 'Accuracy not reported' : `± ${Math.round(row.accuracy)} m`}</Text><Text size="xs" c="dimmed">{row.timestampMs === null ? 'No live update' : formatCoachTime(row.timestampMs)}</Text></div>
    </button>)}</div>
    {rows.length > COACH_LIST_PAGE_SIZE ? <Group justify="center" p="md"><Pagination total={Math.ceil(rows.length / COACH_LIST_PAGE_SIZE)} value={currentPage} onChange={onPageChange} aria-label="Tour list pages" /></Group> : null}
  </Paper>;
}
