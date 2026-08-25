import { Badge, Group, Paper, Text, ThemeIcon } from '@mantine/core';
import { IconSpeakerphone } from '@tabler/icons-react';
import { formatTimeForDisplay } from '../../../utils/dateUtils';
import { DELIVERY_STATUS_META, normalizeBroadcastTimestamp } from './broadcastPresentation';

export default function BroadcastHistoryItem({ broadcast }) {
  const timestampMs = normalizeBroadcastTimestamp(broadcast.timestamp);
  const isCategoryBroadcast = broadcast.targetType === 'category';
  const delivery = DELIVERY_STATUS_META[broadcast.deliveryStatus] || DELIVERY_STATUS_META.queued;

  return (
    <Paper p="sm" radius="md" withBorder>
      <Group justify="space-between" mb="xs">
        <Group gap="xs">
          <ThemeIcon color={isCategoryBroadcast ? 'blue' : 'orange'} variant="light" size="sm">
            <IconSpeakerphone size={12} />
          </ThemeIcon>
          <Badge size="sm" color={isCategoryBroadcast ? 'blue' : 'orange'} variant="light">
            {broadcast.targetLabel}
          </Badge>
        </Group>
        <Text size="xs" c="dimmed">{formatTimeForDisplay(timestampMs, 'Unknown time')}</Text>
      </Group>
      <Text size="sm">{broadcast.message}</Text>
      <Group gap="xs" mt="xs">
        <Badge size="xs" color={delivery.color} variant="light">{delivery.label}</Badge>
        {broadcast.recipientCount !== null ? (
          <Text size="xs" c="dimmed">
            {broadcast.successCount || 0} accepted / {broadcast.errorCount || 0} failed / {broadcast.recipientCount} eligible
          </Text>
        ) : null}
      </Group>
    </Paper>
  );
}
