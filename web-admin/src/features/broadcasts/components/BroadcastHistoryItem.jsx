import { useEffect, useState } from 'react';
import { Badge, Button, Group, Paper, Stack, Text, ThemeIcon } from '@mantine/core';
import { IconSpeakerphone } from '@tabler/icons-react';
import { formatTimeForDisplay } from '../../../utils/dateUtils';
import { DELIVERY_STATUS_META, isBroadcastJobRequeueable, normalizeBroadcastTimestamp, presentSkipReasons } from './broadcastPresentation';
import { subscribeToNotificationJob } from '../../../services/broadcastRepository';

export default function BroadcastHistoryItem({ broadcast, onRequeue, requeueing = false }) {
  const [job, setJob] = useState(null);
  useEffect(() => subscribeToNotificationJob({
    jobId: broadcast.deliveryJobId,
    onData: setJob,
    onError: () => setJob(null),
  }), [broadcast.deliveryJobId]);
  const timestampMs = normalizeBroadcastTimestamp(broadcast.timestamp);
  const isCategoryBroadcast = broadcast.targetType === 'category';
  const deliveryStatus = job?.status || broadcast.deliveryStatus;
  const delivery = DELIVERY_STATUS_META[deliveryStatus] || DELIVERY_STATUS_META.queued;
  const counts = job?.counts || {};
  const eligible = Number.isFinite(Number(counts.eligible)) ? Number(counts.eligible) : broadcast.recipientCount;
  const ticketAccepted = Number.isFinite(Number(counts.ticketAccepted)) ? Number(counts.ticketAccepted) : broadcast.successCount;
  const providerAccepted = Number.isFinite(Number(counts.receiptAccepted)) ? Number(counts.receiptAccepted) : null;
  const rejected = job?.counts
    ? Number(counts.receiptRejected || 0) + Number(counts.ticketRejected || 0)
    : broadcast.errorCount;
  const submissionUnknown = Number.isFinite(Number(counts.submissionUnknown))
    ? Number(counts.submissionUnknown)
    : broadcast.submissionUnknownCount;
  const skipSummary = presentSkipReasons(job?.skipReasons || broadcast.skipReasons);
  const requeueable = isBroadcastJobRequeueable(job);

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
        {eligible !== null && eligible !== undefined ? (
          <Text size="xs" c="dimmed">
            {ticketAccepted || 0} Expo ticket accepted{providerAccepted !== null ? ` / ${providerAccepted} provider accepted` : ''} / {rejected || 0} rejected / {submissionUnknown || 0} outcome unknown / {eligible} eligible
          </Text>
        ) : null}
      </Group>
      {skipSummary ? <Text size="xs" c="dimmed" mt={4}>Skipped: {skipSummary}</Text> : null}
      {(ticketAccepted > 0 || providerAccepted > 0) ? <Text size="xs" c="dimmed" mt={4}>Acceptance confirms handoff to Expo or the push provider, not display on the device.</Text> : null}
      {job?.lastErrorCode || broadcast.lastErrorCode ? <Text size="xs" c="red" mt={4}>Last error: {job?.lastErrorCode || broadcast.lastErrorCode}</Text> : null}
      {requeueable ? <Stack align="flex-start" mt="xs"><Button size="compact-xs" variant="light" color="orange" loading={requeueing} onClick={() => onRequeue?.(job.jobId)}>Requeue remaining recipients</Button></Stack> : null}
    </Paper>
  );
}
