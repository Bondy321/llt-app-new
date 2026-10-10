import { Progress, Stack, Text, Tooltip } from '@mantine/core';
import { getTourPassengerSummary } from '../../../utils/tourPassengerCounts';

export function TourPassengerSummary({ tour, compact = false }) {
  const counts = getTourPassengerSummary(tour);
  return <Stack gap={3} style={{ flex: 1, minWidth: 0 }}>
    <Tooltip label={counts.source === 'tour.sold' ? 'Booked places from the morning TourSummary report'
      : counts.source.startsWith('tour.') && !counts.source.endsWith('currentParticipants')
        ? 'Passengers listed in the morning passenger report'
        : 'Legacy participation count; no imported booking total is available'}>
      <Text size="sm" c="dimmed">{counts.text}</Text>
    </Tooltip>
    {counts.reportMismatch ? <Text size="xs" c="orange">Passenger report lists {counts.reportCount}; check the difference</Text> : null}
    {!compact && counts.loadPercent !== null ? <Progress value={Math.min(100, counts.loadPercent)}
      color={counts.loadPercent > 90 ? 'red' : counts.loadPercent > 70 ? 'orange' : 'blue'} size="sm" /> : null}
  </Stack>;
}
