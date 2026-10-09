import { Badge, Button, Group, Stack, Text, Title } from '@mantine/core';
import { formatCoachTime, formatPositionAge } from '../../../utils/coachTrackingPresentation';

export default function CoachTourDetails({ row, onClose }) {
  if (!row) return <div className="coach-details-empty"><Text fw={600}>Choose a tour</Text><Text size="sm" c="dimmed">Select a map marker or a tour below to inspect its latest position.</Text></div>;
  return <section className="coach-details" aria-label={`Details for ${row.tourCode}`}>
    <Group justify="space-between"><Badge color={row.meta.color} variant="light">{row.meta.label}</Badge><Button size="compact-xs" variant="subtle" onClick={onClose}>Clear selection</Button></Group>
    <Title order={3} size="h4" mt="sm">{row.name}</Title><Text size="sm" c="dimmed">{row.tourCode}</Text>
    <Text size="sm" mt="sm">{row.reason}</Text>
    <Stack gap="sm" mt="md">
      <div><Text size="xs" c="dimmed" tt="uppercase" fw={700}>Assigned drivers</Text><Text size="sm">{row.assignedDrivers.length ? row.assignedDrivers.map(driver => driver.name).join(', ') : 'No current driver assignment'}</Text>
        {row.assignmentOverflow ? <Text size="xs" c="orange.8">The assignment list is incomplete.</Text> : null}</div>
      <div><Text size="xs" c="dimmed" tt="uppercase" fw={700}>Last location update · UK time</Text><Text size="sm">{formatCoachTime(row.timestampMs)}</Text><Text size="xs" c="dimmed">{formatPositionAge(row.ageMs)}</Text></div>
      <div><Text size="xs" c="dimmed" tt="uppercase" fw={700}>GPS accuracy</Text><Text size="sm">{row.accuracy === null ? 'Not reported' : `Within approximately ${Math.round(row.accuracy)} metres`}</Text></div>
      {row.position ? <div><Text size="xs" c="dimmed" tt="uppercase" fw={700}>Latitude / longitude</Text><Text size="sm">{row.position.latitude.toFixed(5)}, {row.position.longitude.toFixed(5)}</Text></div> : null}
      <div><Text size="xs" c="dimmed" tt="uppercase" fw={700}>Tour dates · UK time</Text><Text size="sm">{row.startAtMs === null ? 'Dates unavailable' : `${formatCoachTime(row.startAtMs)}${row.endAtMs === null ? '' : ` – ${formatCoachTime(row.endAtMs)}`}`}</Text></div>
      {row.pickup ? <div className="coach-pickup-note"><Text size="sm" fw={700}>Fixed pickup point</Text><Text size="sm">{row.pickup.address}</Text><Text size="xs" c="dimmed">A published meeting point. This does not locate the coach.</Text></div> : null}
    </Stack>
  </section>;
}
