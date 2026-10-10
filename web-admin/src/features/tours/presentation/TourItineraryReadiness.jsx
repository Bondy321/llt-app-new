import { Badge, Text, Tooltip } from '@mantine/core';
import { getTourItineraryReadiness } from './tourItineraryReadinessModel';

export function TourItineraryReadiness({ tour, showDetail = false }) {
  const readiness = getTourItineraryReadiness(tour);
  const badge = <Badge variant="light" color={readiness.color}>{readiness.label}</Badge>;

  return showDetail ? (
    <div>
      <Tooltip label={readiness.detail} multiline w={320}>
        {badge}
      </Tooltip>
      <Text size="xs" c="dimmed" mt={6}>{readiness.detail}</Text>
    </div>
  ) : (
    <Tooltip label={readiness.detail} multiline w={320}>
      {badge}
    </Tooltip>
  );
}
